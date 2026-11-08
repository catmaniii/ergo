// 页面桥里不碰 DOM 的规矩：哪些 input 算文本框、哪些框是密码类（不列、不填、不出悬浮按钮）、标签文字怎么收拾、
// 悬浮按钮摆在框的哪边、这一刻该贴着元素还是常驻右下角还是不显示（fabSpot、placeCornerButton，地图也用）；还有按钮旁边的小气泡摆在哪、波形的竖条多高、按住说话怎么算取消；按住说话时气泡在
// 按钮上方（placeListening）、挑图片窗口摆在哪（placePickWindow）；还有能点的东西是什么种类（clickRoleOf）、文字怎么收拾
// （cleanElementText）、超过上限先列哪些（chooseClickables）、哪些 target 开新窗口（opensNewWindow）；还有能填、能交、
// 能选的控件是什么种类（FieldRole）、现在的值怎么截（previewText）、下拉框的选项怎么收拾（optionTexts）。
// 单独一个文件，测试在 Node 里直接跑（test/page-bridge/rules.test.ts）。

/** 算单行文本框的 input 类型（日期、颜色、勾选这些不算） */
export const TEXT_INPUT_TYPES: readonly string[] = ["", "text", "search", "email", "url", "tel", "number"];

/** autocomplete 里写了这些的是密码、银行卡、一次性验证码 */
const SENSITIVE_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code|cc-[a-z-]+)\b/i;

/**
 * 名字、id、placeholder、标签、aria-label 里出现这些的是密码类：密码、口令、验证码、校验码、动态码、银行卡、信用卡、卡号、安全码、
 * CVV、PIN……（中英文）。宁可多认几个不填，不能填进密码框
 */
const SENSITIVE_WORDS =
  // @i18n-ignore-next data：认网页上中文的密码类字眼
  /(密\s*码|口\s*令|验\s*证\s*码|校\s*验\s*码|动\s*态\s*码|短\s*信\s*码|安\s*全\s*码|银\s*行\s*卡|信\s*用\s*卡|储\s*蓄\s*卡|卡\s*号|支付密|password|passwd|passcode|\bpwd\b|captcha|\botp\b|one[-_ ]?time|verif(y|ication)[-_ ]?code|sms[-_ ]?code|security[-_ ]?code|\bcvv\d?\b|\bcvc\d?\b|card[-_ ]?(number|num|no)\b|\bccnum|credit[-_ ]?card|\bpin\b)/i;

/** 这个框是不是密码类：type=password、autocomplete 是密码 / 银行卡 / 验证码、提示文字里有那些词 */
export function isSensitiveField(input: { type?: string; autocomplete?: string; hints: readonly string[] }): boolean {
  if ((input.type ?? "").toLowerCase() === "password") return true;
  if (input.autocomplete && SENSITIVE_AUTOCOMPLETE.test(input.autocomplete)) return true;
  return input.hints.some((h) => SENSITIVE_WORDS.test(h));
}

/** 标签文字：空白并成一个空格、去掉末尾的冒号和星号，最长 80 字 */
export function cleanLabel(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s:：*＊]+$/, "") // @i18n-ignore data：去掉网页标签末尾的全角冒号、星号
    .slice(0, 80);
}

/** 整页文字最多交多少字（和协议的 BROWSER_PAGE_TEXT_MAX 一样；页面桥的脚本里不引用协议包的值） */
export const PAGE_TEXT_MAX = 20_000;
/** 框里现在的内容最多交多少字（和协议的 PAGE_FIELD_VALUE_MAX 一样） */
export const FIELD_VALUE_MAX = 5000;

/**
 * 整页文字收拾一下（读网页）：每行去掉首尾空白、行内连着的空白并成一个空格，空行并成一个，最多 max 字（多的截掉，
 * 写明截了、一共多少字——一共的按收拾过的算）
 */
export function tidyPageText(raw: string, max = PAGE_TEXT_MAX): { text: string; truncated: boolean; total: number } {
  const lines: string[] = [];
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const tidy = line.replace(/[\s\u00a0]+/g, " ").trim();
    if (tidy) lines.push(tidy);
    else if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  }
  while (lines.at(-1) === "") lines.pop();
  const all = lines.join("\n");
  return all.length > max ? { text: all.slice(0, max), truncated: true, total: all.length } : { text: all, truncated: false, total: all.length };
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// ---------- 长按元素的圆钮 ----------

/** 圆钮没人用时留多久（毫秒）：按到第一下实测用不到 2 秒，再长就挡内容（真机上再看够不够） */
export const ELEMENT_KEEP_MS = 5000;
/** 元素的地址最长多少（和协议的 PICKED_ELEMENT_URL_MAX 一样）、说明文字最多多少字（PICKED_ELEMENT_LABEL_MAX） */
export const ELEMENT_URL_MAX = 2048;
export const ELEMENT_LABEL_MAX = 300;

/** 说明文字（alt、title）：空白并成一个空格，最多 ELEMENT_LABEL_MAX 字 */
export function cleanElementLabel(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, ELEMENT_LABEL_MAX);
}

/** 图片、视频的地址从哪取：http、https 由 App 取，data:、blob: 页面桥读；别的（没有地址、about:）是 undefined */
export function elementSourceOf(url: string): "http" | "data" | "blob" | undefined {
  if (/^https?:\/\//i.test(url)) return "http";
  if (/^data:/i.test(url)) return "data";
  if (/^blob:/i.test(url)) return "blob";
  return undefined;
}

/** 系统选文字的浮动工具条占选区上方多高（两个模拟器量的，安卓约 60、鸿蒙约 66，留点余量） */
const TOOLBAR_CLEARANCE = 74;
/** 选区手柄往选区下方伸出多少（安卓约 24、鸿蒙约 18） */
const HANDLE_CLEARANCE = 30;

/**
 * 圆钮摆在哪（左上角，视口坐标）。系统选文字的工具条是原生层，盖在网页上（两个平台都贴在选区上方）：
 * - 有选区：放选区下方让开手柄；下面放不下放到工具条上方；都不行贴着看得见的部分的下边（选区比屏幕还长时工具条在别处）；
 * - 没选区（图、链接，它们没有系统菜单）：放按的点右上方（手指还按着时看得见），上面放不下放下方。
 * 左右夹在看得见的部分里
 */
export function placeElementButton(point: { x: number; y: number }, selection: Rect | undefined, area: Rect, size = BUTTON_SIZE): { x: number; y: number } {
  const x = Math.max(area.left + EDGE, Math.min(point.x + 16, area.right - size - EDGE));
  const maxY = area.bottom - size - EDGE;
  const minY = area.top + EDGE;
  if (selection) {
    const below = selection.bottom + HANDLE_CLEARANCE;
    if (below <= maxY) return { x, y: Math.max(minY, below) };
    const above = selection.top - TOOLBAR_CLEARANCE - size;
    if (above >= minY) return { x, y: above };
    return { x, y: maxY };
  }
  const above = point.y - 26 - size;
  if (above >= minY) return { x, y: above };
  return { x, y: Math.min(maxY, point.y + 24) };
}

// ---------- 选中的地址用地图（447）----------

/** 地址、地名最长多少字（再长多半是一段话，不给地图那两个按钮） */
export const ADDRESS_TEXT_MAX = 120;
/** 拿不准的短短一段最长多少字（可能是地名："西湖""Eiffel Tower"） */
const PLACE_NAME_MAX = 30;
/** 拿不准的英文最多几个词 */
const PLACE_WORDS_MAX = 6;
/** 网址、邮箱 */
const URLISH = /(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[a-z]{2,})/i;
/** 只有数字和符号（电话、价钱、时间、编号） */
const ONLY_NUMBERS = /^[\d\s+()\-.,:/#*￥¥$€£%~～]+$/;
/** 句号、问号、叹号（一段话里有两个以上就不是地址） */
const SENTENCE_END = /[。！？!?]/g;
/** 中文地址的门牌、路名、行政区、邮编 */
const CN_STRONG = [/\d+\s*(号|弄|栋|幢|座|室|单元)/, /(路|街|大道|巷|弄|胡同|道)\s*\d+/, /(省|自治区).{0,12}(市|州|盟)/, /(市|州).{0,10}(区|县|旗)/, /(邮编|邮政编码)\s*[:：]?\s*\d{6}/];
/** 中文的地名用字（短的里有它们就当是地址） */
const CN_PLACE = /(省|市|区|县|镇|乡|街道|村|路|街|大道|巷|弄|胡同|小区|大厦|广场|商场|公园|景区|机场|车站|火车站|高铁站|地铁站|码头|大学|学院|医院|酒店|宾馆|饭店|寺|塔|桥)/;
/** 英文地址：门牌 + 街名、美国的州 + 邮编、英国的邮编、新加坡的邮编、邮政信箱 */
const EN_STRONG = [
  /\b\d+[a-z]?\s+(?:[\w'.-]+\s+){0,4}(street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|square|sq|highway|hwy|parkway|pkwy|terrace|crescent|close|circle|cir)\b/i,
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/,
  /\bsingapore\s+\d{6}\b/i,
  /\bp\.?\s?o\.?\s+box\s+\d+/i,
];
/** 空格、制表符、不换行空格、全角空格（换行留着：几行算不算地址要数） */
const SPACES = /[ \t 　]+/g;

/** 选中的一段字像不像地址、地名：address 像（门牌、路名、邮编……）、maybe 拿不准（短短一段，可能是地名）、no 不像（太长、网址、电话、一段话） */
export type AddressGuess = "address" | "maybe" | "no";

/**
 * 网页上选中的字像不像地址、地名（447：选中地址时圆钮旁边多"在地图上看""怎么去"）。简单的规则，判断不准时宁可给（maybe 也给），
 * 查不到再说：中文的门牌、路名、行政区、邮编，常见的英文地址（门牌加街名、州加邮编、英国和新加坡的邮编）；
 * 不给的只有一看就不是的：太长、网址邮箱、只有数字符号、好几句话
 */
export function guessAddress(raw: string): AddressGuess {
  const text = raw.replace(SPACES, " ").trim();
  if (text.length < 2 || text.length > ADDRESS_TEXT_MAX) return "no";
  if (URLISH.test(text) || ONLY_NUMBERS.test(text)) return "no";
  if (text.split(/\n+/).length > 3) return "no";
  if ((text.match(SENTENCE_END) ?? []).length >= 2) return "no";
  if (CN_STRONG.some((re) => re.test(text)) || EN_STRONG.some((re) => re.test(text))) return "address";
  const oneLine = !text.includes("\n");
  if (oneLine && text.length <= 60 && CN_PLACE.test(text)) return "address";
  if (oneLine && text.length <= PLACE_NAME_MAX && text.split(" ").length <= PLACE_WORDS_MAX) return "maybe";
  return "no";
}

/** 圆钮旁边给不给"在地图上看""怎么去"（像的、拿不准的都给） */
export function offersMapActions(text: string): boolean {
  return guessAddress(text) !== "no";
}

/** 交给地图服务查的那段：空白并成一个，去掉开头的"地址：""Address:"这类说明和末尾的标点 */
export function mapQueryOf(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(地址|位置|地点|住址|address|location|addr)\s*[:：]\s*/i, "")
    .replace(/[。，,;；.!！?？、\s]+$/, "")
    .slice(0, ADDRESS_TEXT_MAX);
}

/** 地图那两个小按钮离圆钮多远 */
export const MAP_CHIPS_GAP = 6;

/**
 * 地图那两个小按钮（一行）摆在哪（左上角，视口坐标）：圆钮右边、竖着和圆钮居中；右边放不下放左边；都放不下放圆钮下面（左边对齐，
 * 夹在看得见的部分里），下面也放不下放上面
 */
export function placeMapChips(button: Rect, size: { width: number; height: number }, area: Rect): { x: number; y: number } {
  const midY = (button.top + button.bottom) / 2 - size.height / 2;
  const clampY = (y: number) => Math.max(area.top + EDGE, Math.min(y, area.bottom - size.height - EDGE));
  const right = button.right + MAP_CHIPS_GAP;
  if (right + size.width <= area.right - EDGE) return { x: right, y: clampY(midY) };
  const left = button.left - MAP_CHIPS_GAP - size.width;
  if (left >= area.left + EDGE) return { x: left, y: clampY(midY) };
  const x = Math.max(area.left + EDGE, Math.min(button.left, area.right - size.width - EDGE));
  const below = button.bottom + MAP_CHIPS_GAP;
  if (below + size.height <= area.bottom - EDGE) return { x, y: below };
  return { x, y: clampY(button.top - MAP_CHIPS_GAP - size.height) };
}

/** 悬浮按钮多大、离框多远（CSS 像素）；离视口边至少留多少 */
export const BUTTON_SIZE = 36;
export const BUTTON_GAP = 6;
const EDGE = 4;

/**
 * 悬浮按钮摆在哪（左上角，视口坐标）：先放框的右边（单行框竖着居中，多行框贴底），别挡住输入的字；右边放不下（手机上框多半占满整行）
 * 放框下面靠右，下面也放不下放上面，都不行才放进框里的右下角。框整个滚出视口时不显示（undefined）
 */
export function placeButton(anchor: Rect, viewport: { width: number; height: number }): { x: number; y: number } | undefined {
  if (anchor.bottom < 0 || anchor.top > viewport.height || anchor.right < 0 || anchor.left > viewport.width) return undefined;
  const s = BUTTON_SIZE;
  const height = anchor.bottom - anchor.top;
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, viewport.width - s - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, viewport.height - s - EDGE));
  if (anchor.right + BUTTON_GAP + s <= viewport.width - EDGE) {
    const y = height < s * 2 ? anchor.top + (height - s) / 2 : anchor.bottom - s;
    return { x: anchor.right + BUTTON_GAP, y: clampY(y) };
  }
  const x = clampX(anchor.right - s);
  if (anchor.bottom + BUTTON_GAP + s <= viewport.height - EDGE) return { x, y: anchor.bottom + BUTTON_GAP };
  if (anchor.top - BUTTON_GAP - s >= EDGE) return { x, y: anchor.top - BUTTON_GAP - s };
  return { x: clampX(anchor.right - s - EDGE), y: clampY(anchor.bottom - s - EDGE) };
}

// ---------- 悬浮按钮在哪：贴着选中的元素、常驻右下角、不显示 ----------

/**
 * 悬浮按钮这一刻该在哪（四种情况）：选中了网页元素（文本框有焦点、点了上传处、长按出了圆钮）就贴到元素旁边，侧边栏开不开都一样；
 * 没选中时侧边栏关着常驻右下角、开着不显示（侧边栏里就能和二狗说话）。浏览和地图（右边的二狗聊天窗）共用这一条
 */
export type FabSpot = "anchor" | "corner" | "none";

export function fabSpot(at: { selected: boolean; sideOpen: boolean }): FabSpot {
  if (at.selected) return "anchor";
  return at.sideOpen ? "none" : "corner";
}

/** 右下角的按钮离右边、底边多远（CSS 像素）：照谷歌地图右下角的按钮 */
export const CORNER_GAP = 16;
/** 让开网页自己的底部栏、悬浮按钮时最多往上挪看得见的部分的几成：再高就不让了（盖住一点，不跑到屏幕中间去） */
export const CORNER_LIFT_SHARE = 0.4;
/** 让开的东西和按钮之间留多少 */
const CORNER_CLEARANCE = 8;

/**
 * 右下角的按钮摆在哪（左上角，视口坐标）：area 是看得见的部分；inset 是底下再让开多少（系统手势区：网页延伸到手势条底下时那一截）；
 * obstacles 是网页自己固定在屏幕上的东西（底部栏、右下角的客服按钮……，宿主量好的视口坐标）——盖住按钮的就挪到它上面，
 * 挪了再看有没有盖住的，最多往上挪看得见的部分的 CORNER_LIFT_SHARE；挪不下就留在原处（盖住一点，不跑到屏幕中间）。
 * 按钮不拖动，固定在右下角
 */
export function placeCornerButton(area: Rect, inset = 0, obstacles: readonly Rect[] = [], size = BUTTON_SIZE): { x: number; y: number } {
  const x = Math.max(area.left + EDGE, area.right - CORNER_GAP - size);
  const base = Math.max(area.top + EDGE, area.bottom - CORNER_GAP - Math.max(0, inset) - size);
  const highest = Math.max(area.top + EDGE, base - (area.bottom - area.top) * CORNER_LIFT_SHARE);
  let y = base;
  for (let round = 0; round <= obstacles.length; round++) {
    const hit = obstacles.filter((r) => r.left < x + size && r.right > x && r.top < y + size && r.bottom > y);
    if (hit.length === 0) return { x, y };
    y = Math.min(...hit.map((r) => r.top)) - CORNER_CLEARANCE - size;
    if (y < highest) return { x, y: base };
  }
  return { x, y: base };
}

// ---------- 悬浮按钮旁边的小气泡 ----------

/** 气泡离看得见的部分的边至少留多少、离按钮多远、最宽多宽、最高多高（内容多了气泡里自己滚）（CSS 像素） */
export const BUBBLE_EDGE = 8;
export const BUBBLE_GAP = 8;
export const BUBBLE_MAX_WIDTH = 360;
export const BUBBLE_MAX_HEIGHT = 320;
/** 手机上气泡比屏幕窄多少（左右各 16） */
const BUBBLE_INSET = 32;
/** 小尖角离气泡左右边至少多远（不出圆角） */
const TAIL_INSET = 16;

/** 气泡多宽：手机上屏宽减 32，最宽 360 */
export function bubbleWidth(viewportWidth: number): number {
  return Math.max(0, Math.min(BUBBLE_MAX_WIDTH, viewportWidth - BUBBLE_INSET));
}

/** 气泡限高时最矮多高才算放得下（头一行加一行字、或者一个输入框） */
export const BUBBLE_MIN_HEIGHT = 120;
/** 多行的框里文字所在的那一块：从框的上边起这么高（大约两行字加内边距） */
const TEXT_BLOCK = 56;

/**
 * 气泡摆在哪（视口坐标）：side 是在按钮上方、下方、左边、右边（按住说话时按钮贴着顶，上方放不下），还是没有按钮
 * （free：放在看得见的部分的下面居中）；maxHeight 是气泡最高能多高（内容比它高就在里面滚）；tailX 是小尖角离气泡左边多远（指着按钮的
 * 中线，没有按钮、在左右两边时是 -1）；tailY 是在左右两边时小尖角离气泡上边多远（指着按钮的中线）；width 是在左右两边时气泡收窄到多宽
 * （放得下就是原来的宽度）；covers 是盖住了框没有（none 没盖、field 盖了框但没盖文字那块、text 盖了文字那块——实在放不下才这样）
 */
export interface BubblePlacement {
  x: number;
  y: number;
  maxHeight: number;
  side: "above" | "below" | "left" | "right" | "free";
  tailX: number;
  tailY?: number;
  width?: number;
  covers: "none" | "field" | "text";
}

/** 框里文字所在的那一块：单行的框（不到按钮两倍高）是整个框，多行的框是上面一截（字从上往下排；气泡开着时焦点在气泡里，框里的字不会变） */
export function textBlockOf(field: Rect): Rect {
  return field.bottom - field.top < BUTTON_SIZE * 2 ? field : { ...field, bottom: field.top + TEXT_BLOCK };
}

type Side = "above" | "below";

/** 先试哪一边（背离框的那一边）：按钮在框下面先下方、在框上面先上方；在框旁边、框里看按钮在框的下半截还是上半截；不知道框在哪先上方 */
function sideOrder(button: Rect, field: Rect | undefined): [Side, Side] {
  if (!field) return ["above", "below"];
  if (button.top >= field.bottom - 1) return ["below", "above"];
  if (button.bottom <= field.top + 1) return ["above", "below"];
  return (button.top + button.bottom) / 2 >= (field.top + field.bottom) / 2 ? ["below", "above"] : ["above", "below"];
}

/** 气泡在某一边能占的一段（竖着的上下范围） */
interface Slot {
  side: Side;
  top: number;
  bottom: number;
}

/**
 * 按钮某一边能放气泡的几段（先贴着按钮的，再越过挡着的东西的）：obstacle 是不许盖的那块（框、或者框里文字那块；和气泡横着不重叠的不算）。
 * 挡着的东西和按钮之间放得下就贴着按钮放（比如多行框文字下面的空白处），不然越过它放到另一头
 */
function slots(side: Side, button: Rect, view: Rect, obstacle: Rect | undefined): Slot[] {
  const lo = view.top + BUBBLE_EDGE;
  const hi = view.bottom - BUBBLE_EDGE;
  if (side === "above") {
    const end = button.top - BUBBLE_GAP;
    if (!obstacle || obstacle.top >= button.top) return [{ side, top: lo, bottom: end }];
    const out: Slot[] = [];
    if (obstacle.bottom + BUBBLE_GAP <= end) out.push({ side, top: Math.max(lo, obstacle.bottom + BUBBLE_GAP), bottom: end });
    out.push({ side, top: lo, bottom: Math.min(end, obstacle.top - BUBBLE_GAP) });
    return out;
  }
  const start = button.bottom + BUBBLE_GAP;
  if (!obstacle || obstacle.bottom <= button.bottom) return [{ side, top: start, bottom: hi }];
  const out: Slot[] = [];
  if (obstacle.top - BUBBLE_GAP >= start) out.push({ side, top: start, bottom: Math.min(hi, obstacle.top - BUBBLE_GAP) });
  out.push({ side, top: Math.max(start, obstacle.bottom + BUBBLE_GAP), bottom: hi });
  return out;
}

const roomOf = (slot: Slot) => Math.max(0, slot.bottom - slot.top);

/** 几段里最高的那段（一样高取前面的，也就是先试的那一边） */
function tallest(list: readonly Slot[]): Slot | undefined {
  return list.reduce<Slot | undefined>((best, s) => (best === undefined || roomOf(s) > roomOf(best) ? s : best), undefined);
}

/**
 * 气泡摆在哪（气泡不要盖住框）：button 是悬浮按钮（undefined 是不知道跟哪个框）；size 是气泡按内容要多宽多高；
 * view 是看得见的部分（手机上输入法弹起时只剩上面那一截，缩放时是放大的那一块）；field 是按钮挂着的框（不知道是 undefined）。
 * 横着以按钮为中，左右不出看得见的部分、至少留 8。竖着依次试：
 * 1. 全高放得下、不盖框：先背离框的那一边（按钮在框下面放下方、在框上面放上方），放不下换另一边（越过框放到框的另一头）；
 * 2. 全高放得下、不盖框里文字那块（多行框的上面一截；盖文字下面的空白处）；
 * 3. 限高（至少 120，内容在气泡里滚）、不盖框，挑空间大的那段；再不行限高、不盖文字那块；
 * 4. 实在不行才盖：贴着按钮，先背离的那边放得下的，不然空间大的那边，限高。
 * 不知道框在哪时优先上方、放不下到下方。没有按钮放在看得见的部分下面居中
 */
export function placeBubble(button: Rect | undefined, size: { width: number; height: number }, view: Rect, field?: Rect): BubblePlacement {
  const width = size.width;
  const wanted = Math.min(size.height, BUBBLE_MAX_HEIGHT);
  const center = button ? (button.left + button.right) / 2 : (view.left + view.right) / 2;
  const minX = view.left + BUBBLE_EDGE;
  const maxX = view.right - BUBBLE_EDGE - width;
  const x = Math.max(minX, Math.min(center - width / 2, maxX));
  if (!button) {
    const maxHeight = Math.max(0, Math.min(BUBBLE_MAX_HEIGHT, view.bottom - view.top - 2 * BUBBLE_EDGE));
    return { x, y: view.bottom - BUBBLE_EDGE - Math.min(wanted, maxHeight), maxHeight, side: "free", tailX: -1, covers: "none" };
  }
  const tailX = Math.max(TAIL_INSET, Math.min(center - x, width - TAIL_INSET));
  const order = sideOrder(button, field);
  const crossing = (r: Rect | undefined) => (r && r.left < x + width && r.right > x ? r : undefined);
  const levels = field ? [crossing(field), crossing(textBlockOf(field))] : [undefined];
  const candidates = (obstacle: Rect | undefined) => order.flatMap((side) => slots(side, button, view, obstacle));
  const make = (slot: Slot): BubblePlacement => {
    const maxHeight = Math.min(BUBBLE_MAX_HEIGHT, roomOf(slot));
    const height = Math.min(wanted, maxHeight);
    const y = slot.side === "above" ? slot.bottom - height : slot.top;
    const rect: Rect = { left: x, top: y, right: x + width, bottom: y + height };
    const hits = (r: Rect) => r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top;
    const covers = !field ? "none" : hits(textBlockOf(field)) ? "text" : hits(field) ? "field" : "none";
    return { x, y, maxHeight, side: slot.side, tailX, covers };
  };
  for (const obstacle of levels) {
    const fit = candidates(obstacle).find((s) => roomOf(s) >= wanted);
    if (fit) return make(fit);
  }
  for (const obstacle of levels) {
    const best = tallest(candidates(obstacle));
    if (best && roomOf(best) >= Math.min(wanted, BUBBLE_MIN_HEIGHT)) return make(best);
  }
  const plain = order.map((side) => slots(side, button, view, undefined)[0]!);
  return make(plain.find((s) => roomOf(s) >= wanted) ?? tallest(plain)!);
}

/** 气泡在按钮左右两边时最窄多窄（再窄放不下波形和秒数） */
const SIDE_MIN_WIDTH = 160;

/**
 * 按住说话时气泡摆在哪（"按住悬浮按钮说话时，波形在按钮上方"——手指按在按钮上，下方和按钮本身会被挡住）：
 * 不管按钮背离框是哪一边，都放在按钮上方，横着以按钮为中、不出看得见的部分；上方放不下（按钮贴着屏幕顶），放在按钮左边或右边
 * 空间大的那一侧（离按着按钮的手指远），竖着以按钮为中，宽度不够就收窄（最窄 160）；不放在下方。可以盖住框（说话时不用看框）
 */
export function placeListening(button: Rect, size: { width: number; height: number }, view: Rect): BubblePlacement {
  const wanted = Math.min(size.height, BUBBLE_MAX_HEIGHT);
  const centerX = (button.left + button.right) / 2;
  const centerY = (button.top + button.bottom) / 2;
  const above = button.top - BUBBLE_GAP - (view.top + BUBBLE_EDGE);
  if (above >= wanted) {
    const x = Math.max(view.left + BUBBLE_EDGE, Math.min(centerX - size.width / 2, view.right - BUBBLE_EDGE - size.width));
    return { x, y: button.top - BUBBLE_GAP - wanted, maxHeight: Math.min(BUBBLE_MAX_HEIGHT, above), side: "above", tailX: Math.max(TAIL_INSET, Math.min(centerX - x, size.width - TAIL_INSET)), covers: "none" };
  }
  const leftRoom = button.left - BUBBLE_GAP - (view.left + BUBBLE_EDGE);
  const rightRoom = view.right - BUBBLE_EDGE - (button.right + BUBBLE_GAP);
  const side = leftRoom >= rightRoom ? "left" : "right";
  const width = Math.max(Math.min(SIDE_MIN_WIDTH, size.width), Math.min(size.width, side === "left" ? leftRoom : rightRoom));
  const x = side === "left" ? button.left - BUBBLE_GAP - width : button.right + BUBBLE_GAP;
  const maxHeight = Math.max(0, Math.min(BUBBLE_MAX_HEIGHT, view.bottom - view.top - 2 * BUBBLE_EDGE));
  const height = Math.min(wanted, maxHeight);
  const y = Math.max(view.top + BUBBLE_EDGE, Math.min(centerY - height / 2, view.bottom - BUBBLE_EDGE - height));
  return { x, y, maxHeight, side, tailX: -1, tailY: Math.max(TAIL_INSET, Math.min(centerY - y, height - TAIL_INSET)), width, covers: "none" };
}

// ---------- 挑图片窗口 ----------

/** 宽屏上挑图片窗口最宽多宽、离边多远；窗口最高多高（内容多了在里面滚） */
export const PICK_MAX_WIDTH = 520;
export const PICK_EDGE = 16;
export const PICK_MAX_HEIGHT = 340;
/** 看得见的部分不到这么宽算手机（和二狗的窄屏、宽屏分界一样） */
export const PICK_WIDE_MIN = 600;

/**
 * 挑图片窗口摆在哪（"挑图片的窗口不跟着悬浮按钮，固定弹在屏幕上让用户挑"）：只看看得见的部分
 * （输入法弹起时只剩上面那一截），和按钮、框、网页滚到哪都无关——手机上贴着底、占满宽（docked：只有上面两个角是圆的）；
 * 宽屏底部居中，离底 16，宽度最多 520。height 是窗口按内容要多高
 */
export function placePickWindow(view: Rect, height: number): { x: number; y: number; width: number; maxHeight: number; docked: boolean } {
  const viewWidth = view.right - view.left;
  const docked = viewWidth < PICK_WIDE_MIN;
  const width = docked ? viewWidth : Math.min(PICK_MAX_WIDTH, viewWidth - 2 * PICK_EDGE);
  const gap = docked ? 0 : PICK_EDGE;
  const maxHeight = Math.max(0, Math.min(PICK_MAX_HEIGHT, view.bottom - view.top - gap - BUBBLE_EDGE));
  const h = Math.min(height, maxHeight);
  return { x: view.left + (viewWidth - width) / 2, y: view.bottom - gap - h, width, maxHeight, docked };
}

/** 气泡里的波形有几格（每格是一次音量采样，二狗的网页约 0.08 秒送一次） */
export const WAVE_BARS = 28;
/** 竖条最矮多高（百分比）：没声音时也看得见一排 */
const WAVE_MIN = 6;

/**
 * 音量序列 → 竖条高度（百分比）：照二狗 App 里"按住说话"的波形（ui/conversation/VoiceInput.tsx）——取最近的 count 格，
 * 音量（0–1）×100 取整、最矮 6；不够的前面补最矮的
 */
export function waveBars(levels: readonly number[], count = WAVE_BARS): number[] {
  const recent = levels.slice(-count);
  const pad = Array.from({ length: Math.max(0, count - recent.length) }, () => WAVE_MIN);
  return [...pad, ...recent.map((v) => Math.max(WAVE_MIN, Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 100)))];
}

/** 按住说话时上滑多远进"松开取消"（和二狗 App 里"按住说话"一样），往别处划开多远也算（原来的规则） */
export const VOICE_CANCEL_UP = 60;
export const VOICE_CANCEL_AWAY = 80;

/** 按住说话的手指从 from 挪到 to：在不在"松开取消"里（上滑 60、或往别处划开超过 80）；挪回来就又不在了 */
export function inVoiceCancelZone(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return from.y - to.y >= VOICE_CANCEL_UP || Math.hypot(to.x - from.x, to.y - from.y) > VOICE_CANCEL_AWAY;
}

/** 录了多久写成"分:秒"（和二狗 App 里"按住说话"的录音面板一样） */
export function recordedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ───────────────────────── 能点的东西（clickables.ts） ─────────────────────────

/** 能点的东西的种类（和协议的 PAGE_ELEMENT_ROLES 一样；页面桥的脚本里不引用协议包的值） */
export type ClickRole = "link" | "button" | "menuitem" | "tab" | "input" | "submit";

/** 能填、能交、能选的控件的种类（和协议的 PAGE_FIELD_ROLES 一样）：文本框、上传框、下拉框 */
export type FieldRole = "textbox" | "upload" | "select";
/** snapshot 列的东西的种类：能点的和能填、能交、能选的 */
export type ElementRole = ClickRole | FieldRole;

export const isFieldRole = (role: string): role is FieldRole => role === "textbox" || role === "upload" || role === "select";

/** 现在的值最多交多少字、下拉框最多交几个选项、一个选项最长多少字（和协议的 PAGE_ELEMENT_VALUE_MAX 这几个一样） */
export const VALUE_PREVIEW_MAX = 40;
export const OPTIONS_MAX = 20;
export const OPTION_TEXT_MAX = 100;

/** 现在的值：空白并成一个空格、去掉两头的，取前 40 字；空的是 undefined（不写） */
export function previewText(value: string | null | undefined): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim().slice(0, VALUE_PREVIEW_MAX);
  return text === "" ? undefined : text;
}

/** 下拉框的选项：每个收拾空白、最长 100，空的去掉，最多 20 个 */
export function optionTexts(list: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const raw of list) {
    if (out.length >= OPTIONS_MAX) break;
    const text = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, OPTION_TEXT_MAX);
    if (text) out.push(text);
  }
  return out;
}

/** 能点的东西上的文字最长多少（和协议的 PageElement.text 一样） */
export const CLICK_TEXT_MAX = 200;

/**
 * 能点的东西是什么种类：提交表单的先认（button 的 type 默认是 submit、在表单里才算；input 的 submit、image），会提交表单的要让秘书看得出来；
 * 再看 role（menuitem、tab、link、button）；a、area 是链接；input 的 button、reset 是 input；summary 和别的是按钮
 */
export function clickRoleOf(el: { tag: string; type: string; role: string; hasForm: boolean }): ClickRole {
  const tag = el.tag.toLowerCase();
  const type = el.type.trim().toLowerCase();
  if (tag === "input" && (type === "submit" || type === "image")) return "submit";
  if (tag === "button" && (type === "" || type === "submit") && el.hasForm) return "submit";
  const role = el.role.trim().toLowerCase();
  if (role === "menuitem" || role === "tab" || role === "link" || role === "button") return role;
  if (tag === "a" || tag === "area") return "link";
  if (tag === "input") return "input";
  return "button";
}

/** 能点的东西上的文字：空白并成一个空格、去掉两头的，最长 CLICK_TEXT_MAX */
export function cleanElementText(text: string | null | undefined): string {
  // JS 的 \s 里有不换行空格
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, CLICK_TEXT_MAX);
}

/**
 * 超过上限时先列哪些（item 照页面上的先后给，rect 是视口坐标）：屏幕上看得见的、上半屏的先，再是下半屏的，屏幕外的按离屏幕多远
 * （上下、左右差多少加起来）；挑出来的照页面上的先后交出去
 */
export function chooseClickables<T>(items: ReadonlyArray<{ item: T; rect: Rect }>, view: { width: number; height: number }, max: number): T[] {
  const ranked = items.map(({ rect }, index) => {
    const dy = rect.bottom <= 0 ? -rect.bottom : rect.top >= view.height ? rect.top - view.height : 0;
    const dx = rect.right <= 0 ? -rect.right : rect.left >= view.width ? rect.left - view.width : 0;
    const seen = dx === 0 && dy === 0;
    const rank = seen ? (rect.top < view.height / 2 ? 0 : 1) : 2;
    return { index, rank, far: seen ? 0 : dx + dy };
  });
  // 不用 toSorted：页面桥要在 Chrome 100 起的 ArkWeb 上跑
  const picked = ranked.sort((a, b) => a.rank - b.rank || a.far - b.far || a.index - b.index).slice(0, Math.max(0, max));
  return picked
    .map((p) => p.index)
    .sort((a, b) => a - b)
    .map((i) => items[i]!.item);
}

/** 这个 target 会不会开新窗口：_blank 和起了名字的都会；空的、_self、_top、_parent 不会 */
export function opensNewWindow(target: string | null | undefined): boolean {
  const t = (target ?? "").trim();
  return t !== "" && !/^_(self|top|parent)$/i.test(t);
}
