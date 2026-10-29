// 这套记忆系统的名字（336 号票，用户 2026-10-28 定的「会意」，英文 Subtext）：以后还会接别的记忆系统当插件，
// 一次只用一个，界面上得认得出现在用的是哪一套（337 号票在设置里选记忆系统时也用这个名字）。
// 名字和文案都在多语言里（packages/protocol/locales/{zh-CN,en}/pages.json 的 pages.memory.system*），这里只放键名、
// 界面上一律 t() 现取；**导航那一项还是"记忆"**（shell.nav.memory），名字只露在记忆页页头和那块设置的小标题上。
import { t } from "../../state/index.ts";

/** 名字：中文「会意」、英文 Subtext */
export const MEMORY_SYSTEM_NAME = "pages.memory.systemName";

/** 记忆页页头那一行：会意 · 从你说过的话里推断你真正想要的 */
export function memorySystemTagline(): string {
  return t("pages.memory.systemTagline", { name: t(MEMORY_SYSTEM_NAME) });
}

/** 记忆页最下面那块设置的小标题：会意 · 设置 */
export function memorySystemSettingsTitle(): string {
  return t("pages.memory.systemSettings", { name: t(MEMORY_SYSTEM_NAME) });
}
