// 节假日数据（29 号票）：一个地区一年一份（共享协议包 workday-calendar.ts 的 HolidayYear），两种来源同一个格式：
// - 框架自带的公开数据：本包的 holidays/<地区>-<年>.json，从调研文件 docs/research/13-holidays-sg-cn.md 导入，
//   靠框架发版更新；
// - 用户的更新任务交付、运行时校验后导入的：数据目录配置区的 holidays/<地区>-<年>.json（agent 写不进配置区）。
// 两边合在一起用，同一地区同一年两边都有时以导入的为准。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOLIDAY_REGION_LABEL, HolidayYear, schemaChecker } from "@ergou/protocol";

/** 框架自带的节假日数据所在的目录 */
export const BUILTIN_HOLIDAYS_DIR = fileURLToPath(new URL("../../holidays/", import.meta.url));

const holidayYear = schemaChecker(HolidayYear);

/** 数据文件的名字：sg-2027.json */
export function holidayFileName(year: Pick<HolidayYear, "region" | "year">): string {
  return `${year.region}-${year.year}.json`;
}

/**
 * 校验一份节假日数据：格式（schema）之外，日期都在这一年里、真实存在、不重复；新加坡没有调休补班，国内没有补假；
 * 至少一条官方来源（https）。
 */
export function checkHolidayYear(value: unknown): { ok: true; value: HolidayYear } | { ok: false; error: string } {
  if (!holidayYear.check(value)) return { ok: false, error: `格式不对：${holidayYear.firstError(value) ?? ""}` };
  const seen = new Set<string>();
  for (const day of value.days) {
    const at = new Date(`${day.date}T00:00:00Z`);
    if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day.date) return { ok: false, error: `日期不存在：${day.date}` };
    if (at.getUTCFullYear() !== value.year) return { ok: false, error: `${day.date} 不在 ${value.year} 年里` };
    if (seen.has(day.date)) return { ok: false, error: `${day.date} 出现了两次` };
    seen.add(day.date);
    const allowed = value.region === "sg" ? ["holiday", "observed"] : ["holiday", "makeup_workday"];
    if (!allowed.includes(day.kind)) return { ok: false, error: `${HOLIDAY_REGION_LABEL[value.region]}的数据里不该有 ${day.kind}（${day.date}）` };
  }
  return { ok: true, value };
}

/** 读一个目录里的全部数据文件（文件名 <地区>-<年>.json，内容要和文件名一致）；不对的交给 onBad，不收 */
export function readHolidayDir(dir: string, onBad: (file: string, error: string) => void): HolidayYear[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const years: HolidayYear[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).toSorted()) {
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      onBad(file, `读不了：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const checked = checkHolidayYear(parsed);
    if (!checked.ok) onBad(file, checked.error);
    else if (holidayFileName(checked.value) !== name) onBad(file, `文件名应当是 ${holidayFileName(checked.value)}`);
    else years.push(checked.value);
  }
  return years;
}

/** 框架自带的节假日数据（坏了就是框架的错：直接抛） */
export function loadBuiltinHolidays(dir: string = BUILTIN_HOLIDAYS_DIR): HolidayYear[] {
  return readHolidayDir(dir, (file, error) => {
    throw new Error(`框架自带的节假日数据不对：${file}：${error}`);
  });
}

/** 合在一起：同一地区同一年以后面的（导入的）为准；按地区、年份排好 */
export function mergeHolidays(...sources: readonly (readonly HolidayYear[])[]): HolidayYear[] {
  const merged = new Map<string, HolidayYear>();
  for (const years of sources) for (const year of years) merged.set(`${year.region}-${year.year}`, year);
  return [...merged.values()].toSorted((a, b) => a.region.localeCompare(b.region) || a.year - b.year);
}
