// 写临时文件再改名（265 号票）：产品里"先写旁边的临时文件（或临时目录）、写全了再改名成正式的"都走这里，文件不会只写了一半。
// 改名碰上目标或来源正被占着（EPERM / EBUSY / EACCES）时等一会儿重试，每 100 毫秒一次、最多 50 次（约 5 秒），一直不成照旧抛出原来的错误。
// Windows 上改名覆盖一个正被别的进程开着的文件会失败——哪怕对方只是在读（备份在复制、杀毒在扫、索引、同步客户端，
// 测试在轮询读；同一个进程自己开着也一样），刚写完的临时文件被杀毒扫着时也会；255 号票查出的会话文件改写就是这样碰上一次就放弃的。
// - 同步的（renameRetrying / writeFileAtomic）等的时候挡住当前线程：给本来就是同步的写法用（配置区的小文件、设置页的保存），
//   平常一次就成、不等；只有真被占着才等，最多约 5 秒；
// - 异步的（renameRetryingAsync / writeFileAtomicAsync）等的时候不挡事件循环：给本来就在异步流程里的用（截图、下载模型、备份、导入）。
// 别的错误（来源不在、跨盘 EXDEV、没有权限以外的）不重试，原样抛出，调用方照旧处理。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 这几种错误算"正被占着"，等一会儿重试 */
const BUSY_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);
/** 最多重试几次、每次隔多久（毫秒）：一共约 5 秒 */
export const RENAME_RETRIES = 50;
export const RENAME_RETRY_MS = 100;

export interface RenameRetryOptions {
  /** 最多重试几次（不填是 RENAME_RETRIES） */
  retries?: number;
  /** 每次隔多久（毫秒，不填是 RENAME_RETRY_MS） */
  delayMs?: number;
}

const isBusy = (err: unknown): boolean => BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? "");

/** 同步地等 ms 毫秒（挡住当前线程；Node 的主线程上也能用） */
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 改名（文件或目录）；被占着时等一会儿重试，一直不成抛出最后一次的错误。来源不会被删 */
export function renameRetrying(from: string, to: string, options: RenameRetryOptions = {}): void {
  const retries = options.retries ?? RENAME_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= retries || !isBusy(err)) throw err;
      sleepSync(options.delayMs ?? RENAME_RETRY_MS);
    }
  }
}

/** renameRetrying 的异步版：等的时候不挡事件循环 */
export async function renameRetryingAsync(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const retries = options.retries ?? RENAME_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (attempt >= retries || !isBusy(err)) throw err;
      await sleep(options.delayMs ?? RENAME_RETRY_MS);
    }
  }
}

export interface AtomicWriteOptions extends RenameRetryOptions {
  /** 临时文件的路径（和目标在同一个目录，改名才是原子的）；不填是 <目标>.<pid>.<随机>.tmp */
  temp?: string;
}

/** 目标旁边的临时文件名：同一个目录、以 .tmp 结尾（列目录按扩展名认正式文件的模块看不见它） */
export function tempPathFor(file: string): string {
  return path.join(path.dirname(file), `${path.basename(file)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
}

/**
 * 写一个文件：父目录没有就建，先写同目录的临时文件，再改名成目标（被占着时重试）。
 * 写或改名失败：临时文件删掉，抛出原来的错误（目标保持原样）
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = options.temp ?? tempPathFor(file);
  try {
    fs.writeFileSync(temp, data);
    renameRetrying(temp, file, options);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** writeFileAtomic 的异步版：写和等都不挡事件循环 */
export async function writeFileAtomicAsync(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = options.temp ?? tempPathFor(file);
  try {
    await fs.promises.writeFile(temp, data);
    await renameRetryingAsync(temp, file, options);
  } catch (err) {
    await fs.promises.rm(temp, { force: true });
    throw err;
  }
}
