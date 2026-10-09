// 主切面：视觉风格的字体（39 号票）。Web UI 构建时把风格要用的字体拷进构建产物的 fonts/（每套有字体的风格一份样式表
// <风格 id>.css，woff2 放在带包版本号的目录里，旁边是许可证），网关按 /fonts/ 提供：
// - 本机端口直接给；外网端口和别的接口一样要设备凭证（没配对的新设备只拿得到页面本身）；
// - woff2 的地址带版本号、内容不变，让浏览器长期缓存；样式表每次都问一下变没变（ETag，没变回 304）；
// - 只给 fonts/ 目录里认识的三种文件（样式表、woff2、许可证），跑出目录、别的类型一律 404。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startTestDaemon, TEST_PAGE } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const CSS = '@font-face { font-family: "Demo"; src: url("demo-font@1.2.3/demo-0.woff2") format("woff2"); unicode-range: U+4e00-4e10; }\n';
const WOFF2 = "wOF2-not-really-a-font";
const LICENSE = "SIL Open Font License, Version 1.1\n";

/** 构建产物的样子：页面本身，加上 fonts/ 里的样式表、字体、许可证；fonts/ 外面还有一个不该被取到的文件 */
function webRootWithFonts(): string {
  const dir = makeTempDir("ergou-web-");
  fs.writeFileSync(path.join(dir, "index.html"), TEST_PAGE);
  fs.writeFileSync(path.join(dir, "secret.txt"), "不该被取到");
  fs.mkdirSync(path.join(dir, "fonts", "demo-font@1.2.3"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fonts", "grid.css"), CSS);
  fs.writeFileSync(path.join(dir, "fonts", "demo-font@1.2.3", "demo-0.woff2"), WOFF2);
  fs.writeFileSync(path.join(dir, "fonts", "demo-font@1.2.3", "LICENSE.txt"), LICENSE);
  fs.writeFileSync(path.join(dir, "fonts", "demo-font@1.2.3", "script.js"), "alert(1)");
  return dir;
}

describe("本机端口提供字体", () => {
  it("样式表、woff2、许可证：类型对，woff2 长期缓存，样式表每次问一下（没变回 304）", async () => {
    const { url } = await startTestDaemon({ webRoot: webRootWithFonts() });

    const css = await httpRequest(url, "/fonts/grid.css");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.headers["cache-control"]).toBe("no-cache");
    expect(css.headers["x-content-type-options"]).toBe("nosniff");
    expect(css.body).toBe(CSS);
    const etag = css.headers.etag;
    expect(etag).toBeTruthy();
    const again = await httpRequest(url, "/fonts/grid.css", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.body).toBe("");

    const font = await httpRequest(url, "/fonts/demo-font@1.2.3/demo-0.woff2");
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect(font.headers["cache-control"]).toContain("immutable");
    expect(font.body).toBe(WOFF2);

    const license = await httpRequest(url, "/fonts/demo-font@1.2.3/LICENSE.txt");
    expect(license.status).toBe(200);
    expect(license.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(license.body).toBe(LICENSE);

    const head = await httpRequest(url, "/fonts/grid.css", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("没有的、不认识的类型、跑出 fonts/ 目录的：一律 404；不是 GET 的 405", async () => {
    const { url } = await startTestDaemon({ webRoot: webRootWithFonts() });
    for (const pathname of [
      "/fonts/nope.woff2",
      "/fonts/demo-font@1.2.3/script.js",
      "/fonts/",
      "/fonts/demo-font@1.2.3",
      "/fonts/..%2Fsecret.txt",
      "/fonts/..%5Csecret.txt",
      "/fonts/%2e%2e%2Fsecret.txt",
      "/fonts/demo-font@1.2.3/..%2F..%2Fsecret.txt",
      "/fonts/%E0%A4%A.css",
      "/fonts/grid.css%00.txt",
    ]) {
      const res = await httpRequest(url, pathname);
      expect({ pathname, status: res.status }).toEqual({ pathname, status: 404 });
      expect(res.body).not.toContain("不该被取到");
    }
    expect((await httpRequest(url, "/fonts/grid.css", { method: "POST", body: {} })).status).toBe(405);
  });

  it("构建产物里没有 fonts/（经典风格用不着、还没构建）：404，页面照常", async () => {
    const { url } = await startTestDaemon();
    expect((await httpRequest(url, "/fonts/grid.css")).status).toBe(404);
    expect((await httpRequest(url, "/")).status).toBe(200);
  });
});

describe("外网端口上的字体和页面一样要设备凭证", () => {
  it("没配对：401；配对过的设备：照常取到", async () => {
    const { url, externalUrl } = await startTestDaemon({ webRoot: webRootWithFonts() });
    for (const pathname of ["/fonts/grid.css", "/fonts/demo-font@1.2.3/demo-0.woff2"]) {
      const res = await httpRequest(externalUrl, pathname);
      expect({ pathname, status: res.status }).toEqual({ pathname, status: 401 });
      expect(res.body).not.toContain("font-face");
    }

    const pc = await TestFrontend.connect(url);
    await pc.subscribe({ cards: 0, inbox: 0 });
    const phone = await pairDevice(externalUrl, pc, { name: "我的手机" });
    const css = await phone.request("/fonts/grid.css");
    expect(css.status).toBe(200);
    expect(css.body).toBe(CSS);
    const font = await phone.request("/fonts/demo-font@1.2.3/demo-0.woff2");
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
  });
});
