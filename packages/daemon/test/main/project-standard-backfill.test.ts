// 主切面：现有项目补齐规范文档（262 号票，issue 19 Decisions 第 10 条；用户原话："可以给个任务，但是不一定要补，我确认后再补"）。
// 真的守护进程，测试扮演前端；项目的维护者、秘书接 faux 剧本。
// - 规范上线（守护进程第一次带着这一版起来）时记下规范上线之前建的项目（没有版本的）；
// - 其中立项书确认了、没归档、按类型和本项目的规范改写缺文档的，各出一张"补齐规范文档"卡（进待我处理）；不缺的、新项目（有版本的）、
//   立项书没确认的、已归档的不出；已归档的取消归档之后再出；
// - 选"补齐"：项目改用现在的规范（记下版本，有模板的几份从模板放进档案，已有的不动），建一个项目内部的普通任务交给维护者照项目现状补，
//   维护者在执行的工单段里补好、写回；选"不补"：什么都不动；
// - 一个项目只出一次：选过的（补齐、不补）重启之后也不再出。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  maintainerChannel,
  METHODS,
  type Project,
  type ProjectEventPayload,
  PROJECT_STANDARD_LATEST,
  type ProjectStandardView,
  type StandardBackfillCardPayload,
  type StandardChangeCardPayload,
  standardDocState,
  type WorkOrderEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { openEventStore } from "../../src/events/event-store.ts";
import { projectsView } from "../../src/projects/views.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { call, cardsOf, cardWhere, eventually, itemWhere, latestCards, ok, recordsOf, say, taskWhere, tasksOf, write } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, projects: PROJECTS, inbox: INBOX, board: BOARD } = CHANNELS;
const PM1 = maintainerChannel("pm-1");
const PM3 = maintainerChannel("pm-3");

/** 规范上线之前（258 号票之前）建的时间 */
const BEFORE = "2026-10-12T13:44:00.000+08:00";

/** 规范上线之前建的项目：没有版本；默认是开发类、使用中、立项书确认了 */
const legacy = (n: number, name: string, extra: Partial<Project> = {}): Project => ({
  id: `p-${n}`,
  name,
  goal: `${name}的目标`,
  state: "in_use",
  origin: "suggestion",
  maintainerId: `pm-${n}`,
  workdir: { external: false },
  charterConfirmed: true,
  kind: "dev",
  createdAt: BEFORE,
  updatedAt: BEFORE,
  ...extra,
});

/** 立项书还没确认的项目：还没有项目类型 */
const kindless = ({ kind: _kind, ...project }: Project): Project => project;

/** 守护进程起来之前就在的数据：事件日志里的项目、项目档案里已经写了的文档（规范上线之前就这样了） */
function existingData(dataDir: string, projects: readonly Project[], files: Record<string, string>) {
  const dbDir = path.join(dataDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const store = openEventStore({ file: path.join(dbDir, "ergo.db"), views: [projectsView] });
  try {
    for (const project of projects) store.append({ channel: PROJECTS, type: EVENT_TYPES.project, payload: { project, change: "created", from: null, by: "user" } satisfies ProjectEventPayload });
  } finally {
    store.close();
  }
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dataDir, "projects", ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries([CARDS, INBOX, PROJECTS, BOARD, PM1, PM3].map((c) => [c, 0])));
  return frontend;
}

async function standardOf(td: TestDaemon, projectId: string): Promise<ProjectStandardView> {
  const res = await requestJson<ProjectStandardView>(td.url, HTTP_PATHS.projectStandard(projectId));
  expect(res.status).toBe(200);
  return res.body;
}

/** 守护进程里现在的"补齐规范文档"卡（每张取最新的一版） */
const backfillCards = (td: TestDaemon): Card[] => [
  ...new Map(
    td.daemon.store
      .read(CARDS, 0, EVENT_TYPES.card)
      .map((e) => (e.payload as { card: Card }).card)
      .filter((c) => c.type === "standard_backfill")
      .map((c) => [c.id, c]),
  ).values(),
];

const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);

const ARCHITECTURE = "# 架构图\n\n```mermaid\nflowchart LR\n  抓取 --> 日报站\n```\n\n## 用到的服务\n\n| 服务 | 做什么 |\n|---|---|\n| daily-site | 日报站 |\n\n## 前端\n\n| 前端 | 在哪 |\n|---|---|\n| 日报页 | /apps/daily-site/ |\n\n## 对外接口\n\n| 接口 | 走哪 |\n|---|---|\n| 无 | |\n";
const OPS = `${JSON.stringify({ tools: [{ name: "latest_report", description: "最新一期日报" }] }, null, 2)}\n`;

describe("现有项目补齐规范文档（262 号票）", () => {
  it("规范上线时给缺文档的现有项目各出一张卡（不缺的、新项目、立项书没确认的、已归档的不出，取消归档后再出）；补齐才改用规范、建任务交给维护者补；不补什么都不动；选过的重启后也不再出", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const records = (id: string) => path.join(fs.realpathSync.native(dataDir), "projects", id);
    existingData(
      dataDir,
      [
        legacy(1, "简报站"),
        legacy(2, "汇率看板", { kind: "other" }),
        legacy(3, "旅行相册", { state: "archived", archivedFrom: "in_use" }),
        legacy(4, "账本", { standardVersion: PROJECT_STANDARD_LATEST, createdAt: "2026-10-24T10:00:00.000+08:00" }),
        kindless(legacy(5, "菜谱", { state: "preparing", charterConfirmed: false })),
      ],
      {
        "p-1/spec.md": "# 规格\n\n每天抓 AI 新闻出一份日报。\n",
        "p-1/progress.md": "# 进展\n\n首版上线了，每天出一份日报。\n",
        "p-1/adr/0001-抓取路线.md": "# 抓取路线\n\n用 RSS。\n",
        "p-2/spec.md": "# 规格\n\n盯内存条的价格。\n",
        "p-2/progress.md": "# 进展\n\n每天记一次价格。\n",
        "p-2/adr/0001-数据源.md": "# 数据源\n\n京东。\n",
        "p-3/spec.md": "# 规格\n\n旅行照片按地点、日期翻看。\n",
        "p-3/progress.md": "# 进展\n\n上线过一阵，归档了。\n",
        "p-3/adr/0001-存储.md": "# 存储\n\n本机目录。\n",
      },
    );
    const maintainer = (id: string, n: number): FauxStep[] =>
      id === "pm-1" && n === 1
        ? [
            write(path.join(records("p-1"), "architecture.md"), ARCHITECTURE),
            write(path.join(records("p-1"), "ops.json"), OPS),
            say("架构图、运营接口清单照现在的样子补好了"),
            call("edit", { path: path.join(records("p-1"), "progress.md"), edits: [{ oldText: "首版上线了，每天出一份日报。", newText: "首版上线了，每天出一份日报。\n\n补齐了规范文档：架构图、运营接口清单。" }] }),
            call("write_segment_summary", { summary: "补齐了规范文档" }),
            say("写回了"),
          ]
        : [];
    // 对话审批照用户现在的设置关着（测试底座默认开着）：维护者写项目档案里的架构图、运营接口清单不出审批卡
    const first = await startTestDaemon({ reuse: { dataDir, homeDir }, maintainer, secretary: [say("好")], config: { guard: { conversationApprovals: "off" } } });

    // 规范上线：记下规范上线之前建的项目（没有版本的），只记一次
    const launches = first.daemon.store.read("standards").filter((e) => e.type === "standard_backfill_launched");
    expect(launches.map((e) => (e.payload as { projects: string[] }).projects)).toEqual([["p-1", "p-2", "p-3", "p-5"]]);
    // 起来时就出好了：只有缺文档的简报站一张——汇率看板（其他类）三份都写了、账本是新项目、菜谱立项书没确认、旅行相册已归档，都不出
    expect(backfillCards(first).map((c) => (c.payload as StandardBackfillCardPayload).projectId)).toEqual(["p-1"]);

    const frontend = await connect(first.url);
    const card = await cardWhere(frontend, (c) => c.type === "standard_backfill" && (c.payload as StandardBackfillCardPayload).projectId === "p-1", "简报站的补齐规范文档卡");
    expect(card.status).toBe("pending");
    expect(card.payload).toEqual({
      projectId: "p-1",
      projectName: "简报站",
      kind: "dev",
      version: PROJECT_STANDARD_LATEST,
      missing: [
        { key: "architecture", path: "architecture.md", state: "missing" },
        { key: "tickets", path: "tickets/", state: "missing" },
        { key: "ops", path: "ops.json", state: "missing" },
      ],
    } satisfies StandardBackfillCardPayload);
    expect(card.text).toContain("架构图（architecture.md）、票（tickets/）、运营接口清单（ops.json）");
    await itemWhere(frontend, (i) => i.kind === "card" && i.cardId === card.id && i.origin?.projectId === "p-1", "待办里的补齐规范文档卡");
    // 出卡不动档案：确认之前项目还是没有版本，缺的照样缺
    expect(fs.existsSync(path.join(records("p-1"), "architecture.md"))).toBe(false);
    expect((await standardOf(first, "p-1")).version).toBeNull();

    // 已归档的旅行相册取消归档：这时再出
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-3", action: "unarchive" }, "k-unarchive"));
    const albumCard = await cardWhere(frontend, (c) => c.type === "standard_backfill" && (c.payload as StandardBackfillCardPayload).projectId === "p-3", "旅行相册的补齐规范文档卡");
    expect((albumCard.payload as StandardBackfillCardPayload).missing.map((d) => d.key)).toEqual(["architecture", "tickets", "ops"]);

    // 简报站选"补齐"：改用现在的规范（记下版本），有模板的几份从模板放进档案（写了的规格不动）；建一个项目内部的普通任务交给维护者补
    const specBefore = fs.readFileSync(path.join(records("p-1"), "spec.md"), "utf8");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }));
    const adopted = await eventually(() => projectEventsOf(frontend), (e) => e.change === "standard_adopted" && e.project.id === "p-1", "简报站改用规范");
    expect(adopted).toMatchObject({ by: "user", from: "in_use", project: { standardVersion: PROJECT_STANDARD_LATEST, state: "in_use" } });
    await waitUntil(() => fs.existsSync(path.join(records("p-1"), "ops.json")), { describe: () => "从模板放进档案的几份" });
    expect(fs.readdirSync(path.join(records("p-1"), "tickets"))).toEqual(["README.md"]);
    expect(fs.readFileSync(path.join(records("p-1"), "spec.md"), "utf8")).toBe(specBefore);
    const created = await taskWhere(frontend, (e) => e.change === "created" && e.task.internal?.projectId === "p-1", "补齐规范文档的任务");
    expect(created.task).toMatchObject({ title: "补齐规范文档", kind: "plain", maintainerId: "pm-1", projectScope: "single", internal: { projectId: "p-1", projectName: "简报站" } });
    expect(created.task.summary).toContain("架构图（architecture.md）");
    expect(created.task.summary).toContain("运营接口清单（ops.json）");
    const taskId = created.task.id;
    const decided = await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled", "处理过的简报站卡");
    expect((decided.payload as StandardBackfillCardPayload).decided).toEqual({ choice: "backfill", at: expect.any(String), taskId });
    expect(decided.text).toContain(`你选了补齐：建了任务 ${taskId}`);
    const record = await eventually(() => recordsOf(frontend, PM1), (r) => r.record.kind === "standard_backfill", "维护者会话时间线上的一笔");
    expect(record.record.summary).toBe(`你选了补齐规范文档：建了任务 ${taskId} 交给维护者补`);
    // 维护者在执行的工单段里照项目现状补好、写回，任务做完
    const wo = await eventually(() => workOrdersOf(frontend), (e) => e.change === "created" && (e.workOrder as { taskId?: string }).taskId === taskId, "执行的工单");
    expect((wo.workOrder as { instructions?: string }).instructions).toContain(`普通任务 ${taskId}「补齐规范文档」`);
    await waitUntil(() => tasksOf(frontend).some((e) => e.task.id === taskId && e.change === "completed"), { timeoutMs: 60_000, describe: () => "补齐规范文档的任务做完" });
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.id === wo.workOrder.id, "工单结束", 60_000);
    const after = await standardOf(first, "p-1");
    expect(after.version).toBe(PROJECT_STANDARD_LATEST);
    expect(after.docs.filter((d) => d.role !== "auxiliary").map((d) => [d.key, standardDocState(d)])).toEqual([
      ["spec", "written"],
      ["architecture", "written"],
      ["progress", "written"],
      ["adr", "written"],
      ["tickets", "template"],
      ["ops", "written"],
    ]);
    expect(fs.readFileSync(path.join(records("p-1"), "progress.md"), "utf8")).toContain("补齐了规范文档");

    // 旅行相册选"不补"：什么都不动——没有任务，项目还是没有版本，档案不补
    ok(await frontend.cardAction({ cardId: albumCard.id, action: "dismiss", expectedVersion: albumCard.version }));
    const skipped = await cardWhere(frontend, (c) => c.id === albumCard.id && c.status === "handled", "处理过的旅行相册卡");
    expect((skipped.payload as StandardBackfillCardPayload).decided).toEqual({ choice: "skip", at: expect.any(String) });
    expect(skipped.text).toContain("你选了不补");
    const skipRecord = await eventually(() => recordsOf(frontend, PM3), (r) => r.record.kind === "standard_backfill", "旅行相册维护者会话时间线上的一笔");
    expect(skipRecord.record.summary).toBe("你选了不补规范文档，不会再问");
    expect(tasksOf(frontend).some((e) => e.task.internal?.projectId === "p-3")).toBe(false);
    expect(first.daemon.projects.get("p-3")?.standardVersion).toBeUndefined();
    expect(fs.existsSync(path.join(records("p-3"), "architecture.md"))).toBe(false);
    // 不补之后项目再有变化（停用）也不再出
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-3", action: "retire" }, "k-retire"));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "retired" && e.project.id === "p-3", "旅行相册停用");
    expect(backfillCards(first)).toHaveLength(2);
    await first.daemon.stop();

    // 重启：规范上线只记一次；选过的（补齐、不补）都不再出，不缺的照样不出
    const second = await startTestDaemon({ reuse: { dataDir, homeDir } });
    expect(second.daemon.store.read("standards").filter((e) => e.type === "standard_backfill_launched")).toHaveLength(1);
    expect(backfillCards(second).map((c) => [(c.payload as StandardBackfillCardPayload).projectId, c.status, (c.payload as StandardBackfillCardPayload).decided?.choice])).toEqual([
      ["p-1", "handled", "backfill"],
      ["p-3", "handled", "skip"],
    ]);
    const fresh = await connect(second.url);
    await waitUntil(() => cardsOf(fresh).some((c) => c.id === card.id), { describe: () => "重连后看到原来的卡" });
    expect(latestCards(fresh).filter((c) => c.type === "standard_backfill" && c.status === "pending")).toEqual([]);
  }, 180_000);

  // 272 号票第 4 条：卡只出一次，"不补"之后想补也有路——放开 261 的"跟新版"：维护者对没有版本的项目也能提（upgrade），
  // 卡上写明是补齐规范文档、缺哪几份；用户确认后照 262 的补齐做（改用规范、从模板放进缺的几份、建任务交给维护者补）
  it("选了不补以后还能补：维护者照用户的话提跟新版（补齐卡还在等你选时不让提）；规范改写卡写明是补齐、缺哪几份；确认后改用规范、从模板放进缺的、建一个补齐规范文档的任务交给维护者，补齐卡不再出", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const records = (id: string) => path.join(fs.realpathSync.native(dataDir), "projects", id);
    existingData(dataDir, [legacy(1, "简报站")], {
      "p-1/spec.md": "# 规格\n\n每天抓 AI 新闻出一份日报。\n",
      "p-1/progress.md": "# 进展\n\n首版上线了，每天出一份日报。\n",
      "p-1/adr/0001-抓取路线.md": "# 抓取路线\n\n用 RSS。\n",
    });
    const td = await startTestDaemon({ reuse: { dataDir, homeDir }, maintainer: answeringMaintainer, secretary: [say("好")], config: { guard: { conversationApprovals: "off" } } });
    const frontend = await connect(td.url);
    const backfill = await cardWhere(frontend, (c) => c.type === "standard_backfill" && (c.payload as StandardBackfillCardPayload).projectId === "p-1", "简报站的补齐规范文档卡");
    const tool = td.daemon.standardChanges.tool("p-1", "pm-1");

    // 补齐卡还在等你选：不让维护者另提一张（两张卡都能补齐，免得重了）
    const early = await tool.run({ upgrade: true, why: "用户说补上规范文档" }, { toolCallId: "t-early" });
    expect(early.isError).toBe(true);
    expect(early.text).toContain("补齐规范文档的卡还在等用户选");

    // 选了不补：什么都不动
    ok(await frontend.cardAction({ cardId: backfill.id, action: "dismiss", expectedVersion: backfill.version }));
    await cardWhere(frontend, (c) => c.id === backfill.id && c.status === "handled", "处理过的补齐卡");
    expect(td.daemon.projects.get("p-1")?.standardVersion).toBeUndefined();

    // 之后用户改主意了：维护者提跟新版——出一张规范改写卡，写明是补齐规范文档、缺哪几份（规范上线之前建的，没有"从哪一版"）
    const proposed = await tool.run({ upgrade: true, why: "用户说还是把规范文档补上吧" }, { toolCallId: "t-up" });
    expect(proposed.isError).toBeUndefined();
    const card = await cardWhere(frontend, (c) => c.type === "standard_change" && (c.payload as StandardChangeCardPayload).projectId === "p-1", "补齐规范文档的规范改写卡");
    expect((card.payload as StandardChangeCardPayload).upgrade).toEqual({
      to: PROJECT_STANDARD_LATEST,
      missing: [
        { key: "architecture", path: "architecture.md", state: "missing" },
        { key: "tickets", path: "tickets/", state: "missing" },
        { key: "ops", path: "ops.json", state: "missing" },
      ],
    });
    expect(card.text).toContain(`补齐规范文档：改用规范 ${PROJECT_STANDARD_LATEST}`);
    expect(fs.existsSync(path.join(records("p-1"), "architecture.md"))).toBe(false);

    // 确认：照 262 的补齐做——改用规范（standard_adopted）、从模板放进缺的几份（写了的不动）、建项目内部的普通任务交给维护者补
    const specBefore = fs.readFileSync(path.join(records("p-1"), "spec.md"), "utf8");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }));
    const adopted = await eventually(() => projectEventsOf(frontend), (e) => e.change === "standard_adopted" && e.project.id === "p-1", "简报站改用规范");
    expect(adopted).toMatchObject({ by: "user", project: { standardVersion: PROJECT_STANDARD_LATEST } });
    await waitUntil(() => fs.existsSync(path.join(records("p-1"), "ops.json")), { describe: () => "从模板放进档案的几份" });
    expect(fs.readFileSync(path.join(records("p-1"), "spec.md"), "utf8")).toBe(specBefore);
    const created = await taskWhere(frontend, (e) => e.change === "created" && e.task.internal?.projectId === "p-1", "补齐规范文档的任务");
    expect(created.task).toMatchObject({ title: "补齐规范文档", kind: "plain", maintainerId: "pm-1", internal: { projectId: "p-1" } });
    expect(created.task.summary).toContain("架构图（architecture.md）");
    expect(created.task.summary).toContain("运营接口清单（ops.json）");
    // 维护者收到的通知写明建了哪个任务
    const notice = await eventually(() => messagesOfChannel(frontend, PM1), (m) => m.agentInput === true && m.message.speaker === "system" && JSON.stringify(m.message.parts).includes("补齐规范文档"), "给维护者的通知");
    expect(JSON.stringify(notice.message.parts)).toContain(created.task.id);
    expect((await standardOf(td, "p-1")).version).toBe(PROJECT_STANDARD_LATEST);
    // 补齐卡不再出（项目有版本了）
    expect(backfillCards(td).map((c) => [c.id, c.status])).toEqual([[backfill.id, "handled"]]);
  }, 120_000);
});

/** 维护者收到通知、被派到补齐的任务时照常应一句（272 那条用例不看它补得怎样，262 那条看过了） */
const answeringMaintainer = (id: string): FauxStep[] => (id === "pm-1" ? Array.from({ length: 6 }, () => say("好，我来补")) : []);

const messagesOfChannel = (frontend: TestFrontend, channel: string) =>
  frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as { agentInput?: boolean; message: { speaker: string; parts: unknown[] } });
