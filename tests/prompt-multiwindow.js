const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { _electron: electron } = require('playwright');

function analysisFor(index) {
  return {
    summary: `并行视觉任务 ${index}`,
    scene_type: '日常视觉',
    product: { category: '对比测试', subject: `独立主体 ${index}`, materials: [], colors: ['蓝色'], geometry: '矩形画面', details: ['窗口任务隔离'] },
    composition: { aspect_ratio: '2:1', framing: '中景', viewpoint: '平视', subject_position: '居中', negative_space: '两侧' },
    camera: { shot_type: '测试镜头', lens_guess: '推测 50mm', depth_of_field: '中等景深' },
    lighting: { source: '柔光', direction: '正面', quality: '柔和', color_temperature: '中性' },
    background: { setting: '测试背景', props: [], texture: '纯色' },
    palette: ['#2F73D9'],
    visible_text: [],
    typography: '',
    prompts: { universal_zh: `并行任务 ${index} 提示词`, universal_en: `parallel visual task ${index}`, negative: '串台' },
    mode_data: { subject_type: '测试图片', activity: '窗口对比', mood: '清晰' },
    warnings: [],
    confidence: {},
  };
}

async function startVisionServer() {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'parallel-vision' }] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        requestCount += 1;
        const index = requestCount;
        setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysisFor(index)) } }] })), 1800);
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: `http://127.0.0.1:${server.address().port}/v1`, getRequestCount: () => requestCount };
}

async function waitForWindow(electronApp, fileName, count = 1, timeout = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const matches = electronApp.windows().filter((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (matches.length >= count) return matches;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${count} ${fileName} windows`);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = path.join(root, 'work', `prompt-windows-profile-${Date.now()}`);
  const artifacts = path.join(root, 'work', 'test-artifacts');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  const mock = await startVisionServer();
  const executablePath = process.env.LUVOELLE_PACKAGED_EXE || '';
  const electronApp = await electron.launch(executablePath ? {
    executablePath,
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile },
  } : {
    args: ['.'],
    cwd: root,
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile },
  });

  try {
    const [mainPage] = await waitForWindow(electronApp, 'index.html');
    await mainPage.waitForSelector('.action-card[data-capture="prompt"]');
    await mainPage.evaluate((endpoint) => window.luvoelle.saveSettings({
      visionProvider: 'local',
      visionEndpoint: endpoint,
      visionModel: 'parallel-vision',
      ocrMode: 'local',
    }), mock.endpoint);
    const image = await mainPage.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 450;
      const context = canvas.getContext('2d');
      context.fillStyle = '#eaf3ff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#184f9c';
      context.font = '700 62px Segoe UI';
      context.fillText('COMPARE 01', 210, 245);
      return canvas.toDataURL('image/png');
    });

    await mainPage.evaluate((dataUrl) => { window.__firstVisual = window.luvoelle.processImage({ dataUrl, mode: 'prompt' }); }, image);
    const [firstWindow] = await waitForWindow(electronApp, 'prompt.html');
    await firstWindow.waitForFunction(() => !document.querySelector('#preview-loading')?.hidden);
    await firstWindow.click('#pin-window');
    await firstWindow.waitForFunction(() => document.querySelector('#pin-window')?.getAttribute('aria-pressed') === 'true');

    await mainPage.evaluate(() => window.luvoelle.startCapture('prompt'));
    await mainPage.evaluate((dataUrl) => window.luvoelle.submitCapture({ dataUrl, mode: 'prompt' }), image);
    const promptPages = await waitForWindow(electronApp, 'prompt.html', 2);
    const secondWindow = promptPages.find((candidate) => candidate !== firstWindow);
    assert.ok(secondWindow, '第二个视觉窗口没有创建');
    await secondWindow.waitForSelector('#window-status');

    const windowAudit = await electronApp.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const windows = BrowserWindow.getAllWindows()
        .filter((candidate) => candidate.webContents.getURL().endsWith('/prompt.html'))
        .map((candidate) => ({ id: candidate.id, visible: candidate.isVisible(), pinned: candidate.isAlwaysOnTop(), bounds: candidate.getBounds() }));
      return { area, windows };
    });
    assert.equal(windowAudit.windows.length, 2);
    assert.equal(windowAudit.windows.filter((item) => item.visible).length, 2);
    assert.equal(windowAudit.windows.filter((item) => item.pinned).length, 1);
    assert.equal(await secondWindow.locator('#pin-window').getAttribute('aria-pressed'), 'false');
    if (windowAudit.area.width >= 1360) {
      const [one, two] = windowAudit.windows;
      assert.notEqual(one.bounds.x, two.bounds.x, '对比窗口没有左右错开');
    }

    await Promise.all([
      firstWindow.waitForSelector('#window-status.is-ready'),
      secondWindow.waitForSelector('#window-status.is-ready'),
    ]);
    const firstSummary = await firstWindow.locator('#summary-text').textContent();
    const secondSummary = await secondWindow.locator('#summary-text').textContent();
    assert.equal(firstSummary, '并行视觉任务 1');
    assert.equal(secondSummary, '并行视觉任务 2');
    assert.equal(mock.getRequestCount(), 2);
    await secondWindow.screenshot({ path: path.join(artifacts, 'visual-comparison-new-window.png') });

    await secondWindow.keyboard.press('Escape');
    await secondWindow.waitForTimeout(120);
    const afterSecondEscape = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter((candidate) => candidate.webContents.getURL().endsWith('/prompt.html'))
      .map((candidate) => ({ visible: candidate.isVisible(), pinned: candidate.isAlwaysOnTop() })));
    assert.equal(afterSecondEscape.filter((item) => item.visible).length, 1);
    assert.equal(afterSecondEscape.find((item) => item.visible)?.pinned, true);

    await firstWindow.keyboard.press('Escape');
    await firstWindow.waitForTimeout(120);
    assert.equal(await firstWindow.locator('#pin-window').getAttribute('aria-pressed'), 'true');
    const firstWindowClosed = firstWindow.waitForEvent('close');
    await firstWindow.click('#close-window');
    await firstWindowClosed;

    const results = await mainPage.evaluate(() => Promise.all([window.__firstVisual, window.__secondVisual].filter(Boolean)));
    assert.ok(results.length >= 1);
    console.log(JSON.stringify({
      parallelVisualRequests: mock.getRequestCount(),
      packaged: Boolean(executablePath),
      fixedWindowPreserved: true,
      fixedWindowContinuedAnalysis: true,
      newWindowStartsUnpinned: true,
      independentResults: [firstSummary, secondSummary],
      comparisonLayout: windowAudit.windows.map((item) => item.bounds),
    }));
  } finally {
    await electronApp.close();
    await new Promise((resolve) => mock.server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
