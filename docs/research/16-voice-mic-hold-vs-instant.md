# 按住说话：既要按下就录，又不一直占着麦克风

37 号票让二狗"进语音模式就打开麦克风流，按下才启动录音器"。用户实测按下到开录 62–72 ms，开头不丢。44 号票又去掉了闲置关麦。新的问题是：麦克风一直被占着。用户在别处用系统输入法的语音输入（比如二狗自己的"发起任务"对话框，或者别的 App），输入法提示"麦克风被占用"，观感也不好。

用户的要求：按下的第一时间就能录到，又不希望一直占着麦克风，不影响在别处用系统麦克风。用户的问题：是不是基于 Web 做麦克风都有这个问题？有没有好办法？

本文接着 `docs/research/14-voice-capture-latency.md`（下称"14 号文档"）写。那份文档讲过的内容这里不再重复：冷启动各段、`track.enabled=false` 不关设备、原生 App 不预热、预录缓冲。本文回答四件事：

1. 输入法为什么说"麦克风被占用"；
2. 这个两难是不是 Web 固有的；
3. 有哪些办法，各自的效果和代价；
4. 推荐方案，以及在真机上怎么验证。

资料截至 2026-10-09，访问日期都是这一天。来源尽量用一手资料：W3C 规范、AOSP / Chromium / WebKit / OpenHarmony 源码、Android / Apple / 华为官方文档、issue tracker。标注规则：

- 从源码推出来、没有实测的，标【推断】；
- 只有第三方来源的，标【未核实】；
- 查不到的，写"未找到"；
- **本文没有做任何真机实测**。唯一的实测数字是用户在 37 号票上报的 62–72 ms。

## 0. 结论速览

1. **"麦克风被占用"的原因：二狗在用户打字时还占着麦克风，而系统的并发录音规则让先占着、或者"界面在顶"的那一方赢。** 三个平台的机制不一样：
   - **Android（Chrome）**。Android 10 起，两个普通应用不能同时拿到麦克风的声音，被压下去的一方 `startRecording()` 照样成功，但收到的全是静音（S2、S4）。键盘弹出时，输入法进程的状态是 BOUND_FOREGROUND_SERVICE（5），不算"界面在顶"（TOP，≤2），所以 Chrome 在顶、在录时，输入法拿到静音，再把它显示成"占用"（S4、S6）【推断，来自源码】。开着回声消除时更严重：Chrome 用 VOICE_COMMUNICATION 预设，这个预设默认是"隐私敏感"的，还会把系统切到通话模式 `MODE_IN_COMMUNICATION`（S9、S10）。这两条都会压住别的录音者，连分屏里的另一个 App 都会被压住。
   - **鸿蒙 NEXT（华为浏览器，ArkWeb M132）**。网页的 `getUserMedia` 一律用 `SOURCE_TYPE_VOICE_COMMUNICATION` 录音源，不看回声消除（S25）。系统的音频焦点表规定：已经有 VOICE_COMMUNICATION 在录时，后来的 MIC、VOICE_RECOGNITION 录音**直接被拒**，启动失败（S24）。华为官方的说法是"敏感场景……先到先得，此时应用A占用麦克风，应用B界面会提示麦克风被占用"（S26）。
   - **iOS（Safari）**。第三方键盘根本不能用麦克风（S18），它们的语音输入要跳回自己的 App 去录。这时 Safari 进入后台，二狗已经关麦，所以不冲突。系统听写大概率会打断 Safari 的采集（S19、S20）：听写能用，但之后页面的音轨可能一直是 muted，按下录到的是空白。WebKit 有没修的 bug，iOS 18.5 上也有报告（S21）【推断，要真机确认】。所以在 iOS 上，问题主要不是"占用提示"，而是"录到空白"。
2. **关掉回声消除、降噪、自动增益解决不了"同一页面里打字时被占用"**：
   - Android：降噪和自动增益在 Android 上是 WebRTC 的软件处理，不影响走哪条录音通路（S11）。只有回声消除决定预设和通话模式。关掉回声消除后，Chrome 153 起用 GENERIC 预设（不隐私敏感、不切通话模式）；153 以前用 CAMCORDER，**仍然隐私敏感**（S10）。用户配对的 Android 设备是 Chrome 149。不管哪个版本，同一页面里 Chrome 都在顶，输入法照样拿到静音【推断】。
   - 鸿蒙 M132：录音源是写死的，关掉回声消除没有任何作用。M144（OpenHarmony 7.0）起才会改走 MIC（S25）。
   - iOS：只把 VoiceProcessingIO 换成 RemoteIO，音频会话的类别和模式都不变（S20）。Safari 18.5 根本不认 `noiseSuppression` 和 `autoGainControl`。
   - 关回声消除只能当辅助手段：Android 上播放不再走通话音量，分屏里的另一个 App 也能录。
3. **是不是 Web 都有这个两难：一半是。**
   - **固有的一半**：网页的麦克风只有"开着"和"关着"两种状态。`getUserMedia` 就是打开设备并开始采集；`track.enabled=false` 在 Chrome、Safari 上不放设备（14 号文档 5.1）。原生有第三种状态：AudioRecord 建好但不 `startRecording()`，不算在用麦克风，不亮指示灯，也不挡别人（S29）。AOSP 的注释说启动一个流通常 20–30 ms，第一次 200–300 ms（S28），所以原生 App 不需要一直占着。网页冷启动要几百毫秒到一秒多（14 号文档），想按下就录，就只能提前占着。
   - **不是固有的一半**：用户要打字时，二狗还占着麦克风，这是二狗自己的时机问题。只要输入框获得焦点时真正 `track.stop()`，三个平台的输入法就都能录【推断】。这一条不影响"语音模式里按下就录"。
4. **推荐**（第 6 节）：
   - **推荐一，先做，改动小："打字就让"**。语音模式里照旧预热、按下即录。另外加三条：
     - 页面里任何可编辑元素获得焦点（"发起任务"对话框、卡片上的输入框），立即停掉音轨；焦点离开后再预热。
     - 分屏时另一侧获得焦点（页面收到 `blur`），也放开。
     - 按下时，如果流被系统静音了（iOS 的 `muted`、Android 的全零采样），当作没预热，重新打开，不发空白语音。
   - **推荐二，在推荐一上叠加，看用户取舍："用完留 60 秒"**。麦克风只在进语音模式、按下或松开、回到前台、焦点离开输入框之后开着 60 秒，期间可以连着发。过了 60 秒就关。代价：闲置超过 60 秒后的第一次按下是冷启动，要等"准备中"。iOS 上隔了 1 分钟以上再开，可能重新弹权限框（S22），除非用户在网站设置里把麦克风设成"允许"。
   - **关回声消除**：用 36 号票已有的兜底 (b) 做 A/B 测试，不作为主解法。Android 上要先把 Chrome 升到 153 以上才有意义。
   - **原生壳**（18 号票）能根治：原生录音按下才开，几十毫秒，不用一直占着。但代价大，iOS 上不现实。建议等做鸿蒙 / Android 壳拿推送时，把录音放进 JS 桥。
5. **需要用户在真机上配合试的**（第 7 节）。先加诊断：麦克风开关的时刻和原因、冷启动各段耗时、音轨的 `mute` 事件、全零检测、浏览器版本。然后在每台手机上试一轮：
   - 在"发起任务"里用输入法的语音；
   - 连着发 5 条；
   - 闲置超过 60 秒后按下念"ABCDEFG"；
   - iPhone 上用一次听写，再按下说话；
   - 分屏；
   - 回声消除开、关各一轮。

## 1. 来源

| # | 资料 | URL | 用来说明 |
|---|---|---|---|
| S1 | W3C Media Capture and Streams（Media Flow、Life-cycle、`getUserMedia` 第 11 步） | https://w3c.github.io/mediacapture-main/ | 麦克风被更高优先级的应用拿走时，UA SHOULD 用 muted 告诉页面；`getUserMedia` 要等页面可见、有系统焦点 |
| S2 | Android：Sharing audio input | https://developer.android.com/media/platform/sharing-audio-input | 并发录音规则、隐私敏感源、通话、被压方收到静音、`isClientSilenced()` |
| S3 | AOSP：Concurrent capture | https://source.android.com/docs/core/audio/concurrent | 并发策略靠把被压方静音来实现 |
| S4 | AOSP `AudioPolicyService.cpp` 的 `updateUidStates_l`（main，另对照 android-10.0.0_r1、11.0.0_r1、12.0.0_r1） | https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/services/audiopolicy/service/AudioPolicyService.cpp | 谁能录、输入法只在 RTT 通话时有特权、"在顶"的判定、通话模式持有者 |
| S5 | AOSP `AudioService.java` | https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/audio/AudioService.java | 通话模式持有者、6 秒复查 |
| S6 | AOSP `InputMethodBindingController.java`、`Context.java`（`BIND_FOREGROUND_SERVICE`）、`ProcessStateEnum.aidl` | https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/inputmethod/InputMethodBindingController.java ；https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/content/Context.java | 键盘显示时输入法进程是 BOUND_FOREGROUND_SERVICE（5），不是 TOP（2） |
| S7 | `AudioRecord.Builder.setPrivacySensitive`；AOSP `AudioStreamBuilder.cpp` | https://developer.android.com/reference/android/media/AudioRecord.Builder#setPrivacySensitive(boolean) ；https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/libaaudio/src/core/AudioStreamBuilder.cpp | VOICE_COMMUNICATION、CAMCORDER 默认隐私敏感 |
| S8 | 荣耀支持页；华为支持页（录屏） | https://www.honor.com/cn/support/content/zh-cn11174377 ；https://consumer.huawei.com/ph/support/content/en-us15996688 | 厂商对"通话时独占麦克风"的说法 |
| S9 | Chromium `audio_manager_android.cc`、`AudioManagerAndroid.java` | https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/audio_manager_android.cc | Android 上平台效果只有 ECHO_CANCELLER；有效果才切通话模式；`SetCommunicationDevice`；最后一路输入关掉就恢复 MODE_NORMAL |
| S10 | Chromium `aaudio_stream_wrapper.cc`；提交 054d2dca62（首见于 153.0.8007.0）；`opensles_input.cc` | https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/aaudio_stream_wrapper.cc ；https://chromium.googlesource.com/chromium/src/+/054d2dca6293ac1847a8287491a18593c047cc50 | 回声消除开用 VOICE_COMMUNICATION；关掉用 GENERIC（M153 起，之前是 CAMCORDER） |
| S11 | Chromium `media_stream_audio_processing_layout.cc` | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/media_stream_audio_processing_layout.cc | 降噪、自动增益在 Android 上是软件处理 |
| S12 | Chromium 停止路径：`processed_local_audio_source.cc`、`audio_input_device.cc`、`aaudio_stream_wrapper.cc`；crbug 1183255 | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/processed_local_audio_source.cc | `track.stop()` 之后多快放开 |
| S13 | crbug 40210610；crbug 564572125；提交 c187abd63b（M155） | https://issues.chromium.org/issues/40210610 ；https://issues.chromium.org/issues/564572125 | Android Chrome 被系统静音时页面收不到 mute，只拿到全零 |
| S14 | Chromium `ViewEventSinkImpl.java`；Android `Activity` 文档 | https://chromium.googlesource.com/chromium/src/+/main/content/public/android/java/src/org/chromium/content/browser/ViewEventSinkImpl.java ；https://developer.android.com/reference/android/app/Activity | Android 上页面失焦只看"顶层 resumed Activity" |
| S15 | Chrome：viewport resize behavior；MDN VirtualKeyboard API | https://developer.chrome.com/blog/viewport-resize-behavior ；https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API | 键盘弹出时页面能收到的信号 |
| S16 | Chromium `user_media_processor.cc`（trace 事件）、UMA 直方图 | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/user_media_processor.cc | Chrome 自己怎么量 `getUserMedia` |
| S17 | crbug 443255997 | https://issues.chromium.org/issues/443255997 | `getUserMedia` 把音量键切到通话音量；关回声消除 "help[s] inconsistently" |
| S18 | Apple：Custom Keyboard（App Extension Programming Guide）；Configuring open access for a custom keyboard | https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/CustomKeyboard.html ；https://developer.apple.com/documentation/uikit/configuring-open-access-for-a-custom-keyboard | 第三方键盘不能用麦克风 |
| S19 | Apple：`AVAudioSession.InterruptionReason`、Handling audio interruptions、`AVAudioSession.Mode.videoChat` | https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionreason ；https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions ；https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/videochat | 别的会话激活时会打断当前会话 |
| S20 | WebKit（Safari 18.5 对应 `safari-7621.2.5-branch`）：`AudioSessionIOS.mm`、`CoreAudioCaptureSource.h`、`BaseAudioSharedUnit.cpp`、`MediaStreamTrack.cpp`、`AudioSession.cpp`、`MediaSessionManagerCocoa.mm`、`CoreAudioSharedUnit.cpp`、`MediaTrackSupportedConstraints.idl` | https://github.com/WebKit/WebKit/tree/main/Source/WebCore/platform/mediastream | 打断时置 muted、打断结束自动 unmute；采集用 PlayAndRecord + VideoChat，不混音；回声消除只决定用 VPIO 还是 RemoteIO；不认 `noiseSuppression`、`autoGainControl` |
| S21 | WebKit 提交 266293@main（bug 259368）；bug 213853；bug 262730 | https://commits.webkit.org/266293@main ；https://bugs.webkit.org/show_bug.cgi?id=213853 ；https://bugs.webkit.org/show_bug.cgi?id=262730 | 打断之后不恢复，iOS 18.5 上仍有报告 |
| S22 | WebKit `UnifiedWebPreferences.yaml`、`UserMediaPermissionRequestManagerProxy.cpp` | https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml | iOS 上采集停了 1 分钟后再要麦克风会重新弹框 |
| S23 | WebKit bug 265578、bug 261764 | https://bugs.webkit.org/show_bug.cgi?id=265578 ；https://bugs.webkit.org/show_bug.cgi?id=261764 | iOS 键盘的 `visualViewport` 事件晚到；听写没有专门的事件 |
| S24 | OpenHarmony：录音并发说明；`audio_interrupt_policy_config.xml`（5.0–7.0 各 Release 分支）；`audio_interrupt_service.cpp` | https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/media/audio/audio-recording-concurrency.md ；https://gitcode.com/openharmony/multimedia_audio_framework/blob/OpenHarmony-6.0-Release/services/audio_policy/server/infra/config/file/audio_interrupt_policy_config.xml | 已经有 VOICE_COMMUNICATION 在录时，后来的录音被拒 |
| S25 | ArkWeb `ohos_audio_capturer_source.cc`（M132 `132_trunk`、M114、master / 7.0）；web_webview `audio_capturer_adapter_impl.cpp`；`web-component-overview.md` | https://gitcode.com/openharmony-tpc/chromium_arkweb/blob/132_trunk/chromium_ext/media/audio/ohos/ohos_audio_capturer_source.cc ；https://gitcode.com/openharmony/web_webview/blob/master/ohos_adapter/audio_adapter/src/audio_capturer_adapter_impl.cpp | 华为浏览器的录音源写死为 VOICE_COMMUNICATION；M144 起按回声消除选 |
| S26 | 华为支持：HarmonyOS 5 及以上提示麦克风被占用；小艺输入法提示其他应用正在录音；状态栏隐私提示 | https://consumer.huawei.com/cn/support/content/zh-cn16056785/ ；https://consumer.huawei.com/cn/support/content/zh-cn15964508/ ；https://consumer.huawei.com/cn/support/content/zh-cn15984519/ | 华为官方对"占用"的解释 |
| S27 | OpenHarmony：`web-rtc.md`（含 API 23 起的 `pauseMicrophone` / `stopMicrophone`）、`background-recording.md`、`audio-fast-recording.md`、`web-in-page-app-function-invoking.md` | https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-rtc.md ；https://gitcode.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-in-page-app-function-invoking.md | 宿主应用控制网页麦克风；JS 桥；低时延录音 |
| S28 | AOSP `AudioStreamInternal.cpp` 的注释；CTS 提交 37b9b9b | https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/libaaudio/src/client/AudioStreamInternal.cpp ；https://android.googlesource.com/platform/cts/+/37b9b9b%5E%21/ | 原生启动 20–30 ms，第一次 200–300 ms；CTS 原来的目标是 200 ms |
| S29 | AOSP `AudioPolicyInterfaceImpl.cpp`、`ServiceUtilities.cpp`；AOSP 隐私指示 | https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/services/audiopolicy/service/AudioPolicyInterfaceImpl.cpp ；https://source.android.com/docs/core/permissions/privacy-indicators | AudioRecord 建好不启动不算在用麦克风 |
| S30 | Apple 开发者论坛 thread 814137、661707、756760 | https://developer.apple.com/forums/thread/814137 ；https://developer.apple.com/forums/thread/661707 ；https://developer.apple.com/forums/thread/756760 | iOS 原生启动耗时【未核实】 |
| S31 | web.dev WebAPKs；Android TWA 文档；TWA postMessage；前台服务限制 | https://web.dev/articles/webapks ；https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities ；https://developer.chrome.com/docs/android/post-message-twa ；https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start | 壳方案 |
| S32 | Capacitor `BridgeWebChromeClient.java`；capacitor-voice-recorder | https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/BridgeWebChromeClient.java ；https://github.com/tchvu3/capacitor-voice-recorder | 壳方案 |
| S33 | Apple：开发者账号（Personal Team 限制）；WebKit bug 215884 | https://developer.apple.com/help/account/basics/about-your-developer-account/ ；https://bugs.webkit.org/show_bug.cgi?id=215884 | iOS 侧载的代价；主屏 Web App 的权限不跨次保留 |

## 2. 现状：二狗什么时候开着麦克风

代码见 `state/voice-mic.ts`（开关时机）、`app/voice-session.ts`（接线）、`app/voice-recorder.ts`（`open` / `begin` / `close`）、`app/voice-browser.ts`。

| 情形 | 现在麦克风 | 问题 |
|---|---|---|
| 进语音模式（输入框挂上） | 开（预热） | — |
| 语音模式里闲置 | 一直开着（44 号票） | 指示灯常亮 |
| 切回文字、离开会话页 | 关 | — |
| 页面切到后台（`visibilitychange`） | 关 | — |
| **语音模式里打开"发起任务"对话框，在输入框里用输入法语音** | **开着** | 输入法提示占用。`StartTaskDialog` 的 textarea 是 `autoFocus`，对话框一打开键盘就弹出来，VoiceInput 还挂在下面的输入栏里（`pages/shared.tsx`、`ui/conversation/Composer.tsx`） |
| **语音模式里在卡片上的输入框打字**（如 `PlanCard.tsx` 的"要改的地方"） | **开着** | 同上 |
| **分屏、悬浮窗、下拉通知栏、系统助理浮层**（页面仍然可见） | **开着** | `visibilitychange` 不触发 |
| **流被系统静音或打断**（iOS 听写之后；Android 被优先级更高的应用抢走） | `warm` 仍为真：只看 `readyState === "live"`，不看 `muted` | 按下"即录"，录到的是空白【推断】 |
| 冷启动（没预热好就按下） | `open()` 里 `getUserMedia` resolve 之后，先 `createMeter`（`new AudioContext`）再 `begin` | 14 号文档 5.3 建议的"先启动录音器，再建 AudioContext"还没做 |
| 回声消除 | 开着（兜底 (b) 默认关） | 见第 3 节 |

## 3. 为什么输入法说"麦克风被占用"

### 3.1 Android 的并发录音规则

官方文档（S2）的规则，原文：

- "Apps with visible foreground UIs have higher priority than background apps."
- "Apps capturing audio from a privacy-sensitive source have higher priority than apps that are not."
- "Two ordinary apps can never capture audio at the same time."
- "If neither app is privacy-sensitive, the app with a UI on top receives audio. If neither app has a UI, the one that started capture the most recently receives audio."
- "If one of the apps is privacy-sensitive, it receives audio and the other app gets silence even if it has a UI on top or started capturing more recently."
- 隐私敏感源："an app is treated differently if it uses a 'privacy-sensitive' audio source: `CAMCORDER` or `VOICE_COMMUNICATION`."
- 通话："A voice call is active if the audio mode returned by `AudioManager.getMode()` is `MODE_IN_CALL` or `MODE_IN_COMMUNICATION`. … The call always receives audio."
- 被压方收到什么："the previously capturing app continues to run, but receives silence"。Android 10 以前则是 `startRecording()` 报错。
- 被压方能自己查出来：`AudioRecordingConfiguration.isClientSilenced()`（API 29）。

AOSP 的实现在 `updateUidStates_l`（S4）。函数前面的注释列出了谁可以录，与本文有关的几条原文如下：

```
//    OR the client is the current InputMethodService
//        AND a RTT call is active AND the source is VOICE_RECOGNITION
//    OR The client is an active communication owner
//        AND is on TOP or latest started
//    OR Any client
//        AND The assistant is not on TOP
//        AND is on TOP or latest started
//        AND there is no active privacy sensitive capture or call
//            OR client can capture calls
```

代码里的几个要点（S4）：

- "is on TOP or latest started"：只要有"在顶"的录音者，就只有它能录；没有"在顶"的，才轮到最后开始的那个。
- 隐私敏感按标志位判断：`AUDIO_FLAG_CAPTURE_PRIVATE`。敏感和普通同时在录时 "favor the privacy sensitive case"。
- 通话模式持有者：`canCaptureCommunication = … || !isPhoneStateOwnerActive || recordUid == mPhoneStateOwnerUid`。也就是说，处于 `MODE_IN_COMMUNICATION`、而且模式持有者自己在录时，别人都不能录。持有者是最近一个调了 `setMode` 的活跃应用；非特权应用设了模式之后，系统每 6 秒复查一次它还在不在播放或录音（S5）。

各版本的差异（S4，对照 android-10/11/12 的标签）：

| 版本 | 隐私敏感源压别人 | `MODE_IN_COMMUNICATION` 的持有者在录时压别人 |
|---|---|---|
| Android 10 | 是（写死 CAMCORDER、VOICE_COMMUNICATION） | 否：只有 `MODE_IN_CALL` 拦 |
| Android 11 | 是 | 否：被注释掉了，`//TODO(b/160260850): restore restriction to mode owner…` |
| Android 12 及以后 | 是 | 是 |

### 3.2 输入法在这套规则里是什么身份

- **输入法不算"在顶"**。键盘显示时，系统用 `IME_VISIBLE_BIND_FLAGS` 绑定输入法，里面有 `BIND_FOREGROUND_SERVICE`。这个标志的说明原文："set the process state to BOUND_FOREGROUND_SERVICE instead of the normal maximum of IMPORTANT_FOREGROUND"（S6）。这个状态的值是 5，而音频策略要求 `amState <= PROCESS_STATE_TOP`（TOP 是 2）才算 `APP_STATE_TOP`（S4、S6）。所以输入法在音频策略里只是普通的前台应用【推断：几处源码连起来得出】。
- **输入法唯一的特殊待遇在 RTT 通话里**（"a RTT call is active AND the source is VOICE_RECOGNITION"），平时没有。
- **权限不是问题**。绑定时带了 `BIND_INCLUDE_CAPABILITIES`，前台应用的"使用期间可用麦克风"能力会传给输入法（S6）【推断】。挡住它的是并发策略，不是权限。
- **输入法怎么判断"占用"**：Gboard、讯飞、搜狗、百度、小艺都没有公开文档，未找到。Android 10 起 `startRecording()` 照样成功，所以输入法只能靠这几种办法发现【推断】：
  - `isClientSilenced()`；
  - 读到的数据全是零；
  - `getActiveRecordingConfigurations()` 里看到别人在录；
  - `getMode()` 不是 NORMAL。
- 厂商的说法和这套规则一致。荣耀："打电话时，禁止其他应用使用麦克风，因此应用无法使用录音功能"；华为："If another app is already using the audio channel, it will be given priority"（S8）。厂商是否改过 AOSP 的这段并发代码，未找到。

### 3.3 Chrome 开着的是哪条通路

Chromium main 分支（S9、S10、S11），手机上：

| 页面约束 | 平台效果 | AAudio 预设 → 录音源 | 隐私敏感 | 切 `MODE_IN_COMMUNICATION` | 降噪、自动增益 |
|---|---|---|---|---|---|
| 回声消除开（现状），设备报告有硬件 AEC | ECHO_CANCELLER | VOICE_COMMUNICATION | 是 | 是 | WebRTC 软件处理，叠加在通话通路自带的处理上 |
| 回声消除关，降噪、自动增益开 | 无 | **M153 起** GENERIC（= MIC）；**M153 以前** CAMCORDER | M153 起否；**以前是** | 否 | WebRTC 软件处理照常 |
| 三项全关 | 无 | 同上 | 同上 | 否 | 没有 |

几点说明：

- **平台效果只可能有 ECHO_CANCELLER**。`GetInputStreamParameters` 只问 `AcousticEchoCanceler.isAvailable()`，从不申请平台降噪或自动增益（S9）。所以降噪、自动增益开不开，都不影响走哪条通路、切不切通话模式。
- **切通话模式的条件**是 `params.effects() != NO_EFFECTS`，而且只在打开第一路输入时判断。最后一路输入关掉时恢复 `MODE_NORMAL`（S9）。
- **M153 的改动**。提交 054d2dca62 的说明原文："If EC is off, we use `AAUDIO_INPUT_PRESET_CAMCORDER` … This CL fixes the issue by using the `AAUDIO_INPUT_PRESET_GENERIC` preset instead"，首见于 153.0.8007.0（S10）。走 OpenSL ES 回退路径的设备（Unisoc 芯片、低于 Android 12）仍然用 CAMCORDER。
- **用户的 Chrome 是 149**。关掉回声消除后用的是 CAMCORDER，仍然隐私敏感，只是不切通话模式。149 大约是半年前的版本，可能这台手机没有自动更新（比如没有 Google Play 的华为机自己装的 APK）【推断】。要先看 `chrome://version`。
- **Chrome 从不设置 `setPrivacySensitive`**，敏感与否完全由预设推出来（S7、S10）。
- **关掉回声消除也有残留**。打开输入流时，Chrome 在手机上**不看效果**，一律调 `SetCommunicationDevice`；它只在关通话模式、关蓝牙 SCO、关免提时清掉（S9）。这影响的是通话路由，看起来不会占住麦克风【推断】。
- 14 号文档 3.2 写"关掉之后……用 GENERIC 预设"，这只在 M153 以后成立，这里更正。
- crbug 443255997：`getUserMedia` 让音量键变成调通话音量，"disabling echoCancellation help[s] inconsistently"（S17）。

### 3.4 关掉回声消除之后，输入法能不能录

按 3.1–3.3 推（全部是【推断】，要真机确认）：

| 场景 | 回声消除开（现状） | 回声消除关，Chrome 153+ | 回声消除关，Chrome 149 |
|---|---|---|---|
| 同一页面里打字，用输入法语音 | 输入法拿到静音：Chrome 在顶，又隐私敏感，还是通话模式持有者 | **仍然静音**：Chrome 在顶，输入法不在顶 | 仍然静音 |
| 分屏，另一侧 App 自己录音（两边都在顶） | 另一侧静音：Chrome 隐私敏感 | 最后开始的那个赢，另一侧能录 | 另一侧静音：CAMCORDER 隐私敏感 |
| 分屏，在另一侧用输入法语音 | 输入法静音 | 仍然静音：Chrome 在顶 | 仍然静音 |
| 切到别的 App（二狗进后台） | 二狗已经关麦，不冲突 | 同左 | 同左 |
| 语音模式里播放 agent 语音 | 走通话音量、通话路由（14 号文档 6.5） | 不再走通话音量 | 不再走通话音量 |

**结论**：在 Android 上，关掉回声消除解决不了"同一页面里打字时被占用"，只能改善分屏和播放音量。真正的解法是放开麦克风。

另外，Chrome 被别人压下去时，页面也察觉不到。Android Chrome 从不因为并发策略把音轨置成 muted：crbug 40210610 的评论说 "'muted' will never be set in Chrome on Android"；crbug 564572125 报告 "all audio samples captured by Chrome are 0 … does not report any error"（S13）。M155 起只有系统级的"麦克风静音"会触发 `mute`。所以，如果语音模式里有通话类 App 抢走了麦克风，二狗按下"即录"录到的是全零。

### 3.5 iOS

- **第三方键盘不能用麦克风**。Apple 原文："Custom keyboards … have no access to the device microphone, so dictation input is not possible"。现行文档的"完全访问"限制里仍然列着 "No access to microphone and speaker"（S18）。所以搜狗、讯飞、Gboard 这类键盘的语音输入，要么跳到自己的主 App 去录，要么由主 App 在后台录（所谓"免跳转"）【未核实，第三方】。跳转时 Safari 进入后台，二狗已经关麦，不冲突。"免跳转"和 Safari 抢麦克风谁赢，未找到资料。
- **系统听写**。"Safari 开着 `getUserMedia` 时按听写键会怎样"，没有找到直接的权威说明。下面是从 Apple 的会话规则和 WebKit 源码推出来的【推断】：
  - Safari 采集时的会话是 PlayAndRecord，模式 VideoChat，选项里**没有** MixWithOthers（`MediaSessionManagerCocoa.mm`、`AudioSessionIOS.mm`，S20）。Apple 原文："The system interrupts this audio session when it activates another"（S19）。所以听写一开始，Safari 的会话大概率被打断，听写本身能用。
  - 被打断时，WebKit 停止采集，把音轨置成 muted：`client.setMuted(true)`（`BaseAudioSharedUnit.cpp`）。打断结束时，只要音轨还开着就自动恢复：`if (client.canResumeAfterInterruption()) client.setMuted(false)`。页面看到 `mute`，然后是 `unmute`，`readyState` 一直是 `live`（S20）。
  - 问题出在"打断结束"的通知不一定会来。WebKit bug 213853（NEW）："the ownership of the microphone never goes back to Safari"。bug 262730（NEW）的 2025-12 评论说 unmute 事件不再出现，受影响设备里列着 iOS 18.5 的 iPhone（S21）。WebKit 的补救是在下次激活音频会话时补发恢复，比如页面开始播放媒体时（`AudioSession.cpp`，提交 266293@main）。
  - **对二狗的影响**：听写之后音轨可能一直是 muted，但现在的 `warm` 只看 `readyState`，按下会"即录"出一段空白。这一条比"占用提示"更要紧，要真机确认。
- **回声消除对 iOS 基本没影响**：只决定用 VoiceProcessingIO 还是 RemoteIO（`m_shouldUseVPIO = enableEchoCancellation()`），会话类别、模式、打断逻辑都不变（S20）。Safari 18.5 的 `MediaTrackSupportedConstraints` 里没有 `noiseSuppression` 和 `autoGainControl`，传了也被忽略。
- **页面能看到的信号**：
  - 输入框获得焦点时有 `focusin`；
  - 键盘弹出时有 `visualViewport` 的 `resize`，但地址栏在底部时要等动画结束才到（bug 265578）；
  - 听写没有专门的事件，只有 `beforeinput` / `input`（bug 261764，S23）；
  - 页面唯一能拿到的"麦克风被别人拿走了"的信号，就是音轨的 `mute`。
- **重新弹权限框**（更正 14 号文档 6.6）：WebKit 的 `InactiveMediaCaptureStreamRepromptIntervalInMinutes` 在 iOS 上默认是 **1 分钟**，其他平台 10 分钟（S22）。这和用户手势无关；手势只影响"被拒过的能不能再问"。也就是说，采集停了超过 1 分钟后再 `getUserMedia`，会重新弹框。Safari 可能覆盖这个默认值【推断】。用户在 Safari 的网站设置里把这个网站的麦克风设成"允许"，就不会再问。

### 3.6 鸿蒙

**HarmonyOS 5 / 6（NEXT，华为浏览器，ArkWeb）**：

- **录音源写死为 VOICE_COMMUNICATION**。ArkWeb M132（OpenHarmony 6.0、6.1 的默认内核）和 M114 都是这样（S25）：

  ```
  capturerOptions->SetSourceType(
      AudioAdapterSourceType::SOURCE_TYPE_VOICE_COMMUNICATION);
  ```

  2026-04 起 master 和 OpenHarmony 7.0 的 M144 改成：有 ECHO_CANCELLER 才用 VOICE_COMMUNICATION，否则用 SOURCE_TYPE_MIC。官方文档对 VOICE_COMMUNICATION 的说明是"语音通话场景的音频源。该流类型启动录音时，会触发开启3A算法"。
- **焦点表：已有 VOICE_COMMUNICATION 在录时，后来的录音被拒**。`audio_interrupt_policy_config.xml` 里，已有 `SOURCE_TYPE_VOICE_COMMUNICATION` 时，`<deny>` 列着 MIC、CAMCORDER、VOICE_RECOGNITION、VOICE_MESSAGE 等（S24）。被拒的一方启动失败（`ERR_FOCUS_DENIED`，日志 "The incoming audio capturer should be denied!"），不是收到静音。各 Release 分支的对比如下（6.0 的文件本文下载核对过，其他版本没有逐条复核）：

  | 已经在录的一方 → 后来的一方 | 5.0 | 5.1 | 6.0 | 6.1 | 7.0 |
  |---|---|---|---|---|---|
  | VOICE_COMMUNICATION → MIC 或 VOICE_RECOGNITION | 拒 | 拒 | 拒 | 拒 | 拒 |
  | MIC → VOICE_RECOGNITION | 拒 | 并存 | 并存 | 并存 | 并存 |
  | MIC → MIC | 拒 | 拒 | 拒 | 并存 | 并存 |

  这份配置可以被厂商用同名文件覆盖，华为商用版有没有覆盖不知道【推断】。
- **反过来，二狗后开会挤掉先在录的一方**。VOICE_COMMUNICATION 作为后来者时（S24，6.0-Release 的文件，本文核对过）：
  - 已有 VOICE_RECOGNITION 在录：`action_type="PAUSE" action_on="existing"`，把它暂停；
  - 已有 MIC 在录：`action_type="STOP" action_on="existing"`，把它停掉。

  所以二狗在输入法正录着的时候预热，会把输入法挤掉。重新预热的时机要避开这种情况（见 3.7）。
- **播放也会挡**。只要网页开着录音，ArkWeb 之后新建的播放流都设成 VIDEO_COMMUNICATION 用途，音频框架把它归到 STREAM_VOICE_COMMUNICATION（S25 的适配层）。焦点表里，已有 STREAM_VOICE_COMMUNICATION 播放时，后来的 VOICE_RECOGNITION 录音被拒，MIC 可以并存（S24）。二狗的音量分析 AudioContext 是拿到麦克风之后才建的，【推断】它也算这种播放流。所以放开麦克风时，要把这个 AudioContext 一起关掉。现在的 `close()` 已经关了；不要为了"保留 AudioContext"而在鸿蒙上留着它（见 5.4）。
- **华为官方的说法**（S26，HarmonyOS 5 及以上）："敏感场景使用麦克风的优先级最高……如果应用A（敏感场景）已经在使用麦克风，应用B（不区分是否为敏感场景）使用麦克风，按照使用时间顺序抢占先到先得，此时应用A占用麦克风，应用B界面会提示麦克风被占用"。
- **关掉回声消除**：在 M132 上没用（录音源写死）。到了 M144，会改走 MIC，按 6.1 / 7.0 的焦点表，输入法就能和它并存【推断】。用户手机上的内核版本，从 UA 里的 `ArkWeb/x` 和 `Chrome/xxx` 看。

**HarmonyOS 2–4（兼容安卓）**：按 AOSP 的规则走（3.1）。华为浏览器在这些版本上的录音通路未找到资料。小艺输入法在这些版本上的官方提示是"【其他应用正在录音，请稍后再试】"，原因写的是"您的设备录音通道当前被其他应用占用"（S26）。

**其他**：

- 后台录音要申请长时任务，"在后台直接启动录音会失败"（S27）。
- API 23 起，宿主应用可以用 `pauseMicrophone` / `stopMicrophone` / `resumeMicrophone` 控制网页的麦克风，原文"stopMicrophone 会停止捕获并释放资源"（S27）。这对 18 号票的鸿蒙壳有用。华为浏览器有没有用这些接口，未找到。

### 3.7 同一页面里，能不能先放开麦克风

能，而且这是三个平台共同有效的解法。

- **放开要真正 `track.stop()`**，`enabled=false` 不行（14 号文档 5.1）。同一个 source 下的音轨（包括 clone 出来的）全部停掉，source 才会停（S12）。现在的 `close()` 已经停掉流上所有音轨，还关了音量分析。
- **放开有多快**（S12）：
  - Android Chrome：`stop()` 之后，AAudio 流先 `requestStop`，最多等 100 ms；Android 12 及以上随后同步 `AAudioStream_close`，没有输入流了就立即恢复 `MODE_NORMAL`。Android 11 及以下的 close 会延后 1 秒（crbug 1183255），但 `MODE_NORMAL` 会先恢复。
  - 输入法的语音键是键盘弹出之后才点的，通常比焦点晚几百毫秒以上，来得及【推断】。
- **页面能收到的信号**：

  | 信号 | Android Chrome | iOS Safari | 鸿蒙 ArkWeb | 说明 |
  |---|---|---|---|---|
  | 可编辑元素的 `focusin` / `focusout` | 有 | 有 | 有（同一套 Blink） | **最早、最准**。"发起任务"的 textarea 是 `autoFocus`，对话框一打开就触发 |
  | `visualViewport` 的 `resize` | 有（Chrome 108 起默认只缩视觉视口） | 有，但可能晚到（S23） | 未查 | 只能作辅助，判断键盘是否收起 |
  | VirtualKeyboard 的 `geometrychange` | 只在 `overlaysContent` 时有（S15） | 没有 | 未查 | 会改布局，不建议为此打开 |
  | `window` 的 `blur` / `focus` | **只在另一个 Activity 成为顶层时**（分屏另一侧、自由窗口）才触发；通知栏、键盘、悬浮窗、系统助理浮层**不触发**（S14）【推断】 | 未查 | 未查 | 可以补上分屏的情形 |
  | `visibilitychange` | 有 | 有 | 有 | 现在已经用了 |

- **重新预热的时机要避开正在录的输入法**：
  - 鸿蒙上，二狗的 VOICE_COMMUNICATION 是后来者时，会把已经在录的输入法暂停或停掉（3.6）；
  - Android 上，Chrome 在顶时会把输入法压成静音。
  - 所以要等到焦点离开、而且没有别的可编辑元素拿到焦点时再预热，再加一点延迟（比如 500 ms）。焦点从一个输入框跳到另一个输入框时，`focusout` 之后紧跟着 `focusin`，延迟正好把它吸收掉。
- **在 iOS 上**，这样做也避开了"听写之后音轨卡在 muted"：听写开始前二狗已经放开，焦点离开后重新 `getUserMedia`，拿到的是新的音轨【推断】。

## 4. 是不是 Web 都有这个两难

### 4.1 原生 App 怎么做到按下就录，又不一直占着

14 号文档 4.4 已经说明：Telegram、Signal 在 Android 和 iOS 上都是按下以后才建录音器，不预热，靠系统路径短，再用振动和动画遮一下。本次补了两件事：

- **原生启动有多快**：
  - AOSP 的 AAudio 客户端注释："It normally takes about 20-30 msec to start a stream on the server. But the first time can take as much as 200-300 msec"（S28）。这句话在 MMAP 路径里，讲的是播放，未必能原样套到输入上【推断】。
  - CTS 原来断言 "Verify recording starts within 200 ms of record.startRecording() (typical 100ms)"，后来改成超过 200 ms 只打警告，硬上限 5 秒（S28）。
  - iOS 只有论坛数据：`AudioOutputUnitStart` 约 200 ms，走 PTT 框架约 500 ms；从 playback 切到 playAndRecord 时可能要 3–4 秒（S30）【未核实】。Apple 没有公布 `setActive(true)` 的耗时，未找到。
- **原生有"建好但不占"的状态**。创建 AudioRecord 时只做权限预检（`checkPermissionForPreflightFromDatasource`）；`startRecording()` 时才正式开始计入麦克风使用（`checkPermissionForStartDataDeliveryFromDatasource`，S29）。并发规则也只按"正在录"的应用来算（S2）。【推断】只建不启动，不亮指示灯，也不挡别人。网页没有对应的状态。

微信、WhatsApp 的做法没有公开资料，未找到。

### 4.2 网页冷启动慢在哪，关掉回声消除能快多少

- **冷启动的各段**见 14 号文档 3.1–3.8：
  - 权限；
  - 打开设备、切通话模式、蓝牙 SCO、建处理模块；
  - `getUserMedia` 等采集真正开始才 resolve；
  - `new AudioContext` 可能同步等输出设备。
- **没有找到任何移动端的分段实测**。Chrome 自己有打点（S16）：
  - trace 事件：`MediaDevices.GetUserMedia`、`GenerateStreams`、`CreateAudioSource`、`AudioInputDevice::Start`、`AAudioStreamWrapper::AAudioStreamWrapper`；
  - UMA 直方图：`Media.MediaDevices.GetUserMedia.Latency`、`Media.AudioInputController.CreateTime` / `CloseTime`。
  - 这些只在本机 trace 或 Google 内部能看到。
- **关掉回声消除能快多少：没有实测数据**。按源码，Android Chrome 能省掉 `setMode(MODE_IN_COMMUNICATION)` 和通话通路的硬件 AEC 初始化【推断】。iOS 上 VPIO 比 RemoteIO 重，macOS 上创建 VPIO 有 2–3 秒的论坛报告，iOS 没有数字（S30）【未核实】。鸿蒙 M132 上没有区别。
- **`stop()` 之后再开要多久：没有找到数据**。按 14 号文档 3.5，source 停了就要重开设备、重建处理模块，基本等于冷启动。只能自己量（第 7 节）。

### 4.3 结论

| | 原生 | 网页 |
|---|---|---|
| 打开麦克风 | 20–30 ms，第一次 200–300 ms（Android） | 几百毫秒到一秒多；没有分段实测 |
| "建好但不占"的状态 | 有：AudioRecord 建好不启动 | 没有：`enabled=false` 不放设备 |
| 按下就录要不要一直占着 | 不用 | 要；或者接受冷启动 |
| 打字时被占用 | 不会：只在按住时开 | 现在会。**放开就不会了，这一半不是 Web 固有的** |

所以，"按下就录"和"不占着"的冲突，在网页上是固有的。能做的是**缩小占着的范围**：只在用户可能要按的时候占着，要打字时让开。

## 5. 办法逐个评估

| # | 办法 | 效果 | 代价 | Android | iOS | 鸿蒙 | 改动量 | 结论 |
|---|---|---|---|---|---|---|---|---|
| 1 | 关回声消除（降噪、自动增益照开） | 不切通话模式；播放不走通话音量；分屏另一侧能录 | 外放时可能录进正在播的声音（按住时已经停播，36 号票）；通话通路的硬件处理没了 | Chrome 153+ 才不再隐私敏感；**同页打字仍被占**（3.4） | 基本无影响 | M132 无影响；M144 起有用 | 极小：兜底 (b) 改成 true | 只作 A/B |
| 2 | 三项全关 | 和 1 一样 | 少了软件降噪、自动增益，声音可能偏小 | 和 1 一样（降噪、自动增益不影响通路） | Safari 本来不认后两项 | 无影响 | 极小 | 不建议 |
| 3 | **打字就让**（可编辑元素 `focusin` 时停掉，`focusout` 后预热） | **同页用输入法语音不再冲突**；iOS 也避开了"听写之后卡在 muted" | 刚打完字马上按，是冷启动 | 有效 | 有效 | 有效（注意重开会挤掉正在录的输入法，要延迟） | 小 | **推荐** |
| 4 | 失焦就让（`window` `blur` 时停掉，`focus` 时预热） | 补上分屏、自由窗口 | 同 3 | 只对分屏、自由窗口有效（S14） | 未查 | 未查 | 小 | 推荐，一起做 |
| 5 | **用完留 N 秒**（N = 30–60） | 平时不占着，指示灯大部分时间灭；连着发都快 | 闲置超过 N 秒后的第一次按下是冷启动；iOS 上隔 1 分钟以上重开可能弹权限框 | 有效 | 有效，但权限框要先设"允许" | 有效 | 中：把 44 号票去掉的计时加回来 | 看用户取舍 |
| 6 | 意图预热（agent 回了消息、关掉对话框、回到前台、焦点离开输入框时开 N 秒） | 减少 5 的冷启动 | 指示灯多亮一会儿；猜错了白开 | 有效 | 有效 | 有效 | 小（配合 5） | 配合 5 |
| 7 | `track.enabled=false` | 无 | 不放设备、不灭灯（14 号文档 5.1） | 无效 | 无效 | 无效（同一套 Blink）【推断】 | — | 不用 |
| 8 | `stop()` 之后重开；保留 AudioContext | 重开时省掉 `new AudioContext` 的同步等待 | AudioContext 留着，输出流可能一直开着 | 可以，挂起留着 | 可以，挂起留着 | **不要**：拿到麦克风之后建的 AudioContext 算通话类播放，会挡输入法（3.6）【推断】 | 小 | 只在 Android、iOS 上做；或者在拿麦克风之前就建 |
| 9 | 冷启动重排：先启动录音器，再建 AudioContext | 冷启动少丢一段 | 无 | 有效 | 有效 | 有效 | 小 | **做**（14 号文档早就建议过） |
| 10 | 冷启动补头：保持"准备中"，开录那一刻振动 | 让用户在开录后才开口，不丢字 | 用户等几百毫秒；用户否过"只给提示"，这里只用于冷启动 | `navigator.vibrate` 可用 | 没有 vibrate | 未查 | 小 | 和 5 一起做 |
| 11 | 静音检测（音轨 `muted`、连续全零采样） | 不再"即录"出空白；能提示被别的应用占着 | 全零是启发式，要防误判 | 只能靠全零（S13） | 靠 `mute` / `unmute`（S20） | 未查 | 小 | **做** |
| 12 | 预录（14 号文档推荐二） | 只在流开着时有用 | 见 14 号文档第 7 节 | — | — | — | — | 与本题无关，不变 |
| 13 | 原生壳（Capacitor、自建 WebView、TWA、ArkWeb 壳） | 根治：按下才开、几十毫秒、不占着 | 大：要构建、签名、安装、JS 桥 | 自建 WebView + 原生 AudioRecord 可行；TWA 不行 | 不现实 | ArkWeb + AudioCapturer 可行 | 大 | 并入 18 号票 |

下面展开几项。

### 5.1 关回声消除

- 现成的开关：36 号票的兜底 (b) `disableEchoCancellation`（`app/voice-fallbacks.ts`）。
- **Android**：先确认 Chrome ≥153。149 上关掉之后是 CAMCORDER，仍然隐私敏感。打开后的收益：
  - 播放不再走通话音量和通话路由（顺带解决 14 号文档 6.5 的遗留问题）；
  - 分屏另一侧的 App 能录；
  - 冷启动可能快一点（未测）。
  - 解决不了同页打字的冲突。
- **鸿蒙 M132**：没用。
- **iOS**：基本没用。
- 代价：外放时，正在播的 agent 语音可能被录进去。不过 VoiceInput 按住时已经停掉播放（`setCapturing`，36 号票），风险小。

### 5.2 打字就让、失焦就让

做法【推断，要实测】：

1. **监听**：在 `document` 上监听 `focusin` / `focusout`。目标是 `textarea`、`input`（文本类）或 `contenteditable` 时，`editing = true`。`focusout` 之后，下一个任务里再看 `document.activeElement` 是不是还在可编辑元素上。
2. **开关时机**：`voice-mic.ts` 加一个输入 `{ kind: "editing"; editing: boolean }`，`voiceMicWanted` 里多一个条件：`!editing`（按住时例外）。
3. **放开**：`editing` 变真时，立即 `close()`，停掉音轨、关掉音量分析。
4. **重新预热**：`editing` 变假后延迟 500 ms，仍在语音模式、页面可见、没有焦点在可编辑元素上，才 `open()`。
5. **失焦**：`window` 的 `blur` / `focus` 同样处理，作为另一个条件 `focused`。按 S1，`getUserMedia` 本来就要等页面有系统焦点，所以失焦时也不该去开。

### 5.3 用完留 N 秒

这就是 37 号票原来的"闲置 10 分钟关麦"，只是时间短得多，触发点也多：

- **开着的窗口**：从进语音模式、按下、松开、回到前台、`focusout` / `focus` 后重新预热、agent 回了消息（页面可见、在语音模式里）这些时刻起算，N 秒内开着，过了就关。
- **N 的取值**：建议 60 秒。理由：
  - 连着说几条（每条最长 60 秒，中间听回复）都在窗口里；
  - 和 iOS 的 1 分钟重新弹框时限对齐，在窗口里重开不会弹框；
  - 做成前端常量，0 表示不关，即 44 号票现在的行为。
- **代价要说清楚**：闲置超过 N 秒后第一次按下是冷启动。界面上出"准备中"（现有逻辑），开录那一刻在 Android 上振动一下。用户在开录之前说的话会丢，丢多少取决于冷启动耗时，要真机量。
- **用户曾否决过**"按住才开麦，用完再多开一会儿"（14 号文档开头的 (b)）。这里不同的是：进语音模式时就预热，第一条不冷；agent 回消息时也预热，"听完回复再说"不冷。冷的只有"放着很久后突然说话"这一种情况。是否接受，交给用户。

### 5.4 `stop()` 之后重开；保留 AudioContext

- 重开的主要开销是 `getUserMedia`，保留 AudioContext 只省掉构造时的同步等待（14 号文档 3.3）。
- 在 Android 和 iOS 上，可以把音量分析的 AudioContext 挂起（`suspend()`）留着，重开时 `resume()`，再接一个新的 `MediaStreamAudioSourceNode`。
- 在鸿蒙上不要这样做：拿到麦克风之后建的 AudioContext 会被 ArkWeb 设成 VIDEO_COMMUNICATION 播放，这种播放流会拒绝后来的 VOICE_RECOGNITION 录音（3.6）。要么照现在这样关掉，要么在拿麦克风之前就建好。后者在鸿蒙上是否不受影响，要用 hilog 确认。
- agent 语音的播放器（`page-voice.ts` 的 Web Audio 调度器、`<audio>`）也一样：在麦克风开着时新建的话，鸿蒙上可能是通话类播放【推断】。真机上要查播放期间输入法能不能用。

### 5.5 静音检测

- **iOS**：监听音轨的 `mute`、`unmute`、`ended`。`warm` 改成 `readyState === "live" && !muted`。按下时音轨是 muted，就当作没预热：停掉、重新 `getUserMedia`，出"准备中"。
- **Android**：页面收不到 `mute`（S13）。按下时读音量分析的时域数据，最近几百毫秒全是精确的 0（软件处理之后，零进零出），就判定为被静音。录完之后，再检查整段的电平，几乎全零时提示"麦克风可能被别的应用占着，没录到声音"，不发送。
- 两种情况都写进诊断记录（第 7 节），用来证实或推翻 3.4、3.5 的推断。

### 5.6 原生壳

- **PWA / WebAPK**：仍然是 Chrome 渲染，走同一条 `getUserMedia` 路径（S31），没有帮助。iOS 主屏 Web App 的权限还不跨次保留（S33）。
- **TWA**：页面由用户的 Chrome 渲染，宿主 App 碰不到页面。Chrome 115 起有 postMessage，理论上可以让宿主录音。但宿主那时在后台，要开麦克风类型的前台服务，而前台服务只能在有可见 Activity 时启动（S31）。不可行。
- **Capacitor / 自建 Android WebView 壳**：Android WebView 也是 Chromium，`getUserMedia` 走同一份 `media/audio/android` 代码（S32）【推断】，所以录音要改走 JS 桥调原生 AudioRecord。按下时 `startRecording()`，几十毫秒，用 MIC 源、不切通话模式，松开就释放。现成的 capacitor-voice-recorder 用 MediaRecorder、录完整段才返回，没有启动延迟的说法（S32）。
- **鸿蒙 ArkWeb 壳**：JS 桥（`javaScriptProxy` / `registerJavaScriptProxy`）调原生 AudioCapturer（S27）。还可以用 API 23 起的 `stopMicrophone` 从宿主一侧放开网页的麦克风。用户有华为开发工具，18 号票本来就打算为推送做鸿蒙壳，JS 桥清单里也列了"录音"。
- **iOS**：要么交 Apple 开发者年费，要么用免费 Personal Team 签名，7 天过期、最多 3 台设备（S33）。不现实。
- **结论**：能根治 Android 和鸿蒙，但是大工程，iOS 仍然只能靠网页。建议并入 18 号票，不为这个问题单独做。

## 6. 推荐方案

### 推荐一：打字就让（先做）

语音模式里照旧预热、按下即录。在此基础上加：

- 可编辑元素获得焦点、页面失焦时，立即放开；
- 焦点回来 500 ms 后，重新预热；
- 按下时检查流有没有被静音；
- 冷启动重排：先启动录音器，再建音量分析；
- 诊断（第 7 节）。

| 情况 | 麦克风 | 按下时 |
|---|---|---|
| 进语音模式 | 开（同现在） | — |
| 按下、松开 | 一直开着 | 即录（62–72 ms） |
| 连着发 | 一直开着 | 每条都即录 |
| 打开"发起任务"、在卡片上打字、用输入法语音 | `focusin` 时**立即关**；焦点离开 500 ms 后重新开 | 刚离开输入框就按：冷启动，"准备中" |
| iPhone 上用系统听写 | 同上：听写前就已经关了 | 同上 |
| 分屏另一侧获得焦点 | `blur` 时关，`focus` 时开 | 同上 |
| 下拉通知栏、悬浮窗里用输入法 | 仍然开着（页面收不到信号） | 可能被占用：残留问题 |
| 被别的应用抢走（iOS muted；Android 全零） | 按下时发现，重开 | 冷启动，"准备中"；不发空白 |
| 切后台 | 关（同现在） | 回到前台重新预热 |
| 语音模式里闲置 | 开着（同 44 号票） | 即录 |

- **改动量**：
  - `state/voice-mic.ts`：加 `editing`、`focused`（或合成一个 `away`）两个输入和条件，补表格测试；
  - `app/voice-session.ts`：加 `document` 的 `focusin` / `focusout`、`window` 的 `blur` / `focus` 监听、500 ms 延迟、音轨 `mute` 监听；
  - `app/voice-recorder.ts`：`warm` 看 `muted`；`open()` 冷启动时先交出流、后建音量分析，或者由 session 在 `begin` 之后补建；全零检测；
  - 诊断字段：协议 `VoiceCapture`、守护进程 `captureOf`、前端。
- **不解决的**：语音模式期间指示灯照样常亮，观感问题还在。

### 推荐二：推荐一 + 用完留 60 秒（叠加，用户取舍）

在推荐一上，再加"开着的窗口"：每次预热或使用，都把窗口续到 60 秒之后；过了就关。

| 情况 | 麦克风 | 按下时 |
|---|---|---|
| 进语音模式 | 开，60 秒 | 即录 |
| 按下、松开 | 开着；松开时续到 60 秒后 | 即录 |
| 连着发（间隔 < 60 秒） | 一直开着 | 每条都即录 |
| agent 回了消息（页面可见、在语音模式里） | 开，60 秒（"听完再回"不冷） | 即录 |
| 打字、用输入法语音、听写、分屏 | 同推荐一：立即关；回来后开 60 秒 | 刚回来就按：冷启动 |
| 闲置超过 60 秒 | **关**，指示灯灭 | **冷启动**："准备中"，开录时振动（Android）；开录前说的话会丢 |
| iPhone 上闲置超过 60 秒后按下 | 关着 | 冷启动；网站麦克风设置不是"允许"时，**可能弹权限框** |
| 下拉通知栏、悬浮窗里用输入法 | 60 秒窗口内仍然开着；之后就关了 | — |
| 切后台 | 关（同现在） | 回到前台开 60 秒 |

- **改动量**：在推荐一的基础上，把 44 号票去掉的计时加回来：状态里放 `openUntil`，加 `tick` 输入，session 里放计时器；加意图预热的入口（agent 新消息到达时调一下 session）。这一项是中等改动。
- **N 做成前端常量**：0 表示不关。

### 怎么选

- **用户主要烦的是"输入法提示占用"**：推荐一就够了，而且不牺牲"按下即录"。
- **用户也烦"指示灯一直亮"**：要加推荐二，并接受"放久了第一下要等"。先用诊断量出用户手机上的冷启动耗时，再决定 N。冷启动在 300 ms 以内的话，"准备中"加振动基本察觉不到；一秒以上就明显了。
- **回声消除**：两种方案都先保持开着，用兜底 (b) 做 A/B。Android 要先升到 Chrome 153 以上。

## 7. 在真机上验证

### 7.1 每条语音的诊断（在 `capture { startDelayMs, prewarmed }` 上加）

协议 `VoiceCapture` 对多带的字段不拒收，但守护进程的 `captureOf` 只留认得的字段；37 号票评审还记下"诊断字段类型不对时网关会拒整条消息"。所以三处都要改：协议、守护进程、前端。新字段先进 schema，并且一律可选、宽松。

| 字段 | 取法 | 用来看什么 |
|---|---|---|
| `inputDelayMs` | 处理函数开头的 `performance.now()` 减 `e.timeStamp` | 手指落下到代码开始跑 |
| `holdMs` | 抬手的 `e.timeStamp` 减按下的 `e.timeStamp` | 服务端算缺头：`headLossMs ≈ holdMs − 识别出的音频时长`（14 号文档 9.3） |
| `warmForMs` | 按下时刻减这次流就绪的时刻 | 预热开了多久 |
| `cold` | 没命中时：`{ gumMs, meterMs, openReason }`。`gumMs` 是 `getUserMedia` 从调用到 resolve；`meterMs` 是建音量分析的耗时；`openReason` 是这次为什么开 | **冷启动各段**，决定推荐二的 N |
| `mutedAtPress` / `zerosAtPress` | 按下时音轨的 `muted`；按下前 300 ms 是否全零 | 验证 3.4、3.5 的"被静音"推断 |
| `levelMax` | 整段录音的最大音量 | 录到空白的直接证据 |
| `settings` | `track.getSettings()` 里的 `echoCancellation`、`noiseSuppression`、`autoGainControl`、`sampleRate` | 实际生效的约束（Safari 没有后两项） |
| `variant` | `{ aec, idleMs, yieldOnEdit }` | 这条是哪种配置录的（A/B） |
| `browser` | `navigator.userAgent`；Chromium 上再取 `navigator.userAgentData.getHighEntropyValues(["platformVersion","model","fullVersionList"])` | Chrome 是不是 ≥153、Android 是不是 ≥12、ArkWeb 是 M132 还是 M144、机型 |
| `micLog` | 见 7.2 | 开关时刻和原因 |

### 7.2 麦克风开关记录 `micLog`

在前端模块里放一个环形缓冲（比如 60 条），记从上一条语音到这一条之间的事件。随这条语音带走，时间换算成"按下前多少毫秒"。

| 事件 | 附带 | 何时记 |
|---|---|---|
| `open` | `reason`：`enter` / `visible` / `focus` / `edit-out` / `press` / `intent-reply` / `retry-muted` | 开始要麦克风 |
| `ready` | `gumMs`、`meterMs` | 流就绪 |
| `fail` | 错误名 | 要不到 |
| `close` | `reason`：`leave` / `hidden` / `edit-in` / `blur` / `idle` / `playback` / `muted` | 停掉音轨 |
| `mute` / `unmute` / `ended` | — | 音轨事件 |
| `zeros` | 持续毫秒数 | 开着时连续全零超过 500 ms |
| `edit-in` / `edit-out`、`blur` / `focus`、`hidden` / `visible` | — | 页面信号（即使没引起开关也记） |

另外，建议在"设置 · 语音"页加一个"麦克风记录"小节，列出最近 60 条。这样用户试完输入法，不用发语音就能截图看。只放在内存里，刷新就没了。

服务端汇总（本机接口 `voices[].capture`）时，每条再算两个数：

- `micOnMs`：两条语音之间麦克风开着的总时长，看推荐二到底省了多少；
- `coldPresses`：冷启动次数。

### 7.3 测试步骤（每台手机：Android Chrome、iPhone Safari，有鸿蒙机的加华为浏览器）

0. **记版本**：
   - Android 打开 `chrome://version`，149 的先升级到 153 以上再测回声消除那一项；
   - 鸿蒙看 UA 里的 `ArkWeb/` 和 `Chrome/`；
   - iPhone 在 Safari 网站设置里看麦克风是"询问"还是"允许"。
1. **打字让麦**（推荐一）：
   - 进语音模式，打开"发起任务"，在输入框里用输入法的语音（小艺 / 讯飞 / Gboard；iPhone 用系统听写）。
   - 预期：不提示占用；记录里先有 `close(edit-in)`。
   - 关掉对话框，1 秒后按下念"ABCDEFG"。预期 `prewarmed=true`，`warmForMs` 约 500 ms 以上。
   - 在改之前的版本上也做一遍，作对照：应当提示占用；iPhone 上听写之后，记录里有 `mute`。
2. **连着发**：连续 5 条。预期全部 `prewarmed=true`，`startDelayMs` 仍是 60–70 ms。
3. **冷启动**（推荐二）：
   - 静置 70 秒，看状态栏指示灯灭了没有；
   - 按下念"ABCDEFG"，做 5 次，回放听第一个字母，记 `cold.gumMs`、`startDelayMs`、`headLossMs`；
   - 回声消除开、关各一轮；
   - iPhone 上看静置之后按下会不会弹权限框。
4. **被抢走**：
   - iPhone：在改之前的版本上，语音模式里用一次听写，再按下说话。看 `mutedAtPress`，回放有没有声音。
   - Android：语音模式里开一个通话类 App（微信语音），挂断后回来按下，看 `zerosAtPress`、`levelMax`。
5. **分屏、悬浮窗**（Android / 鸿蒙）：二狗和另一个 App 分屏，在另一侧用输入法语音；再在悬浮窗里试一次。看记录里有没有 `blur`，有没有提示占用。
6. **切后台**：在二狗语音模式里切到微信，马上用输入法语音。预期不冲突，记录里有 `close(hidden)`。
7. **播放**：语音模式里播一条 agent 语音，回声消除开、关各听一次音量；鸿蒙上播放期间在别处用输入法语音，看会不会被拒（3.6 的播放流）。

### 7.4 可选：系统侧证据

- **Android**（USB 调试）：
  - 在输入法语音时运行 `adb shell dumpsys media.audio_policy` 和 `adb shell dumpsys audio`；
  - 看各录音客户端的 app state、是否 silenced、输入法的 UID、音频模式和持有者；
  - 可以直接证实 3.2、3.4 的推断。
- **鸿蒙**：
  - 用 `hdc shell hilog`，搜 `request rejected`、`The incoming audio capturer should be denied`、`[webrtc_logging]`；
  - 看实际的录音源和被拒的是谁（S24、S25）。

## 8. 开放问题与对 14 号文档的更正

**更正 14 号文档**：

- 3.2：关掉回声消除后用 GENERIC 预设，只在 Chrome 153 以后成立，之前是 CAMCORDER，仍然隐私敏感。
- 6.6：iOS 上重新弹权限框的时限是"采集停了 1 分钟"，和用户手势无关；手势只影响被拒过的请求能不能再问。

**开放问题**：

- Android 上输入法实际凭什么判断"占用"（静音、全零，还是看通话模式），各输入法是否不同：没有资料，只能真机看。
- 华为的商用 ROM 有没有覆盖焦点表、有没有改 AOSP 的并发规则；小艺输入法是不是系统应用、能不能绕过焦点表（S24 提到系统应用的 MIX_WITH_OTHERS 例外）。
- iOS 听写和 Safari 采集到底谁让谁，听写之后 `unmute` 会不会来。
- 下拉通知栏、悬浮窗、系统助理浮层里用输入法：页面收不到任何信号，推荐一管不到，只有推荐二的 60 秒窗口能兜住。
- 冷启动和 `stop()` 之后重开的实际耗时：只能靠 7.1 的 `cold.gumMs` 量。推荐二的 N、要不要做推荐二，都取决于这个数。
- 鸿蒙上，拿麦克风之前建的 AudioContext、agent 语音的播放器，会不会被设成通话类播放并挡住输入法。
