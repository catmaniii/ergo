# 68 — 效果记录不存写进去的全文

Status: ready-for-agent
Blocked by: None — can start immediately
Spec: [第一阶段规格](../spec.md) 时序规则、效果日志；65 号票 Comments"效果日志里写文件这类调用的参数是原样存的"

## What to build

效果记录（守卫在每次调用执行成功后记的"这次实际做成了什么"）里，参数是规范化后原样存的。写文件、改文件这类调用的参数里有写进去的全文，不截断，也不受 65 号票的保留期管，日子久了会跟着一直涨；读过的内容如果被写进别的文件，也会多留一份。

- 效果记录只留时序规则和详情页真正用得到的参数：路径、命令、远端和分支、收件人、网址这类"对象"，以及能判断结果的字段。
- 内容类的参数（写入的全文、编辑的新旧片段、提交说明以外的大段文字）换成"长度 + 摘要哈希"，不存原文。
- 已有的旧效果记录照同样口径迁移，迁移只缩不补。

## Acceptance criteria

- [ ] 先核对：时序规则（`guard/temporal-rules.ts`、planguard 规则、58、59 号票的授权项和计划比对）有没有用到内容类参数；用到的照旧留着，并写进 Comments。
- [ ] 新写的效果记录里没有内容全文；规则和计划核对的测试照旧通过。
- [ ] 迁移旧记录，主切面测试：迁移后体积变小、规则判断不变、详情页的效果记录照常显示。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 效果记录的写法见 `guard/effect-log.ts`（`effectRecordsFor`）、`guard-runtime/effect-log.ts`（`recordEffects`），56 号票给它加了调用 id。
- 读了密钥文件的照旧按 `read-secrets.ts` 脱敏。

## Comments
