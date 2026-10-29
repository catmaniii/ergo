// 按编号认、按编号换行（util/mentions.ts）：265 号票写在子进程的会话文件改写里，272 号票挪进来，事件日志里的一次性补抹
// （memory/purge-backfill.ts）和会话文件用同一份。
import { describe, expect, it } from "vitest";
import { mentionsId, replaceMentionLines } from "../../src/util/mentions.ts";

const MARK = "（已删除）";

describe("按整段认编号", () => {
  it("前后挨着字母、数字、下划线、连字符的不算", () => {
    expect(mentionsId("支持 [ev-1000]", "ev-1000")).toBe(true);
    expect(mentionsId("支持 [ev-10000]", "ev-1000")).toBe(false);
    expect(mentionsId("mat-ab_ev-1000", "ev-1000")).toBe(false);
    expect(mentionsId("", "ev-1")).toBe(false);
    expect(mentionsId("ev-1", "")).toBe(false);
  });
});

describe("按编号换行", () => {
  const brief = [
    "【记录】",
    "1. [ev-1000] 2026-05-01 · 本人说的",
    "   原话：「第一行说花生",
    "第二行还是花生」",
    "   精炼：用户对花生过敏",
    "2. [ev-10000] 2026-05-02 · 本人说的",
    "   原话：「香菜不吃」",
    "【对用户的理解】",
    "- 「注意饮食」，几种说得通的解释还没分出来：",
    "  · 可能是：[cl-0002] 需求 · 推断的 · 拿不准 · 把握低：注意饮食。反对 1 条：ev-1000「花生那句」",
    "  能区分的问题：你是不是对好几样东西过敏？",
  ].join("\n");
  const gone = `- ev-1000 · ${MARK}`;

  it("提到的行换成删除标记；continuation 时续行（缩进的、没合上的「」里的）一起换，同级的下一条、缩进不比它深的不动", () => {
    expect(replaceMentionLines(brief, ["ev-1000"], MARK, { continuation: true })).toBe(
      ["【记录】", gone, "2. [ev-10000] 2026-05-02 · 本人说的", "   原话：「香菜不吃」", "【对用户的理解】", "- 「注意饮食」，几种说得通的解释还没分出来：", gone, "  能区分的问题：你是不是对好几样东西过敏？"].join("\n"),
    );
    // 不带 continuation：只换提到的那一行
    expect(replaceMentionLines("- mat-a · 原话\n  下一行", ["mat-a"], MARK)).toBe(`- mat-a · ${MARK}\n  下一行`);
  });

  it("再换一遍不变（换过的行不再吃后面缩进更深的别的内容）；没有要换的、没给字串是 undefined", () => {
    const once = replaceMentionLines(brief, ["ev-1000"], MARK, { continuation: true })!;
    expect(replaceMentionLines(once, ["ev-1000"], MARK, { continuation: true })).toBeUndefined();
    expect(replaceMentionLines(brief, ["ev-9"], MARK, { continuation: true })).toBeUndefined();
    expect(replaceMentionLines(brief, [], MARK, { continuation: true })).toBeUndefined();
  });
});
