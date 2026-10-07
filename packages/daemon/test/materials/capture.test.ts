// 素材采集（规格第 15 节，模块层）：素材由守护进程从事件日志确定性地产生，agent 没法挑选。
// 每条素材有统一的信封；同一段事件日志重复处理（包括重启后）不产生重复素材；清空 memory.db 后重建，得到相同的素材。
// 本人素材连同信封另存原文副本，它是本人素材的真相：事件日志里的原始事件删掉了，重建时也从它补回来（ADR-0006）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type DeletedEventPayload, EVENT_TYPES, type EventType, maintainerChannel } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { type MaterialSource, userDecisionDraft } from "../../src/materials/capture.ts";
import { sha256Hex } from "../../src/materials/segments.ts";
import { MATERIAL_MODE } from "../../src/materials/types.ts";
import { BACKFILL_DELAY_MS } from "../../src/materials/vectors.ts";
import { vectorsSettled } from "../helpers/embedder.ts";
import { materialsSetup, postMessage, text } from "./helpers.ts";

describe("用户发言", () => {
  test("用户在秘书会话里发一条消息，产生一条用户发言素材，信封字段齐全", () => {
    const t = materialsSetup();
    const { message, event } = postMessage(t.store, [text("我打算下个月搬家")]);

    const [material, ...rest] = t.materials.list();
    expect(rest).toEqual([]);
    expect(material).toEqual({
      id: expect.stringMatching(/^mat-[0-9a-f]+$/),
      kind: "user_utterance",
      mode: "say",
      time: message.time,
      conversation: CHANNELS.secretary,
      task: null,
      project: null,
      source: "self",
      ref: { event: { globalSeq: event.globalSeq, channel: CHANNELS.secretary, seq: event.seq, type: "message" }, messageId: message.id },
      context: ["secretary"],
      segments: [
        { form: "typed", source: "self", notes: [], locator: { part: 0, start: 0, end: 8 }, text: "我打算下个月搬家", sha256: sha256Hex("我打算下个月搬家") },
      ],
      original: { path: `originals/2026-10/${material!.id}.json`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      noInfer: false,
    });
    expect(t.materials.get(material!.id)).toEqual(material);
  });

  test("维护者会话里用户的发言同样产生素材，来源会话是那个维护者的会话；消息事件带了任务、项目 id 就记上", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("这个接口先别改")], { conversation: maintainerChannel("p-notes"), taskId: "t-7", projectId: "p-notes" });
    postMessage(t.store, [text("秘书会话里没有任务")]);
    expect(t.materials.list()).toMatchObject([
      { kind: "user_utterance", conversation: "maintainer:p-notes", task: "t-7", project: "p-notes", context: ["maintainer"] },
      { conversation: CHANNELS.secretary, task: null, project: null },
    ]);
  });

  test("agent 的回复、系统说明不产生素材（agent 之间的往来、召回的记忆都不是用户的话）", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("好的，已经记下了")], { speaker: "agent" });
    postMessage(t.store, [text("上一条消息处理时中断了")], { speaker: "system" });
    expect(t.materials.list()).toEqual([]);
  });

  test("带附件和引用块的消息：附件、引用块只留引用加内容哈希，情境标签写明", () => {
    const t = materialsSetup();
    const media = "c".repeat(64);
    postMessage(t.store, [text("你看这个说法\n> 明年房价会涨"), { type: "image", mediaId: media, name: "截图.png", mime: "image/png" }]);
    const [material] = t.materials.list();
    expect(material!.context).toEqual(["secretary", "with_quote", "with_attachment"]);
    expect(material!.segments.map((s) => [s.form, s.source, s.text])).toEqual([
      ["typed", "self", "你看这个说法"],
      ["quote", "external_untrusted", undefined],
      ["attachment", "external_untrusted", undefined],
    ]);
    expect(material!.segments[2]).toMatchObject({ media: { mediaId: media, name: "截图.png", mime: "image/png" }, sha256: media, label: "截图.png" });
    // 原文副本里只有本人那段的原文：引用块、附件只有引用和哈希
    const stored = t.materials.readOriginal(material!)!;
    expect(stored.segments.map((s) => s.text)).toEqual(["你看这个说法", undefined, undefined]);
    expect(JSON.stringify(stored)).not.toContain("明年房价会涨");
  });

  test("\"作为材料投喂\"发出的消息记成用户主动投喂的材料（说）", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("这份是我的体检报告"), { type: "file", mediaId: "d".repeat(64), name: "体检.pdf", mime: "application/pdf", size: 10, asMaterial: true }]);
    expect(t.materials.list()).toMatchObject([{ kind: "fed_material", mode: "say", source: "self" }]);
  });
});

describe("原文副本", () => {
  test("本人素材连同信封（id、类型、说或做、时间、来源会话、任务或项目、来源等级、引用、情境标签、切段）存进素材区，原文一字不差，文件只读", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("周末想去爬山\n> 天气预报说有雨\n还是去吧")], { conversation: maintainerChannel("p-trip"), projectId: "p-trip" });
    const [material] = t.materials.list();
    const file = path.join(t.materialsDir, ...material!.original!.path.split("/"));
    const { original: _ref, noInfer: _mark, ...envelope } = material!;
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, position: 0, material: envelope });
    expect(envelope).toMatchObject({ kind: "user_utterance", mode: "say", conversation: "maintainer:p-trip", project: "p-trip", source: "self" });
    expect(t.materials.readOriginal(material!)!.segments.flatMap((s) => (s.text === undefined ? [] : [s.text]))).toEqual(["周末想去爬山", "还是去吧"]);
    expect(material!.original!.sha256).toBe(sha256Hex(fs.readFileSync(file, "utf8")));
    expect(() => fs.writeFileSync(file, "改掉")).toThrow(/EPERM|EACCES/);
    expect(() => fs.appendFileSync(file, "追加")).toThrow(/EPERM|EACCES/);
  });

  test("只发了附件也是本人的素材：原文副本里只有附件的引用；系统观察到的（长期没处理）没有原文副本", () => {
    const t = materialsSetup();
    postMessage(t.store, [{ type: "image", mediaId: "e".repeat(64), name: "a.png", mime: "image/png" }]);
    t.store.append({
      channel: CHANNELS.cards,
      type: EVENT_TYPES.cardStale,
      payload: { cardId: "c-1", cardType: "questions", pendingSince: "2026-10-01T09:00:00.000+08:00", time: "2026-10-08T09:00:00.000+08:00" },
    });
    const [attachmentOnly, stale] = t.materials.list();
    expect(t.materials.readOriginal(attachmentOnly!)!.segments).toEqual([expect.objectContaining({ form: "attachment", media: expect.objectContaining({ name: "a.png" }) })]);
    expect(stale!.original).toBeNull();
  });
});

describe("确定性：不重复、可重建", () => {
  test("守护进程重启后不重复产生素材，之后的新消息照常采集", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("第一句话")]);
    postMessage(t.store, [text("第二句话")]);
    await t.reopen();
    expect(t.materials.list().map((m) => m.segments[0]!.text)).toEqual(["第一句话", "第二句话"]);
    postMessage(t.store, [text("第三句话")]);
    expect(t.materials.list().map((m) => m.segments[0]!.text)).toEqual(["第一句话", "第二句话", "第三句话"]);
  });

  test("停着的时候追加的事件，下次打开时补采", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("开着时说的")]);
    // 素材模块停了，事件日志照样在长
    await t.materials.stop();
    postMessage(t.store, [text("停着时说的")]);
    await t.reopen();
    expect(t.materials.list().map((m) => m.segments[0]!.text)).toEqual(["开着时说的", "停着时说的"]);
  });

  test("写原文副本出错时（比如磁盘问题）这条先没采成、不丢：下一条事件来时从事件日志补上", () => {
    const t = materialsSetup();
    // 素材区的 originals 被一个同名文件占着：建目录会失败
    fs.mkdirSync(t.materialsDir, { recursive: true });
    fs.writeFileSync(path.join(t.materialsDir, "originals"), "挡路");
    postMessage(t.store, [text("磁盘出错时说的")]);
    expect(t.materials.list()).toEqual([]);
    expect(t.logs.join("\n")).toContain("事件订阅者出错");

    fs.rmSync(path.join(t.materialsDir, "originals"));
    postMessage(t.store, [text("恢复之后说的")]);
    expect(t.materials.list().map((m) => m.segments[0]!.text)).toEqual(["磁盘出错时说的", "恢复之后说的"]);
  });

  test("清空 memory.db 后从事件日志重建，得到相同的素材；原文副本文件不变、不多出来", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("我想换工作")]);
    postMessage(t.store, [text("老板太难相处\n> 你要学会忍")]);
    postMessage(t.store, [text("算了")], { speaker: "agent" });
    const before = t.materials.list();
    const files = listFiles(t.materialsDir);
    const stats = files.map((f) => fs.statSync(f).mtimeMs);

    await t.reopen({ deleteMemoryDb: true });
    expect(t.materials.list()).toEqual(before);
    expect(listFiles(t.materialsDir)).toEqual(files);
    expect(files.map((f) => fs.statSync(f).mtimeMs)).toEqual(stats);
  });

  test("删掉某个会话的事件（删项目时删掉维护者会话）再重建：本人素材从原文副本补回来，和原来一样，照样检索得到", async () => {
    const t = materialsSetup();
    const maintainer = maintainerChannel("p-house");
    postMessage(t.store, [text("下个月要搬家，这个项目先停")], { conversation: maintainer, projectId: "p-house" });
    postMessage(t.store, [text("搬家公司选便宜的"), { type: "file", mediaId: "a".repeat(64), name: "报价单.pdf", mime: "application/pdf", size: 1 }], { conversation: maintainer });
    postMessage(t.store, [text("维护者的回复不是素材")], { conversation: maintainer, speaker: "agent" });
    postMessage(t.store, [text("秘书会话里的话")]);
    const before = t.materials.list();

    await t.reopen({ deleteChannel: maintainer, deleteMemoryDb: true });
    expect(t.store.read(maintainer)).toEqual([]);
    expect(t.materials.list()).toEqual(before);
    expect(t.materials.searchKeyword("搬家公司").map((m) => m.id)).toEqual([before[1]!.id]);
    expect(t.materials.searchKeyword("报价单").map((m) => m.id)).toEqual([before[1]!.id]);
    expect(t.logs.join("\n")).toContain("从原文副本补回了 2 条本人素材");
    // 向量在启动后过一会儿补算
    t.clock.advance(BACKFILL_DELAY_MS);
    await vectorsSettled(t.materials);
    expect((await t.materials.searchSemantic("换个地方住", { limit: 1 }))[0]!.material.id).toBe(before[0]!.id);
  });

  test("彻底删除改写过的事件（\"已删除\"标记）一律跳过，不产生素材，也不写原文副本", async () => {
    const t = materialsSetup();
    // 素材模块停着时用户发了一条，还没采；21 号票的彻底删除把它改写成"已删除"标记
    await t.materials.stop();
    const { message, event } = postMessage(t.store, [text("这句要彻底删掉")]);
    const deleted: DeletedEventPayload = { deleted: true, deletedAt: "2026-10-09T10:00:00.000+08:00", messageId: message.id, messageTime: message.time };
    await t.reopen({ rewrite: { globalSeq: event.globalSeq, payload: deleted } });
    // 卡片频道上的事件同样
    t.store.append({ channel: CHANNELS.cards, type: EVENT_TYPES.cardDismissed, payload: deleted });

    expect(t.materials.list()).toEqual([]);
    expect(t.materials.searchKeyword("彻底删掉")).toEqual([]);
    expect(listFiles(t.materialsDir)).toEqual([]);
  });
});

describe("七类素材事件和回避信号", () => {
  test("都已定义类型，各自注明是说还是做", () => {
    expect(MATERIAL_MODE).toEqual({
      user_utterance: "say",
      output_reaction: "do",
      approval_decision: "do",
      clarification_answer: "say",
      fed_material: "say",
      memory_command: "say",
      task_outcome: "do",
      avoidance_signal: "do",
    });
  });

  test("其他票按采集接口把自己的事件类型登记为某类素材（替身：审批决定），用户接受 agent 的提议注明 agent 先提出", () => {
    // 替身：07 号票的审批决定事件还没做，这里用一个测试里的事件类型（正式的会加进 EVENT_TYPES）
    const approvalSource: MaterialSource = {
      name: "test-approval-decision",
      eventType: TEST_APPROVAL_DECIDED,
      capture: (event) => {
        const p = event.payload as { approvalId: string; decision: string; proposal: string; note?: string; task: string };
        return [
          userDecisionDraft({
            kind: "approval_decision",
            accepted: { text: p.proposal, field: "proposal" },
            ...(p.note === undefined ? {} : { typed: [{ text: p.note, field: "note" }] }),
            task: p.task,
            context: [`decision:${p.decision}`],
            ref: { recordId: p.approvalId },
          }),
        ];
      },
    };
    const t = materialsSetup({ sources: [approvalSource] });
    t.store.append({
      channel: "approvals-test",
      type: TEST_APPROVAL_DECIDED,
      payload: { approvalId: "a-1", decision: "approve", proposal: "运行草稿区外的脚本 D:\\tools\\sum.py", note: "只这一次", task: "t-1" },
    });

    expect(t.materials.list()).toMatchObject([
      {
        kind: "approval_decision",
        mode: "do",
        source: "self",
        task: "t-1",
        context: ["decision:approve"],
        ref: { recordId: "a-1", event: { type: TEST_APPROVAL_DECIDED } },
        segments: [
          { form: "choice", source: "self", notes: ["agent_proposed"], locator: { field: "proposal" }, text: "运行草稿区外的脚本 D:\\tools\\sum.py" },
          { form: "typed", source: "self", notes: [], locator: { field: "note" }, text: "只这一次" },
        ],
        original: { path: expect.stringMatching(/^originals\//) },
      },
    ]);
  });

  test("启动之后再登记报错（采集要确定性：来源都在启动前登记好）", () => {
    const t = materialsSetup();
    expect(() => t.materials.register({ name: "late", eventType: EVENT_TYPES.turnEnd, capture: () => [] })).toThrow("启动之前");
  });

  test("采集函数出错：记日志、跳过这条事件，不影响后面的", () => {
    const broken: MaterialSource = {
      name: "broken",
      eventType: TEST_BROKEN,
      capture: () => {
        throw new Error("坏了");
      },
    };
    const t = materialsSetup({ sources: [broken] });
    t.store.append({ channel: "x", type: TEST_BROKEN, payload: {} });
    postMessage(t.store, [text("后面这句照常")]);
    expect(t.logs.join("\n")).toContain("坏了");
    expect(t.materials.list().map((m) => m.kind)).toEqual(["user_utterance"]);
  });
});

/** 测试替身用的事件类型（不在 EVENT_TYPES 里） */
const TEST_APPROVAL_DECIDED = "test_approval_decided" as EventType;
const TEST_BROKEN = "test_broken" as EventType;

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name)).toSorted();
}
