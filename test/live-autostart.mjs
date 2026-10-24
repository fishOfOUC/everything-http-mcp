/**
 * Live check: wait for Everything to be closed, then run a search and let the
 * client auto-start it (UAC prompt). Run with: node test/live-autostart.mjs
 */
import { EverythingClient } from "../src/everything.js";

const BASE = "http://127.0.0.1:80";

async function probe() {
  try {
    const response = await fetch(`${BASE}/?search=&json=1&count=0`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return { up: false, total: 0 };
    const data = await response.json();
    return { up: true, total: Number(data?.totalResults ?? 0) };
  } catch {
    return { up: false, total: 0 };
  }
}

async function main() {
  const client = new EverythingClient({ url: BASE });
  const waitStart = Date.now();
  const WAIT_LIMIT = 120_000;

  console.log("等待 Everything 退出（最多 120 秒）...");
  let closed = false;
  while (Date.now() - waitStart < WAIT_LIMIT) {
    if (!(await probe()).up) {
      closed = true;
      console.log(`检测到 80 端口已关闭（等待 ${Math.round((Date.now() - waitStart) / 1000)}s）`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!closed) {
    console.log("TIMEOUT: Everything 还在运行，未触发自动启动测试。");
    process.exitCode = 2;
    return;
  }

  console.log("发起搜索，应触发 UAC 提权启动 ... 请在弹窗点「是」");
  const startedAt = Date.now();
  try {
    const result = await client.search({ search: "*.pdf", count: 3 });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\nAUTO-START OK：${seconds}s 后搜索成功，命中 ${result.total} 条`);
    for (const item of result.results) console.log(" -", item.fullPath);
    process.exitCode = result.total > 0 ? 0 : 3;
    if (result.total === 0) console.log("注意：HTTP 通了但索引还没加载完（预期不应再出现）。");
  } catch (error) {
    console.log(`\nAUTO-START FAILED：${error.code ?? ""} ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
