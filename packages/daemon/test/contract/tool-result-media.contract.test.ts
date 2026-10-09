// pi 契约测试：工具结果里的二进制内容（53 号票）。pi 的 read 读图片时，结果里是一段文字说明加一个图片块（base64）；
// 子进程把图片块换成 [image] 占位放进 resultText（内容不过宿主协议），另在 tool_call_end.media 里说明是什么、多大，
// 守护进程的"完整参数和返回"据此告诉详情页"这里有一张图片，没有内联"。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { png } from "../helpers/images.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("pi 契约：工具结果里的图片", () => {
  it("read 读图片：resultText 里是文字说明和 [image] 占位，没有 base64；media 说明是图片、类型和大小", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergou-cwd-");
    fs.writeFileSync(path.join(cwd, "pic.png"), png({ width: 8, height: 4 }));
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-read-image",
      cwd,
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "read", arguments: { path: "pic.png" } }] }, { kind: "reply", text: "看过了" }]),
      tools: ["read"],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看看这张图" });

    const end = await log.next("tool_call_end");
    expect(end.isError).toBe(false);
    expect(end.resultText).toContain("[image]");
    expect(end.resultText).toContain("image/png");
    expect(end.resultText).not.toMatch(/iVBOR/);
    expect(end.media).toEqual([{ type: "image", mimeType: "image/png", bytes: expect.any(Number) }]);
    expect(end.media![0]!.bytes).toBeGreaterThan(0);
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });

  it("只有文字的结果没有 media", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergou-cwd-");
    fs.writeFileSync(path.join(cwd, "a.txt"), "hello");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-read-text",
      cwd,
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "read", arguments: { path: "a.txt" } }] }, { kind: "reply", text: "看过了" }]),
      tools: ["read"],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看看" });
    const end = await log.next("tool_call_end");
    expect(end.resultText).toContain("hello");
    expect(end).not.toHaveProperty("media");
  });
});
