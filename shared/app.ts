import { themeTools } from "./themes.ts";
import { themePageContent, themePageScript, themePageStyle } from "./theme-page.ts";
import { escapeHtml as e, githubPathTarget, githubUrl, HttpError, imageUrl, loadMetadata } from "./github.ts";

export type AppResponse = { status: number; headers: Record<string, string>; body: string };
const baseHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' https://wsrv.nl https://opengraph.githubassets.com https://repository-images.githubusercontent.com https://avatars.githubusercontent.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const style = `
:root{color-scheme:light dark;--bg:#f6f8fa;--surface:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--accent:#0969da}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--surface:#161b22;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--accent:#79c0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:840px;margin:0 auto;padding:72px 24px 40px}.wordmark{font:600 13px ui-monospace,monospace;letter-spacing:.08em;color:var(--muted)}h1{font-size:clamp(36px,7vw,60px);line-height:1.08;letter-spacing:-.05em;font-weight:650;margin:36px 0 20px}p{color:var(--muted);max-width:640px}a{color:var(--accent);text-underline-offset:4px}form{margin-top:36px}label{display:block;font-weight:600;font-size:14px;margin:0 0 8px}.row{display:flex;gap:10px}input,select,button,.button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:12px 16px;background:var(--surface);color:var(--fg)}input{min-width:0;flex:1;width:100%}button,.button{cursor:pointer;font-weight:600;white-space:nowrap;text-decoration:none}button[type=submit],.primary{background:var(--fg);color:var(--bg)}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.options{display:flex;align-items:center;gap:12px;margin:16px 0}.options label{margin:0}.options select{padding:8px 12px}.hint{font-size:13px;margin-top:14px}code{font-size:.9em;overflow-wrap:anywhere}#result{border-top:1px solid var(--line);margin-top:40px;padding-top:24px}img{display:block;width:100%;border-radius:12px;border:1px solid var(--line);height:auto}.result-actions{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}#output{font:13px/1.6 ui-monospace,monospace;margin:16px 0}footer{border-top:1px solid var(--line);padding-top:20px;margin-top:56px;font-size:13px;color:var(--muted)}[hidden]{display:none!important}#status{min-height:26px;font-size:14px} @media(max-width:560px){main{padding-top:36px}.row{flex-direction:column}.row button{width:100%}.result-actions>*{flex:1;text-align:center}}
`;
function shell(title: string, content: string, head = "", script = "", className = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${e(title)}</title>${head}<style>${style}</style></head><body><main class="${e(className)}"><div class="wordmark">GITHUB / UNSUCK</div>${content}<footer>A tiny wrapper for public GitHub links. Themed images use <a href="https://images.weserv.nl/">wsrv.nl</a>; image artwork is recolored too.</footer></main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}
export function home(): AppResponse {
  const body = shell("GitHub, minus the flashbang.", `
    <h1>GitHub, minus<br>the flashbang.</h1>
    <p>Share the same repo, issue, or pull request. Give its link preview a darker home.</p>
    <form id="builder" action="/u" method="get">
      <label for="github-url">GitHub link</label>
      <div class="row"><input id="github-url" name="url" type="text" placeholder="https://github.com/owner/repo/pull/123" required autocomplete="off" spellcheck="false"><button type="submit">Make a link ↗</button></div>
      <div class="options"><label for="theme">Preview theme</label><select name="theme" id="theme"><option value="dark">Dark</option><option value="light">Light</option><option value="auto">System (best effort)</option></select></div>
    </form>
    <p><a id="browse-themes" href="/themes">Choose an editor theme or import from VS Code ↗</a></p>
    <p class="hint">Chat apps cache one image for everyone. Dark is the default. System mode uses a theme hint when available, otherwise dark.</p>
    <section id="result" hidden aria-label="Your themed link"><label for="output">Ready to share</label><input id="output" readonly><div class="result-actions"><button id="copy" type="button">Copy link</button><a id="original" class="button" rel="noreferrer">Open GitHub ↗</a></div><p id="status" role="status" aria-live="polite"></p><img id="card" alt="Themed GitHub link preview" width="1200" height="600"></section>`, "", `
const form=document.getElementById('builder'), result=document.getElementById('result'), output=document.getElementById('output'), status=document.getElementById('status'), card=document.getElementById('card');
form.addEventListener('submit',event=>{event.preventDefault();let target;try{let value=form.elements.url.value.trim();target=new URL(/^https?:\\/\\//i.test(value)?value:'https://github.com/'+value.replace(/^github\\.com\\//i,'').replace(/^\\/+/ ,''));if(target.protocol!=='https:'||target.hostname!=='github.com'||target.username||target.password||target.port||!target.pathname.split('/').filter(Boolean).length)throw Error();}catch{form.elements.url.setCustomValidity('Enter a public https://github.com link or owner/repository path.');form.elements.url.reportValidity();return;}const theme=form.elements.theme.value, link=new URL('/u',location.origin);link.search=new URLSearchParams({url:target.href,theme}).toString();output.value=link.href;document.getElementById('original').href=target.href;result.hidden=false;status.textContent='Loading preview…';card.hidden=true;const image=new URL('/image',location.origin);image.search=link.search;if(theme==='auto')image.searchParams.set('theme',matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');card.onload=()=>{status.textContent='Ready. Paste your link into a chat.';card.hidden=false;};card.onerror=()=>{status.textContent='Preview could not load. Check that the GitHub page is public, then try again.';};card.src=image.href;});
form.elements.url.addEventListener('input',()=>form.elements.url.setCustomValidity(''));
document.getElementById('browse-themes').addEventListener('click',event=>{const link=new URL('/themes',location.origin);if(form.elements.url.value.trim())link.searchParams.set('url',form.elements.url.value.trim());event.currentTarget.href=link.href;});
document.getElementById('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(output.value);status.textContent='Link copied.';}catch{output.focus();output.select();status.textContent='Select and copy the link above.';}});
`);
  return { status: 200, headers: { ...baseHeaders, "Cache-Control": "public, max-age=300" }, body };
}

export async function handleRequest(url: URL, headers: Pick<Headers, "get"> = new Headers(), fetcher: typeof fetch = fetch, prettyPaths = false): Promise<AppResponse> {
  try {
    if (url.pathname === "/api/health") return { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: '{"ok":true}' };
    if (url.pathname === "/robots.txt") return { status: 200, headers: { "Content-Type": "text/plain" }, body: "User-agent: *\nAllow: /\n" };
    if (url.pathname === "/themes") return { status: 200, headers: { ...baseHeaders, "Cache-Control": "public, max-age=300" }, body: shell("Themes · GitHub / Unsuck", themePageContent(), `<style>${themePageStyle}</style>`, themePageScript(), "theme-page") };
    if ((url.pathname === "/make" || url.pathname === "/") && !url.searchParams.get("url")) return home();
    const imageRequest = url.pathname === "/image";
    const pathRequest = prettyPaths && !["/", "/make", "/u", "/image"].includes(url.pathname);
    const input = pathRequest ? githubPathTarget(url).href : url.searchParams.get("url");
    if (!input && (url.pathname === "/" || url.pathname === "/make")) return home();
    if (!input) throw new HttpError(400, "Provide a GitHub URL with ?url=https%3A%2F%2Fgithub.com%2Fowner%2Frepo.");
    const target = githubUrl(input);
    let selection;
    try { selection = themeTools.resolve(url.searchParams.get("theme"), url.searchParams.get("palette"), url.searchParams.get("name")); }
    catch (error) { throw new HttpError(400, error.message); }
    const theme = selection.id;
    const resolved = theme === "auto" ? (headers.get("sec-ch-prefers-color-scheme")?.replace(/"/g, "") === "light" ? "light" : "dark") : selection;
    const metadata = await loadMetadata(target, fetcher);
    const image = imageUrl(metadata, resolved);
    const cacheHeaders: Record<string, string> = { "Cache-Control": "public, max-age=600, stale-while-revalidate=3600" };
    if (theme === "auto") {
      cacheHeaders["Accept-CH"] = "Sec-CH-Prefers-Color-Scheme";
      cacheHeaders["Vary"] = "Sec-CH-Prefers-Color-Scheme";
    }
    if (imageRequest) return { status: 302, headers: { ...cacheHeaders, Location: image }, body: "" };
    // Keep the canonical OG URL on the wrapper: some crawlers otherwise replace
    // this card with GitHub's cached white one. Theme is part of the cache key.
    const canonical = new URL(url.href);
    canonical.searchParams.delete("preview");
    const head = `<meta property="og:type" content="website"><meta property="og:site_name" content="GitHub · Unsuck"><meta property="og:url" content="${e(canonical.href)}"><meta property="og:title" content="${e(metadata.title)}"><meta property="og:description" content="${e(metadata.description)}"><meta property="og:image" content="${e(image)}"><meta property="og:image:secure_url" content="${e(image)}"><meta property="og:image:alt" content="${e(metadata.imageAlt)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${e(metadata.title)}"><meta name="twitter:description" content="${e(metadata.description)}"><meta name="twitter:image" content="${e(image)}"><meta name="twitter:image:alt" content="${e(metadata.imageAlt)}"><link rel="canonical" href="${e(canonical.href)}"><meta name="robots" content="noindex,follow">`;
    let picture = `<img src="${e(image)}" alt="${e(metadata.imageAlt)}">`;
    if (theme === "auto") picture = `<picture><source media="(prefers-color-scheme: light)" srcset="${e(imageUrl(metadata, "light"))}"><img src="${e(imageUrl(metadata, "dark"))}" alt="${e(metadata.imageAlt)}"></picture>`;
    const content = `<h1 style="font-size:36px">${e(metadata.title)}</h1><p>${e(metadata.description)}</p>${picture}<div class="result-actions"><a id="github-link" class="button primary" href="${e(target.href)}" rel="noreferrer">Continue to GitHub ↗</a><a class="button" href="/make">Make another link</a></div><p class="hint">${url.searchParams.get("preview") === "1" ? "Preview mode. Your shared link opens GitHub directly." : "Opening GitHub… If you stay here, use the button above."}</p>`;
    // Bots read server-rendered tags without executing JS. Human clicks go straight
    // to GitHub; carry a fragment supplied on the wrapper through to the destination.
    const script = url.searchParams.get("preview") === "1" ? "" : `const target=new URL(document.getElementById('github-link').href);if(location.hash)target.hash=location.hash;location.replace(target.href);`;
    return { status: 200, headers: { ...baseHeaders, ...cacheHeaders }, body: shell(metadata.title, content, head, script) };
  } catch (error) {
    const known = error instanceof HttpError;
    const status = known ? error.status : 500;
    const message = known ? error.message : "Something went wrong while building the preview. Try again shortly.";
    return { status, headers: { ...baseHeaders, "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "60" } : {}) }, body: shell("Preview unavailable", `<h1 style="font-size:42px">Preview unavailable.</h1><p role="alert">${e(message)}</p><a class="button" href="/">Try another link</a>`) };
  }
}
