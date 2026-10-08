// 主切面（可注入时钟）：无进展的催促、授权项的有效期和续期（规格第 8 节"阈值"、第 9 节"授权项"，14 号票）。
// - 维护者活着、任务在执行中、有阶段在做，20 分钟内没有成功的工具调用、也没有阶段推进：催一次（维护者正在干活时以插话送达）；
//   中间有了成功的工具调用或阶段推进，从那一刻重新计时，催促计数清零；同一次停滞里催满 3 次仍无进展，这一支停下、
//   任务转等我（卡住求助）；维护者的子进程不在运行（闲置退出了）不算停滞，不催；
// - 授权项默认有效期 7 天：到期前一天待我处理出现续期事项（不卡任务），续期后有效期延长；过期没续的不再生效，
//   执行到那一步时再问用户。
import path from "node:path";
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, type Plan } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import type { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import {
  call,
  cardWhere,
  confirmTask,
  connect,
  eventually,
  fwd,
  inputsDone,
  itemWhere,
  maintainerScript,
  messagesOf,
  noticesOf,
  ok,
  real,
  recordsOf,
  say,
  taskWhere,
  textOf,
  toolCallsOf,
  turnsOf,
  twoStagePlan,
  write,
} from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const M1 = maintainerChannel("tm-1");
const MINUTE = 60_000;
const DAY = 86_400_000;
const echo: FauxStep = { kind: "echo_context" };

/** 某条输入处理完了（作为一轮，或者作为插话收下） */
const inputDone = (frontend: TestFrontend, messageId: string) =>
  waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).some((f) => (f.payload as { inputMessageId: string }).inputMessageId === messageId), {
    timeoutMs: 30_000,
    describe: () => `等输入 ${messageId} 处理完`,
  });

/** 第 n 条催促（1 起）：等它出现，再等维护者处理完 */
async function nudgeHandled(frontend: TestFrontend, n: number): Promise<MessageEventPayload> {
  const nudge = await eventually(
    () => [noticesOf(frontend, M1).filter((m) => textOf(m).includes("没有成功的工具调用"))],
    (l) => l.length >= n,
    `第 ${n} 条催促`,
  ).then((l) => l[n - 1]!);
  await inputDone(frontend, nudge.message.id);
  return nudge;
}

describe("无进展的催促", () => {
  it("20 分钟没有进展催一次；有了成功的工具调用计数清零；正在干活时催促以插话送达；同一次停滞里催满 3 次仍无进展，这一支停下、任务转等我（卡住求助）", async () => {
    const clock = new ManualClock(new Date(2026, 9, 8, 9, 0));
    const td = await startTestDaemon({
      clock,
      maintainer: maintainerScript(twoStagePlan(), [
        // 开始执行：只说话，没有工具调用
        say("开始了"),
        // 第 1 次催促
        say("在想"),
        // 第 2 次催促：写了一个文件（成功的工具调用），催促计数清零
        write("a.md", "a"),
        say("写了一点"),
        // 计数清零后的第 1 次催促：跑一个慢命令，期间又到点了（第 2 次催促以插话送达）
        call("bash", { command: "sleep 3" }),
        echo,
        // 慢命令成功又清零；之后三次催促都只说话
        say("还在想 1"),
        say("还在想 2"),
        say("还在想 3"),
        // 第 4 次到点：这一支停下，收到停下的通知
        say("知道了"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "停滞");
    await turnsOf(frontend, M1, 2);

    // 差一点 20 分钟：不催
    clock.advance(20 * MINUTE - 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(noticesOf(frontend, M1).filter((m) => textOf(m).includes("没有成功的工具调用"))).toHaveLength(0);
    clock.advance(1);
    const first = await nudgeHandled(frontend, 1);
    expect(textOf(first)).toContain("20 分钟没有成功的工具调用");
    expect(textOf(first)).toContain("第 1/3 次催促");
    expect(first.interject).toBe(true);
    expect((await taskWhere(frontend, (e) => e.change === "nudged")).task.stages?.list?.[0]?.nudges).toBe(1);

    // 第 2 次：维护者写了文件，计数清零（progressed）
    clock.advance(20 * MINUTE);
    expect(textOf(await nudgeHandled(frontend, 2))).toContain("第 2/3 次催促");
    const cleared = await taskWhere(frontend, (e) => e.change === "progressed", "催促计数清零");
    expect(cleared.task.stages?.list?.[0]?.nudges).toBeUndefined();

    // 计数清零后（从写文件那一刻算）20 分钟：又是第 1 次；维护者跑 sleep 3 时再到点，第 2 次以插话送达（不另起一轮）
    clock.advance(20 * MINUTE);
    const third = await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes("第 1/3 次催促") && m.message.id !== first.message.id, "清零后的第 1 次催促");
    await waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnStart }).some((f) => (f.payload as { inputMessageId: string }).inputMessageId === third.message.id), {
      timeoutMs: 15_000,
      describe: () => "维护者开始处理催促",
    });
    await new Promise((r) => setTimeout(r, 1000));
    const earlier = new Set(noticesOf(frontend, M1).map((m) => m.message.id));
    clock.advance(20 * MINUTE);
    const interjected = await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes("第 2/3 次催促") && !earlier.has(m.message.id), "插话送达的催促");
    expect(interjected.interject).toBe(true);
    await inputDone(frontend, third.message.id);
    const ends = frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).map((f) => (f.payload as { inputMessageId: string }).inputMessageId);
    expect(ends.slice(-2)).toEqual([interjected.message.id, third.message.id]);
    // 插话在 sleep 的结果之后、下一次模型调用之前进了上下文
    const context = textOf(messagesOf(frontend, M1).filter((m) => m.message.speaker === "agent").at(-1)!);
    expect(context.indexOf("[toolResult] bash")).toBeGreaterThan(-1);
    expect(context.lastIndexOf("第 2/3 次催促")).toBeGreaterThan(context.indexOf("[toolResult] bash"));

    // sleep 成功又清零；之后 3 次催促都没有进展，第 4 次到点这一支停下
    for (let n = 1; n <= 3; n++) {
      clock.advance(20 * MINUTE);
      await eventually(() => tasksNudges(td, taskId), (k) => k === n, `第 ${n} 次催促`);
      await turnsOf(frontend, M1, 5 + n);
    }
    expect(td.daemon.tasks.get(taskId)?.state).toBe("running");
    clock.advance(20 * MINUTE);
    const waiting = await taskWhere(frontend, (e) => e.change === "waiting" && e.task.waitReason === "stuck", "转等我");
    expect(waiting.task.waitNote).toContain("20 分钟没有进展，催了 3 次仍没有进展");
    const help = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stuck_help");
    expect(help).toMatchObject({ urgency: "blocking", data: { taskId, stageIds: ["s1"] } });
    // 每次催促、停下都在时间线上记一笔偏离（属于 s1）
    const deviations = recordsOf(frontend, M1).filter((r) => r.record.kind === "deviation");
    expect(deviations.every((r) => r.stageId === "s1")).toBe(true);
    expect(deviations.at(-1)!.record.summary).toContain("催了 3 次仍没有进展");
    // 停下之后不再催
    await turnsOf(frontend, M1, 9);
    const before = noticesOf(frontend, M1).length;
    clock.advance(60 * MINUTE);
    await new Promise((r) => setTimeout(r, 200));
    expect(noticesOf(frontend, M1)).toHaveLength(before);
    // 给 Web 的回放：催促（一条插话送达）、卡住求助
    await inputsDone(frontend, M1);
    saveOrCheckRecording("task-nudge", frontend.recording, { perChannel: true });
  }, 120_000);
});

describe("无进展：阶段推进、维护者不在运行", () => {
  it("换去做另一个阶段（阶段推进）：从那一刻重新计时，催过的阶段计数清零，下一次催的是新的阶段", async () => {
    const clock = new ManualClock(new Date(2026, 9, 8, 9, 0));
    const base = twoStagePlan();
    const plan: Plan = { ...base, stages: [base.stages[0]!, { ...base.stages[1]!, dependsOn: [] }] };
    const td = await startTestDaemon({
      clock,
      maintainer: maintainerScript(plan, [say("开始了"), call("start_stage", { stageId: "s2" }), say("先做 s2"), say("在想")]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "换阶段");
    await turnsOf(frontend, M1, 2);

    clock.advance(20 * MINUTE);
    await nudgeHandled(frontend, 1);
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2", "换到 s2");
    await waitUntil(() => td.daemon.tasks.get(taskId)?.stages?.list?.[0]?.nudges === undefined, { timeoutMs: 10_000, describe: () => "s1 的催促计数清零" });
    expect(td.daemon.tasks.get(taskId)?.stages?.list?.[0]?.state).toBe("pending");

    // 从换阶段那一刻起算：差一点 20 分钟不催，到点催的是 s2（第 1 次）
    clock.advance(20 * MINUTE - 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(noticesOf(frontend, M1).filter((m) => textOf(m).includes("没有成功的工具调用"))).toHaveLength(1);
    clock.advance(1);
    const next = await nudgeHandled(frontend, 2);
    expect(textOf(next)).toContain("阶段 s2「写报告」已经 20 分钟没有成功的工具调用");
    expect(textOf(next)).toContain("第 1/3 次催促");
  }, 90_000);

  it("维护者闲置退出了（子进程不在运行）：到点不算停滞、不催，从那一刻重新计时", async () => {
    const clock = new ManualClock(new Date(2026, 9, 8, 9, 0));
    const td = await startTestDaemon({ clock, config: { agents: { idleMinutes: 0.01 } }, maintainer: maintainerScript(twoStagePlan(), [say("开始了")]) });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "闲置");
    await turnsOf(frontend, M1, 2);
    await waitUntil(() => !td.daemon.agents.live().some((a) => a.agentId === "tm-1"), { timeoutMs: 15_000, describe: () => "维护者闲置退出" });

    for (let n = 1; n <= 3; n++) {
      clock.advance(20 * MINUTE);
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(noticesOf(frontend, M1).filter((m) => textOf(m).includes("没有成功的工具调用"))).toHaveLength(0);
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ state: "running" });
    expect(td.daemon.tasks.get(taskId)?.stages?.list?.[0]?.nudges).toBeUndefined();
  }, 60_000);
});

/** 阶段 s1 的催促计数（看板上的样子） */
const tasksNudges = (td: Awaited<ReturnType<typeof startTestDaemon>>, taskId: string) => [td.daemon.tasks.get(taskId)?.stages?.list?.[0]?.nudges ?? 0];

describe("授权项的有效期", () => {
  it("到期前一天待我处理出现续期事项（不卡任务）；续期后有效期延长、照常放行；过期没续的不再生效，执行到那一步再问用户", async () => {
    const t0 = new Date(2026, 9, 8, 9, 0).getTime();
    const clock = new ManualClock(t0);
    const outside = real(makeTempDir("ergou-out-"));
    const base = twoStagePlan();
    const plan: Plan = {
      ...base,
      stages: [{ ...base.stages[0]!, policy: { grants: [{ id: "dir1", tool: "make_dir", title: "建 s1 目录", scope: { path: path.join(outside, "s1") } }], temporalRules: [] } }, base.stages[1]!],
    };
    const mkdir = call("bash", { command: `mkdir -p "${fwd(path.join(outside, "s1"))}"` });
    const td = await startTestDaemon({
      clock,
      // 不让无进展的催促掺进来
      config: { tasks: { thresholds: { stallMinutes: 365 * 24 * 60 } } },
      maintainer: maintainerScript(plan, [say("开始了"), mkdir, say("建好了"), mkdir, say("又要建")]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "续期");
    await turnsOf(frontend, M1, 2);

    // 到期前一天：续期事项（不卡任务）
    clock.advanceTo(t0 + 6 * DAY - MINUTE);
    await new Promise((r) => setTimeout(r, 200));
    expect(frontendRenewals(frontend)).toHaveLength(0);
    clock.advanceTo(t0 + 6 * DAY + MINUTE);
    const first = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "grant_renewal");
    expect(first).toMatchObject({ urgency: "non_blocking", actions: ["续期", "不续"], data: { taskId, grants: [{ grantId: "dir1" }] } });
    expect(first.kind === "notice" && first.body).toContain("建 s1 目录");
    expect(td.daemon.tasks.get(taskId)?.state).toBe("running");

    // 续期：有效期从原来的到期时间再延 7 天
    ok(await frontend.inboxAction({ itemIds: [first.id], action: "handle", choice: "续期" }));
    await waitUntil(() => td.daemon.tasks.confirmedPlan(taskId)?.grantTimes?.dir1?.expiresAt === t0 + 14 * DAY, { timeoutMs: 10_000, describe: () => "有效期延长" });
    // 过了原来的到期时间：照常放行（授权内）
    clock.advanceTo(t0 + 8 * DAY);
    await frontend.sendText("把 s1 目录建一下", { conversation: M1 });
    await turnsOf(frontend, M1, 3);
    expect(toolCallsOf(frontend, M1).filter((c) => c.tool === "bash").map((c) => [c.disposition, c.withinGrant, c.outcome])).toEqual([["do", true, "done"]]);

    // 新的到期时间前一天：又一条续期事项；这次不续
    clock.advanceTo(t0 + 13 * DAY + MINUTE);
    const second = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "grant_renewal" && i.id !== first.id);
    ok(await frontend.inboxAction({ itemIds: [second.id], action: "handle", choice: "不续" }));
    await itemWhere(frontend, (i) => i.id === second.id && i.kind === "notice" && i.handled === "不续");
    // 过期之后再做：授权项不再生效，先问用户（审批卡写明过期）
    clock.advanceTo(t0 + 15 * DAY);
    await frontend.sendText("再建一次", { conversation: M1 });
    const card = await cardWhere(frontend, (c) => c.type === "approval", "过期后的审批卡");
    expect(JSON.stringify(card.payload)).toContain("已过期");
    expect(td.daemon.tasks.confirmedPlan(taskId)?.grantTimes?.dir1?.expiresAt).toBe(t0 + 14 * DAY);
    // 两次决定都是素材（审批决定）
    const renewals = () => td.daemon.materials.list({ kind: "approval_decision" }).filter((m) => m.context.includes("notice:grant_renewal"));
    await waitUntil(() => renewals().length >= 2, { timeoutMs: 10_000, describe: () => "续期的素材" });
    expect(renewals().map((m) => m.context.find((c) => c.startsWith("decision:")))).toEqual(["decision:renewed", "decision:declined"]);
    // 给 Web 的回放：续期事项、过期后的审批卡（拒绝它，维护者这一轮接着走完）
    ok(await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version }));
    await inputsDone(frontend, M1);
    saveOrCheckRecording("grant-renewal", frontend.recording, { perChannel: true });
  }, 120_000);
});

const frontendRenewals = (frontend: TestFrontend) =>
  frontend
    .events({ channel: "inbox", type: EVENT_TYPES.inboxItem })
    .map((f) => (f.payload as { item: { kind: string; notice?: string } }).item)
    .filter((i) => i.kind === "notice" && i.notice === "grant_renewal");
