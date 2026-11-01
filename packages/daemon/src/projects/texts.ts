// 项目模块拼给用户看的几句话（从 projects.ts 挪出来）：负责人会话里的说明、卡片的处理结果。
// 说到任务、负责人时带上名字，写成"编号「简短描述」"（"t-5「建设「记账本」首版」"、"pm-1「记账本的项目负责人」"）；
// 交给秘书的通知照旧只写编号。
// 生成时按当时的语言写（以前存下的不动）
import { maintainerIdLabel, namedIdLabel, type Project, type Task, t } from "@ergo/protocol";

/** 立项后负责人会话里的说明：谁会和用户做立项问答 */
export const kickoffNote = (project: Pick<Project, "name" | "goal" | "maintainerId">) =>
  t("projects.notes.kickoff", { name: project.name, goal: project.goal, maintainer: maintainerIdLabel(project.maintainerId, { kind: "project", name: project.name }) });

// @i18n-ignore-start model：交给负责人的通知
/**
 * 立项后叫醒负责人先开口（真模型试验里秘书说"它会问你"，负责人却等用户先说话）；立项时用户的原话原样带上
 * （路径、限制不能丢：试验里立项卡只剩一个文件名，负责人又问了一遍）
 */
export const kickoffOpeningText = (userWords: string | undefined) =>
  [
    "用户刚在卡上点了“立项”，还没和你说过话。不用等用户开口：你先说出你对这个项目的理解，问第一轮问题（一次一两个）。",
    ...(userWords ? ["立项时用户的原话（路径、文件名、限制、数字以这里为准，先读能读的、原样记进规格，已经说清的别再问）：", userWords] : []),
  ].join("\n");
// @i18n-ignore-end

/** 立项书卡"确认并开工"的处理结果 */
export const buildTaskNote = (task: Pick<Task, "id" | "title">) => t("projects.notes.firstBuildTask", { task: namedIdLabel(task.id, task.title) });

/** 立项书确认后负责人会话里说明的最后一句：首个建设任务建出来了 */
export const charterBuildText = (task: Pick<Task, "id" | "title">) => t("projects.notes.firstBuildCreated", { task: namedIdLabel(task.id, task.title) });

/** "首版做完了"卡上选继续建设的处理结果 */
export const nextBuildNote = (task: Pick<Task, "id" | "title">) => t("projects.notes.nextBuildTask", { task: namedIdLabel(task.id, task.title) });

/** 选继续建设后负责人会话里说明的后半句（前面是"你在…卡上选了继续建设：「…」。"） */
export const nextBuildText = (task: Pick<Task, "id" | "title">) => t("projects.notes.nextBuildCreated", { task: namedIdLabel(task.id, task.title) });
