# 语音服务集成

Type: grilling
Status: open
Phase: 2（暂缓，第一阶段规格之后再做）

## Question

语音输入和输出的完整链路怎么定？

1. **语音转文字（faster-whisper，由 LSM 托管）**
   - 接口：整句识别还是流式识别。
   - 模型选哪个。
   - 和 audio.cpp 怎么共用 GPU 显存（显卡是 RTX 4070 Ti 12GB）。
2. **文字转语音（audio.cpp）**
   - 参考音色怎么选、怎么配置。
   - 整句合成完再播放，是否可以接受。
   - 和 drama 争用时谁优先：这是外部依赖，见地图的 Out of scope。
3. **前端录音**：放在网页层，还是放在原生外壳层。
4. **存为素材**：语音消息和它的转写怎样存成素材。

## Context

- `docs/research/08-local-infra.md`：
  - audio.cpp 跑在 :8090，用的是 Fish S2 Pro，带约 60 个参考音色；
  - 合成速度约等于实时，不能流式；
  - Whisper 目前还没有部署成服务。
- `docs/research/09-chat-multimedia.md`：语音消息的交互体验，以及录音的编码格式。
- 立项 grilling Q23：本地 faster-whisper 做成服务注册到 LSM；audio.cpp 要优先为二狗服务。
