// Looki 的"现在能查到的"（343 号票，数据源详情）：现查最近几天的时刻（含今天：今天的要过完这一天才导入，只有这里看得到），新的在前。
// 用按需查那一套（service.query：现查不存；Key 不认、限速照样记在内存里）；不写事件、不进素材、不进记忆、不经过模型。
// 照片视频不下载、不给链接（Looki 的下载链接一小时就失效），只写有没有。
import { type DataSourceDataItem, t } from "@ergo/protocol";
import type { DataSourceLiveAnswer, DataSourceLiveContext } from "../data-sources/api.ts";
import type { LookiMomentPayload } from "./api.ts";
import { addDays } from "./records.ts";
import type { LookiService } from "./service.ts";

/** 现查最近几天（一天一次请求，每个 Key 每分钟 60 次） */
export const LOOKI_LIVE_DAYS = 3;

/** 一个时刻 → 一条：没有标题的用描述当标题 */
function momentItem(m: LookiMomentPayload): DataSourceDataItem {
  const title = m.title === "" ? m.description : m.title;
  return {
    id: m.momentId,
    title,
    ...(m.place === undefined ? {} : { subtitle: m.place }),
    time: m.start,
    ...(m.end === undefined ? {} : { end: m.end }),
    ...(m.title !== "" && m.description !== "" ? { body: m.description } : {}),
    ...(m.media === undefined || m.media.length === 0 ? {} : { labels: m.media.map((kind) => t(`looki.live.media.${kind}`)) }),
  };
}

export async function lookiLive(service: LookiService, ctx: Pick<DataSourceLiveContext, "secrets" | "signal">): Promise<DataSourceLiveAnswer> {
  const today = service.today();
  const { moments } = await service.query({ from: addDays(today, -(LOOKI_LIVE_DAYS - 1)), to: today }, ctx.secrets, ctx.signal);
  return {
    scope: t("looki.live.scope", { days: LOOKI_LIVE_DAYS }),
    items: moments.toSorted((a, b) => Date.parse(b.start) - Date.parse(a.start)).map(momentItem),
  };
}
