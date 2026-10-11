// 进度条上给风格用的"一共几格"（49 号票，不改样子）：看板卡、项目页内部任务一行的小进度条（TaskProgress.tsx 的 .sl-progress）
// 和流程会话标题栏上的进度条（conversation/PlanTimeline.tsx 的 .progress-bar）挂内联自定义属性 --progress-total，
// 像素小屋按它把进度条切成一格一个阶段 / 一步的 HP 格（设计稿 h-tasks 的 .hp）；经典和别的风格不认这个属性，样子不变。
// 单独一个 .ts（不带 JSX），组件测试在 Node 里直接渲染（test/ui/progress-cells.test.ts）。
import type { CSSProperties } from "react";

/** 进度条上的 style：一共几格，至少 1 格（还没有步数时样式里不除以 0） */
export function progressCells(total: number): CSSProperties {
  return { "--progress-total": String(Math.max(1, Math.round(total))) } as CSSProperties;
}
