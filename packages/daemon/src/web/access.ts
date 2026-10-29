// 联网搜索、读网页的实现（70 号票）：两个工具只经这个接口联网，测试里整个换成假的（不起浏览器、不连真网络）。
// 正式的由 createWebAccess 拼成。154 号票起几种方式并列（用户 2026-10-18 定："deepseek 的这两个工具作为一种选择，不作为唯一方式"），
// 162 号票起按设置里的队列用（用户 2026-10-18 定：排最上面的最优先，第一个失效了按顺序换下一个；选哪几种的纯函数在 queue.ts）：
// - 搜索：不指定 engine 时按队列里启用的方式依次试（DeepSeek 的搜索接口 deepseek.ts、浏览器 search.ts 的 ddg → bing → google；
//   DeepSeek 没 key 时跳过），没成的换下一个，结果里写明前面的为什么没成、这次用的是哪种；agent-browser 是模型自己在 bash 里
//   操作的：排中间时试到它前面为止、停下让模型用它，只启用了它时不试别的（OnlyAgentBrowser）。engine 指定了启用着的方式就只用那一种，
//   没成就报；停用了的、没 key 的拒绝（WebMethodUnavailable，161 号票报告 §6.3）。Tavily 不在队列里，照旧只在指定时用。
// - 读网页（fetch.ts）：直接请求 → 队列里的 DeepSeek 读网页、浏览器（按队列的顺序，停用了的不用）；都没读到时 agent-browser
//   启用着的标出来（工具提示用它）。
// - 182 号票：鸿蒙 App 的内置浏览器也是模型自己操作的（秘书的 browse_* 工具），只在这一轮能用时（SearchRequest.appBrowser：秘书、
//   从浏览侧边栏或悬浮按钮来的那一轮）算数：搜索试到它为止、停下让模型用它（排第一时一种都不试，AllSearchesFailed 的 message 是空的）；
//   这一轮用不了时跳过它；启用的都是这一次用不了的模型方式时抛 SearchMethodsUnusable。读网页都没读到时同样标出来。
// 设置每次现取（设置页改了下一次就按新的）。
// @i18n-ignore-file model：这里的原因都进联网工具的结果、出错说明，给模型看（173 号票）
import { DEFAULT_WEB_SETTINGS, effectiveWebQueue, WEB_METHOD_LABEL, type WebSettings, forModel } from "@ergo/protocol";
import { type BrowserDriver, BrowserUnavailable } from "./browser.ts";
import { DeepSeekFailed, type DeepSeekTools } from "./deepseek.ts";
import { type FetchedPage, type FetchFunction, type FetchRequest, webFetch } from "./fetch.ts";
import { engineBlocked, fetchPlan, type ModelMethod, searchPlan, type NextModel, type ToolMethod } from "./queue.ts";
import { type PostFunction, SEARCH_ENGINES, type SearchFound, SearchFailed, type SearchQuery, searchTavily, webSearch } from "./search.ts";

/**
 * web_search 的 engine 能写的：deepseek（DeepSeek 的搜索接口）、browser（浏览器，ddg → bing → google 依次试）、
 * ddg / bing / google（只用这一个引擎的结果页）、tavily（Tavily 的接口）。162 号票起工具说明、参数里只给此刻能用的（queue.ts 的 searchEngines）
 */
export const WEB_SEARCH_ENGINES = ["deepseek", "browser", ...SEARCH_ENGINES, "tavily"] as const;
export type WebSearchEngine = (typeof WEB_SEARCH_ENGINES)[number];

/**
 * 一次搜索：查询、条数、时间、地区（search.ts 的 SearchQuery），engine 指定哪种方式；tavily 为真等于 engine 写 tavily（照 skill 的 --tavily）；
 * agentBrowser：发起调用的 agent 能用 agent-browser（有 bash，162 号票），队列里的 agent-browser 才算数；appBrowser：这一轮能用
 * 鸿蒙 App 的内置浏览器（182 号票：秘书、从浏览侧边栏或悬浮按钮来的那一轮），队列里的它才算数
 */
export interface SearchRequest extends Omit<SearchQuery, "engine"> {
  engine?: WebSearchEngine | undefined;
  tavily?: boolean | undefined;
  agentBrowser?: boolean | undefined;
  appBrowser?: boolean | undefined;
}

/** 一次读网页：网址、最多多少字；agentBrowser、appBrowser 同 SearchRequest（都没读到时提示用它们） */
export interface WebFetchRequest extends FetchRequest {
  agentBrowser?: boolean | undefined;
  appBrowser?: boolean | undefined;
}

/**
 * 按队列试的几种都没搜成：每种的原因（说法直接给模型看）。next：队列里接下来是模型自己操作的方式（agent-browser，182 号票起还有
 * 鸿蒙 App 的内置浏览器；rest 是排在它后面的、它也不成时再用的）。内置浏览器排在最前面时一种都没试，message 是空的
 */
export class AllSearchesFailed extends Error {
  override readonly name = "AllSearchesFailed";
  readonly next: NextModel | undefined;
  constructor(message: string, next?: NextModel) {
    super(message);
    this.next = next;
  }
}

/**
 * 设置里启用的只有模型自己操作的方式，这一次都用不了（182 号票）：methods 是启用着的那几种（agent-browser 要 bash，鸿蒙 App 的
 * 内置浏览器要秘书从浏览侧边栏、悬浮按钮来的那一轮）。只启用了 agent-browser 的照旧是 OnlyAgentBrowser
 */
export class SearchMethodsUnusable extends Error {
  override readonly name = "SearchMethodsUnusable";
  readonly methods: ModelMethod[];
  constructor(methods: ModelMethod[]) {
    super(`设置里联网搜索只启用了 ${methods.join("、")}，这一次都用不了`);
    this.methods = methods;
  }
}

/** 设置里联网搜索只启用了 agent-browser（162 号票）：web_search 不试别的；usable 是发起调用的 agent 用不用得了它（有没有 bash） */
export class OnlyAgentBrowser extends Error {
  override readonly name = "OnlyAgentBrowser";
  readonly usable: boolean;
  constructor(usable: boolean) {
    super("设置里联网搜索只启用了 agent-browser");
    this.usable = usable;
  }
}

/** engine 指定的方式用不了（162 号票）：在设置里停用了，或者 DeepSeek 没配 key */
export class WebMethodUnavailable extends Error {
  override readonly name = "WebMethodUnavailable";
  readonly method: ToolMethod;
  readonly why: "disabled" | "no_key";
  constructor(method: ToolMethod, why: "disabled" | "no_key") {
    // 交回 agent 的话：引的方式名在中文下取（协议包的标签跟着当前语言）
    super(forModel(() => (why === "no_key" ? `没配 DeepSeek 的 key，用不了 ${WEB_METHOD_LABEL.deepseek}` : `${WEB_METHOD_LABEL[method]}在设置里停用了`)));
    this.method = method;
    this.why = why;
  }
}

export interface WebAccess {
  /**
   * 搜索：搜到了交回引擎和结果（换了路的带 note）。按队列只试了一种、后面也没有 agent-browser 时照那一种抛（浏览器用不了
   * BrowserUnavailable、都没搜到 SearchFailed、DeepSeek 没成 DeepSeekFailed）；试了几种都没成、或者接下来是 agent-browser 时抛
   * AllSearchesFailed（接下来是内置浏览器、又一种都没试时 message 是空的）；只启用了 agent-browser 抛 OnlyAgentBrowser，启用的都是
   * 这一次用不了的模型方式抛 SearchMethodsUnusable；指定的方式停用了、没 key 抛 WebMethodUnavailable；
   * 指定 DeepSeek 没成抛 DeepSeekFailed；走 Tavily 时没配 key 抛 TavilyKeyMissing，没搜成抛 TavilyFailed
   */
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchFound>;
  /** 读网页：交回给模型的文字（已截断）；都没读到抛 FetchFailed（agentBrowser、appBrowser：提示用它们） */
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<FetchedPage>;
}

/** 浏览器没搜到的原因（一行） */
const browserWhy = (err: SearchFailed | BrowserUnavailable) => (err instanceof SearchFailed ? err.message : err.message.split("\n")[0]!);

/** 一种方式没成的样子：DeepSeek 没成是 DeepSeekFailed，浏览器没搜到是 SearchFailed、BrowserUnavailable；别的错照抛 */
function failureOf(method: ToolMethod, err: unknown): string | undefined {
  if (method === "deepseek") return err instanceof DeepSeekFailed ? err.message : undefined;
  return err instanceof SearchFailed || err instanceof BrowserUnavailable ? browserWhy(err) : undefined;
}

/** 说明里的叫法：DeepSeek 没搜成、浏览器没搜到；这次用的是 DeepSeek、浏览器（ddg） */
const failedText = (method: ToolMethod, why: string) => (method === "deepseek" ? `DeepSeek 没搜成（${why}）` : `浏览器没搜到（${why}）`);
const usedText = (found: SearchFound) => (found.engine === "deepseek" ? " DeepSeek" : `浏览器（${found.engine}）`);
const shortName = (method: ToolMethod) => (method === "deepseek" ? "DeepSeek" : "浏览器");

export function createWebAccess(deps: {
  browser: BrowserDriver;
  fetch?: FetchFunction;
  /** 调 Tavily 用的 POST；不给用 Node 的 fetch */
  post?: PostFunction;
  /** Tavily 的 key：只从守护进程的环境里取（LSM 从数据目录密钥区的文件注入，config/secrets.ts）；不给就是没配 */
  tavilyKey?: () => string | undefined;
  /** DeepSeek 的搜索、读网页接口（154 号票）；不给就没有这种方式（等于没 key） */
  deepseek?: DeepSeekTools;
  /** 设置里存着的队列（162 号票），每次现取；不给按默认 */
  settings?: () => Readonly<WebSettings>;
  log: (line: string) => void;
}): WebAccess {
  const fetchFn: FetchFunction = deps.fetch ?? ((url, init) => fetch(url, init));
  const post: PostFunction = deps.post ?? ((url, init) => fetch(url, init));
  const { deepseek, log } = deps;
  const hasKey = () => deepseek?.available() ?? false;
  /** 实际用的顺序：启用了、用得上的（没 DeepSeek 的 key 时不含它） */
  const queue = () => effectiveWebQueue(deps.settings?.() ?? DEFAULT_WEB_SETTINGS, hasKey());
  const viaBrowser = (query: SearchQuery, signal: AbortSignal | undefined) => webSearch(deps.browser, query, { signal, log });
  const run = (method: ToolMethod, query: SearchQuery, signal: AbortSignal | undefined) => (method === "deepseek" ? deepseek!.search(query, signal) : viaBrowser(query, signal));

  /** 按队列依次试：成了的带上前面没成的说明；都没成时只试了一种（后面也没有模型自己操作的）照那一种抛，不然 AllSearchesFailed */
  const inOrder = async (methods: readonly ToolMethod[], next: NextModel | undefined, query: SearchQuery, signal: AbortSignal | undefined): Promise<SearchFound> => {
    const failed: { method: ToolMethod; why: string; err: unknown }[] = [];
    for (const method of methods) {
      try {
        const found = await run(method, query, signal);
        if (failed.length === 0) return found;
        return { ...found, note: `${failed.map((f) => failedText(f.method, f.why)).join("；")}，这次用的是${usedText(found)}` };
      } catch (err) {
        const why = failureOf(method, err);
        if (why === undefined) throw err;
        signal?.throwIfAborted();
        failed.push({ method, why, err });
        log(`联网搜索：${failedText(method, why)}${methods.at(-1) === method ? "" : "，换下一个"}`);
      }
    }
    if (failed.length === 1 && !next) throw failed[0]!.err;
    throw new AllSearchesFailed(failed.map((f) => `${shortName(f.method)}：${f.why}`).join("；"), next);
  };

  return {
    search: async ({ tavily, engine, agentBrowser, appBrowser, ...query }, signal) => {
      if (tavily || engine === "tavily") return searchTavily(post, deps.tavilyKey?.(), query, signal);
      if (engine) {
        const blocked = engineBlocked(engine, queue(), hasKey());
        if (blocked) throw new WebMethodUnavailable(blocked.method, blocked.why);
        if (engine === "deepseek") return deepseek!.search(query, signal);
        return viaBrowser(engine === "browser" ? query : { ...query, engine }, signal);
      }
      const plan = searchPlan(queue(), agentBrowser === true, appBrowser === true);
      if (plan.kind === "only_agent_browser") throw new OnlyAgentBrowser(plan.usable);
      if (plan.kind === "unusable") throw new SearchMethodsUnusable(plan.methods);
      return inOrder(plan.methods, plan.next, query, signal);
    },
    fetch: ({ agentBrowser, appBrowser, ...request }, signal) => {
      const plan = fetchPlan(queue(), agentBrowser === true, appBrowser === true);
      return webFetch({ fetch: fetchFn, browser: deps.browser, ...(deepseek ? { deepseek } : {}), after: plan.methods, agentBrowser: plan.agentBrowser, appBrowser: plan.appBrowser }, request, { signal, log });
    },
  };
}
