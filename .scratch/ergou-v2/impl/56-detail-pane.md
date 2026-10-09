# 56 — 详情页：会话里每一条都能点开

Status: done
Blocked by: 52（会话条目层）, 53（工具调用的完整参数和返回）
Spec: [第一阶段规格](../spec.md) 第 19 节"会话区照搬 AgentSense"的详情页；调研 `docs/research/15-agentsense-zoom-detail-task-modes.md` §2、§5.2、§6.1 的 T5

## What to build

照搬 AgentSense 的 `DetailPane`：

- **入口**：会话里每一条都能点开详情。
  - 用户气泡：点整条。
  - 回复、思考：点"详情 ›"。
  - 工具调用组、横条：点 ›。
  - 卡片：点"详情 ›"。
- **位置**：
  - 宽屏在右栏，可以拖宽，显示宽度封顶在窗宽的 32%。
  - 窄屏整页滑入，盖住底部导航；返回回到会话。
- **层层深入**：详情里能一层层点进去，返回时一层层退。有"在对话中定位"。

## Acceptance criteria

- [x] **详情种类**：
  - 文本：用户消息、回复、思考、语音转写。
  - **工具调用组**：逐个列出调了哪些工具、参数是什么，每个可以展开看返回。
  - **单次工具调用**：
    - 参数用 `ValueView` 按字段画，带中文字段名，不甩 JSON；原始参数折进"给开发者看"。
    - 返回能展开，被截断的注明。
    - 显示关注类别、处置、授权、效果记录。
  - 时间线记录。
  - 卡片。
- [x] **完整内容**：工具调用的完整参数和返回用 53 号票的接口取。53 还没合并时先用摘要顶着。
- [x] **取代旧的**：原来的 `WithToolDetail` 和竖屏的底部弹层由本票取代。
- [x] **测试**：
  - 前端状态层：详情按条目 id 存、返回栈、"在对话中定位"、窄屏和宽屏的开合。
  - 详情内容的投影用回放测试。
- [x] 和 AgentSense 不一致的地方，先问用户。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 新加的元素一律用 token。
- 54 号票（缩放）可能同时在做，两边都改会话组件。收尾前变基到最新 main。
- 锚点、详情按条目 id 存，查找一律用 `locateChatItem`，不直接按 id 比对（52 号票：一组调用跨两页时，翻回更早的一页之后组的 id 会变）。

## Comments

- 2026-10-09 做完（待主会话问用户下面"和 AgentSense 不一致的地方"）。实现概要：
  - 状态层（纯函数）：`state/detail-pane.ts` 是返回栈和开合（照 AgentSense `App.tsx` 的 `detail` / `detailBack` / `page`）：详情按条目 id 存，`openDetail` 清栈、`drillDetail` 压栈、`closeDetail`（‹：一层层退，退到底宽屏关、窄屏回会话）、`revealFromDetail`、`systemBack`、`layoutChanged`，右栏宽度 `dragDetailWidth`（260 到 60%）/ `detailColumnWidth`（封顶 32%、不少于 240）、`listYields`（窗宽不到 1200、阶段栏开着、详情开着时任务列表让开）。`state/detail-content.ts` 的 `detailContent` 每次用 `locateChatItem` 现查，投影出文本、工具调用组、单次调用、卡片、记录的详情；`callFullContent` 整理 53 号票的 `ToolCallDetail`。
  - 界面 `ui/detail/`：`DetailPane.tsx`（外壳、各种详情）、`ValueView.tsx`（照搬）、`DetailLayout.tsx`（`useDetail` + `<DetailLayout>`：宽屏右栏可拖宽；窄屏整页滑入、盖住底部导航，挂在 App 外框的 `.dp-host` 上，底下的会话和导航往左让 30%，照 AgentSense 的 `.stack`）。完整参数和返回每次打开现取（`DaemonHttp.toolCallDetail`，`cache: "no-store"`；404 退回摘要并说明）。
  - 入口：用户气泡点整条；思考、多段的回复"详情 ›"；工具调用整行、行尾 ›；卡片"详情 ›"；系统说明、记录点整条；语音在长按菜单里"详情 ›"；要点层点工具调用的要点。"在对话中定位"：缩小着的先回完整视图，滚到视口 30% 高处、闪一下（`ConversationHandle.reveal`）。
  - 62 号票：`useDetail` 自己用 `useBackLayer("overlay", backable, back)` 接进返回栈。39 号票：样式只用 token，新加 `shadow-slide`（经典 `-8px 0 24px rgba(0,0,0,.12)`，AgentSense 的值）。
- **没勾"详情种类"**：单次工具调用的"效果记录"没做。前端拿不到效果日志：协议里没有，守护进程的 `EffectRecord` 也不带调用 id。要做得改守护进程（比如 53 号票的 `ToolCallDetail` 加可选的 `effects`，`tool_call_end` 时和效果日志一起存），超出本票（前端票），等主会话定。其余种类都做了。
- **和 AgentSense 不一致的地方（没勾"先问用户"，请主会话问）**：
  1. 效果记录（见上）。
  2. 返回结果默认收起，点开才显示（规格第 19 节写"返回（可展开）"；AgentSense 的 ToolDetail 返回是摊开的）。组的详情里每次调用的返回也是收着、展开时现取。
  3. "原始参数（给开发者看）"折叠区里放原样 JSON；ValueView 画在外面的"参数"一节（票这样写；AgentSense 的折叠区里放的是 ValueView）。
  4. 宽屏的系统返回照 AgentSense：只退详情里点进去的层，只开着一层时不关右栏、交给外面。62 号票原来的 `WithToolDetail` 是宽屏返回先关详情栏。
  5. 二狗没有对应数据、不搬的：敏感片段高亮（AgentSense 场景里的内容规则）、规则核对、修补经过、计划审查、废弃分支。
  6. 回复的详情按 Markdown 渲染，为此加了依赖 `react-markdown` 10.1.0、`remark-gfm` 4.0.1（和 AgentSense 同版本，版本写死）。聊天气泡里的回复仍是原文，57 号票再说。
  7. 组是二狗加的（AgentSense 没有）：单次调用的详情头上"第 k 次调用 · 这一组共 N 次 ›"点进组的详情；组的详情里每一步按先后（思考、调用），算进 N 的编号，出了状况的标"被拦下：按规则退回"之类，头上列"被拦下：第 2、4 次"。57 号票之前会话里每次调用还是一行，点它进单次调用的详情（AgentSense 的 ToolRow → ToolDetail），组的详情从那一行进；内部工具（52 号票）在组里标"内部"、不编号，挂在别的条目上的列在那一条详情的"相关的内部调用"里。
  8. 语音：点一下是播放，所以详情放进长按菜单（AgentSense 没有语音）。
  9. 回复只有一段时没有"详情 ›"（照 AgentSense 的 AssistantBubble：后面有内容才给），和"每一条都能点开"有出入；57 号票缩成第一段时按同一条件。
  10. "在对话中定位"的闪动在 AgentSense 的底色之外加了一圈同色外框：二狗的气泡、工具行自己有底色，光闪底色看不见。
  11. ValueView：字段字典换成二狗的工具（pi 文件工具、bash、带类型的 bash 工具、二狗自己的工具），金额 / MB / GB 单位不搬；路径还认 Windows 盘符和 `~/`；对象里的字段也按字段名认（AgentSense 只在表格里认）；整段文字的换行靠样式保留。
  12. 详情按条目 id 存、每次现查（调研 15 §2.5 的建议，票也这样写），不是 AgentSense 的快照：流式更新、往上翻之后详情跟着变。
- 测试：状态层 `test/state/detail-pane.test.ts` 10 条、`test/state/detail-content.test.ts` 20 条（回放 secretary-chat、typed-shell-tools、timeline-zoom、task-rejections、voice-message、voice-reply、memory-purge，录不出来的按 schema 构造）。变基到 39、62 号票之后（main `c130ab8`）`ERGOU_TEST_WORKERS=2 npm run check` 一次全绿：196 个文件、2877 条，类型检查、oxlint 0 警告。界面在构建出的原型里看过宽屏（右栏、拖宽、窗宽 1100 时任务列表让开、组的详情）和手机宽度（整页滑入盖住底部导航、‹ 回会话、定位）。
- **和 54 号票（缩放）可能冲突的地方**：`ui/conversation/Conversation.tsx`（`onToolDetail` 换成 `onDetail(条目 id)`；新加 `ref` 的 `ConversationHandle.reveal`；`MessageRow` 里每一部分标 `data-item`、各种入口）、`Timeline.tsx`（`GistLayer` 的 `onDetail`、`RecordRow` 的 `itemId` / `onDetail`）、`parts.tsx`（`PartView` 的 `onDetail`）。54 号票换成 `ZoomHistory` 时：每条矩形标 `data-item={item.id}`，`reveal` 照 AgentSense 放大回对话层再滚、闪（`.dp-flash`），宽屏缩小状态下点一条调 `onDetail(item.id)`（AgentSense 的 `onZoomTap`）；页面那边的 `useDetail` / `DetailLayout` 不用动。
- 2026-10-09 第二轮（用户答复上面 12 条之后）：
  - 用户的决定：第 9 条（单段回复不给"详情 ›"，照搬）、第 2 条（返回默认收起、点开现取）、第 3 条（参数摊开，原始 JSON 折进"给开发者看"）保留；第 4、6、7、8、10、11 条（宽屏系统返回、react-markdown、"这一组共 N 次 ›"、语音长按菜单、闪动外框、ValueView 字典）保留；第 1 条效果记录本票一起做（见下）。
  - **计划审查**（第 5 条里不搬的那项）：58 号票合并后工作流计划卡有了审查数据，由 60 号票接进详情页。
  - **照 AgentSense 最新代码对齐**（`99656b5` 新版界面之后，连同工作区里还没提交的改动；调研 15 写的是旧版）：
    - 组的详情里连续的同类调用合成一条（照 `ZoomHistory.tsx` 约 1090 行的 `runs`）：连续 3 次以上、都顺利执行的同一个工具只留第一条，下面挂"还有 N 次同样的操作，都在授权内 ▾"，点开逐条显示、"收起同类操作 ▴"。状态层 `GroupStepLine.run`（`head` 带还有几次、`tail` 指向第一条），展开了哪些放在详情外壳里（点进一次调用再退回来还展开着，AgentSense 的 `openRuns` 也在详情之外）。"顺利"照 AgentSense 的 `plain`（执行成功、没被纠正、不用当场确认、没有高危标注）对到二狗：执行完了、没有任何状况（被拦下、问过你、出错……都算状况）、不是做完告诉我、不是通用 bash、没命中关注类别或命中了但在授权内（二狗没有"高危"这一级，把要点层、全局层单独标出的当成标注）；中间隔着思考或别的调用就断开（AgentSense 里非工具的条目也断开）。
    - 单次调用的详情写明在做哪个阶段（AgentSense `MilestoneToolDetail` 的"在做：「里程碑」"）：任务里的调用写"在做：第 n 阶段「标题」"。
    - 详情外壳：‹ 的 `aria-label` 改成"返回"、换一页从头看（AgentSense 新加的 `useLayoutEffect` 滚回顶上），这两处第一轮已经是这样。
  - **效果记录**（用户定了本票一起做）：
    - 守护进程：`EffectRecord` 加可选的 `callId`，`recordEffects` 记上（通用 bash 拆出来的几条是同一个），派生视图 `effect_log` 加一列 `call_id`（旧库 `ALTER TABLE` 补列）。`effectsOfCall` 先按调用 id 找，找不到时按"紧跟在这次调用的记录后面"找旧记录（完整内容之后紧跟着会话里的工具调用记录——评审子 agent 没有——再紧跟着效果日志；还得是同一个 agent、没有调用 id、同一个工具或通用 bash 才算）。
    - 53 号票的 `ToolCallDetail` 加可选的 `effects`（`ToolCallEffect { seq, tool, toolTitle?, summary, objects }`，对象 `{ kind: path / recipient / url, access?, value, uncertain? }`）：`findToolCallDetail` 对执行成功、没彻底删除过的现从效果日志里找、顺带返回（找不到是空数组）。摘要原样——写进事件日志之前已按 `read-secrets.ts` 的 `CallPrivacy` 脱敏（读密钥文件的摘要里结果是"（密钥文件的内容不记录）"，读过的值是"（密钥）"）。涉及的对象按 `BUILTIN_TOOL_REGISTRY` 的参数规则认（取的时候调用时那份会话的注册表已经不在了）：MCP、二狗自己的工具认不出对象，涉及的文件仍写在摘要里。
    - 彻底删除、删除项目：`effectRecordPurge` 改写时把 `callId` 一起去掉；另外改写某次调用的完整内容时，按调用 id 找到的效果日志一起改写（`effectEventsOfCall`）——通用 bash 拆出来的伪工具和调用记录的工具对不上，原来"紧跟在后面"那条路找不到；删除项目时评审子 agent、子 agent 的效果也不在维护者名下，原来留着评审读到的开头。详情里彻底删除过的不带 `effects`。
    - **宿主协议不升**：调用 id 本来就在 `tool_call_end` 里，效果日志是守护进程自己写的，子进程不用改。前端协议是 HTTP 响应里加可选字段，`ToolCallDetail` 本来就约定"只加可选字段"，也不升。
    - 前端：`callFullContent` 多给 `effects`（`EffectLine`：摘要、涉及的对象写成"读 / 改动 / 删除 / 涉及 路径""发给 …""网址 …"，守卫当时没法确定的注明）；单次调用的详情在"守卫怎么判的"后面列"效果记录"（执行成功的才有；取不到、彻底删除过、效果日志里没找到各有一句说明）。
  - **再对一遍 AgentSense 最新的 DetailPane，和现在做法不一样、没照搬的**（请主会话问）：
    1. 里程碑计划会话专用的详情都没搬：`GuardDetail`（完整的拦截卡 `GuardFull`、"为什么说是攻击"的提示词注入一节、`HowJudged` 时序逻辑公式和轨迹、`CheckLink` 规则引擎的输入）、`MilestoneToolDetail` 的 `StepRules`、新加的详情种类 `ruleset`（规则集）、`check` / `checks`（规则核对、执行轨迹）、`incidents`（执行中出过的情况，工作区里新加的）、`AttemptDetail`（一次提交的验收核对）、总账里"执行轨迹与规则核对"的入口。二狗的工具调用 part 里没有这些数据（规则公式、引擎输入、注入证据），工作流计划这一套归 58、60 号票。
    2. 换一页时 AgentSense 只把正文滚回顶上，折叠区展开着的状态 DOM 复用时会带过去；二狗按详情 id 重新挂正文（lint 不许在 effect 里依赖 `detail` 做滚动），所以展开了的返回、原始参数也一起收起。组里展开的同类调用另放在外壳里，不受影响。
    3. `runs` 在 AgentSense 里是会话历史（`ZoomHistory`）的折叠，按钮只在对话层显示；二狗按用户的决定放在组的详情里（会话里一组调用怎么画归 57 号票）。
    4. 效果记录 AgentSense 的单次调用详情里没有（它只有废弃分支的"遗留效果"）；二狗按规格和用户的决定加在"守卫怎么判的"后面，摘要和对象的写法是二狗自己的。
  - 测试：前端状态层 `detail-content.test.ts` 加了同类调用合成一条（3 条：够 3 次才折、状况 / 换工具 / 思考断开、有标注的不折）、阶段、效果记录的整理；守护进程主切面 `test/main/tool-call-detail.test.ts` 加了"效果记录"两条（顺带返回、摘要和对象、通用 bash 拆出来各一条、被拦下和出错的没有；旧记录按紧跟着找、中间插了别的或别的 agent 的不算），并在彻底删除（检索调用只靠完整内容找到时、批准过的通用 bash）、删除项目（评审子 agent 的效果）、隐私（读 `.env` 的摘要不记结果、读过的值换成"（密钥）"）的用例里断言效果记录。变基到 main `2fbd599` 之后 `ERGOU_TEST_WORKERS=2 npm run check` 一次全绿：196 个文件、2885 条，类型检查、oxlint 0 警告。效果记录在构建出的原型里看过（宽屏单次调用的详情）。
  - 57 号票（main `2fbd599` 加的"连续的同类调用合成一条"）可以直接用这里的状态层：组的 `steps` 已带 `run`，判"顺利"的条件在 `detail-content.ts` 的 `plainCall`。
- 2026-10-09 第三轮（评审之后）：
  - 用户的决定：第二轮列的 4 处和 AgentSense 不一样的都接受（里程碑计划专用的详情留给 60 号票；换一页时展开的区域收起；聊天区里的折叠由 57 号票做；效果记录是二狗自己加的），勾上"先问用户"。
  - **回复里的外链图片照搬 AgentSense，自动加载——用户知情后定的。** 评审指出的风险原文：被注入的回复可以把数据拼进图片地址发出去，守卫拦不到。主会话向用户说明过，用户仍然选照搬。现在的做法：回复的详情用 `react-markdown` 默认配置渲染（和 AgentSense 一样），图片按地址直接加载（页面没有限制图片来源的 CSP，`Referrer-Policy: no-referrer`）；原始 HTML 不渲染（没有加 `rehype-raw`）、`javascript:` 这类链接被默认的 `urlTransform` 过滤，这两条保持不变。
  - 评审提的，一起改了：
    1. 拿显示文案当判断条件的改成按数据字段：`CallLine` 加 `outcome`（结局）、`disposition`（处置）、`grant` 改成 `within` / `outside` / `not_needed`（说法另放 `grantLabel`）；语音详情的 `voice` 加 `speaker`。界面里 `status === "已执行"`、`grant === "属于计划里的授权项"`、`label === "语音回复"`、`verdict === "直接做只记录"` 都换掉了。
    2. "紧跟在后面"合成一份：`effect-log.ts` 的 `legacyEffectEventAfter(store, 锚点, 调用)`（锚点是完整内容或工具调用记录；跨过紧跟着的工具调用记录；每一条都没有调用 id、同一个 agent（知道时）、同一个工具或通用 bash 才算）。彻底删除原来的 `effectAfter` 删掉，改用它；详情页、删除项目也用它。
    3. 两类旧记录补上：彻底删除时，改写了完整内容的调用按紧跟在完整内容后面找旧效果（通用 bash 拆出来的伪工具在这条路上不比工具）；删除项目时，属于项目的调用（子 agent、评审子 agent 的）按紧跟在完整内容后面找，53 号票之前没有完整内容的，按维护者会话里每条工具调用记录后面紧跟着的找。测试：批准过的通用 bash 被彻底删除分成记了调用 id 的和旧记录两条；删除项目的用例里把评审交评审的效果改回旧样子、再放一条 53 号票之前样子的子 agent 调用，删除后都只剩删除标记。
    4. 按调用 id 查效果时加上同一个 agent：详情页的查询 `call_id = ? AND agent_id = ?`；彻底删除、删除项目按完整内容里的 agent。测试里放一条别的 agent 同号的效果，详情里不出现。
    5. "都在授权内"只用在都命中关注类别、在授权内的几次上。都没命中关注类别的说"都不需要授权"，两样都有的说"都在授权内或不需要授权"（状态层 `run.grant` 是 `within` / `not_needed` / `mixed`）。AgentSense 对应的说法是"只看，没改动东西"（它没有操作标注的就是只读），二狗没命中关注类别不等于只读（比如写草稿区），所以照实说"不需要授权"，和详情里"授权"一栏的说法一致。
    6. `sizeLabel` 合成一份（状态层 `detail-content.ts` 导出，附件、上传、详情共用）；详情外壳的 `onBack`（"‹ 返回上一条"，AgentSense 留的口子，没人传）和控制器的 `back` / `backable` 删掉（系统返回仍由 `useDetail` 自己挂进返回栈）。
  - 变基到 main `67a50b55`（58、63 号票合并之后）。第一次全量在 vitest 刚开始时因为本机内存不够被中止（类型检查、oxlint 已过）；清掉残留进程后在 Git Bash 里重跑 `ERGOU_TEST_WORKERS=2 npm run check` 一次全绿：205 个文件、3081 条，类型检查、oxlint 0 警告。

- 2026-10-09 完成：两轴评审后改了按数据字段判断、"紧跟在后面"合成一份、旧记录的效果在彻底删除和项目删除时也改写、按调用 id 查效果限定同一个 agent、折叠的说法按是否需要授权分开。用户定的：照搬 AgentSense 的连续同类调用折叠、返回默认收起、单段回复不给详情入口、参数摊开 JSON 折起、效果记录这票一起做、回复里的外链图片照搬自动加载（知情后定的）、4 处差异都接受。压缩合并进 main。
