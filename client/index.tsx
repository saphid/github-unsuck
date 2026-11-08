import { useEffect } from "preact/hooks";
// Lakebed reserves `/` for its app shell. Keep all crawler-facing metadata in
// the /u endpoint and the no-JavaScript share builder at /make.
export function App() {
  useEffect(() => { window.location.replace("/make"); }, []);
  return <main style={{ padding: "3rem", fontFamily: "system-ui" }}><h1>GitHub, minus the flashbang.</h1><a href="/make">Make a themed GitHub link</a></main>;
}
