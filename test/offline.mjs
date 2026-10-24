/**
 * Failure-mode checks: nothing running, HTTP server off, invalid input.
 * Run with: node test/offline.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const serverEntry = path.join(process.cwd(), "src", "server.js");

let failures = 0;
function check(label, condition, detail = "") {
  if (!condition) failures += 1;
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
}

const textOf = (result) =>
  (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

async function withClient(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, ...env },
    stderr: "inherit",
  });
  const client = new Client({ name: "everything-offline", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// 1. Everything is running, but the configured port has no HTTP server.
await withClient({ EVERYTHING_HTTP_PORT: "59999" }, async (client) => {
  const down = await client.callTool({ name: "everything_search", arguments: { query: "*.pdf" } });
  const text = textOf(down);
  console.log("\n--- HTTP server off (port 59999) ---\n" + text);
  check("isError when HTTP server is off", down.isError === true);
  check("points at HTTP server settings", /HTTP 服务器/.test(text));
  check("carries HTTP_UNREACHABLE", /HTTP_UNREACHABLE/.test(text));
});

// 2. No Everything process at all (simulated via process name), auto-start disabled.
await withClient(
  { EVERYTHING_HTTP_PORT: "59999", EVERYTHING_PROCESS_NAME: "NoSuchEverything.exe", EVERYTHING_AUTO_START: "0" },
  async (client) => {
    const missing = await client.callTool({ name: "everything_count", arguments: { query: "*.pdf" } });
    const text = textOf(missing);
    console.log("\n--- Everything not running (auto-start off) ---\n" + text);
    check("detects that Everything is not running", /没有运行/.test(text));
    check("carries EVERYTHING_NOT_RUNNING", /EVERYTHING_NOT_RUNNING/.test(text));
    check("does not retry / launch", !/UAC/.test(text));
  },
);

// 3. Invalid input is rejected before reaching Everything.
await withClient({}, async (client) => {
  let rejected = false;
  try {
    const bad = await client.callTool({ name: "everything_search", arguments: { query: "" } });
    rejected = bad.isError === true;
  } catch {
    rejected = true;
  }
  check("empty query rejected", rejected);
});

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
