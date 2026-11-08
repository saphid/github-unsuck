// Keep this factory self-contained: the builder embeds it and the extension
// packages this file directly, so all link entry points share the same rules.
export function createServiceTools() {
  const services = [
    { id: 'github', name: 'GitHub', hosts: ['github.com'], route: '/github', example: 'https://github.com/pingdotgg/t3code' },
    { id: 'youtube', name: 'YouTube', hosts: ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'], route: '/youtube', example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { id: 'gitlab', name: 'GitLab', hosts: ['gitlab.com'], route: '/gitlab', example: 'https://gitlab.com/gitlab-org/gitlab' },
    { id: 'npm', name: 'npm', hosts: ['www.npmjs.com', 'npmjs.com'], route: '/npm', example: 'https://www.npmjs.com/package/typescript' },
    { id: 'pypi', name: 'PyPI', hosts: ['pypi.org'], route: '/pypi', example: 'https://pypi.org/project/requests/' },
    { id: 'wikipedia', name: 'Wikipedia', hosts: ['en.wikipedia.org'], route: '/wikipedia', example: 'https://en.wikipedia.org/wiki/TypeScript' }
  ];
  const invalid = () => Error('Use a supported public HTTPS link: GitHub, YouTube, GitLab, npm, PyPI, or English Wikipedia.');
  function detect(input) {
    let url;
    try { url = new URL(String(input)); } catch { throw invalid(); }
    if (url.href.length > 4096 || url.protocol !== 'https:' || url.port || url.username || url.password) throw invalid();
    const service = services.find(item => item.hosts.includes(url.hostname));
    if (!service) throw invalid();
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { throw invalid(); }
    if (/[\\\u0000-\u001f\u007f]/.test(path)) throw invalid();
    if (service.id === 'github' && !path.split('/').filter(Boolean).length) throw invalid();
    if (service.id === 'youtube') {
      const id = url.hostname === 'youtu.be' ? path.match(/^\/([\w-]{11})\/?$/)?.[1]
        : path === '/watch' ? url.searchParams.get('v') : path.match(/^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/)?.[1];
      if (!id || !/^[\w-]{11}$/.test(id)) throw Error('Choose a YouTube video link (watch, youtu.be, Shorts, or live), not a channel or playlist.');
    }
    if (service.id === 'gitlab') {
      const parts = path.replace(/\/$/, '').split('/-/');
      if (parts.length > 2 || !/^\/[\w][\w.-]*(?:\/[\w][\w.-]*)+$/.test(parts[0]) || (parts[1] !== undefined && !/^(?:merge_requests|issues)\/\d+$/.test(parts[1]))) throw Error('Choose a public gitlab.com project, merge request, or issue.');
    }
    if (service.id === 'npm' && !/^\/package\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/v\/[\w.+-]{1,80})?\/?$/.test(path)) throw Error('Choose an npm package or package-version link.');
    if (service.id === 'pypi' && !/^\/project\/[a-z\d][a-z\d._-]*(?:\/[\w.+!-]{1,80})?\/?$/i.test(path)) throw Error('Choose a PyPI project or project-version link.');
    if (service.id === 'wikipedia' && (!path.startsWith('/wiki/') || !path.slice(6).trim())) throw Error('Choose an English Wikipedia article link.');
    return service;
  }
  function normalize(input) {
    let value = String(input ?? '').trim();
    if (!value || value.length > 4096) throw invalid();
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
    if (hasScheme && !/^https:\/\//i.test(value)) throw invalid();
    if (!hasScheme) {
      const host = value.split(/[/?#]/)[0].toLowerCase();
      if (services.some(item => item.hosts.includes(host))) value = 'https://' + value;
      else {
        // A dotted/credentialed first component is an unsupported host, not a
        // GitHub owner shorthand. Never silently turn arbitrary sites into repos.
        const owner = value.replace(/^\/+/, '').split(/[/?#]/)[0];
        if (/[.:@]/.test(owner)) throw invalid();
        value = 'https://github.com/' + value.replace(/^\/+/, '');
      }
    }
    let url;
    try { url = new URL(value); } catch { throw invalid(); }
    detect(url);
    return url.href;
  }
  return { services, normalize, detect };
}
