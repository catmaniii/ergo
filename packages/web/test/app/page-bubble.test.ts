// 悬浮按钮旁边的小气泡在二狗网页这一侧（146 号票，app/page-bubble.ts）：面板 → 气泡的样子（纯函数），和把它交给页面桥的那一层
// （App、录音、识别、store 都换成假的）。查：
// - 打字：对哪个框说、输入框里的提示（上传框和文本框不一样）；在听带着音量；在办带着打的字、认出来的字和那一句状态（149 号票：
//   在认说了什么、二狗在想、秘书正忙时"排在后面"）；回话（拦下的对话框上的指令给"自己选"）；跟着哪个框（不知道哪个框是空串）；
// - 面板变了就交，一样的不重复交；开场先交一个收起（App 里二狗的网页重新加载过，浏览器的网页上可能还留着上次的气泡）；
//   页面桥点了、长按了、气泡上点了什么之后再交一遍（"让二狗选"除外：等框的列表回来面板变了再交）；
// - 拦下的选文件对话框画不出来（页面桥不在）：交给系统的选择器；
// - 147 号票：有浏览侧边栏时太长的回话（字多、行多）下面给"去侧边栏看"（more），没有侧边栏、不长的不给。
// 149 号票起候选不在气泡里（挑图片窗口见 page-pick.test.ts）。
// 169 号票：气泡上的字跟着当前语言；悬浮按钮出来、选中的框变了时把页面桥自己的那几句（当前语言的）交给它。
// 181 号票：说到助理的那几句用用户起的名字（纯文字换好名字，另给按名字切开的几段，页面桥画成名字标签）；名字标签的颜色按现在的
// 风格算好随那几句交过去；名字、语言、风格变了重交，开着的气泡跟着变。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NativeBrowserEvent, NativePageControl, PageOutcome } from "../../src/app/native-browser.ts";
import { type BridgeLook, bridgeTexts, BUSY_KEY, bubbleView, nameTagColors, PageBubbleSync } from "../../src/plugins/browsing/page-bubble.ts";
import { type CommandTarget, PageCommands, type PagePanel } from "../../src/plugins/browsing/page-commands.ts";
import type { PageBubbleView } from "../../src/page-bridge/protocol.ts";
import { BRIDGE_ASSISTANT_KEYS, BRIDGE_DEFAULT_NAME, NAME_TAG_CLASSIC, type PageBridgeTexts } from "../../src/page-bridge/texts.ts";
import { activeLocaleFrom, type ButtonTurn, DEFAULT_ASSISTANT_NAME, DEFAULT_LANGUAGE, type PageField, setActiveLocale, t } from "../../src/state/index.ts";
import { BASE_STYLE, effectiveTokens, resolveColor, VISUAL_STYLES } from "../../src/visual-styles/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const PAGE = { title: "相册 · 上传", url: "https://album.example.cn/upload" };
const TITLE: PageField = { id: "f1", kind: "text", label: "标题" };
const PHOTOS: PageField = { id: "f2", kind: "file", label: "上传照片", accept: "image/*", multiple: true };
const textTarget: CommandTarget = { page: PAGE, fields: [TITLE, PHOTOS], field: TITLE };
const fileTarget: CommandTarget = { page: PAGE, fields: [TITLE, PHOTOS], field: PHOTOS };
/** 一条成了的回话（对标题框说的） */
const replyPanel = (text: string): PagePanel => ({ kind: "reply", target: textTarget, text, failed: false });

describe("面板 → 气泡的样子", () => {
  test("收起、打字（对哪个框说，上传框的提示不一样）、在听带音量、在办带打的字和那一句状态", () => {
    expect(bubbleView({ kind: "idle" })).toEqual({ kind: "none" });
    expect(bubbleView({ kind: "bar", target: textTarget })).toEqual({ kind: "input", fieldId: "f1", label: "对「标题」说", placeholder: "比如：标题写成周末杭州游记" });
    expect(bubbleView({ kind: "bar", target: fileTarget })).toMatchObject({ kind: "input", fieldId: "f2", label: "对「上传照片」说", placeholder: "比如：把我周末在杭州拍的照片贴上来" });
    expect(bubbleView({ kind: "listening", target: textTarget, levels: [0.1, 0.5] })).toEqual({ kind: "listening", fieldId: "f1", label: "对「标题」说", levels: [0.1, 0.5] });
    expect(bubbleView({ kind: "busy", target: textTarget, said: "标题写成周末", note: "thinking" })).toEqual({ kind: "busy", fieldId: "f1", said: "标题写成周末", text: "二狗在想……", textParts: [{ name: "二狗" }, "在想……"] });
    expect(bubbleView({ kind: "busy", target: textTarget, note: "hearing" })).toEqual({ kind: "busy", fieldId: "f1", said: "", text: "在认你说了什么……" });
    // 秘书正忙（149 号票）：说明排在后面，不让用户以为没反应
    expect(bubbleView({ kind: "busy", target: fileTarget, said: "找几张", note: "queued" })).toEqual({
      kind: "busy",
      fieldId: "f2",
      said: "找几张",
      text: "二狗正忙，排在后面，这一轮说完就看",
      textParts: [{ name: "二狗" }, "正忙，排在后面，这一轮说完就看"],
    });
    expect(t(BUSY_KEY.queued)).toContain("排在后面");
  });

  test("回话：没办成的标出来；拦下的对话框上的指令给自己选，没认出哪个框时不跟着框", () => {
    expect(bubbleView({ kind: "reply", target: textTarget, text: "写好了", said: "标题写成周末", failed: false })).toEqual({
      kind: "reply",
      fieldId: "f1",
      said: "标题写成周末",
      text: "写好了",
      failed: false,
      system: false,
      more: false,
    });
    const chooserTarget: CommandTarget = { page: PAGE, fields: [], chooser: { accept: ["image/*"], multiple: true, capture: false, fieldId: "" } };
    expect(bubbleView({ kind: "reply", target: chooserTarget, text: "没找到", failed: true })).toEqual({ kind: "reply", fieldId: "", said: "", text: "没找到", failed: true, system: true, more: false });
    expect(bubbleView({ kind: "chooser", chooser: { accept: ["image/*"], multiple: true, capture: false, fieldId: "f2" } })).toEqual({ kind: "chooser", fieldId: "f2", text: "网页要你选图片（可以选好几个）" });
    expect(bubbleView({ kind: "chooser", chooser: { accept: [".pdf"], multiple: false, capture: false, fieldId: "" } })).toMatchObject({ text: "网页要你选文件" });
  });

  test("回话太长、有浏览侧边栏（147 号票）：给去侧边栏看；不长的、没有侧边栏的不给", () => {
    const long = "这一页讲的是报名须知，".repeat(13);
    expect(long.length).toBeGreaterThan(120);
    expect(bubbleView(replyPanel(long), true)).toMatchObject({ kind: "reply", more: true });
    expect(bubbleView(replyPanel(long), false)).toMatchObject({ kind: "reply", more: false });
    expect(bubbleView(replyPanel(long))).toMatchObject({ kind: "reply", more: false });
    expect(bubbleView(replyPanel("字".repeat(120)), true)).toMatchObject({ more: false });
    expect(bubbleView(replyPanel(["一", "二", "三", "四", "五", "六", "七"].join("\n")), true)).toMatchObject({ more: true });
    expect(bubbleView(replyPanel(["一", "二", "三", "四", "五", "六"].join("\n")), true)).toMatchObject({ more: false });
  });
});

class FakePage implements NativePageControl {
  views: PageBubbleView[] = [];
  /** 交给页面桥的它自己的那几句（169 号票） */
  sentTexts: PageBridgeTexts[] = [];
  draws = true;
  marks: string[] = [];
  choices: string[] = [];
  fields() {
    return Promise.resolve({ page: PAGE, fields: [TITLE, PHOTOS] });
  }
  fill(): Promise<PageOutcome> {
    return Promise.resolve({ ok: true });
  }
  mark(fieldId: string, mark: string): void {
    this.marks.push(`${fieldId}:${mark}`);
  }
  bubble(view: PageBubbleView): Promise<boolean> {
    this.views.push(view);
    return Promise.resolve(this.draws);
  }
  pick(): Promise<boolean> {
    return Promise.resolve(true);
  }
  texts(texts: PageBridgeTexts): void {
    this.sentTexts.push(texts);
  }
  putFile(): Promise<boolean> {
    return Promise.resolve(true);
  }
  deliver(): Promise<PageOutcome> {
    return Promise.resolve({ ok: true, count: 1 });
  }
  chooser(choice: "system" | "cancel"): Promise<PageOutcome> {
    this.choices.push(choice);
    return Promise.resolve({ ok: true });
  }
  selected(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  text(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  clearSelection(): Promise<PageOutcome> {
    return Promise.resolve({ ok: true });
  }
  snapshot(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  click(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  refField(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

let page: FakePage;
let commands: PageCommands;
let sync: PageBubbleSync;
let turn: ButtonTurn;

const silentVoice = { level: () => 0, prepare() {}, start: () => Promise.resolve(), stop: () => Promise.resolve({ ok: false as const, reason: "x" }), cancel() {}, release() {} };

function setup() {
  commands = new PageCommands({ page, recognize: () => Promise.resolve({ ok: true, text: "x" }), voice: silentVoice, browserPage: () => PAGE, browserId: () => "b-0123456789abcdef" });
  commands.connect({ say: () => "k1" });
  commands.secretaryChanged(() => turn);
  sync = new PageBubbleSync({ commands, page });
}

/** App 推过来一句：面板办，气泡那一层跟着 */
function push(event: NativeBrowserEvent) {
  commands.handle(event);
  sync.after(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  page = new FakePage();
  turn = { phase: "thinking" };
});

afterEach(() => {
  vi.useRealTimers();
});

const openOn = (field: PageField) => push({ type: "page", event: { type: "open", field, page: PAGE, fields: [TITLE, PHOTOS] } });

describe("交给页面桥", () => {
  test("开场先交一个收起；面板变了就交，一样的不重复交；点了按钮之后再交一遍", () => {
    setup();
    expect(page.views).toEqual([{ kind: "none" }]);
    openOn(TITLE);
    // 面板变成打字交一次，点了按钮之后照面板再交一遍（页面桥先自己画的打字框照这个改）
    expect(page.views.slice(1).map((v) => v.kind)).toEqual(["input", "input"]);
    commands.sendText("标题写成周末");
    turn = { phase: "replied", text: "写好了" };
    commands.secretaryChanged(() => turn);
    expect(page.views.slice(3).map((v) => v.kind)).toEqual(["busy", "reply"]);
    // 面板没变：不交
    const count = page.views.length;
    push({ type: "page", event: { type: "field", field: TITLE } });
    expect(page.views).toHaveLength(count);
    // 气泡上点了收起：交 none，再交一遍现在的样子
    push({ type: "page", event: { type: "bubble", action: "close" } });
    expect(page.views.slice(count).map((v) => v.kind)).toEqual(["none", "none"]);
  });

  test("面板没接（二狗还在办）：照面板的样子改回来", () => {
    setup();
    openOn(TITLE);
    commands.sendText("标题写成周末");
    // 页面桥上又长按了（它先自己画了在听），面板在等回话不接：再交一遍"在想"
    const count = page.views.length;
    push({ type: "page", event: { type: "voice", phase: "start", field: TITLE, page: PAGE, fields: [TITLE] } });
    expect(page.views.slice(count)).toEqual([{ kind: "busy", fieldId: "f1", said: "标题写成周末", text: "二狗在想……", textParts: [{ name: "二狗" }, "在想……"] }]);
  });

  test("拦下的选文件对话框画不出来（页面桥不在）：交给系统的选择器；画得出来的照常等用户选", async () => {
    setup();
    page.draws = false;
    push({ type: "chooser", chooser: { accept: ["image/*"], multiple: false, capture: false, fieldId: "" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.choices).toEqual(["system"]);
    expect(commands.snapshot()).toEqual({ kind: "idle" });

    page.draws = true;
    push({ type: "chooser", chooser: { accept: ["image/*"], multiple: false, capture: false, fieldId: "" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.choices).toEqual(["system"]);
    expect(commands.snapshot()).toMatchObject({ kind: "chooser" });
  });

  test("让二狗选：不马上再交（页面桥先画的打字框留着），框的列表回来面板变成打字时再交", async () => {
    setup();
    push({ type: "chooser", chooser: { accept: ["image/*"], multiple: false, capture: false, fieldId: "f2" } });
    const count = page.views.length;
    push({ type: "page", event: { type: "bubble", action: "ergo" } });
    expect(page.views).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.views.slice(count)).toEqual([{ kind: "input", fieldId: "f2", label: "对「上传照片」说", placeholder: "比如：把我周末在杭州拍的照片贴上来" }]);
  });

  test("返回手势：收起后交 none", () => {
    setup();
    openOn(TITLE);
    push({ type: "bubble-close" });
    expect(page.views.at(-1)).toEqual({ kind: "none" });
    expect(commands.snapshot()).toEqual({ kind: "idle" });
  });
});

describe("169 号票：跟着当前语言", () => {
  afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

  test("气泡上的字是英文；悬浮按钮出来、选中的框变了时把页面桥自己的那几句交过去（按钮收起时不交）", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(bubbleView({ kind: "bar", target: textTarget })).toEqual({ kind: "input", fieldId: "f1", label: "Talk to “标题”", placeholder: "e.g. Make the title “A weekend in Hangzhou”" });
    expect(bubbleView({ kind: "busy", target: textTarget, said: "", note: "thinking" })).toMatchObject({ text: "二狗 is thinking…" });
    expect(bubbleView({ kind: "chooser", chooser: { accept: ["image/*"], multiple: true, capture: false, fieldId: "" } })).toMatchObject({ text: "This page wants images (you can pick several)" });
    setup();
    sync.after({ type: "page", event: { type: "field", field: TITLE } });
    sync.after({ type: "page", event: { type: "field", field: null } });
    sync.after({ type: "page", event: { type: "selected", field: null, page: PAGE } });
    expect(page.sentTexts).toHaveLength(2);
    expect(page.sentTexts[0]).toMatchObject({ "bridge.fab.label": "Ask 二狗: tap to type, hold to talk", "bridge.bubble.thinking": "二狗 is thinking…" });
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    sync.after({ type: "page", event: { type: "field", field: TITLE } });
    expect(page.sentTexts[2]).toMatchObject({ "bridge.fab.label": "让二狗帮忙：点一下打字，按住说话" });
  });
});

describe("181 号票：助理的名字和名字标签", () => {
  afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

  const COLORS = nameTagColors("night");
  /** 名字里有 HTML、花括号也只是字 */
  const ODD = "<b>小美</b>{count}";

  test("在办的那一句用起的名字：纯文字换好名字，另给按名字切开的几段；没说到名字的那句不给几段", () => {
    expect(bubbleView({ kind: "busy", target: textTarget, said: "", note: "thinking" }, false, "小美")).toEqual({ kind: "busy", fieldId: "f1", said: "", text: "小美在想……", textParts: [{ name: "小美" }, "在想……"] });
    expect(bubbleView({ kind: "busy", target: textTarget, said: "", note: "queued" }, false, ODD)).toMatchObject({ text: `${ODD}正忙，排在后面，这一轮说完就看`, textParts: [{ name: ODD }, "正忙，排在后面，这一轮说完就看"] });
    expect(bubbleView({ kind: "busy", target: textTarget, said: "", note: "hearing" }, false, "小美")).toEqual({ kind: "busy", fieldId: "f1", said: "", text: "在认你说了什么……" });
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(bubbleView({ kind: "busy", target: textTarget, said: "", note: "thinking" }, false, "Jo")).toMatchObject({ text: "Jo is thinking…", textParts: [{ name: "Jo" }, " is thinking…"] });
  });

  test("交给页面桥的那几句：说到助理的换好名字（不认名字标签的旧页面桥照样显示名字），原样（带 {name}）、名字、颜色另放在 assistant 里；框的名字那句不动", () => {
    const texts = bridgeTexts({ name: "小美", tag: COLORS });
    expect(texts).toMatchObject({
      "bridge.fab.label": "让小美帮忙：点一下打字，按住说话",
      "bridge.talkTo.ergo": "对小美说",
      "bridge.bubble.title": "小美",
      "bridge.bubble.thinking": "小美在想……",
      "bridge.bubble.letErgoPick": "让小美选",
      "bridge.pick.title": "小美给的候选",
      "bridge.talkTo.named": "对「{name}」说",
      "bridge.bubble.send": "发送",
    });
    expect(texts.assistant).toEqual({
      name: "小美",
      tag: COLORS,
      templates: {
        "bridge.fab.label": "让{name}帮忙：点一下打字，按住说话",
        "bridge.talkTo.ergo": "对{name}说",
        "bridge.bubble.title": "{name}",
        "bridge.bubble.thinking": "{name}在想……",
        "bridge.bubble.letErgoPick": "让{name}选",
        "bridge.pick.title": "{name}给的候选",
      },
    });
    // 说到助理的那几句：两种语言都写的是 {name}（不再写死"二狗"、Ergo）
    for (const key of BRIDGE_ASSISTANT_KEYS) expect(t(key)).toContain("{name}");
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    for (const key of BRIDGE_ASSISTANT_KEYS) expect(t(key)).toContain("{name}");
    expect(bridgeTexts({ name: "Jo" })).toMatchObject({ "bridge.bubble.letErgoPick": "Let Jo pick", assistant: { name: "Jo", templates: { "bridge.bubble.letErgoPick": "Let {name} pick" } } });
    // 没给：默认的名字，不带颜色（页面桥用经典的）
    expect(bridgeTexts().assistant).toMatchObject({ name: DEFAULT_ASSISTANT_NAME });
    expect(bridgeTexts().assistant?.tag).toBeUndefined();
  });

  test("名字标签的颜色：照风格清单算出浅色、深色两对（#rrggbb）；经典的就是 43 号票定的；不认识的风格按经典；主色不认识的按默认", () => {
    expect(nameTagColors("classic")).toEqual({ light: { bg: "#fbe3a1", fg: "#5c3d00" }, dark: { bg: "#4a3c14", fg: "#f7d57e" } });
    expect(nameTagColors("nope")).toEqual(nameTagColors("classic"));
    for (const style of VISUAL_STYLES) {
      const tokens = effectiveTokens(style, BASE_STYLE);
      expect(nameTagColors(style.id)).toEqual({
        light: { bg: resolveColor(tokens, "name-bg", "light"), fg: resolveColor(tokens, "name-fg", "light") },
        dark: { bg: resolveColor(tokens, "name-bg", "dark"), fg: resolveColor(tokens, "name-fg", "dark") },
      });
    }
    expect(nameTagColors("night")).not.toEqual(nameTagColors("classic"));
    expect(nameTagColors("classic", "nope")).toEqual(nameTagColors("classic"));
    // 页面桥没交来时用的（打包在页面桥里，不引风格清单）和经典的、默认的名字一样
    expect(NAME_TAG_CLASSIC).toEqual(nameTagColors("classic"));
    expect(BRIDGE_DEFAULT_NAME).toBe(DEFAULT_ASSISTANT_NAME);
  });

  test("名字、风格、语言变了：页面桥装上过才重交那几句（一样的不交）；开着的气泡照新的名字、语言再交", () => {
    let look: BridgeLook = { name: "二狗" };
    commands = new PageCommands({ page, recognize: () => Promise.resolve({ ok: true, text: "x" }), voice: silentVoice, browserPage: () => PAGE, browserId: () => "b-0123456789abcdef" });
    commands.connect({ say: () => "k1" });
    commands.secretaryChanged(() => turn);
    sync = new PageBubbleSync({ commands, page, look: () => look });
    // 页面桥还没报过什么：不交
    look = { name: "小美" };
    sync.lookChanged();
    expect(page.sentTexts).toHaveLength(0);
    push({ type: "page", event: { type: "selected", field: null, page: PAGE } });
    expect(page.sentTexts.at(-1)).toMatchObject({ "bridge.bubble.title": "小美", assistant: { name: "小美" } });
    // 气泡开着、在想
    openOn(TITLE);
    push({ type: "page", event: { type: "bubble", action: "send", text: "标题写成周末" } });
    expect(page.views.at(-1)).toMatchObject({ kind: "busy", text: "小美在想……" });
    const sent = page.sentTexts.length;
    // 一样的不交
    sync.lookChanged();
    expect(page.sentTexts).toHaveLength(sent);
    // 改名字：那几句重交，气泡跟着
    look = { name: "阿福" };
    sync.lookChanged();
    expect(page.sentTexts).toHaveLength(sent + 1);
    expect(page.sentTexts.at(-1)).toMatchObject({ "bridge.bubble.letErgoPick": "让阿福选", assistant: { name: "阿福" } });
    expect(page.views.at(-1)).toMatchObject({ kind: "busy", text: "阿福在想……", textParts: [{ name: "阿福" }, "在想……"] });
    // 换风格：颜色跟着重交（气泡的样子没变不重交）
    const views = page.views.length;
    look = { name: "阿福", tag: COLORS };
    sync.lookChanged();
    expect(page.sentTexts.at(-1)?.assistant?.tag).toEqual(COLORS);
    expect(page.views).toHaveLength(views);
    // 换语言
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    sync.lookChanged();
    expect(page.sentTexts.at(-1)).toMatchObject({ "bridge.bubble.letErgoPick": "Let 阿福 pick" });
    expect(page.views.at(-1)).toMatchObject({ kind: "busy", text: "阿福 is thinking…" });
  });
});

describe("212、214 号票：语音插件没启用", () => {
  test("交给页面桥的悬浮按钮说明只说点一下打字（原样、换好名字的都换），别的几句不动", () => {
    const texts = bridgeTexts({ name: "小美", typeOnly: true });
    expect(texts["bridge.fab.label"]).toBe("让小美帮忙：点一下打字");
    expect(texts.assistant?.templates?.["bridge.fab.label"]).toBe("让{name}帮忙：点一下打字");
    expect(texts["bridge.talkTo.ergo"]).toBe("对小美说");
    expect(bridgeTexts({ name: "小美" })["bridge.fab.label"]).toBe("让小美帮忙：点一下打字，按住说话");
  });
});
