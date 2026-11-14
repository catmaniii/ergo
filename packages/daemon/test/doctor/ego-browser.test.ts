// 466：体检"二狗本身"里的"ego 浏览器"——找不找得到 ego-browser 命令（报路径和版本）、ego lite 开没开；
// 没装给一句该怎么办；没开着算正常、只写一句"agent 要用时二狗会打开"（466 返修）；看不了开没开（不是 Windows）照样报路径、版本。
// 版本从路径上看（active_version_dir 解开链接后的目录名），看不出来只报找到了。中英文都有。
// 体检不起任何进程（466 返修）：不跑 ego-browser --version——ego lite 没开着时它要是自己去拉起 ego，拉起来的就在二狗的 Job 里。
// 这里把 node:child_process 换成记账的一份，真跑一遍体检（假目录 + 链接），核对一次都没起。
import fs from "node:fs";
import path from "node:path";
import { activeLocale, activeLocaleFrom, doctorItemText, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDoctorChecks, type DoctorFinding } from "../../src/doctor/checks.ts";
import { registerCoreDoctorChecks } from "../../src/doctor/core.ts";
import { egoBrowserCheck, judgeEgoBrowser, realEgoBrowserSources } from "../../src/doctor/ego-browser.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 起子进程的每个函数都记一笔（照样转给真的） */
const spawned = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
  const trapped = Object.fromEntries(
    names.map((name) => [
      name,
      (...args: unknown[]) => {
        spawned.push(name);
        return (real[name] as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  );
  return { ...real, ...trapped, default: { ...real, ...trapped } };
});

const before = activeLocale();
afterEach(() => setActiveLocale(before));

const said = (finding: DoctorFinding) => doctorItemText({ title: { key: "x" }, fact: finding.fact, ...(finding.fix ? { fix: finding.fix } : {}) });
const EXE = "C:\\Users\\u\\.local\\share\\ego\\active_version_dir\\ego-browser.exe";

describe("ego 浏览器那一项", () => {
  it("没装：注意，告诉用户去哪装、走完首次引导，不用重启", () => {
    const finding = judgeEgoBrowser({ found: undefined, running: undefined });
    expect(finding.level).toBe("warn");
    const text = said(finding);
    expect(text.fact).toBe("没找到 ego-browser 命令（这台电脑没装 ego lite，或者还没走完首次引导）：agent 用不了 ego 浏览器，联网时跳过它");
    expect(text.fix).toBe("去 https://lite.ego.app/ 装 ego lite，打开它走完首次引导；二狗之后拉起 agent 时会重新找，不用重启");
  });

  it("装了：报路径和版本；开着正常，没开着也正常（写一句 agent 要用时二狗会打开，没有修法），看不了开没开照样正常；看不出版本的只报找到了", () => {
    expect(judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: true })).toEqual({
      level: "ok",
      fact: { key: "doctor.egoBrowser.running", params: { path: EXE, version: "0.6.3.14" } },
    });
    expect(said(judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: true })).fact).toBe(`找到了 ${EXE}（版本 0.6.3.14），ego lite 开着`);
    const closed = judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: false });
    expect(closed).toEqual({ level: "ok", fact: { key: "doctor.egoBrowser.notRunning", params: { path: EXE, version: "0.6.3.14" } } });
    expect(said(closed)).toEqual({ title: "x", fact: `找到了 ${EXE}（版本 0.6.3.14）。ego lite 没开着，agent 要用时二狗会替你打开` });
    expect(judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: undefined })).toEqual({ level: "ok", fact: { key: "doctor.egoBrowser.found", params: { path: EXE, version: "0.6.3.14" } } });
    // 看不出版本：另一组句子，不写"版本读不出来"
    expect(judgeEgoBrowser({ found: { path: EXE }, running: undefined })).toEqual({ level: "ok", fact: { key: "doctor.egoBrowser.foundNoVersion", params: { path: EXE } } });
    expect(said(judgeEgoBrowser({ found: { path: EXE }, running: true })).fact).toBe(`找到了 ${EXE}，ego lite 开着`);
    expect(said(judgeEgoBrowser({ found: { path: EXE }, running: false })).fact).toBe(`找到了 ${EXE}。ego lite 没开着，agent 要用时二狗会替你打开`);
    expect(said(judgeEgoBrowser({ found: { path: EXE }, running: undefined })).fact).toBe(`找到了 ${EXE}`);
  });

  it("英文", () => {
    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    expect(said(judgeEgoBrowser({ found: undefined, running: undefined }))).toMatchObject({
      fact: "The ego-browser command wasn't found (ego lite isn't installed on this computer, or its first-run setup isn't finished): agents can't use the ego browser, and web access skips it",
      fix: "Install ego lite from https://lite.ego.app/, open it and finish the first-run setup; ergo looks again whenever it starts an agent, no restart needed",
    });
    expect(said(judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: false })).fact).toBe(`Found ${EXE} (version 0.6.3.14). ego lite isn't open; ergo opens it when an agent needs it`);
    expect(said(judgeEgoBrowser({ found: { path: EXE }, running: false })).fact).toBe(`Found ${EXE}. ego lite isn't open; ergo opens it when an agent needs it`);
  });

  it("检查项：和拉起 agent 同一份探测（现找）；没装不看版本、不看进程；装了看版本、看开没开；登记进「二狗本身」，cost 是 passive", async () => {
    let found: { path: string; dir: string; source: "default" } | undefined;
    const calls: string[] = [];
    const check = egoBrowserCheck({
      find: () => found,
      version: (f) => {
        calls.push(`version ${f.path}`);
        return "0.6.3.14";
      },
      running: () => {
        calls.push("running");
        return true;
      },
    });
    expect(check).toMatchObject({ id: "ego-browser", title: "doctor.check.egoBrowser.title", cost: "passive" });
    expect((await check.run(new AbortController().signal)).level).toBe("warn");
    expect(calls).toEqual([]);
    found = { path: EXE, dir: EXE.slice(0, EXE.lastIndexOf("\\")), source: "default" };
    expect(await check.run(new AbortController().signal)).toEqual({ level: "ok", fact: { key: "doctor.egoBrowser.running", params: { path: EXE, version: "0.6.3.14" } } });
    expect(calls).toEqual([`version ${EXE}`, "running"]);

    const registry = createDoctorChecks();
    registerCoreDoctorChecks(registry, {
      assistantName: () => "小二",
      secretary: () => ({ ok: true, status: "idle" }),
      turns: () => [],
      contextAgents: () => [],
      supervisor: { read: async () => ({ snapshot: undefined }) } as never,
      servicesInUse: () => ({}) as never,
      managerUrl: () => undefined,
      plugins: () => [],
      webIndex: "x",
      now: () => 0,
      egoBrowser: { find: () => undefined, version: () => undefined, running: () => undefined },
    });
    expect(registry.list().map((c) => c.id)).toContain("ego-browser");
  });

  it("真的那一份（守护进程用的 realEgoBrowserSources）：假的安装目录 + 链接，版本从链接指向的目录名看出来；整个体检一个子进程都不起", async () => {
    // 假的 ego lite：…\ego lite\Application\0.6.3.14\ego-browser.exe，active_version_dir 是指向它的链接（Windows 上是目录联接）
    const root = makeTempDir("ergo-doctor-ego-");
    const versionDir = path.join(root, "Citro Labs", "ego lite", "Application", "0.6.3.14");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, "ego-browser.exe"), "不是真的程序，起了也跑不起来");
    const link = path.join(root, ".local", "share", "ego", "active_version_dir");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(versionDir, link, process.platform === "win32" ? "junction" : "dir");
    const exe = path.join(link, "ego-browser.exe");
    const found = { path: exe, dir: link, source: "default" as const };

    spawned.length = 0;
    const check = egoBrowserCheck(realEgoBrowserSources({ find: () => found, programDirs: () => [versionDir] }));
    const finding = await check.run(new AbortController().signal);
    expect(finding.level).toBe("ok");
    expect(finding.fact.params).toEqual({ path: exe, version: "0.6.3.14" });
    // 链接指向的目录名不像版本：只报找到了
    const plain = path.join(root, "ego-elsewhere");
    fs.mkdirSync(plain);
    const elsewhere = { path: path.join(plain, "ego-browser.exe"), dir: plain, source: "config" as const };
    expect((await egoBrowserCheck(realEgoBrowserSources({ find: () => elsewhere, programDirs: () => [plain] })).run(new AbortController().signal)).fact.params).toEqual({
      path: elsewhere.path,
    });
    expect(spawned).toEqual([]);

    // 记账确实记得到（起一次看看）：说明上面的"一个都没起"不是没记上
    const { spawnSync } = await import("node:child_process");
    spawnSync(process.execPath, ["-v"], { windowsHide: true });
    expect(spawned).toEqual(["spawnSync"]);
  });
});
