import { createServiceTools } from './service-runtime.js';
import { decodeEntities, HttpError, loadMetadata, type Metadata } from './github.ts';

export { createServiceTools };
export type Service = { id: string; name: string; hosts: string[]; route: string; example: string };
export const serviceTools = createServiceTools();
export function supportedUrl(input: string): URL {
  try { return new URL(serviceTools.normalize(input)); }
  catch (error) { throw new HttpError(400, error.message); }
}
export function serviceForUrl(target: URL): Service {
  try { return serviceTools.detect(target); }
  catch (error) { throw new HttpError(400, error.message); }
}

const maxBody = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, limit = 1200): string {
  return typeof value === 'string' ? decodeEntities(value).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}
function image(value: unknown, hosts: string[]): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && hosts.includes(url.hostname) ? url.href : '';
  } catch { return ''; }
}
function metadata(title: unknown, description: unknown, sourceImage = ''): Metadata {
  const heading = text(title, 400);
  if (!heading) throw new HttpError(502, 'The service did not return a usable preview title.');
  return { title: heading, description: text(description), image: sourceImage, imageAlt: heading };
}

async function readJson(response: Response, name: string): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBody) throw new HttpError(502, `${name} metadata is too large.`);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('json')) throw new HttpError(502, `${name} did not return JSON metadata.`);
  let body = '';
  const reader = response.body?.getReader();
  try {
    if (reader) {
      let size = 0, done = false;
      const decoder = new TextDecoder();
      for (let chunk = 0; chunk < 4096; chunk++) {
        const part = await reader.read();
        if (part.done) { done = true; break; }
        size += part.value.byteLength;
        if (size > maxBody) throw new HttpError(502, `${name} metadata is too large.`);
        body += decoder.decode(part.value, { stream: true });
      }
      if (!done) throw new HttpError(502, `${name} metadata is too large.`);
      body += decoder.decode();
    } else {
      // Lakebed's outbound fetch buffers responses and exposes no body stream.
      body = await response.text();
      const size = typeof TextEncoder === 'undefined' ? body.length * 3 : new TextEncoder().encode(body).byteLength;
      if (size > maxBody) throw new HttpError(502, `${name} metadata is too large.`);
    }
    const parsed = JSON.parse(body);
    if (!object(parsed)) throw Error('Expected an object');
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `${name} returned invalid or interrupted metadata.`);
  } finally { if (reader) await reader.cancel().catch(() => {}); }
}

async function fetchJson(source: URL, name: string, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  let current = new URL(source);
  const signal = AbortSignal.timeout(5000);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try { response = await fetcher(current, { redirect: 'manual', signal, headers: { Accept: 'application/json', 'User-Agent': 'Unsuck/0.3 (+https://github.com/saphid/github-unsuck)' } }); }
    catch { throw new HttpError(502, `${name} could not be reached. Try again shortly.`); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      let next: URL;
      try { next = new URL(location ?? '', current); } catch { throw new HttpError(502, `${name} returned an invalid redirect.`); }
      // API endpoints are built from fixed trusted origins; redirects cannot
      // expand the fetch surface to user-selected hosts, ports, or HTTP.
      if (!location || next.origin !== source.origin || next.username || next.password) throw new HttpError(502, `${name} returned an unsupported metadata redirect.`);
      current = next;
      continue;
    }
    if (response.status === 404 || response.status === 410) throw new HttpError(404, `${name} link not found or not public.`);
    if (response.status === 401 || response.status === 403 || response.status === 429) throw new HttpError(503, `${name} is limiting public previews. Try again shortly.`);
    if (!response.ok) throw new HttpError(502, `${name} could not load this preview.`);
    return readJson(response, name);
  }
  throw new HttpError(502, `${name} redirected too many times.`);
}

export async function loadServiceMetadata(target: URL, fetcher: typeof fetch = fetch): Promise<Metadata> {
  const service = serviceForUrl(target);
  if (service.id === 'github') return loadMetadata(target, fetcher);
  const path = decodeURIComponent(target.pathname).replace(/\/$/, '');
  if (service.id === 'youtube') {
    const id = target.hostname === 'youtu.be' ? path.slice(1) : path === '/watch' ? target.searchParams.get('v')! : path.split('/')[2];
    const api = new URL('https://www.youtube.com/oembed');
    api.search = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: 'json' }).toString();
    const value = await fetchJson(api, service.name, fetcher);
    return metadata(value.title, text(value.author_name) ? `YouTube video by ${text(value.author_name)}.` : '', image(value.thumbnail_url, ['i.ytimg.com', 'img.youtube.com']));
  }
  if (service.id === 'npm') {
    const parts = path.match(/^\/package\/((?:@[^/]+\/)?[^/]+)(?:\/v\/([^/]+))?$/)!;
    const name = parts[1], version = parts[2] || 'latest';
    const api = new URL(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    const value = await fetchJson(api, service.name, fetcher);
    const packageName = text(value.name, 200), packageVersion = text(value.version, 80);
    if (!packageName || !packageVersion) throw new HttpError(502, 'npm did not return a package name and version.');
    return metadata(`${packageName} · ${packageVersion}`, value.description);
  }
  if (service.id === 'pypi') {
    const parts = path.slice('/project/'.length).split('/');
    const api = new URL(`https://pypi.org/pypi/${encodeURIComponent(parts[0])}/${parts[1] ? encodeURIComponent(parts[1]) + '/' : ''}json`);
    const value = await fetchJson(api, service.name, fetcher);
    if (!object(value.info)) throw new HttpError(502, 'PyPI did not return project metadata.');
    const name = text(value.info.name, 200), version = text(value.info.version, 80);
    if (!name || !version) throw new HttpError(502, 'PyPI did not return a project name and version.');
    return metadata(`${name} · ${version}`, value.info.summary);
  }
  if (service.id === 'wikipedia') {
    const api = new URL(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(path.slice('/wiki/'.length))}`);
    const value = await fetchJson(api, service.name, fetcher);
    const thumbnail = object(value.thumbnail) ? image(value.thumbnail.source, ['upload.wikimedia.org', 'thumb.wikimedia.org']) : '';
    return metadata(value.title, value.extract || value.description, thumbnail);
  }
  if (service.id === 'gitlab') {
    const parts = path.slice(1).split('/-/');
    const project = parts[0];
    const suffix = parts[1] ? '/' + parts[1] : '';
    const api = new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}${suffix}`);
    const value = await fetchJson(api, service.name, fetcher);
    if (suffix) {
      const number = suffix.split('/')[2];
      const kind = suffix.startsWith('/merge_requests/') ? 'Merge request' : 'Issue';
      const state = text(value.state, 30);
      return metadata(value.title, `${project} · ${kind} ${kind === 'Merge request' ? '!' : '#'}${number}${state ? ' · ' + state : ''}${text(value.description) ? '\n' + text(value.description) : ''}`);
    }
    return metadata(value.name_with_namespace, value.description, image(value.avatar_url, ['gitlab.com']));
  }
  throw new HttpError(400, 'That service is not supported.');
}
