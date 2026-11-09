// 点旁边的字摆到地图上（plugins/map/label-place.ts）：Node 里能测的那部分（一个最小的假 DOM，没有动画帧）——
// 458：缩放的途中（还是那几个点、字框大小没变，只是彼此的相对位置变了）字不重排，照上一次排的跟着点走、引线照点重画；
// 停下来 ZOOM_SETTLE_MS 没再变才排一次。换了一批点、只是拖（相对位置没变）照旧。
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLabelPlacer, type PlacedMark, ZOOM_SETTLE_MS } from "../../src/plugins/map/label-place.ts";

afterEach(() => {
  vi.useRealTimers();
});

interface FakeLine {
  attrs: Record<string, string>;
  removed: boolean;
}

function fakeHost() {
  const lines: FakeLine[] = [];
  const doc = {
    defaultView: undefined,
    createElementNS: (_ns: string, tag: string) => {
      const el = {
        tag,
        attrs: {} as Record<string, string>,
        removed: false,
        setAttribute(name: string, value: string) {
          el.attrs[name] = value;
        },
        append() {},
        remove() {
          el.removed = true;
        },
      };
      if (tag === "line") lines.push(el);
      return el;
    },
  };
  const host = { ownerDocument: doc, append() {} } as unknown as HTMLElement;
  return { host, lines };
}

/** 一个点：24×30 的针，字在针的右边（60×18） */
function mark(id: string, x: number, y: number): PlacedMark {
  const label = { offsetLeft: 26, offsetTop: 2, offsetWidth: 60, offsetHeight: 18, style: { transform: "" }, dataset: {} as Record<string, string> };
  const pin = { offsetLeft: 2, offsetTop: 1, offsetWidth: 20, offsetHeight: 20 };
  const el = { hidden: false, offsetWidth: 24, offsetHeight: 30 };
  return { id, kind: "stay", el: el as unknown as HTMLElement, pin: pin as unknown as HTMLElement, label: label as unknown as HTMLElement, x, y };
}
const moveTo = (m: PlacedMark, x: number, y: number): PlacedMark => ({ ...m, x, y });
const transforms = (marks: readonly PlacedMark[]) => marks.map((m) => m.label!.style.transform);

describe("字跟着点走（458：缩放途中不重排）", () => {
  test("缩放途中字不重排（挤到一起也先不动），停下来 ZOOM_SETTLE_MS 以后才排开；挪开了的字的引线跟着点画", () => {
    vi.useFakeTimers();
    const { host, lines } = fakeHost();
    const placer = createLabelPlacer(host);
    const bounds = { left: 0, top: 0, right: 600, bottom: 600 };
    // 一开始离得远：都在针的右边
    let marks = [mark("a", 200, 200), mark("b", 200, 260)];
    placer.update(marks, bounds);
    expect(transforms(marks)).toEqual(["", ""]);
    // 缩小（围着 a）：b 挪到 a 下面 15 像素，两个字叠在一起——缩放途中先不排
    marks = [moveTo(marks[0]!, 200, 200), moveTo(marks[1]!, 200, 230)];
    placer.update(marks, bounds);
    marks = [moveTo(marks[0]!, 200, 200), moveTo(marks[1]!, 200, 215)];
    placer.update(marks, bounds);
    expect(transforms(marks)).toEqual(["", ""]);
    // 还没停够：不排
    vi.advanceTimersByTime(ZOOM_SETTLE_MS - 10);
    expect(transforms(marks)).toEqual(["", ""]);
    // 停下来了：排开（有一个字挪了）
    vi.advanceTimersByTime(20);
    expect(transforms(marks).filter((t) => t !== "")).toHaveLength(1);
    const placed = transforms(marks);
    // 再放大一点（缩放途中）：字照上一次排的跟着点走，不重排；挪开了的引线另一头跟着点
    marks = [moveTo(marks[0]!, 200, 200), moveTo(marks[1]!, 200, 222)];
    placer.update(marks, bounds);
    expect(transforms(marks)).toEqual(placed);
    const live = lines.filter((l) => !l.removed);
    for (const l of live) {
      const m = marks.find((x) => x.id === l.attrs["data-id"])!;
      expect([Number(l.attrs.x2), Number(l.attrs.y2)]).toEqual([m.x, m.y]);
    }
    placer.destroy();
  });

  test("只是拖（相对位置没变）不排、不等；换了一批点当场排", () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    const placer = createLabelPlacer(host);
    const bounds = { left: 0, top: 0, right: 600, bottom: 600 };
    let marks = [mark("a", 200, 200), mark("b", 200, 212)];
    placer.update(marks, bounds);
    const first = transforms(marks);
    expect(first.filter((t) => t !== "")).toHaveLength(1);
    // 拖：一起挪 5 像素，照旧
    marks = marks.map((m) => moveTo(m, m.x + 5, m.y + 5));
    placer.update(marks, bounds);
    expect(transforms(marks)).toEqual(first);
    // 换了一批（多一个 c 挤在中间）：当场排，三个字两两不叠
    marks = [...marks, mark("c", 205, 211)];
    placer.update(marks, bounds);
    expect(transforms(marks).filter((t) => t !== "").length).toBeGreaterThanOrEqual(2);
    placer.destroy();
  });
});
