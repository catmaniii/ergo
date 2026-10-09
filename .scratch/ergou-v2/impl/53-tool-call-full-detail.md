# 53 — 工具调用的完整参数和返回

Status: done
Blocked by: None — can start immediately
Spec: [第一阶段规格](../spec.md) 第 19 节"会话区照搬 AgentSense"的详情页；调研 `docs/research/15-agentsense-zoom-detail-task-modes.md` §2、§5.2、§6.1 的 T4、§6.3

## What to build

详情页（56 号票）要显示工具调用的完整参数和返回。现在工具调用 part 只带参数摘要（≤160 字）和结果摘要（≤200 字），完整内容只在 pi 的会话文件里。

本票让守护进程能按调用 id 给出完整的参数和返回。

## Acceptance criteria

- [x] **按调用 id 取完整内容**：任意一次工具调用（秘书、维护者、子 agent），包括出错的返回、被拦下的调用，都能按调用 id 取到完整参数和完整返回。
  - 怎么拿由实现定：调用结束时另存一份，或者读 pi 会话文件。写进 Comments，说明理由。
  - 守护进程被杀后重启，以前的调用照样取得到。
- [x] **隐私和截断**：
  - 完整内容和摘要一样经过 `CallPrivacy` 擦除，密钥、MCP 凭据等不出守护进程。
  - 单个值超过上限（建议 200KB）时截断，注明原长和"已截断"。
  - 二进制返回（比如图片）不内联，给媒体引用或说明。
- [x] **接口**：
  - 协议加一个 HTTP 接口，按调用 id 取，宽松、向后兼容。
  - 本机端口和外网端口的鉴权与现有接口一致。
  - 消息里的工具调用 part 照旧只带摘要。
- [x] **彻底删除**：按 21、32 号票的口径彻底删除时，这些完整内容一起删掉。
- [x] **测试**：主切面覆盖以下情形：
  - 普通调用；
  - 被拦下；
  - 出错；
  - 超长截断；
  - 含密钥的参数被擦掉；
  - 重启后照样取得到；
  - 彻底删除后取不到。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 工具调用的守卫判定和 part 在 07、25 号票；隐私擦除见 `redactSecretValues` 和 `CallPrivacy`。
- 宿主协议现在是 10。如果要改，版本取 main 当前值 + 1。

## Comments

- 2026-10-09 做完。实现概要：守护进程 `guard-runtime/tool-call-details.ts`（另存、截断、视图、按 id 取、彻底删除的改写函数），接在 `guard-runtime.ts` 的 `tool_call_end` 处理里（排在工具调用记录之前）；HTTP 接口在 `gateway/http-api.ts`；彻底删除接在 `memory/purge.ts`、删除项目接在 `projects/deletion.ts`；协议 `HTTP_PATHS.toolCall`、`ToolCallDetail`、`TOOL_CALL_VALUE_MAX_BYTES`（`protocol/src/http.ts`、`http-schema.ts`）。取舍写进 ADR-0020，说明在 `docs/dev.md`（"守卫接入运行时"的"完整参数和返回"、频道表、HTTP 接口列表）。
- **完整内容怎么拿：调用结束时另存一份**（不读 pi 会话文件）。理由：读过的密钥值只在守护进程内存里，重启后再读会话文件就擦不掉了；会话文件只能在 `agent-child/` 里读（ADR-0004），还得先知道调用在哪个 agent 的哪个会话文件里；评审子 agent 的会话不留、删项目时维护者的会话文件整个删掉。存成守护进程内部频道 `tool_calls` 上的 `tool_call_detail` 事件（负载就是 `ToolCallDetail`），派生视图 `tool_call_details` 记调用 id → 全局序号。经守卫的调用都有（秘书、维护者、子 agent、评审子 agent；评审的 `conversation` 为 null）。
- **接口**：`GET /api/tool-calls/<调用 id>`（`HTTP_PATHS.toolCall(callId)`，id 按 encodeURIComponent），回 `ToolCallDetail`：`callId, tool, toolTitle?, agentId, conversation, taskId?/projectId?/stageId?/scheduledJobId?, outcome, startedAt?, endedAt?, args, result, isError, media?, truncated?, resultWithheld?, purged?`；没有回 404 `not_found`（本票之前的调用没有完整内容，详情页退回摘要）。鉴权走网关入口，和别的 `/api/` 一样（外网端口没凭证 401）。宽松、向后兼容：以后只加可选字段。
- **体积和截断的口径**：单个值 = 返回的文字、参数里的每个字符串（参数结构保留，不整段序列化后截）；上限 200KB（UTF-8 字节，`TOOL_CALL_VALUE_MAX_BYTES`），超过的只留开头 200KB（不切开多字节字符），末尾加"…（已截断：原长 N 字节，只留开头 200 KB）"，`truncated` 里按 JSON Pointer 列出位置和原长（`/args/content`、`/result`）。先擦密钥再截。pi 自带工具的结果本来截在 50KB，实际多数调用只有几 KB。
- **二进制**：宿主协议改到 **11**（main 上是 10）：`tool_call_end` 加可选的 `media: [{ type, mimeType?, bytes? }]`，子进程按 pi 结果里的非文字块（图片）填，图片内容仍不过协议（`resultText` 里照旧是 `[image]` 占位）；完整内容里原样放进 `media`。契约测试 `test/contract/tool-result-media.contract.test.ts`。
- **彻底删除**：字段级改写（ADR-0008 的口径）——参数里的文字、返回换成删除标记，`purged: true`，工具、结局、归属不变；接口照样 200，但原文取不到（主切面断言）。范围：工具调用记录或执行记录被改写的调用（`targetExecution` 里带上）；检索素材的调用另按完整返回里提到的素材 id 找（摘要只有开头，记录里不一定提到它）；删除项目时项目维护者会话里的（含子 agent）、维护者的、属于项目的一起改写。只要一次检索列出过被删素材，整条完整内容都换掉（不逐行改，宁可多删）。"21、32 号票的口径"里 32 号票没有讲彻底删除，按 21 号票（ADR-0008）和删除项目（ADR-0010）做。
- **测试**：主切面 `test/main/tool-call-detail.test.ts`（9 条：普通调用和 404、被拦下和出错、超长截断、读图片的 media、被杀后重启、审批决定被彻底删除、检索结果只在完整返回里列出的素材被彻底删除、维护者读 .env 后的擦除和不记返回、外网端口鉴权）；子 agent 的在 `test/main/parallel.test.ts` 加了一条断言；已有的 `memory-delete`、`projects`（删项目）、`secret-read-outbound` 的"事件库里不剩原话/密钥"断言现在也覆盖完整内容；`external-port.test.ts` 的要凭证列表加了这个接口；协议的路径拼拆在 `protocol/test/http.test.ts`。
- 2026-10-09 评审后的修改：
  - **删素材时不再逐字扫全部完整内容**：视图 `tool_call_details` 加了 `tool` 列（带索引），找"返回里列出过被删素材的检索调用"时先按工具筛出 `search_materials` 的调用，只看这些的负载（`detailEventsOfToolMentioning`）。ADR-0020 的说法跟着改了。
  - **评审子 agent 的调用带上归属**：`ReviewInput.scope`（评审的任务、阶段，项目的任务还有项目），评审接守卫时作为 `messageScope` 给出，完整内容里有 `taskId`、`stageId`、`projectId`；删除项目按项目找到它们一起改写（`detailEventsOfProject`），彻底删除时和别的调用一样按调用 id 改写。主切面补了"删除项目后评审子 agent 读过的内容也取不到"。
  - **认得出的密钥形态也擦**：`CallPrivacy.text` 在擦读过的值之后再用守卫的 `SECRET_PATTERNS` 擦一遍（`guard/secrets.ts` 的 `redactSecretShapes`：赋值形式留下名字、网址里留下协议和 `@`、私钥从 BEGIN 擦到 END）。完整内容和工具调用记录的摘要、效果日志、审批、"交给我做"用的是同一份 `CallPrivacy`，所以一起生效。补了单元测试（`test/guard-runtime/read-secrets.test.ts`）和主切面（bash 输出里的 token）。
  - `DetailContext.privacy` 改成必填；`ToolResultMedia` 只在协议包定义一份，宿主协议只引类型；`bytes` 的注释改成"按解码后的算"；改名：`limited` → `truncateValue`（参数里的叫 `truncateStrings`）、`toolCallDetailEvents` → `detailEventsOfCall`、`toolCallDetailEventsOf` → `detailEventsOfProject`。
  - **给 56 号票**：只靠完整内容找到的检索调用（结果摘要里没提到被删素材），会话里的 `messages_purged` 不会列出它（它的工具调用记录没改），所以详情页不要缓存完整内容，每次打开现取。
  - 存储的总量上限和保留期以后单开票，这次不做。
  - 还剩的口子（没改，留给主会话定）：秘书能读项目档案，它读过的档案全文在秘书会话的调用里，没有项目归属，删除项目时不改写；涉及多个项目的任务的评审读各项目的档案和工作目录，任务不属于单个项目，删除其中一个项目时也不改写。另外删除项目原本只改写维护者自己的效果日志和执行记录，子 agent、评审的效果日志摘要（结果开头 80 字）删项目时不改，这是本票之前就有的。

- 2026-10-09 完成：两轴评审后改了删素材时只扫检索调用、评审子 agent 的调用带归属、存之前按密钥形态再擦一遍等；和 43 号票一起在整合分支跑全量通过后压缩合并进 main。宿主协议 11。待开票：完整内容的总量上限和保留期；秘书读项目档案、多项目任务的评审读到的内容在删除项目时清不掉。
