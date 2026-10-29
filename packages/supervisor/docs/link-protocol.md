# 接入协议 v1

语言无关。项目实现它即成为 `linked` 服务。
接入之后还可以经它管理**自己名下的服务**（§7）。

## 0. 铁律

**没有注入身份时，接入层静默跳过，服务照常独立运行。**
接入层不得成为项目的启动依赖——管理器没跑、连不上、协议版本不匹配，一律降级为「不接入」，
绝不阻止服务启动、绝不抛错终止进程。否则没人敢接入。

## 1. 身份注入

管理器 spawn 服务时注入四个环境变量：

| 变量 | 含义 |
|---|---|
| `LSM_URL` | 管理器接入端点，如 `ws://127.0.0.1:7420/link` |
| `LSM_SERVICE_ID` | 该服务在注册表里的 id，如 `web-server` |
| `LSM_TOKEN` | 本次启动生成的一次性令牌，有效期 = 该服务实例的生命周期 |
| `LSM_PROTOCOL` | 协议版本，v1 |

四个缺任何一个 → 视为未注入 → 不接入。

## 2. 传输

WebSocket，项目**出站**连接 `LSM_URL`，`Authorization: Bearer <LSM_TOKEN>`。
消息为 JSON 单行。断线由项目侧指数退避重连（1s → 30s 封顶，无限重试）——
管理器重启时所有 linked 服务会自动重连，这是重认领（按 PID + 启动时间 + 端口把上次留下的服务认回来）之外的第二条恢复路径。

## 3. 消息

### 项目 → 管理器

```jsonc
// 握手，连上后立即发
{"type":"hello","serviceId":"web-server","pid":22452,"port":8799,
 "version":"1.4.2","protocol":1,
 "capabilities":["stop","restart","busy","health"],   // 没有的能力就不列，WebUI 据此灰显
 "logs":["tmp/server.log"],
 "features":["services"]}                             // 可选：我会用名下的服务，接入时请推一次全量状态（§7）

// 心跳，每 5s
{"type":"heartbeat","ts":1755900000,
 "health":"ok",                       // ok | degraded | failing
 "busy":true,"busyReason":"正在合成第 3 段语音",
 "detail":{"queue":2}}                // 可选，WebUI 原样展示

// 对指令的应答
{"type":"ack","id":"cmd-17","ok":true}
{"type":"ack","id":"cmd-17","ok":false,"error":"停机被拒绝：正在写入分镜"}

// 主动退出前（可选，但强烈建议）
{"type":"bye","reason":"shutdown-complete"}
```

### 管理器 → 项目

```jsonc
{"type":"welcome","sessionId":"s-91","heartbeatIntervalMs":5000,
 "features":["services"]}                                  // 管理器支持哪些扩展（§7）；老管理器没有这个字段
{"type":"conflict","reason":"该 serviceId 已有活跃会话"}   // 收到后项目应自行退出
{"type":"stop","id":"cmd-17","mode":"now","deadlineMs":60000}
{"type":"stop","id":"cmd-18","mode":"when-idle","deadlineMs":600000}
{"type":"restart","id":"cmd-19","mode":"when-idle","deadlineMs":600000}
{"type":"cancel","id":"cmd-21"}                            // 撤销挂起的 when-idle 停机
{"type":"ping","id":"cmd-20"}
```

## 4. 停机时序

```
管理器 --stop{mode,deadline}--> 项目
项目 --ack{ok:true}--> 管理器            (立即应答，表示收到，不表示已停)
项目 执行自己的 onShutdown 回调           (落盘、drain、等 busy 结束——领域知识在这里)
项目 --bye--> 管理器
项目 自行退出进程
管理器 观察到：连接断开 + 端口消失         => STOPPED
```

- `mode: "now"`：立即执行 onShutdown，不等 busy。
- `mode: "when-idle"`：busy 为 true 时挂起，等它转 false 再执行。管理器 UI 显示「待停机（等待空闲）」
  并提供取消。原来写在项目重启脚本里的「等任务空闲再重启」，在协议里就是这个模式。
- **`mode: "now"` 超过 `deadlineMs` 仍未退出** → 管理器 `taskkill /T /F` 兜底 → 仍在则 FAILED。
- **`mode: "when-idle"` 永远不会被强杀**。服务 ack 之后就进入「待停机」状态，忙多久等多久
  （默认上限 1 小时，只用于停止空等，到点也只是放弃等待、服务照常运行）。
  用 when-idle 就是为了不丢正在进行的工作，用普通停机超时去卡它再强杀，等于毁掉这个模式
  存在的理由（2026-08-23 实测踩到过，已修）。要立刻停请显式用强制停止：
  管理器改发 `mode: "now"`（覆盖排队中的 when-idle），给 `min(钩子 timeoutMs, 10 秒)` 收尾，过了就 `taskkill /T /F`。
  这是人在卡片上点了、再确认过的，不是管理器自己的决定（2026-10-13，一个服务忙着长任务停不下来）。
- 反悔用 `cancel`：管理器和服务两边都要撤销，否则服务空闲时还是会自己退。
- 项目可以 `ack{ok:false}` **拒绝**停机并给出理由，管理器如实展示，不强杀（除非你在 UI 上点强制）。

## 5. 心跳与降级

- 管理器 15s（3 个心跳周期）未收到心跳 → **不判定服务已死**，只把探活档位从 `linked` 降级回
  `port` / `health`，继续用原有方式探活，并在 UI 上标注「接入层已断，观测精度下降」。
  接入层坏掉不等于服务坏掉，这两件事必须分开。
- `health` 字段来自服务自报，与管理器的 HTTP 探活可以并存、互为交叉验证；两者矛盾时 UI 同时显示。
- `busy` 与 health 正交：一个忙碌的服务是完全健康的。

## 6. 重复实例

`hello` 带的 `serviceId` 已有活跃会话 → 管理器回 `conflict` 并在 UI 告警「检测到重复启动」。
项目收到 `conflict` 应立即退出，避免两个实例抢同一端口。

## 7. 名下的服务（2026-10-18）

接入的项目可以让管理器替它**登记、启停、设开机自启、撤销它名下的服务**，并收到这些服务的状态推送。
典型用法：ergo（二狗）的守护进程 `ergo-daemon` 把做完的项目转成一个服务上线，服务由管理器托管、由管理器启动。

### 7.1 兼容：还是 v1，不升版本号

- 只**加**消息，`LSM_PROTOCOL` 仍是 `1`。现有客户端见到不是 1 就整个不接入，升版本号等于让所有老服务静默掉线。
- 管理器在 `welcome.features` 里声明支持（`"services"`）。客户端没在 welcome 里看到它，就当这个管理器不支持——
  别发，发了也不会有回复（老管理器对不认识的消息一律不理）。
- 老项目不发这些消息就毫无影响：除了 welcome 里多一个它不认识的 `features` 字段，什么都不会多收。
  状态推送只发给 `hello.features` 里带了 `"services"` 的、或者名下真有服务的项目。

### 7.2 谁能发、能碰谁

- **只有已经接入、会话有效的项目**：令牌在升级时验过；没 `hello` 就发 → `not-linked`。
- **命名空间**：名下的服务 id = `<登记方 serviceId>--<名字>`，比如 `ergo-daemon--p-1-web`。
  请求里的 `name` 写短名（`p-1-web`）或全名都行；带 `--` 却不是自己的前缀 → `not-owner`。
  短名只会落进自己的命名空间，所以手写在注册表里的服务、别的登记方名下的服务**一概碰不到**。
- **名字**：小写字母、数字、连字符，1–48 个字符，首尾不能是连字符，不能含 `--`。
- **名下只有一层**：登记方必须是注册表顶层的服务；名下的服务自己接入了也不能再登记服务（`not-allowed`）。

### 7.3 请求（项目 → 管理器）

每条请求都带 `id`（项目自己编，回复原样带回）。同一个服务的请求按到达顺序一次处理一个。

```jsonc
{"type":"services.put","id":"q-1","service":{ /* 服务定义，见 7.4 */ }}   // 登记或更新（整份替换）
{"type":"services.start","id":"q-2","name":"p-1-web"}                     // 等到就绪（或失败）才回
{"type":"services.stop","id":"q-3","name":"p-1-web","force":false,"mode":"now"}
{"type":"services.restart","id":"q-4","name":"p-1-web","force":false}
{"type":"services.autostart","id":"q-5","name":"p-1-web","on":true}       // 开机自启名单，不起停任何东西
{"type":"services.remove","id":"q-6","name":"p-1-web"}                    // 撤销：先停，再拿掉登记
{"type":"services.list","id":"q-7"}
```

- `put`：同一份定义反复发**不会**重写注册表（回复 `changed:false`），登记方可以放心地整份同步。
  服务在跑时改了命令 / 目录 / 环境 / 接入，回复 `restartNeeded:true`——管理器不自己重启，由登记方决定什么时候 `restart`。
  **在跑的时候不能改端口**（`running`）：新端口上没人听会被判挂，老端口上的进程从此没人认。先 `stop` 再登记。
  定义里带 `autostart` 时顺手设开机自启；不带就不动。
- `stop` / `restart`：服务**没有停机能力**（定义里没给 `stop.command`、也没接入）时，不带 `force:true` 一律 `no-capability`——
  管理器不替它装出一个优雅停机。`force:true` = 强制停止：有停机能力的按 `now` 停、10 秒没停下杀进程树；
  没有的直接杀进程树（和 WebUI 的「强制停止」完全一样）。没在跑时的 `restart` 就是 `start`。
  `mode:"when-idle"` 只对接入了的服务有意义（§4）。
- `remove`：= 强制停止 + 确认端口真的空了 + 从开机自启名单、注册表、账本里拿掉。
  还被别的服务依赖、或者你在 WebUI 上给它开了公网隧道 / tailnet 入口时拒绝（`in-use`），先撤掉那些。
  停不下来也拒绝（`failed`），登记留着、照常归管理器管——绝不留一个没人管的进程占着端口。

### 7.4 服务定义（`services.put` 的 `service`）

是 `service-schema.md` 的一个子集，字段意思一样。**不认识的字段直接拒**（拼错的字段不能被悄悄忽略）。

```jsonc
{
  "name": "p-1-web",                 // 必填：名字（7.2）
  "title": "示例站点",                  // 可选：显示名（注册表的 name），最多 80 字
  "project": "p-1",                  // 可选：所属项目（显示用），默认登记方的 project
  "command": "node server.mjs",      // command（字符串，经 cmd）和 argv（数组，参数原样）二选一
  // "argv": ["node", "server.mjs"], //   argv 里不能有 " % 换行
  "cwd": "D:\\work\\p-1",            // 必填：工作目录，绝对路径，必须存在（注册表的 root）
  "port": 8899,                      // 必填：端口是身份，由你给、管理器不分配
  "env": [                           // 可选：和注册表的 env 一样只写来源
    {"name": "PORT", "from": "literal", "value": "8899"},
    {"name": "OPENAI_API_KEY", "from": "file", "path": ".secrets/openai.txt"},   // 密钥只能 file / userEnv
    {"name": "HF_HOME", "from": "userEnv", "optional": true}
  ],
  "health": {"path": "/health", "timeoutMs": 3000},   // 可选：管理器去打 http://127.0.0.1:<port><path>
  "autostart": true,                 // 可选：开机自启，不写不动
  "autoRestart": false,              // 可选：挂了自动重拉，默认关
  "readyTimeoutMs": 60000,           // 可选：启动后等就绪的上限，1000–600000
  "link": false,                     // 可选：服务自己用接入层客户端 → linked 档，停机 / 忙碌走协议
  "stop": {"command": "node stop.mjs", "timeoutMs": 60000},   // 可选：停机命令；没有就没有 stop 能力
  "logs": [{"path": "tmp/server.log", "label": "server"}]     // 可选：管理器只 tail，不采集
}
```

校验规则：

- 照注册表的规矩校验——和加载注册表用的是**同一个函数**，写进去之后不会才发现坏了；写进去后 reload 若冒出和它有关的新错误，撤回。
- 端口和已登记的任何服务撞了（探活端口、`extraPorts`、`exposure.localPort`，或者管理器自己的端口）→ `port-conflict`，
  说清是谁占着。没登记、但此刻正被别的进程占着的端口，`put` 不拦，`start` 时照常报「端口 X 已被 node (pid) 占着」。
- 看名字像密钥的变量（`*_TOKEN`、`*_API_KEY`、`*PASSWORD*`、`*SECRET*`……按下划线分段认）不许用 `literal` 写值。只挡明显的，不保证挡全。
- `LSM_` 开头的变量是管理器注入的接入身份，不能自己写。

管理器生成的声明：`kind: managed`；`hooks.start.detaches: false`（管理器自己 spawn：零窗口、输出进 `logs/<id>.out.log`、
管理器重启时照跑并被认领回来）；档位 = 接入了 `linked`，有健康检查 `health`，否则 `port`；
**不写 `exposure`**（公网入口默认不开：登记方要对外给入口就自己转发，比如 ergo 经自己的网关转发服务页面）。

### 7.5 回复（管理器 → 项目）

```jsonc
{"type":"services.reply","id":"q-1","ok":true,"created":true,"changed":true,"restartNeeded":false,"service":{ /* 7.6 */ }}
{"type":"services.reply","id":"q-2","ok":true,"service":{...}}                    // start / stop / restart / autostart
{"type":"services.reply","id":"q-3","ok":true,"pending":true,"note":"服务正忙，停机已排队…","service":{...}}   // when-idle 排队
{"type":"services.reply","id":"q-6","ok":true,"removed":{"id":"ergo-daemon--p-1-web","name":"p-1-web"}}
{"type":"services.reply","id":"q-7","ok":true,"services":[ /* 7.6 */ ]}
{"type":"services.reply","id":"q-1","ok":false,
 "error":{"code":"port-conflict","message":"端口 8899 已经登记给 web-server（探活端口）——管理器不分配端口，换一个"}}
{"type":"services.reply","id":"q-2","ok":false,"error":{"code":"failed","message":"端口 8899 已被 node.exe (1234) 占着"},"service":{...}}
```

| `error.code` | 含义 |
|---|---|
| `not-linked` | 还没 `hello`，或者这条连接不是你的活跃会话 |
| `bad-request` | 缺 `id` / `name` / `on`，或者不认识的 `services.*` |
| `not-allowed` | 你自己就是别人名下的服务，不能再登记服务 |
| `invalid` | 定义或名字不合规；`details` 里逐条列原因 |
| `not-owner` | 目标不在你名下（别的登记方的、手写在注册表里的） |
| `not-found` | 你名下没有这个服务 |
| `port-conflict` | 端口已登记给别的服务（`message` 写清是谁） |
| `running` | 在跑的时候改端口 |
| `no-capability` | 没有停机 / 重启能力又没带 `force:true` |
| `in-use` | 撤销时还被别的东西用着（依赖、公网隧道、tailnet 入口），`details` 列出来 |
| `registry` | 注册表 / 开机自启名单写不进去（比如 `autostart.yaml` 坏了） |
| `failed` | 启停本身失败，`message` 是管理器的原因；带 `service` 给出当前状态 |

### 7.6 状态推送（管理器 → 项目）

```jsonc
{"type":"services.status","full":true,"services":[ /* 全部 */ ],"removed":[]}          // 接入（welcome）后立刻推一次
{"type":"services.status","full":false,"services":[ /* 变了的 */ ],"removed":["p-2-api"]}   // 之后只推变了的
```

`full:true` 时 `services` 是你名下的全部，之前知道、这里没有的就是没了。之后每次探活、每次启停跳变、注册表一变都比一遍，
只推变了的；`removed` 是撤掉了的名字（不管是你撤的还是用户在 CLI 里撤的）。一条服务状态：

```jsonc
{
  "id": "ergo-daemon--p-1-web", "name": "p-1-web", "owner": "ergo-daemon", "title": "示例站点", "port": 8899,
  "state": "RUNNING",          // 状态机见 service-schema.md：STOPPED / STARTING / RUNNING / DEGRADED / STOPPING / FAILED / ORPHAN
  "desired": "running",        // 管理器认为它该不该在跑
  "up": true,                  // state 是 RUNNING / DEGRADED
  "listening": true,           // 端口有没有人听；null = 还没探过
  "health": "ok",              // 健康检查：ok / failing；接入了的是自报的 ok / degraded / failing；没健康检查为 null
  "tier": "health",            // 这次探活的档位（绿灯含金量，service-schema.md）
  "pid": 1234, "since": 1760000000000,   // 监听进程、开始运行的时间（毫秒）
  "autostart": true, "linked": false,
  "busy": false, "busyReason": null, "pendingStop": false,
  "capabilities": ["start", "health"],    // 没有 stop 就是没有：停 / 重启要带 force
  "detail": "HTTP 200",        // 给人看的一句话
  "lastError": null            // 起不来、停不下时的原因
}
```

除了 `detail`、`since`，任何一个字段变了都会推；这两个跟着带上，但不单独触发（`detail` 是给人看的说明，
「第 1 次，下一轮再确认」这类字样会变来变去）。连接断了、重连之后再推一次全量——断线期间的变化以它为准。

### 7.7 登记方掉线、重启、管理器重启

- 名下的服务是管理器 spawn 的**独立常驻服务**，和登记方的进程、连接没有任何关系：登记方掉线、重启都不影响它运行，
  也不会被当成它的依赖（不写 `dependsOn`）。
- 管理器重启时，它和别的 `detaches: false` 服务一样照跑，按端口被认领回来（管理器重启时被收走的只是 cmd 包装层，服务是孙子进程）。
- 用户在 WebUI / CLI 里看得到它（卡片上标「由 X 登记」），照样能启停、开关开机自启；`lsm owned remove <id>` 撤销。
  注册表文件由管理器整份重写，手改会在登记方下次 `put` 时被覆盖（WebUI 上开的公网入口 `exposure` 例外，照留）。

客户端：`clients/lsm-link.mjs` 的 `lsm.services`（`ready()` / `put` / `start` / `stop` / `restart` / `autostart` / `remove` / `list` / `onStatus`），
所有方法都不抛异常，失败一律 `{ok:false, error:{code, message}}`；没接入时 `code` 是 `not-linked`，老管理器是 `unsupported`。
Python 客户端（`lsm_link.py`）暂未加，它会忽略这些消息。
