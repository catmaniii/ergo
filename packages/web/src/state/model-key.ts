// 模型的 key 在网页上填（319 号票，用户 2026-10-28 定"网页里能填 key"）的状态层：请求体怎么拼、输入框里的草稿能不能存、
// 存好之后怎么说。界面在 ui/model-key.tsx，设置 · 模型和首次设置向导的那一步共用同一块。
// 2026-10-30 起设置 · 模型的 API key 一块按服务商逐条列出：请求体可以点名写哪个服务商（不带还是设置里选的那一个）。
// 纯函数，不碰网络、不碰 DOM（网络在 ui/model-key.tsx 里交给 http.saveModelKey）。
import {
  MODEL_KEY_MAX_LENGTH,
  MODEL_KEY_MIN_LENGTH,
  type ModelKeyBody,
  type ModelKeyEffective,
  type ModelKeyWriteResult,
  normalizeModelKey,
  t,
} from "./protocol.ts";

/**
 * 保存 key 的请求体：去掉 BOM、换行和首尾空白（和守护进程写文件前做的是同一套）。
 * provider 给了就写那个服务商的密钥文件（设置页每一行一个服务商），不给还是设置里选的那一个
 */
export function modelKeyBody(raw: string, provider?: string): ModelKeyBody {
  return { key: normalizeModelKey(raw), ...(provider === undefined ? {} : { provider }) };
}

/** 输入框里的草稿存不了的原因：空的、太短、太长；能存是 undefined */
export function modelKeyDraftProblem(raw: string): "empty" | "short" | "long" | undefined {
  const key = normalizeModelKey(raw);
  if (key.length === 0) return "empty";
  if (key.length < MODEL_KEY_MIN_LENGTH) return "short";
  if (key.length > MODEL_KEY_MAX_LENGTH) return "long";
  return undefined;
}

/** 草稿不合规时输入框下面那一句（空的不说，别一打开就红着） */
export function modelKeyDraftNote(raw: string): string | undefined {
  const problem = modelKeyDraftProblem(raw);
  if (problem === undefined || problem === "empty") return undefined;
  return problem === "short" ? t("state.modelKey.tooShort", { min: MODEL_KEY_MIN_LENGTH }) : t("state.modelKey.tooLong", { max: MODEL_KEY_MAX_LENGTH });
}

/** 存好之后说的一句：配好了、什么时候生效；restart 时另有一句怎么重启（安装版是 ergo restart） */
export interface ModelKeySavedText {
  effective: ModelKeyEffective;
  text: string;
  /** 只说 restart 的：怎么重启 */
  how?: string;
}

export function modelKeySavedText(result: Pick<ModelKeyWriteResult, "effective">): ModelKeySavedText {
  const brand = t("shell.brand");
  if (result.effective === "restart") return { effective: "restart", text: t("state.modelKey.savedRestart", { brand }), how: t("state.modelKey.restartHow") };
  return { effective: "now", text: t("state.modelKey.savedNow") };
}
