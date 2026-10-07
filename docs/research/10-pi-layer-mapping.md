# 调研 10：pi 1.0 各层能力映射（对照二狗运行时需求）

> - **问题**：对照二狗的 11 项运行时需求（票 `.scratch/ergou-v2/issues/01-pi-layer-mapping.md`），逐项判断 pi 1.0 的三层各提供什么、缺什么，推荐用哪一层，列出要自建的部分。
>   - (A) `@earendil-works/pi-agent-core` 的 `Agent` 类 + `@earendil-works/pi-ai`；
>   - (B) `@earendil-works/pi-coding-agent` 当 SDK 用，加它的扩展 API；
>   - (C) `@earendil-works/pi-durable`。
> - **快照**：npm `latest` 都是 `1.0.4`（2026-10-05）。四个包的 npm `gitHead` 都是 `7c10bd4337495ee613f2224843ecdf349b80d1df`，也就是 GitHub 上的 "Release v1.0.4" 提交。main 分支当时的 HEAD 是 `ae92585`（2026-10-06），上面已有未发布的改动。
> - **方法**（2026-10-07）：
>   - 用 `npm pack <包>@1.0.4` 下载四个发布包，读 `.d.ts`、`dist/*.js`、README、CHANGELOG、docs。
>   - 从 GitHub 的 release 提交拉取 agent / ai 的 CHANGELOG、durable 的 `docs/spec.md` 和例子 23。
>   - 安装时加了 `--ignore-scripts`，装在隔离目录里，自己另写了 4 个最小探针脚本（附录 A）。所有模型调用都用 pi-ai 的 faux provider 或打桩的 `fetch`，**没有发出任何真实的网络请求**。
>   - 读了 AgentSense 的 `web/src/agent/runtime.ts`，以及它 `node_modules` 里 `pi-agent-core@0.85.1` 的 `agent-harness.d.ts`。
> - **标注**：
>   - 不加标的是事实，后面附来源。
>   - 【实测】表示用探针跑过（附录 A）。
>   - 【判断】是本文作者的分析或建议。
>   - 【未核实】表示没能在一手资料里确认，或者没有实测。
> - **来源记法**：
>   - `PI/` = `https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/`（v1.0.4 发布提交）。
>   - `PIMAIN/` = `https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/`（main，含未发布改动）。
>   - `[A]` = `@earendil-works/pi-agent-core@1.0.4` 发布包，`[AI]` = `@earendil-works/pi-ai@1.0.4`，`[CA]` = `@earendil-works/pi-coding-agent@1.0.4`，`[DU]` = `@earendil-works/pi-durable@1.0.4`。后面跟的是包内路径和行号，例如 `[DU] dist/harness/tool.js:35-58`。用 `npm pack @earendil-works/pi-durable@1.0.4` 可以复现。
>   - `REF/` = AgentSense 仓库 `D:\code\claudecode\user_agent_sense_of_security`。

---

## 0. 结论速览

1. **推荐【判断】**：
   - 运行时引擎用 **pi-ai + pi-durable**，包在二狗自己的一层薄 Runtime 端口后面。
   - `pi-agent-core` 的 `Agent` 留作降级备胎：它的 hook 语义和端口一一对应，见探针 A。
   - **不把 pi-coding-agent SDK 当运行时**，只借鉴它的 `navigateTree` 分支摘要、扩展写法和提示词。
   - 理由：需求 6（崩溃续跑、恢复待审批）和需求 7（子 agent）最难做对，而只有 durable 原生提供；它的 hook 也覆盖了 AgentSense 的全部用法。代价是 durable 自称 "Experimental. The API changes without notice"，所以必须锁版本、写合同测试、留好退路（§6、§7）。
2. **意外 1：pi-durable 不建在 `Agent` 之上。**
   - 它的依赖只有 `chord`、`pi-ai`、`diff`、`typebox`，**没有 `pi-agent-core`**（`[DU] package.json` 的 dependencies）。
   - generation 和工具循环是它自己用持久化任务重写的（`[DU] dist/harness/generation.js`、`dist/harness/tool.js`）。
   - 所以"在 Agent 上叠一层 durable"不成立：选 durable，就等于换了一套循环。三层真正共享的只有 pi-ai。
3. **意外 2：三层的"分段 system prompt"最后都落到 pi-ai 的 `SystemMessage.sections`。可是 pi-ai 目录里的 `deepseek-flash` 没有开 `supportsMidConvoSystemMessages`。**
   - 后果是：任何分段更新、工具集变化，都会被折叠进开头那条 system 消息。请求前缀从第 0 个 token 起就变了，DeepSeek 的前缀缓存整段失效。
   - `deepseek-v4-pro` 开了这个开关，更新是追加在末尾的，前缀不变（【实测】探针 B，§4.9）。
4. **意外 3：durable 的崩溃恢复实测可用。**
   - 让子进程在 `beforeTool` 里等待审批，然后用 SIGKILL 杀掉。重开同一份存储后，工具任务处于 `ready` 状态；`beforeTool` 重跑一次，`memo` 里读回同一个 approvalId；工具随后执行，整个 run 正常完成（【实测】探针 C）。
   - "守护进程重启后恢复待审批状态"因此有了可行的落点（§4.6）。
5. **AgentSense 用到的东西，迁移情况如下**：
   - 三个 hook（`before_tool`、`after_tool`、`before_run_end`）和 `appendCustomEntry`，三层都有等价物（【实测】探针 A、C、D）。
   - "原地回退 + 分支摘要"的 `navigateTree`，只有 coding-agent 原样保留。durable 只能用 `fork` 生成一个新会话，摘要要自己生成。agent-core 1.0 什么都没有。
6. **DeepSeek**：
   - 09 号文档提到的两个坑都核实了：
     - 坑 1：不传 reasoning 时，pi-ai 发 `thinking:{type:"disabled"}`。而 `Agent` 和 durable 的默认 thinkingLevel 都是 `"off"`；coding-agent 默认 `"medium"`，对 flash 会被 clamp 到 `"high"`。
     - 坑 2：目录里的成本按高峰价算。durable 的 `pi.usage` 也基于这个价。
   - `reasoning_content`：同一模型时原样回传；没有思考内容的轮次补空串 `""`。
   - 新发现：**跨模型的历史**（例如 v4-pro 生成的轮次发给 flash）里，推理会被改写成可见的 `content` 文本（【实测】探针 B，§4.10）。
7. **版本**：
   - 四个包从同一个提交同步发版，但包之间互相依赖用的是 `^1.0.4`，必须用 `overrides` 加 lockfile 锁死。
   - 0.74.0（2026-05-07）以来，pi-ai 有 14 个版本带 Breaking Changes，agent-core 有 9 个，coding-agent 有 9 个。durable 1.0.3 和 1.0.4 连续两个版本都有破坏性变更，main 上还排着下一批（§7）。

---

## 1. 三层分别是什么

| 层 | 是什么 | 依赖 | 持久化 | 本文结论的依据 |
|---|---|---|---|---|
| (A) `pi-agent-core` `Agent` + `pi-ai` | 1.0 起只剩 `Agent`、agent loop、proxy stream 和它们的类型。`AgentHarness`、会话、compaction、skills 全删了（agent CHANGELOG 1.0.0：[PI/packages/agent/CHANGELOG.md](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/agent/CHANGELOG.md)） | `pi-ai`、`typebox 1.3.27`（`[A] package.json`） | 没有：状态全在内存（`AgentState`，`[A] dist/types.d.ts`） | 探针 A |
| (B) `pi-coding-agent` SDK + 扩展 | `createAgentSession()` → `AgentSession`。它包住一个 `Agent`：`tool_call` 扩展事件就是接在 `Agent.beforeToolCall` 上的（`[CA] dist/core/agent-session.js:320-345`）。外加 `SessionManager`（JSONL 会话树）、扩展 runner、资源发现、MCP、codemode 等 | `pi-agent-core`、`pi-ai`、`pi-tui`、`pi-codemode`、`pi-mcp`、`chord`、`photon-node`、`jiti`、`undici` 等（`[CA] package.json`） | 每条 entry 同步追加到 JSONL（`[CA] dist/core/session-manager.js:794-813`） | 探针 D |
| (C) `pi-durable` | 持久化的 harness：Conversation / Entry / Commit / Document / Task / Submission。generation 和 tool 都是持久化任务（[README Concepts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/README.md)） | `chord`、`pi-ai`、`diff`、`typebox`，**不依赖 agent-core**（`[DU] package.json`） | Memory / SQLite（`node:sqlite` 的 `DatabaseSync`，`[DU] dist/storage/sqlite/node.js:3`）/ JSONL | 探针 C |

---

## 2. 需求 × 层 矩阵

图例：✅ 提供 · ◐ 部分（能用，但要补关键的一块） · ✗ 缺（要自建）。每格的详细证据见 §4 对应小节。

| # | 需求 | (A) agent-core `Agent` + pi-ai | (B) coding-agent SDK + 扩展 | (C) pi-durable |
|---|---|---|---|---|
| 1 | 工具调用前拦截、改参数、异步等用户决定 | ◐ `beforeToolCall` 可以 async，返回 `{block, reason, terminate}`；**没有改参数的返回字段**，只能原地改 `context.args`（未文档化，改后不重新校验）。`[A] dist/types.d.ts:44,279`；【实测】A | ✅ `pi.on("tool_call")` 可以 async，返回 `{block, reason, terminate}`；文档明说可以原地改 `event.input`，但改后不重新校验。`[CA] dist/core/extensions/types.d.ts:1054,1189`；【实测】D | ✅ `hook(ToolTask,{beforeTool})` 可以 async，返回 `{arguments}`（链式替换，**替换后重新校验**）或 `{block}`；hook 抛异常等于拦截；用 task `memo` 做持久化决定。`[DU] dist/harness/types.d.ts:556-563`、`dist/harness/tool.js:35-58`；【实测】C |
| 2 | 工具调用后附加判定 | ✅ `afterToolCall` → `{content, details, isError, usage, terminate, structuredContent}`，逐字段替换。`[A] dist/types.d.ts:69,293`；【实测】A | ✅ `pi.on("tool_result")` → `{content, details, isError, usage, structuredContent}`，多个 handler 依次叠加。`types.d.ts:1079`；【实测】D | ✅ `afterTool(call, result)` → 整个结果替换；**收到的是模型原始参数**，改写信息要靠 memo 传过来。`types.d.ts:563`、`tool.js:307-309`；【实测】C |
| 3 | 一轮结束前催促模型继续（`before_run_end` 的 followUp） | ✅ 在 `finishTurn` 里调 `agent.followUp(msg)`；或者 `finishTurn→{action:"continue"}`（不带消息）；或者用 `prepareNextTurn` 带上消息。`[A] dist/types.d.ts:131`、`dist/agent-loop.js:179-200`；【实测】A | ✅ `agent_before_settle` → `{entries:[{type:"custom_message",…}], continue:true}`。`types.d.ts:766`；【实测】D | ✅ `hook(GenerationTask,{onYield → {continue}})`，追加一条 `pi.user`；**但这个边界上如果已经选中了用户输入，催促就不生效**。`generation.js:393-420`；【实测】C |
| 4 | 写不进模型上下文的自定义记录 | ◐ 用 declaration merging 扩出自定义 `AgentMessage` 角色，再在 `convertToLlm` 里过滤掉；**只在内存里**。`[A] dist/types.d.ts:186,315`；【实测】A | ✅ `pi.appendEntry(type, data)` / `SessionManager.appendCustomEntry`，写成 JSONL 里的 `custom` 条目。`types.d.ts:1237`、`session-manager.d.ts:273`；【实测】D | ✅ 不带 `model` 字段的 entry（`submit({type:"write"})`、`tx.appendEntry`），以及 `defineDoc` 类型化文档。`[DU] dist/types.d.ts:278`；【实测】C |
| 5 | 会话树回退 + 分支摘要 | ✗ 1.0.0 删了会话和 `navigateTree` | ✅ `session.navigateTree(target,{summarize, customInstructions, replaceInstructions, label})`，生成 `branch_summary` 条目。`agent-session.d.ts:843-853`；【实测】D | ◐ `conversation.fork(at)` 生成一个**新会话**；文档可以设 `history:"rewindable"` + `fork:"asOf"`，跟着回到分叉点；**没有分支摘要**。`types.d.ts:475`、README |
| 6 | 进程崩溃后续跑；守护进程重启后恢复待审批状态 | ✗ 只在内存里 | ◐ 已经定稿的消息落了盘，但没有自动续跑；流式中的回复、正在跑的工具、`tool_call` 里等着的审批都会丢 | ✅ 先提交再显示；`harness.resume()`；执行前先写 intent，`replay:"safe"` 的工具才重跑；`requestId` 保证幂等；hook 会重跑，配合 memo。【实测】C：SIGKILL 后恢复成功 |
| 7 | 子会话 / 子 agent：各自配置模型、工具、指令，父子能通信 | ✗ 自己 new 多个 `Agent`，其余全自建 | ◐ 可以在进程内建多个 `createAgentSession()`；官方 subagent 示例走的是 `pi --mode json` 子进程；**没有父子原语** | ✅ 任务拥有的会话加 `configure({model, thinkingLevel, extensions, tools, instructions, cwd})`；有后台 anchor、steer / followUp 提交、`taskGraph()`、例子 22、23、28 |
| 8 | 可供 UI 订阅的事件流 | ◐ `agent.subscribe`，10 种事件，只在内存里，不能重放 | ◐ `session.subscribe`，在 Agent 事件之外加了 queue、compaction、retry、`entry_appended`、`agent_settled`；不能重放 | ✅ `viewState()`、`watch()`（后加入的客户端从当前视图开始）、`watchEvents()`（实验性：snapshot + delta）、`watchTaskGraph()`；粒度是每 100ms 提交一次 |
| 9 | system prompt 分段注入记忆，且不破坏缓存 | ◐ 往 transcript 里追加带 `sections` 的 system 消息（[A] README:301-307） | ◐ 在 `before_agent_start` 里改 `systemPromptOptions.sections`，pi 会做 diff（`system-prompt.d.ts:26,76`） | ◐ `section(key, render)`，"Only what changed is sent again" |
|   | ↳ 共同短板 | 三层都走 pi-ai。`deepseek-flash` 上分段更新会被**折叠进开头的 system 消息**，前缀缓存失效（【实测】B，§4.9） | 同左 | 同左 |
| 10 | DeepSeek 思考模式和 `reasoning_content` 回传 | ◐ 回传正确；**默认 `"off"`，即关闭思考**，要显式设置 thinkingLevel | ✅ / ◐ 默认 `"medium"`，clamp 后实发 high；成本仍按高峰价 | ◐ 回传正确；**默认 `"off"`**；`pi.usage` 按高峰价 |
| 11 | 锁定版本的方式、升级成本 | 面最小。0.74 以来 9 个 breaking 版本，但大多发生在已删除的 harness 部分 | 面最大，依赖最重。0.74 以来 9 个 breaking 版本，跟着 CLI 产品一起变 | "Experimental"。1.0.3 和 1.0.4 都有 breaking，main 上还排着新的 breaking |

---

## 3. 三层的关系（为什么"选层"其实是"选循环"）

```
pi-ai（provider、SystemMessage.sections、reasoning_content 回放、faux）  ←── 三层都依赖
 ├── pi-agent-core: Agent / agentLoop（内存循环 + hooks）
 │     └── pi-coding-agent: AgentSession(Agent) + SessionManager(JSONL 树) + ExtensionRunner + 资源发现 / MCP / TUI
 └── pi-durable: Harness(Session over Storage) + 自己的 GenerationTask / ToolTask / CompactionTask + chord 文档
```

- coding-agent 的 `tool_call` / `tool_result` 是 agent-core `beforeToolCall` / `afterToolCall` 的薄包装（`[CA] dist/core/agent-session.js:320-345`）。
- durable 的 `beforeTool` / `afterTool` 是另一套实现（`[DU] dist/harness/tool.js`）。语义接近，但细节不同：改参数会重新校验；block 文本会加上前缀 `Tool call blocked: `；`afterTool` 抛异常只上报、不拦截。
- 【判断】二狗的端口应当按"能力"来定义，不要直接按某一层的 API 定义。这样 A 和 C 两种实现都放得进去（§6.2）。

---

## 4. 逐项说明

### 4.1 工具调用前：拦截、改参数、异步等用户决定

- **(A) agent-core**
  - 签名是 `beforeToolCall(context: BeforeToolCallContext, signal) => Promise<BeforeToolCallResult|undefined>`。参数校验之后才调用；返回类型只有 `block`、`reason`、`terminate` 三个字段（`[A] dist/types.d.ts:44-56,279`）。
  - hook 抛异常时，会被 catch 成一个 error tool result，相当于 fail-safe 拦截（`[A] dist/agent-loop.js:481-540`）。
  - **改参数**：
    - `context.args` 来自 `validateToolArguments`，它先 `structuredClone` 一份（`[AI] dist/utils/validation.js:280-281`），之后同一个对象传给 `execute`（`agent-loop.js:530`）。所以原地修改能生效，而 transcript 里模型的原始参数保持不变（【实测】A：执行时 `to:"alice"`，transcript 里还是 `to:"bob"`）。
    - 但这只是实现细节，不是文档化的 API，而且改完不会重新校验。【判断】在端口层要把它封装成显式的 `rewrite`，自己再跑一遍 `validateToolArguments`。
  - **异步等人**：可以 await 任意 Promise（【实测】A：await 了 300ms）。hook 会拿到 abort signal，要自己响应。进程一死，Promise 就没了（见 §4.6）。
- **(B) coding-agent**
  - `pi.on("tool_call", handler)` 的返回值是 `ToolCallEventResult {block, reason, terminate}`。注释写着 "To modify arguments, mutate `event.input` in place"，以及 "No re-validation is performed after mutation"（`[CA] dist/core/extensions/types.d.ts:943-948,1054-1063,1189`）。
  - 多个 handler 中，只要有一个 block 就立即返回（`dist/core/extensions/runner.js:957-971`）。异常会经 agent-core 的 catch 变成拦截。
  - `ctx.ui.confirm/select` 只在 TUI 和 RPC 模式下有，`hasUI` 的注释是 "true in TUI and RPC modes"（`types.d.ts:219`）。SDK 宿主要用闭包里自己的 broker（【实测】D：await 了 307ms）。
- **(C) durable**
  - 写法是 `hook(ToolTask, { beforeTool(call, api, context) })`，返回 `{arguments}` 或 `{block: string}`（`[DU] dist/harness/types.d.ts:556-563`）。
  - 实现上：先跑 `prepareArguments` 和校验，再按扩展顺序跑 `beforeTool`。第一个 block 胜出；`arguments` 链式替换，**替换后再校验一次**；hook 抛异常就变成 block。之后才提交 intent（`[DU] dist/harness/tool.js:35-66`）。
  - spec 写明："Hooks run in extension order off the line; a crash before the consuming commit may rerun them"，并且 "Hooks use task memos for durable first-writer-wins decisions"（[PI/packages/durable/docs/spec.md §7.2](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/docs/spec.md)，第 2533 行起）。
  - memo 存在 task record 上（`[DU] dist/harness/scheduler.js:979-988`）。
  - **限制**：
    - `HookApi` 只能读，加上 memo，**不能 commit**（`types.d.ts:531-536`）。
    - hook 必须响应 `context` 取消，否则 `close()` 会一直挂着（spec §12 "Non-cooperative code at close"）。
    - 【判断】等审批要等很久，等待逻辑必须接 chord `Context` 的取消。

### 4.2 工具调用后：附加判定

- **(A)** `afterToolCall` 返回 `AfterToolCallResult`，按字段整体替换，不做深合并；抛异常时，结果变成 error（`[A] dist/types.d.ts:69-90`、`dist/agent-loop.js:593-630`）。【实测】A：`details` 里合并进了 `policy`。
- **(B)** `tool_result` 返回 `ToolResultEventResult`，多个 handler 依次叠加（`types.d.ts:1079-1087`）。【实测】D：`details.policy` 写进了 session entry。
- **(C)** `afterTool(call, result, api, ctx)` 返回整个替换后的结果，按扩展顺序链式执行（`tool.js:297-318`）。要注意：
  - `call` 是 `readCall` 读出的**模型原始调用**，看不到 `beforeTool` 改写后的参数。【判断】AgentSense 里"参数被改写过，就在 content 前补一句说明"的逻辑，要先在 `beforeTool` 里 memo 改写信息，到 `afterTool` 里再读出来。
  - 抛异常只是 "report, continue"，不会把结果变成 error（spec §7.2 表格）。
  - 被 block 的调用不会进 `afterTool`。

### 4.3 一轮结束前催促模型继续

- **(A)**
  - `finishTurn` 在每轮的工具结果之后、`turn_end` 之前运行。返回 `{action:"continue"}` 只保证"再发一次请求"，不带新消息；无条件返回 continue 会死循环（`[A] README.md:124-150`）。
  - 要带一条催促消息，可以在 `finishTurn` 里调 `agent.followUp(msg)`：循环在"本该停下"时会去取 follow-up 队列（`agent-loop.js:179-200`）。
  - 【实测】A：第 3 次请求的上下文末尾是 `user:"[NUDGE] step s2 not done"`，最后回答是 "done after nudge"。
- **(B)**
  - `agent_before_settle` 的 handler 返回 `{entries:[{type:"custom_message", customType, content, display:false}], continue:true}`（`types.d.ts:720-770`；CHANGELOG 0.87.0 "actionable `turn_end` and `agent_before_settle`"）。
  - 【实测】D：nudge 以 user 消息的形式进入了第 3 次请求。
- **(C)**
  - `onYield(answer)` 返回 `{continue}` 时，第一个 continuation 胜出，追加一条 `pi.user`，并交给下一个 generation 接着跑。
  - 但这只在"本边界没有选中用户输入、也没有 reset"时才生效（`[DU] dist/harness/generation.js:393-420`）。【判断】用户刚好排了一条 follow-up 时，催促会被吃掉。二狗如果要求"一定提醒到"，就得在下一轮再检查一次。
  - 【实测】C。

### 4.4 写不进模型上下文的自定义记录

- **(A)** 用 `CustomAgentMessages` 做 declaration merging，再在 `convertToLlm` 里过滤（`[A] dist/types.d.ts:186,315`；README "Custom Message Types"）。【实测】A：自定义角色 `ledger` 在 `state.messages` 里，但 provider 看不到。持久化全靠二狗自己。
- **(B)**
  - `pi.appendEntry(customType, data)`（`types.d.ts:1237`）对应 `SessionManager.appendCustomEntry`（`session-manager.d.ts:273`），在 JSONL 里写成 `custom` 条目。【实测】D：provider 上下文里没有它。
  - 另有两个相关 API：`appendCustomMessageEntry` 写的条目会进上下文，可以设 `display:false`；`appendContextEdit(entryId, null)` 能把某条记录从此后的上下文里删掉，原始历史不动（CHANGELOG 0.87.0）。
- **(C)**
  - `EntryRecord.model` 字段缺省时，就是 "display or bookkeeping entries"（`[DU] dist/types.d.ts:278`）。写法有两种：`submit({type:"write", entry:{kind:"app.x", data}})`，或者在 commit 里 `tx.appendEntry(...)`。
  - 另有 `defineDoc` 定义的类型化文档（README "Your Own State"）。
  - 【实测】C：`app.guard_ledger` 在 entries 里，不在 model context 里。
  - 注意：
    - 会话正忙时，要用 write submission 写，不要直接写（spec §12 "Writing to a busy conversation"）。
    - `pi.` 前缀是保留的（spec §12 "Reserved `pi.` names"）。

### 4.5 会话树回退 + 分支摘要

- **(A) 缺。** 1.0.0 删掉了 AgentHarness，连同会话、compaction 和导航（[agent CHANGELOG 1.0.0](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/agent/CHANGELOG.md)）。
- **(B) 原样保留。**
  - `navigateTree(targetId, {summarize, customInstructions, replaceInstructions, label})` 返回 `{editorText, cancelled, aborted, summaryEntry}`，在同一个 JSONL 文件里换叶子（`[CA] dist/core/agent-session.d.ts:833-853`）。
  - 扩展可以在 `session_before_tree` 里取消，或者自己提供 summary（`SessionBeforeTreeResult`，`types.d.ts:1106-1118`）。
  - 【实测】D：
    - 摘要请求把被放弃的分支包在 `<conversation>` 里发给模型，生成一条 `branch_summary` 条目；label 单独写成一条 `label` 条目。
    - 默认摘要带一段英文前缀 "The user explored a different conversation branch…"，可以用 `replaceInstructions` 改掉。
- **(C) 部分。**
  - 没有原地的树导航。`conversation.fork(at, {ownership})` 会建一个新会话：它看得到父会话到 `at` 为止的条目，agent 配置也取 `at` 那一刻的版本（README "More Conversations and Forks"；`types.d.ts:475`）。
  - 文档按定义里的 `fork` 设置复制：`"current"`、`"initial"`、`"asOf"`。配上 `history:"rewindable"`，就能回到分叉点时的值。【判断】这正好对应 AgentSense"授权状态跟着分支走"的需要（`REF/web/src/agent/runtime.ts:576-580`），比 AgentSense 回退后重放分支来重建状态更省事。
  - 分支摘要要二狗自己生成，再写进 fork。main 上未发布的 `Conversation.context(context, { at })` 可以在分叉前预览上下文（[PIMAIN durable CHANGELOG Unreleased](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/durable/CHANGELOG.md)）。

### 4.6 崩溃续跑；守护进程重启后恢复待审批

- **(A) 缺。** `AgentState` 全在内存里。`continue()` 只能从非 assistant 结尾重试（`[A] dist/agent.d.ts:119`）。等审批的 Promise 进程一死就没了。
- **(B) 部分。**
  - 每追加一条 entry，就 `appendFileSync` 写一行，不做 fsync（`[CA] dist/core/session-manager.js:794-813`）。重开会话能拿回已经定稿的消息。
  - 丢失的有：流式中的半条回复、正在执行的工具、`tool_call` 里等着的审批。也没有自动续跑。
  - 只有调用、没有结果的孤立 toolCall，pi-ai 在发送前会补一个合成的空结果（`[AI] dist/api/transform-messages.js:125` 起）。
- **(C) 提供。**
  - README 原话："committed to storage before anything is shown. If the process dies mid-turn, reopening the storage picks the work up where it stopped"。重开后调用 `harness.resume()`；`requestId` 用来做幂等提交（README "Persist and Resume"）。
  - 工具调用前先提交 intent。崩溃后，只有 `replay:"safe"` 的工具会重跑；其他工具给模型一个 `interrupted` 错误结果（`tool.js:59-88`；README "Tools"）。
  - 【实测】C：
    - 子进程在 `beforeTool` 里 `memo("approvalId")` 之后挂起，父进程用 SIGKILL 杀掉它。
    - 重开同一个 JSONL 存储后，`inspect()` 显示 `pi.tool:ready` 和 `pi.generation:waiting`。
    - 用同一个 `requestId` 再次 submit，拿到的是原来那个 submission。`resume()` 之后，`beforeTool` 重跑了 1 次，memo 读回 `appr-12`，工具执行，submission 状态为 `done`。
  - 【判断】二狗的落点：
    1. 在 `beforeTool` 里先 `memo` 一个 approvalId（first-writer-wins）；
    2. 在二狗自己的审批表里按这个 id upsert 一条待审批记录，然后推送；
    3. 等用户决定，同时接 `context` 取消。
    - 重启后 hook 重跑，拿到同一个 id，不会重复打扰用户。
    - intent 之后的副作用工具，在二狗这边要带幂等键；能声明 `replay:"safe"` 的才声明。
  - 【判断】一个工具在等审批时，会话会一直处于 busy，用户新发的消息会排进 inbox（README "Busy Conversations"）。所以秘书会话不应该直接执行有副作用的工具。map 里"副作用一律成为任务"的设定正好绕开了这一点：等审批的是任务的会话，不是秘书的会话。

### 4.7 子会话 / 子 agent

- **(A) 缺。** 可以 new 多个 `Agent`，各自设 model、tools、systemPrompt。通信、生命周期、持久化都要自建。
- **(B) 部分。**
  - 进程内可以多次调用 `createAgentSession()`，每个会话各自有 model、tools 和 `resourceLoader` 提供的 system prompt（[CA] docs/sdk.md "Configuring a session"）。但没有父子关系，也没有通信原语。
  - 官方 `examples/extensions/subagent` 用的是子进程：`pi --mode json -p --no-session`（`[CA] examples/extensions/subagent/index.ts:300,346`）。
  - 同一进程里跑多个会话，有没有全局单例冲突（settings、auth 文件）【未核实】。
- **(C) 提供。**
  - 写法：子会话设 `ownership:{kind:"task", taskId}`，再用 `configure({model, thinkingLevel, extensions, tools, instructions, cwd})` 单独配置（README "Per-Conversation Agent"、"Abort and Subagents"；`types.d.ts:246-260`）。
  - 生命周期：父会话 abort 会级联到子会话；父会话要等子会话 idle 才算 idle；`background:true` 的任务是一道边界。
  - 通信：
    - `ConversationHandle.submit` 支持 `whenBusy:"steer"|"followUp"`。
    - 例子 23 用后台 Reporter 任务把子 agent 的回答作为 follow-up 回写给父会话，用 `requestId` 防止重复（[PI/packages/durable/test/examples/23-subagent-background.ts](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/test/examples/23-subagent-background.ts) 第 73–116 行）。
  - 任务面板可以用 `taskGraph()` / `watchTaskGraph()`。
  - **坑**（spec §12）：
    - 子会话在创建时一次性复制父会话的 `pi.agent`，之后父会话再改也不同步。
    - 用 `{add, remove}` 编辑子会话的扩展选择，结果是"宿主默认 + 这次编辑"，而不是"父会话的选择 + 这次编辑"。
    - **数组式选择漏掉守卫扩展，这个会话就完全没有守卫**（"Guards left out of a selection… there is no registry-wide hook or wrapper"）。
    - 【判断】二狗必须在端口层强制每个会话都带上守卫扩展。

### 4.8 UI 事件流

- **(A)** `agent.subscribe((event, signal) => …)` 有 10 种 `AgentEvent`（`[A] dist/types.d.ts:450` 起）。监听器按注册顺序 await，慢监听器会拖慢循环。只在内存里，不能重放。
- **(B)** `session.subscribe` 在 Agent 事件之外，还有 `queue_update`、`compaction_start/end`、`auto_retry_start/end`、`entry_appended`、`session_info_changed`、`thinking_level_changed`、`agent_settled`（`[CA] dist/core/agent-session.d.ts` 的 `AgentSessionEvent`）。不能重放。
- **(C)**（README "Watching a Conversation"、"Agent Events (Experimental)"、"Task Graph"；`dist/harness/events.d.ts:62-164`）
  - `viewState()`：只读的 Chord state，每次提交后更新。
  - `watch()`：逐次提交的精确操作。最多缓存 100 帧，溢出时合并成一帧全量；后加入或重连的客户端从当前视图开始，不重放。
  - `watchEvents()`：snapshot 加增量事件，包括 `run_start`、`turn_*`、带 delta 的 `message_*`、`tool_execution_*`、`inbox_update`、`usage_changed`、`compaction_*`、`task_failed` 等。它在 README 里标的是 "Experimental"。
  - `watchTaskGraph()`。
  - 代价：回复的中间状态和工具输出默认每 100ms 提交一次（`settings.progress`）。UI 看到的是 100ms 粒度，每次提交都是一次存储写入。
- 【判断】二狗的 Web UI 协议（09 §6.4：一条 WebSocket，按 seq 断点续传）要自己定义。三层都没有按 seq 续传；durable 只能"从当前视图重来"。

### 4.9 分段注入记忆，且不破坏缓存

- **共同机制**
  - pi-ai 0.86.0 起，system prompt 和工具声明都放在 transcript 的 `SystemMessage` 里。后续的 system 消息用 `sections` 按名替换或删除段落（`[AI] dist/types.d.ts:342-366`；[ai CHANGELOG 0.86.0 Breaking](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/CHANGELOG.md)）。
  - 模型开了 `compat.supportsMidConvoSystemMessages`，更新就留在原位发送；没开，`collapseSystemMessages` 会把所有 system 消息重放、折叠成开头的一条（`[AI] dist/utils/transcript.js:96-104`；`types.d.ts:670` 的注释："When false, later system messages are folded into the leading system message"）。
  - 三层各自的入口：
    - (A) `agent.prompt([{role:"system", content:"", sections:{…}}, userMsg])`（[A] README:301-307）。`agent.state.tools` 变了，也会自动生成一条声明工具增减的 system 消息（README "Agent State"）。
    - (B) 在 `before_agent_start` 里改 `systemPromptOptions.sections`，pi 用 `diffSystemPromptSections` 算出补丁（`[CA] dist/core/system-prompt.d.ts:26,51-76`）。
    - (C) `section(key, render)`，每次请求前渲染（README "System Prompt"）。spec §12 还列了两条会让缓存失效的情况："Moving default selections … misses the provider prompt cache"，以及 "Unstable prompt text"。
- **DeepSeek 实情【实测】B**
  - `deepseek-flash` 的 compat 没有 `supportsMidConvoSystemMessages`，`deepseek-v4-pro` 有（`[AI] dist/providers/data/deepseek.json`）。
  - 同一份 transcript（开头 memory=“likes tea”，后面一条 sections 补丁把 memory 改了）的发送结果：
    - flash：发出的请求只有**一条** system，内容已经是新的 memory。
    - v4-pro：开头保持旧 memory，末尾追加 `Updated system prompt section "memory": …`。
  - DeepSeek 的缓存要求前缀完整匹配（09 §4.6）。所以**在 flash 上，每改一次分段，整段前缀缓存都失效**；工具集中途改变也一样。
- **【判断】对策**（按推荐顺序）：
  1. 稳定的画像放在开头的 section 里，低频变化，例如每天一次，或在 compaction 时更新。
  2. 高频的检索记忆不要改 system，改成追加在尾部的上下文消息：
     - (A) 用 `convertToLlm` 渲染自定义消息；
     - (B) 用 `custom_message`；
     - (C) 写一条带 `model` 的 entry。
     - 这些消息要**作为历史持久化**。不能每次请求临时插进去再拿掉，否则下一次请求的前缀会在插入点分叉。
  3. 给 flash 自建一个 model 对象，把 `compat.supportsMidConvoSystemMessages` 覆盖成 `true`。pi-ai 优先读 `model.compat`（`[AI] dist/api/openai-completions.js:1336`）。
     - 09 §4.2 引用的 DeepSeek tool calls 指南说，Chat Completions 支持中途插入 system message。
     - 但 flash 在思考模式加 tools 下的实际行为【未实测】，要用真 key 跑一次。
  4. 工具集固定顺序。按角色裁剪工具，要在会话创建时就定死。

### 4.10 DeepSeek：思考模式与 `reasoning_content` 回传

三层都通过 pi-ai 的 `openai-completions` 访问 DeepSeek，所以行为一致，区别只在默认的 thinkingLevel。

- **坑 1（核实）：不传 reasoning 就关闭思考**
  - `thinkingFormat:"deepseek"` 分支的逻辑：有 `reasoningEffort` 才发 `thinking:{type:"enabled"}` 和 `reasoning_effort`，否则发 `{type:"disabled"}`（`[AI] dist/api/openai-completions.js:668-678`）。
  - `streamSimple` 会先把档位 clamp 到模型支持的级别：flash 的 `medium` 变成 `high`，`minimal` 变成 `low`（`[AI] dist/models.js:690-708`；【实测】B）。
  - 三层的默认值：
    - Agent：`"off"`（`[A] dist/agent.js:41`）；
    - durable：`"off"`（`[DU] dist/harness/agent.js:175`；`generation.js:117` 在 off 时不传 reasoning）；
    - coding-agent：`DEFAULT_THINKING_LEVEL = "medium"`（`[CA] dist/core/defaults.js:1`），对 flash 实发 high。
- **坑 2（核实）：成本按高峰价**
  - flash 目录里的单价是 input 0.3、output 1.2、cacheRead 0.006（`deepseek.json`），等于 09 §4.7 里的高峰价。
  - durable 的 `pi.usage`（README "Usage and Cost"）同样基于这个单价。【判断】空闲时段会高估约 2 倍，二狗要自己重算。
- **`reasoning_content` 回传（核实）**
  - 流式接收时，从 `reasoning_content` 字段读出思考内容，记成 thinking block，`thinkingSignature:"reasoning_content"`（`openai-completions.js:396-420`）。
  - 回放时：
    - 同一模型，原样写回 `reasoning_content`（`:995-1010`）；
    - 没有思考内容的 assistant 消息，补上 `reasoning_content:""`（`:1047-1051`，对应 compat `requiresReasoningContentOnAssistantMessages`）。
  - 【实测】B：tool call 那一轮回传了 "I should call lookup."，纯文本那一轮回传 `""`。关闭思考时，历史里的 `reasoning_content` 照样回传。
- **新坑 3：跨模型的历史**
  - provider、api、model id 任一不同，就算跨模型。这时 thinking 会被改写成普通文本放进 `content`，`reasoning_content` 变成 `""`（`[AI] dist/api/transform-messages.js:68-95`）。
  - 【实测】B：v4-pro 生成的那一轮发给 flash 时，`content:"I should call lookup."`。
  - 【判断】同一会话里中途换模型，会把旧推理变成模型"说过的话"，还会改动历史前缀、让缓存失效。二狗应按角色固定模型，不在一个会话里换模型。
- **其他**：思考模式下不支持 `tool_choice:"required"`，也不支持指定工具（09 §4.2）。pi-ai 会原样透传 `toolChoice`，二狗不要用这两种。

### 4.11 锁定版本与升级成本

详见 §7。要点：
- 四个包在同一个提交上同步发版。
- 包与包之间用 caret 依赖。
- pi-ai 本身就是变化最频繁的一层（0.74 以来 14 个 breaking 版本）。不管选哪一层，升级成本都绕不开 pi-ai。

---

## 5. AgentSense（`AgentHarness`，pi-agent-core 0.85.1）→ 1.0 迁移表

AgentSense 用到的旧 API 签名见 `REF/web/node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:501-580,642,655`（0.85.1），用法见 `REF/web/src/agent/runtime.ts`。

| AgentSense 用法 | (A) agent-core 1.0 | (B) coding-agent SDK 1.0 | (C) durable 1.0 | 语义差异 / 注意 |
|---|---|---|---|---|
| `AgentHarness.create({session, models, model, thinkingLevel:"high", systemPrompt, tools, toolExecution:"sequential"})`（runtime.ts:319-330） | `new Agent({initialState:{systemPrompt, model, thinkingLevel:"high", tools}, streamFn: models.streamSimple.bind(models), toolExecution:"sequential"})` | `createAgentSession({model, thinkingLevel, modelRuntime, resourceLoader, sessionManager})`。工具用扩展的 `pi.registerTool`；需要顺序执行就给工具设 `executionMode:"sequential"` | `Harness.open(storage, {models, registry, settings:{toolExecution:"sequential"}})`，再 `root()` / `createConversation({agent:{model, thinkingLevel:"high", instructions, tools}})` | **thinkingLevel 必须显式写**：A 和 C 默认 off，§4.10 |
| `lane.prompt / abort / waitForIdle / inspectExecution`（runtime.ts:514-551） | `agent.prompt / abort / waitForIdle / state.isStreaming` | `session.prompt / abort / waitForIdle / isStreaming` | `conversation.submit(…).wait / abort / waitForIdle`、`harness.inspect()` | C 的 submit 是持久化接纳，可以带 `requestId` |
| `hooks.on("before_tool")` 返回 `{args}` 或 `{block:{reason, terminate}}`；在里面 `await broker.requestRuntimeConfirmation()`（runtime.ts:338-382） | `beforeToolCall` 返回 `{block:true, reason, terminate}`；改参数只能原地改 `context.args` | `tool_call` 返回 `{block, reason, terminate}`；改参数是原地改 `event.input` | `beforeTool` 返回 `{arguments}` 或 `{block: string}`；用 memo 存审批 id | C 的 block 文本带 `Tool call blocked: ` 前缀。AgentSense 那句"这一条不会因为重试而通过"（runtime.ts:366）仍然要保留。A 和 B 改完参数不重新校验 |
| `hooks.on("after_tool")`：把 `details.policy` 合并进去；改写过参数时在 content 前补说明；`!isError` 才 commit 进轨迹（runtime.ts:384-395） | `afterToolCall` 返回 `{details, content}`，参数里有 `isError` | `tool_result` 返回 `{details, content}`，event 里有 `isError` | `afterTool` 返回整个结果，`result.isError` | C 的 `afterTool` 收到的是原始参数，改写信息要 memo 过去；它抛异常不会把结果变成 error |
| `hooks.on("before_run_end")` 返回 `{followUp}`（runtime.ts:401-422） | `finishTurn` 里调 `agent.followUp(msg)` | `agent_before_settle` 返回 `{entries:[custom_message], continue:true}` | `onYield` 返回 `{continue}` | 三层的催促都会以 user 消息进入上下文，和旧版一样。C 遇到同一边界上有用户输入时会丢掉催促 |
| `lane.appendCustomEntry(type, data)`：总账、`milestone_plan`、`milestone_reopen`（runtime.ts:306,457） | 自定义 `AgentMessage` + `convertToLlm` 过滤，持久化自建 | `pi.appendEntry` / `sessionManager.appendCustomEntry` | `submit({type:"write", entry:{kind:"app.guard_ledger", data}})`，或用 `defineDoc` | AgentSense 是在 `waitForIdle` 之后才写总账（runtime.ts:443-462）。C 对应的做法是 `submission.wait()` 之后再写 |
| `lane.navigateTree(target, {summarize, label, customInstructions})`，切分支时 `summarize:false`（runtime.ts:530,553-561） | 缺，自建 | `session.navigateTree(target, {summarize, label, customInstructions, replaceInstructions})`，原样可用 | `conversation.fork(at)` + 二狗自己生成摘要；切分支 = 切换"当前会话 id" | C 里，授权状态可以放进 `history:"rewindable", fork:"asOf"` 的文档，不必再按分支重放 |
| `session.findEntries({order:"asc"})` + `lane.getTipId()`：UI 由会话树纯函数推导（runtime.ts:464-466） | `agent.state.messages`（只有当前这条线） | `sessionManager.getEntries / getBranch / getTree / getLeafId` | `conversation.entries(query, limit, cursor)`、`context()`、`viewState()` | |
| `harness.events.on(...)`：`run_start/run_end/message_*/tool_start/tool_end/entry_added/navigation_end/retry_scheduled/fault/handler_error`（runtime.ts:493-508） | `subscribe`：`agent_*/turn_*/message_*/tool_execution_*`，没有 retry 和 fault | `session.subscribe`，另有 `auto_retry_*`、`entry_appended`、`agent_settled`、`compaction_*` | `watchEvents`：`run_start/run_end`、`message_*`、`tool_execution_*`、`entry_appended`、`auto_retry_*`、`task_failed`… | 二狗要定义自己的 `RuntimeEvent`，各层分别翻译 |
| `JsonlSessionRepo` / `MemorySessionRepo` / `FileSystem` 桥（runtime.ts:318） | 无 | `SessionManager.create / open / inMemory`（JSONL，按 cwd 分组） | `MemoryStorage` / `openNodeSqliteStorage` / `openNodeJsonlStorage`；自定义存储可以跑 conformance 测试 | |
| `AgentHarnessTool`，`execute` 返回 `{content, details}` | `AgentTool.execute(id, params, signal, onUpdate)` | `ToolDefinition.execute(id, params, signal, onUpdate, ctx)` | `defineTool({parameters, execute(args, api, ctx), replay})` | C 的工具多了 `replay` 和 `api.commit / memo / createTask` |
| `createModels / createProvider / openAICompletionsApi` + `thinkingFormat:"deepseek"`（`REF/web/src/agent/model.ts`） | pi-ai 1.0 自带 `deepseekProvider()`（`[AI] dist/providers/deepseek.js`）；要走转发地址时仍可以用 `createProvider` | 同左，另可通过 `ModelRuntime.registerNativeProvider` 注册 | 同左，`Harness.open({models})` | |
| `fauxProvider / fauxAssistantMessage / fauxToolCall` 做端到端回归 | 仍在 `@earendil-works/pi-ai/providers/faux`（`[AI] dist/providers/faux.d.ts`） | 同左（【实测】D） | 同左（【实测】C） | 二狗的合同测试直接复用它 |
| `BACKGROUND_CONTEXT`（pi 的取消上下文） | 改用 `AbortSignal` | 无 | `@earendil-works/chord/context` 的 `BACKGROUND_CONTEXT` | |

---

## 6. 推荐【判断】

### 6.1 选哪一层

**主选 (C) pi-durable 加 pi-ai，包在二狗自己的 Runtime 端口后面；(A) agent-core 作为 Plan B；(B) coding-agent 只作参考。**

| 方案 | 二狗要补的部分 | 风险 | 结论 |
|---|---|---|---|
| (A) Agent + 全部自建 | 会话存储和会话树、回退和摘要、持久化、崩溃恢复（effect sandwich 和幂等）、子 agent 的所有权和级联 abort、compaction（1.0 删了）、事件重放。基本等于重写 pi 自己刚删掉的 AgentHarness | API 面最小，但自建量最大，最容易在恢复语义上出错 | 备胎 |
| (B) coding-agent SDK | #6 续跑、#7 父子原语、#8 重放 | 它是 CLI 产品的 SDK：要关掉 cwd 资源发现、`~/.pi` 配置和 auth 文件（探针 D 不得不一一关掉）；依赖链里有 TUI、codemode、MCP、photon；0.74 以来 9 个 breaking 版本，跟着 CLI 功能变 | 不选，只借鉴 |
| (C) durable | #5 的分支摘要；审批表和推送；成本重算；DeepSeek 适配；UI 协议；守卫强制 | Experimental，随时可能变；它依赖的 `node:sqlite` 在 Node 22 上也还是 experimental（运行时有 ExperimentalWarning） | **主选** |

选 C 的理由：
- 需求 6 和 7 最难自建，durable 已经做了，而且核心路径实测可用（探针 C）。
- 需求 1–4 的 hook 语义比 A 更完整：改参数后会重新校验，有持久化的 memo，有文档。
- 它和二狗的"任务 / 项目 / 后台子 agent / 任务面板"在概念上一一对应（03 号文档 §A1.5 已有同样的判断）。

### 6.2 薄封装：二狗自己的端口（草案）

上层（秘书、任务、项目、审批、UI 网关）只依赖下面这组接口，pi 的类型不出 `runtime/` 目录：

```ts
// 二狗自有类型，不导出任何 pi 类型
interface AgentRuntime {
  openThread(threadId: string): Promise<Thread>;                       // thread = 二狗的"对话"，内部映射到当前的 durable conversation id
  spawnAgent(spec: AgentSpec, owner: { taskId: string; background: boolean }): Promise<Thread>;
  events(threadId: string, sinceSeq?: number): AsyncIterable<RuntimeEvent>; // 二狗自定义 seq，可续传
}
interface Thread {
  submit(input: UserInput, opts: { whenBusy: "steer" | "followUp" | "reject"; requestId: string }): Promise<RunHandle>;
  abort(): Promise<void>;
  appendRecord(kind: string, data: Json): Promise<void>;               // 不进模型上下文
  rollback(toEntryId: string, opts: { summarize: boolean; instructions?: string }): Promise<Thread>; // fork + 摘要 + 切换映射
}
interface AgentSpec { role: string; model: ModelRef; thinkingLevel: ThinkingLevel; tools: string[]; instructions: string }
interface Guard {                                                      // 策略层只实现这三个回调
  beforeTool(call: ToolCall, ctx: GuardCtx): Promise<{ allow: true; rewrite?: Json } | { block: string }>;
  afterTool(call: ToolCall, rewritten: Json | undefined, result: ToolResult, ctx: GuardCtx): Promise<ToolResult>;
  onYield(answer: AssistantMessage, ctx: GuardCtx): Promise<{ nudge?: string }>;
}
interface ApprovalStore { ensurePending(approvalId: string, payload: Json): Promise<void>; waitDecision(approvalId: string, signal: AbortSignal): Promise<Decision> }
```

durable 实现的要点：
- `Guard.beforeTool` 落在 `hook(ToolTask)` 里，用 memo 存 approvalId，再交给 `ApprovalStore` 去等。
- `rewritten` 由 `beforeTool` memo 下来，`afterTool` 里读出。
- `onYield` 落在 `hook(GenerationTask)` 里。
- 端口层在 `configure` 和 `createConversation` 外面再包一层，**拒绝任何漏掉守卫扩展的选择**。

### 6.3 二狗必须自建的部分

1. **审批表和 broker**：放在二狗自己的数据库里，durable 只存 approvalId（memo）。还包括推送、超时和升级规则、一键批准等（07、06 号文档）。
2. **守卫强制与角色权限**：每个会话都必须带守卫扩展；角色的工具白名单在 `beforeTool` 里硬卡，不靠提示词。
3. **回退**：fork、分支摘要（可以借用 coding-agent 的摘要提示词和格式）、thread → 当前 conversation 的映射、分支 UI。
4. **事件网关**：把 `watchEvents` / `watch` 翻译成二狗的事件流，自己维护 seq 和断线续传（09 号文档 §6.4）。
5. **成本账本**：按北京时间的高峰和空闲时段重算费用；`pi.usage` 只当 token 计数的来源（09 号文档 §5）。
6. **DeepSeek 适配**：
   - 显式设置 thinkingLevel；
   - 试验 flash 的 `supportsMidConvoSystemMessages` 覆盖；
   - 定好记忆注入策略（§4.9）；
   - 每个会话固定一个模型。
7. **子 agent 协议**：角色到 `AgentSpec` 的映射；父子消息格式（参考例子 23 的 Reporter）；预算和并发上限；子会话不会自动继承父会话后来的配置变化。
8. **任务登记处 / 看板**：`taskGraph` 只列出活着的任务。二狗自己的任务生命周期、提醒策略、历史，都要放在自己的表里。
9. **合同测试**：把附录 A 的探针改写成基于 faux provider 的测试，每项需求一条。它们是升级的闸门（§7）。
10. **Web UI**：pi-web-ui 已经停更（03 号文档 §A4）。

**Plan B 的前提**：二狗的领域状态（审批、任务、记忆、账本）不要存进 durable 的文档里，只存进自己的数据库。durable 只承载会话和运行时状态。这样将来换成 (A) 时，只需要重写 `runtime/` 这一层。

---

## 7. 版本锁定与升级策略

**事实**
- 四个包的 `1.0.4` 都来自同一个 gitHead `7c10bd43`（`npm view <pkg>@1.0.4 gitHead`）。
- 包之间的依赖是 caret：`pi-agent-core` → `"@earendil-works/pi-ai": "^1.0.4"`；`pi-durable` → `chord ^1.0.4`、`pi-ai ^1.0.4`（各包的 `package.json`）。
- `typebox` 在各包里都被精确锁在 `1.3.27`。
- 发版节奏：
  - agent-core 从 0.85.0（2026-09-04）到 1.0.4（2026-10-05）一共 14 个版本；
  - durable 从 1.0.0（10-01）到 1.0.4（10-05）5 天发了 5 个版本（npm `time` 字段）。
- 自 0.74.0（2026-05-07）以来带 "Breaking Changes" 小节的版本：
  - pi-ai 14 个，最近几个是 1.0.3、0.99.0、0.86.0（ai CHANGELOG）；
  - agent-core 9 个（agent CHANGELOG）；
  - coding-agent 9 个（`[CA] CHANGELOG.md`）；
  - durable 的 1.0.3 和 1.0.4 都有（`[DU] CHANGELOG.md`）。
- durable 在 main 上的 Unreleased 部分已经有新的 breaking：`Storage` 必须支持 `order`；`TaskRuntime.context()` 的签名变了（PIMAIN durable CHANGELOG）。
- `engines.node >= 22.19.0`。

**【判断】策略**
1. **精确锁定，并锁住传递依赖**：
   - `package.json` 里所有 `@earendil-works/*` 都写精确版本（`.npmrc` 设 `save-exact=true`）；
   - 加上 npm `overrides`，把 `@earendil-works/pi-ai`、`pi-agent-core`、`chord`、`pi-durable`、`pi-telemetry` 统一压到同一个版本；
   - 提交 `package-lock.json`，CI 和部署都用 `npm ci`。
   - 工具 schema 用 pi-ai 重新导出的 `Type`（durable README 就是这么写的），避免装出第二份 typebox。
2. **端口隔离**：pi 的类型不出 `runtime/` 目录（§6.2）。升级时只改这一层。
3. **合同测试是升级闸门**：§6.3 第 9 条的测试必须全绿才能合并升级。另外跑一遍 `registerStorageConformance`，确认存储层兼容。
4. **节奏**：
   - 默认不追新版。只在需要某个修复或功能时才升级，一次只跳到一个发布提交（四个包一起跳）。
   - 升级前通读四个包 CHANGELOG 里的 "Breaking Changes" 和 durable 的 spec 差异。
   - 存储格式变化时，先在家庭存储的备份副本上跑一次迁移演练。
5. **退路**：
   - durable 是 MIT 许可，可以 vendor 一份（只要 `packages/durable` 加 `chord`），必要时在自己的分支上修补。
   - 长期失控时切换到 Plan B（§6.3 末尾）。
6. **开工时重新确认**：本文的快照是 1.0.4。真正开工那天，先看 main 上的 Unreleased 是否已经发版；如果已发版，评估是直接从那个版本起步，还是留在 1.0.4。

---

## 8. 风险

| 风险 | 说明 | 缓解【判断】 |
|---|---|---|
| durable API 不稳定 | README 第一行就是 "Experimental. The API changes without notice between releases."；5 天 2 个 breaking 版本；main 上还有未发布的 breaking | §7 的锁定、端口、合同测试；领域状态外置；Plan B |
| durable 太新，没有生产验证 | 2026-09-19 首发 0.0.1（03 号文档 §0）；本文只在 faux provider + JSONL 上实测了一条崩溃路径 | 上线前补做 SQLite 存储、真实 DeepSeek、长时间等审批、多子 agent 并发的浸泡测试【未核实】 |
| DeepSeek 缓存被分段更新打穿 | §4.9：flash 上会折叠 system 消息 | 按 §4.9 的对策；上线后从 usage 里的 `prompt_cache_hit_tokens` 监控命中率 |
| 思考模式被悄悄关掉 | A 和 C 默认 off（§4.10） | 端口层的 `AgentSpec.thinkingLevel` 设为必填；合同测试断言请求里带 `thinking.type=enabled` |
| 跨模型历史改写 | §4.10 新坑 3 | 每个会话固定模型；换模型 = 开新会话加交接摘要 |
| 守卫被漏掉 | durable 没有全局 hook，数组式选择会丢掉守卫（spec §12） | 端口层强制，并写合同测试 |
| 长时间等审批时挂住 close / 会话 | hook 不响应取消会让 `close()` 挂住；会话一直 busy，用户消息只能排队 | 审批等待接上 `Context`；副作用只放在任务会话里，秘书会话不直接调用副作用工具 |
| 恢复后行为漂移 | hook 重跑时用的是新进程注册的扩展版本；重跑的工具会按当前 `cwd` 重建环境（spec §12 "Environment on recovery"） | 守卫判定要幂等，并可以从 memo 和审批表复原；副作用工具带幂等键 |
| 成本报表失真 | 目录单价按高峰价 | 自建账本 |
| `node:sqlite` 仍是实验特性 | Node 22.23 上运行有 ExperimentalWarning（本机实测） | 可以先用 JSONL 存储（`{fsync:true}`），或者锁定 Node 版本 |
| 上游方向变化 | Earendil 公司化；pi 的"不做清单"变过（03 号文档 §A3）；durable 可能并入别的产品形态 | MIT，可以 fork；端口隔离 |

---

## 9. 开放问题

1. 给 flash 覆盖 `supportsMidConvoSystemMessages:true` 后，DeepSeek 在思考模式加 tools 下是否接受，缓存命中是否真的保住了？需要用真 key 跑一次【未实测】。
2. durable 的存储选 SQLite 还是 JSONL？是放进二狗的数据目录，还是和二狗自己的数据库合用一个 SQLite 文件？durable 要求独占存储，不同进程之间没有锁。
3. 二狗用不用 durable 自带的 compaction（`CompactionTask` 加 `beforeCompact`）？还是在压缩前先把计划和授权写进记忆或文档？这和 06 号文档里的"压缩丢约束"问题有关。
4. 回退之后，旧的 conversation 是只留作"废弃分支"给 UI 看，还是允许切回去继续跑？
5. 开工时 main 上的 Unreleased 改动（`HookApi.models`、`Conversation.context({at})`、`durationMs`）如果已经发版，要不要直接从新版本起步？

---

## 附录 A：探针

所有探针都放在本次会话的临时目录里：依赖装在单独的 `deps/` 目录（`npm install --ignore-scripts`），脚本放在 `scripts/`，用绝对路径动态 import。模型用 pi-ai 的 faux provider；探针 B 把 `fetch` 打桩成直接抛错，只靠 `onPayload` 截获请求体。没有任何网络调用。脚本不入库，下面给出要点，可以照着重写。

| 探针 | 做了什么 | 关键结果 |
|---|---|---|
| A `probe-agent-core` | `new Agent`，`toolExecution:"sequential"`。`beforeToolCall` 里 await 300ms，然后把 `args.to` 从 `bob` 改成 `alice`；`afterToolCall` 合并 `details.policy`；`finishTurn` 第一次收尾时调 `agent.followUp("[NUDGE]…")`；`state.messages` 里塞一条自定义角色 `ledger`，`convertToLlm` 把它过滤掉 | 实际执行参数是 `to:"alice"`，transcript 里仍是 `to:"bob"`；toolResult 的 details 为 `{ok, policy}`；provider 共被调用 3 次，第 3 次的上下文末尾是 NUDGE；provider 看不到 `ledger` |
| B `probe-deepseek-payload` | 用 `deepseekProvider()` 构造一份 transcript：开头 system 带 memory/time 两个 section；一轮 assistant 带 thinking（签名 `reasoning_content`）和 toolCall；一条 toolResult；一轮纯文本 assistant；然后一条 sections 补丁（memory 改了）；最后一条 user。分别用 flash 和 v4-pro 截获请求体 | 不传 reasoning 时请求体是 `thinking:{type:"disabled"}`；`reasoning:"high"` 时是 `enabled` 加 `reasoning_effort:"high"`；`medium` 会变成 `high`；同模型回传 `reasoning_content:"I should call lookup."`，纯文本那轮回传 `""`；flash 把补丁折叠进开头那条 system，v4-pro 在末尾追加 `Updated system prompt section "memory"`；历史来自 v4-pro、发给 flash 时，推理变成了 `content` 文本 |
| C `probe-durable` | 第 1 部分：MemoryStorage。`beforeTool` 里 await 300ms 后返回 `{arguments:{to:"alice"}}`；`afterTool` 加上 policy；`onYield` 第一次返回 continue；然后 write 一条 `app.guard_ledger`；再 fork 一次；用 `watchEvents` 收集事件。第 2 部分：子进程开 JSONL 存储，`beforeTool` 里 `memo("approvalId")` 后写一个标记文件，然后永远挂起；父进程看到标记后 SIGKILL 子进程，再用新的 registry 重开同一份存储 | 第 1 部分：执行参数为 alice；状态 `done`；provider 被调用 3 次；ledger 不在 model context 里；fork 只包含到 at 为止的条目；收到的事件有 `submission/run_start/turn_*/message_*/tool_execution_*/usage_changed/entry_appended/run_end`。第 2 部分：`inspect()` 显示 `pi.tool:ready`、`pi.generation:waiting`；hook 重跑 1 次，memo 读回 `appr-12`；工具执行；状态 `done` |
| D `probe-coding-agent` | `ModelRuntime.create({modelsPath:null, refreshOnCreate:false})`，再 `registerNativeProvider(faux)`；`DefaultResourceLoader` 关掉 skills、模板、主题、上下文文件，挂一个内联扩展：注册 `send` 工具；`tool_call` 里 await 300ms 后改 `event.input`；`tool_result` 加上 policy；`agent_before_settle` 第一次时 `appendEntry` 并返回 `custom_message` 加 `continue:true`。然后 `navigateTree(第一条 user, {summarize:true, customInstructions, label})` | 实际执行的是 alice；details 带上了 policy；entry 序列为 `…, custom:guard_ledger, custom_message:nudge, message:assistant`；provider 上下文里没有 `guard_ledger`；`navigateTree` 发出摘要请求，生成 `branch_summary` 和 `label` 两条 entry |

探针 C 第 2 部分的核心写法（可以直接作为二狗"恢复待审批"的原型）：

```js
hook(ToolTask, {
  beforeTool: async (call, api, ctx) => {
    const approvalId = await api.memo("ergou.approvalId", `appr-${api.taskId}`, ctx); // first writer wins，崩溃后不变
    await approvals.ensurePending(approvalId, { call });                              // 二狗自己的审批表：幂等 upsert，并推送
    const d = await approvals.waitDecision(approvalId, signalFrom(ctx));              // 必须响应取消
    return d.granted ? (d.rewrite ? { arguments: d.rewrite } : undefined) : { block: d.reason };
  },
});
```

---

## 附录 B：来源清单

- **发布包**（`npm pack <包>@1.0.4`，gitHead `7c10bd43`）：
  - `@earendil-works/pi-agent-core@1.0.4`：`package.json`、`README.md`、`dist/types.d.ts`、`dist/agent.d.ts`、`dist/agent.js`、`dist/agent-loop.js`。
  - `@earendil-works/pi-ai@1.0.4`：`dist/types.d.ts`、`dist/api/openai-completions.js`、`dist/api/transform-messages.js`、`dist/utils/transcript.js`、`dist/utils/validation.js`、`dist/models.js`、`dist/providers/deepseek.js`、`dist/providers/data/deepseek.json`、`dist/providers/faux.d.ts`。
  - `@earendil-works/pi-coding-agent@1.0.4`：`package.json`、`CHANGELOG.md`、`docs/sdk.md`、`dist/core/agent-session.d.ts`、`dist/core/agent-session.js`、`dist/core/extensions/types.d.ts`、`dist/core/extensions/runner.js`、`dist/core/session-manager.d.ts`、`dist/core/session-manager.js`、`dist/core/system-prompt.d.ts`、`dist/core/defaults.js`、`dist/core/model-runtime.d.ts`、`examples/sdk/12-full-control.ts`、`examples/extensions/subagent/index.ts`、`examples/extensions/permission-gate.ts`。
  - `@earendil-works/pi-durable@1.0.4`：`package.json`、`README.md`、`CHANGELOG.md`、`dist/index.d.ts`、`dist/types.d.ts`、`dist/entries.d.ts`、`dist/harness/types.d.ts`、`dist/harness/tool.js`、`dist/harness/generation.js`、`dist/harness/agent.js`、`dist/harness/scheduler.js`、`dist/harness/events.d.ts`、`dist/storage/sqlite/node.js`、`dist/storage/jsonl/node.d.ts`。
- **GitHub（v1.0.4 发布提交 `7c10bd43`）**：
  - [agent CHANGELOG](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/agent/CHANGELOG.md)
  - [ai CHANGELOG](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/CHANGELOG.md)
  - [durable README](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/README.md)
  - [durable spec](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/docs/spec.md)（§7.2 第 2533 行起，§12 第 4541 行起）
  - [例子 23](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/durable/test/examples/23-subagent-background.ts)
- **GitHub main（`ae92585`，未发布）**：[durable](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/durable/CHANGELOG.md)、[agent](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/agent/CHANGELOG.md)、[ai](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/ai/CHANGELOG.md) 三份 CHANGELOG 的 Unreleased 部分。
- **npm registry**：`npm view @earendil-works/<pkg> time / gitHead / dist-tags`（2026-10-07 查询）。
- **AgentSense**：
  - `REF/web/src/agent/runtime.ts`（全文）；
  - `REF/web/package.json`；
  - `REF/web/node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts`（0.85.1，第 501–580、642、655 行）。
- **本目录**：
  - `01-ref-agentsense.md` §2；
  - `03-openclaw-and-pi.md` §A、§C2；
  - `09-chat-multimedia.md` §4（DeepSeek 官方文档引用见该文）。
