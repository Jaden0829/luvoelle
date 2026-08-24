const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

async function waitForWindowByFile(electronApp, fileName, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const match = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const executablePath = process.env.LUVOELLE_PACKAGED_PATH || path.join(root, 'outputs', 'release', 'win-unpacked', 'Luvoelle.exe');
  if (packaged) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `shortcut-profile-${Date.now()}`);
  const artifactPath = path.join(root, 'work', 'test-artifacts', 'configurable-shortcuts.png');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const electronApp = await electron.launch({
    ...(packaged ? { executablePath } : { cwd: root }),
    args: [...(packaged ? [] : ['.']), '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-software-rasterizer'],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile },
  });

  try {
    const page = await waitForWindowByFile(electronApp, 'index.html');
    await page.waitForSelector('.nav-item[data-view="settings"]');
    const initial = await page.evaluate(() => window.luvoelle.bootstrap());
    if (packaged) assert.equal(initial.version, require('../package.json').version);
    assert.deepEqual(initial.shortcuts, {
      quickEdit: 'F1',
      translate: 'Alt+S',
      ocr: 'Alt+O',
      prompt: 'Alt+P',
      edit: 'Alt+A',
      text: 'Alt+T',
    });
    const initialF1Registered = await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F1'));
    assert.equal(initial.settings.shortcutStatus.quickEdit.registered, initialF1Registered);

    await page.click('.nav-item[data-view="settings"]');
    await page.waitForSelector('#view-settings.is-active');
    assert.equal(await page.locator('[data-shortcut-input]').count(), 6);
    assert.equal(await page.locator('[data-shortcut-input="quickEdit"]').textContent(), 'F1');
    assert.equal(
      await page.locator('[data-shortcut-row="quickEdit"]').evaluate((row) => row.classList.contains('is-unavailable')),
      !initialF1Registered,
    );

    const quickEdit = page.locator('[data-shortcut-input="quickEdit"]');
    await quickEdit.click();
    await page.waitForSelector('[data-shortcut-input="quickEdit"].is-recording');
    assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+S')), false);
    await quickEdit.press('Control+Shift+F12');
    await page.waitForFunction(() => document.querySelector('[data-shortcut-input="quickEdit"]')?.textContent === 'Ctrl + Shift + F12');

    const edit = page.locator('[data-shortcut-input="edit"]');
    await edit.click();
    await edit.press('Control+Shift+F12');
    await page.waitForFunction(() => document.querySelectorAll('[data-shortcut-row].is-conflict').length === 2);
    assert.equal(await page.locator('#settings-save-bar button[type="submit"]').isDisabled(), true);
    await edit.click();
    await edit.press('Alt+A');
    await page.waitForFunction(() => document.querySelectorAll('[data-shortcut-row].is-conflict').length === 0);
    assert.equal(await page.locator('#settings-save-bar button[type="submit"]').isEnabled(), true);

    await page.click('#settings-save-bar button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-shortcut-row="quickEdit"] .shortcut-status')?.textContent === '已生效');
    assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Shift+F12')), true);
    assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F1')), false);
    assert.equal(await page.evaluate(() => window.luvoelle.bootstrap().then((value) => value.shortcuts.quickEdit)), 'Ctrl+Shift+F12');
    await page.screenshot({ path: artifactPath });

    const prompt = page.locator('[data-shortcut-input="prompt"]');
    const promptBeforeCancel = await prompt.textContent();
    await prompt.click();
    await prompt.press('Escape');
    assert.equal(await prompt.textContent(), promptBeforeCancel);
    assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Shift+F12')), true);

    await page.click('#reset-shortcuts');
    assert.equal(await quickEdit.textContent(), 'F1');
    await page.click('#settings-save-bar button[type="submit"]');
    if (initialF1Registered) {
      await page.waitForFunction(() => document.querySelector('[data-shortcut-row="quickEdit"] .shortcut-status')?.textContent === '已生效');
      assert.equal(await page.evaluate(() => window.luvoelle.bootstrap().then((value) => value.shortcuts.quickEdit)), 'F1');
      assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('F1')), true);
    } else {
      await page.waitForFunction(() => document.querySelector('#shortcut-settings-note')?.classList.contains('is-error'));
      assert.equal(await page.evaluate(() => window.luvoelle.bootstrap().then((value) => value.shortcuts.quickEdit)), 'Ctrl+Shift+F12');
      assert.equal(await electronApp.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Shift+F12')), true);
    }

    process.stdout.write(`${JSON.stringify({
      configurableShortcutUi: true,
      packaged,
      defaults: initial.shortcuts,
      recordingSuspendsGlobals: true,
      duplicateValidation: true,
      persistence: true,
      occupiedShortcutRollback: !initialF1Registered,
    })}\n`);
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
