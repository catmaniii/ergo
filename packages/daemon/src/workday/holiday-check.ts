// 节假日数据每年要续（29 号票，规格第 21 节）：
// - 检查：调度器上的内部作业 holiday_data_check，每月 holidayCheck.dayOfMonth 那天跑一次。到了 holidayCheck.fromMonth
//   （默认 12 月）及以后查下一年，之前的月份查今年——整个 12 月都没开机的话，1 月补跑时照样查得出那一年缺数据。
//   缺了就在待我处理里放一条"节假日数据缺失"事项（不卡任务），写明是哪一年、哪一边；同一年同样的缺失已经有事项就不再放。
// - 发起更新任务：用户在事项上点"发起更新任务"，用 12 号票的任务发起建一个任务（用户发起，规划中，出现在看板上），
//   同一事务记下"这个任务是哪一年哪一边的更新"（内部频道的 holiday_update_task），再写好任务书交给任务的维护者：
//   年份、哪一边、调研文件里列的官方来源、交付件的格式；计划的工具包要开联网，照常在计划卡上确认。
// - 导入交付件：任务完成后（13 号票的任务完成回调，daemon.ts 接到 taskCompleted）：任务的工作目录（产出区 outputs/<任务 id>/）
//   里的 <地区>-<年>.json 逐个交给 workdayCalendar.importHolidayFile（运行时校验格式后导入，工作日历用上它）；数据补上了，
//   对应的缺失事项自动结束（归档）；没交的、不对的在待我处理里放一条"节假日数据导入有问题"说明（不卡任务）。
//   任何 agent 都不直接写节假日数据（配置区是受保护区域）。
import fs from "node:fs";
import path from "node:path";
import {
  HOLIDAY_REGION_LABEL,
  HOLIDAY_UPDATE_ACTION,
  holidayFileName,
  type HolidayRegion,
  type HolidayYear,
  type InboxItem,
  missingHolidayDataText,
  type NoticeInboxItem,
  type ReminderSchedule,
  type TaskBrief,
} from "@ergou/protocol";
import type { HolidayCheckConfig } from "../config/config.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import { INTERNAL_CHANNEL, type InternalJobs } from "../scheduler/internal-jobs.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { WorkdayCalendarService } from "./calendar.ts";

/** 内部作业的名字 */
export const HOLIDAY_CHECK_JOB = "holiday_data_check";
/** 内部频道上的事件：用户发起的这个任务是哪一年哪一边的节假日数据更新（任务完成后据此导入交付件） */
export const HOLIDAY_UPDATE_TASK = "holiday_update_task";

/** 缺失事项的 data */
export interface HolidayMissingData {
  year: number;
  regions: HolidayRegion[];
}

/** holiday_update_task 事件的负载 */
export interface HolidayUpdateTaskPayload extends HolidayMissingData {
  taskId: string;
  /** 来自哪条缺失事项 */
  itemId: string;
}

/** 导入一个更新任务交付件的结果 */
export interface HolidayImportResult {
  imported: HolidayYear[];
  /** 没交、交了但不对的（说明给用户看） */
  problems: string[];
}

/** 官方来源（调研文件 docs/research/13-holidays-sg-cn.md "来源"和"更新方法"两节），写进任务书 */
export function officialSources(region: HolidayRegion, year: number): string[] {
  if (region === "sg") {
    return [
      `新加坡人力部（MOM）新闻稿 "Public Holidays for ${year}"，网址形如 https://www.mom.gov.sg/newsroom/press-releases/<发布那年>/<MMDD>-public-holidays-for-${year}；补假写在脚注里（"Monday, … will be a public holiday."）`,
      "用 MOM 公众假期页 https://www.mom.gov.sg/employment-practices/public-holidays 核对（列前一年、当年、下一年三年；它给的 .ics 里没有周一补假）",
      `data.gov.sg 上由 MOM 管理的 "Public Holidays for ${year}" 数据集（holiday 字段含 "… (Observed)" 行），机读接口 https://data.gov.sg/api/action/datastore_search?resource_id=<数据集 ID>（ID 每年不同，在 data.gov.sg 上按标题搜）`,
      "公众假期落在周日时次日补休（observed），落在周六的不顺延；新闻稿给伊斯兰节日标了 Subject to confirmation 的，节前再核对；年中留意临时加的公众假期",
    ];
  }
  return [
    `《国务院办公厅关于${year}年部分节假日安排的通知》（国办发明电），在中国政府网"最新政策" https://www.gov.cn/zhengce/zuixin/ 找；程序化检查读 https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json，在 TITLE 里找"节假日安排"`,
    "备份来源：同一通知随后刊登在国务院公报 https://www.gov.cn/gongbao/ 上",
    "核对《全国年节及纪念日放假办法》有没有再修订（最近一次是 2024 年 11 月公布、2025 年起施行：https://www.gov.cn/zhengce/content/202411/content_6986380.htm）：修订会改变各节日放假的天数",
    "\"X月X日至X日放假调休，共N天\"逐日展开为 holiday，每段天数要等于\"共N天\"；\"X月X日（周X）上班\"列为 makeup_workday",
  ];
}

/** 更新任务的标题和任务书 */
export function holidayUpdateBrief(year: number, regions: readonly HolidayRegion[]): { title: string; brief: TaskBrief } {
  const sides = regions.map((r) => HOLIDAY_REGION_LABEL[r]).join("、");
  const files = regions.map((region) => holidayFileName({ region, year })).join("、");
  return {
    title: `更新 ${year} 年${sides}节假日数据`,
    brief: {
      goal: `更新 ${year} 年${sides}的节假日数据（放假、补假、调休补班），给二狗的个人工作日历用。`,
      acceptanceCriteria: [
        `产出区里每一边一个数据文件：${files}，格式和二狗自带的节假日数据一样（见约束）`,
        "每个日期和种类都和官方原文逐条核对过（星期也对一遍），文件里附官方来源",
        "官方还没公布的那一边如实说明，不交文件、不自行推算",
      ],
      constraints: [
        `只用官方一手来源，要联网去取：计划的工具包要开联网（toolkit.network 为 true）`,
        ...regions.flatMap((region) => officialSources(region, year).map((s) => `${HOLIDAY_REGION_LABEL[region]}：${s}`)),
        `交付件格式：{ "format": 1, "region": "sg" 或 "cn", "year": ${year}, "sources": [{ "title", "url"（https）, "published"（YYYY-MM-DD）, "accessed" }], "days": [{ "date": "YYYY-MM-DD", "name", "kind" }] }；新加坡的 kind 是 holiday 或 observed（补假），国内的是 holiday 或 makeup_workday（调休上班）`,
        "验收通过、任务完成后由运行时校验格式并导入工作日历；不要直接写二狗的配置区",
      ],
      projects: [],
      memoryScope: "不需要用户的记忆",
    },
  };
}

export interface HolidayUpdatesOptions {
  workdayCalendar: WorkdayCalendarService;
  inbox: InboxService;
  store: EventStore;
  /** 12 号票的任务：用户点"发起更新任务"时建任务、写任务书 */
  tasks: Pick<TaskService, "buildCreate" | "writeBrief">;
  internalJobs: InternalJobs;
  clock: Clock;
  layout: Pick<DataDirLayout, "outputs">;
  config: HolidayCheckConfig;
  log: (line: string) => void;
}

export interface HolidayUpdates {
  /** 登记每月的检查、"发起更新任务"的反应、数据补上后缺失事项自动结束 */
  start(): void;
  stop(): void;
  /**
   * 导入一个任务的交付件：不是节假日数据更新任务的返回 undefined；是的话把工作目录（不给是产出区 outputs/<任务 id>）里
   * 交了的 <地区>-<年>.json 逐个校验后导入，没交的、不对的写进 problems
   */
  importForTask(taskId: string, workDir?: string): HolidayImportResult | undefined;
  /** 任务完成后（13 号票的任务完成回调）：导入它的交付件，有问题的在待我处理里放一条说明（不卡任务） */
  taskCompleted(completed: { task: { id: string; title: string }; workDir: string }): void;
}

const isMissingNotice = (item: InboxItem): item is NoticeInboxItem & { data: HolidayMissingData } => item.kind === "notice" && item.notice === "holiday_data_missing" && !item.deleted;

export function createHolidayUpdates(options: HolidayUpdatesOptions): HolidayUpdates {
  const { workdayCalendar, inbox, store, tasks, internalJobs, clock, config, log } = options;
  const offs: Array<() => void> = [];

  /** 每月跑一次：到了检查的月份及以后查下一年，之前的月份查今年 */
  const check = () => {
    const now = new Date(clock.now());
    const year = now.getMonth() + 1 >= config.fromMonth ? now.getFullYear() + 1 : now.getFullYear();
    const missing = workdayCalendar.current().missing(year);
    if (missing.length === 0) return;
    const notified = inbox.list().some((item) => isMissingNotice(item) && item.data.year === year && missing.every((r) => item.data.regions.includes(r)));
    if (notified) return;
    const sides = missing.map((r) => HOLIDAY_REGION_LABEL[r]).join("、");
    const data: HolidayMissingData = { year, regions: missing };
    inbox.add({
      kind: "notice",
      notice: "holiday_data_missing",
      title: missingHolidayDataText(year, missing),
      body: `${year} 年${sides}的节假日数据还没有，工作日历在 ${year} 年${sides}那边先按周一到周五算（没有调休补班）。点"${HOLIDAY_UPDATE_ACTION}"发起一个联网任务，去官方来源取 ${year} 年的数据。`,
      source: "工作日历",
      urgency: "non_blocking",
      actions: [HOLIDAY_UPDATE_ACTION],
      data,
    });
  };

  /** 用户点了"发起更新任务"：建任务（规划中，看板上），记下它是哪一年哪一边的更新，写好任务书交给维护者 */
  const startTask = (item: NoticeInboxItem) => {
    const data = item.data as HolidayMissingData;
    const { title, brief } = holidayUpdateBrief(data.year, data.regions);
    const { task, events } = tasks.buildCreate({ title, summary: brief.goal, origin: "button" }, "user");
    const link: HolidayUpdateTaskPayload = { taskId: task.id, itemId: item.id, year: data.year, regions: data.regions };
    store.appendBatch([...events, { channel: INTERNAL_CHANNEL, type: HOLIDAY_UPDATE_TASK, payload: link }]);
    tasks.writeBrief(task.id, brief);
    log(`工作日历：发起了更新任务 ${task.id}「${task.title}」`);
  };

  /** 数据补上了（导入了交付件）：对应的缺失事项自动结束 */
  const retireNotices = () => {
    for (const item of inbox.list()) {
      if (!isMissingNotice(item) || item.archived) continue;
      if (workdayCalendar.current().missing(item.data.year).some((r) => item.data.regions.includes(r))) continue;
      store.append(inbox.buildUpdate(item, { archived: true, title: `${item.title}（已补上）` }).event);
    }
  };

  /** 导入一个任务的交付件（不是节假日数据更新任务的返回 undefined） */
  const importForTask = (taskId: string, workDir = path.join(options.layout.outputs, taskId)): HolidayImportResult | undefined => {
    const link = store
      .read(INTERNAL_CHANNEL, 0, HOLIDAY_UPDATE_TASK)
      .map((e) => e.payload as HolidayUpdateTaskPayload)
      .find((p) => p.taskId === taskId);
    if (!link) return undefined;
    const result: HolidayImportResult = { imported: [], problems: [] };
    for (const region of link.regions) {
      const name = holidayFileName({ region, year: link.year });
      const file = path.join(workDir, name);
      if (!fs.existsSync(file)) {
        result.problems.push(`没有交 ${name}（${HOLIDAY_REGION_LABEL[region]} ${link.year} 年的数据可能还没公布）`);
        continue;
      }
      try {
        result.imported.push(workdayCalendar.importHolidayFile(file));
      } catch (err) {
        if (!(err instanceof RequestRejected)) throw err;
        result.problems.push(`${name}：${err.message}`);
      }
    }
    return result;
  };

  return {
    start() {
      const schedule: ReminderSchedule = { kind: "monthly", time: config.time, days: [config.dayOfMonth] };
      internalJobs.register({ name: HOLIDAY_CHECK_JOB, schedule, run: async () => check() });
      offs.push(inbox.onNoticeHandled("holiday_data_missing", HOLIDAY_UPDATE_ACTION, startTask));
      offs.push(workdayCalendar.onChange(retireNotices));
    },
    stop() {
      for (const off of offs.splice(0)) off();
    },
    importForTask,
    taskCompleted({ task, workDir }) {
      const result = importForTask(task.id, workDir);
      if (!result || result.problems.length === 0) return;
      inbox.add({
        kind: "notice",
        notice: "holiday_import_problem",
        title: `节假日数据导入有问题：${task.title}`,
        body: [
          `任务「${task.title}」完成了，但交付件有问题，下面这些没有导入：`,
          ...result.problems.map((p) => `- ${p}`),
          ...(result.imported.length > 0 ? [`已导入：${result.imported.map((y) => `${y.region}-${y.year}`).join("、")}`] : []),
        ].join("\n"),
        source: `任务「${task.title}」`,
        urgency: "non_blocking",
        data: { taskId: task.id, problems: result.problems },
      });
    },
  };
}
