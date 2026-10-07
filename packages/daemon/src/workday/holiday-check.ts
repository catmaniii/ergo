// 节假日数据每年要续（29 号票，规格第 21 节）：每年 12 月（默认 12 月 1 日，配置 holidayCheck）调度器上的内部作业
// 检查下一年两边的数据齐不齐，缺了就在待我处理里放一条"下一年节假日数据缺失"事项（不卡任务），写明年份和哪一边。
// 用户点"发起更新任务"，发起一个联网任务去官方来源取数据（秘书不能联网）；任务的交付件是和框架自带数据同一格式的
// 下一年数据，运行时校验后导入（calendar.ts 的 importHolidayFile），日历用上它，对应的缺失事项自动结束（归档）。
//
// - 作业按月登记（每月的那一天），只是检查的年份不同：到了检查的月份（及以后）查下一年，之前的月份查今年
//   ——12 月错过了（整个 12 月都没开机），1 月补跑时照样查出那一年缺数据。同一年同样的缺失已经提醒过（事项还在）就不再放。
// - 发起任务要 12 号票的任务发起：还没接上时，用户的选择记成内部频道上的一条 holiday_update_requested 事件
//   （任务书、年份、哪一边、官方来源、要开联网），由 startTask 接上之后照这份内容发起。
import {
  HOLIDAY_REGION_LABEL,
  HOLIDAY_UPDATE_ACTION,
  type HolidayRegion,
  type InboxItem,
  missingHolidayDataText,
  type NoticeInboxItem,
  type ReminderSchedule,
} from "@ergou/protocol";
import type { HolidayCheckConfig } from "../config/config.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import { INTERNAL_CHANNEL, type InternalJobs } from "../scheduler/internal-jobs.ts";
import type { WorkdayCalendarService } from "./calendar.ts";

/** 内部作业的名字 */
export const HOLIDAY_CHECK_JOB = "holiday_data_check";
/** 还没有任务发起时，"发起更新任务"记在内部频道上的事件 */
export const HOLIDAY_UPDATE_REQUESTED = "holiday_update_requested";

/** 缺失事项的 data */
export interface HolidayMissingData {
  year: number;
  regions: HolidayRegion[];
}

/** 要发起的更新任务：任务书和计划里要的东西 */
export interface HolidayUpdateTask {
  /** 来自哪条缺失事项 */
  itemId: string;
  title: string;
  year: number;
  regions: HolidayRegion[];
  /** 任务书 */
  brief: string;
  /** 官方来源（调研文件里列的） */
  sources: { region: HolidayRegion; title: string; url: string }[];
  /** 计划里的工具包要开联网 */
  network: true;
}

/** 调研文件 docs/research/13-holidays-sg-cn.md "更新方法"一节列的官方来源 */
export function officialSources(region: HolidayRegion, year: number): { title: string; url: string }[] {
  if (region === "sg") {
    return [
      { title: `MOM 新闻稿 "Public Holidays for ${year}"（补假写在脚注里）`, url: "https://www.mom.gov.sg/newsroom/press-releases" },
      { title: "MOM 公众假期页（列前一年、当年、下一年三年；它的 .ics 里没有周一补假）", url: "https://www.mom.gov.sg/employment-practices/public-holidays" },
      { title: `data.gov.sg 上由 MOM 管理的 "Public Holidays for ${year}" 数据集（含 Observed 行）`, url: "https://data.gov.sg/datasets" },
    ];
  }
  return [
    { title: `中国政府网"最新政策"：《国务院办公厅关于${year}年部分节假日安排的通知》`, url: "https://www.gov.cn/zhengce/zuixin/" },
    { title: "中国政府网最新政策的数据源（在 TITLE 里找\"节假日安排\"）", url: "https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json" },
  ];
}

/** 更新任务的任务书 */
export function holidayUpdateTask(itemId: string, year: number, regions: readonly HolidayRegion[]): HolidayUpdateTask {
  const sides = regions.map((r) => HOLIDAY_REGION_LABEL[r]).join("、");
  const sources = regions.flatMap((region) => officialSources(region, year).map((s) => ({ region, ...s })));
  const files = regions.map((r) => `${r}-${year}.json`).join("、");
  const brief = [
    `更新 ${year} 年${sides}的节假日数据，给二狗的个人工作日历用。只用官方一手来源，联网去取：`,
    ...sources.map((s) => `- ${HOLIDAY_REGION_LABEL[s.region]}：${s.title} ${s.url}`),
    "",
    `交付件：每一边一个 JSON 文件（${files}），放在本任务的产出区，格式和二狗自带的节假日数据一样：`,
    `{ "format": 1, "region": "sg" 或 "cn", "year": ${year}, "sources": [{ "title", "url"（https）, "published", "accessed" }], "days": [{ "date": "YYYY-MM-DD", "name", "kind" }] }`,
    "- 新加坡：kind 是 holiday（公众假期）或 observed（补假，按官方公布的日期，周日的假期顺延到周一；周六的不顺延）；",
    "- 国内：kind 是 holiday（官方公布的放假日期，\"X月X日至X日放假调休，共N天\"逐日展开，含因调休放假的工作日）或 makeup_workday（调休上班的日子）；每段天数要等于\"共N天\"；",
    "- 每天的日期和星期都和原文核对；还没公布就如实说没公布，不要自己推算。",
    "验收通过、任务完成后，运行时校验格式并导入，日历从此用上这一年的数据。",
  ].join("\n");
  return { itemId, title: `更新 ${year} 年${sides}节假日数据`, year, regions: [...regions], brief, sources, network: true };
}

export interface HolidayDataCheckOptions {
  calendar: WorkdayCalendarService;
  inbox: InboxService;
  store: EventStore;
  internalJobs: InternalJobs;
  clock: Clock;
  config: HolidayCheckConfig;
  log: (line: string) => void;
  /** 发起更新任务（12 号票的任务发起接上之后给）；不给时把要发起的任务记成内部频道上的事件 */
  startTask?: (task: HolidayUpdateTask) => void;
}

const isMissingNotice = (item: InboxItem): item is NoticeInboxItem & { data: HolidayMissingData } => item.kind === "notice" && item.notice === "holiday_data_missing" && !item.deleted;

/** 登记 12 月的检查、"发起更新任务"的反应、数据补上后缺失事项自动结束；返回停止的函数 */
export function startHolidayDataCheck(options: HolidayDataCheckOptions): () => void {
  const { calendar, inbox, store, internalJobs, clock, config, log } = options;
  const schedule: ReminderSchedule = { kind: "monthly", time: config.time, days: [config.day] };

  const check = () => {
    const now = new Date(clock.now());
    // 到了检查的月份查下一年；之前的月份查今年（12 月整个错过了，1 月补跑时也查得出来）
    const year = now.getMonth() + 1 >= config.month ? now.getFullYear() + 1 : now.getFullYear();
    const missing = calendar.current().missing(year);
    if (missing.length === 0) return;
    const notified = inbox.list().some((item) => isMissingNotice(item) && item.data.year === year && missing.every((r) => item.data.regions.includes(r)));
    if (notified) return;
    const sides = missing.map((r) => HOLIDAY_REGION_LABEL[r]).join("、");
    const data: HolidayMissingData = { year, regions: missing };
    inbox.add({
      kind: "notice",
      notice: "holiday_data_missing",
      title: `下一年节假日数据缺失：${missingHolidayDataText(year, missing)}`,
      body: `${year} 年${sides}的节假日数据还没有，工作日历在这一年${sides}那边先按周一到周五算（没有调休补班）。点"${HOLIDAY_UPDATE_ACTION}"发起一个联网任务，去官方来源取数据（秘书不能联网）。`,
      source: "工作日历",
      urgency: "non_blocking",
      actions: [HOLIDAY_UPDATE_ACTION],
      data,
    });
  };

  internalJobs.register({ name: HOLIDAY_CHECK_JOB, schedule, run: async () => check() });

  const offHandled = inbox.onNoticeHandled("holiday_data_missing", HOLIDAY_UPDATE_ACTION, (item) => {
    const data = item.data as HolidayMissingData;
    const task = holidayUpdateTask(item.id, data.year, data.regions);
    if (options.startTask) return options.startTask(task);
    // 任务发起（12 号票）还没接上：先记下要发起的任务
    store.append({ channel: INTERNAL_CHANNEL, type: HOLIDAY_UPDATE_REQUESTED, payload: task });
    log(`工作日历：用户要发起更新任务「${task.title}」（任务发起还没接上，先记在事件日志里）`);
  });

  // 数据补上了（导入了交付件）：对应的缺失事项自动结束
  const offChange = calendar.onChange(() => {
    for (const item of inbox.list()) {
      if (!isMissingNotice(item) || item.archived) continue;
      if (calendar.current().missing(item.data.year).some((r) => item.data.regions.includes(r))) continue;
      store.append(inbox.buildUpdate(item, { archived: true, title: `${item.title}（已补上）` }).event);
    }
  });

  return () => {
    offHandled();
    offChange();
  };
}
