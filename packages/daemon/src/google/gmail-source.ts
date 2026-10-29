// Google · Gmail 这个数据源（298 号票，ADR-0027 的"数据源"贡献点）：写在 Google 插件的数据契约里（插件停用也认得：设置 · 数据源照样列出、
// 写"Google插件没启用"，断开并删照样删得掉导入的）。
// - 按需查默认开（issue 25：Gmail 默认按需查）：给秘书"搜 Gmail 邮件""读 Gmail 邮件"（gmail-tools.ts），现连现查、不存；
// - 导入默认关，就是"导入我发出的邮件"：开了以后每小时看一次"已发邮件"，新发的邮件写成 google_gmail_sent、采成"本人写的"素材
//   （303 号票的 dataSourceMaterial：text 是主题加去掉引用的正文，scene.people 是收件人）；收到的邮件不导入；
// - 导入的记录是 Google 插件自己的事件（events.ts）："共几条"由它数（导到哪的记号不算）；
// - 要插件在运行才能做的都经 active() 现取插件的服务（gmail.ts）。
// 敏感类别按每封写窄（gmail-sensitive.ts，主会话 2026-10-26 定）：正文里明显是财务、健康的标上对应类别，判不准的不标、其余 sensitive: []；
// 数据源登记这两类（页面上写明默认只记录、不用于推断）。
import { t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { GOOGLE_CHANNEL, GOOGLE_GMAIL_CURSOR, GOOGLE_GMAIL_SENT } from "./events.ts";
import { GOOGLE_GMAIL_SOURCE, type GmailService } from "./gmail.ts";
import { GMAIL_SENSITIVE } from "./gmail-sensitive.ts";
import { gmailTools } from "./gmail-tools.ts";

/** 导入我发出的邮件多久看一次（分钟） */
export const GMAIL_SENT_SYNC_MINUTES = 60;

export function googleGmailSource(active: () => GmailService): DataSource {
  return {
    id: GOOGLE_GMAIL_SOURCE,
    get title() {
      return t("google.gmail.title");
    },
    get summary() {
      return t("google.gmail.summary");
    },
    sensitive: GMAIL_SENSITIVE,
    usages: {
      query: { default: true },
      import: {
        default: false,
        schedule: { kind: "every", minutes: GMAIL_SENT_SYNC_MINUTES },
        get destination() {
          return t("google.gmail.destination");
        },
        syncOnConnect: true,
      },
    },
    records: [
      { channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_SENT },
      { channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_CURSOR },
    ],
    status: (ctx) => active().status(ctx),
    configure: (values, ctx) => active().configure(values, ctx),
    sync: (ctx) => active().syncSent(ctx),
    // 306：登录没通过（出错）后内核每小时叫一次，用存着的再登录一次
    recheck: (ctx) => active().recheck(ctx),
    disconnect: () => active().disconnect(),
    tools: (ctx) => gmailTools({ service: active, ctx }),
    count: () => active().sentCount(),
  };
}
