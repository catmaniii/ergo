**中文** | [English](developer-guide.en.md)

# 二狗开发者指南

给想读代码、改代码、写插件的人。怎么装、怎么用见[用户手册](user-guide.md)；怎么提交改动见 [CONTRIBUTING](../CONTRIBUTING.md)。

- **术语**以 [CONTEXT.md](../CONTEXT.md) 为准（秘书、任务、项目、维护者、守卫、时间线……），代码、界面、文档用同一套词。
- **为什么这么做**记在[架构决策记录](adr/)（ADR）里，下文按编号引用。
- **代码注释里的"N 号票"**是开发时的内部记录编号，公开仓库里没有这些票；注释本身已经写清了做什么、为什么。

## 目录

1. [前提](#1-前提)
2. [常用命令](#2-常用命令)
3. [仓库里有什么](#3-仓库里有什么)
4. [架构](#4-架构)
5. [插件](#5-插件)
6. [网页](#6-网页)
7. [多语言](#7-多语言)
8. [鸿蒙 App](#8-鸿蒙-app)
9. [写代码的约定](#9-写代码的约定)
10. [测试](#10-测试)
11. [升级 pi](#11-升级-pi)
12. [从 ergou 迁到 ergo](#12-从-ergou-迁到-ergo)
13. [文档、CHANGELOG、设计记录](#13-文档changelog设计记录)

---

## 1. 前提

- **Windows 10 / 11**。Job 对象、目录联接、Windows 沙箱、计划任务只有 Windows 有；靠它们的测试在别的系统上跳过，守护进程在别的系统上不启动。
- **Node 22**（≥ 22.19）。**Node 大版本跟着 pi 走**（[ADR-0031](adr/0031-node-version-follows-pi.md)）：pi 的自动测试和安装脚本用哪个大版本，二狗打包、运行、测试就用哪个；pi 升级我们跟着升，pi 不升我们照旧。源码是 TypeScript，靠 Node 自带的类型剥离直接运行，守护进程没有构建步骤。
- **Git for Windows（Git Bash）**：pi 的 `bash` 工具和一批集成测试要靠它。`where bash` 的第一条应该是 `C:\Program Files\Git\bin\bash.exe`；如果只有 `C:\Windows\System32\bash.exe`（WSL 的幌子，跑不起来），先把 Git 的 bin 前插到 PATH：PowerShell 里 `$env:PATH = "C:\Program Files\Git\bin;" + $env:PATH`。没有 Git Bash 时，靠 bash 的用例会明确跳过或在超时错误里说明，不是功能坏了。
- **依赖的安装脚本**：根 `package.json` 的 `allowScripts` 把现有的几个（esbuild、koffi、onnxruntime-node、protobufjs、@google/genai）都标成不跑——原生文件都是现成的。新加带安装脚本的依赖时，核过要不要跑再记进去。Node 22 带的 npm 10 不认这个字段，照旧跑。
- **不要在开发机上直接起常驻服务**：二狗的服务由服务管家登记、启动（见[用户手册](user-guide.md#23-从源码安装现在就能用)）。测试里起的守护进程实例和子进程是测试的一部分，测试结束时销毁。

## 2. 常用命令

都在仓库根目录跑：

| 做什么 | 命令 |
|---|---|
| 装依赖 | `npm ci` |
| 改完代码先跑这条：快车道（除主切面、契约测试外的全部单测 + 网页状态层 / UI / 构建检查） | `npm run test:fast`（约 2 分钟） |
| 主切面（真的拉起守护进程和 agent 子进程）+ 真浏览器打开页面 | `npm run test:integration`（十几分钟） |
| 全量（快车道 + 主切面 + pi 契约测试） | `npm test`（约 35 分钟；Windows 上建议 `$env:ERGO_TEST_WORKERS=2`） |
| pi 契约测试（升级 pi、改 `agent-host/`、`runtime/`、提示词装配时才跑） | `npm run test:contract` |
| 服务管家的测试（`node --test`，不在 vitest 里） | `npm run test:supervisor` |
| 单个包、单个文件、按名字挑 | `npm test -w @ergo/daemon`；`npx vitest run packages/daemon/test/agent-process.test.ts`；`npx vitest run --project daemon -t "中止"` |
| 类型检查 | `npm run typecheck` |
| lint | `npm run lint`（oxlint，配置在 `.oxlintrc.json`） |
| 收尾全套 | `npm run check`（类型检查 + lint + 全量 + 服务管家） |
| 多语言检查 | `npm run i18n:check`（[第 7 节](#7-多语言)） |
| 构建网页 | `npm run build:web`（产物是单个文件 `packages/web/dist/index.html`） |
| 构建在线演示页 | `npm run build:demo`（产物在 `packages/web/dist-demo/`，[6.1](#61-页面从哪里来原型和在线演示页)） |
| 部署后打开真的页面看一眼 | `npm run smoke:page`（无头 Chrome 打开 `http://127.0.0.1:8810/`，`-- <地址>` 换地址） |
| 构建鸿蒙 App | `npm run build:harmony`（[第 8 节](#8-鸿蒙-app)） |
| 下载向量模型 | `npm run download-model` |
| 马上备份一次 | `npm run backup` |
| 部署 VPS 公网入口的 nginx 站点 | `npm run deploy:nginx`（`-- --print` 只打印） |
| 检查项目服务的页面守不守前缀约定 | `npm run check:app-prefix -- <服务地址> --name <应用名>`（[4.8](#48-转发本机服务的页面)） |

## 3. 仓库里有什么

### 3.1 包和目录

```
packages/
  protocol/    @ergo/protocol    守护进程和前端共用的协议：帧、频道事件、消息、卡片（TypeBox）；多语言运行时和语言文件
  daemon/      @ergo/daemon      守护进程：管家，拉起和管理 agent 子进程；事件存储、网关、守卫、任务、插件宿主
  web/         @ergo/web         网页：React 19 + Vite，手写 CSS；自带编的数据的原型
  memory/      @ergo/memory      记忆引擎：证据、知识图谱、推理图谱、混合检索、每晚整理、唯一写入口
  supervisor/  @ergo/supervisor  服务管家（命令 lsm）：单独的小进程，托管常驻服务、开机自启、看门狗、隧道
frontend/
  harmony/     鸿蒙 App：DevEco 工程，原生壳加载二狗的网页
config/        配置样例（ergo.example.json、watch-categories.example.json、mcp.example.json）
deploy/lsm/    服务管家条目的样例（ergo-daemon、ergo-tunnel、ergo-asr）
docs/          用户手册、开发者指南、ADR、记忆系统、调研、指南
```

npm workspaces 管这几个包。`frontend/` 不是 workspace（鸿蒙工程的 ArkTS 不归根目录的 tsc、oxlint、vitest 管，由 hvigor 编译时查）。

### 3.2 守护进程的模块（`packages/daemon/src/`）

| 目录 / 文件 | 是什么 |
|---|---|
| `main.ts`、`preflight.ts`、`stop.ts` | 入口：先做起动前检查（只支持 Windows、Node 版本），再加载组合根；`stop.ts` 是服务管家的 stop 钩子（核对 pid 文件才结束进程） |
| `daemon.ts` | **组合根**：读配置、开事件存储、建 Job 对象、立起各模块、按插件清单装插件、开两个端口；停止和启动失败共用一份倒着收拾的清单 |
| `config/` | 配置（只读）、数据目录各区的路径（`dataDirLayout()`，模块只从这里取路径）、密钥从哪个环境变量取 |
| `storage/` | SQLite 的薄接口：所有数据库访问都经它，换驱动只改这一处 |
| `events/` | **事件存储**：事件日志是唯一真相（`ergo.db`，WAL），派生视图从它投影 |
| `gateway/`、`pairing/` | 网关的两个端口、HTTP 接口、WebSocket；设备配对和凭证 |
| `guard/`、`guard-runtime/`、`approvals/`、`hand-over/` | **守卫**：纯函数判定（`judgeToolCall`）；接入运行时（现取环境事实、审批卡、效果日志、"交给我做"） |
| `agent-manager/`、`agent-host/`、`runtime/`、`process/` | 拉起 agent 子进程（装配参数、注入环境、放进 Job、资源限制）；三种维护者的宿主；运行时封装层（pi 只在 `runtime/agent-child/` 里）；进程工具 |
| `secretary/`、`maintainers/`、`conversation/` | 秘书（常驻子进程）、维护者的唤起、会话（派生视图、输入队列、回退和分支） |
| `tasks/`、`sub-agents/`、`scheduled-jobs/`、`event-sources/`、`recovery/` | 任务（计划、执行、阶段验收、偏离和阈值、流程）、子 agent 并行、定时和事件触发、被杀后的恢复 |
| `projects/`、`work-orders/`、`operations/`、`project-ops/`、`project-services/`、`scope-review/` | **项目系统**：档案和规范、工单派单、运营方案和运营接口、项目服务（经服务管家托管）、范围审视。外面只能引 `projects/api.ts` |
| `cards/`、`inbox/`、`board/`、`activity/`、`ledger/` | 卡片类型和按钮闭环、待我处理、秘书眼里的看板、活动状态、token 账本 |
| `plugins/`、`deletion/`、`data-sources/`、`components/` | 插件宿主、删除参与方登记表、数据源和共用导入文件夹、按需下载的组件和下载器 |
| `materials/`、`memory/`、`quick-actions/` | 素材库（原话副本、关键词和向量索引）、记忆插件（每晚整理、记忆管理员、访谈）、快速动作 |
| `reminders/`、`calendar/`、`voice/`、`browsing/`、`claude-code/`、`google/`、`looki/`、`phone/` | 各个插件（每个目录里有 `plugin.ts`，别的模块只从它的 `api.ts` 取东西） |
| `scheduler/`、`workday/`、`backup/` | 调度器和可注入的时钟、内部作业；个人工作日历和节假日；备份、校验、恢复 |
| `web/`、`typed-shell/`、`skills/`、`mcp/`、`toolkit/`、`apps/` | 联网工具、带类型的 bash 工具（git、构建……）、skill 库、MCP 登记、工具包、转发本机服务的页面 |
| `prompts/`、`agent-settings/`、`model-settings/`、`assistant/`、`agent-roles/`、`i18n/` | 系统提示（md 文件，用户能改）、每个 agent 的 ⚙、模型设置、助理的名字、角色、多语言 |
| `lsm/` | 接入服务管家的 link 协议（报健康和忙不忙、优雅停机、名下的服务） |
| `deploy/`、`deploy-nginx.ts`、`restore.ts`、`run-backup.ts`、`download-model.ts` | 命令行工具：生成和部署 nginx 站点、恢复、备份、下载模型 |

网页的目录见 [6.1](#61-页面从哪里来原型和在线演示页)。

## 4. 架构

### 4.1 两个进程

| | 守护进程（`packages/daemon`） | 服务管家（`packages/supervisor`） |
|---|---|---|
| 做什么 | 二狗本身 | 托管常驻服务：拉起、探活、被杀后拉回、日志、开机自启名单、公网隧道、tailnet 入口 |
| 生命周期 | 最常重启（每次合并、改配置） | 要小、稳、少重启 |
| 数据 | `~/.ergo`（`ERGO_DATA_DIR`） | `%LOCALAPPDATA%\ergo\supervisor`（`--data-dir` / `LSM_DATA_DIR`） |

两边只走**接入协议**（`packages/supervisor/docs/link-protocol.md`），代码上互不 import。守护进程开好端口后出站连上服务管家（四个 `LSM_*` 环境变量缺一个就静默不接入，测试、手动起的都这样），握手报能力，心跳报健康（`ok` / `degraded`）和**忙不忙**（有任务在执行、或任何 agent 有正在执行的有副作用的调用），"等空闲再停"据此等它做完；项目上线的服务经协议登记成守护进程**名下的服务**，由服务管家启动和托管。二狗自己不启动任何常驻服务。

### 4.2 守护进程是管家，agent 是子进程

- 守护进程自己不跑模型。秘书、维护者、子 agent、评审、记忆管理员各是一个**子进程**（[ADR-0002](adr/0002-one-process-per-agent.md)），由 agent 管家拉起、放进 Windows Job 对象（守护进程退出时一起清掉），环境变量只给白名单加显式注入的，模型 key 经 stdin 交给子进程、不走环境变量。
- 子进程里跑 [pi](https://github.com/earendil-works/pi)（[ADR-0001](adr/0001-pi-coding-agent-sdk-as-runtime.md)）。**pi 只出现在 `runtime/agent-child/` 这一层**，守护进程和子进程之间走二狗自己的宿主协议（[ADR-0004](adr/0004-agent-host-protocol-sdk-over-stdio.md)）；`test/pi-boundary.test.ts` 守着这条边界。Claude Code 是另一种运行时，同样经宿主协议接进来。
- 每个项目、每个任务有固定的负责人（维护者），各有自己的上下文、工具包和模型（[ADR-0003](adr/0003-no-roles-toolkit-per-project.md)）。

### 4.3 事件日志是唯一真相

- 审批、任务、计划、卡片、待我处理、账本这些领域状态都是**事件**，追加进 `db/ergo.db`（SQLite，WAL）；界面和模块读的是从事件投影出来的**派生视图**。pi 的会话文件只是 agent 的上下文，不是领域状态。
- 前端经 WebSocket 订阅**频道**（秘书会话、看板、待我处理、某个维护者的会话……），收到的是事件流；前端状态层是把事件流归并成界面状态的纯函数（`packages/web/src/state/`）。
- **彻底删除**改写事件而不是删行：每种可能被删到的事件类型都要登记改写函数，没登记的整个拒删（[ADR-0008](adr/0008-purge-scope-and-session-rewrite.md)）。
- 守护进程按"随时可能被杀"设计：重新起来后正在做的事按规则恢复，有副作用又说不清做没做完的操作转给用户确认，不悄悄重做（`recovery/`）。

### 4.4 网关：两个端口

两个端口都只监听 `127.0.0.1`：

- **本机端口**（默认 8810）自动信任。每个 HTTP 请求和 WebSocket 握手都校验 Host 是 `127.0.0.1:<端口>` 或 `localhost:<端口>`（防 DNS 重绑定），带了 Origin 就必须是这两个源之一（防跨站请求）；`Origin: null` 一律不认。
- **外网端口**（默认 8811）是隧道、Tailscale 这类入口的唯一目标：不看来源 IP、不看 Host，只看设备凭证（cookie `__Host-ergo-device`）。没有有效凭证只放行三样：页面本身（显示配对页）、`/api/access`、配对接口；别的一律 401。以后加的接口自动在这道门后面。
- `/healthz`：秘书在不在运行、网页构建了没有、启用着的插件装没装上（没装上算 `degraded`、照旧回 200）。
- `/fonts/`：视觉风格的字体（外网端口上同样要凭证）。网页运行时不请求任何外部地址。

### 4.5 设备配对

- 新设备在外网端口上 `POST /api/pairing` → 6 位数字短码、8 位十六进制短指纹（由配对 cookie 推出）→ 同一事务里写请求事件、配对请求卡、待我处理事项 → 用户在本机核对后批准（卡片按钮闭环，先到先得）→ 新设备 5 分钟内来领 → 生成 256 位随机凭证（只存哈希），原值只出现在给新设备的那一个响应里。
- 同一来源 10 分钟内最多 5 个请求；待批的 5 分钟后过期；领到凭证后 24 小时内没用过一次就作废（防止半路丢了的"幽灵设备"）；用过以后有效期 365 天，每次用往后推。
- 像网络上的自动访问的（无界面浏览器、命令行工具、爬虫的 User-Agent），卡片上会提示，但规则不变。
- 吊销后网关立刻关掉这台设备开着的 WebSocket。

### 4.6 守卫

`packages/daemon/src/guard/` 的 `judgeToolCall(input)` 是一个**纯函数**：不读文件、不跑命令、不看时钟、不读环境变量（`test/guard/judge-basics.test.ts` 扫源码检查），同样的输入永远得到同样的判定。调用方（`guard-runtime/`）现取环境事实（文件在不在、真实路径、git 状态……）交给它。

- **输入**：这次调用、是哪个 agent（工作目录、工具包）、数据目录各区和受保护区域、任务的计划（授权项、本任务的关注类别、各阶段的时序规则）、效果日志（只有执行成功的调用）、全局的关注类别设置、环境事实。
- **判定**：命中哪些关注类别、按六档处置取最严（直接做只记录 / 做完告诉我 / 计划里列了才做 / 先问我 / 交给我做 / 永不）、在不在授权内、违反了哪些时序规则；每条依据都用大白话写清，存进工具调用详情。
- **三条硬底线**谁说了都不放：不写二狗自己的配置区、数据库区和程序目录；不读密钥区；确定要把密钥发出去的不做。
- 判断不了的（缺环境事实、参数没法规范化……）一律先问。
- 默认值按"功能先跑通、安全后接"（[ADR-0026](adr/0026-features-first-security-later.md)），新装时收紧两项（见[用户手册](user-guide.md#32-不用向导的做法)）。

#### 时序规则

"删除之前必须已备份""push 之前必须跑过测试""读过密钥之后不许往外送"这类规则，格式和 planguard 兼容、原样用它的引擎（[ADR-0005](adr/0005-temporal-rules-planguard-engine.md)）：

- 四种形态：`before`（B 之前必须做过 A）、`not_before`（B 之前不能做过 A）、`check`（当下必须满足某条件）、不写 `require`（一律禁止）。
- "之前"只看效果日志（被拦下、执行失败的不算）；任务里看同一个任务的，不属于任务的看同一个 agent、同一段会话的。一条 bash 拆出的几条调用按真正可能的先后判（`a && b` 里 a 算 b 之前）。
- 违反了：`pull_back` 按规则退回（agent 能自己补救的，不问用户、计入拉回次数）、`block` 永不、`confirm` 或不写是先问我。
- 规则能用的东西（`$current`、`$prior`、`$facts`、`$agent`、`$task`、`$now`，扩展的 `path_within`）写在 `guard/rule-validation.ts` 开头，字段表和构造它们的代码放在一起（`rule-steps.ts`、`rule-env.ts`）。规则写错了存计划时就会被拒。

### 4.7 删除参与方登记表

删项目、删任务、移除插件时连数据删（还有个人档案删一个人）走同一张表（`deletion/participants.ts`）。删除代码只管先停、复查、提交、删文件；改写哪些事件、换成什么由**登记的参与方**定：

- `deletionKind<S>(id)` 是一种删除（`PROJECT_DELETION`、`TASK_DELETION`、`PLUGIN_DATA_DELETION`……），带着这次删的是什么；`participants.register(kind, { owner, join(subject, plan) })` 登记，返回撤销函数。
- 几步按顺序：`scope`（定范围）→ `claim`（认领：整条换成删除标记、换成给出的负载、按改写函数字段级改写；整张卡换成标记或改写卡片；同一事务追加的事件；提交之后做的）→ `follow`（要看别人认领了哪些卡的）→ 登记表收卡片、做字段级改写（**没登记改写函数的事件类型在这里抛错，整个删除被拒**）→ `settle`（要看整张改写单的）。
- **新加一种属于项目 / 任务的事件**：在拥有它的模块里登记一个参与方认领它，再登记它的改写函数，删除代码不用改。**新模块要一种新的删除**：在自己的模块里 `deletionKind` 一个，登记自己的参与方，删的时候 `participants.plan(kind, subject, context)`。`test/deletion/participants.test.ts` 有示范。

### 4.8 转发本机服务的页面

项目的服务跑在 `127.0.0.1:<端口>` 上，手机直接打不开。守护进程按路径转发：`/apps/<应用名>/…` → `http://127.0.0.1:<端口>/…`（`apps/`），网页的内置浏览器打开的就是这个地址。

- **只转发登记过的**（`AppRegistry.register({ name, target, title?, prefix? })`），不是开放代理：`target` 只认本机地址、只到端口。项目服务上线时由内核登记，插件经 `ctx.apps.register`。
- 鉴权和二狗的页面一样：本机端口照旧信任，外网端口要设备凭证；二狗自己的 cookie（`__Host-ergo-*`）不转给服务，服务也写不了二狗的 cookie。转发时改写 Host、Origin、`Location`、`Set-Cookie` 的 Path，去掉挡嵌入的头；流式响应和 WebSocket 原样接上。
- **前缀约定**（给写项目服务的人）：浏览器眼里服务在 `/apps/<应用名>/` 下面。默认（`prefix: "strip"`）转发时去掉前缀，服务当自己在根上，页面里**只用相对地址**（`fetch("api/items")`，不写 `/api/items`——以 `/` 开头的会跑到二狗的根上）；要拼绝对地址的读环境变量 `ERGO_BASE_PATH` 或请求头 `X-Forwarded-Prefix`。框架自己有 base 路径的（Vite 的 `base`、Next 的 `basePath`……）把它设成 `ERGO_BASE_PATH`、登记时写 `prefix: "keep"`。不要写死本机地址；服务的 cookie 别用 `__Host-` 前缀。`npm run check:app-prefix` 抓服务首页、列出不在前缀下的地址。
- **同源转发的安全取舍（已知，没做）**：服务的页面跑在二狗的源上，它的脚本能带着用户的设备凭证调二狗的接口（凭证是 HttpOnly 的，读不到原值，但能用）。按"功能先跑通、安全后接"，现在只转发维护者建的、用户确认上线的服务；以后改成独立的源（单独的端口或子域名、各自配对或短期转发令牌）。见 [SECURITY.md](../SECURITY.md)。

### 4.9 记忆系统

- **素材**：内核的素材库从事件日志采用户的原话（和语音转写、回避信号……），存原文副本、建关键词和向量索引（`db/materials.db`）。
- **记忆插件**（`memory/plugin.ts`）：每天 03:00 的内部作业叫醒**记忆管理员**（一个按需拉起的 agent），它用 `@ergo/memory` 的引擎把新素材读成证据、整理进推理库 `memory/subtext/rg.db`（结论、证据链、竞争解释、预测、问题箱），一次整理最多调 `memory.maxModelCalls` 次模型；所有写入都经唯一写入口（[ADR-0030](adr/0030-memory-keeper-maintains-reasoning-graph-through-write-gate.md)）。
- 秘书每轮醒来带一份简报，用户的话有相关记忆时自动带一份记忆简报，再按需"问记忆"；深聊和改动转给记忆管理员。
- 配置里 `memory.*` 的几项开关（比如按场景标签的情绪、财务、关系、位置）现在有的只是占位：写进来不改变行为，默认值只在 `config/config.ts`。
- 详细设计：[记忆系统总览](memory-system.md)、[记忆引擎架构](memory-architecture.md)、[词汇对照](memory-vocabulary.md)、[ADR-0032](adr/0032-memory-reasoning-rules.md)。

#### 降级、验收和回滚

- **降级**（四条都有测试）：**向量模型不在**——整理照常，素材检索退回关键词并在结果里说明；**整理模型不可用**（没配 key、请求失败）——这一夜记"跳过"（没 key，不建库、不花钱）或"失败"（原因写进整理记录、待我处理一条），素材一条不丢，下一夜接着做；**`rg.db` 打不开或版本对不上**——不自动迁移，记一条"要重建推理库"，素材检索照常，简报为空，"问记忆"回"记忆还没准备好"；**整理跑一半崩**——已经写进库的证据和事实不丢，下一夜按增量接着做。
- **开关**：`memory.enabled: false` 只不跑整理、不建库（素材检索和简报照常），和停用记忆插件是两回事；`memory.extractor` 写 `rule` 用规则版抽事实（不调模型，只当兜底）；`memory.nightlyTimeoutMinutes` 是每一夜最多跑几分钟（默认 60）。
- **只读验收**：`npm run memory:acceptance [-- --data-dir <目录>]`：`rg.db` 能不能打开、版本对不对；最近一次整理记录；现算一份简报；在素材库的快照副本上跑一次检索。不改数据、不打印素材原文，有一项不过退出码 1。
- **离线整理** `npm run memory:build`（`--rebuild` 从头来、`--max-model-calls <n>`）和**全量重判** `npm run memory:rejudge`（规则改了以后按新规则把现有结论全过一遍；`--max-yuan` 封顶，跑前存快照，`--undo <报告>` 换回）：都要先停守护进程，只写 `memory/subtext/rg.db`（338 号票起在记忆插件自己的数据目录里，`dataDirLayout().rgDb`）。
- **回滚**：只想停掉整理——设置 · 插件里停用"记忆"（`rg.db` 保留、素材库不动）；想按素材库重建推理库——停守护进程 → 删数据目录里的 `memory/subtext/rg.db*`（素材库和原文副本不动，`rg.db` 里没有原文）→ 起守护进程 → 点"立即整理一次"或等 03:00（首次建库按每晚预算可能要几夜）→ `npm run memory:acceptance` 确认。

#### 记忆插件接口（会意 / Subtext）

记忆系统是可替换的**一个插件**，同一时间只跑一个。接口在 `packages/protocol/src/memory-provider.ts`（只有类型），宿主在 `packages/daemon/src/memory/provider/host.ts`：

- **核心方法**（每家记忆系统都得有）：`info()`、`start()`/`stop()`、`observe()`（喂一条原始素材）、`remember()`（用户明说"帮我记一句"时按原话存）、`search()`（回统一的 `MemoryItem`，**必须带出处**）、`forget()`（按条目/来源/时间范围/全删，隐私删除靠它）、`health()`。
- **可选能力**（在 `capabilities` 里声明，宿主按声明决定界面和行为）：`brief`（每轮简报，不声明就由宿主用 `search` 拼一个默认的）、`consolidate`（自己的整理）、`settings`（设置项声明，宿主统一渲染）、`tabs`（记忆页有哪些页签）、`tools`（额外工具）、`subject`/`timeline`/`graph`（画像、时间线、关系图）。
- **宿主的规矩**：同时只跑一个（`activate` 先停旧的再起新的）；每个插件的数据目录是 `<数据目录>/memory/<id>/`，内核只按整个目录做备份、恢复、迁移，不读里面的格式；插件不许自己连模型、不许起端口，要模型和向量都经宿主给的 `llm()`/`embed()`；`api` 版本对不上直接不启用。
- **仓库自带的是「会意」（id `subtext`）**：结论、证据链、竞争解释、预测账本这一套（上文 4.9）。它的实现包在 `packages/daemon/src/memory/provider/subtext.ts`，具体引擎仍是 `@ergo/memory`，库在它自己的数据目录 `<数据目录>/memory/subtext/rg.db`（338 号票从 `db/rg.db` 搬过去）。
- **想接别的记忆系统**：实现 `MemoryProvider`、在注册表登记一个工厂（`info` 里写 `api`/`id`/`name`/`capabilities`/`requirements`），配置 `memory.provider` 写它的 id。`packages/daemon/test/memory/provider/` 下的两个假插件就是最小示例（只在测试里，用来验证"换一套很容易"）。

### 4.10 数据目录和配置

- 模块只从 `config/data-dir.ts` 的 `dataDirLayout()` 取路径，不自己拼。db 区里两个库（`ergo.db`、`materials.db`）随每晚的快照走（`VACUUM INTO` 出一致副本），推理库 `memory/subtext/rg.db` 在插件自己的数据目录里、跟着整个数据目录进快照；`secrets`、`tmp`、`backups`、`models`、`cache`、`components`、`imports` 不进备份。
- 配置只读，缺的项取默认值；**每个阈值的默认值只在它自己的模块里定一次**（`tasks/thresholds.ts`、`reminders/thresholds.ts`、`scheduled-jobs/thresholds.ts`、`event-sources/thresholds.ts`……），配置里只写要改的几项。
- 写文件一律先写临时文件再改名，走 `util/atomic-file.ts`（[第 9 节](#9-写代码的约定)）。

### 4.11 模型服务商

模型都在守护进程这台电脑上调，网页只放设置。服务商是一张**登记表**（`model-settings/providers.ts` 的 `MODEL_PROVIDERS`），设置页、连通测试、key 放哪、没有设置文件时的默认值都照它来（为什么只做 DeepSeek + 一个自定义的 OpenAI 兼容服务商，见 [ADR-0037](adr/0037-configurable-model-provider.md)）。

| 字段 | 是什么 |
|---|---|
| `id` | pi 模型目录里的 provider id，也是「provider/模型 id」的前半（`modelKeyOf`）、`credentials` 里的键 |
| `label` | 设置页上的名字。要翻译的写成取值函数（`get label() { return t("…") }`），模块顶层不取句子 |
| `keyEnv` | 守护进程从哪个环境变量取 key（`config/secrets.ts` 的 `modelCredentials` 照它取，键名是 `id`） |
| `secretFile` | 服务管家（LSM）从数据目录哪个文件注入 key（相对数据目录）；网页上填的 key 也写进这个文件 |
| `defaultModelId` | 没有设置文件时的默认模型。自定义服务商是空串——模型 id 是用户填的，谁都不许拿它当默认 |

现在两项，**第一项是默认**：`deepseek`（`DEEPSEEK_API_KEY` / `secrets/deepseek-api-key.txt` / `deepseek-flash`）和 `custom`（`CUSTOM_MODEL_API_KEY` / `secrets/custom-model-api-key.txt` / 空串）。`DEFAULT_MODEL_SETTINGS` 就是 `MODEL_PROVIDERS[0]` + 思考档位 `high`；`providerOf(settings.provider) ?? MODEL_PROVIDERS[0]` 这个写法在 `model-settings.ts` 里到处都是，所以"第一项是默认"这条不能破坏。

**自定义服务商怎么在子进程里登记。** pi 的模型目录里没有 `custom`，不登记的话 `getModel("custom", 模型 id)` 一律是 `undefined`（会话起不来、连通测试回"模型目录里没有"）。登记只有一处：

- `runtime/agent-child/custom-provider.ts` 的 `customProviderConfig()` 构造那份 `ProviderConfig`（`name` 是 `custom`、`baseUrl` 去掉末尾斜杠、`api` 默认 `openai-completions`、`models` 只有一个：用户填的那个 id）。模型元数据用户填不了，按估算写死：`input: ["text"]`、`reasoning: false`、`contextWindow: 128_000`、`maxTokens: 8192`、`cost` 全 0（账本照实际用量记，消耗页上这种模型的成本是粗估）；上下文窗口和一次最多几个 token 这两个数只在 `custom-provider.ts` 里定义。
- `registerCustomProvider(modelRuntime, custom)` 只被四个子进程入口调用：`session.ts`（开会话）、`probe.ts`（模型探查：查目录、连通测试）、`recorded-generation.ts`、`translate.ts`（斜杠命令说明的翻译）。**必须在 `setRuntimeApiKey` 之前登记**——登记之后 `getModel` 才认得，key 由随后的 `setRuntimeApiKey` 放进 pi 的内存凭据；反过来会先报"没有这个 provider"。
- 登记多少份元数据、key 从哪来，都在这两个函数里；别处不要自己造 `ProviderConfig`，也不要绕开 `pi-boundary.test.ts` 去碰 `@earendil-works/*`。

**装配字段 `SessionAssembly.custom`**（`runtime/host-protocol.ts`）：`{ baseUrl, modelId, api? }`，不选自定义时这一项**没有**（不是空对象）。它不含 key——key 照旧只在 `credentials`（键名 `custom`）里，经 stdin 送进子进程。同一块还出现在另外三个请求里：`ModelProbeRequest` 的 `{ type: "catalog", custom? }` 和 `{ type: "ping", custom? }`、`TranslationRequest.custom`。守护进程这一侧只有一个来源：`ModelSettingsService.customProvider()`（选了 `custom` 才有，`settings.custom` 的副本），组合根把它交给 agent 管家（`customProvider: () => modelSettings.customProvider()`）。选自定义时**所有 agent 的模型 id 一律换成 `custom.modelId`**（思考档位照每一行），因为服务商只有一个模型——在 `effectiveChoiceOf` 里做，`default` 和各 agent 覆盖里写的模型 id 只是切回 DeepSeek 时接着用。

**两个接口。** 都是在设置那一套里，key 从不进请求体、也不回显：

| 接口 | 请求 | 回应 |
|---|---|---|
| `POST /api/model-settings/custom-models` | `{ baseUrl? }`（不给就用设置里存的那份） | `{ ok, models: [{ id, name?, ownedBy? }], error? }` |
| `POST /api/model-settings/test` | `{ modelId?, custom? }`（`custom` 给了就测这一份，设置页还没存也想试一下时用；不带按设置里存的） | `{ ok, modelId, firstTokenMs?, totalMs, error? }` |

- 列模型是守护进程自己发的一次 `GET {baseUrl}/models`，带 `Authorization: Bearer <key>`（key **只认自定义服务商那一份**：设置里还选着 DeepSeek 时也绝不把 DeepSeek 的 key 发给请求里那个地址），15 秒超时，最多收 `CUSTOM_MODELS_MAX`（500）个；认 `{ data: [{ id, name?, owned_by? }] }`，也认直接一个数组。**列不成不算出错**：照样回 200，`ok: false`、`error` 写原因，原因里的 key 内容去掉。
- 连通测试还是那条路——起一个一次性子进程，在它里面登记 provider、发一条极短的请求；同一时间只跑一个，重了回 409（"上一个还没测完"）。
- 设置文件里的 `custom` 块在 `provider` 不是 `custom` 时也可以留着（切回 DeepSeek 不清空它）；`POST /api/model-settings` 没带 `custom` 就沿用文件里原来那份。`checkModelCustom()`（`packages/protocol/src/model-settings.ts`）是唯一判合规的地方：地址要 http(s)、模型 id 不能空白、末尾斜杠去掉；选着 `custom` 却没有这一块按读文件失败处理。

**要加别家预设，改这里**：

1. `model-settings/providers.ts` 的 `MODEL_PROVIDERS` 加一行：`id`、`label`（要翻译就写 `t("modelSettings.provider.<id>")`，两份语言文件都加）、`keyEnv`、`secretFile`、`defaultModelId`。
2. `deploy/lsm/ergo-daemon.example.yaml` 的 `env:` 加一条 `{ name: <keyEnv>, from: file, path: <用户主目录>\.ergo\secrets\<文件>, optional: true }`，不然服务管家不注入 key（网页上填的 key 当次有效，重启守护进程以后就没了一样）。
3. pi 的模型目录里**有**这家就不用动子进程；**没有**的话照 `custom-provider.ts` 的样子在 `runtime/agent-child/` 里登记一份（`ProviderConfig` 只能在这一层构造）。
4. 设置页、key 那块、连通测试、列模型都照登记表来，不用改；`test/model-custom-provider.test.ts`（本机的假 OpenAI 兼容服务在 `test/helpers/fake-openai.ts`，不联网）可以照着加。

**这一层不管的**：记忆的每晚整理（`memory/nightly-job.ts` 用 `DEEPSEEK_API_KEY` 建 `DeepSeekChat`）、联网搜索和读网页（`web/deepseek.ts` 是 DeepSeek 专有接口）、token 单价表（`packages/protocol/src/token-prices.ts` 只有 DeepSeek）都只认 DeepSeek，换成自定义服务商也不跟着换——碰这几样时按登记表里 `deepseek` 的 `keyEnv` / `secretFile`（或 `config/secrets.ts` 的 `deepseekKey()`）取 key，别顺手改成"当前服务商"。

## 5. 插件

守护进程分**内核**和**插件**（[ADR-0027](adr/0027-plugin-host-kernel-and-agent-contributions.md)）：内核（事件日志、任务执行连同守卫、宿主协议、网关……）在组合根里手工装；插件按插件清单 `plugins/manifest.ts` 经插件宿主 `plugins/host.ts` 装，组合根里不出现任何一个插件。一个功能插件 = 守护进程里的插件 + 网页里同名的网页插件，一起启停，用户能在设置 · 插件里热插拔。

**写一个插件，照手册 [docs/guides/plugin-development.md](guides/plugin-development.md)**：从一个最小的"笔记"插件讲起，一步步到三部分（守护进程里的、给二狗的、网页上的）、依赖和边界、数据契约和"连数据删"、热插拔、多语言、怎么测、上线；手册里的代码片段和名字由 `test/plugins/plugin-guide-doc.test.ts` 和代码核对。让 agent 写插件时用 skill `.claude/skills/ergo-plugin/SKILL.md`（检查清单）。下面是宿主本身的参考。

### 5.1 能注册什么

插件装配时拿到 `PluginContext`，每个 `register` 都返回撤销函数、同时记在插件名下，停用时宿主倒着撤：

| 登记 | 进哪张表 | 撤销时 |
|---|---|---|
| `cardTypes.register` | 卡片类型（`cards/registry.ts`） | 只撤自己登记的那一份 |
| `purge.register` / `purge.registerQuotes` | 彻底删除的改写函数和引用 | 撤掉这次登记的 |
| `quickActions.register` | 快速动作 | 只撤自己的 |
| `internalJobs.register` | 内部作业（见下） | 取消计时器；正在跑的那一次跑完照常记下 |
| `boardKinds.register` | 看板种类 | 秘书的看板不再列它 |
| `eventSubscribers.register` | 事件触发的订阅方 | 不再交给它 |
| `apps.register` | 转发登记表（[4.8](#48-转发本机服务的页面)） | 之后 404，开着的管道断开 |
| `agent.tools` / `agent.context` / `agent.hooks` / `agent.notes` 的 `register` | 给 agent 的工具、每轮的上下文块、钩子、输入附注 | 之后装配的 agent 不再有它；常驻的秘书手头这一条处理完就重新装配 |
| `effect(execute)` | 定时器、订阅这类：执行它、记下它返回的撤销函数 | 叫那个撤销函数 |
| `lifecycle({ start, stop })` | 插件自己的启停 | 叫 `stop`（最先撤） |
| `provide(key, value)` | 插件提供的服务 | 拿掉，别处取到 `undefined` |

视图、系统提示的片段在定义里声明。**数据契约**（`contracts`：卡片类型、改写函数、素材来源、前端请求、移除时删什么）停用也照样登记——插件停了，它以前写下的事件照样要能被彻底删除、照样要能采成素材。

**依赖**都是带类型的服务（`serviceKey<T>(名字)`）：`needs` 必需（宿主按它排顺序，缺了这个插件不装，原因写进启动日志和 `/healthz`）、`wants` 可选（用 `ctx.optional(key)` 现取，不要存起来）。内核模块要用插件的东西只 import 它的 `api.ts`（边界测试守着）。

**停用时怎样**：配置停用（`plugins.disabled`，重启生效）、运行中停用 / 启用 / 移除（设置 · 插件，马上生效）。停用后它的登记都撤掉、视图记成停着的（表留着、不再更新，再装上时按事件日志补齐）；聊天、待我处理里它以前的条目显示成一行"（X插件没启用，这条内容暂时看不到）"；正在跑的一轮里再调它的工具，回"X插件没启用"。移除时可以连数据一起彻底删除（按 `removal.declare` 写明的）。

### 5.2 插件的内部作业

`ctx.internalJobs.register({ name, schedule, run })`：守护进程自己按时间表做的事，挂在调度器上、不用 Windows 计划任务。

- `schedule` 和提醒用同一套时间规则（比如 `{ kind: "daily", time: "03:00" }`），另外认 `{ kind: "every", minutes }`（从上一次跑完往后数）。
- `run(trigger, signal)`：`trigger` 是到点（`scheduled`）还是启动时补错过的（`catch_up`）；`signal` 在守护进程停止时置位，作业要尽快停下（抛 `AbortError` 就当没跑过，下次启动照常补）。
- 作业自己的错只进日志、照常排下一次；要让人看见就自己写进待我处理。
- 第一次见到某个作业只记"从现在起算"，不马上跑；停机期间错过的开机后补一次。时间一律取注入的时钟（测试用 `ManualClock` 拨，不真等）。
- 在 `setup` 里用 `ctx.effect(() => ctx.internalJobs.register(job))` 登记；正在跑的那一次不会被撤销函数中止，插件要在 `lifecycle.stop` 里自己置中止信号并等它停下。

### 5.3 网页插件

网页用**类型化插槽**，插件之间不互相 import（`packages/web/src/plugins/`）。守护进程在插件频道上推每个插件的状况，网页插件宿主按它装、停。

| 插槽 | 核心在哪画 | 插件停用时 |
|---|---|---|
| `pages` 页面和路由 | 导航里按 `order` 插进核心的几项；收进"更多"时是右边那一栏 | 导航里没有；地址还在的写"X插件没启用" |
| `settingsSections` / `settingsPages` | 设置列表里的分节、插件画的设置页 | 不出现 |
| `chatItems` / `details` | 对话里的条目、详情面板的内容 | 换成一行占位 |
| `cards` | 卡片（聊天、待办、任务详情同一张） | 一行占位 |
| `boardEntries` | 看板条目和菜单项 | 同一组里连着的合成一行占位 |
| `calendar` | 日历的图例、格子里的小标、点开一天的一节 | 不出现 |
| `composerVoice` | 输入框的语音模式 | 一律打字 |
| `background` | 不画东西、只跑钩子（比如自动播放） | 不跑 |
| `tabs` | 主导航里的页签（现在只有"浏览"） | 导航里没有这一项 |

插件在定义里写明它拥有哪些位置（`owns`），装配时登记的要和它一一对上；插件只 import `plugins/api.ts` 和核心，插件清单 `plugins/manifest.ts` 只由 `App.tsx` 引（`test/plugins/boundary.test.ts` 守着）。原型里地址带 `?demo-plugins-off=memory,reminders` 能看停用后的样子。

## 6. 网页

### 6.1 页面从哪里来、原型和在线演示页

- **由守护进程提供**：`npm run build:web` 之后，守护进程在 `http://127.0.0.1:8810/` 提供 `packages/web/dist/index.html`（Vite + `vite-plugin-singlefile`，JS、CSS 全内联；每次请求重新读，不用重启守护进程）。开着的页面几秒内会提示"有新版本 · 刷新"。
- **原型**：直接打开构建产物（`file://`）时没有守护进程，全部用原型自带的编的数据（`src/prototype/`：假连接、假数据，名字和路径都是虚构的）。评审界面、页面测试（`test/page-opens.test.ts`）都这么开。地址的 `?lang=en` 换英文。
- **在线演示页**：`npm run build:demo`（`vite build --mode demo --outDir dist-demo`）再构建一份，页面按 `import.meta.env.MODE` 认出是演示页、一律用原型的假数据（`src/app/prototype-mode.ts`），整个 `dist-demo/` 放 GitHub Pages（`.github/workflows/pages.yml`）。不装、不填 Key 就能点着看。

**网页的目录**：

| 目录 | 是什么 |
|---|---|
| `src/state/` | **前端状态层**：把事件流归并成界面状态的纯函数，不依赖 React 和 DOM（单独一份 tsconfig 守着） |
| `src/app/` | 状态层接到 React（`store.tsx`）、连接（WebSocket 和 HTTP）、配对、路由、主题、语言、录音和播放 |
| `src/ui/` | 共用部件：会话组件（秘书和维护者共用）、卡片、分栏和弹层、主导航、线条图标（`icons.tsx`） |
| `src/pages/` | 各页面 |
| `src/plugins/` | 网页插件宿主、插件清单、各插件 |
| `src/visual-styles/` | 视觉风格清单和 token（[6.2](#62-视觉风格)） |
| `src/prototype/` | 只属于原型的假连接和假数据 |
| `src/page-bridge/` | 注入"浏览"里外部网页的独立脚本（悬浮按钮、填框） |
| `src/styles/` | 经典风格的规则，只用 `var(--token)` |
| `build/` | 构建插件（风格、版本号、关于页的构建信息）、`smoke-page.ts` |

### 6.2 视觉风格

11 套风格（经典、暖纸手帐、净白格栅、夜航仪表、软糖圆角、玻璃光纹、工程蓝图、贴纸便当、像素小屋、水墨国风、复古杂志），每套都有浅色、深色。**风格只换皮**：页面结构、功能、导航的结构和尺寸逻辑都是共享的，风格只覆盖 token 和样式（[ADR-0021](adr/0021-visual-styles-tokens-in-ts-fonts-from-gateway.md)）。

- **一套风格 = 一组 token + 限定在这套风格下的规则**。token 的名字在 `src/visual-styles/tokens.ts` 的 `TOKEN_NAMES`，经典的值写全在 `classic/style.ts`，别的风格只写不一样的；页面样式只用 `var(--token)`，不写死颜色、圆角、阴影。规则在 `<id>/style.css`，每条以 `:root[data-style="<id>"]` 开头（`test/visual-styles/scope.test.ts` 逐条查）。
- 几组容易用错的 token：字体三个（`font-body` 正文、`font-title` 标题、`font-num` 数字）；强调色 `primary` 和实色块 `primary-fill` 分开；边框 `card-border`（有框的卡片）和 `panel-border`（底板）分开；阴影的颜色用 `light-dark()` 写一个值。
- **字体由二狗自己提供**：风格的 `fonts` 写 npm 上 fontsource 的包（许可证要允许分发），构建时拷进 `dist/fonts/<包>@<版本>/`、按 `unicode-range` 切片，守护进程按 `/fonts/` 提供，只在选了这套风格时加载。运行时不请求外部 CDN。
- **图标**：导航、选项、按钮上的图标用 `src/ui/icons.tsx` 的 `<Icon name="…" />`（自己画的线条 SVG，颜色 `currentColor`），不用表情符号。
- **加一套风格**：建 `src/visual-styles/<id>/style.ts`（`{ id, name, blurb, tokens, fonts? }`）和 `style.css`，在 `src/visual-styles/index.ts` 登记一行；要字体的 `npm install -D --save-exact <fontsource 包>@<版本> -w @ergo/web`；跑 `npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts`（对比度、字体、规则的前缀自动查），再 `npm run build:web` 打开看浅色深色。设置里的风格预览自动就有。

### 6.3 会话的缩放和滚到底

秘书、任务、项目三种会话都是同一个组件 `ZoomHistory`（viewport > sizer > content），三档缩放按比例缩 sizer。伸到内容外面的东西（右侧标注、箭头）一律由 `.zh-sizer` 的 `overflow-y: clip` 裁掉，滚动范围就是 sizer 的高度；缩小后看得见、伸到最后一条下面的标注算进"只在缩小时出现的尾部区域"（`state/scroll-end.ts` 的 `zoomedOutTail`）。右下角"回到最新"的 ↓ 的规矩也在 `scroll-end.ts`。jsdom 不排版，真排版的核对办法：无头 Chrome 打开构建产物，用滚轮滚到底，量 `.zh-viewport` 的 `scrollHeight` 是否等于 `.zh-sizer` 的 `offsetHeight`，三档各量一次。

### 6.4 麦克风让路

语音模式里二狗预热着麦克风，按下即录；但页面里**可输入的元素拿到焦点**、或者窗口失去系统焦点时，要立刻停掉所有音轨，免得挡住系统输入法的语音（"麦克风被占用"）。焦点回来以后等 0.5 秒再重新预热；按住说话的时候焦点怎么变都不打断。规则只写在状态层一处（`state/voice-mic.ts` 的 `voiceMicCloseReason` / `voiceMicOpenReason`，表格测试在 `test/state/voice-mic.test.ts`），接到浏览器在 `app/voice-browser.ts`。录下来的语音带诊断记录（`capture`：后端、按下到开录的毫秒数、峰值……），不发空白语音。鸿蒙 App 里改用原生录音、不用让路（[8.4](#84-原生录音)）。

## 7. 多语言

界面文字、二狗生成给用户看的话（卡片、通知、回执）走 `t()`；秘书和维护者用所选语言回答。系统提示和工具说明是给模型看的，照旧中文，末尾加一句"用 <语言> 回答用户"。**全局一个语言**，所有设备一起换（[ADR-0029](adr/0029-i18n-runtime-in-protocol-one-active-language.md)）。

- **运行时**在共享协议包（`packages/protocol/src/i18n/`）：`t(key, params?)`（`{name}` 插值；缺的用中文补）、单复数（参数里有 `count` 时找 `_one` / `_other`……）、`tParts` / 网页的 `<T k="…" params={…} />`（句子中间放元素）、`tTable`（常量表写成 key，取值时现查）、`followLocale`（导出的单个字符串常量跟着语言变）、`forModel`（一段代码里的 `t()` 都按中文，给模型的那份用它包）、`formatNumber` / `formatDate`。
- **语言文件**：自带的在 `packages/protocol/locales/<语言代码>/`，文件名就是 key 的第一段（区域）；用户放在 `~/.ergo/locales/` 的同格式，守护进程每 2 秒看一眼，不用重启。
- **key 的写法**：`<区域>.<模块或页面>.<含义>`，各段小驼峰，说的是**意思**不是原文。网页能用的区域在协议包的 `WEB_NAMESPACES`；守护进程的 key 以它所在的目录名开头。插值参数两种语言要一样。
- **模块顶层不要调 `t()`**，也不要在模块顶层取 `tTable` 的值（那时可能还没装上语言）：写成函数、渲染时取。`memo` 了的组件、`useMemo` 里用了 `t()` 的，自己调 `useLocale()` 或把它放进依赖。
- **给模型看的中文怎么排除**：标注要是那条注释开头的第一样东西——`// @i18n-ignore model：原因`（这一行）、`// @i18n-ignore-next model`、`// @i18n-ignore-start model` … `// @i18n-ignore-end`、文件开头的 `// @i18n-ignore-file model：……`、JSX 里 `{/* @i18n-ignore fixed */}`。原因只能是 `model`、`log`、`fixed`、`data`。直接写在 `log(…)`、`console.*(…)` 括号里的不用标。
- **写死中文的棘轮**：`packages/daemon/test/i18n/hardcoded.test.ts` 数每个区域写死的中文（注释、测试、原型的演示数据不算），每个区域的基线都是 0——新写的给用户看的字一律走 `t()`。
- **检查**：`npm run i18n:check`（每种语言缺的、多的、插值参数对不上的句子，`~/.ergo/locales` 里读不进来的文件；自带的英文不全才以 1 退出）。加一种语言给用户看的步骤见[用户手册](user-guide.md#54-语言)；做成自带的语言：译好的目录放进 `packages/protocol/locales/<语言代码>/`，文件名和 `zh-CN` 的一一对应。

## 8. 鸿蒙 App

`frontend/harmony/` 是 DevEco 工程（stage 模型，`entry` 模块）：一个原生壳，ArkWeb 加载用户配好的二狗地址，网页还是守护进程提供的那份（为什么不把网页打包进 App 见 [ADR-0022](adr/0022-harmony-app-native-shell-loads-daemon-page.md)）。原生桥 `window.ergoNative` 只对配好的来源的主框架开放；"浏览"里的外部网页拿不到它。

### 8.1 构建

```powershell
npm run build:harmony                       # 默认关着 WebView 调试
npm run build:harmony -- --webview-debug    # 打开 WebView 调试（只在调试时装这个包）
```

- 用 DevEco Studio 自带的工具（先看环境变量 `DEVECO_HOME`，没设就找默认安装位置），工程没有 ohpm 依赖，不用联网。构建前先把页面桥打包进 `rawfile/page-bridge.js`、把自带语言的 `harmony.json` 收进 `rawfile/harmony-texts.json`（都是现生成的，不进仓库）。
- 产物：签过名的是 `frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap`；本机没配签名时只有同一目录下的 unsigned 包，脚本会提示怎么签。
- 依赖本机装的 DevEco，所以不进 `npm run check`。

### 8.2 签名（只做一次）

签名材料（证书、描述文件、密钥库、加密的口令）只放在本机，不进仓库：先跑一次 `npm run build:harmony` 生成本机的 `frontend/harmony/build-profile.json5`（被忽略）→ 手机打开开发者模式和 USB 调试并连上 → DevEco 打开 `frontend/harmony`，File → Project Structure → Project → Signing Configs，登录华为账号，勾上 Automatically generate signature → 再构建。仓库里只有不含签名的模板 `build-profile.template.json5`；`frontend/test/harmony.test.ts` 检查仓库里没有签名材料。

### 8.3 安装、启动、调试

```powershell
hdc list targets
hdc -t <设备号> install -r frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap
hdc -t <设备号> shell aa start -a EntryAbility -b com.example.ergou
hdc -t <设备号> hilog | findstr ErgoApp            # App 和网页的日志
```

调试 ArkWeb 里的页面：装 `--webview-debug` 的包，`hdc -t <设备号> fport tcp:9222 localabstract:webview_devtools_remote_<App 的 pid>`，再用 Chrome 的 `chrome://inspect`。要在设备上用 `http://127.0.0.1` 连电脑上的守护进程，先 `hdc rport tcp:<端口> tcp:<端口>`；注意转本机端口（8810）时守护进程会把 App 当成本机、直接信任，只在调试时这样用。

### 8.4 原生录音

App 里按住说话用鸿蒙的 AudioCapturer：进语音模式时建好录音器、停在 PREPARED（不采集、不占麦克风、不挡输入法的语音），按下才 `start`，松手 `stop`（下一条直接 `start`，不用重建）；切到后台、离开语音模式时 `release`。格式是 16 kHz、单声道、16 位 PCM，网页加上 WAV 头照常上传。音源用 `SOURCE_TYPE_MIC`：它是唯一在各个系统版本、两个方向上都能和输入法的语音识别（`VOICE_RECOGNITION`）并存的音源。实现在 `frontend/harmony/entry/src/main/ets/voice/NativeVoice.ets`，网页一侧在 `packages/web/src/app/native-voice.ts`、`voice-native-recorder.ts`。

## 9. 写代码的约定

- **类型剥离的限制**（守护进程和协议包直接跑 `.ts`；网页由 Vite 打包，但同样遵守）：相对导入写 `.ts` 后缀；只用可擦除的语法（不用 `enum`、`namespace`、构造函数参数属性）；纯类型导入写 `import type`。`tsconfig.base.json` 的 `erasableSyntaxOnly`、`verbatimModuleSyntax` 会查。
- **pi 的边界**：`@earendil-works/*` 只能在 `packages/daemon/src/runtime/agent-child/` 里引用，任何地方都不许转导出 pi 的东西，`agent-child/` 之外不许 import 它里面的模块（`test/pi-boundary.test.ts`）。
- **项目系统的边界**：项目系统那几个目录之外只能 import 入口 `projects/api.ts`（运营层是 `project-ops/api.ts`）；要项目系统的新东西就在入口加一个"调用方要什么给什么"的小接口（`test/projects/boundary.test.ts`）。插件同理：内核只 import 插件的 `api.ts`。
- **个人数据和密钥永不进仓库**：数据目录从配置读，测试一律用临时目录。不要读、不要打印用户主目录下 `.ergo`、`.ssh` 等真实数据。
- **写文件先写临时文件再改名，一律走 `util/atomic-file.ts`**（`writeFileAtomic`、`renameRetrying` 和异步版）：Windows 上改名覆盖一个正被别的进程开着的文件会失败（哪怕对方只是在读），它会重试；不要直接 `fs.renameSync` 一个刚写的临时文件。
- **给用户看的文字走 `t()`**（[第 7 节](#7-多语言)）；给模型看的、日志标 `@i18n-ignore`。
- **标识符用英文，注释用中文**；领域概念用 `CONTEXT.md` 里的词。例外：系统提示文件里的占位符名用中文（`{{拉回次数}}`、`{{#立项书已确认}}`，连同代码里填值时的键）——这些文件是给用户看、给用户改的，用户在设置页的编辑框里直接写这些名字。
- **每个阈值的默认值只在它自己的模块里定一次**，配置里只写要改的。
- **样式只用 `var(--token)`**，不写死颜色、圆角、阴影（[6.2](#62-视觉风格)）。
- 依赖写死精确版本，`package-lock.json` 一起提交。

## 10. 测试

### 10.1 车道

| 车道 | 跑什么 | 什么时候跑 |
|---|---|---|
| `npm run test:fast` | 守护进程里除主切面（`test/main`）、契约测试（`test/contract`）以外的全部 + 协议包 + 网页状态层 / UI / 构建检查 + 记忆 + 鸿蒙的检查 | 改完代码每次都跑（约 2 分钟） |
| `npm run test:integration` | 主切面（真的拉起守护进程和 agent 子进程）+ `page-opens`（构建一遍，用真 Chrome 打开每一页） | 改到守护进程主线、组合根、装配时，或者合并前 |
| `npm test` | 全量 = 快车道 + 主切面 + pi 契约测试 | 发版前（GitHub Actions 打 tag 时跑） |

`npm run test:contract`（pi 契约测试）每条用例单独拉起 agent 子进程，只在升级 pi、改 `agent-host/`、`runtime/`、提示词装配时跑。服务管家的测试是 `node --test`，`npm run test:supervisor` 单独跑。两条车道的 vitest 配置在根目录 `vitest.fast.config.ts`、`vitest.integration.config.ts`，全量走根 `vitest.config.ts`；改某个包的 `setupFiles` / `include` 时几处一起改。

### 10.2 测试底座

- **主切面**（`packages/daemon/test/main/`）：`startTestDaemon(options)` 起一个真的守护进程（临时数据目录、系统挑的空闲端口，**从不占用 8810、8811**），秘书、维护者、评审、子 agent 接 pi 的 faux provider 按剧本回话，子进程真的拉起；`TestFrontend` 扮演前端，经 WebSocket 和 HTTP 收发、按频道等事件。时钟用 `ManualClock` 拨，不真等。
- **守卫切面**（`packages/daemon/test/guard/`）：只调判定函数，不起进程；场景文件 `scenarios/*.guard.json` 逐个跑。
- **pi 契约测试**（`packages/daemon/test/contract/`）：只验二狗依赖的 pi 行为。
- **网页**：状态层用录下的事件流回放（`recordings/`，主切面现场录：`ERGO_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/recordings.test.ts`），页面用 `page-opens.test.ts` 在真 Chrome 里打开原型（本机没有 Chrome 时跳过）。
- **插件**：假内核 `test/helpers/plugin-kernel.ts` 的 `startPluginKernel`（见插件开发手册）。
- **测试里的密钥样本**在运行时拼（`test/helpers/fake-secrets.ts`），仓库里没有像真密钥的字符串。

### 10.3 不碰真数据、不联网

- 测试一律用临时目录，不碰 `~/.ergo`、不碰在跑的守护进程。
- 所有 vitest project 都挂了根目录的 `vitest.setup-no-network.mjs`：**除本机回环以外的请求直接抛错**。要测网络就用本机假服务（假 TTS、假 MCP、假的模型目录……）。测试一条都不花 token。

### 10.4 Windows 上要注意

- 并行度：`ERGO_TEST_WORKERS` 设具体个数（不设是一半的核）；几套测试同时跑时用 2。
- 拨时钟跨过 03:00 会在后台唤醒记忆管理员：`startTestDaemon` 给了 `clock` 时默认停掉记忆插件，测记忆的用例写 `memoryPlugin: true`。
- 别在产品改名替换一个文件的途中轮询读它（Windows 上会 EPERM / ENOENT）：先等产品给的"做完了"的信号再读。
- 超时只为"慢"放宽，断言不放松。

## 11. 升级 pi

1. `npm view @earendil-works/pi-coding-agent dist-tags` 查最新稳定版，读几个包 CHANGELOG 里的 Breaking Changes。
2. 所有 `@earendil-works/*` 一起改，都写精确版本：`packages/daemon/package.json` 的 `dependencies`、根 `package.json` 的 `overrides`（新版本 pi 的依赖里有新的 `@earendil-works/*` 包就也加进去）。
3. `npm install`，确认 `npm ls --all` 里 earendil 的包全是同一个版本。
4. `npm run typecheck` → `npm run test:contract` → `npm test`。子进程里挂给 pi 的只有通用桥接扩展（`runtime/agent-child/bridge.ts`），先对照 CHANGELOG 看它用到的事件、`agent-child/tool-order.ts` 用到的接口改了没有。
5. **核对 pi 的 Node 大版本**（[ADR-0031](adr/0031-node-version-follows-pi.md)）：看 pi 的 `.github/workflows/ci.yml` 的 `node-version` 和安装脚本的 `latest-v<大版本>.x` 变没变；变了就跟着换（`engines`、CI、安装包），跑全量。

## 12. 从 ergou 迁到 ergo

二狗早先的代码名是拼音 `ergou`，后来统一成 `ergo`：包名 `@ergo/*`、环境变量 `ERGO_*`、数据目录 `~/.ergo`、`config/ergo.json`、`db/ergo.db`、配对 cookie `__Host-ergo-*`、浏览器存储的键 `ergo-*`、鸿蒙原生桥 `ergoNative`、服务管家里的 `ergo-daemon` / `ergo-tunnel` / `ergo-asr`。鸿蒙包名 `com.example.ergou` 没改（改了就是另一个 App）。

**兼容期旧名字照样认**：读新旧都认、新的优先，写只写新的；旧名字一律用协议包的 `oldNameOf` 从新名字推出来（`packages/protocol/src/old-names.ts`）。数据目录（`ERGOU_DATA_DIR`、`~/.ergou`）、别的环境变量、数据目录里的旧文件名、旧的配对 cookie、浏览器里的旧键、鸿蒙 App 的旧名字都有对应的兼容代码。从旧数据目录迁过来：`npm run migrate:ergo -- [--data-dir <旧的数据目录>] [--dry-run]`（守护进程要先停；改名、在原地建目录联接；每一步都能重跑）。

## 13. 文档、CHANGELOG、设计记录

- **改了行为，同一个提交里改文档**：用户看得到的改[用户手册](user-guide.md)（中英两份），模块、协议、约定改本指南（中英两份），插件改插件开发手册（有测试核对代码片段和名字），新词加进 [CONTEXT.md](../CONTEXT.md)。
- **CHANGELOG**：每个版本一节，写用户能感到的变化。
- **设计记录**（`docs/adr/`）：难以反悔、出人意料、或者在几个方案里取舍过的决定写一份 ADR，编号接着排，写背景、决定、后果。
- **记忆系统**的文档（`docs/memory-system.md`）有测试核对接口表、工具表、路径（`packages/memory/test/architecture-doc.test.ts`）。
- **第三方许可证**：依赖以 MIT / Apache-2.0 / BSD / ISC 为主，sharp 带的 libvips 是 LGPL-3.0，字体是 SIL OFL 1.1（网页构建时许可证跟着字体拷进 `dist/fonts/`）；lightningcss 是 MPL-2.0，但只在构建网页时用、不进安装包。完整清单由构建脚本生成（`packages/daemon/build/`，根目录的 `npm run release` 打到 `dist/release`），放在安装包根目录：`THIRD_PARTY_NOTICES.txt`（全文）和 `third-party-licenses.json`（名字、版本、许可证、从哪来）。Claude Code 的 Agent SDK（`@anthropic-ai/claude-agent-sdk`）是 Anthropic 自己的许可，是可选依赖，不随安装包分发。
