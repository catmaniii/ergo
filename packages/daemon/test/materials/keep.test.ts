// 素材库只保管（129 号票，模块层）：记忆插件没开时素材库不采成素材，但本人的话照样留原文副本（用户的数据承诺）、
// 记忆命令的删除照做；读（list、get、referencesMedia）算上只在原文副本里、还没进库的本人素材，设置里的删除、删项目时随项目删的找得到它们。
// 再开始采集时从停下的采集位置补采：停用期间的素材一条不少（没有原文副本的也补上），删过的不回来。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type DeleteCommandPayload, EVENT_TYPES, type MemoryCommandEventPayload, type MemoryDeleteMode } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import type { MaterialSource } from "../../src/materials/capture.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import { segmentPieces } from "../../src/materials/segments.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { materialsSetup, postMessage, text } from "./helpers.ts";

type Setup = ReturnType<typeof materialsSetup>;

const NOTE = "test_system_note" as never;
let captures = 0;
/** 系统观察到的一类事件（没有原文副本）：数一数采集函数被叫了几次 */
const systemNote: MaterialSource = {
  name: "test-system-note",
  eventType: NOTE,
  capture(event) {
    captures += 1;
    return [{ kind: "task_outcome", source: "system", segments: segmentPieces([{ form: "agent_output", label: (event.payload as { text: string }).text, locator: {} }]) }];
  },
};

let commandNo = 0;
/** 删除类的记忆命令（出处写成删除项目：它本身不产生"显式记忆命令"素材，免得列表里多一条） */
function forget(t: Setup, mode: MemoryDeleteMode, materialIds: string[]) {
  const from: DeleteCommandPayload["from"] = { kind: "project_deletion", projectId: "p-1" };
  const payload = { commandId: `cmd-keep-${++commandNo}`, command: mode, materialIds, from } as MemoryCommandEventPayload;
  return t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload }).event;
}

function originalFiles(t: Setup): string[] {
  const root = path.join(t.materialsDir, "originals");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json")).toSorted();
}

describe("只保管（记忆插件没开）", () => {
  test("不采成素材：库里没有、检索不到、没有向量；本人的话照样留原文副本，读的时候算上它（只在原文副本里）", async () => {
    const t = materialsSetup({ collect: false, sources: [systemNote] });
    postMessage(t.store, [text("下个月要搬家了")]);
    t.store.append({ channel: "test-notes", type: NOTE, payload: { text: "任务做完了" } });

    expect(t.materials.searchKeyword("搬家")).toEqual([]);
    expect(t.materials.vectorStatus()).toMatchObject({ state: "off", available: false });
    await expect(t.materials.searchSemantic("搬家")).rejects.toThrow("记忆插件没启用");
    // 原文副本有（本人的话），系统观察到的没有第二份
    const [kept, ...rest] = t.materials.list();
    expect(rest).toEqual([]);
    expect(kept).toMatchObject({ kind: "user_utterance", source: "self", original: { path: expect.stringMatching(/^originals\//) } });
    expect(originalFiles(t)).toEqual([kept!.id]);
    expect(t.materials.get(kept!.id)).toEqual(kept);
    expect(t.materials.readOriginal(kept!)!.segments[0]!.text).toBe("下个月要搬家了");
  });

  test("删除照做：库里已有的、只在原文副本里的都删掉（原文副本一起），之后重启、再开始采集都不回来", async () => {
    const t = materialsSetup({ sources: [systemNote] });
    postMessage(t.store, [text("采集时说的：房东要卖房")]);
    const [before] = t.materials.list();
    await t.reopen({ collect: false });
    postMessage(t.store, [text("停用时说的：周末去爬山")]);
    postMessage(t.store, [text("停用时说的：周三体检")]);
    const all = t.materials.list();
    expect(all.map((m) => m.segments[0]?.text)).toEqual(["采集时说的：房东要卖房", "停用时说的：周末去爬山", "停用时说的：周三体检"]);
    expect(t.materials.list({ conversation: CHANNELS.secretary, limit: 2 }).map((m) => m.id)).toEqual(all.slice(0, 2).map((m) => m.id));

    forget(t, "forget", [before!.id, all[1]!.id]);
    expect(t.materials.list().map((m) => m.id)).toEqual([all[2]!.id]);
    expect(originalFiles(t)).toEqual([all[2]!.id]);
    // 别推断：按素材 id 记，只在原文副本里的也带上标记
    forget(t, "no_infer", [all[2]!.id]);
    expect(t.materials.get(all[2]!.id)).toMatchObject({ noInfer: true });

    await t.reopen({ collect: false });
    expect(t.materials.list().map((m) => m.id)).toEqual([all[2]!.id]);
    await t.reopen({ collect: true });
    expect(t.materials.list().map((m) => [m.id, m.noInfer])).toEqual([[all[2]!.id, true]]);
    expect(t.materials.searchKeyword("爬山")).toEqual([]);
    expect(t.materials.searchKeyword("体检").map((m) => m.id)).toEqual([all[2]!.id]);
  });

  test("再开始采集：从停下的采集位置补采，停用期间的素材一条不少（没有原文副本的也补上）；只保管期间重启不重复处理", async () => {
    captures = 0;
    const t = materialsSetup({ sources: [systemNote] });
    postMessage(t.store, [text("开着时说的")]);
    await t.reopen({ collect: false });
    postMessage(t.store, [text("停着时说的")]);
    t.store.append({ channel: "test-notes", type: NOTE, payload: { text: "停着时做完的任务" } });
    expect(captures).toBe(1);
    // 只保管期间重启：只保管处理到的位置记着，已经处理过的不再交给采集函数
    await t.reopen({ collect: false });
    expect(captures).toBe(1);

    await t.reopen({ collect: true });
    expect(t.materials.list().map((m) => m.segments[0]?.text ?? m.segments[0]?.label)).toEqual(["开着时说的", "停着时说的", "停着时做完的任务"]);
    expect(t.materials.searchKeyword("停着时说的")).toHaveLength(1);
    expect(t.materials.vectorStatus().state).not.toBe("off");
    // 原文副本还是停用时留下的那一份（没有重写）
    expect(originalFiles(t)).toHaveLength(2);
  });

  test("运行中停止采集（插件运行中停用时撤 collect）：之后只留原文副本、删除照做，向量停掉；采集着时不能再开始一次", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("还在采集")]);
    expect(t.materials.searchKeyword("还在采集")).toHaveLength(1);
    expect(t.materials.vectorStatus().state).not.toBe("off");
    expect(() => t.materials.collect({} as never)).toThrow("已经在采集");

    await t.uncollect!();
    expect(t.materials.vectorStatus().state).toBe("off");
    postMessage(t.store, [text("不采集了")]);
    expect(t.materials.searchKeyword("不采集了")).toEqual([]);
    const [kept, waiting] = t.materials.list();
    expect([kept, waiting].map((m) => m?.segments[0]?.text)).toEqual(["还在采集", "不采集了"]);
    forget(t, "purge", [waiting!.id]);
    expect(t.materials.list().map((m) => m.id)).toEqual([kept!.id]);
    expect(originalFiles(t)).toEqual([kept!.id]);
  });

  test("运行中再开始采集（211 号票：记忆插件运行中启用）：马上从停下的采集位置补采，停用期间的素材一条不少，删过的不回来；向量、回避信号计时接着开", async () => {
    captures = 0;
    const t = materialsSetup({ sources: [systemNote] });
    postMessage(t.store, [text("开着时说的")]);
    await t.uncollect!();
    postMessage(t.store, [text("停着时说的")]);
    postMessage(t.store, [text("停着时说的、后来忘掉了")]);
    t.store.append({ channel: "test-notes", type: NOTE, payload: { text: "停着时做完的任务" } });
    const doomed = t.materials.list().at(-1)!;
    forget(t, "forget", [doomed.id]);
    expect(t.materials.searchKeyword("停着时说的")).toEqual([]);

    const again = t.materials.collect({ embedder: new FakeEmbedder(), scheduler: t.scheduler, clock: t.clock, inbox: t.inbox, staleCardDays: 7 });
    expect(t.materials.list().map((m) => m.segments[0]?.text ?? m.segments[0]?.label)).toEqual(["开着时说的", "停着时说的", "停着时做完的任务"]);
    expect(t.materials.searchKeyword("停着时说的")).toHaveLength(1);
    expect(t.materials.collecting()).toBe(true);
    expect(t.materials.vectorStatus().state).not.toBe("off");
    // 之后的照常采
    postMessage(t.store, [text("又开了以后说的")]);
    expect(t.materials.searchKeyword("又开了以后说的")).toHaveLength(1);
    // 原文副本还是那几份（停着时留下的没有重写，忘掉的已经删了）
    expect(originalFiles(t)).toHaveLength(3);
    await again();
    expect(t.materials.collecting()).toBe(false);
  });
});
