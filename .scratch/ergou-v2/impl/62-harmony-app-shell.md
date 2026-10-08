# 62 — 鸿蒙 App：原生壳加载二狗的网页，`frontend/` 目录

Status: ready-for-agent
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

- [ ] **目录**：
  - `frontend/README.md` 写明各个前端在哪：
    - 网页前端：默认的那个，在 `packages/web/`，由守护进程提供；
    - `frontend/harmony/`：鸿蒙 App；
    - `frontend/android/`：先留空，只有一个 README 写"还没做"。
  - 鸿蒙工程照 AgentSense 的结构（stage 模型、`entry` 模块），bundleName 自定，写进 Comments。
- [ ] **第一次打开**：
  - 先让用户填二狗的地址，比如公网地址或 tailnet 地址，存在应用本地（preferences）。
  - 地址校验：必须是 https。为了本机调试，`http://127.0.0.1`、`http://localhost` 例外。
  - 之后可以在 App 里改地址，入口自定，写进 Comments。
  - 地址不写进仓库，不写死在代码里。
- [ ] **加载网页**：
  - ArkWeb 加载这个地址，配对、聊天、上传、WebSocket 都和手机浏览器里一样能用。
  - App 是个新设备，第一次要像新浏览器一样配对。
  - 返回键：网页能内部返回时先在网页里返回，照 AgentSense 的 `canGoBack` 做法。
  - 深浅色跟着网页的外观走，照 AgentSense 的 `setColorMode`。
- [ ] **原生桥**：用 javaScriptProxy 注入一个名为 `ergouNative` 的对象，本票只放这几样：版本号、日志、设置地址、外观。
  - 桥只对用户配好的那个来源开放：每次调用都核对当前页面的来源，不对就拒绝。ArkWeb 有现成的白名单配置的话就用它。
  - 网页一侧（`packages/web`）检测到 `ergouNative` 时，在设置里显示"在鸿蒙 App 里运行"和 App 版本；没有时什么都不变。
- [ ] **麦克风权限**：`module.json5` 声明 `ohos.permission.MICROPHONE`，运行时向用户申请；ArkWeb 的 `onPermissionRequest` 只对配好的来源放行麦克风。63 号票改用原生录音之前，网页的 getUserMedia 照旧能用。
- [ ] **签名不进仓库**：签名材料（证书、profile、密码）只放在本机，不进仓库。
  - 比如把 `build-profile.json5` 放进 .gitignore，提交一份不含签名的模板，加一个脚本从模板生成；DevEco 自动签名写进的是被忽略的那份。具体做法自定，写进 Comments。
  - 加一个测试或检查，确保仓库里不会出现 signingConfigs 的材料。
- [ ] **构建**：
  - 根目录加 `npm run build:harmony`：调用 DevEco 自带的 hvigor（路径从环境变量或默认安装位置找），产出 HAP。
  - 没签名时产出 unsigned 的 HAP，并提示怎么签。
  - 这个命令不进 `npm run check`，因为它依赖 DevEco。
  - 本票收尾时实际跑一次，产出一个 HAP，在回报里写明路径和大小。
- [ ] **文档**：`docs/dev.md` 加"鸿蒙 App"一节，写清楚：
  - 怎么构建；
  - 怎么签名：用户在 DevEco 里打开 `frontend/harmony`，登录华为账号，点"自动生成签名"，只要做一次；
  - 怎么用 hdc 装到手机或模拟器、怎么启动；
  - 怎么调试 ArkWeb（照 AgentSense README 的 devtools 端口转发）。
- [ ] **测试**：网页一侧检测原生桥的逻辑有单元测试，用假的 `ergouNative`。所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 鸿蒙工程的 ArkTS 文件（`.ets`）不进 oxlint 和 vitest。别让 `npm run check` 去扫 `frontend/harmony` 下的 `oh_modules`、`build` 等目录。
- 不要用 AgentSense 的签名材料：它们绑定 AgentSense 的 bundleName，也属于本机私有材料。
- 不在本票：原生录音（63 号票）、安卓工程。

## Comments
