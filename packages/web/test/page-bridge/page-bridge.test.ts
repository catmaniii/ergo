// 页面桥（134 号票第二部分，src/page-bridge/）：打包成注入用的那一段脚本（build/page-bridge.ts），在真的 Chrome 里跑——
// 和 ArkWeb 的 javaScriptOnDocumentStart 一样在网页的脚本之前注入，宿主的 post 换成记下来的假的。查：
// - 列框：文本框、多行文本、可编辑区域、藏在 label 和拖放区后面的选文件的框，带标签文字；密码、验证码、银行卡、禁用的、看不见的不列；
// - 口令不对什么都不做；入口改不了、删不掉；网页的脚本拿不到按钮（封闭的 shadow root），派的假事件不算；
// - 框获得焦点出悬浮按钮（报 field），点一下报 open、长按报 voice（press、start、stop），都带页面信息和框的列表，地址去掉查询串；
// - 填字：普通的框、React 受控的框（React 的 state 跟着变）、可编辑区域，都触发 input；密码框不碰；不替用户提交；
// - 交文件：分段交来的字节拼成文件设进选文件的框、触发 change；只要一个的只交第一个；网站的脚本调 input.click() 时报 chooser-field；
// - 气泡（146 号票，窄屏 390）：点按钮气泡在按钮旁边出来、打字框聚焦，点发送报 bubble send，网页收不到气泡里的按键；宿主交来的
//   在想、回话画出来（字就是字）；点外面收起；长按出波形和秒数、竖条跟着宿主交来的音量变、上滑变红松手取消；放在按钮背离框的那一边、
//   不盖框（放不下越过框）、左右不出屏幕、框被用户滚出屏幕收起；输入法弹起挡住框时把框滚回来；网页的样式影响不到；不知道哪个框时
//   放在下面居中；
// - 149 号票：发送、长按、选中都带着框里那一刻的内容（普通的框、React 受控的框、可编辑区域；太长截掉写明一共多少字；上传框没有；
//   密码框选不中、不读）；按住说话的波形在按钮上方（按钮贴着顶时放到旁边），不在下方；挑图片窗口固定在屏幕上（手机贴底占满宽、
//   宽屏底部居中最宽 520，网页滚动它不动），缩略图画进 canvas、横排、单选多选、交、都不要、× 收起，报 pick。
//   封闭的 shadow root 网页的脚本拿不到，测试在页面桥注入之前换掉 attachShadow 记下它（网页自己的脚本在页面桥之后才跑，做不到这一步）。
// - 181 号票：气泡的标题、"二狗在想……"、"让二狗选"、挑图片窗口的标题里的名字是名字标签（span.name，底色、字色是交来的，浅色深色
//   各一对；没交来是「二狗」、经典的颜色）；名字里有 <b> 也只是字；读屏说明是纯名字；开着的气泡、窗口跟着改名字、换颜色。
// 本机没有 Chrome（或 Edge）时跳过。页面桥用到的 DOM 全是浏览器自己的，所以不用 jsdom 这类模拟（仓库不加依赖）。
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import EN_BRIDGE from "../../../protocol/locales/en/bridge.json" with { type: "json" };
import ZH_BRIDGE from "../../../protocol/locales/zh-CN/bridge.json" with { type: "json" };
import { buildPageBridge, NONCE_MARK } from "../../build/page-bridge.ts";
import { findChrome } from "../../build/chrome.ts";

const NONCE = "0123456789abcdef0123456789abcdef";

const CHROME = findChrome();

/** 测试页：各种框，一个 React 受控的框（react-form.ts 打包进来），一个表单 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>相册 · 上传</title></head><body style="margin:0;font:16px sans-serif">
<form id="f" onsubmit="window.plainSubmitted = (window.plainSubmitted || 0) + 1; return false;" style="width:300px;padding:10px">
  <label for="title">标题：</label><input id="title" name="title" placeholder="给照片起个名字">
  <textarea id="note" aria-label="说明" style="display:block;width:280px"></textarea>
  <div id="editor" contenteditable="true" aria-label="正文" style="min-height:40px;border:1px solid #ccc"><p>旧的</p></div>
  <input id="pwd" type="password" placeholder="登录密码">
  <input id="code" name="sms_code" placeholder="短信验证码">
  <input id="card" autocomplete="cc-number" placeholder="卡号">
  <input id="off" disabled placeholder="禁用的">
  <input id="hidden-text" type="hidden" value="x">
  <input type="checkbox" id="agree">
  <label id="upload-label" for="photos" style="display:inline-block;padding:20px;border:2px dashed #999">上传照片</label>
  <input id="photos" type="file" accept="image/*" multiple style="display:none">
  <div id="zone" style="padding:20px;border:2px dashed #999">拖到这里<input id="one" type="file" style="display:none"></div>
  <button type="submit" id="submit">提交</button>
</form>
<div id="react-root"></div>
<script>window.submitted = 0; window.addEventListener("react-submitted", () => window.submitted++);</script>
<script>window.events = []; for (const id of ["title", "note", "editor", "photos", "one"]) for (const t of ["input", "change"]) document.getElementById(id).addEventListener(t, () => window.events.push(id + ":" + t));</script>
<script>__REACT__</script>
</body></html>`;

let browser: Browser | undefined;
let bridge = "";
let react = "";

async function bundleReact(): Promise<string> {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL("./react-form.ts", import.meta.url)), formats: ["iife"], name: "reactForm", fileName: () => "react-form.js" } },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunk = outputs.flatMap((o) => o.output).find((f) => f.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("React 的测试页没打包出来");
  return chunk.code;
}

beforeAll(async () => {
  if (!CHROME) return;
  bridge = (await buildPageBridge()).replace(NONCE_MARK, NONCE);
  react = await bundleReact();
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

// 关 Chrome 在机器忙（几个工作槽同时跑全量）时会超过默认的 10 秒，测试本身全过却挂在收尾上
afterAll(async () => {
  await browser?.close();
}, 60_000);

/** 开一页测试页：先挂假的宿主（记下 post 来的），再注入页面桥（都在网页的脚本之前）；peek：记下页面桥的 shadow root（测试看气泡用） */
async function open(options: { width?: number; height?: number; peek?: boolean } = {}): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: options.width ?? 800, height: options.height ?? 900 } });
  if (options.peek) {
    await page.addInitScript(() => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
        const root = attach.call(this, init);
        (window as unknown as { peekRoot: ShadowRoot }).peekRoot = root;
        return root;
      };
    });
  }
  await page.addInitScript(() => {
    const posted: string[] = [];
    (window as unknown as { posted: string[] }).posted = posted;
    (window as unknown as { ergoPageHost: { post(json: string): void } }).ergoPageHost = { post: (json: string) => void posted.push(json) };
  });
  await page.addInitScript({ content: bridge });
  await page.route("https://album.example.cn/**", (route) => route.fulfill({ contentType: "text/html", body: PAGE.replace("__REACT__", () => react) }));
  await page.goto("https://album.example.cn/upload?session=secret#top");
  await page.waitForSelector("#react-title");
  return page;
}

/** 页面桥报过的话（去掉口令后的） */
async function postedOf(page: Page): Promise<Array<Record<string, unknown>>> {
  const raw = await page.evaluate(() => (window as unknown as { posted: string[] }).posted);
  return raw.map((json) => JSON.parse(json) as Record<string, unknown>);
}

const call = (page: Page, method: string, ...args: string[]) => page.evaluate(({ name, params }) => (window as unknown as { __ergoPage: Record<string, (...a: string[]) => string> }).__ergoPage[name]!(...params), { name: method, params: args });
const callJson = async (page: Page, method: string, ...args: string[]) => JSON.parse(await call(page, method, NONCE, ...args)) as Record<string, unknown>;

/** 某个框的编号（fields 列出来的） */
async function idOf(page: Page, label: string): Promise<string> {
  const { fields } = (await callJson(page, "fields")) as { fields: Array<{ id: string; label: string }> };
  const field = fields.find((f) => f.label === label);
  if (!field) throw new Error(`没有「${label}」这个框：${JSON.stringify(fields)}`);
  return field.id;
}

describe.skipIf(!CHROME)("页面桥（在真的 Chrome 里）", () => {
  test("列出能填的框：文本框、多行、可编辑区域、藏起来的选文件的框（标签取上传按钮上的字）；密码、验证码、卡号、禁用、隐藏、勾选框不列；地址去掉查询串", async () => {
    const page = await open();
    const { page: info, fields } = (await callJson(page, "fields")) as { page: unknown; fields: Array<Record<string, unknown>> };
    expect(info).toEqual({ title: "相册 · 上传", url: "https://album.example.cn/upload" });
    expect(fields.map((f) => [f.kind, f.label])).toEqual([
      ["text", "标题"],
      ["textarea", "说明"],
      ["editable", "正文"],
      ["file", "上传照片"],
      ["file", "拖到这里"],
      ["text", "React 标题"],
    ]);
    expect(fields[0]).toMatchObject({ id: expect.stringMatching(/^f\d+$/), placeholder: "给照片起个名字" });
    expect(fields[3]).toMatchObject({ accept: "image/*", multiple: true });
    // 同一个元素一直是同一个号
    expect(((await callJson(page, "fields")) as { fields: Array<{ id: string }> }).fields.map((f) => f.id)).toEqual(fields.map((f) => f.id));
    await page.close();
  });

  test("口令不对什么都不做；入口改不了、删不掉；按钮在封闭的 shadow root 里，网页的脚本摸不到", async () => {
    const page = await open();
    expect(await call(page, "fields", "wrong")).toBe("");
    expect(await call(page, "fill", "wrong", "f1", "x")).toBe("");
    // 按钮挂上来（框获得焦点时）之后再看
    await page.click("#title");
    const tampered = await page.evaluate(() => {
      const w = window as unknown as { __ergoPage: unknown };
      const before = w.__ergoPage;
      try {
        w.__ergoPage = { fields: () => "fake" };
      } catch {
        // 严格模式下抛错也算改不了
      }
      try {
        delete (w as { __ergoPage?: unknown }).__ergoPage;
      } catch {
        // 同上
      }
      const host = Array.from(document.documentElement.children).find((el) => el.tagName === "DIV");
      return { same: w.__ergoPage === before, shadow: host ? host.shadowRoot : "no-host" };
    });
    expect(tampered.same).toBe(true);
    expect(tampered.shadow).toBe(null);
    await page.close();
  });

  test("框获得焦点出悬浮按钮（报 field）；网页的脚本派的假焦点事件不算；密码框不出", async () => {
    const page = await open();
    await page.evaluate(() => document.getElementById("note")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    await page.click("#pwd");
    await page.waitForTimeout(250);
    expect((await postedOf(page)).filter((m) => m.type === "field" && m.field !== null)).toEqual([]);
    await page.click("#title");
    await page.waitForTimeout(100);
    const shown = (await postedOf(page)).filter((m) => m.type === "field");
    expect(shown.at(-1)).toMatchObject({ nonce: NONCE, field: { kind: "text", label: "标题" } });
    await page.close();
  });

  test("点一下悬浮按钮报 open（焦点进到气泡里的打字框），长按报 voice 的 press、start、stop；都带页面信息和框的列表", async () => {
    const page = await open();
    await page.click("#title");
    const box = (await page.locator("#title").boundingBox())!;
    // 宽屏下按钮在框的右边、竖着居中（rules.ts 的 placeButton）
    const x = box.x + box.width + 6 + 18;
    const y = box.y + box.height / 2;
    await page.waitForTimeout(100);
    await page.mouse.click(x, y);
    // 焦点进了页面桥自己的 shadow root（气泡里的打字框），外面看到的是页面桥挂的那个元素
    expect(await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.id])).toEqual(["DIV", ""]);
    let messages = await postedOf(page);
    expect(messages.find((m) => m.type === "open")).toMatchObject({ field: { label: "标题" }, page: { url: "https://album.example.cn/upload" }, fields: expect.arrayContaining([expect.objectContaining({ label: "说明" })]) });

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    messages = await postedOf(page);
    expect(messages.filter((m) => m.type === "voice").map((m) => m.phase)).toEqual(["press", "press", "start", "stop"]);
    await page.close();
  });

  test("填字：普通的框、React 受控的框（state 跟着变）、多行、可编辑区域都填上并触发 input；不替用户提交", async () => {
    const page = await open();
    expect(await callJson(page, "fill", await idOf(page, "标题"), "周末杭州游记")).toEqual({ ok: true });
    expect(await callJson(page, "fill", await idOf(page, "说明"), "西湖边走了一圈")).toEqual({ ok: true });
    expect(await callJson(page, "fill", await idOf(page, "正文"), "第一天")).toEqual({ ok: true });
    expect(await callJson(page, "fill", await idOf(page, "React 标题"), "React 也认")).toEqual({ ok: true });
    const state = await page.evaluate(() => ({
      title: (document.getElementById("title") as HTMLInputElement).value,
      note: (document.getElementById("note") as HTMLTextAreaElement).value,
      editor: document.getElementById("editor")!.textContent,
      react: document.getElementById("react-state")!.textContent,
      events: (window as unknown as { events: string[] }).events,
      submitted: (window as unknown as { submitted: number; plainSubmitted?: number }).submitted + ((window as unknown as { plainSubmitted?: number }).plainSubmitted ?? 0),
    }));
    expect(state).toMatchObject({ title: "周末杭州游记", note: "西湖边走了一圈", editor: "第一天", react: "React 也认", submitted: 0 });
    expect(state.events).toEqual(expect.arrayContaining(["title:input", "title:change", "note:input", "note:change", "editor:input"]));
    // 选文件的框不能填字；页面上没有的号不认
    expect(await callJson(page, "fill", await idOf(page, "上传照片"), "x")).toMatchObject({ ok: false });
    expect(await callJson(page, "fill", "f999", "x")).toMatchObject({ ok: false });
    expect(await page.evaluate(() => (document.getElementById("pwd") as HTMLInputElement).value)).toBe("");
    await page.close();
  });

  test("交文件：分段交来的字节拼成文件，设进选文件的框、触发 change；只要一个的只交第一个", async () => {
    const page = await open();
    for (const [id, name] of [
      ["a", "西湖.jpg"],
      ["b", "断桥.jpg"],
    ] as const) {
      expect(await callJson(page, "fileBegin", id, name, "image/jpeg")).toEqual({ ok: true });
      expect(await callJson(page, "fileChunk", id, b64(`${name}-1`))).toEqual({ ok: true });
      expect(await callJson(page, "fileChunk", id, b64("-2"))).toEqual({ ok: true });
    }
    expect(await callJson(page, "attachFiles", await idOf(page, "上传照片"), JSON.stringify(["a", "b"]))).toEqual({ ok: true, count: 2 });
    const photos = await page.evaluate(async () => {
      const input = document.getElementById("photos") as HTMLInputElement;
      return Promise.all(Array.from(input.files ?? []).map(async (f) => [f.name, f.type, await f.text()]));
    });
    expect(photos).toEqual([
      ["西湖.jpg", "image/jpeg", "西湖.jpg-1-2"],
      ["断桥.jpg", "image/jpeg", "断桥.jpg-1-2"],
    ]);
    for (const id of ["c", "d"]) {
      await callJson(page, "fileBegin", id, `${id}.pdf`, "application/pdf");
      await callJson(page, "fileChunk", id, b64(id));
    }
    expect(await callJson(page, "attachFiles", await idOf(page, "拖到这里"), JSON.stringify(["c", "d"]))).toEqual({ ok: true, count: 1 });
    const events = await page.evaluate(() => (window as unknown as { events: string[] }).events);
    expect(events).toEqual(expect.arrayContaining(["photos:input", "photos:change", "one:change"]));
    await page.close();
  });

  test("点上传处出悬浮按钮（挂在网站画的上传按钮上）；网站的脚本调 input.click() 时报 chooser-field", async () => {
    const page = await open();
    await page.mouse.click(...(await center(page, "#upload-label")));
    await page.waitForTimeout(100);
    expect((await postedOf(page)).filter((m) => m.type === "field").at(-1)).toMatchObject({ field: { kind: "file", label: "上传照片" } });
    await page.evaluate(() => document.getElementById("one")!.click());
    expect((await postedOf(page)).filter((m) => m.type === "chooser-field").at(-1)).toMatchObject({ field: { kind: "file", label: "拖到这里" } });
    await page.close();
  });
});

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe.skipIf(!CHROME)("页面桥认上传处不认过头", () => {
  test("一块里既有文本框又有藏起来的选文件的框：点这块的空白处不算点了上传，这个选文件的框也不列（找不到露在外面的上传处）", async () => {
    const page = await open();
    await page.evaluate(() => {
      const block = document.createElement("div");
      block.innerHTML = '<input id="nm" placeholder="姓名"><p id="blank" style="height:40px">空白</p><input type="file" id="solo" style="display:none">';
      document.body.appendChild(block);
    });
    await page.mouse.click(...(await center(page, "#blank")));
    await page.waitForTimeout(100);
    expect((await postedOf(page)).filter((m) => m.type === "field" && m.field !== null)).toEqual([]);
    const { fields } = (await callJson(page, "fields")) as { fields: Array<{ label: string; placeholder?: string }> };
    expect(fields.map((f) => f.label || f.placeholder)).toEqual(["标题", "说明", "正文", "上传照片", "拖到这里", "React 标题", "姓名"]);
    await page.close();
  });
});

async function center(page: Page, selector: string): Promise<[number, number]> {
  const box = (await page.locator(selector).boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
}

// ---------- 悬浮按钮旁边的气泡（146 号票） ----------

type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };

/** 页面桥 shadow root 里某个元素的位置（open 带 peek 才看得到） */
async function rectIn(page: Page, selector: string, index = 0): Promise<Box> {
  const box = await page.evaluate(
    ({ sel, i }) => {
      const el = (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelectorAll(sel)[i];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    },
    { sel: selector, i: index },
  );
  if (!box) throw new Error(`气泡里没有 ${selector}`);
  return box;
}

/** 真的鼠标点一下 shadow root 里的元素（用户操作，isTrusted） */
async function tapIn(page: Page, selector: string, index = 0): Promise<void> {
  const r = await rectIn(page, selector, index);
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
}

/** shadow root 里取点东西 */
const peekAll = (page: Page, selector: string, what: "text" | "role" | "checked" | "height" | "class" | "disabled") =>
  page.evaluate(
    ({ sel, w }) =>
      Array.from((window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelectorAll<HTMLElement>(sel)).map((el) =>
        w === "text"
          ? el.textContent
          : w === "role"
            ? el.getAttribute("role")
            : w === "checked"
              ? el.getAttribute("aria-checked")
              : w === "height"
                ? el.style.height
                : w === "class"
                  ? el.className
                  : String((el as HTMLButtonElement).disabled),
      ),
    { sel: selector, w: what },
  );

const bubbleOn = (page: Page) => page.evaluate(() => (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelector(".bubble")!.classList.contains("on"));
const fabOn = (page: Page) => page.evaluate(() => (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelector(".fab")!.classList.contains("on"));
const showBubble = (page: Page, view: Record<string, unknown>) => callJson(page, "bubble", JSON.stringify(view));
const bubbleMessages = async (page: Page) => (await postedOf(page)).filter((m) => m.type === "bubble");
/** 网页里一个框的位置 */
async function fieldBox(page: Page, selector: string): Promise<Box> {
  const b = (await page.locator(selector).boundingBox())!;
  return { ...b, right: b.x + b.width, bottom: b.y + b.height };
}
/** 两块重叠没有（气泡盖没盖住框） */
const overlap = (a: Box, b: Box) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
const focusedInShadow = (page: Page) => page.evaluate(() => (window as unknown as { peekRoot: ShadowRoot }).peekRoot.activeElement?.tagName);

describe.skipIf(!CHROME)("悬浮按钮旁边的气泡（146 号票，窄屏 390）", () => {
  test("点按钮：气泡在按钮旁边出来（屏宽减 32、左右留 8、框在顶上时放下方），打字框聚焦；打字点发送报 bubble send；网页收不到气泡里的按键", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await page.evaluate(() => {
      (window as unknown as { pageKeys: number }).pageKeys = 0;
      document.addEventListener("keydown", () => (window as unknown as { pageKeys: number }).pageKeys++);
    });
    await page.click("#title");
    await page.waitForTimeout(80);
    await tapIn(page, ".fab");
    await page.waitForTimeout(80);
    expect((await postedOf(page)).find((m) => m.type === "open")).toMatchObject({ field: { label: "标题" } });
    expect(await focusedInShadow(page)).toBe("TEXTAREA");
    expect(await bubbleOn(page)).toBe(true);
    const fab = await rectIn(page, ".fab");
    const bubble = await rectIn(page, ".bubble");
    expect(bubble.width).toBe(358);
    expect(bubble.x).toBeGreaterThanOrEqual(8);
    expect(bubble.right).toBeLessThanOrEqual(382);
    expect(bubble.y).toBeGreaterThanOrEqual(fab.bottom + 7);
    expect(overlap(bubble, await fieldBox(page, "#title"))).toBe(false);
    // 先自己画的打字框上写着对哪个框说
    expect(await peekAll(page, ".label", "text")).toEqual(["对「标题」说"]);
    await page.keyboard.type("abc ");
    await page.keyboard.insertText("标题写成周末杭州游记");
    expect(await page.evaluate(() => (window as unknown as { pageKeys: number }).pageKeys)).toBe(0);
    await tapIn(page, ".send");
    // 带着按钮所在的框连同框里这一刻的内容（149 号票）
    expect(await bubbleMessages(page)).toEqual([
      { nonce: NONCE, type: "bubble", action: "send", text: "abc 标题写成周末杭州游记", field: expect.objectContaining({ label: "标题", value: { text: "", total: 0 } }) },
    ]);
    // 焦点离开了框，但气泡开着：按钮不收
    await page.waitForTimeout(250);
    expect(await fabOn(page)).toBe(true);
    await page.close();
  });

  test("宿主交来在想、回话（字就是字，HTML 不生效）；点气泡外面的网页收起、报 close，焦点不在框里时按钮也收", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    const fieldId = await idOf(page, "标题");
    await page.click("#title");
    await page.waitForTimeout(80);
    await tapIn(page, ".fab");
    await showBubble(page, { kind: "busy", fieldId, said: "标题写成周末" });
    expect(await peekAll(page, ".said", "text")).toEqual(["标题写成周末"]);
    expect(await peekAll(page, ".thinking", "text")).toEqual(["二狗在想……"]);
    const html = `<img src=x onerror="window.hacked=1">写好了`;
    expect(await showBubble(page, { kind: "reply", fieldId, said: "", text: html, failed: false, system: false })).toEqual({ ok: true });
    expect(await peekAll(page, ".text", "text")).toEqual([html]);
    expect(await peekAll(page, "img", "text")).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { hacked?: number }).hacked)).toBeUndefined();
    // 样子不对的不画
    expect(await showBubble(page, { kind: "explode" })).toMatchObject({ ok: false });
    // 点页面右下角的空白处
    await page.mouse.click(385, 835);
    await page.waitForTimeout(80);
    expect(await bubbleMessages(page)).toEqual([{ nonce: NONCE, type: "bubble", action: "close" }]);
    expect(await bubbleOn(page)).toBe(false);
    expect(await fabOn(page)).toBe(false);
    await page.close();
  });

  test("长按：气泡里出波形和秒数；竖条跟着宿主交来的音量变；上滑进松开取消（变红），挪回来又能发，松手报 cancel；不滑松手报 stop", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    const fieldId = await idOf(page, "标题");
    await page.click("#title");
    await page.waitForTimeout(80);
    const fab = await rectIn(page, ".fab");
    const cx = fab.x + fab.width / 2;
    const cy = fab.y + fab.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(450);
    expect(await peekAll(page, ".wave i", "height")).toHaveLength(28);
    // 波形不在按钮下方（149 号票；标题框在页面顶上，按钮贴着顶，放在按钮旁边），不出屏幕
    const listening = await rectIn(page, ".bubble");
    expect(listening.bottom <= fab.y || listening.right <= fab.x || listening.x >= fab.right).toBe(true);
    expect(listening.x).toBeGreaterThanOrEqual(8);
    expect(listening.right).toBeLessThanOrEqual(382);
    expect(await peekAll(page, ".time", "text")).toEqual(["0:00"]);
    expect(await peekAll(page, ".hint", "text")).toEqual(["松开发送，上滑取消"]);
    await showBubble(page, { kind: "listening", fieldId, label: "对「标题」说", levels: [0.2, 1] });
    expect((await peekAll(page, ".wave i", "height")).slice(-3)).toEqual(["6%", "20%", "100%"]);
    await page.mouse.move(cx, cy - 70);
    expect(await peekAll(page, ".bubble", "class")).toEqual([expect.stringContaining("cancel")]);
    expect(await peekAll(page, ".hint", "text")).toEqual(["松开手指，取消发送"]);
    await page.mouse.move(cx, cy - 10);
    expect(await peekAll(page, ".bubble", "class")).toEqual([expect.not.stringContaining("cancel")]);
    await page.mouse.move(cx, cy - 70);
    await page.mouse.up();
    expect((await postedOf(page)).filter((m) => m.type === "voice").map((m) => m.phase)).toEqual(["press", "start", "cancel"]);
    expect(await bubbleOn(page)).toBe(false);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(1450);
    expect(await peekAll(page, ".time", "text")).toEqual(["0:01"]);
    await page.mouse.up();
    expect((await postedOf(page)).filter((m) => m.type === "voice").map((m) => m.phase)).toEqual(["press", "start", "cancel", "press", "start", "stop"]);
    // 松手了先出"在想"（宿主随后交来）
    expect(await peekAll(page, ".thinking", "text")).toEqual(["二狗在想……"]);
    await page.close();
  });

  test("按钮在框下面（框占满整行）：气泡在按钮下方、不盖框；框在屏幕最下面、下方放不下时越过框放到框上面；用户把框滚出屏幕收起（网页自己滚的不收）", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    // 像手机网页那样框占满整行：按钮放不到右边，在框下面靠右
    await page.evaluate(() => {
      const top = document.createElement("div");
      top.style.height = "1500px";
      document.body.prepend(top);
      const bottom = document.createElement("div");
      bottom.style.height = "2000px";
      document.body.append(bottom);
      const title = document.getElementById("title")!;
      title.style.width = "360px";
      window.scrollTo(0, title.getBoundingClientRect().top + window.scrollY - 200);
    });
    await page.click("#title");
    await page.waitForTimeout(80);
    await tapIn(page, ".fab");
    await page.waitForTimeout(80);
    let field = await fieldBox(page, "#title");
    let fab = await rectIn(page, ".fab");
    let bubble = await rectIn(page, ".bubble");
    expect(fab.y).toBeGreaterThanOrEqual(field.bottom);
    expect(Math.round(bubble.y)).toBe(Math.round(fab.bottom + 8));
    expect(overlap(bubble, field)).toBe(false);

    // 框挪到屏幕最下面（网页自己滚的：不收）：按钮下面放不下，越过框放到框上面，照样不盖框
    await page.evaluate(() => {
      const title = document.getElementById("title")!;
      window.scrollTo(0, title.getBoundingClientRect().top + window.scrollY - 740);
    });
    await page.waitForTimeout(150);
    field = await fieldBox(page, "#title");
    fab = await rectIn(page, ".fab");
    bubble = await rectIn(page, ".bubble");
    expect(fab.y).toBeGreaterThanOrEqual(field.bottom);
    expect(Math.round(bubble.bottom)).toBe(Math.round(field.y - 8));
    expect(overlap(bubble, field)).toBe(false);
    expect(await bubbleMessages(page)).toEqual([]);

    // 网页自己（不是用户）把框滚出去：气泡挪到看得见的地方，不收
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(200);
    expect(await bubbleOn(page)).toBe(true);
    expect(await bubbleMessages(page)).toEqual([]);
    await page.evaluate(() => window.scrollBy(0, -1200));
    await page.waitForTimeout(100);
    // 用户滚的（滚轮、手指划）：收起
    await page.mouse.move(380, 300);
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(200);
    expect(await bubbleMessages(page)).toEqual([{ nonce: NONCE, type: "bubble", action: "close" }]);
    expect(await bubbleOn(page)).toBe(false);
    await page.close();
  });

  test("输入法弹起（看得见的部分变矮）挡住了框：把框滚回看得见的地方，框和气泡都看得见、不盖框，不收", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await page.evaluate(() => {
      const bottom = document.createElement("div");
      bottom.style.height = "2000px";
      document.body.append(bottom);
      const title = document.getElementById("title")!;
      title.style.width = "360px";
      window.scrollTo(0, title.getBoundingClientRect().top + window.scrollY - 600);
    });
    await page.click("#title");
    await page.waitForTimeout(80);
    await tapIn(page, ".fab");
    await page.waitForTimeout(80);
    // 像输入法弹起来：只剩上面 420
    await page.setViewportSize({ width: 390, height: 420 });
    await page.waitForTimeout(250);
    const field = await fieldBox(page, "#title");
    const bubble = await rectIn(page, ".bubble");
    expect(field.y).toBeGreaterThanOrEqual(0);
    expect(field.bottom).toBeLessThanOrEqual(420);
    expect(bubble.y).toBeGreaterThanOrEqual(8);
    expect(bubble.bottom).toBeLessThanOrEqual(412);
    expect(overlap(bubble, field)).toBe(false);
    expect(await bubbleOn(page)).toBe(true);
    expect(await bubbleMessages(page)).toEqual([]);
    expect(await focusedInShadow(page)).toBe("TEXTAREA");
    await page.close();
  });

  test("回话太长（more，147 号票）：回话下面给去侧边栏看，点了气泡收起、报 bubble sidebar；不长的没有这个按钮", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    const fieldId = await idOf(page, "标题");
    await page.click("#title");
    await page.waitForTimeout(80);
    await tapIn(page, ".fab");
    await showBubble(page, { kind: "reply", fieldId, said: "", text: "写好了", failed: false, system: false, more: false });
    expect(await peekAll(page, ".foot .btn", "text")).toEqual([]);
    await showBubble(page, { kind: "reply", fieldId, said: "这页讲什么", text: "很长的回话", failed: false, system: false, more: true });
    expect(await peekAll(page, ".foot .btn", "text")).toEqual(["去侧边栏看"]);
    await tapIn(page, ".foot .btn");
    expect(await bubbleMessages(page)).toEqual([{ nonce: NONCE, type: "bubble", action: "sidebar" }]);
    expect(await bubbleOn(page)).toBe(false);
    await page.close();
  });

  test("网页的样式影响不到气泡（根字号、全局的字号、颜色、背景、内边距）", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await page.addStyleTag({
      content: "html{font-size:40px!important;color:red!important}*{font-family:serif!important;line-height:5!important;background:#f0f!important}div,p,span,button,textarea{font-size:30px!important;padding:40px!important}",
    });
    const fieldId = await idOf(page, "标题");
    await page.click("#title");
    await page.waitForTimeout(80);
    await tapIn(page, ".fab");
    await showBubble(page, { kind: "reply", fieldId, said: "", text: "写好了", failed: false, system: false });
    await page.waitForTimeout(50);
    const look = await page.evaluate(() => {
      const root = (window as unknown as { peekRoot: ShadowRoot }).peekRoot;
      const text = getComputedStyle(root.querySelector(".text")!);
      const bubble = getComputedStyle(root.querySelector(".bubble")!);
      return { size: text.fontSize, color: text.color, padding: text.paddingTop, background: bubble.backgroundColor, width: bubble.width };
    });
    expect(look).toEqual({ size: "14px", color: "rgb(29, 36, 51)", padding: "0px", background: "rgb(255, 255, 255)", width: "358px" });
    await page.close();
  });

  test("不知道是哪个框（拦下的对话框没认出）：气泡在屏幕下面居中、没有尖角；让二狗选先出打字框；知道是哪个框：按钮挪过去、气泡跟着", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await showBubble(page, { kind: "chooser", fieldId: "", text: "网页要你选图片" });
    await page.waitForTimeout(80);
    const free = await rectIn(page, ".bubble");
    expect(Math.round(free.bottom)).toBe(844 - 8);
    expect(free.x).toBe(16);
    expect(await peekAll(page, ".bubble", "class")).toEqual([expect.stringContaining("free")]);
    expect(await peekAll(page, ".btn", "text")).toEqual(["让二狗选", "自己选"]);
    await tapIn(page, ".btn.primary");
    expect(await bubbleMessages(page)).toEqual([{ nonce: NONCE, type: "bubble", action: "ergo" }]);
    expect(await focusedInShadow(page)).toBe("TEXTAREA");

    const noteId = await idOf(page, "说明");
    await showBubble(page, { kind: "chooser", fieldId: noteId, text: "网页要你选图片" });
    await page.waitForTimeout(80);
    expect(await fabOn(page)).toBe(true);
    const note = (await page.locator("#note").boundingBox())!;
    const fab = await rectIn(page, ".fab");
    expect(Math.abs(fab.y - (note.y + note.height + 6)) < 2 || Math.abs(fab.x - (note.x + note.width + 6)) < 2).toBe(true);
    const bubble = await rectIn(page, ".bubble");
    expect(bubble.y > fab.bottom || bubble.bottom < fab.y).toBe(true);
    expect(overlap(bubble, await fieldBox(page, "#note"))).toBe(false);
    await page.close();
  });
});

// 147 号票（浏览侧边栏）：选中的框、整页文字
/** 页面桥报过的选中的框 */
const selectedPosts = async (page: Page) => (await postedOf(page)).filter((m) => m.type === "selected");

describe.skipIf(!CHROME)("页面桥给浏览侧边栏的", () => {
  test("选中的框：装上报一次没选中；点进框选中、焦点离开也不丢；点上传处选中上传框；框从页面上没了报没选中；clearSelection 取消；selected() 现问；密码框选不中", async () => {
    const page = await open();
    expect((await selectedPosts(page))[0]).toMatchObject({ field: null, page: { url: "https://album.example.cn/upload" } });
    await page.click("#title");
    // 焦点离开（点到空白处）：悬浮按钮收起，选中的框还在
    await page.mouse.click(780, 880);
    await page.waitForTimeout(300);
    expect((await postedOf(page)).filter((m) => m.type === "field").at(-1)).toMatchObject({ field: null });
    expect(await callJson(page, "selected")).toMatchObject({ page: { title: "相册 · 上传", url: "https://album.example.cn/upload" }, field: { kind: "text", label: "标题" } });
    // 同一个框再点不再报
    const before = (await selectedPosts(page)).length;
    await page.click("#title");
    expect(await selectedPosts(page)).toHaveLength(before);
    // 密码框：选不中，选中的还是标题
    await page.click("#pwd");
    expect(await callJson(page, "selected")).toMatchObject({ field: { label: "标题" } });
    // 点上传处：选中藏在后面的选文件的框
    await page.mouse.click(...(await center(page, "#upload-label")));
    await page.waitForTimeout(100);
    expect((await selectedPosts(page)).at(-1)).toMatchObject({ field: { kind: "file", label: "上传照片", multiple: true } });
    // 框从页面上没了：一秒内报没选中
    await page.evaluate(() => document.getElementById("photos")!.remove());
    await page.waitForTimeout(1300);
    expect((await selectedPosts(page)).at(-1)).toMatchObject({ field: null });
    expect(await callJson(page, "selected")).toMatchObject({ field: null });
    // clearSelection：取消，报一次
    await page.click("#note");
    expect(await callJson(page, "clearSelection")).toEqual({ ok: true });
    expect((await selectedPosts(page)).at(-1)).toMatchObject({ field: null });
    expect(await callJson(page, "selected")).toMatchObject({ field: null });
    // 口令不对什么都不做
    expect(await call(page, "selected", "wrong")).toBe("");
    expect(await call(page, "text", "wrong")).toBe("");
    await page.close();
  });

  test("整页文字：看得见的正文，脚本、样式、藏起来的不在里面，空白收拾过；太长截到 2 万字，写明截了、一共多少字", async () => {
    const page = await open();
    await page.evaluate(() => {
      const extra = document.createElement("div");
      extra.innerHTML = '<h2>报名须知</h2><p>  第一条：   带身份证  </p><style>.x{color:red}</style><script>var secret = "脚本里的字";</script><p style="display:none">藏起来的字</p>';
      document.body.prepend(extra);
    });
    const read = (await callJson(page, "text")) as { ok: boolean; page: unknown; text: string; truncated: boolean; total: number };
    expect(read).toMatchObject({ ok: true, page: { title: "相册 · 上传", url: "https://album.example.cn/upload" }, truncated: false });
    expect(read.text).toContain("报名须知\n");
    expect(read.text).toContain("第一条： 带身份证");
    expect(read.text).toContain("上传照片");
    for (const hidden of ["脚本里的字", "color:red", "藏起来的字", "window.submitted"]) expect(read.text).not.toContain(hidden);
    expect(read.total).toBe(read.text.length);
    await page.evaluate(() => {
      const long = document.createElement("p");
      long.textContent = "字".repeat(25_000);
      document.body.appendChild(long);
    });
    const cut = (await callJson(page, "text")) as { text: string; truncated: boolean; total: number };
    expect(cut.truncated).toBe(true);
    expect(cut.text).toHaveLength(20_000);
    expect(cut.total).toBeGreaterThan(25_000);
    await page.close();
  });
});

// ---------- 149 号票：框里的内容、按钮贴着顶时的波形、挑图片窗口 ----------

/** 一张 16×16 的红图（base64 的 JPEG），当缩略图 */
const redThumb = (page: Page) =>
  page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 16, 16);
    const data = c.toDataURL("image/jpeg");
    return data.slice(data.indexOf(",") + 1);
  });

const showPick = (page: Page, view: Record<string, unknown>) => callJson(page, "pick", JSON.stringify(view));
const pickMessages = async (page: Page) => (await postedOf(page)).filter((m) => m.type === "pick");
const pickOn = (page: Page) => page.evaluate(() => (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelector(".pick")!.classList.contains("on"));
const pickFiles = (thumb: string, checked: string[]) => [
  { token: "t1", name: "西湖.jpg", image: true, thumb, checked: checked.includes("t1") },
  { token: "t2", name: "断桥.jpg", image: true, thumb, checked: checked.includes("t2") },
  { token: "t9", name: "简历.pdf", image: false, thumb: "", checked: checked.includes("t9") },
];

describe.skipIf(!CHROME)("框里的内容（149 号票：二狗读得到选中的框里写了什么）", () => {
  test("选中、点按钮、长按都带着框里这一刻的内容：普通的框、React 受控的框、多行、可编辑区域；打字过一会儿再报一次选中；上传框没有", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await page.click("#title");
    await page.keyboard.type("周末游记");
    await page.waitForTimeout(450);
    const selected = (await postedOf(page)).filter((m) => m.type === "selected" && m.field);
    expect((selected.at(-1)!.field as { value: unknown }).value).toEqual({ text: "周末游记", total: 4 });
    expect(await callJson(page, "selected")).toMatchObject({ field: { label: "标题", value: { text: "周末游记", total: 4 } } });

    await page.click("#react-title");
    await page.keyboard.type("React 里的字");
    expect(await callJson(page, "selected")).toMatchObject({ field: { label: "React 标题", value: { text: "React 里的字", total: 9 } } });
    await page.fill("#note", "第一行\n第二行");
    await page.click("#note");
    expect(await callJson(page, "selected")).toMatchObject({ field: { label: "说明", value: { text: "第一行\n第二行", total: 7 } } });
    await page.click("#editor");
    expect(await callJson(page, "selected")).toMatchObject({ field: { label: "正文", value: { text: "旧的", total: 2 } } });
    await page.mouse.click(...(await center(page, "#upload-label")));
    await page.waitForTimeout(80);
    const upload = (await callJson(page, "selected")) as { field: Record<string, unknown> };
    expect(upload.field).toMatchObject({ kind: "file", label: "上传照片" });
    expect(upload.field.value).toBeUndefined();

    // 点按钮报的 open 带着
    await page.click("#title");
    await page.waitForTimeout(80);
    await tapIn(page, ".fab");
    expect((await postedOf(page)).filter((m) => m.type === "open").at(-1)).toMatchObject({ field: { label: "标题", value: { text: "周末游记", total: 4 } } });
    await page.close();
  });

  test("太长截到 5000 字、写明一共多少字；密码框选不中、不读", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await page.fill("#note", "字".repeat(6000));
    await page.click("#note");
    const long = (await callJson(page, "selected")) as { field: { value: { text: string; total: number } } };
    expect(long.field.value.text).toHaveLength(5000);
    expect(long.field.value.total).toBe(6000);
    await page.fill("#pwd", "secret-123");
    await page.click("#pwd");
    await page.waitForTimeout(80);
    // 点密码框不算选中（还是原来选中的那个）
    expect(await callJson(page, "selected")).toMatchObject({ field: { label: "说明" } });
    const raw = await page.evaluate(() => (window as unknown as { posted: string[] }).posted.join("\n"));
    expect(raw).not.toContain("secret-123");
    await page.close();
  });
});

describe.skipIf(!CHROME)("按住说话的波形（149 号票：在按钮上方，不在下方）", () => {
  test("上方放得下：在按钮上方，横着不出屏幕（框在按钮上面也一样，说话时可以盖框）", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await page.evaluate(() => (document.getElementById("f")!.style.marginTop = "420px"));
    await page.click("#title");
    await page.waitForTimeout(80);
    const fab = await rectIn(page, ".fab");
    await page.mouse.move(fab.x + fab.width / 2, fab.y + fab.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(450);
    const listening = await rectIn(page, ".bubble");
    expect(listening.bottom).toBeLessThanOrEqual(fab.y);
    expect(listening.x).toBeGreaterThanOrEqual(8);
    expect(listening.right).toBeLessThanOrEqual(382);
    await page.mouse.up();
    await page.close();
  });

  test("按钮贴着屏幕顶、上方放不下：放到按钮旁边空间大的那一侧，不盖住按钮", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await page.click("#title");
    await page.waitForTimeout(80);
    const fab = await rectIn(page, ".fab");
    expect(fab.y).toBeLessThan(120);
    await page.mouse.move(fab.x + fab.width / 2, fab.y + fab.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(450);
    const listening = await rectIn(page, ".bubble");
    // 不在按钮下方：和按钮横着不重叠（在左边或右边）
    expect(listening.right <= fab.x || listening.x >= fab.right).toBe(true);
    expect(listening.x).toBeGreaterThanOrEqual(8);
    expect(listening.right).toBeLessThanOrEqual(382);
    await page.mouse.up();
    await page.close();
  });
});

describe.skipIf(!CHROME)("挑图片窗口（149 号票：固定在屏幕上，不跟着悬浮按钮）", () => {
  test("手机 390：贴底、占满宽，网页滚动它不动；缩略图画进 canvas，单张的框单选、推荐的选上；点一张报 choose、交报 deliver；多张的框交 N 个；都不要报 dismiss；× 收起报 hide", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    await page.evaluate(() => (document.body.style.minHeight = "3000px"));
    const thumb = await redThumb(page);
    expect(await showPick(page, { kind: "pick", id: "c-1", title: "二狗给「上传照片」找了 3 个", note: "点一张选中它", files: pickFiles(thumb, ["t2"]), multiple: false, phase: "choosing" })).toEqual({ ok: true });
    await page.waitForTimeout(250);
    expect(await pickOn(page)).toBe(true);
    const box = await rectIn(page, ".pick");
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    expect(Math.round(box.bottom)).toBe(844);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await rectIn(page, ".pick")).toEqual(box);
    expect(await peekAll(page, ".pick-title", "text")).toEqual(["二狗给「上传照片」找了 3 个"]);
    expect(await peekAll(page, ".pick-strip", "role")).toEqual(["radiogroup"]);
    expect(await peekAll(page, ".pick-tile", "role")).toEqual(["radio", "radio", "radio"]);
    expect(await peekAll(page, ".pick-tile", "checked")).toEqual(["false", "true", "false"]);
    expect(await peekAll(page, ".pick-tile .pick-name", "text")).toEqual(["简历.pdf"]);
    const red = await page.evaluate(() => {
      const canvas = (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelector<HTMLCanvasElement>(".pick-tile canvas")!;
      return canvas.getContext("2d")!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[0];
    });
    expect(red).toBeGreaterThan(200);
    await tapIn(page, ".pick-tile", 0);
    await tapIn(page, ".pick .btn.primary");
    expect(await pickMessages(page)).toEqual([
      { nonce: NONCE, type: "pick", id: "c-1", action: "choose", token: "t1" },
      { nonce: NONCE, type: "pick", id: "c-1", action: "deliver" },
    ]);
    await showPick(page, { kind: "pick", id: "c-2", title: "挑几张", note: "点选要交的，能选好几个", files: pickFiles(thumb, ["t1", "t9"]), multiple: true, phase: "choosing" });
    expect(await peekAll(page, ".pick-strip", "role")).toEqual(["group"]);
    expect(await peekAll(page, ".pick .btn.primary", "text")).toEqual(["交 2 个"]);
    await showPick(page, { kind: "pick", id: "c-2", title: "挑几张", note: "没交进去：页面上没有这个框了（可以再点交）", files: pickFiles(thumb, []), multiple: true, phase: "failed" });
    expect(await peekAll(page, ".pick .btn.primary", "disabled")).toEqual(["true"]);
    expect(await peekAll(page, ".pick-note", "class")).toEqual(["pick-note failed"]);
    await tapIn(page, ".pick .btn:not(.primary)");
    expect((await pickMessages(page)).at(-1)).toEqual({ nonce: NONCE, type: "pick", id: "c-2", action: "dismiss" });
    await tapIn(page, ".pick .x");
    expect((await pickMessages(page)).at(-1)).toEqual({ nonce: NONCE, type: "pick", id: "c-2", action: "hide" });
    expect(await pickOn(page)).toBe(false);
    // 样子不对的不画
    expect(await showPick(page, { kind: "explode" })).toMatchObject({ ok: false });
    await page.close();
  });

  test("宽屏 1280：底部居中、离底 16、最宽 520；悬浮按钮的气泡不盖住它", async () => {
    const page = await open({ width: 1280, height: 800, peek: true });
    const thumb = await redThumb(page);
    await showPick(page, { kind: "pick", id: "c-1", title: "二狗给「上传照片」找了 3 个", note: "点一张选中它", files: pickFiles(thumb, ["t2"]), multiple: false, phase: "choosing" });
    await page.waitForTimeout(250);
    const box = await rectIn(page, ".pick");
    expect(box.width).toBe(520);
    expect(box.x).toBe((1280 - 520) / 2);
    expect(Math.round(box.bottom)).toBe(800 - 16);
    await page.close();
  });
});

// ───────────────────────── 164 号票：看能点的东西、按编号点 ─────────────────────────

/** 小店的首页：各种能点的、不该列的；一个网页自己的 web component（开放的 shadow root 里一个按钮）；最底下一个按钮 */
const SHOP_HOME = `<!doctype html><html><head><meta charset="utf-8"><title>小店 · 首页</title></head><body style="margin:0;font:16px sans-serif">
<nav><a id="to-list" href="/list?from=nav">商品列表</a> <a id="blank" href="/detail" target="_blank">新窗口打开详情</a> <a id="js-link" href="javascript:void(0)">没有地址的链接</a>
<a id="blank-spa" href="/detail" target="_blank" onclick="event.preventDefault(); window.spa = (window.spa || 0) + 1">站内跳</a></nav>
<button id="run" type="button">立即运行</button>
<div id="fake" role="button" tabindex="0">  展开
   更多 </div>
<div role="tablist"><span role="tab" id="tab2">评论</span></div>
<ul><li role="menuitem" id="mi">设置</li></ul>
<form action="/search" target="_blank" id="search"><input name="q" id="q" value="猫"><input type="submit" value="搜索" id="go"><input type="button" value="清空" id="clear"></form>
<button id="icon" aria-label="关闭"><svg width="10" height="10"></svg></button>
<button id="greyed" aria-disabled="true">下一步</button>
<button id="off" disabled>禁用的</button>
<button id="gone" style="display:none">藏起来的</button>
<button id="invisible" style="visibility:hidden">看不见的</button>
<div aria-hidden="true"><button id="aria">无障碍藏起来的</button></div>
<button id="nopointer" style="pointer-events:none">点不到的</button>
<input type="password" id="pwd" placeholder="密码" role="button">
<details><summary id="sum">更多说明</summary><p>内容</p></details>
<button id="opener" type="button" onclick="window.open('/popup?x=1', '_blank')">弹窗打开</button>
<x-card id="card"></x-card>
<button id="evil" type="button" style="position:absolute;left:600px;top:0" data-ergo-ref="e5" onclick="window.evilClicks = (window.evilClicks || 0) + 1" hidden>立即运行</button>
<div style="height:3000px"></div>
<button id="far" type="button">最底下的按钮</button>
<script>
customElements.define("x-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<button>加入购物车</button>"; } });
window.events = [];
const run = document.getElementById("run");
for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) run.addEventListener(t, (e) => window.events.push(t + "@" + Math.round(e.clientX) + "," + Math.round(e.clientY)));
run.addEventListener("click", () => (window.ran = (window.ran || 0) + 1));
</script>
</body></html>`;

const shopPage = (title: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><a href="/home">回首页</a><p>${title}</p></body></html>`;

/** 开小店的首页（页面桥照样在网页的脚本之前注入）；首页之外的地址回一页只有标题的 */
async function openShop(options: { width?: number; height?: number } = {}): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: options.width ?? 800, height: options.height ?? 900 } });
  await page.addInitScript(() => {
    const posted: string[] = [];
    (window as unknown as { posted: string[] }).posted = posted;
    (window as unknown as { ergoPageHost: { post(json: string): void } }).ergoPageHost = { post: (json: string) => void posted.push(json) };
  });
  await page.addInitScript({ content: bridge });
  await page.route("https://shop.example.cn/**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: "text/html", body: url.pathname === "/home" ? SHOP_HOME : shopPage(`小店 · ${url.pathname}${url.search}`) });
  });
  await page.goto("https://shop.example.cn/home?utm=ad#top");
  await page.waitForFunction(() => customElements.get("x-card") !== undefined);
  return page;
}

type Snap = { ok: boolean; page: { title: string; url: string }; elements: Array<{ ref: string; role: string; text: string; href?: string; disabled?: boolean }>; total: number; reason?: string };
const snapshot = async (page: Page, max = 40) => (await callJson(page, "snapshot", String(max))) as Snap;
const refOf = (snap: Snap, text: string) => {
  const found = snap.elements.find((e) => e.text === text);
  if (!found) throw new Error(`没列出「${text}」：${JSON.stringify(snap.elements)}`);
  return found.ref;
};
const click = async (page: Page, ref: string, url = "https://shop.example.cn/home") =>
  (await callJson(page, "click", ref, url)) as { ok: boolean; reason?: string; role?: string; text?: string; page?: { title: string; url: string } };
/** 等新的一页上的页面桥装好 */
const bridgeReady = (page: Page) => page.waitForFunction(() => typeof (window as unknown as { __ergoPage?: unknown }).__ergoPage === "object");

describe.skipIf(!CHROME)("看能点的东西、按编号点（164 号票）", () => {
  test("列出能点的：链接（带地址，javascript: 的不带）、按钮、role 是按钮/标签页/菜单项的、提交和按钮样子的 input、summary、网页自己的开放 shadow root 里的、只有 aria-label 的；灰的标 disabled；禁用、藏起来、看不见、aria-hidden、点不到、密码框不列；不往网页的 DOM 里写任何东西", async () => {
    const page = await openShop();
    const before = await page.evaluate(() => document.body.innerHTML);
    const snap = await snapshot(page);
    expect(snap).toMatchObject({ ok: true, page: { title: "小店 · 首页", url: "https://shop.example.cn/home" }, total: 17 });
    expect(snap.elements).toEqual([
      { ref: "e1", role: "link", text: "商品列表", href: "https://shop.example.cn/list?from=nav" },
      { ref: "e2", role: "link", text: "新窗口打开详情", href: "https://shop.example.cn/detail" },
      { ref: "e3", role: "link", text: "没有地址的链接" },
      { ref: "e4", role: "link", text: "站内跳", href: "https://shop.example.cn/detail" },
      { ref: "e5", role: "button", text: "立即运行" },
      { ref: "e6", role: "button", text: "展开 更多" },
      { ref: "e7", role: "tab", text: "评论" },
      { ref: "e8", role: "menuitem", text: "设置" },
      // 184 号票起文本框也列（搜索框没有标签、没有提示，带着现在的值）
      { ref: "e9", role: "textbox", text: "", valuePreview: "猫" },
      { ref: "e10", role: "submit", text: "搜索" },
      { ref: "e11", role: "input", text: "清空" },
      { ref: "e12", role: "button", text: "关闭" },
      { ref: "e13", role: "button", text: "下一步", disabled: true },
      { ref: "e14", role: "button", text: "更多说明" },
      { ref: "e15", role: "button", text: "弹窗打开" },
      { ref: "e16", role: "button", text: "加入购物车" },
      { ref: "e17", role: "button", text: "最底下的按钮" },
    ]);
    // 编号只在页面桥的内存里：网页的 DOM 一点没变，没有 data-ergo-ref（网页自己写的那个除外）
    expect(await page.evaluate(() => document.body.innerHTML)).toBe(before);
    expect(await page.evaluate(() => document.querySelectorAll("[data-ergo-ref]").length)).toBe(1);
    // 口令不对什么都不做
    expect(await call(page, "snapshot", "wrong", "40")).toBe("");
    expect(await call(page, "click", "wrong", "e5", "https://shop.example.cn/home")).toBe("");
    await page.close();
  });

  test("编号稳定：再看一次同一个元素还是这个号；超过上限时屏幕上看得见的先列，写明一共几个；新出来的接着编；滚到下面再看，下面的还是原来的号", async () => {
    const page = await openShop();
    const first = await snapshot(page);
    expect((await snapshot(page)).elements).toEqual(first.elements);
    const three = await snapshot(page, 3);
    expect(three).toMatchObject({ ok: true, total: 17 });
    expect(three.elements.map((e) => [e.ref, e.text])).toEqual([
      ["e1", "商品列表"],
      ["e2", "新窗口打开详情"],
      ["e3", "没有地址的链接"],
    ]);
    await page.evaluate(() => {
      const added = document.createElement("button");
      added.textContent = "新来的";
      document.body.prepend(added);
    });
    const again = await snapshot(page);
    expect(again.elements[0]).toEqual({ ref: "e18", role: "button", text: "新来的" });
    expect(again.elements.slice(1)).toEqual(first.elements);
    await page.evaluate(() => document.getElementById("far")!.scrollIntoView());
    expect((await snapshot(page, 1)).elements).toEqual([{ ref: "e17", role: "button", text: "最底下的按钮" }]);
    await page.close();
  });

  test("点按钮：滚到看得见、在元素中间依次派 pointerover、pointerenter、mouseover、mouseenter、pointerdown、mousedown、pointerup、mouseup、click，网页自己的处理跑了；回点了什么", async () => {
    const page = await openShop();
    await page.evaluate(() => window.scrollTo(0, 2000));
    const ref = refOf(await snapshot(page), "立即运行");
    expect(await click(page, ref)).toEqual({ ok: true, role: "button", text: "立即运行", page: { title: "小店 · 首页", url: "https://shop.example.cn/home" } });
    const box = await page.evaluate(() => {
      const r = document.getElementById("run")!.getBoundingClientRect();
      return `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}`;
    });
    expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(
      ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"].map((t) => `${t}@${box}`),
    );
    expect(await page.evaluate(() => (window as unknown as { ran: number }).ran)).toBe(1);
    // 滚到了看得见的地方
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(2000);
    await page.close();
  });

  test("点链接跳到新的一页；换了网页，旧编号失效（地址不对、新的一页上没有这个号），不会点错", async () => {
    const page = await openShop();
    const snap = await snapshot(page);
    const list = refOf(snap, "商品列表");
    const run = refOf(snap, "立即运行");
    expect(await click(page, list)).toMatchObject({ ok: true, role: "link", text: "商品列表" });
    await page.waitForURL("https://shop.example.cn/list?from=nav");
    await bridgeReady(page);
    expect(await click(page, run)).toEqual({ ok: false, reason: "换了网页，编号失效，请重新 snapshot" });
    expect(await click(page, run, "https://shop.example.cn/list")).toEqual({ ok: false, reason: "这一页上没有 e5 这个编号（编号只在看过的那一页有效），请重新 snapshot" });
    // 新的一页从 e1 编起
    expect((await snapshot(page)).elements).toEqual([{ ref: "e1", role: "link", text: "回首页", href: "https://shop.example.cn/home" }]);
    await page.close();
  });

  test("开新窗口的都在同一标签打开：target=_blank 的链接、target=_blank 的表单、按钮里调 window.open；网页自己的 onClick 照样跑（拦下了就不跳），target 用完还原", async () => {
    const page = await openShop();
    const pages = () => page.context().pages().length;
    const count = pages();
    let snap = await snapshot(page);
    // 网页自己拦下了：不跳，target 还是 _blank
    expect(await click(page, refOf(snap, "站内跳"))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => [(window as unknown as { spa: number }).spa, document.getElementById("blank-spa")!.getAttribute("target")])).toEqual([1, "_blank"]);
    expect(page.url()).toBe("https://shop.example.cn/home?utm=ad#top");
    expect(await click(page, refOf(snap, "新窗口打开详情"))).toMatchObject({ ok: true });
    await page.waitForURL("https://shop.example.cn/detail");
    expect(pages()).toBe(count);

    await page.goto("https://shop.example.cn/home");
    snap = await snapshot(page);
    expect(await click(page, refOf(snap, "搜索"))).toMatchObject({ ok: true, role: "submit" });
    await page.waitForURL(/\/search\?q=/);
    expect(decodeURIComponent(new URL(page.url()).search)).toBe("?q=猫");
    expect(pages()).toBe(count);

    await page.goto("https://shop.example.cn/home");
    snap = await snapshot(page);
    expect(await click(page, refOf(snap, "弹窗打开"))).toMatchObject({ ok: true });
    await page.waitForURL("https://shop.example.cn/popup?x=1");
    expect(pages()).toBe(count);
    await page.close();
  });

  test("页面变了就不点：字变了、元素被换掉（网页挪 data-ergo-ref 也没用）、地址不对、编号不认得、现在禁用了、灰的", async () => {
    const page = await openShop();
    const snap = await snapshot(page);
    const run = refOf(snap, "立即运行");
    // 网页的脚本把一个一模一样的按钮挂上同样的 data-ergo-ref：点的还是原来那个
    await page.evaluate(() => document.getElementById("evil")!.removeAttribute("hidden"));
    expect(await click(page, run)).toMatchObject({ ok: true });
    expect(await page.evaluate(() => [(window as unknown as { ran?: number }).ran, (window as unknown as { evilClicks?: number }).evilClicks ?? 0])).toEqual([1, 0]);
    // 原来那个被换成一模一样的新元素：不点
    await page.evaluate(() => {
      const old = document.getElementById("run")!;
      old.replaceWith(old.cloneNode(true));
    });
    expect(await click(page, run)).toEqual({ ok: false, reason: "页面变了（这个元素已经不在页面上），请重新 snapshot" });
    // 字变了
    await page.evaluate(() => (document.getElementById("fake")!.textContent = "收起"));
    expect(await click(page, refOf(snap, "展开 更多"))).toEqual({ ok: false, reason: "页面变了（这个元素上的字变了），请重新 snapshot" });
    expect(await click(page, refOf(snap, "评论"), "https://shop.example.cn/other")).toEqual({ ok: false, reason: "换了网页，编号失效，请重新 snapshot" });
    expect(await click(page, "e999")).toEqual({ ok: false, reason: "这一页上没有 e999 这个编号（编号只在看过的那一页有效），请重新 snapshot" });
    await page.evaluate(() => document.getElementById("opener")!.setAttribute("disabled", ""));
    expect(await click(page, refOf(snap, "弹窗打开"))).toEqual({ ok: false, reason: "这个元素现在是灰的（禁用了），点不了" });
    expect(await click(page, refOf(snap, "下一步"))).toEqual({ ok: false, reason: "这个元素现在是灰的（禁用了），点不了" });
    await page.close();
  });

  test("二狗自己的东西（悬浮按钮、气泡、挑图片窗口，在封闭的 shadow 层里）不列", async () => {
    const page = await openShop();
    const plain = (await snapshot(page)).elements.map((e) => e.text);
    await page.click("#q");
    await page.waitForTimeout(100);
    await callJson(page, "bubble", JSON.stringify({ kind: "chooser", fieldId: "", text: "网页要你选图片" }));
    await callJson(page, "pick", JSON.stringify({ kind: "pick", id: "c-1", title: "挑一张", note: "", files: [{ token: "t1", name: "a.png", image: true, thumb: "", checked: true }], multiple: false, phase: "choosing" }));
    await page.waitForTimeout(100);
    // 页面桥的那一层挂上了（documentElement 最后一个孩子）
    expect(await page.evaluate(() => document.documentElement.lastElementChild?.tagName)).toBe("DIV");
    expect((await snapshot(page)).elements.map((e) => e.text)).toEqual(plain);
    await page.close();
  });
});

// ───────────────────────── 184 号票：按编号填字、交文件 ─────────────────────────

/** 换背景的工作室页（照 RunningHub 的 AI 应用页）：两个上传框（一个藏在网站画的上传按钮后面、一个 1 像素透明）、提示词、备注、各种不该列的框、下拉框、运行按钮、没有上传处的上传框、React 受控的框 */
const STUDIO = `<!doctype html><html><head><meta charset="utf-8"><title>换背景 · 工作室</title></head><body style="margin:0;font:16px sans-serif">
<div id="product-area" style="padding:10px;border:1px dashed #999"><h3 style="margin:0">产品图</h3> <span role="button" id="pick-product" onclick="document.getElementById('product').click()">点击上传</span><input id="product" type="file" accept="image/*" style="display:none"></div>
<div id="ref-area" style="padding:10px;border:1px dashed #999;position:relative">参考图<input id="refs" type="file" accept="image/png,image/jpeg" multiple style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0"></div>
<label for="prompt">提示词</label><textarea id="prompt" placeholder="描述场景">旧的提示词，${"很长".repeat(30)}</textarea>
<div id="note" contenteditable="true" aria-label="备注" style="min-height:30px;border:1px solid #ccc"></div>
<input id="pwd" type="password" placeholder="密码">
<input id="otp" name="sms_code" placeholder="短信验证码">
<input id="ro" readonly value="只读的">
<input id="off" disabled placeholder="禁用的">
<input id="gone-text" style="display:none" placeholder="藏起来的框">
<input id="off-file" type="file" disabled style="display:none">
<select id="size" aria-label="尺寸"><option>1:1</option><option selected>3:4</option><option>16:9</option></select>
<div id="model" role="combobox" aria-label="模型" aria-controls="models" tabindex="0">Klein-9B</div>
<ul id="models" role="listbox"><li role="option">Klein-9B</li><li role="option">Flux</li></ul>
<input id="find" type="search" role="combobox" placeholder="搜索应用">
<form id="run-form" onsubmit="window.ran = (window.ran || 0) + 1; return false;"><input id="seed" type="number" aria-label="种子" value="42"><button id="run">立即运行</button></form>
<input id="orphan" type="file" style="display:none">
<div id="react-root"></div>
<script>window.events = []; for (const id of ["prompt", "note", "product", "refs", "orphan"]) for (const t of ["input", "change"]) document.getElementById(id).addEventListener(t, () => window.events.push(id + ":" + t));</script>
<script>__REACT__</script>
</body></html>`;

/** 开工作室那一页（页面桥照样在网页的脚本之前注入）；别的地址回一页只有标题的 */
async function openStudio(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 800, height: 1400 } });
  await page.addInitScript(() => {
    const posted: string[] = [];
    (window as unknown as { posted: string[] }).posted = posted;
    (window as unknown as { ergoPageHost: { post(json: string): void } }).ergoPageHost = { post: (json: string) => void posted.push(json) };
  });
  await page.addInitScript({ content: bridge });
  await page.route("https://studio.example.cn/**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: "text/html", body: url.pathname === "/app/bg" ? STUDIO.replace("__REACT__", () => react) : shopPage(`工作室 · ${url.pathname}`) });
  });
  await page.goto("https://studio.example.cn/app/bg?id=9#top");
  await page.waitForSelector("#react-title");
  return page;
}

const STUDIO_URL = "https://studio.example.cn/app/bg";
type Found = { ok: boolean; reason?: string; field?: { id: string; kind: string; label: string; accept?: string; multiple?: boolean }; page?: { title: string; url: string } };
const refField = async (page: Page, ref: string, want: string, url = STUDIO_URL) => (await callJson(page, "refField", ref, url, want)) as Found;
/** 交来几个文件的字节（每个的字节就是它的名字），再交进那个框 */
async function attachTo(page: Page, fieldId: string, names: string[]) {
  for (const name of names) {
    await callJson(page, "fileBegin", name, name, "image/png");
    await callJson(page, "fileChunk", name, b64(name));
  }
  return callJson(page, "attachFiles", fieldId, JSON.stringify(names));
}

describe.skipIf(!CHROME)("按编号填字、交文件（184 号票）", () => {
  test("看：文本框（单行、多行、可编辑区域、搜索框，带现在的值的前 40 字）、上传框（藏起来的标 hidden，带 accept、multiple，文字取网站画的上传处）、下拉框（现在选的、前 20 个选项）也列；密码、验证码、只读、禁用、看不见的框不列；不往网页的 DOM 里写东西", async () => {
    const page = await openStudio();
    const before = await page.evaluate(() => document.body.innerHTML);
    const snap = await snapshot(page);
    expect(snap).toMatchObject({ ok: true, page: { title: "换背景 · 工作室", url: STUDIO_URL }, total: 13 });
    expect(snap.elements).toEqual([
      { ref: "e1", role: "button", text: "点击上传" },
      { ref: "e2", role: "upload", text: "产品图 点击上传", accept: "image/*", hidden: true },
      { ref: "e3", role: "upload", text: "参考图", accept: "image/png,image/jpeg", multiple: true, hidden: true },
      { ref: "e4", role: "textbox", text: "提示词", multiline: true, valuePreview: `旧的提示词，${"很长".repeat(17)}` },
      { ref: "e5", role: "textbox", text: "备注", multiline: true },
      { ref: "e6", role: "select", text: "尺寸", valuePreview: "3:4", options: ["1:1", "3:4", "16:9"] },
      { ref: "e7", role: "select", text: "模型", valuePreview: "Klein-9B", options: ["Klein-9B", "Flux"] },
      { ref: "e8", role: "textbox", text: "搜索应用" },
      { ref: "e9", role: "textbox", text: "种子", valuePreview: "42" },
      { ref: "e10", role: "submit", text: "立即运行" },
      { ref: "e11", role: "upload", text: "", hidden: true },
      { ref: "e12", role: "textbox", text: "React 标题" },
      { ref: "e13", role: "submit", text: "提交" },
    ]);
    expect(JSON.stringify(snap)).not.toContain("密码");
    expect(JSON.stringify(snap)).not.toContain("验证码");
    expect(await page.evaluate(() => document.body.innerHTML)).toBe(before);
    // 再看一次编号不变；口令不对什么都不做
    expect((await snapshot(page)).elements).toEqual(snap.elements);
    expect(await call(page, "refField", "wrong", "e4", STUDIO_URL, "textbox")).toBe("");
    await page.close();
  });

  test("按编号填：React 受控的框（state 跟着变）、多行文本、可编辑区域；回的框带页面桥的框编号；不提交表单", async () => {
    const page = await openStudio();
    const snap = await snapshot(page);
    const controlled = await refField(page, refOf(snap, "React 标题"), "textbox");
    expect(controlled).toMatchObject({ ok: true, field: { kind: "text", label: "React 标题" }, page: { title: "换背景 · 工作室", url: STUDIO_URL } });
    expect(controlled.field!.id).toMatch(/^f\d+$/);
    expect(await callJson(page, "fill", controlled.field!.id, "白色大理石台面")).toEqual({ ok: true });
    expect(await page.textContent("#react-state")).toBe("白色大理石台面");
    const prompt = await refField(page, refOf(snap, "提示词"), "textbox");
    expect(prompt.field).toMatchObject({ kind: "textarea", label: "提示词" });
    expect(await callJson(page, "fill", prompt.field!.id, "海边，黄昏")).toEqual({ ok: true });
    expect(await page.inputValue("#prompt")).toBe("海边，黄昏");
    const note = await refField(page, refOf(snap, "备注"), "textbox");
    expect(note.field).toMatchObject({ kind: "editable", label: "备注" });
    expect(await callJson(page, "fill", note.field!.id, "不要文字")).toEqual({ ok: true });
    expect(await page.textContent("#note")).toBe("不要文字");
    expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(expect.arrayContaining(["prompt:input", "prompt:change", "note:input"]));
    // 填完再看一眼，现在的值就在 valuePreview 里
    expect((await snapshot(page)).elements.find((e) => e.text === "React 标题")).toMatchObject({ valuePreview: "白色大理石台面" });
    expect(await page.evaluate(() => [(window as unknown as { ran?: number }).ran ?? 0, (window as unknown as { submitted?: number }).submitted ?? 0])).toEqual([0, 0]);
    await page.close();
  });

  test("按编号交文件：藏在上传按钮后面的、1 像素透明的、没有上传处的都交得进（设进 input.files、派 input 和 change）；只要一个的只交第一个", async () => {
    const page = await openStudio();
    const snap = await snapshot(page);
    const product = await refField(page, "e2", "upload");
    expect(product).toMatchObject({ ok: true, field: { kind: "file", label: "产品图 点击上传", accept: "image/*" } });
    expect(await attachTo(page, product.field!.id, ["mug.png", "extra.png"])).toEqual({ ok: true, count: 1 });
    expect(await page.evaluate(() => Array.from((document.getElementById("product") as HTMLInputElement).files ?? []).map((f) => f.name))).toEqual(["mug.png"]);
    const refs = await refField(page, refOf(snap, "参考图"), "upload");
    expect(refs.field).toMatchObject({ kind: "file", multiple: true });
    expect(await attachTo(page, refs.field!.id, ["a.png", "b.png"])).toEqual({ ok: true, count: 2 });
    const orphan = await refField(page, "e11", "upload");
    expect(await attachTo(page, orphan.field!.id, ["c.png"])).toEqual({ ok: true, count: 1 });
    expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(["product:input", "product:change", "refs:input", "refs:change", "orphan:input", "orphan:change"]);
    await page.close();
  });

  test("对不上就不填、不交：种类不对（按钮、上传框、下拉框不能填字，文本框不能交文件）、换了网页、编号不认得、元素被换掉、类型变了（成了密码框、禁用了）；原因跟着交来的语言", async () => {
    const page = await openStudio();
    const snap = await snapshot(page);
    expect(await refField(page, "e1", "textbox")).toEqual({ ok: false, reason: "e1 不是文本框，不能填字" });
    expect(await refField(page, "e2", "textbox")).toEqual({ ok: false, reason: "e2 不是文本框，不能填字" });
    expect(await refField(page, "e4", "upload")).toEqual({ ok: false, reason: "e4 不是上传框，不能交文件" });
    expect(await refField(page, "e6", "textbox")).toEqual({ ok: false, reason: "e6 不是文本框，不能填字" });
    expect(await refField(page, "e4", "textbox", "https://studio.example.cn/app/other")).toEqual({ ok: false, reason: "网页换了，编号对不上了" });
    expect(await refField(page, "e999", "textbox")).toEqual({ ok: false, reason: "这一页上没有 e999 这个编号" });
    expect(await callJson(page, "refField", "e4", STUDIO_URL, "button")).toMatchObject({ ok: false });
    await page.evaluate(() => {
      const old = document.getElementById("prompt")!;
      old.replaceWith(old.cloneNode(true));
    });
    expect(await refField(page, refOf(snap, "提示词"), "textbox")).toEqual({ ok: false, reason: "这个框已经不在页面上了" });
    await page.evaluate(() => ((document.getElementById("seed") as HTMLInputElement).type = "password"));
    expect(await refField(page, refOf(snap, "种子"), "textbox")).toEqual({ ok: false, reason: "这个框变了，和看的时候不是一种了" });
    await page.evaluate(() => ((document.getElementById("product") as HTMLInputElement).disabled = true));
    expect(await refField(page, "e2", "upload")).toEqual({ ok: false, reason: "这个框变了，和看的时候不是一种了" });
    // 交来英文（169 号票）：原因跟着是英文
    expect(await callJson(page, "texts", JSON.stringify(EN_BRIDGE))).toEqual({ ok: true });
    expect(await refField(page, "e1", "textbox")).toEqual({ ok: false, reason: "e1 isn't a text box, so it can't be filled" });
    await page.close();
  });

  test("框不能点：藏起来的上传框、文本框、下拉框按编号点都回原因、不点；网站画的上传按钮照样能点", async () => {
    const page = await openStudio();
    const snap = await snapshot(page);
    const clickAt = (ref: string) => click(page, ref, STUDIO_URL);
    expect(await clickAt("e2")).toEqual({ ok: false, reason: "e2 是上传框，只能交文件，不能点" });
    expect(await clickAt(refOf(snap, "提示词"))).toEqual({ ok: false, reason: "e4 是文本框，不能点：填字按编号填" });
    expect(await clickAt(refOf(snap, "尺寸"))).toEqual({ ok: false, reason: "e6 是下拉框：下拉框现在只能看，选要用户自己点" });
    expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual([]);
    expect(await clickAt("e1")).toMatchObject({ ok: true, role: "button", text: "点击上传" });
    await page.close();
  });

  test("换了网页：旧编号填不了、交不了（地址不对、新的一页上没有这个号）", async () => {
    const page = await openStudio();
    await snapshot(page);
    await page.goto("https://studio.example.cn/app/next");
    await bridgeReady(page);
    expect(await refField(page, "e4", "textbox")).toEqual({ ok: false, reason: "网页换了，编号对不上了" });
    expect(await refField(page, "e4", "textbox", "https://studio.example.cn/app/next")).toEqual({ ok: false, reason: "这一页上没有 e4 这个编号" });
    await page.close();
  });
});

/** 页面桥 shadow root 里某个元素的读屏说明 */
const ariaOf = (page: Page, selector: string) => page.evaluate((sel) => (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelector(sel)?.getAttribute("aria-label"), selector);

describe.skipIf(!CHROME)("页面桥自己的字（169 号票：二狗的网页交来当前语言的那几句，没交来是中文）", () => {
  test("没交来：中文；交来英文：悬浮按钮的说明、先自己画的打字框、在想、气泡和挑图片窗口上的按钮都换成英文；交错了的不认；只交几句的其余回到中文", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    expect(await ariaOf(page, ".fab")).toBe("让二狗帮忙：点一下打字，按住说话");
    expect(await ariaOf(page, ".bubble")).toBe("二狗");
    // 交错了的不认（不是 JSON、一句认得的都没有）
    expect(await callJson(page, "texts", "{")).toMatchObject({ ok: false });
    expect(await callJson(page, "texts", JSON.stringify({ "bridge.nope": "x" }))).toMatchObject({ ok: false });
    // 口令不对什么都不做
    expect(await call(page, "texts", "f".repeat(32), JSON.stringify(EN_BRIDGE))).toBe("");
    expect(await ariaOf(page, ".fab")).toBe("让二狗帮忙：点一下打字，按住说话");

    expect(await callJson(page, "texts", JSON.stringify(EN_BRIDGE))).toEqual({ ok: true });
    // 181 号票起说到助理的那几句写 {name}：只交了句子、没交名字时是默认的"二狗"
    expect(await ariaOf(page, ".fab")).toBe("Ask 二狗: tap to type, hold to talk");
    expect(await ariaOf(page, ".bubble")).toBe("二狗");
    expect(await ariaOf(page, ".pick")).toBe("二狗's suggestions");
    const fieldId = await idOf(page, "标题");
    await page.click("#title");
    await page.waitForTimeout(80);
    await tapIn(page, ".fab");
    await page.waitForTimeout(80);
    // 框的名字是网页自己的（这里是中文），说法是英文
    expect(await peekAll(page, ".label", "text")).toEqual(["Talk to “标题”"]);
    expect(await ariaOf(page, ".send")).toBe("Send");
    await showBubble(page, { kind: "busy", fieldId, said: "" });
    expect(await peekAll(page, ".thinking", "text")).toEqual(["二狗 is thinking…"]);
    expect(await peekAll(page, ".label", "text")).toEqual(["二狗"]);
    await showBubble(page, { kind: "chooser", fieldId: "", text: "This page wants an image" });
    expect(await peekAll(page, ".btn", "text")).toEqual(["Let 二狗 pick", "Pick myself"]);
    // 开着的时候换回中文：按钮上的字跟着换
    expect(await callJson(page, "texts", JSON.stringify({ "bridge.fab.label": "Ask Ergo" }))).toEqual({ ok: true });
    expect(await peekAll(page, ".btn", "text")).toEqual(["让二狗选", "自己选"]);
    expect(await ariaOf(page, ".fab")).toBe("Ask Ergo");
    await showBubble(page, { kind: "none" });

    expect(await callJson(page, "texts", JSON.stringify(EN_BRIDGE))).toEqual({ ok: true });
    const thumb = await redThumb(page);
    await showPick(page, { kind: "pick", id: "c-1", title: "Pick one for “上传照片”", note: "", files: pickFiles(thumb, ["t1", "t2"]), multiple: true, phase: "choosing" });
    expect(await peekAll(page, ".pick-foot .btn", "text")).toEqual(["None of these", "Upload 2"]);
    await showPick(page, { kind: "pick", id: "c-1", title: "Pick one for “上传照片”", note: "", files: pickFiles(thumb, ["t1", "t2"]), multiple: true, phase: "sending" });
    expect(await peekAll(page, ".pick-foot .btn", "text")).toEqual(["None of these", "Uploading…"]);
    await page.close();
  });

  test("交文件没成的原因（175 号票：挑图片窗口里也显示）：没交来是中文，交来英文就是英文", async () => {
    const page = await open();
    const field = await idOf(page, "上传照片");
    expect(await callJson(page, "attachFiles", field, JSON.stringify(["nope"]))).toEqual({ ok: false, reason: "没有文件可交" });
    expect(await callJson(page, "fileChunk", "nope", b64("x"))).toEqual({ ok: false, reason: "没有这个文件" });
    expect(await callJson(page, "texts", JSON.stringify(EN_BRIDGE))).toEqual({ ok: true });
    expect(await callJson(page, "attachFiles", field, JSON.stringify(["nope"]))).toEqual({ ok: false, reason: "No files to upload" });
    expect(await callJson(page, "attachFiles", "f999", JSON.stringify(["nope"]))).toEqual({ ok: false, reason: "That field is no longer on the page" });
    await page.close();
  });
});

/** shadow root 里一个名字标签：字、底色、字色、换不换行（读出来的计算值） */
const tagOf = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelector<HTMLElement>(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { text: el.textContent, bg: cs.backgroundColor, fg: cs.color, wrap: cs.whiteSpace, ring: cs.boxShadow };
  }, selector);
/** shadow root 里有几个某种元素 */
const countIn = (page: Page, selector: string) => page.evaluate((sel) => (window as unknown as { peekRoot: ShadowRoot }).peekRoot.querySelectorAll(sel).length, selector);

/** 二狗的网页交来的（181 号票的样子）：说到助理的那几句顶层换好了名字，原样、名字、颜色在 assistant 里 */
function namedTexts(name: string, tag?: { light: { bg: string; fg: string }; dark: { bg: string; fg: string } }) {
  const own = ["bridge.fab.label", "bridge.talkTo.ergo", "bridge.bubble.title", "bridge.bubble.thinking", "bridge.bubble.letErgoPick", "bridge.pick.title"] as const;
  const top = Object.fromEntries(Object.entries(ZH_BRIDGE).map(([k, v]) => [k, (own as readonly string[]).includes(k) ? v.replaceAll("{name}", name) : v]));
  return { ...top, assistant: { name, ...(tag ? { tag } : {}), templates: Object.fromEntries(own.map((k) => [k, ZH_BRIDGE[k]])) } };
}

const TAG = { light: { bg: "#112233", fg: "#ddeeff" }, dark: { bg: "#334455", fg: "#ffeedd" } };
const TAG2 = { light: { bg: "#c2e3df", fg: "#0b4f49" }, dark: { bg: "#19403d", fg: "#8fe3db" } };

describe.skipIf(!CHROME)("助理的名字和名字标签（181 号票）", () => {
  test("没交来：名字是「二狗」，标题、在想、让二狗选里是名字标签（经典的颜色，深色下换深色那对，不换行）；读屏说明是纯名字", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    expect(await ariaOf(page, ".fab")).toBe("让二狗帮忙：点一下打字，按住说话");
    await showBubble(page, { kind: "chooser", fieldId: "", text: "网页要你选图片" });
    expect(await ariaOf(page, ".bubble")).toBe("二狗");
    expect(await tagOf(page, ".label .name")).toMatchObject({ text: "二狗", bg: "rgb(251, 227, 161)", fg: "rgb(92, 61, 0)", wrap: "nowrap" });
    expect(await peekAll(page, ".btn.primary", "text")).toEqual(["让二狗选"]);
    expect(await tagOf(page, ".btn.primary .name")).toMatchObject({ text: "二狗", bg: "rgb(251, 227, 161)" });
    // 按钮里的名字标签多一圈浅色的边：主按钮的底色上也看得出是个标签
    expect((await tagOf(page, ".btn.primary .name"))?.ring).not.toBe("none");
    expect((await tagOf(page, ".label .name"))?.ring).toBe("none");
    // 宿主没给那一句：页面桥自己的"二狗在想……"
    await showBubble(page, { kind: "busy", fieldId: "", said: "", text: "" });
    expect(await peekAll(page, ".thinking", "text")).toEqual(["二狗在想……"]);
    expect(await tagOf(page, ".thinking .name")).toMatchObject({ text: "二狗", bg: "rgb(251, 227, 161)" });
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await tagOf(page, ".thinking .name")).toMatchObject({ bg: "rgb(74, 60, 20)", fg: "rgb(247, 213, 126)" });
    // 宿主给了纯文字、没给几段（181 号票之前的二狗网页）：照旧是字，没有名字标签
    await showBubble(page, { kind: "busy", fieldId: "", said: "", text: "二狗正忙，排在后面" });
    expect(await peekAll(page, ".thinking", "text")).toEqual(["二狗正忙，排在后面"]);
    expect(await countIn(page, ".thinking .name")).toBe(0);
    await page.close();
  });

  test("交来名字和颜色：各处换成起的名字、颜色是交来的（浅色深色各一对）；名字里的 <b> 也只是字；读屏说明是纯名字；宿主给的几段画成名字标签", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    const name = "<b>小美</b>";
    expect(await callJson(page, "texts", JSON.stringify(namedTexts(name, TAG)))).toEqual({ ok: true });
    expect(await ariaOf(page, ".fab")).toBe("让<b>小美</b>帮忙：点一下打字，按住说话");
    expect(await ariaOf(page, ".pick")).toBe("<b>小美</b>给的候选");
    await showBubble(page, { kind: "chooser", fieldId: "", text: "网页要你选图片" });
    expect(await ariaOf(page, ".bubble")).toBe(name);
    expect(await tagOf(page, ".label .name")).toMatchObject({ text: name, bg: "rgb(17, 34, 51)", fg: "rgb(221, 238, 255)", wrap: "nowrap" });
    expect(await peekAll(page, ".btn.primary", "text")).toEqual([`让${name}选`]);
    expect(await tagOf(page, ".btn.primary .name")).toMatchObject({ text: name, bg: "rgb(17, 34, 51)" });
    expect(await countIn(page, "b")).toBe(0);
    // 在想：宿主给的几段
    await showBubble(page, { kind: "busy", fieldId: "", said: "", text: `${name}正忙，排在后面`, textParts: [{ name }, "正忙，排在后面"] });
    expect(await peekAll(page, ".thinking", "text")).toEqual([`${name}正忙，排在后面`]);
    expect(await tagOf(page, ".thinking .name")).toMatchObject({ text: name, fg: "rgb(221, 238, 255)" });
    // 页面桥自己的"在想"
    await showBubble(page, { kind: "busy", fieldId: "", said: "", text: "" });
    expect(await peekAll(page, ".thinking", "text")).toEqual([`${name}在想……`]);
    // 挑图片窗口的标题
    const thumb = await redThumb(page);
    const title = `${name}给「上传照片」找了 3 个`;
    await showPick(page, { kind: "pick", id: "c-1", title, titleParts: [{ name }, "给「上传照片」找了 3 个"], note: "", files: pickFiles(thumb, ["t1"]), multiple: false, phase: "choosing" });
    expect(await peekAll(page, ".pick-title", "text")).toEqual([title]);
    expect(await tagOf(page, ".pick-title .name")).toMatchObject({ text: name, bg: "rgb(17, 34, 51)", fg: "rgb(221, 238, 255)" });
    expect(await countIn(page, "b")).toBe(0);
    // 深色：换交来的深色那一对
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await tagOf(page, ".pick-title .name")).toMatchObject({ bg: "rgb(51, 68, 85)", fg: "rgb(255, 238, 221)" });
    expect(await tagOf(page, ".thinking .name")).toMatchObject({ bg: "rgb(51, 68, 85)" });
    await page.close();
  });

  test("开着的气泡、挑图片窗口跟着改名字、换颜色；颜色交错了（不是 #rrggbb）不认，用经典的", async () => {
    const page = await open({ width: 390, height: 844, peek: true });
    expect(await callJson(page, "texts", JSON.stringify(namedTexts("小美", TAG)))).toEqual({ ok: true });
    await showBubble(page, { kind: "chooser", fieldId: "", text: "网页要你选图片" });
    const thumb = await redThumb(page);
    await showPick(page, { kind: "pick", id: "c-1", title: "小美给「上传照片」找了 3 个", titleParts: [{ name: "小美" }, "给「上传照片」找了 3 个"], note: "", files: pickFiles(thumb, ["t1"]), multiple: false, phase: "choosing" });
    expect(await tagOf(page, ".pick-title .name")).toMatchObject({ bg: "rgb(17, 34, 51)" });
    // 改名字、换风格（二狗的网页重交那几句）
    expect(await callJson(page, "texts", JSON.stringify(namedTexts("阿福", TAG2)))).toEqual({ ok: true });
    expect(await tagOf(page, ".label .name")).toMatchObject({ text: "阿福", bg: "rgb(194, 227, 223)", fg: "rgb(11, 79, 73)" });
    expect(await peekAll(page, ".bubble .btn.primary", "text")).toEqual(["让阿福选"]);
    expect(await ariaOf(page, ".bubble")).toBe("阿福");
    expect(await ariaOf(page, ".pick")).toBe("阿福给的候选");
    // 窗口的标题是宿主给的（随后照新名字重交）；颜色马上跟着
    expect(await tagOf(page, ".pick-title .name")).toMatchObject({ text: "小美", bg: "rgb(194, 227, 223)" });
    await showPick(page, { kind: "pick", id: "c-1", title: "阿福给「上传照片」找了 3 个", titleParts: [{ name: "阿福" }, "给「上传照片」找了 3 个"], note: "", files: pickFiles(thumb, ["t1"]), multiple: false, phase: "choosing" });
    expect(await tagOf(page, ".pick-title .name")).toMatchObject({ text: "阿福" });
    // 颜色交错了：不认，回到经典的；名字照样换
    const bad = { light: { bg: "red;} .bubble{display:none", fg: "#000" }, dark: { bg: "#000000", fg: "#ffffff" } };
    expect(await callJson(page, "texts", JSON.stringify(namedTexts("阿福", bad as typeof TAG)))).toEqual({ ok: true });
    expect(await tagOf(page, ".label .name")).toMatchObject({ text: "阿福", bg: "rgb(251, 227, 161)", fg: "rgb(92, 61, 0)" });
    expect(await bubbleOn(page)).toBe(true);
    await page.close();
  });
});
