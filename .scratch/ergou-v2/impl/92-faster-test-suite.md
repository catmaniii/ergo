# 92 — 全量测试提速

Status: done
Blocked by: 90、91（等它们合并，免得几处同时跑全量抢机器）
Spec: 规格 Testing Decisions；`docs/dev.md` 的测试一节

## What to build

2026-10-11 统计做票的耗时（脚本 `.scratch/ergou-v2/tools/ticket_timing.py`）：全量测试单次从最早的半分钟涨到现在 15–18 分钟（277 个测试文件、4741 条，`ERGOU_TEST_WORKERS=2`），88 张票里全量一共花了 37 小时。用户同意"找出最慢的测试文件做快"。

- 按文件量出全量测试里最慢的 20–30 个测试文件（vitest 的耗时报告），逐个看慢在哪：拉起真的守护进程 / agent 子进程、固定的等待和超时、每条用例重建数据目录、重复的启动……
- 在不降低覆盖（测的行为不变、不删用例）的前提下做快：共用启动好的东西、把固定等待换成等事件、缩短测试里的超时（可注入的就注入）、能放进更快的层测的挪下去等。
- 目标：2 个 worker 的全量从约 18 分钟降到 8 分钟以内；做不到的说明卡在哪。
- 顺带：`ERGOU_TEST_WORKERS` 开大（比如 6）时全量要能稳定跑过（用户说电脑空着时会开大）；`child-env`、`activity` 两个满负载偶尔失败的测试查清原因修掉。

## Acceptance criteria

- [x] 有改之前、改之后每个慢文件的耗时对照（写进 Comments）。
- [x] 2 个 worker 全量耗时降到 8 分钟以内，或说明卡在哪。（没降到 8 分钟：17.4 分钟，卡在哪见 Comments）
- [x] 用例条数不少于改之前，测的行为不变。
- [x] 6 个 worker 连跑两次全过；`child-env`、`activity` 不再偶发失败。
- [x] typecheck、oxlint 通过。

## Comments

- 2026-10-12 实现（分支 `worktree-agent-a4aadbcd5ca054bfd`，变基到 main `01174818`，即 93、94、95 号票合进来之后；变基没冲突）。
  - **量**（Git Bash，每次先看进程列表、量的时候盯着有没有别的工作区的 vitest）：
    - 改之前：main `461c9279`，`ERGOU_TEST_WORKERS=2 npx vitest run --reporter=dot --reporter=json --outputFile.json=…`：286 个文件、4867 条，**1128 秒（18.8 分钟）**，1 条失败（`parallel.test.ts` 的"前置阶段没验收的……"等任务完成 60 秒超时）。各文件耗时之和 2084 秒，其中主切面（`daemon/test/main`）1784 秒、pi 契约 192 秒，其余 108 秒；最慢的 30 个文件占 67%。
    - 改之后（变基后）：291 个文件、4934 条全过，**1045 秒（17.4 分钟）**，各文件耗时之和 1924 秒（多了 93–95 号票的 67 条）。
  - **慢在哪**：抽样追踪了 18 个最慢的文件（临时在 `startTestDaemon` 里记每个 agent 的拉起、就绪、回合结束，量完去掉了）：**拉起 agent 子进程到就绪平均 1.1 秒（单跑 1.35 秒），占用例时间的 65%–77%**，同一条用例里秘书、维护者（起草计划后退出、确认后再拉起）、评审、子 agent、范围审视、模型探查一个接一个地拉起，是串行等的。这 1.1–1.4 秒几乎全是子进程加载模块：一个 agent 子进程要加载 2362 个模块文件（typebox 1348 个、pi-coding-agent 223 个、pi-ai 184 个……），`node --cpu-prof` 里一大半是找文件（stat）、读 package.json、打开文件；`NODE_COMPILE_CACHE` 试过不起作用（不是编译慢）。单跑 `task-execution.test.ts`（23 条，1 个 worker）也要 130 秒，和全量里一样——不是机器挤的，是每条用例里串行的拉起。其余时间是真干活（git、bash、验收脚本）和设计好的等待（闲置退出 0.6–1.2 秒、审批挂起、"还在说的时候"慢慢吐字）。另外查到：faux 的 `tokensPerSecond` 每吐 3–5 个 token 等一次 `setTimeout`，Windows 上最短约 15.6 毫秒，速度设到约 250 以上就不再变快（`assistant-name` 的 400、`secretary-chat` 的 300 实际都是约 250），想靠调高速度缩短念上下文的用例没用（试过，撤了）。
  - **最慢的文件改前改后**（改之前是 main `461c9279`，改之后是变基后的分支；两次都是 2 个 worker 的全量，单个文件的耗时受同时在跑的另一个 worker 影响，上下浮动一两成）：

    | # | 文件 | 用例（改前） | 改之前（秒） | 改之后（秒） |
    |---|---|---|---|---|
    | 1 | `daemon/test/main/parallel.test.ts` | 12 | 129.4（含一条偶发超时 63 秒） | 64.0 |
    | 2 | `daemon/test/main/task-execution.test.ts` | 23 | 128.5 | 118.3 |
    | 3 | `daemon/test/main/work-orders.test.ts` | 15 | 75.4 | 65.6 |
    | 4 | `daemon/test/main/crash-recovery.test.ts` | 10 | 69.8 | 69.2 |
    | 5 | `daemon/test/main/toolkit.test.ts` | 17 | 61.7 | 58.2 |
    | 6 | `daemon/test/main/scheduled-jobs.test.ts` | 13 | 59.1 | 56.6 |
    | 7 | `daemon/test/main/send-voice.test.ts` | 22 | 54.4 | 49.0 |
    | 8 | `daemon/test/main/scope-review.test.ts` | 12 | 51.5 | 40.7 |
    | 9 | `daemon/test/typed-shell/tools.test.ts` | 30 | 50.6 | 46.9 |
    | 10 | `daemon/test/main/voice-reply.test.ts` | 29 | 49.6 | 48.8 |
    | 11 | `daemon/test/main/multi-project.test.ts` | 8 | 47.3 | 43.3 |
    | 12 | `daemon/test/main/projects.test.ts` | 16 | 44.5 | 39.3 |
    | 13 | `daemon/test/main/project-internal-tasks.test.ts` | 17 | 40.8 | 37.1 |
    | 14 | `daemon/test/main/model-settings.test.ts` | 8 | 39.7 | 38.1 |
    | 15 | `daemon/test/main/typed-shell.test.ts` | 5 | 35.9 | 33.4 |
    | 16 | `daemon/test/main/model-switch.test.ts` | 7 | 35.7 | 34.3 |
    | 17 | `daemon/test/main/triggers.test.ts` | 12 | 33.9 | 32.4 |
    | 18 | `daemon/test/main/deviation.test.ts` | 8 | 33.3 | 42.9（93 号票加到 10 条） |
    | 19 | `daemon/test/main/plain-tasks.test.ts` | 13 | 31.7 | 30.6 |
    | 20 | `daemon/test/main/tasks.test.ts` | 12 | 31.5 | 31.6 |
    | 21 | `daemon/test/main/voice.test.ts` | 23 | 31.0 | 31.5 |
    | 22 | `daemon/test/main/secretary-chat.test.ts` | 9 | 30.3 | 29.3 |
    | 23 | `daemon/test/main/workflow-guard.test.ts` | 8 | 29.6 | 29.0 |
    | 24 | `daemon/test/main/tool-call-detail.test.ts` | 15 | 29.1 | 28.0 |
    | 25 | `daemon/test/contract/pi-session.contract.test.ts` | 10 | 28.9 | 26.0 |

    改动直接省下的是两条"写回中途重置"（`work-orders` 15.3 → 8.6 秒，`scope-review` 11.3 → 约 4 秒）和 `parallel` 那条偶发超时；别的文件快了几秒是机器那会儿更空，不是改出来的。
  - **改了什么**（只改了测试和测试辅助，没动产品代码）：
    1. `test/helpers/process.ts` 加 `killIfRunning(child)`：测试自己拉起的子进程在结束时的兜底，只在这个 `ChildProcess` 还没报退出时按 pid 强杀（没报退出时 node 握着进程句柄，pid 不会被复用）。`entry.test.ts`、`restore-cli.test.ts`、`helpers/killable-daemon.ts` 改用它。
    2. `activity.test.ts`"任务、项目的状态变了不改写活动状态"：数活动状态事件之前先等秘书报过就绪的"休眠"。
    3. `work-orders.test.ts`、`scope-review.test.ts` 的"写回中途重置"：维护者吐字从每秒 20 调到 100、被催时那段长话从 40 句加到 200 句（"还在说"的窗口还是约 4 秒），交计划那一步（计划的 JSON 很长）不再陪着慢吐。
    4. `child-env.test.ts`：整条 `tool_call_end` 一起比（`toMatchObject({ isError: false })`，断言没放松），出错时报告里看得到 bash 的输出和结局。
    5. `docs/dev.md`：`killIfRunning` 的用法；测试一节加"测试的耗时"（worker 个数、怎么量每个文件、时间花在哪、faux 吐字速度的上限和"慢慢说"怎么写、数事件别把别的 agent 算进去）。
  - **两个偶发失败**：
    - `child-env`：失败时是 bash 那次调用 `isError: true`、没有输出可看。Git Bash 本身没问题：单独起了 11000 次（8 路、4 路并发，一次和测试一起跑），一次都没起不来；把这条用例在负载下重复 24 次也都过。查到的原因是**别的测试按复用的 pid 杀进程**：`entry.test.ts` 的 `startEntry` 在用例结束时不管守护进程是不是已经退出（被 stop 钩子杀掉、经 LSM 协议停下）都 `forceKill(child.pid)`，`restore-cli.test.ts` 自己杀掉守护进程、跑完恢复命令之后，结束时又按 pid 判活着就 `forceKill`。Windows 上 pid 退出后会很快分给别的进程（这台机器上量过：起 180–311 个进程、8–12 秒内就复用到了），`taskkill /F /T` 就把那时拿到这个 pid 的进程连树杀掉——正好是别的 worker 上的 agent 子进程或 bash 时，那边的用例就莫名其妙失败（`child-env` 在全量里总是和 `entry`、`restore-cli`、`job-object` 前后脚跑；别的工作区同时跑全量时也会被波及）。修法是上面第 1 条。没能复现那次失败本身，所以第 4 条让下次再出时看得到原因。
    - `activity`：那条用例数整个活动状态频道上的事件，秘书是常驻的、拉起好了才报一条"休眠"，满负载时这条比维护者闲置退出还晚到，被算成"任务、项目变化引起的新事件"（84 号票记的 `expected 5 to be 4`）。修法是上面第 2 条（等它报过再数，断言还是整个频道一条都不多）。
    - `parallel.test.ts` 那条（改之前的全量里失败的）：在负载下单独重复 7 次、整个文件跑 3 次都过，没复现；对话流看过，子 agent 的结果是排队的输入、不会插进维护者正在做的那一轮，剧本没有先后问题。怀疑也是被按复用的 pid 误杀（维护者或验收脚本的 bash 被杀，任务就停在那儿），没有证据。
  - **全量耗时**：2 个 worker：改之前 1128 秒（18.8 分钟）→ 变基后 1045 秒（17.4 分钟）。6 个 worker：变基前（`e92d0e02`）两次 557、605 秒，变基后两次 498、483 秒，四次都全过（变基后 291 个文件 4934 条）。6 个 worker 时每个文件都慢了约一半（拉起子进程的 CPU、读文件抢起来了），所以总时间只到 2 个 worker 的一半左右。
  - **用例条数**：4867 → 4867（变基前），变基后 4934（多的是 93–95 号票的），一条没删，断言没放松。
  - **没做到 8 分钟，卡在 agent 子进程的冷启动**：只改测试能省的只有"非拉起"的那三成里的白等，省不出一半。要到 8 分钟得让子进程起得快或者少等它，几个办法（都没做，要用户定）：
    1. **把 agent 子进程打包成一个文件再拉起**：试过用 esbuild 把 `runtime/agent-child/session.ts` 连同依赖打成一个文件（14 MB），加载 0.3 秒，原来 1.28 秒。全量里大约一千一百多次拉起，每次省约 1 秒，估算 2 个 worker 能到 8–9 分钟（线上唤起 agent 也快 1 秒）。要动产品代码（子进程入口、加一个构建步骤，或者至少给测试底座一个换入口的口子）；打包后测的就不是线上跑的那份源码了，pi 里按 `import.meta.url` 找文件、`createRequire` 的地方要一一核对。
    2. **机器空着时开 6 个 worker**：8.0–10.1 分钟（量了四次，变基后的两次 8.3、8.0 分钟）。
    3. **同一个文件里的用例并发跑**（vitest 的 concurrent）：等于多开 worker，机器负载跟着上去；底座里的 `onTestFinished`、临时目录要改成用各条用例自己的上下文。
  - **动过的产品代码**：没有。
  - **跑了几次全量**：改之前量 1 次；变基前 2 个 worker 1 次（1212 秒，那会儿另一个工作区断断续续在跑测试，数不准，没用）、6 个 worker 2 次；之后会话断了，按主会话的要求变基到 `01174818`，变基后 2 个 worker 1 次、6 个 worker 2 次；另有一次变基前的 2 个 worker 跑到一半随会话中断了。typecheck 通过，oxlint 0 个错误（7 条警告都是 main 上原有的：`chat-look`、`inbox-select`、`task-batch`、`call-mark` 四个测试文件里的）。

- 2026-10-12 完成：只改了测试和测试辅助，不动功能，没派评审。2 个 worker 全量 18.8 → 17.4 分钟，没到 8 分钟：七成时间在拉起 agent 子进程（加载约 2360 个模块文件）。要再快的两条路交给用户定：机器空着时开 6 个 worker（现在约 8 分钟）；把 agent 子进程打包成一个文件再拉起（估算 2 个 worker 能到 8–9 分钟，要动产品代码）。压缩合并进 main。
