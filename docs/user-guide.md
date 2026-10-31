**中文** | [English](user-guide.en.md)

# 二狗用户手册

这份手册讲怎么装、怎么用、怎么设置、出了问题怎么办。二狗是什么、有什么亮点见仓库首页的 [README](../README.md)；想改代码、写插件见[开发者指南](developer-guide.md)。

> 一行命令安装、`ergo` 命令和网页里的首次设置向导都能用了。但公开发布地址还没开（Release 还没发），所以 2.1、2.2 里的命令要在发布之后才通；在那之前用[从源码安装](#23-从源码安装现在就能用)，功能一样。

## 目录

1. [装之前](#1-装之前)
2. [安装](#2-安装)
3. [第一次打开](#3-第一次打开)
4. [日常怎么用](#4-日常怎么用)
5. [设置和配置文件](#5-设置和配置文件)
6. [从外网访问（手机、平板）](#6-从外网访问手机平板)
7. [手机上用](#7-手机上用)
8. [可选功能](#8-可选功能)
9. [备份和恢复](#9-备份和恢复)
10. [更新、停用、卸载](#10-更新停用卸载)
11. [出问题怎么办](#11-出问题怎么办)

---

## 1. 装之前

**二狗由两个进程组成**，都跑在你自己的电脑上：

| 进程 | 是什么 | 默认地址 |
|---|---|---|
| 二狗守护进程（`ergo-daemon`） | 二狗本身：管 agent、存数据、提供网页 | 本机端口 `http://127.0.0.1:8810/`；外网端口 8811（只给隧道、Tailscale 这类入口用） |
| 服务管家（`packages/supervisor`，命令叫 `lsm`） | 一个小而稳的看门进程：开机自启、拉起二狗、被杀后拉回、看日志 | `http://127.0.0.1:7420/` |

二狗自己不启动任何常驻服务，都交给服务管家托管。两个进程分开，是因为二狗是最常重启的那个，不能自己托管自己。

**要求**

- **只支持 Windows 10 / 11**。二狗靠的是 Windows 才有的东西（Job 对象、目录联接、Windows 沙箱、计划任务）；在别的系统上起守护进程，它只说一句不支持就退出。
- **Node.js 22**（≥ 22.19）。二狗的 Node 大版本跟着它的 agent 核心 [pi](https://github.com/earendil-works/pi) 走（[ADR-0031](adr/0031-node-version-follows-pi.md)），自动测试也只跑这一个版本。一行命令安装会自带 Node，不用你装。
- **一个大模型的 API key**：现在是 [DeepSeek](https://platform.deepseek.com/)（也可以换成别家的 OpenAI 兼容服务商，见 [5.5](#55-模型)）。没配也能先起来、打开网页看看，跟它说话时它会提醒你去配。
- **磁盘**：程序几百 MB；语义检索的向量模型约 570 MB；语音识别的模型 1–2 GB（都是可选的）。

**可选**（不装也能用，对应的功能先关着）

| 装了什么 | 能多什么 | 见 |
|---|---|---|
| Git for Windows | agent 跑 bash 命令（任务里常用）、从源码安装 | [2.3](#23-从源码安装现在就能用) |
| Python + faster-whisper，最好有 NVIDIA 显卡 | 按住说话，在本机识别 | [8.1](#81-按住说话本机语音识别) |
| audio.cpp 语音合成服务 | 二狗用语音回话 | [8.2](#82-二狗用语音回话本机语音合成) |
| Chrome 或 Edge | agent 联网搜索、读网页 | [8.4](#84-联网搜索读网页) |
| Tailscale，或一台 VPS | 手机、平板从外面访问 | [第 6 节](#6-从外网访问手机平板) |
| 本机登录好的 Claude Code | 让项目、任务的负责人用你自己的 Claude Code 订阅干活 | [8.6](#86-claude-code) |
| DevEco Studio 和一台鸿蒙手机 | 鸿蒙原生 App | [7.2](#72-鸿蒙-app) |

---

## 2. 安装

### 2.1 一行命令安装（推荐）

在 PowerShell 里：

```powershell
irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1 | iex
```

它会：找到最新版本（GitHub Releases 和 npmmirror 两边挑快的）→ 下载打好的安装包（自带 Node，不用 `npm`、不用构建）→ 校验签名和文件的 sha256 → 解到 `%LOCALAPPDATA%\Programs\ergo\versions\<版本>`、把 `current` 写成一行文本指向在用的那份 → 把 `bin` 加进用户 PATH（不要管理员权限）→ 把二狗起来。接着浏览器打开 <http://127.0.0.1:8810/>，在网页里走向导（见[第 3 节](#3-第一次打开)）。你的数据放在 `%USERPROFILE%\.ergo`，和程序分开，升级、重装都不动它。

`irm … | iex` 传不了参数，要传就把脚本取下来再跑：

```powershell
& ([scriptblock]::Create((irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1))) -FromSource
```

参数有：`-FromSource`（不下安装包，下源码包自己装；`-Ref <标签或分支>` 指定装哪一版）、`-NodeVersion <版本>`（只放行测过的 Node）、`-UseSystemNode`（用机器上那份 Node，不用自带的）、`-Mirror cn`（强制走 npmmirror，国内快）、`-NoPath`（不改 PATH）、`-NoOnboard`（装完不把二狗起来）。

### 2.2 用 npm 安装（已经有 Node 22 的）

```powershell
npm i -g ergo-ai
ergo start
```

装好后命令照样叫 `ergo`。npm 包和 Release 是一起发的，发布之前这一节还装不上；装好以后浏览器打开 <http://127.0.0.1:8810/> 走向导。

### 2.3 从源码安装（现在就能用）

下面用这几个目录举例，换成你自己的就行：

| 举例的路径 | 是什么 |
|---|---|
| `D:\apps\node22\node.exe` | 给二狗专用的一份 Node.js |
| `D:\apps\ergo` | 二狗的代码（服务管家就在它的 `packages\supervisor` 里） |
| `%LOCALAPPDATA%\ergo\supervisor` | 服务管家的数据目录（服务清单、账本、日志、它自己的密钥） |
| `%USERPROFILE%\.ergo` | 二狗的数据目录（第一次启动时自动建） |

**第 1 步：准备 Node 和 Git**

- 装 [Git for Windows](https://git-scm.com/)。
- 到 [nodejs.org](https://nodejs.org/) 下 Node 22 的 Windows zip 包，解压到一个固定目录（比如 `D:\apps\node22\`）。给二狗**单独放一份**：PATH 怎么变都不影响它，也不会被别的程序升级掉。下面的命令用 `node`、`npm` 时，确认用的是这一份（`node -v` 应当是 v22.x）。

**第 2 步：拿代码、装依赖、构建网页**

```powershell
cd D:\apps
git clone https://github.com/catmaniii/ergo.git
cd ergo
npm ci                  # 严格按 package-lock.json 装依赖
npm run build:web       # 构建网页，产物是 packages\web\dist\index.html
```

- 用普通的检出目录，不要用 git worktree。
- 守护进程是 TypeScript 源码直接跑（Node 的类型剥离），只有网页要构建。

**第 3 步：起服务管家**

```powershell
cd D:\apps\ergo\packages\supervisor
$data = "$env:LOCALAPPDATA\ergo\supervisor"
New-Item -ItemType Directory -Force $data | Out-Null
Copy-Item -Recurse examples\registry "$data\registry"
notepad "$data\registry\manager.yaml"    # 把 projectRoots 改成你放代码的目录
node bin\lsm.mjs validate               # 只校验注册表，不碰任何进程
node bin\lsm.mjs install-autostart      # 登录 Windows 时自动在后台起服务管家（不弹窗口）
Start-ScheduledTask -TaskName LocalServiceManager   # 现在就起来（或者注销再登录）
```

浏览器打开 <http://127.0.0.1:7420/> 能看到服务管家的页面就好了。下文的 `lsm` 都是指在 `D:\apps\ergo\packages\supervisor` 里跑 `node bin\lsm.mjs`。服务管家的更多用法（场景、口令、哨兵……）见它的 [README](../packages/supervisor/README.md)。

> 装了一行命令安装的版本以后，`ergo start / stop / status / logs` 管二狗自己，`ergo svc <子命令>` 原样转给服务管家（`ergo svc status` = `lsm status`）。

**第 4 步：放好 API key**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ergo\secrets" | Out-Null
Set-Content -NoNewline -Encoding ascii "$env:USERPROFILE\.ergo\secrets\deepseek-api-key.txt" "sk-你的key"
```

- 文件里只有 key 这一行。服务管家把它读出来交给守护进程；数据目录的 `secrets` 区任何 agent 都读不到。
- **不要把 key 放进仓库**，也不要写进服务管家的注册表。
- 也可以不碰命令行：二狗的网页打开以后，在**首次设置向导**的「模型 Key」那一步，或者**设置 · 模型**里，把 key 填进密码框、点「保存 key」。它会写进同一个文件（`secrets\deepseek-api-key.txt`，目录和文件都按最紧的权限建），保存后下一个新会话就能用，不用重启；以后想换也在同一处改。手动放文件这个办法留着兜底——网页打不开、或者想用别的数据目录时还用得上。
- 想换成别家的模型（自定义的 OpenAI 兼容服务商），key 放在 `secrets\custom-model-api-key.txt`，环境变量是 `CUSTOM_MODEL_API_KEY`；怎么填见 [5.5](#55-模型)。

**第 5 步：把守护进程登记给服务管家**

1. 复制样例：

   ```powershell
   copy D:\apps\ergo\deploy\lsm\ergo-daemon.example.yaml "$env:LOCALAPPDATA\ergo\supervisor\registry\services\ergo-daemon.yaml"
   ```

2. 用文本编辑器打开刚复制的文件，把三个占位符换成本机的值，换完文件里不应再有 `<…>`：

   | 占位符 | 换成 | 例子 |
   |---|---|---|
   | `<仓库路径>` | 二狗的代码目录 | `D:\apps\ergo` |
   | `<专用 Node 路径>` | 第 1 步那份 Node 的 `node.exe` | `D:\apps\node22\node.exe` |
   | `<用户主目录>` | 你的用户目录（数据目录在它下面的 `.ergo`） | `C:\Users\你的用户名` |

   再看三处：没装语音合成服务的，删掉 `dependsOn:` 那一段（软依赖，删了不影响启动）；改了本机端口的（[5.2](#52-配置文件-ergojson)），把条目里两处 `8810` 一起改；文件末尾注释掉的 `exposure:` 是 VPS 公网入口，先别动（[6.3](#63-方式三vps--ssh-反向隧道--nginx公网)）。

3. 校验、启动、打开开机自启：

   ```powershell
   cd D:\apps\ergo\packages\supervisor
   node bin\lsm.mjs validate               # 有错会写明是哪一项
   node bin\lsm.mjs reload                 # 让在跑的服务管家重新读注册表
   node bin\lsm.mjs start ergo-daemon
   node bin\lsm.mjs status                 # 等 ergo-daemon 变成 RUNNING，档位 linked
   node bin\lsm.mjs autostart ergo-daemon on
   ```

- 守护进程接入服务管家以后，健康和"忙不忙"由它自己报：有任务在执行时显示"忙"，"等空闲再停"会等它做完。
- 守护进程的输出在服务管家数据目录的 `logs\ergo-daemon.out.log`，也能在服务管家的网页里实时看。
- 被杀、崩溃后服务管家会按退避重新拉起；重启后正在做的事按规则接着做，说不清做没做完的操作会转给你确认，不会悄悄重做。

---

## 3. 第一次打开

### 3.1 设置向导

地址是 `#/more/setup`，也在 **更多 · 设置** 列表最上面一行「设置向导」。五步走完：语言 / 称呼 / 助手名 → 模型 Key → 组件（语义检索的向量模型，能当场下）→ 手机扫码配对 → 安全默认值说明；五步后面还有一屏"外网访问"，把[第 6 节](#6-从外网访问手机平板)的三种方式各说一遍。每一步都能点「以后再说」先放着；全部做完显示"设置完了"。以后随时能从设置里重进。

还没配好模型 Key 时，会话页顶上有一条引导条（点右边的 × 关掉，这台设备上记住、以后不再出现）。

### 3.2 不用向导的做法

在这台电脑上用浏览器打开 <http://127.0.0.1:8810/>。从本机端口进来的自动信任，不用配对。

1. **更多 · 设置 · 模型**：点"连通测试"，确认 key 能用。
2. **更多 · 设置 · 角色与声音**：给个人助理起个名字；**外观与风格**里挑一套界面风格。
3. **跟它说句话试试**：比如"两分钟后提醒我喝水"。聊天里会出一张提醒卡，到点时页面顶上会提示，待办里也有一条。

**新装时两样是收紧的**（在 **更多 · 设置 · 关注类别** 最上面，嫌烦可以自己关，改了马上生效）：

- **有风险的事先问我**（开着）：对话里要做有风险的事（读写它工作区以外的文件、往外发东西……）先出一张审批卡，你批了才做；任务做计划里没授权的事也先问你。关掉后这些大多直接做、照常记下来，只有特别敏感的（以你的名义往外发、账户和密码、不可逆的提交、删改工作区以外的文件）还问你。
- **任务超预算就停下**（开着）：任务某一步的用量超过计划里的预算时先说明进展，超过两倍就停下等你，可以追加预算接着做。关掉后只记用量、不停。

这两样存在配置文件的 `guard.conversationApprovals`、`tasks.thresholds.budgetControl` 里：守护进程第一次起来时写进去，之后就是普通配置。

---

## 4. 日常怎么用

界面按手机竖屏优先设计，宽屏换成多列布局。主导航：**秘书、任务、项目、待办、浏览、日历、更多**（消耗、记忆、设置都在"更多"里，宽屏上直接在竖栏里）。

### 4.1 秘书

秘书是你的个人助理（名字你起），只负责听懂你、帮你传话、派活，自己不动你的项目。

- 打字或按住说话都行；长回复可以让它念给你听。
- 一步就能办完的（提醒、记住一件事、查一下）它直接办；要花时间的它帮你发起任务或项目，交给专门的负责人。
- 负责人有进展会写信给秘书，来信在秘书那里折成一行，由秘书统一转告你。
- 输入框里打 `/` 有斜杠命令（每条都有说明和参数提示）。

### 4.2 任务：三种做法 × 三种触发

点 **发起任务**（或者直接跟秘书说）：

| 做法 | 适合 | 怎么做 |
|---|---|---|
| 普通任务 | 下个视频、查点资料 | 交给后台 agent 直接做，做完秘书转告你 |
| 流程 | 每天固定这么几步 | 事先排好步骤，一次授权，之后每次运行都逐步核对、偏了自动修回 |
| 长程任务 | 写个工具、做份调研 | 分阶段执行、逐阶段验收，执行中可以改计划 |

触发方式：**现在做一次**；**定时**（可以"按我的工作日"，中国和新加坡的节假日、调休都算进去）；**事件**（某个任务做完、某个文件夹来了新文件……）。在要做什么里直接写"每周一早上 8 点……"，时间表就照你写的定。

**长程任务怎么放心交出去**：

- 负责人先交一张**计划卡**：分几个阶段、每个阶段交付什么、怎么验收、要用哪些工具、预先批准哪些操作（种类、范围、次数、有效期）。你确认一次就是授权，可以勾掉或收窄某一项。
- 执行中每个阶段先过脚本检查，再交给独立的评审 agent 验收；计划外的动作会被标出来、能修的自动拉回。
- 要改计划时只停受影响的阶段，你在计划变更卡上确认一次。
- 守护进程被杀、电脑重启后从断的地方接着做。

### 4.3 项目

项目是长期的事（一个网站、一个工具），有档案（立项书、规格、进展）、工作目录、固定的负责人。负责人的工作按工单排队，一次做一件；每张工单结束后另一个模型检查它有没有做范围外的事。首版做完由你拍板：转入使用、继续建设，或放弃并归档。项目上线成服务以后，服务由服务管家托管，在二狗的内置浏览器里就能打开它的页面。

### 4.4 待办

要你拍板的事都汇总在这里：审批、计划确认、卡住求助、配对请求、到点的提醒……有时限的排在前面。在它所在的会话里也能直接点掉。

### 4.5 时间线三层缩放

任务、项目、秘书的会话都能双指捏合（电脑上按住 Ctrl 滚滚轮，或者点标题栏的按钮）缩放：**对话层**看全文、**要点层**每条一行、**全局层**整件事一根色条。缩小以后，审批、拉回、验收、关注类别命中这些标记钉在页边，连线指到出事的位置。

### 4.6 工具调用详情和花费

- 点开会话里的任何一次工具调用：做了什么、落在哪个关注类别、按什么处置、在不在授权内、实际改了什么，都用大白话写清。
- **更多 · 消耗**：token 账本逐笔记下每次模型调用，记在哪个任务、哪个阶段、哪个 agent 名下，按单价估算成本。

### 4.7 记忆

二狗把你说过的每句原话存一份在本机（不能改，建好了关键词和向量索引），每天凌晨 3 点由**记忆管理员**整理成带证据的结论。

- 这一套是**插件**，界面上叫**记忆模块 · 会意**（英文 Memory Module · Subtext），顶上标着**实验性**：还在打磨，行为和存下的数据结构都可能变。数据都在本机；随时能在 设置 · 插件 里停用（数据留着，启用回来还在），要删就去 记忆 · 素材 成批删除，或者在那里移除它、勾上连它的数据一起删。
- **更多 · 记忆**：档案（你和家人的基本资料）、结论（每条都能点开看证据、支持和反证、竞争解释、修订记录）、问题箱、素材。
- 拿得准的结论秘书会用上；拿不准的会在方便时顺口问你一句。
- 想让它专门记一件事，直接对秘书说"**帮我记一句：……**"——它按你的原话存下来（标成"手动记的"），以后检索能搜到、能点回原话。
- 说"忘掉……""这个别推断"也照旧；也可以在记忆页里纠正、删除，彻底删除会连同引用它的地方一起抹掉。
- 想深聊或者改记忆，直接找记忆管理员（记忆页最上面"和记忆管理员聊"）。它也会约你做"了解你访谈"，一次一个主题，可以随时拒绝。

### 4.8 日历、提醒、内置浏览器

- **日历**：两地的工作日和节假日、手动标记、当天的提醒、定时任务和每次运行；手机日历、Google 日历等外部日历也能接进来（数据源插件）。
- **提醒**：跟秘书说就行，提醒卡上能改时间、取消；到点在页面顶上提示，鸿蒙手机上走系统通知。
- **浏览**：内置浏览器，能打开项目服务的页面、渲染附件；在网页的输入框上点悬浮按钮，可以让二狗帮你填。

### 4.9 插件

**更多 · 设置 · 插件** 里能看到装了哪些插件、停用、启用、移除（热插拔，不用重启）。现在自带：提醒、记忆、日历、语音、内置浏览器、Claude Code、Google、Looki、手机。停用一个插件只会让它的页面和工具消失，以前的数据还在；移除时可以选连数据一起删。

---

## 5. 设置和配置文件

### 5.1 设置页

**更多 · 设置** 分四组：

| 组 | 有哪些 |
|---|---|
| 身份 | 我的名字、个人档案、角色与声音（助理的名字和音色）、语言、外观与风格、语音 |
| 能力 | 模型、skill 和 MCP、插件、组件（按需下载的大件）、Claude Code、浏览与填框 |
| 规矩 | 关注类别（哪些操作要提醒你、怎么处置）、系统提示、工作日规则 |
| 数据 | 数据源、删除素材、工具调用的完整内容、备份、已配对设备、体检、关于二狗 |

**关注类别**是二狗守卫的核心：内置的有花钱、以你的名义对外发送、删除或覆盖、不可逆的提交、账户与安全、越出项目目录等，也能自定义。每类有六档处置：直接做只记录、做完告诉我、计划里列了才做、先问我、交给我做、永不。

### 5.2 配置文件 `ergo.json`

配置是可选的，不写就全用默认值。要改哪项，把仓库里的 `config\ergo.example.json` 复制成 `%USERPROFILE%\.ergo\config\ergo.json`，只留要改的项（带 `<…>` 的是占位符，用到就换成真值，用不到就删掉）。改完重启守护进程生效（设置页里能改的项改了马上生效）。常用的几项：

| 项 | 管什么 | 默认 |
|---|---|---|
| `ports.local` / `ports.external` | 本机端口、外网端口（都只听 127.0.0.1） | 8810 / 8811 |
| `guard.conversationApprovals` | 对话里有风险的事先问我（`"on"` / `"off"`） | 新装 `"on"` |
| `tasks.maxRunning` | 最多几个任务同时执行 | 3 |
| `tasks.thresholds` | 拉回几次停下、多久没进展算停滞、预算超几倍停下…… | 见样例 |
| `agents.maxLive` | 同时存活的 agent 子进程上限 | 8 |
| `approvals.waitMinutes` | "先问我"时一次调用最多等你几分钟 | 5 |
| `voice.recognizer.python` | 装了 faster-whisper 的 `python.exe` | PATH 上的 `python` |
| `voice.speech.url` / `voice.speech.model` | 语音合成服务的地址和模型 | `http://127.0.0.1:8090` |
| `web.browserPath` | 联网用的 Chrome / Edge，不写就自动找 | — |
| `backup.time` / `backup.syncDir` / `backup.schedule` | 每晚备份的时刻、另存一份的同步目录、谁来定时 | 03:30 / 不另存 / `"internal"` |
| `memory.maxModelCalls` / `memory.enabled` | 每晚整理最多调几次模型、这台机器跑不跑整理 | 200 / `true` |
| `media.maxUploadBytes` | 单个上传文件的上限 | 200 MB |
| `timeZone` | 发给模型的时间标记按哪个时区（一般不写） | 本机时区 |
| `plugins.disabled` | 停用的插件（设置 · 插件里点的会写在这里） | 空 |
| `publicAccess` | VPS 公网入口（只有部署命令读，[6.3](#63-方式三vps--ssh-反向隧道--nginx公网)） | — |

### 5.3 数据目录

数据目录默认是 `%USERPROFILE%\.ergo`（环境变量 `ERGO_DATA_DIR` 可以换），各区各有归宿：

| 目录 | 放什么 |
|---|---|
| `config\` | 配置：`ergo.json`、模型设置、关注类别、语言、系统提示、MCP 登记、工作日历 |
| `db\` | 事件日志 `ergo.db`（唯一真相）、素材库 `materials.db`（老版本叫 `memory.db`，起一次就自动改名） |
| `memory\subtext\` | 会意（记忆插件）自己的数据：推理库 `rg.db`（老版本放在 `db\` 里的，起一次就自动搬过来） |
| `secrets\` | 密钥（任何 agent 都读不到；网页里填的 key 写在这里；服务管家启动时读出来交给守护进程） |
| `materials\` | 原话副本、媒体、附件 |
| `sessions\`、`projects\` | agent 的会话、项目的档案和工作目录 |
| `models\`、`components\` | 向量模型、按需下载的组件（不进备份，能重新下） |
| `locales\` | 你自己放的语言文件（[5.4](#54-语言)） |
| `backups\` | 每晚的快照 |
| `logs\`、`tmp\`、`cache\` | 日志、临时文件、缓存 |

**仓库里只放框架**：记忆、对话、档案、密钥这些个人数据永远不进仓库。

### 5.4 语言

二狗自带中文和英文：**更多 · 设置 · 语言 / Language** 里换，所有设备一起换，秘书和负责人也改用这种语言回答。以前的聊天保持原来的语言。

想加一种语言或改某句译法，不用改代码：把仓库里的 `packages\protocol\locales\en` 整个复制到 `%USERPROFILE%\.ergo\locales\<语言代码>\`（比如 `fr`），改 `_meta.json`（`nativeName` 这种语言自己的叫法、`modelName` 告诉模型用什么语言、`intlLocale` 日期数字用的区域码），再翻译每个 `.json` 里冒号后面的句子（`{name}` 这种花括号原样留着；`_one` / `_other` 是单复数）。两秒内设置里就多了这种语言，没翻完的句子用中文补。只改某句译法：在 `locales\<语言代码>\` 里放一个只写那几句的 `.json`。放坏了不要紧，设置 · 语言里会逐条写出哪个文件哪里错了；也可以在仓库根目录跑 `npm run i18n:check` 查漏。

### 5.5 模型

模型都在服务端（二狗守护进程这台电脑）调用，网页上只是设置。这些设置存在数据目录的 `config\model-settings.json`（受保护区域，agent 写不进），各设备看到的一样。

**这一页从上到下五块**：**服务商**（DeepSeek 或自定义，选了自定义才展开接口地址、模型 id、接口类型）→ **API key**（每个服务商一行，最下面是连通测试）→ **默认模型**（和思考档位）→ **各个 agent**（各自用什么模型）→ **看图能力**（每个模型能不能看图）。选了自定义服务商时，后面几块会收起（原因见下面第 5 条和第 7 条）。

**默认用 DeepSeek**：DeepSeek V4.1 Flash、思考档位高，秘书、维护者、子 agent、评审、范围审视都用它。**设置 · 模型** 里能改默认模型、按 agent 覆盖、给每一行选思考档位，也能定某个模型能不能看图。

**换成自定义（OpenAI 兼容）服务商**（**设置 · 模型** 最上面「服务商」那一块，或者**首次设置向导**的「模型 Key」那一步——两处是同一块界面）：

1. 服务商选「**自定义（OpenAI 兼容）**」。
2. **接口地址**：填到 `/v1` 这一层，比如 `https://api.openai.com/v1`。模型请求发到它下面（`/chat/completions` 或 `/responses`，看第 4 步），列模型是它下面的 `/models`。
3. **模型 id**：知道就手填；不知道就点「**拉取列表**」——守护进程带着 key 去 `GET {接口地址}/models` 列一遍，从下拉里挑一个（也可以点「还是手填」）。列不出来（key 不对、地址不对、那家不支持）会把原因原样写出来，照样能手填。
4. **接口类型**：`OpenAI chat completions`（`POST {接口地址}/chat/completions`，默认，别家兼容 OpenAI 的多半是这个），或者 `OpenAI responses`（`POST {接口地址}/responses`）。不确定就照默认。
5. **API key**：同一页下面的「API key」那块**按服务商逐条列出**——DeepSeek 一行、自定义（OpenAI 兼容）一行，各有一个输入框和「保存 key」；每行写着它配没配、key 是从哪个环境变量/哪个文件来的（内容不显示）。**换 key 不用先把它选成当前服务商**：给自定义那一行填就行，写进 `%USERPROFILE%\.ergo\secrets\custom-model-api-key.txt`（DeepSeek 那行写的是 `deepseek-api-key.txt`），当次就生效、不用重启；也可以照[第 4 步](#2-安装)手动放文件（那个环境变量叫 `CUSTOM_MODEL_API_KEY`）。已经是旧版装好、后来才升级上来的，要照样例在服务管家的 `ergo-daemon.yaml` 里补一条 `CUSTOM_MODEL_API_KEY`（`from: file`，`optional: true`，路径指上面那个文件），不然重启守护进程以后这个 key 就不在了（网页上再填一次也行）。
6. 点 **API key 那块底部的「测一下当前服务商」**（首次向导里也在同一个位置）：发一条极短的请求，回通了（带首 token 延迟）或者不通的原因。它测的是设置里**选中**的那个服务商——选着自定义时测的就是第 3 步那个模型 id。

几点要知道：

- **「拉取列表」和点「测一下当前服务商」会先把这一块存进设置**：守护进程按设置里选中的服务商取 key，只有存成"选自定义"以后才拿得到它那份 key。存好会有一句"存好了：下一个新会话起生效"。
- **一个会话固定一个模型**：换服务商、换模型都是下一个新会话起生效；秘书的主线、项目维护者的对话、定时触发的任务在下一轮新开会话、附一份交接摘要（聊天里记一条"已换成 X 模型"）；任务执行中途不换。
- **自定义服务商只有一个模型**：选了自定义时，「默认模型」那里不再重复列模型 id，只写一句"用服务商那里填的模型：X"；默认的思考档位、各个 agent 那一段、看图能力那一段都收起（自定义模型不思考，各个 agent 只有一个模型可选，那家收不收图片二狗不知道）。切回 DeepSeek，这几块都回来，那些行里原来写的模型 id 照旧用。

**哪些东西不跟着换**（换成自定义以后照旧只认 DeepSeek）：

- **记忆的每晚整理**：记忆管理员一直用 DeepSeek（`DEEPSEEK_API_KEY` / `secrets\deepseek-api-key.txt`）。没配 key 那一夜就跳过整理（素材一条不丢，配上了下一夜接着做）。
- **联网搜索、读网页**：走 DeepSeek 自己的搜索、读网页接口，也要 DeepSeek 的 key（浏览器直接搜、Tavily 那几条路不受影响，见 [8.4](#84-联网搜索读网页)）。
- 所以**别把 DeepSeek 的 key 删掉**：换成自定义以后，在网页上给自定义那一行填 key 只动自定义那份文件，不会动 DeepSeek 那份。要给 DeepSeek 换 key，就在「API key」那一块 DeepSeek 那一行直接填、保存（不用先切回 DeepSeek），或者照第 4 步手动放文件。
- **token 单价表只有 DeepSeek**：自定义模型的用量照实际记（输入、输出、缓存），单价按 0 算，**更多 · 消耗** 里它的成本是粗估（算出来是 0），别当成账单。

**自定义模型的能力按估算登记**（这几样在设置里填不了）：

- **只看文字**：按"不知道那家收不收图片"登记成只看文字，聊天里的图片不会以图片交给它。选了自定义时「看图能力」那一块整个收起，只写一句"这家服务商收不收图片，二狗不知道"（切回 DeepSeek 才看得到那些开关，它们只管 DeepSeek 的模型）。
- **不思考**：登记成不支持思考档位，所以设置里思考档位对它不起作用——选了自定义时那些档位直接不显示。
- **上下文窗口 128k、一次最多生成 8192 token**：按常见的 OpenAI 兼容服务估的。你那家比这大就用不满，比这小可能被那家截断或者报错。

**换回 DeepSeek 不会丢东西**：切回 DeepSeek 以后，已经填的接口地址、模型 id、接口类型都留在设置里，key 也还在 `custom-model-api-key.txt`，以后再选「自定义」不用重填。

---

## 6. 从外网访问（手机、平板）

默认二狗只在这台电脑上用（`http://127.0.0.1:8810/`）。要在手机、平板上用，有三种方式，**推荐第一种**。

> **硬规矩**：三种方式都只能接二狗的**外网端口 8811**——那里每个请求都要设备凭证，新设备要你在电脑上批准。**本机端口 8810 绝不能经 Tailscale Serve、隧道或反向代理接出去**：从本机端口来的请求自动信任，接出去等于整个 tailnet（或整个互联网）免认证进你的二狗。

不管哪种方式，新设备第一次打开都会看到配对页：页面上显示设备名、6 位短码和 8 位短指纹 → 电脑上二狗的**待办**里出现一张配对请求卡，核对一致后点批准 → 回到手机上点"进入二狗"。以后在 **更多 · 设置 · 已配对设备** 里能延期、吊销、删除。待批的请求 5 分钟后过期；同一来源 10 分钟内最多申请 5 次。

| | 方式一：Tailscale 官方（推荐） | 方式二：自建 Headscale（进阶） | 方式三：VPS + 隧道 + nginx（公网） |
|---|---|---|---|
| 要什么 | 电脑、手机装 Tailscale，登同一个账号 | 一台 VPS，跑 Headscale | 一台 VPS、域名证书 |
| 谁能打开 | 只有你 tailnet 里的设备 | 只有你 tailnet 里的设备 | 任何浏览器（全靠配对把关） |
| HTTPS 证书 | Tailscale 自带 | VPS 上 certbot 签 | VPS 上 certbot 签 |
| 难度 | 最简单 | 中等 | 最难 |
| 注意 | 登录要 Google / 微软 / GitHub 等账号；中转服务器在海外，国内可能慢 | 可以自建中转，国内快 | 暴露在公网上，陌生人能看到配对页 |

### 6.1 方式一：Tailscale 官方（推荐）

设置向导里那一屏"外网访问"会介绍这三种方式；接 Tailscale 是手动三步：

1. 电脑上装 [Tailscale](https://tailscale.com/download/windows) 并登录；在 Tailscale 的管理后台打开 MagicDNS 和 HTTPS 证书。
2. 让 Tailscale 把本机的 **8811** 用 HTTPS 提供给你的 tailnet（只接 8811）：

   ```powershell
   tailscale serve --bg --https=443 http://127.0.0.1:8811
   ```

3. 手机装 Tailscale、登**同一个账号**，浏览器打开 `https://<电脑的机器名>.<你的 tailnet>.ts.net/`，按上面的步骤配对。

### 6.2 方式二：自建 Headscale（进阶）

适合想自己掌握控制节点、或者要国内快的。一台 Debian / Ubuntu 的 VPS，一条命令装好 [Headscale](https://github.com/juanfont/headscale)（可以再自建 DERP 中转）：

```powershell
lsm vps setup headscale --host root@<VPS 的 IP>    # 在 packages\supervisor 里；搭完 lsm vps status 看通不通
```

电脑和手机的 Tailscale 客户端都登到你自己的 Headscale；服务管家的 **tailnet 入口**给二狗开一个只在 tailnet 里能打开的 HTTPS 地址（VPS 上 certbot 签真证书，Headscale 的 DNS 记录把名字在 tailnet 里指回本机，本机的网关终结 TLS，转到 8811）：

```powershell
node bin\lsm.mjs tailnet ergo-daemon on <名字>
```

每一步做什么见 [vps.md](../packages/supervisor/docs/vps.md) 和服务管家 [README](../packages/supervisor/README.md) 的"可选功能 · tailnet 入口"。**VPS 那一头还没在真 Debian 上验过**（只在 Windows 上跑过电脑这一头），第一次用照文档一步步来。

### 6.3 方式三：VPS + ssh 反向隧道 + nginx（公网）

路径：`https://ergo.<VPS 的 IP>.sslip.io` → VPS 上的 nginx（HTTPS）→ VPS 的 `127.0.0.1:18811` → ssh 反向隧道（`ergo-tunnel`）→ 你电脑上守护进程的外网端口 8811。二狗自己不连 VPS。

一条命令把这套搭好：`lsm vps setup tunnel --host root@<VPS 的 IP>`（在 `packages\supervisor` 里），`lsm vps status` 看通不通；VPS 上原来就有站点的，用 `lsm vps site add` / `site remove` / `certs` / `scan` 接证书和站点，见 [vps-https.md](../packages/supervisor/docs/vps-https.md)。**VPS 那一头还没在真 Debian 上验过。**

不想用那条命令的话，下面每一步都由你来做。

1. **写配置**：在 `ergo.json` 里填 `publicAccess`（照 `config\ergo.example.json`）：VPS 的公网 IP、ssh 用户、ssh 私钥的绝对路径；`nginx.listen`（nginx 直接听 443 的写 `443 ssl`；前面还有一个按域名分流的前门的，写前门转过来的本机端口，比如 `127.0.0.1:8443 ssl`）；`nginx.certificateDir`（现有证书的目录）。
2. **证书**：用你在 VPS 上现有的 Let's Encrypt 做法，把 `ergo.<VPS 的 IP>.sslip.io` 加进证书。
3. **先看一眼**要部署的 nginx 配置：`npm run deploy:nginx -- --print`（只打印，不连 VPS）。
4. **部署**：`npm run deploy:nginx`。它 ssh 到 VPS 写站点配置，`nginx -t` 通过才重载，不通过就恢复原来的配置。
5. **登记隧道**：复制 `deploy\lsm\ergo-tunnel.example.yaml` 到服务管家数据目录的 `registry\services\ergo-tunnel.yaml`，换掉占位符（`<仓库路径>`、`<ssh 私钥路径>`、`<VPS 用户>`、`<VPS 地址>`）；再在 `ergo-daemon.yaml` 里去掉末尾 `exposure:` 那段的注释、换掉 `<VPS 地址>`。然后：

   ```powershell
   node bin\lsm.mjs validate
   node bin\lsm.mjs reload
   node bin\lsm.mjs start ergo-tunnel
   node bin\lsm.mjs autostart ergo-tunnel on
   ```

6. 手机浏览器打开 `https://ergo.<VPS 的 IP>.sslip.io/`，配对。

站在按域名分流的前门后面、前门又没开 `proxy_protocol` 时，nginx 看到的来源都是 127.0.0.1：配对卡上的来源写"经前门转发，无法识别"，配对请求的限频实际上是全局的（仍然安全，只是陌生人刷请求时你自己的配对也要等 10 分钟）。要按真实来源限频，得在前门上开 `proxy_protocol`、把 `nginx.clientAddress` 写成 `$proxy_protocol_addr`，这会影响同一个前门后面的其他站点，由你决定。

---

## 7. 手机上用

### 7.1 浏览器

按[第 6 节](#6-从外网访问手机平板)接好外网访问、配对以后，手机浏览器打开那个地址就是完整的二狗；可以"添加到主屏幕"。服务端更新以后，开着的页面几秒内会提示"有新版本，点一下刷新"。

### 7.2 鸿蒙 App

鸿蒙 App 是一个原生外壳，里面跑同一套网页，另外加了原生录音（按住即录、不占麦克风）、系统通知、文件下载。现在要自己构建、签名：

1. 装 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)；手机打开开发者模式和 USB 调试，用 USB 连上电脑。
2. 在二狗目录里跑一次 `npm run build:harmony`，生成本机的 `frontend\harmony\build-profile.json5`（不进仓库）。
3. 用 DevEco Studio 打开 `frontend\harmony`，File → Project Structure → Project → Signing Configs，登录华为账号，勾上 Automatically generate signature。签名材料都在你本机的 `.ohos\config\`，不进仓库。
4. 再跑 `npm run build:harmony`，得到 `frontend\harmony\entry\build\default\outputs\default\entry-default-signed.hap`。
5. 用 DevEco 自带的 hdc（`<DevEco>\sdk\default\openharmony\toolchains\hdc.exe`）装上：

   ```powershell
   hdc list targets
   hdc -t <设备号> install -r frontend\harmony\entry\build\default\outputs\default\entry-default-signed.hap
   hdc -t <设备号> shell aa start -a EntryAbility -b com.catmaniii.ergo
   ```

6. 第一次打开时填二狗的外网地址（[第 6 节](#6-从外网访问手机平板)），再按页面提示配对。

App 的正式包名是 `com.catmaniii.ergo`（2026-10-30 定；工程里 `app.json5` 已经是它了）。在 DevEco 里 File → Project Structure → Signing Configs 重新点一次"自动生成签名"，之后打出来的包就是这个名字——第 5 步的 `-b` 后面跟着用它。

---

## 8. 可选功能

### 8.1 按住说话（本机语音识别）

1. 装一份 Python（3.9 及以上），在里面装 faster-whisper：`python -m pip install faster-whisper`。有 NVIDIA 显卡、装好 CUDA 时用显卡跑 large-v3；没有就退到 CPU 跑 small 模型。
2. 在 `ergo.json` 里写上这份 Python 的路径：`{ "voice": { "recognizer": { "python": "D:\\apps\\python311\\python.exe" } } }`。
3. 重启 `ergo-daemon`。第一次识别会先加载模型，状态在 **设置 · 语音** 里能看到。

也可以把识别交给服务管家托管的单独服务（`deploy\lsm\ergo-asr.example.yaml`，配置里 `voice.recognizer.mode` 写 `"lsm"`），适合想让它和二狗分开重启的。

语音这两样（识别用的 Python 部分、合成用的 audio.cpp）现在都没有一键装，照上面和 [8.2](#82-二狗用语音回话本机语音合成) 手动配；以后会进 **设置 · 组件**。

### 8.2 二狗用语音回话（本机语音合成）

- 二狗用本机的 [audio.cpp](https://github.com/0xShug0/audio.cpp)（第三方开源的语音合成服务，可选）合成语音。这个服务也交给服务管家托管，登记的 id 是 `audiocpp`，地址 `127.0.0.1:8090`。
- 在 `ergo.json` 的 `voice.speech.model` 里填这个服务上的模型 id；参考音色在 **设置 · 角色与声音** 里选。
- **自带一条默认参考音色「小满」**，装好就有声音，不用先自己录一段导入。第一次启动时数据目录的 voices 区一条参考音色都没有，二狗就把它装进去、设成在用的那个。它和你自己导入的音色一样：能换成别的，也能删掉。删掉以后它不会再自己长回来——想要声音就自己导入一段录音（它是合成出来的，不含任何真人的声音：FireRedTTS3 生成，8.5 秒）。
- 没有它时，语音回复自动退回只发文字，聊天里会有一条说明。

### 8.3 语义检索用的向量模型

**设置 · 组件**里点"安装"，或者在二狗目录里：

```powershell
npm run download-model      # bge-m3 量化版，约 570 MB，放进数据目录的模型区；断了重跑就是续传
```

会自动在 Hugging Face、hf-mirror、ModelScope 里挑快的，走系统代理。没有这个模型时，关键词检索照常能用。

### 8.4 联网搜索、读网页

agent 联网时用本机的 Chrome 或 Edge，会自动找。找不到、或者想指定一个，就在 `ergo.json` 的 `web.browserPath` 里写浏览器 exe 的路径。

### 8.5 skill、MCP 和数据源

- **设置 · skill 和 MCP**：导入 skill，登记 MCP 服务（凭据写成"从环境变量读"，变量在服务管家的 `ergo-daemon` 条目里配），再按项目、按任务配进它们的工具包。
- **设置 · 数据源**：接 Google（日历、联系人）、Looki、手机的数据；有个共用的导入文件夹，放进去的文件由对应的插件收。

### 8.6 Claude Code

本机装好并登录了 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的，可以让项目、任务的负责人用它干活（用你自己的订阅），二狗的守卫照样管着它的每一次工具调用；也能接管你已有的 Claude Code 会话。

它的 Agent SDK（`@anthropic-ai/claude-agent-sdk`）是 Anthropic 自己的许可，不是开源的，二狗把它当**可选依赖**：没装时 **设置 · 插件** 里 Claude Code 写"没装"和怎么装（在二狗目录里运行 `npm install --no-save @anthropic-ai/claude-agent-sdk@<版本>`，版本写在 `packages/daemon/package.json` 的 `optionalDependencies`），装好后点"启用"，别的功能不受影响。

---

## 9. 备份和恢复

- 每晚 03:30，守护进程给数据目录做一份一致性快照，放在数据目录的 `backups\`。电脑那时关着，就在下次启动时补做。
- 在 `ergo.json` 里写 `backup.syncDir`，快照会再复制一份到这个目录——可以放在 NAS、家里的存储或网盘客户端的同步目录里：`{ "backup": { "syncDir": "D:\\NAS同步\\ergo-backup" } }`。
- **马上备份一次**：**设置 · 备份** 里点"立即备份"，或者在二狗目录里跑 `npm run backup`（守护进程开着也行；最后一行写着成没成，日志在数据目录的 `logs\backup.log`）。
- **让别的定时器来跑**：配置里写 `"backup": { "schedule": "external" }`，守护进程就不再自己到点备份，由你的定时器调 `npm run backup -- --scheduled`；连着两天没人备份会提醒你。
- **恢复**：

  ```powershell
  # 在 packages\supervisor 里：先停守护进程
  node bin\lsm.mjs stop ergo-daemon
  # 在二狗目录里：数据目录要和服务管家条目里的一致
  $env:ERGO_DATA_DIR = "$env:USERPROFILE\.ergo"
  D:\apps\node22\node.exe packages\daemon\src\restore.ts --list                   # 看有哪些快照
  D:\apps\node22\node.exe packages\daemon\src\restore.ts 2026-10-15               # 恢复某一天的
  D:\apps\node22\node.exe packages\daemon\src\restore.ts 2026-10-15 --from sync   # 本机那份坏了，从同步目录恢复
  # 回到 packages\supervisor：再启动
  node bin\lsm.mjs start ergo-daemon
  ```

  恢复之前的内容会挪到 `backups\pre-restore-<时间>\`，只留最近 2 份。守护进程没停时，恢复命令会拒绝执行。

---

## 10. 更新、停用、卸载

**一行命令装的**：`ergo update`（新版本装进新目录、二狗空闲时切过去，旧版本留一份）、`ergo rollback`（切回上一个版本）、`ergo uninstall`（撤掉 PATH、服务管家的登记和开机自启，问你要不要删数据）。切哪个版本由安装目录里的 `current`（一行文本）说了算，`ergo version` 看现在跑的是哪一版。

**从源码装的**：

```powershell
cd D:\apps\ergo
git pull
npm ci                  # 依赖有变时
npm run build:web
cd packages\supervisor
node bin\lsm.mjs restart ergo-daemon --when-idle   # 等手上的任务做完再重启
```

- 只改了网页时不用重启守护进程，开着的页面（包括手机上一直开着的鸿蒙 App）几秒内会提示刷新。
- 每个版本改了什么见 [CHANGELOG](../CHANGELOG.md)。

**停用**：

```powershell
node bin\lsm.mjs autostart ergo-daemon off
node bin\lsm.mjs stop ergo-daemon --when-idle
```

服务管家自己的开机自启用 `node bin\lsm.mjs uninstall-autostart` 撤掉。你的数据在 `%USERPROFILE%\.ergo`、服务管家的在 `%LOCALAPPDATA%\ergo\supervisor`，删不删由你决定。

---

## 11. 出问题怎么办

**先做体检**：**更多 · 设置 · 数据与设备 →「体检」**（`#/more/doctor`）一页八项——端口、Node、pi、服务管家、模型的 Key、组件、磁盘、外网入口，每条给出查出来的事实和怎么修，右上角"再查一遍"。查的都是本机的东西：不联网（除了探本机端口）、不调用模型、不改任何设置。

**看日志**：守护进程的输出在服务管家数据目录的 `logs\ergo-daemon.out.log`，服务管家的网页里也能实时看；二狗自己的健康状况：<http://127.0.0.1:8810/healthz>。

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| 守护进程起不来，日志第一行说"只支持 Windows"或 Node 版本不对 | 系统或 Node 不对 | 换 Windows 10 / 11；用 Node 22（≥ 22.19），确认条目里 `<专用 Node 路径>` 指的是它 |
| 起不来，说端口被占 | 8810 / 8811 被别的程序占着（日志里写着程序名和 PID） | 关掉那个程序，或者改 `ports`（同时改条目里两处 8810） |
| 起不来，说同一个数据目录已经有实例在跑 | 手动起过一个、或者旧的没退干净 | 先停掉那个（服务管家的网页、任务管理器），再由服务管家起 |
| 打开页面是 503，提示 `npm run build:web` | 网页还没构建 | 在二狗目录里 `npm run build:web` |
| 跟它说话，它说"还没配模型"或每次都出错 | key 没放、放错了，或者额度用完 | 在**设置 · 模型**里重新填一个 key（或检查 `secrets\deepseek-api-key.txt`，只有 key 一行），再点"连通测试" |
| 任务里的命令总失败，说找不到 Git Bash | 没装 Git for Windows，或 PATH 上排在前面的是 WSL 的 `bash` | 装 Git for Windows；确认 `where bash` 第一条是 `C:\Program Files\Git\bin\bash.exe` |
| 按住说话没反应、识别不可用 | Python 路径没配、没装 faster-whisper、显卡不可用 | 看 **设置 · 语音** 的状态和说明；照 [8.1](#81-按住说话本机语音识别) 配好 |
| 语音回复只有文字 | 语音合成服务没开，或 `voice.speech.model` 还是占位符 | 照 [8.2](#82-二狗用语音回话本机语音合成)；聊天里那条说明会写原因 |
| 记忆里搜不到意思相近的话 | 向量模型没装 | **设置 · 组件**里装，或 `npm run download-model` |
| 手机打不开或一直在配对页 | 外网入口没接好，或请求过期、被限频 | 确认接的是 8811；电脑上**待办**里批准配对请求（5 分钟内有效）；连着失败时等 10 分钟再试 |
| 手机上提示"此设备已被吊销" | 在已配对设备里吊销过 | 点"请求配对"重新申请 |
| 服务管家上二狗亮黄灯（degraded） | 某个启用着的插件没装上 | 看 `/healthz` 的 `reasons`，或 **设置 · 插件** 里那个插件写的原因 |
| 每次备份都说"没写进同步目录" | `backup.syncDir` 还是样例里的占位符，或目录不在 | 改成真实的绝对路径，或者删掉这一项 |
| 联网工具说找不到浏览器 | 本机没有 Chrome / Edge，或装在不常见的位置 | 在 `web.browserPath` 里写浏览器 exe 的路径 |
| 安装或升级时装不下去：安全软件弹"未知发布者"、把进程结束了，或者装好的文件过一会儿不见了 | 360 这类安全软件拦了不认识的新程序（`bin\ergo.exe` 或整个安装目录） | 把 `%LOCALAPPDATA%\Programs\ergo` 加进安全软件的信任区，再装一遍；命令还能跑的话直接用 `bin\ergo.cmd`（和 `ergo.exe` 是同一条命令）；或者改用 npm 装（`npm i -g ergo-ai`，机器上要有 Node 22）。数据在 `%USERPROFILE%\.ergo`，重装不碰 |
| `ergo update` 说切不过去，或者更新完 `ergo version` 还是老版本 | `current` 那行写着哪个版本、`versions\` 里那个版本没装好（拷了一半、手改过） | 看 `%LOCALAPPDATA%\Programs\ergo\current` 里写的是哪个版本、`versions\` 下有没有它、里面的 `ergo.json` 在不在；不对就重跑 `ergo update`，或者重新装一遍（数据不动） |

**报问题**：到 GitHub 上[提一个问题](https://github.com/catmaniii/ergo/issues/new/choose)，照模板填上二狗的版本（**设置 · 关于二狗**）、Node 的版本（`node -v`）、pi 的版本（仓库根目录 `package.json` 的 `overrides`）和安装方式——版本和 Node、pi 这几样在体检页上也能一眼看到。安全问题请不要公开提，见 [SECURITY.md](../SECURITY.md)。

**代码注释里的"N 号票"**：是开发时的内部记录编号，公开版里看不到那些票，不影响理解代码。
