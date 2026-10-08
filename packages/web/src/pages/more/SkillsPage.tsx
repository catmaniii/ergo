// 设置 · skill 库（27 号票）：框架自带的一批（第一阶段只有示例）和你导入的（数据目录的 skill 区）；导入 skill 的入口在这里。
// 列表和导入都走守护进程的 HTTP（GET 工具包目录、POST 导入）；原型里是假实现（prototype/fake-http.ts）。
// 二狗不读 ~/.claude/skills：现成的 skill 要用，就在这里显式导入一份。下面顺带列出配置区里登记的 MCP（只读：在配置区的 mcp.json 里改）。
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import type { LibrarySkill, ToolkitCatalog } from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

export function SkillsPage() {
  const { http, ui } = useStore();
  const toast = useToast();
  const [catalog, setCatalog] = useState<ToolkitCatalog>();
  const [problem, setProblem] = useState<string>();
  const [importing, setImporting] = useState(false);
  const load = useCallback(() => {
    http.toolkitCatalog().then(
      (c) => {
        setCatalog(c);
        setProblem(undefined);
      },
      (err: unknown) => setProblem(`取 skill 库失败：${err instanceof Error ? err.message : String(err)}`),
    );
  }, [http]);
  useEffect(load, [load]);
  // 哪些项目的工具包用了它（任务的工具包在任务详情里看）
  const usedBy = (name: string) =>
    Object.values(ui.projects)
      .filter((p) => p.toolkit?.skills.includes(name))
      .map((p) => `项目「${p.name}」`);
  const groups: { title: string; origin: LibrarySkill["origin"] }[] = [
    { title: "你导入的", origin: "imported" },
    { title: "框架自带", origin: "framework" },
  ];
  return (
    <>
      <div className="add-row">
        <span className="muted">skill 只是说明书，不增加权限。要给哪个项目或任务用，在它的工具包里加；维护者也可以自己从库里增减。</span>
        <button type="button" className="btn primary small" onClick={() => setImporting(true)}>
          ＋ 导入 skill
        </button>
      </div>
      {problem && <div className="hint">{problem}</div>}
      {!catalog && !problem && <div className="muted">正在取 skill 库……</div>}
      {catalog &&
        groups.map((g) => {
          const skills = catalog.skills.filter((s) => s.origin === g.origin);
          return (
            <Section key={g.origin} title={g.title}>
              {skills.length === 0 && <div className="muted">{g.origin === "imported" ? "还没有导入过 skill" : "没有"}</div>}
              {skills.map((s) => {
                const used = usedBy(s.name);
                return (
                  <div key={s.name} className="skill-row">
                    <div>
                      <b>{s.name}</b>
                      <div className="muted">{s.description}</div>
                      <div className="muted">{used.length ? `用在：${used.join("、")}` : "还没有项目的工具包用它"}</div>
                    </div>
                  </div>
                );
              })}
            </Section>
          );
        })}
      {catalog && (
        <Section title="已登记的 MCP" extra={<span className="muted">在数据目录配置区的 mcp.json 里登记</span>}>
          {catalog.mcpProblem && <div className="hint">MCP 登记读不了：{catalog.mcpProblem}</div>}
          {catalog.mcp.length === 0 && !catalog.mcpProblem && <div className="muted">还没有登记 MCP</div>}
          {catalog.mcp.map((m) => (
            <div key={m.name} className="skill-row">
              <div>
                <b>
                  {m.title}（{m.name}）
                </b>
                {m.tools.map((t) => (
                  <div key={t.name} className="muted">
                    {t.title}（{t.name}）{t.network ? " · 要联网" : ""}
                    {t.readOnlyOrIdempotent ? " · 只读或幂等" : ""}
                    {t.quickAction ? ` · 秘书的快速动作「${t.quickAction}」` : ""}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}
      {importing && (
        <ImportSkill
          onClose={() => setImporting(false)}
          onImport={async (path) => {
            const { skill } = await http.importSkill(path);
            toast(`已导入 skill「${skill.name}」`);
            setImporting(false);
            load();
          }}
        />
      )}
    </>
  );
}

function ImportSkill({ onClose, onImport }: { onClose(): void; onImport(path: string): Promise<void> }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = () => {
    setBusy(true);
    setError(undefined);
    onImport(path.trim()).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
  };
  return (
    <Sheet title="导入 skill" onClose={onClose} center>
      <label className="field">
        <span>skill 所在的文件夹（含 SKILL.md）的完整路径</span>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="比如 C:\Users\我\.claude\skills\intent-mining" />
      </label>
      <div className="hint">导入的是一份拷贝，放进数据目录里的 skill 区；名字和说明取 SKILL.md 开头的 name、description。二狗不会自动读 ~/.claude/skills；现成的 skill 要用，就在这里显式导入一份。</div>
      {error && <div className="hint">{error}</div>}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!path.trim() || busy} onClick={submit}>
          {busy ? "导入中……" : "导入"}
        </button>
      </div>
    </Sheet>
  );
}
