// 设备配对和外网端口（规格第 6 节、第 21 节）：守护进程和 Web 共用的常量、默认设备名；
// 123 号票起还有已配对设备多选管理（延期、吊销、删除）的规则：延期后的到期日、哪台要跳过、跳过的原因怎么说。
// 只有常量和纯函数，不引用 TypeBox。HTTP 接口的路径在 http.ts（HTTP_PATHS.access、HTTP_PATHS.pairing），
// 请求体和响应体在 http-schema.ts。
//
// 外网端口是隧道的唯一目标，永远不享受本机信任：每个 HTTP 请求和 WebSocket 握手都要带有效的设备凭证
// （HttpOnly cookie，页面脚本里看不到）；没有凭证只能拿到页面本身（显示配对等待页）、查"我有没有被信任"、发配对请求。
import { t, tTable } from "./i18n/runtime.ts";
import type { DeviceBatchAction, DeviceBatchSkip } from "./constants.ts";

const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** 待批的配对请求多久过期 */
export const PAIRING_REQUEST_TTL_MS = 5 * MINUTE;

/** 批准之后，新设备在多久之内来领凭证（新设备每隔几秒问一次；超时没领就作废，要重新请求） */
export const PAIRING_CLAIM_WINDOW_MS = 5 * MINUTE;

/** 同一来源（经隧道来的以 nginx 覆盖写的 X-Real-IP 为准）在这么长的时间里…… */
export const PAIRING_RATE_WINDOW_MS = 10 * MINUTE;
/** ……最多发这么多个配对请求，再多的被拒 */
export const PAIRING_RATE_LIMIT = 5;

/** 设备凭证的有效期：从最近一次使用算起（每次使用都续期） */
export const DEVICE_CREDENTIAL_TTL_MS = 365 * DAY;

/**
 * 设备凭证 cookie 在浏览器里活多久（用户 2026-10-14 定）：400 天，是 Chrome 允许的最长期限，比服务端的有效期多留 35 天。
 * 服务端过期一个月以内的设备手里还有凭证，在设置里延期（123 号票）就能直接用，不用重新配对
 */
export const DEVICE_COOKIE_MAX_AGE_MS = 400 * DAY;

/**
 * 新设备领到凭证之后，多久之内要第一次带着它来（领取的响应丢了，凭证就到不了设备手里）：
 * 这之前设备记录是"等待首次使用"，到时还没用过就自动作废
 */
export const DEVICE_FIRST_USE_WINDOW_MS = DAY;

/** 延期能选的时长（天）：30 天、90 天、1 年，默认 1 年（123 号票） */
export const DEVICE_EXTEND_DAYS = [30, 90, 365] as const;
export const DEFAULT_DEVICE_EXTEND_DAYS = 365;

/** 一次延期最多推多少天（协议上的上限；界面上只给上面三个） */
export const DEVICE_EXTEND_MAX_DAYS = 365;

/** 一次多选最多管多少台 */
export const DEVICE_BATCH_MAX = 200;

/** 延期后的到期时间（毫秒）：从原到期日和现在里晚的那个起算，已经过期、作废的从现在起算 */
export function extendedExpiry(expiresAt: string, now: number, days: number): number {
  return Math.max(Date.parse(expiresAt), now) + days * DAY;
}

/**
 * 这台设备做这个动作要不要跳过、为什么（守护进程判断、界面上算按钮个数共用）；能做是 undefined。
 * 有效的、等待首次使用的、过期的、作废的三样都能做（过期、作废的延期后重新有效）；吊销了的只能删除（吊销不可撤销）；
 * 删了的、没有的一律跳过
 */
export function deviceBatchSkip(device: { revoked: boolean; deletedAt?: string | undefined } | undefined, action: DeviceBatchAction): DeviceBatchSkip | undefined {
  if (!device) return "not_found";
  if (device.deletedAt !== undefined) return "deleted";
  if (action !== "delete" && device.revoked) return "revoked";
  return undefined;
}

/** 跳过的原因接在"N 台""这台设备"后面怎么说 */
export function deviceSkipPhrase(action: DeviceBatchAction, skip: DeviceBatchSkip): string {
  switch (skip) {
    case "not_found":
      return t("protocol.pairing.skip.notFound");
    case "deleted":
      return t("protocol.pairing.skip.deleted");
    case "revoked":
      return action === "extend" ? t("protocol.pairing.skip.revokedNoExtend") : t("protocol.pairing.skip.revoked");
  }
}

/** 给人看的时长："5 分钟"、"24 小时"、"365 天"（界面和报错的文字由常量拼出，不另写数字） */
export function durationText(ms: number): string {
  if (ms >= 2 * DAY && ms % DAY === 0) return t("protocol.pairing.duration.days", { n: ms / DAY, count: ms / DAY });
  if (ms >= HOUR && ms % HOUR === 0) return t("protocol.pairing.duration.hours", { n: ms / HOUR, count: ms / HOUR });
  return t("protocol.pairing.duration.minutes", { n: Math.round(ms / MINUTE), count: Math.round(ms / MINUTE) });
}

/** 待我处理里配对请求那一项的标题 */
export function pairingRequestTitle(deviceName: string): string {
  return t("protocol.pairing.requestTitle", { name: deviceName });
}

/** 短码的位数（十进制数字）和短指纹的位数（十六进制） */
export const PAIRING_SHORT_CODE_DIGITS = 6;
export const PAIRING_FINGERPRINT_HEX_DIGITS = 8;

/** 设备名最长多少个字符 */
export const DEVICE_NAME_MAX_LENGTH = 64;

/** 被吊销（或凭证失效）的设备，服务端关掉它的 WebSocket 时用的关闭码 */
export const WS_CLOSE_UNPAIRED = 4401;

/** 设备名默认值：浏览器 · 系统（由 User-Agent 推出来；新设备上可以改） */
export function defaultDeviceName(userAgent: string): string {
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /HarmonyOS|ArkWeb/.test(ua)
      ? t("protocol.pairing.device.harmonyBrowser")
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : t("protocol.pairing.device.browser");
  const os = /HarmonyOS|OpenHarmony/.test(ua)
    ? "HarmonyOS"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua)
        ? "iPad"
        : /Android/.test(ua)
          ? "Android"
          : /Windows/.test(ua)
            ? "Windows"
            : /Mac OS X/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : t("protocol.pairing.device.unknownOs");
  return `${browser} · ${os}`;
}

/**
 * 像网络上的自动访问的字眼（137 号票，按顺序，第一条对上的给原因）：浏览器标识里的字眼 → 它是什么。
 * 对上的是整个词（「HeadlessChrome」「Googlebot」「python-requests」），写进原因里。
 * 爬虫的 bot 只认词尾、后面紧跟 / ; ) - 或结尾的（Googlebot/2.1、TwitterBot)）：手机牌子 CUBOT（"CUBOT X30"、"CUBOT_X19"）不算
 */
const AUTOMATED_WHAT = tTable({
  headless: "protocol.pairing.automated.headless",
  automation: "protocol.pairing.automated.automation",
  library: "protocol.pairing.automated.library",
  scanner: "protocol.pairing.automated.scanner",
  crawler: "protocol.pairing.automated.crawler",
});

const AUTOMATED_MARKS: ReadonlyArray<readonly [pattern: RegExp, what: keyof typeof AUTOMATED_WHAT]> = [
  [/[\w.-]*(?:headless|phantomjs|slimerjs)[\w.-]*/i, "headless"],
  [/[\w.-]*(?:puppeteer|playwright|selenium|webdriver|lighthouse)[\w.-]*/i, "automation"],
  [/[\w.-]*(?:curl|wget|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|okhttp|libwww-perl|apache-httpclient|node-fetch|axios|undici|scrapy)[\w.-]*|\bJava\/[\d.]+/i, "library"],
  [/[\w.-]*(?:zgrab|masscan|nmap|nuclei|censys|scanner)[\w.-]*/i, "scanner"],
  [/[a-z]*bot(?=[/;)-]|$)|[\w.-]*(?:crawler|spider)[\w.-]*/i, "crawler"],
];

/** 原因里引浏览器标识时最多引多少个字符 */
const QUOTED_UA_MAX = 60;

/**
 * 配对请求像不像网络上的自动访问（137 号票）：按浏览器标识（User-Agent）判断，像就给原因，不像是 undefined。
 * 规则只写在这里：
 * 1. 没有浏览器标识；
 * 2. 带无界面浏览器（HeadlessChrome、PhantomJS……）、自动化工具（puppeteer、playwright、selenium……）、
 *    程序库和命令行工具（curl、python-requests、Go-http-client……）、扫描程序（zgrab、masscan、Censys……）、
 *    爬虫（…bot、crawler、spider）的字眼（AUTOMATED_MARKS）；
 * 3. 带网址（"+http://www.google.com/bot.html"：爬虫的写法，浏览器从来不带）；
 * 4. 不以 "Mozilla/5.0 (" 开头：现在的浏览器（Chrome、Safari、Firefox、Edge、鸿蒙的 ArkWeb、App 里的网页）
 *    都是这样开头、括号里写系统，光秃秃的 "Mozilla/5.0" 和老 IE 的 "Mozilla/4.0" 都是程序写的。
 * 普通的桌面浏览器（含 "X11; Linux" 的 Chrome、Firefox）不算：用户可能真有 Linux 电脑。只是提示，批准照样能批
 */
export function automatedAccess(userAgent: string): { reason: string } | undefined {
  const ua = userAgent.trim();
  if (ua === "") return { reason: t("protocol.pairing.automated.noUa") };
  for (const [pattern, what] of AUTOMATED_MARKS) {
    const word = pattern.exec(ua)?.[0];
    if (word) return { reason: t("protocol.pairing.automated.word", { word, what: AUTOMATED_WHAT[what] }) };
  }
  if (/https?:\/\//i.test(ua)) return { reason: t("protocol.pairing.automated.url") };
  if (!ua.startsWith("Mozilla/5.0 (")) {
    const quoted = ua.length > QUOTED_UA_MAX ? `${ua.slice(0, QUOTED_UA_MAX)}…` : ua;
    return { reason: t("protocol.pairing.automated.notBrowser", { ua: quoted }) };
  }
  return undefined;
}

/** 配对卡、批准页、纯文本降级上那句醒目的提示（137 号票） */
export function automatedAccessHint(reason: string): string {
  return t("protocol.pairing.automated.hint", { reason });
}

/** 规整用户给的设备名：去掉首尾空白、换行换成空格；空的或太长的不收（返回 undefined） */
export function normalizeDeviceName(name: string): string | undefined {
  const s = name.replace(/\s+/g, " ").trim();
  return s.length === 0 || s.length > DEVICE_NAME_MAX_LENGTH ? undefined : s;
}
