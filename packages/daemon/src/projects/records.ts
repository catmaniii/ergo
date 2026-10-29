// 项目档案（规格第 11、18 节）：数据目录项目区里每个项目一格 projects/<项目 id>/，放一套最小文档
// （立项书、规格、术语表、ADR、进展、项目清单、范围记录），默认的工作目录 workdir/ 也在里面；维护者会话在会话区
// sessions/<维护者 id>/。项目档案随数据目录备份，永不进外部仓库。
// - 外部工作目录：开发类项目的立项书确认绑定外部路径后，工作目录就是那个外部路径（不建目录联接，直接用它）；
//   绑定关系记在 binding.json 和立项书里（外部路径不随二狗备份，靠项目自己的 git 远端）；
// - 历史区 .history/：项目档案里的文件被整体重写或删除前，运行时自动留一份旧版本（守卫接入的 autoVersioning），
//   所以守卫对项目档案里的文件传 backedUp，"删除或覆盖前须已备份或已提交"总是满足。工作目录不在内（默认的 workdir/
//   也不在内）：工作目录靠 git 提交或备份，照 v1 模板；也免得 rm -rf node_modules 这类调用整树同步复制。
//   历史区只由运行时写：任何 agent 用任何方式写入或删除都是永不（守卫的受保护区域），守卫也不对它传 backedUp；
// - 删除项目时整格删掉（外部工作目录不动：那是用户自己的东西）。
// - 258 号票（项目规范）：记了模板版本的项目（规范上线之后立项的），规格、进展、决策记录照规范模板生成，开发类另有架构图 architecture.md、
//   票 tickets/、运营接口清单 ops.json（standard.ts）；立项书、术语表、项目清单、范围记录照旧，算辅助。规范上线之前建的项目照旧的最小文档集。
// - 261 号票（本项目的规范改写）：补文档时跳过用户确认了不要的那几份；确认了的改写由运行时写成 standard-overrides.md（现在生效的每一条、
//   变更记录），维护者手改不算数。
import fs from "node:fs";
import path from "node:path";
import {
  type Charter,
  type CharterChangeItem,
  charterChangeItemText,
  type StandardChangeItem,
  standardChangeItemText,
  type StandardOverride,
  standardOverrideText,
  type StandardUpgrade,
  standardUpgradeText,
  CHARTER_DECISION_LABEL,
  type CharterDecision,
  PROJECT_KIND_LABEL,
  type PlanToolkit,
  type Project,
  type ProjectKind,
  type StandardDocKey,
  USER_WORDS_BADGE,
  userWordsLine,
  ASSISTANT_DOMAIN_TERM,
  fillAssistantName,
  type VerifiedUserWords,
  t,
} from "@ergo/protocol";
import { historyDirOf, isWithin } from "../guard/index.ts";
import { ensureStandardDocs } from "./standard.ts";

/** 一个项目的档案里各文件的位置 */
export interface ProjectRecordsPaths {
  root: string;
  charter: string;
  spec: string;
  glossary: string;
  adr: string;
  progress: string;
  manifest: string;
  scopeRecords: string;
  /** 架构图（258 号票：开发类的规范文档） */
  architecture: string;
  /** 票（258 号票：开发类，一票一文件） */
  tickets: string;
  /** 运营接口清单（258 号票：开发类，MCP 格式，转运营之前要交） */
  ops: string;
  /** 本项目的规范改写（261 号票）：运行时照用户确认了的规范改写写，维护者改了不算数 */
  standardOverrides: string;
  /** 绑定关系（外部工作目录） */
  binding: string;
  /** 历史区：被整体重写或删除前留的旧版本 */
  history: string;
  /** 默认的工作目录（没绑定外部路径时） */
  workdir: string;
}

export function projectRecordsPaths(projectsDir: string, projectId: string): ProjectRecordsPaths {
  const root = path.join(projectsDir, projectId);
  return {
    root,
    charter: path.join(root, "charter.md"),
    spec: path.join(root, "spec.md"),
    glossary: path.join(root, "glossary.md"),
    adr: path.join(root, "adr"),
    progress: path.join(root, "progress.md"),
    manifest: path.join(root, "manifest.md"),
    scopeRecords: path.join(root, "scope-records.md"),
    architecture: path.join(root, "architecture.md"),
    tickets: path.join(root, "tickets"),
    ops: path.join(root, "ops.json"),
    standardOverrides: path.join(root, "standard-overrides.md"),
    binding: path.join(root, "binding.json"),
    history: historyDirOf(root),
    workdir: path.join(root, "workdir"),
  };
}

/** 项目的工作目录：绑定了外部路径就是它，否则是档案里的 workdir/ */
export function projectWorkdir(paths: ProjectRecordsPaths, project: Pick<Project, "workdir">): string {
  return project.workdir.external && project.workdir.path ? project.workdir.path : paths.workdir;
}

/**
 * 立项书照项目的工作目录写（311 号票）：工作目录已经在外面的（305 号票新建时选的文件夹、290 号票接管来的会话原来的；立项书确认时不改它），
 * 立项书就是绑定了那个外部路径——走绑定外部路径同一条路（立项书卡、charter.md、binding.json 都写成已绑定），维护者交的绑不绑、哪条路径不算。
 * 不限开发类：文件夹是用户新建时定的，不是维护者提议绑定。工作目录在档案里的原样
 */
export function charterForWorkdir(charter: Charter, workdir: Project["workdir"] | undefined): Charter {
  if (!workdir?.external || workdir.path === undefined) return charter;
  if (charter.bindExternal && charter.externalPath === workdir.path) return charter;
  return { ...charter, bindExternal: true, externalPath: workdir.path };
}

/** 最小文档集：文件、标题、一开始写什么（维护者在立项问答里往里写） */
// 173 号票：建档时按当时的语言写（标题、开头的说明在语言文件里：projects.records.<文档>.title / .intro）
const MINIMAL_DOCS: ReadonlyArray<keyof ProjectRecordsPaths & ("charter" | "spec" | "glossary" | "progress" | "manifest" | "scopeRecords")> = [
  "charter",
  "spec",
  "glossary",
  "progress",
  "manifest",
  "scopeRecords",
];

/** 规格、进展（连同决策记录的说明）：记了模板版本的项目照规范模板生成（258 号票），规范上线之前建的照旧 */
const STANDARD_COVERED: ReadonlyArray<(typeof MINIMAL_DOCS)[number]> = ["spec", "progress"];

/**
 * 建好项目档案的最小文档集和默认工作目录（已有的不动：守护进程重启时再对一遍也安全）。258 号票：记了模板版本的（standardVersion），
 * 规格、进展、决策记录照规范模板；项目类型定了（立项书确认）再补上这一类另有的（开发类的架构图、tickets/、ops.json）。
 * 261 号票：dropped 是本项目的规范改写里不要的那几份（用户确认过的），不补。
 * 311 号票：工作目录已经在外面的（305 号票新建时选的文件夹、290 号票接管来的会话原来的、立项书绑定了外部路径的）不建档案里那个用不上的 workdir/
 */
export function ensureProjectRecords(
  paths: ProjectRecordsPaths,
  project: Pick<Project, "id" | "name" | "goal"> & { standardVersion?: string | undefined; kind?: ProjectKind | undefined; workdir?: Project["workdir"] | undefined },
  options: { dropped?: readonly StandardDocKey[] } = {},
): void {
  const dropped = options.dropped ?? [];
  const outside = project.workdir?.external === true && project.workdir.path !== undefined;
  for (const dir of [paths.root, ...(dropped.includes("adr") ? [] : [paths.adr]), ...(outside ? [] : [paths.workdir])]) fs.mkdirSync(dir, { recursive: true });
  const standard = project.standardVersion !== undefined && ensureStandardDocs(paths, project.standardVersion, project.kind, undefined, dropped);
  const head = t("projects.records.head", { name: project.name, id: project.id, goal: project.goal });
  for (const doc of MINIMAL_DOCS) {
    if (standard && STANDARD_COVERED.includes(doc)) continue;
    if ((dropped as readonly string[]).includes(doc)) continue;
    writeIfMissing(paths[doc], `# ${t(`projects.records.${doc}.title`)}\n\n${head}\n\n${t(`projects.records.${doc}.intro`)}\n`);
  }
  if (!standard && !dropped.includes("adr")) writeIfMissing(path.join(paths.adr, "README.md"), t("projects.records.adrReadme"));
}

function writeIfMissing(file: string, content: string): void {
  try {
    fs.writeFileSync(file, content, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/**
 * 立项书末尾的一条变更记录（125 号票）：哪天、改了什么、依据的用户原话（运行时核实过的）、维护者为什么提、用户确认
 */
export interface CharterChangeRecord {
  /** 这个项目的第几次立项要求变更 */
  revision: number;
  changes: readonly CharterChangeItem[];
  userWords: readonly VerifiedUserWords[];
  why: string;
  /** 提出的时间、用户确认的时间 */
  proposedAt: string;
  confirmedAt: string;
  note?: string | undefined;
}

/** 时间写成"2026-10-14 08:52"（协议时间是本地时间带偏移） */
const dayTime = (iso: string) => iso.slice(0, 16).replace("T", " ");

/**
 * 立项书的全文（项目档案里的 charter.md；125 号票起范围审视的对照物也用它，从事件算，不读文件）：现在的立项要求，
 * 末尾是每一次用户确认了的立项要求变更
 */
export function charterMarkdown(
  project: Pick<Project, "id" | "name">,
  charter: Charter,
  toolkit: PlanToolkit,
  confirmed: { decision: CharterDecision; at: string; workdir: string },
  changes: readonly CharterChangeRecord[] = [],
): string {
  const lines = [
    `# ${t("projects.records.charter.title")}`,
    "",
    t("projects.records.charterProject", { name: project.name, id: project.id }),
    t("projects.records.charterConfirmed", { at: confirmed.at, decision: CHARTER_DECISION_LABEL[confirmed.decision] }),
    "",
    `## ${t("projects.records.charterGoal")}`,
    "",
    charter.goal,
    "",
    `## ${t("projects.records.charterScope")}`,
    "",
    ...charter.scope.map((s) => `- ${s}`),
    "",
    `## ${t("projects.records.charterFirstVersion")}`,
    "",
    charter.firstVersion,
    "",
    `## ${t("projects.records.charterKind")}`,
    "",
    PROJECT_KIND_LABEL[charter.kind],
    "",
    `## ${t("projects.records.charterWorkdir")}`,
    "",
    t(charter.bindExternal ? "projects.records.workdirBound" : "projects.records.workdirInRecords", { path: confirmed.workdir }),
    "",
    `## ${t("projects.records.charterToolkit")}`,
    "",
    t("projects.records.toolkitSkills", { list: toolkit.skills.join(t("pages.common.listSep")) || t("projects.records.none") }),
    t("projects.records.toolkitMcp", { list: toolkit.mcp.join(t("pages.common.listSep")) || t("projects.records.none") }),
    t("projects.records.toolkitBash", { on: t(toolkit.bash ? "projects.records.on" : "projects.records.off") }),
    t("projects.records.toolkitNetwork", { on: t(toolkit.network ? "projects.records.on" : "projects.records.off") }),
    "",
    // 运营方式（130 号票，选填）：只是个大概，不算授权
    ...(charter.operations ? [`## ${t("projects.records.charterOperations")}`, "", charter.operations, "", t("projects.records.operationsNote"), ""] : []),
  ];
  if (changes.length > 0) {
    lines.push(`## ${t("projects.records.changes")}`, "", t("projects.records.changesIntro"), "");
    for (const c of changes) {
      lines.push(
        `### ${t("projects.records.changeHead", { revision: c.revision, at: dayTime(c.confirmedAt) })}`,
        "",
        ...c.changes.map((item) => `- ${charterChangeItemText(item)}`),
        t("projects.records.changeWhy", { why: c.why }),
        ...(c.userWords.length > 0
          ? [t("projects.records.changeWords", { badge: USER_WORDS_BADGE }), ...c.userWords.map((w) => `  - ${fillAssistantName(userWordsLine(w), ASSISTANT_DOMAIN_TERM)}`)]
          : [t("projects.records.changeNoWords")]),
        t(c.note ? "projects.records.changeConfirmedNote" : "projects.records.changeConfirmed", { at: dayTime(c.confirmedAt), note: c.note ?? "", proposed: dayTime(c.proposedAt) }),
        "",
      );
    }
  }
  return lines.join("\n");
}

/**
 * 立项书确认时写进档案：立项书（旧的先留一份）和工作目录的绑定关系；125 号票起立项要求变更确认后也重写一遍（末尾带变更记录）。
 * 311 号票：工作目录在立项之前就定在外面的，照它写成已绑定（charterForWorkdir；修好之前交的立项书也一样）
 */
export function writeConfirmedCharter(
  paths: ProjectRecordsPaths,
  project: Pick<Project, "id" | "name"> & { workdir?: Project["workdir"] | undefined },
  submitted: Charter,
  toolkit: PlanToolkit,
  confirmed: { decision: CharterDecision; at: string; workdir: string },
  changes: readonly CharterChangeRecord[] = [],
): void {
  const charter = charterForWorkdir(submitted, project.workdir);
  const at = changes.at(-1)?.confirmedAt ?? confirmed.at;
  preservePaths(paths, [paths.charter, paths.binding], at);
  fs.writeFileSync(paths.charter, charterMarkdown(project, charter, toolkit, confirmed, changes));
  const binding = charter.bindExternal ? { external: true, path: confirmed.workdir, boundAt: confirmed.at } : { external: false };
  fs.writeFileSync(paths.binding, `${JSON.stringify(binding, null, 2)}\n`);
}

/** 本项目的规范改写里用户确认了的一次（261 号票，standard-overrides.md 末尾的变更记录） */
export interface StandardChangeRecord {
  /** 这个项目的第几次规范改写 */
  revision: number;
  items: readonly StandardChangeItem[];
  upgrade?: StandardUpgrade | undefined;
  userWords: readonly VerifiedUserWords[];
  why: string;
  proposedAt: string;
  confirmedAt: string;
  note?: string | undefined;
}

/**
 * 本项目的规范改写（261 号票，项目档案里的 standard-overrides.md）：用的哪一版规范、现在生效的每一条改写，末尾是用户确认了的每一次。
 * 由运行时照事件写（维护者改了不算数，下次确认时整份重写）
 */
export function standardOverridesMarkdown(
  project: Pick<Project, "id" | "name">,
  version: string | undefined,
  overrides: readonly StandardOverride[],
  changes: readonly StandardChangeRecord[],
): string {
  const lines = [
    `# ${t("projects.records.standardOverrides.title")}`,
    "",
    t("projects.records.standardOverrides.intro", { name: project.name, id: project.id, version: version ?? t("projects.records.standardOverrides.noVersion") }),
    "",
    `## ${t("projects.records.standardOverrides.current")}`,
    "",
    ...(overrides.length > 0 ? overrides.map((o) => `- ${standardOverrideText(o)}`) : [t("projects.records.standardOverrides.none")]),
    "",
  ];
  if (changes.length > 0) {
    lines.push(`## ${t("projects.records.changes")}`, "", t("projects.records.standardOverrides.changesIntro"), "");
    for (const c of changes) {
      lines.push(
        `### ${t("projects.records.changeHead", { revision: c.revision, at: dayTime(c.confirmedAt) })}`,
        "",
        ...(c.upgrade ? [`- ${standardUpgradeText(c.upgrade)}`] : []),
        ...c.items.map((item) => `- ${standardChangeItemText(item)}`),
        t("projects.records.changeWhy", { why: c.why }),
        ...(c.userWords.length > 0
          ? [t("projects.records.changeWords", { badge: USER_WORDS_BADGE }), ...c.userWords.map((w) => `  - ${fillAssistantName(userWordsLine(w), ASSISTANT_DOMAIN_TERM)}`)]
          : [t("projects.records.changeNoWords")]),
        t(c.note ? "projects.records.changeConfirmedNote" : "projects.records.changeConfirmed", { at: dayTime(c.confirmedAt), note: c.note ?? "", proposed: dayTime(c.proposedAt) }),
        "",
      );
    }
  }
  return lines.join("\n");
}

/** 本项目的规范改写写进档案（261 号票）：和现在的不一样才写，旧的先留进历史区；写了返回 true */
export function writeStandardOverrides(paths: ProjectRecordsPaths, text: string, at: string): boolean {
  let current: string | undefined;
  try {
    current = fs.readFileSync(paths.standardOverrides, "utf8");
  } catch {
    current = undefined;
  }
  if (current === text) return false;
  preservePaths(paths, [paths.standardOverrides], at);
  fs.writeFileSync(paths.standardOverrides, text);
  return true;
}

/** 删除项目时整格删掉（外部工作目录不在这里面，不动） */
export function removeProjectRecords(paths: ProjectRecordsPaths): void {
  fs.rmSync(paths.root, { recursive: true, force: true });
}

// ───────────────────────── 历史区 ─────────────────────────

/** 历史区里这一次的目录名：时间（到毫秒），同一毫秒里再来一次加序号 */
function historySlot(paths: ProjectRecordsPaths, at: string): string {
  const stamp = at.replace(/[^0-9]/g, "").slice(0, 17);
  for (let i = 0; ; i++) {
    const dir = path.join(paths.history, i === 0 ? stamp : `${stamp}-${i}`);
    if (!fs.existsSync(dir)) return dir;
  }
}

/** 把这些（在项目档案里、已经存在的）文件或目录复制进历史区；历史区自己的、工作目录里的不留 */
export function preservePaths(paths: ProjectRecordsPaths, targets: readonly string[], at: string): string[] {
  const existing = targets.filter((target) => isWithin(target, paths.root) && !isWithin(target, paths.history) && !isWithin(target, paths.workdir) && fs.existsSync(target));
  if (existing.length === 0) return [];
  const slot = historySlot(paths, at);
  for (const target of existing) {
    const dest = path.join(slot, path.relative(paths.root, target));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 符号链接和目录联接不跟进（和快照一样）
    fs.cpSync(target, dest, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
  }
  return existing;
}

/**
 * 运行时自动留旧版本的地方：某个项目的档案里，不含它的默认工作目录 workdir/ 和历史区（项目区本身、项目档案的根不算：
 * 删掉整个项目档案连带删掉历史区，守卫判永不）
 */
export function isAutoVersioned(projectsDir: string, target: string): boolean {
  if (!isWithin(target, projectsDir)) return false;
  const projectId = path.relative(projectsDir, target).split(/[\\/]/)[0];
  if (!projectId || projectId === "..") return false;
  const paths = projectRecordsPaths(projectsDir, projectId);
  if (path.relative(paths.root, target) === "") return false;
  return !isWithin(target, paths.workdir) && !isWithin(target, paths.history);
}

/** 放行一次调用之前（守卫接入的 autoVersioning）：它要删除或整体重写的、项目档案里已经存在的文件或目录，先复制进各自项目的历史区 */
export function preserveVersions(projectsDir: string, targets: readonly string[], at: string): void {
  const byProject = new Map<string, string[]>();
  for (const target of targets) {
    if (!isAutoVersioned(projectsDir, target)) continue;
    const projectId = path.relative(projectsDir, target).split(/[\\/]/)[0]!;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), target]);
  }
  for (const [projectId, list] of byProject) preservePaths(projectRecordsPaths(projectsDir, projectId), list, at);
}
