// 维护者此刻的装配（13 号票起执行时按确认的计划；20 号票：子 agent 的装配从它收窄）。
// 任务自己的维护者由 maintainers.ts 算出（Maintainers.assemblyOf），项目维护者的由 16 号票接上。
import type { ShellToolkit } from "../typed-shell/index.ts";

export interface MaintainerAssembly {
  /** 维护者的工作目录（真实路径）：子 agent 没给自己的目录时就在这里干活 */
  cwd: string;
  toolkit: ShellToolkit;
  /** pi 的内置工具（开了 bash 的含 bash） */
  piTools: readonly string[];
  /** 守护进程代为执行的工具的名字（推进任务的、提议并行、带类型的 bash 工具……）：子 agent 的只能是它们的子集 */
  hostTools: readonly string[];
  /** 守卫的围栏：项目档案（子 agent 写它一律拒绝）、工作目录（含绑定的外部路径） */
  projectRecords: readonly string[];
  workingDirs: readonly string[];
  /**
   * 开发类：并行时每个子 agent 必须有自己的、建在工作目录里的 git worktree。任务自己的维护者没有项目类型，
   * 工作目录是 git 仓库时按开发类算；项目维护者按立项书的项目类型（16 号票接）
   */
  development: boolean;
}
