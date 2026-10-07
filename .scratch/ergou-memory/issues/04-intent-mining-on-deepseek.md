# 用 DeepSeek Flash 运行 intent-mining skill

Type: prototype
Status: open
Phase: 2（暂缓，第一阶段规格之后再做）
Blocked by: 03

## Question

intent-mining skill 原本是为 Claude 写的。换成 DeepSeek V4.1 Flash 在 pi 上运行时，能不能产出用得上的结果？

做法：用一份真实或模拟的个人素材样本跑一遍，产出供用户评审。评审要点：
- 推断质量；
- 生成的澄清问题好不好；
- token 消耗；
- 需要对 skill 做哪些适配。

原型作为附件链接在本票里。

## Context

- skill 在 `~/.claude/skills/intent-mining`；它的数据骨架用的是 reasoning-graph skill。
- `docs/research/02-ref-intent-mining.md`。
