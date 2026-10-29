// 普通任务（75 号票，ADR 0025）：有任务卡、有自己的 agent，在后台用 agent loop 直接做——不规划、不授权、不检查。
// 这里只放普通任务自己的几样（纯函数和说法），编排在执行控制器（execution.ts：排队、名额、开始、一轮做完算完成、接着说）里：
// - 建出就排队（规划中、待确认都没有）：有名额就开始，交给 agent 的第一条输入就是任务书——用户或助理交代的那段话（plainBriefText）；
// - agent 这一轮正常结束、手上没有别的输入了，任务自动完成（completed），助理收到结果在对话里转告（99 号票起和别的任务一样由
//   secretary/task-done.ts 告诉它；项目内部的只收到一句做完了，internalPlainDoneNotice）；
//   出错、被打断的那一轮不算做完：任务转等我（卡住求助），用户在任务详情里回一句就接着做；
// - 做完了用户在任务详情里接着说（或者运行时交给它一条通知，比如事后批准了一次调用）：任务回到执行中（continued），接着做；
// - 守卫按普通对话那一套判（调用不属于任务：守卫看不到计划和授权，受 guard.conversationApprovals 管，默认关着：
//   它是任务的 agent，"先问我"的一律直接做、照常标出，101 号票；受保护区域、密钥的硬拒绝和"永不"照旧）。
// 执行的 agent：不涉及项目或涉及多个项目的，是任务自己的 agent（tm-<n>，maintainers/ 里的普通任务装配，工具包是 plainToolkit）；
// 只涉及一个项目的建成这个项目的内部任务（64 号票），由项目的维护者在一张执行的工单段里做（projects/maintainers.ts）。
// 172 号票：交给 agent、助理的话照旧中文（标 model，用到的时间说法也取中文）；会话里、待办里给人看的两句（plainStuckNote、plainDoneNote）按当时的语言写
import { describeTime, forModel, isProjectInternal, type MessageEnvelope, onceAt, type PlanToolkit, t, type Task } from "@ergo/protocol";
import { oneLine } from "../util/text.ts";

/**
 * 不属于项目的普通任务的 agent 的工具包（75 号票）：和维护者同一套装配——读写文件、bash、联网（联网搜索、读网页）都开着，
 * skill 用助理那一份（设置里的 skill 库页勾的，默认 agent-browser、yt-dlp：交出去的事多是"搜一下、下下来"这类），没有 MCP。
 * 项目内部的普通任务用项目的工具包（项目的维护者在这个项目里能用什么就是什么）
 */
export function plainToolkit(skills: readonly string[]): PlanToolkit {
  return { skills: [...skills], mcp: [], bash: true, network: true };
}

/** 交给 agent 的第一条输入的幂等键：一个普通任务只交一次（名额满了回到排队、再开始时不重交） */
export const plainBriefKey = (taskId: string) => `plain-brief:${taskId}`;

/**
 * 交给 agent 的任务书（第一条输入）：只有用户或助理交代的那段话。怎么做、做完怎么收尾（用一两句话说结果、项目内部的照常写回）
 * 只写在系统提示里（prompts/plain-task.md、project-plain.md），用户在设置里改了提示就跟着变，这里不另抄一份
 */
// @i18n-ignore-start model：交给 agent 的任务书、工单
export function plainBriefText(task: Task): string {
  return `普通任务 ${task.id}「${task.title}」${task.origin === "delegated" ? "（助理交给你的）" : ""}${onceAtNote(task)}：要做的事——\n${task.summary.trim()}`;
}

/** 执行的工单（项目内部的普通任务，第一张）的内容：放进固定上下文里的"这次的工单" */
export const plainOrderInstructions = (task: Task) => `普通任务 ${task.id}「${task.title}」${onceAtNote(task)}：直接做，不规划、不用计划卡。要做的事——\n${task.summary.trim()}`;

/** 某个时间做一次的（76 号票）：开始时写明它是定在什么时候做的（现在到点了） */
export function onceAtNote(task: Task): string {
  const at = onceAt(task);
  return at === undefined ? "" : `（定在 ${forModel(() => describeTime(new Date(at)))} 做的，现在到点了）`;
}

/** 续派的工单里原来交代的那段话只留个摘要（背景，不是这次要做的事） */
const BRIEF_GIST_CHARS = 200;

/**
 * 项目内部的普通任务做完之后用户在详情里接着说，续派的工单的内容（75 号票评审）：新的一段是新会话，任务书不会再交一遍，
 * 工单里要做的事就是用户这次说的；原来交代的只留摘要、连同上一轮的结果作为背景，写明做完了的不要重做（下载、写文件、发送这类
 * 有副作用的做过一遍了）
 */
export function plainContinueInstructions(task: Task, continuation: { said: readonly string[]; result: string | undefined }): string {
  const said = continuation.said.length > 0 ? continuation.said.map((line) => `「${oneLine(line, 600)}」`).join("\n") : "（他的话在这一段的输入里）";
  return [
    `接着做普通任务 ${task.id}「${task.title}」：用户在任务详情里说的——`,
    said,
    "只做他这次说的。上一轮已经做完的不要重做：下载、写文件、发送、提交这类做过的不要再做一遍；要用上一轮的产出，到工作目录和项目档案里找。",
    "背景（不是这次要做的事）：",
    `- 原来交代的：${oneLine(task.summary, BRIEF_GIST_CHARS)}`,
    `- 上一轮的结果：${continuation.result ?? "（没有留下说明）"}`,
  ].join("\n");
}

/** 暂停后继续、卡住后点"继续执行"：交给 agent 的话（被中止、出错的那一轮不会自己重来） */
export const PLAIN_RESUMED_TEXT = "任务继续了：上一轮被打断了，接着把没做完的事做完；做完了就用一两句话说结果。";
// @i18n-ignore-end

/** 出错、被打断的那一轮：任务转等我（卡住求助）的说明 */
export function plainStuckNote(outcome: "error" | "interrupted", error: string | undefined): string {
  const why = outcome === "error" ? (error ? t("tasks.plain.errorWhy", { error: oneLine(error, 200) }) : t("tasks.plain.error")) : t("tasks.plain.interrupted");
  return t("tasks.plain.stuck", { why });
}

/** 会话里给人看的说明：这一轮做完了，任务完成 */
export const plainDoneNote = () => t("tasks.plain.done");

/** agent 这一轮最后说的话（转告用户的那一句）：最近一条带文字的回复，压成一行、截短 */
export function plainResult(recentAgentMessages: readonly MessageEnvelope[]): string | undefined {
  for (const message of recentAgentMessages.toReversed()) {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
    if (text) return oneLine(text, 600);
  }
  return undefined;
}

// @i18n-ignore-start model：交给助理的通知、工具结果
/**
 * 项目内部的普通任务做完了：交给助理的通知（75 号票；ADR 0023：助理看不到细节），只说在哪个项目里做完了、结果在项目页的任务详情里，
 * 不带结果。不属于项目的普通任务做完和别的任务一样由 secretary/task-done.ts 告诉助理（99 号票：带着结果，问用户要不要念出来）
 */
export function internalPlainDoneNotice(task: Task): string {
  const project = task.internal?.projectName ?? "";
  return `项目「${project}」里交出去的一件事（项目内部的普通任务）做完了。你看不到它的细节：用一句话告诉用户做完了，结果在项目「${project}」的项目页里看。`;
}

/** 助理把一件事交出去之后（delegate_task 的结果）交回它的话：告诉用户一声，不用等 */
export function delegatedText(task: Task): string {
  const at = onceAt(task);
  const when = at === undefined ? "" : forModel(() => describeTime(new Date(at)));
  if (isProjectInternal(task)) {
    const project = task.internal?.projectName ?? "";
    return (
      `已交给项目「${project}」的维护者在后台做（项目内部的普通任务，只在项目里看得到，你看不到它的细节）${when ? `，等到 ${when} 才开始` : ""}。` +
      `告诉用户一声“已交给项目「${project}」${when ? `，${when} 去做` : "在后台去做"}，做完告诉你”，不用等它；做完了你会收到通知。`
    );
  }
  if (when) {
    return (
      `已交给后台：普通任务 ${task.id}「${task.title}」，有自己的 agent，在任务看板上（等时间）；到 ${when} 才开始做，做完就算完成。` +
      `告诉用户一声“好的，${when} 去做，做完告诉你”，不用等它、也不要现在自己先做；做完了你会收到一条通知，到时把结果转告用户。`
    );
  }
  return (
    `已交给后台：普通任务 ${task.id}「${task.title}」，有自己的 agent，在任务看板上。` +
    `告诉用户一声“已交给后台去做，做完告诉你”，不用等它、也不要自己再做一遍；做完了你会收到一条通知，到时把结果转告用户。`
  );
}
// @i18n-ignore-end
