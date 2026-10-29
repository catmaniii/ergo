// agent 之间的来信（115 号票）：哪些消息算来信、一句话总结从哪来（存着的 summary，旧消息退回第一句）。
import { describe, expect, test } from "vitest";
import { firstSentence, LETTER_SUMMARY_MAX, LETTER_TAGS, letterKindOf, letterSummaryOf, type MessageEnvelope } from "../src/index.ts";

const message = (speaker: MessageEnvelope["speaker"], text: string, extra: Partial<MessageEnvelope> = {}): MessageEnvelope => ({
  id: "m-1",
  conversation: "secretary",
  speaker,
  time: "2026-10-13T08:01:00.000+08:00",
  parts: [{ type: "text", text }],
  ...extra,
});

describe("哪些算来信", () => {
  test.each([
    ["system", `${LETTER_TAGS.task_done}后台有一件事做完了`, {}, "task_done"],
    ["system", `${LETTER_TAGS.task_done}【跑完自动播报】后台有一件事做完了`, {}, "task_done"],
    ["system", `${LETTER_TAGS.maintainer_letter}后台的一个 agent 让你转告用户一件事`, {}, "maintainer_letter"],
    ["system", `${LETTER_TAGS.plan_check}已授权的计划里还有 s2「发邮件」既没有执行`, {}, "plan_check"],
    ["user", "以后早报里把 GitHub 热门也加上", { relayedBy: "secretary" }, "secretary_relay"],
    // 给用户看的系统说明、没有标记的运行时通知照旧
    ["system", "计划已确认，开始执行。", {}, undefined],
    ["system", "项目「记账本」里交出去的一件事做完了。", {}, undefined],
    // 标记要在开头；用户、agent 说的话里带着同样的字不算
    ["system", `说明：${LETTER_TAGS.task_done}`, {}, undefined],
    ["user", `${LETTER_TAGS.task_done}我自己打的`, {}, undefined],
    ["agent", `${LETTER_TAGS.maintainer_letter}它说的`, {}, undefined],
  ] as const)("%s：%s → %s", (speaker, text, extra, kind) => {
    expect(letterKindOf(message(speaker, text, extra))).toBe(kind);
  });

  test("开头不是文字（工单分隔线、卡片）的系统消息不算", () => {
    expect(letterKindOf({ ...message("system", ""), parts: [{ type: "card_ref", cardId: "c-1" }, { type: "text", text: `${LETTER_TAGS.task_done}x` }] })).toBeUndefined();
  });
});

describe("一句话总结", () => {
  test("第一句：第一个非空行到第一个句号、叹号、问号、分号为止，去掉末尾的冒号；长的截到 30 字（含省略号）", () => {
    expect(firstSentence("\n  以后早报里把 GitHub 热门也加上。每天放在最后")).toBe("以后早报里把 GitHub 热门也加上");
    expect(firstSentence("先别删旧文件；等我看过再说")).toBe("先别删旧文件");
    expect(firstSentence("要现场版吗？\n要的话跟我说")).toBe("要现场版吗");
    expect(firstSentence("下面三件事：")).toBe("下面三件事");
    // 英文句点不当句号（文件名、版本号里都有）
    expect(firstSentence("brief.md 写好了，Vite 出了 7.2")).toBe("brief.md 写好了，Vite 出了 7.2");
    const long = "官方有录音室版和现场版两个版本，我先下了录音室版，要现场版的话在任务里跟我说一声";
    expect(firstSentence(long)).toHaveLength(LETTER_SUMMARY_MAX);
    expect(firstSentence(long)).toBe(`${long.slice(0, LETTER_SUMMARY_MAX - 1)}…`);
    expect(firstSentence("")).toBe("");
  });

  test("存着总结的用它", () => {
    expect(letterSummaryOf(message("system", `${LETTER_TAGS.task_done}后台有一件事做完了：\n\n很长的全文`, { summary: "t-5「AI 日报」第 2 次运行做完了，交了 1 个文件" }))).toBe(
      "t-5「AI 日报」第 2 次运行做完了，交了 1 个文件",
    );
  });

  test("旧消息没有总结：去掉开头的标记，跳过运行时写的引子（冒号结尾、后面还有内容的行），取第一句", () => {
    const done = [
      `${LETTER_TAGS.task_done}【跑完自动播报】后台有一件事做完了（运行时发来的，不是用户说的）：`,
      "定时触发的普通任务 t-5「AI 日报」的第 2 次运行做完了（触发：10 月 13 日（周二）08:00 到点）。这件开了跑完自动播报。\n它最后说：\n日报写好了",
      "不用问，直接念。",
    ].join("\n\n");
    expect(letterSummaryOf(message("system", done))).toBe("定时触发的普通任务 t-5「AI 日报」的第 2 次运行做…");
    const letter = [
      `${LETTER_TAGS.maintainer_letter}后台的一个 agent 让你转告用户一件事（运行时转交的，不是用户说的）：`,
      "普通任务 t-song「下载《晴天》的音频」的维护者说：\n官方有录音室版和现场版。我先下了录音室版",
      "在主线里主动用你自己的话转告用户。",
    ].join("\n\n");
    expect(letterSummaryOf(message("system", letter))).toBe("官方有录音室版和现场版");
    expect(letterSummaryOf(message("system", `${LETTER_TAGS.plan_check}已授权的计划里还有 s3「发周报」既没有执行，也没有报告跳过。请继续按计划执行`))).toBe(
      "已授权的计划里还有 s3「发周报」既没有执行，也没有报告跳过",
    );
    // 秘书转达的话：话本身的第一句（用户的话里冒号结尾的行不跳）
    expect(letterSummaryOf(message("user", "以后日报加两块：\n1. GitHub 热门\n2. 论文", { relayedBy: "secretary" }))).toBe("以后日报加两块");
    // 只有引子的：引子就是总结
    expect(letterSummaryOf(message("system", `${LETTER_TAGS.task_done}后台有一件事做完了：`))).toBe("后台有一件事做完了");
  });
});
