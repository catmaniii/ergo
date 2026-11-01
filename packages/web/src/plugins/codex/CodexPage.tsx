// 设置 · Codex（Codex 插件的网页这一半画的设置页）：新建时的默认文件夹，页面在核心（ui/runtime-folder-page.tsx，和 Claude Code 同一个）。
import { RuntimeFolderPage } from "../../ui/runtime-folder-page.tsx";

/** Codex 运行时的 id（守护进程 codex/api.ts 的 CODEX_RUNTIME_ID） */
export const CODEX_RUNTIME = "codex";

export function CodexPage() {
  return <RuntimeFolderPage runtime={CODEX_RUNTIME} />;
}
