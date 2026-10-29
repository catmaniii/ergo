// Claude Code 运行时的设置项和可选模型（289 号票，issue 24 第三节丁类："⚙ 里按运行时多出'权限模式''思考档位'两项"）：
// 守护进程这一侧（runtime.ts 的 settings()、models()，⚙ 里列）和适配子进程（child/session.ts 拉起 query 时翻成 SDK 的选项）共用这一份，
// 所以这里不 import 子进程的模块、不 import SDK（boundary.test.ts）。
// - 权限模式（SDK 的 permissionMode）：跟 Claude Code 自己的设置（默认：不传，用户 settings 里的 defaultMode）、默认、自动接受改文件、
//   计划模式、自动（模型判断）、不问（没放行的拒绝）。bypassPermissions（全部放行）不列：要另开 allowDangerouslySkipPermissions，
//   二狗守卫（288 号票）之外再全放行没有意义；
// - 思考档位（SDK 的 effort）：跟 Claude Code 自己的设置（不传）、low / medium / high / xhigh / max；
// - 模型：子进程起来时报回 Claude Code 自己的列表（supportedModels，宿主协议 runtime_catalog，守护进程记在运行时登记表上）；
//   还没报过时先列 Claude Code 的三个别名（opus / sonnet / haiku，总是指向各自最新的那个）。没选是跟 Claude Code 自己的设置（不传 model）。
import { type RuntimeModelView, type RuntimeSettingView, t } from "@ergo/protocol";

/** 设置项的"跟 Claude Code 自己的设置"：不传给 SDK */
export const CLAUDE_INHERIT = "inherit";

/** 设置项的 id（任务、项目的 runtimeOptions.settings 里写的就是它，定了别改） */
export const CLAUDE_SETTING = { permissionMode: "permission_mode", effort: "effort" } as const;

/** 能选的权限模式（SDK 的 PermissionMode 去掉 bypassPermissions） */
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** 能选的思考档位（SDK 的 EffortLevel） */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/** 设置项（给人看的字按当前语言现取） */
export function claudeCodeSettings(): RuntimeSettingView[] {
  const inherit = { value: CLAUDE_INHERIT, title: t("claudeCode.settings.inherit") };
  return [
    {
      id: CLAUDE_SETTING.permissionMode,
      title: t("claudeCode.settings.permissionMode"),
      options: [inherit, ...CLAUDE_PERMISSION_MODES.map((mode) => ({ value: mode, title: t(`claudeCode.settings.permission.${mode}`) }))],
      default: CLAUDE_INHERIT,
    },
    {
      id: CLAUDE_SETTING.effort,
      title: t("claudeCode.settings.effort"),
      options: [inherit, ...CLAUDE_EFFORT_LEVELS.map((level) => ({ value: level, title: t(`claudeCode.settings.effortLevel.${level}`) }))],
      default: CLAUDE_INHERIT,
    },
  ];
}

/** 子进程还没报过 Claude Code 自己的模型列表时先列的：三个别名（总是指向各自最新的那个） */
export const CLAUDE_FALLBACK_MODELS: readonly RuntimeModelView[] = [
  { id: "opus", title: "Opus" },
  { id: "sonnet", title: "Sonnet" },
  { id: "haiku", title: "Haiku" },
];

/** 维护者选的值翻成 query 的选项：没选的、"跟 Claude Code 自己的设置"、不认得的都不传（用 Claude Code 自己的设置） */
export function claudeQueryChoices(chosen: { model?: string; settings?: Record<string, string> } | undefined): { model?: string; effort?: ClaudeEffortLevel; permissionMode?: ClaudePermissionMode } {
  const mode = chosen?.settings?.[CLAUDE_SETTING.permissionMode];
  const effort = chosen?.settings?.[CLAUDE_SETTING.effort];
  return {
    ...(chosen?.model ? { model: chosen.model } : {}),
    ...(effort !== undefined && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort) ? { effort: effort as ClaudeEffortLevel } : {}),
    ...(mode !== undefined && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode) ? { permissionMode: mode as ClaudePermissionMode } : {}),
  };
}
