// 各 agent 的系统提示（71 号票）：提示的文字在 md 文件里（默认的在本包的 prompts/，用户改的在数据目录配置区的 prompts/），
// 用户能在设置 · 系统提示里改。别处只从这里取东西。
export { createPromptLibrary, DEFAULT_PROMPTS_DIR, defaultPromptLibrary, PromptFilesBroken, type PromptLibrary, type PromptLibraryOptions, type PromptRenderer, promptSpec } from "./library.ts";
export {
  checkPromptRegistry,
  commonPlaceholders,
  isPromptId,
  type PluginPromptFragment,
  type PluginPrompts,
  PROMPT_IDS,
  PROMPTS,
  type PromptDefinition,
  type PromptId,
  type PromptRegistry,
  promptRegistry,
  type PromptValuesOf,
} from "./registry.ts";
