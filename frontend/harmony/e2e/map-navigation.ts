// 用手机地图导航（票 434）在鸿蒙模拟器上的联调：网页地图卡片上点"用手机地图导航"，App 经原生桥的 openNavigation 拉起系统的
// "选导航应用"面板（startAbilityByType('navigation')）。
// 只连模拟器（hdc 目标 127.0.0.1:5555，下面卡着），不连真的二狗：App 的地址经联调的测试入口填成本机起的小网站，网站放的是
// 二狗的演示页（packages/web/dist-demo，全是编的数据，/api/access 回得像二狗）。模拟器能装不签名的包。先有一个开着、解了锁的模拟器，再：
//   npm run build:demo
//   npm run build:harmony -- --webview-debug
//   node frontend/harmony/e2e/map-navigation.ts [截图目录]
// 走一遍：原生桥有 openNavigation → 秘书会话里"从公司到西湖边"那张卡上是个按钮（不是网址） → 点了系统弹出选导航应用的面板
// （App 的日志里有 navigation panel opened，屏幕上多了面板的字；模拟器上没装地图 App，系统写"暂无可用导航方式"）→
// 返回手势收起面板，App 还在前台 →
// 直接调 openNavigation 交步行（路线规划那一种）、交坏的坐标回 bad。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectEqual, expectTrue, Run } from "../../android/e2e/harness.ts";
import { Cdp, type CdpTarget, sleep } from "../../android/e2e/lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAP = path.join(HERE, "..", "entry", "build", "default", "outputs", "default", "entry-default-unsigned.hap");
const DEMO = path.join(HERE, "..", "..", "..", "packages", "web", "dist-demo");
const BUNDLE = "com.catmaniii.ergo";
const TARGET = "127.0.0.1:5555";
const HDC = process.env.HDC ?? "D:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe";
const DEVTOOLS_PORT = 9338;
/** 演示页里那张路线卡（高德查的） */
const ROUTE_TITLE = "从公司到西湖边";

/** 模拟器：hdc 的每条都带 -t，只认本机这个端口（真机的串号不是这个样子） */
class Harmony {
  hdc(...args: string[]): string {
    return execFileSync(HDC, ["-t", TARGET, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  }

  shell(command: string): string {
    return this.hdc("shell", command);
  }

  screenshot(file: string): void {
    const remote = "/data/local/tmp/ergo-shot.png";
    this.shell(`uitest screenCap -p ${remote}`);
    this.hdc("file", "recv", remote, file);
  }

  reverse(port: number): void {
    this.hdc("rport", `tcp:${port}`, `tcp:${port}`);
  }

  pid(): string {
    return /(\d+)/.exec(this.shell(`pidof ${BUNDLE}`))?.[1] ?? "";
  }

  /** App 的日志（hilog 里 ErgoApp 的） */
  appLog(): string {
    return this.shell("hilog -x | grep ErgoApp");
  }

  /** 屏幕上现在的界面（uitest dumpLayout）：每个节点的字、位置 */
  layout(): Array<{ text: string; bounds: [number, number, number, number] }> {
    const remote = "/data/local/tmp/ergo-layout.json";
    this.shell(`uitest dumpLayout -p ${remote}`);
    const tree = JSON.parse(this.shell(`cat ${remote}`)) as LayoutNode;
    const out: Array<{ text: string; bounds: [number, number, number, number] }> = [];
    const walk = (n: LayoutNode) => {
      const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(n.attributes?.bounds ?? "");
      if (b) out.push({ text: n.attributes?.text ?? "", bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] });
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
    return out;
  }

  /** 点屏幕上写着这几个字的那一个（点中间）；没有回 false */
  tapText(text: string): boolean {
    const node = this.layout().find((n) => n.text === text);
    if (!node) return false;
    const [x1, y1, x2, y2] = node.bounds;
    this.shell(`uitest uiInput click ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
    return true;
  }

  /** 窗口管理的窗口表：名字、进程、ZOrd（藏起来的是 -1） */
  windows(): Array<{ name: string; pid: string; zOrder: number }> {
    const dump = this.shell("hidumper -s WindowManagerService -a '-a'");
    const rows: Array<{ name: string; pid: string; zOrder: number }> = [];
    for (const line of dump.split(/\r?\n/)) {
      const m = /^(\S+)\s+\d+\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(-?\d+)\s+/.exec(line);
      if (m) rows.push({ name: m[1]!, pid: m[2]!, zOrder: Number(m[4]) });
    }
    return rows;
  }
}

interface LayoutNode {
  attributes?: { text?: string; bounds?: string };
  children?: LayoutNode[];
}

const device = new Harmony();
const run = new Run(device, process.argv[2]);

/** 放演示页的小网站：dist-demo 下的文件照扩展名给类型，/api/access 回得像二狗（App 扫码连接时要测它） */
function startDemoSite(): Promise<{ origin: string; port: number; close(): void }> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      if (url === "/api/access") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"access":"none"}');
        return;
      }
      const file = path.join(DEMO, url === "/" ? "index.html" : url);
      if (!file.startsWith(DEMO) || !existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, port, close: () => (server.closeAllConnections(), server.close()) });
    });
  });
}

async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`等不到：${what}`);
    await sleep(400);
  }
}

/** 经 fport 接上 ArkWeb 的调试口（上一次联调留下的转发先清掉：进程号变了） */
async function attachWeb(match: (url: string) => boolean): Promise<Cdp> {
  const until = Date.now() + 40_000;
  for (;;) {
    try {
      for (const line of device.hdc("fport", "ls").split(/\r?\n/)) {
        const rule = /(tcp:\d+ localabstract:\S+)/.exec(line);
        if (rule) device.hdc("fport", "rm", rule[1]!);
      }
      device.hdc("fport", `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${device.pid()}`);
      const res = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
      const target = ((await res.json()) as CdpTarget[]).find((t) => match(t.url));
      if (target) return await Cdp.open(target);
    } catch {
      // 还没起来
    }
    if (Date.now() > until) throw new Error("连不上 App 的 ArkWeb 调试口（包是不是带 --webview-debug 构建的？）");
    await sleep(800);
  }
}

/** App 自己的窗口在最前面（没被面板盖住时的样子）：最上面那个可见窗口是不是 App 的 */
function appInFront(): boolean {
  const pid = device.pid();
  return pid.length > 0 && device.windows().some((w) => w.pid === pid && w.zOrder >= 0);
}

/**
 * 屏幕上现在有、before 里没有的字（状态栏的时间、电量这种数字不算）：面板是系统的 UIExtension，挂在 App 的窗口里画（不另开窗口、
 * 窗口表里看不出来），看它多出来的字认
 */
function newTexts(before: ReadonlySet<string>): string[] {
  return [...new Set(device.layout().map((n) => n.text))].filter((t) => t !== "" && !before.has(t) && !/^[\d\s:,]+$/.test(t));
}
const screenTexts = () => new Set(device.layout().map((n) => n.text));

const ROUTE_BUTTON = `[...document.querySelectorAll(".xcard-map[data-state=ready]")].find((c) => c.textContent.includes(${JSON.stringify(ROUTE_TITLE)}))?.querySelector("button.map-nav-btn[data-handoff=panel]")`;

let main: Cdp | undefined;
let site: { origin: string; port: number; close(): void } | undefined;
let exitCode = 1;

try {
  if (!existsSync(path.join(DEMO, "index.html"))) throw new Error("没有演示页：先 npm run build:demo");
  site = await startDemoSite();
  device.reverse(site.port);
  try {
    device.shell(`aa force-stop ${BUNDLE}`);
    device.shell(`bm uninstall -n ${BUNDLE}`);
  } catch {
    // 第一次装
  }
  console.log(device.hdc("install", "-r", HAP).trim().split("\n").at(-1));
  device.shell("hilog -G 16M");
  device.shell("hilog -r");
  device.shell(`aa start -a EntryAbility -b ${BUNDLE}`);
  await sleep(3000);

  await run.step("打开演示页：原生桥有 openNavigation；路线卡上是拉系统面板的按钮", async () => {
    device.shell(`aa start -a EntryAbility -b ${BUNDLE} --ps ergoTestScanText '${site!.origin}/'`);
    main = await attachWeb((url) => url.startsWith(site!.origin));
    await main.waitFor("window.ergoNative && typeof window.ergoNative.openNavigation === 'function'", 20_000);
    // 演示页一进来会要通知的授权（系统的对话框盖在最上面）：点"不允许"
    await sleep(2500);
    if (device.tapText("不允许")) await sleep(1000);
    await main.eval(`window.location.hash = "#/secretary"`);
    await main.waitFor(`!!(${ROUTE_BUTTON})`, 20_000);
    await main.eval(`(${ROUTE_BUTTON}).scrollIntoView({ block: "center" })`);
    expectEqual(await main.eval(`(${ROUTE_BUTTON}).textContent`), "用手机地图导航", "按钮上的字");
    await sleep(1500);
    run.shot("434-harmony-01-route-card");
  });

  let before = new Set<string>();
  let panelTexts: string[] = [];
  await run.step("点\"用手机地图导航\"：系统弹出选导航应用的面板（App 的日志里有 opened，屏幕上多了面板的字）", async () => {
    before = screenTexts();
    await main!.send("Runtime.evaluate", { expression: `(${ROUTE_BUTTON}).click()`, userGesture: true });
    await waitUntil("App 拉起了面板", () => /navigation panel (opened|failed|error|threw)/.test(device.appLog()), 10_000);
    const log = device.appLog();
    console.log(log.split("\n").filter((l) => l.includes("navigation panel")).slice(-4).join("\n"));
    expectTrue(/navigation panel opened: scene 2/.test(log), "面板拉起来了（导航那一种）");
    await sleep(2500);
    run.shot("434-harmony-02-navigation-panel");
    // 手机上装了能导航的地图 App 时面板里列着它们；模拟器上一个都没有，系统写"暂无可用导航方式"、给"前往应用市场"
    panelTexts = newTexts(before);
    console.log(`面板上的字：${panelTexts.join(" | ") || "（没有）"}`);
    expectTrue(panelTexts.length > 0, "面板出来了");
  });

  await run.step("返回手势收起面板，App 还在前台", async () => {
    device.shell("uitest uiInput keyEvent Back");
    await sleep(1500);
    await waitUntil("App 回到最前面", appInFront);
    expectEqual(newTexts(before).filter((t) => panelTexts.includes(t)), [], "面板收起了");
    run.shot("434-harmony-03-after-back");
  });

  await run.step("直接交步行（路线规划那一种）也拉得起来；坐标不对回 bad、不拉", async () => {
    expectEqual(await main!.eval(`window.ergoNative.openNavigation(1.2803, 103.8448, "Maxwell Food Centre", "walking")`), "ok", "步行");
    await waitUntil("路线规划", () => /navigation panel opened: scene 1/.test(device.appLog()));
    await sleep(2000);
    run.shot("434-harmony-04-route-plan-panel");
    expectTrue(newTexts(before).length > 0, "路线规划的面板出来了");
    device.shell("uitest uiInput keyEvent Back");
    await sleep(1500);
    expectEqual(await main!.eval(`window.ergoNative.openNavigation(999, 0, "", "driving")`), "bad", "坏坐标");
  });

  exitCode = run.finish();
} catch (e) {
  console.error("联调中止：", e);
} finally {
  main?.close();
  site?.close();
  try {
    device.hdc("fport", "rm", `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${device.pid()}`);
  } catch {
    // 没有这条转发
  }
}
process.exit(exitCode);
