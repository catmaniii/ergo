// Claude Code 插件（287 号票，issue 24；用户 2026-10-25："会话支持 Claude Code 这个事情要做成插件化，以后我要接入 Codex，也用同一个插件的方式"）：
// 带来一个 agent 运行时——项目、任务的维护者可以用本机的 Claude Code 跑会话（用户自己的 Claude Code 配置、本机登录的订阅额度）。
// - 数据契约：只登记运行时（runtime.ts，286 号票的"运行时"贡献点）。和别的契约一样不管插件开没开都登记：维护者记着的运行时在插件停用时
//   也认得、写得出"Claude Code插件没启用"；能不能用跟着插件在不在运行（停用时用它的维护者不拉起、执行中的任务转等我，启用后接着）。
// - 装配：只备好接管已有会话用的会话来源（290 号票，sessions.ts：经内核的一次性子进程列本机会话、查哪些正开着、读前情、分叉；
//   测试注入假的）和交给官方 App 用的命令行（292 号票，cli.ts：守护进程直接拉起本机的 claude，不进二狗的 Job；环境按守护进程自己的现取，
//   测试注入假的），没有给 agent 的工具、没有定时作业。依赖 @anthropic-ai/claude-agent-sdk 只在子进程里用（适配子进程、一次性子进程）。
// - 不拥有数据：没有视图、事件、卡片、改写函数，设置里移除时没有"连数据删"的勾。Claude Code 自己的会话记录是 Claude Code 的，不是二狗的；
//   290 号票的接管记录（哪个任务、项目接管了哪个会话，也是写入锁）记在任务、项目上（内核的 Task.takeover、Project.takeover），不是插件的数据。
// - 网页这一张不加界面（289 号票起新建任务、项目时选运行时，⚙ 按它显示）；GET /api/runtimes 里照常列出它。
// - 315 号票：SDK 是可选依赖（Anthropic 自己的许可，不随二狗分发，sdk-installed.ts）。没装时插件不装配（定义里的 missing）：设置 · 插件里写"没装"
//   和怎么装、启用不了；运行时写同一句（新建任务、项目时 Claude Code 那一项、用它的维护者不拉起）；别的插件和功能不受影响。装好后点启用就装上。
import { t } from "@ergo/protocol";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { CLAUDE_CODE_PLUGIN } from "./api.ts";
import { type ClaudeCli, detachedClaudeCli } from "./cli.ts";
import type { RemoteTiming } from "./remote-control.ts";
import { claudeCodeRuntime } from "./runtime.ts";
import { claudeSdkInstalled, claudeSdkMissing } from "./sdk-installed.ts";
import { type ClaudeSessionSource, oneShotSessionSource } from "./sessions.ts";

/** 插件还没装好时的日志：不记 */
const ignoreLine = (_line: string): void => {};

/**
 * Claude Code 插件；entry 不给是真的子进程入口（主切面换成接假 SDK 的，test/helpers/fake-claude-code.ts）；
 * sessions 不给是经一次性子进程读本机的会话（主切面换成假的会话来源，不读用户真实的 ~/.claude）；
 * cli 不给是守护进程直接跑本机的 claude（292 号票；主切面换成扮演本机 claude 的假的，不起真的 claude），remoteTiming 测试调短等待；
 * sdkInstalled 不给是按 Node 的解析规则找 SDK 在不在（315 号票；测试换成"没装"的，不用真去卸掉它）
 */
export function createClaudeCodePlugin(
  options: { entry?: string; sessions?: ClaudeSessionSource; cli?: ClaudeCli; remoteTiming?: Partial<RemoteTiming>; sdkInstalled?: () => boolean } = {},
): PluginDefinition {
  /** 接管已有会话用的会话来源（290 号票）：插件在运行时才有（停用时登记表不会叫到它） */
  let sessions: ClaudeSessionSource | undefined;
  /** 交给官方 App 用的命令行（292 号票）：同上 */
  let cli: ClaudeCli | undefined;
  let log: (line: string) => void = ignoreLine;
  return {
    name: CLAUDE_CODE_PLUGIN,
    get title() {
      return t("claudeCode.plugin.title");
    },
    get summary() {
      return t("claudeCode.plugin.summary");
    },
    needs: [KERNEL.oneShot, KERNEL.env],
    // SDK 没装（315 号票）：不装配，设置 · 插件、运行时都写这一句（没装什么、怎么装）
    // 318 号票：组件区里装的也算（宿主给组件区在哪）
    missing: (ctx) => claudeSdkMissing(options.sdkInstalled ?? (() => claudeSdkInstalled(ctx?.componentsDir))),
    contracts(ctx) {
      ctx.runtimes.register(
        claudeCodeRuntime(options.entry, {
          source: () => {
            if (!sessions) throw new Error(t("plugins.notEnabled", { title: t("claudeCode.plugin.title") }));
            return sessions;
          },
          cli: () => {
            if (!cli) throw new Error(t("plugins.notEnabled", { title: t("claudeCode.plugin.title") }));
            return cli;
          },
          log: (line) => log(line),
          ...(options.remoteTiming ? { remoteTiming: options.remoteTiming } : {}),
        }),
      );
    },
    setup(ctx) {
      const run = ctx.use(KERNEL.oneShot);
      const env = ctx.use(KERNEL.env);
      ctx.effect(() => {
        sessions = options.sessions ?? oneShotSessionSource(run);
        cli = options.cli ?? detachedClaudeCli(() => env);
        log = (line) => ctx.log(line);
        return () => {
          sessions = undefined;
          cli = undefined;
        };
      });
    },
  };
}

export const claudeCodePlugin: PluginDefinition = createClaudeCodePlugin();
