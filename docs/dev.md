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

守护进程包里还有 `npm run test:unit -w @ergou/daemon`（不含契约测试）和 `npm run test:contract -w @ergou/daemon`。

## 工作区

```
packages/
  protocol/   @ergou/protocol  守护进程和前端共用的协议类型（04 号票起用 TypeBox）
  daemon/     @ergou/daemon    守护进程：管家，拉起和管理 agent 子进程
  web/        @ergou/web       Web UI（空壳，02 号票从 AgentSense 复制进来）
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
| `runtime/` | **运行时封装层**，pi 只出现在这里（ADR-0001、ADR-0004）。`host-protocol.ts` 是 agent 宿主协议，`agent-process.ts` 是守护进程侧句柄，`agent-child/` 是子进程（里面跑 pi SDK）。上层只从 `runtime/index.ts` 取东西 |

## 写代码的约定

- **类型剥离的限制**：
  - 相对导入写 `.ts` 后缀；
  - 只用可擦除的语法：不用 `enum`、`namespace`、构造函数参数属性；
  - 纯类型导入写 `import type`。
  - `tsconfig.base.json` 里的 `erasableSyntaxOnly`、`verbatimModuleSyntax` 会帮你检查。
- **pi 的边界**：`@earendil-works/*` 只能在 `packages/daemon/src/runtime/` 里引用。`test/pi-boundary.test.ts` 会扫全部源码和测试，越界就红。
- **个人数据和密钥永不进仓库**：数据目录从配置读，测试一律用临时目录。不要读、不要打印用户主目录下 `.ergou`、`.ssh` 等真实数据。
- 标识符用英文，注释用中文；领域概念用 `CONTEXT.md` 里的词。

## 配置

- **数据目录**：环境变量 `ERGOU_DATA_DIR` 指定；不指定时是用户主目录下的 `.ergou`。
- **其余配置**：放在数据目录的 `config/ergou.json`，缺的项取默认值。可以从 `config/ergou.example.json` 复制一份开始。
- **端口**：`ports.local`（本机端口，只监听 127.0.0.1）默认 8810，`ports.external`（外网端口，隧道的目标）默认 8811。这两个是 2026-10-07 查过本机 LSM 已登记的端口后选的。本票只定默认值，监听在 04 号和 10 号票。

## 测试底座（`packages/daemon/test/helpers/`）

三个切面见规格 Testing Decisions。目前有的：

- `temp-dir.ts`：`makeTempDir()` 建一个临时目录，当前测试结束自动删除（必须在测试体内调用）。
- `daemon.ts`：
  - `startTestDaemon({ env })` 在临时数据目录和临时主目录里起一个守护进程实例，测试结束时停掉，Job 里残留的进程一起清掉；
  - `spawnTestAgent(daemon, request)` 拉起一个 agent，返回 `{ agent, log }`，测试结束时先结束子进程；
  - `fauxModel(script, { tokensPerSecond })` 造一个按剧本回话的 faux 模型，不连网。剧本每一步对应一次模型调用：`{ kind: "reply", text?, thinking?, toolCalls? }`，或 `{ kind: "echo_context" }`（把模型看到的系统提示和工具原样回出来）。
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

**pi 契约测试**放在 `packages/daemon/test/contract/`，文件名 `*.contract.test.ts`。每条用例单独拉起一个子进程、接 faux provider，只验二狗依赖的 pi 行为。后面的票按规格往这里加用例。

## 升级 pi

1. 用 npm 查最新稳定版：`npm view @earendil-works/pi-coding-agent dist-tags`，读四个包 CHANGELOG 里的 Breaking Changes。
2. 改版本号，所有 `@earendil-works/*` 一起改，都写精确版本：
   - `packages/daemon/package.json` 的 `dependencies`；
   - 根目录 `package.json` 的 `overrides`；
   - 看一眼新版本 `pi-coding-agent` 的依赖里有没有新的 `@earendil-works/*` 包，有就也加进 `overrides`。
3. `npm install`，确认 `npm ls --all | grep earendil` 全是同一个版本。
4. `npm run typecheck`（子进程的事件翻译对着 pi 的类型），再 `npm run test:contract`，最后 `npm test`。
