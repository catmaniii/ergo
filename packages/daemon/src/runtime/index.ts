// 运行时封装层的对外接口（ADR-0001、ADR-0004）。
// 上层只从这里取东西；这里导出的全是二狗自己的类型。pi 只出现在 agent-child/ 里，
// 那个目录只作为子进程入口由 agent-process.ts 按路径拉起，不被别的模块 import。
export * from "./host-protocol.ts";
export { spawnAgentProcess, type AgentExit, type AgentProcess, type SpawnAgentProcessOptions } from "./agent-process.ts";
// 286 号票：agent 运行时的登记表（pi 和插件登记的运行时，维护者按它拉起哪个子进程入口）
export { type AgentRuntime, createRuntimeRegistry, piRuntime, type RuntimeHistory, type RuntimeHistoryItem, type RuntimeHistoryPart, type RuntimeFollow, type RuntimeOwner, type RuntimeRegistry, type RuntimeRemoteControl, type RuntimeUnavailable } from "./runtimes.ts";
export { runSessionRewrite, type RunSessionRewriteOptions } from "./session-rewrite.ts";
export { PROBE_TIMEOUT_MS, runModelProbe, type RunModelProbeOptions } from "./model-probe.ts";
export { RECORDED_GENERATION_TIMEOUT_MS, runRecordedGeneration, type RunRecordedGenerationOptions } from "./recorded-generation.ts";
export { runThumbnails, THUMBNAILS_TIMEOUT_MS, type RunThumbnailsOptions, type ThumbnailOutcome, type ThumbnailRequest, type ThumbnailResult } from "./thumbnails.ts";
export { redactApiKeys } from "./redact.ts";
// 310 号票：翻斜杠命令的说明（一次性子进程，用二狗的模型）
export { runSlashTranslation, SLASH_TRANSLATE_ENTRY, TRANSLATION_BATCH_MAX, TRANSLATION_TIMEOUT_MS, type RunTranslationOptions, type TranslationRequest, type TranslationResult } from "./translation.ts";
