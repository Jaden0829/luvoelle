const {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorker, OEM, PSM } = require('tesseract.js');
const { checkVisionService, normalizeAnalysis, normalizeAnalysisMode, requestVisionAnalysis } = require('./services/vision');
const { requestReferenceGeneration } = require('./services/generation');
const { requestAiOcr, shouldEnhanceOcr } = require('./services/ai-ocr');
const { shouldUseContextTranslation } = require('./services/routing');
const { mapViewportRectToPixels } = require('./services/capture-geometry');
const { getCaptureWindowTargets, mapAutomationTargetsToWindowTarget, warmWindowTargetDetection } = require('./services/window-targets');
const {
  requestUiAutomationTargets,
  shutdownUiAutomationTargetDetection,
  warmUiAutomationTargetDetection,
} = require('./services/ui-automation-targets');
const { captureDisplay, capturePhysicalRectangle, flushDesktopComposition, warmNativeScreenCapture } = require('./services/native-screen-capture');
const { installWindowsMouseHook, uninstallWindowsMouseHook } = require('./services/windows-mouse-hook');
const { SCREEN_RECORDING_SETTINGS_URL, ensureScreenCaptureAccess } = require('./services/mac-screen-permission');
const { DEFAULT_SHORTCUTS, SHORTCUT_DEFINITIONS, normalizeShortcutMap } = require('./services/shortcuts');
const {
  applyDistributionDefaults,
  migrateDistributionSettings,
} = require('./services/distribution');
const packageMetadata = require('../package.json');

const APP_NAME = 'Luvoelle';
const LEGACY_PRODUCT_NAMES = ['lumalens', 'Luma Lens'];
const BACKGROUND_START_ARG = '--background';
const OVERLAY_STANDBY_OPACITY = 0.01;
const OVERLAY_MAX_RESIDENCY_MS = Math.max(60_000, Number(process.env.LUVOELLE_OVERLAY_MAX_RESIDENCY_MS) || (6 * 60 * 60 * 1000));
const WINDOWS_STABLE_BUILD = 19045;
app.setName(APP_NAME);

if (process.env.LUVOELLE_TEST_USER_DATA) {
  const testUserDataPath = path.resolve(process.env.LUVOELLE_TEST_USER_DATA);
  app.setPath('userData', testUserDataPath);
  app.setPath('cache', path.join(testUserDataPath, 'cache'));
}
crashReporter.start({
  productName: APP_NAME,
  uploadToServer: false,
  globalExtra: {
    appVersion: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
  },
});
function launchedAsMacLoginItem() {
  if (process.platform !== 'darwin' || process.env.LUVOELLE_TEST_USER_DATA) return false;
  try {
    const login = app.getLoginItemSettings();
    return Boolean(login.wasOpenedAtLogin || login.wasOpenedAsHidden);
  } catch {
    return false;
  }
}

const startedInBackground = process.argv.includes(BACKGROUND_START_ARG) || launchedAsMacLoginItem();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function windowsBuildNumber() {
  if (process.platform !== 'win32') return 0;
  const parts = os.release().split('.');
  return Number(parts[2]) || 0;
}

// Chromium's accelerated transparent/full-screen windows and in-process native
// helpers are the two most common startup failure points on older Windows 10
// LTSC machines. Keep the normal fast path on current Windows and automatically
// choose software rendering while deferring native helpers on pre-22H2 builds.
const legacyWindowsCompatibility = process.platform === 'win32' && (
  process.env.LUVOELLE_TEST_LEGACY_WINDOWS === '1'
  || process.argv.includes('--compatibility-mode')
  || (windowsBuildNumber() > 0 && windowsBuildNumber() < WINDOWS_STABLE_BUILD)
);
if (legacyWindowsCompatibility) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
}
const DEFAULT_SETTINGS = {
  provider: 'google',
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-5.4-mini',
  ocrMode: 'local',
  ocrConfidenceThreshold: 82,
  visionProvider: 'local',
  visionEndpoint: 'http://127.0.0.1:8080/v1',
  visionModel: 'Qwen3-VL-4B-Instruct',
  promptAnalysisMode: 'daily',
  generationEndpoint: '',
  generationModel: '',
  assistantEnabled: true,
  assistantSide: 'right',
  assistantDisplayId: '',
  assistantYRatio: 0.42,
  keepScreenshots: false,
  launchAtLogin: false,
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

function createDefaultSettings() {
  return applyDistributionDefaults({ ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } }, packageMetadata);
}

let mainWindow;
let initialWorkbenchPending = !startedInBackground;
let floatWindow;
let editorWindow;
let promptWindow;
let assistantWindow;
const promptWindows = new Set();
const pinnedImageWindows = new Set();
const promptJobWindows = new Map();
const promptAnalysisRuns = new Map();
let tray;
let overlayWindows = [];
let workerPromise;
let paddleOcrWorker;
let paddleOcrReadyPromise;
let paddleOcrReadyResolve;
let paddleOcrReadyReject;
let paddleOcrInitialization;
let paddleOcrRequestSequence = 0;
const paddleOcrRequests = new Map();
let activeMode = 'translate';
let pendingFloatPayload;
let floatReady = false;
let floatReadingSize = 'normal';
let floatModerateBounds = null;
let pendingEditorImage;
let promptAnalysisSequence = 0;
let restoreFloatAfterEditor = false;
let captureSessionId = 0;
let captureRestoreWindows = [];
let captureWarmupPromise = Promise.resolve();
let startupWarmupsStarted = false;
let captureActive = false;
let captureSourceFrames = new Map();
let store = { settings: createDefaultSettings(), history: [] };
let cachedAppIcon;
let workerProgressHandler;
let shortcutRegistration = {};
let shortcutRecording = false;
let shortcutRecordingTimer;
let appIsQuitting = false;
let screenCapturePermissionDialog;
let assistantReady = false;
let assistantExpanded = false;
let assistantHovered = false;
let assistantProgrammaticMove = false;
let assistantMoveTimer;
const capturePerformance = new Map();
let capturePerformanceSamples = 0;
let captureInteractionSamples = 0;
let capturePreviewSamples = 0;
let overlayRefreshPromise = null;
let overlayRefreshTimer = null;

const statePath = () => path.join(app.getPath('userData'), 'state.json');
const diagnosticsPath = () => path.join(app.getPath('userData'), 'diagnostics.log');

function writeDiagnostic(type, details = {}) {
  try {
    const filePath = diagnosticsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = {
      time: new Date().toISOString(),
      type,
      ...details,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // Diagnostics must never become another application failure source.
  }
}

writeDiagnostic('startup-begin', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  electron: process.versions.electron,
  legacyWindowsCompatibility,
  background: startedInBackground,
});

function beginCapturePerformanceTrace({ sessionId, mode, captureVariant, options, entryStartedAt }) {
  const shortcutReceivedAt = Number(options.shortcutReceivedAt || entryStartedAt);
  const trace = {
    sessionId,
    mode,
    captureVariant,
    trigger: options.trigger || 'direct',
    shortcutReceivedAt,
    entryStartedAt,
    shortcutDispatchMs: Math.max(0, entryStartedAt - shortcutReceivedAt),
  };
  trace.firstPaintPromise = new Promise((resolve) => { trace.resolveFirstPaint = resolve; });
  capturePerformance.set(sessionId, trace);
  trace.reportTimer = setTimeout(() => {
    capturePerformance.delete(sessionId);
    const { reportTimer, firstPaintPromise, resolveFirstPaint, shortcutReceivedAt, entryStartedAt: startedAt, ...metrics } = trace;
    const shortcutToFirstPaintMs = Number(metrics.shortcutToFirstPaintMs || 0);
    const slow = captureVariant === 'fast' && shortcutToFirstPaintMs > 180;
    if (captureVariant === 'fast' && (capturePerformanceSamples < 12 || slow)) {
      capturePerformanceSamples += 1;
      writeDiagnostic(slow ? 'capture-entry-slow' : 'capture-entry-sample', metrics);
    }
  }, 1200);
  return trace;
}

process.on('uncaughtExceptionMonitor', (error, origin) => {
  writeDiagnostic('main-uncaught-exception', {
    origin,
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: String(error?.stack || '').slice(0, 4000),
  });
});

process.on('unhandledRejection', (reason) => {
  writeDiagnostic('main-unhandled-rejection', {
    name: reason?.name || 'Error',
    message: reason?.message || String(reason),
    stack: String(reason?.stack || '').slice(0, 4000),
  });
});

function migrateLegacyStore() {
  if (process.env.LUVOELLE_TEST_USER_DATA || fs.existsSync(statePath())) return;
  const currentUserData = path.resolve(app.getPath('userData'));
  const appData = app.getPath('appData');
  for (const legacyName of LEGACY_PRODUCT_NAMES) {
    const legacyUserData = path.resolve(appData, legacyName);
    const legacyState = path.join(legacyUserData, 'state.json');
    if (legacyUserData === currentUserData || !fs.existsSync(legacyState)) continue;
    try {
      fs.mkdirSync(currentUserData, { recursive: true });
      fs.copyFileSync(legacyState, statePath(), fs.constants.COPYFILE_EXCL);
      return;
    } catch {
      // The new profile remains usable even when an old development profile
      // cannot be migrated (for example, due to file permissions).
    }
  }
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    let shortcuts;
    try {
      shortcuts = normalizeShortcutMap(parsed.settings?.shortcuts || {}, DEFAULT_SHORTCUTS);
    } catch {
      shortcuts = { ...DEFAULT_SHORTCUTS };
    }
    // Merge persisted settings into the neutral defaults before applying a
    // distribution migration. Using createDefaultSettings() here would inject
    // the friend marker too early and make an old Google profile look migrated.
    const migrated = migrateDistributionSettings({ ...DEFAULT_SETTINGS, ...(parsed.settings || {}), shortcuts }, packageMetadata);
    store = {
      settings: migrated.settings,
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 120) : [],
    };
    if (migrated.changed) writeStore();
  } catch {
    store = { settings: createDefaultSettings(), history: [] };
  }
}

function writeStore() {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const temporaryPath = `${statePath()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temporaryPath, statePath());
}

function publicSettings() {
  const {
    apiKeyEncrypted,
    deepseekApiKeyEncrypted,
    visionApiKeyEncrypted,
    generationApiKeyEncrypted,
    ...settings
  } = store.settings;
  return {
    ...settings,
    hasApiKey: Boolean(apiKeyEncrypted),
    hasDeepSeekApiKey: Boolean(deepseekApiKeyEncrypted),
    hasVisionApiKey: Boolean(visionApiKeyEncrypted),
    hasGenerationApiKey: Boolean(generationApiKeyEncrypted),
    shortcutStatus: { ...shortcutRegistration },
  };
}

function encryptSecret(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法启用安全密钥存储。');
  return safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}

function createAppIcon() {
  if (cachedAppIcon && !cachedAppIcon.isEmpty()) return cachedAppIcon;
  const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  cachedAppIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', iconFile));
  if (cachedAppIcon.isEmpty()) throw new Error(`无法加载应用图标：${iconFile}`);
  return cachedAppIcon;
}

function browserOptions(extra = {}) {
  const { webPreferences = {}, ...windowOptions } = extra;
  return {
    show: false,
    backgroundColor: '#f5f5f7',
    icon: createAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...webPreferences,
    },
    ...windowOptions,
  };
}

function getPaddleOcrAssetRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'paddleocr', 'native')
    : path.join(__dirname, '..', 'assets', 'paddleocr', 'native');
}

function getPaddleOcrWorkerPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'ocr-native-worker.js')
    : path.join(__dirname, 'ocr-native-worker.js');
}

function settlePaddleOcrRequests(error) {
  paddleOcrRequests.forEach((request) => {
    clearTimeout(request.timeout);
    request.reject(error);
  });
  paddleOcrRequests.clear();
}

function resetPaddleOcrWorker(worker, error, { terminate = true } = {}) {
  if (worker !== paddleOcrWorker) return;
  if (error) {
    paddleOcrReadyReject?.(error);
    settlePaddleOcrRequests(error);
  }
  paddleOcrWorker = null;
  paddleOcrReadyPromise = null;
  paddleOcrReadyResolve = null;
  paddleOcrReadyReject = null;
  paddleOcrInitialization = null;
  if (terminate) {
    try { worker.kill(); } catch { /* the isolated process may already be gone */ }
  }
}

function handlePaddleOcrWorkerMessage(worker, payload) {
  if (worker !== paddleOcrWorker || !payload) return;
  if (payload.type === 'ready') {
    paddleOcrInitialization = payload.summary || { backend: 'native', provider: 'cpu' };
    paddleOcrReadyResolve?.(paddleOcrInitialization);
    return;
  }
  if (payload.type === 'failed') {
    const error = new Error(payload.message || 'PP-OCRv6 native initialization failed.');
    resetPaddleOcrWorker(paddleOcrWorker, error);
    return;
  }
  const request = paddleOcrRequests.get(payload.id);
  if (!request) return;
  if (payload.type === 'progress') {
    request.onProgress?.({ stage: payload.stage, progress: payload.progress });
    return;
  }
  clearTimeout(request.timeout);
  paddleOcrRequests.delete(payload.id);
  if (payload.type === 'result') request.resolve(payload.result);
  else request.reject(new Error(payload.message || 'PP-OCRv6 native recognition failed.'));
}

function createPaddleOcrWorker() {
  if (process.env.LUVOELLE_DISABLE_PADDLE === '1') {
    return Promise.reject(new Error('PP-OCRv6 disabled for this run.'));
  }
  if (paddleOcrWorker && paddleOcrReadyPromise) return paddleOcrReadyPromise;
  paddleOcrInitialization = null;
  paddleOcrReadyPromise = new Promise((resolve, reject) => {
    paddleOcrReadyResolve = resolve;
    paddleOcrReadyReject = reject;
  });
  const worker = utilityProcess.fork(getPaddleOcrWorkerPath(), [], {
    env: {
      ...process.env,
      LUVOELLE_OCR_MODEL_ROOT: getPaddleOcrAssetRoot(),
    },
    serviceName: 'Luvoelle Native OCR',
    stdio: 'ignore',
  });
  paddleOcrWorker = worker;
  worker.on('message', (payload) => handlePaddleOcrWorkerMessage(worker, payload));
  worker.on('error', (type, location, report) => {
    const error = new Error(`PP-OCRv6 isolated process error: ${type}${location ? ` at ${location}` : ''}`);
    writeDiagnostic('ocr-utility-error', {
      errorType: type || 'unknown',
      location: location || '',
      report: String(report || '').slice(0, 4000),
    });
    resetPaddleOcrWorker(worker, error, { terminate: false });
  });
  worker.on('exit', (code) => {
    if (worker !== paddleOcrWorker) return;
    if (code !== 0) {
      const error = new Error(`PP-OCRv6 isolated process stopped with code ${code}.`);
      writeDiagnostic('ocr-utility-exit', { exitCode: Number(code || 0) });
      resetPaddleOcrWorker(worker, error, { terminate: false });
      return;
    }
    resetPaddleOcrWorker(worker, null, { terminate: false });
  });
  return paddleOcrReadyPromise;
}

async function waitForPaddleOcrReady(timeoutMs = 30000) {
  const ready = createPaddleOcrWorker();
  let timeout;
  try {
    return await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('PP-OCRv6 initialization timed out.')), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (!paddleOcrInitialization && paddleOcrWorker) resetPaddleOcrWorker(paddleOcrWorker, error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function recognizeWithPaddle(dataUrl, onProgress = null, { refined = false, scale = 1 } = {}) {
  await waitForPaddleOcrReady();
  if (!paddleOcrWorker) throw new Error('PP-OCRv6 native worker is unavailable.');
  const worker = paddleOcrWorker;
  const id = `paddle-${Date.now()}-${paddleOcrRequestSequence += 1}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error('PP-OCRv6 recognition timed out.');
      paddleOcrRequests.delete(id);
      reject(error);
      resetPaddleOcrWorker(worker, error);
    }, 45000);
    paddleOcrRequests.set(id, { resolve, reject, timeout, onProgress });
    try {
      worker.postMessage({ type: 'recognize', id, dataUrl, refined, scale });
    } catch (error) {
      clearTimeout(timeout);
      paddleOcrRequests.delete(id);
      reject(error);
      resetPaddleOcrWorker(worker, error);
    }
  });
}

function createMainWindow({ deferShow = false } = {}) {
  const createdWindow = new BrowserWindow(browserOptions({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 650,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    // The workbench normally stays hidden in the tray. Its renderer still owns
    // explicit capture/settings IPC actions, so it must remain responsive while
    // hidden instead of being timer-throttled after several capture cycles.
    webPreferences: { backgroundThrottling: false },
  }));
  mainWindow = createdWindow;
  createdWindow.luvoelleReady = false;
  createdWindow.luvoelleReadyPromise = new Promise((resolve, reject) => {
    createdWindow.webContents.once('did-finish-load', () => {
      createdWindow.luvoelleReady = true;
      writeDiagnostic('startup-main-ready');
      resolve();
      if (!deferShow && !createdWindow.isDestroyed()) createdWindow.show();
    });
    createdWindow.webContents.once('did-fail-load', (_event, code, description) => {
      writeDiagnostic('startup-main-load-failed', { code, description });
      reject(new Error(`${code}: ${description}`));
    });
  });
  createdWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });
  return createdWindow;
}

function showMain(section = 'workspace') {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow({ deferShow: true });
  const target = mainWindow;
  initialWorkbenchPending = true;
  const reveal = () => {
    if (!target || target.isDestroyed() || target !== mainWindow) return;
    target.show();
    target.restore();
    target.focus();
    target.webContents.send('app:navigate', section);
    initialWorkbenchPending = false;
  };
  if (target.luvoelleReady) reveal();
  else target.luvoelleReadyPromise.then(reveal).catch(() => {});
}

const ASSISTANT_PET_WIDTH = 92;
const ASSISTANT_PET_HEIGHT = 108;
const ASSISTANT_PANEL_WIDTH = 468;
const ASSISTANT_PANEL_HEIGHT = 610;
const ASSISTANT_EDGE_REVEAL = 38;

function assistantDisplay() {
  const displays = screen.getAllDisplays();
  return displays.find((display) => String(display.id) === String(store.settings.assistantDisplayId))
    || (assistantWindow && !assistantWindow.isDestroyed() ? screen.getDisplayNearestPoint((() => {
      const bounds = assistantWindow.getBounds();
      return { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) };
    })()) : null)
    || screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    || screen.getPrimaryDisplay();
}

function assistantBounds({ expanded = assistantExpanded, hovered = assistantHovered } = {}) {
  const display = assistantDisplay();
  const area = display.workArea;
  const side = store.settings.assistantSide === 'left' ? 'left' : 'right';
  const width = expanded ? Math.min(ASSISTANT_PANEL_WIDTH, area.width - 24) : ASSISTANT_PET_WIDTH;
  const height = expanded ? Math.min(ASSISTANT_PANEL_HEIGHT, area.height - 24) : ASSISTANT_PET_HEIGHT;
  const ratio = Math.max(0, Math.min(1, Number(store.settings.assistantYRatio ?? 0.42)));
  const y = Math.max(area.y + 8, Math.min(
    area.y + Math.round((area.height - height) * ratio),
    area.y + area.height - height - 8,
  ));
  // Keep the native pet window stationary while the pointer crosses it.
  // Moving a transparent, non-focusable BrowserWindow during a native mouse
  // press can make Windows cancel the click. The renderer now performs the
  // visual edge tuck and setAssistantInputRegion controls hit testing.
  let x;
  if (expanded) x = side === 'left' ? area.x + 10 : area.x + area.width - width - 10;
  else if (process.platform === 'darwin' && !hovered) x = side === 'left'
    ? area.x - (width - ASSISTANT_EDGE_REVEAL)
    : area.x + area.width - ASSISTANT_EDGE_REVEAL;
  else x = side === 'left' ? area.x + 4 : area.x + area.width - width - 4;
  return { x, y, width, height };
}

function setAssistantInputRegion({ expanded = assistantExpanded, hovered = assistantHovered, bounds: targetBounds } = {}) {
  if (!assistantWindow || assistantWindow.isDestroyed() || typeof assistantWindow.setShape !== 'function') return;
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  const bounds = targetBounds || assistantWindow.getBounds();
  if (expanded || hovered) {
    assistantWindow.setShape([{ x: 0, y: 0, width: bounds.width, height: bounds.height }]);
    return;
  }
  const reveal = Math.min(ASSISTANT_EDGE_REVEAL, bounds.width);
  const x = store.settings.assistantSide === 'left' ? 0 : bounds.width - reveal;
  assistantWindow.setShape([{ x, y: 0, width: reveal, height: bounds.height }]);
}

function positionAssistant(options = {}) {
  if (!assistantWindow || assistantWindow.isDestroyed()) return false;
  assistantProgrammaticMove = true;
  const bounds = assistantBounds(options);
  assistantWindow.setBounds(bounds, Boolean(options.animate));
  setAssistantInputRegion({ ...options, bounds });
  setTimeout(() => { assistantProgrammaticMove = false; }, options.animate ? 260 : 60);
  return true;
}

function persistAssistantPosition() {
  if (!assistantWindow || assistantWindow.isDestroyed() || assistantProgrammaticMove || assistantExpanded) return;
  const bounds = assistantWindow.getBounds();
  const center = { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) };
  const display = screen.getDisplayNearestPoint(center);
  const area = display.workArea;
  store.settings.assistantSide = center.x < area.x + area.width / 2 ? 'left' : 'right';
  store.settings.assistantDisplayId = String(display.id);
  store.settings.assistantYRatio = Math.max(0, Math.min(1, (bounds.y - area.y) / Math.max(1, area.height - ASSISTANT_PET_HEIGHT)));
  writeStore();
  positionAssistant({ animate: true });
  assistantWindow.webContents.send('assistant:state', {
    expanded: false,
    side: store.settings.assistantSide,
    hovered: assistantHovered,
  });
}

function setAssistantExpanded(expanded, { focus = true, animate = false } = {}) {
  if (!assistantWindow || assistantWindow.isDestroyed()) return false;
  assistantExpanded = Boolean(expanded);
  assistantHovered = assistantExpanded;
  // A non-focusable transparent BrowserWindow can receive hover events but
  // intermittently lose real clicks on Windows. Keep it mouse-eligible while
  // collapsed, show it inactive, and only focus it after an explicit open.
  assistantWindow.setFocusable(assistantExpanded || process.platform === 'win32');
  positionAssistant({ expanded: assistantExpanded, hovered: assistantHovered, animate });
  assistantWindow.setOpacity(assistantExpanded || assistantHovered ? 1 : 0.42);
  assistantWindow.webContents.send('assistant:state', {
    expanded: assistantExpanded,
    side: store.settings.assistantSide,
    hovered: assistantHovered,
  });
  assistantWindow.showInactive();
  if (assistantExpanded && focus) {
    assistantWindow.setFocusable(true);
    assistantWindow.focus();
  } else if (!assistantExpanded && process.platform === 'win32') {
    assistantWindow.blur();
  }
  return assistantExpanded;
}

function showAssistant() {
  store.settings.assistantEnabled = true;
  writeStore();
  if (!assistantWindow || assistantWindow.isDestroyed()) createAssistantWindow();
  // Restoring from settings is an explicit placement action. Snap to the
  // selected edge before showing so callers never observe the previous side
  // during the bounds animation.
  setAssistantExpanded(false, { focus: false, animate: false });
  updateTrayMenu();
}

function pointerInsideAssistantWindow(point) {
  if (!assistantWindow || assistantWindow.isDestroyed() || assistantExpanded || store.settings.assistantEnabled === false) return false;
  const bounds = assistantWindow.getBounds();
  const reveal = assistantHovered ? bounds.width : Math.min(ASSISTANT_EDGE_REVEAL, bounds.width);
  const left = assistantHovered || store.settings.assistantSide === 'left' ? bounds.x : bounds.x + bounds.width - reveal;
  return point.x >= left && point.x < left + reveal && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

function handleNativeAssistantClick(point) {
  const logicalPoint = typeof screen.screenToDipPoint === 'function' ? screen.screenToDipPoint(point) : point;
  if (process.env.LUVOELLE_TEST === '1') writeDiagnostic('assistant-native-click-seen', { physicalPoint: point, logicalPoint, bounds: assistantWindow?.getBounds?.() });
  if (!pointerInsideAssistantWindow(logicalPoint)) return false;
  writeDiagnostic('assistant-native-click-open', { side: store.settings.assistantSide });
  setAssistantExpanded(true);
  return true;
}

function hideAssistant() {
  store.settings.assistantEnabled = false;
  writeStore();
  assistantExpanded = false;
  assistantHovered = false;
  if (assistantWindow && !assistantWindow.isDestroyed()) {
    assistantWindow.setFocusable(false);
    assistantWindow.setOpacity(0.42);
    assistantWindow.webContents.send('assistant:state', {
      expanded: false,
      side: store.settings.assistantSide,
      hovered: false,
    });
    assistantWindow.hide();
  }
  updateTrayMenu();
}

function createAssistantWindow() {
  if (assistantWindow && !assistantWindow.isDestroyed()) return assistantWindow;
  assistantReady = false;
  assistantExpanded = false;
  assistantHovered = false;
  assistantWindow = new BrowserWindow(browserOptions({
    ...assistantBounds({ expanded: false, hovered: false }),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: true,
    hasShadow: false,
    roundedCorners: true,
    focusable: process.platform === 'win32',
    webPreferences: { backgroundThrottling: false },
  }));
  assistantWindow.setAlwaysOnTop(true, 'pop-up-menu');
  assistantWindow.setOpacity(0.42);
  assistantWindow.webContents.setBackgroundThrottling(false);
  if (process.platform === 'darwin') {
    assistantWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    assistantWindow.setHiddenInMissionControl(true);
  }
  assistantWindow.loadFile(path.join(__dirname, 'renderer', 'assistant.html'));
  assistantWindow.webContents.once('did-finish-load', () => {
    assistantReady = true;
    positionAssistant({ expanded: false, hovered: false, animate: false });
    assistantWindow.webContents.send('assistant:state', {
      expanded: false,
      side: store.settings.assistantSide,
      hovered: false,
    });
    if (store.settings.assistantEnabled !== false) assistantWindow.showInactive();
    if (process.platform === 'win32' && !installWindowsMouseHook(handleNativeAssistantClick)) {
      writeDiagnostic('assistant-native-click-hook-failed');
    }
  });
  assistantWindow.on('moved', () => {
    if (assistantProgrammaticMove || assistantExpanded) return;
    clearTimeout(assistantMoveTimer);
    assistantMoveTimer = setTimeout(persistAssistantPosition, 180);
  });
  assistantWindow.on('close', (event) => {
    if (appIsQuitting) return;
    event.preventDefault();
    hideAssistant();
  });
  assistantWindow.on('closed', () => {
    assistantWindow = null;
    assistantReady = false;
  });
  return assistantWindow;
}

function syncLoginItemSettings(enabled) {
  // Test profiles must never mutate the user's real login items.
  if (process.env.LUVOELLE_TEST_USER_DATA) return;
  const options = { openAtLogin: Boolean(enabled) };
  if (process.platform === 'win32') options.args = enabled ? [BACKGROUND_START_ARG] : [];
  if (process.platform === 'darwin') options.openAsHidden = Boolean(enabled);
  app.setLoginItemSettings(options);
}

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    // Windows launches the same executable for both a user's second click and
    // login startup. Only an explicit background launch should remain silent.
    if (!commandLine.includes(BACKGROUND_START_ARG)) showMain();
  });
}

function createTray() {
  // Keep the multi-resolution ICO intact on Windows. macOS menu bar icons are
  // intentionally smaller than Dock/app icons, so give Cocoa an explicit size.
  const appIcon = createAppIcon();
  const trayIcon = process.platform === 'darwin'
    ? appIcon.resize({ width: 18, height: 18, quality: 'best' })
    : appIcon;
  tray = new Tray(trayIcon);
  updateTrayMenu();
  tray.on('click', () => showMain());
  tray.on('double-click', () => showMain());
}

function createApplicationMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `关于 ${APP_NAME}` },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Command+,', click: () => showMain('settings') },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${APP_NAME}` },
        { role: 'hideOthers', label: '隐藏其他应用' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${APP_NAME}` },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ]));
}

function updateTrayMenu(shortcuts = store.settings.shortcuts) {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(`${APP_NAME} · ${shortcuts.quickEdit} 菜单截图 · ${shortcuts.translate} 翻译`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Luvoelle', click: () => showMain() },
    {
      label: store.settings.assistantEnabled === false ? '显示萌宠翻译助手' : '隐藏萌宠翻译助手',
      click: () => (store.settings.assistantEnabled === false ? showAssistant() : hideAssistant()),
    },
    { type: 'separator' },
    { label: `菜单截图标注   ${shortcuts.quickEdit}`, click: () => startCapture('edit', { captureVariant: 'faithful' }) },
    { label: `截图翻译   ${shortcuts.translate}`, click: () => startCapture('translate') },
    { label: `截图取字   ${shortcuts.ocr}`, click: () => startCapture('ocr') },
    { label: `截图转提示词   ${shortcuts.prompt}`, click: () => startCapture('prompt') },
    { label: `快速截图标注   ${shortcuts.edit}`, click: () => startCapture('edit', { captureVariant: 'fast' }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function runShortcutAction(id, shortcutReceivedAt = Date.now()) {
  const shortcutOptions = { trigger: `shortcut:${id}`, shortcutReceivedAt };
  if (id === 'translate') return startCapture('translate', shortcutOptions);
  if (id === 'ocr') return startCapture('ocr', shortcutOptions);
  if (id === 'prompt') return startCapture('prompt', shortcutOptions);
  if (id === 'edit') return startCapture('edit', { ...shortcutOptions, captureVariant: 'fast' });
  if (id === 'quickEdit') return startCapture('edit', { ...shortcutOptions, captureVariant: 'faithful' });
  if (id === 'text') return showMain('text');
  return undefined;
}

function registerShortcuts(shortcuts = store.settings.shortcuts) {
  const normalized = normalizeShortcutMap(shortcuts, DEFAULT_SHORTCUTS);
  clearTimeout(shortcutRecordingTimer);
  shortcutRecordingTimer = undefined;
  globalShortcut.unregisterAll();
  shortcutRegistration = {};
  SHORTCUT_DEFINITIONS.forEach(({ id }) => {
    const accelerator = normalized[id];
    let registered = false;
    try {
      registered = Boolean(globalShortcut.register(accelerator, () => runShortcutAction(id, Date.now())))
        && globalShortcut.isRegistered(accelerator);
    } catch (error) {
      writeDiagnostic('shortcut-registration-failed', {
        id,
        accelerator,
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
    }
    shortcutRegistration[id] = { accelerator, registered };
  });
  shortcutRecording = false;
  updateTrayMenu(normalized);
  return { shortcuts: normalized, status: { ...shortcutRegistration } };
}

function parkOverlayWindow(win) {
  if (!isHealthyOverlay(win)) return;
  win.setIgnoreMouseEvents(true);
  win.setFocusable(false);
  if (process.platform === 'darwin') {
    // ScreenCaptureKit can include content-protected windows. A fully hidden
    // standby overlay is the only reliable way to keep Luvoelle out of the
    // frozen desktop frame on macOS.
    win.hide();
    win.setOpacity(1);
  } else {
    win.setOpacity(OVERLAY_STANDBY_OPACITY);
  }
}

function hideOverlays() {
  overlayWindows.forEach((win) => {
    if (isHealthyOverlay(win)) {
      win.webContents.send('overlay:standby');
      parkOverlayWindow(win);
      win.luvoelleCaptureActive = false;
      win.luvoellePrimaryCapture = false;
    }
  });
  captureActive = false;
  globalShortcut.unregister('Escape');
}

function isHealthyOverlay(overlay) {
  if (!overlay || overlay.isDestroyed() || overlay.luvoelleCrashed || overlay.webContents.isDestroyed()) return false;
  try {
    return typeof overlay.webContents.isCrashed !== 'function' || !overlay.webContents.isCrashed();
  } catch {
    return false;
  }
}

function cancelCapture({ restoreWindows = true } = {}) {
  captureSessionId += 1;
  hideOverlays();
  captureSourceFrames.clear();
  if (restoreWindows) {
    captureRestoreWindows.forEach((win) => {
      if (win && !win.isDestroyed()) {
        if (win === assistantWindow) win.showInactive();
        else win.show();
      }
    });
  }
  captureRestoreWindows = [];
}

function overlayMatchesDisplay(overlay, display) {
  if (!isHealthyOverlay(overlay)) return false;
  const bounds = overlay.getBounds();
  return bounds.x === display.bounds.x
    && bounds.y === display.bounds.y
    && bounds.width === display.bounds.width
    && bounds.height === display.bounds.height;
}

function fitOverlayToDisplay(overlay, display) {
  if (!isHealthyOverlay(overlay)) return;
  if (process.platform === 'win32') {
    if (!overlay.isFullScreen() || !overlayMatchesDisplay(overlay, display)) {
      if (overlay.isFullScreen()) overlay.setFullScreen(false);
      overlay.setBounds(display.bounds, false);
      overlay.setFullScreen(true);
    }
  } else overlay.setBounds(display.bounds, false);
  overlay.luvoelleDisplayBounds = { ...display.bounds };
}

function raiseOverlay(overlay, inactive = false) {
  if (!isHealthyOverlay(overlay)) return;
  overlay.setAlwaysOnTop(true, 'screen-saver', 1);
  if (inactive) overlay.showInactive();
  else overlay.show();
  if (process.platform === 'win32' && !overlay.isFullScreen()) overlay.setFullScreen(true);
  overlay.moveTop();
}

function createOverlayWindow(display) {
  const overlay = new BrowserWindow(browserOptions({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: process.platform === 'win32',
    opacity: OVERLAY_STANDBY_OPACITY,
    webPreferences: {
      backgroundThrottling: false,
    },
  }));
  overlay.luvoelleDisplayId = display.id;
  overlay.luvoelleCreatedAt = Date.now();
  overlay.luvoelleCrashed = false;
  overlay.luvoelleCaptureActive = false;
  overlay.webContents.setBackgroundThrottling(false);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'win32') {
    overlay.setContentProtection(true);
    fitOverlayToDisplay(overlay, display);
  }
  if (process.platform === 'darwin') {
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.setHiddenInMissionControl(true);
  }
  overlay.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      cancelCapture();
    }
  });
  const loadedPromise = new Promise((resolve, reject) => {
    overlay.webContents.once('did-finish-load', resolve);
    overlay.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)));
  });
  overlay.luvoelleReadyPromise = loadedPromise.then(() => new Promise((resolve) => {
    let settled = false;
    const finishStandbyWarmup = () => {
      if (settled) return;
      settled = true;
      overlay.luvoelleResolveStandbyReady = null;
      overlay.luvoelleStandbyReady = true;
      if (isHealthyOverlay(overlay)) parkOverlayWindow(overlay);
      resolve();
    };
    overlay.luvoelleResolveStandbyReady = finishStandbyWarmup;
    overlay.setIgnoreMouseEvents(true);
    overlay.setFocusable(false);
    overlay.setOpacity(OVERLAY_STANDBY_OPACITY);
    overlay.showInactive();
    fitOverlayToDisplay(overlay, display);
    overlay.webContents.invalidate();
    overlay.webContents.send('overlay:standby');
    setTimeout(finishStandbyWarmup, 240);
  })).catch((error) => {
    overlay.luvoelleCrashed = true;
    throw error;
  });
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlay.on('closed', () => {
    overlayWindows = overlayWindows.filter((candidate) => candidate !== overlay);
  });
  overlayWindows.push(overlay);
  return overlay;
}

function getResidentOverlayWindows(displays) {
  const windows = displays.map((display) => overlayWindows.find((candidate) => (
    isHealthyOverlay(candidate)
      && candidate.luvoelleStandbyReady
      && String(candidate.luvoelleDisplayId) === String(display.id)
  )));
  return windows.every(Boolean) ? windows : null;
}

async function ensureOverlayWindows(displays = screen.getAllDisplays()) {
  const validIds = new Set(displays.map((display) => String(display.id)));
  overlayWindows.slice().forEach((overlay) => {
    if (!isHealthyOverlay(overlay) || !validIds.has(String(overlay.luvoelleDisplayId))) {
      if (!overlay.isDestroyed()) overlay.destroy();
    }
  });
  const windows = displays.map((display) => {
    let overlay = overlayWindows.find((candidate) => isHealthyOverlay(candidate) && String(candidate.luvoelleDisplayId) === String(display.id));
    if (!overlay) overlay = createOverlayWindow(display);
    else fitOverlayToDisplay(overlay, display);
    return overlay;
  });
  await Promise.all(windows.map((overlay) => overlay.luvoelleReadyPromise));
  return windows;
}

async function refreshResidentOverlays(reason = 'scheduled', { force = false } = {}) {
  if (appIsQuitting || overlayRefreshPromise) return false;
  if (captureActive) {
    setTimeout(() => refreshResidentOverlays(reason, { force }), 2000).unref?.();
    return false;
  }
  const now = Date.now();
  const healthy = overlayWindows.filter(isHealthyOverlay);
  if (!force && healthy.length && healthy.every((overlay) => now - Number(overlay.luvoelleCreatedAt || now) < OVERLAY_MAX_RESIDENCY_MS)) return false;
  overlayRefreshPromise = (async () => {
    const displays = screen.getAllDisplays();
    const previous = overlayWindows.slice();
    const replacements = displays.map((display) => createOverlayWindow(display));
    try {
      await Promise.all(replacements.map((overlay) => overlay.luvoelleReadyPromise));
      if (captureActive) {
        replacements.forEach((overlay) => {
          if (!overlay.isDestroyed()) overlay.destroy();
        });
        setTimeout(() => refreshResidentOverlays(reason, { force }), 2000).unref?.();
        return false;
      }
      previous.forEach((overlay) => {
        if (!overlay.isDestroyed()) overlay.destroy();
      });
      writeDiagnostic('overlay-resident-refreshed', {
        reason,
        replaced: previous.length,
        resident: replacements.length,
        maximumAgeMs: previous.length
          ? Math.max(...previous.map((overlay) => now - Number(overlay.luvoelleCreatedAt || now)))
          : 0,
      });
      return true;
    } catch (error) {
      replacements.forEach((overlay) => {
        if (!overlay.isDestroyed()) overlay.destroy();
      });
      writeDiagnostic('overlay-resident-refresh-failed', {
        reason,
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
      return false;
    }
  })().finally(() => { overlayRefreshPromise = null; });
  return overlayRefreshPromise;
}

function displayFrameEntry(display, captured, backend) {
  if (!captured?.image || captured.image.isEmpty()) return null;
  const imageSize = captured.image.getSize();
  if (!imageSize.width || !imageSize.height) return null;
  return {
    ...captured,
    imageWidth: imageSize.width,
    imageHeight: imageSize.height,
    displayWidth: display.bounds.width,
    displayHeight: display.bounds.height,
    backend,
    frozenAt: Date.now(),
  };
}

function captureNativePrefreezeFrames(displays, activeDisplay, backend = 'win32-gdi-prefreeze') {
  const orderedDisplays = [
    ...displays.filter((display) => String(display.id) === String(activeDisplay.id)),
    ...displays.filter((display) => String(display.id) !== String(activeDisplay.id)),
  ];
  const frames = new Map();
  for (const display of orderedDisplays) {
    try {
      const captured = captureDisplay(display, (point) => screen.dipToScreenPoint(point), nativeImage);
      const frame = displayFrameEntry(display, captured, backend);
      if (frame) frames.set(String(display.id), frame);
    } catch (error) {
      writeDiagnostic('native-prefreeze-fallback', {
        displayId: String(display.id),
        name: error?.name || 'Error',
        message: error?.message || String(error),
      });
    }
  }
  return frames;
}

async function showMacScreenRecordingHelp(access = {}) {
  if (process.platform !== 'darwin') return;
  if (screenCapturePermissionDialog) return screenCapturePermissionDialog;
  screenCapturePermissionDialog = dialog.showMessageBox({
    type: 'warning',
    title: '需要允许屏幕录制',
    message: 'Luvoelle 还不能读取屏幕画面',
    detail: '请在“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”中允许 Luvoelle。修改后请退出并重新打开 Luvoelle，再使用截图快捷键。',
    buttons: ['打开系统设置', '稍后再说'],
    defaultId: 0,
    cancelId: 1,
  }).then(async ({ response }) => {
    writeDiagnostic('mac-screen-capture-permission-required', {
      status: access.status || 'unknown',
      requested: Boolean(access.requested),
      error: access.error || '',
    });
    if (response === 0) await shell.openExternal(SCREEN_RECORDING_SETTINGS_URL);
  }).finally(() => {
    screenCapturePermissionDialog = null;
  });
  return screenCapturePermissionDialog;
}

async function ensureMacCapturePermission() {
  if (process.platform !== 'darwin') return true;
  const access = await ensureScreenCaptureAccess({ desktopCapturer, systemPreferences });
  if (access.granted) return true;
  await showMacScreenRecordingHelp(access);
  return false;
}

function sourceForDisplay(sources, display, usedSources) {
  const direct = sources.find((source) => (
    !usedSources.has(source) && source.display_id && String(source.display_id) === String(display.id)
  ));
  if (direct) return direct;
  const targetWidth = Math.round(display.bounds.width * (Number(display.scaleFactor) || 1));
  const targetHeight = Math.round(display.bounds.height * (Number(display.scaleFactor) || 1));
  return sources.filter((source) => !usedSources.has(source)).sort((leftSource, rightSource) => {
    const left = leftSource.thumbnail.getSize();
    const right = rightSource.thumbnail.getSize();
    const leftScore = Math.abs(left.width - targetWidth) + Math.abs(left.height - targetHeight);
    const rightScore = Math.abs(right.width - targetWidth) + Math.abs(right.height - targetHeight);
    return leftScore - rightScore;
  })[0] || null;
}

async function captureElectronPrefreezeFrames(displays) {
  if (!displays.length) return new Map();
  const maxWidth = Math.max(...displays.map((display) => Math.round(display.bounds.width * display.scaleFactor)));
  const maxHeight = Math.max(...displays.map((display) => Math.round(display.bounds.height * display.scaleFactor)));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxWidth, height: maxHeight },
    fetchWindowIcons: false,
  });
  const frames = new Map();
  const usedSources = new Set();
  const backend = process.platform === 'darwin' ? 'macos-screencapturekit-prefreeze' : 'electron-thumbnail-prefreeze';
  displays.forEach((display) => {
    const source = sourceForDisplay(sources, display, usedSources);
    if (source) usedSources.add(source);
    const frame = displayFrameEntry(display, source ? { image: source.thumbnail } : null, backend);
    if (frame) frames.set(String(display.id), frame);
  });
  return frames;
}

function automationRootUnderCursor(display, windowTargets) {
  const cursor = screen.getCursorScreenPoint();
  const point = { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y };
  return (windowTargets || [])
    .filter((target) => target.hwnd
      && point.x >= target.left
      && point.y >= target.top
      && point.x <= target.left + target.width
      && point.y <= target.top + target.height)
    .sort((left, right) => (Number(left.zIndex) || 0) - (Number(right.zIndex) || 0))[0] || null;
}

async function supplementUiAutomationTargets({ sessionId, activeDisplay, overlay, topLevelTargets }) {
  if (process.platform !== 'win32') return;
  const root = automationRootUnderCursor(activeDisplay, topLevelTargets);
  if (!root?.hwnd) return;
  const startedAt = Date.now();
  try {
    const result = await requestUiAutomationTargets([root.hwnd]);
    if (sessionId !== captureSessionId || !captureActive || !isHealthyOverlay(overlay)
      || overlay.luvoelleCaptureSessionId !== sessionId) return;
    const automationRoot = result.roots.find((candidate) => String(candidate.handle) === String(root.hwnd));
    const targets = mapAutomationTargetsToWindowTarget(root, automationRoot, result.targets);
    overlay.webContents.send('overlay:targets-update', { sessionId, targets });
    writeDiagnostic('capture-smart-targets-ready', {
      sessionId,
      rootTitle: root.title || '',
      targets: targets.length,
      providerMs: result.elapsedMs,
      totalMs: Date.now() - startedAt,
    });
  } catch (error) {
    writeDiagnostic('capture-smart-targets-unavailable', {
      sessionId,
      rootTitle: root.title || '',
      name: error?.name || 'Error',
      message: error?.message || String(error),
      totalMs: Date.now() - startedAt,
    });
  }
}

function framePreviewDataUrl(frame, format = 'png') {
  return `data:image/png;base64,${frame.image.toPNG().toString('base64')}`;
}

function frameLosslessBmp(frame) {
  const { width, height } = frame.image.getSize();
  const bitmap = frame.image.toBitmap();
  const pixelBytes = width * height * 4;
  if (!width || !height || bitmap.length !== pixelBytes) throw new Error('Native bitmap size mismatch');
  const header = Buffer.alloc(54);
  header.write('BM', 0, 2, 'ascii');
  header.writeUInt32LE(54 + pixelBytes, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(-height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(pixelBytes, 34);
  return Buffer.concat([header, bitmap], 54 + pixelBytes);
}

async function startCapture(mode = 'translate', options = {}) {
  if (captureActive) {
    writeDiagnostic('capture-request-ignored', { mode, trigger: options.trigger || 'direct', activeMode, sessionId: captureSessionId });
    return { ok: false, message: '截图已在进行中' };
  }
  const entryStartedAt = Date.now();
  // Keep the Windows hotkey callback synchronous until the resident overlay is
  // visible. Awaiting an already-resolved macOS permission promise here caused
  // Electron's native accelerator callback to occasionally resume 0.3–3s late
  // after the app had been idle.
  if (process.platform === 'darwin' && !await ensureMacCapturePermission()) {
    return { ok: false, message: '请先在系统设置中允许 Luvoelle 读取屏幕，然后重新打开应用。' };
  }
  captureActive = true;
  // The workbench is an explicit destination, never a post-capture window.
  // Hide it before freezing the desktop and leave it hidden after completion
  // or cancellation. Only the tray and a visible "工作台" action may reveal it.
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  captureSourceFrames.clear();
  const sessionId = ++captureSessionId;
  activeMode = ['ocr', 'prompt', 'edit'].includes(mode) ? mode : 'translate';
  const requestedVariant = options.captureVariant || (activeMode === 'edit' ? 'fast' : 'faithful');
  const captureVariant = requestedVariant === 'fast' && process.platform === 'win32' ? 'fast' : 'faithful';
  const trace = beginCapturePerformanceTrace({ sessionId, mode: activeMode, captureVariant, options, entryStartedAt });

  try {
    const displays = screen.getAllDisplays();
    const ensureStartedAt = Date.now();
    // Alt+A normally uses compositor-resident windows that were created at app
    // startup. Do not cross another Promise boundary before revealing them.
    const residentWindows = captureVariant === 'fast' ? getResidentOverlayWindows(displays) : null;
    const windows = residentWindows || await ensureOverlayWindows(displays);
    windows.forEach((overlay, index) => fitOverlayToDisplay(overlay, displays[index]));
    trace.ensureOverlayMs = Date.now() - ensureStartedAt;
    trace.overlayWakePath = residentWindows ? 'resident-sync' : 'recovered-async';
    const windowTargetsStartedAt = Date.now();
    const windowTargets = legacyWindowsCompatibility
      ? new Map(displays.map((display) => [String(display.id), []]))
      : getCaptureWindowTargets(displays, (point) => screen.dipToScreenPoint(point));
    trace.windowTargetsMs = Date.now() - windowTargetsStartedAt;
    if (sessionId !== captureSessionId) return { ok: false, canceled: true };
    captureRestoreWindows = [floatWindow, assistantWindow, ...promptWindows, ...pinnedImageWindows]
      .filter((win, index, windows) => win && !win.isDestroyed() && win.isVisible() && windows.indexOf(win) === index);
    captureRestoreWindows.forEach((win) => win.hide());
    globalShortcut.unregister('Escape');
    globalShortcut.register('Escape', () => cancelCapture());
    const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    trace.activeDisplayId = String(activeDisplay.id);
    const activeIndex = displays.findIndex((display) => String(display.id) === String(activeDisplay.id));
    const focusedOverlay = windows[activeIndex >= 0 ? activeIndex : 0];

    const prepareOverlay = (display, overlay) => {
      overlay.setFocusable(true);
      overlay.setIgnoreMouseEvents(false);
      overlay.setOpacity(1);
      overlay.luvoelleCaptureVariant = captureVariant;
      overlay.luvoelleCaptureActive = true;
      overlay.luvoellePrimaryCapture = String(display.id) === String(activeDisplay.id);
      overlay.luvoelleCaptureSessionId = sessionId;
      overlay.luvoelleOverlayWakePath = trace.overlayWakePath;
      overlay.luvoelleFirstPaintMs = undefined;
      overlay.webContents.send('overlay:prepare', {
        sessionId,
        mode: activeMode,
        displayId: display.id,
        scaleFactor: display.scaleFactor,
        screenBounds: display.bounds,
        windowTargets: windowTargets.get(String(display.id)) || [],
        captureVariant,
      });
    };

    const loadOverlayFrame = (display, frame, overlay) => {
      const previewFormat = captureVariant === 'fast' ? 'bmp' : 'png';
      const preparationStartedAt = Date.now();
      const imageBytes = previewFormat === 'bmp' ? frameLosslessBmp(frame) : undefined;
      const image = previewFormat === 'png' ? framePreviewDataUrl(frame) : undefined;
      const preparationMs = Date.now() - preparationStartedAt;
      overlay.luvoellePreviewEncodingMs = previewFormat === 'png' ? preparationMs : 0;
      overlay.luvoelleLosslessPreviewEncodingMs = 0;
      overlay.luvoelleLosslessPreviewPreparationMs = previewFormat === 'bmp' ? preparationMs : 0;
      if (String(display.id) === String(activeDisplay.id)) {
        trace.previewEncodingMs = overlay.luvoellePreviewEncodingMs;
        trace.losslessPreviewEncodingMs = 0;
        trace.losslessPreviewPreparationMs = overlay.luvoelleLosslessPreviewPreparationMs;
        trace.losslessPreviewBytes = imageBytes?.length || 0;
      }
      overlay.luvoelleCaptureBackend = frame.backend;
      overlay.luvoelleFrozenAt = frame.frozenAt;
      overlay.webContents.send('overlay:init', {
        sessionId,
        mode: activeMode,
        image,
        imageBytes,
        mimeType: previewFormat === 'bmp' ? 'image/bmp' : 'image/png',
        displayId: display.id,
        scaleFactor: display.scaleFactor,
        screenBounds: display.bounds,
        captureBackend: frame.backend,
        captureVariant,
        previewFormat,
        previewQuality: 'lossless',
        frozenAt: frame.frozenAt,
      });
    };

    if (captureVariant === 'fast') {
      // Alt+A is interaction-first: reveal the already-warmed, content-protected
      // overlay immediately. Its dim surface can paint while the main process
      // captures the underlying desktop. A raw lossless BMP is decoded off the
      // main thread, while the final selection stays on the native frame below.
      prepareOverlay(activeDisplay, focusedOverlay);
      raiseOverlay(focusedOverlay);
      focusedOverlay.focus();
      focusedOverlay.luvoelleEntryLatencyMs = Date.now() - entryStartedAt;
      trace.mainEntryMs = focusedOverlay.luvoelleEntryLatencyMs;
      trace.shortcutToMainEntryMs = Date.now() - trace.shortcutReceivedAt;
      const paintWaitStartedAt = Date.now();
      const firstPaintCompleted = await Promise.race([
        trace.firstPaintPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 140)),
      ]);
      trace.firstPaintBarrierMs = Date.now() - paintWaitStartedAt;
      trace.firstPaintBarrierTimedOut = !firstPaintCompleted;
      if (sessionId !== captureSessionId) return { ok: false, canceled: true };
    }

    // Faithful/F1 capture reaches this point before the overlay is focused, so
    // transient Shell UI is preserved. Fast/Alt+A reaches it immediately after
    // the protected overlay is visible, prioritizing entry latency.
    flushDesktopComposition();
    const prefreezeStartedAt = Date.now();
    const frames = process.platform === 'win32' && !legacyWindowsCompatibility
      ? captureNativePrefreezeFrames([activeDisplay], activeDisplay)
      : new Map();
    if (!frames.has(String(activeDisplay.id))) {
      const fallbackFrames = await captureElectronPrefreezeFrames(displays);
      displays.forEach((display) => {
        const id = String(display.id);
        if (!frames.has(id) && fallbackFrames.has(id)) frames.set(id, fallbackFrames.get(id));
      });
    }
    if (sessionId !== captureSessionId) return { ok: false, canceled: true };
    const activeFrame = frames.get(String(activeDisplay.id));
    if (!activeFrame) throw new Error('Unable to freeze the active display');
    captureSourceFrames = frames;
    focusedOverlay.luvoellePrefreezeLatencyMs = Date.now() - prefreezeStartedAt;
    trace.captureMs = focusedOverlay.luvoellePrefreezeLatencyMs;
    if (captureVariant === 'faithful') prepareOverlay(activeDisplay, focusedOverlay);
    loadOverlayFrame(activeDisplay, activeFrame, focusedOverlay);
    // UI Automation runs out-of-process and only after the frozen frame has
    // been delivered. It enriches snapping without entering the Alt+A
    // interaction-critical path or delaying the first overlay paint.
    setImmediate(() => supplementUiAutomationTargets({
      sessionId,
      activeDisplay,
      overlay: focusedOverlay,
      topLevelTargets: windowTargets.get(String(activeDisplay.id)) || [],
    }));
    if (captureVariant === 'faithful') {
      raiseOverlay(focusedOverlay);
      focusedOverlay.focus();
      focusedOverlay.luvoelleEntryLatencyMs = Date.now() - entryStartedAt;
      trace.mainEntryMs = focusedOverlay.luvoelleEntryLatencyMs;
      trace.shortcutToMainEntryMs = Date.now() - trace.shortcutReceivedAt;
    }

    // Let the active monitor paint immediately. Secondary monitors are frozen
    // afterwards; the invisible, content-protected overlays cannot leak into
    // those frames, and transient UI is expected to be under the cursor on the
    // already-frozen active monitor.
    await new Promise((resolve) => setImmediate(resolve));
    if (sessionId !== captureSessionId) return { ok: false, canceled: true };
    const remainingDisplays = displays.filter((display) => !frames.has(String(display.id)));
    if (remainingDisplays.length && process.platform === 'win32' && !legacyWindowsCompatibility) {
      const secondaryFrames = captureNativePrefreezeFrames(remainingDisplays, activeDisplay, 'win32-gdi-secondary-freeze');
      secondaryFrames.forEach((frame, id) => frames.set(id, frame));
    }
    if (frames.size < displays.length) {
      const fallbackFrames = await captureElectronPrefreezeFrames(displays);
      displays.forEach((display) => {
        const id = String(display.id);
        if (!frames.has(id) && fallbackFrames.has(id)) frames.set(id, fallbackFrames.get(id));
      });
    }
    if (sessionId !== captureSessionId) return { ok: false, canceled: true };
    if (frames.size < displays.length) throw new Error('Unable to freeze every display');
    displays.forEach((display, index) => {
      if (String(display.id) === String(activeDisplay.id)) return;
      prepareOverlay(display, windows[index]);
      loadOverlayFrame(display, frames.get(String(display.id)), windows[index]);
      windows[index].luvoelleEntryLatencyMs = Date.now() - entryStartedAt;
      raiseOverlay(windows[index], true);
    });
    trace.completedMs = Date.now() - entryStartedAt;
    return { ok: true, captureBackend: activeFrame.backend, captureVariant };
  } catch (error) {
    trace.error = error?.message || String(error);
    cancelCapture();
    return { ok: false, message: error.message };
  }
}

function broadcastJob(payload) {
  if (floatWindow && !floatWindow.isDestroyed()) pendingFloatPayload = payload;
  [mainWindow, floatWindow].forEach((win) => {
    if (win && !win.isDestroyed()) win.webContents.send('job:event', payload);
  });
}

function floatPosition(width, height) {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  return {
    x: Math.max(area.x + 16, Math.min(point.x + 22, area.x + area.width - width - 16)),
    y: Math.max(area.y + 16, Math.min(point.y + 18, area.y + area.height - height - 16)),
  };
}

function getFloatReadingBounds() {
  const current = floatWindow?.getBounds() || { ...screen.getCursorScreenPoint(), width: 530, height: 620 };
  const display = screen.getDisplayNearestPoint({
    x: current.x + Math.round(current.width / 2),
    y: current.y + Math.round(current.height / 2),
  });
  const area = display.workArea;
  const width = Math.max(430, Math.min(960, Math.max(760, Math.round(area.width * 0.68)), area.width - 32));
  const height = Math.max(330, Math.min(860, Math.max(700, Math.round(area.height * 0.82)), area.height - 32));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

function toggleFloatReadingSize() {
  if (!floatWindow || floatWindow.isDestroyed()) return false;
  if (floatReadingSize === 'normal') {
    floatModerateBounds = getFloatReadingBounds();
    floatReadingSize = 'moderate';
    floatWindow.setBounds(floatModerateBounds, true);
  } else if (floatReadingSize === 'moderate') {
    floatModerateBounds = floatWindow.getBounds();
    floatReadingSize = 'maximized';
    floatWindow.maximize();
  } else {
    floatReadingSize = 'moderate';
    floatWindow.unmaximize();
    floatModerateBounds ||= getFloatReadingBounds();
    floatWindow.setBounds(floatModerateBounds, true);
  }
  return { mode: floatReadingSize, maximized: floatWindow.isMaximized(), bounds: floatWindow.getBounds() };
}

function createFloat(payload) {
  pendingFloatPayload = payload;
  const width = 530;
  const height = 620;
  const position = floatPosition(width, height);
  if (!floatWindow || floatWindow.isDestroyed()) {
    floatReady = false;
    floatWindow = new BrowserWindow(browserOptions({
      ...position,
      width,
      height,
      minWidth: 430,
      minHeight: 330,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      hasShadow: true,
      roundedCorners: true,
    }));
    floatWindow.loadFile(path.join(__dirname, 'renderer', 'float.html'));
    floatWindow.webContents.once('did-finish-load', () => {
      floatReady = true;
      floatWindow.show();
      floatWindow.focus();
      if (pendingFloatPayload) floatWindow.webContents.send('job:event', pendingFloatPayload);
    });
    floatWindow.on('closed', () => {
      floatWindow = null;
      floatReady = false;
      floatReadingSize = 'normal';
      floatModerateBounds = null;
    });
  } else {
    if (floatWindow.isMaximized()) floatWindow.unmaximize();
    floatReadingSize = 'normal';
    floatModerateBounds = null;
    floatWindow.setBounds({ ...position, width, height }, true);
    floatWindow.show();
    floatWindow.focus();
    if (floatReady) floatWindow.webContents.send('job:event', payload);
  }
}

function isUsablePromptWindow(win) {
  return Boolean(win && !win.isDestroyed() && !win.webContents.isDestroyed());
}

function cancelPromptAnalysis(jobId) {
  if (!jobId) return;
  const run = promptAnalysisRuns.get(jobId);
  if (run) run.controller.abort();
  promptAnalysisRuns.delete(jobId);
}

function releasePromptWindowJob(win) {
  const jobId = win?.luvoellePromptJobId;
  if (!jobId) return;
  cancelPromptAnalysis(jobId);
  if (promptJobWindows.get(jobId) === win) promptJobWindows.delete(jobId);
  win.luvoellePromptJobId = null;
}

function sendPromptWindowState(win) {
  if (!isUsablePromptWindow(win) || !win.luvoellePromptReady) return;
  win.webContents.send('window:state', {
    maximized: win.isMaximized(),
    pinned: win.isAlwaysOnTop(),
  });
}

function broadcastPrompt(payload, targetWindow = null) {
  const jobId = payload?.job?.id || payload?.jobId;
  const win = targetWindow || promptJobWindows.get(jobId) || promptWindow;
  if (!isUsablePromptWindow(win)) return;
  win.luvoellePendingPromptPayload = payload;
  if (win.luvoellePromptReady) win.webContents.send('prompt:event', payload);
}

function defaultPromptBounds(display) {
  const area = display.workArea;
  const width = Math.min(980, Math.max(820, area.width - 96));
  const height = Math.min(820, Math.max(660, area.height - 72));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

function comparisonPromptBounds(fixedWindow, display) {
  const area = display.workArea;
  if (!isUsablePromptWindow(fixedWindow) || area.width < 1360) return defaultPromptBounds(display);
  const margin = 12;
  const gap = 12;
  const width = Math.floor((area.width - margin * 2 - gap) / 2);
  const height = Math.max(600, area.height - margin * 2);
  const left = { x: area.x + margin, y: area.y + margin, width, height };
  const right = { x: left.x + width + gap, y: left.y, width, height };
  if (fixedWindow.isMaximized()) fixedWindow.unmaximize();
  fixedWindow.setBounds(left, true);
  return right;
}

function createPromptBrowserWindow(bounds) {
  const win = new BrowserWindow(browserOptions({
    ...bounds,
    minWidth: 660,
    minHeight: 540,
    frame: false,
    backgroundColor: '#f5f5f7',
    resizable: true,
    maximizable: true,
    hasShadow: true,
  }));
  win.luvoellePromptReady = false;
  win.luvoellePendingPromptPayload = null;
  promptWindows.add(win);
  if (process.platform === 'win32' && typeof win.setBackgroundMaterial === 'function') win.setBackgroundMaterial('mica');
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      if (isUsablePromptWindow(win)) win.webContents.send('prompt:event', { type: 'escape' });
    }
  });
  win.on('maximize', () => sendPromptWindowState(win));
  win.on('unmaximize', () => sendPromptWindowState(win));
  win.webContents.once('did-finish-load', () => {
    if (!isUsablePromptWindow(win)) return;
    win.luvoellePromptReady = true;
    win.show();
    win.focus();
    sendPromptWindowState(win);
    if (win.luvoellePendingPromptPayload) win.webContents.send('prompt:event', win.luvoellePendingPromptPayload);
  });
  win.on('closed', () => {
    releasePromptWindowJob(win);
    promptWindows.delete(win);
    if (promptWindow === win) promptWindow = Array.from(promptWindows).filter(isUsablePromptWindow).at(-1) || null;
  });
  win.loadFile(path.join(__dirname, 'renderer', 'prompt.html'));
  return win;
}

function createPromptWindow(payload, { targetWindow = null } = {}) {
  const requestedWindow = isUsablePromptWindow(targetWindow) ? targetWindow : null;
  const reusableWindow = !requestedWindow && isUsablePromptWindow(promptWindow) && !promptWindow.isAlwaysOnTop()
    ? promptWindow
    : null;
  let win = requestedWindow || reusableWindow;
  const fixedWindow = !requestedWindow
    ? Array.from(promptWindows).filter((candidate) => (
      isUsablePromptWindow(candidate) && candidate !== reusableWindow && candidate.isAlwaysOnTop()
    )).at(-1) || null
    : null;
  const displayPoint = fixedWindow
    ? (() => { const bounds = fixedWindow.getBounds(); return { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) }; })()
    : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(displayPoint);

  if (!win) {
    win = createPromptBrowserWindow(fixedWindow ? comparisonPromptBounds(fixedWindow, display) : defaultPromptBounds(display));
    promptWindow = win;
  } else if (!requestedWindow) {
    win.setBounds(fixedWindow ? comparisonPromptBounds(fixedWindow, display) : defaultPromptBounds(display), true);
  }

  const nextJobId = payload?.job?.id;
  if (win.luvoellePromptJobId && win.luvoellePromptJobId !== nextJobId) releasePromptWindowJob(win);
  if (nextJobId) {
    win.luvoellePromptJobId = nextJobId;
    promptJobWindows.set(nextJobId, win);
  }
  win.luvoellePendingPromptPayload = payload;
  win.show();
  win.focus();
  if (win.luvoellePromptReady) win.webContents.send('prompt:event', payload);
  return win;
}

function createImageEditor(dataUrl) {
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(dataUrl || '')) throw new Error('没有可编辑的截图。');
  pendingEditorImage = dataUrl;
  restoreFloatAfterEditor = Boolean(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible());
  if (restoreFloatAfterEditor) floatWindow.hide();

  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const width = Math.min(1180, Math.max(720, area.width - 40));
  const height = Math.min(820, Math.max(520, area.height - 40));
  const bounds = {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };

  if (!editorWindow || editorWindow.isDestroyed()) {
    editorWindow = new BrowserWindow(browserOptions({
      ...bounds,
      minWidth: 720,
      minHeight: 520,
      frame: false,
      backgroundColor: '#171719',
      resizable: true,
      maximizable: true,
      hasShadow: true,
    }));
    editorWindow.loadFile(path.join(__dirname, 'renderer', 'editor.html'));
    editorWindow.webContents.once('did-finish-load', () => {
      editorWindow.show();
      editorWindow.focus();
      editorWindow.webContents.send('editor:init', { dataUrl: pendingEditorImage });
    });
    editorWindow.on('closed', () => {
      editorWindow = null;
      pendingEditorImage = null;
      if (restoreFloatAfterEditor && floatWindow && !floatWindow.isDestroyed()) {
        floatWindow.show();
        floatWindow.focus();
      }
      restoreFloatAfterEditor = false;
    });
  } else {
    editorWindow.setBounds(bounds, true);
    editorWindow.show();
    editorWindow.focus();
    editorWindow.webContents.send('editor:init', { dataUrl: pendingEditorImage });
  }
}

function createPinnedImageWindow(sender, payload = {}) {
  const dataUrl = payload.dataUrl;
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(dataUrl || '')) throw new Error('没有可固定的截图。');
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('无法读取要固定的截图。');
  const imageSize = image.getSize();
  const sourceWindow = BrowserWindow.fromWebContents(sender);
  const sourceBounds = sourceWindow && !sourceWindow.isDestroyed() ? sourceWindow.getBounds() : null;
  const requestedRect = payload.rect && [payload.rect.left, payload.rect.top, payload.rect.width, payload.rect.height].every((value) => Number.isFinite(Number(value)))
    ? {
      left: Number(payload.rect.left),
      top: Number(payload.rect.top),
      width: Math.max(1, Number(payload.rect.width)),
      height: Math.max(1, Number(payload.rect.height)),
    }
    : null;
  const point = sourceBounds && requestedRect
    ? { x: sourceBounds.x + requestedRect.left, y: sourceBounds.y + requestedRect.top }
    : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
  const area = display.workArea;
  const naturalWidth = requestedRect?.width || imageSize.width;
  const naturalHeight = requestedRect?.height || imageSize.height;
  const maximumWidth = Math.min(760, area.width - 32);
  const maximumHeight = Math.min(620, area.height - 32);
  const fitScale = Math.min(1, maximumWidth / naturalWidth, maximumHeight / naturalHeight);
  let width = Math.max(140, Math.round(naturalWidth * fitScale));
  let height = Math.max(96, Math.round(naturalHeight * fitScale));
  const aspectRatio = Math.max(0.1, imageSize.width / imageSize.height);
  if (width / height > aspectRatio) width = Math.max(140, Math.round(height * aspectRatio));
  else height = Math.max(96, Math.round(width / aspectRatio));
  width = Math.min(width, maximumWidth);
  height = Math.min(height, maximumHeight);
  const x = Math.max(area.x + 8, Math.min(Math.round(point.x), area.x + area.width - width - 8));
  const y = Math.max(area.y + 8, Math.min(Math.round(point.y), area.y + area.height - height - 8));

  const pinWindow = new BrowserWindow(browserOptions({
    x,
    y,
    width,
    height,
    minWidth: 140,
    minHeight: 96,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    movable: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
  }));
  pinWindow.setAlwaysOnTop(true, 'pop-up-menu');
  if (process.platform === 'darwin') pinWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pinWindow.setAspectRatio(aspectRatio);
  pinnedImageWindows.add(pinWindow);
  pinWindow.loadFile(path.join(__dirname, 'renderer', 'pin.html'));
  pinWindow.webContents.once('did-finish-load', () => {
    if (pinWindow.isDestroyed()) return;
    pinWindow.webContents.send('pin:init', { dataUrl, width: imageSize.width, height: imageSize.height });
    pinWindow.showInactive();
  });
  pinWindow.on('closed', () => pinnedImageWindows.delete(pinWindow));
  return { ok: true, count: pinnedImageWindows.size };
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('无法读取图片数据。');
  return Buffer.from(match[1], 'base64');
}

async function nativeCapturedRegion(payload = {}) {
  if (process.platform !== 'win32' || legacyWindowsCompatibility || !payload.rect) return null;
  const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === String(payload.displayId));
  if (!display) return null;
  const rect = payload.rect;
  const values = [rect.left, rect.top, rect.width, rect.height].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return null;
  const scaleFactor = Number(display.scaleFactor) || 1;
  const physicalWidth = Math.max(1, Math.round(display.bounds.width * scaleFactor));
  const physicalHeight = Math.max(1, Math.round(display.bounds.height * scaleFactor));
  const viewportWidth = Math.max(1, Number(payload.viewportWidth) || display.bounds.width);
  const viewportHeight = Math.max(1, Number(payload.viewportHeight) || display.bounds.height);
  const pixelRect = mapViewportRectToPixels(rect, { width: viewportWidth, height: viewportHeight }, { width: physicalWidth, height: physicalHeight });
  if (!pixelRect) return null;
  const { left, top, right, bottom } = pixelRect;
  const displayOrigin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
  const hiddenOverlays = overlayWindows.filter((overlay) => !overlay.isDestroyed() && overlay.isVisible());
  hiddenOverlays.forEach((overlay) => overlay.hide());

  const restoreInlineOverlays = () => {
    if (!payload.inline || !captureActive) return;
    const target = hiddenOverlays.find((overlay) => String(overlay.luvoelleDisplayId) === String(payload.displayId));
    hiddenOverlays.forEach((overlay) => {
      overlay.setFocusable(true);
      overlay.setIgnoreMouseEvents(false);
      overlay.setOpacity(1);
      if (overlay !== target) overlay.showInactive();
    });
    if (target && !target.isDestroyed()) {
      target.show();
      target.focus();
    }
  };

  let captured;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    if (!flushDesktopComposition()) await new Promise((resolve) => setTimeout(resolve, 32));
    if (!captureActive) return null;
    captured = capturePhysicalRectangle({
      x: displayOrigin.x + left,
      y: displayOrigin.y + top,
      width: right - left,
      height: bottom - top,
    }, nativeImage);
  } catch (error) {
    writeDiagnostic('native-region-capture-fallback', {
      displayId: String(display.id),
      name: error?.name || 'Error',
      message: error?.message || String(error),
    });
  } finally {
    restoreInlineOverlays();
  }
  if (!captured?.image || captured.image.isEmpty()) return null;
  const png = captured.image.toPNG();
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return null;
  return {
    image,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: captured.width,
    height: captured.height,
    backend: 'win32-gdi-region',
  };
}

function losslessCapturedRegion(payload = {}) {
  const frame = captureSourceFrames.get(String(payload.displayId));
  const rect = payload.rect;
  if (!frame?.image || frame.image.isEmpty() || !frame.imageWidth || !frame.imageHeight || !rect) return null;
  const sourceImage = frame.image;
  if (sourceImage.isEmpty()) return null;
  const imageSize = sourceImage.getSize();
  if (!imageSize.width || !imageSize.height || !frame.displayWidth || !frame.displayHeight) return null;
  const viewportWidth = Math.max(1, Number(payload.viewportWidth) || frame.displayWidth);
  const viewportHeight = Math.max(1, Number(payload.viewportHeight) || frame.displayHeight);
  const pixelRect = mapViewportRectToPixels(rect, { width: viewportWidth, height: viewportHeight }, imageSize);
  if (!pixelRect) return null;
  const { left, top, right, bottom } = pixelRect;
  const croppedImage = sourceImage.crop({ x: left, y: top, width: right - left, height: bottom - top });
  if (croppedImage.isEmpty()) return null;
  const png = croppedImage.toPNG();
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return null;
  return {
    image,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: right - left,
    height: bottom - top,
    backend: frame.backend || 'unknown',
  };
}

async function writeCapturedImageToClipboard(image) {
  if (!image || image.isEmpty()) return false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    clipboard.write({ image });
    if (!clipboard.readImage().isEmpty()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }
  return false;
}

function getTessdataPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'tessdata')
    : path.join(__dirname, '..', 'assets', 'tessdata');
}

async function getTesseractWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(['eng', 'chi_sim'], OEM.LSTM_ONLY, {
      langPath: getTessdataPath(),
      cachePath: path.join(app.getPath('userData'), 'ocr-cache'),
      gzip: true,
      logger: (message) => {
        if (typeof message.progress === 'number' && workerProgressHandler) {
          workerProgressHandler({
            stage: message.status,
            progress: Math.round(message.progress * 100),
          });
        }
      },
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      return worker;
    }).catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function analyzeTextLanguage(text) {
  const chineseCharacters = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  const latinCharacters = latinWords.reduce((total, word) => total + word.replace(/[^A-Za-z]/g, '').length, 0);
  const hasEnglish = latinWords.some((word) => word.replace(/[^A-Za-z]/g, '').length >= 2) || latinCharacters >= 3;
  return {
    chineseCharacters,
    latinCharacters,
    hasEnglish,
    chineseOnly: chineseCharacters > 0 && !hasEnglish,
  };
}

function normalizeOcr(data) {
  const blocks = [];
  (data.blocks || []).forEach((block, blockIndex) => {
    (block.paragraphs || []).forEach((paragraph, paragraphIndex) => {
      (paragraph.lines || []).forEach((line, lineIndex) => {
        const text = (line.text || '').trim();
        if (!text) return;
        const bbox = line.bbox || {};
        blocks.push({
          text,
          confidence: Math.round(line.confidence || 0),
          rect: {
            x: bbox.x0 || 0,
            y: bbox.y0 || 0,
            width: Math.max(0, (bbox.x1 || 0) - (bbox.x0 || 0)),
            height: Math.max(0, (bbox.y1 || 0) - (bbox.y0 || 0)),
          },
          lineId: `${blockIndex}-${paragraphIndex}-${lineIndex}`,
          paragraphId: `${blockIndex}-${paragraphIndex}`,
        });
      });
    });
  });
  const text = (data.text || blocks.map((block) => block.text).join('\n')).replace(/\n{3,}/g, '\n\n').trim();
  const languageProfile = analyzeTextLanguage(text);
  return {
    text,
    confidence: Math.round(data.confidence || 0),
    detectedLanguage: languageProfile.chineseCharacters > 0 ? 'zh-CN' : 'en',
    languageProfile,
    blocks,
  };
}

async function recognizeWithTesseract(dataUrl, onProgress = null) {
  const progressHandler = typeof onProgress === 'function' ? onProgress : null;
  workerProgressHandler = progressHandler;
  try {
    const worker = await getTesseractWorker();
    const { data } = await worker.recognize(dataUrlToBuffer(dataUrl), {}, { text: true, blocks: true, tsv: true });
    return normalizeOcr(data);
  } finally {
    if (workerProgressHandler === progressHandler) workerProgressHandler = null;
  }
}

function shouldRefinePaddleResult(result) {
  const blocks = result.blocks || [];
  if (!blocks.length) return true;
  if (Number(result.confidence || 0) < 82) return true;
  return blocks.some((block) => (
    (Number(block.rect?.height || 0) < 18 && Number(block.confidence || 0) < 90)
    || /[�□]{1,}|[A-Za-z][?？][A-Za-z]|[?？]{2,}/.test(block.text || '')
  ));
}

function buildPaddleRefinementImage(dataUrl, blocks) {
  const image = nativeImage.createFromBuffer(dataUrlToBuffer(dataUrl));
  if (image.isEmpty()) return null;
  const size = image.getSize();
  const smallestHeight = blocks.length ? Math.min(...blocks.map((block) => Number(block.rect?.height || 0)).filter(Boolean)) : 0;
  let scale = smallestHeight > 0 && smallestHeight < 12 ? 2.4 : smallestHeight > 0 && smallestHeight < 18 ? 2 : 1.65;
  scale = Math.max(1.2, Math.min(scale, 3200 / Math.max(size.width, size.height), Math.sqrt(7_500_000 / Math.max(1, size.width * size.height))));
  const width = Math.max(size.width + 1, Math.round(size.width * scale));
  const resized = image.resize({ width, quality: 'best' });
  const actualScale = resized.getSize().width / Math.max(1, size.width);
  return { dataUrl: resized.toDataURL(), scale: actualScale };
}

function paddleBlockOverlap(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return ((right - left) * (bottom - top)) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

function mergePaddleResults(primary, refined) {
  const blocks = (primary.blocks || []).map((block) => ({ ...block, rect: { ...block.rect } }));
  (refined.blocks || []).forEach((candidate) => {
    let bestIndex = -1;
    let bestOverlap = 0;
    blocks.forEach((block, index) => {
      const overlap = paddleBlockOverlap(block.rect, candidate.rect);
      if (overlap > bestOverlap) {
        bestIndex = index;
        bestOverlap = overlap;
      }
    });
    if (bestIndex >= 0 && bestOverlap >= 0.42) {
      const current = blocks[bestIndex];
      const candidateHasMoreDetail = candidate.text.length > current.text.length * 1.2 && candidate.confidence >= current.confidence - 3;
      if (candidate.confidence > current.confidence + 2 || candidateHasMoreDetail) blocks[bestIndex] = candidate;
      return;
    }
    if (candidate.confidence >= 52) blocks.push(candidate);
  });
  blocks.sort((a, b) => {
    const tolerance = Math.max(7, Math.min(a.rect.height, b.rect.height) * 0.55);
    if (Math.abs(a.rect.y - b.rect.y) <= tolerance) return a.rect.x - b.rect.x;
    return a.rect.y - b.rect.y;
  });
  const normalizedBlocks = blocks.map((block, index) => ({
    ...block,
    lineId: `paddle-${index}`,
    paragraphId: `paddle-${index}`,
  }));
  const totalWeight = normalizedBlocks.reduce((sum, block) => sum + Math.max(1, block.text.length), 0);
  const confidence = totalWeight
    ? Math.round(normalizedBlocks.reduce((sum, block) => sum + block.confidence * Math.max(1, block.text.length), 0) / totalWeight)
    : Math.max(primary.confidence || 0, refined.confidence || 0);
  return {
    ...primary,
    text: normalizedBlocks.map((block) => block.text).join('\n').trim(),
    confidence,
    blocks: normalizedBlocks,
    localRefined: true,
    metrics: {
      ...primary.metrics,
      refinement: refined.metrics,
      totalMs: Number(primary.metrics?.totalMs || 0) + Number(refined.metrics?.totalMs || 0),
    },
  };
}

function paddleProviderLabel(result) {
  const executionProvider = String(result.runtime?.provider || '').toLowerCase();
  const accelerator = executionProvider === 'cpu' ? '原生 CPU' : executionProvider === 'webgpu' ? 'WebGPU' : executionProvider === 'wasm' ? 'WASM' : '本地加速';
  return `PP-OCRv6 small 本地 OCR · ${accelerator}${result.localRefined ? ' · 小字增强' : ''}`;
}

async function recognize(dataUrl, onProgress = null) {
  const startedAt = Date.now();
  try {
    let paddleResult = await recognizeWithPaddle(dataUrl, onProgress);
    if (shouldRefinePaddleResult(paddleResult)) {
      const enhancement = buildPaddleRefinementImage(dataUrl, paddleResult.blocks || []);
      if (enhancement) {
        const refinedResult = await recognizeWithPaddle(enhancement.dataUrl, onProgress, { refined: true, scale: enhancement.scale });
        paddleResult = mergePaddleResults(paddleResult, refinedResult);
      }
    }
    const languageProfile = analyzeTextLanguage(paddleResult.text || '');
    return {
      ...paddleResult,
      detectedLanguage: languageProfile.chineseCharacters > 0 ? 'zh-CN' : 'en',
      languageProfile,
      provider: paddleProviderLabel(paddleResult),
      engine: 'paddle',
      latency: Date.now() - startedAt,
    };
  } catch (paddleError) {
    onProgress?.({ stage: 'tesseract-fallback', progress: 8 });
    const fallback = await recognizeWithTesseract(dataUrl, ({ stage, progress }) => {
      onProgress?.({ stage, progress: Math.max(8, Math.round(8 + Number(progress || 0) * 0.92)) });
    });
    return {
      ...fallback,
      provider: 'Tesseract 本地 OCR · PP-OCRv6 自动回退',
      engine: 'tesseract',
      latency: Date.now() - startedAt,
      fallbackReason: paddleError.message,
    };
  }
}

function localOcrProvider(localOcr, mode, aiFailed = false) {
  const base = localOcr.provider || 'PP-OCRv6 small 本地 OCR';
  if (aiFailed) return `${base} · GPT 增强失败，已保留本地结果`;
  if (mode === 'auto') return `${base} · 自动判定无需 GPT`;
  return base;
}

async function recognizeWithConfiguredMode(dataUrl, { onProgress, onLocalPreview } = {}) {
  const mode = ['local', 'auto', 'ai'].includes(store.settings.ocrMode) ? store.settings.ocrMode : 'local';
  const threshold = Math.max(50, Math.min(98, Number(store.settings.ocrConfidenceThreshold || 82)));
  const localStartedAt = Date.now();
  const localOcr = await recognize(dataUrl, ({ stage, progress }) => {
    if (typeof onProgress !== 'function') return;
    const routedProgress = mode === 'local' ? progress : Math.min(78, Math.round(Number(progress || 0) * 0.78));
    onProgress({ stage, progress: routedProgress });
  });
  const localLatency = Date.now() - localStartedAt;
  const baseResult = {
    ...localOcr,
    provider: localOcrProvider(localOcr, mode),
    engine: localOcr.engine || 'local',
    mode,
    enhanced: false,
    latency: localLatency,
  };
  const needsAi = mode === 'ai' || (mode === 'auto' && shouldEnhanceOcr(localOcr, threshold));
  if (!needsAi) return baseResult;

  if (typeof onLocalPreview === 'function') onLocalPreview(baseResult);
  if (typeof onProgress === 'function') onProgress({ stage: 'ai-ocr', progress: 84 });

  try {
    const aiResult = await requestAiOcr({
      endpoint: store.settings.visionEndpoint,
      apiKey: decryptSecret(store.settings.visionApiKeyEncrypted),
      model: store.settings.visionModel,
      dataUrl,
      localText: localOcr.text,
    });
    const languageProfile = analyzeTextLanguage(aiResult.text);
    return {
      text: aiResult.text,
      confidence: aiResult.confidence || localOcr.confidence,
      detectedLanguage: languageProfile.chineseCharacters > 0 ? 'zh-CN' : aiResult.detectedLanguage === 'mixed' ? 'mixed' : 'en',
      languageProfile,
      blocks: aiResult.text === localOcr.text ? localOcr.blocks : [],
      provider: `${aiResult.provider} · ${mode === 'ai' ? 'GPT 精确 OCR' : 'GPT 自动增强'}`,
      engine: 'ai',
      mode,
      enhanced: true,
      latency: localLatency + aiResult.latency,
      aiLatency: aiResult.latency,
      localConfidence: localOcr.confidence,
    };
  } catch (error) {
    return {
      ...baseResult,
      provider: localOcrProvider(localOcr, mode, true),
      enhancementError: error.name === 'TimeoutError' ? 'AI OCR 超时' : error.message,
    };
  }
}

function languageName(code) {
  return ({
    'zh-CN': '简体中文',
    'zh-TW': '繁体中文',
    en: '英语',
    ja: '日语',
    ko: '韩语',
    fr: '法语',
    de: '德语',
    es: '西班牙语',
    vi: '越南语',
    th: '泰语',
  })[code] || code;
}

function chunkText(text, max = 3500) {
  const paragraphs = text.split(/\n+/);
  const chunks = [];
  let current = '';
  paragraphs.forEach((paragraph) => {
    if ((current + paragraph).length > max && current) {
      chunks.push(current.trim());
      current = '';
    }
    if (paragraph.length > max) {
      for (let index = 0; index < paragraph.length; index += max) chunks.push(paragraph.slice(index, index + max));
    } else {
      current += `${current ? '\n' : ''}${paragraph}`;
    }
  });
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function translateWithGoogle(text, targetLanguage) {
  const results = [];
  for (const chunk of chunkText(text)) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', targetLanguage);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', chunk);
    const response = await fetchTranslationService(url.toString(), { signal: AbortSignal.timeout(20000) }, 'Google 翻译');
    if (!response.ok) throw new Error(`翻译服务响应异常（${response.status}）`);
    const json = await response.json();
    results.push((json[0] || []).map((part) => part[0]).join(''));
  }
  return results.join('\n');
}

async function translateWithOpenAI(text, targetLanguage, provider = store.settings.provider) {
  const endpoint = store.settings.endpoint.replace(/\/$/, '');
  const apiKey = decryptSecret(provider === 'deepseek'
    ? store.settings.deepseekApiKeyEncrypted
    : store.settings.apiKeyEncrypted);
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(endpoint);
  if (!apiKey && !isLocal) {
    throw new Error(provider === 'deepseek'
      ? '请先打开工作台 → 设置 → 翻译服务，填写 DeepSeek API Key 并保存。'
      : '请先在设置中保存 API Key。');
  }
  const isDeepSeek = provider === 'deepseek';
  const response = await fetchTranslationService(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: store.settings.model,
      temperature: 0.1,
      ...(isDeepSeek ? {
        thinking: { type: 'disabled' },
        max_tokens: Math.max(256, Math.min(8192, Math.ceil(text.length * 2.5))),
      } : {}),
      messages: [
        {
          role: 'system',
          content: `你是桌面截图翻译器。把用户文本准确翻译成${languageName(targetLanguage)}。保留段落、列表、数字和专有名词；只输出译文，不解释。`,
        },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  }, isDeepSeek ? 'DeepSeek' : provider === 'cun' ? 'CUN.AI' : 'GPT 翻译服务');
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`翻译请求失败（${response.status}）：${detail.slice(0, 180)}`);
  }
  const json = await response.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

async function fetchTranslationService(url, options, serviceLabel) {
  try {
    return await net.fetch(url, options);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error(`${serviceLabel}连接超时，请检查网络或系统代理后重试。`);
    }
    throw new Error(`无法连接${serviceLabel}。请检查网络、系统代理或防火墙后重试。`);
  }
}

function hasConfiguredContextTranslator() {
  const endpoint = String(store.settings.endpoint || '').trim();
  const model = String(store.settings.model || '').trim();
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(endpoint);
  return Boolean(endpoint && model && (isLocal || store.settings.apiKeyEncrypted));
}

async function translate(text, targetLanguage = store.settings.targetLanguage) {
  if (!text.trim()) throw new Error('没有可翻译的文字。');
  const startedAt = Date.now();
  const configuredProvider = ['google', 'openai', 'cun', 'deepseek', 'auto'].includes(store.settings.provider) ? store.settings.provider : 'google';
  const contextTranslatorReady = hasConfiguredContextTranslator();
  const preferredProvider = configuredProvider === 'auto'
    ? (contextTranslatorReady && shouldUseContextTranslation(text) ? 'openai' : 'google')
    : configuredProvider;
  let actualProvider = preferredProvider;
  let fallback = false;
  let translatedText;
  try {
    translatedText = ['openai', 'cun', 'deepseek'].includes(preferredProvider)
      ? await translateWithOpenAI(text, targetLanguage, preferredProvider)
      : await translateWithGoogle(text, targetLanguage);
  } catch (error) {
    if (configuredProvider !== 'auto') throw error;
    const alternate = preferredProvider === 'openai' ? 'google' : contextTranslatorReady ? 'openai' : '';
    if (!alternate) throw error;
    actualProvider = alternate;
    fallback = true;
    translatedText = alternate === 'openai'
      ? await translateWithOpenAI(text, targetLanguage, alternate)
      : await translateWithGoogle(text, targetLanguage);
  }
  const providerName = actualProvider === 'cun'
    ? `CUN.AI · ${store.settings.model}`
    : actualProvider === 'deepseek' ? `DeepSeek · ${store.settings.model}`
    : actualProvider === 'openai' ? store.settings.model : 'Google Translate';
  return {
    text: translatedText,
    provider: configuredProvider === 'auto' ? `${providerName} · ${fallback ? '自动回退' : '自动选择'}` : providerName,
    route: actualProvider,
    automatic: configuredProvider === 'auto',
    fallback,
    targetLanguage,
    latency: Date.now() - startedAt,
  };
}

function addHistory(result) {
  const item = {
    id: result.id,
    mode: result.mode,
    createdAt: result.createdAt,
    sourceText: result.ocr.text,
    translation: result.translation?.text || '',
    sourceLanguage: result.ocr.detectedLanguage,
    targetLanguage: result.translation?.targetLanguage || '',
    confidence: result.ocr.confidence,
    provider: result.translation?.provider || result.ocr.provider || 'PP-OCRv6 small 本地 OCR',
    ocrProvider: result.ocr.provider || 'PP-OCRv6 small 本地 OCR',
    ocrEnhanced: Boolean(result.ocr.enhanced),
    ocrLatency: Number(result.ocr.latency || 0),
    translationSkipped: Boolean(result.translationSkipped),
  };
  store.history.unshift(item);
  store.history = store.history.slice(0, 120);
  writeStore();
  notifyHistoryChanged();
  return item;
}

function resizeFloatForJob(job) {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  if (floatReadingSize !== 'normal' || floatWindow.isMaximized()) return;
  const compact = job.mode === 'ocr' || Boolean(job.translationSkipped);
  const width = 530;
  let height = 620;
  if (compact) {
    const text = job.ocr?.text || '';
    const explicitLines = Math.max(1, text.split('\n').length);
    const wrappedLines = Math.max(explicitLines, Math.ceil(text.length / 32));
    height = Math.max(340, Math.min(540, 235 + wrappedLines * 22));
  }
  const current = floatWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: current.x + Math.round(current.width / 2), y: current.y + 20 });
  const area = display.workArea;
  const x = Math.max(area.x + 16, Math.min(current.x, area.x + area.width - width - 16));
  const y = Math.max(area.y + 16, Math.min(current.y, area.y + area.height - height - 16));
  floatWindow.setBounds({ x, y, width, height }, true);
}

async function processImage({ dataUrl, mode = 'translate', origin = 'import', imageCopied = false }) {
  if (!dataUrl) throw new Error('没有收到图片。');
  const job = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    mode: mode === 'ocr' ? 'ocr' : 'translate',
    origin,
    imageCopied,
    createdAt: new Date().toISOString(),
    image: dataUrl,
  };
  const startedPayload = { type: 'started', job };
  broadcastJob(startedPayload);
  if (origin === 'capture') createFloat(startedPayload);

  try {
    const ocr = await recognizeWithConfiguredMode(dataUrl, {
      onProgress: ({ stage, progress }) => broadcastJob({ type: 'progress', stage, progress }),
      onLocalPreview: (localOcr) => {
        const previewJob = { ...job, ocr: localOcr, translationSkipped: false, ocrEnhancing: true };
        resizeFloatForJob(previewJob);
        broadcastJob({ type: 'ocr-preview', job: previewJob });
      },
    });
    if (!ocr.text) throw new Error('没有识别到清晰文字，请尝试扩大选区或使用更清晰的图片。');
    const translationSkipped = job.mode === 'translate' && !ocr.languageProfile.hasEnglish;
    const routedJob = { ...job, ocr, translationSkipped };
    resizeFloatForJob(routedJob);
    const ocrPayload = { type: 'ocr-complete', job: routedJob };
    broadcastJob(ocrPayload);
    if (job.mode === 'ocr') {
      if (job.origin === 'capture') {
        const capturedImage = nativeImage.createFromDataURL(job.image);
        clipboard.write({ text: ocr.text, image: capturedImage });
      } else {
        clipboard.writeText(ocr.text);
      }
      const result = { ...routedJob, translation: null };
      addHistory(result);
      broadcastJob({ type: 'completed', job: result, autoCopied: true });
      return result;
    }

    if (translationSkipped) {
      const result = { ...routedJob, translation: null };
      addHistory(result);
      broadcastJob({ type: 'completed', job: result });
      return result;
    }

    broadcastJob({ type: 'progress', stage: 'translating', progress: 92 });
    const translation = await translate(ocr.text);
    const result = { ...routedJob, translation };
    addHistory(result);
    broadcastJob({ type: 'completed', job: result });
    return result;
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '处理超时，请检查网络后重试。' : error.message;
    broadcastJob({ type: 'failed', job, message });
    throw new Error(message);
  }
}

async function translateManualImage({ dataUrl, targetLanguage }) {
  if (!dataUrl) throw new Error('剪贴板里没有可翻译的图片。');
  const ocr = await recognizeWithConfiguredMode(dataUrl);
  if (!ocr.text) throw new Error('没有识别到清晰文字，请换一张更清晰的图片。');
  const translation = await translate(ocr.text, targetLanguage || store.settings.targetLanguage);
  const result = {
    id: `${Date.now()}-manual-image`,
    mode: 'text',
    origin: 'manual-image',
    createdAt: new Date().toISOString(),
    ocr,
    translation,
    translationSkipped: false,
  };
  addHistory(result);
  return result;
}

function notifyHistoryChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:updated', store.history);
  }
}

function addPromptHistory(job) {
  const analysis = job.analysis || {};
  const item = {
    id: job.id,
    mode: 'prompt',
    createdAt: job.createdAt,
    sourceText: analysis.summary || '视觉拆解结果',
    translation: analysis.prompts?.universalZh || analysis.prompts?.firstFrameZh || analysis.prompts?.keyframeZh || '',
    sourceLanguage: 'visual',
    targetLanguage: 'prompt',
    confidence: 0,
    provider: analysis.provider || store.settings.visionModel || '视觉模型',
    analysisMode: analysis.analysisMode || job.analysisMode || 'daily',
    promptData: analysis,
  };
  store.history = store.history.filter((candidate) => candidate.id !== item.id);
  store.history.unshift(item);
  store.history = store.history.slice(0, 120);
  writeStore();
  notifyHistoryChanged();
  return item;
}

async function processPromptImage({ dataUrl, origin = 'import', imageCopied = false, analysisMode, jobId, targetWindow = null }) {
  if (!dataUrl) throw new Error('没有收到图片。');
  const normalizedMode = normalizeAnalysisMode(analysisMode || store.settings.promptAnalysisMode);
  const requestSequence = ++promptAnalysisSequence;
  const controller = new AbortController();
  const job = {
    id: jobId || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    mode: 'prompt',
    analysisMode: normalizedMode,
    origin,
    imageCopied,
    createdAt: new Date().toISOString(),
    image: dataUrl,
  };
  const startedPayload = { type: 'started', job };
  const target = createPromptWindow(startedPayload, { targetWindow });
  cancelPromptAnalysis(job.id);
  promptAnalysisRuns.set(job.id, { controller, sequence: requestSequence, window: target });

  const isCurrentRun = () => {
    const run = promptAnalysisRuns.get(job.id);
    return Boolean(run && run.sequence === requestSequence && run.window === target && isUsablePromptWindow(target));
  };

  try {
    broadcastPrompt({ type: 'progress', stage: 'vision-analysis', progress: 12, job }, target);
    let visionCompleted = false;
    const visionPromise = requestVisionAnalysis({
      endpoint: store.settings.visionEndpoint,
      apiKey: decryptSecret(store.settings.visionApiKeyEncrypted),
      model: store.settings.visionModel,
      provider: store.settings.visionProvider,
      analysisMode: normalizedMode,
      dataUrl,
      signal: controller.signal,
    }).then((analysis) => {
      visionCompleted = true;
      return analysis;
    });
    const ocrPromise = recognize(dataUrl, ({ stage, progress }) => {
      if (isCurrentRun()) broadcastPrompt({ type: 'progress', stage, progress: Math.min(76, Math.round(progress * 0.72)), job }, target);
    }).then((ocr) => {
      if (!visionCompleted && isCurrentRun()) broadcastPrompt({ type: 'progress', stage: 'waiting-vision', progress: 78, job }, target);
      return ocr;
    }).catch(() => {
      if (!visionCompleted && isCurrentRun()) broadcastPrompt({ type: 'progress', stage: 'waiting-vision', progress: 78, job }, target);
      return null;
    });
    const [analysis, ocr] = await Promise.all([visionPromise, ocrPromise]);
    const ocrLines = String(ocr?.text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 24);
    analysis.visibleText = Array.from(new Set([...(analysis.visibleText || []), ...ocrLines])).slice(0, 30);
    analysis.ocrText = ocr?.text || '';
    analysis.ocrConfidence = Number(ocr?.confidence || 0);
    if (!isCurrentRun()) return null;
    const result = { ...job, analysisMode: normalizedMode, analysis };
    addPromptHistory(result);
    broadcastPrompt({ type: 'completed', job: result }, target);
    promptAnalysisRuns.delete(job.id);
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || !isCurrentRun()) return null;
    const message = error.name === 'TimeoutError' ? '视觉分析超时，请检查模型服务后重试。' : error.message;
    broadcastPrompt({ type: 'failed', job, message }, target);
    promptAnalysisRuns.delete(job.id);
    throw new Error(message);
  }
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    settings: publicSettings(),
    history: store.history,
    shortcuts: { ...store.settings.shortcuts },
    platform: process.platform,
    version: app.getVersion(),
  }));
  ipcMain.handle('assistant:bootstrap', () => ({
    settings: publicSettings(),
    platform: process.platform,
    expanded: assistantExpanded,
    side: store.settings.assistantSide,
    enabled: store.settings.assistantEnabled !== false,
  }));
  ipcMain.handle('assistant:hover', (_event, hovered) => {
    assistantHovered = Boolean(hovered) || assistantExpanded;
    if (!assistantExpanded) {
      // The native window remains stationary. Only its hit region and the
      // renderer's visual tuck change, so a quick real mouse click is retained.
      setAssistantInputRegion({ hovered: assistantHovered });
      if (process.platform === 'darwin') positionAssistant({ hovered: assistantHovered, animate: true });
      if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.setOpacity(assistantHovered ? 1 : 0.42);
      assistantWindow?.webContents.send('assistant:state', {
        expanded: false,
        side: store.settings.assistantSide,
        hovered: assistantHovered,
      });
    }
    return assistantHovered;
  });
  ipcMain.handle('assistant:open', () => {
    if (assistantExpanded) return true;
    writeDiagnostic('assistant-open-request', { expandedBefore: assistantExpanded });
    const expanded = setAssistantExpanded(true);
    writeDiagnostic('assistant-open-complete', { expanded });
    return expanded;
  });
  ipcMain.handle('assistant:toggle', () => {
    writeDiagnostic('assistant-toggle-request', { expandedBefore: assistantExpanded });
    const expanded = setAssistantExpanded(!assistantExpanded);
    writeDiagnostic('assistant-toggle-complete', { expanded });
    return expanded;
  });
  ipcMain.handle('assistant:collapse', () => setAssistantExpanded(false, { focus: false }));
  ipcMain.handle('assistant:show', (_event, payload = {}) => {
    if (payload.side === 'left' || payload.side === 'right') store.settings.assistantSide = payload.side;
    showAssistant();
    return publicSettings();
  });
  ipcMain.handle('assistant:hide', () => {
    hideAssistant();
    return true;
  });
  ipcMain.handle('assistant:drag-start', () => {
    if (!assistantWindow || assistantWindow.isDestroyed() || assistantExpanded) return false;
    assistantWindow.setOpacity(1);
    return true;
  });
  ipcMain.handle('assistant:translate', async (_event, payload = {}) => {
    const text = String(payload.text || '').trim();
    const targetLanguage = ['zh-CN', 'en', 'vi', 'th'].includes(payload.targetLanguage)
      ? payload.targetLanguage
      : 'zh-CN';
    const translation = await translate(text, targetLanguage);
    addHistory({
      id: `${Date.now()}-assistant-text`,
      mode: 'text',
      origin: 'assistant',
      createdAt: new Date().toISOString(),
      ocr: { text, confidence: 100, detectedLanguage: payload.sourceLanguage || 'auto', blocks: [], provider: '手动输入' },
      translation,
    });
    return translation;
  });
  ipcMain.handle('assistant:ocr', async (_event, payload = {}) => {
    if (!payload.dataUrl) throw new Error('剪贴板里没有可识别的图片。');
    const ocr = await recognizeWithConfiguredMode(payload.dataUrl);
    if (!ocr.text) throw new Error('没有识别到清晰文字，请换一张更清晰的图片。');
    return ocr;
  });
  ipcMain.handle('ocr:status', () => ({
    ready: Boolean(paddleOcrInitialization),
    engine: paddleOcrInitialization ? 'PP-OCRv6 small' : 'warming',
    backend: paddleOcrInitialization?.backend || '',
    provider: paddleOcrInitialization?.provider || '',
    webgpuAvailable: false,
  }));
  ipcMain.handle('capture:start', (_event, mode) => startCapture(mode));
  ipcMain.on('overlay:paint', (event, payload = {}) => {
    const trace = capturePerformance.get(Number(payload.sessionId));
    if (!trace || trace.sessionId !== captureSessionId) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !isHealthyOverlay(win) || String(win.luvoelleDisplayId) !== String(payload.displayId)
      || String(payload.displayId) !== trace.activeDisplayId) return;
    const receivedAt = Date.now();
    const paintedAt = Number(payload.paintedAt || Date.now());
    trace.rendererPrepareToPaintMs = Math.max(0, paintedAt - Number(payload.preparedAt || paintedAt));
    trace.shortcutToFirstPaintMs = Math.max(0, receivedAt - trace.shortcutReceivedAt);
    trace.firstPaintMs = Math.max(0, receivedAt - trace.entryStartedAt);
    win.luvoelleFirstPaintMs = trace.firstPaintMs;
    trace.resolveFirstPaint?.(true);
    trace.resolveFirstPaint = null;
  });
  ipcMain.on('overlay:interaction-sample', (event, payload = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !isHealthyOverlay(win)) return;
    const maxFrameMs = Math.max(0, Number(payload.maxFrameMs) || 0);
    const slow = maxFrameMs > 20;
    if (captureInteractionSamples >= 12 && !slow) return;
    captureInteractionSamples += 1;
    writeDiagnostic(slow ? 'capture-interaction-slow' : 'capture-interaction-sample', {
      sessionId: Number(payload.sessionId) || 0,
      mode: String(payload.mode || ''),
      pointerEvents: Math.max(0, Number(payload.pointerEvents) || 0),
      renderedFrames: Math.max(0, Number(payload.renderedFrames) || 0),
      coalescedEvents: Math.max(0, Number(payload.coalescedEvents) || 0),
      maxFrameMs,
      averageFrameMs: Math.max(0, Number(payload.averageFrameMs) || 0),
      targetCount: Math.max(0, Number(payload.targetCount) || 0),
    });
  });
  ipcMain.on('overlay:preview-ready', (event, payload = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !isHealthyOverlay(win) || Number(payload.sessionId) !== captureSessionId) return;
    win.webContents.invalidate();
    const trace = capturePerformance.get(Number(payload.sessionId));
    if (trace && payload.quality === 'lossless') {
      trace.losslessPreviewReadyMs = Math.max(0, Date.now() - trace.entryStartedAt);
      win.luvoelleLosslessPreviewReadyMs = trace.losslessPreviewReadyMs;
    }
    const expectedWidth = Math.round(Number(payload.viewportWidth || 0) * Number(payload.devicePixelRatio || 1));
    const expectedHeight = Math.round(Number(payload.viewportHeight || 0) * Number(payload.devicePixelRatio || 1));
    const geometryMismatch = expectedWidth > 0 && expectedHeight > 0
      && (Number(payload.naturalWidth) !== expectedWidth || Number(payload.naturalHeight) !== expectedHeight);
    if (capturePreviewSamples < 12 || geometryMismatch) {
      capturePreviewSamples += 1;
      writeDiagnostic(geometryMismatch ? 'capture-preview-geometry-mismatch' : 'capture-preview-ready', {
        sessionId: Number(payload.sessionId) || 0,
        format: String(payload.format || ''),
        quality: String(payload.quality || ''),
        naturalWidth: Number(payload.naturalWidth) || 0,
        naturalHeight: Number(payload.naturalHeight) || 0,
        viewportWidth: Number(payload.viewportWidth) || 0,
        viewportHeight: Number(payload.viewportHeight) || 0,
        devicePixelRatio: Number(payload.devicePixelRatio) || 1,
        expectedWidth,
        expectedHeight,
        geometryMismatch,
      });
    }
  });
  ipcMain.on('overlay:standby-ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !isHealthyOverlay(win)) return;
    win.luvoelleResolveStandbyReady?.();
  });
  ipcMain.handle('shortcuts:recording-start', () => {
    if (captureActive) throw new Error('请先退出当前截图，再修改快捷键。');
    clearTimeout(shortcutRecordingTimer);
    shortcutRecording = true;
    globalShortcut.unregisterAll();
    shortcutRecordingTimer = setTimeout(() => {
      if (shortcutRecording) registerShortcuts(store.settings.shortcuts);
    }, 30_000);
    return true;
  });
  ipcMain.handle('shortcuts:recording-end', () => {
    if (!shortcutRecording) return { shortcuts: { ...store.settings.shortcuts }, status: { ...shortcutRegistration } };
    return registerShortcuts(store.settings.shortcuts);
  });
  ipcMain.on('capture:cancel', () => {
    cancelCapture();
  });
  ipcMain.handle('capture:submit', async (_event, payload) => {
    // The frozen frame must win over a live recapture. A live recapture happens
    // after the overlay has taken focus, when transient Shell UI is already gone.
    const losslessCapture = losslessCapturedRegion(payload) || await nativeCapturedRegion(payload);
    if (!losslessCapture && !payload.dataUrl) {
      return { ok: false, needsRendererFallback: true, message: '冻结帧裁切暂不可用' };
    }
    const captureDataUrl = losslessCapture?.dataUrl || payload.dataUrl;
    const capturedImage = losslessCapture?.image || nativeImage.createFromDataURL(captureDataUrl);
    // Detach instead of mutating the session-local frame map. The active
    // display can be submitted while secondary displays are still freezing.
    captureSourceFrames = new Map();
    const imageCopied = await writeCapturedImageToClipboard(capturedImage);
    const mode = payload.mode || activeMode;
    if (mode === 'edit' && payload.inline) {
      captureRestoreWindows.forEach((win) => {
        if (pinnedImageWindows.has(win) && !win.isDestroyed()) win.showInactive();
      });
      return { ok: true, mode: 'edit', inline: true, imageCopied, dataUrl: captureDataUrl, lossless: Boolean(losslessCapture), captureBackend: losslessCapture?.backend || 'renderer-fallback' };
    }
    const previouslyVisibleWindows = captureRestoreWindows.slice();
    const fixedPromptWindowsToRestore = captureRestoreWindows.filter((win) => (
      isUsablePromptWindow(win) && promptWindows.has(win) && win.isAlwaysOnTop()
    ));
    const restoreAssistant = captureRestoreWindows.includes(assistantWindow) && assistantWindow && !assistantWindow.isDestroyed();
    cancelCapture({ restoreWindows: false });
    let operation;
    if (mode === 'edit') {
      createImageEditor(captureDataUrl);
      previouslyVisibleWindows.forEach((win) => {
        if (win && !win.isDestroyed()) win.showInactive();
      });
      operation = Promise.resolve({ ok: true, mode: 'edit', imageCopied });
    } else {
      operation = mode === 'prompt'
        ? processPromptImage({ dataUrl: captureDataUrl, origin: 'capture', imageCopied })
        : processImage({ dataUrl: captureDataUrl, mode, origin: 'capture', imageCopied });
      fixedPromptWindowsToRestore.forEach((win) => {
        if (isUsablePromptWindow(win)) win.showInactive();
      });
      if (restoreAssistant) assistantWindow.showInactive();
    }
    operation.catch(() => {});
    return { ok: true, imageCopied, lossless: Boolean(losslessCapture) };
  });
  ipcMain.handle('image:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要识别的图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const mime = extension === 'jpg' ? 'jpeg' : extension;
    return `data:image/${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  });
  ipcMain.handle('image:process', (_event, payload) => (
    payload?.mode === 'prompt'
      ? processPromptImage({ ...payload, origin: 'import' })
      : processImage({ ...payload, origin: 'import' })
  ));
  ipcMain.handle('translate:image', (_event, payload = {}) => translateManualImage(payload));
  ipcMain.handle('translate:text', async (_event, payload) => {
    const translation = await translate(payload.text, payload.targetLanguage || store.settings.targetLanguage);
    const ocr = { text: payload.text.trim(), confidence: 100, detectedLanguage: 'auto', blocks: [] };
    const result = {
      id: `${Date.now()}-text`,
      mode: 'text',
      origin: 'text',
      createdAt: new Date().toISOString(),
      ocr,
      translation,
    };
    addHistory(result);
    broadcastJob({ type: 'completed', job: result });
    return result;
  });
  ipcMain.handle('translation:retry', async (_event, payload) => {
    const text = String(payload?.ocr?.text || '').trim();
    if (!text) throw new Error('没有可重试翻译的原文。');
    const translation = await translate(text, payload.translation?.targetLanguage || store.settings.targetLanguage);
    const result = {
      id: payload.id,
      mode: 'translate',
      origin: payload.origin || 'capture',
      imageCopied: Boolean(payload.imageCopied),
      createdAt: payload.createdAt || new Date().toISOString(),
      image: payload.image || '',
      ocr: payload.ocr,
      translation,
      translationSkipped: false,
    };
    const existing = store.history.find((item) => item.id === result.id);
    if (existing) {
      existing.translation = translation.text;
      existing.targetLanguage = translation.targetLanguage;
      existing.provider = translation.provider;
      writeStore();
    } else addHistory(result);
    broadcastJob({ type: 'completed', job: result, retried: true });
    return result;
  });
  ipcMain.handle('result:apply-correction', async (_event, payload) => {
    const text = String(payload.text || '').trim();
    if (!text) throw new Error('修正后的原文不能为空。');
    const existing = store.history.find((item) => item.id === payload.id);
    const mode = payload.mode === 'ocr' ? 'ocr' : 'translate';
    const languageProfile = analyzeTextLanguage(text);
    const translationSkipped = mode === 'translate' && !languageProfile.hasEnglish;
    broadcastJob({ type: 'correction-started', jobId: payload.id, mode, translationSkipped });

    const ocr = {
      text,
      confidence: Number(payload.confidence || existing?.confidence || 0),
      detectedLanguage: languageProfile.chineseCharacters > 0 ? 'zh-CN' : 'en',
      languageProfile,
      blocks: [],
      provider: String(payload.ocrProvider || existing?.ocrProvider || 'PP-OCRv6 small 本地 OCR'),
      enhanced: Boolean(payload.ocrEnhanced || existing?.ocrEnhanced),
      corrected: true,
    };
    const translation = mode === 'ocr' || translationSkipped ? null : await translate(text, payload.targetLanguage || store.settings.targetLanguage);
    const result = {
      id: payload.id,
      mode,
      origin: payload.origin || 'capture',
      createdAt: payload.createdAt || existing?.createdAt || new Date().toISOString(),
      ocr,
      translation,
      translationSkipped,
    };
    resizeFloatForJob(result);

    if (existing) {
      existing.sourceText = text;
      existing.translation = translation?.text || '';
      existing.sourceLanguage = ocr.detectedLanguage;
      existing.targetLanguage = translation?.targetLanguage || '';
      existing.provider = translation?.provider || `${ocr.provider} · 已校正`;
      existing.ocrProvider = ocr.provider;
      existing.ocrEnhanced = Boolean(ocr.enhanced);
      existing.corrected = true;
      existing.translationSkipped = translationSkipped;
      writeStore();
    } else {
      addHistory(result);
    }
    if (mode === 'ocr') clipboard.writeText(text);
    broadcastJob({ type: 'corrected', job: result, autoCopied: mode === 'ocr' });
    return result;
  });
  ipcMain.handle('settings:save', (_event, nextSettings) => {
    const assistantVisibilityChanged = Object.prototype.hasOwnProperty.call(nextSettings, 'assistantEnabled')
      && Boolean(nextSettings.assistantEnabled) !== (store.settings.assistantEnabled !== false);
    const assistantSideChanged = Object.prototype.hasOwnProperty.call(nextSettings, 'assistantSide')
      && nextSettings.assistantSide !== store.settings.assistantSide;
    if (Object.prototype.hasOwnProperty.call(nextSettings, 'shortcuts')) {
      const previousShortcuts = { ...store.settings.shortcuts };
      const nextShortcuts = normalizeShortcutMap(nextSettings.shortcuts || {}, previousShortcuts);
      const changed = SHORTCUT_DEFINITIONS.some(({ id }) => nextShortcuts[id] !== previousShortcuts[id]);
      if (changed) {
        if (captureActive) throw new Error('请先退出当前截图，再保存快捷键。');
        const registration = registerShortcuts(nextShortcuts);
        const failed = SHORTCUT_DEFINITIONS.filter(({ id }) => !registration.status[id]?.registered);
        if (failed.length) {
          registerShortcuts(previousShortcuts);
          const details = failed.map(({ id, label }) => `${label}（${nextShortcuts[id]}）`).join('、');
          throw new Error(`${details} 已被系统或其他程序占用，请换一个按键。`);
        }
      }
      store.settings.shortcuts = nextShortcuts;
    }
    const allowed = [
      'provider',
      'sourceLanguage',
      'targetLanguage',
      'endpoint',
      'model',
      'ocrMode',
      'ocrConfidenceThreshold',
      'visionProvider',
      'visionEndpoint',
      'visionModel',
      'promptAnalysisMode',
      'generationEndpoint',
      'generationModel',
      'assistantEnabled',
      'assistantSide',
      'assistantDisplayId',
      'assistantYRatio',
      'keepScreenshots',
      'launchAtLogin',
    ];
    allowed.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(nextSettings, key)) return;
      store.settings[key] = key === 'promptAnalysisMode'
        ? normalizeAnalysisMode(nextSettings[key])
        : nextSettings[key];
    });
    if (typeof nextSettings.apiKey === 'string' && nextSettings.apiKey.trim()) {
      const keyField = nextSettings.provider === 'deepseek' ? 'deepseekApiKeyEncrypted' : 'apiKeyEncrypted';
      store.settings[keyField] = encryptSecret(nextSettings.apiKey.trim());
    }
    if (typeof nextSettings.visionApiKey === 'string' && nextSettings.visionApiKey.trim()) {
      store.settings.visionApiKeyEncrypted = encryptSecret(nextSettings.visionApiKey.trim());
    }
    if (nextSettings.reuseVisionApiKey && store.settings.visionApiKeyEncrypted) {
      store.settings.apiKeyEncrypted = store.settings.visionApiKeyEncrypted;
    }
    if (typeof nextSettings.generationApiKey === 'string' && nextSettings.generationApiKey.trim()) {
      store.settings.generationApiKeyEncrypted = encryptSecret(nextSettings.generationApiKey.trim());
    }
    if (nextSettings.clearApiKey) {
      const keyField = nextSettings.provider === 'deepseek' ? 'deepseekApiKeyEncrypted' : 'apiKeyEncrypted';
      delete store.settings[keyField];
    }
    if (nextSettings.clearVisionApiKey) delete store.settings.visionApiKeyEncrypted;
    if (nextSettings.clearGenerationApiKey) delete store.settings.generationApiKeyEncrypted;
    syncLoginItemSettings(store.settings.launchAtLogin);
    writeStore();
    if (assistantVisibilityChanged || assistantSideChanged) {
      if (store.settings.assistantEnabled === false) hideAssistant();
      else showAssistant();
    }
    return publicSettings();
  });
  ipcMain.handle('vision:check', async (_event, payload = {}) => checkVisionService({
    endpoint: payload.endpoint || store.settings.visionEndpoint,
    apiKey: String(payload.apiKey || '').trim() || decryptSecret(store.settings.visionApiKeyEncrypted),
  }));
  ipcMain.handle('prompt:open-history', (_event, id) => {
    const item = store.history.find((candidate) => candidate.id === id && candidate.mode === 'prompt');
    if (!item) throw new Error('没有找到这条视觉拆解记录。');
    const analysisMode = normalizeAnalysisMode(item.analysisMode || item.promptData?.analysisMode || 'ecommerce');
    const storedAnalysis = item.promptData || {};
    const analysis = normalizeAnalysis(storedAnalysis, {
      analysisMode,
      provider: storedAnalysis.provider,
      latency: storedAnalysis.latency,
      local: storedAnalysis.local,
    });
    const job = {
      id: item.id,
      mode: 'prompt',
      origin: 'history',
      createdAt: item.createdAt,
      image: '',
      historyOnly: true,
      analysisMode,
      analysis,
    };
    const target = createPromptWindow({ type: 'started', job });
    broadcastPrompt({ type: 'completed', job }, target);
    return true;
  });
  ipcMain.handle('prompt:reanalyze', (event, payload = {}) => {
    if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(payload.dataUrl || '')) {
      throw new Error('当前记录没有原图，无法切换模式重新拆解。');
    }
    const analysisMode = normalizeAnalysisMode(payload.analysisMode);
    store.settings.promptAnalysisMode = analysisMode;
    writeStore();
    return processPromptImage({
      dataUrl: payload.dataUrl,
      origin: payload.origin || 'mode-switch',
      imageCopied: Boolean(payload.imageCopied),
      analysisMode,
      jobId: payload.jobId,
      targetWindow: BrowserWindow.fromWebContents(event.sender),
    });
  });
  ipcMain.handle('prompt:cancel-analysis', (event, jobId) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const run = promptAnalysisRuns.get(jobId);
    if (run && run.window === senderWindow) cancelPromptAnalysis(jobId);
    return true;
  });
  ipcMain.handle('prompt:generate', async (event, payload = {}) => {
    const strategy = ['style', 'composition', 'subject', 'product', 'character', 'shot', 'continuity'].includes(payload.strategy) ? payload.strategy : 'style';
    const generationKind = payload.generationKind === 'ecommerce-grid' ? 'ecommerce-grid' : 'reference';
    if ((['product', 'character'].includes(strategy) || generationKind === 'ecommerce-grid') && !payload.rightsConfirmed) {
      const message = strategy === 'character'
        ? '“保持角色”会尽量保留人物身份与服装，请先确认你拥有图片和人物肖像素材的使用权。'
        : '“保持商品”会尽量保留商品外观与标识，请先确认你拥有图片和商品素材的使用权。';
      throw new Error(message);
    }
    const eventPrefix = generationKind === 'ecommerce-grid' ? 'grid-generation' : 'generation';
    event.sender.send('prompt:event', { type: `${eventPrefix}-progress`, jobId: payload.jobId, stage: generationKind === 'ecommerce-grid' ? 'grid-generating' : 'generating', progress: 24 });
    try {
      const result = await requestReferenceGeneration({
        endpoint: store.settings.generationEndpoint,
        apiKey: decryptSecret(store.settings.generationApiKeyEncrypted),
        model: store.settings.generationModel,
        dataUrl: payload.dataUrl,
        prompt: payload.prompt,
        analysis: payload.analysis,
        strategy,
        generationKind,
        gridOptions: payload.gridOptions || {},
        size: generationKind === 'ecommerce-grid' ? '1024x1024' : (payload.size || '1024x1024'),
      });
      event.sender.send('prompt:event', { type: `${eventPrefix}-completed`, jobId: payload.jobId, result });
      return result;
    } catch (error) {
      const message = error.name === 'TimeoutError'
        ? `${generationKind === 'ecommerce-grid' ? '九宫格' : '参考图'}生成超时，请检查图像生成服务后重试。`
        : error.message;
      event.sender.send('prompt:event', { type: `${eventPrefix}-failed`, jobId: payload.jobId, message });
      throw new Error(message);
    }
  });
  ipcMain.handle('prompt:save-image', async (event, payload) => {
    const dataUrl = typeof payload === 'string' ? payload : payload?.dataUrl;
    const kind = typeof payload === 'object' ? payload?.kind : 'reference';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const mime = /^data:image\/(jpeg|webp);/i.exec(dataUrl || '')?.[1]?.toLowerCase() || 'png';
    const extension = mime === 'jpeg' ? 'jpg' : mime;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(isUsablePromptWindow(owner) ? owner : (promptWindow || mainWindow), {
      title: kind === 'ecommerce-grid' ? '保存电商九宫格' : '保存参考生成图片',
      defaultPath: path.join(app.getPath('pictures'), `Luvoelle-${kind === 'ecommerce-grid' ? 'Ecommerce-Grid' : 'Generated'}-${stamp}.${extension}`),
      filters: [{ name: `${extension.toUpperCase()} 图片`, extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.writeFileSync(result.filePath, dataUrlToBuffer(dataUrl));
    return { saved: true, filePath: result.filePath };
  });
  ipcMain.handle('prompt:action', (event, action) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const win = isUsablePromptWindow(senderWindow) && promptWindows.has(senderWindow) ? senderWindow : promptWindow;
    if (action === 'close' && isUsablePromptWindow(win)) {
      win.setAlwaysOnTop(false);
      if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(false);
      if (win.luvoellePromptReady) win.webContents.send('window:state', { maximized: win.isMaximized(), pinned: false });
      releasePromptWindowJob(win);
      if (win === promptWindow) win.hide();
      else win.destroy();
    }
    if (action === 'pin' && isUsablePromptWindow(win)) {
      const next = !win.isAlwaysOnTop();
      // Frameless Mica windows on Windows can report `floating` as changed
      // without actually remaining topmost. `pop-up-menu` is the first
      // documented Windows level that reliably stays above regular windows.
      win.setAlwaysOnTop(next, next ? 'pop-up-menu' : 'normal');
      if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(next, { visibleOnFullScreen: next });
      const pinned = win.isAlwaysOnTop();
      if (win.luvoellePromptReady) win.webContents.send('window:state', { maximized: win.isMaximized(), pinned });
      return pinned;
    }
    if (action === 'open-main') showMain();
    return true;
  });
  ipcMain.handle('history:delete', (_event, id) => {
    store.history = store.history.filter((item) => item.id !== id);
    writeStore();
    notifyHistoryChanged();
    return store.history;
  });
  ipcMain.handle('history:clear', () => {
    store.history = [];
    writeStore();
    notifyHistoryChanged();
    return [];
  });
  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(text || '');
    return true;
  });
  ipcMain.handle('clipboard:image', () => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : image.toDataURL();
  });
  ipcMain.handle('window:open-main', () => {
    showMain();
    return true;
  });
  ipcMain.handle('window:control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'close') win.hide();
    return { maximized: win.isMaximized(), pinned: win.isAlwaysOnTop() };
  });
  ipcMain.handle('float:action', (_event, action) => {
    if (action === 'close' && floatWindow && !floatWindow.isDestroyed()) {
      if (floatWindow.isMaximized()) floatWindow.unmaximize();
      floatReadingSize = 'normal';
      floatModerateBounds = null;
      floatWindow.hide();
    }
    if (action === 'resize') return toggleFloatReadingSize();
    if (action === 'pin' && floatWindow && !floatWindow.isDestroyed()) {
      const next = !floatWindow.isAlwaysOnTop();
      floatWindow.setAlwaysOnTop(next, next ? 'floating' : 'normal');
      if (process.platform === 'darwin') floatWindow.setVisibleOnAllWorkspaces(next, { visibleOnFullScreen: next });
      return next;
    }
    if (action === 'open-main') showMain();
    return true;
  });
  ipcMain.handle('editor:open', (_event, payload) => {
    createImageEditor(payload?.dataUrl);
    return true;
  });
  ipcMain.handle('editor:copy', async (_event, dataUrl) => {
    const image = nativeImage.createFromDataURL(dataUrl || '');
    return writeCapturedImageToClipboard(image);
  });
  ipcMain.handle('editor:save', async (event, dataUrl) => {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const ownerWindow = editorWindow && !editorWindow.isDestroyed() ? editorWindow : BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(ownerWindow, {
      title: '保存编辑后的截图',
      defaultPath: path.join(app.getPath('pictures'), `Luvoelle-${stamp}.png`),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.writeFileSync(result.filePath, dataUrlToBuffer(dataUrl));
    return { saved: true, filePath: result.filePath };
  });
  ipcMain.handle('editor:close', () => {
    if (editorWindow && !editorWindow.isDestroyed()) editorWindow.close();
    return true;
  });
  ipcMain.handle('pin:create', (event, payload) => createPinnedImageWindow(event.sender, payload));
  ipcMain.handle('pin:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !pinnedImageWindows.has(win)) return false;
    win.destroy();
    return true;
  });
}

app.on('render-process-gone', (_event, webContents, details) => {
  if (details?.reason === 'clean-exit') return;
  let page = '';
  try { page = path.basename(new URL(webContents.getURL()).pathname); } catch { /* URL may be unavailable after a crash */ }
  writeDiagnostic('render-process-gone', {
    page,
    reason: details?.reason || 'unknown',
    exitCode: Number(details?.exitCode || 0),
  });
  const crashedMain = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === webContents
    ? mainWindow
    : null;
  if (crashedMain) {
    const shouldReveal = initialWorkbenchPending || crashedMain.isVisible();
    mainWindow = null;
    crashedMain.destroy();
    if (!appIsQuitting) {
      setTimeout(() => {
        if (appIsQuitting || mainWindow) return;
        const recovered = createMainWindow({ deferShow: true });
        recovered.luvoelleReadyPromise.then(() => {
          writeDiagnostic('main-window-recovered', { revealed: shouldReveal });
          if (shouldReveal) showMain();
        }).catch((error) => writeDiagnostic('main-window-recovery-failed', {
          name: error?.name || 'Error',
          message: error?.message || String(error),
        }));
      }, 120);
    }
    return;
  }
  const crashedAssistant = assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.webContents === webContents
    ? assistantWindow
    : null;
  if (crashedAssistant) {
    assistantWindow = null;
    assistantReady = false;
    crashedAssistant.destroy();
    if (!appIsQuitting && store.settings.assistantEnabled !== false) {
      setTimeout(() => {
        if (!appIsQuitting && (!assistantWindow || assistantWindow.isDestroyed())) {
          createAssistantWindow();
          writeDiagnostic('assistant-window-recovered');
        }
      }, 240);
    }
    return;
  }
  const crashedOverlay = overlayWindows.find((overlay) => !overlay.isDestroyed() && overlay.webContents === webContents);
  if (crashedOverlay) {
    crashedOverlay.luvoelleCrashed = true;
    if (captureActive) cancelCapture();
    if (!crashedOverlay.isDestroyed()) crashedOverlay.destroy();
    if (!appIsQuitting) {
      setImmediate(() => {
        if (!appIsQuitting && app.isReady()) ensureOverlayWindows().catch((error) => writeDiagnostic('overlay-recovery-failed', {
          name: error?.name || 'Error',
          message: error?.message || String(error),
        }));
      });
    }
  }
});

app.on('child-process-gone', (_event, details) => {
  if (details?.reason === 'clean-exit') return;
  writeDiagnostic('child-process-gone', {
    processType: details?.type || 'unknown',
    reason: details?.reason || 'unknown',
    exitCode: Number(details?.exitCode || 0),
    serviceName: details?.serviceName || '',
  });
  if (details?.type === 'GPU' && !appIsQuitting) {
    setTimeout(() => refreshResidentOverlays('gpu-process-restarted', { force: true }), 1500).unref?.();
  }
});

function startOptionalWarmups() {
  if (startupWarmupsStarted || appIsQuitting) return;
  startupWarmupsStarted = true;
  writeDiagnostic('startup-warmups-begin', { legacyWindowsCompatibility });
  setImmediate(() => {
    if (!legacyWindowsCompatibility) {
      try { warmWindowTargetDetection(); } catch (error) {
        writeDiagnostic('startup-window-target-warmup-failed', { message: error?.message || String(error) });
      }
      try { warmNativeScreenCapture(); } catch (error) {
        writeDiagnostic('startup-native-capture-warmup-failed', { message: error?.message || String(error) });
      }
    }
    try { warmUiAutomationTargetDetection(); } catch (error) {
      writeDiagnostic('startup-uia-warmup-failed', { message: error?.message || String(error) });
    }
  });
  const overlayWarmupPromise = ensureOverlayWindows().catch((error) => {
    writeDiagnostic('startup-overlay-warmup-failed', { message: error?.message || String(error) });
  });
  // On macOS a desktopCapturer call can display the system consent prompt.
  // Never ask during background startup; the first user-initiated screenshot
  // performs the permission probe instead.
  captureWarmupPromise = process.env.LUVOELLE_TEST_WARMUP_HANG === '1'
    ? new Promise(() => {})
    : process.platform === 'darwin'
    ? Promise.resolve()
    : desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then(() => undefined)
      .catch((error) => writeDiagnostic('startup-screen-capture-warmup-failed', { message: error?.message || String(error) }));
  if (!legacyWindowsCompatibility) {
    // Native OCR is optional and isolated; it must never gate the first window.
    createPaddleOcrWorker().catch((error) => writeDiagnostic('startup-ocr-warmup-failed', { message: error?.message || String(error) }));
  }
  Promise.allSettled([overlayWarmupPromise, captureWarmupPromise]).then(() => {
    writeDiagnostic('startup-warmups-settled');
  });
  if (!overlayRefreshTimer) {
    overlayRefreshTimer = setInterval(() => refreshResidentOverlays('scheduled'), 60 * 60 * 1000);
    overlayRefreshTimer.unref?.();
  }
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  writeDiagnostic('startup-electron-ready');
  migrateLegacyStore();
  readStore();
  syncLoginItemSettings(store.settings.launchAtLogin);
  registerIpc();
  createApplicationMenu();
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(createAppIcon());
  const initialMainWindow = createMainWindow({ deferShow: true });
  createTray();
  registerShortcuts();
  initialMainWindow.luvoelleReadyPromise.then(() => {
    // The workbench is independent of screenshot, OCR and GPU warmups. This is
    // essential on older LTSC systems where those optional paths can be slow.
    if (!startedInBackground && mainWindow === initialMainWindow && !initialMainWindow.isDestroyed()) showMain();
    writeDiagnostic('startup-workbench-state', { visible: !startedInBackground });
  }).catch((error) => writeDiagnostic('startup-workbench-failed', { message: error?.message || String(error) }));
  setTimeout(() => {
    if (appIsQuitting) return;
    try { createAssistantWindow(); } catch (error) {
      writeDiagnostic('startup-assistant-failed', { message: error?.message || String(error) });
    }
    startOptionalWarmups();
  }, legacyWindowsCompatibility ? 900 : 120);
  setTimeout(() => {
    if (!startedInBackground && initialWorkbenchPending && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      initialWorkbenchPending = false;
      writeDiagnostic('startup-workbench-timeout-reveal');
    }
  }, 2500);
  writeDiagnostic('startup-core-complete', {
    tray: Boolean(tray && !tray.isDestroyed()),
    shortcuts: Object.values(shortcutRegistration).filter((item) => item.registered).length,
  });
  const handleDisplaysChanged = () => {
    ensureOverlayWindows().catch(() => {});
    positionAssistant();
  };
  screen.on('display-added', handleDisplaysChanged);
  screen.on('display-removed', handleDisplaysChanged);
  screen.on('display-metrics-changed', handleDisplaysChanged);
  powerMonitor.on('resume', () => {
    setTimeout(() => refreshResidentOverlays('system-resume', { force: true }), 1200).unref?.();
  });
  app.on('activate', () => showMain());
}).catch((error) => {
  writeDiagnostic('startup-failed', {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: String(error?.stack || '').slice(0, 4000),
  });
});

app.on('window-all-closed', () => {
  // Luvoelle is tray-first; it keeps listening for global shortcuts.
});

app.on('before-quit', () => {
  appIsQuitting = true;
  clearInterval(overlayRefreshTimer);
  overlayRefreshTimer = null;
});

app.on('will-quit', async () => {
  uninstallWindowsMouseHook();
  globalShortcut.unregisterAll();
  shutdownUiAutomationTargetDetection();
  if (paddleOcrWorker) {
    const worker = paddleOcrWorker;
    resetPaddleOcrWorker(worker, new Error('应用正在退出。'));
  }
  if (workerPromise) {
    try { (await workerPromise).terminate(); } catch { /* ignore shutdown cleanup errors */ }
  }
});
