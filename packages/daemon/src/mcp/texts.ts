// MCP 登记变更（239 号票）给人和模型看的话，都在这里组织（编排在 change.ts，只给结构化的数据）：
// 工具名、工具说明，卡上的说法（动作、是谁提的、命令、args、env、工具和标注、自检结果），待我处理里的标题和来源，
// 时间线上的一句话和明细，审批决定的说法，交给维护者的通知。
// 给用户看的（工具的名字、卡、待我处理、时间线、审批决定、自检结果）走 t()；给维护者的（工具说明、工具结果、通知）照旧中文。
import { type McpChangeAction, type McpChangeCardPayload, type McpChangeRegistration, type McpChangeSubmitter, type McpChangeToolView, type McpDecidedPayload, t } from "@ergo/protocol";

/** 几个名字之间 */
const listOf = (names: readonly string[]) => names.join(t("toolkit.listSep"));

/** 一个提交的人的叫法（"项目「X」的维护者"、"任务「T」的维护者"） */
export function whoText(submitter: McpChangeSubmitter): string {
  return submitter.kind === "project" ? t("mcp.change.who.project", { project: submitter.projectName }) : t("mcp.change.who.task", { task: submitter.taskTitle });
}

/** 动作的说法（"加"、"改"、"删"） */
export function actionText(action: McpChangeAction): string {
  if (action === "add") return t("mcp.change.action.add");
  if (action === "update") return t("mcp.change.action.update");
  return t("mcp.change.action.remove");
}

/** 一条登记说成一行（"加 MCP album"）：卡的标题、待我处理、时间线都用它 */
export const changeText = (action: McpChangeAction, name: string) => t("mcp.change.line", { action: actionText(action), name });

// ───────────────────────── 工具（给维护者） ─────────────────────────

export const requestMcpChangeTitle = () => t("mcp.tool.requestChange");
// @i18n-ignore-start model：工具说明和参数说明（给维护者）
export const requestMcpChangeDescription = [
  "把一条 MCP 登记加、改、删（action 是 add / update / remove）。你只提内容，运行时出一张“MCP 登记变更”卡放进用户的待我处理：",
  "用户在卡上点确认之后，运行时按 name 合并写进数据目录配置区的 mcp.json（别的登记不动），并顺手把这个 MCP 拉起来一次做自检；",
  "用户拒绝则什么都不改。你自己不要把登记写进 mcp.json，也不要让 bash 去改配置区：那是受保护区域，守卫会拦下并记下这次越界。",
  "env 里的密钥只写引用 { fromEnv: \"变量名\" }（运行时从自己的环境里按名字取，由 LSM 注入），不要写明文；明文会被拒。",
  "tools 写要暴露给模型、可以授权给维护者的工具：每个工具的中文名 title、说明、只读或幂等 readOnlyOrIdempotent、要不要联网 network（不写按要联网）、",
  "要不要授权给秘书当快速动作 quickAction（说法和固定的参数）。登记好之后要自己用上，还得让用户把这个 MCP 加进工具包（在任务里提交计划变更，不在任务里用 request_toolkit_change）。",
].join("");
export const REQUEST_MCP_CHANGE_PARAMS = {
  action: "add 加一条、update 改一条（按 name 换掉）、remove 删一条，都要用户确认",
  name: "MCP 的名字（字母、数字、- 和 _，和工具包、登记里写的是同一个）",
  title: "中文名（卡上、审批里用）",
  command: "要拉起的命令（比如 node）",
  args: "命令的参数（比如服务进程的脚本路径）",
  cwd: "服务进程的工作目录；不写用守护进程的临时区",
  timeoutMs: "单次调用、自检最多等多久（毫秒）；不写按工具调用的默认超时",
  env: "环境变量：原样的写字符串，凭据写 { fromEnv: \"变量名\" }",
  tools: "要暴露的工具：工具名 → { title, description, readOnlyOrIdempotent, network, quickAction }",
  why: "为什么要这么改（用户在卡上看得到）",
} as const;
// @i18n-ignore-end

/** 校验不过的原因连起来 */
export const problemsText = (problems: readonly string[]) => problems.join(t("toolkit.sep"));

/** 一条 MCP 已经登记了（add 时） */
export const alreadyRegisteredText = (name: string) => t("mcp.change.alreadyRegistered", { name });
/** 一条 MCP 没有登记（update、remove 时） */
export const notRegisteredText = (name: string) => t("mcp.change.notRegistered", { name });
/** 名字的格式不对 */
export const badNameText = (name: string) => t("mcp.change.badName", { name });
/** command 没写（或只有空白） */
export const missingCommandText = () => t("mcp.change.missingCommand");
/** 密钥写了明文 */
export const plaintextSecretText = (names: readonly string[]) => t("mcp.change.plaintextSecret", { names: listOf(names) });
/** 一个工具都没有 */
export const noToolsText = () => t("mcp.change.noTools");
/** 找不到提交的人（项目、任务被删了？） */
export const noSubmitterText = (target: string) => t("mcp.change.noSubmitter", { target });
// @i18n-ignore-start model：工具结果（给维护者）
export const requestedText = (payload: McpChangeCardPayload) =>
  `已提交“MCP 登记变更”卡：${changeText(payload.action, payload.name)}。用户确认之前 mcp.json 一个字节都不变；确认后运行时写进去并拉起这个 MCP 自检，拒绝会通知你。`;
export const cardWaitingText = (name: string, cardId: string) => `MCP ${name} 的上一张登记变更卡（${cardId}）还在等用户，先等它有结论再提。`;
export const notChangedText = (reason: string) => `没改成：${reason}`;
// @i18n-ignore-end

// ───────────────────────── 卡上 ─────────────────────────

/** 待我处理里的标题 */
export const inboxTitle = (payload: Pick<McpChangeCardPayload, "action" | "name" | "submitter">) =>
  t("mcp.change.inboxTitle", { who: whoText(payload.submitter), change: changeText(payload.action, payload.name) });
/** 待我处理里的来源 */
export const sourceOf = (submitter: McpChangeSubmitter) => t("mcp.change.source", { who: whoText(submitter) });

/** 一个工具在卡上的标注（只读或幂等、要联网、快速动作） */
export function toolMarks(tool: McpChangeToolView): string {
  const marks = [tool.readOnlyOrIdempotent === true ? t("mcp.change.mark.readOnly") : "", tool.network === false ? "" : t("mcp.change.mark.network"), tool.quickAction ? t("mcp.change.mark.quickAction", { title: tool.quickAction.title }) : ""];
  return marks.filter(Boolean).join(t("toolkit.listSep"));
}

/** env 在卡上的写法：凭据只写"来自环境变量 X"，原样的值照写（工具那边已经拒了明文的密钥） */
export function envLines(env: NonNullable<McpChangeRegistration["env"]>): Array<{ name: string; value: string; fromEnv: boolean }> {
  return Object.entries(env).map(([name, value]) => (typeof value === "string" ? { name, value, fromEnv: false } : { name, value: t("mcp.change.env.fromEnv", { variable: value.fromEnv }), fromEnv: true }));
}

/** 一份登记在卡上、时间线里的明细：命令、工作目录、env、工具和标注、超时 */
export function registrationLines(registration: McpChangeRegistration): string[] {
  const command = [registration.command, ...(registration.args ?? [])].join(" ");
  return [
    t("mcp.change.detail.command", { command }),
    ...(registration.cwd === undefined ? [] : [t("mcp.change.detail.cwd", { cwd: registration.cwd })]),
    ...(registration.timeoutMs === undefined ? [] : [t("mcp.change.detail.timeout", { seconds: Math.round(registration.timeoutMs / 1000) })]),
    ...(registration.env === undefined ? [] : [t("mcp.change.detail.env", { list: envLines(registration.env).map((e) => `${e.name}=${e.value}`).join(t("toolkit.listSep")) })]),
    t("mcp.change.detail.tools", {
      list: Object.entries(registration.tools)
        .map(([name, tool]) => {
          const marks = toolMarks(tool);
          return marks ? t("mcp.change.detail.toolWithMarks", { title: tool.title, name, marks }) : t("mcp.change.detail.tool", { title: tool.title, name });
        })
        .join(t("toolkit.listSep")),
    }),
  ];
}

/** 自检结果的一句话（卡的说明、时间线、审批决定都用它） */
export function checkText(check: { ok: boolean; tools: readonly string[]; problem?: string }): string {
  if (!check.ok) return t("mcp.change.check.failed", { problem: check.problem ?? t("mcp.change.check.unknown") });
  return t("mcp.change.check.passed", { tools: listOf(check.tools) });
}

/** 批准之后卡的处理结果 */
export const appliedNote = (name: string, check: { ok: boolean; tools: readonly string[]; problem?: string }) => t("mcp.change.appliedNote", { name, check: checkText(check) });
/** 拒绝之后卡的处理结果 */
export const deniedNote = (name: string) => t("mcp.change.deniedNote", { name });

/** "MCP 登记变更"卡的纯文本降级 */
export function cardText(payload: McpChangeCardPayload): string {
  const head = changeText(payload.action, payload.name);
  const body = payload.registration ? registrationLines(payload.registration).join("\n") : "";
  const check = payload.check ? `\n${checkText(payload.check)}` : "";
  return t("mcp.change.cardText", { who: whoText(payload.submitter), change: head, why: payload.why ?? "", body, check });
}

// ───────────────────────── 时间线、审批决定 ─────────────────────────

/** 时间线上的一句话：批准了什么、自检结果（拉起来了没有）；拒绝的写拒绝 */
export const timelineSummary = (p: Pick<McpDecidedPayload, "decision" | "action" | "name" | "submitter" | "check">) => {
  const head = t("mcp.change.timeline", { who: whoText(p.submitter), change: changeText(p.action, p.name), decision: p.decision === "approved" ? t("mcp.change.timeline.approved") : t("mcp.change.timeline.denied") });
  return p.check ? t("mcp.change.timeline.checked", { head, check: checkText(p.check) }) : head;
};

/** 时间线上的明细：登记的内容、自检结果、用户写的话 */
export function timelineDetail(p: McpDecidedPayload, registration: McpRegistrationLike | undefined): string {
  return [...(registration ? registrationLines(registration) : []), ...(p.check ? [checkText(p.check)] : []), ...(p.note ? [t("mcp.change.timeline.note", { note: p.note })] : [])].join("\n");
}

/** 登记的形状（文本生成用；守护进程那边的 McpServerRegistration 比它严，这里只要显示得到的几样） */
export type McpRegistrationLike = Pick<McpChangeRegistration, "command" | "args" | "cwd" | "env" | "tools" | "timeoutMs" | "title">;

/** 审批决定说成一句话（素材） */
export function decisionText(p: McpDecidedPayload): string {
  const whose = whoText(p.submitter);
  const change = changeText(p.action, p.name);
  if (p.decision === "denied") return t("mcp.decision.denied", { who: whose, change });
  return t("mcp.decision.approved", { who: whose, change, check: p.check ? checkText(p.check) : "" });
}

// ───────────────────────── 交给维护者的通知 ─────────────────────────

// @i18n-ignore-start model：交给维护者的通知
export const approvedNotice = (p: McpDecidedPayload) =>
  `用户批准了你的 MCP 登记变更：${changeText(p.action, p.name)}${p.check ? `，${checkText(p.check)}` : ""}。` +
  `${p.note ? `用户说：${p.note}。` : ""}登记已经在配置区的 mcp.json 里，下次装配会话时这个 MCP 的工具就在了（工具包里有它的话）。`;
export const deniedNotice = (p: McpDecidedPayload) =>
  `用户拒绝了你提的 MCP 登记变更：${changeText(p.action, p.name)}${p.note ? `：${p.note}` : ""}。mcp.json 不变，在现有的登记和工具包里接着做，做不了就告诉用户。`;
/** 登记变了、会话要按新的装配重新拉起时告诉维护者的那句（照工具包变更的"工具包已变更"） */
export const reassembledNotice = (name: string) => `MCP 的登记变了（${name}）：运行时按新的登记重新装配了你的会话，接着原来的对话干。`;
// @i18n-ignore-end
