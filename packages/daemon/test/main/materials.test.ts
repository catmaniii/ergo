// 主切面：素材入库（规格第 15 节）。真的守护进程，测试扮演前端。
// 用户在秘书页说的话进素材库（memory.db，单独的库），原文副本落在素材区；按关键词和按语义都检索得到。
// 前端关掉一张卡、建议卡 7 天没处理（时钟可注入）各产生一条回避信号。重启不重复，删掉 memory.db 重建后一样。
// 向量函数默认是假的（不下载、不跑真模型）；"模型不在"那条用正式的 bge-m3，临时数据目录的模型区是空的。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type CardStaleEventPayload, EVENT_TYPES, type InboxItemEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { Daemon } from "../../src/daemon.ts";
import { openReadonlyDatabase } from "../../src/storage/sqlite.ts";
import { suggestTaskFixture } from "../helpers/card-fixtures.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX } = CHANNELS;
const DAY = 24 * 60 * 60 * 1000;

/** 用户说一句话，等秘书这一轮结束（秘书没有剧本，回一条出错的系统说明，那不是用户的话） */
async function say(frontend: TestFrontend, text: string) {
  const sent = await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
  return sent;
}

const userTexts = (daemon: Daemon) => daemon.materials.list({ kind: "user_utterance" }).map((m) => m.segments.map((s) => s.text).join(""));

describe("用户发言入库", () => {
  it("前端发一条消息后，memory.db 里出现对应的素材，原文副本落在素材区；按关键词、按语义都检索得到", async () => {
    const { url, daemon, dataDir } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const sent = await say(frontend, "下个月要搬家了，房东要卖房");

    const [material, ...rest] = daemon.materials.list();
    expect(rest).toEqual([]);
    expect(material).toMatchObject({
      kind: "user_utterance",
      mode: "say",
      source: "self",
      conversation: SECRETARY,
      ref: { messageId: sent.messageId, event: { channel: SECRETARY, seq: sent.seq, type: EVENT_TYPES.message } },
      segments: [{ form: "typed", source: "self", text: "下个月要搬家了，房东要卖房" }],
    });
    const original = material!.originals[0]!;
    expect(fs.readFileSync(path.join(dataDir, "materials", ...original.path.split("/")), "utf8")).toBe("下个月要搬家了，房东要卖房");

    // memory.db 是数据库区里单独的库（WAL），素材就在里面
    const memoryDb = path.join(dataDir, "db", "memory.db");
    const db = openReadonlyDatabase(memoryDb);
    try {
      expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
      expect(db.all<{ id: string }>("SELECT id FROM materials").map((r) => r.id)).toEqual([material!.id]);
    } finally {
      db.close();
    }

    expect(daemon.materials.searchKeyword("搬家").map((m) => m.id)).toEqual([material!.id]);
    expect(daemon.materials.searchKeyword("房东要卖房").map((m) => m.id)).toEqual([material!.id]);
    await daemon.materials.vectorsSettled();
    expect((await daemon.materials.searchSemantic("想换个地方住", { limit: 1 })).map((h) => h.material.id)).toEqual([material!.id]);
  });

  it("重启守护进程不重复产生素材；删掉 memory.db 再启动，从事件日志重建出相同的素材", async () => {
    const first = await startTestDaemon();
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await say(frontend, "周末想去爬山");
    await say(frontend, "> 天气预报说周末有雨\n那就改到下周");
    const before = first.daemon.materials.list();
    expect(before).toHaveLength(2);
    await frontend.disconnect();
    await first.daemon.stop();

    const reuse = { dataDir: first.dataDir, homeDir: first.homeDir };
    const second = await startTestDaemon({ reuse });
    expect(second.daemon.materials.list()).toEqual(before);
    await second.daemon.stop();

    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(first.dataDir, "db", `memory.db${suffix}`), { force: true });
    const rebuilt = await startTestDaemon({ reuse });
    expect(rebuilt.daemon.materials.list()).toEqual(before);
    expect(userTexts(rebuilt.daemon)).toEqual(["周末想去爬山", "那就改到下周"]);
  });
});

describe("回避信号", () => {
  it("前端关掉一张建议卡：一条回避信号素材，关掉时写的说明是本人的话", async () => {
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CARDS]: 0 });
    const card = daemon.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "你提过三次重复照片太多" } });
    await frontend.cardAction({ cardId: card.id, action: "dismiss", expectedVersion: 1, note: "以后再说" });
    await frontend.next(CARDS, EVENT_TYPES.cardDismissed);

    expect(daemon.materials.list()).toMatchObject([
      { kind: "avoidance_signal", mode: "do", source: "self", context: ["dismissed", "card:suggest_task", "action:dismiss"], ref: { cardId: card.id }, segments: [{ text: "以后再说" }] },
    ]);
  });

  it("建议卡 7 天没处理：前端收到 card_stale 事件，产生一条回避信号素材；7 天内处理了的不产生", async () => {
    const clock = new ManualClock(new Date(2026, 9, 8, 9, 0));
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture], clock });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CARDS]: 0 });
    const ignored = daemon.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "重复照片太多" } });
    const handled = daemon.cards.create({ type: "suggest_task", payload: { title: "学游泳", why: "你说过想学" } });
    clock.advance(2 * DAY);
    await frontend.cardAction({ cardId: handled.id, action: "start_task", expectedVersion: 1 });

    clock.advance(5 * DAY);
    const stale = (await frontend.next(CARDS, EVENT_TYPES.cardStale)).payload as CardStaleEventPayload;
    expect(stale).toEqual({ cardId: ignored.id, cardType: "suggest_task", pendingSince: ignored.createdAt, time: expect.any(String) });
    clock.advance(30 * DAY);
    expect(frontend.events({ channel: CARDS, type: EVENT_TYPES.cardStale })).toHaveLength(1);
    expect(daemon.materials.list()).toMatchObject([{ kind: "avoidance_signal", source: "system", context: ["stale", "card:suggest_task"], ref: { cardId: ignored.id } }]);
  });
});

describe("向量模型不在", () => {
  it("素材照常入库、关键词检索照常；待我处理里出现一条提示，写明运行哪条命令把模型下载到模型区", async () => {
    const { url, daemon, dataDir } = await startTestDaemon({ embedder: "bge-m3" });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [INBOX]: 0 });

    const item = ((await frontend.next(INBOX, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
    expect(item).toMatchObject({ kind: "notice", notice: "embedding_model_missing", urgency: "non_blocking", source: "系统" });
    expect(item.kind === "notice" && item.body).toContain(`npm run download-model -- --data-dir "${dataDir}"`);
    expect(item.kind === "notice" && item.body).toContain(path.join(dataDir, "models", "Xenova", "bge-m3"));

    await say(frontend, "下个月要搬家了");
    expect(daemon.materials.searchKeyword("搬家")).toHaveLength(1);
    expect(daemon.materials.vectorStatus()).toMatchObject({ available: false, pending: 1, indexed: 0 });
    await expect(daemon.materials.searchSemantic("搬家")).rejects.toThrow("向量模型不在");
  });
});
