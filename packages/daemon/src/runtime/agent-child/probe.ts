// 子进程里的模型探查（设置里的"模型"，73 号票）：模型目录只有子进程查得到（pi 边界，ADR-0001、ADR-0004），守护进程自己不跑模型
// （ADR-0002），所以设置页要的两件事在一次性子进程里做（model-probe-main.ts 拉起这里）：
// - catalog：列出模型目录里某个服务商的模型——名字、能不能看图（输入里有没有图片）、支持哪几档思考。不连网、不要凭据；
// - ping：连通测试——用这个模型发一条极短的请求（不开思考、只要几个字），量从发出到第一个 token 的时间和整次的时间。
//   凭据只放内存；出错的原因里去掉凭据的内容（provider 的报错可能带着 key 的一截，比如"****abcd"；runtime/redact.ts）。
import { getSupportedThinkingLevels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelKeyOf, t } from "@ergo/protocol";
import type { CatalogModel, ModelProbeRequest, ModelProbeResult, ModelSpec, ThinkingLevel } from "../host-protocol.ts";
import { redactApiKeys } from "../redact.ts";
import { registerCustomProvider } from "./custom-provider.ts";
import { registerFauxModel } from "./faux.ts";

/** 连通测试发的那句话 */
const PING_TEXT = "ping：只回一个字「在」。"; // @i18n-ignore model：发给模型的那句

/** 连通测试最多要几个 token（够回一两个字） */
const PING_MAX_TOKENS = 16;

/** 宿主协议里有的思考档位（pi 另有的档不列） */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export async function probeModels(request: ModelProbeRequest): Promise<ModelProbeResult> {
  // 凭据只放内存：不读 ~/.pi/agent/auth.json，也不读 models.json，不连网刷新模型目录（和 agent 会话一样）
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // 自定义（OpenAI 兼容）服务商：pi 的模型目录里没有它，先登记，之后列目录（就它那一个模型）、测连通性才认得
  registerCustomProvider(modelRuntime, request.custom);
  if (request.type === "catalog") {
    const models: CatalogModel[] = modelRuntime.getModels(request.provider).map((model) => ({
      modelId: model.id,
      name: model.name,
      vision: model.input.includes("image"),
      thinkingLevels: getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(level)),
    }));
    return { type: "catalog", models };
  }
  return ping(modelRuntime, request.model, request.credentials);
}

async function ping(modelRuntime: ModelRuntime, spec: ModelSpec, credentials: Record<string, string>): Promise<ModelProbeResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const failed = (error: string): ModelProbeResult => ({ type: "ping", ok: false, totalMs: elapsed(), error: redactApiKeys(error, Object.values(credentials)) });
  for (const [provider, apiKey] of Object.entries(credentials)) await modelRuntime.setRuntimeApiKey(provider, apiKey);
  const model = spec.kind === "faux" ? registerFauxModel(spec, modelRuntime) : modelRuntime.getModel(spec.provider, spec.modelId);
  if (!model) return failed(spec.kind === "catalog" ? t("runtime.probe.noModel", { model: modelKeyOf(spec.provider, spec.modelId) }) : t("runtime.probe.noThisModel"));
  const target = spec.kind === "catalog" && spec.baseUrl !== undefined ? { ...model, baseUrl: spec.baseUrl } : model;
  let firstTokenMs: number | undefined;
  try {
    // 不开思考（不给 reasoning）：只量通不通、多久出第一个字
    const stream = modelRuntime.streamSimple(
      target,
      { messages: [{ role: "user", content: [{ type: "text", text: PING_TEXT }], timestamp: Date.now() }] },
      { maxTokens: PING_MAX_TOKENS, cacheRetention: "none" },
    );
    for await (const event of stream) {
      if (firstTokenMs === undefined && (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")) firstTokenMs = elapsed();
      if (event.type === "error") return failed(event.error.errorMessage ?? (event.reason === "aborted" ? t("runtime.probe.aborted") : t("runtime.probe.failed")));
      if (event.type === "done") break;
    }
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  if (firstTokenMs === undefined) return failed(t("runtime.probe.empty"));
  return { type: "ping", ok: true, firstTokenMs, totalMs: elapsed() };
}
