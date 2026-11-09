// 主切面：地图页的隔离框（453，ADR-0059）。网页构建时把 public/map-frame.html 原样拷进产物，网关按 /map-frame.html 给：
// - 本机端口直接给；回应头写 sandbox allow-scripts（直接打开也是不透明来源）、只许二狗自己的页面嵌（frame-ancestors 'self'、
//   X-Frame-Options: SAMEORIGIN）、nosniff；HEAD 只给头；
// - 外网端口和别的地址一样要设备凭证（没配对的 401）；配对过的设备照常取到（框是页面打开的，打开它的请求带着凭证）；
// - 构建产物里没有这个文件：404；
// - 仓库里那一份就是网页包 public/ 下的那个文件：框里只有一个空壳（等外层交来要跑的那一段），不引任何外站的脚本。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAP_FRAME_HEADERS, MAP_FRAME_PATH } from "../../src/gateway/map-frame.ts";
import { startTestDaemon, TEST_PAGE } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const REPO_FRAME = fileURLToPath(new URL("../../../web/public/map-frame.html", import.meta.url));

/** 构建产物的样子：页面本身加上隔离框 */
function webRootWithFrame(): string {
  const dir = makeTempDir("ergo-web-");
  fs.writeFileSync(path.join(dir, "index.html"), TEST_PAGE);
  fs.copyFileSync(REPO_FRAME, path.join(dir, "map-frame.html"));
  return dir;
}

describe("地图页的隔离框", () => {
  it("本机端口：给网页包里那一份，回应头写 sandbox、只许自己的页面嵌；HEAD 只给头", async () => {
    const { url } = await startTestDaemon({ webRoot: webRootWithFrame() });
    expect(MAP_FRAME_PATH).toBe("/map-frame.html");
    const res = await httpRequest(url, MAP_FRAME_PATH);
    expect(res.status).toBe(200);
    expect(res.body).toBe(fs.readFileSync(REPO_FRAME, "utf8"));
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe("sandbox allow-scripts; frame-ancestors 'self'");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(MAP_FRAME_HEADERS["Content-Security-Policy"]).not.toContain("allow-same-origin");
    const head = await httpRequest(url, MAP_FRAME_PATH, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("框里只是个空壳：等外层交来要跑的那一段，只认外层（parent）发来、带记号的；不引外站的脚本", () => {
    const html = fs.readFileSync(REPO_FRAME, "utf8");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("e.source !== parent");
    expect(html).toContain('"ergoMapFrame"');
    expect(html).toContain('post({ type: "frame-ready" })');
  });

  it("构建产物里没有这个文件：404，页面照常", async () => {
    const { url } = await startTestDaemon();
    expect((await httpRequest(url, MAP_FRAME_PATH)).status).toBe(404);
    expect((await httpRequest(url, "/")).status).toBe(200);
  });

  it("外网端口：没配对 401；配对过的设备照常取到", async () => {
    const { url, externalUrl } = await startTestDaemon({ webRoot: webRootWithFrame() });
    const res = await httpRequest(externalUrl, MAP_FRAME_PATH);
    expect(res.status).toBe(401);
    expect(res.body).not.toContain("ergoMapFrame");
    const pc = await TestFrontend.connect(url);
    await pc.subscribe({ cards: 0, inbox: 0 });
    const phone = await pairDevice(externalUrl, pc, { name: "我的手机" });
    const got = await phone.request(MAP_FRAME_PATH);
    expect(got.status).toBe(200);
    expect(got.headers["content-security-policy"]).toBe("sandbox allow-scripts; frame-ancestors 'self'");
  });
});
