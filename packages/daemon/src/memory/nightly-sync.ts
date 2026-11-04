// 整理之前同步一遍：每晚整理（03:00 那一夜作业，含开机补跑的）和手动整理一次，读新素材之前先让数据源各同步一次、等导完再读，
// 这一夜就读得到刚导进来的（电脑夜里睡了、守护进程刚重启、对方晚传了，不用再晚一夜）。
//
// - 同步哪些、怎么同步由数据源的服务定（data-sources/service.ts 的 syncPullable，经 KERNEL.dataSourceSync）：能由电脑拉的、插件在运行、
//   导入开着、连着的各同步一次，触发方式记成定期的那种；正在同步的等同一次；刚同步过的（NIGHTLY_SYNC_FRESH_MS 以内成功过）不再同步；
//   连接出错的不在这里试（内核每小时再试那一套管），记下原因；手机这类设备交来的、只靠导入文件夹的、没连的不在里面；
// - 等多久由这里定：一起开始，每个最多等 NIGHTLY_SYNC_WAIT_MS（按时钟算，测试拨时钟），超了不等、照常整理——那一次接着在后台同步完，
//   导进来的下一次整理读；同步出错的也照常整理，原因记下，不在这里重试；
// - 结果进这一夜的整理记录（sourceSync：各新增几条、刚同步过的、没同步上的和为什么），记忆页"最近一次整理"下面一行写它，
//   记忆管理员的整理日记也照实说；
// - 中止（守护进程停止、插件停用、墙钟上限）马上不等，抛 AbortError；同步本身出了别的错只记日志，整理照常（交回 undefined）。
import type { MemoryNightlySourceSync, MemoryNightlySourceSyncItem } from "@ergo/protocol";
import type { PullableSync } from "../data-sources/index.ts";
import type { DataSourcePreSync } from "../plugins/kernel.ts";
import type { Clock } from "../scheduler/clock.ts";

/** 每个数据源最多等多久（毫秒）：超了不等、照常整理，这一夜的记录里写明 */
export const NIGHTLY_SYNC_WAIT_MS = 3 * 60_000;
/** 多久以内成功同步过的不再同步（毫秒） */
export const NIGHTLY_SYNC_FRESH_MS = 10 * 60_000;

export interface NightlySyncOptions {
  /** 内核的整理前同步（KERNEL.dataSourceSync） */
  sync: DataSourcePreSync;
  /** 等的上限按它算（测试拨时钟） */
  clock: Clock;
  /** 这一夜的中止信号 */
  signal: AbortSignal;
  /** 每个最多等多久（毫秒，默认 NIGHTLY_SYNC_WAIT_MS） */
  waitMs?: number;
  /** 多久以内成功同步过的不再同步（毫秒，默认 NIGHTLY_SYNC_FRESH_MS） */
  freshMs?: number;
  log: (line: string) => void;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isAbort = (err: unknown) => (err as { name?: unknown } | undefined)?.name === "AbortError";

function abortError(reason?: unknown): Error {
  const err = new Error(typeof reason === "string" && reason.length > 0 ? reason : "记忆整理已中止"); // @i18n-ignore log：被中止时的错误信息，只进日志
  err.name = "AbortError";
  return err;
}

/** 等 promise；signal 置位时不再等，抛 AbortError */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** 一个数据源这一次的结局：开始了的等到结果或者上限 */
async function outcomeOf(pulled: PullableSync, deadline: Promise<"timeout">): Promise<MemoryNightlySourceSyncItem> {
  const base = { id: pulled.id, title: pulled.title };
  if (pulled.state === "fresh") return { ...base, state: "fresh" };
  if (pulled.state === "broken") return { ...base, state: "broken", ...(pulled.problem === undefined ? {} : { reason: pulled.problem }) };
  const done = pulled.done.then(
    (result): { added?: number; error?: string } => result,
    (err: unknown): { added?: number; error?: string } => ({ error: messageOf(err) }),
  );
  const outcome = await Promise.race([done, deadline]);
  if (outcome === "timeout") return { ...base, state: "timeout" };
  if (outcome.error !== undefined) return { ...base, state: "failed", reason: outcome.error };
  return { ...base, state: "synced", added: outcome.added ?? 0 };
}

/** 日志里的一句：每个数据源怎样了 */
function logLine(sync: MemoryNightlySourceSync): string {
  // @i18n-ignore-start log：拼好交给日志的一句
  if (sync.sources.length === 0) return "记忆整理之前没有要同步的数据源";
  const parts = sync.sources.map((s) => `${s.id} ${s.state}${s.added === undefined ? "" : ` +${s.added}`}${s.reason === undefined ? "" : `（${s.reason}）`}`);
  return `记忆整理之前同步了数据源：${parts.join("、")}`;
  // @i18n-ignore-end
}

/**
 * 整理之前同步一遍：交回各数据源的结局（进整理记录的 sourceSync）。中止时抛 AbortError；
 * 同步这一步自己出了别的错（数据源的服务出错）只记日志、交回 undefined，整理照常
 */
export async function syncBeforeNightly(options: NightlySyncOptions): Promise<MemoryNightlySourceSync | undefined> {
  const { clock, signal, log } = options;
  const waitMs = options.waitMs ?? NIGHTLY_SYNC_WAIT_MS;
  const freshMs = options.freshMs ?? NIGHTLY_SYNC_FRESH_MS;
  if (signal.aborted) throw abortError(signal.reason);
  let pulled: readonly PullableSync[];
  try {
    pulled = await untilAborted(options.sync.syncPullable({ freshMs, signal }), signal);
  } catch (err) {
    if (isAbort(err) || signal.aborted) throw isAbort(err) ? err : abortError(signal.reason);
    log(`记忆整理之前同步数据源出错（不等了，整理照常）：${messageOf(err)}`);
    return undefined;
  }
  // 一起开始的，等到同一个上限（按时钟算）
  let cancel: (() => void) | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    cancel = clock.setTimer(clock.now() + waitMs, () => resolve("timeout"));
  });
  try {
    const sources = await untilAborted(Promise.all(pulled.map((p) => outcomeOf(p, deadline))), signal);
    const result: MemoryNightlySourceSync = { waitMinutes: Math.max(1, Math.round(waitMs / 60_000)), sources };
    log(logLine(result));
    return result;
  } finally {
    cancel?.();
  }
}
