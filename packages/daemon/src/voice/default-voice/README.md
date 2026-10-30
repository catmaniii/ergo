# 内置的默认参考音色素材

二狗开源版自带的那条默认参考音色（显示名"小满" / "Xiaoman"，数据目录里叫 `v-default`）的素材。
首次启动时如果数据目录的 `voices` 区一条参考音色都没有，守护进程把这里的东西原样装进去、设成在用的音色（ADR-0036）。

- `reference.wav`：参考录音。16 kHz、单声道、16 位 PCM，8496 毫秒（8.5 秒），271952 字节，
  sha256 `df84fd844b1c73a17ec8b66d82f0c437ec15064d5c9236fb2a4d8fb4dd6aa47b`。
- `reference.txt`：这段录音的逐字稿，和录音里念的一字不差。克隆（FireRedTTS3）要录音和逐字稿同时给；
  逐字稿是照录音原文抄的，不是语音识别出来的。

## 怎么来的

- 模型：audio.cpp 上的 FireRedTTS3-Instruct（voice design，不是克隆某个真人的声音）。上游是
  [FireRedTeam/FireRedTTS3](https://huggingface.co/FireRedTeam/FireRedTTS3)，Apache-2.0。
- 合成参数：instruct 写的是"一个十岁男孩的声音，清脆活泼，语速自然，像在跟家里人说话"。
- 后处理：整体降 2 个半音（音高，不改语速）。
- 这次交付的是 24 kHz 的原始产物用 ffmpeg 重采样成 **16 kHz、单声道、PCM16** 的那一份
  （`-af aresample=resampler=soxr:precision=28 -ac 1 -ar 16000 -c:a pcm_s16le`）。
  和"用户导入的录音在导入时被转成什么格式"，存下来的是同一种格式；也正因为素材已经是最终格式，
  首次启动装它不需要装 ffmpeg、不需要识别进程、不需要联网。
- 没有重新合成，也没有别的处理（没做响度、降噪、剪辑）。

## 许可与来源

- 音频完全是模型合成的产物，**不含任何真人录音**，所以这条内置音色不牵扯任何人的声音权、肖像权；
  显示名"小满"是编的，不是任何真人的名字。
- FireRedTTS3 模型本身 Apache-2.0；这份 wav 作为二狗仓库的一部分随仓库按 MIT 分发（见仓库根的 `LICENSE`）。

## 想换掉它

- 用户自己的：在 **设置 · 角色与声音** 里导入自己的参考音色、选中它（内置的这条可以留着，也可以删掉）。
- 开源版要换"出厂默认"：换掉这里的两个文件（逐字稿必须和录音一字不差）、更新本说明里的时长和 sha256，
  然后跑一遍 `npx vitest run --project daemon test/voice/default-voice.test.ts`。取舍见 `docs/adr/0036-builtin-default-voice.md`。

## 别改的东西

- 文件不要手工转格式、截短、加响度——`v-default` 的 `voice.json` 里的时长和 sha256 是装的时候现算的，
  但"这条和用户导入的那条长得一样"是这份素材的约定。
- 目录名、文件名不要改：守护进程按 `reference.wav`、`reference.txt` 找它们。
