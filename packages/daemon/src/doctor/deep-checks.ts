// 深度体检（415）里二狗自己的几项判法：点了才跑、真试一遍（cost: deep，平时体检不跑）。
// - model-probe 模型（真发一句）：用设置里的默认模型发一句很短的话（输出封顶几十个 token，这次请求最多等 8 秒、服务商回 5xx / 429 不重试），
//   记耗时。没回成的按原话分几种（外面先例的写法：OpenClaw 的 models status --probe 也这么分桶），各配修法——
//   Key 不对、欠费 → 坏了；服务商忙（500 / 503 / 529、overloaded）、连不上、别的出错 → 坏了；限流、8 秒没回完、回了但首字超过 5 秒 → 注意。
//   原话的认法和"模型近况"（model-calls.ts 的 modelErrorGist）同一份。没配 Key 不发，算不适用（"模型的 Key"那一项已经是红的）。
// - database 数据库完整性：对 ergo.db 跑只读的 PRAGMA integrity_check（在 SQLite 的工作线程里跑，不卡守护进程），没问题是正常，
//   有一处不对就是坏了（修法：先别删数据目录，备份留底，再从好的备份恢复）。
// - 数据源"测一下"（judgeSourceProbe）：数据源登记了 probe 的（Looki 调 /me），用存着的 Key 连一下上游，各种没通配修法。
// 都是纯函数（交回 DoctorFinding，句子由 doctor.ts 按当前语言拼）；registerDeepDoctorChecks 由组合根接上真的模型设置、数据库文件。
import fs from "node:fs";
import { type DoctorMessage, doctorText, formatNumber, type ModelTestResult } from "@ergo/protocol";
import type { DataSourceProbeFailure, DataSourceProbeResult } from "../data-sources/api.ts";
import type { DoctorCheckRegistry, DoctorFinding } from "./checks.ts";
import { modelErrorGist } from "./model-calls.ts";

/** 测模型这一次请求最多等多久（毫秒；外面先例 OpenClaw 的 --probe 默认也是 8 秒） */
export const MODEL_PROBE_TIMEOUT_MS = 8_000;
/** 首字超过这么久（毫秒）算回得慢（注意） */
export const MODEL_PROBE_SLOW_MS = 5_000;
/**
 * 测模型这一项的总时限：一次性子进程起来（装 pi 的模型目录）也要时间，请求自己的 8 秒之外再留这么多；
 * 过了总时限才算"没查出来"（请求自己到点是"超时"那一种，有修法）
 */
export const MODEL_PROBE_CHECK_TIMEOUT_MS = MODEL_PROBE_TIMEOUT_MS + 25_000;
/** 数据源"测一下"最多等多久（毫秒） */
export const SOURCE_PROBE_TIMEOUT_MS = 8_000;
/** 完整性检查最多等多久（毫秒）：库大的话要一会儿；在工作线程里跑，不卡页面 */
export const DATABASE_CHECK_TIMEOUT_MS = 120_000;

/** 设置 · 模型 */
const MODELS_ROUTE = "#/more/models";
/** 设置 · 备份 */
const BACKUP_ROUTE = "#/more/backup";
/** 设置 · 数据源里某一个 */
const sourceRoute = (id: string) => `#/more/data-sources/${id}`;

/** 毫秒写成秒（一位小数，按当前语言） */
const seconds = (ms: number) => formatNumber(ms / 1000, { maximumFractionDigits: 1 });

/** 嵌进事实里的小句：整句由 doctor.ts 拼，参数里的小句先按当前语言拼好（和 model-calls.ts 一样） */
const tParams = (message: DoctorMessage) => doctorText(message);

/** 测模型没回成的几种（决定事实怎么说、修法用哪一句、算几级） */
export type ModelProbeFailure = "key" | "balance" | "rate" | "busy" | "timeout" | "network" | "other";

/** 没回成是哪一种：到点中止的是超时；别的按原话认（和"模型近况"同一份认法），500 / 503 都归"服务商忙" */
export function modelProbeFailure(result: Pick<ModelTestResult, "error" | "timedOut">): ModelProbeFailure {
  if (result.timedOut) return "timeout";
  const gist = modelErrorGist({ outcome: "error", error: result.error ?? "" }).kind;
  if (gist === "auth") return "key";
  if (gist === "balance") return "balance";
  if (gist === "rate") return "rate";
  if (gist === "busy" || gist === "server") return "busy";
  if (gist === "timeout") return "timeout";
  if (gist === "network") return "network";
  return "other";
}

/** 几种没回成算几级：限流、超时是注意（等等就好），别的都是坏了（现在用不了） */
const FAILURE_LEVEL: Readonly<Record<ModelProbeFailure, "warn" | "error">> = {
  key: "error",
  balance: "error",
  rate: "warn",
  busy: "error",
  timeout: "warn",
  network: "error",
  other: "error",
};

/** 认不出来的原话最多带多少字 */
const OTHER_TEXT_MAX = 120;

/** 没回成的那一句"为什么"（服务商忙的带上状态码） */
function failureWhy(kind: ModelProbeFailure, error: string): DoctorMessage {
  if (kind === "busy") {
    const code = /\b(5\d\d)\b/.exec(error)?.[1];
    return code === undefined ? { key: "doctor.modelProbe.why.busyNoCode" } : { key: "doctor.modelProbe.why.busy", params: { code } };
  }
  if (kind === "other") {
    const text = error.trim() === "" ? "?" : error.length > OTHER_TEXT_MAX ? `${error.slice(0, OTHER_TEXT_MAX)}…` : error;
    return { key: "doctor.modelProbe.why.other", params: { text } };
  }
  return { key: `doctor.modelProbe.why.${kind}` };
}

/** 判一次测模型：result 是这次的结果；undefined 是没配 Key（没发） */
export function judgeModelProbe(result: ModelTestResult | undefined): DoctorFinding {
  if (result === undefined) return { level: "na", fact: { key: "doctor.modelProbe.noKey" } };
  const action = { kind: "open" as const, route: MODELS_ROUTE };
  const model = result.modelId;
  if (result.ok) {
    const first = result.firstTokenMs ?? result.totalMs;
    const params = { model, first: seconds(first), total: seconds(result.totalMs) };
    if (first >= MODEL_PROBE_SLOW_MS) return { level: "warn", fact: { key: "doctor.modelProbe.slow", params }, fix: { key: "doctor.fix.modelProbeSlow" }, action };
    return { level: "ok", fact: { key: "doctor.modelProbe.ok", params } };
  }
  const kind = modelProbeFailure(result);
  if (kind === "timeout") {
    return { level: "warn", fact: { key: "doctor.modelProbe.timeout", params: { model, seconds: seconds(MODEL_PROBE_TIMEOUT_MS) } }, fix: { key: "doctor.fix.modelProbe.timeout" }, action };
  }
  const why = failureWhy(kind, result.error ?? "");
  return {
    level: FAILURE_LEVEL[kind],
    fact: { key: "doctor.modelProbe.failed", params: { model, why: tParams(why), seconds: seconds(result.totalMs) } },
    fix: { key: `doctor.fix.modelProbe.${kind}` },
    action,
  };
}

/** 文件大小写成"312 MB""1.2 GB" */
function sizeText(bytes: number): DoctorMessage {
  if (bytes >= 1024 ** 3) return { key: "doctor.size.gb", params: { n: formatNumber(bytes / 1024 ** 3, { maximumFractionDigits: 1 }) } };
  return { key: "doctor.size.mb", params: { n: formatNumber(Math.max(0.1, bytes / 1024 ** 2), { maximumFractionDigits: bytes < 10 * 1024 ** 2 ? 1 : 0 }) } };
}

/** 一次完整性检查的结果：不对的地方（空是没问题）、查了多久、库有多大（读不到是 undefined） */
export interface DatabaseCheck {
  problems: readonly string[];
  ms: number;
  bytes?: number;
}

/** 不对的地方最多写几个字 */
const PROBLEM_TEXT_MAX = 160;

/** 判完整性检查 */
export function judgeDatabase(check: DatabaseCheck): DoctorFinding {
  const size = check.bytes === undefined ? undefined : tParams(sizeText(check.bytes));
  if (check.problems.length === 0) {
    return size === undefined
      ? { level: "ok", fact: { key: "doctor.database.okNoSize", params: { seconds: seconds(check.ms) } } }
      : { level: "ok", fact: { key: "doctor.database.ok", params: { size, seconds: seconds(check.ms) } } };
  }
  const first = check.problems[0]!;
  return {
    level: "error",
    fact: { key: "doctor.database.bad", params: { count: check.problems.length, first: first.length > PROBLEM_TEXT_MAX ? `${first.slice(0, PROBLEM_TEXT_MAX)}…` : first } },
    fix: { key: "doctor.fix.database" },
    action: { kind: "open", route: BACKUP_ROUTE },
  };
}

/** 数据源"测一下"几种没通算几级：Key 不认、连不上是坏了；限速、到点没回、那边出错、回的不对是注意 */
const SOURCE_FAILURE_LEVEL: Readonly<Record<DataSourceProbeFailure, "warn" | "error" | "na">> = {
  auth: "error",
  network: "error",
  rate_limit: "warn",
  timeout: "warn",
  server: "warn",
  response: "warn",
  unconfigured: "na",
};

/**
 * 判数据源"测一下"：connected 是数据源页上连着没有（没连的不测，算不适用）；result 是这次的结果（没连时不给）
 */
export function judgeSourceProbe(sourceId: string, connected: boolean, result: (DataSourceProbeResult & { ms: number }) | undefined): DoctorFinding {
  if (!connected || result === undefined) return { level: "na", fact: { key: "doctor.sourceProbe.notConnected" } };
  const time = seconds(result.ms);
  if (result.ok) {
    return result.account === undefined
      ? { level: "ok", fact: { key: "doctor.sourceProbe.ok", params: { seconds: time } } }
      : { level: "ok", fact: { key: "doctor.sourceProbe.okAccount", params: { account: result.account, seconds: time } } };
  }
  const level = SOURCE_FAILURE_LEVEL[result.failure];
  // 文案键的各段是小驼峰（rate_limit → rateLimit）
  const segment = result.failure === "rate_limit" ? "rateLimit" : result.failure;
  const fact: DoctorMessage = { key: `doctor.sourceProbe.${segment}`, params: { reason: result.reason, seconds: time } };
  if (level === "na") return { level, fact };
  return { level, fact, fix: { key: `doctor.fix.sourceProbe.${segment}` }, action: { kind: "open", route: sourceRoute(sourceId) } };
}

/** 内核这两项要的（组合根接上真的，测试换成假的） */
export interface DeepDoctorSources {
  /** 用默认模型真发一句（带时限、不重试）；没配 Key 是 undefined（不发） */
  probeModel(timeoutMs: number): Promise<ModelTestResult | undefined>;
  /** 对 ergo.db 跑只读的完整性检查（工作线程里），交回不对的地方（空是没问题） */
  integrity(): Promise<readonly string[]>;
  /** ergo.db 在哪（读大小） */
  eventsDb: string;
}

/** 登记深度体检里二狗本身的两项（不带插件名，进"二狗本身"）；返回撤销 */
export function registerDeepDoctorChecks(registry: Pick<DoctorCheckRegistry, "register">, sources: DeepDoctorSources): () => void {
  const offs = [
    registry.register({
      id: "model-probe",
      title: "doctor.check.modelProbe.title",
      cost: "deep",
      timeoutMs: MODEL_PROBE_CHECK_TIMEOUT_MS,
      run: async () => judgeModelProbe(await sources.probeModel(MODEL_PROBE_TIMEOUT_MS)),
    }),
    registry.register({
      id: "database",
      title: "doctor.check.database.title",
      cost: "deep",
      timeoutMs: DATABASE_CHECK_TIMEOUT_MS,
      run: async () => {
        const started = Date.now();
        const problems = await sources.integrity();
        let bytes: number | undefined;
        try {
          bytes = fs.statSync(sources.eventsDb).size;
        } catch {
          bytes = undefined;
        }
        return judgeDatabase({ problems, ms: Date.now() - started, ...(bytes === undefined ? {} : { bytes }) });
      },
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
