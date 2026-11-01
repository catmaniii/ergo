// npm run check:ops：不起二狗校验运营接口清单和运营方案（project-ops/check-file.ts，命令行 check-file-cli.ts）。
// 看四件事：
// - 清单：没写全的一次说全、不调服务；没给地址的 http 操作记成没测；给了地址就带测试标记真调，没有 say、只读的写了文件、连不上都算没过；
// - 方案：字段（协议包的 schema）、各手段要的字段、事件来源、服务的规矩（密钥明文、工作目录、端口、同名同端口）；
// - 命令行的退出码：0 过了、1 没过、2 用法不对；
// - 开发文档里的例子：plan.json、ops.json 过得了校验，server.mjs 真跑起来过得了清单，二狗连不上、/ops 收到坏的请求体都不崩。
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkOpsFile, type CheckFileOptions } from "../../src/project-ops/check-file.ts";
import { LEDGER_OPS, startFakeOpsApp } from "../helpers/fake-ops-app.ts";
import { freePort } from "../helpers/ports.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const CLI = path.join(import.meta.dirname, "../../src/project-ops/check-file-cli.ts");
const EXAMPLE = path.resolve(import.meta.dirname, "../../../../.claude/skills/ergo-project-service/example");

const check = (value: unknown, options: Partial<CheckFileOptions> = {}) => checkOpsFile(JSON.stringify(value), { workdir: makeTempDir(), ...options });

/** 写全了的一个操作 */
const op = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  title: "查一下",
  description: "用户要看的时候用。",
  userSays: ["查一下"],
  kind: "query",
  inputSchema: { type: "object", properties: {} },
  test: { args: {} },
  ...extra,
});

/** 写全了的一条服务 */
const serviceItem = (key: string, service: Record<string, unknown> = {}) => ({
  key,
  name: key,
  means: "service",
  instructions: "上线它",
  capabilities: {},
  service: { name: key, command: "node server.mjs", port: 18731, ...service },
});

describe("运营接口清单", () => {
  it("没写全的一次说全，不调服务（给了地址也不调）", async () => {
    const app = await startFakeOpsApp();
    const report = await check({ ...LEDGER_OPS, tools: [{ name: "add_expense", inputSchema: { type: "object", properties: {} } }] }, { url: app.url });
    expect(report.kind).toBe("ops");
    for (const words of ["没写中文标题", "没写什么时候用", "没写用户可能怎么说", "没写种类", "没写测试"]) expect(report.problems.join("\n")).toContain(words);
    expect(app.calls()).toEqual([]);
  });

  it("读不通的清单照实说（不是对象、缺 tools）", async () => {
    expect((await check({ endpoint: { path: "/ops" } })).problems).toHaveLength(1);
    expect((await check("写错了")).problems).toHaveLength(1);
  });

  it("没给地址：格式过了就算过，http 的操作记成没测", async () => {
    const report = await check(LEDGER_OPS);
    expect(report.problems).toEqual([]);
    expect(report.notes).toEqual(["add_expense：没测（带 --url 才调 http 的操作，格式过了）", "list_expenses：没测（带 --url 才调 http 的操作，格式过了）"]);
  });

  it("给了地址：带测试标记真调，有副作用的没真改", async () => {
    const app = await startFakeOpsApp();
    const report = await check(LEDGER_OPS, { url: app.url });
    expect(report.problems).toEqual([]);
    expect(report.notes.join("\n")).toContain("add_expense：过");
    expect(report.notes.join("\n")).toContain("list_expenses：过");
    const calls = app.calls() as Array<{ name: string; _meta?: Record<string, unknown> }>;
    expect(calls.map((c) => [c.name, c._meta?.["ergo/test"]])).toEqual([
      ["add_expense", true],
      ["list_expenses", true],
    ]);
    expect(app.expenses()).toEqual([]);
  });

  it("调用口的路径照清单写的", async () => {
    const app = await startFakeOpsApp({ path: "/api/ops" });
    const report = await check({ ...LEDGER_OPS, endpoint: { path: "/api/ops" } }, { url: app.url });
    expect(report.problems).toEqual([]);
    expect(app.calls()).toHaveLength(2);
  });

  it("测试回的没有 say、只读查询写了文件：没过", async () => {
    const workdir = makeTempDir();
    const app = await startFakeOpsApp({ writeDir: workdir });
    const report = await check({ ...LEDGER_OPS, tools: [op("legacy_list"), op("leaky_query")] }, { url: app.url, workdir });
    expect(report.problems.join("\n")).toContain("操作 legacy_list 的测试回的没有能念的 say");
    expect(report.problems.join("\n")).toContain("只读查询 leaky_query 的测试改了文件");
  });

  it("给了地址连不上：没过，不是没测", async () => {
    const url = `http://127.0.0.1:${await freePort()}`;
    const report = await check(LEDGER_OPS, { url });
    expect(report.problems).toEqual([`add_expense：连不上 ${url}`, `list_expenses：连不上 ${url}`]);
  });

  it("脚本不在是没过；转给负责人的只查格式，记成没测", async () => {
    const missing = await check({ tools: [op("monthly", { impl: { type: "script", file: "scripts/none.mjs" } })] });
    expect(missing.problems.join("\n")).toContain("脚本");
    const report = await check({ tools: [op("ask", { kind: "action", impl: { type: "maintainer" } })] });
    expect(report.problems).toEqual([]);
    expect(report.notes).toEqual(["ask：没测（maintainer 的操作要在二狗里才跑得了，格式过了）"]);
  });

  it("脚本照跑：在工作目录里、带测试标记，回的 say 算数", async () => {
    const workdir = makeTempDir();
    fs.mkdirSync(path.join(workdir, "scripts"));
    fs.writeFileSync(path.join(workdir, "scripts", "report.mjs"), 'console.log(JSON.stringify({ say: "报表好了" }));\n');
    const report = await check({ tools: [op("report", { impl: { type: "script", file: "scripts/report.mjs" } })] }, { workdir });
    expect(report.problems).toEqual([]);
    expect(report.notes).toEqual(["report：过（报表好了）"]);
  });
});

describe("运营方案", () => {
  it("数组和 { items } 两种写法都认；工作目录要有 cwd 写的目录", async () => {
    const workdir = makeTempDir();
    const item = serviceItem("counter", { cwd: "counter" });
    const noDir = await check([item], { workdir });
    expect(noDir.kind).toBe("plan");
    expect(noDir.problems.join("\n")).toContain("不存在");
    fs.mkdirSync(path.join(workdir, "counter"));
    expect(await check([item], { workdir })).toMatchObject({ problems: [], notes: ["第 1 条「counter」：过"] });
    expect(await check({ items: [item], why: "上线" }, { workdir })).toMatchObject({ kind: "plan", problems: [] });
  });

  it("缺字段说是第几条；空方案没过", async () => {
    const { instructions: _dropped, ...noInstructions } = serviceItem("counter");
    const report = await check([noInstructions]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/^第 1 条：/);
    expect(report.problems[0]).toContain("instructions");
    expect((await check([])).problems).toEqual(["方案是空的：至少写一条"]);
  });

  it("各手段要的字段：定时没写时间表、事件没写事件或来源不对、公网入口没写手动步骤、没有这种手段、key 重复、别的手段写 service", async () => {
    const base = { name: "一条", instructions: "做", capabilities: {} };
    const report = await check([
      { ...base, key: "a", means: "schedule" },
      { ...base, key: "b", means: "event" },
      { ...base, key: "c", means: "event", event: { kind: "event", source: "没有这个", events: ["x"] } },
      { ...base, key: "d", means: "public_entry" },
      { ...base, key: "e", means: "碰运气" },
      { ...base, key: "e", means: "schedule", schedule: { kind: "daily", time: "09:00" }, service: serviceItem("x").service },
    ]);
    const text = report.problems.join("\n");
    expect(text).toContain("第 1 条「a」");
    expect(text).toContain("第 2 条「b」");
    expect(text).toContain("第 3 条「c」");
    expect(text).toContain("没有这个");
    expect(text).toContain("第 4 条「d」");
    expect(text).toContain("没有 碰运气 这种手段（有：schedule、event、public_entry、service）");
    expect(text).toContain("第 6 条「e」：key 重复了");
    expect(text).toContain("第 6 条「e」：只有 means 是 service 的才写 service");
  });

  it("事件名只查形状：等服务报的事件写一个过得了，名字带换行的过不了", async () => {
    const item = (name: string) => ({ key: "full", name: "满了", means: "event", instructions: "做", capabilities: {}, event: { kind: "event", source: "service", events: ["reported"], filter: { name } } });
    expect((await check([item("计数满百")])).problems).toEqual([]);
    expect((await check([item("两\n行")])).problems).toHaveLength(1);
  });

  it("服务的规矩：名字、二狗自己的端口、密钥明文、注入的变量、同名同端口", async () => {
    const report = await check([
      serviceItem("a--b"),
      serviceItem("own-port", { port: 8810 }),
      serviceItem("leak", { port: 18732, env: [{ name: "API_KEY", value: "abcdefghijklmnopqrstuvwxyz012345" }] }),
      serviceItem("inject", { port: 18733, env: [{ name: "ERGO_SERVICE_TOKEN", value: "x" }] }),
      serviceItem("same-port", { port: 18734 }),
      serviceItem("same-port2", { name: "same-port", port: 18734 }),
    ]);
    const text = report.problems.join("\n");
    expect(text).toContain("第 1 条「a--b」");
    expect(text).toContain("第 2 条「own-port」");
    expect(text).toContain("第 3 条「leak」");
    expect(text).toContain("第 4 条「inject」");
    expect(text).toContain("same-port");
    expect(text).toContain("18734");
    expect(report.notes).toEqual([]);
  });
});

/** 跑命令行 */
const run = (args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { windowsHide: true }, (error, out, err) => resolve({ code: error ? Number(error.code) : 0, out, err }));
  });

describe("命令行：npm run check:ops", () => {
  it("过了 0；没过 1，原因写在输出里；用法不对、读不了、不是 JSON、地址不是本机都是 2", async () => {
    const dir = makeTempDir();
    const file = (name: string, content: string) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content);
      return p;
    };
    const good = file("ops.json", JSON.stringify(LEDGER_OPS));
    const ok = await run([good]);
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.out).toContain("过了。");
    // Windows 上手写的文件带 BOM 也认
    expect((await run([file("bom.json", `﻿${JSON.stringify(LEDGER_OPS)}`)])).code).toBe(0);

    const bad = await run([file("bad.json", JSON.stringify({ tools: [{ name: "add_expense" }] }))]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("没过：");
    expect((await run([file("plan.json", JSON.stringify([serviceItem("a--b")]))])).code).toBe(1);

    expect((await run([])).code).toBe(2);
    expect((await run([good, good])).code).toBe(2);
    expect((await run([path.join(dir, "没有这个.json")])).code).toBe(2);
    expect((await run([file("broken.json", "{")])).code).toBe(2);
    const remote = await run([good, "--url", "http://example.com:80"]);
    expect(remote.code).toBe(2);
    expect(remote.err).toContain("--url");
  });

  it("--workdir、--url 都接得上", async () => {
    const workdir = makeTempDir();
    fs.mkdirSync(path.join(workdir, "counter"));
    const dir = makeTempDir();
    const plan = path.join(dir, "plan.json");
    fs.writeFileSync(plan, JSON.stringify([serviceItem("counter", { cwd: "counter" })]));
    expect((await run([plan])).code).toBe(1);
    expect((await run([plan, "--workdir", workdir])).code).toBe(0);

    const app = await startFakeOpsApp();
    const ops = path.join(dir, "ops.json");
    fs.writeFileSync(ops, JSON.stringify(LEDGER_OPS));
    const tested = await run([ops, "--url", app.url]);
    expect(tested).toMatchObject({ code: 0 });
    expect(tested.out).toContain("add_expense：过");
    expect(app.calls()).toHaveLength(2);
  });
});

/** 真起例子里的 server.mjs，等它能应答 */
async function startExample(env: Record<string, string> = {}): Promise<{ url: string; child: ChildProcess; stderr: () => string }> {
  const port = await freePort();
  let stderr = "";
  const child = spawn(process.execPath, [path.join(EXAMPLE, "server.mjs")], {
    env: { ...process.env, PORT: String(port), ERGO_NOTIFY_URL: "", ERGO_SERVICE_TOKEN: "", ...env },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  onTestFinished(() => void child.kill());
  const url = `http://127.0.0.1:${port}`;
  await expect
    .poll(async () => fetch(`${url}/health`).then((r) => r.status, () => 0), { timeout: 10_000, interval: 50 })
    .toBe(200);
  return { url, child, stderr: () => stderr };
}

/** 收事件的本机小服务 */
async function startReceiver(): Promise<{ url: string; seen: Array<{ authorization?: string; body: unknown }> }> {
  const seen: Array<{ authorization?: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), body: JSON.parse(body) as unknown });
      res.writeHead(202).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/service-events`, seen };
}

const addHundred = async (url: string) => {
  for (let i = 0; i < 100; i += 1) await fetch(`${url}/api/count`, { method: "POST" });
};

describe("开发文档里的例子（.claude/skills/ergo-project-service/example）", () => {
  it("plan.json 过得了校验（工作目录里有 counter/）", async () => {
    const workdir = makeTempDir();
    fs.mkdirSync(path.join(workdir, "counter"));
    const report = await checkOpsFile(fs.readFileSync(path.join(EXAMPLE, "plan.json"), "utf8"), { workdir });
    expect(report).toMatchObject({ kind: "plan", problems: [], warnings: [] });
  });

  it("server.mjs 真跑起来，ops.json 过得了验收，有副作用的没真改", async () => {
    const { url } = await startExample();
    const report = await checkOpsFile(fs.readFileSync(path.join(EXAMPLE, "ops.json"), "utf8"), { workdir: makeTempDir(), url });
    expect(report.problems).toEqual([]);
    expect(report.notes.join("\n")).toContain("get_count：过");
    expect(report.notes.join("\n")).toContain("add_count：过");
    expect(await (await fetch(`${url}/api/count`)).json()).toEqual({ count: 0 });
  });

  it("/ops 收到不是 JSON 的：回 400，服务还活着", async () => {
    const { url, child } = await startExample();
    const res = await fetch(`${url}/ops`, { method: "POST", body: "不是 JSON" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ isError: true });
    expect(child.exitCode).toBeNull();
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it("二狗连不上时报事件：记一句，服务还活着", async () => {
    const { url, child, stderr } = await startExample({ ERGO_NOTIFY_URL: `http://127.0.0.1:${await freePort()}/api/service-events`, ERGO_SERVICE_TOKEN: "t" });
    await addHundred(url);
    await expect.poll(stderr, { timeout: 10_000, interval: 50 }).toContain("事件没报上");
    expect(child.exitCode).toBeNull();
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it("二狗连得上：带 Bearer 头，体是 { event, data }", async () => {
    const receiver = await startReceiver();
    const { url } = await startExample({ ERGO_NOTIFY_URL: receiver.url, ERGO_SERVICE_TOKEN: "token-1" });
    await addHundred(url);
    await expect.poll(() => receiver.seen.length, { timeout: 10_000, interval: 50 }).toBe(1);
    expect(receiver.seen[0]).toEqual({ authorization: "Bearer token-1", body: { event: "计数满百", data: { count: 100 } } });
  });
});
