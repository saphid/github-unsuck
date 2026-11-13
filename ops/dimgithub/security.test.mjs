// Adversarial checks for the public-only worker: it holds no credentials, reads no bindings,
// and can reach nothing but exact public GitHub URLs. Every test drives the real exports
// with a recording fetch, so a request the worker should not make fails the test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as workerExports from './worker.candidate.mjs';
import worker, { proxyRequest, createPublicFetch, publicRequestTarget, themeForHostname } from './worker.candidate.mjs';

const bundle = readFileSync(new URL('./worker.candidate.mjs', import.meta.url), 'utf8');
const UA = 'DimGitHub/0.4 (+https://dimgithub.com)';
const browser = { 'user-agent': 'Mozilla/5.0 (Macintosh)' };

const html = ({ title = 'pingdotgg/t3code', description = 'The T3 code editor', image = 'https://opengraph.githubassets.com/abc/pingdotgg/t3code', extra = '' } = {}) =>
  `<html><head><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="${image}">${extra}</head><body>secret body</body></html>`;
const page = (body = html(), status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location, status = 302) => new Response(null, { status, headers: location === undefined ? {} : { location } });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const image = (bytes, type = 'image/png', extra = {}) => new Response(bytes, { status: 200, headers: { 'content-type': type, ...extra } });

// Answers each outbound request from a script of responses (or a function) and records it.
function recorder(script = () => page()) {
  const calls = [];
  const queue = Array.isArray(script) ? [...script] : null;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const next = queue ? queue.shift() : script(url, init);
    if (next instanceof Error) throw next;
    if (!next) throw new Error('unexpected request to ' + url);
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetcher, calls, urls: () => calls.map((call) => call.url) };
}
async function run(url, { script, headers = {}, method = 'GET' } = {}) {
  const record = recorder(script);
  const response = await proxyRequest(new Request(url, { method, headers }), record.fetcher);
  return { response, body: await response.text(), ...record };
}
const preview = (target, extra = '') => `https://dimgithub.com/u?url=${encodeURIComponent(target)}&preview=1${extra}`;

function assertFixedInit(call, accept) {
  assert.deepEqual(Object.keys(call.init).sort(), [...(call.init.cf ? ['cf'] : []), 'headers', 'method', 'redirect', ...(call.init.signal ? ['signal'] : [])].sort());
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.body, undefined);
  assert.deepEqual(call.init.headers, { Accept: accept, 'User-Agent': UA });
  assert.equal(typeof call.url, 'string');
}

// ---- The entry point ignores bindings ------------------------------------------------------

test('Worker entrypoint exports satisfy the runtime handler contract', () => {
  for (const [name, value] of Object.entries(workerExports)) {
    if (name !== 'default') assert.equal(typeof value, 'function', name);
  }
});

test('the default export reads nothing from env or ctx and has no scheduled handler', async () => {
  const touched = [];
  const trap = (name) => new Proxy({}, { get: (_, key) => { touched.push(`${name}.${String(key)}`); throw new Error('binding read'); }, has: (_, key) => { touched.push(`${name}.${String(key)}`); throw new Error('binding probe'); } });
  const record = recorder();
  const original = globalThis.fetch;
  globalThis.fetch = record.fetcher;
  try {
    const response = await worker.fetch(new Request(preview('pingdotgg/t3code'), { headers: { ...browser, cookie: 'session=abc', authorization: 'Bearer secret' } }), trap('env'), trap('ctx'));
    assert.equal(response.status, 200);
    assert.deepEqual(record.urls(), ['https://github.com/pingdotgg/t3code']);
    assertFixedInit(record.calls[0], 'text/html');
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(touched, []);
  assert.deepEqual(Object.keys(worker), ['fetch']);
  assert.equal(worker.fetch.length, 1, 'the handler does not even accept env');
});

test('the deploy config is credential free: no cron, vars, secrets or bindings', () => {
  const config = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.triggers, { crons: [] });
  for (const key of ['vars', 'ratelimits', 'unsafe', 'kv_namespaces', 'r2_buckets', 'd1_databases', 'services', 'durable_objects', 'queues', 'analytics_engine_datasets', 'ai', 'browser', 'images', 'vectorize', 'hyperdrive', 'secrets_store_secrets', 'send_email', 'mtls_certificates', 'dispatch_namespaces', 'workflows', 'tail_consumers', 'version_metadata']) {
    assert.equal(config[key], undefined, key);
  }
  assert.equal(config.no_bundle, true);
  assert.equal(config.find_additional_modules, false);
  assert.ok(!/BUDGET|POSTHOG|CLOUDFLARE_|ANALYTICS_BURST|api\.cloudflare\.com|posthog|wsrv\.nl|weserv|scheduled\(|\benv\./.test(bundle), 'no management, analytics or binding code remains in the bundle');
});

// ---- The outbound choke point --------------------------------------------------------------

test('the choke point refuses everything but exact public GitHub URLs, without calling fetch', async () => {
  const record = recorder();
  const publicFetch = createPublicFetch(record.fetcher);
  const refused = [
    'http://github.com/a/b', 'https://github.com:8443/a/b', 'https://u:p@github.com/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/b#x',
    'https://GITHUB.COM/a/b', 'https://github.com/a/b/', 'https://github.com/settings', 'https://github.com/login', 'https://github.com/a/b/tree/main',
    'https://github.com/a/b/blob/main/README.md', 'https://github.com/a/b%2fc', 'https://github.com/a/b/../c', 'https://github.com/a/b/pull/1/files',
    'https://github.com.evil.example/a/b', 'https://evil.example/', 'https://wsrv.nl/?url=https://github.com', 'https://us.i.posthog.com/capture/',
    'https://api.cloudflare.com/client/v4/graphql', 'https://api.github.com/graphql', 'https://api.github.com/repos/a/b/contents/x', 'https://api.github.com/search/code',
    'https://api.github.com/repos/a/b?per_page=100', 'https://api.github.com/user', 'https://avatars.githubusercontent.com/u/1?s=99999', 'https://avatars.githubusercontent.com/in/1',
    'https://avatars.githubusercontent.com/u/1/../../x', 'https://raw.githubusercontent.com/a/b/main/x', 'https://gist.github.com/a', 'https://codeload.github.com/a/b/zip/main',
    'https://169.254.169.254/latest/meta-data/', 'https://metadata.google.internal/', 'https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'https://10.0.0.1/',
    'https://192.168.1.1/', 'https://0x7f000001/', 'file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)', 'https://github.com/a\\b', 'https://github.com/a/b\n',
  ];
  for (const url of refused) {
    assert.equal(publicRequestTarget(url), undefined, url);
    await assert.rejects(publicFetch(url), /outside public GitHub/, url);
  }
  for (const value of [new URL('https://github.com/a/b'), new Request('https://github.com/a/b'), undefined, null, 42, { href: 'https://github.com/a/b' }]) {
    await assert.rejects(publicFetch(value), /outside public GitHub/);
  }
  assert.equal(record.calls.length, 0);
});

test('the choke point sends one fixed credential-free GET whatever the caller passes', async () => {
  const record = recorder(() => page());
  const publicFetch = createPublicFetch(record.fetcher);
  await publicFetch('https://github.com/a/b', { method: 'POST', body: 'x', credentials: 'include', headers: { Cookie: 'a=b', Authorization: 'Bearer x' }, redirect: 'follow' });
  await publicFetch('https://github.com/a/b/pull/7');
  await publicFetch('https://avatars.githubusercontent.com/u/9?s=200&v=4');
  await publicFetch('https://api.github.com/repos/a/b/issues/3');
  assert.deepEqual(record.urls(), ['https://github.com/a/b', 'https://github.com/a/b/pull/7', 'https://avatars.githubusercontent.com/u/9?s=200&v=4', 'https://api.github.com/repos/a/b/issues/3']);
  assertFixedInit(record.calls[0], 'text/html');
  assertFixedInit(record.calls[2], 'image/png,image/jpeg,image/gif,image/webp');
  assertFixedInit(record.calls[3], 'application/vnd.github+json');
  assert.equal(record.calls[0].init.cf, undefined);
  assert.deepEqual(record.calls[3].init.cf, { cacheEverything: true, cacheTtlByStatus: { '200-299': 600, '400-599': -1 } });
});

test('incoming cookies, auth and client headers never reach GitHub', async () => {
  const headers = { ...browser, cookie: 'session=abc', authorization: 'Bearer secret', 'proxy-authorization': 'Basic x', 'x-forwarded-for': '10.0.0.1', 'cf-connecting-ip': '1.2.3.4', 'x-github-token': 'ghp_x', 'sec-ch-prefers-color-scheme': 'light' };
  for (const method of ['GET', 'HEAD']) {
    const { response, calls } = await run(preview('pingdotgg/t3code'), { headers, method });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assertFixedInit(calls[0], 'text/html');
    const sent = JSON.stringify(calls[0].init);
    for (const value of ['session=abc', 'secret', 'Basic x', '10.0.0.1', '1.2.3.4', 'ghp_x', 'Mozilla']) assert.ok(!sent.includes(value), value);
  }
});

// ---- Which GitHub links are accepted -------------------------------------------------------

test('only meaningful public GitHub paths are fetched, without their query', async () => {
  const accepted = [
    ['pingdotgg/t3code', 'https://github.com/pingdotgg/t3code'],
    ['https://github.com/pingdotgg/t3code?tab=readme-ov-file&access_token=x', 'https://github.com/pingdotgg/t3code'],
    ['github.com/torvalds', 'https://github.com/torvalds'],
    ['https://www.github.com/a/b/', 'https://github.com/a/b'],
    ['https://github.com/a/b/pull/12/files', 'https://github.com/a/b/pull/12'],
    ['https://github.com/a/b/issues/3#issuecomment-9', 'https://github.com/a/b/issues/3'],
    ['https://github.com/a/b/discussions/5', 'https://github.com/a/b/discussions/5'],
    ['https://github.com/a/b/commit/0123abcd', 'https://github.com/a/b/commit/0123abcd'],
    ['https://github.com/a/.github', 'https://github.com/a/.github'],
  ];
  for (const [input, fetched] of accepted) {
    const { response, urls } = await run(preview(input));
    assert.equal(response.status, 200, input);
    assert.deepEqual(urls(), [fetched], input);
  }
  const { urls } = await run('https://nord.dimgithub.com/pingdotgg/t3code?tab=x&token=y', { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' } });
  assert.deepEqual(urls(), ['https://github.com/pingdotgg/t3code']);
});

test('encoded slashes, traversal, control characters and other hosts are refused before any fetch', async () => {
  const refused = [
    'https://github.com/a/b%2f..%2f..%2fsettings', 'https://github.com/a%2Fb', 'https://github.com/a/b%00', 'https://github.com/a/../settings', 'https://github.com/a/b/../../login',
    'https://github.com/a/%2e%2e', 'https://github.com/a\\b', 'https://github.com/a/b\u0000', 'https://github.com/a/b‮', 'https://github.com//evil.example', 'http://github.com/a/b',
    'https://github.com:443/a/b', 'https://user:pass@github.com/a/b', 'https://github.com@evil.example/a/b', 'https://github.com.evil.example/a/b', '//evil.example/a/b',
    'https://evil.example/a/b', 'https://gist.github.com/a/b', 'https://api.github.com/repos/a/b', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'https://github.com/settings/tokens', 'https://github.com/login', 'https://github.com/a/b/tree/main', 'https://github.com/a/b/blob/main/x', 'https://github.com/a/b/pull/0',
    'https://github.com/a/b/commit/zzzz', 'https://github.com/-a/b', 'https://github.com/' + 'a'.repeat(40), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'http://169.254.169.254/latest/meta-data/',
  ];
  for (const target of refused) {
    const { response, calls } = await run(preview(target));
    assert.equal(response.status, 400, target);
    assert.equal(calls.length, 0, target);
  }
  // Path mode on the site and theme subdomains goes through the same parser.
  for (const url of ['https://dimgithub.com/a/b%2F..%2F..%2Fsettings', 'https://nord.dimgithub.com/a/b/tree/main', 'https://dimgithub.com/settings', 'https://dimgithub.com/a/b%5Cc', 'https://dimgithub.com/a/b/%2e%2e/%2e%2e/login']) {
    const { response, calls } = await run(url);
    assert.ok([400, 404].includes(response.status), url);
    assert.equal(calls.length, 0, url);
  }
});

test('navigations redirect only to the validated GitHub URL', async () => {
  const navigate = { ...browser, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const { response, calls } = await run('https://dimgithub.com/u?url=' + encodeURIComponent('https://github.com/a/b/issues/3?x=%0d%0aSet-Cookie:a#issuecomment-1'), { headers: navigate });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://github.com/a/b/issues/3#issuecomment-1');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(calls.length, 0);
  const hostile = await run('https://dimgithub.com/u?url=' + encodeURIComponent('https://github.com/a/b#"><script>alert(1)</script>'), { headers: navigate });
  assert.equal(hostile.response.headers.get('location'), 'https://github.com/a/b');
});

// ---- Redirects from GitHub -----------------------------------------------------------------

test('GitHub redirects are followed only to valid public GitHub paths', async () => {
  const renamed = await run(preview('old/name'), { script: [redirect('https://github.com/fresh/name?from=old', 301), page()] });
  assert.equal(renamed.response.status, 200);
  assert.deepEqual(renamed.urls(), ['https://github.com/old/name', 'https://github.com/fresh/name']);
  const relative = await run(preview('a/b/issues/3'), { script: [redirect('/a/b/pull/3'), page()] });
  assert.deepEqual(relative.urls(), ['https://github.com/a/b/issues/3', 'https://github.com/a/b/pull/3']);

  const hostile = [
    'https://evil.example/a/b', 'http://github.com/a/b', 'https://github.com:8443/a/b', 'https://user@github.com/a/b', '//evil.example/a/b', 'https://github.com.evil.example/a/b',
    'https://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/a/b', 'https://[::1]/a/b', 'https://localhost/a/b', 'https://10.1.2.3/a/b', 'https://api.github.com/repos/a/b',
    'https://raw.githubusercontent.com/a/b/main/x', '/login?return_to=%2Fa%2Fb', '/settings', '/a/b/../../settings', '/a%2fb', '/a/b%5c..', '\\\\evil.example\\a', '/a/b\tx',
    'javascript:alert(1)', 'data:text/html,x', '', undefined,
  ];
  for (const location of hostile) {
    const { response, body, calls } = await run(preview('a/b'), { script: [redirect(location), page()] });
    assert.equal(response.status, 502, String(location));
    assert.equal(calls.length, 1, `${location} must not be fetched, and no API fallback runs`);
    assert.ok(body.includes('GitHub returned an unsupported redirect.'), String(location));
    assert.ok(!body.includes('evil.example') && !body.includes('169.254'), String(location));
  }
  const loop = await run(preview('a/b'), { script: () => redirect('https://github.com/a/b', 301) });
  assert.equal(loop.response.status, 502);
  assert.equal(loop.calls.length, 4);
});

// ---- Hostile GitHub content ----------------------------------------------------------------

test('hostile page metadata is escaped and never becomes markup or script', async () => {
  const evil = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;';
  const script = () => page(html({ title: evil, description: `</title><script>alert(3)</script>${evil}`, image: 'https://opengraph.githubassets.com/x/a/b?q=%22%3E%3Cscript%3Ealert(4)%3C/script%3E', extra: `<meta property="og:image:alt" content="${evil}">` }));
  for (const url of [preview('a/b'), 'https://dimgithub.com/u?url=a/b']) {
    const { response, body } = await run(url, { script, headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' } });
    assert.equal(response.status, 200, url);
    assert.ok(!/<script>alert|<img src=x|onerror=alert\(2\)>|"><script/i.test(body), url);
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), url);
    assert.ok(!/content="[^"]*"[^ >]/.test(body.slice(0, body.indexOf('<style>'))), 'no attribute breaks out of its quotes');
    const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.every((source) => !source.includes('alert')), url);
    assert.ok(!/unsuckTrack|api\/events/.test(body), url);
  }
});

test('preview images outside GitHub image hosts are refused', async () => {
  for (const image of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', 'https://evil.example/x.png', 'http://opengraph.githubassets.com/x', 'https://opengraph.githubassets.com:8443/x', 'https://u@avatars.githubusercontent.com/u/1', 'https://169.254.169.254/x', '//evil.example/x']) {
    const { response, urls, body } = await run(preview('a/b'), { script: [page(html({ image })), page('', 503)] });
    assert.equal(response.status, 502, image);
    // The page is refused; the only other request is the exact public REST fallback.
    assert.deepEqual(urls(), ['https://github.com/a/b', 'https://api.github.com/repos/a/b'], image);
    assert.ok(!body.includes('evil.example') && !body.includes('onload'), image);
  }
});

test('the /image route redirects to the GitHub image itself and fetches nothing else', async () => {
  const { response, urls } = await run('https://dimgithub.com/image?url=pingdotgg/t3code&theme=dracula');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://opengraph.githubassets.com/abc/pingdotgg/t3code');
  assert.deepEqual(urls(), ['https://github.com/pingdotgg/t3code']);
});

test('oversized or non-HTML GitHub responses are refused', async () => {
  const big = await run(preview('a/b'), { script: [page('<html><head>' + 'x'.repeat(1024 * 1024 + 10))] });
  assert.equal(big.response.status, 502);
  const json = await run(preview('a/b'), { script: [new Response('{}', { headers: { 'content-type': 'application/json' } })] });
  assert.equal(json.response.status, 400);
});

// ---- The API fallback ----------------------------------------------------------------------

test('the API fallback reads only exact public REST routes', async () => {
  const repo = { full_name: 'a/b', description: '<script>alert(1)</script>', updated_at: '2026-11-01T00:00:00Z', private: false };
  const api = (body) => Response.json(body);
  const fallback = await run(preview('a/b'), { script: [page('', 429), api(repo)] });
  assert.equal(fallback.response.status, 200);
  assert.deepEqual(fallback.urls(), ['https://github.com/a/b', 'https://api.github.com/repos/a/b']);
  assertFixedInit(fallback.calls[1], 'application/vnd.github+json');
  assert.ok(!fallback.body.includes('<script>alert'));

  const issue = await run(preview('a/b/pull/7/files'), { script: [page('', 503), api({ title: 'Fix', body: 'x', updated_at: 'now' })] });
  assert.deepEqual(issue.urls(), ['https://github.com/a/b/pull/7', 'https://api.github.com/repos/a/b/issues/7']);
  const user = await run(preview('torvalds'), { script: [page('', 503), api({ login: 'torvalds', avatar_url: 'https://avatars.githubusercontent.com/u/1024025?v=4' })] });
  assert.deepEqual(user.urls(), ['https://github.com/torvalds', 'https://api.github.com/users/torvalds']);

  const moved = await run(preview('a/b'), { script: [page('', 503), redirect('https://api.github.com/repositories/42', 301), api(repo)] });
  assert.deepEqual(moved.urls(), ['https://github.com/a/b', 'https://api.github.com/repos/a/b', 'https://api.github.com/repositories/42']);
  for (const location of ['https://api.github.com/graphql', 'https://api.github.com/repos/a/b/contents/.env', 'https://evil.example/', 'https://169.254.169.254/', '/repos/a/b/../../graphql', 'https://api.github.com:8443/repos/a/b']) {
    const { response, calls } = await run(preview('a/b'), { script: [page('', 503), redirect(location)] });
    assert.equal(response.status, 502, location);
    assert.equal(calls.length, 2, location);
  }
  const stripped = await run(preview('a/b'), { script: [page('', 503), redirect('https://api.github.com/repositories/42?access_token=x#y', 301), api(repo)] });
  assert.equal(stripped.urls()[2], 'https://api.github.com/repositories/42', 'a redirect query is dropped, never forwarded');
  const hidden = await run(preview('a/b'), { script: [page('', 503), api({ ...repo, private: true })] });
  assert.equal(hidden.response.status, 404);
  // Discussions and commits have no exact REST route here, so they never fall back.
  for (const target of ['a/b/discussions/1', 'a/b/commit/abcdef1']) {
    const { response, calls } = await run(preview(target), { script: [page('', 503)] });
    assert.equal(response.status, 502, target);
    assert.equal(calls.length, 1, target);
  }
});

// ---- The avatar card -----------------------------------------------------------------------

const card = (avatar, extra = '') => `https://dimgithub.com/github-card.svg?title=${encodeURIComponent('</text><script>alert(1)</script>')}&description=d&path=github.com/a/b&avatar=${encodeURIComponent(avatar)}${extra}`;

test('the avatar card fetches the public avatar directly and embeds only validated raster data', async () => {
  const { response, body, calls } = await run(card('https://avatars.githubusercontent.com/u/123?s=1&v=4&evil=1', '&theme=custom&palette=000000-ffffff-ff0000-111111&name=' + encodeURIComponent('"/><script>alert(2)</script>')), { script: [image(PNG)] });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.url), ['https://avatars.githubusercontent.com/u/123?s=200&v=4']);
  assertFixedInit(calls[0], 'image/png,image/jpeg,image/gif,image/webp');
  assert.ok(body.includes(`xlink:href="data:image/png;base64,${Buffer.from(PNG).toString('base64')}"`));
  assert.ok(!body.includes('<script'));
  assert.ok(body.includes('&quot;/&gt;&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.ok(body.includes('&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  const jpeg = await run(card('https://avatars.githubusercontent.com/u/5'), { script: [image(JPEG, 'image/jpeg; charset=binary')] });
  assert.ok(jpeg.body.includes('data:image/jpeg;base64,'));
});

test('avatar values outside avatars.githubusercontent.com/u/<id> are refused before any fetch', async () => {
  for (const avatar of ['https://wsrv.nl/?url=https://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com/u/abc', 'https://avatars.githubusercontent.com/u/1/../../x', 'https://avatars.githubusercontent.com/in/1', 'https://evil.example/u/1', 'http://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com:444/u/1', 'https://x@avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com.evil.example/u/1', 'data:image/png;base64,AAAA', 'https://169.254.169.254/u/1', 'https://avatars.githubusercontent.com/u/1?x="><script>']) {
    const { response, calls } = await run(card(avatar));
    assert.equal(response.status, 400, avatar);
    assert.equal(calls.length, 0, avatar);
  }
});

test('avatar responses must be bounded raster images that match their type', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const huge = new Uint8Array(400 * 1024 + 1); huge.set(PNG);
  const streamed = () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 50; i++) controller.enqueue(new Uint8Array(10 * 1024)); controller.close(); } }), { headers: { 'content-type': 'image/png' } });
  const cases = {
    'svg declared as svg': image(svg, 'image/svg+xml'),
    'svg declared as png': image(svg, 'image/png'),
    'html': image(new TextEncoder().encode('<html>'), 'text/html'),
    'jpeg declared as png': image(JPEG, 'image/png'),
    'no content type': new Response(PNG),
    'declared too large': image(PNG, 'image/png', { 'content-length': String(400 * 1024 + 1) }),
    'actually too large': image(huge, 'image/png'),
    'streamed too large': streamed(),
    'tiny': image(PNG.slice(0, 8), 'image/png'),
    'not found': new Response('missing', { status: 404, headers: { 'content-type': 'image/png' } }),
    'network failure': new Error('connect ECONNREFUSED 10.0.0.5 token=SECRET123'),
  };
  for (const [name, answer] of Object.entries(cases)) {
    const { response, body, calls } = await run(card('https://avatars.githubusercontent.com/u/1'), { script: [answer] });
    assert.equal(response.status, 502, name);
    assert.equal(calls.length, 1, name);
    assert.ok(body.includes('The original GitHub avatar could not be loaded.'), name);
    assert.ok(!body.includes('SECRET123') && !body.includes('10.0.0.5') && !body.includes('base64'), name);
  }
});

test('avatar redirects are revalidated at every hop', async () => {
  const moved = await run(card('https://avatars.githubusercontent.com/u/1'), { script: [redirect('https://avatars.githubusercontent.com/u/2?v=4&x=1'), image(PNG)] });
  assert.equal(moved.response.status, 200);
  assert.deepEqual(moved.calls.map((call) => call.url), ['https://avatars.githubusercontent.com/u/1?s=200&v=4', 'https://avatars.githubusercontent.com/u/2?s=200&v=4']);
  for (const location of ['https://wsrv.nl/?url=x', 'https://evil.example/u/1', 'https://169.254.169.254/latest/meta-data/', 'http://avatars.githubusercontent.com/u/2', 'https://avatars.githubusercontent.com/in/2', 'https://avatars.githubusercontent.com/u/2/../../x', '//evil.example/u/1', 'https://127.0.0.1/u/1', 'https://avatars.githubusercontent.com%2f@evil.example/u/1']) {
    const { response, calls } = await run(card('https://avatars.githubusercontent.com/u/1'), { script: [redirect(location), image(PNG)] });
    assert.equal(response.status, 502, location);
    assert.equal(calls.length, 1, location);
  }
  const loop = await run(card('https://avatars.githubusercontent.com/u/1'), { script: () => redirect('/u/1') });
  assert.equal(loop.response.status, 502);
  assert.equal(loop.calls.length, 3);
});

// ---- Disabled services, analytics and management -------------------------------------------

test('analytics, statistics and retired services answer locally and fetch nothing', async () => {
  const cases = [
    ['POST', 'https://dimgithub.com/api/events', 410], ['GET', 'https://dimgithub.com/api/events', 410], ['GET', 'https://dimgithub.com/stats', 410],
    ['GET', 'https://dimgithub.com/stats/logout', 410], ['POST', 'https://dimgithub.com/stats', 410], ['GET', 'https://dimgithub.com/api/stats', 410],
    ['GET', 'https://dimgithub.com/api/anything', 404], ['POST', 'https://dimgithub.com/u?url=a/b', 405], ['PUT', 'https://dimgithub.com/', 405],
    ['GET', 'https://dimgithub.com/youtube?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ', 404], ['GET', 'https://dimgithub.com/npm?url=https://www.npmjs.com/package/x', 404],
    ['GET', 'https://dimgithub.com/gitlab', 404], ['GET', 'https://dimgithub.com/pypi', 404], ['GET', 'https://dimgithub.com/wikipedia', 404],
    ['GET', 'https://dimgithub.com/card.svg?service=npm&title=x', 404], ['GET', 'https://evil.example/', 404], ['GET', 'https://__proto__.dimgithub.com/', 404],
    ['GET', 'https://constructor.dimgithub.com/', 404],
  ];
  for (const [method, url, status] of cases) {
    const body = method === 'POST' ? JSON.stringify({ event: 'page_view', page: 'builder' }) : undefined;
    const record = recorder();
    const response = await proxyRequest(new Request(url, { method, body, headers: { origin: new URL(url).origin, 'content-type': 'application/json' } }), record.fetcher);
    assert.equal(response.status, status, `${method} ${url}`);
    assert.equal(response.headers.get('location'), null, `${method} ${url}`);
    assert.equal(record.calls.length, 0, `${method} ${url}`);
  }
  assert.equal(themeForHostname('__proto__.dimgithub.com'), undefined);
  assert.equal(themeForHostname('solarize.dimgithub.com'), 'solarized-dark');
});

test('site pages fetch nothing and carry no tracker', async () => {
  for (const path of ['/', '/make', '/github', '/themes', '/make?theme=nord', '/favicon.svg', '/api/health', '/robots.txt', '/u?url=ftp://x']) {
    const { response, body, calls } = await run('https://dimgithub.com' + path, { headers: browser });
    assert.ok(response.status < 500, path);
    assert.equal(calls.length, 0, path);
    assert.ok(!/unsuckTrack|api\/events|posthog|wsrv/i.test(body), path);
  }
  const { response } = await run('https://dimgithub.com/');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.ok(!response.headers.get('content-security-policy').includes('wsrv'));
});

test('a crawler unfurl makes exactly one GitHub request and nothing else', async () => {
  for (const agent of ['Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'WhatsApp/2', 'TelegramBot']) {
    const { response, urls } = await run('https://dark.dimgithub.com/pingdotgg/t3code/pull/12', { headers: { 'user-agent': agent } });
    assert.equal(response.status, 200, agent);
    assert.deepEqual(urls(), ['https://github.com/pingdotgg/t3code/pull/12'], agent);
  }
});

// ---- Errors --------------------------------------------------------------------------------

test('errors never echo upstream details', async () => {
  const leaks = [
    new Error('getaddrinfo 10.0.0.5 Authorization: Bearer SECRET123'),
    new Response('SECRET123 internal stack at 10.0.0.5', { status: 500, headers: { 'content-type': 'text/plain' } }),
    new Response('SECRET123', { status: 418 }),
    page('<html><head><meta property="og:title" content="x"></head>SECRET123'),
  ];
  for (const answer of leaks) {
    const { response, body } = await run(preview('a/b/discussions/1'), { script: [answer] });
    assert.ok(response.status >= 400);
    assert.ok(!body.includes('SECRET123') && !body.includes('10.0.0.5'), body.slice(-300));
  }
  const thrown = await proxyRequest(new Request(preview('a/b')), () => { throw new Error('SECRET123'); });
  assert.ok(!(await thrown.text()).includes('SECRET123'));
});
