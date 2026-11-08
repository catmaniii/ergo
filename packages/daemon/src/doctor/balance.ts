// 体检"二狗本身"里的"DeepSeek 余额"（440）：只读余额服务内存里上一次查的结果（model-settings/balance.ts 的 cached()），
// 不另去查——平时体检不联网（checks.ts 的 cost 档），余额是打开消耗页、点刷新、秘书查的时候查的。登记在"模型近况"后面（core.ts）。
// - 没配能查余额的 Key：不适用；配了还没查过：不适用（写明打开消耗页时查）；
// - 服务商说用不了了（is_available: false）、或者每个币种都低于提醒线：注意，带"去看看"跳消耗页；
// - 上一次说 Key 不对：注意（修法去设置 · 模型核对；同一个 Key 以前查成过也算，Key 可能被停用了）；
// - 上一次没查成（超时、连不上……）、也没有查成过的：没查出来；查成过的照上一次查成的判；
// - 别的正常，事实写总余额和什么时候查的。
// 几个服务商（以后）时取最差的那个。
import { type BalanceProblem, balanceMoney, currencySymbol, type DoctorAction, type ProviderBalance, type ProviderBalanceView, t } from "@ergo/protocol";
import { doctorTime } from "./auto.ts";
import type { DoctorFinding } from "./checks.ts";

/** 消耗页（余额那一块在最上面） */
const USAGE_ROUTE = "#/more/usage";
const openUsage: DoctorAction = { kind: "open", route: USAGE_ROUTE };

/** 没查成的原因怎么说 */
const WHY_KEY: Readonly<Record<BalanceProblem, string>> = {
  key_invalid: "doctor.balance.why.key",
  rate_limited: "doctor.balance.why.rate",
  server: "doctor.balance.why.server",
  timeout: "doctor.balance.why.timeout",
  network: "doctor.balance.why.network",
  bad_response: "doctor.balance.why.bad",
};

/** 几级的先后：越后越差 */
const RANK: Readonly<Record<DoctorFinding["level"], number>> = { na: 0, ok: 1, unknown: 2, warn: 3, error: 4 };

/** 总余额写成"¥110.00"，几个币种用"、"连 */
function totalText(entry: ProviderBalance): string {
  return (entry.result?.balances ?? []).map((b) => balanceMoney(b.currency, b.total)).join(t("doctor.list.sep")) || "—";
}

/** 提醒线写成"¥10"（按回来的币种，几个用"、"连） */
function thresholdText(entry: ProviderBalance, lowBelow: Readonly<Record<string, number>>): string {
  const currencies = [...new Set((entry.result?.balances ?? []).map((b) => b.currency.toUpperCase()))].filter((c) => lowBelow[c] !== undefined);
  return currencies.map((c) => `${currencySymbol(c)}${lowBelow[c]}`).join(t("doctor.list.sep"));
}

/** 一个服务商的那一项 */
function judgeOne(entry: ProviderBalance, lowBelow: Readonly<Record<string, number>>): DoctorFinding {
  const name = entry.label;
  const { result, failure } = entry;
  // 上一次说 Key 不对：同一个 Key 以前查成过也算（Key 被停用了），先说它
  if (failure?.problem === "key_invalid") {
    const fact = { key: "doctor.balance.failed", params: { name, why: t(WHY_KEY.key_invalid), time: doctorTime(failure.at) } };
    return { level: "warn", fact, fix: { key: "doctor.fix.balanceKey", params: { name } }, action: { kind: "open", route: "#/more/models" } };
  }
  if (result) {
    const time = doctorTime(result.checkedAt);
    if (!result.available) return { level: "warn", fact: { key: "doctor.balance.unavailable", params: { name, amount: totalText(entry), time } }, fix: { key: "doctor.fix.balanceLow", params: { name } }, action: openUsage };
    if (result.low) return { level: "warn", fact: { key: "doctor.balance.low", params: { name, amount: totalText(entry), threshold: thresholdText(entry, lowBelow), time } }, fix: { key: "doctor.fix.balanceLow", params: { name } }, action: openUsage };
    return { level: "ok", fact: { key: "doctor.balance.fine", params: { name, amount: totalText(entry), time } } };
  }
  if (failure) {
    const fact = { key: "doctor.balance.failed", params: { name, why: t(WHY_KEY[failure.problem]), time: doctorTime(failure.at) } };
    return { level: "unknown", fact, fix: { key: "doctor.fix.balanceRetry" }, action: openUsage };
  }
  return { level: "na", fact: { key: "doctor.balance.notYet", params: { name } } };
}

/** "DeepSeek 余额"那一项：只看缓存，没配 Key 不适用 */
export function judgeBalance(view: ProviderBalanceView): DoctorFinding {
  const configured = view.providers.filter((entry) => entry.configured);
  if (configured.length === 0) return { level: "na", fact: { key: "doctor.balance.noKey", params: { name: view.providers[0]?.label ?? "DeepSeek" } } };
  return configured.map((entry) => judgeOne(entry, view.lowBelow)).reduce((worst, f) => (RANK[f.level] > RANK[worst.level] ? f : worst));
}
