# 二狗 v2

Label: wayfinder:map

## Destination

一份可直接进入实现的二狗 v2 规格：`.scratch/ergou-v2/spec.md`（主规格）+ 关键 ADR（`docs/adr/`）+ 根目录 `CONTEXT.md` 术语表。记忆系统的内部设计由子地图 [二狗记忆系统](../ergou-memory/map.md) 产出独立规格；本地图只定记忆的接口层。走完后用 `/to-tickets` 进入实现。

## Notes

- **领域**：单用户个人助理 agent。框架将来可分享给他人；个人数据永不进仓库。全程中文交流。
- **每个 grilling 票**都调用 `/grilling` 和 `/domain-modeling`：术语即时写进 `CONTEXT.md`；难以逆转、出人意料且有真实取舍的决定写 ADR 到 `docs/adr/`。
- **先查调研**：`docs/research/`（索引见 `README.md`，01–11 已完成）。开新调研前先看是否已有答案。
- **参考项目**：
  - AgentSense（`D:\code\claudecode\user_agent_sense_of_security`）：UI 视觉语言、长程任务、少打扰的继承来源。
  - intent-mining（`D:\code\claudecode\intent-mining`，skill 在 `~/.claude/skills/intent-mining`）：动机挖掘方法。
- **已定的大方向**（立项 grilling 第一至第三轮，2026-10-06/07）：
  - 本地图只产出规格，不写实现代码。
  - 部署：单用户；常驻 Node 守护进程跑在用户的 Windows PC 上；外网访问走 ssh 反向隧道 → VPS nginx → HTTPS。
  - 底座：基于 pi 从零搭建，OpenClaw 只作设计参考。用 `pi-coding-agent` 的 SDK，外面包一层二狗自己的薄封装，并锁定版本（ADR-0001）。
  - 前端：先做 Web UI。再把同一套 Web 套成鸿蒙单框架 App（以及 Android App），用来拿到系统级推送。将来可能接 Telegram。不用飞书。
  - 场景：所有日常事务。将来可能操作电脑或手机。
  - 秘书：信息权限最高，可读全部记忆、知晓全部任务；行动权限最低，只有只读工具和派遣。有副作用的操作，要么是用户确认后由运行时执行的快速动作，要么成为任务。
  - 工作形态有三种：对话、任务、项目（「任务生命周期与任务看板」定稿后的用法）。
    - 任务由用户明确发起，按长程方式执行；执行任务的 agent 只看到与该任务相关的信息。
    - 项目是原子的、可运营的功能模块，有独立工作空间，只能访问被授权的那部分记忆，可选沙箱。
  - 意图澄清 = 带状态、带记忆的 grill-with-docs，目标是大幅减少提问次数。
  - 实现顺序：秘书、派遣、项目这副骨架先行；长程任务和少打扰随骨架一起继承过来；记忆从第一天起就积累素材。
  - 模型：先全部用 DeepSeek V4.1 Flash（`deepseek-flash`）。不设预算上限，但要能看到消耗。以后可能换用 Pro，或者让 pi 指挥 Claude Code。
  - 多媒体：v1 双向支持文本、图片、文档、语音；视频只预留接口。
    - 语音转文字用本地 faster-whisper 服务。
    - 文字转语音用 audio.cpp，音色可配置。
  - 运维：
    - 二狗的所有服务都在 Local Service Manager 注册并由它启动，二狗不自行启动任何服务。
    - 个人数据放在仓库外的数据目录，可以用数据库，定期备份到华为家庭存储。
  - 二狗 v1（套用 OpenClaw 的版本）已丢失，无数据需要迁移。
- **落盘要有章法**（用户 2026-10-07）：凡是要记下来的东西，都要有固定的、统一管理的归宿，不能随手找个文件存。临时文件只能放专门的临时区，并定期清理。每张票设计存储时都要遵守。

## Decisions so far

<!-- 每个已关闭的票一行：[票名](issues/NN-slug.md) — 一句话结论 -->

- [pi 1.0 各层能力映射](issues/01-pi-layer-mapping.md) — 三层能力已摸清；用户排除实验性的 pi-durable，底座在 agent-core `Agent`（全自建）与 coding-agent SDK 之间选，移交运行时架构；deepseek-flash 上分段改 system prompt 会打穿缓存；只记 token 用量，不做按时段计价
- [多 agent 架构与 token 成本](issues/02-multi-agent-and-token-cost.md) — 每个任务/项目绑定一个常驻维护者，默认串行；可并行时由维护者提议、用户确认才派多个 agent；用户可绕过秘书直接查看维护者会话并给它下指令
- [记忆边界：秘书、任务与记忆管理者之间的接口](issues/03-memory-boundary.md) — 记忆管理者是唯一写者；秘书读用户卡（每天最多刷新一次）+ 每轮自动简报（追加在尾部）+ 深查；短期记忆按时效衰减（半衰期 1 个月，自动检索 3 个月），长期记忆只被取代；动机假设只给秘书看，任务在计划授权的记忆范围内取用；秘书一条主线会话，要记住的都落到固定归宿，承诺即任务；简单提醒无 agent，定时作业有维护者；记忆 Web UI 是独立子模块
- [任务生命周期与任务看板](issues/05-task-lifecycle-and-board.md) — 对话 / 任务 / 项目三分：任务由用户明确发起、按长程方式执行，看板只放任务、简单提醒、定时作业，项目单独管理；只有项目维护者能改项目；完成自动、归档只能手动；全局 3 个任务并发；快速动作不配 agent；"待我处理" tab 汇集一切要用户注意的事、未读亮小红点，秘书不主动转述；token 从 pi 用量逐次记账

## Not yet specified

- **不可信内容与提示注入防护**：邮件、网页、文档进入上下文时如何隔离和标记。运行时架构和关注类别定下来之后再细化。
- **外部执行者**：让 pi 指挥 Claude Code、Codex 等外部 harness 干活时，这类角色是什么形态。
- **操作电脑或手机**：computer use 和手机 GUI agent 将来以什么方式作为角色接入。
- **二狗自举**：二狗用自己的项目机制开发和维护自己的代码。等多 agent 架构和沙箱定下来再看。
- **更多前端**：Telegram 等。
- **模型路由与预算**：什么时候、给哪些角色换更强的模型；拿到真实消耗数据后，定什么样的预算策略。

## Out of scope

- **申请华为 AGC 推送与 WORK 分类**（[已关闭票](issues/08-apply-agc-push-work-category.md)）：属于实施阶段的手动操作，由用户按 `docs/guides/huawei-agc-push-setup.md` 完成，规格只留接口。
- **intent-mining skill 的时间维度改进**：独立工作，属于 skill 本身。
- **Local Service Manager 的按服务开机自启**：外部依赖，属于 LSM 项目自己的工作，二狗只是使用方。
- **audio.cpp 为二狗提供抢占式优先级**：外部依赖，属于 audio.cpp 和 drama 那一侧的工作，二狗只是使用方。
- **二狗 v1 数据迁移**：v1 已丢失。
- **多租户，或替他人托管个人数据**：框架可以分享，但每个人各自部署。
