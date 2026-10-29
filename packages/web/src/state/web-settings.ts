// 设置 · 浏览与填框里"agent 联网搜索、读网页"一节（154 号票；162 号票改成三种方式的队列，用户 2026-10-18 定："这三种方式的名称、
// 特点作为一个标签。三个标签在一个队列里面排序……排最上面的最优先。这三个也可以 disable，但是不能全部 disable，至少要保留一个"）：
// 页面上的说法和"改一处、存整份"的纯函数，界面（pages/more/WebToolsSetting.tsx）只管画。
// - 每一项：名字、一句话特点（161 号票报告 §6.2）、排第几、开关；能上移、下移（电脑上也能拖）；
// - 不能全停：剩最后一个启用的，它的开关点不了，写明原因；没配 DeepSeek 的 key 时那一项写明、关着、点不了（存着的不变）；
// - 设置存在守护进程（所有设备一样），每改一处就整份存回去（POST /api/web-settings），下一次搜索、读网页就按新的；
// - DeepSeek 回过余额不足（402）时写明哪会儿、这期间按顺序换了后面的。
// 182 号票（用户 2026-10-19："你把那个英文的工具名列出来，第四个就是二狗鸿蒙客户端内嵌浏览器"）：多第四种"鸿蒙 App 的内置浏览器"；
// 每张标签写上用的英文工具名（webMethodTools）。DeepSeek 和浏览器用的是同一对 web_search、web_fetch（用户问"怎么区分"）：
// 写出各自的 engine，说明里写不写 engine 时按队列挑、结果的标题写着实际用了哪种。
import { clockLabel } from "@ergo/protocol";
import { ASSISTANT_NAME_MARK, BUILTIN_WEB_CALL_PRICES, copyWebSettings, t, tParts, WEB_METHOD_LABEL, type WebMethod, webQueueFallback, type WebSettings, type WebSettingsBody, type WebSettingsView } from "./protocol.ts";

/** 每次多少钱（元），说法里用 */
const PER_CALL = BUILTIN_WEB_CALL_PRICES["deepseek/search"] ?? 0.005;

/** 四种方式各一句特点（161 号票报告 §6.2，照用户给的样子"免费 · 中等速度 · 只能搜和读"；第四种是 182 号票的初稿）；170 号票起取值时按当前语言现取 */
export const WEB_METHOD_TRAIT: Readonly<Record<WebMethod, string>> = Object.freeze({
  get deepseek() {
    return t("state.webSettings.trait.deepseek", { price: PER_CALL });
  },
  get browser() {
    return t("state.webSettings.trait.browser");
  },
  get "agent-browser"() {
    return t("state.webSettings.trait.agentBrowser");
  },
  get "app-browser"() {
    return t("state.webSettings.trait.appBrowser");
  },
});

/** 标签上"用的英文工具名"那一行的一段（182 号票）：字、工具名（等宽）、engine 的写法（小一号的等宽） */
export interface WebToolPart {
  kind: "text" | "tool" | "engine";
  text: string;
}

const tool = (text: string): WebToolPart => ({ kind: "tool", text });

/**
 * 这种方式用哪些英文工具（182 号票）：DeepSeek、浏览器是 web_search（写各自的 engine）、web_fetch（直接请求被拦时由它代读）；
 * agent-browser 是 bash 里的命令；内置浏览器是秘书的 browse_* 工具。句子按当前语言（工具名、engine 原样）
 */
export function webMethodTools(method: WebMethod): WebToolPart[] {
  const parts =
    method === "deepseek" || method === "browser"
      ? tParts("state.webSettings.tools.searchFetch", {
          search: tool("web_search"),
          engine: { kind: "engine", text: method === "deepseek" ? "engine: deepseek" : "engine: browser / ddg / bing / google" },
          fetch: tool("web_fetch"),
        })
      : method === "agent-browser"
        ? tParts("state.webSettings.tools.agentBrowser", { command: tool("agent-browser") })
        : tParts("state.webSettings.tools.appBrowser", {
            open: tool("browse_open"),
            read: tool("browse_read_page"),
            snapshot: tool("browse_snapshot"),
            click: tool("browse_click"),
            fill: tool("browse_fill"),
            attach: tool("browse_attach_files"),
          });
  return parts.map((p) => (typeof p === "string" ? { kind: "text", text: p } : (p as WebToolPart)));
}

// 170 号票：页面上的几句说明原来是模块顶层的常量，改成函数（按当前语言现取）

/** 这一节最上面的说明（说到秘书的地方用名字占位，界面换成名字） */
export function webQueueIntro(): string {
  return t("state.webSettings.queueIntro", { name: ASSISTANT_NAME_MARK });
}

/** 这一节最下面的说明（说到秘书的地方用名字占位，界面换成名字） */
export function webToolsHint(): string {
  return t("state.webSettings.toolsHint", { name: ASSISTANT_NAME_MARK });
}

/** 队列里的一行 */
export interface WebQueueRow {
  method: WebMethod;
  label: string;
  /** 用的英文工具名那一行（182 号票） */
  tools: WebToolPart[];
  trait: string;
  /** 排第几（1 起） */
  rank: number;
  /** 开关开着：启用了而且用得上（实际的顺序里有它） */
  on: boolean;
  /** 开关点不了：没配 key 的 DeepSeek、最后一个启用的 */
  locked: boolean;
  /** 点不了的原因，或者临时用着的说明 */
  note?: string;
  canUp: boolean;
  canDown: boolean;
}

/** 队列的每一行：名字、特点、排第几、开关开没开、点不点得了（为什么）、能不能上移下移 */
export function webQueueRows(view: WebSettingsView): WebQueueRow[] {
  const hasKey = view.deepseekKey.configured;
  const fallback = webQueueFallback(view.settings, hasKey);
  const count = view.settings.queue.length;
  return view.settings.queue.map(({ method }, i) => {
    const on = view.effective.includes(method);
    const noKey = method === "deepseek" && !hasKey;
    const last = on && view.effective.length === 1;
    // 没配 key 的 DeepSeek、启用的都用不上时临时用着的浏览器、最后一个启用的
    const note = noKey ? t("state.webSettings.noKey") : fallback && on ? t("state.webSettings.fallbackBrowser") : last ? t("state.webSettings.lastEnabled") : undefined;
    return { method, label: WEB_METHOD_LABEL[method], tools: webMethodTools(method), trait: WEB_METHOD_TRAIT[method], rank: i + 1, on, locked: noKey || last, ...(note ? { note } : {}), canUp: i > 0, canDown: i < count - 1 };
  });
}

/** 要存的整份：从存着的抄一份；启用的都用不上、临时用着浏览器时把浏览器一并存成启用（看到的是开着的，存下来也是） */
function bodyOf(view: WebSettingsView): WebSettings {
  const body = copyWebSettings(view.settings);
  if (webQueueFallback(view.settings, view.deepseekKey.configured)) {
    for (const e of body.queue) if (e.method === "browser") e.enabled = true;
  }
  return body;
}

/** 开关：只改那一项（整份） */
export function withWebMethodEnabled(view: WebSettingsView, method: WebMethod, enabled: boolean): WebSettingsBody {
  const body = bodyOf(view);
  for (const e of body.queue) if (e.method === method) e.enabled = enabled;
  return body;
}

/** 换位置：第 from 项挪到第 to 项（上移是 i → i-1，下移是 i → i+1，拖动是拖起的 → 放下的；整份） */
export function withWebMethodMoved(view: WebSettingsView, from: number, to: number): WebSettingsBody {
  const body = bodyOf(view);
  const [moved] = body.queue.splice(from, 1);
  if (moved) body.queue.splice(Math.max(0, Math.min(to, body.queue.length)), 0, moved);
  return body;
}

/** 现在实际的顺序：一句话；没配 key、存着启用 DeepSeek 时写明跳过它 */
export function webQueueSummary(view: WebSettingsView): string {
  const skipped = !view.deepseekKey.configured && view.settings.queue.some((e) => e.method === "deepseek" && e.enabled);
  const order = view.effective.map((m) => WEB_METHOD_LABEL[m]).join(" → ");
  return skipped ? t("state.webSettings.orderSkipped", { order }) : t("state.webSettings.order", { order });
}

/** DeepSeek 回过余额不足时的提醒（之后成功过一次就没有了） */
export function webBalanceText(view: WebSettingsView): string | undefined {
  if (!view.deepseekBalanceLowAt) return undefined;
  return t("state.webSettings.balanceLow", { date: view.deepseekBalanceLowAt.slice(5, 10), clock: clockLabel(view.deepseekBalanceLowAt) });
}

/** 设置文件读不出来时最上面写的 */
export function webSettingsFileBrokenNote(): string {
  return t("state.webSettings.fileBroken");
}
