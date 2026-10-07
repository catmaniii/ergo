# 调研 12：Windows 原生沙箱（不用 Docker、不用 WSL2）

> - **调研日期**：2026-10-07。本机检查全程只读：没有启用任何功能，没有安装任何东西，没有改任何设置或 ACL（本文除外）。
> - **问题**：在 Windows 11 Pro 上，二狗的常驻 Node daemon（pi coding-agent SDK）为工具调用派生子进程（PowerShell / cmd / git / node / python），也读写文件。能不能用 Windows 自带或现成的机制，把这些动作关在一个项目的"项目档案 + 工作目录"两个目录里，从而不用 WSL2？
> - **标注**：
>   - 不加标的是事实，后面附来源。
>   - 【实测】= 本机命令的输出（§2）。
>   - 【推测】= 作者推断，没有跑过。
>   - 【建议】= 作者的建议。
>   - 【未核实】= 没在一手资料里找到定论。
> - **来源记法**（完整链接见 §8）：
>   - `CX/` = openai/codex @ `d27764b`（tag rust-v0.160.1，2026-10-05）。
>   - `SRT/` = anthropics/sandbox-runtime @ `6f0ce15`（v0.0.78，2026-09-30）。
>   - `MXC/` = microsoft/mxc @ `13d899c`（main，2026-10-07；最新 release v0.9.0，npm `@microsoft/mxc-sdk` 最新 1.0.0）。
>   - `GEM/` = google-gemini/gemini-cli @ `5738466`（v0.63.0）。
>   - `OC/` = openclaw/openclaw @ `fc23bc8`（v2026.9.8）。
>   - `VSC/` = microsoft/vscode @ `4d10e71`（main）。
>   - `UV/` = libuv v1.51.0，即本机 Node 22.23 自带的版本【实测 `process.versions.uv`】。

---

## 1. 要点

1. **能做，但不是一个开关。** Windows 没有 bubblewrap、Seatbelt 那样"一条命令把进程关进几个目录"的原语。业界的 Windows 原生沙箱都是拼起来的：低权身份（专用本地用户或 AppContainer）+ NTFS ACE + WFP 网络过滤 + Job 对象 + 私有桌面。Codex、Claude 的 sandbox-runtime（下称 srt）、微软 MXC 都是这个路子（§3、§5）。
2. **最贴合"只碰两个目录"的是 AppContainer。**
   - AppContainer 身份默认读写不了 D:、E:、用户目录，只能读 `C:\Windows`、`C:\Program Files` 这类系统目录【实测 ACL】。
   - 每个项目一个 AppContainer SID，项目之间天然互相看不到。
   - 微软的 MXC 已经把它包成 `wxc-exec.exe` 和 npm SDK，VS Code、OpenClaw 都在用。
   - 代价：MXC 的主机准备要管理员，其中 `\Device\Null` 那一项**每次开机都要重做**；网络在本机这一档只有"全断"和"全通互联网"两种；开发工具的兼容性要逐个试。
3. **"专用本地用户"方案在本机有一个硬坑。** `D:\` 和 `E:\` 根目录给 `Authenticated Users` 修改权，并继承到所有代码目录【实测】。
   - srt 的 `srt-sandbox` 用户不带 restricting SIDs，也故意不在盘根加 deny ACE。所以在本机，它能写 D:、E: 上的任何项目【推测：来自源码和本机 ACL，没跑】。
   - Codex 用 WRITE_RESTRICTED 受限令牌挡住了写，但读仍然是全盘可读。
4. **Windows Sandbox 隔离最强，但不适合给每次工具调用用。** 它是有独立内核的 Hyper-V 虚拟机，可是：
   - 每个登录会话只能开一个；
   - 冷启动约 12–15 s（第三方实测）；
   - `wsb exec` 拿不到 stdout / stderr；
   - 需要交互式桌面会话。
   
   本机没有启用这个功能，启用要管理员权限并重启。
5. **Job 对象只管进程，不管文件。** 另外，Node（libuv）给子进程用的 job 带 `SILENT_BREAKAWAY_OK`：daemon 死时只杀直接子进程，孙进程会活下来。二狗需要自己建一个不允许脱离的 job。
6. **本机 Windows 防火墙的三个配置文件全部关闭【实测】。**
   - 按程序、按用户写的防火墙规则都不生效。本机已有一条 Codex 留下的离线阻断规则，也因此不起作用。
   - 直接写 WFP 过滤器的方案（srt、Codex 的 ICMP/DNS/SMB 过滤、MXC 的 PSEC 档）不依赖这个开关【推测】。
7. **业界现状**：
   - Codex 有 `elevated`（专用用户 + 防火墙规则）和 `unelevated`（受限令牌）两种模式。
   - Claude Code 本体在原生 Windows 上**不做沙箱**（官方文档），但它的 srt 库已经有 Windows alpha。
   - VS Code 在 Windows 上用 MXC；OpenClaw 有 MXC 插件。
   - Gemini CLI 用"受限令牌 + 低完整性"。
   - Cursor 直接走 WSL2；Devin（原 Windsurf）在 Windows 上不支持 OS 级沙箱。
8. **【建议】不必为了沙箱回到 WSL2。** 分三层做：
   - **daemon 内的文件工具加路径围栏**：必须做，因为 OS 沙箱管不到 daemon 进程自己的读写；
   - **所有子进程进二狗自建的 Job**；
   - **shell 命令走 OS 沙箱**：先在本机用 `wxc-exec --probe` 和兼容性试跑验证 AppContainer；不行再退到"专用用户 + WRITE_RESTRICTED + 盘根 deny ACE + WFP"。
   
   Windows Sandbox 只留给"跑不可信代码"这种特殊模式。

---

## 2. 本机事实（2026-10-07，只读）

| 项目 | 结果【实测】 | 怎么查的 |
|---|---|---|
| 系统 | Windows 11 专业版 25H2，build **26200.9550**。注册表 `ProductName` 仍写 "Windows 10 Pro"，`EditionID=Professional` | `Get-ComputerInfo`、`cmd /c ver`、注册表 |
| 最近的更新 | KB5124010（2026-09-23）、KB5124009（09-22）、KB5126052（09-09）。26200.9550 高于 2026-09-08 安全更新 KB5124008 对应的 26200.9445（[kb]） | `Get-HotFix` |
| 当前用户 | `catmaniii`，是 Administrators 成员，但当前令牌里 Administrators 是 deny-only（UAC 过滤），完整性 Medium。UAC 开启，`ConsentPromptBehaviorAdmin=5`，能弹窗提权 | `whoami /groups`、注册表 |
| Windows Sandbox | `Containers-DisposableClientVM` 未启用；`WindowsSandbox.exe`、`wsb.exe` 都不存在 | `Win32_OptionalFeature`（InstallState=2）、`Test-Path`、`Get-Command` |
| Hyper-V | `Microsoft-Hyper-V-All` 及其子项都未启用；`VirtualMachinePlatform` 已启用；`HypervisorPresent=True`；基于虚拟化的安全（VBS）在运行。`systeminfo` 只显示 "A hypervisor has been detected" | 同上，加 `systeminfo` |
| WSL | `Microsoft-Windows-Subsystem-Linux` 已启用；WSL 3.0.1.0，内核 6.18.40.1；一个发行版 Ubuntu（WSL2，Stopped） | `wsl --version`、`wsl -l -v` |
| 相关服务 | `vmcompute`、`hns` 在运行（手动启动）；`WSLService` 在运行；没有 `vmms` | `Get-Service` |
| `Get-WindowsOptionalFeature` | 非管理员下**失败**："The requested operation requires elevation."。改用 `Get-CimInstance Win32_OptionalFeature` 可以读 | — |
| 防火墙 | Domain / Private / Public **全部 OFF**；`DefaultOutboundAction=Allow` | `netsh advfirewall show allprofiles state`、`Get-NetFirewallProfile -PolicyStore ActiveStore` |
| 盘根 ACL | `D:\`、`E:\`：Authenticated Users 有修改权（可继承），Users 有读权限。`D:\code\claudecode` 和二狗目录都继承这两条 | `Get-Acl` |
| AppContainer 能读哪里 | `C:\Program Files`、`C:\Windows\System32` 有 `ALL APPLICATION PACKAGES` 和 `ALL RESTRICTED APPLICATION PACKAGES` 的读权限。`C:\nvm4w`、`%LOCALAPPDATA%\pi-node`、`C:\Users\catmaniii`、`D:\`、`E:\` 都没有 | `Get-Acl` |
| 工具位置 | node = `%LOCALAPPDATA%\pi-node\current\node.exe`（v22.23.0）；git = `C:\Program Files\Git\cmd\git.exe`；python = WindowsApps 执行别名（Store 版）；没有 pwsh，只有 Windows PowerShell 5.1 | `Get-Command` |
| PSEC 线索 | `C:\Windows\System32\processmodel.dll` 存在（2026-09-23），`bfscfg.exe` 也存在。MXC 文档说 25H2 没有 processmodel.dll，T1 档要 25H2 之后的版本并且"OS contract enabled"（[MXC os]）。本机能不能用 T1 **未核实**，要跑 `wxc-exec --probe` 才知道 | `Test-Path` |
| Codex 遗留 | 本机装过 Codex CLI 0.104.0 的 elevated 沙箱（2026-02-20），留下：<br>• 本地用户 `CodexSandboxOffline`、`CodexSandboxOnline`，本地组 `CodexSandboxUsers`；<br>• 出站阻断规则 `codex_sandbox_offline_block_outbound`（Enabled，但防火墙是关的）；<br>• `CodexSandboxUsers` 对 `C:\Users\catmaniii` 有可继承的读+执行，所以 `.ssh`、`.codex` 也可读；<br>• `D:\code\opencode\CoopGame` 上有该组和一个能力 SID 的修改权 | `Get-LocalUser`、`Get-LocalGroup`、`Get-NetFirewallRule`、`Get-Acl`、`~\.codex\.sandbox\sandbox.log` |
| 启动开销基线 | 不加沙箱时，`powershell.exe -Command Get-ChildItem …` 跑三次：2.0 / 2.9 / 4.1 s；`cmd /c echo` 约 30 ms。<br>Codex 沙箱日志里，同类 PowerShell 命令端到端 2.5–6.4 s；runner 在 START 之后约 0.1 s 就起来了（第一条是 1.4 s）。<br>结论：受限令牌类沙箱本身的开销很小，大头是 PowerShell 自己 | `Measure-Command`、`~\.codex\.sandbox\sandbox.log` |

---

## 3. 各机制

### 3.1 Windows Sandbox（Containers-DisposableClientVM）

**是什么**

- 一次性的 Hyper-V 虚拟机，"relies on the Microsoft hypervisor to run a separate kernel"。关掉就丢弃全部内容；从 22H2 起，沙箱**内部**发起的重启会保留数据（[wsb-ov]）。
- **版本**：Pro / Enterprise / Education 支持，Home 不支持（[wsb-ov]）。
- **前提**：
  - BIOS 里开了虚拟化；
  - 内存 ≥4 GB（建议 8 GB），≥2 个 CPU 核；
  - 启用功能要用管理员 PowerShell 执行 `Enable-WindowsOptionalFeature -FeatureName "Containers-DisposableClientVM" -All -Online`，按提示重启（[wsb-inst]）；
  - 从 24H2 起，沙箱里没有 Store 内置应用（终端、记事本等）（[wsb-inst]）。
- **同一时刻只能开一个实例**："Windows Sandbox currently doesn't allow multiple instances to run simultaneously"（[wsb-ov]，页面日期 2026-03-29）。MXC 的说法更具体："only one Windows Sandbox VM per logon session"（[MXC wsb]）。

**.wsb 配置**（[wsb-cfg]）

| 键 | 默认 | 要点 |
|---|---|---|
| `Networking` | 开，走 Hyper-V Default Switch | 只有 Enable / Disable 两档，没有白名单。官方警告 "can expose untrusted applications to the internal network" |
| `MappedFolders` | — | `HostFolder` 必须已存在；`ReadOnly` 默认 **false**。可写映射里的改动在沙箱销毁后仍然保留 |
| `LogonCommand` | — | 以容器用户身份运行。默认用户是 `WDAGUtilityAccount`，文档说 "should be an administrator account" |
| `MemoryInMB` | 最多 4 GB | 低于 2048 会被自动提到 2048 |
| `ClipboardRedirection` / `AudioInput` | 都开 | 当沙箱用要显式关掉 |
| `vGPU` | 开 | "can potentially increase the attack surface" |
| `ProtectedClient` | 关 | 打开后，连沙箱的 RDP 客户端跑在 AppContainer 里 |

**wsb CLI（24H2 起）**（[wsb-cli]，页面日期 2024-10-22，2025-01-24 更新后没再改）

- 命令：
  - `start`：返回 sandbox ID，可用 `--config` 传 XML 字符串；
  - `list`、`stop`、`ip`；
  - `exec`：在沙箱里执行命令；
  - `share`：共享主机目录，`--allow-write` 才可写；
  - `connect`：开一个 RDP 窗口；
  - 全局参数 `--raw`：输出 JSON。
- **`exec` 只返回退出码，没有进程 I/O**："there is no way to retrieve the output of a command run in Sandbox"。
- `exec -r System` 以 SYSTEM 身份运行；`-r ExistingLogin` 要求先用 `connect` 建立用户会话。
- **第三方实测**（oxbox PR #34，25H2 Pro，build 26200，[oxbox]）：
  - `wsb.exe` 不在系统镜像里。第一次启动 `WindowsSandbox.exe` 时，系统从 Store 装上 `MicrosoftWindows.WindowsSandbox_0.8.107.0`，之后才有 `wsb.exe`。
  - 在 SSH 这类非交互会话里：`wsb start` 30.6 s 后返回 `Cancelled`；`WindowsSandbox.exe` 返回 0，但什么都没跑。
- 【推测】二狗 daemon 由 LSM 在用户登录后的交互会话里拉起（[08 §3.5](08-local-infra.md)），应该能满足"交互会话"这一条；但锁屏后或无人登录时不行。
- **启动时间**：
  - 微软只说 "takes a few seconds to launch"（[wsb-ov]）。
  - 第三方计时（[yaah]）：
    - 拉起 `.wsb` 到 guest 就绪 12.3 s，加上主机侧 2.5 s，合计约 15 s；
    - 用文件轮询传命令，热命令往返约 1 s；
    - 主机写入映射目录后，沙箱里约 229 ms 可见；
    - 9 次里有 2 次拾取延迟达到 4.5 s 和 17.9 s；
    - 运行时桌面上会出现沙箱窗口。

**常驻复用和拿输出：MXC 的做法**（[MXC wsb]，标为 experimental）

- 在 guest 里放一个代理程序 `wxc-windows-sandbox-guest.exe`。它用 4 条带随机 nonce 认证的 TCP 连接（control / stdin / stdout / stderr）回连主机，经 `cmd.exe /C` 执行命令并转发标准输入输出。
- guest 内的防火墙只放行这几条主机连接。
- **state-aware 模式**：
  - 由一个**脱离的**主机守护进程 `wxc-windows-sandbox-daemon.exe` 持有虚拟机；
  - `provision / start / exec / stop / deprovision` 分阶段调用，多次 exec 共用一台虚拟机；
  - 同一时间只接受一个 exec；
  - **没有空闲超时**："remains active until stop or deprovision"。
- 已知限制：
  - 一次性模式每次都付冷启动成本；
  - 网络只能全断；
  - 只能共享目录，不能共享单个文件。
- originhq 指出这几条 TCP 连接没有加密，源码里留着 TODO（[originhq]）。

**五问**

1. **隔离强度**：
   - 文件：沙箱里只能看到映射的目录，可设只读，这是最干净的白名单。
   - 网络：只有开 / 关两档。"只连主机"靠 guest 内的防火墙实现。
   - 进程：有虚拟机边界，进程逃不出来；`stop` 后全部消失。
2. **开销与复用**：冷启动约 15 s。可以用 wsb 或 MXC 让它常驻。但全机只能有一个实例，多个项目只能共用一台虚拟机：要么把各项目目录都映射进去（互相可见），要么串行切换。
3. **Node 能否控制**：能 spawn `wsb`，但拿不到输出。要么自建 guest 代理（MXC 已经做好，但它的 SDK 要 Node ≥24），要么通过映射目录传文件（YAAH 的做法）。
4. **权限与前提**：启用功能要管理员并重启；之后运行不需要管理员。Pro 版可用。需要交互式会话。
5. **已知弱点**：
   - 可写映射目录是主要通道：改动会留下，主机上的程序之后还会使用这些文件（见 §6 第 7 条）。
   - 网络、剪贴板、麦克风默认开着，要显式关掉。
   - 【推测】容器用户是管理员，所以 guest 内的防火墙锁定可以被 guest 里的管理员改掉，"只连主机"不是硬边界。
   - 主机上的工具链（node、git、python）不在沙箱里，每次都要重新安装，或者只读映射进去。

### 3.2 AppContainer / LPAC

**机制**

- **创建方式**：创建进程时带 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`，"the new process will be created as an AppContainer process"（[upta]）。
- **文件**：
  - 微软的说法："Read-write access can be granted to specific persistent files and registry keys. Read-only access is less restricted."（[ac-iso]）
  - 实际效果：对象的 ACL 里必须有给该 AppContainer SID 或 `ALL APPLICATION PACKAGES` 的授权，否则拒绝。MXC 的文档就记录过，因为 `C:\` 根上没有这类授权，cmd / powershell / node 一启动就报 `ERROR_ACCESS_DENIED`（[MXC hostprep]）。
  - 本机：系统目录有这类授权，D:、E:、用户目录、`C:\nvm4w`、pi-node 都没有【实测 ACL】。所以默认读不到这些地方。
  - 授权一个目录 = 在这个目录上加一条给该 AppContainer SID 的 ACE。这就是 MXC T3 档的做法（[MXC os]）。
- **LPAC**（Less Privileged AppContainer）：
  - 不算 `ALL APPLICATION PACKAGES` 的成员，只认 `ALL RESTRICTED APPLICATION PACKAGES`（S-1-15-2-2），所以连系统目录也要显式授权。本机 `Program Files`、`System32` 对两者都有授权【实测】。
  - 【推测】MXC 的 `processContainer.leastPrivilege` 选项对应 LPAC。
  - 微软 UpdateProcThreadAttribute 文档里查不到 LPAC 那个属性的说明【未核实】。
- **网络**：
  - 能力 SID 决定能连哪里：`internetClient` 可以出站连互联网，`privateNetworkClientServer` 管局域网而且是双向的；没有能力就是断网（[ac-iso]、[MXC net]）。
  - 连本机（环回）默认被 `AppContainerLoopback` 过滤器挡住，豁免只能"through an administrator only API"（[pz]）。
  - 这些过滤器由 MPSSVC 转成 WFP 过滤器、交给 BFE 下发（[pz]）。防火墙配置文件关闭时它们是否仍然生效，没找到一手说明【未核实】。本机防火墙恰好全关，必须实测。
- **进程 / 窗口**：内核对象和窗口都按 AppContainer 隔离（[ac-iso]）。`PROCESS_CREATION_CHILD_PROCESS_RESTRICTED` 能禁止再创建子进程，"only effective in sandboxed applications (such as AppContainer)"（[upta]）。二狗的工具调用需要子进程，用不上它。

**MXC（Microsoft eXecution Containers）**

- **概况**：
  - 微软开源，MIT 许可，2026-02 建仓；v0.9.0 发布于 2026-09-29，npm `@microsoft/mxc-sdk` 1.0.0 发布于 2026-10-06【实测 npm view】。
  - Windows 默认后端是 `processcontainer`，最低 build 26100（24H2），"verified on 25H2"（[MXC readme]）。
- **三档**（[MXC os]）：

  | 档 | 机制 | 状态 |
  |---|---|---|
  | T1 BaseContainer | PSEC（`processmodel.dll`） | 25H2 之后的版本，而且要"OS contract enabled" |
  | T2 AppContainer + BFS | `bfscfg.exe` 代理文件访问 | 发布版里关掉了，因为在 25H2 上可能让主机死锁 |
  | T3 AppContainer + DACL | 往主机路径上加 ACE | 通用兜底 |

  本机是 26200，至少能用 T3；能不能用 T1 要 probe【未核实】。
- **文件策略**：`readonlyPaths` / `readwritePaths` / `deniedPaths`，T3 档都用 ACE 实现（[MXC os]）。
- **网络**（[MXC net]）：
  - T3 档只有能力映射：
    - `egress deny + ingress deny` = 全断；
    - `egress allow` = 加 `internetClient`，互联网全通。
  - 按 IP / 端口的白名单、代理，只有 PSEC 档支持。
  - AppContainer 兜底档会拒绝"egress deny + ingress allow"这个组合，因为 `privateNetworkClientServer` 是双向的。
- **UI**：用 Job 的 `JOB_OBJECT_UILIMIT_*` 标志，加上 `disallowWin32kSystemCalls` 缓解措施（[MXC os]）。
- **主机准备**（`wxc-host-prep.exe`，manifest 要求管理员，[MXC hostprep]）：
  - `prepare-system-drive`：一次性在 `C:\` 根上给两个 AppContainer 通用 SID 加"读属性"ACE。
  - `prepare-null-device`：给 `\Device\Null` 设安全描述符。内核**每次开机都会重置**它，文档建议用计划任务、MDM 启动脚本之类在每次开机后执行。
- **Node 接入**：
  - SDK 要求 Node ≥24（Windows 上是 24.21+ 或 26.8+）（[MXC sdk]），本机 pi-node 是 22.23。
  - 可以绕开 SDK，直接 spawn `wxc-exec.exe config.json -- <命令>`："stdin/stdout/stderr is coupled directly to the container"（[MXC readme]）。
  - `run` / `spawn` 返回 stdout、stderr 和退出码。
  - ProcessContainer 是**每条命令起一次**的，没有常驻容器；常驻生命周期 API 只给 IsolationSession、WSLC 和 windows_sandbox 三个后端（[MXC sdk]、[OC mxc]）。
- **已知问题**：
  - 在 SDK 0.7 时，整个请求（命令、环境变量、策略）以 base64 放在 `wxc-exec` 的命令行参数上，本机能查看进程的人都看得到。OpenClaw 因此提醒不要把密钥放进命令或环境变量（mxc#626，[OC mxc]）。
  - T3 要改主机 ACL，崩溃后得清理残留（[originhq]）。
  - originhq（2026-06-04）引用过当时 README 里的一句 "no MXC profiles should be treated as security boundaries currently"。当前 README（`13d899c`）里已经搜不到这句【实测 grep】。

**五问**

1. **隔离强度**：
   - 文件：用户数据默认不可读也不可写，按目录授读写或只读。这是 Windows 原生方案里最接近白名单的。
   - 网络：T3 只有"断网"和"全通互联网"两档；局域网能力是双向的；环回默认不通，也就连不到 LSM 等本机服务。
   - 进程：子进程继承 AppContainer 令牌；配上 Job（关闭即杀）可以把整棵进程树收住。
2. **开销与复用**：只是创建进程，外加每次运行前后加 / 撤 ACE【推测：毫秒到百毫秒级，未测】。每条命令一个进程，不需要常驻。
3. **Node 能否控制**：Node 没有内置 API。可选：
   - 用 MXC（CLI 或 SDK）；
   - 自己写一个小 helper exe（C# 或 Rust），调用 `CreateAppContainerProfile`，再带 SECURITY_CAPABILITIES 属性 `CreateProcess`；
   - npm 上有零星社区包（`@landstrip/landstrip`、`@rtq/sandbox` 等），本文没有评估。
4. **权限与前提**：
   - 创建 AppContainer 进程不需要管理员。
   - 给目录加 ACE 只需要对该目录有 WRITE_DAC，自己建的目录一般有【推测】。
   - MXC T3 的主机准备要管理员，其中 `\Device\Null` 每次开机一次。
   - 不需要启用可选功能，Pro 版可用。
5. **已知弱点**：
   - 开发工具兼容性：工具要读工具链目录、要打开 NUL、要访问注册表和 COM。【推测】Store 版 python 的执行别名大概率用不了。
   - 网络粒度粗。
   - Project Zero 报告过：默认防火墙规则让几个系统程序绕过能力检查，微软标为 WontFix（[pz]）。
   - ACE 可能残留。

### 3.3 受限令牌（同一用户）与低完整性

**受限令牌**

- **API 语义**（`CreateRestrictedToken`，[crt]）：
  - 可以把 SID 设为 deny-only，可以删特权，可以加 restricting SIDs；
  - 有 restricting SIDs 时做两次访问检查，"Access is granted only if both access checks allow"；
  - `WRITE_RESTRICTED` 让 restricting SIDs "considered only when evaluating write access"；
  - 文档警告：受限进程应放在别的桌面上，否则能向默认桌面上的非受限程序 SendMessage。
- **Codex unelevated 就是这种做法**：
  - 令牌标志 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`；restricting SIDs 依次是若干能力 SID、登录 SID、Everyone（[cx-token]）；然后给工作区加授权该能力 SID 的 ACE。
  - 因为 WRITE_RESTRICTED 只管写，**读不受限**。源码直接拒绝："Restricted read-only access requires the elevated Windows sandbox backend"，deny-read 也做不到（[cx-lib]）。
- **网络**：令牌管不了网络。Codex unelevated 只有 "environment-level offline controls"，文档承认它 "has weaker network isolation"（[cx-doc]）。
- **在本机写隔离能成立**【推测：按 [crt] 的语义】：D:\ 那条 Authenticated Users 修改 ACE 只能通过第一次（普通 SID）检查，第二次检查的 restricting SIDs 里没有 Authenticated Users，所以写不进去。
- **漏洞点**：授予 Everyone 写权限的目录会漏，因为 Everyone 在 restricting SIDs 里。所以 Codex 启动时会扫描 Everyone 可写的目录并加 deny ACE。本机日志就扫出了 `C:\Users\Public\Thunder Network` 和 `C:\$360Section`【实测 `~\.codex\sandbox.log`】。

**低完整性（Low IL）**

- **MIC 语义**（[mic]、[chromium]）：
  - 低 IL 不能写中 IL 的对象，"even if that object's DACL allows write access"；
  - 系统默认给每个对象设 `NO_WRITE_UP`；
  - 但 "By default, a token can read an object of a higher integrity level"。
- **Gemini CLI 的 Windows 原生沙箱**（[GEM doc]、[GEM cs]）：
  - 受限令牌（只用 DISABLE_MAX_PRIVILEGE）+ 降到 Low IL + Job（KILL_ON_JOB_CLOSE）；
  - 要写的目录用 `icacls /setintegritylevel Low` 改标签，**这个改动是持久的**，沙箱结束后还留在文件上；
  - "断网"用的是 Job 网络限速 `MaxBandwidth = 1`，是限速，不是阻断；
  - C# helper 在运行时用系统自带 .NET Framework 的 `csc.exe` 编译。
- **评价**：不需要管理员，但读不受限、网络不阻断，还会永久改目标目录的完整性标签。只能防手滑。

**五问（两者合并）**

1. **隔离强度**：
   - 文件：受限令牌能收写，收不了读；Low IL 要改标签才能写，也收不了读。
   - 网络：都管不了。
   - 进程：都是同一个用户，能借"代理启动"逃出去，见 §3.4。
2. **开销与复用**：约 0.1 s【实测 Codex 日志】。每条命令一次。
3. **Node 能否控制**：Node 不能直接调用 `CreateProcessAsUser`，需要一个 helper exe。
4. **权限与前提**：不需要管理员，也不需要启用功能。
5. **已知弱点**：读全开；Everyone 可写的目录会漏；Low IL 的标签改动是持久的。

### 3.4 专用本地用户 + NTFS ACE（+ 受限令牌）

**Codex elevated**

- **账户**：管理员一次性 setup，建 `CodexSandboxOffline`、`CodexSandboxOnline` 两个用户和 `CodexSandboxUsers` 组（[cx-doc]）。
- **启动链**：用 `LogonUserW(LOGON32_LOGON_INTERACTIVE)` 登录沙箱用户（[cx-id]）→ runner 以 §3.3 那种 WRITE_RESTRICTED 令牌启动命令 → 命令放在私有桌面里、并进 Job（[cx-runner]）。
- **网络**：
  - 给 Offline 用户加一条 Windows 防火墙规则，阻断所有非环回出站（[cx-fw]）；
  - 另外直接用 WFP，按用户 SID 挡 ICMP、DNS（53 / 853）、SMB（445 / 139）（[cx-wfp]）。
- **读**：当前代码默认给沙箱用户读：`C:\Windows`、`Program Files`、`ProgramData`，以及用户目录下除 `.ssh`、`.aws`、`.gnupg`、`.config`、`.npm` 等以外的条目（[cx-setup]）。本机装的 0.104 版则把**整个** `C:\Users\catmaniii` 都授了读，`.ssh`、`.codex` 也在内【实测】。
- **Job**：标志是 `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`；根进程正常退出后会"保留后代"（同时关掉主动终止和关闭即杀），后台进程能活下来（[cx-job]、[cx-lib]）。
- **常见故障**：错误 1385 = 沙箱用户缺少所需的登录权限（[cx-doc]）。

**srt（Claude 的 sandbox-runtime）的 Windows alpha**（[SRT readme]）

- **安装**：管理员一次性执行 `npx @anthropic-ai/sandbox-runtime windows-install`。它建 `srt-sandbox` 用户和 `sandbox-runtime-users` 组，密码 DPAPI 加密后存在 HKLM，再装一组机器级 WFP 过滤器。不用注销。
- **启动链**：broker 用 `CreateProcessWithLogonW` 起一个以 `srt-sandbox` 身份运行的 runner；runner 再用受限令牌在 Job 里启动目标进程。
- **令牌**（[SRT token]）：
  - Administrators 和登录 SID 设为 deny-only；
  - 删除除 SeChangeNotify 外的所有特权；
  - Medium IL；
  - **不用 restricting SIDs**，理由是 "that breaks Schannel/LSA RPC"。
- **文件**：
  - 在 `allowWrite` / `allowRead` 路径上加给 `srt-sandbox` SID 的可继承 ACE；`denyRead` / `denyWrite` 加 deny ACE；
  - 会话结束时 `reset()` 撤销；
  - 不支持按单条命令覆盖 allow 规则。
- **网络**：
  - WFP 在 `ALE_AUTH_CONNECT` 层挡掉这个用户的所有出站，只放行到本机代理端口段（默认 60080–60089）；
  - 代理按域名白名单放行；
  - "a process that strips its proxy environment and connects directly is blocked at the kernel"。
- **人人可写目录**：安装时给 `%ProgramData%`、`%PUBLIC%` 等系统里人人可写的目录加 deny-write，但**故意不处理盘根**（`C:\`、`D:\`）。原因是在盘根加可继承 ACE 会改写整卷的 ACL，"Tracked separately"（[SRT ambient]）。
- **自述的已知限制**：
  - 用户目录里装的工具（nvm、`pip --user`、`%LOCALAPPDATA%\Programs`）沙箱用户打不开；
  - `proxyAuthToken` 出现在 runner 的命令行上；
  - 系统 DNS 解析不受挡（由以 NETWORK SERVICE 运行的 Dnscache 服务完成）；
  - schannel 的证书吊销检查会失败。

**本机后果**

- D:\、E:\ 对 Authenticated Users 是可继承的修改权【实测】。
- srt 的沙箱用户不受 restricting SIDs 约束，盘根又没有 deny，所以在本机**能写 D:、E: 上的所有项目**【推测】；读也一样，因为 Users 有读权限。
- Codex elevated 的写被 WRITE_RESTRICTED 挡住，但读全盘可见。
- 要满足"只碰两个目录"，需要：
  1. 在 D:\、E:\ 根上给沙箱 SID 加可继承的 deny（读和写都 deny）；
  2. 在两个目录上加显式 allow。
  
  这样能成立，是因为显式 ACE 排在继承 ACE 前面，离得近的 allow 先生效；srt 的注释也是这么说的（[SRT ambient]）。代价是第 1 步要改写整卷的 ACL，耗时、影响面大。
- 想按项目隔离，还得每个项目一个用户，或者每个项目一个能力 SID 加 WRITE_RESTRICTED。

**五问**

1. **隔离强度**：
   - 文件：写隔离取决于盘根 ACL，本机 D:、E: 会漏，除非加 restricting SIDs 或盘根 deny；读默认是 Users 能读的都能读。
   - 网络：WFP 按用户 SID 阻断，srt 还能做域名白名单。
   - 进程：沙箱是独立的用户 SID。srt 指出，这样能从结构上堵住"代理启动"类逃逸：计划任务、`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`、BITS、`RunAs="Interactive User"` 的进程外 COM。即使借这些途径起了进程，它仍然是沙箱用户（[SRT readme]）。
2. **开销与复用**：runner 约 0.1 s 起来【实测 Codex 日志】。每条命令一次；用户账户和 WFP 过滤器长期存在。
3. **Node 能否控制**：
   - srt 是 npm 包，有 JS API（`SandboxManager.initialize()`、`wrapWithSandbox`），Windows 部分是 alpha。
   - Codex 有 `codex sandbox windows <命令>` 子命令（本机 0.104 可用【实测 `--help`】），但绑定 Codex 自己的配置。
   - 自己写的话要一个 helper exe。
4. **权限与前提**：一次性管理员安装。需要能建本地用户、给沙箱用户登录权限（[cx-doc]）。WFP 持久过滤器重启后仍在，**不需要开机任务**。
5. **已知弱点**：
   - 盘根 ACL 太宽（本机就是这样）；
   - 用户目录里的工具链读不到；
   - 本机 Codex 遗留说明，ACE 和账户会长期留在主机上。

### 3.5 Job 对象

- **作用**：把一组进程当一个单位管理。可以限制工作集、优先级、CPU 速率、活动进程数、UI、网络速率。设了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 后，关掉最后一个句柄就会终止全部成员（[job]）。
- **子进程归属**（[job]）：
  - 子进程默认自动加入 job；
  - `BREAKAWAY_OK` 配合 `CREATE_BREAKAWAY_FROM_JOB`，或者 `SILENT_BREAKAWAY_OK`，可以让子进程脱离；
  - Windows 8 起可以嵌套 job；
  - "Child processes created using Win32_Process.Create are not associated with the job"，即通过 WMI 能跳出去。
- **不管文件和网络访问**，网络只能限速。
- **Node / libuv**（[UV]）：
  - libuv 的全局 job 带 `BREAKAWAY_OK | SILENT_BREAKAWAY_OK | DIE_ON_UNHANDLED_EXCEPTION | KILL_ON_JOB_CLOSE`；
  - 只有直接子进程在 job 里，"*their* subprocesses are not"；
  - `detached` 启动的子进程不进 job。
  
  后果：二狗 daemon 被 LSM 杀掉时，`powershell → node server.js` 这类孙进程会留下来。
- **五问**：
  1. 只管进程收口和资源上限。
  2. 开销可以忽略，一个项目一个 job 可以长期持有。
  3. Node 没有 job API，要 native addon 或 helper。helper 的写法：先 `CREATE_SUSPENDED` 创建进程，加入 job，再恢复运行。Codex 的 `spawn_contained` 就是这样（[cx-job]）。
  4. 不需要管理员。
  5. 弱点：允许脱离的 job 等于没管；WMI 能绕过；本身没有任何文件或网络隔离。

### 3.6 Windows 防火墙规则（按程序 / 用户 / AppContainer）与直接 WFP

- **`New-NetFirewallRule` 的匹配条件**（[fw-rule]）：
  - `-Program`：程序的完整路径，不支持通配（[fw-rules]）；
  - `-LocalUser`：SDDL，可以是 "services, users, application containers"；
  - `-Package`：AppContainer SID；
  - 显式 block 优先于 allow（[fw-rules]）。
- **按程序的规则对沙箱意义不大**：要挡的是 `powershell.exe`、`node.exe` 这类通用程序，挡了就挡了所有人。按用户（`-LocalUser`）或按包（`-Package`）才有用，Codex elevated 就是按用户（[cx-fw]）。改防火墙规则属于需要管理员批准的安装步骤（[cx-doc]）。
- **本机防火墙全关【实测】**：
  - 规则建了也不生效。本机那条 Codex 规则 Enabled=True，但起不了作用【推测】。
  - 要用规则，得先打开防火墙（需要管理员）。
  - 打开后入站默认拦截，LSM 托管的、监听 0.0.0.0 供局域网访问的服务需要补入站放行规则【推测】。
- **直接 WFP**：srt 和 Codex 都直接用 `FwpmFilterAdd` 加持久过滤器，条件是 `ALE_USER_ID`（用户 SID）（[SRT readme]、[cx-wfp]）。
  - 这类过滤器由 BFE 执行，不依赖防火墙配置文件的开关【推测：没找到一手资料的明确说法】。
  - 需要管理员一次性安装；重启后仍在，不需要开机任务。
- **五问**：
  1. 只管网络，不管文件和进程。
  2. 没有启动开销，规则长期存在。
  3. 规则可以用 PowerShell 建；WFP 要 native 代码。
  4. 都要管理员；用规则还要求防火墙开着。
  5. 弱点：按程序太粗；本机的开关状态让所有规则失效。

### 3.7 Sandboxie-Plus

- **机制**：内核驱动 + 服务的应用级沙箱。默认把写入重定向到沙箱目录（写时复制），不改真实文件；可以同时开多个沙箱（[sbie]）。
- **许可**：
  - Plus 版是自定义许可：非商业使用免费，"certain functionality is only available with a support certificate"；商业使用要企业证书，最多 3 台机器可以限期评估（[sbie-lic]）。
  - Classic 版是 GPL-3.0（[sbie]）。
- **程序化控制**（[sbie-start]）：
  - `Start.exe /box:<名字> [/wait] [/silent] [/hide_window] [/env:K=V] <程序>`；
  - `/wait` "return the exit status from the program"；
  - `/terminate`、`/delete_sandbox` 用于清理；
  - 配置在 Sandboxie.ini，`/reload` 重新加载。
  - stdout 能否捕获，文档没写【未核实】。
- **五问**：
  1. 写是虚拟化的，不是拒绝；读默认放行，要自己配 `ClosedFilePath` 等；可以按沙箱禁网。
  2. 开销小，沙箱可以常驻、可以多开。
  3. Node 可以 spawn `Start.exe`，用 `/wait` 拿退出码。
  4. 装驱动要管理员；Plus 版有许可限制。
  5. 弱点：隔离语义是"虚拟化写"，和"只准碰两个目录"不对路；引入第三方内核驱动。
- 【建议】不作为主方案。

### 3.8 Hyper-V 虚拟机（重型）

- 本机 Hyper-V 未启用【实测】，启用要管理员并重启。
- 主机控制来宾用 PowerShell Direct：`Invoke-Command -VMName`，或者 `New-PSSession` 加 `Copy-Item -ToSession`。前提（[psdirect]）：
  - "You must be logged into the host computer as a Hyper-V administrator"；
  - 虚拟机在本机运行；
  - 提供来宾的凭据。
- **五问**：
  1. 隔离最强，和 Windows Sandbox 同级；网络由虚拟交换机控制。
  2. 可以常驻、可以做检查点；启动要几十秒【推测】。
  3. 用 PowerShell Direct 或 SSH 下发命令、拿输出。
  4. 要管理员，Pro 版可用。
  5. 代价：要维护一个完整的来宾系统（许可、更新、工具链），文件只能共享或复制进出。基本等于"本机上的远程开发机"，复杂度不低于 WSL2。

### 3.9 WSL2（基线对照）

- **自动挂载**：默认 `[automount] enabled=true`，所有固定盘以 DrvFs 挂到 `/mnt/<盘符>`。设成 `false` 只是不自动挂，"you could still mount them manually or via fstab"（[wsl-cfg]）。
- **`wsl.conf` 在发行版里面**（`/etc/wsl.conf`），按发行版生效（[wsl-cfg]）。【推测】发行版里的 root 能改回去，或者手动 `mount -t drvfs`。所以关掉自动挂载不是边界，除非 agent 在发行版里不是 root，并且再叠一层沙箱。
- **interop**：要设 `[interop] enabled=false` 才能阻止从 Linux 启动 Windows 程序（[wsl-cfg]）。
  - Claude Code 的文档说：WSL2 里启动 Windows 程序（`cmd.exe`、`powershell.exe`、`/mnt/c/` 下的程序）是经 Unix socket 交给 Windows 主机执行的，要靠可选的 seccomp 过滤器才能挡住（[cc-doc]）。
  - 【推测】这些程序在 Windows 侧以你的身份运行。
- **全局设置**：`.wslconfig` 对所有 WSL2 发行版生效，包括内存、`networkingMode`（可设 `none`）、`firewall`（让 Windows 防火墙和 Hyper-V 防火墙过滤 WSL 流量）（[wsl-cfg]）。
- **每个项目一个发行版**：可以用 `wsl --import` 实现，每个发行版有自己的 `wsl.conf`；但 `.wslconfig` 里的设置（如网络模式）是全局的。
- **业界在 Windows 上要"真沙箱"时，现成的路线就是"WSL2 + bubblewrap"**：
  - Claude Code："On native Windows, Claude Code runs commands unsandboxed. To use the sandbox on a Windows machine, run Claude Code inside a WSL2 distribution."（[cc-doc]）
  - Cursor："On Windows, Cursor runs the Linux sandbox within WSL2"（[cursor]）。
- **对二狗**：
  - 工具要用 Linux 版，git、node、python 在 WSL 里各装一份；
  - PowerShell、cmd 类命令要么走 interop（等于出了沙箱），要么不支持。

### 3.10 新出现的系统级方案（只做记录）

- **Agent Workspace**：Windows 11 的"实验性 agent 功能"。
  - 每个 agent 一个独立账户，"runs in a separate Windows session"；
  - 默认可以访问 Documents、Downloads、Desktop、Music、Pictures、Videos；
  - 只有管理员能打开，打开后全机生效；
  - 面向 Copilot Actions 和通过 MCP 注册的 agent connector（[agentic]）。
- **MXC 的 `isolation_session` 后端**：每次执行临时建一个 agent 用户，并启动一个 OS 托管的会话（[MXC iso]），需要 Insider build 26340.9212（[MXC readme]）。本机是 26200，用不了【推测】。

---

## 4. 对比表

| 机制 | 文件隔离 | 网络隔离 | 进程逃逸 | 启动开销 | 能否常驻复用 | Node 可控性 | 权限 / 功能要求 |
|---|---|---|---|---|---|---|---|
| Windows Sandbox | 强：只看得到映射目录，可设只读 | 只有开 / 关；"只连主机"靠 guest 防火墙 | 虚拟机边界，stop 后全灭 | 冷启动约 15 s（第三方测） | 能（wsb / MXC 守护进程），但全机只能一个实例 | `wsb exec` 拿不到 stdout，要 guest 代理（MXC） | 启用功能要管理员 + 重启；Pro 可用；需交互会话 |
| AppContainer（MXC T3 / 自写 helper） | 强：用户数据默认不可读写，按目录授权 | 只有断网 / 全通互联网；环回默认不通；IP 白名单只有 T1 有 | 子进程继承令牌；配 Job 收口 | 进程级 + 加撤 ACE【推测】 | 每条命令一次，不用常驻 | `wxc-exec.exe` CLI；SDK 要 Node ≥24 | 主机准备要管理员；`\Device\Null` 每次开机一次 |
| 受限令牌（同一用户，WRITE_RESTRICTED） | 写可收；读不收 | 无，只能靠代理环境变量 | 可借计划任务、COM 等代理启动逃逸 | 约 0.1 s【实测】 | 每条命令一次 | 要 helper exe | 不需要管理员 |
| 低完整性 | 写要改标签（持久）；读不收 | 无（Gemini 只是限速） | 同上 | 很小 | 每条命令一次 | 要 helper exe | 不需要管理员 |
| 专用本地用户 + ACE（srt / Codex elevated） | 写：看盘根 ACL，本机 D:、E: 会漏；读：Users 能读的都能读 | WFP 按用户 SID 阻断，srt 还有域名白名单代理 | 独立 SID，代理启动的进程也还是沙箱用户 | 约 0.1 s【实测】 | 每条命令一次；账户和过滤器长期存在 | srt 有 JS API（alpha）；Codex 有 CLI | 一次性管理员安装；不需要开机任务 |
| Job 对象 | 无 | 只能限速 | 可设不准脱离；WMI 创建的进程不进 job | 很小 | 能（一个项目一个 job） | 要 addon 或 helper | 不需要管理员 |
| 防火墙规则（按程序 / 用户 / 包） | 无 | 按程序太粗；按用户 / 包可用 | — | 无 | 长期存在 | 用 PowerShell 建 | 要管理员；**防火墙必须开着（本机全关）** |
| 直接 WFP 过滤 | 无 | 按用户或 AppContainer SID，持久 | — | 无 | 长期存在 | 要 native 代码 | 一次性管理员 |
| Sandboxie-Plus | 写重定向；读默认放行 | 可按沙箱禁网 | 驱动级拦截 | 小 | 能多开、能常驻 | `Start.exe /wait` 返回退出码 | 装驱动要管理员；Plus 许可有限制 |
| Hyper-V 虚拟机 | 最强，只看得到共享 | 虚拟交换机控制 | 虚拟机边界 | 几十秒【推测】 | 能常驻、能做快照 | PowerShell Direct（要 Hyper-V 管理员）或 SSH | 启用 Hyper-V 要管理员 + 重启 |
| WSL2（基线） | 默认挂载全部盘；关自动挂载不算边界 | `networkingMode` 是全局的 | interop 默认能起 Windows 程序 | 冷启动几秒【推测】 | 长期运行的虚拟机 | `wsl.exe -d <发行版> -- <命令>` | 本机已启用 |

---

## 5. 业界 agent 在 Windows 上的做法

| 产品 | Windows 原生方案 | 文件 | 网络 | 备注 |
|---|---|---|---|---|
| Codex（CLI / App） | `elevated`（首选）：专用沙箱用户 + WRITE_RESTRICTED 令牌 + ACE + 防火墙规则 + WFP（ICMP / DNS / SMB）+ 私有桌面。`unelevated`（兜底）：当前用户的受限令牌 + ACE（[cx-doc]） | 写只限工作区；读默认宽：系统目录加用户目录的大部分 | elevated 靠防火墙规则；unelevated 只有环境变量这一层 | 遇到 Everyone 可写的目录会警告；配置 `[windows] sandbox = "elevated"`；`/sandbox-add-read-dir` 可以临时加读目录 |
| Claude Code | 原生 Windows 上**不做沙箱**，要沙箱就进 WSL2（[cc-doc]） | — | — | srt 库已有 Windows alpha（专用用户 + WFP + ACE，[SRT readme]），Claude Code 本体还没接入 |
| VS Code agent | MXC：`@microsoft/mxc-sdk` 1.0.0 打包进 VS Code（[VSC pkg]）；实验性，要求装 2026-09-08 安全更新（24H2/25H2 是 KB5124008）（[vsc-doc]）。源码注释说，等 srt 支持 Windows 后这一段可以删掉（[VSC mxc]） | `allowRead` / `allowWrite` / `denyRead`，只支持字面路径 | `allowNetwork=false` 时出站全断，不支持按域名过滤 | MCP 服务器的沙箱在 Windows 上不可用 |
| OpenClaw | 插件 `@openclaw/mxc-sandbox`（预发布），后端名 `mxc`，落到 ProcessContainer。其他后端是 docker / podman / ssh / openshell / crabbox（[OC mxc]、[OC modes]） | `workspaceAccess`：none / ro / rw | `none`，或 `default`（即 `internetClient`） | 不支持 Windows 的文件 deny 和主机白名单；每条命令一个容器 |
| Gemini CLI | 受限令牌 + Low IL + Job；C# helper 在运行时用 csc 编译（[GEM cs]） | 用 icacls 把可写目录标成 Low（持久） | Job 网络限速 | 读不受限 |
| Cursor | 在 WSL2 里跑 Linux 沙箱（Landlock + seccomp）（[cursor]） | — | — | 博客原话："Building an equivalent native Windows sandbox is significantly harder" |
| Devin CLI / Devin Desktop（原 Windsurf） | 不支持："OS-level sandboxing is not currently supported on Windows"，在 Windows 上加 `--sandbox` 会直接失败（[devin]） | — | — | Linux 上用 bubblewrap + socat |
| 微软 Agent Workspace | 每个 agent 一个账户、一个独立的 Windows 会话（[agentic]） | 默认可访问 6 个已知文件夹 | — | 管理员打开后全机生效；面向 Copilot Actions 和 MCP connector |

---

## 6. 对二狗的含义【建议】

背景：每个项目有两个目录，"项目档案"和"工作目录"。项目的维护 agent 和它的子 agent 只能碰这两个目录。daemon 由 LSM 托管；项目不许自带任何自启机制（计划任务、Run 键都不行，见 [08 §3.6](08-local-infra.md)）。

1. **OS 沙箱只管子进程，管不到 daemon 进程里的文件工具。**
   - 【推测】pi SDK 的 read / write / edit 工具在 daemon 进程里以用户身份执行，需要对照 pi 的工具实现确认。
   - 所以第一道防线必须是 daemon 里的路径围栏：先规范化路径，再判断是否落在两个目录之内。规范化要处理：`realpath`；指向两个目录之外的 junction 和 symlink 一律拒绝；`\\?\` 前缀；8.3 短文件名；带 `:` 的备用数据流。这层不需要任何 OS 机制。
   - 也可以学 OpenClaw，把文件工具也放到沙箱里执行（它的 fs-bridge）。
2. **所有子进程都进二狗自己的 Job。** 不允许任何脱离、关闭即杀、限制进程数和内存。这能解决 libuv 孙进程漏杀的问题，LSM 杀 daemon 时整棵进程树也能干净退出。不需要管理员。【推测】LSM 本身也在 job 里（08 §3.6），Windows 8 起支持嵌套 job，两者不冲突。
3. **shell 命令的 OS 沙箱：首选 AppContainer，每个项目一个 AppContainer 配置（即一个 SID）。**
   - **授权**：
     - 项目档案 + 工作目录：读写。子 agent 对档案是否只读，见 §7。
     - 工具链目录：只读。`Program Files` 默认可读；`pi-node`、`C:\nvm4w` 要显式授权。
   - **网络**：默认断网。需要联网的命令（`git fetch`、`npm install`）单独审批，批准后用 `internetClient` 跑。
   - **实现**：先用 MXC 的 `wxc-exec.exe`，不走 SDK（避开 Node ≥24 的要求），并锁定版本。
   - **先在本机做一次试验**：
     - 跑 `wxc-exec --probe`，看选到哪一档，是否提示要 `prepare-system-drive` / `prepare-null-device`；
     - 在 AppContainer 里跑通 `git status` / `git commit`、`node -v`、`npm ci`、`python -c`、`powershell -Command`。
   - **和 LSM 规则的冲突**：T3 需要的 `\Device\Null` 每次开机都会重置，MXC 建议用计划任务在开机后跑 `prepare-null-device`（[MXC hostprep]），这正是 LSM 禁止的项目自带自启。可选：
     - (a) 用户每次开机后手动走一次 UAC。二狗检测到没准备好时提示用户。
     - (b) 由 LSM 统一提供"开机后主机准备"这类一次性的提权步骤。这要 LSM 侧设计，因为 LSM 本身不提权。
     - (c) 如果本机能用 T1（PSEC），可能不需要这一步【推测】，问题也就没了。
4. **备选：专用沙箱用户**（用 srt，或仿 Codex 自己写）。
   - 优点：一次性 UAC 安装后不需要开机任务，WFP 过滤器持久，和 LSM 规则相容；进程逃逸面最小。
   - 缺点：本机 D:\、E:\ 盘根给了 Authenticated Users 修改权，沙箱用户默认能写所有代码（srt 不处理盘根）。要么加 WRITE_RESTRICTED 令牌（挡写不挡读），要么在盘根给沙箱 SID 加可继承的 deny（会改写整卷 ACL，要先评估）。按项目隔离还要每个项目一个用户或一个能力 SID。
5. **Windows Sandbox 只用于"跑不可信代码"的特殊模式**，比如跑来路不明的仓库脚本；不做默认的工具通道。理由：
   - 全机只有一个实例，多个项目会互相看到映射目录；
   - 冷启动约 15 s；
   - 要交互会话；
   - 要管理员启用。
   
   如果启用，虚拟机由谁持有也得按 LSM 的规则来。MXC 的守护进程是脱离启动的、没有空闲超时，等于在 LSM 之外多了一个常驻进程，违背"一个服务只有一个管理者"（ADR-0005）的精神。要么把它登记进 LSM，要么由二狗 daemon 自己持有，退出时 stop。
6. **防火墙**：本机三个配置文件全关。任何依赖防火墙规则的网络隔离，都要先让用户打开防火墙（要管理员）；打开后入站默认拦截，要检查 LSM 托管的、需要局域网访问的服务。优先用 WFP 直接过滤或 AppContainer 能力，它们不依赖这个开关。但 AppContainer 在防火墙关闭时是否仍然生效，必须实测【未核实】。
7. **"可写目录"等于"能写主机会执行的入口"。**
   - 沙箱能写工作目录，就能写 `.git/hooks`、`.git/config`、`.vscode/`、`package.json` 里的 scripts、`.npmrc`。之后这些会被沙箱外的程序执行：用户的 IDE、二狗 daemon 自己跑的 git、LSM 的钩子。
   - Claude Code 的沙箱把这些列为"可写目录里仍然拒绝写入的受保护路径"（[cc-doc]）。
   - 二狗要有同样的清单，用 deny ACE 或路径围栏实现；二狗自己对项目目录跑 git 时也要走沙箱。
8. **密钥不进沙箱**：
   - 子进程的环境变量要清洗，不传 API key。
   - MXC 早期版本把请求放在命令行参数上（mxc#626）；srt 的代理 token 在命令行上可见。
   - 所以二狗的密钥不要出现在沙箱命令的命令行或环境变量里。
9. **不要为了沙箱回到 WSL2。** WSL2 关自动挂载不是边界，真要隔离还得在 WSL 里再叠 bubblewrap（Claude Code、Cursor 的路线），而且 PowerShell、cmd 类命令就用不了了。WSL2 只留给确实需要 Linux 工具链的项目。
10. **安装会在主机上留下持久状态。** 本机的 Codex 遗留（两个沙箱用户；对整个用户目录、包括 `.ssh` 的读 ACE；对 CoopGame 的写 ACE；一条不生效的防火墙规则）和二狗无关，但它说明了这一点。二狗的方案要配套卸载和清理命令。

---

## 7. 开放设计问题

1. **"只能碰两个目录"是否包括读？** 如果只限写，受限令牌（WRITE_RESTRICTED）就够了，而且不需要管理员。如果读也要限，只剩 AppContainer、"专用用户 + 盘根 deny"，或虚拟机。
2. **子 agent 对"项目档案"是读写还是只读？** 维护 agent 和子 agent 要不要用不同的沙箱身份（不同的 AppContainer SID 或能力 SID）？
3. **能不能接受一次性 UAC 安装？** 能不能接受每次开机一次 UAC（MXC T3 的 `\Device\Null`）？还是由 LSM 来做"开机后主机准备"？
4. **同不同意打开 Windows 防火墙？** 打开后，哪些 LSM 服务需要局域网入站规则？
5. **联网策略**：默认断网、按命令审批？还是需要域名白名单？后者只有 srt 的代理方案或 MXC T1 做得到。
6. **工具链放哪？** AppContainer 和沙箱用户都读不到 `%LOCALAPPDATA%\pi-node`、`C:\nvm4w` 和 Store 版 Python。是给这些目录授读权限，还是改成机器级安装（Program Files）？
7. **pi SDK 的文件工具能不能换成"经沙箱执行"的实现？** 还是只在 daemon 里做路径围栏？
8. **要不要启用 Windows Sandbox，作为"不可信代码"模式？** 启用要管理员并重启。
9. **MXC 跟不跟？** MXC 版本变化很快（v0.9 到 1.0 只隔一周，接口合约还标着 alpha）。二狗是锁版本跟进，还是自己写一个最小的 AppContainer helper（Rust 或 C#，【推测】几百行）？
10. **要不要清理本机的 Codex elevated 沙箱遗留**（用户、组、ACE、防火墙规则）？Codex 源码里有卸载流程（`uninstall_windows`）。

---

## 8. 来源

**微软官方文档**

- [wsb-ov] Windows Sandbox 概述（ms.date 2026-03-29）：https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/
- [wsb-inst] Install Windows Sandbox：https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install
- [wsb-cfg] Use and configure Windows Sandbox（.wsb）：https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
- [wsb-cli] Windows Sandbox command line（ms.date 2024-10-22）：https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli
- [ac-iso] AppContainer isolation：https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- [upta] UpdateProcThreadAttribute：https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
- [crt] CreateRestrictedToken：https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken
- [mic] Mandatory Integrity Control：https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control
- [job] Job Objects：https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- [fw-rule] New-NetFirewallRule：https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule
- [fw-rules] Windows Firewall Rules：https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules
- [wsl-cfg] Advanced settings configuration in WSL（ms.date 2026-04-15）：https://learn.microsoft.com/en-us/windows/wsl/wsl-config
- [psdirect] PowerShell Direct：https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct
- [agentic] Experimental Agentic Features：https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features
- [kb] KB5124008（2026-09-08，build 26200.9445 / 26100.9445）：https://support.microsoft.com/en-us/servicing/os/windows-11/2026/09/kb5124008-windows-11-24h2-25h2-security-update

**OpenAI Codex**（openai/codex @ `d27764b82f7118f674371e6d6e76271d9d606edb`，rust-v0.160.1）

- [cx-doc] Windows sandbox 文档（developers.openai.com/codex/windows 现重定向到这里）：https://learn.chatgpt.com/docs/windows/windows-sandbox
- [cx-token] 受限令牌标志与 restricting SIDs 顺序：https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/token.rs#L468-L513
- [cx-lib] unelevated 后端拒绝只读 / deny-read；根进程退出后保留后代：https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/lib.rs#L715-L726 、https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/lib.rs#L850-L875
- [cx-id] `LogonUserW` 登录沙箱用户：https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/identity.rs#L185-L230
- [cx-runner] elevated runner 的令牌与私有桌面：https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/bin/command_runner/win.rs#L270-L305
- [cx-fw] 离线用户的防火墙规则：https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/setup_provisioning/firewall.rs#L35-L50
- [cx-wfp] WFP 过滤器清单（ICMP / DNS / SMB）：https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/wfp/filter_specs.rs
- [cx-setup] 默认读根与用户目录排除项：https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/setup.rs#L59-L78
- [cx-job] Job 标志与 `spawn_contained`：https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/utils/pty/src/win/job.rs

**Anthropic**

- [SRT readme] sandbox-runtime README，Windows (alpha) 一节：https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/README.md#windows-alpha
- [SRT token] srt-win 的令牌构造：https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/vendor/srt-win-src/src/token.rs#L1-L25
- [SRT ambient] 人人可写目录的 deny 清单，以及不处理盘根的理由：https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/vendor/srt-win-src/src/ambient.rs#L1-L28
- [cc-doc] Claude Code 沙箱文档（2026-10-07 抓取）：https://code.claude.com/docs/en/sandboxing

**Microsoft MXC**（microsoft/mxc @ `13d899cbace5631e07aa6c4f30c2f04d801d110f`）

- [MXC readme] README：https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/README.md
- [MXC os] ProcessContainer 各 OS 版本支持矩阵：https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/backends/process-container/os-version-support.md
- [MXC hostprep] 主机准备 `wxc-host-prep.exe`：https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/backends/process-container/host-prep.md
- [MXC net] ProcessContainer 网络：https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/backends/process-container/networking.md
- [MXC wsb] Windows Sandbox 后端：https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/backends/windows-sandbox/windows-sandbox.md
- [MXC sdk] Node SDK README：https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/sdk/node/README.md
- [MXC iso] IsolationSession 一次性执行设计：https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/development/architecture/backends/isolation-session/oneshot.md

**其他 agent 与工具**

- [VSC mxc] VS Code 的 Windows MXC 运行时：https://github.com/microsoft/vscode/blob/4d10e715a2e7168de12ff6ceae3a15c653f210c1/src/vs/platform/sandbox/common/terminalSandboxMxcRuntime.ts
- [VSC pkg] VS Code package.json（`@microsoft/mxc-sdk` 1.0.0）：https://github.com/microsoft/vscode/blob/4d10e715a2e7168de12ff6ceae3a15c653f210c1/package.json
- [vsc-doc] VS Code：Sandbox agent terminal commands（页面日期 2026-09-30）：https://code.visualstudio.com/docs/agents/run/agent-sandboxing
- [OC mxc] OpenClaw MXC 插件 README：https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/mxc/README.md
- [OC modes] OpenClaw 沙箱模式与后端：https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/sandboxing/modes-scope-and-backend.md
- [GEM doc] Gemini CLI 沙箱文档：https://github.com/google-gemini/gemini-cli/blob/573846625af9e93b3b968e0e0b86bb093a4c9b16/docs/cli/sandbox.md
- [GEM cs] Gemini CLI 的 Windows helper：https://github.com/google-gemini/gemini-cli/blob/573846625af9e93b3b968e0e0b86bb093a4c9b16/packages/core/src/sandbox/windows/GeminiSandbox.cs
- [cursor] Cursor：agent sandboxing（2026-02-18）：https://cursor.com/blog/agent-sandboxing
- [devin] Devin CLI：Sandbox（2026-10-07 抓取）：https://docs.devin.ai/cli/sandbox
- [UV] libuv v1.51.0 `src/win/process.c`（全局 job 的标志与注释，第 68–120 行、第 1050–1100 行）：https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c#L68-L120
- [chromium] Chromium Sandbox 设计文档（integrity levels 一节）：https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md
- [pz] Project Zero：Understanding Network Access in Windows AppContainers（2021-08）：https://projectzero.google/2021/08/understanding-network-access-windows-app.html
- [sbie] Sandboxie-Plus 仓库（v1.18.5，2026-09-25）：https://github.com/sandboxie-plus/Sandboxie
- [sbie-lic] Sandboxie-Plus 许可：https://github.com/sandboxie-plus/Sandboxie/blob/master/LICENSE.Plus
- [sbie-start] Sandboxie Start 命令行：https://sandboxie-plus.com/sandboxie/startcommandline/

**第三方实测与分析**（不是一手权威，只作旁证）

- [oxbox] oxbox PR #34：在 25H2 上实测 Windows Sandbox 与 wsb（2026-09-04）：https://github.com/curtisgalloway/oxbox/pull/34
- [yaah] YAAH issue #85：Windows Sandbox 启动和命令往返计时（2026-09-22）：https://github.com/elboaf/YAAH/issues/85
- [originhq] MXC Internals（2026-06-04）：https://www.originhq.com/research/mxc-execution-containers-internals

**本地**

- `~\.codex\.sandbox\sandbox.log`、`~\.codex\.sandbox\setup_marker.json`、`~\.codex\sandbox.log`、`~\.codex\config.toml`（只读；没有读 `.sandbox-secrets` 和 `auth.json`）
- 本目录的 [08-local-infra.md](08-local-infra.md)：LSM 的自启方式、job 连坐、ADR-0005

<!-- 引用标签的链接定义（正文里的 [标签] 指向这里） -->
[wsb-ov]: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/
[wsb-inst]: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install
[wsb-cfg]: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
[wsb-cli]: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli
[ac-iso]: https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
[upta]: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
[crt]: https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken
[mic]: https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control
[job]: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
[fw-rule]: https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule
[fw-rules]: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules
[wsl-cfg]: https://learn.microsoft.com/en-us/windows/wsl/wsl-config
[psdirect]: https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct
[agentic]: https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features
[kb]: https://support.microsoft.com/en-us/servicing/os/windows-11/2026/09/kb5124008-windows-11-24h2-25h2-security-update
[cx-doc]: https://learn.chatgpt.com/docs/windows/windows-sandbox
[cx-token]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/token.rs#L468-L513
[cx-lib]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/lib.rs#L715-L726
[cx-id]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/identity.rs#L185-L230
[cx-runner]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/bin/command_runner/win.rs#L270-L305
[cx-fw]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/setup_provisioning/firewall.rs#L35-L50
[cx-wfp]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/wfp/filter_specs.rs
[cx-setup]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/windows-sandbox-rs/src/setup.rs#L59-L78
[cx-job]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/utils/pty/src/win/job.rs
[SRT readme]: https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/README.md#windows-alpha
[SRT token]: https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/vendor/srt-win-src/src/token.rs#L1-L25
[SRT ambient]: https://github.com/anthropics/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/vendor/srt-win-src/src/ambient.rs#L1-L28
[cc-doc]: https://code.claude.com/docs/en/sandboxing
[MXC readme]: https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/README.md
[MXC os]: https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/backends/process-container/os-version-support.md
[MXC hostprep]: https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/backends/process-container/host-prep.md
[MXC net]: https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/backends/process-container/networking.md
[MXC wsb]: https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/backends/windows-sandbox/windows-sandbox.md
[MXC sdk]: https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/sdk/node/README.md
[MXC iso]: https://github.com/microsoft/mxc/blob/13d899cbace5631e07aa6c4f30c2f04d801d110f/docs/development/architecture/backends/isolation-session/oneshot.md
[VSC mxc]: https://github.com/microsoft/vscode/blob/4d10e715a2e7168de12ff6ceae3a15c653f210c1/src/vs/platform/sandbox/common/terminalSandboxMxcRuntime.ts
[VSC pkg]: https://github.com/microsoft/vscode/blob/4d10e715a2e7168de12ff6ceae3a15c653f210c1/package.json
[vsc-doc]: https://code.visualstudio.com/docs/agents/run/agent-sandboxing
[OC mxc]: https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/extensions/mxc/README.md
[OC modes]: https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/sandboxing/modes-scope-and-backend.md
[GEM doc]: https://github.com/google-gemini/gemini-cli/blob/573846625af9e93b3b968e0e0b86bb093a4c9b16/docs/cli/sandbox.md
[GEM cs]: https://github.com/google-gemini/gemini-cli/blob/573846625af9e93b3b968e0e0b86bb093a4c9b16/packages/core/src/sandbox/windows/GeminiSandbox.cs
[cursor]: https://cursor.com/blog/agent-sandboxing
[devin]: https://docs.devin.ai/cli/sandbox
[UV]: https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c#L68-L120
[chromium]: https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md
[pz]: https://projectzero.google/2021/08/understanding-network-access-windows-app.html
[sbie]: https://github.com/sandboxie-plus/Sandboxie
[sbie-lic]: https://github.com/sandboxie-plus/Sandboxie/blob/master/LICENSE.Plus
[sbie-start]: https://sandboxie-plus.com/sandboxie/startcommandline/
[oxbox]: https://github.com/curtisgalloway/oxbox/pull/34
[yaah]: https://github.com/elboaf/YAAH/issues/85
[originhq]: https://www.originhq.com/research/mxc-execution-containers-internals
