// 设置 · skill 库：导入弹窗的两种来源（本机文件夹带「选文件夹…」、GitHub 填地址）、GitHub 的预览（单个、集合）、列表上的来源一行。
// 用 React 在 Node 里渲染出来查；整页在原型里打得开见 page-opens.test.ts，截图用原型的演示数据。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GithubPreviewView, ImportSkill, SkillSourceLink } from "../../src/pages/more/SkillsPage.tsx";
import { FAKE_GITHUB_SET, FAKE_GITHUB_SINGLE, FAKE_GITHUB_SOLO } from "../../src/prototype/fake-github-skills.ts";
import { activeLocaleFrom, DEFAULT_LANGUAGE, type GithubSkillPreview, initialGithubForm, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

const noop = () => {};
const preview = (p: Omit<GithubSkillPreview, "previewId" | "expiresAt">): GithubSkillPreview => ({ ...p, previewId: "demo-1", expiresAt: "2026-11-14T03:00:00.000Z" });
const renderPreview = (p: GithubSkillPreview) => renderToStaticMarkup(createElement(GithubPreviewView, { preview: p, form: initialGithubForm(p), onForm: noop }));
const api = { previewGithubSkill: () => Promise.reject(new Error("x")), installGithubSkill: () => Promise.reject(new Error("x")), discardGithubSkill: () => Promise.resolve() };

describe("导入弹窗", () => {
  test("两种来源；本机文件夹的路径框旁边有「选文件夹…」", () => {
    const html = renderToStaticMarkup(createElement(ImportSkill, { onClose: noop, onImport: () => Promise.resolve(), github: api, onInstalled: noop }));
    expect(html).toContain("本机文件夹");
    expect(html).toContain("GitHub");
    expect(html).toMatch(/class="skill-import-from"[^>]*role="tablist"|role="tablist"[^>]*class="skill-import-from"/);
    expect(html).toContain('aria-selected="true" class="on"');
    expect(html).toContain("fp-path-row");
    expect(html).toContain("选文件夹…");
    expect(html).toContain("skill 所在的文件夹（含 SKILL.md）的完整路径");
  });

  test("英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = renderToStaticMarkup(createElement(ImportSkill, { onClose: noop, onImport: () => Promise.resolve(), github: api, onInstalled: noop }));
    expect(html).toContain("Folder on this computer");
    expect(html).not.toMatch(/[一-鿿]/);
  });
});

describe("GitHub 的预览", () => {
  test("单个：在哪、多大、名字和说明、改名框、脚本、不带进来的", () => {
    const html = renderPreview(preview(FAKE_GITHUB_SINGLE));
    expect(html).toContain("demo-org/habit-tracker@3f2a9c1");
    expect(html).toContain('href="https://github.com/demo-org/habit-tracker"');
    expect(html).toContain("单个 skill");
    expect(html).toContain("6 个文件，18.0 KB");
    expect(html).toContain("habit-tracker");
    expect(html).toContain("改名（不填就用 SKILL.md 里的 name）");
    expect(html).toContain("有 2 个脚本文件（用它的 agent 可能会运行）：scripts/remind.ps1、scripts/stats.py");
    expect(html).toContain("密钥、凭据这类文件不带：.env");
    expect(html).toContain("隐藏的文件和目录不带：.github/");
  });

  test("仓库首页里只有一个 skill（在 skills/meeting-notes）：按单个预览，在哪写到那个子目录，链接指到它；没有集合的那几项", () => {
    const html = renderPreview(preview(FAKE_GITHUB_SOLO));
    expect(html).toContain("demo-org/solo-skill@6d0b3e9 里的 skills/meeting-notes");
    expect(html).toContain('href="https://github.com/demo-org/solo-skill/tree/HEAD/skills/meeting-notes"');
    expect(html).toContain("单个 skill");
    expect(html).toContain("meeting-notes");
    expect(html).toContain("没有脚本文件");
    expect(html).not.toContain("集合名");
    expect(html).not.toContain("gh-members");
  });

  test("单个和库里重名：写和谁重名，改名框写要填", () => {
    const html = renderPreview(preview({ ...FAKE_GITHUB_SINGLE, single: { ...FAKE_GITHUB_SINGLE.single!, sameName: "你导入的 habit-tracker" } }));
    expect(html).toContain("和你导入的 habit-tracker 重名，改个名才能装");
    expect(html).toContain("改名（和库里重名，要填一个新名字）");
  });

  test("集合：集合名、版本、来源、说明填好默认的；成员默认全选，不合规的选不了、写原因，重名的就地改名", () => {
    const html = renderPreview(preview(FAKE_GITHUB_SET));
    expect(html).toContain("demo-org/demo-toolbox@a71c0e5");
    expect(html).toContain("一整套（集合），找到 5 个 skill");
    expect(html).toContain('value="demo-toolbox"');
    expect(html).toContain('value="v1.4.0"');
    expect(html).toContain("要装的 skill：选了 4 个，一共 4 个能装");
    expect((html.match(/type="checkbox" checked=""/g) ?? []).length).toBe(4);
    expect(html).toMatch(/type="checkbox" disabled=""/);
    expect(html).toContain("装不了：SKILL.md 开头没有 frontmatter（---）");
    expect(html).toContain("和集合 demo-methods 里的 demo-tdd 重名，改个名才能装");
    expect(html).toContain('aria-label="给 demo-tdd 改名"');
    expect(html).toContain("链接不带：docs/latest");
    expect(html).toContain("依赖目录不带");
  });
});

test("列表上的来源一行：点得开网址；不是从 GitHub 装的不画", () => {
  const html = renderToStaticMarkup(createElement(SkillSourceLink, { origin: { url: "https://github.com/demo-org/demo-skills/tree/v1.0.0/engineering", repo: "demo-org/demo-skills", ref: "v1.0.0", commit: "5e8d2b0c71f4a96e3d0b8c2a5f7e1d4b9c6a3e82", installedAt: "x" } }));
  expect(html).toContain("来自 GitHub demo-org/demo-skills@5e8d2b0");
  expect(html).toContain('target="_blank"');
  expect(renderToStaticMarkup(createElement(SkillSourceLink, { origin: undefined }))).toBe("");
});
