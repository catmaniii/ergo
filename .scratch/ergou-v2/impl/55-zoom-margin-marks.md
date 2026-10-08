# 55 — 缩小后的两侧标注、底色带和书脊

Status: ready-for-agent
Blocked by: 54（一镜到底缩放）
Spec: [第一阶段规格](../spec.md) 第 19 节"会话区照搬 AgentSense"、"会话组件"；调研 `docs/research/15-agentsense-zoom-detail-task-modes.md` §1.3、§4.6、§6.1 的 T3

## What to build

照搬 AgentSense 缩小后的标注：

- **右侧标注**：带箭头和 ×N，标注这些东西：
  - 关注类别；
  - 三种样式（授权内、做完告诉我、被拦下或问过）；
  - 通用 bash；
  - 范围变更、越界、偏离；
  - 审批；
  - 验收结果。
- **左侧**：任务卡或工单卡。
- **底色带**：
  - 秘书主线按天；
  - 项目维护者会话按工单段；
  - 任务一整块。
- **书脊**：长程任务的每个阶段，一轮一段，颜色表示验收结果：通过、退回、未通过、在做、作废、已重开。
- **图例**：补齐。

## Acceptance criteria

- [ ] 要点层和全局层上，以上标注都在，样式照 AgentSense（`milestoneSpines` 等，见调研 §4.6）。25 号票要标出的东西一样不少。
- [ ] 前端状态层用回放测试覆盖标注、底色带、书脊的分段和颜色，数据用现有录像，不够的构造事件补上。
- [ ] 和 AgentSense 不一致的地方，先问用户。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Comments
