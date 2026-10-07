// 素材检索（规格第 15、21 节，模块层）：关键词（FTS5 trigram，中文可用；3 个字以下的词退回子串扫描）和语义（向量，暴力扫描）。
// 只有本人的文字进索引：引用块、附件这些外部内容只存引用和哈希，搜不到。
import { describe, expect, test } from "vitest";
import { materialsSetup, postMessage, text } from "./helpers.ts";

function seed() {
  const t = materialsSetup();
  postMessage(t.store, [text("下个月要搬家，得先找好新住处")]);
  postMessage(t.store, [text("今天晚饭想吃火锅")]);
  postMessage(t.store, [text("老板让我周末加班，烦")]);
  postMessage(t.store, [text("你看这个\n> 明年房价会大涨")]);
  return t;
}

const texts = (ms: ReadonlyArray<{ segments: ReadonlyArray<{ text?: string }> }>) => ms.map((m) => m.segments[0]!.text);

describe("关键词检索", () => {
  test("三个字以上的中文词走 trigram 索引", () => {
    const t = seed();
    expect(texts(t.materials.searchKeyword("新住处"))).toEqual(["下个月要搬家，得先找好新住处"]);
    expect(texts(t.materials.searchKeyword("吃火锅"))).toEqual(["今天晚饭想吃火锅"]);
  });

  test("两个字的中文词退回子串扫描，也查得到", () => {
    const t = seed();
    expect(texts(t.materials.searchKeyword("搬家"))).toEqual(["下个月要搬家，得先找好新住处"]);
    expect(texts(t.materials.searchKeyword("加班"))).toEqual(["老板让我周末加班，烦"]);
  });

  test("一个字的中文词退回子串扫描，也查得到（新的在前）", () => {
    const t = seed();
    expect(texts(t.materials.searchKeyword("烦"))).toEqual(["老板让我周末加班，烦"]);
    expect(texts(t.materials.searchKeyword("月"))).toEqual(["下个月要搬家，得先找好新住处"]);
    expect(texts(t.materials.searchKeyword("想"))).toEqual(["今天晚饭想吃火锅"]);
  });

  test("几个词用空格隔开时每个都要出现；长词走索引、短词在结果里过滤", () => {
    const t = seed();
    expect(texts(t.materials.searchKeyword("新住处 搬家"))).toEqual(["下个月要搬家，得先找好新住处"]);
    expect(texts(t.materials.searchKeyword("新住处 火锅"))).toEqual([]);
    expect(texts(t.materials.searchKeyword("周末 老板"))).toEqual(["老板让我周末加班，烦"]);
  });

  test("引用块是外部内容，不进索引：搜不到别人的话，自己的话照样搜得到", () => {
    const t = seed();
    expect(t.materials.searchKeyword("房价会大涨")).toEqual([]);
    expect(t.materials.searchKeyword("房价")).toEqual([]);
    expect(texts(t.materials.searchKeyword("你看这个"))).toEqual(["你看这个"]);
  });

  test("查询里有双引号这类 FTS 语法字符也不出错；空查询没有结果", () => {
    const t = seed();
    expect(t.materials.searchKeyword('"火锅" OR')).toEqual([]);
    expect(t.materials.searchKeyword("   ")).toEqual([]);
  });

  test("英文不分大小写", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("明天和 Alice 开会")]);
    expect(t.materials.searchKeyword("alice")).toHaveLength(1);
    expect(t.materials.searchKeyword("AL")).toHaveLength(1);
  });

  test("最多返回 limit 条", () => {
    const t = materialsSetup();
    for (let i = 0; i < 5; i++) postMessage(t.store, [text(`第 ${i} 次说起跑步`)]);
    expect(t.materials.searchKeyword("跑步", { limit: 3 })).toHaveLength(3);
    expect(t.materials.searchKeyword("说起跑步", { limit: 2 })).toHaveLength(2);
  });
});
