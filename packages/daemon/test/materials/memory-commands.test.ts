// 显式记忆命令在素材模块这一侧（规格第 14、15 节，ADR-0006；模块层）：memory_command 事件是"显式记忆命令"素材的来源，
// 也是删除（忘掉、彻底删除）和标记（别推断）素材的依据。materials.db 是派生的，所以删掉 materials.db 重建、
// 或者只在原文副本里的素材，被删的都不会回来，标记也还在。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  type DeleteCommandPayload,
  type DeletedEventPayload,
  EVENT_TYPES,
  maintainerChannel,
  type MemoryCommandEventPayload,
  type MemoryDeleteMode,
  type RememberCommandPayload,
} from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { deletedMarker } from "../../src/events/purge.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import { BACKFILL_DELAY_MS } from "../../src/materials/vectors.ts";
import { vectorsSettled } from "../helpers/embedder.ts";
import { materialsSetup, postMessage, text } from "./helpers.ts";

type Setup = ReturnType<typeof materialsSetup>;

let commandNo = 0;

type CommandInput =
  | Pick<RememberCommandPayload, "command" | "content" | "source">
  | { command: MemoryDeleteMode; materialIds: string[]; from?: DeleteCommandPayload["from"] };

/** 追加一条记忆命令（默认是对话里的快速动作） */
function command(t: Setup, input: CommandInput) {
  const chat = { kind: "chat" as const, conversation: CHANNELS.secretary, actionId: `qa-${++commandNo}`, cardId: `c-${commandNo}` };
  const full = { commandId: `cmd-${commandNo}`, from: chat, ...input } as MemoryCommandEventPayload;
  return t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload: full }).event;
}

function originalFiles(t: Setup): string[] {
  const root = path.join(t.materialsDir, "originals");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json")).toSorted();
}

describe("忘掉", () => {
  test("素材连同原文副本从素材库删除，关键词和向量都不再命中；事件日志里的原话还在；删掉 materials.db 重建后也不回来", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("下个月要搬家了，房东要卖房")]);
    postMessage(t.store, [text("周末去爬山")]);
    const [moving, hiking] = t.materials.list();
    t.clock.advance(BACKFILL_DELAY_MS);
    await vectorsSettled(t.materials);
    expect(originalFiles(t)).toEqual([moving!.id, hiking!.id].toSorted());

    command(t, { command: "forget", materialIds: [moving!.id] });

    expect(t.materials.get(moving!.id)).toBeUndefined();
    expect(t.materials.searchKeyword("房东要卖房")).toEqual([]);
    expect((await t.materials.searchSemantic("换个地方住", { limit: 5 })).map((h) => h.material.id)).not.toContain(moving!.id);
    expect(originalFiles(t)).not.toContain(moving!.id);
    // 聊天记录（事件日志）里原话还在
    expect(JSON.stringify(t.store.read(CHANNELS.secretary))).toContain("房东要卖房");

    const remaining = t.materials.list().map((m) => m.id);
    expect(remaining).toContain(hiking!.id);
    expect(remaining).not.toContain(moving!.id);

    await t.reopen({ deleteMaterialsDb: true });
    expect(t.materials.get(moving!.id)).toBeUndefined();
    expect(t.materials.searchKeyword("房东要卖房")).toEqual([]);
    expect(t.materials.list().map((m) => m.id)).toEqual(remaining);
    expect(originalFiles(t)).not.toContain(moving!.id);
  });

  test("只在原文副本里的素材（会话事件已删）也忘得掉；原文副本没删成（中途崩溃）的，重启时不补回、顺手删掉", async () => {
    const t = materialsSetup();
    const maintainer = maintainerChannel("p-house");
    postMessage(t.store, [text("搬家公司选便宜的")], { conversation: maintainer });
    const [material] = t.materials.list();
    await t.reopen({ deleteChannel: maintainer, deleteMaterialsDb: true });
    expect(t.materials.get(material!.id)).toBeDefined();
    const file = path.join(t.materialsDir, ...material!.original!.path.split("/"));
    const saved = fs.readFileSync(file);

    command(t, { command: "forget", materialIds: [material!.id] });
    expect(t.materials.get(material!.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);

    // 模拟：记下了"忘掉"、但原文副本还没删成就崩溃了
    fs.writeFileSync(file, saved);
    await t.reopen();
    expect(t.materials.get(material!.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    await t.reopen({ deleteMaterialsDb: true });
    expect(t.materials.list()).toEqual([expect.objectContaining({ kind: "memory_command" })]);
  });
});

describe("彻底删除", () => {
  test("原始事件改写成\"已删除\"标记，素材和原文副本按忘掉一样删除；重建后不回来", async () => {
    const t = materialsSetup();
    const { message, event } = postMessage(t.store, [text("这句要彻底删掉")]);
    const [material] = t.materials.list();
    const marker: DeletedEventPayload = { deleted: true, deletedAt: "2026-10-09T10:00:00.000+08:00", messageId: message.id, messageTime: message.time };

    t.store.appendBatch([], { purge: [{ globalSeq: event.globalSeq, payload: deletedMarker(event, marker.deletedAt) }] });
    command(t, { command: "purge", materialIds: [material!.id] });

    expect(t.store.read(CHANNELS.secretary)[0]!.payload).toEqual(marker);
    expect(t.materials.get(material!.id)).toBeUndefined();
    expect(t.materials.searchKeyword("彻底删掉")).toEqual([]);
    expect(originalFiles(t)).not.toContain(material!.id);

    await t.reopen({ deleteMaterialsDb: true });
    expect(t.materials.searchKeyword("彻底删掉")).toEqual([]);
    expect(t.materials.list().map((m) => m.kind)).toEqual(["memory_command"]);
  });
});

describe("别推断", () => {
  test("素材和索引保留，素材带\"不参与推断\"标记；重建后标记还在（包括只在原文副本里的素材）", async () => {
    const t = materialsSetup();
    const maintainer = maintainerChannel("p-house");
    postMessage(t.store, [text("最近睡眠不好")]);
    postMessage(t.store, [text("搬家公司选便宜的")], { conversation: maintainer });
    const [sleep, mover] = t.materials.list();
    expect(sleep!.noInfer).toBe(false);

    command(t, { command: "no_infer", materialIds: [sleep!.id, mover!.id] });

    expect(t.materials.get(sleep!.id)).toMatchObject({ noInfer: true, segments: [{ text: "最近睡眠不好" }] });
    expect(t.materials.searchKeyword("睡眠不好").map((m) => [m.id, m.noInfer])).toEqual([[sleep!.id, true]]);
    expect(originalFiles(t)).toContain(sleep!.id);

    await t.reopen({ deleteChannel: maintainer, deleteMaterialsDb: true });
    expect(t.materials.get(sleep!.id)?.noInfer).toBe(true);
    expect(t.materials.get(mover!.id)?.noInfer).toBe(true);
  });
});

describe("显式记忆命令素材", () => {
  test("每条记忆命令都产生一条：记住的内容按从哪里来标来源（自己打的字、语音转写、引用块、引用的卡片、秘书提出用户确认的）；删除类只记删了几条，不含被删的原话", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("房东要卖房")]);
    const [target] = t.materials.list();
    command(t, { command: "remember", content: "下周三上午体检", source: "typed" });
    command(t, { command: "remember", content: "周五交房租", source: "voice" });
    command(t, { command: "remember", content: "对青霉素过敏", source: "proposed" });
    command(t, { command: "remember", content: "医生说少吃辣", source: "quote" });
    command(t, { command: "remember", content: "每周三晚上去游泳", source: "card" });
    command(t, { command: "forget", materialIds: [target!.id] });
    command(t, { command: "no_infer", materialIds: [], from: { kind: "settings", scope: { kind: "conversation", conversation: CHANNELS.secretary } } });

    const commands = t.materials.list({ kind: "memory_command" });
    expect(commands).toMatchObject([
      { mode: "say", source: "self", conversation: CHANNELS.secretary, context: ["command:remember", "secretary"], segments: [{ form: "typed", source: "self", notes: [], text: "下周三上午体检" }] },
      // 语音里说的（31 号票）：本人，注明转写
      { source: "self", segments: [{ form: "voice", source: "self", notes: ["transcribed"], text: "周五交房租" }] },
      { context: ["command:remember", "secretary"], segments: [{ form: "choice", source: "self", notes: ["agent_proposed"], text: "对青霉素过敏" }] },
      // 只在引用块里的：外部、不可信，只留引用和哈希
      { source: "self", segments: [{ form: "quote", source: "external_untrusted" }] },
      // 只在用户引用的卡片（agent 的提议）里的：用户的选择，注明 agent 先提出
      { segments: [{ form: "choice", source: "self", notes: ["agent_proposed"], text: "每周三晚上去游泳" }] },
      { context: ["command:forget", "secretary"], segments: [{ form: "choice", text: "忘掉 1 条素材" }] },
      { conversation: null, context: ["command:no_infer", "settings"], segments: [{ form: "text", text: "别推断：会话 secretary 里的 0 条素材" }] },
    ]);
    expect(commands.every((m) => m.original !== null)).toBe(true);
    expect(t.materials.searchKeyword("体检").map((m) => m.kind)).toEqual(["memory_command"]);
    expect(t.materials.searchKeyword("房东要卖房")).toEqual([]);
  });
});
