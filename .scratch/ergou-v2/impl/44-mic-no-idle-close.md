# 44 — 麦克风不因闲置关闭

Status: ready-for-agent
Blocked by: 37（麦克风预热）
Spec: [第一阶段规格](../spec.md) 第 22 节（语音消息）"麦克风预热"

## What to build

用户 2026-10-09 实测了 37 号票的预热，按下就能录上，觉得很好。用户不要"语音模式里闲置 10 分钟就关麦"：开着没关系，只在切到后台、离开语音模式（切回文字、离开会话页）时关。

## Acceptance criteria

- [ ] 去掉闲置关麦（`VOICE_MIC_IDLE_MS` 及其计时）。切到后台、切回文字、离开会话页（组件卸下）时照旧立刻停掉所有音轨；回到前台且仍在语音模式时照旧重新预热。
- [ ] `state/voice-mic.ts` 的表格测试和 `app/voice-session.ts` 的测试相应改掉：删掉闲置的用例，补一条"语音模式里很久不按也不关"。
- [ ] 票 37 的 Comments、`docs/dev.md` 里讲闲置的地方同步改掉。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Comments
