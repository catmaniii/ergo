// 关注类别注册表里用户的部分（内置类别的调整、自定义类别）放在数据目录的配置区：config/watch-categories.json。
// 配置区是受保护区域，agent 用任何方式都写不进去；改它的是设置界面（26 号票），本票只读。
// 默认值（内置九类和默认处置）随框架提供，在 watch-categories.ts 里，不写进这个文件。
import fs from "node:fs";
import type { DataDirLayout } from "../config/data-dir.ts";
import { validateWatchCategorySettings, type WatchCategorySettings } from "./watch-categories.ts";

/** 读数据目录里的关注类别设置；没有文件时是空设置（全按默认）；文件不对时报错并指出文件和问题 */
export function loadWatchCategorySettings(layout: Pick<DataDirLayout, "watchCategoriesFile">): WatchCategorySettings {
  const file = layout.watchCategoriesFile;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`关注类别设置 ${file} 不是合法的 JSON：${(err as Error).message}`, { cause: err });
  }
  const problems = validateWatchCategorySettings(parsed);
  if (problems.length > 0) throw new Error(`关注类别设置 ${file} 有问题：\n- ${problems.join("\n- ")}`);
  return parsed as WatchCategorySettings;
}
