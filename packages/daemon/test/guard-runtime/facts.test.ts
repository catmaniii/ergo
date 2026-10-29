// 守护进程一侧现取的环境事实（规格第 9 节：判定函数是纯函数，文件元数据、git 状态由调用方现取后传入）。
// 按一次判定拆出来的调用取：路径参数的文件在不在、真实路径（符号链接、目录联接、8.3 短名），
// 项目里的 git 状态（含 HEAD），要跑的脚本的扫描结果。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, type JudgedCall } from "../../src/guard/index.ts";
import { gatherFacts, gatherFileFacts } from "../../src/guard-runtime/facts.ts";
import { isAutoVersioned } from "../../src/projects/records.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const real = (p: string) => fs.realpathSync.native(p);

function secretary(scratch: string): GuardAgent {
  return { kind: "secretary", agentId: "secretary", cwd: scratch, toolkit: { bash: true, network: false }, scratchDir: scratch };
}

function maintainer(records: string, workDir: string): GuardAgent {
  return { kind: "maintainer", agentId: "m-1", cwd: workDir, toolkit: { bash: true, network: false }, projectRecords: [records], workingDirs: [workDir] };
}

const tool = (name: string, args: Record<string, unknown>): JudgedCall => ({ tool: name, args, origin: "tool" });
const shell = (name: string, args: Record<string, unknown>): JudgedCall => ({ tool: name, args, origin: "shell", text: "…" });

function context(agent: GuardAgent, projectsDir = makeTempDir("ergo-projects-")) {
  return { tools: BUILTIN_TOOL_REGISTRY, agent, homeDir: makeTempDir("ergo-home-"), backedUp: (p: string) => isAutoVersioned(projectsDir, p) };
}

describe("文件", () => {
  it("在不在、是不是目录、真实路径；相对路径按工作目录解析", () => {
    const scratch = real(makeTempDir("ergo-scratch-"));
    fs.writeFileSync(path.join(scratch, "a.txt"), "x");
    fs.mkdirSync(path.join(scratch, "sub"));
    const facts = gatherFacts([tool("read", { path: "a.txt" }), tool("ls", { path: "sub" }), tool("write", { path: "new.txt" })], context(secretary(scratch)));
    expect(facts.files).toEqual({
      [path.join(scratch, "a.txt")]: { exists: true, isDirectory: false, realPath: path.join(scratch, "a.txt") },
      [path.join(scratch, "sub")]: { exists: true, isDirectory: true, realPath: path.join(scratch, "sub") },
      [path.join(scratch, "new.txt")]: { exists: false, realPath: path.join(scratch, "new.txt") },
    });
  });

  it("经目录联接指到别处：真实路径是联接的目标（还不存在的文件按最近的已有上级目录算）", () => {
    const scratch = real(makeTempDir("ergo-scratch-"));
    const outside = real(makeTempDir("ergo-outside-"));
    fs.symlinkSync(outside, path.join(scratch, "link"), "junction");
    const target = path.join(scratch, "link", "x.txt");
    const facts = gatherFacts([tool("write", { path: target })], context(secretary(scratch)));
    expect(facts.files?.[target]).toEqual({ exists: false, realPath: path.join(outside, "x.txt") });
  });

  it("悬空的目录联接（指向的地方没了）：取不到真实路径，不退回成写的路径（58 号票）", () => {
    const scratch = real(makeTempDir("ergo-scratch-"));
    const gone = path.join(real(makeTempDir("ergo-outside-")), "gone");
    fs.mkdirSync(gone);
    fs.symlinkSync(gone, path.join(scratch, "link"), "junction");
    fs.rmdirSync(gone);
    const link = path.join(scratch, "link");
    const inside = path.join(link, "x.txt");
    const facts = gatherFileFacts([tool("ls", { path: link }), tool("write", { path: inside })], context(secretary(scratch)));
    expect(facts.files?.[link]?.realPath).toBeUndefined();
    expect(facts.files?.[inside]?.realPath).toBeUndefined();
  });

  it("短名（8.3）和长名指的是同一个地方：真实路径是长名", () => {
    const dir = makeTempDir("ergo-long-directory-name-");
    const facts = gatherFacts([tool("read", { path: dir })], context(secretary(dir)));
    expect(facts.files?.[path.resolve(dir)]?.realPath).toBe(real(dir));
  });

  it("项目档案里的文件：运行时会自动留旧版本，算已备份；默认工作目录、历史区里的不算，经目录联接指到外面的也不算", () => {
    const projects = real(makeTempDir("ergo-projects-"));
    const records = path.join(projects, "notes");
    const workDir = path.join(records, "workdir");
    const outside = real(makeTempDir("ergo-outside-"));
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(path.join(records, ".history", "20261008100000000"), { recursive: true });
    fs.writeFileSync(path.join(records, "spec.md"), "x");
    fs.writeFileSync(path.join(workDir, "notes.md"), "x");
    fs.writeFileSync(path.join(outside, "a.md"), "x");
    fs.symlinkSync(outside, path.join(records, "linked"), "junction");
    const targets = [path.join(records, "spec.md"), path.join(workDir, "notes.md"), path.join(records, ".history", "20261008100000000", "spec.md"), path.join(records, "linked", "a.md")];
    const facts = gatherFacts(
      targets.map((p) => tool("write", { path: p })),
      context(maintainer(records, workDir), projects),
    );
    expect(targets.map((p) => facts.files?.[p]?.backedUp === true)).toEqual([true, false, false, false]);
  });

  it("没法确定的路径、伪设备：不取", () => {
    const scratch = real(makeTempDir("ergo-scratch-"));
    const facts = gatherFacts([shell("delete", { path: "<unresolved:$X/a>" }), shell("copy", { from: "a", to: "/dev/null" })], context(secretary(scratch)));
    expect(Object.keys(facts.files ?? {})).toEqual([path.join(scratch, "a")]);
  });
});

describe("带通配符的路径（101 号票评审后定）", () => {
  it("展开成现有的路径；展不开的是通配符之前那段目录；不带通配符的不取", () => {
    const scratch = real(makeTempDir("ergo-scratch-"));
    fs.mkdirSync(path.join(scratch, "config"));
    fs.writeFileSync(path.join(scratch, "config", "ergo.json"), "{}");
    const facts = gatherFacts([shell("copy", { from: "a.txt", to: "conf?g/ergo.json" }), shell("read", { path: "nothing*/x" }), shell("read", { path: "a.txt" })], context(secretary(scratch)));
    expect(facts.wildcards).toEqual({
      [path.join(scratch, "conf?g", "ergo.json")]: [path.join(scratch, "config", "ergo.json")],
      [path.join(scratch, "nothing*", "x")]: [scratch],
    });
  });
});

const birth = (p: string) => fs.statSync(p).birthtimeMs;

describe("临时文件要的事实（111 号票，调用方说这个 agent 在做任务、项目时才取）", () => {

  it("文件的创建时间；没说在做任务的不取", () => {
    const records = real(makeTempDir("ergo-records-"));
    const workDir = path.join(records, "work");
    fs.mkdirSync(workDir);
    fs.writeFileSync(path.join(workDir, "gen.js"), "x");
    const calls = [shell("delete", { path: "gen.js" }), tool("write", { path: "new.js" })];
    const facts = gatherFacts(calls, { ...context(maintainer(records, workDir)), ownWork: true });
    expect(facts.files?.[path.join(workDir, "gen.js")]).toMatchObject({ exists: true, createdAt: birth(path.join(workDir, "gen.js")) });
    expect(facts.files?.[path.join(workDir, "new.js")]).not.toHaveProperty("createdAt");
    expect(gatherFacts(calls, context(maintainer(records, workDir))).files?.[path.join(workDir, "gen.js")]).not.toHaveProperty("createdAt");
  });

  it("要删除的目录：里面的东西（递归）和它们的创建时间；工作目录外的、只读的不取", () => {
    const records = real(makeTempDir("ergo-records-"));
    const workDir = path.join(records, "work");
    const tmp = path.join(workDir, "tmp");
    fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "a.json"), "1");
    fs.writeFileSync(path.join(tmp, "sub", "b.json"), "2");
    const outside = real(makeTempDir("ergo-outside-"));
    fs.writeFileSync(path.join(outside, "x.txt"), "1");
    const ctx = { ...context(maintainer(records, workDir)), ownWork: true };
    const facts = gatherFacts([shell("delete", { path: tmp, recursive: true }), shell("read", { path: path.join(tmp, "sub") }), shell("delete", { path: outside, recursive: true })], ctx);
    expect(facts.files?.[outside]).not.toHaveProperty("contents");
    const contents = facts.files?.[tmp]?.contents;
    expect(contents?.complete).toBe(true);
    expect((contents?.entries ?? []).toSorted((x, y) => x.path.localeCompare(y.path))).toEqual(
      [path.join(tmp, "a.json"), path.join(tmp, "sub"), path.join(tmp, "sub", "b.json")].map((p) => ({ path: p, createdAt: birth(p) })),
    );
    expect(facts.files?.[path.join(tmp, "sub")]).not.toHaveProperty("contents");
  });

  it("目录里有链接（目录联接）：列不全", () => {
    const records = real(makeTempDir("ergo-records-"));
    const workDir = path.join(records, "work");
    const tmp = path.join(workDir, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    fs.symlinkSync(real(makeTempDir("ergo-outside-")), path.join(tmp, "link"), "junction");
    const facts = gatherFacts([shell("delete", { path: tmp, recursive: true })], { ...context(maintainer(records, workDir)), ownWork: true });
    expect(facts.files?.[tmp]?.contents?.complete).toBe(false);
  });

  it("带通配符要删除的：展开成的每个现有路径也取文件事实", () => {
    const records = real(makeTempDir("ergo-records-"));
    const workDir = path.join(records, "work");
    fs.mkdirSync(workDir);
    fs.writeFileSync(path.join(workDir, "a.json"), "1");
    fs.writeFileSync(path.join(workDir, "b.json"), "2");
    const facts = gatherFacts([shell("delete", { path: "*.json" })], { ...context(maintainer(records, workDir)), ownWork: true });
    for (const name of ["a.json", "b.json"]) expect(facts.files?.[path.join(workDir, name)]).toMatchObject({ exists: true, createdAt: birth(path.join(workDir, name)) });
  });
});

describe("脚本", () => {
  it("要跑的脚本：扫描结果", () => {
    const scratch = real(makeTempDir("ergo-scratch-"));
    fs.writeFileSync(path.join(scratch, "fetch.py"), "import requests\n");
    fs.writeFileSync(path.join(scratch, "calc.js"), "console.log(1 + 1)\n");
    const facts = gatherFacts(
      [shell("run_script", { interpreter: "python", path: path.join(scratch, "fetch.py") }), shell("run_script", { interpreter: "node", path: path.join(scratch, "calc.js") })],
      context(secretary(scratch)),
    );
    expect(facts.scripts).toEqual({
      [path.join(scratch, "fetch.py")]: { networkUsage: ["requests"] },
      [path.join(scratch, "calc.js")]: { networkUsage: [] },
    });
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

describe("git", () => {
  it("项目里的路径：包含它的仓库的未提交改动和 HEAD", () => {
    const records = real(makeTempDir("ergo-records-"));
    const workDir = path.join(records, "repo");
    fs.mkdirSync(workDir);
    git(workDir, "init", "-q");
    fs.writeFileSync(path.join(workDir, "a.txt"), "1");
    fs.writeFileSync(path.join(workDir, "b.txt"), "1");
    git(workDir, "add", ".");
    git(workDir, "commit", "-q", "-m", "init");
    const head = git(workDir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(workDir, "a.txt"), "2");
    fs.mkdirSync(path.join(workDir, "new"));
    fs.writeFileSync(path.join(workDir, "new", "c.txt"), "1");

    const facts = gatherFacts([tool("write", { path: path.join(workDir, "b.txt") })], context(maintainer(records, workDir)));
    // 未跟踪的目录写目录本身（git status 的默认写法）
    expect(facts.git?.[workDir]).toEqual({ uncommittedPaths: [path.join(workDir, "a.txt"), path.join(workDir, "new")], head });
  });

  it("项目里不在仓库里的目录：repository 为 false", () => {
    const records = real(makeTempDir("ergo-records-"));
    const workDir = path.join(records, "plain");
    fs.mkdirSync(workDir);
    const facts = gatherFacts([tool("write", { path: path.join(workDir, "x.txt") })], context(maintainer(records, workDir)));
    expect(facts.git?.[workDir]).toEqual({ uncommittedPaths: [], repository: false });
  });

  it("秘书的草稿区不取 git 状态（v1 模板不管草稿区）", () => {
    const scratch = real(makeTempDir("ergo-scratch-"));
    expect(gatherFacts([tool("write", { path: path.join(scratch, "x.txt") })], context(secretary(scratch))).git).toBeUndefined();
  });
});
