// 项目页上的"规范"一块（258 号票）的状态层：用的哪一版规范；必须有的几份（开发类四份，其他类三份）写了、只有模板（还是模板原样）、
// 缺（不在）；类型还没定时按其他类的三份；规范上线之前建的项目没有版本；辅助的几份、开发类另有的（tickets/、ops.json）不在这一块。
// 261 号票：本项目的规范改写——不要的那份说"本项目不要"、换写法的标出来、多出来的接在后面（名字是改写里写的），列出和默认规范哪里不同；
// 模板出了新版提示"有新版"（不自动跟）；"规范改写"卡逐处对照（改前、改后，跟新版规范写版本），项目页"规范"一块下列这个项目的几张卡。
// 262 号票："补齐规范文档"卡上缺的每一份一行（名字、位置、缺还是只有说明），项目页"规范"一块下也列它。
import { describe, expect, test } from "vitest";
import {
  type ProjectStandardView,
  projectStandardBlock,
  projectStandardCards,
  replay,
  type StandardBackfillCardPayload,
  standardBackfillRows,
  type StandardChangeCardPayload,
  standardChangeRows,
} from "../../src/state/index.ts";
import { card, frame } from "./events.ts";

const AT = "2026-10-24T09:00:00.000+08:00";

function view(overrides: Partial<ProjectStandardView> = {}): ProjectStandardView {
  return {
    projectId: "p-1",
    version: "v1",
    latest: "v1",
    kind: "dev",
    docs: [
      { key: "spec", path: "spec.md", role: "required", exists: true, modifiedAt: AT, untouched: false },
      { key: "architecture", path: "architecture.md", role: "required", exists: false },
      { key: "progress", path: "progress.md", role: "required", exists: true, modifiedAt: AT, untouched: true },
      { key: "adr", path: "adr/", role: "required", exists: true, modifiedAt: AT, untouched: false },
      { key: "tickets", path: "tickets/", role: "kind", exists: true, modifiedAt: AT, untouched: true },
      { key: "ops", path: "ops.json", role: "before_in_use", exists: true, modifiedAt: AT, untouched: true },
      { key: "charter", path: "charter.md", role: "auxiliary", exists: true, modifiedAt: AT },
    ],
    checklist: { from: "building", to: "in_use", items: [{ id: "progress_written", label: "进展已写回", done: false }] },
    overrides: [],
    ...overrides,
  };
}

describe("项目页上的规范", () => {
  test("开发类：版本，四份必须有的各是写了、缺、只有模板；不列辅助的和 tickets/、ops.json；没有改写、没有新版", () => {
    expect(projectStandardBlock(view())).toEqual({
      version: "v1",
      newer: null,
      kindPending: false,
      docs: [
        { key: "spec", label: "规格", path: "spec.md", state: "written", stateLabel: "已写" },
        { key: "architecture", label: "架构图", path: "architecture.md", state: "missing", stateLabel: "缺" },
        { key: "progress", label: "进展", path: "progress.md", state: "template", stateLabel: "只有模板" },
        { key: "adr", label: "决策记录", path: "adr/", state: "written", stateLabel: "已写" },
      ],
      overrides: [],
    });
  });

  test("类型还没定（立项书确认之前）：按其他类的三份；规范上线之前建的项目没有版本", () => {
    const pending = projectStandardBlock(
      view({
        kind: null,
        docs: [
          { key: "spec", path: "spec.md", role: "required", exists: true, modifiedAt: AT, untouched: true },
          { key: "progress", path: "progress.md", role: "required", exists: true, modifiedAt: AT, untouched: true },
          { key: "adr", path: "adr/", role: "required", exists: true, modifiedAt: AT, untouched: true },
        ],
      }),
    );
    expect(pending.kindPending).toBe(true);
    expect(pending.docs.map((d) => [d.key, d.state])).toEqual([
      ["spec", "template"],
      ["progress", "template"],
      ["adr", "template"],
    ]);
    expect(projectStandardBlock(view({ version: null })).version).toBeNull();
  });

  test("本项目的规范改写（261 号票）：不要的说本项目不要，换写法的标出来，多出来的用改写里的名字；列出和默认规范哪里不同", () => {
    const block = projectStandardBlock(
      view({
        docs: [
          { key: "spec", path: "spec.md", role: "required", exists: true, modifiedAt: AT, untouched: false },
          { key: "architecture", path: "architecture.md", role: "required", exists: false, override: "drop" },
          { key: "progress", path: "progress.md", role: "required", exists: true, modifiedAt: AT, untouched: false, override: "change" },
          { key: "adr", path: "adr/", role: "required", exists: true, modifiedAt: AT, untouched: true },
          { key: "custom", title: "运维手册", path: "runbook.md", role: "required", exists: false, override: "add" },
        ],
        overrides: [
          { kind: "drop", doc: "architecture", path: "architecture.md", summary: "不要架构图", why: "小工具", revision: 1, confirmedAt: AT },
          { kind: "change", doc: "progress", note: "按周写", path: "progress.md", summary: "进展换一种写法：按周写", why: "小工具", revision: 1, confirmedAt: AT },
          { kind: "add", path: "runbook.md", title: "运维手册", note: "怎么重启", summary: "多一份「运维手册」（runbook.md）：怎么重启", why: "要手册", revision: 2, confirmedAt: AT },
        ],
      }),
    );
    expect(block.docs).toEqual([
      { key: "spec", label: "规格", path: "spec.md", state: "written", stateLabel: "已写" },
      { key: "architecture", label: "架构图", path: "architecture.md", state: "dropped", stateLabel: "本项目不要", override: "drop" },
      { key: "progress", label: "进展", path: "progress.md", state: "written", stateLabel: "已写", override: "change" },
      { key: "adr", label: "决策记录", path: "adr/", state: "template", stateLabel: "只有模板" },
      { key: "custom:runbook.md", label: "运维手册", path: "runbook.md", state: "missing", stateLabel: "缺", override: "add" },
    ]);
    expect(block.overrides).toEqual([
      { key: "doc:architecture", summary: "不要架构图", meta: "第 1 次改写，2026-10-24 确认" },
      { key: "doc:progress", summary: "进展换一种写法：按周写", meta: "第 1 次改写，2026-10-24 确认" },
      { key: "path:runbook.md", summary: "多一份「运维手册」（runbook.md）：怎么重启", meta: "第 2 次改写，2026-10-24 确认" },
    ]);
  });

  test("模板出了新版（项目用的旧了）：提示有新版；规范上线之前建的（没有版本）不提示", () => {
    expect(projectStandardBlock(view({ version: "v1", latest: "v2" })).newer).toBe("v2");
    expect(projectStandardBlock(view({ version: null, latest: "v2" })).newer).toBeNull();
  });
});

const change = (projectId: string, revision: number, extra: Partial<StandardChangeCardPayload> = {}): StandardChangeCardPayload => ({
  projectId,
  projectName: "记账本",
  revision,
  why: "小工具",
  items: [{ after: { kind: "drop", doc: "architecture" } }],
  ...extra,
});

describe("规范改写卡（261 号票）", () => {
  test("逐处对照：规范里那份写名字、多出来的写名字和位置；没有改写的一边写照默认规范；跟新版规范写版本，在最前", () => {
    expect(
      standardChangeRows(
        change("p-1", 1, {
          upgrade: { from: "v1", to: "v2" },
          items: [
            { after: { kind: "drop", doc: "architecture" } },
            { before: { kind: "change", doc: "progress", note: "按周写" }, after: { kind: "change", doc: "progress", note: "按月写" } },
            { after: { kind: "add", path: "runbook.md", title: "运维手册", note: "怎么重启" } },
            { before: { kind: "drop", doc: "tickets" } },
          ],
        }),
      ),
    ).toEqual([
      { key: "upgrade", label: "规范版本", before: "v1", after: "v2" },
      { key: "doc:architecture", label: "架构图", before: "照默认规范", after: "本项目不要" },
      { key: "doc:progress", label: "进展", before: "换一种写法：按周写", after: "换一种写法：按月写" },
      { key: "path:runbook.md", label: "「运维手册」（runbook.md）", before: "照默认规范", after: "多出来的一份：怎么重启" },
      { key: "doc:tickets", label: "票", before: "本项目不要", after: "照默认规范" },
    ]);
  });

  test("272 号票：规范上线之前建的项目补齐规范文档（没有从哪一版）：改前写没有记版本", () => {
    expect(standardChangeRows(change("p-1", 1, { upgrade: { to: "v1", missing: [{ key: "ops", path: "ops.json", state: "missing" }] }, items: [] }))).toEqual([
      { key: "upgrade", label: "规范版本", before: "没有记版本（规范上线之前建的）", after: "v1" },
    ]);
  });

  test("项目页\"规范\"一块下列这个项目的几张（先提的在前），别的项目的、别的卡不列", () => {
    const state = replay([
      frame("cards", 1, "card", { card: card("c-2", 1, { type: "standard_change", payload: change("p-1", 2), createdAt: "2026-10-24T10:00:00.000+08:00" }) }),
      frame("cards", 2, "card", { card: card("c-1", 1, { type: "standard_change", payload: change("p-1", 1), createdAt: "2026-10-24T09:00:00.000+08:00" }) }),
      frame("cards", 3, "card", { card: card("c-3", 1, { type: "standard_change", payload: change("p-2", 1) }) }),
      frame("cards", 4, "card", { card: card("c-4", 1, { type: "charter_change", payload: { projectId: "p-1" } }) }),
    ]);
    expect(projectStandardCards(state, "p-1")).toEqual(["c-1", "c-2"]);
    expect(projectStandardCards(state, "p-3")).toEqual([]);
  });
});

const backfill = (projectId: string, extra: Partial<StandardBackfillCardPayload> = {}): StandardBackfillCardPayload => ({
  projectId,
  projectName: "简报站",
  kind: "dev",
  version: "v1",
  missing: [{ key: "architecture", path: "architecture.md", state: "missing" }],
  ...extra,
});

describe("补齐规范文档卡（262 号票）", () => {
  test("缺的每一份一行：名字、位置、缺还是只有说明；改写里多出来的写它的名字", () => {
    expect(
      standardBackfillRows(
        backfill("p-1", {
          missing: [
            { key: "architecture", path: "architecture.md", state: "missing" },
            { key: "adr", path: "adr/", state: "template" },
            { key: "custom", title: "运维手册", path: "runbook.md", state: "missing" },
          ],
        }),
      ),
    ).toEqual([
      { key: "architecture", label: "架构图", path: "architecture.md", state: "missing", stateLabel: "缺" },
      { key: "adr", label: "决策记录", path: "adr/", state: "template", stateLabel: "只有说明" },
      { key: "custom:runbook.md", label: "运维手册", path: "runbook.md", state: "missing", stateLabel: "缺" },
    ]);
  });

  test("项目页\"规范\"一块下也列这个项目的补齐规范文档卡，和规范改写卡按出来的先后排；别的项目的不列", () => {
    const state = replay([
      frame("cards", 1, "card", { card: card("c-change", 1, { type: "standard_change", payload: change("p-1", 1), createdAt: "2026-10-25T10:00:00.000+08:00" }) }),
      frame("cards", 2, "card", { card: card("c-backfill", 1, { type: "standard_backfill", payload: backfill("p-1"), createdAt: "2026-10-25T09:00:00.000+08:00" }) }),
      frame("cards", 3, "card", { card: card("c-other", 1, { type: "standard_backfill", payload: backfill("p-2") }) }),
    ]);
    expect(projectStandardCards(state, "p-1")).toEqual(["c-backfill", "c-change"]);
    expect(projectStandardCards(state, "p-2")).toEqual(["c-other"]);
  });
});
