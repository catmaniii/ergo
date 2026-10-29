// 主切面：定时运行的"部分完成"（176 号票，用户 2026-10-19 定；照 19 号票的定时运行测试）。真的守护进程，秘书、维护者接 faux 剧本，
// 调度器的时钟换成手动拨的（ManualClock），测试扮演前端。读工作目录外的文件要先问（对话审批开着），等 5 分钟没批就挂起、拦下：
// - 拦下之后维护者自己报了失败：失败，原因后面跟着被拦下的那一步，算进连续失败；
// - 拦下之后维护者把这一轮做完了：部分完成，原因写清哪一步没做成，最后说的话照常作摘要；不算进连续失败也不清零、不触发自动暂停、
//   不改"最近一次失败"；秘书收到运行结果的通知，写明哪一步没做成、要它问用户补批；
// - 什么都没拦下：成功；这一次的上下文里"前几次运行的结果"写着上次部分完成、哪一步没做成；
// - 属于项目的：部分完成的这次运行马上记下结局，工单照常以完成收尾（写回项目档案）。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type Project,
  type ScheduledJobEventPayload,
  type WorkOrderEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { boardToolText } from "../../src/board/kinds.ts";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { TASK_DONE_TAG } from "../../src/secretary/task-done.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, secretary: SECRETARY, projects: PROJECTS } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const PM1 = maintainerChannel("pm-1");

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-08 是周四） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 8, 8, 0);
const DAILY_9 = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "09:00" } };
/** 读工作目录外的文件要先问用户（对话审批开着）；等 5 分钟（默认）没批就挂起、拦下 */
const APPROVALS_ON = { guard: { conversationApprovals: "on" } };

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
const jobWhere = (frontend: TestFrontend, match: (e: ScheduledJobEventPayload) => boolean, what: string) => eventually(() => jobsOf(frontend), match, what, 60_000);
/** 某一次运行结束了（运行结束那一条：运行记录、登记的样子） */
const runEnded = (frontend: TestFrontend, runId: string) => jobWhere(frontend, (e) => e.change === "run_finished" && e.run?.runId === runId, `${runId} 结束`);
/** 秘书会话里运行结果的通知（运行时发的、排进它输入队列的系统消息） */
const resultNotices = (frontend: TestFrontend) => messagesOf(frontend, SECRETARY).filter((m) => m.agentInput === true && textOf(m).startsWith(TASK_DONE_TAG));
/** 交给 agent 的一次运行的通知 */
const noticesIn = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.agentInput === true).map(textOf);
/** agent 最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const lastEcho = (frontend: TestFrontend, channel: string) => textOf(messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").at(-1)!);

async function connect(url: string, channels: string[]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 工作目录外的一份笔记（读它要先问用户） */
function outsideNotes(): string {
  const file = path.join(realPathOf(makeTempDir("ergo-outside-"))!, "notes.txt");
  fs.writeFileSync(file, "外面的笔记");
  return file;
}

/** 到点之后先问用户的那张审批卡出来，再拨过 5 分钟让它挂起（拦下） */
async function letApprovalLapse(frontend: TestFrontend, clock: ManualClock, n: number) {
  await waitUntil(() => cardsOf(frontend).filter((c) => c.type === "approval" && c.version === 1).length >= n, { timeoutMs: 60_000, describe: () => `等第 ${n} 张审批卡` });
  clock.advance(6 * 60_000);
}

describe("部分完成", () => {
  it("拦下之后报了失败是失败（原因跟着那一步）；拦下之后做完了是部分完成：不算进连续失败也不清零、不自动暂停，秘书收到写明哪步没做成的通知；下一次成功，上下文里写着上次部分完成", async () => {
    const notes = outsideNotes();
    const clock = new ManualClock(START);
    const td = await startTestDaemon({
      clock,
      // 连续失败 2 次就自动暂停：部分完成要是算进去，第 2 次就会暂停
      config: { ...APPROVALS_ON, scheduledJobs: { jobFailures: 2 } },
      secretary: [say("简报这次部分完成了：笔记那一步没等到你的批准，要去待办里补批吗？"), say("第三份简报好了")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call(TOOL.read, { path: notes }), call("fail_job_run", { reason: "新闻源连不上" }), say("这次没做成")]
          : spawn === 2
            ? [call(TOOL.read, { path: notes }), say("笔记读不到，我换了个办法，简报照样写好了：brief.md")]
            : [ECHO],
    });
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, SECRETARY, TM1]);
    ok(await frontend.startTask("每天早上出一份简报\n读一遍那份笔记，汇总昨天的新闻", "k-daily", [], "plain", DAILY_9));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");

    // 第 1 次：拦下之后自己报了失败 → 失败，原因后面跟着被拦下的那一步，算进连续失败
    clock.advanceTo(at(10, 8, 9, 0));
    await letApprovalLapse(frontend, clock, 1);
    const first = await runEnded(frontend, "j-1-r1");
    expect(first.run).toMatchObject({ state: "failed", reason: expect.stringMatching(/^新闻源连不上；另外有一步没等到你的批准：「.+」（.*notes\.txt.*）$/) });
    expect(first.job).toMatchObject({ state: "active", lastFailed: true, consecutiveFailures: 1 });
    await settled(td, "tm-1");

    // 第 2 次：拦下之后把这一轮做完了 → 部分完成
    clock.advanceTo(at(10, 9, 9, 0));
    await letApprovalLapse(frontend, clock, 2);
    const second = await runEnded(frontend, "j-1-r2");
    expect(second.run).toMatchObject({
      state: "partial",
      reason: expect.stringMatching(/^有一步没等到你的批准：「.+」（.*notes\.txt.*）$/),
      // 维护者最后那句汇报照常作摘要
      summary: "笔记读不到，我换了个办法，简报照样写好了：brief.md",
    });
    // 不算进连续失败、也不清零；没自动暂停；"最近一次失败"照旧是上一次算数的那次
    expect(second.job).toMatchObject({ state: "active", lastFailed: true, consecutiveFailures: 1, lastRun: { runId: "j-1-r2", state: "partial" } });
    expect(second.job.pausedBy).toBeUndefined();
    expect(frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).some((f) => JSON.stringify(f.payload).includes("scheduled_job_auto_paused"))).toBe(false);
    // 秘书的查看板：标"最近一次部分完成"（不再标上一次的"最近一次失败"）
    expect(boardToolText(td.daemon.store, td.daemon.boardKinds)).toMatch(/- 任务 t-1「每天早上出一份简报」：运营中 · 最近一次部分完成；/);

    // 秘书收到这次运行的结果（第 1 次失败的不发）：写明部分完成、哪一步没做成、要它问用户补批
    clock.advance(1000);
    await waitUntil(() => resultNotices(frontend).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书收到运行结果的通知" });
    const notice = resultNotices(frontend)[0]!;
    expect(textOf(notice)).toContain("定时触发的普通任务 t-1「每天早上出一份简报」的第 2 次运行部分完成了（触发：10 月 9 日（周五）09:00 到点）。");
    expect(textOf(notice)).toContain(`没做成的：${second.run!.reason}`);
    expect(textOf(notice)).toContain("它最后说：\n笔记读不到，我换了个办法，简报照样写好了：brief.md");
    expect(textOf(notice)).toContain("补批");
    expect(notice.message.summary).toBe("t-1「每天早上出一份简报」第 2 次运行部分完成");
    await waitUntil(() => messagesOf(frontend, SECRETARY).some((m) => m.message.speaker === "agent"), { timeoutMs: 30_000, describe: () => "等秘书在主线里说一声" });
    await settled(td, "tm-1");

    // 第 3 次：什么都没拦下 → 成功，连续失败清零；交给它的"前几次运行的结果"里写着上次部分完成、哪一步没做成
    clock.advanceTo(at(10, 10, 9, 0));
    const third = await runEnded(frontend, "j-1-r3");
    expect(third.run).toMatchObject({ state: "done" });
    expect(third.job).toMatchObject({ lastFailed: false, consecutiveFailures: 0 });
    const instructions = noticesIn(frontend, TM1).find((t) => t.includes("第 3 次运行"))!;
    expect(instructions).toContain(`- 第 2 次运行（10 月 9 日（周五）09:00）：部分完成——${second.run!.reason}；最后说的：笔记读不到，我换了个办法，简报照样写好了：brief.md`);
    expect(instructions).toContain(`- 第 1 次运行（10 月 8 日（周四）09:00）：失败——新闻源连不上；另外有一步没等到你的批准`);
    expect(lastEcho(frontend, TM1)).toContain("：部分完成——有一步没等到你的批准");
  }, 180_000);

  it("属于项目的：拦下之后维护者做完、写回了 → 这次运行部分完成，工单照常以完成收尾", async () => {
    const notes = outsideNotes();
    const dataDir = makeTempDir("ergo-data-");
    const records = path.join(fs.realpathSync.native(dataDir), "projects", "p-1");
    const clock = new ManualClock(START);
    const td: TestDaemon = await startTestDaemon({
      clock,
      reuse: { dataDir, homeDir: makeTempDir("ergo-home-") },
      config: APPROVALS_ON,
      secretary: [say("好的")],
      maintainer: (id) =>
        id === "pm-1"
          ? [
              call(TOOL.read, { path: notes }),
              call("write", { path: "brief.md", content: "# 今日简报\n" }),
              call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText: "做到哪了、下一步做什么：每段工作结束时写回。", newText: "简报：10-08 的简报出了，笔记那一步没等到批准。" }] }),
              call("write_segment_summary", { summary: "出了 10-08 的简报，笔记那一步没等到批准" }),
              say("简报出了；笔记那一步没等到批准，先跳过了"),
            ]
          : [],
    });
    const project: Project = seedProject(td.daemon, "资讯站", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });
    expect(project.id).toBe("p-1");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    ok(await frontend.startTask("每天早上出简报\n读一遍那份笔记，写一份简报 brief.md", "k-brief", ["资讯站"], "plain", DAILY_9));
    await jobWhere(frontend, (e) => e.change === "registered", "登记");

    clock.advanceTo(at(10, 8, 9, 0));
    await letApprovalLapse(frontend, clock, 1);
    const finished = await runEnded(frontend, "j-1-r1");
    expect(finished.run).toMatchObject({ state: "partial", reason: expect.stringMatching(/^有一步没等到你的批准：「.+」（.*notes\.txt.*）$/) });
    expect(finished.job).toMatchObject({ lastFailed: false, consecutiveFailures: 0 });
    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "run", "运行的工单结束", 60_000);
    expect(ended.workOrder).toMatchObject({ outcome: "done" });
    await settled(td, "pm-1");
    // 工单结束不再改这次运行的结局
    expect(td.daemon.scheduledJobs.get("j-1")!.lastRun).toMatchObject({ runId: "j-1-r1", state: "partial" });
    expect(fs.readFileSync(path.join(records, "workdir", "brief.md"), "utf8")).toBe("# 今日简报\n");
  }, 180_000);
});
