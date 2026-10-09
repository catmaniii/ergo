# 70 — 先跑通功能：对话里一律直接做、秘书能联网，所有 agent 配上 web_search / web_fetch

Status: done
Blocked by: None — can start immediately
Spec: [第一阶段规格](../spec.md) 第 7 节（秘书不能联网）、守卫的关注类别和处置；调研 `docs/research/17-auto-mode-reviewer-agent.md` 的"用户已定"一节

## What to build

用户 2026-10-10 定：**先把功能全面跑通，后续再接入安全机制**；已经实现的安全机制代码保留，但按下面的范围关闭使用。

**关掉**
- **普通对话里的"先问我"**：秘书会话、项目维护者的对话段里，关注类别处置是"先问我"的，一律按"直接做"（照常记录、照常标关注类别）。花钱照旧"交给我做"。
- **秘书不能联网**：去掉代码里写死的 `network: false`，秘书和其他 agent 一样能联网，bash 不再设无效代理。

**保留**
- 长程任务和流程的计划、授权、授权项、执行时的时序规则和逐步核对（58、59 号票），以及任务里的处置。
- 硬拒绝：不许改二狗自己的数据库和配置（受保护区域），不读密钥文件。

**照常**
- 工具调用记录、完整内容、效果记录、关注类别标注照记。以后一个开关就能把对话审批打开。

**给所有 agent 配齐工具**
- 新加两个二狗自己的工具（宿主工具）：
  - `web_search(query, n?, time?)`：联网搜索，返回标题、链接、摘要；
  - `web_fetch(url, max?)`：抓网页正文纯文本。
- 做法照用户 `~/.pi/agent/skills/web-search`：playwright-core 驱动系统 Chrome 真实渲染，不要 API key；搜索默认 DDG，失败回退 Bing、Google；抓取被 403、429 拦时切浏览器兜底。
- 给秘书、任务维护者（起草和执行）、项目维护者、子 agent 都配上；评审子 agent 不配。
- grep、find、ls 给所有 agent 都开上。之前因为首次使用要下载程序、被联网开关去掉了。

## Acceptance criteria

- [x] 一个配置开关（比如 `guard.conversationApprovals: "off" | "on"`，默认 off）控制对话里的"先问我"；off 时对话里不出审批卡，记录里照样有关注类别；on 时恢复原样。任务和流程不受这个开关影响。
- [x] 秘书能联网；规格第 7 节、用户故事 19 改写；写一条 ADR，说明"先跑通功能、安全机制后接"和关闭范围，链接调研 17。
- [x] `web_search`、`web_fetch` 是带类型的工具：守卫看得懂参数（网址、查询词），会话里的工具调用记录、详情页照常显示，性质算"只看"。
- [x] Chrome 路径可配置（默认找系统 Chrome / Edge），找不到时工具回一句清楚的错误。
- [x] 测试用假的搜索、抓取实现，不连真网络；有一条可以手动跑的冒烟脚本，测真网络（不进 CI）。
- [x] 受保护区域、密钥文件的硬拒绝照旧有效，有测试。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 秘书的系统提示里"不能联网、要联网就发起任务"之类的说法一并改掉。
- 71 号票会把系统提示挪到 md 文件里，本票先改现在的位置。
- 新依赖 playwright-core（照用户 web-search skill 用的 1.61.0，约 13 MB）写死版本；不下载浏览器，用系统装的 Chrome。**装依赖算下载，要用户点头**：先把开关、联网、工具接口和假实现做完，到要 `npm install` 时停下回报，主会话问过用户再装。
- grep、find 首次使用时 pi 会下载 rg、fd：测试里不许触发下载（用假的或本机已有的）；线上要不要让它下载，回报时写清楚，由主会话问用户。

## Comments

- 2026-10-10 实现（worktree-agent-a192c45444dc0b32e）。说明在 `docs/dev.md` 的"守卫核心"（判定的输入 `conversationApprovals`）、"守卫接入运行时"（秘书能联网、grep 和 find 照给、对话审批的开关）、新的"联网工具"一节和"配置"；决策记在 ADR-0026；规格第 7、9 节和用户故事 19 改写，`CONTEXT.md` 的秘书、两份 README 跟着改。
  - **开关**：数据目录 `config/ergou.json` 的 `guard.conversationApprovals`，`"off"`（默认）或 `"on"`（`config.ts` 的 `parseGuard`）。守卫接入把它交给判定函数；关着时**不属于任务的调用**里"先问我"的依据按"直接做只记录"（`judge.ts` 的 `relaxConversationAsks`，依据记 `approvalsOff`），关注类别照常命中、照常写进工具调用记录、效果日志、完整内容，聊天里不出审批卡。判定函数不传按 `on`；测试底座默认 `on`（原有审批的用例测的就是这套），测关掉的显式写 `off`。
  - **和票面不一样、请主会话确认的两处**：
    - 票面写"秘书会话、项目维护者的对话段"；实现按"不属于任务的调用"一刀切——还包括任务维护者起草计划、项目维护者起草计划的工单段（它们原来就按对话里的处置判，不属于任务）。任务（含带授权的会话段、定时作业的一次运行）照旧。
    - 脚本里写着受保护区域（配置区、数据库区、程序目录）路径的"未知的写操作"照旧先问（`keepAsking`）：守卫看不出脚本是读还是写，放成直接做就等于受保护区域只剩"文件工具和 bash 直接写"那一层。这一种在开关关着时对话里**仍会出审批卡**。
  - **秘书能联网**：`secretary.ts` 的 `SECRETARY_NETWORK = true`（守卫的工具包和拉起时的 `network` 都用它），`judge.ts` 去掉"秘书一律按联网关着判"，bash 不再设无效代理；系统提示里"不能联网、联网请发起任务"改成能联网的说法（`secretary/system-prompt.ts`，草稿区外的说法跟着开关写）。联网关着时的那一套（守卫拒绝、脚本扫描、无效代理）代码都在，联网关着的维护者照旧用。节假日续期事项里"（秘书不能联网）"也去掉了（`holiday-check.ts`；旧事件的改名对照表 `LEGACY_WORDING` 不动）。
  - **起草计划的工具包开了联网**（`PLANNING_TOOLKIT = { bash: false, network: true }`）：票面要任务维护者起草时也配上联网工具，联网关着的话配上了也用不了。起草时没有 bash、MCP，会联网的只有两个工具。项目维护者立项书确认之前的对话段同起草时（原来是"不带 bash、不联网"）。
  - **两个工具**（`packages/daemon/src/web/`）：`web_search(query, n?, time?)`（n 默认 8，time 是 d/w/m/y）→"搜索: … （N 条）"加编号的标题、链接、摘要；`web_fetch(url, max?)`（只认 http(s)，max 默认 8000 字）→"URL / 标题 / 正文"，超长截掉并注明原长。登记在框架自带的注册表（`tool-registry.ts` 的 `WEB_TOOLS`，来源 `web`：只读或幂等、`network`、`pullOnly`、不落入类别；query 是内容类参数、url 是网址参数），守卫、效果记录、详情页、流程步骤都认得。配给秘书、任务维护者（起草和执行，含多项目任务的维护者）、项目维护者各段、定时作业的维护者、子 agent（从维护者收窄）；评审子 agent 不配。
  - **照 web-search skill 做、偏离的地方**（请主会话确认）：搜索 DDG → Bing → Google、质量门、反爬识别、读网页 403/429 换浏览器都照搬；skill 的 `--engine`、`--region`、`--tavily`、`--raw`、`--browser`、`--json` 不给（票面定的接口）；浏览器起不来时不再试下一个引擎，直接报"找不到浏览器"；实体解码多了一个码点范围检查（skill 遇到非法码点会抛错）。
  - **浏览器路径**（`web/browser-path.ts`，照 drama_maker 的 `chromeExecutablePath()`）：配置 `web.browserPath` → 守护进程环境里的 `AGENT_BROWSER_EXECUTABLE_PATH` → `~/.agent-browser/browsers/chrome-*`（签名的副本）→ 系统 Chrome → 系统 Edge；跳过没签名的，全没签名才兜底。偏离：多了配置项（排第一）和 Edge；用户 web-search skill 里 playwright 自带 chromium 那一项没有（不下载浏览器）。（更正：原来这里把"playwright 自带 chromium"错记成 drama_maker 的，它是 skill 的 `resolveExecutable` 里的；drama 没有这一项。评审后已改成照 drama 原样，见下一条。）找不到时工具回"找不到浏览器（Chrome 或 Edge）。在数据目录的配置里写 web.browserPath……找过：……"。拉起 agent 时同一个路径注入 bash 的环境（`agent-manager.ts` 的 `shellEnvFor`），72 号票的 agent-browser 能直接用。
  - **依赖**：`playwright-core` 写死 1.61.0（用户点过头），lock 里只多它一项；不下载浏览器。
  - **grep、find 给所有 agent**（原来联网关着的会话去掉）：子进程环境固定带 `PI_OFFLINE=1`，pi 只在 `<用户主目录>/.pi/agent/bin` 和 PATH 上找 rg、fd，找不到就让工具出错，**从不下载**（契约测试在空的临时主目录里核过）。本机 `~/.pi/agent/bin` 已有 rg、fd，正式环境能用。**线上要不要放开下载**（去掉 `PI_OFFLINE` 会连带打开 pi 别的自动联网），请主会话问用户；本票没放开。
  - **已知缺口（只记录）**：`web_fetch` 由守护进程发请求，能读到本机端口（含二狗自己的 8810）；直接请求不设正文上限和超时（照 skill）。
  - **测试**：联网一律是假的（`test/helpers/web.ts` 的 `fakeWebAccess`、`FakeBrowser`；浏览器路径是临时目录里假的 `chrome.exe`）。守卫切面 `conversation-approvals.test.ts`、`web-tools.test.ts`、`network.test.ts`；`test/web/` 四个文件；主切面 `web-and-approvals.test.ts`（秘书搜索和读网页、开关两种状态、关着时受保护区域写入和读密钥照旧硬拒绝）、`maintainer-web.test.ts`；契约 `shell-env.contract.test.ts`。真网络只有手动跑的 `npm run smoke:web`（不进测试，本票没跑，请用户自己跑一次）。
  - 变基到 main `164f094d`（64 号票已合入）之后，`vitest run --maxWorkers=1` 全量一次全绿：222 个文件、3260 条；`npm run typecheck`、oxlint 0 报错。ADR 编号用 0026（0025 已被"任务分两个维度"占了）。

- 2026-10-10 评审后的修改（同一分支）：
  - **判断不了的不再一律放开（阻塞）**：评审实测开关关着时"读过路径不明的文件之后发 POST""`cp a "$T/ergou.json"`"都直接执行了。改成牵涉密钥和受保护区域、判断不了的照旧先问（依据标 `keepAsking`，说明里加"牵涉密钥或受保护区域，对话审批关着也照旧先问"）：要写（或看不出读写）的路径没法确定（`judge.ts` 的 `pathRule`：可能落在受保护区域里）；v1 模板"读过 .env 或密钥文件之后不许往外送""对外内容不许含密钥"判断不了（`SECRET_RULE_IDS`）；脚本里写着受保护区域的路径（原来就有）。别的判断不了照开关走：只读的路径没法确定（`cat "$F"`）、删除前缺 git 事实、拆不开的命令里没写着受保护区域的路径。两例都补了测试：守卫切面 `conversation-approvals.test.ts`（还有 `echo x > "$T/…"`、`mv`、`rm -rf "$T"`、同一条命令里先读后发，以及照开关走的反例），主切面 `web-and-approvals.test.ts`（关着时这两样出审批卡、不执行）。秘书的系统提示（关着时）补了一句"看不出写到哪、读过路径不明的文件之后往外发，照旧出审批卡"。
  - **主会话定的写进 ADR 0026**：起草计划算对话（"不属于任务的调用"一刀切）；涉及多个项目的任务的维护者起草和执行时都能联网（`MULTI_PROJECT_TOOLKIT` 同 `PLANNING_TOOLKIT`）；脚本里写着受保护区域路径的，开关关着仍出审批卡。
  - **快速动作不接开关**：秘书推断出的快速动作照旧出卡请用户确认（`quick-actions/judge.ts` 自己调判定函数、不传开关，按"开着"判；那一套没动）——那是确认用户的意图，不是安全审批。主切面 `quick-actions.test.ts` 补了开关关着时推断的动作照样出卡、进待我处理的用例；ADR、规格第 9 节也写了一句。
  - **浏览器路径照 drama 原样**：候选顺序就是 `chromeExecutablePath()` 的（`AGENT_BROWSER_EXECUTABLE_PATH` → agent-browser 自带的签名 Chrome → 系统 Chrome 三处），去掉了 Edge 和去重；二狗的配置 `web.browserPath` 只在用户显式写了时排最前（写空、写示例里的占位符都算没写）。缓存照 drama：一个进程只探一次，没找到也记住、不设环境变量（原来是"没找到下次再找"）；改了配置、装了浏览器要重启，没找到时的说法里写明。上一条里"playwright 自带 chromium 是 drama 的"记错了，已更正（它在用户 web-search skill 的 `resolveExecutable` 里）。
  - **`web_search` 选项和 `search.mjs` 逐个对齐**（用户要求）：`n`、`time`、`engine`（bing / google / ddg：指定了就只用它、不回退，质量门照样过）、`region`（DDG 的 `kl` 原样；Bing 取前半段当 `setlang`；Google 前半段 `hl`、后半段 `gl`，没有后半段用整个）、`tavily`、`json`（结果写成 JSON 数组）。都写进了工具说明，注册表里也登记了这几个参数。Tavily 照 skill（POST `api.tavily.com/search`，key 放请求体 `api_key`，`max_results`=n，`search_depth`=basic，不管 time、region、engine）；key 只从守护进程的环境变量 `TAVILY_API_KEY` 取（`config/secrets.ts` 的 `tavilyKey`，LSM 从数据目录密钥区的文件注入，每次现取；不进 agent 子进程和 bash 的环境），代码、配置、仓库里都没有；没配回"没配 tavily 的 key：请在 LSM 里给二狗加环境变量 TAVILY_API_KEY（从数据目录密钥区的文件注入），或者不用 tavily"。测试里是假的 POST、假的 key。要用的话请在 LSM 的二狗条目里加 `TAVILY_API_KEY`（env.from: file），本票没动 LSM。
  - **`web_fetch` 的直接请求**：加了 20 秒超时（连上和读完正文一起算，超时按网络出错、改用浏览器；调用方中止的照样中止、不改用浏览器）和正文 5 MB 上限（按流读，读到就停、关掉流，正文后注明只读了前面）。上一条"已知缺口"里"不设上限、不设超时"作废。
  - **说法跟上**：用户故事 18（不再"先给我一张审批卡"，写成关着直接做、开着照旧出卡）、用户故事 101 和规格第 11 节"固定工具包"（跨项目任务的维护者三样之外还有联网搜索、读网页）、秘书提示里"现写现跑会被退回"（联网开着时不再退回，改成"分两步更稳"）、`dev.md` 里多项目维护者"什么都不开"。
  - **代码整理**：联网工具和口语总结收进一个装配用的对象 `conversation/session-tools.ts` 的 `SessionTools`（`web`、`voiceReplies`；`conversationTools(sessionTools)`、`sessionVoiceReplies(sessionTools)`），daemon.ts 建一次交给秘书、任务的维护者、项目的维护者、定时作业的维护者、子 agent，不再一样样穿过各模块的选项（`ExecutionSetupDeps` 的 `voiceReplies`、`webTools` 合成 `sessionTools`）。副作用：定时作业的维护者每次运行也有了口语总结（项目里的定时作业原来就有）。`sub-agents.ts` 拉起和重新装配的两处合成一个 `assemble`（候选改名 `candidates`：带类型的 bash 工具和联网工具）。`agent-manager.ts` 改从 `web/index.ts` 取。测试底座里那段孤立的注释挪回 `writeConfig` 头上。
  - **54 号票合进来之后**：两个工具登记成 `nature: "look"`（会话缩小后是只看的浅绿），前端旧记录按名字估的名单（`state/tool-nature.ts`）也加上了。
  - 变基到 main `60ad8782`（54 号票已合入）之后，确认没有别的全量在跑，在 Git Bash 里 `ERGOU_TEST_WORKERS=2` 全量一次全绿：225 个文件、3428 条；`npm run typecheck`、oxlint 0 报错。之后 main 到 `45441054`（66 号票合入），再变基、再跑一次全量：224 个文件通过，`scope-review.test.ts`、`typed-shell/tools.test.ts` 两个文件挂在起不了子进程上（`spawn EPERM`、`fork: Permission denied`，那时另有两个工作区的全量在跑），这两个和同样报了起不来的 `multi-project.test.ts` 单独重跑都通过；类型检查、oxlint 0 报错。
  - 变基到 main `265c2b64`，用进程列表确认没有别的全量在跑之后，在 Git Bash 里 `ERGOU_TEST_WORKERS=2` 全量一次全绿：228 个文件、3452 条。
  - 变基到 main `29f3a3d2`（79 号票）：`agent-manager.ts` 的 `SpawnAgentRequest` 冲突，两边都留（79 的 `vision`，本票改写的 `tools` 说明）。确认没有别的全量在跑之后 `ERGOU_TEST_WORKERS=2` 全量一次全绿：229 个文件、3462 条。跑完 main 又到 `792b8593`（附件等说完再一起发），变基没有冲突，类型检查、oxlint 0 报错，相关的 `voice.test.ts`、`web-and-approvals.test.ts` 和前端的 `composer-outbox`、`detail-content` 测试通过，没再跑全量。package-lock 相对 main 只多 `playwright-core@1.61.0` 一项（`node_modules/playwright-core` 和 daemon 包的依赖），合并后 main 要 `npm install`（不下载浏览器）。

- 2026-10-10 完成：两轴评审的阻塞（密钥、受保护区域相关的"判断不了"照旧先问）已改；web_search 选项和用户的 web-search skill 对齐（engine、region、tavily、json）；全量 3462 条通过。主会话合并到 `98529f2e` 之上无冲突，补跑类型检查。压缩合并进 main，装 playwright-core 1.61.0 后经 LSM 重启。
