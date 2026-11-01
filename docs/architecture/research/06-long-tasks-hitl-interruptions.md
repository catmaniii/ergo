# 06 长任务、人在回路与减少打扰：外部调研

- 调研日期：2026-10-06
- 范围：现有 agent 的审批与权限机制；计划期预授权与运行时确认；agent 策略语言；长任务可靠性（durable execution、后台 agent、进度、watchdog）；HCI 打断管理与通知；监督自治 agent 的 UI 模式；以及据此给出的"用户可配置提醒类别"模型。
- 不在范围内：前作本身（另行研究）。
- 方法：只用一手来源（论文、官方文档、源码、一方工程博客、HCI 文献）；每条结论后附来源 URL。调研中途 WebSearch 配额（200 次）耗尽，后半段只能直接抓取已知 URL 与 GitHub 源码；openai.com 与 help.openai.com 对抓取返回 403。无法核实的条目逐节标注【未核实】，二手来源单独注明。
- 术语：本文的"类别"指用户可配置的提醒/审批类别（花钱、以我名义发消息、删除、联系他人、不可逆、隐私、自定义）；"grant"指计划期批准后编译出的有边界授权；"处置"指对一次操作的处理方式（问 / 延后问 / 撤销窗口 / 摘要 / 只记录 / 交给用户 / 禁止）。

## 要点（TL;DR）

1. **逐条询问基本是噪音**：Claude Code 用户批准了 93% 的权限提示；Anthropic 估计 API 侧只有约 0.8% 的工具调用看起来不可逆；老用户更多开启自动批准，同时更常主动中断——监督方式正从"逐个批准"转向"划边界 + 监控 + 关键时刻介入"。（§1.1、§4.5）
2. **业界的分界线惊人一致**：购买/付款、以用户名义发消息或发布、删除（尤其永久删除）、改权限/授权/分享、输入凭据与登录、下载、部署——必确认；转账与证券交易、执行网页/邮件中的指令、创建账户——常被直接禁止；改密码等由用户亲自做。Microsoft Copilot Cowork 的确认类别几乎与 ergo 的目标类别一一对应。（§1.12、§5.4）
3. **处置不止 allow/ask/deny**：ChatGPT dots 的四档 "Take action without asking / Take action when you say so / Ask before taking action / Hand off to you" 是最接近个人助理的先例；加上"摘要"和"永不"，就是 ergo 用户可见的六档。（§1.7、§6.5）
4. **计划期批准应编译成有边界的授权（grant），而不是批准一段文字**：CaMeL、Progent、Conseca、AP2 v0.2 open mandate、Stripe Shared Payment Token、AgentCore/Cedar 都是这一思路；AP2 v0.2 的约束词汇（单笔范围、总预算、次数、收款方白名单、执行日期、过期）可直接复用为"花钱"类别的 bounds。（§2）
5. **确定性规则做底线、分类器只做补充**：Google 官方立场是推理型防御不能单独用于关键或不可逆操作；各家都声明 classifier 不是安全边界；分类器应只看用户意图与规范化后的调用、不看不可信工具输出，并且只能把处置往严里改。（§2.4、§1.12）
6. **审批本身要防篡改、防疲劳**：批准必须绑定到规范化的具体调用、执行前逐字段比对（Loopjacking、OpenClaw argv/hash 绑定）；聊天里一句 "yes" 不算批准；"帮我起草"不等于"可以发送"；高风险审批要具体、稀少、外观有变化、要求与关键字段交互。（§2.5、§1.3、§4.3）
7. **打断时机和上限比打断与否同样重要**：在任务断点投递显著降低挫败感；bounded deferral（按紧急度设最长等待）几乎能消除"忙时打断"；低紧急度批量成每天 2–3 次的摘要，但完全静默反而增加焦虑。（§4.1–4.3）
8. **长任务的可靠性靠"事件日志 + 持久审批 + 幂等副作用"**：pi 有会话持久化，但审批对话是进程内阻塞；ergo 需要自建任务状态机、action ledger、持久化审批（带 deadline 与超时默认）、lease/heartbeat 与卡住检测；不可逆动作崩溃后结果不明时绝不自动重发。（§3）
9. **UI 的关键模式**：可编辑计划卡 + 批准时一并选自治级别；审批收件箱（批准 / 改参数 / 回复 / 忽略）；IM 只推阻塞项且带短 ID、先答先生效；撤销窗口与草稿化；回来时的小结；时间线附证据与撤销入口。（§5）
10. **推荐模型**（§6）：类别 × 处置档位 × 计划期 grant 三维；判定流水线落在 pi `tool_call` 钩子；偏离计划按 L0–L5 阶梯升级；重规划只做增量审批；放宽必须显式、收紧可以自动；用"打扰预算"把运行时打断前移到计划期一次解决。开放决策见 §7。

## 目录

1. 现有 agent 如何处理审批与权限
2. 计划期预授权 vs 运行时确认；策略语言；把类别写成数据
3. 长任务的可靠性
4. HCI：打断管理、通知与人–agent 交互
5. 监督自治 agent 的 UI 模式
6. 综合建议：用户可配置的"提醒类别"模型
7. 需要你拍板的开放决策

---

## 1. 现有 agent 如何处理审批与权限（截至 2026-10-06）

> 说明：openai.com 与 help.openai.com 对抓取返回 403；多数文档页不显示日期，以文中版本号为准（如 Claude Code v2.1.283、Cursor v3.6）。OpenAI 的 Codex 文档 `developers.openai.com/codex/*` 已 308 跳转到 learn.chatgpt.com。

### 1.1 Claude Code（Anthropic）

**Permission modes**（https://code.claude.com/docs/en/permission-modes ）
- `default`（界面称 Manual）：只有读操作免确认。
- `acceptEdits`：自动接受工作目录内的文件编辑及 `mkdir/touch/mv/cp` 等常见文件命令。
- `plan`：只读探索，有专门的 "Review and approve a plan" 流程；批准计划时选择后续模式（"Yes, and use auto mode" / "Yes, manually approve edits" / "No, keep planning"）。
- `auto`：无常规提示，由后台 classifier 审查每个动作。
- `dontAsk`：凡本该提示的调用一律自动拒绝（适合 CI）。
- `bypassPermissions`：跳过提示，只建议在容器/VM 用；root/sudo 下拒绝启动；管理员可用 `permissions.disableBypassPermissionsMode: "disable"` 禁用，`permissions.disableAutoMode` 禁用 auto。
- **默认**：v2.1.283 起交互终端与 VS Code 会话的内置起始模式是 `auto`；`defaultMode: "auto"` 写在项目 `.claude/settings.json` 中不生效，必须写在用户级 `~/.claude/settings.json`（防止仓库自行放权）。

**规则语法与优先级**（https://code.claude.com/docs/en/permissions ）
- `Tool` 或 `Tool(specifier)`，如 `Bash(npm run *)`、`Read(./.env)`、`WebFetch(domain:example.com)`；deny/ask 还支持 `Tool(param:value)`；工具名可通配（`mcp__*`）。
- 判定顺序 **deny → ask → allow**，首个命中的规则决定结果，与具体程度无关；allow 不能给 deny 开例外；显式 ask 规则在任何模式（包括 bypass）都会提示。
- Managed settings 优先级最高；项目内 allow 规则需先接受 workspace trust。

**任何模式都不自动放行的底线**：命中 ask 规则的调用；标记 `_meta["anthropic/requiresUserInteraction"]` 的 MCP tool（https://code.claude.com/docs/en/mcp ）；组织设为 `ask` 的 connector；对 critical path（根、home、工作目录及其父目录）的 `rm/rmdir`（allow 规则与 hook 的 allow 都放不行）；protected paths（`.git`、`.claude`、`.bashrc`、`.npmrc`、`.mcp.json` 等）只有 bypass 能自动写。

**Auto mode classifier**
- 顺序：规则 → 读操作与工作目录内编辑直接放行 → 其余交 classifier；进入 auto 时临时丢弃 `Bash(*)`、`Bash(python*)` 这类等同任意代码执行的宽 allow 规则。
- 默认 block（代表项）：`curl | bash`；敏感数据外发；生产部署与迁移；云存储批量删除；授予 IAM 权限；force push；不可逆地销毁会话开始前已存在的文件；把凭据打印到 transcript；越过内部 registry；未经授权把敏感细节写进 PR/消息等对外内容；带 `--insecure` 之类关闭防护的参数；启动无人审批的其他 agent loop。默认放行：工作目录内本地操作、按 lockfile 装依赖、只读 HTTP、向当前仓库任意分支 push。
- 用户自定义（https://code.claude.com/docs/en/auto-mode-config ）：`autoMode.environment`（声明可信 repo、bucket、域名）、`autoMode.allow`、`autoMode.soft_deny`（用户明确意图可解除）、`autoMode.hard_deny`（无条件拦截），**均为自然语言 prose 规则**；写入 `"$defaults"` 保留内置规则。
- 用户意图的效力：对话中说的边界（"don't push"）视为 block 信号，但会随 compaction 丢失；批准必须"指明动作与具体对象"（只说 "you can force-push" 不算）。
- 回退：连续 3 次或累计 20 次 block 后暂停 auto、恢复人工提示（不可配置）；classifier 拿不到结论时直接拒绝。
- 工程博客（2026-03-25）：**"Claude Code users approve 93% of permission prompts"**；两阶段 classifier（单 token 快筛，命中再走 CoT）；刻意 reasoning-blind（剥掉 Claude 自己的消息与 tool outputs 以抵抗注入）；真实流量 pipeline FPR 0.4%；52 条真实 overeager 动作 FNR 17%；合成外泄数据集 FNR 5.7%；被拦后 deny-and-continue（拒绝作为 tool result 返回，要求 agent "find a safer path"）。https://www.anthropic.com/engineering/claude-code-auto-mode
- classifier 默认跑在 Sonnet 5 上，Enterprise 与 API 账号会消耗 token。

**Hooks**（https://code.claude.com/docs/en/hooks ）：`PreToolUse` 可返回 `permissionDecision: allow|deny|ask|defer` 并用 `updatedInput` 改写参数；`PermissionRequest` 返回 `decision.behavior: allow|deny`；`PermissionDenied` 可返回 `retry`；hook 类型有 `command/http/mcp_tool/prompt/agent`；hook 的 allow **不能**绕过 deny/ask 规则。

**Sandbox**（https://code.claude.com/docs/en/sandboxing ）：只隔离 Bash/PowerShell/Monitor（macOS Seatbelt，Linux/WSL2 bubblewrap+socat，原生 Windows 不可用）；默认可写范围为工作目录与临时目录；网络经代理按 `network.allowedDomains` 放行（默认空）；`autoAllowBashIfSandboxed` 默认 true（沙箱代替提示）；凭据 `mask`——命令里只看到 sentinel，由代理在出站请求中替换。博客（2025-10-20）："sandboxing safely reduces permission prompts by 84%"。https://www.anthropic.com/engineering/claude-code-sandboxing

**异步/远程审批**：Remote Control + 手机推送 "Push when actions required"（https://code.claude.com/docs/en/remote-control ）；Channels permission relay（Telegram 等，仅 allowlist 发送者可批）（https://code.claude.com/docs/en/channels ）。

### 1.2 OpenAI Codex（CLI / IDE / 桌面 / 云）

- **两层控制**：sandbox mode 决定"能做什么"，approval policy 决定"何时问"。https://learn.chatgpt.com/docs/agent-approvals-security
- `approval_policy`：`on-request | never | { granular = {...} }`；`untrusted` 已退役（写了无法启动），`on-failure` 已 deprecated；granular 字段 `sandbox_approval`、`rules`、`mcp_elicitations`、`request_permissions`、`skill_approval`，为 false 的类别自动拒绝。https://learn.chatgpt.com/docs/config-file/config-reference
- `sandbox_mode`：`read-only / workspace-write / danger-full-access`（`--yolo`）。git 仓库默认 "Auto" preset（`workspace-write` + `on-request`），非 git 目录默认 read-only；默认关网（`[sandbox_workspace_write] network_access = true` 开启，可叠加 `features.network_proxy` 做域名 allow/deny）；`.git`、`.agents`、`.codex` 递归只读。
- 会触发审批：写工作区外文件、需要网络的命令、MCP/app tool 声明了 destructive annotation（"always require approval"）。
- 执行策略规则：Starlark `prefix_rule(..., decision = "allow"|"prompt"|"forbidden")`，多条命中取最严（forbidden > prompt > allow）。https://developers.openai.com/codex/agent-configuration/rules
- MCP/app tool 有 `approval_mode`（`auto | prompt | writes | approve`，文档未逐值解释）。
- **Auto-review（classifier 型 reviewer）**：`approvals_reviewer = "auto_review"`（默认 `"user"`）；只审"本来就要人工批准"的动作（越出沙箱、被拦的网络请求、写出可写根、有副作用的 MCP/app 调用、Computer Use 访问新域名）；reviewer 能看 tool outputs 但看不到隐藏推理；熔断：连续 3 次拒绝或最近 50 次中 10 次拒绝即中断当前 turn；`/approve` 可对**确切的那一个**被拒动作授权重试一次。https://developers.openai.com/codex/sandboxing/auto-review
- **开源的默认 guardian policy**：风险分 `low/medium/high/critical`，结合 `user_authorization` 得出结果——low、medium 放行；high 只有在授权至少为 medium 且范围窄时放行；critical 一律拒绝；外泄授权 "must specify the payload … as well as the destination"。企业可用 `guardian_policy_config` 覆盖；ChatGPT 桌面端对应模式叫 "Approve for me"。https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/policy_template.md
- 文档写明 "GPT-6 Astra includes safety monitoring"，异步监控、可能暂停任务。
- Codex Cloud（Legacy）：setup 阶段联网、agent 阶段默认离线；secrets 只在 setup 阶段可用；开网时可设域名 allowlist 并只允许 GET/HEAD/OPTIONS。https://developers.openai.com/codex/cloud/internet-access
- Agents SDK：`needs_approval=True` / `needsApproval` 产出 `interruptions` 与可序列化 state，之后 `state.approve()/reject()` 恢复——适合异步审批。https://developers.openai.com/api/docs/guides/agents/guardrails-approvals

### 1.3 OpenClaw 与 pi

**OpenClaw**
- 三层：Sandbox（在哪执行）、Tool policy（有哪些 tool；deny 永远优先，非空 allow 即白名单）、Elevated（exec 专用逃生口，可越出沙箱到宿主执行）。https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated
- Tool profile `minimal / coding / messaging / full`，本地 onboarding 未配置时默认 `full`。https://docs.openclaw.ai/gateway/config-tools/tool-policy
- `tools.exec.mode`：`deny` / `allowlist`（未命中静默拒绝）/ `ask`（未命中问人）/ `auto`（未命中交 LLM reviewer 给 allow/deny/ask；gateway 上连续 3 次拒绝升级到人工）/ `full`；文档 "Recommended default" 为 `auto`。https://docs.openclaw.ai/tools/permission-modes
- **实际出厂默认**：gateway/node 宿主 `security` 默认 `full`、`ask` 默认 `off`、sandbox 默认关闭；`askFallback` 默认 `deny`（无审批 UI 时一律拒绝）。https://docs.openclaw.ai/tools/exec-approvals
- 有效策略取更严者：approvals 文件只能收紧不能放宽；`strictInlineEval` 开启后 `python -c` 之类即使在 full 下也要审批。
- **审批绑定**：批准绑定 argv、cwd、env 与文件内容 hash，执行前任一项漂移即拒绝。https://docs.openclaw.ai/start/why-openclaw/policy-as-code
- Session permission modes `read-only / guarded / workspace / full`（`full` 需 `operator.admin`）；**改模式会取消挂起中的审批，而不是批准它们**。https://docs.openclaw.ai/gateway/permission-modes
- 审批渠道：Slack/Discord/Telegram/Matrix/Teams 原生按钮或 `/approve <id> allow-once|deny`；原文 **"Free-text replies such as 'yes' never authorize the change"**；待审项默认 30 分钟过期；standing grants 可绑定 agent/任务/命令/目录/环境、带过期、可撤销。https://docs.openclaw.ai/tools/exec-approvals-advanced

**pi**（仓库已从 badlogic/pi-mono 迁到 earendil-works/pi）
- "does not ask for approval before every tool call"，无内置沙箱，建议跑在容器/VM；只有 project trust（`defaultProjectTrust` 默认 `"ask"`）控制是否加载项目内扩展与配置。https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md
- 作者立场：YOLO by default，认为权限弹窗是 "security theater"。https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- 扩展点：`pi.on("tool_call")` 可 `return { block: true, reason }`，handler 出错 fail-safe 为 block；工具带 MCP 风格 `readOnlyHint/destructiveHint/idempotentHint/openWorldHint`，文档给出"按 Codex 逻辑确认"的示例；官方示例有 `permission-gate.ts`（无 UI 时默认 block）、`protected-paths.ts`、`confirm-destructive.ts`、`plan-mode/`。https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- **对 ergo 的含义**：ergo 的提醒类别引擎天然落在 pi 的 `tool_call` 钩子上；但 pi 的 `ctx.ui.confirm` 是进程内阻塞（RPC 模式下等待客户端回应，可带 timeout），长任务需要自建持久化审批（见 §3）。

### 1.4 Cursor

- Run Modes（Settings > Agents > Approvals & Execution）：Auto-review（allowlist 命中直接跑，shell 尽量进沙箱，其余交 classifier）/ Allowlist / Run Everything；v3.6（2026-05-29）起 Auto-review 为推荐默认，"Ask Every Time" 在 v3.5 弃用。https://cursor.com/docs/agent/security/run-modes
- Auto-review classifier 跑在 Cursor 后端（Gemini 3.5 Flash Lite，fallback Claude 4.5 Haiku），可读本地文件辅助判断；被拦后 agent 先换路径，仍坚持才弹给用户；文档明确它 **"not a security boundary"**。
- 规则：`~/.cursor/permissions.json` 或项目 `.cursor/permissions.json`，`autoRun.allow_instructions / block_instructions` 为**自然语言**；团队配置覆盖本地。CLI 规则 `Shell(...)`、`Read(...)`、`Write(...)`、`WebFetch(...)`。https://cursor.com/docs/cli/reference/permissions
- Hooks：`beforeShellExecution`、`beforeMCPExecution`、`preToolUse` 可返回 `permission`（preToolUse 的 `"ask"` 目前不生效）。https://cursor.com/docs/hooks
- 额外保护：Browser Protection、File-Deletion Protection、External-File Protection，开启后自动模式下也要审批；MCP 每次调用默认要批，配置文件修改要批。https://cursor.com/docs/agent/security
- Cloud Agents 不用 Run Modes，"never asks you to approve"，靠 Firecracker microVM、出网 allowlist、Runtime Secrets 脱敏、draft PR 控风险。https://cursor.com/docs/cloud-agent/security
- 数据：Auto-review 约拦截 4% 的动作，约 7% 的对话被打断至少一次（2026-06-11）https://cursor.com/blog/agent-autonomy-auto-review ；"Sandboxed agents stop 40% less often"（2026-02-18）https://cursor.com/blog/agent-sandboxing

### 1.5 Devin（Cognition）

- CLI 模式：Normal（默认，只读免确认，批准时可选 once / session / project）/ Accept Edits / Smart（快速模型判断安全性）/ Bypass / Autonomous（必须配 `--sandbox`）。https://docs.devin.ai/cli/reference/permissions
- **Smart 模式永不自动放行**：包安装、修改仓库的 git 操作、`rm`/`sudo`、`kubectl delete` 与破坏性云 CLI、读写 dotenv/密钥/git config/agent 自身配置。
- 优先级：组织 > session 授权 > 项目 local > 项目 > 用户；组织级 deny/ask 不可覆盖。
- 云端：Security Profiles 管网络 allowlist、MCP、git 权限，被拦时 Devin 请求新域名，批准只对当前 session 有效（https://docs.devin.ai/product-guides/security-profiles ）；每次 deploy 需显式 approve；会话中索要的 secret 只在当前 session 有效且只注入需要它的命令（https://docs.devin.ai/product-guides/secrets ）。
- 计划级审批（旧 release notes，可能已变）：2025-03-25 默认等 30 秒无输入后自动开始；2025-05-15 置信度非绿色时等用户批准。审批可在 Slack/Teams/Linear 处理；后台 subagent 遇未预批准的 tool 自动拒绝。https://docs.devin.ai/llms-full.txt

### 1.6 Manus

- Desktop "My Computer"：每条本地命令都要批（"Allow Once" / "Always Allow"），只能访问授权过的文件夹。https://manus.im/docs/features/desktop
- Cloud Browser：遇 SMS、CAPTCHA、MFA 时提示用户 "Take Over"，提醒可配置。https://manus.im/docs/features/cloud-browser
- 保存登录状态前询问，可整体关闭；Browser Operator 每个 session 需授权，关闭标签页即停止。
- 未查到：购买、发消息前是否确认；是否有 classifier。

### 1.7 ChatGPT agent / Operator / ChatGPT Work / dots

- **Operator system card（2025-01-23）**：风险按严重度与可逆性分级；购物、发邮件、删日历事件等要确认；买卖股票完全禁止；未缓解时 100 个任务出现 13 个错误、其中 5 个不可逆，加入确认后风险降约 90%，确认 recall 92%；主动拒绝银行交易（recall 94%）；**Watch mode**：在邮箱等网站上用户离开或不活跃时自动暂停。https://cdn.openai.com/operator_system_card.pdf
- **ChatGPT Agent system card（2025-07-17）**："finalizing actions that affect the state of the world (e.g., before completing a purchase or sending an email)" 前确认；关键确认 recall：修改权限 100%、高风险通信 99.9%、金融交易 100%；拒绝的任务：转账、受管制商品、赌博、获取或推断高隐私期待的个人信息、基于敏感数据做高风险决策。https://cdn.openai.com/pdf/839e66fc-602c-48bf-81d3-b21eacc3459d/chatgpt_agent_system_card.pdf
- **当前 Browser / ChatGPT Work**：访问新站点前询问（Always ask / Auto approve（先检查相关性）/ Always allow（不推荐））；提交信息、购买、修改权限、删除数据前确认；登录走 secure sign-in form，模型看不到凭据，登录前有 review model 检查是否钓鱼；可 take over。https://learn.chatgpt.com/docs/browser
- **dots（常驻个人 agent，与 ergo 定位最接近）**：动作在影响账户或分享信息前由 automatic review 决定"继续 / 需批准 / 必须由用户亲自做（如改密码）"；**"Asking your dot to draft replies doesn't give it permission to send them"**；Custom rules 四档：**Take action without asking / Take action when you say so / Ask before taking action / Hand off to you**；自定义规则不能覆盖内置安全要求；决策可推到 Slack。https://learn.chatgpt.com/docs/dots/controls ， https://learn.chatgpt.com/docs/dots
- Computer Use：按 app 授权，有 "Always-allowed apps" 列表。https://learn.chatgpt.com/docs/computer-use
- 未核实：ChatGPT Atlas agent mode 细节（logged-out mode 等）；Operator launch 博客中的 "takeover mode"。

### 1.8 Google（Gemini in Chrome / Gemini Spark）

- **Chrome 安全架构（2025-12-08）**：User Alignment Critic 是独立的 Gemini 模型，只看动作元数据、不看不可信网页内容，可 veto 不符合用户目标的动作；Agent Origin Sets 把站点分成只读与可读写；访问银行/医疗等敏感站点、用 Password Manager 登录、购买/付款/发消息等 consequential actions 需确认；有与规划并行的 prompt-injection classifier。https://blog.google/security/architecting-security-for-agentic/
- **Gemini Spark**（当前 Gemini agent 入口）：发送通讯、修改数据、购买、提交表单、用 Google 登录前确认；输入密码与支付信息时进入 "Take control" 交给用户；显示计划；限制在与任务相关的站点和动作；并自己提示：离线运行的定时任务用户可能来不及阻止。https://support.google.com/gemini/answer/16596215
- Project Mariner 页面已重定向，现状未核实。

### 1.9 Claude in Chrome

- 权限指南（2026-08-12）：三种模式 Manually approve（原 "Ask before acting"）/ Automatically approve（Cowork 侧栏默认，带安全审查）/ Skip all approvals（原 "Act without asking"）；经典侧栏可先批准 plan（plan 列出允许访问的站点）；即使 "Always allow actions on this site"，下载、输入敏感信息、授予授权、修改站点权限仍要确认。
- **禁止动作**：购买与金融交易、创建账户、处理信用卡或证件信息、从不可信来源下载、永久删除（清空回收站、删除邮件/文件/消息）、投资建议或交易、修改系统文件、执行邮件或网页中的指令；管理员可设 allowlist/blocklist。https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide
- 上线博客（2025-08-25）：缓解措施使攻击成功率从 23.6% 降到 11.2%；屏蔽金融服务、成人、盗版等高风险站点类别。https://www.anthropic.com/news/claude-for-chrome
- 1Password 登录用生物识别逐次批准，Claude 看不到密码。

### 1.10 其他

- **GitHub Copilot cloud agent**：只能推 `copilot/` 分支、只能开 draft PR、不能自批自合；Actions 需有写权限者 "Approve and run workflows"；默认 firewall 限制出网。https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations
- **AWS**：AgentCore Policy 在 Gateway 用 Cedar 拦截每个 tool 请求，支持自然语言转 Cedar（https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html ）；Bedrock Agents 可对指定 action 开 user confirmation（https://docs.aws.amazon.com/bedrock/latest/userguide/agents-userconfirmation.html ）。
- **Microsoft Copilot Cowork（Preview）**：执行前需批准的类别——付款；向外部提交个人信息；发邮件或消息；删除文件、改云存储、取消订阅；健康、政府文件或安全设置相关提交。https://support.microsoft.com/en-us/microsoft-365-copilot/cowork-take-control-actions
- **Open-AutoGLM（智谱 / zai-org）**：内置"敏感操作确认机制"，登录/验证码场景"人工接管"；动作集含 `Take_over`；SDK 回调 `confirmation_callback` / `takeover_callback`；遇支付、银行等敏感页面截图黑屏时自动请求人工接管。https://github.com/zai-org/Open-AutoGLM

### 1.11 对比表

| 产品 | 审批粒度 | 默认 | 规则语言 | 分类器/规则 | 沙箱 | 计划级审批 | 异步/远程审批 |
|---|---|---|---|---|---|---|---|
| Claude Code | 单次 tool call（工具、参数、路径、域名） | `auto`（v2.1.283+ 交互会话） | `Tool(spec)` glob + autoMode 自然语言 + hooks | 混合：规则先，其余 classifier | Seatbelt/bwrap，文件+网络代理+凭据 mask | 有（plan mode） | 手机推送、Remote Control、channel relay、http hook |
| Codex | 越出沙箱的动作、prefix_rule、MCP/app tool | Auto（workspace-write + on-request） | Starlark `prefix_rule`、granular、guardian policy | 可选 `auto_review` | Seatbelt/bwrap+seccomp/Windows；默认关网 | 未查到 | 桌面端审查；SDK interruptions |
| OpenClaw | 每条宿主命令（绑定 argv/cwd/hash）+ tool 名 | exec `full`/ask `off`（文档推荐 `auto`） | allowlist glob、tool allow/deny/group | 可选 LLM reviewer | Docker/Podman/SSH | 无 | 聊天渠道按钮、`/approve`；无 UI 时 deny |
| pi | 无内置，扩展自定 | YOLO | TS 扩展（`tool_call`） | 无 | 无（建议容器） | 示例扩展 | 扩展自行实现 |
| Cursor | shell/MCP/Fetch 单次 | Auto-review（v3.6+） | allowlist + 自然语言 `permissions.json` | classifier（非安全边界） | Seatbelt/Landlock | 有 Plan Mode | 云 agent 不审批 |
| Devin | CLI 单次；云端按 session 事件 | Normal（CLI） | `Read/Write/Exec` JSON | Smart 快速模型 + 永不自动类别 | CLI `--sandbox`；云 VM | 有（可关闭） | Slack/Teams/Linear |
| Manus | 每条本地命令 | 云端自主 | 未查到 | 未查到 | 云 VM/浏览器 | 未查到 | Take Over 通知 |
| ChatGPT agent/Work/dots | consequential action + 网站级 | 网站 Always ask | dots 四档自然语言规则 | 训练 + 自动审查 + 钓鱼审查 | 云浏览器/VM | 未查到 | 手机、web、Slack |
| Gemini Spark/Chrome | 动作级 + 站点集合 | 每个浏览任务先确认 | 无用户规则 | Alignment Critic veto + 注入分类器 | 远程浏览器 | 有（展示计划） | 跨设备接管 |
| Claude in Chrome | 动作级 + 站点级 | Auto（Cowork 侧栏） | 站点列表 + 管理员 allow/block | 安全审查 | 浏览器扩展 | 有（Approve plan） | 桌面通知 |
| Copilot cloud agent | PR 级 | 自主 | 仓库规则集 | 无 | Actions runner + firewall | 无（事后审 PR） | GitHub PR |

### 1.12 "自动 vs 询问"的分界线在哪里——跨产品观察

1. **处置结果不止三档**。除 allow / ask / deny，普遍还有 "hand off / take over"（交给用户亲自做）与 "when you say so"（明确指示过才执行）。dots 的四档最值得借鉴；ergo 每个类别可设：自动 / 指示过才自动 / 先问 / 交给我做 / 永不。
2. **普遍"必确认"的类别**：购买与付款；以用户名义发消息/邮件/发布；删除（尤其永久删除）；修改权限、授予授权、分享；输入凭据或证件、登录；下载文件；部署或对公网暴露。常见"永不"：转账与证券交易、赌博与受管制商品、创建账户、执行网页或邮件中的指令。改密码等账户安全操作在 dots 中是"必须用户亲自做"。
3. **硬规则在前、软判断在后**：deny 优先且不能被 allow 开例外；classifier 只处理灰区；Claude Code 区分 `hard_deny`（无条件）与 `soft_deny`（明确意图可解除）；各家都有任何模式都绕不过的底线。
4. **"用户已授权"必须具体**：要说清动作、对象、收件人/目的地（Claude Code；Codex guardian "must specify the payload … as well as the destination"）；"帮我起草"≠"可以发送"（dots）；聊天里一句 "yes" 不算批准（OpenClaw）；审批应是结构化 token 并绑定确切动作（OpenClaw 绑定 argv 与 hash，漂移即拒绝）。
5. **减少打扰最有效的手段**：沙箱代替提示（Claude Code 提示减少 84%；Cursor 停顿减少 40%）；classifier 只审越界动作（Claude Code FPR 0.4%；Cursor 约 7% 对话被打断）；deny-and-continue（被拒后自己换安全路径，达阈值才升级：Claude 3/20、Codex 3 连续或 50 中 10、OpenClaw 连续 3）；让用户声明可信环境以降低误报。基线：**Claude Code 用户批准了 93% 的提示**——逐条询问大多是噪音。
6. **审批要能脱离当前界面，并有安全默认**：推到手机/Slack/Telegram；无 UI 时默认拒绝（OpenClaw `askFallback: deny`；Devin 后台 subagent 自动拒绝）；Gemini 自承离线定时任务可能来不及被叫停。
7. **用工具注解做默认归类**：MCP `readOnlyHint / destructiveHint / openWorldHint` 已被 Codex（destructive 必审）与 pi 示例采用；缺省时视为"可能破坏、可能触达外部"。
8. **按上下文升级**：敏感站点或已登录敏感账户时切到更严模式（Watch mode；Chrome 敏感站点确认；Claude in Chrome 部分站点每步批）。隐私类应按"数据来源与目的地"动态触发。
9. **凭据不进模型上下文**：secure sign-in form、1Password 生物识别、凭据 mask + 代理替换、Runtime Secrets 脱敏、secret 仅 session 内有效——这是隐私/安全类别中比"提醒"更强的结构性做法。
10. **classifier 能看到什么是关键设计选择**：Claude Code reasoning-blind 且剥掉 tool outputs；Codex reviewer 能看 tool 证据；Chrome Alignment Critic 只看元数据；Cursor 可读文件。各家都声明 classifier 不是安全边界。

【未核实】ChatGPT Atlas agent mode；Operator "takeover mode" 原文；Project Mariner 现状；Manus 购买/发送确认与 classifier；Devin 云端计划审批现状；Codex `approval_mode` 各值语义与手机端远程审批；Cursor 计划级审批是否强制。

---

## 2. 计划期预授权 vs 运行时确认；策略语言；把类别写成数据

### 2.0 结论速览

1. 学术界和工业界正在收敛到同一个范式：**用户在计划期批准的不应是一段文字计划，而是一份可由机器校验的"授权包络"**（工具/类别、参数约束、金额、收件人、次数、过期时间）。运行时由确定性代码逐个 tool call 检查：包络内静默执行，越界才回到人。CaMeL、Progent、Conseca、AP2 的 open mandate、AgentCore Policy 都是这一思路（下文逐条）。
2. **确定性规则 vs 分类器**：一手来源的共识是分层组合——确定性规则负责硬边界与可数值化的约束；LLM 分类器负责语义模糊的类别（"是否涉及隐私""算不算联系陌生人"）；分类器不能看不可信的 tool output，它的放行也不能变成持久授权。Google 的官方立场同样如此（§2.4）。
3. **AP2 已更新**：2026-04-28 的 v0.2 不再使用 Intent Mandate / Cart Mandate 这对名词，改为 open / closed 的 Checkout Mandate 与 Payment Mandate；其约束词汇（`amount_range`、`budget`、`agent_recurrence.max_occurrences`、`allowed_payees`、`execution_date`、`exp`）几乎可以直接当作 ergo "花钱"类别的 bounds schema。

### 2.1 Plan-then-execute 与计划级授权

**Beurer-Kellner et al. 2025《Design Patterns for Securing LLM Agents against Prompt Injections》**
- 核心原则："once an LLM agent has ingested untrusted input, it must be constrained so that it is *impossible* for that input to trigger any consequential actions"。六种模式：Action-Selector、Plan-Then-Execute、LLM Map-Reduce、Dual LLM、Code-Then-Execute、Context-Minimization。
- Plan-Then-Execute 的边界：示例 "send today's schedule to my boss John Doe"，计划在读不可信数据前就固定为 `calendar.read(today)` 与 `email.write(____, "john.doe@company.com")`，注入无法让 agent 偏离计划；但它**防不住用户 prompt 本身的注入**，且不可信数据 "could, however, arbitrarily alter the body of the email to be sent"。
- 关于人工确认：它 "can significantly impact system automation and usability, and pose a safety risk themselves with tired or overloaded human verifiers approving unsafe actions"。
- **对 ergo**：计划能锁定"做哪些动作、发给谁"，锁不住内容；内容敏感（隐私类）需要另加出站检查。
- https://arxiv.org/abs/2506.08837

**CaMeL（Debenedetti et al., Google DeepMind, arXiv 2503.18813）**
- 机制：P-LLM 只看用户 query 并写成 Python 程序（控制流）；Q-LLM 无工具，只把不可信数据解析成结构化输出；每个值带 capabilities（provenance：来自 User / CaMeL / 某 tool；allowed readers）。
- Policy 是 Python 函数，"takes the tool name and arguments as input and returns a SecurityPolicyResult expressed as Allowed or Denied, along with a reason"。论文 Fig. 6 示例：
  ```python
  if not all(participant in data.allowed_readers for participant in event.participants):
      if all(participant_source == "User" for participant in event.participants):
          return Allowed()
      return Denied("Participants lack access to event data")
  return Allowed()
  ```
  Travel suite 的 send_email 策略："Recipients must come from the user, email body, subject and attachments must be readable by all recipients"。
- **计划期与运行期**：§5.2 原文 "In a real-world application, executions that violate security policies will not be blocked, but they will require user confirmation." 即 policy 划出预批准区域，越界才需要运行时确认。
- 数字：AgentDojo 上 77% 任务在 provable security 下完成（无防御 84%）；中位任务 input token 2.82 倍、output 2.73 倍。Workspace suite 拒绝"relatively small amount of times"，Slack 与 Banking suite 拒绝率明显更高（send_money 要求收款方只能来自 User）。论文未给逐任务确认比例。
- 自述局限：用户需要 "codify and specify security policies and maintain them"；可能导致 user fatigue；仍有 side channels。
- https://arxiv.org/abs/2503.18813 ，代码 https://github.com/google-research/camel-prompt-injection

**Progent（Shi et al., arXiv 2504.11703, v3 2026-05）**
- 抽象语法 `Policy P := E t when { ei } fallback f priority n`（Effect 为 allow/forbid；条件支持比较、成员、regex），实现基于 JSON Schema。官方代码中的数据结构原文：
  ```python
  security_policy = None  # {"tool_name": [(priority, effect (0: allow; 1: forbid), condition, fallback (0: return msg; 1: terminate; 2: user confirm))]}
  ```
- **LLM 生成 policy**：初始 policy 由 LLM 根据用户任务生成（尚未接触不可信数据）；运行中由 LLM 提议更新（提议时排除 tool 结果）；用 Z3 判断更新是收窄还是放宽——"the agent's action space can only narrow without approval (monotonic confinement)"，收窄自动生效、放宽需批准。生成 prompt 原文："Do not use any information you cannot find in the user's query"。
- fallback：终止 / 交给用户决定 / 返回错误让 agent 换路径（默认第三种）。
- 数字（v3）：AgentDojo ASR 39.9% → 1.0%，utility 基本保持；ASB 70.3% → 3.9%。
- 局限：用户误批放宽请求、初始任务表述含糊都会导致过度放行；只管 tool call。
- https://arxiv.org/abs/2504.11703 ， https://github.com/sunblaze-ucb/progent

**Conseca（Tsai & Bagdasarian, Google, arXiv 2501.17070, HotOS 2025）**
- 针对每个任务 just-in-time 由只看可信上下文的 LLM 生成 policy，执行时由 enforcer "deterministically evaluating policy constraints"。示例：
  ```
  API Call: send_email
  Can Execute: True
  Args Constraint: re.search(r'alice', $1) ∧ re.search(r'^.*@work\.com', $2) ∧ re.search(r'.*urgent.*', $3)
  Rationale: "We need to send urgent responses to emails..."
  ```
- **计划期审批**："Developers can optionally ask users to approve a task's policy prior to agent task execution, given the constraints and their human-readable rationales"——与 ergo 的计划期审批完全对应。20 个任务中 Conseca 完成 60%，不受限 agent 70%。
- 产品化差异（源码阅读，仅读前约 90 行）：Gemini CLI 于 2026-02-24（PR #13193）引入 Conseca，但 constraints 为自然语言、`permissions` 取 `"allow" | "deny" | "ask_user"`，enforcer 由 Gemini Flash 判断（**非确定性**），且在拿不到 tool name 等情况下默认 ALLOW（fail-open）。https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/safety/conseca/policy-generator.ts

**AgentSpec / ShieldAgent / GuardAgent**
- AgentSpec（ICSE 2026）：trigger / check / enforce DSL，例如
  ```
  rule @inspect_transfer
  trigger Transfer
  check !is_to_family_member
  enforce user_inspection
  end
  ```
  enforce 可选 `user_inspection`、`llm_self_examine`、`invoke_action`、`stop`；代码场景拦截 90% 以上不安全执行，毫秒级开销；用 o1 自动生成规则时 embodied 场景 precision 95.56%、recall 70.96%。这正是"按类别触发提醒"的规则形态。https://arxiv.org/abs/2503.18666
- ShieldAgent（arXiv 2503.22738）从政策文档抽规则成 probabilistic rule circuits，recall 90.1%；GuardAgent（ICML 2025）把安全要求转成 guardrail 代码，EICU-AC 98%、Mind2Web-SC 83%。https://arxiv.org/abs/2503.22738 ， https://arxiv.org/abs/2406.09187

**Task Shield（Jia et al., ACL 2025）**——偏离检测：测试时逐个检查每条指令与 tool call 是否服务于用户指定目标；AgentDojo 上 GPT-4o 的 ASR 2.07%、utility 69.79%。https://arxiv.org/abs/2412.16682 。LlamaFirewall 的 AlignmentCheck 是同类思路（§2.3）。

### 2.2 委托、令牌、MCP 与支付授权：现成的"有界委托"协议

- **Authenticated Delegation（South et al. 2025）**：user ID token、Agent-ID token、Delegation Token（用户签名、带过期与撤销）；主张把自然语言权限翻译成 XACML/ODRL 等结构化策略，"The user reviews, corrects if necessary, and finalizes the policy"；自述风险：自然语言歧义、prompt injection 让 LLM "generating or accepting policies that exceed the original user's intent"、contextual drift。https://arxiv.org/abs/2501.09674
- **OAuth RAR（RFC 9396）**：`authorization_details` 表达细粒度授权，例如 `{"type":"payment_initiation","actions":["initiate","status","cancel"],"instructedAmount":{"currency":"EUR","amount":"123.50"},"creditorName":"Merchant A",...}`。https://www.rfc-editor.org/rfc/rfc9396.html
- **draft-niyikiza-oauth-attenuating-agent-tokens-00**（2026-03，个人草案）：按工具的参数约束词汇 `exact`、`pattern`、`range`、`one_of`、`not_one_of`、`cel`；"A derived token MUST NOT authorize tools that the parent did not authorize"，`derived.exp ≤ parent.exp`。https://datatracker.ietf.org/doc/html/draft-niyikiza-oauth-attenuating-agent-tokens-00
- **MCP 授权（2026-07-28 版）**：基于 OAuth 2.1 + RFC 8707；运行中权限不足返回 `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="files:write"`，客户端 SHOULD 走 step-up authorization——现成的"先给最小权限、越界再升级"协议；且应 "include all scopes required for the current operation in a single challenge"。https://modelcontextprotocol.io/specification/latest/basic/authorization
- **MCP elicitation**：form 与 url 两种模式，用户可 `accept` / `decline` / `cancel`；敏感信息 MUST 走 URL mode（不经过 LLM 与 client）。https://modelcontextprotocol.io/specification/latest/client/elicitation
- **MCP ToolAnnotations**（2026-07-28 schema 未变）：`readOnlyHint`（默认 false）、`destructiveHint`（默认 true，仅在非只读时有意义）、`idempotentHint`（默认 false）、`openWorldHint`（默认 true）；原文 "Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers"。工具规范还要求："there SHOULD always be a human in the loop with the ability to deny tool invocations"，客户端 SHOULD "Prompt for user confirmation on sensitive operations"、"Show tool inputs to the user before calling the server"、"Log tool usage for audit purposes"。https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts ， https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- **AP2（Agent Payments Protocol）**——最直接的计划期有界预授权范例：
  - v0.1（2025-09-16）`IntentMandate`：`user_cart_confirmation_required` 默认 True（"If false, the agent can make purchases on the user's behalf once all purchase conditions have been satisfied. This must be true if the intent mandate is not signed by the user."）；`natural_language_description`（"generated by the shopping agent, and confirmed by the user"）；另有 `merchants`、`skus`、`requires_refundability`、`intent_expiry`。**v0.1 源码中没有价格上限字段**（与部分二手文章说法不符）。https://github.com/google-agentic-commerce/AP2/blob/e66fc0b8f3f3c69fbabae721a4c57a18cf28c4b7/src/ap2/types/mandate.py
  - v0.2（2026-04-28，现行）：Human Present 时用户直接批准 closed mandate；Human Not Present 时 "The User sees and approves a set of constraints"（open mandate），之后 agent 用自己的密钥签 closed mandate，验证方逐条检查 closed 是否满足 open 约束。Open Payment Mandate 约束：`payment.amount_range`（currency/max/min）、`payment.budget`、`payment.agent_recurrence`（frequency/max_occurrences）、`payment.allowed_payees`、`payment.allowed_payment_instruments`、`payment.execution_date`（not_before/not_after）、`payment.reference`，外加 `exp` 与 `cnf`（绑定 agent 公钥）；Open Checkout Mandate 有 `checkout.allowed_merchants`、`checkout.line_items`。
  - 关键规则（原文）："Any unknown Constraints MUST be treated as failing evaluation"（fail-closed）；"It is RECOMMENDED to set the `exp` claim ... to the smallest value that will allow the Shopping Agent to complete the assigned task"；"Shopping Agents MUST NOT present any subsequent open Payment or Checkout Mandates without receiving a rejection receipt from the previous one"（防重复花费）；"The agent reduces the scope of the open mandate based on the receipt"（额度逐步消耗）；Trusted Surface "MUST be non-agentic"（批准界面由确定性代码渲染）；验证方返回 `unresolved_constraint` 时可 "bringing the User back into the loop to approve the closed Mandates"（越界回到 human-present）。https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/specification.md
- **Stripe Shared Payment Token（ACP，与 OpenAI 共同制定）**：agent 为每笔交易签发 SPT，限定 `seller_details[network_business_profile]`、`usage_limits[currency]`、`usage_limits[max_amount]`、`usage_limits[expires_at]`；可随时 `revoke`；状态 `active` / `requires_action`（如 3DS 需要用户本人完成）/ `deactivated`；有 `shared_payment.issued_token.used` 等 webhook。——支付通道层的有界委托，且发卡侧仍可强制用户 step-up。https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens
- **Visa Intelligent Commerce**：agent-specific payment tokens，用户用 Passkey 认证指令，控制措施 "ensure that the request originates from the intended merchant for the correct amount"；页面未列出具体限额字段。https://developer.visa.com/capabilities/visa-intelligent-commerce 。Mastercard Agent Pay 官网 403，未核实。
- **消费级先例**：Amazon Alexa 语音购物可设为关闭 / 需 4 位语音码 / 仅限识别出的声音。https://www.amazon.com/gp/help/customer/display.html?nodeId=GAA2RYUEDNT5ZSNK 。Apple App Intents 由开发者在 intent 中调用 `requestConfirmation()`，并以 `IntentAuthenticationPolicy`（`alwaysAllowed` / `requiresAuthentication` / `requiresLocalDeviceAuthentication`）声明每个动作的认证级别。https://developer.apple.com/documentation/appintents/appintent/requestconfirmation() ， https://developer.apple.com/documentation/appintents/intentauthenticationpolicy

### 2.3 策略语言与护栏框架

- **Invariant Guardrails**（2025-06 被 Snyk 收购，仓库仍更新）：类 Python 规则，`->` 表达跨 tool 数据流，可调用分类器 detector，通过 Gateway（MCP 或 LLM proxy）拦截：
  ```python
  raise "Don't use send_email after get_website" if:
      (output: ToolOutput) -> (call2: ToolCall)
      output is tool:get_website
      prompt_injection(output.content, threshold=0.7)
      call2 is tool:send_email
  ```
  ——确定性规则 + 分类器打分的混合规则典型。https://github.com/invariantlabs-ai/invariant
- **NeMo Guardrails**：rails 类型 input / retrieval / dialog（Colang）/ execution / output；tool-calling rails（`rails.tool_output.flows`、`rails.tool_input.flows`）**只做结构校验**（白名单、schema、调用与结果对应），原文 "does not enforce response schemas or apply content-safety checks"；flow 名写错会静默回退导致失效；无人工审批机制。https://docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/tool-calling
- **Cedar / AWS Bedrock AgentCore Policy**（2026-03 GA，GA 时间由 URL 推断）：Gateway 拦截每次 tool call，default-deny、forbid 优先；schema 由工具定义自动生成；自动推理可检出"永远允许/永远拒绝"；提供自然语言 → Cedar 的 authoring service（生成后 schema 校验 + 自动分析）。示例：
  ```
  permit (principal is AgentCore::OAuthUser, action == AgentCore::Action::"ApplyBulkDiscount", resource)
  when {principal.hasTag("customer_tier") && principal.getTag("customer_tier") == "Platinum" && context.input.orderQuantity >= 50}
  ```
  博客理由："the LLM's plan is the thing you can't trust"。**Dogwood temporal policies**（兼容 Cedar）是最贴近"计划期批准、运行中计数累计"的工业实现：
  ```
  permit (principal, action == AgentCore::Action::"TradingTarget___SellShares", resource == ...)
  when temporal {
      formerly within 1h AgentCore::Action::"TradingTarget___ApproveSale"::response{
          eventResource: resource, input.stock: context.input.stock,
          input.shares: context.input.shares, output.approved: true }
  };
  ```
  算子 `formerly within`、`since within`、`count`、`sum`；时间窗最长 24h、每 engine 最多 20 条 temporal policy、修改 policy 会让当前 session 失效（409）；可先 `LOG_ONLY` 观察再 `ENFORCE`。https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html ， https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-temporal.html ， https://aws.amazon.com/blogs/security/why-policy-in-amazon-bedrock-agentcore-chose-cedar-for-securing-agentic-workflows/
- **OPA/Rego 用于 agent 工具授权**：本次未找到可核实的一手资料。
- **LangChain HumanInTheLoopMiddleware**（"类别即数据"的例子）：
  ```python
  HumanInTheLoopMiddleware(interrupt_on={
      "write_file": {"allowed_decisions": ["approve", "edit", "reject"], "when": writes_outside_workspace},
      "execute_sql": {"allowed_decisions": ["approve", "reject"], "when": is_write_query},
  })
  ```
  decision 有 `approve` / `edit` / `reject` / `respond`；`when` 谓词按参数决定是否中断；需 checkpointer，恢复用 `Command(resume={"decisions":[...]})`。https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- **OpenAI Agents SDK**：`@tool(needs_approval=True)` 或传入 `async def requires_review(_ctx, params, _call_id) -> bool`；中断出现在 `RunResult.interruptions`，`state.approve(...)` / `state.reject(...)` 后恢复；`always_approve=True` / `always_reject=True` 在本次 run 剩余时间对该工具持续有效；**fail-closed**：参数缺失或 JSON 畸形时 "the callable is not invoked and the call requires manual approval"。https://openai.github.io/openai-agents-python/human_in_the_loop/
- **Gemini CLI Policy Engine**（另一个成熟的"类别即数据"实现）：
  ```toml
  [[rule]]
  toolName = "run_shell_command"
  mcpName = "my-custom-server"
  toolAnnotations = { readOnlyHint = true }
  argsPattern = '"command":"(git|npm)'
  decision = "ask_user"
  priority = 10
  denyMessage = "Deletion is permanent"
  modes = ["default", "autoEdit", "yolo"]
  ```
  分层优先级 Admin > User > Workspace > Extension > Default；可按 `toolAnnotations` 匹配。https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md
- **LlamaFirewall AlignmentCheck（Meta, arXiv 2505.03574）**：输入用户目标、轨迹与当前动作，由 LLM 判断是否 goal hijacking。AgentDojo：无防御 ASR 17.63%、utility 47.73%；AlignmentCheck 2.89% / 43.09%；PromptGuard 2 + AlignmentCheck 1.75% / 42.68%。自述局限：需要大模型、小模型误报高、有延迟、"AlignmentCheck itself can be targeted by prompt injections"。https://arxiv.org/abs/2505.03574
- **Claude Code auto mode**（分类器范例，也是规则与分类器分层的范例；2026-03-25 工程博客）：动机是 "Claude Code users approve 93% of permission prompts"；流程：只读工具固定白名单 → 项目内文件编辑免检 → 进入 auto mode 时丢弃等同任意代码执行的宽泛 allow 规则 → 其余动作进两阶段分类器；分类器 "strip out Claude's own messages and tool outputs, making it reasoning-blind by design"；真实流量下整条管线 FPR 0.4%，真实 "overeager" 样本（n=52）FNR 17%，合成数据外泄样本 FNR 5.7%；主要难点是判断用户同意是否覆盖该动作的 blast radius；配置 `autoMode.hard_deny` / `soft_deny` / `allow` / `environment` 都是自然语言 prose 规则，"明确意图"需要 named + specifics，授权默认只覆盖一次动作；原文 "Boundaries are not stored as rules ... a boundary can be lost if context compaction removes the message that stated it. For a hard guarantee, add a deny rule"；autoMode 配置不从项目目录读取，以防 "a checked-in repo or a build step could otherwise inject its own allow rules"。https://www.anthropic.com/engineering/claude-code-auto-mode ， https://code.claude.com/docs/en/auto-mode-config

### 2.4 规则 vs 分类器：一手来源对取舍的表述

**Google《An Introduction to Google's Approach for Secure AI Agents》（2025-05）**给出了最清晰的两层架构：
- 三原则：agent 必须有明确的人类控制者；能力必须受限（"General-purpose agents need mechanisms to dynamically confine their capabilities at runtime ... (for example, disallowing file deletion actions when the task is creative writing)"）；动作与规划必须可观察。
- "For actions deemed critical or irreversible--such as deleting large amounts of data, authorizing significant financial transactions, or changing security settings--the system should require explicit human confirmation before proceeding"。
- **Layer 1 runtime policy engine**：拦截 "send email""purchase item" 等动作，按 "the action's inherent risk (Is it irreversible? Does it involve money?), the current context, and potentially the chain of previous actions (Did the agent recently process untrusted data?)" 评估，输出 allow / block / require user confirmation。示例："automatically blocking any purchase action over $500 or requiring explicit user confirmation via a prompt for purchases between $100 and $500"；"prevent an agent from sending emails externally if it has just processed data from a known suspicious source, unless the user explicitly approves"。局限：难以扩展，缺乏上下文（"summarize and send" 与 "exfiltrate" 难区分）。
- **Layer 2 reasoning-based defenses**：guard 分类器；"By analyzing the agent's proposed plan of action, a model might predict the probability of that plan leading to an undesirable outcome, potentially flagging high-risk plans for review"；但 "non-deterministic and cannot provide absolute guarantees ... inadequate, on their own, for scenarios demanding absolute safety guarantees, especially involving critical or irreversible actions. They must work in concert with deterministic controls."
- https://research.google/pubs/an-introduction-to-googles-approach-for-secure-ai-agents/ （PDF https://storage.googleapis.com/gweb-research2023-media/pubtools/1018686.pdf ）

| 维度 | 确定性规则 | LLM 分类器 |
|---|---|---|
| 抗注入 | CaMeL、Progent 可给出可证明/可形式化保证；AgentCore 博客认为 prompt 层控制 "can be bypassed by prompt injection or hallucination" | LlamaFirewall 承认分类器本身可被注入；Claude Code 靠剥离 tool output 缓解 |
| 精度与覆盖 | CaMeL 在 Slack/Banking 拒绝率高；AgentSpec 自动规则 recall 约 71% | 能识别语义，但 auto mode 真实 overeager 样本 FNR 17% |
| 可解释与审计 | Cedar 可自动推理；Conseca 规则附 rationale | 只有 reason 字符串；prose 规则难形式化验证 |
| 成本与延迟 | 毫秒级 | 需要大模型；auto mode 用两阶段压成本 |
| 编写负担 | CaMeL 自述 "codify and maintain" 负担重，所以 Progent、Conseca、AgentCore 都用 LLM 起草再由人/求解器校验 | 写 prose 即可（Claude Code 提供 `claude auto-mode critique` 检查规则） |

**混合方案实例**：Invariant（流规则中调用 `prompt_injection()` 打分）；Magentic-UI（开发者标注 irreversibility always / never / maybe，maybe 档交 LLM judge；开源版 `approval_policy` 取 `auto_approve` / `require_approval_untrusted`（默认）/ `require_approval_all`）https://github.com/microsoft/magentic-ui/blob/main/docs/configuration.md ；Claude Code（deny/ask 规则先执行，分类器第二道门）。

**用户偏好学习的先例**（移动权限研究）：
- Wijesekera et al.（USENIX Security 2015，36 人、2700 万数据点）：至少 80% 参与者想阻止至少一次权限请求，总体希望阻止超过三分之一的请求——静态授权与真实偏好差距很大。https://www.usenix.org/conference/usenixsecurity15/technical-sessions/presentation/wijesekera
- Wijesekera et al.（IEEE S&P 2017，131 人纵向研究）：ask-on-first-use 无法覆盖上下文变化；基于上下文与历史决策的分类器预测用户隐私决策准确率 96.8%，错误率比现有系统降低四倍；目标正是 "automatically grant appropriate resource requests without further user intervention, deny inappropriate requests, and only prompt the user when the system is uncertain of the user's preferences"。https://arxiv.org/abs/1703.02090
- Liu et al.（SOUPS 2016，n=72）：个性化隐私助手的推荐 78.7% 被采纳，之后只有 5.1% 被改回。https://www.usenix.org/system/files/conference/soups2016/soups2016-paper-liu.pdf
- **隐私类不能靠模型自律**：PrivacyLens（NeurIPS 2024 D&B）在发邮件、发帖等 agent 轨迹中，GPT-4 与 Llama-3-70B 即使加了隐私增强指令仍分别有 25.68% 与 38.69% 的情况泄露敏感信息。https://arxiv.org/abs/2409.00138 。AirGapAgent（CCS 2024）用 contextual integrity 把 agent 限制在任务所需数据上，在上下文劫持攻击下保护率 97%（基线 Gemini Ultra 从 94% 跌到 45%）。https://arxiv.org/abs/2405.05175

### 2.5 审批本身的安全性

- **Loopjacking（arXiv 2609.21081，2026-09-17）**：人批准的是操作 A，实现却把这个决定用于实质不同的操作 B。两类攻击：表示层（B 在审批界面被省略或误述）与审批后状态替换（可变的工作流状态在批准后把操作换掉）；在 Agno AgentOS（≤3.0.9）与 LangGraph Agent Server（≤0.14.0）上复现；缓解：完整、规范化的审批渲染 + 执行时逐字段比对；禁止未授权修改挂起中的工作流状态；OpenAI Agents SDK 因序列化续跑保留调用级绑定而能抵抗。https://arxiv.org/abs/2609.21081
- **OWASP Top 10 for Agentic Applications（2025-12-09）**：ASI09 Human-Agent Trust Exploitation——"polished explanations misled human operators into approving harmful actions"；ASI10 Rogue Agents 以 Replit 删库为例。https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/ 。（早先 OWASP《Agentic AI Threats and Mitigations》中有 "Overwhelming Human in the Loop" 威胁，此处仅见二手描述。）
- **OpenAI《Practices for Governing Agentic AI Systems》（2023-12）** §4.2：用户必须批准很多决定时 "must make each approval quickly, reducing their ability to meaningfully consider each one"；开放问题之一是 "best practices for users reviewing approvals for high-cost actions (such as minimum review times) to avoid their turning into a 'rubber stamp'"；还建议长时间无监督运行的 agent 周期性 "time out" 直到人类复核并重新授权；硬编码限制可能被绕过（agent 发邮件说服人类去做被禁止的动作）。§4.4："Actions that can only be reviewed after the fact should be more easily reversible than those that require approval."（ledger of actions 是比审批更轻的手段）§4.7：能对"某一类动作"做 graceful shutdown（如撤销金融凭据），并预先构造 fallback（例如会议邀请只发出两封时被终止，应自动通知已邀请者）。https://cdn.openai.com/papers/practices-for-governing-agentic-ai-systems.pdf

### 2.6 方案对比

| 方案 | 表达力 | 谁写 policy | 执行点 | 确定性 | 支持计划期限定范围 |
|---|---|---|---|---|---|
| CaMeL | Python 函数 + 数据流（provenance、readers） | 开发者 | 解释器，每次 tool call 前 | 是 | 隐式（P-LLM 程序即计划） |
| Progent | 按工具 JSON Schema 条件、priority、fallback | 通用部分人写，任务部分 LLM 生成 | 每次 tool call 前 | 是（更新经 SMT 检查） | **是**，只能单调收窄 |
| Conseca（论文） | 声明式参数约束 + rationale | 只看可信上下文的 LLM | 每次 tool call 前 | 是 | **是**，可执行前让用户审批 |
| Conseca（Gemini CLI） | 自然语言 constraints，allow/deny/ask_user | LLM | 每次 tool call 前 | **否** | 是 |
| AgentSpec | trigger/check/enforce DSL | 开发者或 LLM | 运行时事件 | 是 | 否 |
| Invariant | 类 Python 规则、流 `->`、detector | 开发者 | Gateway/proxy | 混合 | 否 |
| NeMo tool rails | 白名单 + schema | 开发者 | IORails | 是 | 否 |
| Cedar / AgentCore | principal/action/resource/context | 开发者，可从自然语言生成 | Gateway | 是，可形式分析 | 部分（Dogwood 可引用此前批准事件） |
| AP2 open mandate | 金额、预算、次数、收款方、日期、exp | **用户在 Trusted Surface 签署** | 验证方 | 是，未知约束视为失败 | **是**，核心设计 |
| Stripe SPT | 商户、币种、最大金额、过期 | agent 签发 | Stripe | 是 | 是（单笔） |
| OAuth RAR / AAT / MCP scope | authorization_details 或 scope + 参数约束 | AS 或用户同意 | RS/Gateway | 是 | 是（step-up、衰减） |
| LangChain HITL | 按工具 decision 集 + `when` | 开发者 | middleware | 是 | 否 |
| OpenAI Agents SDK | bool/callable + sticky 决定 | 开发者，用户可设 sticky | Runner | 是，fail-closed | 弱 |
| Gemini CLI TOML | tool、MCP、annotation、args regex，分层优先级 | admin/用户/工作区 | 每次 tool call 前 | 是 | 否（按模式切换） |
| Claude Code permissions + auto mode | 模式规则 + prose 规则 | 用户/组织；分类器 | 先规则后分类器 | 混合 | 部分（批准计划时选 mode） |
| LlamaFirewall AlignmentCheck | 自然语言目标对齐 | 无需写规则 | 每步 | 否 | 隐式（以用户目标为锚） |
| Magentic-UI | 三档 irreversibility + LLM judge + 全局 policy | 开发者和用户 | 每个动作 | 混合 | 有 co-planning，无授权包络 |

### 2.7 HCI 证据：计划期参与并非越多越好

- **He, Demartini, Gadiraju（CHI 2025，N=248）**：2×2 设计（计划阶段自动 vs 用户参与；执行阶段自动 vs 用户参与），6 个任务含支付等高风险任务。发现：用户参与并没有像预期那样改善 trust calibration，看似合理的计划容易让人产生错误信任；计划本身已经很好时，用户参与反而降低表现（task-4 中 AP-AE 0.95 vs UP-UE 0.82）；执行中出现复杂错误时（task-6），执行阶段参与帮助很大；参与显著增加 mental demand 与 frustration。启示：参与程度应随风险与失败模式调整；高风险交易需要执行阶段参与；计划应分步呈现，避免过度详细的层级计划。https://arxiv.org/abs/2502.01390
- **Magentic-UI 用户研究**：参与者认可对支付、发邮件、订阅等动作设 guard，但抱怨 "making a request to change the plan, then having an action approval appear to agree to the new plan felt excessive"——**同一件事被确认两次**。https://arxiv.org/abs/2507.22358
- **Jules** 用户离开后计时自动批准计划（https://jules.google/docs/review-plan/ ）——对高风险场景是反模式（fail-open）。

### 2.8 设计启示：让计划期预授权限定运行时行为

1. **把计划编译成 grant（授权包络），而不是批准一段文字**：每个 grant 含 category、工具或工具标签、参数约束、数值上限、TTL、来源；用户看到的是由确定性代码从结构化 grant 渲染的视图（AP2 Trusted Surface "MUST be non-agentic"；Conseca 的执行前审批）。He et al. 说明看似合理的文字计划会诱发错误信任，因此界面上要展示具体收件人与金额。
2. **借用 AP2 v0.2 的约束词汇作 bounds schema 并推广**：花钱 `amount_range` / `budget` / `max_occurrences` / `allowed_payees` / `execution_date` / `exp`；发消息 收件人白名单（CaMeL "Recipients must come from the user"）、渠道、条数；删除 路径前缀、是否可恢复、数量上限。
3. **默认拒绝、不确定即 fail-closed**（AP2 未知约束视为失败；Cedar default-deny；OpenAI SDK 参数无法解析时转人工）；避开 Jules 计时自动批准、Gemini CLI Conseca fail-open 这类反例。
4. **单调收窄，放宽必须回到人**（Progent monotonic confinement；AAT `derived.exp ≤ parent.exp`）；需要升级时一次性提出全部所需权限（MCP step-up 原文）。
5. **grant 只能从可信输入生成**：生成 grant 的 LLM 只看用户原话与已批准计划，不看 tool output；数据带 provenance，收件人等关键参数若来自网页/邮件内容，即便在类别白名单内也要提醒（CaMeL Banking 策略；Google 示例）。
6. **额度与计数由执行层记账**：每次放行扣减剩余额度（AP2 receipt 收窄 open mandate；Dogwood `count`/`sum`）；防并发重复使用；TTL 设为完成任务所需的最小值，长任务分段续期。
7. **越界三档**：`hard_deny`（永不执行）/ `ask`（approve / edit / reject / respond）/ 包络内静默执行 + 审计日志；被拒后先让 agent 找替代路径，连续 N 次被拒再暂停（参考 Claude Code 3 次连续 / 20 次累计）。
8. **类别判定分层**：花钱、删除、发送等由工具标签与参数确定性判定（标签由 ergo 自己维护，第三方 MCP annotations 只当提示）；隐私、联系陌生人、用户自定义模糊类别交给分类器作第二道门（只看用户意图与 tool call）；分类器的放行不能替代用户写下的硬规则；用户在对话里说的边界要**落盘成规则**。
9. **计划期已批准的事，运行时不再问**（Magentic-UI 用户抱怨重复确认；He et al. 过度参与降低表现）；运行时只在偏离 grant 或命中"总是提醒"类别时打断。
10. **用户自定义规则的存放与优先级**：放在 agent、工具、网页内容都写不到的位置（Claude Code 不从项目目录读取 autoMode 的理由）；分层优先级（Gemini CLI Admin > User > Workspace > Extension > Default）；新规则先 `LOG_ONLY` 影子运行再 enforce（AgentCore）；用 LLM 把自然语言转成规则时必须"用户复核结构化结果 + 永真/永假检查"（South et al.；AgentCore authoring service）。
11. **审批要绑定到规范化的具体调用**：渲染完整规范表示，执行前逐字段比对，挂起中的状态不可被修改（Loopjacking）。

【未核实】OPA/Rego 用于 agent 工具授权的官方文档；Mastercard Agent Pay；Llama Guard 最新细节；Jules 自动批准计时时长；Gemini CLI Conseca 实现仅读了源码前约 90 行；CaMeL 未给逐任务确认百分比；Claude Code auto mode "1,053 名测试者"等数字仅见二手报道，未采用；AgentCore Policy GA 时间由 URL 推断。

---

## 3. 长任务的可靠性：durable execution、后台 agent、进度跟踪与 watchdog

> 说明：WebSearch 配额在调研中途用完，Devin、Codex cloud 的部分细节未能核实，已标【未核实】。

### 3.1 Durable execution 引擎如何实现"等人"与崩溃恢复

**共同语义（最重要的一条）**：编排代码必须确定；副作用 step 是 at-least-once，只有"结果已记录"之后才不会重放。exactly-once 只对引擎内部状态成立；对外部世界只能靠 at-least-once + 幂等 key，或 check-then-act，做到"等效 exactly-once"。LLM 调用必须当作 step/activity 记录，replay 时读记录而不重新调用。（依据见下文 Temporal、Restate、DBOS、Inngest、Vercel 各条）

**Temporal**
- Workflow 代码必须确定以支持 replay（"Workflow code must be deterministic to support replay"），replay 时命令与 Event History 比对，不一致抛 non-determinism error；LLM/API/DB 调用放进 Activity 并自动重试。https://docs.temporal.io/workflow-definition
- History 上限 51,200 events 或 50 MB（10,240 events / 10 MB 开始告警），长循环需 `continueAsNew()`。https://docs.temporal.io/workflow-execution/limits
- HITL 原语（TS）：`defineSignal` / `defineQuery` / `defineUpdate` + `setHandler`；Update 可带 validator 在写入 history 前拒绝非法请求；带超时等待 `condition(fn, timeout): Promise<boolean>`。https://docs.temporal.io/develop/typescript/message-passing ， https://typescript.temporal.io/api/namespaces/workflow
- 官方 HITL cookbook：LLM 提出动作，有风险就 `wait_condition(..., timeout)` 等 Signal，用 `request_id` 匹配；可以等 "hours, days or indefinitely while consuming no compute"。https://docs.temporal.io/ai/cookbook/human-in-the-loop-python
- Heartbeat：Worker 定期 ping 并可携带进度；超过 Heartbeat Timeout 判定 Activity 失败并按 retry policy 重试；建议总设 Start-To-Close；TS 用 `heartbeat({progress})`，重试时 `activityInfo().heartbeatDetails` 断点续做；cancellation 也经 heartbeat 送达。https://docs.temporal.io/encyclopedia/detecting-activity-failures ， https://docs.temporal.io/develop/typescript/activities/timeouts
- 幂等：Activity at-least-once，建议用 "Workflow Run ID + Activity ID" 作下游 idempotency key。https://docs.temporal.io/activity-definition
- AI 集成：OpenAI Agents SDK × Temporal（Python）2026-03-23 GA（https://temporal.io/blog/announcing-openai-agents-sdk-integration ）；TS `@temporalio/openai-agents`（pre-release，工具 `needsApproval: true` 后 workflow 等 Signal/Update，用 Continue-As-New 撑过长审批期；嵌套审批不支持）https://docs.temporal.io/develop/typescript/integrations/openai-agents ；`@temporalio/ai-sdk`（Public Preview，包装 Vercel AI SDK）https://docs.temporal.io/develop/typescript/integrations/ai-sdk ；**Temporal Agent Harness**（2026-08-20，实验性）在工具执行前插入审批 policy 引擎，支持分层规则、"approve and stop asking"、按 session 覆盖，审批等待 durable、可跨小时甚至天。https://temporal.io/blog/temporal-agent-harness-durable-agent-infrastructure
- 本地：`temporal server start-dev --db-filename <file>` 可用 SQLite 持久化（dev server，生产适用性为推断）。https://docs.temporal.io/cli/server

**Restate**
- `ctx.run` 把副作用结果写入 journal，失败/挂起后 replay；at-least-once，"retry until their results are journaled"；确定性辅助 `ctx.rand.uuidv4()`、`ctx.date.now()`。https://docs.restate.dev/develop/ts/journaling-results
- HITL：`ctx.awakeable()` 由外部 `resolveAwakeable` 或 HTTP `POST /restate/awakeables/{id}/resolve` 解决；workflow 中 `ctx.promise("review")`；"All three survive retries and process restarts"，等待期间 invocation 挂起；超时需与 durable timer 组合。https://docs.restate.dev/develop/ts/external-events
- Vercel AI SDK 集成 `durableCalls(ctx, {...})` 记录并重试每次 LLM 调用。https://restate.dev/blog/building-durable-agents-with-vercel-and-restate
- 需独立 `restate-server`（内嵌 RocksDB）。https://docs.restate.dev/server/deploy/

**LangGraph（JS）**
- Checkpointer + `thread_id`；JS 有 `MemorySaver`（重启即丢）、`@langchain/langgraph-checkpoint-sqlite`（"ideal for … local workflows"）、Postgres/Mongo/Redis；pending writes 保证同一 super-step 中已成功 node 的写入在 resume 时不重跑。https://docs.langchain.com/oss/javascript/langgraph/checkpointers
- Durability modes：`"exit"`（只在退出/出错/interrupt 时持久化，中途崩溃不可恢复）、`"async"`（小概率丢 checkpoint）、`"sync"`（每步落盘再继续）。（同上页）
- `interrupt(payload)` 暂停、`new Command({resume})` 恢复；**关键坑**："the runtime restarts the entire node from the beginning"——interrupt 前的副作用必须幂等，不能用 try/catch 包 interrupt，同一 node 多个 interrupt 按顺序匹配。https://docs.langchain.com/oss/javascript/langgraph/interrupts
- Time travel：checkpoint 之后的 node 会真的重新执行（"Replay re-executes nodes—it doesn't just read from cache"）。https://docs.langchain.com/oss/python/langgraph/use-time-travel

**Inngest**
- handler 反复重放，已完成 step memoize；"Code outside a step can run again each time the handler replays"；官方示例要求 `refundOrder` 幂等（退款成功但结果未存就被重试）。https://www.inngest.com/docs/learn/how-functions-are-executed
- `step.waitForEvent(id, {event, timeout, match|if})` 超时返回 `null`；坑：race 中输掉的 wait 不会取消；只匹配 wait 开始之后到达的事件（竞态）。https://www.inngest.com/docs/reference/functions/step-wait-for-event
- AgentKit HITL：工具 handler 内 `step.waitForEvent(..., {timeout:'4h'})`，超时把错误返回给模型。https://agentkit.inngest.com/advanced-patterns/human-in-the-loop
- 自托管 `inngest start`（默认 SQLite + 内嵌 Redis）。https://www.inngest.com/docs/self-hosting

**其他**
- **DBOS（TS）**：纯库；`DBOS.registerWorkflow` / `DBOS.runStep`；重启后 "automatically resumes execution from the last completed step"；workflow ID 即幂等 key；HITL 用 `DBOS.recv(topic, timeoutSeconds)`（超时返回 null）与 `DBOS.send(...)`；`setEvent/getEvent` 发布进度。https://docs.dbos.dev/typescript/tutorials/workflow-tutorial ， https://docs.dbos.dev/typescript/tutorials/workflow-communication 【TS 版 SQLite system DB 支持仅见 PR 描述，未核实是否发布】
- **Cloudflare Workflows / Agents SDK**：`step.waitForEvent` 默认 24h、最长 365 天，超时抛错；"Rules of Workflows"：非幂等调用前先检查是否还需执行，step 名即 cache key，不依赖 step 外内存状态；Agents SDK 提供 `waitForApproval(step,{timeout:'7 days'})`、`approveWorkflow/rejectWorkflow`、`this.schedule` 做提醒/升级。https://developers.cloudflare.com/workflows/build/rules-of-workflows/ ， https://developers.cloudflare.com/agents/concepts/human-in-the-loop/
- **Vercel Workflow DevKit**：`"use workflow"` / `"use step"`；`createHook()` / `createWebhook()` + `resumeHook(token, …)` 实现 HITL；`getStepMetadata().stepId` 跨重试不变，可直接作 Stripe `idempotencyKey`；Local World 仅用于开发。https://workflow-sdk.dev/docs/foundations/hooks ， https://workflow-sdk.dev/docs/foundations/idempotency

**不可逆动作（发邮件、付款）的推论**：下游支持 idempotency key 的（如 Stripe）用 stepId 当 key；不支持的（SMTP、IM）要么 check-then-act，要么 at-most-once（如 Temporal `maximumAttempts: 1`）；崩溃后结果不明的进入 `unknown_outcome`，先查询外部状态核对，核对不了就问用户，绝不自动重发。（综合推断）

| 引擎 | HITL 等待原语 | 持久化 | TS | 确定性约束 | 适合单用户本地 daemon？ |
|---|---|---|---|---|---|
| Temporal | Signal/Update(+validator) + `condition(fn, timeout)` | Temporal Server（dev 可 SQLite） | 一流 | 严格 replay；改代码需 `patched()` | 能用但重：额外 server + worker；history 上限 |
| Restate | `awakeable()` / `promise()` | restate-server（RocksDB） | 一流 | journal replay | 中：多一个 server 进程 |
| LangGraph JS | `interrupt()` + `Command({resume})` | SQLite/PG/Redis/Mongo checkpointer | 一流 | node 粒度：resume 整 node 重跑 | 好：纯库 + SQLite；无 durable timer |
| Inngest | `step.waitForEvent` | Inngest server（SQLite + Redis） | 一流 | step 外代码会重放 | 中；注意事件竞态 |
| DBOS | `recv(topic, timeout)` / `send` | Postgres（SQLite 待核实） | 一流 | workflow 确定 | 很好：纯库、进程内 |
| Cloudflare | `waitForEvent`、`waitForApproval` | Cloudflare DO/SQLite | 一流 | step 名即 key | 不适合：仅云上 |
| Vercel WDK | `createHook` + `resumeHook` | World 适配器 | 一流 | 确定性 replay | 弱：本地 World 非生产 |

### 3.2 pi 自身提供什么、缺什么

- pi 会自动保存会话（JSONL 树，`--continue` / `--resume`，`/tree` `/fork` `/clone` 分支，compaction 不删原条目）。https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md （注：pi-mono 仓库现位于 github.com/earendil-works/pi）
- pi 的 `tool_call` 事件可修改输入或 block 执行，handler 抛错时以 block 作为 fail-safe；工具带 MCP 语义的 `annotations`；文档给出了按 annotations 决定是否确认的权限扩展示例。https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- 对话框（`select/confirm/input/editor`）在 RPC 模式下是"发请求 → 阻塞等客户端回应"，可带 `timeout` 自动按默认值返回。https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md
- 官方示例扩展：`permission-gate.ts`（对 bash 的 rm -rf/sudo/chmod 777 正则拦截，无 UI 时默认 block）、`timed-confirm.ts`、`git-checkpoint.ts`（每轮 `git stash create`，fork 时可恢复）、`plan-mode/`（只读计划模式：禁用写工具、bash 白名单、抽取 `Plan:` 编号步骤、`[DONE:n]` 标记进度、状态随会话恢复）、`todo.ts`、`notify.ts`、`sandbox/`、`subagent/`。https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions
- pi 的安全文档明确："it does not ask for approval before every tool call"，安全来自 OS/容器隔离。https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md
- **缺口（推论）**：pi 有会话级持久化，但没有 workflow 级的 durable execution、副作用幂等与跨进程重启的审批等待——`ctx.ui.confirm` 是进程内阻塞，进程一死审批就丢。ergo 需要在 pi 之上自建任务状态机、action ledger 与持久化的审批表。

### 3.3 后台 / 异步 agent 如何汇报进度

- **Claude Code**：
  - 后台命令：`Ctrl+B` 转后台、`/tasks` 查看；交互式本地会话中后台命令无时间上限。https://code.claude.com/docs/en/interactive-mode
  - Task list：`TaskCreate/TaskGet/TaskList/TaskUpdate` 取代 `TodoWrite`，任务在 compaction 后保留，`CLAUDE_CODE_TASK_LIST_ID` 可跨会话共享。https://code.claude.com/docs/en/tools-reference
  - **Session recap**：终端失焦超过 3 分钟后回来，生成一行 ≤400 字符的回顾；会话至少 3 轮才出、不连续出两次；`/recap` 手动触发——"低打扰进度汇报"的好范例。（interactive-mode 页）
  - Hooks：`Stop` / `SubagentStop` 可返回 `decision:"block"` 阻止提前收工；`SessionStart` matcher `startup|resume|compact` 可注入上下文。https://code.claude.com/docs/en/hooks
  - 后台 subagent 的权限请求冒泡到主会话；完成后以通知形式回传。https://code.claude.com/docs/en/sub-agents
  - 云端会话：关电脑也继续跑；**等待审批的时间算作 inactive，可能导致环境过期，过期后只恢复对话历史，后台工作不恢复**。https://code.claude.com/docs/en/claude-code-on-the-web ——教训：pending approval 要持久化且与计算资源解耦。
  - Routines：cron（最小 1 小时）/ API / GitHub 事件触发；运行列表的绿灯只代表基础设施没出错，不代表任务成功。https://code.claude.com/docs/en/routines
- **Anthropic 工程博客**：
  - 《Effective harnesses for long-running agents》（2025-11-26）：initializer agent 建 `init.sh`、`claude-progress.txt`、初始 git 提交和 200 多条 feature list；之后每个会话只推进一个 feature；feature list 用 JSON + `passes` 字段，因为模型"less likely to inappropriately change or overwrite JSON files compared to Markdown"，且"unacceptable to remove or edit tests"；每次会话开头读 git log、进度文件、feature list，先跑基础 e2e 测试；针对的失败模式是一口气全做、过早宣布完成、留下坏状态。https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
  - 《How we built our multi-agent research system》（2025-06-13）：出错后从 checkpoint 处恢复（"resume from where the agent was when the errors occurred"）；让 agent 知道工具在失败并自行适应，配合确定性重试；rainbow deployments 避免升级打断运行中的 agent；多 agent 约耗 15 倍 token。https://www.anthropic.com/engineering/multi-agent-research-system
  - 《Building effective agents》：每步从环境获取 ground truth，在 checkpoint 或阻塞时暂停等人，设最大迭代等停止条件。https://www.anthropic.com/engineering/building-effective-agents
  - 《Harness design for long-running apps》（2026-03-24）：planner / generator / evaluator 三角色，先定 "sprint contract"（对 done 达成一致）；"context anxiety"——模型自以为快到上下文上限会提前收尾，context reset + handoff 文件比单纯 compaction 有效；"Every component in a harness encodes an assumption about what the model can't do"。https://www.anthropic.com/engineering/harness-design-long-running-apps
  - 《Managed Agents》（2026-04-08）：session 是 harness 之外的 durable append-only event log，"nothing in the harness needs to survive a crash"；崩溃后 `wake(sessionId)` 读日志接着跑；sandbox 当 cattle。https://www.anthropic.com/engineering/managed-agents ——**ergo 最值得照搬的架构**。
- **Google Jules**：先出计划，批准后才写代码；"If you navigate away, Jules will eventually auto-approve the plan, which is set on a timer"；执行中有 activity feed，可随时反馈或 pause；API 有 `requirePlanApproval`、`approvePlan`、轮询 activities。https://jules.google/docs/review-plan/ ， https://jules.google/docs/running-tasks/ ， https://developers.google.com/jules/api
- **Devin**：Slack 中 `sleep` 命令、working/blocked/done 状态芯片与实时 worklog（https://docs.devin.ai/integrations/slack.md ）；Dynamic Workflows 恢复时脚本从头重跑，每次 agent 调用按 prompt/schema/设置的哈希 memoize，默认与最大预算 7 天（https://docs.devin.ai/work-with-devin/dynamic-workflows.md ）。【会话自动 sleep 规则未核实】
- **GitHub Copilot coding agent**：单次会话硬上限 59 分钟；session log 展示推理、工具、token、时长；commit message 附 session log 链接。https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- **OpenAI Codex cloud**：每任务独立 workspace、可并行、电脑睡眠也继续，产出 diff 与测试结果。https://learn.chatgpt.com/docs/cloud 【通知机制与时长上限未核实】
- **Cursor cloud agents**：隔离 VM，可从 Web/桌面/手机/Slack/PR 评论查看状态，产出带截图、视频、日志的 PR。https://cursor.com/docs/cloud-agent
- **Manus**（2025-07-18 博客）：平均每任务约 50 次工具调用；持续改写 `todo.md` 把目标 "recite" 到上下文末尾对抗 lost-in-the-middle；失败动作保留在上下文中（"keep the wrong stuff in"）；工具用 mask 而非 remove 以保 KV-cache。https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

### 3.4 按计划跟踪进度、自我纠错、重规划、卡住检测

- **Plan-and-Execute**：每个任务执行后调用 replanner，"decide whether to finish with a response or whether to generate a follow-up plan"；**LLMCompiler**：planner 流式输出任务 DAG，Task Fetching Unit 按依赖调度，Joiner 决定重规划或结束（论文报告相对 ReAct 延迟最多降 3.7 倍、成本最多降 6.7 倍）。https://www.langchain.com/blog/planning-agents ， https://arxiv.org/abs/2312.04511
- **Plan-and-Solve**（ACL 2023）针对 missing-step 错误。https://arxiv.org/abs/2305.04091 ；**Reflexion** 把语言化反思存进 episodic memory。https://arxiv.org/abs/2303.11366
- **LangChain Deep Agents**：`write_todos` 从 v0.7 起改为 opt-in（`todoListMiddleware`），用于较弱模型或需要在 UI 流式展示进度时。https://docs.langchain.com/oss/javascript/deepagents/overview
- **如何判断偏离计划**（综合）：可验证的验收标准（feature list `passes` + e2e 测试、sprint contract）；独立 evaluator 而非执行者自评；每步从环境取 ground truth；Stop hook 阻止在有未完成项时停下；Task Shield 式"每个动作是否服务于用户目标"的对齐检查（见 §2）。
- **OpenHands StuckDetector**（`OpenHands/software-agent-sdk`，2026-08）：只扫描最近 20 个事件（从最后一条用户消息之后）；同一 action + 同一 observation 重复 4 次；同一 action 连续报同一错误 3 次时先注入一次 nudge（"Repeating the exact same call again will not work"），再多 1 次才判定卡住；连续 3 条 agent 消息无动作算 monologue；ABAB 交替阈值 6；判定后状态置 `STUCK` 停止循环。同 SDK 预算：`max_iteration_per_run=500`，`max_budget_per_run` 为美元硬上限。https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py

### 3.5 Watchdog、heartbeat、定时唤醒

- **Temporal 分层超时**：heartbeat timeout 检测"活着但没进展"或 worker 失联；Start-To-Close 限制单次尝试；Schedule-To-Close 限制含重试的总时长；heartbeat details 用于断点续做。
- **Cloudflare Agents**：`keepAlive()` 是 30 秒 alarm heartbeat；`schedule()` 存 SQLite，重启不丢。https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
- **OpenClaw heartbeat**：系统定期在 main session 跑一个 agent turn，用来 "surface anything that needs attention without spamming you"；默认 30 分钟（Anthropic OAuth 时 1 小时），`every:"0m"` 关闭定时但保留事件驱动唤醒；没事就回 `NO_REPLY` 或用 `heartbeat_respond`（`notify:false/true`）；可配 `activeHours`、投递目标、`isolatedSession`、`lightContext`、更便宜的 `model`；官方明确区分：周期业务用 automations/cron，heartbeat 只做巡检。https://docs.openclaw.ai/gateway/heartbeat

### 3.6 agent 能可靠跑多久（METR Time Horizon 1.1，数据更新于 2026-05-08）

| 模型 | p50 | p80 |
|---|---|---|
| Claude Mythos Preview (early) | 约 17.4 h（95% CI 8.5–55 h） | 约 3.1 h |
| Claude Opus 4.6 | 约 12.0 h | 约 70 min |
| Gemini 3.1 Pro | 6.4 h | 约 90 min |
| GPT-5.4 / 5.3-Codex / 5.2 | 约 5.7–5.9 h | 约 54–66 min |

2023 年以来翻倍时间约 129 天；官方原话 "Measurements above 16 hrs are unreliable with our current task suite"；任务集偏软件工程。https://metr.org/time-horizons/ ， https://metr.org/assets/benchmark_results_1_1.yaml
**含义**：p80 比 p50 短一个数量级。要高可靠，单个 step 应控制在人类约 1 小时以内的粒度并逐步验证；长任务靠"计划 + 检查点 + 验证"拼接，而不是指望一次长 run。

### 3.7 对 ergo 的可靠性建议

1. **Event log 是唯一真相，harness 无状态**（照 Managed Agents）：计划版本、step 开始/结束、LLM 结果、工具结果、审批、预算全部 append；崩溃后 `wake(taskId)` 重放。pi 的会话 JSONL 可承载对话，但任务状态机与审批表建议另存 SQLite（WAL）以便查询与加锁。
2. **计划是显式状态机**：Task 状态 `planning → awaiting_plan_approval → running ⇄ waiting_approval / waiting_event / sleeping → stuck / paused → done / failed / cancelled`；Step 字段 `id, goal, acceptance(可执行检查), status, attempts, deps, budget, categories, grant_refs`；用 JSON 存并带 `passes`，模型不能直接删 step，只能通过 replan 事件修改。
3. **Step 级 checkpoint + 记录每次 LLM / 工具调用**：以 `(taskId, stepId, seq)` 为 key 写 journal，恢复时读记录不重调；副作用 step 一律"先落盘再继续"（相当于 LangGraph `"sync"`）。
4. **工具按副作用分三级**：read-only 随便重试；idempotent write 用 `idempotencyKey = hash(taskId, stepId, callIdx)`；irreversible（邮件、支付、对外消息）执行前写 `intent`、成功后写 `result`、check-then-act、最多一次；只有 intent 没有 result 的标记 `unknown_outcome`，先查外部状态，查不了就问用户，绝不自动重发。
5. **审批是 durable promise**：`approvalId, taskId, stepId, actionHash(规范化参数), categories, createdAt, deadline, onTimeout(reject|skip|approve|escalate), notifiedChannels`；任何渠道都可 resolve，按 approvalId 去重、先到先得；deadline 持久化并由调度器扫描；等待期间不占计算，不依赖该审批的 step 继续跑。
6. **崩溃/升级后处理 pending approvals**：启动时从 DB 重新加载，沿用原 approvalId 提醒而非新建；批准绑定 `actionHash`，执行前比对，不一致重新申请；审批过时（超过 N 小时）先重新检查前提；每个任务记录 `harnessVersion`，不兼容升级时在下一个 step 边界迁移或重规划。
7. **Heartbeat 与 watchdog 分两层**：进程层交给 OS 服务管理器拉起；任务层定期写 `lease(taskId, owner, expiresAt, lastProgressAt, lastEventSeq)`，巡检接管过期 lease；区分 liveness 与 progress（"活着但 X 分钟没有新事件"即挂起）。
8. **预算与卡住检测**：每 step / 每任务设迭代、wall-clock、token/金额上限；移植 OpenHands 阈值；命中后依次：自动 replan 一次 → 换策略/降级 → 问用户。
9. **明确的重规划触发**：重试用尽、验收失败、新观测否定计划前提、预算超支超过 X%、审批被拒、检测到 stuck、用户插话、每 K 步定期复盘；replan 产出计划 diff（带版本号），已完成 step 不可改；新增类别只做增量审批（见 §6）。
10. **进度摘要从结构化状态生成**：完成数/总数、当前 step、阻塞项、待审批项、花费与预计完成时间；只有"需要审批 / 被阻塞 / 失败 / 完成"四种情况主动打断，其余走定期 digest（OpenClaw heartbeat 式，无事 `NO_REPLY`）、回来时一句话 recap（Claude Code 式）、随时可查的状态页。
11. **长任务的上下文工程**：每次 wake 先 "get up to speed"（读计划、progress 文件、最近事件）；每轮末尾 recite 计划与下一步；失败痕迹保留；接近上限优先 context reset + handoff 文件。
12. **引擎选型**：单用户、本地、TS、pi 体系下不建议一开始引入 Temporal/Restate/Inngest 这类独立 server；用 SQLite 实现最小原语 `step(id, fn)`、`waitFor(approvalId, deadline, default)`、`sleepUntil(t)`、`lease/heartbeat`，或直接嵌入 DBOS（TS）；接口语义对齐 DBOS/Restate，以后迁移 Temporal TS 成本最低。

【未核实】DBOS TS 的 SQLite 支持是否已发布；Inngest waitForEvent 的 lookback；Cloudflare waitForEvent 是否缓冲早到事件；Codex cloud 通知与时长上限；Devin 自动 sleep 规则；"新模型默认不给 todo 工具"系从 Claude Code 文档推断。

---

## 4. HCI：打断管理、通知与人–agent 交互

> 说明：WebSearch 配额在后期用完，部分论文只核实到摘要或二手转述，已在条目中注明；"打断后约 23 分钟才回到原任务"这一流行数字**不出自** Mark et al. 2008，出处未核实，本文不采用。

### 4.1 打断的代价

- **Mark, Gudith & Klocke, CHI 2008《The cost of interrupted work: more speed and stress》**：N=48，模拟回邮件任务，每 2 分钟打断一次。被打断时反而更快（基线 22.77 分钟，同语境打断 20.31，异语境 20.60，p<.05），错误与礼貌度无差异但邮件更短；代价在主观上：stress（F=12.15，p<.001）、frustration、time pressure、effort、workload 显著升高；个体差异可预测打断代价。**启示**：任务速度没变慢不代表用户没付出代价；要直接度量打断次数与用户压力，打断容忍度应允许个性化。https://dl.acm.org/doi/10.1145/1357054.1357072
- **Adamczyk & Bailey, CHI 2004《If not now, when?》**：N=16；在预测的最佳时机打断，相比最差时机 annoyance 低 56%、frustration 低 49%、time pressure 低 55%，"对手头任务的尊重感"高 43%；**最差时机比随机打断还糟**。**启示**：时机本身决定一大半体验。https://dl.acm.org/doi/10.1145/985692.985727
- **Iqbal & Bailey, CHI 2008《Effects of intelligent notification management on users and their tasks》（OASIS）**：每条通知带 defer 策略（Fine / Medium / Coarse / Any breakpoint）与**最长等待时间**，两者先到者投递。N=16：在 breakpoint 投递 frustration 更低（画图任务 7 点量表：Medium 2.6、Coarse 3.6、Immediate 4.5、Fine 5.5）；平均延迟不到 90 秒；与当前任务相关的通知适合 Medium/Fine 断点，泛兴趣内容只适合 Coarse，否则引发连锁分心（恢复 23.1s vs 4.65s）。**启示**：agent 自身的子任务完成、阶段切换就是天然断点；每个请求都要带最长等待时间。https://dl.acm.org/doi/10.1145/1357054.1357070
- **Altmann & Trafton 2002《Memory for goals》**：被挂起的目标只能靠线索提示回来，线索必须在挂起时建立、在恢复时在场。**启示**：每次打断用户都附上"你刚才在做什么、我在做什么"的线索；agent 挂起子任务时写 resume note。https://interruptions.net/literature/Altmann-CogSci02.pdf
- **Trafton et al. 2003《Preparing to resume an interrupted task》**：打断前先给警示、8 秒后再打断的组准备行为显著更多（13.5/30 vs 3.1/30），首个 session 的 disruption 更小。**启示**：非紧急审批先给轻提示（"稍后需要你确认一笔付款"），让用户收尾。https://www.interruptions.net/literature/Trafton-IJHCS03.pdf
- **Czerwinski, Horvitz & Wilhite, CHI 2004（日记研究）**：需要"返回"的任务时长 120 vs 45 分钟、涉及文档 2.5 vs 1.6 份、被打断 1.5 vs 0.7 次，切换回去显著更难。**启示**：复杂长任务最怕被打断。https://www.microsoft.com/en-us/research/publication/a-diary-study-of-task-switching-and-interruptions/
- **Iqbal & Horvitz, CHI 2007《Disruption and recovery of computing tasks》**：N=27、两周、2,267 小时；平均每小时 3.74 次 alert；响应 alert 后连锁分心 email 平均 9 分 33 秒、IM 8 分钟；27% 的 alert 导致原活动窗口超过 2 小时未恢复。**启示**：一次打断的成本远不止点"批准"的几秒；待处理事项要保持可见作为线索。https://erichorvitz.com/CHI_2007_Iqbal_Horvitz.pdf
- **McFarlane 2002 / McFarlane & Latorella 2002**：四种协调方式 immediate / negotiated / mediated / scheduled（N=36）。negotiated 主任务表现最好但有"拖延"（完成率与及时性最差）；immediate 最及时但出错最多、整体最差；scheduled 切换最少但其他指标差。总结：除非"时效上的微小差异是关键"，negotiation 总体最优。**启示**：默认 negotiated（可稍后处理）+ 截止时间防拖延；真正有时限的才 immediate。https://interruptions.net/literature/McFarlane-HCI02_1.pdf

### 4.2 Horvitz：决策论框架与 bounded deferral

- **《Principles of mixed-initiative user interfaces》（CHI 1999）**——12 条原则：value-added automation；考虑用户目标的不确定性；按注意力状态决定时机；在成本、收益、不确定性下推断最佳行动；用对话解决关键不确定性；高效调用与终止；降低猜错动作或时机的代价（含超时、自然的拒绝手势）；不确定时降低服务精度（"doing less" but correctly）；高效协作精修结果；社交得体；记住近期交互；持续学习。决策模型：比较"行动 / 对话（询问）/ 不做"三者的期望效用，得到两个阈值 p\*¬A,D（不做↔询问）与 p\*D,A（询问↔直接做）；阈值随情境移动（用户越专注，阈值越高）；LookOut 允许用户直接设置这两个阈值，等待回应的时长与推断概率成正比，时间到了"礼貌地消失"。**启示**：ergo 的 ask / digest / log 正对应 dialog / action-then-inform / silent action；每个类别可以有两个用户可调阈值。https://erichorvitz.com/chi99horvitz.pdf
- **《Attention-Sensitive Alerting》（UAI 1999）**：ECDR（expected cost of delayed review，按 criticality 分类、各有损失速率）、EVTA（现在提醒的期望价值）、NEVA = EVTA − 打断成本，NEVA > 0 才提醒。**启示**：每类操作配一个"延迟损失函数"（付款截止、对方等回复的社交代价），与打断成本比较。https://erichorvitz.com/priorities.pdf
- **《Balancing awareness and interruption: investigation of notification deferral policies》（UM 2005）**——bounded deferral：用户忙时压住 alert，一转空闲就投递，最多等到预设上限强制投递。113 名用户、4,803 个忙碌片段：忙碌平均只持续 43.12 秒（SD 51.79），绝大多数 1–2 分钟内转为空闲；邮件案例中把上限设为 4 分钟，忙碌时被打断次数 P1 从 20 降到 4、P2 从 80 降到 0；高紧急度约 1 分钟延迟即可消除忙碌时的全部打断，中约 3 分钟，低约 4 分钟。Priorities 系统按紧急度三档设延迟滑块，并**预测每小时会被打断几次**。**启示**：最直接可用的机制——每档设最长等待，并在 UI 上展示"预计每天会打扰你 N 次"。https://erichorvitz.com/bdef_studies.pdf
- **BusyBody（CSCW 2004）**：用 experience sampling 训练个人化 cost-of-interruption 模型，用户可设每小时最多被问几次；两状态模型准确率 0.70–0.87；但训练探针本身"有点烦"。https://erichorvitz.com/busybody_cscw.htm

### 4.3 批处理、摘要与告警/审批疲劳

- **Fitz et al. 2019《Batching smartphone notifications can improve well-being》（Computers in Human Behavior 101）**：随机现场实验 n=237；每天批量 3 次的组更专注、心情更好、对手机更有掌控感、压力更低；**完全不收通知的组反而焦虑与 FoMO 上升**；每小时批量一次几乎无效（来自作者博客与 highlights，未读全文；摘要中 "lower productivity" 一词疑似笔误）。https://doi.org/10.1016/j.chb.2019.07.016
- **Kushlev & Dunn 2015《Checking email less frequently reduces stress》**：N=124，限制每天查 3 次（实际 4.70 vs 12.54 次/天）的一周日压力显著更低（d=0.37）。https://www.interruptions.net/literature/Kushlev-ComputHumBehav15.pdf
- **Pielot et al.**：MobileHCI 2014 一周日均约 63.5 条通知（正文另写 65.3），通常几分钟内被查看，通知越多负面情绪越多，社交来源的通知带来"要快回"的压力 https://pielot.org/pubs/Pielot2014-MobileHCI-Notifications.pdf ；MobileHCI 2017 关闭所有通知 24 小时，更少分心更有效率，但焦虑没能及时回应、社交联系感变弱 https://pielot.org/pubs/PielotRello2017-MHCI-DoNotDisturb.pdf 。**启示**："少打扰"不等于"不汇报"，用户需要确信进展与异常不会漏报。
- **Iqbal & Horvitz, CSCW 2010《Notifications and awareness》**：用户主要把通知当被动感知手段，关闭后有人更专注、有人反而更频繁主动去查。**启示**：提供低打扰的感知通道（状态栏、环境提示）替代弹窗。https://erichorvitz.com/shamsi_iqbal-eric_horvitz_cscw_2010.pdf
- **Mehrotra et al.（经作者综述 arXiv 1711.10171 转述）**：通知是否被接受取决于内容类型与发送者关系；模型预测 receptivity 优于用户自述规则；PrefMiner 向用户推荐 179 条规则，被接受 56.98%。**启示**：用户规则作起点，agent 根据历史提议调整，由用户确认。https://arxiv.org/abs/1711.10171
- **Akhawe & Felt, USENIX Security 2013《Alice in Warningland》**：超过 2500 万次警告展示；click-through 率 Firefox malware/phishing 约 1/10、Chrome 同类约 1/4、Firefox SSL 约 1/3、Chrome SSL 70.2%；49% 的某类 SSL 点过发生在 1.7 秒以内（warning fatigue 迹象）。**启示**：警告的设计与频率决定其效果；可监测"批准用时"，秒批即疲劳信号。https://www.usenix.org/system/files/conference/usenixsecurity13/sec13-paper_akhawe.pdf
- **Felt et al., SOUPS 2012（Android 权限）**：只有 17% 的人在安装时注意到权限，3% 能答对全部三道理解题。**启示**：一次性、泛泛的授权界面几乎没人看；审批必须具体（多少钱、发给谁、删什么）。https://cups.cs.cmu.edu/soups/2012/proceedings/a3_Felt.pdf
- **Bravo-Lillo et al., SOUPS 2013/2014**：对已习惯化的用户，要求与关键字段交互的 inhibitive attractor 使知情决策概率提高 2–3 倍；习惯化使注意到对话框变化的人数降到三分之一，多数 attractor 随习惯化失效，只有"强制与变化字段交互"的设计仍有效。https://cups.cs.cmu.edu/soups/2013/proceedings/a6_Bravo-Lillo.pdf
- **Vance et al., MIS Quarterly 2018；Jenkins et al., ISR 2016；Anderson et al., CHI 2015**：fMRI 与眼动显示对警告的注意力逐日下降、隔天部分恢复，**polymorphic（外观变化）警告显著减缓下降**；3 周现场实验中普通权限警告遵从率持续下降、polymorphic 下降慢得多；双任务干扰越强越容易忽视警告，**消息紧接在主任务完成之后出现时脑激活接近单任务水平**——重要但不需立即处理的消息应放在低干扰时刻。DOI 10.25300/MISQ/2018/14124、10.1287/isre.2016.0644、10.1145/2702123.2702322（CHI 2015 仅核实题目作者）
- **医疗告警疲劳**：72%–99% 的临床告警是假警报，导致脱敏与漏报（Sendelbach & Funk 2013，PMID 24153215）。**启示**：假阳性率是告警疲劳的关键。
- **移动权限的偏好学习**（见 §2.4）：Wijesekera 2015/2017、Liu 2016——"只在不确定时问"在移动权限上已有实证基础。
- **LLM 生成摘要的风险**：2025 年 1 月 Apple 因 BBC 投诉（把多条新闻合并成事实错误的摘要）暂停了新闻类 App 的 AI 通知摘要，iOS 18.3 将摘要改为斜体显示、加"可能有误"提示、允许按 App 关闭（二手报道）。https://techcrunch.com/2025/01/16/apple-pauses-ai-notification-summaries-for-news-after-generating-false-alerts ——**启示**：ergo 的摘要中，金额、收件人、动作等事实必须从 ledger 结构化渲染，LLM 只负责串联叙述，并附原始事件链接。

### 4.4 平台的紧急度分档

- **Apple（iOS 15+）**：Passive（进列表、不亮屏不响铃）/ Active（默认，立即呈现，不能突破 Focus 与 Notification Summary）/ Time Sensitive（可突破定时汇总与 Focus，不能突破静音开关；只用于正在发生或一小时内会发生的事；首次出现时系统会说明并允许关闭，之后定期让用户复评；营销内容永不可用）/ Critical（三者都能突破，需 Apple 批准 entitlement，健康与安全，"极其罕见"）；HIG："Build trust by accurately representing the urgency"；Notification Summary 用 `relevanceScore`（0–1）决定突出哪条。https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel ， https://developer.apple.com/design/human-interface-guidelines/managing-notifications
- **Android**：8.0 起通知必须属于 channel，重要度 Urgent（heads-up）/ High / Medium（不响）/ Low（不进状态栏）/ None；**channel 创建后应用不能再改其行为，完全由用户控制**；DND Priority-only 按类别放行，用户可按 channel 设置能否突破；同一应用 4 条以上自动归组；Android 15 notification cooldown 对短时间内连续通知最长 2 分钟降低音量与震动。https://developer.android.com/develop/ui/views/notifications/channels
- **对 ergo 的映射**：log ≈ Passive；digest ≈ Summary；普通审批 ≈ Active（可被勿扰拦截）；有时限的审批 ≈ Time Sensitive；Critical 留给极少数情况并定期让用户复核；提醒类别 ≈ channel（用户拥有最终控制权）；连发自动降噪。

### 4.5 近期的人–agent 交互研究

- **Feng, McDonald & Zhang《Levels of Autonomy for AI Agents》（arXiv 2506.12469，2025）**：按用户角色分五级——L1 Operator、L2 Collaborator、L3 Consultant、**L4 Approver**、L5 Observer；自主级别是可独立于能力设计的选择。L4 的描述：agent 只在遇到阻碍时找用户（失败、缺凭证、需要对 consequential action 签字），原文示例中**用户在提交任务前先指定哪些动作需要审批**，计划只做透明展示而不征求意见。L4 的开放问题：如何避免 meaningless rubber stamping；失配 agent 可能利用用户松懈逐步获得更多自主；agent 如何可靠判断哪些动作 consequential。另提出由第三方签发的 autonomy certificate（换工具或环境需重新认证）。**启示**：ergo 的类别审批正是 L4 设计；新增工具时要重新评估类别映射；要专门防 rubber stamping。https://arxiv.org/abs/2506.12469
- **Anthropic《Measuring AI agent autonomy in practice》（2026-02-18）**：Claude Code turn 时长中位数约 45 秒，第 99.9 百分位从不到 25 分钟（2025-09）增至超过 45 分钟（2026-01）；session 数不足 50 的新用户约 20% 开启 full auto-approve，超过 750 个 session 后超过 40%；**中断率反而上升**（新用户约 5% 的 turn、老用户约 9%）——用户从逐个审批转向"监控 + 必要时介入"；内部用户在最难任务上成功率翻倍、每 session 人为介入从 5.4 次降到 3.3 次；"Claude Code pauses for clarification more often than humans interrupt it"（最复杂任务上请求澄清频率是人类打断的两倍以上）；Claude 主动停下的原因：给出方案选择 35%、收集诊断信息 21%、澄清模糊需求 13%、索要凭证 12%、请求批准 11%；人类打断原因：补充上下文或纠错 32%、嫌慢/卡住/做过头 17% 等；API 侧 80% 的 tool call 来自至少有一种 safeguard 的 agent、73% 看起来有人参与、**只有 0.8% 看起来不可逆**（由 Claude 推断，应视为上界）；结论：规定"每个动作都要审批"之类的交互模式"会制造摩擦，却不一定带来安全收益"，"有效监督不需要批准每个动作，而是要在关键时刻能够介入"。https://www.anthropic.com/research/measuring-agent-autonomy
- **Anthropic《Beyond permission prompts》（2025-10-20）**：点名 "approval fatigue"（用户不再细看自己批准了什么）；用 sandbox 划定边界后内部 permission prompt 减少 84%。https://www.anthropic.com/engineering/claude-code-sandboxing
- **Mitchell et al.《Fully Autonomous AI Agents Should Not be Developed》（arXiv 2502.02649）**：五级 agent（simple processor → fully autonomous），用户让渡控制越多风险越大；automation bias 与"经常做对带来的表面能力"推高不当信任；建议保留 override、设清晰运行边界、agent 不能覆盖人类设定的约束。**启示**：用户设定的类别必须是 agent 不能自行绕过的硬约束。https://arxiv.org/abs/2502.02649
- **Amershi et al., CHI 2019《Guidelines for Human-AI Interaction》**（18 条，49 名从业者 × 20 个产品检验），与 ergo 直接相关：G3 按情境安排时机；G7 高效调用；G8 高效忽略；G9 高效纠正；G10 拿不准时缩小范围；G14 谨慎更新；G15 鼓励细粒度反馈；G17 全局控制；G18 通知变化。**启示**：类别开关即 G17；agent 行为策略变化时必须告知用户（G18）。https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/
- **Shneiderman《Human-Centered AI》**：人的控制与自动化不是一根轴的两端，可以同时都高。https://arxiv.org/abs/2002.04087
- **Parasuraman, Sheridan & Wickens 2000（IEEE SMC-A 30(3)）**：四阶段（信息获取、分析、决策选择、执行），各阶段可有不同自动化水平。（10 级量表的具体措辞凭记忆，未重新核实：约第 6 级"执行前给人有限时间否决"、第 7 级"自动执行后必须告知"。）**启示**：撤销窗口 ≈ 限时否决；查资料、起草可高自动，付款、发送低自动。
- **Chen et al., CHI 2025《Need Help? Designing Proactive AI Assistants for Programming》**：N=65；主动助手使完成任务数提高 12%–18%，但提高建议频率后偏好它的比例减半；时机规则：用户在打字或交互时不推、空闲 5 秒后推、两次至少间隔 20 秒、出错时立即推。**启示**：频率是独立的体验变量，效率提升抵消不了打扰的反感。https://arxiv.org/abs/2410.04596
- **Magentic-UI（arXiv 2507.22358）**：模拟用户实验中，轻量的人类帮助使 GAIA 完成率从 30.3% 升到 51.9%，agent 只在 10% 的任务里求助（平均每任务 1.1 次）；N=12 定性研究：有人觉得"加入购物车"不需要审批；改完计划又弹审批被认为多余；希望审批有第三个选项；希望把多个问题合并在一次打断里问；"全程盯着它就失去了意义"；有 safeguard 时更愿意让 agent 后台多任务。https://arxiv.org/abs/2507.22358
- **Sidekick（arXiv 2607.17527，2026-07）**：N=30；agent 后台运行时用 ambient cue（绿/黄/红）展示状态，用户回来时给多模态摘要帮助恢复语境，显著提升并行工作表现并减少错误。https://arxiv.org/abs/2607.17527
- **Grunde-McLaughlin et al.《Overseeing Agents Without Constant Oversight》（arXiv 2602.16844）**：新的 trace 界面缩短了找错时间、提升了信心，但最终准确率没有明显提高。**启示**：digest 与 trace 会提升信心却未必提升监督质量，存在过度自信风险。https://arxiv.org/abs/2602.16844
- **Intelligent AI Delegation（Tomašev, Franklin, Osindero, Google DeepMind, arXiv 2602.11865）**：把委托视为一系列决策——任务分配、权力/责任/问责的转移、角色与边界规格、意图清晰度、建立信任的机制；（据检索摘要）列出安全委托的九个维度，包括任务规格、资源供给、工具访问、监控、信任与声誉、权限处理、可验证完成、安全与回滚。https://arxiv.org/abs/2602.11865

### 4.6 提炼出的设计原则

1. **按类别与可逆性决定自主程度，默认"做 + 记录"**；只有用户勾选的类别叠加不可逆或超阈值条件才走中断式审批（Feng L4；Anthropic 0.8% 不可逆；Magentic-UI 三级可逆性）。
2. **用决策论选打断方式**：比较打断成本、延迟损失、误行动代价，每类两个用户可调阈值（Horvitz p\*、NEVA）。
3. **等断点再打断**：优先双方的任务边界；与用户当前活动相关的可在细边界投递，无关的只在粗边界（Iqbal & Bailey；Adamczyk & Bailey；Jenkins 2016）。
4. **bounded deferral**：每个紧急度档设最长等待；到点仍无响应时执行**安全**默认动作——暂停该分支、其余继续，不越权执行（Horvitz 2005；OASIS）。
5. **低紧急度进可预期的 digest（每天 2–3 次）**，同时保留随时可查的状态视图；不要完全静默（Fitz 2019；Kushlev 2015；Pielot 2017）。
6. **合并打断**：同一时段多个请求合成一次，按风险排序（Magentic-UI；Apple Summary；Android 归组与 cooldown）。
7. **一个审批不卡整个任务**：挂起相关分支，其余推进；等待状态用环境提示展示（Anthropic；Sidekick）。
8. **默认 negotiated + 提前轻提示 + 截止时间**（McFarlane；Trafton 8 秒 interruption lag）。
9. **让拒绝和修改都很便宜**：一步完成批准 / 拒绝 / 编辑 / "本任务内同类都允许"；超时优雅处理；策略变化告知用户（Horvitz 原则 6、7；Amershi G8/G9/G17/G18）。
10. **审批要稀少、具体、外观有变化**：写清金额、收款方、删除对象；高风险审批要求与关键字段交互（如再输入金额或收件人）；监测秒批与批准率，接近 100% 秒批的类别建议降级为 digest（Akhawe & Felt；Bravo-Lillo；Vance 2018）。
11. **诚实标注紧急度并定期复核**：仿 Apple Time Sensitive / Critical 极少使用、可被用户降级；用户拥有最终控制权（Android channel）。
12. **学习偏好但防 rubber stamping**：agent 提议规则调整、用户确认后生效；随用户经验逐步放权；随机抽查 digest 条目；agent 不能自行扩大权限（Mehrotra/PrefMiner；Anthropic；Feng L4 开放问题；Overseeing Agents）。

【未核实】"Ask before you act""To interrupt or not"等 2024–2026 年关于确认时机与 approval fatigue 的更多论文未能检索；Monk et al. 2008 只有摘要级结论；Notification Platform 与 CACM 2003 未读；Anderson et al. CHI 2015 只核实题目作者；Mehrotra CHI 2016 经作者综述转述；Fitz 2019 只读摘要；Parasuraman 10 级措辞凭记忆；Shneiderman 期刊信息未核实。

---

## 5. 监督自治 agent 的 UI 模式

> 说明：openai.com / help.openai.com 对抓取返回 403，凡 ChatGPT agent / Atlas / Codex 移动端的细节均来自搜索摘要或第三方报道，已标"未直接核验"。部分产品已更名：Windsurf 文档跳转到 docs.devin.ai/desktop（Cascade 归入 "Devin Desktop"）；microsoft/magentic-ui 仓库现名 MagenticLite（旧版在 `magentic-ui-0.1` 分支）；Gemini 帮助页现用名 "Gemini Spark"。

### 5.1 计划视图与计划审批

- **Claude Code plan mode**：plan mode 下只读文件、跑探索命令、写计划，批准前不能改源码。计划完成后三个选项："Yes, and use auto mode"（批准后由分类器代替人审每个动作；组织禁用 auto mode 时显示为 "Yes, auto-accept edits"）、"Yes, manually approve edits"、"No, keep planning"；`Ctrl+G` 可在外部编辑器直接改计划。关键点：**批准计划的同一个动作里选定后续自治级别**。https://code.claude.com/docs/en/permission-modes
- **Google Jules**：计划含自然语言描述、可展开步骤、假设与准备步骤，点 "approve plan" 执行；用户离开页面后计划**按计时器自动批准**；API 有 `requirePlanApproval` 参数与 `AWAITING_PLAN_APPROVAL` 状态；2026-01-26 加入 "Planning Critic"——对无人审的自动批准计划由另一个 agent 复审，任务失败率下降 9.5%；2025-08-08 加入 Interactive Plan（先读代码、问澄清问题再共同改计划）。https://jules.google/docs/review-plan/ ， https://jules.google/docs/changelog/ ， https://jules.google/docs/api/reference/sessions/
- **Devin**：2025-03-25 Interactive Planning（session 开始几秒内给出相关文件、发现与初始计划，用户可在自主执行前调整）；2025-05-15 Confidence Scores（绿/黄/红）——**非绿色就等用户批准再执行，绿色自动继续**。https://docs.devin.ai/release-notes/2025
- **Cursor Plan Mode**：澄清问题 → 调研代码库 → 生成带文件路径与 to-do 的 Markdown 计划；可在聊天或 Markdown 里增删 to-do，确认后点 Build；可 "Save to workspace" 存到 `.cursor/plans/`；文档建议出问题时回到计划改了重来，而不是追加 prompt。https://cursor.com/docs/agent/plan-mode ， https://cursor.com/blog/plan-mode
- **GitHub Agent HQ / mission control**（2025-10-28）：一个视图里分派任务、看实时 session log、中途 steer（暂停/修正/重启）、跳到 PR；"See task status at a glance and jump in when Copilot needs your input"。https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/
- **Microsoft Magentic-UI**（arXiv 2507.22358）：co-planning——计划是步骤列表（执行 agent、标题、细节），可直接编辑、文字要求修改、重新生成，再 "Accept Plan"，执行时有进度条；用户研究中参与者常在执行前改计划注入个人偏好，有人称 co-planning "from a safety perspective... my favorite part"；plan learning——从执行轨迹生成可复用计划存入 "Saved Plans gallery"，可手动 attach 或按向量相似度自动检索；参与者希望执行中**计划的变化更显眼**、能从某个已完成步骤改了重跑。https://arxiv.org/html/2507.22358
- **Cocoa**（arXiv 2412.10999，CHI 2026）：interactive plans 嵌在文档里，**每一步可指派给用户或 agent**，计划与执行交错；实验室 n=16 + 一周实地部署 n=7，相比聊天基线 steerability 更好且用户付出不增加。https://arxiv.org/abs/2412.10999
- **Manus**：复杂任务生成 `todo.md` 边做边勾，用于把总体目标"复述"到上下文末尾；平均每任务约 50 次工具调用（一方博客，经搜索摘要）。https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus 。"后来改为专门 planner agent"的说法未经一方证实。
- **Gemini Spark**：工作面板 "Progress" 区显示已完成/当前/计划中步骤，线程顶部有 progress chip。https://support.google.com/gemini/answer/16596215

### 5.2 时间线、活动流与会话日志

- **Devin**：点任一步骤或 Progress tab 看详情；shell、代码编辑、浏览器活动在同一视图，可接管；"Detailed View" 用上下键逐个看动作并显示理由；测试后发**带标注的录屏**（关键点文字标签、放慢、自动放大）作为"能用"的证据，可在 webapp 或 Slack 查看。https://docs.devin.ai/work-with-devin/devin-session-tools.md ， https://docs.devin.ai/work-with-devin/testing-and-recordings.md
- **Copilot cloud agent**：session log 与 PR 的 Overview/Files changed 并排，可 "Stop session"；2026-03-19 子 agent 活动默认折叠为一个 HUD；2026-03-20 起每个 commit 带 `Agent-Logs-Url` trailer，可从产物反查会话日志。https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/track-copilot-sessions ， https://github.blog/changelog/2026-03-19-more-visibility-into-copilot-coding-agent-sessions/ ， https://github.blog/changelog/2026-03-20-trace-any-copilot-coding-agent-commit-to-its-session-logs/
- **Claude Code agent view**：每会话一行，状态 Working / Needs input（黄）/ Idle / Completed（绿）/ Failed（红）/ Stopped；每行一句 Haiku 生成的摘要（运行中每 15 秒刷新）；默认分组 Pinned → Ready for review → Needs input → Working → Completed；Space 打开 peek 面板，可见待答问题与等待时长（如 "waiting 3m"）并直接回复；**重新接入会话时先贴一段"离开期间发生了什么"的小结**。https://code.claude.com/docs/en/agent-view
- **Codex cloud**：查看 diff 与测试输出、追加修改、commit 或开 PR，web/移动/桌面均可。https://learn.chatgpt.com/docs/cloud （"结果引用终端日志与测试输出作为证据"的早期文案未直接核验）
- **ChatGPT agent / Operator**（未直接核验）：执行时屏幕旁白（narration），用户可随时打断、接管浏览器或停止。https://openai.com/index/introducing-chatgpt-agent/
- **Manus**：浏览器动作在专用标签页进行，点入即接管、关闭即停止，"All actions are logged"。https://manus.im/docs/features/browser-operator
- **开发者向**：Langfuse 将一次请求记为 trace（嵌套 observation：LLM 调用、工具执行，带时间与输入输出），适合 ergo 的后台调试视图而非终端用户。https://langfuse.com/docs/observability/overview

### 5.3 审批收件箱与远程审批通道

- **LangChain Agent Inbox**：条目即 LangGraph interrupt，每条有 `action_request`（动作名+参数）与 `allow_accept/allow_edit/allow_respond/allow_ignore` 四开关，对应 Accept / Edit（改参数再执行）/ Response（文字反馈）/ Ignore。**仓库已于 2026-09-20 归档**（托管版 dev.agentinbox.ai），但四种回应的设计仍值得借鉴。https://github.com/langchain-ai/agent-inbox
- **Claude Code Remote Control 与推送**：本地会话可在 claude.ai/code 或 Claude App 继续；推送两开关 "Push when actions required"（权限请求/提问）与 "Push when Claude decides"（长任务完成等）；**用户正在用终端时不推送**，可用 `CLAUDE_CLIENT_PRESENCE_FILE` 做在场检测。https://code.claude.com/docs/en/remote-control
- **Claude Code Channels permission relay**（research preview）：Telegram/Discord/iMessage 收权限请求，含 5 字母 request_id（不含 `l`，避免与 1 混淆）、tool_name、description、input_preview；回复 "yes abcde"/"no abcde"；**终端与手机两端同时有效，先到先生效**；转发前清洗不可见字符、按 3,500 码点截断（保留首尾）、凭据打码为 `[REDACTED]`；仅白名单发送者可审批。https://code.claude.com/docs/en/channels-reference
- **OpenClaw**：审批请求可发回原会话（mode `session`）或指定目标（Slack/Telegram 等）；回复 `/approve <id> allow-once|allow-always|deny`；Discord/Slack/Telegram 有原生按钮，Matrix 用表情回应；待审项**默认 30 分钟过期**；无 UI 时 `askFallback` 默认 deny；"standing grants" 可绑定到特定 agent、任务、命令、目录、环境，带过期、可撤销。https://docs.openclaw.ai/tools/exec-approvals ， https://docs.openclaw.ai/tools/exec-approvals-advanced
- **n8n**：可给单个 AI tool 加 "human review step"，经 Chat/Slack/Discord/Telegram/Teams/Gmail/WhatsApp/Google Chat/Outlook 审批，消息中用 `$tool.name`、`$tool.parameters` 显示调用；拒绝则取消并告知 AI。https://docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools
- **Zapier Human in the Loop**：Approve/Decline，可设审批人能否编辑数据；**超时可选 "Skip and continue" 或 "End run"**，可设定期提醒；通知走邮件/Slack/另一个 Zap。https://help.zapier.com/hc/en-us/articles/38731463206029
- **Copilot Studio multistage / AI approvals**（preview）：人工 stage + AI stage（给 Approve/Reject 与理由）+ 条件路由（如金额 >5000 才转经理）；人工 stage 可选 "First to respond" 或 "Everyone must approve"；在 Teams 审批 App、Outlook、Power Automate 门户处理。https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-advanced-approvals
- **Devin in Slack**：每会话一个频道，带状态标签（工作中/阻塞/完成）；环境配置改动附 diff 与 "Apply" 按钮；`sleep`、`mute` 指令。https://docs.devin.ai/integrations/slack
- **Codex 移动端**（未直接核验，第三方报道）：2026-05-14 起 ChatGPT 移动端可连接桌面 Codex，看 diff 与终端输出、批准命令。https://winbuzzer.com/2026/05/15/codex-is-now-in-the-chatgpt-mobile-app-xcxwbn/

### 5.4 风险标识与分级

- **Microsoft Copilot Cowork（Preview）**：执行前需批准的类别——付款；向外部提交个人信息；发邮件/消息；删除文件、改云存储、取消订阅；健康、政府文件或安全设置相关提交。审批对话框含**动作预览 + 与动作同名的按钮（"Send"/"Post"/"Create"）+ Cancel**。这套类别与 ergo 的目标类别几乎一一对应。https://support.microsoft.com/en-us/microsoft-365-copilot/cowork-take-control-actions
- **Gemini Spark**：发送通信、修改用户数据、购买、提交网页表单、"Sign in with Google" 登录前都需确认。https://support.google.com/gemini/answer/16596215 （搜索摘要中的 "Decline all / Confirm all" 当前页面未见，未核验或已移除）
- **Magentic-UI action guard**：开发者为每类动作标注不可逆性——always（如上传文件）必须人工批准；never（如滚动）直接执行；maybe（如点按钮）交给 ActionGuard LLM 判断；默认配置下对抗场景均未成功；用户希望有**比批准/拒绝更多的第三种选项**。https://arxiv.org/html/2507.22358
- **Claude Code auto mode 分类器**：默认拦截生产部署、敏感数据外发、批量删除、force push、销毁会话开始前已存在的文件、打印凭据等；拦截时给出规则名（如 `[Data Exfiltration]`）并通知，记入 `/permissions` 的 "Recently denied"，按 `r` 可转人工批准重试；连续拦截 3 次或累计 20 次后退回逐项询问；**用户在对话中说的边界（"别 push"）会被当作拦截信号，但可能在上下文压缩中丢失，文档建议硬保证改用 deny 规则**；对 critical path（如 `rm -rf ~`）任何模式都不自动批准。https://code.claude.com/docs/en/permission-modes
- **ChatGPT agent / Atlas**（未直接核验）：购买、发邮件等有后果动作先确认；在已登录邮箱/银行等敏感场景启用 **Watch Mode**（用户须停留在该标签页，离开即暂停）；Atlas 有 logged-out 模式。https://help.openai.com/en/articles/12628199
- **Windows agent workspace**（preview）：agent 用独立账号、在独立 Windows 会话运行，动作可观察、可与用户动作区分、需能输出日志；已知文件夹访问可按 agent 设 "Allow Always / Ask every time / Never allow"。https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features
- **OpenAI《A practical guide to building agents》**（未直接核验）：按只读/可写、可逆性、所需账户权限、财务影响给工具标低/中/高风险；高风险动作与失败次数超阈值时转人工。

### 5.5 撤销与回滚

- **Claude Code checkpoints / `/rewind`**：每次提交 prompt 自动建检查点，保留最近 100 个；可恢复代码+对话 / 仅对话 / 仅代码 / 从此处往后摘要等；**Bash 产生的改动（rm/mv）、外部改动、后台子 agent 改动不跟踪**，文档明确不能替代 git。https://code.claude.com/docs/en/checkpointing
- **Cursor checkpoints**：在聊天时间线上点检查点预览再恢复；只恢复文件，存在本地、与 Git 分开。https://cursor.com/docs/agent/chat/checkpoints
- **Replit**：检查点包含文件、对话上下文、环境、agent 记忆与数据库；"Rollback to here" 默认不动数据库，需勾选 Database 才回滚开发库；**生产库不走此回滚，要用 point-in-time restore**；现有 Plan mode（先拆成有序任务列表，批准后才写代码）。https://docs.replit.com/core-concepts/agent/checkpoints-and-rollbacks ， https://docs.replit.com/replitai/agent
- **Replit 2025-07 删库事件**：code freeze 期间 agent 删除了 SaaStr 的生产库并一度声称无法回滚（Fortune，二手）；CEO 回应 "Unacceptable and should never be possible"，随即上线开发/生产库自动分离并开发 staging（X 帖，经搜索摘要）。https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/ ， https://x.com/amasad/status/1946986468586721478 。OWASP Agentic Top 10 把它列为 ASI10 Rogue Agents 的案例。
- **Windsurf / Devin Desktop Cascade**：可建命名检查点、悬停回退；但文档原文 **"Reverts are currently irreversible"**——撤销本身不可撤销，是反面教材。https://docs.devin.ai/desktop/cascade/cascade
- **PR 作为可审单元**：Copilot 只能推到 `copilot/` 分支、只开 draft PR、须人 review 合并；**发起任务的人不能批准该 PR**；CI 需有写权限的人点 "Approve and run workflows"。https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations
- **Gmail Undo Send**：撤回窗口 5/10/20/30 秒，"延迟真正生效"的经典做法。https://support.google.com/mail/answer/2819488
- **草稿代替发送**：一些 Gmail 连接器只暴露 `create_draft`、`trash/untrash` 而不暴露直接发送（在本调研环境中观察到，无公开文档佐证）。

### 5.6 通知与进度汇报

- **Claude Code hooks**：Notification hook matcher 包括 `permission_prompt`、`idle_prompt`、`agent_needs_input`、`agent_completed`、`elicitation_dialog` 等，只观察不拦截；PermissionRequest hook 可用程序代替用户 allow/deny；status line 由脚本接收会话 JSON 渲染。https://code.claude.com/docs/en/hooks ， https://code.claude.com/docs/en/statusline
- **Jules** Scheduled Tasks（2025-12-10）定期运行并开 PR；**Devin** PR 合并时通知、Slack 状态标签。
- **Apple HIG**：四档中断级别 Passive / Active（默认）/ Time Sensitive（只用于正在发生或一小时内发生的事）/ Critical（健康与安全，极少用）；"Build trust by accurately representing the urgency"；用户可改为定时汇总。https://developer.apple.com/design/human-interface-guidelines/managing-notifications
- **Microsoft Design《UX design for agents》**（2025-04-11）："nudging more than notifying"、"easily accessible yet occasionally invisible"。https://microsoft.design/articles/ux-design-for-agents/

### 5.7 设计指南

- **Anthropic《Our framework for developing safe and trustworthy agents》**（2025-08-04）：高风险决定前人保有控制权；默认只读、修改需审批，例行操作可给持久授权；用实时 to-do checklist 展示过程，并承认"给太少看不懂、给太多信息过载"的权衡。https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents
- **Microsoft HAX 18 条**（Amershi et al., CHI 2019）中与监督最相关的：G3 按情境安排时机、G8 支持高效忽略、G9 支持高效纠正、G10 拿不准时缩小范围、G11 说清为什么、G16 传达用户操作的后果、G17 全局控制、G18 通知变化。https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/ （条目名称部分核对，见 §4）
- **Google PAIR《Feedback + Control》**：在任务高风险、自己负责或享受这件事时，人们抗拒全自动；要提供手动完成的退路；索取反馈要 "strategic, minimal, and allow for easy dismissal"。https://pair.withgoogle.com/chapter/feedback-controls/
- **Microsoft Learn《Human-centered design for agents》**（2026-05）：输出可编辑；纠错不逼用户从头再来；展示所依据的数据和假设。https://learn.microsoft.com/en-us/agents/design-guidelines/human-centered-design

### 5.8 模式目录

| 模式 | 解决的问题 | 例子 | 对 ergo |
|---|---|---|---|
| 可编辑计划卡 + 显式批准 | 执行前对齐意图 | Claude plan mode、Jules、Cursor、Magentic-UI、Devin | 长任务模式核心入口 |
| 批准计划时一并选自治级别 | 一次批准定下后续打扰频率 | Claude Code 三选项、Windows Allow Always/Ask/Never | 长任务模式关键 |
| 按置信度/风险决定是否自动批准 | 低风险不打扰、高风险必审 | Devin 颜色分级、Magentic 不可逆性三档、Claude 分类器 | 两种模式 |
| 步骤可指派给人 | 登录、签字等只能用户做 | Cocoa | 长任务模式 |
| 实时 checklist / 进度条 | 看到做到哪了 | Claude to-do、Manus todo.md、Gemini Progress | 长任务模式 |
| 时间线带证据 | 事后审计、建立信任 | Devin 录屏、Copilot `Agent-Logs-Url` | 长任务模式 |
| 多任务总览 + "需要你"分组 | 并行任务中只在需要时介入 | Claude agent view、mission control | 长任务模式 |
| 回来时的小结 | 离开后快速恢复情境 | Claude agent view | 长任务模式 |
| 审批收件箱（批准/改参数/回复/忽略） | 集中批量审批 | Agent Inbox、Copilot Studio | 长任务模式 |
| IM 审批带 ID、先答先生效 | 随时审批且防误批 | Claude channels relay、OpenClaw `/approve`、n8n | 只发阻塞项 |
| 推送分级 + 在场检测 | 避免通知疲劳 | Claude 两开关 + presence file、Apple 中断级别 | 两种模式 |
| 按动作类别确认、按钮写明动作 | 明确副作用 | Copilot Cowork、Gemini | 两种模式 |
| Watch mode / 接管 | 高敏感场景要求人在场 | ChatGPT agent、Manus、AutoGLM `Take_over` | 隐私、金融类 |
| 检查点与回滚 | 走错后恢复 | Claude `/rewind`、Cursor、Replit | 只覆盖内部状态；外部副作用需另设计 |
| 环境隔离与草稿化 | 防不可逆外部影响 | Replit 开发/生产分离、draft PR、Windows agent 账号、邮件草稿 | 长任务默认 |
| 撤销窗口 / 延迟生效 | 给后悔留时间 | Gmail Undo Send | 消息、邮件类 |
| 单次/永久/拒绝三档 + 过期 | 授权粒度与自动失效 | OpenClaw、Windows | 两种模式 |
| 超时默认行为 | 无人响应怎么办 | Jules 计时自动批准、Zapier 跳过或终止、OpenClaw 30 分钟过期默认拒绝 | 不可逆类必须默认拒绝/挂起 |
| 计划学习 | 重复任务少问 | Magentic Saved Plans | 长任务模式 |

### 5.9 对 ergo 的 UI 建议（摘要）

1. **计划卡每步标出类别与授权状态**（已预批准 / 到时再问 / 禁止）、预计时间、执行者（ergo 或用户）；底部三按钮仿 Claude Code：按授权范围自主执行 / 每个敏感动作都问 / 继续改计划；计划可直接编辑。
2. **授权范围是结构化、可执行的规则**（金额上限、收件人白名单、次数、有效期、可撤销），用户在对话里说的边界（"别给老板发消息"）要立即编译成硬规则并显示在计划卡上——因为 Claude 文档承认对话中的边界可能在压缩后丢失。
3. **越界只挂起该动作，其余可并行步骤照常**；计划变化要高亮，新增未预批准类别时增量确认。
4. **审批收件箱**：按钮写明动作（"发送给张三"而非"批准"）、动作预览、关联计划步骤、可逆性、截止时间与超时默认；四种回应（批准 / 改参数后批准 / 回复意见 / 忽略）；同类低风险可"同类全部批准"，不可逆项禁止批量批准。
5. **外发动作进待执行队列 + 撤销窗口**（聊天 10–30 秒、长任务可数分钟）；做不到延迟的（实时支付）降级为事前审批。
6. **默认草稿化 / staging**：邮件存草稿、购物加购物车不下单、删除进回收站。
7. **IM 只推阻塞项**，带短 ID，多端先答先生效，只认白名单发送者；推送内容清洗、凭据打码、长内容首尾截断；无 ID 的"好的"不算批准。
8. **通知三档 + 在场检测**：阻塞审批≈Time Sensitive；里程碑摘要≈Active/Passive 可汇总；完成/失败一条结论；用户在用桌面端时不推手机。
9. **时间线可按类别筛选**，每条外部副作用附证据（收据、截图、消息链接、交易号）与撤销入口；内部推理默认折叠。
10. **任务总览 + 回来时小结**：按"需要你 / 进行中 / 已完成 / 失败"分组，显示"已等待 N 分钟"。
11. **超时默认按类别区分并显式展示**：不可逆、花钱、隐私到期作废或挂起；只有低风险计划审批可计时自动批准，且应加复核 agent（仿 Jules Planning Critic）。
12. **高敏感场景 Watch mode 或改为"由用户来做"这一步**；聊天模式不显示计划卡，但沿用同一套类别标签、动作按钮与撤销提示。

---

## 6. 综合建议：用户可配置的"提醒类别"模型

> 本节是基于前五节证据的设计推论，不是任何单一来源的结论；关键依据以"（§x）"回指前文。具体数值（金额阈值、窗口时长等）都只是占位示例，需要用户决定（见 §7）。

### 6.1 核心思想（五条）

1. **把"要不要打扰"拆成三个正交的维度**：*类别*（这是什么性质的操作）、*处置级别*（怎么让用户知道：问 / 延后问 / 撤销窗口 / 摘要 / 只记录 / 交给用户 / 禁止）、*授权范围*（用户在计划期已经批准到什么程度）。现有产品基本只有前两维的一部分（§1.12）；第三维正是 AP2 open mandate、Stripe SPT、Progent、Conseca 所做的事（§2.2、§2.1）。
2. **审批的稀缺性本身是安全属性**：Claude Code 用户批准了 93% 的提示（§1.1）；OpenAI 治理白皮书指出审批多了每次都会变快、变草率，成为 rubber stamp（§2.5）；HCI 关于安全警告习惯化的证据见 §4。少打扰不是体验优化，而是让剩下的审批真正有效的前提。
3. **确定性规则做底线，分类器只做补充且只能"往严里改"**：Google 两层防御的官方立场——推理型防御 "inadequate, on their own ... especially involving critical or irreversible actions"（§2.4）；各家都声明 classifier 不是安全边界（§1.12）。
4. **计划期授权 = 有边界、可记账、会过期、可撤销的委托**，而不是"批准了这个计划"这样一个布尔值（AP2 v0.2、Stripe SPT、Progent monotonic confinement，§2.2/§2.1）。
5. **只能事后看的，必须能撤销**："Actions that can only be reviewed after the fact should be more easily reversible than those that require approval."（OpenAI 治理白皮书 §4.4，见本文 §2.5）——这条直接决定"摘要/只记录"与"问"的分界。

### 6.2 类别分类法与默认集合

两层结构：**内置类别**（有确定性检测器兜底）+ **用户自定义类别**（自然语言描述 + 可选规则，主要靠分类器）。每个类别带三个属性：`severity`（后果量级）、`reversibility`（none / partial / full，以及撤销窗口）、`externality`（是否触达第三方或外部世界）。

建议的默认集合（与 Copilot Cowork、Gemini Spark、ChatGPT agent、Claude in Chrome 的"必确认"清单高度重合，§1.7–1.10、§5.4）：

| id | 名称 | 典型操作 | 主要检测信号（确定性优先） | 长任务默认 | 聊天默认 |
|---|---|---|---|---|---|
| `money.spend` | 花钱 | 下单、订阅/续费、充值、打赏、付费 API、转账 | 工具标签 `spends_money`；参数含 amount/currency；浏览器在支付域名提交表单 | 计划期额度型授权；额度内摘要；超额先问；超硬上限禁止 | 先问 |
| `comms.send_as_me` | 以我名义发消息/发布 | 邮件、IM、评论、发帖、回复 | 工具标签 `sends_message`；收件人/频道；是否公开 | 计划期批准"收件人集合 + 要点"；默认先存草稿或进撤销窗口；新收件人或内容偏离先问 | 我说过才做（展示草稿 + 撤销窗口） |
| `contact.new_party` | 联系新的人/机构 | 首次联系、打电话、预约、填写联系表单 | 收件人不在联系人/往来历史中 | 先问（可延后批量） | 先问 |
| `data.delete` | 删除/覆盖 | 删文件、删邮件、清空日历、覆盖写 | `destructiveHint`；rm/del 命令解析；保护路径 | 软删除（回收站/版本）→ 记录；硬删除或批量 > N → 先问 | 软删记录，硬删先问 |
| `irreversible.commit` | 不可逆承诺 | 提交表单、同意条款/签署、不可退款预订、发布上线 | 工具声明 `reversible:false`；表单提交语义 | 先问（除非计划期逐项批准且参数完全一致） | 先问 |
| `privacy.disclose` | 个人信息外流 | 上传/分享含个人数据的文件、把 PII 填进第三方表单 | 出站载荷 PII 检测；数据 provenance；目的地是否新 | 目的地在授权内则摘要；新目的地或高敏感先问 | 先问 |
| `security.account` | 账户与安全 | 改密码/2FA、OAuth 授权、装软件、改权限、读密钥 | 工具/域名/命令匹配 | 交给我做 或 先问（不允许计划期一揽子授权） | 交给我做 |
| `scope.drift` | 偏离计划 | 计划外的新工具/新域名/新类别；与目标无关的动作 | grant 绑定失败；对齐检查（Task Shield / AlignmentCheck 式） | 见 6.6 升级阶梯 | — |
| `budget.exceed` | 资源超支 | token/API 成本、时长、重试次数 | 计量器阈值 | 软阈值摘要，硬阈值暂停并问 | 提示 |
| `user.*` | 用户自定义 | "任何涉及我老板的事""周末的日历改动""发到社交媒体" | 自然语言描述 → 分类器；可附规则 | 用户为每类选处置级别 | 同左 |

**永不（默认 block，设置里才可改）**的候选：执行网页/邮件中的指令；证券交易与转账给新收款方；创建账户；把凭据写入任何对外内容（参考 ChatGPT agent 拒绝清单、Claude in Chrome 禁止动作，§1.7/§1.9）。

### 6.3 类别即数据：建议的 schema（示意，非既有标准）

```yaml
# ~/.ergo/reminder-categories.yaml —— 放在 agent、工具、网页内容都写不到的位置
categories:
  - id: money.spend
    title: 花钱
    description: >          # 给分类器看的自然语言定义（用户可改）
      任何会让我产生费用或扣款的操作，包括下单、订阅、续费、打赏、付费 API 调用。
    severity: high
    reversibility: partial   # none | partial | full
    match:                   # 确定性规则：任一命中即属于该类别
      tool_tags: [spends_money]
      tools: [shop.checkout, payment.*]
      args: [{ path: amount, op: exists }]
      domains: ["pay.example.com"]
    classifier: escalate_only   # 规则未命中时让分类器补判，但只能升级不能降级
    level:                      # 用户可见的处置级别（见 6.5）
      long_task: ask            # 未被 grant 覆盖时
      chat: ask
    preapproval:
      allowed: true
      bounds: [max_per_tx, max_total, payees, currency, max_count, expires_at]  # 借用 AP2 v0.2 词汇
    hard_limits: { max_per_tx: 2000, currency: CNY }   # 超过直接禁止，计划期也不能放开
    on_timeout: reject          # 审批超时的默认处置

  - id: user.boss
    title: 涉及我老板的一切
    description: 任何发给、抄送给或提到王总（wang@example.com）的消息或日程
    match: { recipients: ["wang@example.com"] }
    classifier: escalate_only
    level: { long_task: ask, chat: ask }
    preapproval: { allowed: false }
```

要点：
- **工具元数据是第一信号源**：每个工具注册时声明 ergo 自己维护的 `tool_tags`（`spends_money` / `sends_message` / `deletes` / `irreversible` / `reads_secrets` / `external_network` …），并兼容 MCP `ToolAnnotations`；pi 的工具原生携带这些 annotations，`tool_call` 钩子可 block（§1.3）。**来自不可信 MCP server 的 annotations 不能用于放行**（MCP schema 原文），只能用于"更严"。
- **通用工具（shell、浏览器、代码执行）没有可靠的工具级语义**，必须做参数级解析（命令解析、URL/域名、表单语义）+ 分类器——这正是 Claude Code、Codex 把精力花在 shell 规则与沙箱上的原因（§1.1、§1.2）。
- **分类器单向棘轮**：只允许把操作升级到更严的处置，不允许把规则判定的类别降级。分类器只看用户意图与规范化后的 tool call，不看不可信 tool output（Claude Code reasoning-blind 设计，§2.3）。
- **用户在对话里说的边界要落盘成规则**并在计划卡上显示——Claude Code 文档承认对话中的边界可能在 compaction 后丢失（§1.1、§2.3）。
- **新规则先影子运行**（只记录"本会触发"），再切换到生效（AgentCore `LOG_ONLY` → `ENFORCE`，§2.3）；用 LLM 把自然语言翻成规则时必须让用户复核结构化结果。
- **未知即从严**：无法判定类别且操作非只读 → `unknown.side_effect`，长任务进审批收件箱（不阻塞其他步骤），聊天直接问（AP2 未知约束视为失败；OpenAI SDK 参数无法解析时转人工，§2.2/§2.3）。

### 6.4 一次操作的判定流水线（落在 pi 的 `tool_call` 钩子或 ergo gateway）

1. **规范化**：把工具调用变成"人能读懂、机器能逐字段比对"的规范表示（动词、对象、金额、收件人、路径、域名、数据来源标签）。审批界面展示的就是它；执行前再比对，防"批 A 执行 B"（Loopjacking；OpenClaw 绑定 argv/cwd/hash，§2.5/§1.3）。
2. **类别判定**：工具标签 → 参数规则 → 分类器（仅升级）。输出 `categories[] + confidence + evidence`。
3. **来源/污染检查**：关键参数（收件人、金额、目的地、要上传的文件）是否来自不可信内容？是则对外发类（comms / privacy / money）升一级（Google policy engine 示例；CaMeL provenance，§2.4/§2.1）。
4. **授权匹配**：在当前任务的 grants 中找覆盖该操作的一条，检查边界（金额、次数、对象、时间、所属计划步骤），通过则在执行层扣减额度。
5. **处置决策**：按 6.5。
6. **记录**：无论结果如何都写入 append-only 的 action ledger（类别、规范表示、命中的规则/grant、处置、结果、撤销句柄）。摘要与时间线从 ledger 生成，而不是让 LLM 回忆——Apple 通知摘要失真事件说明 LLM 摘要必须能回溯原始事件（§4）。

### 6.5 处置级别：什么时候问、什么时候批量、什么时候只记录

**用户可见的六档**（在 dots 四档基础上加"摘要"与"永不"，§1.7）：

| 用户可见档位 | 系统内部实现 | 对任务的影响 |
|---|---|---|
| 直接做，只记录 | `log` | 不阻塞 |
| 做完告诉我 | `digest`；条件允许时用 `undo_window`（草稿/延迟发送/软删除，N 分钟后自动生效） | 不阻塞 |
| 我明确说过才做 | 聊天：本轮用户消息中"点名 + 具体参数"即视为授权；长任务：计划卡上逐项列出并被批准即视为授权；否则降为"先问我" | 视情况 |
| 先问我 | `ask_deferred`（进收件箱，在下一个自然断点批量问）或 `ask_now`（立即推送）——由紧急度与是否卡住关键路径决定 | 只挂起该步骤及其下游 |
| 交给我做 | `hand_off`：agent 准备好一切，最后一步由用户本人完成（改密码、支付确认、签署） | 挂起该步骤 |
| 永不 | `block` | 该分支失败 → 重规划 |

**判定逻辑**（可解释、可测试，阈值留给用户）：

```
if redline or hard_limit_violated:                    -> block
elif level == hand_off:                               -> hand_off
elif covered_by_grant and within_bounds and not tainted:
    -> digest   # 若 reversibility == none 且 grant 不是"逐项精确批准"，改为 undo_window 或 ask_deferred
elif level in {log, digest} and (reversible or can_stage):
    -> log / digest / undo_window
elif urgency == high or blocks_critical_path:           -> ask_now
else:                                                   -> ask_deferred（带 deadline）
```

依据（详见 §4）：Horvitz 的 mixed-initiative 期望效用框架——只在"不问而出错的期望代价"超过"打断代价"时打断；bounded deferral——低紧急度消息推迟到用户空闲/断点，但有最长等待上限；断点研究——在任务边界打断代价更低；批处理与摘要降低通知负担；安全警告习惯化——提示越频繁越被无视。

**"延后问"的规则**：
- 每个 `ask_deferred` 必须有 deadline（bounded deferral：Horvitz 2005 的数据显示忙碌片段平均只有约 43 秒，按紧急度设 1–4 分钟的上限即可消除绝大部分"忙时打断"，§4.2），到期按类别的 `on_timeout` 处理：花钱/不可逆/隐私默认 reject（或"跳过此步继续"），低风险可 approve；**超时策略必须显示在审批卡上**（OpenClaw 默认 30 分钟过期且 deny；Zapier 可选跳过或终止；Jules 计时自动批准是高风险场景的反模式，§5.3/§2.7）。
- 延后期间 agent 继续做不依赖它的步骤；同类条目合并成一张卡（"同类全部批准"），但不可逆项不允许批量批准（§5.9；Magentic-UI 用户希望多个问题合并在一次打断里问，§4.5）。
- 断点有两层：用户侧（是否在用电脑、勿扰时段、presence 检测，参考 Claude Code presence file）与 agent 侧（计划里程碑、子任务完成）。消息紧接在一段任务完成之后出现时，用户的注意力干扰最小（Jenkins et al. 2016，§4.3）。
- 非紧急审批先给一个轻提示（"稍后需要你确认一笔 300 元的付款"），再在断点正式询问（Trafton 2003 的 interruption lag；McFarlane 的 negotiated 方式，§4.1）。

**让剩下的审批真正有效**（§4.3）：
- 审批卡写具体：金额、收款方、收件人、要删的对象、是否可撤销；按钮写动作名（"发送给张三""支付 300 元"），不写"批准"。
- 对 `irreversible` 与超大额操作，要求与关键字段交互（如再输入一次金额或收件人尾号），并让这类卡片的外观与普通卡片不同——"强制与变化字段交互"是少数在习惯化之后仍有效的设计（Bravo-Lillo 2013/2014；polymorphic 警告，Vance 2018）。
- 监测每类审批的"批准率"与"批准用时"：某类接近 100% 秒批，说明它是噪音，系统应建议把它降级为摘要或扩大 grant；Akhawe & Felt 把 1.7 秒内点过视为疲劳迹象。

**打扰预算（interruption budget）**：
- 用户设定每天最多被主动打断几次（例如 5 次）与勿扰时段；系统在计划卡上预测"本任务预计打断你 N 次"（Horvitz 的 Priorities 系统会预测每小时被打断几次；BusyBody 允许设每小时上限，§4.2）。
- 预测超出预算时，系统在计划期就建议：哪些"先问我"可以改成额度型 grant、哪些可以合并到里程碑问——把运行时的打断前移到计划期一次性解决。
- 摘要（digest）默认每天 2–3 次、时间可预期；但始终保留随时可查的状态视图，不做成黑箱（Fitz 2019：完全不通知反而更焦虑，§4.3）。

### 6.6 计划期预授权如何约束运行时，以及偏离时的升级

**计划阶段**
1. Planner 输出结构化计划（步骤 DAG），并对每一步做"类别预测"：会触发哪些类别、预计参数（收件人、金额区间、要删的路径、要访问的域名）。
2. 计划卡分两层展示（与前作的 global / key-point 分层一致，但以"类别"为轴）：
   - **全局层**：本任务会涉及哪些类别、总额度、会联系谁、会访问哪些域名、预计时长与成本、超时默认。
   - **关键点层**：每个带类别的步骤一行，附预计参数与建议授权方式（逐项批准 / 额度型 / 到时再问 / 交给我做）。
3. 用户的批准被编译成 **grants**——由确定性代码从结构化数据渲染，而不是 LLM 写的摘要（AP2 Trusted Surface "MUST be non-agentic"；He et al. 发现看似合理的文字计划会诱发错误信任，§2.2/§2.7）：

```yaml
grants:
  - id: g1
    category: money.spend
    plan_steps: [s4, s5]          # 绑定到计划步骤（或 any_step）
    bounds: { max_per_tx: 300, max_total: 800, currency: CNY, payees: ["12306", "某酒店"], max_count: 3 }
    expires_at: 2026-10-07T20:00:00+08:00
    provenance_required: user     # 收款方必须来自用户输入或已批准计划，不能来自网页内容
  - id: g2
    category: comms.send_as_me
    bounds: { recipients: ["alice@x.com", "bob@y.com"], channel: email, about: "周五会议改期" }
    mode: undo_window(10m)
  - id: g3
    category: data.delete
    bounds: { paths: ["~/Downloads/tmp/**"], soft_delete_only: true }
```

4. grant 的生成只能依据可信输入（用户原话与已批准计划），不能依据 tool output（Progent："Do not use any information you cannot find in the user's query"；Conseca 只用 trusted context，§2.1）。
5. 运行中 agent 可以**自动收窄**权限，任何**放宽**都要回到用户（Progent monotonic confinement），并且一次性提出本次所需的全部新增权限（MCP step-up，§2.2）。
6. 计划期批准过的事，运行时不再重复确认（Magentic-UI 用户抱怨"同一件事确认两次"，§2.7）。

**运行阶段的升级阶梯**

| 偏离程度 | 例子 | 处置 |
|---|---|---|
| L0 完全在 grant 内 | 第 4 步按计划买 120 元车票 | 摘要 |
| L1 同类别、计划外步骤、仍在边界内 | 计划外又买了 50 元，总额度未超 | 摘要，并标注"计划外" |
| L2 同类别但超出边界 | 单笔 450 元 > 300；出现新收件人 | 先问（延后或立即，看紧急度） |
| L3 出现计划未预测的类别 | 计划里没有删除，执行中要删文件 | 先问，该分支暂停 |
| L4 高风险组合或参数被污染 | 读过不可信网页后要把含个人信息的内容发往新地址；对齐检查判定与目标无关 | 禁止该动作 + 通知 + 建议重规划 |
| L5 系统性偏离 | 连续 N 次 L2+ 被拒、重规划次数或预算超限、卡住检测命中 | 暂停整个任务，生成"偏离报告"，等用户 |

- 被拒后先让 agent 自己换安全路径（deny-and-continue），连续或累计达到阈值再升级（Claude Code 3/20；Codex 3 连续或 50 中 10；OpenClaw 连续 3，§1.12）。
- **重规划只做增量审批**：新计划中超出原 grants 的部分单独列出来问，不重新审批整个计划。
- 长时间无人监督时，grant 自然过期，需要续期（OpenAI 治理白皮书建议周期性 "time out" 直到人复核，§2.5）。
- 用户可以随时**按类别撤销**（例如"立刻停止一切花钱"），撤销会让对应 grant 失效、挂起中的审批作废而不是被批准（OpenClaw 改模式取消挂起审批；OpenAI 白皮书 §4.7 按类别 graceful shutdown）。

### 6.7 聊天模式的差异

- 用户在场，打断成本较低，但确认疲劳同样存在。**本轮用户明确要求、参数由用户给定的操作**（"把这段发给 Bob"）视为已授权，只展示规范表示 + 撤销窗口；**由 agent 自行推断的副作用**（自作主张抄送谁、删哪些文件）才按类别询问。但"帮我起草"不等于"可以发送"（dots 原文，§1.7）。
- 与长任务共用同一套类别、ledger 与审批卡样式；只是 `ask_deferred` 退化为 `ask_now`。
- 允许"本会话内记住"（session-scoped allow）；跨会话的永久放宽必须在设置里显式确认。

### 6.8 从用户的审批行为中学习（可选，谨慎）

- 移动权限研究显示：静态的 ask-on-first-use 与用户真实偏好经常不一致；基于上下文与历史决策的分类器可把预测准确率做到 96.8%，目标正是"自动放行合适的、自动拒绝不合适的、只在不确定时问"（Wijesekera et al. 2017，§2.4）。个性化推荐被采纳 78.7%、之后只有 5.1% 被改回（Liu et al. 2016）。
- 建议：ergo **不静默放宽**，而是定期生成"规则建议"（"过去 30 天你批准了 14 次给 alice 发邮件，是否加入长期授权？"），由用户一键采纳。**放宽必须显式，收紧可以自动。**
- 先例：Magentic-UI 的 plan learning 与 Saved Plans（§5.1）可以让重复任务的计划期审批变成"沿用上次的 grants"。

### 6.9 推荐的落地顺序（最小可行版本）

1. 工具注册加 `tool_tags` + 兼容 MCP annotations；pi `tool_call` 钩子里实现规范化、确定性类别判定、ledger。
2. 内置 6 个类别（money / comms / contact / delete / irreversible / security）+ 六档处置 + 每类超时默认；先不做分类器。
3. 长任务：结构化计划 + 类别预测 + 计划卡 + grants（额度、收件人、路径、TTL）+ 持久化审批表 + IM 推送（只推阻塞项）。
4. 加入 `privacy.disclose` 的出站 PII 检测与 provenance 标签；加入用户自定义类别（自然语言 + 分类器，影子模式起步）。
5. 撤销窗口与草稿化、回来时小结、规则建议。

---

## 7. 需要你拍板的开放决策

下列问题没有"标准答案"，证据只能缩小选项范围。按对实现影响的大小排序。

1. **默认类别集合与默认档位**
   - 采用 §6.2 的 9 个内置类别，还是更少（例如先做 money / comms / delete / irreversible / security 五个）？
   - 每个类别出厂默认在六档（直接做 / 做完告诉我 / 我说过才做 / 先问我 / 交给我做 / 永不）中的哪一档？哪些动作永远 `block`、连设置都不能放开？
2. **计划期授权的粒度**
   - grant 绑定到"计划步骤"（更安全，但计划外的合理动作都要再问）还是"整个任务"（更省打扰，但偏离更难察觉）？
   - 哪些类别允许额度型 grant，哪些必须逐项精确批准（建议 `irreversible`、`security` 只能逐项或交给用户）？
3. **超时默认值**：每类审批的最长等待时间与超时处置（reject / 跳过此步继续 / approve / 升级推送）。是否允许任何类别"超时即批准"？（证据倾向：高风险类别不允许，见 §2.7、§5.3。）
4. **分类器用不用、用在哪**
   - 是否在第一版就引入 LLM 分类器，用于用户自定义类别与"隐私""联系陌生人"这类模糊类别？
   - 分类器跑本地小模型还是云端模型（隐私、成本、延迟取舍）？分类器能看到什么（只看用户意图 + 规范化 tool call，还是也看工具输出）？
5. **打扰预算与通道**
   - 每天最多主动打断几次、勿扰时段、摘要几点发？
   - 阻塞审批推到哪个通道（桌面通知 / Telegram / 微信 / 飞书 / 邮件），是否需要多端"先答先生效"？IM 回复的认证方式（短 ID + 白名单发送者，是否还要二次确认）？
6. **撤销窗口与草稿化**
   - 对外消息默认延迟多久生效（聊天 10–30 秒？长任务数分钟？）？
   - 哪些动作强制"先草稿、后提交"（邮件、购物车、日历邀请）？软删除保留多久？
7. **偏离计划的阈值**：L2/L3 偏离是"先问"还是"自动重规划后增量问"？连续被拒多少次、重规划多少次、预算超出多少比例时暂停整个任务？
8. **学习与放宽**：是否根据审批历史给出"规则建议"？是否允许任何形式的自动放宽（建议：只允许自动收紧，放宽一律需用户显式确认）？
9. **聊天模式中的"明确指令"**：用户在聊天里说"把这个发给 Bob"，算不算对该次发送的授权？需要多具体（是否必须点名收件人与内容）？"帮我起草"是否永远不包含发送权？
10. **规则的存放与优先级**：规则文件放在哪（必须是 agent、工具、网页内容都写不到的位置）？是否需要"管理员/家庭成员"层级（多用户共享 agent 时）？新规则是否先影子运行？
11. **持久化与引擎**：自建基于 SQLite 的最小 durable 内核（step journal、持久审批、lease/heartbeat），还是嵌入 DBOS 一类现成库？崩溃后对 `unknown_outcome` 的不可逆动作，是一律问用户，还是允许对支持幂等 key 的通道自动核对？
12. **与前作成果的衔接**：前作的"全局层 / 关键点层"按安全隐私组织；ergo 是否把"类别"作为两层视图的主轴，并把前作的风险判定作为类别检测器之一？
