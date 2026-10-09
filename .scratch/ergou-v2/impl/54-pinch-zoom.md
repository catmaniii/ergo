# 54 — 一镜到底缩放：双指捏合，三档吸附

Status: done
Blocked by: 52（会话条目层）
Spec: [第一阶段规格](../spec.md) 第 19 节"会话区照搬 AgentSense"的缩放；调研 `docs/research/15-agentsense-zoom-detail-task-modes.md` §1、§5.1、§6.1 的 T2、§6.3

## What to build

照搬 AgentSense 的会话缩放，用户要求"几乎一模一样"。

- **手势**：同一份会话内容整体缩放。手机上双指捏合；电脑上 Ctrl/⌘ + 滚轮，触控板捏合也走这条路；标题栏另有 ▤ / 💬 切换按钮。以两指中点下的那一点内容为锚。
- **档位**：松手后在对数空间吸附到最近一档，共三档：
  - 1：对话层，完整内容；
  - 0.45：要点层，每条都在，各缩成一行；
  - 0.15：全局层，色块。

  每条的矩形形状不变，矩形里显示的东西随比例在三层之间交叉淡入淡出。
- **缩小之后**：输入框淡出，换成一条图例。点缩小的某一条，放大回去并闪一下。
- **滚动**：跟随最新消息、往上翻加载更早的一页，都要和缩放共存。缩小状态下滚到顶，照样取更早的一页，锚点保持不动。
- **范围**：秘书、任务、项目三处会话都换上，包括秘书的普通对话。
- **去掉旧的**：25 号票的分段按钮、`GistLayer`、`GlobalLayer`。
- **页面缩放**：不再用浏览器自己的缩放（`user-scalable=no`），免得和会话区的捏合抢手势。

## Acceptance criteria

- [x] **先出原型，停下等评审**：先做一版用假数据、能捏的原型，照 02 号票的做法，可以放在原型页面里。做完**停下回报**：由主会话请用户在手机和电脑上试过、确认后，再接真数据。
  - 用户的修改意见按需求变更处理。
  - **和 AgentSense 不一致的地方一律先问，不许自己简化。** 25 号票就是把捏合简化成了分段按钮，用户不满意。
- [x] **代码来源**：
  - `zoom.ts`、`usePinch.ts` 原样搬（调研 §1.8：共 243 行，和业务无关），注明来源。
  - `ZoomHistory.tsx` 里通用的骨架照搬，其余按二狗的条目（52 号票）改写。
- [x] **单元测试**：缩放的数学部分，包括 `levelOf`、`layerOpacity`、吸附、锚点公式。
- [x] **三处会话都换上**：秘书、任务、项目，去掉 25 号票的分段按钮和两套单独的层渲染。25 号票要点层、全局层要标出的东西照样标出；两侧标注做完整是 55 号票的事，本票至少不丢信息。
- [ ] **手势不冲突**：
  - 双指捏合和"按住 说话"的单指手势不冲突；双指落在输入框上的情况也要试过。
  - 页面不再被浏览器缩放。
- [x] **性能**：量一下 500 条时捏合的帧率，写进 Comments。太卡的话，远处的条目按 AgentSense 的思路降级。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 新加的元素一律用 token，39 号票之后各套风格都要能覆盖。
- 宽屏、窄屏的分栏不变。详情页在 56 号票。
- 锚点、详情按条目 id 存，查找一律用 `locateChatItem`，不直接按 id 比对（52 号票：一组调用跨两页时，翻回更早的一页之后组的 id 会变）。
- 全局层按只看、动手、删除给工具调用分深浅（AgentSense 的 `natureOf`），52 号票没做，留给本票：二狗的工具调用 part 里没有"只读"这类信息，要么协议里加，要么按工具名和"删除或覆盖"类别近似，先问用户。

## Comments

2026-10-09 第一步：原型（子 agent，分支 `worktree-agent-a0e9666c0722ff732`）。停在这里等用户评审，三处会话还没换。

- **怎么打开**：`npm run build:web`，浏览器直接打开 `packages/web/dist/index.html#/proto/zoom`（宽于 760 时原型工具条上有"缩放原型"；窄屏从"更多 · 原型 · 会话缩放"进）。标题栏下拉挑五段假会话：助理主线、任务「家庭照片整理」、项目「记账本」、往上翻分页的长会话（120 轮，打开时只有最近 50 条消息）、一次全部加载的约 500 条；右边是帧率读数和 ▤ / 💬。
- **代码**：
  - `ui/zoom/zoom.ts`、`ui/zoom/usePinch.ts` 原样搬（AgentSense 提交 99656b5），差别写在文件头：缩进；`noUncheckedIndexedAccess` 要的几个 `!`；lint 不许渲染时写 ref，usePinch 的回调改在 `useLayoutEffect` 里写。
  - `ui/zoom/ZoomHistory.tsx`：通用骨架照搬（三层 DOM、两个 ResizeObserver、跟随最新、捏合接线、点缩小的条放大并闪、`zoomTo` / `reveal`、报告焦点、长条缩影、右侧标注的排版和箭头、图例）。没搬的：分支和回退、同类操作折叠（二狗用工具调用组）、阶段框、固定计划虚线框；底色带、书脊、左侧任务卡、×N 归 55 号票。
  - 二狗加的：往上翻分页和缩放共存（任何一档滚到顶都取更早一页，缩小状态下停稳时已在顶上也取；锚点按条目 id 存、用 `locateChatItem` 找，取视口里那一条的下沿，组跨页并上更早的调用时下沿不变）；日期分隔线、"加载更早的消息"、"正在回复…"在对话层，缩小后淡出、位置照留；空会话的说明里写怎么缩小（照 AgentSense 的 `zoomOutHint`）。
  - `ui/conversation/ZoomConversation.tsx`：新的会话组件（第二步换掉三处的 `Conversation`）；`ChatItemView.tsx`：对话层按 52 号票的条目画，样子照原来的 part 渲染（聊天区精简是 57 号票）。
  - 右侧标注（`ui/zoom/marks.tsx`）：先把 25 号票要点层、全局层的要点一条不少地标上（样式的说法、命中的类别、通用 bash、结果、审批批了没有、验收结论、记录种类），颜色按 AgentSense 的 r-high / r-op / r-fix / r-data。箭头指到对话层里那一次调用、那张卡（`data-mark`）。
  - 只看 / 动手 / 删除：`state/tool-nature.ts`，**临时按做法二**（工具名 + "删除或覆盖"类别近似），等用户定；工具调用组取组里最重的。
  - 页面不再被浏览器缩放：`index.html` 加了 `maximum-scale=1.0, user-scalable=no`。
  - 按住说话时又落下第二根手指：这一段丢掉不发（`VoiceSession.abort()`），免得双指落在输入框上捏合时发出一段录音。AgentSense 没有语音，这是二狗加的。
  - 样式在 `styles/zoom.css`，只用 token：字号、圆角、间距用 39 号票已有的（`fs-*`、`radius-*`、`space-msg`、`on-color`……），缩放自己的六个颜色登记在风格清单里（`visual-styles/tokens.ts` 的 `zoom-*`，经典的值在 `classic/style.ts`），各套风格可以覆盖。
- **测试**：`test/ui/zoom.test.ts`（38 例：`levelOf`、`layerOpacity`、吸附、锚点公式、对数空间插值、点条放大的滑动、CSS 变量、跨档通知）；`test/state/tool-nature.test.ts`（15 例）；路由 1 例；语音 1 例。界面测试配置另起 `tsconfig.ui-test.json`（缩放控制器写的是 HTMLElement，要 DOM 类型；别的测试照旧不带 DOM）。
- **性能**（无头 Chrome，本机，帧率上限 100；每帧一个 Ctrl + 滚轮事件，缩到全局再放回来）：17 条 100 帧/秒；497 条一开始 36 帧/秒（p50 30 ms），主要花在右侧标注排版边量边写反复重排、以及变量变了整棵对话层重算样式。改了两处，算法和样子都不变：标注先量完再一起写（→ 57 帧/秒），对话层下面一层把缩放变量定死、样式重算停在 `.zi-l0`（→ 约 74 帧/秒，p50 10 ms，p90 20 ms）。没做远处条目降级（AgentSense 也没有）。手机上的帧率请用户看页面右上角的读数。
- **待用户定 / 和 AgentSense 不一致的**：见主会话的回报（只看 / 动手 / 删除的两种做法，任务会话里 ▤ 是否像 AgentSense 里程碑会话那样只在缩小后出现，等等）。

2026-10-09 用户的三个决定，以及在等原型评审时先做的守护进程那一块（同一分支，新提交）：

- **只看 / 动手 / 删除由守护进程判定**，记在每次工具调用上：
  - 协议：工具调用 part 加可选字段 `nature`（`TOOL_NATURES`：`look` / `act` / `delete`，`TOOL_NATURE_LABEL`），向后兼容。前端协议版本不变。宿主协议不升到 12：在守护进程这一侧按守卫的判定算，子进程不用多报什么。
  - 守卫：`guard/nature.ts` 的 `toolNature(input, judgement)`，按这次判定实际要判的调用（通用 bash 拆成的伪工具调用）取最重的。删除是时序规则里 `$current.paths[].replaced` 为真的那些，就是 rule-steps 原来的定义：删除路径、带"删除或覆盖"标签的工具、整体重写已有的文件；不知道在不在的不算。只看看工具登记的 `lookOnly`（注册表新字段，和"只读或幂等"分开）、只读的 HTTP 请求、通用 bash 里只看的命令（`READ_ONLY_COMMANDS`）。其余是动手。`tool-call-record.ts` 写进 part；判定出错的没有。
  - 标了 `lookOnly` 的：`read`、`ls`、`grep`、`find`、`git_status_diff`、`network_read`（带数据的另算动手），代为执行的 `view_board`、`list_inbox`、`read_attachment`、`search_materials`、`read_project_records`、`summarize_receipts`。
  - **按守卫的口径，`mv` 也算删除**：源路径是"删除"访问，和"删除或覆盖"类别一致。
  - 前端 `state/tool-nature.ts` 先用 `part.nature`，旧记录退回按工具名估（只看名单补齐了上面那些代为执行的工具）。
  - 测试：`packages/daemon/test/guard/nature.test.ts`（36 例：直接调的工具、通用 bash、被拦下的）；主切面 `timeline.test.ts` 断言每次调用的 `nature`。重录了 `timeline-zoom`：落盘事件不变，临时事件里 `activity_progress` 9 → 8，多了 45 号票的 2 条 `voice_models`；工具调用都带上了 `nature`。Web 的 `tool-nature.test.ts` 回放它断言三组的性质。
- **整个覆盖一个已有的文件算删除**：守卫这边原来就是这个口径，前端估的时候"删除或覆盖"类别也算删除。
- **▤ 按钮照搬 AgentSense**：任务会话在对话层不显示，缩小后才出现；秘书和项目会话一直显示。原型页的"任务"那段先改了，三处会话换上时照做。

2026-10-09 用户又改了分法：删除和修改合成一类，叫**删改**，按"动没动原来就有的东西"分（同一分支，新提交）。

- **和 AgentSense 不一样**：AgentSense 最深的一档（绿加一圈红）只有删除；二狗这一档是删改，局部改、整个覆盖已有的文件、移动或改名、丢弃 git 改动、强推都在里面。用户定的。
- **三类**：
  - 只看：什么都不改，规则不变。
  - 动手：只新增、不碰已有的。新建文件、追加写、建目录、提交、不强推的推送、发消息、跑测试或构建、装依赖、跑脚本，以及拆不开的 bash 命令。
  - 删改：改了或去掉了原有的东西。局部改已有的文件（`edit`、`sed -i`）、整个覆盖已有的文件、删除、移动或改名（`mv` 原来要单独问用户，这样就定了）、丢弃 git 改动、强推。代为执行的工具里，改提醒、取消提醒、自行调整计划、写回进展（整份换掉原来的 progress.md）算删改；增减 skill 去掉了 skill 时算删改，只加算动手。
- **协议**：取值 `delete` 改名为 `modify`（中文名"删改"）。上一个提交没合进 main，守护进程没写出过 `delete`，所以直接改名，不用兼容。
- **守卫**：
  - 文件在不在仍然看执行前查到的情况；查不清的按新建算动手。
  - 工具注册表的 `lookOnly` 换成 `nature: "look" | "modify"`，另加 `modifiesWith`（给了这些参数就算删改：`git_push` 的 `force`、`adjust_skills` 的 `remove`）。
  - bash 的 `>>`、`&>>`、`tee -a` 拆出来的改文件调用多带一个 `append: true`，追加写据此算动手。效果日志里这几种调用的参数会多这一项，守卫判定不受影响。
- **旧消息按工具名估**：`edit`、命中"删除或覆盖"类别的（整个覆盖已有的文件、删除、移动都命中它）、名字像 delete / remove 的、上面四个登记成删改的代为执行工具、带类型的推送参数摘要里有 `force=true` 的，算删改。通用 bash 不拆，一律动手。
- **图例、颜色**：`n-delete` 改成 `n-modify`，token `zoom-delete-ring` 改成 `zoom-modify-ring`，样子不变；图例写"工具调用（只看 / 动手 / 删改）"。
- **原型**：假数据的每次工具调用都带上 `nature`，照守护进程会记的写。长会话里加了局部改文件、`sed -i`（删改）和 `cat … | grep … | wc -l`（只看）；任务那段加了一条只看的 bash。在无头浏览器里核对过：长会话缩到全局层，删改的组有红圈，图例写的是删改；任务那段对话层没有 ▤，项目那段有。
- **测试**：守卫 `nature.test.ts` 46 例，加了局部改、追加、`tee`、`sed -i`、强推、增减 skill、注册表里只看的工具只有读路径；Web `tool-nature.test.ts` 的旧记录估法补到 23 例。`timeline-zoom` 不用重录：这段流程里没有删改的调用，取值没变。

2026-10-09 变基到 main `fe302b07`（39、62、58、63、56 号票之后），缩放接上 56 号票的详情页。改动在第一个提交（原型）里，三处会话仍然没换：

- **冲突**：`main.tsx` 两份样式都引入（`zoom.css` 在 `detail.css` 前面）；守卫 `index.ts` 两边的导出都留；`dev.md` 两边都留（56 号票的效果记录、54 号票的只看 / 动手 / 删改）。
- **接口**：
  - `ZoomConversation` 的 `onToolDetail` 换成 `onDetail(条目 id)`。
  - `ChatItemView` 的入口照 `Conversation.tsx` 的 `MessageRow` 做：用户气泡点整条，思考和多段的回复点"详情 ›"，工具调用点整行，卡片点"详情 ›"，系统说明和记录点整条，语音在长按菜单里。
  - 每条矩形（`.zi`）标 `data-item={item.id}`，组里每一步另标 `data-item`。
  - 原型页改用 `useDetail` + `DetailLayout`。`ZoomHistoryHandle` 本身就满足 `ConversationHandle`，"在对话中定位"直接经它调 `reveal`。
- **reveal**：照 AgentSense，缩小着的以那一条为焦点放大回对话层，同时滑到视口 30% 高处；已在对话层的就滚过去。整条闪 `.zi.flash`。二狗另加了一处：详情里点的是组里某一步（一次调用、一段思考）时，定位到那一步，闪 56 号票的 `.dp-flash`。
- **宽屏缩小时点一条**：照 AgentSense 的 `onZoomTap`（`wide && precise && 打开详情`），放大回去的同时打开它的详情；窄屏只放大，不开详情。
- **核对过**（无头 Chrome）：
  - 1280 宽，缩到全局层点一组：回到对话层，右栏打开这一组的详情。
  - 在详情里点进第 2 次调用，再缩小，点"在对话中定位"：放大回对话层，那次调用闪了一下。
  - 390 宽，缩小着点一组：只放大，不开详情。

- 2026-10-09 用户试过原型：“手感可以，三处会话都换上吧”。进入第二步（接真数据、换三处会话）。

2026-10-09 第二步：接真数据，三处会话都换上（同一分支，变基到 main `2a714a2d` 之后）。

- **三处会话**：秘书页、任务详情（真任务和原型里的假任务两处）、项目维护者会话，都换成同一个会话组件 `ui/conversation/Conversation.tsx`，也就是原型里的那一个，`ZoomConversation` 改名而来。
  - 标题栏放 `ZoomToggle`（▤ / 💬）：秘书和项目会话一直显示；任务会话在对话层不显示，缩小后才出现（`onlyZoomedOut`），切到计划、工具包这些栏时不显示。
  - 宽屏缩小时点一条，放大回去的同时打开它的详情（`onZoomTap`）；详情页的"在对话中定位"经同一个句柄调 `reveal`。
  - 页面统一用 `const [zoomRef, zoomLevel, setZoomLevel] = useConversationZoom()`。写成三元组是因为 lint 的 react(refs) 规则不许在渲染时读一个装着 ref 的对象的属性。
- **返回键**：会话组件缩小着时挂一层（`useBackLayer("overlay", level > 0, () => zoomTo(0))`），照 AgentSense 的 `level>0 → zoomTo(0)`。
- **切换会话回到对话层**：会话组件按会话重建（`key`），缩放、往上翻、到达动效都从头来；拿掉、换了会话时把外面的档位报回 0，标题栏的按钮跟着变。
- **去掉的旧代码**：
  - `ui/conversation/Timeline.tsx` 整个删掉：25 号票的分段按钮 `ZoomBar`、`GistLayer`、`GlobalLayer`、`MarkLine`、`MarkTick`。`RecordRow` 先挪到 `ui/conversation/RecordRow.tsx`。
  - 原来按消息画的 `Conversation` 换掉了，`ZoomConversation.tsx` 并进新的 `Conversation.tsx`。
  - 状态层分段按钮用的 `ZOOM_LEVELS`、`ZOOM_LEVEL_LABEL`、`ZoomLevel` 去掉了。
  - `pages.css` 里分段按钮、要点层、全局层、色块色板、跳回来闪一下的样式（约 250 行）去掉了；净白格栅 `grid/style.css` 的 `.zoom-bar button.on` 那条去掉了。
- **留着的**：状态层的 `gistView`、`globalView`。没有界面再用它们，但 `gistView` 是测试核对条目层要点一条不少的基准，`globalView` 按天、按工单段、按阶段的分组正是 55 号票底色带要的分段。要不要删，到 55 号票再定。
- **原型页**：`#/proto/zoom` 还留着（两段长会话量帧率、试往上翻），也改用新的会话组件。等用户看过真会话、合并前，连同"更多"里的入口一起去掉。
- **手势**（无头 Chrome）：双指落在输入框上往里捏，会话缩小，`touchmove` 被拦下，页面不缩放（`user-scalable=no`）。"按住 说话"时落下第二根手指丢掉这一段，靠的是 `VoiceSession.abort()`，有单元测试；无头浏览器没有麦克风，真机上请用户确认。
- **500 条真数据下的帧率**：
  - 怎么量：起一个测试守护进程（临时数据目录、系统挑的端口），秘书主线里布置原型那段约 500 条的会话（257 条消息，进了条目层是 617 条）。网页用这个分支的构建产物，在无头 Chrome 里打开真的秘书页（经 WebSocket 订阅，打开时只有最近一页），一页页往上翻到全部加载（窄屏翻了 5 页、宽屏 7 页）。然后每帧一个 Ctrl + 滚轮事件，缩到底再放回来，量帧间隔，每种宽度量三次。帧率上限 100（空转 100 帧/秒）。量完删掉了临时脚本，没入库。
  - 窄屏 390：只有最近一页（216 条）时 99～100 帧/秒；全部 617 条 62～63 帧/秒（p50 10 ms，p90 30 ms，最长 40～50 ms）。
  - 宽屏 1280：全部 617 条 35～38 帧/秒（p50 10～11 ms，p90 50～60 ms，最长 70～100 ms）。
  - 对照：同一套量法量原型页的 497 条假数据，窄屏 68～69、宽屏 39～41。真数据和假数据每条的开销差不多，慢在宽屏：无头 Chrome 用软件光栅，画面越宽越慢。真机、带 GPU 的浏览器会好一些，手机上的帧率请用户看。
  - 远处条目降级没做（AgentSense 也没有）。宽屏要不要做，请用户定。
- **全量**（Git Bash，`ERGOU_TEST_WORKERS=2 npm run check`，变基到 main `47ad9f34` 之后，跑之前确认没有别的全量在跑）：
  - 类型检查、oxlint 都过了。
  - 测试 3252 过，1 个没过：`test/main/work-orders.test.ts` 的"项目的首个建设任务（端到端）"。断言 `complete_stage` 的工具调用记录已经到了前端，但它只等了看板频道上"任务完成"，没等维护者会话频道上的这条记录；机器忙的时候，后者可能还没到。这是原来就有的竞态，和本票的改动无关，这个文件单独跑全过（15 例）。这个测试不是本票的，没改。

2026-10-10 评审意见改完（同一分支，变基到 main `1f73d60b` 之后）：

- **"在对话中定位"的外框**：改回 56 号票第 10 条用户认可的样子（`.dp-flash`，底色加一圈同色外框）。整条定位闪 `.zi-l0`，组里某一步闪那一步。点缩小的条放大回去时，照旧闪 AgentSense 的 `.zi.flash`。
- **性质判错，在守卫的拆分里修**（`guard/shell/programs.ts`）：
  - 新的伪工具 `git_rewrite`："改写 git 历史或删改分支、标签"，登记成删改。
    - 归它的命令：`git reset` 到别的提交（`HEAD~1`、`--soft`、`--mixed`，`--` 之前第一个不是选项的词不是 HEAD）、`rebase`、`filter-branch` / `filter-repo`、`branch -d / -D / -m / -M / -f`、`tag -d / -f`。
    - 它不带"删除或覆盖"标签，所以不触发 v1 模板"删除或覆盖之前必须已提交"。否则带着暂存改动的 amend、工作目录有改动时删分支都会被退回。守卫照常按路径判，不加新的安全规则。
  - `git commit --amend` 仍是提交，多带 `amend: true`。`git push --delete / -d / --prune / :分支` 仍是推送，多带 `delete: true`。这两种都登记成"给了就算删改"（`modifiesWith`）。
  - 只给 HEAD、`--` 之后是文件的 `git reset` 是取消暂存，拆成其他命令（动手）。原来拆成 git 状态和差异，被判成只看。
  - 同类的都查过：`reset --hard`、`checkout -- 文件`、`restore`、`clean`、`stash drop` 原来就是丢弃 git 改动（删改）。
  - 测试：守卫 `nature.test.ts` 每种都补了；`bash.test.ts` 补了拆分。
- **三处照搬 AgentSense**（`D:\code\claudecode\user_agent_sense_of_security\web\src\ui\ZoomHistory.tsx`、`layout.css`）：
  - **`zi-risk-dot`**：AgentSense 在 `.zi-l1` 里画，有 risks 就有，有 `level === "high"` 的加 `.high`。样式：右上角 8px 圆点、白圈、`--op-fg`，高的用 `--high-fg`；`.zh[data-level="1"]`、`[data-level="2"]` 隐藏。照搬：二狗的 risks 就是条右侧的标注（`item.marks`，关注类别也在里面），高不高按 `marks.tsx` 的 `markLevel`。白圈用新 token `--zoom-dot-ring`，经典是 `#fff`。
  - **一组的性质**：AgentSense 没有"工具调用组"，每次调用各是一条。几条合成一块的只有收着的阶段框 `StageZ`：`natures.includes("delete") ? "delete" : natures.includes("act") ? "act" : "look"`，就是成员里最重的。每条的性质出自 `semanticsOf`：没执行的调用（被引回、拉回、拦下）按"只看"画，免得一条没发生的删除显示成红色。照搬：组取最重的（原来就是）。另外改了我原来的写法：被拦下、你拒绝了的调用按只看画（Web 的 `toolNatureOf`），守护进程记的仍是要做的事。
  - **换会话时的档位**：AgentSense 的档位是 App 的一份状态（`const [level, setLevel]`）。`ZoomHistory` 不按会话重建，`openSession` 也不调 `zoomTo(0)`，所以换了会话档位照旧（缩放控制器和滚动位置都留着）。照搬：档位整页一份（`ui/zoom/zoom-level.ts`）。二狗换会话（换任务、换项目、换页）是重新挂上，所以从记着的那一档开始。唯一对不上的是位置：AgentSense 留着上一个会话的滚动位置，对新会话没有意义，二狗停在最新一条。
- **过时的注释和术语**：`state/protocol.ts`、`zoom.css`、`visual-styles/tokens.ts` 的"删除"改成"删改"。`ChatItemView` 里引用已删代码的注释改了。`CONTEXT.md` 的"时间线"改成一镜到底缩放的定义。
- **删干净**：
  - 缩放原型页 `#/proto/zoom`（`ZoomProtoPage.tsx`、路由、"更多"里的入口）、只给它用的假长会话（`fake-long-conversation.ts`，假连接、假 HTTP 里接它的几行）、它的样式，都删了。
  - 应用顶上的原型栏（"自适应宽度 / 手机竖屏 390"、"其他页面仍是原型的假数据"）和手机框模式（`PHONE_PREF`、`framed`）也删了，一律自适应宽度。
  - 开发用的整套假数据（`fake-conversations.ts` 等）还在用，留着。
- **`work-orders.test.ts` 的偶发失败**：等宣布阶段完成的那条工具调用记录到了再读。
- **页面接入收成一套**：
  - `useConversationPane(wide, 会话)` 给出句柄和详情；`<ZoomToggle handle />` 自己读档位；`Conversation` 接 `wide`，自己处理"宽屏缩小时点一条打开详情"和返回键。
  - 句柄直接给会话历史，不再转发。档位只在 `zoom-level.ts` 存一份，页面和会话组件不再各存一份。

2026-10-10 评审修改的收尾：

- **变基到 main `164f094d`**（64、74 号票之后）。
  - 和 64 号票冲突的几处都按两边的意图合：
    - `board/tool.ts`：64 的 `boardToolText(store)` 加上 54 的 `nature: "look"`；
    - `ProjectsPage.tsx`、`TasksPage.tsx`：64 的内部任务一栏照留，会话改用 `useConversationPane` 和 `ZoomToggle`；
    - `work-orders.test.ts`：64 已经改成等执行的工单结束再读工具调用记录，就用它的，我这边的等法不再加。
  - `suggest_task` 的卡片版本没动（仍是 64 的 4）。
  - 74 号票（外观与风格合成一项）和删掉原型入口没有冲突：`MorePage.tsx`、`route-hash.ts` 现在和 main 一致。
- **浏览器里核对过**（构建产物，宽屏 1280）：
  - 原型栏、手机框都没了；
  - 有标注的条右上角有小圆点，被拦下的是高亮色，缩到全局层隐藏；
  - 在任务会话缩到全局层后换任务、再换到秘书，档位都照旧；
  - 宽屏缩小时点一条，打开它的详情；按"在对话中定位"，闪的是带外框的 `.dp-flash`。
- **全量**：从 Git Bash 跑 `ERGOU_TEST_WORKERS=2 npm run check`（先确认没有别的 vitest 全量在跑），typecheck、oxlint、217 个文件 3340 个测试全部通过，用时 949 秒。
- **手势不冲突**这一条还没勾：双指落在"按住 说话"和输入框上的情况要在真机上试。

- 2026-10-10 完成：用户在真会话里试过、要求删掉原型；两轴评审的阻塞（定位外框、git 改写历史判删改、照搬 AgentSense 的小圆点/组性质/档位）已改，主会话核过；全量 3340 条通过。"手势不冲突"（录音时第二指）留给用户真机确认。压缩合并进 main。
