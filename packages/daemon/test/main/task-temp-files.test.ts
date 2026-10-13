// 主切面（111 号票，用户 2026-10-13 定"任务中间的临时文件和脚本，以及为了生成每个项目阶段交付件临时生成的脚本和数据，默认可以修改或者删除，
// 不要每次都问我或者拦住了"）。真的守护进程，维护者接 faux 剧本、在真的工作目录里写文件跑脚本，测试扮演前端：
// - 长程任务：维护者写脚本 → 整个改写脚本 → 跑脚本生成交付件和中间数据 → 删脚本和中间数据目录，全程不退回、不计拉回、不标"删除或覆盖"，
//   阶段照常验收推进；效果日志里照旧记着这些调用；
// - 照旧的：任务开始之前就在的文件（比如上一个任务留下的）删除照旧按规则退回、计入拉回；交出去了的阶段的交付件也一样；
// - 普通任务：一样放开（守卫按普通对话判，对话审批开着也不为它出审批卡），任务开始之前就在的照旧退回；
// - 项目里按项目认（用户补充"任务和项目的临时文件都是一样的"）：前一张工单生成的临时脚本、中间数据，下一张工单删不拦；
//   维护者直接和用户对话时删项目里先前生成的中间数据也不拦；项目开始之前就在工作目录里的照旧拦。
// 测试底座的对话审批默认开着：放开不是靠"任务 agent 超出授权先不管"。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type MessagePart, type WorkOrderEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { listEffects } from "../../src/guard-runtime/effect-log.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import {
  call,
  cardsOf,
  completeStage,
  confirmPlan,
  connect,
  draftTask,
  eventually,
  maintainerScript,
  messagesOf,
  ok,
  real,
  say,
  stageStates,
  taskWhere,
  tasksOf,
  turnsOf,
  twoStagePlan,
  write,
} from "../helpers/task-flow.ts";
import { waitUntil } from "../helpers/process.ts";

const M1 = maintainerChannel("tm-1");
const bash = (command: string) => call("bash", { command });
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
/** 维护者会话里读写文件、bash 的工具调用记录：工具、处置、拦下的原因、结局、命中的类别 */
const fileCalls = (frontend: TestFrontend, channel = M1) =>
  messagesOf(frontend, channel)
    .flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"))
    .filter((p) => p.tool === "write" || p.tool === "bash")
    .map((p) => [p.argsSummary, p.disposition ?? null, p.blockedBy ?? null, p.outcome, p.categoryTitles]);

/** 生成交付件（资料清单 sources.md）的脚本：中间数据放在 tmp/ 里（守卫没看见、靠创建时间认出来） */
const GENERATOR = [
  'const fs = require("node:fs");',
  'fs.mkdirSync("tmp", { recursive: true });',
  'fs.writeFileSync("tmp/data.json", JSON.stringify(["来源一", "来源二"]));',
  'const items = JSON.parse(fs.readFileSync("tmp/data.json", "utf8"));',
  'fs.writeFileSync("sources.md", items.map((s) => `- ${s}`).join("\\n") + "\\n");',
].join("\n");

const DELETE = "删除或覆盖（项目档案和工作目录内）";

describe("长程任务：任务自己的临时脚本、中间数据随便改、删", () => {
  it("写脚本 → 改脚本 → 跑脚本生成交付件 → 删脚本和中间数据：不退回、不计拉回、阶段照常推进；任务开始前就在的、交出去了的交付件照旧退回", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(twoStagePlan(), [
        write("gen.cjs", "// 草稿：还没写完\n"),
        // 整个改写自己刚写的脚本
        write("gen.cjs", GENERATOR),
        bash("node gen.cjs"),
        // 删掉脚本和中间数据目录
        bash("rm -rf gen.cjs tmp"),
        // 任务开始之前就在的文件：照旧退回
        bash("rm legacy-notes.md"),
        completeStage("s1", "资料清单在 sources.md"),
        // s1 交出去了：它的交付件照旧受保护
        bash("rm sources.md"),
        write("report.md", "# 报告\n"),
        completeStage("s2", "报告在 report.md"),
        say("做完了"),
      ]),
    });
    const frontend = await connect(td.url);
    const draft = await draftTask(td, frontend, "X 的调研");
    await turnsOf(frontend, M1, 1);
    // 任务开始之前就在工作目录（任务的产出区）里的文件，比如上一个任务留下的
    const workDir = path.join(td.daemon.layout.outputs, draft.taskId);
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "legacy-notes.md"), "上一个任务留下的笔记\n");
    await new Promise((r) => setTimeout(r, 50));
    const taskId = await confirmPlan(frontend, draft);

    const done = await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务做完");
    expect(stageStates(done.task)).toEqual({ s1: "accepted", s2: "accepted" });
    const calls = await eventually(() => [fileCalls(frontend)], (l) => l.length === 7, "七次读写文件、bash 的记录");
    expect(calls).toEqual([
      [expect.stringContaining("gen.cjs"), "do", null, "done", []],
      [expect.stringContaining("gen.cjs"), "do", null, "done", []],
      [expect.stringContaining("node gen.cjs"), "do", null, "done", []],
      [expect.stringContaining("rm -rf gen.cjs tmp"), "do", null, "done", []],
      [expect.stringContaining("rm legacy-notes.md"), "do_then_tell", "pull_back", "blocked", [DELETE]],
      [expect.stringContaining("rm sources.md"), "do_then_tell", "pull_back", "blocked", [DELETE]],
      [expect.stringContaining("report.md"), "do", null, "done", []],
    ]);
    expect(fs.existsSync(path.join(workDir, "gen.cjs"))).toBe(false);
    expect(fs.existsSync(path.join(workDir, "tmp"))).toBe(false);
    expect(fs.readFileSync(path.join(workDir, "sources.md"), "utf8")).toBe("- 来源一\n- 来源二\n");
    expect(fs.existsSync(path.join(workDir, "legacy-notes.md"))).toBe(true);
    // 拉回只记了那两次（每个阶段一次），临时文件的改写、删除一次都没算
    const pulled = tasksOf(frontend).filter((e) => e.task.id === taskId && e.change === "pulled_back");
    expect(pulled.map((e) => e.stageId)).toEqual(["s1", "s2"]);
    expect(done.task.stages?.list?.map((s) => s.pullBacks ?? 0)).toEqual([1, 1]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
    // 效果日志里照旧记着：改写脚本、跑脚本、删脚本和中间数据
    const effects = listEffects(td.daemon.store.reader, { taskId });
    const at = (name: string) => path.join(real(workDir), name);
    expect(effects.filter((e) => e.tool === "write" || e.tool === "delete" || e.tool === "run_script").map((e) => [e.tool, e.args.path])).toEqual([
      ["write", at("gen.cjs")],
      ["write", at("gen.cjs")],
      ["run_script", at("gen.cjs")],
      ["delete", at("gen.cjs")],
      ["delete", at("tmp")],
      ["write", at("report.md")],
    ]);
    // 第一次写是新建（效果日志记着），守卫靠它认出第二次是改写自己的脚本
    expect(effects.find((e) => e.tool === "write")?.created).toEqual([at("gen.cjs")]);
  }, 90_000);
});

describe("普通任务：一样放开", () => {
  it("改写、删除自己写的脚本和它生成的数据：不退回、不出审批卡；任务开始之前就在的照旧退回", async () => {
    const td = await startTestDaemon({
      secretary: [say("好")],
      maintainer: [
        write("gen.cjs", "// 草稿\n"),
        write("gen.cjs", GENERATOR),
        bash("node gen.cjs"),
        bash("rm -rf gen.cjs tmp sources.md"),
        bash("rm old.md"),
        say("整理完了"),
      ],
    });
    // 任务开始之前就在的：普通任务的工作目录是产出区里它的一格（t-1）
    const workDir = path.join(td.daemon.layout.outputs, "t-1");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "old.md"), "早就在的\n");
    await new Promise((r) => setTimeout(r, 50));
    const frontend = await connect(td.url);
    expect(ok(await frontend.startTask("整理一份资料清单", "k-temp", [], "plain"))).toEqual({ taskId: "t-1" });
    await waitUntil(() => tasksOf(frontend).some((e) => e.task.id === "t-1" && e.change === "completed"), { timeoutMs: 30_000, describe: () => "等普通任务做完" });

    const calls = await eventually(() => [fileCalls(frontend)], (l) => l.length === 5, "五次读写文件、bash 的记录");
    expect(calls).toEqual([
      [expect.stringContaining("gen.cjs"), "do", null, "done", []],
      [expect.stringContaining("gen.cjs"), "do", null, "done", []],
      [expect.stringContaining("node gen.cjs"), "do", null, "done", []],
      [expect.stringContaining("rm -rf gen.cjs tmp sources.md"), "do", null, "done", []],
      // 对话里删除或覆盖是先问我：先按规则退回（补上前提再问）
      [expect.stringContaining("rm old.md"), "ask_first", "pull_back", "blocked", [DELETE]],
    ]);
    expect(fs.readdirSync(workDir)).toEqual(["old.md"]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
  }, 90_000);
});

const PM1 = maintainerChannel("pm-1");
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";
/** 项目的维护者写回进展（工单段收尾） */
const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: CHANNELS.projects, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);

describe("项目里按项目认（用户补充：任务和项目的临时文件都是一样的）", () => {
  it("前一张工单生成的临时脚本、中间数据，下一张工单删不拦；维护者直接对话时删先前生成的也不拦；项目开始之前就在工作目录里的照旧拦", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const records = path.join(real(dataDir), "projects", "p-1");
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir: makeTempDir("ergou-home-") },
      secretary: [say("好"), say("好"), say("好")],
      maintainer: (id, n) => {
        if (id !== "pm-1") return [];
        // 第一张工单（项目内部的普通任务）：写脚本、跑脚本，生成资料清单和中间数据
        if (n === 1) return [write("gen.cjs", GENERATOR), bash("node gen.cjs"), say("清单生成好了：sources.md"), progressEdit(records, PROGRESS_INTRO, "生成了资料清单。"), call("write_segment_summary", { summary: "生成了资料清单" }), say("写回了")];
        // 第二张工单（接着说）：删上一张工单留下的脚本和中间数据；项目开始之前就在的照旧被退回
        if (n === 2) return [bash("rm -rf gen.cjs tmp"), bash("rm old.md"), say("删了"), progressEdit(records, "生成了资料清单。", "生成了资料清单，删了中间数据。"), call("write_segment_summary", { summary: "删了中间数据" }), say("写回了")];
        // 直接和用户对话（没有任务）：删先前生成的资料清单
        return [bash("rm sources.md"), say("删了")];
      },
    });
    // 项目开始之前就在工作目录里的（比如用户放进去的）
    const workDir = path.join(records, "workdir");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "old.md"), "早就在的\n");
    await new Promise((r) => setTimeout(r, 50));
    seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: true, network: true } });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([CHANNELS.board, CHANNELS.cards, CHANNELS.inbox, CHANNELS.projects, PM1].map((c) => [c, 0])));

    expect(ok(await frontend.startTask("生成资料清单", "k-project-temp", ["记账本"], "plain"))).toEqual({ taskId: "t-1" });
    const ended = (n: number) => waitUntil(() => workOrdersOf(frontend).filter((e) => e.change === "ended").length >= n, { timeoutMs: 30_000, describe: () => `等第 ${n} 张工单结束` });
    await ended(1);
    await frontend.sendText("把生成清单用的脚本和中间数据删了", { conversation: PM1, taskId: "t-1" });
    await ended(2);
    await frontend.sendText("资料清单也不要了", { conversation: PM1 });

    const calls = await eventually(() => [fileCalls(frontend, PM1)], (l) => l.length === 5, "五次读写文件、bash 的记录");
    expect(calls).toEqual([
      [expect.stringContaining("gen.cjs"), "do", null, "done", []],
      [expect.stringContaining("node gen.cjs"), "do", null, "done", []],
      [expect.stringContaining("rm -rf gen.cjs tmp"), "do", null, "done", []],
      [expect.stringContaining("rm old.md"), "ask_first", "pull_back", "blocked", [DELETE]],
      [expect.stringContaining("rm sources.md"), "do", null, "done", []],
    ]);
    expect(fs.readdirSync(workDir)).toEqual(["old.md"]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
  }, 90_000);
});
