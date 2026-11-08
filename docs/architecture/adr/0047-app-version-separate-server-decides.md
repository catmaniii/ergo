# ADR-0047 手机 App 一个自己的版本号，够不够新只由服务端判断

状态：已定（"App 不保存服务端版本、服务端判断、太旧才通知"是用户定的，其余是实现时定的）

## 背景

- 手机 App 只是壳：`web.loadUrl(address.href)` 打开电脑上的二狗，页面永远是服务端最新的（ADR-0022）。原生代码几个月才变一次。
- 以前 App 和电脑版共用一个版本号，每发一版电脑版都要重新编译两个包，用户也分不清要不要重装。实际上 0.4.1 到 0.4.2 原生代码和页面桥一行没变。
- 反过来，页面哪天开始依赖一个新的原生能力，旧 App 上那个功能就坏了，而服务端不知道手机上是哪个版本，没法说一声。
- 两个 App 本来就有 `appVersion()`，页面读得到。所以已经装着的 App 不用改就能报版本。

## 决定

1. **App 自己一个版本号：** `frontend/app-version.json`（`version`、`code`），安卓、鸿蒙共用。安卓的 `build.gradle.kts` 读它；鸿蒙的 `app.json5` 读不了外部文件，由 `frontend/test/app-version.test.ts` 核对（连同 `frontend/android/e2e/run.ts`、`downloads/README.md`）。电脑版改版本号不再碰这些。
2. **App 不保存、不判断服务端的版本，只报自己的。** 判断只在服务端这一边做，所以新规则不用升 App 就生效，旧 App 也能被认出来。
3. **一个最低版本的常量：** 协议包的 `MIN_APP_VERSION`。页面开始依赖新的原生能力时才升它，电脑版升级不用动。版本号按数字段比（`0.10.0` 比 `0.9.9` 新），读不到的算最旧。
4. **初始值是 0.4.1：** `v0.4.0` 到现在，`NATIVE_BRIDGE_METHODS` 的名字没变，但页面在用的两组新操作只有 0.4.1 起才有：`browserPage` 的 `elementInfo`、`elementPrepare`、`elementChunk`、`elementRect`、`elementShotDone`，`browserTool` 的 `elementFetch` 这些（长按网页元素的圆钮）。安卓 App 也是 0.4.1 才有。
5. **怎么报：** 页面在 WebSocket 订阅上之后发 `report_app_version`（版本、哪种 App），重连后再发一次，不带幂等键。和 `browser_status` 同一个写法，不用另开 HTTP：连接已经认出是哪台设备。页面是服务端的，所以改完页面，已装的旧 App 也报。重连时再报的好处是：电脑版升级、最低版本变了，还开着的旧页面重连时就能被判断到，即使 App 在后台。
6. **记在这台已配对设备上：** `PairedDevice.appVersion`、`appPlatform`，变了才落一条 `device` 事件（`change: app_version`）。本机端口的连接没有设备，不记。
7. **怎么通知：** 低于最低版本时放一条待办（`app_outdated`，不卡任务）并 `inbox.alert`，走现有的"待办 → 手机系统通知"。编号是设备加要求，所以一台设备的同一个要求只通知一次，用户删了也不再放。报上来够新了、要求变高了换了新的一条、设备吊销或删除了，开着的那条自动归档。
8. **页面上的提示条单独判断：** `AppUpgradeBar` 直接看本机版本和 `MIN_APP_VERSION`。页面就是服务端给的，里面的常量就是服务端的要求，不用另外问。App 被系统杀过、通知发不出去，打开也看得到。安卓给 APK 链接，鸿蒙给手机安装教程（没法替用户签名），认不出哪种 App 给"装 App"那一节。
9. **哪种 App 看浏览器标识：** 两个 App 的原生桥上没有说自己是什么的方法，加了就要升 App。鸿蒙写 `OpenHarmony`、`ArkWeb`，安卓写 `Android`。
10. **打包跟着 App 版本走（`packages/daemon/build/app-version.ts`）：** `npm run release -- --build-mobile` 比较 `frontend/app-version.json` 和 `downloads/README.md`。不一样就是升了，编译并提示更新 `downloads/`。一样时看从上次改版本号、或上次把新打的两个包换进 `downloads/`（取晚的那次）到现在，`frontend/` 或 `packages/web/src/page-bridge` 有没有变：变了报错退出，要求先升 App 版本；没变就不编译，直接用 `downloads/` 里现成的两个包，SHA256 照算。结束打印一行给发布说明用：`手机 App：不用升级` 或 `手机 App：需要升级到 x.y`（`MIN_APP_VERSION` 比上一个发布高了才算）。

## 后果

- 发电脑版不用编译 App，也不用手机工具链。
- 改了原生代码或页面桥忘了升版本，发版时会被拦下。`frontend/` 下不进 App 的（测试、模拟器联调、说明）不算。
- App 在前台时通知走现有规则，不进系统通知栏，只有页面顶上的提示和提示条。首次发现太旧多半就是这种情况；系统通知主要用在 App 在后台、服务端升级后重连的时候。App 的进程没了就发不出，等用户打开时看提示条。
- 升了 `MIN_APP_VERSION` 的那一版，所有低于它的 App 都会被提醒，所以它不能比现有的 App 版本还高（测试查）。


## 补充：安卓在 App 里更新，安装包由二狗发（票 399，2026-11-03）

"做成二狗服务端的功能、App 只下载和调起系统安装、只对安卓"是用户定的，其余是实现时定的。

1. **二狗带着同一版的安卓包**：版本目录的 `app\downloads\`（安装包加 `ergo-android.json`），直接从仓库跑时是仓库的 `downloads/`（`downloads/README.md` 的版本要等于 `frontend/app-version.json`）。发布包里的和发布附件同一套核对（证书对得上 `RELEASE_CERT_SHA256`），不合格就不带。运行时不去 GitHub 下。
2. **接口**：`GET /api/app-update`（`AppUpdateView`：版本、versionCode、SHA-256、大小）、`GET /api/app-update/android.apk`（`application/vnd.android.package-archive`，文件名 `ergo-android-<版本>.apk`，带长度，版本和 SHA-256 也在响应头）。和别的接口一样，外网端口要设备凭证。
3. **该不该更新还是服务端判断**：页面（服务端给的）比这台设备报上来的版本和二狗带的版本，低就在设置 · 设备配对那一行写"有新版"，这台手机自己的那一行多一个"更新"。**只对安卓**：版本号两边共用，鸿蒙包没变也会跟着升号，而且装不了。低于 `MIN_APP_VERSION` 的提示条照旧，安卓带着包时按钮换成"更新"。`MIN_APP_VERSION` 不升：新页面在旧 App 上照样能用（退回成直接下载）。
4. **App 这边**：原生桥多一个 `installAppUpdate`（Promise），只开给主界面。App 自己带设备凭证下到缓存目录，只认配好的二狗来源、不跟重定向；核 SHA-256，再核包名、versionCode 比装着的高、签名证书和装着的一样，不对就不装、回原因；没有"安装未知应用"的授权先带去系统设置，回来接着装；`PackageInstaller` 会话装，安卓 12 起 `USER_ACTION_NOT_REQUIRED`（要声明 `UPDATE_PACKAGES_WITHOUT_USER_ACTION`）。进度推给网页的 `window.__ergoAppUpdate`。装的时候系统关掉 App，装好后 `MY_PACKAGE_REPLACED` 里把它再打开（只认 App 里点的那一次）。
5. **旧 App（0.4.2 及以前）没有这个方法**：按钮退回成从二狗直接下载的链接，类型给对了，旧 App 的下载也存成 `.apk`，在"文件"里点开装。装上第一个带这功能的版本之后，以后都在 App 里点一下。

被否掉的：App 自己去 GitHub 下（国内慢，而且要 App 知道去哪下，判断又回到 App 里）；后台自动下载、自动装（用户点了才下）；鸿蒙自更新（不经华为应用市场装不了）。

## Considered Options

- **App 里存服务端版本、自己判断：** 判断规则焊进了 App，要改规则先得升 App，而太旧的 App 正是不会升的那些。用户明确不要。
- **页面用原生桥上有没有某个方法来判断：** 只能一个功能一个功能地判断，给不出"要升到哪一版"，也记不到设备上。各功能照旧按方法判断自己能不能用，这里只管整体提醒。
- **走 HTTP 报：** 还要再写路径、网关、组合根几处，多一条要带设备凭证的请求。WebSocket 已经连着。
- **在配对请求里带版本：** 配对只有一次，升级之后报不上来。
- **提示条问守护进程要最低版本：** 多一次请求，守护进程没连上时反而看不到。页面本来就是它给的。
- **前台也强制发系统通知：** `force` 是给 Debug 工具集用的，人就在页面上时再响一下只是打扰。
- **`frontend/` 下任何改动都算 App 变了：** 改测试、改说明也要用户重装，不合理，所以排除不进 App 的。
