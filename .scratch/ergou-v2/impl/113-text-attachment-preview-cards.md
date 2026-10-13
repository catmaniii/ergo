# 113 — 文本类附件的预览卡片 + 报告渲染页

Status: done
Blocked by: 无
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI）；附件、媒体接口（31 号票语音、附件发送）

下面是用户 2026-10-13 给的需求文档原文（已按用户 09:28 的拍板定稿），照它做。实现时注意：二狗的页面路由是地址栏 `#/...`（`app/route-hash.ts`），报告页照这个做成 `#/report/<mediaId>`，不另开服务端路由；其余以文档为准。

---


> 用户 2026-10-13 提：日报那种 Markdown 文件，希望聊天里能点一下就**渲染着看**，而不是下载；顺便把附件的显示从“一行文本超链接”改成“带类型图标的卡片”。
> 本版已按用户 2026-10-13 09:28 的拍板定稿（见第三节）。用户明确不做“把全文塞进消息正文”那条替代方案。

## 一、现状（2026-10-13 核实）

- **渲染引擎已经有了**：聊天消息正文按 Markdown 渲染，`packages/web/src/ui/detail/DetailPane.tsx` 用 `react-markdown` + `remarkGfm`（没开 `rehype-raw`，正文里的原始 HTML 不会被当 HTML 渲染）。
- **没有“文件 → 页面”的路由**：`packages/protocol/src/http.ts` 的 `HTTP_PATHS` 是完整清单，只有 `uploads` / `media` / `history` / `usage` / `reference_voices` / `system_prompts` 等，没有 report / file / preview 之类。能读文件内容的只有 `media(mediaId, {name, download})`。
- **媒体接口故意不内联非媒体文件**：`packages/daemon/src/gateway/http-api.ts` 的 `serveMedia()`：
  ```ts
  // 只有认得的图片在页面里直接显示、认得的音频直接播放（语音消息，31 号票），类型是按内容认出的；
  // 其他一律作为附件下载，不按前端声明的类型发出（免得 HTML、SVG 在本机源下跑脚本）
  const inlineType = info.image?.mime ?? info.audio?.mime;
  ```
- **附件已经带着类型**：`packages/daemon/src/media/file-types.ts` 的 `TEXT_TYPES`（`md → text/markdown`、`txt → text/plain`、`csv`、`json`…），发消息时补进消息 part，前端拿得到 `part.mime`，不用重新猜。
- 报告现在落在项目工作目录（`projects/p-1/workdir/daily/…`）和任务产出区（`outputs/<任务 id>/`），进聊天只有附件一条路。

## 二、目标

1. 聊天里点一个 `.md` 附件，跳到**渲染好的页面**（不是下载）。
2. 附件的显示从文本超链接改成**卡片**：类型图标 + 文档标题 + 操作按钮；多个附件横向排列，装不下换行。
3. 不改媒体接口现有的安全边界（图片内联、音频内联，其它一律附件下载）。

## 三、本次拍板的决定（用户 2026-10-13 09:28）

| 编号 | 决定 |
|---|---|
| 1A | 做“附件自动带预览入口”。按钮文案用**「预览」**。 |
| 1A′ | 附件 UI 改成卡片：**图标（上面用文字标类型，如 `MD`、`PPT`）+ 图标下面写文档标题 + 旁边放「预览」/「下载」按钮**；多个附件**尽量排成一横排，屏幕装不下再换行**。 |
| 1A″ | **点图标的默认行为**：见第 4.3 节（本需求主张“能预览的一律默认预览，不能预览的才是下载”）。 |
| 1B | 支持正文里嵌入链接（`media:<id>` 渲染成链接），**相对路径**。**放到下一步做**。 |
| 2 | 报告页做成**独立路由**（可刷新、可分享给同一前端的已配对设备）。 |
| 3 | “项目工作目录浏览”功能认可，**写入规划、暂不做**。 |
| 4 | md 之外的类型（txt/csv/json/代码/PDF…）**列入规划**，本版只做 `text/markdown` + `text/plain`。 |

## 四、详细设计

### 4.1 服务端：内容接口（只返回文本，不直接渲染文件）

新增 `GET /api/media/<mediaId>/text`：

- 响应 JSON：`{ mediaId, name, mime, text, bytes, truncated }`。
- **只服务文本类**：按 `file-types.ts` 的 `TEXT_TYPES` 判定（拿那个 part 上已经补好的 mime 也行）；不在表里的（尤其 `text/html`、`image/svg+xml`、二进制）返回 415 / 404 并说明原因。
- **大小上限**：超过 1 MB 截断，`truncated: true`，页面顶部提示“只显示前 N 字节，完整版点下载”。
- **编码**：UTF-8 解码，解不出来如实报错，不要吐乱码。
- 鉴权沿用现有规矩（本机端口 / 已配对设备的有效凭证）。
- **不要**把媒体接口改成对 md 内联 `text/markdown`：那条注释里的安全理由仍然成立，改内联等于让浏览器直接渲染文件，风险面变大。

### 4.2 前端：报告页（独立路由）

- 路由 `/report/<mediaId>`（相对路径，不写死 IP/端口，前端自己拼当前原点）。可刷新、可收藏、链接可发给同一前端的另一台已配对设备。
- 页面结构：标题栏（文件名 + 生成时间之类 + 「下载」按钮）+ 正文（现有 `react-markdown`，同一套配置，不开 raw HTML）。
- 日报里有**表格**和**外链**：表格要能横向滚动，外链可点跳转；本版不做代码高亮。
- **不自动加载远程图片**：Markdown 里的 `![]()` 一律不请求，显示成占位或链接（避免报告页变成会往外发请求的窗口）。
- 截断时页面顶部有提示条。

### 4.3 附件卡片（本版的重点改动）

**外观**：每个附件一个卡片，竖排三层——

1. **类型图标**：方块内用文字标类型，取扩展名大写（`md → MD`、`pptx → PPT`、`docx → DOC`、`xlsx → XLS`、`pdf → PDF`、`csv → CSV`、`json → JSON`、音视频 → `MP4`/`MP3`、图片 → `PNG`/`JPG`，没后缀 → `FILE`）。建议按类别上色（文档 / 表格 / 图片 / 音视频 / 其它）便于一眼分辨。
2. **文档标题**：单个文件时用原名（过长截断，悬停看全名）；一次性发多个同类文件时允许按序号显示（如 `01-3`、`02-3`），因为分段视频那种场景靠标题区分。
3. **按钮**：「预览」+「下载」；不能预览的类型只给「下载」。

**布局**：多个附件用 flex + wrap——优先排成一横排，屏幕宽度不够时才换行（窄屏下一个卡片一行）。

**点图标的默认行为（本节要拍的点，我的主张）**：**能预览的类型，点图标 = 预览；不能预览的类型，点图标 = 下载**。理由：

- 预览是无损、可重复、不落盘的；下载会在硬盘上留副本，多数时候用户只是想“看一下”。
- 默认下载会让人多一步（先落文件再打开），而且容易攒一堆同名副本；
- 默认预览也不挡路：真想存，旁边的「下载」一直在。
- 不能预览的类型（zip、pptx 这类二进制）在图标上给个提示（比如角标或悬停文字“仅下载”），别让用户点了没反应。

**历史消息**：因为是按 `mime` 判断的，**以前发过的附件也会自动获得预览卡片**（翻回去看 10 月 13 日那条日报也能点开），不用重新发。

### 4.4 正文嵌入链接（下一步做，这里是设计意向）

- 允许 agent 在回复正文里写 `media:<mediaId>`（`mediaId` 就是附件引用那串 sha256），前端渲染成指向 `/report/<id>` 的**相对**链接。
- 要改消息的渲染（`DetailPane.tsx` 那层）；非文本类附件即使写了这个标记也应该是“下载”链接，不是报告页。
- 附带约束：写错 id 就是死链，前端要能优雅处理（“这个文件不在了”而不是白屏）。

### 4.5 边界

- HTML、SVG、JS 一律继续当附件下载——安全边界不动。
- 内容接口返回 JSON，不让浏览器直接渲染文件；响应带 `X-Content-Type-Options: nosniff`。
- 路径只走 mediaId（内容寻址），不接受任意路径，避免越界读文件。

## 五、验收标准

1. 带 `.md` 附件的消息：显示成卡片（类型图标 `MD` + 标题 + 「预览」「下载」）；点图标或「预览」→ 跳到 `/report/<id>`，**渲染出标题、列表、表格、可点的链接**，不是下载。
2. 多个附件（比如三段视频）：默认排成一横排，窗口变窄时换行，不溢出、不重叠。
3. 不能预览的类型（`zip`/`pptx`）：只有「下载」；点图标就是下载，并明确提示不可预览。
4. `.html`、`.svg` 附件：点了仍然只下载（回归，安全边界不变）。
5. 超过 1 MB 的 md：页面能打开、有截断提示、不卡。
6. 报告页可刷新；未配对设备访问被拒。
7. 回归：图片仍内联显示、语音气泡仍能播放、正文 Markdown 渲染不变。
8. 历史消息里的文本类附件也自动有预览入口。

## 六、参考位置

| 文件 | 看什么 |
|---|---|
| `packages/protocol/src/http.ts` | `HTTP_PATHS` / `HttpRoute` / `parseHttpPath`：新增路径三处一起改 |
| `packages/daemon/src/gateway/http-api.ts` | `serveMedia()` 的内联判定与 `Content-Disposition` |
| `packages/daemon/src/media/file-types.ts` | `TEXT_TYPES`、文本类判定与解码 |
| `packages/daemon/src/media/media-store.ts` | `info(mediaId)`：`size` / `image` / `audio` |
| `packages/daemon/src/media/attachment-tools.ts` | `send_attachment` 发的 part 长什么样 |
| `packages/web/src/ui/detail/DetailPane.tsx` | 现有 Markdown 渲染、附件当前怎么显示 |
| `packages/web/src/ui/conversation/` | 消息里 part 的渲染（卡片要改这里） |
| `packages/web/src/pages/` | 页面路由怎么挂（新增 `/report/<id>`） |

## 七、写入规划、本版不做

1. **项目工作目录浏览**：项目页给一个只读文件树，看 `projects/<id>/workdir/`，`md`/`json`/`csv` 可预览，其它下载。用户认可，列入规划。注意路径安全（`../` 与符号链接必须挡住）、大小上限、二进制判定、权限。
2. **更多文件类型**：`csv`/`tsv` 渲染成表格（列宽、横向滚动、大表截断）；`json`/`jsonl` 格式化可折叠；代码类等高亮；PDF 内嵌查看。用户同意列入规划。
3. **正文嵌入链接**（1B）：下一步做，见 4.4。

---

## Acceptance criteria

- [x] 文档第五节"验收标准"8 条逐条做到，各有测试（守护进程主切面：内容接口的文本 / 非文本 / 超 1 MB / 解码失败 / 未配对；Web 状态层：附件卡片的类型标签、能不能预览、点图标的行为、多个附件排列）。
- [x] 截图：经典浅色 390、1280（单个 md 附件卡片、三个附件一排 / 换行、报告页含表格和链接、截断提示），另挑 2 套风格。示例数据里不要出现日本相关的内容。
- [x] 第七节"写入规划、本版不做"三项写进规格的 Out of Scope；`docs/dev.md` 跟着改。
- [x] 动了守护进程和协议：全量测试一次，typecheck、oxlint 通过。

## Comments

- 2026-10-13 实现（分支 `worktree-agent-a50d9f59225690673`，基于 main `7c2f9a57`；worktree 原来在 `a2dd7c13`，先快进到 main）。说明在 `docs/dev.md`"媒体与附件"一节（内容接口）和新的一节"附件卡片和报告页（113 号票，Web 为主）"，协议包一节也补了；第七节三项写进了规格的 Out of Scope（"附件预览的后续"）。
  - **协议**：`HTTP_PATHS.mediaText(id)`（`GET /api/media/<媒体 id>/text`，`parseHttpPath` 拆成 `media_text`）、`MEDIA_TEXT_MAX_BYTES`（1 MB）、错误码 `unsupported_type`（415）和 `undecodable`（422）、响应 `MediaTextView`（`{ mediaId, name, mime, text, bytes, truncated, sentAt }`）；`parts.ts` 的 `textPreviewOf(part)`：能不能预览、按 Markdown 还是纯文本画，守护进程和 Web 共用这一份判断。
  - **守护进程**（先写测试）：`gateway/http-api.ts` 的 `mediaText`。只按媒体 id 取；名字、类型以消息里最近一次引用它的 part 为准（`conversation/attachments-view.ts` 的 `latestAttachment`，连带那条消息的时间）；只给 `text/markdown`、`text/plain`，HTML、SVG、图片、zip、CSV 等回 415 并说明；超过 1 MB 只读开头、截在字符边上；只按 UTF-8 解（`media/file-types.ts` 的 `decodeUtf8`），解不出来或含 NUL 回 422；JSON 响应照旧带 `nosniff` 等安全头、不缓存。媒体接口本身没动（内联只有认得的图片和音频），没加新的安全拦截。
  - **Web**：状态层 `state/attachments.ts`（`attachmentTypeLabel`、`attachmentCategory`、`fileCards`、`partRuns`、`reportPageView`、`markdownChunks`）；附件卡片 `ui/conversation/parts.tsx` 的 `FileCards`（原来的一行链接 `FileView` 删掉），`ChatItemView.tsx` 和详情页的"附件"一节把连着的附件画成一排（只动了附件那一块的渲染）；报告页 `pages/ReportPage.tsx`，地址 `#/report/<媒体 id>`（`route-hash.ts`），`DaemonHttp.mediaText`（取不到不抛错，回错误码），‹ 回到点进来的会话（`history-nav.ts` 的 `cameFrom`），直接打开的回秘书页；样式在 `pages.css`（类别颜色借现成的 token），像素小屋的 `.part-file` 规则改成 `.att-card`。
  - **原型**：`prototype/fake-media.ts` 加了样例（10 月 7 日日报.md：标题、列表、五列表格、三个外链、一张远程图片；2026 年账单流水.md 一兆多；三段周会录像 mp4、源码 zip、预览页 HTML），秘书主线末尾加了五条用到它们的消息；假的下载给一段说明文字。
  - **和需求文档不一样的地方**：
    1. **同类多个的序号**：卡片标题是"01-3 周会录像-第1段.mp4"——序号在前、原名照旧在后（两行放不下时从中间省略，留结尾和扩展名），不是只显示序号；免得一次发"日报.md""周报.md"时只剩"01-2""02-2"。
    2. **一排只出现在一条消息里带了几个附件的时候**：agent 的 `send_attachment` 一次发一个文件、各是一条消息，所以 agent 连着发的三段视频是三条消息、各占一行；用户一次选几个文件发是一排。工具没改（要一排得让工具一次能发几个文件，票面没提，没做）。
    3. **报告页取不到时没有"下载"按钮**：错误响应里没有文件名，下载链接只能用媒体 id 当文件名；改成提示"回到聊天里点附件卡片上的「下载」"。取到的时候标题栏有"下载"。
    4. **只按 UTF-8 解**，和"读取附件"（UTF-8 不行再按 GB18030）不同：照文档"UTF-8 解码，解不出来如实报错"；GBK 存的 md 预览会说"不是 UTF-8 编码的文本"。
    5. **报告页多了"发出时间"**：`MediaTextView` 比文档多一个可选的 `sentAt`（引用它的那条消息的时间），标题下面一行写"Markdown · 1.1 KB · 10-07 21:30 发出"，对应文档里的"生成时间之类"。
    6. **大报告分段画**：1 MB 的 Markdown 一次解析、画完要一秒多（原型里量的），页面会卡；按空行切成约 2 万字一段，先画第一段、其余一段段接着画，最长的一个任务约 60 毫秒。代价是引用式链接的定义、脚注跨了段认不出（只有超过一段长的才分）。
    7. **页内锚点**（`[跳到](#某节)`）只显示文字：页面路由就在地址栏的 `#` 里，点了会跳去秘书页。
    8. **HTML、SVG 的判断多了一层扩展名**：part 上的类型就算写成 `text/plain`，扩展名是 html、htm、xhtml、svg、svgz、xml 的也不预览、只下载。
    9. **"能预览"只认 `text/markdown`、`text/plain`**：`log`、`ini`、`srt` 这些按扩展名补成 `text/plain` 的也能预览（按原文显示）；`csv`、`json`、代码类按第七节留到以后。
  - **测试**：守护进程主切面 `test/main/media-text.test.ts` 8 条（Markdown / 纯文本回 JSON 和安全头、同一份内容以最近一次的名字为准、415 的六种、404 的四种、超 1 MB 截在字符边上和刚好 1 MB 不截、422 的 GBK 和 NUL、外网端口没配对 401 / 配对过 200、媒体接口照旧 md 和 HTML 作为附件下载、图片内联），`external-port.test.ts` 的要凭证清单加了这个接口；协议包 `test/http.test.ts` 加 2 条（原来拆地址的两条里也加了这个接口）；Web `test/state/attachments.test.ts` 50 条（类型标签、类别、卡片的预览与否和点图标、HTML / SVG 只下载、从中间省略、同类序号、连着的合成一组、回放 `secretary-attachments` 录下的旧附件照样能预览、报告页几种情况、`markdownChunks`），`route.test.ts`、`history-nav.test.ts` 各加报告页的。全量一次（`ERGOU_TEST_WORKERS=2`，20 分 15 秒）：309 个文件 5412 条，5411 过、1 条没过——`test/main/secretary-task-done.test.ts` 的"几件差不多同时做完的并成一条"，满负载下两件的先后颠倒了，和本票无关，单独重跑 15 条全过。`npm run typecheck`、`npx oxlint`（0 错误，警告都是原有的）通过。
  - **截图**在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t113\`（脚本 `shots.cjs`，构建产物的原型，无头 Chrome 开 `file://`）：经典浅色 `classic-light-390-md-card`（单个 md 卡片）、`-390-three-videos`（三个附件换行成 2+1，序号 01-3…）、`-390-zip-html`（只能下载、图标写"仅下载"）、`-390-report`、`-390-report-full`（报告页整页：标题、列表、表格、链接、图片占位）、`-390-report-table-scrolled`（表格横向滚过去）、`-390-truncated`（截断提示）、`-390-gone`（文件不在了）、`-390-html-not-previewable`；`classic-light-1280-md-card`、`-1280-three-videos`（一排）、`-1280-report`、`-1280-truncated`；另两套：`pixel-light-1280-three-videos`、`pixel-light-390-report`、`night-dark-1280-cards`、`night-dark-390-report`。

- 2026-10-13 完成：全量 5412 条过 5411（没过的 `secretary-task-done` 满负载下两件做完的先后颠倒，和本票无关，单独重跑全过）。评审没有会出错的问题。压缩合并进 main（`docs/dev.md`、原型会话和 109 / 110 的冲突手工合并），`build:web`、经 LSM 重启守护进程部署。
