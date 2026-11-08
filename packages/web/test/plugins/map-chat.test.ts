// 地图页的二狗（444）在 Node 里能测的那一半：
// - 右下角二狗按钮背后的那一套（map-talk.ts）：点一下打字、发进秘书主会话带地图上下文（via: "button"）；在想、排在后面、回话、过一会儿收起；
//   按住说话：按下备录音器、算开始语音输入，按够了录、取音量，松手送识别、认出来的发（标着是说的）；上滑松手取消；语音插件停用时写一句；
//   没连上、发不出去写原因；收起时正在录的丢掉；离开地图页放掉录音器；
// - 记在这台设备上的（map-layout.ts）：聊天窗开合、左边那一栏收起 / 关掉、下面的抽屉拖低、聊天窗的宽度（和浏览侧边栏同一套规矩、各记各的键）；
//   存储用不了时按默认、照样生效；
// - 二狗按钮在哪（mapFabSpot，照页面桥 placeCornerButton）：离右边、底边 16，底下让开署名角标、手机上的抽屉；
// - 左边那一栏（FootprintPanel）：开着有收起、关掉，收起后是左上角一个小按钮、关掉什么都不画；手机上的卡是抽屉（有把手、拖低了标 low）；
//   宽的时候那一栏收着、关着，标题栏上的概况能点。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DeviceStorage } from "../../src/app/device-storage.ts";
import { chatSideWidthOf, clampChatSideWidth, dragChatSideWidth, stageSideWidthSettingIn } from "../../src/app/stage-side-width.ts";
import { LEVEL_MS, PRESS_CAPTURE_MS, type PageTake, type PageVoice, REPLY_HIDE_MS } from "../../src/app/talk-button.ts";
import { FootprintBar, FootprintPanel, type Footprints } from "../../src/plugins/map/DayFootprints.tsx";
import { footprintDay } from "../../src/plugins/map/footprints.ts";
import { MAP_FAB_ATTRIBUTION_ROOM, mapFabSpot } from "../../src/plugins/map/MapFab.tsx";
import { MAP_CHAT_WIDTH, mapLayoutIn } from "../../src/plugins/map/map-layout.ts";
import { MapTalk } from "../../src/plugins/map/map-talk.ts";
import { demoMapDay } from "../../src/prototype/fake-footprints.ts";
import { type ButtonTurn, localDate, type MapContext, type PageVoiceResult, shiftMapDate } from "../../src/state/index.ts";

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

const VIEW = { lat: 30.2596, lon: 120.1434, zoom: 14, basemap: "amap", footprints: { date: "2026-11-07" } };

describe("右下角的二狗按钮背后那一套", () => {
  let voice: FakeVoice;
  let talk: MapTalk;
  let said: Array<{ text: string; map: MapContext }>;
  let heard: PageVoiceResult;
  let captures: boolean[];
  const turns = new Map<string, ButtonTurn>();
  const turn = (n: number, t: ButtonTurn) => {
    turns.set(`k${n}`, t);
    talk.secretaryChanged((key) => turns.get(key) ?? { phase: "sending" });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    voice = new FakeVoice();
    said = [];
    captures = [];
    turns.clear();
    heard = { ok: true, text: "西湖边有什么好吃的" };
    talk = new MapTalk({ voice, recognize: () => Promise.resolve(heard), context: () => VIEW, capture: (on) => captures.push(on) });
    talk.connect({
      say: (text, map) => {
        said.push({ text, map });
        return `k${said.length}`;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("点一下打字：发进秘书主会话，带这一刻的地图上下文（从按钮发的）；在想、排在后面、回话，过一会儿收起", () => {
    talk.open();
    expect(talk.snapshot()).toEqual({ kind: "bar" });
    talk.sendText("  这附近有什么好吃的 ");
    expect(said).toEqual([{ text: "这附近有什么好吃的", map: { ...VIEW, via: "button" } }]);
    expect(talk.snapshot()).toEqual({ kind: "busy", said: "这附近有什么好吃的", note: "thinking" });
    expect(talk.busy).toBe(true);
    // 在办的时候再点不接
    talk.open();
    expect(talk.snapshot().kind).toBe("busy");
    turn(1, { phase: "queued" });
    expect(talk.snapshot()).toMatchObject({ kind: "busy", note: "queued" });
    turn(1, { phase: "replied", text: "北山街有几家，楼外楼最近。" });
    expect(talk.snapshot()).toEqual({ kind: "reply", text: "北山街有几家，楼外楼最近。", failed: false, said: "这附近有什么好吃的" });
    vi.advanceTimersByTime(REPLY_HIDE_MS);
    expect(talk.snapshot()).toEqual({ kind: "idle" });
  });

  test("没发出去写原因；空的不发；没连上写一句", () => {
    talk.open();
    talk.sendText("   ");
    expect(said).toEqual([]);
    talk.sendText("画一下昨天");
    turn(1, { phase: "failed", reason: "二狗没连上" });
    expect(talk.snapshot()).toMatchObject({ kind: "reply", failed: true, text: "二狗没连上" });
    talk.connect(undefined);
    talk.open();
    talk.sendText("在吗");
    expect(talk.snapshot()).toMatchObject({ kind: "reply", failed: true, text: "二狗还没连上，等一下再试", said: "在吗" });
  });

  test("按住说话：按下备好录音器、算开始语音输入，按够了录、取音量；松手送识别，认出来的字发进秘书主会话（标着是说的）", async () => {
    talk.press();
    expect(voice.log).toEqual(["prepare:press"]);
    expect(captures).toEqual([true]);
    talk.listen();
    expect(voice.log).toEqual(["prepare:press", "start"]);
    voice.volume = 0.5;
    vi.advanceTimersByTime(LEVEL_MS * 2);
    expect(talk.snapshot()).toMatchObject({ kind: "listening", levels: [0.5, 0.5], cancel: false });
    talk.release();
    expect(talk.snapshot()).toEqual({ kind: "busy", note: "hearing" });
    await vi.runOnlyPendingTimersAsync();
    expect(voice.log).toContain("stop");
    expect(said).toEqual([{ text: "西湖边有什么好吃的", map: { ...VIEW, via: "button", spoken: true } }]);
    expect(talk.snapshot()).toMatchObject({ kind: "busy", said: "西湖边有什么好吃的", note: "thinking" });
    // 不录了：语音输入说完了
    expect(captures).toEqual([true, false]);
  });

  test("上滑进\"松开取消\"后松手：取消、不发；没认出来写原因；按下了没开始录，过一会儿自己算说完", async () => {
    talk.press();
    talk.listen();
    talk.setCancelZone(true);
    expect(talk.snapshot()).toMatchObject({ kind: "listening", cancel: true });
    talk.release();
    expect(voice.log).toContain("cancel");
    expect(talk.snapshot()).toEqual({ kind: "idle" });
    expect(said).toEqual([]);

    heard = { ok: false, reason: "没听清" };
    talk.press();
    talk.listen();
    talk.release();
    await vi.runOnlyPendingTimersAsync();
    expect(talk.snapshot()).toEqual({ kind: "reply", text: "没听清", failed: true });

    captures.length = 0;
    talk.dismiss();
    talk.press();
    expect(captures).toEqual([true]);
    vi.advanceTimersByTime(PRESS_CAPTURE_MS);
    expect(captures).toEqual([true, false]);
  });

  test("语音插件停用：长按不录，写一句\"点一下打字\"；正录着的马上取消、放掉录音器", () => {
    talk.press();
    talk.listen();
    talk.setVoice(false);
    expect(voice.log).toEqual(["prepare:press", "start", "cancel", "release"]);
    expect(talk.snapshot()).toEqual({ kind: "idle" });
    expect(talk.typeOnly).toBe(true);
    talk.press();
    talk.listen();
    expect(talk.snapshot()).toEqual({ kind: "reply", text: "语音插件没启用：点一下按钮打字", failed: true });
    expect(voice.log.filter((l) => l === "start")).toHaveLength(1);
    // 点一下照常打字
    talk.open();
    expect(talk.snapshot()).toEqual({ kind: "bar" });
  });

  test("收起：正在等回话也收（回来的回话不再显示）；换了取上下文的函数，发的时候用新的；离开地图页放掉录音器", () => {
    talk.open();
    talk.sendText("这是哪");
    talk.dismiss();
    turn(1, { phase: "replied", text: "西湖" });
    expect(talk.snapshot()).toEqual({ kind: "idle" });
    talk.setContext(() => ({ lat: 1.28, lon: 103.86, zoom: 13, basemap: "osm", card: { id: "c-1" } }));
    talk.open();
    talk.sendText("这条路多远");
    expect(said[1]).toEqual({ text: "这条路多远", map: { lat: 1.28, lon: 103.86, zoom: 13, basemap: "osm", card: { id: "c-1" }, via: "button" } });
    talk.hidden();
    expect(talk.snapshot()).toEqual({ kind: "idle" });
    expect(voice.log.at(-1)).toBe("release");
  });
});

/** 一个记在内存里的存储；broken 时一取就抛错（隐私模式） */
function memoryStorage(broken = false): DeviceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const guard = () => {
    if (broken) throw new Error("SecurityError");
  };
  return {
    data,
    getItem: (k) => (guard(), data.get(k) ?? null),
    setItem: (k, v) => (guard(), void data.set(k, v)),
    removeItem: (k) => (guard(), void data.delete(k)),
  };
}

describe("地图页怎么摆，记在这台设备上", () => {
  test("默认：聊天窗关着、左边那一栏开着、抽屉平常高；改了记下（默认的不留记号），下次照着来", () => {
    const storage = memoryStorage();
    const layout = mapLayoutIn(() => storage);
    expect(layout.snapshot()).toEqual({ chatOpen: false, panel: "open", drawer: "normal" });
    let changes = 0;
    layout.subscribe(() => changes++);
    layout.setChatOpen(true);
    layout.setPanel("folded");
    layout.setDrawer("low");
    layout.setDrawer("low");
    expect(changes).toBe(3);
    expect(Object.fromEntries(storage.data)).toEqual({ "ergo-map-chat": "open", "ergo-map-panel": "folded", "ergo-map-drawer": "low" });
    expect(mapLayoutIn(() => storage).snapshot()).toEqual({ chatOpen: true, panel: "folded", drawer: "low" });
    layout.setPanel("closed");
    expect(mapLayoutIn(() => storage).snapshot().panel).toBe("closed");
    layout.setChatOpen(false);
    layout.setPanel("open");
    layout.setDrawer("normal");
    expect(storage.data.size).toBe(0);
    // 认不得的按默认
    storage.data.set("ergo-map-panel", "huh");
    expect(mapLayoutIn(() => storage).snapshot().panel).toBe("open");
  });

  test("存储用不了：按默认，改了照样生效（只是不记）", () => {
    const layout = mapLayoutIn(() => memoryStorage(true));
    expect(layout.snapshot()).toEqual({ chatOpen: false, panel: "open", drawer: "normal" });
    layout.setChatOpen(true);
    expect(layout.snapshot().chatOpen).toBe(true);
  });

  test("聊天窗的宽度：和浏览侧边栏同一套（初值 400、最窄 320、最宽六成），记在自己的键上", () => {
    expect(MAP_CHAT_WIDTH.key).toBe("ergo-map-chat-width");
    expect(MAP_CHAT_WIDTH.initial).toBe(400);
    expect(MAP_CHAT_WIDTH.parse).toBe(chatSideWidthOf);
    const storage = memoryStorage();
    const width = stageSideWidthSettingIn(() => storage, MAP_CHAT_WIDTH);
    expect(width.width()).toBe(400);
    width.set(dragChatSideWidth(400, -80, 1200));
    expect(storage.data.get("ergo-map-chat-width")).toBe("480");
    expect(storage.data.has("ergo-browse-side-width")).toBe(false);
    expect(clampChatSideWidth(900, 1000)).toBe(600);
    expect(clampChatSideWidth(200, 1000)).toBe(320);
  });
});

describe("二狗按钮在哪", () => {
  test("右下角：离右边 16，底下让开署名角标；手机上的抽屉盖着时让开它", () => {
    expect(MAP_FAB_ATTRIBUTION_ROOM).toBe(20);
    expect(mapFabSpot({ width: 390, height: 700 }, 0)).toEqual({ x: 390 - 16 - 36, y: 700 - 16 - 20 - 36 });
    expect(mapFabSpot({ width: 390, height: 700 }, 150)).toEqual({ x: 338, y: 700 - 16 - 20 - 150 - 36 });
  });
});

/** 原型的假足迹（昨天）当成这一天 */
const today = localDate(new Date());
const view = demoMapDay(shiftMapDate(today, -1));
const fp = (extra: Partial<Footprints> = {}): Footprints => ({
  date: view.date,
  today,
  view,
  day: footprintDay(view),
  loading: false,
  error: undefined,
  shown: true,
  selected: undefined,
  fit: undefined,
  focus: undefined,
  pick: () => {},
  toggle: () => {},
  select: () => {},
  jumpTo: () => {},
  markClick: () => false,
  ...extra,
});
const navigate = () => {};
/** 左边那一栏画成什么（默认宽的、开着） */
const panel = (props: Partial<Parameters<typeof FootprintPanel>[0]>) =>
  renderToStaticMarkup(createElement(FootprintPanel, { fp: fp(), wide: true, listOpen: false, onCloseList: () => {}, navigate, onPanel: () => {}, onDrawer: () => {}, ...props }));
/** 标题栏上选日期那一组（宽的时候） */
const wideBar = (listInWide: boolean) => renderToStaticMarkup(createElement(FootprintBar, { fp: fp(), wide: true, listOpen: !listInWide, onList: () => {}, listInWide, navigate }));

describe("左边那一栏收起、关掉；手机上的抽屉", () => {
  test("宽的时候：开着有收起、关掉；收起后是左上角一个小按钮（写着这一天几条）；关掉什么都不画", () => {
    const open = panel({ panel: "open" });
    expect(open).toContain('class="map-day-panel"');
    expect(open).toContain('aria-label="收起这一栏"');
    expect(open).toContain('aria-label="关掉这一栏"');
    const folded = panel({ panel: "folded" });
    expect(folded).not.toContain('class="map-day-panel"');
    expect(folded).toMatch(/class="map-day-panel-tab"[^>]*aria-label="打开这一天的列表"/);
    expect(folded).toContain(`<span class="map-day-panel-count">${footprintDay(view).timeline.length}</span>`);
    expect(panel({ panel: "closed" })).toBe("");
    for (const html of [open, folded]) expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("手机上：选中的那一处、打开的列表是抽屉——顶上有把手，拖低了标 low（只露标题那一行）", () => {
    const spot = footprintDay(view).spots[0]!.key;
    const normal = panel({ wide: false, fp: fp({ selected: spot }) });
    expect(normal).toMatch(/class="map-day-card" data-drawer="normal"/);
    expect(normal).toMatch(/class="map-drawer-grip"[^>]*aria-label="拖低这张卡（往下拖，再往下拖关掉）"/);
    const low = panel({ wide: false, fp: fp({ selected: spot }), drawer: "low" });
    expect(low).toContain('data-drawer="low"');
    expect(low).toContain('aria-label="拉高这张卡"');
    const list = panel({ wide: false, listOpen: true, drawer: "low" });
    expect(list).toMatch(/class="map-day-card" data-list="" data-drawer="low"/);
  });

  test("宽的时候那一栏收着、关着：标题栏上的概况能点（打开它）；开着时不能点", () => {
    expect(wideBar(true)).toMatch(/<button[^>]*class="map-day-summary"/);
    expect(wideBar(false)).not.toMatch(/<button[^>]*class="map-day-summary"/);
  });
});
