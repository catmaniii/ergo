// 本机的 Codex 在哪、版本够不够、交给它的环境（install.ts）：不起真的 codex，目录、文件都是编的。
// 454：设置 · 组件装的那份（<组件区>\codex）先认，再找 PATH；组件装的不在 PATH 上，登录写完整的命令。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_MIN_VERSION,
  codexComponentScript,
  codexLoginCommand,
  codexMissing,
  codexOnPath,
  codexProcessEnv,
  codexVersion,
  findCodexEntry,
  findCodexOnPath,
  versionOlder,
} from "../../src/codex/install.ts";
import { codexComponentNote } from "../../src/codex/plugin.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 编一个 npm 装好的 codex：codex.cmd（包装脚本）、node_modules/@openai/codex/bin/codex.js、package.json */
function npmInstall(version: string): string {
  const dir = makeTempDir("ergo-fake-npm-");
  const pkg = path.join(dir, "node_modules", "@openai", "codex");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex"), "");
  fs.writeFileSync(path.join(pkg, "bin", "codex.js"), "");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  return dir;
}

describe("找本机的 Codex", () => {
  it("Windows：codex.exe 直接起；npm 装的 codex.cmd 用 node 起旁边的 codex.js；按 PATH 的先后；都没有是 undefined", () => {
    const has = (...files: string[]) => (file: string) => files.includes(file);
    const win = { platform: "win32" as const, node: "C:\\node.exe" };
    expect(findCodexEntry({ PATH: "C:\\a;C:\\b" }, { ...win, exists: has("C:\\b\\codex.exe") })).toEqual({ command: "C:\\b\\codex.exe", args: [] });
    const script = "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    expect(findCodexEntry({ Path: '"C:\\npm";C:\\b' }, { ...win, exists: has("C:\\npm\\codex.cmd", script, "C:\\b\\codex.exe") })).toEqual({ command: "C:\\node.exe", args: [script] });
    // 只有包装脚本、旁边没有真的入口：起不了，接着往后找
    expect(findCodexEntry({ PATH: "C:\\npm" }, { ...win, exists: has("C:\\npm\\codex.cmd") })).toBeUndefined();
    expect(findCodexEntry({}, { ...win, exists: () => true })).toBeUndefined();
  });

  it("别的系统：PATH 里的 codex", () => {
    const options = { platform: "linux" as const, node: "/usr/bin/node", exists: (file: string) => file === "/opt/bin/codex" };
    expect(findCodexEntry({ PATH: "/usr/bin:/opt/bin" }, options)).toEqual({ command: "/opt/bin/codex", args: [] });
  });

  it("版本：npm 装的读包里的 package.json，不起进程；比前三段", () => {
    const dir = npmInstall("0.170.2");
    const entry = findCodexEntry({ PATH: dir })!;
    expect(codexVersion(entry)).toBe("0.170.2");
    expect(versionOlder("0.165.9", "0.166.0")).toBe(true);
    expect(versionOlder("0.166.0", "0.166.0")).toBe(false);
    expect(versionOlder("0.166.1-alpha.2", "0.166.0")).toBe(false);
    expect(versionOlder("1.0.0", "0.166.0")).toBe(false);
  });
});

/** 编一个设置 · 组件装好的 codex：<组件区>\codex\node_modules\@openai\codex\bin\codex.js 和 package.json */
function componentInstall(version: string): string {
  const componentsDir = makeTempDir("ergo-fake-components-");
  const script = codexComponentScript(componentsDir);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  fs.writeFileSync(path.join(path.dirname(script), "..", "package.json"), JSON.stringify({ version }));
  return componentsDir;
}

describe("设置 · 组件装的 Codex（454）", () => {
  it("组件区里的先认（PATH 上也有时也挑它）：用二狗自己的 Node 起 codex.js，标明是组件装的；版本读包里的 package.json", () => {
    const componentsDir = componentInstall("0.166.0");
    const script = path.join(componentsDir, "codex", "node_modules", "@openai", "codex", "bin", "codex.js");
    const onPath = npmInstall("0.170.2");
    const entry = findCodexEntry({ PATH: onPath }, { componentsDir, node: "C:\\ergo\\node.exe" });
    expect(entry).toEqual({ command: "C:\\ergo\\node.exe", args: [script], component: true });
    expect(codexVersion(entry!)).toBe("0.166.0");
    // 只找 PATH 的那个不看组件区（组件页的"别处已经有了"用它）
    expect(findCodexOnPath({ PATH: onPath })?.component).toBeUndefined();
    expect(codexOnPath({ PATH: onPath })).toEqual({ where: path.join(onPath, "node_modules", "@openai", "codex", "bin", "codex.js"), version: "0.170.2" });
  });

  it("组件区在哪：给了用给的；没给按环境里的 ERGO_COMPONENTS_DIR（守护进程给子进程带的）；组件区里没有就找 PATH", () => {
    const componentsDir = componentInstall("0.166.0");
    expect(findCodexEntry({ PATH: "", ergo_components_dir: componentsDir })?.component).toBe(true);
    const onPath = npmInstall("0.170.2");
    const empty = makeTempDir("ergo-empty-components-");
    expect(findCodexEntry({ PATH: onPath }, { componentsDir: empty })).toEqual({ command: process.execPath, args: [path.join(onPath, "node_modules", "@openai", "codex", "bin", "codex.js")] });
    expect(findCodexEntry({ PATH: makeTempDir("ergo-empty-path-") }, { componentsDir: empty })).toBeUndefined();
  });

  it("组件装好了：插件装配（missing 是 undefined）；组件区里的版本读不出时照样写明", () => {
    const empty = { PATH: makeTempDir("ergo-empty-path-") };
    expect(codexMissing(empty, componentInstall("0.166.0"))).toBeUndefined();
    const broken = componentInstall("0.166.0");
    fs.rmSync(path.join(path.dirname(codexComponentScript(broken)), "..", "package.json"));
    expect(codexMissing(empty, broken)).toContain(CODEX_MIN_VERSION);
  });

  it("登录要运行的命令：PATH 上的是 codex login；组件装的写完整的（PowerShell：& '<node>' '<codex.js>' login，路径里的单引号写两个）", () => {
    expect(codexLoginCommand(undefined)).toBe("codex login");
    expect(codexLoginCommand({ command: "C:\\npm\\codex.exe", args: [] })).toBe("codex login");
    expect(codexLoginCommand({ command: process.execPath, args: ["C:\\x\\codex.js"] })).toBe("codex login");
    expect(codexLoginCommand({ command: "C:\\Program Files\\ergo\\node.exe", args: ["C:\\Users\\O'Neil\\.ergo\\components\\codex\\node_modules\\@openai\\codex\\bin\\codex.js"], component: true })).toBe(
      "& 'C:\\Program Files\\ergo\\node.exe' 'C:\\Users\\O''Neil\\.ergo\\components\\codex\\node_modules\\@openai\\codex\\bin\\codex.js' login",
    );
  });

  it("设置 · 插件里的说明：用的是组件装的才有，写版本，完整的登录命令单独交；用 PATH 上的、没有组件区都没有", () => {
    const componentsDir = componentInstall("0.166.0");
    const note = codexComponentNote({ PATH: makeTempDir("ergo-empty-path-") }, componentsDir);
    expect(note?.text).toContain("用的是设置 · 组件装的 Codex 0.166.0（不在 PATH 上）");
    expect(note?.text).toContain("在这台电脑的 PowerShell 里运行下面这条命令");
    expect(note?.command).toBe(codexLoginCommand(findCodexEntry({ PATH: "" }, { componentsDir })));
    expect(note?.command).toMatch(/^& '.+' '.+codex\.js' login$/);
    expect(codexComponentNote({ PATH: npmInstall("0.170.2") }, makeTempDir("ergo-empty-components-"))).toBeUndefined();
    expect(codexComponentNote({ PATH: npmInstall("0.170.2") }, undefined)).toBeUndefined();
  });
});

describe("没装、版本太低", () => {
  it("没装：说清楚缺什么、怎么装（设置 · 组件里的 Codex 接入，或者自己 npm 装）、要登录", () => {
    const text = codexMissing({ PATH: makeTempDir("ergo-empty-path-") });
    expect(text).toContain("到设置 · 组件里装「Codex 接入」");
    expect(text).toContain("ergo components add codex");
    expect(text).toContain("npm i -g @openai/codex");
    expect(text).toContain("登录 Codex");
  });

  it("版本太低写明；够新的是 undefined；版本读不出来也说", () => {
    expect(codexMissing({ PATH: npmInstall("0.100.0") })).toContain("0.100.0");
    expect(codexMissing({ PATH: npmInstall("0.100.0") })).toContain(CODEX_MIN_VERSION);
    expect(codexMissing({ PATH: npmInstall(CODEX_MIN_VERSION) })).toBeUndefined();
    const broken = npmInstall("1.0.0");
    fs.rmSync(path.join(broken, "node_modules", "@openai", "codex", "package.json"));
    expect(codexMissing({ PATH: broken })).toContain(CODEX_MIN_VERSION);
  });
});

describe("交给 codex 的环境", () => {
  it("去掉改计费、改账号、从别的 Codex 会话继承来的变量（不分大小写）；别的（PATH、CODEX_HOME）留着", () => {
    const env = codexProcessEnv({
      PATH: "C:\\x",
      OPENAI_API_KEY: "sk-1",
      openai_api_key: "sk-2",
      CODEX_API_KEY: "sk-3",
      CODEX_ACCESS_TOKEN: "t",
      OPENAI_BASE_URL: "http://x",
      CODEX_SESSION_ID: "old",
      CODEX_SANDBOX: "seatbelt",
      CODEX_HOME: "D:\\home",
      NOTHING: undefined,
    });
    expect(env).toEqual({ PATH: "C:\\x", CODEX_HOME: "D:\\home" });
  });
});
