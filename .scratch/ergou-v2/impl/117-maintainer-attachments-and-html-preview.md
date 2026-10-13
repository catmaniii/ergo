# 117 — 任务和项目的 agent 也能发附件；HTML（和 SVG）附件能直接预览（隔离的沙箱里打开）

Status: ready-for-agent
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

- [ ] 任务维护者、项目维护者有 `send_attachment`，发出的文件在它们的会话里显示成附件卡片；`tell_secretary` 带附件时附件进秘书会话；工具包里看得到、能关；有主切面测试。
- [ ] HTML 附件点"预览"在报告页里的沙箱框中显示、脚本能跑（比如一个按钮改字），但：拿不到二狗的 cookie / 本地存储、fetch 和 WebSocket 连不上二狗（也连不上外面）、表单提交不出去、不能把整页导航走；有守护进程测试（新接口的响应头、只按媒体 id、未配对被拒、`Origin: null` 的 WebSocket 被拒）和 Web 测试（卡片、报告页认得 HTML / SVG）。真浏览器里核对一遍沙箱效果（无头 Chrome：框里的脚本试 `document.cookie`、`fetch('/api/…')`、`new WebSocket(…)`，都拿不到 / 连不上），写清楚怎么核对的。
- [ ] SVG 预览用 `<img>`；`/api/media/<id>` 原规矩不变（回归）。
- [ ] 截图：经典浅色 390、1280（维护者会话里的附件卡片、HTML 报告页、SVG 报告页），另挑 1 套风格。示例数据里不要出现日本相关的内容。
- [ ] 规格、`docs/dev.md` 跟着改；动了守护进程和协议：全量测试一次，typecheck、oxlint 通过。

## Comments
