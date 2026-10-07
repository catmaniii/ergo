// 备份往本机备份区和同步目录写文件，全部经过这个小接口（"可替换的文件写入"）：
// 测试换成会出错的实现，模拟同步目录空间不够、复制出错；正式运行用 nodeSnapshotFiles。
// 读源文件不经过这里（读不会写坏备份）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface CopiedFile {
  size: number;
  sha256: string;
}

/** 硬链接的结果：做不了硬链接时退回了整份复制，带上原因（调用方记日志） */
export type LinkResult = { linked: true } | { linked: false; reason: string };

export interface SnapshotFiles {
  /** 把 src 的前 length 个字节复制成新文件 dest（父目录已存在），返回实际写下的字节数和内容的 sha256 */
  copy(src: string, dest: string, length: number): Promise<CopiedFile>;
  /** dest 和 existing 是同一份存储（硬链接）；文件系统不支持、跨盘、链接数到顶时退回整份复制 */
  link(existing: string, dest: string): Promise<LinkResult>;
  /** 设成只读：本机备份区里一份存储可能属于好几天的快照，不能被就地改写 */
  protect(file: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, data: string): Promise<void>;
  /** 改名（目录也行），见 renameWithRetry */
  rename(from: string, to: string): Promise<void>;
  /** 删文件或整个目录（只读的也删）；不存在不算错 */
  remove(target: string): Promise<void>;
}

/** 复制 src 的前 length 个字节到 dest，边写边算 sha256（源文件中途变短了就只有那么多） */
async function copyPrefix(src: string, dest: string, length: number): Promise<CopiedFile> {
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  if (length === 0) {
    await fs.promises.writeFile(dest, "", { flag: "wx" });
  } else {
    await pipeline(fs.createReadStream(src, { start: 0, end: length - 1 }), tap, fs.createWriteStream(dest, { flags: "wx" }));
  }
  return { size, sha256: hash.digest("hex") };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 改名；Windows 上目录刚被别的程序（同步客户端、杀毒、索引、刚退出的进程）碰过时会短暂 EPERM / EBUSY，
 * 重试一会儿（最多约 5 秒）。备份发布快照、恢复命令挪走数据目录都用它。
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 50 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw err;
      await delay(100);
    }
  }
}

export const nodeSnapshotFiles: SnapshotFiles = {
  copy: copyPrefix,
  async link(existing, dest) {
    try {
      await fs.promises.link(existing, dest);
      return { linked: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // 空间不够之类的错照样抛；只有"这里做不了硬链接"才退回复制（复制品保留只读属性）
      if (!["EXDEV", "EPERM", "EMLINK", "ENOTSUP", "EINVAL", "ENOSYS", "EACCES"].includes(code ?? "")) throw err;
      await fs.promises.copyFile(existing, dest, fs.constants.COPYFILE_EXCL);
      return { linked: false, reason: `${code}：${(err as Error).message}` };
    }
  },
  protect: (file) => fs.promises.chmod(file, 0o444),
  mkdir: async (dir) => {
    await fs.promises.mkdir(dir, { recursive: true });
  },
  writeFile: (file, data) => fs.promises.writeFile(file, data),
  rename: renameWithRetry,
  // 删只读的硬链接不影响同一份存储的其他链接（Windows 上按 POSIX 语义删，只读属性留着）
  remove: (target) => fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
};
