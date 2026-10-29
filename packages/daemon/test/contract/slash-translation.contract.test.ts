// pi 契约：翻斜杠命令的说明（310 号票，一次性子进程 agent-child/translate-main.ts，用 pi 的 completeSimple 在会话之外调模型）：
// - 每条说明单独一次调用，交给模型的只有系统提示（怎么翻）和那句原文——不带命令名、会话、别的上下文；
// - 每次调用报一条用量（purpose: translation）；一条没翻成（剧本用完、模型出错）那一条是 null，别的照旧；
// - 目录模型（本机的假 DeepSeek）：不开思考、最多几百个 token，key 交给 provider，出错原因里没有 key。
import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { runSlashTranslation } from "../../src/runtime/index.ts";
import { fauxModel } from "../helpers/daemon.ts";
import { requestText, startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const KEY = fakeSecret("sk-", "test-310-not-a-real-key-7Qx2");
const env = () => buildChildEnv(process.env);

describe("pi 契约：翻斜杠命令的说明", () => {
  it("faux：每条一次调用、照剧本回，译文收拾过（去掉引号、空白合并）；每次调用一条用量", async () => {
    const result = await runSlashTranslation(
      {
        model: fauxModel([
          { kind: "reply", text: "  「给当前分支写发布说明」\n" },
          { kind: "reply", text: "先写测试，\n再写实现" },
        ]),
        credentials: {},
        language: "中文",
        texts: ["Write release notes for the current branch", "Test first, then implement"],
      },
      { env: env() },
    );
    expect(result.texts).toEqual(["给当前分支写发布说明", "先写测试， 再写实现"]);
    expect(result.usage).toHaveLength(2);
    expect(result.usage.every((u) => u.purpose === "translation" && u.type === "usage")).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("交给模型的只有怎么翻的系统提示和那句原文", async () => {
    const result = await runSlashTranslation(
      { model: fauxModel([{ kind: "reply_with_context", text: "{{context}}" }]), credentials: {}, language: "中文", texts: ["Review a pull request"] },
      { env: env() },
    );
    const context = result.texts[0]!;
    expect(context).toContain("[system]");
    expect(context).toContain("翻译成中文");
    // 用户消息就是原文这一句
    expect(context).toContain("[user] Review a pull request");
    expect(context.match(/\[user\]/g)).toHaveLength(1);
    expect(context).not.toContain("[tool]");
  });

  it("一条没翻成（剧本用完）：那一条是 null、写明原因，前面翻成的照旧", async () => {
    const result = await runSlashTranslation(
      { model: fauxModel([{ kind: "reply", text: "压缩对话" }]), credentials: {}, language: "中文", texts: ["Compact", "Context"] },
      { env: env() },
    );
    expect(result.texts).toEqual(["压缩对话", null]);
    expect(result.errors).toHaveLength(1);
  });

  it("目录模型：不开思考、最多几百个 token，消息只有系统提示和原文；key 交给 provider；401 时没翻成、原因里没有 key", async () => {
    const provider = await startFakeDeepSeek();
    const model = { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high", baseUrl: provider.baseUrl } as const;
    const ok = await runSlashTranslation({ model, credentials: { deepseek: KEY }, language: "中文", texts: ["Show plan usage limits"] }, { env: env() });
    expect(ok.texts[0]).toEqual(expect.any(String));
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, max_tokens: 400 });
    expect(request.body.messages).toHaveLength(2);
    expect(requestText(request)).toContain("Show plan usage limits");
    expect(request.authorization === `Bearer ${KEY}`).toBe(true);

    provider.unauthorized();
    const denied = await runSlashTranslation({ model, credentials: { deepseek: KEY }, language: "中文", texts: ["Show plan usage limits"] }, { env: env() });
    expect(denied.texts).toEqual([null]);
    expect(denied.errors[0]).not.toContain(KEY);
    expect(denied.errors[0]).not.toContain(KEY.slice(-4));
  });
});
