# 117 — 任务和项目的 agent 也能发附件；HTML（和 SVG）附件能直接预览（隔离的沙箱里打开）

Status: done
Blocked by: 无（和 115 号票都碰附件，合并时主会话处理冲突）
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI）；113 号票（附件卡片和报告页）、79 号票（附件工具）、102 号票（`tell_secretary`）

## What to build

用户 2026-10-13 原话："给任务和项目的 agent 也增加发送附件的工具吧，另外如果发送的是 HTML 的话，也要直接能够预览，你本来就是 web，你浏览一个 HTML 问题不大呀，为什么不做呢？"

（113 号票按用户当时的需求文档把 HTML、SVG 定为只下载，理由是 HTML 在二狗页面的同源下打开，脚本能带着设备凭证调二狗的接口。用户现在要预览，做法是隔离着打开，见下。）

### 1. 任务和项目的维护者也有 `send_attachment`

- 现在只有秘书有（`media/attachment-tools.ts` 的 `sendAttachmentTool`，只能发它草稿区里的文件）。给**任务的维护者**和**项目维护者**也配上：能发它自己能读写的地方里的文件（任务的工作目录 / 产出区、项目工作目录），发到它自己的会话里（任务整页、项目整页），用户在那里看到 113 号票的附件卡片。照秘书那一份的做法（复制进媒体库、图片剥元数据、大小上限、一次一个），工具说明写清楚什么时候用（交付件、报告、截图给用户看）。
- 工具包：照现有给维护者配固定工具的地方加（`tell_secretary` 那样默认就有），工具包设置里能看到、能关。
- 子 agent、评审不配（它们的结果交回维护者，维护者决定发不发）。
- `tell_secretary` 加一个可选的附件参数（维护者工作目录里的文件，最多几个）：来信转到秘书时，这几个文件作为附件跟着来信进秘书会话（用户在秘书会话里直接能点开），不用秘书再复制一遍。秘书转述时照旧用自己的话。（今天 11:37 就是维护者让秘书"原样发"日报文件、秘书自己复制再发的。）

### 2. HTML 附件能预览：隔离的沙箱里打开

- 新的内容接口（比如 `GET /api/media/<媒体 id>/html`，照 113 的 `/text` 那样只按媒体 id 取、鉴权照旧）把 HTML 原样发出，带响应头：
  - `Content-Security-Policy`：`sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`（**不给** `allow-same-origin`：页面是一个"陌生来源"，拿不到二狗的 cookie、本地存储）、`connect-src 'none'`（脚本不能 fetch / XHR / WebSocket，连不上二狗的接口，也不能往外发请求）、`form-action 'none'`、`frame-ancestors 'self'`；脚本、样式、图片、字体、媒体允许内联和 `https:`（agent 生成的 HTML 常从 CDN 拉图表库、字体、图片——用户定一阶段先要功能，允许远程资源，写在 Comments 里作为已知的取舍）；
  - `X-Content-Type-Options: nosniff`，`Cache-Control: no-store`。
- 报告页（113 号票的 `#/report/<媒体 id>`）认得 HTML：标题栏照旧（文件名、"下载"），正文是一个 `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox">` 指向上面的接口，铺满报告页，在框里滚动。页面里的链接点了在新窗口打开（鸿蒙 App 里交给系统浏览器，照现有外链的规矩）。
- 附件卡片：HTML 变成能预览（图标照旧写 HTML，按钮"预览""下载"，点图标是预览）。
- **SVG 顺手也能预览**：报告页里用 `<img>` 显示（`<img>` 里的 SVG 不跑脚本），经同样只按媒体 id 取的接口发 `image/svg+xml`，带 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`。
- 守护进程网关核对：WebSocket 和接口照旧不接受 `Origin: null` 的请求（沙箱里的页面就算想连也连不上；加一条测试锁住）。
- 媒体接口原来的规矩（`/api/media/<id>` 只内联认得的图片和音频，别的一律当附件下载）不变；HTML 只经新接口、带沙箱头发出。
- 大小上限照 113（超过就只给下载，不预览）。
- 规格 Out of Scope 里 113 写的"HTML、SVG 一律只下载"改掉。

## Acceptance criteria

- [x] 任务维护者、项目维护者有 `send_attachment`，发出的文件在它们的会话里显示成附件卡片；`tell_secretary` 带附件时附件进秘书会话；工具包里看得到、能关；有主切面测试。
- [x] HTML 附件点"预览"在报告页里的沙箱框中显示、脚本能跑（比如一个按钮改字），但：拿不到二狗的 cookie / 本地存储、fetch 和 WebSocket 连不上二狗（也连不上外面）、表单提交不出去、不能把整页导航走；有守护进程测试（新接口的响应头、只按媒体 id、未配对被拒、`Origin: null` 的 WebSocket 被拒）和 Web 测试（卡片、报告页认得 HTML / SVG）。真浏览器里核对一遍沙箱效果（无头 Chrome：框里的脚本试 `document.cookie`、`fetch('/api/…')`、`new WebSocket(…)`，都拿不到 / 连不上），写清楚怎么核对的。
- [x] SVG 预览用 `<img>`；`/api/media/<id>` 原规矩不变（回归）。
- [x] 截图：经典浅色 390、1280（维护者会话里的附件卡片、HTML 报告页、SVG 报告页），另挑 1 套风格。示例数据里不要出现日本相关的内容。
- [x] 规格、`docs/dev.md` 跟着改；动了守护进程和协议：全量测试一次，typecheck、oxlint 通过。

## Comments

- 2026-10-13 实现（分支 `worktree-agent-a2603f6d53f1e876c`，基于 main `a6e9d397`；worktree 原来在 `a2dd7c13`，先快进到 main）。说明在 `docs/dev.md`：新的一节"维护者发附件"，"媒体与附件"（HTML、SVG 两个预览接口和响应头）、"附件卡片和报告页"（HTML、SVG 在框里看）、"给秘书发消息"（带附件）、网关（`Origin: null`）、工具包（第六样"发附件"）、协议包各补了；规格第 21 节加"发附件""附件预览"两条，Out of Scope 里"附件预览的后续"那句改成 113 只做了文本、HTML 和 SVG 117 起在沙箱里预览。
  - **协议**：工具包第六样 `sendAttachment`（`PlanToolkit` / `ToolkitShape`，照 `tellSecretary` 的写法：不写是开、关掉写 false，`canSendAttachment`、`sendAttachmentField`，能力 `{ kind: "send_attachment" }` 说法"发附件"，`toolkitAdded`/`withCapabilities`/`toolkitText`/`sameToolkit` 都认它）；`parts.ts` 的 `framePreviewOf`（有扩展名只看扩展名：html、htm 是 HTML，svg 是 SVG，xhtml、svgz、xml 照旧只下载；没扩展名看类型）；`HTTP_PATHS.mediaHtml`、`mediaSvg`（`/api/media/<id>/html`、`/svg`）、`MEDIA_FRAME_MAX_BYTES`（= 1 MB）、`HTML_PREVIEW_SANDBOX`；`MediaTextView` 多一个可选的 `frame`。
  - **守护进程**（先写测试）：`send_attachment` 改成按"能从哪里发"（`AttachmentSource`：秘书草稿区、维护者工作目录）复用，附件消息由会话追加（`HostToolOutput.attachments` → `serveHostTools` 的 `onAttachments` → `AgentSession` 带上此刻的归属追加），复制进媒体库那一段 `ingestFrom` 和 `tell_secretary` 共用；维护者的装配三处（`workAssembly`、任务维护者起草时、项目维护者起草和对话段）经 `fixedMaintainerTools` 配上 `tell_secretary` 和 `send_attachment`；子 agent（`MAINTAINER_ONLY_TOOLS`）、评审、涉及多个项目的任务的维护者没有；`narrowedGuardAgent`、`effectiveToolkit`、`mergeDraft`、改工具包的两处都认新开关。`tell_secretary` 维护者的那一份多可选的 `attachments`（≤5 个，调用时入库，记在信上），交给秘书时作为附件 part 跟在那条通知后面（`buildAgentNotice` 的 `attachments`），被打断重交的原样带着。网关：`/api/media/<id>/text` 对 HTML、SVG 回 `frame`、超 1 MB 回 413；新的 `serveFramed` 发 HTML、SVG 原文。`.svg` 按扩展名补成 `image/svg+xml`。
  - **Web**：状态层 `attachmentPreviewOf`、`FileCard.preview` 扩成 `AttachmentPreview`、`reportPageView` 的 `frame` 一种和 `too_large` 的说法；`ReportPage` 的 `FramedBody`（HTML 是 `<iframe sandbox={HTML_PREVIEW_SANDBOX} referrerPolicy="no-referrer">`，铺满报告页、在框里滚动；SVG 是白底框里的 `<img>`）；`DaemonHttp.mediaFrameUrl`；系统消息带的附件画成一排卡片（`ChatItemView` 的 system 改用 `partRuns`）；工具包区多一个"发附件"开关（`state/send-attachment.ts`），计划卡、卡片上的工具包关掉了才写"发附件：关"。原型：网页版早报（目录锚点、内嵌柱状图、"标成已读"按钮）、本周 star 走势 SVG、活动页预览有了内容；t-brief 第 3 次运行里维护者发了这两个附件、`tell_secretary` 带着网页版早报，秘书主线末尾是那封带附件的来信和转告。
  - **响应头原文**（`test/main/media-frame.test.ts` 逐项核对）：
    - HTML（`GET /api/media/<id>/html`）：`Content-Type: text/html; charset=utf-8`（不是 UTF-8 的不写 charset）；`Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'`；`X-Content-Type-Options: nosniff`；`X-Frame-Options: SAMEORIGIN`；`Referrer-Policy: no-referrer`；`Cache-Control: no-store`；`Content-Disposition: inline; filename="…"; filename*=UTF-8''…`。
    - SVG（`GET /api/media/<id>/svg`）：`Content-Type: image/svg+xml`；`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`；`X-Content-Type-Options: nosniff`；`X-Frame-Options: DENY`；`Referrer-Policy: no-referrer`；`Cache-Control: no-store`；`Content-Disposition: inline; …`。
  - **沙箱在真浏览器里的核对**（系统装的 Chrome 154（无头）+ playwright-core 1.61，脚本 `scratchpad/t117/sandbox-probe.test.ts`、结果 `sandbox-probe-result.json`；做法：临时放进 `packages/daemon/test/main/` 当一条 vitest 跑一次后删掉，不进仓库——起一个测试用的守护进程（临时数据目录），网关发出 `npm run build:web` 的构建产物，发一个探针 HTML 附件，Chrome 打开真页面 `#/report/<媒体 id>`；外面的地址 `example.test` 一律由 playwright 的路由在本机回假内容，不出网）。父页面（二狗）先放一个金丝雀 cookie 和 localStorage，再在框里逐项试：
    - 框的来源是 `null`；`iframe` 的 `sandbox` 是 `allow-scripts allow-popups allow-popups-to-escape-sandbox`；
    - `document.cookie`、`localStorage`、`sessionStorage`、`indexedDB.open` 一律 SecurityError（"The document is sandboxed and lacks the 'allow-same-origin' flag"）；`parent.document`、`parent.localStorage` 跨源被拦；
    - `fetch('/api/access')`、`fetch(二狗的绝对地址)`、`fetch('https://example.test/…')`、XHR、`new WebSocket('ws://…/ws')`、`EventSource` 都连不上（TypeError / onerror），控制台 7 条 `connect-src 'none'` 的拦截；`sendBeacon` 返回 true，但请求被 CSP 拦下（playwright 看到的那两条 `/api/access` 都是"没发出去：csp"，没有一条到了服务端）；
    - `top.location.href = …` SecurityError（没有 allow-top-navigation），主页面地址不变；`form.submit()` 被拦（"Blocked form submission … 'allow-forms' permission is not set"），框的地址不变；
    - 页面里的脚本能跑：按钮点了改字（"点我"→"点过了"）；https 的脚本、图片照常加载（取舍，见下）；
    - 页内锚点在框里跳（地址变成 `…/html#sec`，没开新窗口）；外链在新窗口打开，新窗口是 `https://example.test` 的正常页面、`opener` 为 null；`window.open(二狗)` 能开新窗口，但读它的 `document` 跨源被拦；
    - HTML 接口直接在新标签页打开：来源照样是 `null`、`document.cookie` SecurityError（CSP 的 sandbox 指令）；
    - SVG：报告页的 `<img>` 画出来了（naturalWidth 80），里面的 `<script>` 没跑；直接打开 SVG 地址来源是 `null`、脚本没跑；另核对内嵌的 `data:` 图片在 `<img>` 里照常画（`svg-probe.test.ts`，结果 `svg-probe-result.json`）；
    - 外网端口：在浏览器里走一遍配对（发起、PC 上批准、领凭证，cookie `__Host-ergou-device` HttpOnly、Secure、SameSite=Strict），打开同一个报告页：框和内容照常取到（同源的框请求带着凭证），框里来源 `null`、`fetch('/api/access')` 连不上、`document.cookie` SecurityError。
  - **和票面不一样的地方**：
    1. **HTML 不是一字不差地发出**：末尾加了一小段只有 ASCII 的脚本（`LINKS_IN_NEW_WINDOW`），点到没写 target 的链接补 `target="_blank"`，这样"页面里的链接点了在新窗口打开"才做得到（框里的链接默认在框里跳，父页面管不到陌生来源的框）。没用 `<base target="_blank">`：它会让页内锚点（报告常见的目录）也开新窗口。脚本放在末尾、不碰 doctype 和编码。
    2. **报告页的名字、大小从内容接口来**：`/api/media/<id>/text` 对 HTML、SVG 回 `frame`（`text` 是空的），没另开元数据接口；113 号票"HTML、SVG 回 415"的那条测试改成 xhtml 等仍回 415。
    3. **CSP 没给 `'unsafe-eval'`**（票面没写）：Alpine、petite-vue、Vue 的运行时模板编译这类库在框里跑不起来；内联脚本已经能跑，加它不多给权限，用户要的话加一个词。另多了几样票面没列的：`default-src 'none'`（嵌套的框、插件、worker 都不行）、`img-src`/`media-src` 允许 `data:`、`blob:`、`Referrer-Policy: no-referrer`、HTML 的 `X-Frame-Options: SAMEORIGIN`（和 frame-ancestors 'self' 一致）、SVG 的 `X-Frame-Options: DENY`。
    4. **已知的取舍**（票面定的、写明）：框里的页面能从 https 加载脚本、样式、图片、字体、媒体，也就能借这些加载向外发出请求（URL 里带上页面里的内容）；拿不到二狗的数据，只能带出这个 HTML 自己的内容。`allow-popups` 让它能开新窗口（包括打开二狗的页面），但读不到新窗口。
    5. **超过 1 MB 的 HTML、SVG**：内容接口和预览接口回 413 `too_large`，卡片上只有"下载"、图标写"仅下载：HTML 文件超过 1.0 MB，不在这里预览"（agent 把图表库内联进 HTML 时容易超过 1 MB，这类只能下载）。
    6. **打开"发附件"算要用户批准的扩大**，照 102 号票评审后给秘书发消息的定法（维护者自行调整计划不写这一项是沿用现在的）；用户直接在工具包里开照样立即生效。
    7. **`tell_secretary` 带附件的细节**：最多 5 个；只有维护者的那一份有这个参数，"发附件"关掉了也没有；有一个发不了整封信不发（原因交回模型）；调用时就入库，之后改了、删了工作目录里的文件不影响。附件放在那条维护者来信通知（系统消息）上——用户在秘书会话里看到通知下面一排附件卡片（截图 `classic-light-390-secretary-letter`）。
    8. **谁有**：起草计划的段（只读的）也有 `send_attachment`，照 102 号票 `tell_secretary`"每一段都有"；涉及多个项目的任务的维护者没有（它不写文件，工作目录里没有可发的）。
    9. **流程**：执行流程时计划里没有 `send_attachment` 这一步的，照 59 号票的计划核对"会改东西的计划外调用问用户"（它不是只读或幂等）；要在流程里发附件，计划里写上这一步。没改计划核对的规矩。
    10. **鸿蒙 App 没改、没上真机**：框里的外链开新窗口，ArkWeb 不开多窗口时落到主页面的导航上，由现有的 `interceptLoad` 交给系统浏览器（按代码推的）；原生桥对这个框不开放（调用的框的地址和主框架不同，`allowed()` 拒绝）。真机上点一下框里的外链核对一遍再说。
    11. 和 115 号票都碰附件、来信：这边改了 `task-done.ts` 交维护者来信的那一段（附件跟着通知）、`buildAgentNotice`（可带附件）、`ChatItemView` 的系统消息（附件画成一排），合并时留意 115 的"来信折成一行"要把这排附件留在外面。
  - **测试**：先写测试再改。守护进程主切面新加 `test/main/media-frame.test.ts`（9 条：两个接口的响应头逐项、HEAD、GBK 的 HTML、内容接口的 frame、超 1 MB 的 413 和刚好 1 MB、只按媒体 id——不是媒体 id、路径样子的 `..%2F`、没有、没消息引用、文件不在了都 404——、part 上不是这一种的 415、外网端口没配对 401 配对过 200、两个端口上 `Origin: null` 的接口请求和 WebSocket 握手被拒（外网端口带着有效凭证也被拒）、媒体接口原来的规矩不变）和 `test/main/maintainer-attachments.test.ts`（8 条：普通任务的 agent 发附件进自己的会话、带任务归属、工作目录外被拒、发出的能预览、删了原文件照样在；长程任务的维护者发的带阶段；项目维护者在对话段发；计划里关掉没有、打开后重新装配有了、`tell_secretary` 参数跟着变；项目工具包关掉没有；子 agent、评审没有；`tell_secretary` 带附件进秘书会话、秘书看到附件引用和内容、一个发不了整封不发；秘书崩溃重交照样带着附件）；改了 `media-text`（415 的那条）、`external-port`（要凭证清单加两个接口）、`tasks`/`typed-shell`/`work-orders`（精确的工具清单加 `send_attachment`）。协议包 `test/http.test.ts` 加 4 条；Web `test/state/attachments.test.ts`（HTML、SVG 能预览、超 1 MB 只下载、xhtml/svgz 只下载、报告页 frame、too_large）、新加 `test/state/send-attachment.test.ts`（4 条）。**按用户意见没跑全量**，跑了相关的：协议包和 Web 全部（含构建产物测试）加守护进程 23 个相关文件（media-frame、media-text、external-port、gateway、maintainer-attachments、attachments、secretary-letters、secretary-scratch、tasks、typed-shell、work-orders、plan-change 两个、parallel、multi-project、toolkit、secretary-task-done、auto-voice-announce、plain-tasks、project-internal-tasks、reminders、secretary-inbox），`ERGOU_TEST_WORKERS=2` 一次：139 个文件 3171 条全过，6 分 04 秒。开发中途 `secretary-task-done` 的"几件差不多同时做完的并成一条"满负载下两件先后颠倒失败过（已知的不稳），单独重跑通过，最后那次全过。`npm run typecheck`、`npx oxlint`（0 错误，警告都是原有的）通过。
  - **截图**在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t117\`（脚本 `shots.cjs`，构建产物的原型，无头 Chrome 开 `file://`；原型里 HTML 预览用 `data:` 地址，照样放进带 sandbox 的 iframe，脚本里核对了框的来源是 `null`、按钮点了改字）：经典浅色 `classic-light-390-maintainer-cards`（t-brief 维护者会话里的 HTML 附件卡片）、`-390-maintainer-svg-card`、`-390-html-report`、`-390-html-report-clicked`（点了"标成已读"）、`-390-svg-report`、`-390-secretary-letter`（带附件的维护者来信）、`-390-secretary-html-card`（活动页 HTML 现在能预览）、`-390-toolkit-switch-on` / `-off`（工具包区的"发附件"开关）；`classic-light-1280-maintainer-cards`、`-1280-html-report`、`-1280-svg-report`、`-1280-event-html-report`（活动页，点了报名）、`-1280-secretary-letter`、`-1280-toolkit-switch-on` / `-off`；另一套夜航仪表深色：`night-dark-1280-maintainer-cards`、`night-dark-390-html-report`、`night-dark-390-svg-report`。
- 2026-10-13 合并 main、放宽 HTML 预览的限制（同一分支 `worktree-agent-a2603f6d53f1e876c`）。
  - **放宽 HTML 预览（用户 2026-10-13 定："可以。一阶段，不要加什么限制。"）**：页面的功能一律放开，只留让二狗本身安全的两样——sandbox 不给 `allow-same-origin`（框是陌生来源，拿不到二狗的 cookie、本地存储）、网关拒绝 `Origin: null`（框里就算连二狗的地址也被拒）——外加照旧不能把整页导航走。上面第一条 Comments 的"和票面不一样的地方"第 3 条（不给 `'unsafe-eval'`）、第 4 条（已知的取舍）作废。
    - **响应头原文**（HTML，`test/main/media-frame.test.ts` 逐项核对）：`Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-orientation-lock allow-presentation; default-src https: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:; style-src 'unsafe-inline' https: data: blob:; connect-src https: wss: data: blob:; form-action https:; frame-ancestors 'self'`；别的头不变（`text/html; charset=utf-8`、nosniff、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、`Content-Disposition: inline; …`）。SVG 的不变。报告页 `<iframe sandbox>` 用同一份（协议包 `HTML_PREVIEW_SANDBOX`）。
    - **比主会话转达的三处（`'unsafe-eval'`、`connect-src https: wss:`、`form-action https:`）多放开的**，照"不要加什么限制""保留的只有那两样"推的，觉得多了再收：sandbox 加 `allow-forms`（不加它 `form-action https:` 不起作用，表单根本提交不出去）、`allow-modals`（alert、confirm）、`allow-downloads`（页面里"导出 CSV"这类）、`allow-pointer-lock`、`allow-orientation-lock`、`allow-presentation`；`default-src` 从 `'none'` 改成 `https: data: blob:`（嵌套的框、worker 能用）；`connect-src` 另许 `data:`、`blob:`。不给的 sandbox 只剩 `allow-same-origin`、`allow-top-navigation` 那几种（和陌生来源用不上的 `allow-storage-access-by-user-activation`）。一律不许 `http:`：二狗自己在本机 `http://127.0.0.1` 上，局域网里的 http 服务（路由器之类）也连不上。
    - **真浏览器核对**（Chrome 154 无头 + playwright-core 1.61，脚本 `scratchpad/t117/sandbox-probe-relaxed.test.ts`、结果 `sandbox-probe-relaxed-result.json`，做法同上：临时放进 `test/main/` 跑一次后删掉；外面的地址 `example.test` 由 playwright 的路由在本机回假内容，不出网；`https://ergou.example.test` 扮演经 https 访问的二狗——原样转给测试守护进程的外网端口，带着框里请求的头）：
      - 页面功能都能用：`eval("6 * 7")`、`new Function` 得 42；fetch、XHR 外网 https（CORS 放行的假接口）取到 JSON；`wss://` 的 WebSocket 收到消息；EventSource 收到推送；sendBeacon 返回 true；alert、confirm 弹出来了（playwright 收到这两个对话框）；嵌套的 https 框 load 了；`blob:` 的 worker 回了 42；`blob:` 的 `<a download>` 下载了"导出.csv"；表单 POST 到 `https://example.test/form`（`target="_blank"`）在新窗口打开、外面收到 `q=日报`；https 的脚本、图片加载了；按钮点了改字。
      - 二狗照样安全：框的来源 `null`；`document.cookie`、`localStorage`、`sessionStorage`、`indexedDB.open` 一律 SecurityError；`parent.document`、`parent.localStorage` 跨源被拦；fetch、XHR、WebSocket 连本机二狗（`http:`、`ws:`）被 `connect-src` 拦（控制台 5 条违规：4 条 `connect-src http://127.0.0.1:…`、1 条 `form-action http://127.0.0.1:…/api/uploads`——表单提交到二狗也被拦）；连"经 https 访问的二狗"：请求带着 `Origin: null` 到了网关，回 403 `{"code":"forbidden","message":"拒绝：Origin 不对：null"}`；`top.location.href = …` SecurityError、主页面地址不变；`window.open(二狗)` 开得了、读不了它的 `document`。
    - 改的地方：`gateway/http-api.ts` 的 `HTML_PREVIEW_CSP`、协议包的 `HTML_PREVIEW_SANDBOX`、报告页顶上那条说明 `HTML_FRAME_NOTICE`（"在隔离的沙箱里打开：页面照常运行、能从外网取数据，但拿不到二狗的数据、连不上二狗；页面里的链接在新窗口打开"）、注释、`docs/dev.md`、规格第 21 节"附件预览"。测试跟着改：`media-frame.test.ts` 的响应头原文（sandbox 不给 `allow-same-origin`、`allow-top-navigation`，给 scripts、forms、modals、downloads、popups，不许 `http:`），Web `attachments.test.ts` 的说明文字。
  - **合并 main**（`53235518`，带进 111、113 之后的 115、116、118、114、112）。冲突 12 个文件，照两边的意思合：
    1. `secretary/task-done.ts`（和 115 合成一份）：取 115 的做法——任务做完交付的能预览的文件，作为一条只有文件的系统消息紧跟在通知后面（同一事务，幂等键 `task-done-files:<全局序号>`，不排进秘书的输入，只在第一次交时放）；117 原来"附件放在来信通知上（`buildAgentNotice` 带附件）"的做法去掉，来信带的附件走同一套（来信那组的附件和任务那组 `attachable` 入库的合成一份）。同一次交的几条里同一个媒体 id 只放一张：维护者 `tell_secretary` 带了 `daily.md`、紧接着任务做完又交了同一份 `daily.md` 的，只跟在先到的来信后面（不然会出现两张一样的卡）。被打断后重新交的只有文字（原来是原样带着附件）。
    2. `secretary/letters.ts`：115 的必填 `summary` 和 117 的 `attachments` 合进一个参数表——维护者的 `{ summary, text, attachments? }`，子 agent、评审的 `{ summary, text }`；信上两样都记；`describeLetter` 照 115 回 `{ text, summary }`，`text` 里带附件的写"（附了 N 个文件：名字（附件引用 <媒体 id>）、…）"。
    3. `secretary/letter-texts.ts`：两边的导入、参数说明都留；`LETTER_ATTACHMENTS_NOTE` 改说"附件已经作为附件卡片放在这条通知后面给用户看了……要看内容用 read_attachment（附件引用写在上面的文件名后面）"。因为附件卡片不进秘书的输入，秘书只能按全文里的附件引用读（主切面核对了它读得到）。
    4. `conversation/messages.ts`：取 115 的 `buildAgentNotice`（带 `summary`），117 加的 `attachments` 选项不要了。
    5. `maintainers/assembly.ts`、`maintainers/maintainers.ts`：只是导入和头注释冲突——114 的 `GuardOwnWork`、⚙ 的说明和 117 的 `fixedMaintainerTools`、`sendAttachmentField`、"发附件"说明并存；112 的自动验收没碰到这几处。
    6. `web/ui/conversation/ChatItemView.tsx`：取 main（115 已经让系统消息按 `partRuns` 画一排附件卡片，和 117 原来的改动一样）。来信带的附件照 115、118 显示：来信折成一行，附件卡片在秘书的转告后面（截图 `merge-classic-light-390-secretary-letter.png`、`merge-classic-light-1280-secretary-letter.png`）。
    7. `web/state/protocol.ts`、`web/prototype/fake-http.ts`、`protocol/test/http.test.ts`：两边的导出、导入、路径清单都留。
    8. `web/prototype/fake-conversations.ts`：取 118 的那段（秘书先发附件再说话）；117 原来放在秘书主线末尾的那封带附件的来信改照 115 的写法（`letter()` 带总结、id 写死），挪到 t-brief 第 3 次运行的【任务做完】前面：一行来信 + 只有文件的系统消息（网页版早报）+ 秘书的转告；t-brief 会话里 `tell_secretary` 那次调用的参数加上 `summary=`。另外自动合并没报的一处：`fake-media.ts` 里 117 的网页版早报和 115 的 `brief.md` 用了同一个假媒体 id `sha256:fake-brief-1007`，网页版改成 `sha256:fake-brief-html-1007`。
    9. `docs/dev.md`：两边的段都留；"附件卡片和报告页"里 117 那句"系统消息带的附件画成一排"改成照 115；"给秘书发消息"的"带附件"一段改写成新的做法。规格第 21 节"发附件"那句同改。
  - **测试（按用户意见没跑全量）**：typecheck 过；oxlint 0 错误（9 条警告都在这次没碰的文件里）；冲突相关的 19 个测试文件 419 条全过——守护进程 `maintainer-attachments`（改成：附件是来信后面那条只有文件的系统消息、通知里写着附件引用、秘书按引用 `read_attachment` 读得到、同一次交的任务做完不再放一张、崩溃后重交只有文字且附件只放一次；参数表多了 `summary`）、`secretary-letters`、`secretary-task-done`、`media-frame`、`media-text`、`external-port`、`agent-settings`、`tasks`、`typed-shell`、`work-orders`，协议包 `http`、`agent-letters`，Web `attachments`、`send-attachment`、`agent-letters`、`chat-items`、`tell-secretary`、`call-sentence`、`build`。
  - **截图**（同一目录 `scratchpad/t117/`，脚本 `merge-shots.cjs`，构建产物的原型、经典浅色）：`merge-classic-light-390-secretary-letter.png`、`merge-classic-light-1280-secretary-letter.png`（秘书主线：✉️ 维护者来信一行 → 秘书的转告 → 网页版早报的卡片 → ✅ 任务做完一行 → 转告 → brief.md 的卡片），`merge-classic-light-390-html-report.png`、`merge-classic-light-1280-html-report.png`（报告页顶上新的说明，框的 sandbox 是新的那一串）。

- 2026-10-13 完成：按用户意见没跑全量；相关测试（首版 3171 条，合 main 后冲突相关 419 条）全过，沙箱在无头 Chrome 里实测过。用户说"上线吧"，没再单独评审。HTML 预览按用户"一阶段不要加什么限制"放宽（只保留不给 allow-same-origin、网关拒 Origin: null、不能把整页导航走）。压缩合并进 main（分支已含 main，快进），`build:web`、经 LSM 重启守护进程部署。
