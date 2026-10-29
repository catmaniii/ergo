// 运行时核实过的用户原话（125 号票）：给人、给模型看的说法；立项要求变更的合并、逐条对照、说法；重做时改阶段的输入的 schema。
import { describe, expect, test } from "vitest";
import {
  ASSISTANT_NAME_MARK,
  charterChangeItems,
  charterChangeItemText,
  CharterChangeCardPayload,
  mergeCharterDraft,
  refusedUserWordsText,
  schemaChecker,
  TaskActionParams,
  userWordsLine,
  userWordsSource,
  type VerifiedUserWords,
} from "../src/index.ts";

const words: VerifiedUserWords = {
  messageId: "m-1",
  text: "不用等满一周，覆盖到今天就行",
  conversation: "secretary",
  where: "秘书会话",
  time: "2026-10-14T08:30:12.000+08:00",
  device: "设备「我的手机」",
};

describe("运行时核实过的用户原话", () => {
  test("一条写成一行：原文，后面是时间、哪个会话、哪台设备；语音转写、经秘书转达另外写明", () => {
    expect(userWordsLine(words)).toBe("「不用等满一周，覆盖到今天就行」（10-14 08:30 · 秘书会话 · 设备「我的手机」）");
    // 提到秘书的写名字占位（43 号票：界面上换成用户起的名字，交给 agent 的换成"秘书"）
    expect(userWordsSource({ ...words, voice: true, relayedBy: "secretary" })).toBe(`10-14 08:30 · 秘书会话 · 设备「我的手机」 · 语音转写 · 经${ASSISTANT_NAME_MARK}转达`);
  });

  test("没核实过的那几条交回 agent：哪一条、为什么；都核实了是空串", () => {
    expect(refusedUserWordsText([])).toBe("");
    expect(refusedUserWordsText([{ id: "m-2", reason: "这是运行时的通知，不是用户说的" }, { id: "m-3", reason: "不是你会话里的消息" }])).toBe(
      "这几条用户原话没核实过，没算进去：m-2（这是运行时的通知，不是用户说的）；m-3（不是你会话里的消息）。",
    );
  });
});

describe("立项要求变更", () => {
  const charter = { goal: "每天出一份 AI 情报", scope: ["抓取公开来源", "不做付费内容"], firstVersion: "覆盖完整一周的周报样张", kind: "other" as const, bindExternal: false };

  test("只交改动的几项：没写的照旧，写了的整项按写的算（去掉首尾空白，空的范围条目不要），别的字段原样", () => {
    expect(mergeCharterDraft(charter, {})).toEqual(charter);
    expect(mergeCharterDraft(charter, { firstVersion: " 覆盖到今天就行 ", scope: ["抓取公开来源", "  ", "周末也推送"] })).toEqual({ ...charter, firstVersion: "覆盖到今天就行", scope: ["抓取公开来源", "周末也推送"] });
  });

  test("逐条对照新旧：目标、首版写前后两句，范围写去掉的和加上的（先后不算）；一样的没有", () => {
    expect(charterChangeItems(charter, charter)).toEqual([]);
    expect(charterChangeItems(charter, { ...charter, scope: ["不做付费内容", "抓取公开来源"] })).toEqual([]);
    const items = charterChangeItems(charter, { ...charter, goal: "每天出一份 AI 情报和周报", scope: ["抓取公开来源", "周末也推送"], firstVersion: "覆盖到今天就行" });
    expect(items).toEqual([
      { field: "goal", before: "每天出一份 AI 情报", after: "每天出一份 AI 情报和周报" },
      { field: "scope", removed: ["不做付费内容"], added: ["周末也推送"] },
      { field: "firstVersion", before: "覆盖完整一周的周报样张", after: "覆盖到今天就行" },
    ]);
    expect(items.map(charterChangeItemText)).toEqual([
      "目标：「每天出一份 AI 情报」→「每天出一份 AI 情报和周报」",
      "范围：去掉「不做付费内容」；加上「周末也推送」",
      "首版：「覆盖完整一周的周报样张」→「覆盖到今天就行」",
    ]);
  });

  test("卡的负载：逐条改动、前后两份立项书、核实过的原话", () => {
    const check = schemaChecker(CharterChangeCardPayload);
    const payload = { projectId: "p-1", projectName: "AI 简报站", revision: 1, why: "用户说不用等满一周", changes: charterChangeItems(charter, { ...charter, firstVersion: "x" }), before: charter, after: { ...charter, firstVersion: "x" }, userWords: [words] };
    expect(check.firstError(payload)).toBeUndefined();
    expect(check.firstError({ ...payload, decided: { confirmed: true, at: "2026-10-14T08:40:00.000+08:00" } })).toBeUndefined();
  });
});

describe("从这里重做时直接改这一阶段（125 号票）", () => {
  const check = schemaChecker(TaskActionParams);
  test("验收标准（改过的写原来第几条，新加的不写）、交付件，不写的那一栏不改", () => {
    expect(check.firstError({ taskId: "t-1", action: "rework", stageId: "s1", stageEdit: { acceptance: [{ criterion: "覆盖到今天就行", from: 0 }, { criterion: "附上来源" }] } })).toBeUndefined();
    expect(check.firstError({ taskId: "t-1", action: "rework", stageId: "s1", stageEdit: { deliverables: ["周报 weekly.md"] } })).toBeUndefined();
  });
  test("空的标准、空的一栏、多带的字段不收", () => {
    expect(check.firstError({ taskId: "t-1", action: "rework", stageEdit: { acceptance: [{ criterion: "" }] } })).toBeDefined();
    expect(check.firstError({ taskId: "t-1", action: "rework", stageEdit: { acceptance: [] } })).toBeDefined();
    expect(check.firstError({ taskId: "t-1", action: "rework", stageEdit: { title: "改名" } })).toBeDefined();
  });
});
