import { capsule, endpoint, text } from "lakebed/server";
import { handleRequest } from "../shared/app.ts";

// Lakebed 0.0.41 matches endpoint paths exactly. Keep the v1 public interface in
// query parameters; wildcard GitHub paths are supported by standalone.ts.
function route(path: `/${string}`) {
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
    const result = await handleRequest(url, request.headers);
    return text(result.body, { status: result.status, headers: result.headers });
  });
}
export default capsule({
  name: "theme-unfurl",
  auth: { requireSignIn: false },
  endpoints: { home: route("/make"), unfurl: route("/u"), image: route("/image"), health: route("/api/health"), robots: route("/robots.txt") }
});
