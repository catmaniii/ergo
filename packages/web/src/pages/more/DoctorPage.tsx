// 设置 · 更多 · 体检（319b、409）：地址 #/more/doctor。
// 最上面一句说明，然后是总状态（坏了几项、要注意几项、都正常；没查出来的另起一句灰字）和查的时刻；下面按块显示——
// "二狗本身"一块在最前，每个在跑或没装上的插件一块（有问题的在前），块头是名字和这一块最差的结果；
// 每项一行：结果的小圆点、名字（不正常的带结果的小签）、查出来的事实、"从什么时候起"、怎么修，带动作的有一个按钮
// （去看看：跳到那一页；打开服务管家：本机的网址在新标签页里打开，410；现在压缩：和会话 ⚙ 里同一个接口）；不适用的淡显、排在块的最后。
// 停用了的插件最底下一行列名字。
// 右上"再查一遍"（重新请求 GET /api/doctor）。演示页用原型编的一份（prototype/fake-doctor.ts）。
// 每项查什么、几级怎么判、句子怎么拼都在守护进程（packages/daemon/src/doctor/）；形状在共享协议包的 doctor.ts；
// 页面上的几句（总状态、几种结果的叫法、"从什么时候起"）在 app/doctor.ts，中英文案在 locales/*/doctor.json。
// 块和行（DoctorGroups）是纯渲染，测试在 Node 里直接渲染。
import { useState } from "react";
import { doctorActionText, doctorAtText, doctorLevelText, doctorOffText, doctorSinceText, doctorSummary, knownDoctorAction } from "../../app/doctor.ts";
import { useDoctor } from "../../app/page-doctor.ts";
import { type Navigate, parseHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { type DoctorAction, type DoctorGroupView, type DoctorItemView, doctorOpensUrl, type DoctorView, t } from "../../state/index.ts";
import { TopBar } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 动作按钮被点了：交给页面（跳转、压缩）；busy 是正在做的那一个（压缩中） */
interface ActionProps {
  onAction?: ((action: DoctorAction) => void) | undefined;
  busy?: DoctorAction | undefined;
}

/** 这个按钮正在做（压缩同一个 agent 的） */
const working = (busy: DoctorAction | undefined, action: DoctorAction) => busy?.kind === "compact" && action.kind === "compact" && busy.agentId === action.agentId;

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
            <button type="button" className="btn ghost small" data-action={action.kind} disabled={doing || onAction === undefined} onClick={() => onAction?.(action)}>
              {doctorActionText(action, doing)}
            </button>
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

/** 设置 · 更多里的体检页：标题栏右上"再查一遍"，底下是总状态、各块和查的时刻 */
export function DoctorPage({ title, onBack, navigate }: { title: string; onBack: (() => void) | undefined; navigate: Navigate }) {
  const { view, loading, error, recheck } = useDoctor();
  const { http } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState<DoctorAction | undefined>();
  const act = (action: DoctorAction) => {
    if (action.kind === "open") {
      // 本机的网址（服务管家的网页）：新标签页打开，只在这台电脑上打得开
      if (doctorOpensUrl(action.route)) window.open(action.route, "_blank", "noopener");
      else navigate(parseHash(action.route));
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
