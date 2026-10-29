// agent 贡献模块（128 号票，ADR-0027）：插件给 agent 的工具、每轮的上下文块、钩子订阅，经插件宿主登记到这里（PluginContext.agent：
// 每次登记返回撤销函数、记在插件名下，停用时撤掉）；装配时按"给谁"——哪种 agent（秘书、三种维护者）、哪种会话、此刻的工具包——
// 筛好交给装配。秘书（secretary/secretary.ts）和三种维护者（assembly.ts 的 sessionTools 那一处、host.ts 的会话）都经它。
// 组合根在插件装配之前建它（秘书比 agent 宿主起得早，两边都要它），交给插件宿主、秘书、agent 宿主。
// - 工具：守护进程代为执行的工具（HostTool），守卫的登记随工具走（HostTool.descriptor，会话拉起时加进守卫的工具注册表）；
// - 每轮的上下文块：
//   - input：跟在交给 agent 的每条输入后面（开始处理这条输入的那一刻现算，和看板变化、语音的说明拼成一条上下文消息、排在最后）；
//     266 号票起可以是异步的（记忆简报要检索）：有一块是异步的，会话等齐了再交这条输入（出错的当没有）；还可以给这一轮回话带上 part
//     （replyParts，记忆简报的结构化部分：网页据此画"回忆了 N 条记忆"），会话把它放进这一轮的第一条回话；
//   - wake：每条输入之前（被唤起）和每次压缩之后注入（同重注入块；拉起时放进装配参数，交每条输入之前现算一遍、变了先送过去）；
// - 钩子订阅：system_prompt_suffix（每轮接在系统提示末尾）、compaction_instructions（压缩时写摘要另按它），只做现有内联扩展用得到的。
// 子进程那一侧由通用桥接扩展翻译给 pi（runtime/agent-child/bridge.ts）。系统提示的片段和占位符不在这里：插件在定义里声明
// （PluginDefinition.prompts），插件宿主收齐交给系统提示的文件（prompts/library.ts）。
// 一份贡献给的东西只按插件登记的先后排：工具接在每种 agent 装配里的"插件贡献的工具"那一处（秘书在两个附件工具之后，
// 维护者在每个会话都配的工具之后），上下文块、钩子订阅排在内核的（重注入块、秘书的压缩指令）后面。
// 212 号票（浏览插件）加了两样：
// - 工具的位置 at: "end"：排在这种 agent 装配里内核自己的工具之后（秘书：内核的工具之后、测试加的工具和联网工具之前；维护者：
//   插件贡献的工具之后）——浏览插件的网页工具原来就排在那里，搬进插件后模型看到的工具先后不变；
// - 输入附注（notes）：接在交给 agent 的那条输入自己的文字末尾（同一条消息里，在投影、晚到的语音那句之后、维护者的消息 id 那行之前；
//   开始处理这条输入的那一刻现算），不是另起一条上下文消息——浏览侧边栏、悬浮按钮发的消息后面那段网页上下文（147 号票）原来就在那里。
import type { MessageEnvelope, MessagePart, PlanToolkit } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { ContextBlockSpec, HookKind, HookSubscription } from "../runtime/index.ts";
import type { HostedSessionKind, MaintainerKind } from "./assembly.ts";

/** 哪种 agent：秘书、三种维护者 */
export type ContributionAgent = "secretary" | MaintainerKind;

/** 哪种会话：秘书的主线会话，维护者的六种（见 assembly.ts 的 HostedSessionKind） */
export type ContributionSession = "secretary" | HostedSessionKind;

/** 一份贡献给谁：此刻装配的这个 agent */
export interface ContributionTarget {
  agent: ContributionAgent;
  agentId: string;
  session: ContributionSession;
  /** 此刻的工具包（维护者这一段生效的；秘书没有工具包） */
  toolkit?: PlanToolkit;
}

/** 给谁：都不写是所有 agent 的所有会话 */
export interface ContributionScope {
  agents?: readonly ContributionAgent[];
  sessions?: readonly ContributionSession[];
  /** 按此刻的工具包（写了它，没有工具包的秘书就不给） */
  toolkit?: (toolkit: PlanToolkit) => boolean;
}

/** 工具排在哪（212 号票）：plugins 是"插件贡献的工具"那一处（默认），end 是内核自己的工具之后 */
export type ToolPlacement = "plugins" | "end";

/** 工具：守护进程代为执行的（守卫的登记在 HostTool.descriptor 里） */
export interface ToolContribution {
  to?: ContributionScope;
  /** 排在哪（不写是 plugins） */
  at?: ToolPlacement;
  tools(target: ContributionTarget): readonly HostTool[];
}

/**
 * 输入附注（212 号票）：接在交给 agent 的那条输入自己的文字末尾（同一条消息里），开始处理这条输入的那一刻现算；undefined 或空的就不接
 */
export interface NoteContribution {
  to?: ContributionScope;
  text(message: MessageEnvelope, target: ContributionTarget): string | undefined;
}

/** 每轮的上下文块 */
export type ContextContribution =
  /**
   * 跟在每条输入后面：开始处理这条输入的那一刻现算，undefined 就不带。可以是异步的（266 号票：会话等它算好再交这条输入，出错当没有）。
   * replyParts：这一轮的回话要带上的 part（文字算好之后取一次；会话放进这一轮的第一条回话），不给、undefined 就没有
   */
  | {
      to?: ContributionScope;
      when: "input";
      text(message: MessageEnvelope, target: ContributionTarget): string | undefined | Promise<string | undefined>;
      replyParts?(message: MessageEnvelope, target: ContributionTarget): readonly MessagePart[] | undefined;
    }
  /**
   * 被唤起时（每条输入之前）和每次压缩之后注入；undefined 或空的这一回不注入。id 在插件里不重复（插件宿主在前面加上插件名）
   */
  | { to?: ContributionScope; when: "wake"; id: string; text(target: ContributionTarget): string | undefined };

/** 钩子订阅（种类见宿主协议的 HookKind）；id 在插件里不重复（插件宿主在前面加上插件名） */
export interface HookContribution {
  to?: ContributionScope;
  id: string;
  kind: HookKind;
  /** undefined 或空的：这一回没有（system_prompt_suffix 不接，compaction_instructions 不算） */
  text(target: ContributionTarget): string | undefined;
}

/** 撤销函数 */
type Undo = () => void;

/** 拉起时放进装配参数的、交每条输入之前现算的：上下文块和钩子订阅 */
export interface ContributedManifest {
  contextBlocks: ContextBlockSpec[];
  hooks: HookSubscription[];
}

export interface AgentContributions {
  readonly tools: { register(contribution: ToolContribution): Undo };
  readonly context: { register(contribution: ContextContribution): Undo };
  readonly hooks: { register(contribution: HookContribution): Undo };
  /** 输入附注（212 号票） */
  readonly notes: { register(contribution: NoteContribution): Undo };
  /**
   * 给这个 agent 此刻的工具（按登记的先后；重名的只留第一个，记一行日志）：at 是排在哪一处的（不写是 plugins，"插件贡献的工具"那一处）。
   * 重名按两处合起来认（先 plugins 后 end）
   */
  toolsFor(target: ContributionTarget, at?: ToolPlacement): HostTool[];
  /**
   * 跟在这条输入后面的（几块按登记的先后空一行拼在一起）；没有是 undefined。有一块是异步的（266 号票）就交回 Promise，等齐了再拼
   * （异步的那块出错当没有，记一行日志）
   */
  inputContextFor(target: ContributionTarget, message: MessageEnvelope): string | undefined | Promise<string | undefined>;
  /** 这条输入的回话要带上的 part（266 号票：记忆简报的结构化部分），按登记的先后；文字算好之后取 */
  replyPartsFor(target: ContributionTarget, message: MessageEnvelope): MessagePart[];
  /** 接在这条输入自己的文字末尾的输入附注（几条换行拼在一起）；没有是 undefined */
  inputNoteFor(target: ContributionTarget, message: MessageEnvelope): string | undefined;
  /**
   * 拉起时放进装配参数的上下文块（wake）和钩子订阅：给这个 agent 的都在（这一回没有内容的文字是空的），所以一个会话里 id 不变，
   * 之后只按 id 换文字
   */
  manifestFor(target: ContributionTarget): ContributedManifest;
  /**
   * 登记的贡献给出的东西变了、不是登记或撤销（295 号票：数据源的按需查开关、插件停用时内核替数据源给的工具跟着变）：
   * 通知订阅的（常驻的秘书据此重新装配）
   */
  refresh(): void;
  /** 登记、撤销了（插件运行中停用时，常驻的秘书据此重新装配）；返回取消订阅 */
  onChange(listener: () => void): Undo;
}

/** 跟在输入后面的几块空一行拼在一起（没有内容的不算）；一块都没有是 undefined */
function joinBlocks(texts: readonly (string | undefined)[]): string | undefined {
  const parts = texts.filter((t): t is string => t !== undefined && t !== "");
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** 这份贡献给不给这个 agent */
export function contributesTo(scope: ContributionScope | undefined, target: ContributionTarget): boolean {
  if (!scope) return true;
  if (scope.agents && !scope.agents.includes(target.agent)) return false;
  if (scope.sessions && !scope.sessions.includes(target.session)) return false;
  if (scope.toolkit && !(target.toolkit && scope.toolkit(target.toolkit))) return false;
  return true;
}

export function createAgentContributions(options: { log: (line: string) => void }): AgentContributions {
  const { log } = options;
  const tools: ToolContribution[] = [];
  const contexts: ContextContribution[] = [];
  const hooks: HookContribution[] = [];
  const notes: NoteContribution[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        log(`agent 贡献变动的通知出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
  };
  /** 上下文块（wake）、钩子订阅的 id：一份清单里不重复 */
  const ids = () => [...contexts.flatMap((c) => (c.when === "wake" ? [c.id] : [])), ...hooks.map((h) => h.id)];
  const add = <T>(list: T[], item: T): Undo => {
    list.push(item);
    changed();
    return () => {
      const at = list.indexOf(item);
      if (at < 0) return;
      list.splice(at, 1);
      changed();
    };
  };

  return {
    tools: { register: (contribution) => add(tools, contribution) },
    context: {
      register(contribution) {
        if (contribution.when === "wake" && ids().includes(contribution.id)) throw new Error(`agent 贡献的 id ${contribution.id} 已经有了`); // @i18n-ignore log：编程错误
        return add(contexts, contribution);
      },
    },
    hooks: {
      register(contribution) {
        if (ids().includes(contribution.id)) throw new Error(`agent 贡献的 id ${contribution.id} 已经有了`); // @i18n-ignore log：编程错误
        return add(hooks, contribution);
      },
    },
    notes: { register: (contribution) => add(notes, contribution) },
    toolsFor(target, at = "plugins") {
      // 重名按两处合起来认：先 plugins 那一处、后 end（取 end 那一处时，plugins 那一处的只用来认重名，不再记日志）
      const placed = (where: ToolPlacement) => tools.filter((c) => (c.at ?? "plugins") === where && contributesTo(c.to, target)).flatMap((c) => c.tools(target));
      const seen = new Set<string>();
      const keep = (quiet: boolean) => (tool: HostTool) => {
        if (!seen.has(tool.spec.name)) {
          seen.add(tool.spec.name);
          return true;
        }
        if (!quiet) log(`插件贡献的工具 ${tool.spec.name} 重名了，给 ${target.agentId} 的只留第一个`);
        return false;
      };
      const first = placed("plugins").filter(keep(at !== "plugins"));
      return at === "plugins" ? first : placed("end").filter(keep(false));
    },
    inputContextFor(target, message) {
      const texts = contexts.flatMap((c) => (c.when === "input" && contributesTo(c.to, target) ? [c.text(message, target)] : []));
      if (!texts.some((t) => t instanceof Promise)) return joinBlocks(texts as (string | undefined)[]);
      return Promise.all(
        texts.map((t) =>
          Promise.resolve(t).catch((err: unknown) => {
            log(`跟在输入后面的上下文块出错，这一块不带：${err instanceof Error ? err.message : String(err)}`);
            return undefined;
          }),
        ),
      ).then(joinBlocks);
    },
    replyPartsFor(target, message) {
      return contexts.flatMap((c) => (c.when === "input" && c.replyParts && contributesTo(c.to, target) ? [...(c.replyParts(message, target) ?? [])] : []));
    },
    inputNoteFor(target, message) {
      const parts = notes.flatMap((c) => (contributesTo(c.to, target) ? [c.text(message, target)] : [])).filter((t): t is string => t !== undefined && t !== "");
      return parts.length > 0 ? parts.join("\n") : undefined;
    },
    manifestFor(target) {
      return {
        contextBlocks: contexts.flatMap((c) => (c.when === "wake" && contributesTo(c.to, target) ? [{ id: c.id, text: c.text(target) ?? "" }] : [])),
        hooks: hooks.flatMap((h) => (contributesTo(h.to, target) ? [{ id: h.id, kind: h.kind, text: h.text(target) ?? "" }] : [])),
      };
    },
    refresh: changed,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
