// 设置 · 更多 · 体检（319b、409）：地址 #/more/doctor。
// 最上面一句说明，然后是总状态（坏了几项、要注意几项、都正常；没查出来的另起一句灰字）和查的时刻；下面按块显示——
// "二狗本身"一块在最前，每个在跑或没装上的插件一块（有问题的在前），块头是名字和这一块最差的结果；
// 每项一行：结果的小圆点、名字（不正常的带结果的小签）、查出来的事实、"从什么时候起"、怎么修，带动作的有一个按钮
// （去看看：跳到那一页，服务管家里的服务跳设置 · 服务定位到它；开起来：和设置 · 服务一页同一个接口，开完再查一遍，410、413；
// 现在压缩：和会话 ⚙ 里同一个接口；本机的网址画成新开一页的链接）；不适用的淡显、排在块的最后。
// 停用了的插件最底下一行列名字。
// 再往下是后台盯着（416）那一段：每几分钟看一眼哪几件、坏了放进待办；在待办里点了"不再提醒这件事"的列出来，各带"恢复提醒"。
// 右上"再查一遍"（重新请求 GET /api/doctor）。演示页用原型编的一份（prototype/fake-doctor.ts）。
// 415：说明下面是"深度体检"那一块（DoctorDeepSection）——按钮旁一句"会真发一个很短的请求测模型、会连外网、要一点时间"，
// 打开时只取上一次的结果（"3 分钟前测的"），点了才跑、逐项出结果（还在测的写"正在测…"），刚测过按钮倒数"几秒后能再测"。
// 每项查什么、几级怎么判、句子怎么拼都在守护进程（packages/daemon/src/doctor/）；形状在共享协议包的 doctor.ts；
// 页面上的几句（总状态、几种结果的叫法、"从什么时候起"）在 app/doctor.ts，中英文案在 locales/*/doctor.json。
// 块和行（DoctorGroups）是纯渲染，测试在 Node 里直接渲染。
import { useState } from "react";
import {
  doctorActionText,
  doctorAtText,
  doctorDeepButtonText,
  doctorDeepGroups,
  doctorDeepStatusText,
  doctorDeepSummary,
  doctorDeepWaitSeconds,
  doctorLevelText,
  doctorMutedAtText,
  doctorOffText,
  doctorSinceText,
  doctorSummary,
  knownDoctorAction,
  startDoctorService,
} from "../../app/doctor.ts";
import { useDoctor, useDoctorDeep } from "../../app/page-doctor.ts";
import { type Navigate, parseHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import {
  type DoctorAction,
  type DoctorDeepView,
  type DoctorGroupView,
  type DoctorItemView,
  doctorOpensUrl,
  type DoctorView,
  type DoctorWatchMutedView,
  type DoctorWatchView,
  doctorWatchKey,
  t,
} from "../../state/index.ts";
import { TopBar } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 动作按钮被点了：交给页面（跳转、压缩、开起来）；busy 是正在做的那一个（压缩中、正在开） */
interface ActionProps {
  onAction?: ((action: DoctorAction) => void) | undefined;
  busy?: DoctorAction | undefined;
}

/** 这个按钮正在做（压缩同一个 agent 的、开同一个服务的） */
const working = (busy: DoctorAction | undefined, action: DoctorAction) =>
  (busy?.kind === "compact" && action.kind === "compact" && busy.agentId === action.agentId) || (busy?.kind === "start" && action.kind === "start" && busy.service === action.service);

/** 一项：小圆点、名字（不正常的带结果的小签）、事实、从什么时候起、怎么修、动作按钮 */
export function DoctorItemRow({ item, onAction, busy }: { item: DoctorItemView } & ActionProps) {
  const action = knownDoctorAction(item.action) ? item.action : undefined;
  const doing = action !== undefined && working(busy, action);
  return (
    <li className={`doctor-row doctor-${item.level}`} data-item={item.id} data-level={item.level}>
      <span className="doctor-mark" aria-hidden="true" />
      <div className="doctor-body">
        <span className="doctor-head">
          <span className="doctor-name">{item.text.title}</span>
          {item.level !== "ok" && <span className="doctor-level">{doctorLevelText(item.level)}</span>}
        </span>
        <span className="doctor-fact">{item.text.fact}</span>
        {item.since !== undefined && <span className="doctor-since muted">{doctorSinceText(item.since)}</span>}
        {item.text.fix !== undefined && <span className="doctor-fix">{item.text.fix}</span>}
        {action && (
          <span className="doctor-action">
            {action.kind === "open" && doctorOpensUrl(action.route) ? (
              // 本机的网址（服务管家的网页）：新开一页，和设备配对页"打开服务管家"一样是个链接
              <a className="btn ghost small" data-action={action.kind} href={action.route} target="_blank" rel="noreferrer">
                {doctorActionText(action)}
              </a>
            ) : (
              <button type="button" className="btn ghost small" data-action={action.kind} disabled={doing || onAction === undefined} onClick={() => onAction?.(action)}>
                {doctorActionText(action, doing)}
              </button>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

/** 一块：块头（名字、最差的结果），下面一项一行 */
export function DoctorGroupBlock({ group, onAction, busy }: { group: DoctorGroupView } & ActionProps) {
  return (
    <section className={`doctor-group doctor-${group.level}`} data-group={group.id} data-level={group.level}>
      <h3 className="doctor-group-head">
        <span className="doctor-mark" aria-hidden="true" />
        <span className="doctor-group-title">{group.title}</span>
        <span className="doctor-level">{doctorLevelText(group.level)}</span>
      </h3>
      <ul className="doctor-list">
        {group.items.map((item) => (
          <DoctorItemRow key={item.id} item={item} onAction={onAction} busy={busy} />
        ))}
      </ul>
    </section>
  );
}

/** 总状态、各块、停用的插件那一行（顺序照守护进程给的） */
export function DoctorGroups({ view, onAction, busy }: { view: DoctorView } & ActionProps) {
  const off = doctorOffText(view);
  return (
    <>
      <div className={`doctor-summary doctor-${view.level}`} data-level={view.level}>
        {doctorSummary(view).map((line) => (
          <span key={line.level} className={`doctor-summary-item doctor-${line.level}`}>
            {line.text}
          </span>
        ))}
      </div>
      {view.groups.map((group) => (
        <DoctorGroupBlock key={group.id} group={group} onAction={onAction} busy={busy} />
      ))}
      {off !== undefined && <div className="doctor-off muted">{off}</div>}
    </>
  );
}

/** 深度体检里还在测的一项：小圆点（灰）、名字、"正在测…" */
function DoctorDeepPendingRow({ id, title }: { id: string; title: string }) {
  return (
    <li className="doctor-row doctor-pending" data-item={id} data-level="pending">
      <span className="doctor-mark" aria-hidden="true" />
      <div className="doctor-body">
        <span className="doctor-head">
          <span className="doctor-name">{title}</span>
        </span>
        <span className="doctor-fact muted">{t("doctor.deep.pending")}</span>
      </div>
    </li>
  );
}

/** 深度体检那一块（纯渲染，测试在 Node 里直接渲染）：标题和按钮、说明、状态、测完的总状态、按块的各项 */
export function DoctorDeepBlock({
  view,
  now,
  starting = false,
  error,
  onStart,
  onAction,
  busy,
}: { view: DoctorDeepView | undefined; now: number; starting?: boolean; error?: string | undefined; onStart?: (() => void) | undefined } & ActionProps) {
  const running = view?.state === "running";
  const waiting = view !== undefined && !running && doctorDeepWaitSeconds(view, now) > 0;
  const summary = view === undefined ? [] : doctorDeepSummary(view);
  return (
    <section className="doctor-deep" data-state={view?.state ?? "loading"}>
      <div className="doctor-deep-head">
        <h3 className="doctor-deep-title">{t("doctor.deep.title")}</h3>
        <button type="button" className="btn primary small" data-action="deep" disabled={onStart === undefined || starting || running || waiting} onClick={onStart}>
          {starting ? t("doctor.deep.running") : doctorDeepButtonText(view, now)}
        </button>
      </div>
      <div className="doctor-deep-hint muted">{t("doctor.deep.hint")}</div>
      {error !== undefined && (
        <div className="field-error" role="alert">
          {t("doctor.deep.startFailed", { reason: error })}
        </div>
      )}
      {view !== undefined && <div className="doctor-deep-status muted">{doctorDeepStatusText(view, now)}</div>}
      {summary.length > 0 && (
        <div className="doctor-summary doctor-deep-summary">
          {summary.map((line) => (
            <span key={line.level} className={`doctor-summary-item doctor-${line.level}`}>
              {line.text}
            </span>
          ))}
        </div>
      )}
      {view !== undefined &&
        doctorDeepGroups(view).map((group) => (
          <div key={group.id} className="doctor-deep-group" data-group={group.id} data-level={group.level ?? "pending"}>
            <h4 className="doctor-deep-group-title">{group.title}</h4>
            <ul className="doctor-list">
              {group.entries.map((entry) =>
                entry.item === undefined ? <DoctorDeepPendingRow key={entry.id} id={entry.id} title={entry.title} /> : <DoctorItemRow key={entry.id} item={entry.item} onAction={onAction} busy={busy} />,
              )}
            </ul>
          </div>
        ))}
    </section>
  );
}

/**
 * 后台盯着（416）那一段：一句说明（多久看一眼、看哪几件、坏了放进待办）；点过"不再提醒这件事"的一项一行，带"恢复提醒"。
 * busy 是正在恢复的那一项（按钮灰着、写"正在恢复…"）
 */
export function DoctorWatchSection({ watch, onUnmute, busy }: { watch: DoctorWatchView; onUnmute?: ((item: DoctorWatchMutedView) => void) | undefined; busy?: string | undefined }) {
  return (
    <section className="doctor-watch" data-section="watch">
      <div className="doctor-watch-intro muted">{t("doctor.watch.intro", { minutes: watch.everyMinutes })}</div>
      {watch.muted.length > 0 && (
        <>
          <div className="doctor-watch-head">{t("doctor.watch.muted")}</div>
          <ul className="doctor-watch-list">
            {watch.muted.map((item) => {
              const key = doctorWatchKey(item);
              const doing = busy === key;
              return (
                <li key={key} className="doctor-watch-row" data-muted={key}>
                  <span className="doctor-watch-name">{item.title}</span>
                  <span className="doctor-watch-at muted">{doctorMutedAtText(item.at)}</span>
                  <button type="button" className="btn ghost small" data-action="unmute" disabled={doing || onUnmute === undefined} onClick={() => onUnmute?.(item)}>
                    {doing ? t("doctor.watch.unmuting") : t("doctor.watch.unmute")}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** 深度体检那一块连上守护进程：取上一次的、点了开测、正在测时每秒取（重画只在这一块里） */
function DoctorDeepSection({ onAction, busy }: ActionProps) {
  const { view, now, starting, error, start } = useDoctorDeep();
  return <DoctorDeepBlock view={view} now={now} starting={starting} error={error} onStart={start} onAction={onAction} busy={busy} />;
}

/** 设置 · 更多里的体检页：标题栏右上"再查一遍"，底下是总状态、各块和查的时刻 */
export function DoctorPage({ title, onBack, navigate }: { title: string; onBack: (() => void) | undefined; navigate: Navigate }) {
  const { view, loading, error, recheck, updateWatch } = useDoctor();
  const { http } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState<DoctorAction | undefined>();
  const [unmuting, setUnmuting] = useState<string | undefined>();
  // 恢复提醒：这一项再不正常会照常放进待办
  const unmute = (item: DoctorWatchMutedView) => {
    setUnmuting(doctorWatchKey(item));
    http
      .doctorUnmute({ group: item.group, id: item.id })
      .then(
        (watch) => {
          updateWatch(watch);
          toast(t("doctor.watch.unmuted", { name: item.title }));
        },
        (err: unknown) => toast(t("doctor.watch.unmuteFailed", { error: errorText(err) })),
      )
      .finally(() => setUnmuting(undefined));
  };
  const act = (action: DoctorAction) => {
    if (action.kind === "open") {
      // 本机的网址在行里画成链接，不走这里；别处调来的照样新开一页
      if (doctorOpensUrl(action.route)) window.open(action.route, "_blank", "noopener");
      else navigate(parseHash(action.route));
      return;
    }
    // 开起来（418 + 428）：和设置 · 服务一页同一个接口（会过"和二狗有关"、受保护的检查）；结果说一句，开完再查一遍
    if (action.kind === "start") {
      setBusy(action);
      void startDoctorService(http, action.service)
        .then((text) => {
          toast(text);
          recheck();
        })
        .finally(() => setBusy(undefined));
      return;
    }
    // 现在压缩：和会话 ⚙ 里同一个接口；压缩要一会儿，压完了自己再查一遍
    setBusy(action);
    http
      .compactAgent(action.agentId)
      .then(
        () => toast(t("doctor.action.compactStarted")),
        (err: unknown) => toast(t("doctor.action.compactFailed", { error: errorText(err) })),
      )
      .finally(() => setBusy(undefined));
  };
  return (
    <div className="chat-col">
      <TopBar title={title} onBack={onBack}>
        <button type="button" className="btn ghost small" data-action="recheck" disabled={loading} onClick={recheck}>
          {loading ? t("doctor.rechecking") : t("doctor.recheck")}
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <div className="doctor-page">
          <div className="doctor-intro muted">{t("doctor.intro")}</div>
          <DoctorDeepSection onAction={act} busy={busy} />
          {view === undefined && error === undefined && <div className="muted">{t("doctor.loading")}</div>}
          {error !== undefined && (
            <div className="field-error" role="alert">
              {t("doctor.loadFailed", { reason: error })}
            </div>
          )}
          {view !== undefined && (
            <>
              <div className="doctor-at muted">{doctorAtText(view)}</div>
              <DoctorGroups view={view} onAction={act} busy={busy} />
              {view.watch !== undefined && <DoctorWatchSection watch={view.watch} onUnmute={unmute} busy={unmuting} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
