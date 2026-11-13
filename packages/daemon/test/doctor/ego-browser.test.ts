// 466：体检"二狗本身"里的"ego 浏览器"——找不找得到 ego-browser 命令（报路径和 --version 的版本）、ego lite 开没开；
// 没装、没开着各给一句该怎么办；看不了开没开（不是 Windows）照样报路径、版本。中英文都有。
import { activeLocale, activeLocaleFrom, doctorItemText, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createDoctorChecks, type DoctorFinding } from "../../src/doctor/checks.ts";
import { registerCoreDoctorChecks } from "../../src/doctor/core.ts";
import { egoBrowserCheck, judgeEgoBrowser } from "../../src/doctor/ego-browser.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";

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

  it("装了：报路径和版本；开着正常，没开着注意（打开就行，agent 不会自己去拉起），看不了开没开照样正常；版本读不出来写明", () => {
    expect(judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: true })).toEqual({
      level: "ok",
      fact: { key: "doctor.egoBrowser.running", params: { path: EXE, version: "0.6.3.14" } },
    });
    expect(said(judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: true })).fact).toBe(`找到了 ${EXE}（版本 0.6.3.14），ego lite 开着`);
    const closed = judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: false });
    expect(closed.level).toBe("warn");
    expect(said(closed)).toMatchObject({ fact: `找到了 ${EXE}（版本 0.6.3.14），ego lite 没开着`, fix: "要让 agent 用 ego 浏览器时打开 ego lite 就行；agent 用它之前也会先请你打开，不会自己去拉起" });
    expect(judgeEgoBrowser({ found: { path: EXE }, running: undefined })).toEqual({ level: "ok", fact: { key: "doctor.egoBrowser.found", params: { path: EXE, version: "读不出来" } } });
  });

  it("英文", () => {
    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    expect(said(judgeEgoBrowser({ found: undefined, running: undefined }))).toMatchObject({
      fact: "The ego-browser command wasn't found (ego lite isn't installed on this computer, or its first-run setup isn't finished): agents can't use the ego browser, and web access skips it",
      fix: "Install ego lite from https://lite.ego.app/, open it and finish the first-run setup; ergo looks again whenever it starts an agent, no restart needed",
    });
    expect(said(judgeEgoBrowser({ found: { path: EXE, version: "0.6.3.14" }, running: false })).fact).toBe(`Found ${EXE} (version 0.6.3.14); ego lite isn't open`);
  });

  it("检查项：和拉起 agent 同一份探测（现找）；没装不读版本、不看进程；装了读版本、看开没开；登记进「二狗本身」，cost 是 local", async () => {
    let found: { path: string; dir: string; source: "default" } | undefined;
    const calls: string[] = [];
    const check = egoBrowserCheck({
      find: () => found,
      version: async (file) => {
        calls.push(`version ${file}`);
        return "0.6.3.14";
      },
      running: () => {
        calls.push("running");
        return true;
      },
    });
    expect(check).toMatchObject({ id: "ego-browser", title: "doctor.check.egoBrowser.title", cost: "local" });
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
      egoBrowser: { find: () => undefined, version: async () => undefined, running: () => undefined },
    });
    expect(registry.list().map((c) => c.id)).toContain("ego-browser");
  });
});
