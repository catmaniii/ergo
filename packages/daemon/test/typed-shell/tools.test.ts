// 带类型的 bash 工具本身（28 号票）：守护进程代为执行的八个工具，按 HostTool 的接口直接调用（不经守卫、不起 agent），
// 在临时目录里的真实 git 仓库上跑。守卫判定、效果日志、聊天里的记录在主切面（test/main/typed-shell.test.ts）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HostToolOutput } from "../../src/agent-manager/host-tools.ts";
import { BUILTIN_TOOL_REGISTRY } from "../../src/guard/index.ts";
import type { JsonValue } from "../../src/runtime/index.ts";
import { createTypedShell, type TypedShellOptions } from "../../src/typed-shell/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { bareRemote, git, initRepo, put } from "../helpers/git-repo.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { tempUserProfileEnv, withEnv } from "../helpers/user-profile.ts";

/** 工具交回模型的结果：第一行一句话，第二行结构化的 JSON，后面可能跟着差异或输出原文 */
function parsed(out: HostToolOutput): { headline: string; data: Record<string, unknown>; body: string } {
  const [headline = "", json = "{}", ...rest] = out.text.split("\n");
  return { headline, data: JSON.parse(json) as Record<string, unknown>, body: rest.join("\n") };
}

function setup(options: { network?: boolean; bash?: boolean; shell?: Partial<TypedShellOptions> } = {}) {
  const home = makeTempDir("ergou-home-");
  const work = realPathOf(makeTempDir("ergou-work-"))!;
  const shell = createTypedShell({
    parentEnv: withEnv(process.env, tempUserProfileEnv(home)),
    homeDir: home,
    timeouts: { defaultMs: 60_000, longMs: 60_000 },
    log: () => {},
    ...options.shell,
  });
  const tools = shell.toolsFor({ cwd: work, toolkit: { bash: options.bash ?? true, network: options.network ?? true } });
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.spec.name === name);
    if (!tool) throw new Error(`没有工具 ${name}`);
    return tool.run(args as JsonValue, { toolCallId: `call-${name}` });
  };
  return { work, tools, run };
}

describe("八个工具", () => {
  it("随 bash 开关出现；登记就是守卫注册表里那份（typed_shell），参数名都登记过（时序规则、授权项按名字认）；跑测试、构建、装依赖声明更长的超时", () => {
    expect(setup({ bash: false }).tools).toEqual([]);
    const shell = createTypedShell({ parentEnv: process.env, homeDir: "C:\\Users\\tester", timeouts: { defaultMs: 600_000, longMs: 1_800_000 }, log: () => {} });
    const tools = shell.toolsFor({ cwd: "E:\\work\\notes", toolkit: { bash: true, network: false } });
    expect(tools.map((t) => t.spec.name)).toEqual(["git_status_diff", "git_commit", "git_merge", "git_push", "create_remote_repo", "run_tests", "start_build", "install_deps"]);
    for (const tool of tools) {
      expect(tool.descriptor).toBe(BUILTIN_TOOL_REGISTRY[tool.spec.name]);
      const params = Object.keys((tool.spec.parameters as { properties: Record<string, unknown> }).properties);
      expect({ tool: tool.spec.name, unregistered: params.filter((p) => !Object.hasOwn(tool.descriptor.args, p)) }).toEqual({ tool: tool.spec.name, unregistered: [] });
    }
    expect(Object.fromEntries(tools.map((t) => [t.spec.name, t.timeoutMs]))).toEqual({
      git_status_diff: undefined,
      git_commit: undefined,
      git_merge: undefined,
      git_push: undefined,
      create_remote_repo: undefined,
      run_tests: 1_800_000,
      start_build: 1_800_000,
      install_deps: 1_800_000,
    });
  });
});

describe("git 状态和差异", () => {
  it("在工作目录里列出改动的文件（含未跟踪的）和差异", async () => {
    const { work, run } = setup();
    initRepo(work, { "a.txt": "one\n" });
    put(work, "a.txt", "two\n");
    put(work, "b.txt", "new\n");

    const out = await run("git_status_diff");
    expect(out.isError ?? false).toBe(false);
    const { data, body } = parsed(out);
    expect(data).toMatchObject({
      branch: "main",
      files: [
        { path: "a.txt", status: "modified", staged: false },
        { path: "b.txt", status: "untracked", staged: false },
      ],
    });
    expect(body).toContain("-one");
    expect(body).toContain("+two");
    expect(git(work, "status", "--porcelain=v1")).toContain("?? b.txt");
  });

  it("仓库路径可以是建在工作目录里的 worktree；相对路径和守卫一样相对工作目录解析，只看指定的路径", async () => {
    const { work, run } = setup();
    initRepo(work, { "a.txt": "one\n", "b.txt": "b\n" });
    git(work, "worktree", "add", "-q", "-b", "feature", "wt-1");
    put(path.join(work, "wt-1"), "a.txt", "feature\n");
    put(path.join(work, "wt-1"), "b.txt", "changed\n");

    const { data } = parsed(await run("git_status_diff", { repoPath: "wt-1", paths: ["wt-1/a.txt"] }));
    expect(data).toMatchObject({ branch: "feature", files: [{ path: "a.txt", status: "modified" }] });
    expect(data.repoPath).toBe(path.join(work, "wt-1"));
  });

  it("不是 git 仓库：按出错交回", async () => {
    const { run } = setup();
    const out = await run("git_status_diff");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/看状态失败/);
  });
});

describe("git 提交", () => {
  it("把全部改动（含新文件和删除）提交，返回提交号和提交的文件", async () => {
    const { work, run } = setup();
    initRepo(work, { "a.txt": "one\n", "gone.txt": "x\n" });
    put(work, "a.txt", "two\n");
    put(work, "src/new.ts", "export {};\n");
    fs.rmSync(path.join(work, "gone.txt"));

    const out = await run("git_commit", { message: "改 a，加 new，删 gone" });
    expect(out.isError ?? false).toBe(false);
    const { headline, data } = parsed(out);
    const commit = git(work, "rev-parse", "HEAD").trim();
    expect(data).toEqual({
      commit,
      branch: "main",
      files: [
        { path: "a.txt", status: "modified" },
        { path: "gone.txt", status: "deleted" },
        { path: "src/new.ts", status: "added" },
      ],
    });
    expect(headline).toContain(commit);
    expect(git(work, "log", "-1", "--format=%s").trim()).toBe("改 a，加 new，删 gone");
    expect(git(work, "status", "--porcelain=v1")).toBe("");
  });

  it("只提交指定的路径；其余改动留着", async () => {
    const { work, run } = setup();
    initRepo(work, { "a.txt": "one\n", "b.txt": "b\n" });
    put(work, "a.txt", "two\n");
    put(work, "b.txt", "bb\n");
    const { data } = parsed(await run("git_commit", { message: "只提交 a", paths: ["a.txt"] }));
    expect(data.files).toEqual([{ path: "a.txt", status: "modified" }]);
    expect(git(work, "status", "--porcelain=v1").trim()).toBe("M b.txt");
  });

  it("没有可提交的改动：按出错交回", async () => {
    const { work, run } = setup();
    initRepo(work);
    const out = await run("git_commit", { message: "空的" });
    expect(out).toMatchObject({ isError: true });
    expect(out.text.split("\n")[0]).toBe("没有可提交的改动");
  });

  it("提交说明原样到达，不被 shell 解释", async () => {
    const { work, run } = setup();
    initRepo(work);
    put(work, "a.txt", "x\n");
    await run("git_commit", { message: '$(touch pwned) "引号" `x` $HOME' });
    expect(git(work, "log", "-1", "--format=%s").trim()).toBe('$(touch pwned) "引号" `x` $HOME');
    expect(fs.existsSync(path.join(work, "pwned"))).toBe(false);
  });
});

describe("git 合并", () => {
  it("把指定分支（worktree 里子 agent 的分支）合并进当前分支，返回合并后的提交和改动的文件", async () => {
    const { work, run } = setup();
    initRepo(work, { "a.txt": "one\n" });
    git(work, "worktree", "add", "-q", "-b", "sub-1", "wt-sub");
    const wt = path.join(work, "wt-sub");
    put(wt, "feature.txt", "子 agent 的改动\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "子 agent 提交");
    put(work, "main.txt", "主线\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "主线提交");

    const out = await run("git_merge", { branch: "sub-1" });
    expect(out.isError ?? false).toBe(false);
    const { data } = parsed(out);
    expect(data).toMatchObject({ branch: "sub-1", into: "main", fastForward: false, files: ["feature.txt"], commit: git(work, "rev-parse", "HEAD").trim() });
    expect(fs.readFileSync(path.join(work, "feature.txt"), "utf8")).toBe("子 agent 的改动\n");
  });

  it("有冲突：中止合并，工作目录回到合并前的状态，冲突文件列在结果里，按出错交回", async () => {
    const { work, run } = setup();
    initRepo(work, { "a.txt": "one\n" });
    git(work, "checkout", "-q", "-b", "other");
    put(work, "a.txt", "other\n");
    git(work, "commit", "-q", "-am", "other 改 a");
    git(work, "checkout", "-q", "main");
    put(work, "a.txt", "main\n");
    git(work, "commit", "-q", "-am", "main 改 a");
    const before = git(work, "rev-parse", "HEAD").trim();

    const out = await run("git_merge", { branch: "other" });
    expect(out.isError).toBe(true);
    const { headline, data } = parsed(out);
    expect(headline).toMatch(/有冲突，已中止合并/);
    expect(data).toEqual({ branch: "other", into: "main", conflicts: ["a.txt"] });
    expect(git(work, "rev-parse", "HEAD").trim()).toBe(before);
    expect(git(work, "status", "--porcelain=v1")).toBe("");
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8")).toBe("main\n");
    expect(fs.existsSync(path.join(work, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("分支名不能以 - 开头（不会被当成选项）", async () => {
    const { work, tools } = setup();
    initRepo(work);
    const merge = tools.find((t) => t.spec.name === "git_merge")!;
    const out = await merge.run({ branch: "--no-verify" }, { toolCallId: "c" });
    expect(out.isError).toBe(true);
  });
});

describe("git 推送", () => {
  it("把当前分支推送到远端（临时目录里的裸仓库），返回推送的提交", async () => {
    const { work, run } = setup();
    const head = initRepo(work);
    const remote = bareRemote();
    git(work, "remote", "add", "origin", remote);

    const out = await run("git_push", { remote: "origin" });
    expect(out.isError ?? false).toBe(false);
    expect(parsed(out).data).toEqual({ remote: "origin", branch: "main", commit: head });
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(head);
  });

  it("force 一律不推；远端拒绝（不是快进）时按出错交回", async () => {
    const { work, run } = setup();
    initRepo(work);
    const remote = bareRemote();
    git(work, "remote", "add", "origin", remote);
    await run("git_push", { remote: "origin", branch: "main" });
    const pushed = git(remote, "rev-parse", "refs/heads/main").trim();

    expect(parsed(await run("git_push", { remote: "origin", force: true })).headline).toMatch(/force push 一律禁止/);
    // 改写历史后普通推送被远端拒绝，不会偷偷带上 force
    put(work, "a.txt", "x\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "--amend", "-m", "改写");
    const out = await run("git_push", { remote: "origin" });
    expect(out.isError).toBe(true);
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(pushed);
  });

  it("只收已配置的远端名：网址、本机路径、没配置的名字一律不推", async () => {
    const { work, run } = setup();
    initRepo(work);
    const remote = bareRemote();
    git(work, "remote", "add", "origin", remote);
    const stray = bareRemote();
    for (const target of ["https://example.invalid/x.git", stray, stray.replaceAll("\\", "/"), "../elsewhere.git", "upstream"]) {
      const out = await run("git_push", { remote: target });
      expect({ target, isError: out.isError, headline: parsed(out).headline }).toEqual({
        target,
        isError: true,
        headline: `远端 ${target} 没有配置（已配置的：origin）。推送只收已配置的远端名，不收网址和本机路径`,
      });
    }
    expect(git(stray, "for-each-ref").trim()).toBe("");
    expect(git(remote, "for-each-ref").trim()).toBe("");
  });

  it("联网开关关着：推送、建远端仓库、装依赖直接拒绝，说明里写着要开联网", async () => {
    const { work, run } = setup({ network: false });
    initRepo(work);
    for (const [tool, args] of [
      ["git_push", { remote: "origin" }],
      ["create_remote_repo", { name: "notes" }],
      ["install_deps", {}],
    ] as const) {
      const out = await run(tool, args);
      expect({ tool, isError: out.isError, text: out.text }).toMatchObject({ tool, isError: true, text: expect.stringMatching(/要联网.*联网开关关着/) });
    }
  });
});

describe("建远端仓库", () => {
  it("用 GitHub 命令行（测试里是假的）建仓库并加成远端 origin，返回地址", async () => {
    const dir = makeTempDir("ergou-gh-");
    const logFile = path.join(dir, "gh-calls.jsonl");
    const { work, run } = setup({ shell: { ghCommand: [process.execPath, path.join(import.meta.dirname, "../fixtures/fake-gh.mjs"), logFile, dir] } });
    initRepo(work);

    const out = await run("create_remote_repo", { name: "notes", description: "我的笔记" });
    expect(out.isError ?? false).toBe(false);
    expect(parsed(out).data).toEqual({ name: "notes", visibility: "private", url: "https://github.com/ergou-test/notes", remote: "origin" });
    const calls = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; cwd: string });
    expect(calls).toEqual([{ args: ["repo", "create", "notes", "--private", "--source=.", "--remote=origin", "--description=我的笔记"], cwd: work }]);
    expect(git(work, "remote")).toContain("origin");
  });
});

/** 一个 Node 项目：test、build 脚本跑 check.mjs，打出当前目录、是不是在 Git Bash 里起的（SHELL）、看不看得到哨兵变量、收到的参数 */
function nodeProject(dir: string, exitCode = 0): void {
  initRepo(dir, {
    "package.json": JSON.stringify({ name: "demo", version: "1.0.0", private: true, scripts: { test: "node check.mjs test", build: "node check.mjs build" } }),
    "check.mjs": [
      "const secret = Object.keys(process.env).filter((k) => /SECRET|API_KEY|TOKEN/i.test(k));",
      "console.log(JSON.stringify({ cwd: process.cwd(), shell: process.env.SHELL ?? null, secret, argv: process.argv.slice(2) }));",
      `process.exit(${exitCode});`,
    ].join("\n"),
    ".npmrc": "update-notifier=false\nfund=false\naudit=false\n",
  });
}

const reported = (body: string) => JSON.parse(body.split("\n").find((l) => l.startsWith("{"))!) as { cwd: string; shell: string | null; secret: string[]; argv: string[] };

describe("跑测试、启动构建", () => {
  it("跑 package.json 里的 test 脚本：在 Git Bash 里、以工作目录为当前目录，附加参数原样交给脚本；环境里没有密钥", async () => {
    const { work, run } = setup({ shell: { parentEnv: withEnv(process.env, tempUserProfileEnv(makeTempDir("ergou-home-")), { DEEPSEEK_API_KEY: "sk-sentinel", ERGOU_TEST_SECRET: "x" }) } });
    nodeProject(work);

    const out = await run("run_tests", { args: ["--grep", "$(touch pwned)"] });
    expect(out.isError ?? false).toBe(false);
    const { headline, data, body } = parsed(out);
    expect(headline).toBe('测试通过（npm run test -- --grep "$(touch pwned)"，退出码 0）');
    expect(data).toEqual({ command: 'npm run test -- --grep "$(touch pwned)"', exitCode: 0, passed: true });
    expect(reported(body)).toEqual({ cwd: work, shell: expect.stringMatching(/Git[\\/]usr[\\/]bin[\\/]bash\.exe$/i), secret: [], argv: ["test", "--grep", "$(touch pwned)"] });
    expect(fs.existsSync(path.join(work, "pwned"))).toBe(false);
  });

  it("退出码非零：测试没通过，按出错交回（带退出码和输出摘要）", async () => {
    const { work, run } = setup();
    nodeProject(work, 3);
    const out = await run("run_tests");
    expect(out.isError).toBe(true);
    const { headline, data } = parsed(out);
    expect(headline).toBe("测试没通过（npm run test，退出码 3）");
    expect(data).toEqual({ command: "npm run test", exitCode: 3, passed: false });
  });

  it("启动构建跑 build 脚本", async () => {
    const { work, run } = setup();
    nodeProject(work);
    const { headline, body } = parsed(await run("start_build"));
    expect(headline).toBe("构建成功（npm run build，退出码 0）");
    expect(reported(body).argv).toEqual(["build"]);
  });

  it("没有认得的项目约定：不跑任何命令，说明能跑什么", async () => {
    const { work, run } = setup();
    initRepo(work);
    const out = await run("run_tests");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/没有认得的测试约定.*package\.json/);
  });

  it("make、cargo、go 只跑约定的目标，一律不收附加参数（make 的变量会展开进配方，cargo 的 --config、go test 的 -exec 能跑任意程序）", async () => {
    const PROJECTS: [string, Record<string, string>, string[]][] = [
      ["make", { Makefile: "test:\n\t@echo ok\nbuild:\n\t@echo ok\n" }, ["SHELL=/bin/sh", "-C", "/"]],
      ["cargo", { "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n' }, ["--config", "target.x.runner='calc'"]],
      ["go", { "go.mod": "module example.com/demo\n" }, ["-exec", "calc"]],
    ];
    for (const [name, files, args] of PROJECTS) {
      const { work, run } = setup();
      initRepo(work, files);
      for (const tool of ["run_tests", "start_build"]) {
        const out = await run(tool, { args });
        expect({ name, tool, isError: out.isError, text: out.text }).toMatchObject({ name, tool, isError: true, text: expect.stringMatching(/不收附加参数/) });
      }
    }
  });
});

const PID_FILES = ["grandchild.pid", "orphan.pid"];
const pidsIn = (dir: string) => PID_FILES.map((f) => Number(fs.readFileSync(path.join(dir, f), "utf8")));
const pidsWritten = (dir: string) => PID_FILES.every((f) => fs.existsSync(path.join(dir, f)) && fs.readFileSync(path.join(dir, f), "utf8") !== "");

describe.runIf(process.platform === "win32")("超时、被中止：工具起的进程（含孙进程、孤儿）都在这次调用的 Job 里，一起结束", () => {
  const GRANDCHILD = path.join(import.meta.dirname, "../fixtures/grandchild.mjs");

  /** test 脚本起一个一直挂着的孙进程，它再留下一个父进程已经退出的孤儿 */
  function hangingProject(dir: string): string {
    const pids = makeTempDir("ergou-pids-");
    initRepo(dir, { "package.json": JSON.stringify({ name: "hang", private: true, scripts: { test: `node "${GRANDCHILD}" "${pids}"` } }) });
    return pids;
  }

  it("超过声明的超时：结束整棵进程树，按执行失败交回", async () => {
    const { work, run } = setup({ shell: { timeouts: { defaultMs: 60_000, longMs: 5_000 } } });
    const pids = hangingProject(work);
    const out = await run("run_tests");
    expect(out.isError).toBe(true);
    expect(out.text.split("\n")[0]).toMatch(/^跑测试超过 5 秒没有结束，已中止（npm run test）$/);
    expect(pidsWritten(pids)).toBe(true);
    await waitUntil(() => pidsIn(pids).every((pid) => !isProcessAlive(pid)), { describe: () => `进程还活着：${pidsIn(pids).join("、")}` });
  });

  it("这次调用被中止（agent 这一轮被中止、退出）：同样结束整棵进程树", async () => {
    const { work, tools } = setup();
    const pids = hangingProject(work);
    const controller = new AbortController();
    const running = tools.find((t) => t.spec.name === "run_tests")!.run({}, { toolCallId: "c", signal: controller.signal });
    await waitUntil(() => pidsWritten(pids), { timeoutMs: 20_000, describe: () => "等测试脚本起来" });
    controller.abort();
    const out = await running;
    expect(out.isError).toBe(true);
    expect(out.text.split("\n")[0]).toMatch(/^跑测试被中止了/);
    await waitUntil(() => pidsIn(pids).every((pid) => !isProcessAlive(pid)), { describe: () => `进程还活着：${pidsIn(pids).join("、")}` });
  });
});

describe("在工作目录里装依赖", () => {
  it("按锁文件认包管理器（测试里是 PATH 上一个假的 pnpm，不连网），注册表里的包名（带版本号或范围）原样交给它", async () => {
    const { work, run } = setup({ shell: { parentEnv: fakePackageManagerEnv() } });
    nodeProject(work);
    put(work, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const out = await run("install_deps", { packages: ["left-pad@*", "@types/node@^22.0.0", "lodash@>=4 <5"], dev: true });
    expect(out.isError ?? false).toBe(false);
    expect(parsed(out).headline).toBe('依赖装好了（pnpm add -D "left-pad@*" "@types/node@^22.0.0" "lodash@>=4 <5"，退出码 0）');
    expect(fakeArgs(parsed(out).body)).toEqual(["add", "-D", "left-pad@*", "@types/node@^22.0.0", "lodash@>=4 <5"]);
  });

  it("只收注册表里的包名：选项（全局安装、换安装位置）、本机路径、file:、link:、git 网址、绝对路径、.. 一律不收，什么都不跑", async () => {
    const { work, run } = setup({ shell: { parentEnv: fakePackageManagerEnv() } });
    nodeProject(work);
    put(work, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const BAD = [
      "-g",
      "--global",
      "--prefix=/elsewhere",
      "--location=global",
      "./vendor/tiny",
      "vendor/tiny",
      "../tiny",
      "file:vendor/tiny",
      "link:../tiny",
      "git+https://github.com/x/y.git",
      "github:x/y",
      "https://example.invalid/x.tgz",
      "C:\\tiny",
      "/abs/tiny",
      "a..b",
      "@scope/..",
    ];
    for (const bad of BAD) {
      const out = await run("install_deps", { packages: ["left-pad", bad] });
      expect({ bad, isError: out.isError, text: out.text }).toMatchObject({ bad, isError: true, text: expect.stringMatching(/只收注册表里的包名.*不能全局安装/) });
      expect(out.text).not.toMatch(/fake-pm-arg/);
    }
    expect(fs.existsSync(path.join(work, "node_modules"))).toBe(false);
  });
});

/** PATH 上排在最前面的一个假的 pnpm（bash 脚本）：把收到的参数一行一个打出来，不连网 */
function fakePackageManagerEnv(): Record<string, string | undefined> {
  const bin = makeTempDir("ergou-fake-pm-");
  fs.writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\nfor a in \"$@\"; do printf 'fake-pm-arg:[%s]\\n' \"$a\"; done\n");
  return withEnv(process.env, tempUserProfileEnv(makeTempDir("ergou-home-")), { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
}
const fakeArgs = (body: string) => [...body.matchAll(/^fake-pm-arg:\[(.*)\]$/gm)].map((m) => m[1]);

/** 工作目录里和另一个临时目录里各放一个"秘密"文件：`@文件` 被当成响应文件时，它的内容会冒出来 */
function withSecrets(work: string) {
  const elsewhere = path.join(makeTempDir("ergou-secret-"), "secret.txt");
  fs.writeFileSync(elsewhere, "TOPSECRET-ELSEWHERE\n");
  put(work, "secret.txt", "TOPSECRET-HERE\n");
  put(work, "vendor/secret", "TOPSECRET-VENDOR\n");
  return { elsewhere, special: ["*", "?", "@secret.txt", `@${elsewhere}`, "$(id)", "%PATH%", "`id`", "/x/y"] };
}
/** 文件内容、命令输出都没有冒出来 */
const noSecrets = (text: string) => expect(text).not.toMatch(/TOPSECRET|uid=/);

describe("值原样到达：不上命令行，Git Bash 不当通配符展开、不当响应文件读进来，shell 也不解释", () => {
  it("提交说明", async () => {
    const { work, run } = setup();
    initRepo(work);
    const { special } = withSecrets(work);
    for (const [i, message] of special.entries()) {
      put(work, `f${i}.txt`, String(i));
      const out = await run("git_commit", { message, paths: [`f${i}.txt`] });
      expect({ message, isError: out.isError ?? false }).toEqual({ message, isError: false });
      expect(git(work, "log", "-1", "--format=%B").replace(/\n+$/, "")).toBe(message);
    }
  });

  it("合并、推送的分支名", async () => {
    const { work, run } = setup();
    initRepo(work);
    git(work, "remote", "add", "origin", bareRemote());
    const { special } = withSecrets(work);
    for (const branch of special) {
      const merge = await run("git_merge", { branch });
      expect({ branch, isError: merge.isError }).toEqual({ branch, isError: true });
      expect(merge.text).toContain(branch);
      noSecrets(merge.text);
    }
    // 推送的分支名不收通配符和冒号（schema 挡掉），其余的原样到达 git
    for (const branch of ["@secret.txt", "$(id)", "%PATH%", "`id`"]) {
      const push = await run("git_push", { remote: "origin", branch });
      expect({ branch, isError: push.isError }).toEqual({ branch, isError: true });
      expect(push.text).toContain(`refs/heads/${branch}`);
      noSecrets(push.text);
    }
  });

  it("跑测试的附加参数", async () => {
    const { work, run } = setup();
    nodeProject(work);
    const { special } = withSecrets(work);
    const args = [...special, "a b", "a&b", "a|b", '"引号"'];
    const out = await run("run_tests", { args });
    expect(out.isError ?? false).toBe(false);
    expect(reported(parsed(out).body).argv).toEqual(["test", ...args]);
    noSecrets(parsed(out).body);
  });

  it("装依赖的包名（@scope/name 不会被当成响应文件，* 不会被展开）", async () => {
    const { work, run } = setup({ shell: { parentEnv: fakePackageManagerEnv() } });
    nodeProject(work);
    put(work, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    withSecrets(work);
    const out = await run("install_deps", { packages: ["@vendor/secret", "left-pad@*"] });
    expect(fakeArgs(parsed(out).body)).toEqual(["add", "@vendor/secret", "left-pad@*"]);
    noSecrets(out.text);
    // 别的特殊写法不是注册表里的包名：在校验时就原样被拒，什么都不跑
    for (const bad of ["?", "@secret.txt", "$(id)", "%PATH%", "`id`"]) {
      const rejected = await run("install_deps", { packages: [bad] });
      expect(rejected.text).toContain(JSON.stringify(bad));
      expect(rejected.text).not.toMatch(/fake-pm-arg|TOPSECRET/);
    }
  });
});

describe("仓库配置不能把只读的操作变成执行命令", () => {
  it("状态和差异不跑仓库配置里的 core.fsmonitor 钩子", async () => {
    const { work, run } = setup();
    initRepo(work);
    const marker = path.join(work, "fsmonitor-ran");
    const hook = path.join(work, ".git", "fsmonitor-hook");
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > '${marker.replaceAll("\\", "/")}'\nexit 1\n`);
    git(work, "config", "core.fsmonitor", hook.replaceAll("\\", "/"));
    put(work, "a.txt", "x\n");
    const out = await run("git_status_diff");
    expect(out.isError ?? false).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
