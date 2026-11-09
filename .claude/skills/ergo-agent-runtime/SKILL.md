---
name: ergo-agent-runtime
description: 给二狗（ergo）接一个新的 agent 运行时时用：让项目、任务的负责人跑在另一个 agent 程序里（比如 Codex），要写子进程入口、实现宿主协议、转消息和工具、过守卫、把记录交回二狗。改 Claude Code 运行时也用它。普通插件看 ergo-plugin。
---

# 接一个 agent 运行时

先读 `.claude/skills/ergo-dev/SKILL.md` 和 `.claude/skills/ergo-plugin/SKILL.md`。协议全文在 `packages/daemon/src/runtime/host-protocol.ts`，能力和字段的细节在 `docs/architecture/plugin-development.md` 第 7 节"运行时贡献点"，设计理由在 `docs/architecture/adr/0002-one-process-per-agent.md`、`0004-agent-host-protocol-sdk-over-stdio.md`、`0027-plugin-host-kernel-and-agent-contributions.md`。

## 是什么

运行时是负责人跑会话用的 agent 程序。pi 是内核自带的，别的各是一个插件；仓库里有两个范本：Claude Code（SDK，进程内回调）和 Codex（外部程序的 JSON-RPC，外部命令的钩子）。秘书、子 agent、评审永远是 pi。

- 每个会话一个子进程。守护进程用 `process.execPath` 拉起你的入口，名额、Job 对象、超时、闲置退出、孤儿回收都和 pi 一样。
- 子进程的 stdin / stdout 上每行一个 JSON，stderr 只是日志。
- 外部程序的词汇全部挡在子进程里。守护进程和网页只认宿主协议，不知道下面是谁。

## 照哪个写

| 要看 | 文件 |
|---|---|
| 最小的子进程，能照抄（不跑模型，只说协议） | `packages/daemon/test/fixtures/fake-runtime-child.ts` |
| 最小的运行时插件 | `packages/daemon/test/helpers/fake-runtime.ts` |
| 真实现，外部程序给了 SDK | `packages/daemon/src/claude-code/` |
| 真实现，外部程序只有命令行或 JSON-RPC | `packages/daemon/src/codex/`（为什么这么接见 `docs/architecture/adr/0046-codex-runtime-guard-and-tools.md`） |

Claude Code 的目录照搬：

| 文件 | 做什么 |
|---|---|
| `api.ts` | 插件名、运行时 id。插件目录之外只 import 它 |
| `plugin.ts` | `createClaudeCodePlugin(options)`：`contracts` 里登记运行时，外部程序的调用做成可注入的 |
| `runtime.ts` | `AgentRuntime` 和能力清单 |
| `child/main.ts` | 入口，只做接线，真的 SDK 只在这里引 |
| `child/child.ts` | 宿主协议这一层：收命令、发报告 |
| `child/session.ts` | 一个会话的轮次和外部程序的生命周期 |
| `child/translator.ts` | 外部程序的事件翻回宿主协议 |
| `child/guard.ts`、`child/host-tools.ts`、`child/context.ts` | 守卫、二狗的工具、上下文 |
| `child/records.ts` | 二狗的会话名和外部程序的会话 id 对照 |

## 步骤

### 1. 登记运行时

在 `contracts` 里 `ctx.runtimes.register(runtime)`，停用了也要认得它、写得出"X插件没启用"。类型是 `packages/daemon/src/runtime/runtimes.ts` 的 `AgentRuntime`。

- 必填：`id`（小写英文、数字、连字符，定了别改）、`title`（取值函数）、`entry`（子进程入口的绝对路径，和守护进程同扩展名，照 `CLAUDE_CODE_CHILD_ENTRY` 写）、`capabilities`。
- 按需：`models()`、`settings()`、`guardTools`（来源写 `runtime`）、`toolTimeouts`、`workFolder`、`recordedScopeReview`、`toolkitSkillCommands()`。
- **能力清单逐项照实写**，`packages/protocol/src/runtimes.ts` 的 `RUNTIME_OPERATIONS` 每一项都要有布尔值，没做的填 `false`。少一项登记时抛错。
- `take_over` 是 `true` 要给齐 `sessions`、`sessionBusy`、`forkSession`、`sessionHistory`；`remote_control` 是 `true` 要给 `remoteControl`、`currentSession`。不然登记时抛错。第一版都填 `false`。

外部组件不随二狗分发的，定义里给 `missing()`，没装时交回一句"没装什么、怎么装"。npm 依赖写成 `packages/daemon/package.json` 的 `optionalDependencies`，照 `packages/daemon/src/claude-code/sdk-installed.ts`；用本机程序的按 PATH 找，照 `packages/daemon/src/codex/install.ts`（它也先找设置 · 组件装的那份：组件清单里一条、装进组件区，ADR-0046 的补充）。

网页不用写：核心按 `GET /api/runtimes` 画新建时的选择和 ⚙，按能力清单收起按钮。要设置页才加 `settingsPages`，照 `packages/web/src/plugins/claude-code/`。

### 2. 写子进程，先跑通一轮

复制 `fake-runtime-child.ts`。分帧用 `packages/daemon/src/runtime/line-channel.ts` 的 `readJsonLines`、`encodeLine`，别用 `node:readline`（它会在 JSON 里的 U+2028 处断行）。

| 收到 | 做 | 报回 |
|---|---|---|
| `start` | 核对 `protocolVersion` 等于 `HOST_PROTOCOL_VERSION`，不等报 `start_failed` 退出；按 `session` 开或接会话；每 `heartbeatIntervalMs` 发 `heartbeat` | `ready`（`pid`、`sessionId`、`sessionFile`、`session`、`loaded`、`vision`、`model`、`context`） |
| `user_input` | 跑一轮。上一轮没完报 `errorReport("busy", …)` | `stream_delta`……`message_final`、`usage`、`turn_end` |
| `abort` | 中止手头这一轮 | `turn_end`，`outcome: "aborted"` |
| `exit` | 退出，码 0；stdin 关了也退出 | |
| 别的不支持的 | | `errorReport("unsupported", …)`，不崩 |

这一步的标准：`packages/daemon/test/main/agent-runtimes.test.ts` 的写法下，负责人经你的子进程回了话，任务自动完成。

### 3. 转消息

| 外部程序发生了 | 报什么 |
|---|---|
| 逐字输出 | `stream_delta`（`part`：`text` 或 `thinking`） |
| 一条回复完成 | `message_final`，先于这条回复里的工具调用 |
| 一次模型调用结束 | `usage`（`input` 不含缓存，`provider` 写运行时自己的名字），一次一条 |
| 工具调用开始、结束 | `tool_call_start`、`tool_call_end`；子代理里的带 `parentToolCallId` |
| 这条输入做完 | `turn_end`（`completed`、`aborted`、`error`、`yielded`）；收下的插话列在 `interjected` |
| 自己的模型、命令清单变了 | `runtime_catalog` |

- `user_input.context`、`contributions.contextBlocks`（每条输入前和每次压缩后）、`hooks`（`system_prompt_suffix`、`compaction_instructions`）经外部程序自己的钩子注入，**不拼进用户消息**。`contribution` 命令按 `id` 换文字。照 `child/context.ts`。
- 能力清单写了 `true` 的才要实现：`interject`、`compact`、`navigate_session`（撤回和切分支）、`yield`、`toolkit`（`live_toolkit`）。
- `write_handoff` 换运行时时会来。写好了回 `handoff_written` 带 `text`，写的时候出错带 `error`，那次调用的用量另报一条 `usage`（`purpose: "handoff"`）。实在写不了回 `errorReport("unsupported", …)`，守护进程马上按没写成换，不等到超时。

### 4. 转工具，全部过守卫

`forwardToolCalls` 是 `true` 时**每次**工具调用都要先过守卫，要接在外部程序能拦住全部调用的那个口子上（Claude Code 是 `PreToolUse` 钩子，它的 `canUseTool` 不是全量的）。没有一个口子全量的，就叠几个口子，按调用 id 只判一次，拦不住的也发 `guard_request`（**守护进程只给发过 `guard_request` 的调用写记录**），逐条写进 ADR 和手册（Codex：钩子、审批、事后核对，`child/guard.ts`）。

1. 报 `tool_call_start`，再报 `guard_request`（`toolName`、`args` 映射到二狗的工具名，比如 Bash → bash；原样的放 `native`）。映射写在子进程里，照 `child/guard.ts`。
2. 等同一 `requestId` 的 `guard_reply`。`allow: false` 就不执行，把 `reason` 交给模型。`allow: true` 带 `args` 时按它执行，带 `resultPrefix` 时加在结果前面。
3. 外部程序自带、二狗没有的工具登记在 `guardTools`；单次可能跑很久的写进 `toolTimeouts`。

二狗给的工具（`contributions.tools`，名字、说明、JSON Schema）**全部**交给外部程序（Claude Code 经进程内 MCP 服务，Codex 经它拉起的 stdio MCP 中转）。模型调用时过了守卫发 `host_tool_call`，等 `host_tool_result` 交回。报回的工具名换回二狗的名字：网页和超时都按它认。

外部程序要问用户的：报 `ask_user`，等 `ask_user_reply`。

工具包的 skill（`skillPaths`）复制进 `runtimeDir` 交过去，不改原件，不写外部程序的配置目录（`~/.claude`、项目的 `.claude/`）。照 `packages/daemon/src/claude-code/skill-plugin.ts`。

### 5. 记录怎么进二狗

**子进程只报，不写事件。** 守护进程收到报告后写进事件日志（`packages/daemon/src/conversation/agent-session.ts`、`agent-manager/agent-manager.ts`）：会话页、账本、撤回都从那里来。报得对，界面就对。

- 宿主协议里会话是 `sessionDir` 里的一个名字。选法照 pi：`freshSession` 还没有就新开，`session` 有就接着，`continueSession` 接最近的，都没有就新开。`ready.session` 报回用的名字。
- 外部程序的会话 id 只在 `sessionDir` 放一份小记录（`child/records.ts` 写 `<名字>.claude-session.json`）。
- **不读不改外部程序的会话文件和凭据。** 改写不了它的记录就把 `purge_rewrite` 写 `false`。

### 6. 环境和依赖

- 子进程的环境是守护进程按白名单给的。交给外部程序前去掉会改计费方式的变量（`packages/daemon/src/claude-code/claude-env.ts` 的 `STRIPPED_CLAUDE_ENV`）。
- `credentials` 经 stdin 来，是二狗自己的模型 key。用外部程序自己的登录时不用它。
- npm 依赖只在 `child/` 里引：守护进程里别的代码不 import `child/`，找包在不在只解析不加载。

### 7. 停用时

内核管（`packages/daemon/src/agent-host/runtime-gate.ts`）：用它的负责人不拉起，手头那一轮做完才停，执行中的任务转等我，启用后接着。插件不用写。

## 怎么测

不启动真的外部程序，不花额度。外部程序的调用做成可注入的。

| 测什么 | 例子 |
|---|---|
| 协议对照（假的外部程序，适配子进程是真的） | `packages/daemon/test/claude-code/adapter.contract.test.ts`，假 SDK `packages/daemon/test/helpers/fake-claude-sdk.ts`；`packages/daemon/test/codex/adapter.contract.test.ts`，假 app-server `packages/daemon/test/helpers/fake-codex-app-server.ts`（说的话按生成的 schema 校验） |
| 守卫 | `packages/daemon/test/claude-code/guard.contract.test.ts`、`packages/daemon/test/codex/guard.contract.test.ts` |
| 真实装配：登记、拉起、一轮、停用转等我、启用接着 | `packages/daemon/test/main/agent-runtimes.test.ts` |
| 换掉清单里的同名插件跑一轮，事件和 pi 跑同一个剧本一样 | `packages/daemon/test/main/claude-code-runtime.test.ts`，`packages/daemon/test/helpers/fake-claude-code.ts`、`packages/daemon/test/fixtures/fake-claude-child.ts` |
| 边界：子进程不被 import、依赖只在 `child/`、能力清单写全 | `packages/daemon/test/claude-code/boundary.test.ts`、`packages/daemon/test/codex/boundary.test.ts` |

改到协议层跑 `npm run test:contract`。协议有改动要把 `HOST_PROTOCOL_VERSION` 加一，并在文件开头记一句。

用本机程序、不随二狗分发的（Codex）：假的外部程序说的话要按它自己生成的协议校验（`packages/daemon/test/helpers/codex-schema.ts`），不然假的和真的会越走越远；生成的协议只说形状，不说行为（钩子管到哪、调用 id 对不对得上、有没有写入锁），要拿真程序连本机假模型核对：`packages/daemon/test/codex/real-codex.test.ts`（`ERGO_TEST_REAL_CODEX=1` 才跑，不花钱，升级后重跑），假的照它写；测试结果不能看这台机器装没装：`startTestDaemon` 默认把 Codex 插件换成假的（`packages/daemon/test/helpers/fake-codex.ts`），拉起真进程的 `packages/daemon/test/main/entry.test.ts` 在 PATH 前面放一个编的"npm 装好的 codex"。再接一个同样的要照做。

## 完成前检查

- [ ] ergo-plugin 的完成前检查都过了。
- [ ] `GET /api/runtimes` 列出它，能力清单和实际一致：写 `true` 的都有测试。
- [ ] 负责人跑一轮：回复、工具调用、用量都进了会话频道，和 pi 跑同一个剧本一样。
- [ ] 外部程序自带的工具和二狗给的工具都过 `guard_request`，判不放行时真的没执行。
- [ ] `write_handoff` 回了 `handoff_written`；写不了的回了 `unsupported`，换运行时不用等到超时。
- [ ] 交给外部程序的环境里没有改计费的变量；没有读写它的配置和会话目录。
- [ ] 钩子、审批拦不住的调用逐条列出来，写进 ADR 和手册，不默默接受。
- [ ] 插件停用：负责人不拉起，任务转等我，启用后接着。
- [ ] 外部组件没装时 `missing()` 说清楚，别的功能不受影响。
