// ergo notify（357 号票）：用法、环境变量、连不上、二狗拒了、报上了的退出码和说法；请求带的东西。接口是本机一个假的 HTTP 服务（真的接口在主切面）。
// 版本目录里真跑一遍在 test/build/stage.test.ts。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { NOTIFY_EXIT } from "../../src/cli/notify.ts";
import { runCli } from "../../src/cli/run.ts";
import type { CliContext } from "../../src/cli/context.ts";
import { freePort } from "../helpers/ports.ts";

interface Seen {
  method: string | undefined;
  auth: string | undefined;
  body: unknown;
}

/** 假接口：记下收到的，回给定的状态和内容 */
async function fakeApi(status: number, reply: unknown) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/service-events`, seen };
}

function cli(env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = { env, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), ask: async () => "" } } as unknown as CliContext;
  return { ctx, out, err };
}

describe("ergo notify", () => {
  it("报上了：带凭证发事件名和数据，退出码 0，说清不等维护者做完", async () => {
    const api = await fakeApi(202, { ok: true, event: "评论异常", runs: [{ taskId: "t-1", runId: "j-1-r1", merged: false }] });
    const t = cli({ ERGO_NOTIFY_URL: api.url, ERGO_SERVICE_TOKEN: "tok" });
    expect(await runCli(["notify", "评论异常", "--data", '{"count":3}'], t.ctx)).toBe(NOTIFY_EXIT.ok);
    expect(api.seen).toEqual([{ method: "POST", auth: "Bearer tok", body: { event: "评论异常", data: { count: 3 } } }]);
    expect(t.out.join("\n")).toContain("报上了：事件「评论异常」（运行 j-1-r1）");
    expect(t.err).toEqual([]);
  });

  it("不带数据也行；--data=… 的写法也认", async () => {
    const api = await fakeApi(202, { ok: true, event: "x", runs: [] });
    expect(await runCli(["notify", "x"], cli({ ERGO_NOTIFY_URL: api.url, ERGO_SERVICE_TOKEN: "tok" }).ctx)).toBe(0);
    expect(await runCli(["notify", "x", "--data=[1,2]"], cli({ ERGO_NOTIFY_URL: api.url, ERGO_SERVICE_TOKEN: "tok" }).ctx)).toBe(0);
    expect(api.seen.map((s) => s.body)).toEqual([{ event: "x" }, { event: "x", data: [1, 2] }]);
  });

  it("二狗拒了：退出码 1，把二狗说的原因写出来", async () => {
    const api = await fakeApi(404, { code: "not_found", message: "运营方案里没有等事件「x」的任务" });
    const t = cli({ ERGO_NOTIFY_URL: api.url, ERGO_SERVICE_TOKEN: "tok" });
    expect(await runCli(["notify", "x"], t.ctx)).toBe(NOTIFY_EXIT.refused);
    expect(t.err.join("\n")).toContain("二狗没收（404）：运营方案里没有等事件「x」的任务");
  });

  it("用法不对：退出码 2，不发请求（没写事件名、--data 不是 JSON、--data 后面没写、环境变量不在）", async () => {
    const api = await fakeApi(202, { ok: true, event: "x", runs: [] });
    const env = { ERGO_NOTIFY_URL: api.url, ERGO_SERVICE_TOKEN: "tok" };
    const noName = cli(env);
    expect(await runCli(["notify"], noName.ctx)).toBe(NOTIFY_EXIT.usage);
    expect(noName.err.join("\n")).toContain("用法：ergo notify <事件名>");
    const badJson = cli(env);
    expect(await runCli(["notify", "x", "--data", "{oops"], badJson.ctx)).toBe(NOTIFY_EXIT.usage);
    expect(badJson.err.join("\n")).toContain("--data 写的不是 JSON");
    const noData = cli(env);
    expect(await runCli(["notify", "x", "--data"], noData.ctx)).toBe(NOTIFY_EXIT.usage);
    expect(noData.err.join("\n")).toContain("--data 后面要写一段 JSON");
    for (const partial of [{}, { ERGO_NOTIFY_URL: api.url }, { ERGO_SERVICE_TOKEN: "tok" }]) {
      const noEnv = cli(partial);
      expect(await runCli(["notify", "x"], noEnv.ctx)).toBe(NOTIFY_EXIT.usage);
      expect(noEnv.err.join("\n")).toContain("没有环境变量 ERGO_NOTIFY_URL、ERGO_SERVICE_TOKEN");
    }
    expect(api.seen).toEqual([]);
  });

  it("连不上（守护进程停着）：退出码 3，说清这次没报上、二狗不替它存", async () => {
    const url = `http://127.0.0.1:${await freePort()}/api/service-events`;
    const t = cli({ ERGO_NOTIFY_URL: url, ERGO_SERVICE_TOKEN: "tok" });
    expect(await runCli(["notify", "x"], t.ctx)).toBe(NOTIFY_EXIT.unreachable);
    expect(t.err.join("\n")).toContain(`连不上二狗（${url}）`);
    expect(t.err.join("\n")).toContain("二狗不替你存");
  });
});
