// 按设置里的队列选方式（162 号票，用户 2026-10-18 定："需要用的时候，排最上面的最优先……enable 的搜索方式，如果第一个失效，
// 就转而使用下一个，按顺序切换"）。纯函数：输入是实际用的顺序（protocol 的 effectiveWebQueue：启用了、用得上的）和这一次调用能不能用
// 模型自己操作的方式，输出是 web_search / web_fetch 依次试哪几种。
// - web_search、web_fetch 自己能做的只有 DeepSeek 和浏览器；agent-browser、鸿蒙 App 的内置浏览器（182 号票）是模型自己操作的
//   （bash 里的命令、browse_* 工具），工具做不了，只能告诉模型：
//   - agent-browser 排第一：模型先用它（工具说明里写）；调了 web_search 就按后面的顺序试；
//   - 排中间：web_search 试到它前面为止，都没成就停下，回"接下来用它"并写明它后面的（再调时指定 engine）；
//   - 排最后：都没成时提示用它；
//   - 只启用了 agent-browser：web_search 不试别的，回"联网搜索现在只用 agent-browser"；
//   - 这一次用不了（agent-browser 要这个 agent 有 bash；内置浏览器要这一轮是秘书从浏览侧边栏、悬浮按钮来的）：当它不在队列里，
//     启用的都用不了时说明用不了。
// - 内置浏览器排第一时（182 号票验收："内置浏览器排第一时，web_search 停下让模型先用 browse_*"）web_search 一种都不试、直接停下——
//   和 agent-browser 排第一不一样：工具说明是装配时写的、不分哪一轮，模型不一定知道这一轮该先用它，靠 web_search 停下来告诉它
//   （连同搜索结果页的地址）。
// - web_fetch 没有指定方式的参数，模型自己操作的方式不打断它：直接请求之后按队列试 DeepSeek、浏览器，都没读到再提示它们。
// - 显式指定 engine（161 号票报告 §6.3，主会话 2026-10-19 定）：只能用启用着、用得上的；停用了的回"这种方式已停用"，没 key 的
//   DeepSeek 回没配 key。工具说明、参数里也只写这些（searchEngines），模型不会绕过队列去调。Tavily 不在队列里，配了 key 才写。
import type { WebMethod } from "@ergo/protocol";
import { SEARCH_ENGINES, type SearchEngine } from "./search.ts";

/** web_search、web_fetch 自己能做的方式 */
export type ToolMethod = "deepseek" | "browser";
/** 模型自己操作的方式（工具做不了，只能告诉模型）：bash 里的 agent-browser、秘书的 browse_* 工具（鸿蒙 App 的内置浏览器） */
export type ModelMethod = Exclude<WebMethod, ToolMethod>;

/** 接下来该模型自己用的方式：method 是它，rest 是排在它后面的（它也不成时按顺序用：工具的指定 engine，模型的照用） */
export interface NextModel {
  method: ModelMethod;
  rest: WebMethod[];
}

/**
 * web_search 不指定 engine 时：依次试 methods；next 是这些都没成（methods 是空的就是一个不试）时下一个是模型自己操作的方式。
 * 只启用了 agent-browser 时是 only_agent_browser（usable：这个 agent 用不用得了）；启用的只有模型自己操作的、这一次都用不了
 * 时是 unusable（methods 是启用着的那几种）
 */
export type SearchPlan =
  | { kind: "try"; methods: ToolMethod[]; next?: NextModel }
  | { kind: "only_agent_browser"; usable: boolean }
  | { kind: "unusable"; methods: ModelMethod[] };

export const isToolMethod = (m: WebMethod): m is ToolMethod => m === "deepseek" || m === "browser";

/**
 * web_search 不指定 engine 时依次试哪几种。queue 是实际用的顺序；agentBrowser 是这个 agent 有没有 bash；appBrowser 是这一轮能不能用
 * 鸿蒙 App 的内置浏览器（秘书、从浏览侧边栏或悬浮按钮来的那一轮，182 号票）
 */
export function searchPlan(queue: readonly WebMethod[], agentBrowser: boolean, appBrowser = false): SearchPlan {
  const usable = queue.filter((m) => isToolMethod(m) || (m === "agent-browser" ? agentBrowser : appBrowser));
  if (usable.length === 0) {
    const methods = queue.filter((m): m is ModelMethod => !isToolMethod(m));
    return methods.length === 1 && methods[0] === "agent-browser" ? { kind: "only_agent_browser", usable: false } : { kind: "unusable", methods };
  }
  // 排在最前面的 agent-browser：模型已经先用过它了（说明里写着先用它），调了 web_search 就接着往后试（162 号票）
  const start = usable[0] === "agent-browser" ? 1 : 0;
  const methods: ToolMethod[] = [];
  for (let i = start; i < usable.length; i++) {
    const m = usable[i]!;
    if (isToolMethod(m)) methods.push(m);
    else return { kind: "try", methods, next: { method: m, rest: usable.slice(i + 1) } };
  }
  return methods.length > 0 ? { kind: "try", methods } : { kind: "only_agent_browser", usable: true };
}

/**
 * web_fetch 在直接请求之后依次试哪几种；agentBrowser、appBrowser 是都没读到时提示用它们（启用着、这一次用得了）
 */
export function fetchPlan(queue: readonly WebMethod[], agentBrowser: boolean, appBrowser = false): { methods: ToolMethod[]; agentBrowser: boolean; appBrowser: boolean } {
  return { methods: queue.filter(isToolMethod), agentBrowser: agentBrowser && queue.includes("agent-browser"), appBrowser: appBrowser && queue.includes("app-browser") };
}

/** web_search 显式指定的 engine 属于哪种方式：deepseek 是 DeepSeek，browser 和 ddg / bing / google 是浏览器 */
export function engineMethod(engine: "deepseek" | "browser" | SearchEngine): ToolMethod {
  return engine === "deepseek" ? "deepseek" : "browser";
}

/** 显式指定的 engine 用不了的原因：这种方式在设置里停用了，或者 DeepSeek 没配 key；用得了是 undefined */
export function engineBlocked(engine: "deepseek" | "browser" | SearchEngine, queue: readonly WebMethod[], deepseekKey: boolean): { method: ToolMethod; why: "disabled" | "no_key" } | undefined {
  const method = engineMethod(engine);
  if (queue.includes(method)) return undefined;
  return { method, why: method === "deepseek" && !deepseekKey ? "no_key" : "disabled" };
}

/** web_search 的 engine 此刻能写的（按队列的顺序）：启用着、用得上的方式，浏览器连同 ddg / bing / google；配了 Tavily 的 key 再加 tavily */
export function searchEngines(queue: readonly WebMethod[], tavily: boolean): ("deepseek" | "browser" | SearchEngine | "tavily")[] {
  const engines = queue.flatMap((m): ("deepseek" | "browser" | SearchEngine)[] => (m === "deepseek" ? ["deepseek"] : m === "browser" ? ["browser", ...SEARCH_ENGINES] : []));
  return tavily ? [...engines, "tavily"] : engines;
}
