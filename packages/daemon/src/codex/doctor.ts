// Codex 插件自己的体检项（414），在 setup 里经 ctx.doctor.register 登记。
// 二狗已经替它生成的不再重复（doctor/auto.ts）：插件本身（没装、版本太低时插件不装配，那一行是"要的外部组件没装"）、运行时 Codex
// 能不能用（读运行时登记表：装配那一刻的样子）。这里加"程序和版本"（program）：插件在跑说明开机时 codex 在、版本够——
// 体检时再看一眼现在还是不是（用户卸了、PATH 改了、降了版本，重启之前运行时那一项还写"能用"）：
// - 找不到本机的 codex 了 → 坏了（用它的任务、项目起不来；重启后插件会因为没装而不装配）；
// - 读不出版本 → 注意；版本低于 CODEX_MIN_VERSION → 坏了（app-server 的协议按那一版核对）；
// - 别的正常（写版本）。
// cost 是 local：版本按"入口文件 + 修改时间"缓存（插件装配前的 missing 读过一次），文件没变直接用；变了要现读——npm 装的读 package.json，
// codex.exe 异步跑一次 --version，最多 15 秒，所以这一项的超时放到 16 秒。登录状态不在这里查（要起 app-server，留给深度体检 415）。
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import { CODEX_MIN_VERSION, CODEX_VERSION_TIMEOUT_MS, codexVersionChecked, findCodexEntry, versionOlder } from "./install.ts";

/** 体检时看到的本机 codex：找没找到、什么版本（读不出来没有） */
export interface CodexProgram {
  found: boolean;
  version?: string;
}

/** 现在本机的 codex（按守护进程的环境找入口，版本读缓存、没缓存现读） */
export async function probeCodexProgram(env: Readonly<Record<string, string | undefined>> = process.env): Promise<CodexProgram> {
  const entry = findCodexEntry(env);
  if (!entry) return { found: false };
  const version = await codexVersionChecked(entry);
  return { found: true, ...(version === undefined ? {} : { version }) };
}

/** 程序和版本那一项 */
export function codexProgramFinding(program: CodexProgram): DoctorFinding {
  const open = { kind: "open" as const, route: "#/more/plugins" };
  if (!program.found) return { level: "error", fact: { key: "codex.doctor.program.gone" }, fix: { key: "codex.doctor.program.fixInstall" }, action: open };
  if (program.version === undefined) return { level: "warn", fact: { key: "codex.doctor.program.noVersion", params: { min: CODEX_MIN_VERSION } }, fix: { key: "codex.doctor.program.fixUpdate" } };
  if (versionOlder(program.version, CODEX_MIN_VERSION)) {
    return { level: "error", fact: { key: "codex.doctor.program.tooOld", params: { version: program.version, min: CODEX_MIN_VERSION } }, fix: { key: "codex.doctor.program.fixUpdate" }, action: open };
  }
  return { level: "ok", fact: { key: "codex.doctor.program.ok", params: { version: program.version, min: CODEX_MIN_VERSION } } };
}

/** "程序和版本"那一项：probe 不给是看本机真的 codex（测试换成假的） */
export function codexProgramCheck(probe: () => Promise<CodexProgram> = () => probeCodexProgram()): DoctorCheck {
  return { id: "program", title: "codex.doctor.program.title", cost: "local", timeoutMs: CODEX_VERSION_TIMEOUT_MS + 1_000, run: async () => codexProgramFinding(await probe()) };
}
