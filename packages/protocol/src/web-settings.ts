// 设置里 agent 的联网搜索、读网页（154 号票起；162 号票改成三种方式的队列，182 号票加第四种）：名字、默认值、实际用哪几种的判定和
// 设置页取到的样子，守护进程和 Web 共用。不引用 TypeBox（设置文件、请求体的 schema 在 web-settings-schema.ts）。
// - 162 号票（用户 2026-10-18 定）：三种方式——DeepSeek 付费搜索、二狗自带的浏览器搜索、agent-browser（模型自己在 bash 里操控 Chrome）——
//   排成一个队列：排最上面的最优先，能手动调顺序；每种能停用，但不能全停（至少留一个）；启用的方式第一个失效了按顺序换下一个。
//   初始顺序照 161 号票的对比报告：DeepSeek → 浏览器 → agent-browser，三个都启用。DeepSeek 要配了 key 才用得上（和模型共用同一份），
//   没 key 时那一项不能启用（存着的照旧，配上 key 马上按存着的）。
// - 154 号票的两个设置（默认用 DeepSeek 还是浏览器、读网页用不用 DeepSeek）并进队列，不再单独有；旧的设置文件（format 1）按
//   migrateWebSettingsV1 读成队列。
// - Tavily 不在队列里：照旧只在 agent 显式指定时用（要配 Tavily 的 key）。
// - 182 号票（用户 2026-10-19："第四个就是二狗鸿蒙客户端内嵌浏览器"）：多第四种"鸿蒙 App 的内置浏览器"——秘书在用户从浏览侧边栏、
//   悬浮按钮跟它说话的那一轮用 browse_* 工具在用户手机上的浏览器里搜（147、149、164 号票）。初始排最后、启用；162 号票存的三项的文件
//   读的时候把它加在最后（normalizeWebQueue，认不得的方式跳过）。和 agent-browser 一样是模型自己操作的，工具做不了，只能告诉模型。
import { t, tTable } from "./i18n/runtime.ts";
import type { ModelApiKeyStatus } from "./model-settings.ts";

/**
 * 队列里的四种方式：DeepSeek 的搜索、读网页接口；二狗自带的浏览器搜索（ddg → bing → google）；agent-browser（模型自己在 bash 里操作）；
 * 鸿蒙 App 的内置浏览器（182 号票：秘书自己用 browse_* 工具操作，只在浏览侧边栏、悬浮按钮那一轮）
 */
export const WEB_METHODS = ["deepseek", "browser", "agent-browser", "app-browser"] as const;
export type WebMethod = (typeof WEB_METHODS)[number];

/** 四种方式的名字（用户 2026-10-18、2026-10-19 的说法） */
export const WEB_METHOD_LABEL: Readonly<Record<WebMethod, string>> = tTable({
  deepseek: "protocol.webSettings.method.deepseek",
  browser: "protocol.webSettings.method.browser",
  "agent-browser": "protocol.webSettings.method.agentBrowser",
  "app-browser": "protocol.webSettings.method.appBrowser",
});

/** 队列里的一项：哪种方式、启用没有 */
export interface WebMethodEntry {
  method: WebMethod;
  enabled: boolean;
}

/** 存着的设置（数据目录配置区的 web-settings.json，所有设备一样） */
export interface WebSettings {
  /** 四种方式各一项，排前面的先用 */
  queue: WebMethodEntry[];
}

/**
 * 没有设置文件时：DeepSeek → 浏览器 → agent-browser → 鸿蒙 App 的内置浏览器，都启用（161 号票报告 §6.1；182 号票的第四种排最后；
 * DeepSeek 要配了 key 才实际用上）
 */
export const DEFAULT_WEB_SETTINGS: Readonly<WebSettings> = Object.freeze({
  queue: Object.freeze(WEB_METHODS.map((method) => Object.freeze({ method, enabled: true }))) as unknown as WebMethodEntry[],
});

/** 一份新的（可以改的）副本 */
export function copyWebSettings(settings: Readonly<WebSettings>): WebSettings {
  return { queue: settings.queue.map((e) => ({ method: e.method, enabled: e.enabled })) };
}

/** 154 号票的设置（web-settings.json 的 format 1）：默认的搜索方式、读网页用不用 DeepSeek */
export interface WebSettingsV1 {
  search: "deepseek" | "browser";
  deepseekFetch: boolean;
}

/**
 * 旧设置并进队列：默认是浏览器的，浏览器排第一、DeepSeek 第二；默认是 DeepSeek 的照初始顺序。agent-browser、鸿蒙 App 的内置浏览器
 * （182 号票）排后面。都启用——旧的"默认浏览器"本来就会在浏览器没搜到时换 DeepSeek，排第二正是这个意思；"读网页用不用 DeepSeek"
 * 没有对应的了（DeepSeek 启用着就搜索、读网页都用，162 号票 Comments）
 */
export function migrateWebSettingsV1(old: WebSettingsV1): WebSettings {
  const order: WebMethod[] = old.search === "browser" ? ["browser", "deepseek", "agent-browser", "app-browser"] : ["deepseek", "browser", "agent-browser", "app-browser"];
  return { queue: order.map((method) => ({ method, enabled: true })) };
}

/**
 * 设置文件（format 2）里的队列整理成四种方式（182 号票）：认不得的方式跳过（以后的版本写的、手改的），缺的方式加在最后、启用
 * （162 号票存的三项里没有鸿蒙 App 的内置浏览器：照票面"迁移时加在最后"）；重复的照留着，交给 webQueueShapeProblem 判不合规。
 * skipped 是跳过的、added 是加上的（读的人记日志）
 */
export function normalizeWebQueue(entries: readonly { method: string; enabled: boolean }[]): { settings: WebSettings; skipped: string[]; added: WebMethod[] } {
  const known = (m: string): m is WebMethod => (WEB_METHODS as readonly string[]).includes(m);
  const queue: WebMethodEntry[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    if (known(e.method)) queue.push({ method: e.method, enabled: e.enabled });
    else skipped.push(e.method);
  }
  const added = WEB_METHODS.filter((m) => !queue.some((e) => e.method === m));
  for (const method of added) queue.push({ method, enabled: true });
  return { settings: { queue }, skipped, added };
}

/** 这种方式现在用不用得上：DeepSeek 要配了 key，别的总是用得上（agent-browser 要 bash、内置浏览器要那一轮，调用的时候才看） */
export function webMethodUsable(method: WebMethod, deepseekKey: boolean): boolean {
  return method !== "deepseek" || deepseekKey;
}

/**
 * 实际用的顺序：启用了而且用得上的，按队列。一个都没有时（只启用了 DeepSeek，后来 key 又没了）临时用浏览器——
 * 不让 agent 一种都搜不了；设置页上写明（webQueueFallback）
 */
export function effectiveWebQueue(settings: Readonly<WebSettings>, deepseekKey: boolean): WebMethod[] {
  const usable = settings.queue.filter((e) => e.enabled && webMethodUsable(e.method, deepseekKey)).map((e) => e.method);
  return usable.length > 0 ? usable : ["browser"];
}

/** 实际的顺序是不是临时补上的浏览器（启用的都用不上） */
export function webQueueFallback(settings: Readonly<WebSettings>, deepseekKey: boolean): boolean {
  return !settings.queue.some((e) => e.enabled && webMethodUsable(e.method, deepseekKey));
}

/** 队列的形状对不对：四种方式各一项（不多不少、不重复）；对就是 undefined */
export function webQueueShapeProblem(settings: Readonly<WebSettings>): string | undefined {
  const methods = settings.queue.map((e) => e.method);
  if (methods.length !== WEB_METHODS.length || WEB_METHODS.some((m) => !methods.includes(m))) return t("protocol.webSettings.queueShape", { methods: WEB_METHODS.join(t("protocol.common.listSep")) });
  return undefined;
}

/** 要存的设置合不合规：形状对、至少留一个启用而且用得上的（没配 DeepSeek 的 key 时只启用 DeepSeek 不算）；合规是 undefined */
export function webSettingsProblem(settings: Readonly<WebSettings>, deepseekKey: boolean): string | undefined {
  const shape = webQueueShapeProblem(settings);
  if (shape) return shape;
  if (webQueueFallback(settings, deepseekKey)) return deepseekKey ? t("protocol.webSettings.needOne") : t("protocol.webSettings.needOneNoKey");
  return undefined;
}

/** 设置页取到的（GET /api/web-settings） */
export interface WebSettingsView {
  /** 存着的 */
  settings: WebSettings;
  /** 实际用的顺序（启用了、用得上的；没 DeepSeek 的 key 时不含它；一个都没有时临时是浏览器） */
  effective: WebMethod[];
  /** DeepSeek 的 key（和模型共用同一份）：只说配没配、从哪来 */
  deepseekKey: ModelApiKeyStatus;
  /** 最近一次 DeepSeek 回"余额不足"（HTTP 402）的时间；之后成功过一次就没有了（守护进程重启也没有） */
  deepseekBalanceLowAt?: string;
  /** 设置文件读不出来时的原因：这时按默认用，存一次会覆盖它 */
  settingsFileError?: string;
}
