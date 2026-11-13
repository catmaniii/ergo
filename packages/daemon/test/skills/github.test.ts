// 从 GitHub 装 skill（465）：预览（下载、解开、看里面有什么）、安装（走 skill 库导入的同一段校验和写入）、放弃和清理。
// 下载一律是假的 transport，压缩包在测试里现做（带全局 pax 头的提交号、链接、../ 路径、.env、超大的），绝不连真网络；
// skill 库用临时目录里的真的一份。
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { RequestRejected } from "../../src/errors.ts";
import { createGithubSkills, firstParagraph, type GithubSkills } from "../../src/skills/github.ts";
import { COLLECTION_MANIFEST, createSkillLibrary, type SkillLibrary, SOURCE_FILE } from "../../src/skills/library.ts";
import { blob } from "../helpers/fake-downloads.ts";
import { fakeGithub, type FakeGithub, githubArchive, type RepoFile, skillMd } from "../helpers/fake-github.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { writeSkill } from "../helpers/toolkit.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const archive = (owner: string, repo: string, ref = "HEAD") => `https://github.com/${owner}/${repo}/archive/${ref}.tar.gz`;

interface Setup {
  gh: FakeGithub;
  library: SkillLibrary;
  github: GithubSkills;
  dataDir: string;
  userDir: string;
  stagedDir: string;
  logs: string[];
  clock: { at: number };
}

function setup(over: { limits?: Parameters<typeof createGithubSkills>[0]["limits"]; beforeStart?: (stagedDir: string) => void } = {}): Setup {
  const dataDir = makeTempDir("ergo-gh-");
  const userDir = path.join(dataDir, "skills");
  const stagedDir = path.join(dataDir, "tmp", "github-skills");
  over.beforeStart?.(stagedDir);
  const builtinDir = makeTempDir("ergo-gh-builtin-");
  writeSkill(path.join(builtinDir, "example-checklist"), "example-checklist", "框架自带的示例");
  const logs: string[] = [];
  const library = createSkillLibrary({ builtinDir, userDir, dataDir, stagedDir, now: () => "2026-11-14T10:00:00.000+08:00", log: (l) => logs.push(l) });
  const gh = fakeGithub();
  const clock = { at: Date.parse("2026-11-14T02:00:00Z") };
  const github = createGithubSkills({ library, dir: stagedDir, transport: gh.transport, now: () => clock.at, log: (l) => logs.push(l), ...(over.limits ? { limits: over.limits } : {}) });
  return { gh, library, github, dataDir, userDir, stagedDir, logs, clock };
}

/** 抛出的 RequestRejected 的 code 和话 */
async function rejection(p: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string }> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof RequestRejected) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("没有被拒");
}

const slots = (s: Setup) => (fs.existsSync(s.stagedDir) ? fs.readdirSync(s.stagedDir) : []);

/** 一个单个 skill 的仓库：根上就是 skill，带脚本、.env、链接、依赖目录、Windows 用不了的名字、只差大小写的重名 */
function singleRepo(): Record<string, RepoFile> {
  return {
    "SKILL.md": skillMd("habit-tracker", "记习惯的 skill"),
    "README.md": "# habit\n",
    "scripts/run.sh": "echo hi\n",
    "scripts/tool.py": "print(1)\n",
    "bin/helper": "#!/usr/bin/env node\nconsole.log(1)\n",
    ".env": "TOKEN=fake-not-real\n",
    "keys/server.pem": "fake\n",
    ".github/workflows/ci.yml": "on: push\n",
    "docs/link": { symlink: true },
    "node_modules/left-pad/index.js": "module.exports = 1\n",
    "bad:name.txt": "x\n",
    "Notes.md": "a\n",
    "notes.md": "b\n",
  };
}

describe("单个 skill", () => {
  test("预览：名字、说明、提交号、文件数和大小、脚本、会被丢掉的；安装：进库、记来源、临时目录清掉", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "habit-tracker"), { status: 200, body: githubArchive(`habit-tracker-${SHA}`, singleRepo(), SHA) });
    const preview = await s.github.preview("https://github.com/acme/habit-tracker");
    expect(preview).toMatchObject({
      kind: "single",
      url: "https://github.com/acme/habit-tracker",
      repo: "acme/habit-tracker",
      commit: SHA,
      subdir: "",
      single: { name: "habit-tracker", description: "记习惯的 skill", dirName: "habit-tracker" },
      scripts: ["bin/helper", "scripts/run.sh", "scripts/tool.py"],
      scriptCount: 3,
    });
    expect(preview.ref).toBeUndefined();
    expect(preview.single?.sameName).toBeUndefined();
    // 复制的：SKILL.md、README.md、两个脚本、helper、Notes.md（notes.md 只差大小写，丢掉）
    expect(preview.fileCount).toBe(6);
    expect(preview.dropped).toEqual([
      { path: ".env", reason: "sensitive" },
      { path: ".github/", reason: "hidden" },
      { path: "bad:name.txt", reason: "badName" },
      { path: "docs/link", reason: "link" },
      { path: "keys/server.pem", reason: "sensitive" },
      { path: "node_modules/", reason: "dependency" },
      { path: "notes.md", reason: "duplicate" },
    ]);
    expect(s.gh.requests).toEqual([archive("acme", "habit-tracker")]);
    expect(slots(s)).toEqual([preview.previewId]);

    const result = s.github.install({ previewId: preview.previewId });
    // 装完的报告里"没带进来"的：库不带的和解开时就丢掉的一起列
    expect(result.excluded).toEqual([".env", ".github/", "bad:name.txt", "docs/link", "keys/server.pem", "node_modules/", "notes.md"]);
    expect(result.skills).toEqual([
      { name: "habit-tracker", description: "记习惯的 skill", origin: "imported", github: { url: "https://github.com/acme/habit-tracker", repo: "acme/habit-tracker", commit: SHA, installedAt: "2026-11-14T02:00:00.000Z" } },
    ]);
    const dir = path.join(s.userDir, "habit-tracker");
    expect(fs.readdirSync(dir).toSorted()).toEqual([SOURCE_FILE, "Notes.md", "README.md", "SKILL.md", "bin", "keys", "scripts"].toSorted());
    expect(fs.readdirSync(path.join(dir, "keys"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, SOURCE_FILE), "utf8"))).toEqual({ format: 1, github: result.skills[0]!.github });
    // 库里认得出来源：列表、工具包、秘书的 skill 选择用的就是这一份
    expect(s.library.list().find((e) => e.name === "habit-tracker")?.github).toMatchObject({ repo: "acme/habit-tracker", commit: SHA });
    expect(s.library.pathsOf(["habit-tracker"])).toEqual([dir]);
    // 装完这一格清掉；再装同一个预览：过期了
    expect(slots(s)).toEqual([]);
    expect(await rejection(() => s.github.install({ previewId: preview.previewId }))).toMatchObject({ code: "not_found", message: expect.stringContaining("过期") });
  });

  test("指到子目录（tree/<ref>/<子目录>、blob/…/SKILL.md、简写）：只解那个子目录；来源里带的 .ergo-source.json 不复制", async () => {
    const s = setup();
    const files = {
      "README.md": "# 一堆 skill\n",
      "skills/tdd/SKILL.md": skillMd("tdd", "先写测试"),
      "skills/tdd/.ergo-source.json": '{"format":1,"github":{"url":"假的","repo":"x/y","installedAt":"x"}}',
      "skills/review/SKILL.md": skillMd("review", "评审"),
      "big/data.bin": blob(1024),
    };
    s.gh.reply(archive("acme", "pack", "main"), { status: 200, body: githubArchive(`pack-main`, files, SHA) });
    s.gh.reply(archive("acme", "pack"), { status: 200, body: githubArchive(`pack-${SHA2}`, files, SHA2) });
    const a = await s.github.preview("https://github.com/acme/pack/tree/main/skills/tdd");
    expect(a).toMatchObject({ kind: "single", ref: "main", subdir: "skills/tdd", url: "https://github.com/acme/pack/tree/main/skills/tdd", single: { name: "tdd", dirName: "tdd" }, fileCount: 1 });
    expect(a.dropped).toEqual([{ path: SOURCE_FILE, reason: "hidden" }]);
    const b = await s.github.preview("https://github.com/acme/pack/blob/main/skills/review/SKILL.md");
    expect(b).toMatchObject({ kind: "single", ref: "main", subdir: "skills/review", single: { name: "review" } });
    const c = await s.github.preview("acme/pack/skills/review");
    expect(c).toMatchObject({ kind: "single", subdir: "skills/review", commit: SHA2, url: "https://github.com/acme/pack/tree/HEAD/skills/review" });
    expect(c.ref).toBeUndefined();
    s.github.install({ previewId: a.previewId });
    expect(JSON.parse(fs.readFileSync(path.join(s.userDir, "tdd", SOURCE_FILE), "utf8")).github).toMatchObject({ repo: "acme/pack", ref: "main", url: "https://github.com/acme/pack/tree/main/skills/tdd" });
    expect(fs.readdirSync(path.join(s.userDir, "tdd")).toSorted()).toEqual([SOURCE_FILE, "SKILL.md"]);
  });

  test("和库里重名：预览里写和谁重名；不改名装被拒、预览留着，改名再装就行（只改目录名和 SKILL.md 的 name）", async () => {
    const s = setup();
    s.library.importFrom({ path: writeSkill(path.join(makeTempDir("ergo-src-"), "tdd"), "tdd", "本机的 tdd") });
    s.gh.reply(archive("acme", "tdd"), { status: 200, body: githubArchive(`tdd-${SHA}`, { "SKILL.md": skillMd("tdd", "GitHub 上的 tdd") }, SHA) });
    const preview = await s.github.preview("acme/tdd");
    expect(preview.single?.sameName).toContain("tdd");
    expect(await rejection(() => s.github.install({ previewId: preview.previewId }))).toMatchObject({ code: "conflict", message: expect.stringContaining("重名") });
    expect(slots(s)).toEqual([preview.previewId]);
    expect(await rejection(() => s.github.install({ previewId: preview.previewId, rename: "Bad Name" }))).toMatchObject({ code: "bad_params" });
    expect(s.github.install({ previewId: preview.previewId, rename: "gh-tdd" }).skills[0]).toMatchObject({ name: "gh-tdd", github: { repo: "acme/tdd" } });
    expect(fs.readFileSync(path.join(s.userDir, "gh-tdd", "SKILL.md"), "utf8")).toContain("name: gh-tdd");
    expect(slots(s)).toEqual([]);
  });
});

describe("地址下面只有一个能装的 SKILL.md、在子目录里：当单个装", () => {
  /** 仓库根上没有 SKILL.md，skills/meeting-notes 下有一个能装的，另一个不合规；外面有隐藏目录、链接 */
  const soloRepo = (): Record<string, RepoFile> => ({
    "README.md": "# 只有一个 skill 的仓库\n",
    ".github/workflows/ci.yml": "on: push\n",
    "docs/link": { symlink: true },
    "skills/meeting-notes/SKILL.md": skillMd("meeting-notes", "记会议纪要"),
    "skills/meeting-notes/templates/minutes.md": "# 纪要\n",
    "skills/meeting-notes/latest": { symlink: true },
    "skills/broken/SKILL.md": "没有 frontmatter\n",
  });

  test("仓库首页：预览是单个，在哪写那个子目录；装进来的只有那个子目录，来源记子目录、网址指到它", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "solo"), { status: 200, body: githubArchive(`solo-${SHA}`, soloRepo(), SHA) });
    const preview = await s.github.preview("https://github.com/acme/solo");
    expect(preview).toMatchObject({
      kind: "single",
      subdir: "skills/meeting-notes",
      url: "https://github.com/acme/solo/tree/HEAD/skills/meeting-notes",
      single: { name: "meeting-notes", description: "记会议纪要", dirName: "meeting-notes" },
      fileCount: 2,
    });
    expect(preview.members).toBeUndefined();
    expect(preview.collection).toBeUndefined();
    // 不带的只列它里面的（外面的 .github/、docs/link 本来就不装）
    expect(preview.dropped).toEqual([{ path: "latest", reason: "link" }]);
    // 当集合装被拒（它是单个）
    expect(await rejection(() => s.github.install({ previewId: preview.previewId, collection: { name: "solo", source: "s", version: "1", description: "d", members: ["skills/meeting-notes"] } }))).toMatchObject({ code: "bad_params" });

    const result = s.github.install({ previewId: preview.previewId });
    const github = { url: "https://github.com/acme/solo/tree/HEAD/skills/meeting-notes", repo: "acme/solo", path: "skills/meeting-notes", commit: SHA, installedAt: "2026-11-14T02:00:00.000Z" };
    expect(result).toMatchObject({ skills: [{ name: "meeting-notes", origin: "imported", github }], excluded: ["latest"] });
    expect(result.collection).toBeUndefined();
    const dir = path.join(s.userDir, "meeting-notes");
    expect(fs.readdirSync(dir).toSorted()).toEqual([SOURCE_FILE, "SKILL.md", "templates"]);
    expect(fs.readFileSync(path.join(dir, "templates", "minutes.md"), "utf8")).toBe("# 纪要\n");
    expect(JSON.parse(fs.readFileSync(path.join(dir, SOURCE_FILE), "utf8"))).toEqual({ format: 1, github });
    expect(s.library.list().find((e) => e.name === "meeting-notes")?.github).toEqual(github);
    expect(s.library.collections()).toEqual([]);
    expect(slots(s)).toEqual([]);
  });

  test("指了 ref、子目录的：子目录接在后面，网址带 ref", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "mono", "v2.1.0"), { status: 200, body: githubArchive("mono-2.1.0", { "tools/readme.md": "x", "tools/skills/solo/SKILL.md": skillMd("solo", "唯一一个") }, SHA) });
    const preview = await s.github.preview("https://github.com/acme/mono/tree/v2.1.0/tools");
    expect(preview).toMatchObject({ kind: "single", ref: "v2.1.0", subdir: "tools/skills/solo", url: "https://github.com/acme/mono/tree/v2.1.0/tools/skills/solo", single: { name: "solo" } });
    expect(s.github.install({ previewId: preview.previewId }).skills[0]?.github).toMatchObject({ path: "tools/skills/solo", ref: "v2.1.0", url: "https://github.com/acme/mono/tree/v2.1.0/tools/skills/solo" });
  });
});

describe("成员在隐藏目录里（.claude/skills/foo）", () => {
  /** foo 在 .claude/skills 下（带脚本、参考资料、它自己的隐藏目录）；.claude 里还有别的程序的配置；外面有 .github/ */
  const hiddenRepo = (withBar: boolean): Record<string, RepoFile> => ({
    "README.md": "# repo\n",
    ".github/workflows/ci.yml": "on: push\n",
    ".claude/settings.json": "{}\n",
    ".claude/commands/deploy.md": "部署\n",
    ".claude/hooks/pre.sh": "echo hook\n",
    ".claude/.cache/x.json": "{}\n",
    ".claude/skills/foo/SKILL.md": skillMd("foo", "藏在 .claude 下的"),
    ".claude/skills/foo/scripts/run.sh": "echo run\n",
    ".claude/skills/foo/references/guide.md": "指南\n",
    ".claude/skills/foo/.cache/tmp.json": "{}\n",
    ...(withBar ? { "skills/bar/SKILL.md": skillMd("bar", "放在 skills 下的") } : {}),
  });
  const FOO_FILES = ["SKILL.md", "references/guide.md", "scripts/run.sh"];
  /** 一个目录下面的全部文件（相对、/ 分隔、排好） */
  const filesUnder = (dir: string): string[] =>
    fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
      .map((rel) => rel.split(path.sep).join("/"))
      .toSorted();

  test("单个装（仓库首页里只有它、地址直接指到它）：成员目录完整装进来，它里面和外面的隐藏目录都不带", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "hidden"), { status: 200, body: githubArchive(`hidden-${SHA}`, hiddenRepo(false), SHA) });
    const a = await s.github.preview("acme/hidden");
    expect(a).toMatchObject({ kind: "single", subdir: ".claude/skills/foo", single: { name: "foo", dirName: "foo" }, fileCount: 3 });
    expect(a.dropped).toEqual([{ path: ".cache/", reason: "hidden" }]);
    s.github.install({ previewId: a.previewId });
    expect(filesUnder(path.join(s.userDir, "foo"))).toEqual([SOURCE_FILE, ...FOO_FILES].toSorted());

    const b = await s.github.preview("acme/hidden/.claude/skills/foo");
    expect(b).toMatchObject({ kind: "single", subdir: ".claude/skills/foo", url: "https://github.com/acme/hidden/tree/HEAD/.claude/skills/foo" });
    s.github.install({ previewId: b.previewId, rename: "foo-two" });
    expect(filesUnder(path.join(s.userDir, "foo-two"))).toEqual([SOURCE_FILE, ...FOO_FILES].toSorted());
  });

  test("集合装：.claude 里只带通到成员的那条路和成员本身；.github/、.claude 里别的程序的配置、成员里的隐藏目录都不带", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "hidden"), { status: 200, body: githubArchive(`hidden-${SHA}`, hiddenRepo(true), SHA) });
    const preview = await s.github.preview("acme/hidden");
    expect(preview.kind).toBe("collection");
    expect(preview.members?.map((m) => m.dir)).toEqual([".claude/skills/foo", "skills/bar"]);
    expect(preview.dropped).toEqual([
      { path: ".claude/.cache/", reason: "hidden" },
      { path: ".claude/commands/", reason: "hidden" },
      { path: ".claude/hooks/", reason: "hidden" },
      { path: ".claude/settings.json", reason: "hidden" },
      { path: ".claude/skills/foo/.cache/", reason: "hidden" },
      { path: ".github/", reason: "hidden" },
    ]);
    expect(preview.fileCount).toBe(5);
    const result = s.github.install({ previewId: preview.previewId, collection: { ...preview.collection!, members: [".claude/skills/foo", "skills/bar"] } });
    expect(result.collection?.skills).toEqual(["bar", "foo"]);
    const root = path.join(s.userDir, "hidden");
    expect(filesUnder(root)).toEqual([COLLECTION_MANIFEST, "README.md", ...FOO_FILES.map((f) => `.claude/skills/foo/${f}`), "skills/bar/SKILL.md"].toSorted());
    expect(s.library.pathsOf(["foo"])).toEqual([path.join(root, ".claude", "skills", "foo")]);
  });
});

/** 一个集合的仓库：成员在不同的层（skills/ 下、.claude/skills 下），一个不合规的，插件清单里有说明 */
function collectionRepo(): Record<string, RepoFile> {
  return {
    "README.md": "# Fake Pack\n\n[![badge](x.svg)](y)\n\n一套假的 **开发** 方法论，\n给测试用。\n\n第二段。\n",
    ".claude-plugin/plugin.json": JSON.stringify({ name: "fake-pack", description: "插件清单里的说明" }),
    "docs/guide.md": "指南\n",
    "skills/engineering/alpha/SKILL.md": skillMd("alpha", "第一个"),
    "skills/engineering/alpha/run.ps1": "Write-Host hi\n",
    "skills/engineering/beta/SKILL.md": skillMd("beta", "第二个"),
    "skills/productivity/gamma/SKILL.md": skillMd("gamma", "第三个"),
    "skills/broken/SKILL.md": "没有 frontmatter\n",
    ".claude/skills/delta/SKILL.md": skillMd("delta", "放在 .claude 下的"),
  };
}

describe("集合", () => {
  test("预览：下面几层里的成员（名字、说明、目录；不合规的写原因）、默认集合名、来源、版本、说明；取消一个再装：没选的不复制、记来源", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "Fake_Pack"), { status: 200, body: githubArchive(`Fake_Pack-${SHA}`, collectionRepo(), SHA) });
    const preview = await s.github.preview("https://github.com/acme/Fake_Pack");
    expect(preview).toMatchObject({
      kind: "collection",
      collection: { name: "fake-pack", source: "https://github.com/acme/Fake_Pack", version: SHA.slice(0, 7), description: "插件清单里的说明" },
      scripts: ["skills/engineering/alpha/run.ps1"],
    });
    expect(preview.collection?.nameTaken).toBeUndefined();
    expect(preview.members).toEqual([
      { dir: ".claude/skills/delta", name: "delta", description: "放在 .claude 下的" },
      { dir: "skills/broken", name: "broken", description: "", problem: expect.any(String) },
      { dir: "skills/engineering/alpha", name: "alpha", description: "第一个" },
      { dir: "skills/engineering/beta", name: "beta", description: "第二个" },
      { dir: "skills/productivity/gamma", name: "gamma", description: "第三个" },
    ]);
    // .claude-plugin/ 是隐藏目录，不带；.claude/ 在成员的路上，带
    expect(preview.dropped).toEqual([{ path: ".claude-plugin/", reason: "hidden" }]);

    const result = s.github.install({
      previewId: preview.previewId,
      collection: { ...preview.collection!, name: "fake-pack", members: ["skills/engineering/alpha", ".claude/skills/delta", "skills/productivity/gamma"] },
    });
    expect(result.collection).toEqual({
      name: "fake-pack",
      source: "https://github.com/acme/Fake_Pack",
      version: SHA.slice(0, 7),
      description: "插件清单里的说明",
      skills: ["alpha", "delta", "gamma"],
      github: { url: "https://github.com/acme/Fake_Pack", repo: "acme/Fake_Pack", commit: SHA, installedAt: "2026-11-14T02:00:00.000Z" },
    });
    const root = path.join(s.userDir, "fake-pack");
    expect(fs.existsSync(path.join(root, "skills", "engineering", "beta"))).toBe(false);
    expect(fs.existsSync(path.join(root, "skills", "broken"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "docs", "guide.md"), "utf8")).toBe("指南\n");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, COLLECTION_MANIFEST), "utf8"));
    expect(manifest).toMatchObject({ members: [".claude/skills/delta", "skills/engineering/alpha", "skills/productivity/gamma"], importedFrom: "https://github.com/acme/Fake_Pack", github: { commit: SHA } });
    expect(s.library.collections()).toEqual([result.collection]);
    expect(s.library.list().filter((e) => e.collection === "fake-pack").map((e) => e.name)).toEqual(["alpha", "delta", "gamma"]);
    expect(slots(s)).toEqual([]);
  });

  test("标签当版本；说明取不到插件清单时取 README 的第一段", async () => {
    const s = setup();
    const files = collectionRepo();
    delete files[".claude-plugin/plugin.json"];
    s.gh.reply(archive("acme", "pack", "v1.2.0"), { status: 200, body: githubArchive("pack-1.2.0", files, SHA) });
    const preview = await s.github.preview("https://github.com/acme/pack/tree/v1.2.0");
    expect(preview.collection).toMatchObject({ name: "pack", version: "v1.2.0", description: "一套假的 开发 方法论， 给测试用。" });
  });

  test("成员和库里重名、集合名被占：预览里标出来；装的时候给成员改名就行；选了预览里没有的目录被拒", async () => {
    const s = setup();
    s.library.importFrom({ path: writeSkill(path.join(makeTempDir("ergo-src-"), "alpha"), "alpha", "本机的 alpha") });
    s.library.importFrom({ path: writeSkill(path.join(makeTempDir("ergo-src-"), "pack"), "pack", "叫 pack 的单个 skill") });
    s.gh.reply(archive("acme", "pack"), { status: 200, body: githubArchive(`pack-${SHA}`, collectionRepo(), SHA) });
    const preview = await s.github.preview("acme/pack");
    expect(preview.collection?.nameTaken).toContain("pack");
    expect(preview.members?.find((m) => m.name === "alpha")?.sameName).toContain("alpha");
    const spec = { name: "pack", source: "s", version: "1", description: "d", members: ["skills/engineering/alpha", "skills/engineering/beta"] };
    expect(await rejection(() => s.github.install({ previewId: preview.previewId, collection: spec }))).toMatchObject({ code: "conflict" });
    expect(await rejection(() => s.github.install({ previewId: preview.previewId, collection: { ...spec, name: "gh-pack" } }))).toMatchObject({ code: "conflict", message: expect.stringContaining("alpha") });
    expect(await rejection(() => s.github.install({ previewId: preview.previewId, collection: { ...spec, name: "gh-pack", members: ["skills/engineering/alpha", "docs"] } }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("docs") });
    // 单个的写法装集合：被拒
    expect(await rejection(() => s.github.install({ previewId: preview.previewId }))).toMatchObject({ code: "bad_params" });
    const result = s.github.install({ previewId: preview.previewId, collection: { ...spec, name: "gh-pack", rename: { alpha: "gh-alpha" } } });
    expect(result.collection?.skills).toEqual(["beta", "gh-alpha"]);
    expect(fs.readFileSync(path.join(s.userDir, "gh-pack", "skills", "engineering", "gh-alpha", "SKILL.md"), "utf8")).toContain("name: gh-alpha");
  });

  test("集合里两个成员同名：后一个标出来", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "twins"), { status: 200, body: githubArchive(`twins-${SHA}`, { "a/tdd/SKILL.md": skillMd("tdd", "一"), "b/tdd/SKILL.md": skillMd("tdd", "二") }, SHA) });
    const preview = await s.github.preview("acme/twins");
    expect(preview.members?.map((m) => m.sameName === undefined)).toEqual([true, false]);
  });
});

describe("找不到、下不下来、太大", () => {
  test("地址认不出：一句人话，不发请求", async () => {
    const s = setup();
    expect(await rejection(s.github.preview("https://gitlab.com/acme/x"))).toMatchObject({ code: "bad_params", message: expect.stringContaining("认不出这个地址") });
    expect(await rejection(s.github.preview("https://u:p@github.com/acme/x"))).toMatchObject({ code: "bad_params" });
    expect(s.gh.requests).toEqual([]);
  });

  test("404（仓库不存在或私有）、403 和 429（限流）、500、连不上、中途断了：各一句人话，临时目录都清掉", async () => {
    const s = setup();
    expect(await rejection(s.github.preview("acme/missing"))).toMatchObject({ code: "not_found", message: expect.stringContaining("私有仓库") });
    s.gh.reply(archive("acme", "busy"), { status: 403 });
    expect(await rejection(s.github.preview("acme/busy"))).toMatchObject({ code: "rate_limited", message: expect.stringContaining("限流") });
    s.gh.reply(archive("acme", "busy"), { status: 429 });
    expect(await rejection(s.github.preview("acme/busy"))).toMatchObject({ code: "rate_limited" });
    s.gh.reply(archive("acme", "broken"), { status: 500 });
    expect(await rejection(s.github.preview("acme/broken"))).toMatchObject({ message: expect.stringContaining("HTTP 500") });
    s.gh.reply(archive("acme", "offline"), { error: "getaddrinfo ENOTFOUND github.com" });
    expect(await rejection(s.github.preview("acme/offline"))).toMatchObject({ message: expect.stringMatching(/连不上 GitHub.*ENOTFOUND/) });
    s.gh.reply(archive("acme", "cut"), { cut: Buffer.from("partial") });
    expect(await rejection(s.github.preview("acme/cut"))).toMatchObject({ message: expect.stringContaining("连不上 GitHub") });
    s.gh.reply(archive("acme", "notgz"), { status: 200, body: "<html>不是压缩包</html>" });
    expect(await rejection(s.github.preview("acme/notgz"))).toMatchObject({ code: "bad_params", message: expect.stringContaining("压缩包") });
    expect(slots(s)).toEqual([]);
  });

  test("超时：整个下载过了上限还没下完就放弃", async () => {
    const s = setup({ limits: { timeoutMs: 50 } });
    s.gh.reply(archive("acme", "slow"), { hang: true });
    expect(await rejection(s.github.preview("acme/slow"))).toMatchObject({ message: expect.stringContaining("秒还没下完") });
    expect(slots(s)).toEqual([]);
  });

  test("没有 SKILL.md、没有那个子目录", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "docs"), { status: 200, body: githubArchive(`docs-${SHA}`, { "README.md": "# x\n", "a/b/c.md": "c" }, SHA) });
    expect(await rejection(s.github.preview("acme/docs"))).toMatchObject({ code: "bad_params", message: "这个地址下面没有找到 SKILL.md" });
    expect(await rejection(s.github.preview("acme/docs/nope"))).toMatchObject({ code: "not_found", message: expect.stringContaining("没有 nope 这个目录") });
    expect(slots(s)).toEqual([]);
  });

  test("ref 里带 / 的分支：先试第一段（404），再把下一段并进 ref", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "pack", "feature/x"), { status: 200, body: githubArchive("pack-feature-x", { "skills/tdd/SKILL.md": skillMd("tdd", "先写测试") }, SHA) });
    const preview = await s.github.preview("https://github.com/acme/pack/tree/feature/x/skills/tdd");
    expect(preview).toMatchObject({ kind: "single", ref: "feature/x", subdir: "skills/tdd", url: "https://github.com/acme/pack/tree/feature/x/skills/tdd" });
    expect(s.gh.requests).toEqual([archive("acme", "pack", "feature"), archive("acme", "pack", "feature/x")]);
  });

  test("下第一段的 ref 下到了、可是没有那个子目录：接着试把下一段并进 ref；都不行说没有那个目录", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "pack", "feature"), { status: 200, body: githubArchive("pack-feature", { "other/SKILL.md": skillMd("o", "o") }, SHA) });
    expect(await rejection(s.github.preview("https://github.com/acme/pack/tree/feature/x"))).toMatchObject({ code: "not_found", message: expect.stringContaining("没有 x 这个目录") });
    expect(s.gh.requests).toEqual([archive("acme", "pack", "feature"), archive("acme", "pack", "feature/x")]);
    expect(slots(s)).toEqual([]);
  });

  test("压缩包超过下载上限（写了长度的当场拒，没写长度的边收边数）、解开超过大小或文件数上限：不装", async () => {
    const s = setup({ limits: { downloadBytes: 4096, extractFiles: 3, extractBytes: 10_000 } });
    const big = githubArchive(`big-${SHA}`, { "SKILL.md": skillMd("big", "大"), "data.bin": randomBytes(20_000) }, SHA);
    expect(big.length).toBeGreaterThan(4096);
    s.gh.reply(archive("acme", "big"), { status: 200, body: big });
    expect(await rejection(s.github.preview("acme/big"))).toMatchObject({ message: expect.stringContaining("超过 0 MB") });
    s.gh.reply(archive("acme", "big"), { status: 200, body: big, headers: {} });
    expect(await rejection(s.github.preview("acme/big"))).toMatchObject({ message: expect.stringContaining("太大") });
    expect(s.gh.requests.length).toBe(2);

    const many = githubArchive(`many-${SHA}`, { "SKILL.md": skillMd("many", "多"), "a.md": "a", "b.md": "b", "c.md": "c" }, SHA);
    s.gh.reply(archive("acme", "many"), { status: 200, body: many });
    expect(await rejection(s.github.preview("acme/many"))).toMatchObject({ code: "bad_params", message: expect.stringContaining("3 个文件") });
    const heavy = githubArchive(`heavy-${SHA}`, { "SKILL.md": skillMd("heavy", "重"), "zeros.bin": Buffer.alloc(12_000) }, SHA);
    expect(heavy.length).toBeLessThan(4096);
    s.gh.reply(archive("acme", "heavy"), { status: 200, body: heavy });
    expect(await rejection(s.github.preview("acme/heavy"))).toMatchObject({ code: "bad_params", message: expect.stringContaining("太大") });
    expect(slots(s)).toEqual([]);
  });

  test("压缩包里有往外跳的路径（../）：整个不装，外面什么都没写", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "evil"), { status: 200, body: githubArchive(`evil-${SHA}`, { "SKILL.md": skillMd("evil", "坏"), "../../escape.txt": "坏" }, SHA) });
    expect(await rejection(s.github.preview("acme/evil"))).toMatchObject({ code: "not_allowed", message: expect.stringContaining("不安全的路径") });
    expect(fs.existsSync(path.join(s.stagedDir, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(s.stagedDir), "escape.txt"))).toBe(false);
    expect(slots(s)).toEqual([]);
  });

  test("压缩包没记提交号：版本用 ref，不调 GitHub API", async () => {
    const s = setup();
    s.gh.reply(archive("acme", "pack", "main"), { status: 200, body: githubArchive("pack-main", { "a/SKILL.md": skillMd("a", "a"), "b/SKILL.md": skillMd("b", "b") }) });
    const preview = await s.github.preview("https://github.com/acme/pack/tree/main");
    expect(preview.commit).toBeUndefined();
    expect(preview.collection?.version).toBe("main");
    expect(s.gh.requests).toEqual([archive("acme", "pack", "main")]);
  });
});

/** 放一个只有 SKILL.md 的仓库 */
const one = (s: Setup, repo: string) => s.gh.reply(archive("acme", repo), { status: 200, body: githubArchive(`${repo}-${SHA}`, { "SKILL.md": skillMd(repo, repo) }, SHA) });

describe("临时目录清理", () => {
  test("放弃马上清；放太久的、多出上限的最老的清掉；只清自己那一格", async () => {
    const s = setup({ limits: { maxPreviews: 2, ttlMs: 60_000 } });
    for (const r of ["one", "two", "three"]) one(s, r);
    const a = await s.github.preview("acme/one");
    expect(s.github.discard(a.previewId)).toBe(true);
    expect(s.github.discard(a.previewId)).toBe(false);
    expect(slots(s)).toEqual([]);

    // 旁边别人的东西不碰
    const neighbour = path.join(path.dirname(s.stagedDir), "keep.txt");
    fs.writeFileSync(neighbour, "别动");
    const b = await s.github.preview("acme/one");
    s.clock.at += 1000;
    const c = await s.github.preview("acme/two");
    s.clock.at += 1000;
    const d = await s.github.preview("acme/three");
    expect(slots(s).toSorted()).toEqual([c.previewId, d.previewId].toSorted());
    expect(await rejection(() => s.github.install({ previewId: b.previewId }))).toMatchObject({ code: "not_found" });

    s.clock.at += 60_000;
    s.github.sweep();
    expect(slots(s)).toEqual([]);
    expect(fs.readFileSync(neighbour, "utf8")).toBe("别动");
    expect(s.logs.some((l) => l.includes("放太久没装"))).toBe(true);
  });

  test("守护进程上次留下的：起来时清掉", async () => {
    const s = setup({
      beforeStart: (dir) => {
        fs.mkdirSync(path.join(dir, "leftover", "src"), { recursive: true });
        fs.writeFileSync(path.join(dir, "leftover", "src", "x.md"), "x");
      },
    });
    expect(slots(s)).toEqual([]);
  });

  test("skill 库只从临时区里装：别处的目录被拒", () => {
    const s = setup();
    const outside = writeSkill(path.join(makeTempDir("ergo-src-"), "x"), "x", "x");
    expect(() => s.library.installStaged({ root: outside, github: { url: "u", repo: "a/b", installedAt: "t" } })).toThrow(/不是从 GitHub 下下来的临时目录/);
  });
});

test("README 的第一段：跳过标题、徽章、图片、HTML、代码块", () => {
  expect(firstParagraph("# 标题\n\n<p align=center><img src=x></p>\n[![b](x)](y)\n\n这是 [说明](http://x) 的 *第一段*\n还有一行\n\n第二段\n")).toBe("这是 说明 的 第一段 还有一行");
  expect(firstParagraph("```\ncode\n```\n")).toBe("");
});
