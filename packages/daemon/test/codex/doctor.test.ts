// Codex 插件的体检项（414，src/codex/doctor.ts）"程序和版本"：不起真的 codex——
// - 判法：找不到了坏了（跳设置 · 插件），读不出版本注意，版本太旧坏了，别的正常（写版本）；
// - 版本读缓存（和插件装配前的 missing 同一份，按"入口文件 + 修改时间"）：npm 装的读 package.json；codex.exe 用异步的 --version
//   （测试换成假的跑法），读过一次就不再跑，文件变了再跑；
// - 插件在跑时登记这一项（cost local，超时放到 16 秒），停用后跟着没了。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexProgramCheck, codexProgramFinding, probeCodexProgram } from "../../src/codex/doctor.ts";
import { CODEX_MIN_VERSION, CODEX_VERSION_TIMEOUT_MS, codexVersionChecked } from "../../src/codex/install.ts";
import { createCodexPlugin } from "../../src/codex/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { blockOf, itemOf, kernelDoctor } from "../helpers/plugin-doctor.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 编一个 npm 装好的 codex（和 install.test.ts 一样） */
function npmInstall(version: string): string {
  const dir = makeTempDir("ergo-fake-npm-");
  const pkg = path.join(dir, "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex"), "");
  fs.writeFileSync(path.join(pkg, "bin", "codex.js"), "");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  return dir;
}

describe("程序和版本（判法）", () => {
  it("找不到了：坏了；读不出版本：注意；太旧：坏了；够新：正常", () => {
    expect(codexProgramFinding({ found: false })).toMatchObject({ level: "error", fact: { key: "codex.doctor.program.gone" }, fix: { key: "codex.doctor.program.fixInstall" }, action: { kind: "open", route: "#/more/plugins" } });
    expect(codexProgramFinding({ found: true })).toMatchObject({ level: "warn", fact: { key: "codex.doctor.program.noVersion" } });
    expect(codexProgramFinding({ found: true, version: "0.100.0" })).toMatchObject({ level: "error", fact: { key: "codex.doctor.program.tooOld", params: { version: "0.100.0", min: CODEX_MIN_VERSION } } });
    expect(codexProgramFinding({ found: true, version: CODEX_MIN_VERSION })).toEqual({ level: "ok", fact: { key: "codex.doctor.program.ok", params: { version: CODEX_MIN_VERSION, min: CODEX_MIN_VERSION } } });
  });

  it("这一项是 local、超时放到 --version 的上限之后", () => {
    expect(codexProgramCheck(async () => ({ found: true, version: "1.0.0" }))).toMatchObject({ id: "program", cost: "local", timeoutMs: CODEX_VERSION_TIMEOUT_MS + 1_000 });
  });
});

describe("读版本", () => {
  it("npm 装的读 package.json；PATH 里没有是找不到", async () => {
    expect(await probeCodexProgram({ PATH: npmInstall("0.170.2") })).toEqual({ found: true, version: "0.170.2" });
    expect(await probeCodexProgram({ PATH: makeTempDir("ergo-empty-path-") })).toEqual({ found: false });
  });

  it("codex.exe：异步跑 --version（假的），读过一次记住、不再跑；文件变了再跑；跑不出来是读不出；文件没了不跑", async () => {
    const program = path.join(makeTempDir("ergo-fake-exe-"), "codex.exe");
    fs.writeFileSync(program, "");
    const runs: string[] = [];
    const run = async (file: string) => {
      runs.push(file);
      return runs.length === 1 ? "codex-cli 0.170.0\n" : undefined;
    };
    const entry = { command: program, args: [] };
    expect(await codexVersionChecked(entry, run)).toBe("0.170.0");
    expect(await codexVersionChecked(entry, run)).toBe("0.170.0");
    expect(runs).toEqual([program]);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(program, later, later);
    expect(await codexVersionChecked(entry, run)).toBeUndefined();
    expect(runs).toHaveLength(2);
    fs.rmSync(program);
    expect(await codexVersionChecked(entry, run)).toBeUndefined();
    expect(runs).toHaveLength(2);
  });
});

/** 假的 codex login status（415 的深度体检；平时体检不跑它） */
const loginStatus = () => Promise.resolve({ code: 0, stdout: "", stderr: "Logged in using ChatGPT" });

describe("体检页上的 Codex 一块", () => {
  it("插件在跑时有这一项：开机以后 codex 没了是坏了；停用后跟着没了", async () => {
    let program: { found: boolean; version?: string } = { found: true, version: "0.170.0" };
    // 深度体检的登录（415）也换成假的（loginStatus）：平时体检不跑它，这里只看登记上了
    const plugin = createCodexPlugin({ missing: () => undefined, sessions: {} as never, program: async () => program, loginStatus });
    // 415 起插件要 KERNEL.env（跑 codex 用守护进程的环境）
    const k = await startPluginKernel({
      plugins: [plugin],
      services: [extraService(KERNEL.oneShot, () => (() => Promise.reject(new Error("测试里不起子进程"))) as never), extraService(KERNEL.env, () => ({ PATH: makeTempDir("ergo-empty-path-") }))],
    });
    expect(k.doctorChecks.list().map((c) => `${c.plugin}:${c.id}`)).toEqual(["codex:program", "codex:login"]);
    expect(itemOf(await kernelDoctor(k).view(), "codex", "program")).toMatchObject({ level: "ok", text: { title: "程序和版本", fact: `Codex 0.170.0（要 ${CODEX_MIN_VERSION} 或更新的）` } });
    program = { found: false };
    const gone = await kernelDoctor(k).view();
    expect(itemOf(gone, "codex", "program")).toMatchObject({ level: "error", text: { fact: "找不到本机的 Codex 了（开机时还在）：用它的任务、项目起不来" } });
    expect(blockOf(gone, "codex")!.level).toBe("error");
    await k.host.disable("codex");
    expect(k.doctorChecks.list()).toEqual([]);
  });

  it("不给 program 时按守护进程的环境（KERNEL.env，和深度体检的登录一样）找 codex：那个 PATH 里 npm 装的读 package.json，不跑程序", async () => {
    const env = { PATH: npmInstall("0.170.2") };
    const plugin = createCodexPlugin({ missing: () => undefined, sessions: {} as never, loginStatus });
    const k = await startPluginKernel({
      plugins: [plugin],
      services: [extraService(KERNEL.oneShot, () => (() => Promise.reject(new Error("测试里不起子进程"))) as never), extraService(KERNEL.env, () => env)],
    });
    expect(itemOf(await kernelDoctor(k).view(), "codex", "program")).toMatchObject({ level: "ok", text: { fact: `Codex 0.170.2（要 ${CODEX_MIN_VERSION} 或更新的）` } });
    // 守护进程的 PATH 里没有了：找不到（不看跑测试的这台机器装没装）
    env.PATH = makeTempDir("ergo-empty-path-");
    expect(itemOf(await kernelDoctor(k).view(), "codex", "program")).toMatchObject({ level: "error" });
  });
});
