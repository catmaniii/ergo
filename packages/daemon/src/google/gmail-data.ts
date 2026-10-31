// Google · Gmail 的"现在能查到的"（343 号票，数据源详情）：现连现查、只读（和按需查同一套：EXAMINE 打开、只取 BODY.PEEK，不标已读）。
// - 列表只给发件人、主题、时间（只取信头），点开一封才取正文（open，编号是列表给的）；
// - 敏感类别沿用 gmail-sensitive.ts 的规则：主题（点开的再加正文）里明显是财务、健康的标个小签，判不准的不标；只是提醒，什么都不记；
// - 不写事件、不进素材、不进记忆、不经过模型。邮件里的内容是别人写的，页面只当文字显示。
import { type DataSourceDataItem, nowIso, t } from "@ergo/protocol";
import type { DataSourceLiveAnswer, DataSourceLiveContext, DataSourceLiveQuery } from "../data-sources/api.ts";
import { type GmailListed, type GmailMessage, SEARCH_MAX, type GmailService } from "./gmail.ts";
import { sentMailSensitive } from "./gmail-sensitive.ts";
import { formatAddress, type MailAddress } from "./mime.ts";

/** 点开一封，页面上最多显示多少字正文（再长的写明没显示完） */
export const LIVE_TEXT_MAX = 50_000;

const people = (list: readonly MailAddress[]) => list.map(formatAddress).join(", ");
const subjectOf = (subject: string) => (subject.trim() === "" ? t("google.gmail.live.noSubject") : subject);
/** 明显是财务、健康的小签（规则同导入发出的邮件：gmail-sensitive.ts） */
const sensitiveLabels = (text: string) => {
  const labels = sentMailSensitive(text).map((category) => t(`dataSources.sensitive.${category}`));
  return labels.length === 0 ? {} : { labels };
};

function listedItem(m: GmailListed): DataSourceDataItem {
  return {
    id: m.id,
    title: subjectOf(m.subject),
    ...(m.from.length === 0 ? {} : { subtitle: people(m.from) }),
    ...(m.date ? { time: nowIso(m.date) } : {}),
    openable: true,
    ...sensitiveLabels(m.subject),
  };
}

function openedItem(m: GmailMessage): DataSourceDataItem {
  const text = m.text.length > LIVE_TEXT_MAX ? m.text.slice(0, LIVE_TEXT_MAX) : m.text;
  const attachments = m.attachments.filter((a) => !a.inline).map((a) => a.filename);
  const body = [
    text.trim() === "" ? t("google.gmail.live.noBody") : text,
    ...(m.text.length > LIVE_TEXT_MAX ? [t("google.gmail.live.cut", { shown: LIVE_TEXT_MAX, total: m.text.length })] : []),
    ...(m.partial ? [t("google.gmail.live.partial")] : []),
    ...(attachments.length === 0 ? [] : [t("google.gmail.live.attachments", { names: attachments.join(", ") })]),
  ].join("\n\n");
  return {
    id: m.id,
    title: subjectOf(m.subject),
    subtitle: t("google.gmail.live.fromTo", { from: people(m.from), to: people(m.to) }),
    ...(m.date ? { time: nowIso(m.date) } : {}),
    body,
    ...sensitiveLabels(`${m.subject}\n${m.text}`),
  };
}

export async function gmailLive(service: GmailService, query: DataSourceLiveQuery, ctx: DataSourceLiveContext): Promise<DataSourceLiveAnswer> {
  if (query.open !== undefined) return { items: [openedItem(await service.read(ctx, query.open, ctx.signal))] };
  const found = await service.search(ctx, { in: "all", limit: SEARCH_MAX }, ctx.signal);
  return {
    scope: t("google.gmail.live.scope", { count: found.messages.length, n: found.messages.length }),
    total: found.total,
    items: found.messages.map(listedItem),
    notes: found.fellBack ? [t("google.gmail.live.fellBack")] : [],
  };
}
