// 一行命令安装（318 号票，installer/install.ps1）：
//   - 文件只有 ASCII（irm | iex 不认 BOM、-File 按 ANSI 读），中文句子写成 \uXXXX；中英两份句子一一对应、参数一样，没有"秘书""待我处理"；
//   - 里面那段 C#（Ed25519 + BLAKE2b 验 minisign 签名、解 npm 的 tgz）和 Node 那一份互相认；
//   - 对着本机的假发布站整个装一遍（-File 和 irm | iex 两种）：验签、解开、current 联接、bin、install.json；签名不对、Node 版本没测过的不装；
//   - 下载有进度（341 号票）：百分比、已下载/总量、速度；真窗口里刷新同一行，输出被重定向时每 10% 一行；不给长度也下得完；失败不留半截文件。
//   - 装好以后那几步（342 号票）：默认先注册开机自启、再 ergo onboard；-NoAutostart、-NoStart（旧名 -NoOnboard）各自生效；某一步失败其余照常、退出码 0、写清怎么重做；
//     已有的任务指着别处不动；最后报版本、安装目录、current、自启状态、下一步。
// 不改真的 PATH（-NoPath / ERGO_INSTALL_NO_PATH）。
// 碰不到真的计划任务和服务管家：假发布包里的 ergo.cmd 是假的（只把收到的命令记下来），脚本读的任务也换成文件（ERGO_AUTOSTART_TASK_FILE）；
// 默认还带 ERGO_INSTALL_NO_AUTOSTART，要测开机自启的用例才去掉。最后一个 describe 核对真的任务前后一个字不差。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sign } from "../../src/release/minisign.ts";
import { blob, makeTar, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { fakeRelease, fakeVersionZip, releaseKey } from "../helpers/fake-release.ts";
import { realAutostartTaskDefinition } from "../helpers/real-autostart-task.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "installer", "install.ps1");
const text = fs.readFileSync(SCRIPT, "utf8");
const BACKSLASH = String.fromCharCode(92);

// 只为这个文件结束时比一比（最后一个 describe）
let realTaskBefore = "";
beforeAll(() => {
  realTaskBefore = realAutostartTaskDefinition();
}, 60_000);

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ergo-install-ps-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
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

/** 脚本读任务时读这个（不存在 = 没有任务）：用例没另外指定时，连真的任务读都不读 */
const NO_TASK_FILE = path.join(os.tmpdir(), "ergo-install-ps-no-such-task.json");

/** 跑 PowerShell（异步：假发布站就在这个进程里，同步地等会把它卡住） */
function powershell(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
      windowsHide: true,
      env: { ...process.env, ERGO_LANGUAGE: "en", ERGO_INSTALL_NO_AUTOSTART: "1", ERGO_AUTOSTART_TASK_FILE: NO_TASK_FILE, ...env },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const timer = setTimeout(() => child.kill(), 150_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** 退出码不是 0 就把脚本输出带出来（CI 上只看得到 code，没法查） */
function expectOk(r: { code: number; out: string }): void {
  if (r.code !== 0) throw new Error(`exit ${r.code}\n${r.out}`);
}

/** 只拿脚本里的句子表和下载函数跑一段（不走安装流程）。live：把"输出被重定向"的判断换掉，走真窗口那条路（测试的输出总是管道） */
function downloadScript(calls: string, opts: { live?: boolean } = {}): string {
  const table = text.slice(text.indexOf("$ErgoMessages = @{"), text.indexOf("# ---- C#:"));
  const helpers = text.slice(text.indexOf("# ---- small helpers ----"), text.indexOf("function Get-Sha256"));
  expect(helpers).toContain("[Console]::IsOutputRedirected");
  const body = opts.live ? helpers.replace("[Console]::IsOutputRedirected", () => "$false") : helpers;
  const file = path.join(tmp(), "download.ps1");
  fs.writeFileSync(file, `$ErrorActionPreference = 'Stop'\n${table}\n${body}\n${calls}\n`);
  return file;
}

/** 输出里的进度行（"Downloading x..." 那种开始下载的句子不算） */
function progressLines(out: string): string[] {
  return out.split(/\r?\n/).filter((line) => line.startsWith("  Downloaded "));
}

/** 句子表：key → [中文（\uXXXX 解开的）, 英文] */
function messages(): Map<string, [string, string]> {
  const block = text.slice(text.indexOf("$ErgoMessages = @{"), text.indexOf("\n}\n", text.indexOf("$ErgoMessages = @{")));
  const out = new Map<string, [string, string]>();
  for (const m of block.matchAll(/^\s+(\w+) = @\('((?:[^']|'')*)', '((?:[^']|'')*)'\)$/gm)) {
    const zh = m[2]!.replace(/''/g, "'").replace(new RegExp(`${BACKSLASH.repeat(2)}u([0-9a-f]{4})`, "g"), (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
    out.set(m[1]!, [zh, m[3]!.replace(/''/g, "'")]);
  }
  return out;
}

describe("install.ps1 的文字", () => {
  it("只有 ASCII（irm | iex、-File 两种读法都不会读坏）", () => {
    const bad = [...text].filter((c) => c.codePointAt(0)! > 127);
    expect(bad).toEqual([]);
  });

  it("中英两份句子一一对应、参数一样；中文里没有「秘书」「待我处理」", () => {
    const m = messages();
    expect(m.size).toBeGreaterThan(30);
    for (const [key, [zh, en]] of m) {
      // 中文那份有非 ASCII 的字（"{0}……" 这种只有标点的也算）
      expect({ key, zh }).toMatchObject({ zh: expect.stringMatching(/[^ -~]/) });
      expect(`${key}: ${en}`).not.toMatch(/[一-鿿]/);
      const params = (s: string) => [...s.matchAll(/\{(\d)\}/g)].map((x) => x[1]).sort();
      expect({ key, params: params(zh) }).toEqual({ key, params: params(en) });
      expect(`${key}: ${zh}`).not.toMatch(/秘书|待我处理/);
      expect(`${key}: ${en.toLowerCase()}`).not.toContain("secretary");
    }
    // 脚本里用到的句子都在表里
    const used = new Set([...text.matchAll(/\(M '(\w+)'/g)].map((x) => x[1]!));
    expect([...used].filter((k) => !m.has(k))).toEqual([]);
  });
});

describe.runIf(process.platform === "win32")("install.ps1 里的 C#", () => {
  it("验得过 Node 签的（ED、旧的 Ed）、验不过改过的和别的钥匙签的；BLAKE2b 对上；解得开 npm 的 tgz", async () => {
    const dir = tmp();
    const cs = text.slice(text.indexOf("// BEGIN ERGO CSHARP"), text.indexOf("// END ERGO CSHARP"));
    fs.writeFileSync(path.join(dir, "ergo.cs"), cs);
    const key = releaseKey();
    const other = releaseKey();
    const message = crypto.randomBytes(5000);
    fs.writeFileSync(path.join(dir, "msg.bin"), message);
    fs.writeFileSync(path.join(dir, "ed.sig"), sign(message, key.secret, { trustedComment: "hashed one" }));
    fs.writeFileSync(path.join(dir, "legacy.sig"), sign(message, key.secret, { prehashed: false, trustedComment: "legacy one" }));
    fs.writeFileSync(path.join(dir, "other.sig"), sign(message, other.secret));
    fs.writeFileSync(path.join(dir, "key.pub"), key.publicText);
    const tgz = makeTar(
      [
        { path: "package/latest.json", body: '{"a":1}' },
        { path: `package/${"long-name-".repeat(12)}.txt`, body: "long", pax: true },
        { path: "package/dir", type: "dir" },
        { path: "package/dir/inner.bin", body: Buffer.from([1, 2, 3]) },
      ],
      true,
    );
    fs.writeFileSync(path.join(dir, "p.tgz"), tgz);
    const script = [
      `Add-Type -TypeDefinition (Get-Content -Raw '${dir}\\ergo.cs') -ReferencedAssemblies System.Numerics -Language CSharp`,
      `$msg = [IO.File]::ReadAllBytes('${dir}\\msg.bin'); $pub = Get-Content -Raw '${dir}\\key.pub'`,
      "foreach ($f in @('ed.sig', 'legacy.sig', 'other.sig')) { $c = $null; $r = [ErgoInstall.Minisign]::Verify($pub, (Get-Content -Raw (Join-Path '" + dir + "' $f)), $msg, [ref]$c); Write-Output \"$f=[$r][$c]\" }",
      "$msg[7] = $msg[7] -bxor 1",
      "$c = $null; Write-Output ('tampered=[' + [ErgoInstall.Minisign]::Verify($pub, (Get-Content -Raw '" + dir + "\\ed.sig'), $msg, [ref]$c) + ']')",
      "Write-Output ('blake=' + (([ErgoInstall.Blake2b]::Hash([Text.Encoding]::ASCII.GetBytes('abc'), 32) | ForEach-Object { $_.ToString('x2') }) -join ''))",
      `Write-Output ('tgz=' + [ErgoInstall.Tgz]::Extract('${dir}\\p.tgz', '${dir}\\out', 1))`,
    ].join("\n");
    const r = await powershell(["-Command", script]);
    expectOk(r);
    expect(r.out).toContain("ed.sig=[][hashed one]");
    expect(r.out).toContain("legacy.sig=[][legacy one]");
    expect(r.out).toContain("other.sig=[signed by another key][]");
    expect(r.out).toContain("tampered=[signature does not match the content]");
    expect(r.out).toContain("blake=bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319");
    expect(r.out).toContain("tgz=3");
    expect(fs.readFileSync(path.join(dir, "out", "latest.json"), "utf8")).toBe('{"a":1}');
    expect(fs.readFileSync(path.join(dir, "out", `${"long-name-".repeat(12)}.txt`), "utf8")).toBe("long");
    expect([...fs.readFileSync(path.join(dir, "out", "dir", "inner.bin"))]).toEqual([1, 2, 3]);
  }, 120_000);
});

describe.runIf(process.platform === "win32")("install.ps1 整个装一遍（本机的假发布站）", () => {
  it("-File：验签、解开到 versions\\<版本>、current 联接、bin、install.json；签名不对的、Node 版本没测过的不装", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    for (const [name, body] of fakeRelease("0.3.0", key.secret).files) fake.put(name, body);
    const dir = tmp();
    const root = path.join(dir, "inst");
    const base = `${fake.url}/m1`;
    const ok = await powershell(["-File", SCRIPT, "-InstallDir", root, "-BaseUrl", base, "-PublicKey", key.publicLine, "-NoPath", "-NoOnboard"]);
    // CI 上失败时把脚本输出带出来，不然只看得到 code
    expectOk(ok);
    expect(ok.out).toContain("Signature OK: ergo 0.3.0 SHA256SUMS");
    expect(ok.out).toContain("PATH not changed");
    // 三个文件（清单、签名、发布包）各有进度；走的还是原来的 User-Agent
    const shown = progressLines(ok.out);
    expect(shown).toHaveLength(3);
    for (const line of shown) expect(line).toMatch(/^ {2}Downloaded 100% \([\d.]+ \w+ \/ [\d.]+ \w+, [\d.]+ \w+\/s\)$/);
    const downloads = fake.requests.filter((r) => r.path !== "latest.json");
    expect(downloads.map((r) => r.path)).toEqual(["SHA256SUMS", "SHA256SUMS.minisig", "ergo-0.3.0-win-x64.zip"]);
    for (const r of downloads) expect(r.userAgent).toBe("ergo-installer");
    // 脚本在 irm | iex 下没法用 exit code 报错，失败只体现在这行字面上（2026-10-30 Get-FileHash 那次就是）
    expect(ok.out).not.toContain("安装失败");
    expect(JSON.parse(fs.readFileSync(path.join(root, "versions", "0.3.0", "ergo.json"), "utf8")).version).toBe("0.3.0");
    expect(fs.readFileSync(path.join(root, "current"), "utf8").trim()).toBe("0.3.0");
    expect(fs.existsSync(path.join(root, "bin", "ergo.cmd"))).toBe(true);
    expect(fs.existsSync(path.join(root, "bin", "ergo.exe"))).toBe(false);
    const state = JSON.parse(fs.readFileSync(path.join(root, "install.json"), "utf8")) as { source?: { url?: string }; installedBy?: string };
    expect(state).toMatchObject({ source: { url: base }, installedBy: "install.ps1" });

    // 别的钥匙签的：不装，在用的版本不变
    for (const [name, body] of fakeRelease("0.4.0", releaseKey().secret).files) fake.put(name, body);
    const bad = await powershell(["-File", SCRIPT, "-InstallDir", root, "-BaseUrl", base, "-PublicKey", key.publicLine, "-NoPath", "-NoOnboard"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("Signature check failed; not installing: signed by another key");
    expect(fs.existsSync(path.join(root, "versions", "0.4.0"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "current"), "utf8").trim()).toBe("0.3.0");

    // 没测过的 Node 版本、没有公钥：不装
    const node = await powershell(["-File", SCRIPT, "-InstallDir", root, "-BaseUrl", base, "-PublicKey", key.publicLine, "-NodeVersion", "26.0.0", "-NoPath", "-NoOnboard"]);
    expect(node.code).toBe(1);
    expect(node.out).toContain("Node 26.0.0 has not been tested; allowed versions: 22.23.4");
    const unsigned = await powershell(["-File", SCRIPT, "-InstallDir", root, "-BaseUrl", base, "-NoPath", "-NoOnboard"], { ERGO_RELEASE_PUBKEY: "" });
    expect(unsigned.code).toBe(1);
    expect(unsigned.out).toContain("no release public key");
  }, 180_000);

  it("irm | iex（开关都从环境变量来）：装得上、不退出调用它的 PowerShell", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    for (const [name, body] of fakeRelease("0.3.0", key.secret).files) fake.put(name, body);
    fake.put("install.ps1", text);
    const dir = tmp();
    const root = path.join(dir, "inst");
    const r = await powershell(["-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; irm ${fake.url}/m1/install.ps1 | iex; Write-Output 'STILL-HERE'`], {
      ERGO_INSTALL_DIR: root,
      ERGO_RELEASE_URL: `${fake.url}/m1`,
      ERGO_RELEASE_PUBKEY: key.publicLine,
      ERGO_INSTALL_NO_PATH: "1",
      ERGO_INSTALL_NO_ONBOARD: "1",
      ERGO_LANGUAGE: "zh",
    });
    expectOk(r);
    expect(r.out).toContain("STILL-HERE");
    expect(r.out).toContain("签名对：ergo 0.3.0 SHA256SUMS");
    expect(r.out).toMatch(/已下载 100%（[\d.]+ \w+ \/ [\d.]+ \w+，[\d.]+ \w+\/s）/);
    expect(r.out).not.toContain("安装失败");
    expect(r.out).toContain("开机自启：没开（-NoAutostart）");
    const current = path.join(root, "current");
    if (!fs.existsSync(current)) throw new Error(`没生成 ${current}（装了哪去、报了什么都在这下面）\n${r.out}`);
    expect(fs.readFileSync(current, "utf8").trim()).toBe("0.3.0");
  }, 180_000);

  it("假发布站不给长度：一样装得上，进度只写已下载和速度", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    for (const [name, body] of fakeRelease("0.3.0", key.secret).files) fake.put(name, body);
    fake.behave("m1", { kind: "noLength" });
    const dir = tmp();
    const root = path.join(dir, "inst");
    const r = await powershell(["-File", SCRIPT, "-InstallDir", root, "-BaseUrl", `${fake.url}/m1`, "-PublicKey", key.publicLine, "-NoPath", "-NoOnboard"]);
    expectOk(r);
    expect(r.out).toContain("Signature OK: ergo 0.3.0 SHA256SUMS");
    expect(fs.readFileSync(path.join(root, "current"), "utf8").trim()).toBe("0.3.0");
    const shown = progressLines(r.out);
    expect(shown).toHaveLength(3);
    for (const line of shown) expect(line).toMatch(/^ {2}Downloaded [\d.]+ \w+ \([\d.]+ \w+\/s\)$/);
  }, 120_000);

  it("下载中途断了、地址不对：报安装失败、退出 1，不留半截文件", async () => {
    const fake = await startFakeDownloads();
    fake.put("source.zip", blob(1024 * 1024));
    fake.behave("cut", { kind: "cut", bytes: 200_000, times: 1 });
    for (const [url, why] of [
      [`${fake.url}/cut/source.zip`, "The connection dropped: got "],
      [`${fake.url}/ok/nothing-here.zip`, "(404)"],
    ] as const) {
      const root = path.join(tmp(), "inst");
      const r = await powershell(["-File", SCRIPT, "-InstallDir", root, "-FromSource", "-Ref", "x", "-SourceUrl", url, "-NoPath", "-NoOnboard"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("Installation failed:");
      expect(r.out).toContain(why);
      const files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
      expect(files.map((e) => e.name)).toEqual([]);
    }
    expect(fake.requests.map((r) => r.mirror)).toEqual(["cut", "ok"]);
  }, 120_000);
});

/** 假的 ergo：把收到的每条命令记进 ERGO_FAKE_ERGO_LOG，按环境变量假装失败。真的服务管家、真的计划任务它一概碰不到 */
const FAKE_ERGO_CMD = [
  "@echo off",
  '>>"%ERGO_FAKE_ERGO_LOG%" echo %*',
  'if "%~1"=="svc" goto :svc',
  'if "%~1"=="onboard" goto :onboard',
  "exit /b 0",
  ":svc",
  "echo fake lsm output",
  'if "%ERGO_FAKE_SVC_FAIL%"=="1" (',
  "  echo fake task refused 1>&2",
  "  exit /b 1",
  ")",
  "exit /b 0",
  ":onboard",
  "echo Open http://127.0.0.1:8810/ and follow the setup wizard.",
  'if "%ERGO_FAKE_ONBOARD_FAIL%"=="1" exit /b 3',
  "exit /b 0",
  "",
].join("\r\n");

interface FakeInstall {
  r: { code: number; out: string };
  root: string;
  /** 假 ergo 按先后收到的命令 */
  calls: string[];
}

/** 对着假发布站装一遍，发布包里是假的 ergo.cmd。默认流程：不带 -NoAutostart、-NoStart（-NoPath 一直带着，不改真的 PATH） */
async function fakeInstall(options: { args?: string[]; env?: NodeJS.ProcessEnv; task?: { action?: string }; before?: (root: string) => void } = {}): Promise<FakeInstall> {
  const fake = await startFakeDownloads();
  const key = releaseKey();
  for (const [name, body] of fakeRelease("0.3.0", key.secret, fakeVersionZip("0.3.0", { "ergo.cmd": FAKE_ERGO_CMD })).files) fake.put(name, body);
  const dir = tmp();
  const root = path.join(dir, "inst");
  const log = path.join(dir, "ergo-calls.log");
  const taskFile = path.join(dir, "task.json");
  if (options.task) fs.writeFileSync(taskFile, JSON.stringify(options.task));
  fs.mkdirSync(root, { recursive: true });
  options.before?.(root);
  const r = await powershell(["-File", SCRIPT, "-InstallDir", root, "-BaseUrl", `${fake.url}/m1`, "-PublicKey", key.publicLine, "-NoPath", ...(options.args ?? [])], {
    ERGO_INSTALL_NO_AUTOSTART: undefined,
    ERGO_AUTOSTART_TASK_FILE: taskFile,
    ERGO_FAKE_ERGO_LOG: log,
    ...options.env,
  });
  const calls = fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
  return { r, root, calls };
}

describe.runIf(process.platform === "win32")("install.ps1 装好以后的几步（假 ergo、假任务）", () => {
  it("默认流程：先注册开机自启、再 ergo onboard；最后报版本、安装目录、current、自启状态、下一步", async () => {
    const { r, root, calls } = await fakeInstall();
    expectOk(r);
    expect(calls).toEqual(["svc install-autostart", "onboard"]);
    expect(r.out).toContain("Autostart is on:");
    expect(r.out).toContain("ergo svc uninstall-autostart");
    // ergo onboard 的话用的人看得到；lsm 注册时那几行不用看
    expect(r.out).toContain("Open http://127.0.0.1:8810/ and follow the setup wizard.");
    expect(r.out).not.toContain("fake lsm output");
    const lines = r.out.split(/\r?\n/);
    const summary = lines.slice(lines.indexOf("Version: 0.3.0"));
    expect(summary.slice(0, 5)).toEqual(["Version: 0.3.0", `Install folder: ${root}`, "Version in use (current): 0.3.0", "Autostart: on", "Next: ergo open opens the web page; follow the setup wizard there."]);
    expect(summary[5]).toMatch(/^Done\. /);
    expect(fs.readFileSync(path.join(root, "current"), "utf8").trim()).toBe("0.3.0");
  }, 120_000);

  it("-NoAutostart：不注册，照常起二狗，告诉怎么开", async () => {
    const { r, calls } = await fakeInstall({ args: ["-NoAutostart"] });
    expectOk(r);
    expect(calls).toEqual(["onboard"]);
    expect(r.out).toContain("Autostart: off (-NoAutostart); to turn it on: ergo svc install-autostart");
    expect(r.out).not.toContain("Autostart is on:");
  }, 120_000);

  it("-NoStart：注册，不起二狗，下一步写清楚（第一次 ergo start 之后重启才会自动起来）；旧名 -NoOnboard、环境变量一样", async () => {
    const a = await fakeInstall({ args: ["-NoStart"] });
    expectOk(a.r);
    expect(a.calls).toEqual(["svc install-autostart"]);
    expect(a.r.out).toContain("Autostart: on");
    expect(a.r.out).toContain("Next: ergo start brings ergo up, then ergo open and follow the setup wizard. On a first install, a restart brings it up only after ergo start has run once.");
    expect(a.r.out).not.toContain("Running ergo onboard");

    const b = await fakeInstall({ args: ["-NoOnboard"] });
    expectOk(b.r);
    expect(b.calls).toEqual(["svc install-autostart"]);

    const c = await fakeInstall({ env: { ERGO_INSTALL_NO_START: "1", ERGO_INSTALL_NO_AUTOSTART: "1" } });
    expectOk(c.r);
    expect(c.calls).toEqual([]);
    expect(c.r.out).toContain("Autostart: off (-NoAutostart)");
  }, 180_000);

  it("注册任务失败：写清没成、原因、怎么重做；二狗照样起来，退出码 0", async () => {
    const { r, calls } = await fakeInstall({ env: { ERGO_FAKE_SVC_FAIL: "1" } });
    expectOk(r);
    expect(calls).toEqual(["svc install-autostart", "onboard"]);
    expect(r.out).toMatch(/Autostart was not set up: .*fake task refused.*to redo it: ergo svc install-autostart\./);
    expect(r.out).toContain("Autostart: not set up; to redo it: ergo svc install-autostart");
    expect(r.out).toContain("Next: ergo open opens the web page");
    expect(r.out).not.toContain("Installation failed");
  }, 120_000);

  it("二狗没起来：写清没成、怎么重做；自启照样设了，退出码 0", async () => {
    const { r, calls } = await fakeInstall({ env: { ERGO_FAKE_ONBOARD_FAIL: "1" } });
    expectOk(r);
    expect(calls).toEqual(["svc install-autostart", "onboard"]);
    expect(r.out).toContain("ergo did not start (3). The rest goes on; to redo it: ergo start. To see why: ergo logs.");
    expect(r.out).toContain("Autostart: on");
    expect(r.out).toContain("Next: sort out why it did not start (above), then ergo start and ergo open");
    expect(r.out).not.toContain("Installation failed");
  }, 120_000);

  it("命令放不进 bin：其余照常，用版本目录里的 ergo.cmd 接着注册、起二狗，退出码 0", async () => {
    const { r, root, calls } = await fakeInstall({ before: (dir) => fs.writeFileSync(path.join(dir, "bin"), "a file where the folder should go") });
    expectOk(r);
    expect(r.out).toContain("Could not put the ergo command into the bin folder:");
    expect(r.out).toContain(path.join(root, "versions", "0.3.0", "ergo.cmd"));
    expect(calls).toEqual(["svc install-autostart", "onboard"]);
    expect(r.out).toContain("Version in use (current): 0.3.0");
  }, 120_000);

  it("已有的任务指着别处（用的人自己装的服务管家）：不注册、说一声，二狗照常起来；连名字开头一样的目录也不算这个安装", async () => {
    const elsewhere = 'C:\\Windows\\System32\\conhost.exe --headless "D:\\tools\\node.exe" "D:\\code\\repo\\packages\\supervisor\\bin\\lsm.mjs" serve --lifeline --quiet';
    const { r, calls } = await fakeInstall({ task: { action: elsewhere } });
    expectOk(r);
    expect(calls).toEqual(["onboard"]);
    expect(r.out).toContain(`This computer already has the autostart task LocalServiceManager pointing elsewhere; it was left alone: ${elsewhere}.`);
    expect(r.out).toContain("Autostart: the task already on this computer points elsewhere; left alone");

    const dirs2 = await fakeInstall({
      before: (root) => fs.writeFileSync(`${path.dirname(root)}${path.sep}task.json`, JSON.stringify({ action: `"${root}2\\versions\\0.2.0\\app\\packages\\supervisor\\bin\\lsm.mjs" serve` })),
    });
    expectOk(dirs2.r);
    expect(dirs2.calls).toEqual(["onboard"]);
  }, 180_000);

  it("已有的任务指着这个安装（重装、从旧版本接着装）：照常注册，指到新版本", async () => {
    const { r, calls } = await fakeInstall({
      before: (root) => fs.writeFileSync(`${path.dirname(root)}${path.sep}task.json`, JSON.stringify({ action: `"${root}\\versions\\0.2.0\\app\\packages\\supervisor\\bin\\lsm.mjs" serve` })),
    });
    expectOk(r);
    expect(calls).toEqual(["svc install-autostart", "onboard"]);
  }, 120_000);

  it("中文也一样：摘要和提示没有乱码", async () => {
    const dir = tmp();
    const fake = await startFakeDownloads();
    const key = releaseKey();
    for (const [name, body] of fakeRelease("0.3.0", key.secret, fakeVersionZip("0.3.0", { "ergo.cmd": FAKE_ERGO_CMD })).files) fake.put(name, body);
    fake.put("install.ps1", text);
    const r = await powershell(["-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; irm ${fake.url}/m1/install.ps1 | iex`], {
      ERGO_INSTALL_DIR: path.join(dir, "inst"),
      ERGO_RELEASE_URL: `${fake.url}/m1`,
      ERGO_RELEASE_PUBKEY: key.publicLine,
      ERGO_INSTALL_NO_PATH: "1",
      ERGO_INSTALL_NO_AUTOSTART: undefined,
      ERGO_AUTOSTART_TASK_FILE: path.join(dir, "task.json"),
      ERGO_FAKE_ERGO_LOG: path.join(dir, "ergo-calls.log"),
      ERGO_LANGUAGE: "zh",
    });
    expectOk(r);
    expect(r.out).toContain("已设成开机自启：");
    expect(r.out).toContain("开机自启：开着");
    expect(r.out).toContain("版本：0.3.0");
    expect(r.out).toContain("下一步：ergo open 打开网页，走设置向导。");
    expect(fs.readFileSync(path.join(dir, "ergo-calls.log"), "utf8").split(/\r?\n/).filter(Boolean)).toEqual(["svc install-autostart", "onboard"]);
  }, 120_000);
});

describe.runIf(process.platform === "win32")("install.ps1 的下载进度（只跑下载函数）", () => {
  const MB = 1024 * 1024;

  it("输出被重定向：每 10% 一行，不刷屏，内容一个字节不差", async () => {
    const fake = await startFakeDownloads();
    const body = blob(4 * MB);
    fake.put("big.bin", body);
    const dest = path.join(tmp(), "big.bin");
    const r = await powershell(["-File", downloadScript(`Save-Url '${fake.url}/m1/big.bin' '${dest}'`)]);
    expectOk(r);
    expect(fs.readFileSync(dest).equals(body)).toBe(true);
    const shown = progressLines(r.out);
    const percents = shown.map((line) => Number(/^ {2}Downloaded (\d+)% \([\d.]+ \w+ \/ 4\.0 MB, [\d.]+ \w+\/s\)$/.exec(line)?.[1]));
    expect(percents.map((p) => Math.floor(p / 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(percents.at(-1)).toBe(100);
    // 重定向的时候没有 \r 刷新
    expect(r.out.replaceAll("\r\n", "")).not.toContain("\r");
  }, 60_000);

  it("输出被重定向、不给长度：每 10 MB 一行，最后报一次总共多少", async () => {
    const fake = await startFakeDownloads();
    const body = Buffer.alloc(25 * MB, 7);
    fake.put("big.bin", body);
    fake.behave("m1", { kind: "noLength" });
    const dest = path.join(tmp(), "big.bin");
    const r = await powershell(["-File", downloadScript(`Save-Url '${fake.url}/m1/big.bin' '${dest}'`)]);
    expectOk(r);
    expect(fs.statSync(dest).size).toBe(body.length);
    const sizes = progressLines(r.out).map((line) => /^ {2}Downloaded ([\d.]+) MB \([\d.]+ \w+\/s\)$/.exec(line)?.[1]);
    expect(sizes).toEqual([expect.stringMatching(/^10\./), expect.stringMatching(/^20\./), "25.0"]);
  }, 60_000);

  it("窗口里：\\r 刷新同一行，短了也盖得住，下完换行；中文也一样", async () => {
    const fake = await startFakeDownloads();
    const body = blob(MB);
    fake.put("big.bin", body);
    fake.behave("m1", { kind: "slow", bytesPerTick: 128 * 1024, tickMs: 300 });
    const dest = path.join(tmp(), "big.bin");
    const r = await powershell(["-File", downloadScript(`Save-Url '${fake.url}/m1/big.bin' '${dest}'; Say 'AFTER'`, { live: true })]);
    expectOk(r);
    expect(fs.readFileSync(dest).equals(body)).toBe(true);
    const rows = r.out.split(/\r?\n/).filter((row) => row !== "");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe("AFTER");
    const frames = rows[0]!.split("\r").filter((frame) => frame !== "");
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.at(-1)!.trimEnd()).toMatch(/^ {2}Downloaded 100% \(1\.0 MB \/ 1\.0 MB, [\d.]+ \w+\/s\)$/);
    // 每一帧都不比上一帧短：上一帧的尾巴不会露出来
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.length).toBeGreaterThanOrEqual(frames[i - 1]!.length);

    const zh = await powershell(
      ["-File", downloadScript(`[Console]::OutputEncoding = [Text.Encoding]::UTF8; Save-Url '${fake.url}/m1/big.bin' '${dest}'`, { live: true })],
      { ERGO_LANGUAGE: "zh" },
    );
    expectOk(zh);
    expect(zh.out).toMatch(/\r {2}已下载 100%（1\.0 MB \/ 1\.0 MB，[\d.]+ \w+\/s）/);
  }, 60_000);

  it("窗口里下载断了：先换行再报错（错误不会接在进度后面），不留半截文件", async () => {
    const fake = await startFakeDownloads();
    fake.put("big.bin", blob(MB));
    fake.behave("m1", { kind: "slow", bytesPerTick: 16 * 1024, tickMs: 100 });
    const dest = path.join(tmp(), "big.bin");
    const running = powershell(["-File", downloadScript(`try { Save-Url '${fake.url}/m1/big.bin' '${dest}' } catch { Say "FAILED: $($_.Exception.Message)" }`, { live: true })]);
    // 等它画出至少一帧再断（全部下完要 6 秒多）
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1), { timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fake.releaseAll();
    const r = await running;
    expectOk(r);
    expect(r.out).toMatch(/\r {2}Downloaded \d+%[^\n]*\r?\nFAILED: The connection dropped: got /);
    expect(fs.existsSync(dest)).toBe(false);
  }, 60_000);

  it("地址是本机路径也照样下（-BaseUrl 可以给文件夹，原来的 WebClient 就认）", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "local.bin"), "local file");
    const dest = path.join(dir, "copy.bin");
    const r = await powershell(["-File", downloadScript(`Save-Url '${dir}\\local.bin' '${dest}'`)]);
    expectOk(r);
    expect(fs.readFileSync(dest, "utf8")).toBe("local file");
    expect(progressLines(r.out)).toEqual([expect.stringMatching(/^ {2}Downloaded 100% \(10 B \/ 10 B, /)]);
  }, 60_000);
});

describe.runIf(process.platform === "win32")("真的计划任务", () => {
  // 用例按写的顺序跑，这是最后一个：上面所有用例都跑完了才比。任务不存在的电脑两边都是空串
  it("跑完这个文件，这台电脑上的 LocalServiceManager 一个字没变", () => {
    expect(realAutostartTaskDefinition()).toBe(realTaskBefore);
  }, 60_000);
});
