# 调研 03：OpenClaw 与 pi（截至 2026-10-06）

> - **调研对象与快照**
>   - pi：`earendil-works/pi`（原 `badlogic/pi-mono`），commit `ddaa0a0341a8`（2026-10-06），npm 最新版 `1.0.4`。
>   - OpenClaw：`openclaw/openclaw`，commit `bfde36e86028`（2026-10-06），npm `latest` 为 `2026.9.8`，`beta` 为 `2026.10.1-beta.1`。
> - **方法**
>   - 两个仓库都做了浅克隆，读了 docs、源码和 CHANGELOG。
>   - 版本和依赖关系用 npm registry 元数据核对。
>   - GitHub API 用来读竞品 README 和 issue（issue 只做"按 reactions 排序列出"，没有搜索）。
>   - WebFetch 读了 pi.dev、作者博客、OpenClaw 官方博客和 arXiv。
>   - **局限**：本会话的 WebSearch 配额用完了，第三方媒体和博客里的用户抱怨没能系统收集。§B6 主要依据官方文档自己写明的限制，加上 GitHub issue。
> - **标注**
>   - 不加标的是事实，后面附来源 URL。
>   - 【判断】是本文作者的分析或建议。
>   - 【未核实】表示来源打不开或只看到了标题。
> - **链接约定**：仓库内文件的链接都固定到上面两个 commit，方便复现。为了省篇幅，下文把下面两个前缀记作 `PI/` 和 `OC/`，所有链接都写成完整 URL。
>   - `PI/` = `https://github.com/earendil-works/pi/blob/ddaa0a0341a8/`
>   - `OC/` = `https://github.com/openclaw/openclaw/blob/bfde36e86028/`

---

## 0. 决策摘要（TL;DR）

1. **OpenClaw 早已不是"跑在 pi 上"了。**
   - 到 `2026.5.27`（2026-05-28 发布）为止，OpenClaw 的 npm 依赖里还有 `@earendil-works/pi-agent-core` / `pi-coding-agent`。从 `2026.5.28` 起这两个依赖没有了（依据 [npm registry](https://registry.npmjs.org/openclaw)，作者逐个版本核对 `dependencies` 得出）。
   - 现在官方文档的说法是：OpenClaw 自己拥有内置 agent runtime（`@openclaw/agent-core`），"No external agent framework packages remain"；只剩 `pi-tui` 还是第三方依赖。旧的 runtime id `pi` 现在只是 `openclaw` 的别名（[OC/docs/agent-runtime-architecture.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/agent-runtime-architecture.md)）。
   - `THIRD_PARTY_NOTICES` 写的是 "Portions of OpenClaw were adapted from Pi"（[OC/THIRD_PARTY_NOTICES.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/THIRD_PARTY_NOTICES.md)）。
   - 【判断】所以"在 pi 上做一个改进版 OpenClaw"，意味着 OpenClaw 在 pi 之外自己搭的那几层，ergo 要自己重建或另找替代：Gateway、渠道、记忆、调度、策略。另外，OpenClaw 现在的内核和 pi 已经各走各的路了。
2. **pi 现在归 Earendil 公司，API 变动很快。**
   - 2026-04-08 作者宣布带着 pi 加入 Earendil（[博客](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)）。
   - 2026-05-07 起，npm 包改到 `@earendil-works` 命名空间下（[pi.dev changelog](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home)）。
   - 2026-10-01 发布 1.0。从 0.74.0 到 1.0.4 一共发了 58 个版本，其中 9 个版本带 "Breaking Changes" 小节（依据 [PI/packages/coding-agent/CHANGELOG.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/CHANGELOG.md)，作者自己统计）。
   - **pi-agent-core 1.0 把实验性的 `AgentHarness` 整个删了**，连同 sessions、compaction、skills、harness tools 一起，叫用户改用 `pi-durable`（[PI/packages/agent/CHANGELOG.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/agent/CHANGELOG.md)）。
   - 【判断】前作用的正是 `pi-agent-core@0.85.1` 的 `AgentHarness`（调研 01，未公开）。ergo 想继承它的机制，就必须迁到 pi-durable，或者回到 `Agent` 类自己搭。
3. **`pi-durable` 最接近 ergo 想要的底座，但刚出生不久。**
   - 它提供可崩溃恢复的会话、任务和文档运行时，并给出了正式的 subagent 写法：任务拥有子会话；有后台 anchor；能持久化子 agent 并给它 steer 或 follow-up；有任务图。每个会话可以单独配置 model、tools、extensions、instructions 和 cwd（[PI/packages/durable/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/durable/README.md)）。
   - 但它 2026-09-19 才在 npm 首发（0.0.1，见 [npm registry](https://registry.npmjs.org/@earendil-works/pi-durable)），README 第一行就写着 "Experimental. The API changes without notice between releases."，1.0.3 和 1.0.4 又各有破坏性变更。
4. **`pi-web-ui` 已经停更。**
   - 它在 v0.75.3（2026-05-18）之后从 monorepo 里删掉了（`packages/web-ui` 在 tag v0.75.3 还在，v0.75.4 就是 404）。npm 上最后一版是 `0.75.3`（[registry](https://registry.npmjs.org/@earendil-works/pi-web-ui)）。
   - 官方现在的方向是 `chord` + `pi-server` / `pi-client` / `pi-protocol`，用于远程会话和"remote WebUI"，但这几个都标着 experimental，没有兼容性保证，也没有实现鉴权（[PI/packages/protocol/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/protocol/README.md)）。
   - 【判断】ergo 的 Web UI 要自己写。
5. **pi 的立场：核心极简，但不再教条。**
   - 2025-11 时作者明确说不做 MCP、不做 sub-agent、不弹权限框、不做 plan mode、不做 todo、不做后台 bash（[博客](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)）。
   - 但 0.99.0（2026-09-29）把 MCP、codemode 和 tool_search 做成了内置扩展（[PI/packages/coding-agent/CHANGELOG.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/CHANGELOG.md)）。
   - sub-agent 和 plan mode 现在仍然不进核心（[PI/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/README.md)），但官方给了示例扩展（`examples/extensions/subagent`、`plan-mode`、`permission-gate.ts`、`sandbox/`）。社区也有 `pi-subagents`，约 58 万次/月下载（[pi.dev/packages](https://pi.dev/packages)）。
6. **pi 的扩展钩子足以支撑 ergo 的三类需求**（见 §A2.4）：
   - 审批 / 策略门禁：用 `tool_call`，可以拦截，也可以改参数。
   - 往上下文里注入记忆或画像：用 `before_agent_start`（按段改 system prompt）和 `context`（逐次请求改消息）。
   - 派生子 agent：可以 `registerTool` 加起子进程或用 SDK，也可以用 pi-durable 的任务拥有子会话。
7. **OpenClaw 的记忆系统已经相当工程化，但明确不做"动机推断 / 人物档案"。**
   - 已有的部分：分层文件、来源（provenance）和 taint、默认开启的后台整理"dreaming"、写成指令式条目的 `USER.md`、standing intents（事件触发的"到时候提醒我"）、"Active Memory"深度回忆子 agent、带衰减和重要度的混合检索。
   - 但文档原话是 "Do not turn the file into a dossier"，又说 "OpenClaw does not merge files or create a dossier"（[OC/docs/concepts/user-model.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/user-model.md)）。【判断】这正是差异化 (1) 的空间。
8. **OpenClaw 已经有"秘书 + 专家"团队的雏形**（[OC/docs/concepts/multi-agent.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/multi-agent.md)）：
   - 有个 team preset：一个 coordinator（文档叫 chief of staff），加 researcher、writer、reviewer 三个专家。
   - 委派靠 `sessions_spawn`，有嵌套深度上限和逐级 announce；大批并行用 Swarm；还有 Workboard 看板插件。
   - 缺的东西：没有"项目"这个一等实体，也没有 PM 角色。委派是靠提示词引导（`delegationMode: "prefer"` 文档原话是 "prompt guidance, not a scheduler"）。
9. **OpenClaw 主动打扰这块已经改成"默认安静"**（[OC/docs/gateway/heartbeat.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/heartbeat.md)、[OC/docs/web/notifications.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/web/notifications.md)）：
   - `HEARTBEAT.md` 退役了。heartbeat 的默认 prompt 要求没事就回 `NO_REPLY`，并且"不要从旧聊天里推断任务"。
   - 推送通知按类别开关，可设安静时段，默认只推审批。
   - 缺的东西：没有"按任务配置何时提醒"这一层策略。
10. **安全与复杂度是 OpenClaw 的两大软肋**：
    - 沙箱和 exec 审批**默认都关**，默认权限是 full access（[OC/docs/start/why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)）。
    - ClawHub 出过恶意 skill 事件。截至 2026-08-27，仓库公开 advisory 共 647 条（同上页）。
    - 官方自评的总体成熟度是 68%，等级 Alpha（[OC/docs/maturity/scorecard.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/maturity/scorecard.md)）。
    - NanoClaw 作者的批评是 "nearly half a million lines of code, 53 config files, and 70+ dependencies"（[nanoclaw README](https://github.com/nanocoai/nanoclaw)）。

---

## A. pi

### A0. 项目现状

| 项 | 现状 | 来源 |
|---|---|---|
| 归属 | 2026-04-08 Mario Zechner 宣布加入 Earendil（Armin Ronacher 等人创办），"pi is owned by Earendil, the company"。他承诺永远 MIT，不要求签 CLA 或 DCO，以后可能出 Fair Source 和企业版的增值层 | [mariozechner.at/posts/2026-04-08-ive-sold-out](https://mariozechner.at/posts/2026-04-08-ive-sold-out/) |
| 仓库与包名 | 仓库迁到 `earendil-works/pi`；npm 改用 `@earendil-works/*`，第一版是 0.74.0，旧的 `@mariozechner/*` 已标记废弃 | [pi.dev changelog 2026-05-07](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home) |
| 版本 | 1.0.0 于 2026-10-01 发布；1.0.4 于 2026-10-05 发布 | [PI/packages/coding-agent/CHANGELOG.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/CHANGELOG.md) |
| 规模 | GitHub 约 11.3 万 star、1.4 万 fork | GitHub API `repos/earendil-works/pi` |
| 许可证 | MIT | [PI/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/README.md) |
| 贡献政策 | 新贡献者的 issue 和 PR 默认自动关闭，维护者每天复查 | 同上 |
| 运行时 | Node.js ≥ 22.19（各包 `engines` 一致），另有 Bun 二进制和 Nix 安装方式 | 同上；各包 `package.json` |

### A1. 包结构

当前 monorepo（`packages/*`）里的包如下。描述取自各包 `package.json` 和 README：

| 包 | 作用 | 成熟度 |
|---|---|---|
| `@earendil-works/pi-ai` | 统一的多 provider LLM API。按 provider 组织集合，自动解析鉴权，统计 token 和成本，支持中途换模型时交接上下文。另有 image generation、classification、constrained sampling，以及测试用的 faux provider。chat 目录只收支持 tool calling 的模型。provider 有 30 多个（OpenAI、Anthropic、Google/Vertex、Bedrock、DeepSeek、Moonshot、Qwen、MiniMax、ZAI、OpenRouter、Ollama/vLLM 等兼容端点…） | 稳定核心（[PI/packages/ai/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/ai/README.md)） |
| `@earendil-works/pi-agent-core` | `Agent` 类、agent loop、proxy stream。1.0 起"only `Agent`, the agent loop, the proxy stream, and their types" | 核心，1.0 时大幅瘦身（[PI/packages/agent/CHANGELOG.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/agent/CHANGELOG.md)） |
| `@earendil-works/pi-coding-agent` | `pi` CLI 和 SDK，自带 `read/bash/edit/write` 等工具，以及会话管理、扩展、skills、prompt templates、themes、packages、MCP、codemode | 主产品（[PI/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/README.md)） |
| `@earendil-works/pi-tui` | 差分渲染的终端 UI 库 | 稳定（OpenClaw 至今仍在用） |
| `@earendil-works/pi-durable` | 持久化的 conversation / task / document 运行时：先提交再显示，崩溃后能接着跑 | **Experimental**，2026-09-19 首发（[README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/durable/README.md)、[npm](https://registry.npmjs.org/@earendil-works/pi-durable)） |
| `@earendil-works/chord` | 应用组装运行时，提供 plugins、facets、services、replicated state、远程服务边界和 Go 风格的 context。"not a Pi package"，目标是让同一个功能能分别跑在 agent worker、TUI 和远程 WebUI 里 | 新（2026-09-04 首发）（[PI/packages/chord/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/chord/README.md)） |
| `@earendil-works/pi-server` / `pi-client` / `pi-protocol` | 远程 pi 会话：基于 CBOR 帧和 route fencing，可多端同时 attach | "experimental … no compatibility guarantees"，"Peer authentication … not implemented"（[protocol README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/protocol/README.md)、[server README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/server/README.md)） |
| `@earendil-works/pi-codemode` | 在 QuickJS（WASM）沙箱里运行模型写的 JS，脚本唯一的能力就是调用注入进来的工具。嵌套调用的结果不进 LLM 上下文 | 新（[README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/codemode/README.md)） |
| `@earendil-works/pi-mcp` | 独立的 MCP client（stdio / Streamable HTTP / OAuth），不依赖官方 SDK | 新（[README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/mcp/README.md)） |
| `@earendil-works/pi-env` | 远程执行环境：通过 SSH 把一个 Rust daemon 部署到远程机器，让 durable 的工具在那台机器上执行 | 新（[README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/env/README.md)） |
| `@earendil-works/pi-telemetry` | 与厂商无关的 telemetry 契约 | 新 |
| `pi-evals` | 私有包 | — |

**已经不在仓库里的包**：
- `web-ui`：v0.75.3 之后删除，详见 §A4。
- `mom`（Slack bot）和 `pods`（vLLM 部署）：在 v0.75.3 tag 下已经找不到（作者用 raw.githubusercontent 请求，返回 404）。

#### A1.1 Agent loop 与核心抽象（pi-agent-core）

来源：[PI/packages/agent/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/agent/README.md)

- **消息**
  - Agent 内部用的是可扩展的 `AgentMessage`：用 TypeScript declaration merging 往 `CustomAgentMessages` 里加自定义角色。
  - 管道是 `AgentMessage[] → transformContext() → convertToLlm() → Message[] → LLM`。其中 `transformContext` 负责裁剪或注入上下文；`convertToLlm` 是必需的，负责把自定义消息过滤或转换成 LLM 认识的 `user/assistant/toolResult`。
- **事件**
  - 依次有 `agent_start → turn_start → message_start/update/end → tool_execution_start/update/end → turn_end → agent_end`。
  - `subscribe()` 的回调按注册顺序 await。
- **工具（`AgentTool`）**
  - 参数用 TypeBox schema 描述，`execute(toolCallId, params, signal, onUpdate)`。
  - 失败时要抛异常，不要把错误写进返回内容。
  - 可以用 `executionMode: "parallel" | "sequential"` 设定执行方式，默认 parallel：预检逐个进行，执行并行。
  - 结果里带 `terminate: true` 表示希望跳过自动续跑，只有同一批工具全部同意时才生效。
- **生命周期钩子**
  - `beforeToolCall`：可以拦截，也可以 terminate。
  - `afterToolCall`：可以改写结果。
  - `prepareRequest`：每次请求 provider 之前都会跑，可以把 context 换成持久化的规范版本。
  - `finishTurn`：返回 `{action:"continue"|"end"}`。它在 0.87.0 取代了 `shouldStopAfterTurn`，属于破坏性变更。
- **Steering 与 follow-up 队列**
  - `agent.steer(msg)`：在当前这批工具跑完之后注入。
  - `agent.followUp(msg)`：等 agent 整个跑完再处理。
  - 两个队列都有 `steeringMode` / `followUpMode` 设置（`one-at-a-time` 或 `all`），另有 `peekQueuedMessages()` 可以只看不取。
- **其他**
  - thinking level 分 `off|minimal|low|medium|high|xhigh|max` 几档。
  - 设置 `sessionId` 可以让 provider 端做缓存亲和。
  - `streamProxy` 让浏览器端经代理去调 LLM。

#### A1.2 会话、会话树、compaction（pi-coding-agent）

- **会话树**
  - 会话以 JSONL 文件保存，每条 entry 都有 id 和 parent，所以消息和事件构成一棵树。从更早的某条 entry 接着往下写，就在同一个文件里形成新分支；当前用的那条叫 active branch（[PI/docs/how-pi-works.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/how-pi-works.md)）。
  - 相关命令有 `/tree`、`/fork`、`/clone`、`/resume`（[slash-commands.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/slash-commands.md)）。
- **Compaction**（[compaction.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/compaction.md)）
  - 当 `contextTokens > contextWindow - reserveTokens`（默认 16384）时自动触发，也可以手动 `/compact [instructions]`。
  - 默认保留最近约 `keepRecentTokens`（20k）原文，更早的部分由 LLM 写成结构化摘要，存为 `CompactionEntry`；再次压缩时会把上一份摘要一并带进去，迭代生成。
  - 切换到别的分支时，另有 branch summarization 负责保留上下文。
  - 扩展可以通过 `session_before_compact` 取消压缩，或者自己提供摘要。
- **上下文文件**
  - 会读 `AGENTS.md` / `CLAUDE.md`（用户级、项目级都读）。
  - `SYSTEM.md` 会替换默认 system prompt，`APPEND_SYSTEM.md` 是在后面追加（[configuration.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/configuration.md)）。
- **默认工具**
  - 默认开的是 `read, bash, edit, write`。
  - 另外还内置 `powershell, grep, find, ls`。`codemode` 和 `tool_search` 是内置扩展，默认关（[settings.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/settings.md)）。

#### A1.3 Provider 抽象（pi-ai）

- 包里面向用户的入口是 `createModels()` 加按 provider 区分的 factory，调用统一走 `streamSimple` / `completeSimple`，也可以按 provider 传专有选项。
- 内置 credential store 和 OAuth 登录（ChatGPT、Copilot、Anthropic 等）。
- 支持 `createProvider()` 自定义 provider，也有 OpenAI 兼容设置，可以中途切换 provider 而不丢上下文（Cross-Provider Handoffs）。
- 可以在浏览器里用，也可以 tree-shaking。
- 来源：[PI/packages/ai/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/ai/README.md)。
- coding-agent 还加了一层 **virtual models**，扩展可以按每次请求做路由（`pi.registerVirtualModel()`，见 [extensions.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/extensions.md)）。【判断】这一层可以拿来做"闲聊用便宜模型，任务用强模型"。

#### A1.4 SDK / RPC / Print-JSON 四种用法

来源：[PI/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/README.md)、[sdk.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/sdk.md)、[rpc.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/rpc.md)

| 模式 | 进程边界 | 适合 |
|---|---|---|
| Interactive（TUI） | — | 人直接用 |
| Print / JSON | 子进程，跑一次 | 脚本 |
| RPC（`pi --mode rpc`） | 长驻子进程，stdin/stdout 走 JSONL：命令、响应、会话事件、Extension UI 记录 | 其他语言、需要进程隔离、IDE；TS 侧有 `RpcClient` 可用 |
| SDK（`createAgentSession()`） | 同一进程 | Node/Bun 宿主；能拿到 `AgentSession` 和 `SessionManager`，也能用内存会话 |

OpenClaw 在 2026-05 之前正是走 SDK 路线：直接 `createAgentSession()`，没有用子进程，也没有用 RPC（[OC v2026.5.27 docs/pi.md](https://github.com/openclaw/openclaw/blob/v2026.5.27/docs/pi.md)）。

#### A1.5 pi-durable

ergo 应当重点看这个包。来源：[PI/packages/durable/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/durable/README.md)

- **概念**
  - `Harness`：一份存储，加上在它上面跑 agent 的机制。
  - `Conversation`：transcript。
  - `Entry`：不可变记录。
  - `Commit`：原子写入。
  - `Document`：带类型的 JSON 状态。
  - `Task`：每一步都存 checkpoint 的状态机。
  - `Submission`：一次提交。
  - 内置的文档有 `pi.agent`、`pi.inbox`、`pi.live`、`pi.usage` 等。
- **持久化与恢复**
  - 存储后端可以用 SQLite、JSONL 或内存。
  - 用 `requestId` 做幂等重提交。
  - 工具调用前先写入意图。崩溃后，只有声明了 `replay: "safe"` 的工具会重跑。
- **Inbox**：会话忙时，新的 submission 可以选 `steer`、`followUp`（默认）、`reject` 或 `write`（只追加 entry，不问模型）。
- **扩展与按会话配置**
  - 扩展打包 `tools / sections / hooks / wraps / tasks`。
  - 每个会话可以用 `configure({ model, thinkingLevel, extensions, tools, instructions, cwd })` 单独设定。
  - Hooks 有两组：Generation 上的 `beforeRequest / afterResponse / onYield / afterTools`，Tool 上的 `beforeTool / afterTool`。
- **Subagent 的官方写法**
  - 子会话的 ownership 设为 `{kind:"task", taskId}`，即归某个任务所有。父任务 abort 时子会话也跟着 abort；子会话没停下来，父会话就不算 idle。
  - `background: true` 的任务是一道边界：后台子 agent 不受父会话 abort 影响。
  - 例子 `23-subagent-background.ts` 演示了"持久子 agent：spawn、steer、stop、list，并把结果回报给父会话"，重启后也安全。
- **其他**
  - Child tasks 支持等待（`allSettled` / `failFast`），abort 自底向上。
  - `taskGraph()` 能实时给出整棵任务树，可以直接用来做任务面板。
  - `viewState()`、`watch()`、`watchEvents()` 提供 UI 需要的全部状态和事件流。
- 【判断】ergo 要的"后台长任务、项目子 agent 组、任务面板、提醒"，在语义上几乎都能落到 pi-durable 上。代价是 API 随时会变。

### A2. 扩展系统（pi-coding-agent）

#### A2.1 加载与生命周期

来源：[extensions.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/extensions.md)

- **扩展形态**：TS/JS 模块，默认导出一个 factory，参数是 `ExtensionAPI`。用 `jiti` 加载，不用编译。
- **加载位置**：`~/.pi/agent/extensions/`、项目 `.pi/` 目录，或者命令行 `-e`。
- **权限**："An extension runs inside the Pi process with the same operating-system permissions"。
- **生命周期约束**
  - factory 里不要起进程、socket、定时器，这些放到 `session_start` 里做。
  - 清理在 `session_shutdown` 里做，而且必须幂等。
  - `/reload` 会换掉整个扩展运行时。
- **项目信任**：项目级扩展、设置和 MCP 要在 project trust 授予之后才加载。只有个人扩展能参与 `project_trust` 事件。

#### A2.2 ExtensionAPI 能力

| 能力 | API |
|---|---|
| 订阅或修改生命周期 | `pi.on(event, handler)` |
| 注册给模型调用的工具 | `pi.registerTool()`，可以设 `exposure`、`namespace`、`annotations`、`outputSchema`、`prepareLoadout` |
| 注册斜杠命令、快捷键、CLI flag | `pi.registerCommand / registerShortcut / registerFlag` |
| 发消息 | `pi.sendUserMessage()`、`pi.sendMessage()`（自定义消息会进模型上下文） |
| 写不进上下文的持久数据 | `pi.appendEntry()` |
| 切换活跃工具、模型、思考等级 | `pi.getActiveTools / setActiveTools / getAllTools` 等 |
| 加 provider、MCP server、virtual model | `pi.registerProvider / registerMcpServer / registerVirtualModel` |
| 扩展之间通信 | `pi.events` |
| 嵌套模型调用和嵌套工具调用 | `ctx.modelRegistry.streamSimple()`、`ctx.executeTool()` |
| UI | `ctx.ui.confirm / select / input / notify / setStatus / setWidget / setTitle / custom`。TUI 下全部可用；RPC 模式下可通过 "RPC Extension UI protocol" 转发对话框和通知；JSON/print 模式没有 UI |

来源：[extensions.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/extensions.md)、[types.ts](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/src/core/extensions/types.ts)

**工具暴露级别**（`exposure`）共五种：
- `direct`：声明给模型。
- `model-only`：声明给模型，但不能被其他工具调用，适合"编排型"工具。
- `codemode`：只能在 codemode 脚本里调用。
- `deferred`：要先通过 `tool_search` 找到才会激活。
- `hidden`：注册了，但不可达。

工具还可以带 MCP 风格的 annotations（`readOnlyHint`、`destructiveHint` 等）。这些提示不做校验，但权限扩展可以拿来判断该不该让人确认。文档直接给了"模仿 Codex 审批规则"的示例代码（[extensions.md#tool-exposure](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/extensions.md)）。

#### A2.3 完整事件清单

依据 [types.ts 第 1558–1625 行](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/src/core/extensions/types.ts)：

| 类别 | 事件 | 能否改变行为 |
|---|---|---|
| 资源 / 信任 | `project_trust`, `resources_discover` | 可以提供资源，可以参与信任决定 |
| 会话 | `session_start`, `session_info_changed`, `session_shutdown`, `session_tree`, `session_compact`, `session_compact_failed`, `mcp_servers_change` | 只通知 |
| 会话变更前 | `session_before_switch`, `session_before_fork`, `session_before_tree`, `session_before_compact` | 可 `cancel`；compact 时可以自带 `compaction`，tree 时可以自带 summary |
| 上下文 | `context`, `context_with_system` | 返回 `{messages}` 替换本次请求的消息，只影响这一次请求 |
| Provider | `before_provider_request`, `before_provider_headers`, `after_provider_response`, `provider_stream_event`, `cache_warming_decision` | 可以改请求或请求头；可以决定要不要预热缓存 |
| Agent | `before_agent_start` | 返回 `message` 可以注入一条自定义消息，返回 `systemPrompt` 可以换掉整个 prompt；也可以改 `systemPromptOptions` 里的分段、选中的工具和 guidelines |
| Agent | `agent_start`, `agent_end`, `agent_settled` | 只通知（`agent_settled` 表示"不会再自动继续"） |
| Agent | `agent_before_settle`, `turn_end` | 可以追加 `custom`、`custom_message`、`context_edit`、`compaction` 类 entry，并返回 `continue: true` 再跑一轮 |
| 消息 | `message_start`, `message_update` | 只通知 |
| 消息 | `message_end` | 可以替换最终消息（角色不变） |
| 工具 | `tool_call` | `{block, reason, terminate}`；原地修改 `event.input` 即可改参数；**handler 抛异常会被当作拦截（fail-safe）** |
| 工具 | `tool_result` | 可以改写结果，多个 handler 依次叠加 |
| 工具 | `tool_execution_start/update/end` | 只通知（嵌套调用会带 `parentToolCallId`） |
| 输入 | `input` | 可以改写或接管用户输入 |
| 输入 | `user_bash` | 可以接管 `!` 命令 |
| UI / 模型 | `ui_prompt_start/end`, `model_select`, `thinking_level_select` | 只通知 |

#### A2.4 三类需求分别挂在哪些钩子上

**(a) 工具调用的审批 / 策略门禁**

- **主钩子是 `tool_call`。**
  - 返回 `{ block: true, reason }` 拒绝；直接改 `event.input` 就能改参数。
  - handler 出错按拦截处理，这是 fail-safe 设计。
  - 有 UI 时可以 `await ctx.ui.select / confirm` 当场问人；没有 UI 时应当默认拦截。官方 [permission-gate.ts](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/examples/extensions/permission-gate.ts) 就是这样写的。
- **辅助手段**：
  - `tool_result` 做审计或脱敏；
  - `user_bash` 管住人手动敲的命令；
  - `setActiveTools` 按角色裁剪工具集；
  - `annotations` 判断风险等级；
  - `project_trust` 管项目级资源加载。
- **官方示例**：`permission-gate.ts`、`protected-paths.ts`、`confirm-destructive.ts`、`dirty-repo-guard.ts`、`sandbox/`、`plan-mode/`（只读 + bash 白名单）。见 [examples/extensions](https://github.com/earendil-works/pi/tree/ddaa0a0341a8/packages/coding-agent/examples/extensions)。
- **更底层的等价物**：
  - pi-agent-core 的 `beforeToolCall` / `afterToolCall`；
  - pi-durable 的 `hook(ToolTask, { beforeTool: … ? { block: "Needs approval" } : undefined })`（[durable README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/durable/README.md)）。
- **注意**
  - 同一条 assistant 消息里的多个工具调用可能并行执行，各个 handler 不能假设兄弟调用已经有了结果。
  - pi 官方的立场是：审批只是体验，真正的安全边界在 OS 或容器（[security.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/security.md)："does not ask for approval before every tool call"，并且推荐容器化）。

**(b) 把用户记忆或画像注入上下文**

- **稳定的画像**（相当于 USER.md）：放在 `before_agent_start` 里。
  - 推荐改 `systemPromptOptions` 的分段，而不是整段替换。这样 pi 会把 prompt 的变化写成 transcript 里的增量，"Only what changed is sent again"，provider 的前缀缓存能保住。durable 的文档同样强调：每次都变的分段（比如当前时间）会让缓存失效。
  - 需要可见或可审计时，用返回的 `message` 注入一条 `custom_message`。
- **按请求检索出来的记忆片段**：用 `context`（只改本次请求的消息、不改会话，pi 在请求后会恢复原状），或者用 agent-core 层的 `transformContext` / `prepareRequest`。
- **写记忆**
  - `agent_settled` / `agent_end` 适合在一轮结束后做异步抽取。
  - `session_before_compact` 适合在压缩前把要紧的东西写进记忆，相当于 OpenClaw 的 memory flush。
  - `turn_end` / `agent_before_settle` 可以追加 entry，必要时再续一轮。
  - `pi.appendEntry()` 存不进模型上下文、但随会话持久化的元数据。
  - 后台的 LLM 调用用 `ctx.modelRegistry.streamSimple()`。
- **用户输入的预处理**：放在 `input` 事件里，比如先识别是闲聊还是任务。

**(c) 派生或编排子 agent**

- **官方示例 [examples/extensions/subagent](https://github.com/earendil-works/pi/tree/ddaa0a0341a8/packages/coding-agent/examples/extensions/subagent)**
  - 注册一个 `subagent` 工具，每个子 agent 是一个**独立的 `pi` 子进程**，上下文互相隔离。
  - 有三种模式：single、parallel（最多 8 个任务、4 个并发）、chain（用 `{previous}` 占位符串接）。
  - agent 定义写成 markdown + frontmatter，指定 `name / description / tools / model`。示例自带 scout、planner、reviewer、worker 四个角色。
  - 默认只加载用户级定义；要用项目级 agent 得显式开启，并经过确认。
- **进程内的做法**：用 SDK 的 `createAgentSession({ sessionManager: SessionManager.inMemory() })` 起子会话；或者让工具通过 `ctx.executeTool()` 去调别的工具。
- **pi-durable 的做法**：任务拥有子会话，有后台 anchor，有任务图。这是官方给出的语义最完整的一种，见 §A1.5。
- **社区包**：`pi-subagents`（nicobailon，约 583K/月，自带 scout、researcher、evidence-auditor、worker 等角色，支持后台子 agent）（[npm](https://www.npmjs.com/package/pi-subagents)、[pi.dev/packages](https://pi.dev/packages)）。

### A3. pi 在 sub-agent、多 agent、MCP、权限和 plan mode 上的立场

| 话题 | 立场 | 来源 |
|---|---|---|
| 总体 | "Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way." | [PI/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/README.md) |
| 2025-11 时的原始理由 | 不做 MCP（工具描述会占掉 7–9% 的上下文）；不做专用 sub-agent 工具（黑盒、不好观察）；默认 YOLO（"security theater"）；不做 plan mode（主张写成文件）；不做内置 todo；不做后台 bash（建议用 tmux） | [mariozechner.at 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) |
| MCP（已经转向） | 0.99.0 把 codemode、tool_search、MCP 做成内置扩展。MCP 工具默认用 `codemode` 方式暴露，不直接声明给模型，以此缓解上下文膨胀；`--no-mcp` 可以关掉 | [CHANGELOG 0.99.0](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/CHANGELOG.md)、[mcp.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/mcp.md) |
| 权限 | 没有内置权限系统，"Safety comes from limiting the files, credentials, processes, and network services Pi can access"；推荐容器化；project trust 只管启动时加载什么 | [security.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/security.md) |
| Plan mode | 不进核心；有官方示例扩展（`/plan` 切换只读，bash 走白名单，用 `[DONE:n]` 跟踪进度）；社区有 `@narumitw/pi-plan-mode`、`@plannotator/pi-extension` | [plan-mode/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/examples/extensions/plan-mode/README.md)、[pi.dev/packages](https://pi.dev/packages) |
| Sub-agent / 多 agent | 核心不提供；官方给了示例扩展和 pi-durable 的模式；社区有 `pi-subagents`、`@tintinweb/pi-subagents`、`@kontextmind/kxm`（多 agent 编排加仪表盘）、`agent-comms`（跨 harness 的通信网） | 同上 |
| 社区的记忆和权限扩展 | `pi-memory`、`pi-memory-wiki-all-you-need`、`@gotgenes/pi-permission-system` 等 | [pi.dev/packages](https://pi.dev/packages) |

【判断】pi 的"不做"指的是"不进核心"，并不反对这些功能本身。MCP 的转向说明，作者的取舍会跟着生态变。ergo 不能指望 pi 的"不做清单"长期不变，更不能指望它一直缺这些功能。

### A4. pi-web-ui

- **当初提供的东西**（据 [v0.75.3 README](https://github.com/earendil-works/pi/blob/v0.75.3/packages/web-ui/README.md)）：
  - 用 mini-lit Web Components 和 Tailwind v4 写成。
  - `ChatPanel`：完整的聊天界面，包括消息流、流式输出、工具执行、Artifacts 面板。
  - `AgentInterface`：自定义布局时用的低层组件，可开关附件、模型选择器、thinking 选择器。
  - 附件：PDF、DOCX、XLSX、PPTX、图片，带预览和文本抽取。
  - Artifacts：HTML、SVG、Markdown，在沙箱里执行。
  - JS REPL 工具。
  - 用 IndexedDB 存 sessions、API keys 和 settings（`AppStorage`）。
  - CORS 代理。
  - 支持 Ollama、LM Studio、vLLM 等自定义 provider。
  - 它直接在浏览器里跑 `Agent` 加 `pi-ai`，**本质上是纯前端的单用户聊天 UI**。
- **现状**
  - v0.75.4（2026-05-20）的 CHANGELOG 写着 "Removed web UI workspace references from the CLI package"。`packages/web-ui` 在 tag v0.75.4 已经不存在了。
  - npm 上 `@earendil-works/pi-web-ui` 的 latest 停在 `0.75.3`（2026-05-18 发布），依赖 `pi-ai@^0.75.3`（[registry](https://registry.npmjs.org/@earendil-works/pi-web-ui)），和当前的 1.0.x 已经不兼容。
- **官方新方向**
  - `chord` 的 README 把"remote WebUI"列为目标环境之一。
  - `pi-server` 支持一个会话同时被多个展示端 attach。
  - pi-durable 的 `viewState()` / `watch()` / `watchEvents()` 明确是给 UI 用的。
  - 但这几样都是 experimental，pi-protocol 也还没有鉴权。
- 【判断】ergo 的 Web 聊天 UI 应该自己写。前端框架可以随意选，后端走自己的 Gateway 协议，比如 WebSocket 加事件流。可以参考 pi-web-ui 的组件拆法（ChatPanel / AgentInterface / ArtifactsPanel）和 durable 的"一切都是提交过的状态"这个模型，但不要依赖它们。前作的 Web UI 设计更值得继承（见调研 01）。

### A5. 语言、运行时、许可证、发版节奏与 API 稳定性

- **语言和运行时**
  - TypeScript，ESM，Node ≥ 22.19。
  - 工具的 schema 用 TypeBox；1.0 前后还升级过 TypeBox 1.3.7，删掉了一些废弃 API，扩展需要跟着迁移（[CHANGELOG](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/CHANGELOG.md)）。
  - 源码按 "Node.js strip-only TypeScript" 的约束来写。
  - 支持 Windows：有专门的 `powershell` 工具和 [windows.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/windows.md)。
- **许可证**：全部 MIT。作者承诺 "It will stay MIT licensed"，同时预告以后会有 Fair Source 和专有的增值层（[博客](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)）。
- **发版节奏**（npm registry 时间戳）
  - `pi-coding-agent` 从 0.74.0（2026-05-07）到 1.0.4（2026-10-05），npm 上共 57 个版本（CHANGELOG 记了 58 条，个别版本没有发到 npm），平均每周 2–3 个。
  - 2026-09-29 到 10-05 这 7 天里发了 0.99.0 到 1.0.4 共 8 个版本。
  - `openclaw` 的 npm 版本则是 2026-01-29 以来共 266 个。
- **API 稳定性**（【判断】：低到中）
  - `pi-agent-core`：0.87.0 删了 `shouldStopAfterTurn`；1.0.0 删了整个 harness。
  - `pi-coding-agent`：0.74.0 以来 9 个版本有破坏性变更，包括 provider 改名、工具选择语义变化等。
  - `pi-durable`："API changes without notice"，1.0.3 和 1.0.4 都有破坏性变更（[durable CHANGELOG](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/durable/CHANGELOG.md)）。
  - `pi-protocol`："no compatibility guarantees"。
- 【判断】建议：
  1. 锁死精确版本；
  2. ergo 只依赖 `pi-ai` 和 `pi-agent-core` 的 `Agent` 这两个最稳的面，其他都包在自己的适配层后面；
  3. 如果用 pi-durable，要准备好跟着升级，或者 fork 一份。

---

## B. OpenClaw

### B0. 现状与"嵌入 pi"的历史

- **规模与治理**
  - 约 39.1 万 star、8.2 万 fork，开着的 issue 约 9.4k（GitHub API）。
  - MIT 许可，由独立的 501(c)(3) 组织 OpenClaw Foundation 管理。支持方包括 Amazon、Microsoft、NVIDIA、OpenAI、Tencent 等 30 多家（[OC/docs/start/why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)）。
- **名字的变迁**：Warelay → Clawdbot → Moltbot → OpenClaw（[OC/VISION.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/VISION.md)）。
- **版本**
  - 用 CalVer。`latest` 是 2026.9.8（2026-10-03），`extended-stable` 是 2026.8.35，`beta` 是 2026.10.1-beta.1（[npm registry](https://registry.npmjs.org/openclaw)）。
  - Node 要求 `>=24.16 <25 || >=26.1`（[OC/package.json](https://github.com/openclaw/openclaw/blob/bfde36e86028/package.json)）。
- **嵌入 pi 的历史**
  - **v2026.5.27 及以前**：在进程内 import pi 的 SDK，直接 `createAgentSession()`，没用子进程，也没用 RPC。依赖 `pi-agent-core / pi-ai / pi-coding-agent / pi-tui@0.75.1`，入口代码在 `src/agents/pi-embedded-runner/`（`runEmbeddedPiAgent()`），负责会话、compaction、扩展加载、auth profile 轮换和 failover（[OC v2026.5.27 docs/pi.md](https://github.com/openclaw/openclaw/blob/v2026.5.27/docs/pi.md)）。
  - **2026.5.28 之后**：自己拥有内置 runtime（`src/agents/embedded-agent-runner/` 加 `packages/agent-core` 即 `@openclaw/agent-core`）。"No external agent framework packages remain"；`pi` 只是 `openclaw` 的旧别名；runtime 还能换成插件 harness：`codex`（Codex app-server）、GitHub Copilot SDK、Claude Code CLI，以及 ACP 外部 agent（[agent-runtime-architecture.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/agent-runtime-architecture.md)、[why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)）。
  - 更早的 2026.5.22 已经关掉了内嵌 pi-coding-agent 的自动重试，"so OpenClaw's own retry and failover loop does not replay failed tool calls through a nested SDK retry"（[OC/CHANGELOG/2026.5.22.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/CHANGELOG/2026.5.22.md)）。【判断】这是双方分开的一个苗头：网关级的重试、failover、会话锁，和 SDK 自己的会话语义互相冲突。
- **外部背景**：作者说，OpenClaw 火起来以后 pi 引来了投资人的兴趣，这是他加入 Earendil 的直接原因（[博客](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)）。

### B1. 架构

**Gateway**（来源：[OC/docs/concepts/architecture.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/architecture.md)）

- 一台主机上跑一个长驻进程，统一持有所有消息渠道。
- WhatsApp 用 Baileys，Telegram 用 grammY，另有 Slack、Discord、Signal、iMessage、WebChat 等。
- 对外是 WebSocket，默认 `127.0.0.1:18789`，第一帧必须是 `connect`。
- 请求格式 `{type:"req",id,method,params}`，事件格式 `{type:"event",event,payload,seq?}`；有副作用的方法要带幂等键。
- 协议由 TypeBox schema 定义，生成 JSON Schema，再生成 Swift 模型。
- 设备一律要配对；本机 loopback 可以自动批准，tailnet/LAN 要人工批准。
- 内部有一个 `GatewayScheduler` 统一负责定时唤醒。

**渠道**
- `extensions/` 下有 WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Feishu、LINE、Matrix、MS Teams、Google Chat、Mattermost、Zalo、IRC、Nostr、SMS、Twitch、X 等插件（[OC/extensions](https://github.com/openclaw/openclaw/tree/bfde36e86028/extensions)）。
- 另外还能作为 A2A 1.0 的对端（`channels/a2a`）。

**客户端**
- **Control UI**：Vite + Lit 写的单页应用，由 Gateway 在同一端口上提供，直接连 Gateway 的 WebSocket（[web/control-ui.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/web/control-ui.md)）。
- **WebChat**：macOS/iOS 上是原生 SwiftUI，浏览器里就是 Control UI 的聊天页。走 `chat.history / chat.send / chat.inject` 这几个 RPC，历史总是从 Gateway 拉取（[web/webchat.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/web/webchat.md)）。
- 还有 CLI、TUI，以及 macOS、iOS、Android 应用。

**Nodes**
- macOS、iOS、Android 或无界面主机，以 `role: node` 身份连到 Gateway，对外暴露 `camera.*`、`screen.record`、`location.get`、`canvas.*` 等命令（[architecture.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/architecture.md)）。

**状态存储**（[OC/docs/openclaw-agent-runtime.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/openclaw-agent-runtime.md)）

| 文件 | 内容 |
|---|---|
| `~/.openclaw/openclaw.json` | 配置 |
| `state/openclaw.sqlite` | 共享运行时状态 |
| `agents/<id>/agent/openclaw-agent.sqlite` | 每个 agent 的 auth、会话行、transcript、standing intents、记忆索引等 |
| `workspace/` | 默认工作区 |

会话和 transcript 已经从 JSONL 迁到了 SQLite。

**Session**
- 默认 agent 的 id 是 `main`，主会话 key 是 `agent:main:main`。
- `session.dmScope` 控制私信怎么隔离，例如 `per-channel-peer`（[concepts/session.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/session.md)、[multi-agent.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/multi-agent.md)）。

**工作区文件**（[OC/docs/concepts/agent-workspace.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/agent-workspace.md)）

| 文件 | 作用 | 注入方式 |
|---|---|---|
| `AGENTS.md` | 操作规程和记忆用法；`## Tools` 一节写本地工具约定（取代了旧的 TOOLS.md） | 每个会话都注入；子 agent **只**注入这一个 |
| `SOUL.md` | 人格、语气、边界 | 每个会话 |
| `USER.md` | 用户模型，写成指令式条目 | 每个会话，单独有 4,000 字符的预算 |
| `IDENTITY.md` | 名字、风格、emoji | bootstrap 时 |
| `BOOT.md` | 启动检查清单 | 启用 boot-md hook 时 |
| `BOOTSTRAP.md` | 首次运行的仪式 | 只在新工作区里出现 |
| `memory/YYYY-MM-DD.md` | 每日笔记 | `/new` 时载入今天和昨天两份；平时按需检索 |
| `MEMORY.md` | 精选的长期记忆 | 只在私有主会话里注入 |
| `DREAMS.md` | dreaming 的日记，给人复核 | 从不注入 |
| `skills/` | 工作区 skills | 优先级最高 |
| ~~`HEARTBEAT.md`~~ | **已退役**，内容迁到 cron monitor scratch，"The runtime never reads `HEARTBEAT.md`" | — |

注入有上限：`bootstrapMaxChars` 默认 20000，`bootstrapTotalMaxChars` 默认 60000，超出部分截断（[agent-workspace.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/agent-workspace.md)、[heartbeat.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/heartbeat.md)）。

工作区的定位是"默认 cwd，不是硬沙箱"：没开沙箱时，绝对路径可以访问主机上的任何地方。

### B2. 记忆系统

主要来源：
- [OC/docs/concepts/memory.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory.md)
- [memory-architecture.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory-architecture.md)
- [memory-search.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory-search.md)
- [user-model.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/user-model.md)
- [standing-intents.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/standing-intents.md)
- [active-memory.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/active-memory.md)
- [dreaming.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/dreaming.md)

#### B2.1 设计原则（官方原话的要点）

1. **No hidden state**：一切记忆都是可编辑的 Markdown 文件。
2. **Writing is the hard part**：引用 LongMemEval 的结论，写进去什么比怎么建索引更重要，所以把整理工作移出回复路径，放到后台去做。
3. **写入路径就是安全边界**：写入时就强制记录来源，晋升用结构化的门槛来卡，不指望事后去发现坏记忆。
4. **确定性门槛，模型判断只在门槛之内**。
5. **记忆出故障不阻塞回复**。

#### B2.2 存什么（分层）

| 层 | 载体 | 谁写 | 何时注入 |
|---|---|---|---|
| Instructions | `AGENTS.md` 等 | 只有人 | 会话开始时 |
| Curated core | `MEMORY.md`、`USER.md` | 只有 dreaming 整理，或者用户直接要求 | 会话开始时，前提是来源合格，并且有预算 |
| Episodic | 每日笔记、会话 transcript | agent 工作时、memory flush、会话结束时抓取 transcript | 只在回忆时 |
| Prospective | standing intents（SQLite）、cron | `intent` 工具、定时任务 | 触发时 |
| Review | `DREAMS.md` | dreaming 各阶段 | 从不注入 |

**来源（provenance）**
- 每条索引记录都带来源类别，取值只有 `owner`、`agent`、`untrusted`、`system` 四种，存在 SQLite 列里，模型改不了。另外还带会话类型（交互、cron、heartbeat、子 agent）、观察时间和 supersession key。
- cron、heartbeat、子 agent 会话产出的东西**一律不进候选**。
- 从记忆里注入进来的内容会被打上标记，不会再被抽取一次，"A fact recalled one hundred times stays one fact"。
- 工具结果一旦声明了来自网络，这一轮后面的所有内容都标成 `untrusted`（taint）。

#### B2.3 怎么写

- **单一主写者**："Durable memory has exactly one primary writer: the dreaming consolidation pass."
- **Pre-compaction memory flush**
  - compaction 之前先跑一个静默回合，让 agent 把要紧的上下文写进每日笔记。默认开启。
  - 这一回合用的是会话的私有副本，所以 housekeeping 消息不会出现在后续对话里。
  - 可以单独给它指定一个本地模型，比如 `ollama/qwen3:8b`。
  - 只读沙箱的会话会跳过这一步（[memory.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory.md)）。
- **Dreaming**（默认开启，作为后台定时任务运行）
  - Light 和 REM 两个阶段：去重、暂存候选、做主题反思，不碰长期记忆。
  - Deep 阶段分两道关：
    1. 确定性门槛。按检索相关度、召回频率、查询多样性、新近度、多日复现等信号排序，`untrusted` 和 `system` 来源直接排除。
    2. 一次有边界的模型整理回合：合并、按 supersession 退役旧条目、去重。只有通过结构校验、不超预算、删得不过多的结果才会被接受，否则这一轮退回到只追加。
  - 写入用乐观并发（hash 校验后原子 rename），每次改写都保存改写前的版本，并把摘要写进 `DREAMS.md`。
  - 引用的研究依据：Generative Agents、sleep-time compute。

#### B2.4 怎么取

**Lane 1：常开，不调用模型**
- 会话开始时注入 `MEMORY.md` 和 `USER.md`（来源合格才注入，有预算限制，每轮刷新）。
- `memory_search` 做混合检索：BM25 加向量，按 `hybrid relevance × recency decay（30 天半衰期）× importance（1–10，写入时打分）` 排序，再用 MMR 去重；文件名单独建索引。
- **Trigger injection**：条目可以带 `<!-- trigger: … -->` 和 `<!-- importance: N -->` 注释。每条消息进来先用词法和向量做预筛，得分 ≥0.72 的条目注入，每轮最多 3 条。**只有 curated 层的条目会被自动注入**，每日笔记和 transcript 永远不会。
- 嵌入服务默认用 OpenAI，也支持 Gemini、Voyage、Mistral、Bedrock、DeepInfra、本地 GGUF、Ollama、LM Studio、Copilot 和任何 OpenAI 兼容端点。

**Lane 2：Active Memory**
- 一个阻塞式的"回忆子 agent"，可以跨会话检索 transcript。
- 默认用 `escalate` 模式：只有消息里有明显的回忆意图、并且 Lane 1 没有命中时才跑。

**项目作用域**
- 在 Git 仓库里写下的记忆，自动打上 `<!-- project: <origin remote> -->`。
- 一个会话最多同时有 4 个活跃的仓库 key：当前仓库的记忆加权，其他仓库的轻微降权。
- `USER.md` 和 standing intents 永远是用户级的，不分项目。

**User model（`USER.md`）**
- 条目写成指令式，每条带 `observed` 日期，`status` 只能是 `active` 或 `superseded`。
- 偏好变了就在原处标 superseded，**不追加一条矛盾的新条目**。依据是 PrefEval（长对话里对偏好的遵循度会下降）和 HorizonBench（模型常常回到用户最早说的那个偏好）。
- 团队 Gateway 上每个人可以有自己的 `users/<profile-id>/USER.md`。
- "Store only details that improve assistance. Do not turn the file into a dossier."

**Standing intents**
- 用于"当 X 出现时提醒我 Y"这类事件触发的前瞻记忆。
- 存在 SQLite 里。匹配用 FTS 关键词，并检查渠道和发送者的作用域、冷却时间（默认 24h）、触发预算（默认 3 次）、过期时间（默认 90 天）。**匹配路径上不调用模型**。
- 取消必须显式说，模型不会从对话里推断取消。
- 依据是 TriggerBench 和 ProEvent（文档引用的 arXiv 编号是 2606.23459、2607.17701，作者没有逐一核实）。
- 按时间的提醒一律走 cron。

**引擎和外围**
- 默认引擎是 builtin，用 SQLite。也可以换成插件：Honcho（"AI-native cross-session memory with user modeling"）或 LanceDB。
- `memory-wiki` 插件把记忆编成带 claims、evidence、矛盾和新鲜度追踪的知识库。
- "Memory is a special plugin slot where only one memory plugin can be active at a time"（[VISION.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/VISION.md)）。
- **Self-learning / Skill Workshop**：把纠正和成功的做法沉淀成 skill，默认 `auto` 模式（[tools/self-learning.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/self-learning.md)）。

#### B2.5 已知局限

**官方自己写明的：**
- 晋升到长期记忆的条目**没有基于时间的保留上限**。
- `memory forget` 只能删掉有记录可追的产物；原始 transcript、没登记的写入和外部副本都不在覆盖范围内。
- taint 只对声明了"来自网络"的工具生效，本地文件读进来的不受影响（[why-openclaw.md#what-we-do-not-claim](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)、[memory-architecture.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory-architecture.md)）。
- `MEMORY.md` 超出预算会被截断注入（[memory.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory.md)）。
- 同一时间只能启用一个记忆插件。
- 成熟度自评中，"Session, memory, and state lifecycle" 是 Beta，Quality 75%、Completeness 76%（[scorecard](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/maturity/scorecard.md)）。
- 文档提到："production audits have found the overwhelming majority of auto-captured memories to be scaffolding restatements, heartbeat noise, and recall feedback loops"（[memory-architecture.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory-architecture.md)）。【判断】这正是后来加 provenance 门槛的原因，也说明早期版本的记忆质量问题很严重。

**仍然开着的相关 issue：**
- [#45608](https://github.com/openclaw/openclaw/issues/45608)：`/new` 和每日 reset 没有 compaction 那样的 agentic memory flush。
- [#88757](https://github.com/openclaw/openclaw/issues/88757)：主动发出的消息（heartbeat、定时报告）不进会话上下文，用户回复时 agent "不记得自己说过"。
- [#67413](https://github.com/openclaw/openclaw/issues/67413)：希望能按 agent 分别配置 dreaming。

**【判断】从结构上看的缺口（就 ergo 的目标而言）：**
- 整个系统建模的是"事实、偏好指令、待办意图"，**不建模"为什么"**：没有动机、需求、价值观这样的层次，没有置信度上限，没有竞争假设，也没有"说的和做的对不上"这类检测。
- 晋升看的是"被召回的次数多不多"，也就是有用性，而不是有没有解释力。
- 官方是有意不做人物档案的。

### B3. 多 agent

**多 agent 路由**（[multi-agent.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/multi-agent.md)）
- 一个 Gateway 进程里可以跑多个**相互隔离**的 agent。
- 每个 agent 有自己的 workspace、`agentDir`、SQLite 会话库、auth profile 和 skills 白名单，可以分别设 sandbox 和 `tools.allow/deny`。
- 入站消息通过 `bindings` 按渠道账号路由到对应的 agent。
- agent 可以通过 `openclaw` 工具申请新建 agent，但要**操作员批准**，并且记录创建链（`openclaw agents list --tree`）。

**Team preset**（`openclaw agents team create`）
- 默认建四个角色：coordinator（文档称 chief of staff），加 researcher、writer、reviewer。
- coordinator 是对人的唯一接口，负责分派有边界的任务、检查产物、汇总结果；专家只交产物，不再往下委派。
- 角色规程写在各自的 `AGENTS.md` 里。
- 关键配置是 `subagents.allowAgents` 和 `delegationMode: "prefer"`。官方原话："it is prompt guidance, not a scheduler"。
- 角色指令规定：对外发送、发布、购买、删除、动生产环境，都要人批准。

**Sub-agents**（`sessions_spawn`）（[tools/subagents.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/subagents.md)、[nesting.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/subagents/nesting.md)、[tool-policy.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/subagents/tool-policy.md)、[operations.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/subagents/operations.md)）
- 子 agent 是在后台跑的，有自己的会话（`agent:<id>:subagent:<uuid>`），完成后把结果 announce 给父会话。`sessions_spawn` 立即返回 `accepted`，结果通过推送送达。
- 默认嵌套深度上限 5（可调 1–5），每个会话最多 5 个活跃子 agent，每个父会话最多 8 个并发。
- `context: "fork"` 可以把当前 transcript 带给子 agent。
- 可以设成 `visible` 的持久会话，可以绑定渠道线程，也可以放进独立的 worktree。
- 工具策略：子 agent **一律拿不到** `gateway`、`cron`、`message`、`sessions_send`、`progress_card` 等工具，到了最深一层还会失去 spawn 能力。
- **子 agent 只注入 `AGENTS.md`**，不注入 SOUL、USER、MEMORY。
- 并发上限是按父会话算的，不是整个 Gateway 的总上限。

**其他相关能力**
- **Swarm**：在 Code Mode 脚本里用 `Promise.all` 等普通控制流并行跑多个子 agent，"no graph DSL"；默认开启（[tools/swarm.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/swarm.md)）。
- **agent 之间的消息**
  - `sessions_send` / `tools.agentToAgent` **默认开启**，`tools.sessions.visibility` 默认是 `all`。也就是说，没开沙箱的 agent 能读写所有 agent 的会话，包括其他用户的 transcript（[trust-model.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/security/trust-model.md)）。
  - 可以设成只能发、不能读历史的委派方式。
  - 对外支持 A2A 1.0，也能通过 ACP 托管外部 harness（[why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)）。
- **Workboard 插件**（2026.5.28 加入）：卡片看板，状态有 `triage/backlog/todo/scheduled/ready/running/review/blocked/done` 九种；`dispatch` 会把 ready 的卡片派成子 agent worker 去跑（[cli/workboard.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/cli/workboard.md)、[CHANGELOG 2026.5.28](https://github.com/openclaw/openclaw/blob/bfde36e86028/CHANGELOG/2026.5.28.md)）。
- **Goal**：每个会话一个持久目标，用 `/goal start|pause|resume|complete` 管理，可以设 token 预算（[tools/goal.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/goal.md)）。
- **Parallel specialist lanes**：按 lane 分工，契约写在 `AGENTS.md` 里，包括目的、非目标、聊天预算、交接规则、工具风险（[parallel-specialist-lanes.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/parallel-specialist-lanes.md)）。

**"Teams" 这个词在 OpenClaw 里有两种意思**
1. 上面说的 agent team preset；
2. 多个人共用一个 Gateway（[start/teams.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/teams.md)）：大家可以一起操作共享会话；每个会话有创建者、负责人、参与者三层归属；有角色（`gateway.roles`）；有 Git co-author 署名。官方强调"A gateway is one trust domain"。

### B4. 主动性：heartbeat、cron、hooks

来源：[automation/index.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/automation/index.md)、[heartbeat.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/heartbeat.md)

- **Heartbeat**
  - 本质是由系统管理的一个定时任务，定期在主会话里跑一轮。默认每 30 分钟；配了 Anthropic OAuth 时默认每 1 小时。
  - 默认 prompt："Follow the heartbeat monitor scratch context when provided … Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY."
  - agent 还可以调 `heartbeat_respond(notify: true|false, notificationText, scratch)`：notify 为 false 时不显示，但会作为下一轮的内部上下文保留下来。
  - 可以设 `activeHours`（只在某个时段内运行）、`target` 指定投递目标（默认发给主人的私信，从不发到群里）。主会话正忙时会推迟。事件唤醒有 30 秒最小间隔，并有防洪。
  - **成本**：每次都是一轮完整的 agent 运行。`isolatedSession: true` 能把每次的上下文从约 100K token 降到 2–5K。
  - `HEARTBEAT.md` 已经退役，内容迁到数据库里的 "monitor scratch"（上限 256KiB），agent 可以自己改写。
- **Automations（cron）**
  - 支持一次性（`--at`）、固定间隔、cron 表达式，以及 webhook 触发。
  - 可以跑在 isolated、current、命名会话或主会话里；结果投递到渠道、webhook，或者静默。
  - 旧的 Tasks ledger 和 TaskFlow 已经删掉（[automation/index.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/automation/index.md)）。
- **Hooks**
  - 内部 hooks 是 `HOOK.md` 加一个 handler，响应 `/new`、`/reset`、`/stop`、compaction、gateway 启动、消息流等事件。它们是可信代码，**不在沙箱里跑**（[automation/hooks.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/automation/hooks.md)）。
  - 插件 hooks 有 `before_tool_call`、`before_prompt_build`、`before_agent_run`、`before_agent_reply`、`before_agent_finalize`、`message_received/sending`、`heartbeat_prompt_contribution` 等（[plugins/hooks.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/plugins/hooks.md)）。
- **Standing orders**：写在 `AGENTS.md` 里的"长期授权"，要写清范围、触发条件、审批门槛和升级规则（[standing-orders.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/automation/standing-orders.md)）。
- **和"打扰"有关的配套能力**
  - **推送通知**（[web/notifications.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/web/notifications.md)）
    - 浏览器推送（Web Push）或 macOS 原生通知。
    - 可以按类别开关：审批、agent 完成、agent 提问、被人 @、定时任务失败、后台任务失败。可以设安静时段、详细程度和 agent 白名单。
    - **默认只开审批这一类**，其余都要自己打开。安静时段内的通知直接丢弃，不会攒着补发。
  - **Progress drafts**：把渠道里的一条消息当成实时进度条不断编辑，而不是一条接一条刷"还在做"（[progress-drafts.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/progress-drafts.md)）。
  - **`progress_card`**：每个会话一张持久的计划和状态卡，只在有两步以上的实质工作时才建（[progress-card.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/progress-card.md)）。
  - **队列模式**：`steer`（默认，在工具边界处注入新消息）、`followup`、`collect`、`interrupt`。已经在运行的工具不会被打断（[queue-steering.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/queue-steering.md)）。
  - 后台 exec 完成后默认会触发一轮汇报，用 `notifyOnExit: false` 可以关掉。

### B5. 安全模型

- **信任边界**
  - 一个 Gateway 就是一个信任域，只支持一个操作员或互相信任的团队，**不支持互不信任的多租户**（[trust-model.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/security/trust-model.md)）。
  - "Not vulnerabilities by design" 里包括"只有 prompt injection、没有绕过策略、鉴权或沙箱的攻击链"。
- **默认值**："Sandboxing and exec approvals are off by default. Default OpenClaw is a trusted single-operator assistant."（[why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)）。权限选择器的文档也说："Without those settings or sandboxing, the default is full access."（[permission-modes.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/permission-modes.md)）。
- **按会话的权限模式**：`read-only`、`guarded`（白名单之外问人）、`workspace`（由 **LLM 审查员**决定放行、拒绝或问人，连续三次拒绝就升级给人）、`full`（需要 `operator.admin`）。
- **Exec approvals**：在执行主机本地强制执行，策略、白名单和用户批准三者都同意才放行。还有 `strictInlineEval`（`python -c` 这类内联代码也要审批）；白名单模式下，heredoc 一律要审批（[exec-approvals.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/exec-approvals.md)、[prompt-injection.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/security/prompt-injection.md)）。
- **沙箱**：Docker 或 NVIDIA OpenShell 后端，可以按 agent 或按会话配置，`workspaceAccess` 可以设为 `ro`、`rw` 等。工具策略、沙箱、elevated 三层彼此独立。
- **Prompt injection**（[prompt-injection.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/security/prompt-injection.md)）
  - 官方把**选模型**当作第一道防线，引用了一场 2026 年众包攻防的结果（Opus 4.5 的成功率 0.5%，Gemini 2.5 Pro 8.5%），同时承认自适应攻击者成功率可以超过 80%。
  - 外部内容用 `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` 包起来，并清除 chat template 的特殊 token。
  - 建议让一个只读的 "reader agent" 先读不可信内容、写成摘要，再交给主 agent。
- **ClawHub 供应链**
  - 2026-02-07 宣布和 VirusTotal 合作，对 skill 做哈希查询和 Code Insight（LLM 分析），每天复扫一遍；官方说 "this is not a silver bullet"（[openclaw.ai/blog/virustotal-partnership](https://openclaw.ai/blog/virustotal-partnership)）。
  - 威胁模型把 "T-PERSIST-001 恶意 skill 安装"列为 Critical/P0。现有的控制手段有：GitHub 账号要满 14 天、静态和类 AST 扫描、LLM 风险审查、VirusTotal（**要操作员配置了 API key 才生效**）、人工审核。已知缺口是"No runtime execution sandbox isolates a skill from the agent's own privileges once installed"（[THREAT-MODEL-ATLAS.md §4](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/security/THREAT-MODEL-ATLAS.md)）。
  - "a pending or stale scan can allow installation with a warning"（[why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)）。
  - 原生插件在进程内运行，没有沙箱。
  - 成熟度自评中 ClawHub 是 Alpha，Quality 58%、Completeness 62%。
- **事件与批评**
  - Koi Security 的 "ClawHavoc" 报告，标题称在 ClawHub 上发现 341 个恶意 skill。原 URL 现在重定向到 Palo Alto Networks 的产品页，正文没能核实【未核实】（[原链接](https://www.koi.ai/blog/clawhavoc-341-malicious-clawedbot-skills-found-by-the-bot-they-were-targeting)）。
  - 2026.2.14 加固了工具传入的 `gatewayUrl` 覆盖项，只允许 loopback 或配置好的远程地址（[CHANGELOG 2026.2.14](https://github.com/openclaw/openclaw/blob/bfde36e86028/CHANGELOG/2026.2.14.md)）。
  - 截至 2026-08-27，仓库公开 advisory 有 647 条（[why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)、[advisories](https://github.com/openclaw/openclaw/security/advisories)）。
  - 学术分析 arXiv:2603.12644（2026-03-13）指出几类风险：prompt injection 导致 RCE、多个工具串成攻击链、"context amnesia"、供应链污染（[arXiv](https://arxiv.org/abs/2603.12644)）。
  - 有用户报告用 Antigravity/Gemini CLI 的订阅跑 OpenClaw 被 Google 封号（[#14203](https://github.com/openclaw/openclaw/issues/14203)）。
  - NVIDIA 出了一个用 OpenShell 内核级沙箱加固的发行版 NemoClaw（[why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)）。

### B6. 常见抱怨、缺口、分支和替代品

**复杂度与上手**
- 官方成熟度自评：总体 68%（Alpha）。Agent Runtime 是 Beta 78/79；Automation and durable work 是 Beta 72/79；Native Windows 是 Alpha 58/66；Windows App/Node 只有 19/21（[scorecard](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/maturity/scorecard.md)）。
- 文档极其庞大：仅 sub-agent 一项就拆成 7 页，Active Memory 拆成 9 页。
- 安装相关的 issue 有：[#9028](https://github.com/openclaw/openclaw/issues/9028)（Docker 上配对和 token 混乱）、[#1818](https://github.com/openclaw/openclaw/issues/1818)、[#11805](https://github.com/openclaw/openclaw/issues/11805)（systemd）、[#4686](https://github.com/openclaw/openclaw/issues/4686)（WhatsApp 关联卡住）。
- NanoClaw 的批评是代码近 50 万行、53 个配置文件，安全靠应用层（白名单、配对）而不是 OS 隔离（[nanoclaw](https://github.com/nanocoai/nanoclaw)）。

**稳定性**
- 2026-02-01 维护者宣布进入 "Stabilisation Mode"："we're getting a PR roughly every two minutes"，新功能请求一律关闭，建议改写 skill 或自己 fork（[#5799](https://github.com/openclaw/openclaw/issues/5799)）。
- 还有一些发版事故和破坏性迁移：2026.3.22 的 npm 包缺了 Control UI（[#52808](https://github.com/openclaw/openclaw/issues/52808)）、v2026.7.2 的 STRICT 迁移失败（[#110186](https://github.com/openclaw/openclaw/issues/110186)）。官方政策是不长期保留旧配置的别名，统一由 `doctor --fix` 迁移（[VISION.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/VISION.md)）。

**成本**
- heartbeat 每次都是一轮完整运行，不开 isolated 时约 100K token。
- 每个子 agent 都有自己的上下文。
- Active Memory 要额外调用一次会阻塞回复的模型（[heartbeat.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/heartbeat.md)、[subagents.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/subagents.md)）。
- 还有：Codex 续跑回合改写 prompt，导致缓存命中率从 93% 掉到 47%（[#84110](https://github.com/openclaw/openclaw/issues/84110)）。

**长任务的可靠性**
- 想要可配置的流式 watchdog 超时（[#68596](https://github.com/openclaw/openclaw/issues/68596)，当前开着的 issue 里 reactions 最多）。
- steer 在主会话里不能在回合中途注入（[#48003](https://github.com/openclaw/openclaw/issues/48003)）。
- 会话文件过大（[#2254](https://github.com/openclaw/openclaw/issues/2254)）。
- 官方文档里对应的设计：重启后从已保存的工具结果继续、Goals 在出错后暂停等（[CHANGELOG 2026.9.5](https://github.com/openclaw/openclaw/blob/bfde36e86028/CHANGELOG/2026.9.5.md)、[CHANGELOG 2026.9.6](https://github.com/openclaw/openclaw/blob/bfde36e86028/CHANGELOG/2026.9.6.md)）。

**打扰太多或太少**
- 默认 heartbeat 已经从"主动推断任务"改成了"默认安静，没事就回 NO_REPLY"。
- 通知默认只推审批。
- 反面问题：主动发出的消息不进上下文（[#88757](https://github.com/openclaw/openclaw/issues/88757)）。
- 【判断】说明"恰到好处的打扰"还远没有解决。

**记忆质量**：见 §B2.5。

**分支和替代品**（README 层面的核对，数据来自 GitHub API，截至 2026-10-06）：

| 项目 | 语言 / 许可 | Star | 改了什么 | 来源 |
|---|---|---|---|---|
| Hermes Agent（Nous Research） | Python / MIT | ~25.2 万 | 主打"closed learning loop"：由 agent 自己整理记忆并定期提醒自己持久化；复杂任务后自动生成 skill，用的过程中再改进；用 FTS5 加 LLM 摘要做跨会话检索；用 Honcho 做"dialectic"式用户建模；有 7 种终端后端（Docker、SSH、Modal、Daytona 等）；能一键迁移 OpenClaw 的记忆和 skills。它的安全政策写的是 "The only security boundary against an adversarial LLM is the operating system"。背后是风投公司，有付费的 Nous Portal | [README](https://github.com/NousResearch/hermes-agent)、[why-openclaw.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md) |
| NanoClaw（nanocoai） | TS / MIT | ~3.1 万 | 一个进程、几个文件；每个 agent 一个 Linux 容器；agent 拿不到原始 API key，由 credential gateway 在请求时注入凭据；直接用 Claude Agent SDK；主张"skills over features"，渠道按需用 `/add-<channel>` 拷进你自己的 fork；Slack 里一个 agent 一个 app | [README](https://github.com/nanocoai/nanoclaw) |
| nanobot（HKUDS） | Python / MIT | ~4.9 万 | 核心很小；自带 WebUI；有 Dream 长期记忆、子 agent、MCP、cron、OpenAI 兼容 API；有"临时聊天"（不进历史、不进记忆） | [README](https://github.com/HKUDS/nanobot) |
| ZeroClaw | Rust / Apache-2.0 | ~3.3 万 | 主打体积小、速度快、可以替换各个部件 | [repo](https://github.com/zeroclaw-labs/zeroclaw) |
| PicoClaw（Sipeed） | Go / MIT | ~3.0 万 | 面向小型设备部署 | [repo](https://github.com/sipeed/picoclaw) |
| IronClaw（NEAR AI） | Rust / Apache-2.0 | ~1.3 万 | "Agent OS focused on privacy, security and extensibility" | [repo](https://github.com/nearai/ironclaw) |

【判断】替代品分成两条路线：
1. **为了安全和可读性做减法**：NanoClaw 用容器加凭据网关，nanobot 保持核心很小。
2. **在"学习"上做加法**：Hermes 的自我改进循环加 Honcho 用户建模。

ergo 的差异化 (1) 和 Hermes、Honcho 直接相邻，需要单独再调研 Honcho 的 dialectic user modeling。

---

## C. 综合：ergo 的三个差异化

### C1. 对照表

| 差异化 | OpenClaw 已有 | OpenClaw 的不足 | pi 现成可用 | ergo 需自建 |
|---|---|---|---|---|
| **(1) 挖掘动机的记忆** | 分层文件记忆；provenance、taint 和会话类型门槛；dreaming 两道关加 `DREAMS.md` 审阅；`USER.md` 指令加 supersede；standing intents；Active Memory 回忆子 agent；混合检索加衰减加重要度；Honcho 插件；memory-wiki 的 claims、evidence、矛盾追踪 | 不建模动机、需求、价值观；明确拒绝"dossier"；晋升按有用性而不是解释力；没有置信度上限、竞争假设、判别性追问；没有"言行不一"检测；只能启用一个记忆插件 | 注入：`before_agent_start`（分段，保缓存）、`context`、`transformContext/prepareRequest`；写入时机：`agent_settled`、`session_before_compact`、`turn_end`；持久化：`appendEntry`、durable `defineDoc`；后台推理：`ctx.modelRegistry.streamSimple` | 全部存储（SQLite、FTS、向量）；事实抽取管道（带来源）；分层推理图（L1 事实 → L2 动机 → L3 需求 → L4 内核，可以复用 四层动机模型（调研 02，未公开）的四层、置信上限和判别性追问）；整理任务（借鉴 dreaming 的"确定性门槛加有边界的模型回合"）；隐私和用户审阅界面；注入策略（哪一层、什么时候、多少预算） |
| **(2) 长任务可配置提醒、少打扰、普通聊天模式** | 推送通知可按类别开关、有安静时段和详细程度；heartbeat 默认安静（NO_REPLY、`heartbeat_respond`、activeHours）；progress drafts 和 progress card；Goals；cron 一次性提醒；`notifyOnExit`；队列模式 steer/followup/collect | 偏好是按类别和按设备的，**不能按任务设**（比如"只在失败或需要我决定时告诉我""每到一个里程碑汇报""超过 ETA 才提醒"）；没有跨渠道的"注意力预算"；主动消息不进上下文（#88757）；heartbeat 很贵；"聊天 vs 任务"不是一等模式 | `Agent` 事件流（turn、tool、agent_settled）；steering 和 follow-up 队列；`ctx.ui.notify/setStatus/setWidget`（只限 TUI 或 RPC）；pi-durable：持久任务、后台任务、`watchEvents`、`taskGraph`、`pi.usage` | 任务登记处加**提醒策略引擎**（每个任务的规则、全局安静时段、汇总和批量、升级规则）；投递渠道；"聊天模式"路由（轻模型、无工具或只读工具，可以用 `input` 事件或 virtual model 分流）；主动消息回写会话；继承前作的打断分级（见调研 01 §0 第 6 条） |
| **(3) 秘书主 agent + 项目级子 agent 组 + 角色受限的专家 + PM agent** | team preset（coordinator 加三个专家、allowAgents、delegationMode）；每个 agent 单独的 workspace、tools、sandbox；`sessions_spawn`（深度、announce 链、worktree、visible 会话）；Swarm；Workboard 看板和 dispatch；Goals；项目作用域的记忆；A2A/ACP | "prefer" 只是提示词引导，没有调度器；没有"项目"这个实体（不能把 agent 组、预算、生命周期绑在一个项目上）；没有 PM 角色模板；子 agent 只拿到 `AGENTS.md`，看不到用户模型（这是有意的）；并发按父会话算；会话可见性和 agent-to-agent 默认全开，默认隔离很弱 | 核心没有；官方 subagent 示例（子进程、scout/planner/reviewer/worker、并行或串联）；`setActiveTools`、`tool_call` 门禁按角色限制工具；pi-durable：任务拥有子会话、后台 anchor、按会话 `configure`（model、tools、extensions、instructions、cwd）、`taskGraph`、按会话挂 hooks；社区 `pi-subagents` | 项目模型（project → agent group → role → member）；角色策略**写在代码里强制**（tool_call 或 durable `beforeTool`）；PM agent 的状态机（用看板或 durable 文档，参考 Workboard 的九种状态）；秘书的路由和汇总；agent 间消息（只能发、可见性收紧）；预算和并发上限；可观察的 UI（任务树、各 agent 的 transcript） |

### C2. 关于底座选型的建议【判断】

1. **不要把 OpenClaw 当作"pi 上层"去改**：它已经脱离 pi，又极其庞大。ergo 应该把它当成**设计参考**，而不是代码基础。最值得直接借鉴的几块：
   - 记忆架构那一套（provenance、单一写者、确定性门槛、trigger injection、按 supersede 方式写 USER 指令、standing intents）；
   - heartbeat 的"默认安静"契约（NO_REPLY 加 notify 布尔值）；
   - 子 agent 的工具硬禁清单和 announce 链；
   - trust model 文档的写法。
2. **pi 的依赖面要压到最小**：
   - 依赖 `pi-ai`（provider）加 `pi-agent-core` 的 `Agent`（loop、steering、hooks）。
   - `pi-coding-agent` 的 SDK 和扩展系统适合拿来快速做原型或给工具编码；但它的会话是面向编码 CLI 设计的（JSONL 树、cwd），未必适合多渠道的个人助理。
   - `pi-durable` 在语义上最贴合差异化 (2) 和 (3)，但只有两周历史。建议用自己的接口把它包起来，并锁定版本；或者只借它的设计（任务拥有会话、后台 anchor、先提交后显示），自己实现。
3. **前作的迁移路径**：前作依赖的 `AgentHarness`（`before_tool`、`after_tool`、`before_run_end`）已经从 pi-agent-core 1.0 删除。对应关系大致是：
   - `before_tool` / `after_tool` → durable 的 `hook(ToolTask, {beforeTool, afterTool})`，或者 agent-core 的 `beforeToolCall` / `afterToolCall`；
   - `before_run_end` → durable 的 `hook(GenerationTask, {onYield → {continue}})`，或者 agent-core 的 `finishTurn → {action:"continue"}`。
   这一点要在 ergo 的技术方案里提前定下来。
4. **Web UI 自己写**：pi-web-ui 已经停更；pi 的远程协议还处在实验阶段，而且没有鉴权。
5. **安全默认值要反过来**：OpenClaw 默认 full access 和"默认无沙箱"一再被批评。ergo 应该默认开审批门禁（`tool_call`），只读优先，对 skill 和插件做供应链检查（或者干脆不做公开市场）。

### C3. 开放的设计问题

1. **底座深度**：只用 `pi-agent-core` 加 `pi-ai` 自己搭，还是用 `pi-coding-agent` 的 SDK 加扩展，还是用 `pi-durable`？API 变动的风险谁来承担，要不要 fork？
2. **会话与持久化**：ergo 的会话树沿用 pi 的 JSONL 树，还是像 OpenClaw 那样迁到 SQLite，还是用 durable 的提交模型？多渠道、多设备同时 attach 时，以谁为准？
3. **动机记忆的写入**：抽取是每一轮都做（花钱、慢），还是在 compaction、会话结束、后台整理时做（借鉴 dreaming）？推断出的动机要不要用户确认才能晋升？置信度上限怎么定？
4. **动机记忆的使用**：推断出的动机是注入 system prompt、只给秘书看，还是只在规划和提醒时用？推断错了怎么纠正和撤回？对子 agent 是否可见？OpenClaw 的做法是子 agent 看不到用户模型。
5. **隐私边界**：推断层很敏感。要不要分级存储、允许用户一键清除、给出 provenance 并支持可追溯删除（参考 OpenClaw 的 `memory forget` 及其局限）？
6. **提醒策略的表达**：用户怎么配置"这个任务什么时候叫我"？用自然语言转成结构化规则，还是用模板？全局的"注意力预算"要不要做？主动消息要不要回写到会话上下文？
7. **聊天模式与任务模式怎么切换**：自动识别、显式切换，还是两个独立入口？聊天模式要不要完全不带工具？要不要换更便宜的模型？
8. **项目与 agent 组的生命周期**：项目由谁创建（用户、秘书、PM）？子 agent 是常驻还是按需起？项目结束时记忆归到哪里（项目作用域，还是晋升为用户级）？
9. **PM agent 的职责边界**：PM 是一个调度器（写在代码里），还是一个 LLM 角色（只给提示词引导）？OpenClaw 的教训是 "prefer" 只是提示词引导。看板状态机要不要写死在代码里？
10. **角色权限怎么强制**：每个角色的工具白名单、文件和网络范围、审批阈值，用哪一层强制（pi 的 `tool_call`、容器、OS 用户）？要不要每个项目一个沙箱？
11. **渠道范围**：ergo 第一版接哪些渠道（只有 Web？还是加 Telegram、飞书、微信）？自己做 Gateway 的复杂度要控制住，OpenClaw 的教训就在眼前。
12. **成本控制**：heartbeat 和后台整理用什么模型？要不要用 virtual model 按任务路由？给每个项目设预算上限吗？

---

## 附录：本文主要来源清单

**pi**
- 仓库与文档：[PI/README.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/README.md)、[extensions.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/extensions.md)、[types.ts](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/src/core/extensions/types.ts)、[how-pi-works.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/how-pi-works.md)、[compaction.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/compaction.md)、[sdk.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/sdk.md)、[rpc.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/rpc.md)、[mcp.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/mcp.md)、[security.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/security.md)、[skills.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/skills.md)、[packages.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/packages.md)、[settings.md](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/docs/settings.md)、[agent README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/agent/README.md)、[agent CHANGELOG](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/agent/CHANGELOG.md)、[ai README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/ai/README.md)、[durable README](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/durable/README.md)、[chord](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/chord/README.md)、[server](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/server/README.md)、[protocol](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/protocol/README.md)、[codemode](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/codemode/README.md)、[subagent 示例](https://github.com/earendil-works/pi/tree/ddaa0a0341a8/packages/coding-agent/examples/extensions/subagent)、[coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/ddaa0a0341a8/packages/coding-agent/CHANGELOG.md)、[web-ui README @v0.75.3](https://github.com/earendil-works/pi/blob/v0.75.3/packages/web-ui/README.md)
- 作者与官网：[2025-11-30 博客](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)、[2026-04-08 博客](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)、[pi.dev changelog](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home)、[pi.dev/packages](https://pi.dev/packages)
- npm：[pi-coding-agent](https://registry.npmjs.org/@earendil-works/pi-coding-agent)、[pi-durable](https://registry.npmjs.org/@earendil-works/pi-durable)、[pi-web-ui](https://registry.npmjs.org/@earendil-works/pi-web-ui)、[pi-subagents](https://www.npmjs.com/package/pi-subagents)

**OpenClaw**
- 仓库：[README](https://github.com/openclaw/openclaw/blob/bfde36e86028/README.md)、[VISION.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/VISION.md)、[THIRD_PARTY_NOTICES.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/THIRD_PARTY_NOTICES.md)、[agent-runtime-architecture.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/agent-runtime-architecture.md)、[openclaw-agent-runtime.md](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/openclaw-agent-runtime.md)、[旧 docs/pi.md @v2026.5.27](https://github.com/openclaw/openclaw/blob/v2026.5.27/docs/pi.md)
- 概念：[architecture](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/architecture.md)、[agent-workspace](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/agent-workspace.md)、[memory](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory.md)、[memory-architecture](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory-architecture.md)、[memory-search](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/memory-search.md)、[user-model](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/user-model.md)、[standing-intents](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/standing-intents.md)、[active-memory](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/active-memory.md)、[multi-agent](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/multi-agent.md)、[parallel-specialist-lanes](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/parallel-specialist-lanes.md)、[queue-steering](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/concepts/queue-steering.md)
- 工具与自动化：[subagents](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/subagents.md)、[swarm](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/swarm.md)、[goal](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/goal.md)、[workboard](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/cli/workboard.md)、[heartbeat](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/heartbeat.md)、[automation](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/automation/index.md)、[notifications](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/web/notifications.md)
- 安全：[trust-model](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/security/trust-model.md)、[prompt-injection](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/security/prompt-injection.md)、[permission-modes](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/gateway/permission-modes.md)、[exec-approvals](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/tools/exec-approvals.md)、[THREAT-MODEL-ATLAS](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/security/THREAT-MODEL-ATLAS.md)、[why-openclaw](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/start/why-openclaw.md)、[VirusTotal 合作](https://openclaw.ai/blog/virustotal-partnership)、[arXiv:2603.12644](https://arxiv.org/abs/2603.12644)
- 成熟度与 issue：[scorecard](https://github.com/openclaw/openclaw/blob/bfde36e86028/docs/maturity/scorecard.md)、[#5799](https://github.com/openclaw/openclaw/issues/5799)、[#45608](https://github.com/openclaw/openclaw/issues/45608)、[#88757](https://github.com/openclaw/openclaw/issues/88757)、[#67413](https://github.com/openclaw/openclaw/issues/67413)、[#68596](https://github.com/openclaw/openclaw/issues/68596)、[#48003](https://github.com/openclaw/openclaw/issues/48003)、[#84110](https://github.com/openclaw/openclaw/issues/84110)
- npm：[openclaw](https://registry.npmjs.org/openclaw)

**替代品**：[Hermes Agent](https://github.com/NousResearch/hermes-agent)、[NanoClaw](https://github.com/nanocoai/nanoclaw)、[nanobot](https://github.com/HKUDS/nanobot)、[ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw)、[PicoClaw](https://github.com/sipeed/picoclaw)、[IronClaw](https://github.com/nearai/ironclaw)
