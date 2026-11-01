// 设置 · Claude Code（Claude Code 插件的网页这一半画的设置页）：新建时的默认文件夹，页面在核心（ui/runtime-folder-page.tsx，Codex 也用它）。
import { RuntimeFolderPage } from "../../ui/runtime-folder-page.tsx";

/** Claude Code 运行时的 id（守护进程 claude-code/api.ts 的 CLAUDE_CODE_RUNTIME_ID） */
export const CLAUDE_CODE_RUNTIME = "claude-code";

export function ClaudeCodePage() {
  return <RuntimeFolderPage runtime={CLAUDE_CODE_RUNTIME} />;
}
