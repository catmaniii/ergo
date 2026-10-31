**中文** | [English](install.en.md)

# 安装、升级和卸载

二狗只支持 Windows 10 / 11。两个进程是什么、要准备什么，见[用户手册第 1 节](user-guide.md#1-装之前)；从外面访问见[部署和外网访问](deployment.md)。

- [一行命令安装（推荐）](#一行命令安装推荐)
- [用 npm 安装](#用-npm-安装已经有-node-22-的)
- [从源码安装](#从源码安装)
- [装完之后](#装完之后)
- [升级](#升级)
- [回滚](#回滚)
- [停用](#停用)
- [卸载](#卸载)

## 一行命令安装（推荐）

在 PowerShell 里：

```powershell
irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1 | iex
```

它会：找到最新版本（GitHub Releases 和 npmmirror 两边挑快的）→ 下载打好的安装包（自带 Node，不用 `npm`、不用构建；窗口里跟着显示百分比、已下载/总量和速度，服务器没给大小时只显示已下载和速度）→ 校验签名和文件的 sha256 → 解到 `%LOCALAPPDATA%\Programs\ergo\versions\<版本>`、把 `current` 写成一行文本指向在用的那份 → 把 `bin` 加进用户 PATH（不要管理员权限）→ 把服务管家设成开机自启 → 把二狗起来，最后报版本、安装目录、在用的版本、自启状态和下一步。接着浏览器打开 <http://127.0.0.1:8810/>（或者 `ergo open`），在网页里走向导（见[第 3 节](user-guide.md#3-第一次打开)）。你的数据放在 `%USERPROFILE%\.ergo`，和程序分开，升级、重装都不动它。

`irm … | iex` 传不了参数，要传就把脚本取下来再跑：

```powershell
& ([scriptblock]::Create((irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1))) -FromSource
```

参数有：`-FromSource`（不下安装包，下源码包自己装；`-Ref <标签或分支>` 指定装哪一版）、`-NodeVersion <版本>`（只放行测过的 Node）、`-UseSystemNode`（用机器上那份 Node，不用自带的）、`-Mirror cn`（强制走 npmmirror，国内快）、`-NoPath`（不改 PATH）、`-NoAutostart`（不设开机自启）、`-NoStart`（装完不把二狗起来，旧名 `-NoOnboard` 还能用）。`irm … | iex` 时也可以用环境变量：`$env:ERGO_INSTALL_NO_AUTOSTART = 1`、`$env:ERGO_INSTALL_NO_START = 1`。

下载、验签、解开、写 `current` 这几步失败才算没装上（在用的版本不变）。之后的某一步没成（比如注册开机自启被拦了）不算安装失败：脚本写清这一步没成、之后怎么重做，其余照常。

**重启电脑后二狗自己起来**：安装时服务管家设成了开机自启（计划任务 `LocalServiceManager`：登录 Windows 时在后台起来，不弹窗口），第一次 `ergo start` 又把二狗写进了它的开机自启名单（数据目录的 `registry/autostart.yaml`）。

- **开机拉起哪些服务**在服务管家里定：它的网页 <http://127.0.0.1:7420/> 卡片上的开关，或者 `ergo svc autostart <服务> on|off`。把二狗关了就一直关着，`ergo start` 不会替你打开。
- **不要开机自启**：`ergo svc uninstall-autostart`；要回来：`ergo svc install-autostart`。撤掉之后 `ergo start`、`ergo update` 不会把它加回来；重新跑安装脚本会（不想要就加 `-NoAutostart`）。
- **升级、回滚**：`ergo update`、`ergo rollback`、`ergo start` 都会核对，任务指着这个安装里的别的版本就改指在用的版本。
- **这台电脑已有指向别处的同名任务**（比如你自己从源码装的服务管家）：安装脚本、`ergo start`、`ergo uninstall` 都不动它。要换成这一份就跑一次 `ergo svc install-autostart`。
- **用 `-NoStart` 装的**：跑过一次 `ergo start` 之后，重启才会拉起二狗。在这之前服务管家能开机起来，但二狗还没登记、名单还没写；而且它第一次起来时没有上一次的登录记录，按"不是开机"处理，不拉起任何服务（宁可这一次不自启，也不把一次普通的重启当成开机）。

## 用 npm 安装（已经有 Node 22 的）

```powershell
npm i -g ergo-ai
ergo start
```

装好后命令照样叫 `ergo`。npm 包（`ergo-ai`）还没发，这一节暂时还装不上；发了以后，装好就浏览器打开 <http://127.0.0.1:8810/> 走向导。

## 从源码安装

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
- 想换成别家的模型（自定义的 OpenAI 兼容服务商），key 放在 `secrets\custom-model-api-key.txt`，环境变量是 `CUSTOM_MODEL_API_KEY`；怎么填见 [5.5](user-guide.md#55-模型)。

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

   再看三处：没装语音合成服务的，删掉 `dependsOn:` 那一段（软依赖，删了不影响启动）；改了本机端口的（[5.2](user-guide.md#52-配置文件-ergojson)），把条目里两处 `8810` 一起改；文件末尾注释掉的 `exposure:` 是 VPS 公网入口，先别动（[6.3](deployment.md#方式三vps--ssh-反向隧道--nginx公网)）。

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

## 装完之后

1. **走向导**：浏览器打开 <http://127.0.0.1:8810/>（或者 `ergo open`），网页里的**设置向导**五步走完：语言 / 称呼 / 助手名、模型 Key（填完点一下测试）、能力（勾要哪些插件和组件，默认向量模型和记忆，语音不勾；模型都是这时候才在网页里下，不进安装包；这一步也能开关开机自启）、手机扫码配对、安全默认值说明，后面还有一屏外网访问的说明。每步都能"以后再说"，以后随时从**更多 · 设置**最上面一行重进。详见[第一次打开](user-guide.md#3-第一次打开)。
2. **试一句**：跟它说"两分钟后提醒我喝水"。
3. **日常命令**：`ergo start`、`ergo stop`、`ergo restart`、`ergo status`、`ergo logs`；备份和恢复是 `ergo backup`、`ergo restore`（[备份和恢复](user-guide.md#9-备份和恢复)）。
4. **出问题**：先看**更多 · 设置 · 数据与设备 →「体检」**，每条都写着怎么修；再看[出问题怎么办](user-guide.md#11-出问题怎么办)。

## 升级

你的数据（`%USERPROFILE%\.ergo`）和程序分开，升级不动数据。每个版本改了什么见 [CHANGELOG](../CHANGELOG.md)。

### 一行命令装的

```powershell
ergo update --check   # 只看有没有新版本
ergo update           # 升级
ergo version          # 看现在跑的是哪一版
```

`ergo update` 会：查最新版本 → 下载到新目录、校验签名 → 等二狗空闲（有任务在执行时不打断）→ 切过去、重起二狗，开机自启的任务也跟着指向新版本 → 留一份旧版本用来回滚。等太久还不空闲就放弃，在用的版本不变，过会儿再跑一次就行。

参数：`--version <版本>` 指定版本，`--mirror cn` 走 npmmirror（国内快），`--from <地址>` 用别的发布地址。

开机自启起来的服务管家，升级后这个进程还是旧版本的程序（二狗已经是新版本，不影响用），下次登录才换；它占着的旧版本目录这时删不掉，`ergo update` 会说下次再删。

### 从 0.4.0 升上来

0.4.0 的 `ergo update` 切完版本后，二狗其实还跑着旧版；那时装的也没有开机自启。所以要多两步：

```powershell
ergo update                  # 下载新版本并切过去
ergo restart                 # 让二狗真正换成新版本
ergo svc install-autostart   # 补上开机自启
ergo status                  # 确认版本
```

`ergo restart` 时会把二狗写进开机名单。如果你以前自己建过名单、里面没有二狗，用 `ergo svc autostart ergo-daemon on` 加上。服务管家这时还是旧版本的程序，下次登录才换。再往后的升级只要 `ergo update`。

### 其他方式装的

| 怎么装的 | 怎么升级 |
|---|---|
| `install.ps1 -FromSource` | `ergo update`（拉新代码、构建进新目录，再切过去） |
| 自己 `git clone` 的 | 见下面 |
| npm（还没发） | `npm i -g ergo-ai@latest` |
| Scoop、winget | `scoop update ergo`、`winget upgrade`；`ergo update` 也会这样提示你 |

自己 `git clone` 的：

```powershell
cd D:\apps\ergo
git pull
npm ci                  # 依赖有变时
npm run build:web
cd packages\supervisor
node bin\lsm.mjs restart ergo-daemon --when-idle   # 等手上的任务做完再重启
```

只改了网页时不用重启守护进程。

### 手机上

开着的页面（包括手机上一直开着的鸿蒙 App）几秒内会提示刷新，刷新就是新版本。App 本身一般不用重装；App 里的原生部分和对网页下指令的那段脚本是随 App 打包的，这些变了才要重新打包，CHANGELOG 会写。

### 升级出问题

切不过去时在用的版本不变，二狗照常起来。常见情况见[出问题怎么办](user-guide.md#11-出问题怎么办)。

## 回滚

```powershell
ergo rollback    # 切回上一个版本
```

回滚只换程序，不动数据。新版本如果改过数据格式，旧版本不一定读得懂，回滚前看一眼 [CHANGELOG](../CHANGELOG.md)。切哪个版本由安装目录里的 `current`（一行文本）说了算。

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
