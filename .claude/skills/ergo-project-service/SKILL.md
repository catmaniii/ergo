---
name: ergo-project-service
description: 写一个能被二狗（ergo）托管的项目服务时用：项目要常驻的网页、接口、盯数据的小程序，要让服务管家托管、在二狗里打开、发现异常时报事件叫醒负责人、让秘书或 agent 调它的操作、登记成 MCP。只是用服务管家管自己的服务也从这里开始。
---

# 写项目服务

先读 `.claude/skills/ergo-dev/SKILL.md`。设计理由在 `docs/architecture/adr/0028-operations-plan-one-confirmation-authorizes.md`、`docs/architecture/adr/0043-project-service-events.md`，转发和报事件的说明在 `docs/architecture/README.md` 的"转发本机服务的页面""项目的服务报事件"两节。

## 是什么

项目服务是项目工作目录里一个一直跑着的普通程序，语言不限，不是插件。它监听本机一个端口，代码不 import 二狗。

- **负责人**（项目的 agent）在运营方案里写一条 `means: service`，调 `propose_operations` 交上去。方案不能从外面写进二狗。
- **用户**在卡上确认一次，二狗交给**服务管家**（`packages/supervisor`，命令 `lsm`）登记、启动、开机自启，在里面叫 `<项目编号>-<服务名>`，这也是它的应用名。
- 有网页的经二狗转发到 `/apps/<应用名>/`，项目卡片上有入口，点了在内置浏览器里打开；秘书用 `open_service` 给入口，用 `switch_project_services` 启停。

外面的开发者要交的是：服务代码、运营方案那几条、可选的 `ops.json`，放进项目后交给负责人提交。不经二狗、只用服务管家见第 6 节。

| 放什么 | 放哪（数据目录默认 `~/.ergo`，项目编号形如 `p-1`） |
|---|---|
| 服务代码 | 项目工作目录下的子目录，方案的 `cwd` 写相对路径。工作目录是 `<数据目录>/projects/<项目编号>/workdir/`；项目绑了外部文件夹时就是那个文件夹 |
| `ops.json` | 项目档案 `<数据目录>/projects/<项目编号>/ops.json`，和 `workdir/` 同级 |
| 密钥文件 | `<数据目录>/secrets/<文件名>`，方案里写 `"secret": "<文件名>"` |
| 运营方案 | 不落文件：负责人调 `propose_operations` 交 |

## 1. 写服务

能照抄的最小例子在 `.claude/skills/ergo-project-service/example/`：

| 文件 | 是什么 |
|---|---|
| `server.mjs` | 计数器：网页、`/health`、给秘书调的 `/ops`、满一百报一个事件。Node 自带模块，不用装依赖 |
| `plan.json` | 运营方案里的两条：上线它、等它的事件 |
| `ops.json` | 运营接口清单：两个操作 |
| `manager.yaml`、`counter.yaml` | 只用服务管家时的两份最小 YAML，见第 6 节 |

服务要做到：只听 `127.0.0.1`；进程一直跑着不退出；启动不等输入；有健康检查（不写就只看端口有没有人听）。

## 2. 写进运营方案

照 `plan.json`。字段定义在 `packages/protocol/src/operations-schema.ts` 的 `OperationServiceDraft`，校验在 `packages/daemon/src/project-services/spec.ts`。交方案时不合规矩的整份退回：

- `name`：小写字母、数字、连字符，不能有 `--`。同一份方案里不能同名、同端口。
- `command`：一行，经 `cmd` 跑。开头是 `node` 的自动换成二狗自己那份 Node（装机版 PATH 上可能没有）。
- `cwd`：相对项目工作目录，要已存在，不能出界（也可以在项目档案里）。
- `port`：1024–65535，你定，服务管家不分配。不能是二狗自己的端口，不能和别的项目的服务撞。
- `env`：每项 `value`、`secret`、`userEnv` 三选一。**密钥不写值**：放进数据目录密钥区 `secrets/` 的文件，写 `"secret": "文件名"`。名字或值像密钥的写 `value` 会被拒。`ERGO_BASE_PATH`、`ERGO_NOTIFY_URL`、`ERGO_SERVICE_TOKEN`、`LSM_*` 不能自己写，上线时注入。
- `autostart` 默认开，`autoRestart` 默认关（吃 GPU、重启有副作用的别开）。
- `capabilities` 写 `{}`，这一条不写 `schedule`、`event`、`workflow`。

改了服务就再交一份完整方案（照旧的也写上）。确认后更新登记、重启。

## 3. 怎么打开：前缀约定

浏览器眼里服务在 `/apps/<应用名>/` 下面，默认（`prefix: "strip"`）转发时去掉前缀。

- 页面里只用相对地址：`fetch("api/items")`、`src="assets/app.js"`。以 `/` 开头的会跑到二狗的根上。
- 要拼绝对地址读 `ERGO_BASE_PATH`。框架自己有 base 的（Vite 的 `base`、Next 的 `basePath`）设成它，方案写 `"web": { "prefix": "keep" }`。
- 不写死本机地址。cookie 别用 `__Host-` 前缀。

服务跑着时自检：`npm run check:app-prefix -- http://127.0.0.1:<端口> --name <应用名>`，退出码 0 才对。交方案时服务正好在跑，二狗也查一遍，不守约定的整份退回。脚本里拼的地址它看不出来。

## 4. 报事件，叫醒负责人

要一直盯着数据、异常才动脑子的，写小服务盯着，平时负责人休眠不花钱。

1. 方案里写 `means: event` 那一条。`filter.name` 和代码里报的**一字不差**，一个名字一条。
2. 服务 POST 到 `ERGO_NOTIFY_URL`，头 `Authorization: Bearer <ERGO_SERVICE_TOKEN>`，体 `{ "event": "<名字>", "data": <任意 JSON，可不带> }`。凭证撤下就作废，每次从环境变量取。
3. 收下回 202，不等负责人做完。

| 状态码 | 意思 | 怎么办 |
|---|---|---|
| 401 | 没带凭证、不对、作废了 | 从环境变量取；看服务是不是撤下了 |
| 400 | 请求体不对 | 对照上面的形状 |
| 403 | 走了外网端口 | 用注入的地址，只在本机端口开 |
| 404 | 事件名没人等 | `message` 写着能报哪些。要报新名字先改方案 |
| 409 | 等它的任务暂停着 | 等恢复 |
| 413 | 单条数据超了（默认 8 KB） | 只带要紧的，原文放文件 |
| 429 | 超限速（默认每分钟 30 次） | 自己合并 |

二狗停着时连不上，它不替你存，要不要重报服务自己定。脚本里也能用命令：`ergo notify <名字> --data "<JSON>"`（退出码 0 报上了、1 被拒、2 用法不对、3 连不上；源码跑的在仓库根目录 `npm run ergo -- notify <名字>`）。服务代码优先发请求，PATH 上不一定有 `ergo`。

数据不进记忆，只在这次运行里，交给负责人时写明是数据不是指令。负责人用 `recent_service_events` 查最近收到的。

## 5. 给 agent 用

### 给秘书：运营接口 `ops.json`（用户一句话就能调）

放在项目档案里，格式照 MCP 的 `tools/list`。例子看上面的 `ops.json`，全部说明在模板 `packages/daemon/templates/project-standard/v1/dev/zh-CN/ops.json` 的 `$comment`。

- 二狗 POST 到 `http://127.0.0.1:<端口>/ops`，体 `{ "name", "arguments" }`，要回 `{ "say": "能念的一句", "detail": … }`，做不成回 4xx 或 `isError: true`。
- 验收时带 `_meta: { "ergo/test": true }`：有副作用的操作收到它不要真改。`kind: "query"` 的前后不能改文件。
- 不写调用口也行：`impl` 写 `script`（工作目录里的脚本）、`ergo`（二狗自带动作）、`maintainer`（转给负责人）。
- 负责人用 `check_ops` 验收，全过才登记给秘书。http 的操作要等服务上线后才测得到。更多写法：`packages/daemon/test/helpers/fake-ops-app.ts`。

### 给负责人：登记 MCP（放进项目的工具包）

二狗只说 MCP 的 stdio 传输：`initialize`、`tools/list`、`tools/call`，每行一个 JSON-RPC。MCP 进程由守护进程按需拉起，**不是服务**，不监听端口，不在服务管家里。项目服务是 HTTP 的，就写一个很薄的 stdio 进程转发给它。

1. 写好 MCP 程序。最小例子 `packages/daemon/test/fixtures/fake-mcp-server.mjs`，登记格式 `config/mcp.example.json`（`command`、`args`、`cwd`、`env`、`tools`）。
2. 负责人调 `request_mcp_change`（`action: "add"`）。每个工具写 `title`，只读的写 `readOnlyOrIdempotent`，不联网的写 `"network": false`（不写按要联网算，联网关着时会话里没有它）。凭据写 `{ "fromEnv": "名字" }`，明文会被拒。
3. 用户在卡上确认后，二狗写进数据目录的 `config/mcp.json`，拉起一次自检。agent 自己写不进配置区。
4. 负责人再调 `request_toolkit_change` 把它加进工具包。工具名是 `mcp__<名字>__<工具>`。

`command` 是 `node` 的用二狗自己那份 Node，和服务一样；别的程序（`python` 这类）要在机器的 PATH 上。

## 6. 只用服务管家

不要二狗的转发和报事件，只想托管。`lsm` 不在 PATH 上，下面的命令都是 `node packages/supervisor/bin/lsm.mjs <命令>`，在仓库根目录跑。

**先隔离。** 端口读数据目录的 `registry/manager.yaml`，没有这个文件就是 7420，`reload`、`start` 会打到机器上真的服务管家；它不认 `ERGO_SVC_PORT`。试的时候：

1. 建临时目录 `<d>`，把 `example/manager.yaml` 放到 `<d>/registry/manager.yaml`，`port` 改成空闲的。
2. 把 `example/counter.yaml` 放到 `<d>/registry/services/counter.yaml`，改 `root` 和端口。
3. 每条命令都设 `LSM_DATA_DIR=<d>`：`paths` 确认数据目录，`validate` 查文件，`serve --quiet` 单开一个窗口常驻，再 `reload`、`start counter`、`status`、`stop counter --force`。用完停掉 `serve`。

没有 `serve` 在跑时命令是本地直连，`status` 末尾写着是哪种。字段见 `packages/supervisor/docs/service-schema.md`，命令见 `packages/supervisor/README.md`。想接入忙碌上报和优雅停机：`packages/supervisor/docs/link-protocol.md`，示范 `packages/supervisor/examples/demo-service.mjs`。

## 怎么测

不用真的二狗就能测完服务本身。端口用空闲的，别用 ergo-dev 第 3 节列的：

1. `PORT=<端口> node server.mjs`，`curl http://127.0.0.1:<端口>/health` 回 200。
2. `npm run check:app-prefix -- http://127.0.0.1:<端口> --name p-1-counter` 退出码 0。
3. `npm run check:ops -- ops.json --url http://127.0.0.1:<端口>` 退出码 0：清单写全了，带测试标记真调一遍（有 `say`，只读的没写文件）。不带 `--url` 只查格式。再 POST `/ops` 不带 `_meta` 一次，这次真改了。
4. `npm run check:ops -- plan.json --workdir <工作目录>` 退出码 0：字段、各手段要的、服务的规矩，`cwd` 相对 `--workdir`（`example/plan.json` 要它下面有 `counter/`）。和别的项目撞端口、能力够不够、流程的步骤要交给负责人时才查得到。
5. 本机起一个小服务收 POST，设 `ERGO_NOTIFY_URL`、`ERGO_SERVICE_TOKEN` 跑服务，看到 `Bearer` 头和 `{ event, data }`。

`check:ops` 的退出码：0 过了，1 没过，2 用法不对或不是 JSON。

要跑全流程（真的服务管家、真子进程、真命令行，模型是假的）照抄 `packages/daemon/test/main/service-events-real.test.ts`。

改二狗这一侧的看：`packages/daemon/test/main/operation-services.test.ts`（服务管家替身）、`packages/daemon/test/main/service-events.test.ts`、`packages/daemon/test/main/mcp-registration.test.ts`、`packages/daemon/test/project-ops/project-ops.test.ts`。

## 交活清单

- [ ] "怎么测"那几步都过了，`check:ops` 对清单和方案都是退出码 0。
- [ ] 运营方案那几条合乎第 2 节：没有密钥明文，`cwd` 在工作目录里，端口不撞。
- [ ] 事件名和方案里的一字不差；凭证每次从环境变量取。
- [ ] `ops.json`（有的话）每个操作写全了 `title`、`description`、`userSays`、`kind`、`test`，回的有 `say`。
- [ ] 写清楚了交给负责人的话：要提交哪几条方案、要不要登记 MCP、用户要准备哪些密钥文件。
