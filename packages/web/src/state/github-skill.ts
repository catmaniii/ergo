// 从 GitHub 装 skill（465）在网页这一侧的纯函数：skill 库页上"来自 GitHub owner/repo@提交号"那一行、预览的几行说明
// （在哪、多大、脚本、不带进来的）、集合成员的默认选择、填好的表变成安装请求。界面在 pages/more/SkillsPage.tsx。
import { sizeLabel } from "./detail-content.ts";
import { type GithubDropReason, type GithubSkillInstallBody, type GithubSkillOrigin, type GithubSkillPreview, IMPORT_NAME_PATTERN, t } from "./protocol.ts";

/** 提交号的前 7 位（没有提交号的写 ref，都没有写"默认分支"） */
export function githubAt(origin: Pick<GithubSkillOrigin, "ref" | "commit">): string {
  return origin.commit?.slice(0, 7) ?? origin.ref ?? t("state.githubSkill.defaultBranch");
}

/** skill 库页上的来源一行："来自 GitHub acme/pack@0123abc"，点得开网址；不是从 GitHub 装的没有 */
export function githubSourceLine(origin: GithubSkillOrigin | undefined): { text: string; url: string } | undefined {
  if (!origin) return undefined;
  return { text: t("state.githubSkill.sourceLine", { repo: origin.repo, at: githubAt(origin) }), url: origin.url };
}

/** 预览在哪："acme/pack@0123abc"，指了子目录的加上子目录 */
export function githubPreviewWhere(p: Pick<GithubSkillPreview, "repo" | "ref" | "commit" | "subdir">): string {
  const at = t("state.githubSkill.repoAt", { repo: p.repo, at: githubAt(p) });
  return p.subdir === "" ? at : t("state.githubSkill.withSubdir", { where: at, subdir: p.subdir });
}

/** 预览多大："6 个文件，12.3 KB" */
export function githubPreviewSize(p: Pick<GithubSkillPreview, "fileCount" | "totalBytes">): string {
  return t("state.githubSkill.size", { count: p.fileCount, size: sizeLabel(p.totalBytes) });
}

/** 脚本那一行：有几个、是哪些（列不全的加"等"）；没有脚本的写一句没有 */
export function githubScriptsText(p: Pick<GithubSkillPreview, "scripts" | "scriptCount">): string {
  if (p.scriptCount === 0) return t("state.githubSkill.noScripts");
  const list = p.scripts.join(t("state.githubSkill.listSep"));
  return p.scriptCount > p.scripts.length ? t("state.githubSkill.scriptsMore", { count: p.scriptCount, list }) : t("state.githubSkill.scripts", { count: p.scriptCount, list });
}

const DROP_ORDER: readonly GithubDropReason[] = ["sensitive", "link", "hidden", "dependency", "badName", "duplicate"];

/** 不带进来的，按为什么一类一行（链接、密钥这类、隐藏目录……）；什么都不丢的是空的 */
export function githubDroppedLines(p: Pick<GithubSkillPreview, "dropped">): string[] {
  return DROP_ORDER.flatMap((reason) => {
    const paths = p.dropped.filter((d) => d.reason === reason).map((d) => d.path);
    if (paths.length === 0) return [];
    return [t(`state.githubSkill.dropped.${reason}`, { list: paths.join(t("state.githubSkill.listSep")) })];
  });
}

/** 填的表：单个的改名；集合的集合名、来源、版本、说明、选中的成员目录、成员改名（原来的 skill 名 → 新名字） */
export interface GithubInstallForm {
  rename: string;
  name: string;
  source: string;
  version: string;
  description: string;
  selected: readonly string[];
  renames: Readonly<Record<string, string>>;
}

/** 预览来了以后的表：集合名、来源、版本、说明填默认的；能装的成员全选上（不合规的选不了） */
export function initialGithubForm(p: GithubSkillPreview): GithubInstallForm {
  const c = p.collection;
  return {
    rename: "",
    name: c?.name ?? "",
    source: c?.source ?? "",
    version: c?.version ?? "",
    description: c?.description ?? "",
    selected: (p.members ?? []).filter((m) => m.problem === undefined).map((m) => m.dir),
    renames: {},
  };
}

/** 选上、取消一个成员 */
export function toggleGithubMember(form: GithubInstallForm, dir: string): GithubInstallForm {
  return { ...form, selected: form.selected.includes(dir) ? form.selected.filter((d) => d !== dir) : [...form.selected, dir] };
}

const IMPORT_NAME = new RegExp(IMPORT_NAME_PATTERN);

/** 新起的名字不合写法：回一句为什么；空的（不改名）、合写法的是 undefined */
function badName(name: string): { problem: string } | undefined {
  return name !== "" && !IMPORT_NAME.test(name) ? { problem: t("state.githubSkill.badName", { name }) } : undefined;
}

/**
 * 表变成安装请求；还不能装的回一句为什么（集合四项没填全、一个成员都没选、新名字不合写法）。
 * 重名的不在这里挡：守护进程照导入的规矩回"和谁重名"，用户就地改名再装
 */
export function githubInstallBody(p: GithubSkillPreview, form: GithubInstallForm): GithubSkillInstallBody | { problem: string } {
  if (p.kind === "single") {
    const rename = form.rename.trim();
    return badName(rename) ?? { previewId: p.previewId, ...(rename ? { rename } : {}) };
  }
  const [name, source, version, description] = [form.name, form.source, form.version, form.description].map((v) => v.trim()) as [string, string, string, string];
  if (!name || !source || !version || !description) return { problem: t("state.githubSkill.fillCollection") };
  const nameProblem = badName(name);
  if (nameProblem) return nameProblem;
  const members = (p.members ?? []).filter((m) => m.problem === undefined && form.selected.includes(m.dir));
  if (members.length === 0) return { problem: t("state.githubSkill.pickMembers") };
  const rename: Record<string, string> = {};
  for (const m of members) {
    const to = form.renames[m.name]?.trim() ?? "";
    if (to === "" || to === m.name) continue;
    const problem = badName(to);
    if (problem) return problem;
    rename[m.name] = to;
  }
  return {
    previewId: p.previewId,
    collection: { name, source, version, description, members: members.map((m) => m.dir), ...(Object.keys(rename).length > 0 ? { rename } : {}) },
  };
}
