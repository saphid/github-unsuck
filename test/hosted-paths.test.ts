import { test } from 'node:test';
import assert from 'node:assert/strict';
import app from '../server/index.ts';
import { githubPathTarget } from '../shared/github.ts';

test('path links preserve GitHub query and fragment while removing wrapper controls', () => {
  const target = githubPathTarget(new URL('https://github-unsuck.lakebed.app/owner/repo/pull/42?theme=hotdog&preview=1&palette=abcdef&name=example&diff=split&url=original#discussion_r2'));
  assert.equal(target.href, 'https://github.com/owner/repo/pull/42?diff=split&url=original#discussion_r2');
  assert.equal(githubPathTarget(new URL('https://wrapper.test//evil.test/repo')).hostname, 'github.com');
});

test('Lakebed serves the supplied path alias with dark metadata and the GitHub redirect', async t => {
  let requested = '';
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    requested = url.href;
    return new Response('<meta property="og:title" content="Pull request #29809"><meta property="og:image" content="https://opengraph.githubassets.com/abc/pingdotgg/t3code/pull/29809">', { headers: { 'Content-Type': 'text/html' } });
  });
  const path = '/pingdotgg/t3code/pull/29809';
  const endpoint = Object.values(app.endpoints).find(route => route.path === path);
  assert.ok(endpoint, 'Path must be registered as a literal Lakebed endpoint');
  const response = await endpoint.handler({ env: {} } as never, {
    url: 'http://github-unsuck.lakebed.app' + path,
    headers: new Headers()
  } as never);
  assert.equal(response.status, 200);
  assert.equal(requested, 'https://github.com' + path);
  assert.match(response.body, /property="og:url" content="https:\/\/github-unsuck\.lakebed\.app\/pingdotgg\/t3code\/pull\/29809"/);
  assert.match(response.body, /start=e6edf3&amp;stop=0d1117/);
  assert.match(response.body, /href="https:\/\/github\.com\/pingdotgg\/t3code\/pull\/29809"/);
  assert.match(response.body, /location.replace\(target.href\)/);
});
