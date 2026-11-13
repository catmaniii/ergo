// 网页渲染进程没了、卡住了 App 自己救回来（票 389）在鸿蒙模拟器上的联调。
// 用户手机上抓到的：后台放久了系统收掉 ArkWeb 的渲染进程（com.catmaniii.ergo:render），App 停在最后一帧点不动。
// 真机上 shell 结束不了 App 的进程，这里经 ArkWeb 调试口让渲染进程崩掉（CDP Page.crash），看 App 自己重载。
// （网页死循环卡住的渲染进程不在这里：terminateRenderProcess 回成功但模拟器上进程还在，App 救不回来，见 common/RenderWatch.ets）
// 只连模拟器（hdc 目标 127.0.0.1:5555），App 的地址经联调的测试入口填成本机起的小网站（/api/access 回得像二狗）。
// 先有一个开着、解了锁的模拟器，再：
//   npm run build:harmony -- --webview-debug
//   node frontend/harmony/e2e/render-recovery.ts [截图目录]
// 走一遍：前台时渲染进程崩了 → 马上重载；退到后台时崩了 → 回到前台重载；好好的切后台再回来 → 只探一下，不重载。
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectTrue, Run } from "../../android/e2e/harness.ts";
import { Cdp, type CdpTarget, sleep } from "../../android/e2e/lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAP = process.env.HAP ?? path.join(HERE, "..", "entry", "build", "default", "outputs", "default", "entry-default-unsigned.hap");
const BUNDLE = "com.catmaniii.ergo";
const TARGET = "127.0.0.1:5555";
const HDC = process.env.HDC ?? "D:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe";
const DEVTOOLS_PORT = 9338;

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

  pid(): string {
    return /(\d+)/.exec(this.shell(`pidof ${BUNDLE}`))?.[1] ?? "";
  }

  /** 渲染进程（ArkWeb 的 <包名>:render）的进程号；没有是空串 */
  renderPid(): string {
    return /(\d+)/.exec(this.shell(`pidof ${BUNDLE}:render`))?.[1] ?? "";
  }

  /** App 自己记的日志（hilog 里 ErgoApp 的） */
  appLog(): string {
    return this.shell("hilog -x | grep ErgoApp");
  }
}

const device = new Harmony();
const run = new Run(device, process.argv[2]);

/** 测试页：每加载一次换一个编号（重载了没有，看它变没变）；/api/access 回得像二狗 */
function startSite(): Promise<{ origin: string; port: number; loads: () => number; close(): void }> {
  let loads = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0]!;
      if (url === "/api/access") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"access":"none"}');
        return;
      }
      if (url === "/") {
        loads += 1;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>render watch</title>
<body style="font:24px sans-serif;padding:24px"><h1>第 ${loads} 次加载</h1><script>window.loadNo = ${loads};</script></body>`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ origin: `http://127.0.0.1:${port}`, port, loads: () => loads, close: () => server.close() });
    });
  });
}

async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`等不到：${what}`);
    await sleep(400);
  }
}

/** 经 fport 接上 ArkWeb 的调试口，找到测试页（渲染进程换过之后要重新接） */
async function attachPage(origin: string): Promise<Cdp> {
  const until = Date.now() + 40_000;
  for (;;) {
    try {
      for (const line of device.hdc("fport", "ls").split(/\r?\n/)) {
        const rule = /(tcp:\d+ localabstract:\S+)/.exec(line);
        if (rule) device.hdc("fport", "rm", rule[1]!);
      }
      device.hdc("fport", `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${device.pid()}`);
      const res = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
      const target = ((await res.json()) as CdpTarget[]).find((t) => t.url.startsWith(origin));
      if (target) {
        const page = await Cdp.open(target);
        if ((await page.eval<number | undefined>("window.loadNo").catch(() => undefined)) !== undefined) return page;
        page.close();
      }
    } catch {
      // 还没起来
    }
    if (Date.now() > until) throw new Error("连不上 App 的 ArkWeb 调试口（包是不是带 --webview-debug 构建的？）");
    await sleep(800);
  }
}

/** 日志里这一行之后出现的（每一步只看自己那一段） */
function logSince(mark: number): string {
  return device.appLog().split("\n").slice(mark).join("\n");
}

function logLines(): number {
  return device.appLog().split("\n").length - 1;
}

function appInFront(): boolean {
  const pid = device.pid();
  return pid.length > 0 && /Ability onForeground/.test(device.appLog().split("\n").filter((l) => /Ability on(Fore|Back)ground/.test(l)).at(-1) ?? "");
}

/** 让渲染进程崩掉：Page.crash 没有回话，不等 */
function crash(page: Cdp): void {
  page.send("Page.crash").catch(() => {});
}

let page: Cdp | undefined;
let site: Awaited<ReturnType<typeof startSite>> | undefined;
let exitCode = 1;

try {
  site = await startSite();
  device.hdc("rport", `tcp:${site.port}`, `tcp:${site.port}`);
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

  await run.step("打开测试页", async () => {
    device.shell(`aa start -a EntryAbility -b ${BUNDLE} --ps ergoTestScanText '${site!.origin}/'`);
    page = await attachPage(site!.origin);
    expectTrue(device.renderPid().length > 0, "有渲染进程");
    run.shot("render-01-open");
  });

  await run.step("在前台时渲染进程崩了：App 马上重载，页面回来", async () => {
    const mark = logLines();
    const before = site!.loads();
    const oldRender = device.renderPid();
    crash(page!);
    page!.close();
    await waitUntil("App 收到渲染进程没了", () => /main web: render process exited/.test(logSince(mark)));
    await waitUntil("重新加载了测试页", () => site!.loads() > before);
    await waitUntil("App 记下救回来了", () => /main web: recovered/.test(logSince(mark)));
    page = await attachPage(site!.origin);
    expectTrue((await page.eval<number>("window.loadNo")) > before, "页面是新加载的");
    expectTrue(device.renderPid() !== oldRender && device.renderPid().length > 0, "换了一个新的渲染进程");
    console.log(logSince(mark).split("\n").filter((l) => l.includes(" web: ")).join("\n"));
    run.shot("render-02-crash-foreground");
  });

  await run.step("退到后台时渲染进程崩了：在后台不动，回到前台再重载", async () => {
    const mark = logLines();
    device.shell("uitest uiInput keyEvent Home");
    await waitUntil("App 退到后台", () => /Ability onBackground/.test(logSince(mark)));
    const before = site!.loads();
    crash(page!);
    page!.close();
    await sleep(4000);
    expectTrue(site!.loads() === before, "在后台没有重载");
    device.shell(`aa start -a EntryAbility -b ${BUNDLE}`);
    await waitUntil("回到前台", appInFront);
    await waitUntil("重新加载了测试页", () => site!.loads() > before);
    await waitUntil("App 记下救回来了", () => /main web: recovered/.test(logSince(mark)));
    page = await attachPage(site!.origin);
    expectTrue((await page.eval<number>("window.loadNo")) > before, "页面是新加载的");
    console.log(logSince(mark).split("\n").filter((l) => l.includes(" web: ")).join("\n"));
    run.shot("render-03-crash-background");
  });

  await run.step("好好的切后台再回来：只探一下，不重载", async () => {
    const mark = logLines();
    const before = site!.loads();
    device.shell("uitest uiInput keyEvent Home");
    await waitUntil("App 退到后台", () => /Ability onBackground/.test(logSince(mark)));
    await sleep(1500);
    device.shell(`aa start -a EntryAbility -b ${BUNDLE}`);
    await waitUntil("回到前台", appInFront);
    await sleep(8000);
    expectTrue(site!.loads() === before, "没有重载");
    expectTrue(!/main web: .*try/.test(logSince(mark)), "没有去救");
  });

  exitCode = run.finish();
} catch (e) {
  console.error("联调中止：", e);
} finally {
  page?.close();
  site?.close();
  try {
    device.hdc("fport", "rm", `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${device.pid()}`);
  } catch {
    // 没有这条转发
  }
}
process.exit(exitCode);
