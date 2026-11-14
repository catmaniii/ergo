// 466：找 ego 浏览器（ego lite 的 ego-browser 命令）——配置 → 守护进程的 PATH → 用户 PATH（注册表）→ 默认位置；
// 没找到的不一直记着（后来装上的下次能找到），找到的记住、只看文件还在不在；版本从路径上看（不跑 ego-browser）。
// 全用假的文件系统、假的注册表：结果不看这台机器装没装 ego。
import { describe, expect, it } from "vitest";
import { createEgoBrowserLocator, type EgoBrowserProbe, egoDefaultCandidates, expandWindowsVars, findEgoBrowser, egoVersionFromPath, pathDirs } from "../../src/web/index.ts";

const HOME = "C:\\Users\\u";
const DEFAULT_EXE = "C:\\Users\\u\\.local\\share\\ego\\active_version_dir\\ego-browser.exe";

/** 假的文件系统和注册表：files 里的算存在（Windows 上不分大小写）；userPath 现取 */
function probe(input: { files?: string[]; path?: string; userPath?: string; configured?: string; platform?: NodeJS.Platform; dirs?: Record<string, string[]> } = {}) {
  const files = new Set((input.files ?? []).map((f) => f.toLowerCase()));
  const calls = { userPath: 0 };
  const p: EgoBrowserProbe & { files: Set<string>; user: string | undefined } = {
    platform: input.platform ?? "win32",
    env: { Path: input.path ?? "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd", USERPROFILE: HOME },
    homeDir: input.platform === "darwin" ? "/Users/u" : HOME,
    configured: input.configured,
    files,
    user: input.userPath,
    isFile: (file) => files.has(file.toLowerCase()),
    readDir: (dir) => input.dirs?.[dir] ?? [],
    userPath() {
      calls.userPath++;
      return p.user;
    },
  };
  return { probe: p, calls };
}

describe("找 ego-browser：按顺序，第一个存在的", () => {
  it("配置里写的最优先；写了但不在：记一条日志，接着按后面的找", () => {
    const configured = "D:\\ego\\ego-browser.exe";
    expect(findEgoBrowser(probe({ configured, files: [configured, DEFAULT_EXE] }).probe)).toEqual({ path: configured, dir: "D:\\ego", source: "config" });
    const log: string[] = [];
    expect(findEgoBrowser(probe({ configured, files: [DEFAULT_EXE] }).probe, (l) => log.push(l))).toMatchObject({ path: DEFAULT_EXE, source: "default" });
    expect(log).toEqual([`配置里写的 web.egoBrowserPath 不在：${configured}，接着按 PATH、默认位置找`]);
  });

  it("守护进程的 PATH（引号、空项照认）在用户 PATH、默认位置前面", () => {
    const inPath = "D:\\tools\\ego\\ego-browser.exe";
    const { probe: p, calls } = probe({ path: 'C:\\Windows;;"D:\\tools\\ego";C:\\other', files: [inPath, DEFAULT_EXE], userPath: "C:\\x" });
    expect(findEgoBrowser(p)).toEqual({ path: inPath, dir: "D:\\tools\\ego", source: "path" });
    // 守护进程的 PATH 里找到了就不读注册表
    expect(calls.userPath).toBe(0);
  });

  it("用户 PATH（注册表 HKCU\\Environment 的原样值）：展开 %变量%，斜杠混着写的也认；在默认位置前面", () => {
    // ego lite 首次引导加进去的就是这种混着斜杠的写法
    const user = "%USERPROFILE%\\.local/share/ego\\active_version_dir;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps";
    const found = findEgoBrowser(probe({ userPath: user, files: [DEFAULT_EXE] }).probe);
    expect(found).toMatchObject({ source: "user-path" });
    expect(found!.path.toLowerCase()).toBe(DEFAULT_EXE.toLowerCase());
    expect(expandWindowsVars("%userprofile%\\a;%NOPE%\\b", { USERPROFILE: HOME })).toBe("C:\\Users\\u\\a;%NOPE%\\b");
  });

  it("默认位置：Windows 是 ~\\.local\\share\\ego\\active_version_dir\\ego-browser.exe；macOS 是 ~/.local/bin，再是 ego lite.app 里的 Helpers；都没有是 undefined", () => {
    expect(findEgoBrowser(probe({ files: [DEFAULT_EXE] }).probe)).toEqual({ path: DEFAULT_EXE, dir: "C:\\Users\\u\\.local\\share\\ego\\active_version_dir", source: "default" });
    expect(findEgoBrowser(probe().probe)).toBeUndefined();
    const helper = "/Applications/ego lite.app/Contents/Frameworks/ego lite Framework.framework/Versions/Current/Helpers/ego-browser";
    const mac = probe({ platform: "darwin", path: "/usr/bin:/bin", files: [helper], dirs: { "/Applications/ego lite.app/Contents/Frameworks": ["ego lite Framework.framework", "Other.bundle"] } });
    expect(egoDefaultCandidates(mac.probe)).toEqual(["/Users/u/.local/bin/ego-browser", helper]);
    expect(findEgoBrowser(mac.probe)).toEqual({ path: helper, dir: helper.slice(0, -"/ego-browser".length), source: "default" });
    mac.probe.files.add("/users/u/.local/bin/ego-browser");
    expect(findEgoBrowser(mac.probe)).toMatchObject({ path: "/Users/u/.local/bin/ego-browser" });
    expect(egoDefaultCandidates({ platform: "linux", homeDir: "/home/u", readDir: () => [] })).toEqual([]);
    expect(pathDirs("/a:/b::/c", "darwin")).toEqual(["/a", "/b", "/c"]);
  });
});

describe("探测要便宜、后来装上的要找得到", () => {
  it("没找到只记一会儿（这期间不重复读注册表）；过了再找，装上了就找到；找到的记住，文件没了重新找", () => {
    let now = 0;
    const log: string[] = [];
    const { probe: p, calls } = probe();
    const locator = createEgoBrowserLocator(p, { log: (l) => log.push(l), now: () => now, missTtlMs: 30_000 });
    expect(locator.find()).toBeUndefined();
    expect(locator.find()).toBeUndefined();
    expect(calls.userPath).toBe(1);
    expect(log).toEqual(['没找到 ego 浏览器（ego-browser）：agent 用不了它，联网工具的说明里写"没装"；装上之后下次拉起 agent 会重新找']);
    // 用户装好、走完首次引导：用户 PATH 里有了
    p.user = "%USERPROFILE%\\.local\\share\\ego\\active_version_dir";
    p.files.add(DEFAULT_EXE.toLowerCase());
    now = 29_999;
    expect(locator.find()).toBeUndefined();
    now = 30_000;
    expect(locator.find()).toMatchObject({ source: "user-path" });
    expect(calls.userPath).toBe(2);
    expect(log.at(-1)).toMatch(/^ego 浏览器用 .*ego-browser\.exe（用户 PATH）：拉起 agent 时把这个目录放到 PATH 最前面$/);
    // 找到了：之后只看文件还在不在，不再读注册表、不再记日志
    now = 999_999;
    expect(locator.find()).toMatchObject({ source: "user-path" });
    expect(calls.userPath).toBe(2);
    expect(log).toHaveLength(2);
    // 卸了：重新找、没找到再记一条
    p.files.clear();
    p.user = undefined;
    expect(locator.find()).toBeUndefined();
    expect(log).toHaveLength(3);
  });
});

describe("ego lite 的版本：从路径上看，不跑 ego-browser", () => {
  it("找到的目录解开链接后的最后一段像版本号（数字加点）就是版本；不像、解不开是 undefined", () => {
    const dir = "C:\\Users\\u\\.local\\share\\ego\\active_version_dir";
    const linkedTo = (target: string) => (p: string) => (p === dir ? target : p);
    expect(egoVersionFromPath({ dir }, linkedTo("C:\\Program Files\\Citro Labs\\ego lite\\Application\\0.6.3.14"))).toBe("0.6.3.14");
    expect(egoVersionFromPath({ dir }, linkedTo("C:\\Program Files\\Citro Labs\\ego lite\\Application\\0.7.0.1\\"))).toBe("0.7.0.1");
    // macOS：ego lite.app 里的 Helpers，最后一段不是版本
    expect(egoVersionFromPath({ dir: "/Applications/ego lite.app/Contents/Frameworks/x.framework/Versions/Current/Helpers" }, (p) => p)).toBeUndefined();
    // 装在别处、没有链接
    expect(egoVersionFromPath({ dir: "D:\\tools\\ego" }, (p) => p)).toBeUndefined();
    expect(egoVersionFromPath({ dir: "D:\\tools\\ego-0.6" }, (p) => p)).toBeUndefined();
    expect(egoVersionFromPath({ dir: "D:\\tools\\6" }, (p) => p)).toBeUndefined();
    expect(
      egoVersionFromPath({ dir }, () => {
        throw new Error("ENOENT");
      }),
    ).toBeUndefined();
  });
});

