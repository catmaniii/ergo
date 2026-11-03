// 守卫接入里和目录授权（ADR-0049）有关的两件事：
// - 使用记录：因为某个 agent 的目录授权放行、执行了的调用，碰到的每个路径记一条（folder_grant_used，在守护进程内部的 guard 频道上）：
//   哪个 agent、哪条授权、登记的目录、路径、哪种操作、哪个工具、什么时候。文件工具能拿到字节数的写上（写：写进去的内容；读：交回的内容）；
//   bash 拆出来的只记守卫看得到的路径参数，不是程序实际读写了哪些文件（viaShell，设置页上如实写）。设置 · 目录授权里看最近的；
// - 审批卡上的"以后都允许"：对话里因为越出项目目录要问的一次调用，登记一个目录就会整个放开的（照这次要的操作、在这个 agent 的
//   表里加上它再判一遍，判出来会执行才算），审批卡上带着它；用户点了由审批卡登记（approvals/approvals.ts）。
import { win32 } from "node:path";
import { type ApprovalFolderGrant, FOLDER_GRANT_MODES, type FolderGrantMode } from "@ergo/protocol";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { comparable, type GuardInput, type GuardJudgement, isWithin, judgementExecutes, judgeToolCall } from "../guard/index.ts";
import { GUARD_CHANNEL } from "./events.ts";

/** 一处使用记录的事件类型 */
export const FOLDER_GRANT_USED = "folder_grant_used";

export interface FolderGrantUsedPayload {
  agentId: string;
  grantId: string;
  dir: string;
  path: string;
  mode: FolderGrantMode;
  tool: string;
  viaShell: boolean;
  bytes?: number;
  /** 放行了、执行出错的 */
  failed?: true;
  toolCallId: string;
  time: string;
}

/** 这次放行、执行了的调用里因为目录授权放开的每一处：一条事件（不追加） */
export function folderGrantUseEvents(
  input: Pick<GuardInput, "agent">,
  judgement: Pick<GuardJudgement, "folderGrantUses" | "calls">,
  end: { toolCallId: string; resultText?: string | undefined; isError?: boolean | undefined; time: string },
): NewEvent[] {
  return (judgement.folderGrantUses ?? []).map((use) => {
    const call = judgement.calls[use.call];
    const viaShell = call?.origin === "shell";
    const bytes = call && !viaShell ? bytesOf(call.tool, call.args, use.mode, end) : undefined;
    const payload: FolderGrantUsedPayload = {
      agentId: input.agent.agentId,
      grantId: use.grantId,
      dir: use.dir,
      path: use.path,
      mode: use.mode,
      tool: call?.tool ?? "",
      viaShell,
      ...(bytes === undefined ? {} : { bytes }),
      ...(end.isError ? { failed: true as const } : {}),
      toolCallId: end.toolCallId,
      time: end.time,
    };
    return { channel: GUARD_CHANNEL, type: FOLDER_GRANT_USED, payload };
  });
}

/** 文件工具拿得到的字节数：写的是写进去的全文，读的是交回的内容（出错的不算）；别的拿不到 */
function bytesOf(tool: string, args: Readonly<Record<string, unknown>>, mode: FolderGrantMode, end: { resultText?: string | undefined; isError?: boolean | undefined }): number | undefined {
  if (mode === "write" && tool === "write" && typeof args.content === "string") return Buffer.byteLength(args.content, "utf8");
  if (mode === "read" && tool === "read" && !end.isError && typeof end.resultText === "string") return Buffer.byteLength(end.resultText, "utf8");
  return undefined;
}

/** 最近的 limit 条，新的在前 */
export function recentFolderGrantUses(store: Pick<EventStore, "readBefore">, limit: number): FolderGrantUsedPayload[] {
  return store
    .readBefore(GUARD_CHANNEL, Number.MAX_SAFE_INTEGER, limit, FOLDER_GRANT_USED)
    .map((e) => e.payload as FolderGrantUsedPayload)
    .toReversed();
}

/**
 * 审批卡上"以后都允许"要登记的目录和操作：只在对话里（不属于任务）、这个 agent 有目录授权表、要问的只有"越出项目目录"
 * （判断不了的不算）、登记了就会放开的那几处都在同一个目录里（是目录的就是它，是文件的是它所在的目录；几处的取最上面那个，
 * 别的都要在它里面）；在这个 agent 的表里加上它再判一遍，会执行才给。exists 核对这个目录现在在（调用方给，判定函数不碰文件）
 */
export function folderGrantSuggestion(input: GuardInput, judgement: GuardJudgement, exists: (dir: string) => boolean): ApprovalFolderGrant | undefined {
  if (input.task !== null || input.folderGrants === undefined) return undefined;
  if (judgement.hardRefusal !== null || judgement.pullBack !== null || judgement.disposition !== "ask_first") return undefined;
  const asking = judgement.findings.filter((f) => f.kind !== "hard_refusal" && f.kind !== "pull_back" && f.disposition === "ask_first");
  if (asking.length === 0 || asking.some((f) => f.kind !== "category" || f.id !== "outside_project" || f.keepAsking === true)) return undefined;
  const candidates = judgement.folderGrantCandidates ?? [];
  if (candidates.length === 0) return undefined;
  const dirs = candidates.map((c) => (c.isDirectory ? c.realPath : win32.dirname(c.realPath)));
  const dir = dirs.toSorted((a, b) => comparable(a).length - comparable(b).length)[0]!;
  if (!dirs.every((d) => isWithin(d, dir)) || !exists(dir)) return undefined;
  const modes = FOLDER_GRANT_MODES.filter((m) => candidates.some((c) => c.mode === m));
  const again = judgeToolCall({ ...input, folderGrants: [...input.folderGrants, { grantId: "suggested", dir, modes }] });
  return judgementExecutes(again) ? { path: dir, modes } : undefined;
}
