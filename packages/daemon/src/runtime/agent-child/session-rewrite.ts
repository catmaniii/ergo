// 彻底删除（规格第 14、15 节，21 号票）在会话文件这一侧：把 agent 会话文件（pi 的 JSONL）里对应的原话改写成删除标记。
// 会话文件的形状是 pi 的，所以这段放在子进程这一层、用 pi 的类型做类型检查（ADR-0004、ADR-0008）；守护进程以一次性子进程
// （rewrite-main.ts）的方式调用它。要改的：
// - 用户消息：子进程在每条用户输入前记了一条自定义条目（SESSION_INPUT_TAG，带 inputId），紧跟着的那条用户消息就是它，
//   内容整个换成删除标记（附件的内联内容、图片一起去掉）。21 号票之前的会话没有这个标签，找不到就不改；
// - 某几次工具调用（提议"记住"）：助手消息里这次调用的参数里的文字、这次调用的工具结果整个换成删除标记；
// - 某个工具（素材检索）的结果里提到被删素材的那几行，换成"- <素材 id> · 删除标记"；
// - 某几类自定义条目（范围审视结果的副本，18 号票）：数据里的文字全换成删除标记，结构不变；
// - 压缩摘要、分支摘要：被改的条目落在某次压缩覆盖的范围里（在它保留的第一条之前），这段摘要整段换成 summaryMarker；
//   分支摘要在被改的条目之后的，一样换掉（摘要是从原话生成的，只改原话不改摘要等于没删）；
// - 换模型时的交接摘要（83 号票）：新会话开头那条（HANDOFF_SUMMARY_TYPE）是从原来的会话写的，原来的会话里有要改的条目时
//   整段换成 summaryMarker，这个会话后来覆盖了它的压缩摘要也换掉；原来的会话自己又是换过来的、它开头的交接摘要被换掉了，
//   从它再往后换的也一样（跨文件看，一层层往后推）。
// 改写是幂等的：已经是删除标记的不再算"改了"。只改有变化的文件；先写临时文件再改名，并保留原来的修改时间
// （pi 按修改时间挑"最近的会话"接着用，不能因为改写换了会话）。agent 正在跑着时内存里还有原文：调用方先停掉子进程。
import fs from "node:fs";
import path from "node:path";
import type { BranchSummaryEntry, CompactionEntry, CustomEntry, CustomMessageEntry, FileEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { HANDOFF_SUMMARY_TYPE, SESSION_INPUT_TAG, type SessionRewriteRequest, type SessionRewriteResult } from "../host-protocol.ts";

const SESSION_EXT = ".jsonl";

/** 改写一个会话目录里的全部会话文件 */
export function rewriteSessionDir(request: SessionRewriteRequest): SessionRewriteResult {
  const result: SessionRewriteResult = { files: 0, entries: 0, summaries: 0 };
  if (!fs.existsSync(request.sessionDir)) return result;
  // 第一遍：各会话里有没有要改的条目、是不是从别的会话换过来的
  const sessions = fs
    .readdirSync(request.sessionDir)
    .filter((name) => name.endsWith(SESSION_EXT))
    .map((name) => {
      const file = path.join(request.sessionDir, name);
      const text = fs.readFileSync(file, "utf8");
      return { name: path.basename(name, SESSION_EXT), file, text, scanned: rewriteSessionText(text, request) };
    });
  const covered = coveredSessions(sessions.map((s) => ({ name: s.name, targeted: s.scanned.targeted, from: s.scanned.handoffFrom })));
  for (const { file, text, scanned } of sessions) {
    // 从有要改的内容的会话换过来的：开头的交接摘要也换掉
    const rewritten = scanned.handoffFrom !== undefined && covered.has(scanned.handoffFrom) ? rewriteSessionText(text, request, { handoffCovered: true }) : scanned;
    if (rewritten.entries === 0 && rewritten.summaries === 0) continue;
    const stat = fs.statSync(file);
    const temp = `${file}.rewrite-${process.pid}.tmp`;
    fs.writeFileSync(temp, rewritten.text, "utf8");
    fs.renameSync(temp, file);
    fs.utimesSync(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    result.files += 1;
    result.entries += rewritten.entries;
    result.summaries += rewritten.summaries;
  }
  return result;
}

/**
 * 有要改的内容的会话，连同从它们换过来的（83 号票：交接摘要从原来的会话写，再往后换的摘要又是从这段摘要写的，一层层往后推）
 */
function coveredSessions(sessions: ReadonlyArray<{ name: string; targeted: boolean; from: string | undefined }>): Set<string> {
  const covered = new Set(sessions.filter((s) => s.targeted).map((s) => s.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of sessions) {
      if (covered.has(s.name) || s.from === undefined || !covered.has(s.from)) continue;
      covered.add(s.name);
      grew = true;
    }
  }
  return covered;
}

type Line = { raw: string; entry?: FileEntry };

/** 改写一个会话文件的结果：改了几条条目、换掉了几段摘要；有没有要改的条目（已经改过的也算）、是从哪个会话换过来的（83 号票） */
export interface SessionTextRewrite {
  text: string;
  entries: number;
  summaries: number;
  targeted: boolean;
  handoffFrom?: string;
}

/**
 * 改写一个会话文件的内容（纯函数）。handoffCovered：开头的交接摘要（83 号票）是从有要改的内容的会话写的，整段换掉
 * （要不要换得看原来的会话，由 rewriteSessionDir 跨文件判断）
 */
export function rewriteSessionText(text: string, request: SessionRewriteRequest, options: { handoffCovered?: boolean } = {}): SessionTextRewrite {
  const lines: Line[] = text.split("\n").map((raw) => ({ raw, ...parse(raw) }));
  const inputs = new Set(request.inputIds);
  const toolCalls = new Set(request.toolCallIds);
  const customTypes = new Set(request.customTypes);
  /** 要改的条目在文件里的位置（已经改过的也算：摘要覆不覆盖按它判断，重跑时一样） */
  const targeted: number[] = [];
  let entries = 0;
  let tagged = false;
  let handoffFrom: string | undefined;
  /** 开头那条交接摘要在文件里的位置 */
  let handoffAt: number | undefined;

  lines.forEach((line, index) => {
    const entry = line.entry;
    if (!entry) return;
    if (entry.type === "custom_message" && (entry as CustomMessageEntry).customType === HANDOFF_SUMMARY_TYPE) {
      const from = ((entry as CustomMessageEntry).details as { fromSession?: unknown } | undefined)?.fromSession;
      if (typeof from === "string") handoffFrom = from;
      handoffAt = index;
      return;
    }
    if (entry.type === "custom") {
      const custom = entry as CustomEntry;
      if (custom.customType === SESSION_INPUT_TAG) tagged = inputs.has(String((custom.data as { inputId?: unknown } | undefined)?.inputId));
      // 范围审视结果的副本（18 号票）：数据里的文字全换掉（不进模型的上下文，不影响摘要）
      if (customTypes.has(custom.customType)) {
        const next = { ...custom, data: purgedStrings(custom.data, request.marker) };
        const raw = JSON.stringify(next);
        if (raw === JSON.stringify(custom)) return;
        lines[index] = { raw, entry: next };
        entries += 1;
      }
      return;
    }
    if (entry.type !== "message") return;
    const next = rewriteMessage(entry, { tagged, toolCalls, request });
    if (entry.message.role === "user") tagged = false;
    if (next === undefined) return;
    targeted.push(index);
    const raw = JSON.stringify(next);
    if (raw === JSON.stringify(entry)) return;
    lines[index] = { raw, entry: next };
    entries += 1;
  });

  let summaries = 0;
  // 交接摘要（83 号票）：原来的会话里有要改的内容，整段换掉（数据里从哪个会话换过来的留着，后面再换过来的据此判断）；
  // 它也算被改的条目：这个会话后来压缩时的摘要是连它一起写的，覆盖了它的压缩摘要一样换掉
  if (options.handoffCovered && handoffAt !== undefined) {
    targeted.push(handoffAt);
    const handoff = lines[handoffAt]!.entry as CustomMessageEntry;
    if (handoff.content !== request.summaryMarker) {
      const next = { ...handoff, content: request.summaryMarker };
      lines[handoffAt] = { raw: JSON.stringify(next), entry: next };
      summaries += 1;
    }
  }

  // 覆盖了被改条目的压缩摘要、分支摘要整段换掉
  const ids = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.entry && "id" in line.entry) ids.set(line.entry.id, index);
  });
  lines.forEach((line, index) => {
    const entry = line.entry;
    if (!entry || (entry.type !== "compaction" && entry.type !== "branch_summary")) return;
    const summarized = entry.type === "compaction" ? Math.min(index, ids.get((entry as CompactionEntry).firstKeptEntryId) ?? index) : index;
    if (!targeted.some((t) => t < summarized)) return;
    const summary = entry as CompactionEntry | BranchSummaryEntry;
    if (summary.summary === request.summaryMarker) return;
    const next = { ...summary, summary: request.summaryMarker };
    lines[index] = { raw: JSON.stringify(next), entry: next };
    summaries += 1;
  });

  return { text: lines.map((l) => l.raw).join("\n"), entries, summaries, targeted: targeted.length > 0, ...(handoffFrom === undefined ? {} : { handoffFrom }) };
}

/** 一条消息条目要不要改、改成什么；不用改的是 undefined */
function rewriteMessage(
  entry: SessionMessageEntry,
  options: { tagged: boolean; toolCalls: ReadonlySet<string>; request: SessionRewriteRequest },
): SessionMessageEntry | undefined {
  const { request } = options;
  const message = entry.message;
  const markerContent = [{ type: "text" as const, text: request.marker }];
  if (message.role === "user") {
    return options.tagged ? { ...entry, message: { ...message, content: markerContent } } : undefined;
  }
  if (message.role === "assistant") {
    if (!message.content.some((block) => block.type === "toolCall" && options.toolCalls.has(block.id))) return undefined;
    const content = message.content.map((block) =>
      block.type === "toolCall" && options.toolCalls.has(block.id) ? { ...block, arguments: purgedStrings(block.arguments, request.marker) as typeof block.arguments } : block,
    );
    return { ...entry, message: { ...message, content } };
  }
  if (message.role === "toolResult") {
    if (options.toolCalls.has(message.toolCallId)) return { ...entry, message: { ...message, content: markerContent } };
    const rule = request.toolResultLines.find((r) => r.toolName === message.toolName);
    if (!rule) return undefined;
    let touched = false;
    const content = message.content.map((block) => {
      if (block.type !== "text") return block;
      const text = block.text
        .split("\n")
        .map((l) => {
          const needle = rule.needles.find((n) => l.includes(n));
          if (needle === undefined) return l;
          touched = true;
          return `- ${needle} · ${request.marker}`;
        })
        .join("\n");
      return { ...block, text };
    });
    return touched ? { ...entry, message: { ...message, content } } : undefined;
  }
  return undefined;
}

/** 一个值里的全部文字换成删除标记，结构不变 */
function purgedStrings(value: unknown, marker: string): unknown {
  if (typeof value === "string") return marker;
  if (Array.isArray(value)) return value.map((v) => purgedStrings(v, marker));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, purgedStrings(v, marker)]));
  return value;
}

/** 一行 JSON；不是 JSON 的行（最后半行、空行）原样留着 */
function parse(raw: string): { entry?: FileEntry } {
  if (raw.trim() === "") return {};
  try {
    return { entry: JSON.parse(raw) as FileEntry };
  } catch {
    return {};
  }
}
