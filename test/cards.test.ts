import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../shared/app.ts';
import { serviceTools } from '../shared/services.ts';

const fixtures = {
  youtube: { title: 'Video & "quotes"', author_name: 'Creator' },
  gitlab: { name_with_namespace: 'Team / Project', description: 'Project description' },
  npm: { name: 'typescript', version: '5.9.0', description: 'JavaScript with types' },
  pypi: { info: { name: 'requests', version: '2.32.0', summary: 'HTTP for humans' } },
  wikipedia: { title: 'TypeScript', extract: 'A programming language' }
};

test('every new service serves themed PNG metadata and forwards to the complete original URL', async () => {
  for (const service of serviceTools.services.filter(item => item.id !== 'github')) {
    const original = new URL(service.example);
    original.searchParams.set('theme', 'original');
    original.searchParams.set('tracking', 'a&b');
    original.hash = 'section';
    const link = new URL(service.route, 'https://wrapper.test');
    link.search = new URLSearchParams({ url: original.href, theme: 'nord' }).toString();
    const fetcher = (async () => new Response(JSON.stringify(fixtures[service.id]), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const page = await handleRequest(link, new Headers(), fetcher, true);
    assert.equal(page.status, 200, service.id);
    assert.match(page.body, new RegExp(`Continue to ${service.name}`));
    assert.match(page.body, /location.replace\(target.href\)/);
    assert.match(page.body, /theme=original&amp;tracking=a%26b#section/);
    const image = new URL(page.body.match(/property="og:image" content="([^"]+)"/)![1].replaceAll('&amp;', '&'));
    assert.equal(image.hostname, 'wsrv.nl');
    assert.equal(image.searchParams.get('output'), 'png');
    const card = new URL(image.searchParams.get('url')!);
    assert.equal(card.origin + card.pathname, 'https://wrapper.test/card.svg');
    assert.equal(card.searchParams.get('service'), service.id);
    assert.equal(card.searchParams.get('theme'), 'nord');
    let calls = 0;
    const svg = await handleRequest(card, new Headers(), (async () => { calls++; throw Error('Card must not fetch'); }) as typeof fetch);
    assert.equal(svg.status, 200);
    assert.equal(svg.headers['Content-Type'], 'image/svg+xml; charset=utf-8');
    assert.match(svg.body, /width="1200" height="600"/);
    for (const color of ['2e3440', 'eceff4', '88c0d0', '3b4252']) assert.ok(svg.body.includes('#' + color));
    assert.match(svg.body, new RegExp(service.name.toUpperCase()));
    assert.equal(calls, 0);
    link.searchParams.set('preview', '1');
    const preview = await handleRequest(link, new Headers(), fetcher);
    assert.doesNotMatch(preview.body, /location.replace/);
  }
});

test('new card images carry imported palettes and honor light/auto appearance', async () => {
  const fetcher = (async () => new Response(JSON.stringify(fixtures.npm), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const link = new URL('https://wrapper.test/npm?url=https://www.npmjs.com/package/typescript&theme=custom&palette=123456-ffffff-ff00ff-234567&name=My%20theme');
  const response = await handleRequest(link, new Headers(), fetcher);
  const png = new URL(response.body.match(/property="og:image" content="([^"]+)"/)![1].replaceAll('&amp;', '&'));
  const card = new URL(png.searchParams.get('url')!);
  assert.equal(card.searchParams.get('palette'), '123456-ffffff-ff00ff-234567');
  assert.equal(card.searchParams.get('name'), 'My theme');
  const svg = await handleRequest(card);
  for (const color of ['123456', 'ffffff', 'ff00ff', '234567']) assert.ok(svg.body.includes('#' + color));
  link.searchParams.delete('palette'); link.searchParams.delete('name'); link.searchParams.set('theme', 'auto');
  const light = await handleRequest(link, new Headers({ 'Sec-CH-Prefers-Color-Scheme': '"light"' }), fetcher);
  assert.equal(light.headers.Vary, 'Sec-CH-Prefers-Color-Scheme');
  assert.match(light.body, /theme%3Dlight/);
  assert.match(light.body, /<picture>/);
});

test('card rendering escapes hostile text, bounds output, and rejects invalid inputs without fetching', async () => {
  const link = new URL('https://wrapper.test/card.svg?service=npm&theme=dark');
  link.searchParams.set('title', '<script>alert("x")</script>' + 'W'.repeat(10000));
  link.searchParams.set('description', '<image href="https://evil.test/pixel"/>');
  link.searchParams.set('path', '\u0000www.npmjs.com/package/x');
  const svg = await handleRequest(link);
  assert.equal(svg.status, 200);
  assert.match(svg.body, /&lt;script&gt;/);
  assert.doesNotMatch(svg.body, /<script|<image|https:\/\/evil.test\/pixel"/);
  assert.ok(svg.body.length < 5000);
  assert.match(svg.body, /…/);
  for (const query of ['service=unknown&title=hello', 'service=npm', 'service=npm&title=hello&theme=custom&palette=invalid']) {
    const response = await handleRequest(new URL('https://wrapper.test/card.svg?' + query));
    assert.equal(response.status, 400);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
});

test('service routes show examples and reject mismatched destinations before network requests', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw Error('unexpected network'); }) as typeof fetch;
  for (const service of serviceTools.services) {
    const page = await handleRequest(new URL(service.route, 'https://wrapper.test'), new Headers(), fetcher, true);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(service.example.replaceAll('&', '&amp;')));
  }
  const mismatch = await handleRequest(new URL('https://wrapper.test/youtube?url=https://www.npmjs.com/package/react'), new Headers(), fetcher);
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body, /Use a YouTube link/);
  assert.equal(calls, 0);
});
