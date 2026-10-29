// 前端协议里走 HTTP 的那部分（规格第 5 节）：媒体的分片续传上传、按 sha256 下载、会话历史分页。
// 只有常量和路径，不引用 TypeBox（请求和响应体的 schema 在 http-schema.ts）。
// 路径怎么拼（HTTP_PATHS）、怎么拆（parseHttpPath）、查询参数叫什么（HTTP_QUERY）都只写在这里，
// 守护进程的路由和 Web、测试的请求都从这里取。
//
// 上传是自定义的分片续传协议：
// 1. 建上传：POST /api/uploads，带文件名、类型、字节数；超过单文件上限当场拒绝；
// 2. 按偏移写分片：PUT /api/uploads/<上传 id>?offset=<偏移>，请求体是从这个偏移起的一段原始字节。
//    偏移必须等于服务端已收到的字节数，不等就回 409 和服务端的偏移；连接中途断了，已经收到的字节照样算数；
// 3. 查进度：GET /api/uploads/<上传 id>，断网恢复后从服务端已收到的偏移接着传，不重传已收到的字节；
// 4. 收尾：POST /api/uploads/<上传 id>/complete，带原始上传字节的 sha256。不符就拒绝、不入库。
//    图片入库前剥掉 EXIF，入库版本的 sha256 就是媒体 id（消息里的图片、文件 part 和素材都引用它）。
//
// 下载：GET /api/media/<媒体 id>，支持 Range（206）。
//
// 文本类附件的内容（113 号票，报告页用）：GET /api/media/<媒体 id>/text 回 JSON（MediaTextView，http-schema.ts），
// 不让浏览器直接渲染文件。只按媒体 id 取（内容寻址，不接受路径）；名字和类型以消息里最近一次引用它的文件 part 为准，
// 能预览的（parts.ts 的 textPreviewOf：Markdown、纯文本）才给，别的回 415（unsupported_type）。超过 MEDIA_TEXT_MAX_BYTES
// 的只给开头（truncated）；按严格的 UTF-8 解，解不出来回 422（undecodable），不吐乱码。媒体接口本身的内联规矩不变。
// 117 号票：HTML、SVG 附件也能预览，在隔离的沙箱里看——内容接口对它们只回名字、大小这些和 frame（不给 text），报告页按 frame
// 用下面两个接口在框里显示；超过 MEDIA_FRAME_MAX_BYTES 的不预览（413 too_large），只能下载：
// - GET /api/media/<媒体 id>/html：HTML 原样发出（末尾加一小段让链接在新窗口打开的脚本），带沙箱的 CSP（HTML_PREVIEW_SANDBOX，
//   不给 allow-same-origin：页面是一个"陌生来源"，拿不到二狗的 cookie、本地存储；也不能把整页导航走）、frame-ancestors 'self'；
//   用户 2026-10-13 定页面功能不加限制：脚本可以 eval、能从外网（https:、wss:）取数据、表单能提交到 https:。网关照旧不接受
//   Origin: null 的请求，框里就算连二狗的地址也被拒。报告页用 <iframe sandbox> 指向它；
// - GET /api/media/<媒体 id>/svg：SVG 原样以 image/svg+xml 发出，带 default-src 'none'; style-src 'unsafe-inline'; sandbox，
//   报告页用 <img> 显示（<img> 里的 SVG 不跑脚本）。
// 两个都只按媒体 id 取，名字、类型同样以最近一次引用它的文件 part 为准，part 上不是这种的回 415；媒体接口 /api/media/<id>
// 原来的规矩（只内联认得的图片和音频，别的一律作为附件下载）不变。
//
// 设置里按会话、按时间段删除素材（21 号票）：POST /api/materials/scope 看范围里有几条（和有素材的会话），
// POST /api/materials/delete 对范围内的全部素材执行一种删法（请求体带幂等键，重发只执行一次）。
// 158 号票：POST /api/materials/list 列出范围里的素材（一页，新的在前），GET /api/materials/<素材 id> 看一条的完整内容和来源；
// 在详情里删这一条还是 /api/materials/delete，范围是 { kind: "material", materialId }。
// 165 号票：POST /api/materials/web-page 把"浏览"里开着的一页存进素材（标题、地址、正文；请求体带幂等键，重发只存一次），
// 回这一页的编号和它采成的素材 id。
//
// 记忆的推理库（233 号票，只读，形状见 memory.ts）：GET /api/memory/summary 是概览（各层、各状态各几条、问题箱开着几个、
// 最近一次整理的时间和新增条数）；GET /api/memory/claims?tier=&status=&limit= 是结论列表（一页，最多 MEMORY_CLAIMS_MAX 条）；
// GET /api/memory/claims/<编号> 是一条结论的完整解释（证据链、支持/反对、只当背景的、竞争解释、推理、修订）；
// GET /api/memory/questions?limit= 是问题箱（问什么、为什么问、能区分哪几条、优先级、状态）。
// 四个都只读：推理库还没建、版本对不上、正被每晚整理占着的时候照旧 200，数据是空的、ready 是 false、reason 是一句原因；
// 一条结论没有时（ready 着）回 404。每一页取一次（不缓存：每晚整理完结论会变）。
//
// 设置里的工作日历（29 号票）：GET /api/workday-calendar?month=2026-10 按月看每天上班或休息及原因；
// POST /api/workday-calendar 改个人设置（加删额外规则、把某天标成上班或休息、清掉标记）。改动本身是幂等的
// （同一条规则只有一份、同样的标记再标没有变化），所以不带幂等键；改了之后工作日历频道上推一条 workday_settings 事件。
//
// 主导航的日历（35 号票）：GET /api/calendar?month=2026-10 按月给出每一天的日历条目——上班或休息及原因、当天的简单提醒、
// 当天的定时作业（时间表展开到当天，跑过的带着这一次的结果），连同算的时候任务看板、工作日历两个频道的序号（前端据此知道旧没旧）。
//
// 消耗页（24 号票）：GET /api/usage?from=2026-10-01&to=2026-10-08 选定范围（含两头）按天、按 agent 的 token 汇总，
// 秘书单列为系统开销，成本是用量乘配置里的单价（每次现读配置，粗估）。
//
// 设置里的语音页（32 号票）：参考音色（个人数据，数据目录的 voices 区）。GET /api/reference-voices 列出来（和现在用哪一个）；
// POST /api/reference-voices 导入一个（名字、逐字稿、WAV 的 base64，同样的录音和名字再导一次拿到同一个）；
// POST /api/reference-voices/<id>/select 选它；DELETE /api/reference-voices/<id> 删掉；GET /api/reference-voices/<id>/audio 试听参考录音。
//
// 设置里的个人助理的名字（43 号票）：POST /api/assistant-name 改名（请求体 { name }，按 checkAssistantName 的规则查，
// 不合规回 400）。改动本身是幂等的（同样的名字再改没有变化），所以不带幂等键；改了之后名字频道上推一条 assistant_name 事件。
// 现在的名字从频道上来（前端一打开就订阅），不另设 GET。
//
// 我的名字（249 号票）：用户**自己**的名字（和上面那个"助理的名字"是两回事）。GET /api/user-name 取（{ name? }，没设就没有 name），
// PUT /api/user-name 改（请求体 { name }，null 或者空串 = 清除，按 checkUserName 的规则查，不合规回 400）。不走事件：改动本身幂等，
// 界面打开页面时取一次、改了的那台设备用返回里的那个（别的设备要等它自己再取）。
//
// 个人档案（281 号票，schema 见 personal-files-schema.ts）：GET /api/personal-files 列出（本人那份在最前）、POST 加一个重要的人；
// GET /api/personal-files/<编号> 取一份、POST 改（写字段、记下一件事、撤销一个字段最近一次写入；改了就算用户确认）；
// POST /api/personal-files/<编号>/delete 删（整个人、一个字段、一件事；忘掉或彻底删除，彻底删除可以连出处的原话一起）。
// 不走前端频道，和"我的名字"一样打开页面时取、改完用接口回的那份。283 号票：POST 改的多了 set_reminder（生日、纪念日的每年提醒）；
// GET /api/personal-files/<编号>/learned 取"二狗了解到的"（经记忆插件现取，插件没启用时 ready 是 false、写明原因）。
//
// 多语言（168 号票，请求体和响应体见 i18n-schema.ts）：GET /api/locales 是设置 · 语言要的（选的、实际在用的、有哪些语言、
// ~/.ergo/locales 的真实路径、读语言文件出的问题）；GET /api/locale 是网页的词典（实际在用的语言，合好的，只有网页用到的区域）；
// POST /api/language 换语言（请求体 { language }，只能选列表里有的，不然 400）。改动本身是幂等的，不带幂等键；
// 改了之后语言频道上推一条 language 事件和一条临时事件 locale。
//
// 分段合成（38 号票）：GET /api/agent-voices/<agent 语音 id>/segments/<第几段> 取一段合成好的音频（audio/wav，不缓存）。
// 段的音频是临时的：这条语音合成完了，等下一条语音合成完（或者守护进程重启）就删掉，重播、下载用拼好的完整音频（媒体）。
//
// 设置里的 skill 库页（27、72 号票）：GET /api/toolkit-catalog 列出 skill 库（集合显示成一项）和登记的 MCP；
// POST /api/skills/import 导入一个 skill（可以改名）或把一个目录作为集合整套导入；GET、POST /api/skills/secretary 看、改秘书用的 skill
// （整份名单，改动本身幂等，不带幂等键；改了之后秘书做完手头这一条就按新名单重新装配）。
//
// 输入框里打 / 弹出的候选（82 号票）：GET /api/conversations/<会话>/slash-commands 给出这个会话能用的斜杠命令
// （二狗自己的命令和这个会话能用的 skill，SlashCommandList），每次弹出时现取（工具包随时会变）。
//
// 工具调用的完整参数和返回（53 号票，详情页用）：GET /api/tool-calls/<调用 id> 取 ToolCallDetail（http-schema.ts）。
// 调用 id 就是聊天里工具调用 part 的 callId（按 encodeURIComponent 写进路径，什么字符都行）；没有这次调用的完整内容
// （本票之前的调用、不是经守卫的调用）回 404。消息里的工具调用 part 照旧只带摘要。
// 向后兼容：以后只加可选字段，前端认不得的字段不管、没有的可选字段当作没有。
// 完整内容有保留期和总量上限（65 号票）：过了保留期的、超出总量上限时从最旧的起，只剩摘要（ToolCallDetail.cleared 注明原因），
// 接口照样回 200。设置里：GET /api/tool-call-storage 看占了多大、保留多久、照现在的规则清会清掉多少（ToolCallStorageView）；
// POST /api/tool-call-storage/cleanup 是"现在就清理"：按现在的规则马上清一次（不带请求体，再点一次没有可清的就什么都不做，
// 所以不带幂等键），回清了多少（ToolCallCleanupResult）。
//
// 设置里的"备份"（335 号票，响应体见 backup-schema.ts）：GET /api/backup 看现在的状况（BackupStatusView）；POST /api/backup/run 是
// "立即备份"：守护进程排一次（和它自己到点的那次同一条队列、同一把锁，不叠着跑；已经排着一次就不再排），不等做完，马上回现在的状况
// （queued），页面接着取到做完为止。不带请求体，不带幂等键（重复点只多排不了）。
//
// 设置里的系统提示（71 号票，请求体和响应体见 system-prompt-schema.ts）：GET /api/system-prompts 列出全部；
// GET /api/system-prompts/<编号> 取一份；PUT 保存（{ content }，占位符写错回 400）；DELETE 恢复默认。改动本身是幂等的
// （同样的内容再存一遍、已经是默认的再恢复默认都没有变化），所以不带幂等键。
//
// 设置里的"模型"（73 号票）：GET /api/model-settings 取设置页要的全部（ModelSettingsView：服务商登记表、API key 的状态——
// 只说配没配、从哪来，没有 key 的内容——、可选的模型和各自能不能看图、设置、各个 agent 实际会用的）；POST /api/model-settings
// 整份存（请求体 ModelSettingsBody，回 ModelSettingsView；同样的再存没有变化，所以不带幂等键），改了以后下一个新会话生效；
// POST /api/model-settings/test 是连通测试（请求体 ModelTestBody：测哪个模型，不给是默认模型），回 ModelTestResult
// （通不通、首 token 延迟）。
// 模型的 key（315、319 号票）：GET /api/model-settings/key 只说配没配（ModelKeyView）；POST /api/model-settings/key 是在网页上填一个
// （请求体 ModelKeyBody：{ key }，去掉首尾空白后 8 到 400 个字符，不然 400；响应 ModelKeyWriteResult：effective 是 now / restart）。
// 写进数据目录密钥区的那个文件（权限收紧、先写临时文件再改名），key 原样不回显、不进日志、不进错误信息。
//
// 设置里 agent 的联网搜索、读网页（154 号票；162 号票起是 DeepSeek、浏览器、agent-browser 三种方式的队列）：GET /api/web-settings 取
// （WebSettingsView：存着的队列、实际用的顺序、DeepSeek 的 key 配没配、最近一次余额不足）；POST /api/web-settings 整份存（请求体
// WebSettingsBody，回 WebSettingsView；同样的再存没有变化，不带幂等键；三种不是各一项、一个启用的都没留回 400），下一次搜索、读网页就按新的。
//
// 长程任务的阶段详情（84 号票）：GET /api/tasks/<任务 id>/stages/<阶段 id> 取守护进程那边才有的几样（TaskStageView，http-schema.ts）——
// 这一阶段的授权项各用了几次（守卫计次的口径）、从这里重做会重开哪些阶段、这几个阶段这一轮已经做了的事（效果日志里的，分本机、对外）。
// 每次打开阶段详情、点"从这里重做"时现取，不缓存。
//
// 每个 agent 的会话里的 ⚙（114 号票，请求体和响应体见 agent-settings-schema.ts）：GET /api/agents/<agent id> 取面板要的全部；
// PUT /api/agents/<agent id>/prompt 存这个 agent 单独的提示词（{ mode, content }，占位符写错回 400），DELETE 恢复用通用模板
// （改动本身幂等，不带幂等键）；POST /api/agents/<agent id>/clear 清空当前对话（请求体带幂等键，重发只清一次）；
// POST /api/agents/<agent id>/compact 现在压缩（不带请求体；已经在等、在压时再点没有变化，所以不带幂等键）；
// PUT /api/agents/<agent id>/model 项目、任务的维护者单独配模型（{ modelId, thinkingLevel }，120 号票），DELETE 改回跟随它那一行
// （改动本身幂等，不带幂等键）。都回 AgentSettingsView。
//
// 每个 agent 自己的名字和音色（241 号票，请求体和响应体见 agent-profiles-schema.ts）：GET /api/agent-profiles 列出全部能配的 agent
// （秘书、每个在的项目维护者、每个在的任务维护者……按 agent id 来，不写死名单），带着每个人的名字和音色以及来源（自己配的 / 跟默认）；
// PUT /api/agent-profiles/<agent id> 改一个（{ name?, voiceId? }，null 或是不写这一项 = 恢复跟默认），回同样的 AgentProfilesView。
// 名字不合规、音色不存在回 400 带原因。全局的名字（43）和全局选中的音色（31）还是默认，没配的 agent 跟着它走。
//
// 网页现在是哪一版（116 号票）：GET /api/web-version 回 WebVersionView（http-schema.ts）——守护进程提供的 index.html 里的版本号
// （web-version.ts），没有就不带。页面切回前台时问一次（不等 WebSocket 推），和自己的对不上就提示刷新。由网关自己回（和 /api/access 一样），
// 外网端口上要设备凭证。
//
// Debug 工具集的语音组（124 号票，请求体和响应体见 debug-schema.ts）：POST /api/debug/recognize 把录的一段（base64）交给识别进程，
// 回识别出的文字和耗时；POST /api/debug/speak 用当前参考音色合成念一句，回 WAV（base64）和耗时。都不经会话（不进秘书的上下文），
// 识别不了、合成不了也回 200（ok: false 和原因）。外网端口上和别的接口一样要设备凭证。
//
// 网页上下指令（134 号票，请求体和响应体见 page-commands.ts）：POST /api/page-command 交一次指令（打的字或录的一段语音、页面和框），
// 回要填的字、要交的文件和一句话（页面助手出错、没认出说了什么也是 200，ok: false 和原因）；GET /api/page-files/<取件码> 下载要交的
// 一个文件（取件码几分钟内有效，只认这次指令选中的文件）；GET / PUT /api/local-folders 看、改授权的文件夹（138 号票起叫这个名字），
// PATCH 加几个、拿掉几个，GET /api/local-folders/browse?path=… 列守护进程那台电脑上的子文件夹（设置页选文件夹的框用）。
// 外网端口上和别的接口一样要设备凭证。
//
// 项目规范（258 号票，形状见 project-standard.ts）：GET /api/projects/<项目编号>/standard 只读，回 ProjectStandardView——建档时用的模板版本、
// 规范里每份文档在不在和最近修改时间（必须有的几份标出来，还是模板原样的标出来）、当前状态的检查清单进度、本项目的规范改写。
// 每次现算（档案里的文件随时会改，不缓存）；没有这个项目（删掉了的也是）回 404。
//
// 设置 · 组件（323 号票，形状见 components.ts）：GET /api/components 是清单里的全部组件现在的样子（装了没有、多大、哪个版本、
// 下载进度）；POST /api/components 装上照默认该装的；POST /api/components/<id> 装、更新、删、暂停、继续、取消；
// POST /api/component-import 离线导入这台电脑上的一个文件、文件夹或 .tar / .tgz 包（按清单里的大小和校验值认）。
// 下载在守护进程里做，正在下的时候网页每秒取一次。

/** 单个文件的默认上限（字节）：200 MB，数据目录的配置里可以改（media.maxUploadBytes） */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * 工具调用的完整参数和返回里单个值的上限（UTF-8 字节，53 号票）：返回的文字、参数里的每个字符串各算一个值，
 * 超过的只留开头这么多，末尾注明"已截断"和原长（ToolCallDetail.truncated 里也列出）
 */
export const TOOL_CALL_VALUE_MAX_BYTES = 200 * 1024;

/**
 * 完整内容为什么清掉了（65 号票，ToolCallDetail.cleared.reason）：过了保留期（expired）、超出总量上限时从最旧的清（over_limit）。
 * 清掉的只是完整参数和返回，只剩摘要；工具调用记录、效果记录、时间线照旧
 */
export const TOOL_CALL_CLEAR_REASONS = ["expired", "over_limit"] as const;
export type ToolCallClearReason = (typeof TOOL_CALL_CLEAR_REASONS)[number];

/** 文本类附件的内容最多给多少字节（113 号票）：超过的只给开头这么多（截在字符边上），报告页提示"完整版点下载" */
export const MEDIA_TEXT_MAX_BYTES = 1024 * 1024;

/** HTML、SVG 附件最大多少字节还在沙箱里预览（117 号票，照 113 的上限）：HTML 没法截一半看，超过的只给下载 */
export const MEDIA_FRAME_MAX_BYTES = MEDIA_TEXT_MAX_BYTES;

/**
 * HTML 附件预览的沙箱（117 号票）：报告页 <iframe sandbox> 的值，也是 HTML 接口的 CSP 里 sandbox 指令的值（两边同一份）。
 * 用户 2026-10-13 定"一阶段，不要加什么限制"：页面的功能一律放开——脚本、表单、弹框（alert、confirm）、下载、新窗口（不带沙箱，
 * 打开外链才正常）、全屏指针锁定这些都给；不给的只有让二狗本身安全的：allow-same-origin（页面是陌生来源，拿不到二狗的 cookie、
 * 本地存储）和 allow-top-navigation 那几种（不能把整页导航走，二狗的页面不会被换掉）
 */
export const HTML_PREVIEW_SANDBOX =
  "allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-orientation-lock allow-presentation";

/** 历史分页一页最多多少条消息（也是前端第一次订阅会话频道时补发的最近消息条数） */
export const HISTORY_PAGE_SIZE = 50;

/** 媒体 id：入库版本内容的 sha256，64 位小写十六进制（收尾时带的原始字节 sha256 也是这个格式） */
export const MEDIA_ID_PATTERN = /^[0-9a-f]{64}$/;

export function isMediaId(value: string): boolean {
  return MEDIA_ID_PATTERN.test(value);
}

/** HTTP 接口都在这个前缀下 */
export const HTTP_API_PREFIX = "/api/";

/** 查询参数的名字 */
export const HTTP_QUERY = {
  /** 写分片：这个分片从第几个字节起 */
  offset: "offset",
  /** 下载：文件名 */
  name: "name",
  /** 下载：为 1 时一律作为附件下载（不在页面里打开） */
  download: "download",
  /** 历史分页：只要序号小于它的消息 */
  before: "before",
  /** 历史分页：最多几条 */
  limit: "limit",
  /** 工作日历、日历：哪个月（YYYY-MM） */
  month: "month",
  /** 消耗页：范围从哪天起（YYYY-MM-DD，含） */
  from: "from",
  /** 消耗页：范围到哪天（YYYY-MM-DD，含） */
  to: "to",
  /** 列子文件夹：哪个文件夹（完整路径；不给是常用位置和各个盘，138 号票） */
  path: "path",
  /** 服务首页的缩略图（140 号票）：前端手里这张的截图时间（只为换了新图时换地址，守护进程不看它） */
  at: "at",
  /** 服务首页的缩略图（140 号票）：前端手里那张旧了（超过 6 小时）时带上，每 6 小时换一次，让"有人在看"的请求一定发得出去 */
  seen: "seen",
  /** 回退前的确认（150 号票）：回到这条消息之前 */
  message: "message",
  /** 回退前的确认（150 号票）：回到这条分支开始前；一条分支的样子（151 号票）：哪条分支 */
  branch: "branch",
  /** 回退前的确认（152 号票）：回到长程任务这个阶段开始前（维护者会话里那条 stage_start 记号的 id） */
  stage: "stage",
  /** 一条分支的样子（151 号票）：和哪条分支比（不给是当前分支），给的是它路径上不在那条路径上的一段 */
  against: "against",
  /** 记忆的结论列表（233 号票）：只看哪一层（state、preference、need、value，不给是全部） */
  tier: "tier",
  /** 记忆的结论列表（233 号票）：只看哪种状态（active、contested、retracted、superseded，不给是全部；329 号票起没有 needs_review） */
  status: "status",
} as const;

const UPLOADS = "uploads";
const COMPLETE = "complete";
const MEDIA = "media";
const TEXT = "text";
const HTML = "html";
const SVG = "svg";
const CONVERSATIONS = "conversations";
const MESSAGES = "messages";
const SLASH_COMMANDS = "slash-commands";
const ROLLBACK = "rollback";
const BRANCH = "branch";
const MATERIALS = "materials";
const MEMORY = "memory";
const SUMMARY = "summary";
const CLAIMS = "claims";
const QUESTIONS = "questions";
const STRATEGIES = "strategies";
const SETTINGS = "settings";
const INTERVIEW = "interview";
const SCOPE = "scope";
const DELETE = "delete";
const LIST = "list";
const WEB_PAGE = "web-page";
const WORKDAY_CALENDAR = "workday-calendar";
const CALENDAR = "calendar";
const USAGE = "usage";
const REFERENCE_VOICES = "reference-voices";
const SELECT = "select";
const AUDIO = "audio";
const AGENT_VOICES = "agent-voices";
const SEGMENTS = "segments";
const TOOLKIT_CATALOG = "toolkit-catalog";
const SKILLS = "skills";
const IMPORT = "import";
const SECRETARY = "secretary";
const ASSISTANT_NAME = "assistant-name";
const USER_NAME = "user-name";
const PERSONAL_FILES = "personal-files";
const LEARNED = "learned";
const LOCALES = "locales";
const LOCALE = "locale";
const LANGUAGE = "language";
const TOOL_CALLS = "tool-calls";
const VOICE_MODELS = "voice-models";
const TOOL_CALL_STORAGE = "tool-call-storage";
const CLEANUP = "cleanup";
const BACKUP = "backup";
const RUN = "run";
const SYSTEM_PROMPTS = "system-prompts";
const MODEL_SETTINGS = "model-settings";
const SAFETY_SETTINGS = "safety-settings";
const SETUP = "setup";
const DOCTOR = "doctor";
const WEB_SETTINGS = "web-settings";
const TEST = "test";
const KEY = "key";
const TASKS = "tasks";
const STAGES = "stages";
const AGENTS = "agents";
const AGENT_PROFILES = "agent-profiles";
const AGENT_ROLES = "agent-roles";
const ASSIGNMENTS = "assignments";
const DEFAULT = "default";
const PROMPT = "prompt";
const CLEAR = "clear";
const COMPACT = "compact";
const MODEL = "model";
const RUNTIME = "runtime";
const DEBUG = "debug";
const RECOGNIZE = "recognize";
const SPEAK = "speak";
const PAGE_COMMAND = "page-command";
const PAGE_FILES = "page-files";
const VOICE = "voice";
const PAGE_THUMB = "thumb";
const LOCAL_FOLDERS = "local-folders";
const BROWSE = "browse";
const SERVICE_THUMBNAILS = "service-thumbnails";
const PLUGINS = "plugins";
const RUNTIMES = "runtimes";
const SESSIONS = "sessions";
const TAKE_OVER = "take-over";
const TAKEOVER = "takeover";
const WORK_FOLDER = "work-folder";
const DATA_SOURCES = "data-sources";
const IMPORT_FOLDER = "import-folder";
const PUSH = "push";
const COMPONENTS = "components";
const COMPONENT_IMPORT = "component-import";
const PROJECTS = "projects";
const STANDARD = "standard";

/** 拼查询串（不用 URLSearchParams：前端状态层既没有 DOM 也没有 Node 的类型） */
function query(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
}

const api = (...segments: string[]) => `${HTTP_API_PREFIX}${segments.map(encodeURIComponent).join("/")}`;

/** HTTP 接口的路径 */
export const HTTP_PATHS = {
  /** GET：这个请求被信任吗（本机端口、带着有效凭证的已配对设备、都不是）。两个端口都有，不需要凭证（10） */
  access: `${HTTP_API_PREFIX}access`,
  /**
   * 设备配对，只在外网端口上、不需要凭证（10）：POST 发起（`{ deviceName? }`，不给就按 User-Agent 生成，
   * 同一来源 10 分钟内最多 5 个）；GET 查自己这个请求，已批准就在这次响应里领到设备凭证（Set-Cookie）；
   * PATCH 改设备名（`{ deviceName }`，只在待批时能改）。认哪个请求靠发起时下发的配对 cookie（HttpOnly）
   */
  pairing: `${HTTP_API_PREFIX}pairing`,
  uploads: api(UPLOADS),
  upload: (uploadId: string) => api(UPLOADS, uploadId),
  /** 写分片：从 offset 起 */
  uploadChunk: (uploadId: string, offset: number) => `${api(UPLOADS, uploadId)}${query({ [HTTP_QUERY.offset]: String(offset) })}`,
  uploadComplete: (uploadId: string) => api(UPLOADS, uploadId, COMPLETE),
  /** 下载媒体；name 用作下载时的文件名，download 为真时一律作为附件下载（不在页面里打开） */
  media: (mediaId: string, options: { name?: string | undefined; download?: boolean | undefined } = {}) =>
    `${api(MEDIA, mediaId)}${query({ [HTTP_QUERY.name]: options.name, [HTTP_QUERY.download]: options.download ? "1" : undefined })}`,
  /** 文本类附件的内容（GET，响应 MediaTextView，113 号票）：报告页按媒体 id 取，只回 JSON */
  mediaText: (mediaId: string) => api(MEDIA, mediaId, TEXT),
  /** HTML 附件本身（GET，text/html，带沙箱的 CSP，117 号票）：报告页的 <iframe sandbox> 指向它 */
  mediaHtml: (mediaId: string) => api(MEDIA, mediaId, HTML),
  /** SVG 附件本身（GET，image/svg+xml，带 CSP，117 号票）：报告页的 <img> 指向它 */
  mediaSvg: (mediaId: string) => api(MEDIA, mediaId, SVG),
  /** 某个会话更早的消息：before 是前端手里最早那条消息的序号（不填取最近的一页） */
  /**
   * 回退前的确认要的（GET，响应 RollbackPreview，150 号票）：回到这条消息之前（message）或这条分支开始前（branch）会放弃掉的那一段
   * 已经在真实世界里做了的事
   */
  rollbackPreview: (conversation: string, before: { messageId: string } | { branchId: string } | { stageStart: string }) =>
    `${api(CONVERSATIONS, conversation, ROLLBACK)}${query(
      "messageId" in before ? { [HTTP_QUERY.message]: before.messageId } : "branchId" in before ? { [HTTP_QUERY.branch]: before.branchId } : { [HTTP_QUERY.stage]: before.stageStart },
    )}`,
  /**
   * 一条分支的样子（GET，响应 BranchView，151 号票）：它路径上不在 against（不给是当前分支）路径上的那一段——废弃分支的 ⑂ 预览、
   * 详情（遗留效果连同申请撤回了没有、分支摘要、完整历史）；切换分支之后别的设备取新的当前分支上手里没有的那一段
   */
  branchView: (conversation: string, branchId: string, against?: string) =>
    `${api(CONVERSATIONS, conversation, BRANCH)}${query({ [HTTP_QUERY.branch]: branchId, [HTTP_QUERY.against]: against })}`,
  history: (conversation: string, options: { before?: number | undefined; limit?: number | undefined } = {}) =>
    `${api(CONVERSATIONS, conversation, MESSAGES)}${query({ [HTTP_QUERY.before]: options.before?.toString(), [HTTP_QUERY.limit]: options.limit?.toString() })}`,
  /** 这个会话能用的斜杠命令：二狗自己的命令和 skill（GET，响应 SlashCommandList，82 号票） */
  slashCommands: (conversation: string) => api(CONVERSATIONS, conversation, SLASH_COMMANDS),
  /** 素材范围里有几条（POST，请求体 MaterialScopeBody） */
  materialsScope: api(MATERIALS, SCOPE),
  /** 对范围内的全部素材执行一种删法（POST，请求体 DeleteMaterialsBody） */
  materialsDelete: api(MATERIALS, DELETE),
  /** 范围里的素材，一页（POST，请求体 MaterialListBody，响应 MaterialListPage，158 号票） */
  materialsList: api(MATERIALS, LIST),
  /** 存一页网页进素材（POST，请求体 SaveWebPageBody，响应 SaveWebPageResult，165 号票："浏览"的 ⋮ 菜单里"存进二狗的素材"） */
  materialsWebPage: api(MATERIALS, WEB_PAGE),
  /** 一条素材的完整内容和来源（GET，响应 MaterialDetailView，158 号票）；没有这条（删了）是 404 */
  material: (materialId: string) => api(MATERIALS, materialId),
  /** 记忆的推理库概览（GET，响应 MemorySummaryView，233 号票）：各层、各状态、问题箱、最近一次整理；只读 */
  memorySummary: api(MEMORY, SUMMARY),
  /** 结论列表（GET，响应 MemoryClaimListPage，233 号票）：tier、status、limit（默认 MEMORY_CLAIMS_DEFAULT，最多 MEMORY_CLAIMS_MAX） */
  memoryClaims: (q: { tier?: string | undefined; status?: string | undefined; limit?: number | undefined } = {}) =>
    `${api(MEMORY, CLAIMS)}${query({ [HTTP_QUERY.tier]: q.tier, [HTTP_QUERY.status]: q.status, [HTTP_QUERY.limit]: q.limit?.toString() })}`,
  /** 一条结论的完整解释（GET，响应 MemoryClaimDetailView，233 号票）：证据链、支持/反对、竞争解释、修订；没有这条是 404 */
  memoryClaim: (claimId: string) => api(MEMORY, CLAIMS, claimId),
  /** 问题箱（GET，响应 MemoryQuestionsView，233 号票）：limit 默认 MEMORY_QUESTIONS_DEFAULT，最多 MEMORY_QUESTIONS_MAX */
  memoryQuestions: (q: { limit?: number | undefined } = {}) => `${api(MEMORY, QUESTIONS)}${query({ [HTTP_QUERY.limit]: q.limit?.toString() })}`,
  /** 330 号票：做法（交互策略）列表 */
  memoryStrategies: () => api(MEMORY, STRATEGIES),
  /** 记忆的设置（264 号票）：GET 取（MemorySettingsView），PUT 整份存（MemorySettingsBody → MemorySettingsView）；现在只有"顺口问开不开" */
  memorySettings: api(MEMORY, SETTINGS),
  /**
   * 了解你访谈（284 号票）：GET 取现在的样子（InterviewStatusView：开着的那次、聊过哪几个主题、下次聊什么、约访开没开）；
   * POST 开一次（请求体 InterviewStartBody，响应 InterviewStartResult：记忆页的"找管理员聊聊"；已经开着就是那一次）。记忆插件没启用时 404
   */
  memoryInterview: api(MEMORY, INTERVIEW),
  /** 工作日历：改个人设置（POST，请求体 WorkdayChangeBody，响应 WorkdayChangeResult） */
  workdayCalendar: api(WORKDAY_CALENDAR),
  /** 工作日历：某个月（YYYY-MM）每天上班或休息及原因（GET，响应 WorkdayMonthView） */
  workdayMonth: (month: string) => `${api(WORKDAY_CALENDAR)}${query({ [HTTP_QUERY.month]: month })}`,
  /** 日历：某个月（YYYY-MM）每一天的日历条目（GET，响应 CalendarMonthView，35 号票） */
  calendarMonth: (month: string) => `${api(CALENDAR)}${query({ [HTTP_QUERY.month]: month })}`,
  /** 消耗页：from 到 to（YYYY-MM-DD，含两头）的用量汇总和粗估成本（GET，响应 UsageSummary，24 号票） */
  usage: (range: { from: string; to: string }) => `${api(USAGE)}${query({ [HTTP_QUERY.from]: range.from, [HTTP_QUERY.to]: range.to })}`,
  /** 参考音色：GET 列出（ReferenceVoiceList），POST 导入一个（ImportReferenceVoiceBody → ReferenceVoice）（32 号票） */
  referenceVoices: api(REFERENCE_VOICES),
  /** 一个参考音色：DELETE 删掉（响应 ReferenceVoiceList） */
  referenceVoice: (voiceId: string) => api(REFERENCE_VOICES, voiceId),
  /** 选这个参考音色作为语音回复用的（POST，响应 ReferenceVoiceList） */
  referenceVoiceSelect: (voiceId: string) => api(REFERENCE_VOICES, voiceId, SELECT),
  /** 试听：参考录音本身（GET，audio/wav） */
  referenceVoiceAudio: (voiceId: string) => api(REFERENCE_VOICES, voiceId, AUDIO),
  /** 分段合成里合成好的一段音频（GET，audio/wav，38 号票）：index 是第几段（0 起） */
  agentVoiceSegment: (voiceId: string, index: number) => api(AGENT_VOICES, voiceId, SEGMENTS, String(index)),
  /** 工具包里能选的东西：skill 库和登记的 MCP（GET，响应 ToolkitCatalog，27 号票） */
  toolkitCatalog: api(TOOLKIT_CATALOG),
  /** 设置里的 skill 库页导入一个 skill 或一个集合（POST，请求体 ImportSkillBody，响应 ImportSkillResult，27、72 号票） */
  skillImport: api(SKILLS, IMPORT),
  /** 秘书用的 skill：GET 看（SecretarySkillsView），POST 改（请求体 SecretarySkillsBody，响应 SecretarySkillsView），72 号票 */
  secretarySkills: api(SKILLS, SECRETARY),
  /** 改个人助理的名字（POST，请求体 AssistantNameBody，响应 AssistantNameResult，43 号票） */
  assistantName: api(ASSISTANT_NAME),
  /**
   * 我的名字（用户自己的名字，249 号票）：GET 取（响应 UserNameView，没设就没有 name）、PUT 改（请求体 UserNameBody，
   * null 或者空串 = 清除；响应 UserNameResult）
   */
  userName: api(USER_NAME),
  /** 个人档案（281 号票）：GET 列出（PersonalFilesView）、POST 加一个重要的人（请求体 AddPersonBody，响应 PersonalFileView） */
  personalFiles: api(PERSONAL_FILES),
  /** 一份档案：GET 取（PersonalFileView）、POST 改（请求体 PersonalFileChangeBody，响应 PersonalFileView）；没有这份是 404 */
  personalFile: (personId: string) => api(PERSONAL_FILES, personId),
  /** 删档案里的东西（POST，请求体 PersonalFileDeleteBody，响应 PersonalFileDeleteResult） */
  personalFileDelete: (personId: string) => api(PERSONAL_FILES, personId, DELETE),
  /** "二狗了解到的"（GET，响应 PersonalFileLearnedView，283 号票）：经记忆插件现取 */
  personalFileLearned: (personId: string) => api(PERSONAL_FILES, personId, LEARNED),
  /** 设置 · 语言：选的、实际在用的、有哪些语言、读语言文件出的问题（GET，响应 LocaleListView，168 号票） */
  locales: api(LOCALES),
  /** 网页的词典：实际在用的语言（自带 + ~/.ergo/locales 里的，合好的），不是中文时连同中文的（GET，响应 LocaleDictionaryView，168 号票） */
  locale: api(LOCALE),
  /** 换语言（POST，请求体 LanguageBody，响应 LanguageResult，168 号票） */
  language: api(LANGUAGE),
  /** 一次工具调用的完整参数和返回（GET，响应 ToolCallDetail，53 号票）：callId 是工具调用 part 的 callId */
  toolCall: (callId: string) => api(TOOL_CALLS, callId),
  /** 设置里：工具调用的完整内容占了多大、保留多久、照现在的规则清会清掉多少（GET，响应 ToolCallStorageView，65 号票） */
  toolCallStorage: api(TOOL_CALL_STORAGE),
  /** 设置里的"现在就清理"：按现在的规则马上清一次（POST，不带请求体，响应 ToolCallCleanupResult，65 号票） */
  toolCallStorageCleanup: api(TOOL_CALL_STORAGE, CLEANUP),
  /** 设置里的"备份"：现在的状况（GET，响应 BackupStatusView，335 号票） */
  backup: api(BACKUP),
  /** "立即备份"：守护进程排一次，马上回现在的状况（POST，不带请求体，响应 BackupStatusView，335 号票） */
  backupRun: api(BACKUP, RUN),
  /** 语音识别模型、合成模型现在的状态和识别引擎的清单（GET，响应 VoiceModelsView，45 号票）；变了另经活动状态频道推 voice_models */
  voiceModels: api(VOICE_MODELS),
  /** 设置里的系统提示：全部（GET，响应 SystemPromptList，71 号票） */
  systemPrompts: api(SYSTEM_PROMPTS),
  /** 一份系统提示：GET 取（SystemPromptDetail）、PUT 保存（请求体 SystemPromptBody）、DELETE 恢复默认，响应都是 SystemPromptDetail */
  systemPrompt: (id: string) => api(SYSTEM_PROMPTS, id),
  /** 设置里的"模型"：GET 取（ModelSettingsView），POST 整份存（ModelSettingsBody → ModelSettingsView，73 号票） */
  modelSettings: api(MODEL_SETTINGS),
  /** 设置里的"模型"的连通测试（POST，请求体 ModelTestBody，响应 ModelTestResult，73 号票） */
  modelSettingsTest: api(MODEL_SETTINGS, TEST),
  /**
   * 模型的 key（315、319 号票）：GET 只说配没配（ModelKeyView，不查模型目录、马上回，会话页上"还没配模型"的提示用）；
   * POST 是在网页上填一个（请求体 ModelKeyBody：{ key }，响应 ModelKeyWriteResult 写明什么时候生效；回的、日志里都没有 key 的内容）
   */
  modelSettingsKey: api(MODEL_SETTINGS, KEY),
  /**
   * 安全和预算的两个开关（315 号票）：GET 取（SafetySettingsView），PUT 改哪项给哪项（SafetySettingsBody → SafetySettingsView）；
   * 写进配置文件，改了马上生效。设置 · 关注类别那一页、319 号票的设置向导用
   */
  safetySettings: api(SAFETY_SETTINGS),
  /**
   * 首次设置向导（319 号票）：GET 取五步各自做完了没有（SetupView），POST 标一步"以后再说"（skip: true）
   * 或者"看过了/做完了"（SetupMarkBody → SetupView）。真相是配置文件的 setup 节，改了马上生效
   */
  setup: api(SETUP),
  /**
   * 体检（319 号票的 319b）：GET /api/doctor 取八项检查现在的样子（DoctorView：端口、Node、pi、服务管家、模型的 key、组件、磁盘、外网入口）。
   * 每次现算，只查本机（除探本机端口外不联网、不调用模型、不改状态）
   */
  doctor: api(DOCTOR),
  /** 设置里 agent 的联网搜索、读网页走哪条路：GET 取（WebSettingsView），POST 整份存（WebSettingsBody → WebSettingsView，154 号票；162 号票起是队列） */
  webSettings: api(WEB_SETTINGS),
  /** GET：设置 · 插件，清单里的全部插件（PluginsView，211 号票） */
  plugins: api(PLUGINS),
  /** POST：对一个插件停用、启用（装回）、移除（PluginActionBody → PluginActionResult，211 号票） */
  plugin: (name: string) => api(PLUGINS, name),
  /** GET：登记了的 agent 运行时（pi 和插件登记的）连同能力清单、可选模型和设置项、能不能用（RuntimesView，286 号票） */
  runtimes: api(RUNTIMES),
  /** GET：这个运行时在本机能接管的会话（RuntimeSessionsView，290 号票）：标题、工作目录、分支、最近活动、大小，被占着的写明在哪 */
  runtimeSessions: (runtimeId: string) => api(RUNTIMES, runtimeId, SESSIONS),
  /** POST：从选中的会话接管成任务或项目（TakeOverBody → TakeOverResult，290 号票）：被占着的不分叉就回 409 */
  runtimeTakeOver: (runtimeId: string) => api(RUNTIMES, runtimeId, TAKE_OVER),
  /**
   * PUT：能选工作文件夹的运行时新建时的默认文件夹（RuntimeFolderBody → RuntimesView，305 号票）：null 是不设（照旧用二狗给任务开的工作目录）；
   * 不存在、是文件、在数据目录或二狗程序目录里的回 400。POST：只核对一个已有的文件夹（RuntimeFolderBody → WorkFolderCheckResult，
   * 新建对话框交之前看一眼），不对的回 400
   */
  runtimeFolder: (runtimeId: string) => api(RUNTIMES, runtimeId, WORK_FOLDER),
  /** GET：设置 · 数据源，全部数据源和导入文件夹（DataSourcesView，295 号票） */
  dataSources: api(DATA_SOURCES),
  /** POST：对一个数据源立即同步、断开、开关一种用法、填设置（DataSourceActionBody → DataSourceActionResult，295 号票） */
  dataSource: (id: string) => api(DATA_SOURCES, id),
  /** POST：设备交来的（手机上的二狗 App 读本机的通讯录、日历；DataSourcePushBody → DataSourcePushResult，299 号票） */
  dataSourcePush: (id: string) => api(DATA_SOURCES, id, PUSH),
  /** POST：导入文件夹现在看一遍、在电脑上打开（ImportFolderActionBody → ImportFolderActionResult，295 号票） */
  importFolder: api(IMPORT_FOLDER),
  /** GET：设置 · 组件，清单里的全部组件现在的样子（ComponentsView，323 号票）；POST：装上照默认该装的（ComponentsActionBody → ComponentsView） */
  components: api(COMPONENTS),
  /** POST：对一个组件装、更新、删、暂停、继续、取消（ComponentActionBody → ComponentsView，323 号票） */
  component: (id: string) => api(COMPONENTS, id),
  /** POST：离线导入自己下好的文件（ComponentImportBody → ComponentImportResult，323 号票） */
  componentImport: api(COMPONENT_IMPORT),
  /** 长程任务一个阶段的授权已用次数、从这里重做的范围和已经做了的事（GET，响应 TaskStageView，84 号票） */
  taskStage: (taskId: string, stageId: string) => api(TASKS, taskId, STAGES, stageId),
  /** 一个 agent 的 ⚙ 面板（GET，响应 AgentSettingsView，114 号票）：agent id 是秘书的 secretary、维护者的 tm-<n> / pm-<n> */
  agentSettings: (agentId: string) => api(AGENTS, agentId),
  /** 这个 agent 单独的提示词：PUT 存（请求体 AgentPromptBody）、DELETE 恢复用通用模板，响应都是 AgentSettingsView */
  agentPrompt: (agentId: string) => api(AGENTS, agentId, PROMPT),
  /** 清空当前对话（POST，请求体 AgentClearBody，响应 AgentSettingsView） */
  agentClear: (agentId: string) => api(AGENTS, agentId, CLEAR),
  /** 现在压缩（POST，不带请求体，响应 AgentSettingsView） */
  agentCompact: (agentId: string) => api(AGENTS, agentId, COMPACT),
  /** 项目、任务的维护者单独配模型（120 号票）：PUT 选定（请求体 AgentModelBody）、DELETE 改回跟随它那一行，响应都是 AgentSettingsView */
  agentModel: (agentId: string) => api(AGENTS, agentId, MODEL),
  /**
   * 项目、任务的维护者用哪个运行时、给它选的模型和设置项（289 号票）：PUT（请求体 AgentRuntimeBody，响应 AgentSettingsView）。
   * 换了运行时的：手头这一条做完，原来的写交接摘要、新的新开会话；只改模型、设置项的从下一轮起
   */
  agentRuntime: (agentId: string) => api(AGENTS, agentId, RUNTIME),
  /**
   * 接管来的会话交还给运行时 / 收回到二狗（290 号票）、交给官方 App（292 号票，Remote Control）：POST（请求体 TakeoverActionBody，
   * 响应 AgentSettingsView）。交给官方 App 等二狗的进程退干净、后台会话开起来、拿到链接才回
   */
  agentTakeover: (agentId: string) => api(AGENTS, agentId, TAKEOVER),
  /**
   * 角色（248 号票）：GET 默认角色、角色表（连同谁在用）、每个 agent 现在用哪个角色、参考音色（响应 AgentRolesView），
   * POST 新建一个角色（请求体 AgentRoleBody）。替代 241 号票"每个 agent 各管各的名字和音色"。
   */
  agentRoles: api(AGENT_ROLES),
  /** 改（PUT，请求体 AgentRoleUpdateBody）/ 删（DELETE）一个角色；删的是默认角色、还有 agent 在用的回 400 写明是谁；响应 AgentRolesView */
  agentRole: (roleId: string) => api(AGENT_ROLES, roleId),
  /** 把某个角色设成默认（PUT，请求体 AgentDefaultRoleBody，响应 AgentRolesView）：全局名字和音色跟着变成那个角色的 */
  agentDefaultRole: api(AGENT_ROLES, DEFAULT),
  /** 给一个 agent 选角色（PUT，请求体 AgentRoleAssignmentBody，null = 跟默认角色，响应 AgentRolesView） */
  agentRoleAssignment: (agentId: string) => api(AGENT_ROLES, ASSIGNMENTS, agentId),
  /**
   * 每个 agent 自己的名字和音色（241 号票）：**248 号票起只保留 GET 兼容**，返回从角色算出来的结果（AgentProfilesView）；
   * PUT 已经没有了（回 400，指向 /api/agent-roles/assignments/<agent id>）
   */
  agentProfiles: api(AGENT_PROFILES),
  /**
   * （248 号票起不再有）改一个 agent 的名字和音色：留着路径只为把旧的调用引到新接口，PUT/DELETE 都回 400
   */
  agentProfile: (agentId: string) => api(AGENT_PROFILES, agentId),
  /** 守护进程现在提供的网页是哪一版（GET，响应 WebVersionView，116 号票）：页面切回前台时问一次 */
  webVersion: `${HTTP_API_PREFIX}web-version`,
  /** Debug 工具集：录的一段送识别（POST，请求体 DebugRecognizeBody，响应 DebugRecognizeResult，124 号票）；不经会话 */
  debugRecognize: api(DEBUG, RECOGNIZE),
  /** Debug 工具集：用当前参考音色合成念一句（POST，请求体 DebugSpeakBody，响应 DebugSpeakResult，124 号票）；不经会话 */
  debugSpeak: api(DEBUG, SPEAK),
  /**
   * 悬浮按钮上按住说的一段送识别（POST，请求体 PageVoiceBody，响应 PageVoiceResult，149 号票）：认出来的字再作为一条消息发进秘书的主会话
   * （134 号票原来的 POST /api/page-command 一次性页面助手、145 号票的 POST /api/page-command/pick 不再有）
   */
  pageVoice: api(PAGE_COMMAND, VOICE),
  /** 要交进上传框的一个文件（GET，凭取件码，134 号票） */
  pageFile: (token: string) => api(PAGE_FILES, token),
  /**
   * 要交进上传框的一个文件的缩略图（GET，凭取件码，149 号票）：守护进程做的小图（长边 PAGE_THUMB_EDGE 左右），网页上的挑图片窗口、
   * 会话里的候选卡显示它，不下原图；不是图片、做不出来的 404
   */
  pageFileThumb: (token: string) => api(PAGE_FILES, token, PAGE_THUMB),
  /**
   * 授权的文件夹（134 号票，138 号票起叫这个名字）：GET 看（LocalFoldersView），PUT 整份换（LocalFoldersBody → LocalFoldersView），
   * PATCH 加几个、拿掉几个（LocalFoldersChangeBody → LocalFoldersView，138 号票）
   */
  localFolders: api(LOCAL_FOLDERS),
  /** 列守护进程那台电脑上的子文件夹（GET，响应 FolderBrowseView，138 号票）：不给路径是常用位置和各个盘 */
  localFoldersBrowse: (folder?: string) => `${api(LOCAL_FOLDERS, BROWSE)}${query({ [HTTP_QUERY.path]: folder })}`,
  /**
   * 项目的一个服务首页的缩略图（GET，image/jpeg，140 号票）：按项目编号和服务名取；还没截过是 404。at 是前端手里这张的截图时间
   * （换了新图换地址），seen 见 HTTP_QUERY.seen。守护进程收到这个请求就当"有人在看"：那张旧了（6 小时）、还没有的补截一张
   */
  serviceThumbnail: (projectId: string, name: string, q: { at?: string | undefined; seen?: string | undefined } = {}) =>
    `${api(SERVICE_THUMBNAILS, projectId, name)}${query({ [HTTP_QUERY.at]: q.at, [HTTP_QUERY.seen]: q.seen })}`,
  /** 一个项目的规范（GET，响应 ProjectStandardView，258 号票）：模板版本、每份文档在不在、检查清单进度、规范改写；只读，每次现算 */
  projectStandard: (projectId: string) => api(PROJECTS, projectId, STANDARD),
} as const;

/** 拆出来的 HTTP 接口路径（和 HTTP_PATHS 一一对应） */
export type HttpRoute =
  | { route: "uploads" }
  | { route: "upload"; uploadId: string }
  | { route: "upload_complete"; uploadId: string }
  | { route: "media"; mediaId: string }
  | { route: "media_text"; mediaId: string }
  | { route: "media_html"; mediaId: string }
  | { route: "media_svg"; mediaId: string }
  | { route: "history"; conversation: string }
  | { route: "rollback_preview"; conversation: string }
  | { route: "branch_view"; conversation: string }
  | { route: "slash_commands"; conversation: string }
  | { route: "materials_scope" }
  | { route: "materials_delete" }
  | { route: "materials_list" }
  | { route: "materials_web_page" }
  | { route: "material"; materialId: string }
  | { route: "memory_summary" }
  | { route: "memory_claims" }
  | { route: "memory_claim"; claimId: string }
  | { route: "memory_questions" }
  | { route: "memory_strategies" }
  | { route: "memory_settings" }
  | { route: "memory_interview" }
  | { route: "workday_calendar" }
  | { route: "calendar" }
  | { route: "usage" }
  | { route: "reference_voices" }
  | { route: "reference_voice"; voiceId: string }
  | { route: "reference_voice_select"; voiceId: string }
  | { route: "reference_voice_audio"; voiceId: string }
  | { route: "agent_voice_segment"; voiceId: string; index: number }
  | { route: "toolkit_catalog" }
  | { route: "skill_import" }
  | { route: "secretary_skills" }
  | { route: "assistant_name" }
  | { route: "user_name" }
  | { route: "personal_files" }
  | { route: "personal_file"; personId: string }
  | { route: "personal_file_delete"; personId: string }
  | { route: "personal_file_learned"; personId: string }
  | { route: "locales" }
  | { route: "locale" }
  | { route: "language" }
  | { route: "tool_call"; callId: string }
  | { route: "tool_call_storage" }
  | { route: "tool_call_storage_cleanup" }
  | { route: "backup" }
  | { route: "backup_run" }
  | { route: "voice_models" }
  | { route: "system_prompts" }
  | { route: "system_prompt"; id: string }
  | { route: "model_settings" }
  | { route: "model_settings_test" }
  | { route: "model_settings_key" }
  | { route: "safety_settings" }
  | { route: "setup" }
  | { route: "doctor" }
  | { route: "web_settings" }
  | { route: "plugins" }
  | { route: "plugin"; name: string }
  | { route: "runtimes" }
  | { route: "runtime_sessions"; runtimeId: string }
  | { route: "runtime_take_over"; runtimeId: string }
  | { route: "runtime_folder"; runtimeId: string }
  | { route: "data_sources" }
  | { route: "data_source"; id: string }
  | { route: "data_source_push"; id: string }
  | { route: "import_folder" }
  | { route: "components" }
  | { route: "component"; id: string }
  | { route: "component_import" }
  | { route: "task_stage"; taskId: string; stageId: string }
  | { route: "agent_settings"; agentId: string }
  | { route: "agent_prompt"; agentId: string }
  | { route: "agent_clear"; agentId: string }
  | { route: "agent_compact"; agentId: string }
  | { route: "agent_model"; agentId: string }
  | { route: "agent_runtime"; agentId: string }
  | { route: "agent_takeover"; agentId: string }
  | { route: "agent_profiles" }
  | { route: "agent_profile"; agentId: string }
  | { route: "agent_roles" }
  | { route: "agent_role"; roleId: string }
  | { route: "agent_default_role" }
  | { route: "agent_role_assignment"; agentId: string }
  | { route: "debug_recognize" }
  | { route: "debug_speak" }
  | { route: "page_voice" }
  | { route: "page_file"; token: string }
  | { route: "page_file_thumb"; token: string }
  | { route: "local_folders" }
  | { route: "local_folders_browse" }
  | { route: "service_thumbnail"; projectId: string; name: string }
  | { route: "project_standard"; projectId: string };

/** 把请求的路径（不含查询串）拆成接口和参数；不是 HTTP 接口的路径返回 undefined */
export function parseHttpPath(pathname: string): HttpRoute | undefined {
  if (!pathname.startsWith(HTTP_API_PREFIX)) return undefined;
  let segments: string[];
  try {
    segments = pathname.slice(HTTP_API_PREFIX.length).split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [head, id, tail, item, ...rest] = segments;
  if (rest.length > 0 || segments.some((s) => s === "")) return undefined;
  // 四截的：分段合成的一段、长程任务的一个阶段（84 号票）
  if (item !== undefined) {
    if (head === AGENT_VOICES && id !== undefined && tail === SEGMENTS && /^\d{1,4}$/.test(item)) return { route: "agent_voice_segment", voiceId: id, index: Number(item) };
    if (head === TASKS && id !== undefined && tail === STAGES) return { route: "task_stage", taskId: id, stageId: item };
    return undefined;
  }
  if (head === UPLOADS) {
    if (id === undefined) return { route: "uploads" };
    if (tail === undefined) return { route: "upload", uploadId: id };
    if (tail === COMPLETE) return { route: "upload_complete", uploadId: id };
  }
  if (head === MEDIA && id !== undefined && tail === undefined) return { route: "media", mediaId: id };
  if (head === MEDIA && id !== undefined && tail === TEXT) return { route: "media_text", mediaId: id };
  if (head === MEDIA && id !== undefined && tail === HTML) return { route: "media_html", mediaId: id };
  if (head === MEDIA && id !== undefined && tail === SVG) return { route: "media_svg", mediaId: id };
  if (head === CONVERSATIONS && id !== undefined && tail === MESSAGES) return { route: "history", conversation: id };
  if (head === CONVERSATIONS && id !== undefined && tail === ROLLBACK) return { route: "rollback_preview", conversation: id };
  if (head === CONVERSATIONS && id !== undefined && tail === BRANCH) return { route: "branch_view", conversation: id };
  if (head === CONVERSATIONS && id !== undefined && tail === SLASH_COMMANDS) return { route: "slash_commands", conversation: id };
  if (head === MATERIALS && tail === undefined && id === SCOPE) return { route: "materials_scope" };
  if (head === MATERIALS && tail === undefined && id === DELETE) return { route: "materials_delete" };
  if (head === MATERIALS && tail === undefined && id === LIST) return { route: "materials_list" };
  if (head === MATERIALS && tail === undefined && id === WEB_PAGE) return { route: "materials_web_page" };
  if (head === MATERIALS && tail === undefined && id !== undefined) return { route: "material", materialId: id };
  // 记忆的推理库（233 号票）：概览、结论列表、一条结论、问题箱；结论的编号放在下面一段。记忆的设置（264 号票）
  if (head === MEMORY) {
    if (id === SUMMARY && tail === undefined) return { route: "memory_summary" };
    if (id === CLAIMS) return tail === undefined ? { route: "memory_claims" } : { route: "memory_claim", claimId: tail };
    if (id === QUESTIONS && tail === undefined) return { route: "memory_questions" };
    if (id === STRATEGIES && tail === undefined) return { route: "memory_strategies" };
    if (id === SETTINGS && tail === undefined) return { route: "memory_settings" };
    if (id === INTERVIEW && tail === undefined) return { route: "memory_interview" };
  }
  if (head === WORKDAY_CALENDAR && id === undefined) return { route: "workday_calendar" };
  if (head === CALENDAR && id === undefined) return { route: "calendar" };
  if (head === USAGE && id === undefined) return { route: "usage" };
  if (head === REFERENCE_VOICES) {
    if (id === undefined) return { route: "reference_voices" };
    if (tail === undefined) return { route: "reference_voice", voiceId: id };
    if (tail === SELECT) return { route: "reference_voice_select", voiceId: id };
    if (tail === AUDIO) return { route: "reference_voice_audio", voiceId: id };
  }
  if (head === TOOLKIT_CATALOG && id === undefined) return { route: "toolkit_catalog" };
  if (head === SKILLS && id === IMPORT && tail === undefined) return { route: "skill_import" };
  if (head === SKILLS && id === SECRETARY && tail === undefined) return { route: "secretary_skills" };
  if (head === ASSISTANT_NAME && id === undefined) return { route: "assistant_name" };
  if (head === USER_NAME && id === undefined) return { route: "user_name" };
  // 个人档案（281 号票）：列表、一份、删
  if (head === PERSONAL_FILES) {
    if (id === undefined) return { route: "personal_files" };
    if (tail === undefined) return { route: "personal_file", personId: id };
    if (tail === DELETE) return { route: "personal_file_delete", personId: id };
    if (tail === LEARNED) return { route: "personal_file_learned", personId: id };
  }
  if (head === LOCALES && id === undefined) return { route: "locales" };
  if (head === LOCALE && id === undefined) return { route: "locale" };
  if (head === LANGUAGE && id === undefined) return { route: "language" };
  if (head === TOOL_CALLS && id !== undefined && tail === undefined) return { route: "tool_call", callId: id };
  if (head === TOOL_CALL_STORAGE && tail === undefined) {
    if (id === undefined) return { route: "tool_call_storage" };
    if (id === CLEANUP) return { route: "tool_call_storage_cleanup" };
  }
  if (head === BACKUP && tail === undefined) {
    if (id === undefined) return { route: "backup" };
    if (id === RUN) return { route: "backup_run" };
  }
  if (head === VOICE_MODELS && id === undefined) return { route: "voice_models" };
  if (head === SYSTEM_PROMPTS && tail === undefined) return id === undefined ? { route: "system_prompts" } : { route: "system_prompt", id };
  if (head === WEB_SETTINGS && id === undefined) return { route: "web_settings" };
  if (head === PLUGINS && tail === undefined) return id === undefined ? { route: "plugins" } : { route: "plugin", name: id };
  if (head === RUNTIMES && id === undefined) return { route: "runtimes" };
  if (head === RUNTIMES && id !== undefined && tail === SESSIONS) return { route: "runtime_sessions", runtimeId: id };
  if (head === RUNTIMES && id !== undefined && tail === TAKE_OVER) return { route: "runtime_take_over", runtimeId: id };
  if (head === RUNTIMES && id !== undefined && tail === WORK_FOLDER) return { route: "runtime_folder", runtimeId: id };
  if (head === DATA_SOURCES && tail === undefined) return id === undefined ? { route: "data_sources" } : { route: "data_source", id };
  if (head === DATA_SOURCES && id !== undefined && tail === PUSH) return { route: "data_source_push", id };
  if (head === IMPORT_FOLDER && id === undefined) return { route: "import_folder" };
  // 设置 · 组件（323 号票）：清单、一个组件、离线导入
  if (head === COMPONENTS && tail === undefined) return id === undefined ? { route: "components" } : { route: "component", id };
  if (head === COMPONENT_IMPORT && id === undefined) return { route: "component_import" };
  if (head === SAFETY_SETTINGS && id === undefined) return { route: "safety_settings" };
  if (head === SETUP && id === undefined) return { route: "setup" };
  if (head === DOCTOR && id === undefined) return { route: "doctor" };
  if (head === MODEL_SETTINGS && tail === undefined) {
    if (id === undefined) return { route: "model_settings" };
    if (id === TEST) return { route: "model_settings_test" };
    if (id === KEY) return { route: "model_settings_key" };
  }
  if (head === AGENTS && id !== undefined) {
    if (tail === undefined) return { route: "agent_settings", agentId: id };
    if (tail === PROMPT) return { route: "agent_prompt", agentId: id };
    if (tail === CLEAR) return { route: "agent_clear", agentId: id };
    if (tail === COMPACT) return { route: "agent_compact", agentId: id };
    if (tail === MODEL) return { route: "agent_model", agentId: id };
    if (tail === RUNTIME) return { route: "agent_runtime", agentId: id };
    if (tail === TAKEOVER) return { route: "agent_takeover", agentId: id };
  }
  // 每个 agent 自己的名字和音色（241 号票）：GET 列表（248 号票起只读兼容）；PUT 已经不做了，留着路径把旧调用引到角色接口
  if (head === AGENT_PROFILES && tail === undefined) return id === undefined ? { route: "agent_profiles" } : { route: "agent_profile", agentId: id };
  // 角色（248 号票）：列表 / 新建、改 / 删一个、设默认、给一个 agent 分配角色
  if (head === AGENT_ROLES) {
    if (id === undefined) return { route: "agent_roles" };
    if (item !== undefined) return undefined;
    if (id === ASSIGNMENTS) return tail === undefined ? undefined : { route: "agent_role_assignment", agentId: tail };
    if (tail !== undefined) return undefined;
    return id === DEFAULT ? { route: "agent_default_role" } : { route: "agent_role", roleId: id };
  }
  if (head === DEBUG && tail === undefined) {
    if (id === RECOGNIZE) return { route: "debug_recognize" };
    if (id === SPEAK) return { route: "debug_speak" };
  }
  if (head === PAGE_COMMAND && id === VOICE && tail === undefined) return { route: "page_voice" };
  if (head === PAGE_FILES && id !== undefined && tail === undefined) return { route: "page_file", token: id };
  if (head === PAGE_FILES && id !== undefined && tail === PAGE_THUMB && item === undefined) return { route: "page_file_thumb", token: id };
  if (head === LOCAL_FOLDERS && id === undefined) return { route: "local_folders" };
  if (head === LOCAL_FOLDERS && id === BROWSE && tail === undefined) return { route: "local_folders_browse" };
  if (head === SERVICE_THUMBNAILS && id !== undefined && tail !== undefined) return { route: "service_thumbnail", projectId: id, name: tail };
  if (head === PROJECTS && id !== undefined && tail === STANDARD) return { route: "project_standard", projectId: id };
  return undefined;
}

/** HTTP 接口错误响应里的错误码 */
export const HTTP_ERROR_CODES = [
  "bad_request",
  "not_found",
  /** 这个地址不支持这个方法 */
  "method_not_allowed",
  /** 超过单文件上限，或者请求体太大 */
  "too_large",
  /** 写分片的偏移和服务端已收到的字节数不一致（响应里带服务端的偏移） */
  "offset_mismatch",
  /** 同一个上传正有另一个分片在写 */
  "busy",
  /** 收尾的 sha256 和收到的原始字节对不上：拒绝，不入库 */
  "sha256_mismatch",
  /** 收尾时还没收全 */
  "incomplete",
  /** 外网端口上没有有效的设备凭证（还没配对、被吊销、太久没用）：只能看页面本身和配对接口（10） */
  "unauthorized",
  /** 不允许这样做（比如配对请求已经不在等批准了，不能再改设备名） */
  "forbidden",
  /** 太频繁了（同一来源 10 分钟内的配对请求超过上限），稍后再试 */
  "too_many_requests",
  /** 这种文件不能这样用（113 号票：不是能预览的文本类附件，只能下载） */
  "unsupported_type",
  /** 内容解不出来（113 号票：不是合法的 UTF-8 文本） */
  "undecodable",
  /** 要用的本机服务这会儿用不了（230 号票：导入参考音色时 ffmpeg 不在、识别进程不可用），稍后或装好再试 */
  "service_unavailable",
  "internal",
] as const;

export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];
