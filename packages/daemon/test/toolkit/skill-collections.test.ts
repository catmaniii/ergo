// skill 库的集合、导入并改名、依赖目录、秘书用的 skill（72 号票）的单元测试。都用自己造的假 skill、假集合，不碰真的第三方 skill。
// - 带依赖目录（假 node_modules）的 skill：依赖目录不复制、建目录联接指回来源，大小上限不算它；.git 不复制；
// - 不跟任何链接：node_modules 本身是联接、复制的部分里有联接、依赖目录里有指向来源之外的联接、来源目录本身是联接，
//   指向密钥区、数据目录、来源之外的都拒绝；.git 和别的隐藏目录、.env*、*.pem、*.key 不带；
// - 导入并改名：只改目录名和 SKILL.md 里的 name，别的一个字不动；名字照 SKILL.md 原样（"Fancy Mode" 也认），不改；
// - 把一个目录作为集合整套导入：记下集合名、来源、版本、说明；成员是库里独立的 skill 名；根目录整个带上（成员用 ../../ 引用的文件照样在）；
//   不合规的成员跳过并写明原因；重名的整套拒绝、说清和谁重名，可以导入并改名；
// - 名字展开：集合名换成全部成员；
// - 秘书用的 skill：没有设置文件按默认的（库里还没有的悄悄跳过），只能选库里有的，改了通知。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLLECTION_MANIFEST, createSkillLibrary, IMPORT_MAX_BYTES, withSkillName } from "../../src/skills/library.ts";
import { createSecretarySkills, skillPromptSize } from "../../src/skills/secretary-skills.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { writeSkill } from "../helpers/toolkit.ts";

function library() {
  const builtinDir = makeTempDir("ergo-builtin-skills-");
  const dataDir = makeTempDir("ergo-data-");
  const userDir = path.join(dataDir, "skills");
  writeSkill(path.join(builtinDir, "example-checklist"), "example-checklist", "框架自带的示例");
  const logs: string[] = [];
  const lib = createSkillLibrary({ builtinDir, userDir, dataDir, now: () => "2026-10-10T12:00:00.000+08:00", log: (l) => logs.push(l) });
  return { lib, dataDir, userDir, logs };
}

function rejection(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
  throw new Error("该拒绝的没拒绝");
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * 假的集合（照 pstack 插件的样子）：根目录有 README、docs、agents，成员在 skills/ 下面；
 * alpha 引用 ../../docs/guide.md 和兄弟 skill ../beta/SKILL.md；broken 没有 description（不合规）
 */
function fakePlugin(root: string): string {
  write(path.join(root, "README.md"), "# 假插件\n");
  write(path.join(root, "docs", "guide", "01-setup.md"), "MARKER_PLUGIN_GUIDE\n");
  write(path.join(root, "agents", "helper-agent.md"), "假的子 agent\n");
  write(path.join(root, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 第一个\ndisable-model-invocation: true\n---\n\n见 [指南](../../docs/guide/01-setup.md) 和 [beta](../beta/SKILL.md)。\n");
  writeSkill(path.join(root, "skills", "beta"), "beta", "第二个");
  write(path.join(root, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: 假插件的 tdd\n---\n\n假插件的测试驱动。\n");
  write(path.join(root, "skills", "tdd", "references", "loop.md"), "循环\n");
  write(path.join(root, "skills", "broken", "SKILL.md"), "---\nname: broken\n---\n\n没有说明。\n");
  return root;
}

/** 假的另一套（照 matt-pocock 的 engineering 的样子）：成员直接在根目录下，其中也有一个 tdd（CRLF 换行） */
function fakeEngineering(root: string): string {
  write(path.join(root, "README.md"), "- [tdd](./tdd/SKILL.md)\n");
  write(path.join(root, "tdd", "SKILL.md"), "---\r\nname: tdd\r\ndescription: Test-driven development.\r\n---\r\n\r\n# Test-Driven Development\r\n\r\nname: 正文里的这一行不改\r\n");
  write(path.join(root, "tdd", "agents", "openai.yaml"), "policy: {}\n");
  writeSkill(path.join(root, "implement"), "implement", "照规格实现");
  writeSkill(path.join(root, "code-review"), "code-review", "评审");
  return root;
}

describe("导入带依赖目录的 skill（72 号票）", () => {
  it("node_modules 不复制，在原位置建目录联接指回来源（脚本照样找得到依赖），大小上限不算它；.git 不复制；报告写明按原路径引用", () => {
    const { lib, userDir } = library();
    const source = writeSkill(path.join(makeTempDir("ergo-src-"), "fake-browser"), "fake-browser", "带依赖的假 skill");
    write(path.join(source, "scripts", "run.mjs"), "import dep from 'fake-dep';\n");
    write(path.join(source, "node_modules", "fake-dep", "index.js"), "module.exports = 'MARKER_FAKE_DEP';\n");
    write(path.join(source, "node_modules", "fake-dep", "package.json"), '{"name":"fake-dep","main":"index.js"}\n');
    // 依赖目录比复制的上限还大：不算在里面
    fs.writeFileSync(path.join(source, "node_modules", "big.bin"), "");
    fs.truncateSync(path.join(source, "node_modules", "big.bin"), IMPORT_MAX_BYTES + 1024);
    write(path.join(source, ".git", "HEAD"), "ref: refs/heads/main\n");

    const result = lib.importFrom({ path: source });
    const target = path.join(userDir, "fake-browser");
    const realDeps = fs.realpathSync.native(path.join(source, "node_modules"));
    expect(result.skills).toEqual([{ name: "fake-browser", description: "带依赖的假 skill", origin: "imported" }]);
    expect(result.linked).toEqual([{ dir: "fake-browser/node_modules", target: realDeps }]);
    expect(result.report).toEqual([{ name: "fake-browser", dir: ".", ok: true, note: `依赖目录 node_modules 没复制，按原路径引用：${realDeps}` }]);
    expect(result.excluded).toEqual([".git/"]);
    // 复制的部分在，依赖目录是链接、指回来源
    expect(fs.readFileSync(path.join(target, "scripts", "run.mjs"), "utf8")).toContain("fake-dep");
    expect(fs.lstatSync(path.join(target, "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync.native(path.join(target, "node_modules"))).toBe(realDeps);
    expect(fs.readFileSync(path.join(target, "node_modules", "fake-dep", "index.js"), "utf8")).toContain("MARKER_FAKE_DEP");
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
    expect(lib.pathsOf(["fake-browser"])).toEqual([target]);

    // 删掉库里的这一份只删链接本身，来源里的依赖原样在
    fs.rmSync(target, { recursive: true, force: true });
    expect(fs.existsSync(path.join(source, "node_modules", "fake-dep", "index.js"))).toBe(true);
  });

  it("依赖目录里指向来源里面的链接（工作区链接）放过；依赖目录整个按原路径引用", () => {
    const { lib, userDir } = library();
    const source = writeSkill(path.join(makeTempDir("ergo-src-"), "with-workspace"), "with-workspace", "带工作区链接的");
    write(path.join(source, "packages", "local-dep", "index.js"), "MARKER_LOCAL_DEP\n");
    fs.mkdirSync(path.join(source, "node_modules"));
    fs.symlinkSync(path.join(source, "packages", "local-dep"), path.join(source, "node_modules", "local-dep"), "junction");
    lib.importFrom({ path: source });
    expect(fs.readFileSync(path.join(userDir, "with-workspace", "node_modules", "local-dep", "index.js"), "utf8")).toContain("MARKER_LOCAL_DEP");
  });

  it("复制的部分超过上限照旧拒绝（说明上限不算依赖目录）", () => {
    const { lib } = library();
    const source = writeSkill(path.join(makeTempDir("ergo-src-"), "too-big"), "too-big", "太大的");
    fs.writeFileSync(path.join(source, "data.bin"), "");
    fs.truncateSync(path.join(source, "data.bin"), IMPORT_MAX_BYTES + 1024);
    expect(rejection(() => lib.importFrom({ path: source }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("不算依赖目录") });
  });
});

/** 三种去处：数据目录的密钥区、数据目录本身、来源目录之外的别处 */
function targets(dataDir: string): { label: string; dir: string }[] {
  const secrets = path.join(dataDir, "secrets");
  write(path.join(secrets, "deepseek.key.txt"), "MARKER_SECRET\n");
  const elsewhere = makeTempDir("ergo-elsewhere-");
  write(path.join(elsewhere, "private.md"), "外面的\n");
  return [
    { label: "密钥区", dir: secrets },
    { label: "数据目录", dir: dataDir },
    { label: "来源之外", dir: elsewhere },
  ];
}

describe("导入不跟任何链接（评审阻塞项：指向密钥区的联接被原样带进 skill 区）", () => {
  it("node_modules 本身是指向密钥区、数据目录、来源之外的联接：都拒绝，skill 区里什么都没留下", () => {
    const { lib, dataDir, userDir } = library();
    for (const t of targets(dataDir)) {
      const source = writeSkill(path.join(makeTempDir("ergo-src-"), "evil-deps"), "evil-deps", t.label);
      fs.symlinkSync(t.dir, path.join(source, "node_modules"), "junction");
      expect({ to: t.label, ...rejection(() => lib.importFrom({ path: source })) }).toMatchObject({ to: t.label, code: "not_allowed", message: expect.stringContaining("node_modules →") });
    }
    expect(fs.existsSync(userDir) ? fs.readdirSync(userDir) : []).toEqual([]);
    expect(lib.missing(["evil-deps"])).toEqual(["evil-deps"]);
  });

  it("复制的部分里有联接（单个 skill 里的、集合根目录下的）：不论指向哪都拒绝；依赖目录里指向来源之外的也拒绝", () => {
    const { lib, dataDir, userDir } = library();
    for (const t of targets(dataDir)) {
      const single = writeSkill(path.join(makeTempDir("ergo-src-"), "evil-refs"), "evil-refs", t.label);
      fs.symlinkSync(t.dir, path.join(single, "refs"), "junction");
      expect({ to: t.label, ...rejection(() => lib.importFrom({ path: single })) }).toMatchObject({ to: t.label, code: "not_allowed", message: expect.stringContaining("refs →") });

      const root = fakePlugin(makeTempDir("ergo-src-"));
      fs.symlinkSync(t.dir, path.join(root, "docs", "linked"), "junction");
      expect({ to: t.label, ...rejection(() => lib.importFrom({ path: root, collection: { name: "evil-set", source: "假的", version: "1", description: "假的", skillsDir: "skills" } })) }).toMatchObject({
        to: t.label,
        code: "not_allowed",
        message: expect.stringContaining("docs/linked →"),
      });

      const nested = writeSkill(path.join(makeTempDir("ergo-src-"), "evil-nested"), "evil-nested", t.label);
      write(path.join(nested, "node_modules", "ok-dep", "index.js"), "x\n");
      fs.symlinkSync(t.dir, path.join(nested, "node_modules", "sneaky"), "junction");
      expect({ to: t.label, ...rejection(() => lib.importFrom({ path: nested })) }).toMatchObject({ to: t.label, code: "not_allowed", message: expect.stringContaining("node_modules/sneaky →") });
    }
    expect(fs.existsSync(userDir) ? fs.readdirSync(userDir) : []).toEqual([]);
  });

  it("来源目录本身是联接的也拒绝", () => {
    const { lib } = library();
    const real = writeSkill(path.join(makeTempDir("ergo-src-"), "real-skill"), "real-skill", "真的");
    const link = path.join(makeTempDir("ergo-src-"), "link-to-skill");
    fs.symlinkSync(real, link, "junction");
    expect(rejection(() => lib.importFrom({ path: link }))).toMatchObject({ code: "not_allowed", message: expect.stringContaining("本身是符号链接或目录联接") });
  });
});

describe("不带进来的东西", () => {
  it(".git 和别的隐藏目录、.env*、*.pem、*.key（任何一层）不带，报告里列出来；.gitignore 这类普通隐藏文件照带", () => {
    const { lib, userDir } = library();
    const root = fakePlugin(makeTempDir("ergo-src-"));
    write(path.join(root, ".env"), "TOKEN=x\n");
    write(path.join(root, ".env.local"), "TOKEN=y\n");
    write(path.join(root, ".git", "HEAD"), "ref\n");
    write(path.join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    write(path.join(root, "certs", "server.pem"), "-----BEGIN-----\n");
    write(path.join(root, "skills", "alpha", "id.key"), "key\n");
    write(path.join(root, "skills", "beta", ".cache", "x.json"), "{}\n");
    write(path.join(root, ".gitignore"), "node_modules\n");
    const result = lib.importFrom({ path: root, collection: { name: "fake-pstack", source: "假的", version: "1", description: "假的", skillsDir: "skills" } });
    expect(result.excluded).toEqual([".env", ".env.local", ".git/", ".github/", "certs/server.pem", "skills/alpha/id.key", "skills/beta/.cache/"]);
    const copied = path.join(userDir, "fake-pstack");
    const left = [".env", ".env.local", ".git", ".github", "certs/server.pem", "skills/alpha/id.key", "skills/beta/.cache"].filter((gone) => fs.existsSync(path.join(copied, gone)));
    expect(left).toEqual([]);
    expect(fs.existsSync(path.join(copied, ".gitignore"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(copied, COLLECTION_MANIFEST), "utf8")).excluded).toEqual(result.excluded);
  });

  it("成员所在的子目录在隐藏目录里（.claude/skills）：那条路上的不算隐藏目录", () => {
    const { lib } = library();
    const root = makeTempDir("ergo-src-");
    writeSkill(path.join(root, ".claude", "skills", "one"), "one", "一个");
    write(path.join(root, ".claude", "settings.json"), "{}\n");
    const result = lib.importFrom({ path: root, collection: { name: "fake-hidden", source: "假的", version: "1", description: "假的", skillsDir: ".claude/skills" } });
    expect(result.collection?.skills).toEqual(["one"]);
  });
});

describe("导入并改名", () => {
  it("单个 skill：目录名和 SKILL.md 里的 name 换成新名字，别的一个字不动；同名照旧被拒、说清和谁重名", () => {
    const { lib, userDir } = library();
    const source = fakeEngineering(makeTempDir("ergo-src-"));
    expect(lib.importFrom({ path: path.join(source, "tdd") }).skills).toEqual([{ name: "tdd", description: "Test-driven development.", origin: "imported" }]);
    // 再导入一个同名的：被拒，说清是和谁重名、可以改名
    expect(rejection(() => lib.importFrom({ path: path.join(source, "tdd") }))).toMatchObject({ code: "conflict", message: expect.stringContaining("tdd 和你导入的 tdd 重名") });
    expect(rejection(() => lib.importFrom({ path: writeSkill(path.join(makeTempDir("ergo-src-"), "x"), "example-checklist", "x") }))).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("example-checklist 和框架自带的 example-checklist 重名"),
    });

    const result = lib.importFrom({ path: path.join(source, "tdd"), rename: "mp-tdd" });
    expect(result.report).toEqual([{ name: "mp-tdd", dir: ".", ok: true, note: "改名导入：原来叫 tdd" }]);
    const original = fs.readFileSync(path.join(source, "tdd", "SKILL.md"), "utf8");
    const renamed = fs.readFileSync(path.join(userDir, "mp-tdd", "SKILL.md"), "utf8");
    expect(renamed).toBe(original.replace("name: tdd\r\n", "name: mp-tdd\r\n"));
    expect(fs.readFileSync(path.join(userDir, "mp-tdd", "agents", "openai.yaml"), "utf8")).toBe("policy: {}\n");
    expect(lib.list().map((s) => s.name)).toEqual(["example-checklist", "mp-tdd", "tdd"]);
  });

  it("改 SKILL.md 的 name：只换 frontmatter 里的那一行（BOM、换行、正文照旧），没有 name 行就补一行", () => {
    expect(withSkillName("---\nname: tdd\ndescription: x\n---\nname: 正文\n", "mp-tdd")).toBe("---\nname: mp-tdd\ndescription: x\n---\nname: 正文\n");
    expect(withSkillName("﻿---\r\ndescription: x\r\n---\r\n正文\r\n", "mp-tdd")).toBe("﻿---\r\nname: mp-tdd\r\ndescription: x\r\n---\r\n正文\r\n");
    expect(withSkillName("没有 frontmatter", "x")).toBe("没有 frontmatter");
  });
});

describe("目录名规范成小写、不带空格（82 号票：斜杠命令就是目录名）", () => {
  it("单个 skill：目录名转小写、空格和符号换成 -，SKILL.md 一字不动、名字照原样；规范之后重名的被拒、说清和谁重名；和框架自带的目录同名也拒", () => {
    const { lib, userDir } = library();
    const original = "---\nname: Fancy Skill\ndescription: 带空格的名字\n---\n\n正文\n";
    const source = path.join(makeTempDir("ergo-src-"), "Fancy Skill_v2");
    write(path.join(source, "SKILL.md"), original);
    const result = lib.importFrom({ path: source });
    expect(result.skills).toEqual([{ name: "Fancy Skill", description: "带空格的名字", origin: "imported" }]);
    expect(result.report).toEqual([{ name: "Fancy Skill", dir: ".", ok: true, note: expect.stringContaining("目录名规范成 fancy-skill-v2（原来是 Fancy Skill_v2），斜杠命令是 /fancy-skill-v2") }]);
    expect(fs.readFileSync(path.join(userDir, "fancy-skill-v2", "SKILL.md"), "utf8")).toBe(original);
    expect(fs.readdirSync(userDir)).toEqual(["fancy-skill-v2"]);

    // 规范之后和已有的目录同名：拒绝，说清是谁
    const other = path.join(makeTempDir("ergo-src-"), "FANCY skill  v2");
    write(path.join(other, "SKILL.md"), "---\nname: other\ndescription: 另一个\n---\n");
    expect(rejection(() => lib.importFrom({ path: other }))).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("目录名 FANCY skill  v2（规范之后是 fancy-skill-v2） 和你导入的 Fancy Skill 的目录重名"),
    });
    // 和框架自带的 skill 的目录同名（名字不同）：/example-checklist 会分不清，拒绝
    expect(rejection(() => lib.importFrom({ path: writeSkill(path.join(makeTempDir("ergo-src-"), "example-checklist"), "my-checklist", "x") }))).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("目录名 example-checklist 和框架自带的 example-checklist 的目录重名"),
    });
    // 改名导入就能进来
    expect(lib.importFrom({ path: other, rename: "other-skill" }).report[0]).toMatchObject({ name: "other-skill", ok: true });
    // 目录名里全是符号：规范不出东西
    const symbols = path.join(makeTempDir("ergo-src-"), "+++");
    write(path.join(symbols, "SKILL.md"), "---\nname: symbols\ndescription: 全是符号\n---\n");
    expect(rejection(() => lib.importFrom({ path: symbols }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("规范成小写、不带空格的写法之后什么都不剩") });
  });

  it("集合的成员：目录名一样规范（只改目录名），报告里提一句；规范之后撞上的整套拒绝；集合名不能叫 skill", () => {
    const { lib, userDir } = library();
    const root = makeTempDir("ergo-src-");
    const original = "---\nname: Make Bot UI\ndescription: 显示名当名字\n---\n\n正文\n";
    write(path.join(root, "Make Bot UI", "SKILL.md"), original);
    writeSkill(path.join(root, "plain"), "plain", "普通的");
    const spec = { name: "fake-ui", source: "假的", version: "1", description: "假的" };
    expect(rejection(() => lib.importFrom({ path: root, collection: { ...spec, name: "skill" } }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("集合名不能叫 skill") });

    const result = lib.importFrom({ path: root, collection: spec });
    expect(result.report).toContainEqual({ name: "Make Bot UI", dir: "Make Bot UI", ok: true, note: expect.stringContaining("目录名从 Make Bot UI 改成了 make-bot-ui，集合里其他 skill 按原目录名写的相对引用可能对不上") });
    expect(fs.readFileSync(path.join(userDir, "fake-ui", "make-bot-ui", "SKILL.md"), "utf8")).toBe(original);
    expect(JSON.parse(fs.readFileSync(path.join(userDir, "fake-ui", COLLECTION_MANIFEST), "utf8"))).toMatchObject({ members: ["make-bot-ui", "plain"] });
    expect(lib.pathsOf(["Make Bot UI"])).toEqual([path.join(userDir, "fake-ui", "make-bot-ui")]);

    // 两个成员的目录规范之后一样：整套拒绝
    const clash = makeTempDir("ergo-src-");
    writeSkill(path.join(clash, "Same Dir"), "same-one", "一");
    writeSkill(path.join(clash, "same_dir"), "same-two", "二");
    expect(rejection(() => lib.importFrom({ path: clash, collection: { ...spec, name: "fake-clash" } }))).toMatchObject({ code: "conflict", message: expect.stringContaining("目录名规范之后都是 same-dir") });
  });
});

describe("把一个目录作为集合导入", () => {
  it("记下集合名、来源、版本、说明；成员是库里独立的 skill 名、带着集合名；整个根目录带上，../../ 引用的文件照样在；不合规的成员跳过并写明原因", () => {
    const { lib, userDir } = library();
    const plugin = fakePlugin(makeTempDir("ergo-src-"));
    const result = lib.importFrom({
      path: plugin,
      collection: { name: "fake-pstack", source: "假插件仓库的 fake-pstack/", version: "0.1.0", description: "假的工程方法论", skillsDir: "skills" },
    });
    expect(result.collection).toEqual({ name: "fake-pstack", source: "假插件仓库的 fake-pstack/", version: "0.1.0", description: "假的工程方法论", skills: ["alpha", "beta", "tdd"] });
    expect(result.skills.map((s) => [s.name, s.collection])).toEqual([
      ["alpha", "fake-pstack"],
      ["beta", "fake-pstack"],
      ["tdd", "fake-pstack"],
    ]);
    expect(result.report).toEqual([
      { name: "alpha", dir: "skills/alpha", ok: true },
      { name: "beta", dir: "skills/beta", ok: true },
      { name: "broken", dir: "skills/broken", ok: false, note: expect.stringContaining("没有 description") },
      { name: "tdd", dir: "skills/tdd", ok: true },
    ]);

    // 库里：集合显示成一项，成员各自有名字；单个导入的照旧
    writeSkill(path.join(userDir, "yt-dlp"), "yt-dlp", "下载视频");
    expect(lib.collections()).toEqual([result.collection]);
    expect(lib.list()).toEqual([
      { name: "example-checklist", description: "框架自带的示例", origin: "framework" },
      { name: "alpha", description: "第一个", origin: "imported", collection: "fake-pstack" },
      { name: "beta", description: "第二个", origin: "imported", collection: "fake-pstack" },
      { name: "tdd", description: "假插件的 tdd", origin: "imported", collection: "fake-pstack" },
      { name: "yt-dlp", description: "下载视频", origin: "imported" },
    ]);
    // 成员的目录在集合目录里，原来的相对引用照样对得上
    const [alphaDir] = lib.pathsOf(["alpha"]);
    expect(alphaDir).toBe(path.join(userDir, "fake-pstack", "skills", "alpha"));
    expect(fs.readFileSync(path.resolve(alphaDir!, "../../docs/guide/01-setup.md"), "utf8")).toContain("MARKER_PLUGIN_GUIDE");
    expect(fs.existsSync(path.resolve(alphaDir!, "../beta/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(userDir, "fake-pstack", "agents", "helper-agent.md"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userDir, "fake-pstack", COLLECTION_MANIFEST), "utf8"))).toEqual({
      format: 1,
      name: "fake-pstack",
      source: "假插件仓库的 fake-pstack/",
      version: "0.1.0",
      description: "假的工程方法论",
      members: ["skills/alpha", "skills/beta", "skills/tdd"],
      importedFrom: fs.realpathSync.native(plugin),
      importedAt: "2026-10-10T12:00:00.000+08:00",
    });
    // 集合名整套展开；不认识的单列
    expect(lib.expand(["fake-pstack", "yt-dlp", "nope"])).toEqual({ skills: ["alpha", "beta", "tdd", "yt-dlp"], unknown: ["nope"] });
  });

  it("成员和库里已有的重名：整套拒绝、说清和谁重名（什么都不复制）；导入并改名就能进来（只改目录名和 name）", () => {
    const { lib, userDir } = library();
    lib.importFrom({ path: fakePlugin(makeTempDir("ergo-src-")), collection: { name: "fake-pstack", source: "假插件", version: "0.1.0", description: "假的", skillsDir: "skills" } });
    const engineering = fakeEngineering(makeTempDir("ergo-src-"));
    const spec = { name: "fake-mp", source: "假的 engineering", version: "1.2.3", description: "假的一套" };
    expect(rejection(() => lib.importFrom({ path: engineering, collection: spec }))).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("tdd 和集合 fake-pstack 里的 tdd 重名"),
    });
    expect(fs.readdirSync(userDir).toSorted()).toEqual(["fake-pstack"]);
    // 集合名和已有的 skill 重名也不行
    expect(rejection(() => lib.importFrom({ path: engineering, collection: { ...spec, name: "beta" } }))).toMatchObject({ code: "conflict", message: expect.stringContaining("集合名 beta 和集合 fake-pstack 里的 beta 重名") });
    // 改名里写了不是成员的
    expect(rejection(() => lib.importFrom({ path: engineering, collection: { ...spec, rename: { nope: "x" } } }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("nope 不是这个集合里的 skill") });

    const result = lib.importFrom({ path: engineering, collection: { ...spec, rename: { tdd: "mp-tdd" } } });
    expect(result.collection?.skills).toEqual(["code-review", "implement", "mp-tdd"]);
    expect(result.report).toContainEqual({ name: "mp-tdd", dir: "tdd", ok: true, note: "改名导入：原来叫 tdd" });
    const renamed = path.join(userDir, "fake-mp", "mp-tdd");
    expect(fs.existsSync(path.join(userDir, "fake-mp", "tdd"))).toBe(false);
    expect(fs.readFileSync(path.join(renamed, "SKILL.md"), "utf8")).toBe(
      "---\r\nname: mp-tdd\r\ndescription: Test-driven development.\r\n---\r\n\r\n# Test-Driven Development\r\n\r\nname: 正文里的这一行不改\r\n",
    );
    expect(fs.existsSync(path.join(renamed, "agents", "openai.yaml"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userDir, "fake-mp", COLLECTION_MANIFEST), "utf8"))).toMatchObject({ members: ["code-review", "implement", "mp-tdd"], renamed: { "mp-tdd": "tdd" } });
    expect(lib.pathsOf(["tdd", "mp-tdd"])).toEqual([path.join(userDir, "fake-pstack", "skills", "tdd"), renamed]);
    // 再导入同名的集合被拒
    expect(rejection(() => lib.importFrom({ path: engineering, collection: { ...spec, rename: { tdd: "mp-tdd" } } }))).toMatchObject({ code: "conflict", message: expect.stringContaining("集合 fake-mp") });
  });

  it("集合里的成员带依赖目录：一样按原路径引用；成员改了名，链接跟着在新目录里", () => {
    const { lib, userDir } = library();
    const root = makeTempDir("ergo-src-");
    writeSkill(path.join(root, "tool-a"), "tool-a", "带依赖的成员");
    write(path.join(root, "tool-a", "node_modules", "dep", "index.js"), "MARKER_DEP\n");
    const result = lib.importFrom({ path: root, collection: { name: "fake-tools", source: "假的", version: "1", description: "假的", rename: { "tool-a": "tool-b" } } });
    const realDeps = fs.realpathSync.native(path.join(root, "tool-a", "node_modules"));
    expect(result.linked).toEqual([{ dir: "fake-tools/tool-b/node_modules", target: realDeps }]);
    expect(result.report).toEqual([{ name: "tool-b", dir: "tool-a", ok: true, note: `改名导入：原来叫 tool-a；依赖目录 tool-b/node_modules 没复制，按原路径引用：${realDeps}` }]);
    expect(fs.readFileSync(path.join(userDir, "fake-tools", "tool-b", "node_modules", "dep", "index.js"), "utf8")).toContain("MARKER_DEP");
  });

  it("SKILL.md 的 name 写的是显示名（照 pstack 的 poteto-mode：\"Poteto Mode\"）：照原样认、照原样用，SKILL.md 一个字不改；重名按原来的名字判", () => {
    const { lib, userDir } = library();
    const root = makeTempDir("ergo-src-");
    const original = "---\nname: Fancy Mode\ndescription: 入口\nmode: true\n---\n\n# Fancy Mode\n";
    write(path.join(root, "fancy-mode", "SKILL.md"), original);
    writeSkill(path.join(root, "plain"), "plain", "普通的");
    const result = lib.importFrom({ path: root, collection: { name: "fake-fancy", source: "假的", version: "1", description: "假的" } });
    expect(result.collection?.skills).toEqual(["Fancy Mode", "plain"]);
    expect(result.report).toContainEqual({ name: "Fancy Mode", dir: "fancy-mode", ok: true, note: expect.stringContaining("名字「Fancy Mode」不是小写字母、数字、短横线的写法，照原样用") });
    expect(fs.readFileSync(path.join(userDir, "fake-fancy", "fancy-mode", "SKILL.md"), "utf8")).toBe(original);
    expect(lib.pathsOf(["Fancy Mode"])).toEqual([path.join(userDir, "fake-fancy", "fancy-mode")]);
    // 同名（照原来的名字）的单个 skill 被拒
    const again = makeTempDir("ergo-src-");
    write(path.join(again, "other", "SKILL.md"), "---\nname: Fancy Mode\ndescription: 另一个\n---\n");
    expect(rejection(() => lib.importFrom({ path: path.join(again, "other") }))).toMatchObject({ code: "conflict", message: expect.stringContaining("Fancy Mode 和集合 fake-fancy 里的 Fancy Mode 重名") });
    // 手放进 skill 区的也照原样认
    write(path.join(userDir, "hand-placed", "SKILL.md"), "---\nname: Hand Placed\ndescription: x\n---\n");
    expect(lib.missing(["Hand Placed"])).toEqual([]);
  });

  it("目录本身是一个 skill、成员子目录不对、下面没有 skill 的都拒绝", () => {
    const { lib } = library();
    const spec = { name: "fake-set", source: "假的", version: "1", description: "假的" };
    const single = writeSkill(path.join(makeTempDir("ergo-src-"), "one"), "one", "一个");
    expect(rejection(() => lib.importFrom({ path: single, collection: spec }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("本身是一个 skill") });
    const root = fakePlugin(makeTempDir("ergo-src-"));
    expect(rejection(() => lib.importFrom({ path: root, collection: { ...spec, skillsDir: "../outside" } }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("相对路径") });
    expect(rejection(() => lib.importFrom({ path: root, collection: { ...spec, skillsDir: "nope" } }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("没有成员所在的子目录") });
    expect(rejection(() => lib.importFrom({ path: root, collection: spec }))).toMatchObject({ code: "bad_params", message: expect.stringContaining("没有含 SKILL.md 的目录") });
  });
});

describe("秘书用的 skill", () => {
  it("没有设置文件按默认的 agent-browser、yt-dlp（库里还没有的悄悄跳过，导入后自动装上）；只能选库里有的；改了通知、名单没变不通知；文件写错了按默认的并说明", () => {
    const { lib, dataDir, userDir, logs } = library();
    const file = path.join(dataDir, "config", "secretary-skills.json");
    const skills = createSecretarySkills({ file, library: lib, log: (l) => logs.push(l) });
    let changes = 0;
    skills.onChange(() => changes++);
    expect(skills.view()).toEqual({ skills: ["agent-browser", "yt-dlp"], isDefault: true, promptChars: 0, promptBytes: 0 });
    expect(skills.paths()).toEqual([]);
    writeSkill(path.join(userDir, "yt-dlp"), "yt-dlp", "下载视频");
    expect(skills.paths()).toEqual([path.join(userDir, "yt-dlp")]);
    expect(logs.filter((l) => l.includes("agent-browser"))).toEqual([]);

    expect(rejection(() => skills.set(["yt-dlp", "nope"]))).toMatchObject({ code: "bad_params", message: expect.stringContaining("skill 库里没有 nope") });
    expect(changes).toBe(0);
    lib.importFrom({ path: fakePlugin(makeTempDir("ergo-src-")), collection: { name: "fake-pstack", source: "假的", version: "1", description: "假的", skillsDir: "skills" } });
    expect(skills.set(["alpha", "yt-dlp", "alpha"])).toMatchObject({ skills: ["alpha", "yt-dlp"], isDefault: false });
    // 系统提示里 skill 说明多长：照 pi 列 skill 的写法估（名字、说明、位置）
    const sized = skills.view();
    expect(sized.promptChars).toBe(skillPromptSize(lib.find(["alpha", "yt-dlp"])).promptChars);
    expect(sized.promptBytes).toBeGreaterThan(sized.promptChars);
    expect(changes).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, skills: ["alpha", "yt-dlp"] });
    expect(skills.paths()).toEqual([path.join(userDir, "fake-pstack", "skills", "alpha"), path.join(userDir, "yt-dlp")]);
    skills.set(["alpha", "yt-dlp"]);
    expect(changes).toBe(1);
    // 全部取消也行
    expect(skills.set([])).toEqual({ skills: [], isDefault: false, promptChars: 0, promptBytes: 0 });
    expect(skills.paths()).toEqual([]);
    // 改过名单之后，默认的两个照样可以先于导入留着（导入后自动装上），别的不行
    expect(skills.set(["agent-browser", "yt-dlp"])).toMatchObject({ skills: ["agent-browser", "yt-dlp"], isDefault: false });
    expect(skills.paths()).toEqual([path.join(userDir, "yt-dlp")]);
    writeSkill(path.join(userDir, "agent-browser"), "agent-browser", "浏览器");
    expect(skills.paths()).toEqual([path.join(userDir, "agent-browser"), path.join(userDir, "yt-dlp")]);
    expect(logs.filter((l) => l.includes("不在 skill 库里"))).toEqual([]);

    fs.writeFileSync(file, "{ 坏了");
    expect(skills.view()).toMatchObject({ skills: ["agent-browser", "yt-dlp"], isDefault: true, problem: expect.stringContaining("读不了") });
  });
});
