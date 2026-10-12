// 秘书转达（103 号票，规格第 7 节、第 12 节"星形通信"）：用户在和秘书说话时要它给已有的任务、项目的维护者捎一句话
// （"告诉 t-5，以后把 GitHub 热门也加上"），秘书用"提议快速动作"提出 tell_task / tell_project，参数是目标和要转达的话。
// - 目标：看板上的任务（普通任务、流程、长程任务，含定时 / 事件触发的；就是任务详情里用户能说话的那段会话），和项目的维护者会话
//   （项目页"和维护者交流"那段）。项目内部的任务秘书看不到（64、66 号票）：照 100 号票当"没有这个任务"，回的原因不带项目名、
//   不说它在不在（只提示项目里的事用 tell_project 转给项目的维护者），免得秘书按编号一个个试出项目内部有哪些任务；
// - 怎么插进去：走用户在任务详情、项目维护者会话里直接说话的那条路——消息的归属、要先追加的事件（项目维护者手上没有段时开一个
//   对话段）和网关发消息时同一套（daemon.ts 交来 scopeOf、preludeOf），发言方照旧是用户，只多一个 relayedBy: "secretary"
//   （conversation/messages.ts 的 buildRelayedMessage）。所以对方怎么处理照现有规矩：在干活时是插话、闲着时唤起，做完了的普通任务
//   重新进行中接着做，长程任务涉及改范围、授权的照常提计划变更，流程执行中只当补充说明，定时 / 事件触发的照用户在它详情里说话的做法。
//   交给 agent 时开头写明是秘书转达的（agent-input.ts），界面上标出来，不算"本人"的原话素材（materials/sources.ts）；
// - 收不了的（已归档、已取消、不存在、已经结束的长程任务和流程、已归档或删掉的项目……）提出时就拒，原因交回秘书（不出卡）；
//   卡上确认时目标可能变了，执行时再看一次，收不了的卡片保持待处理；
// - "点明了"（照 100 号票评审后改严的判法，再按 103 号票评审收严，relayExplicit）：用户自己说的话里，转达的说法紧跟着这个目标
//   （"告诉 / 转告 / 转达给 / 转给 / 让 t-5""跟 t-5 说"，前面没有否定；目标按编号或完整的名字认，子串不算），要转达的话原样落在
//   点到这个目标的那一段里（说到别的目标、又有转达的说法就截住），那一段里它外面不能有否定词（秘书不能把否定丢掉）。
//   秘书改写了、替用户加了要求、用户说得含糊（"跟早报那个任务说一下"）、拿不准的都算推断：出卡写明发给谁、发什么，
//   用户确认了才发（ask_when_inferred）。秘书不能自己主动去指挥别的 agent：只转达用户的意思。
// 不落入任何内置类别（用户的自定义类别照样能按 quick_action:tell_task 匹配它）。
import {
  type ConversationId,
  isProjectInternal,
  maintainerChannel,
  type MessageScope,
  type Project,
  type Task,
  taskName,
  Type,
} from "@ergou/protocol";
import { VIEW_BOARD_TOOL } from "../board/tool-names.ts";
import { buildRelayedMessage } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { getProjectRow, listProjects } from "../projects/views.ts";
import {
  bareText,
  clausesOf,
  defineQuickAction,
  type ExplicitFinding,
  isQuestion,
  type NamedRef,
  type NormalizedQuickAction,
  normalizeForMatch,
  ownWords,
  type QuickActionExecutor,
  sentencesOf,
  type UserTurn,
} from "../quick-actions/index.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { findByIdOrName } from "../util/find-by-ref.ts";

/** 转达的两种快速动作类型（秘书的系统提示、工具说明里引用：占位符 {{tell_task}}、{{tell_project}}） */
export const RELAY_ACTION = { task: "tell_task", project: "tell_project" } as const;

/** 一次最多转达多少字 */
export const RELAY_MESSAGE_MAX = 2000;

const Message = Type.String({ minLength: 1, maxLength: RELAY_MESSAGE_MAX, description: "要转达的话：照抄用户要你转告的那句原话，不改写、不替用户加要求" });

const TaskParams = Type.Object(
  {
    task: Type.String({ minLength: 1, description: "转给哪个任务：任务编号（t-5，看板上有）或完整的任务标题，尽量照抄用户的说法" }),
    message: Message,
  },
  { additionalProperties: false },
);

const ProjectParams = Type.Object(
  {
    project: Type.String({ minLength: 1, description: "转给哪个项目的维护者：项目编号（p-1）或完整的项目名，尽量照抄用户的说法" }),
    message: Message,
  },
  { additionalProperties: false },
);

// ───────────────────────── 点明了没有 ─────────────────────────

/** 编号和完整的名字（任务标题、项目名） */
export type RelayRef = NamedRef;

/** 转达的说法，后面紧跟着目标（"告诉 t-5""转告 t-5""转达给 t-5""转给 t-5""让 t-5"）；"跟 X 说"另外认 */
const RELAY_VERBS = ["告诉", "转告", "转达给", "转给", "让"];
/** "跟 X 说"里目标和"说"之间可以有的（"跟记账本的维护者说"） */
const THEN_SAY = /^\s*(的维护者|那边|这个项目|这个任务|项目|任务)?\s*(说|讲)/u;
/** 否定：说法前面有它的不算下了命令；要转达的话外面（点到的那一段里）有它的，算秘书丢了否定 */
const NEGATION = /[不没别甭勿莫]|无需|禁止/u;
/** 编号形状的词（任务 t-<n>、项目 p-<n>）：段落里出现别的编号，就是说到别的目标了 */
const ID_LIKE = /(?<![A-Za-z0-9-])[tp]-\d+(?![0-9])/giu;
/** 要转达的话只是这些（"跟 t-5 说一下"）：意思不清楚 */
const FILLER = /^(一下|一声|这个|那个|这件事|那件事|这事|那事|它|吧|了|呢|啊|哈)*$/u;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lower = (s: string) => normalizeForMatch(s).toLowerCase();

/**
 * text 从 at 起（跳过空白）就是这个目标：编号作为一个词（"t-5"不算"t-50"），或者完整的名字——名字只算整个出现在这里，
 * 别的目标的名字更长、也从这里起的不算（"日报"不算"日报汇总"；"AI 日报"里的"日报"更不算：它不在说法后面紧跟着）。
 * 是的话给出目标后面的位置
 */
function targetAt(text: string, at: number, target: RelayRef, others: readonly RelayRef[]): number | undefined {
  const start = at + (/^\s*/u.exec(text.slice(at))?.[0].length ?? 0);
  const rest = text.slice(start);
  const id = new RegExp(`^${escapeRegExp(target.id)}(?![A-Za-z0-9-])`, "iu").exec(rest);
  if (id) return start + id[0].length;
  const name = lower(target.name);
  const head = rest.toLowerCase();
  if (name.length === 0 || !head.startsWith(name)) return undefined;
  if (others.some((o) => lower(o.name).length > name.length && head.startsWith(lower(o.name)))) return undefined;
  return start + name.length;
}

/** 这个分句里点到这个目标的转达说法（前面没有否定）：每一处给出说法连同目标（"跟 X 说"连同"说"）结束的位置 */
function relayEnds(clause: string, target: RelayRef, others: readonly RelayRef[]): number[] {
  const ends: number[] = [];
  for (const verb of RELAY_VERBS) {
    for (let at = clause.indexOf(verb); at >= 0; at = clause.indexOf(verb, at + 1)) {
      if (NEGATION.test(clause.slice(0, at))) continue;
      const end = targetAt(clause, at + verb.length, target, others);
      if (end !== undefined) ends.push(end);
    }
  }
  for (let at = clause.indexOf("跟"); at >= 0; at = clause.indexOf("跟", at + 1)) {
    if (NEGATION.test(clause.slice(0, at))) continue;
    const end = targetAt(clause, at + 1, target, others);
    const say = end === undefined ? null : THEN_SAY.exec(clause.slice(end));
    if (end !== undefined && say) ends.push(end + say[0].length);
  }
  return ends;
}

/** 这个分句说到别的了：又有转达的说法，或者写着别的编号、别的任务和项目的名字（段到它前面为止） */
function talksOfOther(clause: string, target: RelayRef, others: readonly RelayRef[]): boolean {
  if (RELAY_VERBS.some((verb) => clause.includes(verb)) || /跟.*(说|讲)/u.test(clause)) return true;
  for (const match of clause.matchAll(ID_LIKE)) if (match[0].toLowerCase() !== target.id.toLowerCase()) return true;
  const text = clause.toLowerCase();
  return others.some((o) => lower(o.name).length > 0 && lower(o.name) !== lower(target.name) && text.includes(lower(o.name)));
}

/**
 * 用户这一轮点明了把这句话转达给这个目标；没点明是 undefined（推断出来的出卡确认）。从严，拿不准的都算没点明：
 * - 只看用户自己说的话（打的字、语音转写），问句不算；
 * - 有一处转达的说法紧跟着这个目标（"告诉 / 转告 / 转达给 / 转给 / 让 t-5""跟 t-5 说"），说法前面（同一分句里）没有否定词；
 *   目标按编号或完整的名字认，子串不算；"对 X 说""通知""让人……"这类宽的不算；
 * - 要转达的话原样落在点到这个目标的那一段里：从说法和目标后面起，到这一句结束，后面的分句又有转达的说法、
 *   说到别的编号或别的目标就截住（"告诉 t-5 加上 GitHub 热门，跟 t-6 说别动桌面"里 t-5 的那一段只有"加上 GitHub 热门"）；
 * - 那一段里要转达的话外面不能有否定词：秘书转的话不能比用户那段少掉否定（"告诉 t-5 不要删旧文件"转成"删旧文件"不算）；
 * - 要转达的话不只是"一下""一声"、不只是目标的名字。
 * others 是别的任务和项目（认名字时更长的那个优先、段落遇到它们截住）
 */
export function relayExplicit(turn: UserTurn, target: RelayRef, message: string, others: readonly RelayRef[] = []): ExplicitFinding | undefined {
  const said = bareText(message).toLowerCase();
  if (said.length < 2 || FILLER.test(said) || said === bareText(target.name).toLowerCase() || said === target.id.toLowerCase()) return undefined;
  for (const { text, source } of ownWords(turn)) {
    for (const sentence of sentencesOf(text)) {
      if (isQuestion(sentence)) continue;
      const clauses = clausesOf(normalizeForMatch(sentence));
      for (const [i, clause] of clauses.entries()) {
        for (const end of relayEnds(clause, target, others)) {
          const segment = [clause.slice(end)];
          for (const next of clauses.slice(i + 1)) {
            if (talksOfOther(next, target, others)) break;
            segment.push(next);
          }
          const bare = bareText(segment.join("，")).toLowerCase();
          const at = bare.indexOf(said);
          if (at < 0 || NEGATION.test(bare.slice(0, at)) || NEGATION.test(bare.slice(at + said.length))) continue;
          return { source };
        }
      }
    }
  }
  return undefined;
}

// ───────────────────────── 两种快速动作 ─────────────────────────

export interface RelayDeps {
  store: EventStore;
  tasks: TaskService;
  /** 用户在这个会话里说话时消息的归属（网关发消息的那一套）；收不了的抛 RequestRejected（已结束、已归档……），不认得的会话是 undefined */
  scopeOf(conversation: ConversationId, taskId?: string): MessageScope | undefined;
  /** 和消息同一事务、排在它前面追加的事件（项目维护者手上没有在进行的段时开一个对话段，16 号票） */
  preludeOf(conversation: ConversationId, key: string, taskId?: string): NewEvent[];
}

/** 规范化后的参数 */
type TaskRelay = { taskId: string; message: string };
type ProjectRelay = { projectId: string; message: string };

/** 转达的那一句的幂等键：同一个动作只转一次 */
const relayKey = (actionId: string) => `relay:${actionId}`;

const projectTarget = (project: Project) => `项目「${project.name}」的维护者`;

/** 秘书转达的两个快速动作（tell_task、tell_project） */
export function relayActions(deps: RelayDeps): QuickActionExecutor[] {
  const { store, tasks } = deps;

  /**
   * 看板上的任务。项目内部的照 100 号票当"没有这个任务"：和真没有的同一个说法，不带项目名，免得按编号试出项目内部有哪些任务
   */
  const findTask = (ref: string): Task =>
    findByIdOrName(
      tasks.list().filter((t) => !isProjectInternal(t)),
      ref,
      { nameOf: (t) => t.title, what: "任务", hint: `用 ${VIEW_BOARD_TOOL} 查看板，写任务编号；项目里的事请用 ${RELAY_ACTION.project} 转给项目的维护者` },
    );

  /** 别的任务和项目（"点明了"时认名字更长的那个优先、段落遇到它们截住）；项目内部的也算上，只用来截，不往外说 */
  const othersThan = (id: string): RelayRef[] =>
    [...tasks.list().map((t) => ({ id: t.id, name: t.title })), ...listProjects(store.reader).map((p) => ({ id: p.id, name: p.name }))].filter((r) => r.id !== id);

  /** 没删掉的项目 */
  const findProject = (ref: string): Project => findByIdOrName(listProjects(store.reader), ref, { nameOf: (p) => p.name, what: "项目", hint: "写项目编号（p-1）或完整的项目名" });

  /** 这个会话现在收不收用户的话：收的给出归属，收不了的抛出原因（和用户在那里发消息时被拒的说法一样） */
  const scopeIn = (conversation: ConversationId, taskId?: string): MessageScope => {
    const scope = deps.scopeOf(conversation, taskId);
    if (!scope) throw new RequestRejected("not_allowed", "那个会话现在不收消息");
    return scope;
  };

  /** 转达：和用户在那里直接说话一样的归属、开段，消息标上秘书转达 */
  const relay = (conversation: ConversationId, message: string, actionId: string, taskId?: string): NewEvent[] => {
    const scope = scopeIn(conversation, taskId);
    const key = relayKey(actionId);
    return [...deps.preludeOf(conversation, key, taskId), buildRelayedMessage(conversation, message, key, scope).event];
  };

  return [
    defineQuickAction({
      type: RELAY_ACTION.task,
      title: "转达给任务",
      usage:
        "用户要你给看板上已有的某个任务（普通任务、流程、长程任务，含定时 / 事件触发的）捎一句话（补充要求、改个说法），由运行时插进它的会话，" +
        "和用户在任务详情里直接说一样（在干活时下一步之前看到，闲着时唤起，做完了的普通任务接着做）；项目内部的任务看不到，转给那个项目的维护者",
      params: TaskParams,
      watch: { categories: [] },
      confirm: "ask_when_inferred",
      normalize({ task: ref, message }): NormalizedQuickAction {
        const task = findTask(ref);
        // 提出时就看它收不收用户的话（已归档、已取消、已经结束的长程任务和流程……）：收不了的直接拒，原因交回秘书（不出卡）
        scopeIn(maintainerChannel(task.maintainerId), task.id);
        return { params: { taskId: task.id, message } satisfies TaskRelay, title: `转达给${taskName(task)}`, target: taskName(task), content: message };
      },
      explicit(action, turn) {
        const { taskId, message } = action.params as TaskRelay;
        const task = tasks.get(taskId);
        return task ? relayExplicit(turn, { id: task.id, name: task.title }, message, othersThan(task.id)) : undefined;
      },
      execute(params, context) {
        const { taskId, message } = params as TaskRelay;
        const task = tasks.get(taskId);
        if (!task) throw new RequestRejected("not_found", `没有任务 ${taskId}`);
        const events = relay(maintainerChannel(task.maintainerId), message, context.actionId, task.id);
        const reopened = task.state === "done" ? "：它已经做完了，收到后重新进行中、接着做" : "";
        return { events, summary: `已经转给${taskName(task)}了${reopened}` };
      },
    }),
    defineQuickAction({
      type: RELAY_ACTION.project,
      title: "转达给项目的维护者",
      usage:
        "用户要你给某个项目的维护者捎一句话（项目页“和维护者交流”那段会话；项目内部的任务也经它转），由运行时插进维护者的会话，和用户在那里直接说一样",
      params: ProjectParams,
      watch: { categories: [] },
      confirm: "ask_when_inferred",
      normalize({ project: ref, message }): NormalizedQuickAction {
        const project = findProject(ref);
        // 已归档的维护者会话只读：直接拒
        scopeIn(maintainerChannel(project.maintainerId));
        return { params: { projectId: project.id, message } satisfies ProjectRelay, title: `转达给${projectTarget(project)}`, target: projectTarget(project), content: message };
      },
      explicit(action, turn) {
        const { projectId, message } = action.params as ProjectRelay;
        const row = getProjectRow(store.reader, projectId);
        return row && !row.deleted ? relayExplicit(turn, { id: row.project.id, name: row.project.name }, message, othersThan(row.project.id)) : undefined;
      },
      execute(params, context) {
        const { projectId, message } = params as ProjectRelay;
        const row = getProjectRow(store.reader, projectId);
        if (!row || row.deleted) throw new RequestRejected("not_found", `没有项目 ${projectId}（删掉了）`);
        const events = relay(maintainerChannel(row.project.maintainerId), message, context.actionId);
        return { events, summary: `已经转给${projectTarget(row.project)}了` };
      },
    }),
  ];
}
