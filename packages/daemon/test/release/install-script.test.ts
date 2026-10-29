// 一行命令安装（318 号票，installer/install.ps1）：
//   - 文件只有 ASCII（irm | iex 不认 BOM、-File 按 ANSI 读），中文句子写成 \uXXXX；中英两份句子一一对应、参数一样，没有"秘书""待我处理"；
//   - 里面那段 C#（Ed25519 + BLAKE2b 验 minisign 签名、解 npm 的 tgz）和 Node 那一份互相认；
//   - 对着本机的假发布站整个装一遍（-File 和 irm | iex 两种）：验签、解开、current 联接、bin、install.json；签名不对、Node 版本没测过的不装。
// 不改真的 PATH（-NoPath / ERGO_INSTALL_NO_PATH），不跑 onboard。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sign } from "../../src/release/minisign.ts";
import { makeTar, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { fakeRelease, releaseKey } from "../helpers/fake-release.ts";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "installer", "install.ps1");
const text = fs.readFileSync(SCRIPT, "utf8");
const BACKSLASH = String.fromCharCode(92);

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

/** 跑 PowerShell（异步：假发布站就在这个进程里，同步地等会把它卡住） */
function powershell(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
      windowsHide: true,
      env: { ...process.env, ERGO_LANGUAGE: "en", ...env },
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
    expect(fs.readFileSync(path.join(root, "current"), "utf8").trim()).toBe("0.3.0");
  }, 180_000);
});
