// 主切面：时间线（规格第 5、19 节，25 号票）。真的守护进程，维护者接 faux 剧本，测试扮演前端。
// 一个两阶段的任务（工作目录 outputs/t-1 事先建成 git 仓库，计划开了 bash），维护者在两个阶段里做了几种调用：
// 直接做的写文件、通用 bash、授权内的建目录、做完告诉我的提交、先问过的读主目录、被硬拒绝的写围栏外；每个阶段的验收是脚本。
// - 工具调用 part 带齐第 5 节的字段（工具名、参数摘要、命中的关注类别、判定、是否授权内、是否通用 bash），取自守卫的判定；
// - 维护者会话里属于任务的消息带上当时的阶段（stageId），前端的全局层据此按阶段聚色块；
// - 活动状态频道一起录下：被唤起、干活中、等你批准、空闲、闲置退出；
// 录成 timeline-zoom 给前端状态层回放（要点层、全局层、三种样式、活动状态小圆点）。
import fs from "node:fs";
import path from "node:path";
import {
  type ActivityEventPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type Plan,
  type PlanCardPayload,
  type ProgressCardPayload,
  type TaskEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { initRepo } from "../helpers/git-repo.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, activity: ACTIVITY } = CHANNELS;
const M1 = maintainerChannel("tm-1");

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const fwd = (p: string) => p.replaceAll("\\", "/");

const messagesOf = (frontend: TestFrontend) => frontend.events({ channel: M1, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const activityOf = (frontend: TestFrontend, agentId: string) =>
  frontend
    .events({ channel: ACTIVITY, type: EVENT_TYPES.activity })
    .map((f) => f.payload as ActivityEventPayload)
    .filter((a) => a.agentId === agentId);

/** 工具调用 part 里守卫判定的那些字段 */
const gist = (p: ToolCallPart) => ({
  tool: p.tool,
  categoryTitles: p.categoryTitles,
  disposition: p.disposition,
  ...(p.blockedBy ? { blockedBy: p.blockedBy } : {}),
  withinGrant: p.withinGrant,
  genericBash: p.genericBash,
  outcome: p.outcome,
});
const toolIs = (tool: string) => (m: MessageEventPayload) => m.message.parts.some((p) => p.type === "tool_call" && p.tool === tool);

/** 两个阶段：s1 整理笔记（授权在主目录建 notes 目录），s2 写报告；都是脚本验收 */
function timelinePlan(home: string): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      {
        stageId: "s1",
        title: "整理笔记",
        deliverables: ["笔记 notes.md"],
        acceptance: [{ criterion: "笔记存在", method: "script", script: "test -f notes.md" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [{ id: "notes-dir", tool: "make_dir", title: "在主目录建 notes 目录", scope: { path: path.join(home, "notes") } }], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
      {
        stageId: "s2",
        title: "写报告",
        deliverables: ["报告 report.md"],
        acceptance: [{ criterion: "报告存在", method: "script", script: "test -f report.md" }],
        mode: "open",
        dependsOn: ["s1"],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: true, network: false },
    stops: { count: 0, where: [] },
  };
}

describe("演示流程（录给前端回放）", () => {
  it("两阶段任务里的几种调用：工具调用 part 带齐守卫判定的字段，消息带上当时的阶段；活动状态跟着被唤起、等你批准、闲置退出", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const home = fs.realpathSync.native(homeDir);
    fs.writeFileSync(path.join(home, "readme.txt"), "主目录里的说明");
    initRepo(path.join(dataDirLayout(dataDir).outputs, "t-1"));
    const plan = timelinePlan(home);
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      config: { agents: { idleMinutes: 0.02 } },
      // 录像只录任务的时间线：任务做完告诉秘书（99 号票）不落在录像的这段时间里（不然活动频道多出秘书忙、闲的两帧，而且看先后）
      taskDoneSettleMs: 600_000,
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [submitPlanStep(plan), say("计划交上去了")]
          : [
              // 第一阶段
              call("write", { path: "notes.md", content: "- 笔记一\n" }),
              call("bash", { command: "ls" }),
              call("bash", { command: `mkdir -p "${fwd(path.join(home, "notes"))}"` }),
              call("git_commit", { message: "整理笔记" }),
              call("read", { path: path.join(home, "readme.txt") }),
              call("complete_stage", { stageId: "s1", summary: "笔记在 notes.md" }),
              // 第二阶段
              call("write", { path: "report.md", content: "# 报告\n" }),
              call("write", { path: path.join(home, "outside.md"), content: "写到围栏外" }),
              call("complete_stage", { stageId: "s2", summary: "报告在 report.md" }),
              say("两个阶段都做完了"),
            ],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [ACTIVITY]: 0, [M1]: 0 });
    // 秘书常驻：先等它就绪（活动状态频道上它的那条排在前面，录下的事件流每次一样）
    await waitUntil(() => activityOf(frontend, "secretary").length > 0, { timeoutMs: 20_000 });
    const task = td.daemon.tasks.createByRequest({ title: "整理笔记和报告", summary: "整理笔记和报告" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理笔记，再写一份报告", acceptanceCriteria: ["笔记和报告都在"], constraints: [], projects: [], memoryScope: "" });
    let planCard: Card | undefined;
    await waitUntil(() => (planCard = cardsOf(frontend).find((c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id)) !== undefined, { timeoutMs: 30_000 });
    // 交完计划、空闲之后再确认（录下的事件流每次一样）
    await waitUntil(() => activityOf(frontend, "tm-1").some((a) => a.detail?.kind === "idle"), { timeoutMs: 30_000, describe: () => JSON.stringify(activityOf(frontend, "tm-1")) });
    expect((await frontend.cardAction({ cardId: planCard!.id, action: "confirm", expectedVersion: 1, input: {} })).ok).toBe(true);

    // 读主目录：越出项目目录、计划里没有授权，当场问；批准
    let approval: Card | undefined;
    await waitUntil(() => (approval = cardsOf(frontend).find((c) => c.type === "approval" && c.status === "pending")) !== undefined, { timeoutMs: 30_000 });
    await waitUntil(() => activityOf(frontend, "tm-1").at(-1)?.state === "waiting_for_user", { describe: () => JSON.stringify(activityOf(frontend, "tm-1")) });
    expect((await frontend.cardAction({ cardId: approval!.id, action: "approve", expectedVersion: approval!.version })).ok).toBe(true);

    await waitUntil(() => tasksOf(frontend).some((e) => e.change === "completed"), { timeoutMs: 60_000, describe: () => JSON.stringify(tasksOf(frontend).map((e) => e.change)) });
    await waitUntil(() => activityOf(frontend, "tm-1").at(-1)?.detail?.kind === "idle_exit", { timeoutMs: 30_000, describe: () => JSON.stringify(activityOf(frontend, "tm-1")) });

    // 工具调用 part：字段取自守卫的判定
    const parts = messagesOf(frontend)
      .flatMap((m) => m.message.parts)
      .filter((p): p is ToolCallPart => p.type === "tool_call");
    expect(parts.map(gist)).toEqual([
      { tool: "submit_plan", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done" },
      { tool: "write", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done" },
      { tool: "bash", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: true, outcome: "done" },
      { tool: "bash", categoryTitles: ["越出项目目录"], disposition: "do", withinGrant: true, genericBash: true, outcome: "done" },
      { tool: "git_commit", categoryTitles: [], disposition: "do_then_tell", withinGrant: false, genericBash: false, outcome: "done" },
      { tool: "read", categoryTitles: ["越出项目目录"], disposition: "ask_first", withinGrant: false, genericBash: false, outcome: "done" },
      { tool: "complete_stage", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done" },
      { tool: "write", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done" },
      expect.objectContaining({ tool: "write", blockedBy: "hard_refusal", withinGrant: false, genericBash: false, outcome: "blocked" }),
      { tool: "complete_stage", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done" },
    ]);
    expect(parts[2]!.argsSummary).toBe("ls");
    // 做了什么性质的事（54 号票，guard/nature.ts）：ls、读主目录是只看；写新文件、建目录、提交、交计划、宣布阶段完成是动手，
    // 被硬拒绝的写（围栏外的新文件）也按要做的事算
    expect(parts.map((p) => [p.tool, p.nature])).toEqual([
      ["submit_plan", "act"],
      ["write", "act"],
      ["bash", "look"],
      ["bash", "act"],
      ["git_commit", "act"],
      ["read", "look"],
      ["complete_stage", "act"],
      ["write", "act"],
      ["write", "act"],
      ["complete_stage", "act"],
    ]);

    // 消息带上当时的阶段：起草计划时没有阶段；第一阶段的调用（连同宣布它完成的那次）、审批卡、验收卡是 s1，之后是 s2
    const stageOf = (match: (m: MessageEventPayload) => boolean) => messagesOf(frontend).filter(match).map((m) => m.stageId ?? null);
    expect(stageOf(toolIs("submit_plan"))).toEqual([null]);
    expect(stageOf(toolIs("git_commit"))).toEqual(["s1"]);
    expect(stageOf(toolIs("complete_stage"))).toEqual(["s1", "s2"]);
    expect(stageOf(toolIs("write"))).toEqual(["s1", "s2", "s2"]);
    const cardStage = (type: string) => stageOf((m) => m.message.parts.some((p) => p.type === "card_ref" && cardsOf(frontend).some((c) => c.id === p.cardId && c.type === type)));
    expect(cardStage("approval")).toEqual(["s1"]);
    expect(cardStage("progress")).toEqual(["s1", "s2"]);
    expect(cardsOf(frontend).filter((c) => c.type === "progress").map((c) => (c.payload as ProgressCardPayload).stageId)).toEqual(["s1", "s2"]);
    expect(messagesOf(frontend).every((m) => m.taskId === task.id)).toBe(true);

    // 活动状态：第二次唤起（按确认的计划重新装配）之后，干活中、等你批准、批准后接着干、做完空闲、闲置退出
    const run = activityOf(frontend, "tm-1").map((a) => [a.state, a.detail ?? null] as const);
    expect(run.slice(run.findLastIndex(([, d]) => d?.kind === "woken"))).toEqual([
      ["working", { kind: "woken" }],
      ["working", { kind: "handling_input" }],
      ["waiting_for_user", { kind: "approval", tool: "读文件" }],
      ["working", { kind: "handling_input" }],
      ["sleeping", { kind: "idle" }],
      ["sleeping", { kind: "idle_exit" }],
    ]);
    saveOrCheckRecording("timeline-zoom", frontend.recording, { perChannel: true });

    // 往上翻的历史里同样带着所属的任务和阶段（更早的消息也能按阶段聚色块）
    const page = await frontend.history(M1, { limit: 200 });
    const paged = page.messages.flatMap((m) => ("message" in m ? [m] : []));
    expect(paged.map((m) => m.stageId ?? null)).toEqual(messagesOf(frontend).map((m) => m.stageId ?? null));
    expect(paged.every((m) => m.taskId === task.id)).toBe(true);
  }, 120_000);
});
