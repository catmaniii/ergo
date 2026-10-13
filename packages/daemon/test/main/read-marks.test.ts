// 主切面：秘书会话的已读位置（109 号票）。用户在秘书页上滚到了那条消息、或者停在最底部，前端报 mark_read，守护进程记成
// 已读位置频道上的一条 read_mark 事件：
// - 开着的几个前端（手机、平板、电脑）都收到，一台上看过，别的设备上"秘书"页签的红点也消失；
// - 只往后挪：往回的不记，比会话的最后一条还靠后的按最后一条记；同一个幂等键重发拿到同一个结果；
// - 断线重连带着序号补发，新打开的前端从头补发；停掉再起还在；
// - 启动时还没有秘书会话的记录（新装的、刚升级上来的）记一条，位置是秘书会话那时的最后一条：升级前的历史消息当作都看过。
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type MarkReadResult, type ReadMarkEventPayload, type ResponseFrame } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { buildAgentNotice, buildMessage } from "../../src/conversation/messages.ts";
import { createReadMarks } from "../../src/conversation/read-marks.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, readMarks: READ_MARKS } = CHANNELS;
const { turnEnd: TURN_END } = EVENT_TYPES;

const marksOf = (frontend: TestFrontend) => frontend.events({ channel: READ_MARKS, type: EVENT_TYPES.readMark }).map((f) => f.payload as ReadMarkEventPayload);
/** 已读位置的序号，按先后 */
const seqsOf = (frontend: TestFrontend) => marksOf(frontend).map((m) => `${m.conversation}@${m.seq}`);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result as MarkReadResult;
};

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [SECRETARY]: 0, [READ_MARKS]: 0 });
  return frontend;
}

/** 被拒的错误码（没被拒写明） */
const refusal = async (r: Promise<ResponseFrame>) => {
  const res = await r;
  return res.ok ? "（没被拒）" : res.error.code;
};
/** 升级上来那次启动的钟 */
const UPGRADE_TIME = "2026-10-13T08:05:00.000+08:00";
const upgradeNow = () => UPGRADE_TIME;

/** 秘书说完一轮（第 n 个回合结束） */
const turns = (frontend: TestFrontend, n: number) => waitUntil(() => frontend.events({ channel: SECRETARY, type: TURN_END }).length >= n, { describe: () => `等秘书说完 ${n} 轮` });

describe("记已读位置、多设备同步", () => {
  it("一台上看到了哪一条：两个前端都收到已读位置；只往后挪，往回的不记；靠后的按最后一条记；同一个幂等键重发拿到同一个结果", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的" }, { kind: "reply", text: "收到" }] });
    const phone = await connect(url);
    const laptop = await connect(url);
    // 启动时记的那一条：新装的秘书会话是空的，位置是 0
    for (const f of [phone, laptop]) await waitUntil(() => marksOf(f).length >= 1);
    expect(seqsOf(phone)).toEqual(["secretary@0"]);

    await phone.sendText("你好");
    await turns(phone, 1);
    expect(phone.cursors[SECRETARY]).toBe(4);
    expect(ok(await phone.markRead({ conversation: SECRETARY, seq: 4 }, "k-read-1"))).toEqual({ conversation: SECRETARY, seq: 4 });
    for (const f of [phone, laptop]) await waitUntil(() => marksOf(f).length >= 2, { describe: () => JSON.stringify(seqsOf(f)) });
    expect(seqsOf(laptop)).toEqual(["secretary@0", "secretary@4"]);
    expect(marksOf(laptop)[1]!.time).toEqual(expect.any(String));

    // 同一个幂等键重发：同一个结果，不多记
    expect(ok(await phone.markRead({ conversation: SECRETARY, seq: 4 }, "k-read-1"))).toEqual({ conversation: SECRETARY, seq: 4 });
    // 另一台设备晚到的、靠前的：不往回挪，回的是记着的位置
    expect(ok(await laptop.markRead({ conversation: SECRETARY, seq: 2 }, "k-read-2"))).toEqual({ conversation: SECRETARY, seq: 4 });
    expect(ok(await laptop.markRead({ conversation: SECRETARY, seq: 4 }, "k-read-3"))).toEqual({ conversation: SECRETARY, seq: 4 });

    // 比会话的最后一条还靠后：按最后一条记
    await laptop.sendText("再说一句");
    await turns(laptop, 2);
    expect(ok(await laptop.markRead({ conversation: SECRETARY, seq: 99 }, "k-read-4"))).toEqual({ conversation: SECRETARY, seq: 8 });
    for (const f of [phone, laptop]) await waitUntil(() => marksOf(f).length >= 3, { describe: () => JSON.stringify(seqsOf(f)) });
    // 拿"推完了"当标记：前面被拒的、往回的、重发的都没留下事件
    expect(seqsOf(phone)).toEqual(["secretary@0", "secretary@4", "secretary@8"]);
    expect(seqsOf(laptop)).toEqual(["secretary@0", "secretary@4", "secretary@8"]);
  });

  it("参数不对的被拒：负的序号、不是会话的频道、没带幂等键", async () => {
    const { url } = await startTestDaemon();
    const frontend = await connect(url);
    expect(await refusal(frontend.markRead({ conversation: SECRETARY, seq: -1 }))).toBe("bad_params");
    expect(await refusal(frontend.markRead({ conversation: CHANNELS.board as never, seq: 1 }))).toBe("bad_params");
    expect(await refusal(frontend.request("mark_read", { conversation: SECRETARY, seq: 0 }))).toBe("idempotency_key_required");
  });

  it("断线期间另一台看过了：重连带着序号补发那条已读位置；新打开的前端从头补发，最后一条是现在的位置", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的" }] });
    const phone = await connect(url);
    const laptop = await connect(url);
    await phone.sendText("你好");
    await turns(phone, 1);
    await waitUntil(() => marksOf(phone).length >= 1);

    await phone.disconnect();
    ok(await laptop.markRead({ conversation: SECRETARY, seq: 4 }));
    const before = phone.events().length;
    await phone.reconnect([SECRETARY, READ_MARKS]);
    await waitUntil(() => marksOf(phone).length >= 2, { describe: () => JSON.stringify(seqsOf(phone)) });
    // 只补了断线期间的那一条（秘书会话没有新事件）
    expect(phone.events().slice(before).map((f) => `${f.channel} ${f.type}`)).toEqual(["read_marks read_mark"]);
    expect(seqsOf(phone)).toEqual(["secretary@0", "secretary@4"]);

    const tablet = await connect(url);
    await waitUntil(() => marksOf(tablet).length >= 2);
    expect(marksOf(tablet).at(-1)).toMatchObject({ conversation: SECRETARY, seq: 4 });
  });

  it("停掉再起：已读位置还在，不再补记启动时的那一条", async () => {
    const first = await startTestDaemon({ secretary: [{ kind: "reply", text: "好的" }] });
    const frontend = await connect(first.url);
    await frontend.sendText("你好");
    await turns(frontend, 1);
    ok(await frontend.markRead({ conversation: SECRETARY, seq: 3 }));
    await first.daemon.stop();

    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    const again = await connect(second.url);
    await waitUntil(() => marksOf(again).length >= 2);
    // 再记一次当"推完了"的标记：前面没有多出启动时补的那条
    ok(await again.markRead({ conversation: SECRETARY, seq: 4 }));
    await waitUntil(() => marksOf(again).length >= 3);
    expect(seqsOf(again)).toEqual(["secretary@0", "secretary@3", "secretary@4"]);
  });
});

describe("升级上来第一次启动", () => {
  it("秘书会话里已经有消息、还没有已读位置：记一条，位置是秘书会话的最后一条（历史消息当作都看过）；再启动不重复记", () => {
    const store = openEventStore({ file: path.join(makeTempDir("ergou-read-marks-"), "events.db"), views: conversationViews });
    try {
      store.append(buildMessage({ conversation: SECRETARY, speaker: "user", parts: [{ type: "text", text: "早" }] }).event);
      store.append(buildMessage({ conversation: SECRETARY, speaker: "agent", parts: [{ type: "text", text: "早，今天的 AI 日报念好了" }] }).event);
      store.append(buildAgentNotice(SECRETARY, "【任务做完】t-5 做完了", "k-done").event);
      createReadMarks({ store, now: upgradeNow }).start();
      createReadMarks({ store, now: upgradeNow }).start();
      const marks = store.read(READ_MARKS).map((e) => ({ type: e.type, payload: e.payload }));
      expect(marks).toEqual([{ type: EVENT_TYPES.readMark, payload: { conversation: SECRETARY, seq: 3, time: UPGRADE_TIME } }]);
      // 记着的位置照样能往后挪
      store.append(buildMessage({ conversation: SECRETARY, speaker: "agent", parts: [{ type: "text", text: "要我念给你听吗？" }] }).event);
      expect(createReadMarks({ store, now: upgradeNow }).markRead({ conversation: SECRETARY, seq: 4 }, "k-1")).toEqual({ conversation: SECRETARY, seq: 4 });
    } finally {
      store.close();
    }
  });
});
