// 设置 · skill 库（27、72 号票）：框架自带的一批（第一阶段只有示例）和你导入的（数据目录的 skill 区）；导入 skill 的入口在这里。
// 列表和导入都走守护进程的 HTTP（GET 工具包目录、POST 导入）；原型里是假实现（prototype/fake-http.ts）。
// 二狗不读 ~/.claude/skills：现成的 skill 要用，就在这里显式导入一份。下面顺带列出配置区里登记的 MCP（只读：在配置区的 mcp.json 里改）。
// 72 号票：
// - 整套导入的集合（matt-pocock、pstack 这类）不一个一个列，各显示成一项：集合名、几个 skill、版本、来源、一句说明，点开才列出成员；
//   单个导入的、框架自带的照旧一个一个列（分组是状态层的 groupSkills）；
// - 秘书用的 skill：最上面一栏，选择和工具包区同一个部件（ui/skill-picker.tsx：集合整套选，点开单选），默认 agent-browser、yt-dlp；
//   改了之后秘书做完手头这一条就按新名单接着；
// - 导入：单个 skill（可以改名），或者把一个目录作为集合整套导入（集合名、来源、版本、说明、成员所在的子目录、成员改名）；
//   导完显示每个 skill 导入成功与否、哪些依赖目录按原路径引用。
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  ASSISTANT_NAME_MARK,
  collectionMeta,
  DEFAULT_SECRETARY_SKILLS,
  groupSkills,
  type ImportSkillBody,
  type ImportSkillResult,
  type LibrarySkill,
  type SecretarySkillsView,
  secretaryPromptSizeText,
  secretarySkillsNote,
  type SkillGroup,
  type ToolkitCatalog,
} from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { SkillPicker } from "../../ui/skill-picker.tsx";
import { useToast } from "../../ui/toast.tsx";
import { AssistantName, NamedText, useAssistantName } from "../../ui/assistant-name.tsx";

export function SkillsPage() {
  const { http, ui } = useStore();
  const toast = useToast();
  const assistantName = useAssistantName();
  const [catalog, setCatalog] = useState<ToolkitCatalog>();
  const [problem, setProblem] = useState<string>();
  const [secretary, setSecretary] = useState<SecretarySkillsView>();
  const [secretaryProblem, setSecretaryProblem] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [lastImport, setLastImport] = useState<ImportSkillResult>();
  const [openCollection, setOpenCollection] = useState<string>();
  const load = useCallback(() => {
    http.toolkitCatalog().then(
      (c) => {
        setCatalog(c);
        setProblem(undefined);
      },
      (err: unknown) => setProblem(`取 skill 库失败：${err instanceof Error ? err.message : String(err)}`),
    );
    http.secretarySkills().then(
      (v) => {
        setSecretary(v);
        setSecretaryProblem(undefined);
      },
      (err: unknown) => setSecretaryProblem(`取${ASSISTANT_NAME_MARK}用的 skill 失败：${err instanceof Error ? err.message : String(err)}`),
    );
  }, [http]);
  useEffect(load, [load]);
  // 哪些项目的工具包用了它们（任务的工具包在任务详情里看）
  const usedBy = (names: readonly string[]) =>
    Object.values(ui.projects)
      .filter((p) => p.toolkit?.skills.some((s) => names.includes(s)))
      .map((p) => `项目「${p.name}」`);
  const groups = catalog ? groupSkills(catalog) : undefined;
  const originSections: { title: string; origin: LibrarySkill["origin"] }[] = [
    { title: "你导入的", origin: "imported" },
    { title: "框架自带", origin: "framework" },
  ];
  const saveSecretary = (next: string[]) => {
    // 只能选库里有的；默认的两个（agent-browser、yt-dlp）还没导入的留着，导入后自动装上
    const kept = next.filter((n) => DEFAULT_SECRETARY_SKILLS.includes(n) || catalog?.skills.some((s) => s.name === n));
    http.setSecretarySkills(kept).then(
      (v) => {
        setSecretary(v);
        setSecretaryProblem(undefined);
        toast(`改好了：${assistantName}做完手头这一条，就按新的 skill 名单接着`);
      },
      (err: unknown) => setSecretaryProblem(`没改成：${err instanceof Error ? err.message : String(err)}`),
    );
  };
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
      {lastImport && <ImportReport result={lastImport} onClose={() => setLastImport(undefined)} />}
      {catalog && (
        <Section
          title={
            <>
              <AssistantName />
              用的 skill
            </>
          }
        >
          <div className="skill-row skill-secretary">
            {secretary ? <SkillPicker catalog={catalog} selected={secretary.skills} onChange={saveSecretary} label={`${assistantName}用的 skill`} /> : <span className="muted">正在取……</span>}
          </div>
          <div className="hint">
            默认装 {DEFAULT_SECRETARY_SKILLS.join("、")}。这里勾选、取消，
            <AssistantName />
            做完手头这一条就按新的名单接着。{secretary ? secretarySkillsNote(secretary, catalog.skills) : ""}
          </div>
          {secretary && <SecretaryPromptSize view={secretary} />}
          {secretary?.problem && (
            <div className="hint">
              <NamedText text={secretary.problem} />
            </div>
          )}
          {secretaryProblem && (
            <div className="hint">
              <NamedText text={secretaryProblem} />
            </div>
          )}
        </Section>
      )}
      {groups && groups.collections.length > 0 && (
        <Section title="整套导入的集合" extra={<span className="muted">点开看里面的 skill</span>}>
          {groups.collections.map((g) => (
            <CollectionRow key={g.collection.name} group={g} open={openCollection === g.collection.name} onToggle={() => setOpenCollection(openCollection === g.collection.name ? undefined : g.collection.name)} usedBy={usedBy} />
          ))}
        </Section>
      )}
      {groups &&
        originSections.map((g) => {
          const skills = groups.singles.filter((s) => s.origin === g.origin);
          return (
            <Section key={g.origin} title={g.title}>
              {skills.length === 0 && <div className="muted">{g.origin === "imported" ? "还没有单个导入的 skill" : "没有"}</div>}
              {skills.map((s) => (
                <SkillRow key={s.name} skill={s} used={usedBy([s.name])} />
              ))}
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
                    {t.quickAction && (
                      <>
                        {" · "}
                        <AssistantName />
                        的快速动作「{t.quickAction}」
                      </>
                    )}
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
          onImport={async (request) => {
            const result = await http.importSkill(request);
            toast(result.collection ? `已导入集合「${result.collection.name}」：${result.skills.length} 个 skill` : `已导入 skill「${result.skills[0]?.name ?? ""}」`);
            setImporting(false);
            setLastImport(result);
            load();
          }}
        />
      )}
    </>
  );
}

/** 秘书的系统提示里 skill 说明有多长，太长时提醒 */
function SecretaryPromptSize({ view }: { view: SecretarySkillsView }) {
  const size = secretaryPromptSizeText(view);
  return (
    <>
      <div className="hint">{size.text}</div>
      {size.warn && <div className="hint skill-prompt-warn">{size.warn}</div>}
    </>
  );
}

function SkillRow({ skill, used }: { skill: LibrarySkill; used: readonly string[] }) {
  return (
    <div className="skill-row">
      <div>
        <b>{skill.name}</b>
        <div className="muted">{skill.description}</div>
        <div className="muted">{used.length ? `用在：${used.join("、")}` : "还没有项目的工具包用它"}</div>
      </div>
    </div>
  );
}

/** 集合那一行：集合名、几个 skill、版本、来源、一句说明；点开列出成员 */
function CollectionRow({ group, open, onToggle, usedBy }: { group: SkillGroup; open: boolean; onToggle(): void; usedBy(names: readonly string[]): string[] }) {
  const { collection, members } = group;
  const used = usedBy(collection.skills);
  return (
    <div className={`skill-collection${open ? " on" : ""}`}>
      <button type="button" className="skill-collection-row" onClick={onToggle} aria-expanded={open}>
        <span className="skill-collection-title">
          <b>{collection.name}</b>
          <span className="chip chip-data">集合</span>
        </span>
        <span className="muted">{collectionMeta(collection)}</span>
        <span className="skill-collection-desc">{collection.description}</span>
        <span className="muted">{used.length ? `用在：${used.join("、")}` : "还没有项目的工具包用它"}</span>
        <span className="skill-collection-toggle" aria-hidden="true">
          {open ? "收起 ▴" : `看 ${members.length} 个 skill ▾`}
        </span>
      </button>
      {open && (
        <div className="skill-collection-list">
          {members.map((m) => (
            <div key={m.name} className="skill-collection-item">
              <b>{m.name}</b>
              <span className="muted">{m.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 导完的报告：每个 skill 导入成功与否，按原路径引用的依赖目录 */
function ImportReport({ result, onClose }: { result: ImportSkillResult; onClose(): void }) {
  const failed = result.report.filter((r) => !r.ok);
  const noted = result.report.filter((r) => r.ok && r.note);
  const excluded = result.excluded ?? [];
  return (
    <div className="hint import-report">
      <div className="add-row">
        <b>
          {result.collection ? `集合「${result.collection.name}」` : `skill「${result.skills[0]?.name ?? ""}」`}：导入了 {result.skills.length} 个
          {failed.length > 0 ? `，${failed.length} 个没导入` : ""}
        </b>
        <button type="button" className="btn ghost small" onClick={onClose}>
          知道了
        </button>
      </div>
      {failed.map((r) => (
        <div key={r.dir}>
          ✗ {r.name}（{r.dir}）：{r.note}
        </div>
      ))}
      {noted.map((r) => (
        <div key={r.dir}>
          ✓ {r.name}：{r.note}
        </div>
      ))}
      {excluded.length > 0 && <div>没带进来：{excluded.join("、")}</div>}
    </div>
  );
}

/** 每行一条"原名=新名"（或"原名 → 新名"）的改名 */
function parseRenames(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^([^=→\s]+)\s*(?:=|→|->)\s*([^=→\s]+)$/.exec(line);
    if (!m) return `看不懂这一行改名：${line}（写成"原名=新名"）`;
    out[m[1]!] = m[2]!;
  }
  return out;
}

function ImportSkill({ onClose, onImport }: { onClose(): void; onImport(request: ImportSkillBody): Promise<void> }) {
  const [mode, setMode] = useState<"single" | "collection">("single");
  const [path, setPath] = useState("");
  const [rename, setRename] = useState("");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [version, setVersion] = useState("");
  const [description, setDescription] = useState("");
  const [skillsDir, setSkillsDir] = useState("");
  const [renames, setRenames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = path.trim() !== "" && (mode === "single" || (name.trim() && source.trim() && version.trim() && description.trim()));
  const submit = () => {
    let request: ImportSkillBody;
    if (mode === "single") {
      request = { path: path.trim(), ...(rename.trim() ? { rename: rename.trim() } : {}) };
    } else {
      const parsed = parseRenames(renames);
      if (typeof parsed === "string") return setError(parsed);
      request = {
        path: path.trim(),
        collection: {
          name: name.trim(),
          source: source.trim(),
          version: version.trim(),
          description: description.trim(),
          ...(skillsDir.trim() ? { skillsDir: skillsDir.trim() } : {}),
          ...(Object.keys(parsed).length > 0 ? { rename: parsed } : {}),
        },
      };
    }
    setBusy(true);
    setError(undefined);
    onImport(request).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
  };
  return (
    <Sheet title="导入 skill" onClose={onClose} center>
      <div className="seg" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "single"} className={mode === "single" ? "on" : ""} onClick={() => setMode("single")}>
          单个 skill
        </button>
        <button type="button" role="tab" aria-selected={mode === "collection"} className={mode === "collection" ? "on" : ""} onClick={() => setMode("collection")}>
          一整套（集合）
        </button>
      </div>
      <label className="field">
        <span>{mode === "single" ? "skill 所在的文件夹（含 SKILL.md）的完整路径" : "集合的根目录的完整路径"}</span>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={mode === "single" ? "比如 C:\\Users\\我\\.claude\\skills\\intent-mining" : "比如 D:\\下载\\某个插件"} />
      </label>
      {mode === "single" ? (
        <label className="field">
          <span>改名（不填就用 SKILL.md 里的 name）</span>
          <input value={rename} onChange={(e) => setRename(e.target.value)} placeholder="比如 mp-tdd" />
        </label>
      ) : (
        <>
          <div className="field-row">
            <label className="field">
              <span>集合名</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如 pstack" />
            </label>
            <label className="field">
              <span>版本</span>
              <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="比如 0.15.15" />
            </label>
          </div>
          <label className="field">
            <span>来源</span>
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="从哪来的，比如某个仓库的某个目录" />
          </label>
          <label className="field">
            <span>一句说明</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field">
            <span>成员在根目录下的哪个子目录（成员直接在根目录下就不填）</span>
            <input value={skillsDir} onChange={(e) => setSkillsDir(e.target.value)} placeholder="比如 skills" />
          </label>
          <label className="field">
            <span>成员改名（每行一条"原名=新名"，和库里重名时用）</span>
            <textarea rows={2} value={renames} onChange={(e) => setRenames(e.target.value)} placeholder="tdd=mp-tdd" />
          </label>
        </>
      )}
      <div className="hint">
        {mode === "single"
          ? "导入的是一份拷贝，放进数据目录里的 skill 区；名字和说明取 SKILL.md 开头的 name、description。改名只改目录名和 SKILL.md 里的 name，内容不动。"
          : "整个根目录复制一份进 skill 区（成员引用的 README、docs 这些一起带上）；成员仍是库里独立的 skill 名，和库里重名的整套不导入，可以给成员改名。"}
        node_modules 这类依赖目录不复制，按原路径引用；.git 和别的隐藏目录、.env*、*.pem、*.key 不带；来源里有符号链接或目录联接的不导入。二狗不会自动读 ~/.claude/skills；现成的 skill 要用，就在这里显式导入一份。
      </div>
      {error && <div className="hint">{error}</div>}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!ready || busy} onClick={submit}>
          {busy ? "导入中……" : "导入"}
        </button>
      </div>
    </Sheet>
  );
}
