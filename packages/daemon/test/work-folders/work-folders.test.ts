// 新建时选工作文件夹（305 号票，work-folders/）：核对已有的文件夹（绝对路径、在、是文件夹、不在不许用的地方）、默认文件夹的存取、
// 新建时定工作目录（不能选的运行时照旧；新开的按标题起名、不合法的字符换掉、重名加序号；默认文件夹不在了的写明）。
import fs from "node:fs";
import path from "node:path";
import { workFolderName } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { RequestRejected } from "../../src/errors.ts";
import { createWorkFolders } from "../../src/work-folders/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const real = (p: string) => fs.realpathSync.native(p);

function setup() {
  const config = makeTempDir("ergo-wf-config-");
  const data = makeTempDir("ergo-wf-data-");
  const program = makeTempDir("ergo-wf-program-");
  const work = makeTempDir("ergo-wf-work-");
  const file = path.join(config, "work-folders.json");
  const logs: string[] = [];
  const make = () =>
    createWorkFolders({
      file,
      forbidden: () => [
        { dir: real(program), title: "二狗程序目录" },
        { dir: real(data), title: "二狗的数据目录" },
      ],
      supports: (id) => id === "claude-code",
      log: (line) => logs.push(line),
    });
  return { config, data, program, work, file, logs, folders: make(), make };
}

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RequestRejected);
    return (err as Error).message;
  }
  throw new Error("应该抛错");
};

describe("新建时选工作文件夹（305 号票）", () => {
  it("核对已有的文件夹：要绝对路径、在、是文件夹、不在数据目录和程序目录里；行的交回真实路径", () => {
    const { folders, work, data, program } = setup();
    fs.writeFileSync(path.join(work, "a.txt"), "x");
    expect(folders.check(work)).toBe(real(work));
    expect(reason(() => folders.check("relative\\dir"))).toMatch(/不是完整的路径/);
    expect(reason(() => folders.check(path.join(work, "没有")))).toMatch(/不存在/);
    expect(reason(() => folders.check(path.join(work, "a.txt")))).toMatch(/是一个文件/);
    fs.mkdirSync(path.join(data, "projects"));
    expect(reason(() => folders.check(path.join(data, "projects")))).toMatch(/二狗的数据目录/);
    expect(reason(() => folders.check(program))).toMatch(/二狗程序目录/);
  });

  it("默认文件夹：存进设置文件、重新读得到；不设了删掉文件；不能选的运行时不能设；坏了的文件当没设、不覆盖", () => {
    const { folders, work, file, make, logs } = setup();
    expect(folders.defaultOf("claude-code")).toBeUndefined();
    folders.setDefault("claude-code", work);
    expect(folders.defaultOf("claude-code")).toBe(real(work));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, defaults: { "claude-code": real(work) } });
    expect(make().defaultOf("claude-code")).toBe(real(work));
    expect(reason(() => folders.setDefault("pi", work))).toMatch(/不能选工作文件夹/);
    expect(reason(() => folders.setDefault("claude-code", path.join(work, "没有")))).toMatch(/不存在/);
    expect(folders.defaultOf("claude-code")).toBe(real(work));
    folders.setDefault("claude-code", null);
    expect(folders.defaultOf("claude-code")).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, "{坏了");
    expect(make().defaultOf("claude-code")).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("{坏了");
    expect(logs.some((l) => l.includes("读不了"))).toBe(true);
  });

  it("新建时定工作目录：不能选的运行时、没设默认又没选已有的照旧；新开的按标题起名、重名加序号；起了名字的照名字；默认文件夹不在了写明", () => {
    const { folders, work } = setup();
    const existing = makeTempDir("ergo-wf-existing-");
    expect(folders.settle(undefined, { kind: "existing", path: existing }, "x")).toBeUndefined();
    expect(folders.settle("pi", { kind: "existing", path: existing }, "x")).toBeUndefined();
    expect(folders.settle("claude-code", undefined, "整理下载目录")).toBeUndefined();
    expect(folders.settle("claude-code", { kind: "existing", path: existing }, "x")).toBe(real(existing));

    folders.setDefault("claude-code", work);
    const first = folders.settle("claude-code", undefined, "整理: 下载/目录?\n第二行")!;
    expect(first).toBe(path.join(real(work), "整理- 下载-目录-"));
    expect(fs.statSync(first).isDirectory()).toBe(true);
    expect(folders.settle("claude-code", { kind: "new" }, "整理: 下载/目录?")).toBe(path.join(real(work), "整理- 下载-目录- (2)"));
    expect(folders.settle("claude-code", { kind: "new", name: "weekly" }, "写周报")).toBe(path.join(real(work), "weekly"));
    // 什么都不剩的另起名
    expect(folders.settle("claude-code", { kind: "new", name: "..." }, "写周报")).toBe(path.join(real(work), "新的工作"));
    // 只核对：已有的路径不对抛错；新开的默认文件夹不在了抛错
    expect(() => folders.precheck("claude-code", { kind: "existing", path: existing })).not.toThrow();
    expect(reason(() => folders.precheck("claude-code", { kind: "existing", path: path.join(existing, "没有") }))).toMatch(/不存在/);
    fs.rmSync(work, { recursive: true, force: true });
    expect(reason(() => folders.settle("claude-code", undefined, "x"))).toMatch(/默认文件夹用不了/);
    expect(reason(() => folders.precheck("claude-code", { kind: "new" }))).toMatch(/默认文件夹用不了/);
  });

  it("按标题起的子文件夹名（协议包的 workFolderName）：第一行、不合法的字符换成 -、空白并一个、去掉前后的点和空格、保留名加 -、最多 60 个字", () => {
    expect(workFolderName("  修 CI 的 flaky 测试  \n第二行")).toBe("修 CI 的 flaky 测试");
    expect(workFolderName('a<b>c:"d"/e\\f|g?h*')).toBe("a-b-c-d-e-f-g-h-");
    expect(workFolderName("con")).toBe("con-");
    expect(workFolderName("NUL.txt")).toBe("NUL.txt-");
    expect(workFolderName("...")).toBe("");
    expect(workFolderName("名".repeat(80))).toHaveLength(60);
  });
});
