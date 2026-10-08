// 测试里直接放进项目列表的项目（15 号票）：不走立项（不放卡、不通知秘书、维护者休眠），给别处的用例当"已有的项目"
// （比如"发起任务"时选的项目要在项目列表里）。立项本身的主切面在 test/main/projects.test.ts。
import { CHANNELS, EVENT_TYPES, nowIso, type Project, type ProjectEventPayload } from "@ergou/protocol";
import type { Daemon } from "../../src/daemon.ts";

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
