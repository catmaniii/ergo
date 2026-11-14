// 从 GitHub 装 skill（465）：地址拆成仓库、ref、子目录——各种写法认得出，别的一律认不出；ref 里带 / 的从短往长试；下载地址、规范网址。
import { describe, expect, test } from "vitest";
import { archiveUrl, canonicalUrl, looksLikeVersionTag, parseGithubAddress, refCandidates } from "../../src/skills/github-url.ts";

describe("认得出的写法", () => {
  test.each([
    ["https://github.com/acme/skills", { owner: "acme", repo: "skills", hasRef: false, refAndPath: [], subdir: "" }],
    ["https://github.com/acme/skills/", { owner: "acme", repo: "skills", hasRef: false, subdir: "" }],
    ["https://github.com/acme/skills.git", { owner: "acme", repo: "skills", hasRef: false }],
    ["http://www.github.com/acme/skills?tab=readme#top", { owner: "acme", repo: "skills", hasRef: false }],
    ["github.com/acme/skills", { owner: "acme", repo: "skills", hasRef: false }],
    ["  https://github.com/acme/my.skill_set  ", { owner: "acme", repo: "my.skill_set" }],
    ["https://github.com/acme/skills/tree/main", { hasRef: true, refAndPath: ["main"] }],
    ["https://github.com/acme/skills/tree/v1.2.0/skills/tdd/", { hasRef: true, refAndPath: ["v1.2.0", "skills", "tdd"] }],
    ["https://github.com/acme/skills/tree/main/skills/%E4%B8%AD%E6%96%87", { refAndPath: ["main", "skills", "中文"] }],
    ["https://github.com/acme/skills/blob/main/skills/tdd/SKILL.md", { hasRef: true, refAndPath: ["main", "skills", "tdd"] }],
    ["https://github.com/acme/skills/blob/0123456789abcdef0123456789abcdef01234567/SKILL.md", { hasRef: true, refAndPath: ["0123456789abcdef0123456789abcdef01234567"] }],
    ["acme/skills", { owner: "acme", repo: "skills", hasRef: false, subdir: "" }],
    ["acme/skills/skills/tdd", { owner: "acme", repo: "skills", hasRef: false, subdir: "skills/tdd" }],
    ["acme/skills.git", { owner: "acme", repo: "skills" }],
  ])("%s", (input, expected) => {
    expect(parseGithubAddress(input)).toMatchObject(expected);
  });

  test("规范的网址：没写 ref 的是仓库首页，简写带子目录的写 tree/HEAD", () => {
    expect(parseGithubAddress("acme/skills")?.url).toBe("https://github.com/acme/skills");
    expect(parseGithubAddress("acme/skills/a/b")?.url).toBe("https://github.com/acme/skills/tree/HEAD/a/b");
    expect(parseGithubAddress("https://github.com/acme/skills.git/")?.url).toBe("https://github.com/acme/skills");
  });
});

describe("认不出的", () => {
  test.each([
    "",
    "   ",
    "skills",
    "https://github.com/acme",
    "https://github.com/",
    "https://gist.github.com/acme/0123456789abcdef",
    "https://gitlab.com/acme/skills",
    "https://gitee.com/acme/skills",
    "https://raw.githubusercontent.com/acme/skills/main/SKILL.md",
    "https://user:token@github.com/acme/skills",
    "https://ghp_fake@github.com/acme/skills",
    "https://github.com:8443/acme/skills",
    "ftp://github.com/acme/skills",
    "file:///C:/skills",
    "git@github.com:acme/skills.git",
    "https://github.com/acme/skills/issues/3",
    "https://github.com/acme/skills/releases",
    "https://github.com/acme/skills/tree",
    "https://github.com/acme/skills/blob/main",
    "https://github.com/acme/skills/tree/main/../etc",
    "https://github.com/acme/skills/tree/main/a%5Cb",
    "https://github.com/-bad/skills",
    "https://github.com/acme/..",
    "acme/skills with space",
    "C:\\Users\\me\\skills",
  ])("%j", (input) => {
    expect(parseGithubAddress(input)).toBeUndefined();
  });
});

describe("ref 和子目录的分法、下载地址", () => {
  test("没写 ref：一种分法（默认分支），下载 HEAD", () => {
    const a = parseGithubAddress("acme/skills/skills/tdd")!;
    expect(refCandidates(a)).toEqual([{ ref: undefined, subdir: "skills/tdd" }]);
    expect(archiveUrl(a, undefined)).toBe("https://github.com/acme/skills/archive/HEAD.tar.gz");
    expect(canonicalUrl(a, { ref: undefined, subdir: "skills/tdd" })).toBe("https://github.com/acme/skills/tree/HEAD/skills/tdd");
    expect(canonicalUrl(a, { ref: undefined, subdir: "" })).toBe("https://github.com/acme/skills");
  });

  test("ref 里带 / 的分支名：先当第一段是 ref，再一段一段并进去（最多四段）", () => {
    const a = parseGithubAddress("https://github.com/acme/skills/tree/feature/x/skills/tdd/more")!;
    expect(refCandidates(a)).toEqual([
      { ref: "feature", subdir: "x/skills/tdd/more" },
      { ref: "feature/x", subdir: "skills/tdd/more" },
      { ref: "feature/x/skills", subdir: "tdd/more" },
      { ref: "feature/x/skills/tdd", subdir: "more" },
    ]);
    expect(archiveUrl(a, "feature/x")).toBe("https://github.com/acme/skills/archive/feature/x.tar.gz");
    expect(canonicalUrl(a, { ref: "feature/x", subdir: "skills/tdd/more" })).toBe("https://github.com/acme/skills/tree/feature/x/skills/tdd/more");
  });

  test("像版本号的标签", () => {
    for (const tag of ["v1.2.3", "1.0", "2024.11.01-beta", "v0.15.15"]) expect(looksLikeVersionTag(tag)).toBe(true);
    for (const ref of ["main", "feature/x", "v1", "0123456789abcdef0123456789abcdef01234567"]) expect(looksLikeVersionTag(ref)).toBe(false);
  });
});
