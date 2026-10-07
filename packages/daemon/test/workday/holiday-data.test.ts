// 框架自带的节假日数据（29 号票）：从调研文件 docs/research/13-holidays-sg-cn.md 导入已公布的全部年份，
// 每年注明官方来源。这里按调研文件里的表逐日核对：日期、种类（假日、补假、调休上班），星期也对一遍；
// 名字去掉"（放假 1/3）"这类计数后一致。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { HolidayDayKind, HolidayRegion, HolidayYear } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { loadBuiltinHolidays } from "../../src/workday/index.ts";

const RESEARCH = fileURLToPath(new URL("../../../../docs/research/13-holidays-sg-cn.md", import.meta.url));

interface ResearchRow {
  date: string;
  weekday: string;
  name: string;
  kind: HolidayDayKind;
}

const KIND_OF: Record<string, HolidayDayKind> = { 假日: "holiday", "补假 observed": "observed", 调休上班: "makeup_workday" };
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 调研文件里某个地区的章节下，各年的表（"### 2026 年（14 行……）"下面的表格） */
function researchTables(region: HolidayRegion): Map<number, { declared: number; rows: ResearchRow[] }> {
  const text = fs.readFileSync(RESEARCH, "utf8");
  const heading = region === "sg" ? "## 2. 新加坡" : "## 3. 中国大陆";
  const section = text.slice(text.indexOf(heading), text.indexOf("\n## ", text.indexOf(heading) + heading.length));
  const tables = new Map<number, { declared: number; rows: ResearchRow[] }>();
  for (const part of section.split("\n### ").slice(1)) {
    const head = /^(\d{4}) 年（(\d+) 行/.exec(part);
    if (!head) continue;
    const rows = [...part.matchAll(/^\| (\d{4}-\d{2}-\d{2}) \| (周.) \| (.+?) \| (.+?) \|$/gm)].map(([, date, weekday, name, kind]) => {
      const mapped = KIND_OF[kind!];
      if (!mapped) throw new Error(`调研文件里不认识的类型：${kind}`);
      return { date: date!, weekday: weekday!, name: name!, kind: mapped };
    });
    tables.set(Number(head[1]), { declared: Number(head[2]), rows });
  }
  return tables;
}

/** 调研文件来源表里的全部网址 */
function researchUrls(): Set<string> {
  const text = fs.readFileSync(RESEARCH, "utf8");
  return new Set([...text.matchAll(/https:\/\/[^\s|；)]+/g)].map((m) => m[0]));
}

const plainName = (name: string) => name.replace(/（放假 \d+\/\d+）$/, "");

describe("框架自带的节假日数据和调研文件逐日一致", () => {
  const builtin = loadBuiltinHolidays();
  const find = (region: HolidayRegion, year: number): HolidayYear | undefined => builtin.find((y) => y.region === region && y.year === year);

  test("已公布的年份都在：新加坡 2026、2027，国内 2026；国内 2027 尚未公布、不自行推算", () => {
    expect(builtin.map((y) => `${y.region}-${y.year}`).toSorted()).toEqual(["cn-2026", "sg-2026", "sg-2027"]);
    expect([...researchTables("sg").keys()]).toEqual([2026, 2027]);
    expect([...researchTables("cn").keys()]).toEqual([2026]);
  });

  for (const region of ["sg", "cn"] as const) {
    for (const [year, table] of researchTables(region)) {
      test(`${region} ${year}：逐日的日期、种类、名字都对得上，行数和调研文件写的一致`, () => {
        const data = find(region, year);
        expect(data).toBeDefined();
        expect(table.rows).toHaveLength(table.declared);
        // 调研文件的星期列和日期本身一致（导入时没有错位）
        for (const row of table.rows) expect(row.weekday).toBe(WEEKDAYS[new Date(`${row.date}T00:00:00Z`).getUTCDay()]);
        expect(data!.days.map((d) => ({ date: d.date, kind: d.kind, name: d.name }))).toEqual(table.rows.map((r) => ({ date: r.date, kind: r.kind, name: plainName(r.name) })));
      });
    }
  }

  test("每年注明官方来源，来源都是调研文件列出的官方网址", () => {
    const urls = researchUrls();
    for (const year of builtin) {
      expect(year.sources.length).toBeGreaterThan(0);
      for (const source of year.sources) expect(urls.has(source.url), `${year.region}-${year.year} 的来源 ${source.url}`).toBe(true);
    }
    // 新加坡用人力部（MOM）和它在 data.gov.sg 上管理的数据集；国内用中国政府网
    for (const year of builtin) {
      const hosts = new Set(year.sources.map((s) => new URL(s.url).host));
      expect([...hosts].every((h) => (year.region === "sg" ? ["www.mom.gov.sg", "data.gov.sg"] : ["www.gov.cn"]).includes(h))).toBe(true);
    }
  });
});
