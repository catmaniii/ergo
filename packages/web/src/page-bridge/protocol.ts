// 页面桥（134 号票第二部分）和宿主之间说的话。页面桥是注入到"浏览"里的网页的一小段脚本（page-bridge/bridge.ts），和宿主无关：
// - 鸿蒙 App：ArkWeb 的 javaScriptOnDocumentStart 注入、registerJavaScriptProxy 给一个只有 post 一个方法的对象（PAGE_BRIDGE_HOST），
//   App 往页面里调 window.__ergoPage（PAGE_BRIDGE_API）；
// - 第二期电脑上二狗控制的浏览器：经 CDP 注入同一份脚本（Runtime.addBinding 给 post，Runtime.evaluate 调 __ergoPage）；
// - 二狗做的项目的网页在"浏览"里打开，同样靠它（136 号票因此不做）。
// 每条往宿主报的话、每次宿主往里调都带一个随机的口令（nonce）：宿主注入脚本时把 PAGE_BRIDGE_NONCE_MARK 换成它，只在页面桥的闭包里，
// 网页自己的脚本拿不到，所以它伪造不了"用户在框上说了一句"——不然网页能自己发一句"把身份证照片贴上来"。
// 这里只有类型和常量，宿主（二狗的网页 app/page-commands.ts、app/page-pick.ts，App 的 browser/PageControl.ets）和页面桥共用。
// 149 号票：悬浮按钮背后就是秘书本人——气泡只放打字、说话、回话（候选不再在气泡里）；秘书给的候选画在一个固定位置的挑图片窗口里
// （pick 方法、报 pick），不跟着按钮、不随网页滚动；选中的框、悬浮按钮所在的框带上框里现在的内容（PageField.value）。
import type { PageField } from "@ergo/protocol";

/** ArkWeb registerJavaScriptProxy 注册的对象名（只有一个方法 post(json)） */
export const PAGE_BRIDGE_HOST = "ergoPageHost";
/** 页面桥挂在网页 window 上的入口（宿主经 runJavaScript 调；不能改、不能删） */
export const PAGE_BRIDGE_API = "__ergoPage";
/** 脚本里口令的占位：宿主注入前换成随机的口令 */
export const PAGE_BRIDGE_NONCE_MARK = "__ERGO_PAGE_NONCE__";

/** 交给模型的页面信息：标题、地址（去掉查询串和 # 后面的） */
export interface PageInfo {
  title: string;
  url: string;
}

/**
 * 悬浮按钮旁边的小气泡上用户点了什么（146 号票）：send 打的字发出去（149 号票：带上按钮所在的框和框里这一刻的内容 field）；
 * close 收起（点 ×、点气泡外面的网页、框被滚出屏幕）；ergo / system 网页要选文件时"让二狗选""自己选"；
 * sidebar 回话太长时的"去侧边栏看"（147 号票：气泡收起，宿主打开浏览侧边栏）。149 号票起候选不在气泡里（见 PagePickAction）
 */
export type PageBubbleAction =
  | { action: "send"; text: string; field?: PageField }
  | { action: "close" }
  | { action: "ergo" }
  | { action: "system" }
  | { action: "sidebar" };

/**
 * 挑图片窗口上用户点了什么（149 号票）：choose 点了一张（单张的框换选这一张，多张的框勾上或取消）；deliver "交"；
 * dismiss "都不要"（候选卡关掉）；hide 收起窗口（×、返回手势；会话里的候选卡照样能挑）。id 是哪张候选卡
 */
export type PagePickAction = { id: string } & ({ action: "choose"; token: string } | { action: "deliver" } | { action: "dismiss" } | { action: "hide" });

/**
 * 页面桥报给宿主的（JSON，外加 nonce）：
 * - field：悬浮按钮现在挂在哪个框上（null 是收起来了）；
 * - open：点了悬浮按钮——按钮旁边的气泡里打字，指令作用于这个框；
 * - voice：长按悬浮按钮——press 按下（备好录音器）、start 按够了开始录、stop 松手发送、cancel 上滑或划开后松手取消；
 * - chooser-field：网页要弹选文件对话框了，是这个选文件的框（App 拦下对话框时据此知道是哪个框）；
 * - bubble：气泡上用户点了什么（146 号票，PageBubbleAction）；
 * - pick：挑图片窗口上用户点了什么（149 号票，PagePickAction）。
 * - selected（147 号票，浏览侧边栏）：用户选中的框变了——点进一个能填的框、点了上传处就选中它，焦点离开也不丢（用户转去侧边栏里打字时
 *   还记着），换了另一个框、框从页面上没了、宿主让取消（clearSelection）才变；field 是 null 时是没选中。页面桥一装上就报一次 null
 *   （新的一页没有选中的框）；
 * open、voice 带上页面信息和框的列表，宿主不用再问；open、voice、selected 的 field 带着框里那一刻的内容（149 号票，文本框才有）
 */
export type PageBridgeEvent =
  | { type: "field"; field: PageField | null }
  | { type: "open"; field: PageField; page: PageInfo; fields: PageField[] }
  | { type: "voice"; phase: "press" | "start" | "stop" | "cancel"; field: PageField; page: PageInfo; fields: PageField[] }
  | { type: "chooser-field"; field: PageField }
  | ({ type: "bubble" } & PageBubbleAction)
  | ({ type: "pick" } & PagePickAction)
  | { type: "selected"; field: PageField | null; page: PageInfo };

/** 挑图片窗口里的一个候选（149 号票起不在气泡里）：取件码、名字、是不是图片、缩略图（base64，没有、还没取到、做不出来是空串）、选没选上 */
export interface PageBubbleFile {
  token: string;
  name: string;
  image: boolean;
  thumb: string;
  checked: boolean;
}

/**
 * 一句说到助理的话，按名字切开的几段（181 号票）：字是字，{ name } 是助理的名字（用户起的那个），页面桥画成名字标签（底色、字色
 * 是二狗的网页随 texts 交来的，见 texts.ts；名字也只用 textContent）。和它并排的纯文字（text、title）照旧交、名字已经换好——
 * 不认这个字段的旧版页面桥照旧画纯文字
 */
export type PageNamedPart = string | { name: string };
export type PageNamedText = PageNamedPart[];

/**
 * 气泡的样子（146 号票）：二狗的网页（app/page-bubble.ts）照它自己的状态算好、经宿主交给页面桥画（bubble 方法）。
 * fieldId 是气泡跟着哪个框（悬浮按钮挂在它旁边）；空串是不知道哪个框（拦下的选文件对话框没认出来），气泡放在屏幕下面居中。
 * 文字都由二狗的网页给，页面桥只用 textContent 画（模型回的话里有 HTML 也只是字）：
 * - none：收起；
 * - chooser：网页要选文件（text："网页要你选图片"），"让二狗选""自己选"；
 * - input：打字（label："对「标题」说"，placeholder 输入框里的提示）；
 * - listening：在听（levels：最近的音量 0–1，新的在后；秒数、上滑取消的样子页面桥自己管）；
 * - busy：二狗在办（said：用户打的字、认出来的字，说的还没认出来是空串；text：状态那一句，"二狗在想……"、
 *   "二狗正忙，排在后面，这一轮说完就看"（149 号票：秘书正忙着一轮，排队）、"在认说了什么……"；181 号票起说到助理的那一句
 *   另给 textParts，名字画成名字标签）；
 * - reply：回话（failed 没办成；system 是拦下的对话框上的指令，回话下面给"自己选"；more 是回话太长、宿主有浏览侧边栏，
 *   回话下面给"去侧边栏看"，点了报 bubble sidebar——147 号票，回话也记在秘书的会话里，侧边栏里看得到全文）。
 * 146 号票的 files（要交的文件）、pick（候选）149 号票起不在气泡里：候选画在挑图片窗口里（PagePickView）。
 * input、listening 的 labelParts（181 号票）是页面桥先自己画的"对二狗说"用的（名字画成名字标签），宿主现在不给
 */
export type PageBubbleView =
  | { kind: "none" }
  | { kind: "chooser"; fieldId: string; text: string }
  | { kind: "input"; fieldId: string; label: string; labelParts?: PageNamedText; placeholder: string }
  | { kind: "listening"; fieldId: string; label: string; labelParts?: PageNamedText; levels: number[] }
  | { kind: "busy"; fieldId: string; said: string; text: string; textParts?: PageNamedText }
  | { kind: "reply"; fieldId: string; said: string; text: string; failed: boolean; system: boolean; more: boolean };

export const PAGE_BUBBLE_NONE: PageBubbleView = { kind: "none" };

/** 挑图片窗口那一步：choosing 等用户挑、sending 在交、done 交好了（或别处处理了）、failed 没交进去（还能再点） */
export type PagePickPhase = "choosing" | "sending" | "done" | "failed";

/**
 * 挑图片窗口的样子（149 号票，用户 2026-10-18："挑图片的窗口不跟着悬浮按钮，固定弹在屏幕上让用户挑"）：二狗的网页
 * （app/page-pick.ts）照秘书给这台设备的网页候选卡算好、经宿主交给页面桥画（pick 方法）。画在页面桥的封闭 shadow 层里，固定位置：
 * 手机上从底部弹出、占屏宽，宽屏底部居中、宽度有上限；不跟着悬浮按钮、不随网页滚动。文字一律由二狗的网页给，页面桥只用 textContent：
 * - none：收起；
 * - pick：id 哪张候选卡，title（"二狗给「上传头像」找了 3 个"；181 号票起另给 titleParts，名字画成名字标签），note（提示、
 *   "在交……"、"交好了，1 个"、没交进去的原因），一排缩略图（multiple 多张的框能勾几张），phase（PagePickPhase）
 */
export type PagePickView =
  | { kind: "none" }
  | { kind: "pick"; id: string; title: string; titleParts?: PageNamedText; note: string; files: PageBubbleFile[]; multiple: boolean; phase: PagePickPhase };

export const PAGE_PICK_NONE: PagePickView = { kind: "none" };

/** 悬浮按钮的样子：idle 平常、listening 在听、busy 二狗在办 */
export type PageBridgeMark = "idle" | "listening" | "busy";

/**
 * 页面桥给宿主调的（window.__ergoPage）。第一个参数都是口令，不对就不做事；回 JSON 字符串的方法回 { ok, reason? } 这类：
 * - fields()：{ page, fields }；
 * - fill(fieldId, text)：往这个框里写字（整个换掉），照 React 等框架也认的方式触发 input、change；密码类的框不碰；
 * - fileBegin(id, name, mime) / fileChunk(id, base64) / attachFiles(fieldId, idsJson)：分段交来文件的字节，再一起交进选文件的框
 *   （DataTransfer 设进 input.files 触发 change；没有 input 的拖放区派 drop）；
 * - mark(fieldId, mark)：悬浮按钮的样子；
 * - bubble(viewJson)：悬浮按钮旁边的气泡画成这个样子（146 号票，PageBubbleView 的 JSON）；
 * - pick(viewJson)：挑图片窗口画成这个样子（149 号票，PagePickView 的 JSON）；
 * - selected()（147 号票）：{ page, field }，现在选中的框（没选中、框没了是 null；149 号票起 field 带着框里这一刻的内容）；
 * - text()（147 号票）：{ ok, page, text, truncated, total }，整页的正文文字（看得见的文字，去掉脚本、样式，空白收拾过，
 *   最多 PAGE_TEXT_MAX 字，truncated 截没截、total 一共多少字）；
 * - clearSelection()（147 号票）：取消选中（侧边栏顶上"现在在看"的 ×）；
 * - snapshot(max)（164 号票）：{ ok, page, elements, total }，网页上能点的东西（PageElement，最多 max 个，超出时屏幕上看得见的优先；
 *   total 是一共几个），编号只记在页面桥的内存里；
 * - texts(textsJson)（169 号票）：页面桥自己的字换成二狗的网页交来的这几句（PageBridgeTexts 的 JSON：bridge.* 的 key → 当前语言的句子，
 *   见 texts.ts）——悬浮按钮的说明、气泡和挑图片窗口上的按钮、在听的提示；没交来（旧版网页）、旧版 App 不认这个方法时是中文；
 *   181 号票起还带助理的名字和名字标签的颜色（assistant）；
 * - click(ref, url)（164 号票）：按编号点一个元素（url 是看的时候那一页的地址，去掉查询串）：{ ok, role, text, page }，
 *   换了网页、编号不认得、元素不在了、文字变了、禁用了回 { ok: false, reason }；184 号票起框（文本框、上传框、下拉框）点不了，回原因；
 * - refField(ref, url, want)（184 号票）：按编号找要填的文本框（want 是 textbox）、要交的上传框（upload）：{ ok, page, field }，field 是框的说法
 *   （id 是页面桥的框编号 f…，宿主再拿它调 fill、attachFiles）；换了网页、编号不认得、种类不对、元素不在了、种类变了（成了密码框、
 *   禁用了）回 { ok: false, reason }（原因按二狗的网页交来的语言写，挑图片窗口里也显示）。
 * 秘书的填字、交文件照旧用 fill、attachFiles（宿主核对过是选中的框才调）。点什么由秘书经守护进程定（守护进程拦着支付、提交、删除
 * 这类字眼的，让用户自己点）；页面桥自己不主动点、不主动提交
 */
export interface PageBridgeApi {
  fields(nonce: string): string;
  fill(nonce: string, fieldId: string, text: string): string;
  fileBegin(nonce: string, id: string, name: string, mime: string): string;
  fileChunk(nonce: string, id: string, base64: string): string;
  attachFiles(nonce: string, fieldId: string, idsJson: string): string;
  mark(nonce: string, fieldId: string, mark: PageBridgeMark): string;
  bubble(nonce: string, viewJson: string): string;
  pick(nonce: string, viewJson: string): string;
  selected(nonce: string): string;
  text(nonce: string): string;
  clearSelection(nonce: string): string;
  snapshot(nonce: string, max: string): string;
  click(nonce: string, ref: string, url: string): string;
  refField(nonce: string, ref: string, url: string, want: string): string;
  texts(nonce: string, textsJson: string): string;
}

/** 方法的名字（宿主核对用：只许调这几个） */
export const PAGE_BRIDGE_API_METHODS = ["fields", "fill", "fileBegin", "fileChunk", "attachFiles", "mark", "bubble", "pick", "selected", "text", "clearSelection", "snapshot", "click", "refField", "texts"] as const;
