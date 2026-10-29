// 网页上下指令在二狗网页这一侧（134 号票第二部分，app/page-commands.ts）和原生桥上页面桥那一组的包装（app/native-browser.ts）：
// App、录音、识别、store 都换成假的。149 号票起悬浮按钮背后就是秘书本人。查：
// - 点悬浮按钮开输入条，打字发送：作为一条消息发进秘书的主会话（网页上下文：哪个浏览器、网页、按钮所在的框连同框里这一刻的内容、
//   从悬浮按钮发的）；秘书在办"二狗在想"，正忙"排在后面"，说完了回话显示、过一会儿收起；没发出去写原因；
// - 长按：悬浮按钮出来就备好录音器，按够了开始、松手先送识别，认出来的字先显示、再发（标着是说的）；整段静音、没认出不发；划走取消；
//   录着的时候每 80 毫秒取一次音量（146 号票的波形）；按下那一刻起算开始语音输入（209 号票：二狗正在播的语音暂停），
//   松手、取消、收起、录不了、短按打字都算说完；
// - 收起：等二狗回话时也能收起（不再等，按钮回到平常）；返回手势、浏览器开始加载别的网页时收起；
// - 拦下的选文件对话框：让二狗选（问页面桥要框的列表）、这一轮的目标是这个对话框；发出去之后收起不取消对话框（秘书还要交给它），
//   发之前收起告诉 App 取消；自己选交给系统的选择器；
// - 原生桥：页面桥报的话按形状核对（发送带着的框、框里的内容，挑图片窗口上点的），形状不对的不认；文件分段交、App 回的不对当失败；
//   挑图片窗口画成什么样（pick）、放掉预备的文件（discard，新版 App 才有）、返回手势收起窗口（pick-close）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type NativePageControl, type PageOutcome, type StagedFile, wrapNativeBrowser } from "../../src/app/native-browser.ts";
import { LEVEL_MS, PRESS_CAPTURE_MS, type PageTake, type PageVoice, PageCommands, REPLY_HIDE_MS } from "../../src/plugins/browsing/page-commands.ts";
import type { PageBridgeEvent, PageBubbleAction } from "../../src/page-bridge/protocol.ts";
import type { BrowsingContext, ButtonTurn, PageField, PageVoiceResult } from "../../src/state/index.ts";

const PAGE = { title: "相册 · 上传", url: "https://album.example.cn/upload" };
const TITLE: PageField = { id: "f1", kind: "text", label: "标题" };
const PHOTOS: PageField = { id: "f2", kind: "file", label: "上传照片", accept: "image/*", multiple: true };
const AVATAR: PageField = { id: "f3", kind: "file", label: "上传你的照片", accept: "image/*" };
const FIELDS = [TITLE, PHOTOS, AVATAR];
const BROWSER = "b-0123456789abcdef";

/** 假的页面桥（经 App） */
class FakePage implements NativePageControl {
  filled: Array<[string, string]> = [];
  marks: string[] = [];
  delivered: Array<{ target: unknown; files: readonly StagedFile[] }> = [];
  choices: string[] = [];
  fields(): Promise<{ page: typeof PAGE; fields: PageField[] }> {
    return Promise.resolve({ page: PAGE, fields: FIELDS });
  }
  fill(fieldId: string, text: string): Promise<PageOutcome> {
    this.filled.push([fieldId, text]);
    return Promise.resolve({ ok: true });
  }
  mark(fieldId: string, mark: string): void {
    this.marks.push(`${fieldId}:${mark}`);
  }
  bubble(): Promise<boolean> {
    return Promise.resolve(true);
  }
  pick(): Promise<boolean> {
    return Promise.resolve(true);
  }
  putFile(): Promise<boolean> {
    return Promise.resolve(true);
  }
  deliver(target: { fieldId: string } | "chooser", files: readonly StagedFile[]): Promise<PageOutcome> {
    this.delivered.push({ target, files });
    return Promise.resolve({ ok: true, count: files.length });
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

/** 假的录音器 */
class FakeVoice implements PageVoice {
  log: string[] = [];
  take: PageTake = { ok: true, base64: "UklGRg==", mime: "audio/wav" };
  volume = 0;
  level(): number {
    return this.volume;
  }
  prepare(userAction: boolean): void {
    this.log.push(userAction ? "prepare:press" : "prepare");
  }
  start(): Promise<void> {
    this.log.push("start");
    return Promise.resolve();
  }
  stop(): Promise<PageTake> {
    this.log.push("stop");
    return Promise.resolve(this.take);
  }
  cancel(): void {
    this.log.push("cancel");
  }
  release(): void {
    this.log.push("release");
  }
}

let page: FakePage;
let voice: FakeVoice;
let said: Array<{ text: string; browsing: BrowsingContext }>;
let heard: Array<{ base64: string; mime: string }>;
let recognized: PageVoiceResult;
/** 识别慢一点：给了就等它 */
let recognizing: Promise<PageVoiceResult> | undefined;
let browserId: string | undefined;
/** 交给播放器的"开始 / 说完语音输入"（209 号票），按先后 */
let captures: boolean[];
/** 假的秘书会话：每句话（幂等键）走到哪了 */
let turns: Map<string, ButtonTurn>;
let commands: PageCommands;

beforeEach(() => {
  vi.useFakeTimers();
  page = new FakePage();
  voice = new FakeVoice();
  said = [];
  heard = [];
  recognized = { ok: true, text: "标题写成周末杭州游记" };
  recognizing = undefined;
  browserId = BROWSER;
  captures = [];
  turns = new Map();
  commands = new PageCommands({
    page,
    recognize: (audio) => {
      heard.push(audio);
      return recognizing ?? Promise.resolve(recognized);
    },
    voice,
    browserPage: () => ({ title: "浏览器里的标题", url: "https://x.example/a?q=1" }),
    browserId: () => browserId,
    capture: (on) => captures.push(on),
  });
  commands.connect({
    say(text, browsing) {
      said.push({ text, browsing });
      return `k${said.length}`;
    },
  });
  commands.secretaryChanged((key) => turns.get(key) ?? { phase: "sending" });
});

afterEach(() => {
  vi.useRealTimers();
});

const pageEvent = (event: PageBridgeEvent) => commands.handle({ type: "page", event });
const bubbleEvent = (action: PageBubbleAction) => pageEvent({ type: "bubble", ...action });
const open = (field: PageField) => pageEvent({ type: "open", field, page: PAGE, fields: FIELDS });
const voiceEvent = (phase: "press" | "start" | "stop" | "cancel", field: PageField = TITLE) => pageEvent({ type: "voice", phase, field, page: PAGE, fields: FIELDS });
/** 秘书会话变了：这一句（第几句发的）走到了哪 */
const turn = (n: number, t: ButtonTurn) => {
  turns.set(`k${n}`, t);
  commands.secretaryChanged((key) => turns.get(key) ?? { phase: "sending" });
};

describe("悬浮按钮上打字：发进秘书的主会话", () => {
  test("发的是带网页上下文的消息（按钮所在的框连同框里这一刻的内容、从悬浮按钮发的）；在办写二狗在想，说完了回话显示、过一会儿收起", async () => {
    open(TITLE);
    expect(commands.snapshot()).toMatchObject({ kind: "bar", target: { field: TITLE } });
    // 页面桥报的发送带着按钮所在的框和框里这一刻的内容
    const typed: PageField = { ...TITLE, value: { text: "原来的标题", total: 5 } };
    bubbleEvent({ action: "send", text: "  标题写成周末杭州游记 ", field: typed });
    expect(said).toEqual([{ text: "标题写成周末杭州游记", browsing: { browser: BROWSER, page: PAGE, selected: typed, via: "button" } }]);
    expect(commands.snapshot()).toMatchObject({ kind: "busy", said: "标题写成周末杭州游记", note: "thinking" });
    expect(page.marks).toEqual(["f1:busy"]);
    turn(1, { phase: "thinking" });
    expect(commands.snapshot()).toMatchObject({ kind: "busy", note: "thinking" });
    turn(1, { phase: "replied", text: "标题写好了" });
    expect(commands.snapshot()).toMatchObject({ kind: "reply", text: "标题写好了", failed: false, said: "标题写成周末杭州游记" });
    expect(page.marks).toEqual(["f1:busy", "f1:idle"]);
    // 填字是秘书用网页工具办的（浏览侧边栏那一份转给页面桥），这里不填
    expect(page.filled).toEqual([]);
    await vi.advanceTimersByTimeAsync(REPLY_HIDE_MS);
    expect(commands.snapshot()).toEqual({ kind: "idle" });
  });

  test("秘书正忙：排在队里写排在后面，交出去以后照常；没发出去写原因、不收；空的不发", async () => {
    open(PHOTOS);
    commands.sendText("   ");
    expect(said).toEqual([]);
    commands.sendText("找几张杭州的照片");
    turn(1, { phase: "queued" });
    expect(commands.snapshot()).toMatchObject({ kind: "busy", note: "queued" });
    turn(1, { phase: "thinking" });
    expect(commands.snapshot()).toMatchObject({ kind: "busy", note: "thinking" });
    turn(1, { phase: "replied", text: "挑了 4 张，你在下面选一张" });
    expect(commands.snapshot()).toMatchObject({ kind: "reply", text: "挑了 4 张，你在下面选一张" });

    open(TITLE);
    commands.sendText("随便写点");
    turn(2, { phase: "failed", reason: "二狗这一轮出错了：模型没回" });
    expect(commands.snapshot()).toMatchObject({ kind: "reply", text: "二狗这一轮出错了：模型没回", failed: true });
    await vi.advanceTimersByTimeAsync(REPLY_HIDE_MS * 2);
    expect(commands.snapshot()).toMatchObject({ kind: "reply", failed: true });
  });

  test("没有浏览侧边栏（旧版 App）、还没接上 store：写原因，不发", () => {
    browserId = undefined;
    open(TITLE);
    commands.sendText("写个标题");
    expect(said).toEqual([]);
    expect(commands.snapshot()).toMatchObject({ kind: "reply", failed: true, text: expect.stringContaining("新版的二狗 App") });

    browserId = BROWSER;
    const loose = new PageCommands({ page, recognize: () => Promise.resolve(recognized), voice, browserPage: () => PAGE, browserId: () => BROWSER });
    loose.handle({ type: "page", event: { type: "open", field: TITLE, page: PAGE, fields: FIELDS } });
    loose.sendText("写个标题");
    expect(loose.snapshot()).toMatchObject({ kind: "reply", failed: true, text: expect.stringContaining("还没连上") });
  });

  test("等二狗回话时也能收起：马上收、按钮回到平常；之后的回话不再显示（这句照样在秘书的会话里办完）", () => {
    open(TITLE);
    commands.sendText("标题写成周末杭州游记");
    bubbleEvent({ action: "close" });
    expect(commands.snapshot()).toEqual({ kind: "idle" });
    expect(page.marks).toEqual(["f1:busy", "f1:idle"]);
    turn(1, { phase: "replied", text: "标题写好了" });
    expect(commands.snapshot()).toEqual({ kind: "idle" });
  });
});

describe("长按说话", () => {
  test("悬浮按钮出来就备好录音器；按够了开始、松手先送识别，认出来的字先显示，再发进秘书的会话（标着是说的，框里的内容是松手那一刻的）", async () => {
    pageEvent({ type: "field", field: TITLE });
    voiceEvent("press");
    voiceEvent("start");
    expect(commands.snapshot()).toMatchObject({ kind: "listening" });
    let answer: ((r: PageVoiceResult) => void) | undefined;
    recognizing = new Promise((resolve) => (answer = resolve));
    const atRelease: PageField = { ...TITLE, value: { text: "", total: 0 } };
    voiceEvent("stop", atRelease);
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.log).toEqual(["prepare", "prepare:press", "start", "stop"]);
    expect(commands.snapshot()).toMatchObject({ kind: "busy", note: "hearing" });
    expect(heard).toEqual([{ base64: "UklGRg==", mime: "audio/wav" }]);
    answer!({ ok: true, text: "标题写成周末杭州游记" });
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.snapshot()).toMatchObject({ kind: "busy", note: "thinking", said: "标题写成周末杭州游记" });
    expect(said).toEqual([{ text: "标题写成周末杭州游记", browsing: { browser: BROWSER, page: PAGE, selected: atRelease, via: "button", spoken: true } }]);
    turn(1, { phase: "replied", text: "标题写好了" });
    expect(commands.snapshot()).toMatchObject({ kind: "reply", said: "标题写成周末杭州游记", text: "标题写好了" });

    pageEvent({ type: "field", field: null });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(voice.log.at(-1)).toBe("release");
  });

  test("整段静音、没认出：不发，写原因；划走取消", async () => {
    voice.take = { ok: false, reason: "没听到声音，再按住说一次" };
    voiceEvent("start");
    voiceEvent("stop");
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual([]);
    expect(commands.snapshot()).toMatchObject({ kind: "reply", text: "没听到声音，再按住说一次", failed: true });

    voice.take = { ok: true, base64: "UklGRg==", mime: "audio/wav" };
    recognized = { ok: false, reason: "没听清，再说一次？" };
    voiceEvent("start");
    voiceEvent("stop");
    await vi.advanceTimersByTimeAsync(0);
    expect(said).toEqual([]);
    expect(commands.snapshot()).toMatchObject({ kind: "reply", text: "没听清，再说一次？", failed: true });

    voiceEvent("start");
    voiceEvent("cancel");
    expect(voice.log.at(-1)).toBe("cancel");
    expect(commands.snapshot()).toEqual({ kind: "idle" });
  });

  test("录着的时候每 80 毫秒取一次音量，留最近的；松手就不再取；录满 60 秒自己发", async () => {
    voiceEvent("press");
    voiceEvent("start");
    voice.volume = 0.3;
    await vi.advanceTimersByTimeAsync(LEVEL_MS);
    voice.volume = 0.8;
    await vi.advanceTimersByTimeAsync(LEVEL_MS);
    expect(commands.snapshot()).toMatchObject({ kind: "listening", levels: [0.3, 0.8] });
    await vi.advanceTimersByTimeAsync(LEVEL_MS * 60);
    const listening = commands.snapshot();
    expect(listening.kind === "listening" && listening.levels.length).toBe(40);
    voiceEvent("stop");
    await vi.advanceTimersByTimeAsync(0);
    const after = commands.snapshot();
    await vi.advanceTimersByTimeAsync(LEVEL_MS * 3);
    expect(commands.snapshot()).toBe(after);

    // 等回话时再按不接；回话来了以后再按
    turn(1, { phase: "replied", text: "好" });
    voiceEvent("start");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heard).toHaveLength(2);
  });
});

describe("语音插件没启用（212、214 号票）：悬浮按钮只能打字", () => {
  test("不备录音器、按下不算开始语音输入；按够了不录，气泡里写\"语音插件没启用：点一下按钮打字\"，按钮回到平常；松手也回到平常、不送识别、不发", async () => {
    commands.setVoice(false);
    pageEvent({ type: "field", field: TITLE });
    voiceEvent("press");
    voiceEvent("start");
    expect(commands.snapshot()).toMatchObject({ kind: "reply", failed: true, text: "语音插件没启用：点一下按钮打字" });
    voiceEvent("stop");
    await vi.advanceTimersByTimeAsync(5_000);
    // 停用那一下放掉录音器（备过的话），之后不再备、不录
    expect(voice.log).toEqual(["release"]);
    expect(captures).toEqual([]);
    expect(heard).toEqual([]);
    expect(said).toEqual([]);
    // 页面桥按够了自己换成"在听"、松手自己换成"在办"：网页每次都改回平常
    expect(page.marks).toEqual(["f1:idle", "f1:idle"]);
    // 点一下照常打字、发出去
    open(TITLE);
    expect(commands.snapshot()).toMatchObject({ kind: "bar" });
    bubbleEvent({ action: "send", text: "标题写成周末杭州游记", field: TITLE });
    expect(said.map((s) => s.text)).toEqual(["标题写成周末杭州游记"]);
  });

  test("录着的时候语音插件停用：马上取消、放掉录音器；再启用回来照常能说", async () => {
    pageEvent({ type: "field", field: TITLE });
    voiceEvent("press");
    voiceEvent("start");
    expect(commands.snapshot()).toMatchObject({ kind: "listening" });
    commands.setVoice(false);
    expect(commands.snapshot()).toMatchObject({ kind: "idle" });
    expect(voice.log).toEqual(["prepare", "prepare:press", "start", "cancel", "release"]);
    expect(captures.at(-1)).toBe(false);
    commands.setVoice(true);
    voiceEvent("press");
    voiceEvent("start");
    expect(commands.snapshot()).toMatchObject({ kind: "listening" });
  });
});

describe("长按说话时二狗正在播的语音暂停（209 号票）", () => {
  test("按下那一刻就算开始（不等录音器）；按够了开始录不再报；松手说完", async () => {
    voiceEvent("press");
    expect(captures).toEqual([true]);
    voiceEvent("start");
    expect(captures).toEqual([true]);
    voiceEvent("stop");
    await vi.advanceTimersByTimeAsync(0);
    expect(captures).toEqual([true, false]);
  });

  test("取消（划走、上滑）、收起、浏览器开始开别的网页、录不了：都算说完", async () => {
    voiceEvent("press");
    voiceEvent("start");
    voiceEvent("cancel");
    expect(captures).toEqual([true, false]);

    voiceEvent("press");
    voiceEvent("start");
    commands.dismiss();
    expect(captures).toEqual([true, false, true, false]);

    voiceEvent("start");
    commands.handle({ type: "state", state: { url: "https://b.example/", title: "", progress: 10, loading: true, canGoBack: false, canGoForward: false } });
    expect(captures).toEqual([true, false, true, false, true, false]);

    voice.start = () => Promise.reject(new Error("麦克风被别的应用占着"));
    voiceEvent("press");
    voiceEvent("start");
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.snapshot()).toMatchObject({ kind: "reply", failed: true });
    expect(captures).toEqual([true, false, true, false, true, false, true, false]);
  });

  test("短按（松手开打字框）也算说完；按下了却没开始录、也没开打字框（手势被系统收走）的过一会儿自己放开", async () => {
    voiceEvent("press");
    open(TITLE);
    expect(captures).toEqual([true, false]);
    commands.dismiss();

    voiceEvent("press");
    await vi.advanceTimersByTimeAsync(PRESS_CAPTURE_MS - 1);
    expect(captures).toEqual([true, false, true]);
    await vi.advanceTimersByTimeAsync(1);
    expect(captures).toEqual([true, false, true, false]);
  });

  test("在等二狗回话（按钮在办）时按、录：不接，也不动播放", async () => {
    voiceEvent("press");
    voiceEvent("start");
    voiceEvent("stop");
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.snapshot()).toMatchObject({ kind: "busy" });
    voiceEvent("press");
    voiceEvent("start");
    expect(captures).toEqual([true, false]);
  });
});

describe("拦下的选文件对话框", () => {
  test("让二狗选：问页面桥要框的列表，这一轮的目标是这个对话框（认出的框也带上）；发出去之后收起不取消对话框", async () => {
    commands.handle({ type: "chooser", chooser: { accept: ["image/*"], multiple: false, capture: false, fieldId: "f3" } });
    bubbleEvent({ action: "ergo" });
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.snapshot()).toMatchObject({ kind: "bar", target: { field: AVATAR } });
    bubbleEvent({ action: "send", text: "找一张头像" });
    expect(said[0]?.browsing).toEqual({ browser: BROWSER, page: PAGE, selected: AVATAR, via: "button", chooser: { accept: ["image/*"], multiple: false } });
    bubbleEvent({ action: "close" });
    expect(page.choices).toEqual([]);
  });

  test("没认出是哪个框：页面信息用浏览器的；发之前收起告诉 App 取消；自己选交给系统的选择器；回话下面的自己选也行", async () => {
    page.fields = () => Promise.resolve(undefined as never);
    commands.handle({ type: "chooser", chooser: { accept: [], multiple: true, capture: false, fieldId: "" } });
    bubbleEvent({ action: "ergo" });
    await vi.advanceTimersByTimeAsync(0);
    bubbleEvent({ action: "close" });
    expect(page.choices).toEqual(["cancel"]);

    commands.handle({ type: "chooser", chooser: { accept: [], multiple: true, capture: false, fieldId: "" } });
    bubbleEvent({ action: "ergo" });
    await vi.advanceTimersByTimeAsync(0);
    commands.sendText("把发票都传上去");
    expect(said[0]?.browsing).toEqual({ browser: BROWSER, page: { title: "浏览器里的标题", url: "https://x.example/a" }, via: "button", chooser: { accept: [], multiple: true } });
    turn(1, { phase: "replied", text: "交了 3 个" });
    // 拦下的对话框上的回话不自己收（下面有"自己选"）
    await vi.advanceTimersByTimeAsync(REPLY_HIDE_MS);
    expect(commands.snapshot()).toMatchObject({ kind: "reply", text: "交了 3 个" });
    bubbleEvent({ action: "system" });
    expect(page.choices).toEqual(["cancel", "system"]);
    expect(commands.snapshot()).toEqual({ kind: "idle" });
  });
});

describe("收起", () => {
  test("返回手势收起；浏览器开始加载别的网页：开着的收起，加载中的进度变化不算", () => {
    open(TITLE);
    commands.handle({ type: "bubble-close" });
    expect(commands.snapshot()).toEqual({ kind: "idle" });

    const state = (loading: boolean) => commands.handle({ type: "state", state: { url: "https://a.example/", title: "", progress: 10, loading, canGoBack: false, canGoForward: false } });
    state(false);
    open(TITLE);
    state(false);
    expect(commands.snapshot()).toMatchObject({ kind: "bar" });
    state(true);
    expect(commands.snapshot()).toEqual({ kind: "idle" });
    state(true);
    open(TITLE);
    state(true);
    expect(commands.snapshot()).toMatchObject({ kind: "bar" });
  });

  test("回话太长去侧边栏看（147 号票）：气泡收起（侧边栏由浏览侧边栏打开）", () => {
    open(TITLE);
    commands.sendText("讲讲这页");
    turn(1, { phase: "replied", text: "很长".repeat(100) });
    bubbleEvent({ action: "sidebar" });
    expect(commands.snapshot()).toEqual({ kind: "idle" });
  });
});

function bridge() {
  const calls: unknown[][] = [];
  const methods: Record<string, unknown> = {
    browserAttach: () => "{}",
    browserLayout: () => undefined,
    browserLoad: () => undefined,
    browserNav: () => undefined,
    browserPage: (op: string, args: string) => {
      calls.push(["page", op, args]);
      return Promise.resolve(op === "fields" ? JSON.stringify({ page: PAGE, fields: [...FIELDS, { id: "x", kind: "text", label: "坏的" }] }) : '{"ok":true}');
    },
    browserFileChunk: (id: string, b64: string) => {
      calls.push(["chunk", id, b64.length]);
      return Promise.resolve('{"ok":true,"count":1}');
    },
    browserFiles: (json: string) => {
      calls.push(["files", JSON.parse(json)]);
      return Promise.resolve("not json");
    },
    browserChooser: (choice: string) => {
      calls.push(["chooser", choice]);
      return Promise.resolve('{"ok":true,"count":0}');
    },
  };
  return { methods, calls };
}

describe("原生桥上页面桥那一组", () => {
  test("都在才有；列框、填字、分段交文件、交文件（App 回的不对当失败）；放掉预备的文件只在新版 App 上有", async () => {
    const { methods, calls } = bridge();
    const scope: { __ergoBrowser?: (json: string) => void } = {};
    const control = wrapNativeBrowser(methods, scope)?.page;
    expect(control).toBeDefined();
    // 编号不对的框不认
    expect(await control!.fields()).toEqual({ page: PAGE, fields: FIELDS });
    expect(await control!.fill("f1", "周末")).toEqual({ ok: true });
    expect(await control!.putFile("pf1", new Uint8Array(900 * 1024))).toBe(true);
    expect(calls.filter((c) => c[0] === "chunk")).toHaveLength(3);
    expect(await control!.deliver({ fieldId: "f2" }, [{ id: "pf1", name: "a.jpg", mime: "image/jpeg" }])).toMatchObject({ ok: false });
    expect(calls.find((c) => c[0] === "files")?.[1]).toEqual({ target: "field", fieldId: "f2", files: [{ id: "pf1", name: "a.jpg", mime: "image/jpeg" }] });
    expect(calls.find((c) => c[0] === "page" && c[1] === "fill")?.[2]).toBe(JSON.stringify(["f1", "周末"]));
    expect(control!.discard).toBeUndefined();

    const { browserChooser: _, ...older } = methods;
    expect(wrapNativeBrowser(older, {})?.page).toBeUndefined();

    const discarded: string[] = [];
    const newer = wrapNativeBrowser({ ...methods, browserDiscard: (json: string) => (discarded.push(json), Promise.resolve('{"ok":true}')) }, {})!.page!;
    newer.discard!(["pk1", "pk2"]);
    expect(discarded).toEqual([JSON.stringify(["pk1", "pk2"])]);
  });

  test("气泡、挑图片窗口（149 号票）：交给页面桥（没回 ok 是 false）；点的按形状核对，发送带的框和框里的内容；返回手势 bubble-close、pick-close", async () => {
    const { methods, calls } = bridge();
    const scope: { __ergoBrowser?: (json: string) => void } = {};
    const browser = wrapNativeBrowser(methods, scope)!;
    const view = { kind: "busy", fieldId: "f1", said: "标题写成周末", text: "二狗在想……" } as const;
    expect(await browser.page!.bubble(view)).toBe(true);
    expect(calls.find((c) => c[0] === "page" && c[1] === "bubble")?.[2]).toBe(JSON.stringify([JSON.stringify(view)]));
    const pickView = { kind: "none" } as const;
    expect(await browser.page!.pick(pickView)).toBe(true);
    expect(calls.find((c) => c[0] === "page" && c[1] === "pick")?.[2]).toBe(JSON.stringify([JSON.stringify(pickView)]));
    methods.browserPage = () => Promise.resolve("");
    expect(await browser.page!.bubble(view)).toBe(false);
    expect(await browser.page!.pick(pickView)).toBe(false);

    const seen: unknown[] = [];
    browser.subscribe((e) => seen.push(e));
    const report = (type: string, value: Record<string, unknown>) => scope.__ergoBrowser!(JSON.stringify({ type: "page", json: JSON.stringify({ nonce: "n", type, ...value }) }));
    report("bubble", { action: "send", text: "把照片贴上来", field: { ...TITLE, value: { text: "x".repeat(6000), total: 6000 } } });
    report("bubble", { action: "send", text: "   " });
    report("bubble", { action: "choose", token: "t1" });
    report("bubble", { action: "submit-form" });
    report("pick", { id: "c-1", action: "choose", token: "t1" });
    report("pick", { id: "c-1", action: "choose", token: "a".repeat(65) });
    report("pick", { id: "c-1", action: "deliver" });
    report("pick", { action: "dismiss" });
    report("pick", { id: "c-1", action: "submit" });
    report("selected", { field: { ...PHOTOS, value: { text: "不该有", total: 3 } }, page: PAGE });
    scope.__ergoBrowser!(JSON.stringify({ type: "bubble-close" }));
    scope.__ergoBrowser!(JSON.stringify({ type: "pick-close" }));
    expect(seen).toEqual([
      // 框里的内容截到 5000 字，写明一共多少
      { type: "page", event: { type: "bubble", action: "send", text: "把照片贴上来", field: { ...TITLE, value: { text: "x".repeat(5000), total: 6000 } } } },
      { type: "page", event: { type: "pick", id: "c-1", action: "choose", token: "t1" } },
      { type: "page", event: { type: "pick", id: "c-1", action: "deliver" } },
      // 上传框没有"框里的内容"
      { type: "page", event: { type: "selected", field: PHOTOS, page: PAGE } },
      { type: "bubble-close" },
      { type: "pick-close" },
    ]);
  });

  test("页面桥报的话按形状核对：形状不对的不认", () => {
    const { methods } = bridge();
    const scope: { __ergoBrowser?: (json: string) => void } = {};
    const browser = wrapNativeBrowser(methods, scope)!;
    const seen: unknown[] = [];
    browser.subscribe((e) => seen.push(e));
    const push = (value: unknown) => scope.__ergoBrowser!(JSON.stringify(value));
    push({ type: "page", json: JSON.stringify({ nonce: "n", type: "open", field: TITLE, page: PAGE, fields: FIELDS }) });
    push({ type: "page", json: JSON.stringify({ type: "open", field: { id: "1; drop", kind: "text", label: "" }, page: PAGE, fields: [] }) });
    push({ type: "page", json: JSON.stringify({ type: "open", field: TITLE, page: { title: "x", url: "javascript:alert(1)" }, fields: [] }) });
    push({ type: "page", json: JSON.stringify({ type: "voice", phase: "explode", field: TITLE, page: PAGE, fields: [] }) });
    push({ type: "page", json: JSON.stringify({ type: "field", field: null }) });
    push({ type: "chooser", accept: ["image/*", 3], multiple: true, fieldId: "f2" });
    expect(seen).toEqual([
      { type: "page", event: { type: "open", field: TITLE, page: PAGE, fields: FIELDS } },
      { type: "page", event: { type: "field", field: null } },
      { type: "chooser", chooser: { accept: ["image/*"], multiple: true, capture: false, fieldId: "f2" } },
    ]);
  });
});
