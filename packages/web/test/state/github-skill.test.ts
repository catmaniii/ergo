// 从 GitHub 装 skill（465）在网页这一侧的纯函数：来源一行、预览的说明（在哪、多大、脚本、不带进来的）、默认的表、表变成安装请求。
// 守护进程的回答按协议的 schema 构造（编的仓库，不是真的）。
import { GithubSkillInstallBody as InstallSchema, GithubSkillPreview as PreviewSchema, schemaChecker } from "@ergo/protocol";
import { afterEach, describe, expect, test } from "vitest";
import {
  activeLocaleFrom,
  DEFAULT_LANGUAGE,
  type GithubSkillPreview,
  githubAt,
  githubDroppedLines,
  githubInstallBody,
  githubPreviewSize,
  githubPreviewWhere,
  githubScriptsText,
  githubSourceLine,
  initialGithubForm,
  setActiveLocale,
  toggleGithubMember,
} from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const checkPreview = schemaChecker(PreviewSchema);
const checkInstall = schemaChecker(InstallSchema);
const SHA = "0123456789abcdef0123456789abcdef01234567";

afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

function single(over: Partial<GithubSkillPreview> = {}): GithubSkillPreview {
  const p: GithubSkillPreview = {
    previewId: "p1",
    url: "https://github.com/acme/habit",
    repo: "acme/habit",
    commit: SHA,
    subdir: "",
    kind: "single",
    single: { name: "habit", description: "记习惯", dirName: "habit" },
    fileCount: 3,
    totalBytes: 2048,
    scripts: [],
    scriptCount: 0,
    dropped: [],
    expiresAt: "2026-11-14T03:00:00.000Z",
    ...over,
  };
  expect(checkPreview.check(p)).toBe(true);
  return p;
}

function set(): GithubSkillPreview {
  const p: GithubSkillPreview = {
    ...single(),
    kind: "collection",
    single: undefined,
    ref: "v1.0.0",
    url: "https://github.com/acme/pack/tree/v1.0.0",
    repo: "acme/pack",
    members: [
      { dir: "skills/a", name: "alpha", description: "甲" },
      { dir: "skills/b", name: "tdd", description: "乙", sameName: "你导入的 tdd" },
      { dir: "skills/broken", name: "broken", description: "", problem: "没有 frontmatter" },
    ],
    collection: { name: "pack", source: "https://github.com/acme/pack/tree/v1.0.0", version: "v1.0.0", description: "一套" },
  };
  delete p.single;
  expect(checkPreview.check(p)).toBe(true);
  return p;
}

describe("来源和预览的说法", () => {
  test("来源一行：提交号前 7 位，没有提交号写 ref，都没有写默认分支；不是 GitHub 来的没有", () => {
    expect(githubSourceLine({ url: "https://github.com/acme/habit", repo: "acme/habit", commit: SHA, installedAt: "x" })).toEqual({ text: "来自 GitHub acme/habit@0123456", url: "https://github.com/acme/habit" });
    expect(githubAt({ ref: "main" })).toBe("main");
    expect(githubAt({})).toBe("默认分支");
    expect(githubSourceLine(undefined)).toBeUndefined();
    // 装的是仓库里的一个子目录：链接指到那个子目录（网址守护进程拼好了）
    expect(githubSourceLine({ url: "https://github.com/acme/solo/tree/HEAD/skills/x", repo: "acme/solo", path: "skills/x", commit: SHA, installedAt: "x" })).toEqual({
      text: "来自 GitHub acme/solo@0123456",
      url: "https://github.com/acme/solo/tree/HEAD/skills/x",
    });
  });

  test("在哪、多大、脚本、不带进来的", () => {
    expect(githubPreviewWhere(single())).toBe("acme/habit@0123456");
    expect(githubPreviewWhere(single({ subdir: "skills/tdd" }))).toBe("acme/habit@0123456 里的 skills/tdd");
    expect(githubPreviewSize(single())).toBe("3 个文件，2.0 KB");
    expect(githubScriptsText(single())).toBe("没有脚本文件");
    expect(githubScriptsText(single({ scripts: ["a.sh", "b.py"], scriptCount: 2 }))).toBe("有 2 个脚本文件（用它的 agent 可能会运行）：a.sh、b.py");
    expect(githubScriptsText(single({ scripts: ["a.sh"], scriptCount: 40 }))).toContain("比如：a.sh 等");
    expect(
      githubDroppedLines(
        single({
          dropped: [
            { path: "docs/link", reason: "link" },
            { path: ".env", reason: "sensitive" },
            { path: "keys/a.pem", reason: "sensitive" },
            { path: "node_modules/", reason: "dependency" },
          ],
        }),
      ),
    ).toEqual(["密钥、凭据这类文件不带：.env、keys/a.pem", "链接不带：docs/link", "依赖目录不带（要用的话照 skill 的说明自己装）：node_modules/"]);
    expect(githubDroppedLines(single())).toEqual([]);
  });

  test("英文：单复数", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(githubSourceLine({ url: "u", repo: "acme/habit", installedAt: "x" })?.text).toBe("From GitHub acme/habit@default branch");
    expect(githubPreviewSize(single({ fileCount: 1 }))).toBe("1 file, 2.0 KB");
    expect(githubPreviewSize(single())).toBe("3 files, 2.0 KB");
  });
});

describe("表和安装请求", () => {
  test("单个：不改名就只带预览编号；改名的带上；名字不合写法的不发", () => {
    const p = single();
    const form = initialGithubForm(p);
    expect(githubInstallBody(p, form)).toEqual({ previewId: "p1" });
    expect(githubInstallBody(p, { ...form, rename: " gh-habit " })).toEqual({ previewId: "p1", rename: "gh-habit" });
    expect(githubInstallBody(p, { ...form, rename: "Bad Name" })).toEqual({ problem: expect.stringContaining("Bad Name") });
  });

  test("集合：四项填默认的、能装的全选上；取消一个、给重名的改名；四项没填全、一个没选的不发", () => {
    const p = set();
    const form = initialGithubForm(p);
    expect(form).toMatchObject({ name: "pack", version: "v1.0.0", description: "一套", selected: ["skills/a", "skills/b"] });
    const body = githubInstallBody(p, form);
    expect(body).toEqual({ previewId: "p1", collection: { name: "pack", source: "https://github.com/acme/pack/tree/v1.0.0", version: "v1.0.0", description: "一套", members: ["skills/a", "skills/b"] } });
    expect(checkInstall.check(body)).toBe(true);

    const picked = { ...toggleGithubMember(form, "skills/a"), renames: { tdd: "gh-tdd", alpha: "ignored" } };
    expect(picked.selected).toEqual(["skills/b"]);
    expect(githubInstallBody(p, picked)).toEqual({ previewId: "p1", collection: expect.objectContaining({ members: ["skills/b"], rename: { tdd: "gh-tdd" } }) });
    // 不合规的成员就算塞进选择里也不发
    expect(githubInstallBody(p, { ...form, selected: ["skills/broken", "skills/a"] })).toMatchObject({ collection: { members: ["skills/a"] } });
    expect(githubInstallBody(p, { ...form, description: " " })).toEqual({ problem: "集合名、来源、版本、一句说明都要填" });
    expect(githubInstallBody(p, { ...form, selected: [] })).toEqual({ problem: "至少选一个 skill" });
    expect(githubInstallBody(p, { ...form, name: "Pack" })).toEqual({ problem: expect.stringContaining("Pack") });
    expect(githubInstallBody(p, { ...form, renames: { tdd: "Bad" } })).toEqual({ problem: expect.stringContaining("Bad") });
  });
});
