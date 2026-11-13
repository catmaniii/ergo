// 从 GitHub 装 skill（465）：用户填的地址拆成仓库、ref、子目录。纯函数，不连网。
// 认的写法：
//   https://github.com/<owner>/<repo>                     整个仓库，默认分支
//   https://github.com/<owner>/<repo>/tree/<ref>/<子目录>  某个分支、标签或提交下的子目录（不写子目录是整个仓库）
//   https://github.com/<owner>/<repo>/blob/<ref>/<路径>    一个文件（一般是 SKILL.md）：取它所在的目录
//   末尾带 .git、带 /、带 ?… #… 的照样认；http://、www.github.com、不写 https:// 的 github.com/… 也认
//   简写 <owner>/<repo>、<owner>/<repo>/<子目录>（默认分支）
// 别的一律"认不出这个地址"：不是 github.com 的（gist.github.com、GitLab、Gitee……）、网址里带账号密码的、
// 只有用户名没有仓库的、仓库的别的页面（issues、releases……）。只支持公开仓库，不收、不存任何 token。
//
// **ref 里带 / 的分支名**（feature/x）在网址里和子目录分不开：tree/feature/x/skills 可能是分支 feature 下的 x/skills，
// 也可能是分支 feature/x 下的 skills。照 GitHub 网页自己的做法从短往长试——先当第一段是 ref，下载回 404 再把下一段并进 ref，
// 最多并 MAX_REF_SEGMENTS 段（refCandidates）。同时有 feature 和 feature/x 两个分支时认的是 feature，要装另一个就填提交号。

/** 拆好的 GitHub 地址 */
export interface GithubSkillAddress {
  owner: string;
  repo: string;
  /**
   * 网址里 tree/、blob/ 后面的那几段（ref 和子目录还没分开）；没写 ref（默认分支）是空的。
   * blob 的已经去掉了最后的文件名
   */
  refAndPath: string[];
  /** 写了 ref（tree/、blob/）；没写是默认分支 */
  hasRef: boolean;
  /** 简写、没写 ref 时直接给的子目录（/ 分隔，没有是空串） */
  subdir: string;
  /** 规范的网址（记来源、界面上点开用）：https://github.com/<owner>/<repo>[/tree/<ref>/<子目录>] */
  url: string;
}

/** ref 最多由几段组成（ref 里带 / 的分支名） */
export const MAX_REF_SEGMENTS = 4;

/** 用户名：字母数字和 -（GitHub 的规矩，最长 39） */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** 仓库名：字母数字和 . _ -，不能是 . 或 ..（最长 100） */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

const HOSTS = new Set(["github.com", "www.github.com"]);

/** 子目录、ref 里的一段：不能是空的、. 或 ..，不带反斜杠和控制字符 */
function safeSegment(seg: string): boolean {
  if (seg === "" || seg === "." || seg === ".." || seg.includes("\\")) return false;
  return ![...seg].some((c) => (c.codePointAt(0) ?? 0) < 0x20 || c === "\u007f");
}

/** 拆一个地址；认不出是 undefined */
export function parseGithubAddress(input: string): GithubSkillAddress | undefined {
  const text = input.trim();
  // 带空白的、路径里有 . 或 .. 这一段的（网址解析会把 a/../b 化成 b，这里先挡住，不猜用户要哪个）
  if (text === "" || /\s/.test(text) || /(?:^|[/\\])\.\.?(?:[/\\?#]|$)/.test(text)) return undefined;
  let segments: string[];
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || /^(?:www\.)?github\.com(?:[/?#]|$)/i.test(text)) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    // 带账号密码的（https://user:token@github.com/…）一律不认：只支持公开仓库，不收 token
    if (url.username !== "" || url.password !== "") return undefined;
    if (!HOSTS.has(url.hostname.toLowerCase()) || url.port !== "") return undefined;
    try {
      segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return undefined;
    }
  } else {
    // 简写：<owner>/<repo>[/<子目录>]；带 @、: 的（git@github.com:…、别的网址）不认
    if (/[@:?#]/.test(text)) return undefined;
    segments = text.split("/").filter(Boolean);
    if (segments.length < 2) return undefined;
    const [owner, repo, ...rest] = segments as [string, string, ...string[]];
    return build(owner, repo, false, [], rest);
  }
  if (segments.length < 2) return undefined;
  const [owner, repo, kind, ...rest] = segments as [string, string, string | undefined, ...string[]];
  if (kind === undefined) return build(owner, repo, false, [], []);
  if (kind === "tree") {
    if (rest.length === 0) return undefined;
    return build(owner, repo, true, rest, []);
  }
  if (kind === "blob") {
    // 一个文件：去掉文件名取它所在的目录；至少要有 ref 和文件名两段
    if (rest.length < 2) return undefined;
    return build(owner, repo, true, rest.slice(0, -1), []);
  }
  return undefined;
}

function build(owner: string, rawRepo: string, hasRef: boolean, refAndPath: string[], subdir: string[]): GithubSkillAddress | undefined {
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return undefined;
  if (![...refAndPath, ...subdir].every(safeSegment)) return undefined;
  const base = `https://github.com/${owner}/${repo}`;
  const tail = hasRef ? `/tree/${refAndPath.map(encodeURIComponent).join("/")}` : subdir.length > 0 ? `/tree/HEAD/${subdir.map(encodeURIComponent).join("/")}` : "";
  return { owner, repo, refAndPath, hasRef, subdir: subdir.join("/"), url: `${base}${tail}` };
}

/** 一种分法：ref 和子目录 */
export interface RefCandidate {
  /** 没写 ref（默认分支）是 undefined */
  ref: string | undefined;
  subdir: string;
}

/** ref 和子目录的几种分法，按先后试（第一段是 ref，404 了再把下一段并进 ref……） */
export function refCandidates(address: GithubSkillAddress): RefCandidate[] {
  if (!address.hasRef) return [{ ref: undefined, subdir: address.subdir }];
  const out: RefCandidate[] = [];
  for (let n = 1; n <= Math.min(MAX_REF_SEGMENTS, address.refAndPath.length); n++) {
    out.push({ ref: address.refAndPath.slice(0, n).join("/"), subdir: address.refAndPath.slice(n).join("/") });
  }
  return out;
}

/**
 * 下载地址：GitHub 的源码压缩包（git archive 打的 tar.gz，会转到 codeload.github.com）。没写 ref 用 HEAD（默认分支）。
 * base 是测试换的
 */
export function archiveUrl(address: Pick<GithubSkillAddress, "owner" | "repo">, ref: string | undefined, base = "https://github.com"): string {
  const refPath = (ref ?? "HEAD").split("/").map(encodeURIComponent).join("/");
  return `${base}/${address.owner}/${address.repo}/archive/${refPath}.tar.gz`;
}

/** 规范的网址：分好 ref 和子目录之后的（记来源用） */
export function canonicalUrl(address: Pick<GithubSkillAddress, "owner" | "repo">, candidate: RefCandidate): string {
  const base = `https://github.com/${address.owner}/${address.repo}`;
  const sub = candidate.subdir === "" ? [] : candidate.subdir.split("/");
  if (candidate.ref === undefined) return sub.length === 0 ? base : `${base}/tree/HEAD/${sub.map(encodeURIComponent).join("/")}`;
  return `${base}/tree/${[...candidate.ref.split("/"), ...sub].map(encodeURIComponent).join("/")}`;
}

/** 看着像版本号的标签（v1.2.3、1.0、2024.11.01-beta）：集合的版本默认用它，不用提交号 */
export function looksLikeVersionTag(ref: string): boolean {
  return /^v?\d+(?:\.\d+)+(?:[-+.][0-9A-Za-z.-]+)?$/.test(ref);
}
