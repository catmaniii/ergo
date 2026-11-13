// 原型：从 GitHub 装 skill（465）的假预览。地址里带 habit-tracker 的是单个 skill，带 demo-toolbox 的是一整套（一个成员和库里重名、
// 一个不合规），带 private 的回"找不到或私有"，不是 GitHub 地址的回"认不出"。全是编的，不连网。
import type { GithubSkillPreview } from "../state/index.ts";

/** 假提交号（编的） */
const FAKE_COMMIT_SINGLE = "3f2a9c1e7b6d4a0f8e2c5b9d1a7e3c6f0b8d2e4a";
const FAKE_COMMIT_SET = "a71c0e5d9b3f6284c1e7a0d5b9f3c6e2d8a4b170";

/** 单个 skill：仓库根上就是 skill */
export const FAKE_GITHUB_SINGLE: Omit<GithubSkillPreview, "previewId" | "expiresAt"> = {
  url: "https://github.com/demo-org/habit-tracker",
  repo: "demo-org/habit-tracker",
  commit: FAKE_COMMIT_SINGLE,
  subdir: "",
  kind: "single",
  single: { name: "habit-tracker", description: "记习惯、到点提醒打卡（假数据）", dirName: "habit-tracker" },
  fileCount: 6,
  totalBytes: 18_432,
  scripts: ["scripts/remind.ps1", "scripts/stats.py"],
  scriptCount: 2,
  dropped: [
    { path: ".env", reason: "sensitive" },
    { path: ".github/", reason: "hidden" },
  ],
};

/** 一整套：成员在 skills/ 下面两层，一个和库里重名、一个不合规 */
export const FAKE_GITHUB_SET: Omit<GithubSkillPreview, "previewId" | "expiresAt"> = {
  url: "https://github.com/demo-org/demo-toolbox/tree/v1.4.0",
  repo: "demo-org/demo-toolbox",
  ref: "v1.4.0",
  commit: FAKE_COMMIT_SET,
  subdir: "",
  kind: "collection",
  members: [
    { dir: "skills/broken", name: "broken", description: "", problem: "SKILL.md 开头没有 frontmatter（---）" },
    { dir: "skills/research/demo-cite", name: "demo-cite", description: "整理引用、生成参考文献（假数据）" },
    { dir: "skills/research/demo-tdd", name: "demo-tdd", description: "先写测试再写代码（假数据）", sameName: "集合 demo-methods 里的 demo-tdd" },
    { dir: "skills/writing/demo-outline", name: "demo-outline", description: "先列提纲再动笔（假数据）" },
    { dir: "skills/writing/demo-polish", name: "demo-polish", description: "把初稿润色干净（假数据）" },
  ],
  collection: { name: "demo-toolbox", source: "https://github.com/demo-org/demo-toolbox/tree/v1.4.0", version: "v1.4.0", description: "一套写作和查资料用的 skill（假数据）" },
  fileCount: 23,
  totalBytes: 96_870,
  scripts: ["skills/research/demo-cite/fetch.js"],
  scriptCount: 1,
  dropped: [
    { path: ".claude-plugin/", reason: "hidden" },
    { path: "docs/latest", reason: "link" },
    { path: "skills/research/demo-cite/node_modules/", reason: "dependency" },
  ],
};

/** 按地址给哪一份预览；回字符串的是出错的那句话 */
export function fakeGithubPreview(url: string): Omit<GithubSkillPreview, "previewId" | "expiresAt"> | string {
  const text = url.trim();
  if (/habit-tracker/i.test(text)) return FAKE_GITHUB_SINGLE;
  if (/demo-toolbox/i.test(text)) return FAKE_GITHUB_SET;
  const repo = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/.exec(text)?.[1];
  if (!repo || /^[a-z]+:\/\/(?!(?:www\.)?github\.com)/i.test(text)) return `认不出这个地址：${text}。要填 GitHub 上公开仓库的地址`;
  return `GitHub 上找不到 ${repo}：地址写错了，或者是私有仓库（现在只支持公开仓库）`;
}
