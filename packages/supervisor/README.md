# 服务管家（Local Service Manager，LSM）

> A local supervisor for long-running dev services on **one Windows machine**: start / stop / health-check them,
> wire up dependencies, see their console output live in a web UI — with no console windows popping up.
> The docs are in Chinese.

把一台 Windows 机器上各个项目的常驻服务（本地 Web 服务、模型推理服务、ssh 隧道……），收敛到一个统一托管、统一监控的地方。
管理器只关心「服务是否活着、要不要重启」，不关心服务内部的业务逻辑。

**只支持 Windows**（Windows 10 / 11）。它靠的是 Windows 才有的东西：计划任务、`conhost --headless`、进程树和 PowerShell，
在 macOS / Linux 上跑不起来，也没有打算移植。

## 它做什么

- **启停、探活、依赖编排**：一服务一个 YAML 声明；按依赖分层启动；探活分四档（进程 / 端口 / 健康检查 / 接入），
  WebUI 上每盏绿灯旁边都写着它是哪一档，免得一盏绿灯骗了你。
- **实时 WebUI**（只绑 `127.0.0.1`）：状态实时推送；每个服务的命令行输出可以在网页里实时看（过脱敏正则）。
- **零窗口**：管理器和它拉起的服务都不弹控制台窗口；管理器自己重启不会带走正在跑的服务。
- **场景**：一组服务一起起停（比如几个都吃 GPU 的服务不该同时开，所以有场景、没有「一键全开」）。
- **开机自启名单**：开机只起管理器，由它按你勾选的名单拉起服务。
- **接入协议**：服务可以用一个很薄的客户端（Node 版零依赖；Python 版只依赖 `websockets`）接入管理器，自报忙碌、实现优雅停机；
  接入的项目还能替自己登记、启停、撤销「名下的服务」。
- **哨兵**：发现「在跑但没纳管」的服务和「项目自带的自启计划任务」，提醒你纳管，但从不阻止你手动启动任何东西。
- 可选：经 VPS 反向 ssh 隧道开公网入口；经 tailscale + 自建 headscale 开只在 tailnet 里能打开的 HTTPS 入口；
  阿里云 VPS 订阅到期提醒（WebUI 一条栏 + Windows 系统通知）；WebUI 口令（SCRAM-SHA-256）。

## 和 ergo（二狗）的关系

它是 ergo（二狗）仓库里的一个包（`packages/supervisor`），但**运行时是单独的一个小进程**，和二狗的守护进程分开跑：
托管服务的东西要小、稳、少重启，二狗是最常重启的进程，不能自己托管自己。两边之间只走接入协议，代码上互不 import。
不用二狗、只拿它管你自己的服务也行。

ergo（二狗）是一个跑在自己电脑上的个人 AI 助手，它把服务托管交给 LSM：

- ergo 的守护进程作为一个**接入了协议的服务**跑在 LSM 里，启停、开机自启、日志都归 LSM 管；
- ergo 把做好的项目上线成服务时，经接入协议的「名下的服务」（[docs/link-protocol.md](./docs/link-protocol.md) §7）
  登记到 LSM，由 LSM 启动和托管；
- ergo 的外网入口（VPS 隧道、tailnet 入口）也由 LSM 开通。

两边用同一份 Node（大版本跟着二狗走，现在是 22 这条线）。

## 要求

- Windows 10 / 11，Windows PowerShell 5.1（系统自带）
- [Node.js](https://nodejs.org/) ≥ 22.19（22 这条线；自动测试只跑 22）
- 可选：OpenSSH 客户端（公网隧道要用，Windows 自带）、Tailscale（tailnet 入口要用）

## 安装

下面的命令都在 PowerShell 里执行。

```powershell
# 1. 拿到二狗的代码（见仓库根目录的 README），在仓库根目录装依赖；服务管家自己只用 yaml 和 ws 两个
npm ci
cd packages\supervisor

# 2. 把样例注册表拷进数据目录（默认 %LOCALAPPDATA%\ergo\supervisor，见下面「数据放在哪」）
$data = "$env:LOCALAPPDATA\ergo\supervisor"
New-Item -ItemType Directory -Force $data | Out-Null
Copy-Item -Recurse examples\registry "$data\registry"

# 3. 改两处路径：
#    registry\manager.yaml                 的 projectRoots：改成你放代码的目录（哨兵只在这些目录下找「你的项目」）
#    registry\services\link-demo.yaml      的 root：改成 packages\supervisor 所在目录（示范服务的工作目录）
notepad "$data\registry\manager.yaml"
notepad "$data\registry\services\link-demo.yaml"

# 4. 校验注册表（只读，不碰任何进程）
node bin\lsm.mjs validate

# 5. 起管理器 + WebUI，浏览器打开 http://127.0.0.1:7420/
node bin\lsm.mjs serve
```

管理器开着，另开一个 PowerShell 窗口，试一下样例里的示范服务（它演示了接入协议：linked 档探活、自报忙碌、优雅停机）：

```powershell
node bin\lsm.mjs start link-demo
node bin\lsm.mjs status                    # 档位是 linked：示范服务自己连上了管理器
curl.exe http://127.0.0.1:7999/busy/on     # 让它自报「正忙」，WebUI 上卡片变黄、写着忙碌原因
curl.exe http://127.0.0.1:7999/busy/off
node bin\lsm.mjs stop link-demo            # 优雅停机：管理器发停机指令，服务自己收尾后退出
```

管理器没开时，CLI 走本地直连模式：示范服务连不上管理器，就只剩 start 能力，停它要 `stop link-demo --force`（杀进程树）。

下文的 `lsm` 都是在 `packages\supervisor` 目录里跑 `node bin\lsm.mjs`。

**登录时自动起管理器**（可选）：

```powershell
node bin\lsm.mjs install-autostart     # 注册一个登录时运行的计划任务（无窗口）；这是本机唯一的自启入口
node bin\lsm.mjs install-shortcut      # 桌面放一个打开 WebUI 的快捷方式
node bin\lsm.mjs uninstall-autostart   # 不想要了就删掉
```

7420 端口被占了的话，改数据目录里 `registry\manager.yaml` 的 `port`。

## 数据放在哪

代码目录（`packages/supervisor`）只放代码，升级时会整个换掉；你的东西都在**数据目录**里：

| 数据目录里的 | 是什么 |
|---|---|
| `registry\` | 你的服务清单：`manager.yaml`、`services\*.yaml`、开机自启名单、tailnet 入口清单 |
| `state.json` | 账本：各服务的 PID、link token |
| `logs\` | 管理器日志、审计、各服务的命令行输出 |
| `.secrets\` | 密钥：WebUI 口令、tailnet 证书、云账号的只读 AccessKey |
| `tailnet-routes.json` | tailnet 网关的路由表（管理器生成） |
| `vps-setup.json`、`vps-scripts\` | `lsm vps setup` / `site add` 搭的 VPS：装了什么、走到哪一步、`scan` 认领的站点；最近显示给你看的脚本（用到才有，专用钥匙在 `.secrets\vps-setup\`） |
| `vps-certs.json` | `lsm vps certs` 最近一次看到的 VPS 证书和到期日 |

数据目录按这个顺序定（只在 `src/paths.mjs` 一处定）：

1. 命令行 `--data-dir <目录>`，任何命令都能加；
2. 环境变量 `LSM_DATA_DIR`；
3. 默认 `%LOCALAPPDATA%\ergo\supervisor`。

`lsm paths` 列出现在用的是哪个、各样东西在哪。数据目录不在默认位置时，`install-autostart` 会把 `--data-dir` 写进计划任务；
tailnet 网关的登记里也要给它的启动参数加上 `--data-dir <目录>`（管理器拉起服务时不把自己的环境变量传下去）。

**从旧的 LSM 目录过来**：以前数据就放在 LSM 自己的代码目录里，布局和上表一样。先用 `--data-dir <旧目录>` 接着用旧数据，
确认没问题后把上表这几样原样复制到新的数据目录、去掉 `--data-dir` 即可。

## 登记你自己的服务

在数据目录的 `registry\services\` 下一服务一个文件（文件名 = 服务 id），字段见 [docs/service-schema.md](./docs/service-schema.md)，
写完 `lsm validate`，管理器在跑的话再 `lsm reload`。把一个原本自己管自己的项目搬进来（摘掉它原来的自启入口、当场验证启停）
的流程见 [docs/onboarding-skill.md](./docs/onboarding-skill.md)。

密钥类的东西：管理器自己的（WebUI 口令、证书、云账号 AccessKey）放数据目录下的 `.secrets\`；服务要用的 API key 放在
不进 git 的地方。注册表里只写路径或「从用户环境变量读」，不写值。

## 常用命令

| 命令 | 做什么 |
|---|---|
| `lsm` / `lsm status` | 所有服务的真实状态（含档位、公网可达性） |
| `lsm validate` | 只校验注册表，不碰任何进程 |
| `lsm start <id>` | 启动（先按依赖把它依赖的服务起来） |
| `lsm stop <id> [--when-idle] [--force]` | 停止；`--when-idle` 等它空闲再停；`--force` 不等，10 秒内没停下就杀进程树 |
| `lsm restart <id> [--when-idle]` | 重启 |
| `lsm profile <场景>` / `lsm profile-stop <场景>` | 按场景起停一组服务 |
| `lsm autostart [<id> on\|off]` | 开机自启名单：不带参数列出，带参数加入 / 移出 |
| `lsm scan` | 哨兵巡检：谁在跑但没纳管、哪些自启任务该摘 |
| `lsm detach-task <任务名>` | 摘掉项目自带的自启计划任务（纳管的最后一步） |
| `lsm reload` | 让常驻管理器重新加载注册表 |
| `lsm owned [remove <id>]` | 接入的项目经协议登记的「名下的服务」；`remove` = 你手动撤销 |
| `lsm tailnet [<id> on [名字]\|off]` | tailnet 入口 |
| `lsm vps [refresh]` | VPS 订阅到期日和提醒 |
| `lsm vps setup headscale\|tunnel --host root@<IP>` | 一条命令在 VPS 上搭自建 tailnet 或隧道入口（先体检、整份显示脚本、你同意了才跑），见 [docs/vps.md](./docs/vps.md) |
| `lsm vps status` / `remove <方式>` / `approve <key>` | 搭好的通不通、证书哪天到期；原样撤掉；把手机登记进自建 tailnet |
| `lsm vps site add <名字> --port <端口>` / `site remove <名字>` | VPS 本机上的服务接成 https 站点（证书、nginx、80 被占、443 前门都照布局办）；原样撤掉。见 [docs/vps-https.md](./docs/vps-https.md) |
| `lsm vps certs` / `lsm vps scan` | VPS 上的证书和到期日（少于 20 天标出来）；只读扫一遍已有的站点和证书、认领进状态文件（不改它们） |
| `lsm set-password <口令>` | 设 WebUI 口令（写进数据目录的 `.secrets\`），再把 `manager.yaml` 的 `auth.enabled` 改成 `true` |
| `lsm paths` | 代码目录、数据目录各在哪 |

管理器在跑时，命令交给它执行；没在跑时 CLI 自己直连（本地模式）。完整列表：`lsm help`。

## 可选功能

都在数据目录的 `registry\manager.yaml` 里打开，样例文件里每一段都有注释：

- **公网入口**（`vps:`）：WebUI 卡片上点「开通公网」，管理器在本机起一条 ssh 反向隧道，并把 VPS 上要加的 nginx 片段生成给你
  ——管理器不会去改 VPS 上的 nginx。
- **tailnet 入口**（`tailnet:`）：给服务开一个只在 tailnet 里能打开的 HTTPS 地址。需要一台 VPS 跑自建的 headscale：
  VPS 上的 certbot 签真证书、headscale 的 DNS 记录把名字在 tailnet 里指回本机、本机的网关（`bin/tailnet-gateway.mjs`）做 TLS 终结。
  开通 / 撤销时管理器会经 ssh 改 VPS 上的两样东西（签证书、写 DNS 记录文件），平时只读。
- **一条命令搭 VPS**（`lsm vps setup headscale | tunnel`，不用改 `manager.yaml`）：在一台全新的 Debian / Ubuntu VPS 上装好
  自建 tailnet 的控制节点（headscale），或者隧道入口（只能做端口转发的受限账号 + nginx + Let's Encrypt 证书），装完自己验收，
  `lsm vps remove` 原样撤掉。见 [docs/vps.md](./docs/vps.md)。
- **VPS 订阅到期提醒**（`vps.billing:`）：用一个只读的阿里云 RAM 用户（只给 `AliyunBSSReadOnlyAccess`）查费用中心，
  WebUI 上一条栏显示每个包年包月订阅的到期日，快到期时弹 Windows 通知。WebUI 上「怎么配」有逐步说明。
- **WebUI 口令**（`auth:`）：WebUI 默认只绑本机、不要口令；需要时 `lsm set-password <口令>`，再把 `auth.enabled` 改成 `true`。

## 停止的判定

「停了没有」只看进程和端口，不看健康检查：

- 本来就没在跑（端口没人听、进程不在）的，停它直接成功；
- 还在跑的，照它的停机能力停：有停机钩子 / 接入了的走它自己的停机；都没有的要 `--force`（杀进程树），不然拒绝并说明它还在跑；
- 停机钩子返回了、服务却没退，等到超时就杀进程树兜底，**端口真的空了才报已停**，杀了还空不出来就 FAILED 并写明谁还占着。

## 文档

- [CONTEXT.md](./CONTEXT.md) —— 术语表：服务 / 项目 / 托管服务 / 外部服务 / 钩子 / 注册表 / 纳管 / 重认领 / 孤儿 / 探活档位 / 场景 / 哨兵……
- [docs/service-schema.md](./docs/service-schema.md) —— 注册表字段、钩子契约、状态机、启动编排
- [docs/link-protocol.md](./docs/link-protocol.md) —— 接入协议 v1：身份注入、心跳、忙碌、停机时序、名下的服务（§7）
- [docs/webui.md](./docs/webui.md) —— WebUI 的显示原则与实时性取舍
- [docs/onboarding-skill.md](./docs/onboarding-skill.md) —— 新项目怎么纳管进来
- [docs/vps.md](./docs/vps.md) —— 一条命令搭 VPS：自建 tailnet（headscale）或隧道入口，每一步做了什么
- [docs/vps-https.md](./docs/vps-https.md) —— VPS 上的 https 站点和证书：site add / remove、certs、scan；sslip.io 的频率限制
- [skills/vps-https/](./skills/vps-https/SKILL.md) —— 给 agent 的说明书：什么时候用这些命令、出错按踩过的坑排查
- [clients/](./clients/) —— 接入协议的客户端：`lsm-link.mjs`（Node，零依赖）/ `lsm_link.py`（Python，依赖 `websockets`）
- [examples/](./examples/) —— 接入协议的活样板（`demo-service.mjs`）和样例注册表

## 设计要点

- **钩子而不重写**：启停由项目自己的钩子实现，业务语义归项目；管理器只负责时机与观测，对钩子只做黑盒判断。
- **注册表中心化**：服务清单只在管理器这边（数据目录的 `registry\`），一服务一文件，不散在各项目仓库里；代价是会和项目现状漂移，所以启动失败时自动比对提示。
- **服务是脱离的独立进程**：管理器天天改、天天重启，不能把服务带走；重启后靠 PID + 进程启动时间 + 端口监听者三样对上才认回来（Windows 回收 PID 很快，只认 PID 会认错）。
- **默认不自动重启**：挂了只告警 + 一键重启（吃显存的服务盲目重拉代价太大）；隧道这类断了就该重连的服务按服务显式打开 `autoRestart`。
- **排他托管**：一个服务只能有一个管理者，本机也只有管理器这一个自启入口；纳管是一次搬迁（摘掉项目原来的自启），不是一次登记。
- **端口是服务的身份**：钩子自己 detach 的服务靠端口反查 PID；日志是索引而不是采集——管理器只 tail 项目自己的日志文件。
- **靠哨兵发现，不硬阻止**：让「在跑但没纳管」「会自启但没纳管」可见，邀请你纳管，从不阻止你手动启动任何东西。
- **不分配端口**：端口由你给，冲突只报不改。
- **WebUI 只绑本机**：公网入口走 VPS 隧道；要口令时用 SCRAM-SHA-256，口令不上网；所有写操作留审计，日志展示过脱敏。
- **GPU 是独占资源**：所以有「场景」（一组一起起停的服务），没有「一键全开」。
- **不伪造能力**：项目没有的能力（比如优雅停机）就是没有，WebUI 上灰显，不外挂脚本替它装。
- **接入层**：语言无关的协议，项目主动连出来，管理器在启动时注入身份；接入后能自报忙碌、优雅停机。
- **开机只起管理器**：由它按你勾选的「开机自启名单」拉起服务；「开机」按登录会话的建立时间认，管理器自己重启不算。
- **tailnet 入口**：VPS 上签真证书、headscale 的 DNS 记录把名字在 tailnet 里指回本机、本机网关终结 TLS；开通 / 撤销时只改 VPS 上这两样。
- **VPS 订阅到期提醒**：只读查云厂商费用中心，凭证只放数据目录的 `.secrets\`。
- **名下的服务**：接入的项目经协议登记、启停、撤销自己名下的服务（id 是 `<登记方>--<名字>`，存在注册表的 `services\owned\` 下），服务照样归管理器托管。

## 实测踩到、值得记住的三个 Windows 事实

1. **`detached: true` 会制造黑窗口**。它给的是 DETACHED_PROCESS（完全没有控制台），
   子孙进程没有控制台可继承，Windows 就给每个新建一个**可见**窗口；而且 PowerShell
   没有控制台时**所有输出凭空消失**。正确姿势是 `windowsHide: true` + 不 detached + stdio 全 `ignore`
   = CREATE_NO_WINDOW：有控制台但不显示，子孙继承它 → 零窗口；输出由一层 `cmd` 重定向进日志文件。
2. **`taskkill /T` 只向下杀**。杀不到「自带重启循环的父进程」——一个 always-on 的 ps1 启动脚本就是这种，
   kill 掉监听端口的 node，ps1 立刻又拉起一个，看上去像服务自己复活了。
   所以要先沿父链找到服务树的真正树顶（见 `findServiceTreeTop`），中间还会夹着
   `cmd /c` 和 npm shim 这些命令行里完全看不出项目痕迹的环节。
3. **PowerShell 5.1 默认按系统代码页写 stdout**。中文机器上是 GBK，Node 按 UTF-8 解会得到乱码
   （中文任务名变成一串问号）。每条 PS 命令前先钉 `[Console]::OutputEncoding=UTF8`。

## 它不是什么

服务分三档共存，目标是把第一档最大化：**linked**（已接入协议，能自报忙碌、能优雅停机）/
**hooked**（钩子纳管，能力有限就灰显）/ **external**（第三方，只探活）。

它不是 systemd、不是 PM2、不是无人值守的生产编排器。它是一台**你本人就坐在前面**的开发机上的
账本与仪表盘：让你看见什么在跑、绿灯到底保证了什么、以及一键把某个场景启起来。

## 开发

```powershell
npm run test:supervisor     # 在仓库根目录跑；= 本目录的 npm test（node --test tests/*.test.mjs），三分钟左右
```

测试自己建临时目录当数据目录（`LSM_DATA_DIR`；不自己建的测试文件第一个 import 是 `tests/_isolate.mjs`），
端口都是临时挑的空闲端口，不碰你正在用的数据目录和管理器端口。有几条会真的起进程、查进程表，所以只能在 Windows 上跑。
`lsm vps` 的测试不连任何机器：VPS 上跑的脚本在一个假的 Debian 根目录里用 Git Bash 真的跑一遍（要装 Git for Windows，
没有就跳过那几条；绝不用 WSL 的 bash），别的经假的执行层，见 [docs/vps.md](./docs/vps.md) 的「测试」。

## 许可证

和二狗同一份：仓库根目录的 LICENSE（MIT）。
