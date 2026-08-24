const assert = require('assert');
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
const { captureDisplay } = require('../src/services/native-screen-capture');

function bitmapToBmp(bitmap, width, height) {
  const pixelBytes = width * height * 4;
  assert.equal(bitmap.length, pixelBytes);
  const header = Buffer.alloc(54);
  header.write('BM', 0, 2, 'ascii');
  header.writeUInt32LE(54 + pixelBytes, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(-height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(pixelBytes, 34);
  return Buffer.concat([header, bitmap], 54 + pixelBytes);
}

function sampledError(reference, candidate, width, height) {
  let absoluteError = 0;
  let maximumError = 0;
  let samples = 0;
  const strideX = Math.max(1, Math.floor(width / 160));
  const strideY = Math.max(1, Math.floor(height / 90));
  for (let y = 0; y < height; y += strideY) {
    for (let x = 0; x < width; x += strideX) {
      const offset = ((y * width) + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(reference[offset + channel] - candidate[offset + channel]);
        absoluteError += difference;
        maximumError = Math.max(maximumError, difference);
        samples += 1;
      }
    }
  }
  return { meanAbsoluteError: absoluteError / samples, maximumError, samples };
}

function browserSampleError(reference, rgbaSamples, width, height) {
  let absoluteError = 0;
  let maximumError = 0;
  let samples = 0;
  let sampleIndex = 0;
  const strideX = Math.max(1, Math.floor(width / 160));
  const strideY = Math.max(1, Math.floor(height / 90));
  for (let y = 0; y < height; y += strideY) {
    for (let x = 0; x < width; x += strideX) {
      const offset = ((y * width) + x) * 4;
      const expected = [reference[offset + 2], reference[offset + 1], reference[offset]];
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(expected[channel] - rgbaSamples[sampleIndex]);
        absoluteError += difference;
        maximumError = Math.max(maximumError, difference);
        samples += 1;
        sampleIndex += 1;
      }
    }
  }
  assert.equal(sampleIndex, rgbaSamples.length);
  return { meanAbsoluteError: absoluteError / samples, maximumError, samples };
}

(async () => {
  await app.whenReady();
  const display = screen.getAllDisplays().sort((left, right) => right.scaleFactor - left.scaleFactor)[0];
  const frame = captureDisplay(display, (point) => screen.dipToScreenPoint(point), nativeImage);
  assert.ok(frame?.image && !frame.image.isEmpty());
  const { width, height } = frame.image.getSize();

  const rawStartedAt = performance.now();
  const raw = frame.image.toBitmap();
  const rawMs = performance.now() - rawStartedAt;
  const bmpStartedAt = performance.now();
  const bmp = bitmapToBmp(raw, width, height);
  const bmpMs = performance.now() - bmpStartedAt;
  const bmpBase64StartedAt = performance.now();
  const bmpDataUrl = `data:image/bmp;base64,${bmp.toString('base64')}`;
  const bmpBase64Ms = performance.now() - bmpBase64StartedAt;
  const bmpDecodeMs = null;

  const jpegStartedAt = performance.now();
  const jpeg = frame.image.toJPEG(100);
  const jpegMs = performance.now() - jpegStartedAt;
  const jpegBase64StartedAt = performance.now();
  const jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const jpegBase64Ms = performance.now() - jpegBase64StartedAt;
  const jpegDecodeStartedAt = performance.now();
  const jpegDecoded = nativeImage.createFromDataURL(jpegDataUrl);
  const jpegDecodeMs = performance.now() - jpegDecodeStartedAt;

  assert.deepEqual(jpegDecoded.getSize(), { width, height });
  const bmpError = { nativeImageUnsupported: true };
  const jpegError = sampledError(raw, jpegDecoded.toBitmap(), width, height);
  const browser = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await browser.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><canvas></canvas><img><script>
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('decode', async (_event, value) => {
      const startedAt = performance.now();
      const bytes = new Uint8Array(value.bytes);
      if (value.kind === 'bmp') {
        const blob = new Blob([bytes], { type: 'image/bmp' });
        const bitmap = await createImageBitmap(blob);
        const canvas = document.querySelector('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { alpha: false });
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const samples = [];
        const strideX = Math.max(1, Math.floor(bitmap.width / 160));
        const strideY = Math.max(1, Math.floor(bitmap.height / 90));
        for (let y = 0; y < bitmap.height; y += strideY) {
          for (let x = 0; x < bitmap.width; x += strideX) {
            const offset = ((y * bitmap.width) + x) * 4;
            samples.push(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
          }
        }
        ipcRenderer.send('decode-result', { kind: value.kind, width: bitmap.width, height: bitmap.height, samples, elapsedMs: performance.now() - startedAt });
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        const image = document.querySelector('img');
        image.onload = () => { ipcRenderer.send('decode-result', { kind: value.kind, width: image.naturalWidth, height: image.naturalHeight, elapsedMs: performance.now() - startedAt }); URL.revokeObjectURL(url); };
        image.src = url;
      }
    });
  <\/script>`)}`);
  const decodeInBrowser = (kind, bytes) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${kind} browser decode timeout`)), 5000);
    ipcMain.once('decode-result', (_event, value) => { clearTimeout(timer); resolve(value); });
    const sentAt = performance.now();
    browser.webContents.send('decode', { kind, bytes });
    const sendReturnedAt = performance.now();
    browser.luvoelleSentAt = sentAt;
    browser.luvoelleSendMs = sendReturnedAt - sentAt;
  }).then((value) => ({ ...value, sendMs: browser.luvoelleSendMs, roundTripMs: performance.now() - browser.luvoelleSentAt }));
  const browserBmp = await decodeInBrowser('bmp', bmp);
  const browserJpeg = await decodeInBrowser('jpeg', jpeg);
  browser.destroy();
  assert.deepEqual({ width: browserBmp.width, height: browserBmp.height }, { width, height });
  const browserBmpError = browserSampleError(raw, browserBmp.samples, width, height);
  assert.equal(browserBmpError.maximumError, 0);
  delete browserBmp.samples;
  process.stdout.write(`${JSON.stringify({
    display: display.bounds,
    scaleFactor: display.scaleFactor,
    pixels: width * height,
    rawBytes: raw.length,
    bmpBytes: bmp.length,
    jpegBytes: jpeg.length,
    rawMs: Math.round(rawMs * 10) / 10,
    bmpMs: Math.round(bmpMs * 10) / 10,
    bmpBase64Ms: Math.round(bmpBase64Ms * 10) / 10,
    bmpDecodeMs: Math.round(bmpDecodeMs * 10) / 10,
    jpegMs: Math.round(jpegMs * 10) / 10,
    jpegBase64Ms: Math.round(jpegBase64Ms * 10) / 10,
    jpegDecodeMs: Math.round(jpegDecodeMs * 10) / 10,
    bmpError,
    jpegError,
    browserBmp,
    browserBmpError,
    browserJpeg,
  })}\n`);
  app.quit();
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
