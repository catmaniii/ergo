// 转发本机服务的页面（132 号票）里不经网关也能测的部分：响应头怎么改写（Location、CSP 的 frame-ancestors、Set-Cookie）、
// 前缀下自检（页面里以 / 开头、不在前缀下的地址和写死的本机地址；抓假服务的首页；命令行）。经网关的转发在主切面 test/main/app-proxy.test.ts。
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { rewriteLocation, rewriteSetCookie, withoutFrameAncestors } from "../../src/apps/proxy.ts";
import { checkAppPrefix, findOffPrefixUrls, prefixCheckReport } from "../../src/apps/prefix-check.ts";
import { createAppRegistry, type RegisteredApp } from "../../src/apps/registry.ts";
import { startFakeApp } from "../helpers/fake-app.ts";

function appAt(port: number, name = "intel"): RegisteredApp {
  const registry = createAppRegistry();
  registry.register({ name, target: `http://127.0.0.1:${port}` });
  return registry.get(name)!;
}

describe("响应头的改写", () => {
  const app = appAt(5173);

  it("Location：服务自己的地址（127.0.0.1、localhost、[::1] 同端口）去掉源接到前缀下；别的端口、别的网站原样", () => {
    expect(rewriteLocation("http://127.0.0.1:5173/login", app)).toBe("/apps/intel/login");
    expect(rewriteLocation("http://[::1]:5173/", app)).toBe("/apps/intel/");
    expect(rewriteLocation("//localhost:5173/x?y=1", app)).toBe("/apps/intel/x?y=1");
    expect(rewriteLocation("http://127.0.0.1:5174/login", app)).toBe("http://127.0.0.1:5174/login");
    expect(rewriteLocation("https://example.com/", app)).toBe("https://example.com/");
    expect(rewriteLocation("/apps/intel", app)).toBe("/apps/intel");
    expect(rewriteLocation("/apps/intelx/a", app)).toBe("/apps/intel/apps/intelx/a");
    expect(rewriteLocation("../up", app)).toBe("../up");
  });

  it("CSP：只去掉 frame-ancestors（几条策略各自去），别的指令留着；去完不剩的整个头不要", () => {
    expect(withoutFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *")).toBe("default-src 'self'; img-src *");
    expect(withoutFrameAncestors("frame-ancestors 'self', script-src 'self'; FRAME-ANCESTORS 'none'")).toBe("script-src 'self'");
    expect(withoutFrameAncestors("frame-ancestors 'none';")).toBeUndefined();
  });

  it("Set-Cookie：Path 改到前缀下（没写 Path 的照浏览器的默认，已经在前缀下的原样）、去掉 Domain；二狗自己的 cookie 名整条不要", () => {
    expect(rewriteSetCookie("sid=1; Path=/; HttpOnly; SameSite=Lax", app)).toBe("sid=1; Path=/apps/intel/; HttpOnly; SameSite=Lax");
    expect(rewriteSetCookie("a=b=c; domain=localhost; path=/x", app)).toBe("a=b=c; Path=/apps/intel/x");
    expect(rewriteSetCookie("a=1; Path=/apps/intel/y", app)).toBe("a=1; Path=/apps/intel/y");
    expect(rewriteSetCookie("a=1", app)).toBe("a=1");
    expect(rewriteSetCookie("__Host-ergo-device=x; Path=/; Secure", app)).toBeUndefined();
    expect(rewriteSetCookie(" __Host-ergo-pairing=x", app)).toBeUndefined();
  });
});

describe("前缀下自检", () => {
  const BAD = [
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="/assets/app.css">',
    '<link rel="icon" href="favicon.ico">',
    "<style>body{background:url('/img/bg.png')} @import \"/theme.css\";</style>",
    "<!-- <script src=\"/commented.js\"></script> -->",
    '<script src="/apps/intel/ok.js"></script>',
    '<script>const html = \'<img src="/in-script.png">\'; fetch("/api/x")</script>',
    "</head><body>",
    "<img src=/logo.png srcset=\"img/a.png 1x, /img/b.png 2x\">",
    '<a href="http://127.0.0.1:5173/admin">后台</a> <a href="https://example.com/">外链</a> <a href="#top">顶上</a>',
    '<form action="/submit"></form><div style="background: url(/x.png)"></div>',
    '<a href="/apps/intel/">首页</a><a href="//localhost:5173/y">本机</a><a href="mailto:a@b.c">信</a>',
    "</body></html>",
  ].join("\n");

  it("以 / 开头、不在前缀下的地址和写死的本机地址都找出来；相对的、在前缀下的、外链、锚点不算；注释和脚本正文不看", () => {
    expect(findOffPrefixUrls(BAD, "/apps/intel")).toEqual([
      { where: "href", url: "/assets/app.css", problem: "root" },
      { where: "src", url: "/logo.png", problem: "root" },
      { where: "srcset", url: "/img/b.png", problem: "root" },
      { where: "href", url: "http://127.0.0.1:5173/admin", problem: "loopback" },
      { where: "action", url: "/submit", problem: "root" },
      { where: "href", url: "//localhost:5173/y", problem: "loopback" },
      { where: "url()", url: "/img/bg.png", problem: "root" },
      { where: "url()", url: "/x.png", problem: "root" },
      { where: "@import", url: "/theme.css", problem: "root" },
    ]);
    expect(findOffPrefixUrls('<script src="app.js"></script><img src="./a.png">', "/apps/intel")).toEqual([]);
  });

  it("抓服务的首页查（像转发过来的那样带着 X-Forwarded-Prefix）；报告写明哪几处、怎么改", async () => {
    const good = await startFakeApp();
    const ok = await checkAppPrefix(good.url, "intel");
    expect(ok).toMatchObject({ url: `${good.url}/`, status: 200, basePath: "/apps/intel", findings: [] });
    expect(good.seen.at(-1)!.headers["x-forwarded-prefix"]).toBe("/apps/intel");
    expect(prefixCheckReport(ok)).toContain("没有发现");

    const bad = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.url === "/apps/intel/" ? '<script src="app.js"></script>' : BAD);
    });
    await new Promise<void>((resolve) => bad.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => bad.close(() => resolve())));
    const target = `http://127.0.0.1:${(bad.address() as AddressInfo).port}`;
    const result = await checkAppPrefix(target, "intel");
    expect(result.findings).toHaveLength(9);
    expect(prefixCheckReport(result)).toContain("发现 9 处不在前缀下的地址");
    expect(prefixCheckReport(result)).toContain("- href: /assets/app.css  以 / 开头、不在前缀下");
    // 保留前缀的服务：首页本来就在前缀下
    expect(await checkAppPrefix(target, "intel", "keep")).toMatchObject({ url: `${target}/apps/intel/`, findings: [] });
  });

  it("命令行：npm run check:app-prefix -- <服务地址> --name <应用名>，没问题退出码 0，用法不对 2", async () => {
    const app = await startFakeApp();
    const cli = path.join(import.meta.dirname, "../../src/apps/prefix-check-cli.ts");
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((resolve) => {
        execFile(process.execPath, [cli, ...args], (error, out, err) => resolve({ code: error ? Number(error.code) : 0, out, err }));
      });
    const ok = await run([app.url, "--name", "intel"]);
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.out).toContain("前缀下自检");
    expect((await run([app.url])).code).toBe(2);
  });
});
