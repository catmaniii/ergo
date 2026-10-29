// 节假日数据（29 号票）：一个地区一年一份（共享协议包 workday-calendar.ts 的 HolidayYear），两种来源同一个格式：
// - 框架自带的公开数据：本包的 holidays/<地区>-<年>.json，从调研文件 docs/research/13-holidays-sg-cn.md 导入，
//   靠框架发版更新；
// - 用户的更新任务交付、运行时校验后导入的：数据目录配置区的 holidays/<地区>-<年>.json（agent 写不进配置区）。
// 两边合在一起用（协议包的 mergeHolidayYears：同一地区同一年以导入的为准）。校验（checkHolidayYear）、文件名
// （holidayFileName）都在协议包里，这里只管读文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkHolidayYear, holidayFileName, type HolidayYear } from "@ergo/protocol";

/** 框架自带的节假日数据所在的目录 */
export const BUILTIN_HOLIDAYS_DIR = fileURLToPath(new URL("../../holidays/", import.meta.url));

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
      onBad(file, `读不了：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：坏的文件只记日志
      continue;
    }
    const checked = checkHolidayYear(parsed);
    if (!checked.ok) onBad(file, checked.error);
    else if (holidayFileName(checked.value) !== name) onBad(file, `文件名应当是 ${holidayFileName(checked.value)}`); // @i18n-ignore log：坏的文件只记日志
    else years.push(checked.value);
  }
  return years;
}

/** 框架自带的节假日数据（坏了就是框架的错：直接抛） */
export function loadBuiltinHolidays(dir: string = BUILTIN_HOLIDAYS_DIR): HolidayYear[] {
  return readHolidayDir(dir, (file, error) => {
    throw new Error(`框架自带的节假日数据不对：${file}：${error}`); // @i18n-ignore log：框架的错
  });
}
