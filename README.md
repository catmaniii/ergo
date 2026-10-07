# 二狗 v2（ergou）

一个只服务一个人的个人助理 agent，基于 [pi](https://github.com/earendil-works/pi) 从零搭建，是一个改进版的 OpenClaw。它常驻在用户自己的电脑上；用户主要和"秘书"对话，具体的活按任务和项目派给专门的维护者去做；系统持续积累对用户的理解。

> **状态：规划阶段。**仓库里目前只有规格、决策和调研文档，还没有实现代码。下文的图分两类：标"已定"的来自已关闭的决策票；标"草案"的要等对应的票定稿后再修订。

## 三个差异化

1. **挖掘动机的个人记忆**：人说的话常常跟情境有关，不一定准确。二狗从碎片化的素材里推测用户真正的需求和动机，再用推测出的问题向用户求证。方法参考 intent-mining。
2. **安全且少打扰**：继承 AgentSense 的"规划一次、授权一次、执行到底"。用户自己指定哪些操作要提醒，不局限于安全。需要用户的事统一收进"待我处理"。
3. **秘书 + 维护者的派遣**：秘书只负责理解、澄清、规划和派遣，不亲自干活。每个任务和项目都有一个固定的维护者，权限只限于自己负责的那部分。

## 规划进度

规划用 wayfinder 的方式进行：一张地图，加若干决策票，逐张解决。

- 主地图：[二狗 v2](.scratch/ergou-v2/map.md)
- 子地图：[二狗记忆系统](.scratch/ergou-memory/map.md)
- 术语表：[CONTEXT.md](CONTEXT.md)
- 架构决策记录：[docs/adr/](docs/adr/)

已经定下来的：

| 决策票 | 结论 |
|---|---|
| [pi 1.0 各层能力映射](.scratch/ergou-v2/issues/01-pi-layer-mapping.md) | 摸清了 pi 三层能力；排除实验性的 pi-durable；deepseek-flash 上分段改 system prompt 会打穿缓存 |
| [运行时底座（ADR-0001）](docs/adr/0001-pi-coding-agent-sdk-as-runtime.md) | 用 `pi-coding-agent` 的 SDK，外包一层二狗自己的薄封装，锁定版本 |
| [多 agent 架构与 token 成本](.scratch/ergou-v2/issues/02-multi-agent-and-token-cost.md) | 每个任务或项目绑定一个常驻维护者，默认串行；要并行时由维护者提议、用户确认 |
| [记忆边界](.scratch/ergou-v2/issues/03-memory-boundary.md) | 记忆管理者是唯一写者；秘书读用户卡、记忆简报和深查结果；分短期记忆和长期记忆；动机假设只给秘书看 |
| [任务生命周期与任务看板](.scratch/ergou-v2/issues/05-task-lifecycle-and-board.md) | 对话 / 任务 / 项目三分；任务由用户明确发起；完成自动、归档手动；"待我处理"汇集所有要用户确认的事 |

## 1. 实体与关系

### 1.1 agent 与工作（已定）

```mermaid
flowchart LR
    U(["用户"])

    subgraph AGENTS["agent"]
        SEC["秘书<br/>理解、澄清、规划、派遣<br/>只有只读工具"]
        MT["维护者<br/>固定绑定一个任务或项目"]
        SUB["子 agent<br/>临时，用户确认后才派"]
        MK["记忆管理者<br/>「记忆管理」项目的维护者"]
    end

    subgraph WORK["工作"]
        TASK["任务<br/>用户明确发起，长程执行"]
        STAGE["阶段<br/>交付件、验收标准、授权、安全策略"]
        PRJ["项目<br/>可运营的功能模块"]
        QA["快速动作<br/>一步完成，无 agent"]
        RM["简单提醒<br/>无 agent"]
        JOB["定时作业"]
    end

    subgraph VIEWS["界面"]
        BOARD["任务看板"]
        PUI["项目管理界面"]
        INBOX["待我处理"]
    end

    U -->|"默认对话"| SEC
    U -.->|"绕过秘书直接下指令"| MT
    U -->|"明确发起"| TASK
    SEC -->|"规划"| TASK
    SEC -->|"提议，用户确认后由系统执行"| QA
    SEC -->|"建 / 改 / 取消"| RM

    TASK -->|"1 : N"| STAGE
    TASK -->|"N : M 涉及"| PRJ
    PRJ -->|"1 : 1"| MT
    TASK -->|"执行者"| MT
    JOB -->|"执行者"| MT
    MT -->|"0..N"| SUB
    MK -.->|"是一种"| MT

    BOARD --- TASK
    BOARD --- RM
    BOARD --- JOB
    PUI --- PRJ
    INBOX -.->|"汇集要用户确认的事项"| TASK
```

几条规则：

- **只有项目的维护者能改它的项目。**只涉及一个项目的任务，由该项目的维护者执行；涉及多个项目或不涉及项目的任务，有自己的维护者负责统筹。
- 维护者的工具、沙箱、可见的记忆和文件，都只限于它负责的任务或项目。
- 秘书没有执行权。有副作用的操作，要么是用户确认后由系统执行的快速动作，要么成为任务。

### 1.2 记忆（已定）

```mermaid
flowchart LR
    subgraph SRC["素材来源（只有本人的才能生成关于用户的判断）"]
        S1["任何会话里的发言"]
        S2["对产出的反应"]
        S3["审批决定"]
        S4["澄清回答"]
        S5["主动投喂的材料"]
        S6["显式记忆命令"]
        S7["任务结局"]
    end

    SRC -->|"运行时自动产生素材事件"| STM["短期记忆<br/>按时效降权，半衰期 1 个月<br/>永不自动删除"]
    STM -->|"做梦阶段提炼，带证据链接"| LTM["长期记忆<br/>事实、偏好、动机假设<br/>只会被新证据取代"]

    LTM --> CARD["用户卡<br/>常驻 system 段，每天最多刷新一次"]
    STM & LTM -->|"每轮自动检索，默认最近 3 个月"| BRIEF["记忆简报<br/>追加在对话尾部"]
    CARD --> SEC["秘书<br/>能看到动机假设"]
    BRIEF --> SEC

    SEC -->|"计划里标出引用的记忆和记忆范围"| MT["维护者<br/>看不到动机假设"]
    MT -->|"范围内按需取用，超出要临时授权"| MEMIF["记忆接口"]
    MEMIF --> STM & LTM

    MK["记忆管理者<br/>唯一写者"] -.-> STM
    MK -.-> LTM
    MK -->|"了解你问题，永不推送"| QBOX["问题箱"]
    WEBUI["记忆 Web UI"] -->|"查看 / 纠正 / 删除"| MEMIF
```

## 2. 工作流

### 2.1 一条用户消息的去向（已定，分流细节待「意图澄清与规划交互」）

```mermaid
flowchart TD
    MSG["用户发给秘书的消息"] --> BR["运行时自动附上记忆简报"]
    BR --> JUDGE{"秘书判断"}

    JUDGE -->|"问答"| ANS["直接回答（只读工具）"]
    JUDGE -->|"一步就能做完的副作用"| QA["快速动作卡"]
    QA -->|"用户确认，或在已有授权内"| EXEC["系统直接执行"]
    EXEC --> LOG["操作记录"]
    JUDGE -->|"到点提醒"| RM["简单提醒"]
    RM --> SCH["调度器到点发通知"]
    JUDGE -->|"需要多步干活"| SUG["建议发起任务卡"]

    SUG -->|"用户点击"| START
    BTN["用户明说，或点「发起任务」按钮"] --> START["任务：意图澄清（必要时）"]
    START --> PLAN["计划卡<br/>阶段、授权、引用的记忆、记忆范围"]
    PLAN -->|"用户确认 = 一次授权"| RUN["维护者执行"]
```

### 2.2 任务的状态（已定）

```mermaid
stateDiagram-v2
    state "规划中" as planning
    state "待确认" as confirming
    state "排队中" as queued
    state "执行中" as running
    state "等我" as waiting
    state "已暂停" as paused
    state "已完成" as done
    state "失败" as failed
    state "已取消" as cancelled
    state "已归档" as archived

    [*] --> planning : 用户发起
    planning --> confirming : 提交计划
    confirming --> queued : 用户确认
    queued --> running : 有空闲名额（全局 3 个）
    running --> waiting : 审批、澄清、阶段验收、卡住求助
    waiting --> running : 用户处理
    running --> paused : 用户暂停或超预算
    paused --> running : 继续
    running --> done : 全部阶段通过
    running --> failed : 维护者判定做不下去
    failed --> running : 重试
    done --> running : 返工（按依赖重开）

    planning --> cancelled : 取消
    confirming --> cancelled : 取消
    queued --> cancelled : 取消
    running --> cancelled : 取消
    waiting --> cancelled : 取消
    paused --> cancelled : 取消

    done --> archived : 用户手动归档
    failed --> archived : 用户手动归档
    cancelled --> archived : 用户手动归档
    archived --> [*]
```

- "执行中"里面运行 AgentSense 式的阶段计划，卡片上显示"第 N/M 阶段"。阶段层的机制待「长程任务机制泛化」。
- 归档只能由用户手动触发。结束超过 7 天还没归档的任务，每周汇总一次放进"待我处理"。
- 简单提醒：待触发 → 已触发（一次性的），或者一直待触发（重复的）。
- 定时作业：运营中 ⇄ 已暂停；连续失败 3 次自动暂停。

### 2.3 项目与任务（草案，待「项目生命周期」「项目规范」「运营态托管」定稿）

```mermaid
flowchart TD
    NEED["要一个新的功能模块"] --> SETUP["立项问答：确认范围和目标"]
    CONV["已有任务转为项目"] --> SETUP
    SETUP --> CREATE["建项目，按项目规范生成文档<br/>范围、进展、架构图、服务、公网接口"]
    CREATE --> DEV["开发任务<br/>由新项目的维护者执行"]
    DEV --> OPS["转入运营<br/>服务、隧道、公网入口交给 LSM"]
    OPS --> CHANGE["后续调整 = 新的任务"]
    CHANGE --> OPS
    OPS --> OFF["下线或归档"]

    MULTI["涉及多个项目的任务"] --> TM["任务维护者统筹"]
    TM -->|"交接 A 的部分"| PA["项目 A 的维护者"]
    TM -->|"交接 B 的部分"| PB["项目 B 的维护者"]
```

## 3. 系统架构（部署视图）

守护进程内部的部件划分是草案，待「运行时架构」定稿；部署方式和外部依赖已定。

```mermaid
flowchart LR
    subgraph CLIENTS["前端（不持有状态）"]
        WEB["Web UI"]
        HAP["鸿蒙 App<br/>ArkWeb 外壳"]
        APK["Android App"]
        TG["Telegram（远期）"]
    end

    subgraph VPS["VPS"]
        NGX["nginx 443<br/>HTTPS"]
    end

    subgraph PC["用户的 Windows PC"]
        LSM["Local Service Manager<br/>注册、启动、探活"]
        TUN["ssh 反向隧道"]

        subgraph DAEMON["二狗守护进程（Node）"]
            GW["网关<br/>WebSocket 协议、设备配对、媒体"]
            SECR["秘书运行时"]
            TASKS["任务登记与调度<br/>事件日志、并发、提醒"]
            AGT["维护者 / 子 agent 运行时"]
            QAX["快速动作执行器"]
            GUARD["守卫<br/>关注类别、授权、审批表"]
            MEM["记忆模块<br/>记忆管理者、做梦阶段"]
            NOTI["通知服务<br/>待我处理、推送"]
            RT["runtime/<br/>pi-coding-agent SDK 薄封装"]
        end

        STT["faster-whisper<br/>语音转文字"]
        TTS["audio.cpp<br/>文字转语音"]
        DATA[("个人数据目录<br/>不进仓库")]
    end

    DS["DeepSeek API"]
    PUSH["推送<br/>鸿蒙 Push Kit / ntfy / Web Push"]
    NAS[("华为家庭存储<br/>定期备份")]

    CLIENTS --> NGX --> TUN --> GW
    WEB -.->|"局域网"| GW
    GW --> SECR
    GW --> TASKS
    GW --> NOTI
    SECR --> TASKS
    SECR --> QAX
    TASKS --> AGT
    AGT --> GUARD
    QAX --> GUARD
    SECR --> MEM
    AGT --> MEM
    SECR --> RT
    AGT --> RT
    MEM --> RT
    RT --> DS
    NOTI --> PUSH
    PUSH --> HAP
    PUSH --> APK
    GW --> STT
    GW --> TTS
    DAEMON --> DATA
    DATA -->|"二狗内部调度"| NAS
    LSM -.->|"托管"| DAEMON
    LSM -.->|"托管"| TUN
    LSM -.->|"托管"| STT
    LSM -.->|"托管"| TTS
```

约束：

- 二狗的所有服务都在 LSM 注册并由它启动，二狗不自行启动任何服务。
- pi 的类型只出现在 `runtime/` 里，上层只依赖二狗自己定义的接口（ADR-0001）。
- 审批、任务、记忆、token 账本等领域状态只存在二狗自己的库里，不存在 pi 的会话里。
- 个人数据放在仓库外的数据目录；要记下来的东西都有固定的归宿，临时文件只放专门的临时区并定期清理。

## 4. 模块拆分（草案，待「运行时架构」定稿）

```mermaid
flowchart TB
    subgraph FE["前端"]
        WEBUI["web/<br/>Web UI，继承 AgentSense 视觉语言"]
        SHELL["shells/<br/>鸿蒙、Android 外壳"]
    end

    subgraph CORE["守护进程"]
        GATEWAY["gateway/<br/>协议、设备配对、媒体"]
        SECRETARY["secretary/<br/>秘书、意图澄清、规划"]
        TASKSM["tasks/<br/>任务看板、状态机、事件日志、调度、提醒"]
        PROJECTS["projects/<br/>项目登记、项目规范、工作空间"]
        AGENTSM["agents/<br/>维护者、子 agent、角色卡"]
        GUARDM["guard/<br/>关注类别、授权、审批表"]
        MEMORY["memory/<br/>素材、短期 / 长期记忆、做梦、简报"]
        NOTIFY["notify/<br/>待我处理、推送适配器"]
        MEDIA["media/<br/>STT、TTS 客户端"]
        USAGE["usage/<br/>token 记账"]
        RUNTIME["runtime/<br/>pi SDK 薄封装，唯一接触 pi 的地方"]
        STORE["store/<br/>个人数据目录、备份"]
    end

    WEBUI --> GATEWAY
    SHELL --> GATEWAY
    GATEWAY --> SECRETARY
    GATEWAY --> TASKSM
    GATEWAY --> PROJECTS
    GATEWAY --> NOTIFY
    GATEWAY --> MEDIA
    SECRETARY --> TASKSM
    SECRETARY --> MEMORY
    SECRETARY --> RUNTIME
    TASKSM --> AGENTSM
    TASKSM --> GUARDM
    TASKSM --> NOTIFY
    AGENTSM --> RUNTIME
    AGENTSM --> GUARDM
    AGENTSM --> MEMORY
    AGENTSM --> PROJECTS
    MEMORY --> RUNTIME
    RUNTIME --> USAGE
    TASKSM --> STORE
    PROJECTS --> STORE
    MEMORY --> STORE
    GUARDM --> STORE
    USAGE --> STORE
```

## 文档索引

| 路径 | 内容 |
|---|---|
| [CONTEXT.md](CONTEXT.md) | 术语表：秘书、任务、项目、维护者、短期记忆…… |
| [docs/adr/](docs/adr/) | 架构决策记录 |
| [docs/research/](docs/research/) | 调研：AgentSense、intent-mining、OpenClaw 与 pi、多 agent、记忆、长任务与打扰、推送、本地设施、多媒体、pi 分层、用户建模 |
| [docs/guides/](docs/guides/) | 操作指南，如华为 AGC 推送开通 |
| [.scratch/ergou-v2/](.scratch/ergou-v2/) | 主地图和决策票 |
| [.scratch/ergou-memory/](.scratch/ergou-memory/) | 记忆系统子地图和决策票 |

## 约定

- 仓库只放框架。记忆、对话、项目档案、密钥等个人数据永远不进仓库。
- 文档和交流一律用中文。
