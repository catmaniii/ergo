// 本项目的规范改写（261 号票，issue 19 第 5 条）：一条改写管规范里的某一份（不要、换写法）或多出来的一份（按位置）；
// 一次改写是几处"同一份改写前后"的变化，用户确认了才合进现在生效的改写；规范里每一份在这个项目里算什么按改写算；
// 检查清单里看某一份文档的项，这个项目不要那一份就不列；模板出了新版只提示（项目记着的版本比框架里最新的旧）。
import { describe, expect, test } from "vitest";
import {
  applyStandardChange,
  effectiveStandardDocs,
  standardBackfillDocs,
  standardBackfillDocText,
  type StandardChangeItem,
  standardChangeItemText,
  standardChecklistApplies,
  standardDocState,
  type StandardDocView,
  standardHasNewer,
  type StandardOverride,
  type StandardOverrideEntry,
  standardOverrideText,
  standardUpgradeText,
} from "../src/index.ts";

const T1 = "2026-10-24T10:00:00.000+08:00";
const T2 = "2026-10-24T11:00:00.000+08:00";

const dropArchitecture: StandardOverride = { kind: "drop", doc: "architecture" };
const weeklyProgress: StandardOverride = { kind: "change", doc: "progress", note: "按周写，每周一节" };
const runbook: StandardOverride = { kind: "add", path: "runbook.md", title: "运维手册", note: "怎么重启、怎么查日志" };

describe("规范改写合进现在生效的", () => {
  test("加上的接在后面，带着第几次、什么时候确认；改同一份的原地换掉；恢复照默认的拿掉", () => {
    const first = applyStandardChange([], [{ after: dropArchitecture }, { after: weeklyProgress }], { revision: 1, confirmedAt: T1 });
    expect(first).toEqual([
      { kind: "drop", doc: "architecture", revision: 1, confirmedAt: T1 },
      { kind: "change", doc: "progress", note: "按周写，每周一节", revision: 1, confirmedAt: T1 },
    ]);
    const items: StandardChangeItem[] = [
      { before: weeklyProgress, after: { kind: "change", doc: "progress", note: "按月写" } },
      { before: dropArchitecture },
      { after: runbook },
    ];
    expect(applyStandardChange(first, items, { revision: 2, confirmedAt: T2 })).toEqual([
      { kind: "change", doc: "progress", note: "按月写", revision: 2, confirmedAt: T2 },
      { kind: "add", path: "runbook.md", title: "运维手册", note: "怎么重启、怎么查日志", revision: 2, confirmedAt: T2 },
    ]);
  });

  test("不要和换写法管的是同一份：换写法顶掉不要", () => {
    const entries: StandardOverrideEntry[] = [{ ...dropArchitecture, revision: 1, confirmedAt: T1 }];
    const after: StandardOverride = { kind: "change", doc: "architecture", note: "只画一张部署图" };
    expect(applyStandardChange(entries, [{ before: dropArchitecture, after }], { revision: 2, confirmedAt: T2 })).toEqual([{ ...after, revision: 2, confirmedAt: T2 }]);
  });
});

describe("说法", () => {
  test("一条改写一句：不要、换写法、多一份", () => {
    expect(standardOverrideText(dropArchitecture)).toBe("不要架构图");
    expect(standardOverrideText(weeklyProgress)).toBe("进展换一种写法：按周写，每周一节");
    expect(standardOverrideText(runbook)).toBe("多一份「运维手册」（runbook.md）：怎么重启、怎么查日志");
  });

  test("一处变化一句：新加的、恢复照默认的、改了的", () => {
    expect(standardChangeItemText({ after: dropArchitecture })).toBe("不要架构图");
    expect(standardChangeItemText({ before: dropArchitecture })).toBe("架构图恢复照默认规范（原来：不要架构图）");
    expect(standardChangeItemText({ before: runbook })).toBe("「运维手册」（runbook.md）恢复照默认规范（原来：多一份「运维手册」（runbook.md）：怎么重启、怎么查日志）");
    expect(standardChangeItemText({ before: weeklyProgress, after: { kind: "change", doc: "progress", note: "按月写" } })).toBe(
      "进展换一种写法：按周写，每周一节 → 进展换一种写法：按月写",
    );
    expect(standardUpgradeText({ from: "v1", to: "v2" })).toBe("跟新版规范：v1 → v2（缺的文档从新版模板补上，已有的不动）");
    // 272 号票：规范上线之前建的项目（没有版本）补齐规范文档，缺的几份跟在后面
    expect(
      standardUpgradeText({
        to: "v1",
        missing: [
          { key: "architecture", path: "architecture.md", state: "missing" },
          { key: "adr", path: "adr/", state: "template" },
        ],
      }),
    ).toBe("补齐规范文档：改用规范 v1，缺 架构图（architecture.md）、决策记录（adr/，只有说明）（规范上线之前建的项目；缺的从模板补上、已有的不动，再建一个任务交给维护者照项目现状写好）");
    expect(standardUpgradeText({ to: "v1" })).toContain("补齐规范文档：改用规范 v1（");
  });
});

describe("规范里每一份在这个项目里算什么（按改写）", () => {
  test("开发类不要架构图、进展换写法、多一份运维手册：架构图标不要，进展标换写法，运维手册接在必须有的后面", () => {
    expect(effectiveStandardDocs("dev", [dropArchitecture, weeklyProgress, runbook])).toEqual([
      { key: "spec", role: "required" },
      { key: "architecture", role: "required", override: "drop" },
      { key: "progress", role: "required", override: "change" },
      { key: "adr", role: "required" },
      { key: "custom", role: "required", override: "add", path: "runbook.md", title: "运维手册" },
      { key: "tickets", role: "kind" },
      { key: "ops", role: "before_in_use" },
      { key: "charter", role: "auxiliary" },
      { key: "glossary", role: "auxiliary" },
      { key: "manifest", role: "auxiliary" },
      { key: "scopeRecords", role: "auxiliary" },
    ]);
  });

  test("没有改写：和默认规范一样", () => {
    expect(effectiveStandardDocs("other", []).map((d) => [d.key, d.role, d.override])).toEqual([
      ["spec", "required", undefined],
      ["progress", "required", undefined],
      ["adr", "required", undefined],
      ["charter", "auxiliary", undefined],
      ["glossary", "auxiliary", undefined],
      ["manifest", "auxiliary", undefined],
      ["scopeRecords", "auxiliary", undefined],
    ]);
  });

  test("这个项目不要的那份，项目页上说\"本项目不要\"（不管文件在不在）", () => {
    expect(standardDocState({ exists: false, override: "drop" })).toBe("dropped");
    expect(standardDocState({ exists: true, untouched: true, override: "drop" })).toBe("dropped");
    expect(standardDocState({ exists: true, untouched: true, override: "change" })).toBe("template");
  });
});

describe("检查清单按改写后的来", () => {
  test("看某一份文档的项：这个项目不要那一份就不列；别的照列", () => {
    expect(standardChecklistApplies("architecture", [dropArchitecture])).toBe(false);
    expect(standardChecklistApplies("architecture", [{ kind: "change", doc: "architecture", note: "只画部署图" }])).toBe(true);
    expect(standardChecklistApplies("progress", [dropArchitecture])).toBe(true);
    expect(standardChecklistApplies(undefined, [dropArchitecture])).toBe(true);
  });
});

describe("模板出了新版只提示", () => {
  test("项目记着的版本比框架里最新的旧：有新版；一样的、规范上线之前建的（没有版本）没有", () => {
    expect(standardHasNewer({ version: "v1", latest: "v2" })).toBe(true);
    expect(standardHasNewer({ version: "v2", latest: "v2" })).toBe(false);
    expect(standardHasNewer({ version: null, latest: "v2" })).toBe(false);
  });
});

// 262 号票（issue 19 第 10 条）：规范上线之前建的项目缺哪几份——按项目类型和本项目的规范改写，必须有的、这类另有的（票、运营接口清单）
// 不在、或者只有说明（目录里只有 README.md）的算缺；写了的、本项目不要的、辅助的不算。
/** 只读接口里的一份文档（目录以 / 结尾） */
const doc = (key: StandardDocView["key"], role: StandardDocView["role"], exists: boolean, extra: Partial<StandardDocView> = {}): StandardDocView => ({
  key,
  path: key === "adr" || key === "tickets" ? `${key}/` : `${key}.md`,
  role,
  exists,
  ...extra,
});

describe("现有项目补齐规范文档：缺哪几份", () => {
  test("开发类：缺的架构图、只有说明的决策记录、缺的票和运营接口清单；写了的规格、进展和辅助的几份不算", () => {
    const docs: StandardDocView[] = [
      doc("spec", "required", true),
      doc("architecture", "required", false),
      doc("progress", "required", true),
      doc("adr", "required", true, { untouched: true }),
      doc("tickets", "kind", false),
      { ...doc("ops", "before_in_use", false), path: "ops.json" },
      doc("charter", "auxiliary", true),
      doc("glossary", "auxiliary", false),
    ];
    const missing = standardBackfillDocs({ docs });
    expect(missing).toEqual([
      { key: "architecture", path: "architecture.md", state: "missing" },
      { key: "adr", path: "adr/", state: "template" },
      { key: "tickets", path: "tickets/", state: "missing" },
      { key: "ops", path: "ops.json", state: "missing" },
    ]);
    expect(missing.map(standardBackfillDocText)).toEqual(["架构图（architecture.md）", "决策记录（adr/，只有说明）", "票（tickets/）", "运营接口清单（ops.json）"]);
  });

  test("按本项目的规范改写：不要的那份不算缺，多出来的那份没建算缺（写它的名字）；都写了是空的", () => {
    const docs: StandardDocView[] = [
      doc("spec", "required", true),
      doc("architecture", "required", false, { override: "drop" }),
      doc("progress", "required", true, { override: "change" }),
      doc("adr", "required", true),
      { key: "custom", title: "运维手册", path: "runbook.md", role: "required", exists: false, override: "add" },
    ];
    expect(standardBackfillDocs({ docs })).toEqual([{ key: "custom", title: "运维手册", path: "runbook.md", state: "missing" }]);
    expect(standardBackfillDocText({ key: "custom", title: "运维手册", path: "runbook.md", state: "missing" })).toBe("运维手册（runbook.md）");
    expect(standardBackfillDocs({ docs: docs.filter((d) => d.key !== "custom") })).toEqual([]);
  });
});
