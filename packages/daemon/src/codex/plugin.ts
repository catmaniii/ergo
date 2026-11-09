// Codex 插件（"以后 Codex 也用同一个插件的方式"）：带来一个 agent 运行时——项目、任务的负责人可以用本机的 Codex 跑会话
// （用户自己的 Codex 配置、本机的登录）。照 claude-code/ 的结构。
// - 数据契约：只登记运行时（runtime.ts）。不管插件开没开都登记：负责人记着的运行时在插件停用时也认得、写得出"Codex插件没启用"。
// - 装配：只备好接管已有会话用的会话来源（sessions.ts：经内核的一次性子进程起 codex app-server；测试注入假的）。没有给 agent 的工具、没有定时作业。
// - 不拥有数据：没有视图、事件、卡片、改写函数，移除时没有"连数据删"的勾。Codex 自己的会话是 Codex 的；接管记录记在任务、项目上（内核的）。
// - Codex 不随二狗分发：没装、版本太低时插件不装配（定义里的 missing）：设置 · 插件和运行时都写这一句，别的功能不受影响，装好后点启用就装上。
//   设置 · 组件里装的「Codex 接入」（454，<组件区>\codex）也算装了，先找它再找 PATH（install.ts 的 findCodexEntry）；组件区在哪由宿主问 missing 时交来，
//   体检、深度体检找 codex 用同一个。用的是组件装的那份时，设置 · 插件里多一句说明（note）：它不在 PATH 上，登录要在终端运行的完整命令。
// - 体检（414，doctor.ts）：登记"程序和版本"一项——开机以后 codex 被卸了、降了版本，这一项变红（版本读缓存，没缓存异步跑一次 --version）。
//   找 codex 用守护进程的环境（KERNEL.env，415 为登录检查加的），和深度体检的登录看同一个程序。
// - 深度体检（415，deep-doctor.ts）：体检页上点了"深度体检"才跑一次 codex login status，看本机的 Codex 登录了没有。
import { t } from "@ergo/protocol";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { CODEX_PLUGIN } from "./api.ts";
import { type CodexProgram, codexProgramCheck, probeCodexProgram } from "./doctor.ts";
import { type CodexLoginStatus, codexLoginCheck, codexLoginStatus } from "./deep-doctor.ts";
import { CODEX_MIN_VERSION, codexLoginCommand, codexMissing, codexVersion, findCodexEntry, versionOlder } from "./install.ts";
import { codexRuntime } from "./runtime.ts";
import { type CodexSessionSource, oneShotSessionSource } from "./sessions.ts";

/**
 * 用的是组件装的 codex 时设置 · 插件里的那句说明（不在 PATH 上）和登录要运行的完整命令（网页上单独一行）；
 * 用 PATH 上的、没找到、组件里的版本读不出或太旧都没有（没找到、太旧时插件不装配，那句话在 missing 里）
 */
export function codexComponentNote(env: Readonly<Record<string, string | undefined>>, componentsDir: string | undefined): { text: string; command: string } | undefined {
  if (componentsDir === undefined) return undefined;
  const entry = findCodexEntry(env, { componentsDir });
  if (!entry?.component) return undefined;
  const version = codexVersion(entry);
  if (version === undefined || versionOlder(version, CODEX_MIN_VERSION)) return undefined;
  return { text: t("codex.plugin.componentNote", { version }), command: codexLoginCommand(entry) };
}

/**
 * Codex 插件；entry 不给是真的子进程入口（测试换成接假 app-server 的）；sessions 不给是经一次性子进程读本机的会话（主切面换成假的）；
 * missing 不给是先找组件区、再按 PATH 找本机的 codex（测试换掉，结果不看这台机器装没装）；program 不给是体检时看本机真的 codex（测试换成假的，不跑 codex）；
 * loginStatus 不给是跑本机的 codex login status（深度体检用，415；测试换成假的，不跑真的 codex）
 */
export function createCodexPlugin(
  options: { entry?: string; sessions?: CodexSessionSource; missing?: () => string | undefined; program?: () => Promise<CodexProgram>; loginStatus?: CodexLoginStatus } = {},
): PluginDefinition {
  /** 接管已有会话用的会话来源：插件在运行时才有（停用时登记表不会叫到它） */
  let sessions: CodexSessionSource | undefined;
  /** 组件区在哪（宿主问 missing 时交来；体检、深度体检、设置 · 插件里的说明找组件装的 codex 用） */
  let componentsDir: string | undefined;
  /** 守护进程的环境（装配时取到；还没装配过时按本进程的） */
  let daemonEnv: Readonly<Record<string, string | undefined>> = process.env;
  return {
    name: CODEX_PLUGIN,
    get title() {
      return t("codex.plugin.title");
    },
    get summary() {
      return t("codex.plugin.summary");
    },
    get note() {
      return codexComponentNote(daemonEnv, componentsDir);
    },
    needs: [KERNEL.oneShot, KERNEL.env],
    missing: (ctx) => {
      componentsDir = ctx?.componentsDir;
      return options.missing ? options.missing() : codexMissing(process.env, componentsDir);
    },
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
      daemonEnv = env;
      ctx.effect(() => {
        sessions = options.sessions ?? oneShotSessionSource(run);
        return () => {
          sessions = undefined;
        };
      });
      // 体检（414）：本机的 codex 还在不在、版本够不够（开机时的样子由插件本身、运行时那两项写）。
      // 和深度体检的登录（415）一样按守护进程的环境（KERNEL.env）找 codex，两项看的是同一个程序
      ctx.doctor.register(codexProgramCheck(options.program ?? (() => probeCodexProgram(env, componentsDir))));
      // 深度体检（415）：登录了没有（跑一次 codex login status；点了"深度体检"才跑）。组件装的也认（454）
      ctx.doctor.register(codexLoginCheck(options.loginStatus ?? codexLoginStatus(() => env, () => componentsDir)));
    },
  };
}

export const codexPlugin: PluginDefinition = createCodexPlugin();
