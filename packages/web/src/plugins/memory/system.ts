// 这套记忆系统的名字（336 号票，用户 2026-10-28 定的「会意」，英文 Subtext）：以后还会接别的记忆系统当插件，
// 一次只用一个，界面上得认得出现在用的是哪一套（337 号票在设置里选记忆系统时也用这个名字）。
// 名字和文案都在多语言里（packages/protocol/locales/{zh-CN,en}/pages.json 的 pages.memory.system*），这里只放键名、
// 界面上一律 t() 现取。
// 用户 2026-10-31 定：它是插件，所以标题写成「记忆模块 · 会意」/「Memory Module · Subtext」（shell.pages.memory.title，
// 分隔符统一用" · "，整个句子在语言文件里写整，不在代码里拼）；**导航那一项还是"记忆"**（shell.nav.memory，导航项一律两个字），
// 名字露在记忆页页头、下面那块设置的小标题上。
// 同一张票：它是实验性的自研记忆系统，记忆页顶上要挂一个「实验性」/ Experimental 的标签，旁边一句说明（数据在本机、能停用、能删），
// 设置块的小标题下面那句也跟着写"实验性"——不只在文档里说。
import { t } from "../../state/index.ts";

/** 名字：中文「会意」、英文 Subtext（和「记忆模块」拼成的整句在语言文件里：shell.pages.memory.title） */
export const MEMORY_SYSTEM_NAME = "pages.memory.systemName";

/** 记忆页页头那一行：从你说过的话里推断你真正想要的（名字已经在标题栏里，这里不重复） */
export function memorySystemTagline(): string {
  return t("pages.memory.systemTagline");
}

/** 记忆页最下面那块设置的小标题：记忆模块 · 会意 · 设置 */
export function memorySystemSettingsTitle(): string {
  return t("pages.memory.systemSettings", { name: t(MEMORY_SYSTEM_NAME) });
}

/** 记忆页顶上那个标签：实验性（英文 Experimental） */
export function memoryExperimentalBadge(): string {
  return t("pages.memory.experimental");
}

/** 标签旁边那句：还在打磨、数据在本机、怎么停用和删掉（照插件和素材库现有的能力写，不承诺做不到的事） */
export function memoryExperimentalNote(): string {
  return t("pages.memory.experimentalNote");
}
