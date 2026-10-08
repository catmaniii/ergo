// 口语稿（32 号票）：回复的文字送进 TTS 之前的样子。纯函数，表格驱动；主切面（main/voice-reply.test.ts）测它在语音回复里的用法。
import { describe, expect, it } from "vitest";
import { estimateSpeechSeconds, leadingSentences, runtimeSummary, SPEECH_SEGMENT_RULES, speakable, speechSegments } from "../../src/voice/spoken-text.ts";

describe("估念出来要多少秒", () => {
  it.each([
    ["九个汉字九个汉字九", 4.5, 2],
    ["好的，明早九点提醒你。", 4.5, 2],
    ["npm run check", 4.5, 6 / 4.5],
    ["用 git 提交", 4.5, (3 + 2) / 4.5],
    ["", 4.5, 0],
  ])("%s", (text, rate, seconds) => {
    expect(estimateSpeechSeconds(text, { charsPerSecond: rate })).toBeCloseTo(seconds, 5);
  });
});

describe("念得出来的口语稿", () => {
  it.each([
    ["纯文字原样", "好的，明早九点提醒你。", "好的，明早九点提醒你。", false],
    ["加粗、标题、列表、引用的标记去掉，一行一句", "# 今天\n**两件事**：\n- 买菜\n- 交报告\n> 别忘了", "今天。两件事：买菜。交报告。别忘了", false],
    ["行内代码留下内容", "运行 `npm ci` 就行。", "运行 npm ci 就行。", false],
    ["链接留下文字", "见[这份文档](https://example.com/a)。", "见这份文档。", false],
    ["代码块念不出来", "这样装：\n```bash\nnpm ci\n```\n就好了。", "这样装：就好了。", true],
    ["没收尾的代码块也去掉", "看这段：\n```\nconst a = 1;", "看这段：", true],
    ["表格念不出来", "结果如下：\n| 名字 | 数 |\n| --- | --- |\n| 甲 | 1 |", "结果如下：", true],
    ["光秃秃的链接地址念不出来", "地址是 https://example.com/x 。", "地址是 。", true],
    ["图片念不出来", "![图](a.png)看图。", "看图。", true],
    ["表情去掉", "好的👍，马上办✅。", "好的，马上办。", false],
  ])("%s", (_name, input, text, unspeakable) => {
    expect(speakable(input)).toEqual({ text, unspeakable });
  });
});

/** 念多快、多长算长 */
const pace = (maxSeconds: number) => ({ maxSeconds, charsPerSecond: 4.5 });

describe("开头念得完的几句", () => {
  it("按句截：放得下几句就几句", () => {
    expect(leadingSentences("第一句话。第二句话。第三句话。", pace(2))).toBe("第一句话。第二句话。");
  });
  it("第一句就太长：按字截，加省略号", () => {
    const out = leadingSentences("这是一个特别特别长而且中间没有任何句号的句子", pace(2));
    expect(out.endsWith("……")).toBe(true);
    expect(estimateSpeechSeconds(out, pace(2))).toBeLessThanOrEqual(2);
  });
  it("没有内容：空串", () => {
    expect(leadingSentences("", pace(10))).toBe("");
  });
});

describe("运行时兜底的口语总结", () => {
  it("开头念得完的几句，加一句「详细内容我发在聊天里了」，整段念得完", () => {
    const long = "周报整理好了，分三块。".repeat(30);
    const out = runtimeSummary(long, pace(10));
    expect(out.startsWith("周报整理好了，分三块。")).toBe(true);
    expect(out.endsWith("详细内容我发在聊天里了。")).toBe(true);
    expect(estimateSpeechSeconds(out, pace(10))).toBeLessThanOrEqual(10);
  });
  it("回复里没有念得出来的文字（只有代码）：只说一句「详细内容我发在聊天里了」", () => {
    expect(runtimeSummary("", pace(60))).toBe("详细内容我发在聊天里了。");
  });
});

// 38 号票：分段合成。送进 TTS 的稿子按句切段，依次合成、合成好一段推一段；第一段尽量短（第一声只等它），
// 之后每段的上限慢慢放大（合成只比实时快一点，后面的段要赶在前一段播完之前合成好），太短的句子并到相邻句，太长的按逗号再切。
describe("分段合成怎么切段", () => {
  it("切段的数字：第一段最多 16 字，之后每段的上限是前一段的 1.25 倍、最多 40 字；不到 8 字的句子并到相邻句", () => {
    expect(SPEECH_SEGMENT_RULES).toEqual({ firstMax: 16, growth: 1.25, max: 40, min: 8 });
  });

  it.each<[string, string, string[]]>([
    ["短的一句：一段", "好的，明早九点提醒你交报告。", ["好的，明早九点提醒你交报告。"]],
    [
      "按句切：句号、问号、叹号、分号各算一句（不到 8 字的并到下一句）",
      "周报整理好了，一共三块。你要现在听吗？第一块是进度！第二块是风险；第三块是下周的安排。",
      ["周报整理好了，一共三块。", "你要现在听吗？第一块是进度！", "第二块是风险；第三块是下周的安排。"],
    ],
    ["换行也算句末", "明天上午十点开会" + String.fromCharCode(10) + "议程我已经发给大家了", ["明天上午十点开会", "议程我已经发给大家了"]],
    ["太短的句子并到下一句", "好的。明天上午十点的会，议程我已经发给大家了。", ["好的。明天上午十点的会，", "议程我已经发给大家了。"]],
    ["最后一句太短，并到前一句", "议程我已经发给大家了，你看一眼。别忘了。", ["议程我已经发给大家了，你看一眼。别忘了。"]],
    ["第一段超过 16 字：按逗号切，后半句是下一段", "好的，我把这周的周报整理好了，下面分几块说清楚。", ["好的，我把这周的周报整理好了，", "下面分几块说清楚。"]],
    ["按逗号切出来的后半截太短：不单独成段，留在前一段", "我把这周的周报和下个月的计划整理好了，放心。", ["我把这周的周报和下个月的计划整理好了，放心。"]],
    [
      "按逗号切出来的前半截太短：带上下一截",
      "好的，这周的周报和下个月的计划我都整理好了，你有空的时候看一看。",
      ["好的，这周的周报和下个月的计划我都整理好了，", "你有空的时候看一看。"],
    ],
    ["没有逗号的长句不再切", "这一句特别特别长而且中间一个逗号都没有所以只能整句合成", ["这一句特别特别长而且中间一个逗号都没有所以只能整句合成"]],
    [
      "小数点不切；英文按句点加空白切（一个英文单词算两个字）",
      "温度是 3.5 度，记得加衣服。Send it to Bob. Then call me back tomorrow.",
      ["温度是 3.5 度，记得加衣服。", "Send it to Bob.", "Then call me back tomorrow."],
    ],
    ["句末的引号、括号跟着前一句", "他说：“明天的会改到下午了。”我已经通知大家（除了老王）。", ["他说：“明天的会改到下午了。”", "我已经通知大家（除了老王）。"]],
    ["没有念得出来的字：没有段", "……", []],
    [
      "时间、比分、网址里的英文冒号不切（英文冒号只在后面跟空白时才算小句之间）",
      "我们大概15:30到会场，上半场比分是3:2，网址是https://example.com/match，到时候直接看直播就行了。",
      ["我们大概15:30到会场，", "上半场比分是3:2，网址是https://example.com/match，", "到时候直接看直播就行了。"],
    ],
    ["英文冒号后面跟空白算小句之间", "Here is the plan for tomorrow: wake up early and finish the report.", ["Here is the plan for tomorrow:", "wake up early and finish the report."]],
  ])("%s", (_name, text, segments) => {
    expect(speechSegments(text)).toEqual(segments);
  });

  it("上限慢慢放大：16、20、25、31、39，之后都是 40；超过当时上限的句子按逗号切（逗号切不开的除外）", () => {
    const a = "周报我已经整理好了。"; // 9 字
    const b1 = "第一部分说的是本周的进度，"; // 12 字
    const b2 = "第二部分说的是下周安排。"; // 11 字
    const c1 = "第一部分说的是本周的进度和遇到的几个问题，"; // 20 字
    const c2 = "第二部分说的是下周的具体安排和需要你拍板的事。"; // 22 字
    const b = b1 + b2;
    // 第 2 段的上限是 20：23 字的句子切开（后半截占第 3 段）；第 4、5、6 段的上限是 31、39、40：整句；42 字的句子超过 40，切开
    expect(speechSegments(a + b + b + b + b + c1 + c2)).toEqual([a, b1, b2, b, b, b, c1, c2]);
  });

  it("切出来的各段拼回去就是原稿（只差段间的空白）", () => {
    const text = "好的。我把这周的周报整理好了，下面分几块说清楚。第一块是进度，基本按计划走；第二块是风险，主要在测试环境。Send it to Bob. 别忘了。";
    expect(speechSegments(text).join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });
});
