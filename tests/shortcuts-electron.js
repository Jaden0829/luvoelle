const assert = require('assert');
const { app, globalShortcut } = require('electron');
const { DEFAULT_SHORTCUTS, normalizeShortcutMap } = require('../src/services/shortcuts');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

(async () => {
  await app.whenReady();
  const shortcuts = normalizeShortcutMap(DEFAULT_SHORTCUTS);
  const status = {};
  Object.entries(shortcuts).forEach(([id, accelerator]) => {
    const registered = globalShortcut.register(accelerator, () => {});
    status[id] = { accelerator, registered, active: globalShortcut.isRegistered(accelerator) };
  });
  assert.ok(
    Object.values(status).some((item) => item.registered && item.active),
    'Electron could not register any global shortcut in this environment',
  );
  globalShortcut.unregisterAll();
  process.stdout.write(`${JSON.stringify({ configurableShortcutRegistration: status })}\n`);
  app.quit();
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
