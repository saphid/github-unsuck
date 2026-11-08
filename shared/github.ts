import { themeTools, type PaletteTheme } from "./themes.ts";
export type Theme = string;
export type Metadata = { title: string; description: string; image: string; imageAlt: string };
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function githubUrl(input: string): URL {
  const value = input.trim();
  if (!value || value.length > 4096) throw new HttpError(400, "Enter a GitHub URL or owner/repository path.");
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://github.com/${value.replace(/^github\.com\//i, "").replace(/^\/+/, "")}`); }
  catch { throw new HttpError(400, "Invalid GitHub URL."); }
  if (url.hostname !== "github.com" || url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new HttpError(400, "Only public https://github.com URLs are supported.");
  }
  if (!url.pathname.split("/").filter(Boolean).length) throw new HttpError(400, "Include a GitHub user or repository path.");
  // The theme query belongs to this service. GitHub's own query and fragment live inside `url`.
  return url;
}

export function themeParam(value: string | null): Theme {
  if (!value) return "dark";
  try { themeTools.resolve(value); return value; }
  catch (error) { throw new HttpError(400, error.message); }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "�";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? match;
  });
}

export function parseMetadata(html: string): Metadata {
  const tags = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4]));
    }
    const key = attrs.get("property") ?? attrs.get("name");
    if (key && attrs.has("content")) tags.set(key, attrs.get("content")!);
  }
  const image = tags.get("og:image");
  let parsed: URL;
  try { parsed = new URL(image ?? ""); } catch { throw new HttpError(502, "GitHub did not return a preview image for this page."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      !["opengraph.githubassets.com", "repository-images.githubusercontent.com", "avatars.githubusercontent.com"].includes(parsed.hostname)) {
    throw new HttpError(502, "GitHub returned an unsupported preview image host.");
  }
  return {
    title: (tags.get("og:title") ?? "GitHub").slice(0, 400),
    description: (tags.get("og:description") ?? "View on GitHub").slice(0, 1200),
    image: parsed.href,
    imageAlt: (tags.get("og:image:alt") ?? tags.get("og:title") ?? "GitHub link preview").slice(0, 1200)
  };
}

export async function loadMetadata(target: URL, fetcher: typeof fetch = fetch): Promise<Metadata> {
  // Do not forward user headers or follow redirects to arbitrary hosts.
  let current = new URL(target.href);
  current.hash = "";
  const signal = AbortSignal.timeout(3500);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try { response = await fetcher(current, { redirect: "manual", signal, headers: { Accept: "text/html", "User-Agent": "ThemeUnfurl/0.1 (+https://github.unsuck.dev)" } }); }
    catch { throw new HttpError(502, "GitHub could not be reached. Try again shortly."); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new HttpError(502, "GitHub returned an invalid redirect.");
      current = githubUrl(new URL(location, current).href);
      continue;
    }
    if (response.status === 404) throw new HttpError(404, "GitHub page not found. Private repositories are not supported.");
    if (response.status === 429 || response.status === 403) throw new HttpError(503, "GitHub is limiting requests. Try again shortly.");
    if (!response.ok) throw new HttpError(502, "GitHub could not load this page.");
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) throw new HttpError(400, "This GitHub URL is not a web page.");
    const reader = response.body?.getReader();
    // Hosted Lakebed fetch responses expose text()/json(), but no ReadableStream.
    // The platform has already buffered these responses. Keep native streaming
    // locally and apply the same size guard to the hosted text fallback.
    if (!reader) {
      let html: string;
      try { html = await response.text(); }
      catch { throw new HttpError(502, "GitHub's response was interrupted. Try again shortly."); }
      const size = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(html).byteLength : html.length * 3;
      if (size > 1024 * 1024) throw new HttpError(502, "GitHub page metadata is too large.");
      return parseMetadata(html);
    }
    const decoder = new TextDecoder();
    let html = "", size = 0;
    try {
      for (let chunk = 0; chunk < 4096; chunk++) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new HttpError(502, "GitHub page metadata is too large.");
        html += decoder.decode(value, { stream: true });
        if (/<\/head\s*>/i.test(html)) break;
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "GitHub's response was interrupted. Try again shortly.");
    } finally { await reader.cancel().catch(() => {}); }
    return parseMetadata(html);
  }
  throw new HttpError(502, "GitHub redirected too many times.");
}

export function imageUrl(metadata: Metadata, theme: string | PaletteTheme): string {
  const selected = typeof theme === "string" ? themeTools.resolve(theme) : themeTools.resolve(theme.id, theme.id === "custom" ? theme.colors.join("-") : undefined, theme.name);
  if (selected.id === "light") return metadata.image;
  // Reuse GitHub's exact card layout and details. Duotone maps its white background
  // to GitHub dark and its dark text to light; artwork also becomes duotone.
  const image = new URL("https://wsrv.nl/");
  image.search = new URLSearchParams({ url: metadata.image, filt: "duotone", start: selected.colors[1], stop: selected.colors[0], output: "png", w: "1200" }).toString();
  return image.href;
}
