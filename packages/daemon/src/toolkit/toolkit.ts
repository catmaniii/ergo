// 工具包（ADR-0003，规格第 3、11、20、21 节，27 号票）：skill 名单、MCP 名单、bash 开关、联网开关。
// 项目的工具包在项目里（立项书确认时生效），任务的在它现在生效的计划里。执行项目的任务时：skill 取两者的并集（skill 不是权限），
// bash、联网、MCP 取交集（effectiveToolkit）。这里管工具包怎么改、会话装配时怎么解析：
// - 装配：skill 名单经 skill 库解析成目录（宿主协议的 skillPaths），MCP 名单变成守护进程代为执行的 MCP 工具（mcp/）；
// - 工具包里的 skill 只能从 skill 库里选、MCP 只能选登记了的（nameProblems：改工具包、提交计划、计划变更、自行调整都查）；
// - 用户在项目页、任务详情里直接改（set_toolkit 请求）：扩大、减少都直接写进工具包，不出计划变更卡；
// - 维护者自己增减 skill（ADJUST_SKILLS_TOOL）：写进它所在的那一层（任务里的只改任务，不改项目），记进时间线；
//   可以写集合名整套增减（72 号票：比如 pstack，展开成它的全部成员；工具包里记的始终是 skill 名）；
// - 维护者要开 bash、加 MCP、开联网：在任务里只能提交计划变更（14 号票，卡上列出"工具包变更"）；不在任务里时（项目维护者的对话段）
//   用 REQUEST_TOOLKIT_CHANGE_TOOL 提交一张"工具包变更"卡进待我处理，批准后加进项目的工具包，拒绝则不变；减少能力随时可以，直接生效；
// - 工具包变了（不论谁改的）：项目、任务的事件落盘后，维护者模块按新工具包重新装配会话（等它做完手头这一步，接着原会话干）。
// 用户的批准、拒绝、直接改都是"审批决定"素材（toolkit_decided，material-source.ts）。给人和模型看的话在 texts.ts。
import {
  capabilityText,
  EVENT_TYPES,
  type ImportSkillBody,
  type ImportSkillResult,
  maintainerChannel,
  type PlanToolkit,
  projectToolkit,
  type SetToolkitParams,
  type SetToolkitResult,
  type ToolkitCapability,
  type ToolkitCatalog,
  type ToolkitChangeCardPayload,
  ToolkitChangeCardPayload as ToolkitChangeCardPayloadSchema,
  type ToolkitDecidedPayload,
  toolkitExpansions,
  Type,
  withCapabilities,
  withoutCapabilities,
} from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { McpService } from "../mcp/mcp.ts";
import type { ToolkitProjects } from "../projects/api.ts";
import type { SkillLibrary } from "../skills/library.ts";
import { type SkillCommand, skillCommands, skillDirProblems } from "../skills/skill-command.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import type { TaskService } from "../tasks/tasks.ts";
import * as text from "./texts.ts";
import { ADJUST_SKILLS_TOOL, REQUEST_TOOLKIT_CHANGE_TOOL } from "./tool-names.ts";

export { ADJUST_SKILLS_TOOL, REQUEST_TOOLKIT_CHANGE_TOOL } from "./tool-names.ts";

/** 守护进程内部的 toolkits 频道（前端不订阅）：工具包的审批决定（素材的来源） */
export const TOOLKITS_CHANNEL = "toolkits";

/** 维护者增减 skill 时改的是谁的工具包：执行中的任务（只改任务这一层），或项目（对话段） */
export type SkillTarget = { kind: "task"; scope: MaintainerScope } | { kind: "project"; projectId: string; maintainerId: string };

export interface ToolkitServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  /** 项目系统给工具包的（277 号票的入口）：找项目、改项目的工具包 */
  projects: ToolkitProjects;
  tasks: TaskService;
  /** 执行控制器（建在这之后：现取） */
  execution: () => TaskExecution;
  skills: SkillLibrary;
  mcp: McpService;
  now: () => string;
  log: (line: string) => void;
}

export interface ToolkitService {
  /** 工具包里的 skill 名 → 目录（装配会话时经 skillPaths 交给子进程） */
  skillPaths(names: readonly string[]): string[];
  /** 库里每个 skill 的斜杠命令（82 号票：命令名是目录名，几个目录名相同时集合里的是"集合名:目录名"，按整个库现算） */
  skillCommands(): SkillCommand[];
  /** 会话里的 MCP 工具（工具包列了的、联网关着时去掉要联网的） */
  mcpTools(toolkit: Pick<PlanToolkit, "mcp" | "network">): HostTool[];
  /** 工具包里不在 skill 库里的 skill、没登记的 MCP（一条一句；都在时是空的）：提交计划、计划变更、自行调整都查 */
  nameProblems(toolkit: Pick<PlanToolkit, "skills" | "mcp">): string[];
  /** 工具包里能选的东西（skill 库、集合、登记的 MCP；skill 目录名不合规的说明，82 号票） */
  catalog(): ToolkitCatalog;
  /** 设置里的 skill 库页导入一个 skill（可以改名）或一个集合（72 号票） */
  importSkill(request: ImportSkillBody): ImportSkillResult;
  /** 用户在项目页、任务详情里直接改工具包（set_toolkit 请求） */
  set(params: SetToolkitParams, idempotencyKey: string): SetToolkitResult;
  /** 维护者增减 skill 的工具 */
  skillTool(target: SkillTarget): HostTool;
  /** 项目维护者不在任务里时申请加能力（出"工具包变更"卡）、减少能力（直接生效）的工具 */
  requestTool(projectId: string, maintainerId: string): HostTool;
  /** "工具包变更"卡上的批准、拒绝 */
  decide(payload: ToolkitChangeCardPayload, cardId: string, decision: "approved" | "denied", note: string | undefined, idempotencyKey: string): CardActionEffect<ToolkitChangeCardPayload>;
}

export function createToolkitService(options: ToolkitServiceOptions): ToolkitService {
  const { store, cards, inbox, projects, skills, mcp } = options;

  const nameProblems = (toolkit: Pick<PlanToolkit, "skills" | "mcp">): string[] => {
    const missingSkills = skills.missing(toolkit.skills);
    const missingMcp = toolkit.mcp.filter((m) => !mcp.has(m));
    return [...(missingSkills.length > 0 ? [text.unknownSkillsText(missingSkills)] : []), ...(missingMcp.length > 0 ? [text.unknownMcpText(missingMcp)] : [])];
  };

  const decidedEvent = (payload: Omit<ToolkitDecidedPayload, "time">, key?: string): NewEvent => ({
    channel: TOOLKITS_CHANNEL,
    type: EVENT_TYPES.toolkitDecided,
    payload: { ...payload, time: options.now() } satisfies ToolkitDecidedPayload,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });

  const mustProject = (projectId: string) => {
    const project = projects.get(projectId);
    if (!project) throw new RequestRejected("not_found", text.projectNotFoundText(projectId));
    return project;
  };

  /** 任务现在生效的计划里的工具包 */
  const taskToolkit = (taskId: string): PlanToolkit => {
    const stored = options.tasks.confirmedPlan(taskId);
    if (!stored) throw new RequestRejected("not_allowed", text.planNotConfirmedText());
    return stored.plan.toolkit;
  };

  const set = (params: SetToolkitParams, idempotencyKey: string): SetToolkitResult => {
    // 同一个幂等键重发：照现在的样子回
    if (store.eventByIdempotencyKey(`${idempotencyKey}#decided`)) {
      const now = params.target.kind === "project" ? projectToolkit(mustProject(params.target.projectId)) : taskToolkit(params.target.taskId);
      return { toolkit: now, changed: true };
    }
    const problems = nameProblems(params.toolkit);
    if (problems.length > 0) throw new RequestRejected("bad_params", text.problemsText(problems));
    const target = params.target;
    if (target.kind === "project") {
      const project = mustProject(target.projectId);
      const before = projectToolkit(project);
      const decided = decidedEvent({ decision: "edited", target, targetTitle: project.name, before, after: params.toolkit }, `${idempotencyKey}#decided`);
      const result = projects.changeToolkit(project.id, params.toolkit, { by: "user", why: text.editedInProjectPage(), events: [decided] });
      return { toolkit: result.after, changed: result.changed };
    }
    const task = options.tasks.get(target.taskId);
    if (!task) throw new RequestRejected("not_found", text.taskNotFoundText(target.taskId));
    const before = taskToolkit(task.id);
    const decided = decidedEvent({ decision: "edited", target, targetTitle: task.title, before, after: params.toolkit }, `${idempotencyKey}#decided`);
    const result = options.execution().changeToolkit({ taskId: task.id, toolkit: params.toolkit, by: "user", why: text.editedInTaskDetail(), events: [decided] });
    return { toolkit: result.after, changed: result.changed };
  };

  /** 还在等用户的"工具包变更"卡（这个项目的） */
  const pendingCardOf = (projectId: string) =>
    inbox
      .list()
      .flatMap((item) => (item.kind === "card" ? [cards.get(item.cardId)] : []))
      .find((card) => card?.type === "toolkit_change" && card.status === "pending" && (card.payload as ToolkitChangeCardPayload).projectId === projectId);

  const skillTool = (target: SkillTarget): HostTool =>
    defineHostTool({
      name: ADJUST_SKILLS_TOOL,
      title: text.adjustSkillsTitle(),
      description: text.adjustSkillsDescription,
      parameters: Type.Object(
        {
          add: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20, description: text.ADJUST_SKILLS_PARAMS.add })),
          remove: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20, description: text.ADJUST_SKILLS_PARAMS.remove })),
          why: Type.String({ minLength: 1, maxLength: 300, description: text.ADJUST_SKILLS_PARAMS.why }),
        },
        { additionalProperties: false },
      ),
      // 去掉原有的 skill 算删改，只加算动手
      modifiesWith: ["remove"],
      readOnlyOrIdempotent: true,
      run: ({ add: addNames = [], remove: removeNames = [], why }) => {
        // 集合名展开成它的全部成员（72 号票）；去掉时写的名字不在库里的（比如被删了的）原样去掉
        const added = skills.expand(addNames);
        if (added.unknown.length > 0) return { text: text.notInLibraryText(added.unknown, skills.list(), skills.collections()), isError: true };
        const add = added.skills;
        const removed = skills.expand(removeNames);
        const remove = [...removed.skills, ...removed.unknown];
        const adjust = (t: PlanToolkit): PlanToolkit => ({ ...t, skills: [...t.skills.filter((s) => !remove.includes(s)), ...add.filter((s) => !t.skills.includes(s) && !remove.includes(s))] });
        const reason = why.trim();
        try {
          if (target.kind === "project") {
            const result = projects.changeToolkit(target.projectId, adjust(projectToolkit(mustProject(target.projectId))), { by: "maintainer", why: text.skillsAdjustedWhy(reason) });
            return { text: text.skillsAdjustedText(result.before, result.after) };
          }
          const task = options.tasks.get(target.scope.taskId);
          if (!task || task.maintainerId !== target.scope.maintainerId) return { text: text.notYourTaskText(target.scope.taskId), isError: true };
          // 只改任务这一层：skill 不是权限，执行时取项目工具包和任务的并集，项目的工具包不跟着改
          const result = options.execution().changeToolkit({ taskId: task.id, toolkit: adjust(taskToolkit(task.id)), by: "maintainer", why: text.skillsAdjustedWhy(reason) });
          const project = projects.projectOf(task);
          const stillFromProject = project ? remove.filter((s) => projectToolkit(project).skills.includes(s)) : [];
          return { text: text.skillsAdjustedText(result.before, result.after, stillFromProject) };
        } catch (err) {
          if (err instanceof RequestRejected) return { text: text.notChangedText(err.message), isError: true };
          throw err;
        }
      },
    });

  const requestTool = (projectId: string, maintainerId: string): HostTool =>
    defineHostTool({
      name: REQUEST_TOOLKIT_CHANGE_TOOL,
      title: text.requestToolkitChangeTitle(),
      description: text.requestToolkitChangeDescription,
      parameters: Type.Object(
        {
          bash: Type.Optional(Type.Boolean({ description: text.REQUEST_TOOLKIT_CHANGE_PARAMS.bash })),
          network: Type.Optional(Type.Boolean({ description: text.REQUEST_TOOLKIT_CHANGE_PARAMS.network })),
          addMcp: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10, description: text.REQUEST_TOOLKIT_CHANGE_PARAMS.addMcp })),
          removeMcp: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10, description: text.REQUEST_TOOLKIT_CHANGE_PARAMS.removeMcp })),
          why: Type.String({ minLength: 1, maxLength: 1000, description: text.REQUEST_TOOLKIT_CHANGE_PARAMS.why }),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      run: ({ bash, network, addMcp = [], removeMcp = [], why }) => {
        const reason = why.trim();
        const unknown = addMcp.filter((m) => !mcp.has(m));
        if (unknown.length > 0) return { text: text.unregisteredMcpText(unknown, mcp.catalog().servers.map((s) => s.name)), isError: true };
        try {
          const project = mustProject(projectId);
          const current = projectToolkit(project);
          const removals: ToolkitCapability[] = [...(bash === false ? [{ kind: "bash" } as const] : []), ...(network === false ? [{ kind: "network" } as const] : []), ...removeMcp.map((name) => ({ kind: "mcp" as const, name }))];
          const lines: string[] = [];
          let now = current;
          if (removals.length > 0) {
            const result = projects.changeToolkit(project.id, withoutCapabilities(current, removals), { by: "maintainer", why: text.reducedWhy(reason) });
            now = result.after;
            lines.push(text.reducedText(result.before, result.after, result.changed));
          }
          const wanted: ToolkitCapability[] = [...(bash === true ? [{ kind: "bash" } as const] : []), ...(network === true ? [{ kind: "network" } as const] : []), ...addMcp.map((name) => ({ kind: "mcp" as const, name }))];
          const additions = toolkitExpansions(now, withCapabilities(now, wanted));
          if (additions.length === 0) {
            if (lines.length === 0) lines.push(text.NOTHING_TO_REQUEST);
            return { text: lines.join("\n") };
          }
          const waiting = pendingCardOf(project.id);
          if (waiting) return { text: [...lines, text.cardWaitingText(waiting.id)].join("\n"), isError: lines.length === 0 };
          const payload: ToolkitChangeCardPayload = {
            projectId: project.id,
            projectName: project.name,
            maintainerId,
            why: reason,
            before: now,
            after: withCapabilities(now, additions),
            additions: additions.map(capabilityText),
          };
          const card = cards.buildCreate({ type: "toolkit_change", payload, urgency: "non_blocking" });
          const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: text.toolkitChangeInboxTitle(project.name, payload.additions), source: text.toolkitChangeSource(project.name), origin: { projectId: project.id }, urgency: "non_blocking" });
          store.appendBatch([card.event, item.event]);
          lines.push(text.requestedText(payload.additions));
          return { text: lines.join("\n"), cardIds: [card.card.id] };
        } catch (err) {
          if (err instanceof RequestRejected) return { text: text.notChangedText(err.message), isError: true };
          throw err;
        }
      },
    });

  const decide: ToolkitService["decide"] = (payload, cardId, decision, note, idempotencyKey) => {
    const project = mustProject(payload.projectId);
    const comment = note?.trim() || undefined;
    const target = { kind: "project" as const, projectId: project.id };
    const notice = (words: string) => buildAgentNotice(maintainerChannel(project.maintainerId), words, `${idempotencyKey}#notice`, { projectId: project.id }).event;
    if (decision === "denied") {
      const decided = decidedEvent({ decision, target, targetTitle: project.name, before: payload.before, after: payload.after, cardId, ...(comment ? { note: comment } : {}) }, `${idempotencyKey}#decided`);
      return { status: "handled", ...(comment ? { note: comment } : {}), events: [decided, notice(text.deniedNotice(payload.additions, comment))] };
    }
    // 批准：现在的工具包（申请之后可能又改过）加上要加的能力；登记已经撤掉的 MCP 不加
    const wanted = toolkitExpansions(payload.before, payload.after).filter((c) => c.kind !== "mcp" || mcp.has(c.name));
    const current = projectToolkit(project);
    const applied = withCapabilities(current, wanted);
    const decided = decidedEvent({ decision, target, targetTitle: project.name, before: current, after: applied, cardId, ...(comment ? { note: comment } : {}) }, `${idempotencyKey}#decided`);
    const built = projects.buildToolkitChange(project.id, applied, { by: "user", why: text.approvedWhy() });
    return {
      status: "handled",
      payload: { ...payload, applied: built.after },
      ...(comment ? { note: comment } : {}),
      events: [decided, ...built.events, notice(text.approvedNotice(built.before, built.after, comment))],
    };
  };

  return {
    skillPaths: (names) => skills.pathsOf(names),
    skillCommands: () => skillCommands(skills.skills()),
    mcpTools: (toolkit) => mcp.hostToolsFor(toolkit),
    nameProblems,
    catalog() {
      const registered = mcp.catalog();
      const dirProblems = skillDirProblems(skills.skills());
      return {
        skills: skills.list(),
        collections: skills.collections(),
        mcp: registered.servers,
        ...(registered.problem === undefined ? {} : { mcpProblem: registered.problem }),
        ...(dirProblems.length > 0 ? { skillDirProblems: dirProblems } : {}),
      };
    },
    importSkill: (request) => skills.importFrom(request),
    set,
    skillTool,
    requestTool,
    decide,
  };
}

/** "工具包变更"卡：批准（approve）、拒绝（deny），都可附说明 */
export function toolkitChangeCardType(service: Pick<ToolkitService, "decide">) {
  return defineCardType({
    type: "toolkit_change",
    version: 1,
    payload: ToolkitChangeCardPayloadSchema,
    actions: {
      approve: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "approved", note, idempotencyKey) },
      deny: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "denied", note, idempotencyKey) },
    },
    toText: text.toolkitChangeCardText,
  });
}
