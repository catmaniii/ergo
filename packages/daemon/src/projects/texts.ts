// 项目模块拼给用户看的几句话（159 号票起从 projects.ts 挪出来）：维护者会话里的说明、卡片的处理结果。
// 说到任务、维护者时带上名字，写成"编号「简短描述」"（163 号票："t-5「建设「记账本」首版」"、"pm-1「记账本的项目维护者」"）；
// 交给秘书的通知照旧只写编号。
// 173 号票：生成时按当时的语言写（以前存下的不动）
import { maintainerIdLabel, namedIdLabel, type Project, type Task, t } from "@ergo/protocol";

/** 立项后维护者会话里的说明：谁会和用户做立项问答 */
export const kickoffNote = (project: Pick<Project, "name" | "goal" | "maintainerId">) =>
  t("projects.notes.kickoff", { name: project.name, goal: project.goal, maintainer: maintainerIdLabel(project.maintainerId, { kind: "project", name: project.name }) });

/** 立项书卡"确认并开工"的处理结果 */
export const buildTaskNote = (task: Pick<Task, "id" | "title">) => t("projects.notes.firstBuildTask", { task: namedIdLabel(task.id, task.title) });

/** 立项书确认后维护者会话里说明的最后一句：首个建设任务建出来了 */
export const charterBuildText = (task: Pick<Task, "id" | "title">) => t("projects.notes.firstBuildCreated", { task: namedIdLabel(task.id, task.title) });

/** "首版做完了"卡上选继续建设的处理结果 */
export const nextBuildNote = (task: Pick<Task, "id" | "title">) => t("projects.notes.nextBuildTask", { task: namedIdLabel(task.id, task.title) });

/** 选继续建设后维护者会话里说明的后半句（前面是"你在…卡上选了继续建设：「…」。"） */
export const nextBuildText = (task: Pick<Task, "id" | "title">) => t("projects.notes.nextBuildCreated", { task: namedIdLabel(task.id, task.title) });
