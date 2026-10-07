// 守护进程一侧现取的环境事实（规格第 9 节：判定函数是纯函数，文件元数据、git 状态由调用方现取后传入）。
// 按一次判定拆出来的调用取：路径参数的文件在不在、真实路径（符号链接、目录联接、8.3 短名），
// 项目里的 git 状态（含 HEAD），要跑的脚本的扫描结果。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, type JudgedCall } from "../../src/guard/index.ts";
import { gatherFacts } from "../../src/guard-runtime/facts.ts";
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

function context(agent: GuardAgent, projectsDir = makeTempDir("ergou-projects-")) {
  return { tools: BUILTIN_TOOL_REGISTRY, agent, homeDir: makeTempDir("ergou-home-"), projectsDir };
}

describe("文件", () => {
  it("在不在、是不是目录、真实路径；相对路径按工作目录解析", () => {
    const scratch = real(makeTempDir("ergou-scratch-"));
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
    const scratch = real(makeTempDir("ergou-scratch-"));
    const outside = real(makeTempDir("ergou-outside-"));
    fs.symlinkSync(outside, path.join(scratch, "link"), "junction");
    const target = path.join(scratch, "link", "x.txt");
    const facts = gatherFacts([tool("write", { path: target })], context(secretary(scratch)));
    expect(facts.files?.[target]).toEqual({ exists: false, realPath: path.join(outside, "x.txt") });
  });

  it("短名（8.3）和长名指的是同一个地方：真实路径是长名", () => {
    const dir = makeTempDir("ergou-long-directory-name-");
    const facts = gatherFacts([tool("read", { path: dir })], context(secretary(dir)));
    expect(facts.files?.[path.resolve(dir)]?.realPath).toBe(real(dir));
  });

  it("项目区里的文件：运行时会自动留旧版本，算已备份", () => {
    const projects = real(makeTempDir("ergou-projects-"));
    const records = path.join(projects, "notes");
    const workDir = path.join(records, "work");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(records, "spec.md"), "x");
    const facts = gatherFacts([tool("write", { path: path.join(records, "spec.md") })], context(maintainer(records, workDir), projects));
    expect(facts.files?.[path.join(records, "spec.md")]).toMatchObject({ exists: true, backedUp: true });
  });

  it("没法确定的路径、伪设备：不取", () => {
    const scratch = real(makeTempDir("ergou-scratch-"));
    const facts = gatherFacts([shell("delete", { path: "<unresolved:$X/a>" }), shell("copy", { from: "a", to: "/dev/null" })], context(secretary(scratch)));
    expect(Object.keys(facts.files ?? {})).toEqual([path.join(scratch, "a")]);
  });
});

describe("脚本", () => {
  it("要跑的脚本：扫描结果", () => {
    const scratch = real(makeTempDir("ergou-scratch-"));
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
    const records = real(makeTempDir("ergou-records-"));
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
    const records = real(makeTempDir("ergou-records-"));
    const workDir = path.join(records, "plain");
    fs.mkdirSync(workDir);
    const facts = gatherFacts([tool("write", { path: path.join(workDir, "x.txt") })], context(maintainer(records, workDir)));
    expect(facts.git?.[workDir]).toEqual({ uncommittedPaths: [], repository: false });
  });

  it("秘书的草稿区不取 git 状态（v1 模板不管草稿区）", () => {
    const scratch = real(makeTempDir("ergou-scratch-"));
    expect(gatherFacts([tool("write", { path: path.join(scratch, "x.txt") })], context(secretary(scratch))).git).toBeUndefined();
  });
});
