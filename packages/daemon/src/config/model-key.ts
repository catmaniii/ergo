// 模型在配置里的键（模型能力 models、单价 tokenPrices 都按它；token 账本里记的模型也是它）：
// 目录里的模型是「provider/模型 id」，测试用的 faux provider 是 faux。
// 单独一个文件、只引用类型：agent 管家（记账用的模型键）和配置都从这里取，不绕成循环引用。
import type { ModelSpec } from "../runtime/index.ts";

/** 某个模型在配置里的键 */
export function modelConfigKey(model: ModelSpec): string {
  return model.kind === "catalog" ? `${model.provider}/${model.modelId}` : "faux";
}
