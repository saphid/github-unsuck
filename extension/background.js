import { DEFAULT_THEME, SUPPORTED_URL_PATTERNS, makeShareLink, normalizeSupportedUrl, resolveTheme, validTheme } from "./links.js";

export function createActions(browser) {
  let creatingDocument;

  async function ensureOffscreen() {
    // Set the promise before awaiting: simultaneous menu/shortcut clicks must
    // share Chrome's single offscreen document creation.
    if (!creatingDocument) {
      creatingDocument = (async () => {
        const contexts = await browser.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [browser.runtime.getURL("offscreen.html")]
        });
        if (!contexts.length) {
          await browser.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["CLIPBOARD", "MATCH_MEDIA"],
            justification: "Copy themed links and read your system color preference."
          });
        }
      })().finally(() => { creatingDocument = undefined; });
    }
    await creatingDocument;
  }

  async function offscreenRequest(type, data = {}) {
    await ensureOffscreen();
    const response = await browser.runtime.sendMessage({ target: "offscreen", type, ...data });
    if (!response?.ok) throw new Error(response?.error ?? "Could not access the clipboard. Open the extension and try again.");
    return response;
  }

  async function copyLink(input, mode) {
    // Reject unsupported URLs before creating a document or touching clipboard.
    const original = normalizeSupportedUrl(input);
    const stored = mode ?? (await browser.storage.local.get({ theme: DEFAULT_THEME })).theme;
    const selection = validTheme(stored);
    const systemDark = selection === "system" ? (await offscreenRequest("system-theme")).dark : false;
    const link = makeShareLink(original, resolveTheme(selection, systemDark));
    await offscreenRequest("copy", { text: link });
    return link;
  }

  return { copyLink };
}

export function registerBackground(browser) {
  const actions = createActions(browser);

  async function showResult(tabId, error) {
    const target = Number.isInteger(tabId) && tabId >= 0 ? { tabId } : {};
    await Promise.all([
      browser.action.setBadgeText({ ...target, text: error ? "!" : "✓" }),
      browser.action.setBadgeBackgroundColor({ ...target, color: error ? "#b42318" : "#238636" }),
      browser.action.setTitle({ ...target, title: error ? error.message : "Themed link copied" })
    ]);
    setTimeout(() => {
      browser.action.setBadgeText({ ...target, text: "" }).catch(() => {});
      browser.action.setTitle({ ...target, title: "Copy a themed link" }).catch(() => {});
    }, error ? 6000 : 2000);
  }

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll(() => {
      browser.contextMenus.create({
        id: "copy-github-link", title: "Copy themed link", contexts: ["link"],
        targetUrlPatterns: SUPPORTED_URL_PATTERNS
      });
      browser.contextMenus.create({
        id: "copy-github-page", title: "Copy this page as a themed link", contexts: ["page"],
        documentUrlPatterns: SUPPORTED_URL_PATTERNS
      });
    });
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || message?.target !== "background" || message.type !== "copy") return;
    actions.copyLink(message.url, message.theme)
      .then(link => sendResponse({ ok: true, link }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!["copy-github-link", "copy-github-page"].includes(info.menuItemId)) return;
    const input = info.menuItemId === "copy-github-link" ? info.linkUrl : info.pageUrl;
    actions.copyLink(input)
      .then(() => showResult(tab?.id))
      .catch(error => showResult(tab?.id, error));
  });

  browser.commands.onCommand.addListener(async command => {
    if (command !== "copy-link") return;
    let tab;
    try {
      [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      await actions.copyLink(tab?.url);
      await showResult(tab?.id);
    } catch (error) {
      await showResult(tab?.id, error);
    }
  });
}

if (typeof chrome !== "undefined") registerBackground(chrome);
