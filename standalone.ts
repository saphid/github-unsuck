import { createServer } from "node:http";
import { handleRequest } from "./shared/app.ts";

const port = Number(process.env.PORT ?? 3918);
const origin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
  }
  try {
    const url = new URL(request.url ?? "/", origin ?? `http://${request.headers.host ?? `localhost:${port}`}`);
    const headers = new Headers();
    if (request.headers["sec-ch-prefers-color-scheme"]) headers.set("sec-ch-prefers-color-scheme", String(request.headers["sec-ch-prefers-color-scheme"]));
    const result = await handleRequest(url, headers, fetch, true);
    response.writeHead(result.status, result.headers);
    response.end(request.method === "HEAD" ? undefined : result.body);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain" }); response.end("Invalid request URL.");
  }
});
server.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`Theme Unfurl listening on http://${process.env.HOST ?? "127.0.0.1"}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close());
