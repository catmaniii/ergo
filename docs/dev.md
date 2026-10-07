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
| 某个 vitest project | `npx vitest run --project daemon`（project 有 `protocol`、`web`、`daemon`、`pi-contract`） |
| 单个测试文件 | `npx vitest run packages/daemon/test/agent-process.test.ts` |
| 按名字挑测试 | `npx vitest run --project daemon -t "中止"` |
| 监视模式 | `npm run test:watch` |
| 类型检查（各包） | `npm run typecheck` |
| lint | `npm run lint`（oxlint，配置在 `.oxlintrc.json`） |
| 收尾全套 | `npm run check`（类型检查 + lint + 全部测试；主切面里有一条用例会现场构建 Web UI 再扫页面里有没有密钥，所以一条命令就覆盖到真正的构建产物） |
| 构建 Web UI | `npm run build:web`（产物是单个文件 `packages/web/dist/index.html`） |
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
config/ergou.example.json      示例配置（仓库里只有示例，没有个人数据）
deploy/lsm/ergou-daemon.example.yaml  ergou-daemon 的 LSM 条目示例（本机路径是占位符；真实条目只放在 LSM 自己的登记目录），见下面"LSM 登记"
deploy/lsm/ergou-tunnel.example.yaml  ergou-tunnel（公网隧道，只连外网端口）的 LSM 条目示例（VPS 地址、私钥路径是占位符），见下面"公网入口"
```

守护进程 `packages/daemon/src/`：

| 目录 | 是什么 |
|---|---|
| `main.ts` | `ergou-daemon` 的入口（LSM 用 `node packages/daemon/src/main.ts` 启动） |
| `stop.ts` | LSM 的 stop 钩子：读同一份配置，核对"监听本机端口的就是 pid 文件里那个进程、启动时间也对得上"才结束它，否则不动、报原因 |
| `daemon.ts` | 组装：读配置、找数据目录、打开事件存储、建 Job 对象、立起调度器、个人工作日历、卡片、待我处理、简单提醒、设备配对、任务、agent 管家、秘书和维护者、开本机端口和外网端口；停止和启动中途失败共用一份按相反顺序收拾的清单。`startDaemon()` 的 `localPort`、`externalPort`、`heartbeatIntervalMs`、`webRoot`、`programDir`、`secretaryModel`、`secretaryDownThresholdMs`、`clock`、`extraCardTypes`、`embedder`（素材的向量函数）、`backupFiles`（备份往备份区写文件的实现）、`extraSecretaryTools`、`extraQuickActions`（额外登记或替换的快速动作）、`maintainerModel`（维护者的模型，按维护者 id 和第几次唤起给） 给测试用 |
| `download-model.ts` | 下载向量模型的命令（`npm run download-model`），见下面"素材" |
| `deploy-nginx.ts` | 部署公网入口的 nginx 站点（`npm run deploy:nginx`，用户在本机运行，运行即确认）。守护进程不引用它，见下面"公网入口" |
| `restore.ts` | **恢复命令**：从指定日期的快照恢复数据目录（守护进程在运行时拒绝）。见下面"备份、校验与恢复" |
| `config/` | 配置（只读）、数据目录各区的路径（`dataDirLayout`）、模型 key 从哪个环境变量取（`secrets.ts`） |
| `storage/sqlite.ts` | 存储薄接口：所有 SQLite 访问都经过它，换驱动只改这一个文件。`openReadonlyDatabase` 给读派生视图用（只读打开，写不进去）；`vacuumInto`、`integrityCheck` 是整库操作（备份用），在常驻的工作线程（`sqlite-worker.ts`，只转手给 `sqlite.ts` 里的同步函数）里做，不卡事件循环 |
| `events/event-store.ts` | **事件存储**：事件日志是唯一真相（`ergou.db`，WAL）。见下面"事件存储" |
| `events/ephemeral.ts` | 临时事件（只推给正连着的前端）的推送：到点的提醒这类 `notify` |
| `errors.ts` | `RequestRejected`：模块按前端协议的错误码拒绝请求（发消息、卡片动作、待我处理、提醒的时间不对……都用它），网关原样回成错误响应 |
| `cards/` | **卡片**：类型注册表（`registry.ts`）、按钮闭环（`cards.ts`）、派生视图。见下面"卡片和待我处理" |
| `inbox/` | **待我处理**：事项、紧急度、已读 / 归档 / 删除、到点通知。见下面"卡片和待我处理" |
| `scheduler/` | **调度器**和可注入的时钟（`clock.ts`）；**内部作业**（`internal-jobs.ts`，错过的开机后补一次）。见下面"调度器和简单提醒""备份、校验与恢复" |
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
| `secretary/` | 秘书：常驻子进程、长期主线会话（`AgentSession` 配上秘书的差异，加 `/healthz` 用的健康状态）；固定的系统提示在 `system-prompt.ts`；它的工具由守护进程代为执行（见下面"秘书的工具"） |
| `process/` | 进程相关：Job 对象（`job-object.ts`，`processIds()` 列出 Job 里的进程）、全部进程的父进程（`process-list.ts`）、子进程环境（`child-env.ts`）、pid 文件和进程启动时间（`pid-file.ts`；`processRunning` 判断 pid 文件里的进程还在不在） |
| `agent-manager/` | agent 管家：装配会话参数、注入环境、放进 Job、拉起子进程；资源限制（子进程上限和排队、闲置退出、模型调用和工具调用超时、孤儿进程回收 `orphans.ts`，12 号票，见下面"agent 管家的资源限制"）；守护进程代为执行的工具在守护进程这一侧（`host-tools.ts`：`defineHostTool`、`serveHostTools`，见下面"秘书的工具"） |
| `activity/` | **活动状态**（12 号票）：agent 管家报的休眠 / 干活中 / 排队记成活动状态频道上的 `activity` 事件，派生视图 `agent_activity` |
| `tasks/` | **任务**（12 号票）：发起、任务书、计划的检查和存储、计划卡和提问卡和"建议发起任务"卡、状态迁移表（`state-machine.ts`）、秘书的四个任务工具、两种素材的采集规则、确认的计划变成守卫的计划（`plan.ts` 的 `toGuardPlan`）。见下面"任务与计划" |
| `maintainers/` | **维护者**（12 号票：任务自己的维护者）：会话里来了输入就唤起、一次处理一条、闲置退出后再唤起；系统提示、"提交计划"工具。见下面"维护者的唤起" |
| `runtime/` | **运行时封装层**（ADR-0001、ADR-0004）。`host-protocol.ts` 是 agent 宿主协议，`line-channel.ts` 是按行分帧和读行，`agent-process.ts` 是守护进程侧句柄，`agent-child/` 是子进程（pi 只出现在这个目录里）；彻底删除时改写 pi 会话文件的逻辑也在 `agent-child/`（`session-rewrite.ts`、一次性子进程的入口 `rewrite-main.ts`），守护进程经 `session-rewrite.ts` 的 `runSessionRewrite` 拉起它（21 号票，会话文件的格式由契约测试守着）。上层只从 `runtime/index.ts` 取东西 |
| `guard/` | **守卫判定核心**（规格第 9 节，03 号票；时序规则和 v1 模板是 05 号票）。纯函数 `judgeToolCall`；接进运行时的是 `guard-runtime/`。上层只从 `guard/index.ts` 取东西，见下面"守卫" |
| `guard-runtime/` | **守卫接入运行时**（07 号票）：子进程的 `guard_request` 在这里现取环境事实（`facts.ts`、脚本扫描 `script-scan.ts`）、判定、回复（`guard-runtime.ts` 的 `attach` 只做编排）；先问我的一次性授权、等审批和挂起（`approval-waits.ts`）；聊天里的工具调用记录（`tool-call-record.ts`）；效果日志（`effect-log.ts`）；`guard` 频道上的事件和 `CallOrigin`（`events.ts`）；给人看的写法和调用指纹（`describe.ts`）。见下面"守卫接入运行时" |
| `approvals/` | **审批表**（派生视图 `views.ts`）、审批卡（`approvals.ts`：写审批表、建卡、放进待我处理，用户批准或拒绝）、"审批决定"素材的采集规则（`material-source.ts`）。见下面"守卫接入运行时" |
| `hand-over/` | **交给我做**（07 号票）：守卫判定"交给我做"的调用在待我处理里放一个事项，用户点"已完成"后通知 agent。见下面"守卫接入运行时" |
| `typed-shell/` | **带类型的特殊 bash 工具**（28 号票）：git 状态和差异、提交、合并、推送、建远端仓库、跑测试、装依赖、构建，守护进程代为执行、在 Git Bash 里跑（`tools.ts`）；认项目约定（`conventions.ts`）；经闸门进程放进每次调用自己的 Job 再起 Git Bash（`runner.ts`、`runner-main.ts`）。见下面"带类型的 bash 工具" |
| `util/` | 不属于哪个模块的小工具：真实路径 `real-path.ts`（`realPathOf`）、压成一行截短 `text.ts`（`oneLine`） |
| `workday/` | **个人工作日历**（29 号票）：框架自带的节假日数据（`holiday-data.ts`，数据文件在本包的 `holidays/`）、个人设置和事件（`calendar.ts`）、快速动作"改工作日历"（`quick-action.ts`）、节假日数据的续期（`holiday-check.ts`：每月检查、发起更新任务、导入交付件）。别处只从 `workday/index.ts` 取东西，见下面"个人工作日历" |
| `watch-categories/` | **关注类别设置**（26 号票）：设置页的修改、现读数据目录配置区的设置文件（`watch-categories.ts` 的 `WatchCategoryService`，`daemon.watchCategories`）；确定规则的检查和规范化（`match.ts` 的 `normalizeCategoryMatch`，计划里的本任务类别也用）。见下面"关注类别设置" |

### 事件存储（`events/event-store.ts`）

- 事件 `{全局序号, 频道, 频道内序号, 类型, 负载, 时间, 幂等键}`，频道内序号从 1 起连续。对外：
  - `append({ channel, type, payload, idempotencyKey? })`：同一个幂等键第二次追加不落新事件，返回 `{ event: 第一次那条, duplicate: true }`；
  - `appendBatch([...])`：一组事件在同一个事务里追加，要么全落、要么全不落（卡片动作的结果连同它引起的提醒变化、提醒到点时提醒 + 卡片 + 待我处理事项）；每条各按自己的幂等键去重，提交后按顺序通知；
  - `read(channel, afterSeq, type?)`、`lastSeq(channel)`、`eventAt(channel, seq)`、`eventByIdempotencyKey(key)`、`mentioning(type, text)`（负载里含有这段文字的某类事件，彻底删除找记录用）；
  - `ofType(type)`：某类事件全部（启动时对一遍以前的 `messages_purged` 用）；
  - **彻底删除**（21 号票，事件日志不可修改的唯一例外）：`appendBatch(events, { purge: [{ globalSeq, payload }…] })` 在同一个事务里把这些事件的负载换成给出的新负载（消息事件是"已删除"标记 `DeletedEventPayload`，留下消息 id 和时间；别的事件是字段级改写后的负载，见下面"快速动作与记忆命令"），和原来一样的不变，没有这条事件时整组回滚；改写了就整体重放派生视图，提交后做一次 `wal_checkpoint(TRUNCATE)`（连接开着 `secure_delete`）。**派生视图从不收到"已删除"标记**（追加和重放都跳过它），所以各视图不用认它；改写不通知订阅者，要让别处知道就同时追加一条说明（会话频道的 `messages_purged`、卡片的新版本）；
  - `onAppend(listener)`：提交之后同步通知。订阅者在通知里又追加了事件（秘书收到用户消息就追加 `turn_start`）时，新事件排在后面，每个订阅者收到的事件都按追加顺序、一条不漏；
  - `rebuildViews()`：清空派生视图，按全局序号把日志重放一遍；
  - `reader`：只读连接，给视图模块的读取函数用。写一律经 `append`，没有暴露可写的连接。
- **派生视图**实现 `DerivedView { name, create, clear, apply }`，在 `startDaemon` 里交给 `openEventStore({ views })`。`apply` 和事件写入在同一个事务里，抛错则整个追加回滚。视图模块自己提供读取函数（比如 `conversation/views.ts` 的 `listMessages`、`pendingInputs`）。看板、待我处理、审批表……都照这个做。
- 存储接口是同步的（`node:sqlite`），网关"读补发的事件 + 登记订阅"在同一段同步代码里，补发和实时推送之间不重不漏。

### 频道上的事件（04 号票起）

| 频道 | 类型 | 负载 | 落盘 |
|---|---|---|---|
| 会话（`secretary`、`maintainer:<id>`） | `message` | `{ message, idempotencyKey?, taskId?, projectId? }`：定稿的消息；用户发的带发送请求的幂等键（乐观显示靠它替换）；维护者会话里的消息带上所属的任务、项目 id（13、15、16 号票，素材的"任务或项目"取自这里）。用户消息事件里有会话、发言方、时间和原文，08 号票据此采集"用户发言"素材；附件是图片 part 和文件 part，`mediaId` 就是入库版本的 sha256，连同文件名和类型，08 号票据此把附件记为"外部、不可信"的引用加内容哈希 | 是 |
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
| `board` | `task` | `{ task, change, from, by }`（12 号票）：任务的最新状态（`Task`：编号、标题、一句话说明、状态、发起方式、执行的维护者、涉及的项目、阶段 `{ total, current? }`、最新的计划卡）；`change` 是 `TASK_CHANGES` 之一（`created` / `plan_submitted` / `plan_confirmed` / `plan_rejected`，13 号票起往里加），`from` 是迁移前的状态（建出时为 null），`by` 是 `user` / `secretary` / `maintainer` / `system`。见下面"任务与计划" | 是 |
| `activity` | `activity` | `{ agentId, state, since }`（12 号票）：一个 agent 的活动状态变了（`sleeping` / `working` / `waiting_for_user` / `queued`；12 号票报的是休眠、干活中、排队） | 是 |
| `cards` | `questions_answered` | `{ cardId, taskId?, answers: [{ questionId, question, answer, recommended, followedRecommendation, chosenOption }], time }`（12 号票）：用户回答了提问卡，和卡片更新同一事务。"澄清问题的回答"素材的来源 | 是 |
| `tasks`（守护进程内部，前端不订阅） | `task_brief` / `plan_submitted` / `plan_decided` | 任务书（`{ taskId, brief, revision, time }`）、维护者提交的一版计划（`{ taskId, planId, revision, plan, cardId, maintainerId, time }`）、用户在计划卡上的决定（`{ taskId, taskTitle, planId, revision, cardId, decision, plan?, removedGrants, narrowedGrants, note?, by, time }`，"审批决定"素材的来源，类型登记在协议包的 `EVENT_TYPES.planDecided`）。负载的类型在 `tasks/events.ts` | 是 |
| `watch_categories` | `watch_category_settings` | `WatchCategorySettingsEventPayload { state, change, by, time }`（26 号票）：关注类别设置的最新样子（`WatchCategoriesState`：内置九类和各自的默认、现在的处置，两条底线，自定义类别，能匹配的工具，设置文件的问题 `problems`），这次的变化（设置页上的操作，或 `op: "file"`：启动时、文件被手改过或改坏了），谁改的（`user` / `system`）。设置页订阅它；用户的修改带请求的幂等键 | 是 |
| 会话 | `quick_action_executed` | `QuickActionExecutedEventPayload { actionId, action: { type, params }, name, title, explicit, cardId, result }`：一次快速动作的执行，也就是"操作记录"（21 号票），在动作提出的会话频道上，幂等键 `quick-action:<动作 id>`，和执行器的事件、卡片更新同一事务 | 是 |
| 会话 | `messages_purged` | `MessagesPurgedEventPayload { messages: [{ seq, messageId, replacement? }], materialIds, toolCallIds, mediaIds, deletedAt }`：这些消息被彻底删除了（21 号票）：没有 `replacement` 的整条改写成了"已删除"标记，有的（工具调用记录）字段级改写成了 `replacement`。前端据此换掉手里的（不刷新也一样）；记忆模块据此生成会话文件的改写参数（`toolCallIds` 是要改参数和结果的工具调用）、删掉没人再引用的附件（`mediaIds`） | 是 |
| `materials`（守护进程内部，前端不订阅） | `memory_command` | `MemoryCommandEventPayload`：一条显式记忆命令，按命令种类分两种形状：`RememberCommandPayload { commandId, command: "remember", content, source, from }`（`source` 是点明在哪里：`typed` / `quote` / `card` / `proposed`）、`DeleteCommandPayload { commandId, command: "forget" \| "purge" \| "no_infer", materialIds, from }`；`from` 是聊天里的哪张卡（`chat`）或设置里的哪个范围（`settings`，只有删除类）。素材模块据此产生"显式记忆命令"素材，并删除、标记已有的素材（重建时同样照做），见下面"快速动作与记忆命令" | 是 |
| `internal`（内部频道，不在前端协议里，前端订阅不到） | `internal_job` | `{ job, since, lastRunAt? }`：内部作业的最新状态（第一次见到它的时间、上一次开始跑的时间），启动时据此判断错过了没有。见下面"备份、校验与恢复" | 是 |
| `internal` | `holiday_update_task` | `HolidayUpdateTaskPayload { taskId, itemId, year, regions }`：用户在"节假日数据缺失"事项上点"发起更新任务"发起的任务是哪一年哪一边的更新，和建任务的事件同一事务追加；任务完成后据此导入交付件（29 号票），见下面"个人工作日历" | 是 |
| `workday_calendar` | `workday_settings` | `WorkdaySettingsEventPayload { settings, source, change? }`：个人设置（额外上班规则、手动标记）的最新样子；`source` 是 `settings`（设置页）/ `quick_action`（快速动作）/ `config_file`（启动时读入配置文件，和上一条不一样：停着时手改过、从备份恢复了配置区）（29 号票） | 是 |
| `workday_calendar` | `holiday_data` | `HolidayDataEventPayload { years, imported? }`：工作日历用的节假日数据（框架自带的加上导入的）的最新样子；启动时有变化、导入新一年的数据时追加（29 号票） | 是 |

秘书的输入队列就是事件日志：用户消息事件进队，交给秘书时追加 `turn_start`，处理完追加 `turn_end` 出队（派生视图 `agent_inputs`：等着 / 正在处理 / 处理完）。运行时给秘书的通知（`agentInput` 的系统消息，`conversation/messages.ts` 的 `appendAgentNotice(store, conversation, text, key)`）同样进队，交给秘书时开头标 `SYSTEM_NOTICE_TAG`（"[系统通知]"）。模型出错时会话里多一条发言方为 `system` 的说明（不进队）。

**处理到一半被打断的输入不重送**：秘书子进程崩溃、或者守护进程重启时，有 `turn_start`、没有 `turn_end` 的那条以 `interrupted` 结束出队，会话里追加一条系统说明（"上一条消息「…」处理时中断了，秘书没有接着处理；需要的话请重发。"），不再交给秘书；排在它后面、还没开始的照常处理。从会话文件最后一个完整回合续上的恢复规则在 23 号票。

### 网关（`gateway/`）

- 两个端口，都只监听 `127.0.0.1`：本机端口 `ports.local`（默认 8810）自动信任；外网端口 `ports.external`（默认 8811）是隧道的唯一目标，每个请求都要设备凭证（见下面"设备配对与外网端口"）。**本机信任只看从哪个端口进来，不看来源 IP。** 下面这几条说的是本机端口。
- 每个 HTTP 请求和 WebSocket 握手都校验：Host 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`（防 DNS 重绑定）；带了 Origin 就必须是这两个源之一（防跨站请求和跨站 WebSocket）；不带 Origin 的本机程序（LSM 的探针、不在浏览器里的前端）放行。不看来源 IP。
- `GET /`：原样发出 `packages/web/dist/index.html`（每次请求重新读）；没构建时回 503 并提示 `npm run build:web`。
- `GET /healthz`：`{ ok, secretary, webUi, reasons }`。秘书不在运行（拉起中、意外退出后重新拉起中）超过阈值（默认 30 秒）或者 Web UI 没构建时，`ok` 为 false、回 503，`reasons` 写明原因；秘书闲着或在干活时健康。
- `/ws`：前端协议。格式不对的请求得到错误响应，连接不断。**心跳**（10 号票）：服务端每 30 秒（`heartbeatIntervalMs`）ping 一次，上一轮没回 pong 的连接（半开的：对方已经没了、连接没正常关掉）直接断掉；外网端口上的连接每次心跳顺带复查凭证（吊销了、过期了就关掉，关闭码 `WS_CLOSE_UNPAIRED` 4401），还有效就算用了一次（续期）。
- `/api/access`：这个请求被信任吗（`AccessInfo`：`local` / `device`（带设备 id 和名字）/ `none`）。两个端口都有，不需要凭证；前端打开时先问它。外网端口上带着失效的凭证来问时，`none` 带上原因 `reason`（`revoked` / `expired`，`CREDENTIAL_REJECTIONS`）——同一个响应让浏览器删掉凭证，所以只有第一次问时有。
- 请求的分发在 `FrontendConnection.dispatch`：发消息直接调会话模块；卡片动作、待我处理的动作、吊销设备、发起任务交给 `startGateway({ requests })` 里的 `RequestHandlers`（`daemon.ts` 接到 `cards.act` / `inbox.act` / `pairing.revoke` / `tasks.startFromButton`）。模块拒绝时抛 `RequestRejected(code, message)`，网关回成同样的错误。
- 临时事件有两个来源：流式增量（`streams`）和别的通知（`notifications`，`events/ephemeral.ts`），都只推给订阅了那个频道、正连着的前端。
- **重新同步**：订阅时前端带来的序号比某个频道的最后序号还大（比如数据目录恢复成了旧快照），订阅响应的 `resync` 里点名这个频道，服务端从头补发它的事件；前端收到后先清掉这个频道的状态。
- **会话频道第一次只补发最近一页**（09 号票起）：前端在会话频道上什么都没有（游标为 0，或者要重新同步）时，只补发最近 50 条消息（`HISTORY_PAGE_SIZE`）起的全部事件；更早的经 HTTP 往上翻（`conversation/history.ts`）。带着游标重连的照旧补发缺的全部事件。两边按同一个序号切开，交界处不重不漏。
- `/api/`：HTTP 接口（`http-api.ts`；路径怎么拼 `HTTP_PATHS`、怎么拆 `parseHttpPath`、查询参数的名字 `HTTP_QUERY` 都在共享协议包的 `http.ts`，两边不各自拼），见下面"媒体与附件"：
  - `POST /api/uploads`、`GET|PUT /api/uploads/<上传 id>`、`POST /api/uploads/<上传 id>/complete`：分片续传上传；
  - `GET /api/media/<媒体 id>?name=&download=`：下载，支持 Range（206、416）；
  - `GET /api/conversations/<会话>/messages?before=&limit=`：历史分页，返回 `HistoryPage`（序号小于 `before` 的最近若干条消息，`hasMore` 表示更早还有；`limit` 默认 50、最多 200）。被彻底删除的消息是 `{ seq, deleted }`（`HistoryMessage` 是联合），原文不在了；
  - `POST /api/materials/scope`（`MaterialScopeBody { scope? }` → `MaterialScopeSummary { count, conversations }`）、`POST /api/materials/delete`（`DeleteMaterialsBody { scope, mode, idempotencyKey }` → `{ count }`）：设置里按会话、按时间段删除素材（21 号票），见下面"快速动作与记忆命令"。
  - `GET /api/workday-calendar?month=YYYY-MM`（→ `WorkdayMonthView { month, days, settings, missing }`：每天上班或休息及原因、个人设置、这一年缺哪边的节假日数据）、`POST /api/workday-calendar`（`WorkdayChangeBody { change }` → `WorkdayChangeResult { settings, changed }`）：设置里的工作日历（29 号票）。改动本身是幂等的（同一条规则只有一份、同样的标记再标没有变化），不带幂等键；有变化时工作日历频道上推一条 `workday_settings`。
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
- **发给模型前的投影**（`conversation/model-projection.ts`，带版本号的纯函数，现在是第 1 版，在 `projection-v1.ts`）：**每个版本自成一个模块，用到的常量和小函数（文本扩展名表、附件分类、大小的说法、32 KB 上限、解码……）都归它自己**，不从会变的模块取，别处要用就各自定义或从 `media/file-types.ts` 这类不随投影版本变的模块取。第 1 版：第一行是消息的本地时间标记 `[YYYY-MM-DD 周X HH:mm ±HH:MM]`（发送时间按配置的 `timeZone` 换算）；之后各 part 空一行：卡片引用 → 一行摘要（卡片的纯文本降级 `text`，秘书按 `card_ref` 从卡片视图取）；图片 → 支持视觉时是图片输入、正文里"[图片 n：文件名]"，不支持时"[图片：文件名]"；文本类文件（按扩展名和类型认，含 markdown、代码、CSV；不是 UTF-8 的按 GB18030 解）→ 内联前 32 KB，超出的提示用 `read_attachment` 读；PDF → 先抽文本（`unpdf`，用到时才加载）再按文本类处理；其他类型 → 只给文件名、类型和大小；语音 → 转写（预留）。读文件、抽 PDF 由调用方做好交进来（`media/attachment-content.ts` 先问这一版要什么：`projectorOf(version).contentNeeded(part)`），投影本身不碰文件。**改规则就加一个新版本**（新文件，在 `model-projection.ts` 的表里登记），旧版本原样留着。
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
- `run(ctx)` 拿到动作之前的卡片和负载、动作、`note`、按 `input` schema 校验过的输入（类型是 `Static<input>`）、现在的时间和请求的幂等键；返回动作之后的状态（`pending` 表示卡片还能再操作，比如改了提醒）、新的负载、处理说明，以及要随卡片更新一起追加的事件（同一事务，排在卡片更新之前）。不让做就抛 `RequestRejected`。
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
- **时间规则只在一个模块里**：共享协议包的 `reminder-schedule.ts`。`ReminderSchedule` 的 schema、重复规则 `RepeatRule`（种类 `REPEAT_KINDS` 只定义这一次）、以及全部按规则种类分支的逻辑：`nextOccurrence`（下一次响的时间）、`scheduleClockTime`（钟点）、`withClockTime`（只改钟点）、`repeatSchedule` / `repeatRuleOf`（重复规则和时间表互转）、`isRepeating`、`describeSchedule` / `describeTime`（中文写法，"每月 31 号"会写明没有这天的月份在月底）。守护进程（提醒模块、秘书的工具、内部作业）和 Web（提醒卡、编辑框、看板）都用它，别处不按 `schedule.kind` 分支。重复规则有每天、每周几、每月几号、**按我的工作日**（`{ kind: "workdays", time }`，29 号票）：只在个人工作日历上的上班日响。`nextOccurrence(schedule, after, context)` 的第三个参数 `ScheduleContext { calendar }` 必填（漏传编译时就报错），每次按当时的工作日历算；哪些时间表要跟着工作日历变，问 `dependsOnWorkdayCalendar(schedule)`（提醒的 `recalculate`、内部作业的 `rearm` 都用它，不自己看 `kind`）。只要某个钟点下一次出现的时刻（不管工作日历）用 `nextClockTime(time, after)`。19 号票的定时作业沿用这同一套。
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
  - 导入交付件：`holidayUpdates.importForTask(taskId)`——不是更新任务返回 `undefined`；是的话把产出区 `outputs/<任务 id>/` 里的 `<地区>-<年>.json` 逐个交给 `workdayCalendar.importHolidayFile(路径)`（`checkHolidayYear` 校验后放进 `config/holidays/`，推一条 `holiday_data`），没交的、不对的写进 `problems`（什么都不改）。数据补上后对应的缺失事项自动归档（标题加"（已补上）"）。**怎么接 13 号票**：13 号票提供"任务完成后回调"的登记点后，在 `daemon.ts` 里登记一个回调，任务完成（验收通过）时调 `holidayUpdates.importForTask(task.id)`，`problems` 不空就在待我处理里放一条说明。接上之前只能手动调（测试就是这样）。

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

## 快速动作与记忆命令（`quick-actions/`、`memory/`，21 号票）

规格第 7、9 节"快速动作的确认"、第 14、15 节。快速动作是一步就能做完、不需要别人干活的操作：秘书用"提议快速动作"工具（`propose_quick_action({ type, params, explicit? })`）提出，**是直接执行还是先问用户由运行时判定**，不拉起别的 agent、不上任务看板。

- **执行器注册表**（`quick-actions/registry.ts`）：每种动作一个执行器，`defineQuickAction({ type, title, usage, params, watch, confirm?, normalize, explicit?, proposalCard?, execute })`。
  - `params` 是这种动作自带的参数 schema（TypeBox，参照卡片动作的 `input`）：秘书给的 `params` 先按它校验（不合就回"参数不对：……"），再交给 `normalize(params)`（类型由 schema 推出），得到规范化后的动作 `{ params, title, target?, content? }`（存进卡片和操作记录的参数、一句话的标题、展示用的对象和内容）。工具说明里自动列出登记了的动作和各自的参数（`tool.ts` 的 `paramsHint`）。
  - `watch` 的形状同工具注册表的登记：`{ categories, bottomLines?, notifyWhenDone?, args?, outbound? }`（`args` 是规范化后参数里哪些是收件人、金额、路径……，自定义类别按它们匹配）。
  - `execute(params, context)` 返回要和卡片、操作记录同一事务追加的事件、结果说明，彻底删除还给出要改写的事件 `purge`。
  - 29 号票加了 `workday_calendar`（"改工作日历"，`workday/quick-action.ts`，一律先确认），见下面"个人工作日历"。
  - **22 号票的任务控制、27 号票的 MCP 调用照这个加**：只加一个 `defineQuickAction` 的登记，在 `daemon.ts` 里 `quickActionRegistry.register(...)`（测试用 `startTestDaemon({ quickActions })` 加替身，`test/helpers/quick-action-fixtures.ts`）。
- **"明确点了"**（`explicit.ts`）：每个执行器用 `explicit(action, turn)` 自己声明，不写就永远算推断；`turn` 是用户这一轮的话（`UserTurn { typed, quotes, cards }`：自己打的字、引用块里的、引用的卡片上的文字）。共用的辅助函数：`foundIn(turn, text)`（规范化后原样出现在哪一部分，给出 `ExplicitFinding { source: "typed" | "quote" | "card" }`）、`commandTails(turn, triggers, negations)`（触发词后面到句末的那一段，触发词前面同一分句里有否定词的不算）、`bareText`（NFKC、去掉空白和标点后比较）、`NEGATIONS`（别、不要、不用、不必、无需、甭）。秘书在参数里自称"用户点明了"不作数（只记日志）。`confirm: "always"` 的执行器（忘掉、彻底删除、别推断）不论点没点明都要核对。
  - **记住**（`memory/memory-commands.ts` 的 `rememberExplicit`）：用户的话里有触发词（记住、记下来、记下、记一下），前面没有否定词（"别记住……"不算），并且提议的内容和触发词后面到句末的那一段一致（去掉标点和空白）；那一段只是指代（"这个""这条"……）时，内容要和引用块或引用的卡片上的一段一致。否则按推断处理，出确认卡。
- **处置**（`quick-actions/judge.ts` 的 `judgeQuickAction`）：动作作为一个伪工具调用（`quick_action:<动作类型>`，参数是规范化后的参数，`watch` 是它的登记）交给守卫的 `judgeToolCall`，所以**用户的自定义关注类别也管快速动作**（按工具名 `quick_action:<类型>`、收件人、金额、路径匹配）。硬拒绝 → 不出卡；点明了 → 只看底线（付款、改密码……仍然交给我做或永不）；推断 → 内置类别和自定义类别在对话里的处置、底线、`notifyWhenDone` 取最严，"计划里列了才做"在对话里等同先问，按规则退回的至少先问；`confirm: "ask_when_inferred"` 的（记住）推断时至少先问。会执行 → 快速动作卡出来就是"已执行"（`status: handled`，带结果），和执行器的事件、操作记录同一事务；先问 → 卡片待处理，同时放进待我处理（来源"秘书对话"，不卡任务），用户点"执行"才做、点"取消"关掉；交给我做、永不 → 不出卡，告诉秘书原因。**操作记录**就是会话频道上的 `quick_action_executed`。卡片的负载 `QuickActionCardPayload` 里带动作的中文名 `name`，处置是前端协议的写法（`do` / `ask_first`……）。
- **记忆命令**（`memory/memory-commands.ts`）：`remember`（参数 `{ content }`；执行时追加 `memory_command`，素材模块产生"显式记忆命令"素材，来源按点明在哪里：自己打的字 → 本人、打字；只在引用块里 → 外部不可信；只在引用的卡片上 → 用户的选择、注明 agent 先提出；推断出来、用户在卡上确认的 → 注明 agent 先提出）；`forget` / `purge` / `no_infer`（参数 `{ materialIds }`，秘书先用 `search_materials` 检索，把素材 id 放进去，最多 `MAX_MEMORY_DELETE_MATERIALS`（50）条；总是出**记忆删除卡** `memory_delete`，负载 `MemoryDeleteCardPayload` 列出匹配的素材：种类、时间、会话、摘录。用户在卡上可以去掉几条、换一种删法，动作 `delete` 的输入是 `MemoryDeleteInput { mode, materialIds }`，素材 id 必须在卡上）。三种删法的说明（卡上、设置页上同一份）是协议包的 `MEMORY_DELETE_MODE_INFO`，彻底删除的说明带上删不掉的（`PURGE_LIMITS`：秘书回复里转述过的话；备份快照里的一份，随快照轮换消失，本机约 7 天，同步目录最长约 5 周）：
  - **忘掉**：追加 `memory_command`（先记事件，否则重建会让素材回来，ADR-0006），素材模块删素材、索引和原文副本；聊天历史里原话还在；
  - **别推断**：素材和索引保留，标"不参与推断"（`Material.noInfer`，检索结果里注明）；
  - **彻底删除**（`memory/purge.ts` 的 `purgePlan`，取舍见 ADR-0008）：忘掉之外，改写事件日志里带原话的事件。**只有消息事件整条换成"已删除"标记**；别的事件按事件类型**字段级改写**：只把带原话的文本字段换成 `PURGED_TEXT`（"（这条内容已彻底删除）"），id、状态、决定原样保留，所以派生视图重放后审批表仍是已批准或已拒绝、卡片仍是已处理、效果日志条数不变。改写函数按事件类型登记成一张表（`memory/rewriters.ts` 的 `PurgeRewriters`，在 `daemon.ts` 里登记，形状 `PurgeRewriter { eventType, rewrite(event, context) }`，辅助函数在 `events/purge.ts`）：消息（`conversation/purge.ts`：只有工具调用记录的消息换掉参数摘要和结果摘要，别的整条换成标记）、卡片（`cards.ts` 的 `cardPurge`：负载交给卡片类型登记的 `purge`，处理结果里用户写的说明换掉）、卡片被关闭和长期没处理（`materials/sources.ts`）、"记住"的命令（`materials/commands.ts`）、审批决定（`approvals/material-source.ts`）、效果日志（`guard-runtime/effect-log.ts`）、操作记录（`quick-actions.ts`）。**没登记改写函数的事件类型被点到时整个彻底删除被拒**。改写的范围：素材的原始事件；"记住"来的素材连同它的记忆命令、操作记录、快速动作卡的每个版本、提议它的那次工具调用的记录（按卡上记的 `toolCallId` 找）和紧跟着的效果日志；素材卡片上用户写的说明；审批决定那次工具调用的记录（按审批请求里的工具调用 id 找，会话文件里那次调用的结果也改）、挂起之后才拒绝时递给 agent 的那条通知（按幂等键 `approvalDeniedNoticeKey` 找）；检索素材那次调用的记录（按素材 id 找）和紧跟着的效果日志、提到素材 id 的效果日志；列出过这些素材的卡片。会话里被改写的消息另在会话频道追加 `messages_purged`（整条删掉的只给消息 id；字段级改写的给出改写后的样子 `replacement`；还有要改写会话文件的工具调用 id `toolCallIds`、被删消息引用过的附件 `mediaIds`）；改写过的卡片追加一个改写后的新版本（记忆删除卡自己的新版本摘录清空、标 `purged`）。删除类的记忆命令事件本身不改写（里面只有素材 id，它是"这些被删了"的记录）。聊天里的卡片动作和设置里的批量删除共用 `memory/deletion.ts` 的 `deletionEvents`（记事件 + 算改写）。
  - **附件**（`memory/after-purge.ts` 的 `startPurgedMediaCleanup`）：`messages_purged` 里的 `mediaIds`，没有别的（未删的）消息、也没有素材还引用同一个哈希的，删掉媒体文件（`MediaStore.remove`，连同派生文件），按媒体 id 下载回 404；启动时把以前的 `messages_purged` 再对一遍。
  - **SQLite 不留残余**：`ergou.db`、`memory.db` 的写连接开 `secure_delete`（`storage/sqlite.ts` 的 `openDatabase`），彻底删除后各做一次 `wal_checkpoint(TRUNCATE)`。
- **会话文件的改写**（ADR-0008，和 ADR-0004 的关系见那里）：每条交给子进程的输入在 pi 会话文件里前面有一条 `ergou-input` 自定义条目（`SESSION_INPUT_TAG`，记输入 id 即消息 id）。改写逻辑在 `runtime/agent-child/session-rewrite.ts`（用 pi 的类型），由一次性子进程 `agent-child/rewrite-main.ts` 执行（stdin 收 `SessionRewriteRequest`，stdout 回 `SessionRewriteResult { files, entries, summaries }`）；守护进程经 `runtime/session-rewrite.ts` 的 `runSessionRewrite` 拉起它，agent 管家的 `rewriteSessions(agentId, request)` 是上层的入口（agent 子进程还活着时拒绝）。改写范围：按输入标记找到的用户消息、按工具调用 id 找到的工具调用参数（参数里的字符串）和工具结果、素材检索结果里提到被删素材的行（"- <素材 id> · （这条内容已彻底删除）"）；被改的条目在某次压缩保留的第一条之前时，那段压缩摘要整段换成 `PURGED_SUMMARY_TEXT`，在被改条目之后的分支摘要也一样。改写保留修改时间（pi 按它挑最近的会话），是幂等的。**改写哪些由记忆模块从 `messages_purged` 生成**（`after-purge.ts` 的 `sessionRewriteFor`，交给秘书和维护者的 `sessionRewriteFor` 选项）；停、改、拉起由 `AgentSession`（`conversation/agent-session.ts`，见下面"agent 会话"）做：等手头这一条处理完，停掉子进程、改写、接着同一个会话拉起（和崩溃重启共用 `relaunch`）；会话 `start()` 时（秘书在守护进程启动时，维护者在它的会话第一次建好时）把以前的 `messages_purged` 先对一遍再拉起。**不改写的**：秘书自己的回复和检索时写的查询词、审批请求里 agent 要做的那次调用的参数摘要、本票之前的会话文件里没有输入标记的消息。
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

- 宿主协议（`HOST_PROTOCOL_VERSION` 3；3 在装配参数里加了必填的 `shellEnv`，07 号票）：会话装配参数 `hostTools: HostToolSpec[]`（名字、说明、参数的 JSON Schema）；子进程把它们登记成 pi 的自定义工具（`runtime/agent-child/host-tools.ts` 的 `HostToolBridge`；不受工具白名单限制，一次一个、按模型给出的顺序执行），模型调用时发 `host_tool_call { requestId, toolCallId, toolName, args }`（`args` 是 `JsonValue`），等守护进程回 `host_tool_result { requestId, result: { text, isError } }`（`isError` 必填）。pi 先按 JSON Schema 校验参数，不合就不转；等结果时回合被中止，这次调用按出错结束。打开守卫转发时，这些调用和别的工具一样先经 `tool_call` 钩子判定。契约测试在 `test/contract/host-tools.contract.test.ts`（只有这一个文件）。
- 守护进程这边（`agent-manager/host-tools.ts`）：`defineHostTool({ name, title, description, parameters, categories?, bottomLines?, args?, readOnlyOrIdempotent, run })` 定义一个工具（参数用协议包的 `Type` 写，序列化成 JSON Schema 交给子进程，守护进程再按同一个 schema 校验一次）。`title`（中文名）和后面几项是它在守卫工具注册表里的登记（`HostTool.descriptor`，来源 `host`）：类别标签、底线标签、要守卫检查的参数规则（路径、收件人……，不写的参数守卫不看）、"只读或幂等"（必填，重做一次没有额外效果才写 true，拿不准的从严写 false；23 号票被杀后的恢复据此决定能不能重做）；只产生卡片的工具什么类别都不写；`run(args, { toolCallId, inputMessageId?, signal? })` 返回 `{ text, isError?, cardIds? }`（可以是 Promise），抛错等同于出错（错误记日志，模型只看到"没做成"）。`signal`（28 号票）在子进程那边已经结束了这次调用（这一轮被中止、管家按超时中止）或 agent 退出时中止，跑得久的工具据此结束它起的进程。`serveHostTools(agent, tools, { log, onCards, context? })` 接上一个子进程：按名字找工具、执行、回结果；有 `cardIds` 时先调 `onCards`；`context()` 在调用到达时取，补进 `HostToolCall`（`AgentSession` 给正在处理的输入 id）。
- 秘书：自己的附件工具（`media/attachment-tools.ts`）加上 `startSecretary({ tools })` 交进来的（`daemon.ts` 交 `reminders/tools.ts` 的三个提醒工具、`tasks/secretary-tools.ts` 的四个任务工具，21 号票的 `search_materials`、`propose_quick_action`），`onCards` 往会话里追加一条只有卡片引用的消息，卡片就出现在聊天里。15（建议立项）照提醒工具的样子用 `defineHostTool` 加。工具要跑得久的，在 `defineHostTool` 里写 `timeoutMs`（不写按配置的工具调用超时，见下面"agent 管家的资源限制"）。`AgentSession` 把这些工具的登记加进会话的工具注册表（`registerTools(BUILTIN_TOOL_REGISTRY, ...tools.map((t) => t.descriptor))`），它们的调用和文件工具、bash 一样先经守卫判定（07 号票）。
- 提醒工具的时间：知道当前日期时写具体的日期时间（`at`）或周几（`weekday`），不知道时写"几天后的几点"或"几分钟后"，日期由守护进程按（可注入的）时钟算；工具结果里写明落到了哪天、星期几、几点。

## 关注类别设置（`watch-categories/`，26 号票）

规格第 9 节。用户的调整和自定义类别是数据，放在数据目录配置区的 `config/watch-categories.json`（守卫的写法：`{ builtin: { <类别>: { chat?, task? } }, custom: [{ id, title, match, chat, task }] }`）。**文件是真相**（守卫每次判定现读，取舍见 ADR-0009），关注类别频道上的事件是给设置页的同步。

- **只有 `WatchCategoryService` 写这个文件**（`daemon.watchCategories`）：设置页发 `update_watch_categories`（`UpdateWatchCategoriesParams`：`set_builtin` / `create_custom` / `update_custom` / `delete_custom` / `repair` / `reload`，处置用协议的写法），校验通过就先写临时文件再改名，再追加一条 `watch_category_settings`（带请求的幂等键：同一个键重发只改一次）。校验：
  - 内置类别只能不比默认松（和默认一样就是去掉这一项）；"—"的场景（计划外工单在对话里）不适用；两条底线不在注册表里，改不动——这几条在守卫的 `editWatchCategorySettings`（`guard/watch-categories.ts`，纯函数，表格测试在 `test/guard/watch-category-settings.test.ts`），违反的回 `not_allowed`；
  - 自定义类别的规则过 `normalizeCategoryMatch`（`match.ts`）：至少一个条件；工具要认得（`daemon.ts` 的 `watchToolChoices`：内置和 bash 拆出的伪工具、秘书代为执行的工具、快速动作 `quick_action:<类型>`；27 号票的 MCP 工具加进这里）；路径要写完整的 Windows 路径；不对的回 `bad_params`；改、删不存在的回 `not_found`；
  - 新建的 id 是 `c-<n>`，n 按建过的个数往上数，删掉的 id 不再用（计划里对它的调严不会落到新类别上）。
- **现读**：`current()` 读文件（原文没变就用上次的解析结果），和关注类别频道上最后一条事件不一样（启动时还没有事件、用户手改过、改坏了）就追加一条 `by: "system"`、`change.op: "file"` 的事件。守卫接入（`createGuardRuntime({ settings })`）、任务模块（`createTaskService({ watchSettings })`）、快速动作都经它取，所以文件被手改坏了，下一次判定出错的同时设置页就看到问题。`start()` 在秘书拉起之前读一遍。
- **文件坏了**：`current()` 抛错，守卫以"判定出错"拦下（07 号票的行为）；事件的 `state.problems` 写着问题，表格仍是上一次有效的设置。这时别的修改回 `not_allowed`，只能 `repair`（`last_valid` 恢复成上一次有效的设置，`defaults` 恢复默认；坏掉的文件另存为同目录的 `watch-categories.broken.json`）或 `reload`（用户手改好了）。
- **agent 写不进去**：配置区是受保护区域，文件工具、bash 写入判"永不"（03 号票）；26 号票补了脚本：拆不开的内联脚本（`node -e`、`python -c`、`sh -c`……）的命令原文里、要跑的脚本文件里（`script-scan.ts` 报上来的 `ScriptFact.mentionedPaths`）写着受保护区域的路径，也判"永不"（`judge.ts` 的 `scriptTextRule`，路径从文字里认用 `guard/paths.ts` 的 `absolutePathsIn`：写死的盘符路径、转义过的反斜杠、Git Bash 的盘符写法；尽力而为，拼出来的认不出）。

## 任务与计划（`tasks/`、`maintainers/`，12 号票）

规格第 7、8 节。从秘书聊天一路走到一张可以确认的计划卡；排队中 → 执行中、阶段执行和验收在 13 号票。

**流程**（`tasks/tasks.ts` 的 `TaskService`，`daemon.tasks`）：

1. 发起，三条路，建出的任务都是"规划中"，在任务看板频道推一条 `task` 事件（`change: "created"`）：
   - 用户点"发起任务"按钮：`start_task { request, projects? }` 请求（`startFromButton`，第一行当标题，同一个幂等键重发拿到同一个任务；`projects` 是用户多选的涉及的项目，写进 `Task.projects`）。不经秘书判断，同一事务给秘书一条通知（`buildAgentNotice` 那种系统消息，写明用户选了哪些项目，写任务书时以它为依据）让它接着澄清。用户写的原话从这条 `task` 事件记成"用户发言"素材；
   - 用户在消息里要秘书去做：秘书用 `create_task` 直接建（`createByRequest`），这一轮不出建议卡；
   - 秘书自己发现、用户没要求的：`suggest_task` 只出一张"建议发起任务"卡，用户点卡上的"发起任务"才建出（卡片动作和建任务同一事务，卡上的负载补上 `taskId`），秘书收到通知。
2. 澄清：秘书用 `ask_questions` 成批提问（提问卡，每题带推荐答案，题号 `q1`、`q2`……由工具给）。用户回答（`answer`，输入 `QuestionsAnswerInput`，每题都要答）后，卡片频道上同一事务多一条 `questions_answered`（"澄清问题的回答"素材的来源），答案作为通知交回秘书。
3. 任务书：秘书用 `write_task_brief`（目标、验收标准、约束、涉及的项目、记忆范围提议）写，`writeBrief` 存进内部 `tasks` 频道（`task_brief`，改了版本加 1），**同一事务**把任务书作为一条通知追加到执行的维护者的会话频道（带 `taskId`）——维护者模块看到它就唤起维护者（见下面"维护者的唤起"）。只有规划中的任务能写任务书。
4. 计划：维护者用 `submit_plan`（参数就是协议包的 `Plan` schema，pi 先按它校验）交出计划。`submitPlan` 再按 `plan.ts` 的 `checkPlan` 查一遍（见下），不过就抛 `RequestRejected`，原因作为工具结果交回维护者，不出卡；过了就同一事务：`plan_submitted`（`tasks` 频道，计划存在这里、不在 pi 会话里）、计划卡（`plan`，`blocking`）、任务转待确认（`planCardId`、`stages.total` 取自计划）、待我处理的卡片事项（"计划等你确认：……"），再 `inbox.alert`。计划 id 是 `<任务 id>-p<版本>`。
5. 计划卡：`confirm`（输入 `PlanConfirmInput`：`removeGrants` 勾掉的授权项 id、`narrowGrants` 收窄的、`assumptions` 改过的假设栏（整栏）；只能收窄，按守卫的 `validateGrantChange` 查，放宽的被拒）→ 存储里的计划随之改变（`plan_decided` 里是确认的那份，卡上的负载换成它，并记下 `removedGrants`（勾掉的授权项原样，`PlanGrant[]`，两处同名同形）、`narrowedGrants`（id）、`assumptionsEdited`），任务转排队中；`reject`（必须附意见）→ 任务回到规划中，意见作为通知交回维护者，它重新 `submit_plan` 出一张**新的**计划卡（版本加 1）。两个动作都追加 `plan_decided`（"审批决定"素材的来源）。

**状态迁移**（`tasks/state-machine.ts` 的 `TASK_TRANSITIONS`，"谁能改"表；`checkTaskTransition(from, to, by)` 每次迁移都过一遍，不合的抛 `not_allowed`）：12 号票用到的是 规划中 →（维护者，提交计划）待确认 →（用户，确认计划）排队中、待确认 →（用户，打回计划）规划中；表里已经写好 13、15、22 要用的（排队中 → 执行中、暂停 / 继续（排队中 → 已暂停也在）、完成 / 失败、返工、归档、取消、**转为项目**——用户把任何未结束的任务转为项目，以"已完成 · 已转为项目"结束：`Task.endKind: "converted_to_project"`、变化 `converted_to_project`），后面的票直接用，别另写判断。同一对状态之间可以有几行（执行中 → 已完成：维护者"完成"、用户"转为项目"），谁能做看全部这几行。任务状态 `TASK_STATES`、未结束的 `UNFINISHED_TASK_STATES`、发起方式 `TASK_ORIGINS`、谁改的 `TASK_ACTORS` 和 `TASK_ACTOR_LABEL`、变化 `TASK_CHANGES`（加新的变化时往这里加）在协议包 `tasks.ts`。

**编号**：任务 `t-1`、`t-2`……；任务自己的维护者 `tm-1`、`tm-2`……（建卡时产生，`Task.maintainerId`），会话频道 `maintainer:tm-1`，pi 会话在会话区 `sessions/tm-1/`，工作目录是输出区里任务自己的一格 `outputs/t-1/`。

**计划的数据结构**（协议包 `task-schema.ts` 的 `Plan`；13、14、16、17、19、20、24、26 号票读它）：

| 字段 | 是什么 |
|---|---|
| `stages[]` | 阶段：`stageId`（`s1`……，`PLAN_ID_PATTERN`）、`title`、`deliverables[]`（交付件）、`acceptance[]`（`{ criterion, method: script \| review \| user, script? }`，`script` 方式必须带命令）、`mode`（`steps` 定步，必须带 `steps[]`；`open` 开放）、`dependsOn[]`（前置阶段，不能成环）、`policy`、`budget { tokens, toolCalls }`、`groupId?` |
| `stageGroups[]` | 阶段组：`groupId`、`title`、组里各阶段共用的 `policy` |
| 策略 `PlanPolicy` | 术语表的"策略"：`{ grants[], temporalRules[] }`，挂在阶段上，或者定义一次、套给整个阶段组。检查、列授权项、交给守卫时的展开都按策略走（协议包 `plan.ts` 的 `planPolicies`、`planGrants`：各阶段的在前，阶段组的在后） |
| 授权项 `PlanGrant` | `id`（整份计划里唯一）、`tool`（工具名，按工具注册表查得到）、`title`（给用户看的一句话）、`scope`（参数名 → 允许的值或值的数组，空对象是不限对象；参数名要是这个工具登记过的）、`maxUses?`（不写是不限次数）、`validDays?`（不写是 7 天） |
| 时序规则 | planguard 格式（`{ id, title?, trigger, require, … }`），存的时候按 `validateTemporalRules` 查（阶段、阶段组各查一遍，整份计划里 id 唯一）；12 号票只存和显示，执行中生效在 13 |
| `toolkit` | `{ skills[], mcp[], bash, network }`：执行时的工具包（13 号票按它装配） |
| `projects[]` | `{ project, changes[] }`：涉及的项目和改动（12 号票只存和显示；变成工单在 16、17） |
| `memoryScope?` | 记忆范围（占位，不生效） |
| `watchCategories[]` | 本任务要提醒的关注类别：`{ id, title?, disposition?, match? }`。**全局的一个都不能少**（任务书里列给维护者），处置只能比全局严；新加的必须写 `match`（确定的规则，和设置页同一种写法 `WatchCategoryMatch`，过 `normalizeCategoryMatch`）和 `disposition`。卡上显示的名字由运行时补上。用户确认时在卡上加的（26 号票）id 是 `<计划 id>-c<n>`，只存在这个计划里 |
| `userLimits[]?` | 用户说过的限制（26 号票）：`{ id, quote, temporalRules[], grantNarrowings[] }`。维护者把任务书的约束、用户说的"别……""只……"编译成时序规则（整个任务执行期间都检查）或授权收窄（`GrantNarrowing`，只能收窄），每条附上原话；至少编译出一样，编译不了的写进假设栏 |
| `scheduledJobs[]` | 定时作业定义：`{ title, schedule: ReminderSchedule, each, project? }`（确认后登记、进运营中在 19 号票；秘书没有建定时作业的工具）。时间表可以是"按我的工作日"（29 号票），计划卡的负载版本因此是 2（旧前端降级成纯文本）；卡上的写法用 Web 状态层的 `scheduledJobLines(plan)`（"按我的工作日 09:00"） |
| `assumptions[]` | 假设栏：维护者拿不准的地方，用户确认时可以逐条改（随计划一起保存） |
| `stops { count, where[] }` | 维护者的停点预告，**只作参考说明**：卡上的"授权后还会在 N 处停下来"由代码算（见下） |
| `tokenEstimate` | token 粗估 |

- `checkPlan(plan, { tools, settings })` 是 schema 之外的检查（阶段 id 重复、前置阶段不存在或成环、定步没有步骤、脚本验收没有命令、阶段组不存在、授权项 id 重复或工具 / 参数不存在、时序规则、关注类别、用户的限制），一次报出全部问题。用户的限制（26 号票）：规则过 `validateTemporalRules`（规则 id 和阶段、阶段组的在整份计划里唯一），收窄按 `narrowPlan` 的办法查只能收窄，**通过后收窄就落到授权项上**（存的计划里授权项是收窄过的，限制和原话留着给卡上显示）；本任务新加的类别的规则规范化（路径统一成反斜杠、去掉末尾分隔符）。
- `grantInfoOf(plan, { tools, settings })`：每项授权在守卫眼里的样子（`GrantInfo`：工具的中文名、落在哪些关注类别、任务里这些类别最严的处置），放进计划卡负载的 `grantInfo`。类别按工具在注册表里登记的类别标签，加上只按工具名匹配的自定义类别；处置按全局设置和本任务往严里调过的取最严，底线工具固定"交给我做"。按参数才落进去的类别（路径越出项目目录……）这里看不到，执行时守卫照样判。
- **卡上的文字由代码从结构化数据生成**（协议包 `plan.ts`，守护进程的素材和 Web 共用）：授权行 `grantText(grant, info)`（工具、类别、对象范围、次数、有效期；维护者写的 `title` 只作灰字备注），时序规则 `temporalRuleText(rule)`（按形态和 `on_violation` 说明）。**落在"先问我""交给我做""永不"类别里的授权不算授权**（`grantAuthorizes(info)`）：卡上标"执行时仍会问"（`grantNotAuthorizedLabel`），不能勾选。
- **停点由代码算**：`planStops(card, { removed, narrowed })` 给出授权后执行时还会停下的地方——由你验收的阶段、不算授权的授权项、被勾掉的、被收窄的；卡上随勾选实时更新（处理过的卡不给勾选，按记下的确认结果算）。
- `narrowPlan(plan, input, tools, { categoryIdPrefix })`：确认时的勾掉、收窄、改假设栏和加本任务的关注类别（26 号票：`PlanConfirmInput.addWatchCategories`，`{ title, match, disposition }`，规则过 `normalizeCategoryMatch`，结果里的 `added`；卡上没有删除，已有的删不掉）（`toGuardGrant` 换成守卫的形状比较放宽、收窄）。Web 那边把卡上的勾选变成确认输入的纯函数在 `state/plan-card.ts`（`planConfirmInput`、`narrowedGrantIds`）。
- **`toGuardPlan(plan, { confirmedAt, settings })`**：确认的计划变成守卫的 `GuardPlan`（13 号票执行时交给守卫）：授权项用同一个 `toGuardGrant` 变成 `Grant`（`stageId` 是它挂的阶段；阶段组的策略里的授权项展开到组里每个阶段，id 写成 `<授权项 id>@<阶段 id>`，次数按阶段各算；`expiresAt` 按 `validDays` 从确认时刻算），阶段和阶段组的时序规则、本任务的关注类别（换成守卫的处置词）一起带上。26 号票起：用户的限制编译出的规则加到**每个阶段**的 `temporalRules` 上；本任务的关注类别里，对全局类别的调严只记处置（内置的进 `builtin`，自定义的进 `customOverrides`），**规则和存废跟着全局设置走**（全局改了规则按新规则匹配、删了就不再命中），只有本任务新加的（带规则的）进 `custom`。所以 13 号票每次判定时现取全局设置（`daemon.watchCategories.current()`）交给守卫的 `settings`，`GuardPlan` 确认时算一次就行。
- 存储：派生视图 `tasks`（`tasks/views.ts`：`tasks`、`task_briefs`、`task_plans` 三张表），读用 `daemon.tasks.get / list / ofMaintainer / brief / plan / latestPlan`。存的计划是 `StoredPlan { planId, taskId, revision, cardId, maintainerId, status: pending \| confirmed \| rejected, plan }`，确认后 `plan` 是确认的那份。
- 计划卡（`plan`）的负载版本是 2（26 号票）：确认后的负载多了 `addedCategories`（卡上加的类别 id），授权行按确认的计划重算（加的类别可能让授权项落进"先问我"）；`plan_decided` 多了 `addedCategories`（规则和处置原样），素材里记成用户自己写的（`typed`，"给这个任务加了关注类别「……」：……"，`context` 加 `categories_added`）。
- 素材（`tasks/material-sources.ts`，在 `daemon.ts` 里 `materials.register`）：按钮建出的 `task` 事件 → "用户发言"（原话，本人、打的字；`context` 有 `start_task_button` 和选的 `project:<名字>`）；`questions_answered` → "澄清问题的回答"（选了推荐或卡上给的选项是 `choice`，自己写的是 `typed`；`context` 里有 `card:questions`，全按推荐的加 `all_recommended`）；`plan_decided` → "审批决定"（`context` 是 `decision:confirmed|rejected`、`card:plan`，勾掉、收窄、改了假设栏的加 `grants_removed`、`grants_narrowed`、`assumptions_edited`；授权项的说法和卡上一样由 `grantText` 生成；打回意见、改过的假设栏是 `typed`）。"建议发起任务"卡、提问卡被关掉是卡片模块通用的回避信号。

**秘书的四个任务工具**（`tasks/secretary-tools.ts` 的 `taskTools(tasks, cards)`，`TASK_TOOL` 是名字）：`create_task`（标题、一句话说明）、`suggest_task`（标题、为什么建议 → 卡）、`ask_questions`（可选的任务 id 和开场白，问题列表 → 卡；每道题是协议包的 `QuestionDraft`，就是提问卡 `Question` 去掉题号）、`write_task_brief`（任务 id 和协议包的 `TaskBrief`）。都只产生卡片或写任务模块，被拒时以出错的工具结果交回秘书。给模型看的文字里的工具名一律插值 `TASK_TOOL.*` / `SUBMIT_PLAN_TOOL`（和工具定义在同一个文件），不写字面量。

### 维护者的唤起（`maintainers/`）

**交给维护者一条输入 = 往它的会话频道追加一条带 `taskId` 的系统通知**：`conversation/messages.ts` 的 `buildAgentNotice(maintainerChannel(id), text, 幂等键, { taskId })`（第四个参数是 `MessageScope`：所属的任务、项目）拿到事件，放进 `appendBatch`（和引起它的事件同一事务，比如任务书、计划卡上的打回）。维护者模块（`maintainers/maintainers.ts` 的 `createMaintainers`，`daemon.ts` 在秘书之后 `start()`）订阅事件日志：维护者会话频道上第一次来了消息，就为这个维护者建一个 `AgentSession`（见下面"agent 会话"）并 `start()`，之后由它接着处理。

- 系统提示和任务书（26 号票）写明：本任务的关注类别怎么调严、怎么加；任务书的约束（用户说过的限制）编译成 `userLimits`（时序规则或授权收窄，附原话），编译不了的写进假设栏。编译的真实效果靠 DeepSeek 计划起草的手动冒烟。
- 起草计划时的装配：系统提示 `TASK_MAINTAINER_SYSTEM_PROMPT`；pi 工具 `PLANNING_PI_TOOLS` **只有 `read`、`ls`**（确认之前不动手不只靠提示词：白名单之外的工具 pi 根本不给，契约测试在 `pi-session.contract.test.ts`）；代为执行的工具只有 `submit_plan`（`maintainers/tools.ts`，`SUBMIT_PLAN_TOOL` 和定义在一起）；联网关着；`GuardAgent` 的 kind 是 `maintainer`，工作目录 `outputs/<任务 id>`，工具包里没有 bash；来源"任务「标题」"；会话段 `<维护者 id>:planning`；会话的消息范围 `{ taskId }`；`task()` 不给——计划确认之前的调用不属于任务，按对话里的处置判。
- **后面的票**：13 号票在计划确认、开始执行时按计划里的工具包重新装配（联网开关、bash、skill、MCP）、给 `task()` 和阶段，派工单（`work_order`）的宿主命令在 16 号票；项目维护者（15、16）照同样的方式接：各自的会话频道 `maintainer:<id>`、输入是系统通知、直接用 `AgentSession`，只配置差异。

### agent 会话（`conversation/agent-session.ts`）

`AgentSession` 是"一个 agent 处理一条会话的输入"，秘书和维护者共用，各自只配置差异：

```ts
const session = new AgentSession({
  agents, store, streams, guards, media, timeZone, log,
  agentId, conversation, label: "维护者",       // label 用在系统说明里："维护者这次没能回复：……"
  scope: { taskId },                             // 会话里的消息（回复、卡片引用、工具调用记录、系统说明）都带上
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
- **彻底删除**（21 号票）：会话里来了 `messages_purged`，闲着时（手头这一条处理完）停掉子进程、经 agent 管家的 `rewriteSessions` 改写会话文件、再按需拉起（常驻的马上拉起，按需的有输入才唤起）；`start()` 时把以前的先对一遍。维护者模块在维护者会话里来了 `messages_purged` 时也建好它的会话（`tasks.test.ts` 的"彻底删除"）。

## agent 管家的资源限制（`agent-manager/`，12 号票）

规格第 3、21 节。`createAgentManager({ layout, parentEnv, job, limits, onActivity, log })`，`limits` 来自配置的 `agents`（`AgentLimits`，默认 `DEFAULT_AGENT_LIMITS`）：

- **子进程上限**（`maxLive`，默认 8）：`spawn(request)` 返回 `ManagedAgent`，名额满了**不报错而是排队**（`state: "queued"`、没有 pid，可以先登记 `onReport`、等 `exited`，`send` 会抛错），名额空出时按先后拉起。**常驻的**（`resident: true`，只有秘书）占一个预留的名额、从不排队、不闲置退出。
- **闲置退出**（`idleMs`，默认 10 分钟）：非常驻的 agent 就绪后、或一轮结束后闲置这么久，管家送 `exit`，子进程退出（`exited` 的 `reason: "idle"`）；拉起它的模块看到 `idle` 就知道下次有输入再唤起。
- **单次模型调用超时**（`modelCallMs`，默认 5 分钟）和**单次工具调用超时**（`toolCallMs`，默认 10 分钟；代为执行的工具可以在 `defineHostTool({ timeoutMs })` 里声明更长——28 号票的跑测试、启动构建、装依赖声明配置里的 `shellTools.longCallMinutes`，默认 30 分钟：超时留在守护进程这一侧，拉起时经 `hostToolTimeouts(tools)` 放进 `SpawnAgentRequest.toolTimeouts` 交给管家，不进宿主协议）：到点送 `abort`，这一轮的 `turn_end` 改成出错（"模型调用超过 5 分钟没有结束，已中止" / "工具 X 的调用超过 10 分钟没有结束，已中止"）；15 秒还不结束就结束子进程（`reason: "unresponsive"`）。
- **孤儿进程回收**（`orphanSweepMs`，默认每分钟；只有 Windows 有 Job 对象）：Job 里的进程（`JobObject.processIds()`），从活着的 agent 子进程沿父进程链（`process/process-list.ts` 的 `parentProcessIds()`，Toolhelp 快照）够不着的就是孤儿（比如 bash 起的后台进程、父进程已经退了），结束前再确认一次它还在 Job 里（`agent-manager/orphans.ts`）。
- **活动状态**：`onActivity(agentId, state)` 报休眠 / 干活中 / 排队（同一状态不重复报）；`daemon.ts` 交给 `activity/activity.ts` 的 `createActivityLog`，在活动状态频道上记 `activity` 事件（派生视图 `agent_activity`；守护进程启动时 `settle()` 把上次没来得及记成休眠的改成休眠）。"等你"和界面上的小圆点在 25 号票。
- `live()` 是现在活着的子进程；`shutdown()` 结束全部（排队的取消）。守卫接入、宿主工具只要 `AgentLink`（收发消息、知道它什么时候退出）。
- 主切面在 `test/main/agent-limits.test.ts`（数值配小：上限 2、闲置 0.6 秒……）。

## 共享协议包（`packages/protocol/`）

- `constants.ts`：频道名（`CHANNELS`、`maintainerChannel`）、事件类型（`EVENT_TYPES`，临时事件 `isEphemeralEventType`）、请求方法（`METHODS`，必须带幂等键的 `METHODS_REQUIRING_IDEMPOTENCY_KEY`）、错误码、卡片类型和动作等。**不引用 TypeBox**。
- `schema.ts`：TypeBox 定义的三种帧（`RequestFrame`、`ResponseFrame`、`EventFrame`）、频道（`Channel`、会话 id `ConversationId`）、消息信封和全部 part（含工具调用 part 的关注类别、判定、授权内、通用 bash）、卡片、各方法的参数和结果、各事件的负载；类型用 `Static<>` 生成，和 schema 同名导出。
- `request.ts`：`parseRequest(raw)` 先校验帧、再按方法校验参数，给出类型确定的请求或错误（`bad_frame` / `unknown_method` / `bad_params` / `idempotency_key_required`）；有副作用的方法在类型上幂等键就是必填的。`isChannel(name)` 按 schema 里的 `Channel` 判断。
- `time.ts`：`nowIso()`，协议里的时间格式（带时区偏移的本地 ISO 时间，精确到毫秒）。守护进程和 Web 都用这一份。
- `validate.ts`：`schemaChecker(schema)`（按 schema 校验一个值，给出第一条错误），以及转出去的 `Type`、`Static`、`TSchema`。守护进程自己的 schema（卡片动作的输入、秘书工具的参数）也用这里的 `Type` 写，不另外引用 TypeBox，免得两个版本混用（根目录装的是 pi 的那份）。
- `reminder-schedule.ts`：简单提醒的时间规则，见上面"调度器和简单提醒"。
- `workday-calendar.ts`：个人工作日历（29 号票）：节假日数据 `HolidayYear`、额外上班规则 `ExtraWorkdayRule`、手动标记、个人设置 `WorkdaySettings`、改动 `WorkdayChange` 的 schema；纯函数 `workdayCalendar(节假日数据, 个人设置)`（`day(日期)` 给出 `DayVerdict`：上班或休息、原因、当天的节假日、缺哪边的数据；`month`、`missing`、给调度器的 `isWorkday`）、`applyWorkdayChange`、中文写法（`dayReasonLabel`、`describeExtraRule`、`describeWorkdayChange`、`missingHolidayDataText`、格子里的短词 `dayShortLabel`）；节假日数据的校验、合并、文件名；两种事件的负载和改动来源 `WorkdayChangeSource`。`local-date.ts`：本地日期和星期的小工具，时间规则和工作日历共用。守护进程和 Web 共用，见下面"个人工作日历"。
- `inbox.ts`：`isInboxItemProcessed`，待我处理事项算不算处理过的唯一一份判断。
- `tasks.ts`（12 号票）：任务状态 `TASK_STATES` 和中文名、未结束的 `UNFINISHED_TASK_STATES`（由 `TASK_STATES` 过滤出来）、怎么结束的 `TASK_END_KINDS`（转为项目）、发起方式、谁改的和中文名 `TASK_ACTOR_LABEL`、变化种类，看板的五组 `BOARD_GROUPS`（名字和包括哪些状态 `BOARD_GROUP_LABEL`）、任务状态到分组 `BOARD_GROUP_OF_TASK_STATE`、简单提醒到分组 `boardGroupOfReminder(status: ReminderStatus)`（**看板分组只有这一份**，守护进程和 Web 共用）、验收方式、阶段模式、计划里 id 的格式。**不引用 TypeBox**。
- `task-schema.ts`（12 号票）：`Task`、`task` 事件的负载、`start_task` 的参数和结果、任务书 `TaskBrief`、计划 `Plan` 及其各部分（策略 `PlanPolicy`）、`GrantInfo`、计划卡 / 提问卡（题目 `Question`、秘书写的 `QuestionDraft`）/ "建议发起任务"卡的负载和动作输入、`questions_answered` 事件的负载。守护进程的参数 schema 从这里推（`TaskBrief.properties`、`QuestionDraft`），不各写一遍。
- `plan.ts`（12 号票）：计划的纯函数（不引用 TypeBox）：`planPolicies`、`planGrants`、`policyOwnerLabel`，卡上生成的文字 `grantText`、`temporalRuleText`（`temporalRuleForm`、`ruleToolList` 认规则的形态和工具），`grantAuthorizes`，停点 `planStops`。守护进程（检查、素材）和 Web（计划卡）共用。
- `activity.ts`（12 号票）：活动状态 `ACTIVITY_STATES` 和中文名、`activity` 事件的负载。
- `watch-categories.ts`（26 号票，不引用 TypeBox）：场景 `WATCH_SCENES`、设置页的操作、修复的两种做法、`dispositionsNotLooserThan`（内置类别的下拉）、`isLooserDisposition`、`categoryMatchText`（确定规则写成一句话，设置页、计划卡、素材共用）。`watch-category-schema.ts`：确定规则 `WatchCategoryMatch`（计划里本任务的类别也用它）、设置的样子 `WatchCategoriesState`、`update_watch_categories` 的参数和结果、`watch_category_settings` 事件的负载。`plan.ts` 加了 `grantNarrowingText`（用户的限制里的授权收窄写成一句话），`temporalRuleText` 对带 `trigger.where` 的规则也写"只在满足条件时检查"。
- `constants.ts` 里另有处置的中文名 `DISPOSITION_LABEL`（守护进程的说明、Web 共用）。
- `deleted-event.ts`：`isDeletedEventPayload`，认彻底删除改写后的事件（负载是 `schema.ts` 的 `DeletedEventPayload`，见下面"素材"）。**不引用 TypeBox**。
- `http.ts`：走 HTTP 的那部分的路径（拼 `HTTP_PATHS`，含带偏移的写分片 `uploadChunk(id, offset)`，以及 10 号票的 `access`、`pairing`；拆 `parseHttpPath`；查询参数名 `HTTP_QUERY`）、单文件默认上限、分页大小、媒体 id 的格式、HTTP 错误码（10 号票加了 `unauthorized`、`forbidden`、`too_many_requests`）。**不引用 TypeBox**（也不用 `URLSearchParams`：前端状态层既没有 DOM 也没有 Node 的类型）。
- `parts.ts`：拼附件 part 的小工具：`imagePartFrom(...)`（宽高有就带上）、`attachmentPartFrom(入库后的媒体)`（图片发图片 part，其余发文件 part）、`partLabel(part)`（引用消息时给人看的说法）。
- `http-schema.ts`：HTTP 请求体和响应体（`CreateUploadBody`、`UploadStatus`、`CompleteUploadBody`、`UploadedMedia`、`HistoryPage`、`HttpErrorBody`；10 号票的 `AccessInfo`、`PairingRequestView`、`PairingCreateBody`、`PairingRenameBody`；21 号票的 `MaterialScopeBody`、`MaterialScopeSummary`、`DeleteMaterialsBody`、`DeleteMaterialsResult`），守护进程用 `checkHttpBody(schema, value)` 校验。
- `pairing.ts`：设备配对的常量（待批 5 分钟、限频 10 分钟 5 个、凭证 365 天、领取期限、首次使用期限 24 小时、短码和指纹的位数、设备名长度、`WS_CLOSE_UNPAIRED`）和 `defaultDeviceName(userAgent)`、`normalizeDeviceName`、`durationText(毫秒)`（"5 分钟""24 小时""365 天"）、`pairingRequestTitle(设备名)`。**不引用 TypeBox**。配对请求卡的负载 `PairingCardPayload`、已配对设备 `PairedDevice`、`device` 事件的负载、`revoke_device` 的参数和结果在 `schema.ts`。
- 包声明了 `sideEffects: false`：Web 只用到常量、类型和 `nowIso`，打包时 schema 和 TypeBox 被摇掉。
- **加一个请求方法**：`METHODS` 里加名字（有副作用就加进 `METHODS_REQUIRING_IDEMPOTENCY_KEY`）→ `schema.ts` 里定义参数和结果 → `request.ts` 的 `PARAM_SCHEMAS` 登记一项（参数类型 `MethodParams` 和校验器都由它推出）→ 网关 `FrontendConnection.dispatch` 里处理（`switch` 不全 `tsc` 会报）。**加一种频道**：`CHANNELS` 加名字、`schema.ts` 的 `Channel` 加一项（`isChannel` 跟着变）。**加一种事件**：`EVENT_TYPES` 加名字、`schema.ts` 定义负载；前端在状态层 `eventHandlers` 里加归并（临时事件还要加进 `EPHEMERAL_EVENT_TYPES`，前端在 `reduceEphemeral` 里处理）。**登记一种卡片**的协议部分：负载的 schema 写在 `schema.ts`（比如 `ReminderCardPayload`），负载形状改了就把 `CARD_TYPE_VERSIONS` 里它的版本加 1（守护进程登记时核对，前端靠它判断认不认识）。 **加一个 HTTP 接口**：`http.ts` 的 `HTTP_PATHS` 加路径 → `http-schema.ts` 定义请求体和响应体 → 网关 `http-api.ts` 的路由表加一项。

## Web 包（`packages/web/`）

### 页面从哪里来

- **由守护进程提供**（04 号票起的正式方式）：`npm run build:web` 之后，经 LSM 启动的 `ergou-daemon` 在 `http://127.0.0.1:8810/` 提供同一份构建产物。秘书页、卡片、待我处理、任务看板（任务、简单提醒、活动状态）和设置里的已配对设备接真数据（WebSocket），其他页面仍是原型的假数据，页面顶上的原型工具条会写明。外网（经 VPS 的 HTTPS 域名）来的是同一份页面：还没配对的设备只看到配对等待页（10 号票）。
- **直接打开构建产物**（`file://`，没有守护进程）：全部是假数据，用于评审原型。不起开发服务器、预览服务器或任何常驻进程：

1. `npm run build:web`。Vite 加 `vite-plugin-singlefile` 把 JS、CSS 全部内联，产物只有一个文件 `packages/web/dist/index.html`（`dist/` 不进仓库）。
2. 在 PC 浏览器里直接打开这个文件（双击，或者把 `file:///<仓库路径>/packages/web/dist/index.html` 贴进地址栏）。页面用 URL 的 `#` 部分做路由，从文件打开也能刷新、能前进后退。
3. 看手机竖屏：窗口宽于 760 时，页面顶上有一条原型工具条，点"手机竖屏 390"就把应用放进一个 390×844 的框里看；也可以用开发者工具的设备模式，或者直接把窗口拉窄。宽窄按内容区的实际宽度判断，600 以下是竖屏布局（底部 5 个 tab），以上是宽屏布局（左侧竖栏、内容区分栏）。
4. 原型里点按钮只改本地的假状态，刷新页面就回到初始的假数据。

演示一律走守护进程那条路（经 LSM 启动）。

### 目录

| 目录 | 是什么 |
|---|---|
| `src/state/` | **前端状态层**：把事件流归并成界面状态的纯函数，不依赖 React 和 DOM。见下文 |
| `src/app/` | 状态层接到 React（`store.tsx`）、前端连接接口（`connection.ts`）和它的 WebSocket 实现（`ws-connection.ts`）、HTTP 那一半（`daemon-http.ts`、分片续传上传 `uploader.ts`）、新设备的配对接口（`pairing-api.ts` 的 `PairingApi`）、浏览器里"本设备已被吊销"的记号（`revoked-mark.ts`）和"这个页面凭什么被信任"（`access.tsx`）、`#` 路由（`route.ts`） |
| `src/model/` | 页面用的领域形状（看板、项目、待我处理、设置）、14 种卡片的负载和动作结果文字、中文标签 |
| `src/util/` | 和界面无关的小工具（时间格式、`nowIso`、分段算的 `sha256.ts`） |
| `src/ui/` | 共用部件：会话组件（`conversation/`，秘书和维护者共用一个）、卡片（`cards/`，入口是 `CardPanel`，不认识的卡显示纯文本降级加"去 Web 处理"）、分栏和弹层（`common.tsx`）、页面底部的短提示（`toast.tsx`，`useToast()`）、到点的页面内提示和浏览器通知、被拒请求的提示（`alerts.tsx`） |
| `src/pages/` | 各页面：秘书、任务（看板 + 详情）、项目、待我处理、更多（消耗、设置各页）、配对等待页和批准页 |
| `src/prototype/` | **只属于原型**：假事件、假数据（名字和路径都是明显虚构的）、假连接（`fake-connection.ts`）、配对等待页预览用的假配对接口（`preview-pairing.ts`）、过渡期的分流连接（`split-connection.ts`：接了真数据的频道走 WebSocket，其余走假连接）、看板等假数据的本地状态（`proto-store.tsx`，跟着前端状态层里卡片的变化走，不认具体的连接）。接真数据的票逐步删掉这里的东西 |
| `src/styles/` | `base.css`（颜色 token、通用控件）、`layout.css`（tab、分栏、阶段抽屉）、`look.css`（视觉规矩）三份复制自 AgentSense 再裁剪；`pages.css` 是二狗自己的页面样式 |

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
- 29 号票起：`workday`（工作日历频道上节假日数据和个人设置的最新样子），`workdayCalendarOf(state)`（还没收到节假日数据是 `undefined`）、`workdaySettingsOf(state)`（`workday.ts`）：设置里的工作日历页用协议包的同一个纯函数算每天的结果；改个人设置经 `DaemonHttp.changeWorkday`（原型的 `FakeDaemonHttp` 交给假连接推事件）。
- 10 号票起：`devices`（已配对设备频道上的 `device` 事件，按设备 id 留最新的），`pairedDevices(state, now)`（`devices.ts`）分成有效的（按最近使用，新的在前；还没启用的界面标"等待首次使用"）和失效的（被吊销的、启用后凭证过期的、领到之后一直没用过就作废的，带原因 `InactiveReason`）。`pairingOpening(原因, 记号)`、`revokedMarkAfter(信任情况, 记号)`（`pairing-gate.ts`）：配对等待页怎么开场、浏览器里"本设备已被吊销"的记号怎么变（见下面 `App.tsx`）。
- 12 号票起：`tasks`（看板频道上的 `task` 事件，按任务 id 留最新的）、`activity`（活动状态频道，按 agent id 留最新的）；`boardGroups(state)`（`board.ts`）按协议包的分组表排出看板的五组（任务在前、新近有变化的在前；待触发的简单提醒在运营中，已触发的一次性提醒在最近结束，已取消的不上看板；任务带上它的维护者的活动状态），`selectTask`；计划卡上的勾选、收窄和改过的假设栏变成"确认"的输入 `planConfirmInput(plan, choice)`、实际收窄了的 `narrowedGrantIds`（`plan-card.ts`；授权项列表、生成的文字和停点用协议包的 `plan.ts`）。重新同步看板频道清掉任务和提醒。
- 21 号票起：会话视图里多了 `kind: "deleted"` 的条目（被彻底删除的消息，只有时间，界面显示"这条消息已彻底删除"）：事件本身是"已删除"标记（补发、历史分页里的 `{ seq, deleted }`），或者 `messages_purged` 点了名、没给 `replacement` 的（不刷新也换掉）；给了 `replacement` 的（工具调用记录）换成改写后的样子。卡片频道上改写成标记的旧版本卡片直接忽略。输入框里引用的卡片在 `UiState.quotes`（`quote_card` / `unquote_card`，`quotedCards(state, 会话)`；发消息时清掉）。快速动作卡、记忆删除卡的负载用协议包里的 `QuickActionCardPayload`、`MemoryDeleteCardPayload`；设置里的"删除素材"经 `DaemonHttp` 的 `materialScope` / `deleteMaterials`（原型是 `FakeDaemonHttp` 的假数）。
- 26 号票起：`watchCategories`（关注类别频道上最后一条 `watch_category_settings`，重新同步时清掉），`watchCategorySettings(state)`、`builtinChoices`（内置类别的下拉只给不比默认更松的档，"—"的场景没有）、自定义类别的编辑框 `CategoryForm` 和 `categoryDraftOf` / `categoryMatchOf` / `categoryFormOf`（文本框和请求互转，写得不对先在界面上说）、计划卡上的 `planCategoryRows`（每个类别标明来处：全局的、维护者调严的、维护者加的、你加的）和 `userLimitRows`（原话和编译出的规则、收窄）（`watch-categories.ts`）；计划卡的勾选多了 `added`（卡上加的类别，变成 `addWatchCategories`）。设置页（`pages/more/WatchCategoriesPage.tsx`）和计划卡上加类别共用 `ui/category-rule.tsx` 的规则编辑。回放用的录制是 `watch-categories`（`test/main/watch-categories.test.ts` 的"演示流程"）。
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

### 前端连接（`src/app/connection.ts`）

界面只通过 `Connection` 收发：`connect(cursors, deliver)` 连上后把事件帧、失败的请求和连接状态都变成 `UiInput` 交给状态层；`sendMessage`、`cardAction`、`inboxAction`、`revokeDevice`、`startTask`（12 号票："发起任务"按钮，带用户多选的涉及的项目：选项来自项目列表，15 号票之前由守护进程提供页面时列表为空、只有"不涉及项目"）发带幂等键的请求（卡片动作带期望版本和可选的结构化输入）；26 号票加了 `updateWatchCategories`（设置页改关注类别，被拒的原因进 `ui.failures`）。连接只在 `App.tsx` 里注入一次（`StoreProvider` 的 `connection`），别处（包括原型的假数据）都不认具体的连接：

- `WebSocketConnection`（`src/app/ws-connection.ts`）：连上就发 `subscribe`（协议版本 + 每个频道最后收到的序号），断线自动重连（间隔逐步拉长），没得到响应的请求重新订阅之后带同一个幂等键重发；协议版本对不上报"页面过旧"、不再重连；订阅响应里点名重新同步的频道，交给状态层清掉、游标归零。给了 `checkAccess`（`App.tsx` 给的是问 `/api/access`）时，断线后先问一下这台设备还被信任吗：凭证失效就报 `unpaired`、不再重连；问不到照常重连。`test/app/ws-connection.test.ts` 用假 socket 测它。
- `App.tsx`：页面由守护进程提供时先问 `/api/access`：`none`（外网端口上还没配对）只显示配对等待页（`PairingWait` + `httpPairingApi`，不连 WebSocket），配对成功后重新加载页面。每次问到结果都按 `revokedMarkAfter` 更新浏览器里"本设备已被吊销"的记号（localStorage，只是一个固定的值）；配对等待页怎么开场由 `pairingOpening(原因, 记号)` 定（`state/pairing-gate.ts`）：新设备自动发起配对请求，被吊销的（这一次知道原因，或者浏览器里有记号——刷新之后服务端已经分不出来了）只显示"此设备已被吊销"和"重新申请"，凭证过期的也等用户点"重新申请"；点了才擦掉记号；问到的结果经 `AccessProvider` 给页面（设置里标出"就是这台"）；用着用着连接报 `unpaired` 也回到配对等待页。设置里"预览配对等待页"（`#/pair/wait`）用原型的假配对接口。然后用 `SplitConnection`，`REAL_CHANNELS`（06 号票起是秘书会话、卡片、待我处理、看板；10 号票起加上已配对设备；12 号票起加上活动状态；29 号票起工作日历；26 号票起加上关注类别）走 WebSocket，其余频道走原型的假连接；`file://` 打开时全用假连接。**接真数据的票往 `REAL_CHANNELS` 里加频道**，全部接完后去掉 `SplitConnection` 和假连接。卡片频道接了真数据之后，原型的假卡片（任务详情里的计划卡、配对批准页……）换到频道名 `proto:cards` 上推给状态层，点它们的按钮仍交给假连接。看板（12 号票起）：任务和简单提醒来自状态层的 `boardGroups`，原型的假看板只补上还没接真数据的定时作业（`ProtoProvider realBoard`，19 号票接）；`file://` 打开时假看板的任务、提醒、定时作业都在，"发起任务"和"建议发起任务"卡上的"发起任务"由假连接推一条 `task` 事件。真任务的详情页目前只有状态和计划卡（13 号票做任务详情页）。

HTTP 那一半（`src/app/daemon-http.ts` 的 `DaemonHttp`：上传附件、往上翻历史、媒体地址）同样只在 `App.tsx` 注入一次（`StoreProvider` 的 `http`）：页面由守护进程提供时是 `HttpDaemonClient`（同源），`file://` 打开时是原型的 `FakeDaemonHttp`（假进度、本地预览、没有更早的历史）。界面从 `useStore()` 取 `http`、`loadOlder(conversation)`：

- `uploader.ts` 的 `uploadFile(file, options)`：建上传 → 一片 1 MB 地写 → 分段算 sha256 收尾。网断了（请求抛错或 5xx）报"等待网络"，隔一会儿查服务端已收到的偏移接着传；409 按服务端的偏移来；413、422 这类明确拒绝的不重试。`test/app/uploader.test.ts` 用内存里的假服务端测（含传到一半断网）。
- 会话组件：输入框（`ui/conversation/Composer.tsx`）的附件菜单有图片、文件、作为材料投喂（21 号票：选的附件带 `asMaterial`，聊天里标"作为材料投喂"），选了文件就开始上传，每个附件显示进度、"等待网络"、失败可重试，都传完了才能发送；聊天里图片直接显示（点开看原图），文件点了下载；往上滚到顶（或点"加载更早的消息"）时加载更早的一页，视口停在原来看的那条上。

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
  - `places`：数据目录各区（受保护区域从这里取）、二狗程序目录、用户主目录；
  - `task`：对话里是 `null`；任务里带计划（授权项、本任务的关注类别、各阶段和阶段组的时序规则 `stages` / `stageGroups`）和当前阶段；
  - `effectLog`：效果日志，只有执行成功的调用（授权项按它计次，时序规则只看它）。记录用 `effectRecordsFor` 生成，见下面"时序规则"。时序规则按范围过滤：任务里只看同一个任务的，不属于任务的只看同一个 agent、同一段会话（`segmentId`）的，调用方传全量或先筛过都行；
  - `segmentId`：不属于任务的调用所在的会话段（秘书会话、维护者的对话段），时序规则和效果日志的记录用它；
  - `settings`：全局的关注类别设置，用 `loadWatchCategorySettings(layout)` 从数据目录的 `config/watch-categories.json` 读（示例见仓库的 `config/watch-categories.example.json`；守护进程里经 `daemon.watchCategories.current()` 现取，见上面"关注类别设置"）。本任务的设置（`task.plan.watchCategories`）只在全局之上增加：内置类别的调严（`builtin`）、对全局自定义类别的调严（`customOverrides`：只有处置，规则跟着全局，26 号票）、本任务新加的类别（`custom`）。同一个自定义类别 id 的几份和调严取最严（`customDisposition`）；
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
  - `watch-categories.ts` 内置九类、默认处置、两条底线、设置的校验、对全局设置的一次修改 `editWatchCategorySettings`（26 号票：内置类别只能不比默认松、底线改不动）；`watch-category-store.ts` 从数据目录读设置（唯一读文件的地方；`readWatchCategoryFile`、`parseWatchCategorySettings` 给 26 号票的设置服务用）；
  - `tool-registry.ts` 工具注册表（还有大家共用的 `sendsOut`、`argEntriesOf`、`describeCall`、只读 HTTP 方法表）；`grants.ts` 授权项和 `validateGrantChange`；`paths.ts` 路径解析和比较、`agentScope`（agent 的项目范围）、`isGitControlPath`（git 的配置和钩子：写入按越出项目目录判，28 号票）；`secrets.ts` 密钥形态和对外内容；`secret-files.ts` 认 `.env` 和密钥文件；
  - `shell/split.ts` 用 unbash 拆 bash（每条调用带上它在命令结构里的位置 `order`，`mayRunBefore` 判先后），`shell/programs.ts` 是"命令 → 伪工具调用"的程序表；
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
  - `block`：**永不**——一律禁止的（force push、项目外 `rm -rf`）和对外内容含密钥、读过密钥文件之后对外发送；
  - `confirm` 或不写：**先问我**（和 planguard 一致）——不重复发，以及用户的规则、26 号票编译出的规则没写的；
  - 判断不了的（缺环境事实、参数没法规范化、规则要的值取不到、规则求值出错、规则校验不通过，包括 `trigger.where` 判断不了）一律先问我。
  
  命中列在输出的 `temporalRules`（`ruleId`、`title`、`status`、`outcome`、`message`、`call`），说明写明违反了哪条、怎样才能满足。永不和先问的命中和关注类别的处置一起取最严；退回见上面输出的 `pullBack`。
- **13 号票控制器的硬检查"某个对象被判过永不之后，再对它做对外动作要先问"**：只算关注类别、底线、受保护区域的永不，以及时序规则里 `outcome` 为 `never` 的（一律禁止类规则），也就是 `findings` 里处置为 `never` 的依据；按规则退回（`kind: "pull_back"`）不算，判断不了的也不算。
- **规则能用的东西**（详见 `rule-validation.ts` 开头）：`$current` / `$prior`（工具名、规范化参数 `args`，以及推出来的 `paths`、`recipients`、`content`、`secrets`、`sends`）、`$facts`（`files`、`git`、`scripts` 三个列表和声明过的 `extra`）、`$agent`、`$task`、`$now`。字段表和构造它们的代码放在一起：`rule-steps.ts` 的 `STEP_FIELDS`，`rule-env.ts` 的 `AGENT_FIELDS`、`TASK_FIELDS`、`FACT_KINDS`。扩展的运算 `path_within: [路径, 目录或一组目录]` 按 Windows 语义判断"在目录里"。和 planguard 不同，`trigger.where` 判断不了时算判断不了（先问），不当成不触发。
  - `recipients`：显式的收件人、网址（去空白、小写）；没有收件人参数的发送（`git push`、`gh` 评论……）用目标对象当收件人——推送是仓库、远端、分支，别的工具是工作目录加上非内容参数（比如 issue 号）。`content`：对外内容类参数拼在一起；推送的"内容"是推送时 HEAD 的提交号（`headCommit`，由 `facts.git[仓库].head` 补上，没给时是"未知"，不重复发因此判断不了、先问）。
  - `sends`：会不会联网发东西；跑脚本看 `facts.scripts` 的扫描结果，没扫过的是"未知"（读过密钥文件之后跑它就先问）。
- **参数名统一**：`normalizeArgs(tool, args, tools, env, facts?)` 把带类型的工具和 bash 拆出的伪工具调用规范化成同一种形式（参数名照注册表，路径绝对化，不填且默认取工作目录的补上，推送补上 `headCommit`，不符合 pattern / type 的换成"未知"，空值去掉）。
- **效果日志**：守卫接入在工具执行成功后用 `effectRecordsFor(input, judgement, { firstSeq, at, summary? })` 生成记录追加（效果摘要写执行后的效果，见下面"守卫接入运行时"）（规格第 9 节的字段，加上会话段 `segmentId`；参数是规范化、能存成 JSON 的形式，"未知"存成 `{"$unknown": 说明}`），存在派生视图 `effect_log` 里，见下面"守卫接入运行时"。
- **规则校验**：`validateTemporalRules(rules, { tools, facts? })` 返回 `{ ok, problems }`，每个问题以"规则 <id>"开头。查：键、`trigger` 和 `require` 的形态、工具是否登记、`trigger.where` / `when` / `unless` / `require` / `message` 里 `$current.args.X` / `$prior.args.X` 的参数是否登记、运算和操作数个数、正则、引用的东西是否存在、`modes` 里有没有 runtime、`on_violation`（`block`、`confirm`、`pull_back`）、id 重复或用了 v1 模板保留的 id。13 号票存计划时直接调用；判定时校验不通过的规则一律判断不了。
- **v1 模板**（`rule-templates.ts`，id 以 `v1.` 开头）要的环境事实：
  - 删除或覆盖前要 `facts.git`（包含这个路径的仓库的 `uncommittedPaths`；不在仓库里的目录写 `repository: false`）和 `facts.files[路径].exists`（整体重写时），可选 `backedUp`；缺了就判断不了、先问；
  - **项目档案不在 git 里**，覆盖或删除前由运行时自动留一份旧版本（15 号票），所以 07、15 号票对项目档案里的路径传 `facts.files[路径].backedUp: true`，模板就总是满足；
  - 推送要 `facts.git[仓库].head`（不重复发靠它区分新旧提交）；跑脚本要 `facts.scripts[脚本]`（读过密钥文件之后）。

## 守卫接入运行时（`guard-runtime/`、`approvals/`，07 号票）

规格第 3、9 节。子进程里的二狗扩展在 pi 的 `tool_call` 钩子里把每次工具调用（pi 的内置工具、守护进程代为执行的工具都算）发成 `guard_request`，守护进程判定后回 `guard_reply`；放行才执行，拦下的调用不执行，模型收到判定里的说明。守卫从不原地改参数。

- **模块的分工**：`guard-runtime.ts` 的 `attach` 只做编排（判定、按判定分派、在 `tool_call_end` 时记录）；先问我的一次性授权、等审批、超时挂起、事后决定的通知在 `approval-waits.ts`；交给我做在 `hand-over/`（和 `approvals/` 并列）；聊天里的工具调用记录在 `tool-call-record.ts`；效果日志的写入和效果摘要在 `effect-log.ts`。审批记录、交给我做的事项、两个审批事件都带同一个 `CallOrigin`（`events.ts`：agent、会话、任务和阶段、会话段、来源），13 号票往里加字段。
- **接上一个会话**：拉起时 `forwardToolCalls: true`，拉起后 `guards.attach(proc, { agent, tools, conversation, source, segmentId?, task? })`（`GuardedSession`）。`agent` 是守卫看到的 agent（`GuardAgent`：工作目录、工具包、围栏），`tools` 是这个会话的工具注册表（内置的加上它代为执行的工具的 `descriptor`），`conversation` 是工具调用记录、审批卡引用、给 agent 的通知追加到的会话，`source` 是审批卡上的来源（秘书是"秘书对话"），`task()` 给出调用所属的任务（13 号票接，对话里不给）。秘书在 `startSecretary` 里接；维护者、子 agent 随 12、13、16 的会话装配照这个接。**正式的会话都要接**；只有测试里直接拉起、自己回判定的 agent 不接。
- **判定**：先判一次看要哪些路径和脚本，现取环境事实（`facts.ts` 的 `gatherFacts`：路径参数在不在、真实路径——`fs.realpathSync.native`，还不存在的按最近的已有上级目录展开；维护者和子 agent 项目里的 git 状态（未提交改动和 HEAD，只在项目范围之内往上找仓库）；项目区里的文件算已备份；要跑的脚本的扫描结果），再判一次。关注类别设置每次现读（`config/watch-categories.json`，读不了就拒绝这次调用）。效果日志按范围取：任务里只看同一个任务的，不属于任务的只看同一个 agent、同一段会话的。**守卫看到的各区、程序目录、用户主目录、agent 的工作目录都是真实路径**（`daemon.ts` 里展开一次）：测试的临时目录常带 8.3 短名，不展开的话路径比较对不上。
- **按判定**：会执行（直接做只记录、做完告诉我）→ 放行；硬拒绝、按规则退回、永不 → 拦下，模型收到 `explanation`；交给我做 → 拦下，往待我处理里放一个"交给我做"事项（`hand-over/hand-over.ts`；`notice: "hand_over"`，动作 `HAND_OVER_DONE`"已完成"，`body` 和 `data.calls` 里是这次调用的规范化摘要，`data` 的形状是 `HandOverData`），用户点"已完成"后往会话里追加一条交给 agent 的通知；先问我 → 见下。**判定抛错**是单独的结果：拦下、不执行，工具调用记录上 `blockedBy: "judge_error"`、没有处置（不当成"永不"），界面显示"判定出错"。
- **先问我**：先看审批表里有没有同一个 agent、同样调用指纹、事后批准过、还没用掉的一次性授权，并且这次判定命中的关注类别都在当初批准过的类别里（`findOneTimeGrant`），有就放行一次（`approval_consumed`）；多命中了别的类别（比如用户刚加了自定义类别）就重新走审批，授权不用掉。没有就 `approvals.request(...)`：同一事务追加 `approval_requested`（审批表）、审批卡（`approval`，负载 `ApprovalCardPayload`：来源、工具和中文名、参数摘要、命中的类别显示用的名字 `categoryTitles`、守卫的说明；对话里紧急度"不卡任务"，任务里先按"卡着任务"）、待我处理的卡片事项、（对话里）聊天里的卡片引用，审批表在最前；再 `inbox.alert` 提示用户。子进程里这次调用最多等 `approvalWaitMs`（配置 `approvals.waitMinutes`，默认 5 分钟；跟着可注入的时钟）：
  - 期间用户在卡上批准（`approve`）→ 接着执行；拒绝（`deny`，可附说明）→ 拦下，模型收到"用户拒绝了这次调用：……"。卡片动作和 `approval_decided` 同一事务（`resumed: true`）；
  - 超时 → 以"已提交审批，等待用户"拦下，追加 `approval_suspended`（带 `CallOrigin`，对话里任务和阶段为 null）；审批卡仍待处理。回合被中止、子进程退出时同样不再等，审批照旧；
  - 之后用户批准（`resumed: false`）→ 这条审批就是一条一次性授权，往会话里追加一条交给 agent 的通知"……已获用户批准，可以重试"；agent 原样重试时放行一次，再来一次同样的调用重新走审批。之后用户拒绝 → 同样追加一条"……已被用户拒绝"，免得 agent 以为还在等。
  - **调用指纹**（`describe.ts` 的 `callFingerprint`）：agent、任务、阶段（没有阶段时为空）、工作目录、工具名和模型给的原样参数（键排好序）的 sha256，所以一次性授权只在所属阶段有效。不用规范化之后的参数：bash 拆出的伪工具会丢掉命令里的选项，按它匹配就宽了。
- **聊天里的工具调用记录**（`tool-call-record.ts`）：每次调用在 `tool_call_end` 时往会话里追加一条只有一个工具调用 part 的消息（工具名、参数摘要、命中的关注类别显示用的名字 `categoryTitles`、处置（判定出错时没有）、`blockedBy`（硬拒绝 / 按规则退回 / 判定出错，`TOOL_CALL_BLOCKS`）、是否授权内、是否通用 bash、结果 `done` / `error` / `blocked` / `denied` 和结果摘要）。助手的正文在定稿时就落了，工具调用记录排在它后面。
- **效果日志**（`effect-log.ts`）：放行、执行成功（`tool_call_end` 不是出错）的调用用 `recordEffects` 追加 `effect_recorded`（`effectRecordsFor`，序号全局连续），派生视图 `effect_log`；读取用 `listEffects(reader, scope)`。被拦下、执行失败的不追加。**效果摘要写执行后的效果**（`effectSummary`）：做了什么（bash 拆出来的带上那段命令）、改动（写、删）和涉及的文件、成功（bash 带退出码，记下来的总是 0）、结果的开头一小段，比如"跑脚本（bash「node calc.js」）；成功，退出码 0；结果：6"。
- **审批表**（`approvals/views.ts`）：每条审批的请求记录加上状态（待处理 / 批准 / 拒绝）、是否挂起过、决定时有没有调用在等（`resumed`）、一次性授权用掉没有。`daemon.approvals.get / list / oneTimeGrant`。被杀重启后从审批表恢复、不重复通知在 23 号票。
- **秘书的草稿区**：数据目录临时区里的 `tmp/scratch`（`DataDirLayout.scratch`），是秘书的工作目录。秘书的 pi 工具列的是 `read`、`write`、`edit`、`ls`、`grep`、`find`、`bash`（`SECRETARY_PI_TOOLS`），秘书不能联网，按下面的装配规则实际拿到的没有 `grep`、`find`。秘书只有一条长期主线会话，整条是一段（`SECRETARY_SEGMENT_ID`，效果日志和时序规则按它划范围，不借用 agent id）。草稿区里的写、改、删不落入任何类别；项目档案只读；别处读、bash 碰到别处的路径是"越出项目目录"（对话里先问）；别处写直接拒绝；受保护区域写入永不、密钥区连读都拒绝（都在守卫里判）。
- **不能联网**（尽力而为）：联网的工具和命令由守卫拒绝；要跑的脚本执行前扫一遍（`script-scan.ts`：Python 的 `import requests` / `urllib.request` / `socket`……、Node 的 `fetch(`、`require('https')`、`axios`……、字符串里调 `curl` / `wget`、shell 脚本里的联网命令），用到的作为 `facts.scripts` 交给守卫，联网开关关着时拒绝并提示"联网请发起任务"。**没扫到不等于没联网**：联网开关关着时，要跑的脚本判定时还不存在（同一条命令里先写再跑，比如 `echo … > x.py && python x.py`）、读不了或看不出是哪个，守卫按规则退回（`pullBack: ["script_not_checked"]`，`SCRIPT_NOT_CHECKED`），说明"先用 write 写好脚本再运行，以便执行前检查"——和时序规则里"判断不了"的算法一致。联网程序的名单（`curl`、`wget`、`ssh`……）只有守卫 `guard/shell/programs.ts` 的 `NETWORK_PROGRAMS` 一份，脚本扫描也用它。agent 管家对联网开关关着（`SpawnAgentRequest.network` 默认 false）的 agent，把 pi 的 bash 换成同名的一份（`runtime/agent-child/session.ts` 的 `shellOverrides`），起进程前往环境里加 `OFFLINE_SHELL_ENV`（`process/child-env.ts`：`HTTP(S)_PROXY`、`ALL_PROXY` 等设成 `http://127.0.0.1:9`，`NODE_USE_ENV_PROXY=1` 让 Node 的 fetch 也走代理）。子进程自己的环境不受影响（它要连模型）。宿主协议的装配参数因此多了 `shellEnv`（协议版本 3）。
- **联网开关关着时的装配规则**（`agent-manager.ts` 的 `assembledPiTools`，所有会话通用，不写在谁的工具列表里）：联网开关关着的会话（秘书、联网关着的维护者）装配时不给 pi 的 `grep`、`find`（`DOWNLOADS_ON_FIRST_USE`：它们第一次用时会去网上下载 rg、fd），要搜索就在 bash 里用 Git Bash 自带的 grep、find。守卫眼里的工具包也照这个算。契约测试在 `test/contract/shell-env.contract.test.ts`。

## 带类型的 bash 工具（`typed-shell/`，28 号票）

规格第 9、21 节。维护者干开发类的活时常用的 bash 操作，参数是结构化的，守卫不用拆命令就知道它落在哪些类别里。

- **登记**：在守卫的工具注册表里（`guard/tool-registry.ts` 的 `TYPED_SHELL_TOOLS`，来源 `typed_shell`）：类别标签、"做完告诉我"、"只读或幂等"（只有状态和差异）、要联网。和通用 bash 里的同一操作同名、参数名相同（`git push` 拆出来就是 `git_push`），时序规则、授权项、v1 模板对两者一视同仁。工具参数 schema 里的参数名都要在登记里（`test/typed-shell/tools.test.ts` 查）。仓库路径除了状态和差异都按"写"登记（推送会更新远端跟踪分支、建远端仓库会加远端），所以写入受保护区域一律永不；状态和差异是读，按规格第 9 节读的规则（密钥区连读都拒绝，读配置区、数据库区、程序目录是越出项目目录）。
- **执行**：它们是守护进程代为执行的工具（`HostTool`，但 `descriptor` 就是注册表里那一份，`AgentSession` 不再加一遍）。`createTypedShell({ parentEnv, homeDir, timeouts, ghCommand?, log })` 在 `daemon.ts` 里建一份；`toolsFor({ cwd, toolkit })` 给一个会话的八个工具，**bash 关着时一个都没有**。拉起会话的模块把它们放进 `hostTools`，pi 的工具里同时给 `bash`（维护者在 `maintainers.ts` 按工具包装配，13 号票按确认的计划装配时照这个接；秘书的固定工具里没有它们）。
- **怎么跑**：仓库路径和守卫一样解析（`normalizeArgs`：不填是工作目录，相对路径相对工作目录，`/d/x` 也认），在 Git Bash 里以它为当前目录执行。**模型给的值一律不上命令行**：Git Bash 是 MSYS 程序，它的运行时会把命令行上的参数当通配符展开（`*.ts` 变成文件名）、当响应文件读进来（`@secret.txt` 变成文件内容）；命令行上只有固定的脚本，值经 stdin 按 NUL 分隔送进去，脚本开头 `mapfile -d ''` 读进 `"$@"`，不拼进脚本、不被 shell 再解释。Git Bash 起 Windows 程序时也不改写参数（`MSYS_NO_PATHCONV=1`，不然 `/x/y` 会变成 `X:/y`）。所有 git 调用固定加 `-c core.fsmonitor=`（`core.fsmonitor` 可以是一条命令，状态和差异是"只读或幂等"，不能被仓库配置变成执行命令）。推送只收已配置的远端名（先 `git remote` 核对，不收网址和本机路径）。环境是 `buildChildEnv` 的系统变量白名单（没有守护进程的密钥；推送、建远端仓库靠本机已登录的 git 和 GitHub 命令行，二狗不注入凭据），联网开关关着时另加 `OFFLINE_SHELL_ENV`。**每次调用一个 Job 对象**（`runner.ts`）：先起闸门进程（`runner-main.ts`），放进 Job 之后才告诉它要跑什么，Git Bash 和它起的一切都在里面；跑完、超时、被中止时关掉 Job，整棵进程树（含孙进程、孤儿）一起结束。不放进 agent 管家的 Job：那里按"从活着的 agent 子进程走不到"回收孤儿，守护进程直接起的进程会被当成孤儿。
- **结果**：第一行一句话（聊天里的结果摘要、效果摘要都取开头：提交号和文件、"测试通过"……），第二行一个 JSON（结构化字段），后面可能跟着差异或输出的结尾。执行失败（git 出错、退出码非零、合并有冲突、超时、被中止）一律按出错交回，不进效果日志。合并有冲突时中止合并，工作目录回到合并前，冲突文件列在结果里。
- **项目约定**（`conventions.ts`，跑测试、构建两个工具的说法在它的 `PROJECT_TASKS` 一张表里）：跑测试、构建只跑工作目录里已有的约定——package.json 的脚本（`npm run <脚本> -- <附加参数>`，附加参数交给项目自己的测试、构建工具）、Makefile 的目标、`cargo test` / `cargo build`、`go test ./...` / `go build ./...`。**make、cargo、go 一律不收附加参数**：make 的"变量=值"会展开进配方，cargo 的 `--config` 能设 runner，go test 的 `-exec` 能跑任意程序。装依赖按锁文件认包管理器，**只收注册表里的包名**（可以带版本号或版本范围；npm 的包名、crates.io 的包名、Go 的模块路径各一个正则）：选项、本机路径、`file:`、`link:`、git 网址、绝对路径、`..` 一律不收。
- **固有缺口：项目代码本身能执行**。提交会跑仓库的 git 钩子，跑测试、构建会跑项目里的脚本和 Makefile，agent 能用文件工具或 bash 改它们。带类型的工具只负责分类（守卫按类别判），不额外提供隔离。收紧的一处在守卫里：写工作目录（或秘书草稿区）里的 `.git/config`、`config.worktree`、`.git/hooks/` 下的文件（worktree、子模块的同样算；`guard/paths.ts` 的 `isGitControlPath`），文件工具和 bash 都按"越出项目目录"判——写它们等于让之后的 git 调用执行任意命令。
- **超时**：跑测试、构建、装依赖声明 `shellTools.longCallMinutes`（默认 30 分钟），别的按 `agents.toolCallMinutes`。到点管家中止这一轮，`HostToolCall.signal` 随之中止，关掉 Job；工具自己另有一个多 5 秒的兜底计时。
- **测试**：工具本身（`test/typed-shell/tools.test.ts`）按 `HostTool` 接口直接调用、在临时目录的真实 git 仓库上跑；主切面 `test/main/typed-shell.test.ts`；守卫切面 `test/guard/typed-shell.test.ts` 和场景文件 `typed-shell-tools.guard.json`。值原样到达（`*`、`?`、`@文件`、`$(…)`、`%PATH%`、反引号）的用例在 `tools.test.ts` 的"值原样到达"，装依赖用 PATH 上一个假的包管理器（bash 脚本，打出收到的参数）。测试底座：`test/helpers/git-repo.ts`（`initRepo`、`bareRemote`、`git`……：测试进程自己跑 git 时不读用户的 git 配置和凭据，远端是临时目录里的本地裸仓库）、`test/fixtures/fake-gh.mjs`（假的 GitHub 命令行：`startTestDaemon({ ghCommand: [process.execPath, 它, 记录文件, 放裸仓库的目录] })`）、`startTestDaemon({ maintainerToolkit })`（13 号票按计划装配之前，给维护者一个开了 bash 的工具包）。**测试里不要让真的 `gh` 跑**。

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
- **个人工作日历**（29 号票）：用户的额外上班规则和手动标记在数据目录的 `config/workday-calendar.json`（个人数据，只由运行时写，随数据目录备份；仓库里没有）；导入的节假日数据在 `config/holidays/<地区>-<年>.json`。`holidayCheck`：节假日数据的检查，`{ fromMonth, dayOfMonth, time }`（从几月起查下一年、每月几号查（1–28）、几点），默认 `{ fromMonth: 12, dayOfMonth: 1, time: "09:00" }`（也就是每年 12 月 1 日 09:00 开始查下一年），默认值只在 `config.ts` 的 `DEFAULT_HOLIDAY_CHECK`。
- **agent 子进程的资源限制**（12 号票）：`agents.maxLive`（同时存活的子进程上限，至少 2，默认 8）、`agents.idleMinutes`（维护者闲置多久退出，默认 10）、`agents.modelCallMinutes`（单次模型调用超时，默认 5）、`agents.toolCallMinutes`（单次工具调用超时，默认 10）、`agents.orphanSweepSeconds`（多久回收一次孤儿进程，默认 60）。见上面"agent 管家的资源限制"。
- **带类型的 bash 工具**（28 号票）：`shellTools.longCallMinutes`，跑测试、启动构建、装依赖的单次调用超时，默认 30（别的带类型的工具按 `agents.toolCallMinutes`）。
- **维护者的模型**：和秘书一样是 `deepseek/deepseek-flash`、思考档位 `high`（`daemon.ts` 的 `MAINTAINER_MODEL`）。
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

- `startTestDaemon(options)`：`secretary`（faux 剧本）、`secretaryTokensPerSecond`（调慢流式，测节流、测"秘书正忙"）、`secretaryModel`（直接给模型，比如一个装配不起来的，测秘书起不来）、`secretaryDownThresholdMs`、`env`、`reuse: { dataDir, homeDir }`（停掉再起同一个数据目录）、`webRoot`（默认是放了测试页 `TEST_PAGE` 的临时目录）、`programDir`（守卫眼里的二狗程序目录，默认是一个空的临时目录：测试不碰真实仓库）、`portFromConfig`（测"端口从配置读"，两个端口都照配置）、`clock`（`ManualClock`，到点不靠真等）、`cardTypes`（额外登记或替换的卡片类型，比如 `card-fixtures.ts` 里的替身"建议发起任务"卡）、`heartbeatIntervalMs`（测半开连接）、`embedder`（素材的向量函数：默认是 `embedder.ts` 的 `FakeEmbedder`，不下载、不跑真模型；写 `"bge-m3"` 用正式的，临时数据目录的模型区是空的，测"模型不在"）、`secretaryTools`（秘书额外的代为执行的工具，比如带"花钱"类别的，测"交给我做"）、`quickActions`（额外登记或替换的快速动作，`quick-action-fixtures.ts` 里有落入"以我的名义对外发送"的 `send_note` 和不落入类别的 `tidy_note`）、`config`（起来之前写进数据目录 `config/ergou.json` 的配置，比如 `{ approvals: { waitMinutes: 1 } }`、`{ agents: { maxLive: 2, idleMinutes: 0.01 } }`）、`maintainer`（12 号票：维护者的 faux 剧本；给函数 `(维护者 id, 第几次唤起) => 剧本` 时，闲置退出后再唤起是新的子进程、剧本从头开始，会话接着原来的；不给则维护者一被调用就以出错结束）、`maintainerToolkit`（28 号票：`(维护者 id) => { bash, network }`，不给是起草计划时的、都关着）、`ghCommand`（28 号票：假的 GitHub 命令行）。剧本里要写数据目录各区的路径时，先自己建好数据目录和主目录，经 `reuse` 交进来（`secretary-scratch.test.ts` 的 `dirs()`）。两个端口默认都由系统挑，**从不占用 8810、8811**。返回 `{ daemon, url, externalUrl, dataDir, homeDir, webRoot, programDir }`（`externalUrl` 是外网端口）；配对模块是 `daemon.pairing`；读派生视图用 `daemon.store.reader`，秘书子进程的 pid 是 `daemon.secretary.pid`（测崩溃），测试里直接建卡、放待我处理事项用 `daemon.cards`、`daemon.inbox`，提醒用 `daemon.reminders`，工作日历用 `daemon.workdayCalendar`（导入节假日数据 `importHolidayFile`），节假日数据的续期用 `daemon.holidayUpdates`（`importForTask`），素材用 `daemon.materials`，审批表用 `daemon.approvals`，效果日志用 `listEffects(daemon.store.reader, scope)`，`guard` 频道上的事件用 `daemon.store.read(GUARD_CHANNEL)`；从某个时刻起拉起了几个子进程用 `countAgentSpawns(daemon)`（测试接缝：包一层管家的 `spawn`，不在正式接口里）。
- `TestFrontend`（`frontend.ts`）：`connect(url, { origin?, host?, cookie?, headers?, noPong? })`（握手被拒时抛 `HTTP 403` / `HTTP 401`；`cookie` 带设备凭证，`noPong` 模拟半开连接）、`closed()`（等服务端关掉这条连接，拿到关闭码和原因）、`isOpen`、`subscribe(cursors)`、`sendText(text, { idempotencyKey? })`、`cardAction(params, key?)`（和 Web 一样先录一条本地动作）、`inboxAction(params, key?)`、`startTask(request, key?)`（点"发起任务"按钮）、`request(method, params, key?)`、`sendRaw(text)` / `nextResponse()`（测格式不对的帧）、`next(channel, type)`（按到达顺序往后等）、`events({ channel?, type?, persistedOnly? })`、`timedEvents()`（带收到的时间）、`cursors`（重新同步的频道归零）、`disconnect()` / `reconnect(channels, url?)`（断网、带游标重连；守护进程重启后端口变了就给新地址）、`sendTextThenDrop(text)`（发出去就断网）、`sendParts(parts)` / `trySendParts(parts)`（带附件的消息；后者把被拒的响应原样交回）、`history(conversation, { before?, limit? })`（经 HTTP 往上翻一页，录成 `history_page`）、`recording`（录下的输入，类型就是 Web 状态层的 `UiInput`）。频道名和事件类型用协议包的常量。
- `http.ts`：HTTP 那一半。`media.upload(url, bytes, { name, mime }, chunkSize?)` 整个传完并收尾（带原始字节的 sha256），`media.create / put / status / complete / download(url, mediaId, { range?, name? })` 一步一步来；`putThenDrop(...)` 发出一个分片的一部分就掐断连接（模拟传到一半断网）；`history(url, conversation, ...)`；`materialsApi.scope(url, scope?)`、`materialsApi.delete(url, body)`（设置里删除素材的两个接口）；`workdayApi.month(url, "YYYY-MM")`、`workdayApi.change(url, change)`（设置里的工作日历，29 号票）；`sha256Hex(bytes)`。
- `images.ts`：按格式结构手工拼的小图片（`jpeg({ exif: { gps, orientation }, xmp, comment })`、`png({ exif, text })`、`webp({ exif, xmp })`），带上 GPS 等元数据；`jpegMarkers` / `pngChunkTypes` / `webpChunkTypes` 列出各段。`png()` 是能解码的真图片（pi 发给模型前会解码、缩放图片，测视觉时用它）；`jpeg()` 只保证结构。
- `pdf.ts`：`pdf([["第一页的行", …], …])` 手工拼一个 ASCII 文字的小 PDF。
- `echo.ts`：`stripTimeMarkers(context)` 去掉 echo_context 回显里每条用户消息前的时间标记（只关心内容时用）。
- `ports.ts`：`freePort()`、`writePortsConfig(dataDir)`（本机端口和外网端口各挑一个空闲端口写进数据目录的配置，返回两个端口；`writePortConfig` 只返回本机端口）。
- `device.ts`（10 号票）：`TestDevice`——一台从外网（经隧道）访问的设备：自己的 cookie 罐（Set-Cookie 记下，Max-Age=0 的删掉）、`userAgent`、`realIp`（每个请求带上 X-Real-IP）；`requestPairing(name?)`、`pollPairing()`、`renamePairing(name)`、`access()`、`request(path, options)`、`connect()`（带着 cookie 连 WebSocket）、`credential`（设备凭证原值）。`pairDevice(externalUrl, 批准方前端, { name?, realIp?, firstUse? })` 走完一次配对（批准方要已订阅卡片频道），默认领到凭证后像浏览器那样带着它问一次 `/api/access`（设备由此启用），`firstUse: false` 停在"领到了、还没用过"；`waitForPairingCard(frontend, requestId)`。`TestFrontend.recordUnpaired(access)`：服务端关掉连接后，像 Web 的连接那样录"断开"和"凭证失效"（带原因）。
- `browser-http.ts`（10 号票）：`httpRequest(base, path, { method?, headers?, body? })`，Host、Origin、Cookie、X-Real-IP 想怎么写就怎么写，结果带文本正文、`json()` 和解析好的 `setCookies`。
- 关注类别设置的主切面（26 号票）：`watch-categories.test.ts`（设置页看到的、改了下一次判定就按新设置、改不动的、agent 写配置区、文件坏了和修复）、`plan-watch-categories.test.ts`（计划卡上的本任务关注类别、加类别只影响这个任务、全局改了跟着走、用户的限制；任务执行还没接上，"判定"用 `toGuardPlan` 加守卫的判定函数算）。`TestFrontend.updateWatchCategories(params, key?)` 发设置页的请求；关注类别频道和秘书会话各走各的，等设置事件用按频道计数的 `nextSettings`（不用 `frontend.next` 的全局游标）。
- `plans.ts`（12 号票）：`samplePlan(overrides?)` 一份字段齐全、能通过检查的计划（两个阶段、一个阶段组、全局九类关注类别、一个定时作业定义），`submitPlanStep(plan?)` 维护者调用"提交计划"的一步剧本。
- 任务的主切面：`tasks.test.ts`（三条发起路径、提问卡、任务书交给维护者、提交计划、计划卡的确认和打回、素材）、`agent-limits.test.ts`（子进程上限和排队、闲置退出、超时、孤儿进程回收）。秘书、维护者、用户的动作各走各的频道，**跨频道的先后不确定**：等某个结果用 `waitUntil` 看累积收到的事件（`tasks.test.ts` 的 `eventually`），只在同一个频道里按先后等时用 `frontend.next`。状态迁移表、计划检查的表格测试在 `test/tasks/`。
- `recording.ts`：`saveOrCheckRecording(name, frontend.recording, { perChannel? })`，见上面"回放测试"。`perChannel: true` 只核对每个频道里的先后（几个 agent 同时干活、频道之间谁先到每次不一样的流程用它）。`task-initiation`（`tasks.test.ts`：秘书直接建任务 → 提问卡全按推荐 → 计划卡 → 收窄一项后确认 → 排队中）用的就是它，重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/tasks.test.ts -t 演示流程`。`typed-shell-tools`（`typed-shell.test.ts` 的演示：维护者用带类型的 bash 工具看状态、提交、建远端仓库、推送被退回再放行、force push 禁止、合并、构建、装依赖；同样 `perChannel`），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/typed-shell.test.ts -t 演示`。另外十一段：`secretary-chat`、`secretary-reconnect`、`secretary-resync`、`secretary-history`（第一次只补发最近一页，往上翻一页）、`secretary-attachments`（带图片和文件的消息）（在 `recordings.test.ts` 里录），`cards-inbox-sync`（`cards.test.ts`）、`reminder-due`（`reminders.test.ts`）、`secretary-approval`（读草稿区外的文件先问、批准后执行，`approvals.test.ts`）、`device-revoke`（`devices.test.ts`：只订阅已配对设备的设置页，两台配对、吊销一台）、`device-revoked-here`（同一个用例里被吊销的那台设备上的页面：连接被关掉，问到"被吊销"）、`memory-purge`（`memory-delete.test.ts`：秘书检索、出记忆删除卡、确认彻底删除，原话变成"已删除"）、`workday-calendar`（`workday-calendar.test.ts`：节假日数据、改个人设置、按我的工作日的提醒跟着工作日历变的下一次）、`holiday-update-task`（同一个文件，`perChannel`：缺失事项 → 发起更新任务 → 规划中 → 计划卡（定时作业"按我的工作日 09:00"）→ 确认；重新录这两段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/workday-calendar.test.ts`）。录制文件入库：保存时把临时目录、用户主目录（正斜杠、反斜杠、8.3 短名、真实路径几种写法）换成 `<临时目录>`、`<用户主目录>`，`test/recordings-privacy.test.ts` 检查录好的文件里没有本机用户主目录。重新录这一段和审批那段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/memory-delete.test.ts packages/daemon/test/main/approvals.test.ts`。重新录这两段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/devices.test.ts`。重新录卡片、提醒和审批的三段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/cards.test.ts packages/daemon/test/main/reminders.test.ts packages/daemon/test/main/approvals.test.ts`。26 号票加了 `watch-categories`（`watch-categories.test.ts` 的"演示流程"：设置页新建、改处置、调严内置类别、调松被拒、删除），重新录：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/watch-categories.test.ts -t 演示流程`。
- 守卫接入的主切面：`secretary-scratch.test.ts`（草稿区里干活、秘书的围栏、不能联网）、`approvals.test.ts`（审批卡、等待与挂起、一次性授权、交给我做）。聊天里的工具调用记录用 `tool_call` part 断言，模型看到了什么用剧本最后一步 `echo_context` 的回显断言。
- `clock.ts`：`ManualClock`，见上面"调度器和简单提醒"。
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
    - `{ kind: "reply", text?, thinking?, toolCalls? }`；
    - 或 `{ kind: "echo_context" }`：把这次调用看到的上下文原样回成文字，每行以 `[system]`、`[tool]`、`[user]`、`[assistant]`、`[toolResult]` 开头；
    - 或 `{ kind: "call_with_matches", toolCall, argument, pattern }`：从上一个工具结果里按正则 `pattern` 挑出全部匹配（去重），放进 `toolCall` 的参数 `argument`（可以是点分路径，比如 `params.materialIds`）再调用（剧本写的时候还不知道素材 id，比如"照检索结果提议删除"）。
- `user-profile.ts`：`tempUserProfileEnv(homeDir)` 生成上面那组用户目录变量，`withEnv(base, ...overrides)` 按 Windows 不分大小写的规则覆盖环境变量。不引用 vitest，测试夹具进程也能用。
- `report-log.ts`：`ReportLog` 按到达顺序记下子进程发来的消息。`await log.next("turn_end")` 等下一条某类消息，连续调用 `next` 就能断言先后顺序；`log.ofType("stream_delta")` 取到目前为止的某一类消息。
- `process.ts`：
  - `isProcessAlive(pid)`；
  - `waitUntil(predicate, { timeoutMs, describe })`：默认等 10 秒，超时的错误里带 `describe()` 的说明。等秘书拉起来（加上它回第一轮）的那一处显式传 `SECRETARY_START_TIMEOUT_MS`（20 秒）；同一个用例里几次等待加起来超过用例超时（30 秒）的，用例写明更长的超时，真超时时看到的是 `waitUntil` 的说明；
  - `forceKill(pid)` 用来兜底清理，只对还没确认结束的进程用，免得 pid 被复用后误杀。
- `fixtures/`：
  - `daemon-host.ts`：独立进程里的守护进程宿主，Job 对象测试拿它来强杀；
  - `grandchild.mjs`：给 bash 工具起的孙进程和孤儿进程。

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
- 表格测试：`categories`（类别 × 对话 / 任务、设置、自定义类别）、`bottom-lines`、`grants`、`bash`、`fence`、`network`、`registries`、`temporal-rules`（四种形态、只看效果日志、阶段和阶段组、判断不了）、`rule-validation`、`effect-log`（记录的字段、参数名统一）。
- **场景文件** `scenarios/*.guard.json`，由 `scenarios.test.ts` 逐个跑，格式见 `helpers/scenario.ts` 开头的说明（26 号票起每一步可以写 `settings`：从这一步起按这份全局设置判，`custom-category-settings` 用它演示改设置）。和 AgentSense planguard 兼容：`tools`（参数规则照 planguard 的 `args` 写）、`rules`（planguard 规则，原样交给判定函数，先过规则校验）、`facts`（每一步都带上的环境事实，planguard 的领域事实放 `facts.extra`）、`calls`（每一步 `tool`、`args`、`commit`、`expect`，`expect` 里可以写 planguard 的 `verdict` 和 `kinds`）。路径写占位符 `${workDir}`、`${scratch}`、`${config}`……。执行成功的步骤按 `effectRecordsFor` 进效果日志。现有的：v1 六条模板各一份（`v1-*.guard.json`）、四种形态挂在阶段和阶段组上（`temporal-forms-stages`）、从 AgentSense 搬来的 storage 和 office 用例（`agentsense-*`）。
- **v1 模板默认生效**，看关注类别、授权项这些别的东西的表格测试用 `v1Satisfied(...仓库)`（`guard-input.ts`）先满足模板的前提（这些仓库里跑过测试、都已提交、HEAD 是新提交），免得被"push 之前必须跑过测试""删除或覆盖之前必须已提交"退回，或者被"不重复发"判断不了。`effect(seq, tool, args)` 造一条效果日志。

**pi 契约测试**放在 `packages/daemon/test/contract/`，文件名 `*.contract.test.ts`。每条用例单独拉起一个子进程、接 faux provider，只验二狗依赖的 pi 行为。现有五个文件：

- `pi-session.contract.test.ts`：流式到定稿；会话不读用户目录和工作目录里的配置、skill、上下文文件和 CLI 认证；固定的系统提示替换掉 pi 默认的编程助手提示；`continueSession` 接着会话目录里最近的会话；工具白名单之外的工具用不了（只给 `read`、`ls` 时调用 `write`、`bash` 以"没有这个工具"出错，什么也没做——起草计划的维护者靠它）。
- `guard-and-interject.contract.test.ts`：工具调用停在 `tool_call` 钩子里等守护进程判定，按判定执行或不执行（文件工具、bash 的命令真的没跑；守护进程代为执行的工具不放行就不发 `host_tool_call`）；插话在下一次模型调用之前进入上下文。
- `shell-env.contract.test.ts`：同名的自定义工具换掉 pi 自带的 bash，起进程前往环境里加 `shellEnv`（联网开关关着时的无效代理）；bash 里看不到模型 key。
- `session-rewrite.contract.test.ts`（21 号票）：经 agent 管家的 `rewriteSessions`（一次性子进程）改写 pi 的会话文件：输入标记后面的那条用户消息、某次工具调用的参数和结果、检索结果里提到某个 id 的行改写成删除标记，覆盖了它们的压缩摘要整段换掉（没覆盖的不动）；保留修改时间，`continueSession` 仍接着这个会话，重新拉起后模型看到的是标记；agent 还在跑时拒绝改写。
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

`deploy/lsm/ergou-daemon.example.yaml` 是 LSM 注册表条目的示例（格式见 LSM 的 `docs/service-schema.md`）：健康探针 `/healthz`（health 档，端口 8810）、autoRestart、`ERGOU_DATA_DIR`、模型 key 由 LSM 从数据目录密钥区注入（`env.from: file`）、start / stop 钩子都用固定的 Node 22 LTS 绝对路径。本机路径写成三个占位符：`<仓库路径>`、`<专用 Node 路径>`、`<用户主目录>`。**真实条目只放在 LSM 自己的登记目录里，不进本仓库。** link 协议（有任务时报"忙"）在 23 号票。条目里的 `exposure`（公网入口）在示例里是注释掉的：LSM 校验时要求 `via` 指向的隧道已经登记，没登记 `ergou-tunnel` 就打开会让整个条目登记不上；登记隧道之后再去掉注释，见下面"公网入口"。

登记（问过用户之后做，二狗自己不启动任何服务）：

1. **装一份专用的 Node 22 LTS**（≥22.19），比如解压官方的 zip 到一个固定目录。不用 PATH 上的 node（PATH 顺序一变可能换成别的版本），也不用 pi 自带的那份（随 pi 升级）或别的程序带的 node；版本先 `node -v` 看一眼。它的 `node.exe` 绝对路径就是 `<专用 Node 路径>`。
2. **主分支的检出目录**（`<仓库路径>`，不是 worktree）在 main 上：`npm ci`，`npm run build:web`。以后每次合并到 main 后重新 `npm ci`（依赖变了时）、`npm run build:web`，再在 LSM 里重启 `ergou-daemon`（只改了 Web 时不用重启，页面每次请求重新读）。
3. **数据目录和密钥**：在 `<用户主目录>\.ergou\secrets\` 下放 `deepseek-api-key.txt`（只有 key 一行）。数据目录其余各区守护进程启动时自己建；要改端口就放一份 `config/ergou.json`（从 `config/ergou.example.json` 复制），同时改条目里的两处 8810（stop 钩子从配置读端口）。
4. **生成真实条目**：复制示例到 LSM 的 `registry/services/ergou-daemon.yaml`，把三个占位符换成本机的值（换完不应再有 `<…>`）。在 LSM 目录跑 `node bin/lsm.mjs validate`（只校验，不碰进程），再 `lsm reload`（或在 WebUI 里重新加载）。
5. **当场验证钩子闭环**（LSM 的纳管要求）：`lsm start ergou-daemon` → `/healthz` 转绿 → `lsm stop ergou-daemon`（端口放出）→ `lsm start ergou-daemon`。通过后在真实条目里填 `onboarding.verifiedAt` 和 `verifiedHooks: [start, stop, health]`。守护进程的输出在 LSM 的 `logs/ergou-daemon.out.log`。stop 钩子核对不上 pid 文件时什么也不做，原因会显示在 LSM 里。
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

