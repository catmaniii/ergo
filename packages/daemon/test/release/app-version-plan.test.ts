// 手机 App 自己一个版本号：--build-mobile 按它决定编不编（临时 git 仓库，不真的编译 App）。
// 代码变了版本号没升报错退出；没变用 downloads/ 里现成的、SHA256 照算；升了才编译，并提示更新 downloads/。
// 打包结束的一行：MIN_APP_VERSION 比上一个发布高了才说要升级。
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appUpgradeLine, mobilePlan, type MobilePlan, staleMessage } from "../../build/app-version.ts";
import { ANDROID_PACKAGE, collectMobilePackages, HARMONY_PACKAGE, type MobileTools } from "../../build/mobile.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-app-version-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function put(repo: string, file: string, body: string): void {
  const full = path.join(repo, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" });
}

const commit = (repo: string, message = "改动") => {
  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
};

const setVersion = (repo: string, version: string) => put(repo, "frontend/app-version.json", JSON.stringify({ version, code: 1 }));
const setDownloads = (repo: string, version: string) => put(repo, "downloads/README.md", `# 手机安装包\n\n版本 / Version: ${version}\n`);
const setMin = (repo: string, version: string) => put(repo, "packages/protocol/src/app-version.ts", `export const MIN_APP_VERSION = "${version}";\n`);

/** 假仓库：App 版本 0.4.2，downloads/ 里也是 0.4.2，都提交了 */
function repoAt(version = "0.4.2"): string {
  const repo = tmp();
  git(repo, "init", "-q");
  setVersion(repo, version);
  setDownloads(repo, version);
  setMin(repo, "0.4.1");
  put(repo, `downloads/${ANDROID_PACKAGE}`, "apk in downloads");
  put(repo, `downloads/${HARMONY_PACKAGE}`, "hap in downloads");
  put(repo, "frontend/harmony/entry/Index.ets", "壳");
  put(repo, "frontend/android/app/Main.kt", "壳");
  put(repo, "frontend/test/x.test.ts", "测试");
  put(repo, "frontend/android/e2e/run.ts", "联调");
  put(repo, "frontend/README.md", "说明");
  put(repo, "packages/web/src/page-bridge/bridge.ts", "页面桥");
  put(repo, "packages/web/src/pages/Page.tsx", "页面");
  commit(repo, "第一版");
  return repo;
}

/** 假工具：工具链都有；plan 走真的（查临时 git 仓库）；builds 记跑过哪些构建脚本，跑的时候写出产物 */
function fakeTools(repo: string): MobileTools & { builds: string[] } {
  const builds: string[] = [];
  return {
    builds,
    plan: mobilePlan,
    android: () => ({ javaHome: "jdk", sdk: "sdk" }),
    keystore: () => "ks",
    harmony: () => ({}),
    build(_repo, script) {
      builds.push(script);
      if (script === "build-android.ts") put(repo, "frontend/android/app/build/outputs/apk/debug/app-debug.apk", "apk built");
      else {
        put(repo, "frontend/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap", "hap built");
        put(repo, "frontend/harmony/entry/build/default/generated/profile/default/BuildProfile.ets", "export const WEBVIEW_DEBUG = false;\n");
      }
    },
    apkCert: () => {
      throw new Error("没编译时不该核对签名");
    },
  };
}

const sha = (body: string) => crypto.createHash("sha256").update(body).digest("hex");

describe("这次打包该怎么办", () => {
  it("版本号和 App 代码都没变：不编译", () => {
    expect(mobilePlan(repoAt())).toEqual({ kind: "unchanged", version: "0.4.2" });
  });

  it("只动了电脑版的页面：不算 App 变了", () => {
    const repo = repoAt();
    put(repo, "packages/web/src/pages/Page.tsx", "新页面");
    commit(repo);
    expect(mobilePlan(repo).kind).toBe("unchanged");
  });

  it("frontend/ 下不进 App 的（测试、模拟器联调、说明）：不算 App 变了", () => {
    const repo = repoAt();
    put(repo, "frontend/test/x.test.ts", "新测试");
    put(repo, "frontend/android/e2e/run.ts", "新联调");
    put(repo, "frontend/README.md", "新说明");
    commit(repo);
    expect(mobilePlan(repo).kind).toBe("unchanged");
  });

  it.each([
    ["原生代码", "frontend/harmony/entry/Index.ets"],
    ["安卓代码", "frontend/android/app/Main.kt"],
    ["内置浏览器的页面脚本（打包进 App）", "packages/web/src/page-bridge/bridge.ts"],
  ])("提交了 %s 的改动、版本号没升：不能发", (_name, file) => {
    const repo = repoAt();
    put(repo, file, "改了");
    commit(repo);
    expect(mobilePlan(repo)).toMatchObject({ kind: "stale", version: "0.4.2", changed: [file] });
  });

  it("还没提交的改动、新加的文件也算", () => {
    const repo = repoAt();
    put(repo, "frontend/android/app/Main.kt", "改了没提交");
    put(repo, "packages/web/src/page-bridge/new.ts", "新文件");
    expect(mobilePlan(repo)).toMatchObject({ kind: "stale", changed: ["frontend/android/app/Main.kt", "packages/web/src/page-bridge/new.ts"] });
  });

  it("升了版本号：要编译，不管提交没有；升版本那次连带改的代码不算没升", () => {
    const repo = repoAt();
    put(repo, "frontend/android/app/Main.kt", "改了");
    setVersion(repo, "0.4.3");
    expect(mobilePlan(repo)).toEqual({ kind: "bumped", version: "0.4.3", packaged: "0.4.2" });
    commit(repo);
    expect(mobilePlan(repo)).toEqual({ kind: "bumped", version: "0.4.3", packaged: "0.4.2" });
  });

  it("包放进 downloads/、README 改好了提交：回到没变；之后再改 App 代码又不能发", () => {
    const repo = repoAt();
    setVersion(repo, "0.4.3");
    commit(repo, "升版本");
    setDownloads(repo, "0.4.3");
    put(repo, `downloads/${ANDROID_PACKAGE}`, "新的 apk");
    commit(repo, "手机安装包更新");
    expect(mobilePlan(repo)).toEqual({ kind: "unchanged", version: "0.4.3" });
    put(repo, "frontend/harmony/entry/Index.ets", "又改了");
    commit(repo);
    expect(mobilePlan(repo).kind).toBe("stale");
  });

  it("不是 git 仓库：说清楚为什么要 git", () => {
    const repo = tmp();
    setVersion(repo, "0.4.2");
    setDownloads(repo, "0.4.2");
    expect(() => mobilePlan(repo)).toThrow("--build-mobile 要查 git");
  });

  it("错误信息写明要升 App 版本和变了哪些文件", () => {
    const plan: Extract<MobilePlan, { kind: "stale" }> = { kind: "stale", version: "0.4.2", since: "abcd1234", changed: ["frontend/a.ets"] };
    expect(staleMessage(plan)).toContain("要升 App 版本");
    expect(staleMessage(plan)).toContain("frontend/a.ets");
    expect(staleMessage(plan)).toContain("0.4.2");
  });
});

describe("--build-mobile 收手机包", () => {
  it("代码变了版本号没升：报错退出，什么都不编、不收", async () => {
    const repo = repoAt();
    put(repo, "frontend/android/app/Main.kt", "改了");
    commit(repo);
    const tools = fakeTools(repo);
    const out = tmp();
    await expect(collectMobilePackages({ repo, out, build: true }, tools)).rejects.toThrow("要升 App 版本");
    expect(tools.builds).toEqual([]);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it("没变：不编译，也不要工具链，直接用 downloads/ 里现成的，SHA256 照算", async () => {
    const repo = repoAt();
    const noTools: MobileTools = {
      plan: mobilePlan,
      android: () => ({ error: "这台机器没有" }),
      keystore: () => undefined,
      harmony: () => ({ error: "这台机器没有" }),
      build: () => {
        throw new Error("不该编译");
      },
      apkCert: () => {
        throw new Error("不该核对");
      },
    };
    const out = tmp();
    const log: string[] = [];
    const result = await collectMobilePackages({ repo, out, build: true, log: (l) => log.push(l) }, noTools);
    expect(result.skipped).toEqual([]);
    expect(result.packages).toMatchObject([
      { name: ANDROID_PACKAGE, sha256: sha("apk in downloads") },
      { name: HARMONY_PACKAGE, sha256: sha("hap in downloads") },
    ]);
    expect(fs.readFileSync(path.join(out, ANDROID_PACKAGE), "utf8")).toBe("apk in downloads");
    expect(log.join("\n")).toContain("不编译");
  });

  it("没变、但 downloads/ 里少一个：跳过这一个并写明，不编译", async () => {
    const repo = repoAt();
    fs.rmSync(path.join(repo, "downloads", HARMONY_PACKAGE));
    git(repo, "rm", "-q", "--cached", `downloads/${HARMONY_PACKAGE}`);
    const tools = fakeTools(repo);
    const result = await collectMobilePackages({ repo, out: tmp(), build: true }, tools);
    expect(tools.builds).toEqual([]);
    expect(result.packages.map((p) => p.name)).toEqual([ANDROID_PACKAGE]);
    expect(result.skipped).toEqual([{ name: HARMONY_PACKAGE, reason: expect.stringContaining("downloads/") }]);
  });

  it("升了版本：编译，收新编出来的，提示更新 downloads/", async () => {
    const repo = repoAt();
    setVersion(repo, "0.4.3");
    commit(repo);
    const tools = { ...fakeTools(repo), apkCert: () => "e".repeat(64) };
    const log: string[] = [];
    const result = await collectMobilePackages({ repo, out: tmp(), build: true, log: (l) => log.push(l) }, tools);
    expect(tools.builds).toEqual(["build-android.ts", "build-harmony.ts"]);
    expect(result.packages.map((p) => p.name)).toEqual([HARMONY_PACKAGE]);
    expect(result.packages[0]).toMatchObject({ sha256: sha("hap built") });
    expect(log.join("\n")).toContain("手机 App 升到了 0.4.3（downloads/ 里还是 0.4.2）");
    expect(log.join("\n")).toContain("downloads/README.md");
  });

  it("不带 --build-mobile、--no-mobile：照旧，不看 App 版本", async () => {
    const repo = repoAt();
    put(repo, "frontend/android/app/Main.kt", "改了");
    commit(repo);
    const tools = { ...fakeTools(repo), plan: (): MobilePlan => { throw new Error("不该看"); } };
    await expect(collectMobilePackages({ repo, out: tmp(), none: true }, tools)).resolves.toMatchObject({ packages: [] });
    await expect(collectMobilePackages({ repo, out: tmp() }, { ...tools, android: () => ({ error: "没有" }) })).resolves.toMatchObject({ packages: [] });
  });
});

/** 假仓库，上一个发布是 v0.4.2 */
function tagged(): string {
  const repo = repoAt();
  git(repo, "tag", "v0.4.2");
  return repo;
}

describe("打包结束的一行", () => {
  it("最低版本没变：不用升级", () => {
    expect(appUpgradeLine(tagged(), "0.4.3")).toBe("手机 App：不用升级");
  });

  it("最低版本比上一个发布高了：需要升级到它", () => {
    const repo = tagged();
    setMin(repo, "0.5.0");
    commit(repo);
    expect(appUpgradeLine(repo, "0.5.0")).toBe("手机 App：需要升级到 0.5.0");
  });

  it("按数字段比：0.10.0 比 0.9.0 高", () => {
    const repo = repoAt();
    setMin(repo, "0.9.0");
    commit(repo);
    git(repo, "tag", "v0.9.0");
    setMin(repo, "0.10.0");
    commit(repo);
    expect(appUpgradeLine(repo, "0.10.0")).toBe("手机 App：需要升级到 0.10.0");
  });

  it("打这次的标签之后再打包：比的还是上一个发布，不是这次自己", () => {
    const repo = tagged();
    setMin(repo, "0.5.0");
    commit(repo);
    git(repo, "tag", "v0.5.0");
    expect(appUpgradeLine(repo, "0.5.0")).toBe("手机 App：需要升级到 0.5.0");
  });

  it("上一个发布还没有这个常量、没有上一个发布：算没变", () => {
    const repo = tmp();
    git(repo, "init", "-q");
    put(repo, "README.md", "很早以前");
    commit(repo);
    git(repo, "tag", "v0.1.0");
    setMin(repo, "0.4.1");
    commit(repo);
    expect(appUpgradeLine(repo, "0.4.3")).toBe("手机 App：不用升级");
    expect(appUpgradeLine(repoAt(), "0.4.3")).toBe("手机 App：不用升级");
  });

  it("不是 git 仓库：照样打这一行，包都打好了，不为它失败", () => {
    const repo = tmp();
    setMin(repo, "0.4.1");
    expect(appUpgradeLine(repo, "0.4.3")).toBe("手机 App：不用升级");
  });
});
