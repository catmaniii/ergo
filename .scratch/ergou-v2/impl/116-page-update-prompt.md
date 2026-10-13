# 116 — 服务端的页面更新了，开着的页面（鸿蒙 App、浏览器）提示"有新版本，点一下刷新"

Status: done
Blocked by: 无
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI、鸿蒙 App）；网关的静态文件（`gateway/gateway.ts`：单文件构建产物 `index.html`，每次请求重新读）

## What to build

用户 2026-10-13：113 号票上线后，用户在鸿蒙 App 里让秘书发了个 md，看到的还是旧样子（一行文件名链接、点了是下载）——App 一直开着，页面还是上线之前加载的那份，服务端更新了它不知道。原话："我的鸿蒙客户端如果已经打开的情况下，网页端有更新的话，它端侧的那个网页好像不会自动更新，这个你要做一下，只要服务端更新了，我的客户端那边要能收到提醒，让它更新页面。"

现在：网关每次请求重新读 `index.html`（`Cache-Control: no-store`），所以**重新加载**就是新的；但开着的页面（单页应用，连着 WebSocket）不会自己重新加载。部署有两种：只改 Web 时 `npm run build:web`（守护进程不重启，`index.html` 换了）；改了守护进程时经 LSM 重启（WebSocket 断开再连上）。

改成：

- **页面知道自己是哪一版**：构建时生成一个版本号（构建产物内容的哈希，或构建时间 + 哈希），写进页面。
- **服务端知道现在是哪一版**：守护进程从当前的 `index.html` 里取出版本号（文件变了就重新取：每次请求本来就重新读，或者看文件的修改时间），经 WebSocket 告诉页面——连上（含重连）时带上，`index.html` 换了时主动推一条（守护进程看着这个文件，`build:web` 之后几秒内推到）。原型的假连接照样能模拟。
- **对不上就提示**：页面上一条不会自动收起的提示，比如顶上或底部一条"二狗有新版本 · 刷新"（各套风格跟着），点"刷新"重新加载页面（`location.reload()`，鸿蒙 App 的 ArkWeb 里同样有效）。
  - 刷新前把输入框里没发出去的草稿留住（照仓库现有的草稿保存，没有就存到浏览器存储里、刷新后放回去），别让用户写了一半的话丢了。
  - 正在录音、正在上传附件时先不提示（或者提示里写"等这条发完再刷新"），完了再提示。
  - 用户点了"等会儿"就收起，下次切回前台、或者又来了更新时再提示。
- **App 切回前台时**：鸿蒙 App 从后台回来、浏览器标签页重新可见时，问一次服务端现在是哪一版（不等 WebSocket 推），对不上就提示。
- **在前台时来的新版本只提示**，不静默刷新（用户可能正在看、正在写）。
- **在后台时来的新版本，回到前台时直接刷新**（用户 2026-10-13 同意）：页面在后台时服务端更新了，回到前台（鸿蒙 App 从后台回来、浏览器标签页重新可见）时，如果输入框是空的（没有没发出的草稿）、没在录音、没在上传附件、没有打开着的弹层 / 对话框，就直接刷新，不弹提示；不满足这些条件的照旧出"有新版本 · 刷新"提示。
- 鸿蒙 App 的外壳不用改（只改网页和守护进程），旧版 App 也能用。

## Acceptance criteria

- [x] 页面和服务端各有版本号；连上 / 重连 / `index.html` 换了 / 切回前台时对得上就什么都不出，对不上出"有新版本 · 刷新"；在后台时来的、回到前台时没有会丢的东西就直接刷新；有测试（守护进程：取版本号、文件换了推一条；Web 状态层：对不上才提示、录音 / 上传时不提示、"等会儿"之后什么时候再提示、在后台时来的回到前台什么时候直接刷新；草稿刷新后还在）。
- [x] 截图：经典浅色 390、1280 的提示条，另挑 1 套风格。示例数据里不要出现日本相关的内容。
- [x] `docs/dev.md`（部署那几句也写上：`build:web` 之后开着的页面会提示刷新）跟着改；动了守护进程和协议：全量测试一次，typecheck、oxlint 通过。

## Comments

- 2026-10-13（分支 `worktree-agent-abb73047cb1a9de0a`）做完，详见 `docs/dev.md`"服务端的页面更新了：提示刷新、回到前台直接刷新"一节。
  - **版本号**：构建插件 `packages/web/build/web-version-plugin.ts` 把产物全部文件（按名排序、连名带内容）的 sha256 前 16 位写进 `index.html` `<head>` 开头的 `<meta name="ergou-web-version">`（写法、认法在协议包新加的 `web-version.ts`）。只用内容哈希、不带构建时间：同样的代码再构建一遍版本号不变，开着的页面不会白提示；连着构建两次核对过一样。
  - **协议**：`SubscribeResult.webVersion`（可选）；`EVENT_TYPES.webVersion`（`web_version`，临时事件，推在活动状态频道上，照 45 号票 `voice_models` 的先例，没另开频道）；`GET /api/web-version` → `WebVersionView`（`HTTP_PATHS.webVersion`）。
  - **守护进程**：`gateway/web-version.ts` 按修改时间和大小认 `index.html` 变没变，每 2 秒看一眼（`webVersionPollMs`，测试 50 毫秒），换成另一个版本号就推；订阅、HTTP 问的时候现看一眼。文件不在（重新构建中途）照旧是上一版；新文件没有版本号是不知道、不推。
  - **Web**：状态层 `state/page-update.ts`（`pageUpdateAction` → 不做 / 提示 / 直接刷新），页面那一半 `app/page-update.ts`，提示条 `ui/page-update.tsx`（内容区最上面一条，挤下页面、不盖标题栏），草稿 `app/reload-drafts.ts`（sessionStorage）。原型 `?demo-update`。鸿蒙 App 外壳没改。
  - **和票面不一样的地方**：
    1. "静默刷新"按用户 2026-10-13 的意见做了（票面已照改）：在后台时来的（页面在后台、或者刚切回前台还在问服务端——问完再过 1 秒之前——才知道的那一版），回到前台时输入框空、没录音、没附件、没开着弹层就直接刷新。"开着弹层"按返回栈里有没有 overlay 算（弹窗、对话框、选择器、详情页、抽屉、会话缩小着都算，偏保守）；输入框里引用了卡片也算有东西会丢。在前台时来的、之后切后台再回来也只提示。
    2. 忙的范围比票面宽一点：除了"正在上传附件"，附件传好了还等在输入框上方没发、排着的语音也算忙（刷新会丢），这时不提示，发出去或删掉之后再提示。忙的时候是不出提示（票面二选一里的"先不提示"）。
    3. 草稿只留打的字（仓库原来没有草稿保存，存进这个标签页的 sessionStorage，刷新后同一个会话的输入框放回、取一次就删）；附件、引用的卡片不留——有附件时本来就不提示。
    4. 切回前台的那次问服务端走 HTTP（`GET /api/web-version`），没用 WebSocket：后台时连接可能已经冻住、还没发现断了，HTTP 是新连接。窗口拿回焦点（浏览器里从别的窗口切回来）也问一次，但不算"切回前台"（不清"等会儿"、不直接刷新）。
    5. 各套风格没有另写规则，靠 token（底色 surface、圆点 primary）；像素小屋看过，是一条平的通栏（没有像 `.missed-voices` 那样做成带边的块）。
  - **测试**：按用户意见没跑全量，只跑了改动直接相关的 16 个文件，220 条全过（27 秒）：协议 `web-version`（新）、`http`、`request`；守护进程主切面 `web-version`（新）、`gateway`（现场构建那条加了版本号的核对）、`reconnect`；Web `state/page-update`（新）、`state/back-stack`、`app/back-registry`、`app/ws-connection`、`app/reload-drafts`（新）、`build`、`state/inbox-bar`、`state/inbox-jump`、`state/secretary-unread`、`state/replay`。`npm run typecheck` 过，`npx oxlint` 0 错（7 个警告都是原有的、不在改动的文件里）。
  - **截图**（无头 Chrome 开构建产物 `file://…/dist/index.html?demo-update`）在 scratchpad 的 `t116/` 下（`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t116\`）：经典浅色 `classic-light-390-secretary.png`、`classic-light-1280-secretary.png`、`classic-light-390-bar-2x.png`（提示条放大），另看了 `classic-light-390-tasks.png`、`classic-light-1280-inbox.png`（别的页面也被挤下、不出界）；像素小屋浅色 `pixel-light-390-secretary.png`、`pixel-light-1280-secretary.png`；`classic-light-390-after-refresh-draft-kept.png`（输入框打了字点"刷新"，刷新后字还在，点"等会儿"收起）。另在原型里把页面可见性改成后台、再改回来核对过：输入框空的直接刷新了，打了字的只出提示。
- 2026-10-13 返修（评审两处，都在 `app/page-update.ts`，同一分支）：
  1. 自动刷新会丢东西：判断"没东西会丢"原来只看输入框、引用的卡片和弹层，漏了问题卡"自己写"、计划卡的修改意见和假设、宽屏下不算弹层的详情里的输入、断网时还排着的消息和卡片操作。加了两条：页面上所有文本框（直接扫 DOM 的 textarea、input、可编辑元素；勾选框、隐藏、文件这类和只读、禁用的不算）都是空的（状态层 `fieldsHaveText`），并且没有没发出去的消息（会话末尾还没收到权威消息的，含失败了留着原文等重发的）和在路上的卡片操作（状态层 `unsentWork`）；有任何一样就只提示。
  2. 回到前台后问服务端的那几秒里又切走，请求结束后照样报"问完了"，后台状态被清掉，之后在后台来的新版本回来时只提示：切后台时把 `settle` 置回 false；状态层也加了一道（`WebVersionState.hidden`：后台时到的 `page_settled` 不认）。
  - 测试：`test/state/page-update.test.ts` 加了三条（又切走时晚到的"问完了"不算数、`unsentWork`、`fieldsHaveText`，先红后绿）；跑了 `state/page-update`、`app/reload-drafts`、`app/ws-connection`、`app/back-registry`、`state/back-stack`、`build`、`state/replay` 7 个文件 82 条全过（3.5 秒），没跑全量；typecheck 过，oxlint 0 错（7 个原有警告）。重新构建后在原型里再核对了一遍：输入框空的切后台再回来直接刷新，打了字的只提示。

- 2026-10-13 完成：按用户意见没跑全量，相关测试全过。评审报的两处（自动刷新会丢写了的字和没发出的消息、又切走时后台状态被清）都改了。压缩合并进 main（没冲突），`build:web`、经 LSM 重启守护进程部署。这张票之前就开着的页面要手动刷新一次。
