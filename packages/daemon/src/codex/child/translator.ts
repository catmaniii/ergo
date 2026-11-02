// app-server 的通知 → 宿主协议的上报：只管回复、工具调用和用量；轮次、压缩由 session.ts 管。Codex 的词汇在这里换成二狗自己的。
// - 逐字输出：item/agentMessage/delta → stream_delta text；item/reasoning/*Delta → stream_delta thinking；
// - 一条回复：Codex 没有"一次模型调用"的边界，按条目报。agentMessage、reasoning 的 item/completed 攒进草稿，工具调用开始、这一轮结束时报一条 message_final
//   （和 pi 一样：定稿在前、工具调用开始在后），定稿里带上引起定稿的那次工具调用；打断时已经说出来的留着；
// - 工具条目（命令、改文件、MCP、联网搜索、看图、生成图片、子代理、sleep）：全部报 tool_call_start / tool_call_end。钩子先到手时由钩子先报开始（ensureStarted），
//   条目再来不重复；钩子拦下的条目根本不来（实测），由守卫那边当场报结束（end），之后再来的同 id 条目不管；
// - 钩子放行、却没有条目的调用（实测 0.166：get_goal、create_goal、update_goal、list_agents、curr_time、request_user_input，还有被 execpolicy 禁掉、被 Codex 自己拒掉的命令）：
//   结果不知道，也等不来。Codex 等一次模型回复里的工具都做完才报这次的用量，所以用量通知到了还没条目的就是这种，按"没出错、不知道结果"收尾（closeItemless），不留到轮次结束记成出错；
// - 子代理的 thread 上的条目：parentToolCallId 挂在派它的那次调用下面，正文不转；
// - 用量：thread/tokenUsage/updated 的 last 是最近一次模型调用的；Codex 只更新额度时也发这个通知（total 没变），按 thread 的 total 去重；轮次外的（接着会话时报的旧累计）只记不报。子代理各有各的累计，也要算。
//   inputTokens 含缓存，宿主协议的 input 不含；provider 记成 codex-subscription（订阅额度）、codex-api-key（按量）、codex（不知道），消耗页按它写明。
// 不认得的条目、通知一律不管（协议还在加）。
// @i18n-ignore-file log
import type { AgentReport, FinalPart, StopReason, UsagePurpose } from "../../runtime/host-protocol.ts";
import { mcpToolName } from "./host-tools.ts";

/** app-server 的条目（只看用到的几个字段；形状以生成的 schema 为准） */
export type CodexItem = Record<string, unknown> & { type?: string; id?: string };

/** 一次工具调用在二狗这边的样子 */
export interface CodexToolCall {
  id: string;
  /** 报给守护进程、守卫判定用的工具名 */
  toolName: string;
  /** 守卫判定用的参数 */
  args: Record<string, unknown>;
  /** Codex 自己的工具名和原样参数 */
  native: { toolName: string; args: unknown };
}

/** 一次补丁改了哪些文件 */
export interface PatchPaths {
  adds: string[];
  updates: string[];
  deletes: string[];
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** fileChange 条目的 changes → 改了哪些文件（移动算删旧写新） */
function pathsOfChanges(changes: unknown): PatchPaths {
  const paths: PatchPaths = { adds: [], updates: [], deletes: [] };
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!isRecord(change) || typeof change.path !== "string") continue;
    const kind = isRecord(change.kind) ? change.kind : {};
    if (kind.type === "add") paths.adds.push(change.path);
    else if (kind.type === "delete") paths.deletes.push(change.path);
    else if (typeof kind.move_path === "string") {
      paths.deletes.push(change.path);
      paths.adds.push(kind.move_path);
    } else paths.updates.push(change.path);
  }
  return paths;
}

/** 补丁正文（apply_patch 的 command）→ 改了哪些文件：看不出来的是 undefined */
export function pathsOfPatch(patch: string): PatchPaths | undefined {
  const paths: PatchPaths = { adds: [], updates: [], deletes: [] };
  let last: string | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!match) continue;
    const file = match[2]!.trim();
    if (match[1] === "Add File") paths.adds.push(file);
    else if (match[1] === "Delete File") paths.deletes.push(file);
    else if (match[1] === "Update File") {
      paths.updates.push(file);
      last = file;
    } else if (last !== undefined) {
      paths.updates.splice(paths.updates.indexOf(last), 1);
      paths.deletes.push(last);
      paths.adds.push(file);
    }
  }
  return paths.adds.length + paths.updates.length + paths.deletes.length > 0 ? paths : undefined;
}

/**
 * 这条命令真正要跑的那句：条目和审批请求里的 command 是外壳包好的（实测 0.166 Windows 上是 "...powershell.exe" -Command '...'），钩子给的是模型写的那句。
 * commandActions 只有一条时它就是模型写的那句；几条（管道、连着写的）不拆，照外壳包好的。钩子跑失败时判定用它，读前情也用它
 */
export function innerCommand(source: Record<string, unknown>): string {
  const actions = Array.isArray(source.commandActions) ? source.commandActions : [];
  const only = actions.length === 1 && isRecord(actions[0]) ? str(actions[0].command) : undefined;
  return only ?? str(source.command) ?? "";
}

/**
 * 交给守卫判定的命令：守卫按 Git Bash 的语法拆命令（guard/shell/split.ts），没加引号的反斜杠是转义：D:\a\b 拆成 D:ab，..\x 拆成 ..x，密钥区的硬拒绝和越出目录都认不出来（实测）。
 * Codex 在 Windows 上默认跑 PowerShell，反斜杠就是路径分隔符，所以给守卫看的一律换成正斜杠（守卫比较路径不分 / 和 \）。模型写的原样放在 native
 */
export function commandForGuard(command: string): string {
  return command.replaceAll("\\", "/");
}

/** 工具条目 → 一次工具调用；不是工具的条目（消息、思考、压缩……）是 undefined。hostNameOf：ergo 服务里的工具换回二狗的名字 */
export function toolOfItem(item: CodexItem, hostNameOf: (relayName: string) => string | undefined): CodexToolCall | undefined {
  const id = item.id;
  if (typeof id !== "string" || id === "") return undefined;
  switch (item.type) {
    case "commandExecution": {
      if (item.source === "userShell") return undefined;
      const command = innerCommand(item);
      if (item.source === "unifiedExecInteraction") return { id, toolName: "write_stdin", args: { processId: item.processId }, native: { toolName: "write_stdin", args: { processId: item.processId } } };
      return { id, toolName: "bash", args: { command: commandForGuard(command) }, native: { toolName: "Bash", args: { command, cwd: item.cwd } } };
    }
    case "fileChange": {
      const paths = pathsOfChanges(item.changes);
      return { id, toolName: "apply_patch", args: { ...paths }, native: { toolName: "apply_patch", args: { changes: item.changes } } };
    }
    case "mcpToolCall": {
      const server = str(item.server) ?? "";
      const tool = str(item.tool) ?? "";
      const args = isRecord(item.arguments) ? item.arguments : {};
      const own = server === "ergo" ? hostNameOf(tool) : undefined;
      return { id, toolName: own ?? mcpToolName(server, tool), args, native: { toolName: mcpToolName(server, tool), args } };
    }
    case "dynamicToolCall": {
      const tool = str(item.tool) ?? "";
      const args = isRecord(item.arguments) ? item.arguments : {};
      return { id, toolName: tool, args, native: { toolName: tool, args } };
    }
    case "webSearch": {
      const query = str(item.query) ?? "";
      return { id, toolName: "web_search", args: { query }, native: { toolName: "webSearch", args: { query, action: item.action ?? null } } };
    }
    case "imageView": {
      const file = str(item.path) ?? "";
      return { id, toolName: "read", args: { path: file }, native: { toolName: "view_image", args: { path: file } } };
    }
    case "imageGeneration":
      return { id, toolName: "image_generation", args: { revisedPrompt: item.revisedPrompt ?? null }, native: { toolName: "image_generation", args: { revisedPrompt: item.revisedPrompt ?? null } } };
    case "sleep":
      return { id, toolName: "sleep", args: { durationMs: item.durationMs }, native: { toolName: "sleep", args: { durationMs: item.durationMs } } };
    case "subAgentActivity": {
      // 实测 0.166 派子代理（spawn_agent）报的是这个，不是 collabAgentToolCall：kind 是 started 的那条 id 就是调用 id，completed 的那条只是通知
      if (item.kind !== "started") return undefined;
      const args = { agentPath: item.agentPath ?? null, model: item.model ?? null };
      return { id, toolName: "spawnAgent", args, native: { toolName: "spawn_agent", args } };
    }
    case "collabAgentToolCall": {
      const tool = str(item.tool) ?? "collab";
      const args = { prompt: item.prompt ?? null, receiverThreadIds: item.receiverThreadIds ?? [], model: item.model ?? null };
      return { id, toolName: tool, args, native: { toolName: tool, args } };
    }
    default:
      return undefined;
  }
}

/** 工具条目的结果：出错没有、给人看的文字 */
export function endOfItem(item: CodexItem): { isError: boolean; text: string } {
  switch (item.type) {
    case "commandExecution":
      return { isError: item.status !== "completed" || (typeof item.exitCode === "number" && item.exitCode !== 0), text: str(item.aggregatedOutput) ?? "" };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const text = changes.flatMap((change) => (isRecord(change) && typeof change.path === "string" ? [change.path] : [])).join("\n");
      return { isError: item.status !== "completed", text };
    }
    case "mcpToolCall": {
      const error = isRecord(item.error) ? str(item.error.message) : undefined;
      const result = isRecord(item.result) ? item.result : {};
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.map((block) => (isRecord(block) && block.type === "text" ? (str(block.text) ?? "") : `[${isRecord(block) ? String(block.type) : "unknown"}]`)).join("\n");
      return { isError: item.status === "failed" || error !== undefined, text: error ?? text };
    }
    case "dynamicToolCall": {
      const items = Array.isArray(item.contentItems) ? item.contentItems : [];
      return { isError: item.success === false, text: items.map((block) => (isRecord(block) ? (str(block.text) ?? "") : "")).join("\n") };
    }
    case "webSearch":
      return { isError: false, text: str(item.query) ?? "" };
    case "imageView":
      return { isError: false, text: str(item.path) ?? "" };
    case "imageGeneration":
      return { isError: isRecord(item.failure), text: str(item.savedPath) ?? str(item.revisedPrompt) ?? "" };
    case "subAgentActivity":
      return { isError: false, text: str(item.agentPath) ?? "" };
    case "collabAgentToolCall":
      return { isError: item.status === "failed", text: str(item.status) ?? "" };
    default:
      return { isError: false, text: "" };
  }
}

/** 正在攒的一条回复 */
interface Draft {
  messageId: string;
  parts: FinalPart[];
}

interface TokenBreakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

export interface TokenUsageNotice {
  total?: TokenBreakdown;
  last?: TokenBreakdown;
  modelContextWindow?: number | null;
}

export class CodexTranslator {
  private seq = 0;
  private usageSeq = 0;
  private draft: Draft | undefined;
  /** 还没 item/completed 的消息、思考：打断时说出来的留着 */
  private readonly partial = new Map<string, { part: "text" | "thinking"; text: string }>();
  /** 报过开始、还没结束的调用：id → 报的工具名、Codex 的名字（MCP 的认领按它）、认领过没有、来过条目没有、挂在哪次调用下面 */
  private readonly open = new Map<string, { name: string; relay?: string; claimed: boolean; item: boolean; parent?: string }>();
  /** 报过结束的调用：同 id 的条目再来不管 */
  private readonly closed = new Set<string>();
  /** 结束先不报的（守卫还没回判定）：id → 结束的内容 */
  private readonly held = new Map<string, { isError: boolean; text: string; parent?: string }>();
  /** 结果前面要加的话（守卫按计划改了参数时写明实际执行的是哪一版） */
  private readonly prefixes = new Map<string, string>();
  /** 各 thread 的累计用量（去重） */
  private readonly lastTotals = new Map<string, number>();
  private lastMessageId: string | undefined;

  /** 用量记在哪种计费下（account/read 定） */
  provider = "codex";
  /** 现在的模型（thread/start、thread/resume、model/rerouted） */
  model = "";
  /** 这一轮在进行：轮次外的用量通知只记不报 */
  active = false;
  /** 压缩、写交接摘要那一轮：输出不当成回复 */
  suppress = false;

  private readonly emit: (report: AgentReport) => void;

  constructor(emit: (report: AgentReport) => void) {
    this.emit = emit;
  }

  beginTurn(): void {
    this.active = true;
    this.lastMessageId = undefined;
  }

  delta(itemId: string, part: "text" | "thinking", delta: string): void {
    if (this.suppress || !delta) return;
    const open = this.partial.get(itemId);
    if (open) open.text += delta;
    else this.partial.set(itemId, { part, text: delta });
    this.emit({ type: "stream_delta", messageId: this.draftNow().messageId, part, delta });
  }

  /** 一条消息、思考做完了：攒进草稿 */
  messageDone(item: CodexItem): void {
    if (this.suppress || typeof item.id !== "string") return;
    this.partial.delete(item.id);
    if (item.type === "agentMessage") {
      const text = str(item.text) ?? "";
      if (text) this.draftNow().parts.push({ type: "text", text });
    } else if (item.type === "reasoning") {
      const content = Array.isArray(item.content) ? item.content : [];
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const text = (content.length > 0 ? content : summary).filter((s): s is string => typeof s === "string").join("\n");
      if (text) this.draftNow().parts.push({ type: "thinking", text });
    }
  }

  /** 这次调用报开始（报过、结束过的不再报）；主线的调用先把攒着的回复定稿。relay：ergo 服务里的工具名（中转来的调用按它认领） */
  ensureStarted(call: CodexToolCall, parent?: string): void {
    if (this.open.has(call.id) || this.closed.has(call.id)) return;
    if (parent === undefined) this.flush("tool_calls", call);
    const relay = /^mcp__ergo__(.+)$/.exec(call.native.toolName)?.[1];
    this.open.set(call.id, { name: call.toolName, ...(relay === undefined ? {} : { relay }), claimed: false, item: false, ...(parent === undefined ? {} : { parent }) });
    this.emit({ type: "tool_call_start", toolCallId: call.id, toolName: call.toolName, args: call.args, ...(parent === undefined ? {} : { parentToolCallId: parent }) });
  }

  /** 这次调用有条目（之后等它的 item/completed） */
  noteItem(id: string): void {
    const call = this.open.get(id);
    if (call) call.item = true;
  }

  /** 这条线上（parent：子代理的，派它的那次调用）钩子放行了、到现在没条目的调用：没有条目可等了，按没出错收尾（见文件开头）。waiting：判定还没回的不动 */
  closeItemless(parent: string | undefined, waiting: (id: string) => boolean): void {
    for (const [id, call] of this.open) if (!call.item && call.parent === parent && !waiting(id)) this.end(id, false, "", parent);
  }

  /** 中转来的调用没带调用 id：Codex 的工具名是这个、报过开始、没认领过的最早那次 */
  claim(relayName: string): string | undefined {
    for (const [id, call] of this.open) {
      if (call.relay !== relayName || call.claimed) continue;
      call.claimed = true;
      return id;
    }
    return undefined;
  }

  addPrefix(id: string, prefix: string): void {
    this.prefixes.set(id, prefix);
  }

  /** 工具条目结束了；hold：守卫还没回判定，先记着（守护进程按 guard_request 记这次调用，结束不能抢在判定前面） */
  itemDone(item: CodexItem, parent: string | undefined, hold: boolean): void {
    if (typeof item.id !== "string" || this.closed.has(item.id)) return;
    const { isError, text } = endOfItem(item);
    if (hold) this.held.set(item.id, { isError, text, ...(parent === undefined ? {} : { parent }) });
    else this.end(item.id, isError, text, parent);
  }

  /** 判定回来了：先记着的结束现在报 */
  release(id: string): void {
    const held = this.held.get(id);
    if (!held) return;
    this.held.delete(id);
    this.end(id, held.isError, held.text, held.parent);
  }

  /** 报结束：钩子拦下的、条目结束的都走这里；报过开始才报 */
  end(id: string, isError: boolean, text: string, parent?: string): void {
    const call = this.open.get(id);
    if (!call) return;
    this.open.delete(id);
    this.closed.add(id);
    const prefix = this.prefixes.get(id);
    this.prefixes.delete(id);
    this.emit({
      type: "tool_call_end",
      toolCallId: id,
      toolName: call.name,
      isError,
      resultText: prefix === undefined ? text : [prefix, text].join("\n"),
      ...(parent === undefined ? {} : { parentToolCallId: parent }),
    });
  }

  /** 这一轮结束了：还开着的调用收尾（等不来条目了），先记着的结束都报，攒着的回复定稿 */
  finishTurn(reason: StopReason, errorMessage: string | undefined, unfinished: string): void {
    for (const id of this.held.keys()) this.release(id);
    for (const [id, call] of this.open) {
      // 正常结束时没条目的：就是没有条目的那种调用，不算出错；有条目没等到结束的、打断或出错收尾的才写"没等到结果"
      const quiet = reason === "done" && !call.item;
      this.end(id, !quiet, quiet ? "" : unfinished, call.parent);
    }
    this.flush(reason, undefined, errorMessage);
    this.active = false;
  }

  /** 用量通知：一次模型调用一条（见文件开头）。purpose：压缩、写交接摘要那次；thread：哪条线上的（各算各的累计），子代理的另起一个 messageId */
  usage(notice: TokenUsageNotice, purpose?: UsagePurpose, messageId?: string, thread = ""): void {
    const total = notice.total?.totalTokens;
    const changed = total === undefined || total !== this.lastTotals.get(thread);
    if (total !== undefined) this.lastTotals.set(thread, total);
    const last = notice.last;
    if (!changed || !last || !this.active) return;
    const cacheRead = last.cachedInputTokens ?? 0;
    const cacheWrite = last.cacheWriteInputTokens ?? 0;
    const input = Math.max(0, (last.inputTokens ?? 0) - cacheRead - cacheWrite);
    const output = last.outputTokens ?? 0;
    if (input + output + cacheRead + cacheWrite === 0) return;
    this.emit({
      type: "usage",
      messageId: messageId ?? this.draft?.messageId ?? this.lastMessageId ?? `usage-${++this.usageSeq}`,
      provider: this.provider,
      modelId: this.model,
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      ...(purpose === undefined ? {} : { purpose }),
    });
  }

  /** 把攒着的回复报一条（没有就不报）。call：引起定稿的那次工具调用 */
  private flush(stopReason: StopReason, call?: CodexToolCall, errorMessage?: string): void {
    const draft = this.draft;
    if (!draft && !call) return;
    // 打断、出错时已经说出来、还没做完的那些留着
    if (stopReason !== "tool_calls") {
      for (const { part, text } of this.partial.values()) if (text) (draft ?? this.draftNow()).parts.push(part === "text" ? { type: "text", text } : { type: "thinking", text });
    }
    this.partial.clear();
    const current = this.draft;
    this.draft = undefined;
    if (!current || current.parts.length === 0) {
      if (current) this.lastMessageId = current.messageId;
      if (!call) return;
    }
    const messageId = current?.messageId ?? this.nextId();
    const parts: FinalPart[] = [...(current?.parts ?? []), ...(call ? [{ type: "tool_call" as const, toolCallId: call.id, toolName: call.toolName, args: call.args }] : [])];
    this.emit({ type: "message_final", messageId, message: { role: "assistant", parts, stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) } });
    this.lastMessageId = messageId;
  }

  private draftNow(): Draft {
    this.draft ??= { messageId: this.nextId(), parts: [] };
    return this.draft;
  }

  private nextId(): string {
    return `msg-${++this.seq}`;
  }
}
