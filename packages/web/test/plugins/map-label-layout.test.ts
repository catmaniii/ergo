// 地图上点旁边的字不互相盖住（451 补，plugins/map/label-layout.ts）：纯函数，数据都是编的——
// - 不挤的照旧在针的右边，没有引线；
// - 挤的先挪到针旁边近的几处（左边、右上、右下……），还贴着针、不画引线；
// - 很密的一组（几十个点挤在一小块里）：排完任何两个字框都不相交（还留着 LABEL_GAP），挪开了的才有引线，引线的起点在字框边上、
//   朝着点；字尽量不盖住别的针；给了边界时尽量不出边（点自己在边界外的不往里拉）；
// - 上一次挪到外面的那一处有优惠（拖、缩放时不来回跳），空出来了回到右边；重要的先排（rank 大的照旧在右边）；
// - 几十个点一次排完耗时可接受。
import { describe, expect, test } from "vitest";
import { LABEL_GAP, type LabelBox, type LabelPlacement, layoutLabels, leaderStart, LEADER_MIN, type Rect, rectsHit } from "../../src/plugins/map/label-layout.ts";

/** 定位针：24×30，针尖在点上；字在右边（和 map.css 的 .map-mark-label 一样：针的左上角往右 26、往下 2） */
const PIN: Rect = { left: -10, top: -29, right: 10, bottom: 2 };
const label = (id: string, x: number, y: number, width = 90, height = 20, rank?: number): LabelBox => ({ id, x, y, width, height, dx: 14, dy: -28, pin: PIN, ...(rank === undefined ? {} : { rank }) });

/** 排好以后字框在哪（绝对像素） */
const boxOf = (l: LabelBox, p: LabelPlacement): Rect => ({ left: l.x + p.dx, top: l.y + p.dy, right: l.x + p.dx + l.width, bottom: l.y + p.dy + l.height });

/** 相交（中间不到 LABEL_GAP，差一点浮点误差）的那几对 */
function overlaps(labels: readonly LabelBox[], placed: readonly LabelPlacement[]): string[] {
  const boxes = labels.map((l, i) => boxOf(l, placed[i]!));
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (rectsHit(boxes[i]!, boxes[j]!, LABEL_GAP - 0.01)) out.push(`${labels[i]!.id} × ${labels[j]!.id}`);
  }
  return out;
}

/** 引线不对的：没挪开却有引线、挪开了没有引线、太短、起点不在字框边上、不朝着点 */
function badLeaders(labels: readonly LabelBox[], placed: readonly LabelPlacement[]): string[] {
  const out: string[] = [];
  for (const [i, p] of placed.entries()) {
    const l = labels[i]!;
    const start = p.leader;
    if (!p.moved) {
      if (start !== undefined) out.push(`${p.id}：没挪开却有引线`);
      continue;
    }
    if (start === undefined) {
      out.push(`${p.id}：挪开了没有引线`);
      continue;
    }
    if (Math.hypot(start.x, start.y) < LEADER_MIN) out.push(`${p.id}：引线太短`);
    const e = 1e-6;
    const inside = start.x >= p.dx - e && start.x <= p.dx + l.width + e && start.y >= p.dy - e && start.y <= p.dy + l.height + e;
    const edge = Math.min(Math.abs(start.x - p.dx), Math.abs(start.x - (p.dx + l.width)), Math.abs(start.y - p.dy), Math.abs(start.y - (p.dy + l.height)));
    if (!inside || edge > e) out.push(`${p.id}：起点不在字框边上`);
    // 点、起点、字框中心在一条线上（朝着点）
    const cx = p.dx + l.width / 2;
    const cy = p.dy + l.height / 2;
    if (Math.abs(start.x * cy - start.y * cx) > e * Math.max(1, Math.hypot(cx, cy) ** 2)) out.push(`${p.id}：不朝着点`);
  }
  return out;
}

/** 可复现的"随机"（线性同余） */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe("不挤的照旧", () => {
  test("几个隔得开的点：字都在针的右边，没有引线", () => {
    const labels = [label("a", 50, 100), label("b", 50, 200), label("c", 300, 100), label("d", 300, 400)];
    const placed = layoutLabels(labels);
    expect(placed.map((p) => [p.id, p.dx, p.dy, p.moved, p.leader])).toEqual([
      ["a", 14, -28, false, undefined],
      ["b", 14, -28, false, undefined],
      ["c", 14, -28, false, undefined],
      ["d", 14, -28, false, undefined],
    ]);
  });

  test("没有字框大小（还没量到、坏的数）的照旧放、不参与", () => {
    const labels = [label("a", 50, 100), { ...label("b", 50, 100), width: 0 }, { ...label("c", 50, 100), x: Number.NaN }];
    const placed = layoutLabels(labels);
    expect(placed.map((p) => [p.id, p.dx, p.dy, p.moved])).toEqual([
      ["a", 14, -28, false],
      ["b", 14, -28, false],
      ["c", 14, -28, false],
    ]);
  });
});

describe("挤的往旁边让", () => {
  test("两个点挨着（上下差 10 像素）：先排的照旧在右边，后排的挪到针旁边近的一处，不画引线", () => {
    const labels = [label("a", 100, 100), label("b", 100, 110)];
    const placed = layoutLabels(labels);
    expect(placed[0]).toMatchObject({ dx: 14, dy: -28, moved: false });
    expect(placed[1]!.moved).toBe(false);
    expect(placed[1]!.leader).toBeUndefined();
    expect([placed[1]!.dx, placed[1]!.dy]).not.toEqual([14, -28]);
    expect(overlaps(labels, placed)).toEqual([]);
  });

  test("重要的先排：rank 大的照旧在右边，小的让", () => {
    const labels = [label("photo", 100, 110, 60, 18, 1), label("stay", 100, 100, 120, 20, 4)];
    const placed = layoutLabels(labels);
    expect(placed[1]).toMatchObject({ id: "stay", dx: 14, dy: -28 });
    expect(placed[0]!.dx !== 14 || placed[0]!.dy !== -28).toBe(true);
    expect(overlaps(labels, placed)).toEqual([]);
  });

  test("字尽量不盖住别的针：右边有一枚针挡着时挪到左边", () => {
    const labels = [label("a", 100, 100)];
    // 一枚没有字的针正好在 a 的字右边那一块
    const placed = layoutLabels(labels, { pins: [{ x: 150, y: 100, pin: PIN }] });
    expect(placed[0]).toMatchObject({ dx: -14 - 90, dy: -28, moved: false });
  });

  test("给了边界：右边出边时放到左边；点自己在边界外的不往里拉（照旧在右边）", () => {
    const bounds = { left: 0, top: 0, right: 320, bottom: 200 };
    const labels = [label("a", 280, 100), label("out", -30, 100)];
    const placed = layoutLabels(labels, { bounds });
    expect(placed[0]).toMatchObject({ dx: -14 - 90, dy: -28, moved: false });
    expect(placed[1]).toMatchObject({ dx: 14, dy: -28, moved: false });
  });
});

describe("很密的一组", () => {
  // 30 个点挤在 60×60 的一小块里（足迹里一条街上走走停停、拍了一路照片）
  const rnd = seeded(7);
  const dense = Array.from({ length: 30 }, (_, i) => label(`p${i}`, 200 + rnd() * 60, 200 + rnd() * 60, 50 + Math.round(rnd() * 90), 18 + Math.round(rnd() * 4), i % 3));

  test("排完任何两个字框都不相交（还留着 LABEL_GAP）", () => {
    expect(overlaps(dense, layoutLabels(dense))).toEqual([]);
  });

  test("挪开了的才有引线：起点在字框边上、朝着点，长度够；没挪开的没有", () => {
    const placed = layoutLabels(dense);
    expect(placed.filter((p) => p.moved).length).toBeGreaterThan(0);
    expect(badLeaders(dense, placed)).toEqual([]);
  });

  test("最先排的那个（rank 最大）贴着针放、没有引线（周围的针太密时可能在左边、上下）", () => {
    const placed = layoutLabels(dense);
    const first = dense.findIndex((l) => l.rank === 2);
    expect(placed[first]!.moved).toBe(false);
    expect(placed[first]!.leader).toBeUndefined();
  });

  test("几十个点一次排完：60 个挤成一团、120 个铺在一屏里，都在可接受的时间里（远不到一帧的几倍）", () => {
    const r = seeded(11);
    const clump = Array.from({ length: 60 }, (_, i) => label(`c${i}`, 300 + r() * 40, 300 + r() * 40, 60 + Math.round(r() * 100), 20, i % 4));
    const spread = Array.from({ length: 120 }, (_, i) => label(`s${i}`, r() * 1280, r() * 800, 60 + Math.round(r() * 100), 20, i % 4));
    for (const set of [clump, spread]) {
      const t0 = performance.now();
      const placed = layoutLabels(set);
      const ms = performance.now() - t0;
      expect(overlaps(set, placed)).toEqual([]);
      expect(badLeaders(set, placed)).toEqual([]);
      // 本机几毫秒；CI、同时跑着别的测试时放宽到 250 毫秒（只为慢放宽，不相交的断言不放松）
      expect(ms).toBeLessThan(250);
    }
  });

  test("一个点上叠了二十个字（同一处）：也排得开、都不相交", () => {
    const same = Array.from({ length: 20 }, (_, i) => label(`s${i}`, 400, 400, 80, 20));
    const placed = layoutLabels(same);
    expect(overlaps(same, placed)).toEqual([]);
    expect(badLeaders(same, placed)).toEqual([]);
    expect(placed.filter((p) => p.moved).length).toBeGreaterThan(10);
  });
});

describe("上一次的位置", () => {
  test("上一次挪开到的那一处照旧放得下：还放那里（拖、缩放时不来回跳）", () => {
    const labels = [label("a", 100, 100), label("b", 100, 104)];
    const first = layoutLabels(labels);
    // 换个方向挪一点点（像缩放了一点）：b 照旧去上一次那一处
    const again = layoutLabels(
      labels.map((l) => (l.id === "b" ? { ...l, y: 105 } : l)),
      { prefer: new Map(first.map((p) => [p.id, { dx: p.dx, dy: p.dy }])) },
    );
    expect([again[1]!.dx, again[1]!.dy]).toEqual([first[1]!.dx, first[1]!.dy]);
  });

  test("挤着的散开了：回到照旧的位置（右边），引线没了", () => {
    const labels = [label("a", 100, 100), label("b", 100, 104)];
    const first = layoutLabels(labels);
    const apart = layoutLabels(
      labels.map((l) => (l.id === "b" ? { ...l, y: 300 } : l)),
      { prefer: new Map(first.map((p) => [p.id, { dx: p.dx, dy: p.dy }])) },
    );
    expect(apart[1]).toMatchObject({ dx: 14, dy: -28, moved: false });
  });
});

describe("引线的起点", () => {
  test("字框在点的正右边：起点是字框左边的中点；点在字框里：没有", () => {
    const right = leaderStart(40, -10, 60, 20)!;
    expect(right.x).toBeCloseTo(40, 9);
    expect(right.y).toBeCloseTo(0, 9);
    const below = leaderStart(-30, 20, 60, 20)!;
    expect(below.x).toBeCloseTo(0, 9);
    expect(below.y).toBeCloseTo(20, 9);
    expect(leaderStart(-10, -10, 60, 20)).toBeUndefined();
  });
});
