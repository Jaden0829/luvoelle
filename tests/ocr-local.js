const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

async function waitForMainWindow(electronApp, timeout = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const page = electronApp.windows().find((candidate) => candidate.url().endsWith('/index.html'));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for the Luvoelle main window');
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const executablePath = process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe');
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const forceFallback = process.env.LUVOELLE_DISABLE_PADDLE === '1';
  const crashIsolation = process.argv.includes('--crash-isolation');
  const testProfile = path.join(root, 'work', `ocr-profile-${Date.now()}`);
  fs.mkdirSync(testProfile, { recursive: true });
  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: packaged ? [] : ['.'],
    env: {
      ...process.env,
      LUVOELLE_TEST: '1',
      LUVOELLE_TEST_USER_DATA: testProfile,
      ...(crashIsolation ? { LUVOELLE_TEST_OCR_PROCESS_EXIT: '1' } : {}),
    },
  });
  try {
    const page = await waitForMainWindow(electronApp);
    await page.waitForSelector('.action-card[data-capture="ocr"]');
    const sampleImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1040;
      canvas.height = 300;
      const context = canvas.getContext('2d');
      context.fillStyle = '#f7f7f8';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#202124';
      context.font = '600 30px "Segoe UI", Arial';
      context.fillText('SKU: A7-9 / ¥199.50 (NEW) @ 20%', 54, 88);
      context.font = '20px "Segoe UI", Arial';
      context.fillText('Small UI letters: i l I 1 O 0 · [A/B] + C#', 54, 148);
      context.font = '22px "Microsoft YaHei", sans-serif';
      context.fillText('截图识别：中文、小字与符号测试', 54, 212);
      return canvas.toDataURL('image/png');
    });
    fs.writeFileSync(path.join(root, 'work', 'ocr-local-sample.png'), Buffer.from(sampleImage.split(',')[1], 'base64'));
    await page.evaluate(() => window.luvoelle.saveSettings({ ocrMode: 'local' }));
    if (!forceFallback) {
      await page.waitForFunction(async () => (await window.luvoelle.getOcrStatus()).ready, null, { timeout: 30000 });
    }
    const results = [];
    const runs = forceFallback || crashIsolation ? 1 : 3;
    for (let index = 0; index < runs; index += 1) {
      results.push(await page.evaluate((dataUrl) => window.luvoelle.processImage({ dataUrl, mode: 'ocr' }), sampleImage));
    }
    const result = results.at(-1);
    assert.match(
      result.ocr.provider,
      forceFallback || crashIsolation ? /Tesseract/ : /PP-OCRv6 small/,
      result.ocr.fallbackReason || result.ocr.provider,
    );
    assert.match(result.ocr.text, /SKU|199|NEW/i);
    assert.ok(result.ocr.blocks.length > 0, 'PP-OCRv6 returned no positioned text blocks');
    assert.ok(result.ocr.latency > 0 && result.ocr.latency < 45000, `Unexpected OCR latency ${result.ocr.latency}ms`);
    if (crashIsolation) {
      assert.match(result.ocr.fallbackReason || '', /isolated process stopped/i);
      assert.equal(await page.locator('.action-card[data-capture="ocr"]').isVisible(), true, '主应用没有在 OCR 子进程退出后存活');
    }
    console.log(JSON.stringify({
      provider: result.ocr.provider,
      text: result.ocr.text,
      confidence: result.ocr.confidence,
      latency: result.ocr.latency,
      latencies: results.map((item) => item.ocr.latency),
      blocks: result.ocr.blocks.length,
      localRefined: Boolean(result.ocr.localRefined),
      runtime: result.ocr.runtime,
      isolatedCrashSurvived: crashIsolation,
    }));
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
