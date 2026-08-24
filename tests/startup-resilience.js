const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

const TEST_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'];

async function waitForMain(electronApp, predicate, timeout = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const result = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => (
        !candidate.isDestroyed() && candidate.webContents.getURL().endsWith('/index.html')
      ));
      return win ? { id: win.id, visible: win.isVisible() } : null;
    }).catch(() => null);
    if (result && predicate(result)) return { ...result, elapsedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for a visible Luvoelle workbench');
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const executablePath = packaged
    ? (process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe'))
    : '';
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `startup-resilience-profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: [...(packaged ? [] : ['.']), ...TEST_FLAGS],
    env: {
      ...process.env,
      LUVOELLE_TEST: '1',
      LUVOELLE_TEST_USER_DATA: profile,
      LUVOELLE_TEST_LEGACY_WINDOWS: '1',
      LUVOELLE_TEST_WARMUP_HANG: '1',
    },
  });

  try {
    const firstMain = await waitForMain(electronApp, (win) => win.visible, 3500);
    assert.ok(firstMain.elapsedMs < 3000, `Workbench reveal was gated by optional warmups (${firstMain.elapsedMs}ms)`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(electronApp.process().exitCode, null, 'Main process exited during optional warmup');

    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('/index.html'));
      main.webContents.forcefullyCrashRenderer();
    });
    const recoveredMain = await waitForMain(electronApp, (win) => win.visible && win.id !== firstMain.id, 5000);

    const diagnostics = fs.readFileSync(path.join(profile, 'diagnostics.log'), 'utf8');
    assert.match(diagnostics, /"type":"startup-begin"/);
    assert.match(diagnostics, /"legacyWindowsCompatibility":true/);
    assert.match(diagnostics, /"type":"startup-main-ready"/);
    assert.match(diagnostics, /"type":"startup-warmups-begin"/);
    assert.match(diagnostics, /"type":"main-window-recovered"/);

    process.stdout.write(`${JSON.stringify({
      packaged,
      compatibilityMode: true,
      optionalWarmupHung: true,
      workbenchVisibleMs: firstMain.elapsedMs,
      workbenchIndependentFromWarmups: true,
      processStayedAlive: true,
      rendererCrashRecovered: recoveredMain.id !== firstMain.id,
      diagnosticsPersisted: true,
    })}\n`);
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
