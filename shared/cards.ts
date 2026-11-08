import { escapeHtml as e, HttpError, type Metadata } from './github.ts';
import { serviceTools, serviceForUrl } from './services.ts';
import { themeTools, type PaletteTheme } from './themes.ts';

function clean(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f\ufffe\uffff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Estimate glyph widths for wrapping plain SVG text without fonts or a DOM.
function lines(text: string, fontSize: number, maxLines: number): string[] {
  const result: string[] = [];
  let line = '', width = 0;
  for (const char of clean(text, 500)) {
    const units = /[ilI.,'!|:;]/.test(char) ? 0.3 : /[MW@%]/.test(char) ? 0.95 : char.charCodeAt(0) > 255 ? 1 : 0.6;
    if (width + units * fontSize > 1056) {
      result.push(line.trim());
      line = ''; width = 0;
      if (result.length === maxLines) {
        result[maxLines - 1] = result[maxLines - 1].slice(0, -2).trimEnd() + '…';
        return result;
      }
    }
    line += char; width += units * fontSize;
  }
  if (line.trim()) result.push(line.trim());
  return result;
}

export function serviceCardImage(metadata: Metadata, target: URL, theme: PaletteTheme, origin: string): string {
  const service = serviceForUrl(target);
  const card = new URL('/card.svg', origin);
  card.search = themeTools.parameters(theme).toString();
  card.searchParams.set('service', service.id);
  card.searchParams.set('title', clean(metadata.title, 140));
  card.searchParams.set('description', clean(metadata.description, 260));
  card.searchParams.set('path', clean(target.hostname + target.pathname, 100));
  // Raster PNGs work in chat crawlers that don't accept SVG Open Graph images.
  const image = new URL('https://wsrv.nl/');
  image.search = new URLSearchParams({ url: card.href, output: 'png', w: '1200', h: '600', fit: 'contain' }).toString();
  return image.href;
}

export function renderCard(url: URL): string {
  const service = serviceTools.services.find(item => item.id === url.searchParams.get('service'));
  if (!service) throw new HttpError(400, 'Choose a supported service for this card.');
  let theme: PaletteTheme;
  try { theme = themeTools.resolve(url.searchParams.get('theme'), url.searchParams.get('palette'), url.searchParams.get('name')); }
  catch (error) { throw new HttpError(400, error.message); }
  const title = clean(url.searchParams.get('title') || '', 140);
  if (!title) throw new HttpError(400, 'A card needs a title.');
  const description = clean(url.searchParams.get('description') || '', 260);
  const path = clean(url.searchParams.get('path') || '', 100);
  const [bg, fg, accent, surface] = theme.colors;
  const surfaceText = surface === fg ? bg : fg;
  const titleLines = lines(title, 46, 2);
  const descriptionLines = lines(description, 27, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600" role="img" aria-label="${e(title)}">
<title>${e(title)}</title><desc>${e(description)}</desc>
<rect width="1200" height="600" fill="#${bg}"/><rect width="12" height="600" fill="#${accent}"/>
<rect y="488" width="1200" height="112" fill="#${surface}"/>
<g font-family="DejaVu Sans, sans-serif" fill="#${fg}">
<text x="64" y="85" font-size="22" font-weight="bold" letter-spacing="2">${e(service.name.toUpperCase())}</text>
<rect x="902" y="53" width="234" height="44" rx="22" fill="#${surface}"/>
<text x="1019" y="81" text-anchor="middle" font-size="14" fill="#${surfaceText}">${e(clean(theme.name, 27))}</text>
${titleLines.map((line, i) => `<text x="64" y="${181 + i * 60}" font-size="46" font-weight="bold">${e(line)}</text>`).join('')}
${descriptionLines.map((line, i) => `<text x="64" y="${329 + i * 39}" font-size="27" opacity="0.78">${e(line)}</text>`).join('')}
<text x="64" y="530" font-size="19" fill="#${surfaceText}">${e(path.length > 86 ? path.slice(0, 84) + '…' : path)}</text>
<text x="64" y="569" font-size="15" fill="#${surfaceText}" letter-spacing="2" opacity="0.6">LINKS / UNSUCK</text>
</g></svg>`;
}
