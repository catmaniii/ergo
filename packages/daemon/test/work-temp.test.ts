// bash 的临时目录（177 号票，agent-manager/work-temp.ts）：工作目录里的 .ergo-tmp，git 不收、7 天没动过的删掉；
// 守卫看到的维护者带着同样的 TMPDIR、TEMP、TMP 和 /tmp 挂到哪；Git Bash 的 /tmp 按守护进程的 TMP / TEMP 算。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maintainerGuardAgent, type MaintainerAssembly } from "../src/agent-host/assembly.ts";
import { bashTmpMount, ensureWorkTempDir, WORK_TEMP_DIR, workTempDir } from "../src/agent-manager/work-temp.ts";
import { git, initRepo } from "./helpers/git-repo.ts";
import { waitUntil } from "./helpers/process.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const DAY = 24 * 60 * 60 * 1000;
const real = (p: string) => fs.realpathSync.native(p);

describe("工作目录里的临时目录", () => {
  it("建好、写上只有 * 的 .gitignore：git 不收里面的东西，也不用改项目的 .gitignore", () => {
    const repo = makeTempDir("ergo-work-");
    initRepo(repo);
    const dir = workTempDir(repo);
    expect(path.basename(dir)).toBe(WORK_TEMP_DIR);
    ensureWorkTempDir(dir, Date.now(), () => {});
    fs.writeFileSync(path.join(dir, "cand.txt"), "x");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false);
  });

  it("拉起时顺手删掉 7 天没动过的文件和空目录；新的、.gitignore 留着", async () => {
    const dir = workTempDir(makeTempDir("ergo-work-"));
    fs.mkdirSync(path.join(dir, "old-run"), { recursive: true });
    fs.writeFileSync(path.join(dir, "old.txt"), "x");
    fs.writeFileSync(path.join(dir, "old-run", "a.txt"), "x");
    fs.writeFileSync(path.join(dir, "fresh.txt"), "x");
    const old = new Date(Date.now() - 8 * DAY);
    for (const p of ["old.txt", "old-run/a.txt", "old-run"]) fs.utimesSync(path.join(dir, p), old, old);
    ensureWorkTempDir(dir, Date.now(), () => {});
    await waitUntil(() => !fs.existsSync(path.join(dir, "old-run")), { describe: () => "旧的空目录被删掉" });
    expect(fs.readdirSync(dir).toSorted()).toEqual([".gitignore", "fresh.txt"]);
  });
});

describe("Git Bash 的 /tmp 挂到哪", () => {
  it("按 GetTempPath 的顺序：TMP、TEMP、USERPROFILE；变量名不分大小写；展开成真实路径", () => {
    const a = makeTempDir("ergo-tmp-a-");
    const b = makeTempDir("ergo-tmp-b-");
    expect(bashTmpMount({ TMP: a, TEMP: b })).toBe(real(a));
    expect(bashTmpMount({ temp: b })).toBe(real(b));
    expect(bashTmpMount({ USERPROFILE: a })).toBe(real(a));
    expect(bashTmpMount({})).toBeUndefined();
  });
});

describe("守卫看到的维护者", () => {
  const base: MaintainerAssembly = {
    cwd: "E:\\work\\notes",
    toolkit: { bash: true, network: true },
    skillPaths: [],
    piTools: ["read", "bash"],
    hostTools: [],
    projectRecords: ["D:\\ergo-data\\projects\\notes"],
    workingDirs: ["E:\\work\\notes"],
    development: false,
  };

  it("带着指到临时目录的 TMPDIR、TEMP、TMP（盖过事件的值里同名的）和 /tmp 挂到哪", () => {
    const tempDir = "E:\\work\\notes\\.ergo-tmp";
    const agent = maintainerGuardAgent("pm-1", { ...base, tempDir, bashTmp: "C:\\Temp", shellEnv: { ERGO_EVENT_PATH: "a.txt", TMPDIR: "x" } });
    expect(agent).toMatchObject({ shellVars: { ERGO_EVENT_PATH: "a.txt", TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir }, bashTmp: "C:\\Temp" });
    // 没开 bash 的装配里没有临时目录：守卫照旧
    expect("shellVars" in maintainerGuardAgent("pm-1", base)).toBe(false);
  });
});
