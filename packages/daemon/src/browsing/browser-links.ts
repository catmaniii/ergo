// 浏览侧边栏（147 号票）在守护进程这一侧的"设备通路"：哪台设备上开着哪个浏览器（二狗网页的"浏览"，每次打开随机一个编号），
// 它现在开着哪个网页、选中了哪个框（设备经 WebSocket 方法 browser_status 报，变了就报、重连后再报），以及把秘书的网页工具要办的事
// 转给那台设备、等它回结果。
// - 连接（网关的 FrontendConnection）报了某个浏览器就记下"这个浏览器在这条连接上"；同一个浏览器换了连接（断线重连）以新的为准；
//   连接断了，它报过的浏览器都当关了，正等着它回的事一律回"浏览器断开了"，不卡住秘书；
// - request：推一条事件 browser_request 给那条连接（只推给它，不广播），等它 browser_reply；到时没回也回明确的原因；
// - 回结果只认发给的那条连接（别的连接回同一个编号的不算）。
// 网页候选卡上点"交"时也经这里把文件交给那台设备（browsing/pick-card.ts）。
// 212 号票起是浏览插件的：插件装配时建一份，停用时 close（正等着设备回的事一律回"断开了"，记着的浏览器都忘掉）；
// 再启用是新的一份，网页那边插件重新装上时再报一次浏览器的样子。
import { randomBytes } from "node:crypto";
import { type BrowserOutcome, type BrowserReplyParams, type BrowserRequest, type BrowserStatusParams, t } from "@ergo/protocol";

/** 一条连接（网关给）：能往它推一条 browser_request */
export interface BrowserPeer {
  sendBrowserRequest(request: BrowserRequest): void;
}

/** 秘书的网页工具要设备办的事（编号由这里给） */
export type BrowserTask = BrowserRequest extends infer R ? (R extends { id: string } ? Omit<R, "id"> : never) : never;

/** 默认等设备多久（毫秒）：读网页、填字、开网址 */
export const BROWSER_REQUEST_TIMEOUT_MS = 30_000;
/** 交文件等多久（毫秒）：设备要先凭取件码把文件取回去 */
export const BROWSER_ATTACH_TIMEOUT_MS = 120_000;

export interface BrowserLinks {
  /** 连接报了它的浏览器现在的样子 */
  report(peer: BrowserPeer, status: BrowserStatusParams): void;
  /** 连接回了一件事的结果 */
  reply(peer: BrowserPeer, params: BrowserReplyParams): void;
  /** 连接断了 */
  drop(peer: BrowserPeer): void;
  /** 这个浏览器现在的样子（没连着是 undefined） */
  status(browser: string): BrowserStatusParams | undefined;
  /** 让这个浏览器所在的设备办一件事，等它回；没连着、断了、到时没回都回不成和原因（不抛错） */
  request(browser: string, task: BrowserTask, timeoutMs?: number): Promise<LinkOutcome>;
  /** 不再用了（212 号票：浏览插件停用）：正等着的一律回断开了，记着的浏览器都忘掉 */
  close(): void;
}

/**
 * 设备办事的结果；这里自己判的没办成（没连着、断了、到时没回）另带 userReason（173 号票）：reason 是给秘书看的（工具结果，中文），
 * userReason 是给用户看的（网页候选卡上"没交进去"的原因，按当前语言）。设备回的原因是设备那边写的，两边都用它
 */
export type LinkOutcome = BrowserOutcome & { userReason?: string };

/** 没连着时的那句（给秘书看的） */
export const BROWSER_GONE = "发消息的那台设备上「浏览」已经关了（二狗的 App 退出了或断网了）"; // @i18n-ignore model

/** 这里自己判的没办成：给秘书看的原因和给用户看的原因 */
const failed = (reason: string, userReason: string): LinkOutcome => ({ ok: false, reason, userReason });
const gone = () => failed(BROWSER_GONE, t("browsing.links.gone"));

export function createBrowserLinks(): BrowserLinks {
  const browsers = new Map<string, { peer: BrowserPeer; status: BrowserStatusParams }>();
  const pending = new Map<string, { peer: BrowserPeer; resolve(outcome: LinkOutcome): void; timer: ReturnType<typeof setTimeout> }>();

  const settle = (id: string, outcome: LinkOutcome) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
  };

  return {
    report(peer, status) {
      browsers.set(status.browser, { peer, status });
    },
    reply(peer, params) {
      if (pending.get(params.id)?.peer !== peer) return;
      settle(params.id, params.result);
    },
    drop(peer) {
      for (const [browser, entry] of browsers) if (entry.peer === peer) browsers.delete(browser);
      for (const [id, entry] of pending) if (entry.peer === peer) settle(id, failed(`${BROWSER_GONE}，没办成`, t("browsing.links.dropped"))); // @i18n-ignore model
    },
    status: (browser) => browsers.get(browser)?.status,
    close() {
      browsers.clear();
      for (const id of pending.keys()) settle(id, failed(`${BROWSER_GONE}，没办成`, t("browsing.links.dropped"))); // @i18n-ignore model
    },
    request(browser, task, timeoutMs) {
      const link = browsers.get(browser);
      if (!link) return Promise.resolve(gone());
      const id = `br-${randomBytes(8).toString("hex")}`;
      const wait = timeoutMs ?? (task.op === "attach" ? BROWSER_ATTACH_TIMEOUT_MS : BROWSER_REQUEST_TIMEOUT_MS);
      return new Promise<LinkOutcome>((resolve) => {
        const seconds = Math.round(wait / 1000);
        const timer = setTimeout(() => settle(id, failed(`设备 ${seconds} 秒没回（网不好，或者 App 在后台被挂起了）`, t("browsing.links.timeout", { seconds }))), wait); // @i18n-ignore model
        timer.unref?.();
        pending.set(id, { peer: link.peer, resolve, timer });
        try {
          link.peer.sendBrowserRequest({ ...task, id } as BrowserRequest);
        } catch {
          settle(id, gone());
        }
      });
    },
  };
}
