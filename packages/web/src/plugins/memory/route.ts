// 记忆页的地址（167 号票起，193 号票挪进记忆插件）：#/more/memory[/<栏>[/<下一级>]]。核心的路由只把 item、sub 原样交过来（app/route-hash.ts
// 的网页插件页面），哪几栏、哪几栏有下一级由这里认。
import type { MorePage, Route } from "../../app/route-hash.ts";

/**
 * 首页列的几栏（285 号票，按显示的先后：从你确认过的、到推断的、到还拿不准的、到原始记录）：
 * - files：档案（281 号票的个人档案，按"我 / 家人 / 重要的人 / 其他人"分组；数据在内核，这里是它在记忆页里的位置）；
 * - claims：结论（按层分组、按状态筛；点一条是它的证据链和竞争解释——233 号票的"证据与推理"285 号票并进来）；
 * - questions：问题箱（整理时还拿不准的地方）；
 * - materials：素材（二狗从你的话和动作里积累下来的原始记录）。
 */
export const MEMORY_LAYERS = ["files", "claims", "questions", "materials"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

/**
 * 记忆页认的地址：几栏，外加不在栏目里的两处——curator：记忆管理员（242 号票；285 号票起是首页顶上那张卡点进去的整页对话），
 * materials-delete：素材页顶栏进去的成批删除（原来设置里的"删除素材"那一套）。
 */
export const MEMORY_ITEMS = [...MEMORY_LAYERS, "curator", "materials-delete"] as const;
export type MemoryItem = (typeof MEMORY_ITEMS)[number];

export function isMemoryItem(s: string | undefined): s is MemoryItem {
  return s !== undefined && (MEMORY_ITEMS as readonly string[]).includes(s);
}

/**
 * 有再下一级的：档案里点开的一个人（#/more/memory/files/<档案编号>）、结论里点开的一条（#/more/memory/claims/<结论编号>，证据链和竞争解释）、
 * 素材和成批删除里点开的一条（#/more/memory/materials/<素材 id>、#/more/memory/materials-delete/<素材 id>）
 */
export const MEMORY_ITEMS_WITH_SUB: readonly MemoryItem[] = ["files", "claims", "materials", "materials-delete"];

/** 记忆页的页面 id（导航那一项、地址里的那一段） */
export const MEMORY_PAGE = "memory";

/** 记忆页里的一个地址 */
export const memoryRoute = (item?: MemoryItem, sub?: string): Route => ({ tab: "more", page: MEMORY_PAGE, ...(item ? { item } : {}), ...(sub ? { sub } : {}) });

/**
 * 旧地址换成新的（地址栏里换掉，不压新记录）：233 号票的"证据与推理"（#/more/memory/evidence[/<结论编号>]）285 号票并进了结论。
 * 不是旧地址的给 undefined
 */
export function memoryRedirect(item: string | undefined, sub: string | undefined): Route | undefined {
  if (item === "evidence") return memoryRoute("claims", sub);
  return undefined;
}

/**
 * 记忆页盖住的核心页在记忆页里的地址（PageSlot.coverRoute，285 号票）："更多"里的个人档案（#/more/files[/<档案编号>]）换到记忆 · 档案。
 * 成批删除只是设置里不列，地址照旧（不换）
 */
export function memoryCoverRoute(page: MorePage, item: string | undefined): Route | undefined {
  return page === "files" ? memoryRoute("files", item) : undefined;
}
