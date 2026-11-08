// 消耗页顶上的余额（440）的假数据：和守护进程的 GET /api/usage/balance 同一个形状，数是编的。
// 地址带 ?demo-balance= 看别的样子：low（余额不多了）、out（余额不足：服务商说用不了了）、none（没配 Key）、
// failed（这次没查成，留着上次查到的）。英文界面的金额照约定换成美元（fakeMoney）。
// 刷新：原型里等一下再回，查的时刻换成现在，10 秒内不让再刷（和守护进程的防连点一样）。
import { nowIso, type ProviderBalance, type ProviderBalanceView } from "../state/index.ts";
import { demoParam } from "./fake-connection.ts";
import { fakeMoney, isEnglishContent } from "./fake-content.ts";

/** 原型里刷新要等多久（毫秒），看得到"正在查…" */
export const FAKE_BALANCE_DELAY_MS = 600;
/** 刷新之后多久不让再刷（和守护进程的 BALANCE_REFRESH_GAP_MS 一样） */
const FAKE_REFRESH_GAP_MS = 10_000;

/** 编的余额（元）：平常、不多了、用不了了 */
const AMOUNTS = {
  normal: { total: 86.4, granted: 6.4, toppedUp: 80 },
  low: { total: 7.35, granted: 0, toppedUp: 7.35 },
  out: { total: 0, granted: 0, toppedUp: 0 },
} as const;

const money = (yuan: number) => fakeMoney(yuan).toFixed(2);

export class FakeBalance {
  /** 上一次查的时刻：打开原型时算 3 分钟前查的 */
  private checkedAt = Date.now() - 3 * 60_000;
  /** 上一次点刷新的时刻 */
  private refreshedAt: number | undefined;

  view(now = Date.now()): ProviderBalanceView {
    const mode = demoParam("demo-balance");
    const currency = isEnglishContent() ? "USD" : "CNY";
    const lowBelow = { CNY: 10, USD: 1.5 };
    // 充值页是 DeepSeek 开放平台真的地址（公开的，和守护进程的 DEEPSEEK_TOP_UP_URL 一样）
    const base = { provider: "deepseek", label: "DeepSeek", topUpUrl: "https://platform.deepseek.com/top_up" };
    if (mode === "none") return { providers: [{ ...base, configured: false }], lowBelow };
    const kind = mode === "low" ? "low" : mode === "out" ? "out" : "normal";
    const a = AMOUNTS[kind];
    const entry: ProviderBalance = {
      ...base,
      configured: true,
      result: {
        available: kind !== "out",
        balances: [{ currency, total: money(a.total), granted: money(a.granted), toppedUp: money(a.toppedUp) }],
        checkedAt: nowIso(new Date(mode === "failed" ? this.checkedAt - 25 * 60_000 : this.checkedAt)),
        low: kind !== "normal",
      },
      ...(mode === "failed" ? { failure: { problem: "timeout" as const, at: nowIso(new Date(this.checkedAt)) } } : {}),
      ...(this.refreshedAt !== undefined && this.refreshedAt + FAKE_REFRESH_GAP_MS > now ? { nextRefreshAt: nowIso(new Date(this.refreshedAt + FAKE_REFRESH_GAP_MS)) } : {}),
    };
    return { providers: [entry], lowBelow };
  }

  /** 刷新：等一下，查的时刻换成现在（10 秒内再点不重查） */
  async refresh(): Promise<ProviderBalanceView> {
    await new Promise((resolve) => setTimeout(resolve, FAKE_BALANCE_DELAY_MS));
    const now = Date.now();
    if (this.refreshedAt === undefined || now - this.refreshedAt >= FAKE_REFRESH_GAP_MS) {
      this.refreshedAt = now;
      this.checkedAt = now;
    }
    return this.view(now);
  }
}
