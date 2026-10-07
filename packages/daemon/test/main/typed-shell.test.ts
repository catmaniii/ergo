// 主切面：带类型的特殊 bash 工具（规格第 9、21 节，28 号票）。真的守护进程，维护者接 faux 剧本，测试扮演前端。
// 任务 t-1 的工作目录（数据目录输出区里的 outputs/t-1）事先建成一个临时 git 仓库；远端是临时目录里的本地裸仓库，
// GitHub 命令行换成假的（fixtures/fake-gh.mjs），不碰网络。13 号票按计划装配工具包之前，维护者的工具包由测试接缝
// maintainerToolkit 给（开 bash），调用不属于任务（起草计划那一段），按对话里的处置判：推送、建远端仓库先问我。
// - 演示：看状态和差异 → 提交（做完告诉我）→ 建远端仓库（问过）→ 没跑测试就推送（退回）→ 测试没通过 → 推送仍退回 →
//   测试通过 → 推送（问过、执行）→ force push（带类型的、通用 bash 的 --force-with-lease）一律禁止 → 合并有冲突（中止，
//   回到合并前）→ 合并 → 构建 → 装依赖；效果日志、聊天里的工具调用 part、给模型的结果；录下事件流给前端状态层回放；
// - 删除或覆盖前须已提交（通用 bash 的 rm）；超时中止、进程在 Job 里、环境里没有密钥；联网开关关着；工具随 bash 开关出现。
import fs from "node:fs";
import path from "node:path";
import {
  type ApprovalCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type TurnEndEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import { listEffects } from "../../src/guard-runtime/effect-log.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import type { ShellToolkit } from "../../src/typed-shell/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { bareRemote, git, head, initRepo, put } from "../helpers/git-repo.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, inbox: INBOX } = CHANNELS;
const MAINTAINER = maintainerChannel("tm-1");
const SEGMENT = { taskId: null, agentId: "tm-1", segmentId: "tm-1:planning" } as const;
const FAKE_GH = path.join(import.meta.dirname, "../fixtures/fake-gh.mjs");
const GRANDCHILD = path.join(import.meta.dirname, "../fixtures/grandchild.mjs");
/** 一个用例里要等好几轮工具调用和审批 */
const LONG_TEST_MS = 180_000;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const TYPED_TOOLS = ["git_status_diff", "git_commit", "git_merge", "git_push", "create_remote_repo", "run_tests", "install_deps", "start_build"];

/** 一个 Node 项目：test、build 脚本跑 check.mjs（带 --fail 时退出码 1），打出当前目录、起它的 shell、看不看得到密钥类变量、参数 */
const NODE_PROJECT: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo", version: "1.0.0", private: true, scripts: { test: "node check.mjs test", build: "node check.mjs build" } }, null, 2),
  "check.mjs": [
    "const secret = Object.keys(process.env).filter((k) => /SECRET|API_KEY|TOKEN/i.test(k));",
    "console.log(JSON.stringify({ cwd: process.cwd(), shell: process.env.SHELL ?? null, secret, argv: process.argv.slice(2) }));",
    "process.exit(process.argv.includes('--fail') ? 1 : 0);",
  ].join("\n"),
  ".npmrc": "update-notifier=false\nfund=false\naudit=false\n",
  ".gitignore": "node_modules/\n",
  "README.md": "# demo\n",
  // 装依赖按锁文件认 pnpm：守护进程的 PATH 上最前面是一个假的 pnpm（fakePackageManagerDir），不连网
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
};

/** PATH 上排在最前面的一个假的 pnpm（bash 脚本）：把收到的参数一行一个打出来 */
function fakePackageManagerDir(): string {
  const bin = makeTempDir("ergou-fake-pm-");
  fs.writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\nfor a in \"$@\"; do printf 'fake-pm-arg:[%s]\\n' \"$a\"; done\n");
  return bin;
}

interface SetupOptions {
  script: FauxStep[];
  toolkit?: (maintainerId: string) => ShellToolkit;
  /** 在工作目录（还没有守护进程时）里准备仓库 */
  prepare?: (work: string) => void;
  daemon?: Omit<StartTestDaemonOptions, "maintainer" | "reuse" | "maintainerToolkit">;
}

/** 起守护进程（任务 t-1 的工作目录事先准备好），建任务，交给维护者一条输入 */
async function setup(options: SetupOptions) {
  const dataDir = makeTempDir("ergou-data-");
  const homeDir = makeTempDir("ergou-home-");
  const work = path.join(dataDirLayout(dataDir).outputs, "t-1");
  fs.mkdirSync(work, { recursive: true });
  options.prepare?.(work);
  const ghDir = makeTempDir("ergou-gh-");
  const ghLog = path.join(ghDir, "gh-calls.jsonl");
  const test = await startTestDaemon({
    secretary: [{ kind: "reply", text: "好的" }],
    maintainer: options.script,
    maintainerToolkit: options.toolkit ?? (() => ({ bash: true, network: true })),
    ghCommand: [process.execPath, FAKE_GH, ghLog, ghDir],
    ...options.daemon,
    env: { ...options.daemon?.env, PATH: `${fakePackageManagerDir()}${path.delimiter}${process.env.PATH ?? ""}` },
    reuse: { dataDir, homeDir },
  });
  const frontend = await TestFrontend.connect(test.url);
  await frontend.subscribe({ [MAINTAINER]: 0, [CARDS]: 0, [INBOX]: 0 });
  const { daemon } = test;
  daemon.tasks.startFromButton({ request: "给 demo 加一个 hello" }, "k-start");
  daemon.store.append(buildAgentNotice(MAINTAINER, "开始干活：给 demo 加一个 hello，测过再推送", "k-go", { taskId: "t-1" }).event);
  return { ...test, frontend, work: realPathOf(work)!, ghLog };
}

const toolParts = (frontend: TestFrontend): ToolCallPart[] =>
  frontend
    .events({ channel: MAINTAINER, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");
const agentTexts = (frontend: TestFrontend): string[] =>
  frontend
    .events({ channel: MAINTAINER, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .filter((m) => m.speaker === "agent")
    .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: MAINTAINER, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as TurnEndEventPayload);

/** 等维护者这一轮结束 */
const turnEnded = (frontend: TestFrontend, timeoutMs = 60_000) =>
  waitUntil(() => turnEnds(frontend).length > 0, { timeoutMs, describe: () => `等维护者这一轮结束；工具调用：${toolParts(frontend).map((p) => p.tool).join("、")}` });

/** 等到某个工具的审批卡（待处理）出来，批准它 */
async function approveWhenAsked(frontend: TestFrontend, tool: string, nth = 1): Promise<Card> {
  let card: Card | undefined;
  await waitUntil(
    () => {
      const asked = cardsOf(frontend).filter((c) => c.type === "approval" && (c.payload as ApprovalCardPayload).tool === tool && c.status === "pending");
      card = [...new Map(asked.map((c) => [c.id, c])).values()][nth - 1];
      return card !== undefined;
    },
    { timeoutMs: 60_000, describe: () => `等 ${tool} 的第 ${nth} 张审批卡；工具调用：${toolParts(frontend).map((p) => `${p.tool}:${p.outcome}`).join("、")}` },
  );
  const response = await frontend.cardAction({ cardId: card!.id, action: "approve", expectedVersion: card!.version });
  expect(response.ok).toBe(true);
  return card!;
}

/** echo_context 回显里列出的工具 */
const toolsIn = (context: string) => context.split("\n").filter((l) => l.startsWith("[tool] ")).map((l) => l.slice("[tool] ".length));

/** 工具调用 part 的要点：工具、判定、退回或硬拒绝、结果、是不是通用 bash、授权内 */
const gist = (p: ToolCallPart) => ({
  tool: p.tool,
  disposition: p.disposition,
  ...(p.blockedBy ? { blockedBy: p.blockedBy } : {}),
  outcome: p.outcome,
  genericBash: p.genericBash,
  withinGrant: p.withinGrant,
});

describe("演示：在临时 git 仓库里看状态、提交、建远端仓库、跑测试、推送、合并、构建、装依赖", () => {
  it(
    "每一步按登记的类别判定、在 Git Bash 里以工作目录为当前目录执行、结构化结果交回模型；执行成功的进效果日志；时序规则管住推送",
    async () => {
      let featureHead = "";
      const { daemon, frontend, work, ghLog } = await setup({
        prepare: (dir) => {
          initRepo(dir, NODE_PROJECT);
          git(dir, "branch", "conflicting");
          git(dir, "checkout", "-q", "-b", "feature");
          put(dir, "feature.txt", "子 agent 的改动\n");
          git(dir, "add", "-A");
          git(dir, "commit", "-q", "-m", "feature：加 feature.txt");
          featureHead = head(dir);
          git(dir, "checkout", "-q", "conflicting");
          put(dir, "README.md", "# 冲突的一边\n");
          git(dir, "commit", "-q", "-am", "conflicting：改 README");
          git(dir, "checkout", "-q", "main");
          put(dir, "README.md", "# 主线的一边\n");
          git(dir, "commit", "-q", "-am", "main：改 README");
          // 还没提交的改动
          put(dir, "hello.txt", "你好\n");
        },
        script: [
          call("git_status_diff", {}),
          call("git_commit", { message: "加上 hello.txt" }),
          call("create_remote_repo", { name: "demo", description: "演示仓库" }),
          call("git_push", { remote: "origin" }),
          call("run_tests", { args: ["--fail"] }),
          call("git_push", { remote: "origin" }),
          call("run_tests", {}),
          call("git_push", { remote: "origin" }),
          call("git_push", { remote: "origin", force: true }),
          call("bash", { command: "git push --force-with-lease origin main" }),
          call("git_merge", { branch: "conflicting" }),
          call("git_merge", { branch: "feature" }),
          call("start_build", {}),
          call("install_deps", { packages: ["left-pad@^1.3.0"] }),
          { kind: "echo_context" },
        ],
        // 守护进程的环境里有密钥类变量（LSM 注入的模型 key 这类）：工具起的进程里不该看得到
        daemon: { env: { DEEPSEEK_API_KEY: "sk-sentinel-28", ERGOU_TEST_SECRET: "sentinel-28" } },
      });

      // 建远端仓库、推送都是"以我的名义对外发送或发布"：对话里先问我
      await approveWhenAsked(frontend, "create_remote_repo");
      const pushCard = await approveWhenAsked(frontend, "git_push");
      expect(pushCard.payload).toMatchObject({ tool: "git_push", toolTitle: "git 推送", categoryTitles: ["以我的名义对外发送或发布"] });
      await turnEnded(frontend, 120_000);
      expect(turnEnds(frontend)).toEqual([expect.objectContaining({ outcome: "completed" })]);

      // 聊天里的工具调用 part：工具名、判定，不标通用 bash（bash 里那一条才标）
      const parts = toolParts(frontend);
      expect(parts.map(gist)).toEqual([
        { tool: "git_status_diff", disposition: "do", outcome: "done", genericBash: false, withinGrant: false },
        { tool: "git_commit", disposition: "do_then_tell", outcome: "done", genericBash: false, withinGrant: false },
        { tool: "create_remote_repo", disposition: "ask_first", outcome: "done", genericBash: false, withinGrant: false },
        { tool: "git_push", disposition: "ask_first", blockedBy: "pull_back", outcome: "blocked", genericBash: false, withinGrant: false },
        { tool: "run_tests", disposition: "do", outcome: "error", genericBash: false, withinGrant: false },
        { tool: "git_push", disposition: "ask_first", blockedBy: "pull_back", outcome: "blocked", genericBash: false, withinGrant: false },
        { tool: "run_tests", disposition: "do", outcome: "done", genericBash: false, withinGrant: false },
        { tool: "git_push", disposition: "ask_first", outcome: "done", genericBash: false, withinGrant: false },
        { tool: "git_push", disposition: "never", outcome: "blocked", genericBash: false, withinGrant: false },
        { tool: "bash", disposition: "never", outcome: "blocked", genericBash: true, withinGrant: false },
        { tool: "git_merge", disposition: "do_then_tell", outcome: "error", genericBash: false, withinGrant: false },
        { tool: "git_merge", disposition: "do_then_tell", outcome: "done", genericBash: false, withinGrant: false },
        { tool: "start_build", disposition: "do", outcome: "done", genericBash: false, withinGrant: false },
        { tool: "install_deps", disposition: "do_then_tell", outcome: "done", genericBash: false, withinGrant: false },
      ]);
      expect(parts[1]!.argsSummary).toBe("message=加上 hello.txt");
      expect(parts[2]!.categoryTitles).toEqual(["以我的名义对外发送或发布"]);

      // 真的做了：提交、建远端（假的 gh 在工作目录里跑）、推送到远端、合并
      const committed = git(work, "rev-parse", "HEAD~1").trim();
      expect(git(work, "show", "--name-only", "--format=%s", committed).trim().split("\n")).toEqual(["加上 hello.txt", "", "hello.txt"]);
      const ghCalls = fs.readFileSync(ghLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; cwd: string });
      expect(ghCalls).toEqual([{ args: ["repo", "create", "demo", "--private", "--source=.", "--remote=origin", "--description=演示仓库"], cwd: work }]);
      const remote = git(work, "remote", "get-url", "origin").trim();
      expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(committed);
      expect(git(work, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toEqual([head(work), committed, featureHead]);
      expect(fs.readFileSync(path.join(work, "README.md"), "utf8")).toBe("# 主线的一边\n");

      // 效果日志：只有执行成功的（退回、禁止、测试没通过、合并有冲突的都不在），参数是规范化的，效果摘要记下提交号、文件、测试通过
      const effects = listEffects(daemon.store.reader, SEGMENT);
      expect(effects.map((e) => e.tool)).toEqual(["git_status_diff", "git_commit", "create_remote_repo", "run_tests", "git_push", "git_merge", "start_build", "install_deps"]);
      expect(effects[1]!.args).toEqual({ message: "加上 hello.txt", repoPath: work });
      expect(effects[1]!.summary).toContain(committed);
      expect(effects[1]!.summary).toContain("hello.txt");
      expect(effects[3]!.summary).toContain("测试通过");
      expect(effects[4]!.args).toMatchObject({ remote: "origin", repoPath: work, headCommit: committed });
      expect(effects.every((e) => e.agentId === "tm-1" && e.segmentId === "tm-1:planning")).toBe(true);

      // 模型看到的：结构化结果、退回的说明、一律禁止的说明、冲突文件
      const context = agentTexts(frontend).at(-1)!;
      const results = context.split("\n[").filter((l) => l.startsWith("toolResult]"));
      expect(results).toHaveLength(14);
      expect(results[0]).toMatch(/^toolResult\] git_status_diff: 分支 main 上有 1 个文件有改动：hello\.txt\n\{"repoPath":.*"files":\[\{"path":"hello\.txt","status":"untracked","staged":false\}\]/);
      expect(results[1]).toContain(`已提交 ${committed}（1 个文件：hello.txt）`);
      expect(results[3]).toMatch(/退回：.*push 之前必须跑过测试/);
      expect(results[4]).toMatch(/测试没通过（npm run test -- --fail，退出码 1）/);
      expect(results[5]).toMatch(/push 之前必须跑过测试/);
      expect(results[6]).toMatch(/测试通过（npm run test，退出码 0）/);
      // 在 Git Bash 里、以工作目录为当前目录；环境里看不到密钥类变量（守护进程的环境里放了哨兵）
      const reported = JSON.parse(results[6]!.split("\n").find((l) => l.startsWith('{"cwd"'))!) as { cwd: string; shell: string; secret: string[]; argv: string[] };
      expect(reported).toEqual({ cwd: work, shell: expect.stringMatching(/Git[\\/]usr[\\/]bin[\\/]bash\.exe$/i), secret: [], argv: ["test"] });
      expect(results[7]).toContain(`已推送 main 到 origin（${committed}）`);
      expect(results[8]).toMatch(/force push 和项目外的 rm -rf 一律禁止/);
      expect(results[9]).toMatch(/force push 和项目外的 rm -rf 一律禁止/);
      expect(results[10]).toMatch(/合并 conflicting 有冲突，已中止合并，工作目录回到了合并前的状态（1 个冲突文件：README\.md）/);
      expect(results[11]).toMatch(/已把 feature 合并进 main/);
      expect(results[12]).toMatch(/构建成功（npm run build，退出码 0）/);
      // 装依赖：包名原样交给项目的包管理器（测试里是 PATH 上一个假的 pnpm）
      expect(results[13]).toContain('依赖装好了（pnpm add "left-pad@^1.3.0"，退出码 0）');
      expect(results[13]).toContain("fake-pm-arg:[left-pad@^1.3.0]");

      saveOrCheckRecording("typed-shell-tools", frontend.recording, { perChannel: true });
    },
    LONG_TEST_MS,
  );
});

describe("时序规则和通用 bash 一致", () => {
  it(
    "工作目录里有未提交改动的文件：通用 bash 删除它被退回（删除或覆盖前须已提交）；用 git 提交之后不再退回（对话里删除照常先问）",
    async () => {
      const { daemon, frontend, work } = await setup({
        prepare: (dir) => {
          initRepo(dir, { "notes.txt": "旧的\n" });
          put(dir, "notes.txt", "改了还没提交\n");
        },
        script: [call("bash", { command: "rm notes.txt" }), call("git_commit", { message: "先提交" }), call("bash", { command: "rm notes.txt" }), { kind: "reply", text: "删掉了" }],
      });
      await approveWhenAsked(frontend, "bash");
      await turnEnded(frontend);
      expect(toolParts(frontend).map(gist)).toEqual([
        { tool: "bash", disposition: "ask_first", blockedBy: "pull_back", outcome: "blocked", genericBash: true, withinGrant: false },
        { tool: "git_commit", disposition: "do_then_tell", outcome: "done", genericBash: false, withinGrant: false },
        { tool: "bash", disposition: "ask_first", outcome: "done", genericBash: true, withinGrant: false },
      ]);
      expect(toolParts(frontend)[0]!.resultSummary).toMatch(/还没有 git 提交/);
      expect(fs.existsSync(path.join(work, "notes.txt"))).toBe(false);
      expect(git(work, "show", "HEAD:notes.txt")).toBe("改了还没提交\n");
      expect(listEffects(daemon.store.reader, SEGMENT).map((e) => e.tool)).toEqual(["git_commit", "delete"]);
    },
    LONG_TEST_MS,
  );
});

describe("执行失败、超时、进程和环境", () => {
  it.runIf(process.platform === "win32")(
    "单次调用超过声明的超时（可配置）：管家中止这一轮，工具起的进程（孙进程、孤儿）随这次调用的 Job 一起结束；算执行失败，不进效果日志",
    async () => {
      const pids = makeTempDir("ergou-pids-");
      const { daemon, frontend } = await setup({
        prepare: (dir) => initRepo(dir, { "package.json": JSON.stringify({ name: "hang", private: true, scripts: { test: `node "${GRANDCHILD}" "${pids}"` } }) }),
        script: [call("run_tests", {}), { kind: "reply", text: "不该到这里" }],
        // 12 秒：机器忙的时候 npm、node 和孙进程起来也要好几秒，先让它们都起来、写下 pid
        daemon: { config: { shellTools: { longCallMinutes: 0.2 } } },
      });
      await turnEnded(frontend);
      expect(turnEnds(frontend)).toEqual([expect.objectContaining({ outcome: "error", error: expect.stringMatching(/工具 run_tests 的调用超过 12 秒没有结束，已中止/) })]);
      expect(toolParts(frontend).map(gist)).toEqual([{ tool: "run_tests", disposition: "do", outcome: "error", genericBash: false, withinGrant: false }]);
      expect(listEffects(daemon.store.reader, SEGMENT)).toEqual([]);
      const written = ["grandchild.pid", "orphan.pid"].map((f) => path.join(pids, f));
      expect(written.every((f) => fs.existsSync(f))).toBe(true);
      const pidList = written.map((f) => Number(fs.readFileSync(f, "utf8")));
      // 管家中止这一轮 → 子进程结束这次调用 → 守护进程这边的调用被中止、关掉它的 Job：马上就结束（工具自己的兜底计时还要再等 5 秒）
      await waitUntil(() => pidList.every((pid) => !isProcessAlive(pid)), { timeoutMs: 2_000, describe: () => `工具起的进程还活着：${pidList.join("、")}` });
    },
    LONG_TEST_MS,
  );

  it(
    "联网开关关着：推送、建远端仓库、装依赖直接拒绝，说明里写明要开联网；状态和差异、提交、跑测试照常",
    async () => {
      const { frontend, work } = await setup({
        toolkit: () => ({ bash: true, network: false }),
        prepare: (dir) => {
          initRepo(dir, NODE_PROJECT);
          git(dir, "remote", "add", "origin", bareRemote());
        },
        script: [
          call("git_push", { remote: "origin" }),
          call("create_remote_repo", { name: "demo" }),
          call("install_deps", {}),
          call("run_tests", {}),
          { kind: "echo_context" },
        ],
      });
      await turnEnded(frontend);
      expect(toolParts(frontend).map(gist)).toEqual([
        { tool: "git_push", disposition: "ask_first", blockedBy: "hard_refusal", outcome: "blocked", genericBash: false, withinGrant: false },
        { tool: "create_remote_repo", disposition: "ask_first", blockedBy: "hard_refusal", outcome: "blocked", genericBash: false, withinGrant: false },
        { tool: "install_deps", disposition: "do_then_tell", blockedBy: "hard_refusal", outcome: "blocked", genericBash: false, withinGrant: false },
        { tool: "run_tests", disposition: "do", outcome: "done", genericBash: false, withinGrant: false },
      ]);
      const context = agentTexts(frontend).at(-1)!;
      for (const tool of ["git_push", "create_remote_repo", "install_deps"]) expect(context).toMatch(new RegExp(`\\[toolResult\\] ${tool}: .*要联网，但工具包的联网开关关着.*开联网`));
      expect(fs.existsSync(path.join(work, "node_modules"))).toBe(false);
    },
    LONG_TEST_MS,
  );

  it(
    "这些工具随工具包的 bash 开关出现：开了 bash 的维护者有 bash 和八个工具，没开的（起草计划时）一个都没有；秘书的固定工具里没有它们",
    async () => {
      const { daemon, frontend, url } = await setup({
        toolkit: (id) => ({ bash: id === "tm-1", network: false }),
        prepare: (dir) => initRepo(dir),
        script: [{ kind: "echo_context" }],
        daemon: { secretary: [{ kind: "echo_context" }] },
      });
      await turnEnded(frontend);
      const withBash = toolsIn(agentTexts(frontend).at(-1)!);
      expect(withBash).toEqual(expect.arrayContaining(["bash", "submit_plan", ...TYPED_TOOLS]));

      // 第二个任务的维护者：工具包没开 bash
      daemon.tasks.startFromButton({ request: "另一个任务" }, "k-start-2");
      const other = maintainerChannel("tm-2");
      const watcher = await TestFrontend.connect(url);
      await watcher.subscribe({ [other]: 0, [CHANNELS.secretary]: 0 });
      daemon.store.append(buildAgentNotice(other, "看看你有什么工具", "k-go-2", { taskId: "t-2" }).event);
      await waitUntil(() => watcher.events({ channel: other, type: EVENT_TYPES.turnEnd }).length > 0, { timeoutMs: 30_000, describe: () => "等第二个维护者" });
      const planning = watcher
        .events({ channel: other, type: EVENT_TYPES.message })
        .map((f) => (f.payload as MessageEventPayload).message)
        .filter((m) => m.speaker === "agent")
        .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
        .at(-1)!;
      expect(toolsIn(planning).toSorted()).toEqual(["ls", "read", "submit_plan"]);

      // 秘书：有 bash（草稿区里干活），没有带类型的 bash 工具
      await waitUntil(() => watcher.events({ channel: CHANNELS.secretary, type: EVENT_TYPES.turnEnd }).length > 0, { timeoutMs: 30_000, describe: () => "等秘书" });
      const secretary = watcher
        .events({ channel: CHANNELS.secretary, type: EVENT_TYPES.message })
        .map((f) => (f.payload as MessageEventPayload).message)
        .filter((m) => m.speaker === "agent")
        .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
        .at(-1)!;
      const secretaryTools = toolsIn(secretary);
      expect(secretaryTools).toContain("bash");
      expect(secretaryTools.filter((t) => TYPED_TOOLS.includes(t))).toEqual([]);
    },
    LONG_TEST_MS,
  );
});
