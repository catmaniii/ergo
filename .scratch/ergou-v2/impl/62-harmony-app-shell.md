# 62 — 鸿蒙 App：原生壳加载二狗的网页，`frontend/` 目录

Status: done
Blocked by: None — can start immediately
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI）"鸿蒙 App"

## What to build

用户 2026-10-09 要求：在仓库根目录建 `frontend/`，各种前端都放在下面。先编译一个鸿蒙的 HAP；安卓的文件夹先留着，不生成工程。

做鸿蒙 App 的根本目的是用系统原生的录音解决"按下才开麦有延迟、预热又一直占着麦克风"的问题，这一块在 63 号票。本票先把壳和构建打通。

开发环境参照 AgentSense 的鸿蒙工程：

- 工程目录：`D:\code\claudecode\user_agent_sense_of_security\AgentSense\`，只读。
- 构建、安装命令：该仓库 README 第 340–365 行一带。
- 本机已经装了 DevEco Studio（`D:\Program Files\Huawei\DevEco Studio`），自带 HarmonyOS 6.1.1 SDK（API 24）、hvigor、ohpm、hdc。

**和 AgentSense 的不同**：AgentSense 把网页打包进 HAP（`$rawfile('web/index.html')`），二狗不能这样。二狗的网页要连守护进程，外网端口上每个请求都要设备凭证（`__Host-` cookie，`SameSite=Strict`），还要求 Origin 和 Host 一致。打包进 HAP 的网页属于另一个来源，凭证带不过去，请求会被拒。所以二狗的 App 是原生壳：ArkWeb 加载用户配好的二狗地址，网页照常由守护进程提供。这个决定写一条 ADR。

## Acceptance criteria

- [x] **目录**：
  - `frontend/README.md` 写明各个前端在哪：
    - 网页前端：默认的那个，在 `packages/web/`，由守护进程提供；
    - `frontend/harmony/`：鸿蒙 App；
    - `frontend/android/`：先留空，只有一个 README 写"还没做"。
  - 鸿蒙工程照 AgentSense 的结构（stage 模型、`entry` 模块），bundleName 自定，写进 Comments。
- [x] **第一次打开**：
  - 先让用户填二狗的地址，比如公网地址或 tailnet 地址，存在应用本地（preferences）。
  - 地址校验：必须是 https。为了本机调试，`http://127.0.0.1`、`http://localhost` 例外。
  - 之后可以在 App 里改地址，入口自定，写进 Comments。
  - 地址不写进仓库，不写死在代码里。
- [x] **加载网页**：
  - ArkWeb 加载这个地址，配对、聊天、上传、WebSocket 都和手机浏览器里一样能用。
  - App 是个新设备，第一次要像新浏览器一样配对。
  - 返回键：网页能内部返回时先在网页里返回，照 AgentSense 的 `canGoBack` 做法。
  - 深浅色跟着网页的外观走，照 AgentSense 的 `setColorMode`。
- [x] **原生桥**：用 javaScriptProxy 注入一个名为 `ergouNative` 的对象，本票只放这几样：版本号、日志、设置地址、外观。
  - 桥只对用户配好的那个来源开放：每次调用都核对当前页面的来源，不对就拒绝。ArkWeb 有现成的白名单配置的话就用它。
  - 网页一侧（`packages/web`）检测到 `ergouNative` 时，在设置里显示"在鸿蒙 App 里运行"和 App 版本；没有时什么都不变。
- [x] **麦克风权限**：`module.json5` 声明 `ohos.permission.MICROPHONE`，运行时向用户申请；ArkWeb 的 `onPermissionRequest` 只对配好的来源放行麦克风。63 号票改用原生录音之前，网页的 getUserMedia 照旧能用。
- [x] **签名不进仓库**：签名材料（证书、profile、密码）只放在本机，不进仓库。
  - 比如把 `build-profile.json5` 放进 .gitignore，提交一份不含签名的模板，加一个脚本从模板生成；DevEco 自动签名写进的是被忽略的那份。具体做法自定，写进 Comments。
  - 加一个测试或检查，确保仓库里不会出现 signingConfigs 的材料。
- [x] **构建**：
  - 根目录加 `npm run build:harmony`：调用 DevEco 自带的 hvigor（路径从环境变量或默认安装位置找），产出 HAP。
  - 没签名时产出 unsigned 的 HAP，并提示怎么签。
  - 这个命令不进 `npm run check`，因为它依赖 DevEco。
  - 本票收尾时实际跑一次，产出一个 HAP，在回报里写明路径和大小。
- [x] **文档**：`docs/dev.md` 加"鸿蒙 App"一节，写清楚：
  - 怎么构建；
  - 怎么签名：用户在 DevEco 里打开 `frontend/harmony`，登录华为账号，点"自动生成签名"，只要做一次；
  - 怎么用 hdc 装到手机或模拟器、怎么启动；
  - 怎么调试 ArkWeb（照 AgentSense README 的 devtools 端口转发）。
- [x] **测试**：网页一侧检测原生桥的逻辑有单元测试，用假的 `ergouNative`。所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 鸿蒙工程的 ArkTS 文件（`.ets`）不进 oxlint 和 vitest。别让 `npm run check` 去扫 `frontend/harmony` 下的 `oh_modules`、`build` 等目录。
- 不要用 AgentSense 的签名材料：它们绑定 AgentSense 的 bundleName，也属于本机私有材料。
- 不在本票：原生录音（63 号票）、安卓工程。

## Comments

- **实现**（2026-10-09）：
  - 目录：`frontend/README.md`（各个前端在哪）、`frontend/android/README.md`（还没做）、`frontend/harmony/`（DevEco 工程，照 AgentSense：stage 模型、`entry` 模块，HarmonyOS 6.1.1 / API 24）。`frontend/scripts/`（构建脚本）和 `frontend/test/`（签名检查）是 vitest 的 `frontend` project、根目录 `typecheck` 多跑一次 `tsc -p frontend`；`frontend/harmony/**` 在 `.oxlintrc.json` 里忽略，tsc、vitest 都不扫它。
  - **bundleName：`com.example.ergou`**（照 AgentSense 的 `com.example.agentsense`，那个在用户的账号上自动签名可行），`versionName` 0.1.0。
  - 原生壳（`entry/src/main/ets/pages/Index.ets`）：没配地址先显示地址页；地址存在 preferences `ergou_app` 的 `server_url`。校验（`common/ServerAddress.ets`）：必须 https；`http://127.0.0.1`、`http://localhost` 例外（端口随意）；没写 scheme 补 `https://`；去掉 `#`；不许带用户名密码。
  - **改地址的入口**：网页"设置"最上面"在鸿蒙 App 里运行"一栏的"换地址"（经原生桥 `editServer()`）；网页打不开（主页面网络出错、HTTP ≥400、地址重定向到别的来源）时原生出错页上的"改地址"（还有"重试"）。地址页上按返回键回到网页。换了地址，Web 组件连同 controller、原生桥整个重建（`ForEach` 的键跟着换），因为白名单是注册时定的。地址填成了能正常打开、但不是二狗的网站（用户 2026-10-09 要求补上入口）：页面加载完（`onPageEnd`）8 秒网页还没调过原生桥（二狗的网页一打开就会问 App 的版本号，原生桥据此记下"调过了"），底部出一条"这不是二狗？[换地址] [关闭]"；之后网页调过来了就收起。注意：守护进程提供的网页要是本票合并之前构建的（还不会检测原生桥），这一条也会出来，点关闭即可；合并后重新 `npm run build:web` 就没了。
  - 原生桥（`bridge/NativeBridge.ets`）：`appVersion()`、`log(message)`、`editServer()`、`setColorMode(mode)`、`setCanGoBack(flag)`（返回键，照搬 AgentSense），都是同步方法。只对配好的来源开放：用了 ArkWeb 自带的白名单（javaScriptProxy 的 `permission`，对象级的 `urlPermissionList`：scheme、主机、写了端口的还有端口；格式照 OpenHarmony 文档），每次调用再按完整的来源（含端口）核对 `controller.getUrl()`，不对就不做事、返回空串、记一条 hilog。评审后加了主框架核对：ArkWeb 把对象注入所有框架（含 iframe），白名单按调用的那个框架的网址查；每次调用再要求调用的框架（`controller.getLastJavascriptProxyCallingFrameUrl()`）和主框架（`getUrl()`）都是配好的来源、而且去掉 `#` 后网址相同。**残留风险**：同一来源、网址和主框架一模一样的 iframe 分不出来（二狗的网页不用 iframe，这样的 iframe 只能来自二狗自己的页面）。
  - 网页一侧（`packages/web`）：`app/native-app.ts` 的 `detectNativeApp`（没有 `ergouNative`、形状不对、App 拒绝了这个页面（版本号回空串）都当不在 App 里）、`followThemeInApp`（一认出就把外观告诉 App，之后选择变了再告诉；跟随系统时系统切深浅色不重复告诉）；`app/page-native.ts` 接到 `window`，`main.tsx` 开场 `connectNativeApp()`；`pages/more/NativeAppInfo.tsx` 在设置列表最上面显示"在鸿蒙 App 里运行"、App 版本、"换地址"，不在 App 里返回 null。测试 `test/app/native-app.test.ts`（17 条，假的原生桥）。
  - 深浅色：照 AgentSense 的 `setColorMode`，另外把选择记进 preferences，`EntryAbility.onCreate` 开场先按它定深浅色（AgentSense 的 EntryAbility 也是这样读的）。网页自己 `darkMode(Auto)`、`forceDarkAccess(false)`。
  - 麦克风：`module.json5` 声明 `ohos.permission.MICROPHONE`（reason、usedScene inuse）。`onPermissionRequest`：来源是配好的、请求的只有 `TYPE_AUDIO_CAPTURE` 才往下走，App 还没有权限就 `requestPermissionsFromUser`，同意才 `grant`，其他一律 `deny`。
  - 别的来源：主页面要跳到别的来源时（`onLoadIntercept`）交给系统浏览器（`openLink`）；是地址本身重定向过去的就显示出错页。`mailto:`、`sms:`、别的 App 的链接交给系统（`openLink`），`tel:` 拉起拨号界面（`call.makeCall`，没有电话能力的退回 `openLink`），不落到出错页（评审后加）。
  - 切到后台时 `WebCookieManager.saveCookieAsync()`：设备凭证在 cookie 里，App 被系统杀掉也不用重新配对。
- **ADR**：`docs/adr/0022-harmony-app-native-shell-loads-daemon-page.md`（原来编的 0020，主会话要求改成 0022：0020 给 53 号票、0021 给 39 号票）。
- **签名的做法**：工程级 `build-profile.json5` 在 `frontend/harmony/.gitignore` 里；仓库里是不含签名的 `build-profile.template.json5`（`signingConfigs: []`）；`npm run build:harmony` 发现本机没有 `build-profile.json5` 就照模板生成（有了就不动）。用户在 DevEco 里点"自动生成签名"，材料写进被忽略的那份和用户目录下的 `.ohos/config/`。`frontend/test/harmony.test.ts` 检查会进仓库的文件（`git ls-files --cached --others --exclude-standard`）里没有签名材料（非空 `signingConfigs`、口令和材料路径字段、指向 `.p12`/`.p7b`/`.cer`/`.csr` 的路径，也没有这几种文件），`build-profile.json5`、`oh_modules`、`build`、`.hvigor`、`.idea`、`local.properties`、证书文件都被忽略；往工程里放一份带签名的文件试过，会红。模板以后改了，本机那份不会跟着变（模板开头和 `docs/dev.md` 写了怎么办）。没用、没碰 AgentSense 的签名材料。评审后（主会话定）扩到整个仓库：根目录 `.gitignore` 加了 `*.p12`、`*.p7b`、`*.cer`、`*.csr` 和 `/frontend/harmony/build-profile.json5`；检查改成扫整个仓库会进版本库的文件（已跟踪的加上没跟踪、也没被忽略的），只有检查器自己的两个文件（`frontend/scripts/harmony.ts`、`frontend/test/harmony.test.ts`，里面有扩展名表和编的签名样本）不按内容查；在 `packages/` 下放一份带签名的文件试过，会红。
- **构建**：`npm run build:harmony`（`frontend/scripts/build-harmony.ts`）：DevEco 先看 `DEVECO_HOME`，再找 `D:\` / `C:\Program Files\Huawei\DevEco Studio`（macOS 的位置也写了）；直接用 DevEco 自带的 Node 跑 `tools/hvigor/bin/hvigorw.js`（`hvigorw.bat` 也只是这样跑，而且它不认 `NODE_HOME`），`DEVECO_SDK_HOME=<DevEco>/sdk`，`assembleHap`、debug。工程没有 ohpm 依赖（AgentSense 的 hypium/hamock 是测试用的，这里没有 ohosTest），不联网。2026-10-09 实际跑过：`frontend/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`，107.4 KB（109,936 字节；评审后的修改之后，基于 e76fe82，WebView 调试关），干净构建约 40 秒，ArkTS 编译没有警告。没签名时脚本打印签名的三步（含先用 USB 连上手机）。
- **和 AgentSense 不一样的地方**：
  - **返回键：照搬 AgentSense**（用户 2026-10-09 定；最初做成了 WebView 历史，`accessBackward()`/`backward()`，评审后改掉）。网页经原生桥 `setCanGoBack(flag)` 报"现在还能不能在网页里返回上一级"，原生按返回键时，能就 `runJavaScript('window.__ergouBack && window.__ergouBack()')`，不能（到了顶层）就交给系统退出 App；地址页、出错页上另有原生自己的处理。网页一侧：
    - 状态层 `state/back-stack.ts`：返回栈，纯函数，表格测试 `test/state/back-stack.test.ts`（13 条）。开着的各层分 `overlay`（弹窗、选择器、详情、抽屉）和 `page`（这一页有"返回上一级"），先退最后挂上的 overlay，再退最后挂上的 page。
    - `app/back-registry.ts`（各层的关法、变了通知；`test/app/back-registry.test.ts` 5 条）、`app/page-back.ts`（这个页面的那一份和钩子 `useBackLayer`）、`native-app.ts` 的 `followBackInApp`（登记 `window.__ergouBack`，能不能返回变了才告诉 App）。
    - 接进来的：`Sheet`（所有弹窗、确认框、竖屏的工具调用详情）、`TopBar` 的 `onBack`（层级路由就是各页标题栏的"‹ 返回"：任务详情回看板、维护者会话回项目页、设置子页回设置、窄屏的日历某天回这个月、卡片页和批准页回待我处理……宽屏不显示返回的不挂，和 AgentSense 宽屏不算"返回列表"一致）、宽屏的工具调用详情栏、日历的年月选择面板、待我处理一行的"更多操作"菜单、输入框的附件菜单、竖屏任务详情的阶段抽屉；评审后补上会话缩小时先回对话层（25 号票分段按钮切到要点层、全局层时挂一层，返回回到完整视图，照 AgentSense 的 `level>0 → zoomTo(0)`；54 号票的捏合缩放按同样的规矩接）和语音气泡的长按菜单；变基到 43、53 号票之后，43 号票设置里的"个人助理的名字"改了一半没保存时也挂一层（返回先撤销这次修改），43、53 号票新加的弹窗都是 `Sheet`，自动接上。路由本身没改（`route-hash.ts` 不动）。56 号票的窄屏详情页开着时调 `useBackLayer("overlay", 开着, 关掉)` 接进来。
    - 不在 App 里时没人调 `__ergouBack`，浏览器的行为不变。
  - 调试 WebView 的开关：AgentSense 一直开。评审后（主会话定）改成默认关：开着的话接上 USB、能跑 hdc 的人就能经 DevTools 取走设备凭证 cookie。只有 `npm run build:harmony -- --webview-debug` 构建的才开（`entry/hvigorfile.ts` 读 hvigor 的 `-p webviewDebug=true`，写进生成的 `BuildProfile.WEBVIEW_DEBUG`；只跑 `CreateBuildProfile` 试过 true 会写进去，默认构建是 false）。别的参数一律报错，免得拼错了以为开了。风险写在 `docs/dev.md`。
  - 图标：AgentSense 工程里的 PNG 已经坏了（`0x89` 被换成了 UTF-8 的替换字符），没法复制；用 PIL 画了一个（网页主色 #3b6cf6 底、两道白色横条，"二"）。
  - 没带 AgentSense 模板里的 `EntryBackupAbility`（备份扩展，用不上）和 ohosTest。`deviceTypes` 是 phone、tablet（AgentSense 只有 phone）。
- **"加载网页"一条**：返回键照 AgentSense 做完后勾上。配对、聊天、上传、WebSocket 还没在真机上看过（见下面的待验清单）。
- **真机待验**（我没往设备、模拟器上装任何东西，下面都要用户签名装上后看）：
  - 第一次打开填地址、配对、聊天、上传附件、WebSocket 断线重连；
  - 杀掉 App 再开，不用重新配对（cookie 落盘）；
  - 返回键：开着弹窗、阶段抽屉时先关它；任务详情 → 看板 → 退出 App；设置子页 → 设置 → 更多 → 退出；
  - 设置里切外观，状态栏跟着变；重开 App 不闪另一种颜色；
  - 按住说话：第一次弹系统的麦克风授权，之后网页的 getUserMedia 能录；
  - 原生桥：设置里显示"在鸿蒙 App 里运行 / App 版本 0.1.0"，"换地址"能回到地址页；
  - 地址写错（连不上、404）时的出错页，"重试"、"改地址"；地址填成别的网站时 8 秒后底部出"这不是二狗？换地址"；
  - 回复里的外链在系统浏览器里打开；`mailto:` 打开邮件应用，`tel:` 打开拨号界面；
  - 会话切到要点层、全局层时按返回键回到完整视图；语音气泡长按菜单开着时按返回键先关菜单；
  - 原生桥的主框架核对：真机上 `getLastJavascriptProxyCallingFrameUrl()` 和 `getUrl()` 去掉 `#` 后应当相同；要是不同，设置里不会出现"在鸿蒙 App 里运行"、8 秒后还会出"这不是二狗？"，hilog 里有 `bridge ... refused` 和两个来源。

- 2026-10-09 完成：两轴评审后补了缩小时和语音长按菜单的返回层，安全上签名材料检查扩到全仓库、WebView 调试默认关、原生桥不对 iframe 开放、mailto/tel 交给系统；返回键照搬 AgentSense（用户定）。ADR 0022。HAP 未签名，用户在 DevEco 自动签名一次后可装。
