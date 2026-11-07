// pi 契约测试：模型出错时（421）。真实 provider 的路子（pi 的 openai-completions 发 HTTP 到本机的假服务，不联网）：
// - 服务商回 503：pi 当成能重试的，重试之前子进程报 model_retry（第几次、最多几次、等多久、出错原文）；
// - 请求发出去一直不回（连响应头都没有）：到了"太久没回应"的点（这里配成 1 秒）子进程中止这一次、交给 pi 一条带 timed out 的出错，
//   pi 照样重试、算进重试次数；
// - 第三次照常回：这一轮完成；出错的两次各报一条用量、带 failed，成了的那次不带。pi 升级改了重试的认法、事件时这里会红。
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEEPSEEK_STREAM } from "../fixtures/provider-usage-streams.ts";
import { spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";

/** 本机起一个按次序回话的 chat completions 服务：第 1 次 503，第 2 次一直不回，之后回放样本（测试结束关掉） */
async function flakyProvider(): Promise<{ baseUrl: string; requests: () => number }> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      count += 1;
      if (count === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Service Unavailable", type: "server_error" } }));
      } else if (count === 2) {
        // 一直不回：不写响应头，等客户端自己断开
      } else {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(DEEPSEEK_STREAM.body);
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => count };
}

describe("pi 契约：模型出错时自动重试", () => {
  it("503 → 报 model_retry 重试；一直不回 → 到点中止、按出错重试；第三次成了，这一轮完成；出错的两次用量带 failed", async () => {
    const provider = await flakyProvider();
    const { daemon } = await startTestDaemon({ config: { agents: { modelSilenceSeconds: 1 } } });
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-model-retry",
      model: { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off", baseUrl: provider.baseUrl },
      credentials: { deepseek: "sk-test-not-a-real-key" },
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看一眼" });
    expect(await log.next("turn_end", 30_000)).toMatchObject({ outcome: "completed" });
    expect(provider.requests()).toBe(3);

    const [first, second] = log.ofType("model_retry");
    expect(first).toMatchObject({ attempt: 1, maxAttempts: 3, delayMs: 2000, error: expect.stringMatching(/503/) });
    expect(second).toMatchObject({ attempt: 2, maxAttempts: 3, delayMs: 4000, error: expect.stringMatching(/No response from the model for 1 seconds; the request timed out/) });
    expect(log.ofType("model_retry")).toHaveLength(2);

    const finals = log.ofType("message_final");
    expect(finals.map((f) => f.message.stopReason)).toEqual(["error", "error", "done"]);
    expect(finals.at(-1)!.message.parts).toEqual([{ type: "text", text: DEEPSEEK_STREAM.text }]);
    const usages = log.ofType("usage");
    expect(usages.map((u) => u.failed === true)).toEqual([true, true, false]);
    expect(usages.at(-1)).not.toHaveProperty("failed");
  }, 60_000);
});
