// Codex 运行时的设置项（⚙ 里按运行时多出"沙箱""思考档位"）：守护进程这一侧（runtime.ts，⚙ 里列）和适配子进程（child/session.ts 翻成 app-server 的参数）
// 共用这一份，这里不 import 子进程的模块。
// - 沙箱（thread/start 的 sandbox）：跟 Codex 自己的设置（默认：不传，用 config.toml 的 sandbox_mode）、只读、只能写工作目录、不用沙箱（只靠二狗的守卫）；
// - 思考档位（turn/start 的 effort）：跟 Codex 自己的设置（不传）、low / medium / high / xhigh（0.166 的 model/list 里各模型都有的这几档）；
// - 模型：子进程起来时按 model/list 报回（宿主协议 runtime_catalog）；还没报过时是空的，选"跟 Codex 自己的设置"。没选不传 model。
// 审批策略不是设置项：子进程固定用最严的 untrusted、审批请求送到二狗（ADR-0046）。
import { type RuntimeSettingView, t } from "@ergo/protocol";

/** 设置项的"跟 Codex 自己的设置"：不传 */
export const CODEX_INHERIT = "inherit";

/** 设置项的 id（任务、项目的 runtimeOptions.settings 里写的就是它，定了别改） */
export const CODEX_SETTING = { sandbox: "sandbox", effort: "effort" } as const;

export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type CodexEffortLevel = (typeof CODEX_EFFORT_LEVELS)[number];

/** 设置项（给人看的字按当前语言现取） */
export function codexSettings(): RuntimeSettingView[] {
  const inherit = { value: CODEX_INHERIT, title: t("codex.settings.inherit") };
  return [
    {
      id: CODEX_SETTING.sandbox,
      title: t("codex.settings.sandbox"),
      options: [inherit, ...CODEX_SANDBOX_MODES.map((mode) => ({ value: mode, title: t(`codex.settings.sandboxMode.${mode}`) }))],
      default: CODEX_INHERIT,
    },
    {
      id: CODEX_SETTING.effort,
      title: t("codex.settings.effort"),
      options: [inherit, ...CODEX_EFFORT_LEVELS.map((level) => ({ value: level, title: t(`codex.settings.effortLevel.${level}`) }))],
      default: CODEX_INHERIT,
    },
  ];
}

/** 负责人选的值：没选的、"跟 Codex 自己的设置"、不认得的都不传 */
export function codexChoices(chosen: { model?: string; settings?: Record<string, string> } | undefined): { model?: string; effort?: CodexEffortLevel; sandbox?: CodexSandboxMode } {
  const sandbox = chosen?.settings?.[CODEX_SETTING.sandbox];
  const effort = chosen?.settings?.[CODEX_SETTING.effort];
  return {
    ...(chosen?.model ? { model: chosen.model } : {}),
    ...(effort !== undefined && (CODEX_EFFORT_LEVELS as readonly string[]).includes(effort) ? { effort: effort as CodexEffortLevel } : {}),
    ...(sandbox !== undefined && (CODEX_SANDBOX_MODES as readonly string[]).includes(sandbox) ? { sandbox: sandbox as CodexSandboxMode } : {}),
  };
}
