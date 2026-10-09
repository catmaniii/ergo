# 59 — 流程执行：每次调用和计划比对，能修的自动修回

Status: done
Blocked by: 58（流程：起草、审查、授权）
Spec: [第一阶段规格](../spec.md) 第 8 节"两种任务"、第 9 节（守卫）；ADR 0019；调研 `docs/research/15-agentsense-zoom-detail-task-modes.md` §4.5

## What to build

照搬 AgentSense 固定计划的执行守卫：`W/agent/guard.ts` 的 `evaluateCall` 和自动修回，以及 `runtime.ts` 的收尾提醒。

## Acceptance criteria

- [x] **比对**：流程执行时，守卫把每次调用和计划比对，判出以下几种：
  - 计划外；
  - 超范围：参数超出步骤写的；
  - 顺序错：前置步骤或时序规则没满足；
  - 重复；
  - 禁止。

  比对排在现有的守卫判定（关注类别、处置）之后，两道都要过。
- [x] **自动修回**：能修的不打扰用户，两种修法：改回参数（rewrite）、引回前置步骤（redirect）。
  - 每一步最多修 2 次（`MAX_AUTO_FIX`）。修不了或超过次数的，问用户。
  - 每次修回都进时间线，记成偏离记录，口径同 14 号票。
- [x] **进度和收尾**：维护者用 `report_step` 自报进度，视图里再推断一次，照 AgentSense 的 `sessionView`。一轮要收工时还有没做的步骤，提醒一次。
- [x] **执行中不能改步骤**：要改就重新发起。维护者想改计划时，告诉它不行。
- [x] **参数比对的粒度**：通用 bash 的步骤只比到命令这一层；带类型的特殊 bash 工具按字段比。
- [x] **主切面测试**，覆盖这些情形：
  - 计划外的调用照 AgentSense 处理：只读的放行、记一笔；会改东西的、落进关注类别的问用户（原来写的是"被拉回"，用户 2026-10-09 定照 AgentSense，见 Comments 第 1 条）；
  - 参数被改回；
  - 前置步骤没做，被引回；
  - 修回超过次数后问用户；
  - 重复调用；
  - 收尾时有没做完的步骤，提醒一次；
  - 维护者想改步骤，被拒。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。（变基到 56 号票之后 `ERGOU_TEST_WORKERS=2 npm run check` 全绿：208 个文件、3119 条；改了超范围按对象记之后又跑一次全量：类型检查、oxlint 通过，3120 条里 1 条失败——`test/main/parallel.test.ts` 的"工具包收窄"，长程任务的子 agent 重新拉起时读文件的结果还没进会话，和流程无关、上一次全量通过，单独重跑 3 次、整个文件重跑都通过，判断是负载下的偶发）

## Comments

**2026-10-09 实现（worktree-agent-aeb098cf6c050ba12）**

做了什么（细节见 docs/dev.md"流程"一节的"执行时逐步照计划核对"）：

- 引擎：照搬 planguard 的 `monitor.ts`（`guard/planguard/monitor.ts`，哈希没变，VERSION 记了）；AgentSense 的 storage、office、travel 三条执行序列原样跑（`test/guard/planguard-monitor.test.ts`）。
- 比对和自动修回：`guard/plan-monitor.ts` 照搬 `guard.ts` 的 `evaluateCall` / `tryAutoFix`（`MAX_AUTO_FIX` = 2、`correctable`、`HARD_BLOCK`、`findingKey`、引回和改回的原话）和 `planguardMonitor.ts` 的 `PlanMonitor`（按已执行的调用重放、跳过的步骤、`identityArgs`、检查器出错一律当场确认）。第一道是现有的守卫判定，第二道是计划比对，两道都要过。
- 接入：`guard-runtime/plan-check.ts` + `guard-runtime.ts` 的 `disposePlan`；执行成功的调用记 `plan_call_committed`；改回参数经宿主协议 12 的 `guard_reply.args` / `resultPrefix`（子进程原地换参数、结果前面加"【自动纠偏】……以下是按计划参数执行的结果："，契约测试一条）；工具调用记录的 `blockedBy` 加 `plan_redirect`、`plan_check`；每次修回、提醒在时间线上记一笔偏离。
- 收尾和推断：`tasks/workflow-run.ts` + 执行控制器在维护者 `turn_end` 上（提醒一次、推断、推断后步骤都做完或跳过时流程完成）；`TaskStep.inferred`、任务变化 `steps_inferred`；`report_step` 开始一步时别的"在做"推断成做完。
- 执行中不能改步骤：执行时 `propose_plan` 一调用就被拒（`NO_PLAN_CHANGE_TEXT`）；系统提示第 4、5 条补上（第 5 条照 AgentSense 加"【自动纠偏】开头的照它说的做"）。
- 禁止：审查修补从数组参数里剔除的对象记成 `WorkflowStepView.excluded`，执行时再碰直接拦下。
- 宿主协议 11 → 12（main 当前 11）。

和 AgentSense 不一致、需要主会话问用户的地方（我按最贴近 AgentSense 的做了，没有自己简化；**用户 2026-10-09 全部接受**，第 3 条的比对口径另按评审意见改严了，见下面"评审之后"）：

1. **票里写"计划外的调用被拉回"，AgentSense 不是这样**：AgentSense 的固定计划里计划外动作不自动修（CHANGELOG"不修的情况：计划外动作"），只读的放行（只记一条计划外），敏感的（会改东西的）或带敏感标注的当场问用户。我照 AgentSense 做了，主切面测的是"只读的照常做、会改东西的问用户"。若用户要的是"计划外的一律拉回、不问用户"，要另定。
2. **时序规则在第一道判**：AgentSense 的规则只在 planguard 监控器里判；二狗的时序规则（v1 模板 + 计划里写的条件）早就在守卫第一道判，第二道直接用第一道的命中当 `rule:<id>`，只为了自动修回（引回、改回）。修不了时按二狗第一道的处置走：`on_violation: pull_back` 的拉回（计 14 号票的拉回次数，满 3 次找用户），AgentSense 是当场问用户；"用户点过头的同一件事不再问"只管计划比对的那几种，第一道的规则要问的照样每次问（AgentSense 规则判定也会记住）。
3. **比对规则（AgentSense 场景文档的 conformance）按注册表现生成**，AgentSense 是每个场景手写：认对象的参数 = 路径、收件人、网址、通用 bash 的命令，另加推送的远端和分支、合并的分支、建仓库的名字、装的包；数组参数"调用里的值都在步骤写的里面"才算对上（照 AgentSense 的 `in as_list`）；敏感（计划外要问）= 注册表没标"只读或幂等"的工具；只许做一次（重复直接拦下）= 对外发出去的带类型工具（git_push、create_remote_repo）。
4. **禁止（forbidden）的来源**：AgentSense 靠审查把对象写进步骤的 `exclude` 参数；二狗的工具没有这个参数，改成记下审查修补从数组参数里剔除的值（`excluded`）。
5. **收尾提醒的送法**：AgentSense 在同一个 run 里用 followUp 接着跑；二狗是维护者会话里一条通知、开新的一轮（模型看到的一样），"一轮"= 一条输入加上提醒接着的那一轮。另外流程那一支在等用户（审批挂起、卡住求助）时不提醒。
6. **步骤推断落到任务上**：AgentSense 的推断只在视图里；二狗写进 `Task.steps`（标 `inferred`），推断后步骤都做完或跳过就完成流程（否则执行过却没报的流程永远完成不了）。因此"执行过"只算对上这一步、执行成功的调用；AgentSense 视图里出错的、被引回的调用也算碰过这一步。
7. **没做的界面部分**：AgentSense 每轮的执行核对总账（GuardLedger 卡片）、run_end 的"计划检查：……没有执行"提示条、调用详情里的执行时检查记录（RuntimeCheck：轨迹长度、检查项、耗时）都没做——是界面（60 号票、详情页）的事，数据里只有时间线的偏离记录。
8. 小的：硬拒绝优先于自动修回（AgentSense 没有硬拒绝）；计划比对要问的不会马上挂起（照常等 5 分钟，和第一道的"没预料到的类别"不同）；引回时"计划里正好有 X 那一步"对通用 bash 的步骤按拆出来的命令认；给人看的纠偏原话里"Agent"写成"维护者"；拦下的原话"或提交修订后的计划"改成"执行中不能改步骤，要改由用户重新发起"（用户定的 ADR 0019）。

**2026-10-09 评审之后（同一分支）**

按评审意见和用户的决定改的：

- **没执行过的步骤不推断成做完**（阻塞 1）：推断成做完的只有真执行过的步骤——有对上它、执行成功的调用（`plan_call_committed`）；报着"在做"却没执行过的（被拒、出错、被引回的调用都不算）照旧在做，要么接着做，要么维护者自己用 `report_step` 报做完或跳过。`plan_call_committed` 记的是比对时真正对上的那一步（`PlanAssessment.matchedStep`），超范围的调用用户批准了也记 `null`。主切面加了一条：被拒、超范围（批准了）的调用之后开始下一步、再跳过它，写周报那一步不推断成做完，流程不完成（改之前这条会让流程完成）。和 AgentSense 不同（它的视图把"在做"的一律推断成做完、超范围的调用记到同一工具的第一步），是用户定的。
- **计划外、又落进关注类别的每次都问**（阻塞 2）：照 AgentSense 的 `offPlan && ops`，不看之前点没点过头；守卫切面加了测试。
- **比对口径照 58 号票的授权项从严**：只认步骤里写了的参数（多带、少带都对不上）、每个值都要一样（数组不论先后、个数也要一样）、路径按真实路径比（规划时现取的真实路径存在 `WorkflowStepView.realPaths`，执行时取判定前现取的事实；取不到的对不上）、通用 bash 的步骤只比命令、bash 里的同类操作对不上带类型工具的步骤。因此不认对象的参数（写的内容、提交说明）和步骤不一样也是超范围：能改回的按计划改回（rewrite），多带了参数的改不回（照 AgentSense 的改法只改回步骤里写了的参数），问用户。
- **只许做一次的扩到通用 bash**：这次调用命中了"以我的名义对外发送"（发布、`gh release`、`gh pr create`……）的通用 bash 步骤做第二次直接拦下。
- 规范：`isReadOnlyOrIdempotentCall` 挪进守卫（`judge.ts`），被杀后的恢复和计划检查共用；取修法的规则复用 `temporal-rules.ts` 的 `rulesInEffect`；改回参数的结果前缀用 `CORRECTION_PREFIX`；删了没用的 `PlanMonitor.end`、`history`；`evaluatePlanCall` 里的变量改名 `compared`；注册表"只读或幂等"的注释写明计划检查也看它；`findingKey` 的注释按实际写。
- **超范围点过头按"工具 + 这次碰的对象"记**（用户 2026-10-09 定，比 AgentSense 严）：AgentSense 超范围的原话只到工具，点过一次头之后同一工具后面的越界调用都不再问；二狗的判定身份另带这次碰的对象（`callObject`，口径同 58 号票授权项的对象范围：通用 bash 是整条命令，带类型的工具是认对象的参数，路径按真实路径），点一次头只放过那一个对象，换了别的文件、别的命令、别的远端或分支照样问。守卫切面测了同意改 `b.ts` 后改 `c.ts` 仍要问、bash 换一条命令仍要问、推送换分支仍要问（同一个文件换个写法不再问）；主切面测了批准写 `other.md` 之后写 `third.md` 又出一张审批卡。代码注释（`plan-monitor.ts` 的 `findingKey`、`callObject`）和 dev.md 写明是用户定的。

由此带来的、要主会话知道的：

- 规划时取不到真实路径的路径（参数是审查判不了的"未知"值、伪设备）写在步骤里，执行时任何调用都对不上那一步（超范围，问用户；批准了也不算做过它，最后要维护者自己报做完）。58 号票对这种步骤也不发授权，口径一致。
- 不认对象的参数和步骤不一样现在会被自动改回（原来照 AgentSense 的 within 只比认对象的参数，这种照常放行）。

- 2026-10-09 完成：两轴评审后改了步骤推断（只认执行成功、对上的调用或 report_step）、计划外又落进关注类别的每次都问（照 AgentSense）、比对口径和 58 号票授权项一样从严、只许一次扩到 bash 的对外发送。用户定：8 处差异都接受；超范围点头按"工具 + 这次碰的对象"记（比 AgentSense 严）。宿主协议 12。压缩合并进 main。
