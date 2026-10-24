/**
 * Start Everything on demand when its HTTP server is unreachable.
 *
 * On this machine Everything always needs elevation, so the default launch is
 * `Start-Process -Verb RunAs` (one UAC prompt). Set EVERYTHING_AUTO_ELEVATE=0
 * on a machine where a plain launch is enough.
 *
 * Resolution order: EVERYTHING_EXE → running process path → Start Menu
 * shortcut → App Paths registry → well-known install dirs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const KNOWN_PATHS = [
  "C:\\Program Files\\Everything\\Everything.exe",
  "C:\\Program Files (x86)\\Everything\\Everything.exe",
];

/** Don't spam UAC: after a failed launch, stay quiet for this long. */
const FAILURE_COOLDOWN_MS = 60000;
let lastFailureAt = 0;

const RESOLVE_SCRIPT = String.raw`
$found = New-Object System.Collections.Generic.List[string]
Get-Process -Name Everything -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Path) { $found.Add($_.Path) }
}
$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Everything.lnk",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Everything.lnk"
)) {
  if (Test-Path $lnk) {
    $target = $shell.CreateShortcut($lnk).TargetPath
    if ($target) { $found.Add($target) }
  }
}
foreach ($key in @(
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Everything.exe",
  "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Everything.exe"
)) {
  if (Test-Path $key) {
    $value = (Get-ItemProperty $key)."(default)"
    if ($value) { $found.Add($value) }
  }
}
$found | Select-Object -Unique
`;

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Return the first existing Everything.exe path, or null. */
export async function resolveEverythingExe(explicitPath = process.env.EVERYTHING_EXE) {
  if (process.platform !== "win32") return null;

  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", RESOLVE_SCRIPT],
      { timeout: 8000, windowsHide: true },
    );
    candidates.push(
      ...stdout
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^"|"$/g, ""))
        .filter(Boolean),
    );
  } catch {
    // Resolution via PowerShell failed; fall through to static paths.
  }

  candidates.push(...KNOWN_PATHS);

  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith("everything.exe") && (await exists(candidate))) {
      return path.win32.normalize(candidate);
    }
  }
  return null;
}

function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Launch Everything; elevated by default because it refuses a normal launch here. */
async function startProcess(exe, { elevate }) {
  const inner = elevate
    ? `Start-Process -FilePath ${quotePs(exe)} -Verb RunAs`
    : `Start-Process -FilePath ${quotePs(exe)}`;
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", inner],
    { timeout: 60000, windowsHide: true },
  );
}

/**
 * Reachability + index size. Everything answers with totalResults 0 for a
 * moment after launch while it loads Everything.db, so "port open" is not
 * enough — wait until the index actually reports entries.
 */
async function probeIndex(baseUrl, timeoutMs = 1500) {
  const url = new URL("/", baseUrl);
  url.searchParams.set("search", "");
  url.searchParams.set("json", "1");
  url.searchParams.set("count", "0");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { up: false, total: 0 };
    const data = await response.json();
    return { up: true, total: Number(data?.totalResults ?? 0) || 0 };
  } catch {
    return { up: false, total: 0 };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One shared start attempt even if several tool calls fail at once. */
let inflight = null;

/**
 * Ensure the Everything HTTP server answers, launching Everything if needed.
 * Returns { started: true, exe, elevated } or { started: false, exe, reason }.
 */
export async function ensureEverythingStarted({
  baseUrl,
  timeoutMs = Number(process.env.EVERYTHING_AUTO_START_TIMEOUT_MS || 45000),
  elevate = process.env.EVERYTHING_AUTO_ELEVATE !== "0",
} = {}) {
  if (process.platform !== "win32") {
    return { started: false, exe: null, reason: "非 Windows 平台，无法自动启动 Everything。" };
  }

  const status = await probeIndex(baseUrl, 1500);
  if (status.up) {
    if (status.total > 0) {
      return { started: true, exe: null, alreadyRunning: true, elevated: false, indexReady: true };
    }
    // Server is up but the index is still loading: give it a short grace period
    // so the retried query does not come back empty.
    const graceDeadline = Date.now() + Math.min(10000, timeoutMs);
    while (Date.now() < graceDeadline) {
      await sleep(700);
      const retry = await probeIndex(baseUrl, 1200);
      if (retry.total > 0) {
        return { started: true, exe: null, alreadyRunning: true, elevated: false, indexReady: true };
      }
    }
    return {
      started: true,
      exe: null,
      alreadyRunning: true,
      elevated: false,
      indexReady: false,
      warning: "HTTP 服务器已就绪，但索引仍为空。稍等几秒再搜一次。",
    };
  }

  if (inflight) return inflight;

  if (Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
    const seconds = Math.ceil((FAILURE_COOLDOWN_MS - (Date.now() - lastFailureAt)) / 1000);
    return {
      started: false,
      exe: null,
      reason: `上一次自动启动失败，${seconds} 秒内不再重试（避免反复弹 UAC）。`,
    };
  }

  inflight = (async () => {
    const exe = await resolveEverythingExe();
    if (!exe) {
      lastFailureAt = Date.now();
      return {
        started: false,
        exe: null,
        reason:
          "找不到 Everything.exe。设置环境变量 EVERYTHING_EXE 指向它的完整路径，或手动以管理员身份启动。",
      };
    }

    try {
      await startProcess(exe, { elevate });
    } catch (error) {
      lastFailureAt = Date.now();
      const detail = String(error?.stderr || error?.message || error).split(/\r?\n/)[0];
      return {
        started: false,
        exe,
        elevated: elevate,
        reason:
          `提权启动被拒绝或失败：${detail}。` +
          "请在弹出的 UAC 对话框中点「是」；如果没看到弹窗，说明 UAC 被系统策略拦截。",
      };
    }

    const deadline = Date.now() + timeoutMs;
    let sawHttp = false;
    while (Date.now() < deadline) {
      const probe = await probeIndex(baseUrl, 1200);
      if (probe.up) sawHttp = true;
      if (probe.up && probe.total > 0) {
        return { started: true, exe, elevated: elevate, indexReady: true };
      }
      await sleep(700);
    }

    if (sawHttp) {
      return {
        started: true,
        exe,
        elevated: elevate,
        indexReady: false,
        warning: "HTTP 服务器已就绪，但索引仍为空（可能还在加载）。稍等几秒再搜一次。",
      };
    }

    lastFailureAt = Date.now();
    return {
      started: false,
      exe,
      elevated: elevate,
      reason:
        `已通过 UAC 启动 ${exe}，但 ${timeoutMs}ms 内 HTTP 服务器仍无响应。` +
        `请确认「工具 → 选项 → HTTP 服务器」已启用，且端口是 ${new URL(baseUrl).port || 80}。`,
    };
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
