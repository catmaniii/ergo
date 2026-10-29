// @i18n-ignore-file log：这里只有日志（打开失败、降级的一行），没有界面文字
// 会话里现用现开的记忆引擎（232 号票）：`ask_memory` 工具和每轮醒来的简报要用推理库 rg.db，但 225 号票的引擎是
// "整理时开、跑完关"，会话里没人常开它。这里懒打开、缓存一个（只读用途）、插件停用时关掉：
// - 第一次用的时候才打开（打开会校验 manifest、版本对不上不打开，见 rg-db.ts）；之后一直用这同一个连接，
//   守卫的只读查询（结论、用户模型、问题箱、竞争解释）都走它，不写库（打开时那一次 manifest 的 updated_at 除外）；
// - 打开失败就降级：不抛错、不一直重试，记一行日志，之后每次回 undefined——`ask_memory` 因此回"记忆还没准备好"，
//   简报是空串；库**不顺手建**（还没建库就是还没建库）；
// - 和每晚整理的并发：两边各自一个连接，靠 SQLite 的 WAL 和 busy_timeout（5 秒）各走各的；这里不握事务，更不长期握写锁；
//   碰巧撞上写（busy / locked）的那一次不当成永久失败，下次再试；
// - 插件停用（运行中或者守护进程停止）时 close()：关掉连接，之后 get() 回 undefined。
// 267 号票：这一份的唯一写入口开成只读（reader），写一律被拒。要写的（264 号票的顺口问：记问过、跳过、别问这个、回答回写）
// 用 createWritableEngineUse 随用随开一份可写的、用完关掉（和管理员的工具、删除登记一样）。
import fs from "node:fs";
import { DEEPSEEK_DEFAULT_MODEL, type Embedder, type MemoryEngine } from "@ergo/memory";
import { reasoningIssueText } from "./nightly-job.ts";
import { openReasoningDb } from "./rg-db.ts";

export interface MemoryEngineProviderOptions {
  /** rg.db 的路径（338 号票起是 <数据目录>/memory/subtext/rg.db；以前在 db 区） */
  file: string;
  /** 引擎的时钟（"现在"，store.now() 用它） */
  clock: () => string;
  /** manifest 里记下的整理模型名（默认 deepseek-flash，和每晚整理一致） */
  model?: string;
  /** 向量函数（内核的 bge-m3 转接）；给了才和每晚整理用同一个向量模型名，检索里也算语义 */
  embedder?: Embedder;
  /**
   * 日志里怎么称呼"这件事"（默认"顺口问"）：337 号票起"按原话记一条"也用这一份可写引擎，日志说清是哪件事打不开库
   */
  what?: string;
  log?: (line: string) => void;
}

export interface MemoryEngineProvider {
  /** 此刻能用的引擎；没有（还没建库、版本对不上、打不开、已经关掉）是 undefined */
  get(): MemoryEngine | undefined;
  /** 打开过没有（测试、日志用；开了之后一直是 true，直到 close） */
  readonly opened: boolean;
  /** 关掉连接：插件停用、守护进程停止时调，之后 get() 回 undefined */
  close(): void;
}

/** 随用随开一份可写的引擎做一件事、用完关掉；库用不了（还没建、版本对不上、打不开）是 undefined，fn 不跑 */
export type MemoryEngineUse = <T>(fn: (engine: MemoryEngine) => T) => T | undefined;

/**
 * 267 号票：要写推理库的会话里的活（顺口问）用这个，不用上面那份缓存的读者引擎：每次打开、做完关掉，写都经引擎的唯一写入口。
 * 库**不顺手建**（还没建库就是还没建库）；打不开的原因只在变了的时候记一行日志（省得每条消息记一遍）。fn 抛的错照抛给调用方
 */
export function createWritableEngineUse(options: MemoryEngineProviderOptions): MemoryEngineUse {
  const log = options.log ?? (() => {});
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
  const what = options.what ?? "顺口问";
  let lastIssue: string | undefined;
  const issue = (reason: string) => {
    if (reason !== lastIssue) log(`${what}用不了推理库：${reason}`);
    lastIssue = reason;
  };
  return <T>(fn: (engine: MemoryEngine) => T): T | undefined => {
    let opened: ReturnType<typeof openReasoningDb>;
    try {
      if (!fs.existsSync(options.file) || fs.statSync(options.file).size === 0) {
        issue("还没建库");
        return undefined;
      }
      opened = openReasoningDb({ file: options.file, clock: options.clock, model, ...(options.embedder === undefined ? {} : { embedder: options.embedder }) });
    } catch (err) {
      issue(`打开出错：${messageOf(err)}`);
      return undefined;
    }
    if (!opened.ok) {
      issue(reasoningIssueText(opened.issue));
      return undefined;
    }
    lastIssue = undefined;
    try {
      return fn(opened.engine);
    } finally {
      opened.engine.close();
    }
  };
}

/** 打不开的原因里可以等一等再试的（正好撞上写）：不记成"一直用不了" */
const RETRYABLE = /busy|locked/i;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createMemoryEngineProvider(options: MemoryEngineProviderOptions): MemoryEngineProvider {
  const log = options.log ?? (() => {});
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
  let engine: MemoryEngine | undefined;
  /** 认定一直用不了的原因（只记一次日志，之后不再试） */
  let unusable: string | undefined;
  let closed = false;

  const giveUp = (reason: string) => {
    if (unusable === undefined) log(`记忆简报和 ask_memory 用不了推理库：${reason}`);
    unusable = reason;
  };

  return {
    get opened() {
      return engine !== undefined;
    },
    get() {
      if (engine) return engine;
      if (closed || unusable !== undefined) return undefined;
      // 还没建库：不顺手建（225 号票的装配、每晚整理会建）；空文件也当没有
      try {
        if (!fs.existsSync(options.file) || fs.statSync(options.file).size === 0) {
          giveUp("还没建库");
          return undefined;
        }
      } catch (err) {
        giveUp(messageOf(err));
        return undefined;
      }
      let result: ReturnType<typeof openReasoningDb>;
      try {
        result = openReasoningDb({
          file: options.file,
          clock: options.clock,
          model,
          // 267 号票：秘书只读——这一份引擎的唯一写入口开成只读，写推理图谱一律被拒
          reader: true,
          ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
        });
      } catch (err) {
        // 打开的时候抛出来的（磁盘、权限这类）：记一次，之后不再试
        giveUp(`打开出错：${messageOf(err)}`);
        return undefined;
      }
      if (!result.ok) {
        // 正好撞上写（busy / locked）：这次当没有，下次再来，不记成"一直用不了"
        if (result.issue.code === "open_failed" && RETRYABLE.test(result.issue.detail)) return undefined;
        // 版本对不上、里面没有 manifest：不自动迁移，等重新建库；下次不再试（省得每轮都开一遍）
        giveUp(reasoningIssueText(result.issue));
        return undefined;
      }
      engine = result.engine;
      if (result.created) log(`记忆简报建好了推理库 ${options.file}`);
      return engine;
    },
    close() {
      closed = true;
      engine?.close();
      engine = undefined;
    },
  };
}
