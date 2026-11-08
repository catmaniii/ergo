**中文** | [English](install.en.md)

# 安装、升级和卸载

这一章讲怎么把二狗装到你的 Windows 电脑上，怎么启动和停止、开机自启、升级、回滚和卸载。看完你能自己把二狗装好跑起来，出了问题知道怎么查。装好后接着看[开始使用](getting-started.md)；想先知道二狗是什么，看[二狗是什么](README.md)。

- [装之前](#装之前)
- [一行命令安装（推荐）](#一行命令安装推荐)
- [用 npm 安装](#用-npm-安装已经有-node-22-的)
- [从源码安装](#从源码安装)
- [启动和停止](#启动和停止)
- [开机自启](#开机自启)
- [装完之后](#装完之后)
- [升级](#升级)
- [回滚](#回滚)
- [停用](#停用)
- [卸载](#卸载)
- [出问题怎么办](#出问题怎么办)

## 装之前

**要准备的：**

- **一台 Windows 10 / 11 电脑。** 现在只支持 Windows。
- **一个大模型的 API key：** 现在是 [DeepSeek](https://platform.deepseek.com/)，也可以换成别家的 OpenAI 兼容服务商，见[模型](settings.md#模型)。没配也能先起来、打开网页看看，跟它说话时它会提醒你去配。
- **磁盘：** 程序几百 MB。语义检索的向量模型约 560 MB，语音识别的模型约 1 GB，这两样都是可选的。

不用事先装 Node：一行命令安装自带一份。

**可选**（不装也能用，对应的功能先关着）

| 装了什么 | 能多什么 | 见 |
|---|---|---|
| Git for Windows | agent 跑 bash 命令（任务里常用）、从源码安装 | [从源码安装](#从源码安装) |
| 语音识别（在 **设置 · 组件** 里装） | 按住说话，在本机识别 | [语音](voice.md) |
| 语音合成（在 **设置 · 组件** 里装） | 二狗用语音回话 | [语音](voice.md) |
| Chrome 或 Edge | agent 联网搜索、读网页 | [浏览与填框](settings.md#浏览与填框) |
| Tailscale，或一台 VPS | 手机、平板从外面访问 | [手机上用](mobile.md) |
| 本机登录好的 Claude Code | 让项目、任务的负责人用你自己的 Claude Code 订阅干活 | [Claude Code](claude-code.md) |
| 一台安卓手机 | 安卓原生 App，[下载](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-android-debug.apk)就能装 | [手机上用](mobile.md#安卓-app) |
| 一台鸿蒙手机、DevEco Studio 和华为账号 | 鸿蒙原生 App，要用你自己的账号签名。[没签名的包](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-harmony-unsigned.hap)模拟器能直接装 | [手机上用](mobile.md#鸿蒙-app) |

## 一行命令安装（推荐）

不用事先装 Node，也不要管理员权限。

**第 1 步：打开 PowerShell。** 按 Win 键，输入 `powershell`，回车。普通窗口就行，不要"以管理员身份运行"。

**第 2 步：粘贴这一行，回车。**

```powershell
irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1 | iex
```

安装包约 150 MB，窗口里会显示下载进度。脚本依次做这些事：

1. 找到最新版本（GitHub Releases 和 npmmirror 两边挑快的），下载打好的安装包。安装包自带 Node，不用 `npm`，也不用构建。
2. 校验签名和文件的 sha256。
3. 解到 `%LOCALAPPDATA%\Programs\ergo\versions\<版本>`，把 `current` 写成一行文本，指向在用的那份。
4. 把 `bin` 加进用户 PATH。
5. 把服务管家设成开机自启，再把二狗起来（见[开机自启](#开机自启)）。

你的数据放在 `%USERPROFILE%\.ergo`，和程序分开，升级、重装都不动它。

**第 3 步：看窗口最后几行。** 全部成功时是这样：

```text
版本：<版本>
安装目录：C:\Users\你的用户名\AppData\Local\Programs\ergo
在用的版本（current）：<版本>
开机自启：开着
下一步：ergo open 打开网页，走设置向导。
装好了。之后用 ergo start / stop / status / update / uninstall 管它，ergo help 看全部命令。数据在 ~/.ergo，升级、卸载都不碰。
```

下载、验签、解开、写 `current` 这几步失败才算没装上，在用的版本不变。之后的某一步没成（比如注册开机自启被拦了）不算安装失败：窗口里写清这一步没成、之后怎么重做，其余照常。

**第 4 步：确认二狗在跑。** 新开一个 PowerShell 窗口，运行 `ergo status`，应当看到：

```text
版本：<版本>（安装包）
装在：C:\Users\你的用户名\AppData\Local\Programs\ergo
数据：C:\Users\你的用户名\.ergo
服务管家：在跑（端口 7420）
二狗：RUNNING，http://127.0.0.1:8810/（pid 12345）
```

**第 5 步：打开网页，走设置向导。** 运行 `ergo open`，或者浏览器打开 <http://127.0.0.1:8810/>。向导怎么走见下面的[装完之后](#装完之后)。

### 安装选项

`irm … | iex` 传不了参数，要传就把脚本取下来再跑：

```powershell
& ([scriptblock]::Create((irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1))) -FromSource
```

| 参数 | 作用 |
|---|---|
| `-FromSource` | 不下安装包，下源码包自己装；`-Ref <标签或分支>` 指定装哪一版 |
| `-NodeVersion <版本>` | 指定 Node 版本（只放行测过的） |
| `-UseSystemNode` | 用机器上那份 Node，不用自带的 |
| `-Mirror cn` | 强制走 npmmirror（npm 包发布之后才可用，现在会退回 GitHub） |
| `-NoPath` | 不改 PATH |
| `-NoAutostart` | 不设开机自启 |
| `-NoStart` | 装完不把二狗起来 |

`irm … | iex` 时也可以用环境变量：`$env:ERGO_INSTALL_NO_AUTOSTART = 1`、`$env:ERGO_INSTALL_NO_START = 1`。

## 启动和停止

二狗由两个进程组成：**服务管家**负责把别的服务起来、看着它们；**二狗守护进程**是二狗本身，由服务管家托管。

装完二狗已经在跑，重启电脑后也会自己起来，**平时不用手动启动**。要手动操作时：

| 想做什么 | 命令 |
|---|---|
| 看在不在跑、什么版本、装在哪 | `ergo status` |
| 启动（服务管家没在跑会先把它起来） | `ergo start` |
| 打开网页 | `ergo open` |
| 马上停止 | `ergo stop` |
| 等手上的任务做完再停止 | `ergo svc stop ergo-daemon --when-idle` |
| 重启 | `ergo restart` |
| 等手上的任务做完再重启 | `ergo svc restart ergo-daemon --when-idle` |
| 看日志（`-f` 接着看新的，Ctrl+C 退出） | `ergo logs`、`ergo logs -f` |
| 看全部命令 | `ergo help` |

也可以在服务管家的网页操作：浏览器打开 <http://127.0.0.1:7420/>，每个服务一张卡片，能启动、停止、看实时日志、开关开机自启。

二狗被杀或者崩溃，服务管家会自动重新拉起。重启后正在做的事按规则接着做，说不清做没做完的操作会转给你确认，不会悄悄重做。

`ergo status` 显示的意思：

| 显示 | 意思 | 怎么办 |
|---|---|---|
| `服务管家：没在跑` | 服务管家没起来 | `ergo start` |
| `二狗：还没登记` | 用 `-NoStart` 装的，还没启动过 | `ergo start` |
| `二狗：STOPPED` | 被停了 | `ergo start` |
| `二狗：FAILED — 原因` | 没起来 | 按原因处理，看 `ergo logs`，修好后 `ergo start` |

### 让二狗替你开关服务

**这是什么：** 不用开命令行，跟二狗说一声，它替你在服务管家里看状态、看日志、开关服务。

可以直接说的话：

- 服务管家里都有什么？语音合成还在跑吗
- 把 audiocpp 停一下；再把它开起来；重启一下
- comfyui 为什么起不来，看看它的日志
- 把画图服务加进开机自启
- 你重启一下自己吧，刚改了配置

| 你让它做的 | 它怎么做 |
|---|---|
| 看状态、看日志；启动、停止、重启、等空闲再停、加进开机自启、按场景启动一组 | 你说了就做，对话里的工具调用写着停了谁、现在怎样。服务自己没有正常停止（重启）办法的，说停就直接强制停下（说重启就强制重启），它手上正在做的会断，结果里写明 |
| 有正常停止办法的服务你点名要强制停止、强制重启，移出开机自启、按场景停止、撤销二狗名下的项目服务、处理占着端口的陌生进程、开关公网入口和 tailnet 入口 | 出一张审批卡，你点「批准这一次」才做。对话审批关着也一样 |
| 重启二狗自己 | 出审批卡。批了以后不马上重启：等手上的任务、正在做的事做完，它把这句话说完，才退出、由服务管家拉起来。重启后对话接着在 |
| 停掉二狗自己、不等空闲就重启它，停它的外网隧道、它离不开的服务 | 不做，告诉你是哪个、为什么。真要做，在服务管家的网页上自己做 |

要知道的：

- **防线在服务管家那边。** 二狗是用服务管家发给它的身份去指挥的，服务管家按身份算出"二狗离不开的"，经服务管家怎么说都停不了它们。
- **想多护住一个服务**（比如语音识别），在它的登记里加一行 `lifeline: true`，对谁都不能经这里停。
- **服务管家太旧时**，二狗会照实说"要先更新服务管家"，什么都不动。
- **这里不做的：** 开通公网（新建隧道）、改服务管家的口令、重新加载登记，都在服务管家的网页上做。
- **自己点也行：** 设置 · 数据与设备 · 服务一页列着和二狗有关的服务，手机上也能启停、看日志，规矩一样，见[设置 · 服务](settings.md#服务)。

## 开机自启

开机自启分两层，**两层都开，重启电脑后二狗才会自己起来**。一行命令安装默认两层都开好了，不用做任何设置。下面这些是要检查或者改的时候用的。

| | 第 1 层：服务管家自启 | 第 2 层：服务管家拉起二狗 |
|---|---|---|
| 管什么 | 登录 Windows 时，计划任务 `LocalServiceManager` 在后台把服务管家起来，不弹窗口 | 服务管家起来后，把开机名单里的服务拉起来 |
| 什么时候开的 | 安装脚本 | 第一次 `ergo start`（安装脚本会替你跑一次） |
| 看现在开没开 | `Get-ScheduledTask -TaskName LocalServiceManager` | `ergo svc autostart`（列出名单） |
| 打开 | `ergo svc install-autostart` | `ergo svc autostart ergo-daemon on` |
| 关掉 | `ergo svc uninstall-autostart` | `ergo svc autostart ergo-daemon off` |
| 网页上 | 设置向导「能力」那一步的**开机自启**开关 | 服务管家网页 <http://127.0.0.1:7420/> 卡片上的开关 |

**验证一下：** 重启电脑，登录 Windows，等一两分钟，新开 PowerShell 运行 `ergo status`。

要知道的：

- **是"登录时"，不是"开机时"。** 电脑开着但停在登录界面，二狗不会起来。家里的电脑要无人值守，得让 Windows 自动登录，这个由你自己决定和设置。
- **别的服务也一样。** 装了语音服务之后想让它也开机起来，用 `ergo svc autostart <服务> on`，或者点它卡片上的开关。服务名看 `ergo svc status`。
- **关了就一直关着。** 把二狗从名单里关掉后，`ergo start` 不会替你打开。第 1 层撤掉后，`ergo start`、`ergo update` 也不会加回来；重新跑安装脚本会（不想要就加 `-NoAutostart`）。
- **升级、回滚不用管。** `ergo update`、`ergo rollback`、`ergo start` 都会核对，任务指着这个安装里的别的版本就改指在用的版本。
- **这台电脑已有指向别处的同名任务**（比如你自己从源码装的服务管家）：安装脚本、`ergo start`、`ergo uninstall` 都不动它。要换成这一份就跑一次 `ergo svc install-autostart`。
- **用 `-NoStart` 装的：** 跑过一次 `ergo start` 之后，重启才会拉起二狗。
- **从源码装的：** 把上面的 `ergo svc` 换成在 `packages\supervisor` 里跑 `node bin\lsm.mjs`，步骤见[从源码安装](#从源码安装)的第 3、5 步。

## 用 npm 安装（已经有 Node 22 的）

```powershell
npm i -g ergo-ai
ergo start
```

装好后命令照样叫 `ergo`。npm 包（`ergo-ai`）还没发，这一节暂时还装不上；发了以后，装好就浏览器打开 <http://127.0.0.1:8810/> 走向导。

## 从源码安装

想改代码、跟着最新代码跑的才走这一节。只是用二狗，用上面的一行命令就够了。

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

浏览器打开 <http://127.0.0.1:7420/> 能看到服务管家的页面就好了。下文的 `lsm` 都是指在 `D:\apps\ergo\packages\supervisor` 里跑 `node bin\lsm.mjs`。服务管家的更多用法（场景、口令、哨兵……）见它的 [README](../../packages/supervisor/README.md)。

> 装了一行命令安装的版本以后，`ergo start / stop / status / logs` 管二狗自己，`ergo svc <子命令>` 原样转给服务管家（`ergo svc status` = `lsm status`）。

**第 4 步：放好 API key**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ergo\secrets" | Out-Null
Set-Content -NoNewline -Encoding ascii "$env:USERPROFILE\.ergo\secrets\deepseek-api-key.txt" "sk-你的key"
```

- 文件里只有 key 这一行。服务管家把它读出来交给守护进程；数据目录的 `secrets` 区任何 agent 都读不到。
- **不要把 key 放进仓库**，也不要写进服务管家的注册表。
- 也可以不碰命令行：二狗的网页打开以后，在**首次设置向导**的「模型 Key」那一步，或者**设置 · 模型**里，把 key 填进密码框、点「保存 key」。它会写进同一个文件（`secrets\deepseek-api-key.txt`，目录和文件都按最紧的权限建），保存后下一个新会话就能用，不用重启；以后想换也在同一处改。手动放文件这个办法留着兜底——网页打不开、或者想用别的数据目录时还用得上。
- 想换成别家的模型（自定义的 OpenAI 兼容服务商），key 放在 `secrets\custom-model-api-key.txt`，环境变量是 `CUSTOM_MODEL_API_KEY`；怎么填见 [设置 · 模型](settings.md#模型)。

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

   再看三处：没装语音合成服务的，删掉 `dependsOn:` 那一段（软依赖，删了不影响启动）；改了本机端口的（[配置文件](../architecture/README.md#配置文件)），把条目里两处 `8810` 一起改；文件末尾注释掉的 `exposure:` 是 VPS 公网入口，先别动（[方式三](../architecture/deployment.md#方式三vps--ssh-反向隧道--nginx公网)）。

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
- 守护进程的输出在服务管家数据目录的 `logs\ergo-daemon.out.log`，也能在服务管家的网页里实时看。超过 20 MB 时在它下次启动前切开，旧的是同目录的 `.1`、`.2`、`.3`（只留 3 份），网页上往前翻能接着看。
- 被杀、崩溃后服务管家会按退避重新拉起；重启后正在做的事按规则接着做，说不清做没做完的操作会转给你确认，不会悄悄重做。

### 从源码升级

```powershell
cd D:\apps\ergo
git pull
npm ci                  # 依赖有变时
npm run build:web
cd packages\supervisor
node bin\lsm.mjs restart ergo-daemon --when-idle   # 等手上的任务做完再重启
```

回「✓ ergo-daemon 已重启（新进程 PID …）」才是换好了；二狗正忙时回「⏸ … 等它空闲后重启」，它忙完自己退出、服务管家再把它拉起来（`ergo status` 看），等一小时还在忙就撤销这次重启、它照常跑。只改了网页时不用重启守护进程。

## 装完之后

1. **走向导**：浏览器打开 <http://127.0.0.1:8810/>（或者 `ergo open`），网页里的**设置向导**五步走完：语言 / 称呼 / 助手名、模型 Key（填完点一下测试）、能力（勾要哪些插件和组件，默认向量模型和记忆，语音不勾；模型都是这时候才在网页里下，不进安装包；这一步也能开关开机自启）、手机扫码配对、安全默认值说明，后面还有一屏外网访问的说明。每步都能"以后再说"，以后随时从**更多 · 设置**最上面一行重进。详见[开始使用](getting-started.md)。
2. **试一句**：跟它说"两分钟后提醒我喝水"。
3. **日常命令**：`ergo start`、`ergo stop`、`ergo restart`、`ergo status`、`ergo logs`；备份和恢复是 `ergo backup`、`ergo restore`（[备份](settings.md#备份)）。
4. **出问题**：先看**更多 · 设置 · 数据与设备 →「体检」**，每条都写着怎么修；再看[出问题怎么办](#出问题怎么办)。

## 升级

你的数据（`%USERPROFILE%\.ergo`）和程序分开，升级不动数据。每个版本改了什么见 [CHANGELOG](../../CHANGELOG.md)。

### 一行命令装的

```powershell
ergo update --check   # 只看有没有新版本
ergo update           # 升级
ergo version          # 看现在跑的是哪一版
```

`ergo update` 会：查最新版本 → 下载到新目录、校验签名 → 等二狗空闲（有任务在执行时不打断）→ 切过去、重起二狗，开机自启的任务也跟着指向新版本 → 留一份旧版本用来回滚。等太久还不空闲就放弃，在用的版本不变，过会儿再跑一次就行。

参数：`--version <版本>` 指定版本，`--mirror cn` 先走 npmmirror（npm 包发布之后才有用，现在会退回 GitHub），`--from <地址>` 用别的发布地址。

开机自启起来的服务管家，升级后这个进程还是旧版本的程序（二狗已经是新版本，不影响用），下次登录才换；它占着的旧版本目录这时删不掉，`ergo update` 会说下次再删。

### 其他方式装的

| 怎么装的 | 怎么升级 |
|---|---|
| `install.ps1 -FromSource` | `ergo update`（拉新代码、构建进新目录，再切过去） |
| 自己 `git clone` 的 | 见[从源码升级](#从源码升级) |
| npm（还没发） | `npm i -g ergo-ai@latest` |
| Scoop、winget | `scoop update ergo`、`winget upgrade`；`ergo update` 也会这样提示你 |

### 手机上

新装的手机：电脑上打开 **更多 · 设置 · 设备配对**，点"显示配对二维码"，用手机上的二狗 App 点"扫码连接"扫一下（连不上时 App 会说清原因）。

开着的页面（包括手机上一直开着的鸿蒙 App）几秒内会提示刷新，刷新就是新版本。App 本身一般不用重装；App 里的原生部分和对网页下指令的那段脚本是随 App 打包的，这些变了才要重装，CHANGELOG 会写。安卓下载新的 APK 直接覆盖安装，鸿蒙重新构建或重新签名再装，见[装 App](mobile.md#装-app)。

### 升级出问题

切不过去时在用的版本不变，二狗照常起来。常见情况见[出问题怎么办](#出问题怎么办)。

## 回滚

```powershell
ergo rollback    # 切回上一个版本
```

回滚只换程序，不动数据。新版本如果改过数据格式，旧版本不一定读得懂，回滚前看一眼 [CHANGELOG](../../CHANGELOG.md)。切哪个版本由安装目录里的 `current`（一行文本）说了算。

## 停用

```powershell
ergo svc autostart ergo-daemon off    # 开机不再拉起二狗
ergo svc stop ergo-daemon --when-idle # 等手上的任务做完再停
ergo svc uninstall-autostart          # 服务管家也不开机自启
```

自己 `git clone` 的，把 `ergo svc` 换成在 `packages\supervisor` 里跑 `node bin\lsm.mjs`。

## 卸载

```powershell
ergo uninstall                # 撤掉 PATH、服务管家里的登记和开机自启，问你要不要删数据
ergo uninstall --keep-data    # 不问，留着数据
ergo uninstall --delete-data  # 不问，连数据一起删
```

你的数据在 `%USERPROFILE%\.ergo`，服务管家的在 `%LOCALAPPDATA%\ergo\supervisor`。自己 `git clone` 的，删代码目录和这两个目录就是卸载，删不删数据由你决定。

## 出问题怎么办

**先做体检**：**更多 · 设置 · 数据与设备 →「体检」**——二狗本身一块（端口、Node、pi、服务管家、模型的 Key、组件、磁盘、外网入口），每个插件一块（插件本身、它的数据源和运行时），每条给出查出来的事实和怎么修，右上角"再查一遍"。平时体检只查本机：不联网、不调用模型、不改任何设置，会连一下本机上二狗在用的服务的端口。

**看日志**：二狗的输出在服务管家数据目录的 `logs\ergo-daemon.out.log`，服务管家的网页里也能实时看；二狗自己的健康状况：<http://127.0.0.1:8810/healthz>。

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| 二狗起不来，日志第一行说"只支持 Windows"或 Node 版本不对 | 系统或 Node 不对 | 换 Windows 10 / 11；用 Node 22（≥ 22.19），从源码跑的确认条目里 `<专用 Node 路径>` 指的是它 |
| 起不来，说端口被占 | 8810 / 8811 被别的程序占着（日志里写着程序名和 PID；查不到时写"有人占着，查不到是谁"） | 关掉那个程序，或者改[配置文件](../architecture/README.md#配置文件)里的端口 |
| 起不来，说同一个数据目录已经有实例在跑 | 手动起过一个、或者旧的没退干净 | 先停掉那个（服务管家的网页、任务管理器），再由服务管家起 |
| 从源码跑时打开页面是 503，提示 `npm run build:web` | 网页还没构建 | 在二狗目录里 `npm run build:web` |
| 打开页面只有一句"这个页面要经二狗打开" | 直接双击了安装目录里的 `index.html` | 先运行 `ergo start`，再用浏览器打开 <http://127.0.0.1:8810> |
| 跟它说话，它说"还没配模型"或每次都出错 | key 没放、放错了，或者额度用完 | 在**设置 · 模型**里重新填一个 key（或检查 `secrets\deepseek-api-key.txt`，只有 key 一行），再点"连通测试" |
| 任务里的命令总失败，说找不到 Git Bash | 没装 Git for Windows，或 PATH 上排在前面的是 WSL 的 `bash` | 装 Git for Windows；确认 `where bash` 第一条是 `C:\Program Files\Git\bin\bash.exe` |
| 按住说话没反应、识别不可用 | 语音识别模型没装、语音服务没在运行 | 看 **设置 · 语音** 的状态和说明；照[语音](voice.md)装好 |
| 语音回复只有文字 | 语音程序没在运行 | 照[语音](voice.md#出问题怎么办)处理；聊天里那条说明会写原因 |
| 记忆里搜不到意思相近的话 | 向量模型没装 | **设置 · 组件**里装 |
| 手机打不开或一直在配对页 | 外网入口没接好，或请求过期、被限频 | 确认接的是 8811；电脑上**待办**里批准配对请求（5 分钟内有效）；连着失败时等 10 分钟再试 |
| 手机扫码后说连不上 | 手机到不了这个地址 | 按页面上的提醒查：手机上的 Tailscale 开了没有、是不是同一个 tailnet；电脑上的二狗和服务管家在不在跑；VPS、隧道、反代在不在运行 |
| 手机上提示"此设备已被吊销" | 在设备配对里吊销过 | 点"请求配对"重新申请 |
| 服务管家上二狗亮黄灯（degraded） | 某个启用着的插件没装上 | 看 `/healthz` 的 `reasons`，或 **设置 · 插件** 里那个插件写的原因 |
| 每次备份都说"没写进同步目录" | 另存的文件夹不在，或者写不进去 | 在**设置 · 备份**里换一个文件夹，或者点"清掉" |
| 联网工具说找不到浏览器 | 本机没有 Chrome / Edge，或装在不常见的位置 | 在[配置文件](../architecture/README.md#配置文件)里写浏览器的路径 |
| 安装或升级时装不下去：安全软件弹"未知发布者"、把进程结束了，或者装好的文件过一会儿不见了 | 360 这类安全软件拦了不认识的新程序（`bin\ergo.exe` 或整个安装目录） | 把 `%LOCALAPPDATA%\Programs\ergo` 加进安全软件的信任区，再装一遍；命令还能跑的话直接用 `bin\ergo.cmd`（和 `ergo.exe` 是同一条命令）；或者改用 npm 装（`npm i -g ergo-ai`，机器上要有 Node 22）。数据在 `%USERPROFILE%\.ergo`，重装不碰 |
| `ergo update` 说切不过去，或者更新完 `ergo version` 还是老版本 | `current` 那行写着哪个版本、`versions\` 里那个版本没装好（拷了一半、手改过） | 看 `%LOCALAPPDATA%\Programs\ergo\current` 里写的是哪个版本、`versions\` 下有没有它、里面的 `ergo.json` 在不在；不对就重跑 `ergo update`，或者重新装一遍（数据不动） |

**报问题**：到 GitHub 上[提一个问题](https://github.com/catmaniii/ergo/issues/new/choose)，照模板填上二狗的版本（**设置 · 关于二狗**）、Node 的版本（`node -v`）、pi 的版本（仓库根目录 `package.json` 的 `overrides`）和安装方式——版本和 Node、pi 这几样在体检页上也能一眼看到。安全问题请不要公开提，见 [SECURITY.md](../../SECURITY.md)。

