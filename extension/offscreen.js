chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== "offscreen") return;
  if (message.type === "system-theme") {
    sendResponse({ ok: true, dark: matchMedia("(prefers-color-scheme: dark)").matches });
    return;
  }
  if (message.type !== "copy") return;
  const field = document.getElementById("clipboard");
  try {
    if (typeof message.text !== "string" || message.text.length > 16000) throw new Error("The link could not be copied.");
    field.value = message.text;
    field.focus();
    field.select();
    // Chrome's offscreen clipboard recipe uses execCommand: navigator.clipboard
    // requires focus that a hidden document cannot reliably acquire.
    if (!document.execCommand("copy")) throw new Error("Chrome could not copy the link. Open the extension and copy the link field.");
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  } finally {
    field.value = "";
  }
});
