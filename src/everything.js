/**
 * Minimal client for the built-in Everything HTTP server (voidtools).
 *
 * Everything ships a web server that can answer searches as JSON:
 *   http://127.0.0.1/?search=*.pdf&json=1&count=20&path_column=1
 *
 * This client only speaks that HTTP interface, so it needs neither
 * Everything64.dll nor es.exe — just the HTTP server switched on.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureEverythingStarted } from "./launcher.js";

const execFileAsync = promisify(execFile);

const FILETIME_UNIX_EPOCH_MS = 11644473600000n;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Everything reports timestamps as Windows FILETIME (100ns ticks since 1601). */
export function filetimeToDate(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    const ticks = BigInt(String(value).trim());
    if (ticks <= 0n) return null;
    const ms = ticks / 10000n - FILETIME_UNIX_EPOCH_MS;
    const date = new Date(Number(ms));
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

export function formatLocal(date) {
  if (!date) return null;
  // sv-SE yields "YYYY-MM-DD HH:mm:ss" in the machine's local time zone.
  return date.toLocaleString("sv-SE", { hour12: false });
}

export function formatSize(bytes) {
  if (bytes === undefined || bytes === null || bytes === "") return null;
  const n = Number(bytes);
  if (!Number.isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export class EverythingError extends Error {
  constructor(message, { code = "EVERYTHING_ERROR", detail = "" } = {}) {
    super(message);
    this.name = "EverythingError";
    this.code = code;
    this.detail = detail;
  }
}

const SORTS = new Set(["name", "path", "size", "date_modified", "date_created"]);

export class EverythingClient {
  constructor({
    url = process.env.EVERYTHING_HTTP_URL,
    host = process.env.EVERYTHING_HOST || "127.0.0.1",
    port = process.env.EVERYTHING_HTTP_PORT || "80",
    username = process.env.EVERYTHING_HTTP_USERNAME || "",
    password = process.env.EVERYTHING_HTTP_PASSWORD || "",
    timeoutMs = Number(process.env.EVERYTHING_TIMEOUT_MS || 20000),
    processName = process.env.EVERYTHING_PROCESS_NAME || "Everything.exe",
    autoStart = process.env.EVERYTHING_AUTO_START !== "0",
  } = {}) {
    const base = url || `http://${host}:${port}`;
    let parsed;
    try {
      parsed = new URL(/^https?:\/\//i.test(base) ? base : `http://${base}`);
    } catch {
      throw new EverythingError(`无法解析 Everything HTTP 地址: ${base}`, {
        code: "BAD_CONFIG",
      });
    }
    this.baseUrl = parsed.origin;
    this.host = parsed.hostname;
    this.port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    this.processName = processName;
    this.autoStart = autoStart;
    this.username = username;
    this.password = password;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;
  }

  /**
   * Best-effort check whether Everything is running locally, so a connection
   * failure can say "start Everything" instead of "enable the HTTP server".
   * Returns null when it cannot be determined (non-Windows, remote host, error).
   */
  async #isEverythingRunning() {
    if (process.platform !== "win32" || !LOCAL_HOSTS.has(this.host)) return null;
    try {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", `IMAGENAME eq ${this.processName}`, "/NH"],
        { timeout: 3000, windowsHide: true },
      );
      const escaped = this.processName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(escaped, "i").test(stdout);
    } catch {
      return null;
    }
  }

  get address() {
    return this.baseUrl;
  }

  authHeader() {
    if (!this.username && !this.password) return {};
    const token = Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  async #request(params, { retried = false } = {}) {
    const url = new URL("/", this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", ...this.authHeader() },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const cause = error?.cause;
      const nested = Array.isArray(cause?.errors) ? cause.errors : [];
      const reason = [
        error?.code,
        error?.name,
        cause?.code,
        cause?.message,
        ...nested.flatMap((item) => [item?.code, item?.message]),
      ]
        .filter(Boolean)
        .join(" ");

      if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EADDRNOTAVAIL|bad port|UND_ERR_CONNECT/i.test(reason)) {
        const running = await this.#isEverythingRunning();

        if (running === false && this.autoStart && !retried) {
          const outcome = await ensureEverythingStarted({ baseUrl: this.baseUrl });
          if (outcome.started) {
            return this.#request(params, { retried: true });
          }
          throw new EverythingError(
            `Everything 没有运行，自动启动失败：${outcome.reason}\n` +
              "也可以手动以管理员身份运行 Everything.exe，再确认「工具 → 选项 → HTTP 服务器」已启用。",
            { code: "AUTO_START_FAILED", detail: String(reason) },
          );
        }

        if (running === false) {
          throw new EverythingError(
            `Everything 没有运行（进程 ${this.processName} 不在列表里）。` +
              "请以管理员身份启动 Everything；自动启动已被 EVERYTHING_AUTO_START=0 关闭。",
            { code: "EVERYTHING_NOT_RUNNING", detail: String(reason) },
          );
        }

        if (running === true) {
          throw new EverythingError(
            `Everything 正在运行，但 ${this.baseUrl} 连不上——HTTP 服务器没启用或端口不一致。` +
              `请在「工具 → 选项 → HTTP 服务器」勾选「启用 HTTP 服务器」，把端口设为 ${this.port}（或同步设置 EVERYTHING_HTTP_PORT）。`,
            { code: "HTTP_UNREACHABLE", detail: String(reason) },
          );
        }

        throw new EverythingError(
          `连不上 Everything HTTP 服务器 (${this.baseUrl})。请确认 Everything 已启动，` +
            `并在「工具 → 选项 → HTTP 服务器」中启用 HTTP 服务器、端口设为 ${this.port}。`,
          { code: "HTTP_UNREACHABLE", detail: String(reason) },
        );
      }
      if (/TimeoutError|ABORT/i.test(String(reason))) {
        throw new EverythingError(
          `Everything HTTP 服务器 ${this.timeoutMs}ms 内没有响应，搜索可能太宽泛。`,
          { code: "HTTP_TIMEOUT", detail: String(reason) },
        );
      }
      throw new EverythingError(`请求 Everything HTTP 服务器失败: ${error.message}`, {
        code: "HTTP_ERROR",
        detail: String(reason),
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new EverythingError(
        "Everything HTTP 服务器要求用户名/密码。请设置 EVERYTHING_HTTP_USERNAME 和 EVERYTHING_HTTP_PASSWORD 环境变量。",
        { code: "HTTP_AUTH", detail: `status ${response.status}` },
      );
    }
    if (!response.ok) {
      throw new EverythingError(`Everything HTTP 服务器返回 HTTP ${response.status}。`, {
        code: "HTTP_STATUS",
        detail: await response.text().catch(() => ""),
      });
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new EverythingError(
        "Everything 返回的不是 JSON。请确认地址指向 Everything 的 HTTP 服务器，而不是别的网页服务。",
        { code: "HTTP_BAD_RESPONSE", detail: text.slice(0, 300) },
      );
    }
  }

  /**
   * Run a search against the Everything index.
   * Returns { total, results: [{ name, path, fullPath, type, size, modified, created }] }.
   */
  async search({
    search,
    count = 50,
    offset = 0,
    sort = "name",
    ascending = true,
    matchPath = false,
    matchCase = false,
    wholeWord = false,
    regex = false,
  } = {}) {
    const query = String(search ?? "").trim();
    if (!query) {
      throw new EverythingError("搜索关键词不能为空。", { code: "EMPTY_QUERY" });
    }
    if (!SORTS.has(sort)) {
      throw new EverythingError(`不支持的排序方式: ${sort}`, { code: "BAD_SORT" });
    }

    const payload = await this.#request({
      search: query,
      json: 1,
      count: Math.max(0, Math.trunc(count)),
      offset: Math.max(0, Math.trunc(offset)),
      sort,
      ascending: ascending ? 1 : 0,
      path: matchPath ? 1 : 0,
      case: matchCase ? 1 : 0,
      wholeword: wholeWord ? 1 : 0,
      regex: regex ? 1 : 0,
      path_column: 1,
      size_column: 1,
      date_modified_column: 1,
      date_created_column: 1,
    });

    const raw = Array.isArray(payload?.results) ? payload.results : [];
    const results = raw.map((item) => {
      const name = item?.name ?? "";
      const path = item?.path ?? "";
      const type = item?.type === "folder" ? "folder" : "file";
      return {
        name,
        path,
        fullPath: path ? `${path}\\${name}` : name,
        type,
        size: item?.size === "" || item?.size === undefined ? null : Number(item.size),
        sizeText: formatSize(item?.size),
        modified: formatLocal(filetimeToDate(item?.date_modified)),
        created: formatLocal(filetimeToDate(item?.date_created)),
      };
    });

    return {
      total: Number(payload?.totalResults ?? results.length),
      offset: Math.max(0, Math.trunc(offset)),
      results,
    };
  }

  /** How many items match — transfers no result rows (count=0). */
  async count(search) {
    const query = String(search ?? "").trim();
    if (!query) {
      throw new EverythingError("搜索关键词不能为空。", { code: "EMPTY_QUERY" });
    }
    const payload = await this.#request({ search: query, json: 1, count: 0 });
    return Number(payload?.totalResults ?? 0);
  }
}

/** Quote a folder for use inside Everything's `path:` search function. */
export function pathFilter(folder) {
  if (!folder) return "";
  const cleaned = String(folder).trim().replace(/[\\/]+$/, "");
  if (!cleaned) return "";
  if (cleaned.includes('"')) {
    throw new EverythingError("目录路径里不能包含英文双引号。", { code: "BAD_FOLDER" });
  }
  return `path:"${cleaned}"`;
}
