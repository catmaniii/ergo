// 界面字号在真页面上（验收）：照 vite.config.ts 按生产环境构建一遍演示页，存成临时文件，用 file:// 在真 Chrome 里打开
// （不经守护进程，前端走原型的假数据）。手机（390×844）和折叠屏展开（720×1024）两个视口，比例取 0.85、1、1.25、1.5：
// 1. 十一套风格每套都跑一遍：没有横向滚动、没有伸出屏幕的东西、没有新截掉的内容（和同一套风格、同一页在 1 下比；
//    单行省略号、多行截断是有意的，不算）。最长的标题、最长的附件名各塞一次再量；
// 2. 标题栏：1.5 和 1 的差不超过 12px；1 下不到 56px 的，1.5 也不超过 56px；
// 3. 消息列表占可视高度：1 下不低于 78% 的，1.5 下不低于 75%（量出来的数打在输出里，写进票的 Comments）；
// 4. 可点的元素：1 下宽、高够 40 的，0.85 下还够 40（本来就不到 40 的打在输出里，不在这票改）；
// 5. 手机上调到 1.25，换到中屏用中屏自己那份，折回来还是 1.25；
// 6. 重开页面后保持。
// 本机没有 Chrome（或 Edge）时跳过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { VISUAL_STYLES } from "../src/visual-styles/index.ts";
import { findChrome } from "../build/chrome.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 720, height: 1024 },
] as const;
const SCALES = [1, 0.85, 1.25, 1.5] as const;
/** 量的几页：秘书会话（气泡、附件、输入框上面的条）、任务的会话（两行的标题栏、阶段条）、待办列表、设置 · 外观与风格（字号那一节） */
const PAGES = ["#/secretary", "#/tasks/t-photos", "#/inbox", "#/more/appearance"] as const;
/** 塞进去的最长的标题、最长的附件名 */
const LONG_TITLE = "把家里这些年所有的旧手机照片、微信聊天里的图片和网盘相册全部整理去重之后按年份和事件归档并写一份说明";
const LONG_FILE = "二〇二六年第三季度家庭开支明细和各项保险续费提醒以及孩子学校活动安排的汇总表格最终版本-已核对.xlsx";

let browser: Browser | undefined;
let pageUrl = "";
let tempDir = "";

async function buildPage(): Promise<string> {
  const result = await build({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, logLevel: "silent", mode: "demo", build: { write: false } });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const page = outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html");
  if (page?.type !== "asset") throw new Error("构建产物里没有 index.html");
  return String(page.source);
}

beforeAll(async () => {
  if (!CHROME) return;
  // 和 npm run build:demo 一样按生产环境构建（vitest 把 NODE_ENV 设成了 test，Vite 会照它打开发版）
  vi.stubEnv("NODE_ENV", "production");
  let html: string;
  try {
    html = await buildPage();
  } finally {
    vi.unstubAllEnvs();
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-font-scale-"));
  const file = path.join(tempDir, "index.html");
  fs.writeFileSync(file, html);
  pageUrl = pathToFileURL(file).href;
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}, 60_000);

/** 一页量出来的东西 */
interface Measure {
  /** 标题栏的高（看得见的第一个） */
  topbar: number | null;
  /** 消息列表占可视高度的百分比（没有会话的页是 null） */
  list: number | null;
  /** 整页能横着滚 */
  hscroll: boolean;
  /** 伸出屏幕、又没有被哪一层裁住的元素 */
  off: string[];
  /** 截掉了内容的元素（单行省略号、多行截断这类有意的不算） */
  trunc: string[];
  /** 看得见的可点的元素：名字 → [宽, 高] */
  clickables: [string, number, number][];
}

/** 在页面里量（字符串，交给 page.evaluate） */
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 看得见：有大小、没藏、自己和上面几层都不是全透明（会话缩放的要点层在对话层是透明的）
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
    }
    return true;
  };
  const name = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).join(".") : "");
  // 有意裁的：读屏用的隐藏字、会话的滚动范围（zoom.css 的 .zh-sizer）、语音条放不下时截掉尾巴的波形（voice.css）
  const designed = (el) => el.closest(".sr-only, .zh-sizer > *, .voice-wave-mini") !== null || el.matches(".sr-only, .zh-sizer, .voice-wave-mini");
  // 真被裁掉的：box 里有看得见的东西（元素或一段字）伸出它的边，中间没有别的一层先裁住（看不见的东西伸出去不算，
  // 比如对话层时透明的缩放图例）
  const sticksOut = (box, axis) => {
    const b = box.getBoundingClientRect();
    const out = (r) => (axis === "x" ? r.right > b.right + 1 || r.left < b.left - 1 : r.bottom > b.bottom + 1 || r.top < b.top - 1);
    const innerClip = (from) => {
      for (let p = from; p && p !== box; p = p.parentElement) if ((axis === "x" ? getComputedStyle(p).overflowX : getComputedStyle(p).overflowY) !== "visible") return true;
      return false;
    };
    for (const el of box.querySelectorAll("*")) if (out(el.getBoundingClientRect()) && seen(el) && !innerClip(el.parentElement)) return true;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent.trim() || !seen(t.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      if ([...range.getClientRects()].some(out) && !innerClip(t.parentElement === box ? null : t.parentElement)) return true;
    }
    return false;
  };
  const off = [];
  const trunc = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!seen(el) || designed(el)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.position !== "fixed" && (r.right > vw + 1 || r.left < -1)) {
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX !== "visible" || pcs.transform !== "none" || pcs.position === "fixed") { clipped = true; break; }
      }
      if (!clipped) off.push(name(el));
    }
    const ellipsis = cs.textOverflow === "ellipsis";
    if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && el.scrollWidth > el.clientWidth + 1 && !ellipsis && sticksOut(el, "x")) trunc.push("横 " + name(el));
    if ((cs.overflowY === "hidden" || cs.overflowY === "clip") && el.scrollHeight > el.clientHeight + 1 && cs.webkitLineClamp === "none" && !(ellipsis && cs.whiteSpace === "nowrap") && sticksOut(el, "y")) trunc.push("竖 " + name(el));
  }
  const clickables = [];
  const counts = new Map();
  for (const el of document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=radio], [role=switch], input:not([type=hidden]), select, textarea, summary")) {
    if (!seen(el) || el.closest("[inert], [aria-hidden=true]")) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    const base = name(el) + " " + ((el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 16));
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    clickables.push([base + " #" + n, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]);
  }
  const top = [...document.querySelectorAll(".topbar")].find(seen);
  const list = [...document.querySelectorAll(".zh-viewport")].find(seen);
  return {
    topbar: top ? Math.round(top.getBoundingClientRect().height * 10) / 10 : null,
    list: list ? Math.round((list.getBoundingClientRect().height / vh) * 1000) / 10 : null,
    hscroll: document.scrollingElement.scrollWidth > vw,
    off: [...new Set(off)],
    trunc: [...new Set(trunc)],
    clickables,
  };
})()`;

/**
 * 塞最长的标题（标题栏里标题那一格的第一段字：秘书页是"个人秘书："，任务会话是任务名）、最长的附件名（附件卡上的文件名，
 * 序号除外）。给回塞了几处：标题 0 或 1，附件名几张卡
 */
const STUFF_LONG = `((title, file) => {
  const firstText = (root, skip) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && !(skip && n.parentElement.closest(skip)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    return walker.nextNode();
  };
  const node = [...document.querySelectorAll(".topbar .title")]
    .filter((el) => el.closest(".topbar").getBoundingClientRect().width > 0)
    .map((el) => firstText(el, ".title-sub"))
    .find((n) => n);
  if (node) node.textContent = title;
  let files = 0;
  for (const a of document.querySelectorAll(".att-title")) {
    const text = firstText(a, ".att-seq");
    if (text) {
      text.textContent = file;
      files++;
    }
  }
  return [node ? 1 : 0, files];
})`;

/** 开一个窗口，按这套风格、这个比例（每种形态都记成它）打开，返回量页面的函数 */
async function openAt(viewport: { width: number; height: number }, style: string, scale: number): Promise<{ page: Page; errors: string[]; close(): Promise<void> }> {
  const context = await browser!.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`没接住的错误：${String(e)}`));
  await page.goto(pageUrl);
  await page.evaluate(
    ([s, k]) => {
      localStorage.clear();
      localStorage.setItem("ergo-style", s as string);
      for (const form of ["narrow", "medium", "wide"]) if (k !== 1) localStorage.setItem(`ergo-font-scale-${form}`, String(k));
    },
    [style, scale] as const,
  );
  await page.reload();
  await page.waitForTimeout(500);
  return { page, errors, close: () => context.close() };
}

/** 量一页；long 时先塞最长的标题、附件名（塞了几处记在 stuffed 里：标题、附件名） */
async function measureAt(page: Page, hash: string, long = false): Promise<Measure & { stuffed?: [number, number] }> {
  await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
  await page.waitForTimeout(450);
  let stuffed: [number, number] | undefined;
  if (long) {
    // 机器忙时这一页可能还没画完：塞不进去就等一下再塞，最多两秒
    for (let i = 0; i < 10; i++) {
      stuffed = (await page.evaluate(`${STUFF_LONG}(${JSON.stringify(LONG_TITLE)}, ${JSON.stringify(LONG_FILE)})`)) as [number, number];
      if (stuffed[0] === 1 && (hash !== "#/secretary" || stuffed[1] > 0)) break;
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(100);
  }
  return { ...((await page.evaluate(MEASURE)) as Measure), ...(stuffed ? { stuffed } : {}) };
}

/** 量出来要写进票的数 */
const report: string[] = [];

describe.skipIf(!CHROME)("界面字号（真页面）", () => {
  afterAll(() => {
    if (report.length) console.log(`\n界面字号量出来的数：\n${report.join("\n")}`);
  });

  for (const style of VISUAL_STYLES.map((s) => s.id)) {
    test(`${style}：两个视口 × 0.85 / 1 / 1.25 / 1.5，不横滚、不伸出屏幕、不新截内容；标题栏、消息列表、点击区照规矩`, async () => {
      const problems: string[] = [];
      for (const viewport of VIEWPORTS) {
        const at = new Map<string, Measure & { stuffed?: [number, number] }>();
        for (const scale of SCALES) {
          const { page, errors, close } = await openAt(viewport, style, scale);
          for (const hash of PAGES) at.set(`${scale} ${hash}`, await measureAt(page, hash));
          for (const hash of ["#/secretary", "#/tasks/t-photos"]) at.set(`${scale} ${hash} 长`, await measureAt(page, hash, true));
          await close();
          problems.push(...errors.map((e) => `${viewport.width} ${scale}：${e}`));
        }
        const vw = viewport.width;
        // 最长的标题两页都塞进去了，附件名秘书会话里至少一张卡
        for (const scale of SCALES) {
          const titles = ["#/secretary", "#/tasks/t-photos"].map((hash) => at.get(`${scale} ${hash} 长`)!.stuffed?.[0]);
          const files = at.get(`${scale} #/secretary 长`)!.stuffed?.[1] ?? 0;
          if (titles.some((n) => n !== 1) || files < 1) problems.push(`${vw} ${scale}：最长的标题、附件名没塞进去（标题 ${titles.join("、")}，附件 ${files}）`);
        }
        for (const [key, m] of at) {
          const [scale, ...rest] = key.split(" ");
          const where = `${vw} ${style} ${scale} ${rest.join(" ")}`;
          if (m.hscroll) problems.push(`${where}：能横着滚`);
          if (m.off.length) problems.push(`${where}：伸出屏幕 ${m.off.join("、")}`);
          if (scale === "1") continue;
          const base = at.get(`1 ${rest.join(" ")}`)!;
          const cut = m.trunc.filter((x) => !base.trunc.includes(x));
          if (cut.length) problems.push(`${where}：新截掉了内容 ${cut.join("、")}`);
        }
        // 2. 标题栏
        for (const hash of PAGES) {
          const one = at.get(`1 ${hash}`)!.topbar;
          const big = at.get(`1.5 ${hash}`)!.topbar;
          if (one === null || big === null) continue;
          if (big - one > 12) problems.push(`${vw} ${hash}：标题栏 1 下 ${one}、1.5 下 ${big}，多了 ${big - one}px`);
          if (one <= 56 && big > 56) problems.push(`${vw} ${hash}：标题栏 1.5 下 ${big}px，超过 56px`);
          report.push(`标题栏 ${vw} ${style} ${hash}：1 下 ${one}，1.5 下 ${big}`);
        }
        // 3. 消息列表占可视高度
        for (const hash of ["#/secretary", "#/tasks/t-photos"]) {
          const one = at.get(`1 ${hash}`)!.list;
          const big = at.get(`1.5 ${hash}`)!.list;
          if (one === null || big === null) {
            problems.push(`${vw} ${hash}：没找到消息列表`);
            continue;
          }
          report.push(`消息列表 ${vw} ${style} ${hash}：1 下 ${one}%，1.5 下 ${big}%${one < 78 ? "（1 下就不到 78%，不在这票改布局）" : ""}`);
          if (one >= 78 && big < 75) problems.push(`${vw} ${hash}：消息列表 1.5 下只占 ${big}%`);
        }
        // 4. 可点的元素
        for (const hash of PAGES) {
          const one = new Map(at.get(`1 ${hash}`)!.clickables.map(([k, w, h]) => [k, [w, h] as const]));
          const small = at.get(`0.85 ${hash}`)!.clickables;
          const under: string[] = [];
          for (const [k, w, h] of small) {
            const before = one.get(k);
            if (!before) continue;
            if ((before[0] >= 40 && w < 40) || (before[1] >= 40 && h < 40)) problems.push(`${vw} ${hash}：${k} 1 下 ${before[0]}×${before[1]}，0.85 下 ${w}×${h}，不到 40`);
            if (before[0] < 40 || before[1] < 40) under.push(`${k.replace(/ #\d+$/, "")} ${before[0]}×${before[1]}`);
          }
          if (style === "classic" && under.length) report.push(`本来就不到 40 的点击区 ${vw} ${hash}（${under.length} 个）：${[...new Set(under)].join("；")}`);
        }
      }
      expect(problems).toEqual([]);
    }, 240_000);
  }

  test("手机上调到 1.25（设置里的滑杆），换到中屏用中屏自己那份，折回来还是 1.25；重开页面后保持", async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${pageUrl}#/more/appearance`);
    await page.evaluate("localStorage.clear()");
    await page.reload();
    const root = () => page.evaluate(`[document.documentElement.style.getPropertyValue("--fs-k"), document.documentElement.getAttribute("data-font-scale")]`);
    const body = () => page.evaluate(`parseFloat(getComputedStyle(document.querySelector(".font-scale-preview p")).fontSize)`);
    await page.locator(".font-scale-slider input").waitFor();
    expect(await root()).toEqual(["", null]);
    expect(await body()).toBe(15);
    await page.locator(".font-scale-slider input").fill("1.25");
    expect(await root()).toEqual(["1.25", "up"]);
    expect(await body()).toBe(18.75);
    expect(await page.locator(".font-scale-value").innerText()).toBe("125%");
    // 预设：点"大"是 1.15，选中它；再拖回 1.25 就哪个预设都不是
    await page.getByRole("radio", { name: "大", exact: true }).click();
    expect(await root()).toEqual(["1.15", "up"]);
    expect(await page.getByRole("radio", { name: "大", exact: true }).getAttribute("aria-checked")).toBe("true");
    await page.locator(".font-scale-slider input").fill("1.25");
    expect(await page.locator('.font-scale [role="radio"][aria-checked="true"]').count()).toBe(0);
    // 展开成中屏：中屏没调过，是 1
    await page.setViewportSize({ width: 720, height: 1024 });
    await page.waitForTimeout(200);
    expect(await root()).toEqual(["", null]);
    expect(await body()).toBe(15);
    expect(await page.locator(".font-scale .muted").first().innerText()).toContain("只记在这台设备的折叠屏展开宽度上");
    await page.locator(".font-scale-slider input").fill("0.9");
    expect(await root()).toEqual(["0.9", "down"]);
    // 折回手机：还是 1.25
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    expect(await root()).toEqual(["1.25", "up"]);
    // 重开页面：内联脚本在页面脚本之前就写好了
    await page.reload();
    expect(await root()).toEqual(["1.25", "up"]);
    expect(await body()).toBe(18.75);
    await page.setViewportSize({ width: 720, height: 1024 });
    await page.reload();
    expect(await root()).toEqual(["0.9", "down"]);
    expect(await page.evaluate(`[localStorage.getItem("ergo-font-scale-narrow"), localStorage.getItem("ergo-font-scale-medium"), localStorage.getItem("ergo-font-scale-wide")]`)).toEqual(["1.25", "0.9", null]);
    await context.close();
    expect(errors).toEqual([]);
  }, 60_000);

  test("调回标准（1）：根元素上什么都不留，和没有这个功能时一样", async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${pageUrl}#/more/appearance`);
    await page.evaluate(`localStorage.setItem("ergo-font-scale-narrow", "1.3")`);
    await page.reload();
    await page.getByRole("radio", { name: "标准", exact: true }).click();
    expect(await page.evaluate(`[document.documentElement.style.length, document.documentElement.getAttribute("data-font-scale"), localStorage.getItem("ergo-font-scale-narrow")]`)).toEqual([0, null, null]);
    await context.close();
  }, 60_000);
});
