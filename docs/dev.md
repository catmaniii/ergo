# 开发说明

怎么装、怎么跑测试、代码放在哪、测试底座怎么用。架构和取舍见 `docs/adr/`，规格见 `.scratch/ergou-v2/spec.md`。

## 前提

- **Node ≥ 22.19**（本机 v22.23）。源码是 TypeScript，靠 Node 自带的类型剥离直接运行，没有构建步骤。
- **Windows**：Job 对象只在 Windows 上有，相关测试在别的系统上会跳过。
- **Git Bash**：pi 的 `bash` 工具要用；测试里有用例让 agent 跑 bash。
- **不要在开发机上直接起常驻服务**：二狗的服务只能在 Local Service Manager 登记、由它启动。04 号票起 `ergou-daemon` 在 LSM 登记。测试里起的守护进程实例和子进程是测试的一部分，测试结束时销毁。

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
| 收尾全套 | `npm run check`（类型检查 + lint + 全部测试） |
| 构建 Web UI | `npm run build:web`（产物是单个文件 `packages/web/dist/index.html`） |

守护进程包里还有 `npm run test:unit -w @ergou/daemon`（不含契约测试）和 `npm run test:contract -w @ergou/daemon`。

## 工作区

```
packages/
  protocol/   @ergou/protocol  守护进程和前端共用的协议类型（04 号票起用 TypeBox）
  daemon/     @ergou/daemon    守护进程：管家，拉起和管理 agent 子进程
  web/        @ergou/web       Web UI：React 19 + Vite，手写 CSS（起点复制自 AgentSense），见下面"Web 包"
config/ergou.example.json      示例配置（仓库里只有示例，没有个人数据）
```

守护进程 `packages/daemon/src/`：

| 目录 | 是什么 |
|---|---|
| `daemon.ts` | 组装：读配置、找数据目录、建 Job 对象、立起 agent 管家 |
| `config/` | 配置（只读）和数据目录各区的路径（`dataDirLayout`） |
| `storage/sqlite.ts` | 存储薄接口：所有 SQLite 访问都经过它，换驱动只改这一个文件 |
| `process/` | 进程相关：Job 对象（`job-object.ts`）、子进程环境（`child-env.ts`） |
| `agent-manager/` | agent 管家：装配会话参数、注入环境、放进 Job、拉起子进程 |
| `runtime/` | **运行时封装层**（ADR-0001、ADR-0004）。`host-protocol.ts` 是 agent 宿主协议，`line-channel.ts` 是按行分帧和读行，`agent-process.ts` 是守护进程侧句柄，`agent-child/` 是子进程（pi 只出现在这个目录里）。上层只从 `runtime/index.ts` 取东西 |

## Web 包（`packages/web/`）

### 不起服务、直接打开原型

02 号票的原型全部是假数据，没有守护进程（网关和 LSM 登记从 04 号票起才有），所以**不起开发服务器、预览服务器或任何常驻进程**：

1. `npm run build:web`。Vite 加 `vite-plugin-singlefile` 把 JS、CSS 全部内联，产物只有一个文件 `packages/web/dist/index.html`（`dist/` 不进仓库）。
2. 在 PC 浏览器里直接打开这个文件（双击，或者把 `file:///<仓库路径>/packages/web/dist/index.html` 贴进地址栏）。页面用 URL 的 `#` 部分做路由，从文件打开也能刷新、能前进后退。
3. 看手机竖屏：窗口宽于 760 时，页面顶上有一条原型工具条，点"手机竖屏 390"就把应用放进一个 390×844 的框里看；也可以用开发者工具的设备模式，或者直接把窗口拉窄。宽窄按内容区的实际宽度判断，600 以下是竖屏布局（底部 5 个 tab），以上是宽屏布局（左侧竖栏、内容区分栏）。
4. 原型里点按钮只改本地的假状态，刷新页面就回到初始的假数据。

04 号票起 UI 由经 LSM 启动的守护进程提供（同一份构建产物），演示走那条路。

### 目录

| 目录 | 是什么 |
|---|---|
| `src/state/` | **前端状态层**：把事件流归并成界面状态的纯函数，不依赖 React 和 DOM。见下文 |
| `src/app/` | 状态层接到 React（`store.tsx`）、前端连接接口（`connection.ts`）、`#` 路由（`route.ts`） |
| `src/model/` | 页面用的领域形状（看板、项目、待我处理、设置）、14 种卡片的负载和动作结果文字、中文标签 |
| `src/util/` | 和界面无关的小工具（时间格式、`nowIso`） |
| `src/ui/` | 共用部件：会话组件（`conversation/`，秘书和维护者共用一个）、卡片（`cards/`，入口是 `CardPanel`）、分栏和弹层（`common.tsx`）、页面底部的短提示（`toast.tsx`，`useToast()`） |
| `src/pages/` | 各页面：秘书、任务（看板 + 详情）、项目、待我处理、更多（消耗、设置各页）、配对等待页和批准页 |
| `src/prototype/` | **只属于原型**：假事件、假数据（名字和路径都是明显虚构的）、假连接（`fake-connection.ts`）、看板等假数据的本地状态（`proto-store.tsx`，跟着前端状态层里卡片的变化走，不认具体的连接）。接真数据的票逐步删掉这里的东西 |
| `src/styles/` | `base.css`（颜色 token、通用控件）、`layout.css`（tab、分栏、阶段抽屉）、`look.css`（视觉规矩）三份复制自 AgentSense 再裁剪；`pages.css` 是二狗自己的页面样式 |

### 前端状态层（`src/state/`）

- 输入（`UiInput`）两类：
  - 服务端推来的事件帧 `{channel, seq, type, payload}`。按频道记下最后收到的序号，重复或更旧的直接丢掉；
  - 本地动作：发消息（`send_message`）、点卡片按钮（`card_action`）、请求失败（`request_failed`）。
- 乐观显示：自己发的消息先显示在会话末尾（`pending`），收到带同一个幂等键的 `message` 事件后被替换；请求失败就标成失败。卡片按钮点了先是"处理中"，收到更高版本的 `card` 事件后变成权威状态。
- 对外只用 `reduce`、`replay`、`resumeCursors`（重连时带给服务端的序号）和选择器 `conversationView`、`selectCard`（返回 `CardState`：权威版本加本地还没结果的动作）。还没结果的请求统一用 `RequestStatus`（在路上 / 失败带错误）。
- **加新的事件类型**：在 `ui-state.ts` 的 `eventHandlers` 表里加一项（看板、待我处理、项目列表、活动状态这些频道由各自的票加）；不认识的类型只推进序号。
- 帧和消息的形状现在手写在 `src/state/protocol.ts`（按规格第 5 节）；04 号票在共享协议包里用 TypeBox 定义后，这个文件改成从 `@ergou/protocol` 取类型，测试不用改。
- 频道名（`CHANNELS`、`maintainerChannel`）、事件类型（`EVENT_TYPES`）、14 种卡片类型（`CARD_TYPES` / `CardType`，用 `isCardType` 收窄）、卡片动作名（`CARD_ACTIONS` / `CardAction`）都集中定义在 `protocol.ts`，别处不写字面量；06 号票的卡片类型注册表建在 `CARD_TYPES` 上。卡片的处理结果是结构化的 `outcome: { action, note? }`，显示成文字用 `model/cards.ts` 的 `outcomeLabel`。
- **幂等键**放在 `message` 事件的负载里（`{ message, idempotencyKey? }`），乐观显示的消息靠它被替换；04 号票落地正式协议时要保住这个字段。
- 状态层只许引用自己目录里的模块（`test/state/boundary.test.ts` 检查；04 号票起放行 `@ergou/protocol`），也不许用 DOM 和 Node 的全局量（`tsconfig.state.json` 不给这两类类型，`npm run typecheck` 会查）。

**回放测试**写在 `packages/web/test/state/`：手写一串事件帧和本地动作交给 `replay`，再用视图函数断言。`test/state/events.ts` 里有造帧、消息、卡片的小工具：

```ts
const state = replay([
  frame("secretary", 1, "message", { message: textMessage("m1", "agent", "早") }),
  { kind: "send_message", conversation: "secretary", idempotencyKey: "k1", parts: [{ type: "text", text: "在吗" }], time: "…" },
  frame("secretary", 2, "message", { message: textMessage("m2", "user", "在吗"), idempotencyKey: "k1" }),
]);
expect(conversationView(state, "secretary").map((it) => it.kind)).toEqual(["message", "message"]);
```

04 号票起换成主切面录下来的真实事件流回放。页面本身不单设测试切面，靠用户评审。

### 前端连接（`src/app/connection.ts`）

界面只通过 `Connection` 收发：`connect(cursors, deliver)` 连上后把事件帧和失败的请求都变成 `UiInput` 交给状态层；`sendMessage`、`cardAction` 发带幂等键的请求（卡片动作带期望版本）。连接只在 `App.tsx` 里注入一次（`StoreProvider` 的 `connection`）：原型是 `new FakeConnection()`，04 号票写 WebSocket 实现，换掉这一行即可，别处（包括原型的假数据）都不认具体的连接。

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

## 配置

- **数据目录**：环境变量 `ERGOU_DATA_DIR` 指定；不指定时是用户主目录下的 `.ergou`。
- **其余配置**：放在数据目录的 `config/ergou.json`，缺的项取默认值。可以从 `config/ergou.example.json` 复制一份开始。
- **端口**：`ports.local`（本机端口，只监听 127.0.0.1）默认 8810，`ports.external`（外网端口，隧道的目标）默认 8811。选定的依据见 01 号票的 Comments。监听在 04 号和 10 号票。
- **agent 子进程的环境**：系统变量白名单（PATH、SystemRoot、TEMP，以及 USERPROFILE、HOME、APPDATA、LOCALAPPDATA 这些用户目录类变量）加显式注入的变量，不继承守护进程的其他环境；模型 key 不走环境变量。见 `src/process/child-env.ts`、ADR-0004。

## 测试底座（`packages/daemon/test/helpers/`）

三个切面见规格 Testing Decisions。目前有的：

- `temp-dir.ts`：`makeTempDir()` 建一个临时目录，当前测试结束自动删除（必须在测试体内调用）。
- `daemon.ts`：
  - `startTestDaemon({ env })` 起一个守护进程实例，返回 `{ daemon, dataDir, homeDir }`，测试结束时停掉，Job 里残留的进程一起清掉。
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
  agentId: "secretary",
  model: fauxModel([{ kind: "reply", text: "你好" }]),
  tools: [],
});
await log.next("ready");
agent.send({ type: "user_input", inputId: "in-1", text: "在吗" });
expect((await log.next("message_final")).message.parts).toEqual([{ type: "text", text: "你好" }]);
expect((await log.next("turn_end")).outcome).toBe("completed");
```

**pi 契约测试**放在 `packages/daemon/test/contract/`，文件名 `*.contract.test.ts`。每条用例单独拉起一个子进程、接 faux provider，只验二狗依赖的 pi 行为。现有两个文件：

- `pi-session.contract.test.ts`：流式到定稿；会话不读用户目录和工作目录里的配置、skill、上下文文件和 CLI 认证。
- `guard-and-interject.contract.test.ts`：工具调用停在 `tool_call` 钩子里等守护进程判定，按判定执行或不执行；插话在下一次模型调用之前进入上下文。

后面的票按规格往这里加用例。

## 升级 pi

1. 用 npm 查最新稳定版：`npm view @earendil-works/pi-coding-agent dist-tags`，读四个包 CHANGELOG 里的 Breaking Changes。
2. 改版本号，所有 `@earendil-works/*` 一起改，都写精确版本：
   - `packages/daemon/package.json` 的 `dependencies`；
   - 根目录 `package.json` 的 `overrides`；
   - 看一眼新版本 `pi-coding-agent` 的依赖里有没有新的 `@earendil-works/*` 包，有就也加进 `overrides`。
3. `npm install`，确认 `npm ls --all | grep earendil` 全是同一个版本。
4. `npm run typecheck`（子进程的事件翻译对着 pi 的类型），再 `npm run test:contract`，最后 `npm test`。
