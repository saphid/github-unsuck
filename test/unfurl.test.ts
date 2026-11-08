import { test } from "node:test";
import assert from "node:assert/strict";
import { githubUrl, parseMetadata, imageUrl, loadMetadata } from "../shared/github.ts";
import { handleRequest, home } from "../shared/app.ts";

const sourceImage = "https://opengraph.githubassets.com/abc/owner/repo/pull/42";
const fixture = `<head><meta content='Fix &quot;dark&quot; &amp; light' property='og:title'><meta property="og:description" content="A &lt;script&gt; &amp; a fix"><meta property="og:image" content="${sourceImage}"></head>`;
const mockFetch = (async () => new Response(fixture, { headers: { "Content-Type": "text/html" } })) as typeof fetch;

test("accepts GitHub paths and preserves nested URL queries and fragments", () => {
  assert.equal(githubUrl("owner/repo/pull/42").href, "https://github.com/owner/repo/pull/42");
  assert.equal(githubUrl("github.com/owner/repo").href, "https://github.com/owner/repo");
  assert.equal(githubUrl("https://github.com/owner/repo?tab=readme#install").search, "?tab=readme");
  for (const value of ["https://github.com.evil.test/repo", "https://github.com@evil.test/a", "https://user:pass@github.com/repo", "http://github.com/owner/repo", "https://github.com:444/a", "https://localhost/a", "https://github.com/"]) {
    assert.throws(() => githubUrl(value));
  }
});

test("parses reversed attributes and entities; rejects unexpected image hosts", () => {
  assert.equal(parseMetadata(fixture).title, 'Fix "dark" & light');
  assert.equal(parseMetadata(fixture).description, "A <script> & a fix");
  assert.throws(() => parseMetadata(fixture.replace(sourceImage, "https://127.0.0.1/private")));
  assert.throws(() => parseMetadata(fixture.replace(sourceImage, "https://opengraph.githubassets.com:444/a")));
  assert.throws(() => parseMetadata("<head></head>"));
});

test("dark images use a real PNG proxy; light keeps GitHub's image", () => {
  const metadata = parseMetadata(fixture);
  const dark = new URL(imageUrl(metadata, "dark"));
  assert.equal(dark.hostname, "wsrv.nl");
  assert.equal(dark.searchParams.get("url"), sourceImage);
  assert.equal(dark.searchParams.get("output"), "png");
  assert.equal(dark.searchParams.get("filt"), "duotone");
  assert.equal(imageUrl(metadata, "light"), sourceImage);
});

test("serves crawler metadata with escaped values and redirects human clicks via JS", async () => {
  const url = new URL("https://github.unsuck.dev/u");
  url.searchParams.set("url", "https://github.com/owner/repo/pull/42?expand=1#discussion_r2");
  const result = await handleRequest(url, new Headers(), mockFetch);
  assert.equal(result.status, 200);
  assert.match(result.body, /property="og:image" content="https:\/\/wsrv.nl\//);
  assert.match(result.body, /property="og:title" content="Fix &quot;dark&quot; &amp; light"/);
  assert.match(result.body, /twitter:card" content="summary_large_image"/);
  assert.match(result.body, /location.replace\(target.href\)/);
  assert.match(result.body, /href="https:\/\/github.com\/owner\/repo\/pull\/42\?expand=1#discussion_r2"/);
  assert.doesNotMatch(result.body, /A <script>/);
  assert.ok(result.headers["Content-Security-Policy"].includes("base-uri 'none'"));
});

test("preview mode stays on page; theme auto varies correctly and uses light hint", async () => {
  const url = new URL("https://wrapper.test/u?url=owner/repo&theme=auto&preview=1");
  const result = await handleRequest(url, new Headers({ "Sec-CH-Prefers-Color-Scheme": '"light"' }), mockFetch);
  assert.equal(result.status, 200);
  assert.equal(result.headers.Vary, "Sec-CH-Prefers-Color-Scheme");
  assert.match(result.body, /og:image" content="https:\/\/opengraph.githubassets.com\//);
  assert.match(result.body, /<picture>/);
  assert.doesNotMatch(result.body, /location.replace/);
  assert.doesNotMatch(result.body.match(/property="og:url"[^>]+/)![0], /preview/);
  const fallback = await handleRequest(new URL("https://wrapper.test/u?url=owner/repo&theme=auto"), new Headers(), mockFetch);
  assert.match(fallback.body, /og:image" content="https:\/\/wsrv.nl\//);
});

test("query and future path URLs share behavior; original query survives", async () => {
  let requested = "";
  const fetcher = (async (url: URL) => { requested = url.href; return mockFetch(url); }) as typeof fetch;
  const result = await handleRequest(new URL("https://github.unsuck.dev/owner/repo/pull/42?theme=light&diff=split"), new Headers(), fetcher, true);
  assert.equal(result.status, 200);
  assert.equal(requested, "https://github.com/owner/repo/pull/42?diff=split");
  assert.match(result.body, /og:image" content="https:\/\/opengraph.githubassets.com\//);
});

test("rejects malformed input before fetching and does not cache failures", async () => {
  let called = false;
  const fetcher = (async () => { called = true; throw Error(); }) as typeof fetch;
  for (const suffix of ["?url=https://evil.test/repo", "?url=owner/repo&theme=oops", ""]) {
    const result = await handleRequest(new URL("https://wrapper.test/u" + suffix), new Headers(), fetcher);
    assert.equal(result.status, 400);
    assert.equal(result.headers["Cache-Control"], "no-store");
  }
  assert.equal(called, false);
});

test("never follows an upstream redirect outside GitHub", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://localhost/admin" } }); }) as typeof fetch;
  await assert.rejects(loadMetadata(githubUrl("owner/repo"), fetcher));
  assert.equal(calls, 1);
});

test("handles upstream failures, redirects, and excessive response sizes", async () => {
  for (const [status, expected] of [[404, 404], [429, 503], [500, 502]]) {
    const fetcher = (async () => new Response("unavailable", { status })) as typeof fetch;
    const result = await handleRequest(new URL("https://wrapper.test/u?url=owner/repo"), new Headers(), fetcher);
    assert.equal(result.status, expected);
    assert.equal(result.headers["Cache-Control"], "no-store");
  }
  const large = (async () => new Response("x".repeat(1024 * 1024 + 1), { headers: { "Content-Type": "text/html" } })) as typeof fetch;
  await assert.rejects(loadMetadata(githubUrl("owner/repo"), large), /too large/);
  let calls = 0;
  const renamed = (async () => ++calls === 1 ? new Response(null, { status: 301, headers: { location: "/new/repo" } }) : mockFetch("https://github.com/new/repo")) as typeof fetch;
  assert.equal((await loadMetadata(githubUrl("old/repo"), renamed)).image, sourceImage);
  assert.equal(calls, 2);
});

test("image endpoint redirects to a PNG; health and builder need no upstream calls", async () => {
  const result = await handleRequest(new URL("https://wrapper.test/image?url=owner/repo"), new Headers(), mockFetch);
  assert.equal(result.status, 302);
  assert.equal(new URL(result.headers.Location).searchParams.get("output"), "png");
  assert.equal((await handleRequest(new URL("https://wrapper.test/api/health"))).body, '{"ok":true}');
  assert.match(home().body, /form id="builder" action="\/u"/);
  // Parse the generated inline JS; escaping bugs here break the entire builder.
  const script = home().body.match(/<script>([\s\S]+?)<\/script>/)![1];
  assert.doesNotThrow(() => new Function(script));
});

test("supports hosted Lakebed buffered fetch responses without body streams", async () => {
  const buffered = (async () => ({
    status: 200, ok: true,
    headers: new Headers({ "Content-Type": "text/html" }),
    text: async () => fixture
  })) as unknown as typeof fetch;
  const result = await handleRequest(new URL("https://wrapper.test/u?url=owner/repo"), new Headers(), buffered);
  assert.equal(result.status, 200);
  assert.match(result.body, /property="og:title" content="Fix &quot;dark&quot; &amp; light"/);
  const tooLarge = (async () => ({
    status: 200, ok: true,
    headers: new Headers({ "Content-Type": "text/html" }),
    text: async () => "x".repeat(1024 * 1024 + 1)
  })) as unknown as typeof fetch;
  await assert.rejects(loadMetadata(githubUrl("owner/repo"), tooLarge), /too large/);
});
