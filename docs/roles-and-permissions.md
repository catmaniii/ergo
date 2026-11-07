**中文** | [English](roles-and-permissions.en.md)

# 角色与权限

> **以代码为准，改实现请同步改这篇。** 每一行都写着依据：文件加函数或常量名。路径不写包名的都在 `packages/daemon/src/` 下，别的包写全路径。对不上时信代码，再回来改这里。拿不准的标"未核实"。

这里的"角色"指二狗里的几种 agent，讲它们各能做什么、凭什么。它不是设置 · 角色与声音里的"角色"（名字加音色）。二狗也不给负责人配"工程师""研究员"这类工种，负责人能做什么由工具包定（[ADR-0003](architecture/adr/0003-no-roles-toolkit-per-project.md)）。术语见 [CONTEXT.md](../CONTEXT.md)。

## 有哪几种 agent

| agent | 是谁 | 依据 |
|---|---|---|
| 秘书 | 用户默认的对话入口。常驻，一条长期主线会话 | `secretary/secretary.ts` 的 `startSecretary`；内核给它的工具在 `secretary/tool-list.ts` 的 `secretaryToolList` |
| 项目负责人 | 每个项目一个（`pm-<n>`）。对话段、起草计划、执行、做别的任务派来的改动、项目内部的普通任务、定时运行，各是一段 | `projects/maintainers.ts` 的 `assemble`，经 `agent-host/assembly.ts` 的 `assemble` |
| 任务负责人 | 不属于项目的任务各有一个（`tm-<n>`）。涉及多个项目的任务的负责人用固定工具包。以前登记的定时作业由作业自己的负责人（`jm-<n>`）接着做，装配同"一次运行" | `maintainers/maintainers.ts` 的 `taskToolkit`；`agent-host/assembly.ts` 的 `fixedSetup`、`jobRunSetup`；`scheduled-jobs/maintainers.ts` 的 `createJobMaintainers` |
| 子 agent | 负责人提议、用户同意后临时拉起，做完就解散 | `sub-agents/assembly.ts` 的 `subAgentAssembly` |
| 评审子 agent | 阶段验收时独立判交付件，每次一个新进程、新会话 | `tasks/review.ts` 的 `createReviewer` |
| 记忆管理员 | 维护推理图谱，每晚 03:00 整理；平时在记忆页能找它说话 | `memory/curator.ts` 的 `startMemoryCurator`；工具在 `memory/curator-tools.ts` 的 `curatorTools` |

不算 agent 的两样：范围审视是另一次模型调用，没有工具（`scope-review/scope-review.ts` 的 `createScopeReview`）；快速动作由运行时直接执行，不拉起 agent（`quick-actions/quick-actions.ts` 的 `createQuickActionService`）。

项目、任务的负责人可以跑在 Claude Code、Codex 上。装配还是同一处，运行时自带的工具守卫照样判（`guard/judge.ts` 的 `isRuntimeOwnTool`）。这篇的工具清单按 pi 核对；Claude Code、Codex 上每样工具怎么交到 agent 手里**未核实**，见 [Claude Code 手册](user-guide/claude-code.md#能做到什么做不到什么)和 [Codex 手册](user-guide/codex.md#能做到什么做不到什么)。

## 三条规则

### 1. 能发语音，不等于能主动出声

和用户说话的 agent 都配着"发语音"工具 `send_voice`。但只有这几种的那一轮发得出去，别的时候工具回原因、不发：

- 这一轮处理的消息里有用户直接说的话（不是秘书转达的），或者用户发的是语音；
- 秘书处理"跑完自动播报"通知的那一轮：开了这个开关的任务做完了，或者开了"有进展自动播报"的项目来信。

后台在做的任务、定时和事件触发的运行、别的运行时通知引起的一轮，都发不出。哪几种 agent 有这个工具、细节见下面的[语音一节](#语音什么时候能发什么时候不能)。

依据：`voice/send-voice.ts` 的 `createSendVoice`；`secretary/notice-tags.ts` 的 `isAutoAnnounceNotice`。

### 2. 边界只由人定

agent 能碰哪里、能用什么，只有用户改得了。agent 最多提出来、出一张卡，用户点了才算：

- 工具包加能力（开 bash、加 MCP、开联网、打开"给秘书发消息"、打开"发附件"）要用户批准；减能力、增减 skill 不用。依据：`packages/protocol/src/toolkit.ts` 的 `toolkitExpansions`；`toolkit/toolkit.ts` 的 `createToolkitService`。
- 授权的文件夹：秘书只能提，卡上总要用户点"执行"。依据：`folders/authorize-folders.ts` 的 `authorizeFoldersAction`。
- 目录授权表只由运行时写，agent 没有改它的工具；用户在设置 · 目录授权、各 agent 的 ⚙、审批卡的"以后都允许"里加。依据：`folders/folder-grants.ts` 的 `openFolderGrants`；[ADR-0049](architecture/adr/0049-per-agent-folder-grants.md)。
- 关注类别的内置类别只能往严里调。依据：`guard/watch-categories.ts` 的 `builtinDisposition`、`editWatchCategorySettings`。
- 运营方案、转入使用、定时任务、skill 进库、MCP 登记，都只出卡（见下面的能力表）。
- 受保护区域（配置区、密钥区、数据库区、skill 区、二狗程序目录，服务管家的注册表和运行状态）谁都写不了，密钥区（服务管家的 `.secrets` 也算）连读都拒。依据：`guard/judge.ts` 的 `protectedAreasOf`、`pathRule`。
- 停二狗、杀服务管家只能走服务管家工具，谁都绕不过去：跑服务管家的命令行（`lsm`）、ergo 的停止、重启、升级、回退、卸载和 `svc`，往服务管家端口发不是查询的请求，一律硬拒绝；杀二狗自己、服务管家、命脉服务（二狗的公网隧道、tailnet 网关）的进程永不，杀别的进程先问，看不准杀到谁的（变量、管道传来的、看不透的命令里写着杀进程）对话审批关着也问。依据：`guard/judge.ts` 的 `supervisorRule`、`killProcessRule`；`guard/shell/programs.ts` 的 `opsScript`；`lsm/guard-facts.ts` 的 `supervisorGuardFacts`。

### 3. 隔离换自由

看得少、碰得少的 agent，放得开：

- 对话审批关着（默认）时，秘书以外的 agent 要"先问我"的按"直接做只记录"放行，照常标关注类别、照常记录；牵涉硬底线又判断不了的、任务里确实违反了的时序规则照旧问。秘书读得到全部记忆，写删草稿区外、对外发送、账户与安全、不可逆的提交、删除或覆盖照旧要用户点头。依据：`guard/judge.ts` 的 `letTaskAgentThrough`、`relaxSecretaryAsks`、`SECRETARY_ASKS`；`config/config.ts` 的 `DEFAULT_GUARD_CONFIG`；[ADR-0026](architecture/adr/0026-features-first-security-later.md)。
- 在自己的地方里少管：秘书草稿区里的写、改、删不落入任何关注类别；负责人在项目档案和工作目录里读写不算越出，删、改任务和项目自己的临时文件也不算"删除或覆盖"。依据：`guard/judge.ts` 的 `JudgeContext`；`guard/own-temp.ts` 的 `ownTempTest`。
- 子 agent、评审子 agent 不继承目录授权。要它碰别的目录，写进它的指令、让负责人去做。依据：`guard-runtime/guard-runtime.ts` 的 `folderGrantsNow`；[ADR-0049](architecture/adr/0049-per-agent-folder-grants.md)。

放开的只是"先问我"这一档。硬拒绝、"永不"、"交给我做"、受保护区域、密钥都不变。依据：`guard/judge.ts` 的 `judgeToolCall`。

## 能力表

"同左"是和左边那一格一样。处置（直接做、先问我……）照[关注类别](user-guide/settings.md#关注类别)的设置，这里只写落进哪一类。

### 文件

| 能力 | 秘书 | 项目负责人 | 任务负责人 | 子 agent | 评审子 agent | 记忆管理员 | 依据 |
|---|---|---|---|---|---|---|---|
| 自己的地方 | 草稿区：读、写、删 | 项目档案和工作目录：读、写、删 | 工作目录：读、写、删。起草计划时只读；涉及多个项目的任务的负责人没有 pi 的文件工具 | 负责人的地方，项目档案只能读 | 文件工具只读；开了 bash 能在工作目录里跑命令 | 没有文件工具 | `guard/paths.ts` 的 `agentScope`；`agent-host/assembly.ts` 的 `EXECUTION_PI_TOOLS`、`PLANNING_PI_TOOLS`、`CHAT_PI_TOOLS`、`fixedSetup`；`sub-agents/assembly.ts` 的 `subAgentAssembly`；`tasks/review.ts` 的 `REVIEWER_PI_TOOLS`；`memory/curator.ts` 的 `startMemoryCurator` |
| 读别处 | 读项目档案区不算越出；别处落进"越出项目目录" | 落进"越出项目目录" | 同左 | 同左 | 同左 | — | `guard/judge.ts` 的 `JudgeContext`、`pathRule` |
| 写、删别处 | 先问（对话审批关着也问；开着时文件工具直接拒） | 文件工具：硬拒绝；bash：落进"越出项目目录" | 同左 | 同左 | bash：落进"越出项目目录" | — | `guard/judge.ts` 的 `pathRule`、`relaxSecretaryAsks` |
| 授权的文件夹 | 读不用问 | 读不用问 | 读不用问 | 读不用问 | 读不用问 | — | `guard-runtime/guard-runtime.ts` 的 `authorizedNow`；`guard/judge.ts` 的 `pathRule`；[ADR-0041](architecture/adr/0041-authorized-folders-read-only-in-guard.md) |
| 目录授权表 | 一份 | 每个项目一份，各段共用 | 每个任务一份 | 没有 | 没有 | 没有 | `guard-runtime/guard-runtime.ts` 的 `folderGrantsNow`；`daemon.ts` 的 `folderGrantHolders` |
| 受保护区域 | 写入永不，密钥区连读都拒 | 同左 | 同左 | 同左 | 同左 | 同左 | `guard/judge.ts` 的 `protectedAreasOf`、`pathRule` |
| 停二狗、杀服务管家 | 只能用服务管家工具：命令行、端口的非查询请求硬拒绝，杀它们的进程永不 | 同左 | 同左 | 同左 | 同左 | 同左 | `guard/judge.ts` 的 `supervisorRule`、`killProcessRule` |
| 登记目录里名字像密钥的文件 | 读、写、删都硬拒绝 | 同左 | 同左 | 没有表 | 没有表 | 没有表 | `guard/judge.ts` 的 `grantVerdict`、`folderGrantOutside` |

- 子 agent 的工作目录可以是负责人给它建的 git worktree；写项目档案一律硬拒绝，工作目录在项目档案里面的照常能写。依据：`guard/judge.ts` 的 `pathRule`；`sub-agents/tools.ts` 的 `proposeParallelTool`。
- 评审子 agent 在任务的工具包开了 bash 时能跑命令（看改动、跑测试和构建），不给提交、合并。依据：`tasks/review.ts` 的 `REVIEWER_SHELL_EXCLUDED`。
- 秘书写草稿区外的处理跟着对话审批的开关变：开着时文件工具写是硬拒绝（围栏），关着时改成先问。依据：`guard/judge.ts` 的 `pathRule`。
- 目录授权表里登记了的那种操作（读、写、删分开）不算越出，文件工具写也不再硬拒绝。依据：`guard/judge.ts` 的 `folderGrantOutside`。
- 作业自己的负责人（`jm-<n>`）有没有目录授权表**未核实**：判的是 `daemon.ts` 的 `folderGrantHolders`，看它是不是某个任务的负责人。

### 联网和说话

| 能力 | 秘书 | 项目负责人 | 任务负责人 | 子 agent | 评审子 agent | 记忆管理员 | 依据 |
|---|---|---|---|---|---|---|---|
| 联网 | 开着 | 照工具包；起草计划、立项书确认前开着 | 照工具包；起草计划时、普通任务、涉及多个项目的任务开着 | 照负责人 | 关着 | 关着 | `secretary/secretary.ts` 的 `SECRETARY_NETWORK`；`agent-host/assembly.ts` 的 `PLANNING_TOOLKIT`；`tasks/plain.ts` 的 `plainToolkit`；`maintainers/multi-project.ts` 的 `MULTI_PROJECT_TOOLKIT`；`sub-agents/assembly.ts` 的 `subAgentAssembly`；`tasks/review.ts` 的 `createReviewer`；`memory/curator.ts` 的 `startMemoryCurator` |
| 联网搜索、读网页 | 有 | 有 | 有 | 有 | 没有 | 没有 | `conversation/session-tools.ts` 的 `conversationTools`；`sub-agents/sub-agents.ts` 的 `assemble` |
| 发语音 | 有 | 有 | 有 | 没有 | 没有 | 有 | `conversation/session-tools.ts` 的 `conversationTools`；`memory/curator.ts` 的 `startMemoryCurator`；`voice/send-voice.ts` 的 `createSendVoice` |
| 用别人的声音转述 | 能，只转述通知上记着的发信人 | 不能 | 不能 | 不能 | 不能 | 不能 | `voice/send-voice.ts` 的 `createSendVoice`、`relaySenders` |
| 用户发语音时这一轮用语音回 | 是 | 是 | 是；作业自己的负责人（`jm-<n>`）不是 | 不 | 不 | 是 | `agent-host/host.ts` 的 `MAINTAINER_SESSIONS`；`conversation/session-tools.ts` 的 `sessionVoice` |
| 联系用户 | 在主线会话里说 | 在自己的对话框里说；给秘书发消息；向派单方提问 | 在自己的对话框里说；给秘书发消息；卡住了转等我 | 负责人能给秘书发消息它才能；结果交回负责人 | 任务的工具包开着"给秘书发消息"时能；结论交回运行时 | 在自己的会话里说 | `agent-host/assembly.ts` 的 `letterTools`；`sub-agents/sub-agents.ts` 的 `letterFor`；`tasks/review.ts` 的 `createReviewer`；`tasks/execution-tools.ts` 的 `executionTools`；`work-orders/tool-names.ts` 的 `WORK_ORDER_TOOL` |
| 给别的 agent 递话 | 转达用户的话（快速动作，用户没点明先出卡）；把用户的话转给记忆管理员 | 给秘书写信；做别的任务派来的工单时向派单方提问、交回执 | 给秘书写信；涉及多个项目的任务的负责人派工单、回答项目负责人 | 负责人能给秘书写信它才能 | 工具包开着才能给秘书写信 | 不能 | `secretary/relay.ts` 的 `relayActions`；`memory/curator-link.ts` 的 `askCuratorTool`；`secretary/letters.ts` 的 `SecretaryLetters`；`work-orders/tool-names.ts` 的 `WORK_ORDER_TOOL`、`MULTI_PROJECT_TOOL` |

- 联网开关关着时，联网的工具和命令硬拒绝；工具照样在清单里。依据：`guard/judge.ts` 的 `networkRule`。
- "给秘书发消息"（`tell_secretary`）和"发附件"（`send_attachment`）是工具包的两个开关，不写是开着。依据：`packages/protocol/src/toolkit.ts` 的 `canTellSecretary`、`canSendAttachment`。

### 任务和项目

| 能力 | 秘书 | 项目负责人 | 任务负责人 | 子 agent | 评审子 agent | 记忆管理员 | 依据 |
|---|---|---|---|---|---|---|---|
| 建任务 | 流程、长程任务要用户这一轮点明；普通任务自己决定交出去；没点明的只出建议卡 | 立项书确认后在对话段里建项目内部任务：流程、长程任务要用户点明，没点明的最多一张建议卡 | 不能 | 不能 | 不能 | 不能 | `tasks/secretary-tools.ts` 的 `taskTools`；`tasks/internal-tools.ts` 的 `internalTaskTools`；`projects/maintainers.ts` 的 `assemble` |
| 定时 | 简单提醒直接建、改、取消；定时任务只出卡，不挂项目 | 写进运营方案 | 不能 | 不能 | 不能 | 不能 | `reminders/plugin.ts` 的 `remindersPlugin`；`tasks/schedule-tool.ts` 的 `scheduleTaskTool`；`operations/tool-names.ts` 的 `PROPOSE_OPERATIONS_TOOL` |
| 运营方案 | 改不了，转达给项目负责人 | 起草、出卡，用户确认一次就生效 | 不能 | 不能 | 不能 | 不能 | `projects/maintainers.ts` 的 `assemble`；[ADR-0028](architecture/adr/0028-operations-plan-one-confirmation-authorizes.md) |
| 转入使用 | 只出确认卡 | 只出确认卡 | 不能 | 不能 | 不能 | 不能 | `projects/tool-names.ts` 的 `PROPOSE_GO_LIVE_TOOL` |
| 派子 agent | 不能 | 执行长程任务时提议，用户同意才拉起 | 同左 | 不能 | 不能 | 不能 | `agent-host/assembly.ts` 的 `executionSetup`；`sub-agents/tools.ts` 的 `proposeParallelTool`；`sub-agents/assembly.ts` 的 `MAINTAINER_ONLY_TOOLS` |
| 项目的操作 | 调使用中的项目的操作，不出卡 | 自己项目自动转的 MCP 在工具包里自动有 | 别的项目自动转的 MCP 配进工具包才有 | 没有 | 没有 | 没有 | `project-ops/tool.ts` 的 `createProjectOps`；`projects/maintainers.ts` 的 `segmentToolkit`；[ADR-0045](architecture/adr/0045-project-ops-auto-mcp.md) |
| 项目的服务 | 给入口；启动、关闭（用户说了就做，不出卡） | 查服务最近报的事件 | 不能 | 不能 | 不能 | 不能 | `project-services/secretary-tool.ts` 的 `openServiceTool`、`switchServicesTool`；`project-services/tool-names.ts` 的 `RECENT_SERVICE_EVENTS_TOOL` |

- 秘书的"点明"由运行时看用户这一轮的原话判，不是秘书说了算。依据：`tasks/launch-intent.ts` 的 `launchIntent`、`launchRefusal`；`tasks/launch-tools.ts` 的 `launchTool`。
- 秘书发起时只写了一个项目的，建出来的是这个项目的内部任务，由项目负责人做，秘书看不到细节。依据：`tasks/secretary-tools.ts` 的 `taskTools`。
- 项目负责人做别的任务派来的改动、执行流程时没有派子 agent、增减 skill 的工具。依据：`agent-host/assembly.ts` 的 `executionSetup`。

### 工具、skill 和配置

| 能力 | 秘书 | 项目负责人 | 任务负责人 | 子 agent | 评审子 agent | 记忆管理员 | 依据 |
|---|---|---|---|---|---|---|---|
| MCP | 调登记过的 MCP，不出卡，守卫照常判 | 工具包里列了的 MCP 的工具；登记、改、删出卡 | 执行长程任务时同左；定时运行有工具包里 MCP 的工具；起草计划、普通任务没有 | 没有 | 没有 | 没有 | `mcp/call.ts` 的 `createMcpCallService`；`agent-host/assembly.ts` 的 `toolkitParts`、`planningSetup`；`tasks/plain.ts` 的 `plainToolkit`；`sub-agents/sub-agents.ts` 的 `assemble` |
| 写 skill | 只能加，出卡 | 加、改、删，出卡；增减工具包里的 skill | 执行长程任务时同左 | 没有 | 没有 | 没有 | `skills/change.ts` 的 `createSkillChangeService`；`toolkit/toolkit.ts` 的 `createToolkitService`；`sub-agents/assembly.ts` 的 `MAINTAINER_ONLY_TOOLS` |
| 用 skill | 设置里勾的（默认 agent-browser、yt-dlp） | 工具包里的；起草计划时没有 | 工具包里的，起草计划时没有；普通任务用秘书那份 | 没有 | 没有 | 没有 | `skills/secretary-skills.ts` 的 `DEFAULT_SECRETARY_SKILLS`；`agent-host/assembly.ts` 的 `toolkitParts`；`maintainers/maintainers.ts` 的 `taskToolkit`；`sub-agents/sub-agents.ts` 的 `launch` |
| 工具包加能力 | 没有工具包 | 对话段里出"工具包变更"卡；任务里走计划变更 | 走计划变更 | 不能 | 不能 | 不能 | `toolkit/toolkit.ts` 的 `createToolkitService`；`tasks/execution-tools.ts` 的 `executionTools` |
| 改配置 | 写不了；能经快速动作提几样，授权的文件夹、工作日历总要用户点卡 | 写不了 | 写不了 | 写不了 | 写不了 | 写不了 | `guard/judge.ts` 的 `protectedAreasOf`；`folders/authorize-folders.ts` 的 `authorizeFoldersAction`；`workday/quick-action.ts` 的 `workdayCalendarAction` |

- skill 区是受保护区域，谁都不能直接写；卡上确认后由运行时写。依据：`guard/judge.ts` 的 `protectedAreasOf`；`skills/change.ts` 的 `createSkillChangeService`。
- 子 agent 拉起时不给 skill 目录，pi 只加载给了的。依据：`sub-agents/sub-agents.ts` 的 `launch`；`runtime/agent-child/session.ts` 的 `noSkills`。

### 记忆、日历、浏览器、数据源

| 能力 | 秘书 | 项目负责人 | 任务负责人 | 子 agent | 评审子 agent | 记忆管理员 | 依据 |
|---|---|---|---|---|---|---|---|
| 记忆 | 检索和读素材、问记忆、问记忆管理员、记一句、存外部信息；有相关记忆时带记忆简报 | 没有记忆工具 | 没有记忆工具 | 没有 | 没有 | 整理、看结论、记用户的表态、忘掉、别推断、看问题箱、访谈 | `memory/plugin.ts` 的 `memoryPlugin`；`memory/curator-tools.ts` 的 `CURATOR_TOOL_NAMES` |
| 日历 | 简单提醒；定时任务卡；改工作日历出卡 | 没有 | 没有 | 没有 | 没有 | 没有 | `reminders/plugin.ts` 的 `remindersPlugin`；`workday/quick-action.ts` 的 `workdayCalendarAction`；`calendar/plugin.ts` 的 `calendarPlugin` |
| 数据源按需查 | 连上了、开着按需查的能查 | 没有 | 没有 | 没有 | 没有 | 没有 | `data-sources/service.ts` 的 `createDataSources` |
| 内置浏览器 | 网页工具，只在浏览侧边栏、悬浮按钮（含长按网页元素出来的圆钮）发来的那一轮用得了 | 没有 | 没有 | 没有 | 没有 | 没有 | `browsing/plugin.ts` 的 `browsingPlugin`；`browsing/secretary-tools.ts` 的 `browsingTools`、`browsingTurnOf` |

- 记忆插件、提醒插件、浏览插件给的工具都只给秘书，插件停用时就没有。依据：`memory/plugin.ts` 的 `memoryPlugin`；`reminders/plugin.ts` 的 `remindersPlugin`；`browsing/plugin.ts` 的 `browsingPlugin`。
- 任务、项目的记忆范围现在只占位，负责人读不到记忆。依据：`tasks/tasks.ts` 的 `briefText`。
- 日历插件不给 agent 工具；往外部日历里写没有。Google 日历是数据源，按需查只读。依据：`calendar/plugin.ts` 的 `calendarPlugin`；`google/calendar-source.ts` 的 `googleCalendarSource`。
- 网页工具里，提交、运行这类按钮要带用户这一轮明确说了的确认才点，支付、删除、发布这类字样的不点。依据：`browsing/secretary-tools.ts` 的 `browsingTools`。

## 每种 agent 拿到的工具

按 pi 运行时、插件都启用时列。pi 的内置工具是 `read`、`write`、`edit`、`ls`、`grep`、`find`、`bash`；带类型的 bash 工具是 `git_status_diff`、`git_commit`、`git_merge`、`git_push`、`create_remote_repo`、`run_tests`、`install_deps`、`start_build`，只在工具包开了 bash 时有，联网关着时没有要联网的 `git_push`、`create_remote_repo`、`install_deps`。秘书有 `bash`，没有带类型的 bash 工具。

依据：`guard/tool-registry.ts` 的 `TOOL`；`typed-shell/index.ts` 的 `createTypedShell`；`secretary/secretary.ts` 的 `SECRETARY_PI_TOOLS`。

### 秘书

插件都启用、没连数据源时，先后就是模型看到的顺序：

<!-- secretary-tools：和 packages/daemon/test/main/reminders.test.ts 断言的那一份一致 -->
```text
read write edit ls grep find bash read_attachment send_attachment create_reminder update_reminder cancel_reminder archive_reminder search_materials read_material ask_memory ask_curator mark_woven_question remember_memory ingest_material map_search_places map_route map_geocode map_reverse_geocode map_my_places show_on_map mcp_call propose_quick_action read_personal_file start_workflow create_task delegate_task suggest_task ask_questions write_task_brief schedule_task suggest_project view_board check_health read_project_records open_service switch_project_services project_ops propose_go_live propose_skill list_inbox show_card lsm_status lsm_logs lsm_control lsm_force lsm_entries lsm_restart_self browse_read_page browse_fill find_files view_files browse_attach_files browse_open browse_snapshot browse_click browse_element_content browse_element_download web_search web_fetch spoken_summary send_voice
```

- 提醒插件给 `create_reminder` 到 `archive_reminder`，记忆插件给 `search_materials` 到 `ingest_material`，地图插件给 `map_search_places` 到 `show_on_map`（查地点、算路线的五个插件在运行就有，不跟着高德连没连着走），浏览插件给 `browse_read_page` 到 `browse_element_download`，语音插件给 `spoken_summary`、`send_voice`。插件停用时这几段没有。
- 连上了数据源、开着按需查的，另有 `query_looki`、`query_google_calendar`、`search_gmail`、`read_gmail`。

依据：`secretary/secretary.ts` 的 `startSecretary`；`secretary/tool-list.ts` 的 `secretaryToolList`；`data-sources/service.ts` 的 `createDataSources`。

### 项目负责人

| 哪一段 | 工具 |
|---|---|
| 对话段，立项书确认前 | `read` `write` `edit` `ls` `grep` `find` `submit_charter` `write_segment_summary` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| 对话段，立项书确认后 | 上面这些，加 `propose_charter_change` `propose_standard_change` `propose_operations` `propose_go_live` `check_ops` `recent_service_events` `start_workflow` `create_task` `suggest_task` `write_task_brief` `adjust_skills` `request_toolkit_change` `request_mcp_change` `request_skill_change`，工具包里 MCP 的工具 |
| 起草计划的工单段 | `read` `ls` `grep` `find` `submit_plan`（流程是 `propose_plan`）`write_progress` `ask_clarification` `write_segment_summary` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| 执行长程任务的工单段 | 任务负责人执行长程任务时的那一套，加 `ask_clarification` `write_segment_summary`；立项书确认后另有 `propose_charter_change` `propose_standard_change` `propose_operations` `propose_go_live` `check_ops` `recent_service_events` |
| 执行流程的工单段 | `read` `write` `edit` `ls` `grep` `find` `report_step` `wait_for_user` `fail_task` `propose_plan`（执行中调它一律被拒）`write_progress` `ask_clarification` `write_segment_summary` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| 做别的任务派来的改动 | `read` `write` `edit` `ls` `grep` `find` `submit_receipt` `ask_clarification` `write_segment_summary`，立项书确认后另有 `propose_charter_change` `propose_standard_change` `propose_operations` `propose_go_live` `check_ops` `recent_service_events` `request_mcp_change` `request_skill_change`，加每段都有的 `web_search` 到 `send_attachment`。没有推进阶段、派子 agent、`adjust_skills` |
| 项目内部的普通任务 | `read` `write` `edit` `ls` `grep` `find` `write_segment_summary` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment`，工具包里 MCP 的工具 |
| 定时运行 | 普通任务的：同项目内部的普通任务，加 `fail_job_run`。流程的：同上，再加 `report_step` `propose_plan`（一律被拒），工具包是授权的计划和项目工具包的交集 |

工具包开了 bash 的，每一段都加 `bash` 和带类型的 bash 工具。工具包里关了"给秘书发消息""发附件"的，没有 `tell_secretary`、`send_attachment`。

依据：`projects/maintainers.ts` 的 `assemble`、`segmentToolkit`；`agent-host/assembly.ts` 的 `chatSetup`、`planningSetup`、`executionSetup`、`plainTaskSetup`、`jobRunSetup`；`tasks/workflow-tools.ts` 的 `workflowExecutionTools`；`scheduled-jobs/jobs.ts` 的 `runAssembly`。

### 任务负责人

| 哪一段 | 工具 |
|---|---|
| 起草计划 | `read` `ls` `grep` `find` `submit_plan`（流程是 `propose_plan`）`web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| 执行长程任务 | `read` `write` `edit` `ls` `grep` `find` `start_stage` `complete_stage` `report_progress` `wait_for_user` `propose_plan_change` `revise_plan` `mark_infeasible` `fail_task` `propose_parallel` `web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` `adjust_skills` `request_mcp_change` `request_skill_change`，工具包里 MCP 的工具 |
| 执行流程 | `read` `write` `edit` `ls` `grep` `find` `report_step` `wait_for_user` `fail_task` `propose_plan`（执行中调它一律被拒）`web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment`，工具包里 MCP 的工具。没有派子 agent、增减 skill |
| 普通任务 | `read` `write` `edit` `ls` `grep` `find` `bash`、带类型的 bash 工具、`web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment` `send_attachment` |
| 定时运行 | 普通任务的：同普通任务，加 `fail_job_run`。流程的：工具包照授权的计划，读写、每段都有的那几个，加 `report_step` `fail_job_run` `propose_plan`（一律被拒） |
| 涉及多个项目的任务 | `read_project_records` `dispatch_work_order` `summarize_receipts`；起草时加 `submit_plan`，执行时加推进阶段的那几个和 `answer_work_order` `forward_to_user`；`web_search` `web_fetch` `spoken_summary` `send_voice` `tell_secretary` `read_attachment`。没有 pi 的内置工具 |

执行时工具包开了 bash 的加 `bash` 和带类型的 bash 工具。

依据：`maintainers/maintainers.ts` 的 `taskToolkit`；`agent-host/assembly.ts` 的 `executionSetup`、`fixedSetup`；`tasks/workflow-tools.ts` 的 `workflowExecutionTools`；`scheduled-jobs/jobs.ts` 的 `runAssembly`；`work-orders/tool-names.ts` 的 `MULTI_PROJECT_TOOL`。

### 子 agent

负责人此刻的 pi 内置工具；带类型的 bash 工具、`web_search`、`web_fetch`、`tell_secretary` 里负责人也有的。没有 MCP、skill、`spoken_summary`、`send_voice`，也没有推进任务、起草计划、提议并行、`send_attachment`、`request_skill_change`。

依据：`sub-agents/sub-agents.ts` 的 `assemble`；`sub-agents/assembly.ts` 的 `subAgentAssembly`、`MAINTAINER_ONLY_TOOLS`。

### 评审子 agent

`read` `ls` `grep` `find` `submit_review`。任务的工具包开了 bash 时加 `bash` `git_status_diff` `run_tests` `start_build`；任务的工具包开着"给秘书发消息"时加 `tell_secretary`。

依据：`tasks/review.ts` 的 `createReviewer`、`REVIEWER_PI_TOOLS`、`REVIEWER_SHELL_EXCLUDED`。

### 记忆管理员

`run_memory_consolidation` `inspect_memory` `review_memory_claim` `forget_material` `no_infer_material` `memory_questions` `search_materials` `read_material` `begin_interview` `finish_interview` `forget_interview_answers` `propose_personal_file`；语音插件在运行时加 `spoken_summary` `send_voice`。没有 pi 的内置工具，不联网。

依据：`memory/curator-tools.ts` 的 `CURATOR_TOOL_NAMES`；`memory/curator.ts` 的 `startMemoryCurator`。

## 语音：什么时候能发、什么时候不能

`send_voice` 每次调用都看这一轮处理的是什么消息，不看是哪个 agent：

| 这一轮 | 发得出吗 |
|---|---|
| 用户在秘书那里打字 | 能 |
| 用户在项目负责人、任务负责人、记忆管理员的会话里打字；负责人正忙时作为插话送进去的也算 | 能 |
| 用户发的是语音 | 这一轮本来就用语音回，工具回"已经在合成了" |
| 秘书转达过去的一句（转给负责人、转给记忆管理员） | 对方那一轮不能：用户不在那个会话里 |
| 开了"跑完自动播报"的任务做完、开了"有进展自动播报"的项目来信 | 秘书处理这条通知的那一轮能 |
| 开关关着的任务做完、审批已批准、状态变化这类运行时通知 | 不能 |
| 后台在做的任务、定时和事件触发的运行 | 不能 |
| 还没有参考音色 | 不发，待办里提示去导入 |
| 有代码、表格、链接这类念不出来的，或者太长 | 不发，回原因 |

依据：`voice/send-voice.ts` 的 `createSendVoice`、`SEND_VOICE_WAIT_MS`；`secretary/notice-tags.ts` 的 `isAutoAnnounceNotice`、`AUTO_ANNOUNCE_TAG`。

- **谁有这个工具**：秘书、项目负责人和任务负责人的每一段、记忆管理员，都是语音插件在运行时才有。子 agent、评审子 agent 没有。依据：`conversation/session-tools.ts` 的 `conversationTools`；`sub-agents/sub-agents.ts` 的 `assemble`；`tasks/review.ts` 的 `createReviewer`。
- **用别人的声音转述**：只有秘书的会话能带 `relay`。转述谁只认通知上记着的发信人，发信人没有自己的声音时合成一条秘书的语音。依据：`voice/send-voice.ts` 的 `createSendVoice`、`relaySenders`。
- **开关谁能开**：用户在任务详情、项目档案里开；秘书只有在用户这一轮点明了时，经快速动作开关。项目内部的任务、作业做完不告诉秘书，也就没有自动播报。依据：`tasks/task-control.ts` 的 `taskRunActions`、`projectAnnounceAction`；`secretary/task-done.ts` 的 `startTaskDoneNotices`。
- 用户怎么用见[二狗用语音回话](user-guide/voice.md#二狗用语音回话)。

## 怎么改这张表

加一个给 agent 的工具，要同步改这几处：

1. **装进哪种 agent**：
   - 秘书内核的：`secretary/tool-list.ts` 的 `secretaryToolList`，先后就是模型看到的顺序；
   - 插件给的：经 agent 贡献登记，写清给谁（`agent-host/contributions.ts` 的 `ContributionScope`）；
   - 负责人的：`agent-host/assembly.ts` 里对应那种会话的函数，项目负责人另看 `projects/maintainers.ts` 的 `assemble`；
   - 记忆管理员的：`memory/curator-tools.ts`，名字加进 `CURATOR_TOOL_NAMES`；
   - 评审子 agent 的：`tasks/review.ts` 的 `createReviewer`。
2. **子 agent 该不该有**：子 agent 的候选只有带类型的 bash 工具、联网搜索和读网页、给秘书发消息（`sub-agents/sub-agents.ts` 的 `assemble`）。负责人专用的（推进任务、出卡给用户、往库里写）加进 `sub-agents/assembly.ts` 的 `MAINTAINER_ONLY_TOOLS`。
3. **守卫的登记**：代为执行的工具在定义里写清 `readOnlyOrIdempotent`、`nature`（`agent-manager/host-tools.ts` 的 `defineHostTool`）；框架自带的（pi 的、带类型的 bash、联网）在 `guard/tool-registry.ts` 的 `BUILTIN_TOOL_REGISTRY` 写清类别标签、路径参数的读写、要不要联网。
4. **测试**：秘书的完整清单在 `packages/daemon/test/main/reminders.test.ts`、`packages/daemon/test/main/tasks.test.ts` 里逐个断言，连先后；任务负责人起草计划时的清单在 `packages/daemon/test/main/tasks.test.ts`。`packages/daemon/test/roles-doc.test.ts` 核对这篇的依据和工具名在代码里还在、秘书那份和 reminders.test.ts 断言的一致、中英两篇的依据一样。
5. **这篇的中英两份**：能力表里那一行，"每种 agent 拿到的工具"那一节。

改守卫的规矩（新的硬拒绝、受保护区域、关注类别、对话审批的范围）时，改"文件"那张表和"三条规则"。

## 未核实

- Claude Code、Codex 上跑的负责人，每样工具怎么交到 agent 手里、和 pi 上的清单差在哪。
- 作业自己的负责人（`jm-<n>`）有没有目录授权表。
- 数据源的按需查工具排在秘书工具里的哪个位置。
