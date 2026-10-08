// 口语稿（32 号票）：回复的文字送进 TTS 之前的样子。纯函数，表格驱动；主切面（main/voice-reply.test.ts）测它在语音回复里的用法。
import { describe, expect, it } from "vitest";
import { estimateSpeechSeconds, leadingSentences, runtimeSummary, speakable } from "../../src/voice/spoken-text.ts";

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
