const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { _electron: electron } = require('playwright');

async function waitForWindow(electronApp, fileName, timeout = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const page = electronApp.windows().find((candidate) => candidate.url().endsWith(`/${fileName}`));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${fileName}`);
}

async function startServer() {
  const stats = { requests: 0, authorization: '', body: null };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      stats.requests += 1;
      stats.authorization = String(request.headers.authorization || '');
      stats.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'DeepSeek translated text' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: `http://127.0.0.1:${server.address().port}`, stats };
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const executablePath = String(process.env.LUVOELLE_PACKAGED_PATH || '').trim();
  if (executablePath) assert.ok(fs.existsSync(executablePath), 'Packaged executable is missing');
  const mock = await startServer();
  const profile = path.join(root, 'work', `deepseek-profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const electronApp = await electron.launch({
    ...(executablePath ? { executablePath } : { cwd: root }),
    args: [...(executablePath ? [] : ['.']), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, LUVOELLE_TEST: '1', LUVOELLE_TEST_USER_DATA: profile, LUVOELLE_DISABLE_PADDLE: '1' },
  });
  try {
    const page = await waitForWindow(electronApp, 'index.html');
    const initial = await page.evaluate(() => window.luvoelle.bootstrap());
    assert.equal(initial.settings.hasDeepSeekApiKey, false);
    await page.evaluate(({ endpoint }) => window.luvoelle.saveSettings({
      provider: 'deepseek',
      endpoint,
      model: 'deepseek-v4-flash',
      apiKey: 'test-deepseek-secret',
    }), { endpoint: mock.endpoint });
    const result = await page.evaluate(() => window.luvoelle.translateText({ text: '请翻译这段中文', targetLanguage: 'en' }));
    assert.equal(result.translation.text, 'DeepSeek translated text');
    assert.equal(result.translation.route, 'deepseek');
    assert.equal(result.translation.provider, 'DeepSeek · deepseek-v4-flash');
    assert.equal(mock.stats.authorization, 'Bearer test-deepseek-secret');
    assert.equal(mock.stats.body.model, 'deepseek-v4-flash');
    assert.deepEqual(mock.stats.body.thinking, { type: 'disabled' });
    assert.ok(mock.stats.body.max_tokens >= 256);
    assert.equal(Object.prototype.hasOwnProperty.call(mock.stats.body, 'reasoning_effort'), false);
    const saved = await page.evaluate(() => window.luvoelle.bootstrap());
    assert.equal(saved.settings.provider, 'deepseek');
    assert.equal(saved.settings.hasDeepSeekApiKey, true);
    assert.equal(saved.settings.hasApiKey, false);
    const rawState = fs.readFileSync(path.join(profile, 'state.json'), 'utf8');
    assert.doesNotMatch(rawState, /test-deepseek-secret/);
    assert.match(rawState, /deepseekApiKeyEncrypted/);
    process.stdout.write(`${JSON.stringify({ packaged: Boolean(executablePath), provider: result.translation.provider, route: result.translation.route, thinking: mock.stats.body.thinking.type, keyEncryptedAtRest: true, requests: mock.stats.requests })}\n`);
  } finally {
    await electronApp.close();
    await new Promise((resolve) => mock.server.close(resolve));
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
