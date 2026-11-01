// 模拟器联调的小工具：adb（每条都带 -s 模拟器，绝不碰真机）、经 DevTools 协议（CDP）在 WebView 里跑脚本、读界面（uiautomator）。
// Node 22 自带 WebSocket，不加依赖。要 WebView 调试开着的包：npm run build:android -- --webview-debug（只给模拟器用）。
import { execFileSync } from "node:child_process";
import path from "node:path";

const SDK = process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
export const ADB = path.join(SDK, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
export const PACKAGE = "com.catmaniii.ergo";

/** 只认模拟器的串口：真机的串口不是这个样子，写错了在这里就停 */
export function assertEmulator(serial: string): string {
  if (!/^emulator-\d+$/.test(serial)) throw new Error(`只许用模拟器，不认这个设备：${serial}`);
  return serial;
}

export class Device {
  readonly serial: string;

  constructor(serial: string) {
    this.serial = assertEmulator(serial);
  }

  adb(...args: string[]): string {
    return execFileSync(ADB, ["-s", this.serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  }

  shell(command: string): string {
    return this.adb("shell", command);
  }

  /** 截图存到文件 */
  screenshot(file: string): void {
    execFileSync(ADB, ["-s", this.serial, "exec-out", "screencap", "-p"], { stdio: ["ignore", openWrite(file), "inherit"] });
  }

  /** 电脑上的端口接到模拟器的 127.0.0.1（App 里的地址规矩不用放宽：本机 http 本来就许可） */
  reverse(port: number): void {
    this.adb("reverse", `tcp:${port}`, `tcp:${port}`);
  }

  /** 现在界面上的元素（uiautomator）：文字、描述、坐标中心 */
  ui(): UiNode[] {
    const xml = this.shell("uiautomator dump /data/local/tmp/ergo-ui.xml >/dev/null 2>&1; cat /data/local/tmp/ergo-ui.xml");
    const nodes: UiNode[] = [];
    for (const m of xml.matchAll(/<node [^>]*?>/g)) {
      const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[0])?.[1] ?? "";
      const box = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr("bounds"));
      if (!box) continue;
      nodes.push({
        text: decodeXml(attr("text")),
        desc: decodeXml(attr("content-desc")),
        className: attr("class"),
        x: (Number(box[1]) + Number(box[3])) >> 1,
        y: (Number(box[2]) + Number(box[4])) >> 1,
        left: Number(box[1]),
        top: Number(box[2]),
        right: Number(box[3]),
        bottom: Number(box[4]),
      });
    }
    return nodes;
  }

  /** 等界面上出现这段字，返回它；等不到报错 */
  async waitText(text: string | RegExp, timeoutMs = 30_000): Promise<UiNode> {
    const match = (s: string) => (typeof text === "string" ? s.includes(text) : text.test(s));
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = this.ui().find((n) => match(n.text) || match(n.desc));
      if (found) return found;
      if (Date.now() > until) throw new Error(`界面上等不到：${String(text)}`);
      await sleep(500);
    }
  }

  tap(x: number, y: number): void {
    this.shell(`input tap ${x} ${y}`);
  }

  /** 按住一段时间再松手（长按悬浮按钮说话） */
  press(x: number, y: number, ms: number): void {
    this.shell(`input swipe ${x} ${y} ${x} ${y} ${ms}`);
  }

  /** 打字：只用来输地址这类 ASCII */
  type(text: string): void {
    this.shell(`input text '${text.replaceAll("'", "")}'`);
  }

  back(): void {
    this.shell("input keyevent KEYCODE_BACK");
  }

  pid(): string {
    return this.shell(`pidof ${PACKAGE}`).trim();
  }

  /** App 的日志：tag 是 ErgoApp 的 */
  appLog(): string {
    return this.adb("logcat", "-d", "-s", "ErgoApp:*");
  }
}

export interface UiNode {
  text: string;
  desc: string;
  className: string;
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function decodeXml(s: string): string {
  return s.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

import { closeSync, openSync } from "node:fs";

function openWrite(file: string): number {
  const fd = openSync(file, "w");
  setTimeout(() => closeSync(fd), 0);
  return fd;
}

/** 一个 CDP 目标：一个 WebView 里的一个页面 */
export interface CdpTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

/** 经 adb forward 接到 App 的 WebView 调试口 */
export class WebViews {
  private readonly port: number;

  private constructor(port: number) {
    this.port = port;
  }

  static async connect(device: Device, port: number): Promise<WebViews> {
    const until = Date.now() + 30_000;
    for (;;) {
      const pid = device.pid();
      if (pid) {
        try {
          device.adb("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
          const views = new WebViews(port);
          await views.targets();
          return views;
        } catch {
          // WebView 还没起来：再等
        }
      }
      if (Date.now() > until) throw new Error("连不上 App 的 WebView 调试口（包是不是带 --webview-debug 构建的？）");
      await sleep(500);
    }
  }

  async targets(): Promise<CdpTarget[]> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return (await res.json()) as CdpTarget[];
  }

  /** 等到网址满足条件的页面，连上 */
  async attach(match: (url: string) => boolean, timeoutMs = 30_000): Promise<Cdp> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const target = (await this.targets()).find((t) => match(t.url));
      if (target) return Cdp.open(target);
      if (Date.now() > until) throw new Error(`等不到这个页面（现有：${(await this.targets()).map((t) => t.url).join("、")}）`);
      await sleep(300);
    }
  }
}

/** 一条 CDP 连接 */
export class Cdp {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly events: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly url: string;

  private constructor(ws: WebSocket, url: string) {
    this.ws = ws;
    this.url = url;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (message.id !== undefined) {
        const entry = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) entry?.reject(new Error(message.error.message));
        else entry?.resolve(message.result);
      } else if (message.method) {
        this.events.push({ method: message.method, params: message.params ?? {} });
      }
    });
  }

  static open(target: CdpTarget): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.addEventListener("open", () => resolve(new Cdp(ws, target.url)));
      ws.addEventListener("error", () => reject(new Error(`连不上 ${target.url}`)));
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面主框架（或者给的执行上下文）里跑一段表达式，回它的值；Promise 会等 */
  async eval<T = unknown>(expression: string, contextId?: number): Promise<T> {
    const reply = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId === undefined ? {} : { contextId }) })) as {
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (reply.exceptionDetails) throw new Error(`页面里出错：${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    return reply.result.value as T;
  }

  /** 等一个条件（页面里的表达式）变真 */
  async waitFor(expression: string, timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval<boolean>(`(async () => !!(await (${expression})))()`).catch(() => false)) return;
      if (Date.now() > until) throw new Error(`等不到页面里的条件：${expression}`);
      await sleep(250);
    }
  }

  close(): void {
    this.ws.close();
  }
}
