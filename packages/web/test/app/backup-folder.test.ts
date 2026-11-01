// 设置 · 备份里选定文件夹之后的流程：校验、问要不要新建、写配置；不能用的不写配置，原因交给框写出来。
import { describe, expect, test, vi } from "vitest";
import { type BackupFolderHttp, chooseBackupFolder } from "../../src/app/backup-folder.ts";
import type { BackupFolderCheck, BackupStatusView } from "../../src/state/index.ts";

const STATUS = { queued: false } as BackupStatusView;

function fake(check: BackupFolderCheck) {
  const backupConfig = vi.fn<BackupFolderHttp["backupConfig"]>(() => Promise.resolve(STATUS));
  const http: BackupFolderHttp = { backupCheckFolder: () => Promise.resolve(check), backupConfig };
  return { http, backupConfig };
}

const neverAsked = () => Promise.reject(new Error("不该问"));

describe("选定一个文件夹", () => {
  test("能用：用规整过的路径写配置，不问", async () => {
    const { http, backupConfig } = fake({ kind: "ok", dir: "D:\\NAS\\ergo" });
    await expect(chooseBackupFolder(http, "D:\\NAS\\ergo\\", neverAsked)).resolves.toBe(STATUS);
    expect(backupConfig).toHaveBeenCalledWith({ syncDir: "D:\\NAS\\ergo" });
  });

  test("不能用：抛出原因，不写配置", async () => {
    const { http, backupConfig } = fake({ kind: "invalid", dir: "x", reason: "要写完整路径" });
    await expect(chooseBackupFolder(http, "x", neverAsked)).rejects.toThrow("要写完整路径");
    expect(backupConfig).not.toHaveBeenCalled();
  });

  test("不存在：问一下；答应了带 createSyncDir 写配置", async () => {
    const { http, backupConfig } = fake({ kind: "missing", dir: "D:\\新的" });
    const ask = vi.fn<(dir: string) => Promise<boolean>>(() => Promise.resolve(true));
    await chooseBackupFolder(http, "D:\\新的", ask);
    expect(ask).toHaveBeenCalledWith("D:\\新的");
    expect(backupConfig).toHaveBeenCalledWith({ syncDir: "D:\\新的", createSyncDir: true });
  });

  test("不存在、不答应：不写配置，框里写一句", async () => {
    const { http, backupConfig } = fake({ kind: "missing", dir: "D:\\新的" });
    await expect(chooseBackupFolder(http, "D:\\新的", () => Promise.resolve(false))).rejects.toThrow("没有新建");
    expect(backupConfig).not.toHaveBeenCalled();
  });
});
