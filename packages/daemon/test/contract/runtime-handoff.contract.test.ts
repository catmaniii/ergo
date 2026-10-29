// pi 契约测试：换运行时之前写交接摘要（289 号票，宿主协议 write_handoff）。中途换运行时 = 原来的写交接摘要、新的新开会话（和换模型一样），
// pi 是原来的那个时：
// - 用这个会话的模型照 pi 的压缩摘要写法写一份（守护进程给的写法接在后面 "Additional focus"，同换模型的 handoff.ts），结果以 handoff_written
//   报回，那次调用的用量另报（purpose: handoff）；会话文件不动（不新开、不追加）；
// - 模型出错：报没写成的原因（不带 key）。
// 目录模型的请求都发到本机的假 DeepSeek（helpers/fake-deepseek.ts），不联网。
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { Daemon } from "../../src/daemon.ts";
import type { ModelSpec } from "../../src/runtime/index.ts";
import { FAKE_DEEPSEEK_REPLY, requestText, startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const KEY = fakeSecret("sk-", "test-289-not-a-real-key-Zp4k");
const INSTRUCTIONS = "交接摘要的测试写法：写清在做什么、做到哪了。";
const flash = (baseUrl: string): ModelSpec => ({ kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off", baseUrl });

/** 拉起、说一句话、等这一轮结束，再要它写交接摘要 */
async function talkThenHandoff(daemon: Daemon, baseUrl: string, before?: () => void) {
  const { agent, log } = spawnTestAgent(daemon, { agentId: "contract-runtime-handoff", model: flash(baseUrl), credentials: { deepseek: KEY }, tools: [], continueSession: true });
  const ready = await log.next("ready", 60_000);
  agent.send({ type: "user_input", inputId: "in-1", text: "我在整理十月的发票，按月份分文件夹" });
  expect((await log.next("turn_end")).outcome).toBe("completed");
  const fileBefore = fs.readFileSync(ready.sessionFile, "utf8");
  before?.();
  agent.send({ type: "write_handoff", requestId: "h-1", instructions: INSTRUCTIONS, timeoutMs: 30_000 });
  const written = await log.next("handoff_written");
  const fileAfter = fs.readFileSync(ready.sessionFile, "utf8");
  const usage = log.ofType("usage");
  agent.kill();
  await agent.exited;
  return { written, fileBefore, fileAfter, usage };
}

describe("pi 契约：换运行时之前写交接摘要（write_handoff）", () => {
  it("用这个会话的模型照 pi 的压缩摘要写法写（守护进程的写法接在后面），报回摘要和那次的用量；会话文件不动", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    const { written, fileBefore, fileAfter, usage } = await talkThenHandoff(daemon, provider.baseUrl);
    expect(written).toEqual({ type: "handoff_written", requestId: "h-1", text: FAKE_DEEPSEEK_REPLY });
    const prompt = requestText(provider.requests[1]!);
    expect(provider.requests[1]!.body).toMatchObject({ model: "deepseek-flash" });
    expect(prompt).toContain("<conversation>");
    expect(prompt).toContain("我在整理十月的发票");
    expect(prompt).toContain(`Additional focus: ${INSTRUCTIONS}`);
    expect(usage.at(-1)).toMatchObject({ purpose: "handoff", provider: "deepseek", modelId: "deepseek-flash" });
    expect(fileAfter).toBe(fileBefore);
  });

  it("模型出错：报没写成的原因（不带 key）", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    const { written } = await talkThenHandoff(daemon, provider.baseUrl, () => provider.failNext("摘要写不出来"));
    expect(written.text).toBeUndefined();
    expect(written.error).toContain("摘要写不出来");
    expect(written.error).not.toContain(KEY.slice(-4));
  });
});
