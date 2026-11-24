// 服务首页的缩略图真的截一张：**要本机的浏览器**（照 web/recorded-results.browser.test.ts：按二狗同样的顺序找，
// 找不到的跳过，原因写进测试报告）。起一个本机的小页面当"服务的首页"，用正式的驱动（playwrightDriver）和正式的截法
// （captureServiceHome）截下来：是 JPEG、640×400（1280×800 排版、0.5 倍出图）；打不开的页面（404）算没截成。不连外网。
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureServiceHome } from "../../src/project-services/index.ts";
import { createBrowserLocator, playwrightDriver } from "../../src/web/index.ts";

const executable = createBrowserLocator({ homeDir: os.homedir(), env: process.env, log: () => undefined }).path();
const SKIP_NOTE = "本机找不到 Chrome / Edge：缩略图要在真浏览器里截，跳过";

const HOME = "<!doctype html><html><head><meta charset=\"utf-8\"><title>简报站</title></head><body style=\"margin:0\"><div style=\"height:800px;background:linear-gradient(#2563eb,#f97316)\"><h1>简报站</h1></div></body></html>";

/** 正式的驱动（用找到的浏览器） */
const driver = () => playwrightDriver({ executablePath: () => executable, missing: () => SKIP_NOTE });

/** JPEG 的宽高：找第一个 SOF 段 */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1]!;
    const length = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return undefined;
}

describe("真的截一张服务首页（要本机的 Chrome / Edge，找不到时跳过）", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/apps/p-1-site/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return void res.end(HOME);
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("没有这个地址");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach((ctx) => {
    ctx.skip(!executable, SKIP_NOTE);
  });

  it("截出来是 640×400 的 JPEG；打不开的页面算没截成", async () => {
    const jpeg = await captureServiceHome(driver(), `${base}/apps/p-1-site/`);
    expect(jpegSize(jpeg)).toEqual({ width: 640, height: 400 });
    await expect(captureServiceHome(driver(), `${base}/apps/p-1-gone/`)).rejects.toThrow("页面打不开（HTTP 404）");
  }, 60_000);

  it("带上的头（469：本机程序的令牌）只发给要截的那个源，页面引用的别处的东西拿不到", async () => {
    const heard: Array<{ who: string; url: string; token: string | undefined }> = [];
    const header = "x-ergo-local-token";
    const listen = (who: string, respond: (req: http.IncomingMessage, res: http.ServerResponse) => void) => {
      const srv = http.createServer((req, res) => {
        heard.push({ who, url: req.url ?? "", token: req.headers[header] as string | undefined });
        respond(req, res);
      });
      return new Promise<{ server: http.Server; url: string }>((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ server: srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` })));
    };
    const elsewhere = await listen("elsewhere", (_req, res) => {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    });
    const own = await listen("own", (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.url === "/apps/p-1-site/" ? `<!doctype html><html><body><img src="${elsewhere.url}/pic.svg"><img src="/apps/p-1-site/pic.svg"></body></html>` : "");
    });
    try {
      await captureServiceHome(driver(), `${own.url}/apps/p-1-site/`, undefined, { [header]: "secret-token" });
      expect(heard.filter((h) => h.who === "own").map((h) => [h.url, h.token])).toEqual(expect.arrayContaining([["/apps/p-1-site/", "secret-token"], ["/apps/p-1-site/pic.svg", "secret-token"]]));
      expect(heard.filter((h) => h.who === "elsewhere").map((h) => [h.url, h.token])).toEqual([["/pic.svg", undefined]]);
    } finally {
      await Promise.all([own, elsewhere].map((s) => new Promise<void>((resolve) => s.server.close(() => resolve()))));
    }
  }, 60_000);
});
