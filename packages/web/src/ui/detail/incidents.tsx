/**
 * 执行中出过的状况（60 号票）：图标、个数一行、清单——
 * - 图标：已处理的带 ✓、颜色平和；要注意的换成感叹号；
 * - 个数一行（阶段抽屉全开、宽屏阶段栏下面）：每类一个图标、名字、几次，点一个看是哪几次；
 * - 出过的状况一页（详情栏）：按类筛，一件一行，点一行进那一条的详情。
 * 哪些算状况、怎么说由状态层的 incidentsIn / incidentKinds 给（state/stage-detail.ts），按这个任务的整段会话算。
 */
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type ChatItem, INCIDENT_META, type Incident, type IncidentKind, incidentKinds, t, taskIncidents } from "../../state/index.ts";

/** 一件状况的图标：已处理的带 ✓，要注意的换成感叹号 */
export function IncidentIcon({ kind, attention }: { kind: IncidentKind; attention?: boolean | undefined }) {
  const m = INCIDENT_META[kind];
  const warn = attention === true || kind === "look";
  const label = warn ? t("ui.incidents.iconAttention", { name: m.name }) : t("ui.incidents.iconDone", { name: m.name, done: m.done });
  return (
    // data-mark：收着的阶段框在缩小后条外的标注从这里拉线指过来（91 号票）
    <span className={`ic ic-${kind}${warn ? " ic-warn" : ""}`} title={label} aria-label={label} data-mark={`ic:${kind}`}>
      <span className="ic-g">{warn ? "!" : m.glyph}</span>
      {!warn && kind !== "data" && (
        <span className="ic-ok" aria-hidden="true">
          ✓
        </span>
      )}
    </span>
  );
}

/** 并排的几个图标，不写个数（91 号票：依赖图上一个阶段、聊天里的阶段框上） */
export function IncidentIcons({ list }: { list: readonly Incident[] }) {
  const kinds = incidentKinds(list);
  if (!kinds.length) return null;
  return (
    <span className="ic-row">
      {kinds.map((k) => (
        <IncidentIcon key={k.kind} kind={k.kind} attention={k.attention} />
      ))}
    </span>
  );
}

/** 图标 + 名字 + 个数，点一个看是哪几次（阶段抽屉全开、宽屏阶段栏下面那一行） */
export function IncidentCounts({ list, onPick }: { list: readonly Incident[]; onPick?: ((kind: IncidentKind) => void) | undefined }) {
  const kinds = incidentKinds(list);
  if (!kinds.length) return <div className="ic-counts ic-none">{t("ui.incidents.none")}</div>;
  return (
    <div className="ic-counts">
      {kinds.map((k) => {
        const m = INCIDENT_META[k.kind];
        const warn = k.attention || k.kind === "look";
        return (
          <button type="button" key={k.kind} className={`ic-count${warn ? " ic-count-warn" : ""}`} onClick={onPick && (() => onPick(k.kind))} disabled={!onPick}>
            <IncidentIcon kind={k.kind} attention={k.attention} />
            <span className="ic-name">{m.name}</span>
            <b className="ic-n">{k.n}</b>
            {k.kind !== "data" && k.kind !== "look" && <span className="ic-done">{warn ? t("ui.incidents.needsLook") : m.done}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** 执行中出过的状况：按类筛，一件一行，点一行进那一条的详情 */
export function IncidentsDetail({
  taskId,
  kind,
  items,
  onOpen,
}: {
  taskId: string;
  kind?: string | undefined;
  items: readonly ChatItem[];
  onOpen?: ((id: string) => void) | undefined;
}) {
  const { ui } = useStore();
  const [k, setK] = useState<IncidentKind | undefined>(kind as IncidentKind | undefined);
  const all = taskIncidents(ui, items, taskId);
  const kinds = incidentKinds(all);
  const list = k ? all.filter((x) => x.kind === k) : all;
  return (
    <>
      <div className="dt-head">
        <span className="tag">{t("ui.incidents.title")}</span>
      </div>
      <div className="dt-title">{k ? t("ui.incidents.kindCount", { count: list.length, name: INCIDENT_META[k].name }) : t("ui.incidents.total", { count: list.length })}</div>
      {k && <div className="muted dt-note">{INCIDENT_META[k].hint}</div>}
      <div className="ic-tabs">
        <button type="button" className={!k ? "on" : ""} onClick={() => setK(undefined)}>
          {t("ui.incidents.all")}
        </button>
        {kinds.map((x) => (
          <button type="button" key={x.kind} className={k === x.kind ? "on" : ""} onClick={() => setK(x.kind)}>
            <IncidentIcon kind={x.kind} attention={x.attention} />
            {INCIDENT_META[x.kind].name} {x.n}
          </button>
        ))}
      </div>
      {list.length ? (
        <ul className="ic-list">
          {list.map((x, i) => (
            <li key={`${x.itemId}:${x.kind}:${i}`}>
              <button type="button" onClick={onOpen ? () => onOpen(x.itemId) : undefined} disabled={!onOpen}>
                <IncidentIcon kind={x.kind} attention={x.attention} />
                <span className="ic-list-t">{x.text}</span>
                {onOpen && <span className="tool-more">›</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted">{t("ui.incidents.none")}</div>
      )}
    </>
  );
}
