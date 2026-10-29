// 还剩多少处写死的中文（168 号票：多语言迁移的棘轮）。
// - 怎么数：含中文的字符串、模板、正则、JSX 文字各算一处；注释、日志调用里的、标了 @i18n-ignore 的不算（scanSource 的表格测试）；
// - 棘轮：每个区域还剩几处不能比基线多（新写的界面文字要走 t()），也不能比基线少却不改基线（降下来了就把基线改下来，
//   `npm run i18n:check -- --lower-baseline`）；标注写错了也算失败。基线每个区域一个文件，在 hardcoded-baseline/ 里。
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countByRegion, HARDCODED_REGIONS, readBaseline, regionOf, scanRepo, scanSource } from "../../src/i18n/hardcoded.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/** 算数的几处（文字、种类） */
const counted = (code: string) =>
  scanSource(code)
    .literals.filter((l) => !l.ignored)
    .map((l) => [l.kind, l.text]);

describe("怎么数", () => {
  it.each([
    ["字符串（单双引号）", `const a = "秘书"; const b = 'x'; const c = '待办';`, [["string", "秘书"], ["string", "待办"]]],
    ["模板字符串的几段文字算一处，插值里的字符串另算", "const a = `还剩 ${n} 分钟${f('天')}` + `x`;", [["string", "天"], ["template", "还剩  分钟"]]],
    ["嵌套的模板", "const a = `外${`里${x}面`}头`;", [["template", "里面"], ["template", "外头"]]],
    ["正则", "const r = /^第(\\d+)步/; const d = a / b / c;", [["regex", "/^第(\\d+)步/"]]],
    ["JSX 的文字：被 {} 隔开的算几段", "return <div className=\"x\">你好，{name}！</div>;", [["jsx", "你好，"], ["jsx", "！"]]],
    ["JSX 的结束标签不当成正则", "return <span>秘书</span>;\nconst b = 'x';", [["jsx", "秘书"]]],
    ["注释不算", "// 秘书\n/* 待办 */\nconst a = 1; /** 任务 */", []],
    ["中文的标识符（对象的键）不算", "const v = { 拉回次数: \"几次\", 名字: x };", [["string", "几次"]]],
    ["字符串里的 // 不是注释", `const u = "http://x"; const a = "中";`, [["string", "中"]]],
  ] as const)("%s", (_name, code, expected) => {
    expect(counted(code)).toEqual(expected);
  });

  it("日志：直接写在 log(...)、xxx.log(...)、console.*(...) 里的不算（catalog( 这类不是）", () => {
    const code = "log(`读不了：${f}`); options.log('坏了'); console.warn(\"注意\"); catalog('甲'); throw new Error('错了');";
    expect(counted(code)).toEqual([
      ["string", "甲"],
      ["string", "错了"],
    ]);
    expect(scanSource(code).literals.filter((l) => l.ignored === "log")).toHaveLength(3);
  });

  it("标注：行末只管这一行、-next 管下一行、-start 到 -end 管中间、-file 管整个文件；原因写在后面，可以接说明", () => {
    const code = [
      'const a = "甲"; // @i18n-ignore model：工具说明',
      "// @i18n-ignore-next fixed",
      'const b = "乙";',
      'const c = "丙";',
      "// @i18n-ignore-start data",
      'const d = "丁";',
      "const e = `戊`;",
      "// @i18n-ignore-end",
      'const f = "己";',
      "{/* @i18n-ignore fixed */} const g = <b>庚</b>;",
    ].join("\n");
    const scan = scanSource(code);
    expect(scan.markerErrors).toEqual([]);
    expect(scan.literals.map((l) => [l.text, l.ignored ?? null])).toEqual([
      ["甲", "model"],
      ["乙", "fixed"],
      ["丙", null],
      ["丁", "data"],
      ["戊", "data"],
      ["己", null],
      ["庚", "fixed"],
    ]);
    expect(counted('// 说明\n// @i18n-ignore-file model\nconst a = "甲";')).toEqual([]);
  });

  it("标注写错了要报：原因不认得、单独一行的行末标注、start 没有 end；注释里提到它（不在开头）不算标注", () => {
    expect(scanSource('const a = "甲"; // @i18n-ignore later').markerErrors).toHaveLength(1);
    expect(scanSource('// @i18n-ignore model\nconst a = "甲";').markerErrors).toHaveLength(1);
    expect(scanSource('// @i18n-ignore-start log\nconst a = "甲";').markerErrors).toHaveLength(1);
    expect(scanSource("// 写法：`// @i18n-ignore model`、`// @i18n-ignore-file log`\nconst a = '甲';")).toEqual({ literals: [{ line: 2, text: "甲", kind: "string" }], markerErrors: [] });
  });
});

describe("区域", () => {
  it("按区域表认领：守护进程 tasks/ 和 173 号票的几个目录排在其余目录前面；原型的演示数据、多语言自己的代码、测试不扫", () => {
    expect(regionOf("packages/web/src/ui/main-nav.tsx")?.region).toBe("web-ui");
    expect(regionOf("packages/web/src/App.tsx")?.region).toBe("web-ui");
    expect(regionOf("packages/web/src/state/nav.ts")?.region).toBe("web-state");
    expect(regionOf("packages/web/src/pages/MorePage.tsx")?.region).toBe("web-pages");
    expect(regionOf("packages/protocol/src/tasks.ts")?.region).toBe("protocol");
    expect(regionOf("packages/daemon/src/tasks/plain.ts")?.region).toBe("daemon-tasks");
    expect(regionOf("packages/daemon/src/secretary/secretary.ts")?.region).toBe("daemon-a");
    expect(regionOf("packages/daemon/src/scheduled-jobs/jobs.ts")?.region).toBe("daemon-b");
    expect(regionOf("frontend/harmony/entry/src/main/ets/pages/Index.ets")?.region).toBe("harmony");
    expect(regionOf("packages/web/src/prototype/fake-data.ts")).toBeUndefined();
    expect(regionOf("packages/protocol/src/i18n/runtime.ts")).toBeUndefined();
    expect(regionOf("packages/daemon/test/main/language.test.ts")).toBeUndefined();
    expect(regionOf("packages/web/src/styles/base.css")).toBeUndefined();
  });
});

describe("棘轮：每个区域写死的中文只许降不许升", () => {
  const scans = scanRepo(REPO);
  const counts = countByRegion(scans);

  it("标注都写对了", () => {
    expect(scans.filter((s) => s.markerErrors.length > 0).map((s) => `${s.file}：${s.markerErrors.join("；")}`)).toEqual([]);
  });

  // 175 号票收紧：迁完了，每个区域都是 0；剩下的只有标了原因的（npm run i18n:check -- --ignored <区域> 列出）。基线不许再往上改
  it("175 号票收紧：每个区域的基线都是 0", () => {
    expect(Object.fromEntries(HARDCODED_REGIONS.map(({ region }) => [region, readBaseline(REPO, region)]))).toEqual(
      Object.fromEntries(HARDCODED_REGIONS.map(({ region }) => [region, 0])),
    );
  });

  for (const { region, ticket } of HARDCODED_REGIONS) {
    it(`${region}（${ticket} 号票迁）`, () => {
      const baseline = readBaseline(REPO, region);
      const count = counts[region] ?? 0;
      const places = () =>
        scans
          .filter((s) => s.region === region)
          .flatMap((s) => s.literals.filter((l) => !l.ignored).map((l) => `${s.file}:${l.line} ${l.text.slice(0, 40)}`))
          .slice(0, 40)
          .join("\n");
      expect(baseline, `还没有 ${region} 的基线：npm run i18n:check -- --lower-baseline 写一份`).toBeDefined();
      const problem =
        count > baseline!
          ? `${region} 写死的中文从 ${baseline} 处多到了 ${count} 处：新写的界面文字走 t()（docs/developer-guide.md 的"多语言"一节），给模型看的、日志标 @i18n-ignore。` +
            `npm run i18n:check -- --list ${region} 列出每一处，前面几处：\n${places()}`
          : count < baseline!
            ? `${region} 写死的中文降到了 ${count} 处（基线 ${baseline}）：把基线改下来——npm run i18n:check -- --lower-baseline`
            : undefined;
      expect(problem).toBeUndefined();
    });
  }
});
