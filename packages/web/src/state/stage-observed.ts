// 长程任务阶段"系统查到的结果"（274 号票，纯函数）：每轮结束系统直接查到的结果——会话列表那一行
// （最近一轮的第一句）、阶段框里"系统在真实环境里查到的"；
// 二狗查不了世界，票面定了用效果日志代替，守护进程汇总（tasks/stage-view.ts）：
// - 看板卡上那一行（taskObservedLine）：最近一次交上来的那个阶段宣布完成时存下的个数——"第 2 阶段：git 推送 1 次；修改 1 个文件"，
//   和维护者自报对不上的几处另给（界面标 ⚠）；
// - 阶段框展开后的那一行（observedLine，同一份个数）；
// - 阶段详情里逐条的（observedRows，守护进程现取的）：对外发的一件一行（消息、请求、对外动作，说成人话）、改了的文件按新建 / 修改 / 删除分开、
//   本机做的别的事（里面改的文件效果日志记不到）、自报里提到的文件和系统查到的对不上的。
import { describeCall, fallbackLine, toolLabel } from "./call-sentence.ts";
import { listStageCodes, type StageFileChange, type StageObserved, type StageObservedCounts, type StageSendKind, t, type Task, tTable } from "./protocol.ts";
import { stageCodeLabel } from "./stage-graph.ts";

/** 一行说完系统查到的个数：对外发的按工具数，文件按新建、修改、删除数；什么都没做也照实说（"没有发任何消息""一张都没删"） */
export function observedLine(o: StageObservedCounts): string {
  const list = t("state.stageObserved.listSep");
  const sent = o.sent.length > 0 ? o.sent.map((s) => t("state.stageObserved.sentTool", { label: s.title ?? toolLabel(s.tool), n: s.n, count: s.n })).join(list) : t("state.stageObserved.noSent");
  const files = (
    [
      ["created", o.created],
      ["modified", o.modified],
      ["deleted", o.deleted],
    ] as const
  ).flatMap(([change, n]) => (n > 0 ? [t(`state.stageObserved.files.${change}`, { n, count: n })] : []));
  return [sent, files.length > 0 ? t("state.stageObserved.files", { list: files.join(list) }) : t("state.stageObserved.noFiles")].join(t("state.stageObserved.sep"));
}

/**
 * 看板卡上那一行（最近一轮系统直接查到的结果的第一句）：最近一次交上来的那个阶段（按汇总的时间），
 * 前面写第几阶段；mismatches 是那一次和自报对不上的几处。还没有阶段交上来过（重开之后清掉了的不算）就没有
 */
export function taskObservedLine(task: Task): { text: string; mismatches: number } | undefined {
  const list = task.stages?.list ?? [];
  const latest = list.filter((s) => s.observed !== undefined).toSorted((a, b) => Date.parse(b.observed!.at) - Date.parse(a.observed!.at))[0];
  if (!latest?.observed) return undefined;
  return { text: t("state.stageObserved.cardLine", { stage: stageCodeLabel(listStageCodes(list), latest.stageId), line: observedLine(latest.observed) }), mismatches: latest.observed.mismatches };
}

/** 对外发的一件是什么（消息、请求、对外动作） */
export const SEND_KIND_LABEL: Readonly<Record<StageSendKind, string>> = tTable({
  message: "state.stageObserved.kind.message",
  request: "state.stageObserved.kind.request",
  action: "state.stageObserved.kind.action",
});

/** 文件怎么了（新建、修改、删除） */
export const FILE_CHANGE_LABEL: Readonly<Record<StageFileChange, string>> = tTable({
  created: "state.stageObserved.change.created",
  modified: "state.stageObserved.change.modified",
  deleted: "state.stageObserved.change.deleted",
});

/** 阶段详情里逐条的样子 */
export interface ObservedRows {
  /** 对外发的一件一行：是什么、说成人话的那句（和会话里的工具调用一样） */
  readonly sent: ReadonlyArray<{ readonly kind: string; readonly text: string }>;
  /** 改了的文件按新建、修改、删除分开（没有的那种不列），每种按第一次动它的先后 */
  readonly files: ReadonlyArray<{ readonly change: StageFileChange; readonly label: string; readonly paths: readonly string[] }>;
  /** 本机做的、看不出改了哪些文件的，按工具数（"跑测试 2 次、git 提交 1 次"）；没有是 undefined */
  readonly other: string | undefined;
  /** 自报里提到的文件和系统查到的对不上的，一条一句 */
  readonly mismatches: readonly string[];
}

/** 阶段详情里逐条的（守护进程现取的 TaskStageView.observed） */
export function observedRows(o: StageObserved): ObservedRows {
  const list = t("state.stageObserved.listSep");
  const files = (["created", "modified", "deleted"] as const).flatMap((change) => {
    const paths = o.files.filter((f) => f.change === change).map((f) => f.path);
    return paths.length > 0 ? [{ change, label: FILE_CHANGE_LABEL[change], paths }] : [];
  });
  return {
    sent: o.sent.map((s) => ({ kind: SEND_KIND_LABEL[s.kind], text: describeCall(s.tool, s.argsSummary) ?? fallbackLine(s.tool, s.argsSummary) })),
    files,
    other: o.other.length > 0 ? o.other.map((x) => t("state.stageObserved.sentTool", { label: x.toolTitle ?? toolLabel(x.tool), n: x.n, count: x.n })).join(list) : undefined,
    mismatches: o.claims.flatMap((c) => (c.result === "found" ? [] : [t(`state.stageObserved.claim.${c.result}`, { text: c.text })])),
  };
}
