import { capsule, endpoint, text } from "lakebed/server";
import { handleRequest } from "../shared/app.ts";
import { hostedGithubPaths } from "../shared/hosted-paths.ts";
import { serviceTools } from "../shared/services.ts";

// Lakebed 0.0.41 matches endpoint paths exactly. /u works for every GitHub URL;
// registered path aliases also serve metadata without crawler JavaScript.
function route(path: `/${string}`, prettyPaths = false) {
  return endpoint({ method: "GET", path, readOnly: true }, async (ctx, request) => {
    const url = new URL(request.url);
    // The hosted runner reconstructs req.url with its internal HTTP scheme.
    // Canonical/OG URLs must retain the public HTTPS origin for crawler caches.
    if (ctx.env.PUBLIC_ORIGIN) {
      const origin = new URL(ctx.env.PUBLIC_ORIGIN);
      url.protocol = origin.protocol;
      url.host = origin.host;
    } else if (url.hostname.endsWith(".lakebed.app")) {
      url.protocol = "https:";
    }
    const result = await handleRequest(url, request.headers, fetch, prettyPaths);
    return text(result.body, { status: result.status, headers: result.headers });
  });
}
export default capsule({
  name: "theme-unfurl",
  auth: { requireSignIn: false },
  endpoints: {
    home: route("/make"), themes: route("/themes"), unfurl: route("/u"),
    image: route("/image"), card: route("/card.svg"), health: route("/api/health"), robots: route("/robots.txt"),
    ...Object.fromEntries(serviceTools.services.map(service => [service.id, route(service.route as `/${string}`)])),
    ...Object.fromEntries(hostedGithubPaths.map((path, index) => [`githubPath${index}`, route(path, true)]))
  }
});
