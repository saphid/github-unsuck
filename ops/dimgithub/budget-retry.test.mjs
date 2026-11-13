import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkBudget } from './budget.current.mjs';
import { createBudgetFetcher } from './budget-retry.mjs';
import original from './worker.original.mjs';
import candidate from './worker.candidate.mjs';

const env = { CLOUDFLARE_BUDGET_TOKEN: 'fixture', BUDGET_START_AT: '2026-11-10T23:39:20.437756Z' };
const now = new Date('2026-11-13T00:00:00Z');

test('the deployed snapshot contains the exact retry helper source', () => {
  const helper = readFileSync(new URL('./budget-retry.mjs', import.meta.url), 'utf8').replace('export function createBudgetFetcher', 'function createBudgetFetcher');
  const artifact = readFileSync(new URL('./worker.candidate.mjs', import.meta.url), 'utf8');
  assert.ok(artifact.endsWith(helper));
});

async function run(failures, usage = { requests: 9006, subrequests: 8037 }) {
  let reads = 0, deletes = 0, pauses = 0;
  const fetcher = async (url, init = {}) => {
    if (url.endsWith('/graphql')) {
      const failure = failures[reads++];
      if (failure === 'network') throw new TypeError('Temporary network failure');
      if (failure === 'graphql') return Response.json({ errors: [{ message: 'Temporary usage API failure' }] });
      if (failure === 'empty-data') return Response.json({ data: null });
      if (failure === 'empty-accounts') return Response.json({ data: { viewer: { accounts: [] } } });
      if (typeof failure === 'number') return new Response('upstream failure', { status: failure });
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: usage }] }] } } });
    }
    if (url.endsWith('/domains')) return Response.json({ success: true, result: [
      { id: 'fixture', hostname: 'dimgithub.com', service: 'dimgithub', environment: 'production' }
    ] });
    if (init.method === 'DELETE') { deletes++; return Response.json({ success: true }); }
    if (url.endsWith('/secrets')) { pauses++; return Response.json({ success: true }); }
    throw Error('Unexpected endpoint');
  };
  const result = await checkBudget(env, createBudgetFetcher(fetcher, async () => {}), now);
  return { result, reads, deletes, pauses };
}

for (const failure of [503, 429, 'network', 'graphql', 'empty-data', 'empty-accounts']) {
  test(`a temporary ${failure} failure does not disconnect healthy domains`, async () => {
    const r = await run([failure]);
    assert.equal(r.result.status, 'checked');
    assert.equal(r.reads, 2);
    assert.equal(r.deletes, 0);
    assert.equal(r.pauses, 0);
  });
}
test('persistent usage failure still shuts down after three attempts', async () => {
  const r = await run([503, 503, 503]);
  assert.equal(r.result.status, 'usage-unavailable-shutdown');
  assert.equal(r.reads, 3);
  assert.equal(r.deletes, 1);
  assert.equal(r.pauses, 1);
});
test('actual spend cutoffs still pause analytics and disconnect domains', async () => {
  const r = await run([], { requests: 8_000_000, subrequests: 80_000 });
  assert.equal(r.result.stopSite, true);
  assert.equal(r.result.pauseAnalytics, true);
  assert.equal(r.deletes, 1);
  assert.equal(r.pauses, 1);
});
test('authentication failures fail closed without retries', async () => {
  const r = await run([403]);
  assert.equal(r.result.status, 'usage-unavailable-shutdown');
  assert.equal(r.reads, 1);
  assert.equal(r.deletes, 1);
});
test('management writes are never retried', async () => {
  let calls = 0;
  const request = createBudgetFetcher(async () => { calls++; return new Response(null, { status: 503 }); }, async () => {});
  await request('https://api.cloudflare.com/client/v4/accounts/fixture/workers/domains/fixture', { method: 'DELETE' });
  assert.equal(calls, 1);
});

test('slow usage calls retry within the overall timeout', async () => {
  let calls = 0;
  const fetcher = createBudgetFetcher(async (url, init) => {
    calls++;
    if (calls === 1) {
      await new Promise((resolve, reject) => {
        const keeper = setTimeout(resolve, 1000);
        init.signal.addEventListener('abort', () => { clearTimeout(keeper); reject(init.signal.reason); }, { once: true });
      });
    }
    return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } });
  }, async () => {}, 10);
  const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', signal: AbortSignal.timeout(500) });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

for (const path of ['/', '/make', '/api/health', '/stats', '/themes']) {
  test(`the hotfix preserves the live ${path} response`, async () => {
    const request = new Request('https://dimgithub.com' + path);
    const before = await original.fetch(request, {}, {});
    const after = await candidate.fetch(request, {}, {});
    assert.equal(after.status, before.status);
    assert.deepEqual([...after.headers], [...before.headers]);
    assert.equal(await after.text(), await before.text());
  });
}
