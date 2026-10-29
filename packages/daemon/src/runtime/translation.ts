// 守护进程这一侧调用"翻斜杠命令的说明"（310 号票）：拉起一次性子进程 agent-child/translate-main.ts，stdin 送一行请求（模型和凭据、
// 翻成哪种语言、要翻的说明原文）、stdout 读一行结果，等它退出。模型只在子进程里调（ADR-0001、ADR-0004），守护进程自己不跑模型
// （ADR-0002），这里只转手；用量由调用方记账（purpose: translation）。凭据在请求里经 stdin 送达，不进子进程的环境变量。
// - 只交说明原文：每条说明单独一次模型调用，系统提示里只有怎么翻，用户消息就是那句原文（不带命令名、会话、别的上下文）；
// - 一条没翻成（模型出错、回的是空的）不影响别的：那一条交回 null，原因记在 errors（去掉凭据的内容），调用方显示原文。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import type { ModelSpec, UsageReport } from "./host-protocol.ts";
import { type RunOneShotOptions, runOneShotChild } from "./one-shot-child.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
/** 子进程入口（守护进程经 agent 管家的 runOneShot 拉起它：放进 Job 对象、只给白名单里的环境） */
export const SLASH_TRANSLATE_ENTRY = fileURLToPath(new URL(`./agent-child/translate-main${ownExt}`, import.meta.url));

/** 一批最多等多久：每条一次很短的模型调用（不开思考），一批最多 TRANSLATION_BATCH_MAX 条 */
export const TRANSLATION_TIMEOUT_MS = 2 * 60_000;

/** 一批最多几条（再多的排到下一批） */
export const TRANSLATION_BATCH_MAX = 20;

/** 一条原文最多交多长（skill 的说明按约定最长 1024 字，留些余量） */
export const TRANSLATION_TEXT_MAX = 2000;

export interface TranslationRequest {
  model: ModelSpec;
  /** provider id → API key（只在子进程的内存里用） */
  credentials: Record<string, string>;
  /** 翻成哪种语言：给模型看的名字（语言文件 _meta.json 的 modelName："中文"、"English"） */
  language: string;
  /** 要翻的说明原文 */
  texts: string[];
}

export interface TranslationResult {
  /** 和 texts 一一对应的译文；没翻成的是 null */
  texts: Array<string | null>;
  /** 每次模型调用的用量（没调成的没有） */
  usage: UsageReport[];
  /** 没翻成的原因（去掉了凭据的内容），给日志看 */
  errors: string[];
}

export type RunTranslationOptions = RunOneShotOptions;

/** 翻一批；子进程起不来、超时、整批做不了（模型目录里没有这个模型）抛错，原因前面写明是哪件事 */
export function runSlashTranslation(request: TranslationRequest, options: RunTranslationOptions): Promise<TranslationResult> {
  return runOneShotChild<TranslationResult>(SLASH_TRANSLATE_ENTRY, request, t("runtime.translation.label"), TRANSLATION_TIMEOUT_MS, options);
}
