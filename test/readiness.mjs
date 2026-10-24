/**
 * Readiness semantics: "port open" alone is not enough — after launch the
 * index reports 0 for a few seconds. probeIndex must tell these apart.
 * Run with: node test/readiness.mjs
 */
import http from "node:http";
import { ensureEverythingStarted } from "../src/launcher.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
};

function serve(totalResults) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ totalResults, results: [] }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const loading = await serve(0);
const loadingUrl = `http://127.0.0.1:${loading.port}`;
const loadingState = await ensureEverythingStarted({ baseUrl: loadingUrl, timeoutMs: 1500 });
console.log("while index loads:", JSON.stringify(loadingState));
check("detects HTTP up", loadingState.started === true);
check("knows index is still empty", loadingState.indexReady === false);

const ready = await serve(12345);
const readyUrl = `http://127.0.0.1:${ready.port}`;
const readyState = await ensureEverythingStarted({ baseUrl: readyUrl });
console.log("index ready:", JSON.stringify(readyState));
check("reports index ready", readyState.indexReady === true);

loading.server.close();
ready.server.close();

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
