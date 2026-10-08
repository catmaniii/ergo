# 37 — 麦克风预热：进语音模式就备好麦克风，按下立刻开录

Status: done
Blocked by: 31（语音输入与识别）
Spec: [第一阶段规格](../spec.md) 第 22 节（语音消息）

## What to build

用户真机实测：按下"按住 说话"的同时念"ABCDEFGHIJKRLN"，只识别出"FGHIJKRLN"。原因是按下时才 `getUserMedia` 打开麦克风、再建音量分析和 MediaRecorder，手机上要几百毫秒到一秒多，这段时间说的话没录进去。

用户定（2026-10-08）：**提前加载麦克风，但不记录**。切到语音模式时就打开麦克风流、接好音量分析，MediaRecorder 不启动（不录、不存、不上传）；按下时只启动录音，立刻开录。代价是语音模式期间浏览器和系统的麦克风指示灯亮着，所以切回文字模式、页面切到后台、语音模式里闲置超过 10 分钟（可配，前端常量即可），都立刻关掉麦克风；再按下时重新打开（这一次照旧显示"准备中"）。

## Acceptance criteria

- [x] 预热：进入语音模式（包括页面打开时恢复成语音模式）就请求麦克风并保持流开着、音量分析就绪；不启动录音器，不产生任何录音数据。离开语音模式、页面切到后台（visibilitychange）、组件卸下、闲置超过阈值时立刻停掉所有音轨（指示灯熄灭）；回到前台且仍在语音模式时重新预热。
- [x] 按下即录：流已就绪时，按下的那个 pointer 事件里同步启动录音器，"准备中"不出现、计时从按下那一刻开始；流还没就绪（刚进语音模式就按、或者预热被关掉了）时照旧"准备中"、就绪后开始。抬手、上划取消、太短、60 秒自动发送的行为不变；录完一条后流不关，接着下一条。
- [x] 不录的保证：预热期间录音器不存在或没启动；音量面板只在按住时显示。测试覆盖：进语音模式后没有 MediaRecorder.start 调用、按下才有；离开语音模式 / 切后台 / 闲置后音轨都停了。
- [x] 测量：每条语音带上"按下 → 录音器真正开始"的毫秒数，以及这次是不是预热命中（流已就绪），随语音一起发给守护进程，存在语音对象里（协议加一个可选的诊断字段，宽松向后兼容）；本机接口取得到，方便在用户手机上看实际数字。
- [x] 权限：第一次进语音模式时请求麦克风权限；被拒时照旧提示怎么开，不反复弹。
- [x] 前端状态层（voice-gesture 等）表格或回放测试覆盖新的状态；所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 现状代码：`packages/web/src/app/voice-recorder.ts`、`state/voice-gesture.ts`、`ui/conversation/VoiceInput.tsx`。31 号票评审时为隐私改成"只在按住时开麦"，本票按用户的新决定改回预热，但不录。
- 调研在 `docs/research/14-voice-capture-latency.md`（另一个 agent 正在写，可能还没提交）：涉及 `track.enabled = false` 时各浏览器会不会关设备、重开有没有延迟，echoCancellation 等处理对启动和开头音频的影响。写出来后参考它；本票先按"流开着、track 保持 enabled、录音器按下才 start"做，因为 disabled 的 track 在部分浏览器上会被关设备、重开又有延迟。
- 36 号票同时在改语音气泡（`ui/conversation/` 下的气泡组件），尽量只动录音那几块，收尾前变基到最新 main。

## Comments

- **结构**：开关时机是状态层纯函数 `state/voice-mic.ts`（`voiceMic`、`voiceMicWanted`、`voiceMicIdleAt`，表格测试）；手势 `state/voice-gesture.ts` 的 `press` 多了 `time`、`warm`：预热命中直接进 `recording`、`startedAt` 是按下的时刻，没命中照旧 `starting`（"准备中"）；原来的 `voiceMicOpen` 改名 `voiceHeld`（只表示"正按着"）。把手势、开关时机、录音、前后台、闲置计时接起来的是 `app/voice-session.ts`（`VoiceSession`），录音 `app/voice-recorder.ts` 拆成 `open`（预热）/ `begin`（同步开录）/ `stop`、`cancel`（只停这一段）/ `close`（停音轨），浏览器的接口经注入，真的接在 `app/voice-browser.ts`。`VoiceInput.tsx` 只剩画和转发 pointer 事件。测试 `test/app/voice-session.test.ts` 用假的 getUserMedia、MediaRecorder、音量分析、前后台和计时器。
- **闲置的定义**（规格没写清，选了偏隐私的）：从最后一次"用到"算起——进语音模式、回到前台、按下、抬手；只是看聊天、滚动不算。按着的时候不算闲置。10 分钟是 `VOICE_MIC_IDLE_MS`。
- **权限**：第一次进语音模式时自动要；被拒（含关掉权限弹窗不选）后这个页面上不再自动要（记在 `voice-browser.ts` 的页面级 `permission`，切后台再回来、切回文字再进语音都不弹，刷新页面才重来），提示照旧，按下是用户自己的动作照样要，要到了恢复预热。没有麦克风、被别的程序占着这类失败也提示，然后先歇着不反复试，等下一次按下、回到前台、重新进语音模式再试。要不到麦克风时按着的这一段随之结束，不会因为"还按着"又要一次。
- **测量**：`startDelayMs` 是 pointerdown 的 `event.timeStamp`（手指落下那一刻，和 `performance.now` 同一起点；看着不像时用当时的 `performance.now`）到 MediaRecorder `start` 事件的毫秒数；`prewarmed` 是按下时流是否已就绪。录音器没报 `start` 时只有 `prewarmed`。协议：`VoicePart.capture`、`VoiceRecord.capture`（可选；收的时候宽松，只取认得的字段，负数、非有限数丢掉，不拒收），消息的 part 里不留。前端协议版本不变（可选字段，向后兼容），没动宿主协议。本机看法：`GET http://127.0.0.1:8810/api/conversations/secretary/messages`（维护者会话换成它的会话 id）响应里的 `voices[].capture`。
- **处理和音轨**：调研 `docs/research/14-voice-capture-latency.md` 写这张票时还没到 main，按 Notes 做：回声消除、降噪、自动增益照旧开着（预热期间它们有时间先收敛），音轨一直 enabled，录音器按下才建、才 start。iOS / Chrome 上没有用户手势时建的 AudioContext 是挂起的，按下时唤醒（只影响面板上的音量，不影响录音）。
- **要留意（没做，留给调研和 36 号票验证）**：麦克风流开着、开着回声消除时，手机浏览器可能把音频切到通话模式（Android Chrome 用通话音量、iOS 音量变小），这会影响 36 号票的 agent 语音自动播放。语音模式期间麦克风一直开着，这个影响比原来"只在按住时开"大。若真机上明显，可选做法：播放 agent 语音时先关麦克风、播完再预热，或按调研结论关掉 echoCancellation。


- 2026-10-08 完成：评审（两轴合并一次）无阻塞项后压缩合并进 main。以后再改：诊断字段类型不对时网关会拒整条消息（应宽松）；被拒标记和 opening 各存了两份；"录不了音"的拼接重复三处。真机待验：语音模式期间开着回声消除，安卓上播放可能走通话音量（见 docs/research/14-voice-capture-latency.md）。
