# GitHub / Unsuck

A tiny public GitHub link wrapper that gives GitHub's preview cards your chosen theme.
It uses GitHub's existing Open Graph title, description, and image, including
pull request and issue details. Crawlers get server-rendered metadata; people
opening a shared link are forwarded to the original GitHub URL with JavaScript.
Without JavaScript, a Continue to GitHub button remains available.

## Live deployment

- Builder: https://github-unsuck.lakebed.app
- Themes: https://github-unsuck.lakebed.app/themes
- Example: https://github-unsuck.lakebed.app/u?url=expressjs/express
- Health: https://github-unsuck.lakebed.app/api/health
- Owned deploy: `dep_ehMIy-l20l2NrLjb` (no expiry); binding in `lakebed.json`.

Hosted verification on 2026-11-08 covers repository, PR, and issue metadata and
real PNG images, explicit light mode, system-hint handling and cache headers,
HTTPS canonical URLs, invalid URL rejection, and the link builder.

`github.unsuck.dev` is not attached: the runner rejects registration with
“Custom domains are not configured on this runner.” The included standalone
adapter supports the final GitHub path format when that hostname is available.

## Chrome extension

[Download the Chrome extension ZIP](https://github.com/saphid/github-unsuck/releases/latest/download/github-unsuck-extension.zip),
unzip it, then follow the installation steps below.

Load the `extension/` folder at `chrome://extensions` → **Developer mode** →
**Load unpacked**, then pin **GitHub / Unsuck**. Or run `npm run extension:zip`
and extract `dist/github-unsuck-extension.zip` on the machine running Chrome.
See [extension installation and shortcuts](extension/README.md).

The popup uses the current GitHub page or a pasted URL. Copy from the popup,
right-click a GitHub link, or use Alt+Shift+U (Command+Shift+U on Mac). A remembered
system/dark/light or named editor theme controls all three actions. System mode captures
an explicit theme at creation time so chat crawlers receive a stable image.
The extension needs no site-wide access or content scripts.

Ready-to-paste repository, PR, and issue links are in [EXAMPLES.md](EXAMPLES.md).

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

`url` accepts a full `https://github.com/...` URL, `github.com/owner/repo`, or a
GitHub path. Only public GitHub pages with supported preview images work.
Private repository credentials and cookies are never forwarded.

## Themes

Open [/themes](https://github-unsuck.lakebed.app/themes) from the builder or
extension. Browse theme families, filter dark/light appearances, and choose
GitHub, VS Code Dark+/Light+, Catppuccin, Dracula, Nord, One Dark Pro, or Solarized.
The palette preview and share URL update immediately; **Load GitHub card** shows
the actual recolored image for your repository, issue, or pull request.

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
Background and foreground recolor the actual PNG; accent and surface appear in
the palette preview. Original GitHub query parameters and fragments remain
inside the encoded `url` value. Importing does not upload or fetch a theme file.

The family/variant gallery and workbench-color import approach are inspired by
[T3 Code](https://github.com/pingdotgg/t3code) (MIT); this service implements its
own smaller palette and parser without copying T3 Code source or dependencies.

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

Add `&preview=1` to view the wrapper without being forwarded to GitHub. Use
`/image?url=owner/repo&theme=dark` for a redirect to the selected image.

### Image dependency

Dark, named, and custom previews use [wsrv.nl](https://images.weserv.nl/) to convert GitHub's existing
image into a PNG with a duotone palette (default `#0d1117` / `#e6edf3`). This preserves the
card's layout and details, but **also recolors logos, avatars, and artwork**.
The GitHub image URL is public and visible to the proxy. This version depends on
that third-party service being available. Light previews go directly to GitHub.
No GitHub token, image renderer, database, or app secrets are needed.

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
exactly. The v1 URL format is `/u?url=<encoded-GitHub-URL>&theme=dark`, served
without crawler JavaScript. Normal GitHub path routing needs a proxy rewrite or
future wildcard endpoint support. Never redirect these paths to GitHub before
serving the wrapper metadata, or the unfurl will stay white.

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
PNG redirect URLs, and crawler-facing tags. There are 26 unit tests, including JSONC imports, alpha/contrast handling, palette
URL roundtrips, PNG/OG theme output, extension URL handling, theme capture,
clipboard errors, offscreen messaging, and concurrent clipboard actions.
Endpoint responses cache successful metadata for ten minutes; errors are not cached. No persistent state is used.
Chat apps have their own caches; changing `theme` creates a distinct shared URL.
GitHub and Lakebed rate limits still apply. Health confirms the app is running;
it does not test GitHub or the image proxy.

Source: `server/index.ts` (Lakebed adapter), `shared/app.ts` (HTTP behavior and
builder), `shared/theme-page.ts` (theme gallery), `shared/theme-runtime.js`
(shared palette validation/import), `shared/github.ts` (GitHub metadata and image URLs), `standalone.ts`
(Node adapter).
