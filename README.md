# Links / Unsuck

Themed link previews for GitHub, YouTube, GitLab, npm, PyPI, and English Wikipedia.
Crawlers get server-rendered Open Graph metadata and a PNG in your chosen theme;
people opening a shared link continue to the original page with JavaScript.
Without JavaScript, a Continue button remains available.

GitHub preserves its original card layout. The other services get a text card
with their actual public title, description, service, and source path. All 16
presets and imported VS Code palettes work across the services.

## Live deployment

- Builder: https://github-unsuck.lakebed.app
- Themes: https://github-unsuck.lakebed.app/themes
- Example: https://github-unsuck.lakebed.app/u?url=expressjs/express
- Health: https://github-unsuck.lakebed.app/api/health
- Owned deploy: `dep_ehMIy-l20l2NrLjb` (no expiry); binding in `lakebed.json`.

Hosted verification on 2026-11-08 covers all five new services, repository/PR/issue metadata,
and real 1200×600 PNG images, explicit light mode, system-hint handling and cache headers,
HTTPS canonical URLs, invalid URL rejection, and the link builder.

`github.unsuck.dev` is not attached: the runner rejects registration with
“Custom domains are not configured on this runner.” The included standalone
adapter supports the final GitHub path format when that hostname is available.

## Chrome extension

[Download the Chrome extension ZIP](https://github.com/saphid/github-unsuck/releases/latest/download/github-unsuck-extension.zip),
unzip it, then follow the installation steps below.

Load the `extension/` folder at `chrome://extensions` → **Developer mode** →
**Load unpacked**, then pin **Links / Unsuck**. Or run `npm run extension:zip`
and extract `dist/github-unsuck-extension.zip` on the machine running Chrome.
See [extension installation and shortcuts](extension/README.md).

The popup uses the current supported page or a pasted URL. Copy from the popup,
right-click a supported link, or use Alt+Shift+U (Command+Shift+U on Mac). A remembered
system/dark/light or named editor theme controls all three actions. System mode captures
an explicit theme at creation time so chat crawlers receive a stable image.
The extension needs no site-wide access or content scripts.

Ready-to-paste links for every supported service are in [EXAMPLES.md](EXAMPLES.md).

## Run

Node 24 or newer:

```sh
npm ci
npm run dev
```

Open `http://localhost:3918` to make and copy a link. Lakebed's root client routes
to the server-rendered builder at `/make`. Local health: `/api/health`.

```text
http://localhost:3918/u?url=expressjs/express
http://localhost:3918/u?url=expressjs/express/pull/1&theme=dark
http://localhost:3918/u?url=expressjs/express/issues/1&theme=light
```

Use the builder or URL-encode a full original URL when it includes `?`, `&`, or `#`:

```sh
curl --get 'http://localhost:3918/u' \
  --data-urlencode 'url=https://github.com/expressjs/express?tab=readme-ov-file#readme' \
  --data-urlencode 'theme=dark'
```

`url` accepts a full supported HTTPS URL or a bare supported hostname and path.
GitHub `owner/repository` shorthand remains available. Original query parameters
and fragments stay inside the encoded `url` value. Only public metadata is fetched;
credentials and cookies are never forwarded.

## Supported services and URLs

The builder automatically detects the service. `/u?url=...` works for all six;
service-specific URLs below check that the supplied link matches their service.
Opening a service route without `url` shows the builder with an example filled in.

| Service | Route | Supported public pages | Metadata source |
| --- | --- | --- | --- |
| GitHub | `/github` or `/u` | Users, repositories, PRs, issues | GitHub Open Graph HTML |
| YouTube | `/youtube` | Watch, youtu.be, Shorts, live, embed video links | YouTube oEmbed |
| GitLab | `/gitlab` | gitlab.com projects, issues, merge requests, nested groups | GitLab public API |
| npm | `/npm` | Packages, scoped packages, explicit versions | npm registry |
| PyPI | `/pypi` | Projects and explicit versions | PyPI JSON API |
| Wikipedia | `/wikipedia` | English Wikipedia `/wiki/` articles | Wikipedia summary API |

Examples to share:

- [YouTube](https://github-unsuck.lakebed.app/youtube?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ&theme=dark)
- [GitLab](https://github-unsuck.lakebed.app/gitlab?url=https%3A%2F%2Fgitlab.com%2Fgitlab-org%2Fgitlab&theme=dark)
- [npm](https://github-unsuck.lakebed.app/npm?url=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Ftypescript&theme=dark)
- [PyPI](https://github-unsuck.lakebed.app/pypi?url=https%3A%2F%2Fpypi.org%2Fproject%2Frequests%2F&theme=dark)
- [Wikipedia](https://github-unsuck.lakebed.app/wikipedia?url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FTypeScript&theme=dark)

The host allowlist is explicit; arbitrary websites, self-hosted GitLab,
private pages, YouTube channels/playlists, and non-English Wikipedia sites are
unsupported. API requests have a five-second timeout, a 1 MB metadata limit,
and at most three same-origin redirects. Service outages and rate limits return
an error instead of a fabricated preview.

## Themes

Open [/themes](https://github-unsuck.lakebed.app/themes) from the builder or
extension. Browse theme families, filter dark/light appearances, and choose
GitHub, T3 Code Dark/Light, T3 Chat Dark/Light, VS Code Dark+/Light+,
Catppuccin, Dracula, Nord, One Dark Pro, Solarized, or Cursed Hotdog.
The palette preview and share URL update immediately; **Load actual card** shows
the PNG for your chosen link.

Import a VS Code color-theme **JSON/JSONC** file or paste its contents (256 KB
maximum). Comments, trailing commas, and `#RGB`, `#RGBA`, `#RRGGBB`, and
`#RRGGBBAA` colors are supported. Workbench background, foreground, focus/link
accent, and sidebar colors map to a small opaque palette; alpha colors are
composited and unreadable foregrounds receive a contrast fallback. Themes must
contain usable workbench background colors. Extension manifests, token-only
themes, CSS color functions, and `include` inheritance are unsupported; merge
inherited colors first. This is an unfurl palette, not a syntax highlighter.

The browser remembers your choice and up to 12 imported palettes. Custom links
carry `theme=custom&palette=<background>-<foreground>-<accent>-<surface>&name=...`
(four six-digit hex colors), so recipients need no local storage or installation.
GitHub images use the background and foreground; their accent and surface appear
in the palette preview. New service cards use all four palette colors. Original
query parameters and fragments remain inside the encoded `url` value. Importing does not upload or fetch a theme file.

The family/variant gallery and workbench-color import approach are inspired by
[T3 Code](https://github.com/pingdotgg/t3code) (MIT); this service implements its
own smaller palette and parser without T3 Code's application code or dependencies.
The T3 Code and T3 Chat presets map `canvas`, `text`, `accent`, and `sidebar`
from its [upstream theme definitions](https://github.com/pingdotgg/t3code/blob/8a84e9426d26bb50de24a8d36c262a851a3befd2/packages/shared/src/themePalettes.ts).
T3 Chat's OKLCH colors are converted to six-digit sRGB for the image renderer.
Cursed Hotdog (`theme=hotdog`) uses the classic Windows Hot Dog Stand palette:
red background, yellow text and panels, and black accents.

GitHub image behavior (other services render a text card in the same palette):

| Parameter | Preview image |
| --- | --- |
| omitted or `theme=dark` | GitHub dark background and light text |
| `theme=light` | GitHub's original image |
| `theme=dracula` (or another named preset) | PNG recolored with that palette |
| `theme=custom&palette=...` | PNG recolored with the imported palette |
| `theme=auto` | Uses `Sec-CH-Prefers-Color-Scheme` if available; otherwise dark |

**Chat previews cannot reliably follow each reader's system appearance.** Slack,
Discord, Messages, and similar clients usually fetch and cache one image per URL
without providing the viewer's color preference. There is no widely supported
Open Graph dark/light image selector. `auto` is best effort; explicit dark/light
URLs are reliable. A browser viewing `&preview=1` uses a CSS media query to match
its own system setting, and the link builder also matches system appearance.

Add `&preview=1` to view the wrapper without being forwarded to the original site. Use
`/image?url=owner/repo&theme=dark` for a redirect to the selected image.

### Image dependency

Dark, named, and custom previews use [wsrv.nl](https://images.weserv.nl/) to convert GitHub's existing
image into a PNG with a duotone palette (default `#0d1117` / `#e6edf3`). This preserves the
card's layout and details, but **also recolors logos, avatars, and artwork**.
The GitHub image URL is public and visible to the proxy. This version depends on
that third-party service being available. Light previews go directly to GitHub.
For the other services, `/card.svg` renders a bounded text card with no network
requests or embedded external images. Its URL contains the public metadata and
palette. wsrv.nl converts that SVG to a 1200×600 PNG, so crawlers need no SVG
support. The source path appears on the card; video thumbnails and article photos
are not recolored. The proxy receives the public title/description and source path.
No API token, local image renderer, database, or app secrets are needed.

## Deploy to Lakebed

```sh
npm run build
npx lakebed auth login
npm run deploy
```

This checkout is bound to the project's live deployment through `lakebed.json`.
For your own deployment, remove that file before the first deploy so Lakebed
creates a new app owned by your account. The deploy ID is not a credential.

Sign in **before deploying**: Lakebed requires a claimed/owned app for outbound
fetches. An anonymous deploy cannot fetch GitHub metadata. The CLI creates
`lakebed.json` with the deployment ID; retain it for later updates. Optionally
reserve an available Lakebed app subdomain:

```sh
npx lakebed domains add github-unsuck.lakebed.app
```

Check the resulting deployment using its actual hostname:

```sh
curl -fsS 'https://YOUR-APP.lakebed.app/api/health'
curl --get 'https://YOUR-APP.lakebed.app/u' --data-urlencode 'url=expressjs/express'
npx lakebed inspect https://YOUR-APP.lakebed.app
```

Lakebed 0.0.41 reserves `/` for its client shell and matches endpoint paths
exactly. The universal URL format is `/u?url=<encoded-source-URL>&theme=dark`, served
without crawler JavaScript. The registered alias
[`/pingdotgg/t3code/pull/29809`](https://github-unsuck.lakebed.app/pingdotgg/t3code/pull/29809)
also serves dark GitHub metadata and forwards browser visitors to the original PR.
Add other crawler-facing aliases in `shared/hosted-paths.ts` and redeploy.
Other GitHub paths forward browser visitors through Lakebed's JavaScript shell;
that shell has no Open Graph metadata, so use `/u?url=...` for arbitrary shared links.
Generic server path routing needs a proxy rewrite or future wildcard endpoint
support. Redirecting crawlers directly to GitHub would keep their unfurls white.

The intended hostname is **github.unsuck.dev**. This runner currently rejects
custom domains as unconfigured. Lakebed also documents a zero custom-domain
allowance by default. If custom domains become available, use
`npx lakebed domains add github.unsuck.dev`, then set the exact DNS records it
prints. For a hosted custom origin, set `PUBLIC_ORIGIN=https://github.unsuck.dev`
in `.env.lakebed.server` before redeploying. An external proxy or another host is
the current alternative for that hostname.

### Standalone option: final path format today

The same implementation also runs as a Node server with no runtime dependencies:

```sh
npm start
# Behind an HTTPS reverse proxy:
PUBLIC_ORIGIN=https://github.unsuck.dev HOST=0.0.0.0 PORT=3918 npm start
```

This supports the intended link shape directly:

```text
https://github.unsuck.dev/expressjs/express
https://github.unsuck.dev/expressjs/express/pull/123
https://github.unsuck.dev/expressjs/express/issues/123?theme=light
```

All GitHub query parameters other than the wrapper's `theme`, `palette`, `name`, and `preview` are
preserved in path mode. A fragment on the wrapper is forwarded in the browser.
Use `/u?url=...` to keep original URLs containing those query names intact.
Set `PUBLIC_ORIGIN` behind a reverse proxy so canonical preview URLs use the
public HTTPS origin. The default listener binds only to `127.0.0.1`.

## Verification and behavior

```sh
npm test
npm run build
```

Tests cover URL validation, redirect restrictions, metadata escaping, upstream
errors, bounded responses, explicit and automatic themes, query preservation,
PNG redirect URLs, and crawler-facing tags. There are 41 unit tests, including JSONC imports, alpha/contrast handling, palette
URL roundtrips, PNG/OG theme output for every preset, extension URL handling, theme capture,
clipboard errors, offscreen messaging, concurrent clipboard actions, and literal
Lakebed path aliases with dark metadata, HTTPS canonical URLs, and GitHub forwarding.
Service tests cover every new adapter, service-specific routes, original URL
preservation, safe SVG text, custom palette propagation, and PNG image URLs.
Endpoint responses cache successful metadata for ten minutes; errors are not cached. No persistent state is used.
Chat apps have their own caches; changing `theme` creates a distinct shared URL.
Upstream service and Lakebed rate limits still apply. Health confirms the app is running;
it does not test upstream services or the image proxy.

Source: `server/index.ts` (Lakebed adapter), `shared/app.ts` (HTTP behavior and
builder), `shared/theme-page.ts` (theme gallery), `shared/theme-runtime.js`
(shared palette validation/import), `shared/service-runtime.js` (shared URL rules),
`shared/services.ts` (public metadata adapters), `shared/cards.ts` (themed text cards),
`shared/github.ts` (GitHub metadata and image URLs), `standalone.ts`
(Node adapter).
