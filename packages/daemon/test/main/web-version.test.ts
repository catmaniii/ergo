// 主切面：网页是哪一版（116 号票）。服务端的页面更新了（npm run build:web 换了 index.html，守护进程不重启），开着的页面要知道：
// - 守护进程从它提供的 index.html 里取版本号（构建时写进 <head> 的 <meta name="ergo-web-version">），连上（含重连）时订阅的响应里带着；
// - index.html 换了一版，几秒内（测试里 50 毫秒看一眼）在活动状态频道上推一条临时的 web_version，开着的前端都收到；同一版不重复推；
// - 页面切回前台时经 GET /api/web-version 问一次；外网端口上要设备凭证；
// - 重新构建的中途（Vite 先清空 dist/，文件不在）照旧是上一版、不推；新文件里没有版本号（这张票之前构建的）是不知道，也不推。
// 页面一律是临时目录里的假 index.html。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, HTTP_PATHS, type ResponseFrame, type SubscribeResult, type WebVersionEventPayload, type WebVersionView, webVersionMeta } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon, TEST_PAGE } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { activity: ACTIVITY } = CHANNELS;
/** 测试里多久看一眼 index.html（正式的是 2 秒） */
const POLL_MS = 50;

/** 一个带版本号的假页面 */
const pageOf = (version: string) => `<!doctype html><html><head>${webVersionMeta(version)}<title>二狗测试页 ${version}</title></head><body><div id="root"></div></body></html>\n`;

function webRootWith(html: string): string {
  const dir = makeTempDir("ergo-web-");
  fs.writeFileSync(path.join(dir, "index.html"), html);
  return dir;
}

const subscribed = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`订阅失败：${r.error.code} ${r.error.message}`);
  return r.result as SubscribeResult;
};

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  const result = subscribed(await frontend.subscribe({ [ACTIVITY]: 0 }));
  return { frontend, result };
}

const pushedOf = (frontend: TestFrontend) => frontend.events({ channel: ACTIVITY, type: EVENT_TYPES.webVersion }).map((f) => (f.payload as WebVersionEventPayload).version);
const asked = async (url: string) => (await requestJson<WebVersionView>(url, HTTP_PATHS.webVersion)).body;
/** 等几轮"看一眼"，确认没推什么 */
const settle = () => new Promise((r) => setTimeout(r, POLL_MS * 6));

describe("网页是哪一版", () => {
  it("连上时订阅的响应里带着现在这一版，经 HTTP 问也是它", async () => {
    const { url } = await startTestDaemon({ webRoot: webRootWith(pageOf("3f9a0c12")), webVersionPollMs: POLL_MS });
    const { result } = await connect(url);
    expect(result.webVersion).toBe("3f9a0c12");
    expect(await asked(url)).toEqual({ version: "3f9a0c12" });
  });

  it("index.html 换了一版：推一条 web_version，开着的前端都收到；之后连上、问到的都是新的；同一版不重复推", async () => {
    const webRoot = webRootWith(pageOf("v1"));
    const { url } = await startTestDaemon({ webRoot, webVersionPollMs: POLL_MS });
    const phone = await connect(url);
    const pc = await connect(url);
    // 没换之前什么都不推
    await settle();
    expect(pushedOf(phone.frontend)).toEqual([]);

    fs.writeFileSync(path.join(webRoot, "index.html"), pageOf("v2"));
    const frame = await phone.frontend.next(ACTIVITY, EVENT_TYPES.webVersion, 5000);
    expect(frame.payload).toEqual({ version: "v2" });
    await pc.frontend.next(ACTIVITY, EVENT_TYPES.webVersion, 5000);
    expect((await connect(url)).result.webVersion).toBe("v2");
    expect(await asked(url)).toEqual({ version: "v2" });

    // 内容变了、版本号没变（比如只是重新写了一遍同样的产物）：不再推
    fs.writeFileSync(path.join(webRoot, "index.html"), `${pageOf("v2")}\n`);
    await settle();
    expect(pushedOf(phone.frontend)).toEqual(["v2"]);
    expect(pushedOf(pc.frontend)).toEqual(["v2"]);
  });

  it("重新构建的中途文件不在：照旧是上一版、不推；新文件里没有版本号：不知道（订阅的响应、HTTP 都不带），也不推", async () => {
    const webRoot = webRootWith(pageOf("v1"));
    const { url } = await startTestDaemon({ webRoot, webVersionPollMs: POLL_MS });
    const { frontend } = await connect(url);

    fs.rmSync(path.join(webRoot, "index.html"));
    await settle();
    expect((await connect(url)).result.webVersion).toBe("v1");
    expect(pushedOf(frontend)).toEqual([]);

    fs.writeFileSync(path.join(webRoot, "index.html"), TEST_PAGE);
    // 问的时候现看一眼（不等下一轮）
    expect(await asked(url)).toEqual({});
    expect((await connect(url)).result).not.toHaveProperty("webVersion");
    await settle();
    expect(pushedOf(frontend)).toEqual([]);

    // 再构建出带版本号的：推
    fs.writeFileSync(path.join(webRoot, "index.html"), pageOf("v3"));
    expect((await frontend.next(ACTIVITY, EVENT_TYPES.webVersion, 5000)).payload).toEqual({ version: "v3" });
  });

  it("没订阅活动状态频道的连接不推；外网端口上问要设备凭证", async () => {
    const webRoot = webRootWith(pageOf("v1"));
    const { url, externalUrl } = await startTestDaemon({ webRoot, webVersionPollMs: POLL_MS });
    const bystander = await TestFrontend.connect(url);
    subscribed(await bystander.subscribe({ [CHANNELS.secretary]: 0 }));
    const { frontend } = await connect(url);
    fs.writeFileSync(path.join(webRoot, "index.html"), pageOf("v2"));
    await frontend.next(ACTIVITY, EVENT_TYPES.webVersion, 5000);
    expect(bystander.events({ type: EVENT_TYPES.webVersion })).toEqual([]);
    expect((await requestJson(externalUrl, HTTP_PATHS.webVersion)).status).toBe(401);
  });
});
