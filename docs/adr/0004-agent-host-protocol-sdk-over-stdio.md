# 守护进程和 agent 子进程之间用自己的宿主协议：子进程里跑 pi SDK，stdio 上按行传 JSON

ADR-0002 定了每个 agent 一个子进程，留下一个 spike：守护进程和子进程之间的通信层，是直接用 pi 的 RPC 模式（`pi --mode rpc`，stdin/stdout JSON），还是在子进程里用 SDK、自己写一层 IPC。2026-10-07 用 pi 1.0.4 做了这个 spike，结论是**后者**：

- 子进程是二狗自己的一个小 Node 程序（`packages/daemon/src/runtime/agent-child/`），里面用 SDK 的 `createAgentSession()` 开一个 pi 会话。
- 守护进程和子进程之间只走二狗定义的 **agent 宿主协议**（`runtime/host-protocol.ts`）：stdin / stdout 上每行一个 JSON 对象，只按 LF 分帧。
- pi 的会话事件在子进程里就翻译成宿主协议的消息。守护进程这一侧连 pi 的事件形状都看不到，更不用说 pi 的类型（ADR-0001 的封装边界因此落在子进程入口上）。

## 逐项核对

对照规格第 3 节宿主协议的全部消息类型。RPC 一栏是实测加读文档（`docs/rpc*.md`）的结果：探针用本工作区装的 pi 起 `--mode rpc`，扩展里注册 faux provider，在 `tool_call` 钩子里用 `ctx.ui.confirm(..., { timeout: 300000 })` 向宿主"请求守卫判定"。

| 消息 | RPC 模式 | SDK + 自定义 IPC |
|---|---|---|
| 启动（会话装配参数） | 只能拼命令行参数和环境变量：`-ns --skill`、`-ne -e`、`-nc`、`PI_CODING_AGENT_DIR` 指向空目录。用不上规格要求的 `DefaultResourceLoader`；模型 key 只能走 `--api-key`（进程列表里看得见）或环境变量（会漏进工具起的孙进程） | 直接构造 `DefaultResourceLoader({ noSkills: true, additionalSkillPaths, ... })`、内存里的设置和凭据；key 经 stdin 送进 `setRuntimeApiKey`，不进环境 |
| 用户输入 | `prompt` ✓ | `session.prompt()` ✓ |
| 工单 | 只能当普通 prompt 文本 | 自己的消息类型 |
| 插话（下一步之前） | `steer` ✓ | `session.steer()` ✓，同一机制 |
| 守卫判定请求 / 回复 | 只能借扩展 UI 子协议：请求塞进 `confirm`/`input` 的 title、message 字符串，回复只有布尔或一个字符串。能停住工具调用等回复（实测等了 1.5 秒照常放行，dialog 自带超时） | `tool_call` 钩子里发 `guard_request`、等带同一 `requestId` 的 `guard_reply`；可以等 5 分钟，用 `ctx.signal` 响应中止 |
| 中止 | `abort` ✓ | `session.abort()` ✓ |
| 退出 | 关 stdin ✓ | `exit` 命令，或关 stdin ✓ |
| 就绪 | 没有专门的消息，只能轮询 `get_state` | `ready`，带会话文件路径和实际装配进来的资源清单 |
| 流式增量、消息定稿、工具调用开始和结束、回合结束和闲置 | pi 自己的 `message_update` / `message_end` / `tool_execution_*` / `agent_settled` ✓。但守护进程要解析 pi 的事件 JSON，没有类型检查，pi 改了形状只能在运行时发现 | 在子进程里翻译。翻译代码对着 pi 的 `.d.ts` 做类型检查，pi 改了事件形状，`tsc` 直接报错 |
| 用量（每次模型调用） | `message_end` 里的 `usage` ✓（实测） | 同一来源 ✓ |
| 范围审视结果 | 子进程到宿主没有自定义消息，只能借 `notify`、`setStatus` 这类 UI 消息或 `entry_appended` 夹带 | 自己的消息类型 |
| 错误 | `success: false` 的 response 加事件流 | `error`（带 code 和是否致命） |
| 心跳 | 没有，只能守护进程轮询 | 子进程按装配参数里的间隔发 |

RPC 模式**能**承载核心那几条（输入、插话、中止、用量，连守卫等待都能凑出来），但启动装配、守卫、工单、范围审视、就绪、心跳都要绕着它的 UI 子协议和命令行参数走，而且守护进程得直接吃 pi 的事件形状。

## 为什么选 SDK + 自定义 IPC

1. **会话装配必须用 SDK**：规格要求 `DefaultResourceLoader` + `noSkills: true` + `additionalSkillPaths`，不读 `~/.pi`、`~/.claude/skills` 和 CLI 认证。RPC 只能用参数和环境变量去逼近，CLI 本身还会做认证、配置、项目信任这些发现。
2. **守卫、工单、范围审视、心跳都是一等消息**，不用塞进 UI 对话框的字符串里。
3. **模型 key 不进 argv，也不进环境变量**，工具起的孙进程天然拿不到。
4. **pi 的形状变化在编译期暴露**：翻译只在子进程里做，对着 pi 的类型检查；再加 pi 契约测试兜底。
5. **测试替身好接**：faux provider 在子进程里按装配参数里的剧本注册，不用另写扩展文件。

## Considered Options

- **pi 的 RPC 模式**：零自写的子进程代码，还有现成的 `RpcClient`。代价见上表。
- **SDK + 自定义 IPC**（选定）：代价是要自己维护子进程入口（几百行）和分帧。分帧只按 LF 切，不用 `node:readline`，因为它会把 JSON 字符串里合法的 U+2028 / U+2029 当成换行。pi 的 RPC 文档特意提醒过这一点，集成测试里放了一个 U+2028。

## Consequences

- **协议的位置**：
  - 消息类型：`packages/daemon/src/runtime/host-protocol.ts`；
  - 分帧：`runtime/line-channel.ts`；
  - 守护进程侧句柄：`runtime/agent-process.ts`；
  - 子进程入口：`runtime/agent-child/main.ts`。
  - 上层只从 `runtime/index.ts` 取东西。
- **启动顺序**：拉起 → 守护进程把子进程放进 Job 对象 → 送 `start` → 子进程装配会话 → `ready`。子进程收到 `start` 之前什么都不做，所以不会有漏在 Job 外面的孙进程。
- **环境**：子进程的环境从一张系统变量白名单（PATH、SystemRoot、TEMP 等）加显式给出的变量构造，不继承守护进程的环境；模型 key 走 `start.credentials`。
- **pi 的全局目录**：pi 的 `agentDir` 指向数据目录临时区里的空目录（`tmp/pi-agent`）。
- **回合结束**：`turn_end` 对应 pi 的 `agent_settled`，意思是"这一轮处理完了、可以送下一条"。同一个 agent 的输入由守护进程排队；子进程在回合中途收到新输入会回 `busy`。
- **还没实现的消息**：`work_order`（12/16）、`interject`（13）、`guard_request` / `guard_reply`（07）、`scope_review_result`（18）已经定义好。子进程收到还没实现的命令时回 `unsupported`，不崩溃。
- **升级 pi**：升级时子进程的翻译代码可能要改，`tsc` 和 `npm run test:contract` 会先报出来。
- **Job 对象**（同一个 spike 里定下的做法）：
  - 用 koffi（预编译的 FFI）直接调 kernel32，建一个 `KILL_ON_JOB_CLOSE`、不允许脱离的 Job，没有另写辅助程序。
  - 实测发现：libuv 会把每个子进程先放进父进程私有、允许悄悄脱离的 Job，二狗的 Job 就嵌在它下面。真正把 bash 这类非 Node 进程起的孙进程、以及父进程已退出的孤儿留在清理范围里的，是"不允许脱离"这一条。
  - 测试里放开脱离，孤儿和孙进程就会在守护进程被强杀后活下来。
