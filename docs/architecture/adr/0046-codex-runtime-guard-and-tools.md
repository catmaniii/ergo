# ADR-0046 Codex 运行时：守卫接在钩子、审批、事后核对三个口子，二狗的工具走 stdio MCP 中转

状态：已定（"Codex 做成运行时插件、每次工具调用都过守卫、照实写拦不住的"是用户定的，下面是接 0.166 的 `codex app-server` 时的取舍）

## 背景

票 381 要把 Codex 接成和 Claude Code 并列的运行时：负责人跑在用户本机的 Codex 上，用用户自己的配置和登录，不加 npm 依赖、不下载、不读 `~/.codex` 下的任何文件。接口只有 `codex app-server`（stdio 上的 JSON-RPC），协议的权威来源是 `codex app-server generate-json-schema --experimental` 生成的 schema。

和 Claude Code 最大的不同是工具调用：Claude Code 的 `PreToolUse` 钩子是进程内回调、全量闸口，一个口子就够。Codex 的工具一部分在本机执行（命令、补丁、MCP），一部分在模型服务那边做（联网搜索、生成图片），钩子是外部命令，没有发轮次就验证不了覆盖面。这张票不许发轮次，所以设计按"钩子可能漏"来做，漏了什么照实写。

## 决定

1. **守卫接三个口子，每次调用只判一次（按调用 id 记着，谁先到谁发 `guard_request`）。**
   - **PreToolUse 钩子（主闸口）**：`-c hooks.PreToolUse=...` 配一个固定名字的命令 `ergo-guard-hook`，包装脚本在 `<runtimeDir>/bin`，PATH 前面加这个目录。能拦、能写明原因、能改参数（`updatedInput`）。钩子不给判定时 Codex 接着执行，所以钩子脚本连不上适配子进程一律回不放行。
   - **审批请求（第二道）**：审批策略固定最严的 `untrusted`、`approvalsReviewer: user`，每个 `thread/start`、`thread/resume`、`thread/fork`、`turn/start` 都带。钩子放行过的直接 `accept`；钩子没拦到的（没覆盖、跑失败）在这里判。不放行回 `decline`（说不了原因）；不回 `acceptForSession`。
   - **事后核对（第三道）**：`item/started`、`item/completed` 上看到没过守卫的工具条目，照样发 `guard_request`（守护进程按它记这次调用，不发就没有记录）；已经在跑了拦不住，判了不放行就 `turn/interrupt` 打断这一轮、写日志。
2. **钩子生效不了就不起。** `-c` 给的钩子默认 untrusted，不跑。起来后问 `hooks/list`，没信任就把它报的 key 和 hash 写进 `-c hooks.state` 重起一次（实测有效，记在 runtimeDir，下次不用重起）；还不行回 `start_failed`。不用 `--dangerously-bypass-hook-trust`：它会连带放行用户别的钩子。
3. **Codex 自己的联网搜索关掉（`-c web_search="disabled"`）。** 它在模型服务那边做，钩子拦不到，只能事后知道。要联网的负责人工具包里有二狗的 `web_search`（经中转，调用之前过守卫）。这偏离了"全用 Codex 自己的配置"，换来少一个拦不住的口子。
4. **二狗的工具一律走 stdio MCP 中转，不用动态工具。** `dynamicTools` 只有 `thread/start` 能带，`thread/resume`、`thread/fork` 带不了：接管来的会话、重新拉起接着的会话都拿不到。中转由 Codex 按 `-c mcp_servers.ergo.*` 拉起，无状态（Codex 可能为一个服务开多个进程），工具清单和每次调用都经本机命名管道转给适配子进程。`mcp__<服务>__<工具>` 在服务里叫 `<服务>__<工具>`，Codex 看到 `mcp__ergo__<服务>__<工具>`，报回时换回二狗的名字。`tools/call` 不带工具调用 id，按工具名认领 `item/started` 报过的那次。
5. **配置只走启动参数和请求参数。** 钩子、中转、联网开关走 `-c`；二狗的系统提示追加进 `developerInstructions`（用户 `config/read` 读到的 `developer_instructions` 排在前面）；上下文块走 `turn/start` 的 `additionalContext`（`kind: application`，实验字段）；skill 复制进 runtimeDir，经 `skills/extraRoots/set` 交过去。不写 `~/.codex` 和项目配置。
6. **撤回用 `thread/fork` 的 `beforeTurnId`，不用 `thread/revert`。** 0.166 没有 `thread/rollback`；`thread/revert` 只认 paginated 的会话、会改写原来的历史，切不回废弃分支。分叉出新 thread 接着用，原来的就是废弃分支。只能回到一条输入之前，回不到一次工具调用前后；不恢复文件（`rewind_files: false`，撤回确认框写明）。
7. **"占没占"判不准就照实写。** Codex 没有"谁开着"的接口（`thread/loaded/list` 只认同一个 app-server 进程）。能拿到的信号是状态字段和最近活动：状态不是没加载、或者 5 分钟内有活动的算占着（`busy`）；再早的也写判不准（`ResumableSessionView.unsure`，"可能还开着，先在那边关掉，或者分叉一份接管"），界面默认勾分叉，用户确认关了可以取消勾选直接接。收回前只算交还之后的活动（`AgentRuntime.sessionBusy` 多一个 `returnedAt`）。
8. **用量按登录方式分两种 provider。** `account/read` 是 chatgpt 记 `codex-subscription`（消耗页写不算钱），别的记 `codex-api-key`（消耗页写实际花了钱、这里没单价，不能写得像免费的）。交给 codex 的环境去掉改计费、改账号的变量。

## Considered Options

- **只靠审批请求，不用钩子：** 审批说不了原因、改不了参数，Codex 判成只读的命令根本不问。不够。
- **只靠钩子：** 覆盖面不发轮次验证不了，钩子跑失败 Codex 还接着执行。三个口子叠着，漏了能被后面的接住或者至少记下来。
- **用动态工具（`dynamicTools` + `item/tool/call`）：** 协议最直接，但接管、重新拉起用不了，只能开两套。不要。
- **替用户写 `~/.codex/config.toml` 或项目的 `.codex/`：** 票里明确不许。
- **`--dangerously-bypass-hook-trust`：** 省一次重起，但连带放行用户别的钩子。不要。

## 拦不住的（界面、手册照实写）

- 钩子没覆盖到、又被 Codex 判成只读不问的命令：事后才知道，判了不放行只能打断。
- 看图（`view_image`）、`update_plan`、`tool_search`、读 MCP 资源、`sleep`、`request_user_input` 这些 Codex 自己的工具，钩子大概率不管：事后记录（大多只读）。
- 生成图片（模型服务那边做）：事后记录、打断。
- 派子代理（collab 工具）：事后记录；子线程里的工具调用照常过钩子和审批。
- 联网搜索：启动时关掉了；万一 Codex 不理这个设置，退到事后记录、打断。
- 钩子失败、超时（Codex 放行）：靠审批和事后核对接住。
- `decline` 的原因到不了模型。

没有发过真轮次，钩子的实际覆盖面、`tool_use_id` 和 item id 是否一致要在真机上核对，步骤写在票 381 的 Comments。

## Consequences

- 能力清单：`interject`、`compact`、`rollback`、`branch_switch`、`model_handoff`、`thinking_levels`、`take_over`、`scope_review`（`recordedScopeReview`，由二狗另起）是 `true`；`branch_summary`、`rewind_files`、`slash_passthrough`、`purge_rewrite`、`yield`、`live_toolkit`、`remote_control` 是 `false`。
- 假 app-server 的回复、通知和适配子进程发的请求都按生成的 schema 校验（`packages/daemon/test/fixtures/codex-app-server.schema.json`，`trim-codex-schema.mjs` 裁出）。Codex 升级要重新生成、重新核对。
- 宿主协议没变。`ResumableSessionView` 多 `unsure`，`AgentRuntimeView` 多 `missing`（外部程序没装时灰着列出来）。
