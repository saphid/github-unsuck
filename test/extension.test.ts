import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { SUPPORTED_SERVICES, SUPPORTED_URL_PATTERNS, makePreviewLink, makeShareLink, normalizeGithubUrl, normalizeSupportedUrl, resolveTheme } from "../extension/links.js";
import { createActions, registerBackground } from "../extension/background.js";

function browserMock({ dark = true, theme = "system", clipboardOk = true } = {}) {
  const state = { documents: 0, reads: 0, copies: [] as string[] };
  const browser = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: async () => state.documents ? [{}] : [],
      sendMessage: async (message: { type: string; text?: string }) => {
        if (message.type === "system-theme") { state.reads++; return { ok: true, dark }; }
        if (!clipboardOk) return { ok: false, error: "Clipboard unavailable" };
        state.copies.push(message.text!);
        return { ok: true };
      }
    },
    offscreen: { createDocument: async () => { await new Promise(resolve => setTimeout(resolve, 5)); state.documents++; } },
    storage: { local: { get: async () => ({ theme }) } }
  };
  return { browser, state };
}

test("extension preserves full URLs, nested queries, Unicode, and fragments", () => {
  const original = "https://github.com/owner/repo/pull/42?diff=split&theme=original#discussion_r123";
  const share = new URL(makeShareLink(original, "dark"));
  assert.equal(share.origin, "https://github-unsuck.lakebed.app");
  assert.equal(share.pathname, "/u");
  assert.equal(share.searchParams.get("url"), original);
  assert.equal(share.searchParams.get("theme"), "dark");
  assert.equal(share.hash, "");
  assert.equal(normalizeGithubUrl("github.com/owner/repo"), "https://github.com/owner/repo");
  assert.equal(new URL(makeShareLink("owner/repo?search=深色", "light")).searchParams.get("url"), "https://github.com/owner/repo?search=%E6%B7%B1%E8%89%B2");
  const preview = new URL(makePreviewLink(share.href));
  assert.equal(preview.searchParams.get("preview"), "1");
  assert.equal(preview.searchParams.get("url"), original);
});

test("system preference is captured as an explicit theme for chat crawlers", async () => {
  for (const dark of [true, false]) {
    const { browser, state } = browserMock({ dark });
    const link = await createActions(browser).copyLink("owner/repo");
    assert.equal(new URL(link).searchParams.get("theme"), dark ? "dark" : "light");
    assert.equal(state.reads, 1);
    assert.deepEqual(state.copies, [link]);
  }
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});

test("extension creates service-specific links and copies each public service with the chosen theme", async () => {
  const { browser, state } = browserMock({ theme: "t3-chat-dark" });
  const actions = createActions(browser);
  for (const service of SUPPORTED_SERVICES) {
    const original = new URL(service.example);
    original.searchParams.set("theme", "original");
    original.searchParams.set("tracking", "a&b");
    original.hash = "section";
    const share = new URL(await actions.copyLink(original.href));
    assert.equal(share.pathname, service.id === "github" ? "/u" : service.route);
    assert.equal(share.searchParams.get("url"), normalizeSupportedUrl(original.href));
    assert.equal(share.searchParams.get("theme"), "t3-chat-dark");
    const preview = new URL(makePreviewLink(share.href));
    assert.equal(preview.searchParams.get("url"), share.searchParams.get("url"));
    assert.equal(preview.searchParams.get("preview"), "1");
  }
  assert.equal(state.copies.length, SUPPORTED_SERVICES.length);
  assert.equal(state.reads, 0);
  for (const input of ["https://evil.test/u?url=https://github.com/a/b", "https://user:pass@github-unsuck.lakebed.app/u?url=a/b", "https://github-unsuck.lakebed.app/unknown?url=a/b"]) {
    assert.throws(() => makePreviewLink(input));
  }
});

test("right-click menus cover exact supported service hosts without general website access", () => {
  const { browser } = browserMock();
  const menus: { contexts: string[]; targetUrlPatterns?: string[]; documentUrlPatterns?: string[] }[] = [];
  let install: () => void = () => { throw Error("Installation listener missing"); };
  registerBackground({
    ...browser,
    runtime: {
      ...browser.runtime,
      onInstalled: { addListener: callback => { install = callback; } },
      onMessage: { addListener() {} }
    },
    contextMenus: {
      removeAll: callback => callback(),
      create: menu => menus.push(menu),
      onClicked: { addListener() {} }
    },
    commands: { onCommand: { addListener() {} } }
  });
  install();
  assert.equal(menus.length, 2);
  assert.deepEqual(menus.find(menu => menu.contexts.includes("link"))?.targetUrlPatterns, SUPPORTED_URL_PATTERNS);
  assert.deepEqual(menus.find(menu => menu.contexts.includes("page"))?.documentUrlPatterns, SUPPORTED_URL_PATTERNS);
  for (const service of SUPPORTED_SERVICES) {
    for (const host of service.hosts) assert.ok(SUPPORTED_URL_PATTERNS.includes(`https://${host}/*`));
  }
  assert.ok(SUPPORTED_URL_PATTERNS.every(pattern => /^https:\/\/[a-z0-9.-]+\/\*$/.test(pattern)));
});

test("saved explicit themes override the system without reading appearance", async () => {
  const { browser, state } = browserMock({ theme: "light", dark: true });
  const actions = createActions(browser);
  const saved = await actions.copyLink("owner/repo");
  assert.equal(new URL(saved).searchParams.get("theme"), "light");
  const selected = await actions.copyLink("owner/repo", "dark");
  assert.equal(new URL(selected).searchParams.get("theme"), "dark");
  assert.equal(state.reads, 0);
  assert.equal(state.documents, 1);
});

test("concurrent copy actions create only one offscreen document", async () => {
  const { browser, state } = browserMock();
  const actions = createActions(browser);
  const links = await Promise.all([actions.copyLink("owner/one", "dark"), actions.copyLink("owner/two", "dark")]);
  assert.equal(state.documents, 1);
  assert.deepEqual(state.copies.sort(), links.sort());
});

test("unsupported URLs never reach the clipboard; clipboard failures surface", async () => {
  const { browser, state } = browserMock();
  const actions = createActions(browser);
  for (const input of ["https://github.com.evil.test/owner/repo", "https://github.com@evil.test/repo", "https://user:pass@github.com/repo", "http://github.com/owner/repo", "https://github.com/", "", "https://localhost/secret", "chrome://newtab/", "chrome-extension://test/popup.html", "file:///tmp/file", "about:blank", "javascript:alert(1)"]) {
    await assert.rejects(actions.copyLink(input));
  }
  assert.equal(state.documents, 0);
  assert.deepEqual(state.copies, []);
  const unavailable = browserMock({ clipboardOk: false, theme: "dark" });
  await assert.rejects(createActions(unavailable.browser).copyLink("owner/repo"), /Clipboard unavailable/);
});

test("offscreen handler writes, clears its clipboard field, and rejects other senders", async () => {
  let listener;
  let writes = 0;
  const field = { value: "", focus() {}, select() {} };
  const context = {
    chrome: { runtime: { id: "test", onMessage: { addListener: handler => { listener = handler; } } } },
    document: { getElementById: () => field, execCommand: command => { assert.equal(command, "copy"); writes++; return true; } },
    matchMedia: () => ({ matches: true })
  };
  vm.runInNewContext(await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8"), context);
  let result;
  listener({ target: "offscreen", type: "copy", text: "https://example.test/link" }, { id: "other" }, value => { result = value; });
  assert.equal(writes, 0);
  listener({ target: "offscreen", type: "copy", text: "https://example.test/link" }, { id: "test" }, value => { result = value; });
  assert.equal(result.ok, true);
  assert.equal(writes, 1);
  assert.equal(field.value, "");
  listener({ target: "offscreen", type: "system-theme" }, { id: "test" }, value => { result = value; });
  assert.equal(result.dark, true);
});

test("manifest needs no broad site access or content scripts", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes("activeTab"));
  for (const file of [manifest.action.default_popup, manifest.background.service_worker, ...Object.values(manifest.icons)]) {
    assert.ok((await readFile(new URL(`../extension/${file}`, import.meta.url))).length);
  }
});
