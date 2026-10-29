# 外部程序接管本机 Claude Code 会话：调研笔记（给二狗做方案依据）

调研日期：2026-10-25。

**本机环境**
- `claude --version` → `2.1.310 (Claude Code)`，装在 `C:\Users\<用户名>\.local\bin\claude.exe`
- `claude auth status --text` → `Login method: Claude Max account`
- `npm view @anthropic-ai/claude-agent-sdk` → 最新 `0.3.310`。它的 package.json 里写着 `"claudeCodeVersion": "2.1.310"`，也就是 SDK 自带的 claude 内核和本机版本一样
- `codex --version` → `codex-cli 0.104.0`；`npm view @openai/codex version` → `0.164.0`。本机落后 60 个小版本

**怎么查的**
- 只跑了 `--help`、`--version`、`auth status`、`npm view`，没有开任何 Claude Code 或 Codex 会话。
- 另外离线跑了一次 `codex app-server generate-json-schema --out <草稿目录>` 导出协议 schema。这个命令不开会话、不联网。
- 本机会话文件只列了目录名、文件名，并统计了每类记录有哪些字段名，没有读对话内容。
- 官方文档、SDK 类型定义、CHANGELOG 都下载到了草稿目录，方便复核：
  - `…\scratchpad\cc-takeover\dl-docs\`：Claude Code 和 SDK 文档、两份 CHANGELOG、条款
  - `…\scratchpad\cc-takeover\dl-sdk\`：SDK 0.3.310 的 `sdk.d.ts`、`bridge.d.ts`、README
  - `…\scratchpad\cc-takeover\dl-codex\`：Codex 文档
  - `…\scratchpad\cc-takeover\codex-0104-schema\`：本机 Codex 0.104 的 app-server 协议 schema

---

## 0. 先给结论（每个问题一句话）

1. **列会话**：官方有不开会话就能列的接口。
   - SDK 的 `listSessions()` / `getSessionInfo()` / `getSessionMessages()` / `listSubagents()` / `getSubagentMessages()` 直接读本机文件，不起进程、不花额度。
   - 正在跑的会话用 `claude agents --json` 查，这是官方说的"从外部读会话状态的受支持方式"。
   - 会话文件的格式官方明说是内部格式、每个版本都可能变，不要自己解析。
2. **恢复和驱动**：两条路都官方支持。
   - 命令行：`-p --resume/--continue/--fork-session/--session-id`，加上 `--input-format stream-json --output-format stream-json` 可以双向多轮。
   - SDK：`query({prompt: 异步迭代器, options:{resume, forkSession, continue, cwd, canUseTool, hooks…}})`，再加 `interrupt()`、`setPermissionMode()`、`setModel()` 等控制方法。
   - 会话 ID 从第一条 `system/init` 消息或 `result` 消息拿；新建时也可以自己指定 UUID。
   - 按 ID 恢复可以在任何目录发起（会跨项目查找），但建议传会话原来的 cwd。
3. **并发**：
   - 普通恢复**没有锁**：同一会话在两个进程里不分叉地恢复，两边的消息会交错写进同一份记录。
   - 只有"后台会话"（agent view 管的）会拒绝第二个写入者，或者自动另开一份拷贝。
   - 二狗必须自己保证"一个会话同时只有一个写入进程"。
4. **Remote Control**：
   - 要求订阅账号登录（本机是 Max，符合），API key 不行。
   - 只有交互式会话能开：`claude remote-control` 服务器模式、`claude --remote-control`、会话里敲 `/remote-control`。
   - `-p` 和 SDK 驱动的会话**没有文档化的开法**。SDK 里只有一个没写进文档的 alpha 接口 `@anthropic-ai/claude-agent-sdk/bridge`，要调用方自己提供 claude.ai 的 OAuth token，和条款冲突，不建议用。
   - 交互式会话开了 RC 之后，本地终端和手机可以同时驱动。但外部程序拿不到 RC 那一侧的事件流，只能在本机用 hooks 或读记录文件旁听。
5. **认证和计费**：
   - SDK 和 `-p` 默认用本机 `/login` 的订阅登录，所以本机会走 Max 额度。
   - 但如果环境里有 `ANTHROPIC_API_KEY`，`-p` 会无条件改用 API key 按量计费。
   - 官方帮助中心 2026-10-07 写明："You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits"。
   - 条款的红线是：不得替别人代用订阅、不得收集或转手 claude.ai 的凭据和 token、不得改 claude 程序本身。二狗是自用、跑原版 claude、用本人登录，在允许范围内。
6. **Codex（第二期）**：
   - 接法：`codex app-server`（JSON-RPC，stdio）有 `thread/list/start/resume/fork`、`turn/start/steer/interrupt`，审批是服务端主动发给客户端的请求，模型和二狗的事件很对得上。
   - 最新版已经删掉 `codex mcp-server`。
   - 远程只能通过 ChatGPT 桌面 App 当宿主，CLI 拉起的会话没有 Remote Control 的对应物。
   - 工作量估计和 Claude 适配器同一个量级（中等），先要把 Codex 升到最新并锁定版本。
7. **推荐**：
   - 平时用 **Agent SDK（TypeScript）在守护进程里承载会话**，能力最全、最稳。
   - 需要官方 App 或网页接着看时，做"交接"：二狗先停掉自己的 SDK 进程，再拉起带 `--remote-control` 的交互式（或后台）会话，同一时刻只有一个写入者。
   - 用 pty 驱动交互界面太脆，只在"必须让二狗和官方 App 同时操作同一个活会话"时才用。
   - 命令行 stream-json 和 SDK 是同一套协议，但审批、打断这些控制协议没有对外文档，二狗是 Node 写的，没理由不用 SDK。

---

## 1. 列会话

### 1.1 官方接口（不开会话）

| 需求 | 接口 | 说明 | 出处 |
|---|---|---|---|
| 列历史会话 | `listSessions({dir?, limit?, offset?, includeWorktrees?, includeProgrammatic?})` | 返回 `SDKSessionInfo[]`：`sessionId`、`summary`（自定义标题 → 自动摘要 → 首条提问，按这个顺序取）、`lastModified`、`fileSize`、`customTitle`、`firstPrompt`、`gitBranch`、`cwd`、`tag`、`createdAt`。不传 `dir` 就列本机所有项目。`includeProgrammatic` 默认 true（会把 `-p`/SDK 起的会话也列出来，终端的 `/resume` 列表不显示这些） | `sdk.d.ts` 第 1124 行起；[TS 参考 listSessions](https://code.claude.com/docs/en/agent-sdk/typescript#listsessions) |
| 单个会话的元信息 | `getSessionInfo(id, {dir?})` | 只读一个文件；子代理（sidechain）会话返回 undefined | `sdk.d.ts` 第 890 行 |
| 读对话内容 | `getSessionMessages(id, {dir?, limit?, offset?, includeSystemMessages?})` | 按 `parentUuid` 链重建对话，返回 user/assistant（可选带 system，比如压缩边界） | `sdk.d.ts` 第 920 行 |
| 子代理 | `listSubagents(id)` / `getSubagentMessages(id, agentId)` | 子代理记录在 `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl` | `sdk.d.ts` 第 1179、957 行 |
| 改名、打标签、删除、分叉 | `renameSession` / `tagSession` / `deleteSession` / `forkSession(id,{upToMessageId?, title?})` | 分叉会把记录复制到新文件，全部消息换新 UUID，可以截到某条消息为止；不复制撤销历史 | `sdk.d.ts` 第 690、856 行 |
| 正在跑的会话 | `claude agents --json [--all] [--cwd <path>]` | 列出所有活着的会话，交互式和后台都有。字段：`cwd`、`kind`（interactive/background）、`startedAt`、`pid`、`status`（busy/waiting/idle）、`waitingFor`（permission prompt / input needed …）、`sessionId`、`name`；后台会话另有 `id`、`state`（working/blocked/done/failed/stopped）。官方原话："`claude agents --json` is the supported way to read session state from outside Claude Code" | 本机 `claude agents --help`；[agent-view：List sessions as JSON](https://code.claude.com/docs/en/agent-view#list-sessions-as-json) |
| 命令行 | 没有"只列历史会话"的子命令。`claude --resume` 不带 ID 会打开交互式选择器 | | 本机 `claude --help` |

说明：
- `/core` 入口把列、读、分叉会话这几个函数去掉了，要用就从根入口 `@anthropic-ai/claude-agent-sdk` 导入（SDK README）。
- 这些函数读写的是本机文件，不起 Claude 进程，不花额度。依据是 `deleteSession` 注释里写的 "Without sessionStore: removes `{sessionId}.jsonl`…"。
- `claude agents --json` 我**没在本机跑**。原因是 agent view 第一次打开时可能顺手拉起后台 supervisor，这次的规矩是不碰运行状态。

### 1.2 会话文件格式要点

**官方说法**（[sessions：Where transcripts are stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)）
- 位置：`~/.claude/projects/<project>/<session-id>.jsonl`。`<project>` 是工作目录里所有非字母数字字符换成 `-` 的结果，超过 200 字符就截断再加哈希。
- 可以改：`CLAUDE_CONFIG_DIR` 换根目录，`CLAUDE_CODE_PROJECT_DIR_NAME` 自己起项目目录名。
- 默认保留 30 天（`cleanupPeriodDays` 可改）。
- 官方原话："The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release."
- 本机的目录编码对得上：`D:\code\ergo` → `D--code-ergo`，WSL 路径编码成 `--wsl-localhost-Ubuntu-…`。
- **注意编码会撞名**：路径里只差 `_`、`-`、`.` 的两个目录会编到同一个名字（CHANGELOG 里有条修复："Fixed `claude -c`/resume picking up sessions from a different directory whose path differed only by characters like `_`, `-`, or `.`"）。所以**不要从目录名反推 cwd**，要用记录里的 `cwd` 字段或 `listSessions` 返回的 `cwd`。

**本机实际看到的结构**（只看了名字和字段）
- `<session-id>.jsonl` 是主记录。
- `<session-id>/subagents/agent-<id>.jsonl` 加 `agent-<id>.meta.json` 是子代理；meta 的字段有 `agentType`、`description`、`toolUseId`、`spawnDepth`、`requestNonInteractive`、`requestShape`。
- `<session-id>/tool-results/*.txt` 是工具输出太长时溢出存放的地方。
- `<session-id>/custom-title.json`（字段 `customTitle`）。
- 二狗当前这个会话的主文件已经 252 MB，长会话的文件会很大，读的时候要流式读或者分页（用 `getSessionMessages` 的 `limit/offset`）。

**每行记录的种类**（统计了几份文件的 `type/subtype` 和字段名）

| 类别 | 记录（`type` / `subtype`） | 要点 |
|---|---|---|
| 消息 | `user`、`assistant`、`attachment` | 都带 `uuid`、`parentUuid`（串成树，回退和分叉在这里分叉）、`sessionId`、`cwd`、`gitBranch`、`version`、`entrypoint`（cli / sdk-ts / sdk-cli 等，`listSessions` 靠它判断是不是程序起的会话）、`timestamp`、`isSidechain`、`userType`。工具调用和结果在 `message.content` 里的 tool_use / tool_result 块中 |
| 第一行 | 不一定是用户消息 | 本机样本的头几行是 `mode`、`permission-mode`、`atis-latch`、`file-history-snapshot`，之后才是第一条 `user`。**不要假定第一行是首条提问** |
| 标题 | `custom-title`（customTitle）、`ai-title`（aiTitle）、`agent-name` | SDK 的 `foldSessionSummary` 注释说得清楚：`isSidechain`、`createdAt`、`cwd`、`firstPrompt` 第一次出现就定下；`customTitle`、`aiTitle`、`lastPrompt`、`summaryHint`、`gitBranch`、`tag` 以最后一次为准（`sdk.d.ts` 第 838 行起） |
| 压缩 | `system/compact_boundary` | 带 `compactMetadata`、`logicalParentUuid`。恢复时从最后一次压缩的摘要开始接（[sessions：What a resumed session restores](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores)） |
| 回退、撤销 | `file-history-snapshot`、`file-history-delta` | 文件检查点 |
| Remote Control | `bridge-session`（`bridgeSessionId`、`lastSequenceNum`、`ownerAccountUuid`、`ownerOrganizationUuid`）、`system/bridge_status`（`url`） | 记录里存了 RC 会话号，所以 `claude --resume` 能重新接回同一个 RC 会话 |
| 其他 | `last-prompt`（leafUuid）、`queue-operation`（排队输入）、`cost-state`（费用累计）、`continued-in`（continuedInSessionId，看名字是"在另一个会话里继续"的指针，**具体含义文档没写**）、`system/turn_duration`、`system/local_command`、`system/informational`、`system/stop_hook_summary`、`system/scheduled_task_fire`、`system/model_refusal_fallback` 等 | |
| 分叉 | | `forkSession()` 和 `--fork-session` 生成新文件、新 ID，原记录不动（`sdk.d.ts` 第 856 行；[sessions：Branch a session](https://code.claude.com/docs/en/sessions#branch-a-session)） |

**活会话登记表**：`~/.claude/sessions/<pid>.json`，本机看到 4 个。字段有 `pid`、`sessionId`、`cwd`、`kind`、`status`、`name`、`bridgeSessionId`、`messagingSocketPath`、`entrypoint`、`version`、`startedAt`、`updatedAt` 等，旁边还有 `<pid>.<hash>.key` 文件。这些**没写进文档**，属于内部实现，要用请走 `claude agents --json`。

---

## 2. 恢复和驱动

### 2.1 命令行参数（以本机 `claude --help` 为准）

| 参数 | 本机 help 原文要点 | 补充（文档） |
|---|---|---|
| `-r, --resume [value]` | 按会话 ID 或名字恢复；不给值就打开选择器 | 也可以传 `.jsonl` 的绝对路径。按 ID 找时先找当前项目和它的 worktree，再找本机所有项目；只有一份时才认，重复的拷贝会报找不到（2.1.223 起）（[cli-reference](https://code.claude.com/docs/en/cli-reference)、[sessions](https://code.claude.com/docs/en/sessions#resume-by-session-id-or-name)） |
| `-c, --continue` | 接着当前目录最近一次对话 | 交互模式下会跳过 `-p` 和 SDK 起的会话；`claude -p --continue` 会把它们算进去（[sessions](https://code.claude.com/docs/en/sessions#loop-p-agent-sdk-and-background-sessions)） |
| `--fork-session` | 恢复时换一个新会话 ID（配合 `--resume` 或 `--continue`） | 分叉出的新进程不继承"本会话内允许"的授权 |
| `--session-id <uuid>` | 用指定的 UUID | 新建时二狗可以先定好 ID。SDK 里同名选项和 resume/continue 合用时必须同时开 `forkSession`（`sdk.d.ts` Options.sessionId） |
| `-p, --print` | 非交互输出后退出；**会跳过工作区信任对话框**；设置文件校验失败时不报错、直接忽略 | |
| `--input-format stream-json` | 只能配 `-p`，实时流式输入 | 一个进程里多轮对话 |
| `--output-format stream-json` | 只能配 `-p`，实时流式输出 | 文档示例都加了 `--verbose`；要逐字输出再加 `--include-partial-messages`；要钩子事件加 `--include-hook-events`；要子代理正文加 `--forward-subagent-text`；要回显用户消息加 `--replay-user-messages` |
| `--permission-mode` | 可选值 acceptEdits、auto、bypassPermissions、manual、dontAsk、plan | 2.1.302 起 `-p` 和 SDK 不设权限模式时从 Manual（即 `default`）开始，需要审批的调用除非有规则、钩子、`canUseTool` 或 `--permission-prompt-tool` 放行，否则一律拒绝（[permission-modes](https://code.claude.com/docs/en/permission-modes#tool-calls-denied-in-claude--p-and-agent-sdk-runs)） |
| `--permission-prompt-tool` | | 指定一个 MCP 工具（`mcp__<server>__<tool>`）来回答审批，是**命令行下唯一有文档的外部审批通道**（[cli-reference](https://code.claude.com/docs/en/cli-reference)） |
| `--permission-prompts host\|none` | `-p` 下审批由谁回答：host（SDK 宿主或 prompt-tool）/ none（全部自动拒绝） | 2.1.259 起 |
| `--allowedTools` / `--disallowedTools` | 权限规则语法，比如 `Bash(git *)` | |
| `--mcp-config` / `--strict-mcp-config` | 加载 MCP 配置 | **恢复时不会自动带上**，要重新传（[sessions](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores)） |
| `--append-system-prompt` / `--system-prompt` | | **坑**：系统提示在第一次请求时录下来，之后恢复都沿用录下的版本，直到压缩为止。所以接管已有会话时二狗追加的系统提示**压缩前不生效**，除非加 `--system-prompt-snapshot off`（[cli-reference：System prompt flags in resumed conversations](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations)） |
| `--bg` | 后台启动，打印短 ID。配 `--resume <id>` 时：原会话没在跑就在后台用同一个 ID 接着；正在跑就另开一份拷贝 | 不能和 `-p` 合用（[agent-view](https://code.claude.com/docs/en/agent-view#dispatch-an-agent-from-your-shell)） |
| `--remote-control [name]` | "Start an **interactive** session with Remote Control enabled" | 见第 4 节 |
| `-n, --name` | 会话显示名 | |
| `--no-session-persistence` | 不落盘，只能配 `-p` | |

另外两点：
- **恢复后的权限模式**：`claude -p --resume` 按"新的 `-p` 运行"的规则选权限模式，不恢复原来的模式；只有一种例外是原会话停在计划模式，满足条件时会回到计划模式（[sessions：Permission mode on resume](https://code.claude.com/docs/en/sessions#permission-mode-on-resume)）。
- **退出**：用 SIGTERM 停 `-p` 进程，正在进行的那一轮作废、不记结果；想正常结束一轮，先发 SIGINT 或者调 SDK 的 `interrupt()`（[headless：Stop a run with SIGTERM](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm)）。

### 2.2 Agent SDK（TypeScript）

**入口**
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` 返回 `Query`，它本身是 `AsyncGenerator<SDKMessage>`（`sdk.d.ts` 第 2915、3322 行）。
- 推荐"流式输入模式"，即 prompt 传一个异步迭代器。打断、改权限模式、改模型、发图片、排队消息**都只在这个模式下可用**（[streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)）。
- `startup()` / `prewarm()` 可以预先起好进程。文档提到一个空闲预热进程大约占 230–260 MB 内存，可以当作每个会话进程的内存量级参考（[TS 参考 prewarm](https://code.claude.com/docs/en/agent-sdk/typescript#prewarm)）。

**和会话有关的选项**（`sdk.d.ts` Options，第 1558 行起）

| 选项 | 作用 |
|---|---|
| `resume: id` | 按 ID 恢复 |
| `continue: true` | 当前目录最近的会话（和 resume 互斥） |
| `forkSession: true` | 恢复时分叉成新 ID |
| `sessionId` | 指定新会话的 UUID |
| `resumeSessionAt: uuid` + `resumeDropsTurn` | 截到某条消息为止再恢复，相当于"回退对话"。**只有无头模式认** |
| `cwd` | 默认 `process.cwd()` |
| `persistSession: false` | 不落盘 |
| `sessionStore` | 把记录同步写到你自己的存储（alpha） |
| `settingSources` | 不传时和命令行一样加载 user、project、local 三层设置 |
| `pathToClaudeCodeExecutable` | 不传就用 SDK 自带的 `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` |
| `spawnClaudeCodeProcess` | 自己负责拉起 claude 进程 |
| `extraArgs` | 透传命令行参数，比如 `{'system-prompt-snapshot':'off'}` |

**拿会话 ID**
- 每轮开头的 `system/init` 消息和每轮结尾的 `result` 消息都带 `session_id`（[SDK sessions：Capture the session ID](https://code.claude.com/docs/en/agent-sdk/sessions#capture-the-session-id)）。
- 新建时也可以用 `sessionId` 自己预先指定。

**审批**
- `canUseTool(toolName, input, {signal, suggestions, toolUseID, agentID, requestId, decisionReason, blockedPath, defaultToNo, …}) => {behavior:'allow', updatedInput?, updatedPermissions?} | {behavior:'deny', message, interrupt?}`。只有权限判定走到"要问人"那一步才会调用。
- `AskUserQuestion`（Claude 反问用户）和退出计划模式也走这个回调（[user-input](https://code.claude.com/docs/en/agent-sdk/user-input)、[TS 参考 CanUseTool](https://code.claude.com/docs/en/agent-sdk/typescript#canusetool)）。
- `permissionPrompts:'none'` 表示没人审批，一律拒绝。

**钩子**
- `hooks: {PreToolUse:[{matcher, hooks:[cb]}], …}`，共 33 种事件（`HOOK_EVENTS`：PreToolUse、PostToolUse、PermissionRequest、UserPromptSubmit、Stop、SubagentStart/Stop、PreCompact/PostCompact、SessionStart/End、Notification、TaskCreated/Completed、CwdChanged、FileChanged…）。
- 设置文件里配的钩子照样运行。

**运行中可调的控制方法**（[TS 参考 Query](https://code.claude.com/docs/en/agent-sdk/typescript#query-object)）
- 打断和流程：`interrupt()`、`stopTask(taskId)`、`backgroundTasks(toolUseId?)`、`streamInput()`、`close()`
- 模式和模型：`setPermissionMode()`、`setModel()`、`applyFlagSettings()`（比如改 effortLevel）、`updateSettings()`
- 查询：`getContextUsage()`、`supportedCommands()`、`supportedModels()`、`supportedAgents()`、`mcpServerStatus()`、`accountInfo()`、`initializationResult()`、`readFile()`
- 其他：`reconnectMcpServer()`、`toggleMcpServer()`、`setMcpServers()`、`rewindFiles()`、`reloadPlugins()`、`reloadSkills()`
- 断线重连后用 `reinitialize()` 让还没处理的审批重新送到 `canUseTool`

**插话**：`SDKUserMessage.priority`
- `'next'`（默认）：等正在跑的工具调用结束，在同一轮里送进去
- `'later'`：等这一轮结束，作为新的一轮
- `'now'`：打断当前；带上 `origin:{kind:'human'}` 时会先把能转后台的工作转到后台
- `shouldQuery:false`：只写进记录，不触发回复
- `client_composed:true`：原样送达，不展开 `@文件`，不执行斜杠命令

出处：[TS 参考 SDKUserMessage](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage)。

**恢复时工作目录要不要一致？**
- 文档说按 ID 恢复"可以在任何工作目录发起"，会跨项目查找，但文件必须在本机（[SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions#resume-by-id)；[headless：Continue conversations](https://code.claude.com/docs/en/headless#continue-conversations)）。
- 文档**没有**说恢复后在哪个目录执行。SDK 的 `cwd` 默认是宿主进程的当前目录。项目设置、CLAUDE.md、`.mcp.json`、钩子、Bash 的当前目录都跟着 cwd 走（[sessions：Sessions in other worktrees and projects](https://code.claude.com/docs/en/sessions#sessions-in-other-worktrees-and-projects)：从别的项目选会话时，交互界面会复制一条 `cd … && resume` 命令给你，说明官方预期是回到原目录）。
- 用 `sessionStore` 时文档明说要 "resume from a `cwd` matching the original run's"。
- **结论：二狗应当总是传会话原来的 `cwd`**（从 `listSessions` 或记录里取）。从别的目录恢复时记录写到哪个项目目录下**没写明，待实测**。

### 2.3 命令行 stream-json 和 SDK 是什么关系

- SDK 就是拉起 claude 进程，用 stdin/stdout 上的 stream-json 加 `control_request/control_response` 来通信。这套控制协议的类型在 `sdk.d.ts` 里是公开的（`SDKControlRequest`，有 interrupt、can_use_tool、set_permission_mode、set_model、rewind_files、stop_task、mcp_* 等约 40 种），**但 headless 文档没有把它当成直接使用的协议来写**。
- 只用命令行时，有文档的审批途径只有两条：`--permission-prompt-tool`（MCP 工具）和 `PermissionRequest` 钩子。
- 二狗本身是 Node，直接用 SDK 就行，不必自己实现这套协议。

---

## 3. 并发、冲突和 Windows 注意事项

### 3.1 同一个会话被两处打开

| 场景 | 行为 | 出处 |
|---|---|---|
| 两个终端（或终端加 SDK）都 `--resume` 同一个会话、都没分叉 | **没有锁**："If you resume the same session in two terminals without forking, messages from both interleave into one transcript." | [sessions：Branch a session](https://code.claude.com/docs/en/sessions#branch-a-session) 末段 |
| 要恢复的会话正作为**后台会话**（agent view）在跑 | 在终端里直接敲会 attach 到那个会话；如果有管道或重定向、或者带了 `--permission-mode`、`--output-format` 这类参数，会**不发送、以状态码 1 退出**。加 `--fork-session` 可以另开一份拷贝 | [sessions：Resume a running background session](https://code.claude.com/docs/en/sessions#resume-a-running-background-session) |
| SDK 去恢复一个被后台会话占着的会话 | 启动失败，原因码 `session_held_by_background` | `sdk.d.ts` 里的 `SDKStartupFailureReason` |
| agent view 去启动一个已停止的后台会话，但它的记录正被别的活进程打开 | 拒绝："Two processes can't write to the same transcript." | [agent-view：Opening a session says the conversation is already open](https://code.claude.com/docs/en/agent-view#opening-a-session-says-the-conversation-is-already-open) |
| `claude --bg --resume <id>` 而原会话正在跑 | 不抢，另开一份拷贝并说明 | 本机 `claude --help` 里的 `--bg` 说明 |
| 第一个终端开着 RC，第二个终端恢复同一个对话 | 第二个终端提示 `Remote Control not started here`，RC 留在第一个那边；在第二个终端敲 `/remote-control` 才会把 RC 挪过去 | [remote-control：Resume sessions after stopping the server](https://code.claude.com/docs/en/remote-control#resume-sessions-after-stopping-the-server) |

**对二狗的要求**：接管前先用 `claude agents --json` 查这个 `sessionId` 有没有活着的 pid。
- 有：要么提示用户先关掉，要么分叉出一份新会话（`forkSession`）来接管。
- 没有：才能用 `resume` 原样接管。
- 接管期间二狗是唯一的写入者。
- 分叉只复制对话，不隔离文件，两个会话会改同一批文件，需要的话配合 worktree（[SDK sessions：Fork](https://code.claude.com/docs/en/agent-sdk/sessions#fork-to-explore-alternatives)）。

### 3.2 同时跑多个会话
- SDK 每个 `query` 就是一个独立的 claude 进程，文档里没有硬性数量上限。
- 额度是共享的。agent view 的文档原话："running ten agents in parallel uses quota roughly ten times as fast"（[agent-view：Limitations](https://code.claude.com/docs/en/agent-view#limitations)）。
- RC 服务器模式默认最多 32 个并发会话（`--capacity`）。
- 内存参考：每个进程大约两三百 MB（见 2.2）。

### 3.3 Windows 注意事项
- 原生 Windows **不支持沙箱**，WSL 2 才支持（[setup](https://code.claude.com/docs/en/setup#set-up-on-windows)）。
- 执行命令要有 Git Bash，没有就用 PowerShell 工具；两个都没有时启动失败，原因码 `shell_tool_missing`（`sdk.d.ts`；setup 页）。
- TS SDK 用的是自带的 `claude.exe`，版本和 SDK 锁死。也可以用 `pathToClaudeCodeExecutable` 指向本机的 `C:\Users\<用户名>\.local\bin\claude.exe`，好处是和用户终端里的版本一致，代价是本机 claude 自动升级后可能比 SDK 的类型定义新。
- Python SDK 拒绝通过 `.cmd` 包装脚本启动（[SDK troubleshooting](https://code.claude.com/docs/en/agent-sdk/troubleshooting)），TS SDK 不受影响。
- Windows 命令行最长 32767 个字符，插件多时用 `pluginDelivery:'initialize'`（`sdk.d.ts`）。
- 跨会话消息在 Windows 上走命名管道，每条连接第一行必须先发 token 认证（[cross-session-messaging：The session's inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)）。
- 凭据存在 `%USERPROFILE%\.claude\.credentials.json`（[authentication](https://code.claude.com/docs/en/authentication#credential-management)）。
- 停进程（**推断**）：Windows 没有 POSIX 信号，Node 的 `child.kill()` 在 Windows 上等于强杀，那一轮会作废，`SessionEnd` 钩子可能不跑。应该先 `interrupt()`，再 `close()`；SDK 的 `close()` 会先关掉 claude 的输入，让还没回答的审批被取消（[headless：Stop a run with SIGTERM](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm)）。

---

## 4. Remote Control

### 4.1 它是什么、怎么开
把**本机上跑着的** Claude Code 会话连到 claude.ai/code 和 Claude 手机 App。
- 执行和文件访问都留在本机，本机只发出站 HTTPS，不开端口。
- 连着期间，对话记录会存到 Anthropic 服务器上。
- 出处：[remote-control](https://code.claude.com/docs/en/remote-control)。

| 开法 | 说明 |
|---|---|
| `claude remote-control` | 服务器模式，没有本地交互界面，一个进程最多 32 个会话。参数有 `--name`、`-c/--continue`、`--session-id <cse_…>`、`--spawn same-dir\|worktree\|session`、`--capacity`、`--permission-mode`、`--[no-]create-session-in-dir`。本机 `claude remote-control --help` 能看到全部 |
| `claude --remote-control [名字]` / `--rc` | 普通交互会话加 RC，本地终端和远端都能输入 |
| 会话里敲 `/remote-control` / `/rc` | 把当前对话（带历史）挂上 RC |
| 自动连 | `remoteControlAtStartup: true`，写在用户设置里；"connects Remote Control automatically when each **interactive** session starts"（[settings-reference](https://code.claude.com/docs/en/settings-reference#remotecontrolatstartup)） |
| Desktop App、VS Code | 都用 `/remote-control` |

### 4.2 条件（[remote-control：Requirements](https://code.claude.com/docs/en/remote-control#requirements)）
- Pro、Max、Team、Enterprise 订阅；**不支持 API key**。本机是 Max 账号登录，符合。
- 只能连 `api.anthropic.com`。不能走 Bedrock、Vertex、Foundry，不能设别的 `ANTHROPIC_BASE_URL`，不能走网关。
- 设了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 或 `DISABLE_GROWTHBOOK` 就用不了。
- 第一次要确认"启用 RC"。没信任过的目录会先问要不要信任；**没有终端可问时，服务器模式直接报错退出**。
- 设置里 `disableRemoteControl` 可以整体关掉。

### 4.3 无头或 SDK 驱动的会话能不能开 RC
- 本机 help 写的是 `--remote-control`："Start an **interactive** session…"。文档列的三种开法也全是交互式。`-p` 模式**没有文档化的开法**。
- `sdk.d.ts` 的 Options 和约 40 种控制请求里**都没有**"开 RC"这一项。
- SDK 包里另有一个导出 `@anthropic-ai/claude-agent-sdk/bridge`（`bridge.d.ts`，标着 `@alpha`）：
  - 函数有 `createCodeSession()`、`fetchRemoteCredentials()`、`attachBridgeSession()`，后者返回一个句柄，能写消息、转发审批请求、上报状态。
  - 注释写明 "Callers supply their own OAuth token"，还可能需要可信设备 token。
  - 注释还写着 "ALPHA STABILITY… breaking changes here do NOT bump the package major"。
  - 官方文档站里**完全没提**这个接口。CHANGELOG 里出现过 "SDK-hosted Remote Control sessions"（Desktop、VS Code 就是这么接的）。
  - 对二狗来说，走这条路要拿到用户的 claude.ai OAuth token，正好碰上条款里"不得收集或转手 claude.ai 凭据或会话 token"那条（见第 5 节），而且接口随时可能改。**不建议用。**
- 服务器模式拉起的会话本身是无头 stream-json 进程（`sdk.d.ts` 里提到 "`claude rc` workers"），但归服务器管，本地程序插不进去。

### 4.4 开了 RC 之后，本地程序还能不能同时驱动
- 交互式会话加 RC：官方原话 "Work from both surfaces at once… send messages from your terminal, browser, and phone interchangeably"。所以"本地终端"那一路可以由程序代劳，但前提是程序得驱动交互界面，也就是 pty。
- 一个交互进程同一时间只能挂一个 RC 会话；进程退出，RC 会话就下线（[remote-control：Limitations](https://code.claude.com/docs/en/remote-control#limitations)）。
- 后台会话可以带 RC：CHANGELOG 2.1.169 写 "Background sessions now preserve `--ide`, `--chrome`, `--bare`, `--remote-control`… across retire→wake"。也就是说可以用 `claude --bg --resume <id> --remote-control "名字"` 把会话交给后台 supervisor 托管，同时挂上 RC，不需要 pty。**这个组合文档没正面写，待实测。**

### 4.5 外部程序能不能拿到 RC 会话的事件
- **没有官方接口**让第三方程序订阅 claude.ai 那一侧的事件流。
- 本机能用的官方手段：
  - 钩子：可以配成 `type:"http"`，把每个事件 POST 给二狗；`PermissionRequest` 钩子还能直接回 allow/deny（[hooks](https://code.claude.com/docs/en/hooks)）。
  - `claude agents --json` 看 busy/waiting 状态和在等什么。
  - 状态栏命令的输入、钩子输入里都有 `transcript_path`，可以拿来跟读记录文件。但记录格式是内部格式。
- 往一个活会话里塞消息：
  - 跨会话消息的收件套接字（Windows 上是命名管道）收纯文本。官方规则是这种消息**不能批准任何东西，里面的斜杠命令也不会执行**，`-p` 会话同样会开收件口（[cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging#how-a-session-treats-an-incoming-message)）。
  - Channels（研究预览）可以从 MCP 服务器往会话里推事件，但自建 channel 要加 `--dangerously-load-development-channels`（[channels](https://code.claude.com/docs/en/channels#research-preview)）。
  - 这两条都只适合当辅助，不能当主通道。

---

## 5. 认证、计费和条款

### 5.1 SDK 用的是哪份凭据
SDK 和 `-p` 拉起的就是 claude 本身，按 claude 的凭据优先级选（[authentication：Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)）：

1. 云厂商（Bedrock 等）
2. `ANTHROPIC_AUTH_TOKEN`
3. `ANTHROPIC_API_KEY`，原话 "In non-interactive mode (`-p`), the key is always used when present"
4. `apiKeyHelper`
5. `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` 生成）
6. Anthropic profile
7. `/login` 的订阅登录

本机只有第 7 种，所以**二狗用 SDK 默认走的是用户的 Max 额度**。

要注意两点：
- **二狗守护进程的环境变量里绝对不能有 `ANTHROPIC_API_KEY`。** 否则会悄悄改成 API 按量计费，而且 RC 也开不了（RC 只认订阅登录）。拉起 SDK 时建议显式传 `env`，把这个变量剔掉。
- `--bare` 模式只认 API key（本机 `claude --help` 写着 OAuth and keychain are never read）。

### 5.2 官方对"程序驱动、用订阅额度"的说法（原文）
- **帮助中心 [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)**
  - "Update October 7, 2026: Claude Max and Team plans now include monthly API credits, which cover the Claude Agent SDK, claude -p, the Claude API, and Claude Managed Agents. You can still use the Claude Agent SDK, claude -p, and third-party apps with your subscription limits."
  - "Update June 15, 2026: We've paused the previously-announced changes… Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription limits."
- **[Claude Code 法务页](https://code.claude.com/docs/en/legal-and-compliance)**
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
  - "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription…"
  - "The Claude Code binary must not be modified."
  - "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- **[SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)**："Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- **[消费者条款](https://www.anthropic.com/legal/consumer-terms)**（页面标注 Effective Oct 8, 2025）禁止 "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."

**判断（不是法律意见）**：二狗是用户自己用的本机程序，跑原版 claude，用用户本人的登录，不对外提供，属于法务页说的"end user signing in to the unmodified Claude Code binary with their own Claude subscription"。帮助中心也明说 SDK、`-p` 可以用订阅额度。

红线：
1. 二狗不读取、不复制、不转存 `.credentials.json` 或任何 OAuth token（所以第 4.3 节的 bridge 路线排除）。
2. 不把这套能力提供给别人用。
3. 不改 claude 程序。
4. 并发量保持"个人正常使用"的水平。

---

## 6. Codex CLI（第二期，判断怎么接、工作量多大）

**版本先说清楚**：本机是 0.104.0，npm 最新是 0.164.0，官方文档描述的是最新版。最新版已经删掉 `codex mcp-server`：原文 "The `codex mcp-server` command and the standalone `codex-mcp-server` binary have been removed… Use the Codex app server"（[mcp-server](https://learn.chatgpt.com/docs/mcp-server)）。本机 0.104 还有这个命令（`codex mcp-server --help` 能看到），但不要基于它做方案。

| 项目 | 情况 | 出处 |
|---|---|---|
| 会话文件 | `~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl`。第一行是 `session_meta`，payload 里有 `id`、`cwd`、`cli_version`、`originator`、`source`、`model_provider`、`base_instructions`、`timestamp`。后面是 `response_item`（message、reasoning、function_call、function_call_output）、`event_msg`（task_started、user_message、agent_message、token_count、task_complete）、`turn_context`。另有 `~/.codex/state_5.sqlite` 当索引 | 本机只看了字段名 |
| 列会话 | app-server 的 `thread/list`：游标分页，可按 cwd、sourceKinds（默认只列 cli 和 vscode 起的）、searchTerm、是否置顶、是否归档筛选。另有 `thread/read`（不加载就能读）、`thread/loaded/list` | [app-server：Threads](https://learn.chatgpt.com/docs/app-server) |
| 恢复 | `codex resume [ID\|--last\|--all]`（交互）；`codex exec resume <ID> [prompt]`（非交互）；`codex fork` | 本机 `codex resume --help`、`codex exec resume --help` |
| 无头 | `codex exec --json` 输出 JSONL，事件有 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*`、`error`；`--ephemeral` 不落盘；默认只读沙箱 | 本机 `codex exec --help`；[non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode) |
| 深度集成 | `codex app-server`，JSON-RPC 2.0，默认走 stdio 按行传；ws、unix 套接字是实验性的。流程是 `initialize` → `thread/start\|resume\|fork` → `turn/start`，过程中可以 `turn/steer`（往进行中的这一轮插话）、`turn/interrupt`。通知有 `item/started`、`item/completed`、`item/agentMessage/delta`、`turn/completed` 等。同一个线程可以有多个连接同时订阅。官方定位是 "the interface Codex uses to power rich clients (for example, the Codex VS Code extension)"，同时声明 "experimental and aren't supported for production workloads" | [app-server](https://learn.chatgpt.com/docs/app-server) |
| 本机 0.104 实际支持哪些 | 离线导出的 schema 里：客户端请求 60 个（含 `thread/list`、`thread/resume`、`thread/fork`、`turn/start`、`turn/steer`、`turn/interrupt`、`thread/compact/start`、`thread/rollback`、`model/list`、`account/*`）；服务端发给客户端的请求 7 个（`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput` 等）；通知 37 个 | `…\scratchpad\cc-takeover\codex-0104-schema\` |
| 审批 | 服务端主动发 JSON-RPC 请求，客户端回答 `accept` / `acceptForSession` / `decline` / `cancel`（命令执行还能附带 execpolicy 修正） | [app-server：Approvals](https://learn.chatgpt.com/docs/app-server) |
| 让用户也能看 | 最新版可以 `codex app-server --listen ws://127.0.0.1:4500`，再用 `codex --remote ws://…` 把终端界面接到同一个 app-server 上。本机 0.104 的 `codex --help` **没有** `--remote` | [app-server：Connect the CLI terminal UI](https://learn.chatgpt.com/docs/app-server) |
| 远程（类似 RC） | ChatGPT 手机 App 里的 Codex/Remote 连的是**跑着 ChatGPT 桌面 App 的电脑**："you can't set it up from the Codex CLI or IDE extension"。CLI 或 app-server 拉起的会话没有对应的官方远程 | [remote-connections](https://learn.chatgpt.com/docs/remote-connections) |
| 认证 | ChatGPT 登录（订阅）或 API key；app-server 提供 `account/login/start` 等登录流程 | [auth](https://learn.chatgpt.com/docs/auth) |

**第二期判断**
- 用 app-server（stdio）做 Codex 适配器。它的线程、轮次、条目三层模型和审批请求能直接对上二狗的"会话、轮次、事件、审批"。
- 类型可以用 `codex app-server generate-ts` 生成。
- 工作量和 Claude 适配器同一个量级（中等）。
- 前提：
  1. 先升到最新版，并锁定版本，因为协议是实验性的、会变。
  2. Codex 没有官方 RC，"手机继续"只能靠二狗自己的 App。
  3. 同一线程被两个进程同时恢复会怎样，文档没写，待实测，先按"单写入者"处理。

---

## 7. 结论：外部程序接管 Claude Code 会话的三条路

| | A. Agent SDK 驱动（推荐当主路） | B. 命令行 `-p` stream-json | C. pty 驱动交互界面加 RC |
|---|---|---|---|
| 列会话 | `listSessions` 等，加 `claude agents --json` | 同左（只能用 `agents --json` 加读文件） | 同左 |
| 接管已有会话 | `resume`、`forkSession`、`resumeSessionAt` | `--resume`、`--fork-session` | `claude --resume <id> --remote-control` |
| 多轮、插话、打断 | 有，带 priority 的插话；`interrupt()` | 有，但打断等控制消息得自己按没文档的协议实现 | 只能模拟敲键盘（Esc、Enter），不可靠 |
| 审批 | `canUseTool`，结构化，带 requestId；`AskUserQuestion` 也走这里 | 只有 `--permission-prompt-tool`（MCP）或钩子 | `PermissionRequest` 钩子（可以用 http 类型）。终端和手机的审批框和钩子谁先答谁算，钩子长时间挂着等人会不会挡住手机端的审批框，**待实测** |
| 看过程 | 结构化事件，约 40 种消息类型，见第 9 节 | 同 A（同一套 JSON） | 钩子事件加读记录文件，交互界面本身没法可靠解析 |
| 官方 RC（claude.ai / 手机） | **没有**（除了 alpha bridge，不建议） | 没有 | **有**，终端和手机能同时驱动 |
| 风险 | SDK 自带的内核和本机版本可能不一致；事件结构还在演进（好在有类型）；要保证单写入者；`ANTHROPIC_API_KEY` 会悄悄改成按量计费 | 等于自己重写一遍 SDK | 很脆：界面一改就坏；Windows 要 ConPTY 加 node-pty 原生编译；会弹各种对话框卡住（信任目录、RC 首次确认、"Resume this conversation?" 额度提示）；没法确认输入有没有被接受 |

**推荐做法**
1. **平时由 SDK 承载**。二狗守护进程里每个"项目/任务会话"对应一个 `query()`，用流式输入模式，传原来的 `cwd`。
   - 审批用 `canUseTool` 接到二狗的审批界面。
   - 事件映射成二狗自己的事件格式。
   - 新建会话时自己预定 `sessionId`。
2. **接管已有会话**：
   - 先 `listSessions()` 列出来给用户挑。
   - 再 `claude agents --json` 查这个会话是不是正被别的进程开着。开着就提示用户关掉，或者分叉一份。
   - 确认没人在写，再 `resume`。
   - 记得重新传 MCP 配置和设置；二狗追加的系统提示要等压缩后才生效，或者加 `--system-prompt-snapshot off`。
3. **需要官方 App 或网页接着看时，做交接**：
   - 二狗先 `interrupt()` 再 `close()` 自己的 SDK 进程。
   - 然后拉起 `claude --bg --resume <id> --remote-control "<名字>"`（后台托管，不需要 pty，待实测），或者在可见的控制台或 pty 里跑 `claude --resume <id> --remote-control`。
   - 用 `--settings` 注入二狗的 http 钩子，这样二狗还能旁听进度、参与审批。
   - 用户回到二狗时反向操作：停掉后台会话（`claude stop <id>`），再用 SDK `resume`。
   - 任何时刻只有一个进程在写这个会话。
4. 二狗本来就有网页和手机 App。只要手机端用二狗自己的 App 就够了的场景，完全不需要 RC，交接只作为可选项。

**待实测清单**（这次按规矩没开会话，以下都没验证）
1. `claude agents --json` 会不会顺手拉起 supervisor，以及在本机的实际输出。
2. `claude --bg --resume <id> --remote-control` 能不能用、会不会出现在 claude.ai 上。
3. 从别的 cwd 恢复时，记录写到哪个项目目录下。
4. 交互会话里 `PermissionRequest` http 钩子挂着等人时，终端和手机的审批框怎么表现。
5. SDK 会话里发 `/remote-control`、`/btw` 文本会得到什么。
6. Codex app-server 同一线程两个进程同时 resume 会怎样。

---

## 8. Claude Code 常用命令和操作清单（交互 vs SDK / `-p`）

先说总规则（[SDK skills：Commands in Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/skills#commands-in-agent-sdk-sessions)；[headless](https://code.claude.com/docs/en/headless#create-a-commit) 里的 Note；[commands](https://code.claude.com/docs/en/commands)）：
- SDK 和 `-p` 里，**把 `/命令 参数` 当普通文本发出去就会被执行**。
- 当前会话能用哪些命令，看 `system/init` 消息的 `slash_commands` 字段，或者调 `supportedCommands()`；中途有变化会收到 `commands_changed` 消息。
- 只在终端界面里能用的命令（比如 `/theme`、`/terminal-setup`、`/login`）不在这个列表里；硬发会直接返回 `/<x> isn't available in this environment.`，不调用模型。
- 不认识的 `/xxx` 会当普通文本发给模型，并附注"命令没执行"（2.1.274 起）。
- `/model`、`/effort`、`/fast`、`/color`、`/rename` 在 `-p` 里要带参数；`/mcp` 不带参数会输出文字摘要；`/config key=value` 可以改设置；`/output-style` 可用。
- 自己写的技能、`.claude/commands/` 里的命令、内置技能（`/code-review` 之类）都能用 `/名字` 触发。
- 跨会话消息里的斜杠命令**不会执行**（cross-session-messaging）。
- `terminal_slash_commands` 字段列出"依赖本地终端"的命令，给手机或远程界面隐藏菜单用（`sdk.d.ts` 第 6220 行）。

| 操作 | 交互模式里怎么用 | SDK / `-p` 下能不能用、怎么用 |
|---|---|---|
| 压缩 `/compact [要点]` | 命令；也会自动压缩 | ✅ 发 `/compact` 文本，压缩完收到 `system/compact_boundary`；要有足够历史，否则返回 "Not enough messages to compact."。命令行有 `--autocompact <auto\|tokens>` 设窗口 |
| 清空 `/clear`（别名 /reset、/new） | 命令 | ✅ 在流式输入模式下发 `/clear`，收到 `conversation_reset` 消息；旧对话留在磁盘上，可以 resume |
| 回退 `/rewind`（Esc Esc） | 交互菜单：回退对话和/或代码 | ❌ 不能当命令发。改用拆开的两件事：**代码**用 `rewindFiles(userMessageId)`，要先开 `enableFileCheckpointing`，只追踪 Write/Edit/NotebookEdit 改的文件；**对话**用 `resume` 加 `resumeSessionAt`（可加 `resumeDropsTurn`），或者 `forkSession(id,{upToMessageId})`（[file-checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)） |
| 恢复 `/resume`、`--resume` | 选择器 | ❌ 命令本身只在终端可用（RC 文档也列为终端专用）。SDK 里用 `listSessions` 挑，再新开 `query({resume})` |
| 分支 `/branch`、`/fork` | `/branch` 当场切到分支；`/fork` 复制成一个后台会话 | 用 `forkSession()` 函数，或者 `options.forkSession` |
| 换模型 `/model`（Alt+P） | 选择器 | ✅ `setModel()`（流式模式），或者发 `/model sonnet`；`supportedModels()` 列可选模型 |
| 思考档位 `/effort`、Alt+T | `/effort low…max/auto` | ✅ 选项 `effort`、`thinking`；运行中用 `applyFlagSettings({effortLevel})`；或者发 `/effort high`。`setMaxThinkingTokens()` 已废弃 |
| 快速模式 `/fast` | 命令或 Alt+O | ✅ 发 `/fast on` |
| 计划模式 `/plan`、Shift+Tab | 进计划模式；计划做完弹出批准框 | ✅ `permissionMode:'plan'` 或 `setPermissionMode('plan')`；`planModeInstructions` 可以自定义；退出计划时的批准走 `canUseTool`（ExitPlanMode 工具）。发 `/plan 描述` 文本行不行**文档没写** |
| 切权限模式（Shift+Tab） | 在 Manual / acceptEdits / plan / auto 之间循环 | ✅ `setPermissionMode()` |
| 权限规则 `/permissions` | 对话框 | ❌ 没有对话框。改用选项 `allowedTools`、`disallowedTools`、`settings`；`canUseTool` 返回 `updatedPermissions`（可以写进 `.claude/settings.local.json`）；`updateSettings()`、`applyFlagSettings()` |
| 子代理 `/agents` | 现在只打印一句提示，让你叫 Claude 去建或改 | `agents` 选项定义子代理，`agent` 选项指定主线程用哪个；`supportedAgents()` 列出 |
| MCP `/mcp` | 列表界面 | ✅ 发 `/mcp` 得到文字摘要；`/mcp reconnect\|enable\|disable` 只在有终端的会话里可用。SDK 用 `mcpServerStatus()`、`reconnectMcpServer()`、`toggleMcpServer()`、`setMcpServers()` |
| 记忆 `/memory` | 编辑 CLAUDE.md、开关自动记忆 | ❌ 没有对应接口。直接改 CLAUDE.md 文件；`settingSources` 默认会加载 |
| 上下文 `/context` | 彩色格子图 | ✅ 发 `/context` 文本；`getContextUsage({detail})` 返回结构化数据 |
| 费用和额度 `/usage`（= /cost = /stats） | 面板 | ✅ 发 `/usage`；每轮的 `result` 带 `total_cost_usd`、`usage`、`modelUsage`；`rate_limit_event` 消息报额度；`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` 是实验接口，别依赖 |
| 待办 `/todos` | **现在没有这个命令**。Ctrl+T 显示或隐藏待办清单 | 待办以 `TodoWrite` 或 `TaskCreate/TaskUpdate/TaskList/TaskGet` 的 tool_use 块出现在事件流里。**默认只在 Opus 4.7、Sonnet 4.6、Haiku 4.5 及更早的模型上开**，新模型要自己打开：`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 或写进 `allowedTools`（[todo-tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking)） |
| 后台任务（Ctrl+B、`/tasks`） | 把 Bash 或子代理转到后台；`/tasks` 查看 | ✅ `backgroundTasks(toolUseId?)`、`stopTask(taskId)`；事件有 `task_started`、`task_progress`、`task_updated`、`task_notification`、`background_tasks_changed`；还有 `tool_progress` 心跳 |
| 整个会话转后台 `/background`、`/stop` | agent view 的功能 | 不适用。SDK 会话本来就是二狗托管的后台进程 |
| 插话、排队输入 | 运行中敲 Enter 就排队：普通消息等当前工具调用结束、在同一轮里送达；命令等这一轮结束再执行；Ctrl+Enter 立刻发送 | ✅ 流式输入里直接再推一条 `SDKUserMessage`，用 `priority` 控制 `next`/`later`/`now`（见 2.2）；协议里有 `cancel_async_message`（撤回排队消息），`Query` 上**没有公开方法** |
| 打断（Esc） | 停掉当前回复或工具调用，已做的保留，排队的接着发 | ✅ `interrupt()`（流式模式），CLI 支持 `interrupt_receipt_v1` 时会返回当时还没处理的消息 |
| 粘贴图片（Ctrl+V / Alt+V） | 插入 `[Image #N]` | ✅ `SDKUserMessage.message.content` 里放 image 块（只在流式模式）；粘贴的文字用 `pasted_content` 或 `inline_pastes` |
| `@文件` | 自动补全，把文件当上下文 | ✅ 提示文本里的 `@path` 默认会展开；`client_composed:true` 或 `verbatimPrompts` 会关掉展开 |
| `!` 命令行模式 | 直接跑 shell 命令 | ❌ 没有。替代做法：二狗自己跑命令，再用 `shouldQuery:false` 把输出塞进记录 |
| 钩子 `/hooks` | 只能看 | ✅ `hooks` 选项传回调（33 种事件）；设置文件里的钩子也照常运行；`includeHookEvents` 让事件流里带 `hook_started`、`hook_progress`、`hook_response` |
| 子代理运行 | Agent 工具 | ✅ 子代理的消息带 `parent_tool_use_id`，指向是哪个 Agent 工具调用起的；`forwardSubagentText` 让子代理的正文也转发出来；`agentProgressSummaries` 定期出进度摘要；`getSubagentMessages()` 事后读 |
| 技能、自定义命令 | `/技能名 参数` | ✅ 一样发文本；`skills` 选项可以限制加载哪些 |
| 改名 `/rename` | | ✅ 发 `/rename x`，或调 `renameSession()` |
| 改设置 `/config` | | ✅ 发 `/config key=value` |
| 目标 `/goal` | | ✅ CHANGELOG 写明 "Works in interactive, `-p`, and Remote Control" |
| 循环 `/loop` | | ✅ `-p` 会等自定节奏的 wakeup（[headless：Background tasks at exit](https://code.claude.com/docs/en/headless#background-tasks-at-exit)） |
| 旁问 `/btw` | 问个题外话，不进主对话 | ❓ 公开的控制请求里**没有**；RC 支持（CHANGELOG）；SDK 下行为待实测 |
| 导出 `/export` | | 用 `getSessionMessages()` 自己导 |
| 状态 `/status` | | `accountInfo()`、`initializationResult()` |
| `/diff` | 差异面板 | ❌（RC 网页端有自己的差异面板） |
| 加目录 `/add-dir` | | 选项 `additionalDirectories` |
| `/remote-control` | 交互、Desktop、VS Code | ❌ 见第 4.3 节 |
| `/login` `/logout` `/plugin` `/theme` `/vim` `/keybindings` `/terminal-setup` 等 | 终端专用 | ❌ 返回 "isn't available in this environment"；插件改用 `plugins` 选项加 `reloadPlugins()` |

RC（手机、网页）能用的命令清单另见 [remote-control：Limitations](https://code.claude.com/docs/en/remote-control#limitations)：`/compact`、`/clear`、`/context`、`/usage`、`/exit`、`/recap`、`/reload-plugins`、`/model x`、`/effort x`、`/fast`、`/color`、`/rename`、`/mcp`、`/config`、`/autocompact`、`/advisor`、`/output-style`、`/focus`。和 SDK 能用的那一批基本重合，可以当"两种运行时的交集"参考。

---

## 9. 会话里的事件种类（SDK 消息，用于和 pi 等运行时对齐）

来源：`sdk.d.ts` 里的 `SDKMessage` 联合类型（第 5579 行，共 39 种）和 [TS 参考 Message Types](https://code.claude.com/docs/en/agent-sdk/typescript#message-types)。`-p --output-format stream-json` 每行输出的就是同一套对象。

| 类别 | `type` / `subtype` | 含义 | 对齐建议 |
|---|---|---|---|
| 会话开头 | `system/init` | **每一轮开头都会发**。带 `session_id`、`cwd`、`model`、`permissionMode`、`tools`、`mcp_servers`、`slash_commands`、`terminal_slash_commands`、`skills`、`plugins`、`agents`、`effort`、`capabilities`、`claude_code_version`、`apiKeySource` | 会话元信息；用 `capabilities` 判断支持哪些功能，不要比版本号 |
| 助手输出 | `assistant` | 一个**完整的内容块**发一条（text / thinking / **tool_use**），所以会连续收到好几条；带 `parent_tool_use_id`（子代理）、`agent_id`、`subagent_type`、`error` | 映射成"助手消息"和"工具调用开始" |
| 用户和工具结果 | `user` | 客户端发的提示，以及 CLI 自己加的 **tool_result** 块；`tool_use_result` 放结构化的工具输出；`isSynthetic` 表示是系统合成的 | 映射成"工具结果"和"用户消息" |
| 回显 | `user`（replay） | 开了 `--replay-user-messages` 时把用户消息回显一遍 | 用来确认消息已经收到 |
| 逐字输出 | `stream_event` | 只在 `includePartialMessages` 时发，内容是原始的 API 流事件（text_delta 等） | 打字机效果 |
| 一轮结束 | `result`，subtype 有 `success`、`error_during_execution`、`error_max_turns`、`error_max_budget_usd`、`error_max_structured_output_retries` | **每轮恰好一条**，是这一轮结束的信号。带 `result` 文本、`num_turns`、`duration_ms`、`total_cost_usd`、`usage`、`modelUsage`、`permission_denials`、`stop_reason`、`session_id` | 映射成"轮次结束" |
| 会话状态 | `system/session_state_changed` | `idle` / `running` / `requires_action`；官方说 idle 是"这一轮确实结束了"的权威信号 | 映射成忙 / 闲 / 等审批 |
| 压缩 | `system/compact_boundary` | 带 `compact_metadata` | 映射成"压缩边界" |
| 对话重置 | `conversation_reset` | 由 `/clear`、退出计划模式选了"清空上下文"等触发，会给出新的对话 ID | 映射成"开新对话" |
| 状态 | `system/status` | `compacting` / `requesting` | 转圈提示 |
| 重试 | `system/api_retry` | 第几次、多久后重试、错误类别 | |
| 后台任务和子代理 | `system/task_started` / `task_progress` / `task_updated` / `task_notification`、`system/background_tasks_changed`、`tool_progress`（心跳，带已用秒数） | 子代理和后台任务的生命周期；`task_started` 带 `task_id`、`tool_use_id`、`description`、`subagent_type`、`is_backgrounded`、`parent_task_id` | 映射成"子任务"的开始 / 进度 / 结束 |
| 待办 | 没有专门的消息类型 | 看 `TodoWrite` 或 `Task*` 的 tool_use 块 | 从工具调用里解析 |
| 权限 | 审批请求走 `canUseTool` 回调，**不在消息流里**；`system/permission_denied` 是被拒的通知 | | 审批和"被拒"分开处理 |
| 钩子 | `system/hook_started` / `hook_progress` / `hook_response` | 需要 `includeHookEvents` | |
| 命令输出 | `system/local_command_output`、`system/informational`、`system/notification` | 斜杠命令输出、横幅、提示 | 显示成系统消息 |
| 命令列表变化 | `system/commands_changed` | | 刷新命令菜单 |
| 其他 | `system/thinking_tokens`（思考 token 估计）、`system/memory_recall`、`system/files_persisted`、`system/model_refusal_fallback` / `model_refusal_no_fallback`、`system/elicitation_complete`、`system/plugin_install`、`system/mirror_error`、`system/worker_shutting_down`（RC 进程退出）、`system/control_request_progress`、`tool_use_summary`、`rate_limit_event`、`prompt_suggestion`、`auth_status` | | 按需处理，不认识的类型直接忽略（官方也是这么建议的） |

**和 Codex app-server 的对应**（第二期用）
- `thread/started` ≈ `system/init`
- `turn/started` 或 `turn/completed` ≈ 一轮的开始和 `result`
- `item/started`、`item/completed`（item 类型有 agentMessage、reasoning、commandExecution、fileChange、mcpToolCall…）≈ `assistant` 里的 tool_use 加 `user` 里的 tool_result
- `item/agentMessage/delta` ≈ `stream_event`
- `turn/plan/updated` ≈ 待办更新
- `thread/compacted` ≈ `compact_boundary`
- `thread/tokenUsage/updated`、`account/rateLimits/updated` ≈ 费用和额度
- 审批：Claude 是 `canUseTool` 回调，Codex 是服务端主动请求 `item/*/requestApproval`。两边都是"请求-应答"，二狗可以统一成一个"待审批"实体

---

## 附：主要出处
- Claude Code 文档：[sessions](https://code.claude.com/docs/en/sessions)、[remote-control](https://code.claude.com/docs/en/remote-control)、[headless](https://code.claude.com/docs/en/headless)、[cli-reference](https://code.claude.com/docs/en/cli-reference)、[agent-view](https://code.claude.com/docs/en/agent-view)、[permission-modes](https://code.claude.com/docs/en/permission-modes)、[commands](https://code.claude.com/docs/en/commands)、[interactive-mode](https://code.claude.com/docs/en/interactive-mode)、[hooks](https://code.claude.com/docs/en/hooks)、[cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging)、[channels](https://code.claude.com/docs/en/channels)、[authentication](https://code.claude.com/docs/en/authentication)、[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)、[settings-reference](https://code.claude.com/docs/en/settings-reference)、[setup](https://code.claude.com/docs/en/setup)
- Agent SDK 文档：[overview](https://code.claude.com/docs/en/agent-sdk/overview)、[sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[typescript](https://code.claude.com/docs/en/agent-sdk/typescript)、[streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[user-input](https://code.claude.com/docs/en/agent-sdk/user-input)、[skills（命令一节）](https://code.claude.com/docs/en/agent-sdk/skills#commands-in-agent-sdk-sessions)、[todo-tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking)、[file-checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)、[troubleshooting](https://code.claude.com/docs/en/agent-sdk/troubleshooting)
- SDK 包：`@anthropic-ai/claude-agent-sdk@0.3.310` 的 [sdk.d.ts](https://cdn.jsdelivr.net/npm/@anthropic-ai/claude-agent-sdk@0.3.310/sdk.d.ts)、[bridge.d.ts](https://cdn.jsdelivr.net/npm/@anthropic-ai/claude-agent-sdk@0.3.310/bridge.d.ts)、README；[SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)；[Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- 条款和计费：[帮助中心 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)、[Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- Codex：[app-server](https://learn.chatgpt.com/docs/app-server)、[non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode)、[mcp-server（已删除说明）](https://learn.chatgpt.com/docs/mcp-server)、[remote-connections](https://learn.chatgpt.com/docs/remote-connections)、[codex-sdk](https://learn.chatgpt.com/docs/codex-sdk)、[auth](https://learn.chatgpt.com/docs/auth)、[openai/codex app-server 源码](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- 本机命令：`claude --help`、`claude remote-control --help`、`claude agents --help`、`claude daemon --help`、`claude auth status --help`、`claude auth status --text`、`codex --help`、`codex exec --help`、`codex exec resume --help`、`codex resume --help`、`codex app-server --help`、`codex mcp-server --help`、`codex app-server generate-json-schema --out …`
