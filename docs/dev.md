# 开发说明

怎么装、怎么跑测试、代码放在哪、测试底座怎么用。架构和取舍见 `docs/adr/`，规格见 `.scratch/ergou-v2/spec.md`。

## 前提

- **Node ≥ 22.19**（本机 v22.23）。源码是 TypeScript，靠 Node 自带的类型剥离直接运行，没有构建步骤。
- **Windows**：Job 对象只在 Windows 上有，相关测试在别的系统上会跳过。
- **Git Bash**：pi 的 `bash` 工具要用；测试里有用例让 agent 跑 bash。
- **不要在开发机上直接起常驻服务**：二狗的服务只能在 Local Service Manager 登记、由它启动（`ergou-daemon` 的条目见下面"LSM 登记"）。测试里起的守护进程实例和子进程是测试的一部分，测试结束时销毁。

## 安装

```sh
npm install      # 或 npm ci：严格按 package-lock.json 装
```

## 常用命令（都在仓库根目录跑）

| 做什么 | 命令 |
|---|---|
| 全部测试 | `npm test` |
| pi 契约测试（升级 pi 前先跑） | `npm run test:contract` |
| 单个包的测试 | `npm test -w @ergou/daemon`（`@ergou/protocol`、`@ergou/web` 同理） |
| 某个 vitest project | `npx vitest run --project daemon`（project 有 `protocol`、`web`、`daemon`、`pi-contract`、`frontend`） |
| 单个测试文件 | `npx vitest run packages/daemon/test/agent-process.test.ts` |
| 按名字挑测试 | `npx vitest run --project daemon -t "中止"` |
| 监视模式 | `npm run test:watch` |
| 类型检查（各包） | `npm run typecheck` |
| lint | `npm run lint`（oxlint，配置在 `.oxlintrc.json`） |
| 收尾全套 | `npm run check`（类型检查 + lint + 全部测试；主切面里有一条用例会现场构建 Web UI 再扫页面里有没有密钥，所以一条命令就覆盖到真正的构建产物） |
| 构建 Web UI | `npm run build:web`（产物是单个文件 `packages/web/dist/index.html`） |
| 构建鸿蒙 App 的 HAP（要装 DevEco Studio，不进 `npm run check`） | `npm run build:harmony`，见下面"鸿蒙 App" |
| 主切面测试 | `npx vitest run packages/daemon/test/main` |
| 下载语义检索用的向量模型（bge-m3 量化版，约 570 MB，放进数据目录的模型区） | `npm run download-model`（数据目录取 `ERGOU_DATA_DIR`，没设是用户主目录下的 `.ergou`；指定：`npm run download-model -- --data-dir "<数据目录>"`；连不上 Hugging Face 时先设 `HF_ENDPOINT` 指向镜像）。已经下好的文件跳过，重跑就是续下 |
| 重新录前端回放用的事件流 | Git Bash：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/recordings.test.ts`（PowerShell：先 `$env:ERGOU_RECORD_EVENTS=1`） |
| 部署公网入口的 nginx 站点（只由用户在本机运行，运行即确认） | `npm run deploy:nginx`（加 `-- --print` 只打印生成的配置、不 ssh），见下面"公网入口" |

守护进程包里还有 `npm run test:unit -w @ergou/daemon`（不含契约测试）和 `npm run test:contract -w @ergou/daemon`。

## 工作区

```
packages/
  protocol/   @ergou/protocol  守护进程和前端共用的前端协议（TypeBox），见下面"共享协议包"
  daemon/     @ergou/daemon    守护进程：管家，拉起和管理 agent 子进程；事件存储、网关、秘书
  web/        @ergou/web       Web UI：React 19 + Vite，手写 CSS（起点复制自 AgentSense），见下面"Web 包"
frontend/     其他前端（不是 npm workspace），见 frontend/README.md
  harmony/    鸿蒙 App：DevEco 工程，原生壳加载二狗的网页，见下面"鸿蒙 App"
  android/    安卓 App：还没做
config/ergou.example.json      示例配置（仓库里只有示例，没有个人数据）
deploy/lsm/ergou-daemon.example.yaml  ergou-daemon 的 LSM 条目示例（本机路径是占位符；真实条目只放在 LSM 自己的登记目录），见下面"LSM 登记"
deploy/lsm/ergou-tunnel.example.yaml  ergou-tunnel（公网隧道，只连外网端口）的 LSM 条目示例（VPS 地址、私钥路径是占位符），见下面"公网入口"
```

守护进程 `packages/daemon/src/`：

| 目录 | 是什么 |
|---|---|
| `main.ts` | `ergou-daemon` 的入口（LSM 用 `node packages/daemon/src/main.ts` 启动）；同一个数据目录已经有实例在跑时以退出码 1 退出；LSM 经 link 协议要求停机时停守护进程、退出（23 号票） |
| `stop.ts` | LSM 的 stop 钩子：读同一份配置，核对"监听本机端口的就是 pid 文件里那个进程、启动时间也对得上"才结束它，否则不动、报原因 |
| `daemon.ts` | 组装：读配置、找数据目录、打开事件存储、建 Job 对象、立起调度器、个人工作日历、卡片、待我处理、简单提醒、设备配对、任务、agent 管家、任务执行（13 号票）、token 账本（24 号票）、秘书和维护者、开本机端口和外网端口；停止和启动中途失败共用一份按相反顺序收拾的清单。`startDaemon()` 的 `localPort`、`externalPort`、`heartbeatIntervalMs`、`webRoot`、`programDir`、`secretaryModel`、`secretaryDownThresholdMs`、`clock`、`extraCardTypes`、`embedder`（素材的向量函数）、`backupFiles`（备份往备份区写文件的实现）、`extraSecretaryTools`、`extraQuickActions`（额外登记或替换的快速动作）、`maintainerModel`（维护者的模型，按维护者 id 和第几次唤起给）、`reviewerModel`（评审子 agent 的模型，按它的 id 给，13 号票）、`subAgentModel`（并行派出的子 agent 的模型，按它的 id 给，20 号票）、`scopeReviewModel`（范围审视用的模型，按维护者 id 和第几次唤起给，18 号票）、`scopeReviewTimeoutMs`（工单结束时的范围审视最多等多久，18 号票） 给测试用 |
| `download-model.ts` | 下载向量模型的命令（`npm run download-model`），见下面"素材" |
| `deploy-nginx.ts` | 部署公网入口的 nginx 站点（`npm run deploy:nginx`，用户在本机运行，运行即确认）。守护进程不引用它，见下面"公网入口" |
| `restore.ts` | **恢复命令**：从指定日期的快照恢复数据目录（守护进程在运行时拒绝）。见下面"备份、校验与恢复" |
| `config/` | 配置（只读）、数据目录各区的路径（`dataDirLayout`）、模型 key 从哪个环境变量取（`secrets.ts`） |
| `storage/sqlite.ts` | 存储薄接口：所有 SQLite 访问都经过它，换驱动只改这一个文件。`openReadonlyDatabase` 给读派生视图用（只读打开，写不进去）；`vacuumInto`、`integrityCheck` 是整库操作（备份用），在常驻的工作线程（`sqlite-worker.ts`，只转手给 `sqlite.ts` 里的同步函数）里做，不卡事件循环 |
| `events/event-store.ts` | **事件存储**：事件日志是唯一真相（`ergou.db`，WAL）。见下面"事件存储" |
| `events/ephemeral.ts` | 临时事件（只推给正连着的前端）的推送：到点的提醒这类 `notify` |
| `errors.ts` | `RequestRejected`：模块按前端协议的错误码拒绝请求（发消息、卡片动作、待我处理、提醒的时间不对……都用它），网关原样回成错误响应 |
| `cards/` | **卡片**：类型注册表（`registry.ts`）、按钮闭环（`cards.ts`）、派生视图。见下面"卡片和待我处理" |
| `inbox/` | **待我处理**：事项、紧急度、已读 / 归档 / 删除、到点通知。见下面"卡片和待我处理"。秘书的两个只读工具（`secretary-tools.ts`：列出待我处理、把卡片放进聊天，工具名在 `tool-names.ts`，22 号票）见下面"秘书的看板感知、压缩与任务控制" |
| `scheduler/` | **调度器**和可注入的时钟（`clock.ts`）；**内部作业**（`internal-jobs.ts`，错过的开机后补一次）。见下面"调度器和简单提醒""备份、校验与恢复" |
| `scheduled-jobs/` | **定时作业**（19 号票）：登记、到点、名额、运行和结局、失败和自动暂停、作业的授权（`jobs.ts`），作业自己的维护者（`maintainers.ts`），说法（`texts.ts`）、幂等键（`keys.ts`）。别处只经 `index.ts` 取。见下面"定时作业与错过补发" |
| `backup/` | **备份**：快照的两层结构（`snapshot.ts`）、保留多少份（`retention.ts`）、往备份区写文件的小接口（`files.ts`）、同步目录能不能用（`sync-dir.ts`）、每晚备份 / 每周校验 / 每天清理临时区（`backup.ts`、`tmp-cleanup.ts`）、恢复（`restore.ts`）。见下面"备份、校验与恢复" |
| `reminders/` | **简单提醒**：秘书给的时间落成时间表（`schedule.ts`，纯函数）、提醒卡、秘书的三个工具、派生视图。时间规则本身在共享协议包的 `reminder-schedule.ts`。见下面"调度器和简单提醒" |
| `conversation/` | 会话：派生视图（会话消息、agent 输入队列、会话里的附件 `attachments-view.ts`）、往会话里追加消息、交给 agent 的输入怎么投影（`agent-input.ts`，秘书和维护者共用）、一个 agent 处理一条会话的输入（`agent-session.ts` 的 `AgentSession`，秘书和维护者共用，见下面"agent 会话"）、agent 回复的定稿和引用（`agent-replies.ts`）、流式增量的节流推送（`stream-hub.ts`）、历史分页（`history.ts`）、发给模型前的投影（`model-projection.ts` 登记各版本，第 1 版在 `projection-v1.ts`，见下面"媒体与附件"） |
| `gateway/` | 网关的两个端口，都只听 127.0.0.1：本机端口校验 Host 和 Origin（`local-origin.ts`），外网端口只认设备凭证（`external.ts`，含配对接口）；Web UI 静态文件、`/healthz`、`/ws`（带心跳）、HTTP 接口 `/api/`（`http-api.ts`） |
| `pairing/` | **设备配对**（10 号票）：配对请求、批准、发凭证、吊销、校验凭证（`pairing.ts`）、配对请求卡（`card.ts`）、凭证和 cookie（`credentials.ts`）、事件和派生视图（`views.ts`）。见下面"设备配对与外网端口" |
| `deploy/` | 公网入口：nginx 站点配置的生成（`nginx.ts`，纯函数）、配置里的 `publicAccess`（`public-access.ts`）、部署命令本身（`deploy.ts`，ssh 是可替换的执行器）。只有 `deploy-nginx.ts` 引用它 |
| `media/` | 媒体库（`media-store.ts`）、图片认格式和剥元数据（`image.ts`）、文件类型的日常判断（`file-types.ts`：按名字认类型、文本类 / PDF、解码、大小的说法；不随投影版本变）、附件内容（`attachment-content.ts`：文本开头、PDF 抽文本）、agent 的附件工具（`attachment-tools.ts`，工具名在 `tool-names.ts`），见下面"媒体与附件" |
| `materials/` | **素材**：从事件日志采集、切段与来源标记、原文副本、`memory.db`（关键词和向量索引）、回避信号计时、向量模型（`embedding/`）。别处只从 `materials/index.ts` 取东西，见下面"素材" |
| `quick-actions/` | **快速动作**（21 号票）：执行器注册表（`registry.ts`，每种动作自带参数 schema）、"用户明确点了"的共用辅助函数（`explicit.ts`）、按伪工具调用交给守卫判处置（`judge.ts`）、提议和执行、快速动作卡（`quick-actions.ts`）、秘书的"提议快速动作"工具（`tool.ts`）。见下面"快速动作与记忆命令" |
| `memory/` | **记忆命令与素材删除**（21 号票）：四种记忆命令的执行器和记忆删除卡（`memory-commands.ts`）、记事件加算改写（`deletion.ts`，卡片和批量删除共用）、彻底删除要改写哪些事件（`purge.ts`）、按事件类型的改写函数表（`rewriters.ts`）、彻底删除之后的事（`after-purge.ts`：删附件、会话文件的改写参数）、秘书的素材检索工具（`search-tool.ts`，工具名在 `tool-names.ts`）、设置里按会话或时间段删除（`bulk.ts`）。见下面"快速动作与记忆命令" |
| `secretary/` | 秘书：常驻子进程、长期主线会话（`AgentSession` 配上秘书的差异，加 `/healthz` 用的健康状态）；固定的系统提示和秘书专用的压缩指令在 `system-prompt.ts`；它的工具由守护进程代为执行（见下面"秘书的工具"）；看板变化消息和压缩见下面"秘书的看板感知、压缩与任务控制"（22 号票） |
| `board/` | **秘书眼里的任务看板**（22 号票）：看板上的一项、全貌的写法、两次之间的变化（`board.ts`，纯函数）；**看板种类表**（`kinds.ts` 的 `BOARD_KINDS`：看板上有哪几种东西，现在的看板、看板事件写成的一项、空看板的说法、查看板工具的说明都从它推出）；秘书"上次看到的样子"和看板变化消息（`board-watch.ts`）；"查看板"工具（`tool.ts`，工具名在 `tool-names.ts`）。19 号票的定时作业只在种类表里加一行 |
| `process/` | 进程相关：Job 对象（`job-object.ts`，`processIds()` 列出 Job 里的进程）、全部进程的父进程（`process-list.ts`）、子进程环境（`child-env.ts`）、经闸门进程起一个放进 Job 的程序（`gated-spawn.ts` 的 `spawnGated` + 闸门 `gate-main.ts`：带类型的 bash 工具和 MCP 服务进程共用）、pid 文件和进程启动时间（`pid-file.ts`；`processRunning` 判断 pid 文件里的进程还在不在，`daemonRunning` 再看本机端口：守护进程启动时的单实例检查和恢复命令都用它） |
| `agent-manager/` | agent 管家：装配会话参数、注入环境、放进 Job、拉起子进程；资源限制（子进程上限和排队、闲置退出、模型调用和工具调用超时、孤儿进程回收 `orphans.ts`，12 号票，见下面"agent 管家的资源限制"）；守护进程代为执行的工具在守护进程这一侧（`host-tools.ts`：`defineHostTool`、`serveHostTools`，见下面"秘书的工具"）；一次性的 agent 子进程（`one-shot.ts` 的 `runOneShotAgent`：拉起 → 接守卫 → 接代为执行的工具 → 就绪后送一条输入 → 这一轮结束就结束子进程，评审子 agent 和并行派出的子 agent 共用，20 号票） |
| `activity/` | **活动状态**（12、25 号票）：agent 管家报的休眠 / 干活中 / 等你 / 排队，和待处理的审批卡、提问卡（`card-waits.ts`）合起来记成活动状态频道上的 `activity` 事件（连同结构化的说明），派生视图 `agent_activity`；干活中在做什么节流成临时事件 `activity_progress`。见下面"agent 管家的资源限制"里的"活动状态" |
| `ledger/` | **token 账本**（24 号票）：子进程每次模型调用上报的用量逐条记账（`ledger.ts` 的 `createTokenLedger`，`daemon.ledger`），派生视图 `token_ledger`（`views.ts`），一条的形状和归属（`entry.ts`）。别处只从 `ledger/index.ts` 取东西，见下面"token 账本与消耗" |
| `tasks/` | **任务**（12 号票）：发起、任务书、计划的检查和存储、计划卡和提问卡和"建议发起任务"卡、状态迁移表（`state-machine.ts`）、秘书的四个任务工具、两种素材的采集规则、确认的计划变成守卫的计划（`plan.ts` 的 `toGuardPlan`）。见下面"任务与计划"。13 号票的执行控制器（`execution.ts`）、阶段的纯函数（`stages.ts`）、验收（脚本 `acceptance.ts`、评审子 agent `review.ts`）、重注入块（`context-block.ts`）、维护者执行时的工具和给模型看的话（`execution-tools.ts`，工具名在 `tool-names.ts`）、进度卡（`progress-card.ts`）见下面"任务执行与阶段验收"；"谁能改"表在共享协议包 `task-transitions.ts`。22 号票的任务控制快速动作（暂停、继续、取消）在 `task-control.ts`。19 号票：全局执行名额谁占着只在 `slots.ts` 里数（执行中的任务和开始了的定时作业运行共用），每周的归档清单是任务模块的内部作业（`archive-list.ts`） |
| `maintainers/` | **维护者**（12 号票：任务自己的维护者）：会话里来了输入就唤起、一次处理一条、闲置退出后再唤起；系统提示、"提交计划"工具；13 号票起执行时按确认的计划重新装配、跟着任务状态处理输入；维护者此刻的装配 `MaintainerAssembly`（`assembly.ts`，20 号票：子 agent 从它收窄）。见下面"维护者的唤起" |
| `runtime/` | **运行时封装层**（ADR-0001、ADR-0004）。`host-protocol.ts` 是 agent 宿主协议，`line-channel.ts` 是按行分帧和读行，`agent-process.ts` 是守护进程侧句柄，`agent-child/` 是子进程（pi 只出现在这个目录里）；彻底删除时改写 pi 会话文件的逻辑也在 `agent-child/`（`session-rewrite.ts`、一次性子进程的入口 `rewrite-main.ts`），守护进程经 `session-rewrite.ts` 的 `runSessionRewrite` 拉起它（21 号票，会话文件的格式由契约测试守着）；被杀后接着会话时修补会话文件也在 `agent-child/`（`session-recovery.ts`，23 号票）。上层只从 `runtime/index.ts` 取东西 |
| `guard/` | **守卫判定核心**（规格第 9 节，03 号票；时序规则和 v1 模板是 05 号票）。纯函数 `judgeToolCall`；接进运行时的是 `guard-runtime/`。上层只从 `guard/index.ts` 取东西，见下面"守卫" |
| `guard-runtime/` | **守卫接入运行时**（07 号票）：子进程的 `guard_request` 在这里现取环境事实（`facts.ts`、脚本扫描 `script-scan.ts`）、判定、回复（`guard-runtime.ts` 的 `attach` 只做编排）；先问我的一次性授权、等审批和挂起（`approval-waits.ts`）；聊天里的工具调用记录（`tool-call-record.ts`）；效果日志（`effect-log.ts`）；`guard` 频道上的事件和 `CallOrigin`（`events.ts`）；给人看的写法和调用指纹（`describe.ts`）；有副作用的调用的执行记录（`executions.ts`，23 号票）；每次调用的完整参数和返回（`tool-call-details.ts`，53 号票）。见下面"守卫接入运行时" |
| `approvals/` | **审批表**（派生视图 `views.ts`）、审批卡（`approvals.ts`：写审批表、建卡、放进待我处理，用户批准或拒绝）、"审批决定"素材的采集规则（`material-source.ts`）。见下面"守卫接入运行时" |
| `hand-over/` | **交给我做**（07 号票）：守卫判定"交给我做"的调用在待我处理里放一个事项，用户点"已完成"后通知 agent。见下面"守卫接入运行时" |
| `typed-shell/` | **带类型的特殊 bash 工具**（28 号票）：git 状态和差异、提交、合并、推送、建远端仓库、跑测试、装依赖、构建，守护进程代为执行、在 Git Bash 里跑（`tools.ts`）；认项目约定（`conventions.ts`）；经闸门进程放进每次调用自己的 Job 再起 Git Bash（`runner.ts`，闸门是 `process/` 的 `spawnGated`）。见下面"带类型的 bash 工具" |
| `util/` | 不属于哪个模块的小工具：真实路径 `real-path.ts`（`realPathOf`）、压成一行截短 `text.ts`（`oneLine`）、按编号或名字找一样东西 `find-by-ref.ts`（`findByIdOrName`：编号不分大小写，名字去掉首尾空白后完全相同，同名的报歧义；秘书的工具里找任务、项目都用它，22 号票） |
| `calendar/` | **日历**（35 号票）：按月给出每一天的日历条目（工作日判定、当天的提醒和定时作业），`calendar.ts` 的 `createCalendarService`。见下面"日历" |
| `assistant/` | **个人助理的名字**（43 号票）：用户给秘书起的名字，配置区的文件是真相，改名经设置接口，名字频道上推 `assistant_name`（`assistant-name.ts` 的 `createAssistantNameService`，`daemon.assistantName`）。见下面"个人助理的名字、两个字的导航" |
| `workday/` | **个人工作日历**（29 号票）：框架自带的节假日数据（`holiday-data.ts`，数据文件在本包的 `holidays/`）、个人设置和事件（`calendar.ts`）、快速动作"改工作日历"（`quick-action.ts`）、节假日数据的续期（`holiday-check.ts`：每月检查、发起更新任务、导入交付件）。别处只从 `workday/index.ts` 取东西，见下面"个人工作日历" |
| `watch-categories/` | **关注类别设置**（26 号票）：设置页的修改、现读数据目录配置区的设置文件（`watch-categories.ts` 的 `WatchCategoryService`，`daemon.watchCategories`）；确定规则的检查和规范化（`match.ts` 的 `normalizeCategoryMatch`，计划里的本任务类别也用）。见下面"关注类别设置" |
| `voice/` | **语音消息**（31 号票）：收下语音、建出 `VoiceRecord`、识别队列和重新识别（`voice.ts`）、派生视图（`views.ts`）、按需拉起的识别进程（`recognizer.ts` + Python 脚本 `recognizer.py`）、素材来源、彻底删除的改写和设置里批量彻底删除时没有素材的语音（`material-source.ts`）。别处只从 `voice/index.ts` 取东西（会话、历史分页、快速动作的点明判定直接用 `views.ts` 的读取函数），见下面"语音消息"。32 号票起还有 **agent 用语音回复**：参考音色（`reference-voices.ts`）、口语稿（`spoken-text.ts`）、经 audio.cpp 合成（`speech.ts`）、跟着回合合成语音回复（`voice-reply.ts`）、给模型和人看的话（`texts.ts`，编排里不写文字）、agent 语音对象的派生视图（`agent-voice-views.ts`）、读 WAV（`wav.ts`），和 31 号票共用的版本、一次一条的队列、开着只留一条的说明（`shared.ts`），见下面"agent 用语音回复"。45 号票：**模型预热**（`warmup.ts`），见下面"语音模型预热" |
| `guard-wire/` | 守卫的写法和前端协议的写法之间的对照（边界，26 号票）：处置的两种写法 `WIRE_DISPOSITION` / `GUARD_DISPOSITION`（`dispositions.ts`）。守卫接入、任务、关注类别设置从这里换，守卫本身不引用协议包 |
| `sub-agents/` | **子 agent 并行**（20 号票）：维护者的"提议并行"工具（`tools.ts`）、并行确认卡（`card.ts`）、编排——提议 / 用户决定 / 拉起子 agent / 结果交回维护者 / 重新装配（`sub-agents.ts` 的 `createSubAgents`，`daemon.subAgents`）、给人和模型看的话（`texts.ts`，编排里不写文字）、子 agent 的装配从维护者收窄（`assembly.ts`，纯函数）、`sub_agents` 频道上的事件（`events.ts`）和派生视图（`views.ts`）、"审批决定"素材（`material-source.ts`）、子 agent 的系统提示（`system-prompt.ts`）。见下面"子 agent 并行" |
| `work-orders/` | **工单与派单、项目维护者的会话分段**（16 号票）：派单队列（`work-orders.ts` 的 `createWorkOrders`，`daemon.workOrders`：派出、一次只做一件、`admit`、已归档退回）、会话分段（`segments.ts`：开段、收尾和催写回、催到了次数转用户拍板、重置、摘要、接哪个会话、维护者处理哪条输入）、等澄清的一次往返（`clarifications.ts`）、两种事件的构造（`events.ts`）、给人和模型看的话（`texts.ts`，编排里不写文字）、固定上下文（`fixed-context.ts`，纯函数）、维护者的工具（`tools.ts`，工具名在 `tool-names.ts`）、派生视图（`views.ts`）、删除项目时的改写（`purge.ts`）。见下面"工单与派单"。17 号票：涉及多个项目的任务（`multi-project.ts`：建单、派出、回执、阶段的回执门槛、计划外工单；说法在 `multi-project-texts.ts`，任务维护者的固定工具包和项目维护者的"交回执"在 `multi-project-tools.ts`，建出、派出和结局和派单队列共用 `orders.ts`，计划外工单的守卫判定在 `unplanned.ts`，工单卡在 `card.ts`，素材在 `material-source.ts`），见下面"涉及多个项目的任务" |
| `scope-review/` | **范围审视**（18 号票）：守护进程这一侧（审视的模型调用在维护者子进程里，`runtime/agent-child/scope-review.ts`；会话里的协调在 `conversation/scope-reviews.ts`）：审视的说明、对照物和"近期范围记录"（`texts.ts`）、把子进程交回的结果存成范围记录（`scope-review.ts` 的 `createScopeReview`：`scope_record` 事件、时间线记录、越界通知，项目档案或任务产出区里的文件是投影）、两个维护者模块共用的接线（`session.ts` 的 `sessionScopeReview`）、派生视图 `scope_records`（`views.ts`）、彻底删除和删除项目时的改写（`purge.ts`）。别处只从 `scope-review/index.ts` 取东西，见下面"范围审视" |
| `recovery/` | **被杀后的恢复**（23 号票，`recovery.ts`）：启动早期记下被打断的任务维护者（`scanBeforeStart`），各模块接上之后按规则恢复（`recoverAfterRestart`）。见下面"被杀后的恢复" |
| `lsm/` | **接入 LSM 的 link 协议**（23 号票，`link.ts` 的 `linkToLsm`）：忙的时候心跳报"忙"（`busy.ts`：有任务在执行、有正在执行的有副作用的调用），管理器要求停机时优雅停止；没有 LSM 注入的身份时静默跳过。见下面"LSM 登记" |

### 事件存储（`events/event-store.ts`）

- 事件 `{全局序号, 频道, 频道内序号, 类型, 负载, 时间, 幂等键}`，频道内序号从 1 起连续。对外：
  - `append({ channel, type, payload, idempotencyKey? })`：同一个幂等键第二次追加不落新事件，返回 `{ event: 第一次那条, duplicate: true }`；
  - `appendBatch([...])`：一组事件在同一个事务里追加，要么全落、要么全不落（卡片动作的结果连同它引起的提醒变化、提醒到点时提醒 + 卡片 + 待我处理事项）；每条各按自己的幂等键去重，提交后按顺序通知；
  - `read(channel, afterSeq, type?)`、`lastSeq(channel)`、`eventAt(channel, seq)`、`eventByIdempotencyKey(key)`、`mentioning(type, text)`（负载里含有这段文字的某类事件，彻底删除找记录用）；
  - `ofType(type)`：某类事件全部（启动时对一遍以前的 `messages_purged` 用）；
  - **彻底删除**（21 号票；事件日志不可修改，例外只有它和删除项目，后者用的是同一个口子，见"项目与项目档案"）：`appendBatch(events, { purge: [{ globalSeq, payload }…] })` 在同一个事务里把这些事件的负载换成给出的新负载（消息事件是"已删除"标记 `DeletedEventPayload`，留下消息 id 和时间；别的事件是字段级改写后的负载，见下面"快速动作与记忆命令"），和原来一样的不变，没有这条事件时整组回滚；改写了就整体重放派生视图，提交后做一次 `wal_checkpoint(TRUNCATE)`（连接开着 `secure_delete`）。**派生视图从不收到"已删除"标记**（追加和重放都跳过它），所以各视图不用认它；改写不通知订阅者，要让别处知道就同时追加一条说明（会话频道的 `messages_purged`、卡片的新版本）；
  - `onAppend(listener)`：提交之后同步通知。订阅者在通知里又追加了事件（秘书收到用户消息就追加 `turn_start`）时，新事件排在后面，每个订阅者收到的事件都按追加顺序、一条不漏；`appendBatch` 的一组事件整组排进通知队列（13 号票），订阅者看到组里前面的事件就追加的新事件排在整组之后（维护者模块看到看板上的变化就去处理会话里已经落盘的输入，前端不会先收到 `turn_start` 再收到那条输入）；
  - `rebuildViews()`：清空派生视图，按全局序号把日志重放一遍；
  - `reader`：只读连接，给视图模块的读取函数用。写一律经 `append`，没有暴露可写的连接。
- **派生视图**实现 `DerivedView { name, create, clear, apply }`，在 `startDaemon` 里交给 `openEventStore({ views })`。`apply` 和事件写入在同一个事务里，抛错则整个追加回滚。视图模块自己提供读取函数（比如 `conversation/views.ts` 的 `listMessages`、`pendingInputs`）。看板、待我处理、审批表……都照这个做。
- 存储接口是同步的（`node:sqlite`），网关"读补发的事件 + 登记订阅"在同一段同步代码里，补发和实时推送之间不重不漏。

### 频道上的事件（04 号票起）

| 频道 | 类型 | 负载 | 落盘 |
|---|---|---|---|
| 会话（`secretary`、`maintainer:<id>`） | `message` | `{ message, idempotencyKey?, taskId?, projectId?, stageId?, scheduledJobId?, agentId? }`：定稿的消息；用户发的带发送请求的幂等键（乐观显示靠它替换）。后面五项是消息的归属，**只有协议包 `schema.ts` 的 `MessageScope` 一份定义**（25 号票起；事件负载、历史分页、时间线记录都把它摊开带着，取值用 `message-scope.ts` 的 `pickMessageScope`，守护进程的 `MessageScope` 就是它）：维护者会话里的消息带上所属的任务、项目 id（13、15、16 号票，素材的"任务或项目"取自这里），属于任务、开始执行之后的带上那时的阶段 `stageId`（时间线的全局层按它聚色块。"当前阶段"只在 `tasks/stages.ts` 的 `taskMessageScope(task, stageId?)` 算：执行控制器说某个阶段的说明、验收结论卡写那个阶段，别的取守卫眼里的当前阶段——维护者最后一次开始的那个，任务里记的 `focus`，20 号票；维护者的 `AgentSession` 的 `scope` 是函数、每条消息现取；工具调用记录用守卫判定那一刻取的），`scheduledJobId` 是定时作业的一次运行（19 号票带上，24 号票据此把维护者处理它的用量记在作业名下；守护进程会话视图 `agent_inputs` 里存的输入归属也用 `pickMessageScope` 取），`agentId` 写在一个会话里不止一个 agent 的时候：20 号票的子 agent 的工具调用记录、交回的结果在维护者的会话里，带上它的 id（`sa-<n>`）和它被派去做的阶段 `stageId`（不按维护者此刻的阶段）。用户消息事件里有会话、发言方、时间和原文，08 号票据此采集"用户发言"素材；附件是图片 part 和文件 part，`mediaId` 就是入库版本的 sha256，连同文件名和类型，08 号票据此把附件记为"外部、不可信"的引用加内容哈希 | 是 |
| 会话 | `turn_start` | `{ inputMessageId }`：agent 开始处理一条用户消息 | 是 |
| 会话 | `turn_end` | `{ inputMessageId, outcome, error? }`：agent 处理完一条用户消息（输入出队）。`outcome` 是 `completed` / `aborted` / `error` / `interrupted` | 是 |
| 会话 | `stream` | `{ messageId, deltas: [{ part, type, offset, text }] }`：流式增量，每个会话每 100 毫秒最多一帧；`messageId` 就是定稿消息的 id；序号是频道当时最后一条落盘事件的序号 | 否（临时事件，不补发） |
| `cards` | `card` | `{ card }`：卡片的最新版本（含负载版本 `typeVersion` 和纯文本降级 `text`）。用户动作产生的那条带请求的幂等键 | 是 |
| `cards` | `card_dismissed` | `{ cardId, cardType, action, note?, cardText?, time }`：用户关掉了一张卡（动作之后状态为 `dismissed`），和卡片更新同一事务；`note` 是用户关掉时写的说明，`cardText` 是卡片的纯文本降级。素材模块据此采集回避信号 | 是 |
| `cards` | `card_stale` | `{ cardId, cardType, pendingSince, time, cardText? }`：建议卡、提问卡（`suggest_task`、`suggest_project`、`questions`）从建卡起 7 天（`materials.staleCardDays`）还待处理，由素材模块的计时追加（幂等键 `card-stale:<卡片 id>`，每张卡最多一条）；`time` 是到期的时刻。素材模块据此采集回避信号 | 是 |
| `inbox` | `inbox_item` | `{ item }`：待我处理事项的最新状态（删除也是一次更新，`deleted: true`） | 是 |
| `inbox` | `notify` | `{ id, title, body?, itemId? }`：要马上告诉用户的事（到点的提醒）。前端在任意页面提示，用户允许时再发浏览器通知 | 否（临时事件） |
| `devices` | `device` | `{ device, change }`：一台已配对设备的最新状态（名字、来源、配对和最近使用的时间、凭证到期时间、有没有吊销；**凭证本身不在里面**）。`change`（`DeviceChangeKind`）是 `paired`（新设备领到凭证，`activated: false`，"等待首次使用"）/ `activated`（第一次带着凭证来）/ `used`（使用续期，最多一小时一条）/ `revoked`（吊销，带请求的幂等键）。设置里的"已配对设备"订阅它（10 号票） | 是 |
| `pairing`（守护进程内部） | `pairing_request` | `{ request }`：一个配对请求的最新状态（配对 cookie 的哈希、设备名、短码、短指纹、来源、待批 / 已批准 / 已领走 / 被拒 / 已过期）。**不是前端协议的频道**（不在 `Channel` 里，订阅会被拒），哈希不推给任何前端 | 是 |
| `pairing`（守护进程内部） | `device_credential` | `{ deviceId, credentialHash }`：设备领到凭证时只记它的 sha256，原值不落盘 | 是 |
| 会话 | `message`（`agentInput: true`） | 发言方是 `system`、同时排进 agent 输入队列的运行时通知（07 号票起："……已获批准，可以重试"、"交给我做"的事用户已完成）。同一件事带固定的幂等键，只追加一次 | 是 |
| `guard`（守护进程内部，前端不订阅） | `approval_requested` / `approval_decided` / `approval_suspended` / `approval_consumed` / `effect_recorded` | 审批的请求、用户的决定（批准、拒绝；收窄留出了形状，`resumed` 说明有没有调用在等）、等审批超时的挂起、一次性授权用掉、执行成功的调用进效果日志。审批记录、决定和挂起都带调用从哪儿来（`CallOrigin`：agent、会话、任务和阶段、会话段、来源，13 号票往里加字段）。负载的类型在 `guard-runtime/events.ts`；`approval_decided` 是"审批决定"素材的来源（类型登记在共享协议包的 `EVENT_TYPES.approvalDecided`，素材按事件类型采集），`approval_suspended` 给 13 号票把任务转等我。见下面"守卫接入运行时" | 是 |
| `board` | `reminder` | `{ reminder, change, by, lateMinutes? }`：简单提醒的最新状态；`change`（`ReminderChangeKind`）是 `created` / `updated` / `cancelled` / `fired` / `missed`（晚了超过 60 分钟，没照发、改放进待我处理），`by` 是 `agent`（秘书）/ `user`（卡上的按钮）/ `system`（到点）；晚了才到点的带 `lateMinutes` | 是 |
| `board` | `task` | `{ task, change, from, by, stageId? }`（12 号票）：任务的最新状态（`Task`：编号、标题、一句话说明、状态、发起方式、执行的维护者、涉及的项目、阶段 `{ total, current?, list? }`、最新的计划卡；13 号票起还有等我的原因 `waitReason` / `waitNote`、失败的原因 `failReason`）；`change` 是 `TASK_CHANGES` 之一（`created` / `plan_submitted` / `plan_confirmed` / `plan_rejected`；13 号票的执行、阶段变化见下面"任务执行与阶段验收"），`from` 是迁移前的状态（建出时为 null），`by` 是 `user` / `secretary` / `maintainer` / `system`，阶段的变化带 `stageId`。见下面"任务与计划" | 是 |
| `activity` | `activity` | `{ agentId, state, since, detail? }`（12 号票；25 号票加了 `detail`）：一个 agent 的活动状态变了（`sleeping` / `working` / `waiting_for_user` / `queued`），状态和说明都一样的不重复记。说明是结构化的 `ActivityDetail { kind, tool?, chars? }`（协议包 `activity.ts`，给人看的文字由 `activityDetailText` 按表生成，不含用户的原话和工具参数）：干活中是 `woken`（被唤起）、`handling_input`（处理一条输入），等你是 `approval`（等你批准某个工具，`tool` 是中文名）、`clarification`（等你回答提问卡），休眠是 `idle`（按需的子进程还在、没有输入）或 `idle_exit`（闲置退出）。派生视图留状态和说明 | 是 |
| `activity` | `activity_progress` | `{ agentId, detail }`（25 号票）：干活中的 agent 此刻在做什么（`ActivityDetail`：`thinking` / `replying` 带写了多少字 `chars`，`calling_tool` 带工具的中文名），每个 agent 每 100 毫秒最多一条（`ACTIVITY_PROGRESS_INTERVAL_MS`），攒着的只推最新的、和上一条一样的不推；状态变了就丢掉没推出去的。前端以下一条 `activity` 为准 | 否（临时事件） |
| `activity` | `voice_models` | `VoiceModelsView { recognizerEngines, recognizerEngine, recognizer, speech, startedAt, revision }`（45 号票）：两个语音模型（识别、合成）的状态变了（`VoiceModelState`：`waiting` / `loading` / `ready` / `off` / `busy` / `error` / `unloaded`，带用的模型、设备、计算精度、加载耗时、合成是不是之前就加载好了、退回的原因、没开或出错的原因），和 `GET /api/voice-models` 的一样。前端并进 `UiState.voiceModels`，同一次启动（`startedAt`）里 `revision` 大的新、守护进程重启过的取后启动的 | 否（临时事件） |
| 会话 | `timeline_record` | `TimelineRecordEventPayload { record: { id, kind, summary, detail?, time, workOrderId? }, ...MessageScope }`（形状 25 号票定，协议包 `timeline.ts`）：时间线上消息之外的一条记录，和消息一样带着归属。`kind` 现在有 `deviation`（偏离）、`plan_change` / `plan_revision`（计划变更、自行调整计划），14 号票产生；`scope_change` / `out_of_scope`（范围变更、越界）、`scope_review_missing`（重置时这段没做范围审视），18 号票产生；彻底删除时摘要和说明可能被改写成删除标记（`conversation/purge.ts` 的 `timelineRecordPurge`，范围记录连带）；**加新的种类只往 `TIMELINE_RECORD_KIND_INFO` 里加一行**（中文名、进不进要点层、严重度 `info` / `notice` / `alert`；界面按严重度取样式），前端不认识的种类只在完整视图里显示摘要。守护进程追加记录用 `conversation/messages.ts` 的 `buildTimelineRecord(会话, { kind, summary, detail?, workOrderId? }, 归属, { idempotencyKey? })`（在 `buildMessage` 旁边；任务里的归属用 `taskMessageScope(task)`），和别的事件一起放进 `appendBatch` | 是 |
| `cards` | `questions_answered` | `{ cardId, taskId?, answers: [{ questionId, question, answer, recommended, followedRecommendation, chosenOption }], time }`（12 号票）：用户回答了提问卡，和卡片更新同一事务。"澄清问题的回答"素材的来源 | 是 |
| `tasks`（守护进程内部，前端不订阅） | `output_reaction` | `OutputReactionPayload`（13 号票）：用户对产出的反应——由我验收的阶段验收通过或退回、对已完成的任务要求返工（和任务的变化同一事务）。"用户对产出的反应"素材的来源，类型登记在协议包的 `EVENT_TYPES.outputReaction` | 是 |
| `guard`（守护进程内部） | `never_recorded` | `NeverRecordedPayload { taskId, objects, tool, time }`（13 号票）：任务里一次对外调用被判"永不"，记下它的对象；同一任务之后对这些对象的对外动作至少先问 | 是 |
| `guard`（守护进程内部） | `tool_call_started` / `tool_call_finished` / `tool_call_interrupted` / `tool_calls_settled` | 23 号票：放行、开始执行的有副作用的调用（`ToolCallStartedPayload { execution: ExecutionRecord }`）、它结束了（`{ toolCallId, agentId, time, ok, result }`：成功与否、结果摘要，成功的和效果日志同一事务）、它被中断了（`{ execution, time }`：守护进程被杀、子进程意外退出时还没结束；任务里的由执行控制器让任务转等我，不属于任务的同一事务在待我处理里放一条 `interrupted`）、这个 agent 做完的调用结果都写进会话了（`{ agentId, toolCallIds, time }`：它又出了一条助手消息、或者这一轮结束了）。派生视图 `tool_executions`，见下面"守卫接入运行时""被杀后的恢复" | 是 |
| `tool_calls`（守护进程内部，前端不订阅） | `tool_call_detail` | 53 号票：每次经守卫的调用结束时另存的完整参数和返回，负载就是协议包的 `ToolCallDetail`（已经过隐私处理，超过 200KB 的值截断并注明）。派生视图 `tool_call_details`（调用 id → 全局序号），经 `GET /api/tool-calls/<调用 id>` 取；彻底删除、删除项目时字段级改写（`toolCallDetailPurge`）。见下面"守卫接入运行时" | 是 |
| `tasks`（守护进程内部，前端不订阅） | `task_brief` / `plan_submitted` / `plan_decided` | 任务书（`{ taskId, brief, revision, time }`）、维护者提交的一版计划（`{ taskId, planId, revision, plan, cardId, maintainerId, time }`）、用户在计划卡上的决定（`{ taskId, taskTitle, planId, revision, cardId, decision, plan?, removedGrants, narrowedGrants, note?, by, time }`，"审批决定"素材的来源，类型登记在协议包的 `EVENT_TYPES.planDecided`）。负载的类型在 `tasks/events.ts` | 是 |
| `watch_categories` | `watch_category_settings` | `WatchCategorySettingsEventPayload { state, change, by, time }`（26 号票）：关注类别设置的最新样子（`WatchCategoriesState`：内置九类和各自的默认、现在的处置，两条底线，自定义类别，能匹配的工具，设置文件的问题 `problems`），这次的变化（设置页上的操作，或 `op: "file"`：启动时、文件被手改过或改坏了），谁改的（`user` / `system`）。设置页订阅它；用户的修改带请求的幂等键 | 是 |
| 会话 | `quick_action_executed` | `QuickActionExecutedEventPayload { actionId, action: { type, params }, name, title, explicit, cardId, result }`：一次快速动作的执行，也就是"操作记录"（21 号票），在动作提出的会话频道上，幂等键 `quick-action:<动作 id>`，和执行器的事件、卡片更新同一事务 | 是 |
| 会话 | `voice` | `VoiceEventPayload { voice }`（31 号票）：一条语音的最新状态（`VoiceRecord`：音频、时长、格式、波形摘要、识别出的文字和分段、识别状态 `queued` / `recognizing` / `done` / `failed`、第几次识别、版本）。建出（和语音消息同一事务）、开始识别、识别完成或失败、重新识别各一条。见下面"语音消息" | 是 |
| 会话 | `agent_voice` | `AgentVoiceEventPayload { voice }`（32 号票）：agent 发的一条语音（语音回复）的最新状态（`AgentVoiceRecord`：归属、回的是哪条输入、这一轮开始的序号、完整回复在哪几条消息、整段还是口语总结和谁写的、送进 TTS 的原文、参考音色、实际的 TTS 模型、状态 `replying` / `summarizing` / `synthesizing` / `done` / `partial` / `failed` / `skipped`、分段合成的段数和已合成的段、合成出的音频和时长和波形、载着它的消息、第一段和整条的耗时、失败或没用语音的原因、版本）。38 号票起分段合成的每合成好一段（最后一段除外）还有一条（`synthesizing`，带上已合成的段）；只合成了一部分（`partial`）和载着拼好的那几段的消息、会话里的说明同一事务。这一轮开始时建出（输入是语音、有参考音色；插话让这一轮用了语音的回合结束时建出；幂等键 `agent-voice:<输入的消息 id>`），合成完成时和载着它的消息（`tts_audio` part）同一事务，失败时和会话里的说明同一事务。见下面"agent 用语音回复" | 是 |
| 会话 | `messages_purged` | `MessagesPurgedEventPayload { messages: [{ seq, messageId, replacement? }], materialIds, toolCallIds, mediaIds, deletedAt }`：这些消息被彻底删除了（21 号票）：没有 `replacement` 的整条改写成了"已删除"标记，有的（工具调用记录）字段级改写成了 `replacement`。前端据此换掉手里的（不刷新也一样）；记忆模块据此生成会话文件的改写参数（`toolCallIds` 是要改参数和结果的工具调用）、删掉没人再引用的附件（`mediaIds`） | 是 |
| `sub_agents`（守护进程内部，前端不订阅） | `parallel_proposed` / `parallel_decided` / `sub_agent_started` / `sub_agent_finished` | 维护者提议了一次并行（子 agent 的 id 这时定下）、用户在并行确认卡上同意（`parallel`）或不同意（`sequential`，和卡片更新同一事务）、一个子 agent 拉起（名额满了在排队）、结束（`done` / `error` / `interrupted` / `stopped`，和交回维护者的那条消息同一事务）（20 号票）。负载的类型在 `sub-agents/events.ts`；`parallel_decided` 是"审批决定"素材的来源（类型登记在协议包的 `EVENT_TYPES.parallelDecided`） | 是 |
| `work_orders`（守护进程内部，前端不订阅） | `work_order_decided` | 用户在工单卡上确认派出（`dispatch`）或拒绝（`deny`）一张计划外的工单（和卡片更新同一事务，17 号票）。负载 `WorkOrderDecidedPayload`（`work-orders/multi-project.ts`）；"审批决定"素材的来源（`EVENT_TYPES.workOrderDecided`） | 是 |
| 会话（`maintainer:<id>`） | `message`（`stageId`、`agentId`） | 子 agent 的消息（工具调用记录、交回的结果）在派它的维护者的会话里，`MessageEventPayload` 带上它做的阶段 `stageId` 和它自己的 id `agentId`（20 号票；`MessageScope` 多了这两项），时间线据此归到所属的任务和阶段；维护者自己的消息没有这两项 | 是 |
| `materials`（守护进程内部，前端不订阅） | `memory_command` | `MemoryCommandEventPayload`：一条显式记忆命令，按命令种类分两种形状：`RememberCommandPayload { commandId, command: "remember", content, source, from }`（`source` 是点明在哪里：`typed` / `quote` / `card` / `proposed`）、`DeleteCommandPayload { commandId, command: "forget" \| "purge" \| "no_infer", materialIds, from }`；`from` 是聊天里的哪张卡（`chat`）或设置里的哪个范围（`settings`，只有删除类）。素材模块据此产生"显式记忆命令"素材，并删除、标记已有的素材（重建时同样照做），见下面"快速动作与记忆命令" | 是 |
| `internal`（内部频道，不在前端协议里，前端订阅不到） | `internal_job` | `{ job, since, lastRunAt? }`：内部作业的最新状态（第一次见到它的时间、上一次开始跑的时间），启动时据此判断错过了没有。见下面"备份、校验与恢复" | 是 |
| `internal` | `holiday_update_task` | `HolidayUpdateTaskPayload { taskId, itemId, year, regions }`：用户在"节假日数据缺失"事项上点"发起更新任务"发起的任务是哪一年哪一边的更新，和建任务的事件同一事务追加；任务完成后据此导入交付件（29 号票），见下面"个人工作日历" | 是 |
| `workday_calendar` | `workday_settings` | `WorkdaySettingsEventPayload { settings, source, change? }`：个人设置（额外上班规则、手动标记）的最新样子；`source` 是 `settings`（设置页）/ `quick_action`（快速动作）/ `config_file`（启动时读入配置文件，和上一条不一样：停着时手改过、从备份恢复了配置区）（29 号票） | 是 |
| `assistant_name` | `assistant_name` | `AssistantNameEventPayload { name, source }`（43 号票）：用户给个人助理（秘书）起的名字的最新样子；`source` 是 `settings`（设置页）/ `config_file`（启动时读入配置文件，和上一条不一样）。前端一打开就订阅 | 是 |
| `workday_calendar` | `holiday_data` | `HolidayDataEventPayload { years, imported? }`：工作日历用的节假日数据（框架自带的加上导入的）的最新样子；启动时有变化、导入新一年的数据时追加（29 号票） | 是 |
| `board` | `token_totals` | `TokenTotalsEventPayload { owner, tokens, calls, byAgent, byStage, time }`（24 号票）：一个任务（`owner.kind: "task"`）或定时作业（`"scheduled_job"`）名下的 token 用量合计，每次记账后同一事务推一条**最新的合计**（不是增量）：总量 `tokens`（`TokenCounts { cacheHit, cacheMiss, output }`）、调用次数、按 agent（`TokenAgentRow { agentId, role, purpose, tokens, calls }`，范围审视、压缩各另占一行）、按阶段（`TokenStageRow { stageId, tokens, calls, budgetTokens }`：调用算哪个阶段，`budgetTokens` 是算进预算的部分）。任务卡、作业卡的总量和任务详情的细分都来自它；项目名下的不推。见下面"token 账本与消耗" | 是 |
| `board` | `scheduled_job` | `ScheduledJobEventPayload { job, change, by, run? }`（19 号票）：一个定时作业的最新状态（`ScheduledJob`：`j-N`、时间表、每次做什么、属于哪个项目、执行的维护者、来自哪个任务、`active` / `paused` / `cancelled` 和暂停的原因、下一次、最近一次运行、最近一次失败、连续失败次数），`change` 是 `registered` / `paused` / `resumed` / `cancelled` / `triggered` / `run_started` / `run_finished` / `rescheduled`，`run` 是说到的那一次运行（`JobRun`）。见下面"定时作业与错过补发" | 是 |
| `ledger`（守护进程内部，前端不订阅） | `token_usage` | `TokenUsagePayload { time, owner, stageId?, purpose, agentId, role, sessionId, model, tokens }`（24 号票）：一次模型调用的用量（`ledger/entry.ts`），派生视图 `token_ledger` | 是 |
| `projects` | `project` | `ProjectEventPayload { project, change, from, by }`（15 号票）：项目的最新状态（`Project`：编号、名字、一句话目标、状态、从哪个入口诞生、维护者、项目类型、工作目录、工具包、立项书卡、立项书确认了没有、首个建设任务、归档前的状态、由哪个任务转来）；`change` 是 `PROJECT_CHANGES` 之一，`deleted` 表示删掉了（项目档案和维护者会话都删了，素材留着） | 是 |
| `projects` | `work_order` | `WorkOrderEventPayload { workOrder, change, from, by }`（16 号票）：一张工单的最新状态（`WorkOrder`：`wo-N`、收件项目和维护者、来源、种类 `plan` / `execute`（17 号票加了 `change`：涉及多个项目的任务的维护者派的改动，带所属阶段、验收标准、计划内外、回执，状态多了还没派出的 `planned` / `awaiting_confirm`）、所属任务、内容 `instructions?`、状态、已结束的结局和原因、等澄清时的提问卡、没写回项目档案就结束的 `unwritten?`：`reset` / `nudged`）；`change` 是 `WORK_ORDER_CHANGES` 之一。项目页的工单流水线、看板上的"等项目 X"从它来；项目删掉时内容改写成删除标记 | 是 |
| `projects`、`board` | `scope_record` | `ScopeRecordEventPayload { record, sources }`（18 号票，协议包 `scope-record-schema.ts`）：一条范围记录（`ScopeRecord`：`sr-<uuid>`、种类 `scope_change` 范围变更 / `out_of_scope` 越界、一句话、说明、依据、哪次审视的 `compaction` / `work_order_end`、归属 `ScopeOwnership`（维护者、项目、任务、工单）、时间），`sources`（`ScopeSources { messageIds, approvalIds }`：这次审视看到的用户原话从哪来，彻底删除时据此连带改写）。落在哪个频道由协议包的 `scopeRecordChannel` 定：项目维护者的在 `projects` 频道（简版项目页），不属于项目的任务的在 `board` 频道（任务详情）；同一事务里维护者会话频道上另有一条同种类的 `timeline_record`（时间线标出），越界另有一条待我处理的 `out_of_scope` 通知。彻底删除改写过的记录另追加一条改写后的（同一个 id，前端、派生视图、项目档案里的文件换掉原来的）。见下面"范围审视" | 是 |
| 会话（`maintainer:<id>`） | `segment` | `SegmentEventPayload { segment, change }`（16 号票）：项目维护者的一段会话的最新状态（`MaintainerSegment`：`<维护者>-sN`、种类 `work_order` / `chat`、所属工单和任务、会话的名字 `session`、第一段对话段的 `continueEarlier?`、是不是重置开的、状态 `open` / `closing` / `closed`、开段时进展文档的内容哈希、摘要、工单要以什么结局结束、没写回就结束的 `unwritten?`）；`change` 是 `SEGMENT_CHANGES` 之一（`session`：子进程报回第一段对话段接的是以前的哪个会话）。给守护进程自己用，前端的分隔线是会话里的工单分隔 part | 是 |
| `charters`（守护进程内部，前端不订阅） | `charter_submitted` / `charter_decided` | 维护者交出的一版立项书（`{ projectId, revision, charter, toolkit, cardId, maintainerId, time }`）、用户在立项书卡上的确认（`CharterDecidedPayload`：确认并开工 / 只确认，连同那版立项书、工具包、首个建设任务、附的说明）。`charter_decided` 是"用户对产出的反应"素材的来源 | 是 |

秘书的输入队列就是事件日志：用户消息事件进队，交给秘书时追加 `turn_start`，处理完追加 `turn_end` 出队（派生视图 `agent_inputs`：等着 / 正在处理 / 处理完）。运行时给秘书的通知（`agentInput` 的系统消息，`conversation/messages.ts` 的 `appendAgentNotice(store, conversation, text, key)`）同样进队，交给秘书时开头标 `SYSTEM_NOTICE_TAG`（"[系统通知]"）。模型出错时会话里多一条发言方为 `system` 的说明（不进队）。

**处理到一半被打断的输入不重送**：秘书子进程崩溃、或者守护进程重启时，有 `turn_start`、没有 `turn_end` 的那条以 `interrupted` 结束出队，会话里追加一条系统说明（"上一条消息「…」处理时中断了，秘书没有接着处理；需要的话请重发。"），不再交给秘书；排在它后面、还没开始的照常按原顺序处理。会话从会话文件里最后一个完整回合续上（重新拉起时子进程去掉写到一半的一行、给被中断的工具调用补上结果），被打断的任务维护者由运行时唤起接着做，见下面"被杀后的恢复"（23 号票）。

### 网关（`gateway/`）

- 两个端口，都只监听 `127.0.0.1`：本机端口 `ports.local`（默认 8810）自动信任；外网端口 `ports.external`（默认 8811）是隧道的唯一目标，每个请求都要设备凭证（见下面"设备配对与外网端口"）。**本机信任只看从哪个端口进来，不看来源 IP。** 下面这几条说的是本机端口。
- 每个 HTTP 请求和 WebSocket 握手都校验：Host 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`（防 DNS 重绑定）；带了 Origin 就必须是这两个源之一（防跨站请求和跨站 WebSocket）；不带 Origin 的本机程序（LSM 的探针、不在浏览器里的前端）放行。不看来源 IP。
- `GET /`：原样发出 `packages/web/dist/index.html`（每次请求重新读）；没构建时回 503 并提示 `npm run build:web`。
- `GET /fonts/<…>`（39 号票，`gateway/fonts.ts`）：视觉风格的字体，原样发出构建产物 `fonts/` 下的文件。只认三种：`.css`（每套有字体的风格一份样式表，外加设置里风格预览用的 `preview.css`；`no-cache` + ETag，没变回 304）、`.woff2`（在带包版本号的目录里，同一个地址内容不变，`private, max-age=一年, immutable`）、`.txt`（许可证）；跑出 `fonts/` 目录、别的类型、没有的一律 404。外网端口上和别的地址一样要设备凭证（没配对的新设备只拿得到页面本身）。
- `GET /healthz`：`{ ok, secretary, webUi, reasons }`。秘书不在运行（拉起中、意外退出后重新拉起中）超过阈值（默认 30 秒）或者 Web UI 没构建时，`ok` 为 false、回 503，`reasons` 写明原因；秘书闲着或在干活时健康。
- `/ws`：前端协议。格式不对的请求得到错误响应，连接不断。**心跳**（10 号票）：服务端每 30 秒（`heartbeatIntervalMs`）ping 一次，上一轮没回 pong 的连接（半开的：对方已经没了、连接没正常关掉）直接断掉；外网端口上的连接每次心跳顺带复查凭证（吊销了、过期了就关掉，关闭码 `WS_CLOSE_UNPAIRED` 4401），还有效就算用了一次（续期）。
- `/api/access`：这个请求被信任吗（`AccessInfo`：`local` / `device`（带设备 id 和名字）/ `none`）。两个端口都有，不需要凭证；前端打开时先问它。外网端口上带着失效的凭证来问时，`none` 带上原因 `reason`（`revoked` / `expired`，`CREDENTIAL_REJECTIONS`）——同一个响应让浏览器删掉凭证，所以只有第一次问时有。
- 请求的分发在 `FrontendConnection.dispatch`：发消息直接调会话模块（秘书的会话总能发；别的会话能不能发、消息带上哪个任务或项目由 `RequestHandlers.messageScope(conversation)` 定，不认的会话回 `not_implemented`：`daemon.ts` 先问项目模块（15 号票：项目维护者的会话，消息带 `projectId`，已归档的只读），再问 `maintainers.ts` 的 `userMessageScope`（13 号票：任务维护者的会话，消息带 `taskId`，已完成、已取消、已归档的任务拒收，没有这个维护者回 `not_found`））；卡片动作、待我处理的动作、吊销设备、发起任务、控制任务（`task_action`，13 号票）交给 `startGateway({ requests })` 里的 `RequestHandlers`（`daemon.ts` 接到 `cards.act` / `inbox.act` / `pairing.revoke` / `tasks.startFromButton` / `taskExecution.act`）。模块拒绝时抛 `RequestRejected(code, message)`，网关回成同样的错误。
- 临时事件有两个来源：流式增量（`streams`）和别的通知（`notifications`，`events/ephemeral.ts`），都只推给订阅了那个频道、正连着的前端。
- **重新同步**：订阅时前端带来的序号比某个频道的最后序号还大（比如数据目录恢复成了旧快照），订阅响应的 `resync` 里点名这个频道，服务端从头补发它的事件；前端收到后先清掉这个频道的状态。
- **会话频道第一次只补发最近一页**（09 号票起）：前端在会话频道上什么都没有（游标为 0，或者要重新同步）时，只补发最近 50 条消息（`HISTORY_PAGE_SIZE`）起的全部事件；更早的经 HTTP 往上翻（`conversation/history.ts`）。带着游标重连的照旧补发缺的全部事件。两边按同一个序号切开，交界处不重不漏。
- **补发推完了的回执**（36 号票起 Web 用）：同一条连接上的请求按顺序处理，订阅的补发在处理订阅时同步推完；所以订阅之后紧跟着发一个空订阅（`cursors: {}`：什么也不补、不改订阅），它的响应一定排在这次补发的事件后面。Web 据此分开补发的帧和实时推来的（补发的 agent 语音不自动播）。改补发的推法（比如改成异步分批推）时要保住这一条，`test/main/reconnect.test.ts` 有用例。
- `/api/`：HTTP 接口（`http-api.ts`；路径怎么拼 `HTTP_PATHS`、怎么拆 `parseHttpPath`、查询参数的名字 `HTTP_QUERY` 都在共享协议包的 `http.ts`，两边不各自拼），见下面"媒体与附件"：
  - `POST /api/uploads`、`GET|PUT /api/uploads/<上传 id>`、`POST /api/uploads/<上传 id>/complete`：分片续传上传；
  - `GET /api/media/<媒体 id>?name=&download=`：下载，支持 Range（206、416）；
  - `GET /api/conversations/<会话>/messages?before=&limit=`：历史分页，返回 `HistoryPage`（序号小于 `before` 的最近若干条消息，`hasMore` 表示更早还有；`limit` 默认 50、最多 200）。被彻底删除的消息是 `{ seq, deleted }`（`HistoryMessage` 是联合），原文不在了；消息带着归属（任务、项目、阶段，25 号票，往上翻的更早消息也能按阶段聚色块）。25 号票起还有 `records`：落在这一页里的时间线记录（`HistoryRecord`：`timeline_record` 和快速动作的执行 `quick_action_executed`，带序号和事件负载；序号从这一页第一条消息起、小于 `before`，更早没有了的从头起），往上翻时要点层、全局层也看得到旧页里的偏离和操作记录。工具调用记录本身是消息，跟着消息走；
  - `POST /api/materials/scope`（`MaterialScopeBody { scope? }` → `MaterialScopeSummary { count, conversations }`）、`POST /api/materials/delete`（`DeleteMaterialsBody { scope, mode, idempotencyKey }` → `{ count }`）：设置里按会话、按时间段删除素材（21 号票），见下面"快速动作与记忆命令"。
  - `GET /api/workday-calendar?month=YYYY-MM`（→ `WorkdayMonthView { month, days, settings, missing }`：每天上班或休息及原因、个人设置、这一年缺哪边的节假日数据）、`POST /api/workday-calendar`（`WorkdayChangeBody { change }` → `WorkdayChangeResult { settings, changed }`）：设置里的工作日历（29 号票）。改动本身是幂等的（同一条规则只有一份、同样的标记再标没有变化），不带幂等键；有变化时工作日历频道上推一条 `workday_settings`。
  - `GET /api/calendar?month=YYYY-MM`（→ `CalendarMonthView`，协议包 `calendar-schema.ts`）：主导航的日历（35 号票），月份写错了回 `bad_request`。见下面"日历"。
  - `GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD`（→ `UsageSummary`，协议包 `usage-schema.ts`）：消耗页（24 号票），范围是协议包的 `LocalDate`、含两头，写错了、日期不存在、起点在终点之后回 `bad_request`。见下面"token 账本与消耗"。
  - `GET /api/reference-voices`（→ `ReferenceVoiceList { voices, currentId? }`）、`POST /api/reference-voices`（`ImportReferenceVoiceBody { name, referenceText, audioBase64 }` → 新导入的 201、同样的录音和名字已经有了 200，都是 `ReferenceVoice`；请求体上限按 20 MB 的录音放宽）、`POST /api/reference-voices/<id>/select`、`DELETE /api/reference-voices/<id>`（都 → `ReferenceVoiceList`）、`GET /api/reference-voices/<id>/audio`（参考录音本身，`audio/wav`，和媒体同一套发文件、支持 Range，不缓存）：设置里的语音页（32 号票）。不合规矩回 `bad_request`、没有这个音色回 `not_found`。见下面"agent 用语音回复"。
  - `GET /api/tool-calls/<调用 id>`（→ `ToolCallDetail`，协议包 `http-schema.ts`）：一次工具调用的完整参数和返回（53 号票，详情页用），调用 id 就是工具调用 part 的 `callId`；没有回 `not_found`。执行成功的顺带效果记录（`effects`，可选字段，56 号票）。见下面"守卫接入运行时"的"完整参数和返回"。
  - `GET /api/voice-models`（→ `VoiceModelsView`，45 号票）：两个语音模型的状态和识别引擎的清单（现在只有 `faster-whisper`）；设置 · 语音打开时取一次，之后的变化经活动状态频道的临时事件 `voice_models` 推来。见下面"语音模型预热"。
  - `GET /api/agent-voices/<agent 语音 id>/segments/<第几段>`（`audio/wav`，不缓存，支持 Range）：分段合成里合成好的一段（38 号票），前端边收边播用；段是临时的，没有了回 `not_found`。见下面"分段合成"。
  - 出错时回 `HttpErrorBody { code, message, offset? }`（错误码 `HTTP_ERROR_CODES`）。错误码到 HTTP 状态码只在 `http-api.ts` 的 `STATUS_OF` 一张表里对应；媒体库抛的 `MediaError` 和网关自己的 `HttpError` 都只带错误码。
  - JSON 响应一律经 `http-api.ts` 导出的 `sendJson(res, status, body)`（带 `SECURITY_HEADERS`：nosniff、不许嵌框、不带 Referer、CSP `sandbox`，并且不缓存）和 `sendError(res, code, message)`（状态码由 `STATUS_OF` 定）。两个端口、配对接口、来源校验的 403 都用它们，不另写状态码和响应头（主切面断言了外网端口的响应头和本机端口一样）。

### 设备配对与外网端口（`pairing/`、`gateway/external.ts`，10 号票）

- **外网端口的门**（`external.ts`）：不看来源 IP、不看 Host 写的是什么。带了 Origin 就必须和 Host 同源（不同源 403）。然后只看设备凭证（cookie `__Host-ergou-device`）：有效就和本机端口走同一套路由（`/healthz`、`/api/`、`/ws`……），并在响应里重新下发 cookie（`DEVICE_CREDENTIAL_TTL_MS`，跟着服务端续期）；没有或失效（带着失效的凭证时顺带让浏览器删掉它）只放行三样：页面本身 `GET /`（前端据此显示配对等待页）、`/api/access`（回 `none`，带着失效的凭证时附原因）、配对接口 `/api/pairing`；别的一律 401（`HttpErrorBody` 的 `unauthorized`），WebSocket 握手 401。以后加的 HTTP 接口自动在这道门后面。
- **来源**：经隧道来的请求 TCP 对端都是本机，以 nginx 覆盖写的 `X-Real-IP` 为准（不像 IP 就用 TCP 对端）。只在外网端口上信任这个头，只用于配对请求的限频和卡片上的"来源"。来源是本机地址（127.0.0.1、::1）时——VPS 上的 nginx 站在按 SNI 分流的前门后面，前门没开 `proxy_protocol`，nginx 只看得到 127.0.0.1——卡片上的来源写"经前门转发，无法识别"（`UNIDENTIFIED_SOURCE_LABEL`），限频照样按这个地址算，**实际上就成了全局的**（所有人共用 10 分钟 5 个）：仍然安全，只是陌生人刷请求时自己的配对也要等。要不要在前门上开 `proxy_protocol` 按真实来源限频由用户决定（见下面"公网入口"第 1 步）。
- **配对接口**（只在外网端口上，本机端口回 404）：`POST /api/pairing`（`{ deviceName? }`，不给就由 `defaultDeviceName(User-Agent)` 生成）→ 201 `{ request: PairingRequestView }`，同时下发配对 cookie `__Host-ergou-pairing`（HttpOnly，认出"这台设备的请求"）；`GET /api/pairing` 查自己的请求，**已批准的那一次响应里领到设备凭证**（Set-Cookie，配对 cookie 同时删掉）；`PATCH /api/pairing`（`{ deviceName }`）改名，只在待批时能改。错误：`bad_request`、`not_found`、`forbidden`（不在待批了）、`too_many_requests`（限频）。
- **配对模块**（`pairing/pairing.ts` 的 `PairingService`）：
  - `createRequest`：同一来源 10 分钟内最多 5 个（`PAIRING_RATE_LIMIT`、`PAIRING_RATE_WINDOW_MS`，按派生视图里的请求数，守护进程重启也算数）；6 位数字短码（`crypto.randomInt`）、8 位十六进制短指纹（由配对 cookie 推出）；同一事务里追加请求事件、配对请求卡（`cards.buildCreate`）、待我处理的卡片事项（标题 `pairingRequestTitle(设备名)`，来源"设备配对"，不卡任务），然后 `inbox.alert` 提示一下；
  - 时长、位数、上限都只在共享协议包的 `pairing.ts` 里定一次：配对请求卡负载的短码、指纹 pattern 由 `PAIRING_SHORT_CODE_DIGITS`、`PAIRING_FINGERPRINT_HEX_DIGITS` 拼出，报错和界面上的"5 分钟""365 天"由 `durationText(常量)` 拼出；
  - 配对请求卡（`card.ts`）的 `approve` / `deny` 走卡片的按钮闭环（按版本条件更新、先到先得、后到的"已被处理"）。批准只把请求变成已批准（新设备 5 分钟内来领，`PAIRING_CLAIM_WINDOW_MS`）；**不产生素材**：这张卡不是审批卡，批准时只追加请求事件和卡片更新两条（主切面断言了），08 号票不要把它当审批决定采集。拒绝是"已处理"不是"已关闭"，不产生回避信号；
  - `rename`：同一事务里改请求、卡片负载（版本加 1，所以拿旧版本去批准得到冲突，用户批准的一定是他看到的名字）和待我处理事项的标题；
  - 待批的请求 5 分钟后过期（`PAIRING_REQUEST_TTL_MS`，调度器计时，`start()` 时把还要计时的重新登记）：卡片变成已过期、不能再处理；新设备看到的状态以时间为准（计时器还没落事件也算过期）；
  - `claim`：已批准、在领取期限内 → 生成 256 位随机凭证（base64url），同一事务里追加 `device_credential`（只有哈希）、`device`（`paired`）、请求变成已领走。原值只出现在给新设备的那一个响应里。这时设备记录**还没启用**（`activated: false`，设置里显示"等待首次使用"，`expiresAt` 是领到后 24 小时，`DEVICE_FIRST_USE_WINDOW_MS`）：领取的响应可能丢在半路上，凭证到不了设备手里，这样的"幽灵设备"24 小时里一次也没用过就自动作废（按 `expiresAt` 判断，和 365 天过期同一条路）；
  - `authenticate(cookie 原值)` / `refresh(deviceId)`：没吊销、没到 `expiresAt` 就有效，并算用了一次。第一次带着凭证来就是启用：马上追加一条 `device`（`activated`，有效期从这时起算 365 天，`DEVICE_CREDENTIAL_TTL_MS`）；之后离上一条使用记录超过一小时（`DEVICE_USE_RECORD_INTERVAL_MS`）才追加一条（`used`，`lastUsedAt` 和 `expiresAt` 往后推）——续期因此最多提前一小时失效，不会推迟；
  - `rejectionOf(cookie 原值)`：认得出、但不认的凭证是怎么回事（`revoked` / `expired`），给 `/api/access` 的 `reason` 用；
  - `revoke(deviceId, 幂等键)`：前端的 `revoke_device` 请求。同一个键重发拿到同一个结果；已吊销的再吊销 `conflict`；之后 `onRevoked` 通知网关关掉这台设备开着的 WebSocket（先把这一轮的响应发出去，所以设备吊销自己也能收到响应）。
- **凭证和 cookie**（`credentials.ts`）：`HttpOnly; Secure; SameSite=Strict; Path=/`，名字带 `__Host-` 前缀（同一 sslip.io 下别的子域名覆盖不了）。服务端只存 sha256；页面脚本里没有任何令牌，也不碰 `document.cookie`（主切面构建真的 Web UI 扫过）。
- **已配对设备**是 `ergou.db` 里的派生视图（`views.ts` 的 `paired_devices`，连同 `pairing_requests`、吊销请求的幂等键 `device_revoke_keys`）。

### 媒体与附件（09 号票）

- **媒体库**（`media/media-store.ts`）：图片和文件附件按**入库版本**的 sha256 存在数据目录素材区的 `materials/media/<sha256>`（平铺，文件名就是哈希），同样的内容只存一份；写的时候先写临时文件再改名，库里不会有写了一半的文件。**媒体 id 就是入库版本的 sha256**，消息里的图片 part、文件 part 和素材都引用它。被引用的媒体永不回收（本票不做回收）；第一阶段不生成缩略图等派生物。
- **分片续传上传**（自定义协议）：建上传（声明文件名、类型、字节数；超过 `media.maxUploadBytes`，默认 200 MB，当场 413）→ `PUT ?offset=` 按偏移写分片（偏移必须等于服务端已收到的字节数，不等回 409 带服务端的偏移；同一个上传同时只写一个分片）→ 收尾带**原始上传字节**的 sha256（不符回 422，这次上传作废、不入库；同一个上传重复收尾拿到同一个结果）。还没收尾的上传放在临时区 `tmp/uploads/`（`<id>.json` + `<id>.part`），服务端已收到的偏移就是 `.part` 的大小，所以连接中途断了，已写下的字节照样算数，守护进程重启后也能接着传。
- **图片入库前剥元数据**（`media/image.ts`）：按内容（不看文件名和声明的类型）认 JPEG、PNG、GIF、WebP，这几种算"图片"（`kind: "image"`）。JPEG 去掉 GPS、相机等全部 EXIF，**只留方向**（原图方向不是"正常"时补一个只含方向这一项的最小 EXIF，不然竖拍的照片会躺倒；方向是 5–8 时，part 里的宽高按显示出来的方向对调），也去掉 XMP、IPTC、注释、多图索引（MPF），**图像结束标记之后的数据一律截掉**（MPF 的第二张图、动态照片附带的视频等）；PNG 去掉 eXIf 和文字块；WebP 去掉 EXIF、XMP 块。剥过的才是入库版本，所以图片的媒体 id 和原始字节的 sha256 不同。**HEIC、TIFF、SVG 等其他格式当普通文件存，未剥元数据**（第一阶段的取舍，里面同样可能有 GPS）。
- **下载**：只有认得的图片 `inline` 显示，其余一律 `attachment` + `application/octet-stream`（不按声明的类型发，免得 HTML、SVG 在本机源下跑脚本），另加 `Content-Security-Policy: sandbox`；文件名从 `?name=` 来；内容按哈希寻址，`Cache-Control: immutable`。
- **发消息**（`conversation/messages.ts` 的 `postUserMessage`）：附件先上传入库，再在 `send_message` 里引用。媒体不在库里、或者把不是图片的东西当图片 part 发，回 `bad_params`。图片的类型、尺寸和文件的大小以服务端入库的为准；文件的类型按扩展名认得的优先（`media/file-types.ts` 的 `mimeFromName`）。附件菜单的"作为材料投喂"（21 号票）选的附件带 `asMaterial: true`（图片 part、文件 part 都可以），原样写进事件，素材模块据此把这条消息记成"用户主动投喂的材料"。消息里也可以引用卡片（`card_ref`，卡片要存在），给"用户引用的卡片"判定"明确点了"用；Web 聊天里每张卡下面有"引用"，引用的卡片显示在输入框上方（可去掉），发送时作为 `card_ref` 带上。
- **发给模型前的投影**（`conversation/model-projection.ts`，带版本号的纯函数，现在是第 1 版，在 `projection-v1.ts`）：**每个版本自成一个模块，用到的常量和小函数（文本扩展名表、附件分类、大小的说法、32 KB 上限、解码……）都归它自己**，不从会变的模块取，别处要用就各自定义或从 `media/file-types.ts` 这类不随投影版本变的模块取。第 1 版：第一行是消息的本地时间标记 `[YYYY-MM-DD 周X HH:mm ±HH:MM]`（发送时间按配置的 `timeZone` 换算）；之后各 part 空一行：卡片引用 → 一行摘要（卡片的纯文本降级 `text`，秘书按 `card_ref` 从卡片视图取）；图片 → 支持视觉时是图片输入、正文里"[图片 n：文件名]"，不支持时"[图片：文件名]"；文本类文件（按扩展名和类型认，含 markdown、代码、CSV；不是 UTF-8 的按 GB18030 解）→ 内联前 32 KB，超出的提示用 `read_attachment` 读；PDF → 先抽文本（`unpdf`，用到时才加载）再按文本类处理；其他类型 → 只给文件名、类型和大小；语音 → "语音转写：<识别出的文字>"，识别失败的 → "[语音，识别失败]"（31 号票，文字由调用方从 `VoiceRecord` 取来交进 `voices`）。读文件、抽 PDF 由调用方做好交进来（`media/attachment-content.ts` 先问这一版要什么：`projectorOf(version).contentNeeded(part)`），投影本身不碰文件。**改规则就加一个新版本**（新文件，在 `model-projection.ts` 的表里登记），旧版本原样留着。唯一的例外是语音（31 号票就地写进第 1 版）：语音 part 在 04 号票只是预留，`postUserMessage` 一直拒收，从没有消息带着它交给过模型，第 1 版对它的投影没有生效过；就地填上不会改变任何已有会话的投影，另起第 2 版反而让第 1 版里留一段永远走不到的分支。以后再改语音的写法照常加新版本。
- **秘书的输入**：用户消息先经投影再交给子进程（`user_input` 的 `text`，支持视觉时另带 `images`）。模型支不支持视觉看配置 `models["provider/模型 id"].vision`，没配的一律不支持（pi 的模型目录里 deepseek-flash 标着能收图片，但没有实测，默认关着）。
- **附件工具也是守护进程代为执行的工具**（和 06 的提醒工具同一套，见下面"秘书的工具"）。
- **秘书的附件工具**（`media/attachment-tools.ts`）：
  - `read_attachment({ ref, offset? })`：按附件引用（媒体 id，或本会话里唯一的至少 8 位前缀）读全文，文本类读原文，PDF 读抽出的文本，一次最多 64K 个字符、更长的用 `offset` 接着读。**只能读自己会话里的附件**（派生视图 `conversation_attachments`），读别的会话的被拒并说明原因。在工具注册表里登记为只读、幂等，不落入任何关注类别。
  - `send_attachment({ path, name? })`：把草稿区（秘书的工作目录 `tmp/scratch`）里的文件复制进媒体库（图片照样剥元数据），作为秘书的一条消息发进聊天；之后清理草稿区不影响。草稿区外的文件（含 `..`、符号链接和目录联接逃出去的）发不了：工具自己拒绝，真实路径和"在不在里面"用的是守卫的那一份（`util/real-path.ts` 的 `realPathOf`、守卫的 `isWithin`）。在工具注册表里不落入任何类别（只往二狗自己的媒体库和聊天里写，没有对外效果），路径参数不交给守卫查（不然草稿区外的路径会先出审批卡、批准了工具也照样拒绝）。

## 卡片和待我处理（`cards/`、`inbox/`，06 号票）

卡片是独立实体，消息里只放引用（`card_ref` part）；同一张卡在聊天、待我处理（以后还有时间线）里只有一份状态，状态全在卡片频道上。

**登记一种卡**（12、13、15、17……各票照这个做）：

```ts
// 负载的 schema 在共享协议包里；动作的输入 schema 也用协议包里的（或协议包转出的 Type 写）
export const myCardType = defineCardType({
  type: "suggest_task",            // CARD_TYPES 之一
  version: 1,                      // 必须等于 CARD_TYPE_VERSIONS[type]
  payload: SuggestTaskCardPayload, // 建卡和动作改出来的负载都按它校验
  actions: {                       // 不在这里的动作一律拒绝（bad_params）
    // 每个动作都写明 input：没有输入就写 undefined（类型推导靠它，省略了 run 里的 input 就推不出来）
    start_task: { input: undefined, run: (ctx) => ({ status: "handled", events: [/* 同一事务追加的事件 */] }) },
    dismiss: { input: undefined, run: () => ({ status: "dismissed" }) }, // 已关闭：自动多一条 card_dismissed
    // 有输入的：run 里的 input 就是 Static<typeof SomeInput>，不用断言
    save: { input: SomeInput, run: ({ payload, input }) => ({ status: "pending", payload: { ...payload, title: input.title } }) },
  },
  toText: (p) => `建议发起任务：${p.title}`,   // 纯文本降级版本，存进卡片的 text
  // 负载里有用户原话的卡片类型要写（21 号票）：彻底删除时卡片的新版本只留下去掉原话的负载
  purge: (p, ctx) => ({ ...p, why: PURGED_TEXT }),
});
// daemon.ts：registry.register(myCardType)
```

- `purge(payload, context)`（可选，21 号票）：彻底删除点到这张卡时改写负载（把带原话的字段换成 `PURGED_TEXT`，id 和状态不动）；卡片处理结果里用户写的说明由卡片模块统一换掉。没写 `purge` 的卡片类型被点到时，负载原样保留。动作的 `run` 返回的 `purge` 是要和卡片更新同一事务改写的事件（记忆删除卡的"彻底删除"用）。
- `run(ctx)` 拿到动作之前的卡片和负载、动作、`note`、按 `input` schema 校验过的输入（类型是 `Static<input>`）、现在的时间和请求的幂等键；返回动作之后的状态（`pending` 表示卡片还能再操作，比如改了提醒）、新的负载、处理说明，以及要随卡片更新一起追加的事件（同一事务，排在卡片更新之前）。不让做就抛 `RequestRejected`。落盘之后还要做点什么的（22 号票：任务控制落盘后提示用户、把对应的通知记成处理过）写 `afterCommit`，卡片更新连同事件落盘之后叫一次。
- **按钮闭环**由 `cards.act` 统一做：同一个幂等键重发直接回第一次的 ack；卡片不是待处理 → `conflict`"已被处理"；版本对不上 → `conflict`；动作不认识 → `bad_params`；输入不合 schema → `bad_params`。ack 是 `{ cardId, version }`，卡片本身随后在卡片频道推送。存储是同步的，两个前端同时点同一版本只会有一个生效。**卡片动作只接受来自前端的请求**：不要给 agent 任何对卡片做动作的工具。
- 系统建卡、改卡：`cards.create(...)`；要和别的事件原子地一起追加，用 `cards.buildCreate(...)` / `cards.buildUpdate(cardId, { payload?, status?, outcome? })` 拿到 `{ card, event }`，自己放进 `store.appendBatch`。
- 在聊天里出现一张卡：往会话里追加一条带 `card_ref` part 的消息（秘书的工具返回 `cardIds`，秘书模块代劳，见下面"秘书的工具"）。

**待我处理**：

- 事项在协议里是判别联合 `InboxItem = CardInboxItem | NoticeInboxItem`；`NewInboxItem` 是它们去掉由服务生成的字段。
- 放进一条事项：`inbox.add({ kind: "card", cardId, title, source, urgency })`，或者通知类 `inbox.add({ kind: "notice", notice, title, body, source, urgency, pinned?, actions, cardId?, data? })`（`notice` 取 `NOTICE_TYPES`；`cardId` 是相关的卡，详情页里显示在通知下面；`data` 放这种通知自己的结构化内容）。要原子地和别的事件一起追加，用 `inbox.buildAdd(...)`；系统改一条事项（比如取消置顶）用 `inbox.buildUpdate(item, change)`；和某张卡有关的事项用 `inbox.itemsForCard(cardId)` 找。要马上告诉用户（页面内提示、浏览器通知），追加之后调 `inbox.alert(item)`。用户选了通知的某个动作之后要做点什么的（比如"备份失败"上的"重试"），用 `inbox.onNoticeHandled(通知种类, 动作, fn)` 登记：每条事项只在用户第一次选这个动作时叫一次（重发、再选同一个都不叫），不用自己订阅事件；14、19 号票的通知照这个做。
- **处理过没有只有一份判断**：共享协议包 `inbox.ts` 的 `isInboxItemProcessed(item, 卡片状态)`。卡片事项看卡片的状态，通知类看有没有选过它的动作；卡片状态不知道（前端还没收到、找不到）时算没处理过。守护进程、Web 状态层（`inboxItemProcessed(state, item)` 是它的包装）、原型的假连接都用它。
- 紧急度三档 `blocking_deadline` / `blocking` / `non_blocking`。**卡着任务**（前两档）的事项处理之前，归档或删除被拒（`not_allowed`，说明原因）。卡着任务的事项出现后，由产生它的票补主切面场景（本票在模块层测，`test/inbox.test.ts`）。
- 前端的动作是 `inbox_action { itemIds, action, choice? }`：`read` / `unread` / `archive` / `unarchive` / `delete` / `handle`（处理通知，`choice` 是它的 `actions` 之一）。一次多项时要么全部生效、要么全部不生效；没有变化的事项不推送。

## 调度器和简单提醒（`scheduler/`、`reminders/`，06 号票）

- **时钟可注入**（`scheduler/clock.ts` 的 `Clock`：`now()`、`setTimer(at, fn)`）。`startDaemon({ clock })`，不给用系统时钟；事件时间也跟着它走。测试用 `test/helpers/clock.ts` 的 `ManualClock`：`advanceTo(时刻)` 时途中到点的计时器按先后依次触发，触发时 `now()` 正好是那一刻（重复的提醒在一次拨动里能响好几次）；`jumpTo(时刻)` 像电脑睡着又醒来，途中到点的计时器醒来时才一起触发、`now()` 是醒来的时刻（测"晚了才到点"）。
- **调度器**（`scheduler/scheduler.ts`）：`schedule(key, at, run)`（同一个 key 再登记就换掉）、`cancel(key)`、`pending()`。它只管内存里的计时器；要做的事和下一次的时间存在各模块的派生视图里，守护进程启动时由各模块重新登记。定时作业、错过的触发、内部作业（19 号票）都挂在它上面：在 `daemon.ts` 里拿 `scheduler` 登记。
- **时间规则只在一个模块里**：共享协议包的 `reminder-schedule.ts`。`ReminderSchedule` 的 schema、重复规则 `RepeatRule`（种类 `REPEAT_KINDS` 只定义这一次）、以及全部按规则种类分支的逻辑：`nextOccurrence`（下一次响的时间）、`latestOccurrence`（停机期间错过的最后一次和一共错过几次，提醒和定时作业共用）、`occurrencesBetween`（一段时间里的每一次，日历上展开用）、`scheduleClockTime`（钟点）、`withClockTime`（只改钟点）、`repeatSchedule` / `repeatRuleOf`（重复规则和时间表互转）、`isRepeating`、`describeSchedule` / `describeTime`（中文写法，"每月 31 号"会写明没有这天的月份在月底）。守护进程（提醒模块、秘书的工具、内部作业）和 Web（提醒卡、编辑框、看板）都用它，别处不按 `schedule.kind` 分支。重复规则有每天、每周几、每月几号、**按我的工作日**（`{ kind: "workdays", time }`，29 号票）：只在个人工作日历上的上班日响。`nextOccurrence(schedule, after, context)` 的第三个参数 `ScheduleContext { calendar }` 必填（漏传编译时就报错），每次按当时的工作日历算；哪些时间表要跟着工作日历变，问 `dependsOnWorkdayCalendar(schedule)`（提醒的 `recalculate`、内部作业的 `rearm` 都用它，不自己看 `kind`）。只要某个钟点下一次出现的时刻（不管工作日历）用 `nextClockTime(time, after)`。19 号票的定时作业沿用这同一套。
- **简单提醒**（`reminders/`）：
  - `schedule.ts`：秘书在工具里给的时间 → 时间表（纯函数，不看时钟）。写法有：具体的本地日期时间 `at`（YYYY-MM-DD HH:mm）、哪天几点 `date` + `time`、最近的周几 `weekday` + `time`、几天后 `inDays` + `time`、几分钟后 `inMinutes`、只给几点，或者几点加 `repeat`。`editedSchedule` 处理改提醒时只给了一部分（只给几点：日期和规则不变；"改到周五"：`weekday`，钟点不变）。时间不对抛 `ReminderInputError`（就是 `bad_params` 的 `RequestRejected`）。
  - `reminders.ts`：`create` / `update` / `cancel`（秘书用；提醒卡跟着变），`editFromCard` / `cancelFromCard`（直接给出提醒卡按钮的 `CardActionEffect`）。每次变化是看板频道上一条 `reminder` 事件；`start()` 把待触发的提醒登记进调度器，之后跟着每条 `reminder` 事件重新登记，所以守护进程重启后还没到点的提醒照常触发。到点：一次性的变成已触发、提醒卡变成已过期（界面上写"已触发"），重复的算出下一次；同一事务里放一条置顶的待我处理事项（`reminder_due`，相关的卡是提醒卡），再推一条临时的 `notify`。不拉起任何 agent。同一个提醒在待我处理里最多一条置顶：新的一次到点时，上一次的置顶事项取消置顶（还没处理的顺手归档）。
  - **晚了才到点**（启动时已经过了点，或者电脑睡着了，规格第 13 节）：晚了 60 分钟以内照发，事项里写明晚了多久，事件带 `lateMinutes`；更晚的不弹提示、不发浏览器通知，改放进待我处理（`missed_reminder`，不置顶），事件的 `change` 是 `missed`。重复提醒错过多次只按最近一次处理。19 号票把同一套规则扩到定时作业。
  - 提醒的编号是 `r-1`、`r-2`……（短，秘书好引用）。
  - **按我的工作日**（29 号票）：`createReminderService({ scheduleContext })` 给当前的工作日历；工作日历变了（个人设置、导入了节假日数据），`daemon.ts` 叫 `reminders.recalculate()`：跟着工作日历变的待触发提醒（`dependsOnWorkdayCalendar`）按新的工作日历重算下一次，变了就追加一条 `updated`（`by: "system"`），提醒卡跟着变——"把明天标成休息"不用重建提醒。启动时也对一遍。
  - `card.ts`：提醒卡，动作 `save`（输入 `ReminderEditInput`：新的时间或重复规则，可连内容一起改；卡片仍待处理）和 `cancel_reminder`（卡片已处理）。

## 个人工作日历（`workday/`，29 号票）

规格第 21 节。我的工作日 = 新加坡工作日（周一到周五，去掉新加坡公众假期，含补假）∪ 国内工作日（周一到周五，去掉国内放假日期，加上调休补班的周末）∪ 额外上班规则 ∪ 手动标记的上班日 − 手动标记的休息日。计算是协议包 `workday-calendar.ts` 的纯函数，守护进程和 Web 共用；节假日数据的校验（`checkHolidayYear`：schema、日期在那一年里且真实存在、不重复、种类是这个地区能有的——`HOLIDAY_KINDS_BY_REGION`：新加坡没有调休补班，国内没有补假）、合并（`mergeHolidayYears`：同一地区同一年以后面的为准）、文件名（`holidayFileName`：`<地区>-<年>.json`）、格子里的短词（`dayShortLabel`、`isManualDay`）也都在那里，只此一份。日期小工具（`parseLocalDate`、`localDate`、`weekdayName`、`pad2` 等）在协议包的 `local-date.ts`。

- **节假日数据**（`holiday-data.ts`）：一个地区一年一个 JSON（`HolidayYear`：`{ format: 1, region, year, sources, days: [{ date, name, kind }] }`，`kind` 是 `holiday` / `observed`（新加坡补假）/ `makeup_workday`（国内调休补班））。框架自带的在本包 `holidays/`，从 `docs/research/13-holidays-sg-cn.md` 导入（新加坡 2026、2027，国内 2026；国内 2027 未公布，不自行推算），`test/workday/holiday-data.test.ts` 按调研文件逐日核对。**框架的数据靠发版更新**：新的一年公布后，调研文件同步更新，照同一格式加一个文件，跑这个测试。导入的在配置区 `config/holidays/`，同一地区同一年以导入的为准（`mergeHolidayYears`）。缺某一年的数据时那一边按周一到周五算，结果里 `missing` 标明。
- **个人设置**（`calendar.ts` 的 `createWorkdayCalendarService`）：配置区 `config/workday-calendar.json` 是真相（`WorkdaySettingsFile`：`{ format: 1, rules, marks }`，由 `WorkdaySettings` 推出）。只由运行时写：设置接口（HTTP，`change`）和快速动作执行器（`prepare`：先写文件，返回要和卡片、操作记录同一事务追加的事件）。每次有变化追加一条 `workday_settings`；**启动时读入配置文件**：和上一条事件不一样（停着时手改过、从备份恢复了配置区、上次写完文件没来得及追加事件）就以文件为准补一条（`source: "config_file"`），提醒和作业跟着重算，框架自带或导入的节假日数据变了补一条 `holiday_data`。`current()` 是当前的工作日历，`onChange(fn)` 在个人设置或节假日数据变了时叫（`daemon.ts` 用它让提醒 `recalculate`、内部作业 `rearm`）。agent 写不进配置区（受保护区域，03 号票）。
- **快速动作"改工作日历"**（`quick-action.ts`，类型 `workday_calendar`）：参数 `{ change: mark_rest | mark_work | clear_mark | add_rule | remove_rule, date?, rule? }`，秘书把"下周一"换算成具体日期、把规律换成确定的规则（每周几、每月第 N 个周几、每月最后一个周几）；规范化成 `WorkdayChange`，卡片标题是给用户核对的写法（"把 2026 年 10 月 12 日（周一）标为休息"）。`confirm: "always"`：一律先确认（日期和规则是秘书换算的，"点明了"的判定因此不需要），不落入任何关注类别。秘书没有直接改工作日历的工具。
- **节假日数据的续期**（`holiday-check.ts` 的 `createHolidayUpdates`，`daemon.holidayUpdates`）：
  - 每月检查：内部作业 `holiday_data_check`，每月 `holidayCheck.dayOfMonth` 日 `holidayCheck.time` 跑（默认每月 1 日 09:00）；到了 `holidayCheck.fromMonth`（默认 12 月）及以后查下一年，之前的月份查今年——整个 12 月都没开机，1 月开机补跑时查今年，照样查得出缺数据。缺了就放一条 `holiday_data_missing` 事项（不卡任务，`data: { year, regions }`，标题和说明按实际查的年份写，比如"缺 2027 年国内节假日数据"，动作 `HOLIDAY_UPDATE_ACTION`"发起更新任务"）；同一年同样的缺失已经有事项就不再放。
  - 发起更新任务：用户点"发起更新任务"（`inbox.onNoticeHandled`）→ `tasks.buildCreate({ title, summary, origin: "button" }, "user")` 建任务（规划中，出现在看板上），同一事务追加内部频道的 `holiday_update_task`（任务 id ↔ 年份、哪一边）→ `tasks.writeBrief` 把 `holidayUpdateBrief(year, regions)` 写好的任务书交给维护者：年份、哪一边、官方来源（`officialSources`：新加坡是人力部新闻稿 `https://www.mom.gov.sg/newsroom/press-releases/<发布那年>/<MMDD>-public-holidays-for-<年>`、公众假期页、data.gov.sg 的 `datastore_search?resource_id=<数据集 ID>`；国内是国务院办公厅通知（中国政府网"最新政策"和 `ZUIXINZHENGCE.json`）、国务院公报作备份，并提醒核对《全国年节及纪念日放假办法》有没有再修订）、交付件的格式和文件名、计划的工具包要开联网。不经秘书澄清（不用 `startFromButton`）：要做什么是确定的。之后照常：维护者交计划，在计划卡上确认。
  - 导入交付件：`holidayUpdates.importForTask(taskId, workDir?)`——不是更新任务返回 `undefined`；是的话把工作目录（不给是产出区 `outputs/<任务 id>/`）里的 `<地区>-<年>.json` 逐个交给 `workdayCalendar.importHolidayFile(路径)`（`checkHolidayYear` 校验后放进 `config/holidays/`，推一条 `holiday_data`），没交的、不对的写进 `problems`（什么都不改）。数据补上后对应的缺失事项自动归档（标题加"（已补上）"）。**已由 13 号票接上**：`daemon.ts` 把 `taskExecution.onCompleted` 接到 `holidayUpdates.taskCompleted(completed)`，任务完成（全部阶段验收通过）时它导入交付件，`problems` 不空就由这里在待我处理里放一条 `holiday_import_problem` 说明（`non_blocking`，`data { taskId, problems }`；见下面"任务执行与阶段验收"）。

## 素材（`materials/`，08 号票）

规格第 15 节、记忆子地图「素材管理」。第一阶段只积累和建索引：没有抽取、推断，也没有素材的页面。素材有两份真相：**事件日志**和**本人素材的原文副本**，`memory.db` 是能整个重建的派生，取舍见 ADR-0006。别的模块只从 `materials/index.ts` 取东西。

- **素材只从事件日志产生**：素材模块订阅事件存储，登记过的事件类型一来就按采集规则（`capture.ts` 的 `MaterialSource`）产生素材。agent 没有任何写素材、挑选素材的工具；`Materials` 对外只有读、检索和登记来源。采到事件日志的哪一条（全局序号）记在 `memory.db` 里、和素材同一事务：守护进程停着时追加的事件，启动时补采；同一条事件不会采两次。素材 id 由事件（频道、频道内序号、时间）、采集规则的名字和第几条算出来。
- **原文副本是本人素材的真相**（`originals.ts`）：本人素材（来源本人，或者里面有本人的话）连同整个信封存成 `materials/originals/<年-月>/<素材 id>.json`（`{ format: 1, position, material }`，本人切段里就是原文），写完设为只读；只用"不存在才创建"的方式写，重复处理落到同一个文件、不再写；素材模块不提供改写、删除它的接口。系统观察到的（长期没处理）没有原文副本。
- **重建**：删掉 `memory.db` 再启动 = 从事件日志采出的素材 ∪ 原文副本里事件日志已经没有的本人素材（按素材 id 去重）。每次启动都会把"原文副本里有、`memory.db` 里没有"的补回来，所以**删项目时可以删掉维护者会话的事件**，用户在里面说过的话照样在、能检索。
- **彻底删除的"已删除"标记**（08 号票定格式，21 号票做删除，见下面"快速动作与记忆命令"）：事件的频道、序号、类型、时间不变，负载整个换成共享协议包的 `DeletedEventPayload`：`{ deleted: true, deletedAt, messageId?, messageTime? }`，原文一个字不留；认它用 `isDeletedEventPayload`（守护进程和 Web 共用）。素材采集遇到它一律跳过、不写原文副本。21 号票彻底删除时只有消息事件整条换成这个标记，别的事件字段级改写（见下面"快速动作与记忆命令"），同时删掉对应的原文副本（先去掉只读属性）和 `memory.db` 里的素材；"忘掉"、"别推断"、按会话或时间段删除也要先追加一条事件记下来（素材模块把它当采集规则处理）、再删原文副本，否则重建时会回来。
- **`memory.db`**：数据库区里单独的库（WAL），经存储薄接口打开；只有 `materials/` 拿得到连接（`test/materials/boundary.test.ts` 检查）。表：`materials`（信封）、`material_fts`（FTS5 trigram）、`material_vectors`（向量和模型名）、`capture_state`（采集位置）；`PRAGMA user_version` 是库的版本，以后改表据此迁移。
- **信封**（`types.ts` 的 `Material`）：`{ id, kind, mode（说 say / 做 do）, time, conversation, task, project, source（来源等级）, ref（指向原始事件，以及消息 id / 卡片 id / 别的记录 id）, context（情境标签）, segments（切段）, original（原文副本的路径和 sha256，没有的是 null）}`。**一条事件（一条消息、一次反应）一条素材**；信封的来源等级是"这件事是谁做的、谁说的"，每个切段另有自己的来源。
- **任务或项目**：取自消息事件负载里可选的 `taskId`、`projectId`。**13、15、16 号票往维护者会话里追加消息（用户发的和维护者的）时，要把这条消息所属的任务、项目 id 放进 `message` 事件的负载**；秘书会话里没有。
- **七类素材事件加回避信号**（`MATERIAL_KINDS`，说或做在 `MATERIAL_MODE`）：用户发言（说）、用户对产出的反应（做）、审批决定（做）、澄清问题的回答（说）、用户主动投喂的材料（说）、显式记忆命令（说）、任务结局（做）、回避信号（做）。本票接上了：
  - 用户发言：任何会话频道上发言方是 `user` 的 `message` 事件（秘书会话、维护者会话，包括附件引用）；带 `asMaterial` 标记的 part（21 号票的"作为材料投喂"）时记成用户主动投喂的材料。agent 的回复、系统说明不算；
  - 回避信号：`card_dismissed`（来源本人；配对请求卡不算）和 `card_stale`（来源系统），卡片只留引用，类型和标题（事件里的 `cardText`）作说明；
  - 审批决定（07 号票，`approvals/material-source.ts`，在 `daemon.ts` 里登记）：`guard` 频道的 `approval_decided`（批准、拒绝、收窄），一次决定一条。用户的选择"批准 / 拒绝：工具中文名「参数摘要」"是本人、注明 agent 先提出，拒绝时写的说明是用户自己的话；情境标签是 `decision:…`、`tool:…`、`category:…`，引用审批 id 和审批卡 id。"交给我做"事项上点"已完成"不算审批决定。
- **接入一种素材来源**（07、12、13、14、15、17、20、21、22、26、27 各票照这个做）：事件类型照常加进共享协议包的 `EVENT_TYPES`（`MaterialSource.eventType` 的类型就是 `EVENT_TYPES` 的值），然后在 `daemon.ts` 里、`materials.start()` 之前：

```ts
materials.register({
  name: "approval-decision",               // 唯一，定了别改（素材 id 由它算出来）
  eventType: EVENT_TYPES.approvalDecided,   // 自己的事件类型
  capture: (event) => {                     // 确定性的：只看事件本身；不算素材的返回 []（"已删除"标记不会交过来）
    const p = event.payload as ApprovalDecidedPayload;
    return [
      userDecisionDraft({
        kind: "approval_decision",
        accepted: { text: p.summary, field: "summary" }, // 用户接受的是 agent 先提出的东西：本人，注明 agent 先提出
        typed: p.note ? [{ text: p.note, field: "note" }] : [], // 用户自己写的话：本人
        task: p.taskId, context: [`decision:${p.decision}`], ref: { recordId: p.approvalId },
      }),
    ];
  },
});
```

  要别的形状就自己拼 `MaterialDraft`（`kind`、`source`、`segments` 用 `segmentPieces` 切）。
- **切段与来源标记**（`segments.ts`，纯函数，表格测试在 `test/materials/segments.test.ts`）：输入 `MaterialPiece` 的 `form` 和切出来的段的 `form`（`SegmentForm`）是同一套名字。用户打的字、判断不了来历的纯文本 → 本人；消息里的引用块（行首最多三个空格接 `>`，连续的行一段；不做 Markdown 的惰性续行）、附件（图片、文件、视频）、抓取的网页 → 外部、不可信；用户接受的 agent 提议（`choice`）→ 本人、注明 `agent_proposed`；语音转写 → 本人、注明 `transcribed`；agent 的产出 → agent。**只有本人的切段留文字**，其余只留引用（在原始记录里的位置 `locator`、媒体引用、网址、卡片 id）加内容哈希（附件的哈希就是媒体 id，即入库版本的 sha256），外加**引用的说明** `label`：附件的文件名、网页的网址、卡片的类型和标题。
- **关键词检索** `searchKeyword(query, { limit })`：索引的是本人的文字加上引用的说明（所以"彻底删除我发的体检报告"按文件名找得到，只发了附件的消息、回避信号也搜得到）；外部内容和 agent 产出的正文不进。查询按空白拆词、每个词都要出现；3 个字以上的词走 FTS5 trigram 索引（按相关度），3 个字以下的词在结果里做子串过滤，全是短词时整个退回子串扫描（新的在前）。英文不分大小写。
- **向量**（`vectors.ts`）：素材入库后在后台补算（不卡写入：写入在向量算出之前就返回），算的是和关键词索引同一份文字；每条向量旁边记模型名，换了模型（名字变了）旧向量不参与检索、整批重算。**守护进程启动时不马上补算**：过 30 秒（`BACKFILL_DELAY_MS`）再开始，免得加载模型、重算一大批和秘书的拉起抢 CPU；期间新来的素材照常马上算。`searchSemantic(query, { limit })` 暴力扫描当前模型的全部向量（存的是归一化向量，余弦就是点积）；模型不在时抛 `EmbeddingUnavailable`。`vectorStatus()` 看补算到哪了。算出错记日志，1 分钟后重试。
- **向量模型**（`embedding/`）：`Embedder` 接口（`model`、`available()`、`unavailableHint()`、`embed(texts)`、`close()`）。正式的是 `bge-m3.ts`：Hugging Face 上 `Xenova/bge-m3` 锁定版本的 q8 量化 ONNX（约 570 MB），文件放在数据目录**模型区** `models/Xenova/bge-m3/`；模型名 `Xenova/bge-m3:q8@<版本前 8 位>`。推理在**工作线程**里（`worker-host.ts` 拉起 `worker.ts`，加载 `bge-m3-backend.ts`，transformers.js + onnxruntime-node，CPU，最多 4 个线程，CLS 池化加归一化，1024 维），不阻塞守护进程的事件循环；第一次要算时才拉起，闲置 10 分钟结束线程、还回内存；模型加载失败时这个线程作废，下次重新加载。两边的消息形状和后端参数的类型在 `worker-types.ts`。transformers.js 只在 `bge-m3-backend.ts` 里引用（边界测试检查）。
- **模型文件不在时**：素材入库和关键词索引照常；守护进程在日志里、并在待我处理里放一条通知（`embedding_model_missing`，只放一次）提示运行 `npm run download-model -- --data-dir "<数据目录>"`；之后每 5 分钟看一次，模型就位就补算缺的向量（不用重启），那条通知收进归档。下载命令（`src/download-model.ts` → `downloadBgeM3` → `embedding/model-files.ts`）先写 `.part`、核对大小和 sha256 再改名，已经在的文件跳过；**不随仓库分发、守护进程不自动下载**。
- **回避信号计时**（`avoidance.ts`）：建议发起任务卡、建议立项卡、提问卡从建卡起 `materials.staleCardDays`（默认 7，默认值只在配置里）天还待处理，调度器上的内部作业追加一条 `card_stale`；期间处理了就取消。计时器跟着卡片事件登记，守护进程启动时按卡片视图重新登记，停着时过了点的启动后补上，`time` 记到期的时刻（不是补发的时刻）。
- **删除和标记**（21 号票）：`memory.db` 里另有 `material_marks`（素材 id → 已忘掉 / 不参与推断，库版本 2）。忘掉（含彻底删除）的素材从 `materials`、关键词和向量索引里删掉，原文副本去掉只读后删除，同时记下"已忘掉"（墓碑）：之后重放、补采、从原文副本补回都跳过它。信封多了 `noInfer`。这些都只跟着 `memory_command` 事件做（`commands.ts` 的 `commandEffect`），删 `memory.db` 重建时照样重做；启动补采之前先把事件日志里的忘掉记下（不然补采会先把要删的原文副本写回来）。
- `memory.db` 和素材区的备份见 11 号票（一定要备份 `materials/originals/`，它是本人素材的真相，文件是只读的；模型区可以不备份，能重新下载）。

## 语音消息（`voice/`，31 号票）

规格第 22 节、第 21 节"语音识别"。用户在 Web 上按住说话，录音只在本地，抬手后整段经分片续传上传，传完发一条只有一个语音 part 的消息（可以带用户引用的卡片）；守护进程收下、在后台用 faster-whisper 识别，识别完成前这条输入在 agent 的输入队列里等着。第一阶段不用大模型修正（用户 2026-10-08 定，ADR-0011）：气泡下方直接显示的、交给 agent 的、素材里存的都是同一段识别出的文字。

- **一条语音和它的文字是同一个数据对象**（协议包 `voice-schema.ts` 的 `VoiceRecord`）：音频（入库的媒体，按内容哈希）、时长、格式（按内容认出的音频类型）、波形摘要（画气泡用，最多 64 格 0–100）、faster-whisper 的识别结果 `recognition`（识别出的文字、分段、语言、实际用的模型 / 设备 / 计算精度、退回 CPU 的原因、耗时）、识别状态、第几次识别。状态的每次变化是会话频道上的一条 `voice` 事件，派生视图 `voices`。消息里的语音 part `{ voiceId, mediaId, mime, durationMs, waveform }` 只引用它；前端发送时不带 `voiceId`，服务端填上（前端带了也不算）。识别完成的语音的文字用协议包的 `settledVoiceText(voice)` 取（排队、识别中、失败的没有），一条消息引用了哪些语音用 `voiceIdsOf(parts)`：前者守护进程（交给 agent、点明判定、素材、重新识别的通知）和 Web 状态层共用，后者守护进程里共用。
- **收下**（`voice.ts` 的 `intake`，经 `postUserMessage` 的 `voices` 参数、网关的 `RequestHandlers.voiceIntake`）：录音要在媒体库里、按内容认得是音频（`media/audio.ts` 的 `sniffAudio`：webm、ogg、mp4、wav、flac、mp3、aac）、不短于 1 秒（`VOICE_MIN_MS`）、不长于 60 秒加 2 秒余量（schema 管），语音消息里只能有这一段语音，另外可以带用户引用的卡片（`card_ref`，"引用这张卡，说'把这个取消'"），不能和文字、附件、别的语音一起发；`voice` 事件和消息同一事务追加，幂等键由发送请求的推出（重发不多出一条语音）。语音 part 可以带录音的诊断 `capture`（37 号票；61 号票加了开麦原因、冷启动耗时、最大振幅、麦克风诊断记录和浏览器，见下面"麦克风让路"。宽松：网关收的时候不校验它，`voice.ts` 的 `captureOf` 只取认得的、类型对的字段，毫秒数取整，负数丢掉，超长的截断——上限在协议包的 `VOICE_CAPTURE_TEXT_MAX`，前端、schema、守护进程共用——带得不对也不拒收），整理后存进 `VoiceRecord.capture`，消息的 part 里不留。认得的音频下载时按它的类型 `inline` 发（页面里直接播放，支持 Range）。
- **识别**：一次一条、按排队先后；守护进程重启时排队、识别中的接着识别。识别进程（`recognizer.ts`）要用时才拉起（45 号票起守护进程一启动就由预热拉起）：`[配置的 Python, recognizer.py]`，放进它自己的 Job 对象（不放 agent 管家的 Job：那里会把守护进程直接起的进程当孤儿回收），环境是 `buildChildEnv` 的系统变量白名单加 `RECOGNIZER_ENV`（`HF_HUB_OFFLINE=1` 只从本机缓存加载模型、不联网，输出 UTF-8）；`voice.recognizer.idleMinutes` 为 0（45 号票起的默认）时常驻、不因闲置退出，配了正数的闲置这么久就让它退出、释放显存（状态记成已卸载）；一次识别最多等多久按语音时长和设备算（`recognizeTimeoutMs`：`voice.recognizer.timeout` 的余量 + 语音时长 × 每秒语音最多等几秒，显卡、CPU 各一个；识别进程刚拉起、还没加载模型时再加冷启动的余量，而且不知道会不会退回 CPU，按宽的算；不给时长按最长的 60 秒算），超了就结束它、这条记成失败，后面排队的输入不再等它。两边走 stdin / stdout 的 JSON 行（照 08 号票向量工作线程的请求 / 应答：`{ id, type: "transcribe", path, language, initialPrompt }` → `{ id, result }` 或 `{ id, error, fatal? }`，拉起后第一行是 `{ type: "init", primary, fallback }`，紧接着是 `{ id, type: "load" }` → `{ id, result: { model, device, computeType, loadMs, fallbackReason? } }`，加载出错一律是致命的；真的识别排在加载后面，加载最多等 `timeout` 的余量加冷启动）。识别模型的状态经 `Recognizer.state` / `onState` 给出。Python 那边（`recognizer.py`）收到 `load` 就加载模型（没收到就在第一次识别时加载）：先用 primary（默认显卡上的 large-v3、int8_float16），没有显卡、加载失败（显存不够）或识别时显卡出错就退回 fallback（默认 CPU 上的 small、int8），结果里记下实际用的和原因；识别带 `vad_filter`（短语音的静音最容易让 Whisper 编话）；库打到 stdout 上的东西改到 stderr，stdout 只留给协议。起不来、模型加载失败（`RecognizerUnavailable`）：这条记成失败（"语音识别不可用：……"），待我处理里放一条 `voice_recognizer_unavailable`（开着的只有一条），守护进程照常；之后识别成功就把它收进归档。没识别出内容的也记成失败。
- **交给 agent**：`AgentSession`（秘书和维护者共用）的队首是还没识别完的语音时，它在队里等着，后面的也不越过它，也不为它唤起 agent；识别有了结局（`voice` 事件）再看队首。插话（任务维护者干活时）也一样：队里排在它前面的语音（正在处理的那条除外）和它自己的语音都识别出了结局，才当插话送（`settledUpTo`），否则留在队里，识别完了按先后作为输入处理。交过去的投影见上面"发给模型前的投影"。识别失败、交过去之后用户在气泡菜单里"重新识别"（`retry_voice { voiceId }`，只有失败的能重新识别）：成功后另追加一条交给 agent 的通知（`agentInput` 的系统消息，"用户重新识别了之前没识别出来的那条语音，转写如下：……"，幂等键 `voiceRetryNoticeKey`）；还没交过去的照常排队等着。
- **素材**（`material-source.ts`，在 `daemon.ts` 里登记）：识别完成的 `voice` 事件产生一条"用户发言"（本人），时间是说话的时间，情境标签带 `voice_transcript`，切段是语音转写（注明 `transcribed`）：`text` 是识别出的文字，`media` 是音频；原文副本里两样都在。识别失败的不产生素材；消息事件本身不产生（`materials/sources.ts` 跳过语音消息）。
- **快速动作的点明**（规格第 22 节）：语音转写和用户打的字一样参与"点明"判定（用户发的语音，识别出的文字直接显示在气泡下方，就算用户确认过）。`quick-actions/explicit.ts` 的 `UserTurn.spoken` 是这条消息里识别完成的语音的文字（`userTurnOf` 的 `voiceTextOf` 从 `voice/views.ts` 取），`ownWords(turn)` 把打的字和语音转写一起交给判定（`foundIn`、`commandTails`、任务控制都用它），点明的来源分开记：打的字是 `typed`，语音是 `voice`（"记住"的素材切段因此是 `form: "voice"`、注明 `transcribed`，`REMEMBER_SOURCES` 多了 `voice`）。识别失败的语音没有文字，不算点明。
- **彻底删除**：素材的原始事件是识别完成的那条 `voice` 事件，改写函数 `voicePurge` 把识别出的文字、分段、失败原因换成删除标记（状态、模型、时长不变），并声明连带改写（`PurgeRewriter.related`，记忆模块的 `purgePlan` 顺着它找）：这条语音的消息（整条换成"已删除"，没有别的引用的音频随之删掉）、它的别的 `voice` 事件、重新识别后交给 agent 的通知；会话文件里那几条输入照常按 `messages_purged` 改写。识别完成时消息已经不在了（被删了）就不再写识别结果。设置里按会话、按时间段彻底删除时，范围里没有素材的语音（识别失败的、还没识别完的、素材早先被忘掉了的）也要删：`voicePurgeTargets(store, scope, 这次删的素材)` 找出它们的 `voice` 事件，记忆模块的批量删除（`createBulkMaterialDeletion` 的 `unmaterializedPurgeTargets`）把它们交给 `purgePlan` 的 `extraTargets`，连带的照上；范围里只有它们、没有素材时照样执行。范围的统计（`MaterialScopeSummary.voices`）带上这类语音有几条，设置页据此提示、允许彻底删除。忘掉、别推断只管素材，不碰它们。
- **配置**见下面"配置"的 `voice`。**测试一律用假的识别进程**：`startTestDaemon` 默认的识别进程是 `test/fixtures/fake-recognizer.mjs`（和 `recognizer.py` 说同样的 JSON 行，结果由"录音"里的指令定：文字、退回 CPU、出错、模型加载失败、中途退出、等某个文件出现再回、往 stdout 打噪声；记录写进返回的 `recognizerLog`。45 号票起它也认 `load`：怎么回由记录文件旁边的 `<recognizerLog>.load.json` 定——退回 CPU、加载失败、中途退出、等某个文件出现、报的加载耗时；`startTestDaemon({ recognizerLoad })` 在起来之前写好，之后用 `helpers/voice.ts` 的 `setFakeLoad(recognizerLog, 指令 | undefined)` 改）；换识别进程用 `startTestDaemon({ recognizerCommand })`（`startDaemon` 同名选项）。`helpers/voice.ts` 另有 `fakeRecording(指令)`（WebM 头加指令）、`sendVoice(frontend, url, 指令, { conversation?, durationMs?, waveform? })`（上传再发语音消息）、`voiceSettled(frontend, 状态)`、`voiceVersions`、`recognizerLog`。主切面在 `test/main/voice.test.ts`，识别进程的宿主在 `test/voice/recognizer.test.ts`（含 Job 对象），Python 脚本在 `test/voice/recognizer-py.test.ts`（faster-whisper、ctranslate2 换成临时目录里的替身模块，`-s` 不读用户的 site-packages；本机没有 Python 时跳过，`ERGOU_TEST_PYTHON` 可以指定），认音频在 `test/media-audio.test.ts`。前端回放用的录制是 `voice-message`（"演示流程"），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/voice.test.ts -t 演示流程`。
- **Web**：输入栏右侧的按钮在文字 / 语音之间切换（选的模式记在 localStorage），左边的加号不变；语音模式下整个输入框是"按住 说话"（`ui/conversation/VoiceInput.tsx`）。手势的规矩是状态层的纯函数 `state/voice-gesture.ts`（按下、上划超过 60 像素进"松开取消"、抬手发送、不到 1 秒"说话时间太短"、最后 10 秒倒计时、60 秒自动发送、没有麦克风权限的提示、波形摘要），麦克风预热（37 号票，用户 2026-10-08 定：提前加载麦克风但不记录）：进语音模式（输入框挂上，包括打开页面时恢复成语音模式）就 `getUserMedia`、接好音量分析，但不建也不启动录音器；按下的那个 pointer 事件里同步 `MediaRecorder.start`，不出"准备中"、计时从按下算起；抬手、取消只停下这一段的录音器，流留着接着下一条。离开语音模式（卸下）、页面切到后台立刻停掉所有音轨；回到前台再预热；打字、分屏时也立刻停掉，焦点回来 0.5 秒后再预热（61 号票，见下面"麦克风让路"）；语音模式里闲置不关（44 号票，用户 2026-10-09 定：开着没关系，放多久都按下即录）；刚进语音模式就按、或者预热没打开（失败、系统收走了麦克风）时照旧"准备中"、就绪后才计时。第一次进语音模式时自动要权限，被拒了提示怎么开，之后这个页面上不再自动要（按下照样要）。开关时机是纯函数 `state/voice-mic.ts`（`voiceMic`、`voiceMicWanted`），把手势、开关时机、录音、前后台接起来的是 `app/voice-session.ts`（`VoiceSession`：`enter` / `leave` / `press` / `move` / `release` / `frame`），录音在 `app/voice-recorder.ts`（`open` 预热、`begin` 开录、`stop` / `cancel` 停这一段、`close` 关麦克风；能录什么格式就用什么），真的浏览器接在 `app/voice-browser.ts`；`test/app/voice-session.test.ts` 用假的 getUserMedia、MediaRecorder、音量分析、前后台和时钟测。每条语音带上录音的诊断 `capture`（按下 → 录音器 `start` 事件的毫秒数 `startDelayMs`、预热命中 `prewarmed`），守护进程整理后存进 `VoiceRecord.capture`（消息里不留），本机接口 `GET http://127.0.0.1:8810/api/conversations/secretary/messages` 的 `voices[].capture` 取得到。录好的整段由 `Composer.tsx` 上传（和附件同一套 `startUpload`、同一种进度条 `UploadChip`，失败可重试或放弃）、传完连同引用的卡片发出。语音模式下加号照常可用：选的附件传好就作为单独一条消息发出去（照微信），不用切回文字。气泡是 `ui/conversation/VoiceBubble.tsx`：宽度随时长变、点一下播放或暂停（`app/voice-playback.ts`，同一时间只播一条）、长按或右键弹出菜单。用户发的语音（`VoiceBubble`），识别出的文字默认直接显示在框里播放条下面（36 号票起和语音同框；就算用户对识别结果的确认），还没识别完显示"识别中…"，失败显示"识别失败"；菜单里有复制文字，失败的还有重新识别。agent 发的语音（32 号票）是 `AgentVoiceBubble`：菜单里"转文字"在框里展开送进 TTS 的原文、再点收起。要的东西由状态层的 `voiceBubble(state, part)` 给出（`state/voice.ts`，框里那一行是 `caption`，框的样子是 `voiceBubbleLook`）。每条语音的最新状态在 `UiState.voices`（按版本留最新的；往上翻取回的一页带着 `HistoryPage.voices`；彻底删除、重新同步时跟着拿掉）。连接多了 `retryVoice`。原型（`file://`）里发的语音由假连接推一遍假的识别。消息通用的菜单项（引用消息）现在还没有，气泡菜单里也就没有。

## agent 用语音回复（`voice/`，32 号票）

规格第 22 节、第 21 节"语音合成"。用户发的是语音，agent 这一轮的回复就由运行时合成语音（秘书和维护者的会话都一样），在 agent 一侧显示成和用户语音一样的气泡；长按"转文字"才展开送进 TTS 的原文。取舍见 ADR-0013。

- **是否用语音由运行时判定**（`voice-reply.ts`，不只靠提示词）：跟着会话频道上的回合走（`turn_start` / `message` / `turn_end`）。这一轮开始时交给 agent 的输入是用户的语音、而且有参考音色，就建出 agent 语音对象（`replying`，记下 `turn_start` 的序号 `turnSeq`）；一轮完成时看这一轮处理的用户消息（交给 agent 的那条输入和这一轮收下的插话）里最后一条，是语音就用语音回复（插话是语音、输入不是的，这时才建出）。31 号票里重新识别成功后交给 agent 的那条通知（`voice.ts` 导出的 `isVoiceRetryNotice`）也算用户的语音；别的运行时通知引起的一轮（任务执行中的阶段通知这类）不用语音。出错、中止、中断的一轮，最后一句不是语音的、没有要念的文字的，记成 `skipped`（带原因），文字照常显示。
- **会话和装配里多的东西**：口语总结工具 `spoken_summary({ text })`（只读或幂等、不落入任何关注类别）由各处的装配放进代为执行的工具——秘书的固定工具、任务维护者起草时的 `taskSetup`、执行时的 `executionSetup`（`maintainers/assembly.ts` 的 `conversationTools`，任务自己的维护者和项目维护者的执行工单段共用）、项目维护者起草和对话段的 `assemble`——所以 `MaintainerAssembly.hostTools`、守卫的工具包、固定上下文里"这一段能用的工具"都有它；子 agent 不加（它不和用户说话）。`AgentSession` 的 `voiceReplies` 选项（`SessionVoiceReplies`）只管两件：交给子进程的输入是用户的语音、而且有参考音色时，输入后面跟一条说明（和秘书的看板变化拼在同一条上下文消息里）；一轮完成之后的**追问**（`followUp`，见下）。
- **口语稿**（`spoken-text.ts`，纯函数，表格测试在 `test/voice/spoken-text.test.ts`）：回复的文字去掉 Markdown 标记（标题、加粗、列表、引用、行内代码的反引号、表情；链接留文字），代码块、表格、图片、光秃秃的链接地址念不出来，去掉并标出。念多快、多长算长是一个 `SpokenPace { maxSeconds, charsPerSecond }`（配置里的 `voice.reply`）：念出来要多久按字数估（每秒 `charsPerSecond` 个汉字，一个英文单词按两个汉字）。整段念得完（`maxSeconds` 内）又没有念不出来的 → `mode: "whole"`，整段合成；否则 `mode: "summary"`：agent 这一轮写了口语总结就用它（`summaryBy: "agent"`，太长的截到念得完）。
- **没写口语总结时先追问一次**（用户 2026-10-08 定）：记成 `summarizing`，`AgentSession` 在追加 `turn_end` 之后同一刻问 `voiceReplies.followUp(会话, 输入)`，拿到追问就在处理下一条输入之前交给子进程（`user_input`，话在 `texts.ts` 的 `summaryFollowUpText`）。这一次不算新回复：不记 `turn_start` / `turn_end`，流式增量和定稿消息都不进会话，不送插话（用户这时说的话留在队里）；工具照常代为执行、照常经守卫（调用记录照常进会话），用量照常记在那条输入名下（`usageAttribution` 不变）。追问结束（答完、出错、中止）、或者没法追问（子进程退出、任务暂停时不再追问）都调 `done()`：agent 补写了就用它（`summaryBy: "agent"`），还是没写由运行时兜底（`summaryBy: "runtime"`：回复开头念得完的几句加"详细内容我发在聊天里了。"——守护进程不调模型，所以是截不是概括）。万一没有会话来接追问，下一个事件循环就直接兜底。
- **合成**（`speech.ts`）：经本机 LSM 托管的 audio.cpp（drama 的 TTS 引擎，二狗不自己启动它，LSM 条目里对 `audiocpp` 是弱依赖）的 `POST /v1/audio/speech`，`{ model, input, voice_ref, reference_text }`（Fish 克隆两样必须同时给），回 WAV。一次一条（`shared.ts` 的 `createSerialQueue`，显卡和 drama 共用）。一次最多等 `voice.speech.timeout` 的余量 + 冷启动 + 估出的语音时长 × 每秒语音最多等几秒（服务第一次用到时才加载模型，所以冷启动总算上）。服务说忙（HTTP 503、`server_busy`）时不等、不重试（`SpeechServiceBusy`），原因记"语音服务忙"。实际的模型：合成成功后问一次 `GET /v1/models`，记成"<family>（audio.cpp/<模型 id>）"（比如 `fish_audio（audio.cpp/tts）`），问不到记配置里的 `audio.cpp/<模型 id>`。配置里的模型 id 还是示例的占位符时不发请求、报清楚。参考录音的路径里有非英文字符时不发请求、直接报原因（audio.cpp 读不了）。日志和报错里只写字数、参考音色的 id 和文件名，不写原文和完整路径。合成出的 WAV 写到临时区再入媒体库（按内容哈希，下载时按 `audio/wav` 在页面里直接播放），波形摘要 32 格（`wav.ts` 按峰值算）。
- **结局**：成功 → `agent_voice`（`done`）和一条 agent 的消息 `{ type: "tts_audio", voiceId, mediaId, mime, durationMs, waveform }` 同一事务（历史分页带上这一页的 `HistoryPage.agentVoices`）；合成之后不论哪一步出错都走同一个 `fail`：服务没开（`ECONNREFUSED`）、忙、出错（非 2xx，原因里带一小段正文）、超时、回的不是 WAV、存不进媒体库、参考音色被删了 → `agent_voice`（`failed`，带原因）和一条系统说明"语音没合成出来（原因），这次只发文字。"同一事务，这一轮只有文字。没有任何参考音色时不建语音对象、不合成、不写说明，待我处理里放一条 `voice_reference_missing`（`shared.ts` 的 `standingNotice`：开着的只有一条；动作"去导入参考音色"由前端带到设置里的语音页、不算处理），导入参考音色后自动归档。给模型和人看的话都在 `texts.ts`。
- **重启**：还在回复的（`replying`）记成 `skipped`（那条输入由会话标成中断，不重送）；在追问口语总结的（`summarizing`）直接由运行时兜底（追问的子进程已经没了）；合成只是一次 HTTP 调用、可以重做，不算 23 号票的"有副作用的调用"：还在"合成中"的接着重做一遍（不进"中断不确定"）。
- **参考音色**（`reference-voices.ts`，个人数据，文件就是真相、不进事件日志）：数据目录的 `voices/` 区（`DataDirLayout.voices`，随快照备份），每个音色一个以英文 id 命名的目录：`reference.wav`、`reference.txt`（UTF-8 逐字稿）、`voice.json`（`{ format: 1, id, name, audioFile, referenceTextFile, durationMs, sha256, importedAt }`，显示名只在这里）；现在用哪一个记在 `voices/current.json`（`{ format: 1, voiceId }`），没选过（或选的被删了）用最早导入的。导入只收 1–30 秒的 WAV（PCM 或 32 位浮点，`wav.ts` 读头），名字和逐字稿都要有；同样的录音和名字再导一次拿到同一个。先写进 `voices/.importing-*` 再改名，半截的不会被列出。不列出 audio.cpp 自带的音色库。HTTP 接口见上面"HTTP"（`/api/reference-voices`；试听和媒体共用 `http-api.ts` 的 `serveFile`，支持 Range）。
- **测试**：合成服务一律是假的（`test/helpers/tts.ts` 的 `startFakeSpeechService()`：空闲端口上的 `POST /v1/audio/speech` 和 `GET /v1/models`，记下每次请求和当时 `voice_ref` 指的文件内容，`behave("ok" | "hang" | "hold" | { status, body } | { wav })`、`release()`、`models(列表 | { status })`、`FAKE_SPEECH_BUSY`；回的 WAV 每 5 个字 1 秒；38 号票起一段一次请求，`script(...behaviors)` 给接下来几次请求各自怎么回、`held` / `releaseNext()` 一次放行一个 hold 住的）。`startTestDaemon({ speechUrl })`（`startDaemon` 同名选项，覆盖配置里的 `voice.speech.url`）；不给时是本机 1 号端口（连不上），不会打到本机 8090 上真的 audio.cpp。另有 `makeWav(秒, { sampleRate?, channels?, float? })`、`importReferenceVoice(url, 名字?, 逐字稿?)`（默认 `SAMPLE_VOICE`：编的示例音色，不用谁的真名字和声音）、`referenceVoicesApi`、`agentVoiceSettled(frontend, 状态, 第几条?)`、`agentVoiceVersions`。主切面在 `test/main/voice-reply.test.ts`；前端回放用的录制是 `voice-reply` 和 `voice-reply-segments`（38 号票），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/voice-reply.test.ts -t 演示流程`。
- **Web**（显示由用户 2026-10-08 定）：`tts_audio` part 渲染成 `AgentVoiceBubble`（菜单里"转文字"在框里展开原文、再点收起，"复制文字"；框的样子是 `agentVoiceBubbleLook`，见下面 36 号票）。状态层 `state/agent-voice.ts`：`UiState.agentVoices`（`agent_voice` 事件和历史分页的 `agentVoices`，和用户语音共用 `mergeVoices` 按版本留最新的；重新同步、删掉的项目跟着拿掉），`agentVoiceBubble(state, part)`，`replyCoverage(state, 会话)`（哪些消息的文字收进语音、不显示：还在回复的那一轮 `turnSeq` 之后 agent 的消息；整段合成、正在合成或合成好的语音对应的回复，协议包的 `agentVoiceCoversReply`），`agentVoicePhase(state, 会话)`（会话末尾一行：`replying` 时"正在回复…"，`summarizing` / `synthesizing` 时"正在合成语音…"）。`timelineItems` 按它们收起文字（只剩文字的整条不显示），还在回复时不显示正在生成的回复。所以这一轮不流式显示；短回复合成好只出语音气泡；长回复的文字和附件照常显示，合成好再加气泡；没合成出来、没用语音的文字照常显示。往上翻、重连补发同一套规则。设置里的语音页 `pages/more/VoicePage.tsx`（`#/more/voice`）：列出、导入（名字、WAV、逐字稿）、试听（参考录音，和语音气泡共用一个播放器，`app/page-voice.ts`）、选用、删除。待我处理里"去设置里修"的动作在 `InboxPage.tsx` 的 `SETTINGS_LINKS` 一张表里（关注类别设置、参考音色）。

## 语音气泡：自动播放、同框，界面上叫"个人助理"（36 号票，只改 Web）

规格第 22 节"气泡和自动播放"、第 19 节"名称"（用户 2026-10-08 真机试过后定）。

- **同框**：语音和它的文字在同一个气泡框里，播放条和时长在上、文字在下（`ui/conversation/VoiceBubble.tsx`，样式 `styles/voice.css`；下半截的颜色跟着框里的字色走，用户的蓝框和 agent 的框、浅色深色都看得清）。框的样子由状态层给：`voiceBubbleLook(bubble)`（用户的：下半截总有，识别出的文字或"识别中…"这类说法）、`agentVoiceBubbleLook(bubble, 展开没有)`（agent 的：默认没有下半截，展开了是送进 TTS 的原文；菜单里那一项 `textToggle` 是"转文字"或"收起文字"，没有原文时不能点）。宽度 `{ exact }`：没有下半截时随时长；`{ min }`：有下半截时随时长的宽度只是最小宽度，框按文字撑开。测试在 `test/state/voice.test.ts`、`agent-voice.test.ts` 的"气泡框的样子"。
- **新到的 agent 语音**：`ws-connection.ts` 把订阅之后补发的帧标成 `catchUp`（发订阅时紧跟着发一个空订阅当回执、不等订阅的响应，见上面"网关"的"补发推完了的回执"；多订阅频道时同样；断线后旧回执作废）。状态层只把**实时推来**、让一条 agent 语音变成 `done` 的帧记进 `UiState.agentVoiceArrivals`（同一条只记一次；往上翻取回的不经事件帧，不算；重新同步时清掉），选择器 `agentVoiceArrivals(state)`。界面决定过了送 `agent_voice_arrival_seen`（store 的 `seeAgentVoiceArrival`）。
- **该不该自动播**（`state/voice-autoplay.ts`，纯函数）：`agentVoiceAutoplay(state, voiceId, { enabled, foreground, openConversations, recording })` → `play` / `after_recording`（正按着"按住 说话"：松手后再问一次）/ `skip`（不是新到的、开关关着、页面在后台、没开着这个会话）。表格测试在 `test/state/voice-autoplay.test.ts`。页面上的那一半是 `app/voice-autoplay.ts` 的 `useAgentVoiceAutoplay()`（挂在 `App.tsx` 的 `Shell`）：每有新到的就按此刻的样子问一次（前台看 `document.visibilityState`，开着的会话由 `Conversation` 挂着时用 `useOpenConversation` 登记）。
- **播放器**（`app/voice-playback.ts` 的 `voicePlayerIn({ createAudio })`，页面上的那一个和 hook 在 `app/page-voice.ts`）：整个页面一个 `<audio>`，同一时间只播一条。点气泡播放或暂停，点另一条正在播的停下，用户自己点了气泡，排着的自动播放就不播了；自动播放没在播就马上播，**在播别的就排在后面、不打断**；按住说话时（`VoiceInput` 告诉它 `setCapturing`）在播的停下（不然会录进去，松手后也不接着放），排着的等松手；放不了的跳过。**手机浏览器的自动播放限制**：iOS 上同一个 `<audio>` 在用户手势里出过一次声，之后换地址、在手势之外播也放行，所以在"按住 说话"抬手时（手机上按下不算手势，也免得和按下就开录挤在一起）和点发送时调 `unlock()`，静音出一次声（一段内嵌的静音 WAV）；仍被拦下（`NotAllowedError`）就标成被拦下（排在后面的一起），气泡上提示"点一下播放"（不折行；这时随时长的宽度只当最小宽度），不报错，点一下就播。测试在 `test/app/voice-playback.test.ts`（假 `<audio>`）。
- **设置**：设置 · 语音"播放"里的"自动播放 agent 的语音"开关（`pages/more/AutoplaySwitch.tsx`；36 号票放在外观下面，45 号票按用户要求挪到语音这一栏，行为不变），默认开，按设备记住（localStorage 键 `ergou-voice-autoplay`，只在关掉时写 `off`，打开就擦掉；存储用不了按默认），改了立即生效。认记住的值是状态层的 `autoplaySettingOf`，读写在 `app/voice-autoplay-setting.ts`（`test/app/voice-autoplay-setting.test.ts`）。
- **开着的麦克风影响播放的两种兜底**（评审时加，待真机验证，**默认都不开**）：37 号票起语音模式里麦克风一直开着、回声消除开着，浏览器可能把播放切进通话模式（安卓走通话音量或听筒、蓝牙切到 SCO、iOS 录音时声音变小）。`app/voice-fallbacks.ts` 的 `VOICE_FALLBACKS`：(a) `releaseMicWhilePlaying`，有语音在播时先关麦克风、播完再预热（播放器的 `anyPlaying` 经 `VoiceInput` 交给 `VoiceSession.setPlayback`，`state/voice-mic.ts` 多了"在播"这一条；代价是播放期间按下要等"准备中"）；(b) `disableEchoCancellation`，要麦克风时关掉回声消除（`voice-recorder.ts` 的 `micConstraints`；代价是外放时可能把 agent 的声音录进去）。不开时就是 37 号票原样的"按下即录"。真机对比改这里的值重新构建；测试在 `voice-mic.test.ts`、`voice-session.test.ts` 的"兜底"。
- **名称**：界面上秘书叫"个人助理"——秘书聊天页的标题（`SecretaryPage.tsx`）和主导航的标签（`main-nav.tsx`）。43 号票起是用户起的名字，界面上处处用它，导航上一律两个字，见下面"个人助理的名字、两个字的导航"。

## 分段合成、边合成边推送、前端无缝播放（38 号票）

规格第 22 节"分段合成"。用户实测一段 309 字的口语总结合成出 56 秒的语音要等 51 秒；Fish-Audio S2 Pro 在 audio.cpp 上没有原生流式，所以由守护进程分段。

- **切段**（`spoken-text.ts` 的 `speechSegments`，规则和数字在 `SPEECH_SEGMENT_RULES`，表格测试在 `test/voice/spoken-text.test.ts`）：字数按估时长同一套（汉字一个算一个，英文单词、数字串一个算两个；每秒约念 4.5 个）。按句切（。！？!?；;…和换行，英文句点后面跟空白才算，句末的引号括号跟着前一句），一句一段；不到 **8 字**的句子并到下一句（最后一句并到前一句）；第一段最多 **16 字**（约 3.5 秒，第一声只等它），之后每段的上限是前一段的 **1.25 倍**（16、20、25、31、39），最多 **40 字**（约 9 秒）——合成只比实时快一点，后一段比前一段长太多就赶不上前一段播完；超过上限的句子按逗号切开（，、：和英文逗号，`1,000` 这样数字中间的不算；英文冒号只在后面跟空白时才算，`15:30`、`3:2`、`https://` 都不切）、小句凑到上限以内，切下来剩的不到 8 字就不切，一个小句本身超长的不再切。英文缩写（`Mr. Smith`）的句点后面跟空白，会被当成句末切开，暂不处理。
- **合成**（`voice-reply.ts`）：一段一次请求依次合成（还是一次一条语音）。不止一段的，每合成好一段存进临时区（`segment-files.ts`：`<临时区>/tts-segments/<语音 id>/<第几段>.wav`，不进媒体库——按内容哈希去重的媒体库里同样的一段可能正好是别的语音的完整音频），不是最后一段的追加一个新版本（`synthesizing`，`segmentCount`、`segments: [{ durationMs, offsetMs }]`、第一段时记 `firstSegmentMs` 和实际的模型），下一段才去合成。全部合成好拼成一条（`wav.ts` 的 `joinWavs`：44 字节标准头、格式和各段一样，段间 **200 毫秒**静音，接缝两边淡出淡入 `AGENT_VOICE_SEGMENT_FADE_MS`（协议包，5 毫秒，前端边收边播用同一个）；各段格式对不上算失败），入库、`done`（带全部的段）和语音消息同一事务，`elapsedMs` 是整条（拼好入库）的耗时。只有一段的不推段、没有 `segments`，`segmentCount: 1`、`firstSegmentMs` 等于 `elapsedMs`。
- **失败**：一段都没合成出来的和以前一样 `failed`。合成到一半（出错、超时、服务忙、回的不是 WAV、存不下这一段）：已经推出去的段拼成一条入库，`partial`（`error` 是原因、`segments` 是推出去的那几段）、语音消息、系统说明"语音只合成了前面一部分（原因），回复的文字照常显示。"同一事务；`agentVoiceCoversReply` 对 `partial` 不收文字，所以整段合成的短回复也把文字补出来。拼好的那条存不进去时退成 `failed`。
- **段的文件什么时候删**：一条语音有了结局（完整音频入库了，或者失败了）之后再留 **5 分钟**（`SEGMENT_KEEP_MS`，前端可能还在取最后一段）才删这一条的段，按守护进程的时钟（`clock.setTimer`，测试里用 `ManualClock` 拨）；停的时候没到点的不删，守护进程启动时全删。还在合成的（被杀了）重启后先追加一个去掉 `segments` / `segmentCount` / `firstSegmentMs` 的版本（推过的段收回），再从第一段重做。临时区 7 天一清也兜着底。彻底删除不涉及：agent 的语音消息本来就不在彻底删除的范围里（21、32 号票），段又不在媒体库里。
- **HTTP**：`GET /api/agent-voices/<id>/segments/<n>`（`HTTP_PATHS.agentVoiceSegment`），`Cache-Control: no-store`（重做时同一段的内容会变）。
- **Web 状态层**（`state/agent-voice.ts`）：`streamingAgentVoices(state, 会话)`（合成中、已经有段的），`streamingAgentVoiceBubble(voice)`（时长是最后一段的起点加它的时长），`agentVoiceAudible`。**一条 agent 语音此刻交给播放器什么**是纯函数 `agentVoicePlayback(voice, urls)`：`none`（还在回复、准备口语稿、合成中还没有段、推过的段被收回了、一段都没合成出来就失败了——播放器里在播的停掉放开、排着的拿掉）、`stream`（边收边播的段 `{ url, offsetMs, durationMs }`，`complete` 是不再是 `synthesizing`；合成好了还带完整音频的地址 `file`）、`file`（只有一段的）；从头播时播什么是 `playbackSource(playback)`（有完整音频播完整音频，不然边收边播）。`urls`（`AgentVoiceUrls`：拼段和媒体的地址）由页面给（`page-voice.ts` 的 `agentVoiceUrls(http)`）。表格测试在 `agent-voice-segments.test.ts` 的最后一组。`agentVoicePhase` 的"正在合成语音…"只算还没有段的；新到的（`agentVoiceArrivals`）改成"实时推来、让这条语音第一次有了能播的音频"（第一段到了；只有一段的是合成完成那一版）。回放测试 `test/state/agent-voice-segments.test.ts`（录制 `voice-reply-segments`：整段四段合成完成，再发一条第三段时服务忙；`voice-reply-segments-restart`：推了两段，守护进程重启收回，从第一段重做完成）。
- **Web 界面**：会话末尾显示合成中的气泡 `StreamingAgentVoiceBubble`（"合成中"，`VoiceBubbleView` 的 `note`），合成完了换成载着完整音频的消息。播放器里 agent 的语音按**语音 id** 认（边收边播和完整音频是同一条），用户的语音照旧按媒体 id。
- **播放器**（`app/voice-playback.ts`）：要播的（`VoiceSource`）是完整音频的地址，或者边收边播的段（状态层的 `SegmentStream`）。段用 Web Audio 按时间排程（`SegmentScheduler`，页面上的是 `page-voice.ts` 的 `webAudioScheduler`：fetch + `decodeAudioData`，每段一个 `AudioBufferSourceNode` 加 `AGENT_VOICE_SEGMENT_FADE_MS` 淡入淡出的增益）：按顺序排，每段排在"整条开始的时刻 + `offsetMs`"，所以和拼好的完整音频一样首尾相接；段来晚了（前一段已经播完）就到了马上播（50 毫秒余量），后面的跟着挪；取不到的段重试一次，还取不到就跳过、后面的段往前补（整条的开始往前挪这一段和它前面的停顿，不留一整段静音）；段到齐、都放完了才算播完，接着播排着的。`update(id, playback)` 收状态层算好的 `AgentVoicePlayback`：边收边播的接着排新到的段；排着没轮到的换成 `playbackSource`（合成好了就是完整音频）；`none`、或者段比手里的少（推过的段被收回了）——在播的停掉、放开这一条（接着播排着的），排着的拿掉；重做的第一段到了按新到的再自动播放。边收边播时点暂停、点别的语音、按住说话都停掉整条（再点从头播）。Web Audio 同样要手势开过：`unlock()` 时一并 `resume()`，自动播放时还没开过的标成被拦下（"点一下播放"）。`useAgentVoiceAutoplay` 只转发：每次状态变化先把每条 agent 语音的 `agentVoicePlayback` 交给 `update`（收回的先停掉放开），再把新到的按 `playbackSource` 交给 `autoplay`。36/37 号票的两个兜底开关（`voice-fallbacks.ts`）没动，`anyPlaying` 也算边收边播的。测试在 `test/app/voice-playback.test.ts` 的"分段合成的语音"（假的 Web Audio）。
- **真机看耗时**：`GET http://127.0.0.1:8810/api/conversations/secretary/messages` 返回的 `agentVoices[]`：`firstSegmentMs`（第一段出来用了多久，约等于第一声的等待，不含前端取段解码的几十毫秒）、`elapsedMs`（整条）、`durationMs`（语音总长）、`segmentCount`、`segments`；守护进程日志里每条语音合成完有一行"agent 语音 … 合成好了：N 段，语音 X 秒，第一段用了 Y 秒，整条用了 Z 秒"，每段一行"语音合成 → …：N 字"。

## 个人助理的名字、两个字的导航（`assistant/`，43 号票）

规格第 19 节"名称"和"导航按空间自适应"。用户给秘书起名字（默认"个人助理"），界面上说到它的地方都用这个名字，名字带专门的底色；秘书自己也知道叫什么。代码、领域术语（CONTEXT.md）、给 agent 的提示词照旧叫秘书、待我处理。

- **存和推**（照工作日历的个人设置，29 号票）：配置区的 `config/assistant-name.json`（`{ format: 1, name }`）是真相，只由运行时写；`assistant/assistant-name.ts` 的 `createAssistantNameService`（`daemon.assistantName`：`current()`、`change(raw, source)`、`onChange`）。改名走 `POST /api/assistant-name`（`{ name }` → `{ name, changed }`，`HTTP_PATHS.assistantName`），有变化先写文件、再在**名字频道** `assistant_name` 上追加一条 `assistant_name`（`{ name, source }`）；同样的名字再改没有变化、不推事件。启动时文件和上一条事件（没有事件就是默认名字）不一样就以文件为准补一条 `source: "config_file"`；文件读不了、名字不合规时不覆盖它，沿用上一次的名字，只记日志。
- **起名的规则**（协议包 `assistant-name.ts` 的 `checkAssistantName`，守护进程和设置页共用）：去掉首尾空白后 1–8 个字（按 Unicode 码点数，emoji 算一个），不能有换行（LF、CR、NEL、U+2028/2029）和控制字符，不能含名字占位的括号"⟦""⟧"。不合规守护进程回 400，设置页就地提示、不保存。"恢复默认"就是改回 `DEFAULT_ASSISTANT_NAME`。
- **秘书知道自己叫什么**：系统提示 `secretary/system-prompt.ts` 的 `secretarySystemPrompt(name)` 第二行写"用户叫你「名字」……运行时的消息和工具结果里说的"秘书"就是你"。改了名，秘书的 `AgentSession.refresh()`：手头这一条处理完就停掉子进程、按新的系统提示重新拉起（接着同一条主线会话），所以从下一轮起生效。pi 接着会话时系统提示变了，会在会话中途记一条系统消息（认中途系统消息的模型照原样收到、前缀缓存不打穿；不认的由 pi 把新的系统提示放回开头），faux 的 `echo_context` 把两条都列出来，生效的是最后一条（主切面 `test/main/assistant-name.test.ts`，也测了一轮进行中改名：这一轮照常做完、不中断，下一轮按新名字，消息不丢）。
- **守护进程写的话里的名字占位**：要给人看、又提到秘书的话，不写死名字，写协议包的 `ASSISTANT_NAME_MARK`（`⟦个人助理⟧`）——会话里的系统说明（`AgentSession` 的 `displayName`：秘书的"……这次没能回复"、"……没有接着处理"）、审批卡和待我处理事项的来源 `SECRETARY_SOURCE`（`⟦个人助理⟧对话`，快速动作的来源同）、提醒卡上"按你的话取消了"、节假日数据缺失事项的说明、协议包的 `PURGE_LIMITS`、消耗页的角色名 `LEDGER_ROLE_LABEL.secretary`。前端按现在的名字显示，所以改名后旧的也跟着变。
  - **交给 agent 的一律是"秘书"**：这些话也会转给 agent（待我处理的列表、引用的卡片、素材……）。往子进程送的每一行都经 `runtime/agent-process.ts` 的 `forAgent`，占位换成 `ASSISTANT_DOMAIN_TERM`（"秘书"），模型看不到占位（`test/agent-process.test.ts`）。报给 LSM 的忙碌原因同样换成"秘书"（`lsm/busy.ts`）。
  - 守卫退回的理由、工具结果这类**写给 agent 的话**照旧写"秘书"（聊天的工具调用记录里原样显示）；`guard/` 不引用协议包，不改。
  - **43 号票之前存下的旧话**：事件日志不可改，那时守护进程写的话里写死了"秘书""待我处理"。协议包 `assistant-name.ts` 的对照表 `LEGACY_WORDING`（`currentWording`）逐句列出那几句固定的旧话（来源"秘书对话"只在整个字段就是它时才认；"……这次没能回复："、"……处理时中断了，秘书没有接着处理；需要的话请重发。"、"秘书按你的话取消了"、"（秘书不能联网）。"、审批卡纯文本里的"审批（秘书对话）："、交给我做 / 中断事项说明开头的"秘书对话里……"、两句"待我处理"），前端显示守护进程写的话时先换成现在的说法（秘书换成名字占位，待我处理换成"待办"），效果和新的一样。不做全文替换：用户和 agent 的原话不经过这里，表外的话（比如引用里用户的原话）也不动。以后改了给人看的说法、旧数据里留着旧话的，往表里加一行（`test/assistant-name.test.ts` 的表格测试，Web 的 `test/state/assistant-name.test.ts` 回放旧数据）。
- **Web**：状态层 `state/assistant-name.ts` 的 `assistantNameOf(state)`（没收到过事件是默认名字；重新同步名字频道时清掉）、`daemonTextSegments` / `daemonTextPlain`（守护进程写的话：先按 `LEGACY_WORDING` 换掉旧话，再拆出名字 / 换成名字），前端一打开就订阅 `assistant_name` 频道（`App.tsx` 的 `REAL_CHANNELS`）。界面组件 `ui/assistant-name.tsx`：`<AssistantName />`（名字标签）、`<NamedText text>`（守护进程写的话：占位换成名字标签；会话里的系统说明、待我处理的标题 / 说明 / 来源、卡片的标题和处理结果、卡片的纯文本降级、引用条、页面内通知、短提示、任务页消耗表的角色名都经它）、`useNamedPlain()`（只能放纯文字的地方：`title`、`aria-label`、下拉选项、浏览器通知）。设置顶部 `pages/more/AssistantNameSetting.tsx`。改名 `DaemonHttp.setAssistantName`（原型里交给假连接推事件：`prototype/fake-http.ts` 的 `FakeAssistantName`）。
  - **名字标签**：`.assistant-name`，颜色是 token `--name-bg` / `--name-fg`（浅色、深色两个值，在风格清单里，每套风格可以覆盖，见"视觉风格"）；`test/visual-styles/contrast.test.ts` 的表格查每套风格下字和底的对比度不低于 4.5:1，`test/styles/name-tag.test.ts` 查底色和页面底色、卡片底色分得出来。
  - **输入框的占位**"和<名字>说…"：原生 placeholder 不能部分上色，叠一层假占位 `.composer-placeholder`（输入框空着时显示、不挡点击，读屏用 `aria-label`）。
- **导航**（`ui/main-nav.tsx` 定结构，所有风格都用它）：每一项 `button.tab` 里图标 `.tab-icon` 在上、名字 `.tab-label` 在下，竖栏和横栏一样。名字一律两个字：秘书那一项是两个字以内的名字，超过两个字写"助理"（状态层 `navAssistantLabel`），带名字标签，完整名字在 `title` 和 `aria-label` 里；待我处理在界面上叫"待办"（导航、页面标题、正文、提示）。待办的提示叠在图标右上角（`.tab-badges`：看过没处理的灰色数字 `.tab-count`，超过 99 写"99+"，`navBadgeCount`；有未读时一个小红点 `.tab-dot`），不另占横向的地方。宽屏竖栏按"图标 + 两个字"定宽 43px（原来 56px）：两个字（字号 `--fs-xs`，经典 11px）× 2 + 名字底色左右各 3px + tab 左右内边距各 3px + 竖栏左右内边距各 4px + 右边框 1px（`layout.css` 的 `.siderail`）。每项一行字，竖栏里一样高、横栏里一样宽；`test/state/nav.test.ts` 按新的项高（51）、项宽（56）重算。
- **扫描**：`test/build.test.ts` 查构建出来的页面里没有"秘书""待我处理"（也查 Unicode 转义的写法）；对照表 `LEGACY_WORDING` 里的旧话是唯一的例外（只用来认旧数据，不显示），先去掉再查。
## 语音模型预热、设置 · 语音（`voice/warmup.ts`，45 号票）

规格第 22 节"模型预热""设置 · 语音"。用户实测：二狗重启后第一条语音识别用了 36 秒（要先把 large-v3 加载进显卡），之后都不到 1 秒；合成那边 audio.cpp 是 `lazy_load`，第一次请求才加载、加载后不卸载。

- **两个预热依次做**（`createVoiceWarmup`，一次做一件的队列）：先识别、后合成，不同时往显卡里加载；都在后台，不挡启动；失败只记日志、在状态里显示，不影响别的功能。守护进程在停时不等还在加载的模型。
- **识别**：`Recognizer.load()` 拉起识别进程并加载模型（协议见上面"语音消息"的 `load`）。识别进程默认常驻（`idleMinutes` 默认 0）。要不要重拉看识别进程宿主经 `Recognizer.onLifecycle` 明确报的（`loaded`；`ended` 带 `cause`：`load_failed` 没加载起来、`exited` 加载好之后意外没了、`idle` 闲置退出），不从状态跳变倒推：加载好之后撑过 `RECOGNIZER_STABLE_MS`（60 秒）没崩才算稳定，稳定了才把连续失败清零；稳定之后意外没了（崩溃、被杀、识别超时被结束、识别时报致命错误）马上在后台重拉并加载；没加载起来、加载好了还没稳定就又没了（"加载好就崩"）都算连续失败，按 `RECOGNIZER_RETRY_MS`（5 秒、30 秒、2 分钟、之后每 10 分钟）再试，每次一行日志，两种分开写（"没加载起来"、"加载好后很快又退出了"）。测试里退避和稳定的时间用 `startDaemon` / `startTestDaemon` 的 `recognizerRetryMs`、`recognizerStableMs` 配小。配了闲置退出的闲置后是"已卸载"，不重拉。配置里的 Python 还是占位符时不预热，状态是出错。
- **合成**：先 `SpeechSynthesizer.health()`（`GET /health`，3 秒），开着就用实际会用的模型和当前参考音色发一条试合成（`WARMUP_TEXT`："你好。"），结果丢掉、不进会话、不留文件；用了不到 `ALREADY_LOADED_MS`（10 秒）算模型之前已经加载好，日志和状态（`alreadyLoaded`）里记下。没开记"没开"；还没有参考音色记"等待"，导入了再做；服务回"忙"（503，`SpeechServiceBusy`：显卡和 drama 共用，启动时常见）记"忙"（`busy`），按探活的间隔再试，状态一直是"忙"、只在开始忙时记一行日志。给人看的说明在 `texts.ts` 的 `SPEECH_WARMUP_TEXT`。之后每 `voice.speech.probeSeconds`（默认 60）看一次 `/health`，只在连不上 ↔ 连得上变了的时候动作：变成连得上再预热一次，变成连不上记"没开"。语音回复的合成成功了也把状态记成已就绪，连不上（`SpeechServiceOff`）记成没开。已知的空子：audio.cpp 在两次探活之间被重启（没被看到"连不上"）不会补预热，下一条语音回复照常冷启动。
- **和真请求撞上**：真请求排在同一个模型的预热后面（预热做的正是它要等的加载），不排在另一个模型的预热后面。识别：识别进程按到达顺序一条一条处理，"加载"在前；合成：`VoiceWarmup.speech` 包住语音回复用的合成，试合成在做时等它做完再发（同时发也只是在 audio.cpp 的模型锁上排队，还可能等过 `busy_timeout_ms` 被回 503）。
- **状态**：`VoiceWarmup.view()` 是 `VoiceModelsView`（识别引擎的清单 `["faster-whisper"]`、`recognizer`、`speech`、`startedAt`、`revision`）；变了推临时事件 `voice_models`（活动状态频道），本机接口 `GET /api/voice-models` 取得到同样的。真机看：`curl http://127.0.0.1:8810/api/voice-models`，看 `recognizer.status` / `model` / `device` / `loadMs` / `fallbackReason` 和 `speech.status` / `model` / `loadMs` / `alreadyLoaded` / `reason`。
- **设置 · 语音**（`pages/more/VoicePage.tsx`）分三块：识别（识别引擎的单选，清单由守护进程给，现在只有 faster-whisper、选中、选不了别的，旁边是识别模型的状态）、合成（audio.cpp 的状态、参考音色）、播放（"自动播放 agent 的语音"开关，从设置列表的外观下面挪过来）。状态的说法在状态层 `voiceModelSummary`，并进状态层的规则是 `newerVoiceModels`（`test/state/voice-models.test.ts`）。以后加识别引擎时再加切换和存储。
- **测试**：主切面 `test/main/voice-warmup.test.ts`（启动后两个都预热、不挡启动、结果不进会话；没有参考音色时等着；退回 CPU；加载失败过一会儿再试；稳定之后被杀马上重拉；加载好就崩、连崩几次按退避；服务忙稍后再试；守护进程停时不等；audio.cpp 后来才开时补一次预热；预热期间来真的识别、合成）。假的合成服务（`helpers/tts.ts`）把试合成单独记在 `warmups`、单独回（`behaveWarmup`、`heldWarmups`、`releaseWarmups`），不占 `script` / `behave`，别的测试不用管预热；`down()` / `up()` 在原来的端口上关了再开。守护进程一起来就预热，所以不经 `startTestDaemon` 起守护进程的测试也要避开真的东西：独立进程里的守护进程（`fixtures/daemon-host.ts`、`fixtures/killable-daemon.ts`）给假的识别进程和连不上的合成服务，像 LSM 那样拉起 `main.ts` 的（`entry.test.ts`、`restore-cli.test.ts`）在配置里写 `helpers/ports.ts` 的 `NO_VOICE_SERVICES_CONFIG`（占位的 Python、连不上的合成服务地址）。

## 麦克风让路、不发空白语音、麦克风诊断记录（61 号票，Web 和语音诊断）

规格第 22 节"麦克风预热"，照调研 `docs/research/16-voice-mic-hold-vs-instant.md` 的方案一做。用户 2026-10-09 反馈：语音模式里二狗一直占着麦克风，在"发起任务"这类地方用系统输入法的语音时提示"麦克风被占用"（安卓上 Chrome 在顶时输入法只录到静音；鸿蒙上华为浏览器走通话通路，先到先得，后来的输入法被拒；iOS 听写会打断网页的录音）。关掉回声消除不管用，办法是打字时真正放开麦克风。36 号票的两个兜底开关（`voice-fallbacks.ts`）照旧，默认都不开。

- **让路的规则**（`state/voice-mic.ts`，纯函数，表格测试在 `test/state/voice-mic.test.ts`）：
  - 页面里**可输入的元素拿到焦点**就立即停掉所有音轨、关掉音量分析。可输入的元素是 `isTextEntry`：textarea、文字类的 input（没写 type 的、text、search、email、url、tel、password、number……）、contenteditable；只读、禁用的不算；按钮（包括"按住 说话"）、勾选框、下拉框、日期时间选择不算。
  - **窗口失去系统焦点**（`document.hasFocus()` 为假，页面还看得见，比如分屏切到另一边）同样放开。
  - **焦点回来**（离开输入元素、窗口回来）之后等 `VOICE_MIC_RETURN_DELAY_MS`（500 毫秒，常量可调），这时仍在语音模式、页面在前台、焦点不在输入元素上、窗口有焦点，才重新预热：免得挤掉还在录的输入法（鸿蒙上后来的通话通路会把正在录的输入法停掉）。这 0.5 秒里焦点又进了输入元素就重新算（从最后一次离开算起），焦点在输入框之间跳不会开了又关；离开语音模式、切到后台就不开了。状态里是 `editing`、`focused`、`returning { until, reason }`，到点由 `VoiceSession` 送 `tick`（`voiceMicReturnAt` 给出那一刻，计时器是 `env.setTimer`）。
  - **按住说话的时候焦点怎么变都不打断**；抬手时焦点在输入元素上、或者窗口没焦点就放开。按下时焦点从输入框移到别处（手机上先到的是 pointerdown）、或者在等的 0.5 秒里按下：马上要麦克风（这一段等"准备中"），不再等。
  - 窗口回来算"回到前台"：自动打开失败歇着的再试一次；离开输入元素不算。
  - **从后台回来**：切到别的 App 时窗口也失去焦点，回来时 `visibilitychange` 和窗口的 `focus` 先后不定。页面在后台时不再跟踪窗口焦点（切到后台时当作焦点跟着回来），所以回到前台立刻预热、原因记 `visible`，不多等 0.5 秒；真的没拿回焦点，下一次看焦点时（最迟 1 秒）照样让路。
  - **规则只写在一处**：`voiceMicCloseReason(state)` 给出挡着的第一条（`VoiceMicCloseReason`），`voiceMicWanted` 就是"没有挡着的"；开麦原因 `voiceMicOpenReason(before, input)`（`VoiceMicOpenReason`）：本来就该开着却没有流的记 `stale`，不然看是哪个输入放行的。
  - **管不到的**：下拉通知栏、悬浮窗、系统助理浮层里用输入法，页面收不到任何信号，麦克风仍然开着（调研 16 第 6 节；"用完开着 60 秒就关"的方案二要用户取舍，不在本票）。
- **接到浏览器**（`app/voice-browser.ts`）：`document` 上的 `focusin` / `focusout`（冒泡，页面里任何元素都知道，包括对话框里的输入框）、`window` 的 `blur` / `focus`。拿着焦点的输入框被移走（对话框关了）时浏览器不一定发 `focusout`，所以语音模式里每秒再看一眼 `document.activeElement`（已经不在页面上的不算）和 `document.hasFocus()`。`VoiceSession`（`app/voice-session.ts`）只在值变了时喂给状态层。测试在 `test/app/voice-session.test.ts` 的"让路"（假的焦点、窗口焦点和计时器）。
- **不发空白语音**：
  - **按下时检查**：预热的音轨 `readyState` 不是 `live`、或者 `muted`（iOS 听写打断过、被优先级更高的应用拿走）就当作没预热：放掉旧的流、重新 `getUserMedia`，照旧"准备中"（`VoiceRecorder.warm` 看 `muted`，`stale` 是留着的流失效了）。
  - **录完时检查**：录着的时候每 0.1 秒读一次音量分析（`level()`），顺带记下这一段的最大振幅和读了几次——只算音量分析在跑（AudioContext 没挂起）时读的。读到 `VOICE_SILENT_MIN_READS`（5）次以上、整段最大振幅低于 `VOICE_SILENT_PEAK`（0.001，约 −60 dBFS）就是静音（`voiceTakeSilent`）：不发送、不上传，提示"没录到声音，再按一次试试"，并且放掉这个流、马上重新打开（它多半已经被系统静音了，比如安卓上被通话类应用压下去时 Chrome 收到的全是 0、页面也收不到 `mute`）。音量分析没在跑时（iOS 上可能一直挂着，读到的全是 0）判断不了，照常发送。阈值的依据：被系统静音的流是精确的 0；开着降噪、自动增益时，对着手机说话哪怕很小声，峰值也在 0.01 以上。真机上每条语音的 `peak` 可以用来校准。
- **诊断记录**：每条语音的 `capture`（协议包 `VoiceCapture`，守护进程整理后存进 `VoiceRecord.capture`，消息的 part 里不留）在 37 号票的 `startDelayMs`、`prewarmed` 之外多了：
  - `openReason`：录这一段的麦克风流是为什么打开的——`enter` 进语音模式、`visible` 回到前台、`edit-out` 离开输入元素 0.5 秒后、`focus` 窗口回来 0.5 秒后、`press` 按下（之前没开着）、`stale` 按下时预热的音轨已经失效（结束了或被静音了）、`silent` 上一段整段是静音之后重开、`playback-end` 兜底 (a) 播完；
  - `gumMs`：打开这个流时 `getUserMedia` 从调用到返回的毫秒数（冷启动耗时）；
  - `peak`：这一段量到的最大振幅（0–1，音量分析在跑时才有）；
  - `micLog`：最近 40 条（`VOICE_MIC_LOG_MAX`：一次完整的开关是 open、ready、close 三条，放得下最近 10 次以上，再给音轨事件留余量）麦克风开关和音轨事件，旧的在前，`atMs` 是相对这一段按下的毫秒数（负数是按下之前），每条带上那一刻的页面信号 `hasFocus`（`document.hasFocus()`）和 `visibility`（`document.visibilityState`），鸿蒙浏览器、原生壳里焦点或前后台报得不对时能查出来。事件：`open`（`reason` 同上面的开麦原因）、`ready`（`ms` 是 getUserMedia 的毫秒数）、`fail`（`reason` 是错误名，比如 `NotAllowedError`、`NotReadableError`）、`close`（`reason`：`leave` 离开语音模式、`hidden` 切到后台、`edit-in` 输入元素拿到焦点、`blur` 窗口失去焦点、`stale` 按下时放掉失效的流、`silent` 整段静音后放掉、`playback` 兜底 (a) 在播、`denied` / `failed` 要不到、`returning` 刚回来还在等时按下又抬手）、`mute` / `unmute` / `ended`（音轨被系统静音、恢复、收走）、`silent`（`ms` 是那一段的毫秒数；那一段没发出去，记录随下一条语音带上）。记录是页面上的一份（`app/voice-mic-log.ts` 的 `VoiceMicLog`，`voice-browser.ts` 里一个页面一个），离开、重新进语音模式接着记，只在内存里，刷新就没了；
  - `browser`：`navigator.userAgent`（看 Chrome 是不是 ≥153、ArkWeb 是 M132 还是 M144）。
- **鸿蒙 App 的原生录音**（63 号票）沿用这一套：`capture.backend` 是 `native`（浏览器录的是 `web`），另有 `prepareMs`（原生录音器备好用了多久）、`firstDataMs`（App 里开录到第一块数据），`micLog` 多了 `released`、`error` 两种事件；原生后端不让路（备好的录音器不占麦克风）。详见"鸿蒙 App"一节的"原生录音"。
- **在本机看诊断**：用户在手机上试完（"发起任务"里用输入法的语音、分屏、iPhone 上听写之后再按……），回来照常发一条语音，然后在 PC 上：
  - `GET http://127.0.0.1:8810/api/conversations/secretary/messages`（本机端口不用凭证；维护者的会话换成它的会话 id；`?limit=` 取更多条），响应里 `voices[]` 是这一页语音消息的语音对象，每条的 `capture` 就是上面这些；`messageId` 对应消息，`createdAt` 是发送时刻（`micLog` 的时刻相对按下，按下大约在 `createdAt` 前面"时长 + 上传"那么久）。
  - PowerShell 里：`(Invoke-RestMethod http://127.0.0.1:8810/api/conversations/secretary/messages).voices | ForEach-Object { $_.createdAt; $_.capture | ConvertTo-Json -Depth 5 }`。
  - 预期（调研 16 第 7.3 节）：打开"发起任务"用输入法语音时不再提示占用，记录里先有 `close edit-in`；关掉对话框 0.5 秒后有 `open edit-out`、`ready`；分屏时有 `close blur`；iPhone 上听写之前已经 `close edit-in`，之后按下 `prewarmed: true`；被别的应用占着时有 `mute` 或 `silent`。

## 快速动作与记忆命令（`quick-actions/`、`memory/`，21 号票）

规格第 7、9 节"快速动作的确认"、第 14、15 节。快速动作是一步就能做完、不需要别人干活的操作：秘书用"提议快速动作"工具（`propose_quick_action({ type, params, explicit? })`）提出，**是直接执行还是先问用户由运行时判定**，不拉起别的 agent、不上任务看板。

- **执行器注册表**（`quick-actions/registry.ts`）：每种动作一个执行器，`defineQuickAction({ type, title, usage, params, watch, confirm?, normalize, explicit?, proposalCard?, execute })`。
  - `params` 是这种动作自带的参数 schema（TypeBox，参照卡片动作的 `input`）：秘书给的 `params` 先按它校验（不合就回"参数不对：……"），再交给 `normalize(params)`（类型由 schema 推出），得到规范化后的动作 `{ params, title, target?, content? }`（存进卡片和操作记录的参数、一句话的标题、展示用的对象和内容）。工具说明里自动列出登记了的动作和各自的参数（`tool.ts` 的 `paramsHint`）。
  - `watch` 的形状同工具注册表的登记：`{ categories, bottomLines?, notifyWhenDone?, args?, outbound? }`（`args` 是规范化后参数里哪些是收件人、金额、路径……，自定义类别按它们匹配）。
  - `execute(params, context)` 返回要和卡片、操作记录同一事务追加的事件、结果说明，彻底删除还给出要改写的事件 `purge`。
  - 29 号票加了 `workday_calendar`（"改工作日历"，`workday/quick-action.ts`，一律先确认），见下面"个人工作日历"。
  - **27 号票的 MCP 调用照这个加**：只加一个 `defineQuickAction` 的登记，在 `daemon.ts` 里 `quickActionRegistry.register(...)`（测试用 `startTestDaemon({ quickActions })` 加替身，`test/helpers/quick-action-fixtures.ts`）。
  - 22 号票加了任务控制 `pause_task` / `resume_task` / `cancel_task`（`tasks/task-control.ts`），见下面"秘书的看板感知、压缩与任务控制"。执行器的结果可以带 `afterCommit`（事件连同卡片、操作记录落盘之后叫一次）；`normalize` 抛的 `RequestRejected`（执行器明说不让做，比如任务现在不能暂停）原样回给秘书（"不能这样做：……"），别的错误才是"参数不对"。
- **"明确点了"**（`explicit.ts`）：每个执行器用 `explicit(action, turn)` 自己声明，不写就永远算推断；`turn` 是用户这一轮的话（`UserTurn { typed, quotes, cards }`：自己打的字、引用块里的、引用的卡片上的文字）。共用的辅助函数：`foundIn(turn, text)`（规范化后原样出现在哪一部分，给出 `ExplicitFinding { source: "typed" | "quote" | "card" }`）、`commandTails(turn, triggers, negations)`（触发词后面到句末的那一段，触发词前面同一分句里有否定词的不算）、`bareText`（NFKC、去掉空白和标点后比较）、`NEGATIONS`（别、不要、不用、不必、无需、甭）。秘书在参数里自称"用户点明了"不作数（只记日志）。`confirm: "always"` 的执行器（忘掉、彻底删除、别推断）不论点没点明都要核对。
  - **记住**（`memory/memory-commands.ts` 的 `rememberExplicit`）：用户的话里有触发词（记住、记下来、记下、记一下），前面没有否定词（"别记住……"不算），并且提议的内容和触发词后面到句末的那一段一致（去掉标点和空白）；那一段只是指代（"这个""这条"……）时，内容要和引用块或引用的卡片上的一段一致。否则按推断处理，出确认卡。
- **处置**（`quick-actions/judge.ts` 的 `judgeQuickAction`）：动作作为一个伪工具调用（`quick_action:<动作类型>`，参数是规范化后的参数，`watch` 是它的登记）交给守卫的 `judgeToolCall`，所以**用户的自定义关注类别也管快速动作**（按工具名 `quick_action:<类型>`、收件人、金额、路径匹配）。硬拒绝 → 不出卡；点明了 → 只看底线（付款、改密码……仍然交给我做或永不）；推断 → 内置类别和自定义类别在对话里的处置、底线、`notifyWhenDone` 取最严，"计划里列了才做"在对话里等同先问，按规则退回的至少先问；`confirm: "ask_when_inferred"` 的（记住）推断时至少先问。会执行 → 快速动作卡出来就是"已执行"（`status: handled`，带结果），和执行器的事件、操作记录同一事务；先问 → 卡片待处理，同时放进待我处理（来源"秘书对话"，不卡任务），用户点"执行"才做、点"取消"关掉；交给我做、永不 → 不出卡，告诉秘书原因。**操作记录**就是会话频道上的 `quick_action_executed`。卡片的负载 `QuickActionCardPayload` 里带动作的中文名 `name`，处置是前端协议的写法（`do` / `ask_first`……）。
- **记忆命令**（`memory/memory-commands.ts`）：`remember`（参数 `{ content }`；执行时追加 `memory_command`，素材模块产生"显式记忆命令"素材，来源按点明在哪里：自己打的字 → 本人、打字；只在引用块里 → 外部不可信；只在引用的卡片上 → 用户的选择、注明 agent 先提出；推断出来、用户在卡上确认的 → 注明 agent 先提出）；`forget` / `purge` / `no_infer`（参数 `{ materialIds }`，秘书先用 `search_materials` 检索，把素材 id 放进去，最多 `MAX_MEMORY_DELETE_MATERIALS`（50）条；总是出**记忆删除卡** `memory_delete`，负载 `MemoryDeleteCardPayload` 列出匹配的素材：种类、时间、会话、摘录。用户在卡上可以去掉几条、换一种删法，动作 `delete` 的输入是 `MemoryDeleteInput { mode, materialIds }`，素材 id 必须在卡上）。三种删法的说明（卡上、设置页上同一份）是协议包的 `MEMORY_DELETE_MODE_INFO`，彻底删除的说明带上删不掉的（`PURGE_LIMITS`：秘书回复里转述过的话，和秘书看任务看板时看到过的等我原因——看板变化消息、查看板的结果里带着任务等我的说明，23 号票的"中断：不确定 X 是否已执行"会带上调用摘要；备份快照里的一份，随快照轮换消失，本机约 7 天，同步目录最长约 5 周）：
  - **忘掉**：追加 `memory_command`（先记事件，否则重建会让素材回来，ADR-0006），素材模块删素材、索引和原文副本；聊天历史里原话还在；
  - **别推断**：素材和索引保留，标"不参与推断"（`Material.noInfer`，检索结果里注明）；
  - **彻底删除**（`memory/purge.ts` 的 `purgePlan`，取舍见 ADR-0008）：忘掉之外，改写事件日志里带原话的事件。**只有消息事件整条换成"已删除"标记**；别的事件按事件类型**字段级改写**：只把带原话的文本字段换成 `PURGED_TEXT`（"（这条内容已彻底删除）"），id、状态、决定原样保留，所以派生视图重放后审批表仍是已批准或已拒绝、卡片仍是已处理、效果日志条数不变。改写函数按事件类型登记成一张表（`memory/rewriters.ts` 的 `PurgeRewriters`，在 `daemon.ts` 里登记，形状 `PurgeRewriter { eventType, rewrite(event, context) }`，辅助函数在 `events/purge.ts`）：消息（`conversation/purge.ts`：只有工具调用记录的消息换掉参数摘要和结果摘要，别的整条换成标记）、卡片（`cards.ts` 的 `cardPurge`：负载交给卡片类型登记的 `purge`，处理结果里用户写的说明换掉）、卡片被关闭和长期没处理（`materials/sources.ts`）、"记住"的命令（`materials/commands.ts`）、审批决定（`approvals/material-source.ts`）、效果日志（`guard-runtime/effect-log.ts`）、操作记录（`quick-actions.ts`）、时间线记录（`conversation/purge.ts` 的 `timelineRecordPurge`：摘要和说明）、范围记录（`scope-review/purge.ts` 的 `scopeRecordPurge`，18 号票）。**没登记改写函数的事件类型被点到时整个彻底删除被拒**。改写函数还可以声明连带改写的事件（`related`）和改写后追加的新版本（`newVersion`：改写不通知订阅者，开着的页面、投影出来的文件靠它更新——范围记录就是这样）；别的模块的事件里引着某类事件的原话时，由引用方登记"引用"（`PurgeRewriters.registerQuotes(PurgeQuotes { eventType, quotedIn })`）：改写被引用的事件时连带改写引用它的（范围记录引着维护者会话里的消息、审批卡上的批准，见下面"范围审视"）。改写的范围：素材的原始事件；"记住"来的素材连同它的记忆命令、操作记录、快速动作卡的每个版本、提议它的那次工具调用的记录（按卡上记的 `toolCallId` 找）和紧跟着的效果日志；素材卡片上用户写的说明；审批决定那次工具调用的记录（按审批请求里的工具调用 id 找，会话文件里那次调用的结果也改）、挂起之后才拒绝时递给 agent 的那条通知（按幂等键 `approvalDeniedNoticeKey` 找）；检索素材那次调用的记录（按素材 id 找）和紧跟着的效果日志、提到素材 id 的效果日志；列出过这些素材的卡片。会话里被改写的消息另在会话频道追加 `messages_purged`（整条删掉的只给消息 id；字段级改写的给出改写后的样子 `replacement`；还有要改写会话文件的工具调用 id `toolCallIds`、被删消息引用过的附件 `mediaIds`）；改写过的卡片追加一个改写后的新版本（记忆删除卡自己的新版本摘录清空、标 `purged`），声明了 `newVersion` 的同样追加。删不掉的如实写在协议包的 `PURGE_LIMITS`（设置页、记忆删除卡上都写）：秘书回复里转述过的话、秘书看任务看板时看到过的等我原因、交给项目维护者的工单内容里转述的话（16 号票的工单内容：打回计划的意见原样转进去，而计划卡上的决定还删不了；17 号票起维护者派工单时写的），和备份快照里的一份。删除类的记忆命令事件本身不改写（里面只有素材 id，它是"这些被删了"的记录）。聊天里的卡片动作和设置里的批量删除共用 `memory/deletion.ts` 的 `deletionEvents`（记事件 + 算改写）。
  - **附件**（`memory/after-purge.ts` 的 `startPurgedMediaCleanup`）：`messages_purged` 里的 `mediaIds`，没有别的（未删的）消息、也没有素材还引用同一个哈希的，删掉媒体文件（`MediaStore.remove`，连同派生文件），按媒体 id 下载回 404；启动时把以前的 `messages_purged` 再对一遍。
  - **SQLite 不留残余**：`ergou.db`、`memory.db` 的写连接开 `secure_delete`（`storage/sqlite.ts` 的 `openDatabase`），彻底删除后各做一次 `wal_checkpoint(TRUNCATE)`。
- **会话文件的改写**（ADR-0008，和 ADR-0004 的关系见那里）：每条交给子进程的输入在 pi 会话文件里前面有一条 `ergou-input` 自定义条目（`SESSION_INPUT_TAG`，记输入 id 即消息 id）。改写逻辑在 `runtime/agent-child/session-rewrite.ts`（用 pi 的类型），由一次性子进程 `agent-child/rewrite-main.ts` 执行（stdin 收 `SessionRewriteRequest`，stdout 回 `SessionRewriteResult { files, entries, summaries }`）；守护进程经 `runtime/session-rewrite.ts` 的 `runSessionRewrite` 拉起它，agent 管家的 `rewriteSessions(agentId, request)` 是上层的入口（agent 子进程还活着时拒绝）。改写范围：按输入标记找到的用户消息、按工具调用 id 找到的工具调用参数（参数里的字符串）和工具结果、素材检索结果里提到被删素材的行（"- <素材 id> · （这条内容已彻底删除）"）、`customTypes` 列出的自定义条目（范围审视结果的副本 `SCOPE_REVIEW_ENTRY`，数据里的文字全换掉，18 号票）；被改的条目在某次压缩保留的第一条之前时，那段压缩摘要整段换成 `PURGED_SUMMARY_TEXT`，在被改条目之后的分支摘要也一样。改写保留修改时间（pi 按它挑最近的会话），是幂等的。**改写哪些由记忆模块从 `messages_purged` 生成**（`after-purge.ts` 的 `sessionRewriteFor`，交给秘书和维护者的 `sessionRewriteFor` 选项）；停、改、拉起由 `AgentSession`（`conversation/agent-session.ts`，见下面"agent 会话"）做：等手头这一条处理完，停掉子进程、改写、接着同一个会话拉起（和崩溃重启共用 `relaunch`）；会话 `start()` 时（秘书在守护进程启动时，维护者在它的会话第一次建好时）把以前的 `messages_purged` 先对一遍再拉起。**不改写的**：秘书自己的回复和检索时写的查询词、审批请求里 agent 要做的那次调用的参数摘要、本票之前的会话文件里没有输入标记的消息。
- **秘书的素材检索工具**（`memory/search-tool.ts`，`search_materials({ query, limit? })`）：关键词（`searchKeyword`）加语义（`searchSemantic`，分数 0.5 以上算匹配，模型不在时只按关键词并说明）两路合并，每行是素材 id、时间、种类、会话、是否不参与推断、怎么命中的和摘录；秘书正在处理的那条消息（就是用户的命令本身）不列出。只读，不落入任何类别。
- **代为执行的工具知道正在处理哪条输入**：`HostToolCall` 多了 `inputMessageId`，由拉起 agent 的模块经 `serveHostTools(..., { context })` 补上（秘书给的是正在处理的那条输入）。
- **设置里按会话、按时间段删除**（`memory/bulk.ts`，HTTP 接口见上面"网关"，`createHttpApi` 的选项 `materialDeletion: BulkMaterialDeletion`）：范围是 `MaterialScope`（`{ kind: "conversation", conversation }` 或 `{ kind: "time_range", from, to }`，两头都算，按素材的时间），三种删法同上；每次是一条 `memory_command`（`from: { kind: "settings", scope }`），带幂等键，重发只执行一次；时间不对回 `bad_request`。范围里没有素材时什么都不追加。
- **加一种快速动作的样子**：

```ts
export const pauseTaskAction = defineQuickAction({
  type: "pause_task", title: "暂停任务", usage: "暂停一个任务",
  params: Type.Object({ task: Type.String({ minLength: 1, description: "任务名" }) }, { additionalProperties: false }),
  watch: { categories: [] },                       // 形状同工具登记：类别、底线、参数规则……按伪工具 quick_action:pause_task 判处置
  confirm: "ask_when_inferred",                    // 推断出来的一律先问
  normalize: ({ task }) => ({ params: { taskId: find(task) }, title: `暂停任务：${task}`, target: task }),
  explicit: (action, turn) => foundIn(turn, action.target ?? ""),   // 任务名原样出现在用户的话里才算点明
  execute: (params, ctx) => ({ events: [/* 同一事务追加 */], summary: "任务已暂停" }),
});
// daemon.ts：quickActionRegistry.register(pauseTaskAction)
```

## 备份、校验与恢复（`backup/`、`scheduler/internal-jobs.ts`，11 号票）

**内部作业**（`scheduler/internal-jobs.ts`，规格第 13 节）：守护进程自己按时间表做的事，挂在调度器上。`createInternalJobs({ store, scheduler, clock, log })` 在 `daemon.ts` 里建一次（`daemon.internalJobs`），各模块 `register({ name, schedule, run })`：

- `schedule` 是和简单提醒同一种时间表（共享协议包 `reminder-schedule.ts` 的 `ReminderSchedule`，比如 `{ kind: "daily", time: "03:30" }`、`{ kind: "weekly", time: "04:30", weekdays: [0] }`），下一次用 `nextOccurrence` 算：时间规则只在那一个模块里。
- `run(trigger, signal)` 是异步的，`trigger` 是 `scheduled`（到点）或 `catch_up`（启动时补）；`signal` 是 Node 自带的 `AbortSignal`，守护进程停止时置位，作业要尽快停下（`signal.throwIfAborted()`，抛 `AbortError`）。
- 每个作业上一次开始跑的时间记在事件日志的内部频道 `internal` 上（`internal_job` 事件，派生视图 `internal_jobs`）。启动时看"上一次之后的下一次"过没过点：过了就马上补跑一次，没过就登记到那个时刻。停机期间错过好几次也只补一次（跑完之后的下一次从跑完那一刻往后算）；补完再重启不会再补。第一次见到一个作业只记下"从现在起算"，不马上跑。
- **"过没过点"是纯函数 `nextDue(schedule, 上一次, 现在)`**，给出 `{ at, missed }`（一次性的过了点是 `undefined`）。19 号票的定时作业"只补跑一次"直接调用它，状态存在它们自己的看板事件里。
- 跑完（成功、失败都算跑过；失败由作业自己报告）才记一次、登记下一次。因为守护进程停止被中止的不算跑过，下次启动照常补。
- `daemon.internalJobs.whenIdle()` 等正在跑的作业做完；`state(name)` 看它的状态。归档清单（19）、回避信号计时（08）、授权到期提醒（14）照这个登记。
- 时间表可以是"按我的工作日"（29 号票）：`createInternalJobs({ scheduleContext })` 给当前的工作日历（必填），`nextDue(schedule, last, now, context)` 按它算；工作日历变了 `rearm()` 把跟着它变（`dependsOnWorkdayCalendar`）、没在跑的作业按新的工作日历重新登记。29 号票自己登记了 `holiday_data_check`（见下面"个人工作日历"）。

**备份**（`backup/backup.ts`，规格第 18 节）在内部作业里登记三件事，排在一条队列里依次做：

| 作业 | 时间 | 做什么 |
|---|---|---|
| `backup` | 每晚，配置 `backup.time`（默认 03:30） | 在本机备份区（数据目录的 `backups/`）做当天的快照，再复制到同步目录（配置 `backup.syncDir`）；写进去就算成功，不等也不查同步客户端。本机留最近 7 份；同步目录留最近 7 份，加上比它们更早的最近 4 个周日（`retention.ts`），清完回收公共池里没人用的文件。周日那份当时没写进同步目录的（目录不在等），之后写得进去时从本机补写最近缺的那个周日 |
| `verify_snapshot` | 每周日 04:30 | 本机备份区和同步目录里最新的快照：数据库做完整性检查，其余文件（含公共池里的）核对大小 |
| `clean_tmp` | 每天 04:00 | 删临时区（含秘书草稿区、7 天没动的分片上传 `tmp/uploads/`）里修改时间在 7 天前的文件；删完变空、本身也 7 天没动的子目录一并删，临时区下第一层的目录留着；符号链接不动 |

- **快照的样子分两层**（`snapshot.ts`，ADR-0007）。都是 `<备份区>/<YYYY-MM-DD>/manifest.json` + `data/`，按清单还原；数据库区里的 `*.db`（`ergou.db`，有了就还有 `memory.db`）用 `VACUUM INTO` 生成；`.jsonl` 只复制到最后一个换行（pi 会话最后半行正在写）；不进备份的是 `config/data-dir.ts` 的 `nonBackupEntries`（密钥区、临时区、本机备份区、pid 文件、模型区），外加 `*.db-wal` / `-shm`；符号链接和目录联接不跟进（外部工作目录因此进不来）；先写进 `.<日期>.partial`，最后改名。
  - **本机备份区**：`data/` 是完整镜像。大小和修改时间都没变的文件硬链接到上一份，变了的复制，复制完内容（sha256）和已有的较大文件（≥ 64 KB）一样的换成硬链接；做不了硬链接时整份复制并记一条日志。**快照文件都设成只读**：一份存储可能属于好几天的快照，不能就地改写（要人为改坏它来测试，先去掉只读）。
  - **同步目录**：同步客户端不认硬链接，所以不用硬链接。较大的文件（≥ 64 KB，含数据库、媒体）按内容放进公共池 `pool/<sha256>`，池里有了就不再复制；日期目录里只有清单和小文件。清单里 `pooled: true` 的条目内容在池里（`contentPath` 给出实际位置）。
- **当天已经有快照**：到点和补做的只补齐缺的（本机没有就做，同步目录没有就复制），不覆盖已有的；`daemon.backup.backupNow()`（"立即备份"）重做当天的、换掉已有的。
- **出错**：本机快照没做成（`备份失败：本机快照没做成`）、没写进同步目录（同步目录不在、还是示例里的占位符、空间不够、复制出错：`备份失败：没写进同步目录`，本机快照照样留着）、周日那份补写不进去，各在待我处理里放一条 `backup_failed`（不卡任务，动作"重试""知道了"）；校验没通过放一条 `snapshot_check_failed`。"重试"用待我处理的 `inbox.onNoticeHandled("backup_failed", "重试", fn)` 接上：用户第一次选这个动作时马上 `backupNow()` 一次。同步目录能不能用只有一处判断（`sync-dir.ts` 的 `syncDirOf`），备份、校验、恢复说法一致。
- **往备份区写文件**都经过 `files.ts` 的 `SnapshotFiles`（复制前若干字节并算 sha256、硬链接、设只读、建目录、写清单、改名、删除）。测试用 `startDaemon({ backupFiles })` 换成会出错的实现。改名带重试的是 `renameWithRetry`（恢复命令也用它）。
- **恢复**（`backup/restore.ts`，命令行入口 `src/restore.ts`）：`restoreSnapshot({ config, layout, date, from? })`。pid 文件里的进程还在运行（`process/pid-file.ts` 的 `processRunning`：进程没退出、启动时间也对得上），或者本机端口上有进程在听，就拒绝（`RestoreRefused`）。快照默认先找本机备份区，再找同步目录（`from: "local" | "sync" | { dir }`）；先校验，不通过拒绝。数据目录里现在进备份的那些内容先挪到 `backups/pre-restore-<时间>/`（同一个盘上只是改名），再按清单把快照里的文件复制进来（同步目录的从公共池取；复制出来的去掉只读，源文件本来就只读的——清单里记着 `readOnly`，比如素材区的原文副本——照样只读）；`nonBackupEntries` 那几项不动（模型区也在里面：几百 MB，能重新下载）。中途出错就撤回。**`pre-restore-*` 只留最近 2 份**，更早的在恢复时删掉。恢复后前端带来的序号比服务端大，订阅时这些频道重新同步（见上面"网关的本机端口"）。

## 秘书的工具（守护进程代为执行）

秘书的五种回复形态里，除了直接回答，其余四种各是一个只产生卡片的工具（规格第 7 节）；还有读取附件、把文件作为附件发出（09）。这类工具的逻辑和要改的状态都在守护进程里，子进程只转手（ADR-0004 的边界），06 和 09 号票合成了一套：

- 宿主协议（`HOST_PROTOCOL_VERSION` 9。3 在装配参数里加了必填的 `shellEnv`，07 号票；4 是 13 号票：装配参数可选的 `contextBlock`（每条输入之前——被唤起：刚拉起，或者闲着时来了新输入；插话不算——作为一条上下文消息注入，`CONTEXT_BLOCK_TYPE`），命令 `context_block { text }`（换成最新的，下一条输入之前、压缩之后注入它）、`compact`（手动压缩；守护进程现在不发，契约测试用它验证"压缩之后重注入"，24 号票按上下文用量压缩时用），`interject` 收下的在 `turn_end.interjected` 里报出、没收下的回 `error { code: "bad_command", inputId }`；工具执行到一半被中止的回合报 `aborted`；5 是 22 号票：`user_input.context`（跟在这条用户消息后面的一条上下文消息，`INPUT_CONTEXT_TYPE`，模型看到它紧跟在用户消息之后，系统提示不动；秘书的看板变化）、装配参数可选的 `compactionInstructions`（自动压缩——到了阈值、上下文溢出——和手动压缩写摘要都按它写；秘书专用的压缩指令）；6 是 24 号票：`usage` 多了可选的用途 `purpose`（`compaction`：压缩会话生成摘要的那次模型调用，子进程在压缩结束时报，`messageId` 是 `compaction-<n>`；`scope_review` 预留给 18 号票的范围审视），faux 剧本的一步可以给定用量 `usage`，目录模型可选的请求地址 `CatalogModelSpec.baseUrl`（只给契约测试：把真实 provider 的请求发到本机回放录好的响应）；7 是 23 号票：装配参数可选的 `interruptedToolResults`（工具调用 id → `{ text, isError }`），接着会话时给最后一个回合里没有结果的工具调用补结果，见下面"被杀后的恢复"；8 是 16 号票：装配参数可选的 `session`（会话的名字：会话目录里有这个名字的会话就打开它接着，没有时选了 `continueSession` 就接着目录里最近的那个，否则用这个名字新开；agent 管家只认字母、数字、`-`、`_`、`.`），`ready` 报回这次打开的会话的名字 `session`——会话文件长什么样、叫什么只有子进程认（ADR-0004），守护进程只说名字；项目维护者每段会话一个、接哪个由当前这一段明确指定；9 是 18 号票：装配参数可选的 `scopeReview { model, instructions, reference, recentRecords? }`（范围审视用的模型、审视的说明——审视那次调用的系统提示，守护进程写好交来——、对照物、近期范围记录，维护者才有），命令 `scope_context { reference, recentRecords? }`（换成最新的）和 `scope_review { requestId, reference }`（审视会话里还没审视过的部分，结果以同一 `requestId` 的 `scope_review_result` 报回；审视做完之前排在后面的命令——含闲置退出的 `exit`——等它），报告 `scope_review_result { requestId?, findings: [{ kind, summary, detail?, basis? }], inputIds, error? }`（守护进程要的带 `requestId`，压缩时子进程自己做的没有；`inputIds` 是这个会话里交给它的输入；没做成的写 `error`，守护进程这一侧的没做成也用同一个 `failedScopeReview`），`usage.purpose: "scope_review"`（`messageId` 是 `scope-review-<n>`，provider、模型是审视用的那个），审视的结果另 appendEntry 进会话（`SCOPE_REVIEW_ENTRY`，只是副本），改写会话文件的请求多了 `customTypes`（这些自定义条目的数据里的文字全换掉：范围审视结果的副本），faux 剧本的一步 `reply_with_context { text }`（回复里的 `{{context}}` 换成这次调用看到的上下文，按 JSON 字符串转义：核对审视的输入用），见下面"范围审视"）：会话装配参数 `hostTools: HostToolSpec[]`（名字、说明、参数的 JSON Schema）；子进程把它们登记成 pi 的自定义工具（`runtime/agent-child/host-tools.ts` 的 `HostToolBridge`；不受工具白名单限制，一次一个、按模型给出的顺序执行），模型调用时发 `host_tool_call { requestId, toolCallId, toolName, args }`（`args` 是 `JsonValue`），等守护进程回 `host_tool_result { requestId, result: { text, isError } }`（`isError` 必填）。pi 先按 JSON Schema 校验参数，不合就不转；等结果时回合被中止，这次调用按出错结束。打开守卫转发时，这些调用和别的工具一样先经 `tool_call` 钩子判定。契约测试在 `test/contract/host-tools.contract.test.ts`（只有这一个文件）。
- 守护进程这边（`agent-manager/host-tools.ts`）：`defineHostTool({ name, title, description, parameters, categories?, bottomLines?, args?, readOnlyOrIdempotent, run })` 定义一个工具（参数用协议包的 `Type` 写，序列化成 JSON Schema 交给子进程，守护进程再按同一个 schema 校验一次）。`title`（中文名）和后面几项是它在守卫工具注册表里的登记（`HostTool.descriptor`，来源 `host`）：类别标签、底线标签、要守卫检查的参数规则（路径、收件人……，不写的参数守卫不看）、"只读或幂等"（必填，重做一次没有额外效果才写 true，拿不准的从严写 false；被杀后的恢复据此分两种，见下面"被杀后的恢复"）、"由执行控制器负责恢复"（可选的 `recoveredByController`：被打断后控制器自己处理，不转给用户确认，比如"宣布阶段完成"）；只产生卡片的工具什么类别都不写；`run(args, { toolCallId, inputMessageId?, signal? })` 返回 `{ text, isError?, cardIds? }`（可以是 Promise），抛错等同于出错（错误记日志，模型只看到"没做成"）。`signal`（28 号票）在子进程那边已经结束了这次调用（这一轮被中止、管家按超时中止）或 agent 退出时中止，跑得久的工具据此结束它起的进程。`serveHostTools(agent, tools, { log, onCards, context? })` 接上一个子进程：按名字找工具、执行、回结果；有 `cardIds` 时先调 `onCards`；`context()` 在调用到达时取，补进 `HostToolCall`（`AgentSession` 给正在处理的输入 id）。
- 秘书：自己的附件工具（`media/attachment-tools.ts`）加上 `startSecretary({ tools })` 交进来的（`daemon.ts` 交 `reminders/tools.ts` 的三个提醒工具、`tasks/secretary-tools.ts` 的四个任务工具，21 号票的 `search_materials`、`propose_quick_action`），`onCards` 往会话里追加一条只有卡片引用的消息，卡片就出现在聊天里。15（建议立项）照提醒工具的样子用 `defineHostTool` 加。22 号票加了四个只读的：查看板（`board/tool.ts`）、读项目档案（`projects/records-tool.ts`）、列出待我处理和把卡片放进聊天（`inbox/secretary-tools.ts`）。工具要跑得久的，在 `defineHostTool` 里写 `timeoutMs`（不写按配置的工具调用超时，见下面"agent 管家的资源限制"）。`AgentSession` 把这些工具的登记加进会话的工具注册表（`registerTools(BUILTIN_TOOL_REGISTRY, ...tools.map((t) => t.descriptor))`），它们的调用和文件工具、bash 一样先经守卫判定（07 号票）。
- 提醒工具的时间：知道当前日期时写具体的日期时间（`at`）或周几（`weekday`），不知道时写"几天后的几点"或"几分钟后"，日期由守护进程按（可注入的）时钟算；工具结果里写明落到了哪天、星期几、几点。

## 秘书的看板感知、压缩与任务控制（22 号票）

规格第 7 节（秘书）、第 14 节（快速动作）。秘书掌握任务靠任务看板，不靠对话记忆；它的长期主线靠自动压缩控制长度。

- **看板变化消息**（`board/board-watch.ts`）：秘书"上次看到的样子"是上一条交到它手里的用户消息开始处理（`turn_start`）那一刻的看板（看板种类表 `BOARD_KINDS` 里各种东西的派生视图，`board/board.ts` 写成一项项：任务的状态，等我的带原因，失败的带原因，在第几阶段；提醒的待触发、已触发、已取消，中文名用协议包的 `REMINDER_STATUS_LABEL`）。交给秘书下一条用户消息时（`AgentSession` 的 `inputContext`），和现在的看板比：新出现的、状态变了的、换了阶段的（"任务 t-3「…」进入第 2/4 阶段"；刚开始执行、第一次有阶段的由状态那一行说明）写成一条以 `BOARD_CHANGE_TAG`（"【看板变化】"）开头的上下文消息，经宿主协议的 `user_input.context` 跟在这条用户消息后面（pi 的 nextTurn 自定义消息，会话文件里是 `INPUT_CONTEXT_TYPE`），系统提示不动；没变就不带。运行时给秘书的通知（系统消息）不带，变化攒到下一条用户消息。涉及的项目、提醒的时间这类补充不算变化。守护进程启动时、秘书子进程意外退出后（状态 `restarting`）`resync()`：从事件日志找最后一条处理完（不是被打断）的用户消息的 `turn_start`，把它之前的看板事件归并成"上次看到的样子"，所以停机时的变化下次照常报、报过的不重报；处理到一半崩了的那条可能已经连同看板变化进了会话文件，下一条会再报一次（宁可重报，不能丢）。**待我处理不在里面**：新增事项不进秘书的模型输入（不主动转述）。
- **只读工具**（都不落入任何关注类别，登记进秘书会话的工具注册表、照常先经守卫；除了 `show_card` 都是 `readOnlyOrIdempotent: true`）：
  - `view_board`（`board/tool.ts`）：看板的全貌，按五组列出（分组只用协议包那一份，和看板频道推给前端的一致；说明和空看板的说法由种类表和 `BOARD_GROUP_LABEL` 拼出）；
  - `read_project_records`（`projects/records-tool.ts`）：按项目编号或名字读任意项目（含已归档的）的最小文档集（`projectRecordsPaths` 给出位置，ADR 目录逐个文件，太长的截断并说明全文在哪），由守护进程读文件，不拉起、不唤醒维护者；没有对应的写工具；
  - `list_inbox`（`inbox/secretary-tools.ts`）：待我处理里还没处理（`isInboxItemProcessed`）、没归档的事项，先后用协议包的 `compareInboxItems`、紧急度的中文名用 `URGENCY_LABEL`（和 Web 的待我处理页同一份）；卡片事项带卡片编号和卡上的文字；
  - `show_card`：把待我处理里的卡片（编号从 `list_inbox` 的结果里抄）放进聊天：只往会话里追加一条卡片引用（同一 id、同一状态），在哪里点按钮都是同一张卡；每调一次多一条引用，所以登记成不幂等。**秘书没有任何对卡片做动作的工具**（卡片动作只接受来自前端的请求）。
- **秘书专用的压缩指令**（`secretary/system-prompt.ts` 的 `SECRETARY_COMPACTION_INSTRUCTIONS`）：拉起秘书时放进装配参数 `compactionInstructions`。子进程里的 `ergou-compaction` 扩展在 pi 的 `session_before_compact` 里自己写摘要：用 pi 导出的 `compact`（和 pi 默认的写法同一个函数、同一个模型调用函数和凭据），多带这份指令（接在 pi 的摘要提示后面，"Additional focus: …"），结果交回 pi 照常记进会话文件。自动压缩（到了阈值、上下文溢出）和手动压缩都走它。pi 把每条输入前的输入标记（`SESSION_INPUT_TAG`）和它后面的用户消息一起留下，切点就落在标记上、被当成"切在一轮中间"，那一轮会另用 pi 的"半轮"提示（不带自定义指令）写：扩展里的 `wholeTurns` 认出这种其实没切开的情况，把那一轮并回要压缩的历史，整段按这份指令写。压缩之后还是同一条主线会话（同一个会话文件），看板变化照常追加。彻底删除时压缩摘要的改写（21 号票）照旧：扩展写的摘要也是 pi 的 `compaction` 条目。18 号票的范围审视也挂 `session_before_compact`（`ergou-scope-review` 扩展，只在装配了 `scopeReview` 的维护者会话里，不改压缩本身），秘书会话里只有这一个。
- **任务控制快速动作**（`tasks/task-control.ts`，动作类型是 `TASK_CONTROL_ACTION` 的 `pause_task` / `resume_task` / `cancel_task`，参数 `{ task }`：任务编号或完整标题）：规范化时用 `findByIdOrName` 认出是哪个任务，能不能做用 `tasks/state-machine.ts` 的 `assertUserCan`（只看 `availableTaskActions(task, "user")`，执行控制器的 `task_action` 也用它），做不了的提议直接被拒（不出卡，说法是 `taskActRefusal`）。"点明了"照记忆命令的做法从严（取消是终态）：只看用户自己打的字，按句（句号、叹号、问号、分号、换行）、分句（逗号、顿号）看；问句不算（以问号结尾，或以"吗""么""呢""没有"这类收尾）；分句里有这个动作的说法（暂停；继续、恢复；取消），它前面没有否定词，并且任务（编号作为一个词，或完整标题）出现在动作词后面到分句结束的那一段里，或者是"把 X 暂停"的 X；那一段只是指代（"取消这个"）时任务要在用户引用的卡片上。"t-3 取消了吗？""取消提醒 r-1，t-3 怎么样了"都算推断。推断出来的（`confirm: "ask_when_inferred"`）一律先问（不论关注类别设置如何）。不落入任何内置类别（用户的自定义类别照样能按 `quick_action:pause_task` 匹配它）。执行走 `taskExecution.prepareAct`：迁移记为用户发起、按"谁能改"表里用户那一行校验，事件和快速动作卡、操作记录同一事务追加，落盘之后 `afterCommit`；暂停、取消中止维护者手头这一轮，名额满了继续回到排队中，取消产生"任务结局：取消"素材，都照 13 号票。执行控制器建在快速动作登记之后，`daemon.ts` 经后接接线点 `wiring.taskExecution` 交给它。
- **承诺即任务**写在秘书的固定系统提示里：只答应用户要它做的事；答应了就当场建任务或简单提醒（要反复做的事建一个任务，定时作业由计划落地，秘书没有建定时作业的工具）；用户没要求的只能给建议卡，不能口头答应。真实模型上的效果（以及 DeepSeek 上中途插入上下文消息对前缀缓存的影响）靠手动冒烟，不进自动测试。

## 关注类别设置（`watch-categories/`，26 号票）

规格第 9 节。用户的调整和自定义类别是数据，放在数据目录配置区的 `config/watch-categories.json`（守卫的写法：`{ builtin: { <类别>: { chat?, task? } }, custom: [{ id, title, match, chat, task }] }`）。**文件是真相**（守卫每次判定现读，取舍见 ADR-0009），关注类别频道上的事件是给设置页的同步。

- **只有 `WatchCategoryService` 写这个文件**（`daemon.watchCategories`）：设置页发 `update_watch_categories`（`UpdateWatchCategoriesParams`：`set_builtin` / `create_custom` / `update_custom` / `delete_custom` / `repair` / `reload`，处置用协议的写法），校验通过就先写临时文件再改名，再追加一条 `watch_category_settings`（带请求的幂等键：同一个键重发只改一次）。校验：
  - 内置类别只能不比默认松（和默认一样就是去掉这一项）；"—"的场景（计划外工单在对话里）不适用；两条底线不在注册表里，改不动——这几条在守卫的 `editWatchCategorySettings`（`guard/watch-categories.ts`，纯函数，表格测试在 `test/guard/watch-category-settings.test.ts`），违反的回 `not_allowed`；
  - 自定义类别的名字和规则过 `normalizeCategoryMatch`（`match.ts`，守护进程里唯一的这道检查，计划里本任务的类别也过它）：名字不空、至少一个条件；路径要写完整的 Windows 路径（Git Bash 的 `/d/x` 换成 `D:\x`，判断和换算用 `guard/paths.ts` 的 `isWindowsAbsolutePath`、`fromShellDrivePath`）；不对的回 `bad_params`；改、删不存在的回 `not_found`。**工具名不查登记**：还没登记的工具（比如以后的 MCP 工具）也能写，登记了才会命中，设置页提示"目前没有登记，登记后生效"（候选在 `daemon.ts` 的 `watchToolChoices`：内置和 bash 拆出的伪工具、秘书代为执行的工具、快速动作 `quick_action:<类型>`；27 号票的 MCP 工具加进这里）；规则里的工具后来没了也不妨碍只改处置；
  - 新建的 id 是 `c-<n>`，n 取用过的最大号加一（关注类别频道的事件里、当前文件里、计划里出现过的，`categoryIdsInPlans`），删掉的 id 不再用；本任务的类别是 `<任务 id>-c<n>`，不会撞上；
  - 删除或调松（任一场景更松、规则改了）一个自定义类别时，事件的 `change.heldByTasks` 记下还有几个进行中的任务确认时快照了它（`heldByTasks`，任务模块的 `planWatchCategories` 算），设置页提示"N 个进行中的任务仍按确认时的设置检查"。
- **现读**：`current()` 读文件（原文没变就用上次的解析结果），和关注类别频道上最后一条事件不一样（启动时还没有事件、用户手改过、改坏了）就追加一条 `by: "system"`、`change.op: "file"` 的事件。守卫接入（`createGuardRuntime({ settings })`）、任务模块（`createTaskService({ watchSettings })`）、快速动作都经它取，所以文件被手改坏了，下一次判定出错的同时设置页就看到问题。`start()` 在秘书拉起之前读一遍。
- **文件坏了**：`current()` 抛错，守卫以"判定出错"拦下（07 号票的行为）；事件的 `state.problems` 写着问题，表格仍是上一次有效的设置。这时别的修改回 `not_allowed`，只能 `repair`（`last_valid` 恢复成上一次有效的设置，`defaults` 恢复默认；坏掉的文件另存为同目录的 `watch-categories.broken.json`）或 `reload`（用户手改好了）。同时待我处理里放一条 `watch_categories_broken` 事项（"关注类别设置文件有问题，所有 agent 的工具调用都会被拦下"，卡着，动作"去设置页修复"由前端带到设置页、不算处理；已经有开着的就不再放），读到好的文件（修复、重新读取、判定时现读）就自动归档。
- **agent 写不进去**：配置区是受保护区域，文件工具、bash 拆得开的写入判"永不"（03 号票）。26 号票补了脚本：拆不开的内联脚本（`node -e`、`python -c`、`sh -c`……）的命令原文里、要跑的脚本文件里（`script-scan.ts` 报上来的 `ScriptFact.mentionedPaths`）写着受保护区域的路径时，读写分不清，按拆不开处理——写着密钥区的判"永不"（密钥区连读都拒绝），写着配置区、数据库区、程序目录的落入"未知的写操作"（先问用户）（`judge.ts` 的 `scriptTextRule`；写受保护区域的"永不"依据统一由 `protectedAreaFinding` 生成；路径从文字里认用 `guard/paths.ts` 的 `absolutePathsIn`：写死的盘符路径、转义过的反斜杠、Git Bash 的盘符写法；尽力而为，拼出来的认不出，也不看真实路径的环境事实）。

## 任务与计划（`tasks/`、`maintainers/`，12 号票）

规格第 7、8 节。从秘书聊天一路走到一张可以确认的计划卡；排队中 → 执行中、阶段执行和验收见下面"任务执行与阶段验收"（13 号票）。

**流程**（`tasks/tasks.ts` 的 `TaskService`，`daemon.tasks`）：

1. 发起，**只有用户点明了才发起**（58 号票，ADR 0019），三条路，建出的任务都是"规划中"，在任务看板频道推一条 `task` 事件（`change: "created"`）。任务分两种（`Task.kind`：`workflow` 流程 / `long_running` 长程任务，建卡时定下、不能换；之前建的没有这一项，`taskKind(task)` 补成长程任务）：
   - 用户点"发起任务"按钮：`start_task { request, projects?, kind? }` 请求（`startFromButton`，第一行当标题，同一个幂等键重发拿到同一个任务；`projects` 是用户多选的涉及的项目，写进 `Task.projects`；`kind` 是对话框里先选的种类，照 AgentSense 的 ScenarioPicker 两个页签，不选是长程任务）。不经秘书判断，同一事务给秘书一条通知（`buildAgentNotice` 那种系统消息，写明用户选了哪些项目、哪一种，写任务书时以它为依据）让它接着澄清。用户写的原话从这条 `task` 事件记成"用户发言"素材；
   - 用户在消息里点明了：秘书用 `start_workflow`（流程）或 `create_task`（长程任务）建（`createByRequest`），这一轮不出建议卡。点明没有由运行时判定（`tasks/launch-intent.ts` 的 `launchIntent`，白名单：看这一轮用户打的字和说的话，引用、卡片上的字不算，一句一句看，**一句话开头就是祈使的发起说法才算**——`/流程`、`/任务`，"按流程做 X""按照这个流程做：X""用流程帮我 X""发起（一个）流程：X""作为流程来做""发起（一个）长程任务：X""建个长程任务 X""发起任务：X"；说法前面只许有称呼（"二狗，"）、客气词（请、麻烦、帮我、能不能……）和原来就算点明的几个引子（"这件事""这次""就""不管怎样都""不如"）；说法后面冒号之后是要做的事，不再看，否则同一句里跟着"的、了、过、是、时"、否定或贬低、"还是""或者"、问功能的词（怎么、多久、什么、区别……）的不算，后面几句里收回（"算了""没必要"）的也不算；问句不算，客气的请求除外（"能帮我按流程做吗？"）；其余一律不算，最多出建议卡；只说"发起任务"没说种类的按长程任务；表格测试在 `test/tasks/launch-intent.test.ts`）。没点明、点明的是另一种时工具被拒、原因交回秘书（`launchRefusal`），不建任务；
   - 没点明、秘书觉得该发起的：`suggest_task` 只出一张"建议发起任务"卡（一轮最多一张），卡片版本 3：两个按钮"作为流程"（`start_workflow`）"作为长程任务"（`start_task`），用户点哪个建哪种（卡片动作和建任务同一事务，卡上的负载补上 `taskId`、`kind`），秘书收到通知。
   - 流程暂时只做不涉及项目的事：涉及项目的流程发起、写任务书时被拒（`WORKFLOW_PROJECTS_REFUSAL`，建议改用长程任务）。项目维护者在自己项目里发起的流程、长程任务以后由 64 号票做。
2. 澄清：秘书用 `ask_questions` 成批提问（提问卡，每题带推荐答案，题号 `q1`、`q2`……由工具给）。用户回答（`answer`，输入 `QuestionsAnswerInput`，每题都要答）后，卡片频道上同一事务多一条 `questions_answered`（"澄清问题的回答"素材的来源），答案作为通知交回秘书。
3. 任务书：秘书用 `write_task_brief`（目标、验收标准、约束、涉及的项目、记忆范围提议）写，`writeBrief` 存进内部 `tasks` 频道（`task_brief`，改了版本加 1），**同一事务**把任务书作为一条通知追加到执行的维护者的会话频道（带 `taskId`）——维护者模块看到它就唤起维护者（见下面"维护者的唤起"）。只有规划中的任务能写任务书。
4. 计划：维护者用 `submit_plan`（参数就是协议包的 `Plan` schema，pi 先按它校验）交出计划。`submitPlan` 再按 `plan.ts` 的 `checkPlan` 查一遍（见下），不过就抛 `RequestRejected`，原因作为工具结果交回维护者，不出卡；过了就同一事务：`plan_submitted`（`tasks` 频道，计划存在这里、不在 pi 会话里）、计划卡（`plan`，`blocking`）、任务转待确认（`planCardId`、`stages.total` 取自计划）、待我处理的卡片事项（"计划等你确认：……"），再 `inbox.alert`。计划 id 是 `<任务 id>-p<版本>`。
5. 计划卡：`confirm`（输入 `PlanConfirmInput`：`removeGrants` 勾掉的授权项 id、`narrowGrants` 收窄的、`assumptions` 改过的假设栏（整栏）；只能收窄，按守卫的 `validateGrantChange` 查，放宽的被拒）→ 存储里的计划随之改变（`plan_decided` 里是确认的那份，卡上的负载换成它，并记下 `removedGrants`（勾掉的授权项原样，`PlanGrant[]`，两处同名同形）、`narrowedGrants`（id）、`assumptionsEdited`），任务转排队中；`reject`（必须附意见）→ 任务回到规划中，意见作为通知交回维护者，它重新 `submit_plan` 出一张**新的**计划卡（版本加 1）。两个动作都追加 `plan_decided`（"审批决定"素材的来源）。

**状态迁移**（"谁能改"表 `TASK_TRANSITIONS` 在共享协议包 `task-transitions.ts`，13 号票从守护进程挪过去；`tasks/state-machine.ts` 的 `checkTaskTransition(from, to, by)` 每次迁移都过一遍，不合的抛 `not_allowed`）：12 号票用到的是 规划中 →（维护者，提交计划）待确认 →（用户，确认计划）排队中、待确认 →（用户，打回计划）规划中；表里已经写好 13、15、22 要用的（排队中 → 执行中、暂停 / 继续（排队中 → 已暂停也在）、完成 / 失败、返工、归档、取消、**转为项目**——用户把任何未结束的任务转为项目，以"已完成 · 已转为项目"结束：`Task.endKind: "converted_to_project"`、变化 `converted_to_project`），后面的票直接用，别另写判断。**现在能对任务做什么**也从这张表推（13 号票）：`availableTaskActions(task, actor)` 给出这个人现在能做的事（`TaskAct`：用户的控制 `TASK_ACTIONS`，加上不改状态的 `message`（用户在维护者会话里说话）、`work`（维护者处理会话里的输入）），表里的行带 `act`（用户的哪个控制走这一步）和 `when`（还要满足的：卡住求助、不是转为项目结束的、有在等用户验收的阶段），不改状态的几件在 `TASK_STAY_ACTS`；做不了时的说法 `taskActRefusal(task, act)`。执行控制器的 `act()`、维护者模块（什么时候处理输入、会话收不收用户的话）、Web 的任务详情（控制按钮、输入框）都只用它。同一对状态之间可以有几行（执行中 → 已完成：维护者"完成"、用户"转为项目"），谁能做看全部这几行。任务状态 `TASK_STATES`、未结束的 `UNFINISHED_TASK_STATES`、发起方式 `TASK_ORIGINS`、谁改的 `TASK_ACTORS` 和 `TASK_ACTOR_LABEL`、变化 `TASK_CHANGES`（加新的变化时往这里加）在协议包 `tasks.ts`。

**编号**：任务 `t-1`、`t-2`……；任务自己的维护者 `tm-1`、`tm-2`……（建卡时产生，`Task.maintainerId`），会话频道 `maintainer:tm-1`，pi 会话在会话区 `sessions/tm-1/`，工作目录是输出区里任务自己的一格 `outputs/t-1/`。

**计划的数据结构**（协议包 `task-schema.ts` 的 `Plan`；13、14、16、17、19、20、24、26 号票读它）：

| 字段 | 是什么 |
|---|---|
| `stages[]` | 阶段：`stageId`（`s1`……，`PLAN_ID_PATTERN`）、`title`、`deliverables[]`（交付件）、`acceptance[]`（`{ criterion, method: script \| review \| user, script?, expectOutput? }`，`script` 方式必须带命令；`expectOutput { contains?, matches? }` 只给脚本方式，和退出码一起判，`matches` 要是合法的正则，13 号票）、`mode`（`steps` 定步，必须带 `steps[]`；`open` 开放）、`dependsOn[]`（前置阶段，不能成环）、`policy`、`budget { tokens, toolCalls }`、`groupId?` |
| `stageGroups[]` | 阶段组：`groupId`、`title`、组里各阶段共用的 `policy` |
| 策略 `PlanPolicy` | 术语表的"策略"：`{ grants[], temporalRules[] }`，挂在阶段上，或者定义一次、套给整个阶段组。检查、列授权项、交给守卫时的展开都按策略走（协议包 `plan.ts` 的 `planPolicies`、`planGrants`：各阶段的在前，阶段组的在后） |
| 授权项 `PlanGrant` | `id`（整份计划里唯一）、`tool`（工具名，按工具注册表查得到）、`title`（给用户看的一句话）、`scope`（参数名 → 允许的值或值的数组，空对象是不限对象；参数名要是这个工具登记过的）、`maxUses?`（不写是不限次数）、`validDays?`（不写是 7 天）；流程的步骤由运行时推出的另有 `command?`、`exactArgs?`、`realScope?`（见下面"流程"）。判定时调用里的数组参数传空数组不算在对象范围里（不少工具空着就是全部：提交的 `paths` 空着是提交全部改动，58 号票） |
| 时序规则 | planguard 格式（`{ id, title?, trigger, require, … }`），存的时候按 `validateTemporalRules` 查（阶段、阶段组各查一遍，整份计划里 id 唯一）；12 号票只存和显示，执行中生效在 13 |
| `toolkit` | `{ skills[], mcp[], bash, network }`：执行时的工具包（13 号票按它装配） |
| `projects[]` | `{ project, changes[] }`：涉及的项目和改动（12 号票只存和显示；变成工单在 16、17） |
| `memoryScope?` | 记忆范围（占位，不生效） |
| `watchCategories[]` | 本任务要提醒的关注类别：`{ id, title?, disposition?, match? }`。**全局的一个都不能少**（任务书里列给维护者），处置只能比全局严；新加的必须写 `title`、`match`（确定的规则，和设置页同一种写法 `WatchCategoryMatch`，过 `normalizeCategoryMatch`）和 `disposition`，id 由运行时换成本任务的 `<任务 id>-c<n>`（26 号票；用户确认时在卡上加的接着往下排），只存在这个任务的计划里。全局类别的名字由运行时补上，规则不认维护者写的，只留比全局严的处置；**确认时调严过的全局自定义类别连当时的规则一起快照进计划**（`snapshotWatchCategories`，见下） |
| `userLimits[]?` | 用户说过的限制（26 号票）：`{ id, quote, temporalRules[], grantNarrowings[] }`。维护者把任务书的约束、用户说的"别……""只……"编译成时序规则（整个任务执行期间都检查）或授权收窄（`GrantNarrowing`，只能收窄），每条附上原话；至少编译出一样，编译不了的写进假设栏。原话要核对：`verifiedQuotes(limits, 用户的话)` 只认原样出现在任务书的约束、点按钮发起任务时写的话、用户在这个任务的维护者会话里发的消息里的（去掉首尾空白和引号、连续空白算一个），结果放进计划卡负载的 `verifiedQuotes`，对不上的卡上显示成"维护者转述" |
| `scheduledJobs[]` | 定时作业定义：`{ title, schedule: ReminderSchedule, each, project? }`（确认后登记、进运营中在 19 号票；秘书没有建定时作业的工具）。时间表可以是"按我的工作日"（29 号票），计划卡的负载版本因此是 2（旧前端降级成纯文本）；卡上的写法用 Web 状态层的 `scheduledJobLines(plan)`（"按我的工作日 09:00"） |
| `assumptions[]` | 假设栏：维护者拿不准的地方，用户确认时可以逐条改（随计划一起保存） |
| `stops { count, where[] }` | 维护者的停点预告，**只作参考说明**：卡上的"授权后还会在 N 处停下来"由代码算（见下） |
| `tokenEstimate` | token 粗估 |

- `checkPlan(plan, { tools, settings, taskId })` 是 schema 之外的检查（阶段 id 重复、前置阶段不存在或成环、定步没有步骤、脚本验收没有命令、阶段组不存在、授权项 id 重复或工具 / 参数不存在、时序规则、关注类别、用户的限制），一次报出全部问题。用户的限制（26 号票）：规则过 `validateTemporalRules`（规则 id 和阶段、阶段组的在整份计划里唯一），收窄按 `narrowPlan` 的办法查只能收窄，**通过后收窄就落到授权项上**（存的计划里授权项是收窄过的，限制和原话留着给卡上显示）；本任务新加的类别的规则规范化（路径统一成反斜杠、去掉末尾分隔符）。
- `grantInfoOf(plan, { tools, settings })`：每项授权在守卫眼里的样子（`GrantInfo`：工具的中文名、落在哪些关注类别、任务里这些类别最严的处置），放进计划卡负载的 `grantInfo`。类别按工具在注册表里登记的类别标签，加上只按工具名匹配的自定义类别；处置按全局设置和本任务往严里调过的取最严，底线工具固定"交给我做"。按参数才落进去的类别（路径越出项目目录……）这里看不到，执行时守卫照样判。
- **卡上的文字由代码从结构化数据生成**（协议包 `plan.ts`，守护进程的素材和 Web 共用）：授权行 `grantText(grant, info)`（工具、类别、对象范围、次数、有效期；维护者写的 `title` 只作灰字备注），时序规则 `temporalRuleText(rule)`（按形态和 `on_violation` 说明）。**落在"先问我""交给我做""永不"类别里的授权不算授权**（`grantAuthorizes(info)`）：卡上标"执行时仍会问"（`grantNotAuthorizedLabel`），不能勾选。
- **停点由代码算**：`planStops(card, { removed, narrowed })` 给出授权后执行时还会停下的地方——由你验收的阶段、不算授权的授权项、被勾掉的、被收窄的；卡上随勾选实时更新（处理过的卡不给勾选，按记下的确认结果算）。
- `narrowPlan(plan, input, tools, { taskId })`：确认时的勾掉、收窄、改假设栏和加本任务的关注类别（26 号票：`PlanConfirmInput.addWatchCategories`，`{ title, match, disposition }`，名字和规则过 `normalizeCategoryMatch`，结果里的 `added`；卡上没有删除，已有的删不掉）；不让做时分开给 `grantProblems`（放宽了、没有这一项）和 `categoryProblems`（`toGuardGrant` 换成守卫的形状比较放宽、收窄）。Web 那边把卡上的勾选变成确认输入的纯函数在 `state/plan-card.ts`（`planConfirmInput`、`narrowedGrantIds`）。
- **`snapshotWatchCategories(plan, settings)`**（26 号票，`confirmFromCard` 在确认时调）：本任务调严过（处置比当时的全局严）的全局自定义类别，连同当时的名字和规则写进确认的计划。这样**生效处置 = 当前全局设置和确认时的快照取最严**：全局后来调严照样生效，调松、改规则、删除放松不了已确认的任务；没调严的全局类别不快照，跟着全局走（取舍见 ADR-0009）。
- **`toGuardPlan(plan, { confirmedAt })`**：确认的计划变成守卫的 `GuardPlan`（13 号票执行时交给守卫）：授权项用同一个 `toGuardGrant` 变成 `Grant`（`stageId` 是它挂的阶段；阶段组的策略里的授权项展开到组里每个阶段，id 写成 `<授权项 id>@<阶段 id>`，次数按阶段各算；`expiresAt` 按 `validDays` 从确认时刻算），阶段和阶段组的时序规则、本任务的关注类别（换成守卫的处置词）一起带上。26 号票起：用户的限制编译出的规则加到**每个阶段**的 `temporalRules` 上；本任务的关注类别写成守卫的 `TaskWatchSettings`（`GuardPlan.watchCategories`）：内置类别的处置进 `builtin`，带规则的（本任务新加的、确认时快照下来的全局类别）进 `custom`（`{ id, title, match, disposition }`），没调严的全局类别不写。13 号票每次判定时现取全局设置（`daemon.watchCategories.current()`）交给守卫的 `settings`，`GuardPlan` 确认时算一次就行。
- 存储：派生视图 `tasks`（`tasks/views.ts`：`tasks`、`task_briefs`、`task_plans` 三张表），读用 `daemon.tasks.get / list / ofMaintainer / brief / plan / latestPlan`。存的计划是 `StoredPlan { planId, taskId, revision, cardId, maintainerId, status: pending \| confirmed \| rejected, plan }`，确认后 `plan` 是确认的那份。
- 计划卡（`plan`）的负载版本是 3（26 号票；2 是 29 号票的"按我的工作日"）：提交时的负载多了 `verifiedQuotes`（原话核对得上的限制 id），确认后的负载多了 `addedCategories`（卡上加的类别 id），授权行按确认的计划重算（加的类别可能让授权项落进"先问我"）；`plan_decided` 多了 `addedCategories`（规则和处置原样），素材里记成用户自己写的（`typed`，"给这个任务加了关注类别「……」：……"，`context` 加 `categories_added`）。
- 素材（`tasks/material-sources.ts`，在 `daemon.ts` 里 `materials.register`）：按钮建出的 `task` 事件 → "用户发言"（原话，本人、打的字；`context` 有 `start_task_button` 和选的 `project:<名字>`）；`questions_answered` → "澄清问题的回答"（选了推荐或卡上给的选项是 `choice`，自己写的是 `typed`；`context` 里有 `card:questions`，全按推荐的加 `all_recommended`）；`plan_decided` → "审批决定"（`context` 是 `decision:confirmed|rejected`、`card:plan`，勾掉、收窄、改了假设栏的加 `grants_removed`、`grants_narrowed`、`assumptions_edited`；授权项的说法和卡上一样由 `grantText` 生成；打回意见、改过的假设栏是 `typed`）。"建议发起任务"卡、提问卡被关掉是卡片模块通用的回避信号。

**秘书的任务工具**（`tasks/secretary-tools.ts` 的 `taskTools(tasks, cards, userTurn)`，`TASK_TOOL` 是名字；`userTurn` 是这一轮用户的输入，判定点明了没有）：`start_workflow`（标题、一句话说明，发起流程，58 号票）、`create_task`（标题、一句话说明，发起长程任务）、`suggest_task`（标题、为什么建议 → 卡）、`ask_questions`（可选的任务 id 和开场白，问题列表 → 卡；每道题是协议包的 `QuestionDraft`，就是提问卡 `Question` 去掉题号）、`write_task_brief`（任务 id 和协议包的 `TaskBrief`）。都只产生卡片或写任务模块，被拒时以出错的工具结果交回秘书。给模型看的文字里的工具名一律插值 `TASK_TOOL.*` / `SUBMIT_PLAN_TOOL`（和工具定义在同一个文件），不写字面量。

### 维护者的唤起（`maintainers/`）

**交给维护者一条输入 = 往它的会话频道追加一条带 `taskId` 的系统通知**：`conversation/messages.ts` 的 `buildAgentNotice(maintainerChannel(id), text, 幂等键, { taskId })`（第四个参数是 `MessageScope`：所属的任务、项目）拿到事件，放进 `appendBatch`（和引起它的事件同一事务，比如任务书、计划卡上的打回）。维护者模块（`maintainers/maintainers.ts` 的 `createMaintainers`，`daemon.ts` 在秘书之后 `start()`）订阅事件日志：维护者会话频道上第一次来了消息，就为这个维护者建一个 `AgentSession`（见下面"agent 会话"）并 `start()`，之后由它接着处理。

- 系统提示和任务书（26 号票）写明：本任务的关注类别怎么调严、怎么加；任务书的约束（用户说过的限制）编译成 `userLimits`（时序规则或授权收窄，附原话），编译不了的写进假设栏。编译的真实效果靠 DeepSeek 计划起草的手动冒烟。
- 起草计划时的装配：系统提示 `TASK_MAINTAINER_SYSTEM_PROMPT`；pi 工具 `PLANNING_PI_TOOLS` **只有 `read`、`ls`**（确认之前不动手不只靠提示词：白名单之外的工具 pi 根本不给，契约测试在 `pi-session.contract.test.ts`）；代为执行的工具只有 `submit_plan`（`maintainers/tools.ts`，`SUBMIT_PLAN_TOOL` 和定义在一起）；联网关着；`GuardAgent` 的 kind 是 `maintainer`，工作目录 `outputs/<任务 id>`，工具包里没有 bash；来源"任务「标题」"；会话段 `<维护者 id>:planning`；会话的消息范围 `{ taskId }`；`task()` 不给——计划确认之前的调用不属于任务，按对话里的处置判。
- **执行时的装配**（13 号票）：任务开始执行（有了 `stages.list`）后按确认的计划重新装配——pi 工具 `EXECUTION_PI_TOOLS`（`read`、`write`、`edit`、`ls`、`grep`、`find`），工具包开了 bash 才加 `bash`（连同带类型的 bash 工具，28 号票）；联网开关照计划**显式**给（`network: toolkit.network`）；代为执行的工具换成 `executionTools`（开始阶段、宣布阶段完成、报告进展、转为等我、失败）、"提议并行"（20 号票，`subAgentTools`）加上带类型的 bash 工具；`GuardAgent` 的工具包照计划；守卫的 `task` 是 `taskExecution.guardTask(taskId)`，会话段 `<维护者 id>:<任务 id>`（效果日志、时序规则按任务划范围）；装配里带重注入块（`contextBlock`）；每一段装配都有的口语总结工具（32 号票，`conversationTools`）也在这里加。系统提示还是同一段（起草和执行都写在里面）。skill、MCP 的装配在 27 号票。装配由 `taskSetup` 一处算出（`MaintainerAssembly`：工作目录、工具包、pi 工具、代为执行的工具名、围栏、是不是开发类），每次唤起算一次，拉起参数、代为执行的工具、守卫都取这一份；`maintainers.assemblyOf(taskId)` 现算一份给子 agent 收窄（20 号票）。**14、27 号票改了维护者的工具包（改计划、接 MCP）之后要调 `daemon.subAgents.reassemble(taskId)`**，活着的子 agent 跟着重新装配（见下面"子 agent 并行"）。
- **跟着任务变**（维护者模块订阅看板上的 `task` 事件）：起草和执行之间换装配时 `refresh()`；用户暂停、取消时 `abortTurn()`；阶段、状态变了 `setContextBlock(最新的重注入块)`；每次都 `poke()`。什么时候处理输入看任务状态（`canProcess`）：规划中、待确认、执行中、等我时处理，排队中、已暂停、结束了的输入留在队里。用户在任务详情里说的话：维护者休眠时唤起它；正在干活时作为插话（`interject: true`）。
- **后面的票**：任务的维护者派工单的工具在 17 号票（涉及多个项目的任务的维护者，工具包固定，见"涉及多个项目的任务"；16 号票的工单只来自用户发起的单项目任务，由运行时派，见"工单与派单"）；项目维护者（15、16）照同样的方式接：各自的会话频道 `maintainer:<id>`、输入是系统通知、直接用 `AgentSession`，只配置差异。

### agent 会话（`conversation/agent-session.ts`）

`AgentSession` 是"一个 agent 处理一条会话的输入"，秘书和维护者共用，各自只配置差异：

```ts
const session = new AgentSession({
  agents, store, streams, guards, media, timeZone, log,
  agentId, conversation, label: "维护者",       // label 用在系统说明里："维护者这次没能回复：……"
  scope: { taskId },                             // 会话里的消息（回复、卡片引用、工具调用记录、系统说明）都带上
  ledgerRole: "maintainer",                      // 在 token 账本里的角色（24 号票，不给是维护者）；用量记在谁名下见下面
  resident: false,                               // 常驻（秘书）：一开始就拉起、意外退出后重新拉起，不闲置退出
  spawn: (n) => ({ model, tools, cwd, systemPrompt, continueSession: true, credentials, network: false }), // 第 n 次唤起的装配
  hostTools,                                     // 代为执行的工具：登记进守卫的工具注册表，声明的超时交给管家
  guard: { agent: guardAgent, source, segmentId },// 守卫看到的会话（工具注册表、会话、消息范围由它填）
  vision: (model) => …,                          // 这个模型支不支持图片输入
  interruptedNote: (quoted) => `上一条输入「${quoted}」处理时中断了……`,
  sessionRewriteFor,                             // 彻底删除之后会话文件改写哪些原话（记忆模块的；不给就不改写）
  onStatus: (status) => …,                       // asleep / starting / idle / busy / restarting / stopped
});
session.start();
```

- **输入泵**：输入队列就是事件日志（`turn_start` / `turn_end`，派生视图 `agent_inputs`），一次处理一条；会话里来了消息就看一眼队首。按需的（非常驻）没有子进程时有输入才经 agent 管家唤起（满了排队），就绪了把队首的输入交过去（`prepareAgentInput` 的投影）；回复的流式增量节流推送，定稿只留文本和推理 part；代为执行的工具产生的卡片以一条卡片引用消息出现在会话里。
- **退出**：闲置退出（`reason: "idle"`）后变休眠，再来输入时重新唤起；意外退出（含超时中止后被结束）时正在处理的那条以 `interrupted` 结束、不重送（`interruptedNote` 写进会话），隔一会儿（1 秒起翻倍，最多 30 秒）常驻的重新拉起、按需的有输入才再唤起；`start()` 时上次被打断的输入同样处理。
- 每次唤起都 `forwardToolCalls: true` 并 `guards.attach`；代为执行的工具调用时带上正在处理的那条输入（`HostToolCall.inputMessageId`）。
- **用量记在谁名下**（24 号票，交给 agent 管家的 `ledger`，每次现取）：正在处理（或刚处理完）的那条输入所属的定时作业（消息事件里的 `scheduledJobId`）优先，其次任务（`taskId`）、项目（`projectId`），再按会话的 `scope`。输入的归属由输入队列带着（派生视图 `agent_inputs` 的 `scope` 列，`pendingInputs` 返回的 `QueuedInput.scope`），不回读事件。所以项目维护者处理带 `scheduledJobId` 的输入（19 号票把定时作业的一次运行交给它）时记在作业名下，处理带 `taskId` 的输入（项目的首个建设任务、16 号票的工单）时记在那个任务名下，和用户直接对话时记在项目名下。秘书（`ledgerRole: "secretary"`）不论输入属于谁都是系统开销（账本按角色判）。消息的归属（`MessageScope { taskId?, projectId?, scheduledJobId? }`）经 `appendMessage`、`appendAgentNotice` 的 `scope` 写进消息事件（`MessageEventPayload` 的同名字段）。
- **彻底删除**（21 号票）：会话里来了 `messages_purged`，闲着时（手头这一条处理完）停掉子进程、经 agent 管家的 `rewriteSessions` 改写会话文件、再按需拉起（常驻的马上拉起，按需的有输入才唤起）；`start()` 时把以前的先对一遍。维护者模块在维护者会话里来了 `messages_purged` 时也建好它的会话（`tasks.test.ts` 的"彻底删除"）。
- **22 号票加的**（秘书用）：`inputContext(message)`：交给子进程一条输入时跟在它后面的一条上下文消息（在追加 `turn_start` 之前现取，返回 undefined 就不带，经 `user_input.context` 交过去）；`spawn(n)` 的装配可以带 `compactionInstructions`。
- **13 号票加的**（维护者执行任务用，秘书不用）：
  - `hostTools()`、`guard()` 是函数，每次唤起现取（维护者起草和执行是两套；秘书、项目维护者给固定的那份）；`spawn(n)` 返回的装配可以带 `contextBlock`（重注入块）；
  - `canProcess?()`：现在能不能处理输入，不能时输入留在队里；状态变了由拉起它的模块调 `poke()`；
  - `refresh()`：要换一套装配，手头这一条处理完就停掉子进程，下次唤起按新的装配拉起（接着同一个会话）；
  - `abortTurn()`：中止手头这一轮（工具执行到一半被中止也算 `aborted`）；
  - `setContextBlock(text)`：活着的子进程换上最新的重注入块（下一条输入之前、压缩之后注入它）；维护者模块在任务每次变化时换；
  - `interject: true`：正在处理一条输入时用户又发来的话，作为插话送进子进程（`interject { inputId, text }`，在下一次模型调用之前插入）；子进程在 `turn_end.interjected` 里报出收下了哪几条，这几条随之记成处理完（`turn_start` + `turn_end completed`）；回合已经结束、没收下的（`error` 带 `inputId`）照常排队。
- **18 号票加的**（范围审视，维护者用）：
  - `scopeReview?: SessionScopeReviewOptions { model(spawn), instructions, context(), onCompactionReview(result) }`：给了就由 `conversation/scope-reviews.ts` 的 `SessionScopeReviews` 协调（照 `serveHostTools` 的做法，会话只在几处接上它）——拉起时装配里带上审视的那一份（`setup`）、交每条输入之前对照物变了先送 `scope_context`（`sync`）、子进程就绪后送等着的审视、有审视等着又没有子进程时拉起一个；压缩时子进程自己做的审视交给 `onCompactionReview`。两个维护者模块都用 `scope-review/session.ts` 的 `sessionScopeReview` 拼这一项；
  - `reviewScope(timeoutMs): Promise<ScopeReviewResult>`：让子进程审视这个会话里还没审视过的部分（工单结束时，派单器经项目维护者模块调）；结果回来、超时、子进程中途退出、会话停下都兑现（后几种 `report.error` 写原因），结果带着那次对照的是哪一份（`context`）。送出去到结果回来之间拿着 agent 管家的 `holdAwake`（不闲置退出），会话也不换装配、不改写会话文件。
- **16 号票加的**（项目维护者的会话分段用）：
  - `scope` 可以是函数：每次往会话里追加消息时现取（项目维护者的消息属于当前这一段：项目，做工单时还有任务）；
  - `accepts?(input)`：现在处理不处理这条排着的输入（`{ messageId, payload }`）；不处理的留在队里、不挡着后面的，插话同样先问它；
  - `outdated?()`：交下一条输入之前看一眼子进程是不是按过时的装配拉起的（换了一段会话、项目的装配变了），是就停掉、按新的装配拉起再交——比事件驱动的 `refresh()` 稳：同一事务里几条事件谁先通知都不会让旧进程接到新一段的输入；
  - `onIdleExit?()`：闲置退出时告诉拉起它的模块（对话段在维护者闲置退出时结束）；
  - `onReady?({ session })`：子进程就绪时报回它打开的是哪个会话（第一段对话段接着以前的会话时，项目维护者模块把名字记进这一段）；
  - `queuedAgentInput(store, input)`：输入队列里的一条连同它的消息事件负载（`accepts` 收到的就是它；派单器看"这一段还有没有要处理的输入"也用它）。

## 流程（`tasks/workflow-*.ts`、`guard/workflow-review.ts`、`guard/workflow-steps.ts`、`guard/planguard/reviewer.ts`，58 号票）

ADR 0019：照搬 AgentSense 的固定计划（`web/src/agent/plan.ts`、`runtime.ts` 的 `propose_plan` / `report_step` 和系统提示、`planguardReviewer.ts`、`ui/components.tsx` 的 `PlanCard`）。执行时每次调用和计划逐步比对、自动修回是 59 号票。

- **起草**：流程的维护者的系统提示是 `maintainers/system-prompt.ts` 的 `workflowMaintainerSystemPrompt`（"工作方式"六条照 AgentSense，加上写参数和条件的规矩 `WORKFLOW_PLAN_GUIDE`）；任务书是 `workflowBriefText`。起草时的工具是 `propose_plan`（`tasks/workflow-tools.ts`，名字在 `tool-names.ts` 的 `WORKFLOW_TOOL`），参数是协议包的 `WorkflowPlanDraft`：`{ goal, steps: [{ id, title, tool, args?, after? }], rules }`。步骤里只能写 pi 的读写、搜索、通用 bash 和带类型的 bash 工具（守卫的 `stepToolAllowed` / `workflowStepTools`，检查和系统提示里的清单都用它）；`rules` 是这份计划要满足的条件（时序规则，planguard 格式，四种：之前必须做过、之前不能做过、当下必须满足、一律禁止），过规则校验（`validateTemporalRules`）。检查（`tasks/workflow-plan.ts` 的 `checkWorkflowDraft`：步骤 id、工具、前置步骤、成环、规则）不过的以出错的工具结果交回维护者。
- **审查修补**（`guard/workflow-review.ts` 的 `reviewWorkflow`，引擎是照搬的 planguard 规划时审查 `guard/planguard/reviewer.ts`、`search.ts`）：规则是框架的 v1 模板加计划里写的，交给引擎的每一步先变成规则看到的样子（`rule-steps.ts` 的 `ruleStep`，和执行时同一种形式）。规划时不取环境事实，要用到的规则判不了，推迟到执行时（`deferred`）。没写修补方案的规则按 `on_violation` 补一个（`withDefaultRepairs`：`pull_back` 退回维护者、`confirm` 或不写交给用户确认、`block` 没有修补）；v1 模板"推送之前要跑过测试"带插入修补（插一步 `run_tests`）。时间预算 `WORKFLOW_REVIEW_BUDGET_MS`（1 秒），超了算没审查（`skipped`）。结果是 `WorkflowReview { verdict, status, violations, actions, confirmations, deferred, replans, scanned, phases?, rules, ms, note? }`：`rules` 是逐条规则的复测（照 AgentSense 的 `perRule` / `RuleProbe`：每条规则单独扫一遍原计划，`{ id, title, source, ms, violated, unknown, error? }`），`phases` 是各阶段耗时（`facts` 规划时恒为 0、`compile`、`solve`、`probe`），计划卡审查面板"扫描"一步下面可以展开看；修补后的步骤（插入的带 `inserted`，改写的带 `patches`）才是授权对象。另给出每一步要满足的条件（`stepConditions`：触发它的规则、`trigger.where` 明确不成立的不算，连同规划时查出的结果 `pass` / `violated` / `unknown`）。
- **标注和条件**（`tasks/workflow-plan.ts` 的 `reviewWorkflowDraft`）：每一步的敏感标注按守卫判一遍（`judgeToolCall`，任务里、授权项由步骤推出，环境事实是规划时现取的、真实路径和写的不一样的那些路径的文件事实：真实路径在项目之外的照执行时一样落进"越出项目目录"，别的路径照旧不给事实）：落进了哪些关注类别、底线，类别的处置，计划授权了没有（`WorkflowStepMark`），会被直接拒绝的也标出来；真实路径落在项目、工作区之外的路径另列在 `WorkflowStepView.outside`（`{ arg, path, realPath }`），卡上这一步下面写明，并且是授权前必须逐条勾的确认事项（`workflowConfirmationItems(review, steps)`，key 是 `o:<步骤>:<参数>:<路径>`）；条件写成人话（`conditionText`：`temporalRuleText`，触发工具换成这一步的工具）。工具包按步骤推出（守卫的 `workflowToolkit`：用到 bash 或带类型的 bash 工具才开 bash，用到要联网的才开联网）。审查退回（`needs_replan`）、判定不可执行（`blocked`）的：结果交回维护者（AgentSense 的原话），照 AgentSense 也把这版计划显示给用户——`TaskService.refuseWorkflowPlan`：`plan_submitted` 带 `refused`（`task_plans` 里这一版的状态是 `refused`，版本号照样往上加），一张不能授权的流程计划卡（负载 `refused`）进待我处理，写明原因和下一步：退回的不卡任务（维护者会改好重新提交；卡上"知道了""取消任务"），不可执行的卡着任务（"让维护者改"可以附说明，交回维护者、`plan_decided` 的 `decision` 是 `returned`，记成"让维护者改"；"取消任务"和任务详情里的取消同一个控制；服务端也只许不可执行的那版"让维护者改"、退回的那版"知道了"）；交给用户授权和审查没通过的两种都走 `TaskService` 里同一个 `putWorkflowPlan`；任务还在规划中。其余的 `TaskService.submitWorkflowPlan`：`plan_submitted`（`plan` 是推出来的执行用的那份，`workflow` 是流程计划，`task_plans` 视图多一列 `workflow`）、流程计划卡（`workflow_plan`，版本 1，负载 `WorkflowPlanCardPayload`）、任务转待确认（`steps: { total, done: 0 }`）、待我处理事项。
- **授权**（`tasks/cards.ts` 的 `workflowPlanCardType`）：`confirm` 的输入是 `WorkflowConfirmInput { confirmations }`，审查要你逐项确认的事项（协议包 `workflowConfirmationItems`，照 AgentSense 的 `confirmationItems`）没勾完被拒；任务转排队中，`plan_decided` 带 `workflow` 和 `confirmations`。`reject` 可以附说明：回到规划中，"用户拒绝了计划 vN。用户说明：……"交回维护者，重新提交是新的一版、新的一张卡。
- **执行**：沿用长程任务的执行控制器。确认的流程计划推出一份只有一个阶段（`WORKFLOW_STAGE_ID` = `flow`）的计划（`workflowExecutionPlan`：授权项由步骤推出（守卫的 `workflowGrants`）——步骤里写死的参数全部进对象范围（路径解析成绝对路径，数字、真假按字面，对象按 JSON），非 bash 的步骤只认步骤里写了的参数（`exactArgs`：调用多带了步骤里没有的参数、比如建远端仓库多带 `visibility`，就超出；参数按内容精确比，数组少了、多了都不算；只放行直接调用那个工具，从通用 bash 拆出来的同类调用一律不算——拆的时候认不出的旗标会丢，`git push --delete`、`commit --amend`、`merge -s ours`、`gh repo create --push`），通用 bash 的步骤按拆出来的伪工具各一项、再限定到这条命令本身（`Grant.command` / `PlanGrant.command`：判定时只有从同一条命令拆出来的调用才算授权内，命令只去掉首尾空白比），路径按真实路径比（`realScope`：规划时用 `guard-runtime/facts.ts` 的 `gatherFileFacts` 现取真实路径记进授权项，判定时调用里的路径的真实路径（判定前现取的事实）也要落在里面，取不到的不放行，悬空的链接取不到（`util/real-path.ts`）；规划时取不到的不发授权；取路径参数的循环只有守卫的 `absolutePathArgs` 一份），对象不确定的不发授权（参数没法确定、路径没法解析、拆不开的命令、命令拿到了看不见的输入、会联网却说不清发给谁、推送没写明远端和分支：执行时照常按处置问用户），同一个工具、同样的对象范围、同一条命令合成一项，次数是用到它的步骤数（一步里出现几次也只算一次）；时序规则是计划里写的条件；没有预算），排队、名额、暂停、审批挂起、催促都照常（流程只有这一个内部阶段，给维护者、给用户的说法里不说"阶段 flow"，说"流程"，催促时说步骤和 `report_step`）。第一次开始时建好 `Task.steps.list`，交给维护者 `workflowNoticeText.started`（审查改过的照 AgentSense 说"必须照它执行——插进来的步骤即使你认为之前做过也要再做一遍"，列出步骤和每一步的条件）。执行时维护者的工具是 `report_step`、`wait_for_user`、`fail_task`（`workflowExecutionTools`；没有阶段、计划变更、并行、增减 skill 的工具）；`report_step` → `TaskExecution.reportStep`：看板上推一条 `step_reported`，步骤都做完或说明跳过时 `flow` 阶段算完成、流程完成（不逐步验收）。重注入块是 `workflowContextText`（步骤、状态、条件、边界）。流程没有返工（`availableTaskActions` 的 `not_converted` 条件把流程排除）。
- **Web**：流程计划卡 `ui/cards/WorkflowPlanCard.tsx`（审查面板四步（"扫描"下可展开逐条规则的复测）、步骤连同工具参数和条件、敏感标注、确认事项勾选、授权执行 / 拒绝；审查没让它交给你授权的那一版写明原因和下一步，按钮是"让维护者改""知道了""取消任务"），纯函数在 `state/workflow-card.ts`；看板卡片和任务详情显示"做完 N/M 步"，任务详情列出各步的状态。

## 任务执行与阶段验收（`tasks/execution.ts`，13 号票）

规格第 8 节（阶段执行、验收、并发、状态补充）、第 9 节（守卫的三条硬检查）。确认过的任务从排队到完成由**执行控制器** `createTaskExecution` 管（`daemon.taskExecution`），14（阈值和升级、计划变更）、16、17（项目任务、工单的阶段验收）、19、20（并行阶段）、22（快速动作控制任务）、23、24、25 号票都在它上面加。

**执行状态全在任务里**（看板频道的 `task` 事件，`Task.stages.list: TaskStage[]`），不在 pi 会话里：

| 字段 | 是什么 |
|---|---|
| `TaskStage` | `{ stageId, title, state, dependsOn, waitReason?, waitingOn?, acceptance: TaskStageAcceptance[], attempts, startedAt? }`。`state`（`STAGE_STATES`）：`pending` 未开始 / `running` 进行中 / `accepting` 验收中 / `waiting` 等我（`waitReason`：`approval` / `hand_over` / `acceptance`；`waitingOn` 是在等的审批 id 或待我处理事项 id）/ `accepted` 已验收。`attempts` 是宣布过几次完成，`startedAt` 是第一次开始的时刻（能开始时优先接着做开始过的） |
| `TaskStageAcceptance` | `{ criterion, method, result?: { passed, note?, at } }`：每条标准的验收结果（脚本的退出码和输出末尾、评审的理由；用户退回的原因**不**放这里，见下面素材） |
| `Task.stages` | `{ total, current?, list?, focus? }`：`current` 是第 N 阶段（`stagePosition`：维护者的当前阶段是第几个），开始执行时才有 `list`；`focus` 是维护者最后一次开始的阶段（它 `start_stage` 的、运行时替它开始的；用户同意并行时交给子 agent 的不算，20 号票），维护者的当前阶段按它定（`stages.ts` 的 `currentStage`：`focus` 还在做、在验收、在等用户就是它，否则它自己在做的、第一支在等的、第一个没开始的），暂停、继续、重启后都不变 |
| `Task.waitReason` / `waitNote` / `failReason` | 任务转等我的原因（`TASK_WAIT_REASONS`，中文 `TASK_WAIT_REASON_LABEL`）、维护者卡住求助时写的原因、判失败的原因；恢复执行时清掉 |
| `TaskEventPayload.stageId` | 阶段的变化（`stage_started` / `stage_submitted` / `stage_accepted` / `stage_returned` / `stage_waiting` / `stage_unblocked`）是哪个阶段 |

任务的变化 `TASK_CHANGES` 加了 `started`（排队中 → 执行中）、`requeued`（要恢复执行——继续、一支不用再等了、重试、返工——时名额满了，回到排队中；不管是哪种恢复一律记成它，`by` 照发起的人）、上面那几种阶段变化、`waiting` / `resumed` / `paused` / `completed` / `failed` / `retried` / `rework` / `cancelled`。状态迁移照旧过 `TASK_TRANSITIONS`（13 号票加了：执行中 → 已完成 `system`、等我 → 已完成 `system`（最后一个由我验收的阶段通过）、失败 → 已取消 `user`）。**任务的一次变化**用 `tasks.buildChange(prev, next, { by, change, stageId? }, 幂等键?)` 拿到 `task` 事件（状态变了就查迁移表，不合的抛 `not_allowed`），和别的事件一起 `appendBatch`；排队中的任务按进入排队的先后 `tasks.queued()`（`tasks` 视图的 `queued_seq` 列）。

**阶段的纯函数**（`tasks/stages.ts`，表格测试在 `test/tasks/stages.test.ts`）：`missingPrerequisites(list, id)`（前置阶段没验收的）、`runnableStages(list)`、`nextStep(list)`（`continue` 接着做 / `start` 开始一个能开始的 / `wait`（所有能推进的都在等用户，带原因）/ `complete`：阶段都建好了、全部验收了才算，空列表不算）、`allAccepted(list)`、`stageNow(stage, state)`（换状态、去掉在等什么）、`reopen(list, id)`（返工：指定阶段和它的全部下游回到未开始，其余不动）、`stagePosition(list)`、`guardStageId(list)`（守卫眼里的当前阶段：在做的，没有就第一个等着的、第一个没开始的）。开始执行时各阶段的样子 `initialStages(plan)`、一个阶段的策略（它自己的加所属阶段组的）`stagePolicies(plan, id)` 在共享协议包 `plan.ts`（Web 也用）。

**控制器的规矩**：

- **全局执行名额**（配置 `tasks.maxRunning`，默认 3；19 号票起和开始了的定时作业运行共用，谁占着只在 `tasks/slots.ts` 里数）：看板频道上任务一有变化、名额可能空出来时（`slots.onFreed`）就（微任务里）按排队先后把空出的名额补上（排队中 → 执行中，`system`，`started`）。**第一次进入执行中**（从排队中开始，或者排队时暂停、没开始过就继续了）建好各阶段、开始第一个能开始的阶段、给维护者一条"计划已确认，开始执行"的通知（写明这个阶段的交付件、验收标准、模式、授权和时序规则、边界）。等我、已暂停、结束了的不占名额；要恢复执行（继续、一支不用再等了、重试、返工，`resume`）时有名额回到执行中（变化记成 `resumed` / `retried` / `rework`），名额满了回到排队中（一律 `requeued`；之后开始时不重新交代）。
- **一支在等用户**：守卫的 `approval_suspended`（带 `origin.taskId`、`stageId`）、"交给我做"事项（`hand_over`，`data.origin.taskId`）让调用所在的阶段转 `waiting`；别的阶段能推进就接着推进（任务仍是执行中、占名额，维护者收到"这一支先停下，先做……"的通知）；所有能推进的都在等时任务转等我（`waitReason` 是第一个在等的阶段的原因）。`approval_decided` 且 `resumed: false`（事后批准或拒绝）、"交给我做"点了"已完成"时这一支回到未开始，任务在等我的就恢复执行（同上，名额满了 `requeued`），执行中的看下一步；给维护者的"已获批准，可以重试""已经亲手完成"通知照旧由 07 号票的模块追加（带 `taskId`）。**批准了、可维护者正在做别的阶段**（s1 挂起后控制器让它先做 s2）时，控制器另给一条通知：先用 `start_stage` 切回 s1 再原样重试（一次性授权按调用指纹匹配，指纹里有批准时记下的阶段，在 s2 里重试对不上、会再问用户）；没有别的阶段在做时控制器自己开始 s1（开始过的优先），当前阶段就是 s1。审批卡、"交给我做"事项在任务里的紧急度是 `blocking`（07 号票已按 `origin.taskId` 定）。
- **维护者推进阶段**（代为执行的工具，`tasks/execution-tools.ts` 的 `executionTools(execution, scope)`，名字是 `tasks/tool-names.ts` 的 `EXECUTION_TOOL`）。控制器上维护者用的五个方法都传 `MaintainerScope { taskId, maintainerId }`、返回结构化的结果（`startStage` → `StartStageResult { stage: StageHandoff, alreadyRunning, setAside? }`，`completeStage` → `CompleteStageResult`：`void`（验收期间任务结束了）/ `returned` / `awaiting_user` / `accepted`，带各条结论 `AcceptanceVerdict[]` 和接下来 `NextUp`；`reportProgress` → `{ cardId }`；`waitForUser`、`fail` → `{ itemId }`），给模型看的话（工具结果 `completeStageText` / `startStageText`、阶段的交代 `stageText`、控制器交给维护者的通知 `noticeText`）都在 `execution-tools.ts` 组织，22 号票要结构化结果直接调控制器：
  - `start_stage { stageId }`：换去做另一个能开始的阶段（前置阶段没验收的拒绝："阶段 s2 的前置阶段 s1 还没验收，不能开始"）；手头在做的放回未开始（开始过的优先接着做）；
  - `complete_stage { stageId, summary }`（工具调用超时 30 分钟）：阶段转验收中、`attempts` 加 1，然后**验收**：脚本方式的在工作目录里跑（`tasks/acceptance.ts` 的 `runAcceptanceScript(typedShell, …)`：照 28 号票带类型 bash 工具的启动器 `typedShell.runScript`——闸门进程先放进这次调用的 Job 对象再起 Git Bash，孙进程跑不出去，结束时关掉 Job；系统变量白名单，联网开关关着时加无效代理；10 分钟超时。退出码 0 才算通过，计划里写了期望的输出 `expectOutput { contains?, matches? }`（标准输出和标准错误合在一起，包含这段文字、匹配这个正则）时一并判定，没写只看退出码；没对上的地方和输出末尾记进结论）；都过了再派评审子 agent 判评审方式的（见下）；没通过的交回维护者（`stage_returned`，阶段回到进行中，结论在工具结果里）；都过了还有"由你验收"的，待我处理里放一条 `stage_acceptance` 通知（`blocking`，动作 `STAGE_ACCEPTANCE_ACTIONS`：验收通过 / 退回），阶段转 `waiting`（`acceptance`）；全过了就 `stage_accepted` 并推进。每次结论是一张进度卡（`kind: "acceptance"`，`judgedBy` 是 `script` / `review` / `user`，卡上标"脚本检查""评审判定""用户验收"，`ACCEPTANCE_VERDICT_LABEL`）；
  - `report_progress { text }`：一张进度卡（`kind: "progress"`）；
  - `wait_for_user { reason }`：任务转等我（`stuck`，`waitNote` 是原因），待我处理里放一条 `stuck_help`（`blocking`，动作"继续执行"）；用户在任务详情里回话、或者点"继续执行"，任务接着执行；
  - `fail_task { reason }`：原因必填（空白的拒绝），任务失败（`failReason`），待我处理里放一条 `failure_choice`（`blocking`，动作 `FAILURE_CHOICE_ACTIONS`：重试 / 取消任务）。
  被拒的以出错的工具结果交回维护者。这几个工具不落入任何关注类别，照样先经守卫。
- **全部阶段验收后任务自动完成**（`completed`，`system`），维护者会话里一条说明，任务留下的卡着任务的事项改成 `non_blocking`。
- **用户的控制**：`task_action` 请求（`TaskActionParams { taskId, action, stageId?, note? }` → `TaskActionResult { taskId, state }`，要幂等键，同一个键重发拿到同一个结果；网关交给 `taskExecution.act`）。要和别的事件同一事务追加的（22 号票的任务控制快速动作：快速动作卡、操作记录）用 `taskExecution.prepareAct(params, 幂等键)`：同样的校验和迁移，返回 `PreparedTaskAct { events, result, afterCommit }`，调用方自己追加 `events`、落盘之后叫 `afterCommit`（`act` 就是它加上追加）。能不能做只看 `availableTaskActions(task, "user")`，做不了回 `not_allowed`（说法 `taskActRefusal`）。`action`（`TASK_ACTIONS`）：`pause`（执行中、排队中、等我 → 已暂停，中止维护者手头这一轮）、`resume`（已暂停、卡住求助的等我 → 恢复执行）、`cancel`（任何未结束的和失败的 → 已取消）、`retry`（失败 → 恢复执行，维护者收到上次失败的原因）、`rework`（已完成的任务、指明 `stageId`：`reopen` 按依赖重开，由同一个维护者接着做，附的话交给它）、`accept_stage` / `return_stage`（由我验收的阶段，退回可附原因）。待我处理里那几种通知的动作（`inbox.onNoticeHandled`）调同样的函数（重试、取消、卡住后继续、验收通过、退回各一个，现在做不了的——已经在任务详情里做过了——什么也不做）；在任务详情里做了同一件事时，对应的通知自动记成处理过。等我的事项从不自动批准。
- **重启**：`start()` 时验收做到一半（`accepting`）的阶段交回维护者（"验收被打断了，再宣布一次完成"），然后补名额。所以"宣布阶段完成"登记成"由执行控制器负责恢复"（`recoveredByController`；它跑验收脚本、改验收次数，不是只读或幂等）：被杀时正在验收不记执行记录、不算说不清做没做完，重启后控制器交回维护者再宣布一次（23 号票）。
- **中断不确定**（23 号票）：守卫接入记了 `tool_call_interrupted`（任务里一次有副作用的调用被杀时还在执行，或者维护者的子进程意外退出）时，执行中、等我的任务转等我（`waitReason: "interrupted"`，`waitNote` 是"中断：不确定 X 是否已执行"，同一任务又来一条就接在后面），维护者会话里一条说明，待我处理里一条 `interrupted`（`blocking`，动作 `INTERRUPTED_ACTIONS`：已经执行了，继续 / 没执行，重做这一步；`data` 是协议包的 `InterruptedNoticeData { toolCallId, agentId, taskId }`，用 `interruptedNoticeData(item)` 取；调用摘要不放进数据，回答时从执行记录取）；已暂停、排队中的只放事项。运行时不自动重做。用户选了动作，任务恢复执行（名额满了排队），维护者收到"用户确认过了：X 已经执行了 / 没有执行"；在任务详情里点"继续"（中断不确定和卡住求助一样由用户直接定夺：协议包的 `USER_DECIDES_WAIT_REASONS` / `userDecidesWait`，`task-transitions.ts` 的 `user_decides` 条件、执行控制器和任务页都用它）收到"先查一下那次调用的效果"；在任务详情里回话的，他的话就是输入。恢复时这个任务别的"中断不确定"事项不再卡着任务。别的分支有了结论（批准了、验收了）也不会让中断不确定的任务自己恢复。
- **并行**（20 号票，见下面"子 agent 并行"）：`checkParallel(scope, stageIds)` 查这几个阶段现在能不能交给子 agent（任务是这个维护者在执行的、在执行中；阶段正在做或能开始、前置都验收了、没有子 agent 已经在做），`parallelStartEvents(scope, stageIds)` 在用户同意时再查一遍、给出没开始的阶段开始的事件（和卡片更新同一事务；这样开始的不记成维护者的 `focus`）：**几个阶段同时 `running`**。**维护者的当前阶段是它最后一次开始的那个**（`Task.stages.focus`，`stages.ts` 的 `currentStage`），守卫、重注入块、进展卡、看板上的第 N 阶段都按它，不按计划里的顺序取。有子 agent 在做的阶段（`subAgentsOn(taskId)`，`daemon.ts` 接到 `daemon.subAgents.busyStages`）维护者不能宣布完成（"还有子 agent（sa-1）在做"）、不能切过去（"有子 agent（sa-1）在做：等它交回结果再切过去"），切到别的阶段时也不放下它；子 agent 交回结果后它的阶段交还维护者：维护者对一个在做、但没有活着的子 agent 的阶段调 `start_stage` 就切过去（记成 `focus`，手头在做的那个放下），不再回"已经在做了"。看下一步（`nextStep(list, busy)`）时有子 agent 在做的阶段不算维护者手头的：维护者手头空着就替它开始一个能开始的阶段，在做的只剩子 agent 的就接着等。子 agent 的调用挂起后被批准时，控制器不发"先切回 sX 再原样重试"（那是维护者自己的调用才有的，按 `origin.agentId` 分），通知由子 agent 那边给（见下）。

**评审子 agent**（`tasks/review.ts` 的 `createReviewer`）：每次评审一个新的子进程、新的会话（agent id `review-<任务>-<阶段>-<第几次>`），固定的只读工具包——pi 工具 `REVIEWER_PI_TOOLS`（`read`、`ls`，系统提示里插值它们），加代为执行的 `submit_review`（`tool-names.ts` 的 `SUBMIT_REVIEW_TOOL`，每条标准按编号给通过与否和理由，没判全的退回）；输入只有交付件和验收标准（不给维护者的说法）；守卫照常（`sub_agent`，任务里、当前阶段）；交出结论、回合结束就结束它，没交就结束的算评审出错（这几条没通过）；拉起到结束的流程是 `agent-manager/one-shot.ts` 的 `runOneShotAgent`（和并行派出的子 agent 共用）。不占任务的执行名额，占 agent 管家的子进程名额。模型 `REVIEWER_MODEL`（和维护者一样），测试经 `startDaemon({ reviewerModel })` 换。契约测试的白名单用例在 `pi-session.contract.test.ts`。

**守卫的三条硬检查**（03、05 的判定函数加 13 号票的输入）：维护者执行时的 `GuardedSession.task` 是 `taskExecution.guardTask(taskId)`（确认的计划经 `toGuardPlan`，`confirmedAt` 是确认时刻，`currentStageId` 是 `guardStageId`）——

1. 授权只在所属阶段内有效：用到别的阶段的授权项时**按规则退回**（`pullBack: [GRANT_OTHER_STAGE]`，说明"这一步的授权项 X 属于阶段 sY，当前是阶段 sZ……"），不按授权放行；
2. 前置阶段没验收的阶段不能开始：在控制器（`start_stage` 拒绝；自动推进只开始能开始的）；
3. 被判过"永不"的对象再做对外动作要先问：守卫运行时在任务里一次对外调用被判"永不"时，用 `neverObjectsOf(input, judgement)` 记下它的对象（收件人、网址，推送是仓库、远端和分支），追加 `guard` 频道的 `never_recorded { taskId, objects, tool, time }`；之后同一任务的判定输入带上 `neverObjects`，对这些对象的对外动作至少按"先问我"（发现 `never_object`）。读过 `.env` 或密钥文件后对外发送由 05 的 v1 模板一律禁止，不重复判。

**重注入块**（`tasks/context-block.ts` 的 `contextBlockText`，`taskExecution.contextBlock(taskId)`）：开头"【运行时注入】"，写任务和状态、第 N/M 阶段、目标、各阶段状态、当前阶段的交付件 / 验收标准 / 模式、当前阶段（加所属阶段组）的授权（`grantText`，不算授权的标出来）和时序规则、边界（工作目录、bash 和联网开关、三条硬检查、该用哪个工具）。系统提示不变；每次唤起（刚拉起，或者闲着时来了新输入）时作为会话里的一条上下文消息注入，压缩之后也注入最新的（宿主协议 4，见上面"维护者的唤起"）；维护者模块在任务每次变化时 `setContextBlock` 换成最新的。一个阶段的交代、授权和时序规则、边界（`stageBrief`、`stageAuthorization`、`boundaryLines`、`authorizationSection`）也用在阶段变化时交给维护者的话里（`stageText`：开始执行、换阶段、一支停下先做别的、用户验收通过后接着做、宣布完成的结论里的"接下来"）。纯函数测试在 `test/tasks/context-block.test.ts`。

**任务完成后的回调**：`taskExecution.onCompleted(fn)`（返回取消登记的函数）。"任务完成"只走这一条路：全部阶段验收、任务自动完成之后叫（事件已经落盘），`fn` 拿到 `CompletedTask { task, brief, plan, workDir }`（任务、任务书、确认的计划、交付件所在的工作目录，也就是产出区 `outputs/<任务 id>`）；返工后再完成会再叫一次；**转为项目**（以"已完成 · 已转为项目"结束）不是做完了，不叫；出错只记日志。`daemon.ts` 只接线：29 号票 `holidayUpdates.taskCompleted(completed)`（只认 29 发起的更新任务；导入交付件，没交全、不对的由节假日模块在待我处理里放一条 `holiday_import_problem` 说明，`non_blocking`，`data { taskId, problems }`）、15 号票 `projects.taskCompleted(task)`（首个建设任务完成，项目进入使用中）。

**项目的任务**（15 号票的首个建设任务 `project_build`，执行者是项目的维护者）：控制器照常排队、开始阶段（通知进项目维护者的会话）、验收、完成；完成时经上面的回调交给项目模块，项目自动由建设中进入使用中。项目维护者还没有 `submit_plan`、执行工具和重注入块（`maintainers.ts` 只管任务自己的维护者），验收脚本的工作目录 `workDir(taskId)` 和 `CompletedTask.workDir` 也还是 `outputs/<任务 id>`，这些归 16 号票；主切面"项目的首个建设任务（15 号票）：接口衔接"只验回调接到项目模块，端到端验证（项目维护者起草计划、执行到完成）归 16 号票。

**素材**（`tasks/material-sources.ts`）：`taskOutcomeSource`（看板 `task` 事件里的 `completed` / `failed` / `cancelled` → "任务结局"，来源分别是系统 / agent / 本人，失败带原因）；`outputReactionSource`（`tasks` 频道的 `output_reaction`：`OutputReactionPayload { taskId, taskTitle, stageId, stageTitle, reaction: accepted \| returned \| rework, note?, reopened?, by, time }` → "用户对产出的反应"，用户写的原因是 `typed`；彻底删除的改写 `outputReactionPurge` 只换掉 `note`）；用户在维护者会话里说的话本来就是"用户发言"（消息带 `taskId`）。

**进度卡**（`tasks/progress-card.ts` 的 `progressCardType()`，负载 `ProgressCardPayload { taskId, taskTitle, stageId, stageTitle, stageIndex, stageTotal, kind: progress \| acceptance, text, acceptance? }`，动作只有 `ack`）：出现在维护者会话里（卡片引用），不进待我处理；纯文本降级"进展：任务「…」第 N/M 阶段「…」。…" / "验收通过（评审判定）：……"。

**主切面**在 `test/main/task-execution.test.ts`（演示流程录成 `task-execution.json` 给前端回放；名额和排队（排队时暂停、没开始过就继续的从第一个阶段开始）；审批挂起、交给我做时一支停下（s1 挂起、s2 在做时批准了，切回 s1 再重试）；同一个子进程里换了阶段、闲着时来了新输入也注入最新的块；守卫拿到计划和当前阶段；重注入块和插话；验收不通过；由我验收；进展、失败、卡住、暂停和取消；节假日数据的更新任务完成后导入；项目的首个建设任务完成后项目进入使用中（15）；用户的限制编译出的规则和计划卡上加的关注类别在执行中生效（26））。

## 子 agent 并行（`sub-agents/`，20 号票）

规格第 8 节"阶段执行"、第 11 节"子 agent"、第 21 节"并行"。`createSubAgents`（`daemon.subAgents`）。

- **提议**：维护者执行时的代为执行的工具 `propose_parallel`（`tasks/tool-names.ts` 的 `PROPOSE_PARALLEL_TOOL`；维护者的系统提示、工具说明里插值它和 `TOOL.bash`、`TOOL.git_merge`）：`{ reason, agents: [{ stageId, step?, instructions, workDir? }] }`。先过控制器的 `checkParallel`；`step` 要是那个定步阶段的步骤；`workDir` 相对维护者的工作目录（或绝对路径、Git Bash 写法），要已经存在、在维护者的工作目录里，不写就是维护者的工作目录（`ownWorkDir: false`）；几个子 agent 自己的目录**彼此不重叠**（同一个、一个在另一个里面都不行）。**开发类**（维护者装配里的 `development`：任务自己的维护者没有项目类型，工作目录是 git 仓库时算；项目维护者按立项书的项目类型，16 号票接）每个子 agent 必须有自己的目录，而且是**工作目录这个仓库的 git worktree**（目录里的 `.git` 是文件、指向 `<工作目录>/.git/worktrees/` 下面，不起 git 进程判断）：不写目录、直接用工作目录、普通目录都拒绝并说明原因。过了就定下子 agent 的 id（`sa-<n>`，全局接着往下排）和提议 id（`par-<n>`），同一事务追加 `parallel_proposed`、并行确认卡（`parallel`，`non_blocking`：用户处理之前维护者照常一件一件做）、待我处理的卡片事项；同一任务上一张没处理的并行确认卡过期（任务结束时也过期，`expireUndecided` 一处）。卡片引用随工具结果出现在维护者会话里。被拒的原因作为出错的工具结果交回维护者。
- **用户决定**：卡上两个动作就是协议包的 `PARALLEL_DECISIONS`（`parallel` / `sequential`，`ParallelDecision` 从它派生）。同意时没开始的阶段随卡片更新一起开始；子 agent 自己的目录提议之后被删了的拒绝（"目录不在了"）。维护者收到通知（`texts.ts` 的 `confirmedNotice` / `declinedNotice`，附用户写的话）。两个决定都是"审批决定"素材。
- **拉起**：`parallel_decided`（`parallel`）落盘后，为这次提议的每个子 agent 追加 `sub_agent_started`，经 `runOneShotAgent` 拉起（占子进程名额、满了排队，活动状态"排队"；不是任务，不占任务的执行名额）。装配从维护者此刻的装配收窄，**在纯函数里保证是子集**（`assembly.ts` 的 `subAgentAssembly(maintainer, { agentId, cwd, hostTools })`）：pi 工具、bash 和联网开关照维护者的；代为执行的工具是调用方给的候选（带类型的 bash 工具，`typedShell.toolsFor({ cwd: 子 agent 的目录 })`）和维护者的 `hostTools` 取交集，再去掉维护者专用的（`MAINTAINER_ONLY_TOOLS`：推进任务、提议并行、提交计划）；新会话（`continueSession: false`）、固定的 `SUB_AGENT_SYSTEM_PROMPT`；守卫：`kind: "sub_agent"`（写项目档案一律拒绝），工作目录是它自己的，围栏（项目档案、工作目录）是维护者的，`task()` 是维护者的任务、当前阶段换成它被派去做的阶段（`subAgentGuardTask`，每次调用现取：授权收窄立即生效），会话段同维护者；工具调用记录进维护者的会话，带 `{ taskId, stageId, agentId }`。就绪后递送第一条输入（`texts.ts` 的 `workText`：工作说明、阶段的交付件和验收标准、授权和时序规则、边界，工具包的说法和重注入块共用 `context-block.ts` 的 `toolkitText`）。
- **结束**：这一轮结束（`turn_end`）就交回结果、结束子进程（做完即解散）：同一事务追加 `sub_agent_finished` 和一条交回维护者的消息（发言方 `system`、`agentInput`，带任务、阶段、子 agent；任务已结束的只留说明；`texts.ts` 的 `resultText`），维护者下一回合用到；它的阶段交还维护者（维护者 `start_stage` 切过去，合并、收尾、宣布完成）。出错的写原因；任务暂停、取消、失败、完成时它的子 agent 被结束（`stopped`，原因 `STOPPED_BY`；继续后**不自动重拉**）；子进程意外退出、排队时被取消算 `interrupted`；守护进程重启前没结束的（同意了、拉起了的）在 `start()` 时交回一条"被打断了（守护进程重启）"。守护进程停止时不交回。
- **重新装配**（`daemon.subAgents.reassemble(taskId)`，返回重新拉起的子 agent）：**14 号票的计划变更和自行调整（执行控制器的 `toolkitChanged`，`daemon.ts` 接到这里）、27 号票接 MCP 等改了维护者的工具包之后调它**。这个任务活着的子 agent 按维护者新的装配重新算交集，变了的照规格第 11 节"工具包变了立即生效"：**等它做完手头这一步**（当前的工具调用结束、下一次模型调用之前，`runOneShotAgent` 的 `onStepEnd`）就结束子进程、按新的装配重新拉起、**接着原来的会话**（`continueSession: true`），交给它一条"工具包已变更"的说明（`reassembledText`：之前、现在的开关和工具）；还没开始（排队、还没就绪）的直接按新的装配重拉（新会话、照常的工作说明）；这一步之后这一轮就做完了的照常交回结果，不再重拉；没变的不动。不记第二次 `sub_agent_started`。只改授权项不用调：守卫每次调用现取任务的计划。
- **审批的边角**：子 agent 的调用等审批超时挂起后，用户事后才批准或拒绝：一次性授权只认子 agent 自己的调用指纹，通知进的是维护者的会话。守卫接入运行时的 `lateNotice`（`approval-waits.ts`，`daemon.ts` 接到 `daemon.subAgents.lateNotice`）换掉通知的说法（`texts.ts` 的 `lateDecisionText`）："……是子 agent sa-N 在阶段 X 的调用，用户事后批准了；子 agent 已结束，这次批准用不上了。还要做的话请在阶段 X 里自己重新调用，会再问一次用户"，不说"原样再调用一次会直接放行"；拒绝的也写明是子 agent 的调用。
- **给别的票**：`busyStages(taskId)`（阶段 → 在做的子 agent，任务执行控制器用）；`ownerOf(agentId)`（`SubAgentOwner`：任务、阶段、维护者、提议，24 号票把子 agent 的用量归到任务时用；派生视图 `sub_agents` 的 `getSubAgent`、`liveSubAgents` 同样可读，重启后也在）；用量（24 号票的账本）：子 agent 拉起时（重新装配再拉起也一样）给 `ledger: () => ({ owner: { kind: "task", id: taskId }, role: "sub_agent", stageId: 它被派去的阶段 })`，用量从它的子进程照常上报，agent id 就是 `sa-<n>`，记在它自己的阶段、算进那个阶段的预算（`ledger.stageTokens(taskId, stageId, { budget: true })`），不另数；`reassemble(taskId)`（14、27 号票，见上）。
- **项目的维护者**（16 号票接上）：`daemon.ts` 给子 agent 模块的 `maintainerAssembly` 先问任务的维护者模块（`maintainers.assemblyOf`），再问项目维护者模块（`projectMaintainers.assemblyOf`：维护者手上是这个任务的执行工单段时才有；`projectRecords` 是项目档案，`development` 按立项书的项目类型，工具包是任务授权和项目工具包的交集）；`projectOf(taskId)` 让交回维护者会话的消息、子 agent 的工具调用记录也带上项目。项目的工具包变了（立项书确认）、维护者正在执行某个任务时，项目维护者模块调 `reassemble(taskId)`。开发类被拒时的说法是"开发类：……"；开发类的工作目录不是 git 仓库（用户绑定的外部目录；二狗给的默认工作目录在立项书确认时已初始化成 git 仓库）时先拒绝并说明办法：先把工作目录初始化成 git 仓库（`git init`，再提交一次），再为每个子 agent 建 worktree。主切面在 `test/main/work-orders.test.ts` 的"子 agent 并行（20 号票）"：项目任务里批准并行后子 agent 写项目档案被守卫硬拒绝、写工作目录照常；开发类按项目类型算。
- 主切面 `test/main/parallel.test.ts`（提议和拒绝——这条路录成前端回放 `parallel-sequential`、同意后拉起和结果、提议的检查和有子 agent 在做的阶段、子 agent 随任务暂停和守护进程重启停下（维护者的当前阶段不变）、事后批准子 agent 的调用的通知、维护者的当前阶段（子 agent 做完后按维护者自己的阶段判、切过去后按那个阶段判）、工具包收窄后重新装配、名额、开发类的 worktree 和带类型的合并、开发类提议的目录检查）；守卫切面 `test/guard/sub-agent.test.ts`（工具包是维护者的子集——表格、围栏、按任务的计划和子 agent 的阶段判定）；纯函数 `test/tasks/stages.test.ts`（`nextStep(list, busy)`、`currentStage`）。Web 的回放在 `packages/web/test/state/recorded.test.ts`。

## 偏离、阈值与计划变更（`tasks/execution.ts`、`tasks/plan-change.ts`、`tasks/thresholds.ts`、`tasks/stall.ts`、`tasks/grant-renewal.ts`，14 号票）

规格第 8 节（阈值、偏离的逐级升级、计划变更）、第 9 节（授权项的有效期）。都加在 13 号票的执行控制器上，"一支停下"照 13 号票的规矩落地：别的分支还能推进就只停这一支（阶段转 `waiting`），都在等才转等我。术语：维护者提交、用户在卡上确认的叫**计划变更**；维护者不扩大授权、直接改的叫**自行调整计划**；两者统称**计划变更和自行调整**（不说"执行中改计划"）。

**新字段**（共享协议包）：`TaskStage.pullBacks` / `returns` / `nudges`（拉回、验收退回、催促的计数，用户让这一支接着走时清零）、`TaskStage.waitNote`（这一支为什么停下；所有能推进的都在等时任务的 `waitNote` 取第一个在等的阶段的）；`Task.rejections`（累计被用户拒绝几次）、`Task.pauseReason`（`TASK_PAUSE_REASONS`：`too_many_rejections`，中文 `TASK_PAUSE_REASON_LABEL`"累计被拒"）。等我的原因 `TASK_WAIT_REASONS` 加了 `plan_change`（计划变更），`over_budget` 早有；超预算和卡住求助一样是等用户定夺的（并进 23 号票的 `USER_DECIDES_WAIT_REASONS` / `userDecidesWait`：卡住求助、超预算、中断不确定），用户点"继续执行"（任务详情里；超预算的按钮写"追加预算继续"）或待我处理里那条事项上的"继续执行""追加预算继续"就接着走，"谁能改"表里等我 → 执行中 / 排队中（用户）的条件是 23 号票的 `user_decides`。**会话里回话就接着走的只有卡住求助、中断不确定**（`RESUME_ON_REPLY_WAIT_REASONS` / `resumesOnReply`）：超预算的任务收到用户的话，照常交给维护者回答，任务仍停在等我、不重给预算（2026-10-08 用户定的）；别的分支卡住求助的照样接着走。系统能把排队中的任务暂停（累计被拒）。任务的变化加了 `pulled_back`、`nudged`、`progressed`、`rejection_counted`、`plan_change_proposed`、`plan_changed`、`plan_change_rejected`、`plan_revised`。待我处理的通知加了 `over_budget`（动作 `OVER_BUDGET_ACTIONS`：追加预算继续）；`stuck_help`、`over_budget` 的 `data` 是 `{ taskId, stageIds }`（哪几个阶段停下了）；`grant_renewal` 的动作 `GRANT_RENEWAL_ACTIONS`（续期 / 不续）。看板频道上加了 `task_plan`（`TaskPlanEventPayload { taskId, planId, revision, plan, grantInfo }`：现在生效的计划换了一版，见下）。时间线记录（25 号票的 `TIMELINE_RECORD_KIND_INFO`）加了 `plan_change`（计划变更）、`plan_revision`（自行调整计划），`deviation`（偏离）由这里产生。

**阈值**（默认值只在 `tasks/thresholds.ts` 的 `DEFAULT_TASK_THRESHOLDS`，配置 `tasks.thresholds`：`pullBacks`、`nudges`、`stallMinutes`、`acceptanceReturns`、`budgetExplainTimes`、`budgetAskTimes`、`rejections`、`renewalLeadHours`；字段名和配置键一致，时长的在配置里写分钟、小时，代码里是 `stallMs`、`renewalLeadMs`。维护者的系统提示 `maintainers/system-prompt.ts` 的 `thresholdsText(thresholds)` 照它插值，放在两种维护者共用的 `executionGuide(thresholds)` 里，通知里的倍数也是参数）：

| 偏离 | 计数 | 超了 |
|---|---|---|
| 被拉回（守卫按规则退回，`guard` 频道的 `pulled_back { origin, toolCallId, tool, ruleIds, time }`，守卫运行时在任务里一次调用被拉回时追加） | 调用所在阶段的 `pullBacks` | 满 3 次后再犯：这一支停下（卡住求助） |
| 无进展（`tasks/stall.ts` 的 `createStallWatch`，调度器键 `task-stall:<任务 id>`）：维护者的子进程在运行（`agentAlive`，接 agent 管家的 `live()`；不在运行的到点不算停滞，从那一刻重新计时）、任务在执行中、维护者手头的阶段在做（它的当前阶段，20 号票的 `stages.focus`；交给子 agent 的不算），`stallMs`（默认 20 分钟）内没有成功的工具调用（效果日志 `effect_recorded`，子 agent 的也算）也没有阶段推进（看板上的任务变化，不算进展的见 `STALL_NEUTRAL`） | 那个阶段的 `nudges`（`nextNudge` 是纯函数） | 每到点催一次（维护者会话里的系统通知，`interject: true`：它正在干活时以插话送达，只有催促这样送）；有了进展（成功的工具调用、阶段推进）从那一刻重新计时，没在等用户的阶段催促计数清零（`progressed`）；同一次停滞里催满 3 次仍无进展，这一支停下（卡住求助） |
| 验收退回（脚本、评审没通过） | 阶段的 `returns` | 退回 2 次、第 3 次还不过：这一支停下（卡住求助），`complete_stage` 的结论是 `stuck` |
| 预算：每个阶段按 token 加工具调用次数累计。token 从 24 号票的账本取（`ledger.stageTokens(taskId, stageId, { budget: true })`，不算评审、范围审视，子 agent 在这个阶段的用量算进去），减去这一份预算起算时账本里的数；工具调用次数从维护者会话里的工具调用记录数（维护者和子 agent 的都记在那里，带调用时的阶段），`tasks` 频道的 `budget_used { taskId, stageId, toolCalls }`，视图 `task_budget` 只记工具调用次数、起算点（`base_tokens`、`base_tool_calls`）和说明过没有（`tasks.stageUsage`）。账本每记一条（`ledger.onRecorded`）`daemon.ts` 叫 `taskExecution.tokensRecorded(taskId, stageId)` 比一次；计划里写 0 的那一项不算 | `budgetRatio`：用量 / 预算两项各算一个比值、取大的 | 用量超过预算（`budgetExplainTimes`，默认 1 倍）让维护者说明进展（一条通知，只说一次，`budget_warned`）；超过预算的 2 倍（`budgetAskTimes`）这一支停下（超预算）。用户点"追加预算继续"后这个阶段从现在起重新给一整份预算（`budget_reset { baseTokens }`） |
| 用户拒绝（审批卡上拒绝、计划变更卡上拒绝） | 任务的 `rejections` | 满 5 次整个任务转已暂停（系统，`pauseReason`）；用户继续时清零 |

一支停下（`stopBranch(d, stages, reason)`）：`reason` 是结构化的 `BranchStopReason`（`pull_backs` / `stall` / `acceptance` / `over_budget` / `infeasible`，带次数、用量和预算……），说法由 `execution-tools.ts` 的 `stopReasonText` 生成（给维护者的通知、待我处理事项、阶段的 `waitNote`、时间线记录共用一句）。待我处理里放一条 `stuck_help` 或 `over_budget`（`blocking`），阶段转 `waiting`（`waitingOn` 是这条事项），别的能推进就接着推进；维护者收到"这一支停下等用户"的通知。用户点事项上的"继续执行""追加预算继续"、在任务详情里点"继续执行"（超预算的写"追加预算继续"），停下的阶段一起回到未开始、计数清零，超预算的重新给一整份预算，任务接着执行（名额满了排队）；在任务的会话里回话只让卡住求助的那几支接着走。给维护者的"这一支停下"通知也照这个写：超预算的告诉它等"追加预算继续"，会话里的话照常回答但不接着做。维护者用 `mark_infeasible` 标做不了的也走这条路（卡住求助，`waitNote` 是"做不了：……"）。

**时间线**：这一支停下、每次催促、让维护者说明进展、累计被拒暂停任务，各在维护者会话的频道上记一条 `timeline_record`（`deviation`，`buildTimelineRecord`，归属用 `taskMessageScope`，说的是哪个阶段就带哪个）；计划变更被确认或拒绝记一条 `plan_change`，自行调整计划记一条 `plan_revision`（详细说明列出改了什么）。授权内放行的调用本身就是工具调用记录上的 `withinGrant`，不另记。

**偏离的逐级升级**（守卫，`guard/judge.ts` 的 `GuardJudgement.deviation`，表格测试在 `test/guard/deviation.test.ts`）：落在"计划里列了才做"那一档的调用——授权内的放行，只在时间线记一笔（工具调用记录的 `withinGrant`）；计划对这个类别有授权项（同一个工具，或者授权项的工具登记在这个类别里，或者把授权项当成一次调用判一遍也落在这个类别里——按路径判的"越出项目目录"靠这一条，`grantsFallInCategory`）、这次超出了对象范围、次数或有效期的是 `exceeds_grant`，先问用户（审批卡，说明写"超出授权"）；计划里没有任何对应授权项的是 `unanticipated`，先问用户并马上暂停这一支（守卫运行时提交审批后不等，直接挂起：`approval-waits.ts` 的 `suspendNow`）。**子 agent（20 号票）的调用不先挂起**，照常等用户（等的时候它那一支就停着；挂起了它会接着往下做完、交回结果）。"先问我""交给我做""永不"照旧，不算偏离。

**计划变更**（维护者的工具 `propose_plan_change { plan: PlanDraft, why, goal?, acceptanceCriteria?, stages? }`，`PlanDraft` 是计划去掉 `watchCategories`、`userLimits`、`scheduledJobs`、`memoryScope`——这几样沿用当前计划；`goal`、`acceptanceCriteria` 是任务书里新的目标和验收标准，不改就不写）：`tasks/plan-change.ts` 的 `diffPlan` 算出相对当前计划（和现在的任务书）的改动 `PlanChangeItem[]`（新增 / 放宽 / 收窄 / 挪动 / 去掉授权项、工具包、项目、目标、任务的验收标准 `criteria`、阶段的验收标准和交付件、预算、时序规则、阶段的增删和顺序……每一处带 `expands`：扩大了授权或者改了目标、验收）。每种改动的说法、对应的授权项、落在哪些阶段上在协议包 `plan.ts` 的 `PLAN_CHANGE_KINDS` 一张表里（`planChangeItemText`、`planChangeGrant`、`planChangeStages`；新加一种只改这张表）；工具包一样不一样只用协议包的 `sameToolkit`，"预算加了"只用 `budgetRaised`。没有扩大的被拒（提示自行调整）；**同一任务一次只有一张在等**。出一张计划变更卡（`plan_change`，`tasks/plan-change-card.ts`，负载 `PlanChangeCardPayload`：`changes` 只列变化，`affectedStages`，变更后的整份计划和 `grantInfo`），进待我处理（`blocking`）；只有受影响的阶段（`affectedStages`：扩大的改动落在的阶段、维护者另外点名的；都不落在阶段上的停维护者的当前阶段）转 `waiting`（`plan_change`），其余照常推进。`tasks` 频道的 `plan_change_proposed`，视图里这一版是 `proposed`。**已验收的阶段不能改**（要改让用户返工）。
- **确认**（`PlanConfirmInput`，和计划卡一样可以勾掉、收窄授权项，加本任务的关注类别；和计划卡共用 `tasks/plan.ts` 的 `planConfirmation`：收窄、关注类别快照、`plan_decided` 的负载、说明）：追加 `plan_decided`（带 `change { why, changes, basePlanId }` 和 `grantTimes`），这一版成为现在生效的计划（`tasks.confirmedPlan(taskId)`），任务的 `planCardId` 换成这张卡，阶段跟着新计划（`stagesAfter`），等这张卡的阶段恢复，看板上推一条 `task_plan`。改了目标或任务的验收标准的，任务书换成新的一版（`tasks.buildBriefRevision`，同一事务），重注入块（`contextBlock` 的目标和"任务的验收标准"）和下一次提交时的比较都用新的。工具包变了：维护者模块看到任务变化后等它做完手头这一步，按新工具包（取现在生效的计划）重新拉起，接着同一个会话；卡片动作落盘之后（`afterCommit`）执行控制器叫 `toolkitChanged(taskId)`，`daemon.ts` 接到 20 号票的 `subAgents.reassemble(taskId)`，活着的子 agent 按新的交集重新装配。只改授权项不用：守卫每次调用现取计划。
- **拒绝**（可附说明）：受影响的阶段交回维护者，在现有授权内自行调整计划（`revise_plan`），做不到就 `mark_infeasible { stageIds, reason }`；拒绝算一次被拒。
- **自行调整计划**（`revise_plan { plan, why }`）：不扩大授权的改动（拆阶段、调顺序、改步骤、收窄或去掉授权项、关掉能力、加时序规则）直接生效（`plan_revised`，新的一版，时间线记一笔 `plan_revision`，看板上推 `task_plan`；关掉了能力的同样叫 `toolkitChanged`），扩大的被拒（列出哪几处，提示改走计划变更）。在等用户或在验收的阶段不能去掉。

**授权项的有效期**（`tasks/grant-renewal.ts`）：每项授权（守卫的 id，阶段组的写成"授权项 id@阶段 id"，取计划里的 id 用 `tasks/plan.ts` 的 `planGrantIdOf`）的授予时间、到期时间（`GrantTime { grantedAt, expiresAt }`，`toGuardPlan`、`StoredPlan.grantTimes`、续期共用这一个类型）记在那一版计划上；13 号票确认的计划没记，按确认时刻和各自的 `validDays`（默认 `DEFAULT_GRANT_VALID_DAYS` 7 天，一天 `DAY_MS` 只在 `thresholds.ts` 定义）算。计划变更、自行调整后原样留着或收窄的照旧，放宽的从这次起重新算有效期，新加的从这次起算（`grantTimesAfter`）；续期和它用同一个"再给一期"的算法（`extendedExpiry`）。到期前 `renewalLeadMs`（默认一天，调度器 `grant-renewal:<任务 id>`）待我处理里放一条 `grant_renewal`（`non_blocking`，`data { taskId, planId, grants: [{ grantId, title, expiresAt }] }`）；续期后有效期从原来的到期时间（过了就从现在）再延一期，不续的到期后不再生效（守卫判超出授权，执行到那一步再问）。决定记成 `tasks` 频道的 `grant_renewal_decided`。

**素材**：计划变更卡上的确认、拒绝也是 `plan_decided`（`planDecisionSource`，上下文 `card:plan_change`，改动的说法由 `planChangeItemText` 生成）；续期、不续是 `grantRenewalSource`（"审批决定"，上下文 `notice:grant_renewal`）。

**给模型看的话**都在 `execution-tools.ts`（`proposePlanChangeText`、`revisePlanText`、`infeasibleText`、`stopReasonText`、`spendText`、`noticeText` 的 `branchStopped` / `branchResumed` / `nudge` / `budgetExplain` / `planChangeConfirmed` / `planChangeRejected`）；控制器的方法返回结构化结果（`PlanChangeProposal`、`PlanRevision`、`InfeasibleResult`、`BranchStopReason`）。

**项目的维护者执行的任务**（16 号票）：执行控制器不分谁在执行，拉回、无进展、验收退回、预算、累计被拒、计划变更和自行调整对项目维护者执行的任务一样生效。任务属于哪个项目只认 `ProjectService.projectOf(task)`（`daemon.ts` 接进执行控制器的 `projectTasks.of`）；给维护者的通知、会话里的说明、时间线记录的归属都用 `scopeIn(d)`（任务、阶段，项目的任务还有项目）。无进展看 `task.maintainerId`（项目的任务就是项目的维护者）的子进程在不在运行；预算的 token 和工具调用次数照样按任务和阶段取（项目维护者会话里的消息和用量的归属来自派单器的 `scopeOf`，执行的工单段带任务和当时的阶段）。执行时的系统提示两种维护者共用 `executionGuide(thresholds)`（计划变更、自行调整、阈值的说法都在里面，`projectMaintainerSystemPrompt` 多了 `thresholds` 参数）。项目维护者执行的工单段（`projects/maintainers.ts` 的 `assemble`）按现在生效的计划（`tasks.confirmedPlan`，计划变更提出的一版在确认之前不算）取工具包，再和项目工具包取交集；现在生效的计划的工具包变了（`executingToolkit` 记进 `outdated` 比较的装配形状），交下一条输入之前按新的装配重新拉起，子 agent 照样经 `toolkitChanged` → `subAgents.reassemble`（装配取 `projectMaintainers.assemblyOf`）。会话分段收尾时催写回的次数也取 `tasks.thresholds.nudges`，和执行中的催促同一个阈值（`createWorkOrders({ nudges })`，原来写死的 `WRITE_BACK_NUDGES` 去掉了）。

**Web**：计划变更卡 `ui/cards/PlanChangeCard.tsx`（状态层 `state/plan-change-card.ts` 的 `planChangeLines`、`planChangeAffectedText`、`planChangeConfirmInput`；负载只用协议包的 `PlanChangeCardPayload`，原型的工具包变更卡去掉了，维护者不在任务里时要加能力归 27 号票）；看板和任务详情的状态写法 `taskStatusText`（"等我 · 超预算""已暂停 · 累计被拒"）；阶段抽屉写明这一支为什么停下（`StageView.waitNote`），交付件、预算、授权取现在生效的计划：换过版的取看板上最新的 `task_plan`（`UiState.taskPlans`），没换过的取计划卡；时间线上的偏离、计划变更、自行调整计划按 25 号票的记录显示。

**主切面**：`test/main/deviation.test.ts`（拉回、验收第 3 次、预算（含项目维护者执行的任务超预算）、偏离的三级、累计被拒）、`test/main/stall-renewal.test.ts`（可注入时钟：催促、阶段推进后重新计时和计数清零、维护者不在运行时不催、续期）、`test/main/plan-change.test.ts`（确认、拒绝后自行调整和做不了、改目标和任务的验收标准、收窄工具包后子 agent 重新装配）；录了 `task-plan-change`、`task-over-budget`、`task-rejections`、`task-nudge`、`grant-renewal` 五段给前端回放（`packages/web/test/state/recorded-deviation.test.ts`）。重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/deviation.test.ts packages/daemon/test/main/plan-change.test.ts packages/daemon/test/main/stall-renewal.test.ts`。维护者剧本里的通知都是一条输入一轮（只有催促以插话送达），录制的测试在用户每次动手前等维护者的输入都处理完（`task-flow.ts` 的 `inputsDone`），事件流的先后才固定。纯函数在 `test/tasks/plan-change.test.ts`、`test/tasks/thresholds.test.ts`（比值、催促、说法里的数字照阈值）。faux 模型每次调用按整个上下文报用量（一次一万 token 上下），写主切面时阶段预算的 token 要给足，否则"说明进展"的通知会多出一条输入。

## skill 库、MCP 登记与工具包（`skills/`、`mcp/`、`toolkit/`，27 号票）

规格第 20、21 节，ADR-0018。

- **skill 库**（`skills/library.ts`，`daemon.skills`）：框架自带的在 `packages/daemon/skills/`（第一阶段只有示例 `example-checklist`；测试可以经 `startDaemon({ builtinSkillsDir })` 换），用户导入的在数据目录的 skill 区 `skills/`，每个 skill 一个含 `SKILL.md` 的目录，名字和说明取 frontmatter 的 `name`、`description`（名字只能小写字母、数字、短横线，最长 64）。每次现扫，框架自带的在前、同名的以框架自带的为准。**不读 `~/.claude/skills`、`~/.pi`**。导入（`importFrom`，HTTP `POST HTTP_PATHS.skillImport`）：绝对路径、是目录、不在数据目录里、有合规的 frontmatter、库里不重名、不超过 2000 个文件或 20 MB；先复制到 skill 区里的临时目录再改名就位，符号链接不复制。
- **MCP 登记**（`mcp/registration.ts`）：数据目录配置区的 `config/mcp.json`（示例 `config/mcp.example.json`），每次现读，写错了一个都不用（界面上显示原因）。每个 MCP：`command`、`args`、`cwd`、`env`（值是字符串，或者 `{ "fromEnv": "变量名" }`：凭据从守护进程的环境里取，由 LSM 注入守护进程），`tools`：每个工具的中文名、类别标签、底线、参数规则、"只读或幂等"、要不要联网（不写按要联网）、做完告诉我、`outbound`，以及授权给秘书快速动作的 `quickAction: { title, args }`（快速动作的说法、固定的参数）。
- **MCP 服务进程**（`mcp/mcp.ts`、`mcp/client.ts`，`daemon.mcp`）：守护进程的子进程，不在 LSM 登记。按需拉起：会话装配时在后台拉起（拿服务进程报的参数说明），或者第一次调用时；登记改了下次用到时按新的重起；守护进程停止时一起结束。经闸门进程（`process/gated-spawn.ts` 的 `spawnGated`，和带类型的 bash 工具共用；闸门把守护进程写来的请求原样转给服务进程，`stdin: "forward"`）先放进 Job 对象再起服务进程，**每个 MCP 一个 Job**（句柄关闭即结束：守护进程被杀时随之结束；不放 agent 管家的 Job）。环境是系统变量白名单加登记里的变量（含凭据）。**注入的凭据值不出守护进程**（`mcp.ts` 的 `redactorOf`，按登记取注入的值，用守卫的 `redactSecretValues` 擦掉原样、URL 编码、base64 的写法）：服务进程的 stderr 和不是 JSON 的输出进守护进程日志之前、工具结果（含报错）交给 agent 和写进事件日志之前、服务进程报的工具说明给模型看之前都擦掉。客户端只实现 `initialize`、`tools/list`、`tools/call` 和取消通知（JSON-RPC 2.0，stdio 每行一个消息），单次调用的超时同 `agents.toolCallMinutes`。
- **会话里的 MCP 工具**：守护进程代为执行的工具，名字 `mcp__<MCP 名>__<工具名>`（协议包的 `mcpToolName`），只有工具包列了这个 MCP 才有，联网开关关着时没有要联网的那些；在守卫的工具注册表里（`daemon.ts` 把 `mcp.descriptors()` 交给守卫的工具注册表）按登记判（来源 `mcp`；登记交给守卫的那几样由 `registration.ts` 的 `guardFieldsOf` 统一取，秘书快速动作的关注也用它）。参数说明依次取登记里的 `inputSchema`、服务进程报的、宽松的 `{ type: "object" }`。
- **按工具包装配**（`maintainers/assembly.ts` 的 `toolkitParts`、`toolkitPiTools`）：skill 名单经 skill 库解析成目录，经宿主协议的 `skillPaths` 交给子进程（pi 的 `noSkills: true` 加 `additionalSkillPaths`，只加载这些）；有 skill 时工具白名单一定含 `read`；bash 开关决定 `bash` 和带类型的 bash 工具；MCP 工具见上。起草计划时没有 skill 和 MCP。子 agent 不拿 skill 和 MCP（20 号票的交集只取带类型的 bash 工具）。
- **执行时的工具包**（`tasks/execution.ts` 的 `effectiveToolkit(任务授权, 项目工具包)`）：skill 取并集（skill 不是权限：任务里加的 skill 只记在任务上，项目页的工具包不变），bash、联网、MCP 取交集。
- **联网开关关着时**：会话里没有要联网的 MCP 工具，也没有要联网的带类型 bash 工具（`typedShell.toolsFor` 按开关去掉推送、建远端仓库、装依赖；工具自己和守卫里的检查留作第二道）。
- **工具包一变就重新装配**（`conversation/agent-session.ts` 的 `reassemble(notice)`，宿主协议 10 的 `yield`）：忙时等它做完手头这一步（当前的工具调用结束、下一次模型调用之前）就停下、按新装配拉起、接着同一个会话，把"工具包已变更：……"作为一条输入交过去，原来那条输入接着算在处理中；闲着时停掉子进程；休眠时什么都不停，后两种情况"工具包已变更"跟在下一条输入后面。任务维护者在任务的工具包变了时调（`maintainers.ts` 的 `taskChanged`），项目维护者在项目的工具包变了（`RESHAPING_CHANGES` 加了 `toolkit_changed`）或执行中的任务换了计划时调（`toolkitMaybeChanged`）。范围审视（18 号票）在做时不换装配：闲着时的停子进程（`restartWhenIdle`）和按 yield 停下后的重新拉起（`resumeTurn` 的 `resume.restart`）都等审视兑现之后。重新装配后的那一次模型调用提示词前缀缓存失效（第一阶段的 deepseek-flash 不认会话中途的系统消息，pi 把更新后的系统提示放回开头、工具列表整份重发），这是规格接受的代价。
- **守卫用此刻的工具包**（`maintainers/assembly.ts` 的 `narrowedGuardAgent`，`AgentSession` 的 `guardNow`、守卫接入的 `GuardedSession.currentAgent`）：每次判定把拉起时的守卫视角收窄到现在的工具包（项目维护者取 `segmentToolkit`，任务维护者取 `taskToolkit`，子 agent 取 `execution.toolkitNow`）——去掉的 bash、联网、MCP 在子进程重新装配之前的下一次调用就被拒；正在等审批的调用被批准时也按此刻的重判（`askUser` 的 `replyNow`），硬拒绝就不执行。加上的要等重新装配、会话里有了才算。
- **工具包服务**（`toolkit/toolkit.ts`，`daemon.toolkits`）：
  - 用户直接改（`set_toolkit` 请求，`SetToolkitParams`：项目或任务、整份工具包；幂等键必填）：skill 要在库里、MCP 要登记了；项目要立项书已确认、没归档（`projects.changeToolkit`），任务要计划已确认、没结束（`execution.changeToolkit`：现在生效的计划换一版，只改工具包，不出计划变更卡）。有计划变更卡在等时照样能收窄，扩大（`toolkitExpansions` 不为空）要等卡处理完；之后确认这张卡时，卡上的计划补上用户在这期间的增减（基础版本只差工具包时才这样认），作为最新的一版生效（`pendingChange`、`confirmPlanChange`）。扩大和减少都直接生效，时间线记一笔（种类 `toolkit`），审批决定事件 `toolkit_decided`（守护进程内部的 `toolkits` 频道，`decision: "edited"`）。
  - 维护者增减 skill（`adjust_skills`，执行时和项目维护者的对话段都有）：只能从库里选，写进工具包、记进时间线，这次调用结束后重新装配。项目的任务里加的 skill 只记在任务上（执行时 skill 取并集）；去掉的 skill 只影响它所在那一层，项目工具包里也有的照样在（工具结果里写明）。
  - 名字的检查（`toolkits.nameProblems`：skill 要在库里、MCP 要登记了）：改工具包、提交计划（`TaskServiceOptions.toolkitProblems`）、自行调整计划和计划变更（执行控制器的 `toolkitProblems`）都查，不在就拒绝并说明。
  - 项目维护者不在任务里时申请（`request_toolkit_change`）：减少的直接生效；开 bash、加 MCP、开联网出一张"工具包变更"卡（`toolkit_change`，`ToolkitChangeCardPayload`）进待我处理，每个项目同时只有一张在等。批准时按**现在的**工具包加上要加的能力，拒绝则不变；两种都通知维护者、都是审批决定。任务里要加能力走 14 号票的计划变更（`PLAN_CHANGE_KINDS.toolkit` 的说法是"工具包变更：加上 ……"；加 skill 不算扩大）。
  - 素材：`toolkit/material-source.ts` 的 `toolkitDecisionSource`（`approval_decision`，情境 `decision:<决定>`、`card:toolkit_change` 或 `toolkit:edited`），彻底删除只换掉用户写的话（`toolkitDecisionPurge`）。
- **说法**：给模型和人看的话都在 `toolkit/texts.ts`，工具名用常量插值（`toolkit/tool-names.ts`、`EXECUTION_TOOL`）。
- **秘书的快速动作"调用 MCP 工具"**（`mcp/quick-action.ts`，类型 `mcp_call`，参数 `{ tool: "<MCP 名>/<工具名>" }`）：只能选登记里写了 `quickAction` 的工具，参数按登记固定。用户这一轮的原话里原样有登记写的快速动作说法才算点明，直接执行；否则动作作为伪工具调用按这个工具登记的类别判（执行器的 `watchFor`）。执行是异步的（快速动作的执行器二选一，类型上分开：当场做完的 `SyncQuickActionExecutor.execute`，要等外面回话的 `AsyncQuickActionExecutor.perform`，`isAsyncQuickAction` 区分）：点明直接执行的等结果回来才出"已执行"卡；在卡上确认的，卡先记成已处理（"正在执行……"），结果回来后补上卡片和操作记录（没做成的照样记，`ok: false`）。不拉起 agent。
- **HTTP**：`GET HTTP_PATHS.toolkitCatalog`（`ToolkitCatalog`：skill 库、登记的 MCP、登记读不了的原因），`POST HTTP_PATHS.skillImport`。
- **Web**：项目页（立项书确认后）和任务详情的"工具包"一栏是 `pages/ToolkitEditor.tsx` 的 `ToolkitPanel`（取工具包目录，改一下发一次 `set_toolkit`，项目、任务随后在各自的频道推来）；原型数据的还是原型的 `ToolkitEditor`。设置里的 skill 库页（`pages/more/SkillsPage.tsx`）走 HTTP 列出和导入，顺带列出登记的 MCP。"工具包变更"卡是 `ui/cards/cards.tsx` 的 `ToolkitChangeCard`。
- **测试**：pi 契约 `test/contract/toolkit.contract.test.ts`（按工具包装配、临时 HOME 里的 `~/.claude/skills`、`~/.pi` 不出现、`yield` 后换工具包接着会话）；单元 `test/toolkit/library-registration.test.ts`（skill 库、MCP 登记、登记进守卫的工具注册表）；主切面 `test/main/toolkit.test.ts`（含凭据不出守护进程、守卫用此刻的工具包、有计划变更卡在等时收窄、名字的检查、任务里加 skill 不动项目工具包；假的 MCP 服务 `test/fixtures/fake-mcp-server.mjs`，随测试起停，底座 `test/helpers/toolkit.ts`：`writeMcpRegistration`、`mcpLog`、`writeSkill`、`seedToolkitProject`；凭据经 `startTestDaemon({ env })` 注入）；前端回放 `packages/web/test/state/recorded-toolkit.test.ts`（录制 `toolkit-change`）；范围审视在做时不换装配在 `test/main/scope-review.test.ts`。

## 项目与项目档案（`projects/`，15 号票）

规格第 11 节。`createProjectService` 管项目的业务状态（项目列表频道上的 `project` 事件，派生视图 `projects/views.ts`），`createProjectMaintainers` 管项目维护者的会话（`AgentSession`），`deletion.ts` 管删除。

- **立项的三个入口**，都落到"点了立项，项目以筹备中诞生"：
  - 秘书的"建议立项"工具（`SUGGEST_PROJECT_TOOL`，`projects/tools.ts`，和任务工具一起给秘书）只出一张"建议立项"卡（名字、一句话目标）。用户在消息里明说要立项时秘书直接收口出卡；用户点"新建项目"（`new_project` 请求，`{ request }`）时守护进程往秘书会话里放一条通知，写明不判断是不是项目、直接出卡。卡上点"立项"（`kickoff`）→ 建出 `p-N`、维护者 `pm-N`，同一事务里项目事件、维护者会话里一条说明（给用户看，不交给维护者）、给秘书的通知；和没删掉的项目（含已归档的）重名的被拒。"不用了"是回避信号（08 号票的卡片关闭素材）。
  - 任务转为项目（`convert_task_to_project`，`{ taskId, name }` → `{ projectId }`）：项目名由用户定（界面预填任务标题），重名时被拒（`conflict`，"已经有叫「X」的项目了：换个名字"）。不新建维护者，项目的维护者就是原任务的维护者；同一事务里任务以 `done` + `endKind: "converted_to_project"` 结束（看板的最近结束分组，"已完成 · 已转为项目"）、项目建出（`origin: "task"`、`fromTaskId`，一句话目标取任务书里的目标）、给维护者一条带 `projectId` 的通知。任务模块的维护者（`maintainers/`）把它让出来（`excluded` + `release`），项目维护者模块在同一个会话目录里接着（`continueSession`，见下面"运行时"）。只有由自己的维护者执行的任务能转（共享协议包的 `hasOwnMaintainer`，任务自己的维护者编号是 `ownMaintainerId(taskId)`）。
- **立项问答和立项书**：项目维护者的系统提示（`projects/system-prompt.ts`，工具名一律插值）说明项目档案的布局、工作目录、围栏和历史区，筹备中时要它像 grill-with-docs 那样问，最后用"提交立项书"（`SUBMIT_CHARTER_TOOL`）交出立项书（`Charter`：目标、范围、首版、项目类型、是否绑定外部工作目录及其路径）和提议的工具包。检查不过的原因交回维护者：不是筹备中、已经确认过（确认后不能再交：项目类型、外部路径绑定以后要改，归后续的票）、其他类绑定外部路径、外部路径不是绝对路径，或者按真实路径（展开符号链接、目录联接、8.3 短名）看它在数据目录、程序目录里，或者数据目录、程序目录在它里面（两个方向都拒，围栏不能盖住它们）。开发类没写 bash 时默认带。交上来的一版落 `charter_submitted`，建立项书卡（不卡任务，进待我处理），上一版还没处理的卡过期。
- **立项书卡**：`confirm_start`（确认并开工）和 `confirm_later`（只确认，稍后开工；说法都取共享协议包的 `CHARTER_DECISION_LABEL`）。两个都让项目类型、工作目录（`workdir: { external, path? }`）和工具包立即生效（项目事件 + `charter_decided`，同一事务）；开工的同时建出首个建设任务（`origin: "project_build"`、`projects: [项目名]`、`projectIds: [项目编号]`、执行的维护者就是项目的维护者，规划中，看板上；说明里不写立项书正文，只说见项目档案里的立项书），项目转建设中，`Project.buildTaskId` 记着它；16 号票起同一事务派一张起草计划的工单给项目的维护者（工单的内容是一份指向立项书的任务书，见下面"工单与派单"）。之后维护者会话里一条说明，维护者按新的装配重新拉起（工作目录、围栏、bash）。
- **项目档案**（`projects/records.ts` 的 `projectRecordsPaths`）：数据目录 `projects/<项目编号>/` 下的立项书 `charter.md`、规格 `spec.md`、术语表 `glossary.md`、决策记录 `adr/`、进展 `progress.md`、项目清单 `manifest.md`、范围记录 `scope-records.md`、外部工作目录的绑定 `binding.json`、历史区 `.history/`、默认工作目录 `workdir/`；维护者会话在会话区（`sessions/<维护者>`）。立项时建好（已有的不覆盖），确认立项书时写立项书和绑定（旧的先留进历史区）。随数据目录备份；外部工作目录不在数据目录里，不随二狗备份（11 号票：恢复后按 `binding.json` 认回来）。
- **自动留旧版本**：守卫接入运行时的 `autoVersioning`（`daemon.ts` 里接 `records.ts` 的 `isAutoVersioned` 和 `preserveVersions`）。只覆盖项目档案，**不含工作目录**（默认的 `workdir/` 也不含：工作目录靠 git 提交或备份，照 v1 模板；也免得 `rm -rf node_modules` 整树同步复制）**和历史区自己**。放行一次调用之前，判定里这次要删除或整体重写的路径（守卫的 `replacedPaths`，和 v1 模板认的是同一份 `pathReplacement`）落在这里的，先把旧的复制进那个项目的 `.history/<时间>/`（保持相对路径，同一时刻另起一格；不跟符号链接）。复制失败就不执行这次调用。守卫事实里只对这些路径传 `backedUp: true`（写的路径和它的真实路径都在这里才算）。**历史区只由运行时写**：守卫把任何项目的 `.history/` 当受保护区域，任何 agent 用任何方式写入或删除都是永不，删除包含它的目录（整个项目档案）也是。
- **项目状态机**：`PROJECT_ACTION_RULES`（共享协议包）是"哪个状态能做哪个动作、到哪个状态、记成什么变化"的唯一一份：`projectActions(project, 首个建设任务的状态)` 给出现在能做的，`projectActionTarget(project, action)` 给出到哪个状态、记成什么变化、归档前的状态（取消归档没记下归档前的状态时回到筹备中）；守护进程和原型的假连接都用它。`project_action` 请求（`{ projectId, action }`）带幂等键，同一个键重发拿到同一个结果。**项目还有正在做或排队的工单时不能归档**（16 号票评审后用户定：放弃、归档都算，`ARCHIVING_ACTIONS`；被拒的说法是共享协议包的 `archiveBlockedText`，写明先完成或取消哪几个任务，项目页上这两个按钮同样不能点、写着这句）。重置维护者不在项目状态机里，是单独的 `reset_maintainer` 请求（见下面"工单与派单"）。首个建设任务（`buildTaskId`）以 `done`（不是转为项目）结束时，项目自动由建设中进入使用中（`by: "system"`，守护进程重启时补做）：13 号票起"任务完成"只走执行控制器的 `onCompleted` 回调，`daemon.ts` 把它接到 `projects.taskCompleted(task)`，项目模块不再监听看板上的 `task` 事件（端到端见 `work-orders.test.ts` 的"项目的首个建设任务（端到端）"：项目维护者经提交计划和执行工具走完）；别的任务的变化不改项目状态。首个建设任务失败或取消了，可以再开工（`start_build`，新任务接替成为首个建设任务）。
- **任务涉及的项目**：任务上除了项目名 `projects`，还记着项目编号 `projectIds`（点"发起任务"时按项目列表认，计划提交时按计划里写的项目名认；`createTaskService({ projects: { check, idsOf } })`）。项目列表按编号数进行中的任务（同名的项目删掉之后再立，旧任务不算到新项目头上）。
- **已归档的**：维护者会话只读（`send_message` 被拒，说明要先取消归档；会话里的消息范围 `messageScope` 由项目模块给出），"发起任务"选它被拒（`checkTaskProjects`：选的项目要在项目列表里、没归档）。
- **删除**（`deletion.ts`，ADR-0010）：`delete` 只能从已归档发起，不马上删，往待我处理放一条 `project_delete` 通知（`确认删除` / `不删了`，`data: { projectId }`，取项目编号用共享协议包的 `inboxItemProjectId`；同一个项目已有没处理的就用它）。点了确认删除：
  1. 先停维护者（`suspend`：马上不再接输入、之后来的也不唤起，等子进程退出）；
  2. 复查：期间用户取消了归档就整个中止，什么都不删，维护者恢复成能唤起（`resume`）；
  3. 同一事务追加 `deleted`，并改写属于项目的事件（`appendBatch` 的 `purge`，和彻底删除同一个口子：行和序号留着，派生视图整体重放，原文不留）：维护者会话频道上的事件整条换成"已删除"标记；立项书正文（`charters` 频道的事件、立项书卡的每个版本）、这个维护者的审批（请求、审批卡、决定）和效果日志（56 号票起还有按调用 id 找到的属于项目的调用的效果：子 agent、评审子 agent 的）、待我处理里属于项目的事项，用彻底删除的改写函数表按事件类型字段级改写（原话换成删除标记，状态不变），改写过的卡片追加一个新版本；
  4. 最后删项目档案目录和会话区里的会话文件（`removeSession`）。
  前端靠项目列表频道上那条 `deleted` 把项目和会话从界面上拿掉。**素材不删**：用户在维护者会话里说过的话按 08 号票的原文副本留在素材库里（`test/main/projects.test.ts` 有断言）。
- **项目的维护者**（`projects/maintainers.ts`）：直接用 `AgentSession`，会话频道 `maintainer:<维护者>`；16 号票起按当前这一段会话装配（见下面"工单与派单"的"装配"），消息的范围是当前这一段的（项目，做工单时还有任务）。守卫看到的是 `kind: "maintainer"`、工作目录是真实路径的工作目录、`projectRecords` 是项目档案、`workingDirs` 是工作目录，联网按这一段的工具包。立项书确认（工作目录、工具包变了）时项目模块建好工作目录（开发类、用二狗给的默认工作目录的同时 `git init`：子 agent 并行时各用一个 git worktree；用户绑定的外部目录不动），子进程按旧的装配拉起的，交下一条输入之前停掉、按新的装配重新拉起（`outdated`）；第 n 次唤起的计数跨重新拉起累计。
- **接线**：任务模块要核对项目名（项目模块建在它之后）、项目模块删除时要停维护者（项目维护者模块建在它之后）、任务模块、项目模块、执行控制器和提问卡都要派单器（16 号票，它建在执行控制器之后）：`daemon.ts` 里只有一个后接接线点 `wiring`，各方先拿转手的对象，模块都建好之后一起填上。派单器要的执行控制器在它之前就建好了，直接放进 `createWorkOrders` 的参数（没有第二个后接的口子）。

## 工单与派单、项目维护者的会话分段（`work-orders/`，16 号票）

规格第 11、12 节，ADR-0012。只涉及一个项目的任务由这个项目的维护者起草计划并执行，不新建任务自己的维护者（`Task.maintainerId` 就是项目的维护者，`hasOwnMaintainer(task)` 为假）：点"发起任务"时只选了一个项目的；秘书建任务卡（`create_task`）、出建议卡（`suggest_task`，卡片版本 2）时写了一个项目的（任务模块的 `buildCreate` 按涉及的项目定执行的维护者，不在项目列表里、已归档的拒绝并说明）；建卡时没写、**第一版任务书只涉及一个项目**的（任务自己的维护者还没接过任何输入：任务书交出时改由这个项目的维护者起草，看板上的任务事件 `handed_to_project`，状态不变；之后的任务书不再换）；项目的首个建设任务。**"任务属于哪个项目"只有 `ProjectService.projectOf(task)` 一处**（由项目的维护者执行、项目没删掉的），任务模块、执行控制器、子 agent 模块、派单器、项目维护者模块都经它；"某个维护者维护的、没删掉的项目"是 `maintainedBy(maintainerId)`。派单器 `createWorkOrders`（`daemon.workOrders`）管工单和项目维护者的会话分段：派单队列在 `work-orders.ts`，会话分段在 `segments.ts`，等澄清的一次往返在 `clarifications.ts`，说法在 `texts.ts`。

- **工单**（项目列表频道上的 `work_order` 事件，派生视图 `work-orders/views.ts`，名字和纯函数在共享协议包 `work-orders.ts`、schema 在 `work-order-schema.ts`）：`wo-N`，注明收件项目和维护者、来源（本票只有 `user_task`，"你"）、所属任务、种类（`plan` 起草计划 / `execute` 执行）、内容（`instructions`：起草计划的是任务书，打回时是打回意见加任务书）。状态 `pending`（待接）→ `in_progress` ⇄ `clarifying`（等澄清，`questionsCardId`）→ `ended`（`outcome`：`done` 完成、`returned` 退回、`unable` 做不了，`reason`），每次迁移一条事件（`change`：created / updated / started / clarifying / answered / ended）。
  - 派出：秘书写任务书（`writeBrief`）、用户打回计划（`rejectFromCard`）、项目开工建出首个建设任务时派一张起草计划的工单（`dispatchPlan`，和引起它的事件同一事务；维护者正在起草就作为通知交给它，还排着就换成新内容）；任务进排队中（确认了计划、重试、返工）的那一下还没有执行工单就派一张执行工单（`admit` 时也补）。
  - 一次只做一件、先来先做：维护者"空着"是手上没有进行中（含等澄清）的工单、也没有在进行或收尾中的会话段。空着时队首（先派出、现在能开始的：起草计划的要任务在规划中，执行的要任务在排队中，定时作业的运行要有全局执行名额，19 号票）开始：起草计划的由派单器开始（工单开始、开一段会话、分隔线、一条开始的通知，同一事务）；执行的交给执行控制器——全局名额也有空时，执行控制器问 `admit(task)`，工单开始、开一段会话和任务进入执行中同一事务。项目正忙时任务留在排队中，看板上标"等项目 X"——只在真被项目挡住时标（前端的 `taskWaitingForProject`：任务有一张排着的、它正等着的工单——起草计划的任务还在规划中，执行的在排队中——而项目的维护者手上有别的工单）；全局执行名额满了、任务暂停了都不标。工单结束（段结束）后看下一张（`execution.kick()`）。
  - 结束：起草计划的在计划交了（任务离开规划中）时、执行的在任务完成 / 失败 / 取消时**先让这一段收尾**，写回之后（或者催写回到了次数，见下面）工单才以对应的结局结束；任务结束时还排着的工单退回。
  - 已归档：派出时就以"退回"结束（同一事务，附原因 `archivedReason`），维护者不被唤起——秘书写任务书、用户确认计划、重试、返工之后派的都是；`admit` 也先看项目归档了没有，归档了不开始、不补派（任务留在排队中，取消归档时执行控制器 `kick()` 一次，排着的接着做）。**还有正在做或排队的工单时项目不能归档**（项目模块的 `act` 问 `workOrders.openOf(projectId)`），所以归档时没有要退回的。已停用的照常接单。
- **会话分段**（`segments.ts`；维护者会话频道上的 `segment` 事件：`MaintainerSegment`，`segmentId` 是 `<维护者>-sN`）：每段一个新的 pi 会话，名字就是段号（宿主协议的 `session`，接哪个由当前这一段明确指定；会话文件叫什么只有子进程认）。工单段在工单开始时开；对话段在维护者手上没有进行中的段时用户直接说话开（网关的 `messagePrelude`：段和分隔线排在用户这句话之前、同一事务，重发按幂等键不多开），或者运行时给了它一条不属于任务的通知时开。第一段对话段（`continueEarlier`，重置开的不算）这个名字的会话还没有时接着这个维护者以前的会话（任务转为项目、16 号票之前就有的项目）：拉起时带 `continueSession: true`，子进程在 `ready` 里报回接的是哪个，项目维护者模块（`AgentSession` 的 `onReady`）经 `recordSession` 记进这一段（`segment` 事件的 `session` 变化），之后拉起都按它打开；之后每段一个新的。没有在进行的段时不会拉起（`accepts` 只认当前段的输入）；万一拉起也是新会话（`continueSession: false`），不去猜接哪个。每段开头追加一条带工单分隔 part（`work_order_divider`，对话段的 `workOrderId` 是空串）的系统消息。
  - 段的状态 `open` → `closing`（该结束了）→ `closed`。收尾：进展 `progress.md` 的内容哈希和这段开始时一样、或者维护者没用 `write_segment_summary` 写摘要，就催它（`segment-nudge:<段>:<n>` 通知，起草计划的段说法照只读的那一套：进展用 `write_progress` 写回）；写回之后段结束、工单随之结束。一条输入都没处理过的段（刚开就该结束了）不用写回。**催写回到了次数还没写回，转为用户拍板**（规格第 12 节，同第 8 节的催促阈值：取配置的 `tasks.thresholds.nudges`，默认 3，14 号票）：待我处理里一条不卡任务的"卡住求助"（`stuck_help`，动作 `WRITE_BACK_HELP_ACK`"知道了"，数据里是项目、维护者、段、工单，不记任务编号——任务的"卡住求助"那一套按任务编号认事项），会话里一条说明，这一段以 `unwritten: "nudged"` 结束，工单照常以原来的结局结束、同样标着，时间线上记一笔（`write_back_missing`），项目的队列接着走。工单段收尾时它的任务已经离开了执行中（计划交了是待确认，本来就在看板的"等我"组；执行的已完成、失败或取消），状态机不许从这些状态转等我，所以任务状态不改。对话段在维护者闲置退出（`onIdleExit`）或有工单在等时收尾。**范围审视**（18 号票）：工单段结束之前——写回检查通过之后，或者催写回到了次数转用户拍板时——`segments.ts` 的 `checkClosing` 先经 `reviewScope`（项目维护者模块的 `reviewScope(segment)`，`daemon.ts` 接线）让维护者的子进程审视这一段（异步：审视完了再走一遍 `checkClosing`；审视期间维护者又处理起这一段的输入，这次的结果不用，这一轮结束后收尾时重新审视），结果事件（范围记录、时间线记录、越界通知；没做成的是会话里一条说明）放进 `close(segment, { extra })`，和段、工单的结束同一事务。对话段不在结束时审视（压缩时照样审视）；重置维护者时直接结束的段不审视。见下面"范围审视"。
  - 维护者现在处理哪条输入（`accepts`）：用户直接说的话总作为插话进当前段；运行时交给它的、属于某个任务的，只在做这个任务的工单段里处理（任务要能 `work`；收尾中不看任务状态），别的留在队里；没有任务的总处理。
  - 重置维护者（项目页上单独的 `reset_maintainer` 请求 `{ projectId }` → `{ projectId, segmentId }`，带幂等键；项目状态不变，已归档的不能，`canResetMaintainer`）：当前这段直接结束（不催写回），新开一段（`reset: true`，进行中的工单在新的一段接着做），固定上下文里没有上一段的摘要；旧会话原样留着，会话频道里的旧消息照样在。**写回中途重置的**（段在收尾中）：这张工单照常算完成（规格第 12 节，2026-10-08 用户定），段和工单都标 `unwritten: "reset"`，时间线上记一笔"重置时这段没写回档案"（`WRITE_BACK_GAP_LABEL`；项目页工单流水线上的状态 `workOrderStatusText` 同样写出来）；处理过输入、没写回就被重置的进行中的段同样标。工单段里干过活、还没做范围审视就被重置的，时间线上另记一笔"重置时这段没做范围审视"（18 号票，见下面"范围审视"）。
- **固定上下文**（`work-orders/fixed-context.ts`，拼在项目维护者的系统提示后面，每次拉起现算）：工具包说明和这段能用的工具、内置的项目规范说明（`PROJECT_STANDARD`）、项目档案快照（规格、进展、术语表，每份最多 3000 字）、上一段的摘要（重置的段、第一段没有）、这次的工单（对话段没有；起草计划的工单写明这一段只读、进展用 `write_progress`）。执行的工单段另有重注入块（执行控制器的 `contextBlock`）。工具名一律插值（`TOOL`、`WORK_ORDER_TOOL`、`SUBMIT_PLAN_TOOL`）。
- **装配**（`projects/maintainers.ts`）：
  - 对话段（含立项问答）：`read`、`write`、`edit`、`ls`，工具包按项目的（立项书确认前不带 bash、不联网，带 bash 时加 `bash` 和带类型的 bash 工具），"提交立项书"、`write_segment_summary`；守卫的段是 `<维护者>:<segmentId>`。
  - 起草计划的工单段：**只读**，和任务自己的维护者起草计划时一样（`PLANNING_PI_TOOLS`：`read`、`ls`），不带 bash、不联网，`submit_plan`、`write_progress`（写回进展：整份换掉 `progress.md`，旧版本先留进历史区，`ProjectService.writeProgress`）、`ask_clarification`、`write_segment_summary`；工作目录和项目档案别的文件都写不了（写回要的只有进展文档和段摘要）；调用不属于任务。
  - 执行的工单段：**和任务自己的维护者执行时是同一套装配**（`maintainers/assembly.ts` 的 `executionSetup`：`EXECUTION_PI_TOOLS`、阶段的工具、子 agent 模块给的"提议并行"、带类型的 bash 工具，守卫看到任务、段是 `<维护者>:<任务>`，重注入块；27 号票改执行时的工具包只改这一处），差异由调用方给：**工具包是任务授权和项目工具包的交集**（`effectiveToolkit`：skill、MCP 取交集，bash、联网都开才开；验收脚本的联网同样取交集）、围栏多了项目档案、开发类按项目类型、另加 `ask_clarification` 和 `write_segment_summary`。任务变了换上最新的重注入块，暂停、取消时中止手头这一轮（`followExecutingTask`，两边共用）。守卫看到的工具清单两边都由 `maintainerGuardAgent` 按真正装配给 pi 的算（`assembledPiTools`）。
  - 装配每次唤起算一次（`assemble`：拉起参数、代为执行的工具、守卫都取这一份）。`assemblyOf(taskId)` 给子 agent 收窄用的 `MaintainerAssembly`（20 号票，见上面"子 agent 并行"）。
- **执行控制器**（`tasks/execution.ts`）的 `projectTasks: { of(task), admit(task) }`（`of` 就是 `ProjectService.projectOf` 加上项目的工作目录和工具包 `projectToolkit`）：项目的任务在项目的工作目录里做（`workDir(taskId)`、验收脚本的工作目录、`onCompleted` 交付件的位置），交给维护者的话带上项目（`MessageScope`），进入执行中要 `admit`；`kick()`、`awaitAnswer(taskId, cardId)`（等澄清：这一支停下，原因 `clarification`，都在等时任务转等我）、`answered(cardId)`。
- **等澄清**（一次往返都在 `clarifications.ts`）：维护者用 `ask_clarification` 出提问卡（`QuestionsCardPayload.askedBy`，卡片类型 `questions` 版本 2），进待我处理（挡着任务），工单转等澄清；执行中的这一支停下。用户回答（`questions_answered` 带 `projectId`，"澄清问题的回答"素材属于任务和项目）后，提问卡（`tasks/cards.ts` 的 `questionsCardType(workOrderReply)`）把交回维护者的通知交给派单器的 `clarificationReply` 给（不交给秘书，和卡片的处理同一事务），工单回到进行中、任务回到执行中（名额满了回到排队中）。**关掉提问卡算"按你自己的理解接着做"**（16 号票评审后保留）：工单同样回到进行中，通知维护者，时间线上记一笔（`own_judgement`）。等澄清的工单仍占着维护者。
- **消息的归属**：项目维护者会话里的消息带当前这一段的项目，工单段里的还有任务和当时的阶段（`scopeIn`：任务那部分取 `tasks/stages.ts` 的 `taskMessageScope`，25 号票；执行控制器交给维护者的话同样在 `taskMessageScope` 之外加上项目）。时间线的全局层按工单分隔 part 给项目维护者会话聚块（25 号票）。
- **token 记账**（24 号票的账本，不另数）：项目维护者的用量按正在处理（或刚处理完）的那条输入记——工单段里交给它的输入带着任务，记在任务名下、任务当时的阶段（账本的 `currentStage`，和守卫一致）；对话段、和用户直接对话记在项目名下。工单结束时的范围审视（18 号票，在回合之后）记在刚处理完的那条输入所属的任务名下。主切面在 `token-ledger.test.ts` 的"范围审视和压缩的用量"。
- **删除项目**：项目的工单的内容（`instructions`）一起改写（`work-orders/purge.ts` 登记了 `work_order` 的改写函数）；段的事件在维护者会话频道上，随整条会话换成标记。
- 主切面在 `test/main/work-orders.test.ts`（录了 `work-orders-queue`：两个任务排进同一项目，重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/work-orders.test.ts -t 连发两个`；评审后加了秘书发起的单项目任务、写回中途重置、催写回到了次数、关掉提问卡、不能归档、已归档退回的用例），`projects.test.ts` 的立项问答、开工之后都按会话分段走（剧本里写回进展、写摘要；起草计划的段用 `write_progress`）。测试里要维护者"正说着"时做点什么，用 `startTestDaemon` 的 `maintainerTokensPerSecond`。

## 范围审视（`scope-review/`、`runtime/agent-child/scope-review.ts`、`conversation/scope-reviews.ts`，18 号票）

规格第 10 节和第 12 节"范围审视的细则"。范围审视是软约束（和守卫是两道独立的闸）：不拦任何工具调用，也不暂停维护者；维护者做了范围外的事会被发现、记下来。

- **审视在维护者自己的子进程里另开一次模型调用**（守护进程不跑模型）：装配参数 `scopeReview` 里有审视用的模型（`daemon.ts` 的 `SCOPE_REVIEW_MODEL`，第一阶段也是 `deepseek/deepseek-flash`，思考档位 `high`；测试经 `startDaemon` 的 `scopeReviewModel(维护者, 第几次唤起)` 换成 faux）、审视的说明（`scope-review/texts.ts` 的 `SCOPE_REVIEW_INSTRUCTIONS`，照秘书压缩指令的先例写在守护进程一侧、经装配交过去）、对照物和近期范围记录。子进程的 `ScopeReviewer` 用 `modelRuntime.completeSimple`（不进会话；审视的模型是 faux 时注册成另一个 provider `faux-review`，和会话的各按各的剧本），系统提示就是装配里的审视说明，输入是 `<scope-reference>` 对照物加 `<work-log>` 这段对话（pi 压缩时的写法：`convertToLlm` + `serializeConversation`；上次压缩的摘要、重注入块、看板变化不算），要模型只回 `{"records":[{"kind","summary","detail?","basis?"}]}`（`parseFindings`：去掉围栏、按括号配对取第一个对象；取不出就报 `error`、不记）。用量另报一条 `usage`（`purpose: "scope_review"`，和会话里的回复、压缩共用 `event-translator.ts` 的 `usageReport`），agent 管家记账时的模型取 `scopeReview.model`；归属照 `AgentSession` 的规矩，记在刚处理完的那条输入所属的名下（工单段是任务）。结果 `appendEntry` 进会话（`SCOPE_REVIEW_ENTRY`，副本），同时以 `scope_review_result` 报给守护进程，带上会话里交给它的输入（`inputIds`，输入标记里的 id）。
- **两个时点**：
  - 压缩会话时：`session_before_compact` 里审视要压缩掉的消息（`messagesToSummarize` 加上被切开那一轮的前半），不改压缩本身；结果没有 `requestId`，交给 `scopeReview.onCompactionReview`，维护者模块存（`ScopeReview.save`，归属是这时的这一段或任务）。项目维护者、任务自己的维护者都有；
  - 每张工单结束时（只有项目维护者的工单段，写回之后，催写回到了次数转用户拍板时也审；对话段只在压缩时审）：见上面"工单与派单"的收尾。派单器经项目维护者模块的 `reviewScope(segment)`（归属取传进来的这一段）调 `AgentSession.reviewScope(timeoutMs)`，会话这一侧的协调都在 `SessionScopeReviews`：送 `scope_review`（先送最新的对照物）；没有子进程（闲置退出了、守护进程重启后接着收尾）就按当前这一段的装配拉起一个（接着同一个会话）再送；结果回来、子进程中途退出、超时（配置的单次模型调用超时加 30 秒，测试经 `scopeReviewTimeoutMs` 改小）、会话停下都兑现（后几种带 `error`，都用宿主协议的 `failedScopeReview`）。子进程审视时排在后面的命令（含闲置退出的 `exit`）等它；送出去到结果回来之间拿着 agent 管家的 `holdAwake`（审视比 15 秒的退出宽限还久时也不会被杀），会话也不换装配、不改写会话文件。审视的是会话里还没审视过的部分：上次压缩留下的消息和之后的（压缩掉的那些压缩时审视过了）。
- **审视没做成**（回复不是约定的 JSON、模型出错、超时、子进程中途退出）：不卡工单，照常结束；维护者会话里一条说明（`reviewFailedNote`，给用户看，不交给维护者）、日志里一行，不记范围记录。
- **重置维护者时**（`work-orders/segments.ts` 的 `reset`）：工单段里干过活、还没审视就结束的（工单做到一半、写回中途、审视做到一半——那次的结果回来时这一段已经不在了，不用），不强行审视，时间线上如实记一笔（种类 `scope_review_missing`"没做范围审视"，摘要"重置时这段没做范围审视"，`work-orders/texts.ts` 的 `unreviewedRecord`，写法同"重置时这段没写回档案"）。对话段本来就只在压缩时审，重置时不记。
- **对照物**（`ScopeReview.context`，`texts.ts` 的 `referenceText`）：立项书（项目档案的 `charter.md`，最多 4000 字）；属于任务的另有任务书（目标、验收标准、约束）和现在生效的计划（确认过的；还没确认过的用最新交上去的那版：阶段和交付件、授权项——授权行用协议包的 `grantText`——、工具包、用户说过的限制——原话连同编译出的时序规则和授权收窄、假设）；用户在审批卡上批准过的调用（这个维护者的最近 20 条，`approvals/views.ts` 的审批表：工具的中文名和参数摘要；批准过的算授权过）；用户在这个维护者会话里直接说的话（最近 20 条，`conversation/views.ts` 的 `recentMessagesOf`）。拉起时进装配，交每条输入之前、要审视时现算，和子进程手里的不一样就先送 `scope_context`。`context` 另给出对照物里的用户原话从哪来（`sources`：那几条消息、那几次批准的 id，不送给子进程）。
- **近期范围记录**：这个维护者最近 5 条（`RECENT_SCOPE_RECORDS`，派生视图 `scope_records` 按维护者取，越早的在前），`recentRecordsText` 写成以"## 近期范围记录"（`texts.ts` 的 `RECENT_SCOPE_RECORDS_TITLE`）为标题的一段；子进程的 `before_agent_start` 每条输入之前拼到系统提示末尾（每次在原来的系统提示上拼，不叠加；没有记录不拼）。新的一段会话（新的子进程）从装配里拿到，所以换了工单分段、旧段的 appendEntry 不在上下文里时也有。
- **存**（`ScopeReview.recordEvents` / `save`）：每条发现一条 `scope_record`（归属 `ScopeOwnership`：项目维护者的带项目，工单段里还有任务和工单，在 `projects` 频道；任务自己的维护者的带任务，在 `board` 频道——落在哪个频道由协议包的 `scopeRecordChannel` 定，前端共用；归属由 `ownershipOf` 拼，两个维护者模块共用），记上 `sources`（对照物里的消息和批准，加上会话里交给维护者的输入 `inputIds`）；维护者会话频道上一条 `timeline_record`（种类就是 `scope_change` / `out_of_scope`，摘要、说明和依据，带工单和归属，幂等键 `scopeTimelineKey`），越界另在待我处理放一条通知（`out_of_scope`，`non_blocking`，动作 `OUT_OF_SCOPE_ACK`"知道了"，数据 `OutOfScopeNoticeData`：记录号加归属）——**不调 `inbox.alert`（不推送）**，照常算未读（待我处理的小红点亮起）。越界通知上不做"算范围变更"。
- **文件是投影**：项目维护者的记进项目档案的 `scope-records.md`，不属于项目的任务的记进任务产出区的 `outputs/<任务>/scope-records.md`（没有就建，带个开头）。`createScopeReview().start()` 订阅 `scope_record` 事件：文件里还没有这条就添上（`recordFileEntry`：时间 · 种类 · 哪次审视 · 工单和任务：摘要（依据）`<!-- sr-… -->`，说明另起一行），已经有了（同一个记录号）就换成现在的样子（彻底删除追加的新版本）；启动时把没写进文件、没换掉的补上。范围变更和越界都记（种类写明）；项目删掉了不写。以事件为准，维护者写坏了文件也不影响项目页、近期范围记录。
- **彻底删除**（规格第 12 节"范围记录里引用的用户原话随彻底删除一起改写"）：审视的模型可能原样引用户的话，也可能转述，不去辨认——范围记录上记着这次审视看到的用户原话从哪来（`sources`），`scope-review/purge.ts` 的 `scopeRecordQuotes` 登记成"引用"（`PurgeRewriters.registerQuotes`）：彻底删除维护者会话里的一条消息、审批卡上的一次批准时，记着它的范围记录一起改写（`scopeRecordPurge`：摘要、说明、依据换成删除标记，种类、哪次审视、归属、来源不变），连带它的时间线记录（按幂等键找，`timelineRecordPurge`）和越界通知的每个版本（`inboxItemPurge`）；改写后追加一条新版本（`newVersion`），前端换掉手里的记录，派生视图换内容（先后不变），项目档案里的文件换掉那一条。会话文件里审视结果的副本按 ADR-0008 一起改：`sessionRewriteFor` 的 `customTypes` 列着 `SCOPE_REVIEW_ENTRY`，有彻底删除就把副本里的文字全换掉（副本不进模型的上下文、也不给人看，不去辨认引了哪句）。开着的页面上时间线记录、越界通知要刷新才换成删除标记（和别的被改写的事项一样）。
- **删除项目**：项目的 `scope_record` 一起改写（`scopeRecordPurge`），越界通知数据里有项目编号，随待我处理里属于项目的事项改写；时间线记录在维护者会话频道上，随整条会话换成标记。
- **前端**（`state/scope-records.ts`）：`ui.scopeRecords`（`scope_record` 事件，同一个 id 的新版本换掉旧的；跟着所在的频道重新同步，删掉的项目的一起拿掉）；`projectScopeRecords(state, projectId)`、`taskScopeRecords(state, taskId)` 返回范围变更、越界各一组（最近的在前，`ScopeRecordView`：中文种类、哪次审视、"工单 wo-2 · 任务 t-1「…」"）。简版项目页和任务详情的"计划"一栏都有"范围记录"一节（`ui/scope-records.tsx` 的 `ScopeRecordList`：越界一组在前，说明可以展开），项目的任务也显示项目维护者做它的工单时记下的；越界通知在待我处理里（`InboxPage` 早有"越界通知"的说法）。
- **测试**：主切面 `test/main/scope-review.test.ts`（工单结束时审视出越界：通知不推送、不卡任务、未读，项目页频道、时间线、项目档案的文件，审视的输入有这段对话、立项书、计划和任务书的约束，用量记在任务名下；下一段会话的系统提示末尾有近期范围记录；用户说"先帮我做下 X"后压缩，审视记为范围变更写进项目档案、appendEntry 进会话文件——录成 `scope-review` 给前端回放（只录项目列表、待我处理、看板、卡片）；近期范围记录只取最近 5 条；审视比闲置退出的时间还久时子进程等它；不属于项目的任务压缩时审视、写进任务产出区；审视回了不合约定的结果、超时：工单照常结束、会话里有说明；工单做到一半、写回中途、审视做到一半重置：时间线上记"重置时这段没做范围审视"；审批卡上批准过的调用进对照物，彻底删除这次批准时范围记录跟着改写；彻底删除一条被范围记录引用的用户消息：范围记录、时间线、越界通知、项目档案、会话文件里都不再有原话），契约测试 `test/contract/scope-review.contract.test.ts`（会话之外另开一次调用拿到用量、不进会话、系统提示是装配里的审视说明；回复不是约定的 JSON；压缩前钩子拿到待压缩的消息并 appendEntry；`before_agent_start` 改系统提示）和 `session-rewrite.contract.test.ts`（副本里的文字换掉）。`startTestDaemon` 的 `scopeReviewer(维护者, 第几次唤起)` 给审视的 faux 剧本，后面总接上 `NO_SCOPE_FINDINGS`（每次审视都"在范围之内"），所以别的用例不用管工单结束时的审视；`scopeReviewerTokensPerSecond` 让审视慢下来，`scopeReviewTimeoutMs` 让守护进程早点不等。剧本里核对审视的输入用 `reply_with_context`（把 `{{context}}` 放进记录的 `detail`）。
- **注意**：工单结束时的审视记在任务名下，看板频道上因此多一条 `token_totals`；录了看板频道的事件流（`work-orders-queue`、`project-lifecycle`）因此重新录过。
## 涉及多个项目的任务（`work-orders/multi-project*.ts`，17 号票）

规格第 8、9、11、12 节，ADR-0015。派单队列、会话分段、等澄清的底座照 16 号票，多项目任务自己的那一部分在 `work-orders/multi-project.ts`（`createMultiProject`，派单器建、`daemon.workOrders.multiProject`），说法都在 `multi-project-texts.ts`（编排里不写文字），工具在 `multi-project-tools.ts`（工具名在 `tool-names.ts` 的 `MULTI_PROJECT_TOOL`）。建出、派出和"工单该以什么结局结束"和派单队列共用 `work-orders/orders.ts`（`newWorkOrder` / `dispatchedEvents` / `outcomeOf`；每张工单都有的基础字段只在那里的 `orderBase` 拼，19 号票的 `newRunWorkOrder` 也用它）。

- **哪些任务算**：建卡时定下（`Task.projectScope`：`none` / `single` / `multi`，协议包 `taskProjectScope`；老任务没有这个字段的按维护者和项目数推出来）。任务自己的维护者、选了两个以上项目的是多项目任务；没写项目、第一版任务书里写了项目的，那一刻定下（一个项目交给项目的维护者，16 号票；两个以上是多项目，`projects_settled`）。**之后不随计划改动重新判断**：多项目任务的计划里只剩一个项目也还是多项目任务（工具包固定、回执门槛照样、剩下的等阶段开始的工单照样派）。只涉及一个项目的仍由项目的维护者执行（16 号票）。
- **计划里涉及的项目要对得上任务**（`tasks/plan-projects.ts`：纯函数 `planProjectProblems`，接上项目列表的 `planProjectsCheck`，`daemon.ts` 交给任务服务的 `planProjects` 和执行控制器的 `planProjects`）：提交计划、计划变更、自行调整都查。不涉及项目的任务不能写项目行；单项目任务只能写它自己那个项目（要涉及别的项目就重新发起任务）；多项目任务每一行写计划里有的所属阶段 `stageId` 和这张工单自己的验收标准 `acceptance`，项目要在项目列表里，同一阶段同一项目只写一行，**阶段的验收不用脚本**（交付件在各项目那边，脚本在任务的产出区里跑不到；用评审或由用户验收）。计划卡版本 4。计划变更的比较（`plan-change.ts` 的 `projectAdditions`）按项目和所属阶段对上：去掉一行不算扩大，可以自行调整；同一项目在另一个阶段多一行、挪阶段算加项目。
- **任务维护者的固定工具包**（`maintainers/multi-project.ts`：`MULTI_PROJECT_TOOLKIT` 是"什么都不开"的唯一一份，`multiProjectToolkit(task)` 判断；`multiProjectSetup` 给装配，`maintainers.ts` 的 `taskSetup` 里先看它；执行控制器经 `multiProject.toolkit` 取同一份）：pi 工具一个都不给（没有读写文件、bash、联网），代为执行的工具是固定三样——`read_project_records`（`projects/records-tool.ts` 带范围的版本：只能读这个任务涉及的项目）、`dispatch_work_order`、`summarize_receipts`——加上运行时控制：起草计划时 `submit_plan`，执行时执行控制器的那几个（开始阶段、宣布完成、报告进展、转为等我、失败、计划变更、自行调整、标做不了）、`answer_work_order`（回答项目维护者，算"派工单"那一样的工单往来）和 `forward_to_user`（答不了，指明工单转问用户；项目维护者向派单方提问的是另一个工具 `ask_clarification`）；另有每个维护者会话都有的口语总结（32 号票）。系统提示是任务维护者那一段加上 `system-prompt.ts` 的 `MULTI_PROJECT_GUIDE`。27 号票的工具包四样（skill、MCP、bash、联网）都不开：`maintainers.ts` 的 `taskToolkit` 对多项目任务给的就是这一份，守卫按此刻的工具包收窄（`guardNow` / `narrowedGuardAgent`）也用它，所以用户在任务详情里改工具包不会让任务维护者重新装配；那里的工具包是各项目维护者做工单时的授权（界面上写明），任务维护者也没有增减 skill 的工具。
- **工单**（共享协议包 `work-order-schema.ts`）：按来源分的联合类型——`user_task`（用户发起的单项目任务，种类 `plan` / `execute`，16 号票）、`task_maintainer`（任务维护者派来的改动，种类 `change`，带所属阶段 `stageId`、验收标准 `acceptance`、计划内外 `planned`、工单卡 `cardId?`、等澄清时的问题 `question?`、回执 `receipt?`、派出时刻 `dispatchedAt?`）、`scheduled_job`（定时作业的一次运行，种类 `run`，不属于任务，19 号票，见下面"定时作业与错过补发"）。前两支属于任务（`taskId`、`taskTitle`，合起来是 `TaskWorkOrder`）。状态多了两种还没派出的：`planned`（等阶段开始）、`awaiting_confirm`（待你确认）——不在收件维护者的队列里、不在项目的工单流水线上，**但和别的没结束的工单一样挡项目归档**；结局多了 `declined`（"没派出"：计划外的工单被你拒绝了），`change` 多了 `dispatched`。
  - 建出：用户确认计划时每一行建成一张（`planConfirmed`，和计划卡的处理同一事务），状态 `planned`；返工按依赖重开阶段时，重开的阶段涉及的项目重新建出（`output_reaction`），没受影响的阶段不重派。
  - 派出：所属阶段在做（`running`）时派出（`dispatched`，`dispatchedAt`），进收件维护者的队列；已归档、删掉的项目派出时就退回。
  - 任务维护者执行中派单（`dispatch_work_order`）：计划内外只按"阶段 + 项目"判断——这个阶段现行计划里有这个项目的一行的是**计划内的**，直接派出（可以改写内容）；本阶段这个项目上次退回、做不了的，重新派单是"调整做法"，**算一次验收退回**。没有这一行的是**计划外的**：作为伪工具调用 `work_order:unplanned` 交给守卫的判定函数（`unplanned.ts`，和快速动作同一种做法；派单的维护者在守卫眼里的样子取它此刻的装配：`maintainers.assemblyOf` + `maintainerGuardAgent`；"计划外工单"类别，任务里默认先问我，永不、硬拒绝的不派），工单"待你确认"、待我处理出现**工单卡**（`work_order`，`card.ts`，动作 `dispatch` / `deny`，挡着任务；不另出审批卡，这次调用马上返回），所属阶段这一支等用户确认（`awaitAnswer`，原因 `approval`）。确认后派出，拒绝以 `declined` 结束（卡不能关掉，任务结束时过期），都告诉任务维护者。卡上的决定是内部 `work_orders` 频道上的 `work_order_decided` 事件，"审批决定"素材（`material-source.ts`，彻底删除只换掉用户写的话）。
  - **调整做法算一次验收退回**：执行控制器的 `countReturn(scope, stageId, { why, judged })` 和脚本、评审的退回走同一个 `acceptanceReturn`（同一份 `returns` 计数、同一个阈值；超了这一支停下找用户，不派）；`judged` 是阈值说法里"怎么判的"（`stopReasonText` 不认来源，多项目模块给 `RECEIPTS_JUDGED`）。
  - 项目维护者的装配（`projects/maintainers.ts`）：和执行的工单段同一套 `executionSetup`，带 `part: { stageId }`——做的是任务的一部分：另加 `submit_receipt`，没有推进任务的工具、提议并行、增减 skill（改的是任务的工具包）、重注入块（所属阶段、验收标准在固定上下文"这次的工单"里），守卫看到的当前阶段是工单所属的阶段；工具包是任务授权和项目工具包的交集（`segmentToolkit`，27 号票起守卫按它收窄；任务的工具包变了按新工具包重新装配）。任务暂停、取消时中止它手头这一轮（`followExecutingTask`，不给执行控制器就不换重注入块）。
- **回执**：项目维护者用 `submit_receipt` 交回执（`done` / `returned` / `unable`，退回、做不了必须写理由），这一段照常收尾（写回检查、18 号票的范围审视），段结束时工单以这个结局结束；之后回执作为一条通知进任务维护者的会话（`work-order-receipt:<工单>`，带本阶段到齐没有的说法），任务已经结束的只记在时间线上；没派出就结束的（任务结束、新的计划里没有这一行）不算回执，时间线上记"没有派出就结束了"。
- **阶段的验收**（执行控制器的 `multiProject.stageGate`）：**只看现行计划里这一阶段的行**（每行取最新的那张；你拒绝了的不算）和计划外确认派出的，都结束、都完成了，才能 `complete_stage`、跑本阶段的验收（13 号票的流程）；还在等回执、或者有退回、做不了的，宣布完成被拒（不算一次），原因交回。阶段的交代、重注入块、由我验收的事项、评审的输入里写上本阶段的工单和回执（`stageLines`）；**评审子 agent**（`tasks/review.ts` 的 `context` / `readOnly`）拿到这几行，并能只读访问本阶段涉及的各项目的档案和工作目录（`multiProject.reviewPlaces`）。
- **计划换了一版**（14 号票的计划变更确认、自行调整计划：`plan_decided` 带 `change` 的、`plan_revised`）：新计划里还没有工单的行照样建出，所属阶段在做就马上派出；新计划里没有了的行，还没派出的工单退回（"计划变更或自行调整计划之后，新的计划里没有这一行了"），派出了的在时间线上记一笔、不再挡所属阶段；去掉的是退回、做不了的那几行时，这是调整做法，每个阶段算一次验收退回。
- **等澄清**（`clarifications.ts`，按工单的来源分支）：任务维护者派来的工单，项目维护者提问时不出提问卡：工单转等澄清（`question`），问题作为通知进任务维护者的会话。任务维护者 `answer_work_order` 回答：交回项目维护者、工单回到进行中。答不了用 `forward_to_user`（带 `workOrderId`）转问用户：提问卡（`askedBy` 是任务维护者、项目、工单）进待我处理，所属阶段这一支停下；用户回答后回答交给任务维护者（工单还在等澄清），它再 `answer_work_order` 交回；关掉提问卡同样告诉任务维护者"按你自己的判断回答"。用户的回答是"澄清问题的回答"素材（属于任务和项目）。
- **任务结束**：还没派出的（等阶段开始、待你确认的卡片过期）、还在排队的工单退回；进行中、等澄清的那一段收尾后以退回（任务取消了）或做不了（任务失败）结束。任务从暂停回到执行中时告诉手上有工单的项目维护者。
- **时间线**：工单的建出、派出、待你确认、确认或拒绝、回执、那一行从计划里去掉都记在任务维护者的会话里（`timeline_record` 的 `work_order` 种类，带 `workOrderId`）。
- **前端**：任务详情多了"工单"一栏（`state/work-orders.ts` 的 `taskWorkOrders`：这个任务的全部工单，含建出了还没派出的，按所属阶段排，写着收件项目、状态、所属阶段和那个阶段现在怎样）；工单卡（`ui/cards/cards.tsx` 的 `WorkOrderCard`）能确认派出或拒绝；计划卡的项目行写着所属阶段和工单的验收标准。
- 主切面在 `test/main/multi-project.test.ts`（录了 `multi-project`："派单 → 一张退回 → 重派 → 全部完成"，阶段由评审验收，重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/multi-project.test.ts -t 派单、回执`；另有"改计划去掉退回的那一行"、"计划里涉及的项目要对得上任务"），计划检查的纯函数在 `test/tasks/plan-projects.test.ts`，守卫判定在 `test/guard/unplanned-work-order.test.ts`，回放在 Web 包 `recorded.test.ts` 的"multi-project"。

## 定时作业与错过补发（`scheduled-jobs/`，19 号票）

规格第 8、11、12、13、17 节，ADR-0017（一次运行的形态、谁来做、结局、名额和授权）。名字和纯函数在共享协议包 `scheduled-jobs.ts`、schema 在 `scheduled-job-schema.ts`；守护进程这边在 `scheduled-jobs/` 里，**对外的唯一入口是 `scheduled-jobs/index.ts`**（别的模块只从它取：`createScheduledJobs`、`createJobMaintainers`、`checkPlanJobs`、`jobMaintainerSystemPrompt`、`PROJECT_JOB_RUN_GUIDE`、默认值、视图的几个读法）。编排在 `jobs.ts`，说法都在 `texts.ts`（编排里不写文字），幂等键只在 `keys.ts` 的 `jobKeys`。

- **作业**（看板频道上的 `scheduled_job` 事件，派生视图 `views.ts` 的 `scheduled_jobs`、`job_runs`）：`j-N`，标题、时间表（和简单提醒同一个 `ReminderSchedule`，只能是重复的）、每次做什么（`each`）、属于哪个项目（可空）、执行的维护者、来自哪个任务、**每次运行的授权**（`grants`、`temporalRules`、`grantInfo`）、状态 `active` / `paused` / `cancelled`（暂停的原因 `pausedBy`：`user` / `failures` / `project_retired` / `project_archived`）、下一次 `nextAt`、最近一次运行、`lastFailed`、连续失败次数。事件带着这次的变化（`registered` / `paused` / `resumed` / `cancelled` / `triggered` / `run_started` / `run_finished` / `rescheduled`）、谁做的、说到的那一次运行（`JobRun`：`<作业>-rN`，`scheduled` 到点 / `catch_up` 开机补跑（带错过了几次 `missed`），`queued` → `running` → `done` / `failed` / `interrupted`（停机打断）/ `dropped`（排着时作业暂停、取消了，没运行），原因，属于项目的带工单号）。看板分组：运营中、已暂停的都在"运营中"组，取消的不上看板（`boardGroupOfScheduledJob`）。
- **作业的授权**（规格"定时作业的授权"，用户定）：计划里的作业定义可以带 `policy: { grants, temporalRules }`（和阶段的策略同一种写法）。协议包的 `planPolicies` / `planGrants` 把作业的策略排在阶段、阶段组之后（`PolicyOwner` 的 `job` 一支，`policyOwnerLabel` 写成"定时作业「…」的每次运行"），所以计划的检查（工具和参数、id 唯一、规则校验）、计划卡上的授权行（勾掉、收窄，`narrowPlan` 落到作业的策略上）、停点、用户的限制里的授权收窄都和阶段的一样；授权行的主文 `grantText(grant, info, owner)` 对作业写"每次运行最多 N 次；作业在就一直有效，暂停、取消作业即收回"（`JOB_GRANT_VALIDITY_TEXT`）。确认计划后登记时把授权快照在作业上：授权项、计划卡上算好的 `grantInfo`、作业自己的时序规则加上用户的限制编出的时序规则。**运行时**守卫看到的是 `jobs.ts` 的 `guardTask(jobId)`：`tasks/plan.ts` 的 `toGuardJobPlan` 把授权项挂在唯一的阶段 `JOB_RUN_STAGE`（"run"）上，授予时间是登记的时刻，不过期（不按 7 天、不续期，`grant-renewal.ts` 只看任务的 `toGuardPlan`，看不到作业的），本任务的关注类别取确认的计划里的；作业不在运营中（暂停、取消）时不给授权项（收回）。工具包是作业所在计划现在生效的那一份（27 号票直接改过任务的工具包也跟着），属于项目的再和项目工具包取交集（`effectiveToolkit`：skill 取并集，能力取交集；项目维护者的 `segmentToolkit` 对运行工单段就这么算）；skill、MCP 照样落进会话（`workAssembly` 里的 `toolkitParts`，作业的运行里没有"增减 skill"），守卫按此刻的工具包判（`guardNow` → `narrowedGuardAgent`，作业维护者的工具包变了下一次唤起按新的装配）。
  - 守卫核心为此加了 **带着授权的会话段**（`GuardTask.segmentScoped`）：按任务的那一套判（计划里列了才做的看授权项，超出的照常先问），但效果日志、时序规则、授权项的次数只看这一段会话（`segmentId`，每次运行一段：作业维护者是 `jm-N:<运行号>`，项目维护者是运行工单的那一段），调用和效果的归属里没有任务（`attributedTask` 返回 null：效果记录 `taskId: null`、审批卡的来源里没有任务、不记"永不"的对象、不按任务挂起、不记拉回）。
- **登记**（`jobs.ts` 的 `register`）：用户确认计划（看板上任务的 `plan_confirmed`）后每个定义登记成一个作业，进入运营中（幂等键 `jobKeys.register(计划, i)`，启动时把漏登的补上——只补还在排队、执行中的任务；一个任务只登记一回，14 号票的计划变更、自行调整出的新一版计划沿用原来的作业）。秘书没有建作业的工具。提交计划时 `plan.ts` 的 `checkPlanJobs` 查：时间表要重复；单项目任务（17 号票的 `Task.projectScope` 是 `single`，由项目的维护者执行）里的作业都属于这个项目（没写就补上），不涉及项目、涉及多个项目的任务里的作业不属于项目、不能写属于哪个项目。任务里的作业属于哪个项目只在 `plan.ts` 的 `jobProjectOf` 里判，提交计划时的检查和确认后的登记都用它。项目已停用、已归档时登记成已暂停。
- **谁来做**：属于项目的由项目的维护者做，每次运行是一张工单（`JobRunWorkOrder`：来源 `scheduled_job`、种类 `run`，不属于任务，带 `scheduledJobId`、`runId`、`instructions`；工单按来源区分成联合类型的第三支（前两支是 16、17 号票的 `user_task`、`task_maintainer`），认是哪一支用 `isJobRunWorkOrder`，要任务编号用 `workOrderTaskId`；建出用 `work-orders/orders.ts` 的 `newRunWorkOrder`，和另两支共用基础字段 `orderBase`；派生视图里没有任务的存成 `NO_TASK_ID`，`workOrdersOfTask` 不接受它）。开段、收尾、写回检查、工单结束时的范围审视照 16、18 号票；运行的段里没有 `ask_clarification`，装配是 `maintainers/assembly.ts` 的 `jobRunSetup`（和 `executionSetup` 同一个 `ExecutionSetup`，动手的那部分共用 `workAssembly`；`projects/maintainers.ts` 的 `jobRun` 钩子取 `ScheduledJobs.runAssembly`：工具包、`fail_job_run`、来源、守卫的 `guardTask`）。范围审视的对照物（`scope-review/texts.ts` 的 `referenceText`）对运行工单段列出【定时作业】：每次要做的事、时间表、每次运行的授权项和规则、工具包。不属于项目的由作业自己的维护者 `jm-N` 做（`maintainers.ts`，会话频道 `maintainer:jm-N`，工作目录是任务的产出目录 `outputs/<任务>`，接着同一个 pi 会话），一次运行是一条带作业身份（`scope.scheduledJobId`）的通知；子进程按哪一次运行拉起的记着，换了一次运行就重新拉起（`outdated`），守卫的这一段跟着换。
- **到点和名额**：调度器的 key 是 `job:<作业>`（`start()` 之后才登记）。到点时一次运行进队列（`jobKeys.trigger(作业, 这一次的时刻)`），下一次往后算；同一个作业上一次还没跑完（排着或在跑）的，这一次跳过（`rescheduled`）。**名额在运行真正开始时才占**，谁占着只在 `tasks/slots.ts` 的 `ExecutionSlots` 里数（执行中的任务、作业自己的维护者在做的运行、进行中的运行工单，都从派生视图现数，和状态变化同一事务，不会数错）；名额可能空出来（任务离开执行中、运行结束、工单结束）时依次叫执行控制器（排队的任务）、派单器（项目队列里排到的运行工单）、定时作业（作业自己的维护者那边排队的运行）。属于项目的到点时就派出工单（同一事务），在项目的队列里排着不占名额；排到了、又有名额才开始（派单器的 `startable`），工单开始时这次运行开始。所以项目队首是排队中任务的执行工单、后面排着运行时不会卡死：名额先给队首的任务。LSM 的忙闲（`lsm/busy.ts`）也算正在运行的。
- **结局**：这一轮正常结束是成功；维护者用 `fail_job_run` 报了原因的、这一轮出错或被中止的、**有一步等不到批准被拦下的**（`approval_suspended`，原因写明是哪一步）、交给用户亲手做的（"交给我做"事项）是失败；属于项目的工单退回、做不了也是失败。**停机打断的那次记为中断**（`interrupted`，不重做，不算进连续失败，也不改"最近一次失败"）。连续失败 `scheduledJobs.jobFailures`（默认 3）次自动转为已暂停（`pausedBy: "failures"`），同一事务里待我处理放一条 `scheduled_job_auto_paused` 通知（动作"恢复""保持暂停"）。中间有一次成功就清零，用户恢复时也清零。作业维护者的系统提示（`jobMaintainerSystemPrompt(次数)`）、`fail_job_run` 的工具说明、每次运行的内容里的次数都从配置插值，"做不了就报告失败"这句只在 `texts.ts` 的 `failRunHint` 里。
- **用户的动作**：`scheduled_job_action { jobId, action: pause | resume | cancel }` → `{ jobId, state }`（带幂等键）。做不了的（已暂停的再暂停、项目已停用 / 已归档时恢复）`not_allowed`，没有这个作业 `not_found`。恢复后下一次从现在往后算。**暂停、取消时排着的运行一并丢掉**（记为没运行，属于项目的还排着的工单经 `WorkOrders.dropRun` 退回，同一事务）；正在运行的那一次照常做完。项目停用、归档时它运营中的作业暂停（`project_retired` / `project_archived`），重新启用、取消归档时只恢复因此暂停的（取消归档回到已停用的，改记成因停用而暂停）；项目删除时它的作业取消。作业的变化从不改项目状态。工作日历变了时按工作日重复的作业重算下一次（`rearm`）。
- **错过的触发**（`start()`，在 23 号票的 `recoverAfterRestart` 之后调）：停机前在跑的运行对一遍（属于项目的看工单；不属于项目的，被打断的那条输入在作业维护者的会话开始时标成中断，记为中断）；过了点的运营中作业不管错过几次只补跑一次（`catch_up`，`missed` 写明错过了几次，下一次从现在往后算，和补跑同一事务落盘：再重启不会再补）。错过了几次和简单提醒共用协议包的 `latestOccurrence`。简单提醒的晚到 / 错过（06 号票，界线是 `reminders.lateLimitMinutes`，默认值在 `reminders/thresholds.ts`）和内部作业的补跑（11 号票）照旧。
- **记账**：交给维护者的输入带着 `scheduledJobId`，账本（24 号票）按"定时作业 > 任务 > 项目"把用量记在作业名下（看板上作业的 `token_totals`）；运行工单结束时的范围审视也记在作业名下。
- **秘书的看板**：`board/kinds.ts` 加了定时作业一行（时间表、状态、下一次、最近一次失败、属于哪个项目）。
- **日历要的查询**（35 号票用）：`ScheduledJobs.calendar(from, to)` 给出 [from, to) 之间每个没取消的作业（`JobCalendarEntry`：作业本身——状态、暂停的原因都在上面，时间表展开 `occurrences`——按当前的个人工作日历，"按我的工作日"的照它，已暂停的也展开，这段时间里到点的运行记录 `runs`）；视图的 `runsOfJob` 从入口导出；时间表展开本身是协议包 `reminder-schedule.ts` 的 `occurrencesBetween`（和简单提醒同一套时间规则，Web 也能直接用）。
- 主切面在 `test/main/scheduled-jobs.test.ts`（登记、作业的授权（授权内的对外发送不问、限制编出的规则禁止的被拦、超出的先问且等不到批准记失败、暂停即收回）、到点运行和记账、名额排队和暂停时丢掉排着的、属于项目的作业、名额不会卡死和范围审视的对照物、失败和自动暂停、暂停恢复取消、项目停用归档和恢复、计划检查、错过的触发和再重启、被打断的运行记为中断、归档清单）。守卫的带着授权的会话段在 `test/guard/grants.test.ts`，作业策略的检查、收窄、交给守卫的样子在 `test/tasks/plan.test.ts`，授权行和停点在 `packages/protocol/test/plan.test.ts`。录了 `scheduled-job-project`、`scheduled-job-failures`、`missed-triggers`、`archive-list` 四段给 Web 回放（`packages/web/test/state/recorded-scheduled-jobs.test.ts`），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/scheduled-jobs.test.ts`。
- Web：状态层 `state/scheduled-jobs.ts`（`scheduledJobView`（含每次运行的授权 `grants`、`rules`，`jobAuthorizationLines`）、`projectScheduledJobs`、`jobRuns`；`UiState.scheduledJobs`、`jobRuns`），看板运营中组的作业卡（暂停、恢复、取消）和项目页的定时作业列表都能展开看每次运行的授权（`ui/job-authorization.tsx`），计划卡的授权一栏列出作业的授权行，工单流水线上运行的工单写作业名，归档清单卡 `ui/cards/ArchiveListCard.tsx`。

## 归档清单（`tasks/archive-list.ts`，19 号票）

任务模块在调度器上登记的内部作业 `archive_list`（每周一 09:00，错过了开机补做一次），不放在 `scheduled-jobs/` 下。把结束（已完成、失败、已取消）超过 `tasks.thresholds.archiveAfterDays`（默认 7，默认值在 `tasks/thresholds.ts`）天、还没归档的任务汇总成一张归档清单卡（卡片类型 `archive_list`，不卡任务；上一张还没处理完的过期掉），进待我处理。每一项单独选（卡片动作 `decide`，输入 `{ taskId, choice, stageId?, note? }`）：`archive` 任务变为已归档（任务的变化 `archived`，看板的已归档分组）；`continue` 已完成的走返工（默认最后一个阶段，照常产生 `output_reaction` 的返工素材）、失败的走重试，都回到执行中；`keep` 不变。已取消的、转为项目结束的只能归档或先留着。每一项都选了卡片算处理完。说法（标题、纯文本降级、拒绝的原因）在 `tasks/archive-texts.ts`。

## 日历（`calendar/`，35 号票）

规格第 19 节"日历"、第 21 节"工作日历"。主导航的日历按月看：每天上班或休息及原因，当天的简单提醒和定时作业。名字、说法和纯函数在共享协议包 `calendar.ts`（每一次的状况 `CALENDAR_REMINDER_STATUSES` / `CALENDAR_JOB_STATUSES` 和中文名、格子上的数 `calendarDayCounts`、月份的写法 `monthKey` / `parseMonthKey` / `shiftMonthKey`、年月选择的年份 `calendarYearOptions`），schema 在 `calendar-schema.ts`。

- **按月取**：`GET /api/calendar?month=YYYY-MM` → `CalendarMonthView { month, days, missing, asOf }`。每天一个 `CalendarDay { date, verdict, reminders, jobs }`：`verdict` 是工作日历的 `DayVerdict`；`reminders` 是 `CalendarReminderEntry { reminderId, text, schedule, at, status, lateMinutes? }`，`jobs` 是 `CalendarJobEntry { jobId, title, schedule, projectId?, projectName?, at, status, run? }`，都按时刻排好。守护进程这边是 `calendar/calendar.ts` 的 `createCalendarService({ store, workdayCalendar, reminders, scheduledJobs, clock })`，只把三样按天合起来、给每一次定状况：提醒的展开和触发记录来自提醒模块的 `reminders.calendar(from, to)`（每条没取消的提醒：时间表在这段时间里的每一次、现在的时间表从哪一刻起生效 `since`、触发记录 `firings`——reminder 事件里 `fired` / `missed` 的 `lastFiredAt` 就是那一次该响的时刻），作业的来自定时作业模块的 `scheduledJobs.calendar(from, to)`（19 号票）。时间规则都是协议包的 `occurrencesBetween`，按当前的工作日历展开（"按我的工作日"的跟着它），前端不另算。
- **每一次的状况**：从建的那一刻起展开（提醒从 `since`，作业从登记的时候），之前的日子上没有；真响过、真跑过但对不上现在的时间表的（时间表改过、工作日历改过）按它们自己的时刻单独列出。提醒：有触发记录的是 `fired`（晚了的带 `lateMinutes`）或 `missed`；没有的，还没到点、或者到点了正等着响（不早于提醒的 `nextAt`）是 `upcoming`，过了点是 `skipped`（没响：停机期间错过几次只按最近一次处理，前面几次就是它）。作业：有运行记录的是这次运行的状态（`queued` … `dropped`）；没有的，还没到点（或到点了正等着触发）运营中的是 `expected`（预计）、暂停着的是 `paused`（不算预计，格子上的作业数不算它），过了点是 `skipped`（跳过：停机期间只补跑最近一次，前面几次就是它）。已取消的提醒、作业不出现。
- **实时更新**：提醒和作业的变化都是看板频道上的 `reminder` / `scheduled_job` 事件，工作日历的变化是工作日历频道上的事件；`asOf` 是算的时候这两个频道最后一条事件的序号（一次同步调用里读，和内容一致）。前端收到序号更大的这些事件就知道手里这份旧了，重新取（见下面 Web 的"35 号票起"）。没有新的推送事件，也不用改前端协议版本。
- 主切面在 `test/main/calendar.test.ts`（按月展开、到点之后的结果、失败、标休息后按我的工作日的没了、暂停和取消、恢复和改提醒、停机期间错过的"跳过""没响""错过"）。录了 `calendar-month`、`calendar-changes` 两段给 Web 回放（`packages/web/test/state/recorded-calendar.test.ts`），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/calendar.test.ts`。模拟前端的 `frontend.calendarMonth(month)` 经 HTTP 取一个月，并把它录成状态层的 `calendar_month` 输入（骨架里只记月份和每天的提醒数、作业数）；直接看接口用 `test/helpers/http.ts` 的 `calendarApi.month`。

## agent 管家的资源限制（`agent-manager/`，12 号票）
## agent 管家的资源限制（`agent-manager/`，12 号票）

规格第 3、21 节。`createAgentManager({ layout, parentEnv, job, limits, onActivity, log })`，`limits` 来自配置的 `agents`（`AgentLimits`，默认 `DEFAULT_AGENT_LIMITS`）：

- **子进程上限**（`maxLive`，默认 8）：`spawn(request)` 返回 `ManagedAgent`，名额满了**不报错而是排队**（`state: "queued"`、没有 pid，可以先登记 `onReport`、等 `exited`，`send` 会抛错），名额空出时按先后拉起。**常驻的**（`resident: true`，只有秘书）占一个预留的名额、从不排队、不闲置退出。
- **闲置退出**（`idleMs`，默认 10 分钟）：非常驻的 agent 就绪后、或一轮结束后闲置这么久，管家送 `exit`，子进程退出（`exited` 的 `reason: "idle"`）；拉起它的模块看到 `idle` 就知道下次有输入再唤起。
- **单次模型调用超时**（`modelCallMs`，默认 5 分钟）和**单次工具调用超时**（`toolCallMs`，默认 10 分钟；代为执行的工具可以在 `defineHostTool({ timeoutMs })` 里声明更长——28 号票的跑测试、启动构建、装依赖声明配置里的 `shellTools.longCallMinutes`，默认 30 分钟：超时留在守护进程这一侧，拉起时经 `hostToolTimeouts(tools)` 放进 `SpawnAgentRequest.toolTimeouts` 交给管家，不进宿主协议）：到点送 `abort`，这一轮的 `turn_end` 改成出错（"模型调用超过 5 分钟没有结束，已中止" / "工具 X 的调用超过 10 分钟没有结束，已中止"）；15 秒还不结束就结束子进程（`reason: "unresponsive"`）。
- **孤儿进程回收**（`orphanSweepMs`，默认每分钟；只有 Windows 有 Job 对象）：Job 里的进程（`JobObject.processIds()`），从活着的 agent 子进程沿父进程链（`process/process-list.ts` 的 `parentProcessIds()`，Toolhelp 快照）够不着的就是孤儿（比如 bash 起的后台进程、父进程已经退了），结束前再确认一次它还在 Job 里（`agent-manager/orphans.ts`）。
- **活动状态**（12、25 号票）：`onActivity(agentId, state, detail?)` 每次可能变了就报（不去重）；`daemon.ts` 交给 `activity/activity.ts` 的 `createActivityLog`，它把管家报的和待处理的卡片合起来（见下），合起来变了才在活动状态频道上记一条 `activity` 事件——**去重只在这里做一次**（派生视图 `agent_activity`；守护进程启动时 `settle()` 按"子进程都已不在"重新合一遍：没有待处理卡片的是休眠，有的是等你）。说明都是结构化的 `ActivityDetail`。管家里每个 agent 的活动状态这样算：
  - 排队：名额满了在等；
  - 干活中：拉起了还没交来输入的按需 agent 是"被唤起"（就绪后 2 秒 `READY_HOLD_MS` 内还算被唤起，免得唤起时先报一下空闲），送了输入（`user_input`）是"处理一条输入"；常驻的（秘书）拉起时不报；
  - 等你：这一轮里有调用在等用户——守卫接入（`createGuardRuntime({ userWaits })`，经 `approval-waits.ts`）在子进程里的调用开始等审批时报 `userWaitStarted(agentId, key, detail)`，不等了（批准、拒绝、超时挂起、回合中止）时报 `userWaitEnded(agentId, key)`（接口 `UserWaits`，管家实现它，`daemon.ts` 传 `userWaits: agents`）；这一轮结束、子进程退出时一并清掉。16、17 号票的等澄清要是在子进程里停着等，照审批的样子报这两个；
  - 休眠：闲着（按需的说明是"空闲"：子进程还在，`idleMs` 后退出；常驻的闲着就是休眠、没有说明）、闲置退出（"闲置退出"）、别的退出。
  管家报的是休眠时，还有属于这个 agent 的待处理卡片就是等你（`activity/card-waits.ts`，由卡片视图和审批表推出，重启后照样对）：挂起、这一轮结束以后还没处理的审批卡（发起调用的 agent，说明 `approval` 带工具名），没回答的提问卡（秘书，说明 `clarification`）；卡片处理掉回到休眠。后面的票有新的"等用户"的卡（别的 agent 出的提问卡、工单的等澄清……）往 `CARD_WAITS` 里加一行。
  干活中此刻在做什么经 `onProgress(agentId, detail)` 报（流式增量数着字数 `thinking` / `replying`，工具调用开始时 `calling_tool` 带中文名，代为执行的工具的中文名由 `AgentSession` 经 `SpawnAgentRequest.toolTitles` 给，内置的取守卫的工具注册表），`createActivityLog({ publish, nowMs? })` 按 agent 节流成临时事件 `activity_progress`（只在记下的状态是干活中时推）。节流用 `util/throttle.ts` 的 `createKeyedThrottle`（按键、钟可注入），流式增量（`conversation/stream-hub.ts`）用的也是它。活动状态和任务状态、项目状态是三回事：不引起任务、项目的迁移，任务、项目变了也不改写它（主切面 `test/main/activity.test.ts`）。
- **用量**（24 号票）：子进程每次模型调用报一条 `usage`，管家连同会话 id（就绪时报的）和拉起时给的归属（`SpawnAgentRequest.ledger: () => UsageAttribution`，每次现取）交给 `onUsage`（`daemon.ts` 接到 `ledger.record`）。**拉起 agent 的模块都要给 `ledger`**（`AgentSession` 按输入定，评审子 agent 记在任务名下、它评审的阶段；20 号票的并行子 agent、19 号票的作业照这个给），不给的记成"未归属"（消耗页单列，不混进系统开销；账本的日志里提醒）。管家把模型在配置里的键（`modelConfigKey(request.model)`）一并交给账本。
- **拿着不闲置退出**（18 号票）：`ManagedAgent.holdAwake(key)` 返回放开的函数；拉起它的模块在等子进程做一件不是回合的事（范围审视：结果要在子进程退出之前交回来，真模型审视可能比 15 秒的退出宽限还久）时拿着，拿着时不闲置退出，都放开了、又没有回合在进行时重新计时。管家自己不认得范围审视。
- `live()` 是现在活着的子进程；`shutdown()` 结束全部（排队的取消）。守卫接入、宿主工具只要 `AgentLink`（收发消息、知道它什么时候退出）。
- 主切面在 `test/main/agent-limits.test.ts`（数值配小：上限 2、闲置 0.6 秒……）。

## token 账本与消耗（`ledger/`，24 号票）

规格第 16 节、第 21 节"token 记账"。**token 计数只有一个来源**：子进程每次模型调用上报的 `usage`（宿主协议；压缩会话生成摘要的那次也报，`purpose: "compaction"`），经 agent 管家交给账本记一条；看板上的合计、任务详情的细分、消耗页、14 号票的预算阈值都从这一条来，不各数一套。合计也只有一处算：派生视图上的 SQL 聚合（`views.ts` 的 `ownerTotals`；看板上推的那条在记账前算，把正要记的这一条并进去一起聚合）。

- **一条记什么**（`ledger/entry.ts` 的 `TokenUsagePayload`，`ledger` 频道上的 `token_usage`，派生视图 `token_ledger`）：时间（可注入的时钟）、归属 `owner`（`LedgerOwner { kind: task | project | scheduled_job, id }`；`null` 是不在任何名下：秘书的系统开销，或者未归属）、记在任务名下时调用算哪个阶段 `stageId`、用途 `purpose`（`LEDGER_PURPOSES`：`work` 干活、`scope_review` 范围审视、`compaction` 压缩，照子进程报的）、agent 和它的角色（`LEDGER_ROLES`：秘书、维护者、评审子 agent、子 agent、未归属）、pi 会话 id、模型（`config/model-key.ts` 的 `modelConfigKey`：`provider/模型 id`，faux 是 `faux`——和配置里 `models`、`tokenPrices` 的键是同一个；管家算好放进 `AgentUsage.model`）、`tokens { cacheHit, cacheMiss, output }`。**缓存命中 = pi 的 `cacheRead`，未命中 = `input + cacheWrite`**（`ledgerTokens(report)`；pi 里这三块互不重叠；DeepSeek 不报 cacheWrite）。契约测试用 pi 的 openai-completions 解析录好的 DeepSeek 流式响应（本机回放，不联网）锁住这个换算。
- **归属**（`UsageAttribution { owner, role, stageId? }`，拉起 agent 的模块经 `SpawnAgentRequest.ledger` 给，每次用量上来时现取）：
  - **系统开销按角色判**：秘书（`role: "secretary"`）的用量不论它在处理什么（哪怕输入带着任务）都是系统开销，不计入任何名下；
  - **未归属**：拉起时没给 `ledger` 的 agent，记成 `role: "unattributed"`、`owner: null`，消耗页单列为"未归属"，不混进系统开销；账本的日志里对每个这样的 agent 提醒一次；
  - `AgentSession`（秘书、维护者）按正在处理的那条输入定：输入的消息事件里带的定时作业 `scheduledJobId` 优先，其次任务 `taskId`、项目 `projectId`，都没有按会话的 `scope`（见上面"agent 会话"）。所以项目维护者执行定时作业（19 号票把作业的一次运行交给它时，消息带上 `scheduledJobId`）时记在作业名下，处理带任务的输入时记在任务名下，和用户直接对话时记在项目名下；
  - 评审子 agent：`{ owner: 任务, role: "reviewer", stageId: 它评审的阶段 }`；
  - **20 号票的并行子 agent**：拉起时给 `ledger: () => ({ owner: { kind: "task", id: taskId }, role: "sub_agent", stageId: 它被派去的阶段 })`，用量就记在那个阶段（不看维护者当时在哪个阶段）；
  - 作业自己的维护者（19 号票）：给 `{ owner: { kind: "scheduled_job", id }, role: "maintainer" }`；
  - 记在任务名下、没给 `stageId` 的，取任务的当前阶段（`stages.ts` 的 `taskMessageScope`，和消息的归属同一处算：20 号票起是维护者最后一次开始的那个阶段 `focus`）；还没开始执行（起草计划）、任务已经结束、全部阶段都验收了之后的调用（收尾）不算进任何阶段；
  - 范围审视（18 号票）：子进程在 `usage` 里标 `purpose: "scope_review"`，走同一条上报路径，记在维护者当时所属的名下。
- **看板**：记在任务、定时作业名下的，同一事务里在看板频道推一条 `token_totals`（这个名下最新的合计：`byAgent` 按 agent、角色、用途各一行；`byStage` 每个阶段的全部用量 `tokens` 和算进预算的 `budgetTokens`）。
- **查询接口**（`daemon.ledger`，`TokenLedger`）：
  - `totals({ kind: "task", id })` → `TokenTotalsEventPayload | undefined`：某个名下的总量、调用次数、按 agent、按阶段（和看板上那条一样）；
  - `stageTokens(taskId, stageId, { budget: true })` → 这个阶段**算进预算**的 token 数（命中 + 未命中 + 输出）：干活的 agent（维护者、子 agent）的调用和压缩算，**评审子 agent 的、范围审视的不算**，收尾调用本来就不在阶段里。**14 号票的预算阈值（用量超过预算让维护者说明进展、超过预算的 2 倍问用户）读它**，和看板上 `byStage[].budgetTokens`、阶段抽屉上写的"用了多少"是同一个数。不给 `budget` 是这个阶段的全部用量（含评审）。只查这一个阶段的一条 SQL，不算整个任务的合计；计划卡上的 token 粗估（12 号票）要和实际比时用 `totals`；
  - `onRecorded(entry => …)`：每记一条叫一次（事件已经落盘），返回取消登记的函数；14 号票据此在每次调用之后检查阈值（`entry.owner`、`entry.stageId` 告诉它查哪个阶段）；
  - `entries(owner?)`：账本里的条目（`LedgerEntry`，`null` 只要不在任何名下的：系统开销和未归属）；
  - `summary({ from, to })` → `UsageSummary`：消耗页的数据（下面）；
  - `record(usage)`：agent 管家的 `onUsage` 接在这里（测试里的构造用量也走它）。
- **消耗页**（`GET /api/usage?from=&to=`，`UsageSummary`）：范围（协议包的 `LocalDate`，含两头；网关按 `LocalDate` 和 `parseLocalDate` 校验，写错了、日期不存在、起点在终点之后回 `bad_request`）里按天（`days[]`：当天合计、系统开销、未归属、按 agent）、按 agent（`agents[]`，`category` 是 `owned` 记在名下、`system` 系统开销、`unattributed` 未归属，`usageCategory(role, owned)`）的汇总，`total`、`system`、`unattributed` 各一份 `UsageTally { tokens, calls, cost }`；`pricing { estimate: true, currency, prices: ModelPrice[], unpriced, problem? }`：**成本一律是粗估**——用量乘配置里的单价（`tokenPrices`，`TokenPriceTable`，单价是协议包的 `TokenPrice`，每百万 token，命中、未命中、输出各一个；每次现读配置，改了不用重启），不按时段计价；没配单价的模型列在 `unpriced`、不算进成本；配置读不出来时成本按 0、`problem` 写原因。天按记账时间的本地日期（协议时间的前 10 个字符）分。
- **前端**：`state/usage.ts`：`ownerTokens(state, owner)`、`taskTokenTotal`（看板的任务卡，`BoardItem.tokens`）、`jobTokenTotal`（作业卡，`owner.kind: "scheduled_job"`；19 号票接真作业之前原型的假作业卡用假数）、`taskUsage(state, taskId)`（任务详情"消耗"一栏：每个 agent 一行，范围审视、压缩各另一行标出来（`LEDGER_PURPOSE_LABEL`），各行之和就是总量）、`stageTokens`（阶段抽屉的预算旁边写用了多少：`StageView.budget.usedTokens`，取 `budgetTokens`）、消耗页的范围快捷选项 `usageRange(preset, now)`、`rangeDays`、`usageAgentName`（维护者带上所在的项目或任务）。消耗页（`pages/more/UsagePage.tsx`）经 `DaemonHttp.usage(range)` 取数（原型是 `FakeDaemonHttp` 的假账本），按 agent 的表里记在名下的、系统开销（秘书）、未归属（有才显示）分三组。
- **测试**：主切面 `test/main/token-ledger.test.ts`（秘书的用量是系统开销、未归属单列；跑完一个任务后账本和剧本一致、看板合计逐次增长、任务详情的细分、评审记在它评审的阶段但不算进预算、收尾调用不算进阶段（录成 `token-ledger` 给前端回放）；工单结束时的范围审视用剧本给定的用量（`scopeReviewer` 的一步带 `usage`），任务自己的维护者压缩时的审视、压缩用构造的用量；预算口径；项目维护者处理带 `scheduledJobId` 的输入时记在作业名下；粗估成本和改单价；范围写错回 400）。构造的用量用 `test/helpers/usage.ts` 的 `usageInjector(daemon)`：包一层管家的 `spawn` 记下每个 agent 的归属，`inject(agentId, tokens, { purpose?, attribution?, unattributed?, model? })` 照管家收到 usage 时那样交给账本。faux 剧本的一步可以带 `usage: { cacheHit, cacheMiss, output }`（这次调用照它上报）；契约测试 `test/contract/usage.contract.test.ts`；回放在 `recorded.test.ts` 的"任务的 token 用量"。
- **注意**：任务、作业名下的每次模型调用都会在看板频道多一条 `token_totals`，主切面里录看板频道的事件流（`task-initiation`、`task-execution`、`holiday-update-task` 等）因此要重新录（命令见下面"测试底座"的 `recording.ts`）。

## 共享协议包（`packages/protocol/`）

- `constants.ts`：频道名（`CHANNELS`、`maintainerChannel`）、事件类型（`EVENT_TYPES`，临时事件 `isEphemeralEventType`）、请求方法（`METHODS`，必须带幂等键的 `METHODS_REQUIRING_IDEMPOTENCY_KEY`）、错误码、卡片类型和动作等。**不引用 TypeBox**。
- `schema.ts`：TypeBox 定义的三种帧（`RequestFrame`、`ResponseFrame`、`EventFrame`）、频道（`Channel`、会话 id `ConversationId`）、消息信封和全部 part（含工具调用 part 的关注类别、判定、授权内、通用 bash）、卡片、各方法的参数和结果、各事件的负载；类型用 `Static<>` 生成，和 schema 同名导出。
- `request.ts`：`parseRequest(raw)` 先校验帧、再按方法校验参数，给出类型确定的请求或错误（`bad_frame` / `unknown_method` / `bad_params` / `idempotency_key_required`）；有副作用的方法在类型上幂等键就是必填的。`isChannel(name)` 按 schema 里的 `Channel` 判断。
- `time.ts`：`nowIso()`，协议里的时间格式（带时区偏移的本地 ISO 时间，精确到毫秒）。守护进程和 Web 都用这一份。
- `validate.ts`：`schemaChecker(schema)`（按 schema 校验一个值，给出第一条错误），以及转出去的 `Type`、`Static`、`TSchema`。守护进程自己的 schema（卡片动作的输入、秘书工具的参数）也用这里的 `Type` 写，不另外引用 TypeBox，免得两个版本混用（根目录装的是 pi 的那份）。
- `reminder-schedule.ts`：简单提醒的时间规则，见上面"调度器和简单提醒"。
- `workday-calendar.ts`：个人工作日历（29 号票）：节假日数据 `HolidayYear`、额外上班规则 `ExtraWorkdayRule`、手动标记、个人设置 `WorkdaySettings`、改动 `WorkdayChange` 的 schema；纯函数 `workdayCalendar(节假日数据, 个人设置)`（`day(日期)` 给出 `DayVerdict`：上班或休息、原因、当天的节假日、缺哪边的数据；`month`、`missing`、给调度器的 `isWorkday`）、`applyWorkdayChange`、中文写法（`dayReasonLabel`、`describeExtraRule`、`describeWorkdayChange`、`missingHolidayDataText`、格子里的短词 `dayShortLabel`）；节假日数据的校验、合并、文件名；两种事件的负载和改动来源 `WorkdayChangeSource`。`local-date.ts`：本地日期和星期的小工具，时间规则和工作日历共用。守护进程和 Web 共用，见下面"个人工作日历"。
- `inbox.ts`：`isInboxItemProcessed`，待我处理事项算不算处理过的唯一一份判断；`compareInboxItems`，事项的先后（置顶的在前，再按紧急度三档 `URGENCIES` 的先后，同一档里新的在前，Web 的待我处理页和秘书的列出待我处理共用，22 号票）。
- `tasks.ts`（12 号票）：任务状态 `TASK_STATES` 和中文名、未结束的 `UNFINISHED_TASK_STATES`（由 `TASK_STATES` 过滤出来）、怎么结束的 `TASK_END_KINDS`（转为项目）、发起方式、谁改的和中文名 `TASK_ACTOR_LABEL`、变化种类，看板的五组 `BOARD_GROUPS`（名字和包括哪些状态 `BOARD_GROUP_LABEL`）、任务状态到分组 `BOARD_GROUP_OF_TASK_STATE`、简单提醒到分组 `boardGroupOfReminder(status: ReminderStatus)`（**看板分组只有这一份**，守护进程和 Web 共用）、验收方式、阶段模式、计划里 id 的格式。**不引用 TypeBox**。
- `task-schema.ts`（12 号票）：`Task`、`task` 事件的负载、`start_task` 的参数和结果、任务书 `TaskBrief`、计划 `Plan` 及其各部分（策略 `PlanPolicy`）、`GrantInfo`、计划卡 / 提问卡（题目 `Question`、秘书写的 `QuestionDraft`）/ "建议发起任务"卡的负载和动作输入、`questions_answered` 事件的负载。守护进程的参数 schema 从这里推（`TaskBrief.properties`、`QuestionDraft`），不各写一遍。
- `plan.ts`（12 号票）：计划的纯函数（不引用 TypeBox）：`planPolicies`、`planGrants`、`policyOwnerLabel`，卡上生成的文字 `grantText`、`temporalRuleText`（`temporalRuleForm`、`ruleToolList` 认规则的形态和工具），`grantAuthorizes`，停点 `planStops`。守护进程（检查、素材）和 Web（计划卡）共用。
- `activity.ts`（12 号票）：活动状态 `ACTIVITY_STATES` 和中文名、`activity` 事件的负载（25 号票加了结构化的说明 `ActivityDetail`，种类 `ACTIVITY_DETAIL_KINDS`，文字由 `activityDetailText` 按表生成）、临时事件 `activity_progress` 的负载和节流间隔 `ACTIVITY_PROGRESS_INTERVAL_MS`。
- `timeline.ts`（25 号票）：时间线上的记录 `TimelineRecord`、`timeline_record` 事件的负载（带着 `MessageScope`），记录的种类表 `TIMELINE_RECORD_KIND_INFO`（中文名、进不进要点层、严重度 `TIMELINE_RECORD_SEVERITIES`；新种类只加这一行）、`isTimelineRecordKind`。14 号票的偏离、计划变更、自行调整计划，18 号票的范围变更和越界用守护进程的 `buildTimelineRecord` 追加到维护者会话的频道上（任务里的归属用 `taskMessageScope`）。
- `message-scope.ts`（25 号票，不引用 TypeBox）：消息归属 `MessageScope`（schema 在 `schema.ts`）的键 `MESSAGE_SCOPE_KEYS` 和取值 `pickMessageScope`（只留有值的字段）。`http-schema.ts` 的 `HistoryPage` 多了 `records`（`HistoryRecord`）。
- `constants.ts` 里另有快速动作凭什么执行的 `QUICK_ACTION_BASES` / `QUICK_ACTION_BASIS_LABEL`（`quick_action_executed` 的 `basis`：`explicit` 用户点明的、`within_grant` 推断出来但在已有授权内直接执行的、`confirmed` 用户在卡上确认后；25 号票之前的记录没有这一项）、被拦下的原因的中文名 `TOOL_CALL_BLOCK_LABEL`（25 号票从 Web 挪来）。
- `usage.ts`（24 号票，不引用 TypeBox）：账本里的角色 `LEDGER_ROLES`、归属种类 `LEDGER_OWNER_KINDS`（`task`、`project`、`scheduled_job`）、调用的用途 `LEDGER_PURPOSES`（干活、范围审视、压缩）、消耗页上的三类 `USAGE_CATEGORIES` 和它们的中文名，"系统开销""未归属""粗估"这几个说法，`tokenTotal`、`addTokens`、`cacheHitRate`、`costOf(tokens, price)`（单价每百万 token）、`ledgerOwnerKey`、`usageCategory`、`currencySymbol`。`usage-schema.ts`：`TokenCounts`、`LedgerOwner`、看板上的 `TokenTotalsEventPayload`、单价 `TokenPrice`（`ModelPrice` 是它加上模型）、消耗页的 `UsageSummary`（日期都是 `LocalDate`）。
- `parallel-schema.ts`（20 号票）：卡上的两个决定 `PARALLEL_DECISIONS` / `ParallelDecision`（取自 `CARD_ACTIONS`）；并行确认卡的负载 `ParallelCardPayload`（提议 id、任务、维护者、为什么并行、每个子 agent `ParallelAgent`：id、阶段、可选的步骤、工作说明、目录和有没有自己的目录 `ownWorkDir`）。
- `watch-categories.ts`（26 号票，不引用 TypeBox，类型从 schema 用 `import type` 取）：场景 `WATCH_SCENES`、设置页的操作 `WATCH_CATEGORY_OPS`（常量表，schema 的字面量也用它）和事件里的变化 `WATCH_CATEGORY_CHANGE_OPS`（多一个 `file`）、修复的两种做法、`dispositionsNotLooserThan`（内置类别的下拉）、`isLooserDisposition`、`categoryMatchText`（确定规则写成一句话，设置页、计划卡、素材共用）、`unregisteredTools` / `unregisteredToolsText`（规则里还没登记的工具）、`heldByTasksText`。通知类型 `watch_categories_broken` 和它的动作 `WATCH_CATEGORIES_REPAIR_ACTION` 在 `constants.ts`。`watch-category-schema.ts`：确定规则 `WatchCategoryMatch`（计划里本任务的类别也用它）、设置的样子 `WatchCategoriesState`、`update_watch_categories` 的参数和结果、`watch_category_settings` 事件的负载。`plan.ts` 加了 `grantNarrowingText`（用户的限制里的授权收窄写成一句话），`temporalRuleText` 对带 `trigger.where` 的规则也写"只在满足条件时检查"。
- `constants.ts` 里另有处置的中文名 `DISPOSITION_LABEL`（守护进程的说明、Web 共用），以及紧急度的中文名 `URGENCY_LABEL`、简单提醒状态的中文名 `REMINDER_STATUS_LABEL`（22 号票，守护进程给秘书看的看板和待我处理、Web 共用）。`tasks.ts` 的 `taskName(task)` 是"任务 t-3「整理发票」"这种称呼（秘书看的看板、任务控制快速动作共用）。
- `deleted-event.ts`：`isDeletedEventPayload`，认彻底删除改写后的事件（负载是 `schema.ts` 的 `DeletedEventPayload`，见下面"素材"）。**不引用 TypeBox**。
- `http.ts`：走 HTTP 的那部分的路径（拼 `HTTP_PATHS`，含带偏移的写分片 `uploadChunk(id, offset)`，以及 10 号票的 `access`、`pairing`；拆 `parseHttpPath`；查询参数名 `HTTP_QUERY`）、单文件默认上限、分页大小、媒体 id 的格式、HTTP 错误码（10 号票加了 `unauthorized`、`forbidden`、`too_many_requests`）。**不引用 TypeBox**（也不用 `URLSearchParams`：前端状态层既没有 DOM 也没有 Node 的类型）。
- `parts.ts`：拼附件 part 的小工具：`imagePartFrom(...)`（宽高有就带上）、`attachmentPartFrom(入库后的媒体)`（图片发图片 part，其余发文件 part）、`partLabel(part)`（引用消息时给人看的说法）。
- `http-schema.ts`：HTTP 请求体和响应体（`CreateUploadBody`、`UploadStatus`、`CompleteUploadBody`、`UploadedMedia`、`HistoryPage`、`HttpErrorBody`；10 号票的 `AccessInfo`、`PairingRequestView`、`PairingCreateBody`、`PairingRenameBody`；21 号票的 `MaterialScopeBody`、`MaterialScopeSummary`、`DeleteMaterialsBody`、`DeleteMaterialsResult`），守护进程用 `checkHttpBody(schema, value)` 校验。
- `voice.ts` / `voice-schema.ts`（31 号票）：语音消息的限制（60 秒、1 秒、10 秒倒计时、波形格数）、识别状态 `VOICE_STATUSES` 和中文名、`settledVoiceText`、`voiceIdsOf`、`voiceDurationLabel`、交给 agent 的通知里的写法 `VOICE_TRANSCRIPT_LABEL`（不引用 TypeBox）；`VoiceRecord`、`voice` 事件的负载、`retry_voice` 的参数和结果。语音 part 本身在 `schema.ts`（`VoicePart`、`VoiceWaveform`、`VoiceDurationMs`）。见上面"语音消息"。32 号票加了 agent 发的语音：`AGENT_VOICE_STATUSES`、`AGENT_VOICE_MODES`、`agentVoiceCoversReply`（回复的文字收进语音了吗）、`agentVoiceIdsOf`、参考音色的限制（`REFERENCE_VOICE_*`）；`AgentVoiceRecord`、`agent_voice` 事件的负载、`ReferenceVoice`、`ReferenceVoiceList`、`ImportReferenceVoiceBody`。agent 语音的 part 是 `schema.ts` 的 `TtsAudioPart`（`{ voiceId, mediaId, mime, durationMs, waveform }`）。见上面"agent 用语音回复"。
- `pairing.ts`：设备配对的常量（待批 5 分钟、限频 10 分钟 5 个、凭证 365 天、领取期限、首次使用期限 24 小时、短码和指纹的位数、设备名长度、`WS_CLOSE_UNPAIRED`）和 `defaultDeviceName(userAgent)`、`normalizeDeviceName`、`durationText(毫秒)`（"5 分钟""24 小时""365 天"）、`pairingRequestTitle(设备名)`。**不引用 TypeBox**。配对请求卡的负载 `PairingCardPayload`、已配对设备 `PairedDevice`、`device` 事件的负载、`revoke_device` 的参数和结果在 `schema.ts`。
- 包声明了 `sideEffects: false`：Web 只用到常量、类型和 `nowIso`，打包时 schema 和 TypeBox 被摇掉。
- **加一个请求方法**：`METHODS` 里加名字（有副作用就加进 `METHODS_REQUIRING_IDEMPOTENCY_KEY`）→ `schema.ts` 里定义参数和结果 → `request.ts` 的 `PARAM_SCHEMAS` 登记一项（参数类型 `MethodParams` 和校验器都由它推出）→ 网关 `FrontendConnection.dispatch` 里处理（`switch` 不全 `tsc` 会报）。**加一种频道**：`CHANNELS` 加名字、`schema.ts` 的 `Channel` 加一项（`isChannel` 跟着变）。**加一种事件**：`EVENT_TYPES` 加名字、`schema.ts` 定义负载；前端在状态层 `eventHandlers` 里加归并（临时事件还要加进 `EPHEMERAL_EVENT_TYPES`，前端在 `reduceEphemeral` 里处理）。**登记一种卡片**的协议部分：负载的 schema 写在 `schema.ts`（比如 `ReminderCardPayload`），负载形状改了就把 `CARD_TYPE_VERSIONS` 里它的版本加 1（守护进程登记时核对，前端靠它判断认不认识）。 **加一个 HTTP 接口**：`http.ts` 的 `HTTP_PATHS` 加路径 → `http-schema.ts` 定义请求体和响应体 → 网关 `http-api.ts` 的路由表加一项。

## Web 包（`packages/web/`）

### 页面从哪里来

- **由守护进程提供**（04 号票起的正式方式）：`npm run build:web` 之后，经 LSM 启动的 `ergou-daemon` 在 `http://127.0.0.1:8810/` 提供同一份构建产物。秘书页、卡片、待我处理、任务看板（任务、简单提醒、活动状态）和设置里的已配对设备接真数据（WebSocket），其他页面仍是原型的假数据，页面顶上的原型工具条会写明。外网（经 VPS 的 HTTPS 域名）来的是同一份页面：还没配对的设备只看到配对等待页（10 号票）。
- **直接打开构建产物**（`file://`，没有守护进程）：全部是假数据，用于评审原型。不起开发服务器、预览服务器或任何常驻进程：

1. `npm run build:web`。Vite 加 `vite-plugin-singlefile` 把 JS、CSS 全部内联，产物只有一个文件 `packages/web/dist/index.html`（`dist/` 不进仓库）。
2. 在 PC 浏览器里直接打开这个文件（双击，或者把 `file:///<仓库路径>/packages/web/dist/index.html` 贴进地址栏）。页面用 URL 的 `#` 部分做路由，从文件打开也能刷新、能前进后退。
3. 看手机竖屏：窗口宽于 760 时，页面顶上有一条原型工具条，点"手机竖屏 390"就把应用放进一个 390×844 的框里看；也可以用开发者工具的设备模式，或者直接把窗口拉窄。宽窄按内容区的实际宽度判断，600 以下是竖屏布局（底部横栏），以上是宽屏布局（左侧竖栏、内容区分栏）。主导航按空间自适应（33 号票）：秘书、任务、项目、待我处理、消耗、记忆、设置按顺序放得下的直接显示，放不下的从末尾起收进"更多"，窗口变矮（竖栏）、变窄（横栏）时实时收放。
4. 原型里点按钮只改本地的假状态，刷新页面就回到初始的假数据。

演示一律走守护进程那条路（经 LSM 启动）。

### 目录

| 目录 | 是什么 |
|---|---|
| `src/state/` | **前端状态层**：把事件流归并成界面状态的纯函数，不依赖 React 和 DOM。见下文 |
| `src/app/` | 状态层接到 React（`store.tsx`）、前端连接接口（`connection.ts`）和它的 WebSocket 实现（`ws-connection.ts`）、HTTP 那一半（`daemon-http.ts`、分片续传上传 `uploader.ts`）、新设备的配对接口（`pairing-api.ts` 的 `PairingApi`）、浏览器里"本设备已被吊销"的记号（`revoked-mark.ts`）和"这个页面凭什么被信任"（`access.tsx`）、`#` 路由（地址怎么拆、怎么拼、属于主导航哪一项是纯函数 `route-hash.ts`，测试在 `test/app/route.test.ts`；盯着地址变化的钩子 `useRoute` 在 `route.ts`，它也把前者全部转出）、外观（`theme.ts`、`page-theme.ts`，见下文"外观"）、设置里风格预览的浏览器那一半（`style-preview.ts`、`page-style-preview.ts`，见下文"视觉风格"）、语音播放（`voice-playback.ts` 播放器、`voice-autoplay-setting.ts` 自动播放的开关、`page-voice.ts` 把它们接到页面上、`voice-autoplay.ts` 自动播放，见上面 36 号票）、开在鸿蒙 App 里时的原生桥（`native-app.ts`、`page-native.ts`）和系统返回键用的返回栈（`back-registry.ts`、`page-back.ts`），见下文"鸿蒙 App"；记在这台设备 localStorage 里的东西共用 `device-storage.ts` 的 `DeviceStorage` 类型 |
| `src/model/` | 页面用的领域形状（看板、项目、待我处理、设置）、14 种卡片的负载和动作结果文字、中文标签 |
| `src/util/` | 和界面无关的小工具（时间格式、`nowIso`、分段算的 `sha256.ts`） |
| `src/visual-styles/` | **视觉风格**（39 号票）：风格清单 `index.ts`，token 的名字和写法 `tokens.ts`，地址栏颜色、字体样式表的地址 `page.ts`；每套风格一个目录（`<id>/style.ts` 是 token、名字、字体，`<id>/style.css` 是限定在这套风格下的规则）。纯数据，Vite 配置和页面都引用。见下文"视觉风格" |
| `src/ui/` | 共用部件：会话组件（`conversation/`，秘书和维护者共用一个）、卡片（`cards/`，入口是 `CardPanel`，不认识的卡显示纯文本降级加"去 Web 处理"）、分栏和弹层（`common.tsx`）、主导航（`main-nav.tsx`：竖栏 / 横栏，量长度交给状态层的 `fitNav`，见下文）、页面底部的短提示（`toast.tsx`，`useToast()`）、到点的页面内提示和浏览器通知、被拒请求的提示（`alerts.tsx`） |
| `src/pages/` | 各页面：秘书、任务（看板 + 详情）、项目、待我处理、更多（消耗、设置各页）、配对等待页和批准页 |
| `src/prototype/` | **只属于原型**：假事件、假数据（名字和路径都是明显虚构的）、假连接（`fake-connection.ts`）、配对等待页预览用的假配对接口（`preview-pairing.ts`）、过渡期的分流连接（`split-connection.ts`：接了真数据的频道走 WebSocket，其余走假连接）、看板等假数据的本地状态（`proto-store.tsx`，跟着前端状态层里卡片的变化走，不认具体的连接）。接真数据的票逐步删掉这里的东西 |
| `src/styles/` | `base.css`（外观的开关、通用控件）、`layout.css`（tab、分栏、阶段抽屉）、`look.css`（视觉规矩）三份复制自 AgentSense 再裁剪；`pages.css` 是二狗自己的页面样式，`voice.css` 是语音消息的。这几份就是"经典"的规则，只用 `var(--token)`；token 39 号票起在风格清单里，见下文"视觉风格" |
| `build/` | 构建插件 `visual-styles-plugin.ts`（39 号票）：风格清单生成 token 样式表、往内联脚本里填风格表、把字体拷进 `dist/fonts/` |

### 前端状态层（`src/state/`）

- 输入（`UiInput`）三类：
  - 服务端推来的事件帧 `{channel, seq, type, payload}`。按频道记下最后收到的序号，重复或更旧的直接丢掉；临时事件（`stream`）不推进序号，比已收到的落盘事件旧就丢掉；
  - 本地动作：发消息（`send_message`）、点卡片按钮（`card_action`）、请求失败（`request_failed`）；
  - 连接状态（`connection`）：连接中、在线、断开、页面过旧、凭证失效（`unpaired`，10 号票：外网端口上被吊销或过期，界面回到配对等待页；输入里可以带知道的原因 `reason`，记在 `UiState.unpairedReason`）（`UiState.connection`；会话组件在断开和过旧时提示一行）；
  - 重新同步（`resync`）：清掉一个频道的序号和归并出来的状态（还没确认的乐观显示留着），接下来服务端从头补发；
  - 往上翻取回的一页历史（`history_page`，09 号票）：按序号并进权威消息（已有的不重复），不推进游标；服务端说更早没有了就记下翻到头了。
- 流式：`stream` 事件拼成"正在生成的回复"，在会话视图里是 `kind: "streaming"` 的条目（排在权威消息之后、乐观显示的尾巴之前），id 就是定稿消息的 id，定稿时原地换掉；`turn_end` 时收起。每段增量带 part 下标和字符偏移，对不上（断线漏了中间的、说到一半才打开页面）就标成 `broken`，界面只显示"正在回复…"，等定稿消息。
- 乐观显示：自己发的消息先显示在会话末尾（`pending`），收到带同一个幂等键的 `message` 事件后被替换；请求失败就标成失败。卡片按钮点了先是"处理中"，收到更高版本的 `card` 事件后变成权威状态。
- 对外只用 `reduce`、`replay`、`resumeCursors`（重连时带给服务端的序号）和选择器 `conversationView`、`selectCard`（返回 `CardState`：权威版本加本地还没结果的动作）、`olderHistory`（还能不能往上翻、从哪个序号往前翻）。还没结果的请求统一用 `RequestStatus`（在路上 / 失败带错误）。
- 06 号票起：
  - `cardDisplay(state, cardId)`（`cards.ts`）：认识的类型和版本 → `typed`；不认识的类型、或负载版本比 `CARD_TYPE_VERSIONS` 新 → `fallback`（纯文本降级 `text`，"去 Web 处理"的链接 `#/card/<id>`）；
  - 待我处理（`inbox.ts`）：`inboxEntries(state, "open" | "done" | "archived")`（置顶在前，然后按紧急度三档，同一档新的在前；卡片事项处理没处理看卡片）、`inboxCounts`、`inboxBadge`（未读数 → 小红点；看过没处理的件数 → 灰色数字）、`selectInboxItem`；
  - `selectReminder`：看板频道上的简单提醒；
  - `alerts`：临时的 `notify` 事件变成待提示的通知，界面提示过就送 `alert_seen`；
  - `failures`：和消息、卡片对不上的被拒请求（比如卡着任务的事项不能删、吊销设备被拒），界面提示过就送 `failure_seen`。
- 29 号票起：`workday`（工作日历频道上节假日数据和个人设置的最新样子），`workdayCalendarOf(state)`（还没收到节假日数据是 `undefined`）、`workdaySettingsOf(state)`（`workday.ts`）：设置里的工作日规则页读个人设置，年月选择用节假日数据标出缺数据的年份（35 号票起每天的结果在日历页上，由守护进程按月给出）；改个人设置经 `DaemonHttp.changeWorkday`（原型的 `FakeDaemonHttp` 交给假连接推事件）。
- 10 号票起：`devices`（已配对设备频道上的 `device` 事件，按设备 id 留最新的），`pairedDevices(state, now)`（`devices.ts`）分成有效的（按最近使用，新的在前；还没启用的界面标"等待首次使用"）和失效的（被吊销的、启用后凭证过期的、领到之后一直没用过就作废的，带原因 `InactiveReason`）。`pairingOpening(原因, 记号)`、`revokedMarkAfter(信任情况, 记号)`（`pairing-gate.ts`）：配对等待页怎么开场、浏览器里"本设备已被吊销"的记号怎么变（见下面 `App.tsx`）。
- 12 号票起：`tasks`（看板频道上的 `task` 事件，按任务 id 留最新的）、`activity`（活动状态频道，按 agent id 留最新的）；`boardGroups(state)`（`board.ts`）按协议包的分组表排出看板的五组（任务在前、新近有变化的在前；待触发的简单提醒在运营中，已触发的一次性提醒在最近结束，已取消的不上看板；任务带上它的维护者的活动状态），`selectTask`；计划卡上的勾选、收窄和改过的假设栏变成"确认"的输入 `planConfirmInput(plan, choice)`、实际收窄了的 `narrowedGrantIds`（`plan-card.ts`；授权项列表、生成的文字和停点用协议包的 `plan.ts`）。重新同步看板频道清掉任务和提醒。
- 21 号票起：会话视图里多了 `kind: "deleted"` 的条目（被彻底删除的消息，只有时间，界面显示"这条消息已彻底删除"）：事件本身是"已删除"标记（补发、历史分页里的 `{ seq, deleted }`），或者 `messages_purged` 点了名、没给 `replacement` 的（不刷新也换掉）；给了 `replacement` 的（工具调用记录）换成改写后的样子。卡片频道上改写成标记的旧版本卡片直接忽略。输入框里引用的卡片在 `UiState.quotes`（`quote_card` / `unquote_card`，`quotedCards(state, 会话)`；发消息时清掉）。快速动作卡、记忆删除卡的负载用协议包里的 `QuickActionCardPayload`、`MemoryDeleteCardPayload`；设置里的"删除素材"经 `DaemonHttp` 的 `materialScope` / `deleteMaterials`（原型是 `FakeDaemonHttp` 的假数）。
- 26 号票起：`watchCategories`（关注类别频道上最后一条 `watch_category_settings`，重新同步时清掉），`watchCategorySettings(state)`、`heldByTasksNotice(state)`（删除或调松后还有进行中的任务按确认时的设置检查时的提示）、`builtinChoices`（内置类别的下拉只给不比默认更松的档，"—"的场景没有）、自定义类别的编辑框 `CategoryForm`：名字和规则的检查只有 `categoryRuleOf` 一处，设置页用 `categoryDraftOf`、计划卡用 `planCategoryAdditionOf`，`categoryFormOf` 从现有类别填好，`formUnregisteredTools` 给"登记后生效"的提示；计划卡上的 `planCategoryRows`（每个类别标明来处：全局的、维护者调严的、维护者加的、你加的）和 `userLimitRows(card)`（原话或维护者转述，和编译出的规则、收窄）（`watch-categories.ts`）；待我处理的 `watch_categories_broken` 事项的"去设置页修复"是到设置页的链接；计划卡的勾选多了 `added`（卡上加的类别，变成 `addWatchCategories`）。设置页（`pages/more/WatchCategoriesPage.tsx`）和计划卡上加类别共用 `ui/category-rule.tsx` 的规则编辑。回放用的录制是 `watch-categories`（`test/main/watch-categories.test.ts` 的"演示流程"）。
- 24 号票起：`tokenTotals`（看板频道上的 `token_totals`，按 `ledgerOwnerKey` 留最新的合计，重新同步看板频道时清掉），选择器在 `usage.ts`（见上面"token 账本与消耗"）；看板的 `BoardItem` 任务项多了 `tokens`；`StageView.budget` 多了 `usedTokens`。回放用的录制是 `token-ledger`。
- 15 号票起：`projects`（项目列表频道上的 `project` 事件，按项目 id 留最新的；`deleted` 把项目连同它的维护者会话、游标、引用一起拿掉）；`projectViews(state)`（`projects.ts`）按状态排（使用中、建设中、筹备中、已停用、已归档），带进行中任务数（看板上按项目编号 `projectIds` 涉及它、没结束的任务）、维护者的活动状态和现在能做的动作（`projectActions`）；`selectProject`、`selectableProjectNames`（"发起任务"能选的：没归档的）。
- 16 号票起：`workOrders`（项目列表频道上的 `work_order` 事件，按工单 id 留最新的；项目 `deleted` 时连它的工单一起拿掉；重新同步项目列表频道时清掉）；`work-orders.ts` 的 `projectPipeline(state, projectId)` 是项目页的工单流水线（排队中按派出先后、进行中、已结束最近的在前、最多 10 张；每张带来源、种类、状态、所属任务现在到哪了），`taskWaitingForProject(state, taskId)` 是看板上的"等项目 X"（只在真被项目挡住时：任务有一张它正等着的排着的工单、项目的维护者手上有别的工单；看板项 `BoardItem.waitingForProject` 带着它）。`ProjectView.actions` 是项目状态动作，`archiveBlocked` 是不能归档的原因（项目还有没结束的工单时，放弃、归档按钮不能点，写着 `archiveBlockedText`），`canResetMaintainer` 是重置维护者的入口（项目页上单独一节，二次确认，store 的 `resetMaintainer(projectId)` 发 `reset_maintainer` 请求）。维护者会话的 `segment` 事件不用：分隔线是会话里的工单分隔 part。回放测试在 `recorded.test.ts` 的"两个任务排进同一项目（work-orders-queue）"。
- 36 号票起：事件帧输入可以带 `catchUp`（订阅之后补发的，连接标的）；实时推来的帧让 agent 语音变成合成完成时记进 `agentVoiceArrivals`，`agentVoiceAutoplay` 决定自动播不播；语音气泡框的样子 `voiceBubbleLook`、`agentVoiceBubbleLook`。见上面"语音气泡：自动播放、同框"。
- 33 号票起：主导航按空间自适应（`nav.ts`，纯函数，和事件流无关）。`NAV_ITEMS` 是固定顺序（秘书（界面上叫"个人助理"，36 号票）、任务、项目、待我处理、日历（35 号票）、消耗、记忆、设置）；`fitNav({ available, sizes, more })` 按可用长度（竖栏是高度、横栏是宽度）、每项的长度和"更多"的长度算出直接显示的 `shown` 和收进"更多"的 `folded`：从末尾起收，有收起的才显示"更多"，"更多"自己也要放得下；前 `NAV_MIN_SHOWN`（4）项再挤也直接显示（待我处理的小红点因此总在导航条上），连它们都放不下时导航条自己滚动。`navHighlight(fit, 当前页所属的项)`：直接显示着就高亮它，收进了"更多"（或就在"更多"页上）高亮"更多"。长度由 `ui/main-nav.tsx` 量：导航条里藏一份全部导航项加"更多"的样本（`inert`、不可见、不占地方，和真的 tab 同一套样式），挂上时量一次，之后 ResizeObserver 盯着可用长度和样本，变了才重算；显示哪些 tab 不影响样本和可用长度，不会来回跳。当前页属于哪一项是 `app/route-hash.ts` 的 `navItemOf(route)`；消耗、记忆、设置的地址仍是 `#/more/<页>`（加了 `#/more/memory`：第二阶段的说明），`MorePage` 按收没收起决定它显示在"更多"里还是自己一页，"更多"的菜单只列 `folded`。测试在 `test/state/nav.test.ts`。
- 35 号票起：日历（`calendar.ts`）。`UiState.calendar`：经 HTTP 取回的每个月（`calendar_month` 输入，`DaemonHttp.calendarMonth` / store 的 `loadCalendarMonth`；晚到的旧响应不盖掉手里更新的），和最近一条会让日历变的事件的序号 `changedAt { board, workdayCalendar }`（看板频道上的 `reminder` / `scheduled_job`，工作日历频道上的任何事件；别的看板事件如 `token_totals` 不算）。`calendarMonthOf(state, month)` 给出 `{ view, stale }`：还没取过、或者 `changedAt` 比这份的 `asOf` 大就是旧了，日历页（`pages/CalendarPage.tsx`）重新取，取的时候先接着显示旧的。重新同步看板或工作日历频道时清掉。`calendarCells(view)` 是格子（上班或休息、原因的短词、手动标记、提醒数、作业数（已暂停的不算）、失败数、读屏用的完整说法），`calendarDayDetail(view, date)` 是某一天的详情（原因、节假日、缺数据、提醒的时间内容和触发没有、作业的时间名字项目和结果或预计），`jobPlace(row)` 是点作业去哪（属于项目的去项目页 `#/projects/<p>/jobs/<j>`，不属于的去看板 `#/tasks/jobs/<j>`，那一项高亮并滚到看得见的地方，`ui/common.tsx` 的 `useRevealed`），`calendarYearChoices(state, 今年, 正在看的年)` 是年月选择里的年份（今年前后各 5 年，缺节假日数据的标出来）。主导航的 `NAV_ITEMS` 在待我处理之后加了 `calendar`（地址 `#/calendar[/YYYY-MM | /YYYY-MM-DD]`：看哪个月、展开哪一天；手机上那一天是单独一页，宽屏是日历旁边的面板）；设置里的"工作日历"页换成"工作日规则"（`#/more/workday-rules`，只管额外上班规则；旧地址 `#/more/workday-calendar` 认作它）。日历地址里的月份、日期用协议包的 `parseMonthKey`、`parseLocalDate` 校验，写错了、不存在的当成没带，回到本月。原型的假日历在 `prototype/fake-calendar.ts`（假连接的 `calendarMonth`）。测试在 `test/state/calendar.test.ts`（手写的边角）和 `test/state/recorded-calendar.test.ts`（回放）。
- 34 号票起：外观（`theme.ts`，纯函数，和事件流无关）。`THEME_CHOICES`（浅色、深色、跟随系统，设置里按这个顺序显示）；`themeChoiceOf(存的值)`：认识的原样用，没选过、不认识的都是跟随系统；`resolveTheme(选择, 系统是不是深色)` 是实际用的外观。读写存储、给页面挂标记在 `app/theme.ts`，见下文"外观"。测试在 `test/state/theme.test.ts`。
- 39 号票起：视觉风格（`visual-style.ts`，纯函数）。`visualStyleOf(存的值, 风格清单里的 id)`：清单里有就用，没选过、清单里没有了（删掉的风格、被改过的值）都按经典 `DEFAULT_VISUAL_STYLE`。状态层不认具体有哪几套风格（清单在 `src/visual-styles/`）。测试在 `test/state/visual-style.test.ts`。
- 25 号票起（时间线的缩放、活动状态）：
  - 会话里除了消息还有记录（`ConversationRecord`：`{ type: "timeline", timeline, scope }` 或 `{ type: "operation", operation }`）：`timeline_record`（偏离、范围变更、越界……）和 `quick_action_executed`（快速动作的操作记录，21 号票转来"时间线上可见"）；往上翻取回的一页里落在那一页的记录同样并进来（按序号去重）。操作记录跟着它的快速动作卡：卡片来了新版本（彻底删除时换成去掉原话的），操作记录的标题、参数、结果一起换。`timelineItems(state, 会话)` 是完整视图（消息和记录按序号排，消息带上序号和归属 `scope`；操作记录的时间取它的快速动作卡处理的时间），和 `conversationView` 共用消息的映射；`timelineItemKey`、`timelineItemTime`。
  - `timeline.ts`：`gistView(state, 会话)` 是要点层（`GistRow`：带要点的条目一行，连着的其余条目收起成"收起了 N 条"）；`globalView(state, 会话, 分组?)` 是全局层（`TimelineBlock`：标题、颜色序号 `tone`、几条、时间、第一条的 key、块上的要点），分组 `timelineGrouping`：秘书主线按天，项目维护者的会话（或会话里有工单分隔线）按段（工单分隔 part 起一段，对话段也各成一块，第一条分隔线之前算一个对话段），别的（任务的维护者）按阶段（消息带的 `stageId`；开始执行之前是"规划"，没带阶段的跟着同一任务的上一块）。要点 `TimelineMark`（`marksOf`）：命中关注类别的、通用 bash 的、有样式的工具调用（`isKeyToolCall`），审批卡（带 `cardId`，界面用 `model/cards.ts` 的 `outcomeLabel` 写批了没有），验收结论的进度卡，进要点层的时间线记录（带严重度 `severity`），以及每一条操作记录（命中的类别取它的快速动作卡）。**"被拦下 / 问过"只在状态层推**：要点带样式 `style`（`OP_STYLES`：`granted` 授权内、`notify` 做完告诉我、`stopped` 被拦下或问过）和更细的说法 `reason`（`OP_REASON` 表：`granted`、`notify`、`blocked` 被拦下、`asked` 问过、`explicit` 你点明的、`confirmed` 你确认后），以及结果的文字 `outcome`（被拦下的原因、你拒绝了、等你批准、出错；操作记录执行的结果）。工具调用按守卫的判定（`opReasonOf` / `opStyleOf`：拦下、拒绝、按规则退回、硬拒绝、判定出错是被拦下；处置是先问我、交给我做、永不，或者不在授权内的计划里列了才做是问过；做完告诉我，同时在授权内的也算这个；授权内放行），操作记录按 `basis`（点明的、确认后的算问过或用户决定的，授权内的算授权内）。收起的行 `GistRow` 直接带收起的第一条 `itemKey`。全局层的分组都是 placer（按阶段、按段、按天），颜色在 `TIMELINE_TONE_COUNT` 种之间轮转（界面的色板 `tone-0` 到 `tone-5` 照这个数）。通用 bash 的标记取工具调用 part 的 `genericBash`，带类型的特殊 bash 工具不带；文字 `GENERIC_BASH_LABEL`。
  - 活动状态：`activity` 事件留着说明，临时的 `activity_progress` 记在 `UiState.activityProgress`（只认落盘状态是干活中的 agent；下一条 `activity` 事件到了就作废；比已收到的落盘事件旧的丢掉）；`agentActivity(state, agentId)` 取 `AgentActivity { state, detail? }`（干活中时说明换成最新的进度；没收到过的是休眠，默认值只在这里），`activityNote(activity)` 是说明的文字。看板的任务项和 `ProjectView` 的 `activity` 都是 `AgentActivity`。重新同步活动状态频道两样都清掉。
  - 界面：会话组件（`ui/conversation/Conversation.tsx`）上方的缩放控件在完整、要点、全局之间切换，画法在 `ui/conversation/Timeline.tsx`（要点层、全局层、完整视图里的记录一行 `RecordRow`）；点收起的行或色块回到完整视图并跳到那一条，点工具调用的要点打开它的详情。秘书页、任务详情、项目维护者的会话都用这一个组件。任务卡、任务详情、项目列表和项目页、秘书页的标题栏上是活动状态小圆点，带着说明（没收到过活动状态的维护者显示休眠）。回放测试在 `recorded.test.ts` 的"时间线的缩放和活动状态（timeline-zoom）"、"往上翻取回旧页里的时间线记录（timeline-history）"和"维护者用带类型的 bash 工具干活"，录不出来的（秘书主线跨天、项目的工单段和对话段、偏离、范围变更和越界、按 schema 构造的记录、操作记录的几种 basis 和彻底删除）在 `test/state/timeline.test.ts`。
- 52 号票起（会话条目层，`chat-items.ts`；缩放 54、两侧标注 55、详情页 56、聊天区精简 57 的共同底座）：
  - `chatItems(state, 会话)` 把 `timelineItems` 拆成一条条 `ChatItem`（照 AgentSense 的 `ChatItem` 和 `semanticsOf` / `keyLine`）。种类 `CHAT_ITEM_KINDS`：用户消息（带附件和引用的卡片）、语音（用户的、agent 的）、思考、回复、工具调用组、卡片、系统说明、时间线记录、工单分隔、已删除。每条都有稳定的 `id`、`seq`、`time`、归属 `scope`、底色 `content`（`ContentKind`，图例 `CONTENT_KIND_LABEL`）、要点层那一行 `keyLine`、性质色 `tone`（`OpStyle`）、两侧标注的要点 `marks`（25 号票的 `TimelineMark`）、详情种类 `detail`（`DetailKind`）、`error`，以及挂在它上面的内部工具调用 `internalCalls`。
  - 工具调用组（用户 2026-10-09 定）：两段话之间的调用按先后合成一组，被拦下、问过你、你拒绝了、等你批准、出错的也在组里；没有正文的思考不论长短也并进组。组的 `steps` 按时间顺序列出每一步思考和调用（`ChatGroupStep`），`calls` 是算进"调用了 N 个工具"的调用，`issues` 是出了状况的计数（`CallIssue`、`CALL_ISSUE_LABEL`，`callIssueOf(part)`），性质色取组里最显眼的。卡片（包括审批卡）、系统说明、记录、已删除隔开组；换了 agent、任务或阶段另起一组。每次调用是 `ChatToolCall`（`issue`、结果的说法 `outcome`、`internal`、`counted`）。
  - 内部工具 `INTERNAL_TOOLS`（`isInternalTool`）：会话里已经有卡片、说明或记录代表的工具（提交计划、宣布阶段完成、写进度、写段摘要、口语总结、报进度、计划变更、自行调整计划……），每个写明由什么代表（`shownAs`）。顺利执行时不算进 N：在组里的留在 `steps`，不在组里的挂到这一轮里代表它的那一条（那种卡片、那种记录、系统说明、它总结的回复；找不到就挂在紧挨着的前一条上）的 `internalCalls`。被拦下、出错的照样算进组。
  - id：消息主体用 `timelineItemKey`，思考加 `:think`，卡片、分隔线加 `#part 序号`，组是 `group:` 加第一次算进 N 的调用的 id。往上翻、实时追加之后 id 不变；例外是一组调用跨两页时，翻回来之后组并上更早的调用、id 跟着变。**存了 id 的（详情页、缩放的锚点）一律用 `locateChatItem(items, id)` 找，不直接按 id 比对**：它按条目 id、组原来的 id、组里任一步（调用、思考）的 id、挂着的内部工具调用的 id 都找得到，按调用 id 找的还给出那一次调用。
  - `keyLine` 里守护进程写的话（卡片的纯文本、系统说明、记录）先过 `currentWording`，名字占位留着，界面照 43 号票画成名字标签。
  - 为它从 `timeline.ts` 多导出了 `partMarksOf(state, 条目, part 序号)`（一条消息里某个 part 的要点，`marksOf` 也改成用它）、`toolOutcome(part)`（被拦下的原因、你拒绝了、等你批准、出错）和 `awaitingApproval(part)`（"等你批准"只在这里判）。测试在 `test/state/chat-items.test.ts`（回放 timeline-zoom、task-rejections、秘书的几段录像、work-orders-queue、timeline-history；录不出来的按协议 schema 构造）。
- 56 号票起（详情页，照搬 AgentSense 的 `DetailPane`；取代原来的 `WithToolDetail` 和竖屏的底部弹层）：
  - 状态层 `detail-pane.ts`（纯函数，照 AgentSense `App.tsx` 的 `detail` / `detailBack` / `page`）：`DetailNav { detail, back, page }`，详情**按条目 id 存**（`DetailRef { type: "item", id }`：条目、组里某一步、挂着的内部调用的 id）。`openDetail`（从会话里打开：清空返回栈，窄屏滑到详情页）、`drillDetail`（详情里钻进另一条：来处压栈）、`closeDetail`（标题栏的 ‹：先一层层退，退到底宽屏关右栏、窄屏回会话页）、`revealFromDetail`（"在对话中定位"：窄屏先回会话页，给出要定位的 id）、`systemBack`（鸿蒙的系统返回：没什么可退时是 `undefined`，交给外面）、`layoutChanged`（宽屏变窄屏回会话页）、`detailShown`。宽屏右栏的宽度：`DETAIL_WIDTH_INITIAL` 288、`dragDetailWidth`（260 到外框宽度的 60%）、`detailColumnWidth`（显示宽度封顶在外框宽度的 32%，不少于 240）；`listYields`（外框不到 1200、阶段栏开着、详情开着时任务列表让开）。测试 `test/state/detail-pane.test.ts`。
  - 状态层 `detail-content.ts`：`detailContent(state, chatItems, ref)` 每次用 `locateChatItem` 现查，给出 `DetailContent`：`text`（用户输入、模型思考、模型回复——`markdown`、语音转写 / 语音回复——`voice`、系统说明；`task` 所属任务、`attachments`）、`tool_group`（`title`、`count`、`issues` 每种状况几次、各是第几次、`steps` 按先后的思考和调用）、`tool_call`（`call: CallLine`、`position` 在组里第几次共几次、`itemId` 所在的那一条、`stage` 在做哪个阶段——"第 n 阶段「标题」"，照 AgentSense 的"在做：「里程碑」"）、`card`、`record`（时间线记录、操作记录）、`missing`（`not_found` / `deleted`）。除单次调用外都带 `internalCalls`（挂着的内部工具调用）。`CallLine` 是从工具调用 part 推出的一次调用：编号只数算进 N 的、状况、被拦下的原因、守卫判定 `verdict`（原来 `parts.tsx` 的 `dispositionText`）、`executed`；界面要判断的一律用数据字段——结局 `outcome`、处置 `disposition`、授权 `grant`（`within` / `outside` / `not_needed`），说法另有 `status`、`verdict`、`grantLabel`，不拿说法当条件（语音的详情同样看 `voice.speaker`）。组的 `steps` 里连续 3 次以上、都顺利执行的同一个工具合成一条（照 AgentSense `ZoomHistory.tsx` 的 `runs`）：第一条带 `run: { kind: "head", more, grant }`，界面在它下面挂"还有 N 次同样的操作，都在授权内 ▾"（点开逐条显示，"收起同类操作 ▴"）——"都在授权内"只用在这几次都命中关注类别、在授权内时，都没命中的说"都不需要授权"，两样都有的说"都在授权内或不需要授权"（AgentSense 对应的是"只看，没改动东西"，二狗没命中关注类别不等于只读）；其余带 `run: { kind: "tail", head }`。"顺利"对应 AgentSense 的 plain（执行成功、没被纠正、不用当场确认、没有高危标注）：执行完了、没有任何状况（`issue`）、不是做完告诉我、不是通用 bash、没命中关注类别或命中了但在授权内；中间隔着思考或别的调用就断开。完整参数和返回由界面现取，`callFullContent(ToolCallDetail)` 整理成 `CallFullContent`（`args`、原样 JSON `rawArgs`、`result` 和能解析成结构的 `resultValue`、截断了哪些值 `truncated`、`withheld`、`purged`、图片 `media`、耗时、效果记录 `effects`——每条 `EffectLine { seq, title, summary, objects }`，涉及的对象写成"读 / 改动 / 删除 / 涉及 路径"、"发给 …"、"网址 …"，守卫当时没法确定的注明）。单次调用的详情在"守卫怎么判的"后面列"效果记录"（执行成功的才有）。测试 `test/state/detail-content.test.ts`（回放 secretary-chat、typed-shell-tools、timeline-zoom、task-rejections、voice-message、voice-reply、memory-purge；录不出来的按 schema 构造）。
  - 会话条目层多导出了 `chatItemIdOf(key, part?)`（时间线上一条里各部分在条目层的 id，`chatItems` 自己也用它）：按消息画的会话组件给元素标 `data-item`，打开详情、定位都用它。
  - 界面 `ui/detail/`：`DetailPane.tsx`（外壳和各种详情）、`ValueView.tsx`（参数和返回按字段画，照搬 AgentSense，字段字典换成二狗的工具）、`DetailLayout.tsx`（`useDetail(wide, 会话, conversationRef)` 返回控制器：`nav`、`shown`、`open`、`drill`、`close`、`reveal`——系统返回它自己用 62 号票的 `useBackLayer("overlay", 有东西可退, 退一层)` 接进返回栈：窄屏详情页开着、或者详情里点进去过时挂一层，宽屏只开着一层时不挂（照 AgentSense）；`<DetailLayout wide detail conversation>` 宽屏右栏可拖宽、窄屏整页滑入并盖住底部导航，页面挂到 App 外框的 `.dp-host` 上，底下的会话和导航往左让 30%；外框宽度经 `FrameWidth` 给）。会话组件 `Conversation` 的 `onDetail(id)` 取代 `onToolDetail`，`ref` 给出 `ConversationHandle.reveal(id)`（滚到视口 30% 高处、闪一下 `.dp-flash`）。入口：用户气泡点整条、思考和多段的回复"详情 ›"、工具调用整行（行尾 ›）、卡片"详情 ›"、系统说明和记录点整条、语音在长按菜单里；单次调用的详情里"这一组共 N 次 ›"进组的详情。`DaemonHttp.toolCallDetail(callId)`（404 是 `undefined`，不缓存，每次打开现取）。样式 `styles/detail.css`（只用 token；新加的 token `shadow-slide` 是滑入的详情页左边缘，经典的值在 `visual-styles/classic/style.ts`）。Markdown 用 `react-markdown` + `remark-gfm`（和 AgentSense 同版本，只在回复的详情里用）。
- **加新的事件类型**：在 `ui-state.ts` 的 `eventHandlers` 表里加一项（看板、待我处理、项目列表、活动状态这些频道由各自的票加）；不认识的类型只推进序号。
- 帧、消息、卡片的类型和频道名、事件类型、卡片类型和动作名都来自共享协议包；`src/state/protocol.ts` 只是把状态层和界面要用的那些从 `@ergou/protocol` 转导出来，别处从 `state/index.ts` 取，不写字面量。前端认识哪些卡、认识到哪个版本，看 `CARD_TYPES` 和 `CARD_TYPE_VERSIONS`。卡片的处理结果是结构化的 `outcome: { action, note? }`，显示成文字用 `model/cards.ts` 的 `outcomeLabel`。
- **幂等键**放在 `message` 事件的负载里（`{ message, idempotencyKey? }`），乐观显示的消息靠它被替换。
- 状态层只许引用自己目录里的模块和 `@ergou/protocol`（`test/state/boundary.test.ts` 检查），也不许用 DOM 和 Node 的全局量（`tsconfig.state.json` 不给这两类类型，`npm run typecheck` 会查）。

**回放测试**写在 `packages/web/test/state/`：

- `recorded.test.ts` 回放**主切面录下的真实事件流**（`recordings/*.json`：模拟前端收到的帧，连同它自己的本地动作和连接状态，就是一串 `UiInput`）。录制在 `packages/daemon/test/main/recordings.test.ts`，平时只核对录好的文件和守护进程现在发的事件"骨架"一致（不一致就红，提示重新录），设 `ERGOU_RECORD_EVENTS=1` 跑才覆盖文件。新的主线流程先在那里加一段录制，再在这里回放断言。
- 录不出来的边角（漏掉中间增量、迟到的增量、还没真数据的卡片）手写事件序列：一串事件帧和本地动作交给 `replay`，再用视图函数断言。`test/state/events.ts` 里有造帧、消息、卡片的小工具：

```ts
const state = replay([
  frame("secretary", 1, "message", { message: textMessage("m1", "agent", "早") }),
  { kind: "send_message", conversation: "secretary", idempotencyKey: "k1", parts: [{ type: "text", text: "在吗" }], time: "…" },
  frame("secretary", 2, "message", { message: textMessage("m2", "user", "在吗"), idempotencyKey: "k1" }),
]);
expect(conversationView(state, "secretary").map((it) => it.kind)).toEqual(["message", "message"]);
```

页面本身不单设测试切面，靠用户评审。

**任务详情**（13 号票，`state/task-detail.ts`）：`taskStages(state, taskId)` 是阶段抽屉里的各阶段（`StageView`：执行中的状态、`waitReason`、宣布完成的次数、每条验收标准的方式和结果来自任务的 `stages.list`；交付件、模式、授权行、时序规则、预算来自计划卡上的计划；还没开始执行时按计划列出、都是未开始）；`taskControls(task)` 是详情页上该给的控制按钮（能不能做只看协议包的 `availableTaskActions(task, "user")`，这里只摆按钮：由我验收的阶段的验收通过 / 退回、暂停、继续、继续执行、重试、按阶段返工、取消任务；服务端按同一份再判一次）；`taskAcceptsMessages(task)`（同样看 `availableTaskActions` 里的 `message`：已完成、已取消、已归档的任务不再收消息）。还没开始执行时各阶段按协议包的 `initialStages(plan)` 列出，阶段的授权和时序规则取 `stagePolicies(plan, id)`。任务详情页（`pages/TasksPage.tsx` 的 `RealTaskDetail`）：打开时用 `watchChannels` 订阅它的维护者会话，会话组件就是秘书聊天那个（`mode="maintainer"`，输入框直接下指令），阶段抽屉（竖屏）/ 阶段栏（宽屏）、计划卡（和 15 号票的"转为项目"按钮一起在"计划"栏）、状态行写明等我的原因和失败的原因；看板卡片显示"第 N/M 阶段"和"等我 · 原因"（`TASK_WAIT_REASON_LABEL`）。回放测试在 `recorded.test.ts` 的"两阶段任务到完成、再返工（task-execution）"。

### 前端连接（`src/app/connection.ts`）

13 号票加了 `taskAction(req)`（`task_action` 请求：暂停、继续、取消、重试、返工、由我验收的验收通过或退回）；打开任务详情时用下面 15 号票的 `watchChannels` 订阅它的维护者会话 `maintainer:<id>`。

界面只通过 `Connection` 收发：`connect(cursors, deliver)` 连上后把事件帧、失败的请求和连接状态都变成 `UiInput` 交给状态层；`sendMessage`、`cardAction`、`inboxAction`、`revokeDevice`、`startTask`（12 号票："发起任务"按钮，带用户多选的涉及的项目：选项来自项目列表，15 号票之前由守护进程提供页面时列表为空、只有"不涉及项目"）发带幂等键的请求（卡片动作带期望版本和可选的结构化输入）；26 号票加了 `updateWatchCategories`（设置页改关注类别，被拒的原因进 `ui.failures`）。连接只在 `App.tsx` 里注入一次（`StoreProvider` 的 `connection`），别处（包括原型的假数据）都不认具体的连接：

- 15 号票起多了 `newProject`、`convertTaskToProject`、`projectAction` 和 `watchChannels(channels)`：打开一个项目的维护者会话（或任务详情，13 号票）时才订阅它的会话频道（服务端的订阅是叠加的，再发一次只带这几个频道的 `subscribe`；断线重连时和固定的频道一起订阅）。原型的分流连接把真项目的维护者会话记成接了真数据的频道。
- `WebSocketConnection`（`src/app/ws-connection.ts`）：连上就发 `subscribe`（协议版本 + 每个频道最后收到的序号），断线自动重连（间隔逐步拉长），没得到响应的请求重新订阅之后带同一个幂等键重发；协议版本对不上报"页面过旧"、不再重连；订阅响应里点名重新同步的频道，交给状态层清掉、游标归零。发订阅（包括多订阅）时紧跟着发一个空订阅当回执（不等订阅的响应），回执的响应到之前这几个频道上来的帧带 `catchUp: true`（补发的，36 号票）。给了 `checkAccess`（`App.tsx` 给的是问 `/api/access`）时，断线后先问一下这台设备还被信任吗：凭证失效就报 `unpaired`、不再重连；问不到照常重连。`test/app/ws-connection.test.ts` 用假 socket 测它。
- `App.tsx`：页面由守护进程提供时先问 `/api/access`：`none`（外网端口上还没配对）只显示配对等待页（`PairingWait` + `httpPairingApi`，不连 WebSocket），配对成功后重新加载页面。每次问到结果都按 `revokedMarkAfter` 更新浏览器里"本设备已被吊销"的记号（localStorage，只是一个固定的值）；配对等待页怎么开场由 `pairingOpening(原因, 记号)` 定（`state/pairing-gate.ts`）：新设备自动发起配对请求，被吊销的（这一次知道原因，或者浏览器里有记号——刷新之后服务端已经分不出来了）只显示"此设备已被吊销"和"重新申请"，凭证过期的也等用户点"重新申请"；点了才擦掉记号；问到的结果经 `AccessProvider` 给页面（设置里标出"就是这台"）；用着用着连接报 `unpaired` 也回到配对等待页。设置里"预览配对等待页"（`#/pair/wait`）用原型的假配对接口。然后用 `SplitConnection`，`REAL_CHANNELS`（06 号票起是秘书会话、卡片、待我处理、看板；10 号票起加上已配对设备；12 号票起加上活动状态；29 号票起工作日历；26 号票起加上关注类别）走 WebSocket，其余频道走原型的假连接；`file://` 打开时全用假连接。**接真数据的票往 `REAL_CHANNELS` 里加频道**，全部接完后去掉 `SplitConnection` 和假连接。卡片频道接了真数据之后，原型的假卡片（任务详情里的计划卡、配对批准页……）换到频道名 `proto:cards` 上推给状态层，点它们的按钮仍交给假连接。看板（12 号票起）：任务和简单提醒来自状态层的 `boardGroups`，原型的假看板只补上还没接真数据的定时作业（`ProtoProvider realBoard`，19 号票接）；`file://` 打开时假看板的任务、提醒、定时作业都在，"发起任务"和"建议发起任务"卡上的"发起任务"由假连接推一条 `task` 事件。真任务的详情页目前只有状态和计划卡（13 号票做任务详情页）。

HTTP 那一半（`src/app/daemon-http.ts` 的 `DaemonHttp`：上传附件、往上翻历史、媒体地址；24 号票加了消耗页的 `usage(range)`）同样只在 `App.tsx` 注入一次（`StoreProvider` 的 `http`）：页面由守护进程提供时是 `HttpDaemonClient`（同源），`file://` 打开时是原型的 `FakeDaemonHttp`（假进度、本地预览、没有更早的历史）。界面从 `useStore()` 取 `http`、`loadOlder(conversation)`：

- `uploader.ts` 的 `uploadFile(file, options)`：建上传 → 一片 1 MB 地写 → 分段算 sha256 收尾。网断了（请求抛错或 5xx）报"等待网络"，隔一会儿查服务端已收到的偏移接着传；409 按服务端的偏移来；413、422 这类明确拒绝的不重试。`test/app/uploader.test.ts` 用内存里的假服务端测（含传到一半断网）。
- 会话组件：输入框（`ui/conversation/Composer.tsx`）的附件菜单有图片、文件、作为材料投喂（21 号票：选的附件带 `asMaterial`，聊天里标"作为材料投喂"），选了文件就开始上传，每个附件显示进度、"等待网络"、失败可重试，都传完了才能发送；聊天里图片直接显示（点开看原图），文件点了下载；往上滚到顶（或点"加载更早的消息"）时加载更早的一页，视口停在原来看的那条上。

### 外观（34 号票）

设置里可选浅色、深色、跟随系统（默认），按设备记住（这台设备浏览器的 localStorage，键 `ergou-theme`；跟随系统就是没有这个键），不经协议、不进守护进程的配置。分三层：

- **状态层** `state/theme.ts`：只算——存的值认不认识（`themeChoiceOf`）、选的外观加上系统深浅实际用哪种（`resolveTheme`）。
- **浏览器层** `app/theme.ts` 的 `themeControllerIn(env)`：读写记住的选择（取存储抛错就按跟随系统，写不进去这次打开里照样生效），给页面挂三处——根元素的 `data-theme`（选了浅色、深色挂上，跟随系统去掉）、`<meta name="color-scheme">`（`light` / `dark` / `light dark`）、`<meta name="theme-color">`（手机浏览器地址栏的颜色，和标题栏底色 `--surface` 一致），并监听 `prefers-color-scheme` 的变化（换地址栏颜色、通知界面；颜色本身由样式自己跟着变）。`env` 里的页面、存储、系统深浅都是接口，测试换成假的（`test/app/theme.test.ts`）。`app/page-theme.ts` 的 `pageTheme()` 把它接到真的 `document`、`localStorage`、`matchMedia` 上（单独一个文件，`app/theme.ts` 就能在 Node 里测），`main.tsx` 开场取一次。设置列表顶上的三个选项是 `pages/more/AppearancePicker.tsx`（`ui/common.tsx` 的 `Segmented`，`role="radio"`），用 `useSyncExternalStore` 跟着 `subscribe`。
- **内联脚本** `index.html` 的 `<head>` 里：页面脚本和样式加载之前就按记住的选择挂好那三处，打开页面不先闪一下另一种颜色。它和 `app/theme.ts` 做同一件事（同一个键、同样的三处、同样的地址栏颜色），只是写成不依赖打包的几行 ES5；页面脚本起来后 `themeControllerIn` 再挂一遍（结果一样），之后由它接手。**改一边要改另一边**：`test/app/theme.test.ts` 把内联脚本从 `index.html` 里拿出来在假页面上跑，和 `themeControllerIn` 的结果逐项比对（记住的值 × 系统深浅）。

**颜色 token 的写法**：开关只有一个，根元素的 `color-scheme`——`:root` 是 `light`；`:root[data-theme="dark"]`（选了深色）和 `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`（跟随系统而系统是深色）两处切成 `dark`（`base.css` 开头）。颜色 token 每个只写一次，浅深两个值写在一起：39 号票起 token 写在风格清单里（`src/visual-styles/<id>/style.ts`，写成 `[浅色, 深色]`），构建时生成 `--bg: light-dark(#f5f6f8, #121316)` 这样的样式；浅深一样的写一个值。不要再写 `@media (prefers-color-scheme: dark)` 去改 token，也不要在页面样式里写死只适合一种外观的颜色（白底黑字、`#fff` 背景之类），否则选了另一种外观时那一块还按系统或写死的颜色画。

**地址栏颜色**（39 号票起按风格和外观两样定）：准的是风格清单里每套风格的 `surface`。`app/theme.ts` 和内联脚本用的都是 `visual-styles/page.ts` 的 `stylePageInfo` 算出的同一张表（内联脚本那份是构建时填进去的）；`index.html` 里 meta 的初始值抄的是经典浅色的 `surface`。`test/app/theme.test.ts` 按风格清单逐套比对。

**`light-dark()` 的回退**：它要 Chrome/Edge 123、Firefox 120、Safari 17.5 起。`vite.config.ts` 明写了 `build.cssMinify: "lightningcss"` 和 `build.cssTarget`（和 JS 的 es2022 同一档：Chrome/Edge 94、Firefox 93、Safari/iOS 16.4），构建时 Lightning CSS 按目标把 `light-dark()` 降成跟着 `color-scheme` 切的两个开关变量（`--lightningcss-light` / `--lightningcss-dark`），老一点的 WebView、ArkWeb 照样能切。`test/build.test.ts`（跟 `npm run check` 一起跑，半秒多）照 `vite.config.ts` 构建一遍（按生产环境、不写盘、不动 `dist/`），断言产物的 CSS 里没有 `light-dark(`、有开关变量，内联脚本在 `<head>` 里、在页面脚本和样式之前。开发服务器（`vite dev`）不压缩、不降级，用新浏览器看。

### 视觉风格（39 号票）

设置 · 外观里，"浅色 / 深色 / 跟随系统"下面是"风格"：经典（39 号票之前的样子）、净白格栅，之后 40–42 号票加暖纸手帐（`paper`）、夜航仪表（`night`）、软糖圆角（`candy`），46–51 号票再加六套。风格和浅深色正交：每套都有浅色、深色。按设备记住（localStorage 的 `ergou-style`；经典就是没有这个键），不经协议。**风格只换皮**：页面结构、功能、导航的结构和尺寸逻辑都是共享的，风格只覆盖 token 和样式。取舍见 ADR-0021。

**一套风格 = 一组 token + 限定在这套风格下的规则**：

- **token**：颜色（浅深两个值）、字体、字号阶、圆角、阴影、间距密度、边框。名字在 `src/visual-styles/tokens.ts` 的 `TOKEN_NAMES`（就是样式里的 `--名字`），经典的值在 `classic/style.ts`（要写全），别的风格只写和经典不一样的。页面样式（`src/styles/` 那几份，也就是经典的规则）只用 `var(--token)`。几组容易用错的：
  - **字体三个**：`font-body` 正文；`font-title` 标题（页面标题 `.title`、竖栏顶上的"二狗"、空页的大字、弹层标题、看板和待我处理的分组标题、卡片的类型标签、一节的小标题）；`font-num` 数字（消息时间、语音时长、看板分组的件数、导航上的灰色数字、消耗页的统计数字、日历上的日子）。经典的标题、数字都是 `var(--font-body)`。只用在标题或数字上的展示字体（快乐体、黄油体、Press Start 2P、马善政……）写在 `font-title` / `font-num` 里，栈的后面接 `var(--font-body)` 或别的系统字体顶着；`font-mono` 是代码、短码。
  - **强调色和实色块分开**：`primary` 是强调色（链接、选中的字、进度条这类细条），`primary-fill` 是主按钮这类实色块的底（上面的字是 `primary-text`）；`danger-fill` 是危险按钮的底（字是 `on-color`），`high-fg` 是出错的字。深色下当字用的颜色要亮、当底用的要暗，一个值两头顾不上。改了 `primary` 的风格一般把 `primary-fill` 写成 `var(--primary)`（净白格栅就是），不然深色下主按钮还是经典的蓝。
  - **边框两个**：`card-border` 是有框的卡片（聊天里的卡片 `.xcard`、看板上的 `.bcard`，经典 1px 细线），`panel-border` 是底板 `.card`（设置项、项目页头部这类，经典没有边框）。
- **规则**：`<id>/style.css`，每条都写成 `:root[data-style="<id>"] .xxx { … }`（只在根元素是这套风格时生效，不会漏到别的风格；`test/visual-styles/scope.test.ts` 一条条扫，`@media` 里面也查，`@keyframes` 的名字要以 `<id>-` 开头，不许写 `@font-face` 这类）。根元素上只能再加属性（`:root[data-style="<id>"][data-theme="dark"]` 可以，`:root[data-style="<id>"]:has(…)`、`.类名` 不行），往下接只能是空格（后代）或者 `> body`（`> .别的`、`+`、`~` 不行）：设置里的预览把开头换成 `:host(...)`，见下面"设置里的预览"。整页的东西写在 `:root[data-style="<id>"]` 本身或者 `… body` 上，预览里它们都对应场景最外层。风格自己用的自定义属性以 `--<id>-` 开头（比如 `--grid-icon`），免得和别的风格重名。只放 token 做不到的：比如净白格栅的个人助理的话不套气泡、看板是一行一行的列表、导航换成线条图标。可以给现有元素补 class 或 data 属性好下样式（主导航的每一项有 `data-nav`，输入栏切语音 / 文字的按钮有 `data-to`），不改结构；不要按界面文案（`aria-label`、标题）挂样式，文案一改就失效。
- **怎么变成样式**：`build/visual-styles-plugin.ts`。`main.tsx` 引入 `virtual:visual-styles`，它先引入生成的 token 样式表（经典挂在 `:root`，每套风格——包括经典——另挂在 `[data-style="<id>"]` 上并写全全部 token），再按清单的顺序引入各套的 `style.css`，都在 `look.css` 后面。和别的样式一样经 Lightning CSS 降级、内联进单文件页面。
- **根元素的 `data-style`**：和 `data-theme` 一样由 `index.html` 的内联脚本在页面脚本和样式之前挂好（不闪），`app/theme.ts` 的同一个控制器接手（`style()`、`chooseStyle(id)`）。内联脚本里的风格表（每套的地址栏颜色、字体样式表的地址）是构建时把 `/*VISUAL_STYLES*/ {}` 换成清单生成的那张。记住的风格不在清单里（删掉了）就按经典（`state/visual-style.ts`）。
- **设置里的预览**（`pages/more/StylePicker.tsx`、`StylePreview.tsx`，原理在 `src/visual-styles/preview.ts` 开头）：每套风格浅色、深色各一张，用这套风格自己的 token 和规则现场画一小段固定的场景（自己发的一条、个人助理回的一条、一张带两个按钮的卡片、一排导航图标），**加风格不用为预览做任何事**。每张预览是一个挂着 `data-style`、`data-theme` 的容器：token 本来就每套挂在 `[data-style="<id>"]` 上，容器的 `color-scheme` 按 `data-theme` 定（`pages.css` 的 `.style-preview`）；从 token 算出来的自定义属性（`look.css` 的 `--sys-bg` 这类）也要挂在 `:root, [data-style]` 上，只挂 `:root` 的话预览拿到的是页面那套风格算出来的值。场景放在容器的 shadow root 里，用页面样式表复制的一份（`previewCss`：每套风格规则开头的 `:root[data-style="<id>"]` 换成 `:host([data-style="<id>"])`；挂在根元素本身、`body`、`> body` 上的换到场景最外层 `.preview-page`），所以这套风格的规则在它的预览里生效，页面现在那套风格的规则进不了 shadow root。`.preview-page` 先 `all: initial`：页面（和它那套风格）挂在根元素、`body` 上的可继承属性（字距、字体特性、抗锯齿……）不会经容器继承进预览，token 是自定义属性，不受影响。浏览器那一半在 `app/`：`style-preview.ts` 挂 shadow root、复制改写一次样式表给所有预览共用、给预览里能拿到焦点的元素挂 `tabindex="-1"`（容器有 `inert`，Chrome 102 以前不认），`page-style-preview.ts` 接到 `document`；预览的字体样式表由 `theme.ts` 的 `showPreviewFonts()` 挂，和风格的字体样式表同一段代码（测试 `test/app/style-preview.test.ts`、`theme.test.ts`）。场景用真界面的类名和组件（`PartView`、`.card.xcard`、`.btn`、主导航的 `NavTab`），界面改了预览跟着变；改场景结构时只用不靠外层容器的类名（预览里没有 `.app`、`.conv` 这些外层）。场景里的字挑在 Noto Sans SC 最常用的那一片里，构建时另出一份 `dist/fonts/preview.css`，只收每套风格的 `@font-face` 里管着这几个字的段，设置页挂它：打开设置只为预览多下一个 1.8 KB 的样式表和一片 45 KB 的字体（有字体的风格多了，各再多一两片）。

**字体由二狗自己提供**（不请求外部 CDN：手机经 tailnet 也能用，也不向第三方透露使用情况）：

- 风格的 `fonts` 写 npm 上 fontsource 的包和它的哪份 CSS（比如 `{ package: "@fontsource-variable/noto-sans-sc", css: "index.css" }`），包装进 `packages/web` 的 devDependencies（版本写死，`package-lock.json` 一起提交）。许可证要允许分发（OFL 等），写进票的 Comments。
- 构建时插件照抄包里的 `@font-face`（字族、字重、`unicode-range`、`font-display: swap` 都不动），只留 woff2，生成 `dist/fonts/<风格 id>.css`；用到的 woff2 和许可证拷进 `dist/fonts/<包>@<版本>/`（目录带版本号，同一个地址内容不变）。只在写盘时拷（`test/build.test.ts` 不写盘）。
- 有字体的风格另合一份 `dist/fonts/preview.css` 给设置里的预览（只收管着预览场景里那几个字的 `@font-face`，见上面"设置里的预览"），所以风格 id 不能叫 `preview`。
- 守护进程按 `/fonts/` 提供（见上面"网关"）；外网端口上要设备凭证。`file://` 直接打开构建产物时从旁边的 `dist/fonts/` 取（浏览器不让时用系统字体顶着）。开发服务器（`vite dev`）的 `/fonts/` 直接从 `node_modules` 取。
- 只在选了这套风格时加载：内联脚本和 `app/theme.ts` 只给现在这套风格挂 `<link rel="stylesheet" data-style-fonts href="fonts/<id>.css">`；`@font-face` 按 `unicode-range` 切片，浏览器只下页面上用到的字（净白格栅打开秘书页约 18 片、900 KB，全部 101 片 4.3 MB）。设置页为了预览另挂 `preview.css`，只多下预览里那几个字所在的切片。字体没下好时先用 `--font-body` 后面的系统字体（`font-display: swap`），不会空白。

**测试**（以后加的风格自动算进来）：

- `test/visual-styles/contrast.test.ts`：每套风格、浅色深色下，正文、说明文字、你发的消息、主按钮、链接、"跟你有关的"、出错、通过、各种小签的字和底的对比度（正文 4.5:1，大字 3:1），经典也一样，没有例外（经典原来有 7 处小字不够，39 号票沿原来的色相调深了）。参与对比度、地址栏颜色的 token 要写成 `#rrggbb`、`#rrggbbaa`、`rgba()` 或 `var(--别的 token)`；半透明的按叠在 `--bg` 上算（毛玻璃在不支持的浏览器上退回的样子，字的对比度不能靠模糊撑），`--bg` 自己要不透明（`test/visual-styles/tokens.test.ts`）。
- `test/visual-styles/fonts.test.ts`：有字体的风格都有样式表，按 `unicode-range` 切片、`font-display: swap`、只用 woff2、地址相对且在带版本号的目录里、这套风格提供的每个字体都被 `--font-body` / `--font-title` / `--font-num` 至少一个用到（没提供字体的不查）、许可证在。
- `test/app/theme.test.ts`：选风格、记住、找不到时退回经典、只挂这套风格的字体、地址栏颜色按风格的 `surface`；内联脚本和页面脚本挂出来的逐项一样（记住的外观 × 风格 × 系统深浅）。
- `test/visual-styles/preview.test.ts`：每套风格都有浅色、深色两张预览；`:root[...]` 换成 `:host(...)` 的写法（根元素本身、`body`、`> body` 换到场景最外层）；页面风格挂在根元素上的可继承属性进不了别的风格的预览（场景最外层先 `all: initial`）；每套风格的 `style.css` 换完一条不落。`fonts.test.ts` 里查 `preview.css` 收齐了预览里每个字的段、别的段不收。
- `test/state/visual-style.test.ts`：记住的值怎么认。`test/build.test.ts`：产物里每套风格的 token 都在、规则进了页面、风格表填好了、不请求外部地址；产物的样式复制给预览后每套风格的规则开头都换成了 `:host(...)`，预览容器的 `color-scheme` 降级后带着开关变量。
- 主切面 `packages/daemon/test/main/fonts.test.ts`：`/fonts/` 的类型、缓存、304、跑出目录 404、外网端口要凭证；`gateway.test.ts` 现场构建的那条用例顺带确认构建产物的字体经网关取得到。

**加一套风格**（40–42、46–51 号票照这个做；只动这套风格自己的文件和清单里的一行；要字体的再加一个依赖，`packages/web/package.json` 和 `package-lock.json` 也会变，几张票并行时这两处和清单一样要在变基时合并）：

1. 建 `src/visual-styles/<id>/style.ts`：`export const <id>: VisualStyle = { id, name（界面上的中文名）, blurb（设置里的一句话）, tokens: { … }, fonts?: [...] }`。token 只写和经典不一样的；颜色写 `[浅色, 深色]`。字体只用在标题或数字上的，写进 `font-title` / `font-num`，别动 `font-body`。改了 `primary` 就把 `primary-fill` 也写上（一般是 `var(--primary)`），`danger-fill` 同理。
2. 建 `src/visual-styles/<id>/style.css`：token 做不到的规则，每条以 `:root[data-style="<id>"]` 开头（根元素上只再加属性）。
3. 在 `src/visual-styles/index.ts` 登记：`import` 一行，`VISUAL_STYLES` 里加一行。
4. 要字体的：`npm install -D --save-exact <fontsource 包>@<版本> -w @ergou/web`，在 `fonts` 里写上。
5. 跑 `npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts`：对比度、字体、规则的前缀、内联脚本都自动按新风格查一遍。对比度不够就调颜色。
6. `npm run build:web`，打开 `dist/index.html`，设置 · 外观 · 风格里选它，浅色深色各看一遍（设计稿只画了聊天、任务看板、待我处理、宽屏，其余页面按同一套 token 推）。设置里它的浅深两张预览自动就有，顺带看一眼。

导航（标签、图标在上文字在下、未读数的位置、竖栏的宽度）、页面上有哪些信息和控件，所有风格共用一套，风格只换颜色、字体、圆角、选中态这些样子。设计稿里出现了产品没有的东西不加，写进票的 Comments。必须改共享代码（页面组件、`src/styles/` 里经典的规则、token 的名字）的，写进 Comments 说明原因；新加 token 时给经典一个和原来一样的值，别的风格自动沿用。

## 鸿蒙 App（`frontend/harmony/`，62 号票）

原生壳：第一次打开先填二狗的地址，之后 ArkWeb 加载这个地址，网页还是守护进程提供的那份；App 是一台新设备，第一次要像新浏览器一样配对。不像 AgentSense 把网页打包进 HAP，原因见 `docs/adr/0022`。工程照 AgentSense 的结构：stage 模型、`entry` 模块，HarmonyOS 6.1.1（API 24），bundleName `com.example.ergou`（`AppScope/app.json5`），版本号在同一个文件的 `versionName`。

### 代码

| 文件（`frontend/harmony/entry/src/main/ets/` 下） | 是什么 |
|---|---|
| `pages/Index.ets` | 唯一的页面：地址页、加载二狗的 Web、打不开时的出错页（重试、改地址）、"这不是二狗？换地址"的提示条；返回键；麦克风授权；主页面跳到别的来源时交给系统浏览器 |
| `bridge/NativeBridge.ets` | 原生桥 `window.ergouNative`（javaScriptProxy） |
| `voice/NativeVoice.ets` | 原生录音（63 号票）：AudioCapturer 备好、开始、停止交出 PCM、丢弃、释放，往网页推音量和出错 |
| `common/ServerAddress.ets` | 地址校验（`checkServerAddress`）和来源（`originOf`） |
| `common/AppSettings.ets` | App 自己的设置（preferences `ergou_app`：二狗的地址、外观） |
| `entryability/EntryAbility.ets` | 开场按记住的外观定深浅色；切到后台时 cookie 落盘（设备凭证在 cookie 里） |

App 里的规矩：

- **地址**：必须是 https；为了本机调试，`http://127.0.0.1`、`http://localhost`（端口随意）例外；没写 `https://` 的自动补上，`#` 后面的去掉。只存在 App 的偏好里，不进仓库、不写死在代码里。**改地址**的入口：网页"设置"最上面"在鸿蒙 App 里运行"一栏的"换地址"；网页打不开时原生出错页上的"改地址"；页面加载完 8 秒网页还没调过原生桥（地址填成了能打开、但不是二狗的网站；二狗的网页一打开就会问 App 的版本号），底部出一条"这不是二狗？[换地址] [关闭]"。地址页上按返回键回到网页。换了地址，Web 组件连同原生桥整个重建（白名单是注册时定的）。
- **返回键**（照搬 AgentSense）：网页经原生桥 `setCanGoBack(flag)` 报"现在还能不能在网页里返回上一级"；按返回键时，能的话原生调网页登记的 `window.__ergouBack()`，网页按返回栈退一级——先关最后打开的弹窗、选择器、详情、抽屉，再回这一页的上一级（比如任务详情回看板），不能的话（到了顶层）原生退出 App。网页一侧见下面"返回栈"。
- **深浅色**：网页把设置里的外观（浅色、深色、跟随系统）经原生桥告诉 App，App 用 `setColorMode` 让状态栏、窗口底色跟着变，并记下来，下次开场先按它画（照 AgentSense）。网页自己的深色由网页画（`darkMode(Auto)`、不强制反色）。
- **麦克风**：`module.json5` 声明 `ohos.permission.MICROPHONE`。63 号票起录音走原生（见下面"原生录音"），权限由 `NativeVoice` 在备好录音器时要；没有原生录音的旧版网页还走 getUserMedia，那时 ArkWeb 走 `onPermissionRequest`：只对配好的来源、只给麦克风，App 还没有权限就先向用户申请（系统弹窗）。
- **别的来源**：主页面要跳到别的来源（比如点了回复里的外链）时交给系统浏览器打开；地址本身重定向到别的来源时显示出错页，提示把地址改成跳过去的那个。`mailto:`、`sms:`、别的 App 的链接这类不是 http(s) 的交给系统（`openLink` 按链接找能打开它的应用），`tel:` 拉起拨号界面（`call.makeCall`，没有电话能力的设备退回 `openLink`），都不落到出错页；`about:`、`blob:`、`data:` 留在页面里。
- **WebView 调试默认关**：开着的话，手机接上 USB、任何能跑 hdc 的人都能经 DevTools 看到页面、取走设备凭证 cookie（等于拿到这台设备的二狗权限）。只有 `npm run build:harmony -- --webview-debug` 构建的包才开（`entry/hvigorfile.ts` 把 `-p webviewDebug=true` 写进生成的 `BuildProfile.WEBVIEW_DEBUG`，`pages/Index.ets` 据此开）；调试完装回不带这个参数构建的包。直接在 DevEco 里构建也是关着的。

**原生桥** `window.ergouNative`：只对配好的来源的主框架开放。ArkWeb 把这个对象注入所有框架（含 iframe），所以两层：ArkWeb 自带的白名单（javaScriptProxy 的 `permission`：scheme、主机、写了端口的还有端口，按调用的那个框架的网址查，别的来源的 iframe 调不进来）；每次调用再核对——主框架（`controller.getUrl()`）是配好的完整来源，调用的框架（`controller.getLastJavascriptProxyCallingFrameUrl()`）也是这个来源、而且去掉 `#` 之后和主框架的网址相同，不对就不做事、返回空串、记一条 hilog。残留：同一来源、网址和主框架一模一样的 iframe 分不出来（二狗的网页不用 iframe，这样的 iframe 只能来自二狗自己）。方法都是同步方法（`NativeBridge.ets` 的 `NATIVE_BRIDGE_METHODS`，每个方法开头先过 `allowed()`）；要等结果的回 `Promise<string>`，网页那边拿到的就是 Promise（官方文档"应用侧 new Promise 作为返回值传给前端"）。`asyncMethodList`（`NATIVE_BRIDGE_ASYNC_METHODS`）里的方法拿不到返回值（官方文档"异步方法无法获取返回值"），现在没有用：

| 方法 | 做什么 |
|---|---|
| `appVersion(): string` | App 的版本号 |
| `log(message: string)` | 写进 hilog（tag `ErgouApp`，前缀 `[web]`） |
| `editServer()` | 回到原生的地址页 |
| `setColorMode(mode: "system" \| "light" \| "dark")` | 外观，见上 |
| `setCanGoBack(flag: boolean)` | 返回键，见上 |
| `voicePrepare(userAction: boolean): Promise<string>` | 原生录音：备好录音器（63 号票，见下面"原生录音"） |
| `voiceStart(): Promise<string>` | 原生录音：开始采集 |
| `voiceStop(): Promise<string>` | 原生录音：停下，交出这一段 PCM |
| `voiceDiscard()` | 原生录音：丢掉这一段 |
| `voiceRelease()` | 原生录音：放掉录音器 |

原生往网页推的（原生录音的实时音量、出错、App 放掉了录音器）用 `controller.runJavaScript` 调网页登记的 `window.__ergouVoice(json)`；推之前核对主框架还是配好的来源（`pageFromServer`，和 `allowed()` 同一个口径），跳到了别的地址就不推。

**网页一侧**（`packages/web`）：`app/native-app.ts` 的 `detectNativeApp` 检测 `window.ergouNative`（没有、形状不对、App 拒绝了这个页面都当不在 App 里，一切照旧），`followThemeInApp` 把外观告诉 App，`followBackInApp` 登记 `window.__ergouBack`、把能不能返回告诉 App；`app/page-native.ts` 接到真的 `window` 上，`main.tsx` 开场调 `connectNativeApp()`；设置列表最上面的 `pages/more/NativeAppInfo.tsx` 显示"在鸿蒙 App 里运行"、App 版本和"换地址"。测试用假的原生桥（`test/app/native-app.test.ts`）。63 号票的录音接口：`native-app.ts` 检测（录音这一组方法都在才有 `NativeApp.voice`），包装在 `app/native-voice.ts`。

**返回栈**（照搬 AgentSense 的返回键）：

- 状态层 `state/back-stack.ts`（纯函数，表格测试 `test/state/back-stack.test.ts`）：开着的各层按挂上的先后排，分两种——`overlay`（弹窗、选择器、详情、抽屉：开着就先关它）和 `page`（这一页有"返回上一级"）。按返回键退的是最后挂上的 overlay，没有就是最后挂上的 page，都没有就是到了顶层（`backTarget`、`canGoBack`）。
- 页面上的那一份 `app/back-registry.ts`（各层的关法、变了通知，`test/app/back-registry.test.ts`）和 `app/page-back.ts`（这个页面的那一份，加钩子 `useBackLayer(kind, active, onBack)`）。
- 现在接进来的：`ui/common.tsx` 的 `Sheet`（所有弹窗、确认框）挂 overlay，`TopBar` 有 `onBack` 时挂 page（层级路由就是各页标题栏的"‹ 返回"：任务详情回看板、设置子页回设置、维护者会话回项目页……宽屏不显示返回的就不挂）；会话缩小时先回对话层（25 号票的分段按钮切到要点层、全局层时挂一层，返回回到完整视图，照 AgentSense 的 `level>0 → zoomTo(0)`；54 号票的捏合缩放按同样的规矩接）、语音气泡的长按菜单、会话的详情页（56 号票的 `ui/detail/DetailLayout.tsx`：窄屏详情页开着、或者详情里点进去过时挂一层，先一层层退再滑回会话；宽屏只开着一层时不挂，照 AgentSense）、日历的年月选择面板、待我处理一行的"更多操作"菜单、输入框的附件菜单、竖屏任务详情的阶段抽屉、设置里改了一半没保存的个人助理名字（返回先撤销这次修改，43 号票的设置项）挂 overlay。以后加弹层开着时调一下 `useBackLayer("overlay", 开着, 关掉)`。
- 不在 App 里时没人调 `__ergouBack`，浏览器的行为不变（浏览器自己的返回照旧走 `#` 地址的历史）。

### 原生录音（63 号票）

用户 2026-10-09 要求：在 App 里用系统自带的录音能力解决"麦克风被占用"，又保住按下即录——调研 16 说的"准备好但不使用"。网页的 getUserMedia 只有"开着"（占着麦克风）和"关着"两种状态；原生的 AudioCapturer 多一个 PREPARED：建好了、不采集。官方"音频焦点"一文：开始录制（`start`）时系统才为录音流申请焦点，停止（`stop`）、释放时放掉，所以 PREPARED、STOPPED 的录音器不占麦克风、不挡系统输入法的语音、不亮隐私指示灯（这一条要真机验，见下面）。AgentSense 没有原生录音，照鸿蒙官方的 AudioCapturer 用法写。

- **格式**：16 kHz、单声道、16 位小端 PCM（`SAMPLE_FORMAT_S16LE`、`ENCODING_TYPE_RAW`），60 秒不到 2 MB。网页加上 44 字节的 WAV 头（`app/voice-wav.ts`），按 `audio/wav` 照常上传；守护进程按内容认出 WAV（`media/audio.ts` 本来就认），识别、播放都不用改。
- **音源 `SOURCE_TYPE_MIC`**：查了 OpenHarmony 的录音焦点表（`audio_interrupt_policy_config.xml`，GitCode 上 OpenHarmony-6.0-Release、6.1-Release、master 三份下载核对；Gitee 镜像的 master 还是旧的，和 6.0 一样）。三个版本都一样的：已有 MIC 在录、后来 VOICE_RECOGNITION（输入法的语音多半是它）并存，反过来也并存；已有 VOICE_RECOGNITION、后来 VOICE_MESSAGE（语音消息）：把正在录的暂停；已有 VOICE_MESSAGE、后来 VOICE_RECOGNITION：拒；VOICE_COMMUNICATION（华为浏览器 getUserMedia 用的）在录时后来的 MIC、VOICE_RECOGNITION 都拒，还开 3A。分版本的：6.0 里 MIC→MIC、VOICE_MESSAGE→MIC、VOICE_RECOGNITION→VOICE_RECOGNITION、VOICE_MESSAGE→VOICE_MESSAGE 都是拒，6.1 和 master 改成了并存。MIC 是三种里唯一各个版本、两个方向都能和 VOICE_RECOGNITION 并存的，不开 3A，启动也最轻。焦点表厂商可以覆盖，华为商用版是否一样要真机看。
- **低时延**：ArkTS 的 AudioCapturer 没有低时延模式（`capturerFlags` 文档写"设置为 0 即可"），低时延通路（`AUDIOSTREAM_LATENCY_MODE_FAST`）只在 C 接口 OHAudio 里，要写 NAPI 模块。用户 2026-10-09 定：先在真机上测现在的（`startDelayMs`、`firstDataMs`），不够快再另开票用 OHAudio 做。
- **状态机**（`voice/NativeVoice.ets`，录音器上的建、开始、停、放都是异步的，排成一队一个一个做）：
  - 没有录音器 →（网页进语音模式，`voicePrepare`）要麦克风权限（没有就系统弹框；用户拒过的系统不再弹，按下时 `userAction` 为真，弹"去设置里打开"的框 `requestPermissionOnSetting`）→ `createAudioCapturer` → **PREPARED**（不采集）；回 `{ ok, id, prepareMs, state }`。
  - **PREPARED / STOPPED** →（按下，`voiceStart`）`start()` → **RUNNING**，`readData` 收 PCM（一段最多留 70 秒），每 50 毫秒往网页推一次音量 `{ type: "level", id, rms }`；回 `{ ok, id }`。录音器的回调在留下录音器之前挂好（`listen`），挂不上就放掉它、回备不好。
  - **RUNNING** →（松手，`voiceStop`）`stop()` → **STOPPED**（下一条直接 `start`，不用重建），回 `{ ok, id, pcm（base64）, sampleRate, channels, bitsPerSample, firstDataMs }`；`firstDataMs` 是 `voiceStart` 调进来到第一块数据的毫秒数（单调时钟 `systemDateTime.getUptime`）。上划取消、太短、出错是 `voiceDiscard`：`stop()`、扔掉。
  - 任何状态 →（`voiceRelease`：网页离开语音模式、页面切到后台）`release()` → 没有录音器。App 自己也放：页面 `onPageHide`（切到后台，网页的 visibilitychange 不一定先到）、Web 开始加载新页面（`onPageBegin`）、换地址、页面拆掉，这时往网页推 `{ type: "released", id, reason }`（`background`、`reload`、`server-changed`、`closed`）。
  - 录着的时候被系统打断（`audioInterrupt` 的 `INTERRUPT_HINT_STOP` / `PAUSE`：来电、别的应用要麦克风）：放掉录音器，推 `{ type: "error", id, reason: "interrupted" }`。
  - 每备一次录音器换一个编号 `id`，推过来的都带着，网页只认现在这个录音器的；放掉时还在建的那次建好后马上放掉（回 `cancelled`）。
- **网页一侧**（`packages/web`）：`app/native-voice.ts` 包装这一组方法（解析 JSON、base64，App 回的不对一律当失败、不抛错），`app/voice-native-recorder.ts` 的 `NativeVoiceRecorder` 和浏览器的 `VoiceRecorder` 同一个接口（`VoiceCaptureBackend`：`open` 预热 / `begin` / `stop` / `cancel` / `close`），`VoiceSession` 有 `env.native`（`voice-browser.ts` 从 `pageNativeApp()?.voice` 取）就用它，没有（不在 App 里、旧版 App）照旧用 getUserMedia。手势、上划取消、太短、60 秒自动发送、"准备中"、按下到开录的计时、权限的规矩、不发空白语音（直接看 PCM 样本的最大振幅）、诊断记录都沿用。状态层按后端区分（`state/voice-mic.ts` 的 `backend`）：原生后端不让路——打字、分屏照样备着，没有那 0.5 秒，兜底 (a) 也不管——离开语音模式、切到后台照样放掉。录着的时候 App 说录不下去了（开始不了、被打断、放掉了）：提示、这一段不发、录音器歇着，下一次用到（按下、回到前台）再备好。App 放掉了录音器而这时没在录：记成失效，按下时重新备好（"准备中"）。测试：`test/app/voice-session-native.test.ts`（假的 App）、`test/app/native-app.test.ts`（包装）、`test/state/voice-mic.test.ts`（不让路）；守护进程收 WAV 在 `packages/daemon/test/main/voice.test.ts` 的"鸿蒙 App 的原生录音"。
- **诊断**：原生录的语音 `capture.backend` 是 `native`（浏览器录的是 `web`），`prewarmed` 是按下时录音器已经备好，`startDelayMs` 是按下 → 第一块数据（网页按下到调进 App 的那一截 + `firstDataMs`），`firstDataMs` 是 App 里 `start` 到第一块数据，`prepareMs` 是 `createAudioCapturer` 花了多久（原生的冷启动），`openReason` 是录音器为什么备的，`peak` 是整段 PCM 的最大振幅；`micLog` 里 `open` 是让 App 备好、`ready` 是备好了（`ms` 是 `prepareMs`，`reason` 是 App 报的录音器状态，应当是 `PREPARED`）、`fail` 是备不好（`denied`、`failed: …`）或开始不了（`start: …`）、`close` 是放掉，另有 `released`（App 自己放掉了，`reason` 同上）和 `error`（`interrupted`）。看法同 61 号票：本机 `GET http://127.0.0.1:8810/api/conversations/secretary/messages` 的 `voices[].capture`。App 自己的日志：`hdc hilog | findstr ErgouApp`，有 `voice capturer N prepared in X ms, state PREPARED`、`voice capturer N state RUNNING / STOPPED / RELEASED`、`voice take: B bytes, first data after X ms`、`interrupt: force F, hint H`。
- **真机上怎么验**（签好名装上之后；结果写进 63 号票的 Comments）：
  1. 进语音模式（第一次会弹麦克风权限框，允许）：状态栏的麦克风隐私指示灯**不亮**；`hilog` 里有 `prepared … state PREPARED`、没有 `RUNNING`。
  2. 按住念"ABCDEFG"，松手：回放听开头的"A"在不在；发出去之后在 PC 上看这条的 `capture`：`backend: "native"`、`prewarmed: true`、`startDelayMs`、`firstDataMs`、`prepareMs`。按住时指示灯亮、松手后灭。连录几条，看 `startDelayMs` 有多少毫秒。
  3. 语音模式里点"发起任务"，用输入法的语音：不再提示"麦克风被占用"、能识别；回来按住说话照样即录（`micLog` 里**没有** `close edit-in`，录音器一直备着）。分屏时在另一边用输入法语音同样试一次。
  4. 语音模式里切到别的 App 再回来：`micLog` 里有 `close hidden` 或 `released background`，之后 `open visible`、`ready`；回来马上按住，看 `prewarmed`。
  5. 按住说话的时候来个电话（或别的 App 开始录音）：提示"录音被系统打断了"，这一段不发；之后按住照常（先"准备中"）。
  6. 在系统设置里关掉二狗的麦克风权限再进语音模式：提示到设置里打开；按住时弹"去设置里打开"的框。
  7. 没过的项（比如 PREPARED 时输入法仍报占用、指示灯亮）用 `hdc shell hilog` 搜 `The incoming audio capturer should be denied`、`request rejected` 看是谁拒了谁。

### 构建

```sh
npm run build:harmony
```

- 用 DevEco Studio 自带的工具：先看环境变量 `DEVECO_HOME`，没设就找 `D:\Program Files\Huawei\DevEco Studio`、`C:\Program Files\Huawei\DevEco Studio`（macOS 是 `/Applications/DevEco-Studio.app/Contents`）。实际跑的是 `<DevEco>/tools/node/node <DevEco>/tools/hvigor/bin/hvigorw.js --mode module -p product=default -p module=entry@default -p buildMode=debug -p webviewDebug=false assembleHap --no-daemon`（工作目录 `frontend/harmony`，`DEVECO_SDK_HOME=<DevEco>/sdk`）。工程没有 ohpm 依赖，不用联网。
- `npm run build:harmony -- --webview-debug`：同样构建，但打开 WebView 调试（见上面的风险）；脚本会打一行提醒。别的参数一律报错，免得拼错了以为开了。
- 本机还没有 `frontend/harmony/build-profile.json5` 时先照 `build-profile.template.json5` 生成一份（见下面"签名"）。
- 产物：签过名的是 `frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap`；本机没配签名时只有同一目录下的 `entry-default-unsigned.hap`，脚本会提示怎么签。
- 依赖本机装的 DevEco，所以不进 `npm run check`。鸿蒙工程的 ArkTS 不归根目录的 tsc、oxlint、vitest 管（`.oxlintrc.json` 忽略 `frontend/harmony/**`），类型由 hvigor 编译时查。
- 也可以直接在 DevEco 里打开 `frontend/harmony` 点运行（要先有本机的 `build-profile.json5`，跑一次 `npm run build:harmony` 就有了）。

### 签名（只做一次）

签名材料（证书、描述文件、密钥库、加密的口令）只放在本机，不进仓库：

1. 先跑一次 `npm run build:harmony`，生成本机的 `frontend/harmony/build-profile.json5`（在 `frontend/harmony/.gitignore` 里）。
2. 手机打开开发者模式和 USB 调试，用 USB 连上电脑（DevEco 会把这台手机登记进调试用的描述文件；换手机要再签一次）。
3. DevEco Studio 打开 `frontend/harmony`，File → Project Structure → Project → Signing Configs，登录华为账号，勾上 Automatically generate signature，确定。DevEco 把证书、描述文件、密钥库放进用户目录下的 `.ohos/config/`，把它们的路径和加密过的口令写进第 1 步那份 `build-profile.json5`。
4. 再跑 `npm run build:harmony`，产出 `entry-default-signed.hap`。

- 仓库里只有不含签名的模板 `build-profile.template.json5`。模板以后改了（比如升级 SDK），本机那份不会跟着变：照着改它，或者删掉它重新生成、再点一次自动生成签名。
- 不要用别的工程（比如 AgentSense）的签名材料：描述文件绑定 bundleName，也是那个工程的本机私有材料。
- 根目录 `.gitignore` 忽略 `*.p12`、`*.p7b`、`*.cer`、`*.csr`（放在哪里都不进仓库）和 `frontend/harmony/build-profile.json5`；`frontend/harmony/.gitignore` 另外忽略鸿蒙工程的 `oh_modules`、`build`、`.hvigor`、`.idea`、`local.properties` 等。
- `frontend/test/harmony.test.ts`（跟 `npm run check` 一起跑）检查：整个仓库里会进版本库的文件（已跟踪的，加上没跟踪、也没被忽略的）不带签名材料——没有 `.p12`/`.p7b`/`.cer`/`.csr` 文件，文本文件里没有非空的 `signingConfigs`、口令和材料路径字段、指向这几种文件的路径（检查器自己的两个文件除外）；上面这些路径都被忽略。

### 安装和启动

`hdc` 在 `<DevEco>\sdk\default\openharmony\toolchains\hdc.exe`：

```sh
hdc list targets                                   # 设备号；只连了一台可以省掉 -t
hdc -t <设备号> install -r frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap
hdc -t <设备号> shell aa start -a EntryAbility -b com.example.ergou
hdc -t <设备号> hilog | grep ErgouApp              # App 和网页（ergouNative.log）的日志；PowerShell 用 findstr
```

第一次打开填二狗的地址（公网 HTTPS 域名，或 tailnet 地址），然后按网页的提示配对。要在模拟器或手机上用 `http://127.0.0.1` 连电脑上的守护进程，先 `hdc -t <设备号> rport tcp:<端口> tcp:<端口>` 把设备上的端口转到电脑上。注意转本机端口（8810）时守护进程会把 App 当成本机、直接信任，不用配对，只在调试时这样用；外网端口（8811）的凭证 cookie 带 Secure，在 `http://127.0.0.1` 上能不能配对成功没在真机上验过。

### 调试 ArkWeb 里的页面

照 AgentSense 用 DevTools 连 WebView，但要先用 `npm run build:harmony -- --webview-debug` 构建、装上那个包（默认构建的包关着调试，见上面"WebView 调试默认关"的风险），调试完装回默认的包。

```sh
hdc -t <设备号> fport tcp:9222 localabstract:webview_devtools_remote_$(hdc -t <设备号> shell pidof com.example.ergou)
# 然后 Chrome 打开 chrome://inspect（Configure 里加 localhost:9222），或直接用 CDP
```

## 写代码的约定

- **类型剥离的限制**（守护进程和共享协议包；Web 包由 Vite 打包，但同样遵守，`tsconfig` 一样会查）：
  - 相对导入写 `.ts` 后缀；
  - 只用可擦除的语法：不用 `enum`、`namespace`、构造函数参数属性；
  - 纯类型导入写 `import type`。
  - `tsconfig.base.json` 里的 `erasableSyntaxOnly`、`verbatimModuleSyntax` 会帮你检查。
- **pi 的边界**：`test/pi-boundary.test.ts` 会扫全部源码和测试，越界就红：
  - `@earendil-works/*` 只能在 `packages/daemon/src/runtime/agent-child/` 里引用；
  - 任何地方都不许转导出 pi 的东西（`export ... from "@earendil-works/..."`，或把从 pi 导入的名字原样 `export`）；
  - `agent-child/` 之外不许 import 它里面的模块。
- **个人数据和密钥永不进仓库**：数据目录从配置读，测试一律用临时目录。不要读、不要打印用户主目录下 `.ergou`、`.ssh` 等真实数据。
- 标识符用英文，注释用中文；领域概念用 `CONTEXT.md` 里的词。

## 守卫（`packages/daemon/src/guard/`）

`judgeToolCall(input)` 是一个纯函数：不读文件、不跑命令、不看时钟、不读环境变量（`test/guard/judge-basics.test.ts` 会扫源码检查）。同样的输入永远得到同样的判定。

- **输入**（`types.ts` 的 `GuardInput`）：
  - `call`：工具名和参数；
  - `agent`：秘书（带草稿区）或维护者、子 agent（带项目档案和工作目录），以及工作目录 `cwd` 和工具包（bash、联网开关，可选的工具白名单 `tools`）；
  - `places`：数据目录各区（受保护区域从这里取：配置区、密钥区、数据库区，以及每个项目档案里的历史区 `.history/`，15 号票）、二狗程序目录、用户主目录；
  - `task`：对话里是 `null`；任务里带计划（授权项、本任务的关注类别、各阶段和阶段组的时序规则 `stages` / `stageGroups`）和当前阶段；
  - `effectLog`：效果日志，只有执行成功的调用（授权项按它计次，时序规则只看它）。记录用 `effectRecordsFor` 生成，见下面"时序规则"。时序规则按范围过滤：任务里只看同一个任务的，不属于任务的只看同一个 agent、同一段会话（`segmentId`）的，调用方传全量或先筛过都行；
  - `segmentId`：不属于任务的调用所在的会话段（秘书会话、维护者的对话段），时序规则和效果日志的记录用它；
  - `settings`：全局的关注类别设置，用 `loadWatchCategorySettings(layout)` 从数据目录的 `config/watch-categories.json` 读（示例见仓库的 `config/watch-categories.example.json`；守护进程里经 `daemon.watchCategories.current()` 现取，见上面"关注类别设置"）。本任务的设置（`task.plan.watchCategories`，`TaskWatchSettings`，26 号票起和全局设置分开的类型）是确认计划时的快照，只在全局之上增加、只管任务里：内置类别的处置（`builtin`）、带规则的本任务类别（`custom`：本任务新加的、调严过的全局类别的快照，`{ id, title, match, disposition }`）。判定时和当前全局设置取最严；同一个类别 id 从全局和本任务两处命中时（两份各按各的规则匹配），合并成一条依据、取更严的处置；
  - `facts`：调用方现取的环境事实：文件在不在、真实路径（符号链接、目录联接、8.3 短名）、是否已备份，git 状态（`git[仓库根目录] = { uncommittedPaths, repository?, head? }`），脚本扫描出的联网库或函数，以及给时序规则用的别的事实（`extra`）。要取哪些文件的事实，可以先判一次看 `calls` 里的路径；
  - `tools`：工具注册表，默认 `BUILTIN_TOOL_REGISTRY`，MCP 工具用 `registerTools` 加，按名字找用 `findTool`；守卫认的工具名都在常量 `TOOL` 里；
  - `now`：当前时间（毫秒）；
  - `temporalRules`：调用方另给的时序规则（planguard 格式）。v1 模板和计划里当前阶段、阶段组的规则自动加上，不用放在这里。
- **输出**（`GuardJudgement`）：
  - `hardRefusal`：生效的硬拒绝（不是处置的一档）：文件工具写围栏外、联网开关关着时联网、碰密钥区、工具包没给的工具或没开 bash、子 agent 写项目档案。不为 `null` 时直接拒绝，不问用户、不出审批卡。硬拒绝优先于一切处置，只有两条底线例外：同时命中底线时按底线走，`hardRefusal` 为 `null`，硬拒绝只作为附带原因留在 `findings` 里；
  - `pullBack`：生效的"按规则退回"（违反了的时序规则 id，见下面"时序规则"），也不是处置的一档。不为 `null` 时这次调用不执行、不问用户，说明里写怎么补救，控制器把它计入拉回次数。硬拒绝或处置为"永不"时退回不生效（更硬的说了算），原因留在 `findings` 里；处置为"先问"时先退回，补上前提再问；
  - `disposition`：六档之一，各条处置依据取最严。"计划里列了才做"已经按授权项落成放行或先问，类别本身的处置记在 `findings[].categoryDisposition`；
  - 会不会执行用 `judgementExecutes(j)`：没有硬拒绝、没有退回，处置是 `log_only` 或 `notify_after`；
  - `categories`、`genericShell`、`temporalRules`、`withinGrant`、`explanation`（给模型的说明）；
  - `findings`：每条依据，处置依据（类别、底线、受保护区域、做完告诉我、时序规则）带自己的处置，硬拒绝依据带原因，退回依据（`kind: "pull_back"`）带规则 id；
  - `calls`：实际判定的调用。通用 bash 拆成伪工具调用（`origin: "shell"`），伪工具和带类型的工具同名、参数名相同（比如 `git push` → `git_push`）。
- **文件**：
  - `judge.ts` 判定；`disposition.ts` 六档和取最严；
  - `watch-categories.ts` 内置九类、默认处置、两条底线、设置的校验、对全局设置的一次修改 `editWatchCategorySettings`（26 号票：内置类别只能不比默认松、底线改不动；结果带上改的类别 id）、本任务的设置 `TaskWatchSettings`；`watch-category-store.ts` 从数据目录读设置（唯一读文件的地方；`readWatchCategoryFile`、`parseWatchCategorySettings` 给 26 号票的设置服务用）；
  - `tool-registry.ts` 工具注册表（还有大家共用的 `usesNetwork`、`argEntriesOf`、`describeCall`、只读 HTTP 方法表和 `isReadOnlyMethod` / `isReadOnlyRequest`；`pullOnly` 标"只往下拉"的联网工具，参数上的 `payload` 标请求带出去的数据，只给 v1 模板"读过密钥之后不许往外送"用；以及"一个路径参数会不会删除或整体重写它指向的东西"的唯一一份 `pathReplacement`：判定、规则步骤、v1 模板、`rule-steps.ts` 的 `replacedPaths`（运行时给项目档案留旧版本）都用它）；`grants.ts` 授权项和 `validateGrantChange`；`paths.ts` 路径解析和比较、`agentScope`（agent 的项目范围）、项目档案的历史区 `projectHistoryOf`、`isGitControlPath`（git 的配置和钩子：写入按越出项目目录判，28 号票）、`fromShellDrivePath` / `isWindowsAbsolutePath`（Git Bash 的盘符写法、完整的 Windows 路径，解析路径和关注类别的规则检查共用）、`absolutePathsIn`（一段文字里写着的绝对路径，26 号票）；`secrets.ts` 密钥形态和对外内容（`outboundTextOf`：会联网的工具除路径以外的全部参数，加上 bash 那段命令原文；密钥形态和读过的密钥值；底线和 v1 模板共用）；`secret-files.ts` 认 `.env` 和密钥文件；
  - `shell/split.ts` 用 unbash 拆 bash（每条调用带上它在命令结构里的位置 `order`，`mayRunBefore` 判先后；拿到了守卫看不见的输入的——管道、here-doc 或重定向喂来的标准输入，没法静态确定的词和命令前的赋值，xargs 补上的参数，curl `-K`、wget `-i` / `-e` 这类配置和输入文件——带 `unseenInput`），`shell/programs.ts` 是"命令 → 伪工具调用"的程序表；
  - 时序规则：`planguard/` 是从 AgentSense 照搬的引擎（`expr.ts` 三值表达式、`checker.ts` 过去时规则检查、`spec.ts` 参数规范化，来源和哈希见 `planguard/VERSION`）；`rule-ops.ts` 二狗的扩展运算（`path_within`），加载时注册进引擎；`temporal-rules.ts` 收齐要检查的规则、跑引擎、把命中变成结果；`rule-doc.ts` 规则的形态（`ruleForm`）、触发工具和违反结果；`rule-env.ts` 规则看到的 `$facts`、`$agent`、`$task`；`rule-steps.ts` 参数规范化和规则看到的"一步"；`effect-log.ts` 效果日志的记录；`rule-templates.ts` v1 模板；`rule-validation.ts` 规则校验。

### 时序规则

规格第 9 节。规则格式和 AgentSense planguard 兼容，原样用它的引擎；二狗在规则能用的东西上做了扩展，取舍见 ADR-0005。

- **四种形态**（planguard 的 `require`）：`before`（B 之前必须做过 A）、`not_before`（B 之前不能做过 A）、`check`（当下必须满足某条件，用 `$facts` 里的环境事实）、不写 `require`（一律禁止）。B 是 `trigger.tool`；`for_each`、`when`、`unless`、`message`、`on_violation` 照 planguard。
- **要检查的规则** = v1 模板（`v1RuleTemplates(tools)`，默认生效）+ 当前阶段的 `temporalRules` + 它所属阶段组（`groupId`）的 `temporalRules` + 输入里的 `temporalRules`。
- **"之前"的范围**：
  - 只看效果日志：被拦下、执行失败的调用不在里面，既满足不了 `before`，也触发不了 `not_before`；
  - 效果日志按范围过滤：任务里只看同一个任务的（不管哪个 agent、哪个阶段）；不属于任务的（秘书会话、维护者的对话段）只看同一个 agent、同一段会话（`segmentId`）的。维护者会话跨工单延续，之前工单里的效果不算。07、13 号票传 `task` 或 `segmentId`，日志传全量或先筛过都行；
  - 一条 bash 拆出的几条调用一起判，只算真正可能先执行的：对 `not_before`，`a && b`、`a || b`、`a; b` 里的 a 算 b 之前，排在后面的不算（`git push origin main && rm -f tmp.txt` 不因为后面的 rm 违反"删过之后不许推送"）；同一条管道的各段、同一条简单命令（连同重定向、命令替换）里的调用、同一个循环体里的调用互相都算（`cat .env | curl …`、`curl -d @.env …` 照样违反）。对 `before`，同一条命令里的都还没执行，不算（`npm test && git push` 照样违反）。
- **违反了怎么办**（`on_violation`，`rule-doc.ts` 的 `violationOutcome`）：
  - `pull_back`（二狗的扩展）：**按规则退回**——前提没满足、agent 自己能补救的（v1 的"删除或覆盖前须已备份或已提交""push 前须跑过测试"）。判定输出的 `pullBack` 列出规则 id，这次调用不执行、不问用户，说明写怎么补救；它不是处置的一档，不进"被判过永不的对象"，由控制器计入拉回次数；
  - `block`：**永不**——一律禁止的（force push、项目外 `rm -rf`）和对外内容含密钥、读过密钥文件之后往外送；
  - `confirm` 或不写：**先问我**（和 planguard 一致）——不重复发，以及用户的规则、26 号票编译出的规则没写的；
  - 判断不了的（缺环境事实、参数没法规范化、规则要的值取不到、规则求值出错、规则校验不通过，包括 `trigger.where` 判断不了）一律先问我。
  
  命中列在输出的 `temporalRules`（`ruleId`、`title`、`status`、`outcome`、`message`、`call`），说明写明违反了哪条、怎样才能满足。永不和先问的命中和关注类别的处置一起取最严；退回见上面输出的 `pullBack`。
- **13 号票控制器的硬检查"某个对象被判过永不之后，再对它做对外动作要先问"**：只算关注类别、底线、受保护区域的永不，以及时序规则里 `outcome` 为 `never` 的（一律禁止类规则），也就是 `findings` 里处置为 `never` 的依据；按规则退回（`kind: "pull_back"`）不算，判断不了的也不算。
- **规则能用的东西**（详见 `rule-validation.ts` 开头）：`$current` / `$prior`（工具名、规范化参数 `args`，以及推出来的 `paths`、`recipients`、`content`、`secrets`、`sends`、`outward`）、`$facts`（`files`、`git`、`scripts` 三个列表和声明过的 `extra`）、`$agent`、`$task`、`$now`。字段表和构造它们的代码放在一起：`rule-steps.ts` 的 `STEP_FIELDS`，`rule-env.ts` 的 `AGENT_FIELDS`、`TASK_FIELDS`、`FACT_KINDS`。扩展的运算 `path_within: [路径, 目录或一组目录]` 按 Windows 语义判断"在目录里"。和 planguard 不同，`trigger.where` 判断不了时算判断不了（先问），不当成不触发。
  - `recipients`：显式的收件人、网址（去空白、小写）；没有收件人参数的发送（`git push`、`gh` 评论……）用目标对象当收件人——推送是仓库、远端、分支，别的工具是工作目录加上非内容参数（比如 issue 号）。`content`：对外内容类参数拼在一起；推送的"内容"是推送时 HEAD 的提交号（`headCommit`，由 `facts.git[仓库].head` 补上，没给时是"未知"，不重复发因此判断不了、先问）。
  - `sends`：会不会联网，不管方向（`tool-registry.ts` 的 `usesNetwork`：标了 `network`、`outbound`，或带"以我的名义对外发送"标签）；跑脚本看 `facts.scripts` 的扫描结果，没扫过的是"未知"（读过密钥文件之后跑它就先问）。
  - `outward`：会不会往外送（30 号票）。拿到了守卫看不见的输入的（bash 拆出的调用带 `unseenInput`：`cat .env | curl …`、`curl "…?q=$(cat .env)"`，守卫看不全它发了什么）、带了请求数据的（`payload` 参数有值：`http_request` 的 `data`——curl 的 `-d`、`--data*`、`--json`、`-F`、`-T`，wget 的 `--post-*`、`--body-*`，httpie 的数据项，PowerShell 的 `-Body`、`-InFile`、`-Form`；`network_read` 的 `data`——`gh api -X GET` 带的 `-f`、`-F`、`--input`）为真；只往下拉的为假：注册表标了 `pullOnly` 的（`install_deps`、`install_global`、`git_fetch`（clone、fetch、pull）、`network_read`），以及只读的请求（`isReadOnlyRequest`：方法都是 GET、HEAD、OPTIONS）。别的会联网的为真（推送、建远端仓库、发布、发消息、连远端主机、下载并运行软件包、没标 `pullOnly` 的 MCP 工具……）；不联网的同 `sends`。`unseenInput` 也记在效果日志里，`$prior.outward` 一样准。
  - 联网相关的几个说法别混：`usesNetwork`（会联网，不管方向）、`outbound`（登记：会把内容发给收件人或网址，"不重复发"看它）、往外送（`outward`）和往下拉（`pullOnly`、`isReadOnlyRequest`），见 `tool-registry.ts` 里 `ToolDescriptor` 后面的说明。
- **参数名统一**：`normalizeArgs(tool, args, tools, env, facts?)` 把带类型的工具和 bash 拆出的伪工具调用规范化成同一种形式（参数名照注册表，路径绝对化，不填且默认取工作目录的补上，推送补上 `headCommit`，不符合 pattern / type 的换成"未知"，空值去掉）。
- **效果日志**：守卫接入在工具执行成功后用 `effectRecordsFor(input, judgement, { firstSeq, at, summary? })` 生成记录追加（效果摘要写执行后的效果，见下面"守卫接入运行时"）（规格第 9 节的字段，加上会话段 `segmentId`，bash 拆出、拿到了看不见的输入的再加 `unseenInput: true`；参数是规范化、能存成 JSON 的形式，"未知"存成 `{"$unknown": 说明}`），存在派生视图 `effect_log` 里，见下面"守卫接入运行时"。
- **规则校验**：`validateTemporalRules(rules, { tools, facts? })` 返回 `{ ok, problems }`，每个问题以"规则 <id>"开头。查：键、`trigger` 和 `require` 的形态、工具是否登记、`trigger.where` / `when` / `unless` / `require` / `message` 里 `$current.args.X` / `$prior.args.X` 的参数是否登记、运算和操作数个数、正则、引用的东西是否存在、`modes` 里有没有 runtime、`on_violation`（`block`、`confirm`、`pull_back`）、id 重复或用了 v1 模板保留的 id。13 号票存计划时直接调用；判定时校验不通过的规则一律判断不了。
- **v1 模板**（`rule-templates.ts`，id 以 `v1.` 开头）要的环境事实：
  - 删除或覆盖前要 `facts.git`（包含这个路径的仓库的 `uncommittedPaths`；不在仓库里的目录写 `repository: false`）和 `facts.files[路径].exists`（整体重写时），可选 `backedUp`；缺了就判断不了、先问；
  - **项目档案不在 git 里**，覆盖或删除前由运行时自动留一份旧版本（15 号票），所以 07、15 号票对项目档案里的路径传 `facts.files[路径].backedUp: true`，模板就总是满足；
  - 推送要 `facts.git[仓库].head`（不重复发靠它区分新旧提交）；跑脚本要 `facts.scripts[脚本]`（读过密钥文件之后）。
- **读过 `.env` 或密钥文件之后只拦往外送**（`v1.no-send-after-secret-read`，用户 2026-10-08 定，30 号票）：触发条件是 `$current.outward` 为真，读过之后一律永不；只往下拉的（只读的 GET / HEAD 和下载、装依赖、`git pull` / `fetch` / `clone`）照常按处置走。"之前"照上面的口径，同一管道、同一条命令里先后执行的组合都算。往外送和往下拉的区分只在这条规则里用：联网开关关着时照样一律拒绝，关注类别照旧按方法算（`curl -G -d …`、`gh api -X GET -f …` 是 GET，不落入类别，但读过密钥之后不许做；`Invoke-WebRequest` / `Invoke-RestMethod`（`iwr`、`irm`）和 curl 一样拆成发 HTTP 请求，不写 `-Method` 是 GET）。带类型的工具和 bash 里的同一操作结论一致。
- **对外内容不许含密钥**（`v1.no-secret-in-outbound`，和底线"把凭据写进对外内容"同一套，`secrets.ts`）：对外内容是会联网的工具（`usesNetwork`）除路径以外的全部参数，加上 bash 那段命令原文——GET 的网址（查询串、`https://<token>@host/…` 这类网址里的用户信息）、请求头、请求体、`git clone` / `npm install` 的网址、推送的远端、联网命令的其他参数都算，不管之前读没读过密钥。两种认法：
  - 密钥形态（`SECRET_PATTERNS`）：网址里的 `用户名:密码@`，和像令牌的一长串（20 位以上、字母数字都有）`@` 也算一种；`git@`、纯字母的用户名不算；
  - **读过的密钥值**：agent 读过 `.env` 或密钥文件（放行执行过的读，执行出错的也算：文件工具、bash 的 `cat`、`source`……），守卫接入就把文件里的值收进这个任务（不属于任务的是这一段会话）的内存里（`guard-runtime/read-secrets.ts`，拆值是 `secret-files.ts` 的 `secretValuesIn`：`.env` 每行的值，8 个字符以上；别的密钥文件整段去掉空白），判定时作为环境事实 `facts.secretValues` 交进来。出现在对外内容里（原样、URL 编码、标准和网址安全的 base64，去掉空白也比）就是永不；说明里只写"之前读过的密钥文件里的值"，不带出值本身。**只放内存**：不落盘、不进事件日志；守护进程重启后就没了，"读过之后不许往外送"照旧管着。同一份值也用来擦事件日志，见下面"守卫接入运行时"的"密钥不进事件日志"。
  
  **剩余风险**：密钥被拆开拼接、自定义变形（倒序、换编码、嵌进更长的 base64 里错开对齐……）之后写进网址或参数，正则和读过的值都认不出——读过密钥之后，网址静态的只读请求会放行，只靠这两种认法把关；守护进程重启之前读过的值丢了；`.env` 里 8 个字符以上的普通配置值（比如一个网址）也会被当成读过的值，之后网址里出现它就判永不，要用户处理。

## 守卫接入运行时（`guard-runtime/`、`approvals/`，07 号票）

规格第 3、9 节。子进程里的二狗扩展在 pi 的 `tool_call` 钩子里把每次工具调用（pi 的内置工具、守护进程代为执行的工具都算）发成 `guard_request`，守护进程判定后回 `guard_reply`；放行才执行，拦下的调用不执行，模型收到判定里的说明。守卫从不原地改参数。

- **模块的分工**：`guard-runtime.ts` 的 `attach` 只做编排（判定、按判定分派、在 `tool_call_end` 时记录）；先问我的一次性授权、等审批、超时挂起、事后决定的通知在 `approval-waits.ts`（通知的说法可由 `GuardRuntimeOptions.lateNotice` 换掉：20 号票子 agent 的调用）；交给我做在 `hand-over/`（和 `approvals/` 并列）；聊天里的工具调用记录在 `tool-call-record.ts`；效果日志的写入和效果摘要在 `effect-log.ts`。审批记录、交给我做的事项、两个审批事件都带同一个 `CallOrigin`（`events.ts`：agent、会话、任务和阶段、会话段、来源），13 号票往里加字段。
- **接上一个会话**：拉起时 `forwardToolCalls: true`，拉起后 `guards.attach(proc, { agent, tools, conversation, source, segmentId?, task? })`（`GuardedSession`）。`agent` 是守卫看到的 agent（`GuardAgent`：工作目录、工具包、围栏），`tools` 是这个会话的工具注册表（内置的加上它代为执行的工具的 `descriptor`），`conversation` 是工具调用记录、审批卡引用、给 agent 的通知追加到的会话，`source` 是审批卡上的来源（秘书是"秘书对话"），`task()` 给出调用所属的任务（13 号票接，对话里不给）。秘书在 `startSecretary` 里接；维护者、子 agent 随 12、13、16 的会话装配照这个接。**正式的会话都要接**；只有测试里直接拉起、自己回判定的 agent 不接。
- **判定**：先判一次看要哪些路径和脚本，现取环境事实（`facts.ts` 的 `gatherFacts`：路径参数在不在、真实路径——`fs.realpathSync.native`，还不存在的按最近的已有上级目录展开；维护者和子 agent 项目里的 git 状态（未提交改动和 HEAD，只在项目范围之内往上找仓库）；项目区里的文件算已备份；要跑的脚本的扫描结果），加上这个范围里读过的密钥值（`read-secrets.ts`，只在内存里），再判一次。关注类别设置每次现读（`config/watch-categories.json`，读不了就拒绝这次调用）。效果日志按范围取：任务里只看同一个任务的，不属于任务的只看同一个 agent、同一段会话的。**守卫看到的各区、程序目录、用户主目录、agent 的工作目录都是真实路径**（`daemon.ts` 里展开一次）：测试的临时目录常带 8.3 短名，不展开的话路径比较对不上。
- **按判定**：会执行（直接做只记录、做完告诉我）→ 放行；硬拒绝、按规则退回、永不 → 拦下，模型收到 `explanation`；交给我做 → 拦下，往待我处理里放一个"交给我做"事项（`hand-over/hand-over.ts`；`notice: "hand_over"`，动作 `HAND_OVER_DONE`"已完成"，`body` 和 `data.calls` 里是这次调用的规范化摘要，`data` 的形状是 `HandOverData`），用户点"已完成"后往会话里追加一条交给 agent 的通知；先问我 → 见下。**判定抛错**是单独的结果：拦下、不执行，工具调用记录上 `blockedBy: "judge_error"`、没有处置（不当成"永不"），界面显示"判定出错"。
- **先问我**：先看审批表里有没有同一个 agent、同样调用指纹、事后批准过、还没用掉的一次性授权，并且这次判定命中的关注类别都在当初批准过的类别里（`findOneTimeGrant`），有就放行一次（`approval_consumed`）；多命中了别的类别（比如用户刚加了自定义类别）就重新走审批，授权不用掉。没有就 `approvals.request(...)`：同一事务追加 `approval_requested`（审批表）、审批卡（`approval`，负载 `ApprovalCardPayload`：来源、工具和中文名、参数摘要、命中的类别显示用的名字 `categoryTitles`、守卫的说明；对话里紧急度"不卡任务"，任务里先按"卡着任务"）、待我处理的卡片事项、（对话里）聊天里的卡片引用，审批表在最前；再 `inbox.alert` 提示用户。子进程里这次调用最多等 `approvalWaitMs`（配置 `approvals.waitMinutes`，默认 5 分钟；跟着可注入的时钟）：
  - 期间用户在卡上批准（`approve`）→ 接着执行；拒绝（`deny`，可附说明）→ 拦下，模型收到"用户拒绝了这次调用：……"。卡片动作和 `approval_decided` 同一事务（`resumed: true`）；
  - 超时 → 以"已提交审批，等待用户"拦下，追加 `approval_suspended`（带 `CallOrigin`，对话里任务和阶段为 null）；审批卡仍待处理。回合被中止、子进程退出时同样不再等，审批照旧；
  - 之后用户批准（`resumed: false`）→ 这条审批就是一条一次性授权，往会话里追加一条交给 agent 的通知"……已获用户批准，可以重试"；agent 原样重试时放行一次，再来一次同样的调用重新走审批。之后用户拒绝 → 同样追加一条"……已被用户拒绝"，免得 agent 以为还在等。
  - **调用指纹**（`describe.ts` 的 `callFingerprint`）：agent、任务、阶段（没有阶段时为空）、工作目录、工具名和模型给的原样参数（键排好序）的 sha256，所以一次性授权只在所属阶段有效。不用规范化之后的参数：bash 拆出的伪工具会丢掉命令里的选项，按它匹配就宽了。
- **聊天里的工具调用记录**（`tool-call-record.ts`）：每次调用在 `tool_call_end` 时往会话里追加一条只有一个工具调用 part 的消息（工具名、参数摘要、命中的关注类别显示用的名字 `categoryTitles`、处置（判定出错时没有）、`blockedBy`（硬拒绝 / 按规则退回 / 判定出错，`TOOL_CALL_BLOCKS`）、是否授权内、是否通用 bash、结果 `done` / `error` / `blocked` / `denied` 和结果摘要）。助手的正文在定稿时就落了，工具调用记录排在它后面。
- **完整参数和返回**（`tool-call-details.ts`，53 号票）：工具调用记录只有摘要（参数 160 字、结果 200 字），详情页要完整的。每次调用在 `tool_call_end` 时、追加工具调用记录之前另存一份：守护进程内部频道 `tool_calls` 上的 `tool_call_detail`，负载就是协议包的 `ToolCallDetail`（调用 id、工具和中文名、agent、会话（评审子 agent 没有会话，为 null）、归属、结局、开始判定和结束的时间、模型给的原样参数、工具交回模型的文字（被拦下的是模型收到的说明）、是否出错）。派生视图 `tool_call_details` 记调用 id → 全局序号，外加工具、agent、会话、项目；`findToolCallDetail(store, callId)` 按全局序号读回事件（同一个 id 有几份取最后一份），经 `GET /api/tool-calls/<调用 id>` 取。**为什么不读 pi 的会话文件**：读过的密钥值只在内存里，重启后擦不掉；会话文件只能在 `agent-child/` 里读（ADR-0004）；评审的会话不留、删项目时维护者的会话文件整个删掉。**写之前**：和工具调用记录同一份 `CallPrivacy`（`DetailContext.privacy` 必给；读过的值、认得出的密钥形态换成"（密钥）"，读了密钥文件的不记返回，`resultWithheld: "secret_file"`）；单个值（返回的文字、参数里的每个字符串）超过 `TOOL_CALL_VALUE_MAX_BYTES`（200KB，UTF-8 字节）的只留开头（不切开多字节字符），末尾注明"…（已截断：原长 N 字节，只留开头 200 KB）"，`truncated` 里按 JSON Pointer（`/args/content`、`/result`）列出位置和原长；先擦再截。**归属**：和工具调用记录同一份；评审子 agent 接守卫时带上它评审的任务、阶段、项目（`ReviewInput.scope`）。**二进制**：子进程把结果里的图片块换成 `[image]` 占位（内容不过宿主协议），`tool_call_end.media`（宿主协议 11，形状就是协议包的 `ToolResultMedia`）说明种类、类型和解码后的字节数，原样放进 `media`。**彻底删除**：`memory/purge.ts` 改写某次调用的记录、执行记录时（`targetExecution`）连带它的完整内容（`detailEventsOfCall`）；检索素材的调用按返回里提到的素材 id 另找（`detailEventsOfToolMentioning`：先按视图的工具列筛出检索调用，只看这些）；删除项目时（`projects/deletion.ts`，`detailEventsOfProject`）项目维护者会话里的（含子 agent 的）、维护者的、归属这个项目的（含评审子 agent 的）一起改写。改写函数 `toolCallDetailPurge`：参数里的文字、返回换成删除标记，`purged: true`，去掉 `truncated`、`resultWithheld`。只靠完整内容找到的检索调用，`messages_purged` 不会列出，所以前端不要缓存完整内容，每次现取。**效果记录**（56 号票）不另存：`findToolCallDetail` 对执行成功（`outcome` 是 `done`）、没彻底删除过的现从效果日志里找，放进 `effects`（找不到是空数组）；彻底删除、删除项目改写某次调用的完整内容时，它的效果日志一起改写（`effect-log.ts` 的 `effectEventsOfCall(store, effectCallOf(完整内容), [完整内容的事件])`：记了调用 id 的按调用 id 和 agent 找，旧的按紧跟着找）——通用 bash 拆出来的伪工具和调用记录的工具对不上、评审子 agent 和子 agent 的效果不在维护者名下，原来都漏掉；删除项目时还看维护者会话里每条工具调用记录后面紧跟着的旧效果日志（53 号票之前没有完整内容的子 agent 调用）。宿主协议不用升：调用 id 本来就在 `tool_call_end` 里，效果日志是守护进程自己写的。
- **密钥不进事件日志**（`read-secrets.ts` 的 `CallPrivacy`，30 号票）：工具调用记录、效果日志、审批（参数、参数摘要、守卫的说明）、"交给我做"事项写进事件日志之前过一遍——读了密钥文件的调用（放行执行了，路径参数是读或不知道读写、名字像密钥文件）不记结果，结果摘要和效果摘要里的结果换成"（密钥文件的内容不记录）"；别的文字里出现这个任务（或这段会话）读过的密钥值（原样、base64、URL 编码），换成"（密钥）"（`secrets.ts` 的 `redactSecretValues`）；53 号票评审后，认得出的密钥形态（守卫的 `SECRET_PATTERNS`：`sk-`、`ghp_`、私钥整块、赋值形式的 `token=…` 留下名字、网址里的凭据留下协议和 `@`）不管读没读过也擦（`secrets.ts` 的 `redactSecretShapes`），免得密钥经 bash 输出、命令原文这些别的路径进事件日志、时间线和备份。**pi 的会话文件里模型看到的原始结果不动**（模型要用它；会话区随数据目录备份，和密钥区一样要当密钥看待）。擦不到的：模型自己回复的正文里写出的值、去掉空白才对得上的多行值（私钥原文）、读之前就出现过的、守护进程重启之后才出现的。
- **效果日志**（`effect-log.ts`）：放行、执行成功（`tool_call_end` 不是出错）的调用用 `recordEffects` 追加 `effect_recorded`（`effectRecordsFor`，序号全局连续），派生视图 `effect_log`；读取用 `listEffects(reader, scope)`。被拦下、执行失败的不追加。**效果摘要写执行后的效果**（`effectSummary`）：做了什么（bash 拆出来的带上那段命令）、改动（写、删）和涉及的文件、成功（bash 带退出码，记下来的总是 0）、结果的开头一小段，比如"跑脚本（bash「node calc.js」）；成功，退出码 0；结果：6"。56 号票起每条记上调用 id（`EffectRecord.callId`，通用 bash 拆出来的几条是同一个；视图多一列 `call_id`），详情页按它找一次调用的效果（`effectsOfCall(store, 完整内容的事件)`：调用 id 和 agent 都对上才算，不同 agent 的调用 id 可能撞上）；之前的旧记录没有调用 id，按"紧跟在这次调用的记录后面"找——`legacyEffectEventAfter(store, 完整内容或工具调用记录, 调用)`，详情页、彻底删除、删除项目只用这一份（完整内容之后紧跟着会话里的工具调用记录——评审子 agent 没有——再紧跟着效果日志；还得每一条都没有调用 id、是同一个 agent（知道时）、同一个工具（通用 bash 记的是拆出来的伪工具，不比）才算，中间插了别的就找不到，宁可漏、不认错）。给详情页的样子 `effectView`：摘要原样（写进事件日志前已按 `CallPrivacy` 脱敏），涉及的对象按 `BUILTIN_TOOL_REGISTRY` 的参数规则认路径、收件人、网址（取的时候调用时那份会话的注册表已经不在了，MCP、二狗自己的工具认不出对象，涉及的文件写在摘要里）。彻底删除时 `effectRecordPurge` 连调用 id 一起去掉。
- **自动留旧版本**（15 号票）：`createGuardRuntime({ autoVersioning: { covers, preserve } })`：`covers(path)` 认的路径，环境事实里传 `backedUp`（写的路径和它的真实路径都认才算）；每次放行（直接放行、一次性授权、用户批准都算）之前，这次要删除或整体重写的（守卫的 `replacedPaths`）、`covers` 认的路径交给 `preserve` 同步留旧版本，它抛错就不执行这次调用（`blockedBy: "judge_error"`，模型收到"这次调用没有执行：……"）。项目档案接在这里（见"项目与项目档案"）。
- **审批表**（`approvals/views.ts`）：每条审批的请求记录加上状态（待处理 / 批准 / 拒绝）、是否挂起过、决定时有没有调用在等（`resumed`）、一次性授权用掉没有。`daemon.approvals.get / list / oneTimeGrant`。被杀重启后从审批表恢复（还待处理、没挂起过的记成挂起，不新建卡、不再提示），见下面"被杀后的恢复"。
- **有副作用的调用的执行记录**（`executions.ts`，23 号票）：放行、开始执行的调用，注册表里没标"只读或幂等"（bash 按拆出的伪工具算：每一条都标了才算只读，`isReadOnlyOrIdempotentCall`）、也没标"由执行控制器负责恢复"的（`needsExecutionRecord`）记 `tool_call_started`（`ExecutionRecord`：调用从哪儿来、工具、规范化后的调用摘要 `call`——工具的中文名加参数摘要，"中断：不确定 X 是否已执行"里的 X），结束时记 `tool_call_finished`（成功与否、结果摘要；成功的和效果日志同一事务，排在效果日志后面）。**pi 并行执行一批调用、全部结束才把结果写进会话**：同一批里先做完的那次被杀时结果还没写进去，所以结束的记录留着，等这个 agent 又出了一条助手消息、或者这一轮结束（`message_final`、`turn_end`）才记 `tool_calls_settled` 放掉。派生视图 `tool_executions` 留还在执行的、做完了结果还没写进会话的、被中断的。子进程意外退出时还没结束的记 `tool_call_interrupted`（`interruptionEvents`：不属于任务的同一事务在待我处理里放一条"中断不确定"）；**守护进程停止时（`guards.stop()` 在停止流程里最先叫）子进程被结束不算中断**，还没结束的留到下次启动时按被杀恢复；停止期间来的判定请求一律不放行。重新拉起、接着会话时补会话文件用的结果在 `interruptedToolResults(reader, agentId)`（agent 管家的 `interruptedToolResults` 选项现取）：等审批的"没有执行"，做完了的"已经执行完了（结果……），不要重做"（不算出错），失败了的"执行失败了"，被中断的"不确定是否已执行，不要自己重做"。
- **秘书的草稿区**：数据目录临时区里的 `tmp/scratch`（`DataDirLayout.scratch`），是秘书的工作目录。秘书的 pi 工具列的是 `read`、`write`、`edit`、`ls`、`grep`、`find`、`bash`（`SECRETARY_PI_TOOLS`），秘书不能联网，按下面的装配规则实际拿到的没有 `grep`、`find`。秘书只有一条长期主线会话，整条是一段（`SECRETARY_SEGMENT_ID`，效果日志和时序规则按它划范围，不借用 agent id）。草稿区里的写、改、删不落入任何类别；项目档案只读；别处读、bash 碰到别处的路径是"越出项目目录"（对话里先问）；别处写直接拒绝；受保护区域写入永不、密钥区连读都拒绝（都在守卫里判）。
- **不能联网**（尽力而为）：联网的工具和命令由守卫拒绝；要跑的脚本执行前扫一遍（`script-scan.ts`：Python 的 `import requests` / `urllib.request` / `socket`……、Node 的 `fetch(`、`require('https')`、`axios`……、字符串里调 `curl` / `wget`、shell 脚本里的联网命令），用到的作为 `facts.scripts` 交给守卫，联网开关关着时拒绝并提示"联网请发起任务"。**没扫到不等于没联网**：联网开关关着时，要跑的脚本判定时还不存在（同一条命令里先写再跑，比如 `echo … > x.py && python x.py`）、读不了或看不出是哪个，守卫按规则退回（`pullBack: ["script_not_checked"]`，`SCRIPT_NOT_CHECKED`），说明"先用 write 写好脚本再运行，以便执行前检查"——和时序规则里"判断不了"的算法一致。联网程序的名单（`curl`、`wget`、`ssh`……）只有守卫 `guard/shell/programs.ts` 的 `NETWORK_PROGRAMS` 一份，脚本扫描也用它。agent 管家对联网开关关着（`SpawnAgentRequest.network` 默认 false）的 agent，把 pi 的 bash 换成同名的一份（`runtime/agent-child/session.ts` 的 `shellOverrides`），起进程前往环境里加 `OFFLINE_SHELL_ENV`（`process/child-env.ts`：`HTTP(S)_PROXY`、`ALL_PROXY` 等设成 `http://127.0.0.1:9`，`NODE_USE_ENV_PROXY=1` 让 Node 的 fetch 也走代理）。子进程自己的环境不受影响（它要连模型）。宿主协议的装配参数因此多了 `shellEnv`（协议版本 3）。
- **联网开关关着时的装配规则**（`agent-manager.ts` 的 `assembledPiTools`，所有会话通用，不写在谁的工具列表里）：联网开关关着的会话（秘书、联网关着的维护者）装配时不给 pi 的 `grep`、`find`（`DOWNLOADS_ON_FIRST_USE`：它们第一次用时会去网上下载 rg、fd），要搜索就在 bash 里用 Git Bash 自带的 grep、find。守卫眼里的工具包也照这个算。契约测试在 `test/contract/shell-env.contract.test.ts`。

## 带类型的 bash 工具（`typed-shell/`，28 号票）

规格第 9、21 节。维护者干开发类的活时常用的 bash 操作，参数是结构化的，守卫不用拆命令就知道它落在哪些类别里。

- **登记**：在守卫的工具注册表里（`guard/tool-registry.ts` 的 `TYPED_SHELL_TOOLS`，来源 `typed_shell`）：类别标签、"做完告诉我"、"只读或幂等"（只有状态和差异）、要联网。和通用 bash 里的同一操作同名、参数名相同（`git push` 拆出来就是 `git_push`），时序规则、授权项、v1 模板对两者一视同仁。工具参数 schema 里的参数名都要在登记里（`test/typed-shell/tools.test.ts` 查）。仓库路径除了状态和差异都按"写"登记（推送会更新远端跟踪分支、建远端仓库会加远端），所以写入受保护区域一律永不；状态和差异是读，按规格第 9 节读的规则（密钥区连读都拒绝，读配置区、数据库区、程序目录是越出项目目录）。
- **执行**：它们是守护进程代为执行的工具（`HostTool`，但 `descriptor` 就是注册表里那一份，`AgentSession` 不再加一遍）。`createTypedShell({ parentEnv, homeDir, timeouts, ghCommand?, log })` 在 `daemon.ts` 里建一份；`toolsFor({ cwd, toolkit })` 给一个会话的八个工具，**bash 关着时一个都没有**；`runScript({ cwd, script, network, timeoutMs, signal? })` 用同一个启动器跑一段固定的脚本（13 号票的阶段验收）。拉起会话的模块把它们放进 `hostTools`，pi 的工具里同时给 `bash`（维护者在 `maintainers.ts` 按工具包装配：起草计划时都关着（测试可以经 `maintainerToolkit` 给），执行时照确认的计划（13 号票）；秘书的固定工具里没有它们）。
- **怎么跑**：仓库路径和守卫一样解析（`normalizeArgs`：不填是工作目录，相对路径相对工作目录，`/d/x` 也认），在 Git Bash 里以它为当前目录执行。**模型给的值一律不上命令行**：Git Bash 是 MSYS 程序，它的运行时会把命令行上的参数当通配符展开（`*.ts` 变成文件名）、当响应文件读进来（`@secret.txt` 变成文件内容）；命令行上只有固定的脚本，值经 stdin 按 NUL 分隔送进去，脚本开头 `mapfile -d ''` 读进 `"$@"`，不拼进脚本、不被 shell 再解释。Git Bash 起 Windows 程序时也不改写参数（`MSYS_NO_PATHCONV=1`，不然 `/x/y` 会变成 `X:/y`）。所有 git 调用固定加 `-c core.fsmonitor=`（`core.fsmonitor` 可以是一条命令，状态和差异是"只读或幂等"，不能被仓库配置变成执行命令）。推送只收已配置的远端名（先 `git remote` 核对，不收网址和本机路径）。环境是 `buildChildEnv` 的系统变量白名单（没有守护进程的密钥；推送、建远端仓库靠本机已登录的 git 和 GitHub 命令行，二狗不注入凭据），联网开关关着时另加 `OFFLINE_SHELL_ENV`。**每次调用一个 Job 对象**（`runner.ts`）：先起闸门进程（`process/gated-spawn.ts` 的 `spawnGated`，和 MCP 服务进程共用），放进 Job 之后才告诉它要跑什么（值经 `stdin: { values }` 送），Git Bash 和它起的一切都在里面；跑完、超时、被中止时关掉 Job，整棵进程树（含孙进程、孤儿）一起结束。不放进 agent 管家的 Job：那里按"从活着的 agent 子进程走不到"回收孤儿，守护进程直接起的进程会被当成孤儿。
- **结果**：第一行一句话（聊天里的结果摘要、效果摘要都取开头：提交号和文件、"测试通过"……），第二行一个 JSON（结构化字段），后面可能跟着差异或输出的结尾。执行失败（git 出错、退出码非零、合并有冲突、超时、被中止）一律按出错交回，不进效果日志。合并有冲突时中止合并，工作目录回到合并前，冲突文件列在结果里。
- **项目约定**（`conventions.ts`，跑测试、构建两个工具的说法在它的 `PROJECT_TASKS` 一张表里）：跑测试、构建只跑工作目录里已有的约定——package.json 的脚本（`npm run <脚本> -- <附加参数>`，附加参数交给项目自己的测试、构建工具）、Makefile 的目标、`cargo test` / `cargo build`、`go test ./...` / `go build ./...`。**make、cargo、go 一律不收附加参数**：make 的"变量=值"会展开进配方，cargo 的 `--config` 能设 runner，go test 的 `-exec` 能跑任意程序。装依赖按锁文件认包管理器，**只收注册表里的包名**（可以带版本号或版本范围；npm 的包名、crates.io 的包名、Go 的模块路径各一个正则）：选项、本机路径、`file:`、`link:`、git 网址、绝对路径、`..` 一律不收。
- **固有缺口：项目代码本身能执行**。提交会跑仓库的 git 钩子，跑测试、构建会跑项目里的脚本和 Makefile，agent 能用文件工具或 bash 改它们。带类型的工具只负责分类（守卫按类别判），不额外提供隔离。收紧的一处在守卫里：写工作目录（或秘书草稿区）里的 `.git/config`、`config.worktree`、`.git/hooks/` 下的文件（worktree、子模块的同样算；`guard/paths.ts` 的 `isGitControlPath`），文件工具和 bash 都按"越出项目目录"判——写它们等于让之后的 git 调用执行任意命令。
- **超时**：跑测试、构建、装依赖声明 `shellTools.longCallMinutes`（默认 30 分钟），别的按 `agents.toolCallMinutes`。到点管家中止这一轮，`HostToolCall.signal` 随之中止，关掉 Job；工具自己另有一个多 5 秒的兜底计时。
- **测试**：工具本身（`test/typed-shell/tools.test.ts`）按 `HostTool` 接口直接调用、在临时目录的真实 git 仓库上跑；主切面 `test/main/typed-shell.test.ts`；守卫切面 `test/guard/typed-shell.test.ts` 和场景文件 `typed-shell-tools.guard.json`。值原样到达（`*`、`?`、`@文件`、`$(…)`、`%PATH%`、反引号）的用例在 `tools.test.ts` 的"值原样到达"，装依赖用 PATH 上一个假的包管理器（bash 脚本，打出收到的参数）。测试底座：`test/helpers/git-repo.ts`（`initRepo`、`bareRemote`、`git`……：测试进程自己跑 git 时不读用户的 git 配置和凭据，远端是临时目录里的本地裸仓库）、`test/fixtures/fake-gh.mjs`（假的 GitHub 命令行：`startTestDaemon({ ghCommand: [process.execPath, 它, 记录文件, 放裸仓库的目录] })`）、`startTestDaemon({ maintainerToolkit })`（13 号票按计划装配之前，给维护者一个开了 bash 的工具包）。**测试里不要让真的 `gh` 跑**。

## 被杀后的恢复（`recovery/`，23 号票）

规格第 17 节。LSM 每次重启都连带杀掉守护进程，Job 对象把所有子进程一起清掉（`job-object.test.ts`）；守护进程重新起来后，正在做的事按规则恢复，不乱、也不悄悄重做有副作用的操作。`daemon.ts` 里分两步：

1. **`scanBeforeStart(store, tasks)`**（任何 agent 会话开始之前）：记下被杀时正处理到一半的任务维护者（任务自己的维护者里有 `turn_start`、没有 `turn_end` 的输入——agent 会话 `start()` 时会把它标成中断，所以要先看）。
2. **`recoverAfterRestart(...)`**（各模块都接上之后：执行控制器订阅好了，agent 会话标好了中断的输入；开端口之前）：
   - **待审批的从审批表恢复**：还待处理、没挂起过的记成挂起（`approval_suspended`）——审批卡还是原来那张、仍待处理，不新建卡、不推 `notify`；任务里的由执行控制器让这一支停下（都在等时任务转等我，原因"审批"）。这次调用不算说不清做没做完。用户事后批准照 07 号票：`resumed: false`，记成按调用指纹的一次性授权，维护者收到"……已获批准，可以重试"，原样重试放行一次；
   - **被杀时正在执行的有副作用的调用**（`tool_executions` 里还在执行的）记成中断（`tool_call_interrupted`）：任务里的任务转为等我（见上面"任务执行与阶段验收"的"中断不确定"），不属于任务的（秘书会话、项目维护者的对话）同一事务在待我处理里放一条 `interrupted`（`non_blocking`，动作 `INTERRUPTED_ACK`"知道了"）。运行时不自动重做；
   - **被打断的任务维护者**：任务还在规划中、执行中，又没有别的输入等着唤起它的，给它一条通知 `RESTART_WAKE_TEXT`（幂等键 `restart-wake:<被打断的输入 id>`），接着做刚才的事。只读或幂等的调用被打断的，会话文件里补着"这次调用被中断了"（`INTERRUPTED_TOOL_RESULT`），由模型决定要不要重做；任务不转等我。
- **会话文件的修补**在子进程那一层（`runtime/agent-child/session-recovery.ts`，接着会话时做，契约测试 `session-recovery.contract.test.ts`）：去掉末尾写到一半的一行（输出到一半的回复不留碎片；pi 的流式增量本来就不落盘）；最后一个回合（pi 的回合：一条助手消息加它要调用的工具的结果）里还没有结果的工具调用补上一条工具结果，回合就完整了——没有结果的不只是被杀时正在执行、正在等审批的，同一批里先做完、结果还没写进会话的也是；结果按工具调用 id 取守护进程给的（`interruptedToolResults`，见上面"守卫接入运行时"的执行记录），没给的用默认的那句（出错，"需要的话再调用一次"）。已经补过的不会再补。
- **"只读或幂等"**看工具注册表（03、28、各代为执行的工具的 `readOnlyOrIdempotent`）：没标的一律按有副作用算；bash 按拆出的伪工具算，每一条都标了（`cat`、`ls`、`tail` 这类读）才算只读。另有"由执行控制器负责恢复"（`recoveredByController`）的不算说不清做没做完。
- **单实例**：`startDaemon` 一开始先看 pid 文件和本机端口（`daemonRunning`），同一个数据目录已经有实例在跑（被重复启动了）就抛 `DaemonAlreadyRunning`，什么状态都不碰（不然下面的恢复会把正在跑的实例里正在执行的调用当成中断的）；`main.ts` 以退出码 1 退出。pid 文件由 `startDaemon` 在开好端口之后写、全部停完才删（被杀时留着，下次启动按"进程已经不在了"看待）。
- **彻底删除的口径**（21 号票）：执行记录里的调用摘要、结果摘要登记了改写函数（`executionPurges`）。彻底删除一次调用（"记住"的提议、审批决定、检索记录对应的那次）时，同一段调用摘要出现的地方一起改写：执行记录、"中断不确定"事项的标题和正文、任务等我的说明（`taskWaitNotePurge`，只改 `waitNote`）、维护者会话里的系统说明和给它的通知（整条换成"已删除"）。删除项目时改写那个维护者的执行记录和他对话里的"中断不确定"事项。
- **子进程意外退出**（守护进程没被杀）时同一套：守卫接入看到子进程退出、还有开始执行没结束的有副作用调用，记成中断（任务转等我、秘书会话里放事项）；重新拉起时同样补会话文件。只是被打断的维护者不额外唤起（照 12 号票：有输入才再唤起）。秘书为改写会话文件、换装配主动重启子进程（21、13 号票）只在闲着时做，没有调用在执行，不算中断；守护进程停止时结束子进程也不算（留到下次启动按被杀恢复）。
- **子 agent**（20 号票）同一套：子 agent 经一次性子进程接守卫（`agent-manager/one-shot.ts`），它放行、开始执行的有副作用调用一样记执行记录（`origin.agentId` 是 `sa-<n>`，任务、阶段是它被派去的），执行期间算"忙"（`lsm/busy.ts` 不分是谁的调用，原因写"任务「…」阶段 s1 的子 agent sa-1的通用 bash"）。被杀、子进程意外退出时记成中断，任务转为等我、待我处理里一条卡着任务的"中断不确定"，说明里写明是哪个子 agent 在哪个阶段的调用（`execution.ts` 的 `interruptedBy`），用户回答后交给维护者的确认也写明。子 agent 本身重启后不重新拉起（20 号票交回维护者一条"被打断了"）；这条说明和随任务停下的说明里，用 `uncertainExecutions` 列出它停下时还在执行的调用，写明等用户确认、不要重做（`sub-agents/texts.ts` 的 `resultText`），免得维护者接手时重做。
- **输入队列**在事件日志里：被杀时排着、还没开始的输入，重启后按原顺序处理，不丢也不重复（被打断的那一条照 04 号票不重送）。错过的定时触发按 19 号票补；本票只保证重启后调度器照常起来。
- 主切面在 `test/main/crash-recovery.test.ts`：守护进程在独立进程里跑（`helpers/killable-daemon.ts`），测试直接杀掉它再用同一个数据目录起一个（同一批里一快一慢、杀在中间的，子 agent 的调用执行到一半的也在里面；`startKillableDaemon` 的 `subAgent` 给子 agent 的剧本）；重复启动不搞乱正在跑的实例、彻底删除改写中断留下的调用摘要也在这个文件；见下面"测试底座"。

## 配置

- **数据目录**：环境变量 `ERGOU_DATA_DIR` 指定；不指定时是用户主目录下的 `.ergou`。事件日志和派生视图在数据库区的 `db/ergou.db`（WAL）；agent 的 pi 会话在会话区，秘书在 `sessions/secretary/`，每次拉起接着最近的那个会话。经 `main.ts` 启动的守护进程在数据目录根下写 `daemon.pid`（pid、进程启动时间、端口），给 stop 钩子核对。
- **模型 key**：守护进程从环境变量 `DEEPSEEK_API_KEY` 取（`config/secrets.ts`），由 LSM 从数据目录密钥区的 `secrets/deepseek-api-key.txt` 注入；再经 stdin 交给秘书子进程。没有 key 时守护进程照常起来，秘书每次回复都以出错结束（会话里一条系统说明）。
- **秘书的模型**：`deepseek/deepseek-flash`，思考档位 `high`（`daemon.ts` 的 `SECRETARY_MODEL`）。
- **其余配置**：放在数据目录的 `config/ergou.json`，缺的项取默认值。可以从 `config/ergou.example.json` 复制一份开始。
- **备份**：`backup.time`（每晚做快照的时刻，本地时间 HH:mm，默认 03:30）、`backup.syncDir`（同步目录，绝对路径，不能放在数据目录里；不配就只做本机备份）。示例配置里的同步目录是占位符 `<同步目录的绝对路径>`：复制过去要换成本机的路径，不换的话配置照样能用，但每次备份都报"没写进同步目录"。
- **关注类别设置**：数据目录的 `config/watch-categories.json`（内置类别的调整、自定义类别）。没有这个文件时全按默认；文件不对时守卫判定出错（拦下），设置页提示并修复。平时由设置页改（26 号票），手改也行，改完在设置页点"重新读取"或者等下一次判定。
- **端口**：`ports.local`（本机端口，只监听 127.0.0.1）默认 8810，`ports.external`（外网端口，隧道的目标，也只监听 127.0.0.1）默认 8811。选定的依据见 01 号票的 Comments。
- **公网入口**：`publicAccess`，只有部署命令读（守护进程不读）：`vpsHost`、`sshKey`（必填），`sshUser`（默认 root）、`tunnelPort`（VPS 上隧道的端口，默认 18811）、`domain`（默认 `ergou.<vpsHost>.sslip.io`）、`nginx.listen`（默认 `127.0.0.1:8443 ssl`：站在 VPS 上按 SNI 分流的前门后面；没有前门、直接听 443 的写 `443 ssl`；示例配置里是占位符）、`nginx.certificateDir`（默认 `/etc/letsencrypt/live/<域名>`）、`nginx.clientAddress`（客户端真实地址的 nginx 变量，默认 `$remote_addr`）。每一项按严格的字符集校验，占位符不收。
- **媒体**：`media.maxUploadBytes` 单个上传文件的上限（字节），默认 200 MB。媒体在素材区 `materials/media/`，还没收尾的上传在临时区 `tmp/uploads/`。
- **模型能力**：`models["<provider>/<模型 id>"].vision`：支不支持图片输入，没配的一律不支持（测试里的 faux provider 的名字是 `faux`）。
- **素材**：`materials.staleCardDays`：建议卡、提问卡多少天没处理算回避信号，默认 7。原文副本在素材区 `materials/originals/`，`memory.db` 在数据库区。
- **模型区**：数据目录的 `models/`，放语义检索用的向量模型（`npm run download-model` 下载）。
- **时区**：`timeZone`（IANA 名字，比如 `Asia/Shanghai`），发给模型的每条消息前面的本地时间标记按它换算；默认是本机时区。**简单提醒的时间（06）按本机时区算**，秘书照着时间标记写提醒的 `at`，所以两者不一致时提醒会差开：守护进程启动时发现不一致会在日志里提示。一般不写这一项。
- **审批**：`approvals.waitMinutes`，守卫判定"先问我"时子进程里这次调用最多等几分钟，默认 5。
- **任务的执行名额**（13 号票）：`tasks.maxRunning`，全局最多几个任务同时处于执行中（正整数），默认 3，多出的排队。
- **token 单价**（24 号票）：`tokenPrices: { currency, models: { "provider/模型 id": { cacheHit, cacheMiss, output } } }`（键和 `models` 的一样，是 `modelConfigKey`；测试里的 faux 是 `faux`），每百万 token 多少钱（输入命中缓存、没命中、输出各一个），货币是三个字母的代码（默认 CNY）。消耗页的成本按它粗估；账本每次算成本时现读（`config.ts` 的 `readTokenPrices`），启动时也校验一遍。没配单价的模型不算进成本（消耗页列出来）。示例配置里 deepseek-flash 的单价是照 DeepSeek 官网公布价格写的示例值（缓存命中 0.2、未命中 2、输出 3 元），用前以官网为准。
- **任务的阈值**（14 号票）：`tasks.thresholds`，只写要改的几项：`pullBacks`（拉回几次后再犯就停下，默认 3）、`nudges`（同一次停滞里催几次，默认 3）、`stallMinutes`（多久没进展算停滞，默认 20）、`acceptanceReturns`（验收退回几次后再不过就停下，默认 2）、`budgetExplainTimes`（用量超过预算的几倍让维护者说明进展，默认 1）、`budgetAskTimes`（超过预算的几倍停下，默认 2，不能小于前一项）、`rejections`（累计被拒几次暂停任务，默认 5）、`renewalLeadHours`（授权项到期前多少小时放续期事项，默认 24）、`archiveAfterDays`（结束超过几天的任务进每周的归档清单，默认 7，19 号票）。默认值只在 `tasks/thresholds.ts`。
- **提醒和定时作业的阈值**（19 号票）：各归各的模块，只写要改的几项。`reminders.lateLimitMinutes`（晚了多少分钟以内的提醒照发，更晚的改放"错过的提醒"，默认 60，默认值只在 `reminders/thresholds.ts`）；`scheduledJobs.jobFailures`（定时作业连续失败几次自动暂停，默认 3，默认值只在 `scheduled-jobs/thresholds.ts`）；结束超过几天的任务进归档清单是任务的阈值 `tasks.thresholds.archiveAfterDays`（默认 7，见上一条）。
- **个人工作日历**（29 号票）：用户的额外上班规则和手动标记在数据目录的 `config/workday-calendar.json`（个人数据，只由运行时写，随数据目录备份；仓库里没有）；导入的节假日数据在 `config/holidays/<地区>-<年>.json`。`holidayCheck`：节假日数据的检查，`{ fromMonth, dayOfMonth, time }`（从几月起查下一年、每月几号查（1–28）、几点），默认 `{ fromMonth: 12, dayOfMonth: 1, time: "09:00" }`（也就是每年 12 月 1 日 09:00 开始查下一年），默认值只在 `config.ts` 的 `DEFAULT_HOLIDAY_CHECK`。
- **agent 子进程的资源限制**（12 号票）：`agents.maxLive`（同时存活的子进程上限，至少 2，默认 8）、`agents.idleMinutes`（维护者闲置多久退出，默认 10）、`agents.modelCallMinutes`（单次模型调用超时，默认 5）、`agents.toolCallMinutes`（单次工具调用超时，默认 10）、`agents.orphanSweepSeconds`（多久回收一次孤儿进程，默认 60）。见上面"agent 管家的资源限制"。
- **语音消息**（31 号票）：`voice.recognizer`：`python`（装了 faster-whisper 的 Python，默认 PATH 上的 `python`；示例配置里是占位符，原样用时识别不可用、待我处理里说明）、`device` / `model` / `computeType`（默认 `cuda` / `large-v3` / `int8_float16`）、`fallback`（显卡不可用或显存不够时退回的，默认 `{ device: "cpu", model: "small", computeType: "int8" }`，写 `null` 不退回）、`idleMinutes`（闲置多久退出；默认 0：常驻，不因闲置退出，45 号票；写负数报错）、`timeout`（一次识别最多等多久，按语音时长和设备算：`baseSeconds` 余量默认 30、`coldStartSeconds` 刚拉起时多留的默认 60、`gpuPerAudioSecond` 显卡上每秒语音最多等几秒默认 1、`cpuPerAudioSecond` CPU 上默认 3；最坏的 60 秒语音冷启动退回 CPU 是 4.5 分钟）、`language`（默认 `zh`）、`initialPrompt`（默认"以下是普通话的句子。"）。第一阶段不用大模型修正，没有 `voice.correction`。默认值只在 `config.ts` 的 `DEFAULT_VOICE_CONFIG`。模型只从 Hugging Face 的本机缓存加载（识别进程的环境里 `HF_HUB_OFFLINE=1`），不在缓存里就是"加载失败"。
- **语音回复**（32 号票）：`voice.speech`：`url`（本机 LSM 托管的 audio.cpp，默认 `http://127.0.0.1:8090`）、`model`（服务上 Fish-Audio S2 Pro 的模型 id，默认 `tts`，和 drama 的配置一样；示例配置里是占位符，原样用时语音回复退回只发文字、说明里写怎么填）、`timeout`（一次合成最多等多久：`baseSeconds` 余量默认 15、`coldStartSeconds` 冷启动默认 90、`perSpeechSecond` 每秒语音最多等几秒默认 2；60 秒的语音最多等 225 秒）、`probeSeconds`（多久看一次服务的 `/health`，默认 60：从连不上变成连得上时再预热一次合成模型，45 号票）。`voice.reply`（`SpokenPace`）：`maxSeconds`（口语稿估出来念多久算长，默认 60）、`charsPerSecond`（估时长的语速，默认每秒 4.5 个汉字）。参考音色不在配置里，在数据目录的 `voices/` 区（设置里的语音页管）。
- **MCP 登记**（27 号票）：数据目录的 `config/mcp.json`，从 `config/mcp.example.json` 复制一份开始；凭据写 `{ "fromEnv": "变量名" }`，变量在 LSM 的守护进程登记里配。见上面"skill 库、MCP 登记与工具包"。skill 区是数据目录的 `skills/`。
- **带类型的 bash 工具**（28 号票）：`shellTools.longCallMinutes`，跑测试、启动构建、装依赖的单次调用超时，默认 30（别的带类型的工具按 `agents.toolCallMinutes`）。
- **维护者的模型**：和秘书一样是 `deepseek/deepseek-flash`、思考档位 `high`（`daemon.ts` 的 `MAINTAINER_MODEL`）。
- **范围审视用的模型**（18 号票）：规格定的便宜模型，第一阶段也是 `deepseek/deepseek-flash`、思考档位 `high`（`daemon.ts` 的 `SCOPE_REVIEW_MODEL`，和秘书、维护者的一样写在代码里，不在配置文件里）。工单结束时的审视最多等配置的单次模型调用超时（`agents.modelCallMinutes`）再加半分钟。
- **agent 子进程的环境**：系统变量白名单（PATH、SystemRoot、TEMP，以及 USERPROFILE、HOME、APPDATA、LOCALAPPDATA 这些用户目录类变量）加显式注入的变量，不继承守护进程的其他环境；模型 key 不走环境变量。联网开关关着时，bash 起的进程另加一组无效代理（见上面"守卫接入运行时"）。见 `src/process/child-env.ts`、ADR-0004。

## 测试底座（`packages/daemon/test/helpers/`）

三个切面见规格 Testing Decisions。守卫切面的底座在 `test/guard/helpers/`，见下文。

### 主切面（守护进程对前端的协议）

用例放在 `packages/daemon/test/main/`。一个真的守护进程（临时数据目录、系统挑的空闲端口，**从不占用 8810**，也不在 LSM 登记），秘书接 faux provider 按剧本回话、子进程真的拉起；测试扮演前端，经 WebSocket 和 HTTP 收发：

```ts
const { url, daemon } = await startTestDaemon({
  secretary: [{ kind: "reply", thinking: "想一想", text: "在的" }], // 每步对应一次模型调用
});
const frontend = await TestFrontend.connect(url);       // 测试结束自动断开
await frontend.subscribe({ secretary: 0 });
const sent = await frontend.sendText("在吗", { idempotencyKey: "k1" }); // → { messageId, seq }
await frontend.next("secretary", "message");             // 用户消息事件
await frontend.next("secretary", "stream");              // 流式增量（临时事件）
const reply = await frontend.next("secretary", "message"); // 定稿消息
await frontend.next("secretary", "turn_end");
expect(frontend.events({ persistedOnly: true }).map((f) => f.seq)).toEqual([1, 2, 3]);
```

- `startTestDaemon(options)`：`secretary`（faux 剧本）、`secretaryTokensPerSecond`（调慢流式，测节流、测"秘书正忙"）、`secretaryModel`（直接给模型，比如一个装配不起来的，测秘书起不来）、`secretaryDownThresholdMs`、`env`、`reuse: { dataDir, homeDir }`（停掉再起同一个数据目录）、`webRoot`（默认是放了测试页 `TEST_PAGE` 的临时目录）、`programDir`（守卫眼里的二狗程序目录，默认是一个空的临时目录：测试不碰真实仓库）、`portFromConfig`（测"端口从配置读"，两个端口都照配置）、`clock`（`ManualClock`，到点不靠真等）、`cardTypes`（额外登记或替换的卡片类型，比如 `card-fixtures.ts` 里的替身"建议发起任务"卡）、`heartbeatIntervalMs`（测半开连接）、`embedder`（素材的向量函数：默认是 `embedder.ts` 的 `FakeEmbedder`，不下载、不跑真模型；写 `"bge-m3"` 用正式的，临时数据目录的模型区是空的，测"模型不在"）、`secretaryTools`（秘书额外的代为执行的工具，比如带"花钱"类别的，测"交给我做"）、`quickActions`（额外登记或替换的快速动作，`quick-action-fixtures.ts` 里有落入"以我的名义对外发送"的 `send_note` 和不落入类别的 `tidy_note`）、`config`（起来之前写进数据目录 `config/ergou.json` 的配置，比如 `{ approvals: { waitMinutes: 1 } }`、`{ agents: { maxLive: 2, idleMinutes: 0.01 } }`）、`maintainer`（12 号票：维护者的 faux 剧本；给函数 `(维护者 id, 第几次唤起) => 剧本` 时，闲置退出后再唤起是新的子进程、剧本从头开始，会话接着原来的；不给则维护者一被调用就以出错结束）、`maintainerToolkit`（28 号票：`(维护者 id) => { bash, network }`，不给是起草计划时的、都关着）、`ghCommand`（28 号票：假的 GitHub 命令行）。`reviewer`（13 号票：评审子 agent 的 faux 剧本，`(评审子 agent 的 id) => 剧本`，id 是 `review-<任务>-<阶段>-<第几次>`；不给则评审一被调用就以出错结束，这次验收不通过）。`subAgent`（20 号票：并行派出的子 agent 的 faux 剧本，`(子 agent 的 id, 第几次拉起) => 剧本`，id 是 `sa-<n>`，按提议的先后编号；工具包变了重新装配时再拉起，剧本从头开始、会话接着原来的；不给则子 agent 一被调用就以出错结束，交回维护者的是"出错了"）。剧本里要写数据目录各区的路径时，先自己建好数据目录和主目录，经 `reuse` 交进来（`secretary-scratch.test.ts` 的 `dirs()`）。两个端口默认都由系统挑，**从不占用 8810、8811**。返回 `{ daemon, url, externalUrl, dataDir, homeDir, webRoot, programDir }`（`externalUrl` 是外网端口）；配对模块是 `daemon.pairing`；读派生视图用 `daemon.store.reader`，秘书子进程的 pid 是 `daemon.secretary.pid`（测崩溃），测试里直接建卡、放待我处理事项用 `daemon.cards`、`daemon.inbox`，提醒用 `daemon.reminders`，工作日历用 `daemon.workdayCalendar`（导入节假日数据 `importHolidayFile`），节假日数据的续期用 `daemon.holidayUpdates`（`importForTask`），素材用 `daemon.materials`，审批表用 `daemon.approvals`，效果日志用 `listEffects(daemon.store.reader, scope)`，`guard` 频道上的事件用 `daemon.store.read(GUARD_CHANNEL)`；从某个时刻起拉起了几个子进程用 `countAgentSpawns(daemon)`、拉起了哪些 agent（按先后的 id）用 `agentSpawns(daemon)`（测试接缝：包一层管家的 `spawn`，不在正式接口里）；token 账本用 `daemon.ledger`，构造的用量用 `usage.ts` 的 `usageInjector(daemon)`（24 号票）。
- `TestFrontend`（`frontend.ts`）：`connect(url, { origin?, host?, cookie?, headers?, noPong? })`（握手被拒时抛 `HTTP 403` / `HTTP 401`；`cookie` 带设备凭证，`noPong` 模拟半开连接）、`closed()`（等服务端关掉这条连接，拿到关闭码和原因）、`isOpen`、`subscribe(cursors)`、`sendText(text, { idempotencyKey? })`、`cardAction(params, key?)`（和 Web 一样先录一条本地动作）、`inboxAction(params, key?)`、`startTask(request, key?)`（点"发起任务"按钮）、`taskAction(params, key?)`（控制任务，13 号票）、`request(method, params, key?)`、`sendRaw(text)` / `nextResponse()`（测格式不对的帧）、`next(channel, type)`（按到达顺序往后等）、`events({ channel?, type?, persistedOnly? })`、`timedEvents()`（带收到的时间）、`cursors`（重新同步的频道归零）、`disconnect()` / `reconnect(channels, url?)`（断网、带游标重连；守护进程重启后端口变了就给新地址）、`sendTextThenDrop(text)`（发出去就断网）、`sendParts(parts)` / `trySendParts(parts)`（带附件的消息；后者把被拒的响应原样交回）、`history(conversation, { before?, limit? })`（经 HTTP 往上翻一页，录成 `history_page`）、`recording`（录下的输入，类型就是 Web 状态层的 `UiInput`）。频道名和事件类型用协议包的常量。
- `http.ts`：HTTP 那一半（24 号票加了消耗页的 `usageApi.summary(url, { from, to })`）。`media.upload(url, bytes, { name, mime }, chunkSize?)` 整个传完并收尾（带原始字节的 sha256），`media.create / put / status / complete / download(url, mediaId, { range?, name? })` 一步一步来；`putThenDrop(...)` 发出一个分片的一部分就掐断连接（模拟传到一半断网）；`history(url, conversation, ...)`；`materialsApi.scope(url, scope?)`、`materialsApi.delete(url, body)`（设置里删除素材的两个接口）；`workdayApi.month(url, "YYYY-MM")`、`workdayApi.change(url, change)`（设置里的工作日历，29 号票）；`sha256Hex(bytes)`。
- `images.ts`：按格式结构手工拼的小图片（`jpeg({ exif: { gps, orientation }, xmp, comment })`、`png({ exif, text })`、`webp({ exif, xmp })`），带上 GPS 等元数据；`jpegMarkers` / `pngChunkTypes` / `webpChunkTypes` 列出各段。`png()` 是能解码的真图片（pi 发给模型前会解码、缩放图片，测视觉时用它）；`jpeg()` 只保证结构。
- `pdf.ts`：`pdf([["第一页的行", …], …])` 手工拼一个 ASCII 文字的小 PDF。
- `echo.ts`：`stripTimeMarkers(context)` 去掉 echo_context 回显里每条用户消息前的时间标记（只关心内容时用）。
- `ports.ts`：`freePort()`、`writePortsConfig(dataDir)`（本机端口和外网端口各挑一个空闲端口写进数据目录的配置，返回两个端口；`writePortConfig` 只返回本机端口）。
- `device.ts`（10 号票）：`TestDevice`——一台从外网（经隧道）访问的设备：自己的 cookie 罐（Set-Cookie 记下，Max-Age=0 的删掉）、`userAgent`、`realIp`（每个请求带上 X-Real-IP）；`requestPairing(name?)`、`pollPairing()`、`renamePairing(name)`、`access()`、`request(path, options)`、`connect()`（带着 cookie 连 WebSocket）、`credential`（设备凭证原值）。`pairDevice(externalUrl, 批准方前端, { name?, realIp?, firstUse? })` 走完一次配对（批准方要已订阅卡片频道），默认领到凭证后像浏览器那样带着它问一次 `/api/access`（设备由此启用），`firstUse: false` 停在"领到了、还没用过"；`waitForPairingCard(frontend, requestId)`。`TestFrontend.recordUnpaired(access)`：服务端关掉连接后，像 Web 的连接那样录"断开"和"凭证失效"（带原因）。
- `browser-http.ts`（10 号票）：`httpRequest(base, path, { method?, headers?, body? })`，Host、Origin、Cookie、X-Real-IP 想怎么写就怎么写，结果带文本正文、`json()` 和解析好的 `setCookies`。
- 关注类别设置的主切面（26 号票）：`watch-categories.test.ts`（设置页看到的、改了下一次判定就按新设置、改不动的、还没登记的工具、id 不重用、agent 写配置区、文件坏了和修复、待我处理事项）、`plan-watch-categories.test.ts`（计划卡上的本任务关注类别、加类别只影响这个任务、确认时的快照和全局改动、设置页删改时的提示、用户的限制和原话核对；任务执行还没接上，"判定"用 `toGuardPlan` 加守卫的判定函数算，走真实执行路径的验证等 13 号票）。`TestFrontend.updateWatchCategories(params, key?)` 发设置页的请求；关注类别频道和秘书会话各走各的，等设置事件用按频道计数的 `nextSettings`（不用 `frontend.next` 的全局游标）。
- `plans.ts`（12 号票）：`samplePlan(overrides?)` 一份字段齐全、能通过检查的计划（两个阶段、一个阶段组、全局九类关注类别、一个定时作业定义），`submitPlanStep(plan?)` 维护者调用"提交计划"的一步剧本。
- 秘书的看板感知、待我处理和任务控制（22 号票）：`secretary-board.test.ts`（看板变化消息跟在用户消息后面、没变不加、系统提示不变、重启后从事件日志对出上次看到的样子；查看板；读项目档案不唤醒维护者；主线自动压缩用秘书专用的压缩指令，压缩后看板变化照常追加）、`secretary-inbox.test.ts`（列出待我处理、把同一张卡放进聊天、聊天里点了待我处理里同步；新增事项不主动进模型输入；秘书的全部工具（没有对卡片做动作的、没有建定时作业的）；承诺即任务）、`task-control.test.ts`（点明了直接执行、名额满了回到排队中、不合法的被拒；推断出来的一律先问）。
- 任务的主切面：`tasks.test.ts`（三条发起路径、提问卡、任务书交给维护者、提交计划、计划卡的确认和打回、素材）、`agent-limits.test.ts`（子进程上限和排队、闲置退出、超时、孤儿进程回收）。秘书、维护者、用户的动作各走各的频道，**跨频道的先后不确定**：等某个结果用 `waitUntil` 看累积收到的事件（`tasks.test.ts` 的 `eventually`），只在同一个频道里按先后等时用 `frontend.next`。状态迁移表、计划检查的表格测试在 `test/tasks/`。
- `recording.ts`：`saveOrCheckRecording(name, frontend.recording, { perChannel? })`，见上面"回放测试"。`perChannel: true` 只核对每个频道里的先后（几个 agent 同时干活、频道之间谁先到每次不一样的流程用它）。`task-initiation`（`tasks.test.ts`：秘书直接建任务 → 提问卡全按推荐 → 计划卡 → 收窄一项后确认 → 排队中）用的就是它，重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/tasks.test.ts -t 演示流程`。`project-lifecycle`（15 号票，`projects.test.ts` 的"演示流程"：建议立项 → 立项 → 立项问答 → 立项书卡确认并开工 → 首个建设任务完成转使用中 → 停用、重新启用；另一个项目放弃、取消归档、再放弃、删除）也是 `perChannel`，重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/projects.test.ts -t 演示流程`。`timeline-zoom`（25 号票，`timeline.test.ts` 的"演示流程"：两阶段任务里写文件、通用 bash、授权内的建目录、做完告诉我的提交、问过的读主目录、写围栏外被硬拒绝、脚本验收，连同活动状态频道；`perChannel`），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/timeline.test.ts`。`timeline-history`（25 号票，`history.test.ts`：维护者会话、秘书会话各 60 条消息带偏离、范围变更、操作记录，第一次补发最近一页，往上翻取回旧页和其中的记录），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/history.test.ts`。历史分页的骨架里带着这一页的记录（类型和序号）。`typed-shell-tools`（`typed-shell.test.ts` 的演示：维护者用带类型的 bash 工具看状态、提交、建远端仓库、推送被退回再放行、force push 禁止、合并、构建、装依赖；同样 `perChannel`），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/typed-shell.test.ts -t 演示`。另外十一段：`secretary-chat`、`secretary-reconnect`、`secretary-resync`、`secretary-history`（第一次只补发最近一页，往上翻一页）、`secretary-attachments`（带图片和文件的消息）（在 `recordings.test.ts` 里录），`cards-inbox-sync`（`cards.test.ts`）、`reminder-due`（`reminders.test.ts`）、`secretary-approval`（读草稿区外的文件先问、批准后执行，`approvals.test.ts`）、`device-revoke`（`devices.test.ts`：只订阅已配对设备的设置页，两台配对、吊销一台）、`device-revoked-here`（同一个用例里被吊销的那台设备上的页面：连接被关掉，问到"被吊销"）、`memory-purge`（`memory-delete.test.ts`：秘书检索、出记忆删除卡、确认彻底删除，原话变成"已删除"）、`workday-calendar`（`workday-calendar.test.ts`：节假日数据、改个人设置、按我的工作日的提醒跟着工作日历变的下一次）、`holiday-update-task`（同一个文件，`perChannel`：缺失事项 → 发起更新任务 → 规划中 → 计划卡（定时作业"按我的工作日 09:00"）→ 确认；重新录这两段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/workday-calendar.test.ts`）。录制文件入库：保存时把临时目录、用户主目录（正斜杠、反斜杠、8.3 短名、真实路径几种写法）换成 `<临时目录>`、`<用户主目录>`，`test/recordings-privacy.test.ts` 检查录好的文件里没有本机用户主目录。重新录这一段和审批那段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/memory-delete.test.ts packages/daemon/test/main/approvals.test.ts`。重新录这两段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/devices.test.ts`。重新录卡片、提醒和审批的三段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/cards.test.ts packages/daemon/test/main/reminders.test.ts packages/daemon/test/main/approvals.test.ts`。26 号票加了 `watch-categories`（`watch-categories.test.ts` 的"演示流程"：设置页新建、改处置、调严内置类别、调松被拒、删除），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/watch-categories.test.ts -t 演示流程`。24 号票加了 `token-ledger`（`token-ledger.test.ts` 的"跑完一个任务"：剧本里每次回话带固定的用量，看板上的合计逐次增长，`perChannel`），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/token-ledger.test.ts -t 跑完一个任务`；13 号票的 `task-execution` 重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/task-execution.test.ts -t 演示流程`。
- 时间线和活动状态的主切面（25 号票）：`activity.test.ts`（被唤起、开始干活、等你批准、空闲、闲置退出各一条活动状态事件；审批挂起、这一轮结束后还有待处理的审批卡是等你，闲置退出、守护进程重启后照样是，批准后不再等你；提问卡没回答时秘书是等你（澄清）；干活中的进度是节流的临时事件；任务、项目变了不改写活动状态；断言结构化的说明，不断言文案）、`timeline.test.ts`（工具调用 part 的字段取自守卫的判定、消息带上阶段、往上翻的历史也带着，录成 `timeline-zoom`）、`history.test.ts` 里时间线记录跟着它所在的那一页回来（录成 `timeline-history`）。
- 守卫接入的主切面：`secretary-scratch.test.ts`（草稿区里干活、秘书的围栏、不能联网）、`approvals.test.ts`（审批卡、等待与挂起、一次性授权、交给我做）、`secret-read-outbound.test.ts`（维护者读过 `.env` 之后装依赖照常执行、推送被拦下，网址里带着读过的值（原样、base64）判永不，30 号票；装依赖用 PATH 上假的 pnpm，远端是本地裸仓库）。被杀后的恢复（23 号票）：`crash-recovery.test.ts`（任务里有副作用的调用、等审批的调用、只读的调用、维护者子进程意外退出、秘书会话里批准过的草稿区外脚本、说到一半的回复和排着的输入，底座见下面的 `killable-daemon.ts`），LSM 的 link 协议在 `lsm-link.test.ts`（子 agent 的调用执行期间报忙、等空闲再停等它做完也在里面）。聊天里的工具调用记录用 `tool_call` part 断言，模型看到了什么用剧本最后一步 `echo_context` 的回显断言。
- `clock.ts`：`ManualClock`，见上面"调度器和简单提醒"。
- `killable-daemon.ts`（23 号票）：`startKillableDaemon({ secretary?, secretaryTokensPerSecond?, maintainer?: { 维护者 id: [第 1 次唤起的剧本, 第 2 次……] }, subAgent?: { 子 agent id: 剧本 }, config? })` 在**独立进程**里起一个守护进程（`fixtures/killable-daemon.ts`，临时数据目录、系统挑的端口、faux 模型），测试当前端经 `url` 连它；`reports` / `waitFor(match, what)` 是它报出来的行（`guard`：guard 频道上的每条事件；`agent`：之后唤起的 agent 和 pid；`allowed`：守卫放行了某个 agent 的一次调用，之后它就在执行了）；`processes()` 是 Job 里的全部进程、活着的 agent 子进程；`kill()` 像 LSM 重启时那样直接杀掉它（Job 对象随之关闭）。`restartAfterKill(killed, options)` 用同一个数据目录、主目录、Web 目录和程序目录在测试进程里再起一个（`startTestDaemon` 的 `reuse`），前端 `reconnect(频道, 新地址)` 带着游标只补发重启之后的；`survivors(pids)` 等这些进程结束、返回还活着的。
- `lsm-stand-in.ts`（23 号票）：`startLsmStandIn({ heartbeatIntervalMs?, conflict?, port?, token? })` 当 LSM 的接入层（只认对的令牌，收到 `hello` 回 `welcome` 或 `conflict`），`env` 放进守护进程的环境就会连上；`messages`、`waitFor(match, what, { from? })` 是服务发来的消息，`send(...)` 发停机、撤销、ping。
- `embedder.ts`：`FakeEmbedder`：按概念组出向量（"搬家"和"换个地方住"落在同一维，测语义检索），`setAvailable(false)` 模拟模型文件不在，`hold()` 把计算卡住、等测试放行，`calls` 记下每次算了哪些文字。`vectorsSettled(materials)` 等后台的向量补算告一段落（测试接缝，只看 `vectorStatus()`，不在正式接口里）；启动后的补算要过 `BACKFILL_DELAY_MS` 才开始，重启后要等补算先把 `ManualClock` 拨过去。
- 素材模块的模块层测试在 `test/materials/`，底座是 `test/materials/helpers.ts` 的 `materialsSetup({ embedder?, sources?, staleCardDays? })`（真的事件存储和素材模块、`ManualClock`、调度器、卡片和待我处理；`reopen({ embedder?, deleteMemoryDb?, deleteChannel?, rewrite? })` 模拟重启、删库重建、删项目时删掉某个会话的事件、彻底删除把事件改写成"已删除"标记）和 `postMessage(store, parts, { conversation?, speaker? })`。工作线程那条路用 `test/fixtures/fake-embed-backend.ts`（假的推理后端，`busyMs` 占住 CPU 测不阻塞主线程）。
- `backup.ts`：`startBackupDaemon({ start, syncDir?, backupFiles?, reuse?, secretary?, config?, log? })` 起一个时钟停在 `start`、同步目录是临时目录的守护进程（启动时补做的作业做完才返回）。恢复命令按配置里的 `ports.local` 判断守护进程在不在，配置还会随快照一起恢复，所以它总在数据目录的配置里写一组 `freePorts()` 挑的空闲端口（`config.ports` 给了就用给的），守护进程也照配置用这组端口：备份、恢复的用例不依赖 8810 空着（那是 LSM 托管的正式服务，测试时照常在跑）；它的 `advanceTo(时刻)` 把途中到点的计时器一个个拨过去，每到一个点等内部作业做完（作业是异步的，跑完才登记下一次，一下子拨过好几天就只会跑一次）。`restartBackupDaemon(旧的, 时刻)` 停掉再用同一个数据目录和同步目录起来；`put(目录, 相对路径, 内容)`、`touch(文件, 时刻)`。
- `snapshots.ts`：`listTree(目录)`、`snapshotRels(备份区, 日期)`（清单里的文件）、`snapshotFile(备份区, 日期, 相对路径)`（内容实际在哪：日期目录里或公共池里）、`poolFiles(同步目录)`、`snapshotEvents(快照里的 ergou.db, 频道)`（复制一份再读事件）、`snapshotIntegrity(数据库)`、`sameStorage(a, b)`（是不是同一份存储）、`isReadOnly(文件)`、`makeWritable(文件)`（人为改坏快照之前先去掉只读）。
- `startTestDaemon` 另有 `config`（起来之前写进数据目录的配置，按顶层键合并；`writeConfig(dataDir, config)` 也单独导出）、`backupFiles` 和 `log`（收守护进程的日志）。**同步目录一律用临时目录**，绝不写真实的同步目录。
- `card-fixtures.ts`：替身"建议发起任务"卡（发起任务 → 已处理，不用了 → 已关闭，不建任务），给卡片和待我处理的通用机制做测试用。正式的在 `tasks/cards.ts`（12 号票）；测试里按替换登记，不冲突。
- `test/main/entry.test.ts` 按 LSM 的方式拉起 `src/main.ts`，用 `src/stop.ts` 停下，也验 pid 文件对不上时 stop 钩子不动手。
- 公网入口（`test/deploy/`）：`nginx.test.ts` 用一个很小的 nginx 配置解析器逐项断言生成的站点配置；`deploy.test.ts` 用假的执行器测部署命令（只 ssh 一次、脚本里先 `nginx -t` 再 reload、占位符和不合法的值不部署），扫源码确认只有部署命令的入口引用部署模块，并核对 `ergou-tunnel` 条目示例的目标是外网端口。
- `test/main/backup.test.ts`、`restore.test.ts` 是备份、校验、清理和恢复的主切面（底座见上面的 `backup.ts`、`snapshots.ts`），内部作业"过没过点"的纯函数在 `test/internal-jobs.test.ts`；`restore-cli.test.ts` 按 LSM 的方式拉起 `src/main.ts`，再跑恢复命令 `src/restore.ts`。
- 守护进程里单独的模块（事件存储、流式节流 `stream-hub.test.ts`、图片剥元数据 `media-image.test.ts`、发给模型前的投影 `model-projection.test.ts`、调度器 `scheduler.test.ts`、待我处理 `inbox.test.ts`、秘书给的提醒时间 `reminders/schedule.test.ts`、守卫接入现取的环境事实 `guard-runtime/facts.test.ts` 和脚本扫描 `guard-runtime/script-scan.test.ts`）在 `test/` 下按模块测；提醒的时间规则本身和"事项算不算处理过"在共享协议包里测（`packages/protocol/test/reminder-schedule.test.ts`）；计划的纯函数（授权项列表、卡上生成的授权行和时序规则说明、停点随勾选变化）在 `packages/protocol/test/plan.test.ts`，"谁能改"表和计划的检查、每项授权的样子、勾掉 / 收窄 / 改假设栏、交给守卫的样子在 `packages/daemon/test/tasks/`。 投影的期望输出都是手写的字面量（快照），改投影规则时先改这里。

### 其他辅助

- `temp-dir.ts`：`makeTempDir()` 建一个临时目录，当前测试结束自动删除（必须在测试体内调用）。
- `daemon.ts`：
  - `startTestDaemon(options)` 起一个守护进程实例（见上），测试结束时停掉，Job 里残留的进程一起清掉。
    - 数据目录（`ERGOU_DATA_DIR`）是临时目录。
    - 守护进程的环境取当前进程的环境，但 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`HOMEDRIVE`、`HOMEPATH` 都换成临时主目录 `homeDir` 下的路径。守护进程按白名单把它们传给 agent 子进程，所以测试里的子进程（和它起的 bash 等工具）看不到真实的用户主目录。
    - `env` 再覆盖在上面，比如放一个哨兵变量。
  - `spawnTestAgent(daemon, request)` 拉起一个 agent，返回 `{ agent, log }`，测试结束时先结束子进程。要验守卫转发时在 request 里加 `forwardToolCalls: true`，然后用 `guard_request` / `guard_reply` 来回；要验宿主工具时在 request 里给 `hostTools`，然后用 `host_tool_call` / `host_tool_result` 来回。
  - `fauxModel(script, { tokensPerSecond })` 造一个按剧本回话的 faux 模型，不连网。剧本每一步对应一次模型调用：
    - `{ kind: "reply", text?, thinking?, toolCalls?, usage? }`（`usage: { cacheHit, cacheMiss, output }` 是这次调用上报的用量，不给就由 faux 按上下文估算，24 号票）；
    - 或 `{ kind: "echo_context" }`：把这次调用看到的上下文原样回成文字，每行以 `[system]`、`[tool]`、`[user]`、`[assistant]`、`[toolResult]` 开头；
    - 或 `{ kind: "context_overflow" }`：模型报上下文溢出（出错回复），pi 据此自动压缩、再重试这一轮（22 号票验证自动压缩用自定义的压缩指令；压缩时写摘要的那次调用也吃剧本的一步）；
    - 或 `{ kind: "call_with_matches", toolCall, argument, pattern }`：从上一个工具结果里按正则 `pattern` 挑出全部匹配（去重），放进 `toolCall` 的参数 `argument`（可以是点分路径，比如 `params.materialIds`）再调用（剧本写的时候还不知道素材 id，比如"照检索结果提议删除"）。
- `user-profile.ts`：`tempUserProfileEnv(homeDir)` 生成上面那组用户目录变量，`withEnv(base, ...overrides)` 按 Windows 不分大小写的规则覆盖环境变量；`NO_LSM_ENV` 去掉 LSM 注入的四个变量（测试底座起守护进程时都叠上它：在 LSM 拉起的终端里跑测试也不会连上真实的 LSM，23 号票）。不引用 vitest，测试夹具进程也能用。
- `report-log.ts`：`ReportLog` 按到达顺序记下子进程发来的消息。`await log.next("turn_end")` 等下一条某类消息，连续调用 `next` 就能断言先后顺序；`log.ofType("stream_delta")` 取到目前为止的某一类消息。
- `process.ts`：
  - `isProcessAlive(pid)`；
  - `waitUntil(predicate, { timeoutMs, describe })`：默认等 10 秒，超时的错误里带 `describe()` 的说明。等秘书拉起来（加上它回第一轮）的那一处显式传 `SECRETARY_START_TIMEOUT_MS`（20 秒）；同一个用例里几次等待加起来超过用例超时（30 秒）的，用例写明更长的超时，真超时时看到的是 `waitUntil` 的说明；
  - `forceKill(pid)` 用来兜底清理，只对还没确认结束的进程用，免得 pid 被复用后误杀。
- `fixtures/`：
  - `daemon-host.ts`：独立进程里的守护进程宿主，Job 对象测试拿它来强杀；
  - `killable-daemon.ts`：独立进程里能被直接杀掉的守护进程（被杀后的恢复，经 `helpers/killable-daemon.ts` 用）；
  - `grandchild.mjs`：给 bash 工具起的孙进程和孤儿进程。
- `running-task.ts`：要一个"执行中"的任务时用，两种走法。22 号票的：`startTestDaemon({ maintainer: maintainerScript() })`（第一次唤起交一份只有一个阶段、由用户验收的计划 `onePlan()`，之后每次唤起只回一句），前端订阅看板和卡片频道，`runningTask(td, frontend, 标题)` 建任务、写任务书、在计划卡上确认，等它开始执行，返回任务 id；另有 `tasksOf(frontend)`、`eventually(list, match, what)`。23 号票的只经前端协议走（独立进程里的守护进程也能用），让任务 t-1 走到执行中：`SECRETARY_BRIEFS`（秘书收到"发起任务"的通知后写任务书）、`maintainerScripts(执行时的剧本)`（维护者第一次交一份一个阶段、开 bash 不联网、脚本验收的计划 `bashPlan()`，第二次照剧本执行）、`startRunningTask(frontend)`（点"发起任务"、确认计划卡、等任务开始执行；前端要订阅看板和卡片）。
- `projects.ts`（15 号票）：`seedProject(daemon, name, overrides?)` 直接往项目列表频道放一个项目（不走立项、不出卡、不通知秘书），给别处的用例当"已有的项目"（比如"发起任务"时选的项目要在项目列表里）。

一个典型的集成测试：

```ts
const { daemon } = await startTestDaemon();
const { agent, log } = spawnTestAgent(daemon, {
  agentId: "demo-agent", // "secretary" 归守护进程自己的秘书
  model: fauxModel([{ kind: "reply", text: "你好" }]),
  tools: [],
});
await log.next("ready");
agent.send({ type: "user_input", inputId: "in-1", text: "在吗" });
expect((await log.next("message_final")).message.parts).toEqual([{ type: "text", text: "你好" }]);
expect((await log.next("turn_end")).outcome).toBe("completed");
```

**守卫切面**（切面 2）放在 `packages/daemon/test/guard/`，只调判定函数（和授权项校验、注册表），不起进程：

- `helpers/guard-input.ts`：虚构的固定路径 `P`（数据目录 `D:\ergou-data`、工作目录 `E:\work\notes`、草稿区……，不需要真的存在）、`NOW`、`executingAgent(kind)`（`maintainer()` / `subAgent()` 是它的简写）/ `secretary()`、`task()`、`call()` / `bash()`，拼输入的 `inChat(agent, call, extra)` 和 `inTask(...)`，以及取某条处置依据的 `dispositionFinding(j, id)`。
- `helpers/test-tools.ts`：`TEST_TOOLS` 是加了测试用 MCP 工具的注册表（每个内置类别一个 `mcp_<类别>`，还有付款、改密码、发邮件、网页搜索）。
- 表格测试：`categories`（类别 × 对话 / 任务、设置、自定义类别）、`bottom-lines`、`grants`、`bash`、`fence`、`network`、`registries`、`temporal-rules`（四种形态、只看效果日志、阶段和阶段组、判断不了）、`rule-validation`、`effect-log`（记录的字段、参数名统一）、`secret-read-outbound`（读过密钥之后只拦往外送、bash 里的组合、GET 网址和联网命令参数里的密钥、读过的密钥值、效果日志里的 `unseenInput`、带类型的工具和 bash 一致，30 号票）。
- **场景文件** `scenarios/*.guard.json`，由 `scenarios.test.ts` 逐个跑，格式见 `helpers/scenario.ts` 开头的说明（26 号票起每一步可以写 `settings`：从这一步起按这份全局设置判，`custom-category-settings` 用它演示改设置）。和 AgentSense planguard 兼容：`tools`（参数规则照 planguard 的 `args` 写）、`rules`（planguard 规则，原样交给判定函数，先过规则校验）、`facts`（每一步都带上的环境事实，planguard 的领域事实放 `facts.extra`）、`calls`（每一步 `tool`、`args`、`commit`、`expect`，`expect` 里可以写 planguard 的 `verdict` 和 `kinds`）。路径写占位符 `${workDir}`、`${scratch}`、`${config}`……。执行成功的步骤按 `effectRecordsFor` 进效果日志。现有的：v1 六条模板各一份（`v1-*.guard.json`）、四种形态挂在阶段和阶段组上（`temporal-forms-stages`）、从 AgentSense 搬来的 storage 和 office 用例（`agentsense-*`）。
- **v1 模板默认生效**，看关注类别、授权项这些别的东西的表格测试用 `v1Satisfied(...仓库)`（`guard-input.ts`）先满足模板的前提（这些仓库里跑过测试、都已提交、HEAD 是新提交），免得被"push 之前必须跑过测试""删除或覆盖之前必须已提交"退回，或者被"不重复发"判断不了。`effect(seq, tool, args)` 造一条效果日志。

**pi 契约测试**放在 `packages/daemon/test/contract/`，文件名 `*.contract.test.ts`。每条用例单独拉起一个子进程、接 faux provider，只验二狗依赖的 pi 行为。现有八个文件：

- `session-recovery.contract.test.ts`（23 号票）：被杀之后接着会话——会话文件末尾写到一半的一行去掉、只留完整的条目，模型看不到碎片；最后一个回合的工具调用没有结果（被杀时正在执行）的补上出错的工具结果（守护进程按调用给了说法的用它的，没给的用 `INTERRUPTED_TOOL_RESULT`），模型接着往下走；再接着会话不重复补。用到的 pi 行为：带工具调用的助手消息在执行工具之前就落盘、`SessionManager.appendMessage` 追加的工具结果进模型的上下文。

- `pi-session.contract.test.ts`：流式到定稿；会话不读用户目录和工作目录里的配置、skill、上下文文件和 CLI 认证；固定的系统提示替换掉 pi 默认的编程助手提示；`continueSession` 接着会话目录里最近的会话，工作目录变了也接着（15 号票：任务转为项目、绑定外部工作目录时维护者的工作目录会变；pi 自带的 `continueRecent` 在指定会话目录时按工作目录筛，所以 `agent-child/session.ts` 自己挑最近的那个、用新的工作目录打开）；指定会话的名字（`session`，16 号票：没有就用这个名字新开，有就接着它，同一个目录里别的会话不进上下文；ready 报回名字；没有又选了 `continueSession` 时接着目录里最近的那个，报回它的名字）；工具白名单之外的工具用不了（只给 `read`、`ls` 时调用 `write`、`bash` 以"没有这个工具"出错，什么也没做——起草计划的维护者靠它；评审子 agent 的固定只读工具包 `REVIEWER_PI_TOOLS` 加 `submit_review`，调用 `write`、`edit`、`bash` 同样用不了，13 号票）。
- `guard-and-interject.contract.test.ts`：工具调用停在 `tool_call` 钩子里等守护进程判定，按判定执行或不执行（文件工具、bash 的命令真的没跑；守护进程代为执行的工具不放行就不发 `host_tool_call`）；插话在下一次模型调用之前进入上下文，收下的在 `turn_end.interjected` 里报出；回合已经结束时的插话回 `error`（带 `inputId`），之后照常送输入（13 号票）。
- `context-block.contract.test.ts`（13 号票）：装配里的重注入块在每条输入之前（刚拉起、闲着时来了新输入）作为一条上下文消息注入（系统提示不变）；`context_block` 换成最新的，下一条输入之前、压缩之后（`compact` 手动触发）注入最新的那块。22 号票加了：用户输入带的上下文消息（`user_input.context`）紧跟在这条用户消息之后、系统提示不变、不带的那一轮什么都不加；装配里给了 `compactionInstructions` 时，手动压缩和自动压缩（上下文溢出后压缩再重试，faux 的 `context_overflow`）写摘要的那次模型调用收到的都是这份指令。
- `shell-env.contract.test.ts`：同名的自定义工具换掉 pi 自带的 bash，起进程前往环境里加 `shellEnv`（联网开关关着时的无效代理）；bash 里看不到模型 key。
- `session-rewrite.contract.test.ts`（21 号票）：经 agent 管家的 `rewriteSessions`（一次性子进程）改写 pi 的会话文件：输入标记后面的那条用户消息、某次工具调用的参数和结果、检索结果里提到某个 id 的行改写成删除标记，覆盖了它们的压缩摘要整段换掉（没覆盖的不动）；保留修改时间，`continueSession` 仍接着这个会话，重新拉起后模型看到的是标记；agent 还在跑时拒绝改写。
- `usage.contract.test.ts`（24 号票）：每次模型调用一条 `usage`，剧本给定的缓存命中、未命中和输出原样到达、各自对得上那次的定稿消息；pi 自己算的用量里，同一会话第二次调用的前缀记在 `cacheRead`；压缩会话生成摘要的那次也报一条（`purpose: "compaction"`）；**真实 provider 的换算**：子进程用目录里的 `deepseek/deepseek-flash`（`CatalogModelSpec.baseUrl` 指到测试在本机起的回放服务，不联网），pi 的 openai-completions 解析录好的流式响应（`test/fixtures/provider-usage-streams.ts`：DeepSeek 的 `prompt_cache_hit_tokens`，和 OpenAI 写法带 `cache_write_tokens` 的各一份），断言命中 = `cacheRead`、未命中 = `input + cacheWrite` 和 provider 报的缓存命中、输入总数对得上（账本的 `ledgerTokens` 同一个换算）。pi 升级改了这几个字段的含义时这里会红。
- `host-tools.contract.test.ts`：守护进程代为执行的工具登记进会话（工具白名单为空时照样可用）；调用转给守护进程、等结果期间工具不结束，结果（含出错）回到下一次模型调用；参数不合 JSON Schema 时 pi 直接拒绝、不转；一次调用几个时一个一个、按顺序转；用户输入带的图片进入模型调用的上下文。

后面的票按规格往这里加用例。

## 升级 pi

1. 用 npm 查最新稳定版：`npm view @earendil-works/pi-coding-agent dist-tags`，读四个包 CHANGELOG 里的 Breaking Changes。
2. 改版本号，所有 `@earendil-works/*` 一起改，都写精确版本：
   - `packages/daemon/package.json` 的 `dependencies`；
   - 根目录 `package.json` 的 `overrides`；
   - 看一眼新版本 `pi-coding-agent` 的依赖里有没有新的 `@earendil-works/*` 包，有就也加进 `overrides`。
3. `npm install`，确认 `npm ls --all | grep earendil` 全是同一个版本。
4. `npm run typecheck`（子进程的事件翻译对着 pi 的类型），再 `npm run test:contract`，最后 `npm test`。

## LSM 登记（`ergou-daemon`）

`deploy/lsm/ergou-daemon.example.yaml` 是 LSM 注册表条目的示例（格式见 LSM 的 `docs/service-schema.md`）：探活档位 `linked`（接入层断了 LSM 降级回健康探针 `/healthz`，端口 8810）、`link.enabled`、autoRestart、`ERGOU_DATA_DIR`、模型 key 由 LSM 从数据目录密钥区注入（`env.from: file`）、start / stop 钩子都用固定的 Node 22 LTS 绝对路径。本机路径写成三个占位符：`<仓库路径>`、`<专用 Node 路径>`、`<用户主目录>`。**真实条目只放在 LSM 自己的登记目录里，不进本仓库。** 条目里的 `exposure`（公网入口）在示例里是注释掉的：LSM 校验时要求 `via` 指向的隧道已经登记，没登记 `ergou-tunnel` 就打开会让整个条目登记不上；登记隧道之后再去掉注释，见下面"公网入口"。

**link 协议**（23 号票，`src/lsm/link.ts`，照 LSM 的 `docs/link-protocol.md` v1 和 `clients/lsm-link.mjs` 写；WebSocket 用工作区已有的 `ws`，带 `Authorization: Bearer` 请求头）：

- LSM 拉起时注入 `LSM_URL` / `LSM_SERVICE_ID` / `LSM_TOKEN` / `LSM_PROTOCOL`，守护进程开好端口之后出站连上它。**四个变量缺一个、协议版本不是 1 时静默跳过**（测试、手动起的都是这样）；连不上、断线只是重连（1 秒起翻倍、最多 30 秒，无限重试），从不挡启动。`daemon.lsm.enabled` 说明接没接入。
- 握手（`hello`）报 pid、本机端口、版本（守护进程包的 `version`）和能力 `busy`、`stop`、`restart`、`health`；心跳按管理器 `welcome` 给的间隔（默认 5 秒）报健康（秘书在运行是 `ok`，否则 `degraded`）和**忙不忙：有任务处于执行中、或者任何 agent 有正在执行的有副作用的调用（秘书会话里跑着的脚本、维护者对话里的命令……，执行记录里还在执行的）就是忙**（`lsm/busy.ts`），原因"正在执行 N 个任务：「…」；M 个有副作用的调用还没做完：秘书对话的通用 bash……"；忙闲变了马上补一次心跳（看板上的 `task` 事件、调用开始、结束、被中断时触发），不等下一拍。
- 停机（`stop` / `restart`，先应答）：`now` 马上优雅停止；`when-idle` 忙时挂起（管理器可以 `cancel` 撤销），不忙了再停——**有正在执行的有副作用的调用也算忙**，所以"等空闲再停"会等它们做完，而不是把它们杀成说不清做没做完。停止就是 `daemon.stop()`（停止流程里最先叫 `guards.stop()`：之后结束子进程不算中断；最后删 pid 文件、断开接入层发 `bye`，只在这一处断），`main.ts` 接着退出（`startDaemon({ onLsmStop })`，测试里不给就只停守护进程）。管理器回 `conflict`（被重复启动了）时退出（`onLsmConflict`）。
- 测试：主切面 `test/main/lsm-link.test.ts`（替身 `helpers/lsm-stand-in.ts` 当管理器），入口 `test/main/entry.test.ts` 的"接入 LSM 的 link 协议"（按 LSM 的方式拉起 `main.ts`，经协议停机后退出码 0、pid 文件删掉）。

**手动验证被杀后的恢复**（真实条目更新、守护进程按新代码重启由主会话做）：条目开着 autoRestart，在任务管理器里直接结束 `ergou-daemon` 的 node 进程（或 `taskkill /F /PID <pid>`，pid 在数据目录的 `daemon.pid`）→ LSM 按退避重新拉起 → `/healthz` 恢复健康 → 被杀前在跑的任务按上面"被杀后的恢复"的规则恢复。有任务处于执行中、或者有有副作用的调用正在执行时，LSM 的 WebUI 上能看到它报"忙"（原因写着任务、调用），"等空闲再停"会等它们做完。

登记（问过用户之后做，二狗自己不启动任何服务）：

1. **装一份专用的 Node 22 LTS**（≥22.19），比如解压官方的 zip 到一个固定目录。不用 PATH 上的 node（PATH 顺序一变可能换成别的版本），也不用 pi 自带的那份（随 pi 升级）或别的程序带的 node；版本先 `node -v` 看一眼。它的 `node.exe` 绝对路径就是 `<专用 Node 路径>`。
2. **主分支的检出目录**（`<仓库路径>`，不是 worktree）在 main 上：`npm ci`，`npm run build:web`。以后每次合并到 main 后重新 `npm ci`（依赖变了时）、`npm run build:web`，再在 LSM 里重启 `ergou-daemon`（只改了 Web 时不用重启，页面每次请求重新读）。
3. **数据目录和密钥**：在 `<用户主目录>\.ergou\secrets\` 下放 `deepseek-api-key.txt`（只有 key 一行）。数据目录其余各区守护进程启动时自己建；要改端口就放一份 `config/ergou.json`（从 `config/ergou.example.json` 复制），同时改条目里的两处 8810（stop 钩子从配置读端口）。
4. **生成真实条目**：复制示例到 LSM 的 `registry/services/ergou-daemon.yaml`，把三个占位符换成本机的值（换完不应再有 `<…>`）。在 LSM 目录跑 `node bin/lsm.mjs validate`（只校验，不碰进程），再 `lsm reload`（或在 WebUI 里重新加载）。
5. **当场验证钩子闭环**（LSM 的纳管要求）：`lsm start ergou-daemon` → `/healthz` 转绿（接入层连上后档位显示 linked）→ `lsm stop ergou-daemon`（接入层连着时走协议优雅停止，端口放出）→ `lsm start ergou-daemon`。通过后在真实条目里填 `onboarding.verifiedAt` 和 `verifiedHooks: [start, stop, health]`。守护进程的输出在 LSM 的 `logs/ergou-daemon.out.log`。stop 钩子核对不上 pid 文件时什么也不做，原因会显示在 LSM 里。
6. **演示**：浏览器打开 `http://127.0.0.1:8810/`，进秘书页发消息，看到逐字输出；刷新后历史还在；断网（比如断开再连上）后不刷新就补上；开两个窗口内容一致。对秘书说"两分钟后提醒我喝水"：聊天里出现提醒卡（可以改、可以取消），看板"运营中"里多一条；到点时任意页面顶上出现提示，待我处理顶部是这条提醒（在待我处理页点"允许浏览器通知"后，还会弹浏览器通知）。对秘书说"算一下 1 到 100 的平方和"：聊天里看到它写脚本、用 bash 跑出结果的工具调用记录（标"通用 bash"），再回答；让它读主目录里的某个文件：聊天和待我处理里出现同一张审批卡，批准后接着读。其他页面仍是原型的假数据。
7. **备份和恢复**：在本机配置（`config/ergou.json`）里写上 `backup.syncDir`（本机同步客户端的同步目录下给二狗的那个子目录，路径只写在本机配置里）。之后每晚 03:30 自动备份，电脑那时关着就在下次启动时补做。出事时：在 LSM 里停掉 `ergou-daemon` → `<专用 Node 路径> packages/daemon/src/restore.ts --list` 看有哪些快照 → `<专用 Node 路径> packages/daemon/src/restore.ts <日期>`（本机备份区那份坏了或没了就加 `--from sync`；要在 LSM 条目一样的环境里跑，数据目录取 `ERGOU_DATA_DIR`）→ 在 LSM 里启动 `ergou-daemon`。守护进程没停时恢复命令拒绝执行；恢复之前的内容挪在 `backups/pre-restore-<时间>/`，只留最近 2 份，更早的自动删掉。

## 公网入口（`ergou-tunnel` 和 nginx，10 号票）

手机等其他设备一律经 VPS 的 HTTPS 域名访问：`https://ergou.<VPS>.sslip.io` →（VPS 上的 nginx，TLS 终止）→ VPS 的 `127.0.0.1:18811` →（`ergou-tunnel`：本机 `ssh -R`，只绑 VPS 的本机地址）→ 本机守护进程的**外网端口** 8811。外网端口上每个请求都要设备凭证，新设备先配对（见上面"设备配对与外网端口"）。二狗自己不启动隧道、不连 VPS；下面都由用户做（问过用户之后），部署由用户在本机运行一条命令，运行即确认。

**外部前提**：上线前先核实 LSM 的两个已知问题已经修好（隧道 PID 复用导致的误判、`vps.key` 路径错误）。这不在本仓库里改。

1. **配置**：在数据目录的 `config/ergou.json` 里填 `publicAccess`（见上面"配置"，从 `config/ergou.example.json` 复制）：VPS 的公网 IP、ssh 私钥的绝对路径、`nginx.listen`。`nginx.listen` 默认 `127.0.0.1:8443 ssl`（`DEFAULT_NGINX_LISTEN`）：如果 VPS 上已有一个按 SNI 分流的前门（nginx `stream` 占着 443，按域名转给本机端口上的各个站点），二狗的站点也只听本机地址，端口写前门转过来的那个（示例配置里是占位符，必须换掉）；VPS 上没有前门、nginx 直接听 443 的，写 `443 ssl`。`nginx.certificateDir` 写现有证书的目录。
   **限频要用户决定**：站在前门后面、前门又没开 `proxy_protocol` 时，nginx 看到的 `$remote_addr` 都是 127.0.0.1——卡片上的来源显示"经前门转发，无法识别"，**配对请求的限频实际上是全局的**（所有人共用 10 分钟 5 个）：仍然安全，只是陌生人刷请求时自己的配对也要等 10 分钟。要按真实来源显示和限频，得在前门上开 `proxy_protocol`（`listen` 加 `proxy_protocol`、`nginx.clientAddress` 写 `$proxy_protocol_addr`）——这会影响同一个前门后面的其他站点，开不开由用户决定，二狗不替用户改前门。
2. **证书**：沿用 VPS 上现有的 Let's Encrypt 做法（比如 `certbot --expand` 把 `ergou.<VPS>.sslip.io` 加进现有证书），本仓库不签证书。
3. **看一眼要部署的配置**：`npm run deploy:nginx -- --print`（只打印，不 ssh）。生成的站点：`/ws` 升级成 WebSocket，`client_max_body_size 256m`，`proxy_read_timeout` / `proxy_send_timeout` 3600 秒，每个 location 都覆盖写 `X-Forwarded-For` 和 `X-Real-IP`，HSTS 一年，上游 `http://127.0.0.1:<tunnelPort>`。
4. **部署**：`npm run deploy:nginx`。一条 ssh（`BatchMode`），VPS 上跑 `sh -s`：写 `/etc/nginx/sites-available/ergou.conf`（旧的留 `.bak`）、链接到 `sites-enabled`、`nginx -t` 通过才 `systemctl reload nginx`，没通过就恢复原来的配置并以非零退出。
5. **登记隧道**：复制 `deploy/lsm/ergou-tunnel.example.yaml` 到 LSM 的 `registry/services/ergou-tunnel.yaml`，换掉占位符（`<仓库路径>`、`<ssh 私钥路径>`、`<VPS 用户>`、`<VPS 地址>`）；再在 `ergou-daemon` 的真实条目里去掉示例末尾 `exposure` 段的注释（`<VPS 地址>` 换掉）。`node bin/lsm.mjs validate`、`lsm reload`，`lsm start ergou-tunnel`。
6. **演示**：手机打开 `https://ergou.<VPS>.sslip.io/` → 配对等待页（设备名可改、6 位短码、8 位短指纹）→ PC 本机 `http://127.0.0.1:8810/` 的待我处理里出现配对请求卡（页面顶上也提示一下），点"核对并批准"，核对一致后批准 → 手机上点"进入二狗"，正常使用 → PC 上"更多 · 设置 · 已配对设备"里看到这台手机，吊销 → 手机上的页面立刻断开、显示"此设备已被吊销"，刷新也不会自动重新申请（点"重新申请"才发起新的配对请求）。

