// 会话滚到底（108 号票）：右下角"回到最新"的 ↓ 什么时候出、上面标什么；缩小后伸到最后一条下面的标注算进滚动范围多少。
// 滚到底就停（sizer 把伸出去的裁掉）靠真实排版，这里测不了：核对办法见 docs/dev.md 的"会话滚到最后一条就停"。
import { describe, expect, test } from "vitest";
import { AT_LATEST_PX, afterScroll, atLatest, type ContentKind, jumpBadge, jumpToLatestShown, maxSeq, newSince, ZOOM_TAIL_GAP_PX, zoomedOutTail } from "../../src/state/index.ts";

/** 可视区 600 高 */
const spot = (scrollTop: number, scrollHeight: number, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight });

describe("↓ 什么时候出：离开底部才出", () => {
  test("停在底部（滚到头）：不出", () => {
    expect(jumpToLatestShown(spot(1400, 2000))).toBe(false);
  });

  test("离底部不到 24 像素也算停在底部（和跟随最新一条同一个数）：不出", () => {
    expect(atLatest(spot(2000 - 600 - (AT_LATEST_PX - 1), 2000))).toBe(true);
    expect(jumpToLatestShown(spot(2000 - 600 - (AT_LATEST_PX - 1), 2000))).toBe(false);
  });

  test("往上翻开了 24 像素以上：出", () => {
    expect(jumpToLatestShown(spot(2000 - 600 - AT_LATEST_PX, 2000))).toBe(true);
    expect(jumpToLatestShown(spot(0, 2000))).toBe(true);
  });

  test("内容不满一屏（滚不动）：不出", () => {
    expect(jumpToLatestShown(spot(0, 600))).toBe(false);
    expect(jumpToLatestShown(spot(0, 380))).toBe(false);
  });

  test("只比一屏多一点点（不到 24 像素）：怎么滚都算在底部，不出", () => {
    expect(jumpToLatestShown(spot(0, 610))).toBe(false);
  });
});

describe("点了 ↓ 之后：还算不算在往底部滑、跟不跟最新的走（每次滚动之后，程序滚的也算）", () => {
  test("往下滑的途中：一路都算跟着最新的走", () => {
    expect(afterScroll(true, 500, spot(800, 3000))).toEqual({ jumping: true, follow: true });
  });

  test("到了底部：不算在滑了，接着跟最新的走", () => {
    expect(afterScroll(true, 2000, spot(2400, 3000))).toEqual({ jumping: false, follow: true });
  });

  test("往上滚了（拖滚动条、键盘翻页、定位到别处）：不算在滑了，也不跟最新的", () => {
    expect(afterScroll(true, 1200, spot(900, 3000))).toEqual({ jumping: false, follow: false });
  });

  test("没在滑：跟不跟看停没停在底部（和原来一样）", () => {
    expect(afterScroll(false, 0, spot(800, 3000))).toEqual({ jumping: false, follow: false });
    expect(afterScroll(false, 0, spot(2400, 3000))).toEqual({ jumping: false, follow: true });
  });

  test("评审 2026-10-13 的那一回：滑的途中内容变高，程序一下滚到底，之后拖滚动条往上翻，新内容来了不再被拉回底部", () => {
    // 点 ↓ 时离底 1400：开始滑
    let jumping = true;
    let top = 1000;
    const scroll = (s: ReturnType<typeof spot>) => {
      const r = afterScroll(jumping, top, s);
      jumping = r.jumping;
      top = s.scrollTop;
      return r.follow;
    };
    expect(scroll(spot(1300, 3000))).toBe(true);
    // 内容变高 120，跟随最新一条用程序一下滚到底（这一次的 follow 界面不用，但滑的状态要跟着变）
    scroll(spot(3120 - 600, 3120));
    expect(jumping).toBe(false);
    // 拖滚动条往上翻 600：不跟最新的了——新内容来了不会被拉回底部
    expect(scroll(spot(3120 - 600 - 600, 3120))).toBe(false);
    expect(jumping).toBe(false);
  });
});

/** 一条：只要 id 和底色（是不是消息） */
const item = (id: string, content: ContentKind = "reply") => ({ id, content });
/** 带序号的一条（会话条目层给的都带；正在生成的、乐观显示的没有） */
const seqItem = (id: string, seq: number | undefined, content: ContentKind = "reply") => ({ id, seq, content });

describe("↓ 上标什么：离开底部之后新到的", () => {
  const items = [item("a", "user"), item("b"), item("c"), item("d", "user"), item("e")];

  test("从最后一次停在底部时的最后一条往后算", () => {
    expect(newSince(items, "c").map((it) => it.id)).toEqual(["d", "e"]);
    expect(newSince(items, "e")).toEqual([]);
  });

  test("往上翻取回更早的一页（插在前面）不算新的", () => {
    expect(newSince([item("y"), item("z"), ...items], "c").map((it) => it.id)).toEqual(["d", "e"]);
  });

  test("那时还一条都没有：都算新的", () => {
    expect(newSince(items, undefined)).toHaveLength(5);
    expect(newSince([], undefined)).toEqual([]);
  });

  test("记着的那一条找不到了（被删了）：不算，宁可不标也不标错", () => {
    expect(newSince(items, "gone")).toEqual([]);
    expect(jumpBadge(items, "gone")).toBeUndefined();
  });

  test("新到了消息（你说的、回复、卡片、说明和记录）：写条数，思考、工具调用不算进条数", () => {
    const more = [...items, item("f", "thinking"), item("g", "tool"), item("h"), item("i", "plan"), item("j", "context")];
    expect(jumpBadge(more, "e")).toEqual({ count: "3" });
  });

  test("只多了思考、工具调用（agent 还在干活，没说话）：标一个圆点", () => {
    expect(jumpBadge([...items, item("f", "thinking"), item("g", "tool")], "e")).toBe("dot");
  });

  test("没有新的：不标", () => {
    expect(jumpBadge(items, "e")).toBeUndefined();
  });

  test("118 号票：附件挪到了这一轮文字的后面，按停在底部时手里最大的序号算——后来排到附件前面的话算新的，挪到后面的旧附件、早就在的话不算", () => {
    const later = [seqItem("u1", 1, "user"), seqItem("g", 3, "tool"), seqItem("r", 4), seqItem("att", 2)];
    expect(maxSeq(later)).toBe(4);
    // 停在底部时是 u1、att（附件是最后一条，最大的序号 2）；之后调了工具、写了文字，附件挪到文字后面
    expect(newSince(later, "att", 2).map((it) => it.id)).toEqual(["g", "r"]);
    expect(jumpBadge(later, "att", 2)).toEqual({ count: "1" });
    // 打开时就是这样（附件已经排在最后，最大的序号 4）：往上翻一点，没有新的
    expect(newSince(later, "att", 4)).toEqual([]);
    expect(jumpBadge(later, "att", 4)).toBeUndefined();
    // 停在底部时最后一条是正在出字的那段（还没有序号，最大的序号 2），定稿后 id 不变、附件挪到它后面：都不算新的
    expect(newSince(later, "r", 2).map((it) => it.id)).toEqual(["g"]);
    expect(newSince([seqItem("u1", 1, "user"), seqItem("r", 4), seqItem("att", 2)], "r", 2)).toEqual([]);
    // 正在生成的、乐观显示的（还没有序号）排在那一条后面的算新的
    expect(newSince([...later, seqItem("s", undefined)], "att", 4).map((it) => it.id)).toEqual(["s"]);
    // 往上翻取回的更早的一页序号小，不算
    expect(newSince([seqItem("old", 0), ...later], "att", 4)).toEqual([]);
  });

  test("太多写 99+", () => {
    const many = [item("0"), ...Array.from({ length: 100 }, (_, i) => item(`n${i}`))];
    expect(jumpBadge(many, "0")).toEqual({ count: "99+" });
    expect(jumpBadge(many.slice(0, 100), "0")).toEqual({ count: "99" });
  });
});

describe("缩小后伸到最后一条下面的标注、卡：算进滚动范围的那一截", () => {
  test("对话层（标注看不见，没有下沿）：0", () => {
    expect(zoomedOutTail(-Infinity, 3000, 1)).toBe(0);
  });

  test("没伸出去（离内容底边还有留空以上）：0", () => {
    // 全局层 0.15：留空 8 屏幕像素 = 8 / 0.15 ≈ 53.3 内容像素
    expect(zoomedOutTail(3000 - 60, 3000, 0.15)).toBe(0);
  });

  test("伸出去了：伸出去的那一截加上留空（内容坐标，向上取整）", () => {
    // 要点层 0.45：最低的标注下沿在 3200，内容 3000 → 200 + 8 / 0.45 ≈ 217.8 → 218
    expect(zoomedOutTail(3200, 3000, 0.45)).toBe(Math.ceil(200 + ZOOM_TAIL_GAP_PX / 0.45));
    expect(zoomedOutTail(3200, 3000, 0.45)).toBe(218);
    // 全局层：同一个下沿，屏幕上的留空一样是 8 像素，换成内容坐标更长
    expect(zoomedOutTail(3200, 3000, 0.15)).toBe(254);
  });
});
