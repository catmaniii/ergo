// 466：拉起 agent 子进程时，找到了 ego 浏览器就把给 agent 的那个目录放到 PATH 最前面（Windows 上是二狗写的薄 ego-browser 所在的
// shim 目录，web/ego-shim.ts；它要的环境变量一起给）；不再给 AGENT_BROWSER_* 三个变量。
// - 环境是 agent 管家按白名单拼的，和运行时无关：pi、Claude Code、Codex 三种运行时的子进程拿到的是同一份（用 fixtures/echo-assembly-child.ts
//   把子进程自己的环境写回来核对）；
// - 再往下：pi 的 bash 用子进程的环境（契约测试 shell-env 里真跑 bash 看）；Claude Code 交给 claude 的、Codex 交给 app-server 的环境
//   是从子进程的环境拷的（claudeProcessEnv、codexProcessEnv），PATH 和 shim 的环境变量原样带过去。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { agentChildEnv, createAgentManager, shellEnvFor } from "../../src/agent-manager/agent-manager.ts";
import { claudeProcessEnv } from "../../src/claude-code/claude-env.ts";
import { codexProcessEnv } from "../../src/codex/install.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { prependPath } from "../../src/process/child-env.ts";
import { piRuntime } from "../../src/runtime/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const ECHO_ENTRY = fileURLToPath(new URL("../fixtures/echo-assembly-child.ts", import.meta.url));
const EGO_DIR = "C:\\Users\\u\\.ergo\\cache\\ego-browser";
const EGO = { dir: EGO_DIR, env: { ERGO_EGO_SHIM_NODE: "C:\\node\\node.exe", ERGO_EGO_SHIM_ENTRY: "C:\\ergo\\ego-browser-shim-main.ts" } };
const pathOf = (env: Record<string, string | undefined>) => env[Object.keys(env).find((k) => k.toUpperCase() === "PATH")!]!;
const agentBrowserKeys = (env: Record<string, unknown>) => Object.keys(env).filter((k) => k.toUpperCase().startsWith("AGENT_BROWSER_"));
const shimKeys = (env: Record<string, unknown>) => Object.keys(env).filter((k) => k.startsWith("ERGO_EGO_"));

describe("PATH 前面加 ego 浏览器的目录", () => {
  it("加在最前面；变量名照原样的大小写；已经在里面的挪到前面、不重复；原来的不改", () => {
    const env = { Path: `C:\\Windows;${EGO_DIR.toUpperCase()};C:\\Git`, X: "1" };
    const out = prependPath(env, EGO_DIR, ";");
    expect(out).toEqual({ Path: `${EGO_DIR};C:\\Windows;C:\\Git`, X: "1" });
    expect(env.Path).toBe(`C:\\Windows;${EGO_DIR.toUpperCase()};C:\\Git`);
    expect(prependPath({}, EGO_DIR, ";")).toEqual({ PATH: EGO_DIR });
  });

  it("agent 子进程的环境：找到了加（目录在 PATH 最前面，shim 要的环境变量一起给）、没找到不加；守护进程环境里的 AGENT_BROWSER_* 不往下带；bash 的额外变量里也没有", () => {
    const parent = { PATH: "C:\\Windows", SystemRoot: "C:\\Windows", AGENT_BROWSER_EXECUTABLE_PATH: "C:\\chrome.exe", AGENT_BROWSER_SOCKET_DIR: "C:\\s" };
    const withEgo = agentChildEnv(parent, {}, EGO);
    expect(pathOf(withEgo).split(path.delimiter)[0]).toBe(EGO_DIR);
    expect(withEgo).toMatchObject(EGO.env);
    // 别的系统、写不了 shim 时只有目录
    expect(pathOf(agentChildEnv(parent, {}, { dir: EGO_DIR })).split(path.delimiter)[0]).toBe(EGO_DIR);
    expect(pathOf(agentChildEnv(parent, {}, undefined))).toBe("C:\\Windows");
    expect(shimKeys(agentChildEnv(parent, {}, undefined))).toEqual([]);
    expect(agentBrowserKeys(withEgo)).toEqual([]);
    expect(agentBrowserKeys(shellEnvFor(true))).toEqual([]);
    expect(agentBrowserKeys(shellEnvFor(false))).toEqual([]);
  });

  it("Claude Code 交给 claude 的、Codex 交给 app-server 的环境：PATH 原样带过去（ego 的目录还在最前面），shim 要的环境变量也在", () => {
    const child = agentChildEnv({ PATH: "C:\\Windows", SystemRoot: "C:\\Windows" }, {}, EGO);
    expect(pathOf(claudeProcessEnv(child)).split(path.delimiter)[0]).toBe(EGO_DIR);
    expect(pathOf(codexProcessEnv(child)).split(path.delimiter)[0]).toBe(EGO_DIR);
    expect(claudeProcessEnv(child)).toMatchObject(EGO.env);
    expect(codexProcessEnv(child)).toMatchObject(EGO.env);
  });
});

describe("三种运行时的子进程拿到的环境（真的拉起，子进程把自己的环境写回来）", () => {
  for (const runtime of ["pi", "claude-code", "codex"]) {
    it(`${runtime}：PATH 最前面是给 agent 的 ego-browser 的目录、shim 要的环境变量在，没有 AGENT_BROWSER_*；没找到 ego 时都不加`, async () => {
      for (const ego of [EGO, undefined]) {
        const dataDir = makeTempDir("ergo-ego-env-");
        const envFile = path.join(dataDir, "env.json");
        const assemblyFile = path.join(dataDir, "assembly.json");
        const manager = createAgentManager({
          layout: dataDirLayout(dataDir),
          // 守护进程的环境里就算有 AGENT_BROWSER_*（用户自己设的），也不往下带
          parentEnv: { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: "C:\\chrome.exe" },
          job: undefined,
          egoBrowserPath: () => ego,
          // 三种运行时都换成把环境写回来的子进程（不跑模型、不启动真的 claude、codex）
          runtimes: { resolve: (id) => ({ ...piRuntime, id, entry: ECHO_ENTRY }) },
          log: () => {},
        });
        manager.spawn({
          agentId: `ego-${runtime}`,
          ...(runtime === "pi" ? {} : { runtime }),
          model: { kind: "faux", script: [], thinkingLevel: "off" },
          tools: ["bash"],
          env: { ERGO_TEST_ENV_FILE: envFile, ERGO_TEST_ASSEMBLY_FILE: assemblyFile },
        });
        await vi.waitUntil(() => fs.existsSync(envFile) && fs.existsSync(assemblyFile), { timeout: 30_000 });
        const env = JSON.parse(fs.readFileSync(envFile, "utf8")) as Record<string, string>;
        const first = pathOf(env).split(path.delimiter)[0];
        expect(first === EGO_DIR).toBe(ego !== undefined);
        expect(env.ERGO_EGO_SHIM_NODE).toBe(ego?.env.ERGO_EGO_SHIM_NODE);
        expect(env.ERGO_EGO_SHIM_ENTRY).toBe(ego?.env.ERGO_EGO_SHIM_ENTRY);
        expect(agentBrowserKeys(env)).toEqual([]);
        const assembly = JSON.parse(fs.readFileSync(assemblyFile, "utf8")) as { shellEnv: Record<string, string> };
        expect(agentBrowserKeys(assembly.shellEnv)).toEqual([]);
        await manager.shutdown();
      }
    }, 60_000);
  }
});
