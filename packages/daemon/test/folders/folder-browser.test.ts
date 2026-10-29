// 列子文件夹（138 号票，212 号票起是内核的 folders/folder-browser.ts）：设置 · 浏览与填框里"添加文件夹"的框用它一路点进去。
// 用户目录、各个盘换成假的（临时目录），不碰真实的主目录。
// - 不给路径：常用位置（图片、下载、桌面、文档、用户目录，存在的才列）和各个盘；
// - 给路径：子文件夹（只列文件夹，隐藏的、系统的不列，按名字排）、上一级；太多的截断、写着一共几个；
// - 读不了的（不存在、不是文件夹、不是完整路径）回原因和上一级。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFolderBrowser } from "../../src/folders/folder-browser.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function setup(limit?: number) {
  const home = makeTempDir("ergo-home-");
  const driveD = makeTempDir("ergo-drive-");
  for (const name of ["Pictures", "Downloads", "Documents"]) fs.mkdirSync(path.join(home, name));
  const browser = createFolderBrowser({ homeDir: () => home, drives: () => Promise.resolve([driveD]), ...(limit === undefined ? {} : { limit }) });
  return { home, driveD, browser };
}

describe("列子文件夹", () => {
  it("不给路径：常用位置（存在的才列，按图片、下载、桌面、文档、用户目录排）和各个盘", async () => {
    const { home, driveD, browser } = setup();
    expect(await browser.browse()).toEqual({
      kind: "roots",
      places: [
        { name: "图片", path: path.join(home, "Pictures") },
        { name: "下载", path: path.join(home, "Downloads") },
        { name: "文档", path: path.join(home, "Documents") },
        { name: "用户目录", path: home },
      ],
      drives: [{ name: driveD, path: driveD }],
    });
  });

  it("盘的名字去掉末尾的分隔符（C:\\ 写成 C:）", async () => {
    const home = makeTempDir("ergo-home-");
    const browser = createFolderBrowser({ homeDir: () => home, drives: () => Promise.resolve(["C:\\", "D:\\", "/"]) });
    const view = await browser.browse();
    expect(view.kind === "roots" && view.drives).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "D:", path: "D:\\" },
      { name: "/", path: "/" },
    ]);
  });

  it("给路径：只列子文件夹（按名字排），隐藏的、系统的不列，文件不列；有上一级", async () => {
    const { home, browser } = setup();
    for (const name of ["旅行", "2025", "2026 杭州", ".git", "$RECYCLE.BIN", "node_modules", "AppData", "System Volume Information"]) fs.mkdirSync(path.join(home, "Pictures", name));
    fs.writeFileSync(path.join(home, "Pictures", "IMG_001.jpg"), "照片");
    const pictures = path.join(home, "Pictures");
    expect(await browser.browse(pictures)).toEqual({
      kind: "folder",
      path: pictures,
      parent: home,
      folders: [
        { name: "2025", path: path.join(pictures, "2025") },
        { name: "2026 杭州", path: path.join(pictures, "2026 杭州") },
        { name: "旅行", path: path.join(pictures, "旅行") },
      ],
      total: 3,
    });
    // 末尾带分隔符的、上一级写法的照样认，规范成完整路径
    expect(await browser.browse(`${pictures}${path.sep}2025${path.sep}..${path.sep}`)).toMatchObject({ kind: "folder", path: pictures });
  });

  it("盘的根没有上一级", async () => {
    const { browser } = setup();
    const root = path.parse(process.cwd()).root;
    const view = await browser.browse(root);
    expect(view.kind).toBe("folder");
    expect(view.kind === "folder" && view.parent).toBeUndefined();
  });

  it("太多的只列前面这些，写着一共几个", async () => {
    const { home, browser } = setup(3);
    for (const name of ["a", "b", "c", "d", "e"]) fs.mkdirSync(path.join(home, "Documents", name));
    const view = await browser.browse(path.join(home, "Documents"));
    expect(view).toMatchObject({ kind: "folder", total: 5 });
    expect(view.kind === "folder" && view.folders.map((f) => f.name)).toEqual(["a", "b", "c"]);
  });

  it("读不了的回原因和上一级：不存在、不是文件夹、不是完整路径", async () => {
    const { home, browser } = setup();
    const missing = path.join(home, "没有");
    expect(await browser.browse(missing)).toEqual({ kind: "unreadable", path: missing, parent: home, reason: "这台电脑上没有这个文件夹" });
    const file = path.join(home, "笔记.txt");
    fs.writeFileSync(file, "x");
    expect(await browser.browse(file)).toEqual({ kind: "unreadable", path: file, parent: home, reason: "这不是文件夹" });
    expect(await browser.browse("Pictures")).toEqual({ kind: "unreadable", path: "Pictures", reason: "要写完整的路径（比如 D:\\照片）" });
  });
});
