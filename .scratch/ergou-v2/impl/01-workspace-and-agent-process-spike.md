# 01 — 工作区骨架与 agent 子进程 spike

Status: done
Blocked by: 无，可以立即开始
Spec: [第一阶段规格](../spec.md) 第 1 节（工程与总体架构）、第 3 节（agent 子进程与 pi 封装层）、第 4 节（存储与事件）、第 6 节（访问与设备配对）、第 18 节（数据目录与备份）、Testing Decisions（pi 契约测试）、Further Notes（实现票）

## What to build

搭起二狗 v2 的地基：一个 npm workspaces 工作区，三个包（守护进程、Web、共享协议），装好精确锁定的 pi，配好 vitest 和 oxlint。做完后，守护进程能按配置找到数据目录，拉起一个 agent 子进程（里面是一个接 pi faux provider 的 pi 会话），把它放进二狗自建、不允许脱离的 Job 对象，送一条输入进去，收到逐段的流式回复和定稿消息；强杀守护进程，子进程和它起的孙进程一起消失。

这张票同时是一个 spike：验证 pi 的 RPC 模式（stdin/stdout JSON）能不能当守护进程和子进程之间的通信层；不合适就在子进程里用 SDK，自己写一层 stdio 上按行分帧的 JSON IPC。不管选哪种，都包在运行时封装层里，上层只看到"agent 宿主协议"。选定的方案决定第 3 节的通信层，后面所有和子进程打交道的票都建在它上面。

另外立起两样以后反复用到的东西：存储薄接口（先验证 `node:sqlite` 的 FTS5 trigram 分词器可用，不可用就换 better-sqlite3，换驱动只改这一层），以及 pi 契约测试（切面 3）的骨架，作为以后升级 pi 的闸门。

## Acceptance criteria

- [x] 工作区有守护进程、Web、共享协议三个包，声明 Node ≥22.19；从干净目录 `npm install` 后，根目录一条命令跑全部 vitest 测试、一条命令跑 oxlint。Web 包本票只是空壳（内容由 02 号票复制进来）。
- [x] pi 用 `@earendil-works/pi-coding-agent` 的 SDK，装在本工作区里（不用本机全局那份），取开工时的最新稳定版；所有 `@earendil-works/*` 包都写精确版本，并用 npm `overrides` 和 lockfile 锁住。有一道自动检查（lint 规则或测试）保证运行时封装层之外的代码不引用 `@earendil-works/*` 的类型。
- [x] 存储薄接口：能打开 WAL 模式的 SQLite 库；有一条测试建一张 FTS5 trigram 表、写入中文文本、用三个字以上的中文子串查到它。用 `node:sqlite` 时只屏蔽它那一条 ExperimentalWarning，其他警告照常输出；若 trigram 不可用则换成 better-sqlite3，改动只落在这一层。
- [x] 配置：数据目录路径从配置读（默认用户主目录下的 `.ergou`，不写死），测试一律用临时数据目录；仓库里只有示例配置，没有个人数据。本机端口和外网端口的端口号也从配置读，默认值由本票查过本机 Local Service Manager 已登记的端口后选定、写进示例配置（本票只定默认值，不开监听）。
- [x] spike 结论：对照第 3 节"agent 宿主协议"的全部消息类型，逐项核对两种方案能否承载——尤其是守卫判定请求要能让子进程里的这次工具调用停住、等守护进程回复（最长要等 5 分钟），插话要能在下一步之前插入，能拿到每次模型调用的用量。选定一种，把结论和理由写成一条决策记录。宿主协议的全部消息类型在封装层里定义好，本票没用到的先留着。
- [x] 守护进程能拉起一个接 faux provider 的子进程：收到"就绪"后送"用户输入"，按 faux 剧本收到若干"流式增量"、一条"消息定稿"和"回合结束和闲置"；"中止"能停住进行中的回合；"退出"让子进程正常结束。该子进程的 pi 会话 JSONL 写在数据目录的会话区。用临时数据目录跑的集成测试覆盖这一串。
- [x] Job 对象：子进程和它起的孙进程（测试里让子进程起一个）都在二狗自建的 Job 对象里，该 Job 对象不允许脱离；测试里强杀守护进程后，子进程和孙进程都不再存在。
- [x] 环境注入：拉起子进程时显式给出它需要的模型 key 和环境变量，不继承守护进程的环境。测试：在守护进程的环境里放一个哨兵变量，子进程里看不到。
- [x] pi 契约测试骨架：单独拉起一个 agent 子进程、接 faux provider，能用单独的一条命令跑（升级 pi 前先跑）。先有两条用例：输入 → 流式增量 → 定稿；会话用 `DefaultResourceLoader` 且 `noSkills: true`，不读 `~/.pi`、`~/.claude/skills` 和 CLI 认证（测试里往临时的用户主目录放一个 skill 和一份配置，断言都没被加载）。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 事件存储（频道、序号、幂等键、派生视图）和主切面的测试底座在 04 号票（规格 Further Notes 已按此写明），本票只做存储薄接口。`memory.db` 由 08 号票建，同样走这层薄接口。
- 本票不开任何监听端口：本机端口和网关在 04，外网端口在 10（10 号票按本票选定的默认端口号读配置）。
- 不在本票，各自由下列票做并往 pi 契约测试里加用例：agent 管家的子进程上限（满 8 个时新的唤起排队）、闲置退出、模型调用和工具调用超时、孤儿回收（12）；按工具包装配会话，即 `additionalSkillPaths`、工具白名单（27，在本票的"不读用户目录配置"之上扩展）；守卫转发 `tool_call`（07）；工具起的孙进程环境里剥掉密钥、秘书和联网关着的维护者跑脚本时设无效的代理地址（07，随 bash 工具一起做）；插话、压缩后注入（13）；用量（24）；压缩钩子和 `appendEntry`（18）；被杀后从会话文件恢复（23）。MCP 服务进程同样由守护进程拉起、放进本票的 Job 对象，在 27 号票做。
- 本票的守护进程只在自动测试里起：测试在临时数据目录里起的守护进程实例是测试的一部分，用完即销毁，不算服务，不在 LSM 登记。`ergou-daemon` 从 04 号票起在 LSM 登记（指向主分支的构建产物，开发期间的演示经 LSM 启动）；link 协议上报"忙"和 autoRestart 重启之后的恢复在 23 号票。按规格第 1 节和用户的约定，二狗的服务进程只能在 LSM 登记、由它启动，不要直接起常驻进程。
- 拉起子进程时"不继承守护进程的环境"在拆分清单里没有单列，随本票一起做，因为子进程就是在这里拉起的。
- Job 对象是 Windows 的机制；守护进程被杀时全部子进程一起清掉，是第 17 节恢复规则的前提。

## Comments

2026-10-07 实现时定下的几处（规格没写死、又必须定的，取最保守、最贴近规格的做法）：

- **pi 版本**：开工时 npm 上 `@earendil-works/pi-coding-agent` 的 `latest` 是 **1.0.4**（2026-10-05 发布）。`pi-ai`、`pi-agent-core`、`pi-tui`、`pi-mcp`、`pi-codemode`、`pi-telemetry`、`chord` 也都锁在 1.0.4：守护进程包里写精确版本，根目录 `overrides` 统一压住，`package-lock.json` 入库。
- **spike 结论**：选 SDK + 自定义 IPC，不用 RPC 模式，逐项核对写在 ADR-0004。
  - RPC 模式的一次性探针能承载输入、中止、用量；守卫等待也能借扩展 UI 子协议凑出来，但只实测过等 1.5 秒。启动装配（`DefaultResourceLoader`）、模型 key、工单、范围审视、就绪、心跳都要绕路，守护进程还得直接解析 pi 的事件形状。
  - 选中方案的实测依据入库成了 pi 契约测试（`test/contract/guard-and-interject.contract.test.ts`）：工具调用停在 `tool_call` 钩子里等守护进程隔 2 秒送回的判定，等待期间不执行，按判定执行或不执行；插话在下一次模型调用之前进入上下文。
- **默认端口**：本机端口 **8810**，外网端口 **8811**，写在 `config/ergou.example.json` 和代码默认值里。依据：
  - LSM 里已登记的端口有 3080、3081、7331、7332、7420（LSM 自己）、7500、7999、8080（vibecraft，另隐含占用 8081）、8090、8770、8787、8788、8795、8797、8799；
  - 2026-10-07 当时正在监听的还有 8710 等。8810 和 8811 都没被占用。
  - 隧道在 VPS 上的远端端口不归本票，按现有惯例将来可以用 18811（已登记的远端端口有 17500、18080–18084、18770、18790、18797、18799）。
- **数据目录"从配置读"的落法**：
  - 数据目录本身由环境变量 `ERGOU_DATA_DIR` 指定，不指定时取 `os.homedir()` 下的 `.ergou`。04 号票在 LSM 条目里设这个变量即可。
  - 其余配置在数据目录里的 `config/ergou.json`（规格第 2 节"读取数据目录里的配置"）。
  - 没有另设一份"引导配置文件"。
- **模型 key 不走环境变量**：经 stdin 的 `start.credentials` 送进 pi 的内存凭据（`setRuntimeApiKey`）。子进程的环境由系统变量白名单（PATH、SystemRoot、TEMP、USERPROFILE 等）加显式给出的变量构成，另固定加 `PI_OFFLINE=1`、`PI_TELEMETRY=0`。这样 07 号票"孙进程环境里剥掉密钥"时，环境里本来就没有模型 key；LSM 注入守护进程的密钥也不会漏下去（测试覆盖了这一点）。
  - 白名单里有用户目录类变量（`USERPROFILE`、`HOME`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`），生产环境里 agent 知道真实主目录在哪。07 号票做路径围栏要考虑这一点。
  - 测试里起的守护进程把这些变量都换成临时目录（`test/helpers/user-profile.ts`），测试里的子进程看不到真实用户主目录；有一条测试专门验这一点。
- **pi 的全局目录**：`agentDir` 指向数据目录临时区下的 `tmp/pi-agent`（空目录），不用 `~/.pi/agent`。设置用 `SettingsManager.inMemory`，凭据用 `InMemoryCredentialStore`，不读 `models.json`，不联网刷新模型目录。
- **Job 对象**：
  - 用 koffi（预编译 FFI，3.3.2）调 kernel32，不另写辅助程序。
  - 每个守护进程实例建一个 Job，`KILL_ON_JOB_CLOSE`，不设任何脱离标志，句柄不可继承；`daemon.stop()` 关掉它。
  - 守护进程把子进程放进 Job 之后才送 `start`；子进程收到 `start` 之前不做任何事。
  - 实测发现：Node（libuv）会先把每个子进程放进父进程私有的 Job，那个 Job 允许悄悄脱离；二狗的 Job 嵌在它下面，靠"不允许脱离"把 bash 起的孙进程和孤儿进程留住。测试里放开脱离，这两个进程就活了下来，说明测试是有效的。
  - 嵌套情况的测试：先把守护进程放进一个外层 Job（模拟 LSM），再让它拉起子进程。
- **被强杀的"守护进程"**：`ergou-daemon` 的入口（`main.ts`、监听端口）在 04 号票。本票 Job 测试里被强杀的是一个测试夹具进程（`test/fixtures/daemon-host.ts`），它调用真实的 `startDaemon()`，不另起炉灶。
- **"不引用 pi 类型"的自动检查**用测试实现（`test/pi-boundary.test.ts`，扫全部包的源码和测试），没用 lint 规则：测试连 `typeof import(...)` 这种写法也能抓到。规则有三条，并带一组反例验证检查本身有效：
  - 只有 `runtime/agent-child/` 能引用 `@earendil-works/*`，`runtime/` 的其余文件也不行；
  - 任何地方都不许转导出 pi 的东西（`export ... from "@earendil-works/..."`，或把从 pi 导入的名字原样 `export`）；
  - `agent-child/` 之外不许 import 它里面的模块。
- **宿主协议的几处约定**：
  - `turn_end` 对应 pi 的 `agent_settled`；
  - 定稿消息的停止原因用二狗自己的词（`done`、`tool_calls`、`max_tokens`、`aborted`、`error`），由子进程从 pi 的值翻译；
  - `ready` 带上实际装配进会话的资源清单（工具、skill、上下文文件、扩展、有凭据的 provider），契约测试据此核对；
  - 守卫转发由装配参数 `forwardToolCalls` 打开，本票默认关，只为验证通路。07 号票接上守卫后所有会话都开，并在守护进程一侧管 5 分钟超时和挂起；
  - `interject` 已实现（13 号票接守护进程一侧）；
  - 还没实现的命令（`work_order`）回 `unsupported` 错误，不崩溃；
  - 回合中途再送输入回 `busy`，输入排队由守护进程负责。
- **faux 剧本在子进程里**：faux provider 的支持写在子进程的正式代码里，由 `start` 里的模型参数 `{ kind: "faux", script }` 打开。这是让测试跨进程驱动 pi 的唯一办法，只在模型参数显式要求时生效。
- **契约测试里的对照组**：隔离用例加了一个"显式列出的 skill 能被加载、被模型看到"的对照，否则"看不到"的断言可能是空话。27 号票做工具包装配时，可以在这条基础上扩展。
- **没有构建步骤**：源码靠 Node 22 的类型剥离直接跑，子进程入口按本文件的扩展名找（`.ts` 或将来的 `.js`）。04 号票在 LSM 登记时要定：是直接 `node packages/daemon/src/main.ts`，还是加一步 `tsc` 构建（`tsconfig.base.json` 已开 `rewriteRelativeImportExtensions`）。
- **工具链版本**：TypeScript 7.0.2（原生版）、vitest 5.0.3、oxlint 1.87.0、@types/node 22.20.5，都是开工时的最新版，各包类型检查和测试都正常。

- 2026-10-07 完成：经两轴代码评审（规范、规格）并按评审意见修改后合并进 main（da8c925）。pi 锁定 1.0.4；通信层选 SDK + 自定义 IPC（ADR-0004）；默认端口 8810 / 8811。
