# 0022 鸿蒙 App 是原生壳，加载守护进程提供的网页，不把网页打包进 HAP

日期：2026-10-09
状态：已采纳（62 号票）

## 背景

用户 2026-10-09 要一个鸿蒙 App，根本目的是用系统原生的录音解决"按下才开麦有延迟、预热又一直占着麦克风"（63 号票）。开发环境照 AgentSense 的鸿蒙工程。

AgentSense 把网页打包进 HAP（`Web({ src: $rawfile('web/index.html') })`），网页需要的数据都在手机本地。二狗不一样：网页要连守护进程，外网端口上：

- 每个 HTTP 请求和 WebSocket 握手都要设备凭证，凭证是 `__Host-` 前缀、`SameSite=Strict`、HttpOnly 的 cookie（`pairing/credentials.ts`）；
- 带了 Origin 就必须和 Host 同源（`gateway/external.ts` 的 `checkExternalOrigin`）。

打包进 HAP 的网页的来源是 `resource://rawfile`，和二狗的地址不同源：cookie 带不过去，Origin 对不上，请求会被拒。

## 决定

- **鸿蒙 App 是原生壳**：第一次打开先填二狗的地址（https；本机调试 `http://127.0.0.1`、`http://localhost` 例外），存在应用本地（preferences），之后 ArkWeb 直接加载这个地址。网页照常由守护进程提供，和手机浏览器打开的是同一份。
- **App 是一台新设备**：ArkWeb 有自己的 cookie，第一次要像新浏览器一样配对；之后凭证留在 App 里。守护进程不需要为 App 做任何改动。
- **原生桥只对配好的来源开放**：`window.ergouNative`（javaScriptProxy）用 ArkWeb 自带的白名单（`permission`）限定来源，每次调用再按完整的来源（含端口）核对一遍当前页面；麦克风（`onPermissionRequest`）同样只对这个来源放行。主页面跳到别的来源时用系统浏览器打开，App 里只显示二狗。
- **仓库结构**：各种前端放在根目录 `frontend/` 下（`frontend/harmony/` 是 DevEco 工程，`frontend/android/` 先留空）；网页前端仍在 `packages/web/`。鸿蒙工程不进 npm workspaces，根目录的 tsc、oxlint、vitest 不扫它，由 DevEco 的 hvigor 构建（`npm run build:harmony`，依赖本机装的 DevEco，不进 `npm run check`）。

## 后果

- 网页改了不用重新打包 App：守护进程换了页面，App 下次加载就是新的。反过来，App 离不开守护进程：连不上时 App 显示原生的出错页（重试、改地址），没有离线能力。
- 网页靠检测 `window.ergouNative` 知道自己在 App 里（`packages/web/src/app/native-app.ts`），没有时一切照旧；原生能力（返回键、63 号票的录音等）都挂在这个对象上，网页一侧按"有没有这个接口"选后端。
- 系统返回键照搬 AgentSense：网页经 `setCanGoBack` 报还能不能在网页里返回，原生按返回键时调网页登记的 `window.__ergouBack()`，网页按返回栈（`packages/web/src/state/back-stack.ts`）先关弹窗、详情，再回上一级，到顶层才由原生退出 App。
- 地址填成了能打开、但不是二狗的网站时，网页不会调原生桥：原生在页面加载完 8 秒还没被调过时，在底部提示"这不是二狗？换地址"。
- 签名材料只在本机：工程级 `build-profile.json5` 在 .gitignore 里，仓库里只有不含签名的模板，构建脚本照模板生成；DevEco 的"自动生成签名"写进被忽略的那份。`frontend/test/harmony.test.ts` 检查会进仓库的文件里没有签名材料。

## 考虑过的做法

- **照 AgentSense 把网页打包进 HAP，接口请求发到守护进程**：跨源，凭证 cookie 是 `SameSite=Strict` 的 `__Host-` cookie，带不过去；要改成别的凭证（比如原生存一个 token 加到请求头上），等于给 App 另开一套认证，外网端口的安全模型要跟着改。不做。
- **打包进 HAP，再用 ArkWeb 的请求拦截把 `resource://` 的页面伪装成二狗的来源**：能绕过同源限制，但页面和守护进程的版本会脱节，拦截层本身也成了要维护的安全边界。不做。
