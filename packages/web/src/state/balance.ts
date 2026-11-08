// 消耗页顶上的服务商余额（440，纯函数）：数据经 HTTP 取（GET /api/usage/balance，刷新是 POST），
// 这里给页面要的几样——能用 / 余额不多了 / 余额不足、"几分钟前查的"、没查成的说法、提醒线、刷新还要等几秒。
import { type BalanceProblem, currencySymbol, formatDate, type ProviderBalance, type ProviderBalanceResult, t } from "./protocol.ts";

/** 余额那一块的状态：能用、能用但不多了、服务商说用不了了 */
export type BalanceStatus = "available" | "low" | "unavailable";

export function balanceStatus(result: Pick<ProviderBalanceResult, "available" | "low">): BalanceStatus {
  if (!result.available) return "unavailable";
  return result.low ? "low" : "available";
}

/** 状态的说法 */
export function balanceStatusLabel(status: BalanceStatus): string {
  return status === "unavailable" ? t("pages.usage.balance.unavailable") : status === "low" ? t("pages.usage.balance.low") : t("pages.usage.balance.available");
}

/** 什么时候查的："刚查的""3 分钟前查的""2 小时前查的"，一天以上写日期时间 */
export function balanceAgo(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(ms) || ms < 60_000) return t("pages.usage.balance.justNow");
  if (ms < 3_600_000) return t("pages.usage.balance.minutesAgo", { count: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t("pages.usage.balance.hoursAgo", { count: Math.floor(ms / 3_600_000) });
  return t("pages.usage.balance.at", { time: formatDate(iso, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) });
}

const WHY_KEY: Readonly<Record<BalanceProblem, string>> = {
  key_invalid: "pages.usage.balance.why.key",
  rate_limited: "pages.usage.balance.why.rate",
  server: "pages.usage.balance.why.server",
  timeout: "pages.usage.balance.why.timeout",
  network: "pages.usage.balance.why.network",
  bad_response: "pages.usage.balance.why.bad",
};

/** 没查成的原因怎么说（name 是服务商的名字） */
export function balanceWhy(problem: BalanceProblem, name: string): string {
  return t(WHY_KEY[problem], { name });
}

/** 提醒线："¥10"（按回来的币种，几个用" / "连；认不得提醒线的币种不写） */
export function balanceLowLine(entry: Pick<ProviderBalance, "result">, lowBelow: Readonly<Record<string, number>>): string {
  const currencies = [...new Set((entry.result?.balances ?? []).map((b) => b.currency.toUpperCase()))].filter((c) => lowBelow[c] !== undefined);
  return currencies.map((c) => `${currencySymbol(c)}${lowBelow[c]}`).join(" / ");
}

/** 还要等几秒才能再刷新（防连点）；现在就能刷是 0 */
export function balanceRefreshWait(entry: Pick<ProviderBalance, "nextRefreshAt">, now: number): number {
  if (entry.nextRefreshAt === undefined) return 0;
  const ms = Date.parse(entry.nextRefreshAt) - now;
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}
