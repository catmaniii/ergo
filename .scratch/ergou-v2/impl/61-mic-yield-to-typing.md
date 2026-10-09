# 61 — 麦克风让路：打字、分屏时放开，回来再预热；不发空白语音；麦克风诊断记录

Status: done
Blocked by: 44（麦克风不因闲置关闭）
Spec: [第一阶段规格](../spec.md) 第 22 节"麦克风预热"

## What to build

用户 2026-10-09 反馈：语音模式里麦克风一直被二狗占着，在"发起任务"等地方用系统输入法的语音输入时，输入法会提示"麦克风被占用"，观感不好。

调研见 `docs/research/16-voice-mic-hold-vs-instant.md`。

- **原因**：用户打字时，二狗还开着麦克风。
  - Android：Chrome 在前台占着麦克风，系统把输入法录到的声音换成静音。
  - 鸿蒙：华为浏览器的网页录音走通话通路，按"先到先得"拒掉后来的输入法。
  - iOS：系统听写会打断网页的录音，之后可能录不到声音。
- **关掉回声消除不管用**：用户的 Chrome 是 149，要 153 以上才不压别人；鸿蒙不看这个设置。
- **办法**：输入框获得焦点时，真正关掉麦克风。

本票照调研的"方案一"做，并加上诊断记录，方便在真机上看效果。

## Acceptance criteria

- [x] **打字时让路**：页面里任何可输入的元素获得焦点时，立即停掉麦克风的所有音轨，这样系统输入法的语音就能用。可输入的元素包括：二狗自己的文字输入框、发起任务等对话框里的输入框、textarea、contenteditable。
- [x] **焦点回来再预热**：焦点离开输入元素后，如果仍在语音模式、页面在前台，0.5 秒后重新预热（常量可调）。
- [x] **分屏让路**：窗口失去焦点（页面仍可见，比如分屏切到另一边）也算让路；窗口回来后照上一条重新预热。
- [x] **状态层**：以上规则写进 `state/voice-mic.ts` 的纯函数，有表格测试。`app/voice-session.ts` 用假的浏览器接口测：
  - 焦点进出时音轨确实停了、又重新打开；
  - 按住说话的过程中不会因为焦点变化被打断，"按住 说话"本身不是输入元素。
- [x] **不发空白语音（一）：按下时检查**：按下时检查预热的音轨还活着没有（`readyState`、`muted`）。已经失效的，比如被 iOS 听写打断过，当作没预热，重新打开，照旧显示"准备中"。
- [x] **不发空白语音（二）：录完时检查**：录完的一段如果整段是数字静音（全零，或者音量一直低于阈值），不发送，提示"没录到声音，再按一次试试"。
- [x] **诊断记录**：随每条语音一起发给守护进程，存进语音对象的 `capture`，宽松、向后兼容，本机接口取得到。内容：
  - 这次开麦的原因：预热、按下、焦点回来……；
  - 冷启动耗时：`getUserMedia` 从调用到返回的毫秒数；
  - 最近 N 次（比如 10 次）麦克风开关的时刻和原因；
  - 浏览器 UA。

  `docs/dev.md` 写清楚在本机怎么看这些记录。
- [x] **兜底开关保留**：`app/voice-fallbacks.ts` 的两个兜底开关保留，默认值不变。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 调研的"方案二"（用完开着 60 秒、过时就关）要用户取舍，不在本票。用户定了再另开。
- 37、44 号票的代码：`state/voice-mic.ts`、`app/voice-session.ts`、`app/voice-recorder.ts`、`app/voice-browser.ts`。
- 39、43、45 号票同时在改前端，收尾前变基到最新 main。

## Comments

- **结构**：规则都在 `state/voice-mic.ts`（纯函数，表格测试 `test/state/voice-mic.test.ts`）：状态多了 `focused`、`editing`、`returning { until, reason }`，输入多了 `editing`、`focus`（带时刻）和 `tick`；`voiceMicReturnAt` 给出该再看一眼的时刻，`voiceMicOpenReason` / `voiceMicCloseReason` 给出开关的原因，`isTextEntry` 判断拿到焦点的元素算不算可输入的，`voiceTakeSilent` 判断录完的一段是不是静音。`app/voice-session.ts` 盯着焦点（`VoicePage.focused()` / `editing()` / `onFocusChange`）、用 `env.setTimer` 到点送 `tick`；真的浏览器在 `app/voice-browser.ts`（`focusin` / `focusout`、窗口 `blur` / `focus`，外加语音模式里每秒看一眼 `activeElement` 和 `hasFocus()`：对话框关掉、拿着焦点的输入框被移走时浏览器不一定发 `focusout`）。诊断记录是 `app/voice-mic-log.ts` 的 `VoiceMicLog`，一个页面一份。
- **让路和重新预热的规则**：可输入的元素（textarea、文字类 input、contenteditable；只读、禁用的不算；按钮、勾选框、下拉框、日期选择不算）拿到焦点，或者窗口失去系统焦点 → 立即停掉所有音轨、关掉音量分析。焦点离开输入元素、窗口回来 → 等 500 毫秒（`VOICE_MIC_RETURN_DELAY_MS`），这时仍在语音模式、页面在前台、焦点不在输入元素上、窗口有焦点才预热；这期间焦点又进了输入元素就从最后一次离开重新算。按着的时候焦点怎么变都不打断，抬手时还在输入元素里 / 窗口没焦点就放开。**自己定的两条**（规格没写）：按下时（包括焦点正从输入框移到"按住 说话"上、或者在等的 0.5 秒里按下）马上要麦克风、清掉等待，按着时焦点离开输入元素也不再设等待——用户正在用麦克风，没有要护着的输入法，不然抬手后会关了 0.5 秒再开；窗口回来算"回到前台"，打开失败歇着的再试一次（离开输入元素不算）。
- **不发空白语音**：按下时音轨 `readyState` 不是 `live` 或者 `muted` → 放掉、重开（"准备中"，开麦原因 `stale`）。**静音的流只在按下时才重开**：别的时机（回到前台、焦点回来）只在没有活着的流时才开，刚打开就是静音的流（系统层面静音了麦克风）照样能录——不然会开了又开（测试里先写出来是死循环）。录完时：录着的时候每 0.1 秒读一次音量分析，记下最大振幅和读了几次（只算 AudioContext 在跑时读的）；读到 5 次以上（`VOICE_SILENT_MIN_READS`）、整段最大振幅低于 0.001（`VOICE_SILENT_PEAK`，约 −60 dBFS）→ 不发，提示"没录到声音，再按一次试试"。音量分析没在跑（iOS 上可能一直挂着，读到全 0）判断不了，照常发，宁可漏判也不吞掉真语音。**自己加的一条**：判定为静音后放掉这个流、马上重开（开麦原因 `silent`），不然安卓上被压成全零的流下一次按下还是全零，"再按一次"没用。
- **诊断记录**：`capture` 在 `startDelayMs`、`prewarmed` 之外多了 `openReason`、`gumMs`（getUserMedia 从调用到返回）、`peak`（这一段的最大振幅，票里没要，校准静音阈值用）、`micLog`（最近 40 条开关和音轨事件，`atMs` 相对这一段按下，负数在之前，每条带上那一刻的 `hasFocus`、`visibility`；条数的算法见下面"评审后改的"）、`browser`（UA）。整段静音没发出去的那一段记成 `silent`，随下一条语音带上。记录只在页面内存里，刷新就没了。研究 7.1 里的 `inputDelayMs`、`holdMs`、`warmForMs`、`settings`、`variant`、高熵 UA、设置页"麦克风记录"小节、冷启动重排都没做（票没要）。
- **协议**：`VoiceCapture`（存进 `VoiceRecord.capture` 的样子）加了上面几个可选字段和 `VoiceMicLogEntry`，`VOICE_MIC_LOG_MAX`（40）和字符串上限 `VOICE_CAPTURE_TEXT_MAX` 在协议包 `voice.ts`。`VoicePart.capture` 改成收的时候不校验（`Type.Unsafe<VoiceCapture>(Type.Unknown())`），顺带修掉 37 号票评审记下的"诊断字段类型不对时网关会拒整条消息"；守护进程 `voice.ts` 的 `captureOf` 只取认得的、类型对的字段，毫秒数取整、负数丢掉，字符串截断（开麦原因和事件名 32、记录里的原因 64、可见状态 16、UA 512 字，前端、schema、守护进程共用 `VOICE_CAPTURE_TEXT_MAX`），记录里坏掉的条目丢掉、只留最后 40 条。前端协议版本不变（可选字段、更宽松，向后兼容），没动宿主协议，没有录像要重录。
- **本机怎么看**：`GET http://127.0.0.1:8810/api/conversations/secretary/messages`（维护者会话换成它的会话 id）响应里 `voices[].capture`；`docs/dev.md`"麦克风让路、不发空白语音、麦克风诊断记录"一节写了字段、原因的意思、PowerShell 一行命令和真机上预期看到什么。
- **管不到的**（调研 16 已写明）：下拉通知栏、悬浮窗、系统助理浮层里用输入法，页面收不到信号，麦克风仍开着；方案二（用完开着 60 秒）等用户取舍。
- **评审后改的**（2026-10-09）：
  - **诊断记录 20 条 → 40 条**（阻塞项）：票里要"最近 10 次麦克风开关"。一次完整的开关是 open、ready、close 三条，10 次就是 30 条；再给音轨事件（mute、unmute、ended）、没要到（fail）、整段静音（silent）留约 10 条余量，取 40（`VOICE_MIC_LOG_MAX`）。测试：连着进出语音模式 15 次后发一条，记录正好 40 条、含 13 次 close。
  - 开麦、关麦的原因收成联合类型 `VoiceMicOpenReason`、`VoiceMicCloseReason`（`state/voice-mic.ts`），录音器的 `open` / `close` 只收这两种。
  - 规则只写一处：`voiceMicCloseReason(state)` 给出挡着的第一条（该开着时没有），`voiceMicWanted` 就是"没有挡着的"，session 用同一次结果决定开还是关、关的原因。开麦原因改成：本来就该开着却没有流（按下时预热的流失效了、系统收走了）记 `stale`，不然看是哪个输入放行的；session 里原来专门记"按下时失效"的标记去掉了。
  - 字符串上限（32、64、16、512）放进协议包 `VOICE_CAPTURE_TEXT_MAX`，schema、守护进程、前端（UA、记录里的原因和可见状态）共用。
  - 从后台回来时窗口同时触发 focus：页面在后台时不再跟踪窗口焦点（切到后台时当作焦点跟着回来，后台里来的 blur / focus 不算），回到前台立刻预热、原因记 `visible`，不再多等 0.5 秒、记成 `focus`；两种先后（visibilitychange 先到、窗口 focus 先到）都有状态层表格和 session 测试。真的没拿回焦点（分屏），最迟 1 秒的轮询看到后照样让路。
  - 诊断记录每条加了页面信号 `hasFocus`（`document.hasFocus()`）、`visibility`（`document.visibilityState`），守护进程照样宽松整理（类型不对丢掉、超长截断）。
- **真机待验**（这次不改）：
  - 静音判断读的是音量分析（AudioContext + AnalyserNode），不是录音本身。如果某个浏览器上音量分析在跑（`running`）却读不到声音、录音器却录到了，就会把真语音当静音吞掉——iOS 上最可能。真机上看每条语音的 `peak` 和被拦下时记录里的 `silent`；真出现了，改成只认精确的全零，或者从录好的音频里判断。
  - 彻底删除（21 号票的 `voicePurge`）只换掉识别出的文字、分段和失败原因，`capture` 里的 UA 和麦克风开关记录还留在语音对象里；要不要一起清掉，留给用户定。
  - `document.hasFocus()` 在鸿蒙浏览器、原生壳里报得对不对：如果一直报"没焦点"，就不会预热，每次按下都要"准备中"，抬手后记录里有 `close blur`、`hasFocus: false`。
  - 输入法的语音还报不报"麦克风被占用"、0.5 秒够不够、静音阈值准不准（调研 16 第 7.3 节的步骤）。

- 2026-10-09 完成：两轴评审后诊断记录改留 40 条（至少 10 次完整开关）、开关原因收成联合类型、从后台回来立刻预热等；变基到 43、53 号票之后全量通过，压缩合并进 main。真机待验见上。
