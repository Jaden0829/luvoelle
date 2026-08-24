const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

if (process.platform !== 'win32') {
  process.stdout.write(`${JSON.stringify({ skipped: true, reason: 'Windows-only native pet click test' })}\n`);
  process.exit(0);
}

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const mouseEvent = user32.func('void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t extraInfo)');
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;

async function movePointerToDip(electronApp, target) {
  let guess = { ...target };
  let actual = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    SetCursorPos(Math.round(guess.x), Math.round(guess.y));
    await new Promise((resolve) => setTimeout(resolve, 18));
    actual = await electronApp.evaluate(({ screen }) => screen.getCursorScreenPoint());
    const dx = target.x - actual.x;
    const dy = target.y - actual.y;
    if (Math.abs(dx) <= 6 && Math.abs(dy) <= 6) return actual;
    guess = { x: guess.x + dx, y: guess.y + dy };
  }
  throw new Error(`Could not position native pointer at ${JSON.stringify(target)}; actual ${JSON.stringify(actual)}`);
}

async function movePointerAway(electronApp) {
  const point = await electronApp.evaluate(({ screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + Math.round(area.width / 2), y: area.y + Math.round(area.height / 2) };
  });
  return movePointerToDip(electronApp, point);
}

async function nativePrimaryClick(holdMs = 40) {
  mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
}

async function waitForAssistant(electronApp, timeout = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      return win ? { bounds: win.getBounds(), visible: win.isVisible(), focusable: win.isFocusable() } : null;
    });
    if (state?.visible) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for desktop pet');
}

async function assistantSide(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
    return win ? win.webContents.executeJavaScript('document.body.dataset.side') : 'right';
  });
}

async function waitForExpanded(electronApp, timeout = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      return win ? { bounds: win.getBounds(), focusable: win.isFocusable() } : null;
    });
    if (state?.bounds.width >= 450 && state.focusable) return state;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return null;
}

async function waitForCollapsed(electronApp, timeout = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      return win ? { bounds: win.getBounds(), focusable: win.isFocusable() } : null;
    });
    if (state?.bounds.width <= 100 && state.focusable) return state;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return null;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const executablePath = packaged
    ? (process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe'))
    : '';
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `assistant-native-click-profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: [...(packaged ? [] : ['.']), '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile, LUVOELLE_DISABLE_PADDLE: '1' },
  });

  try {
    // Every run must cross the native window boundary. Leaving the cursor at
    // the previous run's pet position produces no WM_MOUSEMOVE/enter event.
    await movePointerAway(electronApp);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await waitForAssistant(electronApp);
    // Keep the test on the primary display. This avoids Windows DPI
    // virtualization differences for negative-origin secondary monitors while
    // the app's own multi-display logic is covered separately.
    const initial = await electronApp.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      const area = screen.getPrimaryDisplay().workArea;
      const current = win.getBounds();
      win.setBounds({ x: area.x + area.width - current.width - 4, y: area.y + Math.round((area.height - current.height) * 0.42), width: current.width, height: current.height }, false);
      return { bounds: win.getBounds(), visible: win.isVisible(), focusable: win.isFocusable() };
    });
    assert.equal(initial.focusable, true);
    const side = await assistantSide(electronApp);
    const hoverPointDip = {
      x: side === 'left' ? initial.bounds.x + 18 : initial.bounds.x + initial.bounds.width - 18,
      y: initial.bounds.y + Math.round(initial.bounds.height * 0.58),
    };
    const hoverPoint = await movePointerToDip(electronApp, hoverPointDip);
    const hoverDelayMs = Math.max(0, Number(process.env.LUVOELLE_TEST_PET_HOVER_DELAY_MS ?? 500));
    await new Promise((resolve) => setTimeout(resolve, hoverDelayMs));
    const hovered = await waitForAssistant(electronApp);
    const clickPointDip = {
      x: side === 'left' ? hovered.bounds.x + 22 : hovered.bounds.x + hovered.bounds.width - 22,
      y: hovered.bounds.y + Math.round(hovered.bounds.height * 0.58),
    };
    const clickPoint = await movePointerToDip(electronApp, clickPointDip);
    await nativePrimaryClick();
    const expanded = await waitForExpanded(electronApp);
    assert.ok(expanded, `A real Windows mouse click did not expand the desktop pet after ${hoverDelayMs}ms hover`);
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      return win?.webContents.executeJavaScript("window.luvoelle.assistantCollapse()");
    });
    const collapsedAgain = await waitForCollapsed(electronApp);
    assert.ok(collapsedAgain, 'Desktop pet did not return to its collapsed edge state');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await movePointerAway(electronApp);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await movePointerToDip(electronApp, hoverPointDip);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await movePointerToDip(electronApp, clickPointDip);
    await nativePrimaryClick();
    const reopened = await waitForExpanded(electronApp);
    assert.ok(reopened, 'A second real Windows mouse click did not reopen the desktop pet');
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      return win?.webContents.executeJavaScript("window.luvoelle.assistantCollapse().then(() => { document.getElementById('pet-button').style.pointerEvents = 'none'; })");
    });
    const collapsedForHook = await waitForCollapsed(electronApp);
    assert.ok(collapsedForHook, 'Desktop pet did not collapse before native hook test');
    await movePointerAway(electronApp);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await movePointerToDip(electronApp, clickPointDip);
    await nativePrimaryClick();
    const nativeHookExpanded = await waitForExpanded(electronApp);
    assert.ok(nativeHookExpanded, 'Windows low-level mouse hook did not open the pet when renderer pointer events were disabled');
    process.stdout.write(`${JSON.stringify({ packaged, side, initial, hovered, hoverPoint, hoverDelayMs, clickPoint, expanded, collapsedAgain, reopened, nativeHookExpanded, nativeClickExpanded: Boolean(expanded), nativeClickReopened: Boolean(reopened), nativeHookWorked: Boolean(nativeHookExpanded) })}\n`);
  } finally {
    try { await movePointerAway(electronApp); } catch { /* app may already be closing */ }
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
