// pi 契约测试：看图能力（79 号票）。
// - 看图能力默认取 pi 的模型目录（模型的输入里有图片就算能看：deepseek-flash 能，deepseek-v4-pro 不能）；装配参数写明了 vision
//   的以它为准（可以关掉，也可以打开）。子进程在 ready 里报回实际生效的。
// - 子进程按实际生效的改写会话用的模型：能看图时用户输入里的图片、历史里的图片都作为图片发给 provider；关掉时 pi 把它们换成
//   一句占位（本机回放 DeepSeek 的流式响应、记下请求体，不联网）。
// - 73 号票起看图能力在会话开始时定下：接着同一个会话时配置改了也照开始时的（一个会话固定一个模型），新开的会话按新的。
//   装配参数 vision 是按模型的表（键是「provider/模型 id」，faux 是 faux）。
// - 宿主工具的结果可以带图片（读取附件读图）、插话可以带图片：模型调用的上下文里有这张图。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { HostToolSpec, ModelSpec } from "../../src/runtime/index.ts";
import { DEEPSEEK_STREAM } from "../fixtures/provider-usage-streams.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { png } from "../helpers/images.ts";

/** 本机起一个只回放 DeepSeek 流式响应的服务（测试结束关掉），记下每次请求的请求体 */
async function recordingProvider(): Promise<{ baseUrl: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(DEEPSEEK_STREAM.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const deepseek = (modelId: string, baseUrl?: string): ModelSpec => ({ kind: "catalog", provider: "deepseek", modelId, thinkingLevel: "off", ...(baseUrl === undefined ? {} : { baseUrl }) });
/** 一张能解码的小图（pi 发给模型前会解码、按模型的上限缩放） */
const pixel = () => ({ mime: "image/png", data: png({ width: 4, height: 4 }).toString("base64") });
/** 回显的上下文（faux 的 echo_context） */
const echoed = (message: { parts: Array<{ type: string; text?: string }> }) => message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

// 255 号票：这个文件的用例一条里依次拉起好几个 agent 子进程（第一条 7 个），空闲时 10 秒上下，全量并行时超过默认的 30 秒；
// 查过不是竞态，只是慢（用户 2026-10-24 定：只给这个文件加长超时）
vi.setConfig({ testTimeout: 120_000 });

describe("pi 契约：看图能力取模型目录，配置写明的为准", () => {
  it("不写：deepseek-flash 能看图、deepseek-v4-pro 不能；写明的为准（关掉、打开）；faux 按它的目录（能收图片）", async () => {
    const { daemon } = await startTestDaemon();
    const readyOf = async (agentId: string, model: ModelSpec, vision?: Record<string, boolean>) => {
      const { log } = spawnTestAgent(daemon, { agentId, model, credentials: { deepseek: "sk-test-not-a-real-key" }, tools: [], ...(vision === undefined ? {} : { vision }) });
      return (await log.next("ready")).vision;
    };
    expect(await readyOf("vision-flash", deepseek("deepseek-flash"))).toBe(true);
    expect(await readyOf("vision-flash-off", deepseek("deepseek-flash"), { "deepseek/deepseek-flash": false })).toBe(false);
    // 表里别的模型的不管这个模型
    expect(await readyOf("vision-flash-other", deepseek("deepseek-flash"), { "deepseek/deepseek-v4-pro": true })).toBe(true);
    expect(await readyOf("vision-pro", deepseek("deepseek-v4-pro"))).toBe(false);
    expect(await readyOf("vision-pro-on", deepseek("deepseek-v4-pro"), { "deepseek/deepseek-v4-pro": true })).toBe(true);
    expect(await readyOf("vision-faux", fauxModel([]))).toBe(true);
    expect(await readyOf("vision-faux-off", fauxModel([]), { faux: false })).toBe(false);
  });

  it("deepseek-flash 不写配置：用户输入里的图片作为图片发给 provider，之后每次调用历史里的这张图也在；接着同一个会话时配置关掉看图也照开始时的；新开的会话关掉看图时图片换成占位、不发", async () => {
    const provider = await recordingProvider();
    const { daemon } = await startTestDaemon();
    const spawn = async (vision?: Record<string, boolean>, agentId = "contract-vision-deepseek") => {
      const spawned = spawnTestAgent(daemon, {
        agentId,
        model: deepseek("deepseek-flash", provider.baseUrl),
        credentials: { deepseek: "sk-test-not-a-real-key" },
        tools: [],
        continueSession: true,
        ...(vision === undefined ? {} : { vision }),
      });
      await spawned.log.next("ready");
      return spawned;
    };

    const first = await spawn();
    first.agent.send({ type: "user_input", inputId: "in-1", text: "[图片 1：点.png] 这是什么", images: [pixel()] });
    expect((await first.log.next("turn_end")).outcome).toBe("completed");
    first.agent.send({ type: "user_input", inputId: "in-2", text: "再说说" });
    expect((await first.log.next("turn_end")).outcome).toBe("completed");
    first.agent.kill();
    await first.agent.exited;
    // 第一次：这张图作为 image_url 发出；第二次：历史里的这张图照样在
    expect(provider.bodies).toHaveLength(2);
    for (const body of provider.bodies) expect(body).toContain('"image_url"');
    expect(provider.bodies[0]).toContain("data:image/png;base64,");

    // 接着同一个会话，配置关掉看图：照会话开始时的（73 号票），历史里的图照样发
    const second = await spawn({ "deepseek/deepseek-flash": false });
    second.agent.send({ type: "user_input", inputId: "in-3", text: "还记得那张图吗" });
    expect((await second.log.next("turn_end")).outcome).toBe("completed");
    second.agent.kill();
    await second.agent.exited;
    expect(provider.bodies).toHaveLength(3);
    expect(provider.bodies[2]).toContain('"image_url"');

    // 新开的会话关掉看图：输入里的图片换成 pi 的占位，请求里没有图片
    const third = await spawn({ "deepseek/deepseek-flash": false }, "contract-vision-deepseek-off");
    third.agent.send({ type: "user_input", inputId: "in-4", text: "[图片 1：点.png] 这是什么", images: [pixel()] });
    expect((await third.log.next("turn_end")).outcome).toBe("completed");
    expect(provider.bodies).toHaveLength(4);
    expect(provider.bodies[3]).not.toContain('"image_url"');
    expect(provider.bodies[3]).toContain("image omitted");
  });
});

describe("pi 契约：宿主工具的结果和插话带图片", () => {
  const READ_TOOL: HostToolSpec = {
    name: "read_attachment",
    description: "读取附件（测试用）",
    parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false },
  };

  it("宿主工具的结果带图片：图片跟在文字后面进下一次模型调用的上下文；tool_call_end 里只有占位和说明（内容不过宿主协议）", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-host-tool-image",
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "read_attachment", arguments: { ref: "abcd1234" } }] }, { kind: "echo_context" }]),
      tools: [],
      hostTools: [READ_TOOL],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看看那张图" });
    const call = await log.next("host_tool_call");
    agent.send({ type: "host_tool_result", requestId: call.requestId, result: { text: "附件「点.png」是图片，见下面的图。", isError: false, images: [pixel()] } });
    const end = await log.next("tool_call_end");
    expect(end).toMatchObject({ isError: false, media: [{ type: "image", mimeType: "image/png", bytes: expect.any(Number) }] });
    expect(end.resultText).not.toMatch(/iVBOR/);
    expect(echoed((await log.next("message_final")).message)).toContain("[toolResult] read_attachment: 附件「点.png」是图片，见下面的图。\n[image image/png]");
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });

  it("插话带图片：插话进上下文时这张图也在", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-interject-image",
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "read_attachment", arguments: { ref: "abcd1234" } }] }, { kind: "echo_context" }]),
      tools: [],
      hostTools: [READ_TOOL],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "先读个附件" });
    // 回合停在宿主工具上：这时送的插话是在回合进行中到的
    const call = await log.next("host_tool_call");
    agent.send({ type: "interject", inputId: "in-2", text: "[图片 1：点.png] 顺便看看这张", images: [pixel()] });
    agent.send({ type: "host_tool_result", requestId: call.requestId, result: { text: "读好了", isError: false } });
    expect(echoed((await log.next("message_final")).message)).toContain("[user] [图片 1：点.png] 顺便看看这张\n[image image/png]");
    expect(await log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed", interjected: ["in-2"] });
  });
});
