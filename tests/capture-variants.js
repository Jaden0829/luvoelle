const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

async function waitForWindowByFile(electronApp, fileName, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const match = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

async function waitForOverlayActive(electronApp, active, timeout = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const opacity = await electronApp.evaluate(({ BrowserWindow }) => Math.max(0, ...BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && win.webContents.getURL().endsWith('/overlay.html'))
      .map((win) => win.getOpacity())));
    if (active ? opacity > 0.9 : opacity < 0.1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for overlay active=${active}`);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const executablePath = process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe');
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `capture-variant-profile-${Date.now()}`);
  const artifacts = path.join(root, 'work', 'test-artifacts');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  assert.match(mainSource, /id === 'edit'[\s\S]{0,160}captureVariant: 'fast'/);
  assert.match(mainSource, /id === 'quickEdit'[\s\S]{0,160}captureVariant: 'faithful'/);
  assert.match(mainSource, /previewFormat = captureVariant === 'fast' \? 'bmp' : 'png'[\s\S]+frameLosslessBmp/);
  assert.doesNotMatch(mainSource, /overlay:preview-upgrade/);

  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: [...(packaged ? [] : ['.']), '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile },
  });
  try {
    const page = await waitForWindowByFile(electronApp, 'index.html');
    const overlay = await waitForWindowByFile(electronApp, 'overlay.html');
    await page.waitForSelector('.action-card[data-capture="edit"]');
    if (packaged) assert.equal((await page.evaluate(() => window.luvoelle.bootstrap())).version, require('../package.json').version);
    await overlay.waitForFunction(() => document.body.classList.contains('is-standby'));
    await overlay.waitForTimeout(250);
    const standbyOpacity = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL().endsWith('/overlay.html'))?.getOpacity());
    assert.ok(standbyOpacity > 0 && standbyOpacity < 0.1, `Overlay is not compositor-resident in standby: opacity=${standbyOpacity}`);

    const startedAt = Date.now();
    await page.click('.action-card[data-capture="edit"]');
    await waitForOverlayActive(electronApp, true);
    const observedFastVisibleMs = Date.now() - startedAt;
    const fastState = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.isFocused() && candidate.webContents.getURL().endsWith('/overlay.html'));
      return { entryMs: win?.luvoelleEntryLatencyMs, variant: win?.luvoelleCaptureVariant };
    });
    assert.equal(fastState.variant, 'fast');
    assert.ok(fastState.entryMs < 180, `Alt+A internal entry took ${fastState.entryMs}ms`);
    await overlay.waitForFunction(() => document.body.dataset.captureVariant === 'fast'
      && document.body.dataset.initialPreviewFormat === 'bmp'
      && document.body.dataset.previewFormat === 'bmp'
      && document.body.dataset.previewQuality === 'lossless'
      && document.body.dataset.previewReadyAt
      && document.getElementById('screen-image').naturalWidth > 0);
    const fastPreview = await overlay.locator('#screen-image').getAttribute('src');
    assert.ok(fastPreview.startsWith('blob:'), 'Alt+A lossless interaction preview is not backed by the BMP blob');
    const previewGeometry = await overlay.evaluate(() => ({
      naturalWidth: document.getElementById('screen-image').naturalWidth,
      naturalHeight: document.getElementById('screen-image').naturalHeight,
      expectedWidth: Math.round(innerWidth * config.scaleFactor),
      expectedHeight: Math.round(innerHeight * config.scaleFactor),
      sessionId: config.sessionId,
    }));
    assert.equal(previewGeometry.naturalWidth, previewGeometry.expectedWidth, 'Fast preview width does not match the native frame');
    assert.equal(previewGeometry.naturalHeight, previewGeometry.expectedHeight, 'Fast preview height does not match the native frame');
    const firstPaintMs = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((candidate) => candidate.isFocused() && candidate.webContents.getURL().endsWith('/overlay.html'))?.luvoelleFirstPaintMs);
    assert.ok(firstPaintMs < 160, `Alt+A first interactive paint took ${firstPaintMs}ms`);
    await overlay.locator('#screen-image').screenshot({ path: path.join(artifacts, 'alt-a-lossless-interaction-preview.png') });

    const pointerBenchmark = await overlay.evaluate(async () => {
      const benchmarkTargets = Array.from({ length: 600 }, (_, index) => ({
        left: (index * 17) % Math.max(1, innerWidth - 180),
        top: (index * 29) % Math.max(1, innerHeight - 100),
        width: 180,
        height: 100,
        title: `Benchmark ${index}`,
        source: index % 2 ? 'uia' : 'window',
        zIndex: index,
      }));
      config.windowTargets = benchmarkTargets;
      rebuildWindowTargetIndex();
      const before = { ...interactionMetrics };
      for (let index = 0; index < 1200; index += 1) {
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          clientX: (index * 13) % Math.max(1, innerWidth - 1),
          clientY: (index * 19) % Math.max(1, innerHeight - 1),
        }));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        pointerEvents: interactionMetrics.pointerEvents - before.pointerEvents,
        renderedFrames: interactionMetrics.renderedFrames - before.renderedFrames,
        coalescedEvents: interactionMetrics.coalescedEvents - before.coalescedEvents,
        maxFrameMs: interactionMetrics.maxFrameMs,
      };
    });
    assert.equal(pointerBenchmark.pointerEvents, 1200, 'Pointer benchmark did not receive every synthetic move');
    assert.ok(pointerBenchmark.renderedFrames <= 2, `Pointer moves were not frame-coalesced: ${pointerBenchmark.renderedFrames}`);
    assert.ok(pointerBenchmark.coalescedEvents >= 1198, `Pointer event coalescing was ineffective: ${pointerBenchmark.coalescedEvents}`);
    assert.ok(pointerBenchmark.maxFrameMs < 20, `Pointer target matching exceeded a frame budget: ${pointerBenchmark.maxFrameMs}ms`);

    const selection = { left: 820, top: 620, width: 220, height: 140 };
    await overlay.mouse.move(selection.left, selection.top);
    await overlay.mouse.down();
    await overlay.mouse.move(selection.left + selection.width, selection.top + selection.height, { steps: 5 });
    await overlay.mouse.up();
    await overlay.waitForSelector('#inline-editor:not([hidden])');
    assert.equal(await overlay.locator('body').getAttribute('data-capture-crop-path'), 'native-frame', 'Alt+A redundantly PNG-encoded the renderer preview before native cropping');
    assert.equal(await overlay.locator('body').getAttribute('data-capture-quality'), 'lossless');
    assert.match(await overlay.locator('body').getAttribute('data-capture-backend'), /^win32-gdi-/);
    const editor = overlay.frames().find((frame) => frame.url().includes('/editor.html?inline=1'));
    assert.ok(editor);
    await editor.waitForFunction(() => document.getElementById('editor-canvas')?.dataset.ready === 'true');
    const canvasBeforeToolbarDrag = await editor.locator('#editor-canvas').evaluate((element) => element.toDataURL('image/png'));
    const controlsBeforeToolbarDrag = await editor.evaluate(() => {
      const toolbarRect = document.querySelector('.editor-toolbar').getBoundingClientRect();
      const optionsRect = document.querySelector('.tool-options').getBoundingClientRect();
      return { toolbar: { left: toolbarRect.left, top: toolbarRect.top }, options: { left: optionsRect.left, top: optionsRect.top } };
    });
    const dragHandle = await editor.locator('#toolbar-drag-handle').boundingBox();
    assert.ok(dragHandle && dragHandle.width > 0, 'Inline editor drag handle is not visible');
    await overlay.mouse.move(dragHandle.x + dragHandle.width / 2, dragHandle.y + dragHandle.height / 2);
    await overlay.mouse.down();
    await overlay.mouse.move(dragHandle.x + dragHandle.width / 2 - 100, dragHandle.y + dragHandle.height / 2 - 140, { steps: 5 });
    await overlay.mouse.up();
    const controlsAfterToolbarDrag = await editor.evaluate(() => {
      const toolbarRect = document.querySelector('.editor-toolbar').getBoundingClientRect();
      const optionsRect = document.querySelector('.tool-options').getBoundingClientRect();
      return { toolbar: { left: toolbarRect.left, top: toolbarRect.top }, options: { left: optionsRect.left, top: optionsRect.top } };
    });
    assert.ok(Math.abs(controlsAfterToolbarDrag.toolbar.top - controlsBeforeToolbarDrag.toolbar.top) > 20, 'Inline toolbar did not move');
    assert.ok(Math.abs(controlsAfterToolbarDrag.toolbar.left - controlsAfterToolbarDrag.options.left) < 1, 'Toolbar and options did not move together horizontally');
    assert.ok(Math.abs((controlsAfterToolbarDrag.options.top - controlsAfterToolbarDrag.toolbar.top) - 57) < 1, 'Toolbar and options did not move together vertically');
    assert.equal(await editor.locator('#editor-canvas').evaluate((element) => element.toDataURL('image/png')), canvasBeforeToolbarDrag, 'Dragging the toolbar changed screenshot pixels');
    const scaleFactor = await overlay.evaluate(() => config.scaleFactor);
    assert.equal(await editor.locator('#editor-canvas').getAttribute('width'), String(Math.round(selection.width * scaleFactor)));
    assert.equal(await editor.locator('#editor-canvas').getAttribute('height'), String(Math.round(selection.height * scaleFactor)));
    await editor.click('#cancel-inline-editor');
    await waitForOverlayActive(electronApp, false);
    await overlay.waitForFunction(() => document.body.classList.contains('is-standby'));

    await page.click('.action-card[data-capture="translate"]');
    await waitForOverlayActive(electronApp, true);
    await overlay.waitForFunction(() => document.body.dataset.captureVariant === 'faithful'
      && document.body.dataset.previewFormat === 'png'
      && document.getElementById('screen-image').naturalWidth > 0);
    const faithfulState = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.isFocused() && candidate.webContents.getURL().endsWith('/overlay.html'));
      return { variant: win?.luvoelleCaptureVariant, backend: win?.luvoelleCaptureBackend };
    });
    assert.equal(faithfulState.variant, 'faithful');
    assert.match(faithfulState.backend, /^win32-gdi-/);
    assert.ok((await overlay.locator('#screen-image').getAttribute('src')).startsWith('data:image/png;base64,'));
    await overlay.keyboard.press('Escape');
    await waitForOverlayActive(electronApp, false);

    process.stdout.write(`${JSON.stringify({
      altA: { variant: 'fast', internalEntryMs: fastState.entryMs, firstPaintMs, observedVisibleMs: observedFastVisibleMs, preview: 'single-lossless-bmp', pointerBenchmark, final: 'lossless-native-frame' },
      f1: { variant: 'faithful', preview: 'png', transientUiFrozenBeforeFocus: true },
      compositorResidentStandby: true,
      packaged,
    })}\n`);
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
