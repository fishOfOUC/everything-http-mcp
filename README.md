# everything-http-mcp

把 **Everything（voidtools）自带的 HTTP 服务器** 变成 AI 可直接调用的文件搜索能力。零依赖 Everything SDK，不需要 `Everything64.dll`，也不需要 `es.exe`——只要你已经开启了 Everything 的 HTTP 服务。

> 本机默认地址：`http://127.0.0.1:80`（Everything 便携版，`http_server_port=80`）

## 为什么不用现成的 MCP

| 项目 | 依赖 | 与你的环境 |
| --- | --- | --- |
| [mcp-everything-search](https://github.com/mamertofabian/mcp-everything-search)（Python） | `Everything64.dll` + `EVERYTHING_SDK_PATH` | 本机没装 SDK，不可直接用 |
| [everything-search-mcp](https://github.com/kanishka-namdeo/everything-search-mcp)（npm） | 内置 `es.exe` 命令行 | 走 CLI 子进程，绕开 HTTP 服务 |
| [evryth-mcp](https://pypi.org/project/evryth-mcp/) 等 | SDK / CLI | 同上 |

这些项目全部基于 Everything SDK 或 `es.exe`，**没有一个走 HTTP 接口**。而 HTTP 接口恰好是零配置、跨语言、最适合 MCP 的一条路，所以这里单独实现。

## Everything HTTP 接口（官方）

文档：<https://www.voidtools.com/zh-cn/support/everything/http/>

```
http://localhost/?search=*.pdf&json=1&count=50&path_column=1&size_column=1&date_modified_column=1
```

| 参数 | 含义 |
| --- | --- |
| `search` / `s` | 搜索表达式 |
| `json` / `j` | 非 0 返回 JSON |
| `count` / `c` | 返回条数（JSON 模式默认 4294967295，务必显式传） |
| `offset` / `o` | 跳过条数，用于翻页 |
| `sort` | `name` / `path` / `size` / `date_modified` |
| `ascending` | 1 升序，0 降序 |
| `path` / `case` / `wholeword` / `regex` | 全路径匹配 / 区分大小写 / 全字 / 正则 |
| `path_column` 等 | 让 JSON 带上路径、大小、修改时间等字段 |

返回形如：

```json
{
  "totalResults": 12818,
  "results": [
    { "type": "file", "name": "a.pdf", "path": "D:\\docs", "size": "148000", "date_modified": "133908035387768450" }
  ]
}
```

注意两个坑，本项目已处理：

- `date_modified` / `date_created` 是 Windows **FILETIME**（1601 年起的 100ns 刻度），不是 Unix 时间戳。
- `count=0` 只返回 `totalResults`，适合做「有多少个」的统计而不传输结果。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `everything_search` | 搜索文件/目录，返回命中总数、完整路径、类型、大小、修改时间，支持分页与排序 |
| `everything_count` | 只返回命中数量（`count=0`，不传列表） |
| `everything_file_info` | 读取单个路径的实时元数据（fs stat），包括创建时间 |
| `everything_reveal` | 在资源管理器里选中并定位文件 |

`folder` 参数会转换为 Everything 的 `path:"..."` 过滤，搜索严格限制在目录内。

## 没启动怎么办：自动拉起

搜不到 HTTP 服务时，MCP 会判断是「Everything 没运行」还是「运行了但 HTTP 服务没开」，前者会直接启动它：

1. 解析 `Everything.exe`：`EVERYTHING_EXE` → 已运行进程的路径 → 开始菜单快捷方式 → App Paths 注册表 → 常见安装目录
2. 用 `Start-Process -Verb RunAs` **以管理员权限启动**（本机的 Everything 配置了 `run_as_admin=1`，普通权限起不来），Windows 会弹一次 UAC，点「是」即可
3. 每 700ms 探测一次：既要 HTTP 端口能应答，也要空查询能返回索引条目数（刚启动时 `Everything.db` 还在加载，只探测端口会搜出 0 条）
4. 索引就绪后自动重试刚才那次查询，对调用方无感

失败会冷却 60 秒，避免反复弹 UAC。想关掉自动启动就设 `EVERYTHING_AUTO_START=0`；机器上普通权限就能起 Everything 的话设 `EVERYTHING_AUTO_ELEVATE=0`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EVERYTHING_HTTP_URL` | `http://127.0.0.1:80` | 完整地址，优先于 host/port |
| `EVERYTHING_HTTP_PORT` | `80` | 端口 |
| `EVERYTHING_HTTP_USERNAME` / `EVERYTHING_HTTP_PASSWORD` | 空 | HTTP 服务器设了账号密码时填写 |
| `EVERYTHING_TIMEOUT_MS` | `20000` | 单次请求超时 |
| `EVERYTHING_AUTO_START` | `1` | 设 `0` 关闭「未启动时自动拉起」 |
| `EVERYTHING_AUTO_ELEVATE` | `1` | 设 `0` 改为普通权限启动（不需要 UAC 的机器） |
| `EVERYTHING_AUTO_START_TIMEOUT_MS` | `45000` | 启动后等端口就绪的最长时间 |
| `EVERYTHING_EXE` | 自动探测 | 指定 `Everything.exe` 完整路径 |
| `EVERYTHING_PROCESS_NAME` | `Everything.exe` | 进程名，用于判断是否已运行 |

## 接入客户端

先确认服务在线：浏览器打开 <http://127.0.0.1/> 能看到 Everything 页面。

**Claude Desktop**（`%APPDATA%\Claude\claude_desktop_config.json`）、Cursor（`~/.cursor/mcp.json`）、Cherry Studio 等使用 `mcpServers` 的客户端：

```json
{
  "mcpServers": {
    "everything": {
      "command": "node",
      "args": ["C:\\mcp\\everything-http\\src\\server.js"],
      "env": { "EVERYTHING_HTTP_URL": "http://127.0.0.1:80" }
    }
  }
}
```

**Claude Code**：

```bash
claude mcp add everything -- node "C:\mcp\everything-http\src\server.js"
```

**VS Code**（`.vscode/mcp.json`，键名是 `servers`）：

```json
{
  "servers": {
    "everything": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\mcp\\everything-http\\src\\server.js"]
    }
  }
}
```

## 查询语法速查

| 写法 | 含义 |
| --- | --- |
| `ext:pdf;docx` | 指定扩展名 |
| `dm:last7days` / `dm:thisweek` | 修改时间 |
| `size:>100mb` | 大小筛选 |
| `path:"D:\work" report` | 目录内搜索 |
| `!draft` | 排除 |
| `report AND (pdf OR docx)` | 布尔组合 |
| `^report.*\.docx$` + `regex=true` | 正则 |

## 测试

```bash
node test/smoke.mjs     # 4 个工具的真实调用
node test/offline.mjs   # 服务未启动、空查询等失败场景
```

## 安全提醒

当前 Everything 的 HTTP 服务器：

- 监听 `0.0.0.0:80`（局域网内其他机器可访问）
- 未设置用户名/密码
- `http_server_allow_file_download=1`（任何能访问该端口的人都能**下载**你索引到的文件）

建议在「工具 → 选项 → HTTP 服务器」里至少设置账号密码，并把绑定地址改为 `127.0.0.1`；不需要网页下载时取消「允许文件下载」。配置账号后，在本 MCP 的 `env` 里填 `EVERYTHING_HTTP_USERNAME` / `EVERYTHING_HTTP_PASSWORD`。
