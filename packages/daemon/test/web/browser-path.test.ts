// 用哪个浏览器（70 号票，照搬 drama_maker 的 chrome-path.js，用户显式写了二狗的配置 web.browserPath 时它排最前）：测试里全是临时目录里的假路径，
// 假的 chrome.exe 只有一段 PE 文件头（签没签名由签名表那一项决定），不碰本机装的浏览器。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentBrowserCandidates, browserCandidates, createBrowserLocator, pickBrowser, probeEmbeddedSignature, systemChromePaths } from "../../src/web/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 一段最小的 PE 文件头：MZ、PE 签名、可选头的 magic（PE32+ 或 PE32），签名表（data directory 第 4 项）有没有 */
function peHeader(signed: boolean, magic: 0x20b | 0x10b = 0x20b): Buffer {
  const buf = Buffer.alloc(0x200);
  buf.writeUInt16LE(0x5a4d, 0);
  const peOff = 0x80;
  buf.writeUInt32LE(peOff, 0x3c);
  buf.writeUInt32LE(0x00004550, peOff);
  const optOff = peOff + 24;
  buf.writeUInt16LE(magic, optOff);
  const secOff = optOff + (magic === 0x20b ? 112 : 96) + 4 * 8;
  if (signed) {
    buf.writeUInt32LE(0x1000, secOff);
    buf.writeUInt32LE(0x2000, secOff + 4);
  }
  return buf;
}

/** 在 dir 下建一个假的浏览器（目录按需建好），返回路径 */
function fakeExe(file: string, content: Buffer | string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe("签名探测（读 PE 文件头的签名表）", () => {
  it("有签名表的是 signed，没有的是 unsigned；PE32 也认", () => {
    const dir = makeTempDir("ergou-pe-");
    expect(probeEmbeddedSignature(fakeExe(path.join(dir, "signed.exe"), peHeader(true)))).toBe("signed");
    expect(probeEmbeddedSignature(fakeExe(path.join(dir, "unsigned.exe"), peHeader(false)))).toBe("unsigned");
    expect(probeEmbeddedSignature(fakeExe(path.join(dir, "pe32.exe"), peHeader(true, 0x10b)))).toBe("signed");
  });

  it("不是 PE、太短、读不到的是 unknown（不能据此否决）", () => {
    const dir = makeTempDir("ergou-pe-");
    expect(probeEmbeddedSignature(fakeExe(path.join(dir, "text.exe"), "not a pe file"))).toBe("unknown");
    const noPe = peHeader(true);
    noPe.writeUInt32LE(0, 0x80);
    expect(probeEmbeddedSignature(fakeExe(path.join(dir, "nope.exe"), noPe))).toBe("unknown");
    expect(probeEmbeddedSignature(path.join(dir, "missing.exe"))).toBe("unknown");
  });
});

describe("候选的顺序", () => {
  it("配置（写了才有）→ 守护进程环境里的 AGENT_BROWSER_EXECUTABLE_PATH → agent-browser 自带（版本高的在前）→ 系统 Chrome（照 drama，没有 Edge）", () => {
    const home = makeTempDir("ergou-home-");
    const ab = path.join(home, ".agent-browser", "browsers");
    fakeExe(path.join(ab, "chrome-131.0.1", "chrome.exe"), peHeader(true));
    fakeExe(path.join(ab, "chrome-153.0.8", "chrome.exe"), peHeader(false));
    fs.mkdirSync(path.join(ab, "chrome-160.0.0"), { recursive: true }); // 没有 chrome.exe 的目录不算
    fs.mkdirSync(path.join(ab, "firefox-1"), { recursive: true });
    expect(agentBrowserCandidates(home)).toEqual([path.join(ab, "chrome-153.0.8", "chrome.exe"), path.join(ab, "chrome-131.0.1", "chrome.exe")]);

    const env = { programfiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", agent_browser_executable_path: "D:\\fake\\from-env.exe" };
    const candidates = browserCandidates({ configured: "D:\\fake\\configured.exe", homeDir: home, env });
    expect(candidates.map((c) => c.path)).toEqual([
      "D:\\fake\\configured.exe",
      "D:\\fake\\from-env.exe",
      path.join(ab, "chrome-153.0.8", "chrome.exe"),
      path.join(ab, "chrome-131.0.1", "chrome.exe"),
      path.join("C:\\PF", "Google/Chrome/Application/chrome.exe"),
      path.join("C:\\PF86", "Google/Chrome/Application/chrome.exe"),
      path.join("C:\\Users\\me\\AppData\\Local", "Google/Chrome/Application/chrome.exe"),
    ]);
    expect(candidates[0]!.why).toBe("外部显式指定（二狗的配置 web.browserPath）");
    expect(candidates[1]!.why).toBe("外部显式指定（AGENT_BROWSER_EXECUTABLE_PATH）");
    // 没写配置：和 drama 的 chromeCandidates 一样，从环境变量开始
    expect(browserCandidates({ homeDir: home, env }).map((c) => c.path)).toEqual(candidates.slice(1).map((c) => c.path));
    expect(browserCandidates({ configured: "", homeDir: home, env: { AGENT_BROWSER_EXECUTABLE_PATH: "  " } }).map((c) => c.path)).toEqual(agentBrowserCandidates(home));
    expect(systemChromePaths({})).toEqual([]);
  });
});

describe("选哪个", () => {
  it("跳过不存在的、没签名的，选第一个签了名的；签名探测不出结论的按能用处理", () => {
    const dir = makeTempDir("ergou-pick-");
    const unsigned = fakeExe(path.join(dir, "cft", "chrome.exe"), peHeader(false));
    const signed = fakeExe(path.join(dir, "copy", "chrome.exe"), peHeader(true));
    const unknown = fakeExe(path.join(dir, "odd", "chrome.exe"), "odd");
    const pick = pickBrowser([
      { path: path.join(dir, "missing.exe"), why: "配置里写明的" },
      { path: unsigned, why: "agent-browser 自带" },
      { path: signed, why: "agent-browser 自带" },
    ]);
    expect(pick.path).toBe(signed);
    expect(pick.why).toBe("agent-browser 自带，已验签");
    expect(pick.rejected).toEqual([`${path.join(dir, "missing.exe")} —— 文件不存在`, expect.stringContaining(`${unsigned} —— 没有 Authenticode 签名`)]);
    expect(pickBrowser([{ path: unknown, why: "系统 Chrome 兜底" }]).why).toBe("系统 Chrome 兜底（签名探测不出结论，按能用处理）");
  });

  it("全都没签名：按存在兜底（告警）；一个都不存在：没有", () => {
    const dir = makeTempDir("ergou-pick-");
    const a = fakeExe(path.join(dir, "a.exe"), peHeader(false));
    const all = pickBrowser([{ path: a, why: "x" }]);
    expect(all.path).toBe(a);
    expect(all.why).toContain("多半会秒退");
    expect(pickBrowser([{ path: path.join(dir, "none.exe"), why: "x" }]).path).toBeNull();
  });
});

describe("守护进程里的探测", () => {
  it("找到了就记住（一个进程只探一次）、只记一次日志", () => {
    const home = makeTempDir("ergou-home-");
    const configured = fakeExe(path.join(home, "browser", "chrome.exe"), peHeader(true));
    const logs: string[] = [];
    const locator = createBrowserLocator({ configured, homeDir: home, env: {}, log: (l) => logs.push(l) });
    expect(locator.path()).toBe(configured);
    fs.rmSync(configured);
    expect(locator.path()).toBe(configured);
    expect(logs).toEqual([`浏览器用 ${configured}：外部显式指定（二狗的配置 web.browserPath），已验签`]);
  });

  it("没找到也记住（照 drama：一个进程只探一次，不设环境变量）：说清楚怎么办、找过哪些；装上之后要重启才认", () => {
    const home = makeTempDir("ergou-home-");
    const configured = path.join(home, "browser", "chrome.exe");
    const logs: string[] = [];
    const locator = createBrowserLocator({ configured, homeDir: home, env: {}, log: (l) => logs.push(l) });
    expect(locator.missingReason()).toMatch(/^找不到浏览器。在数据目录的配置里写 web\.browserPath（Chrome 或 Edge 的可执行文件的绝对路径），或者装上 Chrome，然后重启二狗/);
    expect(locator.missingReason()).toContain(`${configured} —— 文件不存在`);
    expect(locator.path()).toBeUndefined();
    fakeExe(configured, peHeader(true));
    expect(locator.path()).toBeUndefined();
    expect(logs.filter((l) => l.startsWith("没找到能用的浏览器"))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith("跳过的浏览器候选"))).toEqual([`跳过的浏览器候选：${configured} —— 文件不存在`]);
  });
});
