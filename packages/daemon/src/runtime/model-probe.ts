// 守护进程这一侧调用"模型探查"（设置里的"模型"）：拉起一次性子进程 agent-child/model-probe-main.ts，
// stdin 送一行请求（列出模型目录里某个服务商的模型，或者连通测试）、stdout 读一行结果，等它退出。模型目录只有子进程查得到
// （ADR-0001、ADR-0004），守护进程自己不跑模型（ADR-0002），这里只转手。凭据在请求里经 stdin 送达，不进子进程的环境变量。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import type { ModelProbeRequest, ModelProbeResult } from "./host-protocol.ts";
import { type RunOneShotOptions, runOneShotChild } from "./one-shot-child.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
const PROBE_ENTRY = fileURLToPath(new URL(`./agent-child/model-probe-main${ownExt}`, import.meta.url));

/** 探查最多等这么久：列目录很快；连通测试要等模型回第一个字（服务慢时也就十几秒） */
export const PROBE_TIMEOUT_MS = 60_000;

/** 请求自己带了时限（深度体检，415）时，子进程比它多等这么久：拉起子进程、装 pi 的模型目录的时间不算在请求的时限里 */
export const PROBE_STARTUP_MS = 20_000;

export type RunModelProbeOptions = RunOneShotOptions;

/**
 * 做一次模型探查；子进程出错、超时都抛错（连通测试不通不算出错，结果里 ok 为假）。
 * 出错原因前面写明是哪件事："连通测试超时（60 秒），结束了子进程"、"查模型目录的子进程退出了……"
 */
export function runModelProbe(request: ModelProbeRequest, options: RunModelProbeOptions): Promise<ModelProbeResult> {
  // 请求带了时限的（深度体检）：子进程就等时限加上起来的工夫，不等满 60 秒
  const limited = request.type === "ping" && request.timeoutMs !== undefined && options.timeoutMs === undefined ? { ...options, timeoutMs: request.timeoutMs + PROBE_STARTUP_MS } : options;
  return runOneShotChild<ModelProbeResult>(PROBE_ENTRY, request, request.type === "ping" ? t("runtime.probe.ping") : t("runtime.probe.catalog"), PROBE_TIMEOUT_MS, limited);
}
