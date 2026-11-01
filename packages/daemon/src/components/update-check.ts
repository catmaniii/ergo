// 组件查更新（ADR-0042）：组件清单是随版本发布的一份数据，新版本发布时同一份放在发布页上（components-manifest.json 和签名）。
// 这里只取这两个文件，不带任何用户信息（地址没有查询串，请求头只有下载那一层一直在用的 User-Agent）。
// - 签名按发布公钥验（和验发布包同一把）：验不过、程序里没有公钥都不认。这份清单决定下什么、校验值是多少，不验不能信；
// - 查成了把原始字节和签名存在组件区，重启时重新验一遍再用；没查成只记下原因，组件页上写一行，不进待办、不算出错；
//   发布页上还没有这份清单（404，老的发布都这样）连"没查成"都不算，页面写"这个版本还没有组件更新信息"；
// - 比现在的新（清单的 release 更大、这个组件的版本不一样）只是"有新版本"，点了"更新"才下（service.ts 的 offered）；
// - 每晚一次是内部作业，查到装着的组件有新版本时在待办里放一条提醒（同一版本只提醒一次），换上之后自动归档。
import fs from "node:fs";
import path from "node:path";
import { COMPONENTS_UPDATE_ACTION, type ComponentUpdateNoticeData, formatList, type InboxItem, nowIso, t } from "@ergo/protocol";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { GITHUB_REPO_URL, getBytes, HttpStatusError } from "../release/fetch.ts";
import { type MinisignPublicKey, verify } from "../release/minisign.ts";
import type { InternalJobs } from "../scheduler/internal-jobs.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { type ComponentManifest, parseManifest } from "./manifest.ts";
import type { Components } from "./service.ts";
import type { Transport } from "./transport.ts";

/** 发布页上这份清单的文件名（发版时放上去，build/release.ts） */
export const LATEST_MANIFEST_NAME = "components-manifest.json";
/** 每晚的内部作业 */
export const COMPONENT_UPDATE_JOB = "component_update_check";
const COMPONENT_UPDATE_TIME = "04:20";
/** 组件区里存着的：上次查到的清单和签名、上次查的结果 */
const SAVED_MANIFEST = "latest-manifest.json";
const CHECK_RECORD = "update-check.json";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const CHECK_TIMEOUT_MS = 20_000;

/** 清单的地址：给了自己的发布地址（ERGO_RELEASE_URL、安装时记下的 source.url）查那里，不然查 GitHub 发布页上最新的那一版 */
export function latestManifestUrl(base: string | undefined): string {
  return base?.trim() ? `${base.trim().replace(/\/+$/, "")}/${LATEST_MANIFEST_NAME}` : `${GITHUB_REPO_URL}/releases/latest/download/${LATEST_MANIFEST_NAME}`;
}

export interface UpdateCheckRecord {
  checkedAt?: string;
  error?: string;
  /** 发布页上还没有这份清单（404） */
  notPublished?: true;
}

export interface UpdateChecker {
  /** 查的是哪个地址 */
  readonly where: string;
  /** 上次查的结果 */
  last(): UpdateCheckRecord;
  /** 上次查到、存着的清单（重新验过签）；没有、验不过是 undefined */
  saved(): ComponentManifest | undefined;
  /** 查一次：查成了回新的清单，没查成记下原因、回 undefined（不抛错；守护进程停下时的中止除外） */
  check(signal?: AbortSignal): Promise<ComponentManifest | undefined>;
}

export interface UpdateCheckerOptions {
  componentsDir: string;
  /** 清单的完整地址（latestManifestUrl） */
  url: string;
  transport: Transport;
  /** 现在认的发布公钥 */
  publicKey: () => MinisignPublicKey | undefined;
  /** 一次最多等多久（毫秒）；不给是 20 秒 */
  timeoutMs?: number;
  log: (line: string) => void;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const { componentsDir, url, transport, log } = options;
  const manifestFile = path.join(componentsDir, SAVED_MANIFEST);
  const signatureFile = `${manifestFile}.minisig`;
  const recordFile = path.join(componentsDir, CHECK_RECORD);

  const readRecord = (): UpdateCheckRecord => {
    try {
      const raw = JSON.parse(fs.readFileSync(recordFile, "utf8")) as { checkedAt?: unknown; error?: unknown; notPublished?: unknown };
      return { ...(typeof raw.checkedAt === "string" ? { checkedAt: raw.checkedAt } : {}), ...(typeof raw.error === "string" ? { error: raw.error } : {}), ...(raw.notPublished === true ? { notPublished: true as const } : {}) };
    } catch {
      return {};
    }
  };
  let record = readRecord();
  const remember = (next: UpdateCheckRecord) => {
    record = next;
    fs.mkdirSync(componentsDir, { recursive: true });
    writeFileAtomic(recordFile, `${JSON.stringify(next)}\n`);
  };

  /** 验签、读清单：不对就抛（原因给人看） */
  const open = (bytes: Buffer, signature: string): ComponentManifest => {
    const key = options.publicKey();
    if (!key) throw new Error(t("components.update.noKey"));
    if (!verify(bytes, signature, key).ok) throw new Error(t("components.update.badSignature"));
    return parseManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  };

  return {
    where: url,
    last: () => record,
    saved() {
      try {
        return open(fs.readFileSync(manifestFile), fs.readFileSync(signatureFile, "utf8"));
      } catch {
        return undefined;
      }
    },
    async check(signal) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS);
      const limit = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const bytes = await getBytes(transport, url, limit, MAX_MANIFEST_BYTES);
        const signature = (await getBytes(transport, `${url}.minisig`, limit, MAX_SIGNATURE_BYTES)).toString("utf8");
        const manifest = open(bytes, signature);
        fs.mkdirSync(componentsDir, { recursive: true });
        writeFileAtomic(manifestFile, bytes);
        writeFileAtomic(signatureFile, signature);
        remember({ checkedAt: nowIso() });
        return manifest;
      } catch (err) {
        if (signal?.aborted) throw err;
        // 只认清单本身的 404：清单在、签名没有的还是"没查成"
        if (err instanceof HttpStatusError && err.status === 404 && err.url === url) {
          // @i18n-ignore-next log：只进日志
          log(`[组件] 查更新：发布页上还没有版本清单（${url}）`);
          remember({ checkedAt: nowIso(), notPublished: true });
          return undefined;
        }
        const reason = timeout.aborted ? t("components.update.timeout") : err instanceof Error ? err.message : String(err);
        // @i18n-ignore-next log：没查成只进日志和组件页那一行
        log(`[组件] 查更新没查成（${url}）：${reason}`);
        remember({ checkedAt: nowIso(), error: reason });
        return undefined;
      }
    },
  };
}

export interface ComponentUpdateJob {
  /** 登记每晚的内部作业、换上之后自动归档提醒 */
  start(): void;
  stop(): void;
  /** 每晚做的那一次（查、有新版本就提醒） */
  nightly(signal?: AbortSignal): Promise<void>;
}

export interface ComponentUpdateJobOptions {
  components: Pick<Components, "checkUpdates" | "pendingUpdates" | "onChange">;
  inbox: Pick<InboxService, "add" | "list" | "isProcessed" | "buildUpdate">;
  store: Pick<EventStore, "append">;
  internalJobs: Pick<InternalJobs, "register">;
}

const NOTICE = "component_update_available";
const versionKey = (c: { id: string; version: string }) => `${c.id}@${c.version}`;

export function createComponentUpdateJob(options: ComponentUpdateJobOptions): ComponentUpdateJob {
  const { components, inbox, store, internalJobs } = options;
  const offs: (() => void)[] = [];
  const notices = () => inbox.list().filter((item): item is InboxItem & { kind: "notice"; data: ComponentUpdateNoticeData } => item.kind === "notice" && item.notice === NOTICE && !item.deleted);

  /** 换上了（或者这个版本不再是新版本了）：提醒没人点过的自动归档 */
  const retire = () => {
    const open = notices().filter((item) => !item.archived && !inbox.isProcessed(item));
    if (open.length === 0) return;
    const pending = new Set(components.pendingUpdates().map(versionKey));
    for (const item of open) {
      if (!item.data.components.some((c) => pending.has(versionKey(c)))) store.append(inbox.buildUpdate(item, { archived: true }).event);
    }
  };

  const nightly = async (signal?: AbortSignal) => {
    await components.checkUpdates(signal);
    retire();
    // 同一个组件的同一个版本只提醒一次：点过"知道了"的不再每晚来一条
    const told = new Set(notices().flatMap((item) => item.data.components.map(versionKey)));
    const fresh = components.pendingUpdates().filter((c) => !told.has(versionKey(c)));
    if (fresh.length === 0) return;
    const data: ComponentUpdateNoticeData = { components: fresh.map(({ id, version }) => ({ id, version })) };
    inbox.add({
      kind: "notice",
      notice: NOTICE,
      title: t("components.update.noticeTitle", { names: formatList(fresh.map((c) => c.title)) }),
      body: t("components.update.noticeBody"),
      source: t("components.update.noticeSource"),
      urgency: "non_blocking",
      // "去更新组件"由前端带到设置 · 组件（不算处理），换上之后这条自动归档
      actions: [COMPONENTS_UPDATE_ACTION, "知道了"], // @i18n-ignore fixed：事项的动作按字认
      data,
    });
  };

  return {
    start() {
      offs.push(internalJobs.register({ name: COMPONENT_UPDATE_JOB, schedule: { kind: "daily", time: COMPONENT_UPDATE_TIME }, run: (_trigger, signal) => nightly(signal) }));
      offs.push(components.onChange(retire));
    },
    stop() {
      for (const off of offs.splice(0)) off();
    },
    nightly,
  };
}
