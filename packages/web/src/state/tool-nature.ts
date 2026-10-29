// 工具调用"做了什么性质的事"：只看、动手、删改。
// 要点层、全局层的工具色块按它分深浅：只看是浅绿，动手是绿，删改是绿加一圈红描边（54 号票，缩放）。
// 最重的一档不只是删除，是删改，按"动没动原来就有的东西"分（用户 2026-10-09 定）：局部改或整个覆盖已有的文件、
// 删除、移动或改名、丢弃 git 改动、改写 git 历史、删分支和标签、强推都算。
// 没执行的调用（被拦下、你拒绝了）按只看画，免得一条没发生的删改显示成红圈。
// 一组调用取组里最重的（成员里有删改就是删改，有动手就是动手，否则只看）。
//
// 用户 2026-10-09 定：由守护进程判定，记在每次工具调用上（工具调用 part 的 nature，daemon/src/guard/nature.ts：按守卫的工具注册表
// 和这次判定实际要判的调用定）。54 号票之前的记录、守卫判定出错的没有这个字段，退回按工具名估：
// - 删改：改文件（edit）、命中"删除或覆盖"类别（整个覆盖已有的文件、删除、移动……都命中它）、工具名像删除
//   （/delete|remove/）、改提醒、取消提醒、自行调整计划、写回进展、带类型的推送给了 force=true；
// - 只看：在只看的工具名单里的；
// - 其余算动手（通用 bash 不拆，一律动手）。
import { type MessagePart, TOOL_NATURE_LABEL, TOOL_NATURES, type ToolNature } from "./protocol.ts";
import type { ChatItem } from "./chat-items.ts";

export { TOOL_NATURE_LABEL, TOOL_NATURES, type ToolNature };

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/**
 * 只看的工具（没有 nature 的旧记录按它估）：pi 自带的读文件、列目录、搜索内容、查找文件，带类型的 git 状态和差异，
 * 查看板、列出待我处理、读附件、检索素材、读素材（166 号票）、读项目档案、汇总回执、联网搜索、读网页（70 号票）。名字照守护进程的工具注册表里登记成只看（nature: "look"）的那些
 */
const LOOK_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "grep",
  "find",
  "git_status_diff",
  "view_board",
  "list_inbox",
  "read_attachment",
  "search_materials",
  "read_material",
  "read_project_records",
  "summarize_receipts",
  "web_search",
  "web_fetch",
]);

/** 删改的工具（旧记录按它估）：改文件，以及守护进程的工具注册表里登记成删改（nature: "modify"）的那些 */
const MODIFY_TOOLS: ReadonlySet<string> = new Set(["edit", "update_reminder", "cancel_reminder", "archive_reminder", "revise_plan", "write_progress"]);

/** 工具名像删除 */
const DELETE_NAME = /delete|remove/i;

/** 内置关注类别"删除或覆盖"的 id（173 号票起工具调用记录带类别 id，categories） */
const DELETE_CATEGORY_ID = "delete_or_overwrite";
/**
 * 173 号票之前的记录只有类别的显示名（那时都是中文）：认"删除或覆盖"开头的。这个分支只给没有 nature 的旧记录（54 号票之前）用，
 * 173 号票起新记的都有 nature 和 categories，不认字
 */
const LEGACY_DELETE_CATEGORY = "删除或覆盖"; // @i18n-ignore data：认旧记录里存下的中文类别名

/** 命中了"删除或覆盖"：有类别 id 的看 id，旧记录看存下的中文名 */
const hitsDeleteCategory = (part: ToolCallPart) => (part.categories ? part.categories.includes(DELETE_CATEGORY_ID) : part.categoryTitles.some((c) => c.startsWith(LEGACY_DELETE_CATEGORY)));

/** 带类型的推送给了 force（参数摘要是 `remote=… branch=… force=true`，guard-runtime/describe.ts 的 summarizeArgs） */
const FORCE_PUSH = /(?:^|\s)force=true(?:\s|$)/;

/** 没执行的调用：被拦下、你拒绝了 */
const NOT_EXECUTED: ReadonlySet<ToolCallPart["outcome"]> = new Set(["blocked", "denied"]);

/** 一次调用画成什么性质：没执行的按只看画；守护进程记了就用它的；旧记录按工具名估 */
export function toolNatureOf(part: ToolCallPart): ToolNature {
  if (NOT_EXECUTED.has(part.outcome)) return "look";
  if (part.nature) return part.nature;
  if (
    MODIFY_TOOLS.has(part.tool) ||
    DELETE_NAME.test(part.tool) ||
    hitsDeleteCategory(part) ||
    (part.tool === "git_push" && FORCE_PUSH.test(part.argsSummary))
  )
    return "modify";
  return LOOK_TOOLS.has(part.tool) ? "look" : "act";
}

const RANK: Readonly<Record<ToolNature, number>> = { look: 0, act: 1, modify: 2 };

/** 一条的性质：只有工具调用组、调用记忆（187 号票，都是只看）有，取里面的调用里最重的（删改 > 动手 > 只看）；别的条目没有 */
export function chatItemNature(item: ChatItem): ToolNature | undefined {
  if (item.kind !== "tool_group" && item.kind !== "recall") return undefined;
  let out: ToolNature | undefined;
  for (const call of item.calls) {
    const n = toolNatureOf(call.part);
    if (out === undefined || RANK[n] > RANK[out]) out = n;
  }
  return out;
}
