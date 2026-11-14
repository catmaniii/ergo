// 设置 · skill 库：框架自带的一批（第一阶段只有示例）和你导入的（数据目录的 skill 区）；导入 skill 的入口在这里。
// 列表和导入都走守护进程的 HTTP（GET 工具包目录、POST 导入）；原型里是假实现（prototype/fake-http.ts）。
// 二狗不读 ~/.claude/skills：现成的 skill 要用，就在这里显式导入一份。下面顺带列出配置区里登记的 MCP（只读：在配置区的 mcp.json 里改）。
// - 整套导入的集合（matt-pocock、pstack 这类）不一个一个列，各显示成一项：集合名、几个 skill、版本、来源、一句说明，点开才列出成员；
//   单个导入的、框架自带的照旧一个一个列（分组是状态层的 groupSkills）；
// - 秘书用的 skill：最上面一栏，选择和工具包区同一个部件（ui/skill-picker.tsx：集合整套选，点开单选），默认 agent-browser、yt-dlp；
//   改了之后秘书做完手头这一条就按新名单接着；
// - 导入：来源两种（465）——
//   - 本机文件夹：单个 skill（可以改名），或者把一个目录作为集合整套导入（集合名、来源、版本、说明、成员所在的子目录、成员改名）；
//     路径能手填，也能点「选文件夹…」开几处共用的选文件夹的框（ui/folder-picker.tsx，选的是二狗那台电脑上的，手机上也能点）；
//   - GitHub：填地址，「看看里面有什么」让守护进程下载、解开、回预览（单个还是一整套、成员、多大、脚本、不带进来的、和库里重名的），
//     看过再「安装」（同导入的校验和写入）；单个、集合的分法守护进程自己认，重名的就地改名，集合的成员能取消；
//   导完显示每个 skill 导入成功与否、哪些依赖目录按原路径引用。从 GitHub 装的在列表上多一行"来自 GitHub owner/repo@提交号"，点得开网址。
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import { useStore } from "../../app/store.tsx";
import {
  ASSISTANT_NAME_MARK,
  collectionMeta,
  DEFAULT_SECRETARY_SKILLS,
  type GithubInstallForm,
  type GithubSkillOrigin,
  type GithubSkillPreview,
  githubDroppedLines,
  githubInstallBody,
  githubPreviewSize,
  githubPreviewWhere,
  githubScriptsText,
  githubSourceLine,
  groupSkills,
  initialGithubForm,
  type ImportSkillBody,
  type ImportSkillResult,
  type LibrarySkill,
  type SecretarySkillsView,
  secretaryPromptSizeText,
  secretarySkillsNote,
  type SkillGroup,
  t,
  toggleGithubMember,
  type ToolkitCatalog,
} from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { FolderPickButton, FolderPickerSheet } from "../../ui/folder-picker.tsx";
import { Icon } from "../../ui/icons.tsx";
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
  /** 导好了（本机文件夹导入、从 GitHub 装一样）：说一句、关弹窗、页面上出报告、重取列表 */
  const imported = (result: ImportSkillResult) => {
    toast(result.collection ? t("pages.skills.importedCollection", { name: result.collection.name, count: result.skills.length }) : t("pages.skills.importedSkill", { name: result.skills[0]?.name ?? "" }));
    setImporting(false);
    setLastImport(result);
    load();
  };
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
        // 斜杠命令就是 skill 的目录名：不合规的目录名二狗不自动改，这里提示
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
                {m.auto && <div className="hint">{t("pages.skills.mcpAuto", { project: m.auto.projectName })}</div>}
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
          onImport={async (request) => imported(await http.importSkill(request))}
          github={http}
          onInstalled={imported}
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

/** 从 GitHub 装的：来源一行"来自 GitHub owner/repo@提交号"，点了开那个网址；不是从 GitHub 装的不画 */
export function SkillSourceLink({ origin }: { origin: GithubSkillOrigin | undefined }) {
  const line = githubSourceLine(origin);
  if (!line) return null;
  return (
    <a className="skill-source" href={line.url} target="_blank" rel="noopener noreferrer" title={line.url}>
      {line.text}
    </a>
  );
}

function SkillRow({ skill, used }: { skill: LibrarySkill; used: readonly string[] }) {
  return (
    <div className="skill-row">
      <div>
        <b>{skill.name}</b>
        <div className="muted">{skill.description}</div>
        <SkillSourceLink origin={skill.github} />
        {/* 负责人、秘书提交的：标上谁提的（秘书写用户给它起的名字） */}
        {skill.submittedBy && (
          <div className="muted">
            {skill.submittedBy.kind === "secretary" ? (
              <NamedText text={t("pages.skills.submittedBySecretary", { name: ASSISTANT_NAME_MARK })} />
            ) : (
              t(skill.submittedBy.kind === "project" ? "pages.skills.submittedByProject" : "pages.skills.submittedByTask", { title: skill.submittedBy.title ?? "" })
            )}
          </div>
        )}
        <div className="muted">{used.length ? t("pages.skills.usedIn", { list: used.join(t("pages.common.listSep")) }) : t("pages.skills.notUsed")}</div>
      </div>
    </div>
  );
}

/** 集合那一行：集合名、几个 skill、版本、来源、一句说明；点开列出成员。从 GitHub 装的下面一行来源（链接不能放进按钮里） */
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
      {collection.github && (
        <div className="skill-collection-source">
          <SkillSourceLink origin={collection.github} />
        </div>
      )}
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

/** 从 GitHub 装要的三个接口（DaemonHttp 里的） */
type GithubApi = Pick<DaemonHttp, "previewGithubSkill" | "installGithubSkill" | "discardGithubSkill">;

/** 导入弹窗：来源两种——本机文件夹（单个 / 集合，路径能点选）和 GitHub（填地址，先看再装） */
export function ImportSkill({ onClose, onImport, github, onInstalled }: { onClose(): void; onImport(request: ImportSkillBody): Promise<void>; github: GithubApi; onInstalled(result: ImportSkillResult): void }) {
  const [from, setFrom] = useState<"folder" | "github">("folder");
  return (
    <Sheet title={t("pages.skills.importTitle")} onClose={onClose} center>
      <div className="skill-import-from" role="tablist" aria-label={t("pages.skills.sourceLabel")}>
        <button type="button" role="tab" aria-selected={from === "folder"} className={from === "folder" ? "on" : ""} onClick={() => setFrom("folder")}>
          <Icon name="folder" />
          {t("pages.skills.fromFolder")}
        </button>
        <button type="button" role="tab" aria-selected={from === "github"} className={from === "github" ? "on" : ""} onClick={() => setFrom("github")}>
          <Icon name="globe" />
          {t("pages.skills.fromGithub")}
        </button>
      </div>
      {from === "folder" ? <ImportFromFolder onClose={onClose} onImport={onImport} /> : <ImportFromGithub onClose={onClose} api={github} onInstalled={onInstalled} />}
    </Sheet>
  );
}

function ImportFromFolder({ onClose, onImport }: { onClose(): void; onImport(request: ImportSkillBody): Promise<void> }) {
  const [mode, setMode] = useState<"single" | "collection">("single");
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [rename, setRename] = useState("");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [version, setVersion] = useState("");
  const [description, setDescription] = useState("");
  const [skillsDir, setSkillsDir] = useState("");
  const [renames, setRenames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pathId = useId();
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
    <>
      <div className="seg" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "single"} className={mode === "single" ? "on" : ""} onClick={() => setMode("single")}>
          {t("pages.skills.single")}
        </button>
        <button type="button" role="tab" aria-selected={mode === "collection"} className={mode === "collection" ? "on" : ""} onClick={() => setMode("collection")}>
          {t("pages.skills.wholeCollection")}
        </button>
      </div>
      <div className="field">
        <label htmlFor={pathId}>{mode === "single" ? t("pages.skills.pathSingle") : t("pages.skills.pathCollection")}</label>
        <div className="fp-path-row">
          <input id={pathId} className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder={mode === "single" ? t("pages.skills.pathSinglePlaceholder") : t("pages.skills.pathCollectionPlaceholder")} />
          <FolderPickButton disabled={busy} onClick={() => setPicking(true)} />
        </div>
      </div>
      {picking && (
        <FolderPickerSheet
          title={mode === "single" ? t("pages.skills.pickSingleTitle") : t("pages.skills.pickCollectionTitle")}
          intro={t("pages.skills.pickIntro")}
          onChoose={(chosen) => {
            setPath(chosen);
            setError(undefined);
          }}
          onClose={() => setPicking(false)}
        />
      )}
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
    </>
  );
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * GitHub 来源：填地址，点「看看里面有什么」，守护进程下载、解开、回预览；看过再点「安装」。
 * 换地址、关弹窗、切回本机文件夹时放弃这次预览（守护进程清掉下下来的）；看的途中关掉的，回来了也放弃
 */
function ImportFromGithub({ onClose, api, onInstalled }: { onClose(): void; api: GithubApi; onInstalled(result: ImportSkillResult): void }) {
  const [url, setUrl] = useState("");
  const [looking, setLooking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [preview, setPreview] = useState<GithubSkillPreview>();
  const [form, setForm] = useState<GithubInstallForm>();
  const [error, setError] = useState<string>();
  const urlId = useId();
  /** 还没装、还没放弃的预览（关掉时放弃它）；关掉了以后回来的预览直接放弃 */
  const pending = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pending.current) void api.discardGithubSkill(pending.current).catch(() => {});
    };
  }, [api]);
  const drop = () => {
    if (pending.current) void api.discardGithubSkill(pending.current).catch(() => {});
    pending.current = undefined;
    setPreview(undefined);
    setForm(undefined);
  };
  const look = () => {
    if (url.trim() === "" || looking) return;
    drop();
    setLooking(true);
    setError(undefined);
    api.previewGithubSkill(url.trim()).then(
      (p) => {
        if (!alive.current) {
          void api.discardGithubSkill(p.previewId).catch(() => {});
          return;
        }
        pending.current = p.previewId;
        setPreview(p);
        setForm(initialGithubForm(p));
        setLooking(false);
      },
      (err: unknown) => {
        if (!alive.current) return;
        setError(errorText(err));
        setLooking(false);
      },
    );
  };
  const install = () => {
    if (!preview || !form) return;
    const body = githubInstallBody(preview, form);
    if ("problem" in body) return setError(body.problem);
    setInstalling(true);
    setError(undefined);
    api.installGithubSkill(body).then(
      (result) => {
        pending.current = undefined;
        onInstalled(result);
      },
      (err: unknown) => {
        if (!alive.current) return;
        setError(errorText(err));
        setInstalling(false);
      },
    );
  };
  return (
    <>
      <div className="field">
        <label htmlFor={urlId}>{t("pages.skills.githubUrl")}</label>
        <div className="fp-path-row">
          <input
            id={urlId}
            className="input"
            value={url}
            spellCheck={false}
            inputMode="url"
            placeholder={t("pages.skills.githubUrlPlaceholder")}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") look();
            }}
          />
          <button type="button" className={preview ? "btn gh-look" : "btn primary gh-look"} disabled={looking || installing || url.trim() === ""} onClick={look}>
            {looking ? t("pages.skills.githubLooking") : t("pages.skills.githubLook")}
          </button>
        </div>
      </div>
      {!preview && <div className="hint">{t("pages.skills.githubHint")}</div>}
      {preview && form && <GithubPreviewView preview={preview} form={form} onForm={setForm} />}
      {error && <div className="hint gh-error">{error}</div>}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.skills.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={!preview || installing || looking} onClick={install}>
          {installing ? t("pages.skills.githubInstalling") : t("pages.skills.githubInstall")}
        </button>
      </div>
    </>
  );
}

/** GitHub 的预览：在哪、单个还是一整套、多大；单个的名字和说明（重名的就地改名）；集合的四项和成员（能取消、重名的就地改名）；脚本、不带进来的 */
export function GithubPreviewView({ preview, form, onForm }: { preview: GithubSkillPreview; form: GithubInstallForm; onForm(next: GithubInstallForm): void }) {
  const dropped = githubDroppedLines(preview);
  const members = preview.members ?? [];
  const set = (patch: Partial<GithubInstallForm>) => onForm({ ...form, ...patch });
  return (
    <div className="gh-preview">
      <div className="gh-preview-head">
        <span className="gh-where">{githubPreviewWhere(preview)}</span>
        <a href={preview.url} target="_blank" rel="noopener noreferrer" title={preview.url}>
          {t("pages.skills.githubOpen")}
        </a>
      </div>
      <div className="muted">
        {preview.kind === "single" ? t("pages.skills.githubIsSingle") : t("pages.skills.githubIsSet", { count: members.length })}
        {" · "}
        {githubPreviewSize(preview)}
      </div>
      {preview.kind === "single" && preview.single && (
        <div className="gh-single">
          <b>{preview.single.name}</b>
          <span className="muted">{preview.single.description}</span>
          {preview.single.sameName && <div className="gh-warn">{t("pages.skills.githubSameName", { owner: preview.single.sameName })}</div>}
          <label className="field">
            <span>{preview.single.sameName ? t("pages.skills.githubRenameNeeded") : t("pages.skills.rename")}</span>
            <input value={form.rename} onChange={(e) => set({ rename: e.target.value })} placeholder={t("pages.skills.renamePlaceholder")} />
          </label>
        </div>
      )}
      {preview.kind === "collection" && (
        <>
          {preview.collection?.nameTaken && <div className="gh-warn">{t("pages.skills.githubNameTaken", { name: preview.collection.name, owner: preview.collection.nameTaken })}</div>}
          <div className="field-row">
            <label className="field">
              <span>{t("pages.skills.collectionName")}</span>
              <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="field">
              <span>{t("pages.skills.version")}</span>
              <input value={form.version} onChange={(e) => set({ version: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>{t("pages.skills.source")}</span>
            <input value={form.source} onChange={(e) => set({ source: e.target.value })} />
          </label>
          <label className="field">
            <span>{t("pages.skills.description")}</span>
            <input value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder={t("pages.skills.githubDescriptionPlaceholder")} />
          </label>
          <div className="gh-members" role="group" aria-label={t("pages.skills.githubMembers")}>
            <div className="gh-members-head">
              <span>{t("pages.skills.githubMembersPicked", { picked: form.selected.length, total: members.filter((m) => m.problem === undefined).length })}</span>
            </div>
            {members.map((m) => {
              const on = form.selected.includes(m.dir);
              return (
                <div key={m.dir} className={`gh-member${m.problem ? " off" : ""}`}>
                  <label className="gh-member-pick">
                    <input type="checkbox" checked={on} disabled={m.problem !== undefined} onChange={() => onForm(toggleGithubMember(form, m.dir))} />
                    <span className="gh-member-text">
                      <b>{m.name}</b>
                      <span className="muted gh-member-dir">{m.dir}</span>
                      {m.problem ? <span className="gh-warn">{t("pages.skills.githubMemberProblem", { problem: m.problem })}</span> : <span className="muted">{m.description}</span>}
                    </span>
                  </label>
                  {m.sameName && on && (
                    <div className="gh-member-rename">
                      <span className="gh-warn">{t("pages.skills.githubSameName", { owner: m.sameName })}</span>
                      <input
                        className="input"
                        value={form.renames[m.name] ?? ""}
                        aria-label={t("pages.skills.githubRenameMember", { name: m.name })}
                        placeholder={t("pages.skills.githubRenamePlaceholder")}
                        onChange={(e) => set({ renames: { ...form.renames, [m.name]: e.target.value } })}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="gh-facts">
        <div className={preview.scriptCount > 0 ? "gh-scripts" : "muted"}>{githubScriptsText(preview)}</div>
        {dropped.map((line) => (
          <div key={line} className="muted">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
