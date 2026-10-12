// 104 号票：项目页照任务页（88 号票）改——项目一览占满内容区（宽屏多列的"档案墙"，按项目状态分组，已归档默认收起，顶上一条概览），
// 点卡片、从别处跳进来整页是这个项目（宽屏会话占主区、项目详情在能开合能拖宽的档案栏里），‹、浏览器后退回一览并滚回原来的位置；
// 窄屏照旧一览 → 项目页 → 维护者会话。
import { describe, expect, test } from "vitest";
import { parseHash, toHash } from "../../src/app/route-hash.ts";
import {
  BOARD_GROUPS,
  boardFoldedOf,
  dragProjectSideWidth,
  PROJECT_SIDE_WIDTH_INITIAL,
  type Project,
  type ProjectEventPayload,
  projectFoldedOf,
  projectFoldedText,
  projectPageView,
  projectSideLayout,
  projectSideWidthOf,
  projectWall,
  replay,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type Task,
  type TaskEventPayload,
  toggleFolded,
  type UserTaskWorkOrder,
  wallScrollOnReturn,
  type WorkOrderEventPayload,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const T = "2026-10-08T09:00:00.000+08:00";

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { id, name: `项目${id}`, goal: `${id} 的目标`, state: "preparing", origin: "suggestion", maintainerId: `pm-${id}`, workdir: { external: false }, charterConfirmed: false, createdAt: T, updatedAt: T, ...overrides };
}

const projectFrame = (seq: number, p: Project) => frame("projects", seq, "project", { project: p, change: "created", from: null, by: "user" } satisfies ProjectEventPayload);

/** 项目 p-1 的一个内部任务（64 号票） */
function internal(id: string, state: Task["state"], updatedAt = T): Task {
  return { id, title: id, summary: id, state, origin: "button", maintainerId: "pm-p-1", projects: ["项目p-1"], projectIds: ["p-1"], internal: { projectId: "p-1", projectName: "项目p-1" }, createdAt: T, updatedAt };
}

const taskFrame = (seq: number, t: Task) => frame("board", seq, "task", { task: t, change: "created", from: null, by: "user" } satisfies TaskEventPayload);

/** 项目 p-1 的一个定时作业 */
function job(id: string, state: ScheduledJob["state"]): ScheduledJob {
  return {
    id,
    title: id,
    schedule: { kind: "daily", time: "09:00" },
    each: "汇总账单",
    projectId: "p-1",
    projectName: "项目p-1",
    maintainerId: "pm-p-1",
    taskId: "t-9",
    taskTitle: "记账",
    state,
    lastFailed: false,
    consecutiveFailures: 0,
    runCount: 0,
    grants: [],
    temporalRules: [],
    grantInfo: {},
    createdAt: T,
    updatedAt: T,
  };
}

const jobFrame = (seq: number, j: ScheduledJob) => frame("board", seq, "scheduled_job", { job: j, change: "registered", by: "system" } satisfies ScheduledJobEventPayload);

/** 地址里的项目页换成显示什么（App 把 #/projects… 拆成 projectId、chat、jobId 交给项目页） */
function viewAt(hash: string, wide: boolean) {
  const route = parseHash(hash);
  if (route.tab !== "projects") throw new Error(`不是项目页：${hash}`);
  return projectPageView({ wide, projectId: route.projectId, chat: route.chat, jobId: route.jobId });
}

describe("项目页显示什么：一览和项目二选一", () => {
  test("没点项目：整页是项目一览，宽屏排成多列的档案墙，窄屏一列", () => {
    expect(viewAt("#/projects", true)).toEqual({ kind: "wall", layout: "grid" });
    expect(viewAt("#/projects", false)).toEqual({ kind: "wall", layout: "list" });
  });

  test("宽屏点卡片：整页是这个项目（会话加档案栏），不再左边列表右边项目", () => {
    expect(viewAt(toHash({ tab: "projects", projectId: "p-1" }), true)).toEqual({ kind: "project", projectId: "p-1", pane: "full" });
  });

  test("从别处跳进来都直接打开整页的项目：建议立项卡的“和维护者做立项问答 ▸”（…/chat）、任务详情的“项目「X」内部”、日历里点作业（…/jobs/<作业>，点名那一行）", () => {
    expect(viewAt(toHash({ tab: "projects", projectId: "p-1", chat: true }), true)).toEqual({ kind: "project", projectId: "p-1", pane: "full" });
    expect(viewAt(toHash({ tab: "projects", projectId: "p-1", jobId: "j-1" }), true)).toEqual({ kind: "project", projectId: "p-1", pane: "full", job: "j-1" });
  });

  test("窄屏照旧：项目页、维护者会话各是一页；日历里点作业过来是项目页，点名那一行", () => {
    expect(viewAt("#/projects/p-1", false)).toEqual({ kind: "project", projectId: "p-1", pane: "page" });
    expect(viewAt("#/projects/p-1/chat", false)).toEqual({ kind: "project", projectId: "p-1", pane: "chat" });
    expect(viewAt("#/projects/p-1/jobs/j-1", false)).toEqual({ kind: "project", projectId: "p-1", pane: "page", job: "j-1" });
  });
});

describe("项目一览：按项目状态分组，顶上一条概览", () => {
  test("分组按使用中、建设中、筹备中、已停用、已归档；没有项目的组不列；同一组里先建的在前", () => {
    const state = replay([
      projectFrame(1, project("p-1", { state: "in_use", createdAt: "2026-10-02T09:00:00.000+08:00" })),
      projectFrame(2, project("p-2", { state: "archived", archivedFrom: "in_use" })),
      projectFrame(3, project("p-3", { state: "preparing" })),
      projectFrame(4, project("p-4", { state: "in_use", createdAt: "2026-10-01T09:00:00.000+08:00" })),
    ]);
    const { groups } = projectWall(state);
    expect(groups.map((g) => [g.id, g.title, g.cards.map((c) => c.view.project.id)])).toEqual([
      ["in_use", "使用中", ["p-4", "p-1"]],
      ["preparing", "筹备中", ["p-3"]],
      ["archived", "已归档", ["p-2"]],
    ]);
  });

  test("没有项目：一组都没有，概览全是 0", () => {
    const wall = projectWall(replay([]));
    expect(wall.groups).toEqual([]);
    expect(wall.overview.states.map((s) => s.n)).toEqual([0, 0, 0, 0, 0]);
  });

  test("卡片：页签写种类和状态（立项书确认前没有类型写“类型待定”）；底下一行是维护者在干什么、进行中的内部任务、定时触发的（取消了的不算）、最近一次动静", () => {
    const later = "2026-10-09T20:15:00.000+08:00";
    const state = replay([
      projectFrame(1, project("p-1", { state: "in_use", kind: "dev", charterConfirmed: true })),
      projectFrame(2, project("p-2", { state: "preparing" })),
      taskFrame(1, internal("t-1", "running", later)),
      taskFrame(2, internal("t-2", "done")),
      taskFrame(3, internal("t-3", "awaiting_confirm")),
      // 看板频道上接着任务往下编号（同一频道 seq 重复的当成补发丢掉）
      jobFrame(4, job("j-1", "active")),
      jobFrame(5, job("j-2", "paused")),
      jobFrame(6, job("j-3", "cancelled")),
      frame("activity", 1, "activity", { agentId: "pm-p-1", state: "working", since: "2026-10-09T08:00:00.000+08:00" }),
    ]);
    const [p1, p2] = projectWall(state).groups.flatMap((g) => g.cards);
    expect([p1!.kindLabel, p1!.stateLabel, p1!.activity, p1!.internalOpen, p1!.scheduled, p1!.lastAt]).toEqual(["开发类", "使用中", "working", 2, 2, later]);
    expect([p2!.kindLabel, p2!.stateLabel, p2!.activity, p2!.internalOpen, p2!.scheduled, p2!.lastAt]).toEqual(["类型待定", "筹备中", "sleeping", 0, 0, T]);
  });

  test("最近一次动静也看维护者的活动、项目的工单", () => {
    const orderAt = "2026-10-10T07:30:00.000+08:00";
    const order: UserTaskWorkOrder = { id: "wo-1", projectId: "p-1", maintainerId: "pm-p-1", source: "user_task", kind: "plan", taskId: "t-9", taskTitle: "记账", title: "起草计划：记账", state: "pending", createdAt: T, updatedAt: orderAt };
    const activity = frame("activity", 1, "activity", { agentId: "pm-p-1", state: "sleeping", since: "2026-10-09T08:00:00.000+08:00" });
    const onlyActivity = replay([projectFrame(1, project("p-1", { state: "in_use" })), activity]);
    expect(projectWall(onlyActivity).groups[0]!.cards[0]!.lastAt).toBe("2026-10-09T08:00:00.000+08:00");
    const withOrder = replay([
      projectFrame(1, project("p-1", { state: "in_use" })),
      activity,
      frame("projects", 2, "work_order", { workOrder: order, change: "created", from: null, by: "system" } satisfies WorkOrderEventPayload),
    ]);
    expect(projectWall(withOrder).groups[0]!.cards[0]!.lastAt).toBe(orderAt);
  });

  test("概览：各状态几个（一个都没有的也列）、维护者在干活的（已归档的不算）、进行中的内部任务、定时触发的", () => {
    const state = replay([
      projectFrame(1, project("p-1", { state: "in_use" })),
      projectFrame(2, project("p-2", { state: "in_use" })),
      projectFrame(3, project("p-3", { state: "building" })),
      projectFrame(4, project("p-4", { state: "archived", archivedFrom: "retired" })),
      taskFrame(1, internal("t-1", "running")),
      jobFrame(2, job("j-1", "active")),
      frame("activity", 1, "activity", { agentId: "pm-p-1", state: "working", since: T }),
      frame("activity", 2, "activity", { agentId: "pm-p-4", state: "working", since: T }),
    ]);
    const { overview } = projectWall(state);
    expect(overview.states.map((s) => `${s.label} ${s.n}`)).toEqual(["使用中 2", "建设中 1", "筹备中 0", "已停用 0", "已归档 1"]);
    expect([overview.working, overview.internalOpen, overview.scheduled]).toEqual([1, 1, 1]);
  });
});

describe("分组收起：照看板（90 号票），按设备记住，默认已归档收起；和任务看板分开记", () => {
  test("没记过：已归档收起，其它展开", () => {
    expect([...projectFoldedOf(null)]).toEqual(["archived"]);
  });

  test("记过的按记的：空串是全展开；认不出的组名（比如任务看板的组）丢掉", () => {
    expect([...projectFoldedOf("")]).toEqual([]);
    expect([...projectFoldedOf("retired,archived")]).toEqual(["retired", "archived"]);
    expect([...projectFoldedOf("waiting,in_use")]).toEqual(["in_use"]);
  });

  test("和默认一样不记；不一样的按一览上的先后连起来；点一下标题收起 / 展开", () => {
    expect(projectFoldedText(new Set(["archived"]))).toBeUndefined();
    expect(projectFoldedText(new Set())).toBe("");
    expect(projectFoldedText(toggleFolded(new Set(["archived"]), "in_use"))).toBe("in_use,archived");
    expect([...toggleFolded(new Set(["archived"] as const), "archived")]).toEqual([]);
  });

  test("任务看板的组名和项目的不混：看板照旧认它自己的", () => {
    expect([...boardFoldedOf("in_use,archived")]).toEqual(["archived"]);
    expect(BOARD_GROUPS).toContain("archived");
  });
});

describe("从项目回到一览：滚回离开时的位置（宽窄屏一样）", () => {
  test("离开过的滚回去；没离开过（刚打开、切到别的页再回来、从别处直接跳进项目再回来）从顶上开始", () => {
    expect(wallScrollOnReturn(720)).toBe(720);
    expect(wallScrollOnReturn(undefined)).toBeUndefined();
  });
});

describe("宽屏项目的档案栏：能开合、能拖宽（照长程任务的阶段栏）", () => {
  test("按设备记住的开着就开着、藏掉就藏掉；日历里点作业过来的这一次开着（好看到那一行）", () => {
    expect(projectSideLayout({ pref: "open" })).toBe("side");
    expect(projectSideLayout({ pref: "closed" })).toBe("closed");
    expect(projectSideLayout({ pref: "closed", job: "j-1" })).toBe("side");
  });

  test("宽度：初值 380（比阶段栏宽）；最窄 280，最宽外框的 60%；记住的值认不出、太窄的按初值", () => {
    expect(PROJECT_SIDE_WIDTH_INITIAL).toBe(380);
    expect(dragProjectSideWidth(380, -200, 1280)).toBe(280);
    expect(dragProjectSideWidth(380, 600, 1280)).toBe(768);
    expect(dragProjectSideWidth(380, 40, 1280)).toBe(420);
    expect(dragProjectSideWidth(380, 200, 600)).toBe(440);
    expect(projectSideWidthOf(null)).toBe(380);
    expect(projectSideWidthOf("abc")).toBe(380);
    expect(projectSideWidthOf("200")).toBe(380);
    expect(projectSideWidthOf("460")).toBe(460);
  });
});
