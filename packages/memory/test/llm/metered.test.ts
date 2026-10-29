// 192 号票：真模型外面那一层——记实际 token 和费用、同样的请求只问一次、失败最多重试 2 次、总次数封顶。都用假模型，不联网。
import { describe, expect, it } from "vitest";
import type { ChatModel, ChatRequest } from "../../src/llm/chat.ts";
import { isDeepSeekPeak, MeteredChat } from "../../src/llm/metered.ts";

const req = (user: string, purpose: ChatRequest["purpose"] = "judge"): ChatRequest => ({ purpose, system: "s", user, maxTokens: 100 });

/** 假模型：按脚本一次次回答（Error 就抛） */
function scripted(name: string, script: (string | Error)[]): ChatModel & { sent: number } {
  const model = {
    name,
    sent: 0,
    async complete() {
      const next = script[model.sent] ?? "{}";
      model.sent += 1;
      if (next instanceof Error) throw next;
      return { content: next, usage: { inputTokens: 1000, outputTokens: 200 } };
    },
  };
  return model;
}

// 2026-10-20 是周二：10:00 高峰，12:30 空闲（北京时间）
const PEAK = () => new Date("2026-10-20T10:00:00+08:00");
const OFF = () => new Date("2026-10-20T12:30:00+08:00");
const noSleep = async () => {};

describe("MeteredChat", () => {
  it("照回应里的 usage 记 token，按每次调用的时段算钱（deepseek-flash 高峰 2 / 8 元、空闲 1 / 4 元每百万）", async () => {
    const inner = scripted("deepseek-flash", ["{}", "{}"]);
    const peak = new MeteredChat(inner, { now: PEAK });
    await peak.complete(req("a"));
    const off = new MeteredChat(inner, { now: OFF });
    await off.complete(req("b", "extract"));
    expect(peak.report()).toMatchObject({ calls: 1, attempts: 1, inputTokens: 1000, outputTokens: 200, peakCalls: 1, byPurpose: { judge: { calls: 1 } } });
    expect(peak.report().yuan).toBeCloseTo((1000 * 2 + 200 * 8) / 1e6, 10);
    expect(off.report().yuan).toBeCloseTo((1000 * 1 + 200 * 4) / 1e6, 10);
    expect(off.report().peakCalls).toBe(0);
  });

  it("同样的请求只真问一次，第二次用上次的回答、不记 token", async () => {
    const inner = scripted("deepseek-flash", ['{"x":1}', '{"x":2}']);
    const chat = new MeteredChat(inner, { now: PEAK });
    expect((await chat.complete(req("a"))).content).toBe('{"x":1}');
    expect((await chat.complete(req("a"))).content).toBe('{"x":1}');
    expect(inner.sent).toBe(1);
    expect(chat.report()).toMatchObject({ calls: 1, cacheHits: 1, inputTokens: 1000 });
  });

  it("失败了最多重试 2 次；第 3 次成功就照常记", async () => {
    const inner = scripted("deepseek-flash", [new Error("HTTP 429"), new Error("网络断了"), "{}"]);
    const waits: number[] = [];
    const chat = new MeteredChat(inner, { now: PEAK, sleep: async (ms) => void waits.push(ms) });
    expect((await chat.complete(req("a"))).content).toBe("{}");
    expect(chat.report()).toMatchObject({ calls: 1, attempts: 3, failures: [] });
    expect(waits).toEqual([2000, 5000]);
  });

  it("重试 2 次还失败：不再试，记下来，交回空回答（推理实现当解析不了丢掉）", async () => {
    const inner = scripted("deepseek-flash", [new Error("HTTP 503"), new Error("HTTP 503"), new Error("HTTP 503"), "{}"]);
    const chat = new MeteredChat(inner, { now: PEAK, sleep: noSleep });
    expect((await chat.complete(req("a", "propose"))).content).toBe("");
    expect(inner.sent).toBe(3);
    expect(chat.report()).toMatchObject({ calls: 0, attempts: 3, failures: [{ purpose: "propose", message: "HTTP 503", attempts: 3 }], inputTokens: 0, yuan: 0 });
  });

  it("总次数到了上限就不再发", async () => {
    const inner = scripted("deepseek-flash", ["{}", "{}", "{}"]);
    const chat = new MeteredChat(inner, { now: PEAK, maxCalls: 2 });
    await chat.complete(req("a"));
    await chat.complete(req("b"));
    expect((await chat.complete(req("c"))).content).toBe("");
    expect(inner.sent).toBe(2);
    expect(chat.report()).toMatchObject({ calls: 2, capped: 1 });
  });

  it("连着 3 个请求重试完都失败就停下，后面的不再发（key、模型名不对时别空等）", async () => {
    const inner = scripted("deepseek-flash", Array.from({ length: 20 }, () => new Error("HTTP 401")));
    const chat = new MeteredChat(inner, { now: PEAK, sleep: noSleep });
    for (const u of ["a", "b", "c", "d", "e"]) await chat.complete(req(u));
    expect(inner.sent).toBe(9);
    expect(chat.report()).toMatchObject({ calls: 0, stopped: true, capped: 2 });
    expect(chat.report().failures).toHaveLength(3);
  });

  it("花费封顶：这次最坏的花费（输出写满 maxTokens）加上已经花的超过上限就不发", async () => {
    const inner = scripted("deepseek-flash", ["{}", "{}", "{}"]);
    // 每次实际 1000 入 / 200 出，高峰 0.0036 元；请求的 maxTokens 100，最坏多 0.0008 元出
    const chat = new MeteredChat(inner, { now: PEAK, maxYuan: 0.008 });
    await chat.complete(req("a"));
    await chat.complete(req("b"));
    expect((await chat.complete(req("c"))).content).toBe("");
    expect(inner.sent).toBe(2);
    expect(chat.report()).toMatchObject({ calls: 2, capped: 1 });
    expect(chat.report().yuan!).toBeLessThanOrEqual(0.008);
  });

  it("价格表里没有的模型不算钱", async () => {
    const chat = new MeteredChat(scripted("fake-llm", ["{}"]), { now: PEAK });
    await chat.complete(req("a"));
    expect(chat.report().yuan).toBeNull();
  });

  it("高峰时段：北京时间工作日 9–12 点、14–18 点；午休、晚上、周末是空闲", () => {
    expect(isDeepSeekPeak(new Date("2026-10-20T09:00:00+08:00"))).toBe(true);
    expect(isDeepSeekPeak(new Date("2026-10-20T11:59:00+08:00"))).toBe(true);
    expect(isDeepSeekPeak(new Date("2026-10-20T12:00:00+08:00"))).toBe(false);
    expect(isDeepSeekPeak(new Date("2026-10-20T14:00:00+08:00"))).toBe(true);
    expect(isDeepSeekPeak(new Date("2026-10-20T18:00:00+08:00"))).toBe(false);
    expect(isDeepSeekPeak(new Date("2026-10-24T10:00:00+08:00"))).toBe(false);
  });
});
