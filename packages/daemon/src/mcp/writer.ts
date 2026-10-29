// MCP 登记的写入（239 号票）：用户在"登记变更"卡上点确认之后，只有运行时从这里写配置区的 mcp.json。
// 规矩（照记忆推理库/备份留旧版本、项目档案历史区的写法）：
// - 按 name 合并：只动这一条，别的一条不碰（键按名字排好，写出来的文件稳定，备份之间好比对）；
// - 写前把旧的那一份复制进 config/.history/（mcp-<时间>.json，只留最近几份）；
// - 原子写：先写同目录的临时文件，再 rename 顶上去，写一半被杀也不会留下半份登记；
// - 现在的文件写坏了（不是 JSON、条目不合 schema）不动它：合并的前提是读得懂，硬写会把用户的登记冲掉。
// 读回来的仍是 registration.ts 的 readMcpRegistrations（每次用到时现读）。
import fs from "node:fs";
import path from "node:path";
import { RequestRejected } from "../errors.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { readMcpRegistrations, type McpServerRegistration } from "./registration.ts";

/** 历史区默认留几份 */
const KEEP_HISTORY = 10;

/** 写一次登记要动的地方（数据目录配置区：登记文件和它的历史区） */
export interface McpWriteTarget {
  /** config/mcp.json */
  file: string;
  /** config/.history */
  historyDir: string;
  /** 只留最近几份；不给是 KEEP_HISTORY */
  keepHistory?: number;
}

/** 要写进去的一次变更：加、改（都是按 name 放进去）、删 */
export interface McpRegistrationChange {
  action: "add" | "update" | "remove";
  name: string;
  /** action 不是 remove 时必给 */
  registration?: McpServerRegistration;
}

/** 写完了：留的备份（文件本来没有时没有）、写之前和之后的登记名字（排好序） */
export interface McpWriteResult {
  backup?: string;
  before: string[];
  after: string[];
}

/** 现在（协议时间）的写法换成历史区的文件名：时间到毫秒的数字，同一毫秒里再来一次加序号 */
function historyFile(target: McpWriteTarget, at: string): string {
  const stamp = at.replace(/[^0-9]/g, "").slice(0, 17);
  for (let i = 0; ; i += 1) {
    const file = path.join(target.historyDir, i === 0 ? `mcp-${stamp}.json` : `mcp-${stamp}-${i}.json`);
    if (!fs.existsSync(file)) return file;
  }
}

/** 历史区只留最近几份：文件名里的时间排前面的先删 */
function pruneHistory(target: McpWriteTarget, keep: number): void {
  const names = fs
    .readdirSync(target.historyDir)
    .filter((name) => /^mcp-\d+(?:-\d+)?\.json$/.test(name))
    .toSorted();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(target.historyDir, name), { force: true });
}

/**
 * 按 name 把一条登记写进配置区的 mcp.json：读现在的（读不懂就不写）、留一份备份、合并、原子写。
 * 读不懂现在的文件时抛 RequestRejected（bad_params），说明是哪里不对；文件一个字节都不动。
 */
export function applyMcpChange(target: McpWriteTarget, change: McpRegistrationChange, at: string): McpWriteResult {
  if (change.action !== "remove" && !change.registration) throw new RequestRejected("bad_params", `要${change.action === "add" ? "加" : "改"} MCP ${change.name}，没给登记的内容`); // @i18n-ignore model：卡片动作的结果（给用户看的错误说明先照这个写）
  const current = readMcpRegistrations(target.file);
  if (current.problem) throw new RequestRejected("bad_params", current.problem);
  const merged: Record<string, McpServerRegistration> = { ...current.servers };
  if (change.action === "remove") delete merged[change.name];
  else merged[change.name] = change.registration!;
  // 键按名字排好：写出来的文件稳定，两份备份之间好比对
  const servers = Object.fromEntries(Object.entries(merged).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  let backup: string | undefined;
  if (fs.existsSync(target.file)) {
    fs.mkdirSync(target.historyDir, { recursive: true });
    backup = historyFile(target, at);
    fs.copyFileSync(target.file, backup);
    pruneHistory(target, target.keepHistory ?? KEEP_HISTORY);
  }
  // 临时文件和目标在同一个目录（rename 才是原子的），写完再顶上去；被占着时等一会儿重试，失败时临时文件删掉（265 号票，atomic-file.ts）
  writeFileAtomic(target.file, `${JSON.stringify({ servers }, null, 2)}\n`);
  return { ...(backup === undefined ? {} : { backup }), before: Object.keys(current.servers).toSorted(), after: Object.keys(servers) };
}
