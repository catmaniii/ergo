// skill 的选择（72 号票）：工具包区（项目页、任务详情）和设置里秘书用的 skill 共用。
// 集合（matt-pocock、pstack 这类整套导入的）显示成一项：可以整套选、整套去掉，点开能单选其中几个；单个的 skill 一个一个列。
// 怎么分组、怎么显示、选了之后的名单都是状态层的纯函数（state/skill-groups.ts），这里只管画。
import { useState } from "react";
import {
  addOptions,
  applyAddOption,
  collectionPick,
  groupSkills,
  selectCollection,
  selectionChips,
  type SkillGroup,
  t,
  toggleSkill,
  type ToolkitCatalog,
  unselectCollection,
} from "../state/index.ts";

export function SkillPicker({
  catalog,
  selected,
  onChange,
  label = "skill",
}: {
  catalog: Pick<ToolkitCatalog, "skills" | "collections"> | undefined;
  selected: readonly string[];
  onChange(next: string[]): void;
  /** 加 skill 的下拉框的读屏名字里用的说法 */
  label?: string;
}) {
  const groups = groupSkills(catalog ?? { skills: [], collections: [] });
  const [open, setOpen] = useState<string>();
  const chips = selectionChips(selected, groups);
  const options = catalog ? addOptions(selected, groups) : [];
  const openGroup = groups.collections.find((g) => g.collection.name === open);
  return (
    <div className="skill-picker">
      <div className="chips">
        {chips.length === 0 && <span className="muted">{t("ui.skillPicker.none")}</span>}
        {chips.map((chip) =>
          chip.kind === "skill" ? (
            <button key={chip.name} type="button" className="chip chip-data chip-x" onClick={() => onChange(selected.filter((x) => x !== chip.name))} aria-label={t("ui.skillPicker.remove", { name: chip.name })}>
              {chip.label} ×
            </button>
          ) : (
            <span key={chip.name} className={`chip chip-data chip-collection${open === chip.name ? " on" : ""}`}>
              <button type="button" className="chip-collection-open" onClick={() => setOpen(open === chip.name ? undefined : chip.name)} aria-expanded={open === chip.name} aria-label={t("ui.skillPicker.openCollection", { name: chip.name })}>
                {chip.label} {open === chip.name ? "▴" : "▾"}
              </button>
              <button
                type="button"
                className="chip-collection-x"
                onClick={() => {
                  const group = groups.collections.find((g) => g.collection.name === chip.name);
                  if (group) onChange(unselectCollection(selected, group));
                }}
                aria-label={t("ui.skillPicker.removeCollection", { name: chip.name })}
              >
                ×
              </button>
            </span>
          ),
        )}
        {options.length > 0 && (
          <select
            className="input chip-add"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const next = applyAddOption(selected, e.target.value, groups);
              if (next.open) setOpen(next.open);
              if (next.selected.length !== selected.length) onChange(next.selected);
            }}
            aria-label={t("ui.skillPicker.add", { label })}
          >
            <option value="">{t("ui.skillPicker.addFromLibrary")}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {openGroup && <CollectionMembers group={openGroup} selected={selected} onChange={onChange} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

/** 点开的集合：每个成员一个勾，整套选、整套去掉 */
function CollectionMembers({ group, selected, onChange, onClose }: { group: SkillGroup; selected: readonly string[]; onChange(next: string[]): void; onClose(): void }) {
  const pick = collectionPick(group, selected);
  return (
    <div className="skill-collection-panel">
      <div className="skill-collection-head">
        <b>{group.collection.name}</b>
        <span className="muted">
          {t("ui.skillPicker.picked", { picked: pick.count, total: pick.total })}
        </span>
        <span className="skill-collection-actions">
          <button type="button" className="btn ghost small" disabled={pick.state === "all"} onClick={() => onChange(selectCollection(selected, group))}>
            {t("ui.skillPicker.selectAll")}
          </button>
          <button type="button" className="btn ghost small" disabled={pick.state === "none"} onClick={() => onChange(unselectCollection(selected, group))}>
            {t("ui.skillPicker.unselectAll")}
          </button>
          <button type="button" className="btn ghost small" onClick={onClose}>
            {t("ui.skillPicker.collapse")}
          </button>
        </span>
      </div>
      <div className="skill-collection-members">
        {group.members.map((m) => (
          <label key={m.name} className="skill-collection-member" title={m.description}>
            <input type="checkbox" checked={selected.includes(m.name)} onChange={() => onChange(toggleSkill(selected, m.name))} />
            <span>{m.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
