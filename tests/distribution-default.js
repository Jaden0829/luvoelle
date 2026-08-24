const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

async function waitForWindow(electronApp, fileName, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const page = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const executablePath = String(process.env.LUVOELLE_PACKAGED_PATH || '').trim();
  const expectedDistribution = process.env.LUVOELLE_EXPECT_DISTRIBUTION || 'standard';
  const migrateGoogle = process.env.LUVOELLE_TEST_MIGRATE_GOOGLE === '1';
  const expectedProvider = expectedDistribution === 'friend' ? 'deepseek' : 'google';
  if (executablePath) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const profile = path.join(root, 'work', `distribution-profile-${expectedDistribution}-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  if (migrateGoogle) {
    fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({
      settings: { provider: 'google', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
      history: [],
    }), 'utf8');
  }
  const electronApp = await electron.launch({
    ...(executablePath ? { executablePath } : { cwd: root }),
    args: [...(executablePath ? [] : ['.']), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile, LUVOELLE_DISABLE_PADDLE: '1' },
  });
  try {
    const page = await waitForWindow(electronApp, 'index.html');
    const initial = await page.evaluate(() => window.luvoelle.bootstrap());
    assert.equal(initial.settings.provider, expectedProvider);
    if (expectedDistribution === 'friend') {
      assert.equal(initial.settings.endpoint, 'https://api.deepseek.com');
      assert.equal(initial.settings.model, 'deepseek-v4-flash');
      assert.equal(initial.settings.hasDeepSeekApiKey, false);
      assert.equal(initial.settings.distributionDefaultApplied, 'friend-deepseek-v4-flash');
    }
    process.stdout.write(`${JSON.stringify({ packaged: Boolean(executablePath), distribution: expectedDistribution, migratedGoogle: migrateGoogle, provider: initial.settings.provider, endpoint: initial.settings.endpoint, model: initial.settings.model, hasDeepSeekApiKey: initial.settings.hasDeepSeekApiKey })}\n`);
  } finally {
    await electronApp.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
