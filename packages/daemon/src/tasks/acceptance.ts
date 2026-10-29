// 阶段验收里"能写成脚本的标准"（规格第 8 节"验收"：由运行时的钩子运行，看退出码和输出）：在工作目录里跑，
// 退出码 0 才算通过；计划里写了期望的输出（expectOutput：包含某段文字、匹配某个模式）时一并判定，没写只看退出码。
// 输出（标准输出和标准错误按到达先后合在一起）的末尾一段记进结论。脚本是用户确认过的计划里写的，所以不再经守卫；
// 进程照 28 号票带类型 bash 工具的启动器起（typed-shell/：闸门进程先放进这次调用的 Job 对象再起 Git Bash，
// 孙进程跑不出去；环境是系统变量白名单，联网开关关着时加无效代理）。
import { type AcceptanceCriterion, t } from "@ergo/protocol";
import type { ShellRunResult, TypedShell } from "../typed-shell/index.ts";

/** 一条脚本验收的结果 */
export interface ScriptOutcome {
  passed: boolean;
  /** 给人看的一句：退出码、期望的输出对没对上、输出的末尾 */
  note: string;
  /**
   * 验收没跑起来（311 号票）：进程起不来（闸门进程起不来、找不到 Git Bash……），或者脚本里的命令找不到、不能执行（bash 的退出码 127、126）——
   * 不是跑了、和实际对不上。退回的框照它写"验收没跑起来"。跑起来了的没有这一项
   */
  notRun?: true;
}

/** bash 的命令找不到（127）、找到了不能执行（126）：脚本没真跑起来 */
const NOT_RUN_EXIT_CODES: readonly number[] = [126, 127];

/** 输出最多留这么多字（末尾） */
const OUTPUT_TAIL = 2000;

export interface AcceptanceScript {
  cwd: string;
  script: string;
  expectOutput?: AcceptanceCriterion["expectOutput"];
  /** 工具包的联网开关 */
  network: boolean;
  timeoutMs: number;
  /** 停下这次运行（276 号票返修：删任务时停掉在跑的复验）：关掉这次调用的 Job，脚本和它起的进程全部结束 */
  signal?: AbortSignal;
}

/** 期望的输出没对上的地方（都对上了是空的） */
export function outputMismatches(output: string, expect: AcceptanceCriterion["expectOutput"]): string[] {
  if (!expect) return [];
  return [
    ...(expect.contains !== undefined && !output.includes(expect.contains) ? [t("tasks.acceptance.missing", { text: expect.contains })] : []),
    ...(expect.matches !== undefined && !new RegExp(expect.matches).test(output) ? [t("tasks.acceptance.noMatch", { pattern: expect.matches })] : []),
  ];
}

/** 一次运行的结论 */
export function scriptOutcome(run: ShellRunResult, input: Pick<AcceptanceScript, "expectOutput" | "timeoutMs">): ScriptOutcome {
  const text = run.output.trim();
  const tail = text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;
  const shown = tail ? t("tasks.acceptance.output", { tail }) : "";
  if (run.error !== undefined) return { passed: false, notRun: true, note: t("tasks.acceptance.notStarted", { error: run.error }) };
  if (run.stopped === "timeout") return { passed: false, note: t("tasks.acceptance.timeout", { seconds: Math.round(input.timeoutMs / 1000) }) + shown };
  if (run.stopped === "aborted") return { passed: false, note: t("tasks.acceptance.aborted") + shown };
  const mismatches = outputMismatches(run.output, input.expectOutput);
  const passed = run.exitCode === 0 && mismatches.length === 0;
  const exit = run.exitCode === null ? t("tasks.acceptance.exitKilled") : t("tasks.acceptance.exitCode", { code: run.exitCode });
  const notRun = run.exitCode !== null && NOT_RUN_EXIT_CODES.includes(run.exitCode);
  return { passed, ...(notRun ? { notRun: true as const } : {}), note: [exit, ...mismatches].join(t("protocol.plan.scope.sep")) + shown };
}

/** 在工作目录里跑一条验收脚本 */
export async function runAcceptanceScript(shell: Pick<TypedShell, "runScript">, input: AcceptanceScript): Promise<ScriptOutcome> {
  const run = await shell.runScript({ cwd: input.cwd, script: input.script, network: input.network, timeoutMs: input.timeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
  return scriptOutcome(run, input);
}
