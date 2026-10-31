// @i18n-ignore-file model：翻译的系统提示给模型看；没翻成的原因守护进程只记日志
// 子进程里翻斜杠命令的说明（310 号票，translate-main.ts 拉起这里）：Claude Code 报回的命令、skill 带的说明是英文的，界面是中文时
// 用二狗的模型翻成一句中文（别的语言同理），守护进程缓存起来。
// - 只交说明原文：每条单独一次模型调用（completeSimple，和范围审视一样在会话之外），系统提示只说怎么翻，用户消息就是那句原文；
// - 不开思考、最多 MAX_TOKENS 个 token；模型照守护进程交来的（catalog 的按 provider 取凭据，faux 的按剧本回），凭据只放内存；
// - 一条没翻成（模型出错、回的是空的）那一条是 null，原因去掉凭据的内容；用量每次调用一条（purpose: translation），守护进程记账。
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelKeyOf } from "@ergo/protocol";
import type { UsageReport } from "../host-protocol.ts";
import { redactApiKeys } from "../redact.ts";
import { TRANSLATION_TEXT_MAX, type TranslationRequest, type TranslationResult } from "../translation.ts";
import { registerCustomProvider } from "./custom-provider.ts";
import { registerFauxModel } from "./faux.ts";

/** 一条译文最多要几个 token（一两句话够了） */
const MAX_TOKENS = 400;

/** 翻译的系统提示（language 是给模型看的语言名） */
export function translationPrompt(language: string): string {
  return [
    `把用户发来的一条斜杠命令的说明翻译成${language}。`,
    "只回译文本身：通顺简短，不加引号、不加解释、不加前缀；命令名、代码、文件名、路径、占位符（<…>、[…]、$ARGUMENTS 这类）照原样保留。",
    `原文已经是${language}就原样回。`,
  ].join("\n");
}

/** 模型回的译文收拾一下：去掉两头的空白和成对的引号，空白合成一个空格；收拾完是空的算没翻成 */
export function cleanTranslation(text: string): string {
  let out = text.trim();
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["“", "”"],
    ["「", "」"],
    ["'", "'"],
  ];
  for (const [open, close] of pairs) if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) out = out.slice(open.length, -close.length).trim();
  return out.replace(/\s+/g, " ");
}

export async function translateTexts(request: TranslationRequest): Promise<TranslationResult> {
  const secrets = Object.values(request.credentials);
  // 凭据只放内存：不读 ~/.pi/agent/auth.json，也不读 models.json，不连网刷新模型目录（和模型探查一样）
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // 自定义（OpenAI 兼容）服务商：pi 的模型目录里没有它，先登记，getModel("custom", 模型 id) 才认得
  registerCustomProvider(modelRuntime, request.custom);
  for (const [provider, apiKey] of Object.entries(request.credentials)) await modelRuntime.setRuntimeApiKey(provider, apiKey);
  const spec = request.model;
  const found = spec.kind === "faux" ? registerFauxModel(spec, modelRuntime) : modelRuntime.getModel(spec.provider, spec.modelId);
  if (!found) throw new Error(spec.kind === "catalog" ? `模型目录里没有 ${modelKeyOf(spec.provider, spec.modelId)}` : "faux 模型注册不上");
  const model = spec.kind === "catalog" && spec.baseUrl !== undefined ? { ...found, baseUrl: spec.baseUrl } : found;
  const systemPrompt = translationPrompt(request.language);
  const texts: Array<string | null> = [];
  const usage: UsageReport[] = [];
  const errors: string[] = [];
  for (const [i, original] of request.texts.entries()) {
    try {
      // 不给 reasoning：不开思考（一句翻译用不着）
      const response = await modelRuntime.completeSimple(
        model,
        { systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: original.slice(0, TRANSLATION_TEXT_MAX) }], timestamp: Date.now() }] },
        { maxTokens: MAX_TOKENS, cacheRetention: "none" },
      );
      usage.push({
        type: "usage",
        messageId: `translation-${i + 1}`,
        provider: response.provider,
        modelId: response.model,
        input: response.usage.input,
        output: response.usage.output,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        totalTokens: response.usage.totalTokens,
        purpose: "translation",
      });
      if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? response.stopReason);
      const text = cleanTranslation(response.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
      if (!text) throw new Error("模型回的译文是空的");
      texts.push(text);
    } catch (err) {
      texts.push(null);
      errors.push(redactApiKeys(err instanceof Error ? err.message : String(err), secrets));
    }
  }
  return { texts, usage, errors };
}
