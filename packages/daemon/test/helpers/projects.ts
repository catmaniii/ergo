// 测试里直接放进项目列表的项目（15 号票）：不走立项（不放卡、不通知秘书、维护者休眠），给别处的用例当"已有的项目"
// （比如"发起任务"时选的项目要在项目列表里）。立项本身的主切面在 test/main/projects.test.ts。
import { CHANNELS, EVENT_TYPES, nowIso, type Project, type ProjectEventPayload, type Task, type TaskBrief, type TaskKind } from "@ergo/protocol";
import type { Daemon } from "../../src/daemon.ts";

/**
 * 项目里的一个任务（64 号票起只涉及一个项目的任务都是这个项目的内部任务）：项目的维护者建出、写好任务书（派起草计划的工单给它），
 * 不经通知——给只关心工单、执行的用例当"项目的任务"。从各个入口发起的主切面在 test/main/project-internal-tasks.test.ts
 */
export function projectTask(daemon: Daemon, projectName: string, title: string, brief: Omit<TaskBrief, "projects">, kind: TaskKind = "long_running"): Task {
  const task = internalTask(daemon, projectName, title, kind);
  daemon.tasks.writeBrief(task.id, { ...brief, projects: [projectName] }, byMaintainer(daemon, task.id));
  return task;
}

/** 项目里的一个内部任务（项目的维护者建出，不经通知），还没写任务书 */
export function internalTask(daemon: Daemon, projectName: string, title: string, kind: TaskKind = "long_running"): Task {
  const project = daemon.projects.list().find((p) => p.name === projectName);
  if (!project) throw new Error(`没有项目「${projectName}」`);
  return daemon.tasks.createInternal({ projectId: project.id, title, summary: title, kind }, project.maintainerId);
}

/** 项目内部任务的任务书由它的维护者写（writeBrief 的 writer） */
export function byMaintainer(daemon: Daemon, taskId: string): { maintainerId: string } {
  const task = daemon.tasks.get(taskId);
  if (!task) throw new Error(`没有任务 ${taskId}`);
  return { maintainerId: task.maintainerId };
}

export function seedProject(daemon: Daemon, name: string, overrides: Partial<Project> = {}): Project {
  const n = daemon.projects.list().length + 1;
  const time = nowIso();
  const project: Project = {
    id: `p-${n}`,
    name,
    goal: `${name}的目标`,
    state: "preparing",
    origin: "suggestion",
    maintainerId: `pm-${n}`,
    workdir: { external: false },
    charterConfirmed: false,
    createdAt: time,
    updatedAt: time,
    ...overrides,
  };
  const payload: ProjectEventPayload = { project, change: "created", from: null, by: "user" };
  daemon.store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload });
  return project;
}
