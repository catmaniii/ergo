// 项目的服务首页的缩略图（140 号票）：守护进程自己用无头浏览器（web/browser.ts）给运营中的、有网页的服务截首页，项目卡、项目页的
// "运营概况"上显示，点了和入口一样在内置浏览器里打开。截图是守护进程做的，不是 agent 做的（不经守卫）。
// - 怎么截（captureServiceHome）：打开经二狗转发的本机地址 http://127.0.0.1:<本机端口>/apps/<应用名>/<首页>（相对地址都对），
//   1280×800 排版、0.5 倍出图，存成 640×400 的 JPEG；页面没有响应、状态码 ≥ 400（服务不在线时转发给的说明页）、超时的算没截成；
// - 什么时候截（谁来叫见 project-services.ts）：上线并且在线（健康检查过了）之后截一次；改了运营方案、服务重启之后重截（重启引起的
//   离上一张不到 10 分钟的不截：健康检查抖一下不来回截）；之后有人看（取图的请求）时，旧了（6 小时）、还没有的补一张；
//   没截成的留着上一张，有人看时半小时内不再试；
// - 同时只截一个：排队，一个做完再做下一个；守护进程起来时不主动截（LSM 推来的全量状态不算"重启"），没有、旧了的等有人看时补；
// - 存在数据目录的缓存区（cache/service-thumbnails/<应用名>.jpg，截图时间在同名的 .json 里；不进备份，不进素材、媒体库）；
//   删除项目时一起删掉。
import fs from "node:fs";
import path from "node:path";
import { isAppName, SERVICE_THUMBNAIL_REFRESH_MS } from "@ergo/protocol";
import { type Clock, clockIso } from "../scheduler/clock.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import type { BrowserDriver } from "../web/browser.ts";
import { SEARCH_USER_AGENT } from "../web/search.ts";

/** 截图时的窗口（宽屏）和缩放：按 1280×800 排版，0.5 倍出图就是 640×400 */
export const SERVICE_THUMBNAIL_VIEWPORT = { width: 1280, height: 800 } as const;
export const SERVICE_THUMBNAIL_SCALE = 0.5;
/** JPEG 的画质 */
const JPEG_QUALITY = 70;
/** 打开首页最多等多久（毫秒） */
const GOTO_TIMEOUT_MS = 15_000;
/** 打开之后再等一会儿再截（脚本渲染、图片加载） */
const SETTLE_MS = 1_500;
/** 一次截图（起浏览器、打开、等、截）最多多久，超时算没截成 */
export const SERVICE_THUMBNAIL_TIMEOUT_MS = 40_000;
/** 没截成之后，有人看时最快多久再试 */
export const SERVICE_THUMBNAIL_RETRY_MS = 30 * 60_000;
/** 服务重启引起的重截：离上一张不到这么久的不截 */
export const SERVICE_THUMBNAIL_RESTART_GAP_MS = 10 * 60_000;

/** 用浏览器截服务首页：1280×800 排版、0.5 倍出图的 JPEG。页面没有响应、状态码 ≥ 400 的抛错（浏览器起不来也抛） */
export async function captureServiceHome(driver: BrowserDriver, url: string, signal?: AbortSignal): Promise<Buffer> {
  return driver.withPage(
    { userAgent: SEARCH_USER_AGENT, locale: "zh-CN", viewport: { ...SERVICE_THUMBNAIL_VIEWPORT }, deviceScaleFactor: SERVICE_THUMBNAIL_SCALE },
    async (page) => {
      const status = await page.goto(url, GOTO_TIMEOUT_MS);
      if (status === 0) throw new Error("页面没有响应"); // @i18n-ignore log：截不成的原因只进日志
      if (status >= 400) throw new Error(`页面打不开（HTTP ${status}）`); // @i18n-ignore log：截不成的原因只进日志
      await page.wait(SETTLE_MS);
      return page.screenshot({ quality: JPEG_QUALITY });
    },
    signal,
  );
}

/**
 * 为什么要截：live 上线了（并且在线）、plan 改了运营方案、restart 服务重启了（离上一张 10 分钟以上才截）、
 * seen 有人在看（没有、旧了 6 小时的才截；没截成的半小时内不再试）
 */
export type ThumbnailReason = "live" | "plan" | "restart" | "seen";

export interface ServiceThumbnailsOptions {
  /** 存在哪（数据目录的缓存区） */
  dir: string;
  /** 截一张（正式的是 captureServiceHome；测试注入假的） */
  capture: (url: string, signal: AbortSignal) => Promise<Buffer>;
  /** 现在截哪个地址；截不了（不在线、没有网页、没上线、二狗的端口还没开好）是 undefined——排到它时再问一次 */
  target: (app: string) => string | undefined;
  /** 有了新的一张 */
  onChange: (app: string) => void;
  clock: Clock;
  /** 一次截图最多多久（毫秒）；不给是 SERVICE_THUMBNAIL_TIMEOUT_MS */
  timeoutMs?: number;
  log: (line: string) => void;
}

export interface ServiceThumbnails {
  /** 现在这张的截图时间；没有是 undefined */
  takenAt(app: string): string | undefined;
  /** 现在这张的文件和截图时间 */
  file(app: string): { file: string; takenAt: string } | undefined;
  /** 要截一张（够不够格见 ThumbnailReason）；排着队，同时只截一个 */
  want(app: string, why: ThumbnailReason): void;
  /** 删掉某个项目的全部缩略图（删除项目时） */
  forgetProject(projectId: string): void;
  /** 手上的都截完（测试） */
  idle(): Promise<void>;
  stop(): void;
}

interface Meta {
  takenAt: string;
}

export function createServiceThumbnails(options: ServiceThumbnailsOptions): ServiceThumbnails {
  const { dir, clock, log } = options;
  const timeoutMs = options.timeoutMs ?? SERVICE_THUMBNAIL_TIMEOUT_MS;
  const jpg = (app: string) => path.join(dir, `${app}.jpg`);
  const json = (app: string) => path.join(dir, `${app}.json`);
  /** 应用名 → 现在这张的截图时间（起来时从缓存区读一遍） */
  const metas = new Map<string, Meta>();
  /** 应用名 → 最近一次没截成的时刻（按 clock） */
  const failedAt = new Map<string, number>();
  /** 排着的（一个应用只排一次） */
  const queue: string[] = [];
  let running: Promise<void> | undefined;
  /** 正在截的；forgotten：项目删掉了（截好了也不写） */
  let current: { app: string; controller: AbortController; forgotten: boolean } | undefined;
  let stopped = false;

  try {
    for (const name of fs.readdirSync(dir)) {
      const app = name.endsWith(".json") ? name.slice(0, -5) : undefined;
      if (app === undefined || !isAppName(app) || !fs.existsSync(jpg(app))) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(json(app), "utf8")) as Partial<Meta>;
        if (typeof meta.takenAt === "string") metas.set(app, { takenAt: meta.takenAt });
      } catch {
        // 坏了的不算：等有人看时重截
      }
    }
  } catch {
    // 还没有缓存区
  }

  /** 这张多老了（毫秒）；没有是无穷 */
  const age = (app: string) => {
    const meta = metas.get(app);
    const taken = meta ? Date.parse(meta.takenAt) : Number.NaN;
    return Number.isNaN(taken) ? Number.POSITIVE_INFINITY : clock.now() - taken;
  };

  const due = (app: string, why: ThumbnailReason): boolean => {
    if (why === "live" || why === "plan") return true;
    if (why === "restart") return age(app) >= SERVICE_THUMBNAIL_RESTART_GAP_MS;
    if (age(app) < SERVICE_THUMBNAIL_REFRESH_MS) return false;
    const failed = failedAt.get(app);
    return failed === undefined || clock.now() - failed >= SERVICE_THUMBNAIL_RETRY_MS;
  };

  /** 截一张：截成了换掉旧的（先写临时文件再改名），没截成的留着上一张 */
  const shoot = async (app: string) => {
    const url = options.target(app);
    if (url === undefined) return;
    const controller = new AbortController();
    const entry = { app, controller, forgotten: false };
    current = entry;
    // 驱动不理会中止的也不等它：到点就算超时
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没截完`)); // @i18n-ignore log：截不成的原因只进日志
      }, timeoutMs);
      timer.unref?.();
    });
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("停了")), { once: true })); // @i18n-ignore log：截不成的原因只进日志
    try {
      const jpeg = await Promise.race([options.capture(url, controller.signal), timeout, aborted]);
      // 停了、项目删掉了（forgetProject 中止了它）：不写
      if (stopped || entry.forgotten) return;
      if (jpeg.length === 0) throw new Error("截出来是空的"); // @i18n-ignore log：截不成的原因只进日志
      // 先写临时文件再改名；上一张正被人取着（开着）时改名等一会儿重试（265 号票）。同步写：写之前查过的"停了、项目删掉了"写完之前不会变
      writeFileAtomic(jpg(app), jpeg);
      const meta: Meta = { takenAt: clockIso(clock) };
      fs.writeFileSync(json(app), JSON.stringify(meta));
      metas.set(app, meta);
      failedAt.delete(app);
      options.onChange(app);
    } catch (err) {
      if (stopped || entry.forgotten) return;
      failedAt.set(app, clock.now());
      log(`服务 ${app} 的首页没截成（${metas.has(app) ? "留着上一张" : "先不显示图"}）：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    } finally {
      clearTimeout(timer);
      current = undefined;
    }
  };

  const pump = () => {
    if (running || stopped || queue.length === 0) return;
    running = (async () => {
      for (let app = queue.shift(); app !== undefined; app = stopped ? undefined : queue.shift()) await shoot(app);
    })()
      .catch((err: unknown) => log(`截服务首页时出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
      .finally(() => {
        running = undefined;
        pump();
      });
  };

  const remove = (app: string) => {
    for (const f of [jpg(app), json(app)]) fs.rmSync(f, { force: true });
    metas.delete(app);
    failedAt.delete(app);
  };

  return {
    takenAt: (app) => metas.get(app)?.takenAt,
    file(app) {
      const meta = metas.get(app);
      return meta && isAppName(app) ? { file: jpg(app), takenAt: meta.takenAt } : undefined;
    },
    want(app, why) {
      if (stopped || !isAppName(app) || queue.includes(app)) return;
      // 正在截它：有人看、重启的不再排；上线、改了方案的截完再截一张（截的可能是改之前的）
      if (current?.app === app && (why === "seen" || why === "restart")) return;
      if (!due(app, why) || options.target(app) === undefined) return;
      queue.push(app);
      pump();
    },
    forgetProject(projectId) {
      const prefix = `${projectId}-`;
      for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i]!.startsWith(prefix)) queue.splice(i, 1);
      if (current?.app.startsWith(prefix)) {
        current.forgotten = true;
        current.controller.abort();
      }
      for (const app of metas.keys()) if (app.startsWith(prefix)) remove(app);
      try {
        for (const name of fs.readdirSync(dir)) if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // 没有缓存区
      }
    },
    async idle() {
      for (let r = running; r; r = running) await r;
    },
    stop() {
      stopped = true;
      queue.length = 0;
      current?.controller.abort();
    },
  };
}
