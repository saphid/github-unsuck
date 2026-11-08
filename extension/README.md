# GitHub / Unsuck — Chrome extension

## Install

1. [Download the extension ZIP](https://github.com/saphid/github-unsuck/releases/latest/download/github-unsuck-extension.zip)
   and extract it into a folder you will keep.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked**, then choose the extracted `github-unsuck-extension`
   folder containing `manifest.json`.
4. Pin **GitHub / Unsuck** in Chrome's extensions menu.

When working in the source checkout, load the `extension/` directory directly.
Chrome 116 or newer is required. No build is needed to load the source folder.

## Use

- On a GitHub page, click the extension, then **Copy link**. The copy button is
  focused automatically, so pressing Enter also works.
- Right-click a GitHub link on any page and choose **Copy themed GitHub link**.
- Right-click the background of a GitHub page to copy that page's themed link.
- Press **Alt+Shift+U** (Windows/Linux) or **Command+Shift+U** (Mac) to copy the
  current GitHub page directly. Change conflicts at `chrome://extensions/shortcuts`.
- On another site, open the extension and paste a public GitHub URL or an
  `owner/repository` path.
- Choose a named editor theme such as Dracula, Nord, or Catppuccin in the popup.
  The selection also applies to the right-click menu and shortcut.
- **Explore themes + import from VS Code** opens the full theme gallery with
  your current GitHub link. Imported palettes are used by links created on that
  page; the extension remembers its own named/system theme separately.
- **Preview** opens the rendered card without immediately forwarding to GitHub.

**Match my system** is the default. It reads your appearance at creation time
and writes an explicit `theme=dark` or `theme=light` into the link. This works
with chat crawlers that cannot detect the reader's system theme. Everyone sees
the chosen image; it does not change independently for each recipient.
Your selected theme is remembered for the popup, menus, and shortcut.

GitHub URL query parameters and fragments are preserved. Only public GitHub
pages can produce previews; the extension cannot make a private repository
accessible to a chat crawler. Generated links use
`https://github-unsuck.lakebed.app/u?url=...&theme=dark`.

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
