// 删除项目时（66 号票，ADR-0010）找项目之外读过这个项目的东西的调用：秘书能读项目档案（读项目档案的工具、文件工具、bash），
// 涉及多个项目的任务自己的维护者用读项目档案的工具读各项目，它的评审子 agent 读各项目的档案和工作目录。这些调用没有这个项目的
// 归属，按"读的是不是这个项目的东西"找（这个项目自己的维护者会话里的不在这里找：deletion.ts 整条换成标记）：
// - 读项目档案的工具：按返回开头写的项目编号认（不按参数里的名字：删掉的项目的名字可以被新项目重用），哪个会话里的都算；
// - 参数里写着路径的工具（PATH_TOOLS），秘书会话里的和不在任何会话里的（评审子 agent 的）：调用碰到的路径和项目档案、
//   工作目录有包含关系就算，任一方向都算——读了上级目录、递归扫到项目里的也算（touches）。比的时候写的路径和它的真实路径
//   都看，经符号链接、目录联接读到的也算；带通配符的先展开，展不开的按通配符之前的那段目录。删除时项目档案还在（改写事件
//   之后才删），工作目录也在，真实路径和通配符都展得开；
// - 碰了哪些路径：调用时守卫规范化过的（效果日志里这次调用的记录：相对路径、~、通用 bash 的拆分都按调用时的），加上完整
//   参数里写死的绝对路径（通用 bash 照守卫的拆法拆开：没执行成功的也算，读了文件再以非零退出的 bash 返回里也有读到的）。
//   先只查视图：记了调用 id 的效果记录就够判断；没有的（没执行成功的、56 号票之前的）才逐条读完整内容，不把候选一次读进内存。
// 认不出的（命令里用环境变量拼出的路径、python -c 这类看不透的命令）不在里面，删除项目的二次确认上如实写着
// （协议包的 PROJECT_DELETE_LIMITS）。读别的项目、读项目外文件的调用不在里面。
import { CHANNELS, maintainerChannel, type Project, type ToolCallDetail } from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { absolutePathArgs, argEntriesOf, BUILTIN_TOOL_REGISTRY, type EffectRecord, findTool, isWithin, type ShellEnv, stepCalls, TOOL, unresolvedPath } from "../guard/index.ts";
import { effectsByCallId, effectsOfCall } from "../guard-runtime/effect-log.ts";
import { detailEventAt, detailRowsOf } from "../guard-runtime/tool-call-details.ts";
import { realPathOf } from "../util/real-path.ts";
import { expandWildcards } from "../util/wildcards.ts";
import { type ProjectRecordsPaths, projectWorkdir } from "./records.ts";
import { projectIdOfRecordsResult } from "./records-tool.ts";
import { READ_PROJECT_RECORDS_TOOL } from "./tool-names.ts";

export { expandWildcards } from "../util/wildcards.ts";

/** 参数里可能写着路径的工具：内置工具、带类型的 bash 工具、伪工具里登记了路径参数的，加上通用 bash（命令里的路径按守卫的拆法认） */
export const PATH_TOOLS: readonly string[] = [
  TOOL.bash,
  ...Object.values(BUILTIN_TOOL_REGISTRY)
    .filter((d) => Object.values(d.args).some((rule) => rule.kind === "path"))
    .map((d) => d.name),
];

/** 项目之外读过这个项目的调用的完整内容的事件（秘书会话里的、跨项目任务的维护者和评审子 agent 的），按全局序号 */
export function outsideReadsOf(store: EventStore, project: Project, records: ProjectRecordsPaths): StoredEvent[] {
  const dirs = projectDirs(project, records);
  const own = maintainerChannel(project.maintainerId);
  const found = new Map<number, StoredEvent>();
  /** 还没彻底删除过的才算（内容早就没了） */
  const keep = (event: StoredEvent | undefined) => {
    if (event && !(event.payload as ToolCallDetail).purged) found.set(event.globalSeq, event);
  };
  // 读项目档案的工具：逐条读，按返回开头的项目编号认
  for (const row of detailRowsOf(store, [READ_PROJECT_RECORDS_TOOL])) {
    if (row.conversation === own) continue;
    const event = detailEventAt(store, row.globalSeq);
    if (event && projectIdOfRecordsResult((event.payload as ToolCallDetail).result) === project.id) keep(event);
  }
  // 参数里写着路径的：先按效果日志里记的路径筛（只查视图），没有效果记录的再读完整内容
  for (const row of detailRowsOf(store, PATH_TOOLS, CHANNELS.secretary)) {
    const recorded = effectsByCallId(store.reader, row.callId, row.agentId);
    if (recorded.length > 0) {
      if (recorded.some((record) => pathsOfEffect(record).some((p) => touches(p, dirs)))) keep(detailEventAt(store, row.globalSeq));
      continue;
    }
    const event = detailEventAt(store, row.globalSeq);
    if (event && pathsOfCall(store, event).some((p) => touches(p, dirs))) keep(event);
  }
  return [...found.values()].toSorted((a, b) => a.globalSeq - b.globalSeq);
}

/** 事后不知道调用时的工作目录、主目录：完整参数里只认写死的绝对路径（相对路径、~ 开头的守卫认成没法确定） */
const UNKNOWN_PLACES: ShellEnv = { cwd: unresolvedPath("调用时的工作目录"), homeDir: unresolvedPath("调用时的主目录") }; // @i18n-ignore data：只用来认路径，不显示

/**
 * 一次调用碰到的路径（规范化后的绝对路径，还没展开真实路径和通配符）：调用时守卫规范化过的（效果日志里这次调用的记录，
 * 记了调用 id 的和之前紧跟着的旧记录），加上完整参数里写死的绝对路径（通用 bash 按守卫的拆法拆开）。
 * 哪些参数是路径按内置工具、带类型的 bash 工具、伪工具的登记认（取的时候调用时那份会话的注册表已经不在了）
 */
export function pathsOfCall(store: EventStore, event: StoredEvent): string[] {
  const detail = event.payload as ToolCallDetail;
  const paths = new Set<string>();
  const args = detail.args;
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    for (const call of stepCalls({ tool: detail.tool, args: args as Record<string, unknown> }, UNKNOWN_PLACES)) {
      for (const { path: p } of absolutePathArgs(call, BUILTIN_TOOL_REGISTRY, UNKNOWN_PLACES)) paths.add(p);
    }
  }
  if (detail.outcome === "done") for (const record of effectsOfCall(store, event)) for (const p of pathsOfEffect(record)) paths.add(p);
  return [...paths];
}

/** 一条效果记录里的路径（调用时规范化过的绝对路径；没法确定的不算） */
function pathsOfEffect(record: EffectRecord): string[] {
  const tool = findTool(BUILTIN_TOOL_REGISTRY, record.tool);
  if (!tool) return [];
  return argEntriesOf(tool, record.args, ["path"]).flatMap(([, value]) => (typeof value === "string" && value !== "" ? [value] : []));
}

/** 项目档案和工作目录（绑定了外部路径的是那个外部路径）：写的样子和真实路径都列上 */
function projectDirs(project: Project, records: ProjectRecordsPaths): string[] {
  return [records.root, projectWorkdir(records, project)].flatMap((dir) => [dir, realPathOf(dir) ?? dir]);
}

/**
 * 这个路径和项目档案、工作目录有包含关系：路径在目录里，或者目录在路径里（读了上级目录、递归扫到项目里）。
 * 写的路径和它的真实路径（展开符号链接、目录联接、8.3 短名）都比；带通配符的先展开
 */
function touches(p: string, dirs: readonly string[]): boolean {
  return expandWildcards(p).some((q) => {
    const real = realPathOf(q);
    return [q, ...(real === undefined ? [] : [real])].some((x) => dirs.some((d) => isWithin(x, d) || isWithin(d, x)));
  });
}

