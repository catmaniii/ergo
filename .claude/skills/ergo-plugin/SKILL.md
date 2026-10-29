---
name: ergo-plugin
description: 二狗 v2 插件的检查清单。写新插件、改已有插件（守护进程的 plugin.ts、网页的 plugins/<名字>/、插件给二狗的工具和上下文块、数据契约和"连数据删"、带 agent 运行时的插件如 Claude Code / Codex、接外部数据的数据源插件如 Looki / Google / 手机），或者把内核里的功能拆成插件时用。
---

# 二狗插件

做法全在手册 `docs/guides/plugin-development.md`：一个最小的"笔记"插件从头讲到上线，每一步指向七个真插件（提醒、记忆、日历、语音、内置浏览器、Claude Code、Google）里对应的代码。动手前读手册里对应的那一节，照最像的真插件写（手册第 1 节的表）。

插件化的范围用户定过（2026-10-20）：提醒、记忆、日历、语音、内置浏览器这五个是插件，其余留在内核；2026-10-25 用户加了"运行时"这一类插件（Claude Code 已有，287 号票；以后 Codex：接入外部 coding agent 一律做成插件，经运行时贡献点登记，照 Claude Code 写），同一天又加了"数据源"这一类（issue 25：每种外部数据一个插件——Looki、Google、手机、账单……，经数据源贡献点登记）。要加别的新插件、再拆别的，先问用户。

## 清单

交活前每一项都答得出"做了、在哪"，或者"不适用、为什么"：

1. **三部分**（手册第 2–5 节）：守护进程 `packages/daemon/src/<模块>/plugin.ts` 加 `api.ts`；给二狗的经 `ctx.agent` 和定义里的 `prompts`（不写 pi 扩展）；网页 `packages/web/src/plugins/<名字>/plugin.tsx`，两边同名；两份清单各加一行、排最后。
2. **依赖和边界**（第 6 节）：必需的写 `needs`，可选的写 `wants`、用 `ctx.optional` 现取不存；服务名放 `api.ts`，插件目录之外只 import `api.ts`；加一条边界测试。
3. **数据契约**（第 7 节）：卡片类型、改写函数、素材来源、前端请求写进 `contracts`；新的事件类型进协议包；`removal.declare` 写明连数据删删什么、删不掉什么，素材库不跟着删；带原话、停用时也要读的视图放内核。
4. **热插拔**（第 8 节）：登记全经 `ctx`，订阅交给 `ctx.effect`，起停交给 `ctx.lifecycle`；取不到服务时回"X插件没启用"；再启用时 `start` 补上停着时错过的。
5. **多语言**（第 9 节）：给人看的写成取值函数走 `t()`（key 第一段是目录名，中英两份）；给模型看的只用中文，标 `@i18n-ignore model`。
6. **测试**（第 10 节）：假内核 `startPluginKernel` 测装上、停用、启用、移除；至少一条主切面走真实装配；网页回放录下的事件流；加插件时改列插件的断言、重录 `plugins-*.json`。
7. **运行时**（第 7 节"运行时贡献点"，只有带 agent 运行时的插件，照 Claude Code 插件 `packages/daemon/src/claude-code/` 写）：在 `contracts` 里 `ctx.runtimes.register`；能力清单 `RUNTIME_OPERATIONS` 逐项照实写（没做的填 `false`）；子进程入口实现宿主协议、只由守护进程按路径拉起（守护进程里不 import 它，运行时的 npm 依赖只在子进程入口里引真的，外部程序的调用做成可注入的）；交给外部程序的环境去掉会改计费的变量，不读它的凭据和会话文件；契约测试用假的外部程序（不花额度），主切面经 `extraPlugins` 换掉清单里的同名插件、子进程接假的跑一轮；停用时的行为照手册（维护者不拉起、任务转等我、启用后接着）；加边界测试。二狗给维护者的东西照 291 号票交给外部程序（`claude-code/child/host-tools.ts`、`context.ts`、`claude-code/skill-plugin.ts`）：装配参数 `contributions.tools` 全部交过去、调用转成 `host_tool_call`（报回的工具名换回二狗的，守卫按二狗的登记判）；上下文块、跟在输入后面的上下文经外部程序自己的钩子注入（不放进用户消息）；工具包变了能当场换的在能力清单标 `live_toolkit` 并实现宿主协议 `toolkit`（不能的照 pi 走 `yield`）；工具包里的 skill 拼在装配参数 `runtimeDir` 里交过去（复制，不改 skill 库原件），不写外部程序自己的配置目录（`~/.claude`、项目的 `.claude/`）；斜杠补全的写法给 `AgentRuntime.toolkitSkillCommands`。
8. **数据源**（第 7 节"数据源贡献点"，只有接外部数据的插件）：在 `contracts` 里 `ctx.dataSources.register`；导入的写成插件自己的事件（写进 `records`）、经 `ctx.materialSources.register` 变成素材（采集规则用 `dataSourceMaterial`，按谁做的、谁说的选"观察到的本人行为 / 别人写给你的 / 本人写的"之一，场景能给就给，敏感类别按每条记录写窄——不写默认带上数据源登记的全部类别，默认设置下就进不了推断），不碰推理图谱、不直接写档案；量大的先整理成摘要；密钥只经 `ctx.secrets` 存（不进日志、事件）；敏感类别写进 `sensitive`；按需查给 `tools`（306 号票起只在连着时给秘书：`status()` 要快、不连网，同步、按需查碰到 Key 失效、地址失效记在内存里、下一次报 `error`，一时的限速、超时照样报连着；出错后内核每小时叫 `recheck` 用存着的设置再测，好了自己回来）、导入给 `sync` / `files`；没密钥、不进素材的数据源登记一句 `disconnectNote` 说断开实际会删什么；要在页面上填设置的网页插件登记 `dataSources` 插槽；照 `packages/daemon/test/data-sources/data-sources.test.ts` 用假内核测，主切面照 `packages/daemon/test/main/data-sources.test.ts`。设备（手机 App）交来的给 `push`（schema + `receive`），交给日历显示的给 `calendar`，记录是增量的给 `count`，量大的原始数据（位置点、照片的时间地点）留在插件自己的存储里、按天整理成摘要再写事件，登记 `raw`（`days` 按天列出、`clear` 按天清，页面上的动作是 `clear_raw`；断开并删时由插件的 `disconnect` 删；设备会重交的要记下清到哪一刻、那以前的不再收），照手机插件 `packages/daemon/src/phone/` 写；不进素材的（档案候选、日历）在 `records` 之外由接收的模块登记删除参与方。有连接、要定时拉的照 Google 插件（`packages/daemon/src/google/`，297 号票）写：定期导入可以每隔几分钟（`{ kind: "every", minutes }`），导入的不进素材时写明 `destination`，测试里拉地址注入假 fetch 或本机假服务、不连外网。导入文件夹认的文件（或设备交来的）要进个人档案的，照 Google · 联系人（301 号票，`packages/daemon/src/google/contacts.ts`）和手机通讯录选人（299 号票）：复用交给档案候选那段（`KERNEL.personalFiles` 的 `addCandidates(<来源>, …)` + `composeCandidates()`），来源写清楚（`PERSONAL_SUGGEST_ORIGINS` 里加一个，卡上、档案页的写法跟着加）、带上 `dataSource`（删除已导入的时档案那一侧按它删），不直接写档案；量大的只取够格的、分批交。
9. **文档和上线**（第 11 节）：`docs/developer-guide.md` 和 `docs/developer-guide.en.md`（模块表、插件一节）、ADR-0027、`CONTEXT.md`、CHANGELOG；合进 main 后经 LSM 重启守护进程，`npm run smoke:page`。

改了插件宿主（守护进程的 `plugins/host.ts`、`kernel.ts`，网页的 `plugins/host.ts`、`slots.ts`）或者手册摘录的代码：跑 `packages/daemon/test/plugins/plugin-guide-doc.test.ts`，红了就把手册改对。
