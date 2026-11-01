// ergo notify <事件名> [--data <JSON>]（ADR-0043）：项目的服务报事件，叫醒等这个事件的任务。给服务用的，不是给人操作二狗的（用户定过不用命令行操作二狗）。
// 地址和凭证从环境变量取（服务上线时二狗注入）；发完就走，不等负责人做完。退出码：
//   0 报上了；1 二狗拒了（凭证、事件名没人等、任务暂停着、超限速、数据太大，原因写在 stderr）；
//   2 用法不对（没写事件名、--data 不是 JSON、环境变量不在：不是在上线的服务里跑）；3 连不上二狗（守护进程停着）。
// 连不上时不缓存、不重试：这次就是没报上，要不要重报由服务自己定。
import { type HttpErrorBody, SERVICE_NOTIFY_URL_ENV, SERVICE_TOKEN_ENV, type ServiceEventBody, type ServiceEventReply, t } from "@ergo/protocol";
import type { CliContext } from "./context.ts";

export const NOTIFY_EXIT = { ok: 0, refused: 1, usage: 2, unreachable: 3 } as const;

/** 等二狗回话最多多久（接口不等负责人做完，正常一下就回） */
const NOTIFY_TIMEOUT_MS = 15_000;

export async function cmdNotify(ctx: CliContext, name: string | undefined, dataText: string | true | undefined): Promise<number> {
  if (name === undefined || name.trim() === "") {
    ctx.io.err(t("cli.notify.usage"));
    return NOTIFY_EXIT.usage;
  }
  let data: unknown;
  if (dataText === true) {
    ctx.io.err(t("cli.notify.dataMissing"));
    return NOTIFY_EXIT.usage;
  }
  if (dataText !== undefined) {
    try {
      data = JSON.parse(dataText);
    } catch (err) {
      ctx.io.err(t("cli.notify.badData", { detail: err instanceof Error ? err.message : String(err) }));
      return NOTIFY_EXIT.usage;
    }
  }
  const url = ctx.env[SERVICE_NOTIFY_URL_ENV]?.trim();
  const token = ctx.env[SERVICE_TOKEN_ENV]?.trim();
  if (!url || !token) {
    ctx.io.err(t("cli.notify.noEnv", { url: SERVICE_NOTIFY_URL_ENV, token: SERVICE_TOKEN_ENV }));
    return NOTIFY_EXIT.usage;
  }
  const body: ServiceEventBody = { event: name.trim(), ...(data === undefined ? {} : { data }) };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
  } catch {
    ctx.io.err(t("cli.notify.unreachable", { url }));
    return NOTIFY_EXIT.unreachable;
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as HttpErrorBody).message;
    } catch {
      // 不是二狗回的 JSON：原样写
    }
    ctx.io.err(t("cli.notify.refused", { status: response.status, message }));
    return NOTIFY_EXIT.refused;
  }
  const reply = JSON.parse(text) as ServiceEventReply;
  ctx.io.out(t("cli.notify.ok", { name: reply.event, runs: reply.runs.map((r) => r.runId).join(", ") }));
  return NOTIFY_EXIT.ok;
}
