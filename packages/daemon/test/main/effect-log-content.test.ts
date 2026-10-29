// 主切面：效果记录不存写进去的全文（68 号票）。真的守护进程，agent 接 faux 剧本，测试扮演前端：
// - 新写的效果记录里，写文件的全文、改文件的新旧片段只有字符数和 SHA-256：事件日志里没有原文，效果日志（派生视图）里也没有；
//   路径照原样，详情页的效果记录照常显示（摘要、涉及的文件）；调用的完整内容（53 号票，受 65 号票的保留期管）里照旧有原文；
// - 本票之前的数据目录：效果日志里还有原文。启动时从事件日志补一遍效果日志，归并时缩——效果日志变小、条数和序号不变，
//   事件日志原样不动（规格第 15 节：事件日志不可修改）；时序规则照样看得到之前做过什么（阶段上的规则"读报告之前要先写过笔记"
//   迁移后照样满足），详情页的效果记录和迁移前一样。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, type MessagePart } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import type { EventStore } from "../../src/events/event-store.ts";
import type { EffectRecord } from "../../src/guard/index.ts";
import { type EffectRecordedPayload, GUARD_EVENTS } from "../../src/guard-runtime/events.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { toolCallDetail } from "../helpers/http.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { onePlan, runningTask } from "../helpers/running-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const MAINTAINER = maintainerChannel("tm-1");
const LONG_TEST_MS = 120_000;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const reply = (text: string): FauxStep => ({ kind: "reply", text });
const toolPartsOf = (frontend: TestFrontend, channel: string): ToolCallPart[] =>
  frontend
    .events({ channel, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");
const gist = (p: ToolCallPart) => ({ tool: p.tool, disposition: p.disposition, outcome: p.outcome });

/** 一段写进文件的笔记（多行） */
const NOTES = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：周三下午三点和装修师傅确认厨房的水电改造方案`).join("\n");
const EDITS = [{ oldText: "第 1 行：周三下午三点", newText: "第 1 行：周四上午十点" }];
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const digest = (text: string) => ({ $digest: { length: text.length, sha256: sha256(text) } });

/** 事件日志里的效果记录（守卫频道上的 effect_recorded） */
const effectEvents = (store: EventStore): EffectRecord[] => store.ofType(GUARD_EVENTS.effectRecorded).flatMap((e) => (e.payload as EffectRecordedPayload).records);
/** 效果日志（派生视图）里存的每一条，按序号 */
const effectRows = (store: EventStore): EffectRecord[] =>
  store.reader.all<{ record: string }>("SELECT record FROM effect_log ORDER BY seq").map((r) => JSON.parse(r.record) as EffectRecord);
/** 效果日志（派生视图）一共多少字 */
const effectLogSize = (store: EventStore): number => Number(store.reader.get<{ n: number | null }>("SELECT SUM(length(record)) AS n FROM effect_log")?.n ?? 0);

describe("新写的效果记录", () => {
  it("写文件的全文、改文件的新旧片段只记字符数和 SHA-256：事件日志、效果日志里都没有原文；路径照原样，详情页的效果记录照常显示", async () => {
    const { url, dataDir, daemon } = await startTestDaemon({
      secretary: [call("write", { path: "notes.md", content: NOTES }), call("edit", { path: "notes.md", edits: EDITS }), reply("记好了")],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("把装修的事记下来，时间改成周四上午");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const notes = path.join(dataDirLayout(realPathOf(dataDir)!).scratch, "notes.md");
    expect(fs.readFileSync(notes, "utf8")).toBe(NOTES.replace(EDITS[0]!.oldText, EDITS[0]!.newText));

    const [write, edit] = toolPartsOf(frontend, SECRETARY);
    expect([write?.outcome, edit?.outcome]).toEqual(["done", "done"]);
    const stored = { write: { path: notes, content: digest(NOTES) }, edit: { path: notes, edits: [digest(JSON.stringify(EDITS[0]))] } };
    for (const records of [effectEvents(daemon.store), effectRows(daemon.store)]) {
      expect(records.map((r) => [r.tool, r.args])).toEqual([
        ["write", stored.write],
        ["edit", stored.edit],
      ]);
    }
    // 原文一个字也不在：事件日志里的效果记录、效果日志
    const everything = JSON.stringify([daemon.store.ofType(GUARD_EVENTS.effectRecorded), effectRows(daemon.store)]);
    for (const text of ["装修师傅", "周四上午十点"]) expect(everything).not.toContain(text);

    // 详情页：效果记录照常（摘要、改动的文件），注明写了多少；完整内容里照旧有原文（53 号票，受保留期管）
    const writeDetail = (await toolCallDetail(url, write!.callId)).body;
    expect(writeDetail.args).toEqual({ path: "notes.md", content: NOTES });
    expect(writeDetail.effects).toEqual([
      expect.objectContaining({
        tool: "write",
        summary: expect.stringMatching(/^写文件；改动 .*notes\.md；成功/),
        objects: [{ kind: "path", access: "write", value: notes }],
        content: `写入 ${NOTES.length} 字`,
      }),
    ]);
    expect((await toolCallDetail(url, edit!.callId)).body.effects).toEqual([
      expect.objectContaining({
        tool: "edit",
        summary: expect.stringMatching(/^改文件；改动 .*notes\.md；成功/),
        objects: [{ kind: "path", access: "write", value: notes }],
        content: "改了 1 处",
      }),
    ]);
  });
});

describe("本票之前的数据目录", () => {
  /** 阶段上的一条规则：读报告之前要先写过笔记（看效果日志里写文件的路径） */
  const notesFirst = {
    id: "notes-before-report",
    title: "读报告之前要先写过笔记",
    trigger: { tool: "read" },
    when: { matches: ["$current.args.path", "report\\.md$"] },
    require: { before: { tool: "write", where: { matches: ["$prior.args.path", "notes\\.md$"] } } },
    message: "先把笔记写好再看报告",
    on_violation: "block",
  };
  const plan = onePlan();
  plan.stages[0]!.policy.temporalRules = [notesFirst];
  const readReport = call("read", { path: "report.md" });

  it(
    "效果日志里还有原文：启动时补一遍、归并时缩，效果日志变小（条数、序号不变），事件日志原样不动；时序规则照样看得到之前写过的文件；详情页的效果记录和迁移前一样",
    async () => {
      const dataDir = makeTempDir("ergo-data-");
      const homeDir = makeTempDir("ergo-home-");
      const work = path.join(dataDirLayout(dataDir).outputs, "t-1");
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(work, "report.md"), "# 装修报告\n");

      // 第一次：执行中的任务，维护者先看报告（还没写过笔记，被规则拦下），写笔记、改笔记，再看报告（照常），
      // 最后用 bash 写一个文件（拆出来的写文件只带路径：最近的一条写文件里没有内容，迁移不能只看它）
      const first = await startTestDaemon({
        maintainer: (_id, spawn) =>
          spawn === 1
            ? [submitPlanStep(plan), reply("计划交上去了")]
            : [
                readReport,
                call("write", { path: "notes.md", content: NOTES }),
                call("edit", { path: "notes.md", edits: EDITS }),
                readReport,
                call("bash", { command: "echo 看过了 > done.txt" }),
                reply("看过了"),
              ],
        reuse: { dataDir, homeDir },
      });
      const frontend = await TestFrontend.connect(first.url);
      await frontend.subscribe({ [MAINTAINER]: 0, [CHANNELS.board]: 0, [CHANNELS.cards]: 0 });
      await runningTask(first, frontend, "记下装修的事");
      const executed = () => toolPartsOf(frontend, MAINTAINER).filter((p) => p.tool !== "submit_plan");
      await waitUntil(() => executed().length === 5 && executed().every((p) => p.outcome !== "running"), { timeoutMs: 60_000, describe: () => JSON.stringify(executed().map(gist)) });
      const parts = executed();
      expect(parts.map(gist)).toEqual([
        { tool: "read", disposition: "never", outcome: "blocked" },
        { tool: "write", disposition: "do", outcome: "done" },
        { tool: "edit", disposition: "do", outcome: "done" },
        { tool: "read", disposition: "do", outcome: "done" },
        { tool: "bash", disposition: "do", outcome: "done" },
      ]);
      const detailsBefore = await Promise.all(parts.map(async (p) => (await toolCallDetail(first.url, p.callId)).body.effects));
      const dbFile = path.join(first.daemon.layout.db, "ergo.db");
      await first.daemon.stop();

      // 换回本票之前的样子：事件日志和效果日志里写文件、改文件的参数是原文，表上没有记口径的版本
      const db = openDatabase(dbFile);
      db.exec("DROP TABLE effect_log_format");
      // bash 拆出来的写文件只带路径，本来就没有内容
      const legacy = (r: EffectRecord): EffectRecord =>
        r.tool === "write" && r.args.content !== undefined ? { ...r, args: { ...r.args, content: NOTES } } : r.tool === "edit" ? { ...r, args: { ...r.args, edits: EDITS } } : r;
      for (const row of db.all<{ global_seq: number; payload: string }>("SELECT global_seq, payload FROM events WHERE type = ?", GUARD_EVENTS.effectRecorded)) {
        const payload = JSON.parse(row.payload) as EffectRecordedPayload;
        db.run("UPDATE events SET payload = ? WHERE global_seq = ?", JSON.stringify({ records: payload.records.map(legacy) }), row.global_seq);
      }
      for (const row of db.all<{ seq: number; record: string }>("SELECT seq, record FROM effect_log")) {
        db.run("UPDATE effect_log SET record = ? WHERE seq = ?", JSON.stringify(legacy(JSON.parse(row.record) as EffectRecord)), row.seq);
      }
      const rawRows = db.all<{ record: string }>("SELECT record FROM effect_log ORDER BY seq").map((r) => JSON.parse(r.record) as EffectRecord);
      const rawSize = Number(db.get<{ n: number }>("SELECT SUM(length(record)) AS n FROM effect_log")!.n);
      const rawEvents = db.all<{ payload: string }>("SELECT payload FROM events WHERE type = ? ORDER BY global_seq", GUARD_EVENTS.effectRecorded).map((r) => r.payload);
      db.close();
      expect(rawRows.map((r) => r.tool)).toEqual(["submit_plan", "write", "edit", "read", "shell_command", "write"]);
      expect(rawRows[1]!.args.content).toBe(NOTES);
      expect(rawRows.at(-1)!.args).toEqual({ path: path.join(realPathOf(work)!, "done.txt") });

      // 第二次启动：效果日志缩了（条数、序号、别的参数不变），事件日志一个字没动
      const second = await startTestDaemon({ maintainer: [readReport, reply("又看了一遍")], reuse: { dataDir, homeDir } });
      const compact = (r: EffectRecord): EffectRecord =>
        r.tool === "write" && r.args.content !== undefined
          ? { ...r, args: { ...r.args, content: digest(NOTES) } }
          : r.tool === "edit"
            ? { ...r, args: { ...r.args, edits: [digest(JSON.stringify(EDITS[0]))] } }
            : r;
      expect(effectRows(second.daemon.store)).toEqual(rawRows.map(compact));
      expect(rawSize - effectLogSize(second.daemon.store)).toBeGreaterThan(NOTES.length - 200);
      expect(second.daemon.store.ofType(GUARD_EVENTS.effectRecorded).map((e) => JSON.stringify(e.payload))).toEqual(rawEvents);
      // 表上记下了按哪一版口径存的，下次打开不再补
      expect(second.daemon.store.reader.all("SELECT version FROM effect_log_format")).toEqual([{ version: 2 }]);

      // 详情页的效果记录和迁移前一样（写了多少照样注明）
      expect(detailsBefore[1]).toEqual([expect.objectContaining({ tool: "write", content: `写入 ${NOTES.length} 字` })]);
      for (const [i, p] of parts.entries()) expect((await toolCallDetail(second.url, p.callId)).body.effects).toEqual(detailsBefore[i]);

      // 时序规则照样看得到之前写过笔记（效果日志里写文件的路径还在）：再看报告，照常
      const fresh = await TestFrontend.connect(second.url);
      await fresh.subscribe({ [MAINTAINER]: 0 });
      second.daemon.store.append(buildAgentNotice(MAINTAINER, "再看一眼报告", "k-again", { taskId: "t-1" }).event);
      const reads = () => toolPartsOf(fresh, MAINTAINER).filter((p) => p.tool === "read");
      await waitUntil(() => reads().length === 3 && reads().every((p) => p.outcome !== "running"), { timeoutMs: 60_000, describe: () => JSON.stringify(reads().map(gist)) });
      expect(reads().at(-1)).toMatchObject({ disposition: "do", outcome: "done" });
    },
    LONG_TEST_MS,
  );
});

