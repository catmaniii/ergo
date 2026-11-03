// skill 变更（补齐负责人提交 skill，和登记 MCP 走一样的路）：给负责人一个工具 request_skill_change——
// 把一个 skill 加进 skill 库、改、删。整条链照 MCP 登记变更（mcp/change.ts）：
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
//
// 秘书也能提交（propose_skill，只能加），走的是同一张卡、同一段校验和写入：
// - 内容直接给（名字、触发说明、正文、为什么），运行时拼成 SKILL.md。**卡上的那一份就是真相**：校验时、用户确认后写入时，运行时都把它
//   落到秘书草稿区里单独的一格（SKILL_DRAFTS_FOLDER 下面，随机名），当作来源交给 skill 库，用完整格删掉——秘书事后改草稿区、
//   临时区每天清理都碰不到它；写入时照样核内容指纹（和卡上的对得上才进库）。提交时 skill 区一个字节都不写；
// - 库里已有同名的不当场拒绝，照样出卡，卡上带着同名检查（SkillLibrary.previewSubmission）：用户选覆盖（走"改"那条，旧版进 .history/；
//   框架自带的、集合成员照旧不能覆盖）、改名（填新名字，同导入并改名）或放弃（就是拒绝）。选的那条还进不了库（新名字也重名、
//   同名的已经不能覆盖了）时这一下不算，卡留着，换一个选；
// - 进库后不配进任何项目的工具包，只配进秘书用的 skill（SecretarySkills.add），秘书做完手头这一条就按新名单重新装配，下一轮起能用；
// - 时间线和通知在秘书的会话里；批准、拒绝照样记 skill_decided。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  ENDED_TASK_STATES,
  EVENT_TYPES,
  IMPORT_NAME_PATTERN,
  maintainerChannel,
  type McpChangeSubmitter,
  type PlanToolkit,
  type Project,
  projectToolkit,
  type SkillChangeAction,
  type SkillChangeCardPayload,
  SkillChangeCardPayload as SkillChangeCardPayloadSchema,
  type SkillChangeCheck,
  type SkillChangeSubmitter,
  type SkillChangeUser,
  type SkillDecidedPayload,
  SkillRenameInput,
  type Task,
  Type,
} from "@ergo/protocol";
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
import { PROPOSE_SKILL_TOOL, REQUEST_SKILL_CHANGE_TOOL } from "./tool-names.ts";

export { PROPOSE_SKILL_TOOL, REQUEST_SKILL_CHANGE_TOOL } from "./tool-names.ts";

/** 守护进程内部的 skills 频道（前端不订阅）：skill 变更的审批决定（素材的来源） */
export const SKILLS_CHANNEL = "skills";

/** 秘书提交的 SKILL.md 校验、写入时临时落在秘书草稿区里的哪个子文件夹（用完就删） */
export const SKILL_DRAFTS_FOLDER = ".skill-drafts";

/** 秘书给的说明最多多少字（Agent Skills 的约定）、正文最多多少字（SKILL.md 本身另有 512 KB 的上限） */
const DESCRIPTION_MAX = 1024;
const BODY_MAX = 100_000;

/** 工具给谁用：项目的负责人（对话段、执行工单），或者任务自己的负责人（和 request_mcp_change 一样的范围） */
export type SkillChangeTarget = ChangeTarget;

/** 负责人（项目的、任务的）这一种提交人：来源在它的工作目录里，进库后配进它的工具包 */
type OwnerSubmitter = McpChangeSubmitter;

/** 秘书提交的卡上和库里同名时用户选的：覆盖同名的、改名后进库 */
export type SameNameChoice = { kind: "overwrite" } | { kind: "rename"; name: string };

export interface SkillChangeServiceOptions extends SubmitterLookups {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  skills: Pick<SkillLibrary, "checkSubmission" | "previewSubmission" | "applySubmission" | "changeable" | "removeSkill" | "find">;
  /** 负责人能提交的地方：自己的工作目录（第一个，相对路径按它解析）、项目档案 */
  sourceRoots(submitter: OwnerSubmitter): string[];
  /** 配进提交人的工具包：要和卡片一起落盘的事件；已经有了 changed 是 false。不能改的（项目归档了、任务结束了）抛 RequestRejected */
  addToToolkit(submitter: OwnerSubmitter, name: string): { changed: boolean; events: NewEvent[] };
  /**
   * 秘书的草稿区：秘书提交的 SKILL.md（卡上的那一份）校验、写入时由运行时落到它下面的 SKILL_DRAFTS_FOLDER 里单独一格，
   * 用完就删。不给就不能决定秘书提交的卡（秘书的工具也不该给出去）
   */
  secretaryScratch?: string;
  /** 秘书提交的进库了：配进秘书用的 skill（SecretarySkills.add）；名单变了返回 true。配不上的抛 RequestRejected */
  addToSecretary?: (name: string) => boolean;
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
  /** 秘书的工具：内容直接给，运行时拼成 SKILL.md、校验 + 出卡（skill 区不写；和库里同名的照样出卡，带着同名检查） */
  secretaryTool(): HostTool;
  /**
   * "skill 变更"卡上的批准、拒绝（批准：写 skill 区 + 自检 + 配进工具包）；秘书提交的和库里同名时还能覆盖、改名（choice）。
   * 选的那条进不了库时抛 RequestRejected，卡留着
   */
  decide(payload: SkillChangeCardPayload, cardId: string, decision: "approved" | "denied", note: string | undefined, idempotencyKey: string, choice?: SameNameChoice): CardActionEffect<SkillChangeCardPayload>;
}

/** 工具给的目录换成绝对路径（相对的按工作目录） */
const absoluteSource = (given: string, roots: readonly string[]) => (path.isAbsolute(given) || roots[0] === undefined ? given : path.resolve(roots[0], given));

/** 说明压成一行：换行、制表符、控制字符都换成空格（SKILL.md 里写成折叠块，只认一行） */
const oneLine = (s: string) => s.replace(/[\s\p{Cc}]+/gu, " ").trim();

/**
 * 秘书给的内容拼成 SKILL.md：名字是小写字母、数字、短横线，照写；说明写成折叠块（`>-`），冒号、引号、# 都照字面，
 * pi 用的 YAML 和 skill 库自己的读法读出来一样；正文原样接在后面
 */
export function composeSkillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\n${body}\n`;
}

/** 会话和归属：负责人提交的记在它的会话上（带项目、任务），秘书提交的记在秘书的主线上 */
const conversationOf = (submitter: SkillChangeSubmitter) => (submitter.kind === "secretary" ? CHANNELS.secretary : maintainerChannel(submitter.maintainerId));
const scopeOf = (submitter: SkillChangeSubmitter) => (submitter.kind === "secretary" ? {} : changeScopeOf(submitter));
const originOf = (submitter: SkillChangeSubmitter) => (submitter.kind === "secretary" ? { conversation: CHANNELS.secretary } : changeScopeOf(submitter));

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

  /**
   * 秘书提交的 SKILL.md 落到草稿区里单独的一格（<草稿区>/.skill-drafts/<随机>/<目录名>/SKILL.md），当作来源交给 fn
   * （校验、写进 skill 区），完了整格删掉
   */
  const withDraft = <T>(dirName: string, skillMd: string, fn: (source: string, roots: string[]) => T): T => {
    if (options.secretaryScratch === undefined) throw new Error("没给秘书的草稿区，决定不了秘书提交的 skill"); // @i18n-ignore log：编程错误
    const root = path.join(options.secretaryScratch, SKILL_DRAFTS_FOLDER);
    const slot = path.join(root, randomUUID());
    const dir = path.join(slot, dirName);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd);
      return fn(dir, [root]);
    } finally {
      try {
        fs.rmSync(slot, { recursive: true, force: true });
      } catch (err) {
        options.log(`删秘书提交的 skill 的临时目录 ${slot} 出错：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const payloadOf = (action: SkillChangeAction, given: { name?: string | undefined; path?: string | undefined; why?: string | undefined }, submitter: OwnerSubmitter): SkillChangeCardPayload | { refused: string } => {
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

  /** 出卡：卡和待办里的一条一起落盘 */
  const submit = (payload: SkillChangeCardPayload): string => {
    const card = cards.buildCreate({ type: "skill_change", payload, urgency: "non_blocking" });
    const item = inbox.buildAdd({
      kind: "card",
      cardId: card.card.id,
      title: text.inboxTitle(payload),
      source: text.sourceOf(payload.submitter),
      origin: originOf(payload.submitter),
      urgency: "non_blocking",
    });
    store.appendBatch([card.event, item.event]);
    return card.card.id;
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
          return { text: text.requestedText(payload), cardIds: [submit(payload)] };
        } catch (err) {
          if (err instanceof RequestRejected) return { text: text.notChangedText(err.message), isError: true };
          throw err;
        }
      },
    });

  const secretaryTool = (): HostTool =>
    defineHostTool({
      name: PROPOSE_SKILL_TOOL,
      title: text.proposeSkillTitle(),
      description: text.PROPOSE_SKILL_DESCRIPTION,
      parameters: Type.Object(
        {
          name: Type.String({ pattern: IMPORT_NAME_PATTERN, description: text.PROPOSE_SKILL_PARAMS.name }),
          description: Type.String({ minLength: 1, maxLength: DESCRIPTION_MAX, description: text.PROPOSE_SKILL_PARAMS.description }),
          body: Type.String({ minLength: 1, maxLength: BODY_MAX, description: text.PROPOSE_SKILL_PARAMS.body }),
          why: Type.String({ minLength: 1, maxLength: 1000, description: text.PROPOSE_SKILL_PARAMS.why }),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      run: (given) => {
        try {
          const description = oneLine(given.description);
          if (description === "") return { text: text.emptyFieldText("description"), isError: true };
          const body = given.body.replace(/\r\n?/g, "\n").trim();
          if (body === "") return { text: text.emptyFieldText("body"), isError: true };
          const waiting = pendingCardOf(given.name);
          if (waiting) return { text: text.cardWaitingText(given.name, waiting.id), isError: true };
          // 只校验：落到草稿区里的一格、交给 skill 库看一遍（和库里同名的不拒绝，交回同名检查），完了就删
          const preview = withDraft(given.name, composeSkillMd(given.name, description, body), (source, roots) => skills.previewSubmission({ source, roots }));
          const why = given.why.trim();
          const payload: SkillChangeCardPayload = {
            action: "add",
            name: preview.name,
            description: preview.description,
            source: preview.source,
            submitter: { kind: "secretary" },
            ...(why === "" ? {} : { why }),
            ...(preview.sameName ? { sameName: preview.sameName } : {}),
            // 能覆盖的：列出现在在用同名那个的（覆盖了它们下次装配就是这一份）
            ...(preview.sameName?.overwritable ? { usedBy: usersOf(preview.name).users } : {}),
          };
          return { text: text.proposedText(payload), cardIds: [submit(payload)] };
        } catch (err) {
          if (err instanceof RequestRejected) return { text: text.notChangedText(err.message), isError: true };
          throw err;
        }
      },
    });

  /** 自检：库里读得到、名字说明对；删的是读不到了。对不上不回滚，卡上写明 */
  const selfCheck = (action: SkillChangeAction, name: string, description: string): SkillChangeCheck => {
    const time = options.now();
    const found = skills.find([name])[0];
    if (action === "remove") return found ? { ok: false, problem: text.stillThereText(name), time } : { ok: true, time };
    if (!found) return { ok: false, problem: text.notFoundText(name), time };
    if (found.entry.description !== description) return { ok: false, problem: text.mismatchText(description, found.entry.description), time };
    return { ok: true, time };
  };

  const decide: SkillChangeService["decide"] = (payload, cardId, decision, note, idempotencyKey, choice) => {
    const comment = note?.trim() || undefined;
    const { submitter, source } = payload;
    const secretary = submitter.kind === "secretary";
    // 覆盖、改名只给秘书提交的加 skill：同名检查是它的卡才有的
    if (choice && (!secretary || payload.action !== "add" || !source)) throw new RequestRejected("bad_params", text.resolutionNotForThisText());
    if (choice?.kind === "overwrite" && payload.sameName?.overwritable !== true) throw new RequestRejected("not_allowed", text.cannotOverwriteText(payload.sameName?.problem ?? text.sameNameText(payload.sameName)));
    const conversation = conversationOf(submitter);
    const scope = scopeOf(submitter);
    // 真正做的：覆盖就是改同名的那个，改名是换个名字加
    const action: SkillChangeAction = choice?.kind === "overwrite" ? "update" : payload.action;
    const name = choice?.kind === "rename" ? choice.name : payload.name;
    const resolution = choice === undefined ? {} : { resolution: choice.kind, ...(choice.kind === "rename" ? { renamedFrom: payload.name } : {}) };
    const decided = (event: SkillDecidedPayload): NewEvent => ({ channel: SKILLS_CHANNEL, type: EVENT_TYPES.skillDecided, payload: event, idempotencyKey: `${idempotencyKey}#decided` });
    const record = (event: SkillDecidedPayload): NewEvent =>
      buildTimelineRecord(conversation, { kind: "skill", summary: text.timelineSummary(event), detail: text.timelineDetail(event, payload) }, scope, { idempotencyKey: `${idempotencyKey}#timeline` }).event;
    const notice = (words: string): NewEvent => buildAgentNotice(conversation, words, `${idempotencyKey}#notice`, scope).event;
    const base = { action, name, submitter, cardId, ...resolution, ...(comment === undefined ? {} : { note: comment }), ...(source === undefined ? {} : { fingerprint: source.fingerprint }) };
    if (decision === "denied") {
      const event: SkillDecidedPayload = { ...base, decision, applied: false, time: options.now() };
      return { status: "handled", ...(comment === undefined ? {} : { note: comment }), events: [decided(event), record(event), notice(secretary ? text.secretaryDeniedNotice(event) : text.deniedNotice(event))] };
    }
    // 先记下在用它的（改了、删了之后要它们重新拉起）；真写 skill 区
    const before = action === "add" ? { maintainerIds: [], assistant: false } : usersOf(name);
    const replacing = action === "update" ? payload.name : undefined;
    const rename = choice?.kind === "rename" ? choice.name : undefined;
    const submission = { ...(replacing === undefined ? {} : { replacing }), ...(rename === undefined ? {} : { rename }) };
    try {
      if (action === "remove") skills.removeSkill(name);
      else if (source && submitter.kind === "secretary") {
        // 秘书提交的：卡上的那一份落到草稿区里一格当来源。选了覆盖、改名的先校验一遍：进不了库就不算这一下，卡留着换一个选
        withDraft(payload.name, source.skillMd, (dir, roots) => {
          if (choice) {
            try {
              skills.checkSubmission({ source: dir, roots, ...submission });
            } catch (err) {
              if (err instanceof RequestRejected && err.code !== "internal") throw new RequestRejected("conflict", text.resolutionFailedText(err.message));
              throw err;
            }
          }
          skills.applySubmission({ source: dir, roots, ...submission, fingerprint: source.fingerprint, submittedBy: { kind: "secretary" } });
        });
      } else if (source && submitter.kind !== "secretary") {
        skills.applySubmission({
          source: source.path,
          roots: options.sourceRoots(submitter),
          ...submission,
          fingerprint: source.fingerprint,
          submittedBy: submitter.kind === "project" ? { kind: "project", title: submitter.projectName } : { kind: "task", title: submitter.taskTitle },
        });
      }
    } catch (err) {
      // 复制、改名这类出错（占着、磁盘满）：抛回去，卡片留在待办，用户可以再点一次；旧版没动
      if (!(err instanceof RequestRejected) || err.code === "internal") throw err;
      // 选了覆盖、改名但进不了库：这一下不算，卡留着
      if (choice) throw err;
      // 改不成的（来源变了、重名了、不能改了）：这张卡再点也没用，记下决定和原因，提交的人弄好了重新提交
      const event: SkillDecidedPayload = { ...base, decision: "approved", applied: false, problem: err.message, time: options.now() };
      options.log(`skill 变更卡 ${cardId} 批准了但没改成：${err.message}`);
      return {
        status: "handled",
        payload: { ...payload, applied: false, problem: err.message },
        note: text.notAppliedNote(payload.name, err.message),
        events: [decided(event), record(event), notice(secretary ? text.secretaryNotAppliedNotice(event) : text.notAppliedNotice(event))],
      };
    }
    const check = selfCheck(action, name, payload.description);
    // 配进提交人的工具包（加、改；秘书提交的配进它用的 skill）：进库了才配；配不上（项目归档了、任务结束了）skill 留着，卡上写明
    let added = false;
    let toolkitProblem: string | undefined;
    let toolkitChanged = false;
    let toolkitEvents: NewEvent[] = [];
    if (action !== "remove" && check.ok) {
      try {
        if (submitter.kind === "secretary") {
          if (options.addToSecretary) {
            toolkitChanged = options.addToSecretary(name);
            added = true;
          }
        } else {
          const result = options.addToToolkit(submitter, name);
          added = true;
          toolkitChanged = result.changed;
          toolkitEvents = result.events;
        }
      } catch (err) {
        if (!(err instanceof RequestRejected)) throw err;
        toolkitProblem = err.message;
      }
    }
    const event: SkillDecidedPayload = { ...base, decision: "approved", applied: true, check, time: options.now() };
    // 工具包变了的，负责人模块收到事件自己按新工具包重新拉起（秘书的名单变了，SecretarySkills 自己叫秘书重新装配）；
    // 没变的（改了内容、工具包里本来就有）这里叫。改、删还要叫上别的在用它的（在通知落盘之前标记好，照 MCP 登记变更的做法）
    const own = submitter.kind === "secretary" || toolkitChanged ? [] : [submitter.maintainerId];
    const maintainerIds = new Set([...own, ...before.maintainerIds]);
    options.skillChanged?.({ maintainerIds: [...maintainerIds], assistant: before.assistant || (secretary && !toolkitChanged), name });
    const words = secretary ? text.secretaryApprovedNotice(event, { added, problem: toolkitProblem }) : text.approvedNotice(event, { added, problem: toolkitProblem });
    return {
      status: "handled",
      payload: {
        ...payload,
        applied: true,
        check,
        ...(choice === undefined ? {} : { resolution: choice.kind, ...(choice.kind === "rename" ? { renamedTo: choice.name } : {}) }),
        ...(action === "remove" ? {} : { addedToToolkit: added }),
        ...(toolkitProblem === undefined ? {} : { toolkitProblem }),
      },
      note: text.appliedNote({ action, name }),
      events: [decided(event), ...toolkitEvents, record(event), notice(words)],
    };
  };

  return { requestTool, secretaryTool, decide };
}

/** "skill 变更"卡：批准（approve）、拒绝（deny），都可附说明；秘书提交的和库里同名时还有覆盖（overwrite）、改名（rename，带新名字） */
export function skillChangeCardType(service: Pick<SkillChangeService, "decide">) {
  return defineCardType({
    type: "skill_change",
    version: 2,
    payload: SkillChangeCardPayloadSchema,
    actions: {
      approve: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "approved", note, idempotencyKey) },
      deny: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "denied", note, idempotencyKey) },
      overwrite: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "approved", note, idempotencyKey, { kind: "overwrite" }) },
      rename: { input: SkillRenameInput, run: ({ card, payload, note, input, idempotencyKey }) => service.decide(payload, card.id, "approved", note, idempotencyKey, { kind: "rename", name: input.name }) },
    },
    toText: text.cardText,
  });
}
