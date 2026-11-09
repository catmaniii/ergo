# ADR-0046 Codex 运行时：守卫接在钩子、审批、事后核对三个口子，二狗的工具走 stdio MCP 中转

状态：已定（"Codex 做成运行时插件、每次工具调用都过守卫、照实写拦不住的"是用户定的，下面是接 0.166 的 `codex app-server` 时的取舍）；2026-11-09 补充：设置 · 组件装的也认（见文末）

## 背景

票 381 要把 Codex 接成和 Claude Code 并列的运行时：负责人跑在用户本机的 Codex 上，用用户自己的配置和登录，不加 npm 依赖、不下载、不读 `~/.codex` 下的任何文件。接口只有 `codex app-server`（stdio 上的 JSON-RPC），协议的权威来源是 `codex app-server generate-json-schema --experimental` 生成的 schema。

和 Claude Code 最大的不同是工具调用：Claude Code 的 `PreToolUse` 钩子是进程内回调、全量闸口，一个口子就够。Codex 的工具一部分在本机执行（命令、补丁、MCP），一部分在模型服务那边做（联网搜索、生成图片），钩子是外部命令。票 381 不许发轮次，所以设计按"钩子可能漏"来做。

后来用真的 codex 0.166 + 本机假模型核对过（`packages/daemon/test/codex/real-codex.test.ts`，`ERGO_TEST_REAL_CODEX=1` 才跑，不花钱、不连 OpenAI，Codex 升级后重跑）。下面写的都是实测结果，没测到的写明。模型两种说话方式都测了：`gpt-5.5` 直接调函数；`gpt-6.x`、`gpt-5.6`（默认的 `gpt-6.1-sol`）只给一个 `exec`，工具在它的 JS 里调（代码模式）。

## 决定

1. **守卫接三个口子，每次调用只判一次（按调用 id 记着，谁先到谁发 `guard_request`）。**
   - **PreToolUse 钩子（主闸口）**：`-c hooks.PreToolUse=...` 配一个固定名字的命令 `ergo-guard-hook`，包装脚本在 `<runtimeDir>/bin`，PATH 前面加这个目录。实测 Windows 上解析得到，app-server 的环境传得到钩子，`tool_use_id` 就是条目 id（一次调用一条记录）。能拦（没有条目、没有审批，模型收到 `Command blocked by PreToolUse hook: <原因>`）、能改参数（`updatedInput`，命令和补丁都按改过的执行）。钩子没给判定、跑失败时 Codex 接着执行，所以钩子脚本连不上适配子进程一律回不放行。
   - **审批请求（第二道）**：审批策略固定最严的 `untrusted`、`approvalsReviewer: user`，每个 `thread/start`、`thread/resume`、`thread/fork`、`turn/start` 都带。钩子放行过的直接 `accept`；钩子跑失败时在这里判（实测接得住）。不放行回 `decline`（模型只收到 `rejected by user`，原因写在二狗的记录上）；不回 `acceptForSession`。
   - **事后核对（第三道）**：看到没过守卫的调用（模型硬吐的联网搜索、钩子跑失败又被 execpolicy 放行的命令、万一送进终端的字符），照样发 `guard_request`（守护进程按它记这次调用，不发就没有记录）；已经在跑了拦不住，判了不放行就 `turn/interrupt` 打断这一轮、写日志。
   - **换目录跑的命令补判一次**：钩子的 `tool_input` 只有 `command`，模型写的 `workdir` 看不到，守卫按负责人的工作目录判的。实测顺序是钩子、条目、审批，`item/started` 和审批请求的 `cwd` 才是真的目录。它和负责人的工作目录不同时（比真实路径，盘符大小写、斜杠方向、末尾分隔符、短文件名都不算不同）再发一次 `guard_request`：调用 id 是 `<id>#cwd`，`args.command` 是 `cd "<cwd>" && <钩子看到的那句>`，`native` 里是模型写的那句和 `workdir`，单独报开始和结束，守护进程按它记一条。目录相同的不多发。审批要等两次判定都回了才答复，补判不放行回 `decline`，原因写在这条命令的记录上；补判要改参数的也回 `decline`（审批改不了）。没有审批可接的（用户 execpolicy 放行的命令）走事后那条路：命令已经跑了，判了不放行只能打断这一轮。
   - **给守卫看的命令把反斜杠换成正斜杠。** 守卫按 Git Bash 的语法拆命令，Codex 在 Windows 上默认跑 PowerShell：不换的话没加引号的 `D:\a\b` 拆成 `D:ab`，`..\x` 拆成 `..x`，认不出密钥区和越界（实测）。模型写的原样放在 `native`，调用记录的完整内容存的是原样，真的执行的也是原样；审批卡、记录的摘要、对话里显示的工具调用是换过的。
2. **钩子生效不了就不起。** `-c` 给的钩子默认 untrusted，不跑。起来后问 `hooks/list`，没信任就把它报的 key 和 hash 写进 `-c hooks.state` 重起一次（实测有效，记在 runtimeDir，下次不用重起）；还不行回 `start_failed`。不用 `--dangerously-bypass-hook-trust`：它会连带放行用户别的钩子。
3. **Codex 自己的联网搜索关掉（`-c web_search="disabled"`）。** 它在模型服务那边做，钩子拦不到，只能事后知道。实测关掉后两种模型的工具清单里都没有了。要联网的负责人工具包里有二狗的 `web_search`（经中转，调用之前过守卫）。已定，保持关。代价：偏离了"全用 Codex 自己的配置"，搜索走二狗配的服务（要有联网工具和可用的服务商），用不了 Codex 自带的；换来少一个拦不住的口子。
3a. **Codex 的 TTY 关掉（`--disable unified_exec_tty`）。** 实测 `write_stdin` 既不过钩子也不走审批（协议里的 `kind: writeStdin` 审批在 0.166 没发过），只有事后的 `item/commandExecution/terminalInteraction` 通知：钩子只看到 `powershell`，之后送进去的 `Remove-Item keep.txt` 真的把文件删了。关了 TTY，要 `tty` 的 `exec_command` 被 Codex 回错，管道模式的 stdin 是关着的，送不进去；两种模型都实测过。已定，保持关。代价：要人敲键盘的交互程序在 Codex 负责人这里跑不了，系统提示和手册里写明了；换来堵住一个完全不过守卫的口子。`terminalInteraction` 还是接着，万一来了记一次、事后核对。
4. **二狗的工具一律走 stdio MCP 中转，不用动态工具。** `dynamicTools` 只有 `thread/start` 能带，`thread/resume`、`thread/fork` 带不了：接管来的会话、重新拉起接着的会话都拿不到。中转由 Codex 按 `-c mcp_servers.ergo.*` 拉起，无状态（Codex 可能为一个服务开多个进程），工具清单和每次调用都经本机命名管道转给适配子进程。`mcp__<服务>__<工具>` 在服务里叫 `<服务>__<工具>`，Codex 看到 `mcp__ergo__<服务>__<工具>`，报回时换回二狗的名字。`tools/call` 不带工具调用 id，按工具名认领 `item/started` 报过的那次。实测 MCP 工具一律延迟加载（`tool_search_always_defer_mcp_tools` 在 0.166 是写死的，关不掉）：直接调函数的模型要先 `tool_search`，不搜就调回 `unsupported call`；代码模式的模型在 `exec` 里 `tools.mcp__ergo__xxx` 直接能调。系统提示里写明了。
5. **配置只走启动参数和请求参数。** 钩子、中转、联网开关走 `-c`；二狗的系统提示追加进 `developerInstructions`（用户 `config/read` 读到的 `developer_instructions` 排在前面）；上下文块走 `turn/start` 的 `additionalContext`（`kind: application`，实验字段）；skill 复制进 runtimeDir，经 `skills/extraRoots/set` 交过去。不写 `~/.codex` 和项目配置。
6. **撤回用 `thread/fork` 的 `beforeTurnId`，不用 `thread/revert`。** 0.166 没有 `thread/rollback`；`thread/revert` 只认 paginated 的会话、会改写原来的历史，切不回废弃分支。分叉出新 thread 接着用，原来的就是废弃分支。只能回到一条输入之前，回不到一次工具调用前后；不恢复文件（`rewind_files: false`，撤回确认框写明）。
7. **"占没占"靠写入锁，列表里判不准的照实写。** 实测：`thread/list`、`thread/read` 的 `status` 跨进程永远是 `notLoaded`，`thread/loaded/list` 只认同一个进程，都看不出来。真正的信号是 Codex 的写入锁：别的 app-server、`codex exec` 开着的会话（空闲、跑着都算），`thread/resume` 回 `thread X already has an active writer`；`thread/fork`、`thread/read`、`thread/turns/list` 不受影响，所以开着也能分叉接管，一次性进程分叉的 thread 落了盘，退出后 `resume` 得上。
   - 核对一个会话（`sessionBusy`，收回前）：一次性进程探一次 `thread/resume`，被拒就是开着。探一次不改会话记录（文件大小、修改时间都不变），代价是这个进程会拉起一次用户配的 MCP 服务（`-c mcp_servers={}` 去不掉），进程退出就收掉；
   - 列表（`sessions`）：一个一个探太慢，只按最近活动：5 分钟内有活动的算占着（`busy`），再早的写判不准（`ResumableSessionView.unsure`），界面默认勾分叉，用户确认关了可以取消勾选直接接；真开着的适配子进程 `start_failed`，写明先去关掉或者分叉；
   - **真的终端界面（`codex` TUI）占不占写入锁没验证**（这里驱动不了它），所以"5 分钟内有活动"的规则还留着兜底，验证过了可以去掉。收回前只算交还之后的活动（`AgentRuntime.sessionBusy` 多一个 `returnedAt`）。
8. **用量按登录方式分两种 provider。** `account/read` 是 chatgpt 记 `codex-subscription`（消耗页写不算钱），别的记 `codex-api-key`（消耗页写实际花了钱、这里没单价，不能写得像免费的）。交给 codex 的环境去掉改计费、改账号的变量。真账号实测账本的键是 `codex-subscription/gpt-6.1-sol`。
9. **现在的模型用不了时，新开 thread 换。** 真账号实测：`config.toml` 里的 `gpt-5.2-codex` ChatGPT 账号不认，`turn/start` 照收，这一轮 `failed`，`codexErrorInfo` 是 `modelNotFound`，0 token。一个会话固定一个模型的规矩在这里会卡死：任务中途不换模型，换模型的交接摘要又要旧模型写。用户在 ⚙ 选了别的就新开 thread（`thread/start` 带 `model`），之前的记录从 `thread/turns/list` 读原文放进上下文；第一轮就失败时，这里面是用户交代的事（真模型实测，只发一句"接着做"，它接得上）。**不能在原来的 thread 上换**：`turn/start`、`thread/resume`、`thread/fork` 带 `model` 都报成功，但 Codex 换模型之前先用旧模型压缩一次（发 CONTEXT CHECKPOINT COMPACTION），旧模型用不了这一轮就失败（真的 codex + 假模型实测，两个模型都能用时多一次旧模型的压缩）。代价：接管来的会话这样换了之后，二狗接着的是新 thread，交还到终端的还是原来那个。
10. **分叉、撤回带上这个会话的模型。** 真账号实测：`thread/fork` 不带 `model` 不是接着原来的，是回到 `config.toml` 里的（警告 `This session was recorded with model X but is resuming with Y`），配置里的用不了时分叉接管后第一轮就失败；`thread/resume` 不带时留着原来的（真的 codex + 假模型对比过）。所以接管的分叉先 `thread/read` 拿原来的模型再带上，撤回和写摘要的临时分叉带 `record.model`，撤回到开头新开的 `thread/start` 也带。同一个模型不会触发换模型前的压缩。

## Considered Options

- **只靠审批请求，不用钩子：** 审批说不了原因、改不了参数。不够。
- **只靠钩子：** 钩子跑失败 Codex 还接着执行（实测）。三个口子叠着，漏了能被后面的接住或者至少记下来。
- **用动态工具（`dynamicTools` + `item/tool/call`）：** 协议最直接，但接管、重新拉起用不了，只能开两套。不要。
- **替用户写 `~/.codex/config.toml` 或项目的 `.codex/`：** 票里明确不许。
- **`--dangerously-bypass-hook-trust`：** 省一次重起，但连带放行用户别的钩子。不要。

## 实测的覆盖面（界面、手册照实写）

**先过钩子，判不放行就不执行、模型收到原因：** 命令（`dir`、`git status`、`Get-ChildItem` 这种只读的也过，Windows 上 `untrusted` 也都要审批，没有"判成只读不问"这回事）、补丁、MCP（二狗的和用户配的）、看图（映射成 `read`）、`get_goal`、`create_goal`、`update_goal`、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`、`sleep`、`curr_time`、子代理工具（`spawn_agent`、`wait_agent`、`list_agents`……）、`request_user_input`、`request_user_input_async`、被用户 execpolicy 放行或禁止的命令；子代理线程里的调用（钩子的 `agent_id` 是子线程，审批也送到二狗）；代码模式 `exec` 里嵌套的调用（调用 id 是 `exec-<uuid>`，判不放行时 JS 里抛错）。钩子报的名字把命名空间拼在前面（`clocksleep`、`collaborationspawn_agent`），适配子进程换成登记表里的。`update_plan` 0.166 已经没有了（`unsupported call`）。

**不过钩子：**

- `write_stdin`：见决定 3a，关了 TTY，送不了字符，只剩轮询输出；
- `tool_search`（直接调函数的模型）：没有钩子、没有条目，二狗记不到。只读工具说明；
- 代码模式外层的 `exec` 和 `wait`：没有钩子、没有条目，二狗记不到这段 JS 本身。`exec` 在 V8 隔离里跑，碰不到文件和网络，能碰外面的只有嵌套的工具调用，那些都过钩子；
- 联网搜索：关了；模型硬吐一个时 Codex 照样报条目（不过钩子）：事后记录，判了不放行打断这一轮；
- 生成图片：假模型下 Codex 不给这个工具，硬吐也没有条目，**没验证**。

**拦得住但有代价或限制：**

- 钩子跑失败（退出码不是 0）：Codex 放行。审批接住（判定用模型写的那句，`commandActions` 里的，不是外壳包好的），不放行回 `decline`；**但又被用户 execpolicy 放行的命令没有审批可接，只能跑完才知道**。钩子超时（设了 24 小时）没实测；
- `decline` 的原因到不了模型（`rejected by user`），记在二狗的记录上。钩子拦下的说得清原因；
- 模型写的 `workdir`：钩子看不到，靠决定 1 的补判。实测两种模型、子代理里都拦得下（相对路径的 `workdir` Codex 解析好了才报），只读的 `dir`、`Get-Content`、`git status` 也有审批可接。**用户 execpolicy 放行的命令没有审批可接：已经跑了，判了不放行只能打断这一轮，读到的内容可能已经到了模型那里**。`sandbox_permissions`、`justification` 钩子也看不到；
- 守卫按 Git Bash 的语法拆命令，PowerShell 只认程序表里的文件命令（`guard/shell/programs.ts` 的 PowerShell 一节）：cmdlet 和常用别名按对应的 Unix 命令判，参数不分大小写、能缩写，裸文件名算路径，表里没列、动词是写东西的 cmdlet（`Export-Csv`、`Tee-Object`）裸词也当路径。所以命令跑在受保护区（配置、数据库、程序目录）里写或删判永不，跑在密钥区里读硬拒绝，对话审批关着也一样；模型自己写 `cd D:\x; Remove-Item y`（不带 `workdir`）也一样。看不出路径的：`$env:`、`$变量`、`$( )` 走没法确定的路径，管道传来的（`Get-ChildItem x | Remove-Item`）按未知的写操作判、再算一个没法确定的路径，写和删对话审批关着也问；读没法确定的路径对话审批关着放行，原文写着密钥区的判永不。通配符和 `rm *.json` 一样，展不开的按通配符之前那段目录判。**还判不出来的：** 脚本块（`% { … }`）、`Invoke-Expression`、圆括号表达式（语法解析过不去）算未知的写操作，对话审批关着放行，只有原文写着受保护区、数据目录，或者当前目录落在受保护区里才拦；拼出来的路径（字符串相加、脚本块里的变量）认不出。不解析 PowerShell 的语法是有意的，见票 383；
- 事后核对打断有延迟（判定回来再等 200 毫秒）：回得快的这一轮可能已经结束了；
- 钩子放行、却没有条目的调用（goal、`list_agents`、`curr_time`、`request_user_input`、被 execpolicy 禁掉或 Codex 自己拒掉的命令）：结果不知道。下一次用量通知时按"没出错、结果空"收尾；
- 钩子连不上适配子进程：不放行，模型收到原因，这次调用没有记录（子进程都不在了）。

**等守卫时花额度（真账号实测）：** 代码模式下命令在 `exec` 的 JS 里调，钩子没回判定（审批卡没人点）时 `exec` 到点让出（默认 30 秒），模型接着 `wait`（默认 10 秒）。没写提示时实测，没人点卡两分钟 13 次模型调用，197413 token（145152 走缓存），一个命令都没跑成。`CODEX_TOOL_NOTE` 写了别反复查、`yield_time_ms` 给大之后再量（`gpt-6.1-sol`，达标线：3 分钟不超过 3 次，折算一小时不超过 15 次）：留卡 3 分钟，两个样本分别 1 次、2 次；等满 5 分钟 `approvals.waitMinutes` 到点，判定回"已提交审批"，模型花 2 次调用说明情况、结束这一轮（等待期间一共 4 次，77722 token，57344 走缓存），之后到用户批准前 0 次；批准的通知开一轮，模型原样重试，一次性授权放行，不出第二张卡，2 次调用。**量下来达标，所以没做"等人时 `turn/interrupt`、判定到了再开一轮"的方案**（设计记在票 381）。代价：这靠模型听话，样本只有两个，不是硬保证；兜底是 5 分钟上限，模型不听话时按没提示的速度一张卡约 30 次。以后量到超标再做。

**真账号验收到哪了（2026-11-02，详情在票 381）：** 过了的：`account/read` 是 chatgpt、账本的键、⚙ 模型列表和 `model/list` 一致（账号上 8 个，都是代码模式的 `gpt-6.x`、`gpt-5.6`，没有 `gpt-5.5`）、没登录写明、用不了的模型写明并能换；真模型跑成命令和 `apply_patch`，一次调用一条记录，日志没有"钩子没拦到"；找到并调通延迟加载的二狗工具（`tell_secretary`，普通任务没有 `report_progress`）；审批卡拒绝时文件在、模型拿到原因，批准才删、不出第二张卡；`codex exec` 造的会话分叉接管，答得出暗号，原会话不动；撤回后上下文真的切掉了；直接接管、交还、收回的机制。没验的：真终端占不占写入锁、直接接管和收回之后问暗号（用户做，清单在票 381）；模型这次没用 `codex_apps`、插件、生成图片，不知道；账号上没有直接调函数的模型，`tool_search` 这条路碰不到。

**还是没法用假模型验、真账号也还没验到的：** 终端界面占不占写入锁；直接调函数的模型会不会照系统提示先 `tool_search`；生成图片；ChatGPT 账号多出来的工具（`codex_apps`、插件）；真实限额和登录过期的错误形状。步骤写在票 381 的 Comments。

## Consequences

- 能力清单：`interject`、`compact`、`rollback`、`branch_switch`、`model_handoff`、`thinking_levels`、`take_over`、`scope_review`（`recordedScopeReview`，由二狗另起）是 `true`；`branch_summary`、`rewind_files`、`slash_passthrough`、`purge_rewrite`、`yield`、`live_toolkit`、`remote_control` 是 `false`。
- 假 app-server 的回复、通知和适配子进程发的请求都按生成的 schema 校验（`packages/daemon/test/fixtures/codex-app-server.schema.json`，`trim-codex-schema.mjs` 裁出）。Codex 升级要重新生成、重新核对。
- 宿主协议没变。`ResumableSessionView` 多 `unsure`，`AgentRuntimeView` 多 `missing`（外部程序没装时灰着列出来）。

## 补充：设置 · 组件装的 Codex 也认（票 454，2026-11-09）

用户要能从二狗的页面装 Codex，照 Claude Code 接入的样子做成组件。决定 1–10 都不变，只是"用户本机的 codex"多了一个来处。

- **组件「Codex 接入」**：组件清单里一条 `codex`，从 npm 官方下 `@openai/codex@0.166.0`（主包，只有 `bin/codex.js`）和 Windows x64 的平台包。平台包在 npm 上是同名包的另一个版本 `0.166.0-win32-x64`，主包的 `optionalDependencies` 里用别名 `@openai/codex-win32-x64` 引它；两个都解进 `<组件区>\codex\node_modules\@openai\` 下（`codex`、`codex-win32-x64`），和 `npm i -g` 装出来的结构一样。`bin/codex.js` 按 `require.resolve("@openai/codex-win32-x64/package.json")` 找平台包、拉起里面的 `vendor/x86_64-pc-windows-msvc/bin/codex.exe`：读的是 GitHub 上 `rust-v0.166.0` 的 `codex-cli/bin/codex.js`，和 npm 包里那份按 jsDelivr 列的文件 sha256 核对过是同一份；平台包没有安装脚本。
- **版本钉 0.166.0**：就是生成 app-server schema 的那一版（`test/fixtures/codex-app-server.schema.json` 的 `codexVersion`），测试锁住两者相等、不低于 `CODEX_MIN_VERSION`。npm 上已经有更新的（0.167.0），没跑过真的程序核对协议，不换；换版本要先重新生成 schema、跑 `real-codex.test.ts`，再改清单。
- **校验值是 registry 的**：npm 的元数据只给 sha512（`dist.integrity`），清单的文件加 `sha512`（十六进制），下载器、离线导入、"正式目录里已经有了"都认；大小对 tarball 发 HEAD（带 `Range: bytes=0-0`，看 `Content-Range` 的总长；不带时 registry 不回 `Content-Length`），没下载包。许可是 Apache-2.0（两个包的 package.json、仓库的 LICENSE），清单照写、不用确认。
- **先找组件区，再找 PATH**：组件是用户在二狗里点了装的，版本是核对过协议的那一版；想用自己 PATH 上的，在组件页删掉组件。守护进程这一侧（插件的 `missing`、体检、深度体检、设置 · 插件里的说明）用宿主交来的组件区，子进程（适配子进程、一次性子进程）用守护进程带的 `ERGO_COMPONENTS_DIR`。起法照 npm 装的那条：二狗自己的 Node 起组件里的 `codex.js`，版本读包里的 `package.json`。
- **默认和"已有"**：`default: detected`（PATH 上有 `codex` 才默认装）；PATH 上有用户自己装的、版本够的算"已有"（`provided: codex-cli`，找法和版本线从 Codex 插件的 `api.ts` 拿），不用从组件页装；PATH 上的太旧时照默认装组件。打开功能 `runtime.codex`：没装、也没有"已有"时新建任务、项目里的 Codex 灰着，点了去设置 · 组件。
- **登录照旧是用户自己的**：二狗不登录、不读凭据。组件装的不在 PATH 上，所以设置 · 插件里 Codex 那一块（插件的 `note`，`PluginInfo.note`）、没登录时这一轮的出错、深度体检"登录"一项的修法都写完整的命令，PowerShell 的写法 `& '<二狗的 node.exe>' '<组件区>\codex\node_modules\@openai\codex\bin\codex.js' login`（单引号，路径里的单引号写两个）。命令按当前的程序路径现拼，二狗升级换了版本目录也对。用 PATH 上的照旧写 `codex login`。
- **代价**：组件装好后插件不会自己装配，要回设置 · 插件点「启用」（和 Claude Code 接入一样）；在那之前运行时那一项写的还是装之前的那句"没装"。设置向导的"能力"一步没有列 Codex。
