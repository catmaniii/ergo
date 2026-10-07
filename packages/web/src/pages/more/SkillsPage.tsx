// 设置 · skill 库：框架自带的一批（第一阶段只有示例）和你自己导入的；导入 skill 的入口在这里。
import { useState } from "react";
import type { SkillEntry } from "../../model/types.ts";
import { useProto } from "../../prototype/proto-store.tsx";
import { Section, Sheet } from "../../ui/common.tsx";

export function SkillsPage() {
  const { proto, update, toast } = useProto();
  const [importing, setImporting] = useState(false);
  const groups: { title: string; origin: SkillEntry["origin"] }[] = [
    { title: "你导入的", origin: "imported" },
    { title: "框架自带", origin: "framework" },
  ];
  return (
    <>
      <div className="add-row">
        <span className="muted">skill 只是说明书，不增加权限。要给哪个项目或任务用，在它的工具包里加。</span>
        <button type="button" className="btn primary small" onClick={() => setImporting(true)}>
          ＋ 导入 skill
        </button>
      </div>
      {groups.map((g) => (
        <Section key={g.origin} title={g.title}>
          {proto.skills
            .filter((s) => s.origin === g.origin)
            .map((s) => (
              <div key={s.id} className="skill-row">
                <div>
                  <b>{s.name}</b>
                  <div className="muted">{s.description}</div>
                  <div className="muted">{s.usedBy.length ? `用在：${s.usedBy.join("、")}` : "还没有工具包用它"}</div>
                </div>
                {s.origin === "imported" && (
                  <button
                    type="button"
                    className="link danger-text"
                    onClick={() => {
                      update((st) => ({ ...st, skills: st.skills.filter((x) => x.id !== s.id) }));
                      toast(`已移除 skill「${s.name}」`);
                    }}
                  >
                    移除
                  </button>
                )}
              </div>
            ))}
        </Section>
      ))}
      {importing && (
        <ImportSkill
          onClose={() => setImporting(false)}
          onImport={(name) => {
            update((s) => ({ ...s, skills: [{ id: `sk-${Date.now()}`, name, description: "刚导入的 skill（原型）", origin: "imported", usedBy: [] }, ...s.skills] }));
            toast(`已导入 skill「${name}」`);
            setImporting(false);
          }}
        />
      )}
    </>
  );
}

function ImportSkill({ onClose, onImport }: { onClose(): void; onImport(name: string): void }) {
  const [path, setPath] = useState("");
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return (
    <Sheet title="导入 skill" onClose={onClose} center>
      <label className="field">
        <span>skill 所在的文件夹（含 SKILL.md）</span>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="比如 D:\skills\intent-mining" />
      </label>
      <div className="hint">导入的是一份拷贝，放进数据目录里的 skill 区。二狗不会自动读 ~/.claude/skills；现成的 skill 要用，就在这里显式导入一份。</div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!name} onClick={() => onImport(name)}>
          导入{name ? `「${name}」` : ""}
        </button>
      </div>
    </Sheet>
  );
}
