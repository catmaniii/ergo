# 42 — 视觉风格"软糖圆角"

Status: done
Blocked by: 76、77、60、83（用户 2026-10-11 定：其他票做完后集成这 9 套风格）
Spec: [第一阶段规格](../spec.md) 第 19 节（Web UI）"外观"

## What to build

在 39 号票搭好的风格底座上加一套风格"软糖圆角"（内部 id `candy`）。设计稿是 `docs/design/styles/` 里方案 D 那一行（`d-chat`、`d-tasks`、`d-inbox`、`d-wide`），说明见那里的 README。

要点：ZCOOL 快乐体标题（正文不用它）、大圆角、浮起的胶囊导航和输入栏、紫罗兰加珊瑚红未读。浮起的胶囊导航要和 33 号票的导航自适应（放不下的收进"更多"）照常配合。

## Acceptance criteria

- [x] 设置 · 外观 · 风格里多出"软糖圆角"，选了立即生效，按设备记住（沿用 39 号票）。
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

- 2026-10-11 实现说明（42 号票子 agent，分支 `worktree-agent-af945dafb6cc2d6e9`，已变基到 main `b29bf5c1`；评审后再变基到 `04a2bf4f`）：
  - **做了什么**：照 `docs/dev.md`"加一套风格"做。新建 `packages/web/src/visual-styles/candy/style.ts`（token、名字、字体）和 `candy/style.css`（token 做不到的规则，全部 `:root[data-style="candy"]` 开头），风格清单 `index.ts` 登记（import 一行、`VISUAL_STYLES` 一行，排在净白格栅后面）。设置 · 外观与风格里多出"软糖圆角"，选了立即生效、按设备记住、浅深两张预览都是 39 号票的底座自动给的，没为它写界面代码。
  - **颜色**：取设计稿 `renderVals()` 浅色、深色两套（`--bg`、`--surface`、`--border`、`--text`、`--muted`、`--accent`、`--accent-ink`、`--accent-soft`、`--warm`、`--warm-soft`、`--code`）。紫罗兰是强调色、主按钮、你发的消息（深色下浅紫底深紫字）；"跟你有关的"（等你、要你批准）和未读是珊瑚红。对比度不够调了两处：`--you` 浅色 `#c93a26` → `#bd3421`（压在淡珊瑚底上 4.3 → 4.8:1）；名字标签底色设计稿的淡紫 `#ece7ff` 和页面底色亮度差只有 1.08（名字标签测试要 1.15），加深到 `#ddd5ff` / 深色 `#3a3070`，字 `#3f22c9` / `#ddd6ff`。设计稿没有的按同一套推：出错、拦下用偏玫红的 `#b8204f` / `#ff8db0`（和珊瑚红分得开）；命中关注类别的小签（`op-*`）用珊瑚红，和设计稿审批卡上"删除或覆盖"一样；想法的类型色换成长春花蓝（经典的紫和"你说的"紫撞色）；危险按钮浅深都是 `#bd3421`（白字 5.7:1）。
  - **字体**：标题 ZCOOL 快乐体（新装 `@fontsource/zcool-kuaile@5.3.0`，写进 `font-title`，正文不用它）；正文 Noto Sans SC（设计稿的正文字体，沿用 39 号票已装的 `@fontsource-variable/noto-sans-sc`，没新装）。快乐体只有 400 一种字重，用到标题字体的地方（页面标题、看板分组、卡片类型、弹层标题、空状态、竖栏的"二狗"）都不加粗；小号的分组说明（待办分组、详情小节、标题旁的副标题）不用快乐体（设计稿只给大标题用）。按 39 号票的办法只在选了这套时加载，按 unicode-range 只下用到的字；设置页的预览只多下快乐体一片 18 KB。
  - **规则**：标题栏不是白条，落在淡紫底上，26px 快乐体大标题（带返回键的二级页 21px），"发起任务"是浮起的紫色胶囊；按钮一律胶囊，次要按钮淡紫底紫字；分段切换是浮起的胶囊、选中那段紫色实心。**导航**：图标换成设计稿的圆头线条图标（按 `data-nav`），当前那一项淡紫胶囊；底部横栏浮成白色胶囊（左右 12px、下面 12px 加安全区）；宽屏竖栏浮成竖着的胶囊，宽度照旧按"图标 + 两个字"算（右边框留着位置、颜色透明）。**和 33 号票的自适应照常配合**：导航条的可用长度和量长度的样本 tab 都在浮起的胶囊里、用同一套样式，360 宽时"日历"收进"更多"（截图里看到了），390 宽六项放得下。**聊天**：个人助理的话是白气泡、你的是紫气泡，大圆角 22、带小尖角、柔和投影，不要经典的左边竖线；语音气泡同样的圆角投影，播放键放进圆里（你的半透明白圆、个人助理的淡紫圆），波形用紫色；输入栏是浮起的白色胶囊，附件是淡紫圆钮、切语音 / 文字是紫色圆钮（线条话筒 / 键盘图标），输入框无框，"按住 说话"是淡紫长胶囊。**审批卡等卡片**：白底大圆角浮起；类型标签换成 17px 快乐体小标题，前面一个 40px 圆形图标（按卡片类型换：审批 / 工具包变更是盾牌、提问是问号、计划类是文档、提醒是闹钟、配对是手机、进度类是闪电，别的星星；要你拍板、会删改东西的珊瑚红圆，别的淡紫圆），标题另起一行；命令单独一块浅底圆角等宽字；两个按钮胶囊、确认的宽一点，宽屏会话里靠右按字宽（设计稿 d-wide）；处理过的卡不浮起、描细线、圆变灰。**任务看板**：一张张白色浮卡，分组标题快乐体，件数在浮起的小胶囊里；状态改成小胶囊（要你的珊瑚红、规划中 / 执行中 / 运营中紫罗兰、失败玫红、别的灰）；结束、归档的不浮起、描细线。**待我处理**：一行一张白色浮卡，未读的点挪到右边（珊瑚红、白边、细红圈，照设计稿），看过的不浮起、描细线；分组说明一律灰字（设计稿如此，经典按紧急度上色）。**其余页面**按同一套 token 推：宽屏的列表栏、详情栏、窄屏滑入的详情页、任务详情的状态行都落在淡紫底上，`.card` 底板浮起；设置、项目、日历、消耗、发起任务弹层、附件菜单、阶段抽屉都看过（截图在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\work\`）。
  - **阴影**：`shadow-*` 四个 token 写成一个字符串 `0 8px 24px light-dark(紫色半透明, 黑色半透明)`（浅深几何一样，只换颜色），构建时 Lightning CSS 照样降成跟着 color-scheme 切的开关变量（查过产物 CSS 里没有 `light-dark(` 留下，`build.test.ts` 也查）；这套风格自己的 `--candy-soft`（淡紫底）、`--candy-lift`（卡片投影）挂在 style.css 的根上。
  - **和设计稿不一样的地方**（产品里没有的不加；导航和页面上的信息、控件是共享结构，风格只换样子）：
    1. ~~个人助理每条消息左边的"狗"字圆头像：产品没有，不加。~~ 评审后加了（40 号票合进来共用的"助理名字首字"，见下面评审后的修改）。
    2. 待我处理每一行左边按类型的圆形图标、标题旁的"3 未读"红胶囊：产品没有（类型在每行的说明文字里），不加。
    3. 宽屏右边那一栏（"待我处理""进行中"两块列表）：产品的宽屏秘书页没有，不加。宽屏导航设计稿是 200px 宽、图标和名字横排、"二狗"28px 的面板；产品竖栏的结构和宽度（图标在上两个字在下、按字号算宽度）所有风格共用，只做成浮起的竖胶囊。
    4. 导航上待办的提示：设计稿是珊瑚红实心数字胶囊（未读数）；产品是 43 号票定的"看过没处理的灰色数字 + 有未读时一个小红点"，只换了样子（灰色小胶囊、珊瑚红点）。导航名字产品一律两个字（"助理""待办"），设计稿写全名。
    5. 审批卡：设计稿类型下面一行灰字"先问我 · 卡住任务 · 有时限"、"通用 bash"是紫色小签、理由是灰字；产品卡上是标题（任务 · 阶段 · 做什么）、工具名、命令、关注类别小签加"先问我"小签、理由是"系统直接查到的"浅绿条（look.css 规矩 3），照产品的信息排，只换样子。类型前的圆形图标是装饰（和类型标签同义），产品每种卡都有类型，就按类型都配了。
    6. 看板卡：设计稿的状态胶囊在标题行右边，产品的状态在第二行（结构共享），胶囊留在原位；"9.6 万 token"在设计稿里是灰底小胶囊，产品里那一段没有类名，不加（不按结构位置硬挂样式）。"最近结束"的卡设计稿是透明度 0.8，这里不降透明度（灰字的对比度会掉到 4.5 以下），改成不浮起、描细线。
    7. 输入栏：产品比设计稿多一个"发送"按钮（紫色胶囊），保留。
    8. ~~语音气泡：播放键的圆 30px（设计稿 36）、波形竖条 2px（设计稿 4px）~~（评审后按设计稿改成 36、4，见下）——`state/voice.ts` 按经典的尺寸（左右内边距 + 竖线 29、图标 + 两处间隔 32）算波形画几格，放大了会把波形尾巴截掉；这里左右内边距 9 + 9、圆 30、间隔 6 + 6 合起来 60，守在 61 以内。你发的语音播放键在右边（产品照微信从右往左排）。产品原型里没有个人助理发的语音，截图里那条是照你那条在页面上克隆出来的（只为看样子）。
    9. 标题栏：个人助理的名字在标题里是带底色的名字标签（43 号票要求；设计稿是纯字）。**手机浏览器地址栏的颜色**按 39 号票的机制取 `--surface`（白 / `#221c3f`），而这套的标题栏落在淡紫底上，两者不一致：要一致得改共享的 `stylePageInfo`（比如加一个"标题栏底色"token、经典给 `var(--surface)`），没改，留给主会话定。（评审后用户定了：加共用 token `bar-bg`，已改，见下）
    10. 设置里的预览：这套留白大，预览框里那张卡的两个按钮被浮起的导航挡住（像会话往上滚了一截），按 39 号票的约定没为预览单写规则。（评审后做了共用的修法：预览场景贴底，见下）
    11. 快乐体自带拉丁字母，标题里的英文和数字（"按天（token）"这类）也是快乐体的样子。
    12. 设计稿本身的小毛病：`.root button{font:inherit;padding:0}` 压过了 `.tab`、`.card` 的字号和内边距，直接渲染出来导航字是 15px、看板卡没有内边距；产品按它明显的本意做（导航字 11px，卡片内边距 14 / 16）。
  - **改了的共享代码**：（第一轮）没有。只动了 `candy/style.ts`、`candy/style.css`、`visual-styles/index.ts`（import 一行、清单一行）、`packages/web/package.json`、`package-lock.json`。评审后按用户定的改了几处共用代码，见下。
  - **字体许可证**：`@fontsource/zcool-kuaile` 5.3.0（npm 官方仓库），SIL Open Font License 1.1（Copyright 2018 The ZCOOL KuaiLe Project Authors，https://github.com/googlefonts/zcool-kuaile），允许分发；构建时许可证拷到 `dist/fonts/fontsource-zcool-kuaile@5.3.0/LICENSE.txt`。包解压 4.5 MB，拷进构建产物的是 93 片 woff2 共 1.2 MB，页面只下用到的那几片。正文的 `@fontsource-variable/noto-sans-sc` 5.3.0 同为 OFL-1.1（39 号票已装）。装法：worktree 里原来没有 node_modules 链接，直接在 worktree 里 `npm ci`，再 `npm install -D --save-exact @fontsource/zcool-kuaile@5.3.0 -w @ergou/web`，只多了这一个包。
  - **测试**：`npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts packages/web/test/styles` 8 个文件 262 条全过（对比度表格里软糖圆角浅色、深色 36 条，名字标签 2 条）；web 包全部 69 个文件 1366 条全过（`ERGOU_TEST_WORKERS=2`）；守护进程 `test/main/fonts.test.ts`、`gateway.test.ts` 2 个文件 15 条全过；`npm run typecheck -w @ergou/web` 通过；oxlint 0 错误（1 条警告是原有的 `chat-look.test.ts`）。
  - **截图**（构建产物 `file://` 原型模式、无头 Chrome、2 倍像素，不打网络）在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\`：`candy-{chat,approval,tasks,inbox}-{light,dark}.png` 是 390 宽（chat 是秘书会话滚到语音那一段，approval 是任务「家庭照片整理与去重」会话里的审批卡），`candy-{wide,wideapproval}-{light,dark}.png` 是 1280 宽；`design-{chat,tasks,inbox,wide}-{light,dark}.png` 是同样尺寸的设计稿（.dc.html 要设计画布的 support.js 才开得了：`design.mjs` 把 helmet 里的样式和标记取出来、按 renderVals() 填浅深两套值、字体换成构建产物里的本地字体后截的）；`compare-*.png` 是两者拼的对照图（手机宽度左右并排、宽屏上下叠）。`work` 子目录里还有其余页面（设置、外观与风格的预览、项目、日历、消耗、宽屏看板 / 待办 / 任务详情、360 宽、平板）和发起任务弹层、附件菜单、语音输入、阶段抽屉、详情页的截图。脚本 `shots.mjs`、`design.mjs`、`compare.mjs`、`extra.mjs` 在同一目录。

- 2026-10-11 评审后的修改（42 号票子 agent；变基到 main `04a2bf4f`，40 号票暖纸手帐已合进来；风格清单按 A 暖纸、B 格栅、D 软糖排：经典、暖纸手帐、净白格栅、软糖圆角；`package.json` / lockfile 取 main 的再重跑 `npm install -D --save-exact @fontsource/zcool-kuaile@5.3.0 -w @ergou/web`）：
  - **共用改动一：地址栏颜色跟标题栏一致**（用户定）。加 token `bar-bg`（标题栏底色，`tokens.ts`；经典 `var(--surface)`），`.topbar`（`styles/base.css`）、详情页的 `.detail-bar`（`styles/detail.css`）的底色改用它；地址栏颜色按它取（`visual-styles/page.ts` 的 `stylePageInfo`，`app/theme.ts` 和 `index.html` 内联脚本的风格表都是这张表，构建时填进去）。经典是 `var(--surface)`，没写它的风格（净白格栅、暖纸手帐）沿用经典的写法 = 各自的 `surface`，表现不变；软糖圆角写 `var(--bg)`（标题栏落在淡紫底上，地址栏也是淡紫），style.css 里原来把标题栏刷透明的那条删了。`test/app/theme.test.ts` 改成按 `bar-bg` 比对，加一条"经典、净白格栅的 `bar-bg` 就是 `surface`"；对比度表格加"标题栏上的字"（`text` 对 `bar-bg`）。dev.md"地址栏颜色"、token 一节写了。
  - **共用改动二：语音气泡的框宽、波形格数按风格的尺寸算**（用户定：按设计稿放大）。播放条的尺寸挪成 6 个 token（`voice-pad` 左右内边距、`voice-line` agent 一侧的边线、`voice-key` 播放键宽、`voice-gap` 间隔、`voice-bar` / `voice-bar-gap` 波形竖条和间隔，只能写像素），经典的值就是原来 `styles/voice.css`、`state/voice.ts` 里写死的（13、3、16、8、2、2）。`voice.css` 改用这几个 token；`state/voice.ts` 加 `VoiceBarSizes`、`BASE_VOICE_BAR`（经典）、`voiceWidthIn`，`voiceWave`、`voiceBubbleLook`、`agentVoiceBubbleLook` 多一个尺寸参数（不传是经典的）；新文件 `visual-styles/voice.ts`（`voiceBarSizesOf`：风格的 token 换算成数）；`ui/conversation/VoiceBubble.tsx` 按现在这套风格取（`pageTheme().style()`，换风格立刻跟着变）。算法：随时长的宽度（76–236）按经典定，减去经典的边（61）是波形那一段、各风格一样长；框宽 = 这套风格的边 + 这一段 + 时长，波形按这套风格的竖条放得下几格画几格。软糖圆角照 d-chat：播放键 36 的圆、间隔 10、竖条 4 隔 3、内边距 12（设计稿播放键一侧 10、另一侧 14，取 12）、没有竖线——框比经典宽 19；暖纸手帐照 a-chat：28 的圆、间隔 10、竖条 3 隔 3、内边距 12、四周 1px 细边算 2——宽 13（改了 `paper/style.ts` 加 6 个 token、`paper/style.css` 播放键的宽改走 token、波形高 22）。测试：`test/state/voice.test.ts` 加"播放条的尺寸按风格"一组（不传尺寸和原来一样、大尺寸的框宽和格数、边加波形加时长放得进框里），新文件 `test/visual-styles/voice.test.ts`（经典的 token = `BASE_VOICE_BAR`、每套风格都写成像素、软糖圆角照设计稿）。dev.md token 一节、"同框"一条写了。
  - **共用改动三：设置里的预览贴底**（用户定）。`styles/pages.css` 的 `.preview-page .conv-scroll` 加 `justify-content: flex-end`：放不下时裁掉的是最上面那条，所有风格的预览都看得到卡片和它的两个按钮。截图核对：经典、净白格栅完整，暖纸手帐第一条气泡顶上裁掉一点，软糖圆角两条气泡被裁掉、卡片和两个按钮、导航都在（`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\work\candy-previews-light.png`）。dev.md"设置里的预览"写了。
  - **共用改动四（评审 4）**：`ui/common.tsx` 的 `TopBar` 带返回键时在 `.topbar` 上挂 `data-back`（只补属性、不改结构，经典不用它）；软糖圆角二级页标题小一号改按它认（原来靠兄弟顺序 `.icon-btn + .title`）。dev.md"规则"一条写了。
  - **经典、净白格栅表现不变的证据**：同一台机器、同一套脚本，先把 main `04a2bf4f` 的 `packages/web` 检出到 worktree 构建截图，再换回本分支构建截图，逐像素比对（`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\pixdiff.py`，结果 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\pixdiff.txt`）：经典、净白格栅的聊天（底部、滚到语音那段）、任务里的审批卡、看板、待办、宽屏聊天 / 语音 / 审批卡、任务详情、设置、详情页（`.detail-bar`）、宽屏详情、发起任务弹层，浅色深色共 52 张**逐像素相同**；暖纸手帐的聊天、审批卡、看板、待办、宽屏、详情页、弹层也相同。不同的只有：三套的"外观与风格"页（预览贴底、清单里多了软糖圆角，本来就要变），暖纸手帐的语音气泡（照 a-chat 放大，本来就要变）。前后对照在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\base\`、`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\after\`，暖纸手帐语音的前后另拷在 `C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\paper\`。
  - **秘书会话的圆形字头像**（40 号票共用的"助理名字首字"：会话外层 `.conv[data-mode="secretary"]` 上的 `--assistant-initial`）：照设计稿 d-chat，36 的紫罗兰圆、快乐体、名字的第一个字（默认名字"个人助理"就是"个"），只在秘书的会话（维护者的会话没有）；回复、语音的头像贴着底（和时间一行），卡片的贴着顶；这一列都往右让 46。上面"和设计稿不一样"第 1 条划掉了。
  - **评审建议逐条**：1. 删掉和经典一样的 `nav-on`、`radius-pill`（`nav-on` 改成 `var(--data-fg)`：选中的导航是淡紫胶囊上的深紫字，这一对在对比度测试里）。2. `--candy-soft` 删了，淡紫底一律用 `var(--data-bg)`，上面的字一律 `var(--data-fg)`（次要按钮、`.st-running` 这类状态、选中的导航、按住说话、附件钮、卡片类型的圆、`.menu-item.on`；`data-fg` 对 `data-bg` 浅色 6.6:1、深色 7.6:1，测试里有）；`.voice-hold-off` 不再单独写灰字，跟着按住说话的深紫字；`--candy-lift`、`--candy-lift-s` 删了，统一用 `shadow-note`（改成设计稿的 `--shadow` 原值）；画图标的 mask 声明合成一条，图标是风格自定义属性 `--candy-icon`。3. style.ts 注释的数字照实（`--you` 4.82:1、`danger-fill` 白字 5.71:1）。4. 见上面共用改动四；阴影 token 的 `light-dark()` 写法 dev.md token 一节补了一句。5. 发起任务弹层里"只提醒我"不再被切：分段每段改成能收窄到字宽（`flex: 1 1 auto`）、左右内边距 10；待办行的说明：未读的点挪到卡片右缘正中（绝对定位，不占说明那一行的宽度），看过的细线框改成内描边，行尾"⋯"字靠左、右边留出点的位置，列表左右留白 12——量过（`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\probe.mjs`）：经典是一行的说明，软糖圆角也都是一行（说明那一行给 318 像素，最长的 313）；经典自己就折行的那一条（"授权到期续期 · …"）照样折。6. 紧急度拉开："有时限"（`high-fg`）改成偏紫的玫红 `#b0185f` / `#ff8cc0`，"卡住任务"（`op-fg`）改成琥珀 `#9a5800` / `#f5b45a`（底 `#fff1dc` / `#3a2a12`），"要你"的珊瑚红不动——三种一眼分得开，对比度都过（命中关注类别的小签跟着变琥珀，和设计稿审批卡上的珊瑚红不一样，为了和"有时限"分开）。
  - 用户定的另外两件照做：看板、待我处理一行一张卡片（不平铺）；已结束卡片不降透明度、几处颜色调深保留。
  - **测试**：`npx vitest run packages/web/test/visual-styles packages/web/test/app/theme.test.ts packages/web/test/build.test.ts packages/web/test/styles packages/web/test/state/voice.test.ts packages/web/test/state/agent-voice.test.ts packages/web/test/state/agent-voice-segments.test.ts` 12 个文件 407 条全过；web 包全部 71 个文件 1478 条全过（`ERGOU_TEST_WORKERS=2`，先等别的 vitest 跑完）；守护进程 `fonts.test.ts`、`gateway.test.ts` 15 条全过；`npm run typecheck -w @ergou/web` 通过；oxlint 0 错误（1 条警告是原有的 `chat-look.test.ts`）。
  - **截图**重截了：`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\candy-*.png`（聊天这回截的是原型里真的那条个人助理语音，40 号票加的；不再在页面上克隆）、`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\compare-*.png`、`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t42\work\`（预览、发起任务弹层、详情、秘书会话里卡片的头像 `candy-seccard-light.png`）。

- 2026-10-11 完成：两轴评审无阻塞，建议（和经典同值的 token、淡紫底改用有对比度测试的 `data-bg`、注释数字、相邻选择器换成 `data-back`、两处截断、紧急度颜色拉开）已改。用户定看板 / 待我处理用卡片、看得清的改动接受，并把三项共用改动交给本票：地址栏颜色跟标题栏（新 token `bar-bg`）、语音气泡尺寸按风格算（`voice-*` token，软糖、暖纸照设计稿放大）、设置里的预览贴底；40 合并后照设计稿加了秘书会话的字头像。经典、净白格栅、暖纸 66 张截图前后逐像素一致（只有预览页和暖纸的语音气泡按意图变了）。代价：关注类别小签为了和"有时限""卡住任务"分开变成琥珀色，和设计稿的珊瑚红不同。web 包 1478 条通过。压缩合并进 main。
