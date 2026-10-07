// 个人工作日历的运行时一侧（29 号票，规格第 21 节）：节假日数据加个人设置 → 当前的工作日历（共享协议包的纯函数）。
//
// - 个人设置（额外上班规则、手动标记）是个人数据，存在数据目录配置区的 workday-calendar.json（随数据目录备份，不进仓库）。
//   只由运行时写：设置接口（HTTP）和快速动作执行器"改工作日历"；配置区是受保护区域，agent 用任何方式都写不进（03 号票）。
// - 节假日数据：框架自带的（holiday-data.ts）加上导入的（配置区的 holidays/），同一地区同一年以导入的为准。
// - 每次改动是工作日历频道上的一条事件（workday_settings：个人设置的最新样子；holiday_data：节假日数据的最新样子），
//   多个前端据此同步，前端用同一个纯函数算出每天的结果。配置文件是个人设置的真相：先写文件、再追加事件；
//   启动时文件和上一条事件不一样（停着时手改过、或者上次写完文件没来得及追加），以文件为准、补一条事件。
// - 工作日历变了（个人设置或节假日数据），onChange 登记的函数被叫：提醒按新日历重算下一次，内部作业重新登记。
import fs from "node:fs";
import path from "node:path";
import {
  applyWorkdayChange,
  CHANNELS,
  DayMark,
  EMPTY_WORKDAY_SETTINGS,
  EVENT_TYPES,
  ExtraWorkdayRule,
  type HolidayDataEventPayload,
  type HolidayYear,
  normalizeWorkdaySettings,
  schemaChecker,
  Type,
  type WorkdayCalendar,
  workdayCalendar,
  type WorkdayChange,
  type WorkdayMonthView,
  type WorkdaySettings,
  type WorkdaySettingsEventPayload,
  WORKDAY_CHANGE_SOURCES,
} from "@ergou/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { checkHolidayYear, holidayFileName, loadBuiltinHolidays, mergeHolidays, readHolidayDir } from "./holiday-data.ts";

export type WorkdayChangeSource = (typeof WORKDAY_CHANGE_SOURCES)[number];

/** 配置文件的样子 */
const SettingsFile = Type.Object({ format: Type.Literal(1), rules: Type.Array(ExtraWorkdayRule), marks: Type.Array(DayMark) });
const settingsFile = schemaChecker(SettingsFile);

/** 改一次个人设置的结果：已经写进配置文件；有变化时带着要追加的事件（和别的事件一起放进 appendBatch） */
export interface PreparedWorkdayChange {
  settings: WorkdaySettings;
  changed: boolean;
  event?: NewEvent;
}

export interface WorkdayCalendarService {
  /** 当前的工作日历（每次按最新的个人设置和节假日数据） */
  current(): WorkdayCalendar;
  settings(): WorkdaySettings;
  holidays(): readonly HolidayYear[];
  /** 某个月（YYYY-MM）每天的结果；月份写法不对抛 RequestRejected */
  month(month: string): WorkdayMonthView;
  /** 改个人设置：写配置文件，返回要追加的事件（快速动作执行器用：和卡片、操作记录同一事务）。日期不存在抛 RequestRejected */
  prepare(change: WorkdayChange, source: WorkdayChangeSource): PreparedWorkdayChange;
  /** 改个人设置并追加事件（设置接口用） */
  change(change: WorkdayChange, source: WorkdayChangeSource): { settings: WorkdaySettings; changed: boolean };
  /**
   * 导入一份节假日数据（更新任务交付的，和框架自带的同一格式）：校验后放进配置区，推一条 holiday_data 事件。
   * 格式不对抛 RequestRejected（bad_params），什么都不改
   */
  importHolidayFile(file: string): HolidayYear;
  /** 工作日历变了（个人设置或节假日数据）时叫 fn；返回取消登记的函数 */
  onChange(fn: () => void): () => void;
  /** 读配置文件和节假日数据，和事件日志对一遍（不一样就补一条事件），之后跟着事件走 */
  start(): void;
  stop(): void;
}

export interface WorkdayCalendarServiceOptions {
  store: EventStore;
  layout: DataDirLayout;
  log: (line: string) => void;
  /** 框架自带的节假日数据所在的目录；不填用本包的 holidays/ */
  builtinHolidaysDir?: string;
}

/** 某个频道上某类事件的最后一条的负载 */
function lastPayload<T>(store: EventStore, type: string): T | undefined {
  return store.read(CHANNELS.calendar, 0, type).at(-1)?.payload as T | undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const settingsEvent = (payload: WorkdaySettingsEventPayload): NewEvent => ({ channel: CHANNELS.calendar, type: EVENT_TYPES.workdaySettings, payload });
const holidayEvent = (payload: HolidayDataEventPayload): NewEvent => ({ channel: CHANNELS.calendar, type: EVENT_TYPES.holidayData, payload });

/** 先写临时文件再改名：配置文件不会只写了一半 */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function createWorkdayCalendarService(options: WorkdayCalendarServiceOptions): WorkdayCalendarService {
  const { store, layout, log } = options;
  const builtin = loadBuiltinHolidays(options.builtinHolidaysDir);
  let settings: WorkdaySettings = EMPTY_WORKDAY_SETTINGS;
  let holidays: HolidayYear[] = builtin;
  let calendar = workdayCalendar(holidays, settings);
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;

  const changed = () => {
    calendar = workdayCalendar(holidays, settings);
    for (const fn of listeners) fn();
  };

  /** 配置文件里的个人设置；没有文件是空的；文件不对时 undefined（记日志，不覆盖它） */
  const readSettingsFile = (): WorkdaySettings | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(layout.workdayCalendarFile, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_WORKDAY_SETTINGS;
      log(`工作日历的配置文件读不了：${layout.workdayCalendarFile}：${err instanceof Error ? err.message : String(err)}；先按事件日志里上一次的样子用`);
      return undefined;
    }
    try {
      if (!settingsFile.check(parsed)) throw new Error(settingsFile.firstError(parsed) ?? "格式不对");
      return normalizeWorkdaySettings({ rules: parsed.rules, marks: parsed.marks });
    } catch (err) {
      log(`工作日历的配置文件不对：${layout.workdayCalendarFile}：${err instanceof Error ? err.message : String(err)}；先按事件日志里上一次的样子用`);
      return undefined;
    }
  };

  const importedHolidays = () => readHolidayDir(layout.holidaysDir, (file, error) => log(`导入的节假日数据不对，没用它：${file}：${error}`));

  const prepare = (change: WorkdayChange, source: WorkdayChangeSource): PreparedWorkdayChange => {
    let result: { settings: WorkdaySettings; changed: boolean };
    try {
      result = applyWorkdayChange(settings, change);
    } catch (err) {
      throw new RequestRejected("bad_params", err instanceof Error ? err.message : String(err));
    }
    if (!result.changed) return result;
    writeJsonAtomic(layout.workdayCalendarFile, { format: 1, ...result.settings });
    return { ...result, event: settingsEvent({ settings: result.settings, source, change }) };
  };

  return {
    current: () => calendar,
    settings: () => settings,
    holidays: () => holidays,
    month(month) {
      const m = /^(\d{4})-(\d{2})$/.exec(month);
      const [year, mon] = m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
      if (!m || mon < 1 || mon > 12) throw new RequestRejected("bad_params", `月份的写法不对：${month}（写 YYYY-MM）`);
      return { month, days: calendar.month(year, mon), settings, missing: calendar.missing(year) };
    },
    prepare,
    change(change, source) {
      const prepared = prepare(change, source);
      if (prepared.event) store.append(prepared.event);
      return { settings: prepared.settings, changed: prepared.changed };
    },
    importHolidayFile(file) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (err) {
        throw new RequestRejected("bad_params", `节假日数据读不了：${err instanceof Error ? err.message : String(err)}`);
      }
      const checked = checkHolidayYear(parsed);
      if (!checked.ok) throw new RequestRejected("bad_params", `节假日数据不对：${checked.error}`);
      writeJsonAtomic(path.join(layout.holidaysDir, holidayFileName(checked.value)), checked.value);
      store.append(holidayEvent({ years: mergeHolidays(builtin, importedHolidays()), imported: { region: checked.value.region, year: checked.value.year } }));
      return checked.value;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      unsubscribe = store.onAppend((event) => {
        if (event.channel !== CHANNELS.calendar) return;
        if (event.type === EVENT_TYPES.workdaySettings) settings = (event.payload as WorkdaySettingsEventPayload).settings;
        else if (event.type === EVENT_TYPES.holidayData) holidays = (event.payload as HolidayDataEventPayload).years;
        else return;
        changed();
      });
      const lastSettings = lastPayload<WorkdaySettingsEventPayload>(store, EVENT_TYPES.workdaySettings);
      const lastHolidays = lastPayload<HolidayDataEventPayload>(store, EVENT_TYPES.holidayData);
      settings = lastSettings?.settings ?? EMPTY_WORKDAY_SETTINGS;
      holidays = mergeHolidays(builtin, importedHolidays());
      // 框架自带的数据随发版变了、或者导入过新的：推一条，前端跟着换
      if (!same(lastHolidays?.years, holidays)) store.append(holidayEvent({ years: holidays }));
      // 配置文件是个人设置的真相：和上一条事件不一样就补一条
      const fromFile = readSettingsFile();
      if (fromFile && !same(fromFile, settings) && !(lastSettings === undefined && same(fromFile, EMPTY_WORKDAY_SETTINGS))) {
        store.append(settingsEvent({ settings: fromFile, source: "config_file" }));
      }
      changed();
    },
    stop() {
      unsubscribe?.();
      listeners.clear();
    },
  };
}
