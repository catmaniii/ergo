// 二狗共享协议：守护进程和前端共用的帧、频道、事件、消息信封与 part、卡片。
// - constants.ts：名字（频道、事件类型、方法、错误码……），不引用 TypeBox；
// - schema.ts：TypeBox 定义的 schema 和由它生成的类型；
// - message-scope.ts：消息归属（任务、项目、阶段、agent）的取值，不引用 TypeBox；
// - request.ts：守护进程解析、校验收到的请求帧，判断频道名；
// - time.ts：协议里的时间格式（nowIso），守护进程和 Web 共用；
// - validate.ts：按 schema 校验一个值（守护进程校验卡片负载、动作输入、工具参数用）；
// - reminder-schedule.ts：简单提醒的时间规则（schema 和全部按规则种类分支的逻辑），守护进程和 Web 共用；
// - workday-calendar.ts：个人工作日历（节假日数据、额外规则和手动标记 → 某天上班或休息及原因），守护进程和 Web 共用；
// - local-date.ts：本地日期和星期的小工具（YYYY-MM-DD、周几的中文名），时间规则和工作日历共用；
// - inbox.ts：待我处理事项算不算处理过、事项的先后（守护进程、Web 状态层、原型的假连接共用）；
// - http.ts / http-schema.ts：走 HTTP 的部分（媒体上传下载、历史分页；还有设备配对）的路径、常量和请求响应体；
// - parts.ts：拼附件 part 的小工具、文件附件能不能预览；
// - agent-letters.ts：agent 之间的来信（任务做完、负责人来信、秘书转达……）怎么认、一句话总结从哪来，守护进程和 Web 共用；
// - deleted-event.ts：认彻底删除改写后的事件（"已删除"标记）；
// - pairing.ts：设备配对和外网端口的常量、默认设备名，已配对设备多选管理的规则（守护进程和 Web 共用）；
// - app-version.ts：手机 App 的最低版本、版本号怎么比、太旧了去哪升级（守护进程、网页、打包脚本共用）；
// - project-internal.ts：项目内部的标记怎么判断、怎么标注（任务、待我处理事项、定时作业、建议卡共用一个 internal）；
// - tasks.ts / task-schema.ts / plan.ts：任务、计划、看板分组的名字（不引用 TypeBox）、schema、
//   计划的纯函数（授权项列表、卡上生成的文字、停点）；
// - task-transitions.ts："谁能改"表和"现在能对任务做什么"（守护进程和 Web 共用）；
// - activity.ts：agent 的活动状态（加了结构化的说明、说明的文字表和临时的进度事件）；
// - background-agents.ts：负责人背后的 agent（子 agent、评审）的一行、只读的对话、有变化时的临时事件；
// - timeline.ts：时间线上的记录（偏离、范围变更、越界）的 schema 和种类表（中文名、是否要点、严重度）；
// - watch-categories.ts / watch-category-schema.ts：关注类别设置的名字和纯函数（不引用 TypeBox）、schema。
// - projects.ts / project-schema.ts：项目、立项书、项目页上的动作的名字（不引用 TypeBox）和 schema。
// - usage.ts / usage-schema.ts：token 账本的名字和纯函数（合计、粗估成本，不引用 TypeBox）、看板上的合计和消耗页的 schema。
// - token-prices.ts：框架自带的单价表（DeepSeek，取自官网，分高峰、空闲）和高峰时段的判断，官网改价只改这里。
// - parallel-schema.ts：子 agent 并行的并行确认卡。
// - runtime-question-schema.ts：运行时的提问卡（Claude Code 自己要问你的选择题、退出计划模式的批准）。
// - voice.ts / voice-schema.ts：语音消息的限制、识别状态和纯函数（不引用 TypeBox）、语音对象的 schema；
//   agent 发的语音（语音回复）和参考音色。
// - work-orders.ts / work-order-schema.ts：工单和负责人会话分段的名字（不引用 TypeBox）和 schema。
// - scope-records.ts / scope-record-schema.ts：范围记录（范围变更、越界）的名字（不引用 TypeBox）和 schema。
// - toolkit.ts / toolkit-schema.ts：工具包改动的说法和纯函数（不引用 TypeBox）、skill 库和 MCP 登记、改工具包、"工具包变更"卡的 schema。
// - mcp-schema.ts：MCP 登记变更（加、改、删一条登记，用户确认后才写进配置区）的卡和审批决定的 schema。
// - skill-change-schema.ts：skill 变更（负责人把一个 skill 加进库、改、删，用户确认后才写 skill 区）的卡和审批决定的 schema。
// - scheduled-jobs.ts / scheduled-job-schema.ts：定时作业和归档清单的名字、纯函数（不引用 TypeBox）和 schema；
//   job-runs.ts：一次运行的触发怎么说、老的运行补上触发、以前的定时作业的判定（守护进程和 Web 共用这一处）。
// - calendar.ts / calendar-schema.ts：日历（按月看的每一天：工作日判定、当天的提醒和定时作业）的名字、纯函数（不引用 TypeBox）
//   和 schema。
// - assistant-name.ts / assistant-name-schema.ts：个人助理的名字（起名的规则、守护进程生成的话里的名字占位，不引用 TypeBox）
//   和名字事件、配置文件、设置接口的 schema。
// - personal-files.ts / personal-files-schema.ts：个人档案——本人和重要的人各一份；有哪些字段、叫什么、哪些算号码
//   （核对卡上逐位列出）、值合不合规（不引用 TypeBox），档案页的接口和核对卡的 schema。
// - user-name.ts / user-name-schema.ts：我的名字（用户自己的名字）——规矩照个人助理的名字（checkUserName 就是
//   checkAssistantName），配置文件、GET/PUT 设置接口的 schema（不走事件）。
// - workflow.ts / workflow-schema.ts：流程（两种任务之一，固定计划）的名字、纯函数（不引用 TypeBox）
//   和 schema：步骤、条件、审查结果、流程计划卡。
// - system-prompts.ts / system-prompt-schema.ts：各 agent 的系统提示（md 文件）里占位符的写法、检查和填值（不引用 TypeBox），
//   设置里"系统提示"页的接口的 schema。
// - model-settings.ts / model-settings-schema.ts：设置里的"模型"（服务商登记、各个 agent 选模型和思考档位、API key 的状态、看图能力、
//   连通测试，以及自定义 OpenAI 兼容服务商的地址、模型 id 和接口风格）的名字、纯函数（不引用 TypeBox）和设置文件、设置接口的 schema。
// - web-settings.ts / web-settings-schema.ts：设置里 agent 的联网搜索、读网页（是 DeepSeek、浏览器、agent-browser
//   三种方式的队列：能排序、能停用、至少留一个）的名字、实际用哪几种的判定、旧设置的迁移（不引用 TypeBox）和设置文件、设置接口的 schema。
// - event-sources.ts / event-source-schema.ts：事件来源登记表（来源、事件、字段、过滤条件）、文件名模式、在等什么事件的说法、
//   流程步骤参数里 {{事件.字段名}} 占位的认法和代入（不引用 TypeBox），和事件触发方式的 schema。
// - agent-settings.ts / agent-settings-schema.ts：每个 agent 的会话里的 ⚙ 面板——单独的提示词（追加或整份自己写）的名字和检查
//   （不引用 TypeBox）、面板接口的 schema。
// - auto-compact.ts：自动压缩点——设置 · 模型里的默认、每个 agent 的 ⚙ 里单独设的，生效的点怎么算（按模型窗口夹）、范围怎么查。
// - agent-profiles.ts / agent-profiles-schema.ts：每个 agent 自己的名字和音色——来源、"跟默认"是什么、设置页那张表的样子
//   （不引用 TypeBox）和配置文件、接口的 schema。全局的名字和音色是默认，每个 agent 配的是覆盖。
// - operations.ts / operations-schema.ts：运营方案：项目转入使用后怎么运转——每一条的做法、要的能力和项目工具包比、
//   卡上的说法、流程的确认事项（不引用 TypeBox），和方案的一条、项目上生效的运营方案、"运营方案变更"卡的 schema。
// - user-words.ts：运行时核实过的用户原话：一条原话的 schema（原文、会话、时间、设备、经秘书转达）和给人、给模型看的说法。
// - web-version.ts：网页是哪一版——构建时写进 index.html 的版本号怎么写、怎么认（服务端更新了网页，开着的页面提示刷新）。
// - debug-schema.ts：设置里的"关于二狗"和 Debug 工具集从守护进程取的：守护进程的版本和起来的时间、调试用的识别和合成。
// - apps.ts：守护进程转发本机服务的页面——/apps/<应用名>/ 的写法、应用名的规矩、前缀约定的环境变量和请求头。
// - page-commands.ts：网页上下指令——页面桥报的框（选中的框带着框里的内容）、悬浮按钮上说的一段送识别、要交的文件、授权的文件夹（叫这个名字）和列子文件夹。
// - browsing.ts：浏览侧边栏——侧边栏里、悬浮按钮上发的消息带的网页上下文、设备报的浏览器样子、秘书的网页工具转给设备的请求和结果、网页候选卡。
// - project-services.ts：项目的服务——上线到哪了、在不在线、入口的说法和能不能点开（守护进程和 Web 共用）。
// - service-events-schema.ts：项目的服务报事件的请求体；地址、结局的说法在 project-services.ts。
// - project-ops-mcp-schema.ts：项目自动转的 MCP：转发程序问守护进程的请求体和回话（ADR-0045）。
// - i18n/、i18n-schema.ts：多语言——语言文件的形状和检查、运行时的 t()、单复数、回退中文、按语言格式化（不读文件、不引用 TypeBox），
//   全局语言设置的事件、配置文件、设置接口和网页取词典的接口的 schema。
// - plugins.ts、plugins-schema.ts：插件的状况——守护进程清单里每个插件在运行、停用了、没装上，网页按它装、停自己的网页插件（插件频道上的临时事件）；
//   设置 · 插件的清单、停用 / 启用 / 移除的请求体和结果、连数据删的记录。
// - runtimes.ts：agent 运行时——负责人用的运行时（pi 或者插件登记的）、能力清单、可选模型和设置项、能接管的会话，
//   GET /api/runtimes 交给网页的样子；runtime-schema.ts：负责人给运行时选的值、PUT /api/agents/<id>/runtime 的请求体、⚙ 里运行时一块。
// - data-sources.ts、data-sources-schema.ts：数据源——设置 · 数据源一页列出的数据源（连接状态、上次同步和条数、两种用法、
//   敏感类别）、共用的导入文件夹，GET /api/data-sources 的样子和 POST 的请求体、结果。
// - components.ts、components-schema.ts：组件——模型、语音这些大件按需下载：设置 · 组件一页列出的组件（装了没有、大小、版本、
//   默认装不装、下载进度）、功能灰不灰（没装的组件对应的功能），GET /api/components 的样子和 POST 的请求体、离线导入的结果。
// - phone.ts、phone-schema.ts：手机上的二狗 App 读本机——"手机"插件的数据源（通讯录选人、手机日历；加照片的时间地点、位置）、App 交来的样子。
// - backup-schema.ts：备份的状况和"立即备份"——谁来定时、同步目录、最新的快照、最近一次的记录、正在做的，GET /api/backup 的样子。
// - looki.ts：Looki 插件的"存一份到本地"——设置 · 数据源里那一块的数据（存哪几类、已存多少、补存进度）、填设置时交的值。
// - readable-ids.ts：给用户看的编号带上名字，写成仓库里原来的"编号「简短描述」"——"t-3「给记账本加周报」"、"tm-2「记账本的任务负责人」"、删掉了的"t-3（已删除）"。
// - project-standard.ts：项目规范——规范里有哪几份文档、哪几份必须有、检查清单、本项目的规范改写，
//   只读接口 GET /api/projects/<id>/standard 的返回（守护进程和 Web 共用）；还有本项目的规范改写（不要、换写法、多一份、跟新版）
//   怎么合、怎么说，project-standard-schema.ts 是"规范改写"卡的负载；还有现有项目补齐规范文档（缺哪几份、怎么说、两个选择），
//   "补齐规范文档"卡的负载也在 project-standard-schema.ts。
// - memory.ts：记忆的推理库只读看的形状——网页"记忆"页的结论、证据与推理、问题箱的视图、取值表和取多少条的上限。
// - memory-provider.ts：记忆插件接口（v1）——一个记忆系统实现一个 MemoryProvider，宿主同时只用其中一个：
//   上下文、能力清单、条目/素材/查询/删除/体检的形状、几个可选能力（简报、整理、额外工具）和接口版本（MEMORY_API_VERSION）。
// - memory-settings-schema.ts：记忆的设置——秘书顺口问开不开，配置文件和设置接口 GET / PUT /api/memory/settings 的 schema。
// - safety-settings-schema.ts：安全和预算的两个开关——先问我、任务的预算，设置接口 GET / PUT /api/safety-settings 的 schema。
// - folder-grants-schema.ts：目录授权——每个 agent 一份的目录授权表（读、写、删分开，可过期）、设置接口和使用记录的 schema，审批卡上"以后都允许"登记的目录（ADR-0049）。
// - connection-addresses.ts、connection-addresses-schema.ts：连接地址——手机从外面连到二狗用的地址：种类、校验、排序，GET / POST /api/connection-addresses 的样子。
// - autostart.ts、autostart-schema.ts：服务管家的开机自启——向导里的开关，GET / PUT /api/autostart 的样子。
// - ergo-related.ts：服务管家里哪些服务"和二狗有关"（二狗自己、名下的、语音按端口对上的、隧道 / 网关 / 依赖、标了 ergo: true 的），
//   设置 · 服务一页和体检共用的判定。
// - managed-services.ts、managed-services-schema.ts：设置 · 服务（428）——在二狗里看和开关和二狗有关的服务：
//   GET /api/managed-services、POST /api/managed-services/<id>、GET /api/managed-services/<id>/logs 的样子。
// - setup.ts / setup-schema.ts：首次设置向导——网页上要走的五步、每步做完了没有（GET /api/setup 的样子）、
//   标"以后再说"和"看过了"的请求体（POST /api/setup）的 schema。
// - doctor.ts：体检（319b）——设置 · 更多 · 体检一页的八项检查（端口、Node、pi、服务管家、模型的 key、组件、磁盘、外网入口），
//   每项查出来的结构化事实（GET /api/doctor 的样子）；409 加了五种结果、分块（二狗本身 + 每个插件）、动作按钮、汇总的纯函数。
// - doctor-text.ts：体检的话——八项的事实怎么拼成一句、一句话（文案键 + 参数）按当前语言拼，守护进程和网页共用。
// - doctor-schema.ts：体检后台盯着（416）——体检页"恢复提醒"（POST /api/doctor/unmute）的请求体。
// - memory-interview.ts / memory-interview-schema.ts：了解你访谈——五个主题和先后、每月一次的"最近有什么变化"、
//   素材上"来自访谈"的情境标签；约访卡的负载、GET / POST /api/memory/interview 的形状。
// - ingested-materials.ts / ingested-materials-schema.ts：存下的外部信息——秘书按用户的要求存进素材的邮件、网页、日程、Looki 时刻、
//   别的外部文字：有哪几种、上限、建议清理的时间；素材频道上 material_ingested 事件的负载、设置里点开时多给的一块。
// - material-replies.ts / material-replies-schema.ts：素材的"回的是什么"——接着对方的话说的一句挂上前文意思的总结：
//   判的几种结果、总结的上限；素材频道上 material_replies 事件的负载、设置里点开时多给的一块。
//
// 包的 package.json 声明了 sideEffects: false：Web 只用常量和类型，打包时 schema 和 TypeBox 会被摇掉。
//
// 注意：守护进程和 agent 子进程之间的"agent 宿主协议"不在这里，
// 它属于守护进程的运行时封装层（packages/daemon/src/runtime/host-protocol.ts）。
export * from "./constants.ts";
export * from "./schema.ts";
export * from "./message-scope.ts";
export * from "./request.ts";
export * from "./time.ts";
export * from "./validate.ts";
export * from "./reminder-schedule.ts";
export * from "./workday-calendar.ts";
export * from "./local-date.ts";
export * from "./inbox.ts";
export * from "./http.ts";
export * from "./http-schema.ts";
export * from "./parts.ts";
export * from "./agent-letters.ts";
export * from "./deleted-event.ts";
export * from "./pairing.ts";
export * from "./app-version.ts";
export * from "./tasks.ts";
export * from "./project-internal.ts";
export * from "./task-schema.ts";
export * from "./plan.ts";
export * from "./task-transitions.ts";
export * from "./activity.ts";
export * from "./background-agents.ts";
export * from "./timeline.ts";
export * from "./watch-categories.ts";
export * from "./watch-category-schema.ts";
export * from "./projects.ts";
export * from "./user-words.ts";
export * from "./operations.ts";
export * from "./operations-schema.ts";
export * from "./project-schema.ts";
export * from "./usage.ts";
export * from "./usage-schema.ts";
export * from "./token-prices.ts";
export * from "./parallel-schema.ts";
export * from "./runtime-question-schema.ts";
export * from "./voice.ts";
export * from "./voice-schema.ts";
export * from "./work-orders.ts";
export * from "./work-order-schema.ts";
export * from "./scope-records.ts";
export * from "./scope-record-schema.ts";
export * from "./toolkit.ts";
export * from "./toolkit-schema.ts";
export * from "./mcp-schema.ts";
export * from "./skill-change-schema.ts";
export * from "./scheduled-jobs.ts";
export * from "./scheduled-job-schema.ts";
export * from "./job-runs.ts";
export * from "./calendar.ts";
export * from "./calendar-schema.ts";
export * from "./assistant-name.ts";
export * from "./assistant-name-schema.ts";
export * from "./user-name.ts";
export * from "./user-name-schema.ts";
export * from "./personal-files.ts";
export * from "./personal-files-schema.ts";
export * from "./workflow.ts";
export * from "./workflow-schema.ts";
export * from "./system-prompts.ts";
export * from "./system-prompt-schema.ts";
export * from "./model-settings.ts";
export * from "./model-settings-schema.ts";
export * from "./web-settings.ts";
export * from "./web-settings-schema.ts";
export * from "./event-sources.ts";
export * from "./event-source-schema.ts";
export * from "./agent-settings.ts";
export * from "./agent-settings-schema.ts";
export * from "./auto-compact.ts";
export * from "./agent-profiles.ts";
export * from "./agent-profiles-schema.ts";
export * from "./agent-roles.ts";
export * from "./agent-roles-schema.ts";
export * from "./web-version.ts";
export * from "./plugins.ts";
export * from "./plugins-schema.ts";
export * from "./runtimes.ts";
export * from "./runtime-schema.ts";
export * from "./data-sources.ts";
export * from "./data-sources-schema.ts";
export * from "./autostart.ts";
export * from "./autostart-schema.ts";
export * from "./ergo-related.ts";
export * from "./managed-services.ts";
export * from "./managed-services-schema.ts";
export * from "./components.ts";
export * from "./components-schema.ts";
export * from "./phone.ts";
export * from "./phone-schema.ts";
export * from "./looki.ts";
export * from "./debug-schema.ts";
export * from "./backup-schema.ts";
export * from "./apps.ts";
export * from "./page-commands.ts";
export * from "./browsing.ts";
export * from "./project-services.ts";
export * from "./service-events-schema.ts";
export * from "./project-ops-mcp-schema.ts";
export * from "./session-branches.ts";
export * from "./stage-starts.ts";
export * from "./readable-ids.ts";
export * from "./project-standard.ts";
export * from "./project-standard-schema.ts";
export * from "./memory.ts";
export * from "./memory-provider.ts";
export * from "./memory-settings-schema.ts";
export * from "./safety-settings-schema.ts";
export * from "./folder-grants-schema.ts";
export * from "./setup.ts";
export * from "./setup-schema.ts";
export * from "./doctor.ts";
export * from "./doctor-text.ts";
export * from "./doctor-schema.ts";
export * from "./connection-addresses.ts";
export * from "./connection-addresses-schema.ts";
export * from "./memory-interview.ts";
export * from "./memory-interview-schema.ts";
export * from "./ingested-materials.ts";
export * from "./ingested-materials-schema.ts";
export * from "./material-replies.ts";
export * from "./material-replies-schema.ts";
export * from "./i18n/index.ts";
export * from "./i18n-schema.ts";
