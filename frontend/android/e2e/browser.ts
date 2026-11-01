// 安卓 App 内置浏览器的模拟器联调（第 3 阶段）：外部页面碰不到 ergoNative（安全要求的证明）、悬浮按钮、填表、选元素、交文件、
// 下载、能渲染的文件、⋮ 菜单。外部网页是本机起的假网站，不联网。只用模拟器，连临时守护进程。
//   npm run build:android -- --webview-debug
//   node frontend/android/e2e/browser.ts emulator-5570 [截图目录]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectEqual, expectTrue, Run, startDaemon, startSite, type TestDaemonHandle } from "./harness.ts";
import { Cdp, Device, PACKAGE, sleep, WebViews } from "./lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APK = path.join(HERE, "..", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

const device = new Device(process.argv[2] ?? "emulator-5570");
const run = new Run(device, process.argv[3]);
const CDP_PORT = 9334;

/** 查一个页面的全局对象里跟二狗有关的名字，以及几个绝不能有的对象（在哪个框架里跑都一样） */
const PROBE = `(function () {
  var names = Object.getOwnPropertyNames(window).filter(function (n) { return /ergo/i.test(n); }).sort();
  return { names: names, native: typeof window.ergoNative, side: typeof window.ergoSide, channel: typeof window.__ergoChannel };
})()`;
const CLEAN = { native: "undefined", side: "undefined", channel: "undefined" };

/** 外部网页主框架里只许看到页面桥的这几样；iframe 里连页面桥都没装，只有通道（没口令说什么都不认） */
const PAGE_NAMES = ["__ergoPage", "__ergoPageChannel", "ergoPageHost"];

function formPage(childOrigin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>外部测试页</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px sans-serif;margin:16px}label{display:block;margin:12px 0}input,textarea{display:block;width:80%;font-size:16px;padding:8px}a{display:block;margin:12px 0}iframe{width:90%;height:60px}</style></head>
<body><h1>外部测试页</h1>
<label>姓名<input id="name" name="name"></label>
<label>备注<textarea id="note"></textarea></label>
<label>头像<input id="file" type="file"></label>
<button id="go" type="button" onclick="document.title='clicked'">确定</button>
<a id="dl" href="/report.bin">下载文件</a>
<a id="md" href="/note.md">看 markdown</a>
<iframe id="child" src="${childOrigin}/child.html"></iframe>
<script>
document.cookie = 'site_cookie=1; path=/';
localStorage.setItem('site_store', '1');
window.__childReport = null;
addEventListener('message', function (e) { window.__childReport = e.data; });
</script></body></html>`;
}

/** 别的来源的 iframe：查自己的全局对象，报给父页面；再试着冒充页面桥说话 */
const CHILD_PAGE = `<!doctype html><meta charset="utf-8"><title>child</title><body>iframe<script>
var report = ${PROBE};
try { window.__ergoPageChannel && window.__ergoPageChannel.postMessage(JSON.stringify({ nonce: 'forged', type: 'open' })); report.posted = true; } catch (e) { report.posted = String(e); }
parent.postMessage(report, '*');
</script>`;

/** 假的外部网站：表单页、iframe、要下载的文件、markdown */
async function sites() {
  const child = await startSite(() => ({ "/child.html": { type: "text/html", body: CHILD_PAGE } }));
  const site = await startSite(() => ({
    "/form.html": { type: "text/html; charset=utf-8", body: formPage(child.origin) },
    "/page2.html": { type: "text/html; charset=utf-8", body: "<!doctype html><title>第二页</title><h1>第二页</h1>" },
    "/report.bin": { type: "application/octet-stream", body: Buffer.from("二狗下载测试"), headers: { "content-disposition": 'attachment; filename="report.bin"' } },
    "/note.md": { type: "text/markdown; charset=utf-8", body: "# 标题\n\n一段 markdown\n" },
  }));
  return { site, child };
}

/** 证书不受信任的网站（现生成的自签证书）：记下有没有连过来、有没有请求发到 */
async function startBadTls() {
  const dir = mkdtempSync(path.join(tmpdir(), "ergo-e2e-tls-"));
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  let requests = 0;
  let connections = 0;
  const server = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (_req, res) => {
    requests += 1;
    res.end("secret");
  });
  rmSync(dir, { recursive: true, force: true });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, requests: () => requests, connections: () => connections, close: () => server.close() };
}

/** 地址页上填地址、点连接 */
async function submitAddress(address: string): Promise<void> {
  const input = device.ui().find((n) => n.className.includes("EditText"));
  if (!input) throw new Error("地址页上找不到输入框");
  device.tap(input.x, input.y);
  await sleep(600);
  device.shell("input keycombination 113 29 && input keyevent 67");
  device.type(address);
  await sleep(400);
  device.shell("input keyevent 66");
}

/** 整个页面（含封闭的 shadow DOM）里找元素：class 里有这个词的第一个节点 */
interface DomNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  nodeValue?: string;
}

function findNode(node: DomNode, match: (n: DomNode) => boolean): DomNode | undefined {
  if (match(node)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findNode(child, match);
    if (found) return found;
  }
  return undefined;
}

const classOf = (n: DomNode): string[] => {
  const at = n.attributes?.indexOf("class") ?? -1;
  return at >= 0 ? (n.attributes![at + 1] ?? "").split(/\s+/) : [];
};

async function domTree(page: Cdp): Promise<DomNode> {
  return ((await page.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode }).root;
}

/** 元素中心的 CSS 坐标 */
async function centerOf(page: Cdp, node: DomNode): Promise<{ x: number; y: number }> {
  const box = (await page.send("DOM.getBoxModel", { nodeId: node.nodeId })) as { model: { content: number[] } };
  const q = box.model.content;
  return { x: (q[0]! + q[4]!) / 2, y: (q[1]! + q[5]!) / 2 };
}

/** 等到页面（含 shadow DOM）里有这样的元素 */
async function waitNode(page: Cdp, match: (n: DomNode) => boolean, what: string, timeoutMs = 15_000): Promise<DomNode> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = findNode(await domTree(page), match);
    if (found) return found;
    if (Date.now() > until) throw new Error(`页面里等不到：${what}`);
    await sleep(300);
  }
}

/** 页面上所有的字，含封闭的 shadow DOM */
async function pierceText(page: Cdp): Promise<string> {
  const root = (await page.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode & { nodeType?: number; nodeValue?: string } };
  const out: string[] = [];
  const walk = (n: DomNode & { nodeType?: number; nodeValue?: string }) => {
    if (n.nodeType === 3 && n.nodeValue) out.push(n.nodeValue);
    for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(child as DomNode & { nodeType?: number; nodeValue?: string });
  };
  walk(root.root);
  return out.join(" ");
}

async function touch(page: Cdp, x: number, y: number, holdMs = 60): Promise<void> {
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await sleep(holdMs);
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

let daemon: TestDaemonHandle | undefined;
let main: Cdp | undefined;
let page: Cdp | undefined;
let exitCode = 1;

try {
  daemon = await startDaemon();
  const devices = daemon;
  const { site: siteServer, child } = await sites();
  for (const port of [Number(new URL(daemon.external).port), siteServer.port, child.port]) device.reverse(port);
  // 外部网站用 localhost：和二狗（127.0.0.1）主机名不同，桌面版、清当前网站这些按主机名算的才测得到
  const site = { origin: siteServer.origin.replace("127.0.0.1", "localhost") };

  device.adb("install", "-r", APK);
  device.shell(`pm clear ${PACKAGE}`);
  // 配对后网页会要通知权限（系统框会挡住后面的界面）：先给上，要权限那一步单独测
  device.shell(`pm grant ${PACKAGE} android.permission.POST_NOTIFICATIONS`);
  device.shell(`pm grant ${PACKAGE} android.permission.RECORD_AUDIO`);
  device.adb("logcat", "-c");
  device.shell("cmd uimode night no");
  device.shell(`am start -W -n ${PACKAGE}/.MainActivity`);
  await device.waitText("Enter ergo's address");
  await submitAddress(`${daemon.external}/`);

  const views = await WebViews.connect(device, CDP_PORT);
  main = await views.attach((url) => url.startsWith(devices.external));
  const m = main;
  await m.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('请求配对') || b.textContent.includes('Request'))`);
  await m.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('请求配对') || b.textContent.includes('Request')).click()`);
  for (let i = 0; i < 20; i++) {
    devices.send("approve");
    if ((await devices.waitLine((l) => "approved" in l)).approved) break;
    await sleep(500);
  }
  await m.waitFor("fetch('/api/access').then(r => r.json()).then(j => j.access === 'device')", 40_000);
  await m.eval("location.reload()").catch(() => undefined);
  await sleep(2500);
  await m.waitFor("window.ergoNative && document.getElementById('root').childElementCount > 0");
  // 记下 App 推给网页的浏览器事件（交文件、查找、能渲染的文件要看）；先换掉网页的函数之前留着原来的
  const hook = `(function () {
    window.__e2eEvents = [];
    var inner = window.__ergoBrowser;
    window.__ergoBrowser = function (json) { var e = JSON.parse(json); if (e.type !== 'state') window.__e2eEvents.push(e); if (inner) inner(json); };
  })()`;
  await m.eval(`(() => { const x = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '×'); if (x) x.click(); })()`);
  await m.eval("location.hash = '#/browse'");
  await sleep(1500);
  await m.waitFor("!!window.__ergoBrowser");
  await m.eval(hook);

  console.log("打开外部网页");
  await run.step("网页的\"浏览\"页签开外部网页：内置浏览器摆在内容区，加载出来", async () => {
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${site.origin}/form.html`)})`);
    page = await views.attach((url) => url.startsWith(site.origin));
    await page.waitFor("document.readyState === 'complete'");
    await page.send("DOM.enable");
    await page.send("Runtime.enable");
    await sleep(800);
    run.shot("20-browser-form");
    expectEqual(await page.eval("document.title"), "外部测试页", "页面标题");
  });

  console.log("外部页面碰不到 ergoNative");
  await run.step("外部网页主框架：没有 ergoNative、ergoSide、通道，只有页面桥那几样", async () => {
    const seen = await page!.eval<Record<string, unknown>>(PROBE);
    expectEqual({ native: seen.native, side: seen.side, channel: seen.channel }, CLEAN, "原生桥的对象");
    expectEqual(seen.names, PAGE_NAMES, "全局对象里跟二狗有关的名字");
  });
  await run.step("外部网页里的 iframe（别的来源）：一样碰不到", async () => {
    await page!.waitFor("window.__childReport !== null");
    const seen = await page!.eval<Record<string, unknown>>("window.__childReport");
    expectEqual({ native: seen.native, side: seen.side, channel: seen.channel }, CLEAN, "iframe 里原生桥的对象");
  });
  await run.step("外部网页冒充页面桥（错的口令）：App 不认，二狗的网页什么都没收到；调页面桥的入口也不回东西", async () => {
    const before = await m.eval<number>("window.__e2eEvents.filter(e => e.type === 'page').length");
    await page!.eval("window.ergoPageHost.post(JSON.stringify({ nonce: 'forged', type: 'open', field: { id: 'f1', kind: 'text', label: 'x' }, page: { title: 't', url: location.href }, fields: [] }))");
    await sleep(800);
    expectTrue(/page message refused: bad nonce/.test(device.appLog()), "App 记下了拒绝");
    expectEqual(await m.eval("window.__e2eEvents.filter(e => e.type === 'page').length"), before, "二狗的网页收到的页面桥消息数");
    const forged = await page!.eval<string>("JSON.stringify(window.__ergoPage.fields('forged'))");
    expectTrue(!/"fields":\[/.test(forged), `错的口令拿不到框的列表（${forged}）`);
  });
  await run.step("外部网页读不到本机文件，也拿不到二狗的凭证和回话", async () => {
    const file = await page!.eval<string>("fetch('file:///etc/hosts').then(() => 'read', () => 'blocked')");
    expectEqual(file, "blocked", "读本机文件");
    expectTrue(!(await page!.eval<string>("document.cookie")).includes("__Host-"), "这个网页的 cookie 里没有设备凭证");
    const api = await page!.eval<string>(`fetch(${JSON.stringify(`${devices.external}/api/access`)}, { credentials: 'include' }).then((r) => r.text().then((t) => 'read:' + t.slice(0, 80)), () => 'blocked')`);
    expectEqual(api, "blocked", "带凭证请求二狗的接口");
  });
  await run.step("二狗的地址开在内置浏览器里：同样没有原生桥（原生桥挂在主界面那个 WebView 上）", async () => {
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${devices.external}/`)})`);
    await sleep(2500);
    const own = (await views.targets()).filter((t) => t.url.startsWith(devices.external));
    expectTrue(own.length >= 2, `两个 WebView 都开着二狗的地址（${own.length}）`);
    let checked = 0;
    for (const t of own) {
      if (t.url.includes("ergo=side")) continue;
      const c = await Cdp.open(t);
      const native = await c.eval<string>("typeof window.ergoNative");
      const channel = await c.eval<string>("typeof window.__ergoChannel");
      // 主界面那个有原生桥，内置浏览器那个没有：两个都查，恰好一个有
      if (native === "undefined") {
        expectEqual(channel, "undefined", "内置浏览器里的通道");
        checked += 1;
      }
      c.close();
    }
    expectEqual(checked, 1, "内置浏览器里开二狗的地址没有原生桥");
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${site.origin}/form.html`)})`);
    page?.close();
    await sleep(1500);
    page = await views.attach((url) => url.startsWith(site.origin));
    await page.waitFor("document.readyState === 'complete'");
    await page.send("DOM.enable");
    await page.send("Runtime.enable");
  });
  await run.step("主界面 WebView 里塞一个别的来源的 iframe：iframe 里也碰不到；同来源的 iframe 没有 ergoNative，通道发话也被拒", async () => {
    await m.send("Page.enable");
    await m.send("Page.setBypassCSP", { enabled: true });
    await m.eval("location.reload()").catch(() => undefined);
    await sleep(3000);
    await m.waitFor("!!window.ergoNative && !!window.__ergoBrowser");
    await m.eval(hook);
    const report = await m.eval<Record<string, unknown> | null>(`new Promise((resolve) => {
      addEventListener('message', (e) => { if (e.data && e.data.names) resolve(e.data); });
      const f = document.createElement('iframe');
      f.src = ${JSON.stringify(`${child.origin}/child.html`)};
      document.body.appendChild(f);
      setTimeout(() => resolve(null), 8000);
    })`);
    expectTrue(report !== null, "别的来源的 iframe 加载出来了（否则这步什么都没证明）");
    expectEqual({ native: report!.native, side: report!.side, channel: report!.channel }, CLEAN, "主界面里别的来源的 iframe");
    expectEqual(report!.names, [], "连名字都没有");
    const same = await m.eval<Record<string, unknown>>(`new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.srcdoc = '<!doctype html><title>x</title>';
      f.onload = () => {
        const w = f.contentWindow;
        const seen = { native: typeof w.ergoNative, channel: typeof w.__ergoChannel };
        if (w.__ergoChannel) w.__ergoChannel.postMessage(JSON.stringify({ m: 'editServer', a: [] }));
        resolve(seen);
      };
      document.body.appendChild(f);
    })`);
    expectEqual(same.native, "undefined", "同来源 iframe 里的 ergoNative");
    await sleep(800);
    expectTrue(!device.ui().some((n) => n.text.includes("填二狗的地址")), "iframe 发 editServer 没打开地址页");
    if (same.channel !== "undefined") expectTrue(/bridge refused: .*main frame false/.test(device.appLog()), "App 记下了拒绝");
  });
  await run.step("主界面跳外部网址：不在主界面打开，改到内置浏览器（主界面只显示二狗）", async () => {
    await m.eval(`location.href = ${JSON.stringify(`${site.origin}/page2.html`)}`).catch(() => undefined);
    await sleep(2500);
    expectTrue((await m.eval<string>("location.origin")) === devices.external, "主界面还在二狗的地址");
    expectTrue((await m.eval<number>("window.__e2eEvents.filter(e => e.type === 'open').length")) >= 1, "网页收到了 open");
    const moved = (await views.targets()).find((t) => t.url.endsWith("/page2.html"));
    expectTrue(moved, "内置浏览器开了这个地址");
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${site.origin}/form.html`)})`);
    page?.close();
    await sleep(1500);
    page = await views.attach((url) => url.includes("/form.html"));
    await page.waitFor("document.readyState === 'complete'");
    await page.send("DOM.enable");
    await page.send("Runtime.enable");
  });

  console.log("悬浮按钮");
  const fabFilter = (n: DomNode) => classOf(n).includes("fab") && classOf(n).includes("on");
  await run.step("点框：悬浮按钮出现", async () => {
    await m.eval("location.hash = '#/browse'");
    await sleep(800);
    await page!.eval("document.getElementById('name').scrollIntoView()");
    const input = await page!.eval<{ x: number; y: number }>("(() => { const r = document.getElementById('name').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await touch(page!, input.x, input.y);
    await waitNode(page!, fabFilter, "悬浮按钮");
    await sleep(400);
    run.shot("21-browser-fab");
  });
  await run.step("点悬浮按钮：气泡出来打字；发出去二狗回话", async () => {
    await sleep(1000);
    const fab = await waitNode(page!, fabFilter, "悬浮按钮");
    const at = await centerOf(page!, fab);
    await touch(page!, at.x, at.y);
    const box = await waitNode(page!, (n) => n.nodeName === "TEXTAREA" && !(n.attributes ?? []).includes("id"), "气泡里的输入框");
    await sleep(300);
    run.shot("22-browser-bubble-input");
    await page!.send("DOM.focus", { nodeId: box.nodeId });
    await page!.send("Input.insertText", { text: "帮我看看这个框" });
    await sleep(300);
    const send = await waitNode(page!, (n) => n.nodeName === "BUTTON" && classOf(n).some((c) => /send/.test(c)), "发送按钮");
    const sendAt = await centerOf(page!, send);
    await touch(page!, sendAt.x, sendAt.y);
    // 假模型的那句回话出现在气泡里：字在封闭的 shadow DOM 里，从 DOM 树上找
    const until = Date.now() + 40_000;
    let text = "";
    for (;;) {
      text = await pierceText(page!);
      if (text.includes("假模型")) break;
      if (Date.now() > until) throw new Error(`气泡里等不到二狗的回话（现在是：${text.slice(-200)}）`);
      await sleep(500);
    }
    expectTrue(!text.includes("要新版"), "不是在报 App 太旧");
    await sleep(500);
    run.shot("23-browser-bubble-reply");
  });
  await run.step("收气泡：返回键先收起气泡（不退网页历史）", async () => {
    device.back();
    await sleep(800);
    expectEqual(await page!.eval("document.title"), "外部测试页", "还在这一页");
    expectTrue((await m.eval<number>("window.__e2eEvents.filter(e => e.type === 'bubble-close').length")) >= 1, "网页收到 bubble-close");
  });

  console.log("填表、选元素、交文件");
  /** 经二狗的网页同一条路调页面桥（网页给秘书干活时走的也是它） */
  const bridgePage = (op: string, args: unknown[]) => m.eval<string>(`window.ergoNative.browserPage(${JSON.stringify(op)}, ${JSON.stringify(JSON.stringify(args))})`);
  let fields: Array<{ id: string; kind: string; label: string }> = [];
  await run.step("列框、填字：框里真的写进去了", async () => {
    fields = (JSON.parse(await bridgePage("fields", [])) as { fields: typeof fields }).fields;
    const name = fields.find((f) => f.label.includes("姓名"));
    expectTrue(name, `认出了姓名框（${JSON.stringify(fields)}）`);
    const filled = JSON.parse(await bridgePage("fill", [name!.id, "张三"])) as { ok: boolean };
    expectTrue(filled.ok, "fill 回 ok");
    expectEqual(await page!.eval("document.getElementById('name').value"), "张三", "框里的字");
  });
  await run.step("看能点的、按编号点：真的点到了", async () => {
    const snap = JSON.parse(await bridgePage("snapshot", ["50"])) as { ok: boolean; page: { url: string }; elements: Array<{ ref: string; text: string; role: string }> };
    expectTrue(snap.ok, "snapshot 回 ok");
    const button = snap.elements.find((e) => e.text.includes("确定"));
    expectTrue(button, "认出了确定按钮");
    const clicked = JSON.parse(await bridgePage("click", [button!.ref, snap.page.url])) as { ok: boolean };
    expectTrue(clicked.ok, "click 回 ok");
    await page!.waitFor("document.title === 'clicked'", 5000);
    await page!.eval("document.title = '外部测试页'");
  });
  const putFile = (id: string, text: string) => m.eval<string>(`window.ergoNative.browserFileChunk(${JSON.stringify(id)}, btoa(${JSON.stringify(text)}))`);
  await run.step("交文件进上传框（页面桥塞进 input.files）", async () => {
    const upload = fields.find((f) => f.kind === "file");
    expectTrue(upload, "认出了上传框");
    expectTrue((JSON.parse(await putFile("e2e-file-1", "hello ergo")) as { ok: boolean }).ok, "文件写进了缓存");
    const reply = JSON.parse(await m.eval<string>(`window.ergoNative.browserFiles(${JSON.stringify(JSON.stringify({ target: "field", fieldId: upload!.id, files: [{ id: "e2e-file-1", name: "a.txt", mime: "text/plain" }] }))})`)) as { ok: boolean };
    expectTrue(reply.ok, `交进去了（${JSON.stringify(reply)}）`);
    expectEqual(await page!.eval("(() => { const f = document.getElementById('file').files[0]; return f ? [f.name, f.size] : null; })()"), ["a.txt", 10], "input.files 里的文件");
  });
  await run.step("网页弹选文件对话框：App 拦下，告诉二狗的网页；二狗交的文件进了对话框", async () => {
    await page!.eval("document.getElementById('file').value = ''");
    const at = await page!.eval<{ x: number; y: number }>("(() => { const el = document.getElementById('file'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()");
    await sleep(300);
    await touch(page!, at.x, at.y);
    await m.waitFor("window.__e2eEvents.some(e => e.type === 'chooser')", 8000);
    await sleep(600);
    run.shot("24-browser-chooser");
    expectTrue((JSON.parse(await putFile("e2e-file-2", "chooser file")) as { ok: boolean }).ok, "文件写进了缓存");
    const reply = JSON.parse(await m.eval<string>(`window.ergoNative.browserFiles(${JSON.stringify(JSON.stringify({ target: "chooser", files: [{ id: "e2e-file-2", name: "b.txt", mime: "text/plain" }] }))})`)) as { ok: boolean };
    expectTrue(reply.ok, `交给对话框了（${JSON.stringify(reply)}）`);
    await page!.waitFor("document.getElementById('file').files.length === 1", 8000);
    expectEqual(await page!.eval("(() => { const f = document.getElementById('file').files[0]; return [f.name, f.size]; })()"), ["b.txt", 12], "对话框交进去的文件");
  });
  await run.step("气泡上点\"自己选\"：系统的选文件界面起来，取消了网页照常；返回键收起气泡，对话框跟着关", async () => {
    const pressFile = async () => {
      await m.eval("window.__e2eEvents.length = 0");
      await page!.eval("document.getElementById('file').value = ''");
      const at = await page!.eval<{ x: number; y: number }>("(() => { const el = document.getElementById('file'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()");
      await sleep(300);
      await touch(page!, at.x, at.y);
      await m.waitFor("window.__e2eEvents.some(e => e.type === 'chooser')", 8000);
    };
    // 上一步直接把文件交给了对话框，气泡还留着：先收起来，从干净的样子开始
    const isMine = (n: DomNode) => n.nodeName === "BUTTON" && (n.children ?? []).some((c) => c.nodeValue === "自己选");
    if (findNode(await domTree(page!), isMine)) {
      device.back();
      await sleep(1200);
    }
    await pressFile();
    await sleep(1000);
    // 用户真实走的路：气泡画在封闭的 shadow DOM 里，从 DOM 树上找那个按钮
    const mine = await waitNode(page!, isMine, "气泡上的自己选");
    const at = await centerOf(page!, mine);
    run.shot("24a-chooser-before-pick");
    await touch(page!, at.x, at.y);
    // 看系统的哪个界面在最上面，不看字：页面上的"下载文件"也算字，会假通过
    const until = Date.now() + 15_000;
    while (!/topResumedActivity=.*(documentsui|photopicker|mediaprovider)/i.test(device.shell("dumpsys activity activities"))) {
      if (Date.now() > until) throw new Error(`系统的选文件界面没起来；网页收到：${JSON.stringify(await m.eval("window.__e2eEvents"))}；最上面：${/topResumedActivity=.*/.exec(device.shell("dumpsys activity activities"))?.[0] ?? ""}`);
      await sleep(500);
    }
    await sleep(800);
    run.shot("24b-system-file-picker");
    device.back();
    await sleep(1500);
    expectEqual(await page!.eval("document.getElementById('file').files.length"), 0, "取消了没有文件");
    // 气泡开着时又点一次上传框：网页为旧气泡发的取消晚到，不能把新的对话框关了
    await pressFile();
    await sleep(1000);
    await pressFile();
    await sleep(1000);
    const startsBefore = (device.adb("logcat", "-d").match(/START u0 \{act=android\.intent\.action\.OPEN_DOCUMENT/g) ?? []).length;
    const second = await waitNode(page!, isMine, "气泡上的自己选");
    const secondAt = await centerOf(page!, second);
    await touch(page!, secondAt.x, secondAt.y);
    const secondUntil = Date.now() + 10_000;
    while ((device.adb("logcat", "-d").match(/START u0 \{act=android\.intent\.action\.OPEN_DOCUMENT/g) ?? []).length <= startsBefore) {
      if (Date.now() > secondUntil) throw new Error("再点一次之后，自己选开不了系统的选文件界面");
      await sleep(300);
    }
    await sleep(1000);
    device.back();
    await sleep(1500);
    await pressFile();
    await sleep(1000);
    device.back();
    await sleep(800);
    const again = JSON.parse(await m.eval<string>("window.ergoNative.browserChooser('cancel')")) as { ok: boolean };
    expectEqual(again.ok, false, "对话框已经关了，再答话有说明");
  });
  await run.step("放掉预备好了没用上的文件", async () => {
    await putFile("e2e-file-3", "unused");
    const reply = JSON.parse(await m.eval<string>(`window.ergoNative.browserDiscard(${JSON.stringify(JSON.stringify(["e2e-file-3", "not-staged"]))})`)) as { ok: boolean; count: number };
    expectEqual([reply.ok, reply.count], [true, 1], "删了一个");
  });
  await run.step("按住悬浮按钮说话：录音器开始、松手交出录音（真人说话留给真机）", async () => {
    const input = await page!.eval<{ x: number; y: number }>("(() => { const el = document.getElementById('note'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await sleep(300);
    await touch(page!, input.x, input.y);
    await sleep(1200);
    const fab = await waitNode(page!, fabFilter, "悬浮按钮");
    const at = await centerOf(page!, fab);
    const takesBefore = (device.appLog().match(/voice take:/g) ?? []).length;
    await page!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await sleep(1800);
    run.shot("25-browser-fab-listening");
    await page!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(1500);
    const takes = (device.appLog().match(/voice take:/g) ?? []).length;
    expectTrue(takes > takesBefore, "App 交出了这一段录音");
  });

  console.log("侧边栏");
  /** 把"浏览"页的侧边栏打开：点页面上那个按钮 */
  const openSide = async () => {
    await m.waitFor("document.querySelector('[data-browse-side-toggle], .browse-side-toggle, [aria-label*=侧边栏]')", 8000);
    await m.eval("document.querySelector('[data-browse-side-toggle], .browse-side-toggle, [aria-label*=侧边栏]').click()");
  };
  let sidePage: Cdp | undefined;
  await run.step("窄屏打开侧边栏：另一个 WebView 加载 ?ergo=side，整屏盖住，能认出在 App 里", async () => {
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${site.origin}/form.html`)})`);
    await sleep(1200);
    await openSide();
    sidePage = await views.attach((url) => url.includes("ergo=side"), 20_000);
    await sidePage.waitFor("window.ergoNative && document.getElementById('root').childElementCount > 0", 20_000);
    await sleep(1200);
    run.shot("30-side-phone");
  });
  await run.step("侧边栏只有一小份原生桥：版本号、日志、录音；没有地址页、浏览器；ergoSide 有三个方法", async () => {
    const keys = await sidePage!.eval<string[]>("Object.keys(window.ergoNative).sort()");
    expectEqual(keys, ["appVersion", "log", "voiceDiscard", "voicePrepare", "voiceRelease", "voiceStart", "voiceStop"], "侧边栏原生桥的方法");
    expectEqual(await sidePage!.eval("Object.keys(window.ergoSide).sort()"), ["clearSelection", "close", "ready"], "ergoSide 的方法");
    const reply = JSON.parse(await sidePage!.eval<string>("window.ergoNative.voicePrepare(false)")) as { ok: boolean };
    expectTrue(reply.ok, "侧边栏能备好原生录音");
    await sidePage!.eval("window.ergoNative.voiceRelease()");
  });
  await run.step("侧边栏里点外部链接：改到内置浏览器打开，侧边栏还在二狗的地址，告诉网页收起", async () => {
    await m.eval("window.__e2eEvents.length = 0");
    await sidePage!.eval(`location.href = ${JSON.stringify(`${site.origin}/page2.html`)}`).catch(() => undefined);
    await m.waitFor("window.__e2eEvents.some(e => e.type === 'side' && e.action === 'link')", 10_000);
    expectEqual(await sidePage!.eval("location.origin"), devices.external, "侧边栏还在二狗的地址");
    await sleep(800);
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${site.origin}/form.html`)})`);
    await sleep(1000);
  });
  await run.step("返回键先收侧边栏（滑出去），再是别的", async () => {
    await m.eval("window.__e2eEvents.length = 0");
    const open = await m.eval<boolean>("!!document.querySelector('[data-browse-side-toggle], .browse-side-toggle, [aria-label*=侧边栏]')");
    if (open) await openSide();
    await sleep(600);
    device.back();
    await m.waitFor("window.__e2eEvents.some(e => e.type === 'side' && e.action === 'close')", 8000);
    await sleep(600);
    run.shot("31-side-closed");
  });
  await run.step("宽屏（平板尺寸）：侧边栏在右边一块，浏览器让出位置（挤压）", async () => {
    device.shell("wm size 1600x2560");
    device.shell("wm density 240");
    try {
      await sleep(2500);
      await m.eval(`location.hash = '#/browse'`);
      await sleep(800);
      run.shot("32-browser-tablet");
      await openSide();
      await sleep(1500);
      run.shot("33-side-tablet");
      const web = device.ui().filter((n) => n.className.includes("WebView"));
      expectTrue(web.length >= 2, "几个 WebView 在界面上");
      const widths = web.map((n) => n.right - n.left);
      expectTrue(widths.some((w) => w < 1400), `侧边栏不是整屏（${JSON.stringify(widths)}）`);
      device.back();
      await sleep(800);
    } finally {
      device.shell("wm size reset");
      device.shell("wm density reset");
    }
    await sleep(2500);
  });
  sidePage?.close();

  console.log("下载、能渲染的文件");
  await run.step("网页上点下载：下到缓存，弹系统的保存，存好有提示，进下载记录", async () => {
    await m.eval("window.ergoNative.browserTool('downloads', '{}')");
    await page!.eval("document.getElementById('dl').scrollIntoView({ block: 'center' })");
    await sleep(200);
    const at = await page!.eval<{ x: number; y: number }>("(() => { const r = document.getElementById('dl').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()");
    await touch(page!, at.x, at.y);
    await device.waitText(/^(SAVE|Save|保存)$/, 20_000);
    await sleep(2500);
    run.shot("26-download-save-picker");
    const save = await device.waitText(/^(SAVE|Save|保存)$/, 5000);
    const toastsBefore = (device.appLog().match(/toast shown/g) ?? []).length;
    device.tap(save.x, save.y);
    // 轻提示只停 2.5 秒，读界面太慢赶不上：看 App 记没记，一有就截图
    const until = Date.now() + 15_000;
    while ((device.appLog().match(/toast shown/g) ?? []).length <= toastsBefore) {
      if (Date.now() > until) throw new Error("存好后没有提示");
      await sleep(100);
    }
    await sleep(200);
    run.shot("26b-download-saved-toast");
    await m.waitFor("window.ergoNative.browserTool('downloads', '{}').then(t => JSON.parse(t).downloads.length > 0)", 15_000);
    const list = JSON.parse(await m.eval<string>("window.ergoNative.browserTool('downloads', '{}')")) as { downloads: Array<{ id: string; name: string; size: number; uri: string }> };
    expectTrue(list.downloads[0]?.name === "report.bin", `下载记录里有它（${JSON.stringify(list.downloads[0])}）`);
    expectEqual(list.downloads[0]?.size, Buffer.byteLength("二狗下载测试"), "大小");
    const removed = JSON.parse(await m.eval<string>(`window.ergoNative.browserTool('removeDownloads', ${JSON.stringify(JSON.stringify({ ids: [list.downloads[0]!.id] }))})`)) as { ok: boolean };
    expectTrue(removed.ok, "删记录");
  });
  await run.step("能渲染的文件：浏览器开 markdown，App 报类型给网页，取得到内容", async () => {
    await m.eval("window.ergoNative.browserDoc('enable', '')");
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${site.origin}/note.md`)})`);
    await m.waitFor("window.__e2eEvents.some(e => e.type === 'document' && /note\\.md$/.test(e.doc.url))", 15_000);
    const doc = await m.eval<{ id: string; mime: string; via: string }>("window.__e2eEvents.filter(e => e.type === 'document' && /note\\.md$/.test(e.doc.url)).pop().doc");
    expectTrue(doc.mime.includes("markdown"), `类型报对了（${doc.mime}）`);
    const source = JSON.parse(await m.eval<string>(`window.ergoNative.browserDoc('source', ${JSON.stringify(doc.id)})`)) as { ok: boolean; text?: string };
    expectTrue(source.ok && source.text?.includes("一段 markdown"), `取到内容（${JSON.stringify(source).slice(0, 120)}）`);
    await sleep(800);
    run.shot("27-browser-file-doc");
  });

  console.log("⋮ 菜单的原生能力");
  await run.step("页内查找：结果推给网页；返回键先收查找栏", async () => {
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${site.origin}/form.html`)})`);
    await sleep(1500);
    page?.close();
    page = await views.attach((url) => url.includes("/form.html"));
    await page.waitFor("document.readyState === 'complete'");
    await page.send("DOM.enable");
    await page.send("Runtime.enable");
    await m.eval("window.__e2eEvents.length = 0");
    await m.eval(`window.ergoNative.browserTool('findBar', '{"open":true}')`);
    await m.eval(`window.ergoNative.browserTool('find', ${JSON.stringify(JSON.stringify({ text: "外部测试页" }))})`);
    await m.waitFor("window.__e2eEvents.some(e => e.type === 'find' && e.total >= 1 && e.done)", 8000);
    await sleep(300);
    run.shot("28-browser-find");
    device.back();
    await m.waitFor("window.__e2eEvents.some(e => e.type === 'find-close')", 5000);
    await m.eval(`window.ergoNative.browserTool('findClear', '{}')`);
  });
  await run.step("按网站的文字大小、桌面版：只影响内置浏览器这一个网站，二狗不受影响", async () => {
    const host = new URL(site.origin).hostname;
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
    const before = await page!.eval<string>("navigator.userAgent");
    expectTrue(/Android/.test(before), "开始是手机的标识");
    const reply = JSON.parse(await m.eval<string>(`window.ergoNative.browserTool('sites', ${JSON.stringify(JSON.stringify({ zoom: { [host]: 150 }, desktopUserAgent: ua, desktop: [host] }))})`)) as { ok: boolean };
    expectTrue(reply.ok, "sites 回 ok");
    await m.eval("window.ergoNative.browserNav('reload')");
    await sleep(2500);
    page?.close();
    page = await views.attach((url) => url.includes("/form.html"));
    await page.waitFor("document.readyState === 'complete'");
    await page.send("DOM.enable");
    await page.send("Runtime.enable");
    expectEqual(await page.eval("navigator.userAgent"), ua, "这个网站换成了桌面版的标识");
    expectTrue(/Android/.test(await m.eval<string>("navigator.userAgent")), "二狗的网页还是手机的标识");
    await m.eval(`window.ergoNative.browserTool('sites', ${JSON.stringify(JSON.stringify({ zoom: {}, desktopUserAgent: ua, desktop: [] }))})`);
    await m.eval("window.ergoNative.browserNav('reload')");
    await sleep(2000);
    page?.close();
    page = await views.attach((url) => url.includes("/form.html"));
    await page.waitFor("document.readyState === 'complete'");
    await page.send("DOM.enable");
    await page.send("Runtime.enable");
  });
  await run.step("分享：系统的分享面板起来", async () => {
    const reply = JSON.parse(await m.eval<string>(`window.ergoNative.browserTool('share', ${JSON.stringify(JSON.stringify({ title: "外部测试页", url: `${site.origin}/form.html` }))})`)) as { ok: boolean };
    expectTrue(reply.ok, "share 回 ok");
    await sleep(1500);
    run.shot("29-share-sheet");
    device.back();
    await sleep(800);
  });
  await run.step("清全部 Cookie 和网站数据：外部网站的没了，二狗的设备凭证和本地存储还在", async () => {
    await m.eval("localStorage.setItem('e2e_own', '1')");
    const cookiesBefore = await page!.eval<string>("document.cookie");
    expectTrue(cookiesBefore.includes("site_cookie=1"), `外部网站有 cookie（${cookiesBefore}）`);
    const reply = JSON.parse(await m.eval<string>(`window.ergoNative.browserTool('clear', ${JSON.stringify(JSON.stringify({ cache: true, cookies: true, scope: "all", url: "" }))})`)) as { ok: boolean; notes: string[] };
    expectTrue(reply.ok, `clear 回 ok（${JSON.stringify(reply)}）`);
    await sleep(1000);
    expectEqual(await page!.eval("document.cookie.includes('site_cookie')"), false, "外部网站的 cookie 没了");
    await m.waitFor("fetch('/api/access').then(r => r.json()).then(j => j.access === 'device')", 10_000);
    expectEqual(await m.eval("localStorage.getItem('e2e_own')"), "1", "二狗的本地存储还在");
    const cookies = (await m.send("Network.getCookies", { urls: [`${devices.external}/`] })) as { cookies: Array<{ name: string; secure: boolean; httpOnly: boolean; sameSite: string }> };
    const own = cookies.cookies.find((c) => c.name.startsWith("__Host-"));
    expectTrue(own, "设备凭证还在");
    expectEqual([own!.secure, own!.httpOnly, own!.sameSite], [true, true, "Strict"], "写回去的凭证没被削弱");
  });
  await run.step("只清当前网站：二狗自己的页面不清（清了会掉线），有提示", async () => {
    const reply = JSON.parse(await m.eval<string>(`window.ergoNative.browserTool('clear', ${JSON.stringify(JSON.stringify({ cache: false, cookies: true, scope: "site", url: `${devices.external}/` }))})`)) as { ok: boolean; notes: string[] };
    expectTrue(reply.notes.length === 1, `有一句说明（${JSON.stringify(reply.notes)}）`);
    await m.waitFor("fetch('/api/access').then(r => r.json()).then(j => j.access === 'device')", 10_000);
  });
  await run.step("返回键：浏览器里有历史先退一页", async () => {
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`${site.origin}/page2.html`)})`);
    await sleep(1500);
    device.back();
    await sleep(1500);
    expectTrue((await views.targets()).some((t) => t.url.includes("/form.html")), "退回了上一页");
  });
  await run.step("打不开的文件协议：内置浏览器只开 http、https", async () => {
    await m.eval("window.ergoNative.browserLoad('file:///etc/hosts')");
    await sleep(800);
    expectTrue(!(await views.targets()).some((t) => t.url.startsWith("file:")), "没开 file:");
    expectTrue(/browser refused to load a non-web url/.test(device.appLog()), "App 拒了");
  });

  await run.step("证书错误不放行：自签证书的网站打不开，请求发不出去", async () => {
    const bad = await startBadTls();
    device.reverse(bad.port);
    await m.eval(`window.ergoNative.browserLoad(${JSON.stringify(`https://localhost:${bad.port}/secret.html`)})`);
    const until = Date.now() + 10_000;
    while (bad.connections() === 0 && Date.now() < until) await sleep(200);
    await sleep(1500);
    expectTrue(bad.connections() > 0, "WebView 确实去连了（否则这步什么都没证明）");
    expectEqual(bad.requests(), 0, "发到网站的请求数");
    bad.close();
  });
  console.log(device.appLog().split("\n").filter((l) => /FATAL|refused/.test(l)).slice(-6).join("\n"));
  exitCode = run.finish();
  siteServer.close();
  child.close();
} catch (e) {
  console.error("联调中止：", e);
} finally {
  page?.close();
  main?.close();
  await daemon?.stop();
}
process.exit(exitCode);
