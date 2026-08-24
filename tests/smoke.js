const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { _electron: electron } = require('playwright');

const MOCK_IMAGE_BASE64 = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'icon.png')).toString('base64');

async function startMockAiServer() {
  let visionRequestCount = 0;
  const stats = { vision: 0, ocr: 0, translation: 0, generation: 0, gridPromptReceived: false, ocrDetail: '', translationSystemPrompt: '', translationBody: null, deepseekTranslationBody: null, nextVisionDelayMs: 0 };
  const analysis = {
    summary: '一只极简护肤瓶置于浅灰色台面，采用柔和侧光与居中构图。',
    scene_type: '电商产品静物',
    product: { category: '护肤品', subject: '磨砂玻璃精华瓶', materials: ['磨砂玻璃', '金属'], colors: ['乳白色', '#B7C7D8'], geometry: '竖向圆柱体', details: ['银色滴管盖', '极简标签'] },
    composition: { aspect_ratio: '4:3', framing: '中近景', viewpoint: '轻微俯拍', subject_position: '居中偏下', negative_space: '上方留白充足' },
    camera: { shot_type: '产品静物特写', lens_guess: '推测 50–85mm', depth_of_field: '浅景深' },
    lighting: { source: '大型柔光箱', direction: '左前侧', quality: '柔和漫射光', color_temperature: '中性偏冷' },
    background: { setting: '浅灰无缝背景', props: ['石材台面'], texture: '细腻哑光' },
    palette: ['#F5F3EF', '#B7C7D8', '#363A40'],
    visible_text: ['{品牌名}', '{商品名}'],
    typography: '细字重无衬线体，宽松字距',
    prompts: {
      universal_zh: '极简高端护肤品静物，{商品名}磨砂玻璃瓶，浅灰无缝背景，柔和左侧光，居中构图，细腻商业摄影',
      universal_en: 'Minimal premium skincare still life, frosted glass bottle, seamless light gray background, soft left key light, centered composition',
      qwen_image: '电商产品摄影，{商品名}磨砂玻璃瓶，柔和侧光，浅灰背景，4:3',
      flux: 'premium product still life, frosted glass bottle, soft diffused side light, neutral palette, commercial photography',
      midjourney: 'premium skincare bottle, minimal studio still life, soft side light, neutral gray --ar 4:3 --style raw',
      negative: '变形包装，错误文字，重复商品，水印，过曝，低清晰度',
    },
    warnings: ['画面含品牌与商品文字，商用生成时请替换为自有品牌资产。'],
    confidence: { product: 0.95, composition: 0.91 },
  };
  const dramaAnalysis = {
    analysis_mode: 'drama',
    summary: '少女在木质房间内警觉地看向门外，安静气氛被未知动静打破。',
    scene_type: '短剧镜头',
    drama: {
      narrative_beat: '[推测]少女察觉门外有人',
      dramatic_purpose: '制造悬念并引出下一镜',
      characters: [{ name: '少女', appearance: '黑色长发，圆脸', wardrobe: '浅紫色和服', expression: '警觉', body_language: '身体略微停顿', screen_position: '画面左侧' }],
      relationships: ['当前单帧仅出现一人，人物关系无法确认'],
      location: { setting: '木质日式房间', time: '室内夜晚', weather: '无法确认' },
      props: ['门帘', '木质拉门'],
      visible_action: '少女转头看向画面右侧的门口',
      performance: '眼神警觉，肩部略微收紧',
      conflict_tension: '门外未知动静与室内安静形成反差',
      blocking: '少女位于画面左侧，视线指向右侧门口',
      dialogue_or_subtitle: [],
      continuity: {
        identity_locks: ['同一张脸', '黑色长发'],
        wardrobe_locks: ['浅紫色和服'],
        scene_locks: ['木质房间', '右侧门口'],
        screen_direction: '少女始终朝画面右侧看，后续反打保持轴线',
        before: '[推测]室内原本安静',
        after: '[推测]下一镜可切门外或人物反应特写',
      },
      suggested_duration: '4秒',
      uncertainties: ['门外人物与动静来源无法从单帧确认'],
    },
    composition: { aspect_ratio: '4:3', framing: '中景', viewpoint: '平视', subject_position: '人物居左', negative_space: '右侧门口留出悬念空间' },
    camera: { shot_type: '中景', camera_angle: '平视', lens_guess: '推测 35–50mm', depth_of_field: '中等景深', camera_movement: '缓慢推近' },
    lighting: { source: '室内柔光', direction: '左前侧', quality: '低反差柔光', color_temperature: '偏暖' },
    background: { setting: '木质日式房间', props: ['门帘', '木质拉门'], texture: '温暖木纹' },
    palette: ['#E8D8E7', '#7B5540', '#2A2528'],
    visible_text: [],
    typography: '',
    prompts: {
      first_frame_zh: '短剧首帧，黑色长发少女穿浅紫色和服站在木质房间左侧，警觉地望向右侧门口，中景平视，室内偏暖柔光，保留右侧悬念空间',
      first_frame_en: 'Short-drama opening frame, a black-haired girl in a pale purple kimono looks alertly toward the doorway on frame right, eye-level medium shot, warm soft interior light',
      keyframe_zh: '少女听见门外动静后猛然转头，眼神警觉，肩部收紧，右侧门口保持悬念留白',
      storyboard_zh: '中景平视，人物居左，视线朝右，门口居右；低反差暖光，利用空间留白制造悬念',
      image_to_video: '以输入画面为首帧，少女先轻微眨眼，随后缓慢转头看向右侧门口，门帘被微风轻轻带动，摄影机单一缓慢推近，4秒',
      character_continuity: '锁定少女圆脸、黑色长发、浅紫色和服、身形比例与朝右视线，保持木质房间和右侧门口位置',
      negative: '换脸，发型变化，服装变化，额外人物，肢体畸形，动作跳变，时间闪烁，镜头抖动，轴线翻转，乱码字幕，水印',
    },
    warnings: ['人物肖像用于公开发布前需确认授权。'],
    confidence: { character: 0.94, composition: 0.91 },
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'mock-qwen3-vl' }, { id: 'mock-image-edit' }] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const systemPrompt = String(body.messages?.[0]?.content || '');
        if (systemPrompt.includes('严格的截图 OCR 转写引擎')) {
          stats.ocr += 1;
          stats.ocrDetail = body.messages?.[1]?.content?.find?.((item) => item.type === 'image_url')?.image_url?.detail || '';
          setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: 'HELLO WORLD 2026', language: 'en', confidence: 99 }) } }] })), 1500);
          return;
        }
        if (systemPrompt.includes('桌面截图翻译器')) {
          stats.translation += 1;
          stats.translationSystemPrompt = systemPrompt;
          stats.translationBody = body;
          if (body.model === 'deepseek-v4-flash') stats.deepseekTranslationBody = body;
          const translatedText = systemPrompt.includes('越南语')
            ? 'Xin chào, thế giới'
            : systemPrompt.includes('泰语') ? 'สวัสดีชาวโลก' : '你好，世界';
          response.end(JSON.stringify({ choices: [{ message: { content: translatedText } }] }));
          return;
        }
        visionRequestCount += 1;
        stats.vision += 1;
        const requestedMode = systemPrompt.includes('电商拆图模式') ? '电商模式' : systemPrompt.includes('短剧拆图模式') ? '短剧模式' : '日常模式';
        const modeAnalysis = requestedMode === '短剧模式'
          ? { ...dramaAnalysis, summary: `${requestedMode} · ${dramaAnalysis.summary}` }
          : { ...analysis, summary: `${requestedMode} · ${analysis.summary}` };
        const sendResponse = () => response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modeAnalysis) } }] }));
        const delay = Number(stats.nextVisionDelayMs || (visionRequestCount === 2 ? 800 : 0));
        stats.nextVisionDelayMs = 0;
        if (delay) setTimeout(sendResponse, delay);
        else sendResponse();
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/images/edits') {
        stats.generation += 1;
        stats.gridPromptReceived ||= Buffer.concat(chunks).toString('utf8').includes('exact 3-by-3 grid');
        setTimeout(() => response.end(JSON.stringify({ data: [{ b64_json: MOCK_IMAGE_BASE64, revised_prompt: 'mock revised prompt' }] })), 800);
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
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

async function waitForOverlayMode(electronApp, label, timeout = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    for (const candidate of electronApp.windows().filter((page) => page.url().endsWith('/overlay.html'))) {
      try {
        if (await candidate.locator('#capture-mode').textContent() === label
          && !await candidate.locator('body').evaluate((body) => body.classList.contains('is-standby'))) return candidate;
      } catch { /* an overlay may be rebuilding between display changes */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  throw new Error(`Timed out waiting for active overlay mode ${label}`);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const executablePath = String(process.env.LUVOELLE_PACKAGED_PATH || '').trim();
  const packaged = Boolean(executablePath);
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const outputDir = path.join(root, 'work', 'test-artifacts');
  const testProfile = path.join(root, 'work', `test-profile-${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const mockAi = await startMockAiServer();

  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: [...(packaged ? [] : ['.']), '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: testProfile },
  });

  try {
    const page = await waitForWindowByFile(electronApp, 'index.html');
    await page.waitForSelector('.action-card[data-capture="translate"]');
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true, 10000);
    await page.waitForTimeout(500);
    assert.equal(await page.title(), 'Luvoelle');
    assert.equal(await page.locator('.action-card').count(), 4);
    assert.equal(await page.locator('.action-card[data-capture="prompt"]').count(), 1);
    assert.equal(await page.locator('.action-card[data-capture="edit"]').count(), 1);
    const initialBootstrap = await page.evaluate(() => window.luvoelle.bootstrap());
    assert.equal(initialBootstrap.shortcuts.edit, 'Alt+A');
    assert.equal(initialBootstrap.shortcuts.quickEdit, 'F1');
    const initialF1Registered = await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F1'));
    assert.equal(initialF1Registered, initialBootstrap.settings.shortcutStatus.quickEdit.registered, 'F1 registration status was not exposed to the UI');
    assert.equal(await page.locator('.brand-mark img[src$="assets/icon.svg"]').count(), 1, 'Folded L brand mark is missing');
    await page.waitForFunction(() => document.querySelector('.brand-mark img')?.naturalWidth > 0);
    const brandSvg = fs.readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf8');
    assert.match(brandSvg, /folded-l-mark/);
    assert.match(brandSvg, /folded-l-face/);
    assert.doesNotMatch(brandSvg, /prism/i);
    const trayIcon = await electronApp.evaluate(({ nativeImage }, iconPath) => {
      const image = nativeImage.createFromPath(iconPath);
      return { empty: image.isEmpty(), size: image.getSize() };
    }, path.join(root, 'assets', 'icon.ico'));
    assert.equal(trayIcon.empty, false, 'Windows tray ICO could not be loaded');
    assert.ok(trayIcon.size.width >= 32 && trayIcon.size.height >= 32, 'Windows tray ICO has no usable representation');
    const icoData = fs.readFileSync(path.join(root, 'assets', 'icon.ico'));
    const icoCount = icoData.readUInt16LE(4);
    const icoSizes = Array.from({ length: icoCount }, (_, index) => icoData.readUInt8(6 + index * 16) || 256);
    assert.deepEqual(icoSizes, [16, 24, 32, 48, 64, 128, 256]);
    await page.screenshot({ path: path.join(outputDir, 'workspace.png') });

    const assistantWindow = await waitForWindowByFile(electronApp, 'assistant.html');
    await assistantWindow.waitForSelector('#pet-button');
    assert.equal(await assistantWindow.locator('body').evaluate((body) => body.classList.contains('is-expanded')), false);
    const collapsedAssistantState = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      return { bounds: win?.getBounds(), visible: win?.isVisible(), topmost: win?.isAlwaysOnTop(), focusable: win?.isFocusable(), opacity: win?.getOpacity() };
    });
    assert.equal(collapsedAssistantState.visible, true);
    assert.equal(collapsedAssistantState.topmost, true);
    assert.equal(collapsedAssistantState.focusable, true);
    assert.equal(collapsedAssistantState.bounds.width, 92);
    assert.ok(collapsedAssistantState.opacity < 0.5);
    await assistantWindow.screenshot({ path: path.join(outputDir, 'desktop-pet-collapsed.png'), omitBackground: true });
    await assistantWindow.hover('#pet-view');
    await assistantWindow.waitForTimeout(320);
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'))?.getOpacity()), 1);
    await assistantWindow.click('#pet-button');
    await assistantWindow.waitForSelector('body.is-expanded');
    const expandedAssistantState = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      return { bounds: win?.getBounds(), topmost: win?.isAlwaysOnTop(), focusable: win?.isFocusable() };
    });
    assert.equal(expandedAssistantState.topmost, true);
    assert.equal(expandedAssistantState.focusable, true);
    assert.ok(expandedAssistantState.bounds.width >= 450 && expandedAssistantState.bounds.height >= 580);
    await assistantWindow.click('#close-panel');
    await assistantWindow.waitForFunction(() => !document.body.classList.contains('is-expanded'));
    const closedPanelAssistantState = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      return { bounds: win?.getBounds(), visible: win?.isVisible(), focusable: win?.isFocusable() };
    });
    assert.equal(closedPanelAssistantState.visible, true, 'Closing the panel hid the desktop pet');
    assert.equal(closedPanelAssistantState.focusable, true);
    assert.equal(closedPanelAssistantState.bounds.width, 92);

    let overlay = await waitForWindowByFile(electronApp, 'overlay.html');
    const overlayCoverage = await electronApp.evaluate(({ BrowserWindow, screen }) => {
      const displays = new Map(screen.getAllDisplays().map((display) => [String(display.id), display.bounds]));
      return BrowserWindow.getAllWindows()
        .filter((candidate) => candidate.webContents.getURL().endsWith('/overlay.html'))
        .map((candidate) => ({
          displayId: String(candidate.luvoelleDisplayId),
          bounds: candidate.getBounds(),
          expected: displays.get(String(candidate.luvoelleDisplayId)),
          fullscreen: candidate.isFullScreen(),
        }));
    });
    assert.ok(overlayCoverage.length > 0 && overlayCoverage.every((entry) => JSON.stringify(entry.bounds) === JSON.stringify(entry.expected)), `Overlay does not cover complete displays: ${JSON.stringify(overlayCoverage)}`);
    const captureStartedAt = Date.now();
    await page.click('.action-card[data-capture="translate"]');
    await waitForOverlayActive(electronApp, true);
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'))?.isVisible()), false, 'Desktop pet assistant was captured instead of hiding');
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
    assert.ok(prefreezeLatencyMs < 250, `Physical display prefreeze took ${prefreezeLatencyMs}ms`);
    assert.ok(captureEntryLatencyMs < 800, `Lossless capture entry took ${captureEntryLatencyMs}ms`);
    await overlay.waitForFunction(() => document.visibilityState === 'visible' && document.getElementById('screen-image').naturalWidth > 0);
    const sourceCaptureBackends = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((candidate) => candidate.isVisible() && candidate.webContents.getURL().endsWith('/overlay.html'))
      .map((candidate) => candidate.luvoelleCaptureBackend));
    assert.ok(sourceCaptureBackends.includes('win32-gdi-prefreeze'), `Active display was not prefrozen: ${sourceCaptureBackends.join(', ')}`);
    const screenFrozenLatencyMs = Date.now() - captureStartedAt;
    assert.ok(screenFrozenLatencyMs < 3500, `Screen freeze took ${screenFrozenLatencyMs}ms`);
    await overlay.locator('#screen-image').screenshot({ path: path.join(outputDir, 'captured-background.png') });
    const rawBackground = await overlay.locator('#screen-image').getAttribute('src');
    assert.ok(rawBackground.startsWith('data:image/png;base64,'), 'Capture preview is not lossless PNG');
    fs.writeFileSync(path.join(outputDir, 'captured-background-raw.png'), Buffer.from(rawBackground.split(',')[1], 'base64'));
    await overlay.screenshot({ path: path.join(outputDir, 'capture-overlay.png') });
    await overlay.keyboard.press('Escape');
    await overlay.waitForTimeout(180);
    await waitForOverlayActive(electronApp, false);
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'))?.isVisible()), true, 'Desktop pet assistant was not restored after capture');
    await waitForBrowserWindowVisibility(electronApp, 'index.html', false);
    const idleCaptureLatenciesMs = [];
    await page.waitForTimeout(3200);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const idleCaptureStartedAt = Date.now();
      await page.evaluate(() => window.luvoelle.startCapture('translate'));
      await waitForOverlayActive(electronApp, true);
      const visibleLatency = Date.now() - idleCaptureStartedAt;
      const internalLatency = await electronApp.evaluate(({ BrowserWindow }) => {
        const overlays = BrowserWindow.getAllWindows().filter((candidate) => candidate.webContents.getURL().endsWith('/overlay.html'));
        const win = overlays.find((candidate) => candidate.isFocused()) || overlays.find((candidate) => candidate.getOpacity() > 0.9);
        return win?.luvoelleEntryLatencyMs ?? 9999;
      });
      idleCaptureLatenciesMs.push({ visibleLatency, internalLatency });
      assert.ok(internalLatency < 800, `Idle lossless overlay wake attempt ${attempt + 1} took ${internalLatency}ms`);
      // BrowserWindow hides the Playwright-controlled page as the overlay appears,
      // so the driver can occasionally observe the already-visible window late.
      // luvoelleEntryLatencyMs above is the in-process interaction-critical guard.
      assert.ok(visibleLatency < 1800, `Playwright observed the idle overlay after ${visibleLatency}ms on attempt ${attempt + 1}`);
      await overlay.keyboard.press('Escape');
      await waitForOverlayActive(electronApp, false);
      await waitForBrowserWindowVisibility(electronApp, 'index.html', false);
      await page.waitForTimeout(180);
    }
    await page.evaluate(() => window.luvoelle.openMain());
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true);
    await page.waitForTimeout(250);
    await page.evaluate(() => window.luvoelle.windowControl('maximize'));
    await page.waitForTimeout(250);

    const sampleImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 260;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#111111';
      context.font = '700 72px Arial';
      context.textBaseline = 'middle';
      context.fillText('HELLO WORLD 2026', 90, 130);
      return canvas.toDataURL('image/png');
    });

    const fastEditStartedAt = Date.now();
    await page.click('.action-card[data-capture="edit"]');
    await waitForOverlayActive(electronApp, true);
    overlay = await waitForOverlayMode(electronApp, '截图标注');
    const fastEditVisibleLatencyMs = Date.now() - fastEditStartedAt;
    const fastEditEntry = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.isFocused() && candidate.webContents.getURL().endsWith('/overlay.html'));
      return { latency: win?.luvoelleEntryLatencyMs ?? 9999, variant: win?.luvoelleCaptureVariant || '' };
    });
    assert.equal(fastEditEntry.variant, 'fast');
    assert.ok(fastEditEntry.latency < 180, `Alt+A fast overlay entry took ${fastEditEntry.latency}ms`);
    assert.equal(await overlay.locator('.mini-mark img[src$="assets/icon.svg"]').count(), 1, 'Capture overlay still uses the legacy mark');
    await overlay.waitForFunction(() => document.querySelector('.mini-mark img')?.naturalWidth > 0);
    assert.equal(await overlay.locator('#capture-mode').textContent(), '截图标注');
    assert.match(await overlay.locator('#capture-instruction').textContent(), /内部区域.*单击截取/);
    assert.ok(Number(await overlay.locator('body').getAttribute('data-window-targets')) > 0, 'Native window targets were not enumerated');
    await overlay.waitForFunction(() => document.getElementById('screen-image').naturalWidth > 0
      && document.body.dataset.initialPreviewFormat === 'bmp'
      && document.body.dataset.previewFormat === 'bmp'
      && document.body.dataset.previewQuality === 'lossless'
      && document.body.dataset.previewReadyAt);
    const snapFixture = await overlay.evaluate(() => {
      const target = { left: 140, top: 120, width: 420, height: 260, title: 'Window snap fixture', zIndex: 0 };
      prepareOverlay({ mode: 'edit', scaleFactor: 1, windowTargets: [target] });
      const canvas = document.createElement('canvas');
      canvas.width = innerWidth;
      canvas.height = innerHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = '#f5f5f7';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#111';
      context.font = '48px Arial';
      context.fillText('WINDOW SNAP', target.left + 40, target.top + 130);
      const dataUrl = canvas.toDataURL('image/png');
      document.getElementById('screen-image').src = dataUrl;
      document.getElementById('selection-image').style.backgroundImage = `url(${dataUrl})`;
      document.getElementById('loupe').style.backgroundImage = `url(${dataUrl})`;
      return { target, smart: { left: 180, top: 160, width: 260, height: 72, title: 'Small settings row', source: 'uia', controlType: 'ListItem', zIndex: 4 } };
    });
    await overlay.waitForFunction(() => document.getElementById('screen-image').naturalWidth > 0);
    await overlay.evaluate((smart) => applyOverlayTargetsUpdate({ sessionId: undefined, targets: [smart] }), snapFixture.smart);
    await overlay.waitForFunction(() => document.body.dataset.smartWindowTargets === '1');
    const smartPoint = { x: snapFixture.smart.left + 30, y: snapFixture.smart.top + 30 };
    const resolvedSmartTarget = await overlay.evaluate((point) => findWindowTarget(point), smartPoint);
    assert.equal(resolvedSmartTarget.title, 'Small settings row', 'Smallest nested smart target was not prioritized');
    await overlay.evaluate((point) => updateWindowTarget(point), smartPoint);
    assert.equal(await overlay.locator('#selection').getAttribute('class'), 'selection is-window-target');
    assert.match(await overlay.locator('#selection-size').textContent(), /Small settings row/);
    await overlay.evaluate((point) => {
      const target = document.elementFromPoint(point.x, point.y) || document.body;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: point.x, clientY: point.y, button: 0 }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: point.x, clientY: point.y, button: 0 }));
    }, smartPoint);
    await overlay.waitForSelector('#inline-editor:not([hidden])');
    assert.equal(await overlay.locator('#capture-header').isVisible(), false, 'Capture hint remained visible during inline editing');
    const inlineEditorFrame = overlay.frames().find((frame) => frame.url().includes('/editor.html?inline=1'));
    assert.ok(inlineEditorFrame, 'Inline editor frame did not load');
    await inlineEditorFrame.waitForFunction(() => document.getElementById('editor-canvas')?.dataset.ready === 'true');
    assert.equal(await inlineEditorFrame.locator('#pin-editor').isVisible(), true, 'Inline editor pin action is missing');
    for (const tool of ['rect', 'ellipse', 'arrow', 'pen', 'text']) {
      await inlineEditorFrame.click(`.tool-button[data-tool="${tool}"]`);
      assert.equal(await inlineEditorFrame.locator('#custom-color-control').isVisible(), true, `Custom color wheel is unavailable for ${tool}`);
    }
    await inlineEditorFrame.locator('#text-content').fill('Enter should remain text input');
    await inlineEditorFrame.locator('#text-content').press('Enter');
    assert.equal(await overlay.locator('#inline-editor').isVisible(), true, 'Enter submitted while typing text');
    await inlineEditorFrame.click('.tool-button[data-tool="rect"]');
    await inlineEditorFrame.locator('#custom-color-picker').evaluate((element) => {
      element.value = '#12abef';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await inlineEditorFrame.locator('#editor-canvas').getAttribute('data-active-color'), '#12abef');
    assert.equal(await inlineEditorFrame.locator('#custom-color-control').getAttribute('class').then((value) => value.includes('is-active')), true);
    assert.equal(await inlineEditorFrame.locator('#editor-canvas').getAttribute('width'), String(snapFixture.smart.width));
    assert.equal(await inlineEditorFrame.locator('#editor-canvas').getAttribute('height'), String(snapFixture.smart.height));
    const inlineStageBox = await inlineEditorFrame.locator('#canvas-stage').boundingBox();
    assert.ok(Math.abs(inlineStageBox.x - snapFixture.smart.left) <= 1 && Math.abs(inlineStageBox.y - snapFixture.smart.top) <= 1, 'Inline canvas moved away from the selected screen area');
    assert.equal((await electronApp.windows()).filter((candidate) => candidate.url().endsWith('/editor.html')).length, 0, 'Alt+A opened a separate editor window');
    const inlineCanvasBox = await inlineEditorFrame.locator('#editor-canvas').boundingBox();
    await overlay.mouse.move(inlineCanvasBox.x + 24, inlineCanvasBox.y + 16);
    await overlay.mouse.down();
    await overlay.mouse.move(inlineCanvasBox.x + 150, inlineCanvasBox.y + 58, { steps: 5 });
    await overlay.mouse.up();
    assert.equal(await inlineEditorFrame.locator('#editor-canvas').getAttribute('data-annotations'), '1');
    assert.equal(await inlineEditorFrame.locator('#editor-canvas').getAttribute('data-selected-rect-radius'), '0');
    await overlay.mouse.move(inlineCanvasBox.x + 36, inlineCanvasBox.y + 28);
    await overlay.mouse.down();
    await overlay.mouse.move(inlineCanvasBox.x + 58, inlineCanvasBox.y + 48, { steps: 4 });
    await overlay.mouse.up();
    const selectedRectRadius = Number(await inlineEditorFrame.locator('#editor-canvas').getAttribute('data-selected-rect-radius'));
    assert.ok(selectedRectRadius >= 16, `Rectangle corner radius handle did not update the completed shape (${selectedRectRadius})`);
    await inlineEditorFrame.click('.tool-button[data-tool="arrow"]');
    assert.equal(await inlineEditorFrame.locator('.arrow-style-option').isVisible(), true, 'Arrow styles are hidden');
    await overlay.mouse.move(inlineCanvasBox.x + 35, inlineCanvasBox.y + 60);
    await overlay.mouse.down();
    await overlay.mouse.move(inlineCanvasBox.x + 220, inlineCanvasBox.y + 18, { steps: 5 });
    await overlay.mouse.up();
    assert.equal(await inlineEditorFrame.locator('#editor-canvas').getAttribute('data-selected-arrow-style'), 'open');
    await inlineEditorFrame.click('[data-arrow-style="filled-double"]');
    assert.equal(await inlineEditorFrame.locator('#editor-canvas').getAttribute('data-selected-arrow-style'), 'filled-double', 'Completed arrow did not switch styles');
    assert.equal(await inlineEditorFrame.locator('#editor-canvas').getAttribute('data-annotations'), '2');
    await overlay.screenshot({ path: path.join(outputDir, 'inline-editor.png') });
    await inlineEditorFrame.click('#pin-editor');
    await waitForOverlayActive(electronApp, false);
    await waitForBrowserWindowVisibility(electronApp, 'index.html', false);
    const pinnedImageWindow = await waitForWindowByFile(electronApp, 'pin.html');
    await pinnedImageWindow.waitForFunction(() => document.body.dataset.ready === 'true');
    await pinnedImageWindow.screenshot({ path: path.join(outputDir, 'pinned-screenshot.png') });
    assert.equal(await pinnedImageWindow.locator('#pinned-image').getAttribute('src').then((value) => value.startsWith('data:image/png;base64,')), true);
    assert.equal(await pinnedImageWindow.locator('#pin-surface').evaluate((element) => getComputedStyle(element).webkitAppRegion), 'drag');
    const pinnedWindowState = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/pin.html'));
      return { alwaysOnTop: win?.isAlwaysOnTop(), movable: win?.isMovable(), resizable: win?.isResizable(), visible: win?.isVisible() };
    });
    assert.deepEqual(pinnedWindowState, { alwaysOnTop: true, movable: true, resizable: true, visible: true });
    await pinnedImageWindow.keyboard.press('Escape');
    await pinnedImageWindow.waitForTimeout(120);
    assert.equal((await electronApp.windows()).filter((candidate) => candidate.url().endsWith('/pin.html')).length, 1, 'Escape closed the pinned screenshot');
    await page.evaluate(() => window.luvoelle.openMain());
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true);
    await page.click('.action-card[data-capture="edit"]');
    await waitForOverlayActive(electronApp, true);
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/pin.html'))?.isVisible()), false, 'Pinned screenshot leaked into a new capture');
    await overlay.waitForFunction(() => document.getElementById('screen-image').naturalWidth > 0);
    await overlay.mouse.move(100, 120);
    await overlay.mouse.down();
    await overlay.mouse.move(300, 260, { steps: 5 });
    await overlay.mouse.up();
    await overlay.waitForSelector('#inline-editor:not([hidden])');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/pin.html'))?.isVisible()), true, 'Pinned screenshot was not restored for side-by-side editing');
    const comparisonEditorFrame = overlay.frames().find((frame) => frame.url().includes('/editor.html?inline=1'));
    await comparisonEditorFrame.waitForFunction(() => document.getElementById('editor-canvas')?.dataset.ready === 'true');
    await comparisonEditorFrame.locator('#editor-canvas').click({ position: { x: 80, y: 60 } });
    await overlay.keyboard.press('Enter');
    await waitForOverlayActive(electronApp, false);
    await waitForBrowserWindowVisibility(electronApp, 'index.html', false);
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/pin.html'))?.isVisible()), true, 'Pinned screenshot was not restored after capture');
    await Promise.all([pinnedImageWindow.waitForEvent('close'), pinnedImageWindow.click('#pin-close')]);

    await page.evaluate(({ endpoint }) => window.luvoelle.saveSettings({
      provider: 'openai',
      endpoint,
      model: 'mock-translator',
      ocrMode: 'ai',
      visionProvider: 'local',
      visionEndpoint: endpoint,
      visionModel: 'mock-qwen3-vl',
      visionApiKey: 'test-vision-key',
      generationEndpoint: endpoint,
      generationModel: 'mock-image-edit',
    }), { endpoint: mockAi.endpoint });
    await assistantWindow.click('#pet-button');
    await assistantWindow.waitForSelector('body.is-expanded');
    await assistantWindow.selectOption('#left-language', 'zh-CN');
    await assistantWindow.selectOption('#right-language', 'vi');
    await assistantWindow.fill('#left-text', '你好，欢迎使用 Luvoelle');
    await assistantWindow.click('#translate-forward');
    await assistantWindow.waitForFunction(() => document.querySelector('#right-text')?.value.includes('Xin chào'));
    assert.match(mockAi.stats.translationSystemPrompt, /越南语/);
    await assistantWindow.selectOption('#right-language', 'th');
    await assistantWindow.click('#translate-forward');
    await assistantWindow.waitForFunction(() => document.querySelector('#right-text')?.value.includes('สวัสดีชาวโลก'));
    assert.match(mockAi.stats.translationSystemPrompt, /泰语/);
    await assistantWindow.fill('#left-text', '');
    await assistantWindow.fill('#right-text', 'สวัสดีชาวโลก');
    await assistantWindow.click('#translate-backward');
    await assistantWindow.waitForFunction(() => document.querySelector('#left-text')?.value.includes('你好'));
    assert.match(mockAi.stats.translationSystemPrompt, /简体中文/);
    await electronApp.evaluate(({ clipboard, nativeImage }, dataUrl) => clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)), sampleImage);
    await assistantWindow.click('.paste-image[data-side="right"]');
    await assistantWindow.waitForFunction(() => document.querySelector('#right-text')?.value.includes('HELLO WORLD 2026')
      && document.querySelector('#right-image-status')?.textContent.includes('已识别'), null, { timeout: 60000 });
    assert.equal(await assistantWindow.locator('#right-image-chip').isVisible(), true);
    await assistantWindow.screenshot({ path: path.join(outputDir, 'desktop-pet-translator.png') });
    await assistantWindow.click('#collapse-panel');
    await assistantWindow.waitForFunction(() => !document.body.classList.contains('is-expanded'));
    await page.evaluate(() => window.luvoelle.openMain());
    await waitForBrowserWindowVisibility(electronApp, 'index.html', true);
    await page.click('.nav-item[data-view="text"]');
    await page.waitForSelector('#view-text.is-active');
    assert.equal(await page.locator('#manual-target option[value="vi"]').textContent(), '越南语');
    assert.equal(await page.locator('#manual-target option[value="th"]').textContent(), '泰语');
    assert.equal(await page.locator('#setting-target option[value="vi"]').textContent(), '越南语');
    assert.equal(await page.locator('#setting-target option[value="th"]').textContent(), '泰语');
    await page.selectOption('#manual-target', 'vi');
    await electronApp.evaluate(({ clipboard, nativeImage }, dataUrl) => clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)), sampleImage);
    await page.click('#manual-paste-image');
    await page.waitForFunction(() => document.querySelector('#manual-source')?.value.includes('HELLO WORLD 2026')
      && document.querySelector('#manual-image-status')?.textContent.includes('图片文字已识别'), null, { timeout: 60000 });
    assert.equal(await page.locator('#manual-image-preview').isVisible(), true);
    assert.match(await page.locator('#manual-result').textContent(), /Xin chào, thế giới/);
    assert.match(mockAi.stats.translationSystemPrompt, /越南语/);
    await page.fill('#manual-source', '你好，欢迎使用 Luvoelle');
    await page.click('#translate-manual');
    await page.waitForFunction(() => document.querySelector('#translate-manual')?.textContent.includes('翻译')
      && !document.querySelector('#translate-manual')?.disabled);
    assert.match(mockAi.stats.translationSystemPrompt, /越南语/);
    assert.match(await page.locator('#manual-result').textContent(), /Xin chào, thế giới/);
    await page.screenshot({ path: path.join(outputDir, 'manual-image-vietnamese-translation.png') });
    await page.selectOption('#manual-target', 'th');
    await page.click('#translate-manual');
    await page.waitForFunction(() => document.querySelector('#translate-manual')?.textContent.includes('翻译')
      && !document.querySelector('#translate-manual')?.disabled);
    assert.match(mockAi.stats.translationSystemPrompt, /泰语/);
    assert.match(await page.locator('#manual-result').textContent(), /สวัสดีชาวโลก/);
    await page.screenshot({ path: path.join(outputDir, 'manual-image-thai-translation.png') });
    await page.click('#clear-manual');
    assert.equal(await page.locator('#manual-image-preview').isHidden(), true);
    assert.equal(await page.locator('#manual-source').inputValue(), '');
    await page.click('.nav-item[data-view="workspace"]');
    const visionHealth = await page.evaluate(({ endpoint }) => window.luvoelle.checkVisionService({ endpoint }), { endpoint: mockAi.endpoint });
    assert.equal(visionHealth.ok, true);
    assert.ok(visionHealth.models.includes('mock-qwen3-vl'));

    const promptResult = await page.evaluate(async (dataUrl) => {
      const result = await window.luvoelle.processImage({ dataUrl, mode: 'prompt' });
      return { id: result.id, summary: result.analysis.summary, prompt: result.analysis.prompts.universalZh };
    }, sampleImage);
    assert.match(promptResult.summary, /护肤瓶|玻璃/);
    assert.match(promptResult.prompt, /商品名|护肤/);
    const promptWindow = await waitForWindowByFile(electronApp, 'prompt.html');
    await promptWindow.waitForSelector('#window-status.is-ready');
    await promptWindow.waitForFunction(() => document.querySelector('.brand-mark img')?.naturalWidth > 0);
    assert.equal(await promptWindow.locator('.brand-mark img[src$="assets/icon.svg"]').count(), 1);
    assert.equal((await promptWindow.locator('#pin-window').textContent()).trim(), '固定');
    await promptWindow.click('#pin-window');
    await promptWindow.waitForFunction(() => document.querySelector('#pin-window')?.getAttribute('aria-pressed') === 'true');
    const promptPinStates = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((candidate) => candidate.webContents.getURL().endsWith('/prompt.html'))
      .map((candidate) => ({ id: candidate.id, visible: candidate.isVisible(), pinned: candidate.isAlwaysOnTop() })));
    assert.ok(promptPinStates.some((candidate) => candidate.visible && candidate.pinned), `视觉窗口没有实际置顶：${JSON.stringify(promptPinStates)}`);
    await promptWindow.keyboard.press('Escape');
    await promptWindow.waitForTimeout(120);
    await waitForBrowserWindowVisibility(electronApp, 'prompt.html', true);
    assert.match(await promptWindow.locator('#toast-stack').textContent(), /已固定|不会关闭/);
    await promptWindow.click('#pin-window');
    await promptWindow.waitForFunction(() => document.querySelector('#pin-window')?.getAttribute('aria-pressed') === 'false');
    await promptWindow.waitForFunction(() => document.querySelector('#source-image')?.naturalWidth > 0 && document.querySelector('#preview-frame')?.classList.contains('has-image'));
    assert.equal(await promptWindow.locator('#maximize-window').isVisible(), true);
    await promptWindow.click('#maximize-window');
    await promptWindow.waitForFunction(() => document.querySelector('#maximize-window')?.getAttribute('aria-label') === '还原窗口');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/prompt.html'))?.isMaximized()), true);
    await promptWindow.screenshot({ path: path.join(outputDir, 'visual-window-maximized.png') });
    await promptWindow.click('#maximize-window');
    await promptWindow.waitForFunction(() => document.querySelector('#maximize-window')?.getAttribute('aria-label') === '最大化');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/prompt.html'))?.isMaximized()), false);
    assert.equal(await promptWindow.locator('#product-category').textContent(), '护肤品');
    assert.match(await promptWindow.locator('#camera-lens').textContent(), /推测/);
    assert.equal(await promptWindow.locator('#warning-list li').count(), 1);
    assert.equal(await promptWindow.locator('#analysis-mode-switch button').count(), 3);
    assert.equal(await promptWindow.locator('[data-analysis-mode="daily"]').evaluate((element) => element.classList.contains('is-active') && element.classList.contains('has-result')), true);
    assert.equal(await promptWindow.locator('#grid-tab').isHidden(), true);
    await page.evaluate((dataUrl) => {
      window.__luvoelleSecondPrompt = window.luvoelle.processImage({ dataUrl, mode: 'prompt' });
    }, sampleImage);
    await promptWindow.waitForFunction(() => (
      document.querySelector('#product-category')?.textContent === '等待分析'
      && document.querySelector('#product-subject')?.textContent === '正在分析新图片…'
      && document.querySelector('#prompt-text')?.value === ''
      && !document.querySelector('[data-tab="prompts"]')?.disabled
      && document.querySelector('[data-tab="prompts"]')?.classList.contains('is-pending')
      && document.querySelector('#warning-card')?.hidden
    ));
    await promptWindow.screenshot({ path: path.join(outputDir, 'visual-new-task-reset.png') });
    await promptWindow.click('[data-tab="prompts"]');
    await promptWindow.waitForFunction(() => (
      document.querySelector('[data-tab-panel="prompts"]')?.classList.contains('is-active')
      && !document.querySelector('#prompt-waiting-state')?.hidden
      && document.querySelector('#prompt-waiting-title')?.textContent.includes('提示词')
    ));
    await promptWindow.waitForTimeout(320);
    await promptWindow.screenshot({ path: path.join(outputDir, 'visual-prompt-waiting.png') });
    await page.evaluate(() => window.__luvoelleSecondPrompt);
    await promptWindow.waitForSelector('#window-status.is-ready');
    assert.equal(await promptWindow.locator('#product-category').textContent(), '护肤品');
    assert.equal(await promptWindow.locator('[data-tab="prompts"]').isEnabled(), true);
    assert.equal(await promptWindow.locator('#prompt-waiting-state').isHidden(), true);
    assert.equal(await promptWindow.locator('[data-tab-panel="prompts"]').evaluate((element) => element.classList.contains('is-active') && !element.classList.contains('is-waiting')), true);
    assert.match(await promptWindow.locator('#prompt-text').inputValue(), /商品名|护肤/);
    await promptWindow.screenshot({ path: path.join(outputDir, 'visual-prompt-ready-after-wait.png') });
    await promptWindow.click('[data-tab="analysis"]');
    await promptWindow.screenshot({ path: path.join(outputDir, 'visual-analysis.png') });
    await promptWindow.click('[data-tab="prompts"]');
    assert.match(await promptWindow.locator('#generator-model-badge').textContent(), /mock-image-edit/);
    assert.equal(await promptWindow.locator('.model-select > span').textContent(), '提示词模板');
    assert.equal(await promptWindow.locator('#copy-prompt').textContent(), '复制当前提示词');
    await promptWindow.locator('#prompt-text').fill('可编辑的 Luvoelle 商品视觉提示词');
    await promptWindow.click('#copy-prompt');
    const copiedPrompt = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(copiedPrompt, '可编辑的 Luvoelle 商品视觉提示词');
    await promptWindow.selectOption('#prompt-model', 'flux');
    assert.match(await promptWindow.locator('#prompt-text').inputValue(), /premium product still life/);
    const deniedProductGeneration = await promptWindow.evaluate(async (dataUrl) => {
      try {
        await window.luvoelle.generateReferenceImage({ dataUrl, prompt: 'test', strategy: 'product', rightsConfirmed: false });
        return '';
      } catch (error) {
        return error.message;
      }
    }, sampleImage);
    assert.match(deniedProductGeneration, /使用权|拥有/);
    await promptWindow.click('[data-strategy="style"]');
    await promptWindow.click('#generate-image');
    await promptWindow.waitForFunction(() => !document.querySelector('#generation-working')?.hidden);
    assert.equal(await promptWindow.locator('#generated-strategy').textContent(), '正在生成参考图');
    assert.match(await promptWindow.locator('#generation-working-model').textContent(), /mock-image-edit/);
    assert.equal(await promptWindow.locator('#generated-actions').isHidden(), true);
    await promptWindow.screenshot({ path: path.join(outputDir, 'generation-working-state.png') });
    await promptWindow.waitForFunction(() => document.querySelector('#generated-image')?.naturalWidth > 0);
    assert.equal(await promptWindow.locator('#generated-actions').isVisible(), true);
    assert.equal(await promptWindow.locator('#generation-error').isHidden(), true);
    await promptWindow.screenshot({ path: path.join(outputDir, 'reference-generation.png') });
    await promptWindow.click('#copy-generated');
    const generatedCopyResult = await promptWindow.evaluate(() => window.luvoelle.copyImage(document.querySelector('#generated-image').src));
    assert.equal(generatedCopyResult, true);
    const generatedClipboardReady = await electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty());
    assert.equal(generatedClipboardReady, true);
    await promptWindow.click('[data-tab="analysis"]');
    const dailySummary = await promptWindow.locator('#summary-text').textContent();
    assert.match(dailySummary, /日常模式/);
    const visionBeforeEcommerce = mockAi.stats.vision;
    mockAi.stats.nextVisionDelayMs = 900;
    await promptWindow.click('[data-analysis-mode="ecommerce"]');
    await promptWindow.waitForFunction(() => document.querySelector('[data-analysis-mode="ecommerce"]')?.classList.contains('is-generating'));
    assert.equal(await promptWindow.locator('#summary-text').textContent(), dailySummary, '首次切换电商时不应清空日常结果');
    assert.equal(await promptWindow.locator('#product-category').textContent(), '护肤品');
    assert.equal(await promptWindow.locator('#mode-transition-banner').isVisible(), true);
    await promptWindow.screenshot({ path: path.join(outputDir, 'visual-mode-result-preserved-during-switch.png') });
    await promptWindow.waitForFunction(() => (
      document.querySelector('[data-analysis-mode="ecommerce"]')?.classList.contains('is-active')
      && !document.querySelector('[data-analysis-mode="ecommerce"]')?.disabled
      && document.querySelector('#product-category')?.textContent === '护肤品'
      && document.querySelector('#window-status')?.classList.contains('is-ready')
    ));
    const ecommerceSummary = await promptWindow.locator('#summary-text').textContent();
    assert.match(ecommerceSummary, /电商模式/);
    assert.equal(mockAi.stats.vision, visionBeforeEcommerce + 1);
    const visionAfterEcommerce = mockAi.stats.vision;
    await promptWindow.click('[data-analysis-mode="daily"]');
    await promptWindow.waitForFunction(() => document.querySelector('#summary-text')?.textContent.includes('日常模式'));
    assert.equal(await promptWindow.locator('#summary-text').textContent(), dailySummary);
    assert.equal(await promptWindow.locator('#generated-image').getAttribute('src') !== null, true, '日常模式的参考生成结果应随缓存恢复');
    assert.equal(mockAi.stats.vision, visionAfterEcommerce, '返回日常缓存不应重复调用视觉模型');
    await promptWindow.click('[data-analysis-mode="ecommerce"]');
    await promptWindow.waitForFunction(() => document.querySelector('#summary-text')?.textContent.includes('电商模式'));
    assert.equal(await promptWindow.locator('#summary-text').textContent(), ecommerceSummary);
    assert.equal(mockAi.stats.vision, visionAfterEcommerce, '返回电商缓存不应重复调用视觉模型');
    assert.equal(await promptWindow.locator('#grid-tab').isVisible(), true);
    await promptWindow.click('#grid-tab');
    assert.equal(await promptWindow.locator('[data-tab-panel="grid"]').evaluate((element) => element.classList.contains('is-active')), true);
    assert.match(await promptWindow.locator('.grid-hero-copy h2').textContent(), /完整九宫格/);
    await promptWindow.screenshot({ path: path.join(outputDir, 'ecommerce-grid-settings.png') });
    await promptWindow.check('#grid-rights-checkbox');
    await promptWindow.click('#generate-grid');
    await promptWindow.waitForFunction(() => !document.querySelector('#grid-generation-working')?.hidden);
    await promptWindow.waitForFunction(() => document.querySelector('#grid-generated-image')?.naturalWidth > 0);
    assert.equal(await promptWindow.locator('#grid-generated-actions').isVisible(), true);
    assert.equal(await promptWindow.locator('#grid-generation-error').isHidden(), true);
    assert.equal(mockAi.stats.gridPromptReceived, true);
    assert.equal(mockAi.stats.generation, 2, '九宫格应只新增一次图像生成请求');
    await promptWindow.click('#zoom-grid-image');
    assert.equal(await promptWindow.locator('#image-lightbox').isVisible(), true);
    await promptWindow.click('#lightbox-close');
    await promptWindow.click('#copy-grid-generated');
    const gridClipboardReady = await electronApp.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty());
    assert.equal(gridClipboardReady, true);
    await promptWindow.screenshot({ path: path.join(outputDir, 'ecommerce-grid-result.png') });
    await promptWindow.click('[data-analysis-mode="drama"]');
    await promptWindow.waitForFunction(() => (
      document.querySelector('[data-analysis-mode="drama"]')?.classList.contains('is-active')
      && !document.querySelector('[data-analysis-mode="drama"]')?.disabled
      && document.querySelector('#window-status')?.classList.contains('is-ready')
    ));
    const dramaSummary = await promptWindow.locator('#summary-text').textContent();
    assert.match(dramaSummary, /短剧模式/);
    assert.equal(await promptWindow.locator('#grid-tab').isHidden(), true);
    assert.equal(await promptWindow.locator('#subject-card-title').textContent(), '人物、关系与场景');
    assert.equal(await promptWindow.locator('#scene-type').textContent(), '短剧镜头');
    assert.match(await promptWindow.locator('#product-subject').textContent(), /少女|和服|木质/);
    await promptWindow.click('[data-tab="prompts"]');
    const dramaPromptValues = await promptWindow.locator('#prompt-model option').evaluateAll((options) => options.map((option) => option.value));
    assert.deepEqual(dramaPromptValues, ['firstFrameZh', 'keyframeZh', 'storyboardZh', 'firstFrameEn', 'imageToVideo', 'characterContinuity']);
    assert.match(await promptWindow.locator('#prompt-text').inputValue(), /短剧首帧|少女|和服/);
    assert.match(await promptWindow.locator('#negative-description').textContent(), /身份漂移|动作跳变|翻轴/);
    assert.deepEqual(
      await promptWindow.locator('#strategy-control button').evaluateAll((buttons) => buttons.map((button) => ({ value: button.dataset.strategy, text: button.textContent.trim() }))),
      [
        { value: 'character', text: '保持角色锁定脸、发型与服装' },
        { value: 'shot', text: '保持镜头景别、站位与画面轴线' },
        { value: 'continuity', text: '延续剧情承接动作、情绪与空间' },
      ],
    );
    const dramaPromptPanelText = await promptWindow.locator('[data-tab-panel="prompts"]').textContent();
    assert.doesNotMatch(dramaPromptPanelText, /商品名|商品展示|电商主图|保持商品|商品图瑕疵|商业电商/);
    await promptWindow.selectOption('#prompt-model', 'imageToVideo');
    assert.match(await promptWindow.locator('#prompt-text').inputValue(), /首帧|转头|推近/);
    await promptWindow.click('[data-tab="analysis"]');
    const visionAfterDrama = mockAi.stats.vision;
    await promptWindow.click('[data-analysis-mode="daily"]');
    await promptWindow.waitForFunction(() => document.querySelector('#summary-text')?.textContent.includes('日常模式'));
    assert.equal(mockAi.stats.vision, visionAfterDrama, '短剧返回日常时不应重新分析');
    await promptWindow.click('[data-analysis-mode="drama"]');
    await promptWindow.waitForFunction(() => document.querySelector('#summary-text')?.textContent.includes('短剧模式'));
    assert.equal(await promptWindow.locator('#summary-text').textContent(), dramaSummary);
    assert.equal(mockAi.stats.vision, visionAfterDrama, '再次进入短剧模式应直接恢复缓存');
    await promptWindow.click('[data-analysis-mode="daily"]');
    await promptWindow.waitForFunction(() => document.querySelector('#summary-text')?.textContent.includes('日常模式'));
    assert.equal(await promptWindow.locator('#regenerate-mode').isEnabled(), true);
    mockAi.stats.nextVisionDelayMs = 650;
    await promptWindow.click('#regenerate-mode');
    await promptWindow.waitForFunction(() => document.querySelector('#product-category')?.textContent === '等待分析');
    assert.equal(await promptWindow.locator('#regenerate-mode').isDisabled(), true);
    await promptWindow.waitForFunction(() => document.querySelector('#window-status')?.classList.contains('is-ready'));
    assert.match(await promptWindow.locator('#summary-text').textContent(), /日常模式/);
    assert.equal(mockAi.stats.vision, visionAfterDrama + 1, '清除重生应只重新请求当前模式');
    const promptHistoryAudit = await page.evaluate(async (id) => {
      const bootstrap = await window.luvoelle.bootstrap();
      const item = bootstrap.history.find((candidate) => candidate.id === id);
      return {
        exists: Boolean(item),
        mode: item?.mode,
        hasPromptData: Boolean(item?.promptData?.prompts?.universalZh),
        containsImageData: JSON.stringify(item || {}).includes('data:image/'),
      };
    }, promptResult.id);
    assert.deepEqual(promptHistoryAudit, { exists: true, mode: 'prompt', hasPromptData: true, containsImageData: false });
    await promptWindow.keyboard.press('Escape');
    await waitForBrowserWindowVisibility(electronApp, 'prompt.html', false);
    await page.evaluate((id) => window.luvoelle.openPromptHistory(id), promptResult.id);
    await waitForBrowserWindowVisibility(electronApp, 'prompt.html', true);
    await promptWindow.waitForFunction(() => document.querySelector('#summary-text')?.textContent.includes('护肤瓶'));
    assert.equal(await promptWindow.locator('#generate-image').isDisabled(), true);
    await promptWindow.click('#pin-window');
    await promptWindow.keyboard.press('Escape');
    await waitForBrowserWindowVisibility(electronApp, 'prompt.html', true);
    await promptWindow.click('#close-window');
    await waitForBrowserWindowVisibility(electronApp, 'prompt.html', false);
    assert.equal(await promptWindow.locator('#pin-window').getAttribute('aria-pressed'), 'false');
    assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/prompt.html'))?.isAlwaysOnTop()), false);

    await page.evaluate((dataUrl) => {
      window.__aiOcrJob = window.luvoelle.processImage({ dataUrl, mode: 'ocr' });
    }, sampleImage);
    await page.waitForFunction(() => document.querySelector('#result-title')?.textContent.includes('GPT 校正中') && document.querySelector('#source-text')?.textContent.includes('HELLO'));
    await page.click('#source-text');
    assert.equal(await page.locator('#source-text').getAttribute('contenteditable'), 'false');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((item) => item.textContent.includes('GPT 校正完成后即可修改原文')));
    await page.screenshot({ path: path.join(outputDir, 'ai-ocr-local-preview.png') });
    const result = await page.evaluate(() => window.__aiOcrJob);
    assert.match(result.ocr.text, /HELLO|WORLD/i);
    assert.equal(result.ocr.enhanced, true);
    assert.match(result.ocr.provider, /GPT 精确 OCR/);
    assert.doesNotMatch(await page.locator('#result-meta').textContent(), /PP-OCRv6|原生 CPU/);
    assert.equal(mockAi.stats.ocrDetail, 'original');
    await page.waitForSelector('#result-panel.is-complete');
    await page.screenshot({ path: path.join(outputDir, 'ocr-result.png') });

    await page.click('#source-text');
    await page.locator('#source-text').fill('HELLO CORRECTED 2026');
    await page.click('#edit-source-text');
    await page.waitForFunction(() => document.querySelector('#source-text')?.textContent.trim() === 'HELLO CORRECTED 2026' && document.querySelector('#edit-source-text')?.hidden);
    const correctedBootstrap = await page.evaluate(() => window.luvoelle.bootstrap());
    assert.equal(correctedBootstrap.history[0].sourceText, 'HELLO CORRECTED 2026');
    assert.equal(correctedBootstrap.history[0].corrected, true);

    const translationJob = await page.evaluate(() => window.luvoelle.translateText({ text: 'Hello world', targetLanguage: 'zh-CN' }));
    assert.ok(translationJob.translation.text.length > 0);
    assert.notEqual(translationJob.translation.text.toLowerCase(), 'hello world');
    assert.equal(translationJob.translation.route, 'openai');

    await page.evaluate(({ endpoint }) => window.luvoelle.saveSettings({
      provider: 'deepseek',
      endpoint,
      model: 'deepseek-v4-flash',
      apiKey: 'test-deepseek-key',
    }), { endpoint: mockAi.endpoint });
    const deepseekTranslationJob = await page.evaluate(() => window.luvoelle.translateText({ text: 'DeepSeek translation', targetLanguage: 'zh-CN' }));
    assert.equal(deepseekTranslationJob.translation.route, 'deepseek');
    assert.equal(deepseekTranslationJob.translation.provider, 'DeepSeek · deepseek-v4-flash');
    assert.deepEqual(mockAi.stats.deepseekTranslationBody.thinking, { type: 'disabled' });
    assert.ok(mockAi.stats.deepseekTranslationBody.max_tokens >= 256);
    const deepseekSettings = await page.evaluate(() => window.luvoelle.bootstrap().then((value) => value.settings));
    assert.equal(deepseekSettings.hasDeepSeekApiKey, true);

    await page.evaluate(({ endpoint }) => window.luvoelle.saveSettings({
      provider: 'cun',
      endpoint,
      model: 'mock-translator',
    }), { endpoint: mockAi.endpoint });
    const cunTranslationJob = await page.evaluate(() => window.luvoelle.translateText({ text: 'CUN compatible translation', targetLanguage: 'zh-CN' }));
    assert.equal(cunTranslationJob.translation.route, 'cun');
    assert.match(cunTranslationJob.translation.provider, /^CUN\.AI · mock-translator$/);

    await page.evaluate(() => window.luvoelle.saveSettings({ provider: 'auto' }));
    const autoTranslationJob = await page.evaluate(() => window.luvoelle.translateText({ text: '第一行商品说明\n第二行材质信息\n第三行使用方式\n第四行注意事项', targetLanguage: 'en' }));
    assert.equal(autoTranslationJob.translation.route, 'openai');
    assert.equal(autoTranslationJob.translation.automatic, true);
    assert.match(autoTranslationJob.translation.provider, /自动选择/);
    await page.evaluate(() => window.luvoelle.saveSettings({ provider: 'openai', ocrMode: 'local' }));

    const chineseSampleImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 260;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#111111';
      context.font = '700 72px Microsoft YaHei';
      context.textBaseline = 'middle';
      context.fillText('这是中文识别测试', 100, 130);
      return canvas.toDataURL('image/png');
    });
    await page.evaluate((dataUrl) => window.luvoelle.submitCapture({ dataUrl, mode: 'translate' }), chineseSampleImage);
    const floatWindow = await waitForWindowByFile(electronApp, 'float.html');
    await floatWindow.waitForFunction(() => document.querySelector('#mode-label')?.textContent === '中文取字' && document.querySelector('#float-source')?.textContent.includes('中文'), null, { timeout: 60000 });
    await floatWindow.waitForFunction(() => document.querySelector('.float-mark img')?.naturalWidth > 0);
    assert.equal(await floatWindow.locator('.float-mark img[src$="assets/icon.svg"]').count(), 1);
    const floatCornerStyle = await floatWindow.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body);
      const shellStyle = getComputedStyle(document.querySelector('.float-shell'));
      return {
        bodyPadding: bodyStyle.padding,
        bodyBackground: bodyStyle.backgroundColor,
        bodyClipPath: bodyStyle.clipPath,
        shellRadius: shellStyle.borderRadius,
      };
    });
    assert.equal(floatCornerStyle.bodyPadding, '0px');
    assert.equal(floatCornerStyle.bodyBackground, 'rgba(0, 0, 0, 0)');
    assert.match(floatCornerStyle.bodyClipPath, /24px/);
    assert.equal(floatCornerStyle.shellRadius, '24px');
    await floatWindow.waitForSelector('.float-shell.complete');
    assert.equal(await floatWindow.locator('#float-translation-pane').isHidden(), true);
    const compactFloatHeight = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/float.html'));
      return win?.getBounds().height || 0;
    });
    assert.ok(compactFloatHeight > 0 && compactFloatHeight <= 540, `Chinese result float height was ${compactFloatHeight}`);
    await floatWindow.screenshot({ path: path.join(outputDir, 'chinese-compact-float.png') });
    await floatWindow.keyboard.press('Escape');
    await waitForBrowserWindowVisibility(electronApp, 'float.html', false);

    const screenshotSubmitResult = await page.evaluate((dataUrl) => window.luvoelle.submitCapture({ dataUrl, mode: 'translate' }), sampleImage);
    const copiedScreenshot = await page.evaluate(() => window.luvoelle.getClipboardImage());
    const clipboardWriteConfirmed = Boolean(copiedScreenshot?.startsWith('data:image/'));
    assert.equal(screenshotSubmitResult.imageCopied, clipboardWriteConfirmed, 'Capture result did not reflect the actual clipboard state');
    await floatWindow.waitForSelector('.float-shell');
    await floatWindow.waitForFunction(() => document.querySelector('#mode-label')?.textContent === '截图翻译' && document.querySelector('#float-source')?.textContent.includes('HELLO'), null, { timeout: 60000 });
    await floatWindow.waitForFunction(() => !document.querySelector('#float-translation')?.classList.contains('loading'), null, { timeout: 60000 });
    assert.equal(await floatWindow.locator('#translation-model').textContent(), 'mock-translator');
    assert.equal(await floatWindow.locator('#translation-model').isVisible(), true);
    assert.doesNotMatch(await floatWindow.locator('#float-meta').textContent(), /mock-translator/);
    assert.doesNotMatch(await floatWindow.locator('#float-meta').textContent(), /PP-OCRv6|本地 OCR|原生 CPU/);
    assert.match(await floatWindow.locator('#float-meta').textContent(), /识别置信度/);
    assert.equal(await floatWindow.locator('#resize-float').isVisible(), true);
    const readFloatWindowState = () => electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/float.html'));
      return { bounds: win?.getBounds(), maximized: Boolean(win?.isMaximized()) };
    });
    const normalFloatState = await readFloatWindowState();
    await floatWindow.click('#resize-float');
    await floatWindow.waitForFunction(() => document.getElementById('resize-float')?.getAttribute('aria-label') === '最大化窗口');
    await floatWindow.waitForTimeout(320);
    const moderateFloatState = await readFloatWindowState();
    assert.equal(moderateFloatState.maximized, false);
    assert.ok(moderateFloatState.bounds.width > normalFloatState.bounds.width + 120, 'Moderate reading width did not expand');
    assert.ok(moderateFloatState.bounds.height > normalFloatState.bounds.height + 30, 'Moderate reading height did not expand');
    await floatWindow.screenshot({ path: path.join(outputDir, 'result-float-moderate.png') });
    await floatWindow.click('#resize-float');
    await floatWindow.waitForFunction(() => document.getElementById('resize-float')?.getAttribute('aria-label') === '恢复适度大小');
    await floatWindow.waitForTimeout(320);
    const maximizedFloatState = await readFloatWindowState();
    assert.equal(maximizedFloatState.maximized, true);
    assert.equal(await floatWindow.locator('body').evaluate((element) => element.classList.contains('window-maximized')), true);
    await floatWindow.click('#resize-float');
    await floatWindow.waitForFunction(() => document.getElementById('resize-float')?.getAttribute('aria-label') === '最大化窗口');
    await floatWindow.waitForTimeout(320);
    const restoredModerateFloatState = await readFloatWindowState();
    assert.equal(restoredModerateFloatState.maximized, false);
    assert.ok(Math.abs(restoredModerateFloatState.bounds.width - moderateFloatState.bounds.width) <= 2);
    assert.ok(Math.abs(restoredModerateFloatState.bounds.height - moderateFloatState.bounds.height) <= 2);
    assert.equal(await floatWindow.locator('#clipboard-status > span').textContent(), '截图已复制');
    await floatWindow.click('[data-copy="float-source"]');
    await floatWindow.waitForFunction(() => document.querySelector('#clipboard-status > span')?.textContent === '原文已复制');
    assert.match(await electronApp.evaluate(({ clipboard }) => clipboard.readText()), /HELLO WORLD/i);
    await floatWindow.click('[data-copy="float-translation"]');
    await floatWindow.waitForFunction(() => document.querySelector('#clipboard-status > span')?.textContent === '译文已复制');
    assert.ok((await electronApp.evaluate(({ clipboard }) => clipboard.readText())).trim().length > 0);
    await floatWindow.click('#copy-image-footer');
    await floatWindow.waitForFunction(() => document.querySelector('#clipboard-status > span')?.textContent === '截图已复制');
    assert.ok((await page.evaluate(() => window.luvoelle.getClipboardImage()))?.startsWith('data:image/'));
    assert.equal(await floatWindow.locator('#copy-result').count(), 0);
    assert.equal(await floatWindow.locator('#retry-translation').isHidden(), true);
    const expandedPaneLayout = await floatWindow.evaluate(() => ({
      sourceHeight: document.querySelector('.source-pane').getBoundingClientRect().height,
      translationHeight: document.querySelector('.translation-pane').getBoundingClientRect().height,
    }));
    await floatWindow.locator('.translation-pane > header').click({ position: { x: 110, y: 15 } });
    await floatWindow.waitForTimeout(260);
    const sourceExpandedLayout = await floatWindow.evaluate(() => ({
      sourceHeight: document.querySelector('.source-pane').getBoundingClientRect().height,
      translationCollapsed: document.querySelector('.translation-pane').classList.contains('is-collapsed'),
      translationAriaExpanded: document.getElementById('collapse-translation').getAttribute('aria-expanded'),
    }));
    assert.equal(sourceExpandedLayout.translationCollapsed, true);
    assert.equal(sourceExpandedLayout.translationAriaExpanded, 'false');
    assert.equal(await floatWindow.locator('#translation-model').isVisible(), true);
    assert.ok(sourceExpandedLayout.sourceHeight > expandedPaneLayout.sourceHeight + 80, 'Source pane did not expand after collapsing translation');
    await floatWindow.screenshot({ path: path.join(outputDir, 'result-float-source-expanded.png') });
    await floatWindow.locator('.source-pane > header').click({ position: { x: 110, y: 15 } });
    await floatWindow.waitForTimeout(260);
    const translationExpandedLayout = await floatWindow.evaluate(() => ({
      sourceCollapsed: document.querySelector('.source-pane').classList.contains('is-collapsed'),
      translationCollapsed: document.querySelector('.translation-pane').classList.contains('is-collapsed'),
      translationHeight: document.querySelector('.translation-pane').getBoundingClientRect().height,
    }));
    assert.equal(translationExpandedLayout.sourceCollapsed, true);
    assert.equal(translationExpandedLayout.translationCollapsed, false);
    assert.ok(translationExpandedLayout.translationHeight > expandedPaneLayout.translationHeight + 80, 'Translation pane did not expand after collapsing source');
    await floatWindow.locator('.source-pane > header').click({ position: { x: 110, y: 15 } });
    await floatWindow.waitForTimeout(260);
    await floatWindow.click('#edit-image');
    const editorWindow = await waitForWindowByFile(electronApp, 'editor.html');
    await editorWindow.waitForFunction(() => document.getElementById('editor-canvas')?.dataset.ready === 'true');
    assert.equal(await editorWindow.locator('.editor-mark img[src$="assets/icon.svg"]').count(), 1, 'Editor still uses the legacy mark');
    assert.equal(await editorWindow.locator('.tool-button[data-tool]').count(), 7);
    const editorCanvas = editorWindow.locator('#editor-canvas');
    const editorBefore = await editorCanvas.evaluate((element) => element.toDataURL('image/png'));
    const canvasBox = await editorCanvas.boundingBox();
    assert.ok(canvasBox && canvasBox.width > 100 && canvasBox.height > 80, 'Editor canvas was not visible');
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.16, canvasBox.y + canvasBox.height * 0.18);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.42, canvasBox.y + canvasBox.height * 0.72, { steps: 8 });
    await editorWindow.mouse.up();
    assert.equal(await editorCanvas.getAttribute('data-selected-vector-stroke'), '5');
    assert.equal(await editorCanvas.getAttribute('data-selection-guide'), '');
    await editorWindow.locator('#stroke-width').evaluate((element) => {
      element.value = '9';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await editorCanvas.getAttribute('data-selected-vector-stroke'), '9');
    await editorWindow.click('.tool-button[data-tool="ellipse"]');
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.05, canvasBox.y + canvasBox.height * 0.55);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.16, canvasBox.y + canvasBox.height * 0.86, { steps: 7 });
    await editorWindow.mouse.up();
    assert.equal(await editorCanvas.getAttribute('data-selection-guide'), '');
    await editorWindow.locator('#stroke-width').evaluate((element) => {
      element.value = '7';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await editorCanvas.getAttribute('data-selected-vector-stroke'), '7');
    await editorWindow.click('.tool-button[data-tool="arrow"]');
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.42, canvasBox.y + canvasBox.height * 0.18);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.54, canvasBox.y + canvasBox.height * 0.43, { steps: 7 });
    await editorWindow.mouse.up();
    assert.equal(await editorCanvas.getAttribute('data-selection-guide'), '');
    await editorWindow.locator('#stroke-width').evaluate((element) => {
      element.value = '12';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await editorCanvas.getAttribute('data-selected-vector-stroke'), '12');
    await editorWindow.screenshot({ path: path.join(outputDir, 'image-editor-vector-line-width.png') });
    await editorWindow.click('.tool-button[data-tool="mosaic"]');
    assert.equal(await editorWindow.locator('[data-mosaic-mode="square"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await editorWindow.locator('[data-mosaic-mode]').count(), 3);
    assert.equal(await editorWindow.locator('.mosaic-brush-option').isHidden(), true);
    await editorWindow.locator('#mosaic-pixel').evaluate((element) => {
      element.value = '28';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.56, canvasBox.y + canvasBox.height * 0.32);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.82, canvasBox.y + canvasBox.height * 0.6, { steps: 10 });
    await editorWindow.mouse.up();
    assert.equal(await editorCanvas.getAttribute('data-selection-guide'), 'square');
    await editorWindow.locator('#mosaic-pixel').evaluate((element) => {
      element.value = '36';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await editorCanvas.getAttribute('data-selected-mosaic-blur'), '36');
    assert.equal(await editorWindow.locator('#mosaic-pixel-value').textContent(), '36');
    assert.equal(await editorCanvas.getAttribute('data-mosaic-effect'), 'frosted-glass');
    const mosaicCanvasSize = await editorCanvas.evaluate((element) => ({ width: element.width, height: element.height }));
    const squareRectBeforeResize = (await editorCanvas.getAttribute('data-selected-mosaic-rect')).split(',').map(Number);
    const squareSouthEast = {
      x: canvasBox.x + (squareRectBeforeResize[0] + squareRectBeforeResize[2]) * canvasBox.width / mosaicCanvasSize.width,
      y: canvasBox.y + (squareRectBeforeResize[1] + squareRectBeforeResize[3]) * canvasBox.height / mosaicCanvasSize.height,
    };
    await editorWindow.mouse.move(squareSouthEast.x, squareSouthEast.y);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(squareSouthEast.x + 38, squareSouthEast.y + 26, { steps: 5 });
    await editorWindow.mouse.up();
    const squareRectAfterResize = (await editorCanvas.getAttribute('data-selected-mosaic-rect')).split(',').map(Number);
    assert.ok(squareRectAfterResize[2] > squareRectBeforeResize[2] && squareRectAfterResize[3] > squareRectBeforeResize[3], 'Completed square mosaic could not be resized');
    const squareCenter = {
      x: canvasBox.x + (squareRectAfterResize[0] + squareRectAfterResize[2] / 2) * canvasBox.width / mosaicCanvasSize.width,
      y: canvasBox.y + (squareRectAfterResize[1] + squareRectAfterResize[3] / 2) * canvasBox.height / mosaicCanvasSize.height,
    };
    await editorWindow.mouse.move(squareCenter.x, squareCenter.y);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(squareCenter.x - 24, squareCenter.y + 18, { steps: 5 });
    await editorWindow.mouse.up();
    const squareRectAfterMove = (await editorCanvas.getAttribute('data-selected-mosaic-rect')).split(',').map(Number);
    assert.ok(squareRectAfterMove[0] < squareRectAfterResize[0] && squareRectAfterMove[1] > squareRectAfterResize[1], 'Completed square mosaic could not be moved');
    assert.equal(await editorCanvas.getAttribute('data-selected-mosaic-blur'), '36');
    await editorWindow.screenshot({ path: path.join(outputDir, 'image-editor-frosted-mosaic.png') });
    await editorWindow.click('[data-mosaic-mode="circle"]');
    assert.equal(await editorWindow.locator('[data-mosaic-mode="circle"]').getAttribute('aria-pressed'), 'true');
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.46, canvasBox.y + canvasBox.height * 0.68);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.54, canvasBox.y + canvasBox.height * 0.78, { steps: 5 });
    await editorWindow.mouse.up();
    assert.equal(await editorCanvas.getAttribute('data-selection-guide'), 'circle');
    await editorWindow.click('[data-mosaic-mode="brush"]');
    assert.equal(await editorWindow.locator('[data-mosaic-mode="brush"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await editorWindow.locator('.mosaic-brush-option').isVisible(), true);
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.25, canvasBox.y + canvasBox.height * 0.3);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.38, canvasBox.y + canvasBox.height * 0.46, { steps: 8 });
    await editorWindow.mouse.up();
    assert.equal(await editorCanvas.getAttribute('data-annotations'), '6');
    assert.equal(await editorCanvas.getAttribute('data-selection-guide'), '');
    const editorAfter = await editorCanvas.evaluate((element) => element.toDataURL('image/png'));
    assert.notEqual(editorAfter, editorBefore, 'Image editor did not change the canvas');
    await editorWindow.click('#undo-editor');
    assert.equal(await editorCanvas.getAttribute('data-annotations'), '5');
    assert.equal(await editorCanvas.getAttribute('data-selection-guide'), 'circle');
    assert.equal(await editorWindow.locator('[data-mosaic-mode="circle"]').getAttribute('aria-pressed'), 'true');
    await editorWindow.screenshot({ path: path.join(outputDir, 'image-editor.png') });
    await editorWindow.click('#copy-editor');
    await editorWindow.waitForFunction(() => document.getElementById('editor-toast')?.textContent.includes('图片已复制') || document.getElementById('editor-toast')?.textContent.includes('占用'));
    const editedImageCopied = Boolean((await page.evaluate(() => window.luvoelle.getClipboardImage()))?.startsWith('data:image/'));
    await editorWindow.click('#redo-editor');
    assert.equal(await editorCanvas.getAttribute('data-annotations'), '6');
    assert.equal(await editorWindow.locator('[data-mosaic-mode="brush"]').getAttribute('aria-pressed'), 'true');
    await editorWindow.click('.tool-button[data-tool="emoji"]');
    assert.equal(await editorWindow.locator('.emoji-option').isVisible(), true);
    assert.ok(await editorWindow.locator('[data-emoji]').count() >= 20);
    await editorWindow.click('[data-emoji="🎉"]');
    await editorWindow.mouse.click(canvasBox.x + canvasBox.width * 0.7, canvasBox.y + canvasBox.height * 0.22);
    assert.equal(await editorCanvas.getAttribute('data-annotations'), '7');
    assert.equal(await editorCanvas.getAttribute('data-selected-emoji'), '🎉');
    assert.equal(await editorCanvas.getAttribute('data-selected-emoji-size'), '72');
    await editorWindow.locator('#emoji-size').evaluate((element) => {
      element.value = '110';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await editorCanvas.getAttribute('data-selected-emoji-size'), '110');
    const emojiXBeforeDrag = Number(await editorCanvas.getAttribute('data-selected-emoji-x'));
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.7, canvasBox.y + canvasBox.height * 0.22);
    await editorWindow.mouse.down();
    await editorWindow.mouse.move(canvasBox.x + canvasBox.width * 0.82, canvasBox.y + canvasBox.height * 0.36, { steps: 8 });
    await editorWindow.mouse.up();
    const emojiXAfterDrag = Number(await editorCanvas.getAttribute('data-selected-emoji-x'));
    assert.ok(emojiXAfterDrag > emojiXBeforeDrag, 'Emoji did not move after dragging');
    await editorWindow.screenshot({ path: path.join(outputDir, 'image-editor-emoji.png') });
    await editorWindow.click('.emoji-tool-button');
    await editorWindow.keyboard.press('Delete');
    assert.equal(await editorCanvas.getAttribute('data-annotations'), '6');
    assert.equal(await editorCanvas.getAttribute('data-selected-emoji'), '');
    await editorWindow.click('#close-editor');
    await waitForBrowserWindowVisibility(electronApp, 'editor.html', false);
    await waitForBrowserWindowVisibility(electronApp, 'float.html', true);
    await floatWindow.click('#float-source');
    await floatWindow.locator('#float-source').fill('GOOD MORNING');
    await floatWindow.click('#float-edit-source');
    await floatWindow.waitForFunction(() => document.querySelector('#float-source')?.textContent.trim() === 'GOOD MORNING' && document.querySelector('#float-edit-source')?.hidden, null, { timeout: 60000 });
    assert.ok((await floatWindow.locator('#float-translation').textContent()).trim().length > 0);
    await floatWindow.waitForTimeout(250);
    await floatWindow.screenshot({ path: path.join(outputDir, 'result-float.png') });
    await floatWindow.click('#float-source');
    await floatWindow.locator('#float-source').fill('UNSAVED CHANGE');
    await floatWindow.keyboard.press('Escape');
    assert.equal(await floatWindow.locator('#float-source').textContent(), 'GOOD MORNING');
    assert.equal(await floatWindow.locator('#float-source').getAttribute('contenteditable'), 'false');
    await waitForBrowserWindowVisibility(electronApp, 'float.html', true);
    await floatWindow.keyboard.press('Escape');
    await waitForBrowserWindowVisibility(electronApp, 'float.html', false);

    await page.click('.nav-item[data-view="settings"]');
    await page.waitForSelector('#view-settings.is-active');
    assert.equal(await page.locator('#setting-assistant-enabled').isChecked(), true);
    assert.equal(await page.locator('#setting-assistant-side').inputValue(), 'right');
    assert.match(await page.locator('#assistant-settings-status').textContent(), /右侧待命/);
    await page.locator('#setting-assistant-enabled').evaluate((element) => {
      element.checked = false;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('#settings-save-bar button[type="submit"]');
    await waitForBrowserWindowVisibility(electronApp, 'assistant.html', false);
    assert.equal(await page.locator('#restore-assistant').textContent(), '显示萌宠');
    await page.selectOption('#setting-assistant-side', 'left');
    await page.click('#restore-assistant');
    await waitForBrowserWindowVisibility(electronApp, 'assistant.html', true);
    await assistantWindow.waitForFunction(() => !document.body.classList.contains('is-expanded'));
    const restoredAssistantState = await electronApp.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/assistant.html'));
      const bounds = win?.getBounds();
      const area = bounds ? screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) }).workArea : null;
      return { bounds, area, visible: win?.isVisible(), focusable: win?.isFocusable() };
    });
    assert.equal(restoredAssistantState.visible, true);
    assert.equal(restoredAssistantState.focusable, true);
    assert.equal(restoredAssistantState.bounds.width, 92);
    assert.ok(restoredAssistantState.bounds.x <= restoredAssistantState.area.x + 8, 'Restored pet was not attached to the left edge');
    assert.equal(await page.locator('#setting-assistant-enabled').isChecked(), true);
    assert.equal(await page.locator('#setting-assistant-side').inputValue(), 'left');
    await page.selectOption('#setting-assistant-side', 'right');
    await page.click('#restore-assistant');
    assert.equal(await page.locator('#setting-assistant-side').inputValue(), 'right');
    await page.fill('#setting-vision-endpoint', mockAi.endpoint);
    await page.fill('#setting-vision-model', '');
    await page.click('#test-vision-service');
    await page.waitForFunction(() => document.querySelector('#vision-configured-model')?.textContent === '服务已连接 · 请选择视觉模型');
    assert.equal(await page.locator('#vision-model-options option').count(), 2);
    await page.fill('#setting-vision-model', 'mock-ui-saved-vision');
    await page.waitForFunction(() => !document.querySelector('#settings-save-bar button[type="submit"]')?.disabled && document.querySelector('#settings-note')?.textContent === '有未保存的更改');
    assert.equal(await page.locator('#test-vision-service').textContent(), '检测并保存');
    await page.click('#test-vision-service');
    await page.waitForFunction(() => document.querySelector('#vision-configured-model')?.textContent === '已保存模型 · mock-ui-saved-vision');
    assert.match(await page.locator('#vision-service-status').textContent(), /模型目录未列出当前名称/);
    assert.equal(await page.locator('#vision-detected-models-summary').textContent(), '查看服务返回的模型（2）');
    assert.match(await page.locator('#vision-detected-models-list').textContent(), /mock-qwen3-vl/);
    assert.equal(await page.locator('#vision-model-options option').count(), 2);
    const savedVisionSettings = await page.evaluate(() => window.luvoelle.bootstrap().then((value) => ({ endpoint: value.settings.visionEndpoint, model: value.settings.visionModel })));
    assert.deepEqual(savedVisionSettings, { endpoint: mockAi.endpoint, model: 'mock-ui-saved-vision' });
    assert.equal(await page.locator('#setting-provider option').count(), 5);
    assert.equal(await page.locator('#setting-vision-provider option[value="cun"]').textContent(), 'CUN.AI');
    assert.equal(await page.locator('#setting-ocr-mode option').count(), 3);
    await page.selectOption('#setting-vision-provider', 'cun');
    assert.equal(await page.locator('#setting-vision-endpoint').inputValue(), 'https://www.cun.ai/v1');
    assert.equal(await page.locator('#vision-model-options option').count(), 6);
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini']) {
      assert.equal(await page.locator(`#vision-model-options option[value="${model}"]`).count(), 1);
    }
    assert.equal(await page.locator('#vision-cun-models').isVisible(), true);
    assert.equal(await page.locator('#vision-cun-models button').count(), 4);
    await page.click('#vision-cun-models button[data-cun-model="gpt-5.6-terra"]');
    assert.equal(await page.locator('#setting-vision-model').inputValue(), 'gpt-5.6-terra');
    assert.equal(await page.locator('#cun-vision-help').isVisible(), true);
    assert.equal(await page.locator('#local-vision-help').isHidden(), true);
    assert.equal(await page.locator('#reuse-vision-translation').textContent(), '复用并切换到 CUN.AI');
    await page.screenshot({ path: path.join(outputDir, 'cun-api-settings.png') });
    await page.selectOption('#setting-vision-provider', 'local');
    await page.fill('#setting-vision-endpoint', mockAi.endpoint);
    await page.fill('#setting-vision-model', 'mock-ui-saved-vision');
    await page.selectOption('#setting-provider', 'cun');
    assert.equal(await page.locator('#translation-model-options option').count(), 4);
    assert.equal(await page.locator('#translation-cun-models').isVisible(), true);
    assert.equal(await page.locator('#translation-model-options option[value="gpt-5.6-sol"]').count(), 1);
    assert.equal(await page.locator('#translation-model-options option[value="gpt-5.4-mini"]').count(), 1);
    await page.click('#translation-cun-models button[data-cun-model="gpt-5.4-mini"]');
    assert.equal(await page.locator('#setting-model').inputValue(), 'gpt-5.4-mini');
    await page.selectOption('#setting-provider', 'deepseek');
    assert.equal(await page.locator('#setting-endpoint').inputValue(), 'https://api.deepseek.com');
    assert.equal(await page.locator('#setting-model').inputValue(), 'deepseek-v4-flash');
    assert.equal(await page.locator('#translation-model-options option[value="deepseek-v4-flash"]').count(), 1);
    assert.equal(await page.locator('#deepseek-translation-help').isVisible(), true);
    assert.match(await page.locator('#translation-provider-note').textContent(), /关闭思考/);
    await page.selectOption('#setting-provider', 'auto');
    await page.selectOption('#setting-ocr-mode', 'auto');
    assert.match(await page.locator('#translation-provider-note').textContent(), /110 字以上/);
    assert.match(await page.locator('#translation-routing-note').textContent(), /110 字/);
    assert.match(await page.locator('#translation-routing-note').textContent(), /60 字/);
    assert.match(await page.locator('#ocr-mode-note').textContent(), /低于 82%/);
    assert.doesNotMatch(await page.locator('#ocr-mode-note').textContent(), /PP-OCRv6|原生 CPU/);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(outputDir, 'hybrid-routing-settings.png') });
    await page.click('#reuse-vision-translation');
    await page.waitForFunction(() => document.querySelector('#setting-model')?.value === 'mock-ui-saved-vision' && document.querySelector('#setting-provider')?.value === 'openai' && document.querySelector('#setting-ocr-mode')?.value === 'auto');
    const reusedTranslationSettings = await page.evaluate(() => window.luvoelle.bootstrap().then((value) => ({ endpoint: value.settings.endpoint, model: value.settings.model, hasApiKey: value.settings.hasApiKey, ocrMode: value.settings.ocrMode })));
    assert.deepEqual(reusedTranslationSettings, { endpoint: mockAi.endpoint, model: 'mock-ui-saved-vision', hasApiKey: true, ocrMode: 'auto' });
    assert.equal(await page.locator('#settings-save-bar button[type="submit"]').isDisabled(), true);
    assert.equal(await page.locator('[data-shortcut-input]').count(), 6);
    const quickShortcutButton = page.locator('[data-shortcut-input="quickEdit"]');
    assert.equal(await quickShortcutButton.textContent(), 'F1');
    assert.equal(await page.locator('[data-shortcut-row="quickEdit"]').evaluate((row) => row.classList.contains('is-unavailable')), !initialF1Registered);
    await quickShortcutButton.click();
    await page.waitForSelector('[data-shortcut-input="quickEdit"].is-recording');
    assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F1')), false, 'Global shortcuts stayed active while recording');
    await quickShortcutButton.press('Control+Shift+F12');
    await page.waitForFunction(() => document.querySelector('[data-shortcut-input="quickEdit"]')?.textContent === 'Ctrl + Shift + F12');
    assert.equal(await page.locator('[data-shortcut-row="quickEdit"] .shortcut-status').textContent(), '待保存');
    assert.equal(await page.locator('#settings-save-bar button[type="submit"]').isEnabled(), true);
    await page.click('#settings-save-bar button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-shortcut-row="quickEdit"] .shortcut-status')?.textContent === '已生效');
    const customShortcutState = await page.evaluate(() => window.luvoelle.bootstrap().then((value) => value.shortcuts.quickEdit));
    assert.equal(customShortcutState, 'Ctrl+Shift+F12');
    assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Shift+F12') && !globalShortcut.isRegistered('F1')), true);
    await page.click('#reset-shortcuts');
    await page.click('#settings-save-bar button[type="submit"]');
    if (initialF1Registered) {
      await page.waitForFunction(() => document.querySelector('[data-shortcut-input="quickEdit"]')?.textContent === 'F1' && document.querySelector('[data-shortcut-row="quickEdit"] .shortcut-status')?.textContent === '已生效');
      assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F1') && !globalShortcut.isRegistered('Ctrl+Shift+F12')), true);
    } else {
      await page.waitForFunction(() => document.querySelector('#shortcut-settings-note')?.classList.contains('is-error'));
      assert.equal(await page.evaluate(() => window.luvoelle.bootstrap().then((value) => value.shortcuts.quickEdit)), 'Ctrl+Shift+F12', 'Occupied-default rollback did not preserve the last working shortcut');
      assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Shift+F12') && !globalShortcut.isRegistered('F1')), true);
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outputDir, 'settings.png') });

    const report = {
      title: await page.title(),
      actionCards: await page.locator('.action-card').count(),
      trayIcon,
      ocrText: result.ocr.text.trim(),
      confidence: result.ocr.confidence,
      hybridOcrModes: ['local', 'auto', 'ai'],
      aiOcrUsedOriginalDetail: mockAi.stats.ocrDetail === 'original',
      localOcrPreviewBeforeAi: true,
      correctedText: correctedBootstrap.history[0].sourceText,
      translation: translationJob.translation.text,
      translationModes: ['google', 'deepseek', 'openai', 'cun', 'auto'],
      deepseekTranslation: { model: 'deepseek-v4-flash', thinking: mockAi.stats.deepseekTranslationBody.thinking.type },
      cunApiPreset: 'https://www.cun.ai/v1',
      cunModelPresets: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini'],
      manualImageTranslation: { clipboardPaste: true, editableOcrText: true, staysInTextView: true },
      desktopPetTranslator: { edgePeek: true, hoverReveal: true, alwaysOnTop: true, bidirectionalEditing: true, imageOcrBothSides: true, hiddenDuringCapture: true, closeReturnsToEdge: true, workbenchSettings: true, restoreAction: true },
      workbenchVisibility: { trayOrExplicitActionOnly: true, hiddenAfterCaptureCancel: true, hiddenAfterCaptureComplete: true },
      vietnameseTranslationTarget: true,
      thaiTranslationTarget: true,
      automaticContextTranslation: autoTranslationJob.translation.route,
      reusedVisionCredentialsForTranslation: reusedTranslationSettings.hasApiKey,
      correctedFloatText: await floatWindow.locator('#float-source').textContent().catch(() => 'GOOD MORNING'),
      chineseTranslationSkipped: true,
      compactFloatHeight,
      overlayVisibleLatencyMs,
      captureEntryLatencyMs,
      prefreezeLatencyMs,
      sourceCaptureBackends,
      screenFrozenLatencyMs,
      idleCaptureLatenciesMs,
      fastEditVisibleLatencyMs,
      fastEditEntryLatencyMs: fastEditEntry.latency,
      escapeCanceledCapture: true,
      escapeClosedResultFloat: true,
      escapeCanceledResultEditFirst: true,
      collapsibleResultPanes: true,
      sourceExpandedHeight: Math.round(sourceExpandedLayout.sourceHeight),
      translationExpandedHeight: Math.round(translationExpandedLayout.translationHeight),
      imageEditor: true,
      imageEditorTools: 7,
      emojiEditor: { quickPicker: true, customInput: true, adjustableSize: true, draggable: true, deletable: true },
      mosaicBlurLevel: 36,
      mosaicModes: ['square', 'circle', 'brush'],
      persistentMosaicSelectionGuide: true,
      adjustableSelectedMosaicBlur: true,
      adjustableCompletedVectorStroke: ['rect', 'ellipse', 'arrow'],
      vectorSelectionGuideRemoved: true,
      redundantFooterTranslationCopyRemoved: true,
      translationRetryAction: true,
      fullPaneHeaderCollapseHitArea: true,
      clipboardStatusStates: ['截图已复制', '原文已复制', '译文已复制'],
      directScreenshotRecopy: true,
      editedImageCopied,
      capturedImageCopied: clipboardWriteConfirmed,
      clipboardUnavailableDuringRun: !clipboardWriteConfirmed,
      captureOverlay: true,
      resultFloat: true,
      roundedResultWindow: true,
      translationModelInTranslationHeader: true,
      localOcrEngineNameHidden: true,
      floatReadingSizeCycle: ['moderate', 'maximized', 'moderate'],
      moderateFloatSize: moderateFloatState.bounds,
      settingsVisible: await page.locator('#view-settings.is-active').isVisible(),
      visualPromptWindow: true,
      pinnedVisualWindowIgnoresEscape: true,
      explicitVisualCloseClearsPin: true,
      editableStructuredPrompts: true,
      visionServiceModels: visionHealth.models,
      referenceGenerationStrategies: {
        daily: ['style', 'composition', 'subject'],
        ecommerce: ['style', 'composition', 'product'],
        drama: ['character', 'shot', 'continuity'],
      },
      generatedImageClipboardReady: generatedClipboardReady,
      visualAnalysisModes: ['daily', 'ecommerce', 'drama'],
      visualModeResultsPreserved: true,
      visualModeCacheAvoidsRepeatRequests: true,
      clearAndRegenerateCurrentModeOnly: true,
      dramaSchemaAndPromptIsolation: true,
      ecommerceGridSingleImage: true,
      ecommerceGridPromptReceived: mockAi.stats.gridPromptReceived,
      ecommerceGridClipboardReady: gridClipboardReady,
      productRightsGuard: true,
      promptHistoryExcludesSourceImage: true,
      altPromptShortcut: 'Alt+P',
      altAnnotationShortcut: 'Alt+A',
      instantMenuShortcut: 'F1',
      configurableGlobalShortcuts: true,
      pinnedScreenshotComparison: true,
      customColorWheel: true,
      enterCompletesInlineEditor: true,
      directAnnotationCapture: true,
      nativeWindowSnap: true,
      smartControlSnap: true,
      fullDisplayOverlayCoverage: true,
      viewportCalibratedCropping: true,
      completedArrowStyles: ['open', 'filled', 'double', 'filled-double', 'dot'],
      draggableRectangleCornerRadius: true,
      editorFoldedLogo: true,
      altAnnotationInlineEditor: true,
      altAnnotationSeparateWindowRemoved: true,
      packaged,
    };
    fs.writeFileSync(path.join(outputDir, 'smoke-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await electronApp.close();
    await new Promise((resolve) => mockAi.server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
