# 63 — 鸿蒙 App 的原生录音：录音器备好但不占麦克风，按下立刻开录，接到网页

Status: done
Blocked by: 62（鸿蒙 App 原生壳）, 61（麦克风让路，网页一侧的录音状态）
Spec: [第一阶段规格](../spec.md) 第 19 节"鸿蒙 App"、第 22 节"麦克风预热"

## What to build

用户 2026-10-09 要求：在鸿蒙原生 App 里，用操作系统自带的录音能力解决麦克风问题，不用网页内置的 getUserMedia。目标仍然是降低按下后的延迟，做法是调研 16 说的"准备好但不使用"状态：

- 原生侧在进语音模式时创建并准备好录音器（`AudioCapturer` 的 PREPARED 状态），这时不真正采集；
- 按下时才 `start()`；
- 松手 `stop()`；
- 录好的音频交给网页，网页照常上传、发送。

这样既不一直占着麦克风（系统输入法照样能用），按下又几乎没有延迟。

背景：
- 调研：`docs/research/16-voice-mic-hold-vs-instant.md` 讲了原生 App 的做法和鸿蒙的并发录音规则；`docs/research/14-voice-capture-latency.md`。
- 网页一侧的录音逻辑：37、44、61 号票，`packages/web/src/state/voice-mic.ts`、`voice-gesture.ts`、`app/voice-session.ts`、`app/voice-recorder.ts`、`app/voice-browser.ts`。

## Acceptance criteria

- [ ] **原生录音器**：在 `frontend/harmony` 里用 `@kit.AudioKit` 的 `AudioCapturer` 实现。（录音器、采样参数、音源都做了；低时延模式没做，用户 2026-10-09 定：先在真机上测现在的，不够快再另开票用 OHAudio 做，见 Comments）
  - 采样参数适合语音识别，比如 16kHz、单声道、16 位。
  - 音源类型选能让系统输入法并存、延迟最低的那种：先查文档，在 Comments 写清楚选了哪个、为什么。
  - 能用低时延模式的就用。
- [x] **生命周期**：
  - **进语音模式**：网页通知原生，原生创建并 `prepare`，进入 PREPARED，不 `start`，麦克风指示灯不亮。
  - **按下**：`start()`。
  - **松手**：`stop()`，交出这一段。
  - **离开语音模式、App 切到后台**：`release()`。
  - **验证不占用**：要验证 PREPARED 状态不挡系统输入法的语音输入。真机上验证不了的，写进待验清单。
- [x] **原生桥**：62 号票的 `ergouNative` 加录音这一组接口：
  - 备好、开始、停止（交出音频）、丢弃、释放；
  - 实时音量：给音量面板用，节流，比如 50 毫秒一次；
  - 错误：权限没给、录音器创建失败等。

  音频怎么交给网页（ArrayBuffer、base64、或原生先写临时文件再给网页读）由实现定，写进 Comments。格式用 WAV（PCM），网页照常走上传接口。
- [x] **网页一侧**：
  - `packages/web` 的录音加一个"原生后端"：检测到 `ergouNative` 的录音接口时用它，否则照旧用 getUserMedia。
  - 手势、上划取消、太短、60 秒自动发送、"准备中"、按下到开录的计时都沿用现有的状态层，只换掉底下的采集。
  - 原生后端下，61 号票的"打字时让路"不再需要关麦，因为 PREPARED 本来就不占用；状态层按后端区分。
  - 用假的原生桥写测试：
    - 进语音模式只备好、不开始；
    - 按下才开始；
    - 松手交出音频；
    - 离开语音模式时释放；
    - 出错时退回 getUserMedia 或提示。
- [x] **守护进程**：用户语音接受 WAV（`audio/wav`）。现在只认 webm 之类的话，在这里补上；识别照常。主切面测试覆盖一条 WAV 语音从上传到识别完成。
- [x] **测量**：沿用 `capture` 诊断字段，记录：
  - 后端是原生还是网页；
  - 按下到原生录音器真正开始（第一块数据）的毫秒数；
  - 备好用了多久。

  本机接口取得到。
- [x] **构建**：`npm run build:harmony` 产出带原生录音的 HAP。`docs/dev.md` 的"鸿蒙 App"一节写清楚原生录音怎么工作、怎么在真机上看计时。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 真机验证要用户配合：签好名装到手机上，试以下几项，结果写进 Comments：
  - 进语音模式后指示灯亮不亮；
  - 按下念"ABCDEFG"，开头丢不丢；
  - 在"发起任务"里用输入法的语音，还报不报"麦克风被占用"。
- 39、43、45、61 号票同时在改前端，收尾前变基到最新 main。

## Comments

- **实现**（2026-10-09）：
  - **原生**（`frontend/harmony/entry/src/main/ets/voice/NativeVoice.ets`）：AgentSense 没有原生录音，照鸿蒙官方的 AudioCapturer 用法写。16 kHz、单声道、16 位小端 PCM（`SAMPLE_FORMAT_S16LE`、`ENCODING_TYPE_RAW`）。状态机：没有录音器 →（`voicePrepare`）要权限 → `createAudioCapturer` → PREPARED（不采集）；→（`voiceStart`）`start()` → RUNNING，`readData` 收 PCM、每 50 毫秒推一次音量；→（`voiceStop`）`stop()` → STOPPED（下一条直接 start，不重建），交出 PCM；`voiceDiscard` 停下扔掉；`voiceRelease` → `release()`。录音器上的异步操作排成一队；每放掉一次 generation 加一，还没建好的那次建好后马上放掉；每个录音器一个编号 `id`，推给网页的都带着。App 自己也放：`onPageHide`（切到后台）、`onPageBegin`（页面重新加载）、换地址、页面拆掉，推 `released`。录着的时候 `audioInterrupt` 是 STOP / PAUSE（来电、别的应用要麦克风）：放掉，推 `error interrupted`。
  - **原生桥**（`bridge/NativeBridge.ets`）新加：`voicePrepare(userAction): Promise<string>`、`voiceStart(): Promise<string>`、`voiceStop(): Promise<string>`、`voiceDiscard()`、`voiceRelease()`，都在 `NATIVE_BRIDGE_METHODS`（同步方法回 Promise），开头都过 `allowed()`，拒绝时回空串（网页当失败）。推送：`Index.ets` 用 `controller.runJavaScript` 调 `window.__ergouVoice(json)`：`{ type: "level", id, rms }`、`{ type: "error", id, reason: "interrupted", message }`、`{ type: "released", id, reason }`；推之前核对主框架还是配好的来源（`pageFromServer`，`allowed()` 也改用它，同一个口径），跳到了别的地址就不推（评审后加）。
  - **评审后改的**（2026-10-09）：`NativeVoice.ets` 里会抛异常的系统调用都包了 try、失败打 hilog（照 AgentSense）：`listen()`（挂 readData、audioInterrupt、stateChange）挪到留下录音器之前，挂不上就放掉它、回"录音器接不上"（网页提示、歇着），不再留下一个没挂 readData 的录音器；`getUptime` 取不到退回 `Date.now()`；base64 编码失败回失败。`voiceStart` 不再回 `startMs`（网页没用，按下到开录看停下时的 `firstDataMs`）。`state/voice-mic.ts` 里按后端区分合成一处（`occupiesMic`、`returningFrom`）。
  - **网页**：`app/native-voice.ts`（包装、解析、base64，回的不对一律当失败不抛错，`detectNativeApp` 在录音这一组方法都在时给出 `NativeApp.voice`，并登记 `window.__ergouVoice`）；`app/voice-native-recorder.ts`（`NativeVoiceRecorder`，和浏览器的 `VoiceRecorder` 同一个接口 `VoiceCaptureBackend`）；`app/voice-wav.ts`（加 WAV 头、量最大振幅）；`VoiceSession` 有 `env.native` 就用原生（`voice-browser.ts` 从 `pageNativeApp()?.voice` 取，`voiceSupport()` 在 App 里有原生录音时直接可用）；状态层 `state/voice-mic.ts` 加 `backend`（`web` / `native`）。`Composer` 的语音文件名认 wav。
  - **守护进程**：本来就按内容认 WAV（`media/audio.ts`），识别、播放不用改；`VoiceCapture` 加了 `backend`、`prepareMs`、`firstDataMs`（协议包 schema 和 `voice.ts` 的 `captureOf`，宽松整理）。主切面 `test/main/voice.test.ts` 加了一条 WAV 从上传到识别完成（`helpers/voice.ts` 的 `fakeWavRecording`：标准 16 kHz 单声道头 + 0.1 秒样本 + 一个自定义块装给假识别进程的指令）。
- **决定**：
  - **音源 `SOURCE_TYPE_MIC`**。查了 OpenHarmony `audio_interrupt_policy_config.xml` 里录音之间的焦点规则（GitCode 上 OpenHarmony-6.0-Release、6.1-Release、master 三份下载核对；评审指出后重查：先前拿的 Gitee 镜像的 master 是旧的、和 6.0 一样，所以原来写的"6.0 和 master 一样"不对）。各版本都一样的：已有 MIC 在录、后来 VOICE_RECOGNITION：并存；已有 VOICE_RECOGNITION、后来 MIC：并存；已有 VOICE_RECOGNITION、后来 VOICE_MESSAGE：把正在录的暂停；已有 VOICE_MESSAGE、后来 VOICE_RECOGNITION：拒；VOICE_COMMUNICATION 在录时后来的 MIC、VOICE_RECOGNITION 都拒（还开 3A）。分版本的：OpenHarmony 6.0 里"MIC→MIC 也是拒""已有 VOICE_MESSAGE、后来 MIC：拒"（VOICE_RECOGNITION→VOICE_RECOGNITION、VOICE_MESSAGE→VOICE_MESSAGE 也拒）；6.1 和 master 这几条改成了并存。输入法的语音多半走 VOICE_RECOGNITION，所以 MIC 是三种里唯一各个版本、两个方向都能和它并存的；MIC 不开 3A，启动最轻。不过二狗只在按住时才 start，平时 PREPARED 不申请焦点（官方"音频焦点"：开始录制时系统才为音频流申请焦点，结束时释放），这条规则只在"按住说话的同时输入法也在录"时才用得上。华为商用 ROM 是否覆盖了焦点表不知道。
  - **低时延没用上（第一条验收因此没勾）**：ArkTS 的 `AudioCapturerInfo.capturerFlags` 文档只写"设置为 0 即可"，低时延通路（`OH_AudioStreamBuilder_SetLatencyMode(AUDIOSTREAM_LATENCY_MODE_FAST)`）只在 C 接口 OHAudio 里，要写 NAPI（C++）模块、改构建。**用户 2026-10-09 定：先在真机上测现在的（`startDelayMs`、`firstDataMs`），不够快再另开票用 OHAudio 做。**
  - **音频怎么交给网页**：`voiceStop` 回 `Promise<string>`，JSON 里 PCM 用 base64（60 秒约 2.5 MB 字符串），网页加 44 字节 WAV 头、按 `audio/wav` 照常上传。不用 `asyncMethodList`：官方文档写"异步方法无法获取返回值"（62 号票注释里"网页那边拿到的是 Promise"不对，已改正注释和 `docs/dev.md`）；同步方法回 Promise 是官方文档的用法。不用临时文件：网页读不到 App 沙箱里的文件，要另开自定义协议或拦截请求，没必要。WAV 头在网页加：纯函数好测，App 只管 PCM。
  - **格式不用改**：守护进程本来就认 WAV、faster-whisper 照常识别（主切面测过），所以没动守护进程收的格式。
  - **按后端区分**：原生后端不让路（打字、分屏照样备着，没有那 0.5 秒），兜底 (a)（播放时关麦）也不管，因为备好的录音器不占麦克风也不影响播放；离开语音模式、切到后台照样放掉，权限、歇着的规矩不变。主会话的转述里写了"61 号票的规则仍然适用：打字时让路"，票里写的是"原生后端下打字时让路不再需要关麦"，我照票做；真机上要是 PREPARED 仍然挡输入法，把 `voiceMicCloseReason` 里 `edit-in`、`blur` 两条的 `web &&` 去掉就恢复让路。
  - **出错时**：旧版 App 没有录音这一组方法（检测时）→ 照旧 getUserMedia；在 App 里运行时出错（没权限、建不起来、开始不了、被打断）→ 提示，不在运行中途改用 getUserMedia（那样又回到占着麦克风，状态也要跟着换后端）。没权限的提示是"到手机的设置 › 应用和元服务 › 二狗 › 权限里打开麦克风"；拒过之后网页不再自动要，按下时 App 弹"去设置里打开"的框（`requestPermissionOnSetting`）。
  - **不发空白语音**：原生录音直接看整段 PCM 的最大振幅（阈值同 61 号票 `VOICE_SILENT_PEAK`），静音就不发、放掉录音器重新备好。
  - **测量**：`startDelayMs` = 网页按下到调进 App 的那一截 + App 里 `start` 调进来到第一块 `readData` 的毫秒数（`firstDataMs`，单调时钟 `systemDateTime.getUptime`）；`prepareMs` 是 `createAudioCapturer` 的毫秒数；`micLog` 的 `ready` 带 App 报的录音器状态（应当是 `PREPARED`）。
- **测试**：第一轮 `ERGOU_TEST_WORKERS=2 npm run check` 从 PowerShell 起，60 条挂在"找不到 Git Bash"（PATH 上没有 Git 的 bash.exe），从 Git Bash 里重跑那几个文件全过。评审后的修改变基到 `0ba7cac6`（58 号票）之后，从 Git Bash 里重跑全量：类型检查、oxlint 干净，vitest 203 个文件 3041 条全过（706 秒）。
- **构建**：第一轮 `npm run build:harmony` 成功，有两条 ArkTS 警告（`listen()` 里的 `capturer.on` 可能抛异常）。评审后包了 try、变基之后再构建一次：成功，没有 ArkTS 警告，`entry-default-unsigned.hap` 151.9 KB。
- **真机待验**（我没往设备、模拟器上装任何东西；步骤和看哪些字段写在 `docs/dev.md`"鸿蒙 App · 原生录音 · 真机上怎么验"）：
  - 进语音模式后麦克风隐私指示灯亮不亮（预期不亮；hilog 里 `prepared … state PREPARED`）；
  - 按下念"ABCDEFG"，开头丢不丢；`capture` 的 `backend: "native"`、`prewarmed`、`startDelayMs`、`firstDataMs`、`prepareMs`；
  - 在"发起任务"里用输入法的语音，还报不报"麦克风被占用"（`micLog` 里应当没有 `close edit-in`）；分屏另一边用输入法语音；
  - 切后台再回来（`released background` / `close hidden`，然后 `open visible`、`ready`）；
  - 按住时来电（提示被打断、不发）；关掉麦克风权限后进语音模式、按下（弹"去设置里打开"）；
  - ArkWeb 里同步方法回的 Promise 网页能不能拿到、2.5 MB 的 base64 字符串过桥有没有问题（录满 60 秒发一条）。

- 2026-10-09 完成：两轴评审后改了 listen() 的顺序和异常处理、推送前核对来源、焦点规则按 OpenHarmony 版本写。低时延模式那条没勾：用户定了先在真机上测现在的延迟，不够快再另开票用 OHAudio 做。真机测试由主会话安装、取日志。

- 2026-10-09 真机测过（两台鸿蒙手机，10 条原生录音）：全部预热好；按下到收到第一块数据中位 144 毫秒、最慢 176；准备录音器中位 21 毫秒；"ABCDEFG""1234567"开头不丢。用户说延迟还可以，不用进一步改：低时延模式（OHAudio）不做。
