# 46 — 视觉风格"玻璃光纹"

Status: done
Blocked by: 76、77、60、83（用户 2026-10-11 定：其他票做完后集成这 9 套风格）
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI）"外观"

## What to build

在 39 号票搭好的风格底座上，加一套风格"玻璃光纹"，内部 id 是 `glass`。设计稿是 `docs/design/styles/` 里方案 E 那一行（`e-chat`、`e-tasks`、`e-inbox`、`e-wide`），说明见同目录的 README。

要点：磨砂玻璃面板、点阵底、电光蓝微光，Noto Sans SC 加 Chakra Petch 数字。磨砂玻璃用 backdrop-filter，不支持的浏览器退回半透明纯色，文字对比度不能靠模糊背景撑。

设计稿里画了个人助理名字的底色标签（43 号票），这套风格要覆盖名字标签的 token，画成设计稿里的样子。

## Acceptance criteria

- [x] 设置 · 外观 · 风格里多出"玻璃光纹"，选了立即生效，按设备记住（沿用 39 号票）。
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

- 2026-10-11 实现说明（46 号票子 agent，分支 `worktree-agent-a923e09b90b1ff615`，已变基到 main `5c46a0b9`）：
  - **做了什么**：照 `docs/dev.md`"加一套风格"加了风格 `glass`（玻璃光纹）。`packages/web/src/visual-styles/glass/style.ts` 是 token，`glass/style.css` 是 token 做不到的规则（全部 `:root[data-style="glass"]` 开头，浅深只靠 token 和 `light-dark()` 切），风格清单 `index.ts` 加 import 一行、清单一行（排在软糖圆角后面：经典、暖纸、格栅、夜航、软糖、玻璃）。设置 · 外观与风格里多出"玻璃光纹"，选了立即生效、按设备记住、浅深两张预览都是 39 号票的底座给的（预览里也是点阵底、玻璃卡片）。
  - **颜色**：取设计稿 `renderVals()` 浅深两套（`--bg #EEF1F8 / #0B0E1A`、`--text`、`--muted`、`--border`、`--accent #2457F5 / #7C9CFF`、`--accent-ink`、`--accent-soft`、`--warn #B8321A / #FF8A6A`、`--warn-soft`、`--code`、`--dot`、`--surface`、`--edge`、`--glow`）。电光蓝实色块（主按钮、你发的消息、分段选中的那段、导航的选中条、进度条、未读点）是 `primary-fill`，照设计稿原值；"要你"的事（等你验收、中断、超预算、上次失败、导航上的未读点）是 `you`（设计稿的 --warn）。设计稿没有的按同一套推：出错 / 拦下用深玫红 `#a8154f / #ff7aa8`（和"要你"的砖红分得开），命中关注类别（计划外、待处理……）琥珀 `#7d4b00 / #f3c06a`，通过绿 `#0f6431 / #5fd38d`；危险按钮 `#a8154f`（白字 7.28:1）。
  - **磨砂玻璃**：半透明的玻璃底（设计稿的 --surface：浅色白 74%、深色 72%）是 style.css 里的 `--glass-bg`，标题栏、详情页标题栏、导航（横栏、竖栏）、输入栏、个人助理的气泡和语音气泡、工具调用那一行、卡片和底板（`.card`）、看板卡、待办行、工单行、任务详情的状态行和页签、阶段抽屉 / 阶段栏、宽屏右边的详情栏用它，加 `backdrop-filter: blur(14px)`；亮边是 `card-border` token（设计稿的 --edge），微光是 `shadow-note` token（设计稿的 --glow）。token 里的 `surface` 写成不透明的（玻璃叠在页面底上的颜色 `#fbfbfd / #14192d`），给弹层、菜单、窄屏滑入的详情页、录音面板这些盖在内容上的东西用，底下的字不会透上来；标题栏底色 `bar-bg` 没写，沿用经典的 `var(--surface)`——标题栏是浮起的玻璃，看上去就是这个颜色，手机浏览器地址栏跟着它。点阵（`--glass-dot`，18px 一格、1px 的点）画在 `body` 上，App 外框、各栏透明，滚动的内容在静止的点阵上走。
    - **踩到的坑**：`backdrop-filter` 让元素成为 `position: fixed` 后代的包含块、自成层叠上下文。"发起任务"的弹层就画在标题栏里，看板卡（定时任务、定时作业的取消确认）、底板里也有确认弹层，会被关在那块玻璃里；待办行的"⋯"菜单会被后面的行盖住。做法：模糊只在认 `:has()` 的浏览器上开（`@supports selector(:has(*))`），里面开着弹层（`.modal-mask`）或菜单（`.row-menu`）的那块玻璃先不模糊；不认 `:has()` 的浏览器（Chrome 105、Firefox 121 以前）就是半透明纯色（票面允许的退回样子）。截图核对过发起任务弹层照常盖满全屏。dev.md"视觉风格"的规则一节补了一句，提醒以后的风格。
  - **对比度按最坏的底色算**（文字对比度不靠模糊撑）：直接压在页面上的字按点的颜色算（浅色下点 `#c6cde0` 比页面底深、深色下点 `#283052` 比页面底亮），玻璃上的字按"玻璃叠在点上"算（不支持模糊时就是这样：浅色 `#f0f2f7`、深色 `#1c223c`），玻璃上的浅底（输入框、代码块）再叠一层；状态药丸（字色 12% 的淡底）叠在"玻璃叠在点上"上算；小签、名字标签的淡底写成不透明的（`--accent-soft` / `--warn-soft` 叠在玻璃上的颜色），放在哪都一样。设计稿浅色的几个字色压在点上不到 4.5:1，沿色相压暗：`muted #566078 → #4d566c`（3.96 → 4.61）、当字用的电光蓝 `primary #2457f5 → #1e49ce`（3.52 → 4.56；主按钮这类实色块 `primary-fill` 照旧是 #2457f5，白字 5.59:1）、`you #b8321a → #a12c17`（3.76 → 4.57）；电光蓝字压在淡蓝底上设计稿是 4.20:1，压暗后 5.81:1。深色的设计稿颜色都够，没改。这些组合写成了测试 `packages/web/test/visual-styles/glass.test.ts`（点阵、玻璃的颜色从 style.css 里读，59 条，含语音播放条照 e-chat 的尺寸）；39 号票的 `contrast.test.ts`、`test/styles/name-tag.test.ts` 自动覆盖这一套，浅深都过。
  - **四个画面**：
    - 聊天：标题栏是一块浮起的玻璃（离边 12、圆角 16、68 高，"发起任务"电光蓝 44 高带淡蓝光）；时间挪到消息上面一行（Chakra Petch 11px）；个人助理的话是玻璃气泡、左上角收成 4，你的话是电光蓝块、右上角收成 4、下面一圈淡蓝光；语音气泡照 e-chat 的尺寸（42 号票的 `voice-*` token：内边距 12、播放键 30 的圆角方块、间隔 10、竖条 2 隔 3、个人助理一侧四周亮边左右合起来 2），你的播放键半透明白、个人助理的淡蓝底蓝三角，播放 / 暂停换成实心图标；审批卡：类型是淡蓝底蓝字的小块、标题另起一行、工具名一行灰字、命令一块等宽代码（宽屏排在同一行，照 e-wide）、命中的关注类别是中性细线签、理由是灰字、"拒绝 / 批准这一次" 1 : 1.4（宽屏靠右、最小宽 96 / 128）；输入栏是浮起的玻璃（附件细线框加号、切语音淡蓝话筒、切回文字细线框键盘、按住说话淡蓝长块）；名字标签照 e-* 的 `.name`：淡蓝底、蓝字、粗体、一圈蓝线（画成内描边，不占宽度；导航里的内边距照经典，竖栏两个字放得下；输入框占位里小一号 12px）。
    - 任务看板：一张张玻璃卡（圆角 14），分组标题粗字不上色、说明灰字、件数是电光蓝的 Chakra Petch；状态是 6px 小圆角的药丸（淡底跟着字色，字色照经典按状态的规则，所以运行记录 `run-st-*`、工单 `wo-*` 的颜色不受影响；设计稿里"运营中"是电光蓝、"排队中 / 已完成"是中性细线，这几种按 `.st.st-xxx` 改）；进度条细轨道、电光蓝带微光。
    - 待我处理：标题栏和页签画成一块玻璃（见下面共享代码），页签选中那段电光蓝实色块；分组说明灰字后面接一道细线；每一项一张玻璃，未读点电光蓝带微光、看过的是空心圈。
    - 宽屏：竖栏是浮起的玻璃（离边 16、圆角 20），选中那项淡蓝底，顶上"二狗"是电光蓝的 Chakra Petch；各栏的标题栏浮起；右边的详情栏（56 号票）整栏一块玻璃（照 e-wide 右边那一栏的样子）。
    - 其余页面按同一套 token 和规则推：任务详情（状态行、页签、窄屏阶段抽屉、宽屏阶段栏都是浮起的玻璃）、运行记录、工单、窄屏详情页、设置、外观与风格（含预览）、项目、日历、消耗、发起任务弹层、附件菜单、按住说话、360 宽、平板都截图看过。
  - **字体**：正文 Noto Sans SC（设计稿就是它，用的是净白格栅已装的 `@fontsource-variable/noto-sans-sc@5.3.0`，没新装）；数字（`--font-num`：时间、时长、看板件数、导航角标、消耗的统计数字、日历的日子、副标题）Chakra Petch 600，后面接正文字体。新装的只有 **`@fontsource/chakra-petch@5.3.0`**（npm 官方仓库，用户同意的那一个；风格里只引它的 `600.css`，拷进产物 4 片 woff2 共约 30 KB），**许可证 SIL Open Font License 1.1**（Copyright 2018 The Chakra Petch Project Authors，https://github.com/m4rc1e/Chakra-Petch），构建时拷到 `dist/fonts/fontsource-chakra-petch@5.3.0/LICENSE.txt`；Noto Sans SC 同为 OFL-1.1。只在选了这套时挂 `fonts/glass.css`：无头浏览器核对，经典打开秘书页、看板一片字体都不下；玻璃光纹下 Noto Sans SC 21 片、Chakra Petch 只有拉丁那 1 片。装法：worktree 里原来没有 node_modules（也没有指向主仓库的链接），在 worktree 里 `npm ci`，再 `npm install -D --save-exact @fontsource/chakra-petch@5.3.0 -w @ergou/web`，`package.json` / lockfile 只多这一项。
  - **和设计稿不一样的地方**（设计稿有、产品没有的不加；导航和页面上的信息、控件所有风格共用）：
    1. 标题下面的汇总小字（"10.07 WED · 秘书主线""5 等我 · 3 进行中 · 4 运营中""3 未读 · 2 卡着任务"）产品没有，不加；产品有副标题的（宽屏秘书页的"主线会话"）照设计稿排在标题下一行、Chakra Petch。
    2. 个人助理那一行设计稿是"[二狗] 08:00"（名字标签 + 时间），产品的消息只带时间（完整的名字 CSS 拿不到），只画时间。方案 E 没有字头像，"助理名字首字"不用。
    3. 标题里的名字：设计稿是"个人助理"四个字加一个 12px 的名字小标签；产品秘书页的标题本身就是名字标签（43 号票），按标题字号画（带蓝线），不缩成小标签。
    4. 审批卡右上角"卡住任务 · 有时限"产品卡片上没有，不加；"先问我"在产品里是小签那一排的一个签，类型标签只写"审批"。个人助理语音下面"语音回复 · 长按转文字"一行产品没有（展开转文字才有下半截），不加。
    5. 看板卡：设计稿状态药丸在标题行右边、进度条单独一整行、"3/3 阶段"在下面一行；产品的结构（种类签 + 标题一行，状态 + 进度 + token 一行，活动状态 + 项目签一行）是共享的，只换样子；设计稿件数写成"05"，产品是"7"；"不确定续期命令是否已执行"那行设计稿是砖红字，产品的这一行和别的灰字行同一种写法，照旧灰字。"最近结束"设计稿是降透明度 0.7，这里不降（灰字的对比度会掉），改成不浮起、不模糊、只留细线（用户第一批定的）。
    6. 待我处理每行说明里的种类（"提醒""审批"）设计稿是电光蓝；产品里种类、来源、时间是同一段文字，不拆就上不了色，没做。产品多的紧急度小方块、"⋯"菜单、浏览器通知那一行保留。列表左右留白设计稿是 16，这里是 10，行里左边 10、点和字隔 8、"⋯"收窄：照设计稿的话说明那一行比经典窄 30 像素，经典一行放得下的 9 条会折成两行（量过：现在 390 宽和经典一样只折 2 条，360 宽一样折 11 条，宽屏一样折 5 条）。
    7. 导航：名字照产品两个字（助理、待办），不是"个人助理""待我处理"；宽屏竖栏按导航的规矩（图标 + 两个字，43px），不加宽到设计稿的 96px，"二狗"14px。导航角标：设计稿是砖红实底的未读数；产品的数字是"看过没处理"（灰色，画成设计稿角标的 6px 小圆角方块、Chakra Petch），未读是砖红小点（带一点光）。
    8. 宽屏右边"待我处理 / 进行中"一栏产品的秘书页没有，不加；消息区照产品铺满（个人助理的话最宽 520、卡片最宽 560 照设计稿），输入栏照产品铺满整栏（设计稿 720）。宽屏按住说话设计稿是"按住 和 [二狗] 说"，产品的文案是"按住 说话"，照产品。
    9. 你发的语音照产品从右往左排（播放键在右，照微信），设计稿在左。输入栏产品多一个"发送"按钮，按主按钮的样子画。
    10. 设计稿原样打开时看板卡、待办行、分段、导航的样子不对：按钮的重置 `.root button{border:0;background:none;padding:0}` 特异度比 `.card`、`.row`、`.seg`、`.tab` 高，卡片的底色、边框、内边距和分段的圆角、导航的字号都被盖掉，画布上显示成平铺。按样式表的本意做成卡片（用户第一批定的）；对照截图里的设计稿也按本意画（截图脚本把这条重置降成 0 特异度）。
    11. 二级页（带返回键的，任务详情这类）标题 16px（设计稿只画了一级页的 18px）：浮起的标题栏比经典窄，任务详情的标题旁边还有阶段标签，18px 时 360 宽会截掉"家庭照片整理与去重"的尾巴；16px 和经典一样不截（量过 11 个页面 × 390 / 360 / 1280 宽被截的字：经典 0 处、玻璃光纹 0 处；发起任务弹层的分段一个都没截）。待我处理详情这类本来就长的标题经典也截，这里截得多一两个字。
  - **需要用户定的**：
    1. 浅色的字色为了"压在点阵的点上也有 4.5:1"沿色相压暗了（上面"对比度"一条）：当字用的电光蓝比设计稿深一档（#1e49ce，按钮、你的消息还是设计稿的 #2457f5），灰字、砖红也深一点。如果只要求压在页面底色上（不算点），设计稿原色就够（灰 5.56、蓝 4.94，玻璃上的砖红 5.34），可以改回去。
    2. 磨砂只在认 `:has()` 的浏览器上开（为了不把弹层关在面板里）；老浏览器是半透明纯色，看得出点阵透上来一点。
    3. 每张卡、每个气泡都开了 `backdrop-filter`（设计稿每块玻璃都有）。玻璃底下只是静止的点阵，模糊的效果就是"点阵在玻璃下面看不见"；如果鸿蒙真机上长列表滚动卡，可以只给标题栏、导航、输入栏开模糊，卡片用半透明纯色（看上去差别很小）。还没在真机上看过。
  - **改了的共享代码**：`packages/web/src/ui/common.tsx` 的 `TopBar` 加 `joined` 属性（挂 `data-joined`，经典不用），`pages/InboxPage.tsx` 待我处理的标题栏传 `joined`。原因：这套的标题栏是一块离边 12、圆角 16 的浮起玻璃，设计稿 e-inbox 里页签在同一块玻璃里；只靠 `.seg-head` 认不出它上面的标题栏（不能用 `+` 相邻选择器），标题栏得知道下面接着页签，才能去掉下半的圆角、边和外光。只补属性、不改结构。`docs/dev.md`"视觉风格"规则一节补了 `data-joined` 和 `backdrop-filter` 的提醒。**经典、格栅、暖纸、夜航、软糖表现不变的证据**：变基后同一台机器、同一套脚本，把这两个文件换回 main 的版本构建一份、本分支构建一份，聊天（底部、语音那段）、任务里的审批卡、看板、定时 / 提醒卡、待办、宽屏聊天 / 审批卡 / 看板 / 待办详情、运行记录、工单、任务详情，浅深各一，五套共 130 张逐像素比：127 张一样；另 3 张（软糖待办深色、经典语音深色、经典运行记录深色）两边各重截一次后全部一样——同一个构建自己截两次也差这么多（软糖浮起导航的模糊阴影、抗锯齿）。结果在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\pixdiff.txt`、`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\pixdiff-recheck.txt`，前后截图在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\base\`、`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\after\`。
  - **测试**：（变基到 main `5c46a0b9` 之后跑的）`npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts packages/web/test/state/voice.test.ts` 10 个文件 532 条通过（对比度、名字标签、字体、规则前缀、预览、内联脚本、语音尺寸都自动按新风格查了，加 `test/styles` 是 545 条）；web 包全部 73 个文件 1675 条通过（`ERGOU_TEST_WORKERS=2`，先等别的 agent 的 vitest 跑完才开）；守护进程 `test/main/fonts.test.ts`、`gateway.test.ts` 2 个文件 15 条通过（现场构建的产物里玻璃光纹的字体经网关取得到）；`npm run typecheck -w @ergou/web` 通过；oxlint 0 错误（1 条警告是原有的 `chat-look.test.ts`）。只改了 web，没跑全量。日志在 worktree 的 `test-web.log`、`test-daemon.log`（不进仓库）。
  - **截图**（构建产物 `file://` 原型模式、无头 Chrome、2 倍像素、不打网络，跟随系统按浏览器的浅深色切）在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\`：`glass-<画面>-<light|dark>.png`——390 宽的聊天 `chat`、语音 `chat-voice`（你的语音、个人助理的语音）、`chat-voicetext`（个人助理的语音展开转文字）、`chat-hold`（按住说话）、`chat-approval`（审批卡，在任务会话里）、`chat-card`（秘书会话里的卡片）、看板 `tasks`、`tasks-more`（定时 / 事件 / 提醒卡）、`tasks-ended`（最近结束）、待我处理 `inbox`、`inbox-detail`、运行记录 `runs`、工单 `orders`、任务详情 `detail`、阶段抽屉 `drawer`、窄屏详情页 `tooldetail`、设置预览 `settings`、发起任务弹层 `starttask`、附件菜单 `attach`、项目 `projects`、日历 `calendar`、消耗 `usage`、设置 `more-settings`、360 宽 `narrow360`、平板 `tablet`；1280 宽的 `wide`、`wide-voice`、`wide-approval`、`wide-tasks`、`wide-inbox`、`wide-runs`、`wide-orders`、`wide-settings`、`stage`（宽屏三栏：看板、任务、阶段详情）。同尺寸设计稿 `design-<chat|tasks|inbox|wide>-<light|dark>.png`（.dc.html 缺 support.js 打不开，`scripts\design.mjs` 转成普通 HTML、字体用本机的包），并排对照 `compare-<chat|tasks|inbox|wide>-<light|dark>.png`。脚本在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\scripts\`（`shots.mjs`、`design.mjs`、`compare.mjs`，`contrast.mjs` / `search.mjs` 算候选颜色，`probe.mjs` 量待办说明折行和发起任务弹层的分段截断，`cut.mjs` 量各页面被截的字，`fontload.mjs` 量下了哪些字体，`pixdiff.mjs`、`compare-base.sh`、`recheck.sh` 逐像素比对）。

- 2026-10-11 第二轮（评审意见和用户定的三条，同一个分支，已变基到 main `8e9eb085`：47 号票蓝图 `6f532765`、84 号票 `71991645`、48 号票贴纸便当 `1e47e43b` 都在下面；风格清单按 A–H：经典、暖纸、格栅、夜航、软糖、玻璃、蓝图、贴纸）：
  - **用户定的三条**：
    1. 浅色为了"压在点阵的点上也有 4.5:1"压暗的字色保留（当字用的电光蓝 `#1e49ce`、灰字 `#4d566c`、砖红 `#a12c17`）。
    2. 老浏览器（不认 `:has()` 或不认 `backdrop-filter`）没有模糊、只有半透明底，接受。
    3. **磨砂只给标题栏、导航、输入栏**：卡片、气泡、看板卡、待办行、任务详情的状态行和页签、宽屏详情栏这些改成不透明的底色，不开 `backdrop-filter`。
  - **磨砂范围（用户定的第 3 条）**：半透明的 `--glass-bg` 加 `blur(14px)` 只剩标题栏 `.topbar`、详情页标题栏 `.detail-bar`、和标题栏接成一块的页签 `.seg-head`（算标题栏的一半）、导航 `.tabbar` / `.siderail`、输入栏 `.composer`。别的面板换成不透明的 `--surface`（`#fbfbfd / #14192d`：设计稿的玻璃色叠在页面底色上，看上去和原来几乎一样），亮边、微光照旧，不开 `backdrop-filter`：个人助理的气泡和语音气泡、工具调用那一行、待办行、工单行、任务详情的状态行和页签、阶段抽屉 / 阶段栏、宽屏右边的详情栏；卡片 `.card` 和看板卡 `.bcard` 的底色本来就是 `--surface`，现在玻璃光纹不再改它们的底色，只加微光。`:has()` 只剩一条 `.topbar:has(.modal-mask)`（"发起任务""新建项目"的弹层画在标题栏里）：输入栏里没有弹层（斜杠菜单、长按菜单经 `.popup-layer` 画在外面，附件菜单是普通的绝对定位，不受影响），导航里也没有。`style.css` 开头写明这是一份白名单、以后在开了模糊的面板里放弹层要补进去；`docs/dev.md` 那句提醒跟着改了。待办行打开"⋯"菜单时不再闪一下点阵（行不模糊了，原来的 `.inbox-row:has(.row-menu)` 删了）。
  - **阻塞 1（经典按类型、状态的底色被盖掉）**：删了 `.wo-divider > span` 的玻璃底，会话里的工单分隔线（计划色淡底）和定时任务的运行分隔线（`.wo-divider.run-divider`，绿色淡底）照经典；看板卡不再改底色，`.bcard-static`（提醒卡、定时作业卡：经典是 surface 70% 混页面底）照经典。把玻璃光纹里所有改底色、字色、边框色的规则逐条和经典按类型、状态改这几样的规则对了一遍：
    - 另外修了三处：附件 `.attach` 改了底色，经典"作为材料投喂"`.attach-material`（data-bg）、"上传失败"`.attach-failed`（high-bg）的底色被盖掉，写成 `.attach.attach-xxx` 补回；待办行现在有底色，选中的 `.inbox-row.on` 补回经典的"电光蓝 10%"（叠在 surface 上）；宽屏详情栏同时挂着 `.pane`（开头把各栏刷透明那条），底色写回 `--surface`。
    - 原来就按 `.st.st-xxx`、`.tool-sum.tool-sum-stopped / -you`、`.xcard-tag.xt-xxx`、`.bcard.on`、`.voice-hold.voice-cancel` 写回经典的照旧。运行记录 `run-st-*`、工单 `wo-*`、日历 `cal-st-*` 的字色玻璃光纹没碰。
    - 结束了的看板卡（"最近结束"、归档）照用户第一批定的不浮起、透明、只留细线；已触发的提醒卡（`bcard-static`）也在"最近结束"里，同样透明：经典里它比普通卡暗一档（往页面底色混），普通卡已经透明（等于页面底色），再混还是透明。
    - **照设计稿有意改的经典颜色**（不是被盖掉，第一轮也写了；用户想照经典可以改回，每条一两行 CSS）：(a) 看板"等我"那组的标题经典是砖红，设计稿粗字不上色；(b) 审批卡里命中的关注类别 `chip-op` 经典是琥珀小签，设计稿是中性细线签；(c) 审批卡里的理由 `.sys-note` 经典是"系统查到的"浅绿底、左边一道线，设计稿是灰字；(d) 卡片类型标签默认经典是砖红（等你），设计稿淡蓝底蓝字（计划类的计划色、进展 / 通知的中性照经典）；(e) 任务状态药丸"运营中"设计稿是电光蓝（经典绿），"排队中 / 已排期 / 已完成 / 已取消 / 已归档 / 已暂停"设计稿是中性细线（经典排队、已排期是琥珀，完成是绿）；(f) 页面内容里的分段（消耗的时间段、模型的思考档、外观……）经典带一圈细线，这里是浅底不带线。
    - 这些淡底上的字另算过对比度（浅 / 深，用玻璃光纹的颜色）：工单分隔线 正文 15.39 / 12.01、灰字 6.56 / 5.67；运行分隔线 13.86 / 11.77、5.91 / 5.56；提醒卡 16.20 / 15.30、6.91 / 7.22；选中的待办行 14.20 / 12.67、6.06 / 5.98，电光蓝字 5.98 / 5.71。
  - **阻塞 2（按住说话按下时对比度不够）**：按下时改成电光蓝实色块 + 主按钮上的字（`primary-text` 压在 `primary-fill` 上），浅色 5.59:1、深色 7.38:1；`contrast.test.ts` 的"主按钮上的字"就是这一对。截图 `glass-chat-holdactive-<light|dark>.png`（给按钮挂上按住时的类名，不真的录音）。
  - **建议 3**：白名单写在 `style.css` 开头（见上面"磨砂范围"）。
  - **建议 4（分段只按两处浮起）**：照夜航仪表，分段默认是一块浅底（页面里、弹层里的都一样），只有 `.chat-col > .seg`（任务详情的页签，直接排在一栏里）浮起成不透明的面板，`.seg.seg-head`（待我处理）和标题栏接成一块玻璃；原来"默认浮起、再按 `.page-pad` / `.detail-body` / `.modal` / `.appearance-choice` 一处处排除"那一串删了。
  - **建议 5**：`ui/common.tsx` 里 `TopBar` 的 `joined` 和 `Segmented` 的 `head` 两处注释都写明要成对传、只传一边会怎样；`docs/dev.md` 同样写上。
  - **建议 6（测试不再各抄一份颜色算法）**：抽到 `packages/web/test/visual-styles/color.ts`（`luminance`、`contrast`、`over`：半透明叠在不透明上，直接用 `resolveColor` 的算法），`contrast.test.ts`、`test/styles/name-tag.test.ts`、`glass.test.ts` 都引它，删了原来各自的副本（前两个只换引用，断言没动）。
  - **建议 7**：`--glass-glow` 改回设计稿 `--accent-soft` 的原值（浅色 `rgba(36,87,245,0.12)`、深色 `rgba(124,156,255,0.16)`），注释写"原值"。
  - **建议 8（浮起的标题栏下面滚动内容被硬切）**：选了滚动区顶上一道 14px 的渐隐，没选"标题栏背景铺满整宽"：设计稿的标题栏离边浮起、四周露出点阵，铺满会把两边的点阵盖掉，离设计稿更远。会话（`.zh`，不滚动、`position: relative`）挂绝对定位的 `::before`；页面的滚动区（`.scroll`、详情页的 `.detail-body`）挂 sticky 的 `::before`，用负外边距抵掉它占的位置，内容一像素不挪（停在最上面时盖住的只是上内边距）。渐隐层画的是页面底（底色 + 点阵，`background-attachment: fixed` 和整页的点阵对齐，看不出有一层），用 mask 从上往下淡掉，不接点击；宽屏右边详情栏里画 `--surface`。会话的上内边距是 16，渐隐 14，停在最上面时第一条不被盖。滚到一半的卡片、气泡现在是淡进点阵里，不再在标题栏两侧留一道硬边。
  - **`glass.test.ts`**：按"磨砂只给标题栏、导航、输入栏"改：玻璃上的字（含 `--nav-on`）、玻璃上的浅底、状态药丸仍按"玻璃叠在点上"算；新加"面板底 `--surface` 和各种小签的底是不透明的"（放在点阵上、玻璃上都一样，字和底由 `contrast.test.ts` 查）。浅深各 30 条，加语音播放条尺寸 1 条，共 61 条。
  - **共享代码这一轮**：`ui/common.tsx` 只改注释；`test/visual-styles/color.ts` 新文件，`contrast.test.ts`、`name-tag.test.ts` 改成引用它；`docs/dev.md` 改两句。没有新加 class / data 属性。
  - **前后逐像素对照（含蓝图）**：同一台机器、同一套脚本，`ui/common.tsx`、`pages/InboxPage.tsx` 换回 main 的版本构建一份、本分支构建一份，经典、暖纸、格栅、夜航、软糖、蓝图 6 套 × 13 个画面（聊天底部、语音那段、审批卡、看板、定时 / 提醒卡、待办、宽屏聊天 / 审批卡 / 看板 / 待办详情、运行记录、工单、任务详情）× 浅深，共 156 张逐像素比：154 张一样；另 2 张（夜航语音深色差 19 个像素、夜航任务详情浅色差 3 个像素）两边各重截一次后一样——是本分支那次截图自己的抖动（本分支同一个构建截两次也差这么多，main 截两次一样）。收尾时 main 合进了 48 号票，再变基后贴纸便当同样 13 个画面 × 浅深 26 张比：25 张一样；聊天浅色那张 main 第一次截的和它自己再截的就不一样（第一张截图时字体还没就绪），两边各重截两次后全部一样（`pixdiff-sticker.txt`、`pixdiff-sticker-recheck.txt`）。结果在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\pixdiff.txt`、`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\pixdiff-recheck.txt`，前后截图在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\base\`、`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\after\`。
  - **测试**：`npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts packages/web/test/state/voice.test.ts packages/web/test/styles` 11 个文件 670 条通过；web 包全部 73 个文件 1805 条通过（`ERGOU_TEST_WORKERS=2`，开跑前查过进程列表没有别的 vitest）；守护进程 `test/main/fonts.test.ts`、`gateway.test.ts` 2 个文件 15 条通过；`npm run typecheck -w @ergou/web` 通过；oxlint 0 错误（1 条警告是原有的 `chat-look.test.ts`）——都是变基到 `8e9eb085`、`npm ci --offline` 装齐 48 号票的字体之后跑的。日志在 worktree 的 `test-web.log`、`test-daemon.log`（不进仓库）。
  - **截图**：整套重截，`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t46\glass-<画面>-<light|dark>.png` 共 84 张；新加 `chat-holdactive`（按住说话按下去）、`runs-chat`（定时任务的会话，绿色的运行分隔线）。设计稿并排对照 `compare-<chat|tasks|inbox|wide>-<light|dark>.png` 重新拼了。

- 2026-10-11 完成：两轴评审的阻塞（运行分隔线、`.bcard-static` 等经典底色被盖掉，按住说话按下时对比度不够）和建议（`:has()` 白名单写明、分段只浮起两处、`joined` 和 `head` 成对传、颜色算法抽成测试公共文件、淡蓝光照设计稿、滚动内容顶部渐隐）已改。用户定：浅色压深的字色保留、老浏览器没有磨砂接受、磨砂只给标题栏 / 导航 / 输入栏（卡片气泡改不透明底，手机滚动不卡）。几处照设计稿有意改的经典颜色（"等我"组标题、审批卡的关注类别签和理由、卡片类型标签、几种状态药丸）按"照设计稿"保留，列在上面。共享代码只改注释和 `TopBar` 的 `joined`（第一轮）、新增测试公共文件。经典等七套 182 张截图前后一致。web 包 1805 条通过。压缩合并进 main。
