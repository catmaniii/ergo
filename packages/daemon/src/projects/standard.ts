// 项目规范（issue 19，258 号票）：模板和只读视图。
// - 模板放在框架里（本包的 templates/project-standard/<版本>/<开发类 dev | 其他类 other>/<语言>/），按版本分目录，两类各一套；
//   每份开头写清这份写什么、什么时候更新。模板只加新版本、不改旧版本：项目记着建档时用的版本（Project.standardVersion），
//   "还是模板原样"按它所在位置的任何版本、任何一类、任何语言的模板比。
// - 生成：项目档案里缺的从模板复制（已有的不动）。立项时项目类型还没定，按其他类那一套（规格、进展、决策记录：两类的这三份一字不差，
//   测试查）；立项书确认成开发类时再对一遍，补上架构图、tickets/、ops.json。按建档时的语言（没有这种语言的模板用中文的）。
//   辅助的几份（立项书、术语表、项目清单、范围记录）照旧由 records.ts 生成。
// - 只读视图（GET /api/projects/<id>/standard）：每份文档在不在、最近修改时间、是不是还是模板原样；当前状态的检查清单
//   （258 号票只有"进展已写回"，259 号票接着填）；本项目的规范改写。
// - 259 号票：建设中 → 使用中的检查清单（goLiveChecklist，issue 19 第 3 条）——架构图写清服务和对外接口、ops.json 交了（268 号票起是
//   清单验收通过：照 112 号票的自动验收，project-ops/ 给这一项）、
//   架构图里的服务都写进了运营方案（确认时照 133 号票的模板交给 LSM 登记）、对外接口里要外网的有带网页的服务（确认后开
//   /apps/<应用名>/）、进展写回。开发类五项都查；其他类只查进展，运营方案里真有服务的照开发类查。只读视图、"首版做完了"卡、
//   "转入使用"确认卡用的都是它；没做到的不挡确认，写明差什么。
// - 261 号票（本项目的规范改写，用户确认了的，standard-change.ts）：不要的那份不从模板补（ensureStandardDocs 的 dropped），视图里标
//   "本项目不要"、不再检查，看它的检查项不列（架构图那项看架构图、运营接口清单那项看 ops.json：不要架构图时服务、/apps/ 两项只看运营方案）；
//   换写法的标出来；多出来的接在必须有的后面（文件在就算写了，目录里要有一份）。
//   框架里最新的版本按模板目录算（latestStandardVersion）：项目记着的旧了只在视图里看得出（latest），不自动跟。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeLanguage,
  DEFAULT_LANGUAGE,
  type EffectiveStandardDoc,
  effectiveStandardDocs,
  nowIso,
  type OperationService,
  PROJECT_STANDARD_LATEST,
  type Project,
  type ProjectKind,
  type ProjectStandardView,
  STANDARD_CHECKLIST_ITEM_DOC,
  STANDARD_CHECKLIST_ITEM_LABEL,
  STANDARD_CHECKLIST_TO,
  STANDARD_DOCS,
  type StandardChecklistItem,
  standardChecklistApplies,
  type StandardChecklistItemId,
  type StandardDocKey,
  type StandardDocView,
  type StandardOverride,
  type StandardOverrideEntry,
  standardOverrideText,
  t,
} from "@ergo/protocol";
import type { ProjectRecordsPaths } from "./records.ts";

/** 框架里的规范模板 */
export const STANDARD_TEMPLATES_DIR = fileURLToPath(new URL("../../templates/project-standard/", import.meta.url));

/** 模板里的一份文件：在项目档案里的相对位置（正斜杠）和内容（换行统一成 \n） */
export interface StandardTemplateFile {
  rel: string;
  content: string;
}

export interface StandardTemplates {
  /** 有哪些版本（从旧到新） */
  versions(): string[];
  /** 某个版本、某类项目的模板文件：language 的（不给是现在的语言），没有这种语言的用中文的；没有这个版本是空的 */
  files(version: string, kind: ProjectKind, language?: string): StandardTemplateFile[];
  /** 这段内容是不是模板里这个位置的文件原样（任何版本、任何一类、任何语言） */
  isTemplate(rel: string, content: string): boolean;
}

const KINDS: readonly ProjectKind[] = ["dev", "other"];

/** 换行统一成 \n（仓库检出时可能是 \r\n） */
const lf = (text: string) => text.replace(/\r\n/g, "\n");

/** 目录下的文件（相对路径，正斜杠）；目录不在是空的 */
function filesUnder(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[];
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .toSorted();
}

const cache = new Map<string, StandardTemplates>();

/** 读模板目录（读一次留着：模板是框架的一部分，运行时不变） */
export function standardTemplates(dir: string = STANDARD_TEMPLATES_DIR): StandardTemplates {
  const cached = cache.get(dir);
  if (cached) return cached;
  /** 版本 → 类 → 语言 → 文件 */
  const tree = new Map<string, Map<ProjectKind, Map<string, StandardTemplateFile[]>>>();
  let versionDirs: string[] = [];
  try {
    versionDirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name);
  } catch {
    versionDirs = [];
  }
  const versions = versionDirs.toSorted((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  /** 相对位置 → 这个位置的所有模板内容 */
  const known = new Map<string, Set<string>>();
  for (const version of versions) {
    const kinds = new Map<ProjectKind, Map<string, StandardTemplateFile[]>>();
    for (const kind of KINDS) {
      const languages = new Map<string, StandardTemplateFile[]>();
      const kindDir = path.join(dir, version, kind);
      let languageDirs: string[] = [];
      try {
        languageDirs = fs.readdirSync(kindDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        languageDirs = [];
      }
      for (const language of languageDirs) {
        const files = filesUnder(path.join(kindDir, language)).map((rel) => ({ rel, content: lf(fs.readFileSync(path.join(kindDir, language, rel), "utf8")) }));
        languages.set(language, files);
        for (const f of files) known.set(f.rel, (known.get(f.rel) ?? new Set()).add(f.content));
      }
      kinds.set(kind, languages);
    }
    tree.set(version, kinds);
  }
  const templates: StandardTemplates = {
    versions: () => [...versions],
    files(version, kind, language = activeLanguage()) {
      const languages = tree.get(version)?.get(kind);
      return [...(languages?.get(language) ?? languages?.get(DEFAULT_LANGUAGE) ?? [])];
    },
    isTemplate: (rel, content) => known.get(rel)?.has(lf(content)) === true,
  };
  cache.set(dir, templates);
  return templates;
}

/** 框架里最新的模板版本（模板目录里最新的那个；读不到时是协议包的 PROJECT_STANDARD_LATEST） */
export function latestStandardVersion(templates: StandardTemplates = standardTemplates()): string {
  return templates.versions().at(-1) ?? PROJECT_STANDARD_LATEST;
}

/** 模板里的这个文件属于规范里的哪一份（按它在档案里的位置；不是规范里的那几份的没有） */
function docOfTemplateFile(rel: string): StandardDocKey | undefined {
  const head = rel.split("/")[0];
  return STANDARD_DOCS.find((key) => DOC_PLACES[key].fromTemplate && DOC_FILE[key] === head);
}

/**
 * 项目档案里缺的规范文档从模板复制（已有的不动）：kind 还没定（立项时）按其他类。没有这个版本的模板时什么都不做、返回 false
 * （调用方退回照旧的最小文档集）。dropped：本项目的规范改写里不要的那几份（261 号票），不补
 */
export function ensureStandardDocs(
  paths: ProjectRecordsPaths,
  version: string,
  kind: ProjectKind | undefined,
  templates: StandardTemplates = standardTemplates(),
  dropped: readonly StandardDocKey[] = [],
): boolean {
  const files = templates.files(version, kind ?? "other");
  if (files.length === 0) return false;
  for (const f of files) {
    const doc = docOfTemplateFile(f.rel);
    if (doc !== undefined && dropped.includes(doc)) continue;
    const target = path.join(paths.root, ...f.rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(target, f.content, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return true;
}

/** 每份文档在项目档案里的位置；dir：是目录（决策记录、票），里面除了说明文件 README.md 至少有一样才算写了 */
const DOC_PLACES: Readonly<Record<StandardDocKey, { place: keyof ProjectRecordsPaths; dir?: true; fromTemplate: boolean }>> = {
  spec: { place: "spec", fromTemplate: true },
  architecture: { place: "architecture", fromTemplate: true },
  progress: { place: "progress", fromTemplate: true },
  adr: { place: "adr", dir: true, fromTemplate: true },
  tickets: { place: "tickets", dir: true, fromTemplate: true },
  ops: { place: "ops", fromTemplate: true },
  charter: { place: "charter", fromTemplate: false },
  glossary: { place: "glossary", fromTemplate: false },
  manifest: { place: "manifest", fromTemplate: false },
  scopeRecords: { place: "scopeRecords", fromTemplate: false },
};

/** 每份文档在档案里的名字（目录不带 /）：模板里的文件按它认属于哪一份 */
const DOC_FILE: Readonly<Record<StandardDocKey, string>> = {
  spec: "spec.md",
  architecture: "architecture.md",
  progress: "progress.md",
  adr: "adr",
  tickets: "tickets",
  ops: "ops.json",
  charter: "charter.md",
  glossary: "glossary.md",
  manifest: "manifest.md",
  scopeRecords: "scope-records.md",
};

/** 一份文档在档案里的相对位置（正斜杠，目录以 / 结尾） */
export function standardDocPath(key: StandardDocKey): string {
  return DOC_FILE[key] + (DOC_PLACES[key].dir ? "/" : "");
}

/** 目录里的说明文件（模板带的）：只有它不算写了 */
const DIR_README = "README.md";

interface DocFacts {
  view: StandardDocView;
  /** 最近修改时间（毫秒） */
  mtimeMs?: number;
}

function docFacts(paths: ProjectRecordsPaths, key: StandardDocKey, role: StandardDocView["role"], templates: StandardTemplates): DocFacts {
  const { place, dir, fromTemplate } = DOC_PLACES[key];
  const abs = paths[place];
  const rel = path.relative(paths.root, abs).split(path.sep).join("/") + (dir ? "/" : "");
  return fileFacts({ key, path: rel, role }, abs, dir === true, fromTemplate ? templates : undefined);
}

/** 改写里多出来的那份（261 号票）：没有模板，文件在就算写了；目录里除了说明文件要有一份 */
function customDocFacts(paths: ProjectRecordsPaths, doc: EffectiveStandardDoc & { path: string }): DocFacts {
  const dir = doc.path.endsWith("/");
  const abs = path.join(paths.root, ...doc.path.split("/").filter(Boolean));
  const facts = fileFacts({ key: doc.key, path: doc.path, role: doc.role }, abs, dir, undefined);
  return { ...facts, view: { ...facts.view, override: "add", ...(doc.title === undefined ? {} : { title: doc.title }) } };
}

/** 一份文档（文件或目录）在不在、最近修改时间；从模板生成的（给了 templates）再看是不是还是模板原样，目录一律看 */
function fileFacts(base: Pick<StandardDocView, "key" | "path" | "role">, abs: string, dir: boolean, templates: StandardTemplates | undefined): DocFacts {
  const { key, path: rel, role } = base;
  const missing: DocFacts = { view: { key, path: rel, role, exists: false } };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return missing;
  }
  if (dir) {
    if (!stat.isDirectory()) return missing;
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const times = entries.flatMap((e) => {
      try {
        return [fs.statSync(path.join(abs, e.name)).mtimeMs];
      } catch {
        return [];
      }
    });
    const mtimeMs = times.length > 0 ? Math.max(...times) : stat.mtimeMs;
    const untouched = entries.every((e) => e.name === DIR_README);
    return { view: { key, path: rel, role, exists: true, modifiedAt: nowIso(new Date(mtimeMs)), untouched }, mtimeMs };
  }
  if (!stat.isFile()) return missing;
  const view: StandardDocView = { key, path: rel, role, exists: true, modifiedAt: nowIso(new Date(stat.mtimeMs)) };
  if (templates) {
    let content = "";
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      content = "";
    }
    view.untouched = templates.isTemplate(rel, content);
  }
  return { view, mtimeMs: stat.mtimeMs };
}

// ───────────────────────── 转运营检查清单（259 号票） ─────────────────────────

/** 运营方案里和检查清单有关的部分：每一条的名字、是服务的话服务名、应用名、有没有网页（"首版做完了"卡上带的那份就合用） */
export interface ChecklistPlan {
  items: ReadonlyArray<{ name: string; service?: Pick<OperationService, "name" | "app" | "web"> | undefined }>;
}

/** 架构图（architecture.md）里一张表的一行：每格去掉首尾空白、`反引号`、**加粗** */
type TableRow = string[];

/** 分隔行（|---|:--:|） */
const SEPARATOR_ROW = /^\|[\s:|-]*\|?$/;

/** 一格去掉加粗、反引号 */
const cellText = (c: string) =>
  c
    .trim()
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/^`(.*)`$/, "$1")
    .trim();

/** 一节（## 标题到下一个 ## 之前）里表格的数据行：表头、分隔行不算，空行不算 */
function tableRows(lines: readonly string[]): TableRow[] {
  const rows = lines.map((l) => l.trim()).filter((l) => l.startsWith("|"));
  return rows
    .slice(1)
    .filter((l) => !SEPARATOR_ROW.test(l))
    .map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cellText))
    .filter((cells) => cells.some((c) => c.length > 0));
}

/** 架构图里的几节（按 ## 标题认，中英文模板都认）：用到的服务、对外接口；没有这一节是 undefined */
export function architectureTables(text: string): { services?: TableRow[]; interfaces?: TableRow[] } {
  const sections: Array<{ title: string; body: string[] }> = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) sections.push({ title: heading[1]!.toLowerCase(), body: [] });
    else sections.at(-1)?.body.push(line);
  }
  const find = (match: (title: string) => boolean) => {
    const s = sections.find((x) => match(x.title));
    return s ? tableRows(s.body) : undefined;
  };
  // @i18n-ignore-start data：认维护者写的架构图里的标题（中英文模板都认），不是给人看的字
  const isInterfaces = (title: string) => title.includes("接口") || /\binterfaces?\b/.test(title);
  const services = find((title) => (title.includes("服务") || /\bservices?\b/.test(title)) && !isInterfaces(title));
  const interfaces = find(isInterfaces);
  // @i18n-ignore-end
  return { ...(services ? { services } : {}), ...(interfaces ? { interfaces } : {}) };
}

/** 一行写的是"没有"（没有服务、没有对外接口时写一行"无"） */
// @i18n-ignore-next data：认维护者在表里写的"没有"
const NONE_MARKS = new Set(["无", "没有", "（无）", "(无)", "none", "(none)", "n/a", "na", "-", "—", "——"]);
const isNoneRow = (row: TableRow) => NONE_MARKS.has((row[0] ?? "").toLowerCase());

/** 比名字时不看大小写、空白 */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** 两个名字算对得上：一样，或者互相包含 */
const sameName = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
};

/** 运营方案里的一条服务的几个名字：服务名、应用名、这一条的名字 */
const serviceNames = (item: ChecklistPlan["items"][number]) => (item.service ? [item.service.name, item.service.app, item.name] : []);

/** 一行对外接口要不要外网：写着 /apps/、公网、外网、public 的 */
// @i18n-ignore-next data：认维护者在对外接口表里写的走哪条路
const wantsOutside = (row: TableRow) => row.some((c) => /\/apps\/|公网|外网|public/i.test(c));

/** 一行里点名的 /apps/<应用名>/（写的是模板里的占位 <…> 不算点名） */
const namedApp = (row: TableRow): string | undefined => {
  for (const c of row) {
    const m = /\/apps\/([^/\s<>`]+)/.exec(c);
    if (m) return m[1];
  }
  return undefined;
};

const quoteList = (names: readonly string[]) => names.map((name) => t("projects.standard.check.quoted", { name })).join(t("projects.standard.check.listSep"));

/** 读一份文件（读不到是 undefined） */
const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

function checkItem(id: StandardChecklistItemId, done: boolean, detail?: string): StandardChecklistItem {
  return { id, label: STANDARD_CHECKLIST_ITEM_LABEL[id], done, ...(detail ? { detail } : {}) };
}

/** 架构图写清服务和对外接口；顺带给出它写的服务名和对外接口（服务、/apps/ 两项看它） */
function architectureItem(paths: ProjectRecordsPaths, templates: StandardTemplates, plan: ChecklistPlan | undefined): { item: StandardChecklistItem; services: string[]; interfaces: TableRow[] } {
  const text = readText(paths.architecture);
  const fail = (detail: string) => ({ item: checkItem("architecture", false, detail), services: [], interfaces: [] });
  if (text === undefined) return fail(t("projects.standard.check.architectureMissing"));
  if (templates.isTemplate("architecture.md", text)) return fail(t("projects.standard.check.architectureTemplate"));
  const tables = architectureTables(text);
  const services = (tables.services ?? [])
    .filter((r) => !isNoneRow(r))
    .map((r) => r[0] ?? "")
    .filter(Boolean);
  const interfaces = (tables.interfaces ?? []).filter((r) => !isNoneRow(r));
  const problems: string[] = [];
  if ((tables.services ?? []).length === 0) problems.push(t("projects.standard.check.servicesEmpty"));
  if ((tables.interfaces ?? []).length === 0) problems.push(t("projects.standard.check.interfacesEmpty"));
  // 运营方案里的服务架构图里都要写着（一张图说清项目由哪些部分组成）
  const unlisted = (plan?.items ?? []).flatMap((item) => (item.service && !services.some((s) => serviceNames(item).some((n) => sameName(n, s))) ? [item.service.name] : []));
  if (unlisted.length > 0) problems.push(t("projects.standard.check.planServiceUnlisted", { names: quoteList(unlisted) }));
  const item = problems.length > 0 ? checkItem("architecture", false, problems.join(t("projects.standard.check.sep"))) : checkItem("architecture", true);
  return { item, services, interfaces };
}

/** 运营接口清单（ops.json）交了：不是模板原样、合法的 JSON、tools 是列表、每个接口写了 name（268 号票起接上验收的用 project-ops/ 的那一项） */
function opsItem(paths: ProjectRecordsPaths, templates: StandardTemplates): StandardChecklistItem {
  const text = readText(paths.ops);
  if (text === undefined) return checkItem("ops", false, t("projects.standard.check.opsMissing"));
  if (templates.isTemplate("ops.json", text)) return checkItem("ops", false, t("projects.standard.check.opsTemplate"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return checkItem("ops", false, t("projects.standard.check.opsInvalid", { reason: err instanceof Error ? err.message : String(err) }));
  }
  const tools = typeof parsed === "object" && parsed !== null ? (parsed as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) return checkItem("ops", false, t("projects.standard.check.opsNoTools"));
  const named = (tool: unknown) => typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string" && (tool as { name: string }).name.trim().length > 0;
  const unnamed = tools.findIndex((tool) => !named(tool));
  if (unnamed >= 0) return checkItem("ops", false, t("projects.standard.check.opsUnnamed", { n: unnamed + 1 }));
  return checkItem("ops", true, t("projects.standard.check.opsCount", { count: tools.length }));
}

/** 架构图里的服务都写进了运营方案（means: service）：确认转入使用时照它交给 LSM 登记 */
function servicesItem(declared: readonly string[], plan: ChecklistPlan | undefined): StandardChecklistItem {
  const inPlan = (plan?.items ?? []).filter((i) => i.service);
  if (declared.length === 0 && inPlan.length === 0) return checkItem("services", true, t("projects.standard.check.noServices"));
  if (!plan) return checkItem("services", false, t("projects.standard.check.noPlan", { names: quoteList(declared) }));
  const missing = declared.filter((name) => !inPlan.some((item) => serviceNames(item).some((n) => sameName(n, name))));
  if (missing.length > 0) return checkItem("services", false, t("projects.standard.check.serviceNotInPlan", { names: quoteList(missing) }));
  return checkItem("services", true, t("projects.standard.check.servicesInPlan", { names: quoteList(inPlan.map((i) => i.service!.name)) }));
}

/** 对外接口里要外网的（/apps/、公网），运营方案里有对应的带网页的服务：确认后经二狗转发开 /apps/<应用名>/ */
function publicEntryItem(interfaces: readonly TableRow[], plan: ChecklistPlan | undefined): StandardChecklistItem {
  const web = (plan?.items ?? []).flatMap((i) => (i.service?.web ? [i.service] : []));
  const opened = () => t("projects.standard.check.appsOpened", { urls: web.map((s) => `/apps/${s.app}/`).join(t("projects.standard.check.listSep")) });
  const wanted = interfaces.filter(wantsOutside);
  if (wanted.length === 0) return checkItem("public_entry", true, web.length > 0 ? opened() : t("projects.standard.check.noOutside"));
  const missing = wanted.flatMap((row) => {
    const app = namedApp(row);
    const ok = app === undefined ? web.length > 0 : web.some((s) => s.app === app || s.name === app);
    return ok ? [] : [row[0] || app || "?"];
  });
  if (missing.length > 0) return checkItem("public_entry", false, t("projects.standard.check.outsideWithoutWeb", { names: quoteList(missing) }));
  return checkItem("public_entry", true, opened());
}

/** 进展写回了：在、不是模板原样、在进入现在这个状态之后改过 */
function progressItem(paths: ProjectRecordsPaths, templates: StandardTemplates, stateSince: string): StandardChecklistItem {
  const facts = docFacts(paths, "progress", "required", templates);
  if (facts.view.exists && facts.view.untouched !== true && (facts.mtimeMs ?? 0) >= Date.parse(stateSince)) return checkItem("progress_written", true);
  const detail = !facts.view.exists ? "projects.standard.check.progressMissing" : facts.view.untouched === true ? "projects.standard.check.progressTemplate" : "projects.standard.check.progressStale";
  return checkItem("progress_written", false, t(detail));
}

/** 建设中 → 使用中要查全五项：开发类；其他类运营方案里真有服务的也是（issue 19 第 4 条"真有服务就按开发类来"） */
const fullGoLiveCheck = (project: Pick<Project, "kind">, plan: ChecklistPlan | undefined) => project.kind === "dev" || (plan?.items ?? []).some((i) => i.service);

/** 看某一份文档的检查项（STANDARD_CHECKLIST_ITEM_DOC）在这个项目里列不列：这个项目不要那一份（261 号票的规范改写）就不列 */
const checklistApplies = (overrides: readonly StandardOverride[]) => (id: StandardChecklistItemId) => standardChecklistApplies(STANDARD_CHECKLIST_ITEM_DOC[id], overrides);

/**
 * 建设中 → 使用中的检查清单（259 号票）：开发类（或运营方案里有服务的）查架构图、ops.json、服务、/apps/、进展五项，别的只查进展。
 * plan：要随转入使用生效的那份运营方案（维护者建设期间交的；没交是 undefined）。
 * overrides：本项目的规范改写（261 号票）：不要架构图的不列架构图那项（服务、/apps/ 两项只看运营方案），不要 ops.json 的不列运营接口清单那项
 * ops：运营接口清单那一项（268 号票：照 112 号票的自动验收——格式对、每个操作一条能跑通的测试、只读的真不写，project-ops/ 的
 * checklistItem）；不给（没接上验收的单元测试）用 opsItem 只查最基本的几样
 */
export function goLiveChecklist(input: {
  project: Pick<Project, "kind">;
  paths: ProjectRecordsPaths;
  stateSince: string;
  plan?: ChecklistPlan | undefined;
  overrides?: readonly StandardOverride[];
  templates?: StandardTemplates;
  ops?: (() => StandardChecklistItem) | undefined;
}): StandardChecklistItem[] {
  const templates = input.templates ?? standardTemplates();
  const applies = checklistApplies(input.overrides ?? []);
  const progress = progressItem(input.paths, templates, input.stateSince);
  if (!fullGoLiveCheck(input.project, input.plan)) return [progress].filter((item) => applies(item.id));
  const arch = applies("architecture") ? architectureItem(input.paths, templates, input.plan) : undefined;
  const items = [
    arch?.item,
    applies("ops") ? (input.ops ? input.ops() : opsItem(input.paths, templates)) : undefined,
    servicesItem(arch?.services ?? [], input.plan),
    publicEntryItem(arch?.interfaces ?? [], input.plan),
    progress,
  ];
  return items.filter((item): item is StandardChecklistItem => item !== undefined && applies(item.id));
}

/** 现在生效的一条改写，带着提它的那一次说的为什么（projects/views.ts 的 standardOverrides） */
export type StandardOverrideRow = StandardOverrideEntry & { why: string };

/**
 * 一个项目的规范现在的样子（只读接口）。stateSince：进入现在这个状态的时间（"进展已写回"要在它之后改过、不是模板原样）；
 * plan：建设中时要随转入使用生效的那份运营方案（259 号票：检查清单的服务、/apps/ 两项看它）；
 * overrides：本项目现在生效的规范改写（261 号票，按确认的先后）
 */
export function projectStandardView(input: {
  project: Project;
  paths: ProjectRecordsPaths;
  stateSince: string;
  plan?: ChecklistPlan | undefined;
  overrides?: readonly StandardOverrideRow[];
  templates?: StandardTemplates;
  ops?: (() => StandardChecklistItem) | undefined;
}): ProjectStandardView {
  const { project, paths, stateSince } = input;
  const overrides = input.overrides ?? [];
  const templates = input.templates ?? standardTemplates();
  const facts = effectiveStandardDocs(project.kind, overrides).map((doc) => {
    if (doc.key === "custom") return customDocFacts(paths, { ...doc, path: doc.path ?? "" });
    const f = docFacts(paths, doc.key, doc.role, templates);
    return doc.override ? { ...f, view: { ...f.view, override: doc.override } } : f;
  });
  const to = STANDARD_CHECKLIST_TO[project.state];
  // 建设中 → 使用中查全（259 号票）；别的转换只要进展写回（停用时的反向收回由运行时做）
  const items: StandardChecklistItem[] =
    to === null
      ? []
      : project.state === "building"
        ? goLiveChecklist({ project, paths, stateSince, plan: input.plan, overrides, templates, ops: input.ops })
        : // 261 号票：看某一份文档的项，这个项目不要那一份（规范改写）就不列
          [progressItem(paths, templates, stateSince)].filter((item) => checklistApplies(overrides)(item.id));
  return {
    projectId: project.id,
    version: project.standardVersion ?? null,
    latest: latestStandardVersion(templates),
    kind: project.kind ?? null,
    docs: facts.map((f) => f.view),
    checklist: { from: project.state, to, items },
    overrides: overrides.map((o) => ({ ...o, path: o.kind === "add" ? o.path : standardDocPath(o.doc), summary: standardOverrideText(o) })),
  };
}
