# 票（tickets/）

> **这份写什么**：建设中按规格拆出来的实现票，一票一个文件，格式同二狗自己的票。每张票端到端做通一小块，写清验收标准和依赖。
> **什么时候更新**：写完规格、开始建设时拆票；做一张票时改它的 Status、勾验收标准、在 Comments 里记取舍；范围变了就加票，不做的标 wontfix。
> 项目规范 v1 · 开发类（不检查；票的进度写进进展）

文件名：`<编号>-<简短的名字>.md`，编号从 `01` 起，被依赖的票编号在前。

每张票的样子：

~~~
# 01 — <这张票做什么>

Status: ready-for-agent
Blocked by: 无

## What to build

## Acceptance criteria

- [ ] 

## Comments
~~~

Status 的取值：needs-triage（要维护者看一下）、needs-info（等补充信息）、ready-for-agent（写清楚了，可以交给子 agent）、ready-for-human（要人来做）、done（做完了，验收标准全勾上）、wontfix（不做）。
Blocked by 写依赖的票的编号（逗号隔开），没有写"无"。按依赖分波做：一票一个子 agent，测试通过才合并。
