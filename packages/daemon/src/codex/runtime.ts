// Codex 运行时：负责人用本机的 Codex 跑会话。插件在数据契约里把它登记进运行时的登记表（runtime/runtimes.ts 的 AgentRuntime，"运行时"贡献点）。
// - 子进程入口 child/main.ts：守护进程用 process.execPath 拉起，每个会话一个（ADR-0002）；里面拉起用户本机的 codex app-server（stdio 上的 JSON-RPC），
//   把宿主协议翻成 app-server 的调用、把它的通知翻回宿主协议。外部词汇全挡在子进程里。
// - 能力清单照实写（按 0.166 生成的协议，test/fixtures/codex-app-server.schema.json）：
//   · interject：turn/steer；compact：thread/compact/start；thinking_levels：turn/start 的 effort；take_over：thread/list、thread/resume、thread/fork、thread/turns/list；
//   · rollback、branch_switch：thread/fork 的 beforeTurnId 从撤回点之前分叉出新会话接着用，废弃的那条还在，切回去就是接着它（0.166 没有 thread/rollback；thread/revert 只认
//     paginated 的会话，还会改写原来的历史，切不回去，不用）。只回对话：Codex 不恢复文件（rewind_files 是 false，撤回确认框写明）；只能回到一条输入之前，回不到一次工具调用前后；
//   · model_handoff：换了模型的，旧模型在临时分叉里写交接摘要，新模型新开会话；
//   · scope_review：和 Claude Code 一样由二狗按自己记下的事件另起（recordedScopeReview），子进程在压缩开始时报 compacting；
//   · branch_summary：Codex 不写，由二狗写好交来；purge_rewrite：不改写 Codex 的会话文件；remote_control：这期不做；
//   · slash_passthrough：false：斜杠命令是 Codex 终端界面的，app-server 没有转交的接口，/目录名 由二狗展开成 skill；
//   · live_toolkit：false：实测（0.166，临时 CODEX_HOME）会话连着的 MCP 服务发 tools/list_changed、再 config/mcpServer/reload，会话里的工具清单都不换；
//   · yield：false：没有"做完手头这一步、下一次模型调用之前停下"的口子。工具包变了，这一轮做完之后按新的装配重新拉起。
// - 守卫：Codex 自带的工具登记进 guard-tools.ts，能对上二狗工具的由子进程映射（child/guard.ts）。守卫接在哪、拦不住哪些见 ADR-0046。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import type { RuntimeCapabilities } from "@ergo/protocol";
import type { AgentRuntime } from "../runtime/index.ts";
import { CODEX_RUNTIME_ID } from "./api.ts";
import { CODEX_GUARD_TOOLS } from "./guard-tools.ts";
import { type CodexSessionSource, listResumable, sessionBusy } from "./sessions.ts";
import { codexSettings } from "./settings.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
/** Codex 运行时的子进程入口（child/main） */
export const CODEX_CHILD_ENTRY = fileURLToPath(new URL(`./child/main${ownExt}`, import.meta.url));

/** 能力清单（共享协议包 RUNTIME_OPERATIONS 逐项） */
export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  interject: true,
  compact: true,
  rollback: true,
  branch_switch: true,
  branch_summary: false,
  rewind_files: false,
  model_handoff: true,
  thinking_levels: true,
  slash_passthrough: false,
  take_over: true,
  purge_rewrite: false,
  yield: false,
  live_toolkit: false,
  scope_review: true,
  remote_control: false,
};

/** 命令的单次超时：比 Codex 自己的后台终端上限（background_terminal_max_timeout 默认 5 分钟）宽，交给它自己先到点 */
const SHELL_TOOL_TIMEOUT_MS = 11 * 60_000;

/** 运行时自带的工具单次调用的超时（null 是不按单次超时算；没写的照守护进程的默认） */
export const CODEX_TOOL_TIMEOUTS: Readonly<Record<string, number | null>> = {
  bash: SHELL_TOOL_TIMEOUT_MS,
  // 派子代理、等子代理：一次可能跑很久，它里面的每次调用照常各自计时
  spawnAgent: null,
  wait: null,
  followupTask: null,
  resumeAgent: null,
  sleep: null,
};

/** 接管已有会话用的：会话来源（插件在运行时才有，现取） */
export interface CodexTakeOverDeps {
  source(): CodexSessionSource;
}

/** Codex 运行时；entry 不给是 child/main（测试换成接假 app-server 的子进程入口）；takeOver 不给的不能真的列会话（只给边界测试用） */
export function codexRuntime(entry: string = CODEX_CHILD_ENTRY, takeOver?: CodexTakeOverDeps): AgentRuntime {
  const source = () => {
    // @i18n-ignore-next log：编程错误
    if (!takeOver) throw new Error("这个 Codex 运行时没接会话来源");
    return takeOver.source();
  };
  return {
    id: CODEX_RUNTIME_ID,
    get title() {
      return t("codex.runtime.title");
    },
    entry,
    capabilities: CODEX_CAPABILITIES,
    // 模型列表子进程起来时报回（runtime_catalog）；还没报过时是空的：⚙ 里只有"跟 Codex 自己的设置"
    models: () => [],
    settings: codexSettings,
    guardTools: CODEX_GUARD_TOOLS,
    toolTimeouts: CODEX_TOOL_TIMEOUTS,
    workFolder: true,
    recordedScopeReview: true,
    sessions: () => listResumable(source()),
    sessionBusy: (sessionId, after) => sessionBusy(source(), sessionId, after),
    forkSession: (sessionId, cwd) => source().fork(sessionId, cwd),
    sessionHistory: (sessionId) => source().history(sessionId),
  };
}
