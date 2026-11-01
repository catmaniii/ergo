// 模拟器联调的底座（349 号票）：起临时守护进程、起两个"外部网站"（不同来源）、记每一步的结果和截图。
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Device, sleep } from "./lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface TestDaemonHandle {
  local: string;
  external: string;
  send(command: string): void;
  /** 等 stdout 上满足条件的一行 JSON */
  waitLine(match: (line: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

export async function startDaemon(options: { fakeLsm?: boolean } = {}): Promise<TestDaemonHandle> {
  const env = options.fakeLsm ? { ...process.env, E2E_FAKE_LSM: "1" } : process.env;
  const child: ChildProcess = spawn(process.execPath, [path.join(HERE, "test-daemon.ts")], { cwd: HERE, stdio: ["pipe", "pipe", "ignore"], env });
  const lines: Array<Record<string, unknown>> = [];
  const reader = readline.createInterface({ input: child.stdout! });
  reader.on("line", (line) => {
    try {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 守护进程自己打的日志
    }
  });
  const waitLine = async (match: (line: Record<string, unknown>) => boolean, timeoutMs = 60_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const at = lines.findIndex(match);
      if (at >= 0) return lines.splice(at, 1)[0]!;
      if (Date.now() > until) throw new Error("等不到临时守护进程的回话");
      await sleep(100);
    }
  };
  const first = await waitLine((l) => typeof l.external === "string", 120_000);
  return {
    local: first.local as string,
    external: first.external as string,
    send: (command) => void child.stdin!.write(`${command}\n`),
    waitLine,
    async stop() {
      child.stdin!.write("stop\n");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 15_000);
      });
    },
  };
}

/** 一个"外部网站"：e2e 给的路径表，别的回 404。只听 127.0.0.1，模拟器经 adb reverse 过来 */
export interface FakeSite {
  origin: string;
  port: number;
  close(): void;
}

export type SiteRoutes = Record<string, { type: string; body: string | Buffer; headers?: Record<string, string> }>;

export function startSite(routes: (origin: string) => SiteRoutes): Promise<FakeSite> {
  return new Promise((resolve) => {
    let table: SiteRoutes = {};
    const server = http.createServer((req, res) => {
      const route = table[(req.url ?? "/").split("?")[0]!];
      if (!route) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": route.type, ...route.headers });
      res.end(route.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      table = routes(origin);
      resolve({ origin, port, close: () => server.close() });
    });
  });
}

/** 一步一步记结果：失败的记下原因接着往下（一次看全），最后按有没有失败定退出码 */
export class Run {
  readonly passed: string[] = [];
  readonly failed: Array<{ name: string; error: string }> = [];
  readonly shots: string[] = [];
  private readonly shotsDir: string | undefined;
  private readonly device: Pick<Device, "screenshot">;

  constructor(device: Pick<Device, "screenshot">, shotsDir: string | undefined) {
    this.device = device;
    this.shotsDir = shotsDir;
    if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  }

  async step(name: string, body: () => Promise<void> | void): Promise<void> {
    try {
      await body();
      this.passed.push(name);
      console.log(`  ok    ${name}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.failed.push({ name, error });
      console.log(`  FAIL  ${name}\n        ${error.split("\n").join("\n        ")}`);
    }
  }

  /** 截一张，存进截图目录（没给目录就不截） */
  shot(name: string): void {
    if (!this.shotsDir) return;
    const file = path.join(this.shotsDir, `${name}.png`);
    this.device.screenshot(file);
    this.shots.push(file);
  }

  /** 打印总结，返回退出码 */
  finish(): number {
    console.log(`\n通过 ${this.passed.length} 步，失败 ${this.failed.length} 步`);
    for (const f of this.failed) console.log(`  失败：${f.name}：${f.error.split("\n")[0]}`);
    return this.failed.length === 0 ? 0 : 1;
  }
}

/** 断言 */
export function expectEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}：想要 ${b}，实际 ${a}`);
}

export function expectTrue(value: unknown, what: string): void {
  if (!value) throw new Error(`${what}：不成立（${JSON.stringify(value)}）`);
}
