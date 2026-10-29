// 了解你访谈的记录和发起（284 号票，memory/interview.ts）：从记录算出现在的样子（开着的那次、放下了的、聊过哪几个主题），
// 每周约、五个主题都聊过以后改每月约"最近有什么变化"、约访关着不约、开着访谈不约、已经开着就进同一次。
// 事件日志、卡片、待我处理换成内存里的假的（只看访谈这一层；真的装配在主切面 test/main/memory-interview.test.ts）。
import {
  INTERVIEW_QUESTION_MAX,
  INTERVIEW_TOPICS,
  interviewCadence,
  type InterviewFilesCardPayload,
  type InterviewTopic,
  MEMORY_CURATOR_CONVERSATION,
  type MemorySettingsView,
  nextInterviewTopic,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { buildMessage } from "../../src/conversation/messages.ts";
import type { NewEvent } from "../../src/events/event-store.ts";
import { createMemoryInterviews, INTERVIEW_EVENT, INTERVIEW_EXPIRE_MS, type InterviewRecord, interviewSnapshot, type PersonalFileParams } from "../../src/memory/interview.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { ManualClock } from "../helpers/clock.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-10T10:00:00+08:00");
const iso = (ms: number) => new Date(ms).toISOString();

/** 内存里的假内核：事件按频道记下来，卡片、待我处理只数个数 */
function fakeKernel(settings: MemorySettingsView = { wovenQuestions: true, memoryBrief: true, interviewInvites: true }) {
  const events: NewEvent[] = [];
  let current = { ...settings };
  let cardSeq = 0;
  const store = {
    read: (channel: string, _after = 0, type?: string) =>
      events.filter((e) => e.channel === channel && (type === undefined || e.type === type)).map((e, i) => ({ ...e, seq: i + 1, globalSeq: i + 1, time: iso(T0) })),
    append: (event: NewEvent) => {
      events.push(event);
      return { event } as never;
    },
    appendBatch: (batch: NewEvent[]) => {
      events.push(...batch);
      return [] as never;
    },
    reader: { all: () => [] },
    lastSeq: (channel: string) => events.filter((e) => e.channel === channel).length,
    readBefore(channel: string, before: number, limit: number, type?: string) {
      return this.read(channel, 0, type)
        .filter((e) => e.seq < before)
        .slice(-limit);
    },
  };
  const cards = {
    buildCreate: (input: { type: string; payload: unknown }) => {
      cardSeq += 1;
      const card = { id: `c-${cardSeq}`, type: input.type, payload: input.payload };
      return { card, event: { channel: "cards", type: "card", payload: { card } } };
    },
    buildUpdate: (cardId: string) => ({ card: { id: cardId }, event: { channel: "cards", type: "card", payload: {} } }),
  };
  const inbox = { buildAdd: (item: unknown) => ({ item, event: { channel: "inbox", type: "inbox_item", payload: { item } } }) };
  const settingsService = {
    current: () => ({ ...current }),
    change: (body: Partial<MemorySettingsView>) => (current = { ...current, ...body }),
  };
  return { events, store, cards, inbox, settingsService, records: () => events.filter((e) => e.type === INTERVIEW_EVENT).map((e) => e.payload as InterviewRecord) };
}

/**
 * 假的 personal_file 执行器（只做访谈这一层要的：拆好的一项规范化成卡片要的样子，号码认出来，"坏"字段报错）；
 * 真的执行器、真的写进档案在主切面里
 */
const fakePersonalFile = {
  type: "personal_file",
  normalizeChecked(raw: PersonalFileParams) {
    const field = raw.fields?.[0];
    if (field?.field === "坏") throw new Error("认不出字段「坏」");
    return {
      params: {
        person: raw.person,
        isNew: raw.person !== "我",
        ...(raw.relation === undefined ? {} : { relation: raw.relation }),
        fields: field === undefined ? [] : [{ field: field.field, label: field.field, value: field.value, number: /^\d+$/.test(field.value) }],
        ...(raw.note === undefined ? {} : { note: { text: raw.note, date: "2026-10-10" } }),
      },
      title: `记进档案：${raw.person} · ${field?.field ?? "记下的事"}`,
    };
  },
};

function setup(kernel = fakeKernel(), at = T0, withFiles = false) {
  const clock = new ManualClock(new Date(at));
  const quickActions = { registry: { get: (type: string) => (type === "personal_file" ? fakePersonalFile : undefined) }, execute: () => ({ events: [], summary: "" }) };
  const interviews = createMemoryInterviews({
    store: kernel.store as never,
    cards: kernel.cards as never,
    inbox: kernel.inbox as never,
    clock,
    materials: { list: () => [] },
    settings: () => kernel.settingsService as never,
    ...(withFiles ? { quickActions: quickActions as never } : {}),
    log: () => {},
  });
  return { kernel, clock, interviews };
}

/** 管理员在它的会话里说的一段话（事件） */
const curatorSays = (text: string) => buildMessage({ conversation: MEMORY_CURATOR_CONVERSATION, speaker: "agent", parts: [{ type: "text", text }] }).event;

describe("五个主题的先后和约访的频率", () => {
  it("下次聊第一个还没聊过的；五个都聊过了是「最近有什么变化」、改成每月一次", () => {
    expect(nextInterviewTopic([])).toBe("family");
    expect(nextInterviewTopic(["family", "work_day"])).toBe("choices");
    expect(interviewCadence(["family"])).toBe("weekly");
    expect(nextInterviewTopic([...INTERVIEW_TOPICS])).toBe("changes");
    expect(interviewCadence([...INTERVIEW_TOPICS])).toBe("monthly");
  });
});

/** 一条"开始了"的记录 */
const started = (id: string, topic: InterviewTopic, at: number): InterviewRecord => ({ change: "started", at: iso(at), interviewId: id, topic, by: "card" });

describe("从记录算出现在的样子", () => {

  it("开着的那次；结束了、聊透了的主题记成聊过；中途停的不算", () => {
    const records: InterviewRecord[] = [
      started("iv-1", "family", T0),
      { change: "ended", at: iso(T0 + 600_000), interviewId: "iv-1", covered: true, answers: 5 },
      started("iv-2", "work_day", T0 + DAY),
      { change: "ended", at: iso(T0 + DAY + 600_000), interviewId: "iv-2", covered: false, answers: 2 },
      started("iv-3", "work_day", T0 + 2 * DAY),
    ];
    const snap = interviewSnapshot(records, T0 + 2 * DAY + 60_000);
    expect(snap.active).toMatchObject({ id: "iv-3", topic: "work_day" });
    expect(snap.covered).toEqual(["family"]);
    expect(snap.lastContactAt).toBe(iso(T0 + 2 * DAY));
  });

  it("开了 3 小时还没收尾的当它放下了：不再算开着，主题也不算聊过", () => {
    const records = [started("iv-1", "family", T0)];
    expect(interviewSnapshot(records, T0 + INTERVIEW_EXPIRE_MS - 1).active?.id).toBe("iv-1");
    const later = interviewSnapshot(records, T0 + INTERVIEW_EXPIRE_MS);
    expect(later.active).toBeUndefined();
    expect(later.latest).toMatchObject({ id: "iv-1", ended: true });
    expect(later.covered).toEqual([]);
  });
});

describe("约访和开访谈", () => {
  it("每周约一次：同一周不约两次，满 6 天再约（主题还是没聊过的那个）；开着访谈时不约", () => {
    const { kernel, clock, interviews } = setup();
    const first = interviews.invite();
    expect(first).toBe("c-1");
    expect(kernel.records()).toEqual([expect.objectContaining({ change: "invited", kind: "weekly", topic: "family", cardId: "c-1" })]);
    expect(interviews.invite()).toBeUndefined();
    clock.advance(6 * DAY);
    expect(interviews.invite()).toBe("c-2");
    // 开着访谈：不约
    interviews.start({ by: "page" });
    clock.advance(7 * DAY - 60_000);
    // （3 小时以后那次当放下了，又可以约）
    expect(interviews.invite()).toBe("c-3");
  });

  it("约访关着不约；「不想做了」关掉约访", () => {
    const { kernel, interviews } = setup();
    interviews.stopInvites();
    expect(kernel.settingsService.current().interviewInvites).toBe(false);
    expect(interviews.invite()).toBeUndefined();
    expect(interviews.status().invites).toBe(false);
  });

  it("五个主题都聊过以后改成每月一次「最近有什么变化」：隔 27 天才约", () => {
    const kernel = fakeKernel();
    const { clock, interviews } = setup(kernel);
    for (const topic of INTERVIEW_TOPICS) {
      const opened = interviews.start({ by: "page" });
      expect(opened.topic).toBe(topic);
      interviews.finish(true);
      clock.advance(DAY);
    }
    expect(interviews.status()).toMatchObject({ covered: [...INTERVIEW_TOPICS], next: "changes", cadence: "monthly" });
    // 最后一次聊在 1 天前：每月的要隔 27 天
    clock.advance(20 * DAY);
    expect(interviews.invite()).toBeUndefined();
    clock.advance(7 * DAY);
    expect(interviews.invite()).toBeDefined();
    expect(kernel.records().at(-1)).toMatchObject({ change: "invited", kind: "monthly", topic: "changes" });
  });

  it("已经开着就进同一次，不重开；从约访卡、记忆页、秘书那里开的放开场的系统消息，管理员自己开的不放", () => {
    const { kernel, interviews } = setup();
    const first = interviews.start({ by: "curator" });
    expect(first.already).toBe(false);
    expect(first.events.map((e) => e.type)).toEqual([INTERVIEW_EVENT]);
    const again = interviews.prepareStart({ by: "secretary" });
    expect(again).toMatchObject({ interviewId: first.interviewId, already: true, events: [] });
    interviews.finish(false);
    const next = interviews.prepareStart({ by: "card", cardId: "c-9" });
    expect(next.topic).toBe("family");
    expect(next.events.map((e) => `${e.channel}:${e.type}`)).toEqual([`${INTERNAL_CHANNEL}:${INTERVIEW_EVENT}`, "maintainer:memory-curator:message"]);
    const opening = next.events[1]!.payload as { message: { id: string; parts: Array<{ text: string }> }; agentInput: boolean; interviewId: string };
    expect(opening).toMatchObject({ agentInput: true, interviewId: next.interviewId });
    // 开场的系统消息用户在会话里看得到：只有一行"这次聊：……"，不写从哪开的、访谈编号
    expect(opening.message.parts[0]!.text).toBe("【了解你访谈】这次聊：家里的人和基本情况");
    // 开始的记录记着它的消息编号（问法跟在交它的那一轮后面）
    expect(next.events[0]!.payload).toMatchObject({ change: "started", by: "card", cardId: "c-9", openingMessageId: opening.message.id });
    expect(kernel.records().map((r) => r.change)).toEqual(["started", "ended"]);
  });

  it("结束：没在聊时交回 undefined；中途停的主题下次接着聊", () => {
    const { interviews } = setup();
    expect(interviews.finish(true)).toBeUndefined();
    interviews.start({ by: "page" });
    expect(interviews.finish(false)).toMatchObject({ topic: "family", covered: false, remaining: [...INTERVIEW_TOPICS] });
    expect(interviews.status().next).toBe("family");
  });

  it("访谈里用户说话的归属：访谈编号，加上管理员这次访谈里最近的一段话（取末尾）；管理员还没开口、开场以前的不算", () => {
    const { kernel, interviews } = setup();
    expect(interviews.messageScope()).toEqual({});
    // 上一次聊天里管理员说的（开场的系统消息以前）不算这次访谈的问题
    kernel.store.append(curatorSays("上次的话：还有别的要我看的吗？"));
    const opened = interviews.start({ by: "page" });
    expect(interviews.messageScope()).toEqual({ interviewId: opened.interviewId });
    // 管理员问了：问的那句在末尾，太长的截掉开头
    kernel.store.append(curatorSays(`${"今天想聊聊家里的人，随时能跳过。".repeat(20)}先问一个：现在家里都有谁？`));
    const scope = interviews.messageScope();
    expect(scope.interviewId).toBe(opened.interviewId);
    expect(scope.interviewQuestion!.endsWith("先问一个：现在家里都有谁？")).toBe(true);
    expect(scope.interviewQuestion!.startsWith("…")).toBe(true);
    expect([...scope.interviewQuestion!]).toHaveLength(INTERVIEW_QUESTION_MAX);
    // 又问了一句短的：就是它
    kernel.store.append(curatorSays("平时谁接送孩子？"));
    expect(interviews.messageScope().interviewQuestion).toBe("平时谁接送孩子？");
    interviews.finish(false);
    expect(interviews.messageScope()).toEqual({});
  });
});

describe("访谈里的档案信息", () => {
  it("聊的时候记下（不出卡）：一人一项，同一个人的同一项以后记的为准，新建的人关系跟着；收尾时合成一张核对卡", () => {
    const { kernel, interviews } = setup(fakeKernel(), T0, true);
    // 没在聊：交给调用方照 281 号票出一人一张的卡
    expect(interviews.collectFile({ person: "妈妈", fields: [{ field: "生日", value: "3月1日" }] }, {})).toBeUndefined();
    const opened = interviews.start({ by: "page" });
    const first = interviews.collectFile(
      {
        person: "妈妈",
        relation: "母亲",
        fields: [
          { field: "生日", value: "3月1日" },
          { field: "电话", value: "13812345678" },
        ],
      },
      { inputMessageId: "m-1", toolCallId: "tc-1" },
    )!;
    expect(first.isError).toBeUndefined();
    expect(first.text).toContain("记进档案：妈妈 · 生日、记进档案：妈妈 · 电话");
    expect(first.text).toContain("现在不出卡");
    // 改口：同一项以后记的为准（位置不变），没写关系的照样是"母亲"
    interviews.collectFile({ person: "妈妈", fields: [{ field: "生日", value: "3月2日" }] }, { inputMessageId: "m-2", toolCallId: "tc-2" });
    interviews.collectFile({ person: "我", note: "周三晚上固定加班" }, { inputMessageId: "m-3", toolCallId: "tc-3" });
    // 认不出的字段：报给管理员，不记
    const bad = interviews.collectFile({ person: "女儿", fields: [{ field: "坏", value: "x" }] }, {})!;
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toContain("认不出字段「坏」");
    // 还没出卡
    expect(kernel.events.filter((e) => e.channel === "cards")).toEqual([]);

    const done = interviews.finish(true)!;
    expect(done).toMatchObject({ files: 3, filesCardId: "c-1" });
    const card = kernel.events.find((e) => e.channel === "cards")!.payload as { card: { type: string; payload: InterviewFilesCardPayload } };
    expect(card.card.type).toBe("interview_files");
    expect(card.card.payload).toMatchObject({ interviewId: opened.interviewId, topic: "family", conversation: MEMORY_CURATOR_CONVERSATION });
    expect(card.card.payload.items.map((i) => [i.person.name, i.person.relation, i.field?.value ?? i.note?.text, i.inputMessageId, i.toolCallId, i.state])).toEqual([
      ["妈妈", "母亲", "3月2日", "m-2", "tc-2", "pending"],
      ["妈妈", "母亲", "13812345678", "m-1", "tc-1", "pending"],
      ["我", undefined, "周三晚上固定加班", "m-3", "tc-3", "pending"],
    ]);
    expect(card.card.payload.items[1]!.field!.number).toBe(true);
    // 同一事务进待办；结束的记录记着卡片
    expect(kernel.events.filter((e) => e.channel === "inbox")).toHaveLength(1);
    expect(kernel.records().at(-1)).toMatchObject({ change: "ended", filesCardId: "c-1" });
  });

  it("没记下档案信息：收尾时不出卡", () => {
    const { kernel, interviews } = setup(fakeKernel(), T0, true);
    interviews.start({ by: "page" });
    expect(interviews.finish(true)).toMatchObject({ files: 0 });
    expect(interviews.finish(true)).toBeUndefined();
    expect(kernel.events.filter((e) => e.channel === "cards")).toEqual([]);
    expect(kernel.records().at(-1)).not.toHaveProperty("filesCardId");
  });
});
