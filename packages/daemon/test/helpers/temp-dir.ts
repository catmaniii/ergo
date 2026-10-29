// 测试用临时目录：一律建在系统临时目录下，测试结束自动删除。
// 个人数据永不进测试：数据目录、用户主目录在测试里都用这里建的临时目录。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

/**
 * 建一个临时目录，当前测试结束时删除（必须在测试体内调用）。
 * defer 时不在用例结束时删（给 beforeAll 里共用守护进程用：那时不在用例里，onTestFinished 会抛错），
 * 改由调用方在 afterAll 里 removeDir。
 */
export function makeTempDir(prefix = "ergo-test-", defer = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (!defer) onTestFinished(() => removeDir(dir));
  return dir;
}

/** 删除目录；Windows 上刚退出的进程可能还短暂占着文件，所以带重试。 */
export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
