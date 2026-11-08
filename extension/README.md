# Links / Unsuck — Chrome extension

## Install

1. [Download the extension ZIP](https://github.com/saphid/github-unsuck/releases/latest/download/github-unsuck-extension.zip)
   and extract it into a folder you will keep.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked**, then choose the extracted `github-unsuck-extension`
   folder containing `manifest.json`.
4. Pin **Links / Unsuck** in Chrome's extensions menu.

When working in the source checkout, load the `extension/` directory directly.
Chrome 116 or newer is required. No build is needed to load the source folder.

## Use

- On a supported page, click the extension, then **Copy link**. The copy button is
  focused automatically, so pressing Enter also works.
- Right-click a supported link on any page and choose **Copy themed link**.
- Right-click the background of a supported page to copy that page's themed link.
- Press **Alt+Shift+U** (Windows/Linux) or **Command+Shift+U** (Mac) to copy the
  current supported page directly. Change conflicts at `chrome://extensions/shortcuts`.
- On another site, open the extension and paste a public GitHub, YouTube, npm,
  English Wikipedia, GitLab.com, or PyPI URL. GitHub `owner/repository` paths
  still work. The popup lists the current supported services.
- Choose a named theme such as T3 Code, T3 Chat, Cursed Hotdog, Dracula, Nord, or Catppuccin in the popup.
  The selection also applies to the right-click menu and shortcut.
- **Explore themes + import from VS Code** opens the full theme gallery with
  your current link. Imported palettes are used by links created on that
  page; the extension remembers its own named/system theme separately.
- **Preview** opens the rendered card without immediately forwarding to GitHub.

**Match my system** is the default. It reads your appearance at creation time
and writes an explicit `theme=dark` or `theme=light` into the link. This works
with chat crawlers that cannot detect the reader's system theme. Everyone sees
the chosen image; it does not change independently for each recipient.
Your selected theme is remembered for the popup, menus, and shortcut.

Original URL query parameters and fragments are preserved. Only public supported
pages can produce previews; the extension cannot make private content accessible
to a chat crawler. GitHub links retain `/u?url=...&theme=dark`. Other services
receive their own route, such as
`https://github-unsuck.lakebed.app/youtube?url=...&theme=dark` or
`https://github-unsuck.lakebed.app/npm?url=...&theme=dark`.

## Permissions and data

`activeTab` reads the current URL when you invoke the extension; `contextMenus`
adds the copy actions; `storage` remembers only your theme; `offscreen` and
`clipboardWrite` let menu and shortcut actions copy without opening the popup.
There are no host permissions, content scripts, analytics, or remote scripts.
Creating or copying a link does not make a network request. Opening a preview
or sharing the link uses the hosted service described in the project README.

If copying fails, the popup selects the generated link so it can be copied
manually. A successful menu/shortcut action briefly shows a green check on the
toolbar icon; an error shows `!` and an explanation in the icon's tooltip.

## Package

From the project root, `npm run extension:zip` creates
`dist/github-unsuck-extension.zip` using Python 3's standard library. The icons
are included; no image tooling is needed for packaging.
Packaging copies the shared service URL rules into `extension/service-runtime.js`
so Chrome can load them without accessing files outside the extension folder.
