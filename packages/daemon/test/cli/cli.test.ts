// ergo 命令：参数、语言、服务管家的设置和二狗的登记（lsm validate 认）、update / rollback / uninstall / components / status。
// 服务管家一律指到临时数据目录、没人听的端口（不碰本机正在跑的 7420 和二狗 8810/8811）；发布对着本机的假下载服务；PATH 用假的存储。
// 开机自启的计划任务用假的（ERGO_AUTOSTART_TASK_FILE，一个 JSON 文件）：名字是固定的，这台电脑上可能就有一个真的在用。
// 要跑 ergo start 的，服务管家也是假的（fakeManager：本机一个回话的端口 + 版本目录里一个记账的 lsm.mjs），真的 lsm 根本不起。
// 最后一个 describe 核对真的任务前后一个字不差。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { activeLocaleFrom, setActiveLocale } from "@ergo/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { parseArgs } from "../../src/cli/args.ts";
import { type FakeAutostartTask, readFakeTask, TASK_COMMAND_REFUSED, taskInsideRoot, taskRunsScript } from "../../src/cli/autostart.ts";
import { type CliContext, createContext, daemonPort } from "../../src/cli/context.ts";
import { cliLanguage, runCli } from "../../src/cli/run.ts";
import { daemonEntryYaml, defaultBootListYaml, defaultManagerYaml, lsmScript, managerAddress, quoteArg, runLsm, svcPaths, syncAutostart, writeSvcConfig, yamlQuote } from "../../src/cli/service.ts";
import { packageManagerOf } from "../../src/cli/versions.ts";
import { builtinCatalogs } from "../../src/i18n/builtin.ts";
import { currentVersionName, detectLayout, installPaths, readInstallState, switchCurrent, writeVersionInfo } from "../../src/release/layout.ts";
import { fileUserPathStore } from "../../src/release/user-path.ts";
import { startFakeDownloads } from "../helpers/fake-downloads.ts";
import { fakeRelease, releaseKey } from "../helpers/fake-release.ts";
import { realAutostartTaskDefinition } from "../helpers/real-autostart-task.ts";

const LSM = path.resolve(import.meta.dirname, "..", "..", "..", "supervisor", "bin", "lsm.mjs");

// 只为这个文件结束时比一比（最后一个 describe）
let realTaskBefore = "";
beforeAll(() => {
  realTaskBefore = realAutostartTaskDefinition();
}, 60_000);

const closers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ergo-cli-")));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "zh-CN"));
  for (const dir of dirs.splice(0)) {
    try {
      const current = path.join(dir, "inst", "current");
      if (fs.lstatSync(current).isSymbolicLink()) fs.rmdirSync(current);
    } catch {
      // 没有联接
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** 一个没人听的端口 */
async function deadPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface TestCli {
  ctx: CliContext;
  out: string[];
  err: string[];
  base: string;
  root: string;
  /** 假的计划任务（JSON 文件） */
  taskFile: string;
  /** fakeManager 时：假 lsm 收到的每条命令 */
  lsmCalls(): string[];
  run(...argv: string[]): Promise<number>;
}

/** 假的服务管家命令行：记下每条命令；status --json 回二狗的状态（ERGO_FAKE_DAEMON_STATE，默认在跑） */
const FAKE_LSM = `import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ERGO_FAKE_LSM_LOG, args.join(" ") + "\\n");
if (args[0] === "status") console.log(JSON.stringify({ services: [{ id: "ergo-daemon", state: process.env.ERGO_FAKE_DAEMON_STATE || "RUNNING", pid: 1 }] }));
`;

/** 假服务管家回话的端口：ergo 问 /api/auth/status，它回 200 */
async function fakeManagerPort(): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

function setFakeTask(t: TestCli, task: FakeAutostartTask): void {
  fs.writeFileSync(t.taskFile, JSON.stringify(task));
}

/** 假任务里的命令：跑的是这个 lsm.mjs */
function taskActionFor(script: string, dataDir: string): string {
  return `C:\\Windows\\System32\\conhost.exe --headless "C:\\node.exe" "${script}" serve --lifeline --quiet --data-dir "${dataDir}"`;
}

function lsmOf(root: string, version: string): string {
  return path.join(installPaths(root).versions, version, "app", "packages", "supervisor", "bin", "lsm.mjs");
}

/** 一个装好的 ergo（假的版本目录，current 那行文本指着它）+ 临时的数据目录、服务管家数据目录（manager.yaml 指着没人听的端口） */
async function installedCli(options: { versions?: string[]; current?: string; env?: NodeJS.ProcessEnv; answers?: string[]; fakeManager?: boolean; fakeLsm?: boolean } = {}): Promise<TestCli> {
  const base = tmp();
  const root = path.join(base, "inst");
  for (const v of options.versions ?? ["0.2.0"]) {
    const dir = path.join(installPaths(root).versions, v);
    if (options.fakeManager || options.fakeLsm) {
      // 没有 node\node.exe：跑假 lsm 用的就是这个测试进程的 node
      fs.mkdirSync(path.dirname(lsmOf(root, v)), { recursive: true });
      fs.writeFileSync(lsmOf(root, v), FAKE_LSM);
    } else {
      fs.mkdirSync(path.join(dir, "node"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node", "node.exe"), "");
    }
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    writeVersionInfo(dir, { format: 1, version: v, kind: "release" });
  }
  const current = options.current ?? (options.versions ?? ["0.2.0"])[0]!;
  switchCurrent(root, current);
  // 启动器给的是 versions\<版本> 这个目录（它是照 current 那行文本找出来的）
  const home = path.join(installPaths(root).versions, current);
  const svc = path.join(base, "svc");
  const port = options.fakeManager ? await fakeManagerPort() : await deadPort();
  const taskFile = path.join(base, "fake-task.json");
  const lsmLog = path.join(base, "fake-lsm.log");
  fs.mkdirSync(path.join(svc, "registry"), { recursive: true });
  fs.writeFileSync(path.join(svc, "registry", "manager.yaml"), defaultManagerYaml(port));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ERGO_HOME: home,
    ERGO_DATA_DIR: path.join(base, "data"),
    LSM_DATA_DIR: svc,
    ERGO_SVC_PORT: String(port),
    ERGO_USER_ENV_FILE: path.join(base, "user-env.json"),
    ERGO_AUTOSTART_TASK_FILE: taskFile,
    ERGO_FAKE_LSM_LOG: lsmLog,
    ERGO_LANGUAGE: "en",
    ...options.env,
  };
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(options.answers ?? [])];
  const layout = detectLayout({ cliFile: path.join(home, "app", "packages", "daemon", "src", "cli", "main.js"), env, execPath: process.execPath });
  const ctx = createContext(layout, env, { out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => answers.shift() ?? "" }, base);
  setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
  const lsmCalls = () => (fs.existsSync(lsmLog) ? fs.readFileSync(lsmLog, "utf8").split(/\r?\n/).filter(Boolean) : []);
  return { ctx, out, err, base, root, taskFile, lsmCalls, run: (...argv) => runCli(argv, ctx) };
}

describe("参数和语言", () => {
  it("命令、位置参数、--开关、--名字 值、--名字=值、-n 值、-- 之后原样", () => {
    const a = parseArgs(["logs", "-n", "20", "--follow", "--from=http://x", "extra", "--", "--raw"], new Set(["n", "from"]));
    expect(a.command).toBe("logs");
    expect(a.positional).toEqual(["extra", "--raw"]);
    expect([...a.flags]).toEqual([
      ["n", "20"],
      ["follow", true],
      ["from", "http://x"],
    ]);
  });

  it("语言：ERGO_LANGUAGE > 二狗设置的语言 > 系统的（中文系统中文，别的英文）", () => {
    const data = tmp();
    expect(cliLanguage({}, data, "zh-Hans-CN")).toBe("zh-CN");
    expect(cliLanguage({}, data, "en-US")).toBe("en");
    fs.mkdirSync(path.join(data, "config"), { recursive: true });
    fs.writeFileSync(path.join(data, "config", "language.json"), JSON.stringify({ format: 1, language: "en" }));
    expect(cliLanguage({}, data, "zh-CN")).toBe("en");
    expect(cliLanguage({ ERGO_LANGUAGE: "zh-CN" }, data, "en-US")).toBe("zh-CN");
  });

  it("Windows 命令行参数的引号、包管理器装的认得出来", () => {
    expect(quoteArg("plain")).toBe("plain");
    expect(quoteArg("a b")).toBe('"a b"');
    expect(quoteArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArg("")).toBe('""');
    expect(packageManagerOf("C:\\Users\\u\\scoop\\apps\\ergo\\current")).toBe("scoop");
    expect(packageManagerOf("C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Ergo_abc")).toBe("winget");
    expect(packageManagerOf("C:\\Users\\u\\AppData\\Local\\Programs\\ergo\\current")).toBeUndefined();
  });
});

describe("服务管家的设置和二狗的登记", () => {
  it("登记走 current 指着的那个版本目录（每次 start 按 current 重写），端口按二狗的配置，路径单引号（反斜杠不会被当成转义）；lsm validate 认", async () => {
    const t = await installedCli();
    fs.mkdirSync(path.join(t.ctx.dataDir, "config"), { recursive: true });
    fs.writeFileSync(path.join(t.ctx.dataDir, "config", "ergo.json"), JSON.stringify({ ports: { local: 18_777, external: 18_778 } }));
    expect(daemonPort(t.ctx)).toBe(18_777);
    const home = path.join(t.root, "versions", "0.2.0");
    const entry = YAML.parse(daemonEntryYaml(t.ctx)) as Record<string, any>;
    expect(entry.root).toBe(path.join(home, "app"));
    expect(entry.probe).toMatchObject({ tier: "linked", port: 18_777, health: { url: "http://127.0.0.1:18777/healthz" } });
    expect(entry.hooks.start.argv).toEqual([path.join(home, "node", "node.exe"), "packages/daemon/src/main.js"]);
    expect(entry.hooks.stop.cmd).toBe(`"${path.join(home, "node", "node.exe")}" packages/daemon/src/stop.js`);
    expect(entry.env).toEqual([
      { name: "ERGO_DATA_DIR", from: "literal", value: t.ctx.dataDir },
      // 服务管家不把自己的 --data-dir、环境变量传给服务：体检要读它的注册表，得在登记里写明它在哪
      { name: "LSM_DATA_DIR", from: "literal", value: t.ctx.svcDataDir },
      { name: "DEEPSEEK_API_KEY", from: "file", path: path.join(t.ctx.dataDir, "secrets", "deepseek-api-key.txt"), optional: true },
      // 自定义（OpenAI 兼容）服务商的 key：和 DeepSeek 一样从密钥区注入，没有这个文件也能起来
      { name: "CUSTOM_MODEL_API_KEY", from: "file", path: path.join(t.ctx.dataDir, "secrets", "custom-model-api-key.txt"), optional: true },
    ]);
    expect(yamlQuote("C:\\a\\v'x")).toBe("'C:\\a\\v''x'");

    const first = writeSvcConfig(t.ctx);
    expect(first).toEqual({ managerCreated: false, bootListCreated: true, entryChanged: true });
    expect(writeSvcConfig(t.ctx)).toEqual({ managerCreated: false, bootListCreated: false, entryChanged: false });
    const v = spawnSync(process.execPath, [LSM, "validate"], { env: { ...t.ctx.env, LSM_DATA_DIR: t.ctx.svcDataDir }, encoding: "utf8", windowsHide: true });
    expect(v.stdout + v.stderr).toMatch(/1 个服务，全部通过校验/);
  });

  describe("用的人在登记的 env 里多加的项（手册让把 MCP 的 fromEnv 变量加在这里）", () => {
    const OURS = ["ERGO_DATA_DIR", "LSM_DATA_DIR", "DEEPSEEK_API_KEY", "CUSTOM_MODEL_API_KEY"];
    /** 我们写的 env 最后一项之后插进这几行（照用的人在记事本里加的样子） */
    const addToEnv = (text: string, lines: string) => text.replace(/^autoRestart:/m, `${lines}\nautoRestart:`);
    const entryOf = (t: { ctx: Parameters<typeof svcPaths>[0] }) => fs.readFileSync(svcPaths(t.ctx).daemonEntry, "utf8");
    const envOf = (text: string) => (YAML.parse(text) as { env: Array<Record<string, unknown>> }).env;

    it("重写时留下，紧跟在我们的项后面；我们的项和别的地方跟着这次的安装走；再写一次不算变了；lsm validate 认", async () => {
      const t = await installedCli();
      writeSvcConfig(t.ctx);
      const added = [
        "  # 笔记服务的 token",
        "  - name: ERGO_NOTES_API_TOKEN",
        "    from: file",
        "    path: 'C:\\keys\\notes.txt'",
        "    optional: true",
        "  - { name: ERGO_MAPS_KEY, from: userEnv }",
      ].join("\n");
      // 上一个版本写的登记（路径指着旧版本目录）加上用的人多加的两项，像升级前磁盘上的样子
      const old = addToEnv(entryOf(t).replaceAll(path.join("versions", "0.2.0"), path.join("versions", "0.1.0")), added);
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, old);

      expect(writeSvcConfig(t.ctx).entryChanged).toBe(true);
      const text = entryOf(t);
      expect(text).toContain("# 笔记服务的 token");
      const env = envOf(text);
      expect(env.map((e) => e.name)).toEqual([...OURS, "ERGO_NOTES_API_TOKEN", "ERGO_MAPS_KEY"]);
      expect(env[4]).toEqual({ name: "ERGO_NOTES_API_TOKEN", from: "file", path: "C:\\keys\\notes.txt", optional: true });
      expect(env[5]).toEqual({ name: "ERGO_MAPS_KEY", from: "userEnv" });
      const home = path.join(t.root, "versions", "0.2.0");
      expect((YAML.parse(text) as { root: string }).root).toBe(path.join(home, "app"));
      expect(text).not.toContain(path.join("versions", "0.1.0"));

      expect(writeSvcConfig(t.ctx).entryChanged).toBe(false);
      expect(entryOf(t)).toBe(text);
      const v = spawnSync(process.execPath, [LSM, "validate"], { env: { ...t.ctx.env, LSM_DATA_DIR: t.ctx.svcDataDir }, encoding: "utf8", windowsHide: true });
      expect(v.stdout + v.stderr).toMatch(/1 个服务，全部通过校验/);
    });

    it("我们自己的项照旧覆盖：用的人改了也改回来，新版本的值生效，不会多出一份", async () => {
      const t = await installedCli();
      writeSvcConfig(t.ctx);
      const fresh = envOf(entryOf(t));
      const tampered = entryOf(t)
        .replace(/(name: DEEPSEEK_API_KEY\n\s+from: file\n\s+path: )'[^']*'/, "$1'C:\\old\\key.txt'")
        .replace(/(name: ERGO_DATA_DIR\n\s+from: literal\n\s+value: )'[^']*'/, "$1'C:\\old\\data'");
      expect(envOf(tampered)).not.toEqual(fresh);
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, tampered);
      writeSvcConfig(t.ctx);
      expect(envOf(entryOf(t))).toEqual(fresh);
    });

    it("认得各种手写的样子：记事本的 CRLF、列表不缩进、一行写完的 env: [...]、值里带 # 和 env:", async () => {
      const t = await installedCli();
      writeSvcConfig(t.ctx);
      const ours = envOf(entryOf(t));

      // 记事本存的：换行是 CRLF
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, addToEnv(entryOf(t), "  - name: A_TOKEN\n    from: userEnv").replaceAll("\n", "\r\n"));
      writeSvcConfig(t.ctx);
      expect(envOf(entryOf(t)).map((e) => e.name)).toEqual([...OURS, "A_TOKEN"]);
      expect(entryOf(t)).not.toContain("\r");

      // 列表和 env: 对齐（YAML 允许不缩进）
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, "id: ergo-daemon\nenv:\n- name: B_TOKEN\n  from: literal\n  value: 'a # b'\n- name: ERGO_DATA_DIR\n  from: literal\n  value: 'x'\nautoRestart:\n  enabled: true\n");
      writeSvcConfig(t.ctx);
      expect(envOf(entryOf(t)).slice(ours.length)).toEqual([{ name: "B_TOKEN", from: "literal", value: "a # b" }]);

      // 一行写完的
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, "id: ergo-daemon\nenv: [{ name: C_TOKEN, from: userEnv }, { name: 'DEEPSEEK_API_KEY', from: userEnv }, { name: D_TOKEN, from: literal, value: 'x, y' }]\nautoRestart:\n  enabled: true\n");
      writeSvcConfig(t.ctx);
      expect(envOf(entryOf(t)).slice(ours.length)).toEqual([
        { name: "C_TOKEN", from: "userEnv" },
        { name: "D_TOKEN", from: "literal", value: "x, y" },
      ]);

      // 别的地方（比如 hooks 下面）的 env 不算登记的 env
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, "id: ergo-daemon\nhooks:\n  start:\n    env:\n      - name: NOT_THIS\n        from: userEnv\nautoRestart:\n  enabled: true\n");
      writeSvcConfig(t.ctx);
      expect(envOf(entryOf(t))).toEqual(ours);
    });

    it("手加了一项再 ergo restart：服务管家重读登记（加的写法和我们写的一字不差时文件不算变了，也要读到）", async () => {
      const t = await installedCli({ fakeManager: true });
      expect(await t.run("start")).toBe(0);
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, addToEnv(entryOf(t), "  - name: A_TOKEN\n    from: userEnv"));
      const edited = entryOf(t);
      expect(writeSvcConfig(t.ctx).entryChanged).toBe(false);
      expect(entryOf(t)).toBe(edited);
      const before = t.lsmCalls().length;
      expect(await t.run("restart")).toBe(0);
      const calls = t.lsmCalls().slice(before);
      const at = (word: string) => calls.findIndex((call) => call.includes(word));
      expect(at("reload")).toBeGreaterThanOrEqual(0);
      expect(at("reload")).toBeLessThan(at("restart"));
    });

    it("没有 env、文件是坏的、写的不是一项一项的：不出错，也不把坏的带进新登记", async () => {
      const t = await installedCli();
      writeSvcConfig(t.ctx);
      const ours = envOf(entryOf(t));
      for (const broken of ["", "id: [oops", "env: oops\n", "env:\n  - just a string\n  - from: userEnv\n", "env: []\n"]) {
        fs.writeFileSync(svcPaths(t.ctx).daemonEntry, broken);
        writeSvcConfig(t.ctx);
        expect(envOf(entryOf(t))).toEqual(ours);
      }
    });
  });

  describe("用的人在登记里写的公网入口（部署手册让在这里打开 exposure）", () => {
    const entryOf = (t: { ctx: Parameters<typeof svcPaths>[0] }) => fs.readFileSync(svcPaths(t.ctx).daemonEntry, "utf8");
    const parsed = (text: string) => YAML.parse(text) as { exposure?: Record<string, unknown>; env: unknown[]; root: string };
    /** 手册上的那一段：写在 profiles 前面 */
    const addExposure = (text: string, lines: string) => text.replace(/^profiles:/m, `${lines}\nprofiles:`);
    const BLOCK = ["# 公网入口：经隧道", "exposure:", "  via: ergo-tunnel", "  remotePort: 18811", "  # 真去打一下", "  publicUrl: https://ergo.203.0.113.9.sslip.io/", "  check: true"].join("\n");
    const WANTED = { via: "ergo-tunnel", remotePort: 18811, publicUrl: "https://ergo.203.0.113.9.sslip.io/", check: true };

    it("重写时留下，连注释；别的地方跟着这次的安装走；再写一次不算变了；env 里加的也还在；lsm validate 认", async () => {
      const t = await installedCli();
      writeSvcConfig(t.ctx);
      // 登记好隧道（校验要求 via 指向的服务真的在），照 deploy/lsm 的示例换掉占位符
      const tunnel = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "..", "deploy", "lsm", "ergo-tunnel.example.yaml"), "utf8").replaceAll("<仓库路径>", t.root).replace(/<[^>\n]+>/g, "x");
      fs.writeFileSync(path.join(svcPaths(t.ctx).services, "ergo-tunnel.yaml"), tunnel);

      // 上一个版本写的登记（路径指着旧版本目录）加上用的人打开的公网入口和多加的一项 env
      const old = addExposure(entryOf(t).replaceAll(path.join("versions", "0.2.0"), path.join("versions", "0.1.0")), BLOCK).replace(/^autoRestart:/m, "  - name: A_TOKEN\n    from: userEnv\nautoRestart:");
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, old);

      expect(writeSvcConfig(t.ctx).entryChanged).toBe(true);
      const text = entryOf(t);
      expect(parsed(text).exposure).toEqual(WANTED);
      expect(text).toContain("# 公网入口：经隧道");
      expect(text).toContain("# 真去打一下");
      expect(parsed(text).root).toBe(path.join(t.root, "versions", "0.2.0", "app"));
      expect(text).not.toContain(path.join("versions", "0.1.0"));
      expect(parsed(text).env).toContainEqual({ name: "A_TOKEN", from: "userEnv" });

      expect(writeSvcConfig(t.ctx).entryChanged).toBe(false);
      expect(entryOf(t)).toBe(text);
      const v = spawnSync(process.execPath, [LSM, "validate"], { env: { ...t.ctx.env, LSM_DATA_DIR: t.ctx.svcDataDir }, encoding: "utf8", windowsHide: true });
      expect(v.stdout + v.stderr).toMatch(/2 个服务，全部通过校验/);
    });

    it("认得手写的样子：记事本的 CRLF、一行写完的、写在文件最后、后面紧跟不缩进的注释", async () => {
      const t = await installedCli();
      writeSvcConfig(t.ctx);

      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, addExposure(entryOf(t), BLOCK).replaceAll("\n", "\r\n"));
      writeSvcConfig(t.ctx);
      expect(parsed(entryOf(t)).exposure).toEqual(WANTED);
      expect(entryOf(t)).not.toContain("\r");

      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, "id: ergo-daemon\nexposure: { via: ergo-tunnel, publicUrl: 'https://a.example/#x', check: true }\nprofiles: [ergo]\n");
      writeSvcConfig(t.ctx);
      expect(parsed(entryOf(t)).exposure).toEqual({ via: "ergo-tunnel", publicUrl: "https://a.example/#x", check: true });

      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, "id: ergo-daemon\nexposure:\n  never: 只给本机用\n");
      writeSvcConfig(t.ctx);
      expect(parsed(entryOf(t)).exposure).toEqual({ never: "只给本机用" });

      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, "exposure:\n  never: 只给本机用\n\n# 说的是下面的 profiles\nprofiles: [ergo]\n");
      writeSvcConfig(t.ctx);
      expect(entryOf(t)).not.toContain("说的是下面的 profiles");

      // 紧贴在我们写的第一行下面打开的：第一行不算它的注释，不会多出一份
      fs.writeFileSync(svcPaths(t.ctx).daemonEntry, entryOf(t).replace(/^exposure:\n {2}never: .*\n/m, "").replace(/^id: /m, "exposure:\n  never: 只给本机用\nid: "));
      writeSvcConfig(t.ctx);
      expect(parsed(entryOf(t)).exposure).toEqual({ never: "只给本机用" });
      expect(entryOf(t).match(/^# ergo daemon entry/gm)).toHaveLength(1);
    });

    it("没有的、别处的、空的、注释掉的（手册的示例原样）：不写 exposure，不出错", async () => {
      const t = await installedCli();
      writeSvcConfig(t.ctx);
      const clean = entryOf(t);
      expect(parsed(clean).exposure).toBeUndefined();
      for (const other of [
        "",
        "id: [oops",
        "exposure:\nprofiles: [ergo]\n",
        "exposure: null\n",
        "exposure: oops\n",
        "exposure:\n  # via: ergo-tunnel\n",
        "# exposure:\n#   via: ergo-tunnel\n#   check: true\nprofiles: [ergo]\n",
        "hooks:\n  start:\n    exposure:\n      via: not-this\n",
      ]) {
        fs.writeFileSync(svcPaths(t.ctx).daemonEntry, other);
        writeSvcConfig(t.ctx);
        expect({ other, entry: entryOf(t) }).toEqual({ other, entry: clean });
      }
    });
  });

  it("manager.yaml 不在时按 ERGO_SVC_PORT 写一份（只绑本机、不动别的进程），在就不改", async () => {
    const t = await installedCli();
    fs.rmSync(svcPaths(t.ctx).managerYaml);
    expect(managerAddress(t.ctx).port).toBe(Number(t.ctx.env.ERGO_SVC_PORT));
    expect(writeSvcConfig(t.ctx).managerCreated).toBe(true);
    const manager = YAML.parse(fs.readFileSync(svcPaths(t.ctx).managerYaml, "utf8")) as Record<string, any>;
    expect(manager).toMatchObject({ bind: "127.0.0.1", port: Number(t.ctx.env.ERGO_SVC_PORT), autoResolveConflicts: false, sentinels: { port: false, scheduledTask: false }, auth: { enabled: false } });
    fs.appendFileSync(svcPaths(t.ctx).managerYaml, "# mine\n");
    expect(writeSvcConfig(t.ctx).managerCreated).toBe(false);
    expect(fs.readFileSync(svcPaths(t.ctx).managerYaml, "utf8")).toContain("# mine");
  });

  it("开发布局（仓库里直接跑）：登记用仓库和这份 node、.ts 入口", () => {
    const layout = detectLayout({ cliFile: path.resolve(import.meta.dirname, "..", "..", "src", "cli", "main.ts"), env: {}, execPath: process.execPath });
    const ctx = createContext(layout, { ERGO_DATA_DIR: tmp() }, { out: () => {}, err: () => {}, ask: async () => "" });
    const entry = YAML.parse(daemonEntryYaml(ctx)) as Record<string, any>;
    expect(entry.root).toBe(layout.appDir);
    expect(entry.hooks.start.argv).toEqual([process.execPath, "packages/daemon/src/main.ts"]);
  });
});

describe("开机自启名单（registry/autostart.yaml）", () => {
  it("第一次 ergo start 写一份只含二狗的，服务管家自己的代码读得懂；再 start 不动", async () => {
    const t = await installedCli({ fakeManager: true });
    const file = svcPaths(t.ctx).bootList;
    expect(fs.existsSync(file)).toBe(false);
    expect(await t.run("start")).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(defaultBootListYaml());
    expect(YAML.parse(fs.readFileSync(file, "utf8"))).toEqual({ services: ["ergo-daemon"] });
    expect(t.out.join("\n")).toContain(`ergo is on the autostart list ${file}`);
    expect(t.out.join("\n")).toContain("ergo svc autostart ergo-daemon off");

    // 服务管家读名单的就是这一个函数（另起进程读，数据目录指到临时的）
    const read = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import { loadBootList } from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(LSM), "..", "src", "bootlist.mjs")).href)}; const b = loadBootList(${JSON.stringify(file)}); console.log(JSON.stringify({ ids: [...b.ids], error: b.error }));`],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, LSM_DATA_DIR: t.ctx.svcDataDir } },
    );
    expect(JSON.parse(read.stdout)).toEqual({ ids: ["ergo-daemon"], error: null });

    t.out.length = 0;
    expect(await t.run("start")).toBe(0);
    expect(t.out.join("\n")).not.toContain("autostart list");
  });

  it("已经有了就绝不改：用的人关掉二狗（服务管家写成 services: []）后再 ergo start、ergo restart，仍是关的", async () => {
    const t = await installedCli({ fakeManager: true });
    const file = svcPaths(t.ctx).bootList;
    const off = "# written by the service manager\nservices: []\n";
    fs.writeFileSync(file, off);
    expect(await t.run("start")).toBe(0);
    expect(await t.run("restart")).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(off);
    expect(t.out.join("\n")).not.toContain("autostart list");

    // 手改坏了的也不替它"修"
    fs.writeFileSync(file, "services: [oops");
    expect(writeSvcConfig(t.ctx).bootListCreated).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("services: [oops");
  });
});

describe("开机自启的计划任务跟着版本走（假任务）", () => {
  it("ergo svc install-autostart / uninstall-autostart：照当前版本注册（带服务管家的数据目录）、撤掉", async () => {
    const t = await installedCli({ fakeLsm: true });
    expect(await t.run("svc", "install-autostart")).toBe(0);
    const action = readFakeTask(t.taskFile).action!;
    expect(action).toContain(lsmOf(t.root, "0.2.0"));
    expect(action).toContain(`--data-dir "${t.ctx.svcDataDir}"`);
    expect(await t.run("svc", "uninstall-autostart")).toBe(0);
    expect(readFakeTask(t.taskFile).action).toBeUndefined();
    expect(readFakeTask(t.taskFile).calls).toEqual(["install-autostart", "uninstall-autostart"]);
    // 假任务挡在 lsm 前面：假 lsm 一次都没被叫到
    expect(t.lsmCalls()).toEqual([]);
  });

  it("切过版本后 ergo start：任务指着安装目录里的旧版本，就改指当前版本，说一声；再 start 不再动", async () => {
    const t = await installedCli({ fakeManager: true, versions: ["0.2.0", "0.3.0"], current: "0.3.0" });
    setFakeTask(t, { action: taskActionFor(lsmOf(t.root, "0.2.0"), t.ctx.svcDataDir) });
    expect(await t.run("start")).toBe(0);
    expect(readFakeTask(t.taskFile).calls).toEqual(["install-autostart"]);
    expect(readFakeTask(t.taskFile).action).toContain(lsmOf(t.root, "0.3.0"));
    expect(readFakeTask(t.taskFile).action).not.toContain(lsmOf(t.root, "0.2.0"));
    expect(t.out).toContain("The autostart task now points at the version in use (0.3.0).");

    t.out.length = 0;
    expect(await t.run("start")).toBe(0);
    expect(readFakeTask(t.taskFile).calls).toEqual(["install-autostart"]);
    expect(t.out.join("\n")).not.toContain("autostart task");
  });

  it("任务不存在（用的人撤掉了）：ergo start 不新建", async () => {
    const t = await installedCli({ fakeManager: true });
    expect(await t.run("start")).toBe(0);
    expect(fs.existsSync(t.taskFile)).toBe(false);
  });

  it("任务指着安装目录以外（用的人自己装的服务管家，比如这台开发机）：不动它，ergo2 也不算 ergo 里面", async () => {
    const t = await installedCli({ fakeManager: true });
    for (const elsewhere of ["D:\\code\\my_repo\\packages\\supervisor\\bin\\lsm.mjs", path.join(`${t.root}2`, "versions", "0.2.0", "app", "packages", "supervisor", "bin", "lsm.mjs")]) {
      const before = { action: taskActionFor(elsewhere, "D:\\lsm-data") };
      setFakeTask(t, before);
      expect(await t.run("start")).toBe(0);
      expect(readFakeTask(t.taskFile)).toEqual(before);
    }
    expect(t.lsmCalls().join("\n")).not.toContain("autostart");
  });

  it("源码跑的不动任务；npm 装的也一样", () => {
    const layout = detectLayout({ cliFile: path.resolve(import.meta.dirname, "..", "..", "src", "cli", "main.ts"), env: {}, execPath: process.execPath });
    expect(layout.kind).toBe("dev");
    const taskFile = path.join(tmp(), "task.json");
    fs.writeFileSync(taskFile, JSON.stringify({ action: taskActionFor("C:\\old\\lsm.mjs", "x") }));
    const before = fs.readFileSync(taskFile, "utf8");
    const ctx = createContext(layout, { ERGO_DATA_DIR: tmp(), LSM_DATA_DIR: tmp(), ERGO_AUTOSTART_TASK_FILE: taskFile }, { out: () => {}, err: () => {}, ask: async () => "" });
    expect(syncAutostart(ctx)).toBe("not-installed");
    expect(syncAutostart({ ...ctx, layout: { ...layout, kind: "npm" } })).toBe("not-installed");
    expect(fs.readFileSync(taskFile, "utf8")).toBe(before);
  });

  it("重新注册失败：只说一句，二狗照常起来，任务原样", async () => {
    const t = await installedCli({ fakeManager: true, versions: ["0.2.0", "0.3.0"], current: "0.3.0" });
    const old = taskActionFor(lsmOf(t.root, "0.2.0"), t.ctx.svcDataDir);
    setFakeTask(t, { action: old, failInstall: true });
    expect(await t.run("start")).toBe(0);
    expect(t.err.join("\n")).toContain("Could not point the autostart task at the version in use: fake task refused");
    expect(t.err.join("\n")).toContain("ergo svc install-autostart");
    expect(readFakeTask(t.taskFile).action).toBe(old);
    expect(t.out).toContain("ergo is up: http://127.0.0.1:8810/");
  });

  it("认任务的两个判断：大小写、斜杠都不计较；root 后面要跟分隔符", () => {
    const action = taskActionFor("C:\\Users\\Me\\Programs\\ergo\\versions\\0.3.0\\app\\packages\\supervisor\\bin\\lsm.mjs", "x");
    expect(taskInsideRoot(action, "c:/users/me/programs/ERGO")).toBe(true);
    expect(taskInsideRoot(action, "C:\\Users\\Me\\Programs\\erg")).toBe(false);
    expect(taskRunsScript(action, "c:/users/me/programs/ergo/versions/0.3.0/app/packages/supervisor/bin/lsm.mjs")).toBe(true);
    expect(taskRunsScript(action, "c:/users/me/programs/ergo/versions/0.2.0/app/packages/supervisor/bin/lsm.mjs")).toBe(false);
  });
});

describe("碰不到真的计划任务", () => {
  it("测试进程里忘了设假任务：动任务的命令到 runLsm 就拦下，lsm 根本不起（版本目录里的也只是假 lsm，万一拦不住也只会记一笔）", async () => {
    const t = await installedCli({ fakeLsm: true });
    expect(lsmScript(t.ctx)).toBe(lsmOf(t.root, "0.2.0"));
    const { ERGO_AUTOSTART_TASK_FILE: _gone, ...env } = t.ctx.env;
    const ctx: CliContext = { ...t.ctx, env };
    for (const args of [["install-autostart"], ["uninstall-autostart"], ["--data-dir", t.ctx.svcDataDir, "install-autostart"]]) {
      const r = runLsm(ctx, args, { capture: true });
      expect(r.code).toBe(TASK_COMMAND_REFUSED);
      expect(r.stderr).toContain("refused");
    }
    expect(t.lsmCalls()).toEqual([]);
    // 别的命令照常走到 lsm
    expect(runLsm(ctx, ["status", "--json"], { capture: true }).code).toBe(0);
    expect(t.lsmCalls()).toEqual(["status --json"]);
  });
});

describe("ergo onboard", () => {
  it("起好二狗，指路去网页走设置向导；不再说还在做", async () => {
    const t = await installedCli({ fakeManager: true });
    expect(await t.run("onboard")).toBe(0);
    expect(t.out.at(-1)).toBe("Open http://127.0.0.1:8810/ and follow the setup wizard.");
    expect(t.out.join("\n")).not.toMatch(/still being built/);
    expect(t.lsmCalls()).toContain("start ergo-daemon");
  });

  it("二狗没起来：不指路，退出码 1", async () => {
    const t = await installedCli({ fakeManager: true, env: { ERGO_FAKE_DAEMON_STATE: "FAILED" } });
    expect(await t.run("onboard")).toBe(1);
    expect(t.out.join("\n")).not.toContain("setup wizard");
    expect(t.err[0]).toMatch(/^ergo did not start/);
  });
});

describe("status、version", () => {
  it("服务管家没在跑：说清楚；--json 给程序读", async () => {
    const t = await installedCli();
    expect(await t.run("status")).toBe(0);
    expect(t.out).toEqual([
      "Version: 0.2.0 (release package)",
      `Installed at: ${t.root}`,
      `Data: ${t.ctx.dataDir}`,
      "Service manager: not running (ergo start starts it)",
    ]);
    t.out.length = 0;
    expect(await t.run("status", "--json")).toBe(0);
    expect(JSON.parse(t.out.join("\n"))).toMatchObject({ version: "0.2.0", install: { kind: "release", root: t.root }, manager: { up: false }, url: "http://127.0.0.1:8810/" });
    t.out.length = 0;
    expect(await t.run("version")).toBe(0);
    expect(t.out[0]).toMatch(/^ergo 0\.2\.0 \(release package\) · Node v/);
    expect(await t.run("nope")).toBe(2);
    expect(t.err).toEqual(["Unknown command: nope"]);
  });
});

describe("update / rollback", () => {
  it("下新版本（验签名）、解开、切过去；只留两个版本；rollback 切回上一个；已经最新时说一句", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    for (const [name, body] of fakeRelease("0.3.0", key.secret).files) fake.put(name, body);
    const t = await installedCli({ versions: ["0.1.0", "0.2.0"], current: "0.2.0", env: { ERGO_RELEASE_PUBKEY: key.publicLine, ERGO_RELEASE_URL: `${fake.url}/m1` } });

    expect(await t.run("update", "--check")).toBe(0);
    expect(t.out).toEqual(["Version 0.3.0 is available (you have 0.2.0): run ergo update."]);
    t.out.length = 0;
    expect(await t.run("update")).toBe(0);
    expect(t.err).toEqual([]);
    expect(t.out).toContain("Signature OK (ergo 0.3.0 SHA256SUMS).");
    expect(t.out).toContain("Switched: 0.2.0 → 0.3.0");
    expect(t.out).toContain("Removed old versions: 0.1.0");
    expect(currentVersionName(t.root)).toBe("0.3.0");
    expect(fs.readdirSync(installPaths(t.root).versions).sort()).toEqual(["0.2.0", "0.3.0"]);
    expect(readInstallState(t.root).previous).toBe("0.2.0");
    expect(fs.existsSync(path.join(installPaths(t.root).downloads, "0.3.0"))).toBe(false);

    // 现在的命令行还是 0.2.0 那份（测试里没换进程）：再查一次照样说有新的；换成 0.3.0 的上下文后说已经最新
    const now = await installedCli({ versions: ["0.3.0"], env: { ERGO_RELEASE_PUBKEY: key.publicLine, ERGO_RELEASE_URL: `${fake.url}/m1` } });
    expect(await now.run("update")).toBe(0);
    expect(now.out).toEqual(["Already up to date (0.3.0)."]);

    t.out.length = 0;
    expect(await t.run("rollback")).toBe(0);
    expect(t.out).toContain("Switching back to 0.2.0 (0.2.0)…");
    expect(currentVersionName(t.root)).toBe("0.2.0");
    expect(readInstallState(t.root).previous).toBe("0.3.0");
  });

  it("切过去之后登记和开机自启都指新版本（这条命令自己还跑在旧版本上）；rollback 再指回来；任务不存在不新建", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    for (const [name, body] of fakeRelease("0.3.0", key.secret).files) fake.put(name, body);
    const t = await installedCli({ fakeLsm: true, env: { ERGO_RELEASE_PUBKEY: key.publicLine, ERGO_RELEASE_URL: `${fake.url}/m1` } });
    const entryRoot = () => (YAML.parse(fs.readFileSync(svcPaths(t.ctx).daemonEntry, "utf8")) as { root: string }).root;
    setFakeTask(t, { action: taskActionFor(lsmOf(t.root, "0.2.0"), t.ctx.svcDataDir) });

    expect(await t.run("update")).toBe(0);
    expect(currentVersionName(t.root)).toBe("0.3.0");
    expect(entryRoot()).toBe(path.join(t.root, "versions", "0.3.0", "app"));
    expect(readFakeTask(t.taskFile).action).toContain(lsmOf(t.root, "0.3.0"));
    expect(t.out).toContain("The autostart task now points at the version in use (0.3.0).");
    expect(readInstallState(t.root).previous).toBe("0.2.0");

    expect(await t.run("rollback")).toBe(0);
    expect(currentVersionName(t.root)).toBe("0.2.0");
    expect(entryRoot()).toBe(path.join(t.root, "versions", "0.2.0", "app"));
    expect(readFakeTask(t.taskFile).action).toContain(lsmOf(t.root, "0.2.0"));

    // 用的人撤掉了任务：切版本也不把它加回来
    setFakeTask(t, {});
    expect(await t.run("rollback")).toBe(0);
    expect(currentVersionName(t.root)).toBe("0.3.0");
    expect(readFakeTask(t.taskFile).action).toBeUndefined();
    expect(readFakeTask(t.taskFile).calls).toBeUndefined();
  });

  it("签名验不过、没有公钥：不装，在用的版本不变", async () => {
    const fake = await startFakeDownloads();
    for (const [name, body] of fakeRelease("0.3.0", releaseKey().secret).files) fake.put(name, body);
    const t = await installedCli({ env: { ERGO_RELEASE_PUBKEY: releaseKey().publicLine, ERGO_RELEASE_URL: `${fake.url}/m1` } });
    expect(await t.run("update")).toBe(1);
    expect(t.err[0]).toMatch(/^The new version failed verification; not installing: 签名验不过：签名是别的钥匙签的/);
    expect(currentVersionName(t.root)).toBe("0.2.0");
    expect(fs.existsSync(path.join(installPaths(t.root).versions, "0.3.0"))).toBe(false);

    const unsigned = await installedCli({ env: { ERGO_RELEASE_PUBKEY: "", ERGO_RELEASE_URL: `${fake.url}/m1` } });
    expect(await unsigned.run("update")).toBe(1);
    expect(unsigned.err[0]).toMatch(/no release public key/);
  });

  it("没有上一个版本可切；npm 装的、开发布局给一句怎么更新", async () => {
    const t = await installedCli();
    expect(await t.run("rollback")).toBe(1);
    expect(t.err).toEqual(["There is no previous version to switch back to."]);
    const devLayout = detectLayout({ cliFile: path.resolve(import.meta.dirname, "..", "..", "src", "cli", "main.ts"), env: {}, execPath: process.execPath });
    const out: string[] = [];
    const dev = createContext(devLayout, { ...t.ctx.env, ERGO_HOME: "" }, { out: (l) => out.push(l), err: () => {}, ask: async () => "" });
    expect(await runCli(["update"], dev)).toBe(0);
    expect(out).toEqual(["This ergo runs from the repository: git pull, npm ci and npm run build are the update."]);
  });
});

describe("uninstall", () => {
  it("撤 PATH、删安装目录；数据默认留着，--delete-data 才删；问了说不就不卸", async () => {
    const t = await installedCli({ answers: ["n"] });
    const store = fileUserPathStore(t.ctx.env.ERGO_USER_ENV_FILE!);
    store.write(`C:\\Windows;${installPaths(t.root).bin}`);
    fs.mkdirSync(path.join(t.ctx.dataDir, "config"), { recursive: true });
    expect(await t.run("uninstall")).toBe(1);
    expect(t.out.at(-1)).toBe("Not uninstalled.");
    expect(fs.existsSync(t.root)).toBe(true);

    t.out.length = 0;
    const { cmdUninstall } = await import("../../src/cli/uninstall.ts");
    expect(await cmdUninstall(t.ctx, { yes: true, deleteData: false, waitForCleanup: true })).toBe(0);
    expect(store.read()).toBe("C:\\Windows");
    expect(fs.existsSync(t.root)).toBe(false);
    expect(fs.existsSync(t.ctx.dataDir)).toBe(true);
    expect(t.out).toContain(`Data kept: ${t.ctx.dataDir}, ${t.ctx.svcDataDir} (a reinstall picks it up; delete it yourself if you no longer need it).`);

    const t2 = await installedCli();
    fs.mkdirSync(path.join(t2.ctx.dataDir, "config"), { recursive: true });
    expect(await cmdUninstall(t2.ctx, { yes: true, deleteData: true, waitForCleanup: true })).toBe(0);
    expect(fs.existsSync(t2.ctx.dataDir)).toBe(false);
    expect(fs.existsSync(t2.ctx.svcDataDir)).toBe(false);
    expect(fs.existsSync(t2.root)).toBe(false);
  });

  it("开机自启：指着这个安装的一并撤掉；指着别处的不动；没有任务就不提；撤不掉说清楚，其余照卸", async () => {
    const { cmdUninstall } = await import("../../src/cli/uninstall.ts");
    const mine = await installedCli({ fakeLsm: true });
    setFakeTask(mine, { action: taskActionFor(lsmOf(mine.root, "0.2.0"), mine.ctx.svcDataDir) });
    expect(await cmdUninstall(mine.ctx, { yes: true, deleteData: false, waitForCleanup: true })).toBe(0);
    expect(readFakeTask(mine.taskFile).action).toBeUndefined();
    expect(readFakeTask(mine.taskFile).calls).toEqual(["uninstall-autostart"]);
    expect(mine.out).toContain("Removed the service manager's autostart.");
    expect(fs.existsSync(mine.root)).toBe(false);

    const other = await installedCli({ fakeLsm: true });
    const before = { action: taskActionFor("D:\\my_repo\\packages\\supervisor\\bin\\lsm.mjs", "D:\\lsm-data") };
    setFakeTask(other, before);
    expect(await cmdUninstall(other.ctx, { yes: true, deleteData: false, waitForCleanup: true })).toBe(0);
    expect(readFakeTask(other.taskFile)).toEqual(before);
    expect(other.out).toContain("The autostarted service manager belongs to another install; left it alone.");

    const none = await installedCli({ fakeLsm: true });
    expect(await cmdUninstall(none.ctx, { yes: true, deleteData: false, waitForCleanup: true })).toBe(0);
    expect(none.out).not.toContain("Removed the service manager's autostart.");
    expect(none.out).not.toContain("The autostarted service manager belongs to another install; left it alone.");
    expect(fs.existsSync(none.taskFile)).toBe(false);

    const stuck = await installedCli({ fakeLsm: true });
    setFakeTask(stuck, { action: taskActionFor(lsmOf(stuck.root, "0.2.0"), stuck.ctx.svcDataDir), failUninstall: true });
    expect(await cmdUninstall(stuck.ctx, { yes: true, deleteData: false, waitForCleanup: true })).toBe(0);
    expect(stuck.err.join("\n")).toContain("The autostart task was not removed: fake task refused");
    expect(stuck.err.join("\n")).toContain("Unregister-ScheduledTask -TaskName LocalServiceManager");
    expect(fs.existsSync(stuck.root)).toBe(false);
  });

  it("不像安装目录的不删；开发布局不用卸", async () => {
    const t = await installedCli();
    fs.rmSync(installPaths(t.root).versions, { recursive: true, force: true });
    expect(await t.run("uninstall", "--yes")).toBe(1);
    expect(t.err[0]).toMatch(/does not look like an ergo install folder/);
  });
});

describe("components（二狗本机端口上的组件接口的终端前端）", () => {
  it("要确认许可的组件：不加 --accept-license 打出许可、不下载；加了带上确认标记", async () => {
    const component = (state: string, accepted: boolean) => ({
      id: "tts",
      title: "Speech model",
      summary: "",
      version: "1",
      state,
      default: "ask",
      defaultText: "ask",
      wanted: false,
      size: 1,
      enables: [],
      dependsOn: [],
      sources: [],
      location: "x",
      license: { name: "Fish Audio Research License", summary: "Non-commercial only", url: "https://example.test/license", confirm: true, accepted },
    });
    const view = (state: string, accepted: boolean) => ({ components: [component(state, accepted)], features: [], manifest: { release: "0.3.0", signed: true }, defaultsMissing: [] });
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        requests.push(`${req.method} ${body}`);
        res.setHeader("content-type", "application/json");
        if (req.method === "GET") {
          res.end(JSON.stringify(view("missing", false)));
          return;
        }
        if (!body.includes("licenseAccepted")) {
          res.statusCode = 400;
          res.end(JSON.stringify({ code: "not_allowed", message: "confirm first" }));
          return;
        }
        res.end(JSON.stringify(view("installed", true)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const t = await installedCli();
      fs.mkdirSync(path.join(t.ctx.dataDir, "config"), { recursive: true });
      fs.writeFileSync(path.join(t.ctx.dataDir, "config", "ergo.json"), JSON.stringify({ ports: { local: port, external: port + 1 } }));
      expect(await t.run("components", "add", "tts")).toBe(1);
      expect(t.err.at(-1)).toContain("Fish Audio Research License");
      expect(t.err.at(-1)).toContain("https://example.test/license");
      expect(t.err.at(-1)).toContain("--accept-license");
      expect(await t.run("components", "add", "tts", "--accept-license")).toBe(0);
      expect(requests.at(-1)).toBe('POST {"action":"install","licenseAccepted":true}');
    } finally {
      server.close();
    }
  });

  it("列出、装（等它装好）、导入；二狗没在跑说一句先 ergo start", async () => {
    const view = (state: string, done?: number) => ({
      components: [
        {
          id: "bge-m3",
          title: "Embedding model bge-m3",
          summary: "",
          version: "1",
          state,
          default: "install",
          defaultText: "installed by default",
          wanted: true,
          size: 570_000_000,
          enables: [],
          dependsOn: [],
          sources: [],
          location: "x",
          ...(done === undefined ? {} : { progress: { phase: "downloading", done, total: 570_000_000 } }),
        },
      ],
      features: [],
      manifest: { release: "0.3.0", signed: true },
      defaultsMissing: [],
    });
    let polls = 0;
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        requests.push(`${req.method} ${req.url} ${body}`);
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/component-import") {
          res.end(JSON.stringify({ installed: ["bge-m3"], matched: [{ component: "bge-m3", file: "a" }], unknown: [], missing: [], view: view("installed") }));
          return;
        }
        if (req.method === "POST") {
          res.end(JSON.stringify(view("downloading", 0)));
          return;
        }
        polls++;
        res.end(JSON.stringify(polls < 2 ? view("downloading", 300_000_000) : view("installed")));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const t = await installedCli();
      fs.mkdirSync(path.join(t.ctx.dataDir, "config"), { recursive: true });
      fs.writeFileSync(path.join(t.ctx.dataDir, "config", "ergo.json"), JSON.stringify({ ports: { local: port, external: port + 1 } }));
      expect(await t.run("components", "add", "bge-m3")).toBe(0);
      expect(t.out).toContain("  bge-m3 50% (300 MB / 570 MB)");
      expect(t.out.at(-1)).toBe("bge-m3: installed");
      expect(requests[0]).toBe('POST /api/components/bge-m3 {"action":"install"}');
      t.out.length = 0;
      polls = 5;
      expect(await t.run("components", "list")).toBe(0);
      expect(t.out[1]).toMatch(/^bge-m3\s+Embedding model bge-m3\s+installed\s+1\s+570 MB\s+installed by default$/);
      expect(t.out.at(-1)).toBe("Component list 0.3.0, signature verified.");
      t.out.length = 0;
      expect(await t.run("components", "import", "D:\\downloads\\bge-m3")).toBe(0);
      expect(t.out).toEqual(["Imported: installed bge-m3; recognized 1 files, 0 unrecognized"]);
      expect(requests.at(-1)).toBe(`POST /api/component-import ${JSON.stringify({ path: path.resolve("D:\\downloads\\bge-m3") })}`);
    } finally {
      server.close();
    }
    const down = await installedCli();
    fs.mkdirSync(path.join(down.ctx.dataDir, "config"), { recursive: true });
    fs.writeFileSync(path.join(down.ctx.dataDir, "config", "ergo.json"), JSON.stringify({ ports: { local: await deadPort(), external: 1 } }));
    expect(await down.run("components")).toBe(1);
    expect(down.err[0]).toMatch(/^ergo is not running \(http:\/\/127\.0\.0\.1:\d+\/ does not answer\): run ergo start first\.$/);
  });
});

describe.runIf(process.platform === "win32")("真的计划任务", () => {
  // 用例按写的顺序跑，这是最后一个：上面所有用例都跑完了才比。任务不存在的电脑两边都是空串
  it("跑完这个文件，这台电脑上的 LocalServiceManager 一个字没变", () => {
    expect(realAutostartTaskDefinition()).toBe(realTaskBefore);
  }, 60_000);
});
