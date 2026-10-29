// 识别结果里剔除模型自带的串词（voice/transcript-filter.ts，180 号票）：FasterWhisper 偶尔把"请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"
// 这类训练语料里的句子编进转写。按句（。！？!?；;换行，另外每个分段的边界也算一句的边界）切开，命中规则的句子整句删掉；
// 分段跟着删、留下的分段和文字对得上；删完没剩有字的就是空的；没命中时原样不动（undefined）。
import { DEFAULT_VOICE_CONFIG } from "../../src/config/config.ts";
import { describe, expect, it } from "vitest";
import { compileStripRules, stripTranscript, type TranscriptSegment } from "../../src/voice/transcript-filter.ts";

const AD = "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目";
const rules = compileStripRules(DEFAULT_VOICE_CONFIG.recognizer.stripPatterns, () => {});

/** 按标点切成分段（和 recognizer.py 一样：中文的分段直接连起来就是全文） */
function segmentsOf(...texts: string[]): TranscriptSegment[] {
  return texts.map((text, i) => ({ start: i * 2, end: i * 2 + 2, text }));
}

const DEFAULTS = ["[请請]不吝?[点點][赞贊讚]", "[订訂][阅閱].{0,6}[转轉][发發]", "打[赏賞].{0,10}(明[镜鏡]|[点點][点點])", "支持(明[镜鏡]|[点點][点點]).{0,6}[栏欄]目", "字幕由.{0,10}提供"];

describe("默认规则（用户 2026-10-19 给的 5 条，字都写成简繁两种都认的）", () => {
  it("默认就是这 5 条", () => {
    expect(DEFAULT_VOICE_CONFIG.recognizer.stripPatterns).toEqual(DEFAULTS);
    expect(rules.map((r) => r.pattern)).toEqual(DEFAULT_VOICE_CONFIG.recognizer.stripPatterns);
  });

  it("串词夹在中间的一句：整句删掉，前后照旧，分段跟着删", () => {
    const segments = segmentsOf("明天早上九点开会。", `${AD}。`, "记得带电脑。");
    const out = stripTranscript(segments.map((s) => s.text).join(""), segments, rules);
    expect(out).toEqual({
      text: "明天早上九点开会。记得带电脑。",
      segments: [segments[0], segments[2]],
      chars: [...`${AD}。`.replace(/\s/g, "")].length,
      rules: DEFAULTS.slice(0, 4),
    });
  });

  it("一个分段里串词和正常的话各是一句：只删串词那句，分段留着、文字换成剩下的", () => {
    const segments = segmentsOf("好的我知道了。请不吝点赞订阅转发！", "明天见。");
    const out = stripTranscript("好的我知道了。请不吝点赞订阅转发！明天见。", segments, rules);
    expect(out?.text).toBe("好的我知道了。明天见。");
    expect(out?.segments).toEqual([{ start: 0, end: 2, text: "好的我知道了。" }, segments[1]]);
  });

  it("不带标点的转写：分段的边界也算一句的边界，只删串词那一段（不连累同一行里别的分段）", () => {
    const segments = segmentsOf("明天早上九点开会", "请不吝点赞订阅转发打赏支持明镜与点点栏目");
    const out = stripTranscript("明天早上九点开会请不吝点赞订阅转发打赏支持明镜与点点栏目", segments, rules);
    expect(out?.text).toBe("明天早上九点开会");
    expect(out?.segments).toEqual([segments[0]]);
  });

  it("同一句里有用户的话也有串词：照规矩整句删（不只删几个字，免得留半句残渣）", () => {
    expect(stripTranscript("好的，请不吝点赞。还有别的吗？", [], rules)?.text).toBe("还有别的吗？");
  });

  it("大小写、空格、标点不敏感：串词里夹空格、全角标点、换行都认得", () => {
    for (const text of [`今天就到这里。${AD}`, "今天就到这里。请 不 吝 点 赞，订阅、转发。", "今天就到这里。\n订阅 · 转发 · 打赏\n", "今天就到这里。字幕由 Amara.org 社区提供"]) {
      expect(stripTranscript(text, [], rules)?.text).toBe("今天就到这里。");
    }
    const english = compileStripRules(["like and subscribe"], () => {});
    expect(stripTranscript("See you tomorrow. Please LIKE and Subscribe! Bye.", [], english)?.text).toBe("See you tomorrow. Bye.");
    const noSpace = compileStripRules(["likeandsubscribe"], () => {});
    expect(stripTranscript("See you tomorrow. Please like, and subscribe!", [], noSpace)?.text).toBe("See you tomorrow.");
  });

  it("整条只有串词：删空，文字和分段都清掉", () => {
    const segments = segmentsOf(`${AD}。`);
    expect(stripTranscript(`${AD}。`, segments, rules)).toMatchObject({ text: "", segments: [], rules: expect.arrayContaining([DEFAULTS[0]]) });
    // 删完只剩标点、空白：也算空
    expect(stripTranscript(`${AD}\n。！`, [], rules)).toMatchObject({ text: "", segments: [] });
  });

  it("繁体的原版（請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目）、简繁混着的也认得", () => {
    expect(stripTranscript("明天見。請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目", [], rules)).toMatchObject({ text: "明天見。", rules: DEFAULTS.slice(0, 4) });
    expect(stripTranscript("好的。訂閱转发。", [], rules)?.text).toBe("好的。");
  });

  it("普通的语音（不带串词）：没命中，原样不动（undefined），一字不差", () => {
    for (const text of ["明天早上九点钟提醒我交报告", "帮我订阅一下这个公众号。", "给点点打个电话，说我晚点到。", "这个视频的字幕不对。", ""]) {
      expect(stripTranscript(text, segmentsOf(text), rules)).toBeUndefined();
    }
  });
});

describe("规则", () => {
  it("写错的正则跳过并写日志（不抛错）；空的、会匹配空句子的（等于删掉所有话）也跳过；日志里没有转写的正文", () => {
    const logs: string[] = [];
    const compiled = compileStripRules(["订阅.{0,6}转发", "([未闭合", "", "a*", "明镜"], (line) => logs.push(line));
    expect(compiled.map((r) => r.pattern)).toEqual(["订阅.{0,6}转发", "明镜"]);
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain("([未闭合");
    // 新加一条规则不用改代码就生效
    expect(stripTranscript("下午三点。感谢明镜。", [], compiled)?.text).toBe("下午三点。");
  });

  it("没有规则：什么都不删", () => {
    expect(stripTranscript(AD, [], [])).toBeUndefined();
  });

  it("分段和全文对不上时（拼不回全文）：全文、分段各自按句删", () => {
    const segments = segmentsOf("今天开会", `${AD}`);
    const out = stripTranscript("今天开会。另外一句。", segments, compileStripRules(["另外"], () => {}));
    expect(out?.text).toBe("今天开会。");
    expect(out?.segments).toEqual(segments);
    const loose = segmentsOf("今天开会 ", AD);
    const both = stripTranscript(`今天开会。${AD}。`, loose, rules);
    expect(both?.text).toBe("今天开会。");
    // 没命中的分段原样留着，命中的删掉
    expect(both?.segments).toEqual([loose[0]]);
  });

  it("英文按空格连起来的分段：删掉中间一段，留下的照旧用一个空格隔开", () => {
    const english = compileStripRules(["subscribe"], () => {});
    const segments = segmentsOf("See you tomorrow.", "Please subscribe.", "Bye.");
    const out = stripTranscript("See you tomorrow. Please subscribe. Bye.", segments, english);
    expect(out).toMatchObject({ text: "See you tomorrow. Bye.", segments: [segments[0], segments[2]], chars: "Please subscribe.".replace(/\s/g, "").length, rules: ["subscribe"] });
  });
});
