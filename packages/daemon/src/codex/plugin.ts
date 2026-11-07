// Codex 插件（"以后 Codex 也用同一个插件的方式"）：带来一个 agent 运行时——项目、任务的负责人可以用本机的 Codex 跑会话
// （用户自己的 Codex 配置、本机的登录）。照 claude-code/ 的结构。
// - 数据契约：只登记运行时（runtime.ts）。不管插件开没开都登记：负责人记着的运行时在插件停用时也认得、写得出"Codex插件没启用"。
// - 装配：只备好接管已有会话用的会话来源（sessions.ts：经内核的一次性子进程起 codex app-server；测试注入假的）。没有给 agent 的工具、没有定时作业。
// - 不拥有数据：没有视图、事件、卡片、改写函数，移除时没有"连数据删"的勾。Codex 自己的会话是 Codex 的；接管记录记在任务、项目上（内核的）。
// - Codex 不随二狗分发：没装、版本太低时插件不装配（定义里的 missing）：设置 · 插件和运行时都写这一句，别的功能不受影响，装好后点启用就装上。
// - 深度体检（415，deep-doctor.ts）：体检页上点了"深度体检"才跑一次 codex login status，看本机的 Codex 登录了没有。
import { t } from "@ergo/protocol";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { CODEX_PLUGIN } from "./api.ts";
import { type CodexLoginStatus, codexLoginCheck, codexLoginStatus } from "./deep-doctor.ts";
import { codexMissing } from "./install.ts";
import { codexRuntime } from "./runtime.ts";
import { type CodexSessionSource, oneShotSessionSource } from "./sessions.ts";

/**
 * Codex 插件；entry 不给是真的子进程入口（测试换成接假 app-server 的）；sessions 不给是经一次性子进程读本机的会话（主切面换成假的）；
 * missing 不给是按 PATH 找本机的 codex（测试换掉，结果不看这台机器装没装）；loginStatus 不给是跑本机的 codex login status
 * （深度体检用，415；测试换成假的，不跑真的 codex）
 */
export function createCodexPlugin(options: { entry?: string; sessions?: CodexSessionSource; missing?: () => string | undefined; loginStatus?: CodexLoginStatus } = {}): PluginDefinition {
  /** 接管已有会话用的会话来源：插件在运行时才有（停用时登记表不会叫到它） */
  let sessions: CodexSessionSource | undefined;
  return {
    name: CODEX_PLUGIN,
    get title() {
      return t("codex.plugin.title");
    },
    get summary() {
      return t("codex.plugin.summary");
    },
    needs: [KERNEL.oneShot, KERNEL.env],
    missing: () => (options.missing ?? codexMissing)(),
    contracts(ctx) {
      ctx.runtimes.register(
        codexRuntime(options.entry, {
          source: () => {
            if (!sessions) throw new Error(t("plugins.notEnabled", { title: t("codex.plugin.title") }));
            return sessions;
          },
        }),
      );
    },
    setup(ctx) {
      const run = ctx.use(KERNEL.oneShot);
      const env = ctx.use(KERNEL.env);
      ctx.effect(() => {
        sessions = options.sessions ?? oneShotSessionSource(run);
        return () => {
          sessions = undefined;
        };
      });
      // 深度体检（415）：登录了没有（跑一次 codex login status；点了"深度体检"才跑）
      ctx.doctor.register(codexLoginCheck(options.loginStatus ?? codexLoginStatus(() => env)));
    },
  };
}

export const codexPlugin: PluginDefinition = createCodexPlugin();
