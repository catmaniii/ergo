// 每个 agent 的会话里一个 ⚙（114 号票，规格第 19 节"Web UI"、系统提示一节）：秘书会话、任务整页（负责它的维护者）、项目整页（项目维护者）。
// 面板上三件事：
// - 这个 agent 单独的提示词（用户 2026-10-13 定：默认追加，也能整份自己写）：存在数据目录配置区的 agent-prompts/（prompts/library.ts），
//   改完从这个 agent 的下一轮起生效（各模块收到 onAgentChange 后照改名的做法：手头这一条处理完按新的重新拉起，接着同一个会话）；
//   面板上看得到现在实际用的系统提示全文（前缀、模板 + 追加或整份；项目维护者后面还有这一段的固定上下文）；
// - 清空当前对话：秘书、任务的维护者新开一段会话（conversation/agent-session.ts 的 clear：旧消息不删，界面上收在分隔线上面；
//   计划、阶段、进展照常作为上下文给到新的一段，秘书照常有看板变化），项目维护者就是重置维护者（16 号票）；
// - 上下文用量和"现在压缩"：数都从子进程每次模型调用报的 usage 来（token 账本），不另数一套——这段会话里最近一次干活的调用的上下文
//   （缓存命中 + 未命中 + 输出，和 pi 自己算的一样），压缩之后还没调用过的不写；窗口和 pi 的压缩设置是子进程就绪时报的
//   （agent 没在跑时用这个模型上一次报的）。"现在压缩"经宿主协议的 compact（秘书照旧用它专用的压缩指令，维护者照旧在压缩时做范围审视、
//   压缩后重注入固定上下文），压缩那次的用量照常记账（用途"压缩"）。
// 谁是哪个 agent、怎么清、怎么压、这一段从哪算起，由秘书、任务的维护者、项目维护者各自的模块给（AgentHandle），这里只拼面板、查只读。
import {
  type AgentPromptBody,
  type AgentClearKind,
  type AgentSettingsKind,
  type AgentSettingsView,
  tokenTotal,
} from "@ergou/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import type { AgentSessionPanel } from "../conversation/agent-session.ts";
import { RequestRejected } from "../errors.ts";
import type { TokenLedger } from "../ledger/index.ts";
import type { PromptId, PromptLibrary } from "../prompts/index.ts";

/** 一个有 ⚙ 的 agent：各模块给出它是谁、通用模板是哪份、怎么清空、怎么压缩 */
export interface AgentHandle {
  agentId: string;
  kind: AgentSettingsKind;
  /** 给人看的：秘书（名字占位）、长程任务 t-3「…」的维护者、项目「…」的维护者 */
  label: string;
  /** 它的通用模板（设置 · 系统提示里这个角色的那份）：单独的提示词按它查、从它复制 */
  template: PromptId;
  /** 只能看不能改的原因（任务结束了、项目归档了）；能改是 undefined */
  readOnly: string | undefined;
  /** 现在实际用的系统提示（不含前缀；项目维护者带着这一段的固定上下文） */
  systemPrompt(): string;
  /** 清空当前对话怎么做 */
  clearKind: AgentClearKind;
  /** 清空当前对话（手头这一条处理完再清；同一个幂等键只清一次） */
  clear(idempotencyKey: string): void;
  /** 现在压缩（手头这一条处理完再压，没在跑的先拉起） */
  compact(): void;
  /** 现在压不了的原因（项目维护者没有在进行的一段会话）；压得了是 undefined */
  cannotCompact(): string | undefined;
  /** 这一段会话从哪算起（清空的分隔线、重置维护者新开的一段的全局序号）和上一次清空（重置）的时间；没有是 0 */
  since(): { seq: number; clearedAt?: string };
  /** 会话此刻的样子（会话还没建起来是 undefined：没在跑、没在等） */
  panel(): AgentSessionPanel | undefined;
}

export interface AgentSettingsOptions {
  prompts: Pick<PromptLibrary, "agentPrompt" | "saveAgentPrompt" | "resetAgentPrompt" | "detail" | "withPrefix">;
  ledger: Pick<TokenLedger, "lastOf">;
  agents: Pick<AgentManager, "contextOf">;
  /** 认这个 agent：秘书、任务自己的维护者、项目维护者；不认得是 undefined */
  resolve(agentId: string): AgentHandle | undefined;
}

export interface AgentSettings {
  view(agentId: string): AgentSettingsView;
  savePrompt(agentId: string, body: AgentPromptBody): AgentSettingsView;
  resetPrompt(agentId: string): AgentSettingsView;
  clear(agentId: string, idempotencyKey: string): AgentSettingsView;
  compact(agentId: string): AgentSettingsView;
}

export function createAgentSettings(options: AgentSettingsOptions): AgentSettings {
  const { prompts, ledger } = options;

  const handleOf = (agentId: string): AgentHandle => {
    const handle = options.resolve(agentId);
    if (!handle) throw new RequestRejected("not_found", `没有这个 agent（只有秘书、任务和项目的维护者有 ⚙）：${agentId}`);
    return handle;
  };

  /** 能改才往下走：只读的写明原因 */
  const writable = (agentId: string): AgentHandle => {
    const handle = handleOf(agentId);
    if (handle.readOnly !== undefined) throw new RequestRejected("not_allowed", handle.readOnly);
    return handle;
  };

  const view = (handle: AgentHandle): AgentSettingsView => {
    const { agentId } = handle;
    const own = prompts.agentPrompt(agentId, handle.template);
    const template = prompts.detail(handle.template);
    const since = handle.since();
    const panel = handle.panel();
    // 这段会话里最近一次干活的调用、最近一次压缩：压缩在后的，压缩之后还没调用过模型，用量等下一次调用再说
    const work = ledger.lastOf(agentId, ["work"], since.seq);
    const compacted = ledger.lastOf(agentId, ["compaction"], since.seq);
    const used = work && (!compacted || compacted.seq < work.seq) ? work : undefined;
    // 窗口：会话最近一次就绪时报的；没在跑过就用这个模型上一次报的（agent 管家记着，按账本里最近一次调用的模型）
    const lastModel = (work ?? ledger.lastOf(agentId, ["work", "compaction"]))?.model;
    const context = panel?.context ?? (lastModel === undefined ? undefined : options.agents.contextOf(lastModel));
    const cannotCompact = handle.cannotCompact();
    return {
      agentId,
      kind: handle.kind,
      label: handle.label,
      ...(handle.readOnly === undefined ? {} : { readOnly: handle.readOnly }),
      prompt: {
        state: own ? own.mode : "template",
        content: own?.content ?? "",
        ...(own?.problem === undefined ? {} : { problem: own.problem }),
        template: { id: template.id, title: template.title, content: template.content, placeholders: template.placeholders, allowEmpty: template.allowEmpty },
        effective: prompts.withPrefix(handle.systemPrompt()),
      },
      clear: { how: handle.clearKind, pending: panel?.clearPending ?? false, ...(since.clearedAt === undefined ? {} : { lastAt: since.clearedAt }) },
      context: {
        running: panel?.running ?? false,
        busy: panel?.busy ?? false,
        ...(used ? { usedTokens: tokenTotal(used.tokens), measuredAt: used.time } : {}),
        ...(context ? { window: context.window, autoCompactAt: Math.max(0, context.window - context.reserveTokens), keepRecentTokens: context.keepRecentTokens } : {}),
        ...(compacted ? { lastCompactedAt: compacted.time } : {}),
        compaction: panel?.compaction ?? "idle",
        ...(panel?.lastCompact ? { lastCompact: panel.lastCompact } : {}),
        ...(cannotCompact === undefined ? {} : { cannotCompact }),
      },
    };
  };

  return {
    view: (agentId) => view(handleOf(agentId)),
    savePrompt(agentId, body) {
      const handle = writable(agentId);
      prompts.saveAgentPrompt(agentId, handle.template, body.mode, body.content);
      return view(handle);
    },
    resetPrompt(agentId) {
      const handle = writable(agentId);
      prompts.resetAgentPrompt(agentId);
      return view(handle);
    },
    clear(agentId, idempotencyKey) {
      const handle = writable(agentId);
      handle.clear(idempotencyKey);
      return view(handle);
    },
    compact(agentId) {
      const handle = writable(agentId);
      const cannot = handle.cannotCompact();
      if (cannot !== undefined) throw new RequestRejected("not_allowed", cannot);
      handle.compact();
      return view(handle);
    },
  };
}
