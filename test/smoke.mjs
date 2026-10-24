/**
 * End-to-end smoke test: launches the MCP server over stdio and calls every tool.
 * Requires Everything's HTTP server to be running (default http://127.0.0.1:80).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const serverEntry = path.join(process.cwd(), "src", "server.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env },
  stderr: "inherit",
});

const client = new Client({ name: "everything-http-smoke", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
function check(label, condition, extra = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`[${status}] ${label}${extra ? ` — ${extra}` : ""}`);
}

function textOf(result) {
  return (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const { tools } = await client.listTools();
const toolNames = tools.map((tool) => tool.name).sort();
console.log("tools:", toolNames.join(", "));
check("4 tools registered", toolNames.length === 4, toolNames.join(","));

const search = await client.callTool({
  name: "everything_search",
  arguments: { query: "ext:pdf", limit: 3 },
});
const searchText = textOf(search);
console.log("\n--- everything_search ---\n" + searchText);
check("search returns hits", /命中 \d+ 条/.test(searchText) && !search.isError);
check("search lists full paths", /^\d+\. [A-Z]:\\/m.test(searchText));

const scoped = await client.callTool({
  name: "everything_search",
  arguments: { query: "ext:exe", folder: "C:\\Windows\\System32", limit: 2 },
});
const scopedText = textOf(scoped);
console.log("\n--- scoped search ---\n" + scopedText);
check(
  "folder filter stays inside folder",
  !scoped.isError && scopedText.split("\n").slice(1).every((line) => !/^\d+\. /.test(line) || /C:\\Windows\\System32/i.test(line)),
);

const recent = await client.callTool({
  name: "everything_search",
  arguments: { query: "dm:last7days", limit: 3, sort_by: "date_modified", descending: true },
});
const recentText = textOf(recent);
console.log("\n--- recent files ---\n" + recentText);
check("date sort works", /按修改时间降序/.test(recentText));

const count = await client.callTool({
  name: "everything_count",
  arguments: { query: "*.pdf" },
});
const countText = textOf(count);
console.log("\n--- everything_count ---\n" + countText);
check("count returns a number", /命中 \d+ 项/.test(countText));

const info = await client.callTool({
  name: "everything_file_info",
  arguments: { path: process.execPath },
});
const infoText = textOf(info);
console.log("\n--- everything_file_info ---\n" + infoText);
check("file_info on running node.exe", /类型: 文件/.test(infoText) && /大小:/.test(infoText));

const missing = await client.callTool({
  name: "everything_file_info",
  arguments: { path: "C:\\definitely\\not\\here\\nope.txt" },
});
console.log("\n--- missing file ---\n" + textOf(missing));
check("missing file reported", /路径不存在/.test(textOf(missing)));

await client.close();
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
