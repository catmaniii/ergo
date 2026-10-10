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
import fs from "node:fs";
import path from "node:path";
import { type Charter, CHARTER_DECISION_LABEL, type CharterDecision, PROJECT_KIND_LABEL, type PlanToolkit, type Project } from "@ergou/protocol";
import { historyDirOf, isWithin } from "../guard/index.ts";

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
    binding: path.join(root, "binding.json"),
    history: historyDirOf(root),
    workdir: path.join(root, "workdir"),
  };
}

/** 项目的工作目录：绑定了外部路径就是它，否则是档案里的 workdir/ */
export function projectWorkdir(paths: ProjectRecordsPaths, project: Pick<Project, "workdir">): string {
  return project.workdir.external && project.workdir.path ? project.workdir.path : paths.workdir;
}

/** 最小文档集：文件、标题、一开始写什么（维护者在立项问答里往里写） */
const MINIMAL_DOCS: ReadonlyArray<{ key: keyof ProjectRecordsPaths; title: string; intro: string }> = [
  { key: "charter", title: "立项书", intro: "立项问答的结论：范围、目标、首版要做到什么程度、项目类型、工作目录。维护者交出、用户确认后由运行时写在这里。" },
  { key: "spec", title: "规格", intro: "这个项目要做成什么样：立项问答时由维护者写。" },
  { key: "glossary", title: "术语表", intro: "这个项目里的词：每个词一段，写清是什么、要避免的说法。" },
  { key: "progress", title: "进展", intro: "做到哪了、下一步做什么：每段工作结束时写回。" },
  { key: "manifest", title: "项目清单", intro: "项目有哪些东西：代码仓库、服务、定时触发的任务、公网入口、用到的外部工具。" },
  { key: "scopeRecords", title: "范围记录", intro: "范围审视的结果：用户授权过的范围变更，以及越界记录。" },
];

const ADR_README = "# 决策记录（ADR）\n\n每条决策一个文件，编号接着往下排：`0001-<简短的名字>.md`。写清背景、决定和后果。\n";

/** 建好项目档案的最小文档集和默认工作目录（已有的不动：守护进程重启时再对一遍也安全） */
export function ensureProjectRecords(paths: ProjectRecordsPaths, project: Pick<Project, "id" | "name" | "goal">): void {
  for (const dir of [paths.root, paths.adr, paths.workdir]) fs.mkdirSync(dir, { recursive: true });
  const head = `项目「${project.name}」（${project.id}）：${project.goal}`;
  for (const doc of MINIMAL_DOCS) writeIfMissing(paths[doc.key], `# ${doc.title}\n\n${head}\n\n${doc.intro}\n`);
  writeIfMissing(path.join(paths.adr, "README.md"), ADR_README);
}

function writeIfMissing(file: string, content: string): void {
  try {
    fs.writeFileSync(file, content, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** 立项书确认时写进档案：立项书（旧的先留一份）和工作目录的绑定关系 */
export function writeConfirmedCharter(
  paths: ProjectRecordsPaths,
  project: Pick<Project, "id" | "name">,
  charter: Charter,
  toolkit: PlanToolkit,
  confirmed: { decision: CharterDecision; at: string; workdir: string },
): void {
  preservePaths(paths, [paths.charter, paths.binding], confirmed.at);
  const lines = [
    `# 立项书`,
    "",
    `项目「${project.name}」（${project.id}）`,
    `用户 ${confirmed.at} 确认（${CHARTER_DECISION_LABEL[confirmed.decision]}）。`,
    "",
    "## 目标",
    "",
    charter.goal,
    "",
    "## 范围",
    "",
    ...charter.scope.map((s) => `- ${s}`),
    "",
    "## 首版",
    "",
    charter.firstVersion,
    "",
    "## 项目类型",
    "",
    PROJECT_KIND_LABEL[charter.kind],
    "",
    "## 工作目录",
    "",
    charter.bindExternal ? `绑定外部路径：${confirmed.workdir}（不随二狗备份，靠项目自己的 git 远端）` : `项目档案里的 workdir/（${confirmed.workdir}）`,
    "",
    "## 工具包",
    "",
    `- skill：${toolkit.skills.join("、") || "（无）"}`,
    `- MCP：${toolkit.mcp.join("、") || "（无）"}`,
    `- bash：${toolkit.bash ? "开" : "关"}`,
    `- 联网：${toolkit.network ? "开" : "关"}`,
    "",
  ];
  fs.writeFileSync(paths.charter, lines.join("\n"));
  const binding = charter.bindExternal ? { external: true, path: confirmed.workdir, boundAt: confirmed.at } : { external: false };
  fs.writeFileSync(paths.binding, `${JSON.stringify(binding, null, 2)}\n`);
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
  const existing = targets.filter((t) => isWithin(t, paths.root) && !isWithin(t, paths.history) && !isWithin(t, paths.workdir) && fs.existsSync(t));
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
