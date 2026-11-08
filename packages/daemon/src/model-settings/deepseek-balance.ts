// DeepSeek 的余额来源（440）：GET <base>/user/balance，Authorization: Bearer <API Key>
// （文档 https://api-docs.deepseek.com/zh-cn/api/get-user-balance ，2026-11-08 读）。回
//   { is_available: boolean, balance_infos: [{ currency: "CNY" | "USD", total_balance, granted_balance, topped_up_balance }] }，
//   余额都是字符串（"110.00"）：total 是总的可用余额（含赠送和充值），granted 是没过期的赠送，topped_up 是充值的。
// - Key：设置里 DeepSeek 服务商的那个；自定义（OpenAI 兼容）服务商的接口地址是 api.deepseek.com 的，它的 Key 也算——
//   选着自定义时先用自定义的，不然先用 DeepSeek 的（deepseekBalanceKey）。查余额的地址一律是 DeepSeek 的根地址（测试里换成本机假服务）。
// - 出错照文档的错误码：401（Key 不对；403 同样算）、429 限流、5xx 服务商出错，别的状态码、回的不是文档里的样子算"看不懂"；
//   连不上算 network，到点中止由余额服务算超时（balance.ts）。说明里只写状态码，不带响应正文（DeepSeek 的 401 正文里有 Key 的末几位）。
// - 查余额不花钱，不记账。
// @i18n-ignore-file log：没查成的说明只进日志
import { CUSTOM_PROVIDER_ID, type ModelSettings, type ProviderBalanceAmount } from "@ergo/protocol";
import { DEEPSEEK_BASE_URL } from "../web/index.ts";
import { BalanceFailed, type BalanceReading, type BalanceSource } from "./balance.ts";
import { providerOf } from "./providers.ts";

/** 查余额的路径 */
export const DEEPSEEK_BALANCE_PATH = "/user/balance";

/** DeepSeek 接口的主机名：自定义服务商的地址是它的，Key 也能查余额 */
const DEEPSEEK_HOST = new URL(DEEPSEEK_BASE_URL).hostname;

/** 地址是不是 DeepSeek 的接口（https://api.deepseek.com、…/v1 这些都算） */
export function isDeepSeekUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.toLowerCase() === DEEPSEEK_HOST;
  } catch {
    return false;
  }
}

/**
 * 查余额用哪个 Key：DeepSeek 服务商的，和接口地址是 api.deepseek.com 的自定义服务商的；
 * 设置里选着自定义时先用自定义的，不然先用 DeepSeek 的。都没有是 undefined（不查）
 */
export function deepseekBalanceKey(settings: Pick<ModelSettings, "provider" | "custom">, credentials: Readonly<Record<string, string | undefined>>): string | undefined {
  const own = credentials.deepseek?.trim() || undefined;
  const custom = isDeepSeekUrl(settings.custom?.baseUrl) ? credentials[CUSTOM_PROVIDER_ID]?.trim() || undefined : undefined;
  return settings.provider === CUSTOM_PROVIDER_ID ? (custom ?? own) : (own ?? custom);
}

const isAmount = (v: unknown): v is string | number => (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v));

/** 文档里的响应换成余额；不是文档里的样子回 undefined */
export function parseDeepSeekBalance(json: unknown): BalanceReading | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const body = json as { is_available?: unknown; balance_infos?: unknown };
  if (typeof body.is_available !== "boolean" || !Array.isArray(body.balance_infos)) return undefined;
  const balances: ProviderBalanceAmount[] = [];
  for (const info of body.balance_infos as unknown[]) {
    if (typeof info !== "object" || info === null) return undefined;
    const i = info as Record<string, unknown>;
    if (typeof i.currency !== "string" || !isAmount(i.total_balance)) return undefined;
    const text = (v: unknown) => (isAmount(v) ? String(v).trim() : "0");
    balances.push({ currency: i.currency.trim().toUpperCase(), total: text(i.total_balance), granted: text(i.granted_balance), toppedUp: text(i.topped_up_balance) });
  }
  return { available: body.is_available, balances };
}

/** 状态码换成没成的原因 */
function problemOf(status: number): BalanceFailed {
  if (status === 401 || status === 403) return new BalanceFailed("key_invalid", `HTTP ${status}`, status);
  if (status === 429) return new BalanceFailed("rate_limited", `HTTP ${status}`, status);
  if (status >= 500) return new BalanceFailed("server", `HTTP ${status}`, status);
  return new BalanceFailed("bad_response", `HTTP ${status}`, status);
}

export interface DeepSeekBalanceOptions {
  /** 用哪个 Key（每次现取；没配是 undefined） */
  key: () => string | undefined;
  /** 不给是正式的 https://api.deepseek.com（测试里是本机的假服务） */
  baseUrl?: string | undefined;
}

export function deepseekBalanceSource(options: DeepSeekBalanceOptions): BalanceSource {
  const url = `${(options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "")}${DEEPSEEK_BALANCE_PATH}`;
  return {
    provider: "deepseek",
    get label() {
      return providerOf("deepseek")?.label ?? "DeepSeek";
    },
    key: options.key,
    async query(key, signal) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal });
      } catch (err) {
        // 超时由余额服务认（它置的中止信号），这里一律当连不上；说明不带地址以外的东西
        throw new BalanceFailed("network", err instanceof Error ? err.message : String(err));
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw problemOf(res.status);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new BalanceFailed("bad_response", "回的不是 JSON", res.status);
      }
      const reading = parseDeepSeekBalance(json);
      if (!reading) throw new BalanceFailed("bad_response", "回的不是文档里的样子", res.status);
      return reading;
    },
  };
}
