# 92 — 全量测试提速

Status: ready-for-agent
Blocked by: 90、91（等它们合并，免得几处同时跑全量抢机器）
Spec: 规格 Testing Decisions；`docs/dev.md` 的测试一节

## What to build

2026-10-11 统计做票的耗时（脚本 `.scratch/ergou-v2/tools/ticket_timing.py`）：全量测试单次从最早的半分钟涨到现在 15–18 分钟（277 个测试文件、4741 条，`ERGOU_TEST_WORKERS=2`），88 张票里全量一共花了 37 小时。用户同意"找出最慢的测试文件做快"。

- 按文件量出全量测试里最慢的 20–30 个测试文件（vitest 的耗时报告），逐个看慢在哪：拉起真的守护进程 / agent 子进程、固定的等待和超时、每条用例重建数据目录、重复的启动……
- 在不降低覆盖（测的行为不变、不删用例）的前提下做快：共用启动好的东西、把固定等待换成等事件、缩短测试里的超时（可注入的就注入）、能放进更快的层测的挪下去等。
- 目标：2 个 worker 的全量从约 18 分钟降到 8 分钟以内；做不到的说明卡在哪。
- 顺带：`ERGOU_TEST_WORKERS` 开大（比如 6）时全量要能稳定跑过（用户说电脑空着时会开大）；`child-env`、`activity` 两个满负载偶尔失败的测试查清原因修掉。

## Acceptance criteria

- [ ] 有改之前、改之后每个慢文件的耗时对照（写进 Comments）。
- [ ] 2 个 worker 全量耗时降到 8 分钟以内，或说明卡在哪。
- [ ] 用例条数不少于改之前，测的行为不变。
- [ ] 6 个 worker 连跑两次全过；`child-env`、`activity` 不再偶发失败。
- [ ] typecheck、oxlint 通过。

## Comments
