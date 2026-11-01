// 手机安装包：npm run release 收现成的、给参数构建、没工具链跳过并写明原因；不合格的产物不收；
// 收到的写进 SHA256SUMS、被一起签，ergo update 只看 Windows 包，latest.json 不提它们。这里不跑工具链。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_CERT_SHA256 } from "../../../../frontend/scripts/android.ts";
import { ANDROID_PACKAGE, collectMobilePackages, HARMONY_PACKAGE, type MobileTools } from "../../build/mobile.ts";
import { writeSums } from "../../build/release.ts";
import { parseSums, type ReleaseIndex, verifyRelease } from "../../src/release/fetch.ts";
import { releaseKey } from "../helpers/fake-release.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-mobile-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (body: string) => crypto.createHash("sha256").update(body).digest("hex");
const apkOf = (repo: string) => path.join(repo, "frontend/android/app/build/outputs/apk/debug/app-debug.apk");
const hapOf = (repo: string) => path.join(repo, "frontend/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap");
const profileOf = (repo: string) => path.join(repo, "frontend/harmony/entry/build/default/generated/profile/default/BuildProfile.ets");

function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** 假仓库：现成的 APK、HAP 都有（WebView 调试关着） */
function repoWithOutputs(): string {
  const repo = tmp();
  put(apkOf(repo), "apk body");
  put(hapOf(repo), "hap body");
  put(profileOf(repo), "export const DEBUG = true;\nexport const WEBVIEW_DEBUG = false;\n");
  return repo;
}

/** 假工具：工具链都有、钥匙也有、APK 是发布钥匙签的。builds 记跑过哪些构建脚本 */
function fakeTools(over: Partial<MobileTools> = {}): MobileTools & { builds: string[] } {
  const builds: string[] = [];
  return {
    builds,
    android: () => ({ javaHome: "jdk", sdk: "sdk" }),
    keystore: () => "ks",
    harmony: () => ({}),
    build: (_repo, script) => void builds.push(script),
    apkCert: () => RELEASE_CERT_SHA256,
    ...over,
  };
}

const boom = () => {
  throw new Error("不该碰工具");
};

describe("收手机安装包", () => {
  it("有现成产物就收：文件名不带版本号，大小、哈希对得上，不重新构建", async () => {
    const repo = repoWithOutputs();
    const out = tmp();
    const tools = fakeTools();
    const log: string[] = [];
    const result = await collectMobilePackages({ repo, out, log: (l) => log.push(l) }, tools);
    expect(result.skipped).toEqual([]);
    expect(result.packages.map((p) => p.name)).toEqual([ANDROID_PACKAGE, HARMONY_PACKAGE]);
    expect(ANDROID_PACKAGE).toBe("ergo-android-debug.apk");
    expect(HARMONY_PACKAGE).toBe("ergo-harmony-unsigned.hap");
    expect(result.packages[0]).toMatchObject({ sha256: sha("apk body"), size: 8 });
    expect(result.packages[1]).toMatchObject({ sha256: sha("hap body"), size: 8 });
    expect(fs.readFileSync(path.join(out, ANDROID_PACKAGE), "utf8")).toBe("apk body");
    expect(tools.builds).toEqual([]);
    expect(log.join("\n")).toContain(sha("apk body"));
  });

  it("没有产物：跳过，写明跳过了什么、怎么办；发布目录里上一次留下的旧文件删掉，免得把旧的发出去", async () => {
    const repo = tmp();
    const out = tmp();
    put(path.join(out, ANDROID_PACKAGE), "old");
    put(path.join(out, HARMONY_PACKAGE), "old");
    const log: string[] = [];
    const result = await collectMobilePackages({ repo, out, log: (l) => log.push(l) }, fakeTools());
    expect(result.packages).toEqual([]);
    expect(result.skipped.map((s) => s.name)).toEqual([ANDROID_PACKAGE, HARMONY_PACKAGE]);
    for (const s of result.skipped) expect(s.reason).toContain("--build-mobile");
    expect(fs.readdirSync(out)).toEqual([]);
    expect(log.join("\n")).toContain(`跳过手机包 ${ANDROID_PACKAGE}`);
    expect(log.join("\n")).toContain(`跳过手机包 ${HARMONY_PACKAGE}`);
  });

  it("--no-mobile：都不带，工具也不碰", async () => {
    const repo = repoWithOutputs();
    const out = tmp();
    const result = await collectMobilePackages({ repo, out, none: true }, fakeTools({ android: boom, harmony: boom, apkCert: boom }));
    expect(result.packages).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["--no-mobile", "--no-mobile"]);
  });

  it("--build-mobile：先构建再收", async () => {
    const repo = repoWithOutputs();
    const tools = fakeTools();
    const result = await collectMobilePackages({ repo, out: tmp(), build: true }, tools);
    expect(tools.builds).toEqual(["build-android.ts", "build-harmony.ts"]);
    expect(result.packages).toHaveLength(2);
  });

  it("--build-mobile 但没工具链：不构建，跳过这一个并说明原因，另一个照收", async () => {
    const repo = repoWithOutputs();
    const noAndroid = fakeTools({ android: () => ({ error: "找不到 Android SDK" }) });
    const a = await collectMobilePackages({ repo, out: tmp(), build: true }, noAndroid);
    expect(noAndroid.builds).toEqual(["build-harmony.ts"]);
    expect(a.packages.map((p) => p.name)).toEqual([HARMONY_PACKAGE]);
    expect(a.skipped).toEqual([{ name: ANDROID_PACKAGE, reason: expect.stringContaining("找不到 Android SDK") }]);

    const noHarmony = fakeTools({ harmony: () => ({ error: "找不到 DevEco Studio" }) });
    const b = await collectMobilePackages({ repo, out: tmp(), build: true }, noHarmony);
    expect(noHarmony.builds).toEqual(["build-android.ts"]);
    expect(b.packages.map((p) => p.name)).toEqual([ANDROID_PACKAGE]);
    expect(b.skipped).toEqual([{ name: HARMONY_PACKAGE, reason: expect.stringContaining("找不到 DevEco Studio") }]);
  });

  it("工具链齐了却构建失败：算出错，不悄悄发一个不带手机包的版本", async () => {
    const tools = fakeTools({
      build: () => {
        throw new Error("build-android.ts 失败");
      },
    });
    await expect(collectMobilePackages({ repo: repoWithOutputs(), out: tmp(), build: true }, tools)).rejects.toThrow("build-android.ts 失败");
  });

  it("--build-mobile 但没有发布用的调试钥匙：不构建安卓，默认调试签名的包不发", async () => {
    const tools = fakeTools({ keystore: () => undefined });
    const result = await collectMobilePackages({ repo: repoWithOutputs(), out: tmp(), build: true }, tools);
    expect(tools.builds).toEqual(["build-harmony.ts"]);
    expect(result.skipped).toEqual([{ name: ANDROID_PACKAGE, reason: expect.stringContaining("调试钥匙") }]);
  });

  it("现成的 APK 不是发布钥匙签的：不收（默认调试签名、开了 WebView 调试的包都是这样），写明证书", async () => {
    const out = tmp();
    const other = "0".repeat(64);
    const result = await collectMobilePackages({ repo: repoWithOutputs(), out }, fakeTools({ apkCert: () => other }));
    expect(result.packages.map((p) => p.name)).toEqual([HARMONY_PACKAGE]);
    expect(result.skipped).toEqual([{ name: ANDROID_PACKAGE, reason: expect.stringContaining(other) }]);
    expect(fs.existsSync(path.join(out, ANDROID_PACKAGE))).toBe(false);
  });

  it("没工具链时现成的 APK 也不收：核对不了签名，就不当它是对的", async () => {
    const result = await collectMobilePackages({ repo: repoWithOutputs(), out: tmp() }, fakeTools({ android: () => ({ error: "找不到 JDK" }) }));
    expect(result.skipped).toEqual([{ name: ANDROID_PACKAGE, reason: expect.stringContaining("核对不了") }]);
  });

  it("apksigner 验不过（包坏了、SDK 缺 build-tools）：跳过这一个，不打断 Windows 包", async () => {
    const tools = fakeTools({
      apkCert: () => {
        throw new Error("DOES NOT VERIFY");
      },
    });
    const result = await collectMobilePackages({ repo: repoWithOutputs(), out: tmp() }, tools);
    expect(result.skipped).toEqual([{ name: ANDROID_PACKAGE, reason: expect.stringContaining("DOES NOT VERIFY") }]);
  });

  it("现成的 HAP 开着 WebView 调试，或者看不出开没开：不收", async () => {
    const debugRepo = repoWithOutputs();
    put(profileOf(debugRepo), "export const WEBVIEW_DEBUG = true;\n");
    const on = await collectMobilePackages({ repo: debugRepo, out: tmp() }, fakeTools());
    expect(on.skipped).toEqual([{ name: HARMONY_PACKAGE, reason: expect.stringContaining("开着 WebView 调试") }]);

    const unknownRepo = repoWithOutputs();
    fs.rmSync(profileOf(unknownRepo));
    const unknown = await collectMobilePackages({ repo: unknownRepo, out: tmp() }, fakeTools());
    expect(unknown.skipped).toEqual([{ name: HARMONY_PACKAGE, reason: expect.stringContaining("看不出") }]);
  });
});

describe("校验值清单和更新", () => {
  const zipBody = "windows zip";
  const zipName = "ergo-0.1.0-win-x64.zip";
  const index: ReleaseIndex = { format: 1, version: "0.1.0", node: "22.23.4", nodeTested: ["22.23.4"], files: { zip: zipName, sums: "SHA256SUMS", signature: "SHA256SUMS.minisig" } };

  it("两个手机包都在清单里、被一起签；ergo update 验 Windows 包照常过，多出来的行不带歪它", async () => {
    const key = releaseKey();
    const out = tmp();
    fs.writeFileSync(path.join(out, zipName), zipBody);
    const { packages } = await collectMobilePackages({ repo: repoWithOutputs(), out }, fakeTools());
    const written = writeSums(out, { name: zipName, sha256: sha(zipBody) }, packages, key.secret, "0.1.0");
    expect(written.signature).toBe(path.join(out, "SHA256SUMS.minisig"));
    const sums = parseSums(fs.readFileSync(written.sums, "utf8"));
    expect(Object.fromEntries(sums)).toEqual({ [zipName]: sha(zipBody), [ANDROID_PACKAGE]: sha("apk body"), [HARMONY_PACKAGE]: sha("hap body") });
    expect(await verifyRelease(out, index, key.secret)).toMatchObject({ ok: true, zip: path.join(out, zipName) });
    // 手机包被换了，清单改过就验不过签名：手机包的哈希也在签名保护下
    fs.appendFileSync(written.sums, `${"0".repeat(64)}  ${ANDROID_PACKAGE}\n`);
    expect(await verifyRelease(out, index, key.secret)).toMatchObject({ ok: false, reason: expect.stringContaining("签名验不过") });
  });

  it("没给钥匙：清单照写，不留上一次的签名", async () => {
    const out = tmp();
    fs.writeFileSync(path.join(out, "SHA256SUMS.minisig"), "old");
    const written = writeSums(out, { name: zipName, sha256: sha(zipBody) }, [], undefined, "0.1.0");
    expect(written.signature).toBeUndefined();
    expect(fs.existsSync(path.join(out, "SHA256SUMS.minisig"))).toBe(false);
    expect([...parseSums(fs.readFileSync(written.sums, "utf8")).keys()]).toEqual([zipName]);
  });
});
