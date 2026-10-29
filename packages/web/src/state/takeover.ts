// 从运行时已有的会话接管（290 号票）在网页这一侧（纯函数）：新建任务、项目时选了能接管已有会话的运行时（Claude Code），对话框里多一个
// "从 Claude Code 会话接管"的入口；点进去列本机的会话（GET /api/runtimes/<运行时>/sessions，每次现取），选一个：
// - 空闲的直接接；被占着的（终端里开着、后台会话在跑、二狗自己的任务 / 项目在管、查不到占没占）不直接接——终端里开着的会话没有锁，
//   直接接会分叉、丢掉一边的话——先在那边关掉再刷新，或者勾上"分叉一份接管"（原会话不动）；
// - 接成任务要写"接着让它做什么"（第一条输入）；接成项目可以不写（一句话目标，空着用会话标题）；
// - 工作目录用会话原来的（守卫的项目目录就是它）。
// 行里的说法：标题、工作目录、分支 · 最近活动 · 大小，被占着的写明在哪。⚙ 里接管来的那一行（交还 / 收回）的说法也在这里。
// 292 号票（交给官方 App、再收回来）：⚙ 里那一块按会话现在在哪边（二狗接管 / 官方 App / 空着）给说法和按钮——二狗接管着的"交给官方 App"
// （接管来的另有"交还给 X"）；在官方 App 里的写明、给链接、"收回到<名字>"；空着的"收回到<名字>"和"交给官方 App"。二狗自己开的会话（还没交过的
// 没有接管记录）也有"交给官方 App"。任务卡、项目卡上的"在官方 App 里"和链接（remoteBadgeOf）也在这里。
import { sizeLabel } from "./detail-content.ts";
import { type AgentRuntimeStateView, type AgentRuntimeView, type ResumableSessionView, type RuntimeTakeover, t, type TakeoverAction, type TakeoverKind, takeoverPlaceOf } from "./protocol.ts";

/** 能接管已有会话的运行时（现在能用、能力清单 take_over）；没有是 undefined */
export function takeoverRuntime(runtimes: readonly AgentRuntimeView[] | undefined, runtime: string): AgentRuntimeView | undefined {
  const found = runtimes?.find((r) => r.id === runtime);
  return found?.available && found.capabilities.take_over ? found : undefined;
}

/** 月-日 时:分（再早的最近活动这样写） */
function timeLabel(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}

/** 最近活动的说法：刚才、几分钟前、几小时前，再早的写日期时间 */
export function activityAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return timeLabel(iso);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("state.takeover.justNow");
  if (minutes < 60) return t("state.takeover.minutesAgo", { count: minutes, n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("state.takeover.hoursAgo", { count: hours, n: hours });
  return timeLabel(iso);
}

/** 一个会话那一行的第二行：分支 · 最近活动 · 大小（有的才写） */
export function sessionMetaLine(session: ResumableSessionView, now: number): string {
  return [session.branch ? t("state.takeover.branch", { branch: session.branch }) : undefined, activityAgo(session.updatedAt, now), session.bytes === undefined ? undefined : sizeLabel(session.bytes)]
    .filter((s): s is string => s !== undefined)
    .join(" · ");
}

/** 选中一个会话之后：能不能直接接、要不要分叉才能接、给人看的说明 */
export interface TakeoverPick {
  /** 被占着（只能分叉接管） */
  busy: boolean;
  /** 选中被占着的那个时下面那一段说明 */
  note: string | undefined;
}

export function takeoverPick(session: ResumableSessionView, runtimeTitle: string): TakeoverPick {
  if (session.busy === undefined) return { busy: false, note: undefined };
  if (session.heldBy) return { busy: true, note: t("state.takeover.heldNote", { busy: session.busy, runtime: runtimeTitle }) };
  return { busy: true, note: t("state.takeover.busyNote", { busy: session.busy, runtime: runtimeTitle }) };
}

/** 能不能点"接管"：选了会话；被占着的要勾上分叉；接成任务的要写接着做什么 */
export function takeoverReady(input: { session: ResumableSessionView | undefined; fork: boolean; as: TakeoverKind; request: string }): boolean {
  if (!input.session) return false;
  if (input.session.busy !== undefined && !input.fork) return false;
  return input.as === "project" || input.request.trim() !== "";
}

/** 接管好了的提示 */
export function takeoverToast(input: { as: TakeoverKind; id: string; title: string; fork: boolean; runtimeTitle: string }): string {
  const what = input.as === "task" ? t("state.takeover.toastTask", { id: input.id, title: input.title }) : t("state.takeover.toastProject", { id: input.id, title: input.title });
  return input.fork ? t("state.takeover.toastForked", { what, runtime: input.runtimeTitle }) : t("state.takeover.toastTaken", { what, runtime: input.runtimeTitle });
}

/** ⚙ 里接管来的那一行：接管自哪个会话（分叉的写明）、工作目录；交还了的写明 */
export function takeoverStateLines(state: AgentRuntimeStateView): { head: string; where: string; note: string } | undefined {
  const takeover = state.takeover;
  if (!takeover) return undefined;
  const head = takeover.own
    ? t("state.takeover.panelOwnHead", { runtime: state.title, title: takeover.title })
    : takeover.forkedFrom
      ? t("state.takeover.panelHeadForked", { runtime: state.title, title: takeover.title })
      : t("state.takeover.panelHead", { runtime: state.title, title: takeover.title });
  const place = takeover.place ?? (takeover.returned ? "returned" : "ergo");
  const note =
    place === "remote"
      ? t("state.takeover.panelRemote", { runtime: state.title })
      : place === "returned"
        ? t("state.takeover.panelReturned", { runtime: state.title })
        : takeover.own
          ? t("state.takeover.panelOwnHeld")
          : t("state.takeover.panelHeld", { runtime: state.title });
  return { head, where: t("state.takeover.panelWhere", { cwd: takeover.cwd }), note };
}

/** ⚙ 里那一块的一个按钮：做哪个动作、写什么、是不是主按钮 */
export interface TakeoverButton {
  action: TakeoverAction;
  label: string;
  primary: boolean;
}

/**
 * ⚙ 里运行时一块的"会话在哪边"（290、292 号票）：说法、官方 App 里的链接、按钮（按现在在哪边，见文件开头）。
 * 不是接管来的、也不能交给官方 App 的是 undefined。name 是助理的名字（"收回到<名字>"）
 */
export function takeoverPanel(
  state: AgentRuntimeStateView,
  name: string,
): { head?: string; where?: string; note: string; place: "ergo" | "remote" | "returned"; url?: string; noLink?: string; buttons: TakeoverButton[] } | undefined {
  const takeover = state.takeover;
  const remote = state.remoteControl === true;
  const reclaim: TakeoverButton = { action: "reclaim", label: t("ui.takeover.reclaimTo", { name }), primary: true };
  if (!takeover) {
    if (!remote) return undefined;
    // 二狗自己开的会话、还没交给过官方 App：只有"交给官方 App"
    return { note: t("state.takeover.panelOwnHeld"), place: "ergo", buttons: [{ action: "remote", label: t("ui.takeover.remote"), primary: false }] };
  }
  const lines = takeoverStateLines(state)!;
  const place = takeover.place ?? (takeover.returned ? "returned" : "ergo");
  if (place === "remote") {
    return {
      ...lines,
      place,
      ...(takeover.url ? { url: takeover.url } : { noLink: t("state.takeover.panelNoLink") }),
      buttons: [reclaim, ...(takeover.url ? [] : [{ action: "remote" as const, label: t("ui.takeover.reopenRemote"), primary: false }])],
    };
  }
  if (place === "returned") return { ...lines, place, buttons: [reclaim, ...(remote ? [{ action: "remote" as const, label: t("ui.takeover.remote"), primary: false }] : [])] };
  return {
    ...lines,
    place,
    buttons: [
      ...(remote ? [{ action: "remote" as const, label: t("ui.takeover.remote"), primary: false }] : []),
      ...(takeover.own ? [] : [{ action: "return" as const, label: t("ui.takeover.return", { runtime: state.title }), primary: false }]),
    ],
  };
}

/** 任务卡、项目卡上的"在官方 App 里"（292 号票）：任务、项目上记着的接管现在在官方 App 里才有；拿到链接的带上 */
export function remoteBadgeOf(takeover: RuntimeTakeover | undefined): { label: string; url?: string } | undefined {
  if (!takeover || takeoverPlaceOf(takeover) !== "remote") return undefined;
  return { label: t("state.takeover.remoteBadge"), ...(takeover.remote?.url ? { url: takeover.remote.url } : {}) };
}
