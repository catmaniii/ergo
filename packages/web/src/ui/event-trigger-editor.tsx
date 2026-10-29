// "事件发生时"的编辑（77 号票）：发起对话框里事件触发的任务、事件发生时提醒的简单提醒共用。按事件来源登记表画——
// 选来源（二狗内部事件、本机文件夹变化……）、勾要哪几种事件、填过滤条件（选一个任务、选一个项目、填文件夹、填文件名模式、含不含子文件夹）。
// 以后登记表里加了来源，这里不用改。文件夹能不能监视（在不在、是不是二狗的数据目录、密钥区、受保护区域）守护进程建的时候现查，被拒时提示里写明。
import {
  defaultEventTrigger,
  EVENT_SOURCES,
  type EventFilterDescriptor,
  eventPlaceholderHint,
  eventSourceOf,
  type EventTrigger,
  eventTriggerMissing,
  filterValue,
  t,
  toggleEvent,
  withFilter,
} from "../state/index.ts";

export interface EventTriggerEditorProps {
  value: EventTrigger;
  onChange(value: EventTrigger): void;
  /** 能选的任务（过滤条件"哪个任务"）：编号和标题 */
  tasks: ReadonlyArray<{ id: string; title: string }>;
  /** 能选的项目（过滤条件"哪个项目"）：编号和名字 */
  projects: ReadonlyArray<{ id: string; name: string }>;
  /** 给流程用：写明步骤参数里能写哪些事件的值 */
  workflow?: boolean;
}

export function EventTriggerEditor({ value, onChange, tasks, projects, workflow }: EventTriggerEditorProps) {
  const source = eventSourceOf(value.source) ?? EVENT_SOURCES[0]!;
  const missing = eventTriggerMissing(value);
  return (
    <div className="event-editor">
      <div className="seg event-sources" role="radiogroup" aria-label={t("ui.eventTriggerEditor.sources")}>
        {EVENT_SOURCES.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={s.id === source.id} className={`seg-btn${s.id === source.id ? " on" : ""}`} title={s.hint} onClick={() => s.id !== source.id && onChange(defaultEventTrigger(s.id))}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="sc-mode-hint">{source.hint}</div>
      <div className="event-kinds" role="group" aria-label={t("ui.eventTriggerEditor.events")}>
        <span className="event-label">{t("ui.eventTriggerEditor.events")}</span>
        {source.events.map((e) => (
          <label key={e.id} className="check-row" title={e.hint}>
            <input type="checkbox" checked={value.events.includes(e.id)} onChange={() => onChange(toggleEvent(value, e.id))} />
            {e.label}
          </label>
        ))}
      </div>
      {source.filters.map((f) => (
        <FilterField key={f.key} filter={f} value={filterValue(value, f.key)} onChange={(v) => onChange(withFilter(value, f.key, v))} tasks={tasks} projects={projects} />
      ))}
      {workflow && value.events.length > 0 && (
        <div className="hint">{t("ui.eventTriggerEditor.workflowHint", { placeholders: eventPlaceholderHint(value) })}</div>
      )}
      {missing.length > 0 && <div className="hint event-missing">{t("ui.eventTriggerEditor.missing", { items: missing.join(t("ui.eventTriggerEditor.missingSep")) })}</div>}
    </div>
  );
}

/** 一个过滤条件：按登记表写的种类画（选任务、选项目、填文件夹、填文件名模式、开关） */
function FilterField({
  filter,
  value,
  onChange,
  tasks,
  projects,
}: {
  filter: EventFilterDescriptor;
  value: string | boolean | undefined;
  onChange(value: string | boolean | undefined): void;
  tasks: EventTriggerEditorProps["tasks"];
  projects: EventTriggerEditorProps["projects"];
}) {
  if (filter.kind === "boolean") {
    return (
      <label className="check-row" title={filter.hint}>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {filter.label}
      </label>
    );
  }
  const text = typeof value === "string" ? value : "";
  if (filter.kind === "task" || filter.kind === "project") {
    const options = filter.kind === "task" ? tasks.map((task) => ({ id: task.id, label: t("ui.eventTriggerEditor.taskOption", { id: task.id, title: task.title }) })) : projects.map((p) => ({ id: p.id, label: p.name }));
    return (
      <label className="event-filter">
        <span className="event-label">{filter.label}</span>
        <select className="input" value={text} onChange={(e) => onChange(e.target.value || undefined)} aria-label={filter.label} title={filter.hint}>
          <option value="">{filter.kind === "task" ? t("ui.eventTriggerEditor.anyTask") : t("ui.eventTriggerEditor.anyProject")}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="event-filter">
      <span className="event-label">
        {filter.label}
        {filter.required ? "" : t("ui.eventTriggerEditor.optional")}
      </span>
      <input className="input" value={text} placeholder={filter.placeholder} onChange={(e) => onChange(e.target.value)} aria-label={filter.label} title={filter.hint} spellCheck={false} />
      <span className="sc-mode-hint">{filter.hint}</span>
    </label>
  );
}
