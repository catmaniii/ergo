// 个人工作日历（29 号票）：工作日历频道上的节假日数据加个人设置 → 工作日历（共享协议包的纯函数，和守护进程算的是同一份）。
// 设置里的工作日历页按它显示每天上班或休息及原因；改个人设置走 HTTP（守护进程改完推一条事件，多个前端一起跟着变）。
import { EMPTY_WORKDAY_SETTINGS, type WorkdayCalendar, workdayCalendar, type WorkdaySettings } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 当前的工作日历；还没收到节假日数据时是 undefined（页面显示加载中） */
export function workdayCalendarOf(state: UiState): WorkdayCalendar | undefined {
  const { holidays, settings } = state.workday;
  return holidays === undefined ? undefined : workdayCalendar(holidays, settings ?? EMPTY_WORKDAY_SETTINGS);
}

/** 个人设置：额外上班规则和手动标记（没有收到过就是空的） */
export function workdaySettingsOf(state: UiState): WorkdaySettings {
  return state.workday.settings ?? EMPTY_WORKDAY_SETTINGS;
}
