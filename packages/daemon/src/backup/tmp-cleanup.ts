// 临时区清理（规格第 13、18 节）：每天删掉临时区（包括秘书草稿区）里 7 天前的文件。
// 秘书给用户的产出作为附件存进了媒体库（素材区），不在临时区，清理不会丢（第 7 节）。
// - 按修改时间算"7 天前"，时钟可注入；
// - 删完变空、本身也 7 天没动过的子目录一并删掉；临时区下的第一层目录（各模块自己的一格，比如秘书草稿区）留着
//   （keepTopDirs: false 时第一层的也删：agent 工作目录里的临时目录 .ergo-tmp，177 号票）；
// - 符号链接和目录联接不动、不跟进。
import fs from "node:fs";
import path from "node:path";

export const TMP_MAX_AGE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

export interface CleanResult {
  removedFiles: number;
  removedDirs: number;
}

export async function cleanTmpDir(tmp: string, now: number, log: (line: string) => void, options: { keepTopDirs?: boolean } = {}): Promise<CleanResult> {
  const keepTopDirs = options.keepTopDirs ?? true;
  const cutoff = now - TMP_MAX_AGE_DAYS * DAY;
  const result: CleanResult = { removedFiles: 0, removedDirs: 0 };

  /** 清一个目录；返回它清完之后是不是空的 */
  const clean = async (dir: string, depth: number): Promise<boolean> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let left = entries.length;
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const { mtimeMs } = await fs.promises.lstat(abs);
          const empty = await clean(abs, depth + 1);
          if (empty && (depth >= 1 || !keepTopDirs) && mtimeMs < cutoff) {
            await fs.promises.rmdir(abs);
            result.removedDirs += 1;
            left -= 1;
          }
          continue;
        }
        const { mtimeMs } = await fs.promises.lstat(abs);
        if (mtimeMs < cutoff) {
          await fs.promises.rm(abs, { force: true });
          result.removedFiles += 1;
          left -= 1;
        }
      } catch (err) {
        // 正被别的进程占着的文件、刚被删掉的：跳过，明天再说
        log(`清理临时区：${abs} 没删掉（${err instanceof Error ? err.message : String(err)}）`);
      }
    }
    return left === 0;
  };

  await clean(tmp, 0);
  return result;
}
