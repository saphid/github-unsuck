import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import worker, { themeForHostname } from './worker.candidate.mjs';

const get = (url, headers = {}) => worker.fetch(new Request(url, { headers }), {}, {});
const page = async (url) => { const response = await get(url); return { response, html: await response.text() }; };
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const themeIds = ['dark', 'light', 't3-code-dark', 't3-code-light', 't3-chat-dark', 't3-chat-light', 'hotdog', 'vscode-dark', 'vscode-light', 'catppuccin-mocha', 'catppuccin-latte', 'dracula', 'nord', 'one-dark-pro', 'solarized-dark', 'solarized-light'];

test('the home page keeps every element its script drives', async () => {
  const { response, html } = await page('https://dimgithub.com/');
  assert.equal(response.status, 200);
  const found = ids(html);
  for (const id of ['builder', 'github-url', 'theme', 'swatches', 'swatch-name', 'browse-themes', 'result', 'output', 'copy', 'original', 'status', 'card', 'demo', 'demo-sub', 'demo-theme']) {
    assert.equal(found.filter((item) => item === id).length, 1, id);
  }
  assert.equal(new Set(found).size, found.length, 'ids are unique');
});

test('every preset is offered as a select option and a swatch', async () => {
  const { html } = await page('https://dimgithub.com/make');
  for (const id of [...themeIds, 'auto']) {
    assert.ok(html.includes(`<option value="${id}"`), `option ${id}`);
    assert.ok(html.includes(`class="swatch" data-theme="${id}"`), `swatch ${id}`);
  }
  // Each advertised theme subdomain is a real route.
  for (const id of themeIds) assert.equal(themeForHostname(`${id}.dimgithub.com`), id);
});

test('inline scripts on every page parse', async () => {
  for (const path of ['/', '/youtube', '/themes', '/make?theme=nord']) {
    const { html } = await page('https://dimgithub.com' + path);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.equal(scripts.length, 1, path);
    assert.doesNotThrow(() => new vm.Script(scripts[0]), path);
  }
});

test('a theme subdomain preselects its theme in the builder and the demo', async () => {
  const { html } = await page('https://nord.dimgithub.com/');
  assert.ok(html.includes('<option value="nord" selected>'));
  assert.match(html, /data-theme="nord"[^>]*aria-pressed="true"/);
  assert.ok(html.includes('--t-bg:#2e3440'));
  assert.ok(html.includes('<span id="demo-sub">nord.</span>dim'));
});

test('an unknown theme falls back to the default palette instead of failing', async () => {
  const { response, html } = await page('https://dimgithub.com/make?theme=bogus');
  assert.equal(response.status, 200);
  assert.ok(html.includes('--t-bg:#0d1117'));
});

test('a crafted theme value cannot close the inline script', async () => {
  for (const path of ['/make', '/themes']) {
    const { html } = await page(`https://dimgithub.com${path}?theme=${encodeURIComponent('</script><script>alert(1)</script>')}`);
    assert.equal(html.split('<script>').length - 1, 1, path);
    assert.equal(html.split('</script>').length - 1, 1, path);
    assert.ok(html.includes('"theme":"\\u003c/script>'), path);
  }
});

test('service pages keep their heading, example and current marker', async () => {
  const { html } = await page('https://dimgithub.com/youtube');
  assert.ok(html.includes('<h1>YouTube links.<br>Your palette.</h1>'));
  assert.ok(html.includes('value="https://www.youtube.com/watch?v=dQw4w9WgXcQ"'));
  assert.ok(html.includes('href="/youtube" aria-current="page"'));
  assert.ok(!html.includes('id="demo-sub"'), 'the dim prefix is a GitHub-only trick');
});

test('pages load nothing the content security policy would block', async () => {
  for (const path of ['/', '/themes', '/u?url=ftp://x']) {
    const { response, html } = await page('https://dimgithub.com' + path);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.ok(!/<link[^>]+rel="stylesheet"|@import|@font-face|url\(/.test(html), path);
    const sources = [...html.matchAll(/<(?:img|script|link)[^>]+(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    for (const source of sources) assert.ok(source.startsWith('/'), `${path} loads ${source}`);
  }
});

test('the favicon is a sandboxed SVG', async () => {
  const response = await get('https://dimgithub.com/favicon.svg');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.match(await response.text(), /^<svg /);
});

test('the theme gallery keeps the elements its script drives', async () => {
  const { html } = await page('https://dimgithub.com/themes');
  const found = ids(html);
  for (const id of ['theme-search', 'appearance', 'theme-library', 'import-details', 'theme-file', 'theme-json', 'import-theme', 'import-status', 'selected-name', 'remove-import', 'palette-preview', 'sample-title', 'sample-service', 'theme-builder', 'github-url', 'output', 'copy-theme-link', 'load-preview', 'open-preview', 'status', 'actual-status', 'actual-card']) {
    assert.equal(found.filter((item) => item === id).length, 1, id);
  }
});
