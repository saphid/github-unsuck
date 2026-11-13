// Retry only the read-only usage query. Failed measurements still fail closed.
export function createBudgetFetcher(fetcher = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attemptTimeoutMs = 2500) {
  return async function budgetFetch(input, init = {}) {
    if (String(input) !== 'https://api.cloudflare.com/client/v4/graphql' || init.method !== 'POST') {
      return fetcher(input, init);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const attemptSignal = AbortSignal.timeout(attemptTimeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, attemptSignal]) : attemptSignal;
        const response = await fetcher(input, { ...init, signal });
        let retry = response.status === 429 || response.status >= 500;
        if (response.ok) {
          const payload = await response.clone().json();
          const groups = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
          retry = Boolean(payload.errors?.length) || !Array.isArray(groups);
        }
        if (!retry || attempt === 2 || init.signal?.aborted) return response;
        await response.body?.cancel();
      } catch (error) {
        if (attempt === 2 || init.signal?.aborted) throw error;
      }
      await sleep(attempt === 0 ? 250 : 1000);
    }
  };
}
