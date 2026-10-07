// 素材采集（规格第 15 节，模块层）：素材由守护进程从事件日志确定性地产生，agent 没法挑选。
// 每条素材有统一的信封；同一段事件日志重复处理（包括重启后）不产生重复素材；清空 memory.db 后重建，得到相同的素材。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, maintainerChannel } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { type MaterialSource, userDecisionDraft } from "../../src/materials/capture.ts";
import { sha256Hex } from "../../src/materials/segments.ts";
import { MATERIAL_MODE } from "../../src/materials/types.ts";
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
      originals: [{ segment: 0, path: expect.stringMatching(/^originals\/2026-10\/.+\.txt$/), sha256: sha256Hex("我打算下个月搬家") }],
    });
    expect(t.materials.get(material!.id)).toEqual(material);
  });

  test("维护者会话里用户的发言同样产生素材，来源会话是那个维护者的会话", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("这个接口先别改")], { conversation: maintainerChannel("p-notes") });
    expect(t.materials.list()).toMatchObject([{ kind: "user_utterance", conversation: "maintainer:p-notes", context: ["maintainer"] }]);
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
    expect(material!.segments[2]).toMatchObject({ media: { mediaId: media, name: "截图.png", mime: "image/png" }, sha256: media });
    // 只有本人的那段另存原文副本
    expect(material!.originals.map((o) => o.segment)).toEqual([0]);
  });

  test("\"作为材料投喂\"发出的消息记成用户主动投喂的材料（说）", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("这份是我的体检报告"), { type: "file", mediaId: "d".repeat(64), name: "体检.pdf", mime: "application/pdf", size: 10, asMaterial: true }]);
    expect(t.materials.list()).toMatchObject([{ kind: "fed_material", mode: "say", source: "self" }]);
  });
});

describe("原文副本", () => {
  test("本人的切段另存一份原文，放在素材区，内容一字不差，文件只读", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("周末想去爬山\n> 天气预报说有雨\n还是去吧")]);
    const [material] = t.materials.list();
    expect(material!.originals.map((o) => [o.segment, t.materials.readOriginal(o)])).toEqual([
      [0, "周末想去爬山"],
      [2, "还是去吧"],
    ]);
    for (const original of material!.originals) {
      const file = path.join(t.materialsDir, ...original.path.split("/"));
      expect(fs.readFileSync(file, "utf8")).toBe(material!.segments[original.segment]!.text);
      expect(() => fs.writeFileSync(file, "改掉")).toThrow(/EPERM|EACCES/);
      expect(() => fs.appendFileSync(file, "追加")).toThrow(/EPERM|EACCES/);
    }
  });

  test("没有本人的切段（只有附件）就没有原文副本", () => {
    const t = materialsSetup();
    postMessage(t.store, [{ type: "image", mediaId: "e".repeat(64), name: "a.png", mime: "image/png" }]);
    expect(t.materials.list()[0]!.originals).toEqual([]);
    expect(fs.existsSync(path.join(t.materialsDir, "originals"))).toBe(false);
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
    // 替身：07 号票的审批决定事件还没做，这里用一个测试里的事件类型
    const approvalSource: MaterialSource = {
      name: "test-approval-decision",
      eventType: "test_approval_decided",
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
      type: "test_approval_decided",
      payload: { approvalId: "a-1", decision: "approve", proposal: "运行草稿区外的脚本 D:\\tools\\sum.py", note: "只这一次", task: "t-1" },
    });

    expect(t.materials.list()).toMatchObject([
      {
        kind: "approval_decision",
        mode: "do",
        source: "self",
        task: "t-1",
        context: ["decision:approve"],
        ref: { recordId: "a-1", event: { type: "test_approval_decided" } },
        segments: [
          { form: "choice", source: "self", notes: ["agent_proposed"], locator: { field: "proposal" }, text: "运行草稿区外的脚本 D:\\tools\\sum.py" },
          { form: "typed", source: "self", notes: [], locator: { field: "note" }, text: "只这一次" },
        ],
        originals: [{ segment: 0 }, { segment: 1 }],
      },
    ]);
  });

  test("启动之后再登记报错（采集要确定性：来源都在启动前登记好）", () => {
    const t = materialsSetup();
    expect(() => t.materials.register({ name: "late", eventType: "x", capture: () => [] })).toThrow("启动之前");
  });

  test("采集函数出错：记日志、跳过这条事件，不影响后面的", () => {
    const broken: MaterialSource = {
      name: "broken",
      eventType: "test_broken",
      capture: () => {
        throw new Error("坏了");
      },
    };
    const t = materialsSetup({ sources: [broken] });
    t.store.append({ channel: "x", type: "test_broken", payload: {} });
    postMessage(t.store, [text("后面这句照常")]);
    expect(t.logs.join("\n")).toContain("坏了");
    expect(t.materials.list().map((m) => m.kind)).toEqual(["user_utterance"]);
  });
});

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name)).toSorted();
}
