// 关注类别的确定规则编辑（26 号票）：设置页的自定义类别、计划卡上给本任务加的类别共用。
// 规则是四种条件（匹配工具、路径、收件人、金额），写了的都要满足；文本框变成请求的纯函数在状态层（state/watch-categories.ts）。
// 还没登记的工具也可以写（比如以后接上的 MCP 工具），这里提示"登记后生效"。
import { useId } from "react";
import { type CategoryForm, type Disposition, DISPOSITION_LABEL, formUnregisteredTools, t, unregisteredToolsText, type WatchToolChoice } from "../state/index.ts";

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
  const unregistered = formUnregisteredTools(form, tools);
  return (
    <>
      <label className="field">
        <span>{t("ui.categoryRule.name")}</span>
        <input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={t("ui.categoryRule.namePlaceholder")} />
      </label>
      <div className="hint">{t("ui.categoryRule.hint")}</div>
      <label className="field">
        <span>{t("ui.categoryRule.tools")}</span>
        <input value={form.tools} onChange={(e) => set({ tools: e.target.value })} placeholder={t("ui.categoryRule.toolsPlaceholder")} list={listId} />
        <datalist id={listId}>
          {tools.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.title}
            </option>
          ))}
        </datalist>
      </label>
      {unregistered.length > 0 && <div className="hint">{unregisteredToolsText(unregistered)}</div>}
      <label className="field">
        <span>{t("ui.categoryRule.paths")}</span>
        <textarea value={form.paths} onChange={(e) => set({ paths: e.target.value })} placeholder={t("ui.categoryRule.pathsPlaceholder")} rows={2} />
      </label>
      <label className="field">
        <span>{t("ui.categoryRule.recipients")}</span>
        <input value={form.recipients} onChange={(e) => set({ recipients: e.target.value })} placeholder={t("ui.categoryRule.recipientsPlaceholder")} />
      </label>
      <label className="field">
        <span>{t("ui.categoryRule.amountOver")}</span>
        <input value={form.amountOver} onChange={(e) => set({ amountOver: e.target.value })} placeholder={t("ui.categoryRule.amountPlaceholder")} inputMode="decimal" />
      </label>
    </>
  );
}
