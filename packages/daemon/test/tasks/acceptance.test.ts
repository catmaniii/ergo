// 脚本验收（规格第 8 节"验收"：运行时的钩子运行，看退出码和输出，13 号票）：
// - 退出码 0 才算通过；计划里写了期望的输出（包含某段文字、匹配某个模式）时一并判定，没写只看退出码；
// - 进程照带类型 bash 工具的启动器起（28 号票的 runner：闸门进程先进这次调用的 Job 对象），超时时整棵进程树一起结束。
// 238 号票：这台机器上真找不到 Git Bash 时，靠 bash 跑的用例明确跳过（skipIf(!hasGitBash)），不要表现成 30 秒超时。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { outputMismatches, runAcceptanceScript, scriptOutcome } from "../../src/tasks/acceptance.ts";
import { createTypedShell } from "../../src/typed-shell/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { hasGitBash } from "../helpers/git-bash.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";

const ran = (exitCode: number | null, output: string, extra: { stopped?: "timeout" | "aborted"; error?: string } = {}) => ({ exitCode, stdout: output, output, truncated: false, ...extra });

describe("判定（纯函数）", () => {
  it.each([
    ["没写期望的输出：只看退出码", ran(0, "随便"), undefined, true, "退出码 0；输出：随便"],
    ["退出码不是 0", ran(1, "3 failed"), undefined, false, "退出码 1；输出：3 failed"],
    ["要包含的文字对上了", ran(0, "12 passed, 0 failed"), { contains: "0 failed" }, true, "退出码 0；输出：12 passed, 0 failed"],
    ["要包含的文字没有", ran(0, "12 passed, 2 failed"), { contains: "0 failed" }, false, "退出码 0，输出里没有「0 failed」；输出：12 passed, 2 failed"],
    ["匹配模式", ran(0, "coverage 93%"), { matches: "coverage (9\\d|100)%" }, true, "退出码 0；输出：coverage 93%"],
    ["不匹配模式", ran(0, "coverage 71%"), { matches: "coverage (9\\d|100)%" }, false, "退出码 0，输出不匹配 /coverage (9\\d|100)%/；输出：coverage 71%"],
    ["两样都写：都要对上", ran(0, "ok\ncoverage 95%"), { contains: "ok", matches: "coverage 9" }, true, "退出码 0；输出：ok\ncoverage 95%"],
    ["输出对上了、退出码不是 0：不通过", ran(2, "0 failed"), { contains: "0 failed" }, false, "退出码 2；输出：0 failed"],
  ] as const)("%s", (_name, run, expect_, passed, note) => {
    expect(scriptOutcome(run, { expectOutput: expect_, timeoutMs: 600_000 })).toEqual({ passed, note });
  });

  it("超时、被中止、起不来：都不通过，写明原因", () => {
    expect(scriptOutcome(ran(null, "半截", { stopped: "timeout" }), { timeoutMs: 5_000 })).toEqual({ passed: false, note: "脚本超过 5 秒没跑完，已结束；输出：半截" });
    expect(scriptOutcome(ran(null, "", { stopped: "aborted" }), { timeoutMs: 5_000 })).toEqual({ passed: false, note: "脚本被中止了" });
    expect(scriptOutcome(ran(null, "", { error: "找不到 Git Bash（要装 Git for Windows）" }), { timeoutMs: 5_000 })).toEqual({ passed: false, notRun: true, note: "脚本没跑起来：找不到 Git Bash（要装 Git for Windows）" });
  });

  it("验收没跑起来（311 号票）：起不来、命令找不到或不能执行（退出码 127、126）标 notRun——和跑了、对不上的分开；超时、被中止、退出码 1 不算", () => {
    expect(scriptOutcome(ran(null, "", { error: "闸门进程起不来" }), { timeoutMs: 5_000 })).toEqual({ passed: false, notRun: true, note: "脚本没跑起来：闸门进程起不来" });
    expect(scriptOutcome(ran(127, "bash: pytest: command not found"), { timeoutMs: 5_000 })).toEqual({ passed: false, notRun: true, note: "退出码 127；输出：bash: pytest: command not found" });
    expect(scriptOutcome(ran(126, "bash: ./check.sh: Permission denied"), { timeoutMs: 5_000 })).toMatchObject({ passed: false, notRun: true });
    for (const run of [ran(1, "1 failed"), ran(null, "半截", { stopped: "timeout" }), ran(null, "", { stopped: "aborted" }), ran(0, "ok")]) {
      expect(scriptOutcome(run, { timeoutMs: 5_000 }).notRun).toBeUndefined();
    }
  });

  it("没对上的地方逐条列出", () => {
    expect(outputMismatches("x", { contains: "y", matches: "^z" })).toEqual(["输出里没有「y」", "输出不匹配 /^z/"]);
    expect(outputMismatches("x", undefined)).toEqual([]);
  });
});

function shell() {
  const home = makeTempDir("ergo-home-");
  return createTypedShell({ parentEnv: withEnv(process.env, tempUserProfileEnv(home)), homeDir: home, timeouts: { defaultMs: 60_000, longMs: 60_000 }, log: () => {} });
}

describe.skipIf(!hasGitBash)("在工作目录里真的跑（Git Bash）", () => {
  it("当前目录是工作目录；标准输出和标准错误合在一起和期望的输出比", async () => {
    const work = realPathOf(makeTempDir("ergo-work-"))!;
    fs.writeFileSync(path.join(work, "report.md"), "# 报告\n");
    const sh = shell();
    const script = 'test -f report.md && echo "found report" && echo "warn: 0 failed" >&2';
    expect(await runAcceptanceScript(sh, { cwd: work, script, expectOutput: { contains: "0 failed", matches: "^found" }, network: false, timeoutMs: 60_000 })).toMatchObject({ passed: true });
    expect(await runAcceptanceScript(sh, { cwd: work, script, expectOutput: { contains: "3 failed" }, network: false, timeoutMs: 60_000 })).toMatchObject({
      passed: false,
      note: expect.stringContaining("输出里没有「3 failed」"),
    });
    expect(await runAcceptanceScript(sh, { cwd: work, script: "test -f missing.md", network: false, timeoutMs: 60_000 })).toEqual({ passed: false, note: "退出码 1" });
  });
});

const PID_FILES = ["grandchild.pid", "orphan.pid"];
const pidsIn = (dir: string) => PID_FILES.map((f) => Number(fs.readFileSync(path.join(dir, f), "utf8")));
const pidsWritten = (dir: string) => PID_FILES.every((f) => fs.existsSync(path.join(dir, f)) && fs.readFileSync(path.join(dir, f), "utf8") !== "");

describe.runIf(process.platform === "win32" && hasGitBash)("进程在这次调用的 Job 里", () => {
  it("超时时脚本起的孙进程、孤儿一起结束", async () => {
    const work = realPathOf(makeTempDir("ergo-work-"))!;
    const pids = makeTempDir("ergo-pids-");
    const grandchild = path.join(import.meta.dirname, "../fixtures/grandchild.mjs").replaceAll("\\", "/");
    const outcome = await runAcceptanceScript(shell(), { cwd: work, script: `node "${grandchild}" "${pids.replaceAll("\\", "/")}"`, network: false, timeoutMs: 5_000 });
    expect(outcome).toMatchObject({ passed: false, note: expect.stringMatching(/^脚本超过 5 秒没跑完，已结束/) });
    expect(pidsWritten(pids)).toBe(true);
    await waitUntil(() => pidsIn(pids).every((pid) => !isProcessAlive(pid)), { describe: () => `进程还活着：${pidsIn(pids).join("、")}` });
  });
});
