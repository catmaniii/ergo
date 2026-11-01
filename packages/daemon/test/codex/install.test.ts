// 本机的 Codex 在哪、版本够不够、交给它的环境（install.ts）：不起真的 codex，目录、文件都是编的。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_MIN_VERSION, codexMissing, codexProcessEnv, codexVersion, findCodexEntry, versionOlder } from "../../src/codex/install.ts";
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

describe("没装、版本太低", () => {
  it("没装：说清楚缺什么、怎么装、怎么登录", () => {
    const text = codexMissing({ PATH: makeTempDir("ergo-empty-path-") });
    expect(text).toContain("没装 Codex，用 npm i -g @openai/codex 安装，再 codex login");
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
