# 32 — agent 用语音回复

Status: done
Blocked by: 31（语音输入与识别）
Spec: [第一阶段规格](../spec.md) 第 22 节（语音消息）、第 3 节（agent 子进程与 pi 封装层）、第 7 节（秘书）、第 19 节（Web UI）

## What to build

只要用户发的是语音，agent 就用语音回复（秘书和维护者的会话都一样）。回复短的整段合成语音；回复长的，agent 写一段适合听的口语总结来合成语音，详细内容照常用文字、图片、视频发到聊天里。语音用本机 audio.cpp、以用户导入的参考音色做声音克隆。agent 发的语音和用户的一样显示成气泡，可以播放，长按能"转文字"看送进 TTS 的原文。设置里可以导入、试听、选择参考音色；不直接引用 audio.cpp 自带的音色库。

## Acceptance criteria

- [x] 主切面：用户发语音后，agent 的这次回复带一条语音消息；用户发文字时不带。是否用语音由运行时按"用户上一条是不是语音"判定，不只靠提示词。
- [x] 主切面：回复的口语稿超过阈值（可配置，默认按字数估算约 60 秒）时，运行时要求 agent 另写一段口语总结用来合成，详细内容照常作为文字和附件发出；agent 没给总结时由运行时兜底生成。阈值内的整段合成。
- [x] 主切面：agent 语音的数据对象绑定音频（入库的媒体，内容哈希）、时长、送进 TTS 的原文、所用参考音色、TTS 模型，以及对应的完整回复在哪条消息里。测试里 TTS 用假的（不调用 audio.cpp、不占显卡）。
- [x] TTS：经本机 LSM 托管的 audio.cpp 服务（drama 的 TTS 引擎，地址在配置里，默认本机 8090）的 HTTP 接口合成，`POST /v1/audio/speech` 带参考音色的 `voice_ref`（WAV 路径）和 `reference_text`（逐字稿，Fish 克隆必须同时给）；二狗不自己启动它。服务没开、合成失败或超时时退回只发文字，会话里一条说明。`deploy/lsm/ergou-daemon.example.yaml` 加上对 `audiocpp` 的弱依赖（soft）。
- [x] 设置：语音页可以导入参考音色（上传一段 WAV 和它的逐字稿，取个名字）、试听、选当前用哪一个、删除；参考音色存在数据目录（个人数据，不进仓库），不列出 audio.cpp 自带的音色库。没有任何参考音色时语音回复退回只发文字，并在待我处理里提示去导入。
- [x] 前端：agent 的语音显示成和用户语音一样的气泡（在 agent 一侧），点一下播放，长按（桌面右键）"转文字"展开送进 TTS 的原文；前端状态层用主切面录下的事件流回放。
- [ ] 手动冒烟（经 LSM 起的守护进程、真 audio.cpp）：导入参考音色后发一条语音，收到用该音色合成的语音回复，记录合成耗时；结果写进票的 Comments。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- **已有一份导入的参考音色**：用户已导入一份参考音色到本机数据目录的 `voices/` 区（一个以英文 id 命名的目录）：`reference.wav`（参考录音）、`reference.txt`（逐字稿，UTF-8）、`voice.json`（`{format: 1, id, name, audioFile, referenceTextFile, durationMs, sha256, importedAt}`）。参考音色的存储就按这个格式定（数据目录加一个 `voices` 区，每个音色一个以 id 命名的英文目录），设置页导入时照此写入；没有选定时默认用唯一的那一个。测试一律用临时数据目录，不读这份真实数据；仓库里（测试、示例、文档）只用编的示例音色。
- audio.cpp 的用法见本机的 audio-cpp skill（`~/.claude/skills/audio-cpp/SKILL.md` 和它的 `references/`，只读参考）；仓库里不写本机路径，示例配置用占位符。
- 显卡和 drama 共用同一个 audio.cpp 服务，不另起一份（两份 Fish 会把 12GB 显存撑爆）。接口契约见 audio.cpp 仓库 `repo/app/server/README.md`，调用写法可参考 drama_maker 的 `server/providers/tts-audiocpp.js`（都只读参考）。
- audio.cpp 读不了带中文的路径：导入的参考音色在数据目录里用英文文件名（比如音色 id）存，显示名另存。
- 测试里用一个假的 HTTP 服务代替 audio.cpp（空闲端口），不碰真服务。

## Comments

- 2026-10-08 做完（手动冒烟那条留给主会话和用户），同日按评审意见改了一版（见下面"评审后的修改"）。实现概要：守护进程这一侧在 `packages/daemon/src/voice/`：参考音色 `reference-voices.ts`、读 WAV 和波形 `wav.ts`、口语稿 `spoken-text.ts`、经 audio.cpp 合成 `speech.ts`、跟着回合做语音回复 `voice-reply.ts`、给模型和人看的话 `texts.ts`、和 31 号票共用的小工具 `shared.ts`、agent 语音对象的派生视图 `agent-voice-views.ts`；口语总结工具由各处的装配放进代为执行的工具（秘书、`taskSetup`、`executionSetup`、项目维护者的 `assemble`），`AgentSession` 的 `voiceReplies` 选项只管输入后面的说明和回合后的追问；`daemon.ts` 只做登记；设置页的 HTTP 接口在 `gateway/http-api.ts`（`/api/reference-voices`，试听和媒体共用发文件、支持 Range）。协议在 `protocol/src/voice.ts`、`voice-schema.ts`（`AgentVoiceRecord`、`agent_voice` 事件、`ReferenceVoice`），消息里的 `tts_audio` part 在 `schema.ts`。Web：状态层 `state/agent-voice.ts`（`replyCoverage`、`agentVoicePhase`），气泡 `AgentVoiceBubble`（`VoiceBubble.tsx`），会话末尾"正在回复…"/"正在合成语音…"，设置里的语音页 `pages/more/VoicePage.tsx`（`#/more/voice`），待我处理里"去导入参考音色"的链接（`InboxPage.tsx` 的 `SETTINGS_LINKS`）。说明见 `docs/dev.md` 的"agent 用语音回复"，取舍见 ADR-0013。测试：主切面 `test/main/voice-reply.test.ts`（21 条，录了 `voice-reply`），口语稿 `test/voice/spoken-text.test.ts`（表格），前端回放 `packages/web/test/state/agent-voice.test.ts`；配置、LSM 条目各加一条。宿主协议没有改（工具走已有的代为执行，说明走已有的输入上下文消息，追问就是一条 `user_input`），版本仍是 main 上的 8。

规格没写清、按最保守做法定下的（含评审后用户定的）：

- **是否用语音**：看这一轮处理的用户消息（交给 agent 的那条输入，和这一轮收下的插话）里最后一条是不是语音。运行时的通知引起的一轮（任务执行中的阶段通知、审批结果……）不用语音，哪怕用户上一句是语音——不然任务执行的每一轮进展都要合成，占显卡。例外：31 号票里用户重新识别成功后交给 agent 的那条通知（带转写）算用户的语音（31 号票的 `isVoiceRetryNotice`）。出错、中止、中断的一轮，最后一句不是语音的，只有卡片、没有文字也没写口语总结的，都不合成（agent 语音对象记成 `skipped`，带原因）。插话的情形写了逻辑，没有专门的主切面测试（前端有手写序列测"还在回复→skipped 时文字回来"）。
- **语音这一轮怎么显示**（评审后用户定）：这一轮开始时输入是语音（有参考音色）就建出 agent 语音对象（`replying`，记下这一轮开始的序号），前端不流式显示回复，这一轮 agent 的消息先不显示文字，会话末尾"正在回复…"。回合结束后：短回复（整段合成）"正在合成语音…"，合成好只出语音气泡，文字收进语音里（长按"转文字"展开）；长回复（口语总结）文字和附件照常显示，合成好再加气泡；没合成出来的文字照常显示，带一条说明。往上翻、重连补发同一套规则。事件日志、agent 的会话里文字原样都在。
- **什么算长**：回复的文字去掉 Markdown 标记后按字数估（每秒 4.5 个汉字，一个英文单词按两个汉字；`voice.reply.charsPerSecond`），超过 `voice.reply.maxSeconds`（默认 60 秒，约 270 个汉字）算长。另外有代码块、表格、图片、光秃秃的链接地址的，不论长短都不整段念（念不出来，而且整段合成时文字会收进语音里，不能丢内容）。
- **"运行时要求 agent 写口语总结"**：交给 agent 的语音输入后面跟一条说明（输入上下文消息，不改系统提示）：这次回复会合成语音，回复长或有念不出来的内容时调用 `spoken_summary` 工具写一段。秘书、维护者每一段的装配都有这个工具（工具列表固定，提示词前缀缓存不受影响；子 agent 不加，它不和用户说话）；几个断言工具列表的测试（tasks、reminders、secretary-inbox、typed-shell、work-orders 的固定上下文）因此加了一项。没有参考音色时不带这条说明。口语总结的用法不进系统提示（只在这条说明和工具说明里），所以 14 号票集中在 `executionGuide(thresholds)` 的执行说法不用跟着改。
- **agent 没写总结时**（评审后用户定）：先追问它一次（话在 `texts.ts`）：会话在处理下一条输入之前把这句交给它，这一次不算新回复——没有 turn_start/turn_end，它说的话不进会话（工具调用记录照常在），用量照常记账；追问时用户说的话留在队里，追问完再处理。追问后还是没写，运行时截回复开头念得完的几句，加一句"详细内容我发在聊天里了。"（守护进程不调模型，所以是截不是概括）。子进程退出、任务暂停时不再追问，直接兜底；守护进程在追问时停了，重启后直接兜底。agent 写的总结太长时同样截到念得完。
- **agent 语音是自己的对象**：`AgentVoiceRecord`（会话频道上的 `agent_voice` 事件、派生视图 `agent_voices`），不和用户语音的 `VoiceRecord` 合成联合类型（生命周期、字段、素材和删除的规矩都不一样）。状态 `replying` → （`summarizing`）→ `synthesizing` → `done` / `failed`，或者 `skipped`。绑定：音频（入库的媒体 id，就是内容哈希）、格式、时长、波形、送进 TTS 的原文 `text`、`mode`（`whole` / `summary`）和 `summaryBy`（`agent` / `runtime`）、参考音色 `{ id, name }`、实际的 TTS 模型、回的是哪条输入 `inputMessageId`、这一轮开始的序号 `turnSeq`、完整回复所在的消息 `replyMessageIds`、载着它的消息 `messageId`、耗时 `elapsedMs`、失败或没用语音的原因。04 号票预留的 `tts_audio` part 改成 `{ voiceId, mediaId, mime, durationMs, waveform }`（以前只有 `mediaId`，从没用过）。合成好时运行时追加一条只有这个 part 的 agent 消息（和语音对象的新版本同一事务）；失败的不追加。
- **实际的 TTS 模型**（评审后）：合成成功后问一次服务的 `GET /v1/models`（audio.cpp 每项带 `family`），记成"fish_audio（audio.cpp/tts）"这样；问不到记配置里的 `audio.cpp/<模型 id>`。示例配置里 `voice.speech.model` 改成占位符（"audio.cpp 服务上 Fish-Audio S2 Pro 的模型 id（drama 的配置里是 tts）"），原样用时不发请求、说明里写怎么填；不写这一项时默认还是 `tts`。
- **退回只发文字**：服务没开（连接被拒）、忙（HTTP 503 / `server_busy`：不等超时、不重试，说明里写"语音服务忙"）、出错（非 2xx）、超时、回的不是 WAV、存不进媒体库、参考音色被删了：语音对象记成失败（带原因），会话里一条系统说明"语音没合成出来（原因），这次只发文字。"——合成之后的每一步都走同一个失败处理（评审指出入库、算波形出错时会一直停在"合成中"，已改，主切面有用例）。没有任何参考音色时不建语音对象、不合成、会话里不写说明（每条语音都写一遍太吵），待我处理里放一条"还没有参考音色"（开着的只有一条，动作"去导入参考音色"带到设置里的语音页，导入后自动归档）。
- **超时**：余量 15 秒 + 冷启动 90 秒 + 估出的语音时长 × 2 秒（`voice.speech.timeout`，都可配置；不知道服务那边模型加载了没有，冷启动总算上）。60 秒的语音最多等 225 秒。超时只是不等了，audio.cpp 那边没法中途取消，会照样合成完。
- **守护进程在途中停了（被杀）**：选的是**重做**：重启后还在"合成中"的接着重做（合成只是一次 HTTP 调用，可以重做；不进 23 号票的"中断不确定"，主切面有用例）。还在追问口语总结的直接兜底再合成；还在回复的记成 `skipped`（那条输入由会话标成中断、不重送，文字照常显示）。代价是守护进程停得久的话，这条语音会晚到。
- **合成一次一条**（显卡和 drama 共用），在 agent 处理下一条输入时照常进行，所以语音消息可能排在下一轮的回复后面。
- **参考音色**：文件就是真相，不进事件日志（数据目录的 `voices/` 区，随快照备份）。格式照 Notes：每个音色一个英文 id 的目录（导入时生成 `v-` 加 8 位十六进制），`reference.wav`、`reference.txt`、`voice.json`（`{ format: 1, id, name, audioFile, referenceTextFile, durationMs, sha256, importedAt }`）；选了哪一个记在 `voices/current.json`（`{ format: 1, voiceId }`）；没选过、或选的被删了，用最早导入的（只有一个时就是它，所以用户已导入的那一份不用再选）。导入只收 1–30 秒的 WAV（PCM 8/16/24/32 位或 32 位浮点，按 WAV 头量时长），名字（40 字内）和逐字稿都要有；同样的录音和名字再导一次拿到同一个；录音经 JSON 里的 base64 上传（20 MB 上限），没走媒体库的分片续传（不想在媒体库里留一份没人引用的个人录音）。"试听"播的是参考录音本身（和媒体同一套发文件，支持 Range），没有做"合成一句试试"。数据目录本身的路径里有非英文字符时，合成前直接报原因（audio.cpp 读不了；报错里只写音色 id，不写完整路径），不发请求。
- **LSM 条目**：`deploy/lsm/ergou-daemon.example.yaml` 加了 `dependsOn: [{ id: audiocpp, type: soft }]`。示例配置加了 `voice.speech`（地址、模型 id 的占位符、超时）和 `voice.reply`（阈值、语速），不含本机路径。

评审后的修改（2026-10-08）：短回复合成好只出语音、语音这一轮不流式（`replying` 状态和 `turnSeq`、前端 `replyCoverage` / `agentVoicePhase`）；没写总结先追问一次（`AgentSession` 的 `followUp` 钩子）；合成之后每一步出错都走 `fail`；记实际的模型；服务忙直接退回；仓库里只用编的示例音色；`speech.ts` 的报错不带完整路径；给模型和人看的话挪到 `texts.ts`；口语总结工具走装配（去掉会话类里的追加和对守卫工具包的改写）；和 31 号票共用 `nextVersion`、队列、说明（`shared.ts`），前端 `mergeVoices` 合一，试听复用媒体的发文件；`InboxPage` 的设置链接收进一张表；`SpokenPace` 打包念多快和多长算长；重新识别的通知改用 31 号票导出的 `isVoiceRetryNotice`；删了没用的 `AGENT_VOICE_*_LABEL`。前端回放的录制 `voice-reply` 重录了（演示流程第二段改成"追问后补写总结"，第三段改成"语音服务忙"）：`agent_voice` 帧 6 → 10（`replying` 0 → 3、`summarizing` 0 → 1，`synthesizing` 3、`done` 2、`failed` 1 不变），agent 的 `message` 帧 7 → 6（追问时它说的那句不进会话），`stream` 帧 3 → 2，其余（用户消息、`voice`、`turn_start`、`turn_end`、系统说明）不变，总数 39 → 41。

**主会话做手动冒烟要配置、要验的**：

1. 合并到 main，`npm run build:web`，把 LSM 里的 ergou-daemon 条目照新的示例加上 `dependsOn: audiocpp (soft)` 后重新登记，再经 LSM 重启 ergou-daemon。数据目录配置一般不用改：`voice.speech.url` 默认就是 `http://127.0.0.1:8090`、模型 id 默认 `tts`（和 drama 的 `audiocpp-serve.mjs` 一样）。**注意**：要是数据目录的 `config/ergou.json` 是照新的示例配置抄的，`voice.speech.model` 是占位符，要换成 `tts`（或者删掉这一项）。
2. 在 LSM 里确认 audiocpp（drama 的 profile）在运行；没在跑就先起它（二狗不会去起它，弱依赖也不等它）。
3. Web 打开 设置 → 语音：应当列出用户已导入的那份参考音色，标着"当前"；点"试听"能听到参考录音。
4. 在秘书聊天里按住说一句（比如"明天早上九点提醒我交报告"）：先看到识别文字，然后会话末尾"正在回复…"（不流式显示回复），回复完变成"正在合成语音…"，然后 agent 一侧只出现语音气泡（不显示文字）；点一下播放，听是不是参考音色的声音；长按（桌面右键）"转文字"展开原文。
5. 记合成耗时和模型：`GET http://127.0.0.1:8810/api/conversations/secretary/messages` 返回的 `agentVoices[].elapsedMs`（第一次含 audio.cpp 加载模型的冷启动，之后再发一条看已加载时的耗时）和 `model`（应当是 `fish_audio（audio.cpp/tts）`），写进这里。也可以看守护进程日志里"语音合成 → …"那一行和语音对象的 `durationMs`。
6. 再说一句要长回答的（比如"详细讲讲怎么做番茄炒蛋"）：回复完详细步骤照常是文字，然后是口语总结的语音（`mode: summary`）；agent 没写总结时会被追问一次（会话里多一条口语总结的工具调用记录，不多文字），`summaryBy` 是 `agent`，追问了还是没写才是 `runtime`。
7. 打字发一条：只回文字（照常流式），不合成。
8. 可选：drama 正在用显卡合成时发一条语音，应当很快退回只发文字，说明里写"语音服务忙"。

- 2026-10-08 完成：经两轴代码评审并按意见修改（合成后出错一律走失败、记实际 TTS 模型、服务忙不等超时、个人数据换成示例、口语总结工具走装配、和 31 号票共用版本号/队列/说明），按用户定的显示（语音这一轮不流式，短回复合成好只出语音气泡）和总结兜底（先追问 agent 一次，再不行截取）压缩合并进 main。真 audio.cpp 手动冒烟待 LSM 恢复后和用户一起做。
