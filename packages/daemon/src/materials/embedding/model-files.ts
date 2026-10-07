// 模型文件：在不在模型区、怎么下载。模型文件不随仓库分发、守护进程也不自动下载，由用户运行下载命令放进模型区。
// 下载：先写 <文件>.part，边下边算 sha256，大小和哈希都对上才改成正式的名字（模型区里不会出现下了一半的正式文件）；
// 已经在、大小对得上的文件跳过。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ModelFile {
  /** 相对模型目录的路径（用 / 分隔） */
  path: string;
  size: number;
  /** 大文件（git LFS）有 sha256，下载后核对 */
  sha256?: string;
}

/** 模型目录里文件都在、大小都对 */
export function modelFilesPresent(dir: string, files: readonly ModelFile[]): boolean {
  return files.every((file) => {
    try {
      return fs.statSync(path.join(dir, ...file.path.split("/"))).size === file.size;
    } catch {
      return false;
    }
  });
}

export interface DownloadOptions {
  /** 文件的下载地址前缀，比如 https://huggingface.co/<仓库>/resolve/<版本> */
  baseUrl: string;
  files: readonly ModelFile[];
  /** 下载到哪个目录（模型目录） */
  dir: string;
  log: (line: string) => void;
  /** 测试注入；默认用全局 fetch */
  fetch?: (url: string) => Promise<Response>;
}

export async function downloadModelFiles(options: DownloadOptions): Promise<void> {
  const fetchFile = options.fetch ?? ((url: string) => fetch(url));
  for (const file of options.files) {
    const dest = path.join(options.dir, ...file.path.split("/"));
    if (modelFilesPresent(options.dir, [file])) {
      options.log(`${file.path}：已经在了，跳过`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const url = `${options.baseUrl}/${file.path}`;
    options.log(`${file.path}：下载 ${formatSize(file.size)}（${url}）`);
    const response = await fetchFile(url);
    if (!response.ok || !response.body) throw new Error(`${file.path}：下载失败，HTTP ${response.status}`);

    const part = `${dest}.part`;
    const hash = createHash("sha256");
    const out = fs.createWriteStream(part);
    let received = 0;
    let reported = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
        // 每 10% 报一次进度
        const percent = Math.floor((received / file.size) * 10) * 10;
        if (file.size > 0 && percent > reported && percent < 100) {
          reported = percent;
          options.log(`${file.path}：${percent}%`);
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw err;
    }
    const digest = hash.digest("hex");
    if (received !== file.size || (file.sha256 !== undefined && digest !== file.sha256)) {
      fs.rmSync(part, { force: true });
      throw new Error(`${file.path}：下载的内容不对（大小 ${received}，应为 ${file.size}；sha256 ${digest}${file.sha256 ? `，应为 ${file.sha256}` : ""}）`);
    }
    fs.renameSync(part, dest);
    options.log(`${file.path}：完成`);
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
