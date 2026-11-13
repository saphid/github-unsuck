import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import worker, { themeForHostname } from './worker.candidate.mjs';

const get = (url, headers = {}) => worker.fetch(new Request(url, { headers }), {}, {});
const page = async (url) => { const response = await get(url); return { response, html: await response.text() }; };
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const themeIds = ['dark', 'light', 't3-code-dark', 't3-code-light', 't3-chat-dark', 't3-chat-light', 'hotdog', 'vscode-dark', 'vscode-light', 'catppuccin-mocha', 'catppuccin-latte', 'dracula', 'nord', 'one-dark-pro', 'solarized-dark', 'solarized-light'];

test('the home page keeps every element its script drives', async () => {
  const { response, html } = await page('https://dimgithub.com/');
  assert.equal(response.status, 200);
  const found = ids(html);
  for (const id of ['builder', 'github-url', 'theme', 'swatches', 'swatch-label', 'browse-themes', 'result', 'output', 'copy', 'original', 'status', 'card', 'demo', 'demo-sub', 'demo-theme']) {
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

// A small stand-in DOM: enough to run the builder's inline script and observe what it
// does, so the tests fail if the page starts making requests or building links differently.
class FakeElement {
  constructor() {
    this.dataset = {}; this.attributes = {}; this.listeners = {}; this.hidden = false; this.textContent = ''; this.value = '';
    this.properties = {}; this.style = { setProperty: (name, value) => { this.properties[name] = value; } };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  dispatchEvent(event) { for (const listener of this.listeners[event.type] ?? []) listener(event); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {} }); }
  setCustomValidity() {} reportValidity() {} focus() {} select() {}
}

async function runBuilder(url, { reducedMotion = false } = {}) {
  const { html } = await page(url);
  // Visibility starts from the markup, as it would in a browser.
  const startsHidden = (pattern) => /\shidden(?=[\s>])/.test(html.match(pattern)?.[0] ?? '');
  const elements = Object.fromEntries(ids(html).map((id) => [id, Object.assign(new FakeElement(), { hidden: startsHidden(new RegExp(`<[^>]*\\sid="${id}"[^>]*>`)) })]));
  const dataAttributes = (tag) => Object.fromEntries([...tag.matchAll(/data-([a-z]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
  const swatches = [...html.matchAll(/<button type="button" class="swatch"[^>]*>/g)].map((match) => Object.assign(new FakeElement(), { dataset: dataAttributes(match[0]) }));
  const segments = [...html.matchAll(/<button type="button" data-state="[^"]*"[^>]*>/g)].map((match) => Object.assign(new FakeElement(), { dataset: dataAttributes(match[0]) }));
  const options = Object.assign(new FakeElement(), { hidden: startsHidden(/<div class="options"[^>]*>/) });
  const segmentGroup = Object.assign(new FakeElement(), { hidden: startsHidden(/<div class="seg"[^>]*>/) });
  elements.theme.value = html.match(/<option value="([^"]+)" selected>/)?.[1] ?? 'dark';
  elements['github-url'].value = html.match(/id="github-url" name="url" type="text" value="([^"]*)"/)[1];
  elements.builder.elements = { url: elements['github-url'], theme: elements.theme };
  elements.demo.querySelectorAll = (selector) => (selector === '.seg button' ? segments : []);
  elements.demo.querySelector = (selector) => (selector === '.seg' ? segmentGroup : null);
  const requests = [], windowListeners = {}, timers = [];
  const sandbox = {
    URL, URLSearchParams, AbortSignal, Event, TextEncoder,
    location: new URL(url),
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', clipboard: { writeText: async () => {} } },
    document: {
      prerendering: false,
      getElementById: (id) => elements[id] ?? null,
      querySelectorAll: (selector) => (selector === '.swatch' ? swatches : []),
      querySelector: (selector) => (selector === '.options' ? options : null),
      addEventListener() {},
    },
    fetch: (target, init = {}) => { requests.push({ target: String(target), body: init.body ? JSON.parse(init.body) : undefined }); return Promise.resolve(new Response(null, { status: 204 })); },
    matchMedia: (query) => ({ matches: reducedMotion && query.includes('reduced-motion') }),
    setTimeout: (callback, delay) => timers.push({ callback, delay }), clearTimeout() {},
    addEventListener: (type, listener) => { (windowListeners[type] ??= []).push(listener); },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], sandbox);
  const sent = () => requests.map((request) => [request.target, request.body?.event]);
  return { html, elements, swatches, segments, options, segmentGroup, requests, sent, windowListeners, timers };
}

test('loading the builder sends one page view and loads no card', async () => {
  const dom = await runBuilder('https://dimgithub.com/make');
  assert.deepEqual(dom.sent(), [['/api/events', 'page_view']]);
  assert.equal(dom.elements.result.hidden, true);
  assert.equal(dom.segments.length, 2);
  assert.equal(dom.elements.card.src, undefined);
  assert.equal(dom.elements.swatches.hidden, false);
  assert.equal(dom.options.hidden, true);
  assert.equal(dom.segmentGroup.hidden, false);
  assert.equal(dom.elements.demo.dataset.state, 'before');
  assert.deepEqual(dom.timers.map((timer) => timer.delay), [1400]);
  dom.timers[0].callback();
  assert.equal(dom.elements.demo.dataset.state, 'after');
});

test('reduced motion skips the introductory flash', async () => {
  const dom = await runBuilder('https://dimgithub.com/make', { reducedMotion: true });
  assert.equal(dom.elements.demo.dataset.state, 'after');
  assert.equal(dom.timers.length, 0);
});

test('a swatch drives the select, repaints the demo, and makes no image request', async () => {
  const dom = await runBuilder('https://dimgithub.com/make');
  dom.swatches.find((swatch) => swatch.dataset.theme === 'nord').click();
  assert.equal(dom.elements.theme.value, 'nord');
  assert.deepEqual(dom.sent(), [['/api/events', 'page_view'], ['/api/events', 'theme_selected']]);
  assert.equal(dom.requests[1].body.theme, 'nord');
  assert.equal(dom.elements.demo.properties['--t-bg'], '#2e3440');
  assert.equal(dom.elements.demo.properties['--t-on'], '#eceff4');
  assert.equal(dom.elements['demo-sub'].textContent, 'nord.');
  assert.equal(dom.elements.demo.dataset.state, 'after');
  assert.equal(dom.elements.card.src, undefined);
  assert.deepEqual(dom.swatches.filter((swatch) => swatch.attributes['aria-pressed'] === 'true').map((swatch) => swatch.dataset.theme), ['nord']);
  // Choosing the theme already selected is not a change and sends nothing.
  dom.swatches.find((swatch) => swatch.dataset.theme === 'nord').click();
  assert.equal(dom.requests.length, 2);
});

test('submitting builds the same link and image request as before the redesign', async () => {
  const dom = await runBuilder('https://dimgithub.com/make');
  dom.swatches.find((swatch) => swatch.dataset.theme === 'dracula').click();
  dom.elements['github-url'].value = 'pingdotgg/t3code';
  assert.equal(dom.elements.result.hidden, true);
  dom.elements.builder.dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(dom.elements.output.value, 'https://dimgithub.com/u?url=https%3A%2F%2Fgithub.com%2Fpingdotgg%2Ft3code&theme=dracula');
  assert.equal(dom.elements.card.src, 'https://dimgithub.com/image?url=https%3A%2F%2Fgithub.com%2Fpingdotgg%2Ft3code&theme=dracula');
  assert.equal(dom.elements.original.href, 'https://github.com/pingdotgg/t3code');
  assert.equal(dom.elements.result.hidden, false);
  assert.deepEqual(dom.sent(), [['/api/events', 'page_view'], ['/api/events', 'theme_selected'], ['/api/events', 'link_created']]);
});

test('a restored form selection repaints the swatches', async () => {
  const dom = await runBuilder('https://dimgithub.com/make');
  dom.elements.theme.value = 'solarized-light';
  for (const listener of dom.windowListeners.pageshow) listener({ type: 'pageshow' });
  assert.deepEqual(dom.swatches.filter((swatch) => swatch.attributes['aria-pressed'] === 'true').map((swatch) => swatch.dataset.theme), ['solarized-light']);
  assert.equal(dom.elements['demo-sub'].textContent, 'solarized-light.');
  assert.deepEqual(dom.sent(), [['/api/events', 'page_view']]);
});

test('without scripts the form still submits a theme', async () => {
  const { html } = await page('https://light.dimgithub.com/make');
  const form = html.slice(html.indexOf('<form id="builder" action="/u" method="get">'), html.indexOf('</form>'));
  assert.match(form, /<div class="options"><label for="theme">Preview theme<\/label><select name="theme" id="theme">/);
  assert.match(form, /<option value="light" selected>/);
  assert.match(form, /<div class="swatches" id="swatches" hidden>/);
  assert.match(form, /<input id="github-url" name="url" type="text"/);
});

test('the comparison control switches the demo between both states', async () => {
  const dom = await runBuilder('https://dimgithub.com/make', { reducedMotion: true });
  const [original, dimmed] = dom.segments;
  original.click();
  assert.equal(dom.elements.demo.dataset.state, 'before');
  assert.deepEqual(dom.segments.map((segment) => segment.attributes['aria-pressed']), ['true', 'false']);
  dimmed.click();
  assert.equal(dom.elements.demo.dataset.state, 'after');
  assert.deepEqual(dom.sent(), [['/api/events', 'page_view']]);
});

test('every page is dark whatever the system prefers', async () => {
  for (const path of ['/', '/youtube', '/themes', '/u?url=ftp://x']) {
    const { html } = await page('https://dimgithub.com' + path);
    assert.ok(html.includes('<meta name="color-scheme" content="dark">'), path);
    assert.ok(html.includes(':root{color-scheme:dark;--bg:#0a0b0e;'), path);
    assert.ok(!/prefers-color-scheme|light-dark\(|color-scheme:[^;}]*light/.test(html.replace(/<script>[\s\S]*?<\/script>/, '')), path);
  }
  // The redirect interstitial people may glimpse on the way to a link is dark as well.
  const bundle = readFileSync(new URL('./worker.candidate.mjs', import.meta.url), 'utf8');
  assert.ok(bundle.includes('<style>:root{color-scheme:dark}body{margin:0;min-height:100svh;display:grid;place-items:center;background:#0a0b0e;color:#eef0f4;'));
  assert.ok(!bundle.includes('light-dark('));
});

test('theme chips carry their own name and colours', async () => {
  const { html } = await page('https://dimgithub.com/make');
  assert.ok(html.includes('style="--s-bg:#2e3440;--s-fg:#eceff4;--s-ac:#88c0d0">Nord</button>'));
  assert.ok(html.includes('>VS Code Dark+</button>'));
  assert.ok(html.includes('>Catppuccin Mocha</button>'));
  assert.ok(html.includes('>System</button>'));
  assert.equal([...html.matchAll(/<button type="button" class="swatch"[^>]*>[^<]+<\/button>/g)].length, 17);
});
