// 简单提醒的阈值：默认值只在这里，配置里写 reminders 改（tasks/thresholds.ts 的规矩）。
// - 晚了 lateLimitMinutes 分钟以内照发（标明晚了多久），更晚的不发通知、改放一条"错过的提醒"进待我处理。

export interface ReminderThresholds {
  /** 晚了多少分钟以内的提醒照发（默认 60） */
  lateLimitMinutes: number;
}

export const DEFAULT_REMINDER_THRESHOLDS: Readonly<ReminderThresholds> = Object.freeze({ lateLimitMinutes: 60 });
