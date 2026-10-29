// 浏览侧边栏（147 号票，用户 2026-10-18：鸿蒙 App 的"浏览"右边能展开二狗侧边栏，里面是秘书本人——看得到当前网页和选中的框，
// 能读网页、操作选中的框、开网址）在协议里的那一半：
// - 侧边栏里发的消息带上网页上下文（SendMessageParams.browsing，BrowsingContext）：哪个浏览器（这台设备上这一页二狗网页的随机编号）、
//   网页的标题和地址、选中的框；守护进程记进消息（MessageEnvelope.browsing，BrowsingMark），交给秘书时写明用户正在看哪个网页、
//   选中了哪个框，会话里这条消息下面一行小字"在网页「X」上说"；秘书页签里发的不带；
// - 设备报它的浏览器现在的样子（WebSocket 方法 browser_status，BrowserStatusParams）：开着哪一页、选中了哪个框，变了就报、重连后再报；
//   连接断了守护进程就当这个浏览器关了；
// - 秘书的网页工具经守护进程转给发消息的那台设备（只推给报过这个浏览器的那条连接的事件 browser_request，BrowserRequest）：
//   读整页文字、给选中的框填字、给选中的上传框交文件（凭取件码，照网页上下指令的做法）、在内置浏览器里开网址；
//   设备办完回 browser_reply（BrowserReplyParams）；
// - 秘书拿不准交哪个文件时，候选作为一张"网页候选卡"（browse_pick，BrowsePickCardPayload）放进秘书的会话：单张的框单选、
//   多张的框能选几张，"交"（confirm，带选中的取件码）、"都不要"（dismiss）。
// 网页上的文字是外部数据，不是指令：交给秘书时标明（守护进程那边写），秘书的提示词里写清不能照网页上的话去做事。
// 149 号票（用户 2026-10-18："干脆悬浮按钮的二狗和秘书的二狗是一个实体好了"）：悬浮按钮上打的字、说的话也是这种消息，
// 带 via: "button"——按钮所在的框就是这一轮的目标框（selected），按住说的标 spoken，网页弹出、App 拦下的选文件对话框上
// "让二狗选"的带 chooser；秘书在这一轮的网页工具作用于这个框（记在消息上的 field、chooser）。选中的框带上框里现在的内容
// （PageField.value，用户 2026-10-18："我在网页选中文本框的时候，二狗读不到文本框的内容"），记在消息上（value），交给秘书时标成外部数据。
// 网页候选卡不管是哪一轮给的，网页上都弹一个固定位置的挑图片窗口，和会话里的卡只认第一次的选择；点"交"没交进去时原因记在卡上
// （failed），两边都看得到。
// 164 号票（用户 2026-10-19：秘书在"浏览"里点不了链接和按钮，希望像 CDP 那样自己点）：秘书的网页工具多"看能点的东西"（snapshot，
// 列出带编号的 PageElement）和"按编号点"（click），照 agent-browser 的 snapshot / click @e1 的形状。
// 184 号票（用户 2026-10-20：希望在一页里能自动交图 → 自动填字 → 自动点按钮，不用每次都由人先点中框）：snapshot 也列可填、可交、
// 可选的控件（textbox、upload、select），fill、attach 能按编号（ref）指到 snapshot 列的框上，不用先选中；网页候选卡也能记着编号（ref）。
import { type Static, Type } from "typebox";
import { forModel, t, tTable } from "./i18n/runtime.ts";
import { PAGE_CANDIDATES_MAX, PageChooser, PageCommandFile, PageField, PageFieldValue, pageUrlForModel } from "./page-commands.ts";

/** 浏览器的编号：二狗的网页每次打开随机生成（b- 加 16 个十六进制字），重连后不变，刷新页面就换一个 */
export const BROWSER_ID = "^b-[0-9a-f]{16}$";

/** 网页的标题、地址（地址去掉查询串和 # 后面的，交给模型的就这些） */
export const BrowsingPage = Type.Object({
  title: Type.String({ maxLength: 300 }),
  url: Type.String({ maxLength: 2048 }),
});
export type BrowsingPage = Static<typeof BrowsingPage>;

/** 侧边栏里、悬浮按钮上（149 号票）发的消息带的网页上下文（SendMessageParams.browsing） */
export const BrowsingContext = Type.Object({
  browser: Type.String({ pattern: BROWSER_ID }),
  page: BrowsingPage,
  /** 用户选中的框（页面桥报的，带着框里现在的内容；没选中就没有）；悬浮按钮发的是按钮所在的框（拦下的对话框认出来的框） */
  selected: Type.Optional(PageField),
  /** 从悬浮按钮发的（149 号票）；不写是浏览侧边栏 */
  via: Type.Optional(Type.Literal("button")),
  /** 悬浮按钮上按住说的（认出来的字） */
  spoken: Type.Optional(Type.Literal(true)),
  /** 悬浮按钮这一轮的目标是网页弹出、App 拦下的选文件对话框（"让二狗选"）：要什么类型、能不能选好几个 */
  chooser: Type.Optional(PageChooser),
});
export type BrowsingContext = Static<typeof BrowsingContext>;

/**
 * 记在消息上的网页上下文（MessageEnvelope.browsing）：哪个浏览器（秘书的网页工具据此找到发消息的那台设备）、网页的标题和地址、
 * 选中的框的说法（"「标题」（单行文本）"，没选中就没有）。149 号票：悬浮按钮发的另记 via、目标框（field，不带内容）、
 * 拦下的对话框（chooser）、是不是说的（spoken）；选中的框那时的内容（value，侧边栏、悬浮按钮都记）
 */
export const BrowsingMark = Type.Object({
  browser: Type.String(),
  title: Type.String(),
  url: Type.String(),
  selected: Type.Optional(Type.String()),
  via: Type.Optional(Type.Literal("button")),
  field: Type.Optional(PageField),
  chooser: Type.Optional(PageChooser),
  spoken: Type.Optional(Type.Literal(true)),
  value: Type.Optional(PageFieldValue),
});
export type BrowsingMark = Static<typeof BrowsingMark>;

/**
 * "浏览"页签能选的搜索引擎（134 号票：设置 · 浏览与填框里选，记在这台设备上，默认必应）的结果页地址，关键词按 encodeURIComponent
 * 接在后面。182 号票从网页挪到协议包：联网搜索轮到"鸿蒙 App 的内置浏览器"时，守护进程照发消息那台设备在用的搜索引擎拼好结果页的地址
 * 交给秘书（browse_open 打开它）；名字在网页（state/browse.ts）
 */
export const BROWSE_SEARCH_ENGINES = {
  bing: "https://cn.bing.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  sogou: "https://www.sogou.com/web?query=",
  google: "https://www.google.com/search?q=",
} as const;
export type BrowseSearchEngineId = keyof typeof BROWSE_SEARCH_ENGINES;
export const BROWSE_SEARCH_ENGINE_IDS = Object.keys(BROWSE_SEARCH_ENGINES) as BrowseSearchEngineId[];

/** 默认用必应（国内能直接用、广告少） */
export const DEFAULT_BROWSE_SEARCH_ENGINE: BrowseSearchEngineId = "bing";

/** 记住的值、设备报的值认不认得：不认得（没记过、改过名、旧页面没报）按默认 */
export function browseSearchEngineOf(raw: string | null | undefined): BrowseSearchEngineId {
  return raw !== null && raw !== undefined && (BROWSE_SEARCH_ENGINE_IDS as string[]).includes(raw) ? (raw as BrowseSearchEngineId) : DEFAULT_BROWSE_SEARCH_ENGINE;
}

/** 关键词的搜索结果页地址 */
export function browseSearchUrl(query: string, engine: BrowseSearchEngineId): string {
  return `${BROWSE_SEARCH_ENGINES[engine]}${encodeURIComponent(query)}`;
}

/**
 * browser_status：设备报它的浏览器现在的样子。page 是开着的网页（还没打开过网页就没有）；selected 是选中的框（没选中就没有）。
 * 变了就报、连上（重连）后再报一次；不带幂等键（只是覆盖"现在的样子"）。182 号票：searchEngine 是这台设备"浏览"里在用的搜索引擎
 * （BrowseSearchEngineId；旧页面不报，认不得的按默认）
 */
export const BrowserStatusParams = Type.Object({
  browser: Type.String({ pattern: BROWSER_ID }),
  page: Type.Optional(BrowsingPage),
  selected: Type.Optional(PageField),
  searchEngine: Type.Optional(Type.String({ maxLength: 32 })),
});
export type BrowserStatusParams = Static<typeof BrowserStatusParams>;

/** 读网页时最多交多少字（多的截掉，结果里写明一共多少字） */
export const BROWSER_PAGE_TEXT_MAX = 20_000;

/**
 * 网页上能点的东西的种类（164 号票）：链接、按钮、菜单项、标签页、按钮样子的 input（type=button）、提交表单的按钮；
 * 184 号票起还有能填、能交、能选的控件：文本框（单行、多行、可编辑区域）、上传框（选文件的 input，藏起来的也算）、下拉框（只能看）
 */
export const PAGE_ELEMENT_ROLES = ["link", "button", "menuitem", "tab", "input", "submit", "textbox", "upload", "select"] as const;
export type PageElementRole = (typeof PAGE_ELEMENT_ROLES)[number];

/** 能填、能交、能选的控件的种类（184 号票）：不能点，填字用 fill、交文件用 attach，下拉框只能看 */
export const PAGE_FIELD_ROLES = ["textbox", "upload", "select"] as const satisfies readonly PageElementRole[];

/** 文本框、下拉框现在的值最多交多少字（184 号票；密码类的框根本不列）；下拉框最多交几个选项、一个选项最长多少字 */
export const PAGE_ELEMENT_VALUE_MAX = 40;
export const PAGE_ELEMENT_OPTIONS_MAX = 20;
export const PAGE_ELEMENT_OPTION_MAX = 100;

/** 看一次最多列多少个能点的东西：不写时 40 个，最多 100 个 */
export const PAGE_ELEMENTS_DEFAULT = 40;
export const PAGE_ELEMENTS_MAX = 100;

/**
 * 网页上一个能点的东西（164 号票，browse_snapshot 列的，照 agent-browser snapshot 的 @e1）：编号（"e1"，页面桥给的，只在这一页有效、
 * 换页即失效；同一页再看一次，同一个元素还是这个号）、种类、看得见的文字（截断；没有文字时用 aria-label / title / alt）、
 * 链接的地址（只有 link 有）、是不是灰的（aria-disabled，点了也没用；真正 disabled 的不列）。
 * 184 号票起的控件（文本框、上传框、下拉框）：文字是标签（没有标签用 placeholder；上传框没有时用网站画的上传按钮上的字）；
 * valuePreview 是现在的值的前 40 字（文本框；下拉框是现在选的那一项；空的不写；密码类的框根本不列）；multiline 多行的文本框；
 * accept、multiple 上传框要什么类型、能不能交好几个；options 下拉框的前 20 个选项；hidden 是藏起来的上传框（网站画了自己的上传按钮、
 * 把 input 藏在后面，业界常见）——只能交文件、不能点
 */
export const PageElement = Type.Object({
  ref: Type.String({ maxLength: 16 }),
  role: Type.Enum(PAGE_ELEMENT_ROLES),
  text: Type.String({ maxLength: 200 }),
  href: Type.Optional(Type.String({ maxLength: 2000 })),
  disabled: Type.Optional(Type.Boolean()),
  valuePreview: Type.Optional(Type.String({ maxLength: PAGE_ELEMENT_VALUE_MAX })),
  multiline: Type.Optional(Type.Boolean()),
  accept: Type.Optional(Type.String({ maxLength: 200 })),
  multiple: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(Type.String({ maxLength: PAGE_ELEMENT_OPTION_MAX }), { maxItems: PAGE_ELEMENT_OPTIONS_MAX })),
  hidden: Type.Optional(Type.Boolean()),
});
export type PageElement = Static<typeof PageElement>;

/**
 * 守护进程要设备办的一件事（事件 browser_request 的负载，只推给报过这个浏览器的连接）：
 * - read：取当前网页的正文文字（去掉脚本、样式，最多 BROWSER_PAGE_TEXT_MAX 字）；
 * - fill：给选中的框（fieldId 是守护进程手里设备上次报的选中的框）填字，整个换掉；
 * - attach：给上传框交文件（凭取件码取字节，照网页上下指令的做法）——秘书直接交的是选中的框，网页候选卡上点"交"的是建卡时选中的那个框；
 * - open：在这个内置浏览器里打开一个网址（http、https）。
 * fill、attach 带着网页的地址（去掉查询串）：设备核对浏览器还开着这一页、页面上还有这个框（fill 还要是现在选中的框），不是就回错——
 * 框的编号只在同一页里有效，换了网页同一个编号可能是别的框。attach 的 fieldId 是 "chooser"（PAGE_CHOOSER_TARGET，149 号票）时
 * 交给网页弹出、App 拦下的选文件对话框（还等着才交得进）。
 * 164 号票（用户 2026-10-19：秘书在"浏览"里点不了链接和按钮）多两种：
 * - snapshot：列当前网页上能点的东西（PageElement，最多 max 个，不写 40 个），编号由页面桥给、记在页面桥的内存里（不写进网页的 DOM）；
 * - click：按编号点一个元素。url 是看的时候那一页的地址（去掉查询串）：设备核对还是这一页、编号还在、元素还在页面上、文字和看的时候一样，
 *   不是就回"页面变了，请重新 snapshot"，不会点错。
 * 184 号票：fill、attach 另有按编号的那一种（ref 是 snapshot 列的 textbox、upload 的编号，不用先选中）：url 同样是看的时候那一页的地址，
 * 设备（页面桥）核对还是这一页、编号认得、元素还在、种类没变才填、才交
 */
export const BrowserRequest = Type.Union([
  Type.Object({ id: Type.String(), op: Type.Literal("read") }),
  Type.Object({ id: Type.String(), op: Type.Literal("fill"), fieldId: Type.String(), url: Type.String(), text: Type.String() }),
  Type.Object({ id: Type.String(), op: Type.Literal("fill"), ref: Type.String(), url: Type.String(), text: Type.String() }),
  Type.Object({ id: Type.String(), op: Type.Literal("attach"), fieldId: Type.String(), url: Type.String(), files: Type.Array(PageCommandFile) }),
  Type.Object({ id: Type.String(), op: Type.Literal("attach"), ref: Type.String(), url: Type.String(), files: Type.Array(PageCommandFile) }),
  Type.Object({ id: Type.String(), op: Type.Literal("open"), url: Type.String() }),
  Type.Object({ id: Type.String(), op: Type.Literal("snapshot"), max: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE_ELEMENTS_MAX })) }),
  Type.Object({ id: Type.String(), op: Type.Literal("click"), ref: Type.String(), url: Type.String() }),
]);
export type BrowserRequest = Static<typeof BrowserRequest>;

/**
 * 设备办完的结果：不成是原因（浏览器换了网页、框没了、取不到文件……）；成了的——read 带网页、文字、截没截、一共多少字，
 * 还有选中的框和框里现在的内容（selected，149 号票：正文文字里没有框里的值）；attach 带交进去几个。
 * 164 号票：snapshot 带网页、能点的东西（elements，最多 PAGE_ELEMENTS_MAX 个，超出时屏幕上看得见的、上半屏的优先）、页面上一共几个
 * （total）、截没截（truncated）；click 带点了什么（clicked，"种类:文字"）、地址变没变（navigated）、点完之后的网页（page）
 */
export const BrowserOutcome = Type.Union([
  Type.Object({ ok: Type.Literal(false), reason: Type.String({ maxLength: 500 }) }),
  Type.Object({
    ok: Type.Literal(true),
    page: Type.Optional(BrowsingPage),
    text: Type.Optional(Type.String({ maxLength: BROWSER_PAGE_TEXT_MAX })),
    truncated: Type.Optional(Type.Boolean()),
    total: Type.Optional(Type.Integer({ minimum: 0 })),
    count: Type.Optional(Type.Integer({ minimum: 0 })),
    selected: Type.Optional(PageField),
    elements: Type.Optional(Type.Array(PageElement, { maxItems: PAGE_ELEMENTS_MAX })),
    clicked: Type.Optional(Type.String({ maxLength: 300 })),
    navigated: Type.Optional(Type.Boolean()),
  }),
]);
export type BrowserOutcome = Static<typeof BrowserOutcome>;

/** browser_reply：设备办完了 browser_request（id 是那件事的编号）；不带幂等键 */
export const BrowserReplyParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  result: BrowserOutcome,
});
export type BrowserReplyParams = Static<typeof BrowserReplyParams>;

/**
 * 网页候选卡（browse_pick）：秘书在侧边栏里替选中的上传框找文件、拿不准交哪个时给用户挑的候选。在哪个网页、哪个框（说法和
 * 页面桥给的编号，网页弹出的选文件对话框是 "chooser"）、哪个浏览器、能不能选好几个、候选的文件（凭取件码，过期时间 expiresAt 之后
 * 取不到了）、秘书最推荐的（取件码）；选好了交进去以后记着选了哪几个、交进去几个；点了"交"没交进去时记着原因（failed，149 号票：
 * 网页上的挑图片窗口和会话里的卡都显示，卡还能再点）。184 号票：秘书按编号指的上传框（browse_attach_files 的 ref）记在 ref 上
 * （fieldId 也写这个编号），交的时候按编号交（页面桥核对还是那一页、编号认得、还是上传框）
 */
export const BrowsePickCardPayload = Type.Object({
  page: BrowsingPage,
  field: Type.String(),
  fieldId: Type.String(),
  ref: Type.Optional(Type.String({ maxLength: 16 })),
  browser: Type.String(),
  multiple: Type.Boolean(),
  files: Type.Array(PageCommandFile, { minItems: 1 }),
  recommended: Type.Array(Type.String()),
  expiresAt: Type.String(),
  picked: Type.Optional(Type.Array(Type.String())),
  delivered: Type.Optional(Type.Integer({ minimum: 0 })),
  failed: Type.Optional(Type.String()),
});
export type BrowsePickCardPayload = Static<typeof BrowsePickCardPayload>;

/**
 * 网页候选卡上点"交"的输入：选中的（取件码，至少一个）。done（149 号票）：网页上的挑图片窗口里点的，设备已经在本机交过了
 * （用的是候选一出来就预备好的文件，不等守护进程）——交进去几个，或没交进去的原因；守护进程只核对、记下（卡片同步），不再转给设备
 */
export const BrowsePickConfirmInput = Type.Object({
  tokens: Type.Array(Type.String({ maxLength: 64 }), { minItems: 1, maxItems: PAGE_CANDIDATES_MAX }),
  done: Type.Optional(Type.Union([Type.Object({ delivered: Type.Integer({ minimum: 0 }) }), Type.Object({ failed: Type.String({ maxLength: 500 }) })])),
});
export type BrowsePickConfirmInput = Static<typeof BrowsePickConfirmInput>;

const FIELD_KIND_TEXT: Readonly<Record<PageField["kind"], string>> = tTable({
  text: "protocol.browsing.field.text",
  textarea: "protocol.browsing.field.textarea",
  editable: "protocol.browsing.field.editable",
  file: "protocol.browsing.field.file",
});

/**
 * 选中的框的说法："「标题」（单行文本）"；没有标签、提示的只写种类。侧边栏顶上"选中："、交给秘书的输入、记在消息上的都用它。
 * 按当前语言写；给模型的（交给秘书的输入、记在消息上的）包一层 forModel 照旧中文（172 号票）
 */
export function selectedFieldText(field: Pick<PageField, "kind" | "label" | "placeholder" | "multiple">): string {
  const name = field.label || field.placeholder || "";
  const kind = field.kind === "file" && field.multiple ? t("protocol.browsing.field.fileMultiple") : FIELD_KIND_TEXT[field.kind];
  return name ? t("protocol.browsing.field.named", { name, kind }) : kind;
}

/** 拦下的选文件对话框的说法（149 号票）：只给模型看（交给秘书的输入、工具的结果） */
export const CHOOSER_TEXT = "网页弹出的选文件对话框"; // @i18n-ignore model

/** 侧边栏、悬浮按钮发的消息带的网页上下文记成什么（地址去掉查询串和 # 后面的；框里的内容另记在 value，目标框不带内容） */
export function browsingMarkOf(context: BrowsingContext): BrowsingMark {
  const { value, ...field } = context.selected ?? { value: undefined };
  const selected = context.selected ? (field as PageField) : undefined;
  // 记在消息上的这一句只交给模型看（daemon/src/browsing/texts.ts），照旧中文
  const said = selected ? forModel(() => selectedFieldText(selected)) : undefined;
  const label = context.via === "button" && context.chooser ? (said ? `${said}（${CHOOSER_TEXT}）` : CHOOSER_TEXT) : said; // @i18n-ignore model
  return {
    browser: context.browser,
    title: context.page.title,
    url: pageUrlForModel(context.page.url),
    ...(label ? { selected: label } : {}),
    ...(context.via === "button"
      ? { via: "button" as const, ...(selected ? { field: selected } : {}), ...(context.chooser ? { chooser: context.chooser } : {}), ...(context.spoken ? { spoken: true as const } : {}) }
      : {}),
    ...(value && selected?.kind !== "file" ? { value } : {}),
  };
}

/**
 * 会话里侧边栏发的那条消息下面的小字："在网页「X」上说"（网页没标题写地址，去掉 http(s)://；还没打开网页时"在浏览侧边栏里说"）。
 * 悬浮按钮发的照 134 号票网页指令的写法（149 号票）："在网页「X」的「标题」上打字"、"……的上传框上说"
 */
export function browsingLabel(mark: Pick<BrowsingMark, "title" | "url" | "via" | "field" | "chooser" | "spoken">): string {
  const page = mark.title.trim() || mark.url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (mark.via === "button") {
    const name = mark.field ? mark.field.label || mark.field.placeholder || "" : "";
    const where = name
      ? t("protocol.browsing.label.whereNamed", { name: name.slice(0, 30) })
      : mark.field?.kind === "file"
        ? t("protocol.browsing.label.whereUpload")
        : mark.chooser
          ? t("protocol.browsing.label.whereChooser")
          : t("protocol.browsing.label.whereField");
    const title = (page || t("protocol.browsing.label.untitled")).slice(0, 40);
    return t(mark.spoken ? "protocol.browsing.label.buttonSpoke" : "protocol.browsing.label.buttonTyped", { page: title, where });
  }
  return page ? t("protocol.browsing.label.sidebarPage", { page: page.slice(0, 40) }) : t("protocol.browsing.label.sidebar");
}

// ───────────────────────── 存进二狗的素材（165 号票） ─────────────────────────

/**
 * "浏览"的 ⋮ 菜单里点"存进二狗的素材"（POST /api/materials/web-page）：这一页的标题、地址（http、https）、正文（页面桥取整页文字的那条路，
 * 最多 BROWSER_PAGE_TEXT_MAX 字）、截没截、原文一共多少字。请求带幂等键：同一个请求重发只存一次
 */
export const SaveWebPageBody = Type.Object({
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ maxLength: 300 }),
  url: Type.String({ pattern: "^[Hh][Tt][Tt][Pp][Ss]?://[^/?#\\s]", maxLength: 2048 }),
  text: Type.String({ maxLength: BROWSER_PAGE_TEXT_MAX }),
  truncated: Type.Boolean(),
  total: Type.Integer({ minimum: 0 }),
});
export type SaveWebPageBody = Static<typeof SaveWebPageBody>;

/** 存好了：这一页的编号（wp- 开头）、它采成的素材 id（记忆插件没开时素材库只保管，id 照样是这个，开了以后采出来就是它） */
export const SaveWebPageResult = Type.Object({ id: Type.String(), materialId: Type.String() });
export type SaveWebPageResult = Static<typeof SaveWebPageResult>;

/** 素材频道上的 web_page_saved 事件的负载：存下的那一页（彻底删除时标题、地址、正文换成删除标记，别的不变） */
export const WebPageSavedEventPayload = Type.Object({
  id: Type.String(),
  time: Type.String(),
  title: Type.String(),
  url: Type.String(),
  text: Type.String(),
  truncated: Type.Boolean(),
  total: Type.Integer({ minimum: 0 }),
});
export type WebPageSavedEventPayload = Static<typeof WebPageSavedEventPayload>;

/** 存下的网页的素材上的情境标签（记忆 · 素材里写成"你存的网页"） */
export const SAVED_WEB_PAGE_CONTEXT = "saved_web_page";
