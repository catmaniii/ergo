# Windows 原生沙箱能力调研

Type: research
Status: resolved
Phase: 1
Blocked by: —

## Question

不装 Docker、不走 WSL2 的前提下，Windows 11 Pro 自带或可用的沙箱手段有哪些？维护者执行 shell 命令、读写文件时，能不能用它们把动作关在项目的目录里？每种手段要回答：

- 文件、网络、进程三方面各能隔离到什么程度；
- 启动开销；能不能长期保持（同一个项目反复进出）；
- Node 守护进程能不能用程序控制（起进程、传命令、取输出）；
- 要不要管理员权限，要不要先开 Windows 功能；
- 业界 agent（Codex CLI、Claude Code 等）在 Windows 上实际怎么做沙箱。

产出 `docs/research/12-windows-sandbox.md`。

## Context

- 「项目生命周期、工作空间与维护者」第 1 轮 Q5：用户问"Windows 上没有沙箱吗？为什么一定要用 WSL 的沙箱？"，要求先讨论、后续再决定。
- 已知事实：本机没有 Docker；有 WSL2（Ubuntu，运行中）；系统是 Windows 11 Pro。
- 项目的文件分"项目档案"和"工作目录"两块，维护者只能碰这两处（同一票 Q4）。
- 「项目生命周期、工作空间与维护者」第 3 轮：用户决定 **v1 暂时不做沙箱**，先用 AgentSense 式 hook 守卫。本调研留作将来加固时的参考，不阻塞任何第一阶段的票。

## Answer

2026-10-07 完成，详见 `docs/research/12-windows-sandbox.md`。

- Windows 原生沙箱能用，不必为沙箱回到 WSL2，但没有现成开关：Codex、Claude 的 sandbox-runtime、微软 MXC 都是把低权身份、目录权限、WFP 网络过滤和 Job 对象拼起来用。
- 最贴合"只碰项目两处目录"的是 **AppContainer**（每个项目一个身份，默认读写不到 D:、E: 和用户目录）。代价：
  - 微软 MXC 要求每次开机用管理员重置一次 `\Device\Null`，官方建议用计划任务，和 LSM 不许项目自带自启冲突；
  - 网络只有全断和全通两档；
  - Node SDK 要求 Node ≥24（本机 22.23），可以直接调 `wxc-exec.exe` 绕开。
- 退路：专用用户 + 受限令牌 + 盘根拒绝规则 + WFP，只需一次性管理员安装，和 LSM 规则相容。
- Windows Sandbox 不适合每次工具调用：全机只能开一个，冷启动约 15 秒，`wsb exec` 拿不到输出。本机未启用。
- **本机事实**：
  - D:\、E:\ 盘根给所有登录用户修改权，并继承到全部代码目录；
  - 防火墙三个配置文件全关；
  - 之前装 Codex 沙箱留下两个本地账户，以及对整个用户目录（含 `.ssh`）的读权限。
- **不管做不做沙箱都该做的两件事**（已转给「运行时架构」）：
  - 文件工具在守护进程里加路径围栏，因为 OS 沙箱管不到守护进程自己的读写；
  - 所有子进程放进二狗自建、不允许脱离的 Job 对象，否则守护进程被 LSM 杀掉时孙进程会活下来。
- v1 按用户决定不做沙箱；将来加固时，先在本机跑 `wxc-exec --probe` 试 AppContainer。
