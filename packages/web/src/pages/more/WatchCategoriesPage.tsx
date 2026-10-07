// 设置 · 关注类别：内置类别的处置只能往严里调，两条底线只显示不能改；自定义类别可以新建、改规则、改处置、删除。
import { useState } from "react";
import { DISPOSITION_LABEL, DISPOSITION_ORDER, notLooserThan } from "../../model/labels.ts";
import type { WatchCategory } from "../../model/types.ts";
import { BASELINES } from "../../prototype/fake-data.ts";
import { useProto } from "../../prototype/proto-store.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { Disposition } from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";

const RULE_KIND = { tool: "匹配工具", path: "路径", recipient: "收件人", amount: "金额" } as const;
type RuleKind = keyof typeof RULE_KIND;

function DispSelect({ value, options, onChange, label }: { value: Disposition; options: Disposition[]; onChange(d: Disposition): void; label: string }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value as Disposition)} aria-label={label}>
      {options.map((d) => (
        <option key={d} value={d}>
          {DISPOSITION_LABEL[d]}
        </option>
      ))}
    </select>
  );
}

export function WatchCategoriesPage() {
  const { proto, update } = useProto();
  const toast = useToast();
  const [editing, setEditing] = useState<WatchCategory | "new">();
  const setCat = (id: string, patch: Partial<WatchCategory>) => update((s) => ({ ...s, categories: s.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const builtin = proto.categories.filter((c) => c.builtin);
  const custom = proto.categories.filter((c) => !c.builtin);

  return (
    <>
      <div className="muted">守卫在每次工具调用之前判断它落在哪些类别里，按处置决定怎么做。"先问我"是执行时一定当场问；"计划里列了才做"才是靠计划一次授权。</div>
      <Section title="内置类别" extra={<span className="muted">只能往严里调</span>}>
        <div className="cat-table">
          <div className="cat-h">
            <span>类别</span>
            <span>对话里</span>
            <span>任务里</span>
          </div>
          {builtin.map((c) => (
            <div key={c.id} className="cat-row">
              <span className="cat-name">{c.name}</span>
              {c.chat && c.defaults?.chat ? (
                <DispSelect label={`${c.name}：对话里`} value={c.chat} options={notLooserThan(c.defaults.chat)} onChange={(d) => setCat(c.id, { chat: d })} />
              ) : (
                <span className="muted">—</span>
              )}
              <DispSelect label={`${c.name}：任务里`} value={c.task} options={notLooserThan(c.defaults!.task)} onChange={(d) => setCat(c.id, { task: d })} />
            </div>
          ))}
        </div>
        <div className="hint">不落在任何类别里的调用直接做只记录；带"做完告诉我"标记的工具（比如 git 提交）做完告诉你。对话里没有计划，"计划里列了才做"等同"先问我"。</div>
      </Section>

      <Section title="两条底线" extra={<span className="muted">不能改</span>}>
        {BASELINES.map((b) => (
          <div key={b.name} className="cat-row cat-locked">
            <span className="cat-name">🔒 {b.name}</span>
            <span className="chip chip-high">{DISPOSITION_LABEL[b.disposition]}</span>
          </div>
        ))}
      </Section>

      <Section
        title="你自己加的类别"
        extra={
          <button type="button" className="btn primary small" onClick={() => setEditing("new")}>
            ＋ 新建类别
          </button>
        }
      >
        {custom.length === 0 && <div className="muted">还没有</div>}
        {custom.map((c) => (
          <div key={c.id} className="cat-row cat-custom">
            <span className="cat-name">
              {c.name}
              {c.rule && (
                <span className="muted">
                  {" "}
                  · {RULE_KIND[c.rule.kind]}：{c.rule.value}
                </span>
              )}
            </span>
            <DispSelect label={`${c.name}：对话里`} value={c.chat ?? "ask_first"} options={DISPOSITION_ORDER} onChange={(d) => setCat(c.id, { chat: d })} />
            <DispSelect label={`${c.name}：任务里`} value={c.task} options={DISPOSITION_ORDER} onChange={(d) => setCat(c.id, { task: d })} />
            <span className="cat-ops">
              <button type="button" className="link" onClick={() => setEditing(c)}>
                改规则
              </button>
              <button
                type="button"
                className="link danger-text"
                onClick={() => {
                  update((s) => ({ ...s, categories: s.categories.filter((x) => x.id !== c.id) }));
                  toast(`已删除类别「${c.name}」`);
                }}
              >
                删除
              </button>
            </span>
          </div>
        ))}
        <div className="hint">自定义类别只能写确定的规则（匹配工具、路径、收件人、金额）。用模型判断的类别以后再加。</div>
      </Section>

      {editing && (
        <CategoryEditor
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSave={(c) => {
            update((s) => ({ ...s, categories: editing === "new" ? [...s.categories, c] : s.categories.map((x) => (x.id === c.id ? c : x)) }));
            toast(editing === "new" ? `已新建类别「${c.name}」` : "已保存");
            setEditing(undefined);
          }}
        />
      )}
    </>
  );
}

function CategoryEditor({ initial, onClose, onSave }: { initial?: WatchCategory; onClose(): void; onSave(c: WatchCategory): void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<RuleKind>(initial?.rule?.kind ?? "path");
  const [value, setValue] = useState(initial?.rule?.value ?? "");
  const [chat, setChat] = useState<Disposition>(initial?.chat ?? "ask_first");
  const [task, setTask] = useState<Disposition>(initial?.task ?? "ask_first");
  const placeholder = { tool: "比如 send_email", path: "比如 /示例/财务/**", recipient: "比如 房东", amount: "比如 > 500 元" }[kind];
  return (
    <Sheet title={initial ? `改类别：${initial.name}` : "新建关注类别"} onClose={onClose} center>
      <label className="field">
        <span>名字</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：给房东发消息" />
      </label>
      <label className="field">
        <span>规则</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as RuleKind)}>
          {Object.entries(RULE_KIND).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
      </label>
      <label className="field">
        <span>对话里</span>
        <DispSelect label="对话里" value={chat} options={DISPOSITION_ORDER} onChange={setChat} />
      </label>
      <label className="field">
        <span>任务里</span>
        <DispSelect label="任务里" value={task} options={DISPOSITION_ORDER} onChange={setTask} />
      </label>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim() || !value.trim()}
          onClick={() => onSave({ id: initial?.id ?? `c-${Date.now()}`, name: name.trim(), builtin: false, chat, task, rule: { kind, value: value.trim() } })}
        >
          保存
        </button>
      </div>
    </Sheet>
  );
}
