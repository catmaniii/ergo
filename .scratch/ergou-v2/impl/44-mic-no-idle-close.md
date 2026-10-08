# 44 — 麦克风不因闲置关闭

Status: done
Blocked by: 37（麦克风预热）
Spec: [第一阶段规格](../spec.md) 第 22 节（语音消息）"麦克风预热"

## What to build

用户 2026-10-09 实测了 37 号票的预热，按下就能录上，觉得很好。用户不要"语音模式里闲置 10 分钟就关麦"：开着没关系，只在切到后台、离开语音模式（切回文字、离开会话页）时关。

## Acceptance criteria

- [x] 去掉闲置关麦（`VOICE_MIC_IDLE_MS` 及其计时）。切到后台、切回文字、离开会话页（组件卸下）时照旧立刻停掉所有音轨；回到前台且仍在语音模式时照旧重新预热。
- [x] `state/voice-mic.ts` 的表格测试和 `app/voice-session.ts` 的测试相应改掉：删掉闲置的用例，补一条"语音模式里很久不按也不关"。
- [x] 票 37 的 Comments、`docs/dev.md` 里讲闲置的地方同步改掉。
- [x] 所有测试通过（vitest），lint（oxlint）无报错。

## Comments

- **去掉了什么**：`state/voice-mic.ts` 的 `VOICE_MIC_IDLE_MS`、`voiceMicIdleAt`、`tick` 输入和状态里的 `lastUsedAt`；只给闲置用的 `time` 字段也从各输入里拿掉（`enter`、`visibility`、`hold`、`playback`）。`resting`（歇着）留着，现在只表示"自动打开失败了，等下一次用到再试"。`app/voice-session.ts` 去掉闲置计时器，`VoiceSessionEnv` 不再有 `setTimeout` / `clearTimeout`（只有闲置用它们），`voice-browser.ts` 跟着去掉。
- **测试**：状态层表格删掉四条闲置用例和两条闲置期限的断言，补"语音模式里很久不按也不关：录完一条、再录一条，一直开着"；`voice-session.test.ts` 删掉两条闲置用例，补"放着几个小时、录完一条后再放着，麦克风一直开着、按下即录、始终是同一个流"。原来闲置用例顺带测的"没预热好时按下 → 准备中 → 量出按下到开录的毫秒数（`prewarmed: false`）"挪进"刚进语音模式就按"那一条，覆盖不减。
- **没改的**：`docs/research/14-voice-capture-latency.md` 里提到"闲置超时"的几处是 37 号票时的调研记录，按原样留着。规格第 22 节已经写了"闲置不关（用户 2026-10-09 定）"，没动。

- 2026-10-09 完成：小票，主会话看过差异代替单独评审，全量通过后压缩合并进 main。同日用户反馈一直占着麦克风会挡住系统语音输入法，另做调研（docs/research/16）。
