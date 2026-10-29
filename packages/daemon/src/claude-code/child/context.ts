// 进上下文、界面不显示的内容交给 Claude（291 号票，issue 24 方案 2.4、第三节丙表"进上下文不显示的消息"）：二狗现在给 pi 注入的那几样，
// 在 Claude Code 里经 SDK 钩子的 additionalContext 交给模型（Claude Code 把它作为一段系统提醒放进上下文，不是用户说的话；网页显示的是
// 二狗自己的会话事件，本来就不显示它）：
// - 上下文块（装配参数 contributions.contextBlocks：重注入块——计划摘要、当前阶段、授权和边界——和插件经 agent 贡献缝给的"被唤起时注入"的那种，
//   比如项目规范、记忆简报）：同 pi，每条输入之前（UserPromptSubmit）和每次压缩之后（SessionStart，source 是 compact）各注入一次最新的；
//   contribution 命令按 id 换文字（没有这个 id 的当成新的一块）；
// - 跟在这条输入后面的上下文（user_input.context：看板变化、语音回复的说明、插件"跟在输入后面"的那种，比如每条消息的记忆简报）：
//   这条输入的 UserPromptSubmit 交给模型（287 号票时是用户消息里另一块文字，Claude 自己的会话记录里会当成用户说的）；
// - 钩子订阅 system_prompt_suffix 和范围审视的近期范围记录（pi 那边每轮接在系统提示末尾、不进会话）：Claude 的系统提示在 query 起来时就定了，
//   这里当成"一直在"的一段——起 query 后第一次、压缩之后、文字变了的时候注入一次（Claude 的会话记录会留下它，所以不每轮重复）；
// - 二狗要告诉模型的话（工具包当场换了的"工具包已变更：……"，宿主协议 toolkit 的 notice）：下一次主线工具调用的结果（PostToolUse）或下一条输入，
//   谁先到交给谁。
// 压缩指令（钩子订阅 compaction_instructions，只有秘书用、秘书是 pi）：二狗发的手动压缩写成 "/compact <指令>"；自动压缩改不了指令。
// @i18n-ignore-file log
import type { HookCallbackMatcher, HookEvent, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { AgentContributions, HookKind } from "../../runtime/host-protocol.ts";

/** 几段文字拼成一份 additionalContext：空的不算，中间空一行 */
const joined = (parts: ReadonlyArray<string | undefined>): string | undefined => {
  const text = parts.filter((p): p is string => p !== undefined && p.trim() !== "").join("\n\n");
  return text === "" ? undefined : text;
};

export class ClaudeContext {
  /** 上下文块：id → 守护进程最近给的文字（按清单的先后） */
  private readonly blocks: Map<string, string>;
  private readonly hooks: Array<{ id: string; kind: HookKind; text: string }>;
  /** 范围审视的近期范围记录（装配参数 scopeReview、命令 scope_context 换） */
  private recentRecords: string | undefined;
  /** 这条输入后面跟的上下文：下一次 UserPromptSubmit 交 */
  private inputContext: string | undefined;
  /** 下一次 UserPromptSubmit 要不要注入上下文块（每条输入之前一次；SessionStart 先注入了就不再重复） */
  private wake = false;
  /** "一直在"的那段（后缀、近期范围记录）上次注入的文字；起 query、压缩之后清空，下一次注入 */
  private standingShown: string | undefined;
  /** 等着交给模型的话（工具包已变更……） */
  private readonly notes: string[] = [];
  private readonly log: (line: string) => void;

  constructor(contributions: Pick<AgentContributions, "contextBlocks" | "hooks">, recentRecords: string | undefined, log: (line: string) => void) {
    this.blocks = new Map(contributions.contextBlocks.map((b) => [b.id, b.text]));
    this.hooks = contributions.hooks.map((h) => ({ ...h }));
    this.recentRecords = recentRecords;
    this.log = log;
  }

  /** 宿主协议 contribution：换掉上下文块、钩子订阅的文字；清单里没有这个 id 的当成新的一块上下文块 */
  update(id: string, text: string): void {
    const hook = this.hooks.find((h) => h.id === id);
    if (hook) hook.text = text;
    else this.blocks.set(id, text);
  }

  /** 宿主协议 scope_context：换成最新的近期范围记录 */
  setRecentRecords(text: string | undefined): void {
    this.recentRecords = text;
  }

  /** 一条输入要交给 Claude 了：它后面跟的上下文（没有就是清掉上一条没交出去的），上下文块到它的 UserPromptSubmit 注入 */
  beginPrompt(context: string | undefined): void {
    this.inputContext = context;
    this.wake = true;
  }

  /** 起了一个新的 query（新拉起、上一个结束了再起）："一直在"的那段重新注入一次 */
  queryStarted(): void {
    this.standingShown = undefined;
  }

  /** 压缩过了（compact_boundary）："一直在"的那段重新注入一次（SessionStart compact 没先注入的话） */
  compacted(): void {
    this.standingShown = undefined;
  }

  /** 要告诉模型的话：下一次主线工具结果或下一条输入时交 */
  note(text: string): void {
    if (text.trim()) this.notes.push(text);
  }

  /** 手动压缩时的指令（钩子订阅 compaction_instructions，几条空一行拼起来）；没有是 undefined */
  compactionInstructions(): string | undefined {
    return joined(this.hooks.filter((h) => h.kind === "compaction_instructions").map((h) => h.text));
  }

  /** 交给 SDK 的钩子：UserPromptSubmit、SessionStart（PostToolUse 由会话和守卫的合在一起，见 postToolContext） */
  sdkHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    return {
      UserPromptSubmit: [{ hooks: [(input) => Promise.resolve(this.onPrompt(input))] }],
      SessionStart: [{ hooks: [(input) => Promise.resolve(this.onSessionStart(input))] }],
    };
  }

  /** 主线工具调用结束（PostToolUse、PostToolUseFailure）时要交给模型的话；子代理里的不交 */
  postToolContext(input: HookInput): string | undefined {
    if (input.agent_id) return undefined;
    return this.takeNotes();
  }

  private onPrompt(input: HookInput): HookJSONOutput {
    if (input.hook_event_name !== "UserPromptSubmit") return {};
    const blocks = this.wake ? this.blockTexts() : [];
    this.wake = false;
    const context = joined([...blocks, this.standing(), this.inputContext, this.takeNotes()]);
    this.inputContext = undefined;
    if (context === undefined) return {};
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  }

  private onSessionStart(input: HookInput): HookJSONOutput {
    if (input.hook_event_name !== "SessionStart") return {};
    // 压缩之后：上下文块再注入一次（同 pi 的 session_compact）；会话开始（新开、接着、清空）：有输入在等就先注入，它的 UserPromptSubmit 不再重复
    const withBlocks = input.source === "compact" || this.wake;
    if (input.source === "compact") this.standingShown = undefined;
    if (withBlocks) this.wake = false;
    const context = joined([...(withBlocks ? this.blockTexts() : []), this.standing()]);
    if (context === undefined) return {};
    this.log(`SessionStart（${input.source}）注入了上下文${withBlocks ? "（含上下文块）" : ""}`);
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
  }

  private blockTexts(): string[] {
    return [...this.blocks.values()].filter((text) => text.trim() !== "");
  }

  /** "一直在"的那段：和上次注入的一样就不再注入（undefined） */
  private standing(): string | undefined {
    const text = joined([...this.hooks.filter((h) => h.kind === "system_prompt_suffix").map((h) => h.text), this.recentRecords]);
    if (text === undefined) {
      this.standingShown = undefined;
      return undefined;
    }
    if (text === this.standingShown) return undefined;
    this.standingShown = text;
    return text;
  }

  private takeNotes(): string | undefined {
    return joined(this.notes.splice(0));
  }
}
