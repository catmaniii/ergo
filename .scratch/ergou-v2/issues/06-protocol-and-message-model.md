# 消息协议与多前端

Type: grilling
Status: open

## Question

1. **前端协议**：守护进程用什么协议对外服务各个前端？可参考 OpenClaw Gateway 的做法：WebSocket 上分请求帧和事件帧，带幂等键，用 schema 生成各端的数据模型。
2. **消息数据模型**：一条消息由信封加若干 part 组成。part 的种类包括：
   - 文本、图片、文件；
   - 语音及其转写、TTS 音频；
   - 视频（先预留）；
   - 计划、审批、进度、提问四种卡片。
3. **媒体的存储与传输**：是否用内容寻址？是否支持 Range 请求和断点续传？
4. **远程访问认证**：设备怎样配对？
5. **HTTPS**：麦克风要求安全上下文。

## Context

- `docs/research/09-chat-multimedia.md`：消息模型建议、DeepSeek 的多模态能力边界。
- `docs/research/03-openclaw-and-pi.md` §B1：Gateway 协议和设备配对。
- 立项 grilling Q3、Q23：
  - 前端有多种；
  - 像 Claude Android App 一样，双向收发图片、文档和语音。
- 「任务生命周期与任务看板」已定，卡片种类要加上：快速动作卡（含"已执行"状态）、"建议发起任务"卡、"待我处理"的事项卡（秘书可以把同一张事项卡放进聊天，用户在卡上点按钮才算处理）。
