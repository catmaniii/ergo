/**
 * 执行中出过的状况（60 号票）：照搬 AgentSense web/src/ui/incidents.tsx 的 IncidentIcon、IncidentCounts 和 DetailPane.tsx 的
 * IncidentsDetail（D:\code\claudecode\user_agent_sense_of_security，bedf5a5）——
 * - 图标：已处理的带 ✓、颜色平和；要注意的换成感叹号；
 * - 个数一行（阶段抽屉全开、宽屏阶段栏下面）：每类一个图标、名字、几次，点一个看是哪几次；
 * - 出过的状况一页（详情栏）：按类筛，一件一行，点一行进那一条的详情。
 * 哪些算状况、怎么说由状态层的 incidentsIn / incidentKinds 给（state/stage-detail.ts），按这个任务的整段会话算。
 */
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type ChatItem, INCIDENT_META, type Incident, type IncidentKind, incidentKinds, taskIncidents } from "../../state/index.ts";

/** 一件状况的图标：已处理的带 ✓，要注意的换成感叹号 */
export function IncidentIcon({ kind, attention }: { kind: IncidentKind; attention?: boolean | undefined }) {
  const m = INCIDENT_META[kind];
  const warn = attention === true || kind === "look";
  const label = warn ? `${m.name}：要你看一眼` : `${m.name}：${m.done}`;
  return (
    <span className={`ic ic-${kind}${warn ? " ic-warn" : ""}`} title={label} aria-label={label}>
      <span className="ic-g">{warn ? "!" : m.glyph}</span>
      {!warn && kind !== "data" && (
        <span className="ic-ok" aria-hidden="true">
          ✓
        </span>
      )}
    </span>
  );
}

/** 图标 + 名字 + 个数，点一个看是哪几次（阶段抽屉全开、宽屏阶段栏下面那一行） */
export function IncidentCounts({ list, onPick }: { list: readonly Incident[]; onPick?: ((kind: IncidentKind) => void) | undefined }) {
  const kinds = incidentKinds(list);
  if (!kinds.length) return <div className="ic-counts ic-none">还没出过情况</div>;
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
            {k.kind !== "data" && k.kind !== "look" && <span className="ic-done">{warn ? "要你看一眼" : m.done}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** 执行中出过的状况（AgentSense 的 IncidentsDetail）：按类筛，一件一行，点一行进那一条的详情 */
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
        <span className="tag">执行中出过的情况</span>
      </div>
      <div className="dt-title">{k ? `${INCIDENT_META[k].name}：${list.length} 次` : `一共 ${list.length} 件`}</div>
      {k && <div className="muted dt-note">{INCIDENT_META[k].hint}</div>}
      <div className="ic-tabs">
        <button type="button" className={!k ? "on" : ""} onClick={() => setK(undefined)}>
          全部
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
        <div className="muted">还没出过情况</div>
      )}
    </>
  );
}
