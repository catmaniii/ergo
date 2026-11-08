// 秘书的只读工具 check_balance（440）：用户问"DeepSeek 还剩多少钱""余额还够吗""欠费了没有"时调它。
// 和消耗页顶上那一块同一份（model-settings/balance.ts）：几分钟内查过的用那一次（写明几分钟前查的），refresh 马上重查（防连点照旧）。
// 查余额不花钱、不记 token；Key 只在守护进程里用，结果里没有。只读、要联网、只往下拉（和地图的查询工具同样声明）。
// 排在 check_health 后面（secretary/tool-list.ts）。
// @i18n-ignore-file model：工具说明和结果给秘书（模型）看；工具的名字走 t()
import { type BalanceProblem, balanceMoney, currencySymbol, type ProviderBalance, type ProviderBalanceView, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { ProviderBalanceService } from "./balance.ts";

/** 工具名（秘书的工具清单、测试里引用） */
export const CHECK_BALANCE_TOOL = "check_balance";

/** 没查成的原因给模型的说法 */
const WHY: Readonly<Record<BalanceProblem, string>> = {
  key_invalid: "Key 不对（服务商不认这个 Key）",
  rate_limited: "被限流了（查得太频繁）",
  server: "服务商那边出错",
  timeout: "超时没回",
  network: "连不上服务商",
  bad_response: "服务商回的看不懂",
};

/** 多久以前：刚查的、N 分钟前、N 小时前 */
function agoText(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(ms) || ms < 60_000) return "刚查的";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前查的`;
  return `${Math.floor(ms / 3_600_000)} 小时前查的`;
}

/** 一个服务商写成一段 */
function entryText(entry: ProviderBalance, lowBelow: Readonly<Record<string, number>>, now: number): string {
  const lines: string[] = [];
  const { result, failure } = entry;
  if (failure) lines.push(`${entry.label}：这次没查成——${WHY[failure.problem]}${failure.status === undefined ? "" : `（HTTP ${failure.status}）`}。${result ? "下面是上一次查成的：" : ""}`);
  if (result) {
    const amounts = result.balances.map((b) => `${balanceMoney(b.currency, b.total)}（其中赠送 ${balanceMoney(b.currency, b.granted)}、充值 ${balanceMoney(b.currency, b.toppedUp)}）`);
    const threshold = [...new Set(result.balances.map((b) => b.currency.toUpperCase()))]
      .filter((c) => lowBelow[c] !== undefined)
      .map((c) => `${currencySymbol(c)}${lowBelow[c]}`)
      .join("、");
    const state = !result.available
      ? "服务商说余额不足、接口已经用不了了（要充值，或者先在设置 · 模型里换一个）"
      : result.low
        ? `能用，但余额不多了（低于 ${threshold} 算不多）`
        : "能用";
    lines.push(`${entry.label} 余额（${agoText(result.checkedAt, now)}）：${amounts.length > 0 ? amounts.join("；") : "没有余额记录"}。${state}。`);
    if (result.low && entry.topUpUrl) lines.push(`充值在 ${entry.label} 开放平台：${entry.topUpUrl}（消耗页顶上的「去充值」也能打开）。`);
  }
  return lines.join("\n");
}

/** 余额写成给秘书的一段话 */
export function balanceReport(view: ProviderBalanceView, now: number): string {
  const configured = view.providers.filter((entry) => entry.configured);
  if (configured.length === 0) {
    const names = view.providers.map((entry) => entry.label).join("、") || "DeepSeek";
    return `没配 ${names} 的 Key，查不了余额。告诉用户：在设置 · 模型里填了 ${names} 的 Key，消耗页顶上就能看余额。`;
  }
  return [...configured.map((entry) => entryText(entry, view.lowBelow, now)), "查余额不花钱、不算 token；消耗页顶上也能看、能刷新。"].join("\n");
}

/** 秘书的"查余额"：默认用几分钟内查过的那一次，refresh 马上重查 */
export function checkBalanceTool(balances: Pick<ProviderBalanceService, "view" | "refresh">, now: () => number = Date.now): HostTool {
  return defineHostTool({
    name: CHECK_BALANCE_TOOL,
    title: t("modelSettings.balance.toolTitle"),
    description:
      "查 DeepSeek 账户还剩多少钱：总余额、其中赠送和充值、能不能用（余额不足时接口用不了）。用户问「DeepSeek 还剩多少钱」「余额够不够」「欠费了没有」时用。" +
      "和消耗页顶上那一块是同一份：几分钟内查过的直接用那一次（结果里写几分钟前查的），refresh 写 true 马上重查（用户说「再查一下」「刷新」时）。" +
      "只读，查询不花钱、不算 token。没配 DeepSeek 的 Key 时查不了，结果里会说。",
    parameters: Type.Object(
      {
        refresh: Type.Optional(Type.Boolean({ description: "马上重查（不用几分钟内查过的那一次）；不写是 false" })),
      },
      { additionalProperties: false },
    ),
    readOnlyOrIdempotent: true,
    nature: "look",
    network: true,
    pullOnly: true,
    args: { refresh: { kind: "other", type: "boolean" } },
    run: async (args) => {
      const view = args.refresh === true ? await balances.refresh() : await balances.view();
      return { text: balanceReport(view, now()) };
    },
  });
}
