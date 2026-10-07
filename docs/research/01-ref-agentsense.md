# 参考项目调研 01：AgentSense（user_agent_sense_of_security）

> - 调研对象：`D:\code\claudecode\user_agent_sense_of_security`，下文记作 `REF/`，文中路径都相对它。版本：2026-10-06 的 HEAD（CHANGELOG 最新一条是 2026-10-06，git 共 55 个提交）。
> - 目的：ergou（改进版 OpenClaw 式个人 Agent）要继承 AgentSense 的 UI 设计、"长任务一定做完"的机制、"少打断用户"的机制和 Web UI 体验，并把"只对安全/隐私操作提醒"推广成"用户自己选哪类操作要提醒"。
> - 读法：§0 是一页摘要；§1–§6 讲 AgentSense 本身，都有文件和行号；§7 是给 ergou 的继承与泛化建议；§8 是开放问题；附录是文件索引和关键数字。
> - 标注：没标的是【事实】，来自代码或文档；【建议】【推测】是本文作者对 ergou 的看法。
> - 跳过了：二进制、媒体、`tts/`、`node_modules`、`oh_modules`、`output/*.mp4|pptx`。`docs/research/*` 两份竞品调研只读了摘要和结论两节。

---

## 0. 一页摘要

1. **定位**：一个在鸿蒙手机上跑多步任务的 Agent，用来做"安全感"实验。它主张的是"**一次授权 + 几道确定性保险**"，用来替代两种做法：一是逐次授权（打断太多，最后用户干脆全放开），二是 auto mode（由模型判断要不要问，判断本身是概率性的）。见 `README.md:3-10`、`docs/security-experience.md:5-12`。
2. **安全感来自四个方面**（`README.md:14-21`）：
   - 事前：先规划，再做确定性审查、自动修补，最后一次授权。
   - 执行中：每次调用工具前做确定性核对。偏了就自动拉回，不打扰用户。
   - 事后：缩放回看整个过程。
   - 兜底：可以回退，也可以切分支，并且先说清楚哪些事已经收不回。
3. **两种计划模式**：新建会话时二选一，之后不能换（ADR 0002）。
   - **固定计划**：每一步都排定，由 planguard 审查并修补。
   - **里程碑计划**：只定一张由里程碑组成的 DAG。每个里程碑写明交付件、验收标准（脚本只读世界状态来核对）、授权项（种类 + 对象范围 + 次数），以及一套从规则库拼出来的安全策略。
4. **pi 的用法**：
   - 用的是 `@earendil-works/pi-agent-core@0.85.1` 的 `AgentHarness`（lane、hooks、JSONL 会话树），加上 `@earendil-works/pi-ai` 接 DeepSeek。
   - 全部安全逻辑挂在三个 hook 上：`before_tool` 负责拦截、改参数、当场问人；`after_tool` 把判定写进 `details`，随会话落盘；`before_run_end` 返回 `followUp`，催 Agent 继续做。
   - pi 和 UI 跑在同一个浏览器 JS 上下文里（ArkWeb）。ArkTS 外壳只有约 350 行。
5. **确定性判定**：规则是 JSON 写的、只看过去的一阶时序公式，按三值逻辑求值，由纯 TS 在端侧求解（单次核对是 ms 级甚至 µs 级）。模型只能从规则库里挑规则，不能自己写；它写的补充规则只能让约束更严。
6. **打断分级**（以里程碑计划为准）：
   - 不问人：红线和拦截（拦下后告诉 Agent）、拉回、参数改回、引回前置步骤、催促、超预算先说明进展。
   - 才问人：超出授权、规则级别是"确认"或判不了、由你验收、交三次都没通过、连续拉回无效、用量到预算两倍、在碰过底线的地方要做对外的事。
   - 授权框默认选"拒绝"。用户说"不"按改主意处理，不算 Agent 失败。
7. **UI**：
   - 一条会话历史一镜到底缩放（对话层 / 要点层 / 全局层）。要点层和全局层两侧挂风险标注、任务卡、回退点、废弃分支和里程碑书脊。
   - 拦下、拉回、退回在聊天里都是一行可以展开的横条，细节进详情页。
   - 视觉上四条规矩：颜色只给发生了的事；统一线型；系统查到的和 Agent 说的用两种声音；动效只解释因果。
8. **对 ergou 最关键的两个缺口**：
   - **"安全类别"在多处写死在代码里**：`GrantKind`、`SensitivityMark.kind`、`COUNTED_KINDS`、`NEVER_GRANTED`、`TAINT_KINDS`、`natureOf` 的正则、各场景用 TS 写的敏感规则。真正由数据驱动的只有 `policies/` 下的 JSON 和 `*.planguard.json`。
   - **没有"普通聊天模式"**：两种模式下，计划没授权之前所有业务工具都会被拦（`runtime.ts:340`、`controller.ts:744`）。

---

## 1. 解决什么问题；核心领域概念

### 1.1 问题陈述

- **长任务敢不敢交给 Agent**：任务有十几步，要读你的文档、以你的名义发消息、花钱、删文件（`README.md:5`）。
- **逐次授权是个死结**：一轮存储清理就要问十几次，人受不了，最后全放开（`docs/security-experience.md:5-12`）。
- **Auto mode 的问题**：做事的是模型，判断"该不该问"的还是模型。每步 99% 判对，100 步全对的概率只有 37%（`README.md:8`）。
- **项目给的答案**：判断交给独立于模型的确定性规则和求解器，同样的输入得出同样的结论；查到问题先自动修，修不了才找你（`README.md:10`）。
- **和竞品的差异**（`docs/research/phone-agent-demos-others.md` §4.4）：各家的确认机制都停在"动作级"，问的是"这一下点不点"。AgentSense 授权的是"这一段能动哪些东西、动几次"，事后再用脚本核对"东西是不是真的变成了那样"。
- **竞品事故给的启发**（同一文件 §4.3）：
  - OpenClaw / Summer Yue：上下文压缩丢掉了"先确认"这条约束，结果删掉 200 多封邮件。对策是**约束放在模型上下文之外，由 harness 执行**。
  - Cowork 删照片：对策是逐个比对对象范围。
  - "幻觉预约"：对策是验收只看世界状态。

### 1.2 与 ergou 最相关的术语（摘自 `CONTEXT.md`）

| 类别 | 术语 | 定义要点 | 对 ergou 的意义 |
|---|---|---|---|
| 计划 | **计划模式（Plan Mode）** | 固定计划或里程碑计划，建会话时选定；文档说以后可以改成由不同的 skill 发起 | ergou 要再加一种"普通聊天"，还要能在模式间升级 |
| | **固定计划** | 有序步骤，审查修补后一次授权 | 适合确定性强的短链任务 |
| | **里程碑计划** | 里程碑组成的 DAG（可并行、汇合、二选一）；每个里程碑可以是**定步**或**自主** | 长任务的主力形态 |
| | **里程碑 / 阶段 / 交付件 / 验收标准 / 验收脚本** | 阶段 = DAG 的同一层；验收脚本只读世界状态，不信 Agent 的自述；它管"结果合不合格"，过程合不合规由时序规则管，两者不混用 | "做完"的定义来自系统，不来自模型 |
| | **认领 / 提交** | 一次只认领一个里程碑，认领后不能中途放下，只能以验收通过或判为未通过结束 | 防止东做一点西做一点 |
| | **初步思路（Approach）** | 只供人理解，不约束执行 | — |
| | **计划调整（Plan Adjustment）** | 执行中由 Agent 提出、用户审批，产生新版本 | — |
| 授权 | **授权项（Authorization Grant）** | 权限类型 + 对象范围（列举 / 条件 / 引用上游交付件）+ 所属里程碑 + 可选次数上限。**只在所属里程碑内有效，验收通过即收回**；次数按**仍然生效的效果**算，不随回退或重开清零 | ergou 的"预批准"就是它的泛化 |
| | **扩大授权** | 超出授权时选择放宽，等同于出一版新计划 | — |
| | **由你验收（User Acceptance）** | 写不成可核对条件的标准，授权时就预先标明执行到这里会停 | "事先告诉你会在哪里停"是减少意外打断的关键 |
| | **事前授权（Pre-authorization）** | 把全部敏感标注集中呈现，一次确认，之后 Agent 自主执行到底；_Avoid_ 逐步确认 | — |
| | **执行时确认（Runtime Confirmation）** | 事前授权之外，少量固定动作执行到时仍要当场确认 | — |
| 策略 | **安全策略（Security Policy）** | 统一配置，判定"哪个工具做什么行为"算敏感。**工具本身不携带安全属性** | ergou 的"用户自定义提醒类别"应该放在这一层 |
| | **规则集 / 补充规则 / 里程碑安全策略** | 规则库里可复用的原子规则集，每条有人话说明和时序公式；补充规则只能收紧；每个里程碑一套 | — |
| | **处置级别（Enforcement Level）** | 红线（拦下，任何授权都豁免不了）/ 拦截（拦下，告诉 Agent 换做法）/ 确认（当场问用户） | ergou 可以把它扩成"提醒强度" |
| | **敏感标注（Sensitivity Mark）** | 分两类：敏感数据使用（读或外发联系人、位置、照片……）和敏感操作（发送、支付、删除、计划外访问……） | 这就是"安全类别"写死的地方，见 §7.2 |
| | **计划外动作（Off-plan Action）** | 做了计划里没有的事；_Avoid_ "越权步骤"（未必越权，只是没事先告知） | — |
| 事后 | **缩放层级（Zoom Level）** | 对话层 / 要点层 / 全局层，外加里程碑抽屉（取代了原来的第四档"计划层"） | 用户点名要继承的"全局层 / 要点层" |
| | **一镜到底（Continuous Zoom）** | 没有页面跳转，整条历史像地图一样等比缩放；捏合处那段历史停在原位 | — |
| | **历史段 / 内容类型 / 风险点 / 步骤要点** | 色块、按内容性质着色、缩略视图里突出的敏感标注、一句话概括 | — |
| | **里程碑书脊（Milestone Spine）** | 要点层和全局层左侧 3px 色条，一个里程碑的一轮是一段，颜色是这一轮的验收结果 | — |
| 回退 | **会话树 / 会话回退 / 废弃分支 / 回退点** | 按时间回退，从较早位置长出新分支，原分支保留 | — |
| | **里程碑重开（Reopen）/ 重开范围 / 重开通知 / 补偿里程碑 / 重开复验** | 按依赖重开，不倒带；范围 = 图上的下游 + 实际读过被重开内容的里程碑 | 长任务"返工"的正确姿势 |
| | **副作用撤销（Effect Undo）** | 撤销真实世界里的效果，由合作方实现，本项目只留了接口 | — |

---

## 2. 它怎么用 pi

### 2.1 包与版本

- `web/package.json:14-15` 依赖 `@earendil-works/pi-agent-core ^0.85.1` 和 `@earendil-works/pi-ai ^0.85.1`。node_modules 里还有 `@earendil-works/chord`、`pi-telemetry`（core 的依赖）。即 pi-mono 现在用 `@earendil-works/*` 这个 scope 发布。【建议】ergou 开工前要再确认最新的包名和版本。
- **没用 `pi-coding-agent`**。ADR 0001 写明只移植 `pi-ai` + `pi-agent-core`（含 harness 和 session），不要 coding-agent 的 CLI、TUI、Node 文件层（`docs/adr/0001-pi-runs-inside-arkweb.md:3`）。所以 AgentSense 用的是 **harness hooks**，不是 pi-coding-agent 的 extension 系统。
- pi-agent-core 有两层：低层的 `Agent` / `agentLoop`（`beforeToolCall` / `afterToolCall` 回调），和高层的 `AgentHarness`（持久会话、lane、hook 注册表、队列、压缩、分支导航）。AgentSense 只用高层。

### 2.2 嵌入方式与桥接

```
HarmonyOS HAP（ArkTS，约 350 行，只是壳和桥）
  pages/Index.ets     铺满屏的 Web 组件，src=$rawfile('web/index.html')
  bridge/NativeBridge  getSetting/setSetting（preferences）、log（hilog）、platform、fs、setCanGoBack
  bridge/FsBridge      单入口 call(op, argsJson)：沙箱 filesDir/vfs 里的小文件系统
  经 javaScriptProxy 注入网页成为 window.native
  └─ ArkWeb：rawfile/web/index.html（约 1MB 单文件，JS/CSS 全内联）
       React 19 UI + pi-agent-core（循环、会话树、hooks）+ pi-ai（→ 云端 DeepSeek，直接 fetch）
```

- `AgentSense/entry/src/main/ets/pages/Index.ets:26-40`：Web 组件加 `javaScriptProxy({ name: 'native', methodList })`。系统返回手势经 `runJavaScript('window.__agentsenseBack()')` 交给网页处理（`Index.ets:17-23`，网页侧在 `App.tsx:404-422`）。
- `NativeBridge.ets` 只暴露 6 个方法（`NATIVE_BRIDGE_METHODS`）。网页侧的抽象在 `web/src/native.ts`：没有 `window.native` 时退回 localStorage，并区分手机和浏览器的提示文案。
- **ADR 0001 的结论**（`docs/adr/0001-pi-runs-inside-arkweb.md`）：
  - 原以为要用 ArkTS 的 `net.http` 代发请求来绕开 CORS，实际 ArkWeb 里直接 `fetch` DeepSeek 就通，流式也正常。所以桥比预期还薄。
  - 后台长时任务没有做。
- **持久化**：
  - pi 的 `JsonlSessionRepo` 接收一个自定义的 `FileSystem`（`web/src/agent/fs.ts:39` 的 `BridgedFileSystem`）。
  - 后端有两种：真机走 `nativeBackend`，调 `window.native.fs`；浏览器走内存 + IndexedDB（`fs.ts:157-339`，`preloadBrowserFs` 在 React 挂载前先把数据读进内存，见 `main.tsx:11-12`）。
  - 会话列表另存一份很小的摘要 JSON（`web/src/agent/sessions.ts`），这样列会话时不用逐个打开整份 JSONL。
- **网页版**（`web/scripts/serve-web.mjs`）：
  - 静态发同一份单文件 index.html。
  - `/api/deepseek/chat/completions` 是服务器带自己的 key 做的转发：白名单模型、限输出长度、按 IP 每分钟 20 次、全站每日 2000 次。
  - 由本地服务管理器托管，经 SSH 反向隧道和 nginx 上公网（`README.md:215-237`）。

### 2.3 用到的 pi API

| API | 位置 | 用途 |
|---|---|---|
| `AgentHarness.create({session, models, model, thinkingLevel:"high", systemPrompt, tools, toolExecution:"sequential"})` | `web/src/agent/runtime.ts:319-330` | 建 harness。**`toolExecution: "sequential"`** 很关键：保证每次检查看到的轨迹是最新的 |
| `harness.lane("main")`，`lane.prompt / abort / waitForIdle / inspectExecution / getTipId` | `runtime.ts:424, 514-520, 544-551` | 单 lane 驱动一个会话 |
| `harness.hooks.on("before_tool" / "after_tool" / "before_run_end")` | `runtime.ts:332-336, 338-422` | 全部安全和续跑逻辑的挂点，见 §2.4 |
| `harness.events.on(...)`：`run_start`、`run_end`、`message_start/update/end`、`tool_start/end`、`entry_added`、`navigation_end`、`retry_scheduled`、`fault`、`handler_error` | `runtime.ts:469-508` | 转成 `RuntimeEvent` 推给 UI，用于流式渲染和刷新会话 |
| `lane.appendCustomEntry(type, data)` | `runtime.ts:306, 457` | 写不进模型上下文的自定义条目：`guard_ledger`（每轮总账）、`milestone_plan`（扩大授权或补偿产生的计划调整）、`milestone_reopen` |
| `lane.navigateTree(targetId, {summarize, label, customInstructions})` | `runtime.ts:530, 553-561` | 会话回退：在会话树上挪末端，同时让 pi 生成"被放弃分支"的中文摘要；切分支时 `summarize:false` |
| `session.findEntries({order:"asc"})`、`Entry` | `runtime.ts:465` | 读整棵树；UI 的全部视图都从这里纯函数推导 |
| `JsonlSessionRepo`、`MemorySessionRepo`、`FileSystem`、`ok/err/FileError` | `sessions.ts`、`fs.ts`、`runtime.ts:318` | 持久化 |
| `AgentHarnessTool<…>` + `typebox` 的 `Type.Object(...)` | `tools.ts`、各场景、`controller.ts:1328-1394` | 工具定义。`execute` 返回 `{content, details}`；`details` 放结构化数据（effectKey、reads、writes、policy、milestone 事件、mplan） |
| `createModels / createProvider / openAICompletionsApi` | `web/src/agent/model.ts` | DeepSeek 走 openai-completions 兼容层（`thinkingFormat:"deepseek"`、1M 上下文） |
| `fauxProvider / fauxAssistantMessage / fauxToolCall / fauxThinking` | `web/src/agent/demoScript.ts:14, 64`、`planDemo.ts`、`milestone/demo.ts` | 脚本回放演示和端到端回归：真实链路，只把模型换成预设脚本 |
| `BACKGROUND_CONTEXT` | 多处 | pi 的取消上下文 |

**没用但在场的**：`transform_context`、`before_run`、`before_compaction`、`before_navigation`、`before_request`、`before_payload`、`after_response`、`steer`、`followUp`、`nextRun` 队列、`setActiveTools`、compaction 设置、skills / prompt templates、`retry` 策略（用默认）。

### 2.4 三个 hook 怎么用（策略/审批层的核心）

pi 的 hook 签名见 `web/node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:485-605`。

- **`before_tool`**：事件是 `{toolCallId, toolName, args}`，返回 `{args?, block?:{reason, terminate?}}`。
  - **可以是 async**：AgentSense 在这里 `await broker.requestRuntimeConfirmation(...)`，也就是把一个 Promise 交给 React 弹窗，等用户回答（`runtime.ts:371-381`、`useAgent.ts:105-113`）。
  - `block.reason` 会作为工具结果回给模型。措辞是刻意设计的："这一条不会因为重试而通过"（`runtime.ts:366`），因为实测模型看到"被拦截"会原样再调一次。
  - 自动纠偏的"引回"也是一次 block，前缀写 `【自动纠偏】`（`plan.ts:372`），系统提示里告诉模型这类结果照做、不用问用户（`runtime.ts:65`）。
  - 返回 `{args}` 可以**静默改参数**（rewrite 纠偏，`runtime.ts:362`）。
- **`after_tool`**：
  - 把这次判定（`PolicyAssessment`）合并进 `details.policy` 一起落盘（`runtime.ts:384-395`）。UI 和重开会话时都从会话树把它读回来。
  - 参数被改写过时，在 `content` 前面补一句"按计划参数执行的结果"，免得模型拿着自己那版参数往下推。
  - 只有 `!isError` 的调用才 `monitor.commit` 进轨迹：失败的调用没改变世界，不该满足任何"之前做过"的前提。
- **`before_run_end`**：返回 `{followUp: string}`，让 Agent **不收工、接着跑**。
  - 固定计划：每轮最多提醒一次，还欠着的步骤要么补做，要么用 `report_step(skipped)` 说明（`runtime.ts:401-422`）。
  - 里程碑：最多催 3 次，见 §3.2。
  - 这是"长任务一定做完"在 pi 里的落点。

### 2.5 pi 原生 vs 自建

| pi 提供的 | AgentSense 自建的 |
|---|---|
| 循环、流式、模型协议、重试 | 计划工具：`propose_plan` / `report_step`（固定计划）；`propose_milestones` / `claim_milestone` / `submit_milestone` / `request_adjustment`（里程碑） |
| 工具执行与 hook 调度（顺序、出错上报） | `UserBroker` 接口（`plan.ts:191-202`）：事前授权、执行时确认、里程碑授权、超出授权的决定、由你验收、失败决定。都是 Promise，由 UI 实现 |
| 会话树（JSONL）、分支导航 + 分支摘要、自定义条目 | 守卫 `guard.ts`、监控外壳 `planguardMonitor.ts`、审查器 `planguardReviewer.ts`、里程碑控制器 `milestone/controller.ts`（1578 行） |
| FileSystem 抽象 | planguard 引擎（`web/src/agent/planguard/`，从 SafetyProtocolSolver 原样同步，不在本仓库改） |
| faux provider | 规则库 `policies/`、拼装 `milestone/policy.ts`、校验 `scripts/policies-check.ts` |
| — | 会话视图推导 `sessionView.ts`（741 行）、总账、效果记录、重开、注入解释 |
| — | 场景抽象：`Scenario`（模拟世界 + 工具 + 规则 + 提示 + 世界钩子） |

### 2.6 对策略/审批层重要的 pi 扩展点

- **必需**：
  - `before_tool`：拦截、改参数、异步等人。
  - `after_tool`：判定写进 `details` 落盘；可以改写 `content` 和 `isError`。
  - `before_run_end` 的 `followUp`：续跑和催促。
  - `appendCustomEntry`：总账、计划调整、重开这类不进上下文的记录。
  - `toolExecution: "sequential"`。
  - `navigateTree` 的 `summarize`、`customInstructions`。
- **【建议】ergou 值得用、AgentSense 没用的**：
  - `transform_context`：每轮把"当前授权计划 + 当前里程碑 + 用户约束"重新注入系统提示或消息尾部，对抗压缩丢约束（Summer Yue 事故）。AgentSense 靠 1M 上下文且不压缩，没遇到这个问题。
  - `before_compaction`：压缩时保留计划和授权条目。
  - `setActiveTools`：按模式或阶段收窄工具，比如普通聊天只开只读工具，进入长任务模式再开写工具。
  - `steer`：用户中途插话。
  - `terminate`：拦下后让循环停下等人，而不是让模型再说一轮。

---

## 3. 计划模型，以及长任务怎么一直做到完

### 3.1 固定计划（版本一）

**数据**：`Plan{version, goal, steps:[{id,title,tool,args,after?,inserted?,patches?}], constraints?}`（`plan.ts:4-30`）。`AnnotatedPlan` 给每一步加上 `marks`（敏感标注）和 `review`。

**规划时**（`runtime.ts:194-256`）：

1. 模型调 `propose_plan`。系统提示要求**动手前必须先交完整计划**，未授权前不得调用业务工具（`runtime.ts:54-74`）。
2. `reviewer.review(plan)` 走 planguard（`planguardReviewer.ts:122-171`）：
   - 按规则在"假想序列"上做三值求值，找出违规；
   - 按规则声明的修法（insert / rewrite / move_after / confirm / replan）生成候选；
   - 求解器按代价和用户目标挑最优组合，给出修补后的计划；
   - 时间预算 50ms，超时或出错返回 `skipped`，退回原来的流程（`planguardReviewer.ts:20-42`）。
3. 按状态分流（`runtime.ts:207-256`）：
   - `needs_replan`：**不打扰用户**，直接把补充要求作为工具结果退回模型，让它重提。
   - `blocked`：不请求授权，让模型把原因讲给用户。
   - `pass` / `patched` / `needs_confirmation`：**修补后的计划才是授权对象**，请用户授权。工具结果里把修补后的完整步骤写给模型，并强调"插进来的步骤即使你认为做过也要再做一遍"。
4. **不替用户点头**（`plan.ts:112-126` 的 `confirmationItems`）：
   - 要用户逐条勾选的事项有三个来源：审查明说要问的、修补本身带人工代价的（比如"先备份再删"）、目标打架时被放弃的那个。
   - 审查说要问却说不出问什么时，给一条兜底项。勾完才能授权。
5. 用户的目标从哪来：`propose_plan.constraints` 写约束 id，场景的 `goalTemplates` 把它翻成审查目标（比如 `min_freed_mb`、`budget`、`depart_after`，见 `storage.ts:181-186`）。

**执行时**（`runtime.ts:338-382` + `guard.ts:75-238`），每次业务调用的处理顺序：

1. 没有已授权的计划：直接拦下。
2. 判定：`classify` 给出敏感标注；`monitor.check` 给出 planguard findings，类别有 `off_plan`、`forbidden`、`out_of_scope`、`repeat`、`out_of_order`、`rule:*`、`rule_unknown:*`、`checker_error`。
3. **能不打扰就修回**（`tryAutoFix`，`guard.ts:168-238`）。只修三类可修问题（`out_of_scope`、`out_of_order`、`rule:*`），而且不碰硬拦截（`forbidden`、`repeat`）：
   - **redirect（引回）**：这次调用对上了计划里某一步，但前置步骤还没做（顺序错，或者规则声明的修法是"先插一步 X"而计划里正好有还没做的 X）。这次不执行，用 `【自动纠偏】` 告诉模型先去做哪一步、参数是什么（`guard.ts:184-209`）。
   - **rewrite（改回）**：参数和计划对不上，就按计划值改回来，然后**完整复检一遍**，全部通过才放行（`guard.ts:211-236`）。**认对象的参数不改**，比如收件人、文件路径、航班号，取自 `conformance.within` 引用的 `$call.args.X`（`planguardMonitor.ts:168-180`）。换对象不是小偏差。
   - **上限**：同一个"工具 + 步骤"自动修 2 次还对不上，就改为找用户（`MAX_AUTO_FIX`，`guard.ts:69`）。
4. 修不了的：
   - planguard 判 `block`：直接拦下不问。那是审查时已经排除掉的对象，再问一次等于把拒绝过的事重新摆到用户面前（`guard.ts:1-10`）。
   - 判 `confirm`：当场问一次（理由是 deviation 或 rule_violation）。
   - 其余按敏感标注：`alwaysConfirm`、计划外的敏感操作、敏感点不在授权集合里，这三种问。
5. **同一件事只问一次**：问题的身份 = `类别|原话`（`guard.ts:47`）。原话里带对象，所以对象级的问题换个对象会重新问；步骤级的问题在同一步里只问一次。一个步骤删 12 个文件，不会弹 12 次。
6. **收尾提醒**（`runtime.ts:401-422`）：一轮要结束时，还有步骤既没做也没说跳过，就替 Agent 补一句 followUp。每轮一次；这一轮没干活不提醒。
7. **世界在变**：引擎的 `Monitor` 构造时就把事实固定了。外壳的办法是每次检查前取新事实，**事实变了才重建**，并重放已成功执行的调用（`planguardMonitor.ts:94-117`）。这一改把真机上的 1.2ms 压了下来。计划修订、回退、切分支时也从当前分支重建并重放（`runtime.ts:279-293, 522-583`）。
8. **出错策略**：监控出错按 `confirm` 处理，不能因为检查器坏了就放行（fail closed，`planguardMonitor.ts:119-130`）；审查出错返回 `skipped`，不能因为检查器坏了就卡死。
9. **总账**：每轮结束写进一条自定义条目，不进模型上下文（`runtime.ts:443-462`）。记的是：动作数、其中敏感的（= 逐个授权要打断几次）、核对次数、偏差、自动修回、拦下、问你、同类已确认、计划授权次数、耗时。`generation` 计数防止"运行中途回退了，旧分支的账写到新分支上"。

### 3.2 里程碑计划（版本二）

**为什么有它**（ADR 0002）：同事反馈每一步都定死的计划不利于执行，比如比价要看到价格才知道在哪家下单。团队没有改固定计划，而是并存一种新模式。

**数据**（`milestone/types.ts`）：

- `Milestone{id, title, deliverable, criteria:[{id,text,expr?}], mode:"stepped"|"open", steps?, approach?, after:[], choice?:{group,when}, grants:[], policies:[], supplementary?, budget?}`（71-94）。
- `Grant{id, kind:GrantKind, scope: list|where|ref|any, limit?, text?}`（43-51）。
- `MilestoneStatus`：pending / in_progress / submitted / accepted / failed / skipped（二选一没走的）/ abandoned。
- 阈值（220-226）：`DEFAULT_BUDGET=50`、`MAX_PULLBACK=3`、`MAX_NUDGE=3`、`MAX_RETRY=2`。

**计划制定**（`controller.ts:199-282`）：

1. 模型调 `propose_milestones`。系统提示（`milestone/prompt.ts`）会教这些：
   - 怎么拆并行（画成图，不要串成线，附一个与场景无关的结构示意）；
   - 授权项怎么写（`$obj` 是对象 id，不是记录）；
   - 表达式语言；
   - 本场景的工具权限类型、底线、可选规则集、事实结构。
2. `annotate` 是**确定性的计划检查**，查出问题就退回模型重写，**不打扰用户**：
   - `validatePlan`（`check.ts:78-123`）查：环、重复 id、缺交付件或验收标准；授权种类不认识；pay / subscribe / account 永不授权；对外或不可逆的操作必须带 limit；`any` 范围必须带 limit；`ref` 必须引用上游；二选一的分组前置要相同。
   - `composePolicy`（`policy.ts:95-229`）拼出每个里程碑的规则文档，见 §4.2。
   - `selfCheck`（`check.ts:217-266`）对当前世界先跑一遍验收标准：一开始就满足的提示"太松"；空交付件就能全过的标为 `loose`；表达式写错、引用了不存在的事实路径的退回模型。
   - `stopsAhead`（`check.ts:269-291`）算出**授权后还会在哪里停下来**：由你验收的标准、授权对象要等上游做完才确定的地方、每次都要确认的工具。
3. 用户授权（`MilestonePlanCard`，`ui/milestone.tsx:527-736`）：
   - 授权项逐条勾选。**不勾的到那一步再问你**（`decision.withhold`，`controller.ts:258-269`）；也可以一键全部勾上。
   - 卡片写明"授权后还会在 N 处停下来等你"。
   - 计划调整时，含义相同的授权项沿用，已验收里程碑的授权项不再列出。

**执行：认领 → 动手 → 提交 → 验收**

1. **认领**（`controller.ts:305-374`）：
   - 前置里程碑都验收了才能认领；一次只认领一个；二选一的分叉要写 reason。
   - **定步里程碑在认领时按当下的真实事实审查**（`reviewAtClaim`，`controller.ts:287-303`）：往保守方向的修补（只 rewrite 或 insert 读、备份类步骤）直接采用；要放宽的才问用户。为什么不在制定计划时审：那时上游还没做，"哪些已备份"这类事实都还不知道。
   - 授权对象引用了上游交付件，而上游不是由你验收的、授权又没写上限时，认领时把确定下来的对象拿给你过目一次（`materialize`，`controller.ts:343-367`）。
2. **每次工具调用的检查**（`beforeTool`，`controller.ts:735-1019`），顺序就是优先级：
   1. 没有已授权的计划：拦下。
   2. **底线不看进度**：没认领也先查底线。碰了底线任何时候都是拦下（`controller.ts:780-828`）。这是观众亲手操作后修的一个严重问题，见 §6。
   3. 没认领：**拉回**（先 `claim_milestone`）。
   4. 规则判"确认"或判不了：当场问。
   5. 你在清单上没勾、或当场拒绝过的对象：直接拦下，不再问。
   6. 碰过底线的地方（同一个平台或渠道）要做对外的事（下单、发送、共享、退订）：先问你。如果这件事本来也没授权，就合成一个问题，不连着弹两个框。
   7. 定步里程碑：工具不在步骤里就拉回。
   8. 授权项检查：
      - 这个里程碑没有这类授权，但别的里程碑有：拉回。
      - 都没有：问"只这一次 / 这一步都允许 / 拒绝"。
      - 对象不在范围里：同样问。
      - 范围暂时判不了：请你过目。
      - 次数（**按仍然生效的效果**算）用完：同样问。
   9. 预算：超过 1 倍时拦一次，让 Agent 说明进展；超过 2 倍时问你。
   - 拉回连续超过 3 次就找你（`drift`），见 `controller.ts:754-778`。
3. **提交与验收**（`submit`，`controller.ts:402-553`）：
   - 验收脚本是 planguard 表达式，环境里有 `$facts`（世界状态）、`$deliverable`、`$deliverables`（上游）、`$task`，**只读世界，不看 Agent 怎么说**。
   - 有由你验收的标准时，弹 `AcceptanceDialog`：可以逐项勾清单（默认一项都不勾，Agent 的建议只做标记），按你勾的算并转告 Agent；你去掉的进入 `excluded`，之后 Agent 再动它直接拦下。
   - **验收通过但值得你看一眼**（`attention`）：先停下请你看（`LookDialog`），因为后面可能是发消息这类收不回的事。你可以当场选"从这一步重做"。
   - 没通过：最多退回 2 次（`MAX_RETRY`）。退回给 Agent 的说明里带上核对表达式、它自己交的值、要对照的事实路径，**不直接给答案**（`explainCriterion`，`controller.ts:1522-1546`）。
   - 第 3 次还不过：判为未通过，请你选"调整计划 / 再给一次机会 / 放弃"（放弃时下游一并作废）。**不受影响的里程碑照常推进**。
4. **催促**（`beforeRunEnd`，`controller.ts:1111-1146`）：
   - Agent 想收工，但还有认领着没交的、能认领的、或未通过待调整的里程碑，就用 followUp 告诉它具体差什么。
   - 连续 3 次没有进展就停下，通知你。
   - **你刚说了"不"就不催**（`userSaidNo`）。停下来如实说明是正确行为，记为 `stoppedByUser`。
5. **计划调整 / 扩大授权**：
   - `request_adjustment` 走同一套检查和授权；`applyPlan` 保留已验收、未走、已废弃的里程碑，做到一半的回到未开始（`state.ts:106-124`）。
   - 扩大授权会直接写一条 `milestone_plan` 自定义条目，出一版新计划（`controller.ts:1064-1084`）。
6. **结果由系统查**：每轮结束调 `scenario.milestone.outcome(world)`，写出"系统直接查到的结果"（下没下单、删了哪几张、退了哪些），放在把关记录最上面（`runtime.ts:448-456`）。

### 3.3 按依赖重开，不按时间回退（ADR 0003）

- **问题**：时间上的先后不等于依赖上的先后。按时间回退会把不相干的并行里程碑一起扔掉。
- **范围**（`reopenPreview`，`controller.ts:1225-1271`）：起点 + 图上的全部下游 + **实际数据依赖**，并对后者再取下游。实际数据依赖指范围外的里程碑在当前这一轮里读过范围内先写下的对象，由工具 `details` 里的 `reads` / `writes` 确定性地算出。
- **重开前的通知**把效果分成三类：
  - 本机可撤：交给 `undo`。
  - 对外可补救：生成**补偿里程碑** C1…，排在被重开那个里程碑的前面，算一次计划调整。
  - 对外收不回：只列出来，并告诉重做的 Agent。
- **只追加，不倒带**：写一条 `milestone_reopen` 自定义条目；原来那一轮标为"已废弃"，留在原处；Agent 在同一条时间线上重新认领（`controller.ts:1273-1324`、`runtime.ts:585-608`）。
- **复验**：用验收脚本重跑范围外已验收的里程碑，复验没过的问你要不要一起重开（`App.tsx:813-842`）。
- **额度按仍然生效的效果算**：回退和重开都不会把世界退回去，所以次数上限按"世界上仍然生效的效果"算（`inForceCount`，`controller.ts:594-604`），否则回退之后 Agent 就能再下一单。固定计划仍有这个缺陷，是已知待办（`docs/security-experience.md:143`）。

### 3.4 状态从哪来："会话树是唯一真相源"

- 里程碑状态完全由当前分支上的条目推导（`milestone/state.ts:1-10, 219-263`），用的是 reduce 式的 `applyPlan`、`applyEvent`、`applyReopen`。
- 运行时和 UI 用的是**同一个推导**。回退、切分支、重新打开会话后重推一遍即可（`controller.ts:1211-1221`）。
- 事件来源：
  - `propose_milestones` / `request_adjustment` 结果里的 `details.mplan + decision`；
  - `claim` / `submit` 结果里的 `details.milestone`；
  - 业务调用的 `details.milestone.event=call`，带 effectKey、reads、writes；
  - 自定义条目 `milestone_reopen`、`milestone_plan`。
- 模拟世界不持久化。重新打开会话时，按时间顺序把**所有分支**上成功执行过的调用重放一遍（因为会话回退本来就不退世界），重开时撤回过的再撤回一次（`replayWorld`，`controller.ts:1170-1191`）。【推测】真实世界里没法这样做，ergou 要换成"效果日志 + 真实状态查询"。

### 3.5 "做完"的保证：机制总表

| 失败形态 | AgentSense 的对策 | 打扰用户吗 |
|---|---|---|
| 没计划就动手 | 未授权前所有业务工具被拦 | 否 |
| 偷懒提前收工 | `before_run_end` followUp：固定计划每轮 1 次，里程碑最多 3 次 | 否；3 次无进展才通知 |
| 跑出当前阶段 | 拉回，并重述验收标准 | 否；连续超过 3 次才问 |
| 顺序错、缺前置步骤 | redirect 引回计划里那一步 | 否 |
| 参数写错 | rewrite 按计划改回，复检后放行 | 否；不换对象，每步最多 2 次 |
| 谎称做完、幻觉结果 | 验收脚本对照真实世界；退回时附带"核对什么、你交了什么" | 否；交 3 次都不过才问 |
| 卡死、耗时太长 | 超预算先让它说明进展；到 2 倍再问 | 2 倍时问 |
| 外部故障（登录失效） | 用中性色标为外部问题，模型可以提出计划调整 | 计划调整需要批准 |
| 需要返工 | 按依赖重开 + 补偿 + 复验 | 用户发起 |
| 约束被遗忘（上下文压缩） | 授权和规则存在模型之外，由 harness 执行 | — |

---

## 4. 安全模型与打断模型

### 4.1 两套判定并存，取更严的一方，只问一次

- **敏感标注**（`policy.ts`，每个场景的 `rules: Rule<W>[]`）回答"这次动作碰了什么"：
  - TS 代码写的 `evaluate(tool, args, ctx)`，返回 `SensitivityMark{ruleId, kind:"data"|"op", label, subject?, severity:"normal"|"high", alwaysConfirm?}`（`policy.ts:7-33`）。
  - 用来画风险点、算"逐个授权要打断几次"、判断授权集合，以及 `alwaysConfirm`。
- **计划一致性 + 安全规则**（planguard）回答"这次动作和授权过的计划对不对得上、违不违反规则"。
- `guard.ts` 把两套结论合并（`guard.ts:1-10, 75-131`）：取更严格的一方，**只向用户确认一次**。
- **工具本身不携带安全属性**（`README.md:259`、`tools.ts:10`）。里程碑模式下，`policies/scenarios/*.json` 给每个工具标了 `grant`（权限类型）、`object`（认对象的参数）、`untrusted`（页面内容不可信）。这是放在工具**之外**的一份清单。

### 4.2 规则库：原子规则集（ADR 0004、`policies/README.md`）

**一个规则集**（`policies/sets/*.json`）的字段：

- `id`、`name`；
- `risk`：一句人话，说它防什么；
- `level`：红线 / 拦截 / 确认；
- `formula`：给人看的中文时序公式，比如 `G(删除(f) → O 备份(f) ∨ 已备份(f))`；
- `vocab`：中文词到接口的映射（工具名、字段名，或 `$param.X`）；
- `attach`：自动挂载条件，`whenGrant:[...]`、`whenAllGrantsRead`、`perTool`；
- `params`：`static` 在拼装时替换字面值，`dynamic` 每次检查时求值，可以绑定 `$deliverables.M2.x` 或 `$task.x`；
- `needsFacts`：场景提供不了这些事实就不能选这个规则集；
- `rules`：planguard 格式；
- `cases`：正反用例。

**拼装**（`milestone/policy.ts:95-229`）：

```
里程碑策略 = 场景底线（scenarios/*.json 的 baseline，必挂）
           ∪ 授权触发（attach 命中，必挂；perTool 时按工具各挂一份）
           ∪ 模型挑选（只能从场景的 optional 里挑）
           ∪ 补充规则（模型写，只能用 trigger + require.check/before/not_before，不能带 repairs/unless，处置只能 block/confirm）
```

- 规则之间是"并且"，加任何一条都只会更严。
- 进入下一个里程碑就换一套策略，但"曾经"（`before`）在**整条时间线**上判定：前一个里程碑做过的备份，能满足后一个里程碑的"删除前必须备份"。
- **授权项和规则集分工**：授权项管"动哪些、动几次"，可以当场放宽；规则集管顺序、红线、数据流，不能当场放宽（`policies/README.md:15-23`）。
- **模型只能挑，不能写整套**：这样才守得住"检查方不是提计划的那个模型"这条立论。

**17 个规则集**（`policies/sets/`）：

| id | 名字 | 级别 | 公式 | 挂法 |
|---|---|---|---|---|
| no-payment | 不许支付 | 红线 | `G ¬(付款 ∨ 转账)` | 底线 |
| no-address-change | 不改收货地址 | 红线 | `G ¬改地址 ∧ G(下单(o) → 地址(o)=默认地址)` | 比价底线 |
| no-off-platform-contact | 网页上写的话不当指令 | 红线 | `G ¬(联系客服 ∨ 打开外部链接 ∨ 加好友)` | 比价底线 |
| no-new-subscription | 不许开通、续费、领试用 | 红线 | `G ¬(开通 ∨ 续费 ∨ 领试用)` | 退订底线 |
| no-payment-method-change | 不改支付方式 | 红线 | `G ¬改支付方式` | 退订底线 |
| protect-outside-window | 时间范围外的照片不删、不外发 | 红线 | `G((删除(p) ∨ 共享(p)) → 拍摄时间(p) ∈ [from,to])` | 照片底线 |
| backup-before-delete | 删除前必须备份 | 红线 | `G(删除(f) → O 备份(f) ∨ 已备份(f))` | 有 delete 授权就自动挂 |
| scan-before-delete | 删除前必须扫描过所在目录 | 拦截 | `G(删除(f) → O 扫描(dir(f)))` | 有 delete 授权就自动挂 |
| list-before-cancel | 退订前必须查过该渠道的清单 | 拦截 | `G(退订(s) → O 查清单(渠道(s)))` | 有 cancel 授权就自动挂 |
| no-repeat-external | 同一对象的对外动作不重复 | 拦截 | `G(动作(x) → ¬O 动作(x))` | 有 order/cancel/send/share 授权就自动挂，按工具各一份 |
| read-only | 只读 | 拦截 | `G ¬写操作` | 授权全是读时自动挂 |
| no-sensitive-photo-share | 证件照和截图不外发 | 拦截 | `G(共享(p) → ¬(证件(p) ∨ 截图(p)))` | 照片底线 |
| outbound-no-private-fields | 外发内容不带隐私字段 | 拦截 | `G(外发(m) → ¬匹配(正文(m), 隐私字段))` | 可选 |
| coupon-only-for-item | 只领本商品能用的券 | 拦截 | `G(领券(c) → 适用商品(c)=sku)` | 可选 |
| order-matches-quote | 下单必须是比价最低价 | 拦截 | `G(下单(o) → 平台/商品=quote ∧ 数量 ≤ qty)` | 可选 |
| no-refund-request | 退订不顺带申请退款 | 拦截 | `G ¬申请退款` | 可选 |
| usage-metadata-only | 使用记录只看打开时间 | 拦截 | `G(读使用记录(f) → f ∈ {最近打开时间, 打开次数})` | 可选 |

注意：库里**没有一个规则集是"确认"级**。"确认"只会来自补充规则，或者"判不了"（unknown）。

**校验**（`web/scripts/policies-check.ts`，`npm test` 第一步）：

- 用例要过（60 条）。
- **公式和规则要对得上**：中文词都在 `vocab` 里，`vocab` 指向的工具正是 rules 判的工具。
- **规则读到的参数名在工具的真实参数里都有**。参数名写错时引擎不报错，只会判成"不知道"，执行时转去问用户，所以要提前查（`CHANGELOG.md:7-18`）。

### 4.3 planguard 引擎（固定计划审查与执行时检查；里程碑的判定也交给它）

- **来源**：`D:/code/claudecode/protocol_solver/SafetyProtocolSolver/planguard/ts/src/`，把 7 个文件原样复制到 `web/src/agent/planguard/`。`VERSION` 里记了每个文件的 sha256。不复制 Z3（WASM 太大，`resource://` 下也没有跨源隔离）。**约定不在本仓库改引擎**，问题记进 `docs/planguard-upstream.md`（9 条）。
- **规则形状**：
  - 字段有 `trigger{tool}`、`when`、`unless`、`for_each`、`require{before | not_before | check}`、`modes`、`on_violation`、`repairs[insert | rewrite | move_after | confirm | replan]`、`message`（`planguard/spec.ts:9-13`）。
  - 对应的时序形状：`G(触发 → O 要求)`、`G(触发 → ¬O 要求)`、`G(触发 → 条件)`、`G ¬触发`（`docs/milestone-plan.md:84-90`）。
  - **只看过去**，所以在"已经发生的那一段"上就能判出结论，不用猜未来。**一份规则可以在规划时和执行时两个时机求值**（`README.md:117-127`）。
- **三值**：满足 / 违反 / 判不了。
  - 规划时参数常常未知（不符合 `tools.<tool>.args.pattern` 的值会被包成 `Unknown`），判不了的推迟到执行时。
  - 执行时判不了的不放行，转去问人。
- **计划一致性**（`conformance`，`travel.planguard.json:526-552`）：
  - `sensitive`：计划外调用这些工具时要确认，其他计划外调用直接放行；
  - `once`：只许做一次；
  - `within`：调用参数和步骤参数要对得上，同时决定了"认对象的参数"；
  - `forbid`：审查时排除掉的对象。
- **其他能力**：
  - `choices`：求解器替计划选参数，比如选哪个航班；
  - `binds`：选定后自动改写下游参数，比如约车时间 = 落地 + 换乘；
  - `quantities`：比如 `freed_mb`、`spend`；
  - `goals`：带权重，冲突时放弃权重小的。
- **性能**（`CHANGELOG.md:396-400`、`README.md:125`）：真机审查最长 18.7ms；单次执行时检查平均 1.9ms，最长 4.1ms；里程碑规则每条 0.1–10µs。纯搜索是穷举，约 12 个耦合违规时 35ms，16 个时 0.3s，所以要有预算。
- **固定计划的场景规则**：O1–O4（办公外发）、S1–S3（存储删除）、T1–T7（出差改签），见 `web/src/agent/scenarios/*.planguard.json`。

### 4.4 一次操作怎么被分类（三层）

1. **工具到权限类型**（里程碑）：`policies/scenarios/*.json` 的 `tools.<name>.grant`。共 12 种 `GrantKind`（`types.ts:10`）：read、claim、order、cancel、delete、upload、share、send、pay、subscribe、refund、account。
   - `COUNTED_KINDS`（对外或不可逆，必须写次数上限）：order、cancel、delete、share、send、claim（`types.ts:28`）。
   - `NEVER_GRANTED`（永远只能由用户本人做）：pay、subscribe、account（`check.ts:23`）。
   - `TAINT_KINDS`（碰过底线的地方，做之前要先问）：order、send、share、cancel（`controller.ts:731`）。
2. **调用到敏感标注**（两种模式都有，用于展示和计数）：每个场景用 TS 写的 `rules`，产出 `data` 类和 `op` 类标注，带 severity 和 alwaysConfirm。完整清单见 §4.8。
3. **调用到规则判定**：planguard 或拼好的规则集给出 allow / confirm / block；再叠加授权项（范围、次数）和控制器的结构规则（只在所属里程碑有效、前置都验收了才能开始、碰过底线先问、只做你勾的）。

### 4.5 什么时候打断用户，什么时候不打断

| 情况 | 固定计划 | 里程碑计划 | 打断？ |
|---|---|---|---|
| 计划提交 | 审查后授权一次（含逐条勾选的确认项） | 授权一次，授权项逐条勾 | **是**（每个任务 1 次） |
| 计划不合格（缺信息、写错表达式、引用不存在的事实） | `needs_replan` 退回模型 | `problems` 退回模型 | 否 |
| 计划不可行 | `blocked`：模型向用户解释 | — | 否（只是告知） |
| 偏了但能按计划修回 | redirect / rewrite / nudge | 拉回 / 催促 / 进展检查 | 否 |
| 审查排除过的对象、重复做 | 直接拦下 | — | 否 |
| 碰红线、违反"拦截"级规则 | （planguard 判 block） | 拦下，告诉 Agent 换做法 | 否 |
| 用户在清单上去掉过的对象 | — | 直接拦下 | 否 |
| 同类问题之前点过头 | 记住 `findingKey`，不再问 | — | 否 |
| `alwaysConfirm`（不可逆，比如改签、取消已付用车、删重要文件、翻计划外目录、付款） | 当场确认 | `support.alwaysConfirm` 只在 `stopsAhead` 里预告；运行时 `beforeTool` 没有单独实现（示例场景里这些工具本来就被底线拦下） | 固定计划：**是** |
| 计划外的敏感操作、超出授权的敏感点 | 当场确认 | 超出授权项：拒绝 / 只这一次 / 这一步都允许 | **是** |
| 规则是"确认"级或判不了 | 当场确认（deviation / rule_violation） | 当场确认 | **是** |
| 授权对象要等上游做完才确定 | — | 认领时请你过目一次（预告过） | **是**（预告过） |
| 由你验收 | — | 验收对话框（预告过） | **是**（预告过） |
| 验收通过但值得一看 | — | 先停下请你看一眼 | **是** |
| 交 3 次都不过 | — | 调整 / 再给一次机会 / 放弃 | **是** |
| 连续拉回超过 3 次 | — | drift 确认 | **是** |
| 预算 1 倍 / 2 倍 | — | 1 倍让 Agent 说进展；2 倍问你 | 2 倍时是 |
| 在碰过底线的地方做对外的事 | — | tainted 确认，和授权问题合并成一个 | **是** |
| 检查器出错 | 当场确认（fail closed） | 当场确认 | **是** |

**原则**（`docs/milestone-plan.md:213-224`、`CHANGELOG.md:228-278`）：

- 越谨慎不能越危险：开头没勾某项授权时，还没轮到的事照样拉回，不弹授权框。
- 授权框默认"拒绝"。
- 一个问题只问一次。
- 用户拒绝或不批准，算改主意，不算 Agent 失败，收尾也不催。
- 用户当场拒绝清单上的某一项，就把它从清单上拿掉，后面的验收照拿掉之后的清单核对。

### 4.6 规划时预授权怎么减少执行时的打断

- **授权粒度是"种类 + 对象范围 + 次数 + 所属阶段"**，不是"整个 App 始终允许"。所以授权范围内的批量动作执行中不再问。
  - 存储：按**目录**授权删除，删这个目录下的文件就不再逐个打断（`storage.ts:31-53`、`CHANGELOG.md:446`）。修这个之前是清理 34 张截图连弹 34 次。
  - 同一步里的同类问题只问一次（`findingKey`）。
- **事先说清还会在哪里停**：计划卡写"授权后还会在 N 处停下来"（`stopsAhead`），确认框写"拒绝会怎样"。用户预先知道"什么时候会被打扰"，体验上就不算意外打断。
- **审查替用户把计划修好**：插入前置步骤、改参数、调顺序、替计划选参数、剔除重要对象。这样执行时就不需要再为这些事问。
- **授权时一并确认带代价的修补和被放弃的目标**（`confirmationItems`），执行时就不再为它们打断。
- **实测**（`README.md:150-155`、`CHANGELOG.md:392-393`、`docs/milestone-plan.md:200`）：

  | 演示 | 逐个授权要打断 | 实际打断 |
  |---|---|---|
  | 会议行动项分发 | 6 次 | 1 次 |
  | 出差改签 | 4 次 | 3 次（1 次授权 + 2 次不可退操作确认） |
  | 存储清理 | 15 次 | 1 次 |
  | 自动纠偏演示 | 5 次 | 3 次 |

  另外：30 次真实运行里，执行时一共只打断 25 次（平均每个任务不到一次）；"腾出 2 个 G"那次执行阶段 0 次；真实 DeepSeek 跑比价整轮只打断 2 次。

### 4.7 "全局层"和"要点层"上显示什么

**这两层属于事后回看的缩放视图**，不是执行中的打断。它们解决的是用户回来时"一眼看懂刚才发生了什么"（`README.md:53-77`、`CONTEXT.md:162-170`、`ui/semantic.ts`、`ui/ZoomHistory.tsx`）。

- **对话层**（比例 1.0）：完整聊天，包括计划卡、工具行、横条、总账卡。
- **要点层**（0.45）：
  - 每段历史压成一个色块，**只写一行**：你 / 思考 / 回复写成"你：……"；工具调用写人话的那句；被拦下的前缀 ⛔，被拉回的前缀 ↩（`keyLine`，`semantic.ts:136`）。
  - 一个计划从提出到做完铺**一块浅黄底色**（`planSpans`，`semantic.ts:276`）。
  - 右侧有**风险标注**，带一根引线指回它在原文里出现的那一行。
  - 左侧有**任务卡**（一句总结，最多两行；点开看原话、目标、进度、授权、介入次数）、回退点 ↶，以及里程碑书脊。
- **全局层**（0.15）：
  - 色块里不再有文字，只剩内容类型的颜色分布：用户输入蓝、思考紫、回复灰、计划橙、上下文粉；工具调用一律绿，"只看"浅绿、"动手"原绿、"删除"原绿加红描边（`natureOf`，`semantic.ts:46`）。
  - 两侧照旧标风险点、任务分组、回退点；**废弃分支 ⑂ 只在这一层出现**。
  - 连续多条同样的风险只在第一条标"×N"（`repeatCounts`，`semantic.ts:329`）。
- **右侧风险标注会出现哪些**（`semanticsOf` 的 tool 分支，`semantic.ts:160-268`）：
  - `⚠ <op 标签>·<对象>`（敏感操作）和 `🔒`（读敏感数据，只在标题前加锁）；
  - `计划外动作`；
  - `✓ 当场确认` / `✕ 用户拒绝`；
  - `⛔ 拦下（底线）` / `⛔ 拦下` / `↩ 拉回` / `⏸ 先说进展` / `↺ 引回计划` / `↺ 参数已改回` / `↺ 提醒补做`；
  - `执行出错`；
  - 里程碑事件：`✕ 退回`、`✕ 未通过`、`⟲ 重开`。**验收通过不在右边标**，书脊变绿就说明了。
  - 等级分 high / op / data / fix，各有底色。
- 要点层和全局层的标注都可见：CSS 让 `o1 + o2` 互补，相加就是"缩小后一直可见"（`layout.css:487-488`）。

### 4.8 现有的全部类别清单

**A. 敏感标注**（各场景 TS 规则，`grep ruleId web/src/agent/scenarios/*.ts`）

- `data`：日程、联系人、内部文档、本地文件、行程、支付方式、相册、相册截图、扣费记录、App 使用时间 / App 内浏览记录。
- `op`：
  - 外发类：外发消息、发给外部人员、以你的名义发出会议邀请、以你的名义预约用车、发消息。
  - 计划外访问：访问计划外的文件、翻看计划外的目录。
  - 删除类：删除本地文件、永久删除·无回收站、批量删除约 N 个文件、删除重要文件 / 未备份的重要文件、删除照片。
  - 上传：上传到云端。
  - 改签与预订：改签机票·出票后不可退、更改酒店订单·收手续费、取消已付用车·不退款、本次改动已累计支出 ¥N。
  - 购物：下单（待支付）、领券、取消订单、改收货地址、付款 / 转账、联系客服 / 打开外部链接。
  - 照片共享：共享相册 / 取消共享。
  - 订阅：退订、开通 / 续费、申请退款、改支付方式。

**B. 权限类型**（`GrantKind` 12 种）及子集：COUNTED、NEVER_GRANTED、TAINT，见 §4.4。

**C. 规则集**（17 个）：见 §4.2。

**D. 固定计划场景规则**：

- O1 外发前先查通讯录；O2 读过仅限内部的文档后，不能原样发给外部；O3 发给外部的消息不含内部内容；O4 读文档写明范围。
- S1 删除重要文件前先备份；S2 删除前先扫描；S3 删除写明范围和数量。
- T1 改签前先查询；T2 酒店和用车排在改签之后；T3 / T4 原接机接不了要取消并重约；T5 赶不上保留时间要改酒店；T6 约车时间地点和新航班对得上；T7 扣款和查询到的差价一致。

**E. 执行时确认的原因**（`plan.ts:185`，文案在 `components.tsx:1034-1044`）：

- always："安全策略要求此类操作当场确认"
- off_plan："计划外的敏感操作"
- unauthorized："超出了你事先授权的范围"
- deviation："与已授权的计划不一致"
- rule_violation："违反了本场景的安全规则"
- drift："屡次偏离，拉回没用"
- budget："用到预算两倍"
- materialize："授权对象现在才确定"
- tainted："这里之前碰过底线"

**F. 处置**：

- Correction.kind：rewrite、redirect、nudge、pullback、progress、block、denied（`plan.ts:266`）。
- GuardEvent.kind：pullback、block、red、reject、nudge、progress（`types.ts:288`）。

**G. 效果**：scope 分 local / external，另有 undoable（`scenario.ts:14-22`）；重开时分成 undo / compensate / stuck 三类。

### 4.9 疑似提示词注入：只解释，不当判定依据

- `controller.ts:677-726`：最近读过的 30 个页面文本里，用正则（`INSTRUCTION`）找写给 AI 的指令腔，比如"AI 助手请直接……"、"忽略之前……"、"点「领取」即可"，再找它和这次动作或要发的话的共有片段。
- 两样都有，就标"疑似提示词注入"，并给出证据：哪个页面、页面原话、对得上的词、是不是刚读完就这么做、计划里有没有这件事。
- **判定照旧只看动作**：没认出注入，危险动作照样被底线拦下；认出了，也不会因此放宽或收紧什么（`docs/milestone-plan.md:156-171`）。
- UI 上：横条标红；输入框上方弹提醒，可以"看证据 / 知道了"；详情页有"为什么怀疑"；计数里也有。

---

## 5. UI/UX

### 5.1 技术栈，以及 UI 怎么和 Agent 通信

- **栈**：
  - React 19、Vite 8、TypeScript ~6.0、`vite-plugin-singlefile`（打成单个 index.html，直接写进 HAP 的 rawfile，见 `vite.config.ts:6-17`）、react-markdown + remark-gfm、typebox、oxlint、tsx（跑脚本和测试，没有 vitest）。
  - **不用组件库，也不用状态管理库**。CSS 全部手写：`index.css`（颜色 token、暗色）、`layout.css`（4833 行）、`look.css`（视觉规矩，压在最上面）。
- **通信方式**：**同进程直连，没有服务端**。
  - `useAgent`（`ui/useAgent.ts`）在浏览器里直接 `createAgentRuntime`。
  - `runtime.subscribe` 收 `RuntimeEvent`：`harness` 事件用于流式渲染；`session` 事件触发重新 `snapshot()` 并推导视图；`notice` 是提醒。
  - `UserBroker` 的每个方法都返回 Promise，resolve 函数放进 React state，弹窗回答时 resolve（`useAgent.ts:105-113`）。
  - 回退或重开前，`dropPending` 把所有悬而未决的请求一律按拒绝处理，让运行尽快停下（`useAgent.ts:231-256`）。
- **视图是纯函数推导的**：`deriveSessionView(entries, tipId, live, liveChecks)`（`sessionView.ts:683`）产出 `chat: ChatItem[]`、`tasks: TaskView[]`（blocks、rollbackPoints、ledger、mplan）、`forks`、`milestones`。`live` / `liveChecks` 是本轮还没写进会话的纠偏记录和核对记录，让详情页在运行中也能讲清"怎么判的"。

### 5.2 布局与屏幕

- **断点**：宽度 ≥600 算宽屏，用的是鸿蒙"一多"断点（`App.tsx:24-27`）。
  - **窄屏**是三页堆叠：会话列表 → 会话历史 → 事项详情（`.stack at-{page}`，滑入滑出）。这就是 CONTEXT 里说的三级导航。
  - **宽屏**是可拖动分栏：会话列表 | 对话 | 详情（`Splitter`）。里程碑会话再在对话左边加一栏计划。宽度不到 1200 又同时打开详情时，会话列表先让开。
- **会话列表**（`ui/SessionList.tsx`）：
  - 每条显示标题、场景、进度 x/y、"系统查到的结果"一句、是否运行中。
  - 长按 480ms 或右键弹出操作单：重命名、归档、删除；归档的收进"显示已归档（N）"。
  - 底部有新建和设置。
- **新建会话**（`ScenarioPicker`，`App.tsx:98-166`）：先选计划模式（里程碑计划默认 / 固定计划），再选场景。里程碑模式下分"演示（预设剧情，不连模型）"和"接真实模型"两组。
- **对话列**（`App.tsx:555-686`）：
  - 顶栏：返回或展开列表；里程碑会话有阶段标签"第 N 阶段"（`StageChip`，跟着聊天里正在看的那一段变，点它开关抽屉）；标题 + 场景名；进度条 x/y（固定计划点开是计划台账 `PlanTimeline`，里程碑点开是抽屉全开）；缩放按钮 ▤ / 💬。
  - **里程碑抽屉**（`ui/drawer.tsx`）：竖屏从标题栏下面拉出，有三档：收起；半开是横向阶段条，并行的叠在一列；全开是上面整个计划的 DAG、下面点中那一步的卡片（交付件、带核对结果的验收标准、可点开的安全策略、授权、"规则核对 N 次 ›"）。点聊天区时全开缩回半开，半开只能手动收。横屏是常驻左栏。
  - 历史区 `ZoomHistory`，见 §5.3。
  - 底部 footer：疑似注入提醒条、里程碑进度条（没有抽屉时才有）、输入框（发送 / 停止；演示会话换成"预设任务 + 开始"或一句说明）。
- **详情栏**（`ui/DetailPane.tsx`）：
  - 有层级返回栈：从详情点进别的详情，返回只退一层（`App.tsx:304-401`）。
  - 每个详情都能"在对话中定位"。

### 5.3 会话历史的一镜到底缩放（核心）

- `ui/zoom.ts`：
  - `PRESETS=[1, 0.45, 0.15, 0.06]`，但 `MIN_SCALE=0.15`，第四档"计划层"已经被抽屉取代。
  - 结构是 viewport（滚动）> sizer（高度 = 内容高 × s）> content（宽 = 视口宽，`translateX + scale(s)`）。
  - 每帧只写 CSS 变量（`--s`、`--o0`…`--o3`、`--colw`、`--vpw`、`--sl`）和 sizer 高度，**不触发 React 渲染**。
  - 各层不透明度由 `layerOpacity(s)` 交叉淡入淡出。
  - 捏合时跟手，焦点内容保持不动；松手在对数空间动画吸附到最近一档。
  - `onScale` 每帧同步重算两侧标注和引线位置。之前标注只在停下后才算，会"飘"。
- **输入方式**：手机上双指捏合；电脑上普通滚轮滚动，**Ctrl / ⌘ + 滚轮缩放**，触控板捏合也行（`native.ts:56-60`、`CHANGELOG.md:311`）。
- `ZItem`（`ZoomHistory.tsx:192-336`）：每条历史同时渲染 `zi-l0`（对话层完整内容）、`zi-l1`（要点层色块 + 一行）、`zi-l2`（全局层纯色块），外加两侧装饰：`zd-right` 风险、`zd-left` 任务卡和回退、`zd-fork` 废弃分支。
- **书脊**（`ZoomHistory.tsx:439-492`）：一个里程碑的一轮是一段。颜色：通过绿、退回紫、未通过红、在做橙、去掉或重开是灰。
- **同类操作折叠**："还有 N 次同样的操作，都在授权内 ▾"。
- **回退**：点 ↶ 弹 `RollbackPopover`（`App.tsx:213-271`），先算清"这一段已经在真实世界里做了 N 件事，其中 M 件收不回"，确认后回退。旧分支变成灰色 ⑂，点开按真实比例预览，可以切回，切换时两条分支走双向弧线动画。废弃分支详情列出遗留效果，本机可撤的带"申请撤回"。
- **固定计划的"计划虚线框"**：没做的步骤是虚线框，挂在主线底部；开始做转实线；偏差（计划外、超范围、顺序错、重复、被排除对象）直接标在那一格上。不变量是"虚线框的数量 = 还欠你的事"（`docs/security-experience.md:61-73`）。

### 5.4 聊天里的组件（"聊天框只放总结，细节进详情"）

- **用户气泡、思考行**（可展开）、**回复气泡**（只显示第一段总结，"展开细节"看全部）。
- **工具行**：说人话的一句（场景的 `describe`，比如"在蓝鲸购物下单：柔丝家庭装 ×1"）、缩略图（`preview`）、敏感标注小签。编号和原始参数一律收进"原始参数（给开发者看）"。
- **固定计划卡**（`PlanCard`）：
  - 顶上是**四步审查面板**（`ReviewPanel`，`components.tsx:130`）：①扫描 ②识别到的风险 ③自动修复 ④修复结果。
  - 一句声明："这份计划在你点「授权」之前，已由一套独立于模型的规则检查过一遍。" 还有"授权后预计会不会再打断你"。
  - 步骤列表标出敏感小签、"审查插入"、"审查改写"。
  - 需要确认的事项做成勾选框；底部是拒绝 / 授权执行。
- **里程碑计划卡**（`MilestonePlanCard`）：
  - 🛡 底线小签；**按阶段缩进的文字提纲**（不画图；并行的标"可并行"）；点一个里程碑在下面展开 `NodePanel`。
  - 授权项勾选（不勾 = 到那一步再问）、"全部勾上"、"授权后还会在 N 处停下来等你"、拒绝 / 授权并开始。
  - 授权后整张卡收成一行。
  - 计划调整卡写为什么改、改了什么，图上标"新 / 改"，去掉的画虚线。
- **横条**（`Strip`，`ui/strip.tsx`；`GuardCard`，`components.tsx:743`）：
  - 用于拉回、拦下、退回、你拒绝了、验收通过，平时只占一行，比如"已拦下：联系蓝鲸购物客服　碰了底线"。
  - 点开展开要点：**Agent 想 / 为什么不行 / 要是没拦 / 结果**；第一次出现时附一句解释："这是「拦下」……是系统在保护你，不是出错"。
  - 点箭头进详情。
- **里程碑事件行**：认领只是一条分隔线；验收通过或退回附**系统直接查到的事实**。
- **把关记录 / 总账卡**（`LedgerCard`）：
  - 固定计划写"做了 N 个动作，M 个触及敏感权限：逐个授权要打断你 M 次，这次打断了 K 次"，外加核对、偏差、修回、拦下、找你的次数和耗时。
  - 里程碑写计数小签（拉回 1 · 拦下 1 · 退回 1 · 问你 2），最上面是"结果（系统直接查到，不看 Agent 怎么说）"。
  - 详情可以按"全部 / 动了东西的 / 被挡下的 / 问过你的"筛选。

### 5.5 找你的对话框

| 对话框 | 文件 | 要点 |
|---|---|---|
| `ConfirmDialog` | `components.tsx:1061` | 原因一句、"Agent 想：……"、缩略图、逐条理由；tainted 时按钮写"拒绝，换个选择 / 允许，仍在这里" |
| `GrantDialog` | `milestone.tsx:1368` | **默认按钮是"拒绝"（primary）**，另有"只这一次"、"这一步都允许"；写明现有授权；提示"拿不准就拒绝：这一项不做，其余照常" |
| `AcceptanceDialog` | `milestone.tsx:1504` | 由你验收：先列系统查到的人话；清单可以多张，每张注明勾上的会被做什么；默认一项都不勾，Agent 的建议标"建议"，可以一键按建议勾；不能勾的写原因；要你判断的标红；两张清单都勾了同一项时，冲突提示放在按钮正上方并给一键解决；照片清单是缩略图宫格 |
| `LookDialog` | `milestone.tsx:1416` | 请你看一眼：👀 提醒 + 系统查到的；"停下，从这一步重做 / 没问题，接着做" |
| `FailureDialog` | `milestone.tsx:1679` | 最近一次不满足的标准；依赖它的会等着，不相干的照常推进；放弃 / 再给一次机会 / 调整计划 |
| `ReopenDialog` | `milestone.tsx:1278` | 重开范围、效果分"能撤回 / 能补救 / 收不回"、风险、"这次要怎么改"（转告 Agent）、是否补救 |
| `RollbackPopover` | `App.tsx:213` | 几件事，几件收不回；本机可撤的可以在废弃分支详情里申请撤回 |

弹窗**限高，内部滚动**。这是观众实测发现长清单会顶出屏幕后改的。

### 5.6 详情页（"凭什么这么判"可以一层层看到底）

- **工具调用详情**：
  - 参数和返回值按字段渲染（`ValueView`：中文字段名、单位、表格、"未知"徽标），不甩 JSON。
  - "执行时检查"：检查器的输入（调用、对应步骤、轨迹长度、审查定下的选择、公式用到的事实）+ 逐项结论 + 耗时（`RuntimeCheck.tsx`）。
  - 纠偏的"怎么修回来的"：修法 → 落成的动作 → 复检。
- **固定计划详情**：「检测项全览」（`RuleBook.tsx`）：全部规则、形式化公式、每条的耗时和判定、所有修复方案及代价、推荐了哪种及理由。
- **里程碑详情**：交付件、带核对结果的验收标准、尝试记录、授权额度用量、这一阶段的策略、这一步出过的状况、"从这里重做"。
- **规则集详情**（`ruleset.tsx`）：中文公式 + **接口写法**（比如 `G(file_delete(f) → O cloud_backup(f) ∨ backedUp(f))`，由 `apiFormula` 生成）、每条原子规则、自动核对的例子、"这组规则在这一步判过 N 次"。
- **单次核对页**（`checks.tsx` 的 `CheckDetail`）依次是：
  1. 轨迹 t1…tn，对上规则的那几步高亮；
  2. 这一次（now）；
  3. 规则读到的量；
  4. 逐条判：公式、规则集、条件和例外成不成立、"之前做过"对上了哪一步，⏱ 微秒；
  5. 系统另外判的几条：授权只在所属那一步有效、碰过底线先问你……
  - `StageChecks` 可以按阶段列出每次核对。

### 5.7 视觉语言（`web/src/look.css:1-14`、`README.md:78-105`）

1. **颜色只给发生了的事**：
   - 挂着没触发的规则一律中性。
   - 结果色全 App 固定：通过绿 `--ok`、拉回青 `--pull-fg`、退回紫 `--reject-fg`、拦下红 `--high-fg`。
   - 跟你有关的（问你、你拒绝、请你看一眼）用你自己消息的蓝 `--you`。
   - 计划橙只当"这是计划"的标识。
   - 内容类型色板：`--c-user / thinking / reply / plan / tool / context`（`index.css:15-20`），有暗色版（`prefers-color-scheme`）。
2. **统一线型**：
   - 实线 = 做了或在做；虚线 = 还欠你的；淡化加划掉 = 不做了；右上角小红点 = 出过状况。
   - 没执行的动作在横条上划掉。
3. **两种声音**：系统直接查到的是浅绿底、左实线、✓；Agent 自己说的是灰字、前缀"Agent："。
4. **动效只解释因果，只给刚发生的事播一次**（`ui/look.ts`）：
   - 打开会话时已有的、之后 1.5 秒内读进来的都算历史，不播。
   - 只动位置和透明度；系统开了"减少动态效果"就全关。
   - 具体动效：计划按依赖一层层画出来；勾授权时提纲里那一项闪一下；在做的那一步慢慢呼吸；拉回从右边弹回；拦下时一道线划掉动作；退回往下弹；验收通过 ✓ 弹出；证据被荧光笔扫过；要你决定的对话框从底部滑上来；抽屉跟手。
5. **其他细节**：
   - 数字等宽（`tabular-nums`）。
   - 说明文字对比度从 3.3:1 提到 4.8:1。
   - 节点窄的时候只留状态图标，不截字。
   - 去掉开发者用语（"coding agent"、"0 份计划"、"核对 0.10 ms"……），编号一律换成名字。

### 5.8 鸿蒙专属 vs 可移植到桌面 Web

| 鸿蒙专属 | 可直接移植 |
|---|---|
| `AgentSense/` 整个 ArkTS 工程：Web 组件、`javaScriptProxy` 的 `window.native`、FsBridge 沙箱文件、preferences 设置、hilog、系统返回手势（`__agentsenseBack` / `setCanGoBack`） | `web/src/**` 全部：React UI、缩放、组件、视觉规矩、视图推导 |
| 构建产物写进 rawfile；单文件打包是为了绕开 `resource://` 下的模块加载问题 | 单文件打包本身无害，也可以改回常规多文件 |
| hdc、DevEco、CDP 端口转发调试 | 浏览器版已经存在：IndexedDB 会话、Ctrl + 滚轮缩放、服务端代理 key |
| "一多"断点 600vp、Pura X Max 折叠屏横竖适配 | 宽窄两套布局在桌面同样适用 |

【推测】ergou 会是桌面或常驻服务形态，Agent 要跑真实工具（shell、文件、浏览器、IM），pi 应该跑在 Node 里，不是浏览器里。所以 AgentSense 的"UI 和 runtime 同进程、Promise 直接塞进 React state"要改成**服务端 runtime + 传输层**（WebSocket 或 SSE）。待批的请求要持久化，UI 断开以后重连还能看到并回答。见 §7.5。

### 5.9 演示与测试工具链（值得继承的工程做法）

- **脚本回放**：用 faux provider 预设"模型"会犯的错，其余链路全真。同时用于演示和 e2e：`plan-demo-e2e.ts`、`autofix-e2e.ts`、`milestone-e2e.ts`。
- **`npm test` 全部不调模型**：规则库用例、里程碑单元测试 56 条与端到端、planguard 共享用例、两类脚本演示。
- **真实模型校准脚本**：
  - `smoke.ts --dump`：把 `propose_plan` 参数落盘，对照规则做统计。
  - `milestone-real.ts --runs --exec`：统计真实模型的计划有没有并行、能不能一路做完。
  - `planguard-real.ts`：把真实模型交过的计划存成回归用例。
- **CDP 驱动的录屏和截图、TTS 配音**（`web/scripts/demo/`）；PPT 生成（`web/scripts/deck/`）。
- **"观众亲手操作"评审法**：给观众一个人设和目标，让他用能点击、勾选、滚动、捏合并自动截图的工具走完演示，交感受报告，再逐条复核上一轮的意见。分数（敢不敢交给它 / 讲得清不清楚，满分 10）从 4–5 / 5–6 升到 9 / 8–9（`README.md:186-204`）。

---

## 6. 经验教训与坑（CHANGELOG 和 ADR 里记下的）

### 6.1 计划与执行

1. **每一步都定死的计划执行不动**，所以新增了里程碑计划（ADR 0002）。没有把固定计划改成"可以跳过步骤"，因为"跳过"和"跑偏"在界面上分不清。
2. **审查放在认领时，不放在计划制定时**：制定时事实不全，审出来的结论要么是"未知"，要么是错的（ADR 0002）。
3. **验收用脚本，不用时序规则**：过程合规和结果合格是两件事，混在一起规则就难读（ADR 0002）。
4. **单 Agent，一次只认领一个里程碑**：讨论过每个里程碑派一个子 Agent，但会话树、回退、展示都会复杂一个量级。图上的"并行"只表示没有先后约束（ADR 0002）。
5. **按时间回退会误伤并行分支**：改为按依赖重开（含隐性数据依赖）；只追加，不倒带（ADR 0003）。
6. **次数额度不能随会话分支重算**：要按仍然生效的效果算，否则回退后能再下一单（ADR 0003）。**固定计划仍然有这个 bug**。
7. **自动纠偏只改属性，不换对象**：每步最多 2 次。不让运行时替 Agent 执行步骤，而是把它引回计划里那一步，让它自己去做，照样过检查，这样轨迹始终连贯（`docs/security-experience.md:130-131`）。
8. **引擎的 Monitor 构造时就冻结了事实**：所以要重建再重放，并且按事实哈希缓存（真机从 1.2ms 降下来，`CHANGELOG.md:409`）。删除类任务几乎每步都改事实，仍然要重建；真要压，需要引擎支持 `setFacts`。

### 6.2 打断体验（观众亲手操作暴露出来的，`CHANGELOG.md:228-278`）

9. **底线必须不看进度**：
   - 之前同一件"照网页联系客服"，第一次是底线拦下，后来只算"拉回"；拉回几次后还弹出带"允许"按钮的框（出现过"允许删 2011 年全家福"）。
   - 改成碰底线任何时候都直接拦下。
10. **用户说"不"之后要有路可走**：
    - Agent 不能编造"办好了"。
    - 确认框事先写清"拒绝之后会怎样"（场景的 `ifDenied`，比如"改在橙子商城买，券后 34.9 元，比蓝鲸贵 2.9 元"）。
    - 拒绝不算失败，收尾不催。
    - "你拒绝了"用中性色显示，不显示成红色的"违反安全规则"。
11. **越谨慎不能越危险**：没勾的授权，还没轮到的事照样拉回。授权框默认"拒绝"。
12. **一件事问一次**：碰过底线又没授权时，合成一个问题，不连着弹两个框；同一句"问你"重复多次时合并成"×N"。
13. **值得一看的先停下，再做收不回的事**：之前只给一行提醒，消息照发。
14. **由你勾的清单默认一项都不勾**：Agent 的建议只做标记；勾之前写清后果和数据的局限（"退了要重新开通、优惠价可能没了""上次打开只看这台手机"）。
15. **如实记录用户的每个决定**：问你的每一条都带上你的回答；"按你的决定停在这里"；没勾的授权写明是开头没勾，还是哪一次调整里没勾的。
16. **批量操作的确认疲劳**：清理 34 张截图连弹 34 次，改成按目录授权（`CHANGELOG.md:446`）；同一步的同类问题记住 `findingKey`，不重复问（`CHANGELOG.md:412`）。
17. **不伪造同意**：
    - `needs_confirmation` 的每一项都必须由用户勾选。
    - 审查说要问却说不出问什么时，给兜底项。
    - 界面接不了"由你验收"时按没通过处理（`CHANGELOG.md:298`）。
18. **演示里不要接自由输入**：预设的 Agent 碰到自由追问会乱出计划、连弹十几个框（`CHANGELOG.md:238`）。【建议】对 ergou 来说就是：脚本演示和真实模式在界面上要明确区分。

### 6.3 模型校准（真实 DeepSeek）

19. **60 次真实运行校准提示词**（`CHANGELOG.md:382-393`）。四类写法问题从多处降到 0：
    - 自造参数名：36 处 → 0；
    - 占位词当成真值（"待定"能通过姓名 pattern）：19 → 0；
    - 多个值拼成一个字符串（"a / b / c"）：7 → 0；
    - 把 `propose_plan` / `report_step` 写成计划步骤：16 → 0；
    - 编造场景没有的约束 id：5 → 0。

    对策是在提示里写明："不知道的参数整个省掉，不要填占位文字；多个值用数组；只用工具真实的参数名"（`runtime.ts:68-72`）。
20. **被拦下后模型会原样重试**：拦截文案要写明"这一条不会因为重试而通过"（`runtime.ts:363-366`）。
21. **真实模型的里程碑计划几乎都串成一条线**：系统提示里专门教"怎么拆里程碑"并给结构示意后，有并列的比例从 7 次中 1 次升到 9 次中 9 次（`CHANGELOG.md:108-127`）。
22. **模型会把 `$obj` 当记录写 `$obj.sku`**：求值悄悄落空，每次都被判成超出授权去问人。对策是计划校验 `exprMisuse` 直接退回模型（`check.ts:165-186`）；引用不存在的事实路径也在计划阶段退回（`CHANGELOG.md:293-294`）。
23. **验收没通过时给线索，不给答案**：带上核对表达式和它交的值，告诉它要对照哪些事实，让它自己去查（`controller.ts:1518-1546`）。
24. **规则引擎的边界误判**（`docs/planguard-upstream.md`）：
    - 机场名要求完全相等，导致误报；
    - 多个文档 id 拼成一个字符串，被当成一个已知值，可能漏判；
    - 剔除对象后 `count` 没同步；
    - `freed_mb` 按声明范围算，会偏高；
    - 执行时模板变量渲染成"?"。

    教训：**规则对真实输入的鲁棒性要拿真实模型的输出做回归**（`planguard-real.ts`）。

### 6.4 工程与运行环境

25. **pi 会把流式输出的每个增量都追加进会话 JSONL**：一轮真实模型就有上万行、几 MB。localStorage 装不下，而且每次追加整份重写会把页面拖死。改成内存 + IndexedDB（`CHANGELOG.md:310`）。【建议】ergou 存储要按"追加写、大文件"来设计。
26. **ArkWeb 里直接 fetch 就能通，不需要原生代发**（ADR 0001 Outcome）。
27. **检查器出错要往严格的方向退**（confirm）；**审查出错或超时要退回原流程**（skipped，50ms 预算）。同步的求解器拦不住 `Promise.race`，只能在每次进入求解前看预算（`planguardReviewer.ts:22-42`）。
28. **总账写进会话前要确认 generation 没变**：运行中途回退了，旧那一轮的账不能写到新分支上（`runtime.ts:157, 443-447`）。
29. **引擎同步纪律**：上游代码原样复制，用 sha256 记录版本，问题交回上游；YAML 1.1 的 `on`、`no`、`yes`、`off` 会被解析成布尔值，键名要避开（`docs/planguard-integration.md:163-168`）。代价是规则源分成了两处（ADR 0004）。
30. **`erasableSyntaxOnly` 和同步来的引擎冲突**：只能整个项目关掉（`CHANGELOG.md:417`）。

### 6.5 UI 实现上的坑

31. **缩放时标注要每帧跟着重算**，不能等停下来再算（`CHANGELOG.md:406`）。
32. **计划底色要整块画**：一条条拼起来交界处会叠色；宽度按视口反算（`vpw / s`）才能铺满（`CHANGELOG.md:408`）。
33. **用 `querySelectorAll` 时要用 `:scope >`**：否则会把预览里复用的同类 DOM 也选进来（`CHANGELOG.md:441`）。
34. **关键帧缓动会在中点停顿**：改成整体 linear，缓动写进关键帧（`CHANGELOG.md:443`）。
35. **长按菜单刚弹出就被抬手那一下的 click 关掉**：开启后 400ms 内不响应关闭（`CHANGELOG.md:448`）。
36. **要点层只写一行**：两行会盖住下面的内容，而且返回值是 JSON 时第二行只剩一个"{"（`CHANGELOG.md:129-133`）。
37. **计划图首次滚进屏幕才画动画**：否则动画在屏幕外白播（`CHANGELOG.md:72-74`）。
38. **横屏四栏放不下**：开详情时让会话列表先让开；计划栏至少 200 宽（`CHANGELOG.md:101-106`）。
39. **新旧两版界面并存只会拖累**：最后删掉"经典版"，只留新版（`CHANGELOG.md:58-62`）。

### 6.6 还没做完的（可能踩到的雷）

- 副作用撤销只留了接口 `EffectUndoHook`；**真实效果不会自动撤销**。
- 后台长时任务没做（手机切到后台以后会怎样，没有处理）。
- 固定计划的次数额度在回退后会清零。
- 照片场景没用真实模型跑过；真实模型下的重开没跑过（脚本回放里已经走通）。
- `docs/security-experience.md:134-140` 列了三件没做的：
  - "只看敏感操作"的入口；
  - "你离开这段时间发生了什么"的摘要；
  - 把规则讲成后果（"保住了法务要求保留三年的唯一录音"），而不是规则 id。

---

## 7. 对 ergou 的继承建议与泛化缝

### 7.1 建议直接继承的（【建议】）

1. **"一次授权 + 确定性保险"的总框架**，以及"四个方面"的叙事：事前、执行中、事后、兜底。
2. **三个 hook 的分工**：`before_tool` 判、`after_tool` 落盘、`before_run_end` 续跑，外加 `appendCustomEntry` 记账。会话树是唯一真相源，视图纯函数推导。
3. **里程碑计划的核心要素**：DAG、认领和提交、验收脚本只读世界、授权项绑定阶段并按仍然生效的效果计数、按依赖重开 + 补偿 + 复验、催促、拉回、预算的阈值体系。
4. **规则库的思路**：原子规则集 + 拼装（底线必挂、授权触发必挂、模型只挑、补充只收紧）+ 用例 + 公式与接口互相核对。
5. **打断原则**：
   - 能修就不问；同一件事只问一次；
   - 事先告诉你会在哪里停（`stopsAhead`）；
   - 默认拒绝；拒绝不算失败；越谨慎不能越危险；
   - 值得一看的先停下再做收不回的事；
   - 结果由系统查。
6. **UI**：
   - 一镜到底缩放三档、两侧标注、计划底色块、书脊、任务卡、回退和废弃分支；
   - 横条 → 要点 → 详情三级信息密度；四条视觉规矩；
   - "Agent 想 / 为什么不行 / 要是没拦 / 结果"这套卡片句式；
   - 总账："逐个授权要打断 N 次，这次打断了 K 次"，这是给用户看的"省了多少打扰"。
7. **工程**：
   - faux provider 脚本回放（演示和 e2e 共用）；
   - 不调模型的 `npm test`；
   - 用真实模型输出做回归；
   - 观众按人设亲手操作的评审法。

### 7.2 泛化缝：哪里写死了"安全类别"，哪里是数据驱动的

| 位置 | 写死的东西 | 性质 | 对 ergou 的影响 |
|---|---|---|---|
| `web/src/agent/milestone/types.ts:10-25` | `GrantKind` 联合类型（12 种）+ 中文标签 | **代码** | 用户自定义类别就加不进来。要改成注册表 |
| `types.ts:28` | `COUNTED_KINDS`（必须带次数上限） | 代码 | 应成为类别属性，比如 `countable` 或 `irreversible` |
| `milestone/check.ts:23` | `NEVER_GRANTED`（pay / subscribe / account） | 代码 | 应成为类别属性，比如 `userOnly` |
| `milestone/controller.ts:731` | `TAINT_KINDS`（order / send / share / cancel） | 代码 | 应成为类别属性，比如 `external` |
| `controller.ts:679-684` | 注入指令腔正则（中文） | 代码 | 多语言和用户可调 |
| `controller.ts:804` | "碰过底线的地方"按参数里不超过 24 字的字符串值认，排除 text / query / note / reason / path | 代码 | 应由工具清单声明"地点或对象参数" |
| `web/src/agent/policy.ts:5-19` | `SensitivityMark.kind = "data" \| "op"`、`severity: normal \| high`、`alwaysConfirm` | 代码（类型） | 只有两种"类别维度"，不够用 |
| `web/src/agent/scenarios/*.ts` 的 `rules: Rule<W>[]` | 每个场景用 **TS 函数**写敏感标注 | 代码 | 用户没法改。要改成声明式匹配器 |
| `runtime.ts:161`、`components.tsx`（总账） | "敏感" = `marks.kind === "op"` | 代码 | 应该按用户选的提醒类别来算 |
| `web/src/ui/semantic.ts:46` | `natureOf`：`/delete\|remove/i` 判"删除"，红描边 | 代码 | 应由类别的展示属性决定 |
| `semantic.ts:91` | `markRisk`：⚠ / 🔒 按 kind | 代码 | 类别要带自己的图标和颜色 |
| `semantic.ts:229-266` | 右侧标注的种类和文案 | 代码 | 应遍历"类别 + 处置"生成 |
| `web/src/ui/DetailPane.tsx:32` | `SENSITIVE` 正则：底价、仅限内部、勿外传、机密 | 代码 | 应来自规则 |
| `web/src/ui/ValueView.tsx:10-34` | 字段中文名、金额、MB 等单位按字段名写死 | 代码 | 应来自工具 schema 的元数据 |
| `web/src/ui/ruleset.tsx:13`、`milestone.tsx:37-39` | 授权或级别文案表 | 代码 | i18n 或类别注册表 |
| `milestone/library.ts:5-24` | 规则集要**逐个 import 并登记** | 代码 | 应运行时加载目录，用户可以新增 |
| `milestone/policy.ts:16` | 级别是中文字符串枚举 "红线 / 拦截 / 确认" | 代码 | 改成英文 id + 显示名 |
| `milestone/types.ts:221-226`、`guard.ts:69`、`planguardReviewer.ts:20` | 预算 50、拉回 3、催促 3、重试 2、自动修 2、审查 50ms | 常量 | 应可配（按任务或用户） |
| `runtime.ts:54-74`、`milestone/prompt.ts` | 系统提示（中文、强制先交计划） | 代码 | 要按模式生成 |
| `scenario.ts:171` | `SCENARIOS` 静态注册；UI 的 `describeCall` / `nameOf` / `previewCall` **遍历所有场景**去猜（`semantic.ts:76-133`） | 代码 | ergou 没有"场景"，是一个真实世界 + 一组工具或技能。人话描述应挂在工具上 |
| `runtime.ts:340`、`controller.ts:744` | 没有已授权计划就拦下全部业务工具 | 代码 | **普通聊天模式不能这样** |
| `model.ts` | 只有 DeepSeek | 代码 | pi-ai 支持多 provider，可以开放 |

**已经是数据驱动的**（可以直接沿用或扩展）：

- `policies/sets/*.json`：risk、level、formula、vocab、attach.whenGrant、params、needsFacts、rules、cases。
- `policies/scenarios/*.json`：tools 到 grant、object、untrusted 的映射，以及 baseline、optional、facts。
- `*.planguard.json`：rules、repairs、conformance、choices、binds、quantities、tools.args.pattern。
- `Scenario.goalTemplates`。
- 授权项本身：模型写，用户勾。
- 验收标准表达式。
- 场景的世界钩子（`MilestoneSupport`，`scenario.ts:75-104`）：outcome、inForce、undo、compensation、evidence、attention、choices、ifDenied、alwaysConfirm、reads。还有 `effectOf`、`describe`、`humanize`、`nameOf`、`preview`、`factsOf`。

### 7.3 【建议】把"安全类别"推广成"用户自定义的关注类别"

- **概念**：建议引入一个和"规则集"并列的一等概念，暂称**关注类别（Attention Category）**。领域术语要进 ergou 的 CONTEXT.md，后面再定名。
  - **匹配**：声明式谓词。工具名或工具标签（比如 `external.send`、`money.spend`、`fs.delete`、`calendar.write`、`git.push`）+ 参数条件（planguard 表达式）。可选内容条件，比如正文匹配隐私模式。
  - **属性**：吸收现在写死的那几个集合。
    - `external`：对外，对应现在的 TAINT 和"对外可补偿 / 收不回"；
    - `irreversible`；
    - `countable`：授权必须带上限；
    - `userOnly`：永不授权，对应 NEVER_GRANTED；
    - `dataSensitive`：对应 kind=data。
  - **处置**：这是用户真正想调的东西，至少分几档：
    - 静默：只计数；
    - 只在全局层标出；
    - 在要点层也标出；
    - 规划时必须单独勾选（预授权项）；
    - 执行时每次确认；
    - 红线（永远拦）。

    可以按"普通聊天 / 长任务"两种模式各设一档。
  - **展示**：图标、颜色（受视觉规矩约束，最好只在结果色和"你的蓝"之外给一个中性加图标的方案，避免颜色泛滥）、人话标签。
- **和 AgentSense 的对应**：
  - 类别的处置决定了它进入哪一层：计划授权卡、执行时确认、要点层、全局层。
  - 规则集仍然只管顺序、红线和数据流，不随用户偏好放宽。用户可以把类别"调严"（比如"任何对外发消息都要问"），但底线类别不能调松。
  - `GrantKind` 改成"类别 id"，授权项照旧是"类别 + 对象范围 + 次数 + 所属阶段"。
  - 总账里"逐个授权要打断 N 次"改成"按你选的提醒类别，逐个问要打断 N 次，这次打断了 K 次"。
- **工具清单**：沿用"工具本身不携带安全属性"的原则。用一份独立的工具清单（类似 `policies/scenarios/*.json` 的 `tools`）给每个工具标类别标签、认对象的参数、是否不可信内容源、人话描述模板。MCP 或第三方工具没有清单时，默认归入"未知写操作"类别，按严格档处理。

### 7.4 【建议】"普通聊天模式"怎么补

AgentSense 的两种模式都假设"先有计划"。ergou 需要第三种：

- **普通聊天（无计划）**：
  - 只读工具直接放行。
  - 有类别命中的调用，按类别在"聊天模式"下的处置走：静默、标注，或者当场问（可以给"本会话都允许"的选项，相当于扩大授权）。
  - 底线规则集照样挂，`before_tool` 照样判。
  - 收尾不催，因为没有计划。
- **升级为长任务**：
  - Agent 判断任务是多步的、或者会命中需要预授权的类别时，主动调 `propose_milestones`（或 `propose_plan`）进入计划模式。
  - 或者用户显式要求，比如一个"交给它跑"按钮。
  - AgentSense 的计划模式是建会话时选死的；ergou 应该允许**同一会话里从聊天升级成长任务、做完再回到聊天**。AgentSense 的会话视图本来就按"任务"分段（`TaskView`、计划底色块），这一点天然支持。
- **UI 上**：普通聊天不铺计划底色、没有书脊；要点层和全局层仍然显示类别标注。这样"事后回看"在两种模式下是一致的。

### 7.5 【建议】桌面 / 服务端形态带来的改变

- **pi 跑在 Node 里**（真实工具：文件、shell、浏览器、IM），UI 用 Web。这样做要补的东西：
  - UserBroker 请求要持久化，变成待办，让 UI 断线重连、手机推送都能拿到。现在 AgentSense 的待批请求只放在内存的 Promise 里。
  - 长任务要能后台跑，跑的过程中能推送"需要你决定"。
  - 多会话并发。
- **真实世界没有 `replayWorld`**：
  - 效果日志（effectKey、读写对象、scope、undoable、补偿动作）要在工具层落盘。
  - `factsOf` 要来自真实查询，并且要标明"拿不到就不提供"，让规则落到"判不了"后推迟或问人（`docs/planguard-integration.md:145`）。
- **验收脚本**依赖可以读取的世界事实。个人 Agent 的很多交付件（写一份文档、整理收件箱）要么写成可查询的事实，要么归为"由你验收"。【推测】这里大概率需要第三档："系统检查 + LLM 评审"作为参考证据，但不能代替系统事实。
- **上下文压缩**：长任务必然触发。要用 `transform_context` 或 `before_compaction` 保证计划、授权、当前阶段、用户约束不丢。约束放在 harness 里，不放在上下文里。

### 7.6 不建议照搬的（【建议】）

- planguard 引擎"原样同步、本仓库不改"的双仓库模式：维护成本高，规则源也分成了两处。ergou 要么把引擎做成依赖包，要么自有。
- 场景 / 模拟世界抽象：适合演示，不适合真实个人 Agent。脚本回放的思路可以保留，用于演示和回归。
- 中文字符串当枚举（"红线 / 拦截 / 确认"），以及 UI 里按工具名、字段名写死的文案表。
- 固定计划和里程碑计划两套并行的代码路径：`guard.ts` 那一套和 `controller.ts` 那一套逻辑重复、能力不对称（比如固定计划的额度有 bug、里程碑没有 rewrite 纠偏）。【建议】ergou 统一成一套，固定计划 = "全部是定步里程碑、每个里程碑一步"的特例。
- 单 Agent、一次只能认领一个里程碑：用于演示足够；个人 Agent 可能需要并发。但这会让会话树和回退复杂一个量级，ADR 0002 已经说明了代价。

---

## 8. 开放设计问题（给 ergou）

1. **关注类别的粒度和来源**：类别由谁定义？有三种可能：系统预置 + 用户勾选，用户自由写（声明式匹配器），或者让 LLM 根据一句话生成匹配器、再经确定性校验。用户自定义的类别能不能是"红线"？
2. **类别处置的档位**：静默、全局层、要点层、规划时预授权、执行时确认、红线，够不够？要不要"按次数或金额阈值升级"（比如单笔超过 200 元才问）？要不要时间窗（"今晚都允许"）？
3. **底线和用户偏好的边界**：哪些规则是系统底线、用户不能放宽（比如付款永不授权）？用户能不能把付款类授权给 Agent，比如带额度？
4. **普通聊天和长任务的切换**：
   - 谁来判定"这是长任务"：模型、用户，还是规则（比如命中可数类别超过 N 次或预计步数超过 N）？
   - 一个会话里能不能多次升级、降级？
   - 计划模式是否像 CONTEXT.md 预想的那样，"由不同的 skill 发起"？
5. **固定计划和里程碑计划要不要统一**成一种（固定计划 = 全定步里程碑），还是保留两种？
6. **验收在个人场景里怎么落地**：哪些交付件能变成可查询的事实？要不要引入 LLM 评审作为"参考证据"（不能作为判定依据），以及怎么在 UI 上和"系统查到的"区分开（第三种声音）？
7. **用哪一层 pi**：
   - 是像 AgentSense 一样直接用 `pi-agent-core` 的 `AgentHarness`；
   - 还是基于 `pi-coding-agent` 的 SDK 和 extension 体系（OpenClaw 那条路：自带 skills、compaction、session 管理、工具集）？
   - 两者的 hook 模型不同，策略层要挂在哪一层？要不要固定 pi 的版本？
8. **运行形态**：常驻 daemon（Node）+ Web UI + 移动端推送？待批请求的持久化和超时策略是什么（小米 miclaw 是 60 秒不确认就自动拒绝）？Agent 等人期间其他不相干的阶段要不要继续推进（AgentSense 在"未通过"时是继续推进的）？
9. **并发**：要不要支持多个里程碑真并发或子 Agent？会话树和书脊、回退怎么表示？
10. **真实效果的撤销和补偿**：哪些工具能提供 `undo` 或补偿动作？效果日志放在哪里？回退或重开时怎么给用户算清"几件收不回"？
11. **规则引擎**：沿用 planguard（三值、只看过去的时序逻辑、修法、求解），还是先上一个更轻的"类别 + 授权项 + 少量时序规则"？规则和工具参数的互相核对（`policies-check`）怎么对 MCP 动态工具生效？
12. **UI 的颜色预算**：用户自定义类别多了以后，怎么守住"颜色只给发生了的事"？类别靠图标或标签区分，还是允许用户给类别配色？
13. **"离开这段时间发生了什么"**：AgentSense 列为待办，没做。对个人 Agent 这可能是最高频的入口（回来看一眼）。要不要作为一等功能？
14. **多模型**：AgentSense 只校准过 DeepSeek。ergou 换别的模型以后，计划和授权项的写法质量要重新校准（参见 60 次真实运行那一套）。要不要一开始就建好"真实输出回归集"？
15. **隐私和数据边界**：个人 Agent 会读邮件、聊天、文件。"疑似注入"的解释机制要不要升级成判定依据之一（AgentSense 明确只做解释，不做判定），还是坚持"只看动作"？

---

## 附录 A：关键文件索引（相对 `REF/`）

| 主题 | 文件 |
|---|---|
| 总述、四个方面、UI 规矩 | `README.md`、`docs/security-experience.md` |
| 术语 | `CONTEXT.md` |
| 演进 | `CHANGELOG.md` |
| 架构和时序图 | `docs/architecture.md` |
| 里程碑设计 | `docs/milestone-plan.md` |
| planguard 集成、上游问题 | `docs/planguard-integration.md`、`docs/planguard-upstream.md` |
| 决策 | `docs/adr/0001…0004` |
| 竞品调研 | `docs/research/doubao-phone-scenarios.md`、`docs/research/phone-agent-demos-others.md` |
| 规则库 | `policies/README.md`、`policies/sets/*.json`、`policies/scenarios/*.json` |
| pi 运行时接线 | `web/src/agent/runtime.ts` |
| 固定计划守卫和纠偏 | `web/src/agent/guard.ts`、`planguardMonitor.ts`、`planguardReviewer.ts`、`plan.ts` |
| 里程碑 | `web/src/agent/milestone/{types,policy,library,check,state,controller,prompt,explain,demo}.ts` |
| 场景接口 | `web/src/agent/scenario.ts`、`scenarios/*.ts`、`scenarios/*.planguard.json` |
| 会话存储 | `web/src/agent/sessions.ts`、`fs.ts` |
| 视图推导 | `web/src/agent/sessionView.ts` |
| UI 入口 | `web/src/App.tsx`、`ui/useAgent.ts` |
| 缩放 | `web/src/ui/zoom.ts`、`ZoomHistory.tsx`、`semantic.ts`、`usePinch.ts` |
| 聊天组件 | `web/src/ui/components.tsx`、`strip.tsx`、`milestone.tsx`、`drawer.tsx` |
| 详情 | `web/src/ui/DetailPane.tsx`、`checks.tsx`、`RuleBook.tsx`、`ruleset.tsx`、`RuntimeCheck.tsx`、`formal.tsx`、`ValueView.tsx` |
| 视觉 | `web/src/index.css`、`layout.css`、`look.css`、`ui/look.ts` |
| 鸿蒙外壳 | `AgentSense/entry/src/main/ets/{pages/Index.ets, bridge/NativeBridge.ets, bridge/FsBridge.ets}` |
| 构建和服务 | `web/vite.config.ts`、`web/package.json`、`web/scripts/serve-web.mjs` |
| 测试和校准 | `web/scripts/{policies-check,milestone-unit,milestone-e2e,plan-demo-e2e,autofix-e2e,planguard-*,smoke,milestone-real}.ts` |
| 截图 | `output/assets/shots/p1_*…p4_*.jpg`（事前 / 执行中 / 事后 / 兜底，各 3 张） |

## 附录 B：关键数字

| 项 | 数值 | 来源 |
|---|---|---|
| ArkTS 外壳规模 | 约 350 行 | ADR 0001 |
| 前端单文件 | 约 1MB（含内联图片后多约 0.4MB） | README、CHANGELOG |
| web/src 代码量 | 约 2.9 万行 ts/tsx/css/json（含 4833 行 layout.css） | `wc -l` |
| 规则集 / 用例 | 17 个 / 60 条；公式与接口核对 136/136 | policies、CHANGELOG |
| 里程碑单元测试 | 56 条 | CHANGELOG |
| 真机审查耗时 | 最长 18.7ms；执行检查平均 1.9ms，最长 4.1ms | README |
| 审查预算 / 单次检查预算 | 50ms / 1ms | 集成方案 |
| 阈值 | 预算 50 次调用；拉回 3；催促 3；验收重试 2；自动修 2 | `types.ts`、`guard.ts` |
| 缩放档位 | 1 / 0.45 / 0.15（0.06 已弃用） | `zoom.ts` |
| 宽屏断点 | 600；四栏不够时的阈值 1200 | `App.tsx` |
| 打断对比 | 6→1、4→3、15→1、5→3 | README |
| 观众评分 | 4–5 / 5–6 → 9 / 8–9 | README |
