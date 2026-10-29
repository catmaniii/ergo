// 素材库 → 证据（224 号票，模块层）：MaterialsEvidenceSource 只读 ctx.materials，把一条素材映射成 @ergo/memory 的 EvidenceDraft。
// 四条规矩：只读（不写素材库、不改状态）；忘了的、彻底删掉的、标了"别推断"的不读；场景只留场景维度的标签，
// 一个都没有时才从原文推（管线标签 secretary、tool:bash、decision:approved 这类不是场景）；时间是素材记的原始记录时间。
import { CHANNELS, type DeleteCommandPayload, EVENT_TYPES, type MemoryCommandEventPayload, type MemoryDeleteMode } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from "../../src/config/config.ts";
import type { MaterialDraft, MaterialSource } from "../../src/materials/capture.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import { segmentPieces } from "../../src/materials/segments.ts";
import { MaterialsEvidenceSource } from "../../src/memory/evidence-source.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { materialsSetup, postMessage, text } from "../materials/helpers.ts";

type Setup = ReturnType<typeof materialsSetup>;

const MESSAGE_TIME = "2026-10-08T09:30:00.000+08:00";
/** 测试自己的一类素材事件：事件负载里直接给一条草稿（来源级别、情境标签、时间自己定） */
const DRAFT_EVENT = "test-evidence-draft" as never;

const draftSource: MaterialSource = {
  name: "test-evidence-draft",
  eventType: DRAFT_EVENT,
  capture: (event) => [(event.payload as { draft: MaterialDraft }).draft],
};

function setup() {
  const t = materialsSetup({ sources: [draftSource] });
  // 234 号票：基础映射的用例把敏感类别都当成"允许推断"，敏感类别各自的行为另有用例
  const source = (options: { inferableSensitiveCategories?: readonly SensitiveCategory[] } = {}) =>
    new MaterialsEvidenceSource({ materials: t.materials, clock: t.clock, inferableSensitiveCategories: options.inferableSensitiveCategories ?? SENSITIVE_CATEGORIES });
  return { t, source };
}

/** 追加一条测试素材（草稿的时间不给就用事件的时间） */
function emit(t: Setup, draft: MaterialDraft, time = MESSAGE_TIME) {
  return t.store.append({ channel: "test-evidence", type: DRAFT_EVENT, payload: { draft: { ...draft, time } } }).event;
}

/** 一条只有说明（label）、没有本人原文的切段 */
const label = (l: string) => segmentPieces([{ form: "agent_output", label: l, locator: {} }]);
/** 用户打的一段字 */
const typed = (t: string) => segmentPieces([{ form: "typed", text: t, locator: {} }]);

let commandNo = 0;
/** 记忆命令：忘掉 / 彻底删除 / 别推断（照 memory-commands.test.ts 的做法） */
function command(t: Setup, mode: MemoryDeleteMode, materialIds: string[]) {
  const from: DeleteCommandPayload["from"] = { kind: "project_deletion", projectId: "p-1" };
  const payload = { commandId: `cmd-224-${++commandNo}`, command: mode, materialIds, from } as MemoryCommandEventPayload;
  t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload });
}

describe("素材映射成证据", () => {
  test("八种素材对成证据的种类和说或做，四种来源级别照搬（external_untrusted 在 PoC 里叫 untrusted）", () => {
    const { t, source } = setup();
    const kinds: Array<[MaterialDraft["kind"], string, string]> = [
      ["user_utterance", "utterance", "say"],
      ["clarification_answer", "utterance", "say"],
      ["fed_material", "utterance", "say"],
      ["memory_command", "utterance", "say"],
      ["output_reaction", "reaction", "do"],
      ["approval_decision", "approval", "do"],
      ["task_outcome", "action", "do"],
      ["avoidance_signal", "action", "do"],
    ];
    kinds.forEach(([kind], i) => {
      const levels: Array<MaterialDraft["source"]> = ["self", "agent", "external_untrusted", "system"];
      emit(t, { kind, source: levels[i % levels.length]!, segments: label(`第 ${i + 1} 条素材`) });
    });

    const drafts = source().read();
    expect(drafts.map((d) => [d.kind, d.mode])).toEqual(kinds.map(([, evidenceKind, mode]) => [evidenceKind, mode]));
    expect(drafts.map((d) => d.sourceLevel)).toEqual(["self", "agent", "untrusted", "system", "self", "agent", "untrusted", "system"]);
    // 原文：本人的话取切段的文字，只有说明的取说明
    expect(drafts.map((d) => d.text)).toEqual(kinds.map((_, i) => `第 ${i + 1} 条素材`));
    // 出处是素材 id；证据 id 让存储自己分配（不是 mat- 开头）
    expect(drafts.map((d) => d.sourceRef)).toEqual(t.materials.list().map((m) => m.id));
    expect(drafts.every((d) => d.id === undefined)).toBe(true);
  });

  test("真人真事：用户说的话、用户关掉的卡，字段照素材库已有的来", () => {
    const { t, source } = setup();
    postMessage(t.store, [text("周六和朋友聚餐吧")], { time: MESSAGE_TIME });
    t.store.append({
      channel: CHANNELS.secretary,
      type: EVENT_TYPES.cardDismissed,
      payload: { cardId: "c-1", cardType: "suggest_task", action: "dismiss", note: "这次不用", time: MESSAGE_TIME } as never,
    });

    const drafts = source().read();
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ sourceLevel: "self", mode: "say", kind: "utterance", text: "周六和朋友聚餐吧", eventTime: MESSAGE_TIME, observedAt: MESSAGE_TIME });
    // 回避信号：用户做的（do），对成 action；卡片的说明和用户附的一句都在原文里
    expect(drafts[1]).toMatchObject({ sourceLevel: "self", mode: "do", kind: "action", eventTime: MESSAGE_TIME, observedAt: MESSAGE_TIME });
    expect(drafts[1]!.text).toContain("这次不用");
  });

  test("name 是 materials，now 取时钟", () => {
    const { t, source } = setup();
    const before = source();
    expect(before.name).toBe("materials");
    expect(before.now).toBe(clockIso(t.clock));
    t.clock.advance(2 * 60 * 60 * 1000);
    expect(source().now).toBe(clockIso(t.clock));
    expect(source().now).not.toBe(before.now);
  });
});

describe("场景：只留场景维度的标签，没有才从原文推", () => {
  test("只有管线标签、原文也说不出场景：场景是空", () => {
    const { t, source } = setup();
    emit(t, {
      kind: "user_utterance",
      source: "self",
      context: ["secretary", "voice_transcript", "decision:approved", "tool:bash", "category:outside_project"],
      segments: typed("把车库收拾一下"),
    });
    expect(source().read()[0]!.context).toEqual([]);
  });

  test("有场景维度的标签时只留那些（管线标签丢掉），也不再从原文推", () => {
    const { t, source } = setup();
    emit(t, { kind: "user_utterance", source: "self", context: ["secretary", "weekend", "work", "with_attachment"], segments: typed("周六也不休息") });
    expect(source().read()[0]!.context).toEqual(["weekend", "work"]);
  });

  test("一个场景维度的标签都没有时从原文按关键词推；推不出来的还是空", () => {
    const { t, source } = setup();
    emit(t, { kind: "user_utterance", source: "self", context: ["secretary"], segments: typed("周六和朋友聚餐") });
    emit(t, { kind: "user_utterance", source: "self", context: ["tool:bash"], segments: typed("把文件挪到临时目录") });
    expect(source().read().map((d) => d.context)).toEqual([["weekend", "social"], []]);
  });
});

describe("只读，忘了的不读", () => {
  test("读一遍不写素材库：事件日志不长、素材库不变", () => {
    const { t, source } = setup();
    postMessage(t.store, [text("周末去爬山")]);
    postMessage(t.store, [text("周三体检")]);
    const events = t.store.lastGlobalSeq();
    const materials = t.materials.list();

    expect(source().read()).toHaveLength(2);
    expect(t.store.lastGlobalSeq()).toBe(events);
    expect(t.materials.list()).toEqual(materials);
  });

  test("忘了的、彻底删掉的不读", () => {
    const { t, source } = setup();
    postMessage(t.store, [text("周末去爬山")]);
    postMessage(t.store, [text("周三体检")]);
    const [first, second] = t.materials.list();

    command(t, "forget", [first!.id]);
    expect(source().read().map((d) => d.sourceRef)).toEqual([second!.id]);

    command(t, "purge", [second!.id]);
    expect(source().read()).toEqual([]);
  });

  test("标了别推断的不读", () => {
    const { t, source } = setup();
    postMessage(t.store, [text("别记这个：房东要卖房")]);
    const [only] = t.materials.list();
    command(t, "no_infer", [only!.id]);
    expect(source().read()).toEqual([]);
  });

  test("发生时间和知道时间都用素材记的原始记录时间", () => {
    const { t, source } = setup();
    emit(t, { kind: "user_utterance", source: "self", segments: typed("晚上去跑步") }, "2026-10-07T21:30:00.000+08:00");
    expect(source().read()[0]).toMatchObject({ eventTime: "2026-10-07T21:30:00.000+08:00", observedAt: "2026-10-07T21:30:00.000+08:00" });
  });
});

describe("敏感类别（234 号票）：默认记录、不用于推断", () => {
  test("健康（场景标签 domain=health）默认不进证据；允许推断时才进", () => {
    const { t, source } = setup();
    postMessage(t.store, [text("周三体检")]); // 从原文认出 workday、health
    postMessage(t.store, [text("周五晚上和老王吃饭")]);

    const off = source({ inferableSensitiveCategories: [] }).read();
    expect(off.map((d) => d.text)).toEqual(["周五晚上和老王吃饭"]);

    const on = source({ inferableSensitiveCategories: ["health"] }).read();
    expect(on.map((d) => d.text)).toEqual(["周三体检", "周五晚上和老王吃饭"]);
    // 健康这条的 context 里确实有 health（不是靠原文另判）
    expect(on[0]!.context).toContain("health");
  });

  test("其余类别（情绪、财务、关系）是开关占位：打开它们不会让健康那条进证据", () => {
    const { t, source } = setup();
    postMessage(t.store, [text("周三体检")]);
    expect(source({ inferableSensitiveCategories: ["emotion", "finance", "relationship"] }).read()).toEqual([]);
  });

  test("不敏感的场景照常进证据，和开关无关", () => {
    const { t, source } = setup();
    postMessage(t.store, [text("周五晚上和老王吃饭")]);
    expect(source({ inferableSensitiveCategories: [] }).read()).toHaveLength(1);
  });
});
