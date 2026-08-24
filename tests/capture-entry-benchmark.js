const { app, nativeImage, screen } = require('electron');
const { captureDisplay } = require('../src/services/native-screen-capture');
const { getCaptureWindowTargets } = require('../src/services/window-targets');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

(async () => {
  await app.whenReady();
  const displays = screen.getAllDisplays();
  const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const targetsStartedAt = performance.now();
  const targets = getCaptureWindowTargets(displays, (point) => screen.dipToScreenPoint(point));
  const windowTargetDetectionMs = performance.now() - targetsStartedAt;
  const captureStartedAt = performance.now();
  const frame = captureDisplay(activeDisplay, (point) => screen.dipToScreenPoint(point), nativeImage);
  const captureMs = performance.now() - captureStartedAt;
  const jpegStartedAt = performance.now();
  const jpeg = frame.image.toJPEG(92);
  const jpegMs = performance.now() - jpegStartedAt;
  const pngStartedAt = performance.now();
  const png = frame.image.toPNG();
  const pngMs = performance.now() - pngStartedAt;
  process.stdout.write(`${JSON.stringify({
    display: activeDisplay.bounds,
    scaleFactor: activeDisplay.scaleFactor,
    targetCount: Array.from(targets.values()).reduce((total, items) => total + items.length, 0),
    windowTargetDetectionMs: Math.round(windowTargetDetectionMs * 10) / 10,
    captureMs: Math.round(captureMs * 10) / 10,
    jpegMs: Math.round(jpegMs * 10) / 10,
    pngMs: Math.round(pngMs * 10) / 10,
    jpegBytes: jpeg.length,
    pngBytes: png.length,
  })}\n`);
  app.quit();
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
