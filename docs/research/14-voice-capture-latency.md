# 按住说话的录音启动延迟：开头为什么被吞、别人怎么做、怎么补

用户在手机上实测"按住 说话"：按下的同时念"ABCDEFGHIJKRLN"，识别结果只有"FGHIJKRLN"，开头大约 0.5–1.5 秒没了。本文回答三个问题：别人怎么做；我们这里为什么有启动时间；怎样做到按下就开录、不丢开头。

用户事先否掉了三种做法：(a) 进入语音模式就一直开着麦克风；(b) 按住才开麦，用完再多开一会儿；(c) 保持现状，只加一个"就绪"提示。2026-10-08 用户又定了方向："**提前加载麦克风，但不记录**"，即进入语音模式就打开麦克风流，MediaRecorder 等按下才启动，已经开成 37 号票（`.scratch/ergou-v2/impl/37-mic-prewarm.md`）。所以本文除了回答三个问题，也给 37 号票补实现细节：指示灯、`track.enabled`、音频处理、MediaRecorder 首块数据、预录缓冲算不算"记录"。

资料截至 2026-10-08，访问日期都是这一天。尽量只用一手来源：W3C / WHATWG 规范，Chromium、WebRTC、WebKit、Firefox 的源码和 bug，Android / Apple / 华为官方文档，开源项目源码（GitHub 链接都钉在具体 commit 上）。查不到一手资料的写"未找到"；从源码推出来、没有实测的标【推断】；只有第三方来源的标【未核实】。

## 0. 结论速览

1. **被吞的那段 = 从按下到 MediaRecorder 真正挂上音轨的时间**。现在按下后要依次等三件事：
   - `getUserMedia` 打开麦克风。Chromium 要等采集真正启动（`OnCaptureStarted`）才 resolve，之前说的话物理上没有被采到。Android Chrome 上只要开着回声消除，打开设备时还会把系统切到通话模式（`MODE_IN_COMMUNICATION`）。
   - `new AudioContext()`。构造时可能在主线程上同步等输出设备信息。
   - `new MediaRecorder(...).start()`。只录 `start()` 之后的数据。

   三段加起来，手机上几百毫秒到一秒多。公开数据：Chrome 已授权时打开摄像头加麦克风，80% 在 1 s 内、95% 在 2 s 内（S38）。
2. **别人怎么做**：
   - 网页端的语音消息（Telegram Web K/A、Element、Signal Desktop、Rocket.Chat、WhatsApp Web、Slack）全是"点一下开始、点一下结束"，都是点击时才 `getUserMedia`。它们不预录，也不让麦克风常开，靠的是"管线就绪后才显示录音中，用户看到再开口"，再加上预热不涉及麦克风的部分（AudioContext、编码器）。
   - 一直开着麦克风的只有实时语音类：Jitsi 和 Discord 的按键说话（push-to-talk）是流常开、按键只切静音或发送，Discord 文档说按键说话 "relatively no delay"。语音活动检测和智能音箱则是麦克风常开，再加一段预录。
3. **原生 App 并没有预热麦克风**。Telegram、Signal 在 Android 和 iOS 上都是按下后才建录音器，Telegram 还故意等 50–190 ms。原生快，是因为系统录音路径短：Android 兼容性定义（CDD）规定冷启动输入延迟 MUST ≤500 ms、强烈建议 ≤100 ms。剩下的那一点延迟，用振动和动画遮住了。微信和 WhatsApp 闭源，未找到一手资料。
4. **网页上没有"设备热着、但指示灯不亮"的办法**。`track.enabled = false` 在 Chrome 和 Safari 上都不关设备、不灭灯，只把送出去的声音换成静音。华为浏览器的 ArkWeb 内核和 Chrome 共用 Blink 层，设备应当也不关【推断】，指示灯要真机看。规范对这一点只写了 MAY / SHOULD。Firefox 桌面版只对摄像头默认关设备，麦克风自 Fx85 起默认也不关。所以只要想按下就开录，语音模式期间指示灯就一定亮着：Chrome 地址栏图标、Android 常驻通知、系统隐私点。
5. **37 号票的方向（预热流、track 保持 enabled、按下才 start）可行**：
   - 流开着的前提下，MediaRecorder 在 `start()` 里同步挂上接收端，之后的数据不会丢。
   - Android Chrome 上，自动增益是固定 6 dB，没有增益爬升；降噪的启动期只在流刚打开时有一次。所以预热之后，开头不会被增益或降噪削弱。
   - 最大的副作用是 **Android Chrome 开着回声消除时，整个语音模式都处于通话模式**，页面播放的声音走通话音量和通话路由（华为浏览器是否一样要实测）。iOS 上捕获期间其他声音会变小（WebKit bug 236219）。这会影响语音气泡播放（36 号票）和语音回复（32 号票），要实测；建议把 `echoCancellation: false` 作为 A/B 验证项。
6. **预录缓冲（按下前 200–300 ms）可以做，但要如实告诉用户**：
   - 它只在内存里滚动，新数据覆盖旧数据，不落地、不上传，没按下就永远不离开内存。按 Alexa、Google Assistant 公开的口径，这不叫"录音 / 保存"。
   - 但按下之后，按下前那 0.2–0.3 秒会成为这条语音的开头，跟着上传和识别。这一点必须说清楚，交给用户决定。
   - 建议先上推荐一，加上打点，实测还缺头再加。
7. **先确认是"录音缺头"还是"识别吞字"**：回放那条语音，听开头是不是从 F 开始。识别用的 faster-whisper 开了 VAD，但它会在每段语音两边各补 400 ms（S45），不太可能是它切掉的。第 9 节给出在用户手机上分段计时的办法。

## 1. 来源

| # | 资料 | URL | 用来说明 |
|---|---|---|---|
| S1 | W3C Media Capture and Streams，§4.3.1.2 Life-cycle、§15 隐私指示 | https://www.w3.org/TR/mediacapture-streams/#life-cycle ；https://www.w3.org/TR/mediacapture-streams/#privacy-indicator-requirements | disabled / muted 时设备与指示灯的 MAY / SHOULD |
| S2 | mediacapture-main issue #642（提议把 MAY 改成 MUST，未改） | https://github.com/w3c/mediacapture-main/issues/642 | 同上 |
| S3 | W3C MediaStream Recording，`start()` 算法 | https://w3c.github.io/mediacapture-record/#dom-mediarecorder-start | 只录 start 之后的数据，start 事件何时触发 |
| S4 | W3C Web Audio API（createDelay、sticky activation、render quantum） | https://webaudio.github.io/web-audio-api/ | DelayNode 上限、AudioContext 何时允许启动 |
| S5 | WHATWG HTML，activation-triggering input event | https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event | 触屏的 pointerdown 不算用户激活 |
| S6 | W3C Event Timing | https://w3c.github.io/event-timing/ | `event.timeStamp` 估计物理输入时刻 |
| S7 | W3C Media Session，`setMicrophoneActive` | https://w3c.github.io/mediasession/#dom-mediasession-setmicrophoneactive | 页面请求浏览器把麦克风静音 |
| S8 | Chrome 自动播放策略 | https://developer.chrome.com/blog/autoplay | 用户手势之前 AudioContext 是 suspended |
| S9 | Chrome 一次性权限（桌面 Chrome 116）；Google 博客 2024-09-12（Android 也有了） | https://developer.chrome.com/blog/one-time-permissions ；https://blog.google/products-and-platforms/products/chrome/google-chrome-safety-update-september-2024/ | "仅这一次允许" |
| S10 | Chromium `audio_manager_android.cc` | https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/audio_manager_android.cc | 有处理效果就切 `MODE_IN_COMMUNICATION` |
| S11 | Chromium `aaudio_stream_wrapper.cc`、`aaudio_input.cc` | https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/aaudio_stream_wrapper.cc ；https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/aaudio_input.cc | 开回声消除用 VOICE_COMMUNICATION 预设，否则用 GENERIC；蓝牙要先拉起 SCO |
| S12 | Chromium `AudioManagerAndroid.java`；Android `AudioManager.setMode` 文档 | https://chromium.googlesource.com/chromium/src/+/main/media/base/android/java/src/org/chromium/media/AudioManagerAndroid.java ；https://developer.android.com/reference/android/media/AudioManager | 通话模式的含义（路由、音量、电话层） |
| S13 | Chromium `media/webrtc/helpers.cc` | https://chromium.googlesource.com/chromium/src/+/main/media/webrtc/helpers.cc | Android / iOS 上 AGC2 固定 6 dB，关闭自适应 |
| S14 | WebRTC `ns_common.h` | https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/ns/ns_common.h | 降噪启动期 50 / 200 块（每块 10 ms） |
| S15 | Chromium `processed_local_audio_source.cc`、`audio_input_device.cc` | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/processed_local_audio_source.cc ；https://chromium.googlesource.com/chromium/src/+/main/media/audio/audio_input_device.cc | getUserMedia 等采集启动成功才 resolve |
| S16 | Chromium `media_stream_audio_track.cc` | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/mediastream/media_stream_audio_track.cc | disabled 时照样流过静音帧 |
| S17 | Chromium `media_stream_capture_indicator.cc`、`MediaCaptureNotificationServiceImpl.java` | https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/media/webrtc/media_stream_capture_indicator.cc ；https://chromium.googlesource.com/chromium/src/+/main/chrome/android/java/src/org/chromium/chrome/browser/media/MediaCaptureNotificationServiceImpl.java | 指示灯和 Android 常驻通知按"设备开着"算，不看 enabled |
| S18 | crbug 642785 "Disabling stream should turn off camera"（2016 年提交，至今未修） | https://issues.chromium.org/40482980 | Chrome 连摄像头都没做"disabled 就关设备" |
| S19 | Chromium `audio_track_recorder.cc`、`media_recorder.cc` | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediarecorder/ | start 时同步挂接收端；start 事件在第一次写出数据时才发 |
| S20 | Chromium `renderer_webaudiodevice_impl.cc`、`media/base/audio_renderer_sink.h` | https://chromium.googlesource.com/chromium/src/+/main/content/renderer/media/renderer_webaudiodevice_impl.cc ；https://chromium.googlesource.com/chromium/src/+/main/media/base/audio_renderer_sink.h | AudioContext 构造时 `GetOutputDeviceInfo()` "may block" |
| S21 | Chromium `user_media_processor.cc` | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/user_media_processor.cc | 同一设备再次 getUserMedia 复用已开的 source |
| S22 | WebKit bug 247752 "[MediaStream] Stop capture when a media stream track is disabled"（ASSIGNED，2022-11 起无补丁） | https://bugs.webkit.org/show_bug.cgi?id=247752 | Safari disabled 时不停采集 |
| S23 | WebKit bug 236219 "[iOS] Volume of non MediaStreamTrack-based audio reduces when capturing microphone"（NEW，2026-03 评论称 iOS 26.4 仍在） | https://bugs.webkit.org/show_bug.cgi?id=236219 | iOS 开麦期间页面其他声音变小 |
| S24 | Firefox `all.js` 的 `off_while_disabled` 偏好；bug 1674283（Fx85 起麦克风 disabled 不关设备） | https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/all.js ；https://bugzilla.mozilla.org/show_bug.cgi?id=1674283 ；https://blog.mozilla.org/webrtc/better-privacy-on-camera-mute-in-firefox-60/ | Firefox 的做法和代价 |
| S25 | Android CDD 5.6 Audio Latency | https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/main/5_multimedia/5_6_audio-latency.md | "lost input"、冷启动输入延迟 ≤500 ms（MUST）/ ≤100 ms（SR） |
| S26 | AOSP Privacy indicators；Android 权限说明 | https://source.android.com/docs/core/permissions/privacy-indicators ；https://developer.android.com/training/permissions/explaining-access | Android 12+ 绿点 |
| S27 | Apple：橙点说明 HT211876；`AVAudioRecorder.prepareToRecord`；Audio Session 编程指南 | https://support.apple.com/HT211876 ；https://developer.apple.com/documentation/avfaudio/avaudiorecorder/preparetorecord() ；https://developer.apple.com/library/archive/documentation/Audio/Conceptual/AudioSessionProgrammingGuide/ConfiguringanAudioSession/ConfiguringanAudioSession.html | iOS 指示与原生做法 |
| S28 | OpenHarmony 文档：ArkWeb 内核版本；《在 Web 中打开摄像头和麦克风》 | https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-component-overview.md ；https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-rtc.md | 鸿蒙 6.0 / 6.1 是 Chromium M132；网页麦克风权限链 |
| S29 | 华为支持：查看和管理隐私设置（EMUI 13 / HarmonyOS 3）；中文页"通过隐私灯了解权限使用" | https://consumer.huawei.com/uk/support/content/en-gb15919093 ；https://consumer.huawei.com/cn/support/content/zh-cn16070780/ | 华为状态栏的麦克风提示 |
| S30 | 机型：苏宁 VYG-AL00 商品页；DeviceAtlas HOP-AL00 | https://www.suning.com/sellers/12451014607.html ；https://deviceatlas.com/device-data/devices/huawei/hop-al00/95182424 | 用户的两台手机【未核实，第三方】 |
| S31 | Telegram Web K（tweb） | https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/helpers/voiceRecorder/nativeVoiceRecorder.ts | 网页端录音实现 |
| S32 | Telegram Web A（telegram-tt） | https://github.com/Ajaxy/telegram-tt/blob/28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/src/util/voiceRecording/nativeVoiceRecorder.ts | 同上 |
| S33 | opus-recorder | https://github.com/chris-rudmin/opus-recorder/blob/87e0145fcf1525fad0d3729628cdbc958370001d/src/recorder.js | 同上（已停止维护） |
| S34 | Element Web `VoiceRecording.ts` | https://github.com/element-hq/element-web/blob/263a2b56d933711bd0c35637c79bee51f157e110/apps/web/src/audio/VoiceRecording.ts | 同上 |
| S35 | Signal Desktop `audioRecorder.dom.ts`、`AudioCapture.dom.tsx` | https://github.com/signalapp/Signal-Desktop/blob/5c1a030485ea64a1c311288cd6b5eecbe36964cd/ts/services/audioRecorder.dom.ts | 鼠标悬停就预热 AudioContext 和编码器，不预热麦克风 |
| S36 | Rocket.Chat `AudioRecorder.ts` | https://github.com/RocketChat/Rocket.Chat/blob/ce4fb3fae98486e0a746de8dc0c5f95935d61b9b/apps/meteor/client/lib/AudioRecorder.ts | 同上 |
| S37 | vad-web `frame-processor.ts`、`real-time-vad.ts` | https://github.com/ricky0123/vad/blob/2e5aca93e3902f04ff5b7eb4a9633926cdca9cf6/packages/web/src/frame-processor.ts | 业界的预录（preSpeechPadMs，默认 800 ms） |
| S38 | addpipe：Chrome 约 10 万次 getUserMedia 的耗时统计（2019-05，2026-05 更新） | https://blog.addpipe.com/camera-microphone-initialization-times/ | 启动耗时量级 |
| S39 | Jitsi Meet 按空格说话；lib-jitsi-meet `JitsiLocalTrack.ts` | https://github.com/jitsi/jitsi-meet/blob/6e371fb23a5d65eec0055e79d0858d56ce70c796/react/features/keyboard-shortcuts/actions.ts ；https://github.com/jitsi/lib-jitsi-meet/blob/979e15e7a00d9c66b720eb759f5f7341915de5fc/modules/RTC/JitsiLocalTrack.ts | 流常开，按键切 `track.enabled` |
| S40 | Discord 帮助：Push to Talk | https://support.discord.com/hc/en-us/articles/211376518 | "relatively no delay" |
| S41 | WhatsApp Web FAQ（只拿到搜索摘要）；Slack clips 帮助 | https://faq.whatsapp.com/web/chats/how-to-send-voice-messages ；https://slack.com/help/articles/4406235165587 | 网页端都是点按式 |
| S42 | Telegram Android `ChatActivityEnterView.java`、`MediaController.java` | https://github.com/DrKLO/Telegram/blob/f2908b14133bbffbf7ab04f641ecb5bfaf533242/TMessagesProj/src/main/java/org/telegram/messenger/MediaController.java | 原生端按下后才建录音器 |
| S43 | Telegram iOS `ManagedAudioRecorder.swift`、`ManagedAudioSession.swift`、录音按钮 | https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/TelegramUI/Sources/ManagedAudioRecorder.swift | 同上 |
| S44 | Signal Android `AudioRecorder.java`；Signal iOS `VoiceMessageInProgressDraft.swift` | https://github.com/signalapp/Signal-Android/blob/ac1d5938947be53577de6052db55e2c35c41b85a/app/src/main/java/org/thoughtcrime/securesms/audio/AudioRecorder.java ；https://github.com/signalapp/Signal-iOS/blob/861588c92e427de1f0ffd0d3ac013c29d8d5f0c4/Signal/ConversationView/VoiceMessage/VoiceMessageInProgressDraft.swift | 同上 |
| S45 | faster-whisper `vad.py`（`speech_pad_ms = 400`） | https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/vad.py | 识别端 VAD 不会切掉开头 |
| S46 | Amazon：Alexa, Echo Devices, and Your Privacy（amazon.com 帮助页 GVP69FUJ48X9DK8V 的镜像） | https://digprjsurvey.amazon.com/csad/help/node/GVP69FUJ48X9DK8V | 智能音箱的预录口径 |
| S47 | Google：How Google Assistant is designed for your privacy | https://support.google.com/assistant/answer/11091714?hl=en | 同上 |
| S48 | MDN browser-compat-data：`AudioEncoder`、`MediaSession` | https://github.com/mdn/browser-compat-data/blob/main/api/AudioEncoder.json ；https://github.com/mdn/browser-compat-data/blob/main/api/MediaSession.json | 兼容性 |

## 2. 现状代码的时间线

`VoiceInput.tsx` 在 `onPointerDown` 里同步调 `apply({kind:"press"})`。状态机给出 `start` 这个动作后，`VoiceRecorder.start()` 也同步调用了 `getUserMedia`。按钮设了 `touch-action: none`（`styles/voice.css`），没有长按判定，所以从手指接触到调用 `getUserMedia` 之间没有多余延迟。之后的顺序如下：

| 步骤 | 代码位置 | 这段时间说的话 |
|---|---|---|
| 手指接触 → `pointerdown` 处理函数开始跑 | 浏览器输入管线 | 丢（这段通常是几十毫秒，可以用 `e.timeStamp` 测，见第 9 节） |
| `getUserMedia(...)` 到 resolve | `voice-recorder.ts` `start()` | **丢**：采集启动成功后才 resolve（S15），之前设备还没开 |
| `new AudioContext()`、接分析器 | 同上 | **丢**：MediaRecorder 还没建 |
| `new MediaRecorder(stream)`、`start(250)` | 同上 | 从这里开始录（S3、S19） |
| `ready` → 面板从"准备中"变成计时 | `VoiceInput.tsx` → `voice-gesture.ts` | 已在录 |

所以清单里的"把 `getUserMedia` 放在 `pointerdown` 里"和"手指一碰就开始、不等长按判定"，现状已经做到了，再改也省不出时间。

另外，现在气泡上的时长 `durationMs` 是从 `ready` 算起的，不是从按下算起。拿它来估计"缺了多少"会把缺的那段漏掉，见第 9 节。

## 3. 启动时间从哪来

### 3.1 `getUserMedia`：打开设备，等采集真正开始

Chromium（Android Chrome、华为浏览器的 ArkWeb 都是这个内核）里，音频 `getUserMedia` 的 Promise 要等 `ProcessedLocalAudioSource::OnCaptureStarted()` 才 resolve。触发它的是 `AudioInputDevice` 收到浏览器侧"采集初始化成功、IPC 通道建好"的通知，源码注释原文是 "Indicate that browser side capture initialization has succeeded and IPC channel initialized"（S15）。也就是说，**resolve 之前设备还没在采，这段时间说的话从物理上就没被录到**，不是录到后被丢掉的。

Android Chrome 打开输入设备时还要做这些事（S10、S11、S12）：

- **切通话模式**：只要输入流带处理效果（`params.effects() != NO_EFFECTS`），就调 `SetCommunicationAudioModeOn(true)`，即 `AudioManager.setMode(MODE_IN_COMMUNICATION)`。源码注释原文："By default, the audio manager for Android creates streams intended for real-time VoIP sessions and therefore sets the audio mode to MODE_IN_COMMUNICATION"。Android 文档说 setMode "encompasses audio routing, volume management AND the behavior of the telephony layer"。
- **选音源预设**：系统报告有硬件回声消除（`AcousticEchoCanceler.isAvailable()`）、且页面要了 `echoCancellation` 时，效果里带 `ECHO_CANCELLER`，AAudio 用 `AAUDIO_INPUT_PRESET_VOICE_COMMUNICATION`；否则用 `GENERIC`。Chromium 从不用 `UNPROCESSED`，注释说没有自动增益时 "results in quiet, sometimes silent, streams"。
- **蓝牙**：连着蓝牙耳机时，开流前要先把 SCO 拉起来（`aaudio_input.cc`："The Android framework requires SCO to be active before the stream is started"）。
- **打开 AAudio 流**：Android CDD 定义了 "lost input: The initial portion of an input signal that is unusable or unavailable" 和"冷启动输入延迟"（lost input 加上第一帧的延迟），要求 MUST ≤500 ms、强烈建议 ≤100 ms（S25）。

切通话模式本身要多久，**未找到一手测量**。也没找到"Android 上开头几百毫秒是静音"的 crbug。

公开测量（S38）：Chrome、已授权、摄像头和麦克风一起，约 10 万次调用，从调用到 resolve，80% <1 s，95% <2 s。没有按纯音频或手机拆分。

### 3.2 回声消除、降噪、自动增益对启动和开头的影响

- **回声消除（AEC）**：决定要不要切通话模式、用哪个音源预设（见 3.1）。关掉之后（`echoCancellation: false`），效果是 `NO_EFFECTS`，不切模式，用 GENERIC 预设【推断：按源码分支推出，没有实测启动快多少】。
- **自动增益（AGC）**：Android / iOS 上 Chromium 关掉 AGC1，AGC2 是固定数字增益 `fixed_digital.gain_db = 6.0f`，`adaptive_digital.enabled = false`（S13）。**没有增益爬升**，第一帧就是满增益。桌面平台才用自适应 AGC2。ArkWeb 自己的配置分支没有公开（`helpers.cc` 里其他平台会走 `#error`，说明 ArkWeb 打了自己的补丁），未找到。
- **降噪（NS）**：WebRTC 降噪有启动期，`kShortStartupPhaseBlocks = 50`、`kLongStartupPhaseBlocks = 200`（每块 10 ms，即约 0.5 s 和 2 s），期间用简化的噪声模型（S14）。启动期从处理模块创建时（打开流时）算起，不是每次录音重新算。启动期会不会把开头的语音压掉，**未找到 bug 依据**。
- **厂商硬件 AEC / NS 的收敛期**：未找到一手资料。

### 3.3 `AudioContext`

- 构造时，如果允许自动播放就直接开始渲染。`RendererWebAudioDeviceImpl` 构造时调 `GetSinkOutputDeviceInfo()`，接口注释原文："If the information is not available yet, this method may block until it becomes available"（S20）。也就是说，**它可能在主线程上同步等输出设备**。现在的代码先 `new AudioContext()` 再 `start` MediaRecorder，这段等待直接算进开头丢失。具体耗时未找到测量数据。
- 自动播放策略：用户和页面交互之前创建的 AudioContext 是 `suspended`（S8）。规范允许 UA "to allow it only when the AudioContext's relevant global object has sticky activation"（S4）。注意，**触屏的 `pointerdown` 不算激活事件**：HTML 规范只把 `pointerType` 为 mouse 的 pointerdown、非 mouse 的 `pointerup`、`touchend` 等算作激活（S5）。只要用户之前在页面上点过任何东西（比如点"切到语音"），sticky activation 就已经有了；如果页面刷新后直接恢复成语音模式、还没点过任何东西，第一次按下时 AudioContext 起不来。

### 3.4 `MediaRecorder.start()` 到第一块数据

- 规范：`start()` 把状态设为 recording，然后 "in parallel" 地 "Start recording all tracks…"（S3）。`start` 之前的音频不在录音范围内。
- Chromium：`start()` 里同步创建 `AudioTrackRecorder`，构造函数直接 `AddSink`。数据从下一个采集缓冲开始，没有预缓冲。编码器初始化和数据处理在同一个任务序列上按顺序排队，**代码上看不出会丢帧**（S19）。
- **`start` 事件来得晚**：它在 muxer 第一次写出数据时才触发（`MaybeEmitStartEvent`），比真正开始收音晚。不要拿它当开录时刻，应以调用 `start()` 的时刻为准。
- 没找到"MediaRecorder 开头丢 N 毫秒"的 crbug。WebKit 有两个相关 bug：281406（WebM 录制时，第一个音频帧之前的视频帧被丢，2024-10 已修复，只影响视频）；281958（编码器固定缓冲 0.1 s，这是延迟，不是丢失）。
- 开头那一块含容器头，之后的块不能单独解码。只有整段拼起来才保证能播放（S3）。所以"MediaRecorder 一直开着、只保留最近几块"这种做法不成立。

### 3.5 第一次调用和之后再调用；权限

- 同一设备的 source 还活着时，再次 `getUserMedia` 直接复用，不重开设备，也不重建处理模块（S21，`user_media_processor.cc` 注释 "The only return point for non-pending sources"）。之前的 track 已经 `stop()` 的，会重开设备、重建处理模块，再切一次通话模式。**现在每次抬手都 `stop()`，所以每次按下都是冷启动。**
- `track.clone()` 共用同一个 source，不开新设备（S1）。
- 权限：
  - Chrome 116 起，桌面版有"仅这一次允许"（S9）。2024-09-12 的 Google 博客说 Android 也有了，原文 "One-time permissions for Chrome on Android and Desktop"，具体版本号官方没写。选了"仅这一次"，每次访问都会弹框。弹框期间的耗时取决于用户点击，**弹框那一次开头必丢**。
  - 鸿蒙：浏览器应用要先有系统的 `ohos.permission.MICROPHONE`。系统授权框有"始终允许 / 每次使用时询问"，网页请求再经 `onPermissionRequest` 交给浏览器自己决定（S28）。华为浏览器对网页是否每次都问，未找到资料。
  - 预热把弹框挪到"进入语音模式"那一刻，按下时就不会再弹，这本身也是好处。

### 3.6 iOS Safari

- 只要有活动的采集源，WebKit 就把音频会话设成 PlayAndRecord。判断函数 `wantsToCaptureAudio()` 不看 `enabled`。
- 原生端的 Telegram iOS 会把 `AVAudioSession.setActive(true)` 的耗时写进日志（S43），说明这一步要专门盯；苹果也没有给出数字（S27）。
- iOS 开麦期间，页面里不走 MediaStreamTrack 的声音（`<audio>`、WebAudio）会变小，WebKit bug 236219 至今未修（S23）。

### 3.7 用户的手机：鸿蒙 6，浏览器基本是 ArkWeb

- **机型**【未核实，第三方】：
  - VYG-AL00：苏宁商品页写的上市日期是 2025-11-25，系统 HarmonyOS（S30）。另一份调研说它是 Mate 80、首发 HarmonyOS 6。
  - HOP-AL00：DeviceAtlas 标为 Pura X Max（S30），苏宁页写 2026-04-20 上市；另一份调研说它首发 HarmonyOS 6.1。
- 两台都不是安卓兼容系统，浏览器基本可以确定是华为浏览器（ArkWeb 内核）。只有通过卓易通这类兼容容器才可能用上 Android Chrome。
- ArkWeb 内核版本：OpenHarmony 6.0 默认 M132（可选 M114），6.1 是 M132（S28）。所以 Blink 层（`getUserMedia`、`MediaRecorder`、`AudioContext`、`track.enabled` 的语义）和 Chrome 是同一套代码。但音频设备层走鸿蒙的 `AudioCapturer`，**第 3.1 节的 Android 通话模式、AAudio 预设不能直接套用**。ArkWeb 的采集适配器（`audio_capturer_adapter_impl.cpp`）支持 MIC / VOICE_RECOGNITION / VOICE_COMMUNICATION 几种音源，映射不到时默认用 VOICE_RECOGNITION；网页 `getUserMedia` 实际选哪种，未找到。
- **结论：用户手机上到底哪一段慢，只能实测**（第 9 节）。

### 3.8 小结

| 段 | 现在在按下路径上吗 | 量级 | 依据 |
|---|---|---|---|
| 触摸 → pointerdown 处理函数 | 在 | 几十毫秒，主线程忙时更长 | S6（可测） |
| getUserMedia：权限、开设备、切通话模式 / 蓝牙 SCO、建处理模块 | 在 | 几百毫秒到 1 s 以上；已授权的摄像头加麦克风 80% <1 s（S38） | S10–S12、S15、S25 |
| new AudioContext（可能同步等输出设备） | 在 | 未找到测量 | S20 |
| new MediaRecorder + start | 在 | 没有设备 I/O，应很短【推断】 | S19 |
| 弹权限框（"每次询问"或"仅这一次"） | 有时在 | 取决于用户 | S9、S28 |

## 4. 别人怎么做

### 4.1 网页端语音消息：全是点按式，点击时才开麦

| 产品 | 交互 | 何时 getUserMedia | 录音管线 | 预热 | 预录 | 录完 |
|---|---|---|---|---|---|---|
| Telegram Web K（S31） | 点一下开始，再点发送 | `start()` 里 | AudioWorklet 取 PCM → WebCodecs `AudioEncoder('opus')` → 自写 OGG；不用 MediaRecorder | 主路径没有；回退的 opus-recorder 在输入框构造时预建 | 无 | `track.stop()` 并关 AudioContext |
| Telegram Web A（S32） | 点一下开始，点一下发送 | `start()` 里 | 同 K 版的 WebCodecs 方案 | 回退路径在 Safari 上组件挂载时 `init()` | 无 | `track.stop()` |
| Element Web（S34） | 点按 | `start()` 里 | getUserMedia → AudioContext → worklet（计时和波形）→ opus-recorder | 无 | 无 | `track.stop()` |
| Signal Desktop（S35） | 点按 | 点击后 | AudioWorklet 里跑 lame 编 MP3 | **鼠标悬停或按钮获得焦点就 `warmup()`**：建全局 AudioContext，加载编码 worklet；不碰麦克风 | 无 | `track.stop()`，注释 "terminates microphone access" |
| Rocket.Chat（S36） | 点按 | 组件挂载就 start | ScriptProcessor + Worker 编 MP3 | 无 | 无 | `track.stop()` |
| WhatsApp Web、Slack clips（S41） | 点麦克风开始，点 ✓ 结束 | 闭源，未找到一手资料 | — | — | — | — |
| Google 翻译网页版 | 闭源，未找到一手资料 | — | — | — | — | — |

共同点：

- "录音中"的界面和计时都等 `start()` resolve 之后才出现（Telegram 两版、Element、Signal、Rocket.Chat 都是），用户看到提示才开口。Telegram Web K 还把短于 500 ms 的录音当误触丢掉。
- **没有一家在网页上做按住说话，没有一家让麦克风在不录的时候开着，也没有一家做预录。** 它们之所以不丢开头，靠的是点按式交互里"先看到提示、再说话"。这正是用户否掉的 (c)。
- 主流是 AudioWorklet 加自带编码器，选它是为了编码格式（统一出 Opus/OGG 或 MP3），不是为了启动快。

### 4.2 实时语音的按键说话：流常开，按键只切静音

- **Jitsi Meet**（S39）：流一直开着，按空格时 `muteAudio(false)`，松开 50 ms 后 `muteAudio(true)`。音频轨的静音实现就是 `track.enabled = !muted`。注释提到：如果按下时还没有音轨就得新建，所以把操作串成 Promise 链，免得松手先于建轨到达。
- **Discord**（S40）：PTT 是按住专用键才发送声音；"Release Delay" 控制松键后多久才切断。原文："Unlike Voice Activity, Push to Talk has relatively no delay when you push the button"。浏览器版 PTT 只在窗口有焦点时可用。帮助文档没说麦克风是否一直开着。工程博客说客户端会读原始音频做语音检测，静音期间不发数据【推断：一直采集、在发送端把关】。
- 共同点：这类产品的麦克风在整个通话期间都开着，指示灯常亮。"按下零延迟"就是靠这个换来的。

### 4.3 麦克风常开再加预录：语音活动检测、智能音箱

- **vad-web**（S37）：每一帧都推进缓冲；没在说话时只保留最近 `preSpeechPadMs` 的帧（环形缓冲），判定开始说话后就不再裁剪，语音段结束时连同前面的缓冲一起交出。当前默认 `preSpeechPadMs = 800`（每帧 32 ms，约 25 帧）；旧版按帧数配置，约 96 ms。前提是麦克风一直开着。
- **Amazon Alexa**（S46）："No audio is stored or sent to the cloud unless the device detects the wake word"；检测到之后，"the audio stream includes a fraction of a second of audio before the wake word"。
- **Google Assistant**（S47）："In standby mode, the device processes short snippets of audio (a few seconds) to detect an activation… If no activation is detected, then those audio snippets won't be sent or saved to Google."

### 4.4 原生 App：没有预热，靠系统路径短，再用反馈遮一下

| App | 按下后做什么 | 预热了什么 | 来源 |
|---|---|---|---|
| Telegram Android | 能切换成圆形视频时先等 150 ms，区分点按和按住；`startRecording` 申请音频焦点、振动，再把启动任务排到录音线程，**延迟 50 ms** 执行（正在播放语音时 500 ms）；任务里打开文件、建 opus 编码器、`new AudioRecord`、`startRecording()` | 只有一条高优先级录音线程和几块缓冲区；没有预建 AudioRecord，没有预录 | S42 |
| Telegram iOS | 按下后开 0.19 s 计时器区分点按和按住；之后申请录音会话，激活后的回调里才建 RemoteIO AudioUnit 并启动；`setActive(true)` 的耗时写进日志 | 只预备了振动反馈；录完录音会话立即关闭 | S43 |
| Signal Android | 按下立即震动 20 ms，在提前建好的线程上建 MediaRecorder → prepare → start | 只有线程 | S44 |
| Signal iOS | 长按最短时长设为 0，主线程同步设置会话类别 → 新建 `AVAudioRecorder` → `prepareToRecord` → `record` | 无 | S44 |
| 微信、WhatsApp | 闭源，未找到一手资料。只有 Bitdefender 2023-05 对 WhatsApp Android 的第三方分析，结论是只在显示录音界面时才触发麦克风 | — | — |

原生几乎没有启动时间，原因有三：

1. **系统路径短**：Android 冷启动输入延迟 MUST ≤500 ms、强烈建议 ≤100 ms（S25）。权限早就授了，没有页面和浏览器进程之间的协商，也不用切通话模式（这些 App 用的不是 VoIP 音源）。
2. **一启动就收音**，之后不丢。
3. **剩下的延迟被反馈遮住**：振动加录音动画，用户通常在反馈出现后才开口。Telegram 甚至主动等了 50–190 ms。
   苹果的设计指南也是这个思路：录音类会话"只在录音时激活"，`prepareToRecord` 是为了"start recording as quickly as possible upon calling record()"（S27）。

**对我们的启示**：原生快靠的是路径短，不是预热。网页的 `getUserMedia` 路径做不短，所以只有两条路：要么把这段路提前走完（预热），要么让用户等提示再说（点按式、显示"准备中"）。后者用户已经否掉。

## 5. 技术手段逐项评估

| 手段 | 能省多少 | 隐私表现（指示灯 / 系统提示） | 兼容性 | 结论 |
|---|---|---|---|---|
| 把 `getUserMedia` 放进 `pointerdown`；手指一碰就开始、不等长按判定 | 0（现状已经这么做） | 不变 | 全部 | 已做到 |
| 用 `touchstart` 代替 `pointerdown` | 约 0：设了 `touch-action: none` 时两者几乎同时触发；两种都不算用户激活（S5） | 不变 | 全部 | 不必改 |
| 按下路径上先 start MediaRecorder，AudioContext 和分析器放到之后（冷启动时） | 省掉 AudioContext 构造的同步等待（S20），具体多少未测 | 不变 | 全部 | **冷启动路径应该改** |
| 关掉回声消除（`echoCancellation: false`） | Android Chrome 不再切通话模式【推断】，省多少未测；ArkWeb 未知 | 不变 | 约束是标准的，各平台的具体效果不同 | **建议 A/B 实测**，顺带消除预热期间的通话模式副作用（6.5） |
| 关掉降噪 / 自动增益 | Android 上它们是软件处理，不影响开设备（S11、S13）；省的只是建处理模块的一点时间【推断】 | 不变 | — | 不建议为启动速度关；识别效果另说 |
| **预热：进语音模式就开流，按下才 start**（37 号票） | 省掉 getUserMedia 和 AudioContext 全部时间，剩输入延迟（几十毫秒） | 语音模式期间指示灯常亮（见 6.1） | 全部 | **推荐一** |
| 预热后让 track `enabled = false`，按下再 true | 在 Chrome / Safari 上和"保持 enabled"一样快（设备没关）；ArkWeb 同 Blink 层，应当一样【推断】 | **指示灯照样亮**，设备照样开（S16、S17、S22）；只有 Firefox 桌面版且手动打开偏好时才关设备，重开又要时间（S24） | — | 没有隐私收益，还用不了预录，**不用** |
| 预录环形缓冲（按下前 N ms） | 补上输入延迟和"手指和嘴不同步"，N 一般 200–300 ms | 需要麦克风常开（即预热）；内存里只留 N ms | DelayNode 或 AudioWorklet 全平台都有 | **推荐二**（要用户点头，第 7 节） |
| 用 AudioWorklet 采 PCM、自己编码，代替 MediaRecorder | 冷启动**不会更快**：还多了 AudioContext 和 `addModule`；Telegram 选它是为了格式 | 不变 | AudioWorklet：Chrome 66+、Safari 14.1+；WebCodecs `AudioEncoder`：Chrome 94、Safari 26、Firefox 130，Firefox Android 没有（S48） | 只在要预录、或要统一编码格式时才值得 |
| `navigator.mediaSession.setMicrophoneActive(false)` 让浏览器把麦克风静音 | 规范只说把 track 设成 muted（S7）。WebKit 的 muted 会真停采集，恢复就是重开，等于冷启动；Chrome 主要用来同步画中画按钮状态【推断】 | Safari 上可能灭灯【推断】 | Chrome 93、Safari 18.4，Firefox 没有（S48） | 不解决启动问题 |
| 按下时振动 + 动画（原生的做法） | 不省时间，让用户晚一点开口 | — | `navigator.vibrate` 在 iOS Safari 上没有；ArkWeb 未查 | 可以作为补充，不能单独解决（接近被否的 (c)） |

下面几项展开说。

### 5.1 `track.enabled = false`：指示灯不灭，设备不关

- **规范**（S1 §4.3.1.2）：track 变为 muted 或 disabled、且连到该设备的所有 track 都是 muted / disabled / stopped 时：
  - UA "MAY" 把设备的 live 状态置为 false，即可以灭"正在采集"的指示；
  - "the UA SHOULD relinquish the device within 3 seconds while allowing time for a reasonably-observant user to become aware of the transition"；
  - 重新 enabled 时 "SHOULD attempt to reacquire the device"，失败 "MUST end the track"。
  - 2019 年有人提议把 MAY 改成 MUST，没改（S2）。
- **Chrome**（ArkWeb 的 Blink 层同源，下面前两条应当同样成立【推断】；后两条是 Chrome 浏览器层的代码，ArkWeb 未公开）：
  - disabled 的音频 track 照样从 source 收数据，只是改发静音。`MediaStreamAudioTrack::OnData` 的注释原文是 "The W3C spec requires silent audio to flow while a track is disabled"（S16）。
  - `setEnabled` 不通知浏览器进程，设备不关。
  - 标签页红点、地址栏图标都由 `MediaStreamCaptureIndicator` 按"已打开的设备"计算；Android 的"正在使用麦克风"常驻通知（以 `FOREGROUND_SERVICE_TYPE_MICROPHONE` 前台服务运行）用的是同一个判断（S17）。
  - 摄像头的"disabled 就关灯"是 crbug 642785，2016 年提交至今没修（S18）。麦克风没有找到对应的 crbug。
- **Safari**：`MediaStreamTrackPrivate::setEnabled` 只改一个标志，采集状态不变。"所有 track 都 disabled 就停采集"是 WebKit bug 247752，2022-11 起一直是 ASSIGNED、没有补丁（S22）。
- **Firefox**（S24）：

  | 偏好 | 桌面 | Android |
  |---|---|---|
  | `media.getusermedia.camera.off_while_disabled.enabled` | true | false |
  | `media.getusermedia.microphone.off_while_disabled.enabled` | **false** | false |
  | 两者的 `…delay_ms` | 3000 | 3000 |

  麦克风原来也会关（Fx60），Fx85 起改成不关（bug 1674283）。原因是重新获取麦克风会让蓝牙耳机重新初始化，报告里解除静音时对方的声音 "drops out for about 500-1000 ms"。Mozilla 博客说这个功能 "desktop-only"。
- **结论**：在 Chrome、Safari 上（ArkWeb 按同一套 Blink 代码推断也是），`enabled = false` 既不灭灯、也不关设备，所以重开也没有延迟。37 号票说的"disabled 的 track 在部分浏览器上会被关设备、重开又有延迟"只在 Firefox 桌面版、而且用户手动打开偏好时才成立。不过它没有隐私收益，还会让预录缓冲收不到声音，**保持 enabled 是对的**。

### 5.2 预录：DelayNode 是最省事的实现

要把"按下前 N ms"带进 MediaRecorder 的录音，不用自己写环形缓冲。在 AudioContext 里接一个延迟节点就行：

```ts
// 预热（进入语音模式）
const stream = await navigator.mediaDevices.getUserMedia({ audio: { /* … */ } });
const ctx = new AudioContext();
const src = ctx.createMediaStreamSource(stream);
src.connect(analyser);                                // 音量表用不延迟的
const delay = ctx.createDelay(1);                     // 上限要小于 3 分钟（S4）
delay.delayTime.value = PREROLL_MS / 1000;            // 比如 0.3
const dest = ctx.createMediaStreamDestination();
src.connect(delay).connect(dest);

// 按下（同步）：dest.stream 比麦克风晚 N ms，所以从这一刻录，录到的是"按下前 N ms"起的声音
const usePreroll = ctx.state === "running";
const rec = new MediaRecorder(usePreroll ? dest.stream : stream, opts);
rec.start(250);

// 抬手：再等 N ms 才 stop，否则尾巴的 N ms 还在延迟线里
setTimeout(() => rec.stop(), usePreroll ? PREROLL_MS : 0);
```

- 内存里只有延迟线那 N ms（1 s 上限 × 48 kHz × 4 字节约 190 KB），新数据不断覆盖旧数据，不落地、不上传。
- 编码格式不变，还是 MediaRecorder 出 webm/opus 或 mp4/aac，服务端不用改。
- 前提是 AudioContext 处于 `running`。页面刷新后直接恢复成语音模式、用户还没点过任何东西时，它是 suspended（S4、S5、S8），这时退回录原始流，不带预录。
- 另一种做法是用 AudioWorklet 自己维护环形缓冲，按下时把缓冲加上后续的 PCM 交出去，自己编码成 WAV 或 Opus（WebCodecs）。这样控制更细，但代码多、上传体积大（16 kHz 单声道 16 位约 32 KB/s），服务端也要认 WAV（守护进程已认 wav）。只在 DelayNode 方案验证不通过时才考虑。

### 5.3 在按下的手势里同步做完能做的

- **预热命中时**：`pointerdown` 处理函数里第一件事就是 `new MediaRecorder(...)` 加 `start()`。React 的 `setState` 和重新渲染都放在后面。分析器和 AudioContext 已经在预热时建好，按下路径上不建任何东西。
- **预热没命中时**（刚进语音模式就按、预热被闲置超时或切后台关掉了）：`getUserMedia` 一 resolve 就立刻 `start` MediaRecorder，**然后**再建 AudioContext 和分析器。现在的代码是反过来的，先建 AudioContext 再 start（S20）。
- **用户激活**：触屏的 `pointerdown` 不算用户激活（S5），在它里面 `new AudioContext()` / `resume()` 能不能成功，取决于之前有没有 sticky activation。预热应当放在"切到语音模式"的那次点击里（那是 `click`，有激活）；页面刷新后恢复成语音模式时，在第一次 `pointerup` 里补一次 `ctx.resume()`。

## 6. 37 号票（预热，track 保持 enabled，按下才 start）要注意的细节

### 6.1 流开着时，各浏览器和系统的指示

| 环境 | 浏览器内的指示 | 系统级指示 | 依据 |
|---|---|---|---|
| Android Chrome | 标签页 / 地址栏的麦克风图标常亮；**通知栏常驻"正在使用麦克风"通知**（前台服务） | Android 12+ 状态栏绿点常亮。AOSP 原文："shows the icon for at least 5 seconds"；从系统源码看，`startRecording` 时开始计入麦克风使用【推断】 | S17、S26 |
| 华为浏览器 / ArkWeb（鸿蒙 6） | 未找到资料，需真机看 | 华为官方：有应用使用敏感权限时状态栏显示提示，"the microphone icon will display on the status bar"（EMUI 13 / HarmonyOS 3 的页面）；控制中心顶部能看到是哪个应用。HarmonyOS 5/6 的中文页据搜索摘要说麦克风是电池旁的黄点，正文没抓到【未核实】 | S29 |
| iOS Safari | 地址栏录音图标常亮 | 橙点常亮（"an app is using the microphone"） | S27 |
| Firefox 桌面 | 指示常亮（disabled 时变灰，但不消失） | 视操作系统 | S24 |

以上对"track 保持 enabled"和"track 设成 disabled"都一样（5.1）。闲置超时、切后台、离开语音模式时 `track.stop()`，指示才会灭。注意规范要求指示从无到有的变化 "MUST remain observable for a sufficient time… This SHOULD be at least 3 seconds"（S1 §15），Android 绿点至少显示 5 s（S26），所以刚开就 stop 时，指示可能还要过几秒才灭。这是正常现象。

### 6.2 `track.enabled = false` 会不会关设备，重开有没有延迟

见 5.1。Chrome、Safari 都不关，ArkWeb 应当也不关【推断】；重新 enabled 立即恢复，不丢开头。Firefox 只有用户打开偏好时才关：重开有延迟，期间的声音必丢；摄像头重开时 Firefox 工程师提到 "~1 second delay"（S2），麦克风没有找到数据。

### 6.3 流已经开着时，AEC / NS / AGC 会不会吞掉开头

- 处理模块挂在音频源上，位于 track 的上游。MediaRecorder 只是在下游多加一个接收端，**新建或启动 MediaRecorder 不会重置处理模块**（S19、S21）。
- AGC：Android / iOS 上的 Chromium 是固定 6 dB，没有爬升（S13）。
- NS：0.5 s / 2 s 的启动期从开流算起（S14），预热之后早就过了。
- 硬件 AEC 的收敛期没有资料，同理也是从开流算起。
- ArkWeb 的配置未公开，以实测为准。
- 预热的一个附带好处：冷启动时可能存在的"处理链刚起步"问题，都发生在用户按下之前。

### 6.4 `MediaRecorder.start` 到第一块数据之间有没有丢

没有发现会丢（S19）。接收端在 `start()` 里同步挂上，下一个采集缓冲（约 10 ms）就进编码器；编码器在开头补的是静音（`PrimeWithSilence`），不是丢数据。要注意的是 `start` 事件和第一个 `dataavailable` 都来得晚，计时以调用 `start()` 的时刻为准。

### 6.5 通话模式副作用：会影响语音气泡和语音回复的播放

- **Android Chrome**：开着回声消除时，整个语音模式期间系统都在 `MODE_IN_COMMUNICATION`（S10）。之后再开的输出流用 `AAUDIO_USAGE_VOICE_COMMUNICATION`，走通话音量和通话路由；连着蓝牙耳机时会切到 SCO（S11、S12）。语音气泡播放（36 号票）和语音回复（32 号票）的音量、音质、走哪个输出可能都会变【推断，需真机验证】。
- **iOS Safari**：开麦期间页面其他声音变小（S23）。
- **ArkWeb**：未知，需真机验证。
- **对策**，任选其一，用实测决定：
  1. `echoCancellation: false`。Android Chrome 上不切通话模式【推断】。代价是播放的声音会被录进去，所以按下时要先停掉正在播放的语音。
  2. 保留回声消除，播放语音时先 stop 预热的流，播完再重新预热。代价是播完马上按的那一次是冷启动。

### 6.6 权限与重新预热

- 第一次进语音模式时弹权限框。被拒后不要反复请求（37 号票已写）。
- 用户在 Chrome 上选了"仅这一次允许"：采集进行中，"页面在后台 5 分钟就失效"的计时不开始；离开页面后失效（S9）。预热会让每次进入页面后的第一次进语音模式都弹框，而不是在按下时弹。
- iOS：WebKit 默认在采集停止后，有用户手势时 10 分钟内不重新弹框，没有手势时 1 分钟后就会重弹（Safari 可能另行覆盖）。所以 iOS 上"回到前台自动重新预热"可能在没有手势时弹框，最好把重新预热放在用户的下一次点击里。这一条来自 WebKit 默认值，没有在 Safari 上实测。
- 鸿蒙：如果用户给浏览器设了"每次使用时询问"，每次重新预热都可能弹系统框【推断】。

## 7. 要不要加预录缓冲？这算不算"记录"

**为什么预热之后可能还需要预录**：预热把 `getUserMedia` 和 AudioContext 从按下路径上拿掉了，但还剩两段：

- 触摸到处理函数的输入延迟（几十毫秒，主线程忙时更长）；
- 人和手不同步：很多人会在手指落下的同时、甚至略早开口，用户的测试正是"按下的同时开始念"。

另外，识别模型从一个音节中间突然开始的音频里，常常认不出第一个音节。补 200–300 ms 可以把这些都盖住。业界的同类做法：vad-web 默认补 800 ms（S37），Alexa 说的是 "a fraction of a second"（S46）。

**这算不算"记录"**（给用户解释用）：

- **不算"录音 / 保存"的部分**：
  - 声音只在内存里流过，最多留最近 0.3 秒，新的不断盖掉旧的；
  - 不写盘，不进浏览器存储，不发到服务器；
  - 没按下，这 0.3 秒就永远不会离开那段内存；
  - 离开语音模式、切后台、闲置超时，它随麦克风流一起销毁。
  - 这和预热本身是同一回事：预热期间浏览器的降噪、音量分析也在处理实时声音，只是不留。
  - Amazon 和 Google 对唤醒词前的缓冲也是这个口径："No audio is stored or sent to the cloud unless…"（S46）、"won't be sent or saved"（S47）。
- **必须如实说明的部分**：按下之后，按下前那 0.3 秒会成为这条语音的开头，跟着这条语音一起上传、识别、存下来。也就是说，**一条语音的内容会比"按住的那段时间"多出开头一小截**。如果用户说的"不记录"是指"按下之前的声音一点都不能进消息"，预录就违背了这个要求。

**建议的说法**："语音模式下麦克风开着但不录音、不保存。按下时，为了不吞掉第一个字，会把按下前一瞬间（不超过 0.3 秒）的声音一起带上。"N 做成前端常量，可以设成 0 关掉。是否开启交给用户决定。

## 8. 推荐方案

### 推荐一：预热、track 保持 enabled、按下同步启动录音器（即 37 号票，补四点）

**理由**：

- 网页上做不到"设备热着、指示灯不亮"（5.1），想按下就开录只能预热。这也是网页上唯一真正能做到按下即录、又不需要预录的办法；实时语音的按键说话（Jitsi、Discord）也是这么做的（4.2）。
- 剩下的只有几十毫秒的输入延迟。
- 用户已经接受指示灯在语音模式期间常亮的代价。

**在 37 号票的基础上补四点**：

1. **按下路径上只做 `new MediaRecorder` 加 `start()`**。AudioContext 和分析器在预热时建好。冷启动（没命中预热）时，先 start 录音器，再建 AudioContext（5.3）。
2. **track 保持 enabled**，不用 `enabled = false`：后者在目标浏览器上不灭灯、没有隐私收益，还收不到预录的声音（5.1）。
3. **通话模式副作用**：把 `echoCancellation: false` 和 `true` 做成 A/B 实测，看两件事：冷启动是不是更快；预热期间播放语音气泡的音量和路由是否正常（6.5）。如果保留回声消除，播放语音时先关麦。按下时停掉正在播放的语音。
4. **打点**：每条语音带上分段计时（第 9 节），先确认在用户手机上预热命中时还缺多少。

**要验证的**：

- 用户的两台华为手机上，华为浏览器（ArkWeb M132）预热期间的指示（状态栏、浏览器内）；
- 预热命中时 `headLossMs`（第 9 节）是否接近 0；
- 语音模式里播放语音气泡和语音回复的音量和路由；
- 闲置 10 分钟关麦后，再按下的冷启动耗时；
- 页面刷新后恢复成语音模式时，AudioContext 的状态。

### 推荐二：在推荐一的基础上加 300 ms 预录（DelayNode），实测仍缺头再上

**理由**：

- 补上输入延迟和"手与嘴不同步"；
- 实现只是 AudioContext 里多一个 DelayNode，编码格式和服务端都不用改（5.2）；
- 业界的语音活动检测和智能音箱都这么做。

**代价**：

- 语音会比"按住的那段时间"多出开头 0.3 秒，要按第 7 节如实告诉用户，由用户决定；
- 抬手后要多等 0.3 秒才 stop；
- AudioContext 没在运行时退回不带预录。

**要验证的**：

- ArkWeb 上 `MediaStreamAudioDestinationNode` 接 MediaRecorder 能否正常出 webm/opus；
- 预录开 / 关两种情况下，"ABCDEFG…"测试的第一个字母能否识别出来；
- 60 秒上限是否把预录算进去（建议算进去）。

## 9. 在用户手机上实测

### 9.1 第零步：分清"录音缺头"还是"识别吞字"

- 回放那条语音（气泡能播放），听开头是 A 还是 F。
- 看识别结果：`recognizer.py` 返回的 `duration`（faster-whisper 解码出来的音频时长）和 `segments[0].start`。
- 如果录音里有 A–E 而识别结果没有，问题在识别端，与本文无关。faster-whisper 的 VAD 在每段语音两边各补 400 ms（S45），不太可能是它切掉的。

### 9.2 前端打点

全部用 `performance.now()` 的时间轴。按下和抬手的时刻用 `PointerEvent.timeStamp`：Event Timing 规范说物理输入的时刻由 `timeStamp` 估计（S6），它比处理函数里取的 `performance.now()` 早，差值就是输入延迟。

建议随语音上传一个可选的诊断对象（37 号票的"诊断字段"）：

| 字段 | 取法 | 说明 |
|---|---|---|
| `prewarm` | `"hit"` / `"miss"` | 按下时流是否已就绪 |
| `warmAgeMs` | 按下时刻 − 流就绪时刻 | 预热了多久（验证 NS 启动期等是否早已过去） |
| `inputDelayMs` | 处理函数开头的 `performance.now()` − `e.timeStamp` | 触摸到处理函数 |
| `gumMs` | getUserMedia 调用到 resolve（只在没命中时有） | 开设备 |
| `ctxMs` | `new AudioContext()` 前后的差（只在没命中时有） | 3.3 的同步等待 |
| `pressToStartMs` | 调用 `rec.start()` 之后的 `performance.now()` − `e.timeStamp` | **理论缺头量** |
| `startEventMs`、`firstChunkMs` | `start` 事件、第一个 `dataavailable` 相对按下的时刻 | 只作参考，它们本来就晚（3.4） |
| `holdMs` | 抬手的 `e.timeStamp` − 按下的 `e.timeStamp` | 用户真正按住了多久 |
| `prerollMs` | 实际用了多少预录（0 表示没用） | 推荐二 |
| `permission` | `navigator.permissions.query({name: "microphone"})` 的 state，查不到记 `"unknown"` | 是否弹过框 |
| `settings` | `track.getSettings()` 里的 `sampleRate`、`echoCancellation`、`noiseSuppression`、`autoGainControl` | 实际生效的约束 |
| `ctx` | `ctx.state`、`ctx.sampleRate`、`ctx.baseLatency` | AudioContext 是否在运行 |
| `ua` | `navigator.userAgent` | 区分华为浏览器、Chrome |

### 9.3 服务端算实际缺头

```
headLossMs ≈ holdMs + prerollMs − duration × 1000
```

其中 `duration` 是识别进程返回的解码时长。stop 会把最后一块冲出来，尾巴不丢，所以差值基本就是开头少的部分；Opus 的编码器延迟只有几毫秒。

把 `pressToStartMs`（理论值）和 `headLossMs`（实际值）放在一起看：

- 两者接近：缺头全在启动路径上；
- `headLossMs` 明显更大：设备层还有"开了但前一段不可用"的 lost input（S25），或者某处丢了数据。

### 9.4 测试步骤（请用户在两台手机上各做一遍）

1. 进语音模式，等 3 秒，按下的同时念"ABCDEFGHIJ"，念完松手。重复 5 次（预热命中）。
2. 切到文字模式再立刻切回语音模式，马上按下念同样的内容。重复 3 次（多半没命中）。
3. 把 `echoCancellation` 改成 `false` 的版本（A/B 开关），重复第 1、2 步。
4. 每次都记下回放听到的第一个字母。服务端按第 9.3 节列出每条的 `prewarm`、`pressToStartMs`、`headLossMs`、`ua`。

还可以加一个更客观的办法：按下的瞬间用另一只手拍一下桌子。拍击声的起点在录音里的位置（或者缺失）能直接读出缺头量，不依赖念字母的节奏。

## 10. 开放问题

- 华为浏览器（ArkWeb）在鸿蒙 6 上，网页开麦时浏览器内的指示、状态栏隐私提示是什么样，以及 `echoCancellation` 映射到哪个 `AudioCapturer` 音源：只能真机看。
- Android 切通话模式的耗时、硬件 AEC 的收敛期：未找到一手测量，靠第 9 节的 A/B 实测。
- 预热期间播放语音的音量和路由（6.5）：可能会反过来影响 36 号票的自动播放和 32 号票的语音回复设计。
- 推荐二的预录要不要做、做多长：取决于推荐一上线后的 `headLossMs` 实测和用户对第 7 节说法的态度。
- 语音模式期间麦克风常开的耗电：未找到资料，没有测。
