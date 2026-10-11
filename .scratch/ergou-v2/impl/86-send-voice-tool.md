# 86 — 用户打字时 agent 也能发语音气泡（`send_voice` 工具）

Status: done
Blocked by: 无（32、38 号票的语音回复已上线）
Spec: [第一阶段规格](../spec.md) 第 22 节"用户打字时也能发语音"一条；用户 2026-10-11 给的需求文档（下面照录要点，并按用户当天的决定改了几处）

## 背景

现在语音气泡只由"用户上一条是语音"触发（`voice/voice-reply.ts` 顶部注释）。用户打字说"念给我听 / 合成语音"时，`spoken_summary` 返回"这次不是语音"，agent 只能自己调 audio.cpp 合成一个音频文件、用 `send_attachment` 当**附件**发——声音对、格式不对。

## What to build

1. **新宿主工具 `send_voice`（标题"发语音"）**
   - 参数 `text`（要念的口语稿，必填）。把它合成成语音，作为 agent 的一条消息发进当前会话，渲染成语音气泡。
   - 工具说明写清楚：这是"用声音说话"，口语稿要像说话一样、不带 Markdown；用户打字的场合想让他听见就用它；发了语音就别在文字里再说一遍同样的话。
   - **谁能用**（用户定）：和用户直接对话的地方——个人助理、用户直接跟项目维护者说话的会话、用户在任务详情里说话时的那一轮。后台自己跑的任务、定时 / 事件触发的运行不给（这些轮里调到就返回清楚的原因，或者干脆不装配，选和现有装配最一致的）。
2. **共用"一段口语稿变成语音气泡"那一半（不要另起一套）**
   - 把 `voice-reply.ts` 里口语稿定下之后的那段——排队（`createSerialQueue`，显卡和 drama 共用，一次一条）、**分段合成和推送**（38 号票，用户定新工具也带上）、`SpeechSynthesizer.synthesize()`（请求体、超时、忙 / 没开的错误分类不变）、入库、同一事务追加新版本和载着它的 `tts_audio` 消息（时长 `readWav`、32 格波形 `WAVEFORM_BARS`、实际模型问一次 `GET /v1/models`）、失败说明、守护进程重启后重做——抽成一个公共的部分，语音轮和这个工具共用。语音轮自己的判定、口语总结、追问、兜底不变。
   - 参考音色取当前导入的（`voice/reference-voices.ts`）；没有参考音色时工具返回清楚的原因（别静默改走文字），照现有规矩在待我处理里提示导入。
3. **`AgentVoiceRecord` 建全**，转文字才看得到：`conversation`、`scope`、`inputMessageId`（触发它的那条用户消息）、`replyMessageIds`、`text`（送进 TTS 的原文）、`referenceVoice`、`model`、`mediaId`、`mime`、`durationMs`、`waveform`、`messageId`、`status`。`mode` / `summaryBy` 表达不了"agent 用工具发的"就给 `AGENT_VOICE_MODES` 加一个值（比如 `"tool"`），别硬塞成现有值；协议新值要让旧记录照常能读。
4. **显示**（用户定"只出气泡、文字收进去"，并"照语音轮的规矩"）：
   - 工具发出的语音气泡和语音轮的一样（播放条、时长、波形，长按"转文字"看送进 TTS 的原文，自动播放照设置）。
   - 这一轮 agent 另写的文字：普通的话收进气泡（长按"转文字"看得到），有代码、表格、链接这类念不出来的照常显示在气泡下面——判定沿用语音轮现有的（`speakable` 这一类）。具体怎么收、和语音轮"正在回复…"的关系，照现有前端的写法推，和语音轮不一致的地方先回报。
5. **失败要说话，不许静默**：服务没开、忙（503）、超时、回的不是 WAV、没有参考音色、入库失败——工具都返回一句清楚的原因，agent 照常发文字说明；绝不出现空气泡或悄悄不发。分段合成到一半失败照语音轮的 partial 规矩。
6. **长度限制**：按 `voice.reply` 的 `maxSeconds` / `charsPerSecond`（`estimateSpeechSeconds`）算；超了返回"太长了，缩到 N 秒以内再说"，由 agent 自己缩，工具内部不截。
7. **和语音轮的边界**：语音轮（用户发语音）行为不变；语音轮里 agent 调这个工具，直接返回"这一轮已经在合成语音了，不用再发"（用户定）。
8. **守卫登记**：照 `send_attachment`（`media/attachment-tools.ts` 的 `defineHostTool`）登记，不落入任何关注类别，不弹审批。
9. **日志**：只写字数、参考音色的 id、参考录音的文件名；不写要合成的正文、不写参考录音的完整路径。
10. **工具调用写成人话**（67 号票）：给 `send_voice` 加一条模板（比如"发语音 · 前 N 字"）。

## Acceptance criteria

- [x] 用户打字让个人助理念一句话 → 聊天里出现语音气泡，能播放，有波形和时长，音色是当前参考音色；长一点的分段先出第一段；主切面测试（假 TTS）。
- [x] 长按"转文字"看到送进 TTS 的原文；这一轮普通文字收进气泡，带代码 / 表格 / 链接的照常显示；有测试。
- [x] 假 TTS 返回没开 / 忙 / 超时 / 不是 WAV、没有参考音色、入库失败 → 工具返回原因，不出空气泡；有测试。
- [x] 超长文本 → 工具返回可读的"太长"提示；有测试。
- [x] 语音轮行为不变：合成、分段推送、口语总结、追问兜底、失败退回文字的现有测试全过，并加一条语音轮里调 `send_voice` 返回"已经在合成"。
- [x] 后台任务、定时 / 事件运行里用不了；有测试。
- [x] 打字这一轮调用时守卫不弹审批卡；有测试。
- [x] 守护进程在合成途中被杀，重启后工具发的语音照语音轮的规矩重做或记成失败；有测试。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 测试里 TTS、LLM 用假的，不打真实的 8090。
- 系统提示（`packages/daemon/prompts/*.md`）里讲语音的地方按需提一句"打字时想让用户听见可以发语音"。

## Comments

- 2026-10-11 做完（子 agent，分支 `worktree-agent-a995d24bf4bffc13d`，变基到 main `04a2bf4f`，40 号票之后）。
  - **抽出的公共部分**：`packages/daemon/src/voice/voice-synthesis.ts` 的 `createVoiceSynthesis`——排队（`createSerialQueue`）、分段合成和推送、`SpeechSynthesizer.synthesize()`（`speech.ts` 没动）、入库、同一事务追加新版本和 `tts_audio` 消息（`readWav`、32 格波形、实际模型）、失败说明（`failed` / `partial`）、段的文件什么时候删、重启重做，代码原样从 `voice-reply.ts` 挪过去；对外 `advance` / `enqueue` / `settled`（等结局）/ `start` / `segmentFile` / `whenIdle` / `stop`。`voice-reply.ts` 建一个，语音轮（判定、口语总结、追问、兜底）和工具共用；重启时的那条循环还在 `voice-reply.ts`，先后和以前一样。语音回复的主切面 `voice-reply.test.ts` 一条没改（29 条照过，三段录像骨架不变）。
  - **工具**：`voice/send-voice.ts` 的 `sendVoiceTool`（话在 `texts.ts` 的 `SEND_VOICE_*`），`AgentVoiceReplies.tool` 改成 `tools: [spoken_summary, send_voice]`，经 `conversationTools` 放进秘书、维护者起草和执行、项目维护者各段、定时作业运行的装配（和口语总结一样，工具列表固定）。谁能用按这一轮看：交给 agent 的那条输入和送进去的插话（`HostToolCall` 加了 `interjected`，`AgentSession` 调用时带上这一轮已经送进子进程的插话）里有用户说的话才能发；用户最后一句是语音 → 交回"已经在合成了"；没有用户说的话（后台任务、定时 / 事件触发的运行、运行时的通知）→ 交回原因。去掉 Markdown 后送进 TTS；按 `voice.reply` 算超长交回"太长了，没有发：念出来约 N 秒，缩到 M 秒以内（大约 K 个字）再发"；没有参考音色交回原因、待我处理里提示导入（同一种事项，开着的只有一条，标题"还没有参考音色，agent 想发的语音没发出去"）。建出 agent 语音对象（`mode: "tool"`，直接 `synthesizing`，带 `turnSeq`），等合成有了结局交回：发出去了（约几秒）/ 只发了一部分（原因）/ 没发出去（原因）。守卫：不落入关注类别、不弹审批，`readOnlyOrIdempotent: false`、`recoveredByController: true`（被杀时语音由合成那边重做，不进"中断不确定"）。日志只写字数、参考音色 id、参考录音文件名。
  - **协议**：`AGENT_VOICE_MODES` 加 `tool`；`AgentVoiceRecord` 加可选的 `coversReply`（旧记录照常能读）；`agentVoiceCoversReply` 认 `tool`。前端协议、宿主协议、模型投影都没升版本（只加可选字段和枚举值；`tts_audio` 只在 agent 消息里，投影照旧"[语音回复]"）。
  - **这一轮另写的文字**：回合结束时 `voice-reply.ts` 的 `closeToolVoices` 照语音轮整段合成的判定定 `coversReply`（去掉 Markdown 后念得完、没有代码表格图片链接，且语音合成好了），`replyMessageIds` 记在这一轮最后一条工具发的语音上；还在合成的等结局再记；守护进程在回合结束前停了，重启时定成不收。
  - **Web**：`state/agent-voice.ts`（`replyCoverage`、`agentVoicePhase`、新的 `agentVoiceHoldsReplies`、`agentVoiceBubble` 的"转文字"接上收进去的文字），`ui-state.ts` 的 `timelineItems` 改用 `agentVoiceHoldsReplies` 收正在生成的回复；工具调用说成"发语音：口语稿前 20 字"（`call-sentence.ts`）；原型秘书主线最后加两轮（`SECRETARY_VOICE`：一条只有气泡、一条气泡下面带表格和链接）。说明在 `docs/dev.md` 新的一节"用户打字时也能发语音"，32、38 号票两节标了挪动；`CONTEXT.md` 的"语音消息"加了一句。
  - **和票面 / 用户的决定不一样、请用户定的**（照"现有前端的写法推"做了，没定的先这样）：
    1. **发语音之前写的文字照常流式显示**：语音轮一开始就知道要用语音，所以从头不流式；打字这一轮要等 agent 调用了工具才知道。调用之前已经显示出来的普通文字，调用那一刻收起（回合结束定了收进去的就一直收着）——用户会看到它先出现再收进气泡。
    2. **调用之后到回合结束，和语音轮"还在回复"一样收着**：这一轮 agent 的文字和正在生成的回复都不显示，会话末尾合成中是"正在合成语音…"（第一段到了换成合成中的气泡），合成好了、这一轮还没结束是"正在回复…"；回合结束后念不出来的再显示出来。另一种做法是调用之后照常流式、回合结束时再把普通的话收进去（文字会先出现再消失）。
    3. **念不出来的显示位置按先后**：调用之前写的在气泡上面，之后写的在气泡下面（气泡在合成完的那一刻进会话），不是一律"在气泡下面"。
    4. **收不收按整轮判**（和语音轮整段合成同一个判定）：这一轮里有一处代码 / 表格 / 链接，或者普通文字长到念不完，这一轮另写的文字全部照常显示，不是一条一条判。
    5. **"转文字"**：送进 TTS 的原文后面空一行接上收进去的那几句（原样文字，不去 Markdown 标记）。
    6. **失败时有两处说明**：会话里照常有合成那边的系统说明（"语音没合成出来（原因），这次只发文字。"，和语音轮共用），agent 拿到原因后自己也会用文字说一句，可能显得重复。
    7. **口语稿里有代码、表格、图片、链接的不发**，交回原因让 agent 去掉再发（语音轮的口语总结是静默去掉）。
    8. **工具等合成完才回**（第一段照常先推先播）：这样只发了一部分、没发出去都能告诉 agent；代价是这一轮要多等合成的时间（大约语音时长的九成）。
    9. **流程任务里**：发语音不是只读或幂等，流程执行时计划外的调用按计划检查会先问用户（和 `send_attachment` 一样），只影响流程里用户插话后 agent 想发语音的情况。
    10. 系统提示没改：`prompts/*.md` 里没有讲语音的地方，用法写在工具说明里（提示词前缀缓存也不动）。
  - **测试**：主切面 `packages/daemon/test/main/send-voice.test.ts` 17 条（假 TTS；打字让个人助理念一句：气泡、波形、时长、参考音色、语音对象各字段、守卫不弹审批、日志不写正文和完整路径；分段第一段先推、工具等到完成；另写的文字收不收；没开 / 忙 / 超时 / 不是 WAV / 存不进去；只合成了一部分；没有参考音色；太长、念不出来；语音轮里调它；项目维护者；后台任务里不行、任务详情里插话之后能；定时触发、事件触发的运行和后台的普通任务里不行；合成途中停了重启重做；录给前端的 `send-voice`），故意去掉插话那一段时插话的用例会红（试过）。前端回放 `packages/web/test/state/send-voice.test.ts` 12 条（先红后绿），`call-sentence.test.ts` 加了发语音的几条。断言工具列表的 6 个测试（tasks、reminders、secretary-inbox、typed-shell、work-orders、multi-project）多了一项 `send_voice`。typecheck 通过；oxlint 0 错误（1 条警告是 57 号票留下的 `chat-look.test.ts:167`）。变基到 `04a2bf4f` 之后 Git Bash `ERGOU_TEST_WORKERS=2 npx vitest run`：263 个文件 4001 条全部通过（933 秒）。
  - **截图**（构建产物 file:// 打开，无头 Chrome，390 和 1280，经典和净白格栅）：`C:\Users\CATMAN~1\AppData\Local\Temp\claude\D--code-claudecode-my-personal-agent-ergou\09db33ab-da39-41c1-9228-bb123bef77e7\scratchpad\t86\`：`*-send-voice-chat`（两轮：只有气泡的、气泡下面带表格和链接的）、`*-send-voice-first`、`*-send-voice-menu`（长按菜单）、`*-send-voice-expanded`（转文字：原文后面接着收进去的那句）；脚本 `shots.mjs` 在同一目录。
- 2026-10-11 评审这一轮（协调者转来的 10 条和用户的决定；变基到 main `8f57a476`，40、41、42 号票之后）。
  - **用户定的**：1、2 保持（调用那一刻这一轮的文字收起，之后"正在回复…"，和语音轮一致）；4 改成"要说的都放进语音"——工具说明和"发出去了"的结果改成：要让用户听到的话都写进口语稿，文字里只放代码、表格、链接这类念不出来的，这一轮另写的普通的话只该是"好的，念给你听"这类引子（替换原来的"别在文字里重复语音的话"）；6 会话里的系统说明保留，工具发的语音没发出去时只说"这条语音没发出去（原因）。"（只发了一部分："这条语音只发出去了前面一部分（原因）。"），不说"这次只发文字"，语音回复的说明不变；3、5、7、8、9、10 保持。
  - **这一轮改的**：
    1. **前端"收着"截到下一轮开始**：`UiState.turnStarts` 记实时收到的 `turn_start` 序号（每个会话最近 20 个；重新同步、删掉的项目跟着清）；收着的范围是 `turnSeq` 到它之后的第一个 `turn_start`（`state/agent-voice.ts` 的 `heldRange`），正在生成的回复、会话末尾的"正在回复…"也只在下一轮开始之前。一轮里收下的插话的 `turn_start` 是回合结束前补的、在这一轮的回复之后，不影响。测试：`web/test/state/send-voice.test.ts` 两条（定收不收的那一版没到时下一轮的回复照常显示、照常流式、重新同步一样；插话的 `turn_start` 不截断这一轮）。截止对语音回复的"还在回复"同样适用（隐藏范围和流式），正常流程里看不出差别；语音回复的"正在回复…"提示照旧不看截止。
    2. **语音轮的判定**：语音轮但没有参考音色 → 交回"没有参考音色"（待我处理里同一条），不再说"已经在合成了"。**看子进程收下的插话**：宿主协议升到 16，`host_tool_call` 带 `interjected`（这一轮已经进了模型上下文的插话 id）。子进程 `agent-child/session.ts` 记这一轮排进 pi 插话队列的输入 id，减去 `getSteeringMessages()` 里还排着的和 yield 时清掉的，每轮开始清空；`HostToolBridge` 调用时带上，管家的 `serveHostTools` 放进 `HostToolCall.interjected`。`AgentSession` 不再按"送进去的"算。所以送进去还排着的语音插话不会让这一轮误判成语音轮，没收下的用户插话也不会留到下一轮（下一轮由通知引起时照样"不是用户在说话"）。测试：契约 `host-tools.contract.test.ts` 一条（同一批里插话还排着时后面的调用不带、进了上下文之后带、下一轮不带，故意改成按送进去的算会红，试过）；主切面任务插话那条改成第二步一次调 `bash sleep 3` 和 `send_voice`，sleep 时用户插话，紧跟着的发语音交回"不是用户在说话"，下一步才发出去；加一条语音轮没有参考音色。
    3. **一轮两条**：两条都发出去（两个气泡按先后，另写的话记在最后一条上、收进去）；前一条没发出去（503）、后一条发出去（说明只有"这条语音没发出去（语音服务忙）。"，排在气泡前面，不含"只发文字"）。
    4. **被杀后的恢复**：agent 的会话里那次调用补"这次调用被中断了：……这条语音已经交给运行时合成，会自己补发出来（发不出去时会话里有说明），不要重发。"（`SEND_VOICE_INTERRUPTED`）。语音记下 `toolCallId`（`AgentVoiceRecord` 新的可选字段）；`AgentSession` 接着会话拉起时问 `voiceReplies.interruptedResults(会话)`（`sendVoiceInterruptedResults`：这个会话最近 20 条工具发的语音），和请求里的合在一起交给管家（管家再并上守卫执行记录里的）。没走守卫执行记录：`send_voice` 是 `recoveredByController`，执行记录里本来就没有它。测试用真的杀进程：`helpers/killable-daemon.ts`（独立进程里的守护进程、`SIGKILL`），给它加了 `speechUrl`（指向测试进程里的假 TTS）；工具在等合成时杀掉，同一个数据目录重启后语音重做发出来（`coversReply: false`），待我处理里没有"中断不确定"，再说一句话时秘书回显的上下文里那次调用的结果就是上面那句。
    5. **超时**：选了"等不完先交回"。`SEND_VOICE_WAIT_MS` 5 分钟（测试经 `startDaemon` 的 `sendVoiceWaitMs` 换短）：串行队列前面可能排着语音回复、别的会话的语音（60 秒的一条约 55 秒，audio.cpp 第一次加载最多 90 秒），拉长 `timeoutMs` 也说不准上限，还会让整轮一直卡着；到 5 分钟交回"语音还在合成（排在别的语音后面，或者合成得慢）：合成好会自己出现在聊天里，不要重发，接着做别的就行。"，语音照样合成发出去，比单次工具调用的默认 10 分钟超时短得多。工具说明里写了最多等约几分钟。测试：等 0.5 秒先交回、回合结束、之后放行合成，气泡出现、另写的话照规矩收进去。
    6. **去重**：协议包 `voice.ts` 加 `agentVoiceHoldsTurn`（语音回复在回复；工具发的在合成或合成好了、`coversReply` 还没有），`agentVoiceCoversReply` 用它；前端删掉自己的 `holdsTurn`。
    7. **合成一条事项**：两条"没有参考音色"合成一条 `MISSING_REFERENCE_NOTICE`，标题"要合成语音，得先导入参考音色"，正文说"agent 要用语音跟你说话（你发了语音，或者它想发一条语音）"。`MISSING_REFERENCE_NOTICE_FOR_TOOL` 删了。
    8. **`notWaited` 拆开**：`aborted`（调用被中止、守护进程在停）、`stillSynthesizing`（等太久）、`alreadySent`（同一次调用的幂等键撞了：只发一条）。`alreadySent` 没有测试：从外面造不出同一个工具调用 id 的第二次执行。
    9. **边界**："发语音"的行为都挪进 `send-voice.ts`（`createSendVoice` 交回 `tool`、`closeTurn`、`start`；`sendVoiceInterruptedResults`），`OpenTurn.toolVoices` 和 `closeToolVoices` 从 `voice-reply.ts` 拿掉，`voice-reply.ts` 只给 `openTurn`（这一轮开始的序号、回复的归属）、回合结束时调 `closeTurn`、启动时先调它的 `start`。`advance` 留在 `voice-synthesis.ts`：它和合成那边自己的写共用"读最新、按版本追加"和派生视图，语音轮、发语音工具都要用；放进 `send-voice.ts` 语音轮就得反过来依赖它。顺带：回合结束时 `closeTurn` 马上记 `coversReply`（不再等合成有结局），合成那边追加版本改成在最新的一版上写、还在合成才写（`advanceOwn`），不会冲掉也不会因此停下；回合结束时还在合成的先按收进去记，之后才没合成出来的按状态不收（`agentVoiceCoversReply` 本来就看状态）。这样定收不收的那一版紧跟在 `turn_end` 后面，前端正常不会跨轮收着。
    10. **ADR-0013 末尾加了"2026-10-11 补充（86 号票）"**：工具发的语音怎样是"一轮只回一条语音"和"语音消息可能排在下一轮的回复后面"的例外（原文没改）。
  - **和协调者说的不完全一样、请看一眼的**：截止到下一轮开始顺带也用在了语音回复的"还在回复"（只管隐藏范围和流式，提示不动）；宿主协议因为"收下的插话"升了版本（15 → 16，子进程和守护进程一起换，没有兼容旧子进程的必要）；被中断的调用补结果走 `AgentSession` 而不是守卫的执行记录。
  - **docs/dev.md** 的 86 号票一节按这一轮重写，宿主协议那一条加了 `interjected`。
  - **测试**：主切面 `send-voice.test.ts` 现在 22 条（加了一轮两条、先失败后成功、等太久、语音轮没有参考音色、真杀守护进程，任务插话那条加了"还排着不算"），录像 `send-voice` 重新录过（说明的话变了，骨架没变）；契约 `host-tools.contract.test.ts` 加 1 条；前端 `web/test/state/send-voice.test.ts` 加 2 条。语音回复的 `voice-reply.test.ts` 照旧一条没改、全过。typecheck 通过；oxlint 0 错误（1 条警告还是 `chat-look.test.ts:167`）。变基到 `8f57a476` 之后 Git Bash `ERGOU_TEST_WORKERS=2 npx vitest run`：264 个文件 4157 条全部通过（1032 秒）。
  - **截图**：变基后重新构建、重截了同样的 16 张（同一目录），和上一轮的逐字节一样——这一轮没有看得见的变化（截止到下一轮开始、说明的话只在边角情况里出现）。

- 2026-10-11 完成：两轴评审无阻塞。用户定显示节奏维持现状（调用那一刻收起，之后"正在回复…"）、"要说的都放进语音"（文字里只留念不出来的）；失败说明不写"只发文字"；其余几处照实现方的做法。评审建议（收起截到下一轮开始、按子进程收下的插话认用户说话并升宿主协议到 16、一轮两条、被杀后补"不要重发"、等不完 5 分钟先交回、去重、两条"没有参考音色"合一、边界集中到 `send-voice.ts`、ADR 0013 追加补充）已改。全量 4157 条通过。压缩合并进 main。
