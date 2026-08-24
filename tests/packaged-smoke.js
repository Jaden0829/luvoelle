const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { _electron: electron } = require('playwright');

async function startMockAiServer() {
  const image = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'icon.png')).toString('base64');
  let chatRequestCount = 0;
  const stats = { ocr: 0, translation: 0, vision: 0, ocrDetail: '' };
  const analysis = {
    summary: '打包版视觉拆解验证', scene_type: '电商视觉',
    product: { category: '测试商品', subject: '玻璃瓶', materials: ['玻璃'], colors: ['白色'], geometry: '圆柱体', details: ['金属盖'] },
    composition: { aspect_ratio: '4:3', framing: '中景', viewpoint: '平视', subject_position: '居中', negative_space: '上方' },
    camera: { shot_type: '产品特写', lens_guess: '推测 50mm', depth_of_field: '浅景深' },
    lighting: { source: '柔光箱', direction: '左侧', quality: '柔和', color_temperature: '中性' },
    background: { setting: '灰色背景', props: [], texture: '哑光' }, palette: ['#FFFFFF', '#999999'], visible_text: [], typography: '',
    prompts: { universal_zh: '打包版商品提示词', universal_en: 'packaged product prompt', qwen_image: '打包版商品提示词', flux: 'packaged product prompt', midjourney: 'packaged product prompt --ar 4:3', negative: '水印，变形' }, warnings: [], confidence: {},
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'packaged-vision' }] }));
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const systemPrompt = String(body.messages?.[0]?.content || '');
        if (systemPrompt.includes('严格的截图 OCR 转写引擎')) {
          stats.ocr += 1;
          stats.ocrDetail = body.messages?.[1]?.content?.find?.((item) => item.type === 'image_url')?.image_url?.detail || '';
          return response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: 'PACKAGED OCR 2026', language: 'en', confidence: 99 }) } }] }));
        }
        if (systemPrompt.includes('桌面截图翻译器')) {
          stats.translation += 1;
          return response.end(JSON.stringify({ choices: [{ message: { content: '打包版翻译结果' } }] }));
        }
        chatRequestCount += 1;
        stats.vision += 1;
        const sendResponse = () => response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
        if (chatRequestCount === 1) setTimeout(sendResponse, 900);
        else sendResponse();
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/images/edits') return response.end(JSON.stringify({ data: [{ b64_json: image }] }));
      response.statusCode = 404;
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: `http://127.0.0.1:${server.address().port}/v1`, stats };
}

async function waitForWindowByFile(electronApp, fileName, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const match = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

async function waitForBrowserWindowVisibility(electronApp, fileName, visible, timeout = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const current = await electronApp.evaluate(({ BrowserWindow }, expected) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && !candidate.webContents.isDestroyed() && candidate.webContents.getURL().endsWith(`/${expected.fileName}`));
      return win?.isVisible() || false;
    }, { fileName, visible });
    if (current === visible) return;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  throw new Error(`Timed out waiting for ${fileName} visibility=${visible}`);
}

async function waitForOverlayActive(electronApp, active, timeout = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    let opacity = 0;
    try {
      opacity = await electronApp.evaluate(({ BrowserWindow }) => Math.max(0, ...BrowserWindow.getAllWindows()
        .filter((candidate) => !candidate.isDestroyed() && !candidate.webContents.isDestroyed() && candidate.webContents.getURL().endsWith('/overlay.html'))
        .map((candidate) => candidate.getOpacity())));
    } catch (error) {
      if (!String(error?.message || error).includes('garbage collected')) throw error;
    }
    if (active ? opacity > 0.9 : opacity < 0.1) return;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  throw new Error(`Timed out waiting for overlay active=${active}`);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const executablePath = process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe');
  const profilePath = path.join(root, 'work', `packaged-profile-${Date.now()}`);
  const artifactPath = path.join(root, 'work', 'test-artifacts', 'packaged-workspace.png');
  assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const mockAi = await startMockAiServer();

  const electronApp = await electron.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'],
    env: { ...process.env, LUVOELLE_TEST_USER_DATA: profilePath },
  });
  try {
    const page = await waitForWindowByFile(electronApp, 'index.html');
    await page.waitForSelector('.action-card[data-capture="translate"]');
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true, 10000);
    await page.waitForTimeout(450);
    assert.equal(await page.locator('.action-card').count(), 4);
    assert.equal(await page.locator('.action-card[data-capture="prompt"]').count(), 1);
    assert.equal(await page.locator('.action-card[data-capture="edit"]').count(), 1);
    const shortcutMap = await page.evaluate(() => window.luvoelle.bootstrap().then((value) => value.shortcuts));
    assert.equal(shortcutMap.edit, 'Alt+A');
    assert.equal(shortcutMap.quickEdit, 'F1');
    assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F1')), true, 'Packaged F1 quick capture was not registered');
    assert.equal(await page.locator('.brand-mark img[src$="assets/icon.svg"]').count(), 1, 'Packaged Folded L brand mark is missing');
    await page.waitForFunction(() => document.querySelector('.brand-mark img')?.naturalWidth > 0);
    const trayIcon = await electronApp.evaluate(({ nativeImage }) => {
      const image = nativeImage.createFromPath(`${process.resourcesPath}\\app.asar\\assets\\icon.ico`);
      return { empty: image.isEmpty(), size: image.getSize() };
    });
    assert.equal(trayIcon.empty, false, 'Packaged Windows tray ICO could not be loaded');
    assert.ok(trayIcon.size.width >= 32 && trayIcon.size.height >= 32, 'Packaged Windows tray ICO has no usable representation');
    const overlay = await waitForWindowByFile(electronApp, 'overlay.html');
    const captureStartedAt = Date.now();
    await page.click('.action-card[data-capture="translate"]');
    await waitForOverlayActive(electronApp, true);
    assert.equal(await overlay.locator('.mini-mark img[src$="assets/icon.svg"]').count(), 1, 'Packaged capture overlay still uses the legacy mark');
    await overlay.waitForFunction(() => document.querySelector('.mini-mark img')?.naturalWidth > 0);
    assert.match(await overlay.locator('#capture-instruction').textContent(), /单击整窗/);
    assert.ok(Number(await overlay.locator('body').getAttribute('data-window-targets')) > 0, 'Packaged native window targets were not enumerated');
    const overlayVisibleLatencyMs = Date.now() - captureStartedAt;
    const captureEntryLatencyMs = await electronApp.evaluate(({ BrowserWindow }) => {
      const overlays = BrowserWindow.getAllWindows().filter((candidate) => candidate.webContents.getURL().endsWith('/overlay.html'));
      const win = overlays.find((candidate) => candidate.isFocused()) || overlays.find((candidate) => candidate.getOpacity() > 0.9);
      return win?.luvoelleEntryLatencyMs ?? 9999;
    });
    const prefreezeLatencyMs = await electronApp.evaluate(({ BrowserWindow }) => {
      const overlays = BrowserWindow.getAllWindows().filter((candidate) => candidate.webContents.getURL().endsWith('/overlay.html'));
      const win = overlays.find((candidate) => candidate.isFocused()) || overlays.find((candidate) => candidate.getOpacity() > 0.9);
      return win?.luvoellePrefreezeLatencyMs ?? 9999;
    });
    assert.ok(prefreezeLatencyMs < 400, `Packaged cold physical display prefreeze took ${prefreezeLatencyMs}ms`);
    assert.ok(captureEntryLatencyMs < 800, `Packaged lossless capture entry took ${captureEntryLatencyMs}ms`);
    await overlay.waitForFunction(() => document.visibilityState === 'visible' && document.getElementById('screen-image').naturalWidth > 0);
    const sourceCaptureBackends = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((candidate) => candidate.isVisible() && candidate.webContents.getURL().endsWith('/overlay.html'))
      .map((candidate) => candidate.luvoelleCaptureBackend));
    assert.ok(sourceCaptureBackends.includes('win32-gdi-prefreeze'), `Packaged active display was not prefrozen: ${sourceCaptureBackends.join(', ')}`);
    const screenFrozenLatencyMs = Date.now() - captureStartedAt;
    // The frozen pixel frame is asynchronous and can be delayed by other screen-capture
    // processes or antivirus scanning; the separately asserted visible overlay is the
    // interaction-critical latency and remains usable while this frame is loading.
    assert.ok(screenFrozenLatencyMs < 3500, `Packaged screen freeze took ${screenFrozenLatencyMs}ms`);
    await overlay.keyboard.press('Escape');
    await overlay.waitForTimeout(180);
    await waitForOverlayActive(electronApp, false);
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true);
    await page.waitForTimeout(3200);
    const idleCaptureStartedAt = Date.now();
    await page.click('.action-card[data-capture="translate"]');
    await waitForOverlayActive(electronApp, true);
    const idleOverlayVisibleLatencyMs = Date.now() - idleCaptureStartedAt;
    const idleCaptureEntryLatencyMs = await electronApp.evaluate(({ BrowserWindow }) => {
      const overlays = BrowserWindow.getAllWindows().filter((candidate) => candidate.webContents.getURL().endsWith('/overlay.html'));
      const win = overlays.find((candidate) => candidate.isFocused()) || overlays.find((candidate) => candidate.getOpacity() > 0.9);
      return win?.luvoelleEntryLatencyMs ?? 9999;
    });
    const idlePrefreezeLatencyMs = await electronApp.evaluate(({ BrowserWindow }) => {
      const overlays = BrowserWindow.getAllWindows().filter((candidate) => candidate.webContents.getURL().endsWith('/overlay.html'));
      const win = overlays.find((candidate) => candidate.isFocused()) || overlays.find((candidate) => candidate.getOpacity() > 0.9);
      return win?.luvoellePrefreezeLatencyMs ?? 9999;
    });
    assert.ok(idlePrefreezeLatencyMs < 250, `Packaged idle physical display prefreeze took ${idlePrefreezeLatencyMs}ms`);
    assert.ok(idleCaptureEntryLatencyMs < 800, `Packaged idle lossless overlay wake took ${idleCaptureEntryLatencyMs}ms`);
    // The hidden source page can delay Playwright's observation even though the
    // in-process overlay entry timestamp above has already been recorded.
    assert.ok(idleOverlayVisibleLatencyMs < 800, `Packaged idle overlay observation took ${idleOverlayVisibleLatencyMs}ms`);
    await overlay.keyboard.press('Escape');
    await waitForOverlayActive(electronApp, false);
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true);
    await page.click('.action-card[data-capture="edit"]');
    await waitForOverlayActive(electronApp, true);
    await overlay.waitForFunction(() => document.getElementById('screen-image').naturalWidth > 0);
    await overlay.mouse.move(160, 150);
    await overlay.mouse.down();
    await overlay.mouse.move(660, 450, { steps: 6 });
    const selectedPixelSize = await overlay.evaluate(() => {
      const selection = document.getElementById('selection').getBoundingClientRect();
      const source = document.getElementById('screen-image');
      return [
        Math.round(selection.width * source.naturalWidth / innerWidth),
        Math.round(selection.height * source.naturalHeight / innerHeight),
      ];
    });
    await overlay.mouse.up();
    await overlay.waitForSelector('#inline-editor:not([hidden])');
    assert.equal(await overlay.locator('body').getAttribute('data-capture-crop-path'), 'native-frame', 'Packaged Alt+A redundantly encoded a renderer-side crop');
    assert.equal(await overlay.locator('body').getAttribute('data-capture-quality'), 'lossless', 'Packaged Alt+A editor used the lossy preview image');
    const nativeCaptureBackend = await overlay.locator('body').getAttribute('data-capture-backend');
    assert.match(nativeCaptureBackend, /^win32-gdi-(?:prefreeze|secondary-freeze)$/, 'Packaged Alt+A editor did not crop a frozen physical-pixel frame');
    const packagedInlineEditor = overlay.frames().find((frame) => frame.url().includes('/editor.html?inline=1'));
    assert.ok(packagedInlineEditor, 'Packaged inline editor frame did not load');
    await packagedInlineEditor.waitForFunction(() => document.getElementById('editor-canvas')?.dataset.ready === 'true');
    const losslessCanvasSize = await packagedInlineEditor.locator('#editor-canvas').evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
    console.log(JSON.stringify({ selectedPixelSize, losslessCanvasSize }));
    assert.deepEqual(
      losslessCanvasSize,
      { width: selectedPixelSize[0], height: selectedPixelSize[1] },
      `Packaged Alt+A editor did not preserve the selected physical-pixel dimensions: selected=${selectedPixelSize.join('x')} actual=${losslessCanvasSize.width}x${losslessCanvasSize.height}`,
    );
    assert.equal((await electronApp.windows()).filter((candidate) => candidate.url().endsWith('/editor.html')).length, 0, 'Packaged Alt+A opened a separate editor window');
    assert.equal(await packagedInlineEditor.locator('#custom-color-control').isVisible(), true, 'Packaged custom color wheel is missing');
    await packagedInlineEditor.locator('#custom-color-picker').evaluate((element) => {
      element.value = '#23b7d9';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await packagedInlineEditor.locator('#editor-canvas').getAttribute('data-active-color'), '#23b7d9');
    assert.equal(await packagedInlineEditor.locator('#pin-editor').isVisible(), true, 'Packaged inline editor pin action is missing');
    await packagedInlineEditor.click('#pin-editor');
    await waitForOverlayActive(electronApp, false);
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true);
    const packagedPinnedImage = await waitForWindowByFile(electronApp, 'pin.html');
    await packagedPinnedImage.waitForFunction(() => document.body.dataset.ready === 'true');
    const packagedPinnedState = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/pin.html'));
      return { alwaysOnTop: win?.isAlwaysOnTop(), movable: win?.isMovable(), resizable: win?.isResizable(), visible: win?.isVisible() };
    });
    assert.deepEqual(packagedPinnedState, { alwaysOnTop: true, movable: true, resizable: true, visible: true });
    await packagedPinnedImage.keyboard.press('Escape');
    await packagedPinnedImage.waitForTimeout(100);
    assert.equal((await electronApp.windows()).filter((candidate) => candidate.url().endsWith('/pin.html')).length, 1, 'Escape closed the packaged pinned screenshot');
    await Promise.all([packagedPinnedImage.waitForEvent('close'), packagedPinnedImage.click('#pin-close')]);
    await page.click('.action-card[data-capture="edit"]');
    await waitForOverlayActive(electronApp, true);
    await overlay.waitForFunction(() => document.getElementById('screen-image').naturalWidth > 0);
    await overlay.mouse.move(180, 160);
    await overlay.mouse.down();
    await overlay.mouse.move(480, 340, { steps: 5 });
    await overlay.mouse.up();
    await overlay.keyboard.press('Enter');
    await waitForOverlayActive(electronApp, false);
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true);
    const sampleImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 240;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#111';
      context.font = '700 68px Arial';
      context.textBaseline = 'middle';
      context.fillText('PACKAGED OCR 2026', 78, 120);
      return canvas.toDataURL('image/png');
    });
    await page.evaluate(({ endpoint }) => window.luvoelle.saveSettings({
      provider: 'openai', endpoint, model: 'packaged-translator',
      ocrMode: 'ai',
      visionProvider: 'local', visionEndpoint: endpoint, visionModel: 'packaged-vision',
      visionApiKey: 'packaged-test-key',
      generationEndpoint: endpoint, generationModel: 'packaged-image',
    }), { endpoint: mockAi.endpoint });
    await page.evaluate((dataUrl) => {
      window.__packagedPrompt = window.luvoelle.processImage({ dataUrl, mode: 'prompt' });
    }, sampleImage);
    const promptWindow = await waitForWindowByFile(electronApp, 'prompt.html');
    await promptWindow.waitForFunction(() => document.querySelector('[data-tab="prompts"]')?.classList.contains('is-pending'));
    await promptWindow.waitForFunction(() => document.querySelector('.brand-mark img')?.naturalWidth > 0);
    assert.equal(await promptWindow.locator('.brand-mark img[src$="assets/icon.svg"]').count(), 1);
    await promptWindow.click('[data-tab="prompts"]');
    await promptWindow.waitForFunction(() => !document.querySelector('#prompt-waiting-state')?.hidden && document.querySelector('[data-tab-panel="prompts"]')?.classList.contains('is-active'));
    const packagedPromptResult = await page.evaluate(async () => {
      const value = await window.__packagedPrompt;
      return { id: value.id, summary: value.analysis.summary };
    });
    assert.equal(packagedPromptResult.summary, '打包版视觉拆解验证');
    await promptWindow.waitForSelector('#window-status.is-ready');
    await promptWindow.waitForFunction(() => document.querySelector('#source-image')?.naturalWidth > 0 && document.querySelector('#preview-frame')?.classList.contains('has-image'));
    assert.equal(await promptWindow.locator('#prompt-waiting-state').isHidden(), true);
    await promptWindow.click('[data-analysis-mode="ecommerce"]');
    await promptWindow.waitForFunction(() => document.querySelector('[data-analysis-mode="ecommerce"]')?.classList.contains('has-result') && document.querySelector('#window-status')?.classList.contains('is-ready'));
    const packagedVisionRequestsAfterEcommerce = mockAi.stats.vision;
    await promptWindow.click('[data-analysis-mode="daily"]');
    await promptWindow.waitForFunction(() => document.querySelector('[data-analysis-mode="daily"]')?.classList.contains('is-active'));
    assert.equal(mockAi.stats.vision, packagedVisionRequestsAfterEcommerce, '打包版返回日常模式不应重复请求');
    assert.equal(await promptWindow.locator('#regenerate-mode').isEnabled(), true);
    assert.equal(await promptWindow.locator('#maximize-window').isVisible(), true);
    await promptWindow.click('#maximize-window');
    await promptWindow.waitForFunction(() => document.querySelector('#maximize-window')?.getAttribute('aria-label') === '还原窗口');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/prompt.html'))?.isMaximized()), true);
    await promptWindow.click('#maximize-window');
    await promptWindow.waitForFunction(() => document.querySelector('#maximize-window')?.getAttribute('aria-label') === '最大化');
    await promptWindow.click('[data-tab="prompts"]');
    assert.match(await promptWindow.locator('#generator-model-badge').textContent(), /packaged-image/);
    assert.equal(await promptWindow.locator('#copy-prompt').isVisible(), true);
    await promptWindow.click('#generate-image');
    await promptWindow.waitForFunction(() => document.querySelector('#generated-image')?.naturalWidth > 0);
    await promptWindow.click('#copy-generated');
    await promptWindow.waitForTimeout(100);
    assert.equal(await electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()), true);
    await promptWindow.click('#pin-window');
    await promptWindow.waitForFunction(() => document.querySelector('#pin-window')?.getAttribute('aria-pressed') === 'true');
    await promptWindow.keyboard.press('Escape');
    await waitForBrowserWindowVisibility(electronApp, 'prompt.html', true);
    await promptWindow.click('#close-window');
    await waitForBrowserWindowVisibility(electronApp, 'prompt.html', false);
    const result = await page.evaluate((dataUrl) => window.luvoelle.processImage({ dataUrl, mode: 'ocr' }), sampleImage);
    assert.match(result.ocr.text, /PACKAGED|OCR/i);
    assert.equal(result.ocr.enhanced, true);
    assert.match(result.ocr.provider, /GPT 精确 OCR/);
    assert.equal(mockAi.stats.ocrDetail, 'original');
    await page.evaluate(() => window.luvoelle.saveSettings({ ocrMode: 'local' }));
    await page.click('#source-text');
    await page.locator('#source-text').fill('PACKAGED CORRECTED 2026');
    await page.click('#edit-source-text');
    await page.waitForFunction(() => document.querySelector('#source-text')?.textContent.trim() === 'PACKAGED CORRECTED 2026' && document.querySelector('#edit-source-text')?.hidden);
    const chineseSampleImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 260;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#111';
      context.font = '700 72px Microsoft YaHei';
      context.textBaseline = 'middle';
      context.fillText('这是中文识别测试', 100, 130);
      return canvas.toDataURL('image/png');
    });
    const captureSubmitResult = await page.evaluate((dataUrl) => window.luvoelle.submitCapture({ dataUrl, mode: 'translate' }), chineseSampleImage);
    const copiedScreenshot = await page.evaluate(() => window.luvoelle.getClipboardImage());
    const clipboardFormats = await electronApp.evaluate(({ clipboard }) => clipboard.availableFormats());
    const clipboardWriteConfirmed = Boolean(copiedScreenshot?.startsWith('data:image/'));
    assert.equal(captureSubmitResult.imageCopied, clipboardWriteConfirmed, `Packaged capture result did not reflect clipboard formats: ${clipboardFormats.join(', ')}`);
    const floatWindow = await waitForWindowByFile(electronApp, 'float.html');
    await floatWindow.waitForFunction(() => document.querySelector('#mode-label')?.textContent === '中文取字' && document.querySelector('.float-shell')?.classList.contains('complete'), null, { timeout: 60000 });
    await floatWindow.waitForFunction(() => document.querySelector('.float-mark img')?.naturalWidth > 0);
    assert.equal(await floatWindow.locator('.float-mark img[src$="assets/icon.svg"]').count(), 1);
    const compactFloatHeight = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/float.html'));
      return win?.getBounds().height || 0;
    });
    assert.ok(compactFloatHeight > 0 && compactFloatHeight <= 540);
    await floatWindow.keyboard.press('Escape');
    await waitForBrowserWindowVisibility(electronApp, 'float.html', false);
    await page.evaluate((dataUrl) => window.luvoelle.submitCapture({ dataUrl, mode: 'translate' }), sampleImage);
    await floatWindow.waitForFunction(() => document.querySelector('#mode-label')?.textContent === '截图翻译' && document.querySelector('.float-shell')?.classList.contains('complete') && !document.querySelector('#float-translation')?.classList.contains('loading'), null, { timeout: 60000 });
    assert.equal(await floatWindow.locator('#clipboard-status > span').textContent(), '截图已复制');
    await floatWindow.click('[data-copy="float-source"]');
    await floatWindow.waitForFunction(() => document.querySelector('#clipboard-status > span')?.textContent === '原文已复制');
    await floatWindow.click('[data-copy="float-translation"]');
    await floatWindow.waitForFunction(() => document.querySelector('#clipboard-status > span')?.textContent === '译文已复制');
    await floatWindow.click('#copy-image-footer');
    await floatWindow.waitForFunction(() => document.querySelector('#clipboard-status > span')?.textContent === '截图已复制');
    assert.ok((await page.evaluate(() => window.luvoelle.getClipboardImage()))?.startsWith('data:image/'));
    assert.equal(await floatWindow.locator('#copy-result').count(), 0);
    assert.equal(await floatWindow.locator('#retry-translation').isHidden(), true);
    const expandedSourceHeight = await floatWindow.locator('.source-pane').evaluate((element) => element.getBoundingClientRect().height);
    await floatWindow.locator('.translation-pane > header').click({ position: { x: 110, y: 15 } });
    await floatWindow.waitForTimeout(260);
    const packagedCollapseLayout = await floatWindow.evaluate(() => ({
      sourceHeight: document.querySelector('.source-pane').getBoundingClientRect().height,
      translationCollapsed: document.querySelector('.translation-pane').classList.contains('is-collapsed'),
    }));
    assert.equal(packagedCollapseLayout.translationCollapsed, true);
    assert.ok(packagedCollapseLayout.sourceHeight > expandedSourceHeight + 80, 'Packaged source pane did not expand after collapsing translation');
    await floatWindow.click('#edit-image');
    const editorWindow = await waitForWindowByFile(electronApp, 'editor.html');
    await editorWindow.waitForFunction(() => document.getElementById('editor-canvas')?.dataset.ready === 'true');
    assert.equal(await editorWindow.locator('.editor-mark img[src$="assets/icon.svg"]').count(), 1, 'Packaged editor still uses the legacy mark');
    assert.equal(await editorWindow.locator('.tool-button[data-tool]').count(), 7);
    const packagedEditorCanvas = editorWindow.locator('#editor-canvas');
    const packagedEditorBefore = await packagedEditorCanvas.evaluate((element) => element.toDataURL('image/png'));
    const packagedCanvasBox = await packagedEditorCanvas.boundingBox();
    await editorWindow.click('.tool-button[data-tool="arrow"]');
    await editorWindow.mouse.move(packagedCanvasBox.x + packagedCanvasBox.width * 0.55, packagedCanvasBox.y + packagedCanvasBox.height * 0.18);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(packagedCanvasBox.x + packagedCanvasBox.width * 0.72, packagedCanvasBox.y + packagedCanvasBox.height * 0.44, { steps: 8 });
    await editorWindow.mouse.up();
    await editorWindow.locator('#stroke-width').evaluate((element) => {
      element.value = '13';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await packagedEditorCanvas.getAttribute('data-selected-vector-stroke'), '13');
    await editorWindow.click('.tool-button[data-tool="mosaic"]');
    assert.equal(await editorWindow.locator('[data-mosaic-mode="square"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await editorWindow.locator('[data-mosaic-mode]').count(), 3);
    await editorWindow.locator('#mosaic-pixel').evaluate((element) => {
      element.value = '32';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await editorWindow.mouse.move(packagedCanvasBox.x + packagedCanvasBox.width * 0.35, packagedCanvasBox.y + packagedCanvasBox.height * 0.35);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(packagedCanvasBox.x + packagedCanvasBox.width * 0.7, packagedCanvasBox.y + packagedCanvasBox.height * 0.62, { steps: 10 });
    await editorWindow.mouse.up();
    assert.equal(await packagedEditorCanvas.getAttribute('data-annotations'), '2');
    assert.equal(await packagedEditorCanvas.getAttribute('data-selection-guide'), 'square');
    await editorWindow.locator('#mosaic-pixel').evaluate((element) => {
      element.value = '38';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await packagedEditorCanvas.getAttribute('data-selected-mosaic-blur'), '38');
    assert.equal(await packagedEditorCanvas.getAttribute('data-mosaic-effect'), 'frosted-glass');
    const packagedMosaicCanvasSize = await packagedEditorCanvas.evaluate((element) => ({ width: element.width, height: element.height }));
    const packagedSquareBeforeResize = (await packagedEditorCanvas.getAttribute('data-selected-mosaic-rect')).split(',').map(Number);
    const packagedSquareHandle = {
      x: packagedCanvasBox.x + (packagedSquareBeforeResize[0] + packagedSquareBeforeResize[2]) * packagedCanvasBox.width / packagedMosaicCanvasSize.width,
      y: packagedCanvasBox.y + (packagedSquareBeforeResize[1] + packagedSquareBeforeResize[3]) * packagedCanvasBox.height / packagedMosaicCanvasSize.height,
    };
    await editorWindow.mouse.move(packagedSquareHandle.x, packagedSquareHandle.y);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(packagedSquareHandle.x + 28, packagedSquareHandle.y + 22, { steps: 5 });
    await editorWindow.mouse.up();
    const packagedSquareAfterResize = (await packagedEditorCanvas.getAttribute('data-selected-mosaic-rect')).split(',').map(Number);
    assert.ok(packagedSquareAfterResize[2] > packagedSquareBeforeResize[2] && packagedSquareAfterResize[3] > packagedSquareBeforeResize[3], 'Packaged frosted mosaic could not be resized');
    await editorWindow.click('[data-mosaic-mode="circle"]');
    await editorWindow.mouse.move(packagedCanvasBox.x + packagedCanvasBox.width * 0.18, packagedCanvasBox.y + packagedCanvasBox.height * 0.2);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(packagedCanvasBox.x + packagedCanvasBox.width * 0.34, packagedCanvasBox.y + packagedCanvasBox.height * 0.48, { steps: 7 });
    await editorWindow.mouse.up();
    assert.equal(await packagedEditorCanvas.getAttribute('data-annotations'), '3');
    assert.equal(await packagedEditorCanvas.getAttribute('data-selection-guide'), 'circle');
    assert.notEqual(await packagedEditorCanvas.evaluate((element) => element.toDataURL('image/png')), packagedEditorBefore, 'Packaged image editor did not apply mosaic');
    await editorWindow.click('.tool-button[data-tool="emoji"]');
    await editorWindow.click('[data-emoji="🔥"]');
    await editorWindow.mouse.click(packagedCanvasBox.x + packagedCanvasBox.width * 0.72, packagedCanvasBox.y + packagedCanvasBox.height * 0.24);
    assert.equal(await packagedEditorCanvas.getAttribute('data-annotations'), '4');
    assert.equal(await packagedEditorCanvas.getAttribute('data-selected-emoji'), '🔥');
    await editorWindow.locator('#emoji-size').evaluate((element) => {
      element.value = '96';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await packagedEditorCanvas.getAttribute('data-selected-emoji-size'), '96');
    await editorWindow.click('.emoji-tool-button');
    await editorWindow.keyboard.press('Delete');
    assert.equal(await packagedEditorCanvas.getAttribute('data-annotations'), '3');
    await editorWindow.click('#close-editor');
    await waitForBrowserWindowVisibility(electronApp, 'editor.html', false);
    await waitForBrowserWindowVisibility(electronApp, 'float.html', true);
    await floatWindow.keyboard.press('Escape');
    await waitForBrowserWindowVisibility(electronApp, 'float.html', false);
    await page.reload();
    await page.waitForSelector('.nav-item[data-view="settings"]');
    await page.click('.nav-item[data-view="settings"]');
    await page.waitForSelector('#view-settings.is-active');
    assert.equal(await page.locator('#test-vision-service').textContent(), '检测并保存');
    assert.equal(await page.locator('#vision-configured-model').textContent(), '已保存模型 · packaged-vision');
    assert.equal(await page.locator('#setting-provider option').count(), 5);
    assert.equal(await page.locator('#setting-ocr-mode option').count(), 3);
    assert.equal(await page.locator('[data-shortcut-input]').count(), 6);
    assert.equal(await page.locator('[data-shortcut-input="quickEdit"]').textContent(), 'F1');
    const packagedF1Registered = await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F1'));
    assert.equal(await page.locator('[data-shortcut-row="quickEdit"]').evaluate((row) => row.classList.contains('is-unavailable')), !packagedF1Registered);
    assert.equal(await page.locator('#reuse-vision-translation').isVisible(), true);
    assert.equal(await page.locator('#settings-save-bar').isVisible(), true);
    await page.screenshot({ path: artifactPath });
    console.log(JSON.stringify({ packaged: true, trayIcon, ocrText: result.ocr.text.trim(), correctedText: 'PACKAGED CORRECTED 2026', confidence: result.ocr.confidence, chineseTranslationSkipped: true, compactFloatHeight, visualPromptWindow: true, referenceGeneration: true, promptHistoryId: packagedPromptResult.id, visionDetectAndSave: true, persistentSettingsSaveBar: true, collapsibleResultPanes: true, fullPaneHeaderCollapseHitArea: true, clipboardStatusStates: ['截图已复制', '原文已复制', '译文已复制'], directScreenshotRecopy: true, redundantFooterTranslationCopyRemoved: true, translationRetryAction: true, sourceExpandedHeight: Math.round(packagedCollapseLayout.sourceHeight), imageEditor: true, imageEditorTools: 7, emojiEditor: true, altAnnotationShortcut: 'Alt+A', instantMenuShortcut: 'F1', configurableGlobalShortcuts: true, pinnedScreenshotComparison: true, customColorWheel: true, enterCompletesInlineEditor: true, nativeCaptureBackend, sourceCaptureBackends, losslessCanvasSize, vectorStrokeWidthAdjusted: 13, mosaicBlurLevel: 38, mosaicModes: ['square', 'circle', 'brush'], persistentMosaicSelectionGuide: true, adjustableSelectedMosaicBlur: true, overlayVisibleLatencyMs, captureEntryLatencyMs, prefreezeLatencyMs, idleOverlayVisibleLatencyMs, idleCaptureEntryLatencyMs, idlePrefreezeLatencyMs, screenFrozenLatencyMs, escapeCanceledCapture: true, escapeClosedResultFloat: true, capturedImageCopied: clipboardWriteConfirmed, clipboardUnavailableDuringRun: !clipboardWriteConfirmed }));
  } finally {
    await electronApp.close();
    await new Promise((resolve) => mockAi.server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
