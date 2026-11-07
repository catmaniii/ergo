// 自动压缩点（420）：一个 agent 这段会话的上下文到多少 token 就自动压缩。守护进程和 Web 共用的名字、范围和纯函数（不引用 TypeBox；
// 设置文件、接口的 schema 在 model-settings-schema.ts、agent-settings-schema.ts）。
//
// - 设置 · 模型里一个默认值（存在模型设置文件里，和默认模型、思考档位放一起；没写是 AUTO_COMPACT_DEFAULT）；
//   每个 agent 建好时跟随它，在自己的 ⚙ → 上下文里能单独设（按 agent id 记在同一个文件里），也能恢复跟随默认。
//   改默认值时跟随默认的一起变，单独设的不受影响。
// - 改了马上生效：守护进程在每轮结束（回复已经交出去）后比一下这段会话最近一次模型调用的上下文和这个 agent 的压缩点，超过就压缩
//   （走"现在压缩"那条路：秘书照带它的压缩指令），不等新会话；
// - 不挪用 pi 的 reserveTokens（它还决定摘要最多写多长：pi 里摘要输出上限是它的 0.8 倍）。pi 自己"窗口 − reserveTokens"的自动压缩照旧留着，
//   当最后一道——所以压缩点最多到那里（autoCompactLimit），设的比它大（比如换了个窗口小的模型）就按它算（clamped），⚙ 里写明；
// - 最少 AUTO_COMPACT_MIN（太小了压完马上又满）；
// - Claude Code、Codex 跑的 agent 自己管压缩，这一项对它们不起作用（⚙ 里灰掉）。
import { PI_COMPACTION_DEFAULTS } from "./agent-settings.ts";
import { formatNumber, t } from "./i18n/runtime.ts";

/** 没设过时的默认压缩点（2026-11-07 用户定的：70 万） */
export const AUTO_COMPACT_DEFAULT = 700_000;

/** 最少：再小压完马上又满（摘要加上最近原样留着的约 2 万 token 就快到了） */
export const AUTO_COMPACT_MIN = 50_000;

/** 存得下的最大：只挡明显写错的；按模型窗口的上限在用的时候夹（autoCompactLimit） */
export const AUTO_COMPACT_MAX = 10_000_000;

/** 压缩点从哪来：跟随设置 · 模型里的默认、在 ⚙ 里单独设的 */
export const AUTO_COMPACT_SOURCES = ["default", "own"] as const;
export type AutoCompactSource = (typeof AUTO_COMPACT_SOURCES)[number];

/** 一个 agent 设的压缩点：设置 · 模型里的默认（没写过就是 AUTO_COMPACT_DEFAULT）、单独设的（跟随默认时没有） */
export interface AutoCompactSetting {
  defaultAt: number;
  own?: number;
}

/** 这个模型的压缩点最多到哪：窗口减 pi 的 reserveTokens（pi 原来自动压缩的点，最后一道） */
export function autoCompactLimit(window: number, reserveTokens: number = PI_COMPACTION_DEFAULTS.reserveTokens): number {
  return Math.max(0, window - reserveTokens);
}

/** 生效的压缩点 */
export interface AutoCompactPoint {
  /** 用量超过它就压缩 */
  at: number;
  /** 跟随默认、单独设的 */
  source: AutoCompactSource;
  /** 设的值（跟随默认时是默认值），还没按模型夹过 */
  configured: number;
  /** 这个模型最多到哪；窗口还不知道时没有 */
  limit?: number;
  /** 设的比上限大，按上限算了 */
  clamped: boolean;
}

/**
 * 生效的压缩点：单独设的优先，没有就是默认；窗口知道时不超过 autoCompactLimit（窗口 − reserveTokens），超过的按它算（clamped）；
 * 窗口还不知道（这个模型守护进程起来以后还没跑过）时就是设的值
 */
export function effectiveAutoCompact(input: AutoCompactSetting & { window?: number | undefined; reserveTokens?: number | undefined }): AutoCompactPoint {
  const source: AutoCompactSource = input.own === undefined ? "default" : "own";
  const configured = input.own ?? input.defaultAt;
  if (input.window === undefined) return { at: configured, source, configured, clamped: false };
  const limit = autoCompactLimit(input.window, input.reserveTokens ?? PI_COMPACTION_DEFAULTS.reserveTokens);
  return configured > limit ? { at: limit, source, configured, limit, clamped: true } : { at: configured, source, configured, limit, clamped: false };
}

/**
 * 设的压缩点合不合规（设置页、⚙ 边改边查，守护进程存之前同一个函数）：要是整数、不少于 AUTO_COMPACT_MIN、不多于 AUTO_COMPACT_MAX；
 * 给了 model（⚙ 里，这个 agent 的模型窗口知道时）还不能超过这个模型的上限。合规回 undefined
 */
export function autoCompactProblem(at: number, model?: { window: number; reserveTokens?: number | undefined }): string | undefined {
  if (!Number.isInteger(at)) return t("protocol.autoCompact.notInteger");
  if (at < AUTO_COMPACT_MIN) return t("protocol.autoCompact.tooLow", { min: formatNumber(AUTO_COMPACT_MIN) });
  if (at > AUTO_COMPACT_MAX) return t("protocol.autoCompact.tooHigh", { max: formatNumber(AUTO_COMPACT_MAX) });
  if (model === undefined) return undefined;
  const reserve = model.reserveTokens ?? PI_COMPACTION_DEFAULTS.reserveTokens;
  const limit = autoCompactLimit(model.window, reserve);
  if (at > limit) return t("protocol.autoCompact.overLimit", { limit: formatNumber(limit), window: formatNumber(model.window), reserve: formatNumber(reserve) });
  return undefined;
}
