// 103 号票：秘书转达（tell_task、tell_project）的"用户点明了没有"，照 100 号票评审后改严的判法，再按 103 号票评审收严：
// 转达的说法紧跟着这个目标（编号或完整的标题、项目名，子串不算），说法前面没有否定词；要转达的话原样落在点到这个目标的那一段里
// （说到别的目标、又有转达的说法就截住），那一段里它外面没有否定词（秘书不能丢掉否定）；不只是"一下"。
// 秘书改写了、加了要求、用户说得含糊、问句、否定、宽的说法、拿不准的都算推断——出卡确认。表格驱动。
import { describe, expect, test } from "vitest";
import type { UserTurn } from "../../src/quick-actions/index.ts";
import { relayExplicit, type RelayRef } from "../../src/secretary/relay.ts";

const T5 = { id: "t-5", name: "每天出 AI 新闻日报" };
const T6 = { id: "t-6", name: "每周整理下载目录" };
const LEDGER = { id: "p-1", name: "记账本" };
const typed = (text: string): UserTurn => ({ typed: [text], spoken: [], quotes: [], cards: [] });

describe("转给任务：目标、转达的说法在同一个分句里，要转达的话原样在这一句里", () => {
  test.each<[string, typeof T5, string, boolean]>([
    ["告诉 t-5，以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", true],
    ["跟每天出 AI 新闻日报说：以后把 GitHub 热门也加上。", T5, "以后把 GitHub 热门也加上", true],
    ["让 t-5 以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", true],
    ["转告 T-5：字数控制在 500 字以内", T5, "字数控制在 500 字以内", true],
    // 秘书照抄时多带了标点、空白不算改写
    ["告诉 t-5，以后把 GitHub 热门也加上", T5, "以后把GitHub热门也加上。", true],
    // 两个目标各自点明
    ["告诉 t-5 加上 GitHub 热门，跟 t-6 说别动桌面", T6, "别动桌面", true],
    ["告诉 t-5 加上 GitHub 热门，跟 t-6 说别动桌面", T5, "加上 GitHub 热门", true],
    // 要转达的话不在点到这个目标的那一段里：t-5 的那一段到"跟 t-6 说"之前为止
    ["告诉 t-5 加上 GitHub 热门，跟 t-6 说别动桌面", T5, "别动桌面", false],
    ["告诉 t-5，加上 GitHub 热门，t-6 别动桌面", T5, "t-6 别动桌面", false],
    // 要转达的话在说法前面
    ["以后把 GitHub 热门也加上，告诉 t-5", T5, "以后把 GitHub 热门也加上", false],
    // 秘书丢了否定：意思反了
    ["告诉 t-5 不要删旧文件", T5, "删旧文件", false],
    ["告诉 t-5，旧文件别删", T5, "旧文件", false],
    ["告诉 t-5 不要删旧文件", T5, "不要删旧文件", true],
    // 宽的说法不算："让"后面不是目标、"对 X 说""通知 X""和 X 说"
    ["t-5 让人头疼，以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", false],
    ["对 t-5 说以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", false],
    ["通知 t-5 以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", false],
    ["和 t-5 说以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", false],
    // 没写编号或完整标题
    ["跟早报那个任务说一下，以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", false],
    // 秘书替用户加了要求
    ["告诉 t-5 以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门和 Hacker News 都加上", false],
    // 问句
    ["能告诉 t-5 以后把 GitHub 热门也加上吗？", T5, "以后把 GitHub 热门也加上", false],
    // 否定
    ["别告诉 t-5 以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", false],
    ["不用跟 t-5 说以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", false],
    // 说法和目标不在同一个分句："转告它"里的它不算
    ["t-5 以后把 GitHub 热门也加上，帮我转告它", T5, "以后把 GitHub 热门也加上", false],
    // 说法绑在别的目标上
    ["告诉 t-6 加上 GitHub 热门，t-5 别动", T5, "加上 GitHub 热门", false],
    // "告诉我"是要秘书自己做
    ["t-5 跑完了告诉我一声", T5, "跑完了", false],
    // 意思不清楚
    ["跟 t-5 说一下", T5, "一下", false],
    // 要转达的话跨了句：只看点明的那一句
    ["告诉 t-5，以后把 GitHub 热门也加上。另外字数控制在 500 字以内。", T5, "以后把 GitHub 热门也加上。另外字数控制在 500 字以内", false],
    // t-5 不算出现在 t-50 里
    ["告诉 t-50，以后把 GitHub 热门也加上", T5, "以后把 GitHub 热门也加上", false],
  ])("“%s” → %j「%s」：点明了 %s", (text, target, message, expected) => {
    expect(relayExplicit(typed(text), target, message) !== undefined).toBe(expected);
  });
});

describe("目标按编号或完整的名字认，子串不算", () => {
  const DAILY = { id: "t-7", name: "日报" };
  const DAILY_SUM = { id: "t-8", name: "日报汇总" };
  test.each<[string, RelayRef, RelayRef[], boolean]>([
    ["告诉日报，以后把 GitHub 热门也加上", DAILY, [DAILY_SUM], true],
    // "AI 日报"里的"日报"不算：说法后面紧跟的是"AI 日报"
    ["告诉 AI 日报，以后把 GitHub 热门也加上", DAILY, [DAILY_SUM], false],
    // 更长的那个名字优先："日报汇总"不算点到"日报"
    ["告诉日报汇总，以后把 GitHub 热门也加上", DAILY, [DAILY_SUM], false],
    ["告诉日报汇总，以后把 GitHub 热门也加上", DAILY_SUM, [DAILY], true],
    // 后面的分句说到别的任务（按名字）：段落截住
    ["告诉日报汇总，日报以后把 GitHub 热门也加上", DAILY_SUM, [DAILY], false],
  ])("“%s” → %j：点明了 %s", (text, target, others, expected) => {
    expect(relayExplicit(typed(text), target, "以后把 GitHub 热门也加上", others) !== undefined).toBe(expected);
  });
});

describe("转给项目的维护者", () => {
  test.each<[string, string, boolean]>([
    ["告诉记账本的维护者：下个月起信用卡账单也要导入", "下个月起信用卡账单也要导入", true],
    ["跟 p-1 说一声，下个月起信用卡账单也要导入", "下个月起信用卡账单也要导入", true],
    ["记账本那边下个月起信用卡账单也要导入吗", "下个月起信用卡账单也要导入", false],
    ["跟账本说一声，下个月起信用卡账单也要导入", "下个月起信用卡账单也要导入", false],
  ])("“%s” → 「%s」：点明了 %s", (text, message, expected) => {
    expect(relayExplicit(typed(text), LEDGER, message) !== undefined).toBe(expected);
  });
});

describe("点明在哪里", () => {
  test("语音转写和打的字一样参与判定，来源记成语音；引用块、引用的卡片里的不算点明", () => {
    const voice: UserTurn = { typed: [], spoken: ["告诉 t-5，以后把 GitHub 热门也加上"], quotes: [], cards: [] };
    expect(relayExplicit(voice, T5, "以后把 GitHub 热门也加上")).toEqual({ source: "voice" });
    expect(relayExplicit(typed("告诉 t-5，以后把 GitHub 热门也加上"), T5, "以后把 GitHub 热门也加上")).toEqual({ source: "typed" });
    const quoted: UserTurn = { typed: ["转给 t-5"], spoken: [], quotes: ["告诉 t-5，以后把 GitHub 热门也加上"], cards: [["告诉 t-5，以后把 GitHub 热门也加上"]] };
    expect(relayExplicit(quoted, T5, "以后把 GitHub 热门也加上")).toBeUndefined();
  });
});
