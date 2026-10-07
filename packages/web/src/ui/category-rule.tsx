// 关注类别的确定规则编辑（26 号票）：设置页的自定义类别、计划卡上给本任务加的类别共用。
// 规则是四种条件（匹配工具、路径、收件人、金额），写了的都要满足；文本框变成请求的纯函数在状态层（state/watch-categories.ts）。
import { useId } from "react";
import { type CategoryForm, type Disposition, DISPOSITION_LABEL, type WatchToolChoice } from "../state/index.ts";

/** 一档处置的下拉 */
export function DispositionSelect({ value, options, onChange, label }: { value: Disposition; options: readonly Disposition[]; onChange(d: Disposition): void; label: string }) {
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

type RuleFields = Pick<CategoryForm, "title" | "tools" | "paths" | "recipients" | "amountOver">;

/** 名字和四种条件；tools 是能匹配的工具（候选） */
export function CategoryRuleFields<F extends RuleFields>({ form, onChange, tools }: { form: F; onChange(next: F): void; tools: readonly WatchToolChoice[] }) {
  const listId = useId();
  const set = (patch: Partial<RuleFields>) => onChange({ ...form, ...patch });
  return (
    <>
      <label className="field">
        <span>名字</span>
        <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="比如：动数据库迁移目录" />
      </label>
      <div className="hint">规则写确定的条件；几条都写了时要同时满足，每条里写几个值是"其中之一"。</div>
      <label className="field">
        <span>匹配工具</span>
        <input value={form.tools} onChange={(e) => set({ tools: e.target.value })} placeholder="工具名，逗号分开，比如 write、delete、git_push" list={listId} />
        <datalist id={listId}>
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.title}
            </option>
          ))}
        </datalist>
      </label>
      <label className="field">
        <span>路径在这些目录之内</span>
        <textarea value={form.paths} onChange={(e) => set({ paths: e.target.value })} placeholder={"完整的 Windows 路径，一行一个，比如\nD:\\code\\app\\db\\migrations"} rows={2} />
      </label>
      <label className="field">
        <span>收件人是</span>
        <input value={form.recipients} onChange={(e) => set({ recipients: e.target.value })} placeholder="逗号分开，比如 landlord@example.com" />
      </label>
      <label className="field">
        <span>金额大于</span>
        <input value={form.amountOver} onChange={(e) => set({ amountOver: e.target.value })} placeholder="比如 500" inputMode="decimal" />
      </label>
    </>
  );
}
