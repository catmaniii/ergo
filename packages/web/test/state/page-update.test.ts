// 服务端的页面更新了（116 号票）：页面自己是哪一版（构建时写进 index.html），服务端现在是哪一版（连上时订阅的响应、index.html 换了时
// 活动状态频道上推来的临时事件 web_version、切回前台时经 HTTP 问到的），对不上才做事：
// - 在前台时来的新版本只出"二狗有新版本 · 刷新"；正在录音、输入框上方有附件时先不出，完了再出；"等会儿"之后同一版不再出，
//   切回前台、或者又来了新的一版时再出；
// - 在后台时来的（页面在后台、或者刚切回前台还在问服务端时才知道的）：回到前台、输入框是空的、没在录音、没有附件、没开着弹层，直接刷新；
//   有会丢的东西的照旧提示。返修（评审）：页面上任何一个文本框里有字（问题卡的"自己写"、计划卡的修改意见……）、有没发出去的消息和
//   卡片操作（断网时排着的）也算有东西会丢；问服务端的那几秒里又切到后台，晚到的"问完了"不算数。
import { describe, expect, test } from "vitest";
import { EVENT_TYPES, fieldsHaveText, type PageNow, pageUpdateAction, replay, type UiInput, type UiState, unsentWork } from "../../src/state/index.ts";
import { card, frame, textMessage } from "./events.ts";

const OWN = "a1b2c3d4e5f60718";
const NEWER = "9f8e7d6c5b4a3210";
const NEWEST = "0123456789abcdef";

const told = (version: string | undefined): UiInput => ({ kind: "web_version", version });
const pushed = (version: string): UiInput => ({ kind: "frame", frame: frame("activity", 3, EVENT_TYPES.webVersion, { version }) });
const LATER: UiInput = { kind: "update_later" };
const HIDDEN: UiInput = { kind: "page_hidden" };
const FOREGROUND: UiInput = { kind: "page_foreground" };
const SETTLED: UiInput = { kind: "page_settled" };

/** 前台、没在忙、什么都没打开（最常见的样子） */
const HERE: PageNow = { visible: true, busy: false, idle: true };
const action = (state: UiState, page: Partial<PageNow> = {}, own: string | undefined = OWN) => pageUpdateAction(state.webVersion, own, { ...HERE, ...page });

describe("在前台时：只提示", () => {
  test("对得上什么都不做；服务端换了一版（订阅的响应、推来的、问到的都一样）才提示，不直接刷新", () => {
    expect(action(replay([]))).toBe("none");
    expect(action(replay([told(OWN)]))).toBe("none");
    expect(action(replay([told(NEWER)]))).toBe("prompt");
    expect(action(replay([told(OWN), pushed(NEWER)]))).toBe("prompt");
    // 服务端又回到了页面这一版（回滚了）：不提示
    expect(action(replay([told(OWN), pushed(NEWER), pushed(OWN)]))).toBe("none");
  });

  test("不知道就什么都不做：页面自己没有版本号（开发服务器）、守护进程没说（旧版、index.html 里没有版本号）", () => {
    expect(pageUpdateAction(replay([told(NEWER)]).webVersion, undefined, HERE)).toBe("none");
    expect(action(replay([told(undefined)]))).toBe("none");
    // 问到"不知道"（换成了这张票之前构建的页面）：之前的提示也收起
    expect(action(replay([told(NEWER), told(undefined)]))).toBe("none");
  });

  test("正在录音、输入框上方有附件（在传、或传好了等着发）时先不出，完了再出", () => {
    const state = replay([told(OWN), pushed(NEWER)]);
    expect(action(state, { busy: true })).toBe("none");
    expect(action(state)).toBe("prompt");
  });

  test("点了“等会儿”收起；同一版再报来（重连、问到的）不出；又来了新的一版时再出", () => {
    const later = replay([told(OWN), pushed(NEWER), LATER]);
    expect(action(later)).toBe("none");
    // 重连上：订阅的响应里还是这一版
    expect(action(replay([{ kind: "connection", status: "offline" }, { kind: "connection", status: "online" }, told(NEWER)], later))).toBe("none");
    expect(action(replay([pushed(NEWEST)], later))).toBe("prompt");
    // 新的那一版也"等会儿"了，再来一版又出
    expect(action(replay([pushed(NEWEST), LATER], later))).toBe("none");
    expect(action(replay([pushed(NEWEST), LATER, pushed(NEWER)], later))).toBe("prompt");
  });

  test("在前台时来的新版本：切到后台再回来也只提示（“等会儿”过的再出），不直接刷新", () => {
    const later = replay([told(OWN), pushed(NEWER), LATER]);
    const back = replay([HIDDEN, FOREGROUND], later);
    expect(action(back)).toBe("prompt");
    expect(action(replay([SETTLED, told(NEWER)], back))).toBe("prompt");
    // 没有新版本时切回前台什么都不做
    expect(action(replay([told(OWN), HIDDEN, FOREGROUND, SETTLED]))).toBe("none");
    // 还没有新版本时点不到"等会儿"；万一先记下了，也不影响之后来的新版本
    expect(action(replay([LATER, told(NEWER)]))).toBe("prompt");
  });
});

describe("在后台时来的：回到前台、没有会丢的东西就直接刷新", () => {
  test("在后台时推来的：还在后台（看不见）不刷新；回到前台、什么都没打开，直接刷新", () => {
    const away = replay([told(OWN), HIDDEN, pushed(NEWER)]);
    expect(action(away, { visible: false })).toBe("prompt");
    const back = replay([FOREGROUND], away);
    expect(action(back)).toBe("reload");
    // 问完了服务端（还是这一版）也一样：这一版是在后台时来的
    expect(action(replay([told(NEWER)], back))).toBe("reload");
  });

  test("回到前台时页面上有会丢的东西（输入框里有字、引用了卡片、开着弹层）：照旧提示；在录音、有附件：先不出", () => {
    const back = replay([told(OWN), HIDDEN, pushed(NEWER), FOREGROUND]);
    expect(action(back, { idle: false })).toBe("prompt");
    expect(action(back, { busy: true })).toBe("none");
    expect(action(back, { busy: true, idle: false })).toBe("none");
  });

  test("切回前台时才知道的（后台时连接冻住了：重连的订阅响应、切回前台问到的）也算在后台时来的", () => {
    const returning = replay([told(OWN), HIDDEN, FOREGROUND]);
    expect(action(replay([told(NEWER)], returning))).toBe("reload");
    expect(action(replay([told(NEWER), SETTLED], returning))).toBe("prompt");
    // 问完了之后才来的：算在前台时来的，只提示
    expect(action(replay([SETTLED, pushed(NEWER)], returning))).toBe("prompt");
  });

  test("回到前台后问完了：没刷新的（有会丢的东西）之后输入框空了也不再自动刷新，只留着提示", () => {
    const settled = replay([told(OWN), HIDDEN, pushed(NEWER), FOREGROUND, SETTLED]);
    expect(action(settled)).toBe("prompt");
    // 下一次切到后台、再回来：这一版还是在后台时来的，回来时什么都没打开就刷新
    expect(action(replay([HIDDEN, FOREGROUND], settled))).toBe("reload");
  });

  test("“等会儿”之后在后台时又来了新的一版：回到前台直接刷新", () => {
    const later = replay([told(OWN), pushed(NEWER), LATER, HIDDEN, pushed(NEWEST), FOREGROUND]);
    expect(action(later)).toBe("reload");
  });

  test("回到前台还在问服务端时又切到后台：晚到的“问完了”不算数，之后在后台来的新版本回到前台照样直接刷新（返修）", () => {
    // 切回前台、问着服务端时又切走了；问完的那一下到的时候页面还在后台
    const away = replay([told(OWN), HIDDEN, FOREGROUND, HIDDEN, SETTLED, pushed(NEWER)]);
    expect(action(away, { visible: false })).toBe("prompt");
    expect(action(replay([FOREGROUND], away))).toBe("reload");
    // 回来之后问完了：照常算回到前台了，之后来的只提示
    expect(action(replay([FOREGROUND, SETTLED, pushed(NEWEST)], away))).toBe("prompt");
  });
});

describe("有没有会丢的东西（返修）", () => {
  test("没发出去的消息（在路上、断网排着、失败了留着原文等重发）、在路上的卡片操作：有；权威事件到了就没了", () => {
    const sending: UiInput = { kind: "send_message", conversation: "secretary", idempotencyKey: "k-1", parts: [{ type: "text", text: "明早九点提醒我交电费" }], time: "2026-10-13T09:00:00+08:00" };
    expect(unsentWork(replay([]))).toBe(false);
    expect(unsentWork(replay([sending]))).toBe(true);
    expect(unsentWork(replay([sending, { kind: "request_failed", idempotencyKey: "k-1", error: "连接断了" }]))).toBe(true);
    const confirmed = frame("secretary", 1, EVENT_TYPES.message, { message: textMessage("m-1", "user", "明早九点提醒我交电费"), idempotencyKey: "k-1" });
    expect(unsentWork(replay([sending, { kind: "frame", frame: confirmed }]))).toBe(false);

    const shown = frame("cards", 1, EVENT_TYPES.card, { card: card("c-1", 1) });
    const clicked: UiInput = { kind: "card_action", cardId: "c-1", action: "approve", idempotencyKey: "k-2" };
    expect(unsentWork(replay([shown]))).toBe(false);
    expect(unsentWork(replay([shown, clicked]))).toBe(true);
    // 卡片有了新版本（点的生效了，或者别处先处理了）：没了；被拒了也没什么要重发的（卡片上写着原因，用户再点）
    expect(unsentWork(replay([shown, clicked, { kind: "frame", frame: frame("cards", 2, EVENT_TYPES.card, { card: card("c-1", 2, { status: "handled" }) }) }]))).toBe(false);
    expect(unsentWork(replay([shown, clicked, { kind: "request_failed", idempotencyKey: "k-2", error: "已被处理" }]))).toBe(false);
  });

  test("页面上的文本框：有一个打了字就算（问题卡的“自己写”、计划卡的修改意见、详情里的输入……）；只有空白、不能编辑的、勾选框这类不算", () => {
    expect(fieldsHaveText([])).toBe(false);
    expect(fieldsHaveText([{ type: "textarea", text: "", editable: true }, { type: "text", text: "  ", editable: true }])).toBe(false);
    expect(fieldsHaveText([{ type: "textarea", text: "第二段写下周计划", editable: true }])).toBe(true);
    expect(fieldsHaveText([{ type: "text", text: "先别合并", editable: true }])).toBe(true);
    expect(fieldsHaveText([{ type: "time", text: "09:00", editable: true }])).toBe(true);
    expect(fieldsHaveText([{ type: "editable", text: "可编辑的一段", editable: true }])).toBe(true);
    // 只读、禁用的，勾选框、单选、隐藏、文件、滑块这类没有"写了的字"
    expect(fieldsHaveText([{ type: "text", text: "只读的", editable: false }])).toBe(false);
    for (const type of ["checkbox", "radio", "hidden", "file", "range", "color", "button", "submit"]) expect(fieldsHaveText([{ type, text: "on", editable: true }])).toBe(false);
  });
});
