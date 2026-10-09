# 80 — 彻底删除补登记三类事件的改写函数：计划的决定、提问卡的回答、授权续期的决定

Status: ready-for-agent
Blocked by: None — can start immediately
Spec: [第一阶段规格](../spec.md) 第 15 节彻底删除；ADR-0008；21 号票

## What to build

66 号票做的时候发现：`plan_decided`（计划的决定）、`questions_answered`（提问卡的回答）、`grant_renewal_decided`（授权续期的决定）这三类事件会产生素材，但没有登记彻底删除的改写函数（`PurgeRewriters`）。用户在记忆删除卡上彻底删除这类素材时，"没登记改写函数的事件类型被点到时整个彻底删除被拒"，删不掉。

照 ADR-0008 字段级改写的口径给三类事件登记改写函数：只把带用户原话的文本字段（打回的意见、回答的文字、续期时写的说明）换成 `PURGED_TEXT`，id、状态、决定原样保留，派生视图重放后结论不变。

## Acceptance criteria

- [ ] 三类事件产生的素材都能在记忆删除卡上彻底删除；删除后原话取不到，计划、提问卡、授权的状态和决定不变；主切面测试。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 参照 `memory/rewriters.ts`、`approvals/material-source.ts` 等已有的改写函数。

## Comments
