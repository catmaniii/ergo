// "记住"点明了没有：运行时判定，点明了直接记、没点明出卡问。加英文的说法，只认不会误伤正常句子的：
// 一句话开头的 "Remember: …" "Remember that …" "Remember this"（不分大小写，前面可以有称呼、客气词），不认 "I remember that …" 这类。
import { describe, expect, it } from "vitest";
import { memoryCommandExecutors, rememberExplicit } from "../../src/memory/memory-commands.ts";
import type { UserTurn } from "../../src/quick-actions/index.ts";

const typed = (...texts: string[]): UserTurn => ({ typed: texts, spoken: [], quotes: [], cards: [] });
const SAID = "my passport expires in May";

describe("中文的说法照旧", () => {
  it("触发词后面到句末的那一段和内容一致才算；前面有否定词的不算", () => {
    expect(rememberExplicit("下周三上午体检", typed("记住：下周三上午体检。"))).toEqual({ source: "typed" });
    expect(rememberExplicit("下周三上午体检", typed("别记住：下周三上午体检。"))).toBeUndefined();
    expect(rememberExplicit("别的话", typed("记住：下周三上午体检。"))).toBeUndefined();
  });
});

describe("英文的说法", () => {
  it.each([
    `Remember: ${SAID}`,
    `remember: ${SAID}.`,
    `REMEMBER: ${SAID}!`,
    `Remember：${SAID}`,
    `Remember that ${SAID}`,
    `remember that ${SAID}.`,
    `Remember this: ${SAID}`,
    `Please remember that ${SAID}`,
    `Please remember: ${SAID}`,
    `ergo, remember that ${SAID}`,
    `Ergo, please remember that ${SAID}`,
    `Can you remember that ${SAID}`,
    `Can you remember that ${SAID}?`,
    // 前面先说一句
    `Ok, listen. Remember that ${SAID}.`,
    // 后面还有一句：那一段到句末为止
    `Remember that ${SAID}. Also, thanks.`,
  ])("点明了：%s", (text) => {
    expect(rememberExplicit(SAID, typed(text))).toEqual({ source: "typed" });
  });

  it("语音转写一样算，来源记成语音", () => {
    expect(rememberExplicit(SAID, { typed: [], spoken: [`remember that ${SAID}`], quotes: [], cards: [] })).toEqual({ source: "voice" });
  });

  it("只是指代（Remember this、Remember that、Remember）：内容要和引用块、引用的卡片一致", () => {
    for (const text of ["Remember this", "Remember this.", "remember that", "Remember these", "Remember the following", "Remember"]) {
      expect(rememberExplicit(SAID, { typed: [text], spoken: [], quotes: [SAID], cards: [] })).toEqual({ source: "quote" });
      expect(rememberExplicit(SAID, { typed: [text], spoken: [], quotes: [], cards: [[SAID]] })).toEqual({ source: "card" });
      expect(rememberExplicit(SAID, typed(text))).toBeUndefined();
    }
  });

  it.each([
    // 正常句子里的 remember：叙述、问话、否定
    `I remember that ${SAID}`,
    `I don't remember that ${SAID}`,
    `Don't remember that ${SAID}`,
    `Do not remember that ${SAID}`,
    `Never remember that ${SAID}`,
    `Can't remember that ${SAID}`,
    `Do you remember that ${SAID}?`,
    `Remember that ${SAID}?`,
    `He told me to remember that ${SAID}`,
    `Can I remember that ${SAID}`,
    // 别的说法：要做的事、回忆，不是要记下这句话
    `Remember to renew ${SAID}`,
    `Remember when ${SAID}`,
    `Remember ${SAID}`,
    `Remember, ${SAID}`,
    // 词的一部分
    `Remembered that ${SAID}`,
    `Remembering: ${SAID}`,
    `Remembers: ${SAID}`,
    `The Remember: ${SAID}`,
  ])("没点明：%s", (text) => {
    expect(rememberExplicit(SAID, typed(text))).toBeUndefined();
  });

  it("内容和那一段对不上不算（秘书推断出来的一律先问）", () => {
    expect(rememberExplicit("my passport expires soon", typed(`Remember that ${SAID}`))).toBeUndefined();
  });

  it("引用块、引用的卡片里的说法不算下了命令", () => {
    expect(rememberExplicit(SAID, { typed: ["look at this"], spoken: [], quotes: [`Remember that ${SAID}`], cards: [[`Remember: ${SAID}`]] })).toBeUndefined();
  });
});

// 忘掉、彻底删除、别推断没有触发词，也就没有语言之分："Forget …" 由秘书检索出素材后提议，一律过一张删除卡由用户核对
describe("忘掉这一类不按说法判定", () => {
  it("三种删除都总要过卡，没有点明这一说", () => {
    const executors = memoryCommandExecutors({} as never);
    for (const type of ["forget", "purge", "no_infer"]) {
      const executor = executors.find((e) => e.type === type)!;
      expect(executor.confirm).toBe("always");
      expect(executor.explicit).toBeUndefined();
    }
  });
});
