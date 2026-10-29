// 运营方案（130 号票，ADR-0028；规格第 8 节"项目内部任务"、第 11 节"项目状态变更时找用户"）：项目转入使用后怎么运转，由项目的
// 维护者起草，用户在卡上确认一次就全部生效——确认就是授权，之后照方案跑，不再逐项问（用户 2026-10-17 定："以后项目做完之后只要我
// 确认一下就可以自动转运营，运营模式不限"）。
// - 维护者用 propose_operations 交一份完整的运营方案（tool）：运行时逐条校验——手段在登记表里（means.ts）、手段自己的校验、要的能力
//   不超出项目的工具包、流程的那几条先检查再审查修补（和 propose_plan 同一套，守卫眼里执行它的是项目的维护者）。不过的整份退回，写明
//   哪一条为什么；
// - 建设期间交的（项目在建设中）：记下（operations_proposed，mode build），等建设任务做完出现在"首版做完了"卡上（projects.ts 的
//   buildDonePayload 取 pendingBuildPlan）；卡已经出了的同一事务更新卡（版本加 1，用户照新的那份确认）；259 号票起"转入使用"确认卡
//   （go_live）同样带着它、同样更新，卡上的转运营检查清单跟着按新的方案重算（goLiveChecklist）；
// - "首版做完了"卡上点"确认并转入使用"（projects.ts 的 decideBuild 叫 putInUse）：方案里每一条生效——automatic 的手段 apply，
//   建成这个项目的内部任务（定时、事件触发的进运营中，授权一直有效）；要用户手动的记成"要你手动"；做不了的记原因、别的照常生效、
//   项目照常转进使用中，通知维护者。项目上记下现在生效的运营方案（Project.operations，和转入使用同一条 project 事件），
//   维护者会话的时间线上记一笔"运营方案已生效"。卡片动作带幂等键：同一次确认重发不会再建一遍；
// - 使用中（或已停用）的项目交的：和现在生效的比出差异（diff.ts），出"运营方案变更"卡（同一个项目一次只有一张在等：新交的顶掉旧的），
//   进待办，也出在用户说那句话的会话里（照 125 号票的立项要求变更卡）；用户确认一次就照差异生效：加上的建、只改了时间的就地改、
//   别的改动撤了重建、去掉的取消、照旧却没跑着的重新开起来；拒绝的什么都不动；
// - 停用、重新启用：定时、事件触发的内部任务由触发底座按项目的状态暂停、恢复（scheduled-jobs 的 onProject）；登记了 pause / resume 的
//   手段（项目自己的服务，133 号票：撤出 LSM、撤掉转发，重新登记、启动）由这里在项目停用（含使用中归档）、重新启用（含取消归档
//   回到使用中）时叫。已归档照现有规矩（触发底座暂停，取消归档恢复）。
import {
  capabilitiesBeyond,
  capabilityText,
  CARD_TYPE_VERSIONS,
  CHANNELS,
  type EventTrigger,
  EVENT_TYPES,
  ENDED_TASK_STATES,
  maintainerChannel,
  OPERATION_NAME_MAX,
  OPERATION_SERVICE_MEANS,
  type OperationItem,
  type OperationItemDraft,
  type OperationResult,
  OperationsChangeCardPayload,
  OperationsConfirmInput,
  operationsConfirmationItems,
  OperationItemDraft as OperationItemDraftSchema,
  OPERATIONS_MAX,
  type OperationsPlanView,
  type Plan,
  type Project,
  type ProjectEventPayload,
  type ProjectOperationItem,
  type ProjectOperations,
  projectToolkit,
  PURGED_TEXT,
  refusedUserWordsText,
  triggerFields,
  Type,
  type VerifiedUserWords,
  type WorkflowPlanDraft,
  forModel,
  type GoLiveChecklistItem,
  t,
} from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { listPendingCards } from "../cards/views.ts";
import { buildAgentNotice, buildTimelineRecord } from "../conversation/messages.ts";
import { cardRefsElsewhere, NO_USER_WORDS, USER_WORDS_PARAM, type UserWordsCheck, type UserWordsDeps, verifyUserWords } from "../conversation/user-words.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { purgedField, type PurgeRewriter } from "../events/purge.ts";
import type { ToolRegistry } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";
import { getProjectRow } from "../projects/views.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { checkWorkflowDraft, type ReviewedWorkflow } from "../tasks/workflow-plan.ts";
import { oneLine } from "../util/text.ts";
import { type ActiveOperation, diffIsEmpty, diffOperations, type OperationsDiff } from "./diff.ts";
import { OPERATIONS_CHANNEL, OPERATIONS_EVENTS, type OperationsDecidedPayload, type OperationsProposedPayload } from "./events.ts";
import type { OperationMeans, OperationMeansRegistry } from "./means.ts";
import { changeCardText, decisionText, diffLines, itemLine, refusal, resultLine, toolDescription, toolResult } from "./texts.ts";
import { PROPOSE_OPERATIONS_TOOL } from "./tool-names.ts";
import { operationsOfProject, operationsRevision } from "./views.ts";

export interface OperationsOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  tasks: Pick<TaskService, "get">;
  /** 运营手段登记表（内核登记定时、事件触发的和要用户手动的那几种，插件经插件宿主登记） */
  means: OperationMeansRegistry;
  /** 事件触发方式对不对（事件来源登记表、来源的实现现查） */
  checkEventTrigger: (trigger: EventTrigger) => string[];
  /** 流程的步骤照这份工具注册表检查（和 propose_plan 一样） */
  workflowTools: ToolRegistry;
  /** 流程的那一条：审查修补（守卫眼里执行它的是项目的维护者，和执行时一样）；不给就收不了流程 */
  reviewWorkflow?: (project: Project, draft: WorkflowPlanDraft, version: number) => Promise<ReviewedWorkflow>;
  /** 核实维护者引用的用户原话；不给就不核实 */
  userWords?: UserWordsDeps;
  /**
   * 转运营检查清单（259 号票，项目模块的 goLiveChecklist）：建设期间又交了一份方案、更新"首版做完了""转入使用"卡时，卡上的清单
   * 按新的方案重算。不给就不重算
   */
  goLiveChecklist?: (projectId: string, plan: OperationsPlanView) => GoLiveChecklistItem[];
  now: () => string;
  log: (line: string) => void;
}

/** "首版做完了"卡上确认并转入使用时，运营方案那一部分 */
export interface PutInUseOperations {
  /** 每一条生效的事件、记下决定、时间线上的一笔、有没生效的时给维护者的通知（排在项目转入使用那一条之后） */
  events: NewEvent[];
  /** 项目上记下的现在生效的运营方案（和转入使用同一条 project 事件） */
  operations: ProjectOperations;
  results: OperationResult[];
  /** 接在维护者会话里"你选了转入使用"那句后面 */
  note: string;
}

export interface Operations {
  /** 项目维护者的"交运营方案"工具（执行的工单段、对话段里都有） */
  tool(projectId: string, maintainerId: string): HostTool;
  /** 建设任务做完出"首版做完了"卡时卡上带的：维护者建设期间交的、还没确认的那一份 */
  pendingBuildPlan(projectId: string): OperationsPlanView | undefined;
  /**
   * "首版做完了"卡、"转入使用"确认卡（via，259 号票）上确认并转入使用（project 是转入使用之前的样子，plan 是卡上的那一份）：
   * 方案里每一条生效。流程那几条审查要用户逐项确认的事项没勾完的抛 RequestRejected（整张卡不动）
   */
  putInUse(project: Project, plan: OperationsPlanView, input: OperationsConfirmInput, key: string, cardId: string, via?: "build_done" | "go_live"): PutInUseOperations;
  /** "运营方案变更"卡上的确认、拒绝（卡片动作，和卡片更新同一事务） */
  decideChange(payload: OperationsChangeCardPayload, confirmed: boolean, input: OperationsConfirmInput, note: string | undefined, key: string): CardActionEffect<OperationsChangeCardPayload>;
  /**
   * 项目列表频道上的 project 事件（组合根接到事件存储的监听上）：项目停用（使用中的归档）时叫登记了 pause 的手段，重新启用（取消归档
   * 回到使用中）时叫 resume。定时、事件触发的任务不登记它们，由触发底座按项目的状态暂停、恢复。
   * seq 是这条 project 事件的全局序号：随之追加的事件的幂等键派生自它（停用、重新启用几次各是各的）
   */
  onProject(payload: ProjectEventPayload, seq: number): void;
}

const ProposeParams = Type.Object(
  {
    // @i18n-ignore-start model：参数说明
    items: Type.Array(OperationItemDraftSchema, { minItems: 1, maxItems: OPERATIONS_MAX, description: "完整的一份运营方案：每一条一项（之前交过的这次没写就算去掉）" }),
    why: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "一两句说明：为什么这样运转、这次改了什么（用户在卡上看得到）" })),
    // @i18n-ignore-end
    userWords: Type.Optional(USER_WORDS_PARAM),
  },
  { additionalProperties: false },
);

/** 校验过的方案：每一条、流程那几条执行用的计划、要告诉维护者的（服务没在跑、没自检……） */
interface CheckedPlan {
  items: OperationItem[];
  executions: Record<string, Plan>;
  notes: string[];
}

/** 项目上的一条：校验过的那一条去掉流程的步骤（步骤在它的内部任务的计划里），加上它生效成的东西 */
const projectItem = (item: OperationItem, binding: { taskId?: string | undefined; failed?: string | undefined }): ProjectOperationItem => {
  const { workflow, ...rest } = item;
  return {
    ...rest,
    ...(workflow ? { steps: workflow.steps.length } : {}),
    ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }),
    ...(binding.failed === undefined ? {} : { failed: binding.failed }),
  };
};

/** 卡上带的一份方案 */
const planView = (p: Pick<OperationsProposedPayload, "revision" | "items" | "why" | "userWords">): OperationsPlanView => ({
  revision: p.revision,
  items: p.items,
  ...(p.why ? { why: p.why } : {}),
  ...(p.userWords.length > 0 ? { userWords: p.userWords } : {}),
});

/** 这几条里，流程审查要用户逐项确认的事项：没勾完的抛 RequestRejected */
const checkedConfirmations = (items: readonly OperationItem[], input: OperationsConfirmInput): Set<string> => {
  const ticked = new Set(input?.confirmations ?? []);
  const missing = operationsConfirmationItems(items).filter((c) => !ticked.has(c.key));
  if (missing.length > 0) throw new RequestRejected("bad_params", refusal.missingConfirmations(missing.map((c) => c.text)));
  return ticked;
};

/** 时间线上的一笔（项目维护者的会话） */
const record = (project: Project, summary: string, results: readonly OperationResult[]) =>
  buildTimelineRecord(maintainerChannel(project.maintainerId), { kind: "operations", summary, ...(results.length > 0 ? { detail: results.map(resultLine).join("\n") } : {}) }, { projectId: project.id }).event;

/** 用户的决定（operations 频道上的 operations_decided） */
const decidedEvent = (p: OperationsDecidedPayload, key: string): NewEvent => ({ channel: OPERATIONS_CHANNEL, type: OPERATIONS_EVENTS.decided, payload: p, idempotencyKey: key });

/** "运营方案变更"卡的负载 */
const changePayload = (project: Project, proposed: OperationsProposedPayload, diff: OperationsDiff, words: VerifiedUserWords[]): OperationsChangeCardPayload => ({
  projectId: project.id,
  projectName: project.name,
  revision: proposed.revision,
  ...(project.operations ? { baseRevision: project.operations.revision } : {}),
  why: proposed.why,
  added: diff.added,
  changed: diff.changed.map((c) => ({ before: c.before.item, after: c.after, inPlace: c.inPlace })),
  removed: diff.removed.map((r) => r.item),
  restored: diff.restored.map((r) => r.after),
  kept: diff.kept.map((k) => ({ key: k.after.key, name: k.after.name, triggerText: k.after.triggerText })),
  ...(words.length > 0 ? { userWords: words } : {}),
});

/** 方案里每一条一句（素材里的说法） */
const decidedSummary = (items: readonly OperationItem[]) => items.map(itemLine).join(t("operations.listSep"));

export function createOperations(options: OperationsOptions): Operations {
  const { store, cards, inbox, now, log } = options;

  const mustProject = (projectId: string): Project => {
    const row = getProjectRow(store.reader, projectId);
    if (!row || row.deleted) throw new RequestRejected("not_found", t("operations.noProject", { projectId }));
    return row.project;
  };

  /** 交上来的一份运营方案逐条校验（不过的整份退回，写明哪一条为什么） */
  const check = async (project: Project, drafts: readonly OperationItemDraft[], revision: number): Promise<CheckedPlan> => {
    const toolkit = projectToolkit(project);
    const problems: string[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();
    for (const d of drafts) {
      if (seen.has(d.key)) problems.push(refusal.duplicateKey(d.key));
      seen.add(d.key);
    }
    const checkContext = {
      project,
      now: now(),
      checkEventTrigger: options.checkEventTrigger,
      names: { project: (id: string) => (id === project.id ? project.name : getProjectRow(store.reader, id)?.project.name), task: (id: string) => options.tasks.get(id)?.title },
    };
    // 同一种手段的几条之间撞没撞（133 号票：同一个项目两个服务同名、同端口）
    for (const means of options.means.list()) {
      const same = drafts.filter((d) => d.means === means.id);
      if (same.length > 0 && means.checkPlan) problems.push(...forModel(() => means.checkPlan!(same, checkContext)));
    }
    const items: OperationItem[] = [];
    const executions: Record<string, Plan> = {};
    for (const [i, d] of drafts.entries()) {
      const name = oneLine(d.name, OPERATION_NAME_MAX);
      const means = options.means.get(d.means);
      if (!means) {
        problems.push(refusal.noMeans(i, name, d.means, options.means.list()));
        continue;
      }
      const approach = d.approach ?? "plain";
      // 校验的问题交回维护者：按中文写（里面用到的协议包说法、手段的名字也是中文，174 号票）
      const own = forModel(() => means.check(d, checkContext));
      for (const p of own) problems.push(refusal.item(i, name, p));
      if (d.service && means.id !== OPERATION_SERVICE_MEANS) problems.push(refusal.serviceOnly(i, name));
      if (means.automatic && approach === "workflow" && !d.workflow) problems.push(refusal.workflowNeedsSteps(i, name));
      if (means.automatic && approach === "plain" && d.workflow) problems.push(refusal.plainNoWorkflow(i, name));
      // 要的能力不能超出项目的工具包（skill 也算）
      const beyond = capabilitiesBeyond(d.capabilities, toolkit);
      if (beyond.length > 0) problems.push(refusal.beyond(i, name, beyond, toolkit));
      const written: OperationItem = {
        key: d.key,
        name,
        means: means.id,
        meansLabel: means.label,
        automatic: means.automatic,
        triggerText: means.describe(d, checkContext),
        ...(d.schedule ? { schedule: d.schedule } : {}),
        ...(d.event ? { event: d.event } : {}),
        approach: means.automatic ? approach : "plain",
        instructions: d.instructions.trim(),
        capabilities: d.capabilities,
        ...(d.onFailure ? { onFailure: d.onFailure.trim() } : {}),
        ...(d.manual ? { manual: d.manual.trim() } : {}),
      };
      // 运行时补齐的（服务的工作目录换成绝对路径、默认值）：这一条自己的校验过了才补
      const item = own.length === 0 && means.normalize ? means.normalize(written, d, checkContext) : written;
      // 要连出去看的（服务的前缀下自检，133 号票）：这一条别的都对了才看
      if (own.length === 0 && means.selfCheck) {
        const checked = await means.selfCheck(item);
        for (const p of checked.problems) problems.push(refusal.item(i, name, p));
        notes.push(...checked.notes);
      }
      // 流程那一条：先检查（和 propose_plan 同一套），再审查修补；审查修补后的计划才是授权对象
      if (means.automatic && approach === "workflow" && d.workflow) {
        const reviewed = await reviewItem(project, d, i, name, revision, problems);
        if (reviewed) {
          item.workflow = reviewed.plan;
          executions[d.key] = reviewed.execution;
          if (reviewed.plan.toolkit.bash && d.capabilities.bash !== true) problems.push(refusal.stepsNeed(i, name, "bash"));
          if (reviewed.plan.toolkit.network && d.capabilities.network !== true) problems.push(refusal.stepsNeed(i, name, "联网")); // @i18n-ignore model：校验的问题
        }
      }
      items.push(item);
    }
    if (problems.length > 0) throw new RequestRejected("bad_params", refusal.problems(problems));
    return { items, executions, notes };
  };

  /** 流程那一条的检查和审查修补；不过的原因记进 problems */
  const reviewItem = async (project: Project, d: OperationItemDraft, i: number, name: string, revision: number, problems: string[]): Promise<ReviewedWorkflow | undefined> => {
    const draft: WorkflowPlanDraft = { goal: d.instructions.trim(), steps: d.workflow!.steps, rules: d.workflow!.rules ?? [] };
    const checked = checkWorkflowDraft(draft, options.workflowTools, d.event ? triggerFields(d.event) : undefined);
    if (checked.length > 0) {
      problems.push(refusal.workflowCheck(i, name, checked));
      return undefined;
    }
    if (!options.reviewWorkflow) {
      problems.push(refusal.noReview(i, name));
      return undefined;
    }
    const reviewed = await options.reviewWorkflow(project, draft, revision);
    const { review } = reviewed.plan;
    if (review.status === "needs_replan") {
      problems.push(refusal.workflowReplan(i, name, review.replans));
      return undefined;
    }
    if (review.status === "blocked") {
      problems.push(refusal.workflowBlocked(i, name, review.violations.map((v) => v.message).join("；") || review.note || "无法修补")); // @i18n-ignore model：校验的问题
      return undefined;
    }
    return reviewed;
  };

  /**
   * 它现在还跑着没有：要用户手动的算跑着（本来就没有内部任务）；没生效的不算；登记了 alive 的手段（服务）由它说；
   * 别的按内部任务（结束了的不算）
   */
  const aliveIn =
    (project: Project) =>
    (active: ActiveOperation): boolean => {
      if (!active.item.automatic) return true;
      if (active.failed !== undefined) return false;
      const means = options.means.get(active.item.means);
      if (means?.alive) return means.alive({ taskId: active.taskId }, { item: active.item, project });
      if (active.taskId === undefined) return false;
      const task = options.tasks.get(active.taskId);
      return task !== undefined && !ENDED_TASK_STATES.includes(task.state);
    };

  /** 改了的这一条能不能就地改：手段的 update 给得出事件（只是看看，不追加） */
  const inPlace = (before: ActiveOperation, after: OperationItem): boolean => {
    const means = options.means.get(after.means);
    return before.item.means === after.means && before.taskId !== undefined && means?.update?.(before.item, after, { taskId: before.taskId }, { key: "probe" }) !== undefined;
  };

  /** 项目上现在生效的每一条（它写的样子从它那一份运营方案里取，生效成的东西从项目上取） */
  const activeOperations = (project: Project): ActiveOperation[] => {
    const active = project.operations;
    if (!active) return [];
    const proposed = operationsRevision(store.reader, project.id, active.revision)?.proposed;
    return active.items.flatMap((p) => {
      const item = proposed?.items.find((i) => i.key === p.key);
      return item ? [{ item, taskId: p.taskId, failed: p.failed }] : [];
    });
  };

  /** 一条生效（同一事务里的前几条已经建了几个任务：counter） */
  const applyOne = (
    project: Project,
    item: OperationItem,
    ctx: { counter: { n: number }; key: string; ticked: ReadonlySet<string>; executions: Record<string, Plan> },
  ): { events: NewEvent[]; binding: { taskId?: string; failed?: string }; result: OperationResult } => {
    const base = { key: item.key, name: item.name };
    const failed = (reason: string) => ({ events: [], binding: { failed: reason }, result: { ...base, outcome: "failed" as const, reason } });
    if (!item.automatic) return { events: [], binding: {}, result: { ...base, outcome: "manual" } };
    const means: OperationMeans | undefined = options.means.get(item.means);
    if (!means?.apply) return failed(t("operations.result.noMeans", { means: item.meansLabel }));
    // 交上来之后项目的工具包可能改过：生效时再看一遍
    const beyond = capabilitiesBeyond(item.capabilities, projectToolkit(project));
    if (beyond.length > 0) return failed(t("operations.result.beyond", { capabilities: beyond.map(capabilityText).join(t("operations.listSep")) }));
    const prefix = `${item.key}/`;
    const confirmations = [...ctx.ticked].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    try {
      const applied = means.apply(item, { project, nth: ctx.counter.n, execution: ctx.executions[item.key], confirmations, key: ctx.key });
      // 建了任务的才占一个任务编号（服务没有任务）
      if (applied.taskId === undefined) return { events: applied.events, binding: {}, result: { ...base, outcome: "created" } };
      ctx.counter.n += 1;
      return { events: applied.events, binding: { taskId: applied.taskId }, result: { ...base, outcome: "created", taskId: applied.taskId } };
    } catch (err) {
      if (err instanceof RequestRejected) return failed(err.message);
      log(`运营方案的「${item.name}」（项目 ${project.id}）生效时出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return failed(t("operations.result.error", { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  /**
   * 撤销一条（它的内部任务还没结束的取消）；没有的、要用户手动的什么都不追加。登记了 alive 的手段（服务）不论跑没跑着都交给它：
   * 上线失败了的也可能还登记在 LSM 上，要撤下
   */
  const revokeOne = (project: Project, active: ActiveOperation, key: string): NewEvent[] => {
    if (!active.item.automatic) return [];
    const means = options.means.get(active.item.means);
    if (!means?.revoke) return [];
    if (!means.alive && (active.taskId === undefined || !aliveIn(project)(active))) return [];
    return means.revoke({ taskId: active.taskId }, { key, item: active.item, project });
  };

  /** 还在等的"运营方案变更"卡（同一个项目一次只有一张） */
  const pendingChangeCards = (projectId: string) => listPendingCards(store.reader, ["operations_change"]).filter((c) => (c.payload as OperationsChangeCardPayload).projectId === projectId);

  /** 还没选的"首版做完了"卡、还没确认的"转入使用"卡（259 号票）：都带着建设期间交的方案 */
  const pendingGoLiveCards = (projectId: string) => listPendingCards(store.reader, ["build_done", "go_live"]).filter((c) => (c.payload as { projectId?: string }).projectId === projectId);

  /** 核实引用的用户原话 */
  const verify = (cited: readonly string[] | undefined, maintainerId: string): UserWordsCheck =>
    !cited || cited.length === 0
      ? NO_USER_WORDS
      : options.userWords
        ? verifyUserWords(options.userWords, cited, maintainerChannel(maintainerId))
        : { verified: [], refused: cited.map((id) => ({ id, reason: "这个版本还不能核实用户原话" })) }; // @i18n-ignore model：交给维护者的说明

  const propose = async (projectId: string, maintainerId: string, drafts: readonly OperationItemDraft[], why: string, cited: readonly string[] | undefined) => {
    const project = mustProject(projectId);
    if (project.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", refusal.notYours(projectId));
    if (project.state === "preparing") throw new RequestRejected("not_allowed", refusal.preparing(project.name));
    if (project.state === "archived") throw new RequestRejected("not_allowed", refusal.archived(project.name));
    if (drafts.length === 0) throw new RequestRejected("bad_params", refusal.empty);
    const revision = operationsOfProject(store.reader, projectId).length + 1;
    const checked = await check(project, drafts, revision);
    // 审查是异步的：期间项目可能变了，按现在的再看一遍
    const current = mustProject(projectId);
    if (current.state === "archived") throw new RequestRejected("not_allowed", refusal.archived(current.name));
    const words = verify(cited, maintainerId);
    const proposed: OperationsProposedPayload = {
      projectId,
      revision: operationsOfProject(store.reader, projectId).length + 1,
      mode: current.state === "building" ? "build" : "change",
      maintainerId,
      why,
      items: checked.items,
      executions: checked.executions,
      userWords: words.verified,
      time: now(),
    };
    if (proposed.mode === "build") {
      // 建设期间交的：等建设任务做完出现在"首版做完了"卡上；卡已经出了的同一事务更新卡（用户照新的那份确认）。
      // 259 号票："转入使用"确认卡同样更新；卡上的转运营检查清单按新的方案重算
      const pendingCards = pendingGoLiveCards(projectId);
      const view = planView(proposed);
      const checklist = pendingCards.length > 0 ? options.goLiveChecklist?.(projectId, view) : undefined;
      const events: NewEvent[] = [{ channel: OPERATIONS_CHANNEL, type: OPERATIONS_EVENTS.proposed, payload: proposed }];
      for (const card of pendingCards) {
        events.push(cards.buildUpdate(card.id, { payload: { ...(card.payload as object), operations: view, ...(checklist ? { checklist, checkedAt: proposed.time } : {}) } }).event);
      }
      store.appendBatch(events);
      return { text: [toolResult.build(proposed.revision, checked.items.length, pendingCards.length > 0), ...checked.notes].join("\n"), words, cardIds: pendingCards.map((c) => c.id) };
    }
    // 使用中、已停用的：和现在生效的比出差异，出"运营方案变更"卡
    const active = activeOperations(current);
    const diff = diffOperations(active, checked.items, { alive: aliveIn(current), inPlace });
    if (diffIsEmpty(diff)) throw new RequestRejected("not_allowed", refusal.same);
    const payload = changePayload(current, proposed, diff, words.verified);
    const card = cards.buildCreate({ type: "operations_change", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({
      kind: "card",
      cardId: card.card.id,
      title: oneLine(t("operations.inboxTitle", { project: current.name }), 60),
      source: t("operations.source", { project: current.name }),
      origin: { projectId },
      urgency: "non_blocking",
    });
    // 新交的顶掉还在等的那张
    const superseded = pendingChangeCards(projectId).map((c) => cards.buildUpdate(c.id, { status: "expired", expiredNote: t("operations.superseded") }).event);
    store.appendBatch([
      ...superseded,
      { channel: OPERATIONS_CHANNEL, type: OPERATIONS_EVENTS.proposed, payload: { ...proposed, cardId: card.card.id } },
      card.event,
      item.event,
      // 卡也出在用户说那句话的会话里（维护者自己的会话里本来就有：工具产生的卡片）
      ...cardRefsElsewhere(card.card.id, words.verified, maintainerChannel(maintainerId)),
    ]);
    inbox.alert(item.item);
    return { text: [toolResult.change(proposed.revision, forModel(() => diffLines(payload))), ...checked.notes].join("\n"), words, cardIds: [card.card.id] };
  };

  return {
    tool: (projectId, maintainerId) =>
      defineHostTool({
        name: PROPOSE_OPERATIONS_TOOL,
        title: t("operations.tool.propose"),
        description: toolDescription(options.means.list()),
        parameters: ProposeParams,
        readOnlyOrIdempotent: false,
        run: async ({ items, why, userWords }) => {
          try {
            const r = await propose(projectId, maintainerId, items, why?.trim() ?? "", userWords);
            return {
              text: [r.text, r.words.verified.length > 0 ? toolResult.words(r.words.verified.length) : "", refusedUserWordsText(r.words.refused)].filter(Boolean).join("\n"),
              ...(r.cardIds.length > 0 ? { cardIds: r.cardIds } : {}),
            };
          } catch (err) {
            if (err instanceof RequestRejected) return { text: err.message, isError: true };
            throw err;
          }
        },
      }),

    pendingBuildPlan(projectId) {
      const last = operationsOfProject(store.reader, projectId).at(-1);
      return last && last.proposed.mode === "build" && !last.decided ? planView(last.proposed) : undefined;
    },

    putInUse(project, plan, input, key, cardId, via = "build_done") {
      const row = operationsRevision(store.reader, project.id, plan.revision);
      if (!row || row.decided) throw new RequestRejected("conflict", refusal.changed());
      const { items, executions } = row.proposed;
      const ticked = checkedConfirmations(items, input);
      const counter = { n: 0 };
      const events: NewEvent[] = [];
      const results: OperationResult[] = [];
      const projectItems: ProjectOperationItem[] = [];
      for (const item of items) {
        const applied = applyOne(project, item, { counter, key, ticked, executions });
        events.push(...applied.events);
        results.push(applied.result);
        projectItems.push(projectItem(item, applied.binding));
      }
      const time = now();
      const decided: OperationsDecidedPayload = { projectId: project.id, projectName: project.name, revision: plan.revision, via, cardId, confirmed: true, results, summary: decidedSummary(items), by: "user", time };
      const failures = results.some((r) => r.outcome === "failed");
      events.push(
        decidedEvent(decided, `${key}#operations`),
        record(project, decisionText.record(plan.revision, results), results),
        // 有没生效的：通知维护者（唤起它），看看是什么原因
        ...(failures ? [buildAgentNotice(maintainerChannel(project.maintainerId), decisionText.failedNotice(plan.revision, results), `${key}#operations-notice`, { projectId: project.id }).event] : []),
      );
      return { events, operations: { revision: plan.revision, confirmedAt: time, items: projectItems }, results, note: decisionText.putInUse(plan.revision, results) };
    },

    onProject({ project, change, from }, seq) {
      const pausing = change === "retired" || (change === "archived" && from === "in_use");
      const resuming = change === "reactivated" || (change === "unarchived" && project.state === "in_use");
      if (!pausing && !resuming) return;
      const events = activeOperations(project).flatMap((active) => {
        const means = options.means.get(active.item.means);
        const hook = pausing ? means?.pause : means?.resume;
        // 要用户手动的、没生效的（服务上线失败的照样叫：它可能还登记在 LSM 上）由手段自己看
        if (!hook || !active.item.automatic) return [];
        try {
          return hook.call(means, { taskId: active.taskId }, { key: `operations-${pausing ? "pause" : "resume"}:${project.id}:${seq}`, item: active.item, project });
        } catch (err) {
          log(`运营方案的「${active.item.name}」（项目 ${project.id}）${pausing ? "暂停" : "恢复"}时出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          return [];
        }
      });
      if (events.length > 0) store.appendBatch(events);
    },

    decideChange(payload, confirmed, input, note, key) {
      const project = mustProject(payload.projectId);
      const row = operationsRevision(store.reader, project.id, payload.revision);
      if (!row) throw new RequestRejected("not_found", refusal.notFound(payload.revision));
      if (row.decided) throw new RequestRejected("conflict", refusal.handled());
      if (project.state === "archived") throw new RequestRejected("conflict", refusal.archived(project.name));
      const comment = note?.trim() || undefined;
      const time = now();
      const conversation = maintainerChannel(project.maintainerId);
      const scope = { projectId: project.id };
      const base = { projectId: project.id, projectName: project.name, revision: payload.revision, via: "change" as const, cardId: row.proposed.cardId ?? "", summary: decidedSummary(row.proposed.items), ...(comment ? { note: comment } : {}), by: "user" as const, time };
      if (!confirmed) {
        return {
          status: "handled",
          payload: { ...payload, decided: { confirmed: false, at: time } },
          ...(comment ? { note: comment } : {}),
          events: [
            decidedEvent({ ...base, confirmed: false, results: [] }, `${key}#decided`),
            record(project, decisionText.rejectedRecord(payload.revision), []),
            buildAgentNotice(conversation, decisionText.rejectedNotice(payload.revision, comment), `${key}#notice`, scope).event,
          ],
        };
      }
      // 卡出来之后生效的那一版又换了（不该发生：一次只有一张在等）
      if (project.operations?.revision !== payload.baseRevision) throw new RequestRejected("conflict", refusal.changed());
      const { items, executions } = row.proposed;
      // 照现在的样子再比一遍（卡出来之后内部任务可能被取消了、结束了）
      const diff = diffOperations(activeOperations(project), items, { alive: aliveIn(project), inPlace });
      const ticked = checkedConfirmations([...diff.added, ...diff.changed.filter((c) => !c.inPlace).map((c) => c.after), ...diff.restored.map((r) => r.after)], input);
      const counter = { n: 0 };
      const events: NewEvent[] = [];
      const results: OperationResult[] = [];
      const projectItems: ProjectOperationItem[] = [];
      const ctx = { counter, key, ticked, executions };
      for (const item of items) {
        const changed = diff.changed.find((c) => c.after.key === item.key);
        const kept = diff.kept.find((k) => k.after.key === item.key);
        if (kept) {
          results.push({ key: item.key, name: item.name, outcome: item.automatic ? "kept" : "manual", ...(kept.before.taskId ? { taskId: kept.before.taskId } : {}) });
          projectItems.push(projectItem(item, { taskId: kept.before.taskId }));
          continue;
        }
        if (changed?.inPlace && changed.before.taskId !== undefined) {
          const updated = options.means.get(item.means)?.update?.(changed.before.item, item, { taskId: changed.before.taskId }, { key });
          if (updated) {
            events.push(...updated);
            results.push({ key: item.key, name: item.name, outcome: "rescheduled", taskId: changed.before.taskId });
            projectItems.push(projectItem(item, { taskId: changed.before.taskId }));
            continue;
          }
        }
        // 改了的撤了重建，加上的、重新开起来的建
        if (changed) events.push(...revokeOne(project, changed.before, key));
        const applied = applyOne(project, item, ctx);
        events.push(...applied.events);
        results.push(changed && applied.result.outcome === "created" ? { ...applied.result, outcome: "recreated" } : applied.result);
        projectItems.push(projectItem(item, applied.binding));
      }
      for (const removed of diff.removed) {
        events.push(...revokeOne(project, removed, key));
        results.push({ key: removed.item.key, name: removed.item.name, outcome: removed.item.automatic ? "cancelled" : "manual", ...(removed.taskId ? { taskId: removed.taskId } : {}) });
      }
      const operations: ProjectOperations = { revision: payload.revision, confirmedAt: time, items: projectItems };
      const changedProject: ProjectEventPayload = { project: { ...project, operations, updatedAt: time }, change: "operations_changed", from: project.state, by: "user" };
      events.push(
        { channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: changedProject },
        decidedEvent({ ...base, confirmed: true, results }, `${key}#decided`),
        record(project, decisionText.record(payload.revision, results), results),
        buildAgentNotice(conversation, decisionText.confirmedNotice(payload.revision, results, comment), `${key}#notice`, scope).event,
      );
      return { status: "handled", payload: { ...payload, decided: { confirmed: true, at: time, results } }, ...(comment ? { note: comment } : {}), events };
    },
  };
}

/** "运营方案变更"卡（130 号票）：确认（confirm，流程审查要你逐项确认的事项勾完才行）、拒绝（reject，可附说明） */
export function operationsChangeCardType(operations: Pick<Operations, "decideChange">) {
  return defineCardType({
    type: "operations_change",
    version: CARD_TYPE_VERSIONS.operations_change,
    payload: OperationsChangeCardPayload,
    actions: {
      confirm: { input: OperationsConfirmInput, run: ({ payload, input, note, idempotencyKey }) => operations.decideChange(payload, true, input, note, idempotencyKey) },
      reject: { input: undefined, run: ({ payload, note, idempotencyKey }) => operations.decideChange(payload, false, undefined, note, idempotencyKey) },
    },
    toText: changeCardText,
    // 彻底删除、删除项目时：说明、每一条的文字、引用的原话换成删除标记，差异的结构、确认结果不变
    purge: (p) => ({
      ...p,
      why: PURGED_TEXT,
      added: p.added.map(purgedItem),
      changed: p.changed.map((c) => ({ ...c, before: purgedItem(c.before), after: purgedItem(c.after) })),
      removed: p.removed.map(purgedItem),
      restored: p.restored.map(purgedItem),
      kept: p.kept.map((k) => ({ ...k, name: PURGED_TEXT, triggerText: PURGED_TEXT })),
      ...(p.userWords ? { userWords: p.userWords.map((w) => ({ ...w, text: PURGED_TEXT })) } : {}),
    }),
  });
}

/** 一条的文字换成删除标记：标识、手段、做法、能不能替用户做不变；流程的步骤去掉 */
export function purgedItem(item: OperationItem): OperationItem {
  const { workflow: _w, ...rest } = item;
  return {
    ...rest,
    name: PURGED_TEXT,
    triggerText: PURGED_TEXT,
    instructions: PURGED_TEXT,
    ...purgedField(item, "onFailure"),
    ...purgedField(item, "manual"),
  };
}

/** 删除项目时项目列表频道上 project 事件里现在生效的运营方案：每一条的文字换成删除标记（标识、手段、生效成的内部任务不变） */
export function purgedProjectOperations(operations: ProjectOperations): ProjectOperations {
  return {
    ...operations,
    items: operations.items.map((item) => ({
      ...item,
      name: PURGED_TEXT,
      triggerText: PURGED_TEXT,
      instructions: PURGED_TEXT,
      ...purgedField(item, "onFailure"),
      ...purgedField(item, "manual"),
      ...purgedField(item, "failed"),
    })),
  };
}

/** 彻底删除、删除项目时 operations 频道上的事件：说明、每一条的文字、引用的原话、用户写的话换成删除标记 */
export const operationsPurges: readonly PurgeRewriter[] = [
  {
    eventType: OPERATIONS_EVENTS.proposed,
    rewrite(event) {
      const p = event.payload as OperationsProposedPayload;
      return { ...p, why: PURGED_TEXT, items: p.items.map(purgedItem), executions: {}, userWords: p.userWords.map((w) => ({ ...w, text: PURGED_TEXT })) } satisfies OperationsProposedPayload;
    },
  },
  {
    eventType: OPERATIONS_EVENTS.decided,
    rewrite(event) {
      const p = event.payload as OperationsDecidedPayload;
      return { ...p, summary: PURGED_TEXT, results: p.results.map((r) => ({ ...r, name: PURGED_TEXT, ...purgedField(r, "reason") })), ...purgedField(p, "note") } satisfies OperationsDecidedPayload;
    },
  },
];

/** 用户确认、拒绝运营方案：审查决定（本人的选择），卡上写的话是本人打的字 */
export const operationsDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "operations-decision",
  eventType: OPERATIONS_EVENTS.decided,
  capture(event) {
    const p = event.payload as OperationsDecidedPayload;
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        project: p.projectId,
        context: [p.via === "change" ? "card:operations_change" : `card:${p.via}`, `decision:${p.confirmed ? "confirmed" : "rejected"}`],
        ref: { recordId: `${p.projectId}-operations-${p.revision}`, cardId: p.cardId },
        accepted: { text: t(p.confirmed ? "operations.material.confirmed" : "operations.material.rejected", { project: p.projectName, revision: p.revision, summary: p.summary }), field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};
