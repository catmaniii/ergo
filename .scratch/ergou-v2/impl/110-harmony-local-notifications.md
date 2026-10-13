# 110 — 鸿蒙 App 里的提醒走系统通知栏（本地通知，App 开着或刚切到后台时）

Status: ready-for-agent
Blocked by: 106（顶上通知框）；和 109 可以同时做（109 的秘书提醒从同一个出口出去）
Spec: [第一阶段规格](../spec.md) 第 19 节（鸿蒙 App）；62 / 63 / 96 / 105 号票（鸿蒙 App 外壳、原生桥）

## What to build

用户 2026-10-13 定：手机系统提醒分两步，先做不用实名认证的这一步——鸿蒙 **Notification Kit 本地通知**：App 自己往通知栏发，不经华为服务器，不用在 AppGallery Connect 开通什么、不用改签名。限制是 App 的进程要活着（开着，或刚切到后台、还没被系统冻结）；App 关着时发不了，那要靠推送服务（Push Kit，要开发者账号实名认证、AGC 开通推送、服务帐号密钥、消息分类，写在规格 Out of Scope，以后做）。

- **网页一侧**：现在提醒在浏览器里用 `Notification` 弹（`ui/alerts.tsx` 的 `showBrowserNotification`，用户允许了才弹）。在鸿蒙 App 里（`app/native-app.ts` 认得出）改走原生桥：同一个出口，App 里调原生桥发通知，浏览器里照旧。同一件事只发一条（用通知的 id 去重，照现在 tag 的做法）。
- **什么时候发**：和现在弹浏览器通知同样的时机（顶上的通知：到点的提醒这些；109 号票加的秘书提醒也从这里出）。App 在前台、用户正看着这一页时可以不发通知栏（顶上已经有了），切到后台、屏幕在别的 App 上时发——取舍写在 Comments。
- **原生一侧**（`frontend/harmony/entry/src/main/ets/`，`bridge/NativeBridge.ets` 加方法，照 `safeArea` 等现有方法的写法和权限名单）：
  - 第一次要发之前请求通知授权（`notificationManager.requestEnableNotification` 一类，按本机 SDK 的声明选能用的）；用户拒了就不再问，网页照旧只有页面内提醒。设置里（"更多"里鸿蒙 App 那一块，`NativeAppInfo.tsx`）显示通知开没开、没开时能点去打开。
  - 发通知：标题、正文（正文太长截短），通知渠道 / 类型选"社交通讯"或"服务提醒"一类合适的（照 SDK）。
  - 点通知：拉起或切回 App，网页跳到那一项该去的地方（地址由网页给，比如 `#/inbox/<事项>`、`#/secretary/at/<消息>`；原生把它交回网页，照 `__ergouInsets` 那样推给网页的一个函数，或开场时网页来取）。
  - 用到的 API 都对过本机 SDK（`D:\Program Files\Huawei\DevEco Studio\sdk`）的声明；需要在 `module.json5` 里声明的权限照声明加（发本地通知一般不需要额外的权限，以 SDK 为准）。
- **子 agent 不碰设备，也不跑鸿蒙构建和签名**：只改代码，`tsc -p frontend` 过（它不查 ArkTS），写清楚真机怎么核对。主会话合并后 `npm run build:harmony`、hdc 装到手机和平板上看。

## Acceptance criteria

- [ ] App 里的提醒走系统通知栏（App 在后台、刚切走时），浏览器里照旧；同一件事只发一条；点通知回到 App 对应的地方。
- [ ] 第一次请求通知授权，拒了不再问；"更多"里显示通知开没开。
- [ ] 网页一侧有测试（App 里走原生桥、浏览器走 `Notification`、去重、旧版 App 没有这个方法时照旧）。
- [ ] Comments 写真机核对步骤：允许 / 拒绝授权、切到后台后来一条到点提醒、点通知回到待办那一项、109 的秘书提醒、App 被冻结 / 关掉后发不出（这是预期，靠以后的推送服务）。
- [ ] 只动 Web 和鸿蒙壳：web 包全量一次、`tsc -p frontend`、typecheck、oxlint 通过；`docs/dev.md` 鸿蒙一节跟着改。

## Comments
