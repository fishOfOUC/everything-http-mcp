#!/usr/bin/env node
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  EverythingClient,
  EverythingError,
  formatLocal,
  formatSize,
  pathFilter,
} from "./everything.js";

const VERSION = "0.1.0";

const client = new EverythingClient();

const server = new McpServer(
  { name: "everything-http", version: VERSION },
  {
    instructions:
      "通过 Everything 的 HTTP 接口检索本机文件索引。适合「找文件」「按扩展名/时间/大小筛选」「统计某类文件数量」。Everything 查询语法可用：ext:pdf、dm:last7days、size:>100mb、path:\"C:\\\\dir\"、!排除、AND/OR/NOT、regex。若 Everything 未运行，会自动以管理员权限启动它（Windows 会弹一次 UAC 确认）。",
  },
);

const SORT_VALUES = ["name", "path", "size", "date_modified", "date_created"];

const commonShape = {
  query: z
    .string()
    .min(1)
    .describe('Everything 搜索表达式，例如 "ext:pdf 报告"、"size:>1gb ext:iso"、"dm:last7days ext:docx"'),
  folder: z
    .string()
    .optional()
    .describe('只在这个目录下搜索（会转成 path:"..." 过滤），例如 "D:\\\\work"'),
};

function buildQuery({ query, folder }) {
  const filter = pathFilter(folder);
  return filter ? `${filter} ${query.trim()}` : query.trim();
}

function failure(error) {
  const message =
    error instanceof EverythingError
      ? error.message
      : `调用 Everything 失败: ${error?.message ?? String(error)}`;
  const code = error instanceof EverythingError ? error.code : "UNEXPECTED";
  return {
    isError: true,
    content: [{ type: "text", text: `${message}\n(error code: ${code})` }],
  };
}

function describeSort(sort, descending) {
  const labels = {
    name: "名称",
    path: "路径",
    size: "大小",
    date_modified: "修改时间",
    date_created: "创建时间",
  };
  return `${labels[sort] ?? sort}${descending ? "降序" : "升序"}`;
}

server.registerTool(
  "everything_search",
  {
    title: "Everything 文件搜索",
    description:
      "用 Everything 索引做全盘文件/文件夹搜索，返回匹配总数和结果列表（名称、完整路径、类型、大小、修改时间）。只支持 Everything 查询语法，不是自然语言。",
    inputSchema: {
      ...commonShape,
      limit: z.number().int().min(1).max(1000).default(50).describe("返回条数，默认 50，最大 1000"),
      offset: z.number().int().min(0).default(0).describe("跳过前 N 条，用于翻页"),
      sort_by: z.enum(SORT_VALUES).default("name").describe("排序字段"),
      descending: z.boolean().default(false).describe("true 为降序，例如按修改时间最新在前"),
      match_path: z.boolean().default(false).describe("让关键词匹配完整路径，而不只是文件名"),
      match_case: z.boolean().default(false).describe("区分大小写"),
      whole_word: z.boolean().default(false).describe("只匹配完整单词"),
      regex: z.boolean().default(false).describe("把 query 当作正则表达式"),
    },
  },
  async (args) => {
    try {
      const search = buildQuery(args);
      const { total, results, offset } = await client.search({
        search,
        count: args.limit,
        offset: args.offset,
        sort: args.sort_by,
        ascending: !args.descending,
        matchPath: args.match_path,
        matchCase: args.match_case,
        wholeWord: args.whole_word,
        regex: args.regex,
      });

      const lines = [
        `命中 ${total} 条 | 查询: \`${search}\` | 返回 ${results.length} 条` +
          (results.length > 0 ? `（第 ${offset + 1}-${offset + results.length} 条）` : "") +
          ` | 按${describeSort(args.sort_by, args.descending)}`,
      ];

      results.forEach((item, index) => {
        const meta = [item.type === "folder" ? "目录" : "文件", item.sizeText, item.modified ? `修改 ${item.modified}` : null]
          .filter(Boolean)
          .join(" · ");
        lines.push(`${offset + index + 1}. ${item.fullPath}  [${meta}]`);
      });

      if (total === 0) {
        lines.push("没有匹配项。可以放宽条件：去掉 path 过滤、换 ext:、或用更短的关键词。");
      } else if (offset + results.length < total) {
        lines.push(`还有 ${total - offset - results.length} 条未显示：加大 limit 或传 offset=${offset + results.length}。`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "everything_count",
  {
    title: "Everything 结果计数",
    description:
      "只返回匹配数量，不传输文件列表。适合「我电脑上有多少个 PDF」「这个目录里有多少张图」这类问题。",
    inputSchema: { ...commonShape },
  },
  async (args) => {
    try {
      const search = buildQuery(args);
      const total = await client.count(search);
      return { content: [{ type: "text", text: `查询 \`${search}\` 命中 ${total} 项。` }] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "everything_file_info",
  {
    title: "文件/目录详情",
    description:
      "读取某个路径的实时元数据（大小、创建/修改/访问时间、是否目录）。不经过 Everything 索引，路径不存在也会明确返回。",
    inputSchema: {
      path: z.string().min(1).describe("完整路径，例如 D:\\\\work\\\\report.docx"),
    },
  },
  async ({ path }) => {
    try {
      const info = await stat(path);
      const type = info.isDirectory() ? "目录" : "文件";
      const lines = [
        `路径: ${path}`,
        `类型: ${type}`,
        info.isDirectory() ? null : `大小: ${formatSize(info.size)} (${info.size} 字节)`,
        `创建: ${formatLocal(info.birthtime)}`,
        `修改: ${formatLocal(info.mtime)}`,
        `访问: ${formatLocal(info.atime)}`,
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { content: [{ type: "text", text: `路径不存在: ${path}` }] };
      }
      return failure(error);
    }
  },
);

server.registerTool(
  "everything_reveal",
  {
    title: "在资源管理器中定位",
    description: "在 Windows 资源管理器里选中并定位一个文件/目录，方便用户直接查看或双击打开。",
    inputSchema: {
      path: z.string().min(1).describe("要定位的完整路径"),
    },
  },
  async ({ path }) => {
    try {
      await stat(path);
    } catch {
      return { content: [{ type: "text", text: `路径不存在，未打开: ${path}` }], isError: true };
    }
    spawn("explorer.exe", [`/select,${path}`], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return { content: [{ type: "text", text: `已在资源管理器中定位: ${path}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
