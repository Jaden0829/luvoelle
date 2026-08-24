const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ensureScreenCaptureAccess,
  getScreenCaptureStatus,
  hasUsableScreenSources,
} = require('../src/services/mac-screen-permission');
const { isMacWindowTargetBackendAvailable, mapLogicalWindowTargetsToDisplays } = require('../src/services/window-targets');

function fakeThumbnail(width = 1, height = 1) {
  return {
    getSize: () => ({ width, height }),
    isEmpty: () => width <= 0 || height <= 0,
  };
}

(async () => {
  assert.equal(getScreenCaptureStatus(null, 'win32'), 'granted');
  assert.equal(hasUsableScreenSources([{ thumbnail: fakeThumbnail(1, 1) }]), true);
  assert.equal(hasUsableScreenSources([{ thumbnail: fakeThumbnail(0, 0) }]), false);

  let probeCalls = 0;
  const denied = await ensureScreenCaptureAccess({
    platform: 'darwin',
    systemPreferences: { getMediaAccessStatus: () => 'denied' },
    desktopCapturer: { getSources: async () => { probeCalls += 1; return []; } },
  });
  assert.deepEqual(denied, { granted: false, status: 'denied', requested: false });
  assert.equal(probeCalls, 0);

  let statusCalls = 0;
  const newlyGranted = await ensureScreenCaptureAccess({
    platform: 'darwin',
    systemPreferences: { getMediaAccessStatus: () => (statusCalls++ === 0 ? 'not-determined' : 'granted') },
    desktopCapturer: { getSources: async () => { probeCalls += 1; return [{ thumbnail: fakeThumbnail() }]; } },
  });
  assert.equal(newlyGranted.granted, true);
  assert.equal(newlyGranted.requested, true);
  assert.equal(probeCalls, 1);

  const mapped = mapLogicalWindowTargetsToDisplays([
    { id: 'retina', bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 },
    { id: 'external', bounds: { x: 1512, y: 80, width: 1920, height: 1080 }, scaleFactor: 1 },
  ], [
    { left: 100, top: 70, right: 1300, bottom: 900, title: 'Retina window', zIndex: 0 },
    { left: 1600, top: 120, right: 3000, bottom: 900, title: 'External window', zIndex: 1 },
  ]);
  assert.deepEqual(mapped.get('retina')[0], {
    left: 100, top: 70, width: 1200, height: 830, title: 'Retina window', zIndex: 0,
  });
  assert.deepEqual(mapped.get('external')[0], {
    left: 88, top: 40, width: 1400, height: 780, title: 'External window', zIndex: 1,
  });

  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const macTargets = packageJson.build.mac.target;
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(macTargets.map((item) => item.target), ['dmg', 'zip']);
  assert.ok(macTargets.every((item) => item.arch.includes('arm64')));
  assert.equal(packageJson.build.mac.minimumSystemVersion, '13.0');
  assert.ok(fs.existsSync(path.join(root, 'build', 'entitlements.mac.plist')));
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'darwin', 'arm64')));
  if (process.platform === 'darwin') {
    assert.equal(process.arch, 'arm64');
    assert.equal(isMacWindowTargetBackendAvailable(), true);
    assert.ok(require.resolve('@koromix/koffi-darwin-arm64'));
    assert.ok(require.resolve('@napi-rs/canvas-darwin-arm64'));
    assert.doesNotThrow(() => require('koffi'));
    assert.doesNotThrow(() => require('@napi-rs/canvas'));
  }

  process.stdout.write(`${JSON.stringify({
    macScreenPermissionFlow: true,
    retinaAndExternalDisplayMapping: true,
    appleSiliconOcrRuntimePresent: true,
    macTargets: ['dmg-arm64', 'zip-arm64'],
  })}\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
