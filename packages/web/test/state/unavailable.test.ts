// 停用的插件拥有的会话条目换成占位（193 号票，state/chat-items.ts 的 maskUnavailable）：归哪个没启用的插件由界面按网页插件宿主现算
// （这里直接给）；换成的那一条 id、序号、时间、归属照原来的，要点那一行写"（X插件没启用，这条内容暂时看不到）"，对话层画成一行
// （chatLook 的 unavailable），详情打不开（开着的时候停的写"X插件没启用"），长程任务的阶段框里照"已删除"留在对话层。
import { describe, expect, test } from "vitest";
import { type ChatItem, chatLook, detailContent, initialUiState, maskUnavailable, stageChatShown } from "../../src/state/index.ts";

const base = { seq: 3, time: "2026-10-20T10:00:03.000+08:00", scope: {}, content: "plan", tone: undefined, marks: [], detail: "card", error: false, internalCalls: [] } as const;
const reminderCard: ChatItem = { ...base, kind: "card", id: "m-3#part0", keyLine: "提醒：交房租", cardId: "card-r" };
const planCard: ChatItem = { ...base, kind: "card", id: "m-4#part0", seq: 4, keyLine: "计划", cardId: "card-p" };
const TYPES: Record<string, string> = { "card-r": "reminder", "card-p": "plan" };
/** 提醒插件停用了：提醒卡归它 */
const owner = (item: ChatItem) => (item.kind === "card" && TYPES[item.cardId] === "reminder" ? "提醒" : undefined);

describe("停用的插件拥有的会话条目换成占位", () => {
  test("一条都不归停用的插件：原样交回（同一个数组，会话不重算）", () => {
    const items = [planCard];
    expect(maskUnavailable(items, owner)).toBe(items);
  });

  test("归停用的插件的那一条：换成 unavailable，id、序号、时间、归属照原来的，没有详情；别的不动", () => {
    const masked = maskUnavailable([reminderCard, planCard], owner);
    expect(masked[1]).toBe(planCard);
    expect(masked[0]).toEqual({
      kind: "unavailable",
      plugin: "提醒",
      was: "card",
      id: "m-3#part0",
      seq: 3,
      time: "2026-10-20T10:00:03.000+08:00",
      scope: {},
      content: "context",
      keyLine: "（提醒插件没启用，这条内容暂时看不到）",
      tone: undefined,
      marks: [],
      detail: undefined,
      error: false,
      internalCalls: [],
    });
    // 已经是占位的不再换
    const placeholders = [masked[0]!];
    expect(maskUnavailable(placeholders, () => "别的")).toBe(placeholders);
  });

  test("对话层一行（点不开）；详情写插件没启用；阶段框里照常显示在对话层", () => {
    const [item] = maskUnavailable([reminderCard], owner);
    expect(chatLook(item!)).toEqual({ form: "unavailable", text: "（提醒插件没启用，这条内容暂时看不到）", open: undefined });
    expect(detailContent(initialUiState, [item!], { type: "item", id: item!.id })).toEqual({ kind: "missing", reason: "unavailable", plugin: "提醒" });
    expect(stageChatShown(initialUiState, item!)).toBe(true);
  });
});
