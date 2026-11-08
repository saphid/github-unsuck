export const SERVICE_ORIGIN = "https://github-unsuck.lakebed.app";
export const DEFAULT_THEME = "system";
export const PRESET_THEMES = [
  ["t3-code-dark", "T3 Code · Dark"], ["t3-code-light", "T3 Code · Light"],
  ["t3-chat-dark", "T3 Chat · Dark"], ["t3-chat-light", "T3 Chat · Light"],
  ["hotdog", "Cursed Hotdog · Hot Dog Stand"],
  ["vscode-dark", "VS Code · Dark+"], ["vscode-light", "VS Code · Light+"],
  ["catppuccin-mocha", "Catppuccin · Mocha"], ["catppuccin-latte", "Catppuccin · Latte"],
  ["dracula", "Dracula"], ["nord", "Nord"], ["one-dark-pro", "One Dark Pro"],
  ["solarized-dark", "Solarized Dark"], ["solarized-light", "Solarized Light"]
];
const explicitThemes = ["dark", "light", ...PRESET_THEMES.map(([id]) => id)];

export function normalizeGithubUrl(input) {
  const value = String(input ?? "").trim();
  if (!value || value.length > 4096) throw new Error("Enter a public GitHub link or owner/repository path.");
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    throw new Error("Use a public https://github.com link with a user or repository path.");
  }
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://github.com/${value.replace(/^github\.com\//i, "").replace(/^\/+/, "")}`);
  } catch {
    throw new Error("That GitHub link is not valid.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || !url.pathname.split("/").filter(Boolean).length) {
    throw new Error("Use a public https://github.com link with a user or repository path.");
  }
  return url.href;
}

export function validTheme(value) {
  return [...explicitThemes, "system"].includes(value) ? value : DEFAULT_THEME;
}

export function resolveTheme(mode, systemDark) {
  const selected = validTheme(mode);
  return selected === "system" ? (systemDark ? "dark" : "light") : selected;
}

export function makeShareLink(input, theme) {
  if (!explicitThemes.includes(theme)) throw new Error("Choose a supported theme before creating the link.");
  const url = new URL("/u", SERVICE_ORIGIN);
  url.search = new URLSearchParams({ url: normalizeGithubUrl(input), theme }).toString();
  return url.href;
}

export function makePreviewLink(shareLink) {
  const url = new URL(shareLink);
  if (url.origin !== SERVICE_ORIGIN || url.pathname !== "/u") throw new Error("Not a themed GitHub link.");
  url.searchParams.set("preview", "1");
  return url.href;
}
