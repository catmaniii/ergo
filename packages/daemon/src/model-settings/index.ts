// 设置里的"模型"（73 号票）对外的东西。别的模块只从这里取。
// agent、思考档位、设置和设置页的样子在共享协议包的 model-settings.ts。
export { createModelSettings, type ModelSettingsOptions, type ModelSettingsService } from "./model-settings.ts";
export { DEFAULT_MODEL_SETTINGS, MODEL_PROVIDERS, type ModelProvider, providerOf } from "./providers.ts";
