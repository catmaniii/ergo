// 进上下文、界面不显示的内容交给 Codex：经 turn/start 的 additionalContext（kind: application，协议的实验字段），不拼进用户消息——
// - 上下文块（contributions.contextBlocks）：每条输入之前一次最新的；contribution 命令按 id 换文字（没有这个 id 的当成新的一块）；
// - 跟在这条输入后面的上下文（user_input.context）：这条输入带上；
// - 钩子订阅 system_prompt_suffix 和范围审视的近期范围记录：当成"一直在"的一段，新起的进程、压缩之后、文字变了的时候带一次；
// - 二狗要告诉模型的话（分支摘要、交接摘要）：下一条输入带上。
// 压缩指令（compaction_instructions，只有秘书用、秘书是 pi）不接：thread/compact/start 不收指令。
// 系统提示：二狗的只追加（developerInstructions），不替换 Codex 自己的说明；用户在 config.toml 写的 developer_instructions 排在前面（会话那边读 config/read 拼上）。
// @i18n-ignore-file model：给 Codex 看的话
import type { AgentContributions, HookKind } from "../../runtime/host-protocol.ts";
import { ERGO_MCP_SERVER } from "./host-tools.ts";

const joined = (parts: ReadonlyArray<string | undefined>): string | undefined => {
  const text = parts.filter((p): p is string => p !== undefined && p.trim() !== "").join("\n\n");
  return text === "" ? undefined : text;
};

export class CodexContext {
  private readonly blocks: Map<string, string>;
  private readonly hooks: Array<{ id: string; kind: HookKind; text: string }>;
  private recentRecords: string | undefined;
  private standingShown: string | undefined;
  private readonly notes: string[] = [];

  constructor(contributions: Pick<AgentContributions, "contextBlocks" | "hooks">, recentRecords: string | undefined) {
    this.blocks = new Map(contributions.contextBlocks.map((b) => [b.id, b.text]));
    this.hooks = contributions.hooks.map((h) => ({ ...h }));
    this.recentRecords = recentRecords;
  }

  update(id: string, text: string): void {
    const hook = this.hooks.find((h) => h.id === id);
    if (hook) hook.text = text;
    else this.blocks.set(id, text);
  }

  setRecentRecords(text: string | undefined): void {
    this.recentRecords = text;
  }

  note(text: string): void {
    if (text.trim()) this.notes.push(text);
  }

  /** 压缩过了、换了 app-server："一直在"的那段再带一次 */
  refreshStanding(): void {
    this.standingShown = undefined;
  }

  /** 这条输入要带的（空是 undefined） */
  forPrompt(inputContext: string | undefined): string | undefined {
    const blocks = [...this.blocks.values()].filter((text) => text.trim() !== "");
    return joined([...blocks, this.standing(), inputContext, ...this.notes.splice(0)]);
  }

  private standing(): string | undefined {
    const text = joined([...this.hooks.filter((h) => h.kind === "system_prompt_suffix").map((h) => h.text), this.recentRecords]);
    if (text === undefined || text === this.standingShown) {
      if (text === undefined) this.standingShown = undefined;
      return undefined;
    }
    this.standingShown = text;
    return text;
  }
}

/** 追加进 developerInstructions 的一句：负责人的系统提示是按 pi 写的，说清二狗的工具在 Codex 里叫什么、提示里说的 pi 的工具对应它自带的哪个 */
export const CODEX_TOOL_NOTE = [
  `（二狗补充：你现在跑在 Codex 里。上面说的二狗的工具在这里名字前面带 mcp__${ERGO_MCP_SERVER}__，比如 submit_plan 就是 mcp__${ERGO_MCP_SERVER}__submit_plan；`,
  `工具包里的 MCP 工具在这里写成 mcp__${ERGO_MCP_SERVER}__<服务>__<工具>。上面说的 read、write、edit、bash、grep、find、ls 用你自带的命令和 apply_patch 做。`,
  "工具包里的 skill 已经放进你能发现的 skill 目录。）",
].join("");
