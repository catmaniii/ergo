// 主切面：每条消息的记忆简报（266 号票，CONTEXT.md"记忆简报"）。走真实的装配路径（组合根、插件清单、秘书的 faux 剧本），
// 推理库里先放好 196 号票测试的那个人（周末、工作日都推掉别人排好的事、说过不喜欢被排满、不吃香菜），按规则版整理一遍：
// - 相关时带：秘书这一轮的输入后面跟一块【记忆简报】（结论连原话），在用户这句话之后、不在系统提示里；秘书这一轮的回话带着结构化的部分
//   （网页的"回忆了 N 条记忆"：命中是简报引的证据背后的素材，为什么带写着），用量页的"记忆简报"记一笔；
// - 不相关、短应答不带；同一段对话里带过、没变的不再带；设置里关掉不带（默认开着），再打开又带。
// 秘书的剧本用 echo_context：回显的上下文里看得到这一轮跟在输入后面的块。
// 假向量只有几个概念组，余弦没有意义（随便一句话都可能过向量门槛），这里让向量模型"不在"，相关门槛只按话题词认。
import { CHANNELS, EVENT_TYPES, type MemoryBriefPart, type MessageEventPayload, type MessagePart } from "@ergo/protocol";
import type { EvidenceDraft } from "@ergo/memory";
import { describe, expect, it } from "vitest";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { memoryApi, usageApi } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const echo: FauxStep = { kind: "echo_context" };
const ok: FauxStep = { kind: "reply", text: "好" };
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const HOUR = 60 * 60 * 1000;

const SAID = "我不喜欢周末被排得满满的";
const TALK = "这周六同事又约我去团建，周末被排得满满的好烦";
const WORKDAY_TALK = "工作日的会太多了，又被提前排满";

const say = (id: string, text: string, when: string, context: string[] = [], sourceRef = `mat-${id}`): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context,
  eventTime: when,
  observedAt: when,
  sourceRef,
});

/** 往守护进程的 rg.db 里放那个人的话（"不喜欢周末被排满"出处是真素材），按规则版整理一遍 */
async function seed(file: string, clock: ManualClock, saidMaterial: string): Promise<void> {
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
  if (!opened.ok) throw new Error("守护进程起来时应该建好了 rg.db");
  try {
    const WEEKEND = ["weekend", "social"];
    const WORKDAY = ["workday", "work"];
    for (const draft of [
      say("ev-w1", "这周六的饭局我就不去了", "2026-03-07T10:00:00+08:00", WEEKEND),
      say("ev-w2", "周日的剧本杀我推掉了", "2026-03-15T10:00:00+08:00", WEEKEND),
      say("ev-w4", "周六的生日会我也没去", "2026-03-21T10:00:00+08:00", WEEKEND),
      say("ev-w3", SAID, "2026-04-04T10:00:00+08:00", ["weekend"], saidMaterial),
      say("ev-d1", "周二的分享会我推掉了", "2026-10-06T10:00:00+08:00", WORKDAY),
      say("ev-d2", "拒绝了周四的临时会议", "2026-10-08T10:00:00+08:00", WORKDAY),
      say("ev-d3", "工作日我也不喜欢被提前排满", "2026-10-09T10:00:00+08:00", ["workday"]),
      say("ev-a1", "我不吃香菜，一吃就过敏", "2026-05-01T10:00:00+08:00"),
    ])
      opened.engine.ingestEvidence(draft);
    await opened.engine.reflect();
  } finally {
    opened.engine.close();
  }
}

const messages = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
const textOf = (parts: readonly MessagePart[]) => parts.map((p) => (p.type === "text" ? p.text : "")).join("");

async function tell(frontend: TestFrontend, text: string) {
  const sent = await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
  return sent;
}

/**
 * 说一句，等秘书这一轮做完：这一轮的回话带的简报 part；回显的那几轮还交回回显里这一轮的输入（这句话最后一次出现的地方起，后面跟着
 * 这一轮的上下文块）和它前面的部分（系统提示、历史）。回显的上下文会越来越长（每轮的回显都留在历史里），只在要看输入的那一轮回显
 */
async function turn(frontend: TestFrontend, text: string): Promise<{ input: string; prompt: string; brief: MemoryBriefPart | undefined }> {
  const before = messages(frontend).length;
  await tell(frontend, text);
  const replies = messages(frontend).slice(before).filter((m) => m.speaker === "agent");
  expect(replies.length).toBeGreaterThan(0);
  const echoed = textOf(replies.at(-1)!.parts);
  const brief = replies.flatMap((m) => m.parts).find((p): p is MemoryBriefPart => p.type === "memory_brief");
  const tail = echoed.lastIndexOf(text);
  return { input: tail < 0 ? "" : echoed.slice(tail), prompt: tail < 0 ? "" : echoed.slice(0, tail), brief };
}

describe("每条消息的记忆简报", () => {
  it("相关时带（在这句话后面、不在系统提示里；回话带着结构化的部分，用量页记一笔）；不相关、短应答不带；带过没变的不再带；设置里关掉不带、再打开又带", { timeout: 120_000 }, async () => {
    const clock = new ManualClock(at(10, 10, 9, 0));
    const td = await startTestDaemon({ clock, memoryPlugin: true, embedder: new FakeEmbedder({ available: false }), secretary: [ok, echo, ok, ok, ok, ok, echo] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    // 推理库还是空的：什么都不带
    const said = await tell(frontend, SAID);
    const material = td.daemon.materials.list().find((m) => m.ref.messageId === said.messageId);
    expect(material).toBeDefined();
    await seed(td.daemon.layout.rgDb, clock, material!.id);

    // 相关：带一块【记忆简报】，结论连原话，跟在这句话后面（追加在这一轮的尾部），系统提示里没有
    clock.advance(HOUR);
    const first = await turn(frontend, TALK);
    expect(first.input).toContain("【记忆简报】");
    expect(first.input).toContain("【对用户的理解】");
    expect(first.input).toContain(`「${SAID}」`);
    expect(first.input).toContain("用户不喜欢香菜");
    expect(first.prompt).not.toContain("【记忆简报】和用户这句话相关的记忆");
    // 回话带着结构化的部分：命中是简报引的证据背后的素材（真素材那一条）、为什么带
    expect(first.brief).toBeDefined();
    expect(first.brief!.recall).toEqual({ source: "brief", hits: [expect.objectContaining({ materialId: material!.id, kind: "user_utterance", conversation: SECRETARY })] });
    expect(first.brief!.items.some((i) => i.reason === "direct" && i.routes.length > 0)).toBe(true);
    expect(first.brief!.items.some((i) => i.reason === "hard")).toBe(true);
    expect(first.brief!.tokens).toBeGreaterThan(0);

    // 同一段对话里再说一遍：带过的没变，不再带
    clock.advance(HOUR);
    expect((await turn(frontend, TALK)).brief).toBeUndefined();

    // 不相关、短应答：不带
    clock.advance(HOUR);
    expect((await turn(frontend, "明天上海会下雨吗")).brief).toBeUndefined();
    expect((await turn(frontend, "好的谢谢")).brief).toBeUndefined();

    // 设置里关掉（默认开着）：工作日的事也相关、还没带过，照样不带
    expect((await memoryApi.settings(td.url)).body).toEqual({ wovenQuestions: true, memoryBrief: true, interviewInvites: true });
    expect((await memoryApi.saveSettings(td.url, { memoryBrief: false })).body).toEqual({ wovenQuestions: true, memoryBrief: false, interviewInvites: true });
    clock.advance(HOUR);
    expect((await turn(frontend, WORKDAY_TALK)).brief).toBeUndefined();
    // 再打开：带上工作日那几条（周末那几条带过、没变，末尾只列编号；禁忌带过了不再带）
    expect((await memoryApi.saveSettings(td.url, { memoryBrief: true })).body).toEqual({ wovenQuestions: true, memoryBrief: true, interviewInvites: true });
    clock.advance(HOUR);
    const workday = await turn(frontend, WORKDAY_TALK);
    expect(workday.brief).toBeDefined();
    expect(workday.input).toContain("【记忆简报】");
    expect(workday.input).toContain("「工作日我也不喜欢被提前排满」");
    expect(workday.input).toContain("前面带过、没变的不再重复");
    expect(workday.input).not.toContain("用户不喜欢香菜");

    // 用量页：记忆简报单列一项（带了两次）
    const day = clockIso(clock).slice(0, 10);
    const usage = await usageApi.summary(td.url, { from: "2026-10-01", to: day });
    expect(usage.status).toBe(200);
    expect(usage.body.memoryBrief).toMatchObject({ count: 2 });
    expect(usage.body.memoryBrief.tokens).toBe(first.brief!.tokens + workday.brief!.tokens);
  });
});
