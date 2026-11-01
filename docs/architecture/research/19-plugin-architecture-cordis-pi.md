# 调研 19：插件化架构——Cordis 与 pi 的扩展机制

> - **调研日期**：2026-10-17。只读了 GitHub 源码、npm 包、官方文档和本仓库。没有改二狗的代码，没有跑 npm install，没有装任何东西。看源码用的是 `git clone --depth 1` 到临时目录，或从 npm registry 下载发布包解压后只读。
> - **问题**：用户想把二狗整个系统做成插件化：界面（聊天窗口）、记忆、项目、任务都是插件。用户提到"DeepSeek harness 底层的 Cordis 框架插件化做得很好"；如果切不过去，就在 pi 的基础上把二狗的功能插件化，"以后接入一个记忆，就是给 pi agent 装一个插件"。本文回答五个问题：
>   1. "DeepSeek harness"到底是什么，底层是不是真用 Cordis、用到什么程度（§2）；
>   2. Cordis 的核心概念、卸载怎么收干净、成熟度和生态、界面插件化、用在二狗这种系统里的先例和坑（§3）；
>   3. pi 自己的扩展机制，在 SDK 用法下怎么挂、跑在哪、活多久、版本稳不稳（§4）；
>   4. "给 pi agent 装一个记忆插件"能做到什么、做不到什么，和"记忆做成守护进程里的插件"的取舍（§5）；
>   5. 和 VS Code、Fastify、Backstage 的插件做法对比（§6）。
>
>   §1 是要点。§7 汇总没核实的地方。§8 是对二狗的启示。§9 列全部来源。
> - **标注**：
>   - 不加标的是事实，后面附来源。
>   - 【推测】= 作者推断，来源里没有直说。
>   - 【建议】= 作者的建议。
>   - 【未核实】= 没在一手资料里找到定论。
> - **来源记法**（完整链接见 §9）：
>   - `CORDIS/` = `github.com/cordiverse/cordis` 的 main，commit `df4431eb43086bd1f8263a0e8c03e9b7c5233b68`（2026-10-16）。包内路径如 `packages/core/src/fiber.ts:445`；§3 里只写 `fiber.ts:445` 时指 `packages/core/src/` 下的文件。
>   - `CORDIS3/` = npm 包 `@cordisjs/core@3.18.1`（2024-09-17，Koishi 4.18.11 用的那一版）解压后的 `src/`。
>   - `DSH/` = `github.com/deepseek-ai/deepseek-harness` 的 master，commit `687f282e8625c6b8d11ff58211a90524be2e4317`（2026-10-17）。
>   - `[CA]` = 本仓库 `node_modules` 里的 `@earendil-works/pi-coding-agent@1.0.4` 发布包；`[CA13]` = 同一个包的 1.3.0 发布包（2026-10-15）。
>   - 本仓库的文件直接写相对仓库根的路径，ADR 写编号。
> - **取文方式**：Koishi 控制台和 VS Code / Fastify / Backstage 两部分由子 agent 读一手资料后回报，本文按回报整理，关键处标了出处；子 agent 读的网页经摘要工具取文，单段引文最长约 125 字符。拿去做决定之前，请对照原文再核一遍。
> - **和以前调研的关系**：调研 [03](03-openclaw-and-pi.md)、[10](10-pi-layer-mapping.md) 讲 pi 各层的能力和版本风险；ADR-0001、0002、0004、0018 定了"pi 包在 `agent-child/` 里、每个 agent 一个子进程、守护进程只当管家"。本文不重复这些，只补插件化相关的部分。

---

## 1. 要点

1. **"DeepSeek harness"确有其物，底层确实是 Cordis，而且用得很彻底**（§2）。
   - 它是 DeepSeek 官方开源的 agent harness `dsh`（`github.com/deepseek-ai/deepseek-harness`，2026-08-13 建库，MIT，开发者预览）。口号是 "Everything is a Plugin"：模型适配器、工具表、会话日志、agent 循环本身、网页界面全是 Cordis 插件。
   - 它把 Cordis 4.0.0-rc.7 的源码复制进仓库，记了 24 条本地改动，其中有 Fiber 生命周期的重入卸载补丁。
   - cordis 仓库的文档链接指向 dsh 的文档站；描述 Cordis 的论文（arXiv 2608.25512）署名有 DeepSeek-AI。
2. **Cordis 的插件化核心是两件事**（§3.2、§3.3）：
   - 凡是会留下痕迹的操作（监听事件、提供服务、挂子插件、开计时器）都写成"执行 + 返回撤销函数（disposer）"，记在当前插件的 Fiber 上；卸载插件时先等依赖它的插件卸完，再撤自己的全部记录。
   - 依赖注入（dependency injection）靠 `inject` 声明，是响应式的：依赖到齐才启动，没了自动停，换了实现就重启。服务的就绪顺序不用手排。
3. **但 Cordis 现在不算成熟**（§3.1、§3.6、§3.8）：
   - 主线 4.x 还是 RC（`latest` = 4.0.0-rc.11，2026-10-14），README 说 API 不稳定；Koishi 和它约 4766 个插件的市场还在 3.x，3.x 和 4.x 的核心名词不同（EffectScope → Fiber，`ready` / `dispose` 事件没了）。
   - 实际只有 Shigma 一个主维护者；官方文档还在建，现成最全的中文资料在 dsh 的文档站。
   - 循环依赖卡死、卸载时序、异步配置竞态都有还开着的 PR 或 issue。
4. **界面插件化**（§3.7）：
   - Koishi 控制台和 Cordis webui 都是"服务端登记客户端入口，浏览器里另跑一个 Cordis，`ctx.page` / `ctx.slot` / `ctx.settings` 都是副作用，入口撤了页面就撤"，但只支持 Vue。
   - dsh 是 React 版：一个包同时导出宿主半边和浏览器半边，网页用类型化插槽（slot）组合，插件之间不互相 import 组件。
5. **pi 有完整的扩展机制，SDK 用法下照样能挂，二狗已经在用**（§4）：
   - `DefaultResourceLoader({ extensionFactories })` 挂内联扩展；能注册工具、命令、模型供应商、MCP 服务，能在约 40 个事件上拦截或改写（`before_agent_start`、`context`、`tool_call`、`session_compact`……）。
   - 但扩展跑在 pi 所在的进程（在二狗里是每个 agent 的子进程）、跟着会话生灭；单个扩展不能卸载，工具注册了撤不掉；界面只有终端和对话框，没有网页扩展点（extension point）。
   - 二狗锁的 1.0.4 之后十天发了三个小版本，1.2.0 改了 `before_agent_start` 的事件形状。
6. **"给 pi agent 装一个记忆插件"只能覆盖记忆的 agent 侧那一小块**（§5）：
   - 能做：每轮注入记忆简报（`before_agent_start` 返回一条消息）、提供 recall 工具、压缩后重注入。
   - 做不到或不该做：跨 agent 整理、夜间做梦、记忆管理界面、记忆范围的强制、单一写者。这些只能在守护进程里。
   - dsh 没有这道选择题，因为它的 agent 跑在宿主进程里；二狗要选，是因为每个 agent 一个子进程。
7. **对比**（§6）：VS Code 是"先声明贡献点（contribution points）、宿主接线、扩展进独立进程、不给 DOM"；Fastify 是"同进程封装作用域（encapsulation）、不能运行时卸载"；Backstage 是"后端依赖注入容器、前端声明式 extension 树、前后端插件成对、经 HTTP 通信"。这五种里只有 Cordis 支持运行时卸载单个插件并把它的注册全部收回。

---

## 2. "DeepSeek harness"是什么

### 2.1 结论：DeepSeek 官方开源的 agent harness，整个产品建在 Cordis 上

- **仓库**：`github.com/deepseek-ai/deepseek-harness`。GitHub 上的简介是 "DeepSeek Harness: Everything is a Plugin."，话题标签 `ai-agents`、`cordis`、`dsh`、`dsh-plugin`，主页 deepseek.com/harness；2026-08-13 建库，MIT 许可，TypeScript（GitHub API，2026-10-17 查询）。同一次查询显示约 25.2 万 star、3.0 万 fork。
- **README 原话**："DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI"，"built on an **everything-is-a-plugin** architecture and powered by Cordis"（`DSH/README.md:5-7`）。
- **成熟度**：README 写着处于开发者预览阶段，"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."（`DSH/README.md:11-13`）。npm 包 `@deepseek-ai/dsh` 首版 0.0.1-rc.1（2026-08-10），`latest` 0.2.0-rc.2（2026-09-29），`next` 0.2.1-rc.2（2026-10-17），全是预发布版（npm registry）。
- **形态**：`npx @deepseek-ai/dsh web` 在本机起一个网页界面（默认 127.0.0.1:3080）（`DSH/README.md:19-27`）；另有 Electron 桌面版、headless、SDK、ACP 几种 profile（`DSH/docs/architecture.zh.md:17,43`）。
- **和 Cordis 的关系**：
  - cordis 仓库 README 把文档链接指向 dsh 的文档站："Documentation: cordis-primer（deepseek-harness.github.io/…）(official documentation is still under construction)"（`CORDIS/packages/core/README.md`）。
  - 描述 Cordis 的论文 arXiv 2608.25512（2026-08-26 提交 v1）作者署名是 Yifan Shi（北京大学、DeepSeek-AI）、Wei Zhang（北京大学）、Tianyi Cui（DeepSeek-AI）。dsh 的 npm 维护人之一就是 tianyicui-deepseek（npm registry）。
  - cordis 作者 Shigma 的 GitHub 资料里 company 一栏写的是 `@deepseek-ai`（GitHub API `users/shigma`，2026-10-17 查询）。【未核实】论文的 Yifan Shi 是否就是 Shigma，没有找到直接证据。
- 所以用户听到的"DeepSeek harness 底层是 Cordis"是准确的。

### 2.2 用到什么程度：从内核到浏览器界面全是 Cordis 插件

- **Cordis 是复制进仓库的**，不走 npm 依赖。`vendor/README.md` 原话："source-vendored copies of the Cordis framework … so that the harness fully owns its framework layer (auditable, patchable, pinned)"（`DSH/vendor/README.md:3`）。
  - 上游基线是 cordis 4.0.0-rc.7（cordiverse/cordis commit `56b3d4f`）、plugin-loader 1.0.0-rc.5（`vendor/README.md:19-20`）；改名为 `@deepseek-ai/cordis`（4.0.5）等发布。
  - 本地改动记了 24 条（`vendor/README.md`），其中第 6 条是 Fiber 生命周期加固，"locally closes three reentrant disposal gaps"（第 40 行）；第 15 条是配置延迟解析，移植自上游 PR #41（第 49 行）。另有一份状态为 proposed 的升级到 rc.11 的计划（`vendor/cordis-rc11-upgrade-plan.md:3`）。
- **架构文档原话**："产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 agent loop（智能体循环）本身"；"不存在需要打补丁的特权内核"（`DSH/docs/architecture.zh.md:9-11`）。
  - agent 循环本身就是一个服务：`export class AgentLoop extends Service implements AgentFactory`，`static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']`（`DSH/packages/core/agent-loop/src/index.ts:341-342`）。
  - `packages/` 和 `apps/` 下 360 个 `package.json` 里有 345 个依赖 `@deepseek-ai/cordis`（在 commit `687f282` 的检出上用 grep 数的）。`packages/client/` 下以 `ui-` 开头的界面插件包有 56 个。
- **配置分层**：一个 profile 由若干"组合包"（bundle）叠成，每个组合包是一份 Cordis 加载器的 patch；启动时依次叠加组合包 → profile 的 `cordis.patch.yml` → 用户主目录的 patch → 命令行 `--patch`（`DSH/docs/architecture.zh.md:13-39`）。
- **能力 seam**：每项可替换能力分三个角色，Service Definition 声明接口、Service Provider 实现、Consumer 使用（`architecture.zh.md:134-140`）。
- **"新行为归谁"有一张表**（`architecture.zh.md:142-167`），例如：加模型可见的上下文用 `agent.inject()`；加持久会话状态就扩展 `SessionEventMap`、从日志回放；把注册限定到单个 agent 用这个 agent 的 `agent.ctx`；加网页聊天节点注册 `ConversationNodeDefinition` 加渲染器。
- **网页界面也是 Cordis 插件**：浏览器侧是一个独立的 Cordis 应用，用 React 渲染，功能插件经类型化的 slot 往界面里加东西（§3.7.2）。
- **事件溯源（event sourcing）式的会话日志**：只追加的 `SessionEvent` 日志是模型所见上下文的唯一来源，"模型可见即已记录"（`architecture.zh.md:122-128`）；领域插件注册纯同步的投影（projection）单元，框架把每个已提交事件折叠进去（`DSH/docs/subsystems/session-projection.zh.md:5`）；持久化是一个 seam，句柄独占写（`DSH/docs/subsystems/persistence.zh.md:7,9`）。
- **子 agent**：进程内的（全新起、或带父历史 fork）和进程外的（ACP、Codex、Claude Code、另一个 dsh）都挂在同一个 `ctx.subagents` 下（`DSH/packages/subagent/README.zh.md`）。进程外的经 `ctx.subprocess` 起子进程（`DSH/docs/subsystems/subprocess.zh.md:5`）。**dsh 的主 agent 跑在宿主进程里**，不是每个 agent 一个子进程。
- **记忆**：按目录名查，没有长期记忆插件；相关的只有压缩、目标（goal）和实验性的 session-search（`DSH/packages/`、`packages/experimental/` 目录列表）。
- **自我扩展**：dsh 给 agent 提供只读工具查运行时的插件树，再配合插件管理器，agent 能自己写组合包、安装、热加载（子 agent 读 `docs/user/develop/practice/dynamic-cordis.zh.md` 得出，本文没有逐行核对）。

### 2.3 查过、排除的方向

- deepseek-ai 组织下没有别的 TypeScript agent 框架（子 agent 查 GitHub API 组织仓库列表）。
- cordiverse 组织（19 个仓库，含 cordis、webui、server、http、database）里没有 agent / LLM 项目（同上）。
- 欧盟科研信息服务也叫 CORDIS，同名无关。

---

## 3. Cordis

### 3.1 两条版本线：Koishi 用 3.x，当前主线是 4.x

- npm 上 `cordis` 的 `latest` 标签现在指向 **4.0.0-rc.11**（2026-10-14）；`next` 标签还停在 4.0.0-beta.5（2025-06-01），已经过时（npm `cordis` 的 `dist-tags` 和 `time`）。
- 4.x 从 4.0.0-alpha.0（2024-11-11）算起已经发了 29 个预发布版；近一年（2025-10-17 起）发了 14 个，rc.4 到 rc.11 大约每月一个（同上）。
- 3.x 最后一版是 3.18.1（2024-09-17）。Koishi 最新版 4.18.11（2026-02-27）的 `@koishijs/core` 依赖 `cordis: ^3.18.1`（npm `@koishijs/core@latest` 的 `dependencies`）。也就是说，**Koishi 和它的插件市场跑在 3.x 上，还没有换到 4.x**。
- 仓库 README 原话："Cordis is under active development. The API is not yet stable and may change without notice."（`CORDIS/packages/core/README.md`）
- 3 → 4 改了核心名词，旧文章和 Koishi 文档里的写法不能直接套到 4.x：

| 概念 | 3.18.1（Koishi 在用） | 4.0.0-rc.11（主线） |
|---|---|---|
| 副作用作用域 | `EffectScope`，分 `MainScope`（每个插件一个）和 `ForkScope`（每次 `ctx.plugin()` 一个），`ctx.scope` / `ctx.runtime`（`CORDIS3/src/scope.ts:58,256,308`） | 统一成 `Fiber`，`ctx.fiber`；同一个插件注册几次就有几个 Fiber，挂在一个 `Plugin.Runtime` 的 `fibers` 列表上（`CORDIS/packages/core/src/fiber.ts:103`、`registry.ts:94-99`） |
| 生命周期事件 | `ctx.on('ready')`、`ctx.on('dispose')`、`ctx.on('fork')`，由事件系统特殊处理（`CORDIS3/src/events.ts:58-72`） | 核心的 `Events` 里只剩 `internal/*` 事件（`events.ts:186-198`）。插件的 `apply` 可以是 async，它返回的函数就是清理函数；服务用 `[Service.init]()` 做异步初始化（`fiber.ts:142-153`） |
| 服务启停 | `Service` 有 `start()` / `stop()`，挂在 ready / dispose 上（`CORDIS3/src/service.ts:66-73`） | `Service` 构造时调 `ctx.reflect.provide(name, self, check)`（`service.ts:35`），没有 start / stop |
| 依赖 | `inject` 分必需和可选，只有必需的缺了才不启动（`CORDIS3/src/scope.ts:169-173`）；没声明就访问服务只**警告**（`CORDIS3/src/reflect.ts:45,60`） | `inject` 里列的全部到齐才启动（`fiber.ts:383-394`）；没声明就访问服务直接**抛错**（`reflect.ts:103`）。核心源码里没找到"可选依赖"的写法 |
| 配置校验 | `plugin.Config` / `plugin.schema`，生态里用 schemastery | `Config` 要实现 Standard Schema（`@standard-schema/spec`），只支持同步校验（`fiber.ts:34-46`、`registry.ts:69-75`）。schemastery 3.18.0 已经实现了 `~standard`（npm 包 `src/index.ts:214`），zod 等也能用 |
| 状态 | PENDING / LOADING / ACTIVE / FAILED / DISPOSED | 多一个 UNLOADING（`fiber.ts:78-85`） |

下面 §3.2–3.5 以 4.x 主线（commit `df4431e`，2026-10-16）为准，必要时注明 3.x 的不同。

### 3.2 核心概念（4.x）

- **上下文（Context）**：
  - 根是 `new Context()`。每个插件拿到的是从父上下文派生出来的一个新对象（原型链继承，`context.ts:55-63`），上面挂着这个插件自己的 `fiber`。
  - 上下文对象是一个 Proxy（`context.ts:39`）。读一个服务属性时，Proxy 先查这个插件有没有在 `inject` 里声明它：没声明抛 `cannot get property "x" without inject`（`reflect.ts:103`），声明了但服务不在抛 `cannot get required service "x" in inactive context`（`reflect.ts:118`）。
  - 所有"往系统里加东西"的 API 都挂在上下文上：`ctx.on`、`ctx.plugin`、`ctx.provide`、`ctx.effect`、`ctx.inject`……（`reflect.ts:171-175` 用 mixin 把各内置服务的方法挂到 ctx 上）。
- **插件（Plugin）**：三种写法（`registry.ts:63-92`）：
  - 函数 `(ctx, config) => …`；
  - 类 `new (ctx, config)`（"类插件"）；
  - 带 `apply(ctx, config)` 方法的对象。
  - 可以再带静态字段 `name`、`Config`、`inject`、`provide`、`intercept`（`registry.ts:69-75`）。
  - `ctx.plugin(p, config)` 返回一个可以 `await` 的 Fiber：`await` 会等到它加载完或失败（`registry.ts:193-213`）。
- **服务（Service）**：
  - 提供方：`class Foo extends Service { constructor(ctx) { super(ctx, 'foo') } }`，构造时登记为名叫 `foo` 的服务（`service.ts:20-37`）；也可以直接 `ctx.provide('foo')` 再 `ctx.set('foo', value)`。
  - 使用方：插件写 `static inject = ['foo']`，或用 `@Inject('foo')` 装饰类或方法（`registry.ts:17-40`），或 `ctx.inject(['foo'], (ctx) => …)` 起一个只在 foo 在时才活着的子插件。
  - 同名服务只能登记一次，再登记就抛错（`reflect.ts:214-216`）。
- **依赖注入是"响应式"的**：
  - 每个 Fiber 有一个 epoch：修订号加上它注入的每个服务实现的 uid（`fiber.ts:383-394`）。
  - 任何一个依赖不在，epoch 变成 INACTIVE，插件不运行；正在运行的就卸载。依赖都到齐了才加载。依赖被换成另一个实现（uid 变了），插件先卸载再重新加载（`fiber.ts:396-443`）。
  - 所以**服务的就绪顺序不用手排**：插件可以先于它依赖的服务注册，服务到了它才启动；服务没了它自动停。
  - 论文把这叫"响应式余效应"（reactive coeffects）：组件的激活和停用由依赖驱动（arXiv 2608.25512 摘要）。
- **副作用（effect）**：见 §3.3。
- **事件**：`ctx.on / once / emit / parallel / serial / bail / waterfall`（`events.ts:16-33`）。`parallel` 并发跑全部监听器、汇总错误；`serial` / `bail` 遇到第一个非空返回值就停；`waterfall` 是中间件式的 `next()` 链（`events.ts:95-140`）。监听器登记本身也是一个副作用（`events.ts:142-149`），插件卸载时自动撤掉。
- **隔离（isolate）与拦截（intercept）**：
  - `ctx.isolate('foo')` 给 `foo` 这个服务名开一个新的命名空间：在它下面注册的插件看到的 `foo` 是另一份，互不影响（`context.ts:65-69`）。加载器的配置里也能写 `isolate:`（`packages/loader/src/config/isolate.ts:5-10`）。
  - `ctx.intercept('foo', config)` 给这一支上下文里的 `foo` 服务附加一份配置，服务读到的是沿上下文链合并后的结果（`context.ts:71-77`、`service.ts:57-70`）。
- **配置与热更新配置**：`fiber.update(config)` 先校验，再走 `internal/update` 链；监听器可以就地接住新配置、不重启插件，没人接就重启这个插件（`fiber.ts:497-517`）。
- **TypeScript**：整个库用 TS 写。服务的类型靠声明合并（declaration merging）挂到 `Context` 上，例如计时器插件写 `declare module 'cordis' { interface Context { timer: TimerService } }`（`packages/timer/src/index.ts:3-7`）。

### 3.3 卸载一个插件时，它注册的东西怎么全部收回

核心只有一个机制：**凡是会留下痕迹的操作，都写成"执行 + 返回撤销函数"，并记在当前插件的 Fiber 上**。

1. `fiber.effect(execute, label)` 运行 `execute`，把它返回的撤销函数收进这个 Fiber 的 `_disposables`（`fiber.ts:273-338`）。`execute` 可以返回一个函数、一个逐个 `yield` 撤销函数的生成器、一个 Promise 或一个异步迭代器（`fiber.ts:54-64,227-271`）。
2. 框架自己的 API 全建在它上面：
   - 事件监听：`ctx.on` 登记时就是一个 effect，撤销函数从监听表里删掉它（`events.ts:142-149`）；
   - 服务：`ctx.provide` 是一个 effect，撤销时把实现从服务表里拿掉、通知依赖它的插件（`reflect.ts:202-238`）；
   - 子插件：新 Fiber 用 `parent.fiber.effect(...)` 把自己挂在父插件上（`fiber.ts:164-193`），所以卸父插件会连带卸掉整棵子树；
   - 计时器：`@cordisjs/plugin-timer` 的 `ctx.timeout` / `ctx.interval` 也是 effect，撤销时 `clearTimeout` / `clearInterval`，还会让正在 `await ctx.timeout(…)` 的代码收到 "Context has been disposed"（`packages/timer/src/index.ts:27-80`）。
3. **卸载顺序**（`fiber.ts:445-479`）：
   - 先等：如果这个插件提供的服务还有别的插件在用，先等那些插件卸完。源码注释写明原因：依赖方在自己的清理过程中可能还要用这个服务（"may still access its services during their own teardown"，`fiber.ts:446-448`）；
   - 再并发执行全部撤销函数，单个出错只记日志、不中断别的（`fiber.ts:453-463`）；
   - 最后告诉它依赖的那些服务"我不用了"，让它们也能继续卸载（`fiber.ts:465-469`）。
4. **卸完之后再登记会报错**：Fiber 卸掉后 `uid` 变成 null，之后在这个上下文上再调 `ctx.on` / `ctx.effect` 等都抛 `INACTIVE_EFFECT`（`fiber.ts:97,218-221`）。所以插件里 `await` 回来之后迟到的登记不会悄悄泄漏。
5. 有单元测试覆盖这些边角：`tests/dispose.spec.ts`、`tests/service-dispose.spec.ts`（例如 "releases dependencies after a cleanup error"、"retains an ancestor injection until its child finishes cleanup"）。
6. **管不到的**【推测，由上面的机制直接推出】：只有经过 ctx 登记的东西才会被收回。插件自己直接调 `setTimeout`、`child_process.spawn`、开 socket、写模块级全局变量，框架都不知道，必须自己包进 `ctx.effect(() => { …; return cleanup })`。热重载（HMR，hot module replacement）也只跟踪用户代码：它收集依赖时跳过 `node:` 内置模块和 `node_modules`（`packages/hmr/src/index.ts:33-46`）。

3.x 的做法相同，只是名字不同：`EffectScope.effect()` 把撤销函数推进 `disposables`（`CORDIS3/src/scope.ts:94-113`），`reset()` 时逐个执行、出错发 `internal/error`（`scope.ts:175-183`）；`ctx.on('dispose', fn)` 就是往 `disposables` 里推一个（`CORDIS3/src/events.ts:64-67`）。

### 3.4 生命周期

- **4.x**：
  - 插件的 `apply` 是 async 时，Fiber 在 Promise 结束前处于 LOADING；依赖它提供的服务的插件也会等着。测试 "pending inject" 演示了：服务在 `[Service.init]()` 里等一个事件，依赖它的插件就一直不启动，事件来了才启动（`tests/service.spec.ts:7-35`）。
  - 状态：PENDING（依赖没到齐）→ LOADING → ACTIVE；出错 FAILED，只能靠 `update()` 恢复；卸载中 UNLOADING；卸完 DISPOSED（`fiber.ts:78-85,346-351,399-400`）。
  - 状态变化会发 `internal/status` 事件（`fiber.ts:353-367`），控制台、加载器靠它显示插件状态。
- **3.x**：`ready` 在插件启动（依赖到齐）后触发，`dispose` 在卸载时触发，`fork` 在可复用插件每次被注册时触发（`CORDIS3/src/events.ts:58-72,223-225`）。

### 3.5 声明式加载器与热重载

- `@cordisjs/plugin-loader`（1.0.0-rc.8，2026-10-14）：把插件树写成配置条目 `{ id, name, config, group, disabled, inject, isolate, intercept }`（`packages/loader/src/config/entry.ts:8-15`、`isolate.ts:5-10`）；`disabled` 可以写 JS 表达式（`entry.ts:63-67`）。
- `@cordisjs/plugin-include`（1.1.1）：读 `cordis.yml`，支持 `!!js` 表达式标签；运行时对插件树的改动（启用、停用、改配置）经一份 journal 写回配置文件（`packages/include/src/index.ts:15-24`、`journal.ts:4-30`）。
- `cordis` 自带的命令行入口就是：建根上下文 → 装加载器 → 用 include 读 `./cordis.yml`（`packages/core/bin.js`）。
- `@cordisjs/plugin-hmr`（1.1.1）：用 chokidar 监视文件；文件变了，找出受影响的插件，卸掉旧 Fiber，用重新 import 的模块重建（`packages/hmr/src/index.ts:1-80`）。祖先已经卸掉的 Fiber 不重建，否则会撞上 `INACTIVE_EFFECT`（`hmr/src/index.ts:63-78`）。
- 主线最新一个提交是"fix(hmr): accept a drive-letter path for `base` (#208)"（2026-10-16）：Windows 盘符路径到最近才修好，在 Windows 上要预期还会遇到这类问题【推测】。

### 3.6 成熟度、生态、维护、文档

本节的统计除注明外由子 agent 在 2026-10-17 取数（npm registry 的 `time` 字段、GitHub REST API、市场索引）；issue 状态本文复查过。

- **npm 版本**：

| 包 | 当前版本（发布日） | 近 12 个月发版 | 状态 |
|---|---|---|---|
| `cordis` | 4.0.0-rc.11（2026-10-14） | 14 个，全是预发布 | `latest` 指向 RC；最后稳定版 3.18.1（2024-09-17） |
| `koishi` | 4.18.11（2026-02-27） | 2 个 | 稳定版，依赖 cordis ^3.18.1 |
| `@koishijs/console` 等 | 5.30.11（2025-11-17） | 2 个 | 稳定、基本只维护；`@koishijs/client`、`@koishijs/plugin-console` 是 AGPL-3.0 |
| `@cordisjs/plugin-webui`、`@cordisjs/client` | 0.8.2（2026-05-13） | 17 个，集中在 2026-04~05 | 0.x |
| `@cordisjs/plugin-loader` | 1.0.0-rc.8（2026-10-14） | 11 个 | RC |

- **插件市场**：
  - Koishi 市场的数据源 `registry.koishi.chat/index.json` 共 4766 个包；一年内有更新的 1891 个（约 40%）；月下载量中位数 5（子 agent 2026-10-17 11:12 UTC 取数，本文从本机复取失败）。
  - Cordis 4 自己的市场 `registry.cordis.io/index.json` 只有 69 个包，66 个是官方 `@cordisjs/*`。
  - Koishi 插件建在 cordis 3 上，不能直接用在 cordis 4 上【推测，依据依赖版本】。
- **维护**：

| 仓库 | star | 最后提交 | 近 12 个月提交 | 贡献者 |
|---|---|---|---|---|
| cordiverse/cordis | 9217 | 2026-10-16 | 123，其中 Shigma 81 | 17 人，Shigma 占 557/604 |
| koishijs/koishi | 6254 | 2026-10-08 | 14 | 55 人，Shigma 约 93% |
| koishijs/webui | 40 | 2026-10-08 | 14 | 23 人 |
| cordiverse/webui | 11 | 2026-06-06 | 80，全是 Shigma | 1 人 |

  - cordis 在 2025-10 到 2026-02 没有提交，2026-03 起重新活跃；每月新开的 issue + PR 从 2026-07 的 5 个跳到 08 月 64 个、09 月 77 个，和 dsh 上线（2026-08-13）时间吻合【推测：关注度来自 dsh】。
  - **主维护者实际只有 Shigma 一人。**
- **文档语言**：
  - Koishi 文档有 zh-CN 和 6 种翻译目录，但抽查 en-US、ja-JP、de-DE 的同一页只译了标题，正文仍是中文。
  - Cordis 的官方文档"still under construction"（README）；cordiverse/docs 只有 zh-CN，最后提交 2025-04-01，早于 4.x RC；cordis.io 当天打不开。现成最完整的是 dsh 文档站上的中文 Cordis 入门、七章教程和 API 目录（`DSH/docs/cordis-primer.zh.md`、`docs/cordis-tutorial/`、`docs/cordis-api/`）。
- **TypeScript**：全部 TS 编写，靠声明合并扩展 `Context`。但 `inject` 不会在类型上收窄：`ctx.inject(deps, callback)` 的回调拿到的 ctx 类型里，服务永远"存在"（`registry.ts:118-123`），缺了只在运行时报错。NodeNext 项目从 cordis 导入类型失败的问题 cordis#124 在 2026-10-14 才关闭。

### 3.7 界面插件化

#### 3.7.1 Koishi 控制台与 Cordis webui（都是 Vue 3）

两套实现，API 不同（子 agent 读源码回报，本文抽查了 `addEntry` / `addListener` 两处）：

- Koishi 版：koishijs/webui @ `1dc5c0e`（2026-10-08），建在 cordis 3.18.1 上。
- Cordis 版：cordiverse/webui @ `2a884b5`（2026-06-06），建在 cordis 4 RC 上，MIT。

**服务端（守护进程这一侧）**：

- **声明客户端入口**：
  - Koishi 版 `ctx.console.addEntry({ dev, prod })`：`dev` 是客户端源码路径，`prod` 是预构建产物目录。构造时用 `ctx.collect('entry', …)` 登记清理，插件卸载时入口自动删掉并通知浏览器（`koishijs/webui packages/console/src/entry.ts:13-25`）。
  - Cordis 版 `ctx.webui.addEntry({ baseUrl, source, manifest, routes }, data)`，清理挂在 `ctx.effect` 上（`cordiverse/webui plugins/webui/src/base/entry.ts`）。
- **给前端推数据**：
  - Koishi 版继承 `DataService<T>`：它本身是一个 `inject = ['console']` 的服务，`refresh()` 发整份、`patch()` 发增量（`packages/console/src/service.ts`）。
  - Cordis 版没有 DataService：`data` 就是状态对象，`entry.mutate(d => …)` 生成增量广播。
- **前端调后端（RPC）**：
  - Koishi 版 `ctx.console.addListener(event, cb)` 的实现只有一句 `this.listeners[event] = { callback, ...options }`，没有登记清理（`packages/console/src/index.ts:100-102`，本文已核对）。插件卸载后监听还留着【推测：影响由代码推出】。
  - Cordis 版里 `data` 中的函数自动成为远程方法，跟着入口一起生灭。

**客户端（浏览器这一侧）**：

- 浏览器里也跑一个 cordis Context。Koishi 版 `class Context extends cordis.Context`；Cordis 版 `createClient()` 新建 `new Context()`。
- 插件的客户端入口：Koishi 版 `export default (ctx) => { ctx.page({...}); ctx.slot({...}) }`；Cordis 版 `export function apply(ctx, data) { ctx.client.router.page(...) }`，客户端插件也能写 `inject`。
- 扩展点：页面（活动栏）、组件插槽（root、global、layout、status、home 等，插件可自定义）、设置面板（Schemastery 表单）、主题、快捷键和右键菜单。这些方法内部都是 `ctx.effect(() => { …; return () => remove(…) })`。
- **卸载时界面会撤掉**：Koishi 版给每个入口开一个隔离的子插件，服务端入口消失时 `scope.dispose()`，页面、插槽、设置、CSS `<link>` 一起撤。浏览器的 ES 模块缓存卸不掉，只是副作用被回收【推测】。

**前端插件包怎么加载**：

- 开发时：Vite 以中间件模式跑在服务端进程里，插件入口直接指向源码（`/vite/@fs/<绝对路径>`）。
- 生产时：每个插件预构建成一个 ES 库包，浏览器动态 `import(url)` 加载；`vue` 等共享依赖标成外部依赖，服务端出包时把裸模块名改写到全站共享的那一份上，保证只有一份 Vue。
- 后端实例或外壳版本一变就整页刷新；两套的 WebSocket 断线重连成功后都执行 `location.reload`。也就是**服务端每重启一次，打开的页面都整页刷新**。
- 两套都**只支持 Vue**，二狗的网页是 React。

#### 3.7.2 dsh 的网页插件（React）

- 浏览器侧是"由独立加载插件组装而成的浏览器侧 Cordis 应用"，有四个底座：Client Modules 加载插件图、API Gateway 做类型化的宿主通信、Slots 组合 React 界面、Conversation 把会话历史变成视图（`DSH/docs/subsystems/web-client.zh.md:5`）。
- **一个包两半**：包在 `package.json` 里声明 `dsh.client`（`platform: 'web'`、可选的 `inject` 边），在 `exports["./client"]` 导出构建好的浏览器包（`DSH/docs/subsystems/client-modules.zh.md:94`）。宿主扫描已启用的加载器条目，把浏览器包拼成带版本号的合并脚本，从 `/plugins` 下发，启动图注入成 `window.__DSH_BOOT__`（同文件第 5、102 行）。宿主那一行关掉，它注册的页面也随之消失（`docs/cookbook/adding-a-settings-card.zh.md` 第 5 节）。
- **插槽**：`SlotMap` 是编译期注册表，各包靠声明合并加插槽；功能插件 `ctx.slots.register()` 贡献组件，"绝不导入其他功能插件的组件"；向别人的插槽贡献用 `ctx.slots.inject(key, cb)`，插槽的主人卸掉时贡献一起撤（`DSH/docs/subsystems/slots.zh.md:5,15-21`）。插槽有单个、列表、按键、链式四种基数，作用域分 root 和会话级（同文件"Cardinality 与 scope"一节）。
- **状态归宿主**：宿主的业务服务拥有权威状态和持久化，浏览器侧的 Client model 只做镜像；展示组件"绝不接收 Cordis `ctx`、transport object 或其他功能插件的实现"（`web-client.zh.md:13-20`）。
- `packages/client/` 下有 56 个 `ui-*` 包（§2.2），聊天、审批、工具调用、子 agent、设置各页、插件管理和插件市场都是插件（`DSH/packages/client/README.zh.md` 包表）。

### 3.8 用在"常驻守护进程 + 子进程 agent + 事件溯源存储"里：先例和坑

**先例**：

- **dsh 是最接近的先例**（§2.2）：常驻宿主 + 网页 + 只追加的会话日志 + 投影 + 子 agent 都是 Cordis 插件。不同的是 dsh 的主 agent 跑在宿主进程里；二狗是每个 agent 一个子进程（ADR-0002）。dsh 把所有子进程收口到一个 `ctx.subprocess` 服务（`DSH/docs/subsystems/subprocess.zh.md:5`）。
- **Koishi 本身就是常驻进程**：`koishi start` 是父进程，fork 一个工作进程；工作进程退出码 51 表示要求重启（子 agent 读 `koishijs/koishi packages/koishi/src/cli/start.ts`）。外部子进程没有统一服务，惯例是在服务的 `start()` 里起、`stop()` 里收；父进程被强杀时 `stop()` 不会执行【推测】。

**坑**（issue 状态为 2026-10-17 本文复查）：

- **循环依赖不报错**：插件互相 `inject` 时会一直停在 PENDING。修复 PR cordis#66（"reject circular plugin dependencies"，2026-08-15）还开着。
- **卸载时序还在修**：
  - cordis#96（"refuse effect/listener/plugin registration while a fiber is UNLOADING"）、#185（"four disposal-order defects around fiber activation and teardown"）两个 PR 都还开着；
  - cordis#194（Shigma 本人 2026-10-12 提）："Async updates can race with each other and with lifecycle changes"，还开着；
  - cordis#127（非激活的 Fiber 卸掉后状态永远到不了 DISPOSED）2026-10-15 才关；
  - dsh 自己在 vendor 里补了"three reentrant disposal gaps"（§2.2）。
- **可选依赖**：4.x 的 `inject` 全是必需的（§3.1），想"有就用、没有也能跑"要走 `ctx.get()`。dsh 复盘 0001 的第二个根因就是可选服务经可追踪代理访问时，只沿祖先查找、查不到兄弟分支提供的服务而抛错（`DSH/docs/postmortem/0001-acp-default-export-drops-inject.zh.md` 根因 #2）。
- **加载器会吞掉命名导出**：模块同时有 `export default apply` 和 `export const inject` 时，加载器取 `default`，`inject` 丢失，插件在没有注入的 Fiber 里运行（复盘 0001 根因 #1）。
- **服务替换会连带重启依赖方**：Koishi 文档原话，服务的值一变，依赖它的插件"将立即回滚"，新值可用再重新加载（子 agent 读 koishijs/docs `zh-CN/guide/plugin/service.md`）。控制台服务一重载，所有 `DataService` 都跟着重启。
- **热重载依赖 Node 内部 API**：cordis 4 的源码热重载要清 Node ESM 的内部缓存，取不到时提示要加 `--expose-internals`；适配代码按 Node 22/23 和 24 分别写（子 agent 读 `packages/hmr/src/index.ts`、`packages/loader/src/internal.ts`）。cordis#154：Node 26 原生 TS 跑时加载器在第一个插件后挂起，还开着。
- **前端整页刷新**：两套控制台都是服务端一重启、所有页面整页刷新（§3.7.1）。

**和外部进程生命周期的关系**：
- Cordis 会 `await` 异步的撤销函数（`fiber.ts:453-463`），也会让提供方等依赖方卸完（§3.3）。但撤销函数里是只"发出终止信号"还是"等到子进程真正退出"，由插件作者决定。dsh 为此专门立了一条规则："发出终止或中止信号后，应等待子进程退出"（`DSH/docs/defensive-patterns/general.zh.md:216-222`）。
- 守护进程被强杀时，撤销函数根本不会跑【推测】，子进程要靠操作系统层面的手段回收（二狗用 Job 对象，ADR-0002）。

---

## 4. pi 自己的扩展机制

二狗锁定的版本是 `@earendil-works/pi-coding-agent` **1.0.4**（根 `package.json:35`、`packages/daemon/package.json:18`）。本节以仓库 `node_modules` 里装的 1.0.4 发布包为准（记作 `[CA]`），再和 npm 最新的 1.3.0（2026-10-15）对比（记作 `[CA13]`）。

### 4.1 能做什么

- 扩展（extension）是一个 TS 模块，默认导出一个工厂函数，参数是 `ExtensionAPI`（`[CA] docs/extensions.md:15`；类型 `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`，`dist/core/extensions/types.d.ts:1483`）。
- 文档列出的接入点（`[CA] docs/extensions.md:73-86`，签名见 `types.d.ts:1151-1308`）：

| 能力 | API |
|---|---|
| 观察或改写生命周期 | `pi.on(event, handler)`，约 40 个事件 |
| 给模型加工具 | `pi.registerTool()` |
| 加 `/` 命令 | `pi.registerCommand()` |
| 加快捷键、命令行参数 | `pi.registerShortcut()`、`pi.registerFlag()` |
| 发用户消息或自定义消息 | `pi.sendUserMessage()`、`pi.sendMessage()` |
| 存不进上下文的会话数据 | `pi.appendEntry()` |
| 改当前工具、模型、思考档位 | `pi.setActiveTools()`、`pi.setModel()`、`pi.setThinkingLevel()` |
| 加模型供应商、虚拟模型 | `pi.registerProvider()`、`pi.registerVirtualModel()` |
| 加 MCP 服务 | `pi.registerMcpServer()` / `unregisterMcpServer()` |
| 终端界面渲染 | `registerMessageRenderer` / `registerEntryRenderer` / `registerToolRenderer`、`ctx.ui` |
| 扩展之间通信 | `pi.events`（事件总线） |

- 跟"插件化二狗"最相关的几个事件：
  - `before_agent_start`：每次用户输入开始一轮之前。可以改系统提示的分段（推荐，pi 只追加差量），可以整个替换系统提示，还可以返回一条 `message`（`[CA] docs/extensions.md:103`；`types.d.ts:1090-1094`）。返回的 `message` 会作为 `role: "custom"` 的消息排在用户消息后面一起进这一轮（`dist/core/agent-session.js:1597-1620`）。
  - `context`：每次调模型之前改写要发的消息。改的是消息的副本（`structuredClone`），不写进会话；系统消息不交给处理器，改完 pi 再放回去（`[CA] docs/extensions.md:115`、`dist/core/extensions/runner.js:1006-1021`）。
  - `tool_call` / `tool_result`：拦截、改参数、改结果（`[CA] docs/extensions.md:105`）。
  - `turn_end` / `agent_before_settle`：可以追加条目并要求再跑一次模型（`[CA] docs/extensions.md:117`）。
  - `session_before_compact` / `session_compact`：自定义压缩、压缩后重注入。
  - `session_start` / `session_shutdown`：起、停长期资源（`[CA] docs/extensions.md:56-60`）。
- 分发：pi 包（Pi packages）把扩展、skill、提示模板、主题打成一个 npm 或 git 包，`pi install npm:…`；pi 本体、pi-ai、pi-agent-core、pi-tui、typebox 由宿主提供，扩展只能写成 `peerDependencies: "*"`（`[CA] docs/packages.md`）。有公开的包目录 pi.dev/packages（同上）。

### 4.2 SDK（`createAgentSession`）用法下怎么挂

- SDK 用法下扩展照样能用。文档原话：内联扩展工厂经 `DefaultResourceLoader` 提供（"Inline extension factories can be supplied through `DefaultResourceLoader`"，`[CA] docs/sdk.md:112`）。例子见 `[CA] examples/sdk/06-extensions.ts:26-37`：`new DefaultResourceLoader({ extensionFactories: [(pi) => { … }] })`，`await resourceLoader.reload()`，再传给 `createAgentSession({ resourceLoader })`。
- 也能用 `additionalExtensionPaths` 加载扩展文件；`noExtensions: true` 关掉目录发现（`[CA] docs/sdk.md:112`）。
- CLI 默认带的 codemode、tool_search、MCP 三个内置扩展，SDK 会话**不**自动加载，要自己放进 `extensionFactories`（`[CA] docs/sdk.md:116`）。
- 宿主可以用 `session.bindExtensions({ uiContext, mode, commandContextActions, abortHandler, shutdownHandler, onError })` 给扩展接上自己的界面实现和错误回调（`dist/core/agent-session.d.ts:159-166,748`）；不接时 `ctx.ui` 是一个什么都不做的空实现（`dist/core/extensions/runner.js:132,203`）。
- **二狗已经在这么用**：子进程里用 `DefaultResourceLoader({ noExtensions: true, extensionFactories, … })` 挂了四个内联扩展：守卫转发、重注入块、自定义压缩、范围审视（`packages/daemon/src/runtime/agent-child/session.ts:155-187`）。例如守卫转发在 `tool_call` 钩子里把调用送去守护进程判定（`guard-forwarding.ts:22-46`），范围审视在 `before_agent_start` 里往系统提示后面接一段（`scope-review.ts:170-175`）。守护进程代为执行的工具不走扩展，走 `customTools`（`session.ts` 里 `createAgentSession` 的 `customTools`；ADR-0004 "守护进程代为执行的工具"）。

### 4.3 扩展跑在哪个进程、能拿到什么、活多久

- **进程**：扩展跑在 pi 所在的进程里，权限相同。文档原话："An extension runs inside the Pi process with the same operating-system permissions."（`[CA] docs/extensions.md:5`）在二狗里就是每个 agent 的子进程（ADR-0002、0004），不是守护进程。
- **能拿到的**（`ExtensionContext`，`types.d.ts:213-250`）：工作目录、运行模式、`ui`、只读的会话管理器（整棵会话树）、模型注册表（可以自己发模型调用）、当前模型和思考档位、中止信号、上下文用量、触发压缩、当前系统提示。命令处理器另外能等空闲、重载、导航会话树、换会话（`types.d.ts:286-300`；文档说这些只能在命令里用，在事件处理器里调会死锁，`docs/extensions.md:214-215`）。
- **拿不到的**【推测，由进程边界推出】：别的 agent 的会话、二狗守护进程里的 SQLite 事件日志、网页前端。要用只能经二狗自己的宿主协议去问守护进程（现在的守卫转发、代为执行的工具就是这么做的）。
- **活多久**：
  - 扩展运行时归一个 `AgentSession` 所有（"The session owns one conversation, its model and tools, queued messages, compaction state, and extension runtime."，`[CA] docs/sdk.md:28`）。`session.dispose()` 让扩展上下文失效、去掉监听（`docs/sdk.md:56`）。
  - 重载会**整个**换掉扩展运行时，旧状态不能再用（`docs/extensions.md:50`）。
  - 文档要求：工厂函数里不要起进程、socket、watcher、计时器；长期资源在 `session_start` 里起，在幂等的 `session_shutdown` 里收（`docs/extensions.md:58-60,262-263`）。
  - 在二狗里，agent 子进程闲下来就退出（ADR-0002），所以扩展活的时间 = 这个 agent 子进程这一次活的时间。
- **卸载粒度**：
  - `pi.on()` 返回一个取消订阅的函数（`docs/extensions.md:97`）；MCP 服务可以 `unregisterMcpServer`（`docs/extensions.md:198-201`）。
  - 但**工具注册了就撤不掉**，只能用 `exposure: "hidden"` 重新注册一次把它藏起来（"tools cannot be unregistered"，`docs/extensions.md:160`）。
  - 没有"单独卸载一个扩展、把它注册的东西全部收回"的 API；要换只能整个重载。和 Cordis 的 Fiber 树相比，这是最大的差别。
- **出错**：处理器出错，pi 报告后尽量继续；`tool_call` 处理器出错就按"拦截"处理（fail-safe）（`docs/extensions.md:260`）。

### 4.4 界面

- `ctx.ui` 提供对话框（select / confirm / input / editor）、通知、状态栏文字、小部件、页眉页脚、自定义组件（`docs/extensions.md:244-246`；方法列表见 `types.d.ts` 的 `ExtensionUIContext`）。小部件、页眉页脚、自定义组件都是 pi-tui 的终端组件。
- RPC 模式只能转发对话框和通知，不能转发自定义终端组件；JSON 和 print 模式没有界面（`docs/extensions.md:248-251`）。
- 所以 **pi 的扩展没有"往网页里加页面或组件"的扩展点**。二狗的网页界面只能由二狗自己的插件机制管。宿主可以经 `bindExtensions({ uiContext })` 把扩展发起的 confirm / notify 之类转给二狗的网页（§4.2），但那是对话框级别的。

### 4.5 版本稳定性

- 1.0.4（2026-10-05）之后，npm 上又发了 1.1.0（10-07）、1.2.0（10-12）、1.3.0（10-15）（npm `@earendil-works/pi-coding-agent` 的 `time`）。十天三个小版本。
- 1.2.0 有一段 Breaking Changes，其中一条直接改了扩展接口：`before_agent_start` 现在也会在 `pi.sendMessage(…, { triggerTurn: true })` 起的回合里触发，`BeforeAgentStartEvent` 变成按 `messageType` 区分的联合类型，`"custom"` 那种没有 `prompt`；另一条改了"启动中算忙"，`pi.sendUserMessage()` 必须带 `deliverAs`（`[CA13] CHANGELOG.md` 1.2.0 节）。二狗的范围审视扩展就挂在 `before_agent_start` 上（§4.2），升级时要对照。
- 1.3.0 把 pi 内部包之间的依赖改成精确版本（"Pinned internal Pi dependencies to exact release versions"，`[CA13] CHANGELOG.md` 1.3.0 Fixed 节），ADR-0001 里靠 `overrides` 锁版本的那层负担会轻一点【推测】。
- 1.0.4 → 1.3.0 的 `docs/extensions.md` 只改了 `before_agent_start`、工具命名空间 `aliases`、`reachesTools` 三处（两版文件逐行对比）；`docs/sdk.md` 没变。扩展的整体形状这十天没变，但事件细节在变。

---

## 5. "给 pi agent 装一个记忆插件"这条路

前提：在二狗里，pi 扩展跑在每个 agent 的子进程里（§4.3），记忆的数据在守护进程的 SQLite 里（ADR-0001），子进程之间不直接通信（ADR-0002）。

### 5.1 记忆做成 pi 扩展，能做到的

| 想做的事 | pi 的接入点 | 说明 |
|---|---|---|
| 每轮往上下文里注入记忆简报 | `before_agent_start` 返回 `message` | 变成一条 `custom` 消息，排在用户消息后面，写进会话文件，模型看得到（`[CA] dist/core/agent-session.js:1597-1620`）。和 ADR-0001 定的"记忆简报作为消息追加在对话尾部、不动系统提示"一致 |
| 每次调模型前临时加一段 | `context` 事件 | 改的是这次请求的消息副本，不写进会话（`[CA] dist/core/extensions/runner.js:1006-1021`）。代价是会话文件里没有记录模型当时看到了什么 |
| 改系统提示 | `before_agent_start` 改分段或整段替换 | 在 `deepseek-flash` 上会折叠进开头的系统消息、打穿前缀缓存（调研 10 §4.9；ADR-0001"缓存"一条） |
| 提供 recall 工具 | `pi.registerTool()` | 工具在子进程里执行，数据要么子进程自己去读库，要么经宿主协议问守护进程 |
| 压缩之后重注入 | `session_compact` → `pi.sendMessage()` | 二狗的"重注入块"扩展已经这么做（`agent-child/session.ts:381-386`） |
| 观察对话、收集素材 | `message_end`、`tool_result`、`agent_settled` | 但守护进程本来就能从宿主协议的事件流里看到全部对话（ADR-0004），在子进程里再收一遍是重复的【推测】 |

### 5.2 做不到、或做起来别扭的

- **跨 agent 整理记忆**：扩展只看得到自己这个会话（`ExtensionContext` 只给自己的会话管理器，`types.d.ts:213-250`）。秘书、各维护者的素材要汇到一处整理，只能在守护进程里做。
- **做梦阶段**（夜间整理）：扩展活的时间就是这个 agent 子进程这一次活的时间，闲了就退出（§4.3、ADR-0002）。夜里没有对话时扩展根本不在。只能由守护进程的调度器去起（比如起一个记忆管理者的 agent 进程）。
- **记忆管理界面**：pi 扩展只有终端界面和对话框级别的 `ctx.ui`，没有往网页加页面的扩展点（§4.4）。
- **单一写者**：记忆是领域状态，在守护进程的事件日志里（ADR-0001）。几个子进程各自直接写库，就破坏了"状态只有一份、只在守护进程里"（ADR-0002 守卫一节的同一原则）【推测】。
- **记忆范围的强制**：哪个任务能看哪部分记忆，是用户在计划卡上授的（`CONTEXT.md`"记忆范围"）。判定放在子进程里的扩展里，等于让被约束的一方自己执行约束；按 ADR-0002 的思路应该放在守护进程【推测】。
- **跟着 pi 的版本走**：记忆的逻辑如果写在 pi 的事件上，pi 改事件就要跟着改（1.2.0 刚改过 `before_agent_start`，§4.5）；将来换底座（ADR-0001"换底座的代价"），这部分也要重写。
- **单个扩展不能单独卸载**（§4.3）：想"运行中关掉记忆功能"，只能重启这个 agent 子进程。二狗换工具包本来就是重启子进程接着会话（ADR-0018），所以这一条代价不大【推测】。

### 5.3 两种做法对照

| | A：记忆做成 pi 扩展（在 agent 子进程里） | B：记忆做成守护进程里的插件，经工具和上下文注入暴露给 agent |
|---|---|---|
| 数据和写入 | 要么子进程直接读写库，要么每次经宿主协议问守护进程 | 守护进程独占，和别的领域状态在一个事件日志里 |
| 每轮注入简报 | 扩展在 `before_agent_start` 里自己算或去问守护进程 | 守护进程收到用户输入时就算好，随输入一起交给子进程；子进程里一个通用的"上下文块"扩展把它变成 `custom` 消息【推测：宿主协议要加一个字段】 |
| recall 工具 | 扩展注册 | 守护进程代为执行的工具（二狗已经有这条通路：ADR-0004 的 `hostTools`；现成的例子是秘书的素材检索工具 `memory/search-tool.ts`） |
| 跨 agent 整理、做梦 | 做不到 | 守护进程的调度器 |
| 管理界面 | 做不到 | 守护进程的插件同时给网页加页面 |
| 卸载 / 停用 | 重启子进程 | 守护进程的插件机制决定（若照 Cordis，可以运行中卸载，§3.3） |
| 跟 pi 版本的耦合 | 高 | 只有通用的那层桥接扩展跟 pi 耦合 |
| 新增一种 agent 侧钩子的成本 | 低：直接用 pi 的事件 | 高：宿主协议要加消息类型，守护进程和子进程一起升版本（ADR-0004 的握手规矩） |
| 能不能复用 pi 社区的扩展包 | 能（pi.dev/packages） | 不能直接用 |

- dsh 没有这道选择题：它的 agent 循环和插件在同一个进程里，记忆之类的插件直接调 `agent.inject()` 往下一次请求里加上下文，并且记进会话日志（`DSH/docs/architecture.zh.md:159`）。二狗之所以要选，是因为 ADR-0002 定了每个 agent 一个子进程。

---

## 6. 对比：Cordis、pi、VS Code、Fastify、Backstage

VS Code、Fastify、Backstage 三部分由子 agent 读官方文档和源码回报（版本：vscode-docs @`ef0ca12`，各页 DateApproved 10/14/2026，VS Code 1.142.0；Fastify v5.12.7、fastify-plugin v6.0.1、avvio v9.3.1；Backstage master @`8747376`，2026-10-16）。本文抽查核对了"扩展不能碰 DOM""插件之间只能经网络通信""服务只有两种作用域""register 默认建新作用域"四处原文。

### 6.1 总表

| | Cordis（4.x）/ dsh | pi 扩展 | VS Code 扩展 | Fastify 插件 | Backstage |
|---|---|---|---|---|---|
| **往界面加东西** | 浏览器里另跑一个 Cordis 应用。Koishi / Cordis webui：`ctx.page`、`ctx.slot`、`ctx.settings`（Vue）；dsh：类型化插槽 `ctx.slots.register()`（React）。命令式，注册即副作用 | 只有终端界面：`ctx.ui` 对话框、状态栏、小部件、终端组件；没有网页扩展点 | 先在 `package.json` 的 `contributes` 里声明（命令、菜单、视图、视图容器、配置……），再用 TreeView / Webview API 填内容；**不给主界面 DOM** | 无界面 | 声明式的 extension 树：插件用 blueprint（如 `PageBlueprint`）生成 extension，挂到父 extension 的输入上；在 `app-config.yaml` 里启用、禁用、配置 |
| **往后台加服务** | `ctx.provide` / `Service` 子类登记成 `ctx.<名字>`；使用方 `inject` 声明 | `pi.registerTool`、`registerCommand`、`registerProvider`、`registerMcpServer`；扩展之间用 `pi.events` | 注册命令（跨扩展、跨宿主的通用通道）；`activate` 的返回值当 API 给别的扩展（只在同一个宿主里） | `decorate` / `decorateRequest`；`fastify-plugin` 打破封装，把装饰器暴露给父作用域 | service ref + service factory 依赖注入，作用域只有 root 和 plugin；插件开扩展点给模块用 |
| **依赖和顺序** | 声明 `inject`，依赖到齐才启动、没了自动停、换了重启（响应式） | 按加载和注册顺序；没有依赖声明 | `activationEvents` 懒激活；`extensionDependencies` 先激活依赖 | 注册顺序 + avvio 的树形加载；`dependencies` 只校验、不排序 | 依赖注入自动排序，启动时拒绝循环依赖；插件之间并行，模块先于插件 |
| **卸载和收回** | 每个注册是副作用，撤销函数记在插件的 Fiber 上；卸插件按依赖顺序撤（§3.3） | `pi.on` 返回取消函数；工具撤不掉；没有单扩展卸载，只能整个重载 | 返回 Disposable，推进 `context.subscriptions`；`deactivate()`；异步撤销"aren't awaited" | `onClose` 钩子，先子后父 | `lifecycle.addShutdownHook()` |
| **运行时卸载 / 热重载** | 支持单个插件运行时卸载、改配置、热重载（plugin-hmr） | 整个扩展运行时重载 | 卸载、禁用、更新要重启扩展宿主进程（窗口不动） | 不支持；启动后加路由、加装饰器都报错；只能整个实例重建（`@fastify/restartable`） | 不支持；前端改配置要刷新页面 |
| **隔离** | 同进程；`isolate` 只隔离服务命名空间 | 跑在 pi 所在进程里，权限相同 | 扩展跑在独立的扩展宿主进程（本地 Node、浏览器 WebWorker、远程）；宿主崩了界面不崩、会自动重启；同宿主内的扩展共用一个进程【推测：彼此不隔离】，没有权限沙箱 | 同进程；封装只隔离命名空间和钩子 | 同进程，可以拆成多个部署；启动失败可配成不致命；前端每个 extension 有错误边界 |
| **当前版本** | cordis 4.0.0-rc.11（2026-10-14）；dsh 0.2.1-rc.2 | 1.3.0（2026-10-15），二狗锁 1.0.4 | VS Code 1.142.0（2026-10-14） | 5.12.7（2026-10-13） | v1.55.3；后端系统 1.x 稳定，前端系统 1.0 RC（`frontend-plugin-api` 0.18.1） |

### 6.2 每种做法里值得注意的点

- **VS Code**：
  - 不给扩展 DOM 是有意的取舍。原文："Extensions have no access to the DOM of VS Code UI"；理由是扩展跑在扩展宿主进程里，VS Code 才能改自己的 DOM 而"without breaking existing extensions"（vscode-docs `api/extension-capabilities/overview.md:123-125`）。
  - 1.74 起，贡献点里声明的命令、视图、语言等不用再写对应的激活事件，VS Code 自动推导（`api/references/activation-events.md`）。
  - 扩展宿主 5 分钟内崩 3 次就不再自动重启（子 agent 读 VS Code 1.142.0 `nativeExtensionService.ts`）。
- **Fastify**：
  - `register` 默认建一个新作用域，改动只影响后代、不影响祖先（`fastify docs/Reference/Plugins.md:8`）。这是"插件之间默认互不可见"的最小实现。
  - `decorate` 是同步的；异步初始化要用 `register` 加 `fastify-plugin`（`docs/Reference/Decorators.md`）。
  - 插件加载有超时，`pluginTimeout` 默认 10000 ms（`docs/Reference/Server.md`）。
- **Backstage**：
  - 后端官方原话："It is an implementation of dependency injection, where each backend instance is the dependency injection container"（`docs/backend-system/architecture/03-services.md:10`）。
  - 插件之间禁止代码级依赖："Plugins must never communicate with each other directly through code, they may only communicate over the network"（`04-plugins.md:80`）。
  - 前后端插件成对出现（`plugin-x` / `plugin-x-backend`，共享类型放 `-common`），前端经 `discoveryApi` 找到后端的 `/api/<pluginId>`，走 HTTP（`plugins/catalog/src/alpha/apis.tsx:34-45`）。
  - 前端插件默认在构建时打进应用（`app.packages: all`，依赖 webpack）；运行时加载（Module Federation）还是实验性的（`docs/frontend-system/building-apps/05-installing-plugins.md`、`07-module-federation.md`）。

### 6.3 "往界面加东西"和"往后台加服务"的几种基本形状

- **声明式贡献 + 宿主接线**（VS Code、Backstage 前端）：插件先用数据声明"我要一个命令、一个视图、一个页面"，宿主决定放在哪、什么时候激活。宿主能在不运行插件代码的情况下知道它贡献了什么（懒激活、配置开关都靠这一点）。
- **命令式注册 + 撤销函数**（Cordis、dsh、Koishi 控制台、pi）：插件在运行时调 `ctx.xxx()` 注册，注册即副作用。灵活，能运行时卸载（Cordis），但宿主要等插件跑起来才知道它贡献了什么。dsh 用 `package.json` 里的 `dsh.client` 声明补上了"不运行就知道有没有浏览器半边"这一块（§3.7.2）。
- **依赖注入容器**（Backstage 后端、Cordis 的 `inject`）：服务按接口登记，使用方声明依赖，容器排顺序。Backstage 是启动时一次性排好、之后不变；Cordis 是运行时持续响应。
- **封装作用域**（Fastify、Cordis 的 `isolate`）：插件默认只影响自己和后代。
- **进程隔离**（VS Code 扩展宿主；二狗的 agent 子进程也是这一类）：换来故障隔离，代价是跨进程只能走消息或命令，拿不到对方的对象。

---

## 7. 没核实、没查到的

- 【未核实】论文作者 Yifan Shi 是不是 Cordis 作者 Shigma 本人。已知的只有：Shigma 的 GitHub 资料写 company `@deepseek-ai`，论文署名有 DeepSeek-AI（§2.1）。
- 【未核实】dsh 的"自我扩展"（agent 自己写组合包、热加载）只按子 agent 读文档的回报写，本文没逐行核对（§2.2）。
- 【未核实】Koishi 市场 4766 个包、一年内有更新 1891 个的数字由子 agent 取得；本文从本机复取市场索引失败（返回空），没能复算（§3.6）。
- 【未核实】Cordis 4.x 核心里有没有"可选依赖"的写法：在 `packages/core/src` 里没找到；Koishi 文档里的 `inject: { optional: [...] }` 是 3.x 的写法（§3.1）。
- 【未核实】cordis#124（NodeNext 类型导入失败）的修复是否已进 4.0.0-rc.11（§3.6）。
- 【未核实】Backstage 新前端系统是否已宣布正式 1.0：到 v1.55 的发布说明里只看到 1.0 RC（§6.1）。
- 【未核实】VS Code 同一扩展宿主里一个扩展死循环会不会拖住其他扩展：官方文档没有原话，按同进程推断（§6.1 隔离一行）。
- 没有实测：本文没有在二狗里跑过 Cordis，也没有在 pi SDK 下写探针验证 `before_agent_start` 的 `message` 注入；结论来自源码和文档。
- 二手资料：dsh 的 star 数在新闻里互相矛盾，本文只用 GitHub API 的数（§2.1）。

---

## 8. 对二狗的启示【建议】

只列从上面几节得出、对"二狗插件化"设计有用的要点，不替用户定整体方案。

### 8.1 先分清两层：Cordis 管不到进程边界

1. **插件化要分"守护进程这一层"和"agent 子进程这一层"来设计。**
   - Cordis 的上下文、服务、副作用都在一个进程里（§3.2、§3.3）；dsh 的主 agent 也跑在宿主进程里，进程外的子 agent 是经子进程和协议接的（§2.2）。
   - 二狗是每个 agent 一个子进程（ADR-0002）。所以就算用 Cordis，它也只能管守护进程（和网页）里的插件；到子进程那一侧，还是要经宿主协议。
2. **"给 pi agent 装一个插件"适合做薄的、通用的桥接，不适合装功能本身。**
   - pi 扩展跑在子进程里、跟着子进程生灭、不能单独卸载、工具注册了撤不掉、没有网页扩展点（§4.3、§4.4）。
   - 记忆的跨 agent 整理、做梦、管理界面、记忆范围的强制，都做不到或不该在子进程里做（§5.2）。
   - 二狗现在的四个内联扩展（守卫转发、重注入块、压缩、范围审视）已经是"逻辑在守护进程、子进程里只转手"的形状（§4.2）。照这个形状，功能插件放在守护进程，子进程里保留少数通用扩展，把守护进程下发的"本轮上下文块""工具""钩子判定"翻译成 pi 的调用。
3. **代价要算进去：每加一种 agent 侧钩子，宿主协议就要升版本**（§5.3）。可以考虑一次性把协议做成"通用贡献"的形状（工具清单、上下文块、钩子订阅都当数据传），让新插件不必每次改协议。这和 VS Code 的贡献点"先声明、宿主按声明接线"是同一个思路（§6）。

### 8.2 守护进程这一层：可以借 Cordis 的哪些规矩

4. **最该借的一条：每次注册都返回撤销函数，并记在注册它的插件名下；卸插件就是按记录倒着撤。**
   - 这是 Cordis 能保证"卸干净"的唯一机制（§3.3），dsh 的入门文档也把它列为实践规则："每个注册都应有对应的 disposer"（`DSH/docs/cordis-primer.zh.md:47-51`）。
   - 二狗现在的组合根（composition root）`packages/daemon/src/daemon.ts` 有 38 处手写的 `teardown.push(...)`，还有好几个注册表（卡片类型、快速动作、素材来源、彻底删除的改写函数）只有 `register`、由组合根统一接线（`daemon.ts:453-847`）。要让一个功能能单独启停，这些注册表都得能按插件撤销。
5. **依赖靠声明、到齐才启动，可以替掉手写的晚绑定。**
   - `daemon.ts:500-516` 用一个 `wiring` 对象加 `wired("taskExecution")` 解决模块之间的循环引用和先后顺序。Cordis 的做法是插件声明 `inject`，依赖到齐才运行、依赖没了自动停（§3.2）。
   - 要注意 4.x 里 `inject` 列的全部是必需的。dsh 的 AgentLoop 就故意不把持久化服务写进 `inject`，"注入它会导致非持久化的演示永远挂起"，改用 `ctx.get()` 按需取（`DSH/docs/postmortem/0001-acp-default-export-drops-inject.zh.md`）。二狗如果借这套，可选依赖要有明确写法。
6. **服务被替换时依赖方会被重启**（§3.2）。对二狗来说，"记忆服务换了实现"会连带重启所有依赖它的插件；如果某个插件持有正在进行的 agent 回合或等待中的审批，重启就要能接得上（ADR-0018 的"做完手头这一步再换"是现成的思路）【推测】。
7. **卸载要等到真正停稳**：Cordis 先等依赖方卸完再撤自己（§3.3）；dsh 另外规定"发出终止或中止信号后，应等待子进程退出"（`DSH/docs/defensive-patterns/general.zh.md:216-222`）。二狗的插件如果拥有子进程（MCP 服务、agent 子进程），卸载函数要等进程真正退出，和 Job 对象的清理（ADR-0002、0018）对齐。

### 8.3 用不用 Cordis 本身：几条要摆上桌的事实

8. **成熟度**：4.x 还是 rc，README 写着 API 不稳定（§3.1）；Koishi 和它的插件市场还在 3.x（§3.1、§3.6），3.x 和 4.x 的核心名词不同，Koishi 的文档和插件不能直接拿来参考 4.x。
9. **最大的用户是 vendor 加补丁**：dsh 把 Cordis 源码复制进仓库，记了 24 条本地改动，其中包括 Fiber 生命周期的三个重入卸载漏洞（§2.2）。如果二狗用 Cordis，也要预期"锁版本、可能要自己补"，这和 ADR-0001 对 pi 的版本策略是同一类负担。
10. **文档**：官方文档还在建，现成最完整的中文资料在 dsh 的文档站（入门、七章教程、API 目录）（§2.1、§3.6）。
11. **Windows**：上游最近一个提交才修好热重载对 Windows 盘符路径的处理（§3.5），dsh 的 vendor 记录第 9 条改了热重载的路径比较，为的是"Windows short-name paths and filesystem aliases"下模块缓存身份一致，第 14 条给配置文件写入加了 `EACCES` / `EBUSY` / `EPERM` 重试（`DSH/vendor/README.md:43,48`）。二狗跑在 Windows 上，要预期这类问题。
12. **测试**：dsh 的复盘 0001 是 178 个单元测试、100% 行覆盖，上线即崩，因为测试都手动 `ctx.plugin({...})` 挂插件，没走真实的加载器（`DSH/docs/postmortem/0001-…zh.md`"为什么所有测试都没有捕获"）。不管用不用 Cordis，插件化之后都要有"走真实装配路径"的测试。

### 8.4 网页这一层

13. **一个插件包同时带后台半边和网页半边，是 dsh 和 Koishi 的共同做法。**
   - dsh：一个 npm 包导出 `.`（宿主插件）和 `./client`（浏览器半边），在 `package.json` 里用 `dsh.client` 声明；宿主扫描已启用的插件、把浏览器半边以合并脚本送到页面；宿主那一行关掉，它注册的页面也随之消失（`DSH/docs/cookbook/adding-a-settings-card.zh.md` 第 5 节、`docs/subsystems/client-modules.zh.md:94`）。
   - Koishi 控制台的插件也是一个包里同时放服务端入口和客户端入口（`addEntry({ dev, prod })`，§3.7.1）。
   - Backstage 则拆成两个包（`plugin-x` / `plugin-x-backend`），经 HTTP 通信（§6.2）。
   - 对二狗：记忆插件 = 守护进程里的记忆服务 + 网页里的记忆管理页，一起启停。
14. **网页里用"类型化插槽"而不是让插件互相 import 组件。**
   - dsh 的网页是浏览器里的另一个 Cordis 应用，React 渲染；插槽表 `SlotMap` 靠声明合并扩展；功能插件 `ctx.slots.register()` 往别人声明的插槽里放组件，"绝不导入其他功能插件的组件"；注册随 Cordis 副作用撤销（`DSH/docs/subsystems/slots.zh.md:5,15-21`）。
   - 二狗的网页也是 React，现在页面是 `App.tsx:250-277` 里按路由 `switch` 写死的。插槽这一层可以不依赖 Cordis 单独做。
15. **网页插件是构建时打包还是运行时加载，要单独定。** dsh 是运行时由宿主拼脚本下发（§3.7.2），Backstage 默认是构建时打进应用（§6）。二狗的网页由守护进程提供，鸿蒙 App 也加载守护进程的页面（ADR-0022）；运行时加载要多管一套模块加载、缓存版本和热更新，构建时打包则每加一个插件要重新构建网页【推测】。

### 8.5 事件溯源这一层

16. **插件拥有自己的事件类型和投影，是 dsh 的现成先例。** dsh 的会话日志只追加、是唯一真源；"新增模型可见输入需要会话事件"；领域插件扩展 `SessionEventMap`、注册纯同步的投影单元，框架把每个已提交事件折叠进去（`DSH/docs/architecture.zh.md:122-130,162`、`docs/subsystems/session-projection.zh.md:5`）。
   - 二狗的事件日志在 SQLite 里，"彻底删除的改写函数表"已经是"拥有一类事件的模块登记自己的改写函数"（`daemon.ts:517-520` 的注释）。插件化时可以让每个插件同时登记：它拥有的事件类型、投影、改写函数、素材来源。
   - 卸载插件时，它写过的事件还在日志里。投影可以撤，事件不能撤；插件停用后这些事件谁来解释、要不要还能被彻底删除，需要先想清楚【推测】。
17. **"模型可见即已记录"**（dsh 的规则，`architecture.zh.md:128`）和二狗"记忆简报作为消息追加在对话尾部"一致；如果记忆注入改用 pi 的 `context` 事件（只对单次请求生效、不落盘，§5.1），就会违反这条。

---

## 9. 来源

**DeepSeek Harness**

- 仓库：https://github.com/deepseek-ai/deepseek-harness ，master，commit `687f282e8625c6b8d11ff58211a90524be2e4317`（2026-10-17，`dsh-v0.2.1-rc.2` 的合并提交）。读过：`README.md`、`vendor/README.md`、`vendor/cordis-rc11-upgrade-plan.md`、`docs/architecture.zh.md`、`docs/cordis-primer.zh.md`、`docs/subsystems/{client-modules,web-client,slots,session-projection,persistence,subprocess,subagent,scope}.zh.md`、`docs/cookbook/adding-a-settings-card.zh.md`、`docs/postmortem/0001-acp-default-export-drops-inject.zh.md`、`docs/defensive-patterns/general.zh.md`、`packages/client/README.zh.md`、`packages/subagent/README.zh.md`、`packages/core/agent-loop/src/index.ts`
- GitHub API：https://api.github.com/repos/deepseek-ai/deepseek-harness （2026-10-17 查询：建库 2026-08-13，MIT，251590 star，30253 fork）
- npm `@deepseek-ai/dsh`：https://registry.npmjs.org/@deepseek-ai/dsh （首版 0.0.1-rc.1，2026-08-10；latest 0.2.0-rc.2，2026-09-29；next 0.2.1-rc.2，2026-10-17；依赖 `@deepseek-ai/cordis ~4.0.5`）
- 文档站：https://deepseek-harness.github.io/deepseek-harness/ ，Cordis 入门页 https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer
- Shigma 的 GitHub 资料：https://api.github.com/users/shigma （2026-10-17 查询）

**Cordis**

- 仓库：https://github.com/cordiverse/cordis ，main，commit `df4431eb43086bd1f8263a0e8c03e9b7c5233b68`（2026-10-16，"fix(hmr): accept a drive-letter path for `base` (#208)"）。读过 `packages/core/src/*.ts`、`packages/core/tests/{service,dispose,service-dispose,fiber}.spec.ts`、`packages/core/bin.js`、`packages/core/README.md`、`packages/{loader,include,hmr,timer}/src/` 的相关文件
- npm `cordis`：https://registry.npmjs.org/cordis （latest 4.0.0-rc.11，2026-10-14；next 4.0.0-beta.5，2025-06-01；3.18.1，2024-09-17）
- npm `@cordisjs/core@3.18.1`（发布包 `src/`）：https://registry.npmjs.org/@cordisjs/core/3.18.1
- npm `@cordisjs/plugin-loader`（1.0.0-rc.8）、`@cordisjs/plugin-hmr`（1.1.1）、`@cordisjs/plugin-timer`（1.1.4），均 2026-10-14
- npm `schemastery@3.18.0`（2026-03-09，发布包 `src/index.ts`）
- npm `@koishijs/core@4.18.11`（2026-02-27）的依赖：https://registry.npmjs.org/@koishijs/core/latest
- 论文：Yifan Shi, Wei Zhang, Tianyi Cui. *A Programming Paradigm for Spatiotemporal Composability*. arXiv:2608.25512 [cs.PL]，v1 2026-08-26：https://arxiv.org/abs/2608.25512

**Koishi 控制台、Cordis webui 与生态数据**（子 agent 读取，2026-10-17）

- koishijs/webui：https://github.com/koishijs/webui ，commit `1dc5c0e1c76a207c2ec48697d4b56364cfe28dce`（2026-10-08）
- cordiverse/webui：https://github.com/cordiverse/webui ，commit `2a884b56e589d81c41e510922e6b9f12badef26a`（2026-06-06）
- koishijs/koishi：https://github.com/koishijs/koishi ，commit `97d5c395750cec37b772e0b94dc63c427e3bb868`（2026-10-08）
- cordiverse/cli：https://github.com/cordiverse/cli ，commit `0238a8fde277a50f9bc99ed5d398b6596c6b6004`（2026-05-12）
- koishijs/docs：https://github.com/koishijs/docs ，commit `8d257bbbd369dd3d3821f6c3030f53fe4915a3ef`；cordiverse/docs：commit `04b38dd925792e7ff0678bbe27ff30744ad57641`（2025-04-01）
- 市场索引：https://registry.koishi.chat/index.json （10:59 GMT）；https://registry.cordis.io/index.json （与 cordiverse/registry release 分支 `d92e70c941235fc13225de113a96bda55a659f42` 一致）
- npm：`@koishijs/console`、`@koishijs/plugin-console`、`@koishijs/client` 5.30.11；`@cordisjs/plugin-webui`、`@cordisjs/client` 0.8.2；`@koishijs/plugin-hmr` 1.2.9
- GitHub REST API：`/repos`、`/commits?since=2025-10-17`、`/contributors`、`search/issues`
- Issue / PR（本文 2026-10-17 复查状态）：cordiverse/cordis [#66](https://github.com/cordiverse/cordis/pull/66)（开）、[#96](https://github.com/cordiverse/cordis/pull/96)（开）、[#124](https://github.com/cordiverse/cordis/issues/124)（2026-10-14 关）、[#127](https://github.com/cordiverse/cordis/issues/127)（2026-10-15 关）、[#154](https://github.com/cordiverse/cordis/issues/154)（开）、[#185](https://github.com/cordiverse/cordis/pull/185)（开）、[#194](https://github.com/cordiverse/cordis/issues/194)（开）；koishijs/koishi [#1215](https://github.com/koishijs/koishi/issues/1215)、[#1504](https://github.com/koishijs/koishi/issues/1504)

**pi**

- `@earendil-works/pi-coding-agent@1.0.4`（本仓库 `node_modules`，与根 `package.json:35` 锁定的版本一致）：`docs/extensions.md`、`docs/sdk.md`、`docs/packages.md`、`dist/core/extensions/types.d.ts`、`dist/core/extensions/runner.js`、`dist/core/agent-session.d.ts`、`dist/core/agent-session.js`、`examples/sdk/06-extensions.ts`、`examples/extensions/{event-bus,reload-runtime}.ts`
- `@earendil-works/pi-coding-agent@1.3.0`（2026-10-15，npm 发布包）：`CHANGELOG.md`（1.1.0–1.3.0 节）、`docs/extensions.md`、`docs/sdk.md`
- npm 版本时间：https://registry.npmjs.org/@earendil-works/pi-coding-agent （1.0.4 2026-10-05；1.1.0 10-07；1.2.0 10-12；1.3.0 10-15）
- 源码类型文件链接（文档里引用）：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts

**VS Code**（子 agent 读取；`<D>` = https://github.com/microsoft/vscode-docs/blob/ef0ca127806a0e7eb9cd9e39e1d71c05e0a5769b ，各页 DateApproved 10/14/2026）

- `<D>/api/references/contribution-points.md`、`<D>/api/references/activation-events.md`、`<D>/api/advanced-topics/extension-host.md`、`<D>/api/extension-capabilities/overview.md`、`<D>/api/get-started/extension-anatomy.md`、`<D>/api/advanced-topics/remote-extensions.md`、`<D>/api/references/extension-manifest.md`、`<D>/api/extension-guides/{webview,tree-view,command}.md`、`<D>/docs/configure/extensions/{extension-marketplace,extension-runtime-security}.md`、`<D>/api/language-extensions/language-server-extension-guide.md`
- VS Code 1.142.0（2026-10-14）源码：`src/vscode-dts/vscode.d.ts`、`src/vs/workbench/api/common/extHostExtensionActivator.ts`、`src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts`；发布页 https://github.com/microsoft/vscode/releases/tag/1.142.0
- npm `@types/vscode` 1.140.0（2026-10-01）

**Fastify**（子 agent 读取；`<F>` = https://github.com/fastify/fastify/blob/v5.12.7 ）

- `<F>/docs/Reference/{Plugins,Encapsulation,Decorators,Hooks,Server,LTS,Errors}.md`、`<F>/docs/Guides/Plugins-Guide.md`、`<F>/lib/{plugin-utils,route}.js`
- fastify-plugin v6.0.1 README：https://github.com/fastify/fastify-plugin/blob/v6.0.1/README.md ；avvio v9.3.1 README：https://github.com/fastify/avvio/blob/v9.3.1/README.md ；`@fastify/restartable` 3.0.4
- npm：fastify 5.12.7（2026-10-13）、fastify-plugin 6.0.1（2026-10-10）、avvio 9.3.1（2026-10-10）

**Backstage**（子 agent 读取；`<B>` = https://github.com/backstage/backstage/blob/8747376ceeb8c46d34549c53cdf6b81bb5de70f9 ，2026-10-16）

- 后端：`<B>/docs/backend-system/architecture/{01-index,02-backends,03-services,04-plugins,05-extension-points,06-modules}.md`、`<B>/docs/backend-system/core-services/{lifecycle,http-router}.md`、`<B>/docs/backend-system/building-backends/01-index.md`、`<B>/packages/backend-app-api/src/wiring/BackendInitializer.ts`、`<B>/docs/plugins/new-backend-system.md`
- 前端：`<B>/docs/frontend-system/` 下 `index.md`、`architecture/{00-index,10-app,15-plugins,20-extensions,33-utility-apis}.md`、`building-apps/{02-configuring-extensions,05-installing-plugins,07-module-federation}.md`、`building-plugins/03-common-extension-blueprints.md`；`<B>/packages/frontend-plugin-api/CHANGELOG.md`；`<B>/packages/{frontend-dynamic-feature-loader,backend-dynamic-feature-service}/README.md`
- 其他：`<B>/docs/overview/architecture-overview.md`、`<B>/plugins/catalog/src/alpha/apis.tsx`、`<B>/docs/releases/{v1.31.0,v1.49.0}.md`；发布页 v1.55.0、v1.55.3
- npm：`@backstage/backend-plugin-api` 1.10.1、`@backstage/frontend-plugin-api` 0.18.1（2026-09-15）

**本仓库**

- ADR-0001、0002、0004、0018；`CONTEXT.md`（记忆、记忆范围、记忆简报）
- `packages/daemon/src/runtime/agent-child/{session,guard-forwarding,scope-review}.ts`
- `packages/daemon/src/daemon.ts`（组合根：注册表、`wired()`、`teardown.push`）
- `packages/daemon/src/memory/{index,search-tool}.ts`
- `packages/web/src/App.tsx`
- 调研 [03](03-openclaw-and-pi.md)、[10](10-pi-layer-mapping.md)
