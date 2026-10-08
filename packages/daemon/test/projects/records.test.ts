// 项目档案的旧版本（15 号票）：放行一次要删除或整体重写项目档案里东西的调用之前，运行时把旧的留进项目自己的历史区。
// 认"要删除或整体重写哪些路径"和 v1 模板"删除或覆盖前须已备份或已提交"是同一份（守卫的 replacedPaths / pathReplacement）；
// 只覆盖项目档案：工作目录（默认的 workdir/ 也是）靠 git 提交或备份，历史区只由运行时写。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BUILTIN_TOOL_REGISTRY, type GuardInput, judgeToolCall, replacedPaths, type ToolCall } from "../../src/guard/index.ts";
import { ensureProjectRecords, isAutoVersioned, preserveVersions, projectRecordsPaths } from "../../src/projects/records.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const AT = "2026-10-08T10:00:00.000+08:00";

function setup() {
  const dataDir = fs.realpathSync.native(makeTempDir("ergou-data-"));
  const projectsDir = path.join(dataDir, "projects");
  const paths = projectRecordsPaths(projectsDir, "p-1");
  ensureProjectRecords(paths, { id: "p-1", name: "记账本", goal: "把家里的账管起来" });
  const input = (call: ToolCall, cwd = paths.workdir): GuardInput => ({
    call,
    agent: { kind: "maintainer", agentId: "pm-1", cwd, toolkit: { bash: true, network: false }, projectRecords: [paths.root], workingDirs: [paths.workdir] },
    places: { dataDir: { root: dataDir, config: path.join(dataDir, "config"), secrets: path.join(dataDir, "secrets"), db: path.join(dataDir, "db"), projects: projectsDir }, programDir: makeTempDir("ergou-program-"), homeDir: makeTempDir("ergou-home-") },
    task: null,
    effectLog: [],
    settings: {},
    facts: {},
    tools: BUILTIN_TOOL_REGISTRY,
    now: 0,
  });
  /** 和运行时一样：判定里要删除或整体重写的路径，自动留旧版本的地方认的，交给 preserveVersions */
  const preserve = (call: ToolCall, cwd?: string) => {
    const i = input(call, cwd);
    const targets = replacedPaths(judgeToolCall(i).calls, i.tools, { cwd: i.agent.cwd, homeDir: i.places.homeDir }).filter((p) => isAutoVersioned(projectsDir, p));
    preserveVersions(projectsDir, targets, AT);
  };
  const history = () => (fs.existsSync(paths.history) ? fs.readdirSync(paths.history) : []);
  return { projectsDir, paths, preserve, history };
}

describe("项目档案里的文件被整体重写或删除前留旧版本", () => {
  test("整体重写已有的文件：旧的留进历史区（按时间一格，保持相对路径）；新文件、局部编辑不留", () => {
    const { paths, preserve, history } = setup();
    const before = fs.readFileSync(paths.glossary, "utf8");
    preserve({ toolName: "write", args: { path: path.join(paths.root, "adr", "0001-new.md"), content: "新文件" } });
    preserve({ toolName: "edit", args: { path: paths.spec, edits: [{ oldText: "a", newText: "b" }] } });
    expect(history()).toEqual([]);
    preserve({ toolName: "write", args: { path: paths.glossary, content: "重写" } });
    expect(history()).toEqual(["20261008100000000"]);
    expect(fs.readFileSync(path.join(paths.history, "20261008100000000", "glossary.md"), "utf8")).toBe(before);
    // 同一时刻再来一次：另起一格，不覆盖
    preserve({ toolName: "write", args: { path: paths.glossary, content: "又重写" } });
    expect(history().toSorted()).toEqual(["20261008100000000", "20261008100000000-1"]);
  });

  test("bash 删项目档案里的目录：整个目录留进历史区", () => {
    const { paths, preserve, history } = setup();
    preserve({ toolName: "bash", args: { command: "rm -rf ../adr" } });
    const [slot] = history();
    expect(fs.readdirSync(path.join(paths.history, slot!, "adr"))).toEqual(["README.md"]);
  });

  test("工作目录（默认的 workdir/ 也是）里的不留：靠 git 提交或备份；rm -rf node_modules 不整树复制", () => {
    const { paths, preserve, history } = setup();
    fs.mkdirSync(path.join(paths.workdir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(paths.workdir, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
    fs.writeFileSync(path.join(paths.workdir, "notes.md"), "旧的");
    preserve({ toolName: "bash", args: { command: "rm -rf node_modules" } });
    preserve({ toolName: "write", args: { path: path.join(paths.workdir, "notes.md"), content: "新的" } });
    expect(history()).toEqual([]);
  });

  test("哪些地方自动留旧版本：项目档案里的文件和目录；不含项目区本身、项目档案的根、工作目录、历史区、项目区之外", () => {
    const { projectsDir, paths } = setup();
    const outside = path.join(fs.realpathSync.native(makeTempDir("ergou-repo-")), "a.txt");
    expect(
      [paths.charter, paths.adr, path.join(paths.adr, "0001-x.md"), projectsDir, paths.root, paths.workdir, path.join(paths.workdir, "a.txt"), paths.history, path.join(paths.history, "x", "spec.md"), outside].map((p) =>
        isAutoVersioned(projectsDir, p),
      ),
    ).toEqual([true, true, true, false, false, false, false, false, false, false]);
  });
});
