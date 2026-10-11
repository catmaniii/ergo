// 进度条上给风格用的"一共几格"（49 号票，ui/progress-cells.ts）：看板卡、项目页内部任务一行的小进度条（TaskProgress.tsx）、
// 流程会话标题栏上的进度条（PlanTimeline.tsx 的 PlanProgress）挂内联自定义属性 --progress-total，像素小屋按它画 HP 格。
// 直接用 React 在 Node 里把这两个组件渲染出来查：属性挂在哪个元素上、值对不对（不带单位，至少 1 格）。
// 步数多时格数封顶是样式的事（style.css 的 --pixel-hp-max），这里挂的照旧是真实的步数，见 test/visual-styles/pixel.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PlanProgress } from "../../src/ui/conversation/PlanTimeline.tsx";
import { progressCells } from "../../src/ui/progress-cells.ts";
import { TaskProgress } from "../../src/ui/TaskProgress.tsx";

describe("TaskProgress：小进度条上挂着一共几格", () => {
  test.each([
    [{ done: 1, total: 3, unit: "stage" as const }, 3],
    [{ done: 4, total: 10, unit: "step" as const }, 10],
    [{ done: 20, total: 30, unit: "step" as const, run: 2 }, 30],
  ])("%o → sl-progress 上 --progress-total: %s，做完那一截照旧按 做完 ÷ 一共", (progress, cells) => {
    const html = renderToStaticMarkup(createElement(TaskProgress, { progress }));
    const width = `${(progress.done / progress.total) * 100}%`;
    expect(html).toContain(`<span class="sl-progress" style="--progress-total:${cells}"><i style="width:${width}"></i></span>`);
  });

  test("没有计划的不画进度条", () => {
    expect(renderToStaticMarkup(createElement(TaskProgress, { progress: { done: 0, total: 0, unit: "step" } }))).not.toContain("--progress-total");
  });
});

describe("PlanProgress：流程会话标题栏的进度条上挂着一共几格", () => {
  test.each([
    [{ done: 0, total: 3, version: 1 }, 3],
    [{ done: 7, total: 20, version: 2, run: { no: 3 } }, 20],
  ])("%o → progress-bar 上 --progress-total: %s，里面是 progress-fill", (progress, cells) => {
    const html = renderToStaticMarkup(createElement(PlanProgress, { progress, onOpen: () => {} }));
    const width = `${(progress.done / progress.total) * 100}%`;
    expect(html).toContain(`<div class="progress-bar" style="--progress-total:${cells}"><div class="progress-fill" style="width:${width}"></div></div>`);
  });
});

describe("progressCells：一共几格取整、至少 1 格（样式里不除以 0）", () => {
  test.each([
    [4, "4"],
    [1, "1"],
    [0, "1"],
    [2.6, "3"],
  ])("一共 %s → --progress-total: %s", (total, cells) => {
    expect(progressCells(total)).toEqual({ "--progress-total": cells });
  });
});
