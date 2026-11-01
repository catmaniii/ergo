// 守卫的 PreToolUse 钩子（ADR-0046）：Codex 每次要执行命令、改文件、调 MCP 工具之前拉起这个小程序（经 <runtimeDir>/bin 里的 ergo-guard-hook 包装脚本），
// stdin 是一份 JSON（工具名、参数、调用 id），stdout 写一份 JSON（不放行就写明原因）。它只把调用转给适配子进程、把判定写回去，判定在守护进程。
// 连不上适配子进程（它退了）一律不放行：钩子没给判定 Codex 会接着执行。
// 只引 node 自带的模块和 bridge-client.ts。
// @i18n-ignore-file model：交回 Codex、给模型看的说明
import { askBridge } from "./bridge-client.ts";

const pipe = process.env.ERGO_CODEX_PIPE ?? "";
const token = process.env.ERGO_CODEX_TOKEN ?? "";

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

function finish(output: unknown): void {
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return finish(deny("二狗的守卫读不懂这次调用，不放行。"));
  }
  askBridge(pipe, { token, kind: "hook", payload }).then(finish, (err: unknown) => finish(deny(`连不上二狗的守卫（${err instanceof Error ? err.message : String(err)}），这次调用不放行。`)));
});
