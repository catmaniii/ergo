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
| 重新录前端回放用的事件流 | Git Bash：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/recordings.test.ts`（PowerShell：先 `$env:ERGOU_RECORD_EVENTS=1`） |

守护进程包里还有 `npm run test:unit -w @ergou/daemon`（不含契约测试）和 `npm run test:contract -w @ergou/daemon`。

## 工作区

```
packages/
  protocol/   @ergou/protocol  守护进程和前端共用的前端协议（TypeBox），见下面"共享协议包"
  daemon/     @ergou/daemon    守护进程：管家，拉起和管理 agent 子进程；事件存储、网关、秘书
  web/        @ergou/web       Web UI：React 19 + Vite，手写 CSS（起点复制自 AgentSense），见下面"Web 包"
config/ergou.example.json      示例配置（仓库里只有示例，没有个人数据）
deploy/lsm/ergou-daemon.example.yaml  ergou-daemon 的 LSM 条目示例（本机路径是占位符；真实条目只放在 LSM 自己的登记目录），见下面"LSM 登记"
```

守护进程 `packages/daemon/src/`：

| 目录 | 是什么 |
|---|---|
| `main.ts` | `ergou-daemon` 的入口（LSM 用 `node packages/daemon/src/main.ts` 启动） |
| `stop.ts` | LSM 的 stop 钩子：读同一份配置，核对"监听本机端口的就是 pid 文件里那个进程、启动时间也对得上"才结束它，否则不动、报原因 |
| `daemon.ts` | 组装：读配置、找数据目录、打开事件存储、建 Job 对象、立起调度器、卡片、待我处理、简单提醒、agent 管家和秘书、开本机端口；停止和启动中途失败共用一份按相反顺序收拾的清单。`startDaemon()` 的 `localPort`、`webRoot`、`secretaryModel`、`secretaryDownThresholdMs`、`clock`、`extraCardTypes` 给测试用 |
| `config/` | 配置（只读）、数据目录各区的路径（`dataDirLayout`）、模型 key 从哪个环境变量取（`secrets.ts`） |
| `storage/sqlite.ts` | 存储薄接口：所有 SQLite 访问都经过它，换驱动只改这一个文件。`openReadonlyDatabase` 给读派生视图用（只读打开，写不进去） |
| `events/event-store.ts` | **事件存储**：事件日志是唯一真相（`ergou.db`，WAL）。见下面"事件存储" |
| `events/ephemeral.ts` | 临时事件（只推给正连着的前端）的推送：到点的提醒这类 `notify` |
| `errors.ts` | `RequestRejected`：模块按前端协议的错误码拒绝请求，网关原样回成错误响应 |
| `cards/` | **卡片**：类型注册表（`registry.ts`）、按钮闭环（`cards.ts`）、派生视图。见下面"卡片和待我处理" |
| `inbox/` | **待我处理**：事项、紧急度、已读 / 归档 / 删除、到点通知。见下面"卡片和待我处理" |
| `scheduler/` | **调度器**和可注入的时钟（`clock.ts`）。见下面"调度器和简单提醒" |
| `reminders/` | **简单提醒**：时间规则（纯函数）、提醒卡、秘书的三个工具、派生视图。见下面"调度器和简单提醒" |
| `conversation/` | 会话：派生视图（会话消息、agent 输入队列）、往会话里追加消息、流式增量的节流推送（`stream-hub.ts`） |
| `gateway/` | 网关的本机端口：只听 127.0.0.1、校验 Host 和 Origin（`local-origin.ts`）；Web UI 静态文件、`/healthz`、`/ws` |
| `secretary/` | 秘书：常驻子进程、长期主线会话、从事件日志里的输入队列逐条取输入；固定的系统提示在 `system-prompt.ts`；自定义工具（守护进程代为执行）的定义方式在 `tools.ts` |
| `process/` | 进程相关：Job 对象（`job-object.ts`）、子进程环境（`child-env.ts`）、pid 文件和进程启动时间（`pid-file.ts`） |
| `agent-manager/` | agent 管家：装配会话参数、注入环境、放进 Job、拉起子进程 |
| `runtime/` | **运行时封装层**（ADR-0001、ADR-0004）。`host-protocol.ts` 是 agent 宿主协议，`line-channel.ts` 是按行分帧和读行，`agent-process.ts` 是守护进程侧句柄，`agent-child/` 是子进程（pi 只出现在这个目录里）。上层只从 `runtime/index.ts` 取东西 |
| `guard/` | **守卫判定核心**（规格第 9 节，03 号票；时序规则和 v1 模板是 05 号票）。纯函数 `judgeToolCall`，还没接进运行时（07 号票接）。上层只从 `guard/index.ts` 取东西，见下面"守卫" |

### 事件存储（`events/event-store.ts`）

- 事件 `{全局序号, 频道, 频道内序号, 类型, 负载, 时间, 幂等键}`，频道内序号从 1 起连续。对外：
  - `append({ channel, type, payload, idempotencyKey? })`：同一个幂等键第二次追加不落新事件，返回 `{ event: 第一次那条, duplicate: true }`；
  - `appendBatch([...])`：一组事件在同一个事务里追加，要么全落、要么全不落（卡片动作的结果连同它引起的提醒变化、提醒到点时提醒 + 卡片 + 待我处理事项）；每条各按自己的幂等键去重，提交后按顺序通知；
  - `read(channel, afterSeq)`、`lastSeq(channel)`；
  - `onAppend(listener)`：提交之后同步通知。订阅者在通知里又追加了事件（秘书收到用户消息就追加 `turn_start`）时，新事件排在后面，每个订阅者收到的事件都按追加顺序、一条不漏；
  - `rebuildViews()`：清空派生视图，按全局序号把日志重放一遍；
  - `reader`：只读连接，给视图模块的读取函数用。写一律经 `append`，没有暴露可写的连接。
- **派生视图**实现 `DerivedView { name, create, clear, apply }`，在 `startDaemon` 里交给 `openEventStore({ views })`。`apply` 和事件写入在同一个事务里，抛错则整个追加回滚。视图模块自己提供读取函数（比如 `conversation/views.ts` 的 `listMessages`、`pendingInputs`）。看板、待我处理、审批表……都照这个做。
- 存储接口是同步的（`node:sqlite`），网关"读补发的事件 + 登记订阅"在同一段同步代码里，补发和实时推送之间不重不漏。

### 频道上的事件（04 号票起）

| 频道 | 类型 | 负载 | 落盘 |
|---|---|---|---|
| 会话（`secretary`、`maintainer:<id>`） | `message` | `{ message, idempotencyKey? }`：定稿的消息；用户发的带发送请求的幂等键（乐观显示靠它替换）。用户消息事件里有会话、发言方、时间和原文，08 号票据此采集"用户发言"素材 | 是 |
| 会话 | `turn_start` | `{ inputMessageId }`：agent 开始处理一条用户消息 | 是 |
| 会话 | `turn_end` | `{ inputMessageId, outcome, error? }`：agent 处理完一条用户消息（输入出队）。`outcome` 是 `completed` / `aborted` / `error` / `interrupted` | 是 |
| 会话 | `stream` | `{ messageId, deltas: [{ part, type, offset, text }] }`：流式增量，每个会话每 100 毫秒最多一帧；`messageId` 就是定稿消息的 id；序号是频道当时最后一条落盘事件的序号 | 否（临时事件，不补发） |
| `cards` | `card` | `{ card }`：卡片的最新版本（含负载版本 `typeVersion` 和纯文本降级 `text`）。用户动作产生的那条带请求的幂等键 | 是 |
| `cards` | `card_dismissed` | `{ cardId, cardType, action, time }`：用户关掉了一张卡（动作之后状态为 `dismissed`），和卡片更新同一事务。08 号票据此采集回避信号 | 是 |
| `cards` | `card_stale` | `{ cardId, cardType, pendingSince, time }`：建议卡、提问卡长期没处理。类型和负载已就绪，计时和产生在 08 号票 | 是 |
| `inbox` | `inbox_item` | `{ item }`：待我处理事项的最新状态（删除也是一次更新，`deleted: true`） | 是 |
| `inbox` | `notify` | `{ id, title, body?, itemId? }`：要马上告诉用户的事（到点的提醒）。前端在任意页面提示，用户允许时再发浏览器通知 | 否（临时事件） |
| `board` | `reminder` | `{ reminder, change, by }`：简单提醒的最新状态；`change` 是 `created` / `updated` / `cancelled` / `fired`，`by` 是 `agent`（秘书）/ `user`（卡上的按钮）/ `system`（到点）。看板的任务等事件在 12 号票 | 是 |

秘书的输入队列就是事件日志：用户消息事件进队，交给秘书时追加 `turn_start`，处理完追加 `turn_end` 出队（派生视图 `agent_inputs`：等着 / 正在处理 / 处理完）。模型出错时会话里多一条发言方为 `system` 的说明。

**处理到一半被打断的输入不重送**：秘书子进程崩溃、或者守护进程重启时，有 `turn_start`、没有 `turn_end` 的那条以 `interrupted` 结束出队，会话里追加一条系统说明（"上一条消息「…」处理时中断了，秘书没有接着处理；需要的话请重发。"），不再交给秘书；排在它后面、还没开始的照常处理。从会话文件最后一个完整回合续上的恢复规则在 23 号票。

### 网关的本机端口（`gateway/`）

- 只监听 `127.0.0.1`，端口是配置里的 `ports.local`（默认 8810）。
- 每个 HTTP 请求和 WebSocket 握手都校验：Host 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`（防 DNS 重绑定）；带了 Origin 就必须是这两个源之一（防跨站请求和跨站 WebSocket）；不带 Origin 的本机程序（LSM 的探针、不在浏览器里的前端）放行。不看来源 IP。
- `GET /`：原样发出 `packages/web/dist/index.html`（每次请求重新读）；没构建时回 503 并提示 `npm run build:web`。
- `GET /healthz`：`{ ok, secretary, webUi, reasons }`。秘书不在运行（拉起中、意外退出后重新拉起中）超过阈值（默认 30 秒）或者 Web UI 没构建时，`ok` 为 false、回 503，`reasons` 写明原因；秘书闲着或在干活时健康。
- `/ws`：前端协议。格式不对的请求得到错误响应，连接不断。外网端口和设备凭证在 10 号票。
- 请求的分发在 `FrontendConnection.dispatch`：发消息直接调会话模块；卡片动作和待我处理的动作交给 `startGateway({ requests })` 里的 `RequestHandlers`（`daemon.ts` 接到 `cards.act` / `inbox.act`）。模块拒绝时抛 `RequestRejected(code, message)`，网关回成同样的错误。
- 临时事件有两个来源：流式增量（`streams`）和别的通知（`notifications`，`events/ephemeral.ts`），都只推给订阅了那个频道、正连着的前端。
- **重新同步**：订阅时前端带来的序号比某个频道的最后序号还大（比如数据目录恢复成了旧快照），订阅响应的 `resync` 里点名这个频道，服务端从头补发它的事件；前端收到后先清掉这个频道的状态。

## 卡片和待我处理（`cards/`、`inbox/`，06 号票）

卡片是独立实体，消息里只放引用（`card_ref` part）；同一张卡在聊天、待我处理（以后还有时间线）里只有一份状态，状态全在卡片频道上。

**登记一种卡**（12、13、15、17……各票照这个做）：

```ts
// 负载的 schema 在共享协议包里；动作的输入 schema 用协议包转出的 Type 写
export const myCardType = defineCardType({
  type: "suggest_task",            // CARD_TYPES 之一
  version: 1,                      // 必须等于 CARD_TYPE_VERSIONS[type]
  payload: SuggestTaskCardPayload, // 建卡和动作改出来的负载都按它校验
  actions: {                       // 不在这里的动作一律拒绝（bad_params）
    start_task: { run: (ctx) => ({ status: "handled", events: [/* 同一事务追加的事件 */] }) },
    dismiss: { run: () => ({ status: "dismissed" }) }, // 已关闭：自动多一条 card_dismissed
    save: { input: SomeInput, run: ({ payload, input }) => ({ status: "pending", payload: { ...payload, ...(input as object) } }) },
  },
  toText: (p) => `建议发起任务：${p.title}`,   // 纯文本降级版本，存进卡片的 text
});
// daemon.ts：registry.register(myCardType)
```

- `run(ctx)` 拿到动作之前的卡片和负载、动作、`note`、按 `input` schema 校验过的输入、现在的时间和请求的幂等键；返回动作之后的状态（`pending` 表示卡片还能再操作，比如改了提醒）、新的负载、处理说明，以及要随卡片更新一起追加的事件（同一事务，排在卡片更新之前）。不让做就抛 `RequestRejected`。
- **按钮闭环**由 `cards.act` 统一做：同一个幂等键重发直接回第一次的 ack；卡片不是待处理 → `conflict`"已被处理"；版本对不上 → `conflict`；动作不认识 → `bad_params`；输入不合 schema → `bad_params`。ack 是 `{ cardId, version }`，卡片本身随后在卡片频道推送。存储是同步的，两个前端同时点同一版本只会有一个生效。**卡片动作只接受来自前端的请求**：不要给 agent 任何对卡片做动作的工具。
- 系统建卡、改卡：`cards.create(...)`；要和别的事件原子地一起追加，用 `cards.buildCreate(...)` / `cards.buildUpdate(cardId, { payload?, status?, outcome? })` 拿到 `{ card, event }`，自己放进 `store.appendBatch`。
- 在聊天里出现一张卡：往会话里追加一条带 `card_ref` part 的消息（秘书的工具返回 `cardIds`，秘书模块代劳，见下面"秘书的工具"）。

**待我处理**：

- 放进一条事项：`inbox.add({ kind: "card", cardId, title, source, urgency })`，或者通知类 `inbox.add({ kind: "notice", notice, title, body, source, urgency, pinned?, actions, cardId?, data? })`（`notice` 取 `NOTICE_TYPES`；`cardId` 是相关的卡，详情页里显示在通知下面；`data` 放这种通知自己的结构化内容）。要原子地和别的事件一起追加，用 `inbox.buildAdd(...)`。要马上告诉用户（页面内提示、浏览器通知），追加之后调 `inbox.alert(item)`。
- 紧急度三档 `blocking_deadline` / `blocking` / `non_blocking`。**卡着任务**（前两档）的事项处理之前，归档或删除被拒（`not_allowed`，说明原因）：卡片事项看卡片的状态，通知类看有没有选过它的动作。卡着任务的事项出现后，由产生它的票补主切面场景（本票在模块层测，`test/inbox.test.ts`）。
- 前端的动作是 `inbox_action { itemIds, action, choice? }`：`read` / `unread` / `archive` / `unarchive` / `delete` / `handle`（处理通知，`choice` 是它的 `actions` 之一）。一次多项时要么全部生效、要么全部不生效；没有变化的事项不推送。

## 调度器和简单提醒（`scheduler/`、`reminders/`，06 号票）

- **时钟可注入**（`scheduler/clock.ts` 的 `Clock`：`now()`、`setTimer(at, fn)`）。`startDaemon({ clock })`，不给用系统时钟；事件时间也跟着它走。测试用 `test/helpers/clock.ts` 的 `ManualClock`：`advanceTo(时刻)` 时途中到点的计时器按先后依次触发，触发时 `now()` 正好是那一刻（重复的提醒在一次拨动里能响好几次）。
- **调度器**（`scheduler/scheduler.ts`）：`schedule(key, at, run)`（同一个 key 再登记就换掉）、`cancel(key)`、`pending()`。它只管内存里的计时器；要做的事和下一次的时间存在各模块的派生视图里，守护进程启动时由各模块重新登记。定时作业、错过的触发、内部作业（19 号票）都挂在它上面：在 `daemon.ts` 里拿 `scheduler` 登记。
- **简单提醒**（`reminders/`）：
  - `schedule.ts`：纯函数。`resolveReminderTime(秘书给的时间, 现在)` 把"几点 + 哪天 / 几天后 / 几分钟后 + 重复规则"落成协议的 `ReminderSchedule`；`nextOccurrence(规则, 某时刻之后)`；`describeSchedule` / `describeTime` 是中文写法。29 号票在 `ReminderSchedule` 里加 `{ kind: "workdays", time }`，在 `nextOccurrence` 和 `resolveReminderTime` 里各加一支。
  - `reminders.ts`：`create` / `update` / `cancel`（秘书用；提醒卡跟着变），`prepareUpdate` / `prepareCancel`（提醒卡的按钮用，卡片由卡片动作自己更新）。每次变化是看板频道上一条 `reminder` 事件；`start()` 把待触发的提醒登记进调度器，之后跟着每条 `reminder` 事件重新登记，所以守护进程重启后还没到点的提醒照常触发。到点：一次性的变成已触发、提醒卡变成已过期（界面上写"已触发"），重复的算出下一次；同一事务里放一条置顶的待我处理事项（`reminder_due`，相关的卡是提醒卡），再推一条临时的 `notify`。不拉起任何 agent。错过的触发怎么补在 19 号票（现在的做法：启动时已经过点的马上响一次）。
  - 提醒的编号是 `r-1`、`r-2`……（短，秘书好引用）。
  - `card.ts`：提醒卡，动作 `save`（输入 `ReminderEditInput`：新的时间或重复规则，可连内容一起改；卡片仍待处理）和 `cancel_reminder`（卡片已处理）。

## 秘书的工具（守护进程代为执行）

秘书的五种回复形态里，除了直接回答，其余四种各是一个只产生卡片的工具（规格第 7 节）。这类工具的逻辑和要改的状态都在守护进程里，子进程只转手：

- 宿主协议：会话装配参数 `hostTools: HostToolSpec[]`（名字、说明、参数的 JSON Schema）；子进程把它们登记成 pi 的自定义工具（`runtime/agent-child/host-tools.ts`），模型调用时发 `host_tool_call`，等守护进程回 `host_tool_result { text, isError }`。pi 先按 JSON Schema 校验参数，不合就不转。契约测试在 `test/contract/host-tools.contract.test.ts`。
- 秘书这边：`defineSecretaryTool({ name, description, parameters, run })`（`secretary/tools.ts`，参数用协议包的 `Type` 写，守护进程再校验一次），交给 `startSecretary({ tools })`。`run` 返回 `{ text, isError?, cardIds? }`：有 `cardIds` 时秘书往会话里追加一条只有卡片引用的消息，卡片就出现在聊天里。本票的三个工具在 `reminders/tools.ts`；12（建议发起任务）、15（建议立项）、21（提议快速动作）照这个加。07 号票接通守卫后，这几个工具在工具注册表里登记为不落入任何类别。
- 秘书不一定知道今天几号：提醒工具的时间可以写成"几天后的几点"或"几分钟后"，日期由守护进程按（可注入的）时钟算，工具结果里写明落到了哪天几点。

## 共享协议包（`packages/protocol/`）

- `constants.ts`：频道名（`CHANNELS`、`maintainerChannel`）、事件类型（`EVENT_TYPES`，临时事件 `isEphemeralEventType`）、请求方法（`METHODS`，必须带幂等键的 `METHODS_REQUIRING_IDEMPOTENCY_KEY`）、错误码、卡片类型和动作等。**不引用 TypeBox**。
- `schema.ts`：TypeBox 定义的三种帧（`RequestFrame`、`ResponseFrame`、`EventFrame`）、频道（`Channel`、会话 id `ConversationId`）、消息信封和全部 part（含工具调用 part 的关注类别、判定、授权内、通用 bash）、卡片、各方法的参数和结果、各事件的负载；类型用 `Static<>` 生成，和 schema 同名导出。
- `request.ts`：`parseRequest(raw)` 先校验帧、再按方法校验参数，给出类型确定的请求或错误（`bad_frame` / `unknown_method` / `bad_params` / `idempotency_key_required`）；有副作用的方法在类型上幂等键就是必填的。`isChannel(name)` 按 schema 里的 `Channel` 判断。
- `time.ts`：`nowIso()`，协议里的时间格式（带时区偏移的本地 ISO 时间，精确到毫秒）。守护进程和 Web 都用这一份。
- `validate.ts`：`schemaChecker(schema)`（按 schema 校验一个值，给出第一条错误），以及转出去的 `Type`、`Static`、`TSchema`。守护进程自己的 schema（卡片动作的输入、秘书工具的参数）也用这里的 `Type` 写，不另外引用 TypeBox，免得两个版本混用。
- 包声明了 `sideEffects: false`：Web 只用到常量、类型和 `nowIso`，打包时 schema 和 TypeBox 被摇掉。
- **加一个请求方法**：`METHODS` 里加名字（有副作用就加进 `METHODS_REQUIRING_IDEMPOTENCY_KEY`）→ `schema.ts` 里定义参数和结果 → `request.ts` 的 `PARAM_SCHEMAS` 登记一项（参数类型 `MethodParams` 和校验器都由它推出）→ 网关 `FrontendConnection.dispatch` 里处理（`switch` 不全 `tsc` 会报）。**加一种频道**：`CHANNELS` 加名字、`schema.ts` 的 `Channel` 加一项（`isChannel` 跟着变）。**加一种事件**：`EVENT_TYPES` 加名字、`schema.ts` 定义负载；前端在状态层 `eventHandlers` 里加归并（临时事件还要加进 `EPHEMERAL_EVENT_TYPES`，前端在 `reduceEphemeral` 里处理）。**登记一种卡片**的协议部分：负载的 schema 写在 `schema.ts`（比如 `ReminderCardPayload`），负载形状改了就把 `CARD_TYPE_VERSIONS` 里它的版本加 1（守护进程登记时核对，前端靠它判断认不认识）。

## Web 包（`packages/web/`）

### 页面从哪里来

- **由守护进程提供**（04 号票起的正式方式）：`npm run build:web` 之后，经 LSM 启动的 `ergou-daemon` 在 `http://127.0.0.1:8810/` 提供同一份构建产物。秘书页、卡片、待我处理和看板上的简单提醒接真数据（WebSocket），其他页面仍是原型的假数据，页面顶上的原型工具条会写明。
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
| `src/app/` | 状态层接到 React（`store.tsx`）、前端连接接口（`connection.ts`）和它的 WebSocket 实现（`ws-connection.ts`）、`#` 路由（`route.ts`） |
| `src/model/` | 页面用的领域形状（看板、项目、待我处理、设置）、14 种卡片的负载和动作结果文字、中文标签 |
| `src/util/` | 和界面无关的小工具（时间格式、`nowIso`） |
| `src/ui/` | 共用部件：会话组件（`conversation/`，秘书和维护者共用一个）、卡片（`cards/`，入口是 `CardPanel`，不认识的卡显示纯文本降级加"去 Web 处理"）、分栏和弹层（`common.tsx`）、页面底部的短提示（`toast.tsx`，`useToast()`）、到点的页面内提示和浏览器通知、被拒请求的提示（`alerts.tsx`） |
| `src/pages/` | 各页面：秘书、任务（看板 + 详情）、项目、待我处理、更多（消耗、设置各页）、配对等待页和批准页 |
| `src/prototype/` | **只属于原型**：假事件、假数据（名字和路径都是明显虚构的）、假连接（`fake-connection.ts`）、过渡期的分流连接（`split-connection.ts`：接了真数据的频道走 WebSocket，其余走假连接）、看板等假数据的本地状态（`proto-store.tsx`，跟着前端状态层里卡片的变化走，不认具体的连接）。接真数据的票逐步删掉这里的东西 |
| `src/styles/` | `base.css`（颜色 token、通用控件）、`layout.css`（tab、分栏、阶段抽屉）、`look.css`（视觉规矩）三份复制自 AgentSense 再裁剪；`pages.css` 是二狗自己的页面样式 |

### 前端状态层（`src/state/`）

- 输入（`UiInput`）三类：
  - 服务端推来的事件帧 `{channel, seq, type, payload}`。按频道记下最后收到的序号，重复或更旧的直接丢掉；临时事件（`stream`）不推进序号，比已收到的落盘事件旧就丢掉；
  - 本地动作：发消息（`send_message`）、点卡片按钮（`card_action`）、请求失败（`request_failed`）；
  - 连接状态（`connection`）：连接中、在线、断开、页面过旧（`UiState.connection`；会话组件在断开和过旧时提示一行）；
  - 重新同步（`resync`）：清掉一个频道的序号和归并出来的状态（还没确认的乐观显示留着），接下来服务端从头补发。
- 流式：`stream` 事件拼成"正在生成的回复"，在会话视图里是 `kind: "streaming"` 的条目（排在权威消息之后、乐观显示的尾巴之前），id 就是定稿消息的 id，定稿时原地换掉；`turn_end` 时收起。每段增量带 part 下标和字符偏移，对不上（断线漏了中间的、说到一半才打开页面）就标成 `broken`，界面只显示"正在回复…"，等定稿消息。
- 乐观显示：自己发的消息先显示在会话末尾（`pending`），收到带同一个幂等键的 `message` 事件后被替换；请求失败就标成失败。卡片按钮点了先是"处理中"，收到更高版本的 `card` 事件后变成权威状态。
- 对外只用 `reduce`、`replay`、`resumeCursors`（重连时带给服务端的序号）和选择器 `conversationView`、`selectCard`（返回 `CardState`：权威版本加本地还没结果的动作）。还没结果的请求统一用 `RequestStatus`（在路上 / 失败带错误）。
- 06 号票起：
  - `cardDisplay(state, cardId)`（`cards.ts`）：认识的类型和版本 → `typed`；不认识的类型、或负载版本比 `CARD_TYPE_VERSIONS` 新 → `fallback`（纯文本降级 `text`，"去 Web 处理"的链接 `#/card/<id>`）；
  - 待我处理（`inbox.ts`）：`inboxEntries(state, "open" | "done" | "archived")`（置顶在前，然后按紧急度三档，同一档新的在前；卡片事项处理没处理看卡片）、`inboxCounts`、`inboxBadge`（未读数 → 小红点；看过没处理的件数 → 灰色数字）、`selectInboxItem`；
  - `selectReminder`：看板频道上的简单提醒；
  - `alerts`：临时的 `notify` 事件变成待提示的通知，界面提示过就送 `alert_seen`；
  - `failures`：和消息、卡片对不上的被拒请求（比如卡着任务的事项不能删），界面提示过就送 `failure_seen`。
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

界面只通过 `Connection` 收发：`connect(cursors, deliver)` 连上后把事件帧、失败的请求和连接状态都变成 `UiInput` 交给状态层；`sendMessage`、`cardAction`、`inboxAction` 发带幂等键的请求（卡片动作带期望版本和可选的结构化输入）。连接只在 `App.tsx` 里注入一次（`StoreProvider` 的 `connection`），别处（包括原型的假数据）都不认具体的连接：

- `WebSocketConnection`（`src/app/ws-connection.ts`）：连上就发 `subscribe`（协议版本 + 每个频道最后收到的序号），断线自动重连（间隔逐步拉长），没得到响应的请求重新订阅之后带同一个幂等键重发；协议版本对不上报"页面过旧"、不再重连；订阅响应里点名重新同步的频道，交给状态层清掉、游标归零。`test/app/ws-connection.test.ts` 用假 socket 测它。
- `App.tsx`：页面由守护进程提供时用 `SplitConnection`，`REAL_CHANNELS`（06 号票起是秘书会话、卡片、待我处理、看板）走 WebSocket，其余频道走原型的假连接；`file://` 打开时全用假连接。**接真数据的票往 `REAL_CHANNELS` 里加频道**，全部接完后去掉 `SplitConnection` 和假连接。卡片频道接了真数据之后，原型的假卡片（任务详情里的计划卡、配对批准页……）换到频道名 `proto:cards` 上推给状态层，点它们的按钮仍交给假连接。看板频道目前只有简单提醒：原型的看板里，简单提醒换成真的（`ProtoProvider realReminders`），任务和定时作业仍是假的（12 号票接看板）。

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
  - `settings`：全局的关注类别设置，用 `loadWatchCategorySettings(layout)` 从数据目录的 `config/watch-categories.json` 读（示例见仓库的 `config/watch-categories.example.json`）；
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
  - `watch-categories.ts` 内置九类、默认处置、两条底线、设置的校验；`watch-category-store.ts` 从数据目录读设置（唯一读文件的地方）；
  - `tool-registry.ts` 工具注册表（还有大家共用的 `sendsOut`、`argEntriesOf`、`describeCall`、只读 HTTP 方法表）；`grants.ts` 授权项和 `validateGrantChange`；`paths.ts` 路径解析和比较、`agentScope`（agent 的项目范围）；`secrets.ts` 密钥形态和对外内容；`secret-files.ts` 认 `.env` 和密钥文件；
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
- **效果日志**：07 号票在工具执行成功后用 `effectRecordsFor(input, judgement, { firstSeq, at, summary? })` 生成记录追加（规格第 9 节的字段，加上会话段 `segmentId`；参数是规范化、能存成 JSON 的形式，"未知"存成 `{"$unknown": 说明}`）。
- **规则校验**：`validateTemporalRules(rules, { tools, facts? })` 返回 `{ ok, problems }`，每个问题以"规则 <id>"开头。查：键、`trigger` 和 `require` 的形态、工具是否登记、`trigger.where` / `when` / `unless` / `require` / `message` 里 `$current.args.X` / `$prior.args.X` 的参数是否登记、运算和操作数个数、正则、引用的东西是否存在、`modes` 里有没有 runtime、`on_violation`（`block`、`confirm`、`pull_back`）、id 重复或用了 v1 模板保留的 id。13 号票存计划时直接调用；判定时校验不通过的规则一律判断不了。
- **v1 模板**（`rule-templates.ts`，id 以 `v1.` 开头）要的环境事实：
  - 删除或覆盖前要 `facts.git`（包含这个路径的仓库的 `uncommittedPaths`；不在仓库里的目录写 `repository: false`）和 `facts.files[路径].exists`（整体重写时），可选 `backedUp`；缺了就判断不了、先问；
  - **项目档案不在 git 里**，覆盖或删除前由运行时自动留一份旧版本（15 号票），所以 07、15 号票对项目档案里的路径传 `facts.files[路径].backedUp: true`，模板就总是满足；
  - 推送要 `facts.git[仓库].head`（不重复发靠它区分新旧提交）；跑脚本要 `facts.scripts[脚本]`（读过密钥文件之后）。

## 配置

- **数据目录**：环境变量 `ERGOU_DATA_DIR` 指定；不指定时是用户主目录下的 `.ergou`。事件日志和派生视图在数据库区的 `db/ergou.db`（WAL）；agent 的 pi 会话在会话区，秘书在 `sessions/secretary/`，每次拉起接着最近的那个会话。经 `main.ts` 启动的守护进程在数据目录根下写 `daemon.pid`（pid、进程启动时间、端口），给 stop 钩子核对。
- **模型 key**：守护进程从环境变量 `DEEPSEEK_API_KEY` 取（`config/secrets.ts`），由 LSM 从数据目录密钥区的 `secrets/deepseek-api-key.txt` 注入；再经 stdin 交给秘书子进程。没有 key 时守护进程照常起来，秘书每次回复都以出错结束（会话里一条系统说明）。
- **秘书的模型**：`deepseek/deepseek-flash`，思考档位 `high`（`daemon.ts` 的 `SECRETARY_MODEL`）。
- **其余配置**：放在数据目录的 `config/ergou.json`，缺的项取默认值。可以从 `config/ergou.example.json` 复制一份开始。
- **关注类别设置**：数据目录的 `config/watch-categories.json`（内置类别的调整、自定义类别）。没有这个文件时全按默认；文件不对时报错。
- **端口**：`ports.local`（本机端口，只监听 127.0.0.1）默认 8810，`ports.external`（外网端口，隧道的目标）默认 8811。选定的依据见 01 号票的 Comments。监听在 04 号和 10 号票。
- **agent 子进程的环境**：系统变量白名单（PATH、SystemRoot、TEMP，以及 USERPROFILE、HOME、APPDATA、LOCALAPPDATA 这些用户目录类变量）加显式注入的变量，不继承守护进程的其他环境；模型 key 不走环境变量。见 `src/process/child-env.ts`、ADR-0004。

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

- `startTestDaemon(options)`：`secretary`（faux 剧本）、`secretaryTokensPerSecond`（调慢流式，测节流、测"秘书正忙"）、`secretaryModel`（直接给模型，比如一个装配不起来的，测秘书起不来）、`secretaryDownThresholdMs`、`env`、`reuse: { dataDir, homeDir }`（停掉再起同一个数据目录）、`webRoot`（默认是放了测试页 `TEST_PAGE` 的临时目录）、`portFromConfig`（测"端口从配置读"）、`clock`（`ManualClock`，到点不靠真等）、`cardTypes`（额外登记或替换的卡片类型，比如 `card-fixtures.ts` 里的替身"建议发起任务"卡）。返回 `{ daemon, url, dataDir, homeDir, webRoot }`；读派生视图用 `daemon.store.reader`，秘书子进程的 pid 是 `daemon.secretary.pid`（测崩溃），测试里直接建卡、放待我处理事项用 `daemon.cards`、`daemon.inbox`，提醒用 `daemon.reminders`，拉起过几个子进程看 `daemon.agents.spawnCount`。
- `TestFrontend`（`frontend.ts`）：`connect(url, { origin?, host? })`（握手被拒时抛 `HTTP 403`）、`subscribe(cursors)`、`sendText(text, { idempotencyKey? })`、`cardAction(params, key?)`（和 Web 一样先录一条本地动作）、`inboxAction(params, key?)`、`request(method, params, key?)`、`sendRaw(text)` / `nextResponse()`（测格式不对的帧）、`next(channel, type)`（按到达顺序往后等）、`events({ channel?, type?, persistedOnly? })`、`timedEvents()`（带收到的时间）、`cursors`（重新同步的频道归零）、`disconnect()` / `reconnect(channels, url?)`（断网、带游标重连；守护进程重启后端口变了就给新地址）、`sendTextThenDrop(text)`（发出去就断网）、`recording`（录下的输入，类型就是 Web 状态层的 `UiInput`）。频道名和事件类型用协议包的常量。
- `ports.ts`：`freePort()`、`writePortConfig(dataDir)`（挑一个空闲端口写进数据目录的配置）。
- `recording.ts`：`saveOrCheckRecording(name, frontend.recording)`，见上面"回放测试"。现有五段：`secretary-chat`、`secretary-reconnect`、`secretary-resync`（在 `recordings.test.ts` 里录），`cards-inbox-sync`（`cards.test.ts`）、`reminder-due`（`reminders.test.ts`）。重新录卡片和提醒的两段：`ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/cards.test.ts packages/daemon/test/main/reminders.test.ts`。
- `clock.ts`：`ManualClock`，见上面"调度器和简单提醒"。
- `card-fixtures.ts`：替身"建议发起任务"卡（发起任务 → 已处理，不用了 → 已关闭），给卡片和待我处理的通用机制做测试用。正式的由 12 号票登记；测试里按替换登记，不冲突。
- `test/main/entry.test.ts` 按 LSM 的方式拉起 `src/main.ts`，用 `src/stop.ts` 停下，也验 pid 文件对不上时 stop 钩子不动手。
- 守护进程里单独的模块（事件存储、流式节流 `stream-hub.test.ts`、调度器 `scheduler.test.ts`、待我处理 `inbox.test.ts`、提醒的时间规则 `reminders/schedule.test.ts`）在 `test/` 下按模块测。

### 其他辅助

- `temp-dir.ts`：`makeTempDir()` 建一个临时目录，当前测试结束自动删除（必须在测试体内调用）。
- `daemon.ts`：
  - `startTestDaemon(options)` 起一个守护进程实例（见上），测试结束时停掉，Job 里残留的进程一起清掉。
    - 数据目录（`ERGOU_DATA_DIR`）是临时目录。
    - 守护进程的环境取当前进程的环境，但 `HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`HOMEDRIVE`、`HOMEPATH` 都换成临时主目录 `homeDir` 下的路径。守护进程按白名单把它们传给 agent 子进程，所以测试里的子进程（和它起的 bash 等工具）看不到真实的用户主目录。
    - `env` 再覆盖在上面，比如放一个哨兵变量。
  - `spawnTestAgent(daemon, request)` 拉起一个 agent，返回 `{ agent, log }`，测试结束时先结束子进程。要验守卫转发时在 request 里加 `forwardToolCalls: true`，然后用 `guard_request` / `guard_reply` 来回。
  - `fauxModel(script, { tokensPerSecond })` 造一个按剧本回话的 faux 模型，不连网。剧本每一步对应一次模型调用：
    - `{ kind: "reply", text?, thinking?, toolCalls? }`；
    - 或 `{ kind: "echo_context" }`：把这次调用看到的上下文原样回成文字，每行以 `[system]`、`[tool]`、`[user]`、`[assistant]`、`[toolResult]` 开头。
- `user-profile.ts`：`tempUserProfileEnv(homeDir)` 生成上面那组用户目录变量，`withEnv(base, ...overrides)` 按 Windows 不分大小写的规则覆盖环境变量。不引用 vitest，测试夹具进程也能用。
- `report-log.ts`：`ReportLog` 按到达顺序记下子进程发来的消息。`await log.next("turn_end")` 等下一条某类消息，连续调用 `next` 就能断言先后顺序；`log.ofType("stream_delta")` 取到目前为止的某一类消息。
- `process.ts`：
  - `isProcessAlive(pid)`；
  - `waitUntil(predicate, { timeoutMs })`；
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
- **场景文件** `scenarios/*.guard.json`，由 `scenarios.test.ts` 逐个跑，格式见 `helpers/scenario.ts` 开头的说明。和 AgentSense planguard 兼容：`tools`（参数规则照 planguard 的 `args` 写）、`rules`（planguard 规则，原样交给判定函数，先过规则校验）、`facts`（每一步都带上的环境事实，planguard 的领域事实放 `facts.extra`）、`calls`（每一步 `tool`、`args`、`commit`、`expect`，`expect` 里可以写 planguard 的 `verdict` 和 `kinds`）。路径写占位符 `${workDir}`、`${scratch}`、`${config}`……。执行成功的步骤按 `effectRecordsFor` 进效果日志。现有的：v1 六条模板各一份（`v1-*.guard.json`）、四种形态挂在阶段和阶段组上（`temporal-forms-stages`）、从 AgentSense 搬来的 storage 和 office 用例（`agentsense-*`）。
- **v1 模板默认生效**，看关注类别、授权项这些别的东西的表格测试用 `v1Satisfied(...仓库)`（`guard-input.ts`）先满足模板的前提（这些仓库里跑过测试、都已提交、HEAD 是新提交），免得被"push 之前必须跑过测试""删除或覆盖之前必须已提交"退回，或者被"不重复发"判断不了。`effect(seq, tool, args)` 造一条效果日志。

**pi 契约测试**放在 `packages/daemon/test/contract/`，文件名 `*.contract.test.ts`。每条用例单独拉起一个子进程、接 faux provider，只验二狗依赖的 pi 行为。现有三个文件：

- `pi-session.contract.test.ts`：流式到定稿；会话不读用户目录和工作目录里的配置、skill、上下文文件和 CLI 认证；固定的系统提示替换掉 pi 默认的编程助手提示；`continueSession` 接着会话目录里最近的会话。
- `guard-and-interject.contract.test.ts`：工具调用停在 `tool_call` 钩子里等守护进程判定，按判定执行或不执行；插话在下一次模型调用之前进入上下文。
- `host-tools.contract.test.ts`：守护进程代为执行的工具登记进会话；调用转给守护进程，结果（含出错）回到模型；参数不合 JSON Schema 时 pi 直接拒绝、不转。

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

`deploy/lsm/ergou-daemon.example.yaml` 是 LSM 注册表条目的示例（格式见 LSM 的 `docs/service-schema.md`）：健康探针 `/healthz`（health 档，端口 8810）、autoRestart、`ERGOU_DATA_DIR`、模型 key 由 LSM 从数据目录密钥区注入（`env.from: file`）、start / stop 钩子都用固定的 Node 22 LTS 绝对路径。本机路径写成三个占位符：`<仓库路径>`、`<专用 Node 路径>`、`<用户主目录>`。**真实条目只放在 LSM 自己的登记目录里，不进本仓库。** link 协议（有任务时报"忙"）在 23 号票，`ergou-tunnel` 在 10 号票。

登记（问过用户之后做，二狗自己不启动任何服务）：

1. **装一份专用的 Node 22 LTS**（≥22.19），比如解压官方的 zip 到一个固定目录。不用 PATH 上的 node（PATH 顺序一变可能换成别的版本），也不用 pi 自带的那份（随 pi 升级）或别的程序带的 node；版本先 `node -v` 看一眼。它的 `node.exe` 绝对路径就是 `<专用 Node 路径>`。
2. **主分支的检出目录**（`<仓库路径>`，不是 worktree）在 main 上：`npm ci`，`npm run build:web`。以后每次合并到 main 后重新 `npm ci`（依赖变了时）、`npm run build:web`，再在 LSM 里重启 `ergou-daemon`（只改了 Web 时不用重启，页面每次请求重新读）。
3. **数据目录和密钥**：在 `<用户主目录>\.ergou\secrets\` 下放 `deepseek-api-key.txt`（只有 key 一行）。数据目录其余各区守护进程启动时自己建；要改端口就放一份 `config/ergou.json`（从 `config/ergou.example.json` 复制），同时改条目里的两处 8810（stop 钩子从配置读端口）。
4. **生成真实条目**：复制示例到 LSM 的 `registry/services/ergou-daemon.yaml`，把三个占位符换成本机的值（换完不应再有 `<…>`）。在 LSM 目录跑 `node bin/lsm.mjs validate`（只校验，不碰进程），再 `lsm reload`（或在 WebUI 里重新加载）。
5. **当场验证钩子闭环**（LSM 的纳管要求）：`lsm start ergou-daemon` → `/healthz` 转绿 → `lsm stop ergou-daemon`（端口放出）→ `lsm start ergou-daemon`。通过后在真实条目里填 `onboarding.verifiedAt` 和 `verifiedHooks: [start, stop, health]`。守护进程的输出在 LSM 的 `logs/ergou-daemon.out.log`。stop 钩子核对不上 pid 文件时什么也不做，原因会显示在 LSM 里。
6. **演示**：浏览器打开 `http://127.0.0.1:8810/`，进秘书页发消息，看到逐字输出；刷新后历史还在；断网（比如断开再连上）后不刷新就补上；开两个窗口内容一致。对秘书说"两分钟后提醒我喝水"：聊天里出现提醒卡（可以改、可以取消），看板"运营中"里多一条；到点时任意页面顶上出现提示，待我处理顶部是这条提醒（在待我处理页点"允许浏览器通知"后，还会弹浏览器通知）。其他页面仍是原型的假数据。
