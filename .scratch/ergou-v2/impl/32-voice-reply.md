# 32 — agent 用语音回复

Status: ready-for-agent
Blocked by: 31（语音输入与识别）
Spec: [第一阶段规格](../spec.md) 第 22 节（语音消息）、第 3 节（agent 子进程与 pi 封装层）、第 7 节（秘书）、第 19 节（Web UI）

## What to build

只要用户发的是语音，agent 就用语音回复（秘书和维护者的会话都一样）。回复短的整段合成语音；回复长的，agent 写一段适合听的口语总结来合成语音，详细内容照常用文字、图片、视频发到聊天里。语音用本机 audio.cpp、以用户导入的参考音色做声音克隆。agent 发的语音和用户的一样显示成气泡，可以播放，长按能"转文字"看送进 TTS 的原文。设置里可以导入、试听、选择参考音色；不直接引用 audio.cpp 自带的音色库。

## Acceptance criteria

- [ ] 主切面：用户发语音后，agent 的这次回复带一条语音消息；用户发文字时不带。是否用语音由运行时按"用户上一条是不是语音"判定，不只靠提示词。
- [ ] 主切面：回复的口语稿超过阈值（可配置，默认按字数估算约 60 秒）时，运行时要求 agent 另写一段口语总结用来合成，详细内容照常作为文字和附件发出；agent 没给总结时由运行时兜底生成。阈值内的整段合成。
- [ ] 主切面：agent 语音的数据对象绑定音频（入库的媒体，内容哈希）、时长、送进 TTS 的原文、所用参考音色、TTS 模型，以及对应的完整回复在哪条消息里。测试里 TTS 用假的（不调用 audio.cpp、不占显卡）。
- [ ] TTS：经本机 LSM 托管的 audio.cpp 服务（drama 的 TTS 引擎，地址在配置里，默认本机 8090）的 HTTP 接口合成，`POST /v1/audio/speech` 带参考音色的 `voice_ref`（WAV 路径）和 `reference_text`（逐字稿，Fish 克隆必须同时给）；二狗不自己启动它。服务没开、合成失败或超时时退回只发文字，会话里一条说明。`deploy/lsm/ergou-daemon.example.yaml` 加上对 `audiocpp` 的弱依赖（soft）。
- [ ] 设置：语音页可以导入参考音色（上传一段 WAV 和它的逐字稿，取个名字）、试听、选当前用哪一个、删除；参考音色存在数据目录（个人数据，不进仓库），不列出 audio.cpp 自带的音色库。没有任何参考音色时语音回复退回只发文字，并在待我处理里提示去导入。
- [ ] 前端：agent 的语音显示成和用户语音一样的气泡（在 agent 一侧），点一下播放，长按（桌面右键）"转文字"展开送进 TTS 的原文；前端状态层用主切面录下的事件流回放。
- [ ] 手动冒烟（经 LSM 起的守护进程、真 audio.cpp）：导入参考音色后发一条语音，收到用该音色合成的语音回复，记录合成耗时；结果写进票的 Comments。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- **已有一份导入的参考音色**：用户 2026-10-08 让主会话把"灿灿的远"导入到了本机数据目录的 `voices/v-cancan/` 下：`reference.wav`（参考录音）、`reference.txt`（逐字稿，UTF-8）、`voice.json`（`{format: 1, id, name, audioFile, referenceTextFile, durationMs, sha256, importedAt}`）。参考音色的存储就按这个格式定（数据目录加一个 `voices` 区，每个音色一个以 id 命名的英文目录），设置页导入时照此写入；没有选定时默认用唯一的那一个。测试一律用临时数据目录，不读这份真实数据。
- audio.cpp 的用法见本机的 audio-cpp skill（`~/.claude/skills/audio-cpp/SKILL.md` 和它的 `references/`，只读参考）；仓库里不写本机路径，示例配置用占位符。
- 显卡和 drama 共用同一个 audio.cpp 服务，不另起一份（两份 Fish 会把 12GB 显存撑爆）。接口契约见 audio.cpp 仓库 `repo/app/server/README.md`，调用写法可参考 drama_maker 的 `server/providers/tts-audiocpp.js`（都只读参考）。
- audio.cpp 读不了带中文的路径：导入的参考音色在数据目录里用英文文件名（比如音色 id）存，显示名另存。
- 测试里用一个假的 HTTP 服务代替 audio.cpp（空闲端口），不碰真服务。

## Comments
