// 190 号票：检索的零件——问题拆词、RRF、问题里的时间说法。纯函数，不开库。
import { describe, expect, it } from "vitest";
import { planQuery } from "../../src/retrieval/plan.ts";
import { fuseRrf, RRF_K } from "../../src/retrieval/rrf.ts";
import { queryTerms } from "../../src/retrieval/terms.ts";

describe("问题拆词（queryTerms）", () => {
  it("去掉问句词、代词、相对时间词；3 个字以上的段拆成三字词（走 FTS5），段里的两字词和两字的段走子串扫描", () => {
    const t = queryTerms("我去年去的那个音乐节是哪天？跟谁去的？");
    expect(t.fts).toEqual(["音乐节"]);
    expect(t.short).toEqual(expect.arrayContaining(["音乐", "乐节"]));
    for (const w of ["去年", "哪天", "那个", "我", "跟谁"]) {
      expect(t.fts).not.toContain(w);
      expect(t.short).not.toContain(w);
    }
  });

  it("两个字的词（香菜、夜跑）只走子串扫描；一个字的不要", () => {
    expect(queryTerms("香菜吗？")).toEqual({ fts: [], short: ["香菜"], single: [] });
    const t = queryTerms("我喜欢夜跑吗？");
    expect(t.short).toContain("夜跑");
    expect(t.short.every((w) => Array.from(w).length === 2)).toBe(true);
    expect(t.fts.every((w) => Array.from(w).length === 3)).toBe(true);
  });

  it("常出现在实词里的单字（会、地）不拆开词：聚会、地铁照样在", () => {
    expect(queryTerms("周末的聚会").short).toEqual(expect.arrayContaining(["周末", "聚会"]));
    expect(queryTerms("地铁通勤月卡").fts).toContain("地铁通");
  });

  it("长的段同时给三字词和两字词（通勤安排 → 通勤安、勤安排 + 通勤、勤安、安排）", () => {
    const t = queryTerms("通勤安排");
    expect(t.fts).toEqual(["通勤安", "勤安排"]);
    expect(t.short).toEqual(["通勤", "勤安", "安排"]);
  });

  it("节日、星期这类绝对的时间说法留着当关键词；几月几号、去年这类相对的去掉（交给时间过滤）", () => {
    expect(queryTerms("我五一去大理是跟谁去的？").short).toEqual(expect.arrayContaining(["五一", "大理"]));
    const t = queryTerms("去年 11 月中旬那阵我是不是忙得很？");
    expect([...t.fts, ...t.short].join(" ")).not.toMatch(/去年|11|中旬|那阵|是不是/);
  });

  it("空问题、全是虚词的问题没有词", () => {
    expect(queryTerms("")).toEqual({ fts: [], short: [], single: [] });
    expect(queryTerms("我是不是？")).toEqual({ fts: [], short: [], single: [] });
  });

  it("192：单字的状态词（忙、累、烦、困……）不丢，单独走子串扫描；别的单字照样不要", () => {
    expect(queryTerms("最近累吗？")).toEqual({ fts: [], short: [], single: ["累"] });
    expect(queryTerms("我最近是不是还忙得脚不沾地？").single).toEqual(["忙"]);
    expect(queryTerms("这阵子忙不忙、烦不烦？").single).toEqual(["忙", "烦"]);
    expect(queryTerms("晚上老犯困").single).toEqual(["困"]);
    expect(queryTerms("我去年去的那个音乐节是哪天？").single).toEqual([]);
  });
});

describe("RRF 融合（k = 60）", () => {
  it("每路贡献 1 / (k + 名次)，加起来排序；记下每路的名次和分数", () => {
    const fused = fuseRrf([
      { channel: "evidence_keyword", items: [{ id: "a", score: 3 }, { id: "b", score: 2 }] },
      { channel: "evidence_vector", items: [{ id: "b", score: 0.9 }, { id: "c", score: 0.8 }, { id: "a", score: 0.1 }] },
    ]);
    expect(RRF_K).toBe(60);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
    const b = fused[0]!;
    expect(b.fused).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(b.channels).toEqual({ evidence_keyword: { rank: 2, score: 2 }, evidence_vector: { rank: 1, score: 0.9 } });
    expect(fused[1]!.fused).toBeCloseTo(1 / 61 + 1 / 63, 10);
    expect(fused[2]!.fused).toBeCloseTo(1 / 62, 10);
  });

  it("同分时先看最好的名次，再看 id（结果确定）", () => {
    const fused = fuseRrf([
      { channel: "evidence_keyword", items: [{ id: "x", score: 1 }, { id: "y", score: 1 }] },
      { channel: "evidence_vector", items: [{ id: "y", score: 1 }, { id: "x", score: 1 }] },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y"]);
    expect(fused[0]!.fused).toBeCloseTo(fused[1]!.fused, 12);
  });

  it("可以给某一路加权；同一路里重复的 id 只算第一次", () => {
    const fused = fuseRrf(
      [
        { channel: "evidence_keyword", items: [{ id: "a", score: 1 }] },
        { channel: "graph", items: [{ id: "b", score: 1 }, { id: "b", score: 0.5 }] },
      ],
      { weights: { graph: 2 } },
    );
    expect(fused.map((f) => f.id)).toEqual(["b", "a"]);
    expect(fused[0]!.fused).toBeCloseTo(2 / 61, 10);
    expect(fused[0]!.channels.graph).toEqual({ rank: 1, score: 1 });
  });

  it("194：场景对不上的命中，这一路给它的票乘一个系数（默认不打折），命中里记下 offContext", () => {
    const lists = [
      { channel: "evidence_keyword" as const, items: [{ id: "a", score: 3, offContext: true }, { id: "b", score: 2 }] },
      { channel: "fact_vector" as const, items: [{ id: "a", score: 0.9 }, { id: "b", score: 0.8, offContext: true }] },
    ];
    const plain = fuseRrf(lists);
    expect(plain.find((f) => f.id === "a")!.fused).toBeCloseTo(1 / 61 + 1 / 61, 10);
    const soft = fuseRrf(lists, { offContextFactor: 0.5, weights: { fact_vector: 0.5 } });
    const a = soft.find((f) => f.id === "a")!;
    const b = soft.find((f) => f.id === "b")!;
    expect(a.fused).toBeCloseTo(0.5 / 61 + 0.5 / 61, 10);
    expect(b.fused).toBeCloseTo(1 / 62 + (0.5 * 0.5) / 62, 10);
    expect(a.channels).toEqual({ evidence_keyword: { rank: 1, score: 3, offContext: true }, fact_vector: { rank: 1, score: 0.9 } });
    expect(b.channels.fact_vector).toEqual({ rank: 2, score: 0.8, offContext: true });
  });

  it("没有输入就是空的", () => {
    expect(fuseRrf([])).toEqual([]);
  });
});

describe("问题里的时间说法（planQuery）", () => {
  const now = "2026-10-20T12:00:00+08:00";

  it("问事情（去年去的、五一去的）：给发生时间范围", () => {
    expect(planQuery("我去年去的那个音乐节是哪天？", now)).toMatchObject({ eventRange: ["2025-01-01T00:00:00+08:00", "2026-01-01T00:00:00+08:00"] });
    expect(planQuery("我五一去大理是跟谁去的？", now)).toMatchObject({ eventRange: ["2026-05-01T00:00:00+08:00", "2026-05-06T00:00:00+08:00"] });
    expect(planQuery("我五一去大理是跟谁去的？", now).at).toBeUndefined();
  });

  it("问那时的状态（那会儿、那阵、还……吗）：给有效期时间点（月中、旬中）", () => {
    expect(planQuery("今年八月中旬那会儿我还夜跑吗？", now)).toEqual({ at: "2026-08-15T12:00:00+08:00", signals: ["今年八月中旬", "那会儿"] });
    expect(planQuery("去年 11 月中旬那阵我是不是忙得很？", now).at).toBe("2025-11-15T12:00:00+08:00");
    expect(planQuery("去年九月那会儿我吃香菜吗？", now).at).toBe("2025-09-15T12:00:00+08:00");
  });

  it("没写哪一年的月份取最近一个已经过去的", () => {
    expect(planQuery("我 11 月中旬那阵是不是挺忙的？", "2025-12-01T12:00:00+08:00").at).toBe("2025-11-15T12:00:00+08:00");
    expect(planQuery("我 11 月中旬那阵是不是挺忙的？", "2026-10-20T12:00:00+08:00").at).toBe("2025-11-15T12:00:00+08:00");
  });

  it("现在、最近：有效期时间点是问的时间；没有时间说法什么都不给", () => {
    expect(planQuery("我现在更喜欢在家办公，还是去公司？", now)).toEqual({ at: now, signals: ["现在"] });
    expect(planQuery("我最近是不是还忙得脚不沾地？", now).at).toBe(now);
    expect(planQuery("我喜欢夜跑吗？", now)).toEqual({ signals: [] });
    expect(planQuery("这一年我推掉的那些活动有啥共同点？", now)).toEqual({ signals: [] });
  });
});
