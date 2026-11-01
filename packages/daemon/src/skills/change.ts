// skill 变更（358 号票，用户 2026-11-01 定"补齐负责人提交 skill，和登记 MCP 走一样的路"）：给负责人一个工具 request_skill_change——
// 把一个 skill 加进 skill 库、改、删。整条链照 239 号票的 MCP 登记变更（mcp/change.ts）：
// - 工具只校验 + 出一张"skill 变更"卡（skill_change）进待办，**不写任何文件**；校验不过当场回原因、不出卡。校验和真导入是同一段逻辑
//   （skills/library.ts 的 checkSubmission），读卡时算一份内容指纹；
// - 用户在卡上确认之后，运行时重新校验、核对内容指纹（提交之后来源变了就不进库，卡上写明，要重新提交），复制进 skill 区、自检（库里读得到、
//   名字说明对），结果写进卡和时间线；加、改的自动配进提交人的工具包（skill 不是权限），提交人的会话按新的装配重新拉起，别的项目要用自己配；
// - 改：只能改用户自己导入的单个 skill 和负责人提交的，旧版留进 skill 区的 .history/，换的时候失败旧版不动；框架自带的、集合成员拒绝；
// - 删：卡上列出现在哪些工具包在用它。删掉后工具包里的名字**留着**，装配时跳过并记日志（SkillLibrary.pathsOf 本来就这样：被删了的名字不报错），
//   不去改别的项目和任务的工具包——运营方案里写着要这个 skill 的，工具包里的名字一去掉，到点运行就成了"要的能力超出工具包"；
//   同名的再进库又能用了。留着的名字不挡别的改动（改工具包、改计划只查新加的名字），要清掉随时能去掉（adjust_skills、项目页）；
// - 拒绝则一个字节都不变。批准、拒绝都记一条 skill_decided（审批决定素材，skills/material-source.ts）和负责人会话上的时间线。
// 为什么不能让 agent 自己写：skill 区是受保护区域（guard/judge.ts 的 protectedAreasOf），守卫对任何方式的写入都是"永不"。
import path from "node:path";
import { ENDED_TASK_STATES, EVENT_TYPES, maintainerChannel, type PlanToolkit, type Project, projectToolkit, type SkillChangeAction, type SkillChangeCardPayload, SkillChangeCardPayload as SkillChangeCardPayloadSchema, type SkillChangeCheck, type SkillChangeSubmitter, type SkillChangeUser, type SkillDecidedPayload, type Task, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { buildAgentNotice, buildTimelineRecord } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { changeScopeOf, type McpChangeTarget as ChangeTarget, submitterOfTarget, type SubmitterLookups } from "../mcp/change.ts";
import * as text from "./change-texts.ts";
import type { SkillLibrary } from "./library.ts";
import { REQUEST_SKILL_CHANGE_TOOL } from "./tool-names.ts";

export { REQUEST_SKILL_CHANGE_TOOL } from "./tool-names.ts";

/** 守护进程内部的 skills 频道（前端不订阅）：skill 变更的审批决定（素材的来源） */
export const SKILLS_CHANNEL = "skills";

/** 工具给谁用：项目的负责人（对话段、执行工单），或者任务自己的负责人（和 request_mcp_change 一样的范围） */
export type SkillChangeTarget = ChangeTarget;

export interface SkillChangeServiceOptions extends SubmitterLookups {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  skills: Pick<SkillLibrary, "checkSubmission" | "applySubmission" | "changeable" | "removeSkill" | "find">;
  /** 提交人能提交的地方：自己的工作目录（第一个，相对路径按它解析）、项目档案 */
  sourceRoots(submitter: SkillChangeSubmitter): string[];
  /** 配进提交人的工具包：要和卡片一起落盘的事件；已经有了 changed 是 false。不能改的（项目归档了、任务结束了）抛 RequestRejected */
  addToToolkit(submitter: SkillChangeSubmitter, name: string): { changed: boolean; events: NewEvent[] };
  /** 现在的项目（工具包里有没有它） */
  listProjects(): readonly Project[];
  /** 现在的任务 */
  listTasks(): readonly Task[];
  /** 任务现在生效的计划里的工具包；还没确认计划的没有 */
  taskToolkit(taskId: string): Pick<PlanToolkit, "skills"> | undefined;
  /** 个人助理（设置里勾的那份）用没用它 */
  assistantUses(name: string): boolean;
  /** skill 库变了：让这几个负责人的会话按新的装配重新拉起；assistant 为 true 时个人助理也换 */
  skillChanged?: (change: { maintainerIds: readonly string[]; assistant: boolean; name: string }) => void;
  now: () => string;
  log: (line: string) => void;
}

export interface SkillChangeService {
  /** 负责人的工具：校验 + 出卡（不写文件） */
  requestTool(target: SkillChangeTarget): HostTool;
  /** "skill 变更"卡上的批准、拒绝（批准：写 skill 区 + 自检 + 配进工具包） */
  decide(payload: SkillChangeCardPayload, cardId: string, decision: "approved" | "denied", note: string | undefined, idempotencyKey: string): CardActionEffect<SkillChangeCardPayload>;
}

/** 工具给的目录换成绝对路径（相对的按工作目录） */
const absoluteSource = (given: string, roots: readonly string[]) => (path.isAbsolute(given) || roots[0] === undefined ? given : path.resolve(roots[0], given));

export function createSkillChangeService(options: SkillChangeServiceOptions): SkillChangeService {
  const { store, cards, inbox, skills } = options;

  /** 同名的上一张卡还在等用户 */
  const pendingCardOf = (name: string) =>
    inbox
      .list()
      .flatMap((item) => (item.kind === "card" ? [cards.get(item.cardId)] : []))
      .find((card) => card?.type === "skill_change" && card.status === "pending" && (card.payload as SkillChangeCardPayload).name === name);

  /** 现在在用这个 skill 的：项目（没删掉的）、没结束的任务；带着它们的负责人（要重新拉起的就是这些） */
  const usersOf = (name: string): { users: SkillChangeUser[]; maintainerIds: string[]; assistant: boolean } => {
    const projects = options.listProjects().filter((p) => projectToolkit(p).skills.includes(name));
    const tasks = options.listTasks().filter((task) => !ENDED_TASK_STATES.includes(task.state) && options.taskToolkit(task.id)?.skills.includes(name) === true);
    const assistant = options.assistantUses(name);
    return {
      users: [...projects.map((p): SkillChangeUser => ({ kind: "project", title: p.name })), ...tasks.map((task): SkillChangeUser => ({ kind: "task", title: task.title })), ...(assistant ? [{ kind: "assistant" } as const] : [])],
      maintainerIds: [...new Set([...projects.map((p) => p.maintainerId), ...tasks.map((task) => task.maintainerId)])],
      assistant,
    };
  };

  const payloadOf = (action: SkillChangeAction, given: { name?: string | undefined; path?: string | undefined; why?: string | undefined }, submitter: SkillChangeSubmitter): SkillChangeCardPayload | { refused: string } => {
    const why = given.why === undefined ? {} : { why: given.why };
    if (action === "remove") {
      if (given.name === undefined) return { refused: text.nameRequiredText(action) };
      const current = skills.changeable(given.name);
      return { action, name: given.name, description: current.entry.description, usedBy: usersOf(given.name).users, submitter, ...why };
    }
    if (given.path === undefined) return { refused: text.pathRequiredText(action) };
    if (action === "update" && given.name === undefined) return { refused: text.nameRequiredText(action) };
    const roots = options.sourceRoots(submitter);
    const report = skills.checkSubmission({ source: absoluteSource(given.path, roots), roots, ...(action === "update" ? { replacing: given.name! } : {}) });
    if (action === "add" && given.name !== undefined && given.name !== report.name) return { refused: text.nameMismatchText(given.name, report.name) };
    return { action, name: report.name, description: report.description, source: report.source, ...(action === "update" ? { usedBy: usersOf(report.name).users } : {}), submitter, ...why };
  };

  const requestTool = (target: SkillChangeTarget): HostTool =>
    defineHostTool({
      name: REQUEST_SKILL_CHANGE_TOOL,
      title: text.requestSkillChangeTitle(),
      description: text.requestSkillChangeDescription,
      parameters: Type.Object(
        {
          action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")], { description: text.REQUEST_SKILL_CHANGE_PARAMS.action }),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: text.REQUEST_SKILL_CHANGE_PARAMS.name })),
          path: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: text.REQUEST_SKILL_CHANGE_PARAMS.path })),
          why: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: text.REQUEST_SKILL_CHANGE_PARAMS.why })),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      run: (given) => {
        try {
          const submitter = submitterOfTarget(target, options);
          if (!submitter) return { text: text.noSubmitterText(target.kind === "project" ? target.projectId : target.taskId), isError: true };
          const payload = payloadOf(given.action as SkillChangeAction, given, submitter);
          if ("refused" in payload) return { text: payload.refused, isError: true };
          const waiting = pendingCardOf(payload.name);
          if (waiting) return { text: text.cardWaitingText(payload.name, waiting.id), isError: true };
          const card = cards.buildCreate({ type: "skill_change", payload, urgency: "non_blocking" });
          const item = inbox.buildAdd({
            kind: "card",
            cardId: card.card.id,
            title: text.inboxTitle(payload),
            source: text.sourceOf(submitter),
            origin: changeScopeOf(submitter),
            urgency: "non_blocking",
          });
          store.appendBatch([card.event, item.event]);
          return { text: text.requestedText(payload), cardIds: [card.card.id] };
        } catch (err) {
          if (err instanceof RequestRejected) return { text: text.notChangedText(err.message), isError: true };
          throw err;
        }
      },
    });

  /** 自检：库里读得到、名字说明对；删的是读不到了。对不上不回滚，卡上写明 */
  const selfCheck = (payload: SkillChangeCardPayload): SkillChangeCheck => {
    const time = options.now();
    const found = skills.find([payload.name])[0];
    if (payload.action === "remove") return found ? { ok: false, problem: text.stillThereText(payload.name), time } : { ok: true, time };
    if (!found) return { ok: false, problem: text.notFoundText(payload.name), time };
    if (found.entry.description !== payload.description) return { ok: false, problem: text.mismatchText(payload.description, found.entry.description), time };
    return { ok: true, time };
  };

  const decide: SkillChangeService["decide"] = (payload, cardId, decision, note, idempotencyKey) => {
    const comment = note?.trim() || undefined;
    const { submitter, source } = payload;
    const conversation = maintainerChannel(submitter.maintainerId);
    const scope = changeScopeOf(submitter);
    const decided = (event: SkillDecidedPayload): NewEvent => ({ channel: SKILLS_CHANNEL, type: EVENT_TYPES.skillDecided, payload: event, idempotencyKey: `${idempotencyKey}#decided` });
    const record = (event: SkillDecidedPayload): NewEvent =>
      buildTimelineRecord(conversation, { kind: "skill", summary: text.timelineSummary(event), detail: text.timelineDetail(event, payload) }, scope, { idempotencyKey: `${idempotencyKey}#timeline` }).event;
    const notice = (words: string): NewEvent => buildAgentNotice(conversation, words, `${idempotencyKey}#notice`, scope).event;
    const base = { action: payload.action, name: payload.name, submitter, cardId, ...(comment === undefined ? {} : { note: comment }), ...(source === undefined ? {} : { fingerprint: source.fingerprint }) };
    if (decision === "denied") {
      const event: SkillDecidedPayload = { ...base, decision, applied: false, time: options.now() };
      return { status: "handled", ...(comment === undefined ? {} : { note: comment }), events: [decided(event), record(event), notice(text.deniedNotice(event))] };
    }
    // 先记下在用它的（改了、删了之后要它们重新拉起）；真写 skill 区
    const before = payload.action === "add" ? { maintainerIds: [], assistant: false } : usersOf(payload.name);
    try {
      if (payload.action === "remove") skills.removeSkill(payload.name);
      else if (source) {
        skills.applySubmission({
          source: source.path,
          roots: options.sourceRoots(submitter),
          ...(payload.action === "update" ? { replacing: payload.name } : {}),
          fingerprint: source.fingerprint,
          submittedBy: submitter.kind === "project" ? { kind: "project", title: submitter.projectName } : { kind: "task", title: submitter.taskTitle },
        });
      }
    } catch (err) {
      // 复制、改名这类出错（占着、磁盘满）：抛回去，卡片留在待办，用户可以再点一次；旧版没动
      if (!(err instanceof RequestRejected) || err.code === "internal") throw err;
      // 改不成的（来源变了、重名了、不能改了）：这张卡再点也没用，记下决定和原因，负责人弄好了重新提交
      const event: SkillDecidedPayload = { ...base, decision: "approved", applied: false, problem: err.message, time: options.now() };
      options.log(`skill 变更卡 ${cardId} 批准了但没改成：${err.message}`);
      return { status: "handled", payload: { ...payload, applied: false, problem: err.message }, note: text.notAppliedNote(payload.name, err.message), events: [decided(event), record(event), notice(text.notAppliedNotice(event))] };
    }
    const check = selfCheck(payload);
    // 配进提交人的工具包（加、改）：进库了才配；配不上（项目归档了、任务结束了）skill 留着，卡上写明
    let added = false;
    let toolkitProblem: string | undefined;
    let toolkitChanged = false;
    let toolkitEvents: NewEvent[] = [];
    if (payload.action !== "remove" && check.ok) {
      try {
        const result = options.addToToolkit(submitter, payload.name);
        added = true;
        toolkitChanged = result.changed;
        toolkitEvents = result.events;
      } catch (err) {
        if (!(err instanceof RequestRejected)) throw err;
        toolkitProblem = err.message;
      }
    }
    const event: SkillDecidedPayload = { ...base, decision: "approved", applied: true, check, time: options.now() };
    // 工具包变了的，维护者模块收到事件自己按新工具包重新拉起；没变的（改了内容、工具包里本来就有）这里叫。改、删还要叫上别的在用它的
    // （在通知落盘之前标记好，照 MCP 登记变更的做法）
    const maintainerIds = new Set([...(toolkitChanged ? [] : [submitter.maintainerId]), ...before.maintainerIds]);
    options.skillChanged?.({ maintainerIds: [...maintainerIds], assistant: before.assistant, name: payload.name });
    return {
      status: "handled",
      payload: { ...payload, applied: true, check, ...(payload.action === "remove" ? {} : { addedToToolkit: added }), ...(toolkitProblem === undefined ? {} : { toolkitProblem }) },
      note: text.appliedNote(payload),
      events: [decided(event), ...toolkitEvents, record(event), notice(text.approvedNotice(event, { added, problem: toolkitProblem }))],
    };
  };

  return { requestTool, decide };
}

/** "skill 变更"卡：批准（approve）、拒绝（deny），都可附说明 */
export function skillChangeCardType(service: Pick<SkillChangeService, "decide">) {
  return defineCardType({
    type: "skill_change",
    version: 1,
    payload: SkillChangeCardPayloadSchema,
    actions: {
      approve: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "approved", note, idempotencyKey) },
      deny: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "denied", note, idempotencyKey) },
    },
    toText: text.cardText,
  });
}
