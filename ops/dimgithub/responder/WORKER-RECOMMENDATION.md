# Recommendation: stop the watchdog's false trips at the source (not applied)

The responder repairs a false budget shutdown about a minute after it happens. The worker can avoid most of them in
the first place. The change below is a recommendation only. It is not deployed and not applied to
`worker.candidate.mjs`.

## Problem

`checkBudget` disconnects every custom domain the first time a scheduled run cannot read usage. PR #2 retries
the read three times within one run, so one bad GraphQL response no longer trips it. But a Cloudflare GraphQL
outage lasting a few minutes still takes the site down while spend is far below the cap. At present spend
($0.0092 of the $4 worker cap on 2026-11-13), unmeasured traffic cannot plausibly reach the cap within a
few minutes.

## Change

Shut down on *sustained* unreadable usage instead of the first failure. Keep the immediate shutdown when real
spend reaches the cap. Persist a consecutive-failure counter in a KV namespace (Workers Free includes KV:
1,000 writes per day). The counter writes only while failures are happening and once more on recovery.

```js
// wrangler.jsonc: "kv_namespaces": [{ "binding": "BUDGET_STATE", "id": "<new namespace id>" }]
const USAGE_FAILURE_GRACE = 10; // consecutive scheduled minutes

// in checkBudget, replace the body of the usage-read catch block:
} catch {
  const failures = Number(await env.BUDGET_STATE?.get("usage_failures") ?? 0) + 1;
  if (env.BUDGET_STATE && failures < USAGE_FAILURE_GRACE) {
    await env.BUDGET_STATE.put("usage_failures", String(failures));
    console.error(JSON.stringify({ event: "budget-usage-unavailable", failures, grace: USAGE_FAILURE_GRACE }));
    return { status: "usage-unavailable-grace", failures };
  }
  console.error(JSON.stringify({ event: "budget-shutdown", reason: "usage-unavailable", failures }));
  const results2 = await Promise.allSettled([pauseAnalytics(), stopSite()]);
  if (results2.some((r) => r.status === "rejected")) throw Error("Budget guard could not complete its emergency shutdown");
  return { status: "usage-unavailable-shutdown" };
}
// after a successful read, before the decision:
if (env.BUDGET_STATE && (await env.BUDGET_STATE.get("usage_failures"))) await env.BUDGET_STATE.delete("usage_failures");
```

If the KV binding is missing, behaviour is unchanged: fail closed at once. The cap path (`decision.stopSite`)
is untouched.

Optional extra: log a structured `budget-shutdown` line (above) and set `observability.enabled: true` in
`wrangler.jsonc`. The cause is then visible in Workers Logs, which the free plan includes, and the responder's
`diagnose` could read it. A webhook from the worker to lxso1 is not recommended. lxso1 has no public
endpoint, and the external monitor already detects the shutdown about 10 seconds after its first failing
probe.

## Tests to add with it

- One usage failure: no `PUT …/secrets` and no `DELETE …/workers/domains`. The counter becomes 1.
- 10 consecutive failures: shutdown, as today.
- A success after failures: the counter is cleared.
- No KV binding: immediate shutdown (today's behaviour).
- Real spend at the cap: immediate shutdown, whatever the counter says.
