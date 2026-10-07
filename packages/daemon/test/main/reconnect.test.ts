// 主切面：重连补发、刷新后历史还在、两个窗口看到的一样、前端的序号比服务端还大时重新同步。
import fs from "node:fs";
import { CHANNELS, EVENT_TYPES, type EventFrame, type MessageEventPayload, type StreamEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const { message: MESSAGE, stream: STREAM, turnEnd: TURN_END } = EVENT_TYPES;

describe("重连与多个前端", () => {
  it("带着每个频道最后收到的序号重连：服务端按序补发缺失的落盘事件，不重不漏，之后照常推送", async () => {
    const { url } = await startTestDaemon({
      secretary: [
        { kind: "reply", text: "第一轮的回复" },
        { kind: "reply", text: "断线期间的回复" },
        { kind: "reply", text: "重连之后的回复" },
      ],
    });
    const a = await TestFrontend.connect(url);
    await a.subscribe({ [SECRETARY]: 0 });
    await a.sendText("第一轮");
    await a.next(SECRETARY, TURN_END);
    expect(a.cursors).toEqual({ [SECRETARY]: 4 });

    await a.disconnect();
    // 断线期间，另一个窗口聊了一轮
    const b = await TestFrontend.connect(url);
    await b.subscribe({ [SECRETARY]: 0 });
    await b.sendText("断线期间");
    await b.next(SECRETARY, TURN_END);
    await b.next(SECRETARY, TURN_END);

    const seenBefore = a.events().length;
    await a.reconnect([SECRETARY]);
    await a.next(SECRETARY, TURN_END);
    const replayed = a.events().slice(seenBefore);
    expect(replayed.map((f) => `${f.seq} ${f.type}`)).toEqual(["5 message", "6 turn_start", "7 message", "8 turn_end"]);
    expect(replayed.map(text)).toEqual(["user:断线期间", "", "agent:断线期间的回复", ""]);

    // 之后的新事件照常推送，序号接着
    await a.sendText("重连之后");
    await a.next(SECRETARY, TURN_END);
    expect(a.events({ persistedOnly: true }).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("回复说到一半时断线：重连后不补中间增量，定稿消息照常补上", async () => {
    const reply = "这是一段慢慢说出来的回复，".repeat(10);
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: reply }], secretaryTokensPerSecond: 40 });
    const a = await TestFrontend.connect(url);
    await a.subscribe({ [SECRETARY]: 0 });
    await a.sendText("说一段");
    await a.next(SECRETARY, STREAM);
    const before = a.events().length;
    const streamedBefore = streamKeys(a.events({ type: STREAM }));

    await a.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    await a.reconnect([SECRETARY]);
    const final = await a.next(SECRETARY, MESSAGE);
    await a.next(SECRETARY, TURN_END);

    const after = a.events().slice(before);
    // 重连后收到的增量都是之前没收到过的（不重放断线前、也不补断线期间的）
    for (const key of streamKeys(after.filter((f) => f.type === STREAM))) expect(streamedBefore.has(key)).toBe(false);
    expect(after.filter((f) => f.type === MESSAGE)).toEqual([final]);
    expect((final.payload as MessageEventPayload).message.parts).toEqual([{ type: "text", text: reply }]);
  });

  it("刷新页面（新连接从头订阅）：历史都在，和之前看到的一样", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", thinking: "想一想", text: "在的" }] });
    const a = await TestFrontend.connect(url);
    await a.subscribe({ [SECRETARY]: 0 });
    await a.sendText("在吗");
    await a.next(SECRETARY, TURN_END);
    await a.close();

    const refreshed = await TestFrontend.connect(url);
    await refreshed.subscribe({ [SECRETARY]: 0 });
    await refreshed.next(SECRETARY, TURN_END);
    expect(refreshed.events()).toEqual(a.events({ persistedOnly: true }));
  });

  it("两个窗口同时开着：落盘事件完全一样，流式增量两边都收到", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "两边都看得到的回复".repeat(4) }], secretaryTokensPerSecond: 60 });
    const a = await TestFrontend.connect(url);
    const b = await TestFrontend.connect(url, { origin: url.replace("127.0.0.1", "localhost") });
    await a.subscribe({ [SECRETARY]: 0 });
    await b.subscribe({ [SECRETARY]: 0 });

    await a.sendText("在吗");
    await a.next(SECRETARY, TURN_END);
    await b.next(SECRETARY, TURN_END);
    expect(b.events({ persistedOnly: true })).toEqual(a.events({ persistedOnly: true }));
    expect(b.events({ type: STREAM }).length).toBeGreaterThan(0);
  });
});

describe("前端的序号比服务端还大（数据目录恢复成了旧快照）", () => {
  it("服务端回\"重新同步\"，从头补发这个频道；之后照常推送", async () => {
    const backup = makeTempDir("ergou-db-backup-");
    const first = await startTestDaemon({
      secretary: [
        { kind: "reply", text: "第一轮的回复" },
        { kind: "reply", text: "第二轮的回复" },
      ],
    });
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("第一轮");
    await frontend.next(SECRETARY, TURN_END);
    // 这时的库存一份"快照"（停掉守护进程再复制，库是关好的）
    await first.daemon.stop();
    const { db } = dataDirLayout(first.dataDir);
    fs.cpSync(db, backup, { recursive: true });

    const second = await startTestDaemon({ secretary: [{ kind: "reply", text: "第二轮的回复" }], reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    await frontend.reconnect([SECRETARY], second.url);
    await frontend.sendText("第二轮");
    await frontend.next(SECRETARY, TURN_END);
    expect(frontend.cursors).toEqual({ [SECRETARY]: 8 });
    await frontend.disconnect();
    await second.daemon.stop();

    // 恢复成第一轮之后的快照：服务端最后序号回到 4，前端还记着 8
    fs.rmSync(db, { recursive: true, force: true });
    fs.cpSync(backup, db, { recursive: true });
    const restored = await startTestDaemon({ secretary: [{ kind: "reply", text: "恢复之后的回复" }], reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    const seenBefore = frontend.events().length;
    const response = await frontend.reconnect([SECRETARY], restored.url);
    expect(response).toMatchObject({ ok: true, result: { resync: [SECRETARY] } });
    await frontend.next(SECRETARY, TURN_END);
    expect(frontend.events().slice(seenBefore).map((f) => `${f.seq} ${text(f) || f.type}`)).toEqual(["1 user:第一轮", "2 turn_start", "3 agent:第一轮的回复", "4 turn_end"]);
    expect(frontend.cursors).toEqual({ [SECRETARY]: 4 });
    expect(frontend.recording.filter((i) => i.kind === "resync")).toEqual([{ kind: "resync", channel: SECRETARY }]);

    // 之后的新事件照常推送，序号从 5 接着
    await frontend.sendText("恢复之后");
    await frontend.next(SECRETARY, TURN_END);
    expect(frontend.cursors).toEqual({ [SECRETARY]: 8 });
    expect(restored.daemon.store.lastSeq(SECRETARY)).toBe(8);
  });
});

function text(frame: EventFrame): string {
  if (frame.type !== MESSAGE) return "";
  const { message } = frame.payload as MessageEventPayload;
  return `${message.speaker}:${message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}`;
}

/** 每段增量的位置（第几个 part 的第几个字符起） */
function streamKeys(frames: EventFrame[]): Set<string> {
  return new Set(frames.flatMap((f) => (f.payload as StreamEventPayload).deltas.map((d) => `${d.part}@${d.offset}`)));
}
