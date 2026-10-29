// 快速动作"授权文件夹"（138 号票，212 号票起是内核的 folders/authorize-folders.ts；一律要用户在卡上点"执行"，见 test/main/authorized-folders.test.ts）：
// - 规范化：只认完整路径、存在的文件夹，最多 20 个；拿掉的要在授权的文件夹里；都已经是这样的不出卡、原因回给秘书；
// - 执行：改那一份授权的文件夹（local-folders.json），结果写清加了、拿掉了哪几个。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZE_FOLDERS_ACTION } from "@ergo/protocol";
import { RequestRejected } from "../../src/errors.ts";
import { authorizeFoldersAction } from "../../src/folders/authorize-folders.ts";
import { openLocalFolders } from "../../src/folders/local-folders.ts";
import { QuickActionRegistry } from "../../src/quick-actions/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 一份授权的文件夹（临时目录里的 local-folders.json）和登记好的快速动作 */
function setup() {
  const root = makeTempDir("ergo-auth-folders-");
  const pictures = path.join(root, "Pictures");
  const downloads = path.join(root, "Downloads");
  fs.mkdirSync(pictures);
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(root, "note.txt"), "不是文件夹");
  const file = path.join(root, "config", "local-folders.json");
  const folders = openLocalFolders({ file, log: () => {} });
  const registry = new QuickActionRegistry();
  registry.register(authorizeFoldersAction(folders));
  const action = registry.get(AUTHORIZE_FOLDERS_ACTION)!;
  const context = { actionId: "qa-1", cardId: "c-1", conversation: "secretary", basis: "confirmed" as const };
  const run = (params: unknown) => {
    if (!action.execute) throw new Error("应当是当场做完的执行器");
    return action.execute(params, context);
  };
  return { root, pictures, downloads, file, folders, action, run };
}

/** 规范化被拒的原因（RequestRejected 的说明） */
function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RequestRejected) return err.message;
    throw err;
  }
  throw new Error("没有被拒");
}

describe("规范化和执行", () => {
  it("加进来：几个一起，规范成完整路径；执行改那一份授权的文件夹，结果写清加了哪几个、设置里能看能改", () => {
    const { pictures, downloads, folders, action, run, file } = setup();
    const normalized = action.normalizeChecked({ change: "add", folders: [`${pictures}${path.sep}`, ` ${downloads} `] });
    expect(normalized.params).toEqual({ change: "add", folders: [pictures, downloads] });
    expect(normalized.title).toBe("授权文件夹：Pictures、Downloads");
    expect(normalized.target).toBe(`${pictures}、${downloads}`);
    // 规范化不改列表，执行才改
    expect(folders.list()).toEqual([]);
    const outcome = run(normalized.params);
    expect(outcome.events).toEqual([]);
    expect(outcome.summary).toBe(`已授权 2 个文件夹：${pictures}、${downloads}。设置 · 浏览与填框里能看、能改`);
    expect(folders.list()).toEqual([pictures, downloads]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ folders: [pictures, downloads] });
  });

  it("已经授权过的照样列出、结果里说一句；全都授权过了不出卡，原因回给秘书", () => {
    const { pictures, downloads, folders, action, run } = setup();
    folders.set([pictures]);
    const normalized = action.normalizeChecked({ change: "add", folders: [pictures, downloads] });
    expect(run(normalized.params).summary).toBe(`已授权 1 个文件夹：${downloads}（${pictures} 本来就授权了）。设置 · 浏览与填框里能看、能改`);
    expect(rejection(() => action.normalizeChecked({ change: "add", folders: [pictures.toUpperCase()] }))).toBe(`这些文件夹已经授权了：${pictures}`);
  });

  it("拿掉：要在授权的文件夹里（不分大小写；找不到了的也能拿掉），设置里跟着少一行", () => {
    const { root, pictures, downloads, folders, action, run } = setup();
    const gone = path.join(root, "旧照片");
    fs.mkdirSync(gone);
    folders.set([pictures, downloads, gone]);
    fs.rmSync(gone, { recursive: true });
    const normalized = action.normalizeChecked({ change: "remove", folders: [downloads.toLowerCase(), gone] });
    // 写成列表里的写法
    expect(normalized.params).toEqual({ change: "remove", folders: [downloads, gone] });
    expect(normalized.title).toBe("取消授权文件夹：Downloads、旧照片");
    expect(run(normalized.params).summary).toBe(`已取消授权 2 个文件夹：${downloads}、${gone}。设置 · 浏览与填框里能看、能改`);
    expect(folders.view()).toEqual({ folders: [{ path: pictures, exists: true }] });
    expect(rejection(() => action.normalizeChecked({ change: "remove", folders: [downloads] }))).toBe(`这些文件夹不在授权的文件夹里：${downloads}（现在授权的有：${pictures}）`);
  });

  it("拒绝：不是完整路径、不存在、不是文件夹、加上以后超过 20 个；参数不合 schema 的也拒", () => {
    const { root, pictures, folders, action } = setup();
    expect(rejection(() => action.normalizeChecked({ change: "add", folders: ["Pictures"] }))).toBe("要写完整的路径（比如 D:\\照片）：Pictures");
    expect(rejection(() => action.normalizeChecked({ change: "add", folders: [path.join(root, "没有")] }))).toBe(`这台电脑上没有这个文件夹：${path.join(root, "没有")}`);
    expect(rejection(() => action.normalizeChecked({ change: "add", folders: [path.join(root, "note.txt")] }))).toBe(`这台电脑上没有这个文件夹：${path.join(root, "note.txt")}`);
    expect(rejection(() => action.normalizeChecked({ change: "remove", folders: ["下载"] }))).toBe("要写完整的路径（比如 D:\\照片）：下载");
    const many = Array.from({ length: 19 }, (_, i) => {
      const dir = path.join(root, `d${i}`);
      fs.mkdirSync(dir);
      return dir;
    });
    folders.set(many);
    const extra = [pictures, path.join(root, "Downloads")];
    expect(rejection(() => action.normalizeChecked({ change: "add", folders: extra }))).toBe("最多授权 20 个文件夹：现在有 19 个，再加 2 个就超了");
    expect(() => action.normalizeChecked({ change: "add", folders: [] })).toThrow(/folders/);
    expect(() => action.normalizeChecked({ change: "add" })).toThrow(/folders/);
  });

  it("执行时再查一遍：确认之前文件夹没了的不加，抛出原因（卡片保持待处理）", () => {
    const { pictures, folders, action, run } = setup();
    const normalized = action.normalizeChecked({ change: "add", folders: [pictures] });
    fs.rmSync(pictures, { recursive: true });
    expect(rejection(() => run(normalized.params))).toBe(`这台电脑上没有这个文件夹：${pictures}`);
    expect(folders.list()).toEqual([]);
  });
});
