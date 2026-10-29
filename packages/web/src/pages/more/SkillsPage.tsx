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
  t,
  type ToolkitCatalog,
} from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { SkillPicker } from "../../ui/skill-picker.tsx";
import { useToast } from "../../ui/toast.tsx";
import { AssistantName, NamedText, useAssistantName } from "../../ui/assistant-name.tsx";
import { T } from "../../ui/i18n.tsx";

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
      (err: unknown) => setProblem(t("pages.skills.loadFailed", { reason: err instanceof Error ? err.message : String(err) })),
    );
    http.secretarySkills().then(
      (v) => {
        setSecretary(v);
        setSecretaryProblem(undefined);
      },
      (err: unknown) => setSecretaryProblem(t("pages.skills.secretaryLoadFailed", { name: ASSISTANT_NAME_MARK, reason: err instanceof Error ? err.message : String(err) })),
    );
  }, [http]);
  useEffect(load, [load]);
  // 哪些项目的工具包用了它们（任务的工具包在任务详情里看）
  const usedBy = (names: readonly string[]) =>
    Object.values(ui.projects)
      .filter((p) => p.toolkit?.skills.some((s) => names.includes(s)))
      .map((p) => t("pages.skills.projectRef", { name: p.name }));
  const groups = catalog ? groupSkills(catalog) : undefined;
  const originSections: { title: string; origin: LibrarySkill["origin"] }[] = [
    { title: t("pages.skills.imported"), origin: "imported" },
    { title: t("pages.skills.framework"), origin: "framework" },
  ];
  const saveSecretary = (next: string[]) => {
    // 只能选库里有的；默认的两个（agent-browser、yt-dlp）还没导入的留着，导入后自动装上
    const kept = next.filter((n) => DEFAULT_SECRETARY_SKILLS.includes(n) || catalog?.skills.some((s) => s.name === n));
    http.setSecretarySkills(kept).then(
      (v) => {
        setSecretary(v);
        setSecretaryProblem(undefined);
        toast(t("pages.skills.saved", { name: assistantName }));
      },
      (err: unknown) => setSecretaryProblem(t("pages.skills.saveFailed", { reason: err instanceof Error ? err.message : String(err) })),
    );
  };
  return (
    <>
      <div className="add-row">
        <span className="muted">{t("pages.skills.intro")}</span>
        <button type="button" className="btn primary small" onClick={() => setImporting(true)}>
          {t("pages.skills.importButton")}
        </button>
      </div>
      {problem && <div className="hint">{problem}</div>}
      {!catalog && !problem && <div className="muted">{t("pages.skills.loading")}</div>}
      {lastImport && <ImportReport result={lastImport} onClose={() => setLastImport(undefined)} />}
      {catalog?.skillDirProblems && catalog.skillDirProblems.length > 0 && (
        // 斜杠命令就是 skill 的目录名（82 号票）：不合规的目录名二狗不自动改，这里提示
        <div className="hint skill-dir-problems">
          {t("pages.skills.dirProblems")}
          <ul>
            {catalog.skillDirProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {catalog && (
        <Section
          title={
            <T k="pages.skills.secretaryTitle" params={{ name: <AssistantName /> }} />
          }
        >
          <div className="skill-row skill-secretary">
            {secretary ? <SkillPicker catalog={catalog} selected={secretary.skills} onChange={saveSecretary} label={t("pages.skills.secretaryTitle", { name: assistantName })} /> : <span className="muted">{t("pages.skills.loadingShort")}</span>}
          </div>
          <div className="hint">
            <T k="pages.skills.secretaryHint" params={{ defaults: DEFAULT_SECRETARY_SKILLS.join(t("pages.common.listSep")), name: <AssistantName /> }} />
            {secretary ? secretarySkillsNote(secretary, catalog.skills) : ""}
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
        <Section title={t("pages.skills.collections")} extra={<span className="muted">{t("pages.skills.collectionsHint")}</span>}>
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
              {skills.length === 0 && <div className="muted">{g.origin === "imported" ? t("pages.skills.noImported") : t("pages.skills.none")}</div>}
              {skills.map((s) => (
                <SkillRow key={s.name} skill={s} used={usedBy([s.name])} />
              ))}
            </Section>
          );
        })}
      {catalog && (
        <Section title={t("pages.skills.mcp")} extra={<span className="muted">{t("pages.skills.mcpHint")}</span>}>
          {catalog.mcpProblem && <div className="hint">{t("pages.skills.mcpProblem", { reason: catalog.mcpProblem })}</div>}
          {catalog.mcp.length === 0 && !catalog.mcpProblem && <div className="muted">{t("pages.skills.noMcp")}</div>}
          {catalog.mcp.map((m) => (
            <div key={m.name} className="skill-row">
              <div>
                <b>{t("pages.skills.titleWithId", { title: m.title, id: m.name })}</b>
                {m.tools.map((tool) => (
                  <div key={tool.name} className="muted">
                    {t("pages.skills.titleWithId", { title: tool.title, id: tool.name })}
                    {tool.network ? t("pages.skills.network") : ""}
                    {tool.readOnlyOrIdempotent ? t("pages.skills.readOnly") : ""}
                    {tool.quickAction && (
                      <>
                        {" · "}
                        <T k="pages.skills.quickAction" params={{ name: <AssistantName />, action: tool.quickAction }} />
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
            toast(result.collection ? t("pages.skills.importedCollection", { name: result.collection.name, count: result.skills.length }) : t("pages.skills.importedSkill", { name: result.skills[0]?.name ?? "" }));
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
        <div className="muted">{used.length ? t("pages.skills.usedIn", { list: used.join(t("pages.common.listSep")) }) : t("pages.skills.notUsed")}</div>
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
          <span className="chip chip-data">{t("pages.skills.collection")}</span>
        </span>
        <span className="muted">{collectionMeta(collection)}</span>
        <span className="skill-collection-desc">{collection.description}</span>
        <span className="muted">{used.length ? t("pages.skills.usedIn", { list: used.join(t("pages.common.listSep")) }) : t("pages.skills.notUsed")}</span>
        <span className="skill-collection-toggle" aria-hidden="true">
          {open ? t("pages.skills.collapse") : t("pages.skills.viewMembers", { count: members.length })}
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
          {result.collection ? t("pages.skills.reportCollection", { name: result.collection.name }) : t("pages.skills.reportSkill", { name: result.skills[0]?.name ?? "" })}
          {t("pages.skills.reportImported", { count: result.skills.length })}
          {failed.length > 0 ? t("pages.skills.reportFailed", { count: failed.length }) : ""}
        </b>
        <button type="button" className="btn ghost small" onClick={onClose}>
          {t("pages.skills.gotIt")}
        </button>
      </div>
      {failed.map((r) => (
        <div key={r.dir}>
          {t("pages.skills.reportFailedLine", { name: r.name, dir: r.dir, note: r.note ?? "" })}
        </div>
      ))}
      {noted.map((r) => (
        <div key={r.dir}>
          {t("pages.skills.reportNoteLine", { name: r.name, note: r.note ?? "" })}
        </div>
      ))}
      {excluded.length > 0 && <div>{t("pages.skills.excluded", { list: excluded.join(t("pages.common.listSep")) })}</div>}
    </div>
  );
}

/** 每行一条"原名=新名"（或"原名 → 新名"）的改名 */
function parseRenames(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^([^=→\s]+)\s*(?:=|→|->)\s*([^=→\s]+)$/.exec(line);
    if (!m) return t("pages.skills.badRename", { line });
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
    <Sheet title={t("pages.skills.importTitle")} onClose={onClose} center>
      <div className="seg" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "single"} className={mode === "single" ? "on" : ""} onClick={() => setMode("single")}>
          {t("pages.skills.single")}
        </button>
        <button type="button" role="tab" aria-selected={mode === "collection"} className={mode === "collection" ? "on" : ""} onClick={() => setMode("collection")}>
          {t("pages.skills.wholeCollection")}
        </button>
      </div>
      <label className="field">
        <span>{mode === "single" ? t("pages.skills.pathSingle") : t("pages.skills.pathCollection")}</span>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={mode === "single" ? t("pages.skills.pathSinglePlaceholder") : t("pages.skills.pathCollectionPlaceholder")} />
      </label>
      {mode === "single" ? (
        <label className="field">
          <span>{t("pages.skills.rename")}</span>
          <input value={rename} onChange={(e) => setRename(e.target.value)} placeholder={t("pages.skills.renamePlaceholder")} />
        </label>
      ) : (
        <>
          <div className="field-row">
            <label className="field">
              <span>{t("pages.skills.collectionName")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("pages.skills.collectionNamePlaceholder")} />
            </label>
            <label className="field">
              <span>{t("pages.skills.version")}</span>
              <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={t("pages.skills.versionPlaceholder")} />
            </label>
          </div>
          <label className="field">
            <span>{t("pages.skills.source")}</span>
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder={t("pages.skills.sourcePlaceholder")} />
          </label>
          <label className="field">
            <span>{t("pages.skills.description")}</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("pages.skills.skillsDir")}</span>
            <input value={skillsDir} onChange={(e) => setSkillsDir(e.target.value)} placeholder={t("pages.skills.skillsDirPlaceholder")} />
          </label>
          <label className="field">
            <span>{t("pages.skills.renames")}</span>
            <textarea rows={2} value={renames} onChange={(e) => setRenames(e.target.value)} placeholder="tdd=mp-tdd" />
          </label>
        </>
      )}
      <div className="hint">
        {mode === "single" ? t("pages.skills.hintSingle") : t("pages.skills.hintCollection")}
        {t("pages.skills.hintTail")}
      </div>
      {error && <div className="hint">{error}</div>}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.skills.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={!ready || busy} onClick={submit}>
          {busy ? t("pages.skills.importing") : t("pages.skills.import")}
        </button>
      </div>
    </Sheet>
  );
}
