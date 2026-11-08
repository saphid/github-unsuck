import { DEFAULT_THEME, PRESET_THEMES, SERVICE_ORIGIN, makePreviewLink, makeShareLink, normalizeGithubUrl, resolveTheme, validTheme } from "./links.js";

const input = document.getElementById("github-url");
const theme = document.getElementById("theme");
const output = document.getElementById("share-link");
const copy = document.getElementById("copy");
const preview = document.getElementById("preview");
const status = document.getElementById("status");
const appearance = matchMedia("(prefers-color-scheme: dark)");
for (const [id, label] of PRESET_THEMES) theme.add(new Option(label, id));
const themesPage = document.getElementById("themes-page");
themesPage.addEventListener("click", event => {
  const url = new URL("/themes", SERVICE_ORIGIN);
  try { url.searchParams.set("url", normalizeGithubUrl(input.value)); } catch { /* Keep the gallery's sample URL. */ }
  url.searchParams.set("theme", resolveTheme(theme.value, appearance.matches));
  event.currentTarget.href = url.href;
});
let ready = false;
let busy = false;

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function update() {
  message("");
  copy.firstChild.textContent = "Copy link ";
  try {
    output.value = makeShareLink(input.value, resolveTheme(theme.value, appearance.matches));
    copy.disabled = !ready || busy;
    preview.disabled = !ready || busy;
    return true;
  } catch {
    output.value = "";
    copy.disabled = true;
    preview.disabled = true;
    return false;
  }
}

input.addEventListener("input", update);
input.addEventListener("blur", () => {
  if (input.value.trim() && !update()) message("Use a public GitHub link or owner/repository path.", true);
});
output.addEventListener("click", () => output.select());
appearance.addEventListener("change", update);
theme.addEventListener("change", async () => {
  update();
  try { await chrome.storage.local.set({ theme: theme.value }); }
  catch { message("Theme could not be saved. This link still uses your selection.", true); }
});

document.getElementById("link-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!ready || busy || !update()) return;
  busy = true;
  update();
  try {
    const result = await chrome.runtime.sendMessage({ target: "background", type: "copy", url: input.value, theme: theme.value });
    if (!result?.ok) throw new Error(result?.error ?? "The link could not be copied.");
    output.value = result.link;
    message("Copied. Paste it into your chat.");
    copy.firstChild.textContent = "Copied ";
  } catch (error) {
    output.focus();
    output.select();
    message(`${error.message} You can copy the selected link field.`, true);
  } finally {
    busy = false;
    copy.disabled = !output.value;
    preview.disabled = !output.value;
  }
});

preview.addEventListener("click", async () => {
  if (!update()) return;
  try { await chrome.tabs.create({ url: makePreviewLink(output.value) }); }
  catch { message("Chrome could not open the preview. Copy the link and open it in a tab.", true); }
});

async function initialize() {
  const [stored, tabs, commands] = await Promise.allSettled([
    chrome.storage.local.get({ theme: DEFAULT_THEME }),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.commands.getAll()
  ]);
  theme.value = validTheme(stored.status === "fulfilled" ? stored.value.theme : DEFAULT_THEME);
  if (tabs.status === "fulfilled") {
    try { input.value = normalizeGithubUrl(tabs.value[0]?.url); } catch { /* A pasted URL works on any page. */ }
  }
  if (commands.status === "fulfilled") {
    const shortcut = commands.value.find(command => command.name === "copy-link")?.shortcut;
    if (shortcut) document.getElementById("shortcut").textContent = shortcut;
  }
  ready = true;
  update();
  if (input.value) copy.focus();
  else input.focus();
}

void initialize();
