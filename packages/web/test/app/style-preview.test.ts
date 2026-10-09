// 设置里风格预览（39 号票）在浏览器里的那一半：给容器挂 shadow root、用上页面样式表复制改写出来的那份（只复制一次，
// 所有预览共用）、让预览里能拿到焦点的元素都 Tab 不到（不认 inert 的老浏览器上，预览在 aria-hidden 里，键盘却能停上去）。
// 容器、shadow root、页面样式都换成假的。
import { describe, expect, test } from "vitest";
import { FOCUSABLE, type PreviewEnv, stylePreviewsIn } from "../../src/app/style-preview.ts";
import { PREVIEW_PAGE_CLASS } from "../../src/visual-styles/index.ts";

/** 假的元素：标签名、属性 */
class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly tag: string;
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag;
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
}

/** 一条简单选择器（标签名、[属性]、标签[属性]）认不认这个元素 */
function matchesSimple(el: FakeElement, selector: string): boolean {
  const m = /^([a-z]*)(?:\[([a-z-]+)\])?$/.exec(selector.trim());
  if (!m) throw new Error(`假的 shadow root 不认识的选择器：${selector}`);
  const [, tag, attr] = m;
  return (!tag || el.tag === tag) && (!attr || el.attrs.has(attr));
}

/** 假的 shadow root：里面的元素，querySelectorAll 按逗号分开的简单选择器找 */
class FakeRoot {
  readonly elements: FakeElement[] = [];
  readonly sheets: string[] = [];
  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(",");
    return this.elements.filter((el) => parts.some((part) => matchesSimple(el, part)));
  }
}

/** 假的容器：挂过 shadow root 就记着（挂的是哪种也记着） */
class FakeHost {
  shadowRoot: FakeRoot | null = null;
  attached = 0;
  mode: string | undefined;
  attachShadow(init: { mode: "open" }) {
    this.mode = init.mode;
    this.attached++;
    this.shadowRoot = new FakeRoot();
    return this.shadowRoot;
  }
}

function setup(css = ':root[data-style="grid"] body { line-height: 1.5; } .bubble { padding: 10px; }') {
  let reads = 0;
  const env: PreviewEnv<FakeRoot> = {
    pageCss: () => {
      reads++;
      return css;
    },
    adopt: (root, text) => void root.sheets.push(text),
  };
  return { previews: stylePreviewsIn(env), reads: () => reads };
}

describe("挂 shadow root、用上复制的样式表", () => {
  test("用上的是改写过的那份：风格规则开头换成 :host(...)，挂在 body 上的换到场景最外层", () => {
    const { previews } = setup();
    const host = new FakeHost();
    const root = previews.open(host)!;
    expect(root.sheets).toEqual([`:host([data-style="grid"]) .${PREVIEW_PAGE_CLASS} { line-height: 1.5; } .bubble { padding: 10px; }`]);
  });

  test("页面样式表只复制、改写一次，所有预览共用", () => {
    const { previews, reads } = setup();
    const roots = [new FakeHost(), new FakeHost(), new FakeHost()].map((h) => previews.open(h)!);
    expect(reads()).toBe(1);
    expect(roots.map((r) => r.sheets.length)).toEqual([1, 1, 1]);
  });

  test("挂过的容器再打开：用原来的 shadow root，不再挂、不再加样式表（开发时 React 的严格模式会跑两遍）", () => {
    const { previews } = setup();
    const host = new FakeHost();
    const first = previews.open(host);
    expect(previews.open(host)).toBe(first);
    expect(host.attached).toBe(1);
    expect(host.mode).toBe("open");
    expect(first!.sheets).toHaveLength(1);
  });

  test("浏览器不支持 shadow root：预览空着", () => {
    const { previews, reads } = setup();
    expect(previews.open({ shadowRoot: null })).toBeUndefined();
    expect(reads()).toBe(0);
  });
});

describe("预览里的东西 Tab 不到", () => {
  test("能拿到焦点的元素都挂 tabindex=-1：按钮、链接、输入框、自带 tabindex 的……", () => {
    const { previews } = setup();
    const root = previews.open(new FakeHost())!;
    const focusable = [
      new FakeElement("button"),
      new FakeElement("a", { href: "#" }),
      new FakeElement("input"),
      new FakeElement("select"),
      new FakeElement("textarea"),
      new FakeElement("summary"),
      new FakeElement("span", { tabindex: "0" }),
      new FakeElement("div", { contenteditable: "" }),
    ];
    const plain = [new FakeElement("div"), new FakeElement("span"), new FakeElement("a"), new FakeElement("i")];
    root.elements.push(...focusable, ...plain);
    previews.unfocus(root);
    expect(focusable.map((el) => `${el.tag} ${el.attrs.get("tabindex")}`)).toEqual(focusable.map((el) => `${el.tag} -1`));
    expect(plain.filter((el) => el.attrs.has("tabindex"))).toEqual([]);
  });

  test("认的元素种类：链接只算带 href 的，媒体只算带控件的", () => {
    expect(FOCUSABLE.split(",").map((s) => s.trim())).toEqual([
      "a[href]",
      "area[href]",
      "button",
      "input",
      "select",
      "textarea",
      "iframe",
      "summary",
      "audio[controls]",
      "video[controls]",
      "[tabindex]",
      "[contenteditable]",
    ]);
  });
});
