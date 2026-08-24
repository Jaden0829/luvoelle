const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

async function waitForWindowByFile(electronApp, fileName, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const match = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

async function overlayState(electronApp) {
  try {
    return await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/overlay.html')
        && candidate.luvoelleCaptureActive && candidate.luvoellePrimaryCapture);
      return win ? {
        opacity: win.getOpacity(),
        sessionId: win.luvoelleCaptureSessionId,
        entryMs: win.luvoelleEntryLatencyMs,
        firstPaintMs: win.luvoelleFirstPaintMs,
        captureMs: win.luvoellePrefreezeLatencyMs,
        previewEncodingMs: win.luvoellePreviewEncodingMs,
        losslessPreviewEncodingMs: win.luvoelleLosslessPreviewEncodingMs,
        losslessPreviewPreparationMs: win.luvoelleLosslessPreviewPreparationMs,
        losslessPreviewReadyMs: win.luvoelleLosslessPreviewReadyMs,
        wakePath: win.luvoelleOverlayWakePath,
      } : null;
    });
  } catch (error) {
    if (String(error?.message || error).includes('garbage collected')) return null;
    throw error;
  }
}

async function waitForActiveSession(electronApp, previousSession, timeout = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = await overlayState(electronApp);
    if (state?.sessionId > previousSession && Number.isFinite(state.firstPaintMs)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Alt+A overlay did not reach its first interactive paint');
}

async function waitForStandby(overlay, timeout = 3000) {
  await overlay.waitForFunction(() => document.body.classList.contains('is-standby'), null, { timeout });
}

async function waitForLosslessPreview(electronApp, overlay, sessionId, timeout = 2500) {
  await overlay.waitForFunction((expectedSessionId) => config?.sessionId === expectedSessionId
    && document.body.dataset.previewFormat === 'bmp'
    && document.body.dataset.previewQuality === 'lossless'
    && Boolean(document.body.dataset.previewReadyAt), sessionId, { timeout });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = await overlayState(electronApp);
    if (state?.sessionId === sessionId && Number.isFinite(state.losslessPreviewReadyMs)) return state;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  throw new Error('Lossless preview renderer paint was not acknowledged by the main process');
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  assert.match(mainSource, /process\.platform === 'darwin' && !await ensureMacCapturePermission\(\)/, 'Windows capture still crosses the macOS permission Promise barrier');
  assert.match(mainSource, /residentWindows \|\| await ensureOverlayWindows\(displays\)/, 'Fast capture does not use the synchronous resident-overlay path');
  assert.match(mainSource, /previewFormat = captureVariant === 'fast' \? 'bmp' : 'png'[\s\S]+frameLosslessBmp/, 'Alt+A is missing its direct lossless bitmap preview');
  assert.doesNotMatch(mainSource, /overlay:preview-upgrade/, 'Alt+A still performs a second full-screen preview replacement');
  const packaged = process.argv.includes('--packaged');
  const executablePath = packaged ? (process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe')) : '';
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `capture-stress-profile-${Date.now()}`);
  const idleMs = Math.max(0, Number(process.env.LUVOELLE_CAPTURE_IDLE_MS) || 5000);
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
    await waitForStandby(overlay);
    // Exercise the idle wake path as well as rapid repeated use.
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    const samples = [];
    let previousSession = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.evaluate(() => { window.luvoelle.startCapture('edit'); });
      const firstPaintState = await waitForActiveSession(electronApp, previousSession);
      previousSession = firstPaintState.sessionId;
      samples.push(await waitForLosslessPreview(electronApp, overlay, firstPaintState.sessionId));
      await overlay.keyboard.press('Escape');
      await waitForStandby(overlay);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const firstPaint = samples.map((sample) => sample.firstPaintMs).sort((a, b) => a - b);
    const entry = samples.map((sample) => sample.entryMs).sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(samples.length * 0.95) - 1);
    const result = {
      attempts: samples.length,
      idleMs,
      entry: { max: Math.max(...entry), p95: entry[p95Index] },
      firstPaint: { max: Math.max(...firstPaint), p95: firstPaint[p95Index] },
      capture: { max: Math.max(...samples.map((sample) => sample.captureMs || 0)) },
      previewEncoding: { max: Math.max(...samples.map((sample) => sample.previewEncodingMs || 0)) },
      losslessPreviewEncoding: { max: Math.max(...samples.map((sample) => sample.losslessPreviewEncodingMs || 0)) },
      losslessPreviewPreparation: { max: Math.max(...samples.map((sample) => sample.losslessPreviewPreparationMs || 0)) },
      losslessPreviewReady: { max: Math.max(...samples.map((sample) => sample.losslessPreviewReadyMs || 0)) },
      wakePaths: [...new Set(samples.map((sample) => sample.wakePath))],
      compositorResidentStandby: true,
      packaged,
    };
    assert.ok(result.entry.max < 120, `Alt+A main entry long tail is ${result.entry.max}ms`);
    assert.ok(result.firstPaint.max < 160, `Alt+A first-paint long tail is ${result.firstPaint.max}ms`);
    assert.deepEqual(result.wakePaths, ['resident-sync'], `Alt+A left the synchronous resident-overlay path: ${result.wakePaths.join(', ')}`);
    assert.equal(result.losslessPreviewEncoding.max, 0, 'Alt+A encoded a full-screen PNG while interaction was active');
    assert.ok(result.losslessPreviewPreparation.max < 80, `Alt+A lossless BMP preparation took ${result.losslessPreviewPreparation.max}ms`);
    assert.ok(result.losslessPreviewReady.max < 500, `Alt+A lossless preview was not ready within 500ms: ${result.losslessPreviewReady.max}ms`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
