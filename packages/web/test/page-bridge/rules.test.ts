// 页面桥里不碰 DOM 的规矩（src/page-bridge/rules.ts）在 Node 里直接跑。几样：
// - 气泡的宽度：手机上屏宽减 32，最宽 360；
// - 气泡摆在哪（不盖住框）：放在按钮背离框的那一边（按钮在框下面放下方、在框上面放上方），放不下换另一边
//   （越过框）；两边都放不下时先不盖框里文字那块（多行框的上面一截），再限高（至少 120、里面滚），实在不行才盖；左右不出屏幕、
//   至少留 8；不知道框在哪时优先上方；没有按钮时放在屏幕下面居中；小尖角指着按钮；
// - 波形：音量序列 → 竖条高度（照二狗 App 里"按住说话"的波形：最近的几格，音量 ×100，最矮 6）；
// - 上滑或划开算取消；录了几秒的写法；
// -按住说话时气泡在按钮上方（上边放不下放到离手指远、空间大的那一侧，不放下方）；挑图片窗口固定在屏幕上（手机贴底占满宽，
//   宽屏底部居中、最宽 520），和按钮、框无关。
// -能点的东西是什么种类（提交表单的按钮先认，再看 role、标签）、文字怎么收拾（空白并成一个、最长 200）、
//   超过上限时先列哪些（屏幕上看得见的、上半屏的优先，再按离屏幕远近；交出去的照页面上的先后）、哪些 target 会开新窗口。
// -哪些种类是框（文本框、上传框、下拉框）、现在的值怎么截（空白并成一个、前 40 字、空的不写）、下拉框的选项怎么收拾。
// - 悬浮按钮这一刻在哪（四种情况：侧边栏开合 × 选没选中）；右下角的按钮摆在哪（离右边、底边 16，让开手势区，网页的底部栏、
//   右下角的按钮盖住它就挪到上面，最多挪看得见的部分的四成，挪不下留在原处）。
// - 选中的地址用地图（447）：选中的字像不像地址（拿不准也给）、交给地图服务查的写法、"在地图上看""怎么去"那一行摆在哪。
import { describe, expect, test } from "vitest";
import { BUTTON_SIZE, cleanElementLabel, CORNER_GAP, ELEMENT_LABEL_MAX, elementSourceOf, fabSpot, guessAddress, MAP_CHIPS_GAP, mapQueryOf, offersMapActions, placeCornerButton, placeElementButton, placeMapChips,
  BUBBLE_EDGE,
  BUBBLE_GAP,
  BUBBLE_MAX_HEIGHT,
  BUBBLE_MIN_HEIGHT,
  bubbleWidth,
  chooseClickables,
  cleanElementText,
  clickRoleOf,
  inVoiceCancelZone,
  isFieldRole,
  opensNewWindow,
  optionTexts,
  PICK_EDGE,
  PICK_MAX_HEIGHT,
  PICK_MAX_WIDTH,
  placeBubble,
  placeListening,
  placePickWindow,
  previewText,
  type Rect,
  recordedText,
  textBlockOf,
  WAVE_BARS,
  waveBars,
} from "../../src/page-bridge/rules.ts";

/** 390 × 844 的手机屏 */
const PHONE: Rect = { left: 0, top: 0, right: 390, bottom: 844 };
const button = (left: number, top: number): Rect => ({ left, top, right: left + 36, bottom: top + 36 });

describe("气泡的宽度", () => {
  test("手机上屏宽减 32；宽屏最宽 360；窄得离谱也不是负的", () => {
    expect(bubbleWidth(390)).toBe(358);
    expect(bubbleWidth(360)).toBe(328);
    expect(bubbleWidth(1280)).toBe(360);
    expect(bubbleWidth(20)).toBe(0);
  });
});

/** 两个框重叠（横着、竖着都有交叠） */
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
/** 摆好的气泡占的那一块（高按 min(要多高, 最高能多高)） */
const bubbleRect = (at: { x: number; y: number; maxHeight: number }, size: { width: number; height: number }): Rect => ({
  left: at.x,
  top: at.y,
  right: at.x + size.width,
  bottom: at.y + Math.min(size.height, at.maxHeight),
});

describe("气泡摆在哪：放在按钮背离框的那一边，不盖住框", () => {
  // 手机上占满整行的单行框：按钮放不到右边，在框下面靠右（rules.ts 的 placeButton）
  const field: Rect = { left: 16, top: 200, right: 374, bottom: 244 };
  const size = { width: 358, height: 160 };

  test("按钮在框下面（框的右下角外侧）：气泡在按钮下方，离按钮 8，不盖框；横着不出屏幕，尖角指着按钮", () => {
    const at = placeBubble(button(338, 250), size, PHONE, field);
    expect(at).toMatchObject({ side: "below", y: 286 + BUBBLE_GAP, covers: "none" });
    expect(at.x).toBe(390 - BUBBLE_EDGE - 358);
    expect(at.x + at.tailX).toBe(356);
    expect(overlaps(bubbleRect(at, size), field)).toBe(false);
  });

  test("按钮在框上面（框在屏幕最下面）：气泡在按钮上方", () => {
    const low: Rect = { left: 16, top: 780, right: 374, bottom: 824 };
    const at = placeBubble(button(338, 738), size, PHONE, low);
    expect(at).toMatchObject({ side: "above", y: 738 - BUBBLE_GAP - 160, covers: "none" });
  });

  test("按钮在框右边（宽屏，单行框竖着居中）：气泡放下方、越过框的下边，不盖框；下方放不下换上方", () => {
    const wide: Rect = { left: 0, top: 0, right: 1280, bottom: 800 };
    const input: Rect = { left: 100, top: 300, right: 500, bottom: 340 };
    const small = { width: 360, height: 100 };
    const at = placeBubble(button(506, 302), small, wide, input);
    expect(at).toMatchObject({ side: "below", y: 340 + BUBBLE_GAP, covers: "none" });
    const lowInput: Rect = { left: 100, top: 700, right: 500, bottom: 740 };
    const up = placeBubble(button(506, 702), small, wide, lowInput);
    expect(up).toMatchObject({ side: "above", y: 700 - BUBBLE_GAP - 100, covers: "none" });
  });

  test("背离的那边放不下（按钮在框下面、下面没地方了）：换另一边，越过框放到框上面，不盖框", () => {
    const low: Rect = { left: 16, top: 700, right: 374, bottom: 744 };
    const at = placeBubble(button(338, 750), size, PHONE, low);
    expect(at).toMatchObject({ side: "above", y: 700 - BUBBLE_GAP - 160, covers: "none" });
    expect(overlaps(bubbleRect(at, size), low)).toBe(false);
  });

  test("两边都放不下（输入法弹起只剩 400）：多行框里文字在上面，气泡盖框下半截空白处，不盖文字那块", () => {
    const short: Rect = { left: 0, top: 0, right: 390, bottom: 400 };
    const textarea: Rect = { left: 16, top: 60, right: 374, bottom: 330 };
    const tall = { width: 358, height: 200 };
    const at = placeBubble(button(338, 336), tall, short, textarea);
    expect(at).toMatchObject({ side: "above", covers: "field" });
    expect(at.y + 200).toBe(336 - BUBBLE_GAP);
    expect(overlaps(bubbleRect(at, tall), textBlockOf(textarea))).toBe(false);
    expect(at.y).toBeGreaterThanOrEqual(textBlockOf(textarea).bottom + BUBBLE_GAP);
  });

  test("都放不下全高、但限高放得下（至少 120）：限高、内容在气泡里滚，不盖框；挑空间大的那边", () => {
    const short: Rect = { left: 0, top: 0, right: 390, bottom: 400 };
    const input: Rect = { left: 16, top: 150, right: 374, bottom: 194 };
    const big = { width: 358, height: 300 };
    const at = placeBubble(button(338, 200), big, short, input);
    expect(at).toMatchObject({ side: "below", y: 236 + BUBBLE_GAP, covers: "none" });
    expect(at.maxHeight).toBe(400 - BUBBLE_EDGE - (236 + BUBBLE_GAP));
    expect(at.maxHeight).toBeGreaterThanOrEqual(BUBBLE_MIN_HEIGHT);
  });

  test("实在放不下（只剩 300 高）：才盖住框，贴着按钮放空间大的那边、限高", () => {
    const tiny: Rect = { left: 0, top: 0, right: 390, bottom: 300 };
    const input: Rect = { left: 16, top: 120, right: 374, bottom: 164 };
    const at = placeBubble(button(338, 170), { width: 358, height: 200 }, tiny, input);
    expect(at).toMatchObject({ side: "above", covers: "text", y: BUBBLE_EDGE });
    expect(at.y + at.maxHeight).toBe(170 - BUBBLE_GAP);
  });

  test("文字那块：单行框是整个框，多行框是上面一截", () => {
    expect(textBlockOf(field)).toEqual(field);
    expect(textBlockOf({ left: 0, top: 100, right: 300, bottom: 400 })).toEqual({ left: 0, top: 100, right: 300, bottom: 156 });
  });
});

describe("气泡摆在哪：不知道框在哪（只有按钮）、没有按钮", () => {
  test("上方放得下就放上方：底边离按钮 8，横着以按钮为中、不出屏幕；尖角指着按钮", () => {
    const at = placeBubble(button(300, 500), { width: 358, height: 160 }, PHONE);
    expect(at.side).toBe("above");
    expect(at.y + 160).toBe(500 - BUBBLE_GAP);
    // 按钮在右边：气泡贴着右边留 8
    expect(at.x).toBe(390 - BUBBLE_EDGE - 358);
    expect(at.x + at.tailX).toBe(318);
    expect(at.maxHeight).toBe(BUBBLE_MAX_HEIGHT);
  });

  test("上方放不下（按钮在屏幕顶上）就放下方；按钮在左边时贴左边留 8，尖角不出圆角", () => {
    const at = placeBubble(button(20, 60), { width: 358, height: 160 }, PHONE);
    expect(at.side).toBe("below");
    expect(at.y).toBe(96 + BUBBLE_GAP);
    expect(at.x).toBe(BUBBLE_EDGE);
    expect(at.tailX).toBe(38 - BUBBLE_EDGE);
  });

  test("宽屏：气泡 360 宽，以按钮为中", () => {
    const wide: Rect = { left: 0, top: 0, right: 1280, bottom: 800 };
    const at = placeBubble(button(622, 400), { width: 360, height: 100 }, wide);
    expect(at.x).toBe(640 - 180);
    expect(at.tailX).toBe(180);
  });

  test("太高的内容不超过最高的高度", () => {
    const at = placeBubble(button(300, 800), { width: 358, height: 900 }, PHONE);
    expect(at.side).toBe("above");
    expect(at.maxHeight).toBe(BUBBLE_MAX_HEIGHT);
    expect(at.y).toBe(800 - BUBBLE_GAP - BUBBLE_MAX_HEIGHT);
  });

  test("看得见的部分不从 0 开始（缩放、输入法把视口往下推）：照它的边算", () => {
    const panned: Rect = { left: 100, top: 300, right: 490, bottom: 700 };
    const at = placeBubble(button(450, 600), { width: 358, height: 100 }, panned);
    expect(at.x).toBe(490 - BUBBLE_EDGE - 358);
    expect(at.y).toBe(600 - BUBBLE_GAP - 100);
    const top = placeBubble(button(150, 320), { width: 358, height: 100 }, panned);
    expect(top.side).toBe("below");
    expect(top.x).toBe(100 + BUBBLE_EDGE);
  });

  test("没有按钮（不知道是哪个框）：屏幕下面居中，离底边 8，没有尖角", () => {
    const at = placeBubble(undefined, { width: 358, height: 120 }, PHONE);
    expect(at.side).toBe("free");
    expect(at.x).toBe(16);
    expect(at.y).toBe(844 - BUBBLE_EDGE - 120);
    expect(at.tailX).toBe(-1);
  });
});

describe("按住说话时的气泡（波形在按钮上方）", () => {
  const size = { width: 358, height: 110 };

  test("上方放得下：放在按钮上方，横着以按钮为中、不出屏幕，尖角指着按钮；框在按钮上面也一样（可以盖框）", () => {
    const at = placeListening(button(300, 500), size, PHONE);
    expect(at.side).toBe("above");
    expect(at.y + size.height).toBe(500 - BUBBLE_GAP);
    expect(at.x).toBe(390 - BUBBLE_EDGE - 358);
    expect(at.tailX).toBe(318 - at.x);
    const mid = placeListening(button(150, 400), { width: 200, height: 110 }, PHONE);
    expect(mid.x).toBe(168 - 100);
  });

  test("按钮贴着屏幕顶：放到左右空间大的那一侧（离按着按钮的手指远），竖着以按钮为中，宽度不够收窄；不放下方", () => {
    const right = placeListening(button(340, 20), size, PHONE);
    expect(right.side).toBe("left");
    expect(right.width).toBe(340 - BUBBLE_GAP - BUBBLE_EDGE);
    expect(right.x).toBe(340 - BUBBLE_GAP - right.width!);
    expect(right.y).toBe(BUBBLE_EDGE);
    expect(right.tailX).toBe(-1);
    const left = placeListening(button(14, 20), size, PHONE);
    expect(left.side).toBe("right");
    expect(left.x).toBe(50 + BUBBLE_GAP);
    expect(left.width).toBe(390 - BUBBLE_EDGE - 58);
  });
});

describe("挑图片窗口摆在哪（固定在屏幕上，不跟着按钮）", () => {
  test("手机：贴底、占满宽；内容多了限高", () => {
    expect(placePickWindow(PHONE, 260)).toEqual({ x: 0, y: 844 - 260, width: 390, maxHeight: PICK_MAX_HEIGHT, docked: true });
    expect(placePickWindow(PHONE, 900)).toMatchObject({ y: 844 - PICK_MAX_HEIGHT, maxHeight: PICK_MAX_HEIGHT });
  });

  test("宽屏：底部居中，离底 16，最宽 520；输入法弹起（看得见的只剩上面一截）跟着往上，矮了限高", () => {
    const wide: Rect = { left: 0, top: 0, right: 1280, bottom: 800 };
    expect(placePickWindow(wide, 260)).toEqual({ x: (1280 - PICK_MAX_WIDTH) / 2, y: 800 - PICK_EDGE - 260, width: PICK_MAX_WIDTH, maxHeight: PICK_MAX_HEIGHT, docked: false });
    const tablet: Rect = { left: 0, top: 0, right: 640, bottom: 300 };
    const at = placePickWindow(tablet, 400);
    expect(at.width).toBe(PICK_MAX_WIDTH);
    expect(at.maxHeight).toBe(300 - PICK_EDGE - BUBBLE_EDGE);
    expect(at.y).toBe(300 - PICK_EDGE - at.maxHeight);
  });
});

describe("波形", () => {
  test("取最近的几格，音量 ×100 取整，最矮 6；不够的前面补最矮的", () => {
    expect(waveBars([0.5, 1, 0, 0.234], 6)).toEqual([6, 6, 50, 100, 6, 23]);
    expect(waveBars([], 3)).toEqual([6, 6, 6]);
    const many = Array.from({ length: 100 }, (_, i) => i / 100);
    const bars = waveBars(many);
    expect(bars).toHaveLength(WAVE_BARS);
    expect(bars.at(-1)).toBe(99);
  });

  test("超出 0–1 的、不是数的按边上算", () => {
    expect(waveBars([2, -1, Number.NaN], 3)).toEqual([100, 6, 6]);
  });
});

describe("按住说话", () => {
  test("上滑 60 像素、或往别处划开超过 80 像素算取消；手指抖一抖不算", () => {
    const from = { x: 100, y: 500 };
    expect(inVoiceCancelZone(from, { x: 104, y: 495 })).toBe(false);
    expect(inVoiceCancelZone(from, { x: 100, y: 440 })).toBe(true);
    expect(inVoiceCancelZone(from, { x: 100, y: 441 })).toBe(false);
    expect(inVoiceCancelZone(from, { x: 190, y: 500 })).toBe(true);
    expect(inVoiceCancelZone(from, { x: 100, y: 570 })).toBe(false);
    expect(inVoiceCancelZone(from, { x: 100, y: 590 })).toBe(true);
  });

  test("录了几秒写成分:秒", () => {
    expect(recordedText(0)).toBe("0:00");
    expect(recordedText(5999)).toBe("0:05");
    expect(recordedText(65_000)).toBe("1:05");
    expect(recordedText(-30)).toBe("0:00");
  });
});

describe("能点的东西", () => {
  test("种类：提交表单的按钮先认（button 默认 type 是 submit，在表单里才算；input submit、image）；再看 role（menuitem、tab、link、button）；a、area 是链接；input button、reset 是 input；summary 和别的是按钮", () => {
    const of = (tag: string, extra: Partial<{ type: string; role: string; hasForm: boolean }> = {}) => clickRoleOf({ tag, type: "", role: "", hasForm: false, ...extra });
    expect(of("button", { hasForm: true })).toBe("submit");
    expect(of("button", { type: "SUBMIT", hasForm: true, role: "tab" })).toBe("submit");
    expect(of("button")).toBe("button");
    expect(of("button", { type: "button", hasForm: true })).toBe("button");
    expect(of("button", { type: "reset", hasForm: true })).toBe("button");
    expect(of("input", { type: "submit" })).toBe("submit");
    expect(of("input", { type: "image" })).toBe("submit");
    expect(of("input", { type: "button" })).toBe("input");
    expect(of("input", { type: "reset" })).toBe("input");
    expect(of("div", { role: "tab" })).toBe("tab");
    expect(of("li", { role: " MenuItem " })).toBe("menuitem");
    expect(of("button", { role: "menuitem" })).toBe("menuitem");
    expect(of("a", { role: "button" })).toBe("button");
    expect(of("span", { role: "link" })).toBe("link");
    expect(of("a")).toBe("link");
    expect(of("area")).toBe("link");
    expect(of("summary")).toBe("button");
    expect(of("div", { role: "button" })).toBe("button");
  });

  test("文字：空白并成一个空格、去掉两头的，最长 200", () => {
    const nbsp = String.fromCharCode(160);
    expect(cleanElementText(`  立即\n\t 运行${nbsp} `)).toBe("立即 运行");
    expect(cleanElementText(null)).toBe("");
    expect(cleanElementText("字".repeat(300))).toHaveLength(200);
  });

  test("超过上限：屏幕上看得见的、上半屏的先列，再是下半屏的，屏幕外的按离屏幕远近；交出去的照页面上的先后", () => {
    const view = { width: 400, height: 800 };
    const at = (name: string, top: number, left = 10) => ({ item: name, rect: { left, top, right: left + 80, bottom: top + 30 } });
    const items = [at("顶上导航", -300), at("下半屏", 600), at("上半屏", 100), at("远在下面", 3000), at("刚出屏幕", 820), at("横着出去了", 100, 500)];
    expect(chooseClickables(items, view, 10)).toEqual(["顶上导航", "下半屏", "上半屏", "远在下面", "刚出屏幕", "横着出去了"]);
    expect(chooseClickables(items, view, 1)).toEqual(["上半屏"]);
    expect(chooseClickables(items, view, 2)).toEqual(["下半屏", "上半屏"]);
    expect(chooseClickables(items, view, 3)).toEqual(["下半屏", "上半屏", "刚出屏幕"]);
    // 屏幕外的按离屏幕多远（上下、左右加起来）：横着出去 100 比顶上 270 近
    expect(chooseClickables(items, view, 4)).toEqual(["下半屏", "上半屏", "刚出屏幕", "横着出去了"]);
    expect(chooseClickables(items, view, 5)).toEqual(["顶上导航", "下半屏", "上半屏", "刚出屏幕", "横着出去了"]);
    expect(chooseClickables(items, view, 0)).toEqual([]);
  });

  test("开新窗口的 target：_blank、起了名字的都算（同一标签打开）；空的、_self、_top、_parent 不算", () => {
    for (const t of ["_blank", "_BLANK", " _blank ", "preview", "_new"]) expect(opensNewWindow(t)).toBe(true);
    for (const t of ["", "  ", "_self", "_top", "_Parent", null, undefined]) expect(opensNewWindow(t)).toBe(false);
  });
});

describe("能填、能交、能选的框", () => {
  test("框的种类：textbox、upload、select 是框，能点的不是", () => {
    for (const r of ["textbox", "upload", "select"]) expect(isFieldRole(r)).toBe(true);
    for (const r of ["link", "button", "submit", "input", "tab", "menuitem", ""]) expect(isFieldRole(r)).toBe(false);
  });

  test("现在的值：空白并成一个、去掉两头的，取前 40 字；空的、只有空白的不写", () => {
    expect(previewText("  海边\n\n 黄昏  ")).toBe("海边 黄昏");
    expect(previewText("字".repeat(60))).toBe("字".repeat(40));
    for (const v of ["", "   \n", null, undefined]) expect(previewText(v)).toBeUndefined();
  });

  test("下拉框的选项：收拾空白、最长 100、空的去掉、最多 20 个", () => {
    expect(optionTexts([" 1:1 ", "", null, "3:4\n", "选".repeat(150)])).toEqual(["1:1", "3:4", "选".repeat(100)]);
    expect(optionTexts(Array.from({ length: 30 }, (_, i) => `第${i}个`))).toHaveLength(20);
  });
});

describe("长按元素的圆钮摆在哪", () => {
  const AREA = { left: 0, top: 0, right: 400, bottom: 800 };
  const SIZE = BUTTON_SIZE;

  test("图、链接：按的点右上方（手指还按着也看得见）；上面放不下放下方", () => {
    expect(placeElementButton({ x: 100, y: 300 }, undefined, AREA)).toEqual({ x: 116, y: 300 - 26 - SIZE });
    const top = placeElementButton({ x: 100, y: 20 }, undefined, AREA);
    expect(top.y).toBe(44);
  });

  test("有选区：放选区下方让开手柄（系统的工具条在选区上方）；下面放不下放到工具条上方；都放不下贴着下边", () => {
    const selection = { left: 10, top: 300, right: 200, bottom: 340 };
    expect(placeElementButton({ x: 100, y: 320 }, selection, AREA).y).toBeGreaterThanOrEqual(340 + 24);
    const low = { left: 10, top: 700, right: 200, bottom: 790 };
    const above = placeElementButton({ x: 100, y: 750 }, low, AREA);
    expect(above.y + SIZE).toBeLessThanOrEqual(700 - 60);
    const huge = { left: 0, top: 10, right: 400, bottom: 795 };
    expect(placeElementButton({ x: 100, y: 400 }, huge, AREA).y).toBe(800 - SIZE - 4);
  });

  test("左右夹在看得见的部分里（放大、输入法弹起时看得见的部分比视口小）", () => {
    expect(placeElementButton({ x: 395, y: 300 }, undefined, AREA).x).toBe(400 - SIZE - 4);
    const zoomed = { left: 100, top: 50, right: 300, bottom: 400 };
    expect(placeElementButton({ x: 50, y: 300 }, undefined, zoomed).x).toBe(104);
  });

  test("地址从哪取；说明文字收拾空白、有上限", () => {
    expect(elementSourceOf("https://a.example/b.png")).toBe("http");
    expect(elementSourceOf("HTTP://a.example/b.png")).toBe("http");
    expect(elementSourceOf("data:image/png;base64,AA")).toBe("data");
    expect(elementSourceOf("blob:https://a.example/x")).toBe("blob");
    expect(elementSourceOf("about:blank")).toBeUndefined();
    expect(elementSourceOf("")).toBeUndefined();
    expect(cleanElementLabel("  一只\n  猫 ")).toBe("一只 猫");
    expect(cleanElementLabel(null)).toBe("");
    expect(cleanElementLabel("字".repeat(400)).length).toBe(ELEMENT_LABEL_MAX);
  });
});

describe("悬浮按钮在哪：四种情况", () => {
  test("侧边栏关着：没选中在右下角，选中了贴到元素旁边；侧边栏开着：没选中不显示，选中了照样贴到元素旁边", () => {
    expect(fabSpot({ sideOpen: false, selected: false })).toBe("corner");
    expect(fabSpot({ sideOpen: false, selected: true })).toBe("anchor");
    expect(fabSpot({ sideOpen: true, selected: false })).toBe("none");
    expect(fabSpot({ sideOpen: true, selected: true })).toBe("anchor");
  });
});

describe("右下角的按钮摆在哪", () => {
  const phone = { left: 0, top: 0, right: 390, bottom: 844 };
  const corner = { x: 390 - CORNER_GAP - BUTTON_SIZE, y: 844 - CORNER_GAP - BUTTON_SIZE };

  test("离右边、底边各 16（和贴框的按钮一样大）；让开手势区；看得见的部分（输入法弹起、缩放）挪了跟着挪", () => {
    expect(CORNER_GAP).toBe(16);
    expect(placeCornerButton(phone)).toEqual(corner);
    expect(placeCornerButton(phone, 24)).toEqual({ x: corner.x, y: corner.y - 24 });
    expect(placeCornerButton({ left: 0, top: 0, right: 390, bottom: 500 })).toEqual({ x: corner.x, y: 500 - 16 - BUTTON_SIZE });
    expect(placeCornerButton({ left: 100, top: 200, right: 300, bottom: 600 })).toEqual({ x: 300 - 16 - BUTTON_SIZE, y: 600 - 16 - BUTTON_SIZE });
  });

  test("网页自己的底部栏盖住了就挪到它上面（留 8）；没盖住的不管", () => {
    const bar = { left: 0, top: 780, right: 390, bottom: 844 };
    expect(placeCornerButton(phone, 0, [bar])).toEqual({ x: corner.x, y: 780 - 8 - BUTTON_SIZE });
    const leftButton = { left: 10, top: 790, right: 60, bottom: 840 };
    expect(placeCornerButton(phone, 0, [leftButton])).toEqual(corner);
  });

  test("挪上去又碰到右下角的客服按钮：再挪到它上面", () => {
    const bar = { left: 0, top: 780, right: 390, bottom: 844 };
    const help = { left: 320, top: 700, right: 380, bottom: 760 };
    expect(placeCornerButton(phone, 0, [bar, help])).toEqual({ x: corner.x, y: 700 - 8 - BUTTON_SIZE });
  });

  test("要挪得比看得见的部分的四成还高（网页底部一大块浮层）就不挪，留在原处", () => {
    const sheet = { left: 0, top: 400, right: 390, bottom: 844 };
    expect(placeCornerButton(phone, 0, [sheet])).toEqual(corner);
  });
});

// 选中的地址用地图（447）：选中的字像不像地址、地名（拿不准也给"在地图上看""怎么去"），交给地图服务查的写法，两个小按钮摆在哪
describe("选中的字像不像地址", () => {
  test("中文门牌、路名、行政区、邮编，英文街名、州加邮编、英国和新加坡的邮编：像", () => {
    for (const text of [
      "浙江省杭州市西湖区示例路 478 号",
      "文三路478号",
      "示例弄 12 号 3 楼",
      "杭州市西湖区",
      "邮编：310012",
      "西溪湿地公园",
      "首都国际机场 T3",
      "1600 Example Street, Springfield",
      "221B Baker Street",
      "Springfield, IL 62704",
      "London SW1A 1AA",
      "1 Kadayanallur Street, Singapore 069184",
      "PO Box 123",
    ]) expect({ text, guess: guessAddress(text) }).toEqual({ text, guess: "address" });
  });

  test("短短一段拿不准（可能是地名）：也给", () => {
    for (const text of ["西湖", "Eiffel Tower", "滨海湾金沙", "Marina Bay Sands"]) {
      expect({ text, guess: guessAddress(text), offers: offersMapActions(text) }).toEqual({ text, guess: "maybe", offers: true });
    }
  });

  test("一看就不是的不给：太短、太长、网址邮箱、只有数字符号、好几句话、好几行、长长的英文句子", () => {
    for (const text of [
      "",
      "x",
      "这".repeat(121),
      "https://shop.example.cn/about",
      "www.example.com",
      "me@example.com",
      "138 0000 0000",
      "¥ 128.00",
      "12:30",
      "今天天气不错。我们去哪儿？",
      "第一行\n第二行\n第三行\n第四行",
      "This is a long sentence about something else entirely that is not an address",
    ]) expect({ text, offers: offersMapActions(text) }).toEqual({ text, offers: false });
  });

  test("交给地图服务查的写法：空白并成一个、去掉开头的说明和末尾的标点", () => {
    expect(mapQueryOf("  地址：浙江省杭州市\n西湖区示例路 478 号。 ")).toBe("浙江省杭州市 西湖区示例路 478 号");
    expect(mapQueryOf("Address: 1600 Example Street, ")).toBe("1600 Example Street");
    expect(mapQueryOf("西湖")).toBe("西湖");
    expect(mapQueryOf("地".repeat(200))).toHaveLength(120);
  });
});

/** 圆钮在 (x, y) 时它的范围 */
const chipButton = (x: number, y: number) => ({ left: x, top: y, right: x + BUTTON_SIZE, bottom: y + BUTTON_SIZE });

describe("地图那两个小按钮摆在哪", () => {
  const area = { left: 0, top: 0, right: 390, bottom: 844 };
  const size = { width: 170, height: 32 };
  test("圆钮右边、竖着居中；右边放不下放左边", () => {
    expect(placeMapChips(chipButton(40, 200), size, area)).toEqual({ x: 40 + BUTTON_SIZE + MAP_CHIPS_GAP, y: 200 + (BUTTON_SIZE - 32) / 2 });
    const right = placeMapChips(chipButton(300, 200), size, area);
    expect(right.x + size.width).toBeLessThanOrEqual(300 - MAP_CHIPS_GAP);
  });

  test("两边都放不下放圆钮下面（夹在看得见的部分里），下面也放不下放上面", () => {
    const narrow = { left: 0, top: 0, right: 240, bottom: 844 };
    expect(placeMapChips(chipButton(100, 200), size, narrow)).toEqual({ x: 240 - 170 - 4, y: 200 + BUTTON_SIZE + MAP_CHIPS_GAP });
    const low = placeMapChips(chipButton(100, 820), size, narrow);
    expect(low.y).toBe(820 - MAP_CHIPS_GAP - 32);
  });
});
