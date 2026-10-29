// 通用桥接扩展（128 号票，ADR-0027）：子进程里唯一挂给 pi 的二狗扩展（ergo-bridge）。守护进程经宿主协议下发的通用贡献清单
// （AgentContributions：上下文块、钩子订阅都当数据传，插件经 agent 贡献缝给的和内核自己的同一个形状），在这里翻译成 pi 的事件；
// 以后插件加上下文块、这几种钩子，不用改协议、不用改子进程。pi 升级时要对照的事件都在这一个文件里：
// - tool_call / tool_result：守卫转发（guard-forwarding.ts；守卫是内核，打开 forwardToolCalls 才接）；
// - session_compact：每次压缩之后把各上下文块按先后再注入一次（13 号票的重注入块是其中一块；每条输入之前那一次在 session.ts 的 prompt 里）；
// - session_before_compact：钩子订阅 compaction_instructions（秘书的压缩指令，compaction.ts），再是范围审视（scope-review.ts）；
// - before_agent_start：钩子订阅 system_prompt_suffix，和范围审视的近期范围记录，接在系统提示末尾（每轮现拼，不进会话）。
// 同一个事件挂了几样时按上面的先后（和 128 号票之前四个内联扩展的先后一样：守卫、重注入块、压缩、范围审视），模型看到的不变。
// 工具不走这里：守护进程代为执行的工具照旧作为 createAgentSession 的 customTools 交给 pi（host-tools.ts），工具清单的先后不变；
// pi 的扩展工具注册了撤不掉（调研 19 §4.3），本来也不适合放插件的工具。
// 记忆简报这类每轮的上下文照旧作为消息追加进会话（user_input.context、上下文块），不用 pi 的 context 事件（只对单次请求生效、
// 不落盘，调研 19 §5.1；"模型看到的都要记下来"）。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type AgentContributions, CONTEXT_BLOCK_TYPE, type HookKind } from "../host-protocol.ts";
import { compactWithInstructions, type CompactionDeps } from "./compaction.ts";
import type { GuardForwarder } from "./guard-forwarding.ts";
import type { ScopeReviewer } from "./scope-review.ts";

/** 一条上下文消息（pi 的 custom message：模型看到的是用户角色的一条，界面不显示） */
export interface ContextMessage {
  customType: string;
  content: string;
  display: boolean;
}

/** 内核的两样（守卫转发、范围审视：有逻辑，不是数据）和按压缩指令写摘要要的 */
export interface BridgeParts {
  guard?: GuardForwarder | undefined;
  reviewer?: ScopeReviewer | undefined;
  compaction: CompactionDeps;
}

export class ContributionBridge {
  /** 上下文块：id → 守护进程最近给的文字（按清单的先后） */
  private readonly blocks: Map<string, string>;
  private readonly hooks: Array<{ id: string; kind: HookKind; text: string }>;
  private readonly parts: BridgeParts;

  constructor(contributions: Pick<AgentContributions, "contextBlocks" | "hooks">, parts: BridgeParts) {
    this.blocks = new Map(contributions.contextBlocks.map((b) => [b.id, b.text]));
    this.hooks = contributions.hooks.map((h) => ({ ...h }));
    this.parts = parts;
  }

  /** 有没有要翻译给 pi 的（都没有就不挂扩展，和 128 号票之前什么都不挂时一样） */
  get needed(): boolean {
    return this.parts.guard !== undefined || this.parts.reviewer !== undefined || this.blocks.size > 0 || this.hooks.length > 0;
  }

  /** 每条输入之前（被唤起）、每次压缩之后要加进会话的上下文消息：各上下文块最新的文字，按清单的先后（空的这一回不注入） */
  contextMessages(): ContextMessage[] {
    return [...this.blocks.values()].filter((content) => content !== "").map((content) => ({ customType: CONTEXT_BLOCK_TYPE, content, display: false }));
  }

  /**
   * 换掉清单里一项（上下文块、钩子订阅）的文字。清单里没有这个 id 的当成一块新的上下文块加在后面，从下一条输入起注入
   * （和 18 之前一样：拉起时没给重注入块、之后才换上的，下一条输入之前照样注入；压缩之后的再注入只在拉起时就有上下文块时才挂）
   */
  update(id: string, text: string): void {
    const hook = this.hooks.find((h) => h.id === id);
    if (hook) hook.text = text;
    else this.blocks.set(id, text);
  }

  /** 这种钩子订阅最新的文字，按先后（空的不算） */
  private texts(kind: HookKind): string[] {
    return this.hooks.filter((h) => h.kind === kind && h.text !== "").map((h) => h.text);
  }

  readonly extension: ExtensionFactory = (pi) => {
    const { guard, reviewer, compaction } = this.parts;
    if (guard) {
      pi.on("tool_call", (event, ctx) => guard.onToolCall(event, ctx.signal));
      pi.on("tool_result", (event) => guard.onToolResult(event));
    }
    // 压缩之后注入最新的各块（回合进行中时 pi 把它们排到下一次模型调用之前）
    if (this.blocks.size > 0) {
      pi.on("session_compact", () => {
        for (const message of this.contextMessages()) pi.sendMessage(message);
      });
    }
    // 压缩指令这一回都是空的：交给 pi 默认的写法
    if (this.hooks.some((h) => h.kind === "compaction_instructions")) {
      pi.on("session_before_compact", (event, ctx) => {
        const instructions = this.texts("compaction_instructions");
        return instructions.length > 0 ? compactWithInstructions(event, ctx, instructions.join("\n\n"), compaction) : undefined;
      });
    }
    if (reviewer || this.hooks.some((h) => h.kind === "system_prompt_suffix")) {
      pi.on("before_agent_start", (event) => {
        const suffixes = [reviewer?.systemPromptSuffix(), ...this.texts("system_prompt_suffix")].filter((t): t is string => t !== undefined);
        return suffixes.length > 0 ? { systemPrompt: [event.systemPrompt, ...suffixes].join("\n\n") } : undefined;
      });
    }
    if (reviewer) {
      reviewer.attach((customType, data) => pi.appendEntry(customType, data));
      // 压缩之前：要压缩掉的消息送审；不改压缩本身（返回 undefined）
      pi.on("session_before_compact", async (event, ctx) => {
        await reviewer.onCompaction(event, ctx.sessionManager);
        return undefined;
      });
    }
  };
}
