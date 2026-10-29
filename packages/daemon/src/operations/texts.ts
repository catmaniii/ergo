// 运营方案（130 号票）的说法：维护者的工具说明和工具结果、被拒的原因、交给维护者的通知、时间线上的一笔、卡的纯文本降级。
// 编排（operations.ts、builtin-means.ts）里不写文字，都从这里取。
// 174 号票：给用户看的（卡的纯文本降级、时间线上的一笔、卡上确认时被拒的原因、一条的结局）走 t()，生成时按当时的语言；
// 给维护者（模型）看的（工具说明、工具结果、校验的问题、通知）照旧中文，标 @i18n-ignore model。
import {
  capabilitiesText,
  forModel,
  capabilityText,
  describeTime,
  OPERATION_APPROACH_LABEL,
  OPERATION_CHANGE_LABEL,
  OPERATION_OUTCOME_LABEL,
  operationLine,
  OPERATIONS_GRANT_TEXT,
  OPERATIONS_MANUAL_PREFIX,
  OPERATIONS_MAX,
  OPERATIONS_PUT_IN_USE_LABEL,
  type OperationItem,
  type OperationResult,
  type OperationsChangeCardPayload,
  type ToolkitCapability,
  type ToolkitShape,
  toolkitText,
  USER_WORDS_TITLE,
  userWordsLine,
  type VerifiedUserWords,
  t,
} from "@ergo/protocol";
import { REQUEST_TOOLKIT_CHANGE_TOOL } from "../toolkit/tool-names.ts";
import type { OperationMeans } from "./means.ts";
import { PROPOSE_OPERATIONS_TOOL } from "./tool-names.ts";

const NL = "\n";

/** 交给维护者的那几样都按中文写（174 号票）：对象里的每个函数包一层 forModel */
function inChinese<T extends Record<string, (...args: never[]) => string>>(texts: T): T {
  return Object.fromEntries(Object.entries(texts).map(([k, fn]) => [k, (...args: never[]) => forModel(() => fn(...args))])) as T;
}

/** 手段（builtin-means.ts）校验、生效时的说法 */
export const meansText = {
  // @i18n-ignore-start model：交给维护者的工单内容、校验的问题（维护者看）
  onFailure: (text: string) => `失败时：${text}`,
  noWorkflowPlan: (name: string) => `「${name}」是流程，却没有审查过的计划`,
  // @i18n-ignore-end
  /** 流程的授权记录上写的（用户看） */
  authorizedNote: () => t("operations.authorizedNote"),
  // @i18n-ignore-start model：校验的问题（交给维护者）
  needSchedule: "定时触发的要写 schedule（时间表）",
  scheduleNotEvent: "定时触发的不写 event（事件发生时做的用 means: event）",
  oncePassed: (at: string) => forModel(() => `定的时间 ${describeTime(new Date(at))} 已经过了：写一个将来的时间，或者写重复的时间表`),
  needEvent: "事件触发的要写 event（事件来源、事件、过滤）",
  eventNotSchedule: "事件触发的不写 schedule（按时间表做的用 means: schedule）",
  needManual: (label: string) => `「${label}」二狗现在还做不了：manual 里写清用户要手动做哪几步`,
  manualNoWorkflow: (label: string) => `「${label}」要用户手动，不能是流程（approach 不写或写 plain，不写 workflow）`,
  // @i18n-ignore-end
};

// @i18n-ignore-start model：工具说明、校验的问题（交给维护者）
/** 维护者的工具说明：有哪些手段按登记表现写 */
export function toolDescription(means: readonly OperationMeans[]): string {
  return forModel(() => toolDescriptionText(means));
}

function toolDescriptionText(means: readonly OperationMeans[]): string {
  const list = means.map((m) => `${m.id}（${m.label}${m.automatic ? "" : "，二狗现在还做不了、要用户手动"}）：${m.hint}`).join("；");
  return (
    `交出这个项目的运营方案：项目转入使用后怎么运转——每天定时出什么、什么事件发生时做什么……一次交完整的一份（之前交过的这次没写就算去掉）。用户在卡上确认一次就全部生效（确认就是授权，之后照方案跑，不再逐项问）：` +
    `定时、事件触发的每一条建成这个项目的内部任务，由你（项目的维护者）执行，到点或来事件时运行时派一张运行工单给你；` +
    `服务那一条（means: service，写 service）确认后由运行时交给 LSM 登记、启动、开机自启，有网页的经二狗转发到 /apps/<项目编号>-<服务名>/、项目卡片上有入口（要守前缀约定）。` +
    `建设期间交的留着，建设任务做完时出现在“首版做完了”卡上（主按钮“${OPERATIONS_PUT_IN_USE_LABEL}”），卡出了以后再交，卡跟着更新；` +
    `项目已经在使用中的，运行时和现在生效的比出加了、改了、去掉哪几条，出一张“运营方案变更”卡，用户确认了才照差异生效（建、改、取消对应的内部任务）。` +
    `用户在会话里点明“建个定时任务”“改成每天 7 点”时就用它出卡，不要回“建不了”，也不要写让用户手动去建定时任务的说明；要把用户那句话的消息 id 写进 userWords。` +
    `每一条写明：key（之后保持不变）、名字、用哪种手段（means）、触发（schedule 或 event）、怎么做（approach：plain 普通任务，或 workflow 流程，流程要写 workflow 的步骤）、` +
    `每次做什么（instructions：交给你的工单内容，照项目档案干活，不用把脚本细节全写进来）、要的能力（capabilities：联网、bash、skill、MCP、给秘书发消息，不能超出项目的工具包，超了运行时拒收）、失败时怎样（可以不写）。` +
    `能用的运营手段：${list}。最多 ${OPERATIONS_MAX} 条。`
  );
}

/** 第几条（给维护者看的，从 1 数） */
const nth = (i: number, name: string) => `第 ${i + 1} 条「${name}」`;

export const refusal = {
  notYours: (projectId: string) => `项目 ${projectId} 不是你维护的，只有它的维护者能交运营方案`,
  preparing: (name: string) => `项目「${name}」还在筹备中：立项书确认、开工之后再交运营方案`,
  // @i18n-ignore-end
  /** 维护者交方案时、用户在卡上确认时都会碰到 */
  archived: (name: string) => t("operations.refusal.archived", { name }),
  // @i18n-ignore-start model：校验的问题（交给维护者）
  empty: "运营方案里至少写一条",
  duplicateKey: (key: string) => `key「${key}」写了不止一条：每一条的 key 不一样`,
  noMeans: (i: number, name: string, means: string, available: readonly OperationMeans[]) =>
    forModel(() => `${nth(i, name)}：没有这种运营手段「${means}」（现在登记的：${available.map((m) => `${m.id} ${m.label}`).join("、")}）`),
  item: (i: number, name: string, problem: string) => `${nth(i, name)}：${problem}`,
  workflowNeedsSteps: (i: number, name: string) => `${nth(i, name)}：approach 写了 workflow（流程），要在 workflow 里写步骤`,
  plainNoWorkflow: (i: number, name: string) => `${nth(i, name)}：workflow 的步骤只给流程用——approach 写 workflow，或者去掉 workflow`,
  serviceOnly: (i: number, name: string) => `${nth(i, name)}：service 只给运营手段“服务”用——要上线服务的写 means: service，不然去掉 service`,
  beyond: (i: number, name: string, beyond: readonly ToolkitCapability[], toolkit: ToolkitShape) =>
    forModel(() => `${nth(i, name)}：要的能力超出了项目的工具包——${beyond.map(capabilityText).join("、")}。项目的工具包现在是：${toolkitText(toolkit)}。要加能力先用 ${REQUEST_TOOLKIT_CHANGE_TOOL} 申请（用户批准后再交运营方案），或者这一条不要它们`),
  stepsNeed: (i: number, name: string, what: string) => `${nth(i, name)}：流程的步骤里用到 ${what}，要的能力（capabilities）里要写上`,
  workflowCheck: (i: number, name: string, problems: readonly string[]) => `${nth(i, name)}：流程的步骤没通过检查——${problems.join("；")}`,
  workflowReplan: (i: number, name: string, asks: readonly string[]) => `${nth(i, name)}：审查要求先补充——${asks.join("；")}`,
  workflowBlocked: (i: number, name: string, why: string) => `${nth(i, name)}：审查判定不能执行——${why}`,
  noReview: (i: number, name: string) => `${nth(i, name)}：这个版本还不能审查流程的步骤，先写成普通任务`,
  same: "和现在生效的运营方案一样，没有要改的（照旧在跑）。",
  problems: (list: readonly string[]) => `运营方案没通过检查，改好再交（整份重交）：${NL}- ${list.join(`${NL}- `)}`,
  // @i18n-ignore-end
  /** 卡上确认时（用户看） */
  changed: () => t("operations.refusal.changed"),
  handled: () => t("operations.refusal.handled"),
  notFound: (revision: number) => t("operations.refusal.notFound", { revision }),
  missingConfirmations: (texts: readonly string[]) => t("operations.refusal.missingConfirmations", { items: texts.join(t("operations.itemSep")) }),
};

// @i18n-ignore-start model：交给维护者的工具结果
/** 交给维护者的工具结果（按中文写：里面用到的协议包说法也是中文） */
export const toolResult = inChinese({
  /** 建设期间交的 */
  build: (revision: number, count: number, onCard: boolean) =>
    onCard
      ? `运营方案（第 ${revision} 份，${count} 条）已更新到用户待办里那张“首版做完了”卡上：用户点“${OPERATIONS_PUT_IN_USE_LABEL}”就一次转入使用、把这些都开起来。告诉用户卡在那里。`
      : `运营方案（第 ${revision} 份，${count} 条）收下了：建设任务做完时出现在“首版做完了”卡上，用户确认一次就转入使用、把这些都开起来。之后要改就再交一份完整的。`,
  /** 使用中交的 */
  change: (revision: number, lines: readonly string[]) =>
    [`运营方案变更卡（第 ${revision} 份）已放进用户的待办，也出在用户说话的会话里；用户确认了才照下面的差异生效，拒绝的什么都不动。告诉用户：卡在这里，点确认就生效。`, ...lines].join(NL),
  words: (n: number) => `你引用的 ${n} 条用户原话运行时核实过了，已写进卡上的“${USER_WORDS_TITLE}”一栏。`,
});
// @i18n-ignore-end

/** 一条写成一行 */
export const itemLine = (item: OperationItem): string => operationLine(item);

/** 差异写成几行（卡的纯文本降级、交给维护者的话） */
export function diffLines(p: Pick<OperationsChangeCardPayload, "added" | "changed" | "removed" | "restored" | "kept">): string[] {
  return [
    ...p.added.map((i) => t("operations.diff.line", { change: OPERATION_CHANGE_LABEL.added, item: itemLine(i) })),
    ...p.changed.map((c) =>
      t(c.inPlace ? "operations.diff.changedInPlace" : "operations.diff.changed", { change: OPERATION_CHANGE_LABEL.changed, before: itemLine(c.before), after: itemLine(c.after) }),
    ),
    ...p.removed.map((i) => t("operations.diff.line", { change: OPERATION_CHANGE_LABEL.removed, item: itemLine(i) })),
    ...p.restored.map((i) => t("operations.diff.line", { change: OPERATION_CHANGE_LABEL.restored, item: itemLine(i) })),
    ...(p.kept.length > 0
      ? [t("operations.diff.kept", { items: p.kept.map((k) => t("operations.diff.keptItem", { name: k.name, trigger: k.triggerText })).join(t("operations.listSep")) })]
      : []),
  ];
}

/** 一条的结局写成一行 */
export const resultLine = (r: OperationResult): string =>
  t("operations.result.line", {
    name: r.name,
    outcome: OPERATION_OUTCOME_LABEL[r.outcome],
    task: r.taskId ? t("operations.result.task", { id: r.taskId }) : "",
    reason: r.reason ? t("operations.result.reason", { reason: r.reason }) : "",
  });

/** 结局的几项数目："开起来 2 条、要你手动 1 条、没生效 1 条" */
export function resultCounts(results: readonly OperationResult[]): string {
  const live = results.filter((r) => r.outcome === "created" || r.outcome === "recreated" || r.outcome === "rescheduled" || r.outcome === "kept").length;
  const manual = results.filter((r) => r.outcome === "manual").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  const cancelled = results.filter((r) => r.outcome === "cancelled").length;
  return [
    t("operations.counts.live", { count: live, n: live }),
    ...(cancelled > 0 ? [t("operations.counts.cancelled", { count: cancelled, n: cancelled })] : []),
    ...(manual > 0 ? [t("operations.counts.manual", { count: manual, n: manual })] : []),
    ...(failed > 0 ? [t("operations.counts.failed", { count: failed, n: failed })] : []),
  ].join(t("operations.listSep"));
}

/** 时间线上的一笔、交给维护者的通知 */
export const decisionText = {
  /** "首版做完了"卡上确认并转入使用：维护者会话里的说明（接在"你选了转入使用"那句后面） */
  putInUse: (revision: number, results: readonly OperationResult[]) => t("operations.decision.putInUse", { revision, counts: resultCounts(results) }),
  record: (revision: number, results: readonly OperationResult[]) => t("operations.decision.record", { revision, counts: resultCounts(results) }),
  rejectedRecord: (revision: number) => t("operations.decision.rejectedRecord", { revision }),
  // @i18n-ignore-start model：交给维护者的通知
  /** 有没生效的：通知维护者（唤起它），看看是什么原因 */
  failedNotice: (revision: number, results: readonly OperationResult[]) =>
    forModel(() => [
      `用户确认了运营方案（第 ${revision} 份），有几条没生效：`,
      ...results.filter((r) => r.outcome === "failed").map(resultLine),
      `其余的照常生效：${resultCounts(results)}。看看没生效的是什么原因（工具包不够、事件写得不对……），改好了用 ${PROPOSE_OPERATIONS_TOOL} 再交一份完整的运营方案，告诉用户。`,
    ].join(NL)),
  confirmedNotice: (revision: number, results: readonly OperationResult[], comment?: string) =>
    forModel(() => [`用户确认了运营方案变更（第 ${revision} 份），已照差异生效：`, ...results.map(resultLine), ...(comment ? [`用户说：「${comment}」`] : [])].join(NL)),
  rejectedNotice: (revision: number, comment?: string) => `用户拒绝了运营方案变更（第 ${revision} 份）${comment ? `：「${comment}」` : ""}。现在生效的运营方案照旧，什么都没动。`,
  // @i18n-ignore-end
};

/** 卡的纯文本降级里运营方案那一节（秘书列待办时看到的，开头就是方案） */
export function planSectionText(items: readonly OperationItem[]): string {
  return t("operations.planSection", { items: items.map(itemLine).join(t("operations.listSep")), grant: OPERATIONS_GRANT_TEXT });
}

/** "运营方案变更"卡的纯文本降级 */
export function changeCardText(p: OperationsChangeCardPayload): string {
  const state = p.decided ? (p.decided.confirmed ? t("operations.card.confirmed") : t("operations.card.rejected")) : t("operations.card.pending");
  return [
    t("operations.card.head", { project: p.projectName, revision: p.revision, state, why: p.why }),
    ...diffLines(p),
    ...wordsLines(p.userWords ?? []),
    OPERATIONS_GRANT_TEXT,
  ].join(NL);
}

/** 依据的用户原话（运行时核实过的）的几行 */
export const wordsLines = (words: readonly VerifiedUserWords[]): string[] =>
  words.length > 0 ? [t("operations.words.head", { title: USER_WORDS_TITLE }), ...words.map((w) => `- ${userWordsLine(w)}`)] : [];

/** 一条交给维护者看的详细写法（工具结果、通知里列出方案时） */
export const itemDetail = (item: OperationItem): string =>
  item.automatic
    ? `${item.name}：${item.triggerText}，${OPERATION_APPROACH_LABEL[item.approach]}；每次做什么：${item.instructions}；要的能力：${capabilitiesText(item.capabilities)}` // @i18n-ignore model：交给维护者看的
    : `${item.name}：${OPERATIONS_MANUAL_PREFIX}${item.manual ?? ""}`; // @i18n-ignore model：交给维护者看的
