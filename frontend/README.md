# 二狗的前端

二狗有几种前端，都连同一个守护进程：

| 前端 | 在哪 | 是什么 |
|---|---|---|
| 网页前端（默认） | `packages/web/` | React 19 + Vite。由守护进程提供（本机 `http://127.0.0.1:8810/`，外网经 HTTPS 域名），手机、电脑的浏览器直接打开。见 `docs/architecture/README.md` 的"网页" |
| 鸿蒙 App | `frontend/harmony/` | DevEco 工程（stage 模型，`entry` 模块，bundleName `com.catmaniii.ergo`）。原生壳：ArkWeb 加载用户配好的二狗地址，网页还是守护进程提供的那份；原生桥 `window.ergoNative` 只对这个地址开放；按住说话用原生录音（AudioCapturer 备好不占麦克风，按下才开始）。构建、签名、安装、调试见 `docs/architecture/development.md` 的"鸿蒙 App"，为什么不把网页打包进 App 见 `docs/architecture/adr/0022` |
| 安卓 App | `frontend/android/` | Gradle 工程（Kotlin，包名 `com.catmaniii.ergo`，最低 API 26，目标 API 36）。原生壳：系统 WebView 加载用户配好的二狗地址，加原生录音、内置浏览器、侧边栏、下载、本地通知；视觉照鸿蒙取值。见 `android/README.md` |

这一层的其他文件：

- `scripts/build-harmony.ts`：`npm run build:harmony` 的实现，用 DevEco 自带的 hvigor 构建鸿蒙 App；`scripts/harmony.ts` 是它用到的辅助（找 DevEco、从模板生成本机的 `build-profile.json5`、认出签名材料）。
- `scripts/build-android.ts`：`npm run build:android` 的实现；`scripts/android.ts` 是它用到的辅助。
- `test/android.test.ts`：跟 `npm run check` 一起跑，核对安卓 App 的原生桥方法、安全规矩（不用 `addJavascriptInterface`、证书错误不放行）、语言文件。
- `test/harmony.test.ts`：跟 `npm run check` 一起跑，检查签名材料不进仓库、构建脚本的辅助。鸿蒙工程本身（ArkTS）不归根目录的 tsc、oxlint、vitest 管。
