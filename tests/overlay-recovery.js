const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

async function waitForWindowByFile(electronApp, fileName, predicate = () => true, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const match = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`) && predicate(candidate));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const executablePath = packaged
    ? (process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe'))
    : '';
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `overlay-recovery-profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: [...(packaged ? [] : ['.']), '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile },
  });

  try {
    const page = await waitForWindowByFile(electronApp, 'index.html');
    const originalOverlay = await waitForWindowByFile(electronApp, 'overlay.html');
    await originalOverlay.waitForFunction(() => document.body.classList.contains('is-standby'));
    const originalWebContentsId = await electronApp.evaluate(({ BrowserWindow }) => {
      const overlay = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('/overlay.html'));
      const id = overlay.webContents.id;
      overlay.webContents.forcefullyCrashRenderer();
      return id;
    });

    const recoveryStartedAt = Date.now();
    let recoveredState;
    while (Date.now() - recoveryStartedAt < 10000) {
      recoveredState = await electronApp.evaluate(({ BrowserWindow }, previousId) => {
        const overlay = BrowserWindow.getAllWindows().find((win) => {
          try {
            return !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
              && win.webContents.getURL().endsWith('/overlay.html') && win.webContents.id !== previousId;
          } catch {
            return false;
          }
        });
        return overlay ? { id: overlay.webContents.id, opacity: overlay.getOpacity() } : null;
      }, originalWebContentsId);
      if (recoveredState) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(recoveredState, 'Crashed capture overlay was not automatically rebuilt');
    assert.ok(recoveredState.opacity > 0 && recoveredState.opacity < 0.1);
    await page.evaluate(() => { window.luvoelle.startCapture('edit'); });
    let firstPaintMs;
    const captureStartedAt = Date.now();
    while (Date.now() - captureStartedAt < 3000) {
      firstPaintMs = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find((win) => win.luvoelleCaptureActive && win.luvoellePrimaryCapture && win.webContents.getURL().endsWith('/overlay.html'))?.luvoelleFirstPaintMs);
      if (Number.isFinite(firstPaintMs)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(firstPaintMs < 500, `Recovered overlay first paint took ${firstPaintMs}ms`);
    await page.evaluate(() => window.luvoelle.cancelCapture());
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.luvoelleCaptureActive)), false);

    const beforeResumeIds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((win) => {
        try { return !win.isDestroyed() && win.webContents.getURL().endsWith('/overlay.html'); } catch { return false; }
      })
      .map((win) => win.webContents.id));
    await electronApp.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); });
    const resumeRefreshStartedAt = Date.now();
    let resumedOverlayIds;
    while (Date.now() - resumeRefreshStartedAt < 6000) {
      resumedOverlayIds = await electronApp.evaluate(({ BrowserWindow }, previousIds) => {
        const ids = BrowserWindow.getAllWindows()
          .filter((win) => {
            try {
              return !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed()
                && win.webContents.getURL().endsWith('/overlay.html');
            } catch {
              return false;
            }
          })
          .map((win) => win.webContents.id);
        return ids.length >= previousIds.length && ids.every((id) => !previousIds.includes(id)) ? ids : null;
      }, beforeResumeIds);
      if (resumedOverlayIds) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(resumedOverlayIds, 'System resume did not renew every long-lived capture overlay');

    const diagnostics = fs.readFileSync(path.join(profile, 'diagnostics.log'), 'utf8');
    assert.match(diagnostics, /"type":"render-process-gone"/);
    assert.match(diagnostics, /"type":"overlay-resident-refreshed".*"reason":"system-resume"/);
    assert.doesNotMatch(diagnostics, /"type":"overlay-recovery-failed"/);
    process.stdout.write(`${JSON.stringify({ packaged, overlayCrashRecovery: true, recoveryMs: Date.now() - recoveryStartedAt, recoveredFirstPaintMs: firstPaintMs, resumeRefreshMs: Date.now() - resumeRefreshStartedAt })}\n`);
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
