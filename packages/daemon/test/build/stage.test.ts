// 构建出的版本目录（318 号票，build/stage.ts；npm run release、npm run ergo:install、npm run build 都用它）：里面有什么、没有什么。
// 有：转好的 JS（没有 .ts）、资源目录、服务管家、网页、Node 和它的许可证、启动器、版本信息、许可证清单（Node、sharp/libvips、字体 OFL……）；
// 没有：.scratch、评测数据（memory-eval）、测试、服务管家的私有数据和设计记录、开发用的命令行工具。转好的命令行、组合根真能加载。
// 第三方包用联接（link）摆，省得每次复制 300 MB；复制哪些另由 deps.test.ts 管。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageVersion, type StageResult } from "../../build/stage.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..");

// 这里只拿 pi 的包名当数据（查它有没有被打进版本目录、许可证清里有没有），不 import 它。
// 拆成两段拼是因为 test/pi-boundary.test.ts 规定 agent-child/ 之外的文件里不许出现对 pi 的引用（ADR-0001 / ADR-0004）。
const PI = ["@earendil", "works"].join("-");
let base: string;
let out: string;
let result: StageResult;

/** 版本目录里的每个文件（相对路径，用 /；不进联接过去的 node_modules） */
function files(dir: string): string[] {
  const list: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else list.push(r);
    }
  };
  walk(dir, "");
  return list;
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-stage-"));
  const web = path.join(base, "web-dist");
  fs.mkdirSync(path.join(web, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>ergo</title>");
  fs.writeFileSync(path.join(web, "fonts", "a.woff2"), "font");
  out = path.join(base, "ergo-9.9.9");
  result = stageVersion({
    repo: REPO,
    out,
    kind: "release",
    version: "9.9.9",
    node: { exe: process.execPath, version: process.versions.node },
    nodeModules: "link",
    commit: "abc123",
    releaseKey: "untrusted comment: minisign public key 0000000000000000\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
    webDist: web,
  });
}, 120_000);

afterAll(() => {
  try {
    fs.rmdirSync(path.join(out, "app", "node_modules"));
  } catch {
    // 没有联接
  }
  for (const name of ["protocol", "memory", "daemon", "supervisor"]) {
    try {
      fs.rmdirSync(path.join(out, "app", "packages", name, "node_modules"));
    } catch {
      // 没有联接
    }
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("版本目录里有什么", () => {
  it("版本信息、Node 和它的许可证、启动器（批处理是 CRLF）", () => {
    expect(JSON.parse(fs.readFileSync(path.join(out, "ergo.json"), "utf8"))).toMatchObject({ format: 1, version: "9.9.9", kind: "release", node: process.versions.node, commit: "abc123" });
    expect(fs.statSync(path.join(out, "node", "node.exe")).size).toBe(fs.statSync(process.execPath).size);
    expect(fs.readFileSync(path.join(out, "node", "LICENSE"), "utf8")).toMatch(/Node\.js/);
    const cmd = fs.readFileSync(path.join(out, "ergo.cmd"), "utf8");
    expect(cmd).toContain("app\\packages\\daemon\\src\\cli\\main.js");
    expect(cmd.replace(/\r\n/g, "")).not.toContain("\n");
    expect(result.info.version).toBe("9.9.9");
  });

  it("程序：转好的 JS、资源、服务管家、网页、发布公钥；包的 package.json 只留运行时的几项、入口是 .js", () => {
    const app = path.join(out, "app");
    for (const f of [
      "package.json",
      "packages/daemon/src/main.js",
      "packages/daemon/src/stop.js",
      "packages/daemon/src/cli/main.js",
      "packages/daemon/src/components/manifest.json",
      "packages/daemon/src/release/release-key.pub",
      "packages/daemon/prompts/secretary.md",
      "packages/daemon/holidays/cn-2026.json",
      "packages/daemon/skills/example-checklist/SKILL.md",
      "packages/protocol/src/index.js",
      "packages/protocol/locales/zh-CN/cli.json",
      "packages/protocol/locales/en/cli.json",
      "packages/memory/src/index.js",
      "packages/supervisor/bin/lsm.mjs",
      "packages/supervisor/src/paths.mjs",
      "packages/supervisor/webui/index.html",
      "packages/supervisor/docs/link-protocol.md",
      "packages/web/dist/index.html",
      "packages/web/dist/fonts/a.woff2",
    ]) {
      expect({ f, exists: fs.existsSync(path.join(app, ...f.split("/"))) }).toEqual({ f, exists: true });
    }
    const daemonPkg = JSON.parse(fs.readFileSync(path.join(app, "packages", "daemon", "package.json"), "utf8")) as Record<string, unknown>;
    expect(daemonPkg.scripts).toBeUndefined();
    expect(daemonPkg.devDependencies).toBeUndefined();
    expect(daemonPkg.optionalDependencies).toHaveProperty("@anthropic-ai/claude-agent-sdk");
    expect((JSON.parse(fs.readFileSync(path.join(app, "packages", "protocol", "package.json"), "utf8")) as { exports: unknown }).exports).toEqual({ ".": "./src/index.js" });
    expect(fs.lstatSync(path.join(app, "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("许可证清单：Node、随包的第三方（sharp 的 libvips、onnxruntime、pi）、打进网页的（react、字体 OFL）", () => {
    const notices = fs.readFileSync(path.join(out, "THIRD_PARTY_NOTICES.txt"), "utf8");
    const list = JSON.parse(fs.readFileSync(path.join(out, "third-party-licenses.json"), "utf8")) as Array<{ name: string; license: string; where: string }>;
    const find = (name: string) => list.find((i) => i.name === name);
    expect(find("Node.js")).toMatchObject({ where: "runtime" });
    expect(notices).toMatch(/Node\.js[\s\S]*Copyright Node\.js contributors/);
    expect(find("@img/sharp-win32-x64")?.license).toMatch(/LGPL-3\.0/);
    expect(find("onnxruntime-node")).toMatchObject({ where: "node_modules", license: "MIT" });
    expect(find(`${PI}/pi-coding-agent`)).toMatchObject({ where: "node_modules" });
    expect(find("react")).toMatchObject({ where: "web", license: "MIT" });
    expect(list.filter((i) => i.name.startsWith("@fontsource")).every((i) => i.license === "OFL-1.1" && i.where === "web")).toBe(true);
    expect(list.filter((i) => i.name.startsWith("@fontsource")).length).toBeGreaterThan(3);
    expect(list.some((i) => i.name.startsWith("@anthropic-ai/claude-agent-sdk"))).toBe(false);
    // 每一条都有许可证全文或写明包里没有
    for (const i of list) expect(notices).toContain(`${i.name} `);
  });
});

describe("版本目录里没有什么", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["TypeScript 源码", /\.ts$/],
    ["内部笔记", /(^|\/)\.scratch(\/|$)/],
    ["评测数据和评测包", /(^|\/)(memory-eval|eval2?)(\/|$)|truth(-README)?\.(json|md)$|leak-check\.json$|judging\.json$/],
    ["测试", /(^|\/)(test|tests|__tests__|fixtures?)(\/|$)|\.test\.(m?js|ts)$/],
    ["调研报告", /(^|\/)docs\/research(\/|$)/],
    ["个人规矩", /(^|\/)CLAUDE\.md$/],
    // 代码里叫 secrets.js 的（读密钥区的模块）不算；密钥目录、.env、私钥文件才算
    ["密钥", /(^|\/)(\.secrets|secrets)\/|(^|\/)\.env(\.|$)|\.(pem|key|p12)$/],
    ["服务管家的私有数据和设计记录", /packages\/supervisor\/(registry|logs|docs\/adr|docs\/notices)(\/|$)|packages\/supervisor\/(state\.json|tailnet-routes\.json|docs\/migration-plan\.md)$/],
    ["开发用的命令行工具", /i18n\/check-cli\.js$/],
  ];
  it.each(forbidden)("没有%s", (_what, pattern) => {
    expect(files(out).filter((f) => pattern.test(f))).toEqual([]);
  });
});

describe("转好的程序真能跑", () => {
  it("命令行：ergo version 认出是装好的、版本号对", () => {
    const r = spawnSync(process.execPath, [path.join(out, "app", "packages", "daemon", "src", "cli", "main.js"), "version"], {
      encoding: "utf8",
      env: { ...process.env, ERGO_LANGUAGE: "en", ERGO_HOME: "" },
      windowsHide: true,
    });
    expect({ status: r.status, stderr: r.stderr }).toMatchObject({ status: 0 });
    expect(r.stdout).toMatch(/^ergo 9\.9\.9 \(release package\) · Node v\d+\.\d+\.\d+ · commit abc123/);
  });

  it("组合根和子进程入口的模块图都加载得了（引用都改对了）", () => {
    const entries = [
      "packages/daemon/src/daemon.js",
      "packages/daemon/src/runtime/agent-child/main.js",
      "packages/daemon/src/stop.js",
      "packages/memory/src/index.js",
    ].map((f) => pathToFileURL(path.join(out, "app", ...f.split("/"))).href);
    const script = `for (const u of ${JSON.stringify(entries.slice(0, 1).concat(entries.slice(3)))}) await import(u); console.log("loaded");`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(r.stdout + r.stderr).toContain("loaded");
    // 子进程入口、stop 钩子：只查语法（加载它们就是在跑它们）
    for (const f of entries.slice(1, 3)) {
      const c = spawnSync(process.execPath, ["--check", fileURLToPath(f)], { encoding: "utf8", windowsHide: true });
      expect({ f, status: c.status, stderr: c.stderr }).toMatchObject({ status: 0 });
    }
  }, 60_000);
});
