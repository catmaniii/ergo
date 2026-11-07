// 主切面：模型出错时（421）。真的守护进程、faux 模型（剧本里写服务商出错、一直不回，不连真的模型）：
// - 服务商先回两次 503 再成：会话频道上有两条 model_retry（第 1、2 次，种类"服务商忙"），这一轮照常回完；
// - 一次调用一个字都不回：到了"太久没回应"的点（这里配成 1 秒，默认 90 秒）子进程中止这一次、交给 pi 重试，第二次照常回；
//   重试之后回出字来，账本里那次被中止的照样记、带 failed；
// - 流式一直在慢慢输出、总共超过那个点：不砍；
// - 重试用完还是出错：会话里的说明写清是服务商那边忙、可以等一会儿再问或换模型；之后再被用户停掉一次（中止），
//   ⚙ 的上下文用量还是之前那次成了的调用的（不显示成出错那次的数）。
// "太久没回应"的计时本身（90 秒、每回一段就续上）用假的钟测在 test/model-errors.test.ts；这里的点配小、走真的子进程。
import { CHANNELS, EVENT_TYPES, type MessageEventPayload, METHODS, type ModelRetryEventPayload, type TurnEndEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { fauxModel, startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY } = CHANNELS;
const say = (text: string): FauxStep => ({ kind: "reply", text });
const busy: FauxStep = { kind: "provider_error", message: "503 Service Unavailable (faux)" };
const STALL: FauxStep = { kind: "stall" };

const retries = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.modelRetry }).map((f) => f.payload as ModelRetryEventPayload);
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as TurnEndEventPayload);
const messages = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");

/** 说一句，等这一轮结束，返回这一轮的结局 */
async function turn(frontend: TestFrontend, text: string, timeoutMs = 30_000): Promise<TurnEndEventPayload> {
  const before = turnEnds(frontend).length;
  const { messageId } = await frontend.sendText(text);
  await waitUntil(() => turnEnds(frontend).length > before, { timeoutMs, describe: () => `等「${text}」这一轮结束` });
  const end = turnEnds(frontend).at(-1)!;
  expect(end.inputMessageId).toBe(messageId);
  return end;
}

describe("模型出错时自动重试，聊天里说一声", () => {
  it("服务商先回两次 503 再成：会话频道上两条\"正在重试\"（第 1、2 次，服务商忙），这一轮照常回完，没有出错的说明", async () => {
    const td = await startTestDaemon({ secretaryModel: fauxModel([busy, busy, say("好了，接上了")], { retryDelayMs: 20 }) });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const end = await turn(frontend, "问个问题");
    expect(end.outcome).toBe("completed");
    expect(retries(frontend)).toEqual([
      { inputMessageId: end.inputMessageId, attempt: 1, maxAttempts: 3, kind: "busy", delayMs: 20, error: "503 Service Unavailable (faux)" },
      { inputMessageId: end.inputMessageId, attempt: 2, maxAttempts: 3, kind: "busy", delayMs: 40, error: "503 Service Unavailable (faux)" },
    ]);
    // 先后：两次重试都在这一轮里、在回复之前
    const events = frontend.events({ channel: SECRETARY });
    const replyAt = events.findIndex((f) => f.type === EVENT_TYPES.message && textOf(f.payload as MessageEventPayload) === "好了，接上了");
    const retryAt = events.map((f, i) => (f.type === EVENT_TYPES.modelRetry ? i : -1)).filter((i) => i >= 0);
    expect(retryAt.every((i) => i < replyAt)).toBe(true);
    expect(messages(frontend).filter((m) => m.message.speaker === "system")).toEqual([]);
    // 出错的那两次照样记账、带 failed；成了的那次不带
    const work = td.daemon.ledger.entries(null).filter((e) => e.agentId === "secretary" && e.purpose === "work");
    expect(work.map((e) => e.failed === true)).toEqual([true, true, false]);
  }, 60_000);

  it("一次调用一个字都不回：到点中止、按出错重试（算进重试次数，种类\"太久没回应\"），第二次照常回", async () => {
    const td = await startTestDaemon({
      config: { agents: { modelSilenceSeconds: 1 } },
      secretaryModel: fauxModel([STALL, say("这次回来了")], { retryDelayMs: 20 }),
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const started = Date.now();
    const end = await turn(frontend, "在吗");
    expect(end.outcome).toBe("completed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(retries(frontend)).toEqual([{ inputMessageId: end.inputMessageId, attempt: 1, maxAttempts: 3, kind: "timeout", delayMs: 20, error: expect.stringMatching(/No response from the model for 1 seconds; the request timed out/) }]);
    expect(textOf(messages(frontend).at(-1)!)).toBe("这次回来了");
  }, 60_000);

  it("流式一直在慢慢输出、总共超过\"太久没回应\"的点：每回一段就续上，不砍、不重试", async () => {
    const long = "这是一段慢慢说出来的回答，每隔一小会儿吐出几个字。".repeat(5);
    const td = await startTestDaemon({
      config: { agents: { modelSilenceSeconds: 1 } },
      // 每段 12~20 个字（3~5 token）、每秒 20 token：每段之间 0.15~0.25 秒，整段说完要好几秒
      secretaryModel: fauxModel([say(long)], { tokensPerSecond: 20, retryDelayMs: 20 }),
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const started = Date.now();
    const end = await turn(frontend, "慢慢讲");
    expect(Date.now() - started).toBeGreaterThan(2000);
    expect(end.outcome).toBe("completed");
    expect(retries(frontend)).toEqual([]);
    expect(textOf(messages(frontend).at(-1)!)).toBe(long);
  }, 60_000);
});

describe("重试用完还是出错、最后一条被中止", () => {
  it("说明写清服务商那边忙、可以等一会儿再问或换模型；之后再被用户停掉一次，⚙ 的上下文用量还是之前那次成了的（不是 0）", async () => {
    const td = await startTestDaemon({
      // 默认 90 秒才算没回应：被用户停掉的那次不会先被这一道中止
      secretaryModel: fauxModel(
        // 63 万：比自动压缩点（70 万）小，这几轮都不压缩
        [{ kind: "reply", text: "第一句的回复", usage: { cacheHit: 600_000, cacheMiss: 30_000, output: 1000 } }, busy, busy, busy, busy, STALL],
        { retryDelayMs: 20, contextWindow: 1_000_000 },
      ),
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    expect((await turn(frontend, "第一句")).outcome).toBe("completed");
    const used = async () => (await agentSettingsApi.view(td.url, "secretary")).body.context.usedTokens;
    expect(await used()).toBe(631_000);

    // 第二句：一开始的那次和重试的三次都是 503（pi 最多重试 3 次）
    const failed = await turn(frontend, "第二句");
    expect(failed).toMatchObject({ outcome: "error", error: "503 Service Unavailable (faux)" });
    expect(retries(frontend).filter((r) => r.inputMessageId === failed.inputMessageId).map((r) => r.attempt)).toEqual([1, 2, 3]);
    const note = messages(frontend).findLast((m) => m.message.speaker === "system")!;
    expect(textOf(note)).toContain("这次没能回复：模型服务商那边忙，自动重试了 3 次还是没成（503 Service Unavailable (faux)）。可以等一会儿再问，或者在设置 · 模型里换一个模型");
    expect(textOf(note)).not.toContain("秘书");
    expect(await used()).toBe(631_000);

    // 第三句：发出去一直不回，用户点了停止（这一轮以中止结束，那次调用照样记账、带 failed；faux 按上下文估了用量，不是 0 也不算）
    const before = turnEnds(frontend).length;
    await frontend.sendText("第三句");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnStart }).length === 3, { timeoutMs: 15_000, describe: () => "等第三句开始处理" });
    await frontend.request(METHODS.stopReply, { conversation: SECRETARY }, "k-stop-421");
    await waitUntil(() => turnEnds(frontend).length > before, { timeoutMs: 15_000, describe: () => "等第三句被停下" });
    expect(turnEnds(frontend).at(-1)!.outcome).toBe("aborted");
    const last = td.daemon.ledger.entries(null).filter((e) => e.agentId === "secretary" && e.purpose === "work").at(-1)!;
    expect(last).toMatchObject({ failed: true });
    expect(await used()).toBe(631_000);
  }, 90_000);
});
