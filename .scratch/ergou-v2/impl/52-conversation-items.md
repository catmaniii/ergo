# 52 — 会话条目层：把会话拆成条目（前端状态层）

Status: done
Blocked by: None — can start immediately
Spec: [第一阶段规格](../spec.md) 第 19 节"会话区照搬 AgentSense"；调研 `docs/research/15-agentsense-zoom-detail-task-modes.md` §3、§5.3、§6.1 的 T1

## What to build

照 AgentSense 的 `ChatItem`，给二狗做一层纯函数的"会话条目"，作为后面三张票的共同底座：缩放（54）、详情页（56）、聊天区精简（57）。

会话里的东西拆成这几种条目：

- 用户消息
- 思考
- 回复
- **工具调用组**：一轮里两段话之间的工具调用按先后合成一组。被拦下、问过你、你拒绝了、出错、等你批准的调用也放在同一组里，组上带着这几种情况的计数（用户 2026-10-09 改，原来是各自单独成一条）。
- 卡片
- 系统说明
- 时间线记录
- 工单分隔
- 语音

每条推出这些属性：

- 种类；
- 稳定的 id（详情页按它存）；
- 要点层的那一行字；
- 性质色（授权内、做完告诉我、被拦下或问过，三种样式）；
- 两侧标注要的信息（复用现有的 `marksOf` 等）；
- 能否打开详情，以及详情的种类。

## Acceptance criteria

- [x] 条目层是 `packages/web/src/state/` 下的纯函数：输入是现有的会话状态（消息、记录、卡片），输出是条目列表，不碰 DOM。
- [x] 回放测试：用主切面现有的录像（秘书会话、任务的维护者会话、项目的维护者会话）回放成条目，断言：
  - 工具调用组的切法：两段话之间的调用按先后成一组，被拦下、问过、拒绝、等你批准、出错的也在组里、带计数（用户 2026-10-09 改）；
  - 每条的种类、要点那一行和性质色；
  - 语音、卡片、时间线记录、工单分隔各自成条。

  现有录像覆盖不到的情形，按共享协议的 schema 构造事件来测。
- [ ] 条目 id 稳定：同一条内容在往上翻加载更早的一页、实时追加之后，id 不变。有测试。
  - 做到了，有一个例外（主会话评审接受，不改方案）：一组调用跨两页时，翻回更早的一页之后，组会并上更早的调用，组的 id 换成新的第一次调用的。`locateChatItem` 按组原来的 id、组里任一步（调用、思考）的 id 都找得到它，所以存 id 的地方（详情页、缩放的锚点）一律用 `locateChatItem` 找，不直接按 id 比对（已写进 54、56 号票的 Notes）。其余条目往上翻、实时追加之后 id 都不变，有测试。
- [x] 本票只做状态层，不改界面。现有的 25 号票三层渲染照旧能跑。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 参照 AgentSense `W/ui/` 里的 `ChatItem` 和 `sessionView.ts`（路径和行号见调研 §3、附录 A）。照它的切法，按二狗的数据改写。
- 二狗现在每次工具调用单独一条消息、单独一个按钮，见调研 §5.3。
- 39 号票（视觉风格）、43 号票（助理名字）同时在改会话组件的界面。本票只动状态层，冲突应该很少。收尾前变基到最新 main。

## Comments

- 2026-10-09 实现：
  - 模块 `packages/web/src/state/chat-items.ts`：`chatItems(state, conversation)` 出条目列表，`locateChatItem(items, id)` 按 id 找条目（详情页、缩放的锚点用）。输入是 `timelineItems`（消息、记录、正在生成的回复、乐观显示的尾巴）。`timeline.ts` 多导出了 `partMarksOf`（一条消息里某个 part 的要点，`marksOf` 改成用它）、`toolOutcome` 和 `awaitingApproval`（"等你批准"只在这里判，`toolOutcome` 和条目层都用它）。测试 `packages/web/test/state/chat-items.test.ts`；`docs/dev.md` 的"前端状态层"一节写了用法。
  - 条目种类：user、voice、thinking、reply、tool_group、card、system、record、divider、deleted。每条都有 id、seq、time、scope、content（底色）、keyLine、tone（性质色）、marks（`marksOf` 推出的要点）、detail（详情种类）、error、internalCalls（挂在这一条上的内部工具调用）。工具调用组另有 calls（算进 N 的调用）、steps（按时间顺序的思考和调用，含内部工具）、issues（出了状况的计数）。
- **用户 2026-10-09 定**（在 AgentSense 之上的改动）：
  1. **出了状况的调用也在组里**（推翻了先前"单独成条"的规则；用户原话：否则让人感觉是两个事件，时间先后也会错乱）：被拦下、问过你、你拒绝了、等你批准、出错的调用按发生的先后放在同一组里。每次调用带 `issue`（`callIssueOf`：被拦下含硬拒绝、按规则退回、判定出错、交给我做和永不没执行的）和结果的说法 `outcome`；组上 `issues` 是各种状况的计数（按 `CALL_ISSUES` 的先后，只列有的），供 57 号票画小签；组的那一行在工具名后面写出来（"调用了 2 个工具：write ×2（1 次被拦下）"）；性质色取组里最显眼的（被拦下或问过 > 做完告诉我 > 授权内）；有出错的组 `error` 为真。审批卡照旧是卡片条目，会把组隔成前后两段。条目种类里不再有单独成条的 `tool`，条目的详情种类也没有 `tool`：单次调用的详情从组里点进去，`locateChatItem` 按调用 id 找到组和那一次。
  2. **思考并进工具调用组**：两段话之间、没有正文的思考不论长短都并进组，组的 steps 按时间顺序留着每一步的思考和调用，详情里照这个顺序列；思考不隔开组。一组思考再长，要点那一行也只说调用了哪些工具。秘书、任务、项目三处会话一样。原来出状况的调用收"它想干什么"的那段短思考，现在就是 steps 里的一步。带着正文的思考照常单独一条、排在回复前面；前后都没有调用的思考、正在生成的思考也单独一条（正在生成的还不知道后面有没有正文；定稿后没有正文就并进前面的组，组的 id 不变）。被组吸收的思考按它自己的 id（`…:think`）用 `locateChatItem` 找得到所在的组。
  3. **内部工具不算进组**：名单在 `INTERNAL_TOOLS`（一处常量，每个写明由什么代表 `shownAs`，挂靠时就按它找）。用户点名的五个：`submit_plan`（计划卡）、`complete_stage`（验收结论的进度卡）、`write_progress`、`write_segment_summary`（记账，同 AgentSense 的 `report_step`）、`spoken_summary`（它总结的那段回复）。检查过其他维护者内部工具后加上、用户同意的：`report_progress`（进度卡）、`propose_plan_change`（计划变更卡）、`revise_plan`（"自行调整计划"记录）、`mark_infeasible`（偏离记录）、`fail_task`（系统说明）、`propose_parallel`（并行确认卡）、`submit_charter`（立项书卡）、`request_toolkit_change`（工具包变更卡）、`adjust_skills`（"工具包变更"记录）、`dispatch_work_order`（"工单"记录）。`submit_review` 去掉了：评审的会话是 null，它的调用不进会话。没列进去的：`start_stage`、`wait_for_user`（会话里没有别的痕迹）、`summarize_receipts`（只读查询）、`ask_clarification`、`submit_receipt`、`answer_work_order`、`forward_to_user`（没核实到同一会话里有对应的卡片或记录）；秘书出卡片的工具（`create_reminder`、`suggest_task`、`ask_questions`、`propose_quick_action` 等）不在范围里，照常显示。
     - 顺利执行的内部工具调用不算进 N（`counted` 为假）：夹在一组里的留在组的 steps 里；一段里只有它们（没有算进 N 的调用）时不成组，挂到代表它的那一条的 internalCalls 上——在这一轮里（不越过用户的输入）往前找 `shownAs` 说的那一条（那种类型的卡片、那种记录、系统说明、它总结的回复），找不到、或者它只是记账，就挂在紧挨着的前一条上；会话开头就是它的挂到下一条上。`locateChatItem` 按调用 id 找得到。被拦下、出错的照旧算进组里，不藏。
- 主会话认可、按我写的处理的：
  - 要点那一行的 `firstLine`：AgentSense 把 `-`、`_` 一律换成空格，"t-1" 会变成 "t 1"。这里只去掉单独成段的（列表记号、分隔线）。
  - 组的边界：除了用户消息和回复，卡片、系统说明、时间线记录、已删除也隔开组（思考不隔开）。同一组要同一个 agent、同一个任务和阶段、同一次定时作业：子 agent 的调用、并行阶段交错的调用不混进一组，一组也不会跨两个阶段（55 号票按阶段画书脊）。
  - id 的例外：一组调用跨两页时，翻回更早的一页之后组的 id 会变（见上面验收那一条）。
- 自己定的（规格没写清，选了保守的）：
  - 组的要点那一行："调用了 N 个工具：write、bash ×2、git_commit"，有状况的在后面加"（1 次被拦下、1 次出错）"。
  - 底色：卡片用计划色（plan），说明、记录、工单分隔、已删除用 context 色，agent 的语音用回复色。
  - keyLine 里守护进程写的话（卡片的纯文本、系统说明、记录）先过 `currentWording`（43 号票之前的旧说法换成现在的），名字占位留着，界面照 43 号票用 `daemonTextSegments` 画成名字标签。
  - 用户消息里引用的卡片留在用户消息里，不另成一条。
  - 正在合成的 agent 语音（`streamingAgentVoices`）和"正在回复…/正在合成语音…"不进条目，界面照旧画在最后。
  - id：消息主体用消息的 key（`timelineItemKey`），思考加 `:think`，调用、卡片、分隔线加 `#part 序号`，组是 `group:` 加组里第一次算进 N 的调用的 id。
- 没推的：AgentSense 全局层的工具调用按只看、动手、删除分深浅（`natureOf`）。二狗的工具调用 part 里没有"只读"这类信息，条目层没推，留给 54 号票（已写进 54 号票的 Notes）。

- 2026-10-09 完成：用户定了三件事（思考并进工具调用组；出状况的调用也在组里按先后排；会话里已有卡片或记录代表的 15 个内部工具不计数），两轴评审后补了思考 id、dev.md、翻页时组 id 变化的例外说明（54、56 号票查找一律用 locateChatItem）。变基到 45 号票之后压缩合并进 main。
