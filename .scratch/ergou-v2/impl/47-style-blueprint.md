# 47 — 视觉风格"工程蓝图"

Status: done
Blocked by: 76、77、60、83（用户 2026-10-11 定：其他票做完后集成这 9 套风格）
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI）"外观"

## What to build

在 39 号票搭好的风格底座上，加一套风格"工程蓝图"，内部 id 是 `blueprint`。设计稿是 `docs/design/styles/` 里方案 F 那一行（`f-chat`、`f-tasks`、`f-inbox`、`f-wide`），说明见同目录的 README。

要点：直角、1.5px 线框带角标、网格底、钴蓝；深色就是真正的蓝图纸。密度比别的低，内容多的页面（看板、记忆）也要排得开。

设计稿里画了个人助理名字的底色标签（43 号票），这套风格要覆盖名字标签的 token，画成设计稿里的样子。

## Acceptance criteria

- [x] 设置 · 外观 · 风格里多出"工程蓝图"，选了立即生效，按设备记住（沿用 39 号票）。
- [x] 按设计稿还原四个画面：聊天（文字气泡、语音气泡、审批卡、输入栏、名字标签）、任务看板、待我处理、宽屏，浅色、深色都要。其余页面按同一套 token 和规则推出来。
- [x] 设计稿里出现了产品没有的信息或控件，不加，写进 Comments。
- [x] 字体按 39 号票的办法由二狗自己提供，只在选了这套风格时加载；字体许可证写进 Comments。
- [x] 39 号票的对比度测试覆盖这一套，浅色、深色都达标。
- [x] 只动这套风格自己的文件和风格清单里的一行。如果必须改共享代码，写进 Comments 并说明原因。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 40–42、46–51 这些风格票并行做，各加一套，冲突点只在风格清单。收尾前变基到最新 main。
- 怎么加一套风格，见 `docs/dev.md` 里 39 号票写的说明。

## Comments

- 2026-10-10 暂缓：用户定风格先只有两套，这张票后续再做。

- 2026-10-11 取消暂缓：用户定其他票（76、77、60、83）做完后集成 78 号票的 9 套视觉风格。

- 2026-10-11 实现说明（47 号票）：
  - **做了什么**：照 `docs/dev.md`"加一套风格"加了风格 `blueprint`（工程蓝图）。`packages/web/src/visual-styles/blueprint/style.ts` 是 token（颜色、字体、字号、圆角、阴影、间距、边框、语音气泡尺寸），`blueprint/style.css` 是只靠 token 做不到的规则（每条都以 `:root[data-style="blueprint"]` 开头，浅深只靠 token 的 `light-dark()` 切，不写 `[data-theme]` 规则）；风格清单 `index.ts` 加 import 一行、清单一行（排在软糖圆角后面：经典、A 暖纸、B 格栅、C 夜航、D 软糖、F 蓝图；46 号票的 E 玻璃合进来时排在 D、F 之间）。设置 · 外观与风格里多出"工程蓝图"，选了立即生效、按设备记住、浅深两张预览自动有（39 号票的底座）。
  - **颜色**照设计稿 `renderVals()` 浅深两套：`bg #F7F9FC / #0D1B3E`、`surface #FFFFFF / #112353`、`text #0F1E45 / #E6ECFF`、`muted #4B5A80 / #A4B2D9`、`fill` = 设计稿的 `--code`（`#EEF2FA / #0B173A`）、`data-bg` = `--accent-soft`（`#E3EAF8 / #1C2D5C`）；设计稿的线色 `--line` 和强调色 `--accent` 是同一个钴蓝（`#1E3A8A / #9DB4FF`），`border`（线）和 `primary`（强调、主按钮实底，上面的字是 `--accent-ink`）都是它，深色下浅蓝线压在深蓝底上，就是蓝图纸。你发的消息照设计稿你的语音：线色实底、页面底色的字。`--warn` 是 `you`（等你、审批、卡住任务、未读）。
  - **四个画面**：
    - 聊天：个人助理的话是"框"（白底、1.5px 钴蓝线、左上 / 右下各一个 7px、3px 粗的角标），你的消息钴蓝实底；时间挪到话上面一行（IBM Plex Mono 10px、字距拉开）；语音气泡：你的钴蓝实底、四周同色线，个人助理的是框，播放键 28 的直角方块（1.5px 线框，个人助理的淡蓝底）、波形直角竖条 3 隔 3、高 22、时长等宽 12px，下半截和播放条之间一道虚线；审批卡是框，类型标签是等宽小字的钴蓝实色签，标题另起一行，工具名一行等宽灰蓝小字、参数是虚线框的代码块（宽屏同一行），命中的关注类别是中性线框签，守卫的理由是灰字，"拒绝 / 批准这一次" 1 : 1.4、44 高（宽屏靠右、最小宽 96 / 128）；主按钮都带设计稿那块往右下错开 3px 的淡蓝硬边影子，次要按钮是 1.5px 线框；输入栏附件、语音 / 键盘是 44 的线框方块（设计稿的直角线条图标，切到语音的淡蓝底），输入框 1.5px 线框、页面底色，按住说话淡蓝底线框钴蓝粗字；名字标签（43 号票）照设计稿的 `.name`：淡蓝底、钴蓝字、钴蓝细框、粗字、前后一对等宽的 `[ ]`（导航上的名字按"两个字"的宽度算好了，不加括号）。
    - 任务看板：卡片是框；状态是右上角直角的实色小签（等你、待确认橙；规划中、执行中、运营中钴蓝；失败红；排队、等时间、已完成、已取消、暂停这类线框灰蓝字），排法照 41 号票补的 `.bcard-status-row`（`display: contents` + `order`，没改结构）；进度条用产品已有的 `sl-progress`，照设计稿的 `.track`（1px 线框、卡片色轨道、钴蓝填充）；token、时间表、下一次这些数字等宽；分组标题粗字 + 灰蓝说明 + 钴蓝等宽件数（前面加 `×`，设计稿的"×5"），下面一道虚线，不上色。
    - 待我处理：标题区里的页签（`.seg-head`）是一排相邻线叠成一道的线框格子，选中的钴蓝实底粗字，和标题栏合成一个头；分组标题等宽灰蓝小字后面一道虚线；每一项一张 1px 线框卡片（未读的再往里描 0.5px，合起来 1.5px），未读橙色实心小方块、看过的空心线框小方块，未读标题粗体。
    - 宽屏：竖栏选中的一项淡蓝底、左边 3px 钴蓝；会话区左右留白 28（设计稿 f-wide）；个人助理的话最宽 520、卡片最宽 560。
    - 导航：设计稿的直角线条图标（按 `data-nav`，CSS mask）；底部横栏上面 1.5px 线，选中的钴蓝粗字、顶上一道 3px 钴蓝短线压在横栏的线上；看过没处理的件数是等宽数字的直角小格（钴蓝线框），未读是橙色小方块。
    - 网格底：页面底色的地方（`body`、`.app`、`.pane-main`、`.chat-col`）铺 24px 网格，网格线是钴蓝 12% 混进页面底色（浅色 `#dde2ee`、深色 `#1e2d55`，设计稿 `#DCE4F2 / #1C2D5C`），挂在不滚动的外层上，滚动时网格不动；设置的预览里也有。
  - **其余页面**按同一套 token 和规则推（截图都看过）：线（`--border`）就是钴蓝，所以经典里所有分隔线、表格线都是钴蓝细线；`.card` 底板（设置项、项目卡）也是框带角标；页签、单选的选中格是钴蓝实底；运行记录（`run-st-*`）、工单（`wo-*`）、任务详情、项目页的状态都按上面的实色 / 线框小签写成 `.st.<状态>`（运行完成、工单完成绿色实底，运行失败、被打断、退回、做不了红色实底，运行中、工单在做钴蓝实底，等你、待你确认、在澄清橙色实底），截图核对过颜色都在；工单、表格、范围记录、作业、流水线、工具包、设置里的一行行、消耗的统计块和柱状图、日历当天的事项、设备这些只靠白底和页面分开的块，压在网格上分不清边，加了 1px 线框（`box-shadow inset`，不改尺寸；`.sjob-row.on` 的高亮外圈重写了一遍）；经典里写死的几处圆角（发起任务的种类卡、流程计划卡……）改直角；小圆点（导航未读、待我处理、工具调用、活动状态、出过状况、紧急度）改小方块。
  - **用户第一批定的规矩，这一套照做的**：
    - 看板、待我处理用卡片。设计稿 `.dc.html` 里那条按钮重置 `.root button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;padding:0}` 特异度比 `.card`、`.row`、`.seg`、`.tab` 高，画布上看板卡、待我处理每一项是平铺的（没有底色、边框、内边距，页签也没有格子线），按样式表的本意做成了卡片；对照截图里的设计稿也按本意画（`scripts/design.mjs` 把这条重置降成 0 特异度）。
    - 不靠降透明度表示"已结束"：设计稿最近结束的卡淡到 0.7（卡里灰字会掉到 4.5:1 以下），这里改成不铺白底（露出网格）、1px 细线、没有角标，字色不变；经典处理过的卡片（`.xcard-done`）正文淡到 0.78，这套里不淡，改成类型标签变线框、去掉角标。
    - 颜色调深到 ≥ 4.5:1，不在 token 表里的组合自己算了（脚本 `scripts/contrast.mjs`、`scripts/grid-contrast.mjs`），网格底上的字按最坏的底（网格线的颜色）算：见下面"对比度"。
    - 共用机制：`bar-bg`（设计稿标题栏就是卡片色，和经典的写法 `var(--surface)` 一样，没写，地址栏跟着卡片色）；`voice-*` token 照 f-chat 写 `voice-pad 12`、`voice-key 28`、`voice-gap 10`、`voice-bar 3`、`voice-bar-gap 3`，框四周 1.5px 的线左右合起来 3，和经典的 `voice-line` 一样，没写；设置的预览没写任何 `.preview-page` 规则（共用贴底后浅深两张卡片和两个按钮都完整，截图 `blueprint-settings-bottom-*`）；助理名字首字（`--assistant-initial`）：方案 F 没有字头像，不用；`TopBar` 的 `data-back`：设计稿没画二级页，不用；`.seg-head` 用在待我处理的页签上；名字标签覆盖了 `name-bg / name-fg`。
    - token 只写和经典不一样的（`voice-line`、`bar-bg`、`nav-on`、字号阶除标题外都没写）；状态色写成 `.st.st-xxx`；没有依赖页面结构的选择器（没有 `:nth-child`、`+`、`>`、类名子串）；角标用伪元素（每个框的 `::before` 铺满框里，用两段渐变画左上、右下两个 L，不挡点击；看板卡的 `::after` 留给 41 号票那种折行用），没加 DOM；没补 class 也没改结构。
    - 截断：发起任务弹层的分段（种类卡三张、"现在做一次 / 定时 / 事件发生时 / 只提醒我"）每一格都完整、不用横向滚（无头浏览器量过 `scrollWidth`）；待我处理每一行的说明（种类 · 来源 · 时间）在 390 宽时 318px，经典一行放得下的这里也一行、经典折两行的这里也两行，360 宽时和经典逐行一样（`scripts/probe.mjs`）。为了这个，列表左右留白 10（设计稿 16）、每一项左内边距 7、小方块后面隔 7、"⋯"按钮左右内边距 3。
  - **和设计稿不一样的地方**（导航和页面上的信息、控件所有风格共用；设计稿有、产品没有的不加）：
    1. **要用户定**：看板分组标题前的编号（"01 等我""02 进行中"）、待我处理分组前的字母（"A · 置顶""B · 卡住任务"）产品没有，没加（用 CSS 计数器能加、不动 DOM，但它算是新出现的内容，先不加）。看板件数前面的"×"加了（`.bgroup-n::before`，只是数字的写法，和设计稿"×5"一样）——要是也算内容就去掉。
    2. 标题上面那行等宽小字（"ASSISTANT / 秘书主线""BOARD / 5 等我 · 3 进行中 · 4 运营中""INBOX / 3 未读 · 2 卡着任务""ERGOU / V2"）产品没有，不加；产品有副标题的（宽屏秘书页的"主线会话"）照经典排在标题后面。
    3. 个人助理每句话上面设计稿是"[二狗] 08:00"，产品的消息只带时间（CSS 拿不到完整的名字），只画时间。标题：设计稿是"个人助理 [二狗]"（12px 的名字标签跟在标题后面），产品的秘书页标题就是名字本身，名字标签按标题的字号画。
    4. 审批卡：右上角"卡住任务 · 有时限"产品卡片上没有，不加；类型标签设计稿是"APPROVAL · 先问我"，产品是"审批"，"先问我"在小签那一排；工具名设计稿前面有"TOOL / "，产品只有工具名，不加前缀。
    5. 个人助理语音下面"语音回复 · 长按转文字"一行产品没有（展开转文字才有下半截，画成虚线下面的原文）；你发的语音照产品从右往左排（播放键在右），设计稿在左。
    6. 看板卡：产品多的种类签、活动状态、项目签、暂停 / 取消按钮保留；状态文字照产品（"等我 · 审批""待确认 · 计划等你确认"，比设计稿长），状态签挤不下时标题折到种类签下一行（和夜航仪表一样）；设计稿进度条单独一整行，产品的进度条和"几/几"、token 在同一行（60 号票的组件），写"1/4"不写"1/4 阶段"；设计稿"不确定续期命令是否已执行"那行是橙色字，产品这一行认不出来，照旧灰字。状态签字号 11px（设计稿 10px：产品的状态字多，10px 的汉字太小）。
    7. 待我处理每一项说明里的种类（"审批""提醒"）设计稿是钴蓝粗字；产品里种类、来源、时间是一段字，不拆就上不了色，没做；时间也没单独等宽。产品多的紧急度小方块、"⋯"菜单、浏览器通知那一行保留。
    8. 宽屏右边"待我处理 / 进行中"一栏产品没有，不加；竖栏宽度按导航的规矩（图标 + 两个字，43px），不加宽到设计稿的 168px，"二狗"15px。
    9. 导航的名字照产品两个字（助理、待办）；导航上的数字设计稿是橙色实底的未读数，产品的数字是"看过没处理"、未读是小点——小点画成橙色小方块，数字画成设计稿角标的形状（等宽、17px 直角小格）但用钴蓝线框，不用橙色实底。底部横栏设计稿下面多 10px 内边距，产品按安全区。
    10. 输入栏产品多一个"发送"按钮，按主按钮画。
    11. 颜色：设计稿没画到的按同一套推——出错红 `#b42318 / #ff8fa3`、危险按钮同色实底、操作类小签（命中关注类别、计划外……）土黄 `#7a4b00` 淡黄底 / `#f2c46b`、计划琥珀 `#a16207 / #f2c14e`（橙色留给"要你"，钴蓝已经是强调色）、想法紫、工具绿、上下文玫红、回复蓝灰；深色下实色块上的字用深蓝墨（`on-color #0d1b3e`）。
    12. 线（`--border`）用钴蓝：经典里拿 `--border` 当底色的几处（次要按钮、看板件数、`sl-progress` / `progress-bar` 的轨道、`vv-badge`、`vv-chip`、`rb-status`、`rb-kind`、`zf-tag`、`pst-archived`、日历年月按钮、录音音量条）上面的字压在钴蓝上会看不清，在 style.css 里逐个换成淡蓝底或线框，被盖掉的变体（`rb-s-violated`、`rb-s-deferred`、`zf-now`、`zf-bad`）重写了一遍。
  - **共享代码**：没改。只动了 `blueprint/` 两个新文件、风格清单 `index.ts` 两行（import 一行、清单一行）、`packages/web/package.json` 和 `package-lock.json`（字体包）；没补 class、没改页面组件、经典的规则和 token 名字。所以没做经典 / 别的风格的逐像素对照（没有共用的东西变了）。
  - **字体**：正文 Noto Sans SC（设计稿就是它，沿用 39 号票已装的 `@fontsource-variable/noto-sans-sc@5.3.0`，没新装），时间、时长、计数、token（`--font-num`）和代码（`--font-mono`）用 IBM Plex Mono，数字字体后面接正文字体。新装的只有 `@fontsource/ibm-plex-mono@5.3.0`（npm 官方仓库，用户同意；包解压约 1.9 MB），只取设计稿用到的 500、600 两个字重（`500.css`、`600.css`；只写 400 的地方落到 500），构建时拷进产物的是 10 片 woff2 加许可证共 132 KB（`dist/fonts/fontsource-ibm-plex-mono@5.3.0/`），`dist/fonts/blueprint.css` 只在选了这套时挂，按 `unicode-range` 只下用到的片。**许可证 SIL Open Font License 1.1（OFL-1.1，Copyright 2017 IBM Corp.）**，允许随软件分发，全文拷到 `dist/fonts/fontsource-ibm-plex-mono@5.3.0/LICENSE.txt`（`fonts.test.ts` 查它在）；Noto Sans SC 同为 OFL-1.1。装法：worktree 里原来没有 `node_modules`（不是链接），直接在 worktree 里 `npm ci`，再 `npm install -D --save-exact @fontsource/ibm-plex-mono@5.3.0 -w @ergou/web`，两个文件只多这一项。
  - **对比度**（39 号票的测试按风格清单自动覆盖这一套，浅深全过）：设计稿的颜色调了几处——浅色 `--warn` `#c2410c` 压在网格线上 4.05:1，沿色相加深到 `#b23a0a`（网格线上 4.62、页面底 5.68、白底 6.0、淡橙底 `#fdf0e8` 上 5.4）；名字标签底设计稿的淡蓝和浅色页面底只差 1.14 倍、深色和卡片底 1.14 倍（名字标签测试要 1.15），浅色加深到 `#dbe4f6`、深色提亮到 `#22366b`（字和底 8.11 / 5.76）；浅色结果色压在网格线上不够的压深：通过绿 `#05703f`（4.77）、拉回青 `#0b6a84`（4.75，经典 `#0f8a9d` 白底上只有 4.08）、退回紫 `#7a40c8`（4.77）。不在测试表里的组合另外算过，全部 ≥ 4.5：网格线上的正文 12.5 / 11.4、灰蓝字 5.27 / 6.37、钴蓝 7.98 / 6.66、出错 5.07 / 6.22；橙色实底上的字 6.0 / 9.41、钴蓝实底上的字 10.36 / 8.37、绿色实底 6.18 / 9.06、红色实底 6.57 / 7.81、计划琥珀实底 4.92 / 10.06；淡蓝底上的灰蓝字 5.66 / 6.3、钴蓝 8.58 / 6.59、橙 4.97 / 7.41；按住时的底上钴蓝 7.55 / 5.18。
  - **测试**（变基到 main `5c46a0b9` 之后跑的）：`npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts packages/web/test/state/voice.test.ts` 9 个文件 474 条通过；web 包全部 72 个文件 1617 条通过（`ERGOU_TEST_WORKERS=2`，先查过没有别的 vitest 在跑）；守护进程 `packages/daemon/test/main/fonts.test.ts`、`gateway.test.ts` 15 条通过（现场构建的产物里这套的字体经网关取得到）；`npm run typecheck -w @ergou/web` 通过；oxlint 0 个错误（1 个 warning 是 `chat-look.test.ts` 原来就有的）。日志在本 worktree 的 `test-web.log`、`test-daemon.log`、`test-styles.log`、`typecheck.log`、`oxlint.log`（不进仓库）。
  - **截图**（无头 Chrome 开构建产物 `file://`，原型模式，localStorage 选上 `blueprint`，跟随系统按浏览器的浅深切，2 倍像素，不打网络、没起服务）：`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t47\`。`blueprint-<画面>-<light|dark>.png`：390 宽的聊天 `chat`、你的语音 `chat-voice`、个人助理的语音 `chat-agent-voice` / 展开转文字 `chat-agent-voice-text`、按住说话 `chat-hold`、审批卡 `chat-approval`、看板 `tasks` / 定时和提醒卡 `tasks-more` / 最近结束 `tasks-ended`、待我处理 `inbox`、运行记录 `runs`、工单 `orders`、记忆 `memory`、设置预览 `settings` / `settings-bottom`、设置列表 `settingsmenu`、消耗 `usage`、日历 `calendar`、项目 `projects`、发起任务弹层 `launch`、360 宽 `narrow360`；1280 宽的 `wide`、`wide-voice`、`wide-approval`、`wide-tasks`、`wide-inbox`、`wide-runs`、`wide-orders`、任务详情的阶段栏 `stage`、`wide-memory`。设计稿同尺寸 `design-<chat|tasks|inbox|wide>-<light|dark>.png`（`.dc.html` 缺 support.js 打不开，脚本转成普通 HTML、字体用本机的包），并排对照 `compare-<chat|tasks|inbox|wide>-<light|dark>.png`；脚本在 `scripts\`（`shots.mjs`、`design.mjs`、`compare.mjs`、`probe.mjs`、`contrast.mjs`、`grid-contrast.mjs`），中间稿在 `work\`。

- 2026-10-11 评审第一轮修改（47 号票；评审无阻塞）：
  - **主会话 / 用户的决定**：看板分组编号"01 / 02"先不加（在问用户）；待我处理的"A · / B ·"不加（分组只在有内容时出现，字母会跟着空分组移位）；"×"留着。
  1. **流程计划卡的步骤号 `.rp-n`**：经典写死白字压在计划色上，这套深色的计划色是亮琥珀 `#f2c14e`，白字只剩 1.68:1。这套里补 `color: var(--on-color)`（浅色白字 4.92:1、深色深蓝墨 10.06:1），圆改直角（截图 `blueprint-workflow-plan-*`）。
  2. **选中的已结束卡丢了淡蓝底**：`.bg-ended .bcard`、`.bg-archived .bcard` 和 `.bcard.on` 特异度一样又写在后面，补了 `.bg-ended .bcard.on`、`.bg-archived .bcard.on`（截图 `blueprint-wide-tasks-ended-on-*`：宽屏点开一张已完成的卡）。
  3. **去重**：语音播放键不再自己写一对 mask，改成在 `.voice-icon` 上设 `--blueprint-icon`（播放中换暂停），`::before` 并进导航 / 输入栏图标那条规则，只另写 14px 的尺寸；输入栏 `[data-to="voice"]` 的两条（底色、图标）合成一条。
  4. **style.ts 开头的说法**：颜色取自设计稿样式里 `.root`（浅色）、`.root.dark`（深色）两套变量，`renderVals()` 只挑强调色（默认钴蓝，深色下换成 #9DB4FF）。上一条 Comments 里"颜色照设计稿 `renderVals()` 浅深两套"以这里为准。
  5. **看板卡标题剩一个字单独换行**（"每周汇总银行账 / 单"）：这套里 `.bcard-title` 加 `text-wrap: pretty`，现在折成"每周汇总银行 / 账单"（截图 `blueprint-tasks-*`）。
  6. **导航待办的件数小格盖住铃铛**：缩回经典的 15px 之后两位数（"11"）还是把线条铃铛的上半截盖掉（截图对照 `navbadge-classic-*`、`navbadge-blueprint-*`，4 倍放大）。改成去掉实底和线框：只写钴蓝的等宽数字，描一圈卡片色的光晕（`text-shadow`），压在铃铛的线上也读得清；大小、位置、左右内边距都照经典，未读的橙色小方块按经典挨在右上角，落在内边距上、不压数字。上一条 Comments 第 9 点"数字画成设计稿角标的形状（等宽、17px 直角小格）但用钴蓝线框"作废，以这里为准。
  7. **日历"有运行失败"的点**：格子里的 `.cal-mk-fail` 也改成小方块，和图例一致（截图 `blueprint-calendar-*`）。
  8. **"×"**：写成 `content: "×"; content: "×" / "";`（读屏不念成"乘"；不认替代文字写法的浏览器用前面那条普通写法；构建后两条都还在）。`.bgroup-n` 用在 5 处，逐处截图看过，读着都通顺，都留着：看板分组"等我 ×7"（`blueprint-tasks-*`）、项目页"已归档 ×1 展开 ▸"（`blueprint-projects-archived-*`）、项目页工单流水线的每一栏"排队中 ×1 / 进行中 ×0 / 已结束 ×3"（使用中的项目 `blueprint-project-pipeline-*`、建设中的项目那一份流水线 `blueprint-project-pipeline2-*`）、范围记录的每一组"越界 ×1 / 范围变更 ×0"。范围记录分组（`ui/scope-records.tsx`）在原型里没有数据（原型的项目页、任务详情画的是假数据里的 `scope-row`，不走这个组件），截图是在任务详情"消耗"页的"范围记录"一节里照组件的标记临时插一份截的（`scope-groups-<classic|blueprint>-*`，脚本 `scripts\scope-groups.mjs`）。
  - **共享代码**：这一轮也没改，只动了 `blueprint/style.css`、`blueprint/style.ts` 的注释。
  - **变基**：main 还是 `5c46a0b9`（46、48 还没合进来），不用变基；风格清单、`package.json`、lockfile 没动。
  - **测试**（main `5c46a0b9` 上；先等别的 worktree 的 vitest 跑完再跑）：`test/visual-styles`、`test/app/theme.test.ts`、`test/build.test.ts`、`test/state/voice.test.ts` 9 个文件 474 条通过；web 包全部 72 个文件 1617 条通过（`ERGOU_TEST_WORKERS=2`）；守护进程 `fonts.test.ts`、`gateway.test.ts` 15 条通过；`npm run typecheck -w @ergou/web` 通过；oxlint 0 个错误（1 个 warning 是 `chat-look.test.ts` 原来就有的）。
  - **截图**（同一目录 `t47\`）：导航上的件数每张都有，所以 `blueprint-*`、`compare-*` 全部重截；新增 `blueprint-workflow-plan-*`、`blueprint-wide-tasks-ended-on-*`、`blueprint-projects-archived-*`、`blueprint-project-pipeline-*`、`blueprint-project-pipeline2-*`、`navbadge-*`、`scope-groups-*`。

- 2026-10-11 用户定：看板分组标题前加编号（47 号票）：
  - **做了什么**：照设计稿 f-tasks 的"01 等我""02 进行中"，看板分组名前面加钴蓝等宽小字的"01 / 02 / 03 / 04 / 05"（等我、进行中、运营中、最近结束、已归档）。只用样式：`.board` 上 `counter-reset`、每个 `.bgroup` 上 `counter-increment`、`.bgroup .bgroup-h::before` 写 `counter(blueprint-group, decimal-leading-zero)`，不动页面结构、没补 class。看板上的分组总是全部列出（空的写"没有"），编号不会跳。只认 `.bgroup` 里的标题：项目页"已归档"那一行（直接排在 `.board` 里、不在 `.bgroup` 里）不编号；待我处理的"A · / B ·"照定的不加。读屏不念编号：写成 `content: counter(...) / ""`，前面留一条普通写法给不认替代文字写法的浏览器（构建后两条都在）。
  - 上一条"和设计稿不一样"第 1 点（编号没加、要用户定）以这里为准：看板编号加了，待我处理字母不加，"×"留着。
  - **共享代码**：没改，只动了 `blueprint/style.css`。
  - **变基**：main 还是 `5c46a0b9`（46、48 还没合进来），不用变基；风格清单、`package.json`、lockfile 没动。
  - **测试**（先查过没有别的 vitest 在跑）：`test/visual-styles`、`test/app/theme.test.ts`、`test/build.test.ts`、`test/state/voice.test.ts` 9 个文件 474 条通过；web 包全部 72 个文件 1617 条通过（`ERGOU_TEST_WORKERS=2`）；守护进程 `fonts.test.ts`、`gateway.test.ts` 15 条通过；typecheck 通过；oxlint 0 个错误（1 个 warning 是原来就有的）。
  - **截图**（同一目录 `t47\`）：重截了 `blueprint-tasks-*`、`blueprint-tasks-more-*`、`blueprint-tasks-ended-*`（"04 最近结束""05 已归档"）、`blueprint-wide-tasks-*`、`blueprint-wide-tasks-ended-on-*`、`blueprint-wide-approval-*`、`blueprint-stage-*`、`blueprint-projects-archived-*`（项目页"已归档"不编号），`compare-*` 重新拼了（`compare-tasks-*` 里和设计稿的"01 等我"对得上）。

- 2026-10-11 完成：两轴评审无阻塞，建议（步骤号对比度、选中的已结束卡、去重、注释说法、标题剩一个字、导航件数盖住铃铛、日历失败点、"×"读屏）已改。用户定看板分组前照设计稿加"01 / 02 / 03"编号（只用 CSS 计数器），待我处理的"A·/B·"不加，"×"留着。共享代码没改。web 包 1617 条通过。压缩合并进 main。
