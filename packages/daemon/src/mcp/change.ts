// MCP 登记变更（239 号票）：给维护者一个工具 request_mcp_change——把一条 MCP 登记加、改、删。整条链照 27 号票的工具包变更：
// - 工具只校验 + 出一张"MCP 登记变更"卡（mcp_change）进待我处理，**不写任何文件**；校验不过当场回原因、不出卡；
// - 用户在卡上确认之后，运行时按 name 合并写进数据目录配置区的 mcp.json（mcp/writer.ts：保留别的条目、原子写、
//   写前留一份进 config/.history/），然后真把这个 MCP 拉起来一次做自检（tools/list），结果写进卡和时间线；
// - 拉不起来时**登记留着**（和服务那条 means: service 的 put → start 一个口径），卡上写明原因，不做自动回滚：
//   用户可以用一张 action: remove 的卡撤掉；
// - 拒绝则一个字节都不变。批准、拒绝都记一条 mcp_decided（审批决定素材，mcp/material-source.ts）和维护者会话上的时间线；
// - 登记变了之后让提交的人的会话按新的装配重新拉起（和工具包变更一样：闲置时停掉子进程、下次唤起按新的），
//   会话里这才看得到新登记的工具。
// 为什么不能让 agent 自己写：配置区是受保护区域，守卫对任何方式的写入都是"永不"（越界），登记只能走这条路。
import { EVENT_TYPES, maintainerChannel, MCP_NAME_PATTERN, type McpChangeAction, type McpChangeCardPayload, McpChangeCardPayload as McpChangeCardPayloadSchema, type McpChangeSubmitter, type McpDecidedPayload, schemaChecker, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { buildAgentNotice, buildTimelineRecord } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
// 登记里"看着是密钥"的环境变量名：这些只能写 { fromEnv }，不许写明文（和带参调用脱敏同一个判断）
import { SECRET_NAME } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { McpService } from "./mcp.ts";
import { McpServerRegistrationSchema, type McpServerRegistration } from "./registration.ts";
import * as text from "./texts.ts";
import { REQUEST_MCP_CHANGE_TOOL } from "./tool-names.ts";
import { applyMcpChange, type McpWriteTarget } from "./writer.ts";

export { REQUEST_MCP_CHANGE_TOOL } from "./tool-names.ts";

/** 守护进程内部的 mcp 频道（前端不订阅）：登记的审批决定（素材的来源） */
export const MCP_CHANNEL = "mcp";

/** 工具给谁用：项目的维护者（对话段），或者任务自己的维护者 */
export type McpChangeTarget = { kind: "project"; projectId: string; maintainerId: string } | { kind: "task"; taskId: string; maintainerId: string };

/** 自检默认最多等多久（毫秒）：服务进程的握手和 tools/list 都在这之内 */
const SELF_CHECK_TIMEOUT_MS = 20_000;

export interface McpChangeServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  /** 现读登记和自检（拉起一次） */
  mcp: Pick<McpService, "registrations" | "probe">;
  /** 配置区的登记文件和它的历史区（数据目录的 config/、config/.history/） */
  write: McpWriteTarget;
  /** 提交的人：项目的维护者的项目 */
  projectOf(projectId: string): { id: string; name: string } | undefined;
  /** 提交的人：任务的维护者的任务（项目内部任务带上所属的项目） */
  taskOf(taskId: string): { id: string; title: string; maintainerId: string; projectId?: string; projectName?: string } | undefined;
  /** 登记变了：让这个人的会话按新的装配重新拉起（和工具包变更一样）；不给就不管（下次唤起自然按新的） */
  mcpChanged?: (submitter: McpChangeSubmitter, name: string) => void;
  /** 自检最多等多久（毫秒）；不给按 SELF_CHECK_TIMEOUT_MS */
  selfCheckTimeoutMs?: number;
  now: () => string;
  log: (line: string) => void;
}

export interface McpChangeService {
  /** 维护者的工具：校验 + 出卡（不写文件） */
  requestTool(target: McpChangeTarget): HostTool;
  /** "MCP 登记变更"卡上的批准、拒绝（批准：写进 mcp.json + 自检） */
  decide(payload: McpChangeCardPayload, cardId: string, decision: "approved" | "denied", note: string | undefined, idempotencyKey: string): Promise<CardActionEffect<McpChangeCardPayload>>;
}

/** 一次决定要记的时间线和通知写在哪个会话、带什么归属 */
const scopeOf = (submitter: McpChangeSubmitter) => (submitter.kind === "project" ? { projectId: submitter.projectId } : { taskId: submitter.taskId, ...(submitter.projectId === undefined ? {} : { projectId: submitter.projectId }) });

/** 登记里的一张工具表（工具名 → 登记的几样）；校验用守护进程那份严的 schema */
const registrationChecker = schemaChecker(McpServerRegistrationSchema);

/** 工具给的登记内容（去掉没写的） */
interface RegistrationArgs {
  title?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | { fromEnv: string }>;
  tools?: Record<string, unknown>;
}

/** 一条登记要写进去的东西：先挑出明确能说清的问题（command、tools、明文密钥），再按配置区那份严的 schema 校一遍 */
function registrationOf(given: RegistrationArgs): { problems: string[]; registration?: McpServerRegistration } {
  const problems: string[] = [];
  const command = (given.command ?? "").trim();
  if (command === "") problems.push(text.missingCommandText());
  const plaintext = Object.entries(given.env ?? {})
    .filter(([name, value]) => typeof value === "string" && SECRET_NAME.test(name))
    .map(([name]) => name);
  if (plaintext.length > 0) problems.push(text.plaintextSecretText(plaintext));
  const tools = given.tools ?? {};
  if (Object.keys(tools).length === 0) problems.push(text.noToolsText());
  if (problems.length > 0) return { problems };
  // 没写的字段不给（免得写成 undefined、history 里对不上）
  const draft = {
    ...(given.title === undefined ? {} : { title: given.title }),
    command,
    ...(given.args === undefined ? {} : { args: given.args }),
    ...(given.cwd === undefined || given.cwd === "" ? {} : { cwd: given.cwd }),
    ...(given.timeoutMs === undefined ? {} : { timeoutMs: given.timeoutMs }),
    ...(given.env === undefined ? {} : { env: given.env }),
    tools,
  };
  if (!registrationChecker.check(draft)) return { problems: [registrationChecker.firstError(draft) ?? ""] };
  return { problems: [], registration: draft as McpServerRegistration };
}

export function createMcpChangeService(options: McpChangeServiceOptions): McpChangeService {
  const { store, cards, inbox, mcp } = options;

  /** 提交的人：目标对得上现在的项目、任务，不然找不到 */
  const submitterOf = (target: McpChangeTarget): McpChangeSubmitter | undefined => {
    if (target.kind === "project") {
      const project = options.projectOf(target.projectId);
      return project && { kind: "project", projectId: project.id, projectName: project.name, maintainerId: target.maintainerId };
    }
    const task = options.taskOf(target.taskId);
    return (
      task && {
        kind: "task",
        taskId: task.id,
        taskTitle: task.title,
        maintainerId: target.maintainerId,
        ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
        ...(task.projectName === undefined ? {} : { projectName: task.projectName }),
      }
    );
  };

  /** 同名的上一张卡还在等用户 */
  const pendingCardOf = (name: string) =>
    inbox
      .list()
      .flatMap((item) => (item.kind === "card" ? [cards.get(item.cardId)] : []))
      .find((card) => card?.type === "mcp_change" && card.status === "pending" && (card.payload as McpChangeCardPayload).name === name);

  const requestTool = (target: McpChangeTarget): HostTool =>
    defineHostTool({
      name: REQUEST_MCP_CHANGE_TOOL,
      title: text.requestMcpChangeTitle(),
      description: text.requestMcpChangeDescription,
      parameters: Type.Object(
        {
          action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")], { description: text.REQUEST_MCP_CHANGE_PARAMS.action }),
          // 名字的格式在这里自己查（给模型的话说得清），schema 只挡长度
          name: Type.String({ minLength: 1, maxLength: 64, description: text.REQUEST_MCP_CHANGE_PARAMS.name }),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: text.REQUEST_MCP_CHANGE_PARAMS.title })),
          command: Type.Optional(Type.String({ maxLength: 2000, description: text.REQUEST_MCP_CHANGE_PARAMS.command })),
          args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100, description: text.REQUEST_MCP_CHANGE_PARAMS.args })),
          cwd: Type.Optional(Type.String({ maxLength: 2000, description: text.REQUEST_MCP_CHANGE_PARAMS.cwd })),
          timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000, description: text.REQUEST_MCP_CHANGE_PARAMS.timeoutMs })),
          env: Type.Optional(
            Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.Union([Type.String({ maxLength: 4000 }), Type.Object({ fromEnv: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false })]), {
              description: text.REQUEST_MCP_CHANGE_PARAMS.env,
            }),
          ),
          tools: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), Type.Record(Type.String(), Type.Unknown()), { description: text.REQUEST_MCP_CHANGE_PARAMS.tools })),
          why: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: text.REQUEST_MCP_CHANGE_PARAMS.why })),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      run: (given) => {
        try {
          const action = given.action as McpChangeAction;
          const submitter = submitterOf(target);
          if (!submitter) return { text: text.noSubmitterText(target.kind === "project" ? target.projectId : target.taskId), isError: true };
          if (!new RegExp(MCP_NAME_PATTERN).test(given.name)) return { text: text.badNameText(given.name), isError: true };
          const read = mcp.registrations();
          if (read.problem) return { text: text.problemsText([read.problem]), isError: true };
          const registered = Object.hasOwn(read.servers, given.name);
          if (action === "add" && registered) return { text: text.alreadyRegisteredText(given.name), isError: true };
          if (action !== "add" && !registered) return { text: text.notRegisteredText(given.name), isError: true };
          let registration: McpServerRegistration | undefined;
          if (action !== "remove") {
            const checked = registrationOf({ ...(given.title === undefined ? {} : { title: given.title }), ...(given.command === undefined ? {} : { command: given.command }), ...(given.args === undefined ? {} : { args: given.args }), ...(given.cwd === undefined ? {} : { cwd: given.cwd }), ...(given.timeoutMs === undefined ? {} : { timeoutMs: given.timeoutMs }), ...(given.env === undefined ? {} : { env: given.env }), ...(given.tools === undefined ? {} : { tools: given.tools }) });
            if (checked.problems.length > 0) return { text: text.problemsText(checked.problems), isError: true };
            registration = checked.registration;
          }
          const waiting = pendingCardOf(given.name);
          if (waiting) return { text: text.cardWaitingText(given.name, waiting.id), isError: true };
          const payload: McpChangeCardPayload = {
            action,
            name: given.name,
            ...(registration === undefined ? {} : { registration }),
            submitter,
            ...(given.why === undefined ? {} : { why: given.why }),
          };
          const card = cards.buildCreate({ type: "mcp_change", payload, urgency: "non_blocking" });
          const item = inbox.buildAdd({
            kind: "card",
            cardId: card.card.id,
            title: text.inboxTitle(payload),
            source: text.sourceOf(submitter),
            origin: scopeOf(submitter),
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

  /** 批准：写进 mcp.json，再拉起一次自检；拉不起来登记留着，只在卡上说原因 */
  const decide: McpChangeService["decide"] = async (payload, cardId, decision, note, idempotencyKey) => {
    const comment = note?.trim() || undefined;
    const submitter = payload.submitter;
    const conversation = maintainerChannel(submitter.maintainerId);
    const scope = scopeOf(submitter);
    const decided = (event: McpDecidedPayload): NewEvent => ({ channel: MCP_CHANNEL, type: EVENT_TYPES.mcpDecided, payload: event, idempotencyKey: `${idempotencyKey}#decided` });
    const record = (event: McpDecidedPayload): NewEvent =>
      buildTimelineRecord(conversation, { kind: "mcp", summary: text.timelineSummary(event), detail: text.timelineDetail(event, payload.registration) }, scope, { idempotencyKey: `${idempotencyKey}#timeline` }).event;
    const notice = (words: string): NewEvent => buildAgentNotice(conversation, words, `${idempotencyKey}#notice`, scope).event;
    const base = { action: payload.action, name: payload.name, submitter, cardId, ...(comment === undefined ? {} : { note: comment }) };
    if (decision === "denied") {
      const event: McpDecidedPayload = { ...base, decision, applied: false, time: options.now() };
      return { status: "handled", ...(comment === undefined ? {} : { note: comment }), events: [decided(event), record(event), notice(text.deniedNotice(event))] };
    }
    // 写文件（读不懂现在的登记时抛 RequestRejected：卡片留在待我处理，用户改好再确认）
    applyMcpChange(options.write, { action: payload.action, name: payload.name, ...(payload.registration === undefined ? {} : { registration: payload.registration as McpServerRegistration }) }, options.now());
    const probed = await options.mcp.probe(payload.name, options.selfCheckTimeoutMs ?? SELF_CHECK_TIMEOUT_MS);
    const check = { ok: probed.ok, tools: probed.tools, ...(probed.problem === undefined ? {} : { problem: probed.problem }), time: options.now() };
    const event: McpDecidedPayload = { ...base, decision: "approved", applied: true, check, time: options.now() };
    // 登记变了：**在返回之前**就让提交的人的会话标记成"要换装配"——通知和卡片同一批落盘，会话接到通知时（可能比这里晚）
    // 要先按新的装配重新拉起，会话里才有新登记的工具（照工具包变更的做法；晚一步就成了拿旧装配干这一轮）
    options.mcpChanged?.(submitter, payload.name);
    return {
      status: "handled",
      payload: { ...payload, applied: true, check },
      note: text.appliedNote(payload.name, check),
      events: [decided(event), record(event), notice(text.approvedNotice(event))],
    };
  };

  return { requestTool, decide };
}

/** "MCP 登记变更"卡：批准（approve）、拒绝（deny），都可附说明 */
export function mcpChangeCardType(service: Pick<McpChangeService, "decide">) {
  return defineCardType({
    type: "mcp_change",
    version: 1,
    payload: McpChangeCardPayloadSchema,
    actions: {
      approve: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "approved", note, idempotencyKey) },
      deny: { input: undefined, run: ({ card, payload, note, idempotencyKey }) => service.decide(payload, card.id, "denied", note, idempotencyKey) },
    },
    toText: text.cardText,
  });
}
