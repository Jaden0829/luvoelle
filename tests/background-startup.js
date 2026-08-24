const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const electronPath = require('electron');
const { _electron: electron } = require('playwright');

const TEST_FLAGS = ['--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'];

async function waitForWindowByFile(electronApp, fileName, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const match = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

async function waitForMainVisibility(electronApp, visible, timeout = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const current = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((win) => !win.isDestroyed() && win.webContents.getURL().endsWith('/index.html'))?.isVisible() || false);
    if (current === visible) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for main visibility=${visible}`);
}

async function waitForOverlayActive(electronApp, active, timeout = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const opacity = await electronApp.evaluate(({ BrowserWindow }) => Math.max(0, ...BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && win.webContents.getURL().endsWith('/overlay.html'))
      .map((win) => win.getOpacity())));
    if (active ? opacity > 0.9 : opacity < 0.1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for overlay active=${active}`);
}

function launchSecondInstance({ executablePath, root, profile, background = false }) {
  const args = [...(executablePath ? [] : ['.']), ...(background ? ['--background'] : []), ...TEST_FLAGS];
  const child = spawn(executablePath || electronPath, args, {
    cwd: root,
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile },
    stdio: 'ignore',
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Second Luvoelle instance did not exit after handing off to the first instance'));
    }, 10000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const executablePath = packaged
    ? (process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe'))
    : '';
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `background-profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: [...(packaged ? [] : ['.']), '--background', ...TEST_FLAGS],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile },
  });

  try {
    const page = await waitForWindowByFile(electronApp, 'index.html');
    const overlay = await waitForWindowByFile(electronApp, 'overlay.html');
    await page.waitForFunction(() => document.readyState === 'complete');
    if (packaged) assert.equal((await page.evaluate(() => window.luvoelle.bootstrap())).version, require('../package.json').version);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await waitForMainVisibility(electronApp, false);
    assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+A')), true);

    // A capture started while the workbench is hidden must restore only the
    // windows that were visible before capture, never the hidden workbench.
    await page.evaluate(() => window.luvoelle.startCapture('edit'));
    await waitForOverlayActive(electronApp, true);
    await overlay.keyboard.press('Escape');
    await waitForOverlayActive(electronApp, false);
    await waitForMainVisibility(electronApp, false);

    assert.equal(await launchSecondInstance({ executablePath, root, profile }), 0);
    await waitForMainVisibility(electronApp, true);
    await page.evaluate(() => window.luvoelle.startCapture('edit'));
    await new Promise((resolve) => setTimeout(resolve, 650));
    await waitForMainVisibility(electronApp, false);
    await page.evaluate(() => window.luvoelle.cancelCapture());
    await page.evaluate(() => window.luvoelle.openMain());
    await waitForMainVisibility(electronApp, true);
    await page.evaluate(() => window.luvoelle.windowControl('close'));
    await waitForMainVisibility(electronApp, false);

    assert.equal(await launchSecondInstance({ executablePath, root, profile, background: true }), 0);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitForMainVisibility(electronApp, false);

    process.stdout.write(`${JSON.stringify({
      packaged,
      silentBackgroundStartup: true,
      shortcutsRemainActive: true,
      captureDoesNotRevealWorkbench: true,
      visibleWorkbenchStaysHiddenAfterCapture: true,
      explicitWorkbenchActionShowsWorkbench: true,
      manualSecondLaunchShowsWorkbench: true,
      backgroundSecondLaunchStaysSilent: true,
      singleInstance: true,
    })}\n`);
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
