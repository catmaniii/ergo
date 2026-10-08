# 63 — 鸿蒙 App 的原生录音：录音器备好但不占麦克风，按下立刻开录，接到网页

Status: ready-for-agent
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

- [ ] **原生录音器**：在 `frontend/harmony` 里用 `@kit.AudioKit` 的 `AudioCapturer` 实现。
  - 采样参数适合语音识别，比如 16kHz、单声道、16 位。
  - 音源类型选能让系统输入法并存、延迟最低的那种：先查文档，在 Comments 写清楚选了哪个、为什么。
  - 能用低时延模式的就用。
- [ ] **生命周期**：
  - **进语音模式**：网页通知原生，原生创建并 `prepare`，进入 PREPARED，不 `start`，麦克风指示灯不亮。
  - **按下**：`start()`。
  - **松手**：`stop()`，交出这一段。
  - **离开语音模式、App 切到后台**：`release()`。
  - **验证不占用**：要验证 PREPARED 状态不挡系统输入法的语音输入。真机上验证不了的，写进待验清单。
- [ ] **原生桥**：62 号票的 `ergouNative` 加录音这一组接口：
  - 备好、开始、停止（交出音频）、丢弃、释放；
  - 实时音量：给音量面板用，节流，比如 50 毫秒一次；
  - 错误：权限没给、录音器创建失败等。

  音频怎么交给网页（ArrayBuffer、base64、或原生先写临时文件再给网页读）由实现定，写进 Comments。格式用 WAV（PCM），网页照常走上传接口。
- [ ] **网页一侧**：
  - `packages/web` 的录音加一个"原生后端"：检测到 `ergouNative` 的录音接口时用它，否则照旧用 getUserMedia。
  - 手势、上划取消、太短、60 秒自动发送、"准备中"、按下到开录的计时都沿用现有的状态层，只换掉底下的采集。
  - 原生后端下，61 号票的"打字时让路"不再需要关麦，因为 PREPARED 本来就不占用；状态层按后端区分。
  - 用假的原生桥写测试：
    - 进语音模式只备好、不开始；
    - 按下才开始；
    - 松手交出音频；
    - 离开语音模式时释放；
    - 出错时退回 getUserMedia 或提示。
- [ ] **守护进程**：用户语音接受 WAV（`audio/wav`）。现在只认 webm 之类的话，在这里补上；识别照常。主切面测试覆盖一条 WAV 语音从上传到识别完成。
- [ ] **测量**：沿用 `capture` 诊断字段，记录：
  - 后端是原生还是网页；
  - 按下到原生录音器真正开始（第一块数据）的毫秒数；
  - 备好用了多久。

  本机接口取得到。
- [ ] **构建**：`npm run build:harmony` 产出带原生录音的 HAP。`docs/dev.md` 的"鸿蒙 App"一节写清楚原生录音怎么工作、怎么在真机上看计时。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 真机验证要用户配合：签好名装到手机上，试以下几项，结果写进 Comments：
  - 进语音模式后指示灯亮不亮；
  - 按下念"ABCDEFG"，开头丢不丢；
  - 在"发起任务"里用输入法的语音，还报不报"麦克风被占用"。
- 39、43、45、61 号票同时在改前端，收尾前变基到最新 main。

## Comments
