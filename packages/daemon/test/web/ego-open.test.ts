// 466 返修（"甲"）：agent 要用 ego-browser、ego lite 没开着时，二狗像用户自己打开那样替他打开（交给桌面外壳，不在二狗的 Job 里），
// 等它好了再往下（web/ego-open.ts）。这里全用假的：假进程、假管道、假的打开、假时钟——不碰真的 ego lite。
// 真的"交给桌面外壳打开的进程不在 Job 里"在 ego-open-job.test.ts（Windows 才跑，用假程序）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimOpening,
  EGO_OPEN_SETTLE_MS,
  EGO_OPEN_TIMEOUT_MS,
  egoAppPath,
  egoBootstrapListening,
  egoCommandNeedsApp,
  type EgoOpenDeps,
  ensureEgoOpen,
  explorerPath,
} from "../../src/web/ego-open.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const APP = "C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe";

/**
 * 假的 ego lite：launch 之后过 startAfter 毫秒主进程起来，再过 pipeAfter 毫秒引导服务的管道出现（undefined 是一直不出现）；
 * 假时钟，sleep 只是往前拨
 */
function fakeEgo(options: { open?: boolean; startAfter?: number; pipeAfter?: number; shell?: boolean; app?: string | null; launchError?: string; claimed?: boolean } = {}) {
  let clock = 0;
  let launchedAt: number | undefined;
  const launches: string[] = [];
  let released = 0;
  const up = (after: number | undefined) => options.open === true || (launchedAt !== undefined && after !== undefined && clock - launchedAt >= after);
  const deps: EgoOpenDeps = {
    running: () => up(options.startAfter ?? 0),
    bootstrapListening: () => options.open === true || (launchedAt !== undefined && options.pipeAfter !== undefined && up((options.startAfter ?? 0) + options.pipeAfter)),
    shellRunning: () => options.shell ?? true,
    appPath: options.app === null ? undefined : (options.app ?? APP),
    launch: async (app) => {
      launches.push(app);
      if (options.launchError) throw new Error(options.launchError);
      launchedAt = clock;
    },
    claim: () => (options.claimed ? undefined : () => void released++),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { deps, launches, released: () => released, clock: () => clock, launchedBySomeoneElse: () => (launchedAt = clock) };
}

describe("ego lite 没开着时替用户打开", () => {
  it("本来就开着（主进程在、或者引导服务在）：不开，直接往下", async () => {
    const ego = fakeEgo({ open: true });
    expect(await ensureEgoOpen(ego.deps)).toEqual({ kind: "open" });
    expect(ego.launches).toEqual([]);
  });

  it("没开：交给桌面外壳打开主程序，等到引导服务的管道出现就往下；放开占位", async () => {
    const ego = fakeEgo({ startAfter: 1000, pipeAfter: 1500 });
    expect(await ensureEgoOpen(ego.deps)).toEqual({ kind: "opened", ready: "bootstrap" });
    expect(ego.launches).toEqual([APP]);
    expect(ego.clock()).toBeGreaterThanOrEqual(2500);
    expect(ego.clock()).toBeLessThan(EGO_OPEN_SETTLE_MS);
    expect(ego.released()).toBe(1);
  });

  it("管道一直不出现（这一版不开着它、或者改了名字）：主进程起来够久也算好了（再起的 ego.exe 只会把命令转给它）", async () => {
    const ego = fakeEgo({ startAfter: 2000 });
    expect(await ensureEgoOpen(ego.deps)).toEqual({ kind: "opened", ready: "settled" });
    expect(ego.clock()).toBeGreaterThanOrEqual(2000 + EGO_OPEN_SETTLE_MS);
    expect(ego.clock()).toBeLessThan(EGO_OPEN_TIMEOUT_MS);
  });

  it("等到点了也没见它起来：开不成，不往下（不让 ego-browser 自己去起一个留在 Job 里的）", async () => {
    const ego = fakeEgo({ startAfter: EGO_OPEN_TIMEOUT_MS * 2 });
    expect(await ensureEgoOpen(ego.deps)).toEqual({ kind: "failed", reason: "not-started" });
    expect(ego.clock()).toBeGreaterThanOrEqual(EGO_OPEN_TIMEOUT_MS);
    expect(ego.released()).toBe(1);
  });

  it("快到点才起来：到点时见过主进程就算开了", async () => {
    const ego = fakeEgo({ startAfter: EGO_OPEN_TIMEOUT_MS - 1000 });
    expect(await ensureEgoOpen(ego.deps)).toEqual({ kind: "opened", ready: "settled" });
  });

  it("找不到主程序、同一个会话里没有桌面外壳：不开（那样起的 explorer 自己会成外壳、留在 Job 里），说清原因", async () => {
    const noApp = fakeEgo({ app: null });
    expect(await ensureEgoOpen(noApp.deps)).toEqual({ kind: "failed", reason: "no-app" });
    const noShell = fakeEgo({ shell: false });
    expect(await ensureEgoOpen(noShell.deps)).toEqual({ kind: "failed", reason: "no-shell" });
    expect([...noApp.launches, ...noShell.launches]).toEqual([]);
  });

  it("起 explorer 出错：开不成，带上原因", async () => {
    const ego = fakeEgo({ launchError: "spawn explorer.exe ENOENT" });
    expect(await ensureEgoOpen(ego.deps)).toEqual({ kind: "failed", reason: "launch-error", detail: "spawn explorer.exe ENOENT" });
    expect(ego.released()).toBe(1);
  });

  it("别的 agent 正在开（占不到）：自己不再开一次，只等它好", async () => {
    const ego = fakeEgo({ claimed: true, startAfter: 500, pipeAfter: 500 });
    ego.launchedBySomeoneElse();
    expect(await ensureEgoOpen(ego.deps)).toEqual({ kind: "opened", ready: "bootstrap" });
    expect(ego.launches).toEqual([]);
  });
});

describe("哪些命令要 ego lite 开着", () => {
  it("连 ego lite 的要（nodejs、skill、import、upgrade、认不得的）；只看帮助、版本的、什么都不带的不要", () => {
    for (const args of [["nodejs"], ["nodejs", "-e", "1"], ["skill"], ["import", "list"], ["upgrade"], ["--ego-server-name=a", "nodejs"], ["whatever"]]) {
      expect(egoCommandNeedsApp(args)).toBe(true);
    }
    for (const args of [[], ["--version"], ["-v"], ["--help"], ["-h"], ["help"], ["help", "nodejs"], ["nodejs", "--help"], ["--ego-server-name=a"]]) {
      expect(egoCommandNeedsApp(args)).toBe(false);
    }
  });
});

describe("ego lite 的主程序和引导服务", () => {
  it("主程序：ego-browser 解开链接后的上一层（…\\Application\\ego.exe）；解不开、不在就看固定的安装位置；都没有是 undefined", () => {
    const real = "C:\\Program Files\\Citro Labs\\ego lite\\Application\\0.6.3.14";
    const found = { path: "C:\\Users\\u\\.local\\share\\ego\\active_version_dir\\ego-browser.exe", dir: "C:\\Users\\u\\.local\\share\\ego\\active_version_dir" };
    const files = new Set([APP]);
    const probe = (overrides: Partial<Parameters<typeof egoAppPath>[1]> = {}) => ({
      env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      isFile: (f: string) => files.has(f),
      realpath: (p: string) => (p === found.dir ? real : p),
      ...overrides,
    });
    expect(egoAppPath(found, probe())).toBe(APP);
    // 解不开链接：固定的位置
    expect(egoAppPath(found, probe({ realpath: () => { throw new Error("ENOENT"); } }))).toBe(APP);
    // 装在用户目录下的（LocalAppData）
    const local = "C:\\Users\\u\\AppData\\Local\\Citro Labs\\ego lite\\Application\\ego.exe";
    expect(egoAppPath(found, probe({ realpath: () => { throw new Error("ENOENT"); }, isFile: (f) => f === local }))).toBe(local);
    expect(egoAppPath(found, probe({ isFile: () => false }))).toBeUndefined();
  });

  it("引导服务：有一个名字以 mojo.CitroLabs.ego. 开头的命名管道（不分大小写）；别的 Chromium 的 mojo 管道不算", () => {
    expect(egoBootstrapListening(["mojo.19204.15248.6056030197404415259", "mojo.CitroLabs.ego.0.6.3.14"])).toBe(true);
    expect(egoBootstrapListening(["MOJO.CITROLABS.EGO.0.7.0.1"])).toBe(true);
    expect(egoBootstrapListening(["mojo.19204.15248.6056030197404415259", "mojo.chromoting.host_services_mojo_ipc"])).toBe(false);
    expect(egoBootstrapListening([])).toBe(false);
  });

  it("桌面外壳是 Windows 目录下的 explorer.exe", () => {
    expect(explorerPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\explorer.exe");
    expect(explorerPath({ SYSTEMROOT: "C:\\Windows" })).toBe("C:\\Windows\\explorer.exe");
  });
});

describe("几个 agent 同时要用时只开一次", () => {
  it("先来的占到、放手之后别人才占得到；占着太久的当那边死了、接着占", () => {
    const dir = makeTempDir("ergo-ego-claim-");
    const first = claimOpening(dir);
    expect(first).toBeTypeOf("function");
    expect(claimOpening(dir)).toBeUndefined();
    first!();
    const again = claimOpening(dir);
    expect(again).toBeTypeOf("function");
    // 占着的那个早就该开完了（比如那个 shim 被杀了）：当它死了
    const later = Date.now() + 10 * 60_000;
    const takeover = claimOpening(dir, { now: () => later });
    expect(takeover).toBeTypeOf("function");
    takeover!();
    expect(fs.existsSync(path.join(dir, "opening"))).toBe(false);
  });
});
