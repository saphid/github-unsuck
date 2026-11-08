import { useEffect } from "preact/hooks";
import { githubPathTarget } from "../shared/github.ts";
// Lakebed falls back to its client shell for unregistered HTML paths. Visitors
// to GitHub paths should continue to GitHub, not the link builder.
export function App() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const target = url.pathname === "/" || url.pathname === "/index.html"
      ? "/make" : githubPathTarget(url).href;
    window.location.replace(target);
  }, []);
  return <main style={{ padding: "3rem", fontFamily: "system-ui" }}><h1>Links, minus the flashbang.</h1><a href="/make">Make a themed link</a></main>;
}
