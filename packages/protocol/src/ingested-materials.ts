// 存下的外部信息：秘书读到的外部信息（邮件、网页、日程、Looki 时刻、别的外部文字），用户这一轮要它存、或者任务书写明了要存时，
// 经秘书的 ingest_material 存进素材（不自动存）。工具只在素材频道上写一条 material_ingested 事件，素材由采集函数从事件产生
// （守护进程的 materials/ingested.ts）：来源等级是外部（不可信），不当用户本人说的话；正文只进检索。
// 本文件只是取值表和上限（不引用 TypeBox）：有哪几种、给人看的名字（跟着当前语言，取值时现查）、正文最长多少、建议几天后清理最多多少天。
// 事件负载和设置里点开时的样子在 ingested-materials-schema.ts。
import { tTable } from "./i18n/runtime.ts";

/** 存的是哪种：邮件、网页、日程、Looki 时刻、别的外部文字（笔记软件里的一条、文档里的一段……） */
export const INGESTED_INFO_KINDS = ["email", "web_page", "calendar", "looki", "note"] as const;
export type IngestedInfoKind = (typeof INGESTED_INFO_KINDS)[number];

/** 名字（记忆 · 素材的详情里写） */
export const INGESTED_INFO_KIND_LABEL: Readonly<Record<IngestedInfoKind, string>> = tTable({
  email: "protocol.ingested.kind.email",
  web_page: "protocol.ingested.kind.webPage",
  calendar: "protocol.ingested.kind.calendar",
  looki: "protocol.ingested.kind.looki",
  note: "protocol.ingested.kind.note",
});

/** 正文最多多少字节（UTF-8）：超了工具回错，让秘书缩短（摘要、只留要紧的段落）再存 */
export const INGESTED_TEXT_MAX_BYTES = 8 * 1024;

/** 标题最长多少字 */
export const INGESTED_TITLE_MAX = 300;

/** 出处（邮件的 message-id、网址、日程的事件 id……）最长多少字 */
export const INGESTED_SOURCE_REF_MAX = 2048;

/** 建议几天后清理：最多多少天（只是建议，到了在素材列表上标出来，不自动删） */
export const INGESTED_TTL_MAX_DAYS = 3650;

/** 一天多少毫秒（建议清理的时间 = 存的时间加 ttlDays 天） */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 建议清理的时刻（毫秒）：存的时间加 ttlDays 天；存的时间写法不对是 NaN */
export function ingestedCleanupAtMs(savedAt: string, ttlDays: number): number {
  return Date.parse(savedAt) + ttlDays * DAY_MS;
}
