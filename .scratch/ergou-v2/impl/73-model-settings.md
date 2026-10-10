# 73 — 设置里的"模型"页：DeepSeek，按角色选模型和思考档位

Status: done
Blocked by: 70（同样改 agent 的装配）
Spec: [第一阶段规格](../spec.md) Implementation Decisions 的"模型"一条

## What to build

用户 2026-10-10 定：设置里加上模型相关的设置项。**模型默认在服务端（二狗守护进程这台电脑）调用，目前只支持 DeepSeek**；以后可以扩展别的服务商，**这次只记下来，不实现**。

设置里新加一项"模型"，点进去是下一级页面：

- **服务商**：显示"DeepSeek（在服务端调用）"，目前唯一，不能选。页面上写一句"以后会支持更多服务商"。
- **API key 状态**：只显示"已配置 / 没配置"和来源（LSM 注入的密钥文件），**不显示、不在页面里输入 key**。没配置时说明去 LSM 里配。
- **默认模型**：从配置里登记的 DeepSeek 模型（`models`）里选，比如 `deepseek-flash`。
- **按角色覆盖**：秘书、任务维护者、项目维护者、子 agent、评审、范围审视，各自可选"跟随默认"或者某个模型，以及思考档位（关、低、中、高）。
- **生效时机**：照规格"一个会话固定一个模型"，改了以后**下一个新会话**生效，正在进行的会话不换模型；页面上写清楚。
- **连通测试**：一个按钮，发一条极短的请求，显示通不通、首 token 延迟多少。

后端：

- 设置存在守护进程（数据目录），各设备一样；有读写接口，协议包里加类型。
- 装配 agent 时按角色取模型和思考档位；记账（24 号票的账本）照常按实际模型算。
- 服务商做成一张只有 DeepSeek 一项的登记表，以后加服务商只加一项；**不实现别家**。

## Acceptance criteria

- [ ] 设置里有"模型"一项，点进去能改默认模型、按角色覆盖和思考档位；改完下一个新会话生效，有测试。
- [ ] API key 只显示状态，接口和页面里都拿不到 key 的内容，有测试。
- [ ] 连通测试在测试里用假模型，不连真的 DeepSeek。
- [ ] 规格里"模型"一条改写：服务端调用、目前只支持 DeepSeek、按角色可选；Out of Scope 加"别的模型服务商"。
- [ ] 所有测试通过（vitest），lint（oxlint）无报错。

## Notes

- 配置在 `packages/daemon/src/config/config.ts`（`models`、`tokenPrices`）。
- 71 号票做"系统提示"设置页，两页风格一致，都是设置里的一项、点进去是下一级页面（74 号票同样做法）。

## Comments

- **79 号票留给这里**（2026-10-10）：设置页要显示每个模型能不能看图。79 号票定的判法：配置 `models["provider/模型 id"].vision` 写明的为准，没写的按 pi 的模型目录（`input` 里有 `image`：deepseek-flash 能，deepseek-v4-pro 不能）。模型目录只有 agent 子进程查得到（pi 边界，`test/pi-boundary.test.ts` 连测试都不许引用 pi），守护进程现在只在会话拉起后从 `ready.vision` 知道实际生效的那个。设置页要在不拉起会话时列出各模型能不能看图，可以照 `rewrite-main.ts` 的样子加一个一次性子进程查模型目录（列出 DeepSeek 各模型的 `input`），或者在页面上把配置写明的和"按模型目录"分开显示；页面上改看图能力就是写 `models[...].vision`，同样下一个新会话生效。

- **实现**（2026-10-10，从 main `bc16668e` 开工，变基到 `79cf87bf`）：
  - **设置存在哪**：数据目录配置区的 `config/model-settings.json`（`{ format: 1, provider, default: { modelId, thinkingLevel }, agents, vision }`），只由设置接口写，各设备一样；没有文件时全按默认（deepseek-flash、思考高，和以前写死的一样）；文件读不出来时按默认用、记日志、页面上提示，存一次才覆盖。代码在 `packages/daemon/src/model-settings/`；服务商登记表 `providers.ts` 只有 DeepSeek 一项（id、名字、key 的环境变量、LSM 注入的文件、默认模型），别家不实现。接口 `GET/POST /api/model-settings`、`POST /api/model-settings/test`，协议包 `model-settings.ts`、`model-settings-schema.ts`。
  - **各个 agent**：秘书、任务维护者（定时作业自己的维护者也算它）、项目维护者、子 agent、评审、范围审视，各自"跟随默认"或者选定模型、思考档位（关、低、中、高；模型不分的档 pi 就近取，页面上注明）。拉起时 `modelSettings.modelFor(agent)` 现取（`daemon.ts` 原来写死的 `SECRETARY_MODEL` 等去掉了）。
  - **下一个新会话才生效**：在子进程里做（`agent-child/session.ts` 的 `sessionSetup`，宿主协议升到 14）——装配参数的模型只用于新开的会话；接着已有的会话（目录里的模型、会话里有消息）时照会话开始时 pi 记下的模型和思考档位（`model_change`、`thinking_level_change`），看图能力照子进程在会话开始时记的自定义条目（`SESSION_MODEL_ENTRY`；73 号票之前开的会话第一次接着时按配置和目录定下、记上）。`ready.model` 报回实际用的；账本照子进程每次报的 provider、模型 id 记。faux（测试）照旧按装配参数。这样以前开的会话（包括秘书的主线会话）也不会被改设置换掉。
  - **偏离 / 要用户拍板的一处：秘书**。秘书只有一条长期主线会话，按"一个会话固定一个模型"它一直用开始时的模型（重启后接着也是），所以改秘书的模型（或秘书跟随的默认）现在不会在秘书身上生效；规格里"换模型就新开会话，附一份交接摘要"没做（要新开主线会话、生成交接摘要，还牵涉看板基线和彻底删除对交接摘要的改写），页面上写明"只有一条长期主线会话，一直接着用它开始时的模型"并显示主线会话现在用的。建议另开一张票做秘书的换会话交接；如果用户更想要"改了秘书的模型，这一轮之后就换（接着同一会话）"，给装配参数加一个"接着会话也用这里的模型"的开关、秘书拉起时打开，再在改设置时让秘书 `refresh()`（和改名一样）即可。
  - **可选的模型**：票上写"从配置里登记的模型（`models`）里选"，示例配置里已经没有 `models`，照字面会一个都没有，所以列的是模型目录里 DeepSeek 的模型（deepseek-flash、deepseek-v4-pro）加上配置文件 `models`、`tokenPrices.models` 里登记的；目录里没有的列出来、选不了。模型目录查不到时只能选登记过的和已经选了的。
  - **看图能力（79 号票留的做法）**：照 `rewrite-main.ts` 加了一次性子进程 `agent-child/model-probe-main.ts`（`probe.ts`），守护进程经 agent 管家的 `probeModels` 调：列出模型目录里 DeepSeek 各模型的能不能看图、支持哪几档思考（查到一次记住）。页面上每个模型写明能不能看图和按什么定的（这里改的 / 配置文件写明 / 按模型目录），能改。页面改的存在 `model-settings.json` 的 `vision` 里（不改用户手写的 `ergou.json`），优先级：页面改的 > 配置文件 `models[...].vision` > 模型目录；同样下一个新会话生效。装配参数 `vision` 改成按模型的表（键是「provider/模型 id」）。
  - **API key**：只显示已配置 / 没配置、来源（环境变量 `DEEPSEEK_API_KEY`，LSM 从密钥区的 `secrets/deepseek-api-key.txt` 注入）和守护进程是否接入 LSM；守护进程只看环境变量有没有值、不读密钥区；接口、页面、日志里都没有 key 的内容，请求体多出来的字段一律 400。没配时写明去 LSM 的 ergou-daemon 条目里配、重启生效。
  - **连通测试**：同一个一次性子进程发一条极短的请求（不开思考、`max_tokens` 16），回通不通、首 token 延迟、整次多久；没配 key 不发。provider 的报错可能带 key 的末尾几位（DeepSeek 401 是"****abcd"），子进程和守护进程各去掉一遍。
  - **Web**：设置里加"模型"一页（`pages/more/ModelsPage.tsx`，`#/more/models`，在"外观与风格"下面），说法在 `state/model-settings.ts`，每改一处整份存回去。和 71 号票的"系统提示"页都在设置列表里（合并时两项都留着）。截图（390、1280）在主会话 scratchpad 的 `t73/`。
  - **说明**：`docs/dev.md`（新的一节"设置里的模型"，模块表、配置、AgentSession、测试底座、契约测试）、规格第 1 节"模型"一条（Out of Scope 的"别的模型服务商"开票时已加）。
  - **测试**：`test/model-settings.test.ts`（模块层）、`test/main/model-settings.test.ts`（目录模型的请求都发到本机的假 DeepSeek `helpers/fake-deepseek.ts`，key 是假的环境变量：改了任务维护者的模型后闲置退出再接着的会话照旧是 flash、新任务用 v4-pro，账本照实际用的记；秘书重启后接着主线会话也照旧；key 不在接口和日志里；连通测试；看图能力的层次；不合规的 400）、`test/contract/session-model.contract.test.ts`（pi 契约：固定模型和思考档位、看图能力的记录、faux 照装配参数、模型探查和连通测试）、`vision.contract.test.ts` 跟着改、协议包和 Web 状态层各一份。`startTestDaemon` 默认把目录模型的请求地址指到连不上的本机 1 号端口，测试里永远不连真的 DeepSeek。
- **评审后改的**（2026-10-10，评审没有阻塞，主会话定的几处和顺手改的）：
  - **主会话接受的两处**：可选的模型取自 pi 的模型目录（只列 DeepSeek 的模型，加上配置里登记过的和已经选了的）；看图能力存在 `model-settings.json` 里，优先级是页面上改的 > 配置文件写明的 > 模型目录（`docs/dev.md` 写明了）。
  - **用词**：`CONTEXT.md` 把"角色"列为避免用词，页面上"按角色"改成"各个 agent"（说明写"秘书、任务维护者……各自用什么模型"），代码标识符一起改（`MODEL_AGENTS`、`ModelAgent`、`MODEL_AGENT_LABEL`、设置里的 `agents`、`agentModel`、`withAgent`、`AgentRow` 等）。
  - **连通测试同一时间只跑一个**：服务端拦（上一个还没测完时回 409"上一个还没测完"，不再发请求），页面上按钮也在测完前点不了；超时的结果写"连通测试超时（60 秒），结束了子进程"（一次性子进程的超时写明等了多久）。
  - **范围审视的模型每次审视时现取**：原来是维护者拉起时定下的；现在守护进程交每条输入之前（`scope_context`）和工单结束时要审视（`scope_review`）都带上此刻按设置取的模型，子进程不一样才换（faux 剧本一样时不重新注册），压缩时自己做的审视用最近交给它的；账本按实际用的记。和子 agent、评审一样，设置里改了下一次审视就用新的。宿主协议仍是 14（这张票里加的，还没合并过）。
  - **设置文件读不出来**：页面最上面提示"设置文件读不出来，正在用默认；保存会覆盖它"和原因，日志里记一条；存一次（哪怕和默认一样）就覆盖它、提示消失。
  - **去掉 key 的逻辑合成一处**：`runtime/redact.ts` 的 `redactApiKeys`，子进程（`probe.ts`、`model-probe-main.ts`）和守护进程（`model-settings.ts`）都用它。
  - **加一个服务商只改一张表**：`MODEL_KEY_ENV` 去掉，`config/secrets.ts` 的 `modelCredentials` 照服务商登记表 `MODEL_PROVIDERS` 的 `keyEnv` 取；「provider/模型 id」的拼和拆收进协议包的 `modelKeyOf` / `splitModelKey`（配置里的模型键、看图能力的键、子进程的提示都用它们）。
- **测试结果（评审后）**：变基到 main `0747ff29` 后，`ERGOU_TEST_WORKERS=2` 跑全量：250 个文件 3664 条全过；`npm run typecheck` 无报错，`npx oxlint` 只有 main 上 `chat-look.test.ts` 原有的一条提醒。截图（390、1280，含"设置文件读不出来"的提示 `models-*-broken.png`）在主会话 scratchpad 的 `t73/`。
- **测试结果（评审前）**：变基到 main `79cf87bf` 后，`ERGOU_TEST_WORKERS=2 npx vitest run`：247 个文件 3616 条，3614 条通过；没过的 2 条是 `test/main/secretary-board.test.ts` 的"任务从第 1 阶段进到第 2 阶段"（验收脚本回了退回）和 `test/main/task-execution.test.ts` 的"节假日数据的更新任务"（等看板超时），这两个文件单独跑全过，都只用 faux 模型、不经设置里的模型，看着是负载下的时序；前一次全量（变基到 `d6a3ab03` 时）这两条是过的，当时没过的是 `activity.test.ts` 的一条，单独跑也过。`npm run typecheck`、`npx oxlint` 无报错。真机：合并、经 LSM 重启后在设置 · 模型里看 key 状态、点连通测试（会真的连 DeepSeek 发一条极短的请求）。

- 2026-10-11 完成：评审无阻塞，按主会话要求改了七处（"各个 agent"的说法、连通测试同时只跑一个、超时提示、范围审视现取设置、设置文件坏了的提示、去 key 逻辑合一、服务商表合一）；可选模型取自模型目录、看图能力存 model-settings.json（主会话接受）。全量 3664 条通过；合并到 67 号票之后无冲突，补跑类型检查和相关测试。秘书长会话换模型不生效，留给 83 号票。压缩合并进 main。
