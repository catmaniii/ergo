# pi 的命令和能力 × 二狗前端的会话操作（为 Claude Code / Codex 接管做的两份清单）

> - 日期：2026-10-25。只读调研，没改文件、没跑服务。
> - 仓库：二狗的检出。pi 版本 1.0.4。
> - 路径记法（表里的"出处"都按这个写）：
>   - `PI/` = `仓库/node_modules/@earendil-works/pi-coding-agent/`
>   - `daemon/` = `仓库/packages/daemon/src/`，`child/` = `daemon/runtime/agent-child/`
>   - `web/` = `仓库/packages/web/src/`，`protocol/` = `仓库/packages/protocol/src/`
>   - 宿主协议 = `daemon/runtime/host-protocol.ts`（版本 21）
> - 另一位同事在列 Claude Code 那一边，这份只管 pi 和二狗。

---

## 0. 先说结论

1. **二狗没有用 pi 的交互模式（TUI），也没有用 pi 的 RPC 模式。** 它在自己的 agent 子进程里调 SDK `createAgentSession()` 跑 pi（`child/main.ts`、`child/session.ts`）。守护进程只认二狗自己的宿主协议，协议的类型里没有任何 pi 的词汇。
   - 所以 pi 的斜杠命令和快捷键，二狗前端**一个都没有直接暴露**。
   - 前端的每个操作都走这条链：网关 WS 方法或 HTTP → 守护进程 → 需要时发一条宿主协议命令 → 子进程里调 pi SDK。
2. **换运行时要对齐的是宿主协议这一层，不是 pi 的命令表。** 这一层有：
   - 14 条命令（`work_order` 只定义了，没实现）；
   - 14 种上报；
   - 3 个一次性子进程：改写会话文件、模型探查、缩图。

   前端约 70 个和会话有关的操作里，大约 2/3 是守护进程自己做的，和运行时无关。比如卡片、待办、任务状态、排队、已读、语音、附件上传、回退前的效果预览、分支视图。
3. **和运行时绑得最紧的地方**（下表标 ★）。换 Claude Code 时，最可能"不兼容"或"不覆盖"的就是这些：
   - ★ **会话树**：撤回到某条输入、某次工具调用之前；切回废弃分支的末端；给被放弃的那段写分支摘要；叶子落盘。用的是 pi 的 `SessionManager.branch / branchWithSummary` 加 `generateBranchSummary`。
   - ★ **彻底删除**：直接改写 pi 的会话 JSONL。按二狗自己埋的 `ergo-input` 标签找到原话，压缩摘要、分支摘要、交接摘要一起换掉。
   - ★ **工具调用前先停住等守护进程判定**：可以异步等最多 5 分钟，可以拦下，可以整份换掉参数，可以在结果前面加一句话。
   - ★ **进上下文但界面不显示的消息**：
     - 上下文块：每条输入之前、每次压缩之后注入；
     - 跟在用户消息后面的上下文消息：看板变化、记忆简报；
     - 交接摘要；
     - 每轮现拼的系统提示后缀。
   - ★ **压缩**：手动压缩；秘书的自定义压缩指令；压缩前的钩子里做范围审视；压缩后重新注入上下文块；报告压缩的结局。
   - ★ **yield**：当前这批工具调用做完、下一次模型调用之前停下。实现方式是包住 pi 内部的 `Agent.finishTurn`。
   - ★ **插话（steer）**，并且要知道哪几条插话已经进了上下文。
   - ★ **一个会话固定一个模型**：换模型 = 用原来的模型写一份交接摘要，再新开一个会话。不用 pi 的会话中途 `setModel`。
   - ★ **被杀后恢复**：去掉 JSONL 末尾写到一半的一行，给没有结果的工具调用补上结果。
   - ★ **资源全部关掉**：
     - 不读 `~/.pi`、项目上下文文件、扩展、提示模板，只加载指定的 skill；
     - 系统提示整份替换；
     - bash 换成二狗自己的定义（额外环境变量、临时目录）。
   - ★ **四段用量**（input / output / cacheRead / cacheWrite）；**模型目录**（列模型、能不能看图、支持哪几档思考）；**上下文窗口和压缩阈值**。
4. **pi 有、二狗前端没有的**（详见 §B7）：
   - `@文件`、`!命令`；
   - 导出、分享、复制；
   - `/tree` 跳到任意节点、节点标签；
   - `/fork`、`/clone`、`/resume` 切换历史会话、`/name`；
   - 会话中途换模型或思考档位、编辑后重发；
   - 自动重试开关、steering / followUp 模式。

   另外两点：
   - 用户自己直接说的话在二狗里**不算插话**：144 号票起，二狗回复时用户发的话排进队，这一轮做完再交。
   - pi 自己的 followUp 队列，二狗也没用。

---

## A. pi coding agent 的命令和能力

### A1. 交互模式的内置斜杠命令

出处：
- 命令表：`PI/dist/core/slash-commands.js`（`BUILTIN_SLASH_COMMANDS`）、`PI/docs/slash-commands.md`；
- 隐藏的 `/debug`：`PI/dist/modes/interactive/interactive-mode.js`；
- `/mcp`、`/llama` 由内置扩展注册：`PI/dist/extensions/mcp/index.js:1019`、`PI/dist/extensions/llama/index.js:163`。

| 命令 | 作用 | SDK / RPC 里的对应 | 二狗有没有、怎么对应 |
|---|---|---|---|
| `/model [provider/model]` | 选模型（Ctrl+L） | `session.setModel` / RPC `set_model` | **不在会话中途换**。装配参数里的 `model` 只用于新开的会话；换模型走交接摘要（83 号票）。入口是 ⚙ 的"模型"、设置 · 模型 |
| `/thinking [level]` | 思考档位（Shift+Tab 轮换） | `setThinkingLevel` / `set_thinking_level` | 同上。档位跟着会话固定（73 号票），只在 `createAgentSession({thinkingLevel})` 时给 |
| `/scoped-models` | Ctrl+P 轮换哪些模型 | `scopedModels` | 无 |
| `/settings` | 设置菜单 | `SettingsManager` | 无。二狗用 `SettingsManager.inMemory({})`，全按 pi 默认（`child/session.ts:158`） |
| `/login` `/logout` | provider 认证 | `ModelRuntime` / 认证存储 | 无。凭据经 stdin 放进 `InMemoryCredentialStore`；API key 在设置 · 模型里填 |
| `/llama` | llama.cpp 路由 | 内置扩展 | 无（`noExtensions`） |
| `/new` | 新开一个会话 | RPC `new_session`、`AgentSessionRuntime.newSession` | 对应物是 ⚙ 的"清空当前对话"：装配参数 `freshSession`，`SessionManager.create` 一个新文件 |
| `/resume` | 切换到已存的会话 | `switch_session` | 没有界面。守护进程按 `continueSession` / `session` 名字接着哪个会话（`child/session.ts:404-428`） |
| `/name [name]` | 会话的显示名 | `set_session_name` | 无。二狗拿文件名当段名 |
| `/session` | 会话文件、ID、消息数、token、成本 | `get_session_stats` / `getSessionStats` | 部分有：⚙ 的上下文用量、任务的"消耗"栏。数据来自 usage 上报，不调 `getSessionStats` |
| `/tree` | 会话树导航：能跳到任意节点，可选写分支摘要；选中用户消息时把原文放回编辑器 | `navigateTree` | ★ **部分有**：↶ 回退（回到用户消息之前、分支开始前、阶段或步骤开始前），和切回废弃分支的末端。不能跳任意节点，也不回填输入框。没直接调 `navigateTree`，用同一套零件自己拼（`child/session-navigation.ts`） |
| `/fork` | 从早先的一条用户消息新开一个会话文件 | `fork` / `getUserMessagesForForking` | 无 |
| `/clone` | 把当前分支复制成一个新会话 | `clone` | 无 |
| `/compact [instructions]` | 手动压缩，可以带指令 | `compact(customInstructions)` | ★ 有，是 ⚙ 的"现在压缩"。不带临时指令；秘书的压缩指令由钩子统一加 |
| `/import <path>` | 导入 JSONL 并接着这个会话 | `importFromJsonl` | 无 |
| `/copy` | 复制最后一条回复（Ctrl+X） | `getLastAssistantText` | 无。语音气泡的"复制文字"是另一回事 |
| `/export [path]` | 导出 HTML / JSONL | `exportToHtml` / `exportToJsonl` / `export_html` | 无 |
| `/share` | 上传后给一个查看链接 | — | 无 |
| `/bug` | 给 pi 开发者的私密报告 | `summarizeForBugReport` | 无 |
| `/trust` | 记下项目信任的决定 | `project_trust` 事件 | 无（资源全关，用不到） |
| `/reload` | 重新加载按键、扩展、skill、模板、主题、上下文文件 | `session.reload()` | 对应物：工具包或提示词变了，停掉子进程、按新装配重新拉起（`reassemble` / `refresh`） |
| `/hotkeys` `/changelog` `/quit` `/debug` | 杂项 | — | 无 |
| `/skill:名字`、`/<模板名>`、扩展命令 | 资源带来的命令 | `prompt()` 里展开 / `get_commands` | skill：守护进程自己把 `/目录名` 展开成全文（`daemon/skills/skill-command.ts`）。pi 的展开永远不会触发，因为每条输入第一行是时间标记。候选来自 `GET /api/conversations/<c>/slash-commands`。模板和扩展命令：关掉了 |
| `/mcp` | 管 MCP | MCP 扩展 | 无。二狗的 MCP 是守护进程的宿主工具（`daemon/mcp/`） |

### A2. 交互模式的输入和按键

出处：`PI/docs/usage.md`、`PI/docs/keybindings.md`

| 能力 | 默认按键 | SDK 里的对应 | 二狗 |
|---|---|---|---|
| 发消息 | Enter | `prompt()` | 有：发送 |
| **回复中按 Enter = steer**：当前这一步（含工具调用）做完、下一次模型调用之前插入 | Enter | `session.steer()` | ★ 宿主协议 `interject`。**只给运行时的通知和秘书转达的话用**；用户自己说的话排队 |
| **回复中 followUp**：整轮做完再交 | Alt+Enter（Windows 上 Ctrl+Q） | `session.followUp()` | 不用。用户回复中发的"追加"由守护进程排队（`daemon/conversation/message-queue.ts`），这一轮结束后合成一条 `user_input` |
| 把排着的消息拿回编辑器 | Alt+Up（Windows 上 Alt+Q） | `clearQueue()` | 对应物：排队气泡叉掉、拖动改顺序（`queued_message_action`）。pi 的 `clearQueue` 只在 yield 时用 |
| 打断 | Esc | `abort()`（交互模式里先 `clear_queue`） | 有：输入框旁的"停止"（`stop_reply` → `abort`） |
| `@` 搜文件插进提示 | `@` | — | **无** |
| Tab 补全路径 | Tab | — | 无 |
| 粘贴或拖入图片 | Ctrl+V（Windows 上 Alt+V） | `prompt(text, {images})` | 有：附件菜单上传图片 → `user_input.images`（模型能看图时） |
| `!cmd` 跑命令并把输出送进上下文；`!!cmd` 跑但不送 | `!` / `!!` | `executeBash` / RPC `bash` | **无**。用户不能直接跑命令；agent 的 bash 工具照常能用 |
| 外部编辑器 | Ctrl+G | — | 无。有"放大输入框" |
| 展开 / 收起工具输出 | Ctrl+O | — | 工具调用组是一行，点开在详情页看 |
| 展开 / 收起思考 | Ctrl+T | — | 思考是一行，点开看全文 |
| 轮换思考档位 / 选模型 / 轮换模型 | Shift+Tab / Ctrl+L / Ctrl+P | — | 无。改的地方是 ⚙ 和设置 · 模型 |
| `/tree` 里给节点加标签、过滤（只看用户消息、隐藏工具、只看带标签的） | Shift+L、Ctrl+U/T/L… | `appendLabelChange` | 二狗只给分支摘要写一个"用户回退"标签，界面不用它 |
| 会话选择器：搜索、改名、删除、排序 | Ctrl+R / Ctrl+D… | `SessionManager.list` | 无 |

### A3. 启动参数（和会话有关的）

出处：`PI/docs/cli.md`

参数有：
- 会话：`-c/--continue`、`-r/--resume`、`--session <path|id>`、`--session-id`、`--fork <path|id>`、`--session-dir`、`--no-session`、`-n/--name`；
- 模型：`--model provider/id[:thinking]`、`--thinking`、`--models`；
- 工具：`--tools` / `--no-tools`；
- 运行方式：`--mode text|json|rpc`、`--export`。

二狗一个都不用，因为它不起 pi 的命令行。对应的是装配参数（宿主协议的 `SessionAssembly`）：`sessionDir`、`continueSession`、`session`、`freshSession`、`model`、`tools`、`skillPaths`、`systemPrompt`。

### A4. RPC 命令（pi 的无界面控制面）

出处：`PI/docs/rpc-commands.md`、`PI/docs/rpc-extension-ui.md`。

二狗不用 RPC 模式。列出来是为了方便和 Claude Code 的 stream-json 对照；最后一列写 `child/` 里实际调的 SDK。

| RPC 命令 | 作用 | 二狗用的 SDK 等价物 |
|---|---|---|
| `prompt`（`images`，回复中要带 `streamingBehavior: steer/followUp`） | 发一条用户提示 | ✔ `session.prompt(text, {images})`（`child/session.ts:612`） |
| `steer` | 回复中插话 | ✔ `session.steer`（`child/session.ts:630`） |
| `follow_up` | 做完再交 | ✘ |
| `abort` | 中止并等到空闲 | ✔ `session.abort`（`child/session.ts:689`） |
| `clear_queue` | 清掉排队的 steer / followUp，返回原文 | ✔ `session.clearQueue`，只在 yield 时用（`child/session.ts:577`） |
| `new_session` | 新会话 | ✘。拉起时用 `SessionManager.create` |
| `get_state` | 模型、思考档位、是否在流式输出、是否在压缩、会话文件… | 直接读 `session.model / isStreaming / isIdle / sessionFile` |
| `get_messages` | 全部消息 | `session.messages`（范围审视用，`child/scope-review.ts:193`） |
| `set_model` / `cycle_model` / `get_available_models` | 换模型、列模型 | ✘。列模型由一次性的模型探查子进程用 `ModelRuntime` 做（`child/probe.ts`） |
| `set_thinking_level` / `cycle_thinking_level` / `get_available_thinking_levels` | 思考档位 | 建会话时给定，加 pi-ai 的 `clampThinkingLevel` / `getSupportedThinkingLevels` |
| `set_steering_mode` / `set_follow_up_mode` | 排队消息一次送全部还是一次一条 | ✘（默认一次一条） |
| `compact`（`customInstructions`） | 手动压缩 | ✔ `session.compact()`（`child/session.ts:653`） |
| `set_auto_compaction` | 自动压缩开关 | ✘（默认开） |
| `set_auto_retry` / `abort_retry` | 自动重试 | ✘（默认开，最多 3 次） |
| `bash` / `abort_bash` | 用户跑命令 | ✘ |
| `get_session_stats` | token、成本、上下文用量 | ✘。用量靠每条回复定稿时的 usage 上报 |
| `export_html` | 导出 | ✘ |
| `switch_session` | 换会话文件 | ✘。拉起时用 `SessionManager.open` |
| `fork` / `clone` / `get_fork_messages` | 分叉、复制 | ✘ |
| `get_entries` / `get_tree` | 会话条目、会话树 | 在子进程里直接读：`sessionManager.getBranch / getEntry / getLeafId` |
| `get_last_assistant_text` / `set_session_name` / `get_commands` | 杂项 | ✘。斜杠候选由守护进程算 |
| RPC 扩展界面（select / confirm / input / notify 转发给客户端） | 扩展问用户 | ✘。审批走二狗自己的卡片 |

### A5. SDK：`AgentSession` 的方法和事件

出处：`PI/dist/core/agent-session.d.ts`（`prompt` 约 527 行、`compact` 约 700 行、`navigateTree` 约 843 行）、`PI/docs/sdk.md`

| 方法 / 属性 | 作用 | 二狗在哪用 |
|---|---|---|
| `prompt(text, {images, streamingBehavior})` | 发提示；回复中要指明 steer 或 followUp | ✔ `child/session.ts:612` |
| `steer(text, images)` | 插话 | ✔ `child/session.ts:630` |
| `followUp(text, images)` | 做完再交 | ✘ |
| `sendCustomMessage(msg, {triggerTurn, deliverAs: steer/followUp/nextTurn})` | 自定义消息：进上下文，`display` 可以设成不显示 | ✔ 上下文块（`child/session.ts:606`）；跟在用户消息后的上下文消息，用 `nextTurn`（`:611`）；交接摘要（`:212`）；压缩后重注入（`child/bridge.ts:79` 的 `pi.sendMessage`） |
| `sendUserMessage` | 以用户身份发消息 | ✘ |
| `clearQueue` / `getSteeringMessages` / `pendingMessageCount` | 看、清排队的消息 | ✔ `child/session.ts:577,640` |
| `abort()` / `waitForIdle()` | 中止 / 等空闲 | ✔ `child/session.ts:689`、`child/session-navigation.ts:55-56` |
| `setModel` / `cycleModel` | 会话中途换模型 | ✘ |
| `setThinkingLevel` / `cycleThinkingLevel` / `getAvailableThinkingLevels` / `supportsThinking` | 思考档位 | ✘（建会话时给定） |
| `setSteeringMode` / `setFollowUpMode` | 排队方式 | ✘ |
| `compact(customInstructions?)` | 手动压缩：先中止当前回合 | ✔ `child/session.ts:653` |
| `abortCompaction` / `abortBranchSummary` | 取消压缩、取消分支摘要 | ✘ |
| `setAutoCompactionEnabled` / `setAutoRetryEnabled` / `abortRetry` | 开关 | ✘ |
| `executeBash` / `recordBashResult` / `abortBash` | 用户跑命令 | ✘ |
| `setSessionName` | 会话名 | ✘ |
| `navigateTree(targetId, {summarize, customInstructions, replaceInstructions, label})` | 在同一个文件的会话树上挪，可以给被放弃的分支写摘要 | ✘ **不直接调**，用零件自己拼（原因见 `child/session-navigation.ts` 开头的注释：叶子落点、落盘、回到根时的问题） |
| `getUserMessagesForForking` / `getSessionStats` / `getContextUsage` | 杂项 | ✘ |
| `exportToHtml` / `exportToJsonl` / `getLastAssistantText` | 导出、复制 | ✘ |
| `subscribe(listener)` | 订阅会话事件 | ✔ `child/session.ts:564` |
| `refreshContext()` | 挪完叶子后换掉内存里的上下文 | ✔ `child/session-navigation.ts:74` |
| `dispose()` | 关闭 | ✔ `child/session.ts:693` |
| `getActiveToolNames` / `getAllTools` / `setActiveToolsByName` | 工具 | ✔ `getActiveToolNames`（`child/session.ts:215`） |
| `model / thinkingLevel / sessionId / sessionFile / isStreaming / isIdle / messages / sessionManager` | 状态 | ✔ 各处 |
| `agent.finishTurn`（pi-agent-core 的 `Agent` 钩子，**内部 API**） | 一批工具调用结束后、决定要不要接着下一次模型调用时问一下 | ✔ yield（`child/session.ts:570-581`） |
| `agent.transformContext`（内部 API） | 每次请求前改上下文 | ✔ 工具清单排序（`child/tool-order.ts`） |
| `agent.streamFunction` | 模型调用函数 | ✔ 写压缩摘要、分支摘要时用（`child/compaction.ts:31`、`child/session-navigation.ts:145`） |
| `AgentSessionRuntime.newSession / switchSession / fork / importFromJsonl` | 换掉当前会话 | ✘ |

**会话事件**（`subscribe` 收到的，`agent-session.d.ts` 30-110 行）：
- 全部有：`message_start / message_update / message_end`、`tool_execution_start / update / end`、`agent_end`、`agent_settled`、`queue_update`、`compaction_start / compaction_end`、`entry_appended`、`session_info_changed`、`thinking_level_changed`、`auto_retry_start / end`、`summarization_retry_*`、`bash_execution_update`。
- **二狗用到的**：`message_start`、`message_update`（`text_delta`、`thinking_delta`）、`message_end`、`tool_execution_start`、`tool_execution_end`、`compaction_end`、`agent_settled`（`child/event-translator.ts:31-57`、`child/session.ts:566`）。

### A6. SDK：`SessionManager`（会话树）

出处：`PI/dist/core/session-manager.d.ts`、`PI/docs/session-format.md`、`PI/docs/sessions.md`

会话文件是追加写的 JSONL 树，每条有 `id` 和 `parentId`。条目类型有：`session`、`message`、`thinking_level_change`、`model_change`、`usage`、`compaction`、`branch_summary`、`custom`、`label`、`session_info`、`custom_message`、`context_edit`。

| 方法 | 作用 | 二狗 |
|---|---|---|
| `create / open / continueRecent / inMemory / forkFrom / findById / list / listAll`（静态方法） | 建、开、找会话 | ✔ `create`、`open`（`child/session.ts:404,419,428`、`child/handoff.ts:86`）；其余 ✘ |
| `appendMessage` | 追加一条消息 | ✔ 给被中断的调用补工具结果（`child/session-recovery.ts:57`） |
| `appendCustomEntry(type, data)` | 不进模型上下文的自定义条目 | ✔ `ergo-input`（`child/session.ts:609,629`）、`ergo-session-model`（`:210`）、`ergo-branch`（`child/session-navigation.ts:73`）；范围审视的副本走 `pi.appendEntry` |
| `appendCustomMessageEntry` | 进上下文的自定义消息 | 间接用，经 `sendCustomMessage` |
| `appendCompaction` | 压缩摘要 | 由 pi 写；二狗在 `session_before_compact` 里交回自己写的摘要 |
| `appendLabelChange` | 节点标签 | ✔ `child/session-navigation.ts:71` |
| `appendContextEdit` | 在本分支上改写早先的一条 | ✘ |
| `appendModelChange / appendThinkingLevelChange / appendSessionInfo` | — | pi 自己写 |
| `getBranch / getEntry / getLeafId` | 当前路径、取条目、当前叶子 | ✔ `child/session-navigation.ts:59-61`、`child/scope-review.ts:55`、`child/session.ts:360` |
| `getTree / getChildren / getEntries` | 整棵树 | ✘。改写会话文件时直接读 JSONL |
| `buildSessionContext` | 拼出模型上下文 | ✔ `child/session.ts:315`、`child/handoff.ts:44` |
| `branch(id)` | 把叶子挪到某条（不写摘要） | ✔ `child/session-navigation.ts:72` |
| `branchWithSummary(id, summary, details, fromHook, usage)` | 挪叶子并写分支摘要条目 | ✔ `child/session-navigation.ts:69` |
| `resetLeaf / createBranchedSession` | — | ✘ |

### A7. SDK 导出的零件函数和工厂

| 导出 | 作用 | 二狗在哪用 |
|---|---|---|
| `createAgentSession` | 建会话（`cwd`、`model`、`thinkingLevel`、`tools` 白名单、`customTools`、`resourceLoader`、`sessionManager`、`settingsManager`） | `child/session.ts:192` |
| `DefaultResourceLoader`（`noExtensions / noSkills / additionalSkillPaths / noPromptTemplates / noThemes / noContextFiles / systemPrompt / appendSystemPromptOverride / extensionFactories`） | 资源发现 | `child/session.ts:171-190`（全关，只加载指定的 skill 和桥接扩展） |
| `SettingsManager.inMemory` 及其 `getCompactionSettings / getBranchSummarySettings / getRetrySettings` | 设置 | `child/session.ts:158,231`、`child/session-navigation.ts:144-146` |
| `ModelRuntime` + pi-ai 的 `InMemoryCredentialStore` | 模型目录和凭据 | `child/session.ts`、`child/probe.ts` |
| `createBashToolDefinition(cwd, {commandPrefix, spawnHook})` + `defineTool` | 换掉内置 bash（额外环境变量、TMPDIR） | `child/session.ts:459-476` |
| `compact()`（底层压缩函数） | 按自定义指令写压缩摘要 | `child/compaction.ts:7` |
| `generateSummaryWithUsage` + `DEFAULT_COMPACTION_SETTINGS` | 写交接摘要 | `child/handoff.ts:20` |
| `collectEntriesForBranchSummary` + `generateBranchSummary` | 写分支摘要 | `child/session-navigation.ts:15-22,137` |
| `convertToLlm` + `serializeConversation` | 把消息转成审视用的文字 | `child/scope-review.ts:17` |
| `resizeImage`（Photon） | 缩小图片 | `child/thumbnails.ts:7` |
| pi-ai 的 `clampThinkingLevel`、`getSupportedThinkingLevels`、`contentText`、`getCurrentTools`、faux provider | 杂项、测试 | `child/session.ts`、`child/probe.ts`、`child/tool-order.ts`、`child/faux.ts` |

### A8. 扩展 API

出处：`PI/docs/extensions.md`、`PI/dist/core/extensions/types.d.ts`

**事件（`pi.on`，共 41 个）**：
`project_trust`、`resources_discover`、`session_start`、`session_shutdown`、`session_before_switch`、`session_before_fork`、`session_before_tree`、`session_tree`、`session_before_compact`、`session_compact`、`session_compact_failed`、`session_info_changed`、`input`、`before_agent_start`、`agent_start`、`turn_start`、`context`、`context_with_system`、`before_provider_headers`、`before_provider_request`、`provider_stream_event`、`after_provider_response`、`message_start`、`message_update`、`message_end`、`tool_call`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`tool_result`、`turn_end`、`agent_before_settle`、`agent_end`、`agent_settled`、`model_select`、`thinking_level_select`、`cache_warming_decision`、`mcp_servers_change`、`ui_prompt_start`、`ui_prompt_end`、`user_bash`。

**二狗用到的 5 个**（都在桥接扩展 `child/bridge.ts:73-98`）：

| 事件 | 二狗拿它做什么 |
|---|---|
| `tool_call` | 守卫转发。可以异步等；返回 `{block, reason}` 拦下；原地改 `event.input` 换参数（`child/guard-forwarding.ts`） |
| `tool_result` | 守卫放行时带了 `resultPrefix`，就加在工具结果前面 |
| `session_before_compact` | 按秘书的压缩指令自己写摘要（`child/compaction.ts`）；范围审视（`child/scope-review.ts`） |
| `session_compact` | 压缩后重新注入上下文块 |
| `before_agent_start` | 系统提示后缀、近期范围记录，每轮现拼 |

**`ExtensionAPI` 的方法**：`registerTool`、`registerCommand`、`registerShortcut`、`registerFlag`、`registerToolRenderer`、`sendMessage`、`sendUserMessage`、`appendEntry`、`setSessionName`、`setLabel`、`exec`、`getActiveTools / getAllTools / setActiveTools`、`setModel`、`setThinkingLevel`、`registerProvider`、`registerMcpServer / unregisterMcpServer`、`registerVirtualModel`、`events`。
- 二狗只用 `on`、`sendMessage`、`appendEntry`。
- 工具不用 `registerTool`，而是作为 `createAgentSession` 的 `customTools` 交进去（`child/host-tools.ts`）。原因是扩展注册的工具撤不掉。

**各种上下文**：
- `ExtensionContext`：`ui`、`mode`、`hasUI`、`cwd`、`sessionManager`、`modelRegistry`、`model`、`signal`、`abort()`、`compact()`、`getContextUsage()`、`getSystemPrompt()`、`shutdown()`。二狗用 `ctx.signal`。
- `ExtensionCommandContext`：`waitForIdle`、`newSession`、`fork(entryId, {position: before|at})`、`navigateTree`、`switchSession`、`reload`。二狗不注册命令，所以都没用。
- `ExtensionUIContext`：`select / confirm / input / notify / setStatus / setWidget / editor / setEditorText …`。只有 TUI 或 RPC 才有界面，二狗没用。

**工具定义**：
- 字段：`name`、`description`、TypeBox 参数、`execute(toolCallId, params, signal, onUpdate, ctx)`，返回 `{content, details, isError, terminate, structuredContent, usage}`；
- 另有 `exposure`（`direct / model-only / codemode / deferred / hidden`）、`annotations`、`executionMode`、`ctx.executeTool`。
- 二狗的做法：把 `HostToolSpec`（参数是 JSON Schema）登记成 `customTools`，模型调用时转成 `host_tool_call` 交给守护进程执行。

### A9. pi 的默认设置（二狗全用默认）

| 设置 | 默认值 | 出处 |
|---|---|---|
| `compaction.enabled` / `reserveTokens` / `keepRecentTokens` | true / 16384 / 20000（用量超过"窗口 − 16384"自动压缩） | `PI/docs/settings.md:70-72` |
| `branchSummary.reserveTokens` | 16384 | `PI/docs/settings.md:85` |
| `retry.enabled` / `maxRetries` / `baseDelayMs` | true / 3 / 2000 | `PI/docs/settings.md:125-128` |
| `steeringMode` / `followUpMode` | one-at-a-time | `PI/docs/settings.md:29-30` |
| `defaultTools` | read、bash、edit、write。可选的内置工具还有 powershell、grep、find、ls、codemode、tool_search | `PI/docs/settings.md:40-44` |

二狗这边：
- 工具白名单：`daemon/agent-host/assembly.ts:44-50`（执行、计划、对话三套）、`daemon/secretary/secretary.ts:98`（秘书，带 bash）；
- 前端也写死了一份 pi 的压缩默认值：`protocol/agent-settings.ts:47` 的 `PI_COMPACTION_DEFAULTS`。**这是 pi 漏到前端的一处耦合。**

### A10. 二狗实际用到 pi 的地方（按文件汇总）

| 文件 | 用了 pi 的什么 | 服务哪条宿主协议消息 |
|---|---|---|
| `child/session.ts` | `createAgentSession`、`DefaultResourceLoader`、`SettingsManager.inMemory`、`ModelRuntime`、`SessionManager.create/open`、`prompt`、`steer`、`sendCustomMessage`（含 `nextTurn`）、`clearQueue`、`getSteeringMessages`、`abort`、`compact`、`subscribe`、`agent.finishTurn`、`appendCustomEntry`、`createBashToolDefinition` | `start` / `user_input` / `interject` / `yield` / `compact` / `abort` / `ready` / `turn_end` |
| `child/event-translator.ts` | `message_*`、`tool_execution_*`、`compaction_end` 事件，pi-ai 的 usage 和 stopReason | `stream_delta` / `message_final` / `tool_call_start` / `tool_call_end` / `usage` / `compacted` |
| `child/bridge.ts` + `child/guard-forwarding.ts` | `tool_call` / `tool_result` 钩子 | `guard_request` / `guard_reply` |
| `child/bridge.ts` + `child/compaction.ts` | `session_before_compact` + `compact()`、`session_compact` + `sendMessage`、`before_agent_start` | `contribution`（上下文块、钩子订阅） |
| `child/host-tools.ts` | `customTools`（`ToolDefinition`） | `host_tool_call` / `host_tool_result` |
| `child/scope-review.ts` | `getBranch`、`convertToLlm`、`serializeConversation`、`appendEntry`、另开一次模型调用 | `scope_context` / `scope_review` / `scope_review_result` |
| `child/session-navigation.ts` | `abort`、`waitForIdle`、`getBranch / getEntry / getLeafId`、`collectEntriesForBranchSummary`、`generateBranchSummary`、`branchWithSummary / branch`、`appendLabelChange`、`appendCustomEntry`、`refreshContext` | `navigate_session` / `session_navigated` |
| `child/handoff.ts` | `generateSummaryWithUsage`、`SessionManager.open`、`buildSessionContext` | `start.handoff` / `ready.handoff` |
| `child/session-recovery.ts` | `getBranch`、`appendMessage` | `start.interruptedToolResults` |
| `child/tool-order.ts` | `agent.transformContext`、pi-ai 的 `getCurrentTools` | 无（保证接着会话时的工具清单和新会话一致） |
| `child/user-invoked-skills.ts` | `Skill` 类型、`appendSystemPromptOverride` | `start.skillPaths` |
| `child/session-rewrite.ts` + `child/rewrite-main.ts` | pi 会话文件的条目类型 | 一次性子进程：彻底删除 |
| `child/probe.ts` + `child/model-probe-main.ts` | `ModelRuntime` 的模型目录、`getSupportedThinkingLevels` | 一次性子进程：模型探查 |
| `child/thumbnails.ts` + `child/thumbnails-main.ts` | `resizeImage` | 一次性子进程：缩图（`view_files`） |
| `child/faux.ts` | pi-ai 的 faux provider | 只给测试用 |

---

## B. 二狗前端对一个会话（维护者 / 秘书）能做的全部操作

"归属"一列三种：
- **运行时**：要运行时本身提供这个能力，换 Claude Code / Codex 时要有等价物或间接实现；
- **混合**：守护进程做主，只要运行时的基础能力（发一条输入、打断、重新拉起）；
- **守护进程**：二狗自己做的，和运行时无关。

网关方法都在 `protocol/constants.ts` 的 `METHODS`，参数登记在 `protocol/request.ts`；HTTP 路径在 `protocol/http.ts` 的 `HTTP_PATHS`。

### B1. 会话控制

| 操作 | 前端出处 | 网关 / HTTP | 宿主协议消息 | pi 能力 | 归属 |
|---|---|---|---|---|---|
| 空闲时发消息 | `web/ui/conversation/Composer.tsx`、`web/app/store.tsx` 的 sendMessage | `send_message` | `user_input`（text、images?、context?）（`daemon/conversation/agent-session.ts:922`） | `prompt`；之前先 `sendCustomMessage`（上下文块）、`appendCustomEntry('ergo-input')`、`sendCustomMessage(nextTurn)` | 运行时 |
| 回复中"追加"（排队） | `Composer.tsx`（回复中发送钮写"追加"）、`web/ui/conversation/ChatItemView.tsx` 的 QueuedBubble | `send_message`（结果 `queued`）+ `message_queue` 事件 | 这一轮结束后，排着的几条合成一条 `user_input` | 只要 `prompt` | 守护进程（`daemon/conversation/message-queue.ts`） |
| 排队的消息叉掉、拖动改顺序 | `web/ui/conversation/queue-drag.tsx` | `queued_message_action`（remove / reorder） | — | — | 守护进程 |
| 停止这一轮（已经说出来的留着，标"已停止"，时间线记"你停止了这一轮"） | `Composer.tsx` 的停止钮 | `stop_reply` | `abort`（`agent-session.ts:698`） | `session.abort` | 运行时 |
| 插话：只有运行时的通知（无进展的催促）、秘书转达的话会插；用户自己的话不插 | 没有单独的按钮；秘书转达发生在秘书会话里 | （发给秘书的 `send_message`） | `interject`（inputId、text、images）→ `turn_end.interjected`、`host_tool_call.interjected`（`agent-session.ts:1508`） | `session.steer` + `getSteeringMessages` | 运行时 ★ |
| 任务暂停、取消 | `web/ui/task-menu.tsx`、`web/ui/task-head.tsx`、看板多选 `web/pages/board-select.tsx` | `task_action`（pause / cancel）、`task_batch_action` | `abort`（`daemon/agent-host/assembly.ts:650`） | `abort` | 混合 |
| 继续、失败后重试、验收通过、退回 | 同上，加待办栏 | `task_action`（resume / retry / accept_stage / return_stage） | 运行时通知作为 `user_input` | `prompt` | 混合 |
| 归档、删除任务 | 同上 | `task_action`（archive / delete） | `exit`（停掉子进程） | `dispose` | 守护进程 |
| 项目开工、停用、重新启用、归档、删除；把任务转成项目 | `web/pages/ProjectsPage.tsx` | `project_action`、`convert_task_to_project` | 按新装配重新拉起 | — | 混合 |
| 定时任务：立即运行一次、改时间、暂停、恢复、跑完自动播报 | `web/ui/task-menu.tsx` | `run_job_now`、`reschedule_job`、`scheduled_job_action`、`set_voice_announce` | `start` + `user_input` | — | 混合 |
| 工具包改了立即生效（项目页 / 任务详情改工具包、批准工具包变更卡、维护者自己增减 skill） | `web/pages/ToolkitEditor.tsx` | `set_toolkit`、`card_action` | `yield` →（`turn_end` 的结局是 yielded）→ `exit` → `start`（新装配）→ `user_input`（"工具包已变更"，`agent-session.ts:984`） | `agent.finishTurn` 返回 end + `clearQueue`；按新装配重建会话 | 运行时 ★ |
| 唤起、闲置退出、排队等名额（界面上是活动状态） | 活动状态点（`activity` 事件） | — | `start` / `exit` / `heartbeat` | `createAgentSession` + `SessionManager.open` | 混合 |
| 崩溃或被杀后接着做 | 会话里一条系统说明；待办里的"中断不确定" | `inbox_action` | `start.interruptedToolResults` | 修好 JSONL + `appendMessage(toolResult)` | 运行时 ★ |

### B2. 输入

| 操作 | 前端出处 | 网关 / HTTP | 宿主协议消息 | pi 能力 | 归属 |
|---|---|---|---|---|---|
| 打字 | `Composer.tsx` | `send_message`（text part） | `user_input.text`。投影规则：时间标记、卡片换成一行摘要、附件按规则处理（`daemon/conversation/agent-input.ts`、`model-projection.ts`） | `prompt` | 混合 |
| 图片附件 | `Composer.tsx`、`web/app/uploader.ts` | HTTP `uploads` / 分片 / `complete` → image part | `user_input.images`（`ready.vision` 为真时；否则投影成占位） | `prompt` 的 `images`（ImageContent）；模型的 input 里有 image | 运行时 |
| 文件附件 | 同上 | file part | 投影里内联或只给名字，再加宿主工具 `read_attachment` | `customTools` | 混合（`daemon/media/attachment-tools.ts`） |
| 作为材料投喂 | `Composer.tsx` 的 asMaterial | file part 带 asMaterial | 同上 | — | 守护进程（素材） |
| 语音（按住说） | `web/plugins/voice/VoiceInput.tsx` | 上传 → voice part；识别完推 `voice` 事件 | `user_input.text`（注明"语音转写"） | `prompt` | 守护进程 |
| 网页上的悬浮按钮按住说 | `web/app/page-voice.ts` | HTTP `pageVoice` → 秘书会话 | `user_input` | `prompt` | 守护进程 |
| 浏览侧边栏里发（带当时的网页和选中的框） | `web/plugins/browsing/BrowseSidebar.tsx` | `send_message.browsing` | `user_input` + 输入附注（插件的 inputNote） | `prompt` | 守护进程 |
| 引用卡片 | `ChatItemView.tsx` 的 onQuote、store 的 `quoteCard` | card_ref part | 投影成一行摘要 | — | 守护进程 |
| 斜杠命令：`/流程`、`/任务`，加上这个会话能用的 skill | `web/ui/conversation/SlashMenu.tsx`、`web/state/slash-commands.ts` | HTTP `slashCommands` | 守护进程先把 `/目录名` 展开成 skill 全文，再作为 `user_input`；`/流程`、`/任务` 由秘书按"点明"判断 | pi 只负责加载 skill（`additionalSkillPaths`）；"只在用户点名时用"的 skill 那一段接在系统提示后面（`appendSystemPromptOverride`） | 守护进程（`daemon/skills/skill-command.ts`、`daemon/slash-commands/`） |
| 放大输入框 | `Composer.tsx` | — | — | — | 纯前端 |
| 在任务详情里说（项目内部的普通任务会带 taskId） | `web/pages/TasksPage.tsx` | `send_message.taskId` | `user_input`（派一张执行的工单） | — | 守护进程 |
| 回答提问卡、卡片附说明 | `web/ui/cards/*` | `card_action`（answer / note） | 作为通知走 `user_input`，或作为 `host_tool_result` | — | 混合 |
| `@文件`、`!命令` | **没有** | — | — | pi 有 | — |

### B3. 显示

| 操作 | 前端出处 | 网关 / HTTP | 宿主协议消息 | pi 能力 | 归属 |
|---|---|---|---|---|---|
| 流式回复、"正在想…" | `ChatItemView.tsx`、`web/ui/conversation/rows.tsx` | `stream` 事件（临时，每 100 毫秒最多一帧，`daemon/conversation/stream-hub.ts`） | `stream_delta`（text / thinking） | `message_update` 的 `text_delta` / `thinking_delta` | 运行时 |
| 定稿的回复（Markdown，能收起展开） | `rows.tsx` 的 AssistantBubble | `message` 事件（text、reasoning part） | `message_final`（parts、stopReason） | `message_end` | 运行时 |
| 思考一行，点开看全文 | `rows.tsx` 的 ThinkingRow | reasoning part | `message_final` 里的 thinking part | 模型给出的 thinking 内容 | 运行时（看模型给不给思考原文） |
| 工具调用组"调用了 N 个工具 ›" | `ChatItemView.tsx` | tool_call part（`daemon/guard-runtime/tool-call-record.ts`） | `tool_call_start` / `tool_call_end` | `tool_execution_start / end` | 运行时 |
| 单次工具调用的详情：参数、守卫怎么判的、返回、图片块、截断说明 | `web/ui/detail/DetailPane.tsx` | HTTP `GET /api/tool-calls/<id>`（`daemon/guard-runtime/tool-call-details.ts`） | `tool_call_start.args`、`tool_call_end.resultText / media`、`guard_request` | `tool_execution_end` 的结果 | 混合 |
| 回忆记忆一行、记忆简报 | `web/plugins/memory/RecallLine.tsx`、`RecallDetail.tsx` | memory_brief part | `user_input.context`（简报作为上下文消息） | `sendCustomMessage` 的 `nextTurn` | 混合 |
| 来信一行（任务做完、维护者来信、秘书转达） | `rows.tsx` 的 LetterLine | `message.summary` | `user_input`（通知）或 `interject` | — | 守护进程 |
| 分隔线：工单、运行、清空、分支摘要；"已换成 X 模型，接着之前的对话" | `web/ui/conversation/parts.tsx` | work_order_divider / run_divider / conversation_cleared / branch_summary part | `ready.handoff`、`session_navigated.summary` | — | 混合 |
| "已停止"标记 | `ChatItemView.tsx` | `turn_end` 的结局 | `turn_end`（aborted） | `agent_settled` + stopReason | 运行时 |
| 时间线记录：压缩过一次、你停止了、偏离、范围变更 / 越界、重做、计划变更… | `web/ui/conversation/RecordRow.tsx`；种类表在 `protocol/timeline.ts` | `timeline_record` | `compacted`、`scope_review_result` 等 | `compaction_end` | 混合 |
| 缩放三档（对话层、要点层、全局层）：双指捏合、Ctrl+滚轮、▤ / 💬 | `web/ui/zoom/ZoomHistory.tsx`、`zoom.ts` | — | — | — | 纯前端 |
| 阶段框、阶段抽屉 / 阶段栏、阶段详情、出过的状况 | `web/ui/conversation/StageBox.tsx`、`StageDrawer.tsx`、`web/ui/detail/StageDetail.tsx`、`incidents.tsx` | `task` 事件、HTTP `taskStage` | — | — | 守护进程 |
| 流程的计划台账、"接下来的计划"虚线框 | `web/ui/conversation/PlanTimeline.tsx`、`web/ui/zoom/future.tsx` | — | — | — | 守护进程 |
| "等你处理"栏 | `web/ui/conversation/InboxBar.tsx` | `inbox_action` | — | — | 守护进程 |
| 活动状态（休眠、干活中、等你、排队）和"此刻在做什么" | 活动状态点 | `activity` / `activity_progress` | `turn_*`、`tool_call_start`、等审批 | — | 混合 |
| 用量和消耗：任务卡、详情的消耗栏、设置 · 消耗页 | `web/state/usage.ts`、`web/pages/more/UsagePage.tsx` | `token_totals`、HTTP `usage` | `usage`（input / output / cacheRead / cacheWrite / purpose） | `message_end` 里的 usage；摘要那几次调用的 usage | 运行时 ★ |
| 往上翻历史、在对话中定位、详情页 | `web/ui/conversation/Conversation.tsx`、`DetailPane.tsx` | HTTP `history` | — | — | 守护进程 |
| 已读位置（秘书会话） | `web/pages/SecretaryPage.tsx` | `mark_read` | — | — | 守护进程 |
| 语音气泡：播放、自动播放、转文字、复制文字、重新识别 | `web/ui/conversation/VoiceBubble.tsx` | `retry_voice`、HTTP `agentVoiceSegment` | agent 调发语音的宿主工具；追问口语总结时发一条 `user_input`（`agent-session.ts:1571`） | — | 守护进程 |
| 文件卡片的预览、下载；图片查看 | `parts.tsx` 的 FileCards、`web/ui/image-viewer.tsx` | HTTP `media` | 宿主工具 `send_attachment` | — | 守护进程 |
| 范围记录列表 | `web/ui/scope-records.tsx` | `scope_record` | `scope_review_result` | — | 混合 |

### B4. 审批和守卫

| 操作 | 前端出处 | 网关 / HTTP | 宿主协议消息 | pi 能力 | 归属 |
|---|---|---|---|---|---|
| 每次工具调用都经守卫：放行、拦下、交给我做、先问我 | 工具调用详情里显示判定 | — | `guard_request` → `guard_reply`（allow / deny） | `pi.on("tool_call")` 异步阻塞，返回 `{block, reason}` | 运行时 ★ |
| 审批卡：批准、拒绝。最多等 5 分钟，超时挂起；挂起之后再批准，记成一次性授权，并给 agent 递一条通知 | `web/ui/cards/cards.tsx` | `card_action`（approve / deny） | `guard_reply`；晚到的决定作为通知走 `user_input` / `interject` | 同上 | 混合（`daemon/guard-runtime/approval-waits.ts`） |
| 流程计划核对：按计划改回参数再放行，结果前面写明执行的是哪一版 | 无界面操作 | — | `guard_reply`（allow、args、resultPrefix） | `tool_call` 里原地改 `event.input` + `tool_result` 改 content | 运行时 ★ |
| 快速动作卡：执行、取消 | `web/ui/cards/*` | `card_action`（execute / cancel） | 宿主工具 `propose_quick_action` | `customTools` | 守护进程 |
| 交给我做；中断不确定（"已经执行了"、"没执行"） | `InboxBar.tsx`、`web/ui/inbox-notice.tsx` | `inbox_action` | 下次 `start` 的 `interruptedToolResults` / `user_input` | — | 混合 |
| 计划卡、计划变更、立项书、工具包变更、MCP 变更、并行确认、首版做完、转入使用、运营方案… | `web/ui/cards/*` | `card_action` | 宿主工具提交（提交计划等），结果作为通知交回 | `customTools` | 守护进程 |
| 对话审批的开关 | 配置 `guard.conversationApprovals`（默认关） | — | — | — | 守护进程 |
| 范围审视：压缩时自动做，工单结束时要一次 | 范围记录、时间线 | — | `scope_context` / `scope_review` → `scope_review_result`；装配参数 `scopeReview` | `session_before_compact`、`before_agent_start`（拼近期范围记录）、`appendEntry`（副本）、`convertToLlm` / `serializeConversation`、另开一次模型调用 | 运行时 ★ |

### B5. 会话历史编辑

| 操作 | 前端出处 | 网关 / HTTP | 宿主协议消息 | pi 能力 | 归属 |
|---|---|---|---|---|---|
| ↶ 撤回：回到这条请求之前 / 这条分支开始前 / 这个阶段开始前 / 这个流程步骤开始前。之前先看"已经做了的事" | `web/ui/zoom/ZoomHistory.tsx`、`web/ui/zoom/rollback.tsx`、`web/ui/conversation/StageBox.tsx`；落点算法在 `web/state/zoom-decor.ts` | HTTP `rollbackPreview`（守卫的效果日志）→ `rollback_session`（`daemon/conversation/rollback.ts`） | `navigate_session`（target 是 beforeInput / entry / beforeCall / afterCall，带 `summary.instructions` 和 marker）→ `session_navigated`（from、at、summary）+ `usage`（branch_summary）（`agent-session.ts:761`） | `abort` + `waitForIdle`、`getBranch`、`collectEntriesForBranchSummary`、`generateBranchSummary`、`branchWithSummary`、`appendLabelChange`、`appendCustomEntry('ergo-branch')`、`refreshContext` | 运行时 ★ |
| ⑂ 废弃分支的预览和详情（遗留效果、分支摘要、完整历史） | `web/ui/zoom/branches.tsx`、`web/ui/detail/BranchDetail.tsx`、`web/state/abandoned-branch.ts` | HTTP `branchView` | — | — | 守护进程 |
| 切换到这条分支 | `web/ui/zoom/branches.tsx` | `switch_branch` | `navigate_session`（entry 是那条分支的末端，不写摘要） | `branch` + `appendCustomEntry` + `refreshContext` | 运行时 ★ |
| 对一件遗留效果"申请撤回" | `BranchDetail.tsx` | `request_effect_undo` | — | — | 守护进程 |
| 从这里重做（阶段返工，可以顺手改验收标准、交付件） | `web/ui/detail/StageDetail.tsx` | `task_action`（rework，带 stageId、note、stageEdit） | `abort` + `user_input`（重做通知）。**不动会话树** | `abort`、`prompt` | 混合 |
| 彻底删除（素材详情、成批删除、记忆删除卡） | `web/pages/more/MaterialDetail.tsx`、`MaterialsBulkDelete.tsx`、`web/plugins/memory/MemoryDeleteCard.tsx` | HTTP `materialsDelete` / `card_action` | 停掉子进程 → 一次性子进程改写会话文件（`SessionRewriteRequest`）→ 重新拉起 | pi 会话 JSONL 的条目类型（message / custom / custom_message / compaction / branch_summary）；按 `ergo-input` 找原话 | 运行时 ★ |
| 清空当前对话（秘书、任务的维护者） | `web/ui/agent-settings.tsx` | HTTP `agentClear` | `start.freshSession` | `SessionManager.create` 一个新文件 | 混合 |
| 重置维护者（项目维护者的"清空"） | `web/ui/agent-settings.tsx` | `reset_maintainer` | 新开一段：`start`（`session` 是新段的名字） | 新会话文件 | 混合 |
| 现在压缩 | `web/ui/agent-settings.tsx` | HTTP `agentCompact` | `compact` → `compacted`（reason、outcome、tokensBefore）+ `usage`（compaction）（`agent-session.ts:1139`） | `session.compact()`；`session_before_compact` 里按压缩指令自己写摘要（`compact()`）；`session_compact` 之后 `sendMessage` 重注入上下文块 | 运行时 ★ |
| 自动压缩（没有按钮，时间线上显示） | `RecordRow.tsx` | — | `compacted`（threshold / overflow） | pi 自动做（窗口 − 16384） | 运行时 |
| 导出、复制会话 | **没有** | — | — | pi 有 | — |

### B6. 设置

| 操作 | 前端出处 | 网关 / HTTP | 宿主协议消息 | pi 能力 | 归属 |
|---|---|---|---|---|---|
| ⚙ 名字和音色（选角色） | `web/ui/agent-settings.tsx`、`web/pages/more/RolesPage.tsx` | HTTP `agentRoleAssignment` / `agentRoles` | 系统提示变了就重新拉起 | `systemPrompt` | 守护进程 |
| ⚙ 单独的提示词（追加 / 整份自己写），查看实际在用的系统提示 | `web/ui/agent-settings.tsx`、`web/state/agent-settings.ts` | HTTP `agentPrompt`（PUT / DELETE） | 下一轮重新拉起，装配参数 `systemPrompt` | `DefaultResourceLoader` 的 `systemPrompt`（整份替换 pi 默认的） | 混合 |
| ⚙ 上下文用量、上次压缩、离自动压缩还有多少 | 同上 | HTTP `agentSettings` | `ready.context`（window、reserveTokens、keepRecentTokens）+ 最近一次 `usage.totalTokens` + `compacted` | `settingsManager.getCompactionSettings`、`model.contextWindow` | 运行时 |
| ⚙ 模型和思考档位（任务、项目的维护者单独配） | `web/ui/agent-settings.tsx` | HTTP `agentModel`（PUT / DELETE） | 下一个新会话 / 下一段 / 下一次运行时生效：`start`（model、handoff）→ `ready.model / handoff` + `usage`（handoff） | `generateSummaryWithUsage` + 新会话 + `sendCustomMessage`（交接摘要）。**不用 `setModel`** | 运行时 ★ |
| 设置 · 模型：各 agent 的默认模型和思考档位、看图能力、连通测试、列出模型 | `web/pages/more/ModelsPage.tsx` | HTTP `modelSettings` / `modelSettingsTest` | 一次性子进程 `ModelProbeRequest`（catalog / ping） | `ModelRuntime` 的模型目录、`getSupportedThinkingLevels`、模型 input 里有没有 image | 运行时 |
| 工具包：skill、MCP、bash、联网 | `web/pages/ToolkitEditor.tsx`、`web/ui/skill-picker.tsx` | `set_toolkit`、HTTP `toolkitCatalog` | `start`（tools 白名单、skillPaths、contributions.tools、shellEnv）+ 用 `yield` 重新装配 | tools 白名单、`additionalSkillPaths`、`customTools`、`createBashToolDefinition(spawnHook)` | 运行时 |
| 秘书用哪些 skill | `web/pages/more/SkillsPage.tsx` | HTTP `secretarySkills` | `skillPaths` | 同上 | 混合 |
| 系统提示模板 | `web/pages/more/PromptsPage.tsx` | HTTP `systemPrompts` | `systemPrompt` | 同上 | 混合 |
| 联网搜索、读网页走哪条路 | `web/pages/more/WebToolsSetting.tsx` | HTTP `webSettings` | 宿主工具 | `customTools` | 守护进程 |
| 插件启停（记忆、浏览、语音、提醒、日历） | `web/pages/more/PluginsPage.tsx` | HTTP `plugin` | contributions（工具、上下文块、钩子）变了就重新装配 | `customTools`、`sendCustomMessage`、`before_agent_start`、`session_before_compact` | 混合 |
| 工具调用完整内容保留多久、界面语言 | `web/pages/more/ToolCallStorageSetting.tsx`、`LanguagePage.tsx` | HTTP | — | — | 守护进程 |

### B7. pi 有、二狗前端没有的（"不覆盖"的候选）

| pi 的能力 | 出处 | 二狗现状 | 以后要不要补（留给对照 Claude Code 时定） |
|---|---|---|---|
| `@` 搜文件插进提示 | `PI/docs/usage.md` | 没有 | Claude Code 也有 `@`，是三方的交集候选 |
| `!cmd` / `!!cmd` 用户直接跑命令 | `PI/docs/usage.md`、RPC `bash` | 没有 | — |
| `/export`、`/share`、`/copy` | `PI/docs/slash-commands.md` | 没有 | 守护进程有事件日志，可以自己导出，不依赖运行时 |
| `/tree` 跳到任意节点、编辑后重发、节点标签和过滤 | `PI/docs/sessions.md`、`PI/docs/keybindings.md` | 只能撤回到"用户消息、分支开始、阶段或步骤开始之前"，以及切回废弃分支的末端；撤回后不把原文放回输入框 | — |
| `/fork`、`/clone`、`/import` | 同上 | 没有 | — |
| `/resume` 切历史会话、`/name` | 同上 | 守护进程自己决定接哪个会话，界面不给选 | — |
| 会话中途 `/model`、`/thinking`、Shift+Tab | 同上 | 故意不做：一个会话固定一个模型（73、83 号票） | — |
| followUp 队列（Alt+Enter）、`set_steering_mode` | `PI/docs/rpc-commands.md` | 用守护进程自己的排队代替；用户的话不插话 | — |
| 自动重试、自动压缩的开关 | 同上 | 全按 pi 默认，界面不给改 | — |
| `/session` 统计（成本） | 同上 | 用量走二狗自己的账本 | — |
| 扩展命令、提示模板、主题、项目上下文文件（AGENTS.md） | `PI/docs/extensions.md`、`prompt-templates.md` | 全部关掉（`child/session.ts:171-190`） | — |

### B8. 宿主协议消息反查：每条消息被哪些前端操作用到、靠 pi 的什么

**命令（守护进程 → 子进程，`host-protocol.ts` 的 `HostCommand`）**

| 命令 | 触发它的前端操作 | 子进程里的 pi 能力 |
|---|---|---|
| `start`（`SessionAssembly`） | 任何需要唤起的操作：发消息、清空、换模型、工具包或提示词变了、崩溃后重拉 | `createAgentSession`、`DefaultResourceLoader`（资源全关、只加载 skill、换系统提示）、`SessionManager.create/open`、`customTools`、bash 替换、`finishTurn` / `transformContext` 包装；handoff（交接摘要）、interruptedToolResults（补工具结果）、freshSession、vision |
| `user_input`（text、images、context） | 发消息（含排队合成的一批）、各种运行时通知（继续、退回、重做、工具包已变更、卡片结果）、追问口语总结 | `prompt` + `sendCustomMessage`（上下文块、`nextTurn`）+ `appendCustomEntry('ergo-input')` |
| `interject` | 运行时通知（催促）、秘书转达的话 | `steer` |
| `yield` | 工具包或装配变了 | `agent.finishTurn` 返回 end、`clearQueue` |
| `contribution` | 重注入块（阶段推进、授权变了）、插件的上下文块和钩子文字变了 | 桥接扩展里换文字：`sendCustomMessage`、`before_agent_start`、`session_before_compact` |
| `scope_context` / `scope_review` | 没有直接按钮：对照物变了、工单结束时 | `getBranch`、`convertToLlm`、`serializeConversation`、另开模型调用、`appendEntry` |
| `compact` | ⚙ 的"现在压缩" | `session.compact()` |
| `guard_reply` | 审批卡的批准 / 拒绝；守卫的自动判定 | `tool_call` 钩子放行或拦下、原地改参数；`tool_result` 加前缀 |
| `host_tool_result` | 二狗的宿主工具（卡片、附件、MCP、提醒、记忆、浏览…）执行完 | `customTools` 的 execute 返回 |
| `navigate_session` | ↶ 撤回、切换分支 | `branch / branchWithSummary`、`generateBranchSummary`、`appendCustomEntry`、`refreshContext` |
| `abort` | 停止、任务暂停 / 取消 / 重做 | `session.abort` |
| `exit` | 闲置退出、换装配、删除任务 | `dispose` |
| `work_order` | 没实现（子进程回 `unsupported`） | — |

**上报（子进程 → 守护进程，`AgentReport`）**：

| 上报 | 驱动哪些显示 | 来源（pi） |
|---|---|---|
| `ready`（sessionId、sessionFile、session、loaded、vision、model、context、handoff） | 活动状态、⚙ 的上下文窗口、"已换成 X 模型" | 建会话后读 `session.*`、`settingsManager.getCompactionSettings` |
| `stream_delta` | 流式回复、"正在想…" | `message_update` |
| `message_final` | 定稿的回复和思考 | `message_end` |
| `tool_call_start` / `tool_call_end` | 工具调用组、调用详情、活动进度 | `tool_execution_start / end` |
| `guard_request` | 审批卡、守卫判定 | `tool_call` 钩子 |
| `host_tool_call` | 卡片、附件、语音等宿主工具 | `customTools` 的 execute |
| `usage` | 消耗、⚙ 的上下文用量 | `message_end` 的 usage；压缩、分支摘要、交接摘要、范围审视那几次调用的 usage |
| `turn_end`（completed / aborted / error / yielded，interjected） | "已停止"、出队、排队消息交出 | `agent_settled` + stopReason |
| `compacted` | 时间线"压缩过一次"、⚙ 的上次压缩 | `compaction_end` |
| `session_navigated` | 撤回、切换的结果，分支摘要消息 | 见 `navigate_session` |
| `scope_review_result` | 范围记录、时间线的越界 / 范围变更 | 另开的模型调用 |
| `error` / `heartbeat` | 日志、存活检测 | — |

**一次性子进程**：

| 子进程 | 用在哪 | 靠 pi 的什么 |
|---|---|---|
| `child/rewrite-main.ts`（`SessionRewriteRequest`） | 彻底删除 | pi 会话 JSONL 的格式（★ 和运行时的会话存储格式强绑定） |
| `child/model-probe-main.ts`（`ModelProbeRequest`） | 设置 · 模型：列模型、连通测试 | `ModelRuntime` 的模型目录 |
| `child/thumbnails-main.ts` | 秘书的 `view_files` 缩图 | `resizeImage` |

---

## C. 给对照 Claude Code 那份时的提示（只列事实上的接缝，不下结论）

1. **前端完全不认运行时，认的是宿主协议**。所以"取交集"在宿主协议这一层做最省事：前端几乎不用动，Claude Code / Codex 各写一个子进程，把它们的会话事件翻译成同一套上报。
2. **前端里直接带着 pi 痕迹的只有两处**：
   - `protocol/agent-settings.ts:47` 的 `PI_COMPACTION_DEFAULTS`（16384 / 20000），⚙ 写说明时用；
   - 分支摘要的文字去掉了 pi 加的开头和文件清单（`child/session-navigation.ts:39-46`）。这一处在子进程里，前端看不到。
3. **★ 项是间接实现的重点**。每一项先查 Claude Code 有没有对应的原语：
   - 会话树、分支摘要；
   - 改写会话文件；
   - 工具调用前异步拦截和改参数；
   - 不显示但进上下文的消息；
   - 压缩的钩子和自定义摘要；
   - 两次模型调用之间停下；
   - steer，以及"已经进了上下文"的回执；
   - 固定模型加交接摘要；
   - 补被中断的工具结果；
   - 只加载指定的资源；
   - 四段用量；
   - 模型目录。

   没有的，要么在守护进程里做（比如分支视图已经是守护进程的事件日志在推导），要么在子进程里模拟（比如用新会话加摘要代替原地回退）。
