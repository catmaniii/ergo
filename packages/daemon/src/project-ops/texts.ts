// 秘书调使用中的项目的操作（260 号票；268 号票补齐）的说法：编排在 tool.ts、check-tool.ts，只给结构化的数据，文字都在这里。
// 给秘书、维护者的（工具说明、参数说明、工具结果）照旧中文；给用户看的（工具名、时间线、转运营检查清单那一项）走 t()。
import { forModel, PROJECT_STATE_LABEL, type Project, type ProjectServiceView, serviceLine, t } from "@ergo/protocol";
import { SWITCH_SERVICES_TOOL } from "../project-services/tool-names.ts";
import { oneLine } from "../util/text.ts";
import type { OpsCheck, OpsChecklistView } from "./registry.ts";
import { paramLines } from "./args.ts";
import { BUILTIN_OP_NAMES } from "./builtin.ts";
import type { OpKind, OpRisk, ProjectOp } from "./manifest.ts";
import { type OpsMsg, problemForModel, problemText } from "./problems.ts";
import { CHECK_OPS_TOOL, PROJECT_OPS_TOOL } from "./tool-names.ts";

/** 交给秘书的附件最多多少字（更长的截掉、说明还剩多少） */
export const MAX_RESULT_CHARS = 12_000;

const projectRef = (p: Pick<Project, "id" | "name">) => `${p.id}「${p.name}」`; // @i18n-ignore model

export const toolTitle = () => t("projectOps.tool.title");
export const checkToolTitle = () => t("projectOps.checkTool.title");

// @i18n-ignore-start model：工具说明、参数说明、交给秘书和维护者的工具结果

/** 三种操作的说法 */
export const KIND_TEXT: Readonly<Record<OpKind, string>> = { query: "只读查询", action: "有副作用的动作", run: "触发一次运行" };

/** 风险标记的说法（只记不做） */
export const RISK_TEXT: Readonly<Record<OpRisk, string>> = { direct: "直接做", confirm: "要确认", handoff: "交给我做" };

/** 实现方式的说法 */
const IMPL_TEXT = { http: "项目服务的本机调用口", script: "工作目录里的脚本", ergo: "二狗自带动作", maintainer: "转给维护者当工单" } as const;

export const PROJECT_OPS_DESCRIPTION = [
  "使用中的项目（转入使用、在运营的）对外的操作：用户要查某个项目的数据、让它做一件事、改它的设置、看它跑得怎样（“记一笔午饭 32 块”“简报站今天抓了几条”“日报改成 7 点”）时用。",
  "三个动作：list 列出使用中的项目和各自的操作（不写 project 列全部）；describe 看一个操作的完整说明和参数；call 调用它，args 照 describe 给的参数写。",
  "每个使用中的项目都有一组通用操作（状态、最近运行、最新交付件、立即跑一次、暂停恢复、改时间、跟维护者说一句），项目自己的操作写在它的运营接口清单里。",
  "不知道有哪些操作先 list，拿不准参数先 describe；参数不对时不发出去，结果里退回这个操作的说明，照它改了再调。使用中的项目调操作不用问用户确认，用户说了就调。",
  "结果里“能念的一句”就是告诉用户的话（语音时直接念它），附件是细节，用户问再说。调不了的结果里写着原因，照实告诉用户，别说已经做了。",
].join("");

export const PROJECT_OPS_PARAMS = {
  action: "list 列出使用中的项目和操作；describe 看一个操作的说明和参数；call 调用一个操作",
  project: "项目的编号（p-1）或名字（describe、call 要写；list 不写就列全部）",
  op: "操作名（describe、call 要写，照 list 列出的写）",
  args: "call 时操作的参数（对象，照 describe 给的参数写；枚举可以写值也可以写中文名，没写的有默认值的自动补上；没有参数就不写）",
  why: "call 时一句为什么（时间线上看得到）",
} as const;

/** 参数没写全 */
export const needParam = (action: string, param: "project" | "op") =>
  param === "project" ? `${action} 要写 project（项目的编号或名字）。不知道有哪些项目先用 ${PROJECT_OPS_TOOL} 的 list。` : `${action} 要写 op（操作名）。不知道有哪些操作先用 ${PROJECT_OPS_TOOL} 的 list。`;

/** 现在使用中的项目（找不到项目时列给秘书） */
export const inUseHint = (inUse: readonly Project[]) => (inUse.length > 0 ? `现在使用中的项目：${inUse.map(projectRef).join("、")}` : "现在没有使用中的项目");

/** 不是使用中的 */
export const notInUse = (p: Project) =>
  `项目「${p.name}」现在是${forModel(() => PROJECT_STATE_LABEL[p.state])}，不是使用中的，调不了它的操作（只有使用中的项目能调）。`;

/** 清单的几种问题（项目自己的操作用不了；通用操作照样能用） */
export const manifestText = {
  missing: (p: Pick<Project, "name">) => `项目「${p.name}」还没交运营接口清单（档案里没有 ops.json），只有通用操作。要它自己的操作得让维护者把操作写进 ops.json。`,
  unreadable: (p: Pick<Project, "name">, m: OpsMsg) => `项目「${p.name}」档案里的运营接口清单读不了：${problemForModel(m)}`,
  notRegistered: (p: Pick<Project, "name">) => `项目「${p.name}」的运营接口清单还没有验收过的版本，只有通用操作。`,
  empty: (p: Pick<Project, "name">, version: number) => `项目「${p.name}」的运营接口清单第 ${version} 版里没有项目自己的操作，只有通用操作。`,
};

/** 档案里新改的那份没用上：验收没过（原因）、还在等服务上线 */
export function pendingText(p: Pick<Project, "name">, check: OpsCheck | undefined, version: number | undefined): string {
  const still = version === undefined ? "现在只有通用操作" : `秘书照旧用第 ${version} 版`;
  if (!check) return `项目「${p.name}」档案里的运营接口清单改过了，还没验收；${still}。`;
  if (check.outcome === "waiting") return `项目「${p.name}」档案里的运营接口清单格式对、能跑的测试都过了，项目服务的操作要等服务在跑时才能测；${still}。`;
  return `项目「${p.name}」档案里的运营接口清单改过了，验收没过：${check.problems.map(problemForModel).join("；")}。${still}；让维护者修好后用 ${CHECK_OPS_TOOL} 重新验收。`;
}

/** 操作不存在 */
export const opMissing = (p: Pick<Project, "name">, op: string, ops: readonly ProjectOp[]) =>
  `项目「${p.name}」没有操作「${op}」。它有：${[...ops.map((o) => o.name), ...BUILTIN_OP_NAMES].join("、")}（op 照这个写）。`;

/** 调用口对不上服务 */
export const endpointUnmatched = (p: Pick<Project, "name">, m: OpsMsg) => `项目「${p.name}」的调用口对不上服务：${problemForModel(m)}`;

/** 服务现在调不了（257 关着、还没上线、上线失败、要你手动） */
export const serviceBlocked = {
  closed: (p: Pick<Project, "name">) =>
    `项目「${p.name}」的服务关着（用户点了“关闭”，或者让你关的），调不了它的服务上的操作。告诉用户它关着；用户要用，先用 ${SWITCH_SERVICES_TOOL} 把它启动起来再调。`,
  pending: (p: Pick<Project, "name">) => `项目「${p.name}」的服务还在上线（LSM 在登记、启动），等它上线了再调。`,
  failed: (p: Pick<Project, "name">, reason: string | undefined) =>
    `项目「${p.name}」的服务上线失败${reason ? `：${reason}` : ""}。调不了它的服务上的操作；维护者已经收到通知，照实告诉用户。`,
  manual: (p: Pick<Project, "name">, reason: string | undefined) => `项目「${p.name}」的服务现在要用户手动上线${reason ? `：${reason}` : ""}。调不了它的服务上的操作，照实告诉用户。`,
};

/** 一个操作的种类、风险标记（风险标记只显示） */
const tags = (op: ProjectOp) => [KIND_TEXT[op.kind], ...(op.risk ? [RISK_TEXT[op.risk]] : [])].join(" · ");

/** 一个操作的一行（list）：名字、中文标题、种类和风险标记、说明的第一句 */
const opLine = (op: ProjectOp) => {
  const gist = /^[^\n。！？!?]*[。！？!?]?/.exec(op.description.trim())?.[0] ?? "";
  return `- ${op.name}${op.title ? `「${op.title}」` : ""}（${tags(op)}）${gist ? `：${oneLine(gist, 80)}` : ""}`;
};

/** list 里一个项目那一段 */
export interface ListedProject {
  project: Project;
  /** 登记着的版本和它的操作 */
  version?: number;
  ops: readonly ProjectOp[];
  /** 调用口在哪个服务上（有 http 的操作才有）：服务现在的样子，或者对不上的原因 */
  service?: ProjectServiceView | OpsMsg;
  /** 档案里的清单为什么没用上（没交、读不了、新改的验收没过 / 在等） */
  note?: string;
}

const serviceNote = (service: ProjectServiceView | OpsMsg) => ("code" in service ? `调用口对不上服务：${problemForModel(service)}` : `调用口在${forModel(() => serviceLine(service))}`);

/** 通用操作的目录（list 开头写一次） */
const builtinCatalog = (ops: readonly ProjectOp[]) => `每个使用中的项目都有的通用操作（op 照写）：${ops.map((o) => `${o.name}「${o.title}」`).join("、")}。`;

export function listText(listed: readonly ListedProject[], builtins: readonly ProjectOp[]): string {
  if (listed.length === 0) return "现在没有使用中的项目，没有能调的操作。";
  const sections = listed.map((entry) => {
    const head = `项目 ${projectRef(entry.project)}${entry.version !== undefined ? `（运营接口清单第 ${entry.version} 版${entry.service ? `；${serviceNote(entry.service)}` : ""}）` : ""}：`;
    const lines = entry.ops.map(opLine);
    const tail = entry.note ? [entry.note] : [];
    if (lines.length === 0 && tail.length === 0) return `${head}${entry.version !== undefined ? manifestText.empty(entry.project, entry.version) : manifestText.notRegistered(entry.project)}`;
    return [head, ...lines, ...tail].join("\n");
  });
  return [`使用中的项目和它们的操作（拿不准参数先用 ${PROJECT_OPS_TOOL} 的 describe 看说明）：`, builtinCatalog(builtins), ...sections].join("\n");
}

/** describe：一个操作的完整说明、参数、返回、实现方式、用法说明、怎么调 */
export function describeText(project: Project, op: ProjectOp, where: { version?: number; builtin: boolean; service?: ProjectServiceView | OpsMsg }): string {
  const from = where.builtin ? "通用操作" : `运营接口清单第 ${where.version ?? "?"} 版`;
  const params = paramLines(op.inputSchema);
  return [
    `项目 ${project.id}「${project.name}」的操作 ${op.name}${op.title ? `「${op.title}」` : ""}（${tags(op)}；${from}）`,
    `说明：${op.description.trim() || "（清单里没写说明）"}`,
    ...(op.userSays.length > 0 ? [`用户可能这么说：${op.userSays.map((s) => `“${s}”`).join("、")}`] : []),
    params.length > 0 ? "参数：" : "参数：没有",
    ...params,
    ...(params.length > 0 ? ["参数的 JSON Schema：", JSON.stringify(op.inputSchema, null, 2)] : []),
    ...(op.returns ? [`返回：${op.returns}`] : []),
    `实现方式：${IMPL_TEXT[op.impl.type]}${op.impl.type === "ergo" && !where.builtin ? `（${op.impl.action}）` : ""}${op.kind === "run" ? "；调了就开始跑，不等跑完" : ""}`,
    ...(op.risk ? [`风险标记：${RISK_TEXT[op.risk]}（现在只显示，使用中的项目调操作不用确认）`] : []),
    ...(op.usage ? [`用法说明：${op.usage}`] : []),
    ...(where.service ? [serviceNote(where.service)] : []),
    `调的时候：${PROJECT_OPS_TOOL}，action 写 call，project 写 ${project.id}，op 写 ${op.name}，args 照上面的参数写。`,
  ].join("\n");
}

/** 附件（太长的截掉） */
const bodyText = (text: string) => {
  const trimmed = text.trim();
  if (trimmed === "") return forModel(() => t("projectOps.resultEmpty"));
  return trimmed.length > MAX_RESULT_CHARS ? `${trimmed.slice(0, MAX_RESULT_CHARS)}\n（后面还有 ${trimmed.length - MAX_RESULT_CHARS} 字没列出）` : trimmed;
};

/** 能念的那句（二狗补的写明） */
const sayLine = (say: string, filled: boolean) => `能念的一句${filled ? "（实现没给，二狗按结果补的）" : ""}：${say}`;

/** 参数不对，没发出去 */
export const argsRejected = (project: Project, op: ProjectOp, problems: readonly string[], describe: string) =>
  [`项目「${project.name}」的操作 ${op.name} 参数不对，没发出去：`, ...problems.map((p) => `- ${p}`), "这个操作的说明（照它改了再调）：", describe].join("\n");

/** call 的结果 */
export const callText = {
  done: (p: Pick<Project, "name">, op: ProjectOp, version: string, say: string, filled: boolean, detail: string) =>
    [`项目「${p.name}」的操作 ${op.name}（${version}）做好了。`, sayLine(say, filled), "附件（细节，用户问再说）：", bodyText(detail)].join("\n"),
  /** 实现回了，但说出错了（HTTP 4xx / 5xx、isError、脚本退出码不是 0、动作做不了）：附上这个操作的说明 */
  failed: (project: Project, op: ProjectOp, status: number | undefined, say: string, filled: boolean, detail: string, describe: string) =>
    [
      `项目「${project.name}」的操作 ${op.name} 没做成${status !== undefined && (status < 200 || status >= 300) ? `（HTTP ${status}）` : ""}。`,
      sayLine(say, filled),
      "实现回：",
      bodyText(detail),
      "这个操作的说明（参数不对的照它改了再调；别的原因照实告诉用户）：",
      describe,
    ].join("\n"),
  refused: (p: Pick<Project, "name">, op: ProjectOp, where: string, service: ProjectServiceView | undefined) =>
    `项目「${p.name}」的操作 ${op.name} 没做成：${where}${service ? `。${forModel(() => serviceLine(service))}` : ""}。服务没在跑、或者还没开调用口，照实告诉用户（服务挂了维护者会收到通知）。`,
  timeout: (p: Pick<Project, "name">, op: ProjectOp, waited: string, service: ProjectServiceView | undefined) =>
    `项目「${p.name}」的操作 ${op.name} 没做成：${waited}${service ? `。${forModel(() => serviceLine(service))}` : ""}。它可能还在做，别马上重调有副作用的操作；照实告诉用户。`,
  aborted: (p: Pick<Project, "name">, op: ProjectOp) => `项目「${p.name}」的操作 ${op.name} 这次调用被中止了，不知道那边做没做。`,
};

// ───────────────────────── 维护者的 check_ops ─────────────────────────

export const CHECK_OPS_DESCRIPTION =
  "验收这个项目的运营接口清单（档案里的 ops.json）：格式对（每个操作写了中文标题、什么时候用、用户可能怎么说、种类、参数、一条测试）、每个操作的测试照 test.args 跑一遍" +
  "（带测试标记，有副作用的不要真改东西）、要回能念的 say、只读查询前后项目档案和工作目录里不能有文件改动。改了 ops.json 就用它看过没过；" +
  "使用中的项目全过了登记成新的一版（版本号加一，秘书马上用新的），没过的秘书照旧用上一版。建设中的项目转运营检查清单也看它。";

/** 验收的结果写给维护者看 */
export function checkReport(input: { project: Project; check: OpsCheck | undefined; missing?: boolean; unreadable?: OpsMsg; registered?: number; registeredNow: boolean }): string {
  const { project, check } = input;
  if (input.missing) return `项目「${project.name}」的档案里没有 ops.json。照档案里的模板写，再用 ${CHECK_OPS_TOOL} 验收。`;
  if (input.unreadable) return `ops.json 读不了：${problemForModel(input.unreadable)}`;
  if (!check) return "没有验收结果。";
  const head =
    check.outcome === "passed"
      ? `验收全过：${check.ops.length} 个操作的测试都跑通了、都回了能念的 say，只读的没写东西。${input.registeredNow ? `登记成第 ${input.registered} 版，秘书马上用它。` : project.state === "in_use" ? `和登记着的第 ${input.registered ?? "?"} 版内容一样。` : "转入使用时登记。"}`
      : check.outcome === "waiting"
        ? `格式对、能跑的测试都过了；项目服务上的 ${check.ops.filter((o) => o.result === "waiting").length} 个操作要服务在跑时才能测（${project.state === "in_use" ? "服务起来以后再验一次" : "转入使用、服务上线后秘书第一次用到时再验，过了登记"}）。`
        : `验收没过（${check.problems.length} 处）：\n${check.problems.map((p) => `- ${problemForModel(p)}`).join("\n")}${input.registered !== undefined ? `\n秘书照旧用第 ${input.registered} 版。` : ""}`;
  const ops = check.ops.map((o) => `- ${o.name}：${o.result === "passed" ? "过了" : o.result === "waiting" ? "等服务" : "没过"}${o.say ? `（说：${o.say}）` : ""}${o.note && o.result !== "failed" ? `；${problemForModel(o.note)}` : ""}`);
  const warnings = check.warnings.map((w) => `- ${problemForModel(w)}`);
  return [head, ...(ops.length > 0 ? ["每个操作的测试：", ...ops] : []), ...(warnings.length > 0 ? ["提醒（不挡验收）：", ...warnings] : [])].join("\n");
}

/** 使用中的项目自动验收没过：告诉维护者 */
export const notifyText = (project: Project, check: OpsCheck, version: number | undefined) =>
  `项目「${project.name}」档案里的运营接口清单（ops.json）改过之后，秘书用到时验收没过：\n${check.problems.map((p) => `- ${problemForModel(p)}`).join("\n")}\n${version === undefined ? "秘书现在只能用通用操作" : `秘书照旧用第 ${version} 版`}。修好后用 ${CHECK_OPS_TOOL} 重新验收。`;
// @i18n-ignore-end

// ───────────────────────── 时间线（给用户） ─────────────────────────

/** 参数写成一段（时间线明细里用擦过密钥的这一份） */
const argsText = (args: Readonly<Record<string, unknown>>) => (Object.keys(args).length === 0 ? t("projectOps.noArgs") : JSON.stringify(args));

const resultText = (text: string) => text.trim() || t("projectOps.resultEmpty");

/** 时间线上的一句话：调到了 / 没做成，带着能念的那句 */
export const timelineSummary = (ok: boolean, projectName: string, op: string, say: string) =>
  t(ok ? "projectOps.timeline.done" : "projectOps.timeline.failed", { project: projectName, op, result: oneLine(resultText(say), 60) });

/** 时间线上的明细：用的第几版、参数、为什么、能念的那句、附件 */
export const timelineDetail = (input: { version: number | null; args: Readonly<Record<string, unknown>>; why?: string; ok: boolean; say: string; sayFilled: boolean; result: string }) =>
  [
    input.version === null ? t("projectOps.timeline.detail.builtin") : t("projectOps.timeline.detail.version", { version: input.version }),
    t("projectOps.timeline.detail.args", { args: argsText(input.args) }),
    ...(input.why === undefined ? [] : [t("projectOps.timeline.detail.why", { why: input.why })]),
    t(input.sayFilled ? "projectOps.timeline.detail.sayFilled" : "projectOps.timeline.detail.say", { say: input.say }),
    t(input.ok ? "projectOps.timeline.detail.result" : "projectOps.timeline.detail.resultFailed", { result: resultText(input.result) }),
  ].join("\n");

// ───────────────────────── 转运营检查清单那一项（给用户） ─────────────────────────

/** 清单那一项写什么（standard.ts 拿它做 ops 那一项）：做到没有、差什么 */
export function checklistDetail(view: OpsChecklistView): { done: boolean; detail: string } {
  switch (view.state) {
    case "missing":
      return { done: false, detail: t("projects.standard.check.opsMissing") };
    case "template":
      return { done: false, detail: t("projects.standard.check.opsTemplate") };
    case "failed":
      return { done: false, detail: t("projectOps.check.failed", { count: view.problems.length, first: view.problems[0] ? problemText(view.problems[0]) : "" }) };
    case "checking":
      return { done: false, detail: t("projectOps.check.checking", { count: view.count }) };
    case "waiting":
      return { done: true, detail: t("projectOps.check.waiting", { count: view.count, waiting: view.waiting }) };
    case "passed":
      return { done: true, detail: t("projectOps.check.passed", { count: view.count }) };
  }
}
