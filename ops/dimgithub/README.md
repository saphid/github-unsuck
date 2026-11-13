# dimgithub production recovery

Production Cloudflare Worker snapshot and bounded-retry hotfix for the recurring DNS outage in [#1](https://github.com/saphid/github-unsuck/issues/1). The repository's Lakebed source predates the deployed Cloudflare application; this snapshot preserves the actual production behavior.

`worker.original.mjs` is the recovered production bundle, SHA256 fb304b17a97a307ee9de874c8ffd697a48234935976090e12d8fc31c350cd228. `worker.candidate.mjs` changes only the scheduled guard's fetcher argument and appends the helper from `budget-retry.mjs`. `budget.current.mjs` extracts the original guard for regression checks. The candidate was deployed as version db395c73-f468-48cf-b668-c4bb1f9f7341 on 2026-11-13 UTC.

The read-only usage query gets at most three attempts for transient HTTP/network failures, malformed JSON, GraphQL errors or missing usage arrays. Each attempt has a 2.5-second timeout within the original 10-second deadline. Persistent failures still pause analytics and disconnect domains. Actual $4 cutoffs and the accounting start date are unchanged. Management writes are never retried.

Keep `no_bundle: true`: the application serializes functions into browser scripts, and bundling inserts inaccessible helpers. The dry-run output must exactly match the candidate. Production bindings were read back before deployment: ANALYTICS_BURST namespace 343535, limit 30/60 seconds, and BUDGET_START_AT 2026-11-10T23:39:20.437756Z. Secret values are not included.

Validation: `node --test ops/dimgithub/budget-retry.test.mjs`. Dry-run: `wrangler deploy --config ops/dimgithub/wrangler.jsonc --dry-run --outdir /tmp/dimgithub-build`. Compare the generated worker to the candidate before uploading. Avoid deploying the older Lakebed implementation over the live Cloudflare application.

Upload succeeded, but Wrangler's domain-sync step lacked zone-route permission. The existing budget-checked resume procedure separately restored all 20 custom domains. The minute-by-minute cron remained unchanged. Exact deployed-code and binding readbacks confirmed the candidate and preserved secrets.

Independent review: Claude Opus 5.5 in Claude Code, high effort, completed task node:delegated-task:command%3Amcp%3Abe36b2e0-7357-4dce-b3ac-65bd7f4bff63%3Adelegate-task%3A9206fc3f-3803-45ab-a845-6c0c8379e036. Findings: bundling regression, binding verification, and missing usage/timeout retries. The parent corrected these, ran 16 regression tests, and compared the actual dry-run artifact's /, /make, /themes, /stats and /api/health responses byte for byte with the original. No CODING_STANDARDS.md was present.
