// 可以配置多份二狗（468）：认哪一份、ergo init / list / unregister、start 按这一份登记、换版本重起各份、卸载拿掉各份。
// 服务管家一律指到临时数据目录（manager.yaml 指着没人听的端口或者本机一个假的回话端口），默认那份的 ~/.ergo 是临时目录下的 home\.ergo；
// 要跑 lsm 的大多用假的 lsm.mjs（记下每条命令，状态存在一个 JSON 里），只有一处用仓库里真的 lsm（本地直连模式改临时目录里的开机自启名单）。
// 开机自启的计划任务用假的（ERGO_AUTOSTART_TASK_FILE）。不碰真的服务管家、~/.ergo 和 8810 这些端口。
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { activeLocaleFrom, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { takeDirFlag } from "../../src/cli/args.ts";
import { type CliContext, createContext } from "../../src/cli/context.ts";
import { DEFAULT_SERVICE_ID, INSTANCE_MARKER, InstanceMarkerError, literalEnv, pickPorts, registeredInstances, resolveInstance, writeMarker } from "../../src/cli/instances.ts";
import { runCli } from "../../src/cli/run.ts";
import { daemonEntryYaml, defaultManagerYaml } from "../../src/cli/service.ts";
import { cmdUninstall } from "../../src/cli/uninstall.ts";
import { builtinCatalogs } from "../../src/i18n/builtin.ts";
import { detectLayout, installPaths, switchCurrent, writeInstallState, writeVersionInfo } from "../../src/release/layout.ts";

const REPO_CLI = path.resolve(import.meta.dirname, "..", "..", "src", "cli", "main.ts");

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ergo-inst-")));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "zh-CN"));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 假服务管家回话的端口（ergo 问 /api/auth/status，它回 200） */
async function liveManagerPort(): Promise<number> {
  const server = http.createServer((_req, res) => res.end("{}"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

/** 假的 lsm：记下每条命令；start / stop / restart 改状态（存在 ERGO_FAKE_STATES 那个 JSON 里），status --json 照它回 */
const FAKE_LSM = `import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ERGO_FAKE_LSM_LOG, args.join(" ") + "\\n");
const file = process.env.ERGO_FAKE_STATES;
const states = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(states));
if (args[0] === "stop") { states[args[1]] = "STOPPED"; save(); }
if (args[0] === "start" || args[0] === "restart") { states[args[1]] = "RUNNING"; save(); }
if (args[0] === "status") console.log(JSON.stringify({ services: Object.entries(states).map(([id, state]) => ({ id, state, pid: 1, autostart: id === "ergo-daemon" })) }));
`;

interface Harness {
  base: string;
  home: string;
  svc: string;
  root: string;
  env: NodeJS.ProcessEnv;
  out: string[];
  err: string[];
  answers: string[];
  /** 在 cwd 里跑一条命令（cwd 没给是 base） */
  run(argv: string[], cwd?: string): Promise<number>;
  ctx(cwd?: string): CliContext;
  lsmCalls(): string[];
  states(): Record<string, string>;
  setStates(states: Record<string, string>): void;
}

/**
 * 一套隔离的环境：用户主目录 base\home（默认那份在 home\.ergo）、服务管家 base\svc。
 * installed：装好的布局（versions 里放假 lsm）；不然是仓库里跑的开发布局（lsm 是真的）。managerUp：服务管家"在跑"
 */
async function harness(options: { installed?: boolean; versions?: string[]; current?: string; managerUp?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Harness> {
  const base = tmp();
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  const svc = path.join(base, "svc");
  fs.mkdirSync(path.join(svc, "registry"), { recursive: true });
  const port = options.managerUp ? await liveManagerPort() : await deadPort();
  fs.writeFileSync(path.join(svc, "registry", "manager.yaml"), defaultManagerYaml(port));
  const root = path.join(base, "inst");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["ERGO_DATA_DIR", "ERGO_SERVICE_ID", "LSM_SERVICE_ID", "LSM_URL", "LSM_TOKEN", "ERGO_HOME"]) delete env[name];
  Object.assign(env, {
    LSM_DATA_DIR: svc,
    ERGO_SVC_PORT: String(port),
    ERGO_AUTOSTART_TASK_FILE: path.join(base, "fake-task.json"),
    ERGO_USER_ENV_FILE: path.join(base, "user-env.json"),
    ERGO_FAKE_LSM_LOG: path.join(base, "fake-lsm.log"),
    ERGO_FAKE_STATES: path.join(base, "fake-states.json"),
    ERGO_LANGUAGE: "en",
    ...options.env,
  });
  let layout = detectLayout({ cliFile: REPO_CLI, env: {}, execPath: process.execPath });
  if (options.installed) {
    const versions = options.versions ?? ["0.2.0"];
    for (const v of versions) {
      const dir = path.join(installPaths(root).versions, v);
      const lsm = path.join(dir, "app", "packages", "supervisor", "bin", "lsm.mjs");
      fs.mkdirSync(path.dirname(lsm), { recursive: true });
      fs.writeFileSync(lsm, FAKE_LSM);
      writeVersionInfo(dir, { format: 1, version: v, kind: "release" });
    }
    const current = options.current ?? versions[0]!;
    switchCurrent(root, current);
    const homeDir = path.join(installPaths(root).versions, current);
    env.ERGO_HOME = homeDir;
    layout = detectLayout({ cliFile: path.join(homeDir, "app", "packages", "daemon", "src", "cli", "main.js"), env, execPath: process.execPath });
  }
  const out: string[] = [];
  const err: string[] = [];
  const answers: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), ask: async () => answers.shift() ?? "" };
  const ctx = (cwd = base) => createContext(layout, env, io, home, { cwd });
  setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
  const statesFile = env.ERGO_FAKE_STATES!;
  return {
    base,
    home,
    svc,
    root,
    env,
    out,
    err,
    answers,
    ctx,
    run: (argv, cwd) => runCli(argv, ctx(cwd)),
    lsmCalls: () => (fs.existsSync(env.ERGO_FAKE_LSM_LOG!) ? fs.readFileSync(env.ERGO_FAKE_LSM_LOG!, "utf8").split(/\r?\n/).filter(Boolean) : []),
    states: () => (fs.existsSync(statesFile) ? (JSON.parse(fs.readFileSync(statesFile, "utf8")) as Record<string, string>) : {}),
    setStates: (states) => fs.writeFileSync(statesFile, JSON.stringify(states)),
  };
}

const entryOf = (svc: string, id: string) => YAML.parse(fs.readFileSync(path.join(svc, "registry", "services", `${id}.yaml`), "utf8")) as Record<string, any>;
const envOf = (entry: Record<string, any>) => Object.fromEntries((entry.env as Array<{ name: string; value?: string }>).map((e) => [e.name, e.value ?? "(file)"]));

/** 在 base 下建一个空文件夹 */
function emptyDir(h: Harness, name: string): string {
  const dir = path.join(h.base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("认哪一份：--dir > ERGO_DATA_DIR > 当前目录或上级的标记文件 > ~/.ergo", () => {
  it("什么都没有是默认那份（~/.ergo，ergo-daemon）；子文件夹里认得出上级的标记；ERGO_DATA_DIR 压过标记，--dir 压过 ERGO_DATA_DIR", () => {
    const home = tmp();
    const b = path.join(home, "work", "b");
    fs.mkdirSync(path.join(b, "projects", "deep"), { recursive: true });
    writeMarker(b, "b");
    const c = path.join(home, "c");
    fs.mkdirSync(c);
    writeMarker(c, "c");

    expect(resolveInstance({ env: {}, cwd: home, homeDir: home })).toEqual({ dataDir: path.join(home, ".ergo"), serviceId: DEFAULT_SERVICE_ID, source: "default" });
    expect(resolveInstance({ env: {}, cwd: path.join(b, "projects", "deep"), homeDir: home })).toEqual({ dataDir: b, serviceId: "ergo-b", name: "b", source: "marker" });
    expect(resolveInstance({ env: { ERGO_DATA_DIR: c }, cwd: b, homeDir: home })).toMatchObject({ dataDir: c, serviceId: "ergo-c", source: "env" });
    // ERGO_DATA_DIR 指着一个没有标记的文件夹：还是默认那份（老用户换过数据目录的照旧是 ergo-daemon）
    expect(resolveInstance({ env: { ERGO_DATA_DIR: path.join(home, "custom") }, cwd: b, homeDir: home })).toMatchObject({ serviceId: DEFAULT_SERVICE_ID, source: "env" });
    expect(resolveInstance({ dir: "work/b", env: { ERGO_DATA_DIR: c }, cwd: home, homeDir: home })).toMatchObject({ dataDir: b, serviceId: "ergo-b", source: "dir" });
  });

  it("--dir 放在命令前后都认（-- 之后的不算）", () => {
    expect(takeDirFlag(["--dir", "x", "status"])).toEqual({ dir: "x", argv: ["status"] });
    expect(takeDirFlag(["status", "--json", "--dir=y"])).toEqual({ dir: "y", argv: ["status", "--json"] });
    expect(takeDirFlag(["svc", "status", "--", "--dir", "z"])).toEqual({ argv: ["svc", "status", "--", "--dir", "z"] });
  });

  it("status --json 管的是 --dir 那一份；--dir 后面没写文件夹是用法不对", async () => {
    const h = await harness();
    const b = emptyDir(h, "b");
    writeMarker(b, "b");
    for (const argv of [["--dir", b, "status", "--json"], ["status", "--json", `--dir=${b}`]]) {
      h.out.length = 0;
      expect(await h.run(argv)).toBe(0);
      expect(JSON.parse(h.out.join("\n"))).toMatchObject({ dataDir: b, instance: { serviceId: "ergo-b", name: "b" } });
    }
    h.out.length = 0;
    expect(await h.run(["status", "--json"], path.join(b))).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({ dataDir: b, instance: { serviceId: "ergo-b" } });
    expect(await h.run(["status", "--dir"])).toBe(2);
    // --dir 写错了（没有标记、也不是默认那份的数据目录）：不落到默认那份头上；默认那份的数据目录照认
    h.err.length = 0;
    expect(await h.run(["--dir", path.join(h.base, "typo"), "stop"])).toBe(1);
    expect(h.err.join("\n")).toContain("isn't an ergo instance");
    expect(h.lsmCalls()).toEqual([]);
    h.out.length = 0;
    expect(await h.run(["--dir", path.join(h.home, ".ergo"), "status", "--json"])).toBe(0);
    expect(JSON.parse(h.out.join("\n"))).toMatchObject({ instance: { serviceId: "ergo-daemon" } });
  });

  it("标记文件坏了：命令不做（免得管错一份），help 照常", async () => {
    const h = await harness();
    const b = emptyDir(h, "b");
    fs.writeFileSync(path.join(b, INSTANCE_MARKER), "{not json");
    expect(() => resolveInstance({ env: {}, cwd: b, homeDir: h.home })).toThrow(InstanceMarkerError);
    expect(await h.run(["stop"], b)).toBe(1);
    expect(h.err.join("\n")).toContain("instance marker file isn't right");
    expect(h.lsmCalls()).toEqual([]);
    expect(await h.run(["help"], b)).toBe(0);
  });
});

describe("ergo init", () => {
  it("空文件夹：挑端口、写配置和标记、建骨架、登记（带 ERGO_SERVICE_ID）、加进开机自启；不启动", async () => {
    const h = await harness({ installed: true });
    const dir = emptyDir(h, "ergo-b");
    expect(await h.run(["init"], dir)).toBe(0);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, INSTANCE_MARKER), "utf8"));
    expect(marker).toEqual({ format: 1, name: "ergo-b", serviceId: "ergo-ergo-b" });
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config", "ergo.json"), "utf8"));
    expect(config.ports.local % 10).toBe(0);
    expect(config.ports.local).toBeGreaterThanOrEqual(8820);
    expect(config.ports.external).toBe(config.ports.local + 1);
    // 骨架和守护进程第一次起来时建的一样（新装的两项安全设置也写明了）
    for (const sub of ["config", "db", "sessions", path.join("tmp", "scratch"), "logs"]) expect(fs.existsSync(path.join(dir, sub))).toBe(true);
    expect(config.guard).toBeDefined();
    const entry = entryOf(h.svc, "ergo-ergo-b");
    expect(entry.id).toBe("ergo-ergo-b");
    expect(entry.probe.port).toBe(config.ports.local);
    expect(entry.profiles).toEqual(["ergo"]);
    expect(envOf(entry)).toMatchObject({ ERGO_SERVICE_ID: "ergo-ergo-b", ERGO_DATA_DIR: dir, LSM_DATA_DIR: h.svc });
    expect(h.lsmCalls()).toEqual(["autostart ergo-ergo-b on"]);
    expect(h.out.join("\n")).toContain("ergo onboard");
    expect(h.out.join("\n")).toContain(`http://127.0.0.1:${config.ports.local}/`);
    // 默认那份不受影响：没登记、没建
    expect(fs.existsSync(path.join(h.svc, "registry", "services", "ergo-daemon.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(h.home, ".ergo"))).toBe(false);
    expect(registeredInstances(h.svc).map((i) => i.id)).toEqual(["ergo-ergo-b"]);
  });

  it("文件夹不空、已经是一份、在别的一份里面：拒绝，什么都不写", async () => {
    const h = await harness({ installed: true });
    const full = emptyDir(h, "full");
    fs.writeFileSync(path.join(full, "mine.txt"), "x");
    expect(await h.run(["init"], full)).toBe(1);
    expect(h.err.join("\n")).toContain("isn't empty");
    expect(fs.readdirSync(full)).toEqual(["mine.txt"]);

    const b = emptyDir(h, "b");
    expect(await h.run(["init"], b)).toBe(0);
    expect(await h.run(["init"], b)).toBe(1);
    const inner = path.join(b, "projects", "inner");
    fs.mkdirSync(inner, { recursive: true });
    h.err.length = 0;
    expect(await h.run(["init"], inner)).toBe(1);
    expect(h.err.join("\n")).toContain("inside another ergo instance's folder");
    expect(fs.readdirSync(inner)).toEqual([]);
  });

  it("名字：大写换小写；中文文件夹名没终端要 --name、有终端问一句；和已有的登记重名、daemon 拒绝", async () => {
    const h = await harness({ installed: true });
    const upper = emptyDir(h, "Work-B");
    expect(await h.run(["init"], upper)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(upper, INSTANCE_MARKER), "utf8")).name).toBe("work-b");

    const chinese = emptyDir(h, "二狗乙");
    h.err.length = 0;
    expect(await h.run(["init"], chinese)).toBe(2);
    expect(h.err.join("\n")).toContain("--name");
    expect(fs.readdirSync(chinese)).toEqual([]);
    h.answers.push("yi");
    expect(await h.run(["init"], chinese)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(chinese, INSTANCE_MARKER), "utf8")).serviceId).toBe("ergo-yi");

    const again = emptyDir(h, "again");
    h.err.length = 0;
    expect(await h.run(["init", "--name", "yi"], again)).toBe(1);
    expect(h.err.join("\n")).toContain("already has an entry called ergo-yi");
    for (const bad of ["daemon", "a--b", "-a", "A"]) expect(await h.run(["init", "--name", bad], again)).toBe(2);
    expect(fs.readdirSync(again)).toEqual([]);
  });

  it("挑端口跳过服务管家登记里已占的、各份配置里的、此刻有人在用的；--port 指定本机端口时外网 +1，被占了拒绝", async () => {
    expect(await pickPorts(new Set([8820, 8831]), async (port) => port === 8840)).toEqual({ local: 8850, external: 8851 });
    expect(await pickPorts(new Set(), async () => true)).toBeUndefined();

    const h = await harness({ installed: true });
    const a = emptyDir(h, "a");
    expect(await h.run(["init", "--port", "18850"], a)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(a, "config", "ergo.json"), "utf8")).ports).toEqual({ local: 18850, external: 18851 });
    const b = emptyDir(h, "b");
    h.err.length = 0;
    expect(await h.run(["init", "--port", "18851"], b)).toBe(1);
    expect(h.err.join("\n")).toContain("18851");
    // 自动挑的跳过 a 已经登记的（这里 a 不在自动挑的范围里，再登记一个占着 8820 的服务看它跳过）
    fs.writeFileSync(path.join(h.svc, "registry", "services", "other.yaml"), "id: other\nprobe:\n  port: 8820\n");
    expect(await h.run(["init"], b)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(b, "config", "ergo.json"), "utf8")).ports.local).not.toBe(8820);
  });

  it("真的 lsm（本地直连，临时目录）：开机自启名单只加这一份，名单里原有的不动；登记 lsm validate 认", async () => {
    const h = await harness();
    const bootFile = path.join(h.svc, "registry", "autostart.yaml");
    const boot = () => (YAML.parse(fs.readFileSync(bootFile, "utf8")) as { services: string[] }).services.toSorted();
    const a = emptyDir(h, "a");
    expect(await h.run(["init", "--port", "18850"], a)).toBe(0);
    // 名单原来没有：只有这一份（不写默认那份的 ergo-daemon：它没登记，服务管家会报名单里的不存在）
    expect(boot()).toEqual(["ergo-a"]);
    const b = emptyDir(h, "b");
    expect(await h.run(["init", "--port", "18860"], b)).toBe(0);
    expect(boot()).toEqual(["ergo-a", "ergo-b"]);
    const { spawnSync } = await import("node:child_process");
    const v = spawnSync(process.execPath, [path.join(h.ctx().layout.appDir, "packages", "supervisor", "bin", "lsm.mjs"), "validate"], { env: h.env, encoding: "utf8", windowsHide: true });
    expect(v.stdout + v.stderr).toMatch(/2 个服务，全部通过校验/);
  }, 60_000);
});

describe("start、list、unregister", () => {
  it("在这一份的文件夹里 start：按它的 id 登记、起它；在别处 start 照旧是默认那份（ergo-daemon，登记里不写 ERGO_SERVICE_ID）", async () => {
    const h = await harness({ installed: true, managerUp: true });
    const b = emptyDir(h, "b");
    expect(await h.run(["init", "--port", "18870"], b)).toBe(0);
    expect(await h.run(["start"], path.join(b, "projects"))).toBe(0);
    expect(h.lsmCalls()).toContain("start ergo-b");
    expect(h.out.join("\n")).toContain("http://127.0.0.1:18870/");

    // 名单是先建的那一份留下的（只有它）：默认那份第一次登记时照旧不碰名单，说一声怎么加
    const bootFile = path.join(h.svc, "registry", "autostart.yaml");
    fs.writeFileSync(bootFile, "services:\n  - ergo-b\n");
    expect(await h.run(["start"])).toBe(0);
    expect(h.lsmCalls()).toContain("start ergo-daemon");
    expect(fs.readFileSync(bootFile, "utf8")).toBe("services:\n  - ergo-b\n");
    expect(h.out.join("\n")).toContain("ergo svc autostart ergo-daemon on");
    const def = entryOf(h.svc, "ergo-daemon");
    expect(envOf(def)).not.toHaveProperty("ERGO_SERVICE_ID");
    expect(envOf(def).ERGO_DATA_DIR).toBe(path.join(h.home, ".ergo"));
    // 默认那份的登记和没有多份时写的一字不差
    expect(fs.readFileSync(path.join(h.svc, "registry", "services", "ergo-daemon.yaml"), "utf8")).toBe(daemonEntryYaml(h.ctx()));
  });

  it("list：默认那份 + 登记的各份，在不在跑、开不开机自启；--json", async () => {
    const h = await harness({ installed: true, managerUp: true });
    const b = emptyDir(h, "b");
    expect(await h.run(["init", "--port", "18880"], b)).toBe(0);
    expect(await h.run(["start"])).toBe(0);
    h.setStates({ "ergo-daemon": "RUNNING", "ergo-b": "STOPPED" });
    h.out.length = 0;
    expect(await h.run(["list", "--json"], b)).toBe(0);
    const rows = JSON.parse(h.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.id, r.running, r.autostart, r.current, r.url])).toEqual([
      ["ergo-daemon", true, true, false, "http://127.0.0.1:8810/"],
      ["ergo-b", false, false, true, "http://127.0.0.1:18880/"],
    ]);
    h.out.length = 0;
    expect(await h.run(["list"], b)).toBe(0);
    expect(h.out.join("\n")).toMatch(/\* b \(ergo-b\)\s+not running/);
  });

  it("unregister：停掉、移出开机自启、拿掉登记，文件夹和数据留着；再 start 重新登记；默认那份不许", async () => {
    const h = await harness({ installed: true, managerUp: true });
    const b = emptyDir(h, "b");
    expect(await h.run(["init", "--port", "18890"], b)).toBe(0);
    fs.writeFileSync(path.join(b, "db", "keep.txt"), "data");
    expect(await h.run(["unregister"], b)).toBe(0);
    expect(h.lsmCalls()).toEqual(["reload", "autostart ergo-b on", "stop ergo-b", "autostart ergo-b off", "reload"]);
    expect(fs.existsSync(path.join(h.svc, "registry", "services", "ergo-b.yaml"))).toBe(false);
    expect(fs.readFileSync(path.join(b, "db", "keep.txt"), "utf8")).toBe("data");
    expect(fs.existsSync(path.join(b, INSTANCE_MARKER))).toBe(true);
    expect(h.out.join("\n")).toContain("Delete the folder yourself");

    expect(await h.run(["start"], b)).toBe(0);
    expect(fs.existsSync(path.join(h.svc, "registry", "services", "ergo-b.yaml"))).toBe(true);
    expect(h.lsmCalls().filter((c) => c === "autostart ergo-b on")).toHaveLength(2);

    h.err.length = 0;
    expect(await h.run(["unregister"])).toBe(1);
    expect(h.err.join("\n")).toContain("ergo uninstall");
  });
});

describe("换版本、卸载：管到各份", () => {
  it("rollback：在跑的每一份都等空闲再停、切完都重起；登记都按新版本重写（不在跑的也重写）", async () => {
    const h = await harness({ installed: true, managerUp: true, versions: ["0.2.0", "0.3.0"], current: "0.3.0" });
    writeInstallState(h.root, { format: 1, previous: "0.2.0" });
    const b = emptyDir(h, "b");
    const c = emptyDir(h, "c");
    expect(await h.run(["init", "--port", "18900"], b)).toBe(0);
    expect(await h.run(["init", "--port", "18910"], c)).toBe(0);
    expect(await h.run(["start"])).toBe(0);
    h.setStates({ "ergo-daemon": "RUNNING", "ergo-b": "RUNNING", "ergo-c": "STOPPED" });
    const before = h.lsmCalls().length;
    expect(await h.run(["rollback", "--idle-timeout", "20"])).toBe(0);
    const calls = h.lsmCalls().slice(before).filter((line) => !line.startsWith("status"));
    expect(calls).toEqual(expect.arrayContaining(["stop ergo-daemon --when-idle", "stop ergo-b --when-idle", "start ergo-daemon", "start ergo-b"]));
    expect(calls.join("\n")).not.toContain("ergo-c --when-idle");
    expect(calls).not.toContain("start ergo-c");
    for (const id of ["ergo-daemon", "ergo-b", "ergo-c"]) expect(entryOf(h.svc, id).root).toBe(path.join(installPaths(h.root).versions, "0.2.0", "app"));
    expect(h.out.join("\n")).toContain("ergo-b is running again on the new version too");
  }, 60_000);

  it("uninstall --yes：别的各份逐份列出来、都停掉、登记都拿掉，文件夹默认留着", async () => {
    const h = await harness({ installed: true, managerUp: true });
    const b = emptyDir(h, "b");
    expect(await h.run(["init", "--port", "18920"], b)).toBe(0);
    expect(await h.run(["start"])).toBe(0);
    h.setStates({ "ergo-daemon": "RUNNING", "ergo-b": "RUNNING" });
    expect(await cmdUninstall(h.ctx(b), { yes: true, waitForCleanup: true })).toBe(0);
    expect(h.out.join("\n")).toContain("There's 1 more ergo instance");
    expect(h.lsmCalls()).toEqual(expect.arrayContaining(["stop ergo-b", "stop ergo-daemon"]));
    expect(registeredInstances(h.svc)).toEqual([]);
    expect(fs.existsSync(path.join(b, INSTANCE_MARKER))).toBe(true);
    expect(h.out.join("\n")).toContain(`b's folder is kept: ${b}`);
  }, 60_000);
});

describe("登记文件读得出来的样子", () => {
  it("literal 的 env：块写法、一行写完的、单引号双引号、不带引号的", () => {
    const text = [
      "id: ergo-x",
      "env:",
      "  - name: ERGO_DATA_DIR",
      "    from: literal",
      "    value: 'D:\\a b\\it''s'",
      '  - { name: ERGO_SERVICE_ID, from: literal, value: "ergo-x" }',
      "  - name: PLAIN",
      "    from: literal",
      "    value: C:\\x # note",
      "  - name: FROM_FILE",
      "    from: file",
      "    path: 'C:\\k.txt'",
      "autoRestart:",
      "  enabled: true",
    ].join("\n");
    expect(Object.fromEntries(literalEnv(text))).toEqual({ ERGO_DATA_DIR: "D:\\a b\\it's", ERGO_SERVICE_ID: "ergo-x", PLAIN: "C:\\x" });
  });
});
