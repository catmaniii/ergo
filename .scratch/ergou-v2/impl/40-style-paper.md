# 40 — 视觉风格"暖纸手帐"

Status: done
Blocked by: 76、77、60、83（用户 2026-10-11 定：其他票做完后集成这 9 套风格）
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI）"外观"

## What to build

在 39 号票搭好的风格底座上加一套风格"暖纸手帐"（内部 id `paper`）。设计稿是 `docs/design/styles/` 里方案 A 那一行（`a-chat`、`a-tasks`、`a-inbox`、`a-wide`），说明见那里的 README。

要点：Noto Serif SC 宋体、米纸底、墨绿印章色、1px 细边卡片、小圆角、圆形字头像（头像里的字用助理名字的第一个字，见 43 号票；43 还没合并时先用二或者现有头像）。

## Acceptance criteria

- [x] 设置 · 外观 · 风格里多出"暖纸手帐"，选了立即生效，按设备记住（沿用 39 号票）。
- [x] 按设计稿还原四个画面：聊天（文字气泡、语音气泡、审批卡、输入栏）、任务看板、待我处理、宽屏。浅色、深色都要。其余页面按同一套 token 和规则推。
- [x] 设计稿里出现了产品没有的信息或控件，不加，写进 Comments。
- [x] 字体按 39 号票的办法由二狗自己提供，只在选了这套时加载；许可证写进 Comments。
- [x] 39 号票的对比度测试覆盖到这一套，浅色、深色都达标。
- [x] 只动这套风格自己的文件和风格清单里的一行。必须改共享代码的，写进 Comments 并说明原因。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 40、41、42 三张票并行做，各加一套，冲突点只在风格清单。收尾前变基到最新 main。
- 怎么加一套风格，见 `docs/dev.md` 里 39 号票写的说明。

## Comments

- 2026-10-10 暂缓：用户定风格先只有两套，这张票后续再做。

- 2026-10-11 取消暂缓：用户定其他票（76、77、60、83）做完后集成 78 号票的 9 套视觉风格。

- **实现**（2026-10-11）：
  - **风格清单**加一行 `paper`（`src/visual-styles/index.ts`）；`src/visual-styles/paper/style.ts` 是 token、名字"暖纸手帐"、一句话"宋体、米纸底、墨绿印章色，细边卡片像手帐"、字体；`paper/style.css` 是限定在 `:root[data-style="paper"]` 下的规则。设置 · 外观与风格里自动多出这一格（浅深两张预览自动有），选了立即生效、按设备记住，都是 39 号票的底座。
  - **token**：颜色照设计稿 a-* 的 `renderVals()` 浅深两套——`bg/surface/border/text/muted` 原样；墨绿 `--accent` 是 `primary`、`you`（等我、问你、卡片的类型标签），`--accent-ink` 是主按钮上的字，`--accent-soft` 是 `you-bg`（头像底、竖栏选中底）；你发的消息 `--user`；设计稿审批卡上的赭石小签（`--warn-soft` 底、`--warn` 字）是 `op-bg/op-fg`（命中关注类别的小签），未读点 `badge` 也是赭石；`fill` 是设计稿的 `--code`（代码块、小签、表单输入框；聊天输入框按设计稿用米纸底，写在 style.css）。设计稿没画到的颜色按纸面补齐：出错 `high-*` 砖红（和赭石分开）、危险按钮砖红、数据小签靛蓝灰、结果色（通过绿、拉回青、退回紫）、内容类型色（墨绿、赭黄、灰紫、豆沙）、名字标签墨绿"印章"。字体 `font-body` 是 Noto Serif SC（设计稿全篇一个宋体，标题、数字沿用正文）；字号阶只改 `fs-title` 22（设计稿 h1）；圆角卡片 8、按钮 6、小签 4、弹层 12；阴影只压一层淡暖灰；`space-page` 16、`space-msg` 18、`bar-h` 64（放得下 22 号标题和 44 高的按钮）；`card-border`、`panel-border` 都是 1px 细边。没有新 token。
  - **规则**（只放 token 做不到的）：
    - 聊天：个人助理的话不套气泡，直接排在纸上；**圆形字头像**（30px 圆、浅绿底、墨绿粗宋，字是名字的第一个字）在秘书会话里每一句话（回复、语音）前面，想法、工具调用行、卡片都往右让出头像那一列（设计稿审批卡也在这一列里）；时间挪到话上面一行小字（设计稿"二狗 · 08:00"的位置，你发的也在上面靠右）；你发的消息墨绿块、圆角 16 右下收成 4；日期分隔线两边细线中间日子（设计稿的"今天"）；语音气泡：播放键在半透明的圆里、波形高 20 不发灰，个人助理的语音是细边白纸、播放键和波形墨绿、时长灰；想法、工具调用左边那道细成 2px。
    - 输入栏：附件、语音键是 44 的圆形细边按钮，换成设计稿的线条图标（加号、话筒、键盘，CSS mask，按 `data-to` 认）；输入框胶囊形、米纸底；"发送"胶囊；按住说话是墨绿细边的浅绿胶囊、粗字。
    - 卡片：类型标签是一行墨绿粗小字（不铺底），标题另起一行；命令是工具名一行、下面一块纸色代码块（宽屏排在同一行）；拒绝是细边按钮、批准是墨绿实色块（1.4 倍宽），44 高；宽屏按钮靠右、最小宽 96 / 128；卡片里的原因说明灰字。
    - 任务看板：一张张细边白纸卡片（内边距 12×14、圆角 8），分组标题 16 号粗宋、说明灰、件数在右边不铺底；状态前面一个 7px 小圆点（等我、执行中、运营中墨绿，规划中、排队中、已完成灰，排队的是空心，失败砖红）；最近结束的淡到 0.82。
    - 待我处理：标题栏下面的页签是下划线页签、平分一行，和标题栏合成一个头（只在最下面一道线）；分组标题灰字后面接一道细线；每一条一张细边卡片，未读赭石实心点、读过空心细圈，标题 15 号半粗。
    - 通用：标题栏的"发起任务"（和别的主按钮）是墨绿细边按钮、44 高；"全部标已读"墨绿粗字；页签都是下划线；次要按钮细边；小签圆角 4。
    - 导航：线条图标（设计稿那一套，CSS mask，按 `data-nav` 认）；底部横栏每项 56 高、选中墨绿、名字下面一个 4px 小圆点；竖栏顶上"二狗"墨绿、选中的那一项铺浅绿底。
    - 设置里这套风格的预览：场景固定 200×280，按真尺寸的 56 高横栏、44 高按钮排不下整张卡片，用只在预览 shadow root 里选得中的 `.preview-page` 收紧一点（页面上不影响）。
  - **其余页面**（项目、日历、设置、外观与风格、消耗、任务详情和阶段栏、宽屏的看板 / 待我处理分栏）按同一套 token 和规则推，浅深都截图看过。
- **设计稿里有、产品没有的，没加**：标题下面那行副标题（"10 月 7 日 · 周三 · 秘书主线"、"5 件等我 · 3 件进行中"、"3 条未读 · 2 条卡着任务"；宽屏标题旁边照产品的"主线会话"）；宽屏右边的"待我处理 / 进行中"一栏；每句话上面的"二狗 · "（只留时间）；审批卡右上角"卡住任务 · 有时限"；个人助理语音下面"语音回复 · 长按转文字"一行（产品里展开转文字才有下半截）；设计稿导航上赭石实底白字的未读数"3"（产品是灰色的"看过没处理"件数加赭石小点，含义不同，照产品）；设计稿的强调色可选（赭石、靛蓝），只有墨绿一种。
- **产品有、设计稿没画的，留着按同一套样子画**：标题栏的活动状态和 ▤ 缩放、名字标签（43 号票）、输入栏的"发送"、看板卡上的类型签 / 进度条 / 活动状态 / 项目小签、待我处理每行的"⋯"菜单和紧急度小方块（"卡住任务"那种改成赭黄，免得和"有时限"的砖红、未读的赭石点混在一起）、"允许浏览器通知"提示、审批卡上的"先问我"小签和原因那一块"系统查到的"浅绿底（look.css 的两种声音）。
- **和设计稿不一样的地方**：
  - **看板、待我处理是细边卡片**：设计稿源码里这两处的条目写成 `.card` / `.row`（surface 底、1px 边、圆角 8、内边距），但同一份源码里 `.root button { border: 0; background: none; padding: 0 }` 特异度更高，画布上实际显示成没有框的平铺列表（离线照原样画出来的设计稿截图也是平铺的）。票面和 README 写的是"1px 细边卡片"，按源码的意图做成了卡片。要改成画布上那样的平铺，只动 style.css 里 `.bcard`、`.inbox-row` 几条。
  - 导航结构照 43 号票：两个字的名字（"助理""待办"）、竖栏 43px、提示叠在图标右上角（设计稿竖栏 96 宽、"个人助理"四个字、"待我处理"两行）；竖栏顶上的"二狗"设计稿 22 号，43px 里放不下，用 16 号。
  - 宽屏会话区的宽度照产品（设计稿主栏最宽 760 再加右栏）；个人助理的话、卡片最宽 560（设计稿 520–560）。
  - 你发的语音：播放键在右边（产品照微信从右往左排），设计稿在左；波形照产品一格 2px（格数由 `state/voice.ts` 按尺寸算，换成设计稿的 3px 宽 3px 间隔会截掉三分之一）；播放键的圆 26（设计稿 28）：`state/voice.ts` 按 16 宽的图标算格数，圆加宽后最后一两格被截掉（69 号票"放不下就截掉尾巴"兜着），没改 `state/voice.ts` 的常数。
  - 待我处理每行说明里的类型（"提醒""审批"）设计稿是墨绿粗字；产品里它和来源、时间是同一段文字，不拆出一个元素就上不了色，没做。
  - 头像里的字：默认名字"个人助理"是"个"，设计稿画的是"狗"（二狗），照 43 号票用名字的第一个字。只在秘书的会话里画：任务、项目维护者的会话里说话的不是个人助理（话照样不套气泡）。
  - 名字标签的浅色底 #d6e3d7 比设计稿头像的浅绿 #e6ece4 深一档：#e6ece4 和米纸底只差 1.06 倍，`test/styles/name-tag.test.ts` 要 1.15 倍才看得出是个标签。
- **对共享代码的改动**（字头像要用名字，CSS 拿不到；不改结构）：
  - `ui/conversation/Conversation.tsx`：会话外层 `.conv` 加 `data-mode`（`secretary` / `maintainer`），秘书的会话挂内联自定义属性 `--assistant-initial`（名字第一个字的 CSS 字符串），风格用 `content: var(--assistant-initial)` 画字头像；维护者的会话不挂。经典、净白格栅不用这两个，样子不变：改前改后经典、净白格栅的聊天、看板、待我处理、宽屏 × 浅深 16 张截图逐像素一样。
  - `state/assistant-name.ts` 加纯函数 `assistantInitialCss(名字)`：按字（码点）取第一个字，表情不拆开，引号、反斜杠、控制字符按 CSS 字符串转义；测试在 `test/state/assistant-name.test.ts`（8 条）。
  - `docs/dev.md`"视觉风格"一节"可以给现有元素补 class 或 data 属性"那句补上 `.conv` 的 `data-mode` 和 `--assistant-initial`，以后的风格（比如水墨国风的印章）也能用。
  - `packages/web/package.json`、`package-lock.json`：加字体依赖（下一条）。
- **字体**：`@fontsource-variable/noto-serif-sc@5.3.0`（npm 官方仓库，用户同意装的那一个，没装别的包），devDependencies 写死版本、lockfile 一起改；在本 worktree 里 `npm ci` 后 `npm install -D --save-exact … -w @ergou/web`。可变字体一套切片覆盖 200–900（设计稿用 400/600/700）。构建时插件照抄包里的 `@font-face`，生成 `dist/fonts/paper.css`（约 100 KB），101 片 woff2 和许可证拷进 `dist/fonts/fontsource-variable-noto-serif-sc@5.3.0/`（6.0 MB）。只在选了暖纸手帐时挂：无头浏览器核对，秘书页下 20 片约 1.27 MB，再把看板、待我处理、项目、日历、设置、消耗翻一遍累计 22 片约 1.33 MB；选经典时秘书页、看板一片都不下；设置 · 外观与风格为预览多下的从 1 片变成 2 片（预览那几个字在 Noto Serif SC 里的一片约 57 KB，`preview.css` 1.8 KB → 3.5 KB）。没下好时先用 `--font-body` 后面的系统宋体（Songti SC、STSong、SimSun）。
- **许可证**：Noto Serif SC 是 SIL Open Font License 1.1（Google / Adobe；fontsource 包的 license 字段 OFL-1.1），允许随软件分发；全文随字体拷到 `dist/fonts/fontsource-variable-noto-serif-sc@5.3.0/LICENSE.txt`，`fonts.test.ts` 查它在。
- **对比度**（`contrast.test.ts` 的表格自动覆盖这一套，浅 / 深全部 ≥ 4.5:1）：正文对页面底 13.3 / 14.1、对卡片 12.5（输入框）/ 13.7；说明文字对页面底 5.25 / 6.7、对卡片 5.8 / 6.0；你发的消息 6.1 / 8.4；主按钮 6.1 / 8.75；链接、导航选中、等我 6.0 / 8.4；跟你有关的小签 5.1 / 6.5；命中关注类别的小签 5.2 / 6.4；出错的字 6.65 / 7.6、出错小签 5.5 / 6.9；通过 6.2 / 8.3；数据小签 6.9 / 7.5；危险按钮 6.8；名字标签 6.35 / 6.5（标签底和页面底、卡片底 1.17 / 1.30，深色 1.46 / 1.30）。设计稿原来的颜色本来就都过线，没调。
- **测试**：`npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts`（对比度、字体、规则前缀、预览、内联脚本自动按新风格查）加 `test/state/assistant-name.test.ts`、`test/styles` 共 9 个文件 275 条通过；web 包全部（`ERGOU_TEST_WORKERS=2 npx vitest run --project web`）69 个文件 1374 条通过；守护进程 `packages/daemon/test/main/fonts.test.ts`、`gateway.test.ts` 15 条通过（现场构建的产物里暖纸手帐的字体经网关取得到）；`npm run typecheck` 通过；oxlint 0 个错误（1 个 warning 是 `chat-look.test.ts` 原来就有的）。这票只改 web，没跑全量。
- **截图**（无头 Chrome 开构建产物 `file://`，原型模式，localStorage 选上 `paper`，没起服务、没碰 8810/8811）：`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t40\`。`对照-{chat,tasks,inbox,wide}-{light,dark}.png` 是产品和设计稿左右（宽屏上下）对照；单张的 `paper-*-{light,dark}.png`：`chat`（秘书页最新）、`chat-voice`（滚到你发的语音和问答卡）、`chat-approval`（任务会话里的审批卡：原型里审批卡只在任务「家庭照片整理与去重」的会话里）、`tasks`、`inbox`（390 宽），`wide`、`wide-voice`、`wide-approval`（1280 宽），`settings`（外观与风格，带三套风格的浅深预览）；`design-*-{light,dark}.png` 是设计稿：`.dc.html` 是设计画布的格式，打不开，用脚本取出 `<helmet>` 的样式和 `<x-dc>` 的结构、按 `renderVals()` 填浅深两套值离线画出来（Google Fonts 换成本机同一个字体包，不联网）。

- **2026-10-11 评审后修改**（主会话转来的 8 条；用户定：看板、待我处理用卡片，照现在的做法）：
  1. **最近结束的卡片**不再整张淡到 0.82（浅色下卡里的灰字只剩约 3.96:1，对比度测试只查 token、查不到透明度）：改成不铺白纸底、只留细边，标题不加粗；字的颜色不变，灰字对米纸底 5.25:1（深色 6.7:1）。用户定接受。
  2. **和经典一样的 token 删掉**：`radius-xs`（4px）、`user-text`（白）、`card-border`（1px 细线），注释里写明沿用经典。
  3. **首字**：状态层 `assistantInitialCss` 换成 `assistantInitial(name)`，用 `Intl.Segmenter` 取第一个字素簇（国旗、零宽连接符拼的组合表情、带组合附加符号的字母都算一个字），没有 `Intl.Segmenter` 时退回按码点取（这几种只取到第一个码点）。写成 CSS 字符串挪到界面层 `ui/conversation/conversation-root.ts`（`cssString`、`conversationRootProps`，`Conversation.tsx` 的 `.conv` 用它）。测试：`test/state/assistant-name.test.ts` 新加 16 条（字素簇 11 条、退回码点 5 条）；组件级 `test/ui/conversation-root.test.ts` 10 条（React 在 Node 里渲染 `.conv` 的属性：秘书的会话有 `data-mode="secretary"` 和 `--assistant-initial`，维护者的会话只有 `data-mode`，一个 style 都不带；CSS 转义 7 条）。`docs/dev.md` 名字一节列 Web 状态函数的地方补上 `assistantInitial` 和界面层的 `conversationRootProps`。
  4. **设置里的预览**：`.preview-page` 那三条规则去掉（预览被挡由 42 号票做共用的修法，用户定），`docs/dev.md` 不加新约定。顺带底部横栏不写死 56 高，靠内边距撑（有名字时还是约 56）。语音气泡放大到设计稿尺寸由 42 号票改共用的波形算法时一起改，这票不动。
  5. **`.topbar + .seg` 换成 class**：`Segmented` 加 `head` 属性，挂 `.seg-head`（现在只有待我处理用），`ui/common.tsx`、`pages/InboxPage.tsx` 各补一处，不改结构；`docs/dev.md`"视觉风格"那句补上 `.seg-head`。导航和输入栏的线条图标合成一条规则（都读 `--paper-icon`），不再写两遍 mask。
  6. **看板卡上两个同色点**：留状态前面那个（设计稿只有它），下面一行活动状态（"等你""休眠"……）在这套风格里不画点，字照旧。
  7. **补记**：设计稿那条 `.root button { border: 0 … }` 也吞掉了 a-inbox 页签的下划线（`.seg` 的 2px 下边框被压掉，`.seg.on` 只剩换颜色），画布上看不到选中页签的下划线；实现照源码的意图做了墨绿下划线。上一轮写的名字测试"8 条"不对，实际是 9 条（这一轮整组换成了上面的 16 条）。
  8. **原型补了一条个人助理的语音**（`prototype/fake-conversations.ts`，秘书主线 07:59；消息 id 写死，不打乱后面消息的编号；带 `agent_voice` 事件：整段念、合成好了，长按"转文字"展开原文），截了浅深两张：收着的、展开转文字的。
  - **经典、净白格栅没变**：原型数据不变时，经典、净白格栅的聊天、看板、待我处理、宽屏 × 浅深 16 张逐像素一样（这一轮的 `.seg-head`、`conversation-root.ts`）；加上原型那条语音之后，经典的聊天、宽屏各有十来个像素的抗锯齿差别（会话变长，滚到底的位置差了不到一个像素），样子没变。
  - **测试**（变基到 `81b98144` 之后）：`npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts` 加名字的两份（`test/state/assistant-name.test.ts`、`test/ui/conversation-root.test.ts`）共 9 个文件 285 条通过；web 包全部（`ERGOU_TEST_WORKERS=2 npx vitest run --project web`，先确认没有别的 vitest 在跑）70 个文件 1391 条通过；`npm run typecheck` 通过；oxlint 0 个错误（1 个 warning 是 `chat-look.test.ts` 原来就有的）。日志在本 worktree 的 `test-web.log`、`typecheck.log`、`oxlint.log`（不进仓库）。
  - **截图**重截了（同一个目录）：`paper-chat-agent-voice-{light,dark}.png`（个人助理的语音，收着）、`paper-chat-agent-voice-text-{light,dark}.png`（展开转文字）、`paper-tasks-ended-{light,dark}.png`（最近结束的卡片），其余 `paper-*` 和 `对照-*` 也按这一版重截（`对照-chat-*` 的第一张里有了助理的语音）。设置里暖纸手帐的预览底下又被横栏挡住一截，等 42 号票的共用修法。

- 2026-10-11 完成：两轴评审无阻塞，建议（已结束卡片对比度、和经典同值的 token、首字按字素簇、去掉预览专用规则、相邻选择器换成补的 class、两个同色点、原型补助理语音）已改。用户定看板、待我处理用卡片（设计稿画布上的平铺是样式冲突造成的）；看得清的改动接受；地址栏颜色、语音气泡放大、预览被挡由 42 号票做共用改动。共享代码加了"助理名字首字"（`.conv` 的 `data-mode`、`--assistant-initial`），以后的风格可用。web 包 1391 条通过。压缩合并进 main。
