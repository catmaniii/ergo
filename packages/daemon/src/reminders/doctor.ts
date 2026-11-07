// 提醒插件自己的体检项（414），在 setup 里经 ctx.doctor.register 登记，passive（只看插件装配时算好的标记）。
// 二狗已经替它生成的只有"插件本身"。这里加"时区"（timezone）：配置文件里的 timeZone（消息前的时间标记、秘书写的提醒时间按它）
// 和这台电脑的时区（简单提醒到点按它算）不一样时，两边会差开——以前只在启动时记一行日志，现在装配时算一个标记（zoneMismatch），
// 不一样是注意（写两个时区），一样是正常。时区只在启动时读一次（改配置文件、改电脑时区都要重启二狗），所以标记在装配时算好就够。
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";

/** 两个时区不一样时的标记：配置文件里的、这台电脑的 */
export interface ZoneMismatch {
  configured: string;
  local: string;
}

/** 配置的时区和这台电脑的时区一样不一样（按 Intl 认出的规范名比；一样是 undefined） */
export function zoneMismatch(configuredZone: string, localZone: string): ZoneMismatch | undefined {
  return configuredZone === localZone ? undefined : { configured: configuredZone, local: localZone };
}

/** 时区那一项：mismatch 是装配时算好的标记，zone 是现在用的时区 */
export function timezoneFinding(mismatch: ZoneMismatch | undefined, zone: string): DoctorFinding {
  if (!mismatch) return { level: "ok", fact: { key: "reminders.doctor.timezone.ok", params: { zone } } };
  return { level: "warn", fact: { key: "reminders.doctor.timezone.mismatch", params: { configured: mismatch.configured, local: mismatch.local } }, fix: { key: "reminders.doctor.timezone.fix" } };
}

/** "时区"那一项 */
export function timezoneCheck(mismatch: ZoneMismatch | undefined, zone: string): DoctorCheck {
  return { id: "timezone", title: "reminders.doctor.timezone.title", cost: "passive", run: () => timezoneFinding(mismatch, zone) };
}
