import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServiceTools, serviceTools, supportedUrl, serviceForUrl, loadServiceMetadata } from '../shared/services.ts';
import { HttpError } from '../shared/github.ts';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('supported links share browser/server validation and preserve queries and fragments', () => {
  const browserTools = vm.runInNewContext('(' + createServiceTools.toString() + ')()', { URL });
  for (const service of serviceTools.services) {
    const url = new URL(service.example);
    url.searchParams.set('theme', 'original');
    url.searchParams.set('tracking', 'a&b');
    url.hash = 'readme';
    assert.equal(serviceTools.normalize(url.href), url.href);
    assert.equal(browserTools.normalize(url.href), url.href);
    assert.equal(serviceForUrl(url).id, service.id);
    assert.equal(serviceTools.detect(url).route, '/' + service.id);
    assert.equal(serviceTools.normalize(url.href.replace('https://', '')), url.href);
  }
  assert.equal(serviceTools.normalize('owner/repo?tab=readme#install'), 'https://github.com/owner/repo?tab=readme#install');
  for (const input of ['https://youtu.be/dQw4w9WgXcQ?t=90', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/live/dQw4w9WgXcQ', 'https://www.npmjs.com/package/@types/node/v/22.0.0', 'https://gitlab.com/group/subgroup/project/-/merge_requests/42', 'https://gitlab.com/group/project/-/issues/1', 'https://pypi.org/project/requests/2.32.0/', 'https://en.wikipedia.org/wiki/C%2B%2B']) assert.equal(supportedUrl(input).href, input);
});

test('unsupported hosts, private URLs, dangerous schemes, and unsupported service pages fail before fetch', async () => {
  let calls = 0;
  const never = (async () => { calls++; throw Error('Unexpected fetch'); }) as typeof fetch;
  for (const input of ['https://localhost/a', 'https://127.0.0.1/a', 'https://github.com.evil.test/a', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'https://github.com@evil.test/a', 'https://user:secret@github.com/repo', 'https://npmjs.com:444/package/react', 'http://gitlab.com/group/repo', 'javascript:alert(1)', 'file:///etc/passwd', 'mailto:owner@example.test', 'evil.test/repo', 'https://www.youtube.com/@someone', 'https://youtube.com/redirect?q=https://evil.test', 'https://youtu.be/not-an-id', 'https://www.npmjs.com/settings/me', 'https://gitlab.com/group/project/-/blob/main', 'https://pypi.org/account/login/', 'https://en.wikipedia.org/w/index.php', 'https://en.wikipedia.org/wiki/%zz', 'https://github.com/']) {
    assert.throws(() => supportedUrl(input), HttpError, input);
    if (input.startsWith('https://')) await assert.rejects(loadServiceMetadata(new URL(input), never), HttpError);
  }
  assert.throws(() => supportedUrl('https://github.com/' + 'x'.repeat(4096)), HttpError);
  assert.equal(calls, 0);
});

test('YouTube video variants use bounded oEmbed metadata and allowlisted thumbnails', async () => {
  const video = 'dQw4w9WgXcQ';
  for (const target of [`https://www.youtube.com/watch?v=${video}&t=90#chapter`, `https://youtu.be/${video}`, `https://www.youtube.com/shorts/${video}`, `https://youtube.com/live/${video}`]) {
    const fetcher = (async (url: URL, options: RequestInit) => {
      assert.equal(url.origin + url.pathname, 'https://www.youtube.com/oembed');
      assert.equal(url.searchParams.get('url'), `https://www.youtube.com/watch?v=${video}`);
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal);
      assert.equal(new Headers(options.headers).get('cookie'), null);
      return json({ title: 'A &amp; B', author_name: '<b>Creator</b>', thumbnail_url: `https://i.ytimg.com/vi/${video}/hqdefault.jpg`, html: '<iframe src="https://evil.test"></iframe>' });
    }) as typeof fetch;
    const result = await loadServiceMetadata(new URL(target), fetcher);
    assert.equal(result.title, 'A & B');
    assert.equal(result.description, 'YouTube video by Creator.');
    assert.equal(result.image, `https://i.ytimg.com/vi/${video}/hqdefault.jpg`);
    assert.ok(!JSON.stringify(result).includes('iframe'));
  }
  const noImage = await loadServiceMetadata(new URL(`https://youtu.be/${video}`), (async () => json({ title: 'Video', thumbnail_url: 'https://i.ytimg.com.evil.test/a' })) as typeof fetch);
  assert.equal(noImage.image, '');
});

test('npm scoped/version packages and PyPI versions fetch fixed public registries', async () => {
  const npm = await loadServiceMetadata(new URL('https://www.npmjs.com/package/@scope/v/v/1.2.3?activeTab=readme'), (async (url: URL) => {
    assert.equal(url.href, 'https://registry.npmjs.org/%40scope%2Fv/1.2.3');
    return json({ name: '@scope/v', version: '1.2.3', description: 'Package description' });
  }) as typeof fetch);
  assert.deepEqual(npm, { title: '@scope/v · 1.2.3', description: 'Package description', image: '', imageAlt: '@scope/v · 1.2.3' });
  const pypi = await loadServiceMetadata(new URL('https://pypi.org/project/requests/2.32.0/'), (async (url: URL) => {
    assert.equal(url.href, 'https://pypi.org/pypi/requests/2.32.0/json');
    return json({ info: { name: 'requests', version: '2.32.0', summary: 'Python HTTP for Humans.' } });
  }) as typeof fetch);
  assert.equal(pypi.title, 'requests · 2.32.0');
  assert.equal(pypi.image, '');
  assert.equal(pypi.description, 'Python HTTP for Humans.');
});

test('Wikipedia summaries and GitLab project/issue/MR metadata use accurate public API fields', async () => {
  const wikipedia = await loadServiceMetadata(new URL('https://en.wikipedia.org/wiki/C%2B%2B#History'), (async (url: URL) => {
    assert.equal(url.href, 'https://en.wikipedia.org/api/rest_v1/page/summary/C%2B%2B');
    return json({ title: 'C++', extract: 'A programming language.', thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/a0/Logo.svg' } });
  }) as typeof fetch);
  assert.equal(wikipedia.title, 'C++');
  assert.equal(wikipedia.description, 'A programming language.');
  assert.ok(wikipedia.image.startsWith('https://upload.wikimedia.org/'));
  const project = await loadServiceMetadata(new URL('https://gitlab.com/group/subgroup/project'), (async (url: URL) => {
    assert.equal(url.href, 'https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fproject');
    return json({ name_with_namespace: 'Group / Project', description: 'Public project', avatar_url: 'http://gitlab.com/avatar.png' });
  }) as typeof fetch);
  assert.equal(project.title, 'Group / Project');
  assert.equal(project.image, '');
  for (const kind of ['issues', 'merge_requests']) {
    const issue = await loadServiceMetadata(new URL(`https://gitlab.com/group/project/-/${kind}/42?view=parallel`), (async (url: URL) => {
      assert.equal(url.href, `https://gitlab.com/api/v4/projects/group%2Fproject/${kind}/42`);
      return json({ title: 'Fix previews', state: 'opened', description: 'Details of the change.' });
    }) as typeof fetch);
    assert.equal(issue.title, 'Fix previews');
    assert.match(issue.description, kind === 'issues' ? /Issue #42/ : /Merge request !42/);
    assert.match(issue.description, /Details of the change/);
  }
});

test('service fetches reject external redirects, rate limits, malformed metadata, and oversized responses', async () => {
  const target = new URL('https://www.npmjs.com/package/react');
  for (const destination of ['https://evil.test/internal', 'http://registry.npmjs.org/react', 'https://user@registry.npmjs.org/react', 'https://127.0.0.1/api', '']) {
    let calls = 0;
    const redirect = (async () => { calls++; return new Response(null, { status: 302, headers: { location: destination } }); }) as typeof fetch;
    await assert.rejects(loadServiceMetadata(target, redirect), (error: HttpError) => error.status === 502);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const looping = (async () => { calls++; return new Response(null, { status: 302, headers: { location: '/react/latest' } }); }) as typeof fetch;
  await assert.rejects(loadServiceMetadata(target, looping), /too many/);
  assert.equal(calls, 3);
  for (const [status, expected] of [[404, 404], [410, 404], [401, 503], [403, 503], [429, 503], [500, 502]]) await assert.rejects(loadServiceMetadata(target, (async () => json({}, status)) as typeof fetch), (error: HttpError) => error.status === expected);
  for (const response of [json(null), json([]), json({ error: 'missing' }), new Response('not json', { headers: { 'Content-Type': 'application/json' } }), new Response('{}', { headers: { 'Content-Type': 'text/html' } }), new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '1048577' } }), new Response('x'.repeat(1048577), { headers: { 'Content-Type': 'application/json' } })]) {
    await assert.rejects(loadServiceMetadata(target, (async () => response) as typeof fetch), (error: HttpError) => error.status === 502);
  }
});

test('hosted buffered responses work and GitHub keeps its existing metadata loader', async () => {
  const npm = await loadServiceMetadata(new URL('https://www.npmjs.com/package/react'), (async () => ({
    status: 200, ok: true, headers: new Headers({ 'Content-Type': 'application/json' }),
    text: async () => '{"name":"react","version":"19.0.0","description":"UI library"}'
  })) as typeof fetch);
  assert.equal(npm.title, 'react · 19.0.0');
  const github = await loadServiceMetadata(new URL('https://github.com/owner/repo'), (async (url: URL) => {
    assert.equal(url.href, 'https://github.com/owner/repo');
    return new Response('<meta property="og:title" content="owner/repo"><meta property="og:image" content="https://opengraph.githubassets.com/abc/owner/repo">', { headers: { 'Content-Type': 'text/html' } });
  }) as typeof fetch);
  assert.equal(github.title, 'owner/repo');
  assert.ok(github.image.startsWith('https://opengraph.githubassets.com/'));
});
