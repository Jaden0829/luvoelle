const assert = require('assert');
const { app, BrowserWindow, nativeImage, screen } = require('electron');
const { captureDisplay, captureDisplays, capturePhysicalRectangle, flushDesktopComposition } = require('../src/services/native-screen-capture');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

function pixelAt(image, x, y) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const clampedX = Math.max(0, Math.min(size.width - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(size.height - 1, Math.round(y)));
  const index = (clampedY * size.width + clampedX) * 4;
  return { blue: bitmap[index], green: bitmap[index + 1], red: bitmap[index + 2] };
}

(async () => {
  await app.whenReady();
  const display = screen.getPrimaryDisplay();
  const fixture = new BrowserWindow({
    x: display.workArea.x + 80,
    y: display.workArea.y + 80,
    width: 640,
    height: 420,
    frame: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#ffffff',
  });
  await fixture.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><style>
      html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}
      .lines{position:absolute;inset:0;background:repeating-linear-gradient(90deg,#000 0 1px,#fff 1px 2px)}
      .label{position:absolute;left:40px;top:120px;padding:12px;background:#fff;color:#000;font:700 42px Arial}
    </style><body><div class="lines"></div><div class="label">PIXEL SHARPNESS 2026</div></body></html>
  `)}`);
  fixture.show();
  fixture.setAlwaysOnTop(true, 'screen-saver');
  fixture.focus();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const bounds = fixture.getBounds();
  const origin = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
  const scaleFactor = display.scaleFactor;
  const expected = {
    width: Math.round(bounds.width * scaleFactor),
    height: Math.round(bounds.height * scaleFactor),
  };
  const startedAt = performance.now();
  const capture = capturePhysicalRectangle({ x: origin.x, y: origin.y, ...expected }, nativeImage);
  const captureMs = Math.round((performance.now() - startedAt) * 10) / 10;
  assert.ok(capture, 'Win32 GDI capture returned no frame');
  assert.deepEqual(capture.image.getSize(), expected, 'Win32 GDI capture changed the physical-pixel dimensions');
  const bitmap = capture.image.toBitmap();
  let dark = 0;
  let light = 0;
  for (let index = 0; index < bitmap.length; index += 64) {
    const brightness = bitmap[index] + bitmap[index + 1] + bitmap[index + 2];
    if (brightness < 120) dark += 1;
    if (brightness > 640) light += 1;
  }
  assert.ok(dark > 100 && light > 100, `Win32 GDI capture lost the high-frequency fixture detail: dark=${dark} light=${light}`);
  const displays = screen.getAllDisplays();
  const allStartedAt = performance.now();
  const frames = captureDisplays(displays, (point) => screen.dipToScreenPoint(point), nativeImage);
  const allCaptureMs = Math.round((performance.now() - allStartedAt) * 10) / 10;
  assert.equal(frames.size, displays.length, 'Win32 GDI capture did not return every display');
  displays.forEach((item) => assert.deepEqual(
    frames.get(String(item.id)).image.getSize(),
    { width: Math.round(item.bounds.width * item.scaleFactor), height: Math.round(item.bounds.height * item.scaleFactor) },
    `Win32 GDI capture scaled display ${item.id}`,
  ));
  const previews = Array.from(frames.values(), (frame) => frame.image.toJPEG(100));
  assert.ok(previews.every((preview) => preview.length > 1000), 'Win32 GDI capture could not create JPEG previews');
  const perDisplayCaptureMs = displays.map((item) => {
    const displayStartedAt = performance.now();
    captureDisplay(item, (point) => screen.dipToScreenPoint(point), nativeImage);
    return Math.round((performance.now() - displayStartedAt) * 10) / 10;
  });
  const transientBounds = { x: display.workArea.x + 190, y: display.workArea.y + 245, width: 260, height: 110 };
  const transient = new BrowserWindow({ ...transientBounds, frame: false, show: false, alwaysOnTop: true, backgroundColor: '#ff2d7a' });
  await transient.loadURL('data:text/html,<body style="margin:0;background:rgb(255,45,122)"></body>');
  transient.setAlwaysOnTop(true, 'screen-saver');
  transient.on('blur', () => transient.hide());
  transient.show();
  transient.focus();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const frozenTransientFrame = captureDisplay(display, (point) => screen.dipToScreenPoint(point), nativeImage);
  const displayOrigin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
  const transientOrigin = screen.dipToScreenPoint({ x: transientBounds.x, y: transientBounds.y });
  const transientCenter = {
    x: transientOrigin.x - displayOrigin.x + Math.round(transientBounds.width * scaleFactor / 2),
    y: transientOrigin.y - displayOrigin.y + Math.round(transientBounds.height * scaleFactor / 2),
  };
  const frozenTransientPixel = pixelAt(frozenTransientFrame.image, transientCenter.x, transientCenter.y);
  fixture.focus();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(transient.isVisible(), false, 'The transient fixture did not close after losing focus');
  const liveFrameAfterFocus = captureDisplay(display, (point) => screen.dipToScreenPoint(point), nativeImage);
  const livePixelAfterFocus = pixelAt(liveFrameAfterFocus.image, transientCenter.x, transientCenter.y);
  const frozenFrameKeepsTransient = frozenTransientPixel.red > 220
    && frozenTransientPixel.green < 80
    && frozenTransientPixel.blue > 80;
  assert.ok(frozenFrameKeepsTransient, `The pre-focus frame lost the transient surface: ${JSON.stringify(frozenTransientPixel)}`);
  assert.notDeepEqual(livePixelAfterFocus, frozenTransientPixel, 'A live recapture unexpectedly retained the closed transient surface');
  transient.destroy();
  const protectedBounds = { x: display.workArea.x + 760, y: display.workArea.y + 120, width: 280, height: 180 };
  const protectedBase = new BrowserWindow({ ...protectedBounds, frame: false, show: false, alwaysOnTop: true, backgroundColor: '#00cc44' });
  await protectedBase.loadURL('data:text/html,<body style="margin:0;background:rgb(0,204,68)"></body>');
  protectedBase.setAlwaysOnTop(true, 'floating');
  protectedBase.show();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const protectedOverlay = new BrowserWindow({ ...protectedBounds, frame: false, show: false, transparent: true, alwaysOnTop: true, backgroundColor: '#00000000' });
  protectedOverlay.setContentProtection(true);
  protectedOverlay.setAlwaysOnTop(true, 'screen-saver');
  await protectedOverlay.loadURL('data:text/html,<body style="margin:0;background:rgba(238,0,51,.82)"></body>');
  protectedOverlay.setOpacity(0);
  protectedOverlay.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 100));
  protectedOverlay.setOpacity(1);
  protectedOverlay.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const protectedOrigin = screen.dipToScreenPoint({ x: protectedBounds.x, y: protectedBounds.y });
  const protectedRect = {
    x: protectedOrigin.x,
    y: protectedOrigin.y,
    width: Math.round(protectedBounds.width * scaleFactor),
    height: Math.round(protectedBounds.height * scaleFactor),
  };
  const protectedCapture = capturePhysicalRectangle(protectedRect, nativeImage);
  const protectedBitmap = protectedCapture.image.toBitmap();
  const center = (Math.floor(protectedCapture.height / 2) * protectedCapture.width + Math.floor(protectedCapture.width / 2)) * 4;
  const protectedPixel = { blue: protectedBitmap[center], green: protectedBitmap[center + 1], red: protectedBitmap[center + 2] };
  const protectedOverlayExcluded = protectedPixel.red < 50 && protectedPixel.green > 150;
  protectedOverlay.hide();
  await new Promise((resolve) => setImmediate(resolve));
  const compositionFlushed = flushDesktopComposition();
  if (!compositionFlushed) await new Promise((resolve) => setTimeout(resolve, 32));
  const revealedCapture = capturePhysicalRectangle(protectedRect, nativeImage);
  const revealedBitmap = revealedCapture.image.toBitmap();
  const revealedPixel = { blue: revealedBitmap[center], green: revealedBitmap[center + 1], red: revealedBitmap[center + 2] };
  const underlyingPixelsRestored = revealedPixel.red < 50 && revealedPixel.green > 150;
  assert.ok(underlyingPixelsRestored, `Hiding the protected overlay did not restore the underlying pixels: ${JSON.stringify(revealedPixel)}`);
  console.log(JSON.stringify({ backend: capture.backend, scaleFactor, expected, actual: capture.image.getSize(), captureMs, dark, light, displays: displays.map((item, index) => ({ id: item.id, bounds: item.bounds, scaleFactor: item.scaleFactor, captureMs: perDisplayCaptureMs[index] })), allCaptureMs, previewBytes: previews.map((preview) => preview.length), frozenTransientPixel, livePixelAfterFocus, frozenFrameKeepsTransient, protectedPixel, protectedOverlayExcluded, compositionFlushed, revealedPixel, underlyingPixelsRestored }));
  protectedOverlay.destroy();
  protectedBase.destroy();
  fixture.destroy();
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
