const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

if (process.platform !== 'win32') {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: 'Windows-only global shortcut latency test' })}\n`);
  process.exit(0);
}

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const keybdEvent = user32.func('void __stdcall keybd_event(uint8_t virtualKey, uint8_t scanCode, uint32_t flags, uintptr_t extraInfo)');
const VK_ALT = 0x12;
const VK_A = 0x41;
const KEY_UP = 0x0002;

function sendAltA() {
  keybdEvent(VK_ALT, 0, 0, 0);
  keybdEvent(VK_A, 0, 0, 0);
  keybdEvent(VK_A, 0, KEY_UP, 0);
  keybdEvent(VK_ALT, 0, KEY_UP, 0);
}

async function waitForWindowByFile(electronApp, fileName, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const match = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

async function activeOverlayState(electronApp) {
  try {
    return await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/overlay.html')
        && candidate.luvoelleCaptureActive && candidate.luvoellePrimaryCapture);
      return win ? {
        sessionId: win.luvoelleCaptureSessionId,
        entryMs: win.luvoelleEntryLatencyMs,
        firstPaintMs: win.luvoelleFirstPaintMs,
        losslessPreviewReadyMs: win.luvoelleLosslessPreviewReadyMs,
        wakePath: win.luvoelleOverlayWakePath,
      } : null;
    });
  } catch (error) {
    if (String(error?.message || error).includes('garbage collected')) return null;
    throw error;
  }
}

async function waitForShortcutCapture(electronApp, previousSession, timeout = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = await activeOverlayState(electronApp);
    if (state?.sessionId > previousSession && Number.isFinite(state.firstPaintMs)) {
      return { ...state, observedMs: Date.now() - startedAt };
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error('The real Alt+A global shortcut did not reach its first interactive paint');
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const executablePath = String(process.env.LUVOELLE_PACKAGED_PATH || '').trim();
  const packaged = Boolean(executablePath);
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `capture-global-shortcut-profile-${Date.now()}`);
  const idleMs = Math.max(0, Number(process.env.LUVOELLE_CAPTURE_IDLE_MS) || 15000);
  fs.mkdirSync(profile, { recursive: true });
  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: [...(packaged ? [] : ['.']), '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile },
  });

  try {
    const page = await waitForWindowByFile(electronApp, 'index.html');
    const overlay = await waitForWindowByFile(electronApp, 'overlay.html');
    await page.waitForSelector('.action-card[data-capture="edit"]');
    await overlay.waitForFunction(() => document.body.classList.contains('is-standby'));
    const registered = await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+A'));
    assert.equal(registered, true, 'Alt+A is owned by another running application; close the installed Luvoelle before this test');

    await new Promise((resolve) => setTimeout(resolve, idleMs));
    const samples = [];
    let previousSession = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pressedAt = Date.now();
      sendAltA();
      const sample = await waitForShortcutCapture(electronApp, previousSession);
      sample.observedMs = Date.now() - pressedAt;
      await overlay.waitForFunction((sessionId) => config?.sessionId === sessionId
        && document.body.dataset.previewFormat === 'bmp'
        && document.body.dataset.previewQuality === 'lossless'
        && Boolean(document.body.dataset.previewReadyAt), sample.sessionId, { timeout: 2500 });
      sample.losslessObservedMs = Date.now() - pressedAt;
      previousSession = sample.sessionId;
      samples.push(sample);
      await overlay.keyboard.press('Escape');
      await overlay.waitForFunction(() => document.body.classList.contains('is-standby'));
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    const result = {
      idleMs,
      attempts: samples.length,
      observedMs: samples.map((sample) => sample.observedMs),
      entryMs: samples.map((sample) => sample.entryMs),
      firstPaintMs: samples.map((sample) => sample.firstPaintMs),
      losslessObservedMs: samples.map((sample) => sample.losslessObservedMs),
      wakePaths: [...new Set(samples.map((sample) => sample.wakePath))],
      packaged,
    };
    assert.ok(Math.max(...result.observedMs) < 350, `Real Alt+A observation exceeded 350ms: ${result.observedMs.join(', ')}`);
    assert.ok(Math.max(...result.entryMs) < 120, `Real Alt+A internal entry exceeded 120ms: ${result.entryMs.join(', ')}`);
    assert.ok(Math.max(...result.losslessObservedMs) < 500, `Real Alt+A lossless preview exceeded 500ms: ${result.losslessObservedMs.join(', ')}`);
    assert.deepEqual(result.wakePaths, ['resident-sync']);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
