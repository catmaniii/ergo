// Google 插件（297 号票，issue 25 生活数据源第一波；ADR-0027 的"数据源"贡献点）：接 Google 账号里的数据，一个插件、几个数据源。
// 297 号票做了日历订阅（Google · 日历：私密 iCal 地址，只读，不用建 Google Cloud 项目——调研 37、39）；298 号票加了 Gmail
// （Google · Gmail：应用专用密码 + 只读 IMAP，按需查；可选导入我发出的邮件）；301 号票加了联系人（Google · 联系人：用户导出的 vCard
// 放进导入文件夹，进档案候选）。网页那一半是 packages/web/src/plugins/google/（同名，一起启停：设置 · 数据源里 Google · 日历、
// Google · Gmail 下面填设置的那两块，Google · 联系人下面怎么导出的那一块）。
// - 数据契约：数据源 Google · 日历（calendar-source.ts：同步来的日程经数据源的 calendar() 交给日历插件当外部日历显示，299 号票定的路）、
//   Google · Gmail（gmail-source.ts）、Google · 联系人（contacts-source.ts：认导入文件夹里的 vCard，交给个人档案的候选核对卡，
//   299 号票手机通讯录选人同一条路）；导入的你发出的邮件采成"本人写的"素材（采集规则在下面），彻底删除时主题、正文、收件人换掉；
//   移除时连数据删：同步来的日历事件、日历的名字、导入的你发出的邮件、导入的联系人记录（google 频道的几类事件），和密钥区里的
//   私密地址、Gmail 地址和密码；
// - 装配：日历订阅的服务（calendar-feeds.ts：存地址、测试连接、同步、展开）、Gmail 的服务（gmail.ts：存设置、测试连接、搜、读、导入）、
//   联系人导入的服务（contacts.ts：解析、只记没交过的、一批一批交给档案候选）；订阅事件存储里的卡片——上一批联系人合进的候选核对卡
//   处理完了接着交下一批，插件起来时补上停着时错过的；
// - 依赖：事件存储、时钟、卡片、个人档案的收候选（KERNEL.personalFiles，联系人用）；日历插件是可选依赖（wants）——只用来在数据源页上
//   写"日历插件没启用"，日历停了 Google 照常同步、按需查照常；
// - 给秘书的"查 Google 日历""搜 Gmail 邮件""读 Gmail 邮件"由内核替数据源登记（按需查开着、插件在运行时才有），插件自己不经 ctx.agent
//   登记工具；系统提示里不讲它们。
// 测试里不连 Google：拉地址用注入的 fetch 或本机假服务（createGooglePlugin 的 fetch、timeoutMs），IMAP 连本机的假服务（imap：地址、端口、
// 测试证书）。
import { type CardEventPayload, CHANNELS, EVENT_TYPES, type EventType, PURGED_TEXT, t } from "@ergo/protocol";
import { CALENDAR } from "../calendar/api.ts";
import { dataSourceMaterial } from "../data-sources/material.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { clockIso } from "../scheduler/clock.ts";
import { GOOGLE } from "./api.ts";
import { createGoogleCalendar, GOOGLE_CALENDAR_SOURCE } from "./calendar-feeds.ts";
import { googleCalendarSource } from "./calendar-source.ts";
import { GOOGLE_CONTACT, GOOGLE_CONTACTS_OFFERED } from "./contacts-events.ts";
import { googleContactsSource } from "./contacts-source.ts";
import { createGoogleContacts } from "./contacts.ts";
import { GOOGLE_CALENDAR_FEED, GOOGLE_CALENDAR_ITEM, GOOGLE_CHANNEL, GOOGLE_GMAIL_CURSOR, GOOGLE_GMAIL_SENT, type GoogleGmailSentPayload } from "./events.ts";
import { createGmail, GOOGLE_GMAIL_SOURCE } from "./gmail.ts";
import { googleGmailSource } from "./gmail-source.ts";
import type { ImapEndpoint } from "./imap.ts";

export interface GooglePluginOptions {
  /** 拉地址用的 fetch（测试注入；不给用全局的） */
  fetch?: typeof fetch;
  /** 拉一个地址最多等多久（毫秒，测试调短） */
  timeoutMs?: number;
  /** Gmail 的 IMAP 连哪（测试换成本机的假服务和测试证书；不给是 imap.gmail.com:993） */
  imap?: ImapEndpoint;
  /** IMAP 多久没回应算超时（毫秒，测试调短） */
  imapTimeoutMs?: number;
}

/** 导入的你发出的邮件采成素材的规则名（素材 id 由它算，定了别改） */
const GMAIL_SENT_MATERIAL = "google-gmail-sent";

/** 插件起来时补交下一批联系人：个人档案还没接上时隔多久再试、最多试几次 */
const CATCH_UP_DELAY_MS = 2000;
const CATCH_UP_TRIES = 10;

export function createGooglePlugin(options: GooglePluginOptions = {}): PluginDefinition {
  return {
    name: "google",
    get title() {
      return t("google.plugin.title");
    },
    get summary() {
      return t("google.plugin.summary");
    },
    get brings() {
      return { tools: [t("google.calendar.tool"), t("google.gmail.tool.search"), t("google.gmail.tool.read")] };
    },
    needs: [KERNEL.store, KERNEL.clock, KERNEL.cards, KERNEL.personalFiles],
    wants: [CALENDAR],
    provides: [GOOGLE],
    contracts(ctx) {
      ctx.dataSources.register(googleCalendarSource(() => ctx.active(GOOGLE).calendar));
      const gmail = googleGmailSource(() => ctx.active(GOOGLE).gmail);
      ctx.dataSources.register(gmail);
      ctx.dataSources.register(googleContactsSource(() => ctx.active(GOOGLE).contacts));
      // 导入的你发出的邮件 → "本人写的"素材（303 号票的写法；只看事件本身）；敏感类别按每封写窄（同步时按关键词判断、写进负载）
      ctx.materialSources.register({
        name: GMAIL_SENT_MATERIAL,
        eventType: GOOGLE_GMAIL_SENT as EventType,
        capture: (event) => {
          const p = event.payload as GoogleGmailSentPayload;
          if (!p.text) return [];
          return [dataSourceMaterial(gmail, { kind: "own_writing", text: p.text, time: p.at, scene: { people: p.to }, sensitive: p.sensitive ?? [], recordId: p.id })];
        },
      });
      // 主题、正文、收件人都是用户的数据，一起换掉
      ctx.purge.register({
        eventType: GOOGLE_GMAIL_SENT,
        rewrite: (event) => {
          const p = event.payload as GoogleGmailSentPayload;
          return { ...p, subject: PURGED_TEXT, to: [], text: PURGED_TEXT } satisfies GoogleGmailSentPayload;
        },
      });
      ctx.removal.declare({
        get deletes() {
          return [t("google.plugin.purge.calendar"), t("google.plugin.purge.addresses"), t("google.plugin.purge.gmail"), t("google.plugin.purge.gmailPassword"), t("google.plugin.purge.contacts")];
        },
        get keeps() {
          return [t("google.plugin.keep.chat"), t("google.plugin.keep.materials"), t("google.plugin.keep.files"), t("google.plugin.keep.backup")];
        },
        events: [
          { channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_ITEM },
          { channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_FEED },
          { channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_SENT },
          { channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_CURSOR },
          { channel: GOOGLE_CHANNEL, type: GOOGLE_CONTACT },
          { channel: GOOGLE_CHANNEL, type: GOOGLE_CONTACTS_OFFERED },
        ],
        files: [`secrets/data-sources/${GOOGLE_CALENDAR_SOURCE}.json`, `secrets/data-sources/${GOOGLE_GMAIL_SOURCE}.json`],
      });
    },
    setup(ctx) {
      const store = ctx.use(KERNEL.store);
      const clock = ctx.use(KERNEL.clock);
      const calendar = createGoogleCalendar({
        store,
        clock,
        // 可选依赖：现取（日历插件停了是 undefined）
        calendarOn: () => ctx.optional(CALENDAR) !== undefined,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        log: (line) => ctx.log(line),
      });
      const gmail = createGmail({
        store,
        clock,
        ...(options.imap ? { endpoint: options.imap } : {}),
        ...(options.imapTimeoutMs === undefined ? {} : { timeoutMs: options.imapTimeoutMs }),
        log: (line) => ctx.log(line),
      });
      const contacts = createGoogleContacts({
        store,
        now: () => clockIso(clock),
        personalFiles: ctx.use(KERNEL.personalFiles),
        cards: ctx.use(KERNEL.cards),
        log: (line) => ctx.log(line),
      });
      ctx.provide(GOOGLE, { calendar, gmail, contacts });
      // 上一批联系人合进的候选核对卡处理完了（写了、都不用、作废了），接着交下一批
      ctx.effect(() =>
        store.onAppend((event) => {
          if (event.channel === CHANNELS.cards && event.type === EVENT_TYPES.card) contacts.onCard((event.payload as CardEventPayload).card);
        }),
      );
      // 插件停着时那张卡处理了的，起来时补交；守护进程刚起来时个人档案还没接上，过一会儿再试
      let retry: ReturnType<typeof setTimeout> | undefined;
      let tries = 0;
      const catchUp = () => {
        retry = undefined;
        try {
          contacts.offerNext();
        } catch (err) {
          tries += 1;
          if (tries > CATCH_UP_TRIES) {
            ctx.log(`Google 联系人：补交下一批出错：${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          retry = setTimeout(catchUp, CATCH_UP_DELAY_MS);
          retry.unref?.();
        }
      };
      ctx.lifecycle({
        start: catchUp,
        stop: () => {
          if (retry !== undefined) clearTimeout(retry);
        },
      });
    },
  };
}

export const googlePlugin = createGooglePlugin();
