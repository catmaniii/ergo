# 110 — 鸿蒙 App 里的提醒走系统通知栏（本地通知，App 开着或刚切到后台时）

Status: done
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

- [x] App 里的提醒走系统通知栏（App 在后台、刚切走时），浏览器里照旧；同一件事只发一条；点通知回到 App 对应的地方。
- [x] 第一次请求通知授权，拒了不再问；"更多"里显示通知开没开。
- [x] 网页一侧有测试（App 里走原生桥、浏览器走 `Notification`、去重、旧版 App 没有这个方法时照旧）。
- [x] Comments 写真机核对步骤：允许 / 拒绝授权、切到后台后来一条到点提醒、点通知回到待办那一项、109 的秘书提醒、App 被冻结 / 关掉后发不出（这是预期，靠以后的推送服务）。
- [x] 只动 Web 和鸿蒙壳：web 包全量一次、`tsc -p frontend`、typecheck、oxlint 通过；`docs/dev.md` 鸿蒙一节跟着改。

## Comments

- 2026-10-13 实现（分支 `worktree-agent-a289f96026bc7f493`，基于 main `24df7da3`）。只动 Web 和鸿蒙壳。说明在 `docs/dev.md` 鸿蒙一节：代码表加 `notify/NativeNotify.ets`，"App 里的规矩"加"系统通知"，原生桥表格加四个方法，"网页一侧"一段，新的"系统通知怎么在真机上核对"；事件表里的 `notify`、Web 包目录表、105 那段"浏览器通知照旧"跟着改。
  - **网页一侧：统一出口**。`app/system-notify.ts` 的 `createSystemNotifier`：调用方只给一条 `SystemNotice`（id、标题、正文、点了去哪的页面地址），有 `NativeApp.notify`（新版 App）就交给 App，没有（浏览器、旧版 App）照旧弹浏览器通知（用户允许了才弹、tag 用 id、只许在 Service Worker 里发的浏览器不抛错）；同一个 id 只发一次（浏览器那边用户还没允许时不记，允许了还挂着的照样弹）；点了浏览器通知（拉窗口到前面）或 App 交回点开的那一条，都去那个地址（`pushHash`，和页面里跳转一样记来处），再告诉订阅的（`onOpen`）。`app/native-notify.ts` 包装原生桥的四个方法（App 回的不对一律当没有、不抛错）和 `followNotifyInApp`；`app/page-notify.ts` 是页面上那一份（`pageNotifier()`、`connectSystemNotify()`、`appNotifies()`）。`ui/alerts.tsx` 原来的 `showBrowserNotification` 和 `notified` 去掉，改成 `pageNotifier().show(alertNotice(alert, plain))`，订 `onOpen` 把点开的那一条从顶上收起；在 App 里不出"允许浏览器通知"。`main.tsx` 开场调 `connectSystemNotify()`。设置最上面"在鸿蒙 App 里运行"下面加一行"系统通知"（`pages/more/NativeAppInfo.tsx`：已打开 / 没打开 + "去打开"，页面回到前台、拿回焦点时再看一眼）。**109 号票接这里**：秘书提醒调 `pageNotifier().show({ id, title, body, route: "#/secretary/at/<消息>" })`，不用管浏览器还是 App；点了之后要收起自己的提醒就订 `pageNotifier().onOpen`（原来的 `showBrowserNotification` 已经没有了，合并时 109 那边的调用改成这个）。
  - **鸿蒙一侧**：新文件 `notify/NativeNotify.ets`（`NativeNotify`：`state` / `prepare` / `show`、记着 App 在不在前台；`notifyTaps`：用户点开的那一条，等网页来取）；`bridge/NativeBridge.ets` 加 `notifyState`、`notifyPrepare`、`notifyShow`、`notifyTakeOpen`（照 `safeArea` 先过 `allowed()`，进 `NATIVE_BRIDGE_METHODS`；`notifyPrepare` 要等系统的框，和录音一样回 `Promise<string>`）；`pages/Index.ets`（一个 `nativeNotify`，换地址不重建；`onPageShow` / `onPageHide` 记前后台；`pushNotifyOpen` 调网页登记的 `window.__ergouNotifyOpen()`，推之前照 `pushInsets` 核对来源）；`entryability/EntryAbility.ets`（`onCreate` 和新加的 `onNewWant` 从 want 取点开的那一条）；`common/AppSettings.ets`（`notify_asked`）。`module.json5` 没改：`publish` 不要求权限，Ability 默认就是 singleton。
  - **用到的 SDK API**（对过 `D:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\ets\api` 的声明，SDK 6.1.1(24)）：`@kit.NotificationKit` 的 `notificationManager.requestEnableNotification(context: UIAbilityContext): Promise<void>`（拒了 1600004、框已经开着 1600013）、`isNotificationEnabledSync()`（API 12）、`openNotificationSettings(context)`（API 13，半模态）、`publish(request): Promise<void>`（没有 `@permission`）；`NotificationRequest` 的 `id`、`appMessageId`（API 12：24 小时内同一个只显示一条）、`notificationSlotType: SlotType.SERVICE_INFORMATION`（API 11，"服务提醒"：横幅、响铃）、`content.notificationContentType: ContentType.NOTIFICATION_CONTENT_BASIC_TEXT` + `normal: { title, text }`（都不能为空）、`wantAgent`、`tapDismissed`、`isAlertOnce`。`@kit.AbilityKit` 的 `wantAgent.getWantAgent(info): Promise<WantAgent>`、`WantAgentInfo` 的 `wants`、`actionType: OperationType.START_ABILITY`、`requestCode`、`actionFlags: [WantAgentFlags.UPDATE_PRESENT_FLAG]`（API 11 起取代已废弃的 `operationType`、`wantAgentFlags`）、`UIAbility.onNewWant(want, launchParam)`、`UIAbilityContext.abilityInfo`（`bundleName`、`name`）。
  - **和票面不一样的 / 票面没说死、我定的**：
    1. **授权在网页开场时问，不是"第一条要发之前"那一刻**：系统的授权框要 App 在前台，而通知只在 App 在后台时发，等到第一条要发时再问弹不出来。所以网页开场（页面在前台）发现还没问过就让 App 问一次；拒了不再问（App 记 `notify_asked`，系统自己也只弹一次），设置里"去打开"：没问过的弹授权框，拒过的拉起系统的通知设置。新装的 App 会在配对页上就弹这个框。
    2. **前台不发由 App 判断**（`onPageShow` / `onPageHide`），不靠网页的 `visibilitychange`（ArkWeb 切后台时可见性不一定先报，63 号票录音同样的考虑）：网页在 App 里每条都交给 App，App 在前台就不发；前台时到、没发的那条之后切到后台不补发（顶上、待办里都有）；锁屏算后台。
    3. **点了通知去哪由地址定**：浏览器通知原来点了是"有事项去那一项，没有就不动"，现在两条路都去 `SystemNotice.route`，顶上的通知没有对应事项的去待办列表（同 106 的"查看"）。
    4. **渠道选"服务提醒"**（`SERVICE_INFORMATION`）不是"社交通讯"：提醒、待办算服务提醒；109 的秘书消息先用同一个渠道，要分开以后再说。
    5. 标题 60 字、正文 200 字（网页截，App 兜底），正文空的写"点开看看"（系统要求不能为空）。浏览器通知也走同一个截短（原来不截），这个长度以内的不变。
    6. 通知编号、wantAgent 的 `requestCode` 由通知的 id 散列出来（不同的事各一个 wantAgent：`requestCode` 一样的会被当成同一个，点旧通知会去新通知的地址）。
    7. 点了的那条随即从通知栏收掉（`tapDismissed`）；App 回到前台时不主动清通知栏里别的二狗通知。
    8. `EntryAbility` 谁都能拉起、能带参数：网页、App 两边都只认 `#/` 开头的页面地址，带来的最多换一页。
  - **测试**：先写测试、看着失败再改。`test/app/system-notify.test.ts`（13 条：浏览器里允许了才弹、tag 用 id、没允许不弹而之后允许了还能弹、不支持 / 抛错不抛、同一个 id 只发一次、点浏览器通知拉窗口去地址关通知并告诉订阅的；App 里走原生桥不弹浏览器通知、同一个 id 只交一次、旧版 App 没有这一组方法照旧走浏览器通知、App 交回的那一条去对的地址、退订；截短；`alertNotice` 去待办那一项 / 待办列表）；`test/app/native-app.test.ts` 加"系统通知的接口（110 号票）"（23 条：认出 / 旧版缺方法、发一条的参数、状态解析表、`prepare`、点开的那一条解析表（不是 `#/` 的不认）、开场取一次 + 推了再取 + 取到空的不动 + 停下拿掉、什么时候开场问授权、调过去抛错不抛）。web 包全量 + frontend 一次（Git Bash，`ERGOU_TEST_WORKERS=2 npx vitest run --project web --project frontend`）：97 个文件 2537 条全过，25.5 秒。`npm run typecheck`（含 `tsc -p frontend`）通过，oxlint 0 个错误（警告都是 main 上就有的；`__ergouNotifyOpen` 加进 no-underscore-dangle 的放行名单）。**ArkTS 没有编译过**：`tsc -p frontend` 不查 `frontend/harmony`，要等 `npm run build:harmony` 时 hvigor 查；照官方文档的写法写的（带类型的对象字面量、`Record<string, Object>` 下标赋值、箭头函数、`as string`），Index 里的字段叫 `nativeNotify`（避开组件自带的名字）。
  - **真机怎么核对**（主会话合并后 `npm run build:harmony` 装机；手机点"允许"、平板点"不允许"；每步的日志写在 `docs/dev.md`"系统通知怎么在真机上核对"）：① 允许：新版第一次打开就弹授权框，允许后 hilog `notification enabled by user`，设置里"系统通知 · 已打开"，再开不弹。② 拒绝（平板）：hilog `notification not enabled: …（1600004）`，设置里"没打开 · 去打开"，再开不弹；点"去打开"拉起系统通知设置，打开后这一行变"已打开"。③ 前台不发：看着页面时到点，顶上有框、通知栏没有，hilog `not published: app in foreground`。④ 刚切到后台时发：设一分钟后的提醒，离到点几秒时回桌面，到点通知栏出一条（横幅、响铃），hilog `published as N`；只进栏不横幅 / 不响的看系统设置里"服务提醒"的开关；一条日志都没有说明网页在后台没跑，记下来。⑤ 点通知回到待办那一项（App 回前台、详情开着、顶上没有这一条、通知从栏里消失），hilog `notification opened`、`Ability onNewWant`。⑥ 通知还在栏里时把 App 划掉再点：App 打开就是那一项（`Ability onCreate`）。⑦ 109 合进来之后：App 在后台时秘书说完一轮，通知栏出秘书那条，点了去 `#/secretary/at/<消息>`。⑧ App 在后台被冻结（几十秒到几分钟）、或者划掉之后到点：通知栏没有、hilog 也没有，回到 App 顶上和待办里有——预期，靠以后的推送服务。⑨ 手机、电脑浏览器照旧。

- 2026-10-13 完成：web 包 + frontend 全量 2537 条通过。评审没有会出错的问题。压缩合并进 main；主会话 `npm run build:harmony` 编译通过（ArkTS 无报错），装到手机、平板，真机核对见下一条。
