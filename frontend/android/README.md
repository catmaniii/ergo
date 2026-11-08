# 安卓 App

Kotlin 原生壳加系统 WebView，加载用户配好的二狗地址，不把网页打包进 App（[ADR-0022](../../docs/architecture/adr/0022-harmony-app-native-shell-loads-daemon-page.md)）。和鸿蒙 App（`frontend/harmony/`）是同一个产品：原生画的部分照鸿蒙的 ArkTS 取值，取值集中在 `ui/ErgoTheme.kt`。

- 包名 `com.catmaniii.ergo`，最低 API 26（安卓 8），目标 API 36。
- 只侧载，不上应用商店。发布页上的 `ergo-android-debug.apk` 是调试版，用发布用的调试钥匙签（见下面）；正式签名材料只放本机，不进仓库。
- 电脑上的二狗带着同一版的这个包（`downloads/`，发布包里在 `app\downloads\`）：设置 · 设备配对里点"更新"，App 自己从二狗下载、核对、调起系统安装（`update/`，要 `REQUEST_INSTALL_PACKAGES`）。旧 App 没有这个方法，页面退回成从二狗直接下载 APK。
- 通知是本地通知，不接 FCM，没有前台服务。App 被系统杀掉后收不到，手册写明。
- 第一版不做手机数据源（通讯录、日历、相册、位置）。网页发现 App 没有这组方法，只显示说明，不报错。

## 构建

```powershell
npm run build:android                    # 调试版，WebView 调试关着
npm run build:android -- --webview-debug # 打开 WebView 调试（联调时用这个包）
npm run build:android -- --release       # 正式版，要本机有 keystore.properties
```

要装 Android SDK（`ANDROID_HOME`，没设就找默认位置）和 JDK 17 以上（Android Studio 自带的也行）。脚本先把页面桥打包进 `assets/page-bridge.js`、把自带语言收进 `assets/harmony-texts.json`（都是现生成的，不进仓库），再调 Gradle。第一次构建要从 Google Maven、Maven Central、Gradle 官方取构建插件和 AndroidX 库。

不带 `--webview-debug` 的包虽然是调试签名，但不可调试（`debuggable=false`）：Chrome 的 inspect 连不上，也不能 `run-as` 读私有数据。系统对可调试的 App 一律开着 WebView 调试，关不掉，所以两件事绑在一起。给人用的手机上装不带这个参数的包。

产物：`app/build/outputs/apk/debug/app-debug.apk`；正式版是 `app/build/outputs/apk/release/app-release.apk`，本机没配签名时是 `app-release-unsigned.apk`。

### 发布用的调试钥匙

发布页上的 APK 每个版本都用同一把钥匙签，用户才能覆盖安装。`npm run build:android` 依次找环境变量 `ERGO_ANDROID_DEBUG_KEYSTORE` 指的文件、`~/.ergo-release/ergo-android-debug.keystore`，找到就经 Gradle 属性 `ergoDebugKeystore` 用它签，脚本第一行写明这次用的是哪把。找不到就用这台机器默认的调试签名，外人自己构建不受影响。带 `--webview-debug` 的包绝不用它签。

`npm run release` 只收证书对得上 `scripts/android.ts` 里 `RELEASE_CERT_SHA256` 的 APK。这把钥匙要备份，丢了所有用户都要卸载重装。详见[开发文档](../../docs/architecture/development.md#发布手机安装包)。

### 正式签名

材料只在本机。在 `frontend/android/` 下放 `keystore.properties`（被忽略，`*.jks`、`*.keystore` 也被忽略）：

```properties
storeFile=D:/私密目录/ergo-release.jks
storePassword=…
keyAlias=ergo
keyPassword=…
```

`storeFile` 相对 `frontend/android/` 算，也可以写绝对路径。没有这个文件时，`--release` 出的是没签名的包（装不上），不会用调试签名冒充正式版。

## 装到真机

```powershell
adb devices                                   # 找到手机的串号
adb -s <串号> install -r frontend\android\app\build\outputs\apk\debug\app-debug.apk
adb -s <串号> shell am start -n com.catmaniii.ergo/.MainActivity
adb -s <串号> logcat -s ErgoApp               # App 和网页的日志
```

第一次打开填二狗的外网地址（https），再按页面提示配对。App 是一台新设备，凭证留在 App 自己的 WebView 里。

调试版和正式版签名不同，下载的和自己构建的也不同（除非本机有发布用的调试钥匙）。换着装要先卸载（凭证跟着没了，要重新配对）。

## 代码

| 目录 | 内容 |
|---|---|
| `app/src/main/java/.../MainActivity.kt` | 外壳：地址页、扫码连接的流程、出错页、主界面 WebView、返回键、避让、外观 |
| `app/src/main/java/.../scan/QrScanner.kt` | 扫码连接：Camera2 取景，ZXing 的 core 包解码（只认二维码） |
| `app/src/main/java/.../common/ConnectCheck.kt`、`ConnectProbe.kt` | 扫到之后测连不连得上：判断（和鸿蒙拿同一份例子核对）和真的请求一次 |
| `bridge/` | 原生桥。`BridgeChannel` 是消息通道和来源核对，`NativeBridge` 是方法表和分发 |
| `assets/ergo-native-shim.js` | 网页这一侧的垫片：定义 `window.ergoNative`，只注入配好的来源 |
| `browser/` | 内置浏览器（`InAppBrowser`）、页面桥（`PageControl`）、⋮ 菜单（`BrowserTools`）、能渲染的文件（`FileDocs`）、侧边栏（`SidePanel`） |
| `download/` | 下载：App 自己发请求，弹系统的保存框 |
| `update/` | 在 App 里更新 App（票 399）：从二狗下载它带的安装包、核 SHA-256 和包名、versionCode、签名证书，交给系统的 PackageInstaller 装；`UpdateChecks.kt` 是不碰系统的判断（JVM 单测） |
| `video/` | 网页视频真全屏（票 407）：`onShowCustomView` 交来的画面铺满一层，藏系统栏、常亮，横视频转横屏；返回键、切后台、换地址先退全屏，退出时都恢复。`FullscreenChecks.kt` 是不碰系统的判断（JVM 单测）。原生桥上的 `videoFullscreen()` 回 `true`，网页据此给全屏按钮 |
| `voice/` | 原生录音 |
| `notify/` | 系统通知 |
| `ui/ErgoTheme.kt` | 从鸿蒙取来的颜色、字号、间距、动画时长，注释写着对应鸿蒙哪个文件 |
| `common/` | 地址校验、设置、语言 |

### 安全

设计和理由见 [ADR-0040](../../docs/architecture/adr/0040-android-app-native-bridge-without-javascript-interface.md)。改这几处时注意：

- 仓库里不许调 `addJavascriptInterface`（`frontend/test/android.test.ts` 查）。`ergoNative` 经只开给二狗来源的消息通道，每条消息核对来源和主框架。
- 内置浏览器那个 WebView 不挂原生桥，外部网页只有页面桥，每句带 App 发的口令。
- 关文件访问，不开混合内容，证书错误一律 `cancel`。
- 设备凭证的 cookie 属性不削弱；清网站数据时存下再写回，属性照旧（`__Host-`、`Secure`、`HttpOnly`、`SameSite=Strict`）。
- App 不存模型的 Key。

### 和鸿蒙对照

网页一侧的权威定义是 `packages/web/src/app/native*.ts`，契约测试核对：网页要的方法安卓都有，和鸿蒙的方法表比只少手机数据源。

## 测试

- `frontend/test/android.test.ts`：跟 `npm run check` 一起跑，静态核对方法表、安全规矩、语言文件。
- `app/src/test/`：JVM 单测（地址校验），`gradlew :app:testDebugUnitTest`。
- `e2e/`：模拟器联调，不进 `npm run check`（要模拟器）。连的是临时守护进程（临时数据目录、假模型），外部网页是本机起的假网站，不联网。所有 adb 命令都带串口，串口不是 `emulator-` 开头的直接报错，不会碰真机。

```bash
# 起模拟器（无窗口）
emulator -avd Medium_Phone_API_36.0 -port 5570 -no-window -no-audio -no-boot-anim -read-only -no-snapshot -gpu swiftshader_indirect

npm run build:android -- --webview-debug
node frontend/android/e2e/run.ts emulator-5570 <截图目录>       # 外壳、配对、语言、外观、返回键、录音、通知
node frontend/android/e2e/browser.ts emulator-5570 <截图目录>   # 外部页面碰不到 ergoNative、内置浏览器、侧边栏、下载、⋮ 菜单
node frontend/android/e2e/scan.ts emulator-5570 <截图目录>      # 扫码连接：相机权限、取景、每种连不上的报错、真的二维码喂给 ZXing、就地批准
node frontend/android/e2e/scan-camera.ts run emulator-5570 17590 <截图目录>   # 相机这条路：虚拟场景相机对着墙上的二维码海报（模拟器的启动参数不同，见文件开头）
node frontend/android/e2e/app-update.ts new emulator-5570 <旧包> <新包> <换钥匙的包> <新版本号> <截图目录>   # App 内更新：有新版、三种不装、第一次授权、装好（包怎么准备见文件开头）
node frontend/android/e2e/app-update.ts old emulator-5570 downloads/ergo-android-debug.apk <截图目录>       # 旧 App：从二狗直接下载 .apk，在"文件"里点开装上
node frontend/android/e2e/video-fullscreen.ts emulator-5570 <截图目录>  # 网页视频真全屏：藏系统栏、横视频转横屏、返回先退全屏、切后台不留半截（要 ffmpeg 现生成测试视频）
```

全屏联调的两个坑（都是测试工具的，不是 App 的）：横屏时跑 `uiautomator dump` 会把系统锁定的方向改成横的，退出全屏就转不回来；DevTools 连着时 WebView 自己让屏幕常亮，看 App 加的常亮要先断开 DevTools。`video-fullscreen.ts` 开头写着怎么避开。

`-no-audio` 下麦克风全静音：网页收到录音、判为没声音，联调到这一步为止。真人说话和上传识别要真机验。

## 图标

由 `frontend/icon/generate.mjs` 生成，通知栏的单色小图标是手画的矢量，见 `frontend/icon/README.md`。
