// 自定义（OpenAI 兼容）服务商（设置 · 模型、首次设置向导那一步共用的那几项）：接口地址、模型 id、接口类型。网页这一侧只管——
// - 设置里存的那一份怎么填进表单、表单里填的怎么收拾成设置里的样子（和守护进程存的时候一样：去首尾空白、地址末尾的斜杠）；
// - 存之前查不查得过：选的还是自定义时地址、模型 id 都得合规，存的是 DeepSeek 时那一块不合规也不要紧——不带它，照样存
//   （设置里原来那份留着，切回自定义时还在）。规矩和守护进程同一套（协议包 checkModelCustom / 请求体的 schema），但句子写在
//   网页这边：protocol 的那几句在 modelSettings 区域，网页的词典里没有那个区域（WEB_NAMESPACES），用了会显示成 key 本身。
//   最后一道还是守护进程——它收不收由它说了算，不收时页面照旧 toast 它给的原因；
// - 列出这个服务商有哪些模型之后：下拉里是哪几项、拉到了没有（成功、一个都没有、失败三种说法）。
// 界面在 ui/model-provider.tsx；模型 id 的下拉要"服务商原样给的那个 id"，设置里存的也是它。
import {
  CUSTOM_PROVIDER_ID,
  DEFAULT_CUSTOM_PROVIDER_API,
  type CustomProviderApi,
  type ModelCustomModel,
  type ModelCustomModelsResult,
  type ModelCustomProvider,
  type ModelSettings,
  type ModelSettingsBody,
  t,
} from "./protocol.ts";
import { withProvider } from "./model-settings.ts";

/** 表单里那几项：接口类型总有值（没选过按默认），地址和模型 id 可以是空的（还没填） */
export interface CustomDraft {
  baseUrl: string;
  modelId: string;
  api: CustomProviderApi;
}

/** 设置里存着的那一份填进表单；没存过时是空的、接口类型按默认（openai-completions） */
export function customDraftOf(settings: Pick<ModelSettings, "custom">): CustomDraft {
  const custom = settings.custom;
  return { baseUrl: custom?.baseUrl ?? "", modelId: custom?.modelId ?? "", api: custom?.api ?? DEFAULT_CUSTOM_PROVIDER_API };
}

/** 表单里填的收拾成设置里的样子：去掉首尾空白、地址末尾的斜杠（和守护进程存的时候一样） */
export function customOf(draft: CustomDraft): ModelCustomProvider {
  return { baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""), modelId: draft.modelId.trim(), api: draft.api };
}

/** 这两项都还空着（刚切到自定义、还没开始填）：这时不急着报"没填"，也不急着存 */
export function customDraftUntouched(draft: CustomDraft): boolean {
  return draft.baseUrl.trim() === "" && draft.modelId.trim() === "";
}

/**
 * 点了一个服务商之后要不要马上存：DeepSeek 总是存（那一份永远合规，存好之后 key 那一块才是它的）；
 * 选自定义时刚切过来、还什么都没填就先不存——等填了地址或模型 id 再存，不然一点就报"没填"
 */
export function providerPickNeedsSave(provider: string, draft: CustomDraft): boolean {
  return provider !== CUSTOM_PROVIDER_ID || !customDraftUntouched(draft);
}

/**
 * 填的这一块哪里不对（地址要是 http(s) 开头的、不能有空白；模型 id 不能是空的）：能存是 undefined。
 * 什么都没填时先说"没填这一块"——不然会先怪接口地址的格式
 */
export function customDraftProblem(draft: CustomDraft): string | undefined {
  const custom = customOf(draft);
  if (customDraftUntouched(draft)) return t("state.modelCustom.missing");
  if (!/^https?:\/\/\S+$/i.test(custom.baseUrl)) return t("state.modelCustom.badBaseUrl", { baseUrl: draft.baseUrl });
  if (custom.modelId === "") return t("state.modelCustom.badModelId");
  return undefined;
}

/**
 * 存不存得了：选的是自定义时，地址和模型 id 都得合规（不合规时 error 就是原因，原样交给页面）；
 * 存的是 DeepSeek 时自定义那一块不合规也不拦着——不带这一块存，设置里原来那份留着
 */
export type CustomSavePlan = { ok: true; body: ModelSettingsBody } | { ok: false; error: string };

export function customSavePlan(settings: ModelSettings, provider: string, draft: CustomDraft): CustomSavePlan {
  const problem = customDraftProblem(draft);
  if (problem !== undefined) return provider === CUSTOM_PROVIDER_ID ? { ok: false, error: problem } : { ok: true, body: withProvider(settings, provider) };
  return { ok: true, body: withProvider(settings, provider, customOf(draft)) };
}

/** 下拉里的一行：服务商给的名字（和 id 不一样时写两个），没有名字就写 id */
export function customModelLabel(model: Pick<ModelCustomModel, "id" | "name">): string {
  return model.name !== undefined && model.name !== "" && model.name !== model.id ? t("state.modelSettings.option.named", { name: model.name, id: model.id }) : model.id;
}

/**
 * 拉到的模型变成下拉的几项：现在填的那个不在列表里时补在第一项（不然下拉里显示不出它，用户会以为填的没了）
 */
export function customModelOptions(models: readonly ModelCustomModel[], current: string): Array<{ id: string; label: string }> {
  const options = models.map((model) => ({ id: model.id, label: customModelLabel(model) }));
  const id = current.trim();
  if (id !== "" && !options.some((option) => option.id === id)) options.unshift({ id, label: id });
  return options;
}

/** 拉列表的结果怎么说：拉到几个、一个都没有、失败（失败时是守护进程写的原因，原样显示） */
export function customModelsText(result: ModelCustomModelsResult): { ok: boolean; text: string } {
  if (!result.ok) return { ok: false, text: result.error ?? t("state.modelCustom.listNoReason") };
  if (result.models.length === 0) return { ok: true, text: t("state.modelCustom.listEmpty") };
  return { ok: true, text: t("state.modelCustom.listOk", { n: result.models.length }) };
}
