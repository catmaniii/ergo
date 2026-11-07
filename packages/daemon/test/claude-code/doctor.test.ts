// Claude Code 插件的体检项（414，src/claude-code/doctor.ts）"Agent SDK"：不起真的 claude——
// - 判法：找不到了坏了（跳设置 · 组件），读不出版本、比二狗认的旧是注意，别的正常（写版本，顺带说本机有没有 claude.exe）；
// - 读 SDK 的版本：从入口往上找名字对得上的 package.json（中间别的 package.json 跳过）；仓库里开发时装着的就是二狗认的那一版；
// - 本机的 claude.exe 按 PATH 找（只找文件，不跑）；
// - 插件在跑时登记这一项，开机以后 SDK 没了这一项变红。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeSdkFinding, probeClaudeSdk } from "../../src/claude-code/doctor.ts";
import { createClaudeCodePlugin } from "../../src/claude-code/plugin.ts";
import { CLAUDE_SDK_PACKAGE, claudeSdkInstalledVersion, claudeSdkVersion, claudeSdkVersionNear } from "../../src/claude-code/sdk-installed.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { itemOf, kernelDoctor } from "../helpers/plugin-doctor.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("Agent SDK（判法）", () => {
  it("找不到了：坏了；读不出版本、比认的旧：注意；够新：正常，按有没有 claude.exe 两种说法", () => {
    expect(claudeSdkFinding({ installed: false, cli: true })).toMatchObject({ level: "error", fact: { key: "claudeCode.doctor.sdk.gone" }, fix: { key: "claudeCode.doctor.sdk.fixInstall" }, action: { kind: "open", route: "#/more/components" } });
    expect(claudeSdkFinding({ installed: true, want: "0.3.296", cli: true })).toMatchObject({ level: "warn", fact: { key: "claudeCode.doctor.sdk.noVersion" } });
    expect(claudeSdkFinding({ installed: true, version: "0.3.290", want: "0.3.296", cli: true })).toMatchObject({ level: "warn", fact: { key: "claudeCode.doctor.sdk.tooOld", params: { version: "0.3.290", want: "0.3.296" } } });
    expect(claudeSdkFinding({ installed: true, version: "0.3.296", want: "0.3.296", cli: true })).toEqual({ level: "ok", fact: { key: "claudeCode.doctor.sdk.ok", params: { version: "0.3.296" } } });
    expect(claudeSdkFinding({ installed: true, version: "0.3.300", want: "0.3.296", cli: false })).toEqual({ level: "ok", fact: { key: "claudeCode.doctor.sdk.okNoCli", params: { version: "0.3.300" } } });
  });
});

describe("读 SDK 的版本、找 claude.exe", () => {
  it("从入口往上找名字对得上的 package.json；没有是读不出；仓库里装着的就是认的那一版", () => {
    const pkg = path.join(makeTempDir("ergo-fake-sdk-"), "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"));
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: CLAUDE_SDK_PACKAGE, version: "0.3.296" }));
    fs.writeFileSync(path.join(pkg, "dist", "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(pkg, "dist", "sdk.mjs"), "");
    expect(claudeSdkVersionNear(path.join(pkg, "dist", "sdk.mjs"))).toBe("0.3.296");
    expect(claudeSdkVersionNear(path.join(makeTempDir("ergo-no-sdk-"), "x.mjs"))).toBeUndefined();
    expect(claudeSdkInstalledVersion()).toBe(claudeSdkVersion());
  });

  it.runIf(process.platform === "win32")("claude.exe 按 PATH 找（只找文件）；没有就说没有；没装时不读版本", () => {
    const bin = makeTempDir("ergo-fake-claude-");
    fs.writeFileSync(path.join(bin, "claude.exe"), "");
    expect(probeClaudeSdk({ env: { PATH: bin }, installed: () => true })).toMatchObject({ installed: true, want: claudeSdkVersion(), cli: true });
    expect(probeClaudeSdk({ env: { PATH: makeTempDir("ergo-empty-path-") }, installed: () => false })).toEqual({ installed: false, want: claudeSdkVersion(), cli: false });
  });
});

describe("体检页上的 Claude Code 一块", () => {
  it("插件在跑时有这一项；开机以后 SDK 没了：坏了", async () => {
    let sdk = true;
    const plugin = createClaudeCodePlugin({ sdkInstalled: () => sdk, sessions: {} as never, cli: {} as never });
    const k = await startPluginKernel({
      plugins: [plugin],
      services: [extraService(KERNEL.oneShot, () => (() => Promise.reject(new Error("测试里不起子进程"))) as never), extraService(KERNEL.env, () => ({ PATH: makeTempDir("ergo-empty-path-") }))],
    });
    // 415 的深度体检"登录"也登记在这一块（cost deep，平时体检不跑）
    expect(k.doctorChecks.list().map((c) => `${c.plugin}:${c.id}`)).toEqual(["claude-code:sdk", "claude-code:login"]);
    expect(itemOf(await kernelDoctor(k).view(), "claude-code", "sdk")).toMatchObject({ level: "ok", text: { title: "Agent SDK", fact: expect.stringContaining("本机没找到 claude.exe") } });
    sdk = false;
    expect(itemOf(await kernelDoctor(k).view(), "claude-code", "sdk")).toMatchObject({ level: "error", text: { fact: "找不到 Claude Code 的 Agent SDK 了（开机时还在）：用 Claude Code 的任务、项目起不来" } });
  });
});
