// 维护者的运行时在网页这一侧（289 号票，纯函数）：新建项目、任务时选、卡上标出、⚙ 里换、界面按能力清单收起运行时不支持的按钮。
// - 运行时清单经 GET /api/runtimes 取（AgentRuntimeView：名字、能不能用、能力清单、模型、设置项），还没取到时一律按"都支持"（界面和以前一样）；
// - 会话的维护者用哪个运行时：项目的维护者照项目的（没写照转来的任务的），任务自己的照任务的，秘书一直是 pi；
// - 新建时只有 pi 能选（没启用别的运行时插件）就不显示这一项；
// - 卡上只标插件登记的运行时（默认的 pi 不标）；⚙ 里的运行时一块同样只有 pi 时不显示。
import { MAINTAINER_CHANNEL_PREFIX, PI_RUNTIME_ID, runtimeIdOf, runtimeShown, runtimeTitleOf, selectableRuntimes, t } from "./protocol.ts";
import type { AgentRuntimeStateView, AgentRuntimeView, BranchFilesRewind, Project, RuntimeOperation, RuntimeSettingView, Task } from "./protocol.ts";

/** 这个运行时能不能做某项会话操作：清单还没取到、不认得的运行时都当能（界面照旧） */
export function runtimeSupports(runtimes: readonly AgentRuntimeView[] | undefined, runtime: string | undefined, operation: RuntimeOperation): boolean {
  const found = runtimes?.find((r) => r.id === runtimeIdOf(runtime));
  return found === undefined ? true : found.capabilities[operation];
}

/** 项目的维护者用的运行时：没写照转来的任务的，再没有是 pi */
export function projectRuntime(project: Pick<Project, "runtime" | "fromTaskId">, tasks: Readonly<Record<string, Pick<Task, "runtime">>>): string {
  return runtimeIdOf(project.runtime ?? (project.fromTaskId === undefined ? undefined : tasks[project.fromTaskId]?.runtime));
}

/** 会话的维护者用的运行时（秘书、不认得的是 pi） */
export function conversationRuntime(state: { tasks: Readonly<Record<string, Task>>; projects: Readonly<Record<string, Project>> }, conversation: string): string {
  if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return PI_RUNTIME_ID;
  const maintainerId = conversation.slice(MAINTAINER_CHANNEL_PREFIX.length);
  const project = Object.values(state.projects).find((p) => p.maintainerId === maintainerId);
  if (project) return projectRuntime(project, state.tasks);
  return runtimeIdOf(Object.values(state.tasks).find((task) => task.maintainerId === maintainerId)?.runtime);
}

/** 新建项目、任务时能选的运行时（现在能用的）；只有一个（只有 pi）时不显示这一项，是空的 */
export function runtimeChoices(runtimes: readonly AgentRuntimeView[] | undefined): Array<{ id: string; title: string }> {
  const usable = selectableRuntimes(runtimes).map((r) => ({ id: r.id, title: r.title }));
  return usable.length > 1 ? usable : [];
}

/** 卡上标的运行时名字：默认的 pi 不标（undefined） */
export function runtimeChipText(runtimes: readonly AgentRuntimeView[] | undefined, runtime: string | undefined): string | undefined {
  return runtimeShown(runtime) ? runtimeTitleOf(runtimes, runtime) : undefined;
}

/** ⚙ 里显不显示运行时一块：用的不是 pi、在换、或者除了 pi 还有能用的（只有 pi 时和以前一样不显示） */
export function runtimeBlockShown(runtimes: readonly AgentRuntimeView[] | undefined, state: AgentRuntimeStateView | undefined): boolean {
  if (state === undefined) return false;
  return state.id !== PI_RUNTIME_ID || state.switching !== undefined || runtimeChoices(runtimes).length > 0;
}

/** ⚙ 里"换运行时"能选的：现在能用的，加上现在用的那个（插件停用了也列着，看得出现在是它） */
export function runtimeOptionsFor(runtimes: readonly AgentRuntimeView[] | undefined, current: AgentRuntimeStateView): Array<{ id: string; title: string; disabled: boolean }> {
  const list = (runtimes ?? []).filter((r) => r.available || r.id === current.id).map((r) => ({ id: r.id, title: r.title, disabled: !r.available && r.id !== current.id }));
  return list.some((r) => r.id === current.id) ? list : [{ id: current.id, title: current.title, disabled: false }, ...list];
}

/** ⚙ 里运行时一块的说明：在换（等手头这一条做完、原来的在写交接摘要）、现在用的不能用；都没有是 undefined */
export function runtimeStateLine(state: AgentRuntimeStateView): string | undefined {
  if (state.switching) {
    return state.switching.state === "handoff"
      ? t("state.runtimes.switchHandoff", { to: state.switching.title, from: state.title })
      : t("state.runtimes.switchWaiting", { to: state.switching.title });
  }
  return state.unavailable;
}

/**
 * 撤回的确认框里按运行时多说的（293 号票：能力清单 branch_summary、rewind_files）：分支摘要不是运行时自己写的（Claude Code：从这条之前另起一个会话接着，
 * 摘要由二狗按自己记下的写）；撤回时运行时会把它改过的文件恢复到这条之前（只追它的 Write、Edit，Bash 改的追不到）——撤回到阶段、步骤开始前
 * （callPoint）时不恢复（检查点只按整条输入记）。pi（自己写摘要、不动文件）什么都不多说。restoresFiles：这次撤回会恢复文件（"做了的事"下面的说明跟着换）
 */
export function rollbackRuntimeNotes(
  runtimes: readonly AgentRuntimeView[] | undefined,
  runtime: string,
  callPoint: boolean,
): { lines: string[]; restoresFiles: boolean; runtimeTitle: string } {
  const runtimeTitle = runtimeTitleOf(runtimes, runtime);
  const lines: string[] = [];
  if (!runtimeSupports(runtimes, runtime, "branch_summary")) lines.push(t("state.runtimes.rollbackForks", { runtime: runtimeTitle }));
  const rewinds = runtimeSupports(runtimes, runtime, "rewind_files");
  if (rewinds) lines.push(callPoint ? t("state.runtimes.rollbackNoFilesAtCall", { runtime: runtimeTitle }) : t("state.runtimes.rollbackFiles", { runtime: runtimeTitle }));
  return { lines, restoresFiles: rewinds && !callPoint, runtimeTitle };
}

/** 文件名太长时列出的个数 */
const FILES_SHOWN = 3;

/**
 * 分支摘要上记的运行时恢复文件的结果（293 号票，BranchSummaryPart.files）说成一句：恢复了哪些（只写文件名，最多列三个）、没有要恢复的、
 * 撤回到阶段步骤开始前没恢复、出错了（恢复了一部分的照列）；都带上"Bash 改的追不到"
 */
export function branchFilesLine(files: BranchFilesRewind): string {
  if (files.skipped === "call_point") return t("state.runtimes.filesSkipped");
  const names = files.restored.map((f) => f.split(/[\\/]/).at(-1) ?? f);
  const shown = names.length > FILES_SHOWN ? t("state.runtimes.filesMore", { files: names.slice(0, FILES_SHOWN).join(t("state.runtimes.filesSep")), count: names.length }) : names.join(t("state.runtimes.filesSep"));
  if (files.error !== undefined) return names.length > 0 ? t("state.runtimes.filesPartly", { files: shown, error: files.error }) : t("state.runtimes.filesFailed", { error: files.error });
  return names.length > 0 ? t("state.runtimes.filesRestored", { files: shown }) : t("state.runtimes.filesNone");
}

/** 一个设置项现在选的（没选是默认那个） */
export const runtimeSettingValue = (setting: RuntimeSettingView, state: AgentRuntimeStateView): string => state.settings[setting.id] ?? setting.default;
