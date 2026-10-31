// ergo 命令（318 号票）：参数、语言、服务管家的设置和二狗的登记（lsm validate 认）、update / rollback / uninstall / components / status。
// 服务管家一律指到临时数据目录、没人听的端口（不碰本机正在跑的 7420 和二狗 8810/8811）；发布对着本机的假下载服务；PATH 用假的存储。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { activeLocaleFrom, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { parseArgs } from "../../src/cli/args.ts";
import { type CliContext, createContext, daemonPort } from "../../src/cli/context.ts";
import { cliLanguage, runCli } from "../../src/cli/run.ts";
import { daemonEntryYaml, defaultManagerYaml, managerAddress, quoteArg, svcPaths, writeSvcConfig, yamlQuote } from "../../src/cli/service.ts";
import { packageManagerOf } from "../../src/cli/versions.ts";
import { builtinCatalogs } from "../../src/i18n/builtin.ts";
import { currentVersionName, detectLayout, installPaths, readInstallState, switchCurrent, writeVersionInfo } from "../../src/release/layout.ts";
import { fileUserPathStore } from "../../src/release/user-path.ts";
import { startFakeDownloads } from "../helpers/fake-downloads.ts";
import { fakeRelease, releaseKey } from "../helpers/fake-release.ts";

const LSM = path.resolve(import.meta.dirname, "..", "..", "..", "supervisor", "bin", "lsm.mjs");

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ergo-cli-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
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
  run(...argv: string[]): Promise<number>;
}

/** 一个装好的 ergo（假的版本目录，current 那行文本指着它）+ 临时的数据目录、服务管家数据目录（manager.yaml 指着没人听的端口） */
async function installedCli(options: { versions?: string[]; current?: string; env?: NodeJS.ProcessEnv; answers?: string[] } = {}): Promise<TestCli> {
  const base = tmp();
  const root = path.join(base, "inst");
  for (const v of options.versions ?? ["0.2.0"]) {
    const dir = path.join(installPaths(root).versions, v);
    fs.mkdirSync(path.join(dir, "node"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node", "node.exe"), "");
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    writeVersionInfo(dir, { format: 1, version: v, kind: "release" });
  }
  const current = options.current ?? (options.versions ?? ["0.2.0"])[0]!;
  switchCurrent(root, current);
  // 启动器给的是 versions\<版本> 这个目录（它是照 current 那行文本找出来的）
  const home = path.join(installPaths(root).versions, current);
  const svc = path.join(base, "svc");
  const port = await deadPort();
  fs.mkdirSync(path.join(svc, "registry"), { recursive: true });
  fs.writeFileSync(path.join(svc, "registry", "manager.yaml"), defaultManagerYaml(port));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ERGO_HOME: home,
    ERGO_DATA_DIR: path.join(base, "data"),
    LSM_DATA_DIR: svc,
    ERGO_SVC_PORT: String(port),
    ERGO_USER_ENV_FILE: path.join(base, "user-env.json"),
    ERGO_LANGUAGE: "en",
    ...options.env,
  };
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(options.answers ?? [])];
  const layout = detectLayout({ cliFile: path.join(home, "app", "packages", "daemon", "src", "cli", "main.js"), env, execPath: process.execPath });
  const ctx = createContext(layout, env, { out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => answers.shift() ?? "" }, base);
  setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
  return { ctx, out, err, base, root, run: (...argv) => runCli(argv, ctx) };
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
      { name: "DEEPSEEK_API_KEY", from: "file", path: path.join(t.ctx.dataDir, "secrets", "deepseek-api-key.txt"), optional: true },
      // 自定义（OpenAI 兼容）服务商的 key：和 DeepSeek 一样从密钥区注入，没有这个文件也能起来
      { name: "CUSTOM_MODEL_API_KEY", from: "file", path: path.join(t.ctx.dataDir, "secrets", "custom-model-api-key.txt"), optional: true },
    ]);
    expect(yamlQuote("C:\\a\\v'x")).toBe("'C:\\a\\v''x'");

    const first = writeSvcConfig(t.ctx);
    expect(first).toEqual({ managerCreated: false, entryChanged: true });
    expect(writeSvcConfig(t.ctx)).toEqual({ managerCreated: false, entryChanged: false });
    const v = spawnSync(process.execPath, [LSM, "validate"], { env: { ...t.ctx.env, LSM_DATA_DIR: t.ctx.svcDataDir }, encoding: "utf8", windowsHide: true });
    expect(v.stdout + v.stderr).toMatch(/1 个服务，全部通过校验/);
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

  it("不像安装目录的不删；开发布局不用卸", async () => {
    const t = await installedCli();
    fs.rmSync(installPaths(t.root).versions, { recursive: true, force: true });
    expect(await t.run("uninstall", "--yes")).toBe(1);
    expect(t.err[0]).toMatch(/does not look like an ergo install folder/);
  });
});

describe("components（二狗本机端口上的组件接口的终端前端）", () => {
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
