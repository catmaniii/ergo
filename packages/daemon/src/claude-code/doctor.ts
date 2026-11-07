// Claude Code 插件自己的体检项（414），在 setup 里经 ctx.doctor.register 登记，passive（找文件、读 package.json，不起进程）。
// 二狗已经替它生成的不再重复（doctor/auto.ts）：插件本身（Agent SDK 没装时插件不装配，那一行是"要的外部组件没装"）、运行时 Claude Code
// 能不能用（读运行时登记表：装配那一刻的样子）。这里加"Agent SDK"（sdk）：插件在跑说明开机时 SDK 在——体检时再看一眼现在还在不在、
// 版本够不够（组件区里删了、换了旧的，重启之前运行时那一项还写"能用"）：
// - 找不到 SDK 了 → 坏了（新会话起不来；重启后插件会因为没装而不装配）；
// - 读不出版本 → 注意；比二狗认的那一版（packages/daemon/package.json 的 optionalDependencies）旧 → 注意；
// - 别的正常：写 SDK 的版本，顺带说本机有没有装 claude.exe（找得到时会话、接管、交给官方 App 都用它；没有时新会话用 SDK 自带的，
//   接管本机会话、交给官方 App 要它）——只是说一声，不算问题。
// 登录状态、额度不在这里查（要起子进程，留给深度体检 415）。
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import { compareVersions } from "../release/layout.ts";
import { findClaudeExecutable } from "./claude-env.ts";
import { claudeSdkInstalled, claudeSdkInstalledVersion, claudeSdkVersion } from "./sdk-installed.ts";

/** 体检时看到的 SDK：在不在、装着哪一版、二狗认哪一版、本机有没有 claude.exe */
export interface ClaudeSdkState {
  installed: boolean;
  version?: string;
  want?: string;
  cli: boolean;
}

/** 现在的样子：installed 不给按 Node 的解析规则和组件区找（测试换成假的）；env 是守护进程的环境（找 claude.exe） */
export function probeClaudeSdk(options: { componentsDir?: string; env: Readonly<Record<string, string | undefined>>; installed?: () => boolean }): ClaudeSdkState {
  const installed = (options.installed ?? (() => claudeSdkInstalled(options.componentsDir)))();
  const version = installed ? claudeSdkInstalledVersion(options.componentsDir) : undefined;
  const want = claudeSdkVersion();
  return { installed, ...(version === undefined ? {} : { version }), ...(want === undefined ? {} : { want }), cli: findClaudeExecutable(options.env) !== undefined };
}

/** Agent SDK 那一项 */
export function claudeSdkFinding(state: ClaudeSdkState): DoctorFinding {
  const open = { kind: "open" as const, route: "#/more/components" };
  if (!state.installed) return { level: "error", fact: { key: "claudeCode.doctor.sdk.gone" }, fix: { key: "claudeCode.doctor.sdk.fixInstall" }, action: open };
  if (state.version === undefined) return { level: "warn", fact: { key: "claudeCode.doctor.sdk.noVersion" }, fix: { key: "claudeCode.doctor.sdk.fixUpdate" }, action: open };
  if (state.want !== undefined && compareVersions(state.version, state.want) < 0) {
    return { level: "warn", fact: { key: "claudeCode.doctor.sdk.tooOld", params: { version: state.version, want: state.want } }, fix: { key: "claudeCode.doctor.sdk.fixUpdate" }, action: open };
  }
  return { level: "ok", fact: { key: state.cli ? "claudeCode.doctor.sdk.ok" : "claudeCode.doctor.sdk.okNoCli", params: { version: state.version } } };
}

/** "Agent SDK"那一项：probe 现取 */
export function claudeSdkCheck(probe: () => ClaudeSdkState): DoctorCheck {
  return { id: "sdk", title: "claudeCode.doctor.sdk.title", cost: "passive", run: () => claudeSdkFinding(probe()) };
}
