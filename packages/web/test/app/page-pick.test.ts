// 挑图片窗口在二狗网页这一侧（149 号票，app/page-pick.ts）：页面桥、取缩略图、取字节、交给 App、对卡做动作都换成假的，预备用真的
// PageStage。查：
// - 秘书给这台设备的网页候选卡（这一页的）：窗口弹出来，推荐的预先选上；先取缩略图（守护进程缩好的小图）马上显示，再在后台预备原图
//   （推荐的先）；别的网页上的卡不弹、不预备；
// - 窗口里点"交"：本机马上用预备好的文件交进框（不再取、不等守护进程），交完再带着结果去卡上记一笔；交好了写一句、过一会儿收起，
//   没用上的预备文件放掉；没交进去写原因（卡上也记）、还能再点；拦下的选文件对话框交给对话框；
// - 卡在别处处理了（会话里交了、都不要了）：窗口写一句跟着收起，预备的放掉；
// - 都不要：卡关掉；收起（×、返回手势）：窗口收起、预备的留着（会话里的卡照样能挑）；换了网页：收起、预备的放掉。
// 181 号票：标题里说到助理用起的名字（纯文字换好名字，另给按名字切开的几段，页面桥画成名字标签），改名、换语言后开着的窗口跟着变。
// 184 号票：卡上记着编号（ref，秘书按编号指的上传框）的按编号交。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StagedFile } from "../../src/app/native-browser.ts";
import { PagePickSync, PICK_DONE_HIDE_MS } from "../../src/plugins/browsing/page-pick.ts";
import { PageStage } from "../../src/plugins/browsing/page-stage.ts";
import type { PagePickView } from "../../src/page-bridge/protocol.ts";
import { activeLocaleFrom, type BrowsePickCardPayload, type BrowsePickConfirmInput, type BrowsePickView, type Card, DEFAULT_LANGUAGE, type PageCommandFile, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const URL_NOW = "https://tryon.example.cn/upload";
const photo = (i: number): PageCommandFile => ({ token: `t${i}`, name: `头像${i}.png`, mime: "image/png", size: 1000 + i, image: true });

function view(id: string, extra: Partial<BrowsePickCardPayload> = {}, status: Card["status"] = "pending", version = 1): BrowsePickView {
  const payload: BrowsePickCardPayload = {
    page: { title: "AI 换装", url: URL_NOW },
    field: "「上传你的照片」（上传框）",
    fieldId: "f3",
    browser: "b-0123456789abcdef",
    multiple: false,
    files: [photo(1), photo(2), { token: "t9", name: "说明.pdf", mime: "application/pdf", size: 10, image: false }],
    recommended: ["t2"],
    expiresAt: "2099-01-01T00:00:00Z",
    ...extra,
  };
  return { card: { id, type: "browse_pick", typeVersion: 1, version, status, payload, text: "候选", createdAt: `2026-10-18T10:00:0${id.slice(-1)}+08:00` }, payload };
}

let pushed: PagePickView[];
let delivered: Array<{ target: unknown; files: readonly StagedFile[] }>;
let deliverResult: { ok: boolean; count?: number; reason?: string };
let actions: Array<{ cardId: string; action: string; input?: BrowsePickConfirmInput }>;
let order: string[];
let discarded: string[];
let logs: string[];
let sync: PagePickSync;
/** 助理现在的名字（181 号票） */
let assistantName: string | undefined;

const settle = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
};
const last = () => pushed.at(-1) as Extract<PagePickView, { kind: "pick" }>;

beforeEach(() => {
  vi.useFakeTimers();
  pushed = [];
  delivered = [];
  deliverResult = { ok: true };
  actions = [];
  order = [];
  discarded = [];
  logs = [];
  assistantName = undefined;
  const stage = new PageStage({
    fetch: (token) => {
      order.push(`原图 ${token}`);
      return Promise.resolve(new TextEncoder().encode(token));
    },
    put: () => Promise.resolve(true),
    discard: (ids) => discarded.push(...ids),
    log: (line) => logs.push(line),
    now: () => Date.now(),
  });
  sync = new PagePickSync({
    page: {
      pick: (v) => {
        pushed.push(v);
        return Promise.resolve(true);
      },
      deliver: (target, files) => {
        delivered.push({ target, files });
        return Promise.resolve(deliverResult.ok ? { ok: true, count: deliverResult.count ?? files.length } : { ok: false, reason: deliverResult.reason ?? "" });
      },
    },
    stage,
    cardAction: (cardId, action, input) => actions.push({ cardId, action, ...(input ? { input } : {}) }),
    thumbnail: (file) => {
      order.push(`缩略图 ${file.token}`);
      return Promise.resolve(`thumb-${file.token}`);
    },
    currentUrl: () => URL_NOW,
    now: () => Date.now(),
    assistantName: () => assistantName,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const act = (id: string, action: "choose" | "deliver" | "dismiss" | "hide", token?: string) =>
  sync.handle({ type: "page", event: action === "choose" ? { type: "pick", id, action, token: token! } : { type: "pick", id, action } });

describe("候选一出来", () => {
  test("这一页的卡弹出窗口，推荐的预先选上；先取缩略图马上显示，再预备原图（推荐的先）；别的网页上的卡不弹、不预备", async () => {
    expect(pushed).toEqual([{ kind: "none" }]);
    sync.cardsChanged([view("c-1"), view("c-2", { page: { title: "别的", url: "https://other.example/" } })]);
    expect(last()).toMatchObject({
      kind: "pick",
      id: "c-1",
      title: "二狗给 「上传你的照片」（上传框） 找了 3 个",
      titleParts: [{ name: "二狗" }, "给 「上传你的照片」（上传框） 找了 3 个"],
      multiple: false,
      phase: "choosing",
      note: "点一张选中它",
    });
    expect(last().files.map((f) => f.checked)).toEqual([false, true, false]);
    await settle();
    expect(order).toEqual(["缩略图 t1", "缩略图 t2", "原图 t2", "原图 t1", "原图 t9"]);
    expect(last().files.map((f) => f.thumb)).toEqual(["thumb-t1", "thumb-t2", ""]);
  });
});

describe("窗口里点交", () => {
  test("本机马上用预备好的文件交进框（不再取、不等守护进程），交完去卡上记一笔；交好了写一句、过一会儿收起，没用上的预备文件放掉", async () => {
    sync.cardsChanged([view("c-1")]);
    await settle();
    act("c-1", "choose", "t1");
    expect(last().files.map((f) => f.checked)).toEqual([true, false, false]);
    const fetched = order.length;
    act("c-1", "deliver");
    expect(last()).toMatchObject({ phase: "sending", note: "在交……" });
    await settle();
    expect(order).toHaveLength(fetched);
    expect(delivered).toEqual([{ target: { fieldId: "f3" }, files: [expect.objectContaining({ name: "头像1.png" })] }]);
    expect(actions).toEqual([{ cardId: "c-1", action: "confirm", input: { tokens: ["t1"], done: { delivered: 1 } } }]);
    expect(last()).toMatchObject({ phase: "done", note: "交好了，1 个" });
    expect(logs[0]).toMatch(/^交文件（挑图片窗口）1 个，用上预备好的 1 个/);
    // 没用上的 t2、t9 放掉
    expect(discarded).toHaveLength(2);
    // 卡在守护进程那边记下了：窗口照样写着交好了，过一会儿收起
    sync.cardsChanged([view("c-1", { picked: ["t1"], delivered: 1 }, "handled", 2)]);
    expect(last()).toMatchObject({ phase: "done" });
    await vi.advanceTimersByTimeAsync(PICK_DONE_HIDE_MS);
    expect(pushed.at(-1)).toEqual({ kind: "none" });
  });

  test("没交进去：写原因、卡上也记一笔，还能再点；拦下的选文件对话框交给对话框", async () => {
    sync.cardsChanged([view("c-1")]);
    await settle();
    deliverResult = { ok: false, reason: "页面上没有这个框了" };
    act("c-1", "deliver");
    await settle();
    expect(last()).toMatchObject({ phase: "failed", note: "没交进去：页面上没有这个框了（可以再点交）" });
    expect(actions).toEqual([{ cardId: "c-1", action: "confirm", input: { tokens: ["t2"], done: { failed: "页面上没有这个框了" } } }]);
    // 再点一次（预备的已经交给 App 用掉了，现取）
    deliverResult = { ok: true };
    act("c-1", "deliver");
    await settle();
    expect(delivered).toHaveLength(2);
    expect(last()).toMatchObject({ phase: "done" });

    sync.cardsChanged([view("c-1", {}, "handled", 3), view("c-2", { fieldId: "chooser", field: "网页弹出的选文件对话框", multiple: true })]);
    await vi.advanceTimersByTimeAsync(PICK_DONE_HIDE_MS);
    await settle();
    expect(last()).toMatchObject({ id: "c-2", multiple: true, note: "点选要交的，能选好几个" });
    act("c-2", "choose", "t1");
    act("c-2", "deliver");
    await settle();
    expect(delivered.at(-1)).toMatchObject({ target: "chooser" });
    expect(delivered.at(-1)?.files.map((f) => f.name)).toEqual(["头像1.png", "头像2.png"]);
  });
});

describe("按编号指的上传框（184 号票）", () => {
  test("卡上记着编号（ref）的：按编号交（交之前页面桥核对还是那一页、还是上传框）；对不上的原因写在窗口上、卡上也记一笔", async () => {
    sync.cardsChanged([view("c-1", { fieldId: "e2", ref: "e2", field: "「产品图」（上传框）" })]);
    await settle();
    act("c-1", "deliver");
    await settle();
    expect(delivered).toEqual([{ target: { ref: "e2", url: URL_NOW }, files: [expect.objectContaining({ name: "头像2.png" })] }]);
    expect(last()).toMatchObject({ phase: "done" });

    sync.cardsChanged([view("c-2", { fieldId: "e5", ref: "e5" })]);
    await vi.advanceTimersByTimeAsync(PICK_DONE_HIDE_MS);
    await settle();
    deliverResult = { ok: false, reason: "网页换了，编号对不上了" };
    act("c-2", "deliver");
    await settle();
    expect(delivered.at(-1)).toMatchObject({ target: { ref: "e5", url: URL_NOW } });
    expect(last()).toMatchObject({ phase: "failed", note: "没交进去：网页换了，编号对不上了（可以再点交）" });
    expect(actions.at(-1)).toEqual({ cardId: "c-2", action: "confirm", input: { tokens: ["t2"], done: { failed: "网页换了，编号对不上了" } } });
  });
});

describe("别处处理了、都不要、收起、换了网页", () => {
  test("会话里交了：窗口写一句跟着收起，预备的放掉；都不要：卡关掉、窗口换下一张", async () => {
    sync.cardsChanged([view("c-1")]);
    await settle();
    sync.cardsChanged([view("c-1", { picked: ["t2"], delivered: 1 }, "handled", 2)]);
    expect(last()).toMatchObject({ id: "c-1", phase: "done", note: "在会话里交好了，1 个" });
    expect(discarded).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(PICK_DONE_HIDE_MS);
    expect(pushed.at(-1)).toEqual({ kind: "none" });

    sync.cardsChanged([view("c-1", {}, "handled", 2), view("c-2"), view("c-3")]);
    expect(last().id).toBe("c-3");
    act("c-3", "dismiss");
    expect(actions).toEqual([{ cardId: "c-3", action: "dismiss" }]);
    expect(last().id).toBe("c-2");
  });

  test("收起（×、返回手势）：窗口收起、预备的留着；换了网页：收起、预备的放掉", async () => {
    sync.cardsChanged([view("c-1")]);
    await settle();
    act("c-1", "hide");
    expect(pushed.at(-1)).toEqual({ kind: "none" });
    expect(discarded).toEqual([]);
    sync.cardsChanged([view("c-1"), view("c-2")]);
    expect(last().id).toBe("c-2");
    sync.handle({ type: "pick-close" });
    expect(pushed.at(-1)).toEqual({ kind: "none" });
    await settle();
    const staged = discarded.length;
    sync.handle({ type: "state", state: { url: "https://other.example/", title: "", progress: 0, loading: true, canGoBack: false, canGoForward: false } });
    expect(discarded.length).toBeGreaterThan(staged);
    expect(pushed.at(-1)).toEqual({ kind: "none" });
  });
});

describe("181 号票：标题里用起的名字", () => {
  afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

  test("标题用起的名字（纯文字换好、另给几段）；改名字、换语言后开着的窗口跟着变", () => {
    assistantName = "小美";
    sync.cardsChanged([view("c-1")]);
    expect(last()).toMatchObject({ title: "小美给 「上传你的照片」（上传框） 找了 3 个", titleParts: [{ name: "小美" }, "给 「上传你的照片」（上传框） 找了 3 个"] });
    const count = pushed.length;
    // 什么都没变：不重交
    sync.cardsChanged([view("c-1")]);
    expect(pushed).toHaveLength(count);
    assistantName = "<b>阿福</b>";
    sync.cardsChanged([view("c-1")]);
    expect(last()).toMatchObject({ title: "<b>阿福</b>给 「上传你的照片」（上传框） 找了 3 个", titleParts: [{ name: "<b>阿福</b>" }, "给 「上传你的照片」（上传框） 找了 3 个"] });
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    sync.cardsChanged([view("c-1")]);
    expect(last()).toMatchObject({ title: "<b>阿福</b> found 3 for 「上传你的照片」（上传框）", titleParts: [{ name: "<b>阿福</b>" }, " found 3 for 「上传你的照片」（上传框）"] });
  });
});
