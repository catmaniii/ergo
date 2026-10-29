# 注册表与钩子契约

注册表位于管理器的数据目录下（服务清单集中在管理器这边，不散在各项目仓库里；数据目录默认 `%LOCALAPPDATA%\ergo\supervisor`，
`--data-dir` / `LSM_DATA_DIR` 可以改，`lsm paths` 看在哪，见 `src/paths.mjs`），一服务一文件：

```
registry/
  manager.yaml            全局设置：绑定地址、探活间隔、场景定义、哨兵开关
  autostart.yaml          开机自启列表（WebUI 卡片上的开关维护）
  services/
    web-server.yaml
    tts-engine.yaml
    web-tunnel.yaml
    ...
    owned/                名下的服务：接入的项目经接入协议登记的（link-protocol.md §7）
      ergo-daemon/
        p-1-web.yaml      id = ergo-daemon--p-1-web；管理器按登记方的定义整份重写
state.json                运行状态（易失，与注册表物理分开，手改配置不会误伤状态）
logs/manager.log          管理器自身日志
logs/audit.log            所有写操作的审计留痕
logs/<id>.out.log         服务的命令行输出：管理器 spawn 的进程、各个钩子的输出都在这里（日志页读它）
```

## 服务声明

```yaml
id: web-server                  # 唯一标识，与文件名一致
name: my_app 主服务
project: my_app
root: C:\dev\my_app              # 所有钩子的工作目录
kind: managed                     # managed = 生死归管理器 | external = 只探活（术语见 CONTEXT.md）

probe:
  tier: health                    # process | port | health | linked —— WebUI 必须显示这个档位
                                  # linked 是接入后由连接本身提供的最高档，见 docs/link-protocol.md
  port: 8799                      # port/health 档必填；这是服务的身份标识
  health:
    url: http://127.0.0.1:8799/health
    timeoutMs: 3000
  intervalMs: 5000
  pidFile: null                   # 仅 process 档必填（无端口 → 没有别的身份来源）
  matchCmd: null                  # process 档按命令行认进程的正则（隧道都用它）。账本 / PID 文件给的 PID
                                  # 也必须对得上它，否则视为 PID 被复用、不认（2026-10-05 实测踩到）

capabilities: [start, restart]     # 该服务真有的能力；没列的在 WebUI 上灰显，管理器不替它伪造
                                  # linked 服务的能力以它 hello 里上报的为准，覆盖此处

link:
  enabled: true                   # 是否在 spawn 时注入 LSM_* 身份（见 link-protocol.md）
                                  # 项目还没改造时设 false，改造完切 true，二者可随时切换

hooks:                            # 未接入服务的兜底；接入后 stop/restart 走协议，不再用钩子
  start:
    cmd: node scripts/restart-server.mjs
    timeoutMs: 120000
    detaches: true                # 钩子会自己 detach → 管理器不追子孙，走端口反查
                                  # false = 前台常驻，管理器自己 spawn：外面套一层 cmd 负责 `>> logs/<id>.out.log`，
                                  #   stdio 全 ignore → 每个服务一个自己的、不可见的控制台（2026-10-08 实测）
    # argv: [ssh, -N, ...]        # 代替 cmd 的数组形式：参数不经 shell 拆分。不能含 " 和 %（cmd 会改写它们，直接拒绝）
    readyTimeoutMs: 60000         # 钩子返回后，等 probe 转绿的上限
  stop:
    cmd: node scripts/stop-server.mjs
    timeoutMs: 60000
  restart:                        # 可选；缺省时管理器执行 stop → start
    cmd: node scripts/restart-server.mjs
    timeoutMs: 180000

env:                              # 只声明来源，绝不存值（密钥不进注册表）
  - name: LLM_API_KEY
    from: userEnv                 # 执行钩子前用 PowerShell 现读用户级环境变量
  - name: ADMIN_TOKEN
    from: file
    path: .secrets/admin-token.txt
  - name: NODE_ENV
    from: literal
    value: production             # literal 只允许非敏感值

logs:                             # 管理器只 tail，不采集
  - path: tmp/server.log
    label: server

exposure:                         # 公网入口，二选一：
  via: web-tunnel               # ① 经哪条隧道服务出网（必须是注册表里真实存在的服务）
  remotePort: 18799
  publicUrl: https://web.example.com/
  check: true                     #    定期真去打 publicUrl——隧道进程活着 ≠ 公网通着
  # localPort: 8811               #    隧道连的本机端口，不写 = probe.port。对外端口和探活端口不同时必须写——
                                  #    例：chat-daemon 的 8810 对本机请求自动信任，对外只能走要设备凭证的 8811
  # never: <原因>                 # ② 永不上公网：管理器拒绝开通（WebUI 无按钮，API 也挡回）。
                                  #    必须写原因（不写原因的禁令迟早被当成多余删掉）；不能与 via 并存。
                                  #    不写 exposure 只表示「没开」，不表示「不许开」——例：tts-engine

# tailnet 入口不写在这里：清单在 registry/tailnet.yaml（服务 id → 名字），由 WebUI / `lsm tailnet` 维护。
# 它连的也是上面的 localPort；标了 never 的服务同样开不了。

dependsOn:
  - id: tts-engine
    type: hard                    # 等它 probe 转绿再启本服务，超时则整条链失败
  - id: gpu-backend
    type: soft                    # 不等；未就绪只标记降级

autoRestart:                      # 默认关（吃显存的服务盲目重拉代价太大）
  enabled: false
  maxRetries: 5
  backoffMs: [5000, 15000, 60000]

profiles: [my_app]

onboarding:                       # 纳管留痕，供漂移检查参考
  removedScheduledTasks: [MyApp-TTS]
  verifiedAt: 2026-08-23
  verifiedHooks: [start, stop, health]
```

## 名下的服务

接入的项目可以经接入协议替自己登记服务（`link-protocol.md` §7），它们落在 `services/owned/<登记方>/<名字>.yaml`，
仍是这一份中心注册表的一部分，字段和上面一样，另外多三个：

```yaml
id: ergo-daemon--p-1-web       # = <登记方>--<文件名>，对不上就报错
owner: ergo-daemon             # 只是给人看的；归属**只看文件放在哪个目录**，和这里不一致就报错
registeredAt: 2026-10-18T08:00:00.000Z
updatedAt: 2026-10-18T09:30:00.000Z
```

- 归属只看位置：顶层文件写了 `owner` 也不算（报错），否则谁都能把自己的服务送进别人手里。
- 登记方能写的只是这里字段的一个子集（命令、目录、环境、端口、健康检查、开机自启、自动重启、停机命令、接入、日志），
  生成的声明一律 `kind: managed`、`hooks.start.detaches: false`、不写 `exposure`（公网入口默认不开）、不写 `dependsOn`。
- 文件由管理器整份重写：手改会在登记方下次更新时被覆盖。你在 WebUI 上给它开的公网入口（`exposure`）照留。
- 你照样能在 WebUI / CLI 里启停、开关开机自启；`lsm owned` 按登记方列出，`lsm owned remove <id>` 撤销（先强制停，再拿掉登记）。

## 钩子契约（硬约定）

管理器对钩子只有黑盒判断（启停的业务语义归项目，管理器只管时机和观测结果），所以这些约定是承重墙：

1. **退出码 0 = 成功**，非 0 = 失败；失败时管理器保留 stderr 末尾若干行并展示。
2. **超时即失败**，管理器 `taskkill /T /F` 掉钩子进程树，服务状态转 FAILED，**不自动重试**。
3. **工作目录**恒为 `root`；**环境**为管理器最小环境 + `env:` 声明现查注入。
   管理器自身的 env 块是陈旧的（开机就起、跑好几天），因此 `userEnv` 每次执行都重新读取，从不缓存。
4. **禁止交互**：钩子不得有 `Read-Host`、确认提示或任何等待 stdin 的行为（管理器不接 stdin）。
   `stdio.stdin = 'ignore'` 只挡得住**读 stdin** 的那一类。PowerShell 的
   `$Host.UI.RawUI.ReadKey()` 读的是**控制台输入缓冲区**，绕开 stdin，照样能挂住。
   2026-08-28 实测：`tts-engine-server.ps1` 末尾那句「按任意键关闭窗口」就是这样——
   force kill 掐掉了它的子进程，ps1 自己却停在 ReadKey 上不退，那个可见窗口跟着一直赖着。
   所以「服务退出后等一下让人看清楚」这种便利，在托管路径上一律不许有。
5. **必须幂等**：`start` 在服务已在跑时应成功返回或明确报错，不得启出第二个实例。
6. **`stop` 必须真的停下**：钩子返回后管理器轮询到**进程和端口都没了**才算停（2026-10-18 起不再拿健康检查判：
   健康检查不过 ≠ 停了，原来这样判会把还活着的服务报成已停）；超时则 `taskkill /T /F` 兜底
   （必须带 `/T`——有的服务是 uv → python → 游戏客户端三层）；仍未消失则转 FAILED。
7. **能力缺失就是缺失**：项目没有停机逻辑就不声明 `stop`，管理器不外挂脚本替它伪造。
8. **Windows 没有 SIGTERM**：优雅停机只能靠服务自己的带内通道（如 my_app 的
   `POST /api/server/prepare-restart`）或项目的 stop 钩子实现，管理器不做任何信号假设。

## 状态机

| 状态 | 含义 |
|---|---|
| `STOPPED` | 账本与现实一致：没在跑，也不该在跑。「没在跑」= 端口没人听、进程不在、接入层没连着——和健康检查无关 |
| `STARTING` | start 钩子已返回，probe 尚未转绿，未超过 readyTimeout |
| `RUNNING` | probe 通过，三元校验（PID + 进程启动时间 + 端口监听者）一致 |
| `DEGRADED` | 进程活着但 probe 不过，或软依赖未就绪 |
| `STOPPING` | stop 钩子执行中 |
| `FAILED` | 钩子失败 / 超时 / 停不下来，需要你介入 |
| `ORPHAN` | 端口有人听，但三元校验对不上——管理器绝不静默处理，只请你裁决 |
| `EXTERNAL` | `kind: external`，只有探活结果，没有生死概念 |

三档服务共存，且目标是把第一档最大化：`linked`（已接入，协议对话）/ `hooked`（钩子纳管）/
`external`（只探活，如第三方应用 —— 第三方，永远改造不了）。

**绿灯的含金量取决于探活档位**：`process` 档的绿灯只保证进程还在（ssh 进程活着但隧道已断是必然会
发生的事），`port` 档保证有人在听，`health` 档保证服务真的能用，`linked` 档还额外保证
「它正在跟我说话，并且它自己说它没事」。WebUI 必须把档位显示出来，不能让一盏绿灯骗你。

**接入层断开不等于服务死亡**：linked 服务失联时降级回 port/health 档继续探活并标注
「观测精度下降」，绝不直接判死（见 link-protocol.md §5）。

## 启动编排

- 按 `dependsOn` 做拓扑排序，**同层并发、层间串行**；保存注册表时即检测循环依赖并拒绝，而不是启动时死锁。
- 硬依赖未就绪 → 整条链失败，明确报出卡在哪一环。
- 软依赖未就绪 → 照常启动，标记 DEGRADED（外部服务的生死不归管理器管，为它阻塞是越权）。
- 场景启动 = 对该场景的服务集合做上述编排（GPU 是独占资源，所以有场景、没有「一键全开」）。
