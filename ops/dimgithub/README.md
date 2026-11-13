# dimgithub production worker

The production Cloudflare Worker for dimgithub.com. The repository's Lakebed source (`shared/`, `server/`) predates the deployed Cloudflare application. Do not deploy it over this worker.

`worker.candidate.mjs` is the bundle to deploy. `worker.original.mjs` is the recovered production bundle from before the outage work, SHA256 fb304b17a97a307ee9de874c8ffd697a48234935976090e12d8fc31c350cd228. It is kept as history only, and it still contains the analytics and budget code removed below.

## Public-only

The worker holds no credentials and can read only public GitHub.

- **No bindings.** The default export is `fetch(request)` and nothing else. It never reads `env` or `ctx`, and it has no `scheduled` handler. `wrangler.jsonc` has an empty cron list and no vars, secrets, rate limits, storage or service bindings.
- **Runtime restrictions.** `global_fetch_strictly_public` keeps global fetch on the public Internet, `disallow_importable_env` disables environment imports, and `disallow_eval_during_startup` disables startup evaluation. No Node.js compatibility or private service bindings are enabled. The host allowlist is enforced by application code, not by a separate platform egress firewall.
- **One way out.** Every outbound request goes through `createPublicFetch`. It accepts only a URL string that matches one of these exactly:
  - `https://github.com/<owner>`, `/<owner>/<repo>`, `/<owner>/<repo>/pull/<n>`, `/issues/<n>`, `/discussions/<n>` or `/commit/<sha>`, with no query or fragment.
  - `https://avatars.githubusercontent.com/u/<digits>`.
  - `https://api.github.com/users/<owner>`, `/repos/<owner>/<repo>`, `/repos/<owner>/<repo>/issues/<n>`, or the `/repositories/<id>` forms GitHub redirects renamed repositories to.

  It sends a fixed `GET` with `redirect: "manual"` and only `Accept` and `User-Agent` headers. It forwards nothing from the incoming request: no cookies, authorization, client IP or other headers. Anything else is refused before `fetch` runs.
- **Redirects are checked at every hop.** `nextHop` refuses a `Location` that has whitespace, control characters, backslashes, encoded slashes or dots, or dot segments. It resolves the rest, requires HTTPS with no user info or port, and requires the target to pass the same allowlist. It also drops any query. The choke point then checks the result again. Redirects to other hosts, private or link-local addresses, metadata endpoints or GitHub's login and settings pages fail with a 502.
- **Strict link parsing.** `E().target` is shared by the server and the browser builder. It accepts only the shapes above, plus `/pull/<n>/files|commits|checks` (the fetch uses `/pull/<n>`). It refuses `%` anywhere in the path, as well as `//`, `.` and `..` segments, backslashes, whitespace and control characters, other schemes and hosts, ports, user info, and GitHub's reserved top-level paths. It drops the query string. It keeps a fragment only if it is plain (`#issuecomment-123`).
- **GitHub only.** The YouTube, GitLab, npm, PyPI and Wikipedia services, `/card.svg`, analytics (`/api/events`, the in-page tracker, PostHog capture) and `/stats` are removed. Their routes answer 404 or 410 locally.
- **No image proxy.** `og:image` and `/image` use GitHub's own preview image (`opengraph.githubassets.com`, `repository-images.githubusercontent.com` or `avatars.githubusercontent.com`). `/github-card.svg` fetches the avatar directly from `avatars.githubusercontent.com/u/<digits>?s=200&v=4`. The avatar must be at most 400 KB, have a declared PNG, JPEG, GIF or WebP type, and have magic bytes that match that type. Only then is it embedded as a `data:` URI.
- **Escaping.** Every value from GitHub or the query string reaches HTML or SVG through `m()`. `og:url` and the canonical link are rebuilt from the `url`, `theme`, `palette` and `name` parameters only. The redirect interstitial navigates only to `https://github.com`. Error pages show fixed messages, never upstream bodies or exception text.

Limitation: chat apps do not render SVG, and rasterizing a dark card needs an image proxy. Shared GitHub links therefore unfurl with GitHub's own (light) preview image. Theme choice still sets the theme subdomain and the builder's palette preview. The page copy that promises themed cards predates this change.

## Validation and deploy

Run `node --test ops/dimgithub/security.test.mjs ops/dimgithub/site.test.mjs`. `security.test.mjs` drives the real default export, `proxyRequest` and `createPublicFetch` with a recording fetch. It covers the allowlist, header and cookie non-forwarding, redirect hops for pages, the API and avatars, encoded-path tricks, hostile metadata, avatar content checks, disabled routes, and the binding-free config. `site.test.mjs` covers the page contract.

Keep `no_bundle: true`: the application serializes `G` and `E` into browser scripts, and bundling inserts inaccessible helpers. Keep `find_additional_modules: false`, so wrangler uploads the bundle alone and attaches no `.txt`, `.html` or `.bin` file from this directory.

1. Dry-run: `wrangler deploy --config ops/dimgithub/wrangler.jsonc --dry-run --outdir /tmp/dimgithub-build`. The generated worker must match the candidate.
2. Upload: `wrangler versions upload --config ops/dimgithub/wrangler.jsonc`.
3. Deploy: `wrangler versions deploy <version-id>@100% --config ops/dimgithub/wrangler.jsonc -y`.

`versions deploy` changes neither cron triggers nor secrets. After deploying, remove the minute cron and any remaining secrets (for example `POSTHOG_PAUSED_MONTH`) separately. Then read back the deployed version's bindings and triggers to confirm that none remain.

## Site redesign

The pages are built inside `worker.candidate.mjs`. There is no separate source or build step, so edit the bundle directly. `site.test.mjs` covers the page contract.

- `ze` is the stylesheet shared by every page and `pe` the theme gallery's. Both are plain CSS, one rule per line. Colors, fonts and motion are custom properties on `:root`. The pages are dark whatever the system prefers.
- `M` is the page shell: site header, `<main>`, footer. Its fifth argument sets the body class (`home`, `theme-page`, or `plain` by default), which sets the page width.
- `Z` renders the builder. The theme `<select>` stays in the form and remains the source of truth. The theme chips and the chat demo are progressive enhancement that write to it and read from it. Without JavaScript the select shows and the swatches stay hidden.
- The demo card is HTML and CSS driven by `--t-*` custom properties, so changing the theme costs no request.
- The content security policy allows no external fonts, styles, scripts or connections. Images may come only from the site and GitHub's image hosts.

Earlier versions: the redesign was ee66190a-58e4-46aa-90c4-56538a9c8cc2, and the dark-only pages were dcfe560e-6b98-4429-8065-7846bd7631a2. Both still contain analytics and the budget guard. Do not roll back to them while the public-only requirement stands.

## Outage monitor and responder

`responder/` holds the lxso1 monitor and the agent it launches when the site goes down. It is stopped. It still contains Cloudflare budget and domain management code (`responder/cfapi.py`) that this worker no longer runs. Its budget-parity tests skip now that `budget.current.mjs` is gone. Start with `responder/README.md`.
