// 选另存的文件夹时校验：绝对路径、不在数据目录里、存在、真写一个临时文件试；不存在的说不存在（页面问要不要新建）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nodeSnapshotFiles, type SnapshotFiles } from "../../src/backup/files.ts";
import { checkBackupFolder } from "../../src/backup/folder-check.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 试写时出这种错的写文件实现 */
const failing = (code: string): SnapshotFiles => ({
  ...nodeSnapshotFiles,
  writeFile: () => Promise.reject(Object.assign(new Error(`${code}: 模拟的`), { code })),
});

function setup() {
  const root = makeTempDir("ergo-folder-check-");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  return { root, dataDir };
}

describe("校验另存的文件夹", () => {
  it("存在、写得进去：能用，回规整过的路径，临时文件不留下", async () => {
    const { root, dataDir } = setup();
    const dir = path.join(root, "nas");
    fs.mkdirSync(dir);
    expect(await checkBackupFolder(`  ${dir}${path.sep}  `, { dataDir })).toEqual({ kind: "ok", dir });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("空的、相对路径、占位符：原因写清楚", async () => {
    const { dataDir } = setup();
    expect(await checkBackupFolder("   ", { dataDir })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("路径") });
    expect(await checkBackupFolder("backup\\here", { dataDir })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("完整路径") });
    expect(await checkBackupFolder("D:relative", { dataDir })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("完整路径") });
    expect(await checkBackupFolder("<同步目录的绝对路径>", { dataDir })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("占位符") });
  });

  it.runIf(process.platform === "win32")("Windows 上不带盘符的（当前盘的根）不算完整路径", async () => {
    const { dataDir } = setup();
    expect(await checkBackupFolder("\\no-drive", { dataDir })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("完整路径") });
  });

  it("数据目录本身、数据目录里面：不行", async () => {
    const { dataDir } = setup();
    for (const dir of [dataDir, path.join(dataDir, "backups"), path.join(dataDir, "还没有的子目录")]) {
      expect(await checkBackupFolder(dir, { dataDir })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("数据目录") });
    }
  });

  it("经目录联接绕进数据目录的：也不行", async () => {
    const { root, dataDir } = setup();
    const link = path.join(root, "link-to-data");
    fs.symlinkSync(path.join(dataDir, "backups"), link, "junction");
    expect(await checkBackupFolder(link, { dataDir })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("数据目录") });
  });

  it("是个文件：不行", async () => {
    const { root, dataDir } = setup();
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "x");
    expect(await checkBackupFolder(file, { dataDir })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("不是文件夹") });
  });

  it("不存在：说不存在，不新建；给 create 才新建，并试写", async () => {
    const { root, dataDir } = setup();
    const dir = path.join(root, "还没有", "ergo-backup");
    expect(await checkBackupFolder(dir, { dataDir })).toEqual({ kind: "missing", dir });
    expect(fs.existsSync(dir)).toBe(false);
    expect(await checkBackupFolder(dir, { dataDir, create: true })).toEqual({ kind: "ok", dir });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("写不进去、空间不够：原因写清楚；文件夹留着", async () => {
    const { root, dataDir } = setup();
    const dir = path.join(root, "readonly");
    fs.mkdirSync(dir);
    expect(await checkBackupFolder(dir, { dataDir, files: failing("EPERM") })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("没有写入权限") });
    expect(await checkBackupFolder(dir, { dataDir, files: failing("ENOSPC") })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("空间不够") });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("新建的文件夹写不进去：把刚建的撤掉", async () => {
    const { root, dataDir } = setup();
    const dir = path.join(root, "new-one");
    expect(await checkBackupFolder(dir, { dataDir, create: true, files: failing("EACCES") })).toMatchObject({ kind: "invalid", reason: expect.stringContaining("没有写入权限") });
    expect(fs.existsSync(dir)).toBe(false);
  });
});
