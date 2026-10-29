// 页面路由的地址（纯函数，不碰 window，测试在 Node 里直接用）：页面有哪些、地址怎么拆（parseHash）、怎么拼（toHash）、
// 这一页属于主导航的哪一项（navItemOf）。盯着地址变化的 React 钩子在 route.ts。
import { cardWebPath, type InboxJump, isAppName, type NavItem, parseLocalDate, parseMonthKey } from "../state/index.ts";

export type Tab = "secretary" | "tasks" | "projects" | "inbox" | "browse" | "calendar" | "more";

/**
 * "更多"下面的页：消耗、记忆（第二阶段的说明）、设置，以及设置下面的七页（32 号票加了语音）。主导航放得下时消耗、记忆、设置直接显示成 tab
 * （33 号票），地址仍是 #/more/...，别处的链接（比如"去设置页修复"）不用跟着导航变。
 * 35 号票：设置里的"工作日历"升为主导航的日历（#/calendar），设置里只留"工作日规则"（额外上班规则）；旧地址 #/more/workday-calendar
 * 认作工作日规则。
 * 74 号票：外观（浅色 / 深色 / 跟随系统）和风格不再摊在设置列表上，合成设置下面的一页"外观与风格"（appearance）
 * 71 号票：设置下面的"系统提示"（prompts）：按角色列出各 agent 的系统提示，点进某一份是下一级（#/more/prompts/<编号>）
 * 73 号票：设置下面加一页"模型"（models）：服务商、API key 的状态、默认模型、各个 agent 的模型和思考档位、看图能力、连通测试
 * 124 号票：设置最下面的"关于二狗"（about）：版本、更新日志；连点版本号 8 次打开的"Debug 工具集"（debug，1 小时内有效）
 * 134 号票：设置下面的"浏览与填框"（browsing）："浏览"页签的搜索引擎、授权的文件夹（138 号票：秘书和"浏览"里的二狗共用）
 * 167 号票：设置里的"删除素材"（materials）去掉，并进记忆 · 素材（#/more/memory/materials）；旧地址认作那里（legacyHashRedirect 换掉地址栏）
 * 168 号票：设置下面的"语言 / Language"（language）：全局一个语言，选哪种、有哪些、怎么加新语言
 * 193 号票："记忆"（memory）挪进记忆插件（网页插件的页面，见下面的 PluginPageId）；设置下面加回"删除素材"（materials-delete，
 * 内核的成批删除：记忆插件停用时记忆页不在了，删除照常的保证落在这里——只在记忆页不在时列在设置里，见 plugins/slots.ts 的 PageSlot.covers）
 * 211 号票：设置下面的"插件"（plugins）：看装了哪些插件，运行中停用、启用、移除（热插拔）
 * 248 号票：设置下面的"角色与声音"（roles）：名字 + 音色绑成一个角色，每个 agent 选一个（替掉 241 号票语音页底部那张两列表）
 * 281 号票："更多"下面的"个人档案"（files）：内核的页面，不是设置下面的一页（navItemOf 认作"更多"）；点进一个人是下一级（#/more/files/<编号>）
 * 323 号票：设置下面的"组件"（components）：模型、语音这些大件装了哪些、多大、哪个版本，装 / 删 / 更新、从文件导入；
 * 没装的组件对应的功能在界面上灰掉，点一下来这一页装
 * 295 号票：设置下面的"数据源"（data-sources）：插件登记的数据源一处列出（连接、同步、断开、两种用法）和共用的导入文件夹；记忆页有链接过来
 * 319 号票：设置最上面的"设置向导"（setup）：首次用的时候五步走完（语言/称呼/助手名、模型 Key、组件、手机配对、安全默认值），
 * 再加一屏"外网访问"的说明；首页顶上那条引导条、没配模型时那条小栏都指到这里
 * 319b：设置 · 数据与设备里加一页"体检"（doctor）：端口、Node、pi、服务管家、模型的 key、组件、磁盘、外网入口八项一查
 */
export const MORE_PAGES = ["usage", "settings", "setup", "roles", "language", "appearance", "models", "watch", "workday-rules", "skills", "prompts", "voice", "browsing", "devices", "plugins", "components", "claude-code", "data-sources", "materials-delete", "doctor", "about", "debug", "files"] as const;

export type MorePage = (typeof MORE_PAGES)[number];

/**
 * 网页插件的页面（193 号票，plugins/slots.ts 的 PageSlot）：地址同样是 #/more/<页面 id>[/<item>[/<sub>]]，item、sub 由插件自己认
 * （比如记忆插件：#/more/memory/<层>/<素材 id>）。页面 id 不和核心的页重名
 */
export type PluginPageId = string & {};

export function isMorePage(s: string): s is MorePage {
  return (MORE_PAGES as readonly string[]).includes(s);
}

/** 改了名的页的旧地址 */
const RENAMED_MORE_PAGES: Readonly<Record<string, MorePage>> = { "workday-calendar": "workday-rules" };

/**
 * 旧地址换成新地址（地址栏里换掉，不压新记录）：35 号票的 #/more/workday-calendar，167 号票之前设置里删除素材的 #/more/materials[/<素材 id>]
 * （认作记忆插件的记忆 · 素材，193 号票起记忆是插件的页面；记忆插件停用时那一页写"没启用"）。不是旧地址的给 undefined
 */
export function legacyHashRedirect(hash: string): string | undefined {
  const [head, a] = hash.replace(/^#\/?/, "").split("/");
  if (head !== "more" || a === undefined || !(a === "materials" || a in RENAMED_MORE_PAGES)) return undefined;
  return toHash(parseHash(hash));
}

/** 写法对、真有这一天（这个月）才算数：#/calendar/2026-13、#/calendar/2026-02-30 当成没带，回到本月（日历页渲染时不会再拆出错） */
function valid(parse: (s: string) => unknown, s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    parse(s);
    return s;
  } catch {
    return undefined;
  }
}

/**
 * at（105 号票）：会话里要定位到的那一条——卡片 id 或工具调用 id（待办里"去看看 ›"带过来）。
 * #/secretary/at/<id>、#/tasks/<任务>/at/<id>、#/projects/<项目>/chat/at/<id>
 */
export type Route =
  | { tab: "secretary"; at?: string }
  /** 看板；jobId：定位到看板上这个定时作业的卡（日历里点作业过来，35 号票）；at：任务的会话里定位到的那一条 */
  | { tab: "tasks"; taskId?: string; jobId?: string; at?: string }
  /** 项目；jobId：定位到项目页上这个定时作业那一行（日历里点作业过来，35 号票）；at：维护者的会话里定位到的那一条 */
  | { tab: "projects"; projectId?: string; chat?: boolean; jobId?: string; at?: string }
  | { tab: "inbox"; itemId?: string }
  /**
   * 浏览（134 号票）：鸿蒙 App 里的原生内置浏览器，内容区是 App 叠在网页上面的 ArkWeb。地址里不带网址（打开的哪一页 App 记着，
   * 切走再回来原样还在）；不在 App 里打开这个地址只有一句说明
   */
  | { tab: "browse" }
  /** 日历（35 号票）：month 是看哪个月（YYYY-MM，不给是这个月），date 是展开详情的那一天（YYYY-MM-DD，月份跟着它） */
  | { tab: "calendar"; month?: string; date?: string }
  /**
   * item：有下一级的页点进去的那一项（71 号票：系统提示的编号；193 号票：删除素材里点开的一条素材）；网页插件的页面（193 号票）
   * 的 item、sub 由插件自己认（记忆插件：哪一层、那一层里点开的一条素材，167 号票）
   */
  | { tab: "more"; page?: MorePage | PluginPageId; item?: string; sub?: string }
  /** 配对等待页：新设备上看到的，独占整页、没有 tab */
  | { tab: "pair-wait" }
  /** 配对批准页：在已信任的设备或 PC 本机上核对后批准 */
  | { tab: "pair-approve"; cardId: string }
  /** 单独显示一张卡：不认识这种卡的前端给的"去 Web 处理"链接指向这里 */
  | { tab: "card"; cardId: string }
  /** 报告页（113 号票）：文本类附件渲染着看，按媒体 id 现取；可刷新、可收藏，链接发给另一台已配对的设备也能打开 */
  | { tab: "report"; mediaId: string }
  /**
   * 内置浏览器（132 号票）：守护进程转发的本机服务的页面（/apps/<应用名>/<path>），整页叠层盖在原来的页面上。
   * path 是前缀下面的那一段（不带开头的斜杠，可以带查询串和页内锚点），原样写进地址：#/apps/<应用名>/<path>。刷新后还在、能发给自己别的设备
   */
  | { tab: "app"; app: string; path?: string };

/** 设置下面的几页（319 号票起最前面还有"设置向导"） */
const SETTINGS_PAGES: readonly MorePage[] = ["setup", "roles", "language", "appearance", "models", "watch", "workday-rules", "skills", "prompts", "voice", "browsing", "devices", "plugins", "components", "claude-code", "data-sources", "materials-delete", "doctor", "about", "debug"];

/** 这一页属于主导航的哪一项："更多"本身是 more；配对等待页独占整页，不属于任何一项 */
export function navItemOf(route: Route): NavItem | "more" | undefined {
  switch (route.tab) {
    case "secretary":
    case "tasks":
    case "projects":
    case "inbox":
    case "browse":
    case "calendar":
      return route.tab;
    case "pair-approve":
    case "card":
      return "inbox";
    case "more":
      if (!route.page) return "more";
      // 网页插件的页面（193 号票）：导航里那一项就是页面的 id
      if (!isMorePage(route.page)) return route.page;
      if (route.page === "usage") return route.page;
      return route.page === "settings" || SETTINGS_PAGES.includes(route.page) ? "settings" : "more";
    case "pair-wait":
    case "report":
    case "app":
      return undefined;
  }
}

export function parseHash(hash: string): Route {
  // 内置浏览器（132 号票）：应用名后面那一段原样留着（服务自己的路径、查询串、锚点里有 / ? # 也不拆）
  const app = /^apps\/([^/?#]+)\/?(.*)$/s.exec(hash.replace(/^#\/?/, ""));
  if (app) return isAppName(app[1]!) ? { tab: "app", app: app[1]!, ...(app[2] ? { path: app[2] } : {}) } : { tab: "secretary" };
  const [head, a, b, c, d] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  switch (head) {
    case "secretary":
      return a === "at" && b ? { tab: "secretary", at: b } : { tab: "secretary" };
    case "tasks":
      if (a === "jobs" && b) return { tab: "tasks", jobId: b };
      if (a && b === "at" && c) return { tab: "tasks", taskId: a, at: c };
      return { tab: "tasks", taskId: a || undefined };
    case "projects":
      if (a && b === "jobs" && c) return { tab: "projects", projectId: a, jobId: c };
      if (a && b === "chat" && c === "at" && d) return { tab: "projects", projectId: a, chat: true, at: d };
      return { tab: "projects", projectId: a || undefined, chat: b === "chat" };
    case "inbox":
      return { tab: "inbox", itemId: a || undefined };
    case "browse":
      return { tab: "browse" };
    case "calendar": {
      const date = valid(parseLocalDate, a);
      if (date) return { tab: "calendar", date };
      return { tab: "calendar", month: valid(parseMonthKey, a) };
    }
    case "more": {
      // 167 号票之前设置里的删除素材（21 号票），点开的一条（158 号票）：认作记忆 · 素材（193 号票起是记忆插件的页面）
      if (a === "materials") return { tab: "more", page: "memory", item: "materials", ...(b ? { sub: b } : {}) };
      const page = a && isMorePage(a) ? a : a ? RENAMED_MORE_PAGES[a] : undefined;
      // 网页插件的页面（193 号票）：#/more/<页面 id>[/<item>[/<sub>]]，item、sub 原样留着由插件自己认（不认得的页面画成"更多"）
      if (a && page === undefined) return { tab: "more", page: a, ...(b ? { item: b } : {}), ...(b && c ? { sub: c } : {}) };
      // 有下一级的页（71 号票：系统提示；193 号票：删除素材里点开的一条素材；281 号票：个人档案里点开的一个人）：
      // #/more/prompts/<编号>、#/more/materials-delete/<素材 id>、#/more/files/<档案编号>
      return (page === "prompts" || page === "materials-delete" || page === "files") && b ? { tab: "more", page, item: b } : { tab: "more", page };
    }
    case "card":
      return a ? { tab: "card", cardId: a } : { tab: "secretary" };
    case "report":
      return a ? { tab: "report", mediaId: a } : { tab: "secretary" };
    case "pair":
      if (a === "approve" && b) return { tab: "pair-approve", cardId: b };
      if (a === "wait") return { tab: "pair-wait" };
      return { tab: "secretary" };
    default:
      return { tab: "secretary" };
  }
}

export function toHash(r: Route): string {
  switch (r.tab) {
    case "secretary":
      return r.at ? `#/secretary/at/${encodeURIComponent(r.at)}` : "#/secretary";
    case "tasks":
      if (r.jobId) return `#/tasks/jobs/${r.jobId}`;
      if (r.taskId && r.at) return `#/tasks/${r.taskId}/at/${encodeURIComponent(r.at)}`;
      return r.taskId ? `#/tasks/${r.taskId}` : "#/tasks";
    case "projects":
      if (r.projectId && r.jobId) return `#/projects/${r.projectId}/jobs/${r.jobId}`;
      if (r.projectId && r.at) return `#/projects/${r.projectId}/chat/at/${encodeURIComponent(r.at)}`;
      return r.projectId ? `#/projects/${r.projectId}${r.chat ? "/chat" : ""}` : "#/projects";
    case "calendar":
      return r.date ? `#/calendar/${r.date}` : r.month ? `#/calendar/${r.month}` : "#/calendar";
    case "inbox":
      return r.itemId ? `#/inbox/${r.itemId}` : "#/inbox";
    case "browse":
      return "#/browse";
    case "more":
      if (r.page && r.item && r.sub) return `#/more/${r.page}/${encodeURIComponent(r.item)}/${encodeURIComponent(r.sub)}`;
      if (r.page && r.item) return `#/more/${r.page}/${encodeURIComponent(r.item)}`;
      return r.page ? `#/more/${r.page}` : "#/more";
    case "pair-wait":
      return "#/pair/wait";
    case "pair-approve":
      return `#/pair/approve/${r.cardId}`;
    case "card":
      return cardWebPath(r.cardId);
    case "report":
      return `#/report/${encodeURIComponent(r.mediaId)}`;
    case "app":
      return `#/apps/${r.app}${r.path ? `/${r.path}` : ""}`;
  }
}

export type Navigate = (r: Route) => void;

/** 待办里"去看看 ›"（105 号票）去的地址：状态层 inboxJump 给出去处，这里拼成页面的地址 */
export function inboxJumpRoute(jump: InboxJump): Route {
  switch (jump.kind) {
    case "task":
      return { tab: "tasks", taskId: jump.taskId, ...(jump.at ? { at: jump.at } : {}) };
    case "project":
      if (jump.jobId) return { tab: "projects", projectId: jump.projectId, jobId: jump.jobId };
      // 要定位的在维护者的会话里：去会话（宽屏 …/chat 也是整页的项目）
      return { tab: "projects", projectId: jump.projectId, ...(jump.chat || jump.at ? { chat: true } : {}), ...(jump.at ? { at: jump.at } : {}) };
    case "secretary":
      return { tab: "secretary", ...(jump.at ? { at: jump.at } : {}) };
    case "calendar":
      return { tab: "calendar", date: jump.date };
    case "board":
      return jump.jobId ? { tab: "tasks", jobId: jump.jobId } : { tab: "tasks" };
    case "settings":
      return { tab: "more", page: jump.page };
    case "pairing":
      return { tab: "pair-approve", cardId: jump.cardId };
  }
}
