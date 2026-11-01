**中文** | [English](development.en.md)

# 开发

搭环境、跑命令、跑测试、提交改动。系统怎么搭起来的见[系统架构](README.md)，写插件见[插件开发手册](plugin-development.md)。

用 AI 编程助手开发的，让它读 `AGENTS.md`，再照 `.claude/skills/ergo-dev/SKILL.md` 做（写插件照 `.claude/skills/ergo-plugin/SKILL.md`）。

怎么提交改动见 [CONTRIBUTING](../../CONTRIBUTING.md)。下面每节讲一件事：

- [前提](#前提)
- [从源码跑](#从源码跑)
- [常用命令](#常用命令)
- [手机 App](#手机-app)
- [写代码的约定](#写代码的约定)
- [测试](#测试)
- [升级 pi](#升级-pi)
- [文档、CHANGELOG、设计记录](#文档changelog设计记录)

## 前提

- **Windows 10 / 11**。Job 对象、目录联接、Windows 沙箱、计划任务只有 Windows 有；靠它们的测试在别的系统上跳过，守护进程在别的系统上不启动。
- **Node 22**（≥ 22.19）。**Node 大版本跟着 pi 走**（[ADR-0031](adr/0031-node-version-follows-pi.md)）：pi 的自动测试和安装脚本用哪个大版本，二狗打包、运行、测试就用哪个；pi 升级我们跟着升，pi 不升我们照旧。源码是 TypeScript，靠 Node 自带的类型剥离直接运行，守护进程没有构建步骤。
- **Git for Windows（Git Bash）**：pi 的 `bash` 工具和一批集成测试要靠它。`where bash` 的第一条应该是 `C:\Program Files\Git\bin\bash.exe`；如果只有 `C:\Windows\System32\bash.exe`（WSL 的幌子，跑不起来），先把 Git 的 bin 前插到 PATH：PowerShell 里 `$env:PATH = "C:\Program Files\Git\bin;" + $env:PATH`。没有 Git Bash 时，靠 bash 的用例会明确跳过或在超时错误里说明，不是功能坏了。
- **依赖的安装脚本**：根 `package.json` 的 `allowScripts` 把现有的几个（esbuild、koffi、onnxruntime-node、protobufjs、@google/genai）都标成不跑——原生文件都是现成的。新加带安装脚本的依赖时，核过要不要跑再记进去。Node 22 带的 npm 10 不认这个字段，照旧跑。
- **不要在开发机上直接起常驻服务**：二狗的服务由服务管家登记、启动（见[从源码安装](../user-guide/install.md#从源码安装)）。测试里起的守护进程实例和子进程是测试的一部分，测试结束时销毁。

## 从源码跑

从源码安装和升级的步骤见[安装、升级和卸载](../user-guide/install.md#从源码安装)。

### 备份和恢复

装好的程序用 `ergo backup`、`ergo restore`，怎么用见[备份](../user-guide/settings.md#备份)。从源码跑时没有 `ergo` 命令：

```powershell
npm run backup                   # 马上备份一次；定时器调的话加 -- --scheduled
# 在 packages\supervisor 里：先停守护进程
node bin\lsm.mjs stop ergo-daemon
# 在二狗目录里：数据目录要和服务管家条目里的一致
$env:ERGO_DATA_DIR = "$env:USERPROFILE\.ergo"
D:\apps\node22\node.exe packages\daemon\src\restore.ts --list                   # 看有哪些快照
D:\apps\node22\node.exe packages\daemon\src\restore.ts 2026-10-15               # 恢复某一天的
D:\apps\node22\node.exe packages\daemon\src\restore.ts 2026-10-15 --from sync   # 本机那份坏了，从另存的文件夹恢复
# 回到 packages\supervisor：再启动
node bin\lsm.mjs start ergo-daemon
```

数据目录不是默认的（设过 `ERGO_DATA_DIR`）：用 `ergo` 命令之前也要在同一个窗口里设好这个环境变量。守护进程没停时，恢复命令会拒绝执行。

### Claude Code 接入

Agent SDK（`@anthropic-ai/claude-agent-sdk`）是 Anthropic 自己的许可，二狗只把它当可选依赖。从源码跑时在二狗目录里 `npm install --no-save @anthropic-ai/claude-agent-sdk@<版本>`，版本写在 `packages/daemon/package.json` 的 `optionalDependencies`，装好后到设置 · 插件点"启用"。

## 常用命令

都在仓库根目录跑：

| 做什么 | 命令 |
|---|---|
| 装依赖 | `npm ci` |
| 改完代码先跑这条：快车道（除主切面、契约测试外的全部单测 + 网页状态层 / UI / 构建检查） | `npm run test:fast`（约 2 分钟） |
| 主切面（真的拉起守护进程和 agent 子进程）+ 真浏览器打开页面 | `npm run test:integration`（十几分钟） |
| 全量（快车道 + 主切面 + pi 契约测试） | `npm test`（约 35 分钟；Windows 上建议 `$env:ERGO_TEST_WORKERS=2`） |
| pi 契约测试（升级 pi、改 `agent-host/`、`runtime/`、提示词装配时才跑） | `npm run test:contract` |
| 服务管家的测试（`node --test`，不在 vitest 里） | `npm run test:supervisor` |
| 单个包、单个文件、按名字挑 | `npm test -w @ergo/daemon`；`npx vitest run packages/daemon/test/agent-process.test.ts`；`npx vitest run --project daemon -t "中止"` |
| 类型检查 | `npm run typecheck` |
| lint | `npm run lint`（oxlint，配置在 `.oxlintrc.json`） |
| 收尾全套 | `npm run check`（类型检查 + lint + 全量 + 服务管家） |
| 多语言检查 | `npm run i18n:check`（[多语言](README.md#多语言)） |
| 构建网页 | `npm run build:web`（产物是单个文件 `packages/web/dist/index.html`） |
| 构建在线演示页 | `npm run build:demo`（产物在 `packages/web/dist-demo/`，[页面从哪里来](README.md#页面从哪里来原型和在线演示页)） |
| 部署后打开真的页面看一眼 | `npm run smoke:page`（无头 Chrome 打开 `http://127.0.0.1:8810/`，`-- <地址>` 换地址） |
| 构建鸿蒙 App | `npm run build:harmony`（[手机 App](#手机-app)） |
| 构建安卓 App | `npm run build:android`（[安卓 App](#安卓-app)） |
| 打发布包 | `npm run release`（`--build-mobile` 连手机安装包一起构建，[发布手机安装包](#发布手机安装包)） |
| 下载向量模型 | `npm run download-model` |
| 马上备份一次 | `npm run backup`（装好的程序里没有 `npm run`，是 `ergo backup`） |
| 从快照恢复 | `node packages/daemon/src/restore.ts <日期>`（装好的程序里是 `ergo restore <日期>`，都要先停守护进程） |
| 部署 VPS 公网入口的 nginx 站点 | `npm run deploy:nginx`（`-- --print` 只打印） |
| 检查项目服务的页面守不守前缀约定 | `npm run check:app-prefix -- <服务地址> --name <应用名>`（[转发本机服务的页面](README.md#转发本机服务的页面)） |
| 不起二狗校验运营接口清单和运营方案 | `npm run check:ops -- <ops.json 或方案.json> [--url <服务地址>] [--workdir <项目工作目录>]`（给了 `--url` 才真调 http 的操作；0 过了，1 没过，2 用法不对） |

## 手机 App

先讲鸿蒙，安卓见[安卓 App](#安卓-app)。

`frontend/harmony/` 是 DevEco 工程（stage 模型，`entry` 模块）：一个原生壳，ArkWeb 加载用户配好的二狗地址，网页还是守护进程提供的那份（为什么不把网页打包进 App 见 [ADR-0022](adr/0022-harmony-app-native-shell-loads-daemon-page.md)）。原生桥 `window.ergoNative` 只对配好的来源的主框架开放；"浏览"里的外部网页拿不到它。

### 构建

```powershell
npm run build:harmony                       # 默认关着 WebView 调试
npm run build:harmony -- --webview-debug    # 打开 WebView 调试（只在调试时装这个包）
```

- 用 DevEco Studio 自带的工具（先看环境变量 `DEVECO_HOME`，没设就找默认安装位置），工程没有 ohpm 依赖，不用联网。构建前先把页面桥打包进 `rawfile/page-bridge.js`、把自带语言的 `harmony.json` 收进 `rawfile/harmony-texts.json`（都是现生成的，不进仓库）。
- 产物：签过名的是 `frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap`；本机没配签名时只有同一目录下的 unsigned 包，脚本会提示怎么签。
- 依赖本机装的 DevEco，所以不进 `npm run check`。

### 签名（只做一次）

签名材料（证书、描述文件、密钥库、加密的口令）只放在本机，不进仓库：先跑一次 `npm run build:harmony` 生成本机的 `frontend/harmony/build-profile.json5`（被忽略）→ 手机打开开发者模式和 USB 调试并连上 → DevEco 打开 `frontend/harmony`，File → Project Structure → Project → Signing Configs，登录华为账号，只勾 Automatically generate signature（不勾 Associate with registered application）→ 再构建。给普通开发者的完整步骤、手动签名和常见报错见[手机上用](../user-guide/mobile.md#鸿蒙-app)。仓库里只有不含签名的模板 `build-profile.template.json5`；`frontend/test/harmony.test.ts` 检查仓库里没有签名材料。

### 安装、启动、调试

```powershell
hdc list targets
hdc -t <设备号> install -r frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap
hdc -t <设备号> shell aa start -a EntryAbility -b com.catmaniii.ergo
hdc -t <设备号> hilog | findstr ErgoApp            # App 和网页的日志
```

调试 ArkWeb 里的页面：装 `--webview-debug` 的包，`hdc -t <设备号> fport tcp:9222 localabstract:webview_devtools_remote_<App 的 pid>`，再用 Chrome 的 `chrome://inspect`。要在设备上用 `http://127.0.0.1` 连电脑上的守护进程，先 `hdc rport tcp:<端口> tcp:<端口>`；注意转本机端口（8810）时守护进程会把 App 当成本机、直接信任，只在调试时这样用。

### 原生录音

App 里按住说话用鸿蒙的 AudioCapturer：进语音模式时建好录音器、停在 PREPARED（不采集、不占麦克风、不挡输入法的语音），按下才 `start`，松手 `stop`（下一条直接 `start`，不用重建）；切到后台、离开语音模式时 `release`。格式是 16 kHz、单声道、16 位 PCM，网页加上 WAV 头照常上传。音源用 `SOURCE_TYPE_MIC`：它是唯一在各个系统版本、两个方向上都能和输入法的语音识别（`VOICE_RECOGNITION`）并存的音源。实现在 `frontend/harmony/entry/src/main/ets/voice/NativeVoice.ets`，网页一侧在 `packages/web/src/app/native-voice.ts`、`voice-native-recorder.ts`。

### 安卓 App

`frontend/android/` 是 Gradle 工程：Kotlin 原生壳加系统 WebView，也不打包网页。和鸿蒙的方法表一样，只少手机数据源（`phone*`）；原生画的部分照鸿蒙取值，集中在 `ui/ErgoTheme.kt`。详细说明见 `frontend/android/README.md`。

```powershell
npm run build:android                       # 调试版，默认关着 WebView 调试
npm run build:android -- --webview-debug    # 打开 WebView 调试（只在调试时装这个包）
npm run build:android -- --release          # 正式版，要本机有 frontend/android/keystore.properties
```

要 Android SDK（`ANDROID_HOME`，没设就找默认位置）和 JDK 17 以上，第一次构建要从官方源取构建插件和 AndroidX 库，所以不进 `npm run check`；`frontend/test/android.test.ts` 的静态核对进。构建前把页面桥打包进 `assets/page-bridge.js`、把自带语言收进 `assets/harmony-texts.json`（都是现生成的，不进仓库）。

**真机步骤**：

```powershell
adb devices
adb -s <设备号> install -r frontend/android/app/build/outputs/apk/debug/app-debug.apk
adb -s <设备号> shell am start -n com.catmaniii.ergo/.MainActivity
adb -s <设备号> logcat -s ErgoApp                  # App 和网页的日志
```

调试 WebView 里的页面：装 `--webview-debug` 的包，用 Chrome 的 `chrome://inspect`。要在设备上用 `http://127.0.0.1` 连电脑上的守护进程，先 `adb -s <设备号> reverse tcp:<端口> tcp:<端口>`；和鸿蒙一样，转本机端口（8810）时守护进程会把 App 当成本机、直接信任，只在调试时这样用。

**原生桥的安全设计和鸿蒙不同**（[ADR-0040](adr/0040-android-app-native-bridge-without-javascript-interface.md)）：安卓的 `addJavascriptInterface` 对 WebView 里所有页面和框架都可见，不能用。`ergoNative` 走 `addWebMessageListener` 和 `addDocumentStartJavaScript`，都只注册给配好的二狗来源，每条消息再核对来源和主框架。网页同步调的方法由垫片 `assets/ergo-native-shim.js` 接上。内置浏览器是另一个 WebView，只有页面桥，每句带 App 发的口令。

**联调**：`frontend/android/e2e/` 在模拟器上连临时守护进程跑，不进 `npm run check`，adb 命令都带串口，串口不是 `emulator-` 开头的直接报错。`e2e/browser.ts` 里有外部页面碰不到 `ergoNative` 的证明，改原生桥或页面桥时要跑。

**扫码连接**（鸿蒙和安卓一样）：地址页最上面"扫码连接"，扫到的文字走 `checkServerAddress`，再 `GET <来源>/api/access` 约 10 秒确认回话的是二狗（不带 cookie、不跟跳转），连不上不进配对页。判断在 `common/ConnectCheck.*`（只有判断，不碰网络），两边和协议包拿 `frontend/test/connect-vectors.tsv` 同一份例子核对。安卓用 Camera2 + ZXing 的 core 包，点按钮才要相机权限；鸿蒙用系统的 ScanKit 界面，不要相机权限。模拟器没有能对准屏幕的相机，`--webview-debug` 的包认两个测试入口（`ergoTestScanText`、`ergoTestScanImage`），正式的包没有。联调：`frontend/android/e2e/scan.ts`、`frontend/harmony/e2e/scan.ts`；安卓的相机帧到 ZXing 这一段用 `frontend/android/e2e/scan-camera.ts`（虚拟场景相机对着墙上的二维码海报）。

**原生录音**用 `AudioRecord`：进语音模式时建好、不采集，按下才 `startRecording`，松手 `stop`；切到后台、离开语音模式时 `release`。格式和鸿蒙一样（16 kHz、单声道、16 位 PCM），网页一侧不变。音源用 `MIC`。

**系统通知**是本地通知，不接 FCM，没有前台服务：进程活着才发得出，被系统杀掉后收不到。其余规矩和鸿蒙一样：第一次问授权，前台不发，同一件事只出一条，点了回到对应的页面。

### 发布手机安装包

`npm run release` 顺带把两个手机安装包放进发布目录、写进 `SHA256SUMS`，和 Windows 包一起被签：`ergo-android-debug.apk`、`ergo-harmony-unsigned.hap`。文件名不带版本号，这样 `releases/latest/download/<文件名>` 一直有效。`latest.json` 不提它们，`ergo update` 和安装脚本只认 Windows 包。

| 命令 | 做什么 |
|---|---|
| `npm run release` | 收现成的产物 |
| `npm run release -- --build-mobile` | 先构建再收。**正式发版用这个**，现成的产物可能是旧代码 |
| `npm run release -- --no-mobile` | 不带手机包 |

没工具链、没产物、产物不合格时，只跳过那一个，写明原因，Windows 包照打；工具链齐了却构建失败算出错。不合格指：APK 的证书不是发布用的那把（`frontend/scripts/android.ts` 的 `RELEASE_CERT_SHA256`），HAP 带了 `--webview-debug`。这次跳过了的包，教程里的下载地址在这个版本上会 404，发版前看一眼最后几行。

**发布用的调试钥匙：** 安卓包都用同一把钥匙签，用户才能一直覆盖安装。默认放在 `~/.ergo-release/ergo-android-debug.keystore`，也可以用环境变量 `ERGO_ANDROID_DEBUG_KEYSTORE` 指定，不进仓库。`npm run build:android` 找到它就用它签，找不到就用这台机器默认的调试签名，所以外人自己构建不受影响。带 `--webview-debug` 的包绝不用它签，这样凡是这把钥匙签的包都关着 WebView 调试。

**这把钥匙要备份。** 丢了或者换了，所有用户都要卸载重装、重新配对。别人拿到它能做出覆盖安装的假包，所以不要外传。口令按调试钥匙的惯例是 `android`，保护它靠文件本身。

## 写代码的约定

- **类型剥离的限制**（守护进程和协议包直接跑 `.ts`；网页由 Vite 打包，但同样遵守）：相对导入写 `.ts` 后缀；只用可擦除的语法（不用 `enum`、`namespace`、构造函数参数属性）；纯类型导入写 `import type`。`tsconfig.base.json` 的 `erasableSyntaxOnly`、`verbatimModuleSyntax` 会查。
- **pi 的边界**：`@earendil-works/*` 只能在 `packages/daemon/src/runtime/agent-child/` 里引用，任何地方都不许转导出 pi 的东西，`agent-child/` 之外不许 import 它里面的模块（`test/pi-boundary.test.ts`）。
- **项目系统的边界**：项目系统那几个目录之外只能 import 入口 `projects/api.ts`（运营层是 `project-ops/api.ts`）；要项目系统的新东西就在入口加一个"调用方要什么给什么"的小接口（`test/projects/boundary.test.ts`）。插件同理：内核只 import 插件的 `api.ts`。
- **个人数据和密钥永不进仓库**：数据目录从配置读，测试一律用临时目录。不要读、不要打印用户主目录下 `.ergo`、`.ssh` 等真实数据。
- **写文件先写临时文件再改名，一律走 `util/atomic-file.ts`**（`writeFileAtomic`、`renameRetrying` 和异步版）：Windows 上改名覆盖一个正被别的进程开着的文件会失败（哪怕对方只是在读），它会重试；不要直接 `fs.renameSync` 一个刚写的临时文件。
- **给用户看的文字走 `t()`**（[多语言](README.md#多语言)）；给模型看的、日志标 `@i18n-ignore`。
- **代码里负责人叫 maintainer**：界面、提示词、文档都叫负责人（英文 owner），代码标识符、事件类型、接口字段、频道名、语言文件的键叫 maintainer。
- **标识符用英文，注释用中文**；领域概念用 `CONTEXT.md` 里的词。例外：系统提示文件里的占位符名用中文（`{{拉回次数}}`、`{{#立项书已确认}}`，连同代码里填值时的键）——这些文件是给用户看、给用户改的，用户在设置页的编辑框里直接写这些名字。
- **每个阈值的默认值只在它自己的模块里定一次**，配置里只写要改的。
- **样式只用 `var(--token)`**，不写死颜色、圆角、阴影（[视觉风格](README.md#视觉风格)）。
- 依赖写死精确版本，`package-lock.json` 一起提交。

## 测试

### 车道

| 车道 | 跑什么 | 什么时候跑 |
|---|---|---|
| `npm run test:fast` | 守护进程里除主切面（`test/main`）、契约测试（`test/contract`）以外的全部 + 协议包 + 网页状态层 / UI / 构建检查 + 记忆 + 鸿蒙的检查 | 改完代码每次都跑（约 2 分钟） |
| `npm run test:integration` | 主切面（真的拉起守护进程和 agent 子进程）+ `page-opens`（构建一遍，用真 Chrome 打开每一页） | 改到守护进程主线、组合根、装配时，或者合并前 |
| `npm test` | 全量 = 快车道 + 主切面 + pi 契约测试 | 发版前（GitHub Actions 打 tag 时跑） |

`npm run test:contract`（pi 契约测试）每条用例单独拉起 agent 子进程，只在升级 pi、改 `agent-host/`、`runtime/`、提示词装配时跑。服务管家的测试是 `node --test`，`npm run test:supervisor` 单独跑。两条车道的 vitest 配置在根目录 `vitest.fast.config.ts`、`vitest.integration.config.ts`，全量走根 `vitest.config.ts`；改某个包的 `setupFiles` / `include` 时几处一起改。

### 测试底座

- **立项后负责人先开口**：正式跑时点"立项"会叫醒负责人（`projects.ts` 的 `kickoffFromCard`）；`startTestDaemon` 默认关着（`kickoffOpening`），假模型的剧本不多一轮，要测的写 `true`。
- **主切面**（`packages/daemon/test/main/`）：`startTestDaemon(options)` 起一个真的守护进程（临时数据目录、系统挑的空闲端口，**从不占用 8810、8811**），秘书、负责人、评审、子 agent 接 pi 的 faux provider 按剧本回话，子进程真的拉起；`TestFrontend` 扮演前端，经 WebSocket 和 HTTP 收发、按频道等事件。时钟用 `ManualClock` 拨，不真等。
- **守卫切面**（`packages/daemon/test/guard/`）：只调判定函数，不起进程；场景文件 `scenarios/*.guard.json` 逐个跑。
- **pi 契约测试**（`packages/daemon/test/contract/`）：只验二狗依赖的 pi 行为。
- **网页**：状态层用录下的事件流回放（`recordings/`，主切面现场录：`ERGO_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/recordings.test.ts`），页面用 `page-opens.test.ts` 在真 Chrome 里打开原型（本机没有 Chrome 时跳过）。
- **插件**：假内核 `test/helpers/plugin-kernel.ts` 的 `startPluginKernel`（见插件开发手册）。
- **测试里的密钥样本**在运行时拼（`test/helpers/fake-secrets.ts`），仓库里没有像真密钥的字符串。

### 不碰真数据、不联网

- 测试一律用临时目录，不碰 `~/.ergo`、不碰在跑的守护进程。
- 所有 vitest project 都挂了根目录的 `vitest.setup-no-network.mjs`：**经全局 `fetch` 发往本机回环以外的请求直接抛错**。它只拦 `fetch`，`net`、`tls` 直连拦不住，这种要自己守住。要测网络就用本机假服务（假 TTS、假 MCP、假的模型目录……）。测试一条都不花 token。
- **计划任务 `LocalServiceManager` 名字是固定的，开发机上有一个真的**：测试用 `ERGO_AUTOSTART_TASK_FILE` 换成一个 JSON 文件（`cli/autostart.ts`，安装脚本也认）。`ergo` 起 lsm 只有 `runLsm` 一个入口，在 vitest 里没设这个变量时，`install-autostart`、`uninstall-autostart` 到那儿就被拒绝，lsm 不起。`cli.test.ts`、`install-script.test.ts` 跑完比一次真任务的完整定义（只读）。安装脚本的测试用假的 `ergo.cmd`。

### Windows 上要注意

- 并行度：`ERGO_TEST_WORKERS` 设具体个数（不设是一半的核）；几套测试同时跑时用 2。
- 拨时钟跨过 03:00 会在后台唤醒记忆管理员：`startTestDaemon` 给了 `clock` 时默认停掉记忆插件，测记忆的用例写 `memoryPlugin: true`。
- 别在产品改名替换一个文件的途中轮询读它（Windows 上会 EPERM / ENOENT）：先等产品给的"做完了"的信号再读。
- 超时只为"慢"放宽，断言不放松。

## 升级 pi

1. `npm view @earendil-works/pi-coding-agent dist-tags` 查最新稳定版，读几个包 CHANGELOG 里的 Breaking Changes。
2. 所有 `@earendil-works/*` 一起改，都写精确版本：`packages/daemon/package.json` 的 `dependencies`、根 `package.json` 的 `overrides`（新版本 pi 的依赖里有新的 `@earendil-works/*` 包就也加进去）。
3. `npm install`，确认 `npm ls --all` 里 earendil 的包全是同一个版本。
4. `npm run typecheck` → `npm run test:contract` → `npm test`。子进程里挂给 pi 的只有通用桥接扩展（`runtime/agent-child/bridge.ts`），先对照 CHANGELOG 看它用到的事件、`agent-child/tool-order.ts` 用到的接口改了没有。
5. **核对 pi 的 Node 大版本**（[ADR-0031](adr/0031-node-version-follows-pi.md)）：看 pi 的 `.github/workflows/ci.yml` 的 `node-version` 和安装脚本的 `latest-v<大版本>.x` 变没变；变了就跟着换（`engines`、CI、安装包），跑全量。

## 文档、CHANGELOG、设计记录

- **改了行为，同一个提交里改文档**：用户看得到的改[用户指南](../user-guide/README.md)（有英文版的章节中英一起改），模块、协议、约定改[这一层](README.md)（中英两份），插件改插件开发手册（有测试核对代码片段和名字），新词加进 [CONTEXT.md](../../CONTEXT.md)。
- **CHANGELOG**：每个版本一节，写用户能感到的变化。
- **设计记录**（`docs/architecture/adr/`）：难以反悔、出人意料、或者在几个方案里取舍过的决定写一份 ADR，编号接着排，写背景、决定、后果。
- **记忆系统**的文档（`docs/architecture/memory-system.md`）有测试核对接口表、工具表、路径（`packages/memory/test/architecture-doc.test.ts`）。
- **第三方许可证**：依赖以 MIT / Apache-2.0 / BSD / ISC 为主，sharp 带的 libvips 是 LGPL-3.0，字体是 SIL OFL 1.1（网页构建时许可证跟着字体拷进 `dist/fonts/`）；lightningcss 是 MPL-2.0，但只在构建网页时用、不进安装包。完整清单由构建脚本生成（`packages/daemon/build/`，根目录的 `npm run release` 打到 `dist/release`），放在安装包根目录：`THIRD_PARTY_NOTICES.txt`（全文）和 `third-party-licenses.json`（名字、版本、许可证、从哪来）。Claude Code 的 Agent SDK（`@anthropic-ai/claude-agent-sdk`）是 Anthropic 自己的许可，是可选依赖，不随安装包分发。
