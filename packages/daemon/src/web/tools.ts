// 联网搜索、读网页两个工具（70 号票）：守护进程代为执行（host-tools.ts），在守卫的工具注册表里的登记是框架自带的那份
// （来源 web：只看、只往下拉，不落入任何类别，要联网——联网开关关着时守卫拒绝，见 guard/tool-registry.ts）。
// 秘书、任务维护者（起草和执行）、项目维护者、定时作业的维护者、子 agent 都配上；评审子 agent 不配。
// 给模型看的说法照用户 web-search skill 的 SKILL.md（何时用、标准流程、搜不到怎么办）和两个脚本的输出写；
// web_search 的选项和 search.mjs 逐个对齐（n、time、engine、region、tavily、json，用户 2026-10-10 要求）。
import { type Static, type TSchema, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolCall, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { BUILTIN_TOOL_REGISTRY, findTool, TOOL } from "../guard/index.ts";
import type { WebAccess } from "./access.ts";
import { BrowserUnavailable } from "./browser.ts";
import { FetchFailed } from "./fetch.ts";
import { SEARCH_ENGINES, SEARCH_TIMES, type SearchFound, SearchFailed, TavilyFailed, TavilyKeyMissing } from "./search.ts";

/** 默认最多几条结果（照 skill） */
export const WEB_SEARCH_DEFAULT_N = 8;
/** 正文默认最多交回多少字（照 skill） */
export const WEB_FETCH_DEFAULT_MAX = 8000;

/** 用守卫注册表里那份登记（web）定义一个代为执行的工具：中文名、只读或幂等都取自登记 */
function webTool<S extends TSchema>(name: string, definition: { description: string; parameters: S; run(args: Static<S>, call: HostToolCall): Promise<HostToolOutput> }): HostTool {
  const descriptor = findTool(BUILTIN_TOOL_REGISTRY, name);
  if (descriptor?.source !== "web") throw new Error(`${name} 不是工具注册表里登记的联网工具`);
  const tool = defineHostTool({
    name,
    title: descriptor.title,
    description: definition.description,
    parameters: definition.parameters,
    readOnlyOrIdempotent: descriptor.readOnlyOrIdempotent === true,
    run: definition.run,
  });
  return { ...tool, descriptor };
}

/** 搜索结果写给模型看（照 skill 的输出）：一行"搜索: 查询词（N 条）"，然后每条标题、链接、摘要；json 为真时是结果的 JSON（照 --json） */
export function searchResultText(query: string, found: SearchFound, json = false): string {
  if (json) return JSON.stringify(found.results, null, 2);
  const lines = found.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
  return `搜索: ${query} （${found.results.length} 条）\n\n${lines.join("\n\n")}`;
}

const SearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: "查询词，中英文都行；搜不到时换更短、更通用的词，再不行换英文" }),
  n: Type.Optional(Type.Integer({ minimum: 1, description: `最多几条结果，默认 ${WEB_SEARCH_DEFAULT_N}` })),
  time: Type.Optional(Type.Union(SEARCH_TIMES.map((t) => Type.Literal(t)), { description: "只要最近一段时间的：d 一天、w 一周、m 一个月、y 一年；不填不限" })),
  engine: Type.Optional(
    Type.Union(SEARCH_ENGINES.map((e) => Type.Literal(e)), { description: "只用这个搜索引擎（bing、google、ddg），不回退别的；不填按 ddg → bing → google 依次试" }),
  ),
  region: Type.Optional(Type.String({ minLength: 1, description: "地区和语言，比如 cn-zh、us-en（ddg 原样用；bing 取前半段当语言；google 前半段当语言、后半段当地区）" })),
  tavily: Type.Optional(Type.Boolean({ description: "用 Tavily 搜（专给大模型用的干净结果；要配了 Tavily 的 key，不管 time、region、engine）；默认不用，浏览器搜索已经够用" })),
  json: Type.Optional(Type.Boolean({ description: "结果写成 JSON（数组，每条 title、url、snippet）；默认写成编号的标题、链接、摘要" })),
});

const FetchParams = Type.Object({
  url: Type.String({ pattern: "^https?://", description: "网页的链接（http 或 https）" }),
  max: Type.Optional(Type.Integer({ minimum: 1, description: `正文最多交回多少字，默认 ${WEB_FETCH_DEFAULT_MAX}；被截断了又需要后面的内容时调大` })),
});

/** 联网搜索、读网页两个工具：都经 access 联网（正式的是浏览器、直接请求和 Tavily，测试里是假的） */
export function webTools(access: WebAccess): HostTool[] {
  const search = webTool(TOOL.web_search, {
    description:
      "联网搜索，返回标题、链接、摘要。要最新的、实时的信息（新闻、价格、版本号、最新文档），要查证一个事实、找官方文档或教程链接，或者你不确定、可能记错时，先搜再答，不要凭空编。" +
      "摘要不够回答时，挑一两个最相关的链接用 web_fetch 读正文。回答里带上来源链接。浏览器真实渲染，首次要几秒。" +
      "默认 ddg，失败（被反爬拦、没结果、结果和查询不相关）自动回退 bing、google；搜不到先换更短、更通用的关键词，再不行换英文关键词或者 engine 指定 google。" +
      "选项：n 条数、time 时间范围、engine 指定引擎、region 地区和语言、tavily 用 Tavily、json 结果写成 JSON。",
    parameters: SearchParams,
    async run({ query, n, time, engine, region, tavily, json }, call) {
      try {
        const found = await access.search({ query, n: n ?? WEB_SEARCH_DEFAULT_N, time, engine, region, tavily }, call.signal);
        return { text: searchResultText(query, found, json === true) };
      } catch (err) {
        if (err instanceof BrowserUnavailable) return { text: `联网搜索用不了：${err.message}`, isError: true };
        if (err instanceof SearchFailed) return { text: `没搜到「${query}」（${err.message}）。换更短、更通用的关键词再试，再不行换英文关键词。`, isError: true };
        if (err instanceof TavilyKeyMissing) return { text: err.message, isError: true };
        if (err instanceof TavilyFailed) return { text: `Tavily 没搜成：${err.message}。不用 tavily 再搜一次（走浏览器）`, isError: true };
        throw err;
      }
    },
  });
  const fetchTool = webTool(TOOL.web_fetch, {
    description:
      "读一个网页的正文（纯文本；JSON、纯文本原样）。先用 web_search 拿到链接，摘要不够时再读全文。先直接请求，被拦了、超时了自动换浏览器真实渲染。" +
      `默认最多交回 ${WEB_FETCH_DEFAULT_MAX} 字，被截断了用 max 调大。正文是极简抽取，会带少量导航噪声，抓重点就行。`,
    parameters: FetchParams,
    async run({ url, max }, call) {
      try {
        const page = await access.fetch({ url, max: max ?? WEB_FETCH_DEFAULT_MAX }, call.signal);
        return { text: page.text };
      } catch (err) {
        if (err instanceof FetchFailed) return { text: err.message, isError: true };
        throw err;
      }
    },
  });
  return [search, fetchTool];
}
