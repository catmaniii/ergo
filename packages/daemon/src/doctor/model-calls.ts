// 体检"二狗本身"里的"模型近况"（410）：读 agent 管家记的最近各轮结局（agent-manager/turn-log.ts），不发新请求。
// 判法（票 410）：
// - 最近 5 轮（不算用户停的）全失败（出错或超时）→ 坏了，从这一串失败的第一轮起；
// - 最近 15 分钟（不算用户停的）出错、超时的占到三成 → 注意；
// - 都没有调用记录（守护进程起来以后还没人调用过模型）→ 正常，写"最近没调用过"；
// - 别的正常：15 分钟里有调用的写几轮、几轮出错；没有的写上一轮是什么时候、什么结局。
// 事实里写出错的大意（服务商说太忙、500、限流、Key 不对……，按原文认），怎么修默认是"可能是服务商那边忙，等一会儿或在设置 · 模型里换一个"，
// Key、余额的问题换成核对 Key 那一句；动作跳到设置 · 模型。用户停的那一轮不算成也不算败（停了说明不了模型）。
// 纯函数：交回结果（DoctorFinding），事实参数里嵌的小句（出错的大意、上一轮的结局）按当前语言先拼好，整句由 doctor.ts 拼。
import { type DoctorMessage, doctorText, formatList } from "@ergo/protocol";
import type { TurnRecord } from "../agent-manager/turn-log.ts";
import { doctorTime } from "./auto.ts";
import type { DoctorFinding } from "./checks.ts";

/** 最近几轮全失败算坏了 */
export const MODEL_CALLS_STREAK = 5;
/** 看最近多久的出错比例（毫秒） */
export const MODEL_CALLS_WINDOW_MS = 15 * 60_000;
/** 出错占到几成算注意 */
export const MODEL_CALLS_WARN_RATIO = 0.3;
/** 事实里最多写几种出错的大意 */
const GISTS_MAX = 2;
/** 认不出来的出错原文最多带多少字 */
const OTHER_TEXT_MAX = 80;

/** 设置 · 模型 */
const MODELS_ROUTE = "#/more/models";

/** 出错的大意是哪一种（决定事实里怎么说、修法用哪一句） */
type GistKind = "busy" | "server" | "rate" | "auth" | "balance" | "network" | "overflow" | "timeout" | "other";

/** 出错原文 → 大意（按原文里的状态码、说法认；先认更具体的） */
export function modelErrorGist(record: Pick<TurnRecord, "outcome" | "error">): { kind: GistKind; message: DoctorMessage } {
  const text = record.error ?? "";
  const of = (kind: GistKind, params?: Record<string, string>): { kind: GistKind; message: DoctorMessage } => ({
    kind,
    message: { key: `doctor.modelCalls.gist.${kind}`, ...(params ? { params } : {}) },
  });
  if (record.outcome === "timeout") return of("timeout");
  if (/\b(503|529)\b|overload|server is busy|too busy|unavailable|繁忙|太忙|capacity/i.test(text)) return of("busy");
  if (/\b429\b|rate.?limit|too many requests|限流|频率/i.test(text)) return of("rate");
  if (/\b402\b|insufficient.{0,20}(balance|quota|credit)|余额|欠费|quota exceeded|billing/i.test(text)) return of("balance");
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?key|token|key)|authentication|api key/i.test(text)) return of("auth");
  if (/context.{0,20}(length|window|overflow)|maximum context|prompt is too long|too many tokens|上下文.{0,6}(超|太长)/i.test(text)) return of("overflow");
  const code = /\b(5\d\d)\b/.exec(text)?.[1];
  if (code !== undefined) return of("server", { code });
  if (/internal server error|bad gateway|gateway time-?out|server error/i.test(text)) return of("server", { code: "5xx" });
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network|连不上|网络/i.test(text)) return of("network");
  const short = text.length > OTHER_TEXT_MAX ? `${text.slice(0, OTHER_TEXT_MAX)}…` : text;
  return of("other", { text: short === "" ? "?" : short });
}

const failed = (record: TurnRecord) => record.outcome === "error" || record.outcome === "timeout";

/** 几轮失败的大意（最近的在前、去重，最多两种）写成一串 */
function gistsOf(records: readonly TurnRecord[]): { text: string; kinds: Set<GistKind> } {
  const seen = new Map<string, DoctorMessage>();
  const kinds = new Set<GistKind>();
  for (const record of records.toReversed()) {
    if (!failed(record)) continue;
    const gist = modelErrorGist(record);
    kinds.add(gist.kind);
    const key = `${gist.message.key}|${JSON.stringify(gist.message.params ?? {})}`;
    if (!seen.has(key)) seen.set(key, gist.message);
  }
  return { text: formatList([...seen.values()].slice(0, GISTS_MAX).map((message) => doctorText(message))), kinds };
}

/** 怎么修：Key、余额的问题核对 Key；对话太长看对话长度；别的是"服务商忙，等等或换一个" */
function fixFor(kinds: Set<GistKind>): DoctorMessage {
  if (kinds.has("auth") || kinds.has("balance")) return { key: "doctor.fix.modelCallsKey" };
  if (kinds.size === 1 && kinds.has("overflow")) return { key: "doctor.fix.modelCallsOverflow" };
  return { key: "doctor.fix.modelCalls" };
}

/** 一轮的结局写成一小句（上一轮是什么样） */
function outcomeText(record: TurnRecord): string {
  if (record.outcome === "ok") return doctorText({ key: "doctor.modelCalls.outcome.ok" });
  if (record.outcome === "stopped") return doctorText({ key: "doctor.modelCalls.outcome.stopped" });
  return doctorText({ key: "doctor.modelCalls.outcome.failed", params: { gist: doctorText(modelErrorGist(record).message) } });
}

/** 判一次：records 是管家记的（按先后），now 是此刻的毫秒时间戳 */
export function judgeModelCalls(records: readonly TurnRecord[], now: number): DoctorFinding {
  const counted = records.filter((record) => record.outcome !== "stopped");
  if (records.length === 0) return { level: "ok", fact: { key: "doctor.modelCalls.none" } };
  const action = { kind: "open" as const, route: MODELS_ROUTE };

  // 最近 5 轮全失败：坏了，从这一串失败的第一轮起
  const last = counted.slice(-MODEL_CALLS_STREAK);
  if (last.length === MODEL_CALLS_STREAK && last.every(failed)) {
    let start = counted.length - 1;
    while (start > 0 && failed(counted[start - 1]!)) start -= 1;
    const streak = counted.slice(start);
    const latest = streak.at(-1)!;
    const gists = gistsOf(streak);
    return {
      level: "error",
      fact: { key: "doctor.modelCalls.allFailed", params: { n: streak.length, gists: gists.text, time: doctorTime(new Date(latest.at).toISOString()), model: latest.model } },
      fix: fixFor(gists.kinds),
      since: new Date(streak[0]!.at).toISOString(),
      action,
    };
  }

  // 最近 15 分钟出错占到三成：注意
  const recent = counted.filter((record) => now - record.at <= MODEL_CALLS_WINDOW_MS);
  const bad = recent.filter(failed);
  if (recent.length > 0 && bad.length / recent.length >= MODEL_CALLS_WARN_RATIO) {
    const gists = gistsOf(bad);
    return {
      level: "warn",
      fact: { key: "doctor.modelCalls.failing", params: { total: recent.length, failed: bad.length, gists: gists.text } },
      fix: fixFor(gists.kinds),
      since: new Date(bad[0]!.at).toISOString(),
      action,
    };
  }
  if (recent.length > 0) {
    if (bad.length === 0) return { level: "ok", fact: { key: "doctor.modelCalls.fine", params: { total: recent.length } } };
    return { level: "ok", fact: { key: "doctor.modelCalls.someFailed", params: { total: recent.length, failed: bad.length, gists: gistsOf(bad).text } } };
  }
  // 15 分钟里没调用过：写上一轮是什么时候、什么结局
  const previous = records.at(-1)!;
  return { level: "ok", fact: { key: "doctor.modelCalls.quiet", params: { time: doctorTime(new Date(previous.at).toISOString()), outcome: outcomeText(previous) } } };
}
