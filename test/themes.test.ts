import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { themeTools, createThemeTools } from '../shared/themes.ts';
import { themePageScript } from '../shared/theme-page.ts';
import { handleRequest } from '../shared/app.ts';
import { PRESET_THEMES, makeShareLink } from '../extension/links.js';
import { createActions } from '../extension/background.js';

const source = 'https://opengraph.githubassets.com/abc/owner/repo';
const fetcher = (async () => new Response(`<meta property="og:title" content="owner/repo"><meta property="og:image" content="${source}">`, { headers: { 'Content-Type': 'text/html' } })) as typeof fetch;

test('imports JSONC workbench colors, comments, trailing commas, and alpha', () => {
  const theme = themeTools.importTheme(`{
    // Strings containing // and /* are preserved.
    "name": "A // theme /* title */",
    "type": "dark",
    "colors": {
      "editor.background": "#102030",
      "editor.foreground": "#fff8",
      "focusBorder": "#ff000080",
      "sideBar.background": "#0008", /* trailing comma */
    },
  }`);
  assert.equal(theme.name, 'A // theme /* title */');
  assert.equal(theme.appearance, 'dark');
  assert.deepEqual(theme.colors, ['102030', '8f979e', '881018', '070f16']);
  assert.equal(themeTools.color('#f008', '000000'), '880000');
  assert.equal(themeTools.color('#abc'), 'aabbcc');
  assert.equal(themeTools.color('#ffffff00', '123456'), '123456');
});

test('sparse light themes derive readable colors and low-contrast text is repaired', () => {
  const light = themeTools.importTheme('{"type":"light","colors":{"editor.background":"#fdf6e3"}}');
  assert.equal(light.appearance, 'light');
  assert.equal(light.colors[0], 'fdf6e3');
  assert.equal(light.colors[1], '1f2328');
  assert.equal(light.colors.length, 4);
  const dark = themeTools.importTheme('{"colors":{"editor.background":"#222222","editor.foreground":"#222222","focusBorder":"url(https://evil.test)"}}');
  assert.equal(dark.colors[1], 'ffffff');
  assert.ok(dark.colors.every(c => /^[a-f0-9]{6}$/.test(c)));
});

test('rejects malformed, oversized, inherited and non-theme inputs', () => {
  for (const value of ['null', '[]', '{}', '{"colors":[]}', '{"contributes":{"themes":[]}}', '{"colors":{"editor.foreground":"#fff"}}', '{"colors":{"editor.background":"red"}}', '{"colors":{"editor.background":"#000"},"include":"https://evil.test/a"}', '{"colors":{"editor.background":"#000"} /*']) {
    assert.throws(() => themeTools.importTheme(value));
  }
  assert.throws(() => themeTools.importTheme(' '.repeat(262145)), /256 KB/);
  assert.throws(() => themeTools.importTheme('深'.repeat(100000)), /256 KB/);
  for (const value of ['red', '#12345', '#123456789', 'url(https://evil.test)', '#ffffff; color:red']) assert.equal(themeTools.color(value), null);
  assert.throws(() => themeTools.resolve('custom', '000000-ffffff-abc123-12345z'));
  assert.throws(() => themeTools.resolve('dracula', '000000-ffffff-abcdef-123456'));
});

test('custom links roundtrip complete palettes, labels and original GitHub query/fragment', () => {
  const imported = themeTools.importTheme('{"name":"My theme","colors":{"editor.background":"#161622","editor.foreground":"#eee"}}');
  const original = 'https://github.com/owner/repo?theme=original&tab=readme#install';
  const link = new URL('/u', 'https://wrapper.test');
  link.search = themeTools.parameters(imported).toString();
  link.searchParams.set('url', original);
  const restored = themeTools.resolve(link.searchParams.get('theme'), link.searchParams.get('palette'), link.searchParams.get('name'));
  assert.deepEqual(restored, imported);
  assert.equal(link.searchParams.get('url'), original);
  assert.ok(link.href.length < 500);
});

test('named and imported themes recolor actual PNG redirects and crawler OG images', async () => {
  for (const theme of [...themeTools.presets.filter(theme => theme.id !== 'light'), themeTools.importTheme('{"colors":{"editor.background":"#123456","editor.foreground":"#ffffff"}}')]) {
    const url = new URL('/image', 'https://wrapper.test');
    url.search = themeTools.parameters(theme).toString();
    url.searchParams.set('url', 'https://github.com/owner/repo?tab=readme#readme');
    const image = await handleRequest(url, new Headers(), fetcher);
    assert.equal(image.status, 302);
    const png = new URL(image.headers.Location);
    assert.equal(png.hostname, 'wsrv.nl');
    assert.equal(png.searchParams.get('start'), theme.colors[1]);
    assert.equal(png.searchParams.get('stop'), theme.colors[0]);
    assert.equal(png.searchParams.get('output'), 'png');
    assert.equal(png.searchParams.get('url'), source);
    url.pathname = '/u';
    const page = await handleRequest(url, new Headers(), fetcher);
    assert.equal(page.status, 200);
    assert.match(page.body, new RegExp('start=' + theme.colors[1]));
    assert.match(page.body, new RegExp('stop=' + theme.colors[0]));
    assert.match(page.body, /property="og:image" content="https:\/\/wsrv.nl\//);
    assert.match(page.body, /href="https:\/\/github.com\/owner\/repo\?tab=readme#readme"/);
  }
});

test('invalid shared palettes fail before upstream fetch; themes route works on both adapters', async () => {
  let calls = 0;
  const noFetch = (async () => { calls++; throw Error('unexpected network request'); }) as typeof fetch;
  for (const params of ['theme=custom', 'theme=custom&palette=000000-ffffff-abcdef-123456%3Bcolor%3Ared', 'theme=unsupported', 'theme=dark&palette=000000-ffffff-abcdef-123456']) {
    const result = await handleRequest(new URL('https://wrapper.test/u?url=owner/repo&' + params), new Headers(), noFetch);
    assert.equal(result.status, 400);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  for (const pretty of [false,true]) {
    const page = await handleRequest(new URL('https://wrapper.test/themes?url=owner/repo&theme=dracula'), new Headers(), noFetch, pretty);
    assert.equal(page.status, 200);
    assert.match(page.body, /Import a VS Code theme/);
    assert.match(page.body, /theme-library/);
    const builder = await handleRequest(new URL('https://wrapper.test/make'), new Headers(), noFetch, pretty);
    assert.equal(builder.status, 200);
    assert.match(builder.body, /href="\/themes"/);
  }
  assert.equal(calls, 0);
  const root = await handleRequest(new URL('https://wrapper.test/?url=owner/repo&theme=nord'), new Headers(), fetcher, true);
  assert.equal(root.status, 200);
  assert.match(root.body, /property="og:image"/);
});

test('embedded browser parser is self-contained and page script parses', () => {
  assert.doesNotThrow(() => new Function(themePageScript()));
  const browserTools = vm.runInNewContext('(' + createThemeTools.toString() + ')()', { URLSearchParams });
  const text = '{"colors":{"editor.background":"#000","editor.foreground":"#fff"}}';
  assert.equal(browserTools.importTheme(text).colors.join('-'), themeTools.importTheme(text).colors.join('-'));
});

test('extension presets match the service catalog and menu actions keep named themes', async () => {
  assert.deepEqual(PRESET_THEMES.map(([id])=>id), themeTools.presets.filter(t=>t.id!=='dark'&&t.id!=='light').map(t=>t.id));
  for (const [id] of PRESET_THEMES) assert.equal(new URL(makeShareLink('owner/repo', id)).searchParams.get('theme'), id);
  let copied='';
  const browser = {
    runtime: {getURL: ()=>'offscreen.html', getContexts: async()=>[{}], sendMessage: async message=>{assert.equal(message.type,'copy');copied=message.text;return {ok:true};}},
    storage: {local:{get:async()=>({theme:'nord'})}}
  };
  await createActions(browser).copyLink('owner/repo');
  assert.equal(new URL(copied).searchParams.get('theme'), 'nord');
});
