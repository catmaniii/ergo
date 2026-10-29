// 守护进程这一侧调用"按二狗自己的事件记录另起一次生成"（293 号票；309 号票加了范围审视）：拉起一次性子进程 agent-child/recorded-generation-main.ts，
// stdin 送一行请求（要做什么、模型和凭据、整理好的那段会话）、stdout 读一行结果，等它退出。模型只在子进程里调（ADR-0001、ADR-0004），
// 守护进程自己不跑模型（ADR-0002），这里只转手；用量由调用方（agent 管家）记账。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import type { RecordedGenerationRequest, RecordedGenerationResult } from "./host-protocol.ts";
import { type RunOneShotOptions, runOneShotChild } from "./one-shot-child.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
const RECORDED_GENERATION_ENTRY = fileURLToPath(new URL(`./agent-child/recorded-generation-main${ownExt}`, import.meta.url));

/** 没给超时时最多等多久（一次模型调用，pi 自己的重试在里面） */
export const RECORDED_GENERATION_TIMEOUT_MS = 5 * 60_000;

export type RunRecordedGenerationOptions = RunOneShotOptions;

/** 做一次另起的生成；子进程出错（模型出错、没写成）、超时都抛错，原因前面写明是哪件事 */
export function runRecordedGeneration(request: RecordedGenerationRequest, options: RunRecordedGenerationOptions): Promise<RecordedGenerationResult> {
  return runOneShotChild<RecordedGenerationResult>(RECORDED_GENERATION_ENTRY, request, labelOf(request), RECORDED_GENERATION_TIMEOUT_MS, options);
}

/** 出错说明里写的是哪件事（"写分支摘要超时（300 秒），结束了子进程"、309 号票的"做范围审视……"） */
function labelOf(request: RecordedGenerationRequest): string {
  switch (request.task.kind) {
    case "branch_summary":
      return t("runtime.recorded.branchSummary");
    case "scope_review":
      return t("runtime.recorded.scopeReview");
  }
}
