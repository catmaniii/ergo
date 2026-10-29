// 不属于项目的任务干活的文件夹：Task.workdir（305 号票新建时选的工作文件夹、290 号票接管来的会话原来的工作目录，在数据目录外面）
// 有就是它（真实路径），没有的是产出区里任务自己的那一格 outputs/<任务 id>。维护者的 cwd（maintainers.ts 的 taskCwd）、
// 阶段验收的脚本和评审、重注入块里写的工作目录、做完告诉秘书的交付文件、守卫认的"交出去了的交付件"都按同一处，不能各拼各的。
import path from "node:path";
import type { Task } from "@ergo/protocol";
import { realPathOf } from "../util/real-path.ts";

/** 任务干活的文件夹（项目的任务另按项目的工作目录，调用方先看项目） */
export function taskWorkdir(task: Pick<Task, "id" | "workdir">, outputsDir: string): string {
  if (task.workdir !== undefined) return realPathOf(task.workdir) ?? task.workdir;
  return path.join(outputsDir, task.id);
}
