// 项目页的布局（纯函数，104 号票，用户 2026-10-12："项目页面也和任务改成类似的风格吧：项目一览全屏显示，点击项目卡片进入全屏的
// 和项目维护者的对话和详情界面……全屏的项目一览和管理界面的风格要和任务一览和管理界面体现出一定视觉差异"）。照 88 号票任务页的做法：
// - 项目一览和项目二选一：没点项目时整页是项目一览（宽屏每组排成多列的"档案墙"，窄屏一列），按项目状态分组（使用中、建设中、
//   筹备中、已停用、已归档；没有项目的组不列），每组标题点一下收起 / 展开，按设备记住，默认已归档收起（照 90 号票的看板分组）；
//   顶上一条概览（各状态几个、维护者在干活的、进行中的内部任务、定时触发的）；
// - 宽屏点卡片、从别处跳进来（#/projects/<项目>，也认 …/chat、…/jobs/<作业>）整页是这个项目：和维护者的会话占主区，项目的详情
//   （项目头、立项书、内部任务、定时触发的、工单流水线、工具包、范围记录、维护者）在会话左边的档案栏里，栏顶 × 整栏藏掉、
//   标题栏左边的"项目档案"标签再打开，分界线能拖，开合和宽度按设备记住（照长程任务的阶段栏）；日历里点作业过来时这一次把档案栏打开；
// - 窄屏照旧：一览 → 项目页（#/projects/<项目>）→ 维护者会话（…/chat）；
// - 从项目回到一览时滚回离开时的位置（宽窄屏一样，照 88 号票用户定的任务看板）。
import { type ActivityState, isInternalTo, PROJECT_KIND_LABEL, PROJECT_STATE_LABEL, t, UNFINISHED_TASK_STATES } from "./protocol.ts";
import { foldedOf, foldedText } from "./board-fold.ts";
import { PROJECT_GROUPS, type ProjectView, projectViews } from "./projects.ts";
import type { StageSidePref } from "./task-page.ts";
import type { UiState } from "./ui-state.ts";

/** 项目一览的一组：按项目状态 */
export type ProjectGroup = (typeof PROJECT_GROUPS)[number];

/**
 * 项目页现在显示什么：项目一览（宽屏 grid 多列档案墙、窄屏 list 一列），或者一个项目——宽屏 full（会话 + 档案栏，整页），
 * 窄屏 page（项目页）或 chat（维护者会话）。job 是日历里点名的那个定时作业（项目详情里那一行高亮）
 */
export type ProjectPageView = { kind: "wall"; layout: "grid" | "list" } | { kind: "project"; projectId: string; pane: "full" | "page" | "chat"; job?: string };

/** 地址拆出来的项目、会话、作业（#/projects/<项目>、…/chat、…/jobs/<作业>）加上宽窄，定项目页显示什么 */
export function projectPageView(at: { wide: boolean; projectId?: string | undefined; chat?: boolean | undefined; jobId?: string | undefined }): ProjectPageView {
  if (!at.projectId) return { kind: "wall", layout: at.wide ? "grid" : "list" };
  const job = at.jobId ? { job: at.jobId } : {};
  if (at.wide) return { kind: "project", projectId: at.projectId, pane: "full", ...job };
  return at.chat ? { kind: "project", projectId: at.projectId, pane: "chat" } : { kind: "project", projectId: at.projectId, pane: "page", ...job };
}

/** 一览上的一张项目卡（像一份档案：上沿页签写种类和状态，正文是名字和一句话目标，底下一行是现在的动静） */
export interface ProjectCard {
  readonly view: ProjectView;
  /** 页签上的种类：开发类、其他；立项书确认之前没有类型，写"类型待定" */
  readonly kindLabel: string;
  readonly stateLabel: string;
  /** 维护者在干什么（休眠、干活中……） */
  readonly activity: ActivityState;
  /** 进行中的内部任务（64 号票：维护者在项目里执行的、还没结束的） */
  readonly internalOpen: number;
  /** 定时触发的（76 号票：这个项目名下没取消的定时作业） */
  readonly scheduled: number;
  /** 最近一次动静：项目自己、维护者的活动、内部任务、工单最近一次变化的时间 */
  readonly lastAt: string;
}

export interface ProjectWallGroup {
  readonly id: ProjectGroup;
  readonly title: string;
  readonly cards: readonly ProjectCard[];
}

/** 一览顶上的概览 */
export interface ProjectOverview {
  /** 各状态几个（使用中、建设中、筹备中、已停用、已归档，一个都没有的也列） */
  readonly states: readonly { readonly state: ProjectGroup; readonly label: string; readonly n: number }[];
  /** 维护者在干活的项目 */
  readonly working: number;
  /** 所有项目进行中的内部任务 */
  readonly internalOpen: number;
  /** 所有项目定时触发的（没取消的） */
  readonly scheduled: number;
}

export interface ProjectWall {
  /** 有项目的组，按使用中、建设中、筹备中、已停用、已归档；同一组里先建的在前（projectViews 的先后） */
  readonly groups: readonly ProjectWallGroup[];
  readonly overview: ProjectOverview;
}

const latest = (times: readonly string[]): string => times.reduce((a, b) => (b > a ? b : a));

function cardOf(state: UiState, view: ProjectView): ProjectCard {
  const p = view.project;
  const internal = Object.values(state.tasks).filter((x) => isInternalTo(x, p.id));
  const since = state.activity[p.maintainerId]?.since;
  const orders = Object.values(state.workOrders).filter((w) => w.projectId === p.id);
  return {
    view,
    kindLabel: p.kind ? PROJECT_KIND_LABEL[p.kind] : t("state.projectPage.kindPending"),
    stateLabel: PROJECT_STATE_LABEL[p.state],
    activity: view.activity.state,
    internalOpen: internal.filter((x) => UNFINISHED_TASK_STATES.includes(x.state)).length,
    scheduled: Object.values(state.scheduledJobs).filter((j) => j.projectId === p.id && j.state !== "cancelled").length,
    lastAt: latest([p.updatedAt, ...(since ? [since] : []), ...internal.map((x) => x.updatedAt), ...orders.map((w) => w.updatedAt)]),
  };
}

/** 项目一览：按状态分组（没有项目的组不列）和顶上的概览 */
export function projectWall(state: UiState): ProjectWall {
  const cards = projectViews(state).map((v) => cardOf(state, v));
  const groups = PROJECT_GROUPS.map((id) => ({ id, title: PROJECT_STATE_LABEL[id], cards: cards.filter((c) => c.view.project.state === id) })).filter((g) => g.cards.length > 0);
  const live = cards.filter((c) => c.view.project.state !== "archived");
  return {
    groups,
    overview: {
      states: PROJECT_GROUPS.map((s) => ({ state: s, label: PROJECT_STATE_LABEL[s], n: cards.filter((c) => c.view.project.state === s).length })),
      working: live.filter((c) => c.activity === "working").length,
      internalOpen: cards.reduce((n, c) => n + c.internalOpen, 0),
      scheduled: cards.reduce((n, c) => n + c.scheduled, 0),
    },
  };
}

// ───────────────────────── 分组收起（照 90 号票的看板，另记一份） ─────────────────────────

/** 没记过时收起的组：已归档 */
export const PROJECT_FOLDED_DEFAULT: readonly ProjectGroup[] = ["archived"];

/** 这台设备记住的值怎么认：没记过按默认（已归档收起），空串是全展开，认不出的组名丢掉 */
export function projectFoldedOf(raw: string | null): ReadonlySet<ProjectGroup> {
  return foldedOf(raw, PROJECT_GROUPS, PROJECT_FOLDED_DEFAULT);
}

/** 要记下的值：和默认一样时是 undefined（擦掉），否则按一览上的先后连起来 */
export function projectFoldedText(folded: ReadonlySet<ProjectGroup>): string | undefined {
  return foldedText(folded, PROJECT_GROUPS, PROJECT_FOLDED_DEFAULT);
}

// ───────────────────────── 回到一览、档案栏 ─────────────────────────

/**
 * 一览挂上时滚到哪（undefined 是不管，从顶上开始）：从项目回来时滚回离开一览时的位置（saved），宽窄屏一样；
 * 没离开过（刚打开、切到别的页再回来、从别处直接跳进项目再回来）从顶上开始
 */
export function wallScrollOnReturn(saved: number | undefined): number | undefined {
  return saved;
}

/**
 * 宽屏项目的档案栏：开着（会话左边）还是藏掉（会话占满，点标题栏左边的"项目档案"再打开）。按设备记住的值（读写在
 * app/stage-side-setting.ts，另一个键）；日历里点作业过来的（job）这一次开着，好看到那一行，不写进设置
 */
export function projectSideLayout(at: { pref: StageSidePref; job?: string | undefined }): "side" | "closed" {
  return at.job || at.pref === "open" ? "side" : "closed";
}

/** 档案栏的宽度初值：比阶段栏（320）宽，工单流水线、定时作业那几行排得开 */
export const PROJECT_SIDE_WIDTH_INITIAL = 380;

/** 最窄 */
const PROJECT_SIDE_WIDTH_MIN = 280;

/** 拖分界线（照阶段栏 dragStageSideWidth）：最窄 280，最宽外框宽的 60%（外框窄时也至少能拖到 440） */
export function dragProjectSideWidth(width: number, dx: number, frameWidth: number): number {
  return Math.min(Math.max(440, frameWidth * 0.6), Math.max(PROJECT_SIDE_WIDTH_MIN, width + dx));
}

/** 这台设备记住的宽度怎么认：认不出、比最窄还窄的按初值 */
export function projectSideWidthOf(raw: string | null): number {
  const w = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(w) && w >= PROJECT_SIDE_WIDTH_MIN ? w : PROJECT_SIDE_WIDTH_INITIAL;
}
