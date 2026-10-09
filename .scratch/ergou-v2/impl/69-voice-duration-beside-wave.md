# 69 — 语音条的秒数贴着波形，不靠边

Status: ready-for-agent
Blocked by: None — can start immediately
Spec: [第一阶段规格](../spec.md) 第 22 节"气泡和自动播放"；36 号票的语音气泡

## What to build

用户 2026-10-09 反馈：语音气泡里"多少秒"那个时长靠着气泡的边，离波形很远；要贴着语音条的波形旁边。

原因：一行里波形 `.voice-wave-mini` 是 `flex: 1`，把剩下的宽度全占了；气泡因为下面的识别文字变宽时，时长就被推到最边上。

- 波形只占它自己该有的长度（按时长定的条数），时长紧跟在波形后面，中间留一个小间距。
- 用户发的（右边）气泡照旧镜像：时长贴在波形的另一侧，整行靠右。
- 气泡宽度的算法不变（有文字时取文字宽和随时长的最小宽里大的那个），多出来的空白留在行尾。
- 播放中、"合成中"小签（38 号票）的位置跟着时长走。

## Acceptance criteria

- [ ] 秘书、任务、项目三处会话里的语音气泡，宽窄屏、有没有识别文字，时长都紧贴波形。
- [ ] 每套风格（经典、净白格栅）浅色深色都看过，风格自己的规则没把它推回去。
- [ ] 截图前后对比写进 Comments。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 代码：`ui/conversation/VoiceBubble.tsx`、`styles/voice.css`；风格规则在 `visual-styles/<id>/style.css`。
- 54 号票同时在把三处会话换成缩放组件，收尾前变基到最新 main。

## Comments
