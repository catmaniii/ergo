// 联网搜索、读网页两个工具（70 号票）：守护进程代为执行（host-tools.ts），在守卫的工具注册表里的登记是框架自带的那份
// （来源 web：只看、只往下拉，不落入任何类别，要联网——联网开关关着时守卫拒绝，见 guard/tool-registry.ts）。
// 秘书、任务维护者（起草和执行）、项目维护者、定时作业的维护者、子 agent 都配上；评审子 agent 不配。
// 给模型看的说法照用户 web-search skill 的 SKILL.md（何时用、标准流程、搜不到怎么办）和两个脚本的输出写；
// web_search 的选项和 search.mjs 逐个对齐（n、time、engine、region、tavily、json，用户 2026-10-10 要求）。
// 154 号票：engine 多了 deepseek（DeepSeek 的搜索接口）、browser（浏览器的整条回退链）、tavily。
// DeepSeek 的结果多写站点、日期、长摘要和"优质""权威"的提示，json 给原样的字段；换了路的写一句说明。
// DeepSeek 只对成功、有结果的调用计费，"结果来自 DeepSeek"就是计费了：交给 onBilled 记账（记在发起调用的 agent 名下，daemon.ts 接账本）。
// 162 号票（设置里的联网搜索改成 DeepSeek、浏览器、agent-browser 三种方式的队列）：
// - 工具说明、能写的 engine 每次装配时按队列现写（setup）：写明用户排的顺序；停用了的、没配 key 的方式不写、engine 里也没有
//   （161 号票报告 §6.3：模型看到说明里有 deepseek 就自己去指定），Tavily 配了 key 才写；
// - agent-browser 是模型自己在 bash 里操作的，它在队列里的位置写进说明（这个 agent 有 bash 时）：排第一先用它、排中间 / 最后什么时候用、
//   停用了别拿它搜（skill 照旧能操作网页、下载文件）、只启用了它时别调 web_search；都附上"别用管道接它的输出"（161 号票报告 §5.1）；
// - 结果的标题行写明用了哪种；只用 agent-browser、指定的方式停用了、试到 agent-browser 为止、读网页都没读到时说清楚接下来怎么办。
// 182 号票（队列多第四种"鸿蒙 App 的内置浏览器"：秘书在浏览侧边栏、悬浮按钮那一轮用 browse_* 工具在用户手机上的浏览器里搜）：
// - 只给有 browse_* 工具的 agent（秘书）写它：工具说明是装配时写的、不分哪一轮（换说明要重新装配，前缀缓存失效，147 号票就为此
//   没按轮换工具），所以说明写清"只在侧边栏、悬浮按钮那一轮算数、那一轮的顺序"，那一轮交给秘书的输入后面再加一句（appBrowserTurnNote）；
// - 那一轮（appBrowser(call) 给出发消息那台设备的搜索引擎）web_search 试到它为止、停下，给出那台设备"浏览"里的搜索引擎的结果页地址，
//   让秘书 browse_open 打开再读、看、点；排第一时一种都不试（验收："内置浏览器排第一时，web_search 停下让模型先用 browse_*"）；
// - 停用了：说明里写别拿它搜索，用户明确要操作网页时 browse_* 照旧能用（和 agent-browser 一样）。
// @i18n-ignore-file model：工具说明、参数说明、结果和出错的说明都是给模型看的（173 号票）；工具的名字在守卫的工具注册表里
import { type BrowseSearchEngineId, browseSearchUrl, type Static, type TSchema, Type, WEB_METHODS, type WebCallKind, type WebCallService, type WebMethod } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolCall, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { BROWSE_CLICK_TOOL, BROWSE_OPEN_TOOL, BROWSE_READ_PAGE_TOOL, BROWSE_SNAPSHOT_TOOL } from "../browsing/api.ts";
import { BUILTIN_TOOL_REGISTRY, findTool, TOOL } from "../guard/index.ts";
import { AllSearchesFailed, OnlyAgentBrowser, SearchMethodsUnusable, type WEB_SEARCH_ENGINES, type WebAccess, WebMethodUnavailable, type WebSearchEngine } from "./access.ts";
import { BrowserUnavailable } from "./browser.ts";
import { DEEPSEEK_AUTHORITY_HIGH, DEEPSEEK_GOOD_SCORE, DeepSeekFailed } from "./deepseek.ts";
import { FetchFailed } from "./fetch.ts";
import { isToolMethod, type ModelMethod, searchEngines, searchPlan, type ToolMethod } from "./queue.ts";
import { SEARCH_TIMES, type SearchFound, type SearchResult, SearchFailed, type SearchTime, TavilyFailed, TavilyKeyMissing } from "./search.ts";

/** 默认最多几条结果（照 skill） */
export const WEB_SEARCH_DEFAULT_N = 8;
/** 正文默认最多交回多少字（照 skill） */
export const WEB_FETCH_DEFAULT_MAX = 8000;

/** 一次按次计费的联网调用（154 号票）：哪家的接口、搜索还是读网页、哪个 agent 发起的（不知道是 undefined） */
export interface WebBilledCall {
  service: WebCallService;
  kind: WebCallKind;
  agentId: string | undefined;
}

/** 设置里的队列此刻的样子（162 号票）：工具说明、能写的 engine 按它 */
export interface WebToolsSetup {
  /** 实际用的顺序（protocol 的 effectiveWebQueue：启用了、用得上的） */
  queue: readonly WebMethod[];
  /** 配了 Tavily 的 key（不在队列里，只在指定时用） */
  tavily: boolean;
}

/** 不给 setup 时：初始的顺序、都用得上（单测用） */
const ALL_AVAILABLE: WebToolsSetup = { queue: WEB_METHODS, tavily: true };

/**
 * 这一轮能用鸿蒙 App 的内置浏览器（182 号票：秘书、从浏览侧边栏或悬浮按钮来的那一轮、发消息的那台设备还连着）：那台设备"浏览"里
 * 在用的搜索引擎（拼结果页的地址）
 */
export interface AppBrowserTurn {
  engine: BrowseSearchEngineId;
}

/** 说明里的叫法 */
const NAME: Readonly<Record<WebMethod, string>> = { deepseek: "DeepSeek", browser: "浏览器", "agent-browser": "agent-browser", "app-browser": "鸿蒙 App 的内置浏览器" };
const AB = "agent-browser（浏览器命令行，在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）";
const AB_USE = "在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core";
const AB_PIPE = "用 agent-browser 时别用管道接它的输出（| head、| cat 会卡住），把输出重定向到文件再读（比如 agent-browser … > ab.txt 2>&1）。";
const ENABLE_OTHERS = "要联网查资料，告诉用户去设置 · 浏览与填框里启用别的方式。";
const APP = NAME["app-browser"];
/** 用内置浏览器搜：打开什么（"它"是结果页的地址）、再怎么看 */
const APP_LOOK = `再用 ${BROWSE_READ_PAGE_TOOL} 读、${BROWSE_SNAPSHOT_TOOL} 和 ${BROWSE_CLICK_TOOL} 看和点`;
const APP_TURNS = "只在用户从浏览侧边栏、悬浮按钮跟你说话的那一轮";
/** "浏览"的搜索引擎的说法（给模型看） */
const ENGINE_NAME: Readonly<Record<BrowseSearchEngineId, string>> = { bing: "必应", baidu: "百度", sogou: "搜狗", google: "谷歌" };

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

/** DeepSeek 结果的一条：站点、日期、"优质"（相关度 ≥ 1.5）、"权威"（权威度 ≥ 3）写成一行，下面是长摘要（没有用短摘要） */
function deepseekBlock(r: SearchResult, i: number): string {
  const meta = [r.site, r.date, (r.score ?? 0) >= DEEPSEEK_GOOD_SCORE ? "优质" : undefined, (r.authority ?? -1) >= DEEPSEEK_AUTHORITY_HIGH ? "权威" : undefined].filter(Boolean).join(" · ");
  return [`${i + 1}. ${r.title}`, `   ${r.url}`, ...(meta ? [`   ${meta}`] : []), `   ${r.summary || r.snippet}`].join("\n");
}

/** 标题行里写的"用了哪种"（162 号票）：DeepSeek、浏览器 ddg、Tavily */
const usedName = (found: SearchFound) => (found.engine === "deepseek" ? "DeepSeek" : found.engine === "tavily" ? "Tavily" : `浏览器 ${found.engine}`);

/**
 * 搜索结果写给模型看（照 skill 的输出）：一行"搜索: 查询词（用了哪种，N 条）"，然后每条标题、链接、摘要；json 为真时是结果的 JSON（照 --json）。
 * DeepSeek 的（154 号票）：实际查询加了 after:、lang: 时写出来，每条多一行站点 · 日期 · 优质 · 权威、摘要用长摘要；
 * json 是 DeepSeek 原样的字段。换了路的在标题行下面写一句说明
 */
export function searchResultText(query: string, found: SearchFound, json = false): string {
  if (json) return JSON.stringify(found.engine === "deepseek" && found.raw ? found.raw : found.results, null, 2);
  const deepseek = found.engine === "deepseek";
  const head = [
    `搜索: ${query} （${usedName(found)}，${found.results.length} 条）`,
    ...(deepseek && found.query && found.query !== query.trim() ? [`实际查询: ${found.query}`] : []),
    ...(found.note ? [`说明: ${found.note}`] : []),
  ];
  const lines = found.results.map((r, i) => (deepseek ? deepseekBlock(r, i) : `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`));
  return `${head.join("\n")}\n\n${lines.join("\n\n")}`;
}

/** 夹在中文里的名字：开头、结尾是英文的那一侧加空格（"按浏览器 → DeepSeek 的顺序"、"排在 DeepSeek 后面"）；后面紧跟标点时 trailing 给 false */
const spaced = (text: string, trailing = true) => `${/^[A-Za-z0-9]/.test(text) ? " " : ""}${text}${trailing && /[A-Za-z0-9]$/.test(text) ? " " : ""}`;

/**
 * agent-browser 在队列里的位置写成一两句（这个 agent 有 bash 时；queue 里至少有一种工具自己能做的，不含鸿蒙 App 的内置浏览器——
 * 它只在侧边栏、悬浮按钮那一轮算数，那一轮的顺序由 appBrowserHint 另写）
 */
function agentBrowserHint(queue: readonly WebMethod[]): string {
  const at = queue.indexOf("agent-browser");
  if (at < 0) return `agent-browser 在设置里停用了联网搜索：别拿它来搜索；操作网页、下载文件照旧能用它。${AB_PIPE}`;
  const before = queue.slice(0, at) as ToolMethod[];
  const after = queue.slice(at + 1) as ToolMethod[];
  const tail = `下载图片、PDF 这类文件用 agent-browser 或 bash（web_fetch 只读文字）。${AB_PIPE}`;
  if (at === 0) return `agent-browser 排第一：搜索、下载先用 ${AB}，用不成再调 web_search（按${spaced(after.map((m) => NAME[m]).join(" → "))}的顺序试）。${tail}`;
  if (after.length === 0) return `web_search 都没搜成时再用 ${AB}搜。${tail}`;
  const names = before.map((m) => NAME[m]).join("、");
  return `agent-browser 排在${spaced(names)}后面：不填 engine 时 web_search 只试${spaced(names, false)}，没成就停下，这时用 ${AB}搜；还不成再调 web_search，engine ${after.length === 1 ? `写 ${after[0]}` : `依次写 ${after.join("、")}`}。${tail}`;
}

/** 内置浏览器那一轮的顺序：agent-browser 只在这个 agent 有 bash 时算 */
const sideOrder = (queue: readonly WebMethod[], agentBrowser: boolean) => queue.filter((m) => m !== "agent-browser" || agentBrowser);

/**
 * 鸿蒙 App 的内置浏览器在队列里的位置（182 号票；只给有 browse_* 工具的 agent，就是秘书）：说明是装配时写的、不分哪一轮，所以写清
 * 只在侧边栏、悬浮按钮那一轮算数、那一轮的顺序和 web_search 什么时候停下；停用了写别拿它搜索、操作网页照旧能用
 */
function appBrowserHint(queue: readonly WebMethod[], agentBrowser: boolean): string {
  if (!queue.includes("app-browser")) return `${APP}在设置里停用了联网搜索：别拿它来搜索；用户明确要你在网页上点、填框、交文件时 browse_* 工具照旧能用（停用只是不拿它来搜索）。`;
  const side = sideOrder(queue, agentBrowser);
  const head = `${APP}（用户手机上二狗 App「浏览」里的浏览器，用户看得见你在做什么）${APP_TURNS}算进联网搜索的顺序，别的轮次跳过它、web_search 照其余的顺序试。`;
  const open = `用 ${BROWSE_OPEN_TOOL} 打开它或者目标网站，${APP_LOOK}`;
  const plan = searchPlan(queue, agentBrowser, true);
  const order = side[0] === "app-browser" ? "那一轮它排第一：" : `那一轮的顺序是 ${side.map((m) => NAME[m]).join(" → ")}：`;
  if (plan.kind !== "try" || plan.next?.method !== "app-browser") return `${head}${order}它排在后面，前面的都没成时再用（web_search 停下时会写明，给出搜索结果页的地址），${open}。`;
  const stop =
    plan.methods.length === 0
      ? "不填 engine 调 web_search 会直接停下、给出搜索结果页的地址（用户在「浏览」里设的搜索引擎），这时"
      : `不填 engine 时 web_search 只试${spaced(plan.methods.map((m) => NAME[m]).join("、"), false)}，没成就停下、给出搜索结果页的地址（用户在「浏览」里设的搜索引擎），这时`;
  return `${head}${order}${stop}${open}；还不成再照 web_search 停下时说的往后用。`;
}

/** 启用的只有模型自己操作的方式时（队列里没有 DeepSeek、浏览器）说明里的那句 */
function onlyModelText(queue: readonly WebMethod[], agentBrowser: boolean, appBrowser: boolean): string {
  const models = queue.filter((m): m is ModelMethod => !isToolMethod(m));
  const onlyAb =
    agentBrowser
      ? `用户在设置里只启用了 agent-browser 来联网搜索：用 ${AB}搜索、下载，不要调 web_search（会直接回“只用 agent-browser”）；读网页可以先用 web_fetch。${AB_PIPE}`
      : `用户在设置里只启用了 agent-browser 来联网搜索，你这里没有 bash，用不了它，也就搜不了；${ENABLE_OTHERS}`;
  if (models.length === 0) return "用户在设置里停用了联网搜索的各种方式。";
  if (models.length === 1 && models[0] === "agent-browser") return onlyAb;
  const appUse = `${APP_TURNS}能用——那一轮调 web_search 会直接停下、给出搜索结果页的地址，用 ${BROWSE_OPEN_TOOL} 打开它或者目标网站，${APP_LOOK}`;
  if (models.length === 1) return appBrowser ? `用户在设置里只启用了${APP}来联网搜索：${appUse}；别的轮次搜不了，${ENABLE_OTHERS}` : `用户在设置里只启用了${APP}来联网搜索，你这里用不了它，也就搜不了；${ENABLE_OTHERS}`;
  // 两种都启用了
  return [
    `用户在设置里只启用了${spaced(models.map((m) => NAME[m]).join(" → "))}来联网搜索。`,
    agentBrowser ? `用 ${AB}搜索、下载；${AB_PIPE}` : "你这里没有 bash，用不了 agent-browser。",
    appBrowser ? `${APP}${appUse}。` : `你这里用不了${APP}。`,
    agentBrowser || appBrowser ? "" : ENABLE_OTHERS,
  ].join("");
}

/**
 * 侧边栏、悬浮按钮那一轮交给秘书的输入后面加的一句（182 号票，agent-input.ts 接在网页上下文那段里）：这一轮联网搜索算上鸿蒙 App 的
 * 内置浏览器、设置里的顺序；停用了不写（undefined）。queue 是实际用的顺序，秘书有 bash，agent-browser 照算
 */
export function appBrowserTurnNote(queue: readonly WebMethod[]): string | undefined {
  if (!queue.includes("app-browser")) return undefined;
  return `这一轮联网搜索算上${APP}（设置里的顺序：${queue.map((m) => NAME[m]).join(" → ")}）：轮到它时 web_search 会停下、给出搜索结果页的地址，用 ${BROWSE_OPEN_TOOL} 打开它或者目标网站再看、点。`;
}

/**
 * web_search 的说明（162 号票起按队列现写）：setup 是设置里的队列，agentBrowser 是这个 agent 能不能用 agent-browser（有 bash；
 * 不给是不知道，不提 agent-browser），appBrowser 是这个 agent 有没有 browse_* 工具（秘书，182 号票：不给就不提鸿蒙 App 的内置浏览器）
 */
export function webSearchDescription(setup: WebToolsSetup, agentBrowser?: boolean, appBrowser?: boolean): string {
  const intro =
    "联网搜索，返回标题、链接、摘要。要最新的、实时的信息（新闻、价格、版本号、最新文档），要查证一个事实、找官方文档或教程链接，或者你不确定、可能记错时，先搜再答，不要凭空编。" +
    "摘要不够回答时，挑一两个最相关的链接用 web_fetch 读正文。回答里带上来源链接。";
  const queue = setup.queue.filter((m) => (m === "agent-browser" ? agentBrowser === true : m === "app-browser" ? appBrowser === true : true));
  const tools = queue.filter(isToolMethod);
  const engines = searchEngines(setup.queue, setup.tavily);
  const options = `选项：n 条数、time 时间范围、${engines.length > 0 ? "engine 指定方式、" : ""}region 地区和语言、${setup.tavily ? "tavily 用 Tavily、" : ""}json 结果写成 JSON。`;
  if (tools.length === 0) {
    const why = onlyModelText(setup.queue, agentBrowser === true, appBrowser === true);
    return `${intro}${why}${setup.tavily ? "tavily：Tavily 的接口（只在 engine 写 tavily 时用）。" : ""}${options}`;
  }
  const parts = [
    intro,
    `用户在设置里排的联网搜索顺序：${queue.map((m) => NAME[m]).join(" → ")}，排前面的先用。不填 engine 时按这个顺序试，没搜成自动换下一个，结果里写明用了哪种、前面的为什么没成。`,
    ...(tools.includes("deepseek")
      ? [
          "deepseek：DeepSeek 的搜索接口，快、结果干净，带长摘要、日期、站点，标「优质」的和问题很相关、标「权威」的来源权威；按次计费；" +
            "query 里能写搜索语法 site:域名、-site:域名、\"精确短语\"、-排除词、lang:zh,en、after:2025-01-01、before:2026。",
        ]
      : []),
    ...(tools.includes("browser") ? ["browser：浏览器真实渲染搜索结果页，不花钱，首次要几秒，ddg → bing → google 依次试；要某个引擎自己的结果页时 engine 写 ddg、bing 或 google（只用它，不回退）。"] : []),
    ...(setup.tavily ? ["tavily：Tavily 的接口（只在 engine 写 tavily 时用）。"] : []),
    "engine 只能写上面这几种，写了就只用那一种、没成不换。",
    ...(agentBrowser === true ? [agentBrowserHint(setup.queue.filter((m) => m !== "app-browser"))] : []),
    ...(appBrowser === true ? [appBrowserHint(setup.queue, agentBrowser === true)] : []),
    "搜不到先换更短、更通用的关键词，再不行换英文关键词或者换一种方式。",
    options,
  ];
  return parts.join("");
}

/** web_fetch 的说明（162 号票起按队列现写直接请求之后换哪几条；appBrowser 同 webSearchDescription） */
export function webFetchDescription(setup: WebToolsSetup, agentBrowser?: boolean, appBrowser?: boolean): string {
  const tools = setup.queue.filter(isToolMethod);
  const way: Record<ToolMethod, string> = { deepseek: "让 DeepSeek 读（回 Markdown，按次计费）", browser: "用浏览器真实渲染" };
  const ab = agentBrowser === true && setup.queue.includes("agent-browser") ? "，这时用 agent-browser 打开网页读" : "";
  const app = appBrowser === true && setup.queue.includes("app-browser") ? `；从浏览侧边栏、悬浮按钮来的那一轮还能用 ${BROWSE_OPEN_TOOL} 在${APP}里打开、${BROWSE_READ_PAGE_TOOL} 读` : "";
  const then =
    tools.length === 0
      ? `只直接请求（用户在设置里停用了 DeepSeek 和浏览器），被拦了就读不到${ab}${app}。`
      : tools.length === 1
        ? `先直接请求，被拦了、超时了${way[tools[0]!]}。`
        : `先直接请求，被拦了、超时了按设置里的顺序换：先${way[tools[0]!]}，再不行${way[tools[1]!]}。`;
  return (
    "读一个网页的正文（纯文本或 Markdown；JSON、纯文本原样）。先用 web_search 拿到链接，摘要不够时再读全文。" +
    then +
    `默认最多交回 ${WEB_FETCH_DEFAULT_MAX} 字，被截断了用 max 调大。直接请求、浏览器读到的正文是极简抽取，会带少量导航噪声，抓重点就行。`
  );
}

/** web_search 的参数（全的；162 号票起 engine 只给此刻能写的，一种都没有时不给，tavily 配了 key 才给） */
function searchParams(setup: WebToolsSetup) {
  const engines = searchEngines(setup.queue, setup.tavily);
  const engineNote: Record<(typeof WEB_SEARCH_ENGINES)[number], string> = {
    deepseek: "deepseek（DeepSeek 的搜索接口）",
    browser: "browser（浏览器，ddg → bing → google 依次试）",
    ddg: "ddg",
    bing: "bing",
    google: "google",
    tavily: "tavily（Tavily 的接口）",
  };
  const listed = engines.filter((e) => e !== "bing" && e !== "google").map((e) => (e === "ddg" ? "ddg / bing / google（只用这一个引擎的结果页，不回退）" : engineNote[e]));
  return Type.Object({
    query: Type.String({
      minLength: 1,
      description: `查询词，中英文都行；搜不到时换更短、更通用的词，再不行换英文。${engines.includes("deepseek") ? "走 DeepSeek 时能写搜索语法：site:域名、-site:域名、\"精确短语\"、-排除词、lang:zh,en、after:2025-01-01、before:2026" : ""}`,
    }),
    n: Type.Optional(Type.Integer({ minimum: 1, description: `最多几条结果，默认 ${WEB_SEARCH_DEFAULT_N}${engines.includes("deepseek") ? "（DeepSeek 最多 50）" : ""}` })),
    time: Type.Optional(Type.Union(SEARCH_TIMES.map((t) => Type.Literal(t)), { description: "只要最近一段时间的：d 一天、w 一周、m 一个月、y 一年；不填不限（DeepSeek 换成 after:日期）" })),
    ...(engines.length > 0
      ? {
          engine: Type.Optional(
            Type.Union(
              engines.map((e) => Type.Literal(e)),
              { description: `用哪种方式搜，只能写设置里启用着的：${listed.join("、")}；不填按设置里的顺序，没搜成自动换下一个` },
            ),
          ),
        }
      : {}),
    region: Type.Optional(Type.String({ minLength: 1, description: "地区和语言，比如 cn-zh、us-en（ddg 原样用；bing 取前半段当语言；google 前半段当语言、后半段当地区；DeepSeek 取语言换成 lang:）" })),
    ...(setup.tavily ? { tavily: Type.Optional(Type.Boolean({ description: "用 Tavily 搜（同 engine 写 tavily；要配了 Tavily 的 key，不管 time、region）；默认不用" })) } : {}),
    json: Type.Optional(Type.Boolean({ description: "结果写成 JSON（浏览器、Tavily 的是数组，每条 title、url、snippet；DeepSeek 的是它原样的字段）；默认写成编号的标题、链接、摘要" })),
  });
}

/** 调用时的参数（schema 按队列写，参数全有时是这个样子；守护进程照交给 pi 的那份 schema 校验过） */
interface SearchArgs {
  query: string;
  n?: number | undefined;
  time?: SearchTime | undefined;
  engine?: WebSearchEngine | undefined;
  region?: string | undefined;
  tavily?: boolean | undefined;
  json?: boolean | undefined;
}

const FetchParams = Type.Object({
  url: Type.String({ pattern: "^https?://", description: "网页的链接（http 或 https）" }),
  max: Type.Optional(Type.Integer({ minimum: 1, description: `正文最多交回多少字，默认 ${WEB_FETCH_DEFAULT_MAX}；被截断了又需要后面的内容时调大` })),
});

/**
 * 联网搜索、读网页两个工具：都经 access 联网（正式的是浏览器、直接请求、DeepSeek 和 Tavily，测试里是假的）。
 * onBilled：DeepSeek 成了的调用（按次计费）每次叫一次。setup：设置里的队列此刻的样子（说明、能写的 engine 按它；不给按初始的、都用得上）。
 * agentBrowser：这个 agent 能不能用 agent-browser（有 bash，162 号票）；说明里写不写 agent-browser、交给 access 的都按它，不给就不提。
 * appBrowser（182 号票，只给有 browse_* 工具的秘书）：这一次调用所在的那一轮能不能用鸿蒙 App 的内置浏览器（能用回发消息那台设备的
 * 搜索引擎，不能用回 undefined）；给了，说明里就写内置浏览器的位置，交给 access 的按这一轮；不给就不提
 */
export function webTools(
  access: WebAccess,
  options: { onBilled?: (call: WebBilledCall) => void; setup?: WebToolsSetup; agentBrowser?: boolean; appBrowser?: (call: HostToolCall) => AppBrowserTurn | undefined } = {},
): HostTool[] {
  const billed = (kind: WebCallKind, call: HostToolCall) => options.onBilled?.({ service: "deepseek", kind, agentId: call.agentId });
  const setup = options.setup ?? ALL_AVAILABLE;
  const { agentBrowser } = options;
  const hasApp = options.appBrowser !== undefined;
  const ab = agentBrowser === undefined ? {} : { agentBrowser };
  /** 这一次调用交给 access 的：agent-browser 用不用得了、这一轮能不能用内置浏览器 */
  const usable = (app: AppBrowserTurn | undefined) => ({ ...ab, ...(hasApp ? { appBrowser: app !== undefined } : {}) });
  const search = webTool(TOOL.web_search, {
    description: webSearchDescription(setup, agentBrowser, hasApp),
    parameters: searchParams(setup),
    async run(args, call) {
      const { query, n, time, engine, region, tavily, json } = args as SearchArgs;
      const app = options.appBrowser?.(call);
      try {
        const found = await access.search({ query, n: n ?? WEB_SEARCH_DEFAULT_N, time, engine, region, tavily, ...usable(app) }, call.signal);
        if (found.engine === "deepseek") billed("search", call);
        return { text: searchResultText(query, found, json === true) };
      } catch (err) {
        if (err instanceof BrowserUnavailable) return { text: `联网搜索用不了：${err.message}`, isError: true };
        if (err instanceof AllSearchesFailed && err.next) return { text: thenModelText(query, err, app), isError: true };
        if (err instanceof SearchFailed || err instanceof AllSearchesFailed) return { text: `没搜到「${query}」（${err.message}）。换更短、更通用的关键词再试，再不行换英文关键词。`, isError: true };
        if (err instanceof OnlyAgentBrowser) {
          return err.usable
            ? { text: `联网搜索现在只用 agent-browser（用户在设置里只启用了它）：用 ${AB}搜；别用管道接它的输出（| head、| cat 会卡住），把输出重定向到文件再读。`, isError: true }
            : { text: `联网搜索现在只用 agent-browser（用户在设置里只启用了它），你这里没有 bash，用不了；${ENABLE_OTHERS}`, isError: true };
        }
        if (err instanceof SearchMethodsUnusable) return { text: unusableText(err.methods), isError: true };
        if (err instanceof WebMethodUnavailable) {
          return { text: `${err.why === "disabled" ? `这种方式已停用：${err.message}` : err.message}。不填 engine 按设置里的顺序搜。`, isError: true };
        }
        if (err instanceof DeepSeekFailed) {
          const orBrowser = setup.queue.includes("browser") ? "，或者 engine 写 browser 用浏览器" : "";
          return { text: `DeepSeek 没搜成：${err.message}。不指定 engine 再搜一次（按设置里的顺序，没搜成自动换下一个）${orBrowser}`, isError: true };
        }
        if (err instanceof TavilyKeyMissing) return { text: err.message, isError: true };
        if (err instanceof TavilyFailed) return { text: `Tavily 没搜成：${err.message}。不用 tavily 再搜一次（不指定 engine 按设置里的顺序）`, isError: true };
        throw err;
      }
    },
  });
  const fetchTool = webTool(TOOL.web_fetch, {
    description: webFetchDescription(setup, agentBrowser, hasApp),
    parameters: FetchParams,
    async run({ url, max }, call) {
      try {
        const page = await access.fetch({ url, max: max ?? WEB_FETCH_DEFAULT_MAX, ...usable(options.appBrowser?.(call)) }, call.signal);
        if (page.via === "deepseek") billed("fetch", call);
        return { text: page.text };
      } catch (err) {
        if (err instanceof FetchFailed) {
          const hints = [
            ...(err.agentBrowser ? [`用 agent-browser（${AB_USE}）打开这个网址读`] : []),
            ...(err.appBrowser ? [`用 ${BROWSE_OPEN_TOOL} 在${APP}里打开它、${BROWSE_READ_PAGE_TOOL} 读`] : []),
          ];
          return { text: hints.length > 0 ? `${err.message}。可以${hints.join("，或者")}。` : err.message, isError: true };
        }
        throw err;
      }
    },
  });
  return [search, fetchTool];
}

/**
 * 试到模型自己操作的方式为止（AllSearchesFailed.next）：写明接下来用它、它也不成时按顺序用哪些。内置浏览器（182 号票）给出发消息那台
 * 设备"浏览"里的搜索引擎搜这个查询的结果页地址；一种都没试（它排在最前面）时不说"没搜到"
 */
function thenModelText(query: string, err: AllSearchesFailed, app: AppBrowserTurn | undefined): string {
  const next = err.next!;
  const engine = app?.engine ?? "bing";
  const url = browseSearchUrl(query, engine);
  // 它也不成时：连着的几种工具自己能做的写成"再调 web_search，engine 写 …"，模型自己操作的写成"用它"
  const steps: string[] = [];
  let tools: ToolMethod[] = [];
  const flush = () => {
    if (tools.length > 0) steps.push(`再调 web_search，engine ${tools.length === 1 ? `写 ${tools[0]}` : `依次写 ${tools.join("、")}`}`);
    tools = [];
  };
  for (const m of next.rest) {
    if (isToolMethod(m)) {
      tools.push(m);
      continue;
    }
    flush();
    steps.push(m === "agent-browser" ? `用 agent-browser（${AB_USE}）搜` : `用${APP}（${BROWSE_OPEN_TOOL} 打开 ${url}）`);
  }
  flush();
  const more = steps.length === 0 ? "" : `；还不成${steps.join("；再不成")}`;
  if (next.method === "agent-browser") {
    const head = err.message ? `没搜到「${query}」（${err.message}）。设置里接下来是 agent-browser：` : "这一轮联网搜索先用 agent-browser：";
    return `${head}用它（${AB_USE}）搜${more}。别用管道接它的输出（会卡住），重定向到文件再读。`;
  }
  const head = err.message ? `没搜到「${query}」（${err.message}）。设置里接下来是${APP}：` : `这一轮联网搜索先用${APP}（用户在设置里把它排在前面）：`;
  return `${head}用 ${BROWSE_OPEN_TOOL} 打开 ${url}（${ENGINE_NAME[engine]}搜「${query}」的结果页）或者直接打开目标网站，${APP_LOOK}${more}。`;
}

/** 启用的都是这一次用不了的模型自己操作的方式（182 号票） */
function unusableText(methods: readonly ModelMethod[]): string {
  const why: Record<ModelMethod, string> = { "agent-browser": "agent-browser 要 bash", "app-browser": "内置浏览器只在用户从浏览侧边栏、悬浮按钮跟秘书说话的那一轮能用" };
  if (methods.length === 1 && methods[0] === "app-browser") {
    return `联网搜索现在只用${APP}（用户在设置里只启用了它），它只在用户从浏览侧边栏、悬浮按钮跟秘书说话的那一轮能用，这里用不了；${ENABLE_OTHERS}`;
  }
  return `联网搜索现在只用${spaced(methods.map((m) => NAME[m]).join("、"))}（用户在设置里只启用了${methods.length > 1 ? "它们" : "它"}），这里都用不了（${methods.map((m) => why[m]).join("；")}）；${ENABLE_OTHERS}`;
}
