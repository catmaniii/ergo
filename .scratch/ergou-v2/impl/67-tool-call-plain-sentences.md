# 67 — 工具调用写成说人话的一句

Status: done
Blocked by: 57（聊天区精简）
Spec: [第一阶段规格](../spec.md) 第 19 节"会话区照搬 AgentSense"；调研 `docs/research/15-agentsense-zoom-detail-task-modes.md` §6.3、§3 里 `ToolRow` 的说明

## What to build

照 AgentSense：工具调用不写"工具名 + 参数摘要"，写一句人话，比如"读 src/app.ts""把改动提交到 main：修复登录超时""给张三发邮件：周五开会"（用户 2026-10-10 定：照 AgentSense 不带"了"，原来的"读了……""发了……"作废）。AgentSense 每个场景有 `describe`，没有的才退回"工具中文名 + 参数值拼接"，截到 60 字。

- 给常用工具各写一句的模板：读、写、改、删、列目录、搜索、通用 bash（按拆出来的命令）、git 提交 / 推送 / 建仓库、联网读取、发消息 / 邮件、提醒、日历、看板、项目档案、附件和素材。MCP 工具和没写模板的照旧退回"工具中文名 + 参数摘要"（用户 2026-10-10 定：三处统一写"中文名 · 参数值"，去掉"参数名="，截到 60 字）。
- 用在：工具调用组的要点那一行和展开后的列表（57 号票）、详情页的标题（56 号票）、缩放的要点层（54 号票）。
- ~~被拦下、问过、拒绝、出错的照 AgentSense 加前缀（⛔ / ↩ / ⏸ / ✕）~~（用户 2026-10-10 改）：前缀照 AgentSense 的四种——⛔ 被拦下、↩ 拉回（"按规则退回"算这一种）、⏸ 等你批准、✕ 你拒绝了；问过你、出错、按计划引回都不加，出错照旧在小签里标。读了敏感数据的加 🔒：只加在读了密钥文件的调用上（守护进程不记内容的那种），"使用授权范围外的记忆"不算。

## Acceptance criteria

- [x] 一句话的生成是前端状态层的纯函数，按工具名查模板；有表格测试，每个模板至少一条，含参数缺失、路径很长时截断。
- [x] 回放现有录像，工具调用的那一行都换成了人话，没有模板的退回原样。
- [x] 和 AgentSense 不一致的地方先问用户（2026-10-10 问过，见 Comments）。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 54 号票的"只看 / 动手 / 删改"和这一句互不影响，颜色照旧按性质。
- 名字占位"⟦个人助理⟧"照 43 号票画成名字标签。

## Comments

- 2026-10-10 做完（子 agent，分支 `worktree-agent-aca902b8d0a4283db`，变基到 main `0747ff29`，55、75 号票之后）。
  - **先问过用户的**（主会话转达，用户 2026-10-10 定）：
    1. 说法照 AgentSense 不带"了"：写"读 src/app.ts""把改动提交：修复登录超时"，票面原来的例子以这条为准。
    2. 前缀照 AgentSense keyLine 的四种：⛔ 被拦下（硬拒绝、判定出错、计划检查拦下、按处置没执行）、↩ 拉回（"按规则退回"）、⏸ 等你批准、✕ 你拒绝了；问过你、出错、按计划引回不加（票面"问过、出错也加"作废），出错照旧在小签里标。
    3. 🔒 只加在读了密钥文件的调用上：守护进程在工具调用 part 上带可选的 `readsSecretFile`（放行执行了、结果摘要不记内容的那种才带 true），经共享协议包给前端；"使用授权范围外的记忆"不算。67 号票之前的记录没有这个字段，不补。
    4. **偏离 AgentSense、用户定的两处**：句子里超过 40 字的路径只留末尾几级、前面写"…/"（反斜杠的路径写"…\"，和后面的分隔符一致；网址留主机名和最后一级）——AgentSense 的说法用名字不用路径，不截；没有模板的，对话层、要点层、详情页三处统一写"中文名 · 参数值"（去掉"参数名="）截到 60 字——AgentSense 三处各不同（工具行中文名加参数值拼接截 60、要点层中文名 · 一个主要参数、详情只写中文名）。
    5. 82 号票：斜杠命令展开本身不产生工具调用；给 `/流程`、`/任务` 调出来的发起流程、发起长程任务各写一个模板，agent 读 skill 的 SKILL.md 写成"读 skill「x」的说明"。
    6. 前端从参数摘要里按参数名拆参数（不改协议）、前端简单拆 bash、MCP 退回原样、中文名表放前端。
  - **怎么做的**：状态层 `call-sentence.ts`（`callSentence`、`callKeyLine`、`callMark`、`TOOL_LABELS`、`summaryArgs`）、`shell-sentence.ts`（`bashSentence`）、`sentence-parts.ts`（`shortPath`、`shortUrl`）。用在组那一行（"调用了 N 个工具：读文件 ×3、通用 bash"）、组的详情每一步、单次调用的详情（标签中文名、"Agent 想做什么"是那一句）、缩小后每一块的要点层和它的对话层内容；一律经 `NamedText` 画。
  - **模板覆盖**：读（含 SKILL.md）、写、改、列目录、搜索内容、查找文件；通用 bash（git、npm/pnpm/yarn、npx、pip、ls、cat/head、rm、mkdir、cp、mv、rsync、grep、find、curl/wget、python/node 脚本、写进文件……）；git 状态、提交、合并、推送、建远端仓库、跑测试、装依赖、构建；联网搜索、读网页（70 号票）；建、改、取消提醒；查看板、看待办、把卡片放进聊天；读项目档案、建议立项；读附件、发附件、检索素材；快速动作（记住、忘掉 / 彻底删除 / 别推断、暂停 / 继续 / 取消任务、改工作日历）；发起流程、发起长程任务、建议发起任务、提问卡、写任务书；75 号票的交给后台（普通任务）。二狗没有发消息、发邮件、日历的工具，MCP 来的退回原样；内部工具、工单的工具没写模板，退回"中文名 · 参数值"。`list_inbox` 守护进程登记的是"列出待我处理"，界面上照 43 号票写"列出待办""看待办"（构建产物里不许有"待我处理"）。
  - **原型假数据**：工具调用的参数摘要换成守护进程真实会写的样子（`query=…`、`message=…`、`remote=… branch=…`，假工具名 move_files、delete_files、http_request 换成通用 bash），秘书主线加了一段提醒、联网搜索、读网页。
  - **测试**：`test/state/call-sentence.test.ts`（每个模板一条以上，参数缺失、路径很长、通用 bash 的拆法、退回的写法和截断、前缀和 🔒、回放全部录像：有模板的都说成了人话、没有模板的退回）；`chat-items`、`chat-look`、`detail-content` 的期望改成中文名和说人话；守护进程 `secret-read-outbound.test.ts` 断言 `readsSecretFile`。变基到 `0747ff29` 之后 Git Bash `ERGOU_TEST_WORKERS=2 npx vitest run`：246 个文件 3747 条通过、1 条失败（`crash-recovery.test.ts` 起测试守护进程时 `spawn EPERM`，单独重跑 10 条全过，和本票无关）；typecheck 通过；oxlint 0 错误（1 条警告在 `chat-look.test.ts:167`，57 号票留下的）。
  - **截图**（构建产物 file:// 打开，无头 Chrome，390 和 1280）：`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t67\`：`group-detail-*`（组的详情每一步）、`group-detail-task-*`（被拦下、你拒绝了、等你批准）、`call-detail-*`（单次调用的详情）、`gist-task-*`、`gist-secretary-*`、`gist-ledger-*`（要点层）。

- 2026-10-11 完成：用户定说法不带"了"、前缀照 AgentSense 四种、🔒 只加在读了密钥文件的调用（守护进程新加 `readsSecretFile`）、长路径只留末尾几级、没模板的三处统一"中文名 · 参数值"。主会话看过截图；全量 3747 条通过（1 条 spawn EPERM 单独重跑通过）。压缩合并进 main。
