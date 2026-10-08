// 主切面：接入 LSM 的 link 协议（规格第 1 节"服务登记"，23 号票）。测试里用替身当管理器（helpers/lsm-stand-in.ts），
// 把它的身份（LSM_URL / LSM_SERVICE_ID / LSM_TOKEN / LSM_PROTOCOL）放进守护进程的环境：
// - 握手报上 pid、端口和能力；心跳报健康和忙不忙：有任务处于执行中、或者有正在执行的有副作用的调用时报"忙"（原因写明），
//   没有时不报；忙闲变了马上补一次；
//   并行派出的子 agent（20 号票）的有副作用的调用也算；
// - 停机：立即的马上优雅停止；等空闲的忙时挂起（可撤销），不忙了再停；停完发 bye；
// - 被重复启动（管理器回 conflict）：守护进程停下；
// - 没有注入身份时静默跳过、照常起来；注入了但连不上也照常起来，之后连上。
import fs from "node:fs";
import path from "node:path";
import { type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, type ResponseFrame, type TaskEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { type LinkMessage, startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { freePort } from "../helpers/ports.ts";
import { waitUntil } from "../helpers/process.ts";
import { maintainerScripts, RUNNING_TASK_ID, RUNNING_TASK_TITLE, SECRETARY_BRIEFS, startRunningTask } from "../helpers/running-task.ts";

const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const heartbeat = (m: LinkMessage) => m.type === "heartbeat";
const busyBeat = (busy: boolean) => (m: LinkMessage) => heartbeat(m) && m.busy === busy;

/** 守护进程接着在不在：/healthz 答不答（停了就连不上） */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(new URL("/healthz", url));
    return true;
  } catch {
    return false;
  }
}

/** 等守护进程停下（端口关掉） */
async function untilStopped(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await answers(url)) {
    if (Date.now() > deadline) throw new Error("守护进程没有停下");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 起一个接入替身的守护进程，和一个订阅了看板、卡片的前端 */
async function linkedDaemon(heartbeatIntervalMs: number) {
  const lsm = await startLsmStandIn({ heartbeatIntervalMs });
  const td = await startTestDaemon({ env: lsm.env, secretary: SECRETARY_BRIEFS, maintainer: (_id, n) => maintainerScripts([{ kind: "reply", text: "开始干了" }])[n - 1] ?? [] });
  const frontend = await TestFrontend.connect(td.url);
  ok(await frontend.subscribe({ [CHANNELS.board]: 0, [CHANNELS.cards]: 0 }));
  return { lsm, td, frontend };
}

describe("接入 LSM：握手和心跳", () => {
  it("握手报上 pid、本机端口和能力；没有任务在执行时心跳不报忙，有任务在执行时报忙（原因写任务），任务不再执行后不报；忙闲变了马上补一次心跳", async () => {
    // 心跳间隔给得很长：之后收到的心跳只能是忙闲变化时补的那一次
    const { lsm, td, frontend } = await linkedDaemon(60_000);
    expect(td.daemon.lsm.enabled).toBe(true);
    expect(await lsm.waitFor((m) => m.type === "hello", "握手")).toMatchObject({
      serviceId: "ergou-daemon",
      pid: process.pid,
      port: td.daemon.localPort,
      protocol: 1,
      capabilities: ["busy", "stop", "restart", "health"],
    });
    // welcome 之后马上报一次：不忙
    expect(await lsm.waitFor(heartbeat, "第一次心跳")).toMatchObject({ busy: false });

    // （秘书写任务书、维护者交计划这些调用执行时也短暂报忙，见下面"有副作用的调用"那条）
    const before = lsm.messages.length;
    await startRunningTask(frontend);
    const taskReason = `正在执行 1 个任务：「${RUNNING_TASK_TITLE}」`;
    const busy = await lsm.waitFor((m) => busyBeat(true)(m) && m.busyReason === taskReason, "报忙的心跳", { from: before });
    expect(["ok", "degraded"]).toContain(busy.health);

    // 任务不再执行（取消）：马上补一次，不忙
    const busySeen = lsm.messages.length;
    ok(await frontend.taskAction({ taskId: RUNNING_TASK_ID, action: "cancel" }));
    expect(await lsm.waitFor(busyBeat(false), "不忙的心跳", { from: busySeen })).toMatchObject({ busy: false, busyReason: null });
    expect(lsm.messages.slice(busySeen).filter((m) => heartbeat(m.message)).map((m) => m.message.busy)).toEqual([false]);
  }, 60_000);

  it("按管理器给的间隔报心跳；秘书在运行时报健康", async () => {
    const { lsm } = await linkedDaemon(100);
    await lsm.waitFor(heartbeat, "心跳");
    await waitUntil(() => lsm.messages.filter((m) => heartbeat(m.message)).length >= 5, { timeoutMs: 10_000, describe: () => "等几次心跳" });
    // 间隔是管理器给的 100 毫秒，不是默认的 5 秒
    const beats = lsm.messages.filter((m) => heartbeat(m.message)).map((m) => m.at);
    expect(beats.slice(1).map((at, i) => at - beats[i]!).every((gap) => gap < 2_000)).toBe(true);
    expect(await lsm.waitFor((m) => heartbeat(m) && m.health === "ok", "报健康的心跳")).toMatchObject({ busy: false });
  }, 60_000);
});

describe("接入 LSM：停机", () => {
  it("立即停机：先应答，再优雅停止（端口关掉），发 bye", async () => {
    const { lsm, td } = await linkedDaemon(60_000);
    await lsm.waitFor(heartbeat, "第一次心跳");
    lsm.send({ type: "stop", id: "cmd-1", mode: "now", deadlineMs: 60_000 });
    expect(await lsm.waitFor((m) => m.type === "ack", "应答")).toEqual({ type: "ack", id: "cmd-1", ok: true });
    expect(await lsm.waitFor((m) => m.type === "bye", "bye")).toEqual({ type: "bye", reason: "shutdown-complete" });
    await untilStopped(td.url);
  }, 60_000);

  it("等空闲再停：有任务在跑就挂起，守护进程照常；管理器撤销后不停；再要求时等任务不再执行才停", async () => {
    const { lsm, td, frontend } = await linkedDaemon(60_000);
    await startRunningTask(frontend);
    await lsm.waitFor(busyBeat(true), "报忙的心跳");

    // 等空闲再停：忙，挂起
    lsm.send({ type: "stop", id: "cmd-1", mode: "when-idle", deadlineMs: 600_000 });
    expect(await lsm.waitFor((m) => m.type === "ack" && m.id === "cmd-1", "应答")).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 800));
    expect(await answers(td.url)).toBe(true);
    // 撤销
    lsm.send({ type: "cancel", id: "cmd-2" });
    expect(await lsm.waitFor((m) => m.type === "ack" && m.id === "cmd-2", "撤销的应答")).toMatchObject({ ok: true });
    // 再要求等空闲再停，然后任务结束：不忙了就停
    lsm.send({ type: "restart", id: "cmd-3", mode: "when-idle", deadlineMs: 600_000 });
    await lsm.waitFor((m) => m.type === "ack" && m.id === "cmd-3", "应答");
    await new Promise((r) => setTimeout(r, 500));
    expect(await answers(td.url)).toBe(true);
    expect(lsm.messages.some((m) => m.message.type === "bye")).toBe(false);
    ok(await frontend.taskAction({ taskId: RUNNING_TASK_ID, action: "cancel" }));
    expect(await lsm.waitFor((m) => m.type === "bye", "bye")).toEqual({ type: "bye", reason: "shutdown-complete" });
    expect((frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.task }).at(-1)?.payload as TaskEventPayload | undefined)?.task.state).toBe("cancelled");
    await untilStopped(td.url);
  }, 90_000);

  it("没有任务、但有正在执行的有副作用的调用（秘书在草稿区里跑脚本）：也报忙；等空闲再停会等它做完，不把它杀成说不清做没做完", async () => {
    const lsm = await startLsmStandIn({ heartbeatIntervalMs: 60_000 });
    const script = "setTimeout(() => require('node:fs').writeFileSync('done.txt', '好了'), 3000);\n";
    const td = await startTestDaemon({
      env: lsm.env,
      secretary: [{ kind: "reply", toolCalls: [{ name: "write", arguments: { path: "wait.js", content: script } }] }, { kind: "reply", toolCalls: [{ name: "bash", arguments: { command: "node wait.js" } }] }, { kind: "reply", text: "跑完了" }],
    });
    const frontend = await TestFrontend.connect(td.url);
    ok(await frontend.subscribe({ [CHANNELS.secretary]: 0 }));
    await lsm.waitFor(heartbeat, "第一次心跳");
    const before = lsm.messages.length;
    await frontend.sendText("跑一下");
    const busy = await lsm.waitFor((m) => busyBeat(true)(m) && String(m.busyReason).includes("通用 bash"), "跑脚本时报忙", { from: before });
    expect(busy.busyReason).toBe("1 个有副作用的调用还没做完：秘书对话的通用 bash");

    // 等空闲再停：脚本还在跑，挂起；跑完了（不忙了）才停
    lsm.send({ type: "stop", id: "cmd-1", mode: "when-idle", deadlineMs: 600_000 });
    await lsm.waitFor((m) => m.type === "ack" && m.id === "cmd-1", "应答");
    expect(await answers(td.url)).toBe(true);
    expect(await lsm.waitFor((m) => m.type === "bye", "bye")).toEqual({ type: "bye", reason: "shutdown-complete" });
    await untilStopped(td.url);
    expect(fs.readFileSync(path.join(td.daemon.layout.scratch, "done.txt"), "utf8")).toBe("好了");
  }, 60_000);

  it("子 agent（20 号票）有正在执行的有副作用的调用、任务本身在等我：也报忙（原因写子 agent 的调用）；等空闲再停会等它做完", async () => {
    const lsm = await startLsmStandIn({ heartbeatIntervalMs: 200 });
    // 维护者把 s1 交给 sa-1，用户同意后自己转为等我；sa-1 跑一个等 go.txt 出现才结束的脚本
    const run = [
      { kind: "reply", toolCalls: [{ name: "propose_parallel", arguments: { reason: "交给子 agent 做", agents: [{ stageId: "s1", instructions: "跑 wait.js" }] } }] },
      { kind: "reply", text: "等你确认" },
      { kind: "reply", toolCalls: [{ name: "wait_for_user", arguments: { reason: "等 sa-1 交回再问你" } }] },
      { kind: "reply", text: "等你" },
      { kind: "reply", text: "收到" },
    ] satisfies FauxStep[];
    const td = await startTestDaemon({
      env: lsm.env,
      secretary: SECRETARY_BRIEFS,
      maintainer: (_id, n) => maintainerScripts(run)[n - 1] ?? [],
      subAgent: () => [{ kind: "reply", toolCalls: [{ name: "bash", arguments: { command: "node wait.js" } }] }, { kind: "reply", text: "做完了" }],
    });
    const frontend = await TestFrontend.connect(td.url);
    ok(await frontend.subscribe({ [CHANNELS.board]: 0, [CHANNELS.cards]: 0 }));
    await startRunningTask(frontend);
    const work = path.join(td.daemon.layout.outputs, RUNNING_TASK_ID);
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(
      path.join(work, "wait.js"),
      "const fs = require('node:fs');\nconst t = setInterval(() => { if (fs.existsSync('go.txt')) { clearInterval(t); fs.writeFileSync('done.txt', '好了'); process.exit(0); } }, 100);\nsetTimeout(() => process.exit(1), 60000);\n",
    );
    let card: Card | undefined;
    await waitUntil(() => (card = frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card).find((c) => c.type === "parallel")) !== undefined, {
      timeoutMs: 30_000,
      describe: () => "等并行确认卡",
    });
    ok(await frontend.cardAction({ cardId: card!.id, action: "parallel", expectedVersion: card!.version }));

    // 任务在等我（不算执行中），sa-1 的脚本还在跑：报忙，原因只有它的调用
    await waitUntil(() => td.daemon.tasks.get(RUNNING_TASK_ID)?.state === "waiting_for_user", { timeoutMs: 30_000, describe: () => "等任务转为等我" });
    const reason = `1 个有副作用的调用还没做完：任务「${RUNNING_TASK_TITLE}」阶段 s1 的子 agent sa-1的通用 bash`;
    const before = lsm.messages.length;
    await lsm.waitFor((m) => busyBeat(true)(m) && m.busyReason === reason, "sa-1 跑脚本时报忙", { from: before });

    // 等空闲再停：sa-1 的调用还在跑，挂起；它做完了（不忙了）才停
    lsm.send({ type: "stop", id: "cmd-1", mode: "when-idle", deadlineMs: 600_000 });
    await lsm.waitFor((m) => m.type === "ack" && m.id === "cmd-1", "应答");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await answers(td.url)).toBe(true);
    fs.writeFileSync(path.join(work, "go.txt"), "");
    expect(await lsm.waitFor((m) => m.type === "bye", "bye")).toEqual({ type: "bye", reason: "shutdown-complete" });
    await untilStopped(td.url);
    expect(fs.readFileSync(path.join(work, "done.txt"), "utf8")).toBe("好了");
  }, 90_000);

  it("被重复启动（管理器回 conflict）：守护进程停下，不抢端口", async () => {
    const lsm = await startLsmStandIn({ conflict: true });
    const td = await startTestDaemon({ env: lsm.env });
    await lsm.waitFor((m) => m.type === "hello", "握手");
    await untilStopped(td.url);
    // 不再重连
    await new Promise((r) => setTimeout(r, 1_500));
    expect(lsm.connections).toBe(1);
    expect(lsm.messages.map((m) => m.message.type)).not.toContain("heartbeat");
  }, 60_000);
});

describe("接入 LSM：铁律", () => {
  it("没有注入身份（或协议版本不对）时静默跳过，照常起来", async () => {
    const plain = await startTestDaemon();
    expect(plain.daemon.lsm.enabled).toBe(false);
    expect(await answers(plain.url)).toBe(true);
    const lsm = await startLsmStandIn();
    const wrongVersion = await startTestDaemon({ env: { ...lsm.env, LSM_PROTOCOL: "2" } });
    expect(wrongVersion.daemon.lsm.enabled).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(lsm.connections + lsm.rejected).toBe(0);
  }, 60_000);

  it("注入了身份但管理器没在跑：照常起来，不报错；管理器起来之后自己连上", async () => {
    const port = await freePort();
    const token = "token-for-later";
    const env = { LSM_URL: `ws://127.0.0.1:${port}/link`, LSM_SERVICE_ID: "ergou-daemon", LSM_TOKEN: token, LSM_PROTOCOL: "1" };
    const td = await startTestDaemon({ env });
    expect(td.daemon.lsm.enabled).toBe(true);
    expect(await answers(td.url)).toBe(true);
    // 管理器后来起来了：重连（1 秒起翻倍）连上，握手
    const lsm = await startLsmStandIn({ port, token, heartbeatIntervalMs: 100 });
    expect(await lsm.waitFor((m) => m.type === "hello", "握手", { timeoutMs: 20_000 })).toMatchObject({ port: td.daemon.localPort });
    await lsm.waitFor(heartbeat, "心跳");
  }, 60_000);
});
