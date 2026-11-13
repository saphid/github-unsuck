# dimgithub production recovery

Production Cloudflare Worker snapshot and bounded-retry hotfix for the recurring DNS outage in [#1](https://github.com/saphid/github-unsuck/issues/1). The repository's Lakebed source predates the deployed Cloudflare application; this snapshot preserves the actual production behavior.

`worker.original.mjs` is the recovered production bundle, SHA256 fb304b17a97a307ee9de874c8ffd697a48234935976090e12d8fc31c350cd228. `worker.candidate.mjs` is the bundle to deploy. Relative to the recovered bundle it changes the scheduled guard's fetcher argument, appends the helper from `budget-retry.mjs`, and carries the site redesign described below. `budget.current.mjs` extracts the original guard for regression checks. The candidate was deployed as version db395c73-f468-48cf-b668-c4bb1f9f7341 on 2026-11-13 UTC.

The read-only usage query gets at most three attempts for transient HTTP/network failures, malformed JSON, GraphQL errors or missing usage arrays. Each attempt has a 2.5-second timeout within the original 10-second deadline. Persistent failures still pause analytics and disconnect domains. Actual $4 cutoffs and the accounting start date are unchanged. Management writes are never retried.

Keep `no_bundle: true`: the application serializes functions into browser scripts, and bundling inserts inaccessible helpers. The dry-run output must exactly match the candidate. Production bindings were read back before deployment: ANALYTICS_BURST namespace 343535, limit 30/60 seconds, and BUDGET_START_AT 2026-11-10T23:39:20.437756Z. Secret values are not included.

Validation: `node --test ops/dimgithub/budget-retry.test.mjs ops/dimgithub/site.test.mjs`. Dry-run: `wrangler deploy --config ops/dimgithub/wrangler.jsonc --dry-run --outdir /tmp/dimgithub-build`. Compare the generated worker to the candidate before uploading. Avoid deploying the older Lakebed implementation over the live Cloudflare application.

Upload succeeded, but Wrangler's domain-sync step lacked zone-route permission. The existing budget-checked resume procedure separately restored all 20 custom domains. The minute-by-minute cron remained unchanged. Exact deployed-code and binding readbacks confirmed the candidate and preserved secrets.

Independent review: Claude Opus 5.5 in Claude Code, high effort, completed task node:delegated-task:command%3Amcp%3Abe36b2e0-7357-4dce-b3ac-65bd7f4bff63%3Adelegate-task%3A9206fc3f-3803-45ab-a845-6c0c8379e036. Findings: bundling regression, binding verification, and missing usage/timeout retries. The parent corrected these, ran 16 regression tests, and compared the actual dry-run artifact's /, /make, /themes, /stats and /api/health responses byte for byte with the original. No CODING_STANDARDS.md was present.

## Site redesign

The pages are rebuilt inside `worker.candidate.mjs`; there is no separate source or build step, so edit the bundle directly. Routing, link generation, card rendering, analytics, the budget guard and every response header are unchanged. `site.test.mjs` covers the page contract, and `budget-retry.test.mjs` asserts that non-page responses still match `worker.original.mjs` byte for byte.

- `ze` is the stylesheet shared by every page and `pe` the theme gallery's. Both are plain CSS, one rule per line. Colors, fonts and motion are custom properties on `:root`, with a light scheme under `prefers-color-scheme`.
- `M` is the page shell: site header, `<main>`, footer. Its fifth argument sets the body class (`home`, `theme-page`, or `plain` by default), which sets the page width.
- `Z` renders the builder. The theme `<select>` stays in the form and remains the source of truth; the swatches and the chat demo are progressive enhancement that write to it and read from it. Without JavaScript the select shows and the swatches stay hidden.
- The demo card is HTML and CSS driven by `--t-*` custom properties, so changing theme costs no request. It illustrates the card layout; the real card still comes from `/image`.
- The content security policy allows no external fonts, styles or scripts and only same-origin images, so the design uses system fonts, CSS gradients and inline SVG. `/favicon.svg` is a new route for the tab icon.
- The analytics bootstrap (`Q`) escapes `<` in its JSON argument. The recovered bundle wrote the raw `?theme=` value into an inline script, which let a crafted link close the script element and run its own.

