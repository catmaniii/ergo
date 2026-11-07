---
name: ergo-plugin
description: 写或改二狗（ergo）插件时用：新功能做成插件、改 plugin.ts 或网页的 plugins/<名字>/、给 agent 加工具和上下文块、加设置页、写数据契约和"连数据删"、把内核的功能拆成插件。接外部数据再读 ergo-data-source，接 agent 程序再读 ergo-agent-runtime。
---

# 写二狗插件

先读 `.claude/skills/ergo-dev/SKILL.md`。完整手册是 `docs/architecture/plugin-development.md`，很长，按节查，别从头读（每一步标题后面写着第几节）。设计理由在 `docs/architecture/adr/0027-plugin-host-kernel-and-agent-contributions.md`。

## 现在哪些是插件

| 插件名 | 拿它当什么的例子 |
|---|---|
| `reminders` 提醒 | 最全：卡片、看板条目、前端请求、系统提示片段、起停 |
| `memory` 记忆 | 内部作业、每轮的上下文块、素材来源 |
| `calendar` 日历 | 最小的真插件：只提供一个服务，可选依赖，不拥有数据 |
| `voice` 语音 | 设置页、后台部件、移除时删媒体文件 |
| `browsing` 内置浏览器 | `at: "end"` 的工具、输入附注、`ctx.page` |
| `claude-code`、`codex` | 运行时，见 ergo-agent-runtime |
| `phone`、`google`、`looki` | 数据源，见 ergo-data-source |

事件日志、任务执行连同守卫、宿主协议、网关、项目系统是内核。清单只有 `packages/daemon/src/plugins/manifest.ts` 和 `packages/web/src/plugins/manifest.ts` 两处。插件和代码一起构建：没有运行时装外部插件包这条路。

## 能照抄的例子：笔记

一个完整的小插件，秘书能记笔记，移除时能连笔记一起删。守护进程 `packages/daemon/test/plugins/notes-example/`（`api.ts`、`notes.ts`、`plugin.ts`），网页 `packages/web/test/plugins/notes-example/plugin.tsx`。先跑绿它：

`npx vitest run packages/daemon/test/plugins/plugin-guide.test.ts packages/daemon/test/main/plugin-guide.test.ts packages/web/test/plugins/plugin-guide.test.ts`

## 步骤

### 1. 建目录，定名字（手册第 2 节）

把例子复制到 `packages/daemon/src/<名字>/` 和 `packages/web/src/plugins/<名字>/`。改 import：守护进程的 `../../../src/` 换成 `../`；网页的 `../../../src/plugins/api.ts` 换成 `../api.ts`，别的 `../../../src/` 换成 `../../`。例子在测试目录，给人看的中文是直接写的；搬进 `src/` 要换成 `t()`（第 10 步），不然写死中文的棘轮红。

`name` 小写英文，两边一样，定了别改：配置 `plugins.disabled`、网页插件、语言文件都认它。

### 2. 对外的接口放 `api.ts`（手册第 2.1、6 节）

服务名 `serviceKey<T>("名字")` 和类型放这里。插件目录之外只 import `api.ts`。组合根 `daemon.ts` 也只 import `api.ts`，不建它的服务。

- `needs`：必需的服务。缺一个不装，它停了这个插件跟着停。取 `ctx.use(key)`。内核的服务在 `packages/daemon/src/plugins/kernel.ts` 的 `KERNEL`。
- `wants`：可选的。每次用时 `ctx.optional(key)` 现取，存起来的引用在对方停用后就是死的。
- `provides`：`setup` 里 `ctx.provide` 要给齐，少了算装配出错。

### 3. 写事件和视图（手册第 2.2 节）

写一律 `store.append({ channel, type, payload, idempotencyKey })`，读走派生视图 `DerivedView`（`name`、`channels`、`create`、`clear`、`apply`）。视图放进定义的 `views`。

频道和事件类型：只有插件自己读的放插件目录（`packages/daemon/src/looki/api.ts` 这样）；网页要订阅的写进 `packages/protocol/src/constants.ts`，负载类型也放协议包。

### 4. 写插件定义（手册第 2.3、3 节）

字段：`name`、`title`、`summary`、`brings`、`needs`、`wants`、`provides`、`views`、`prompts`、`missing`、`contracts(ctx)`、`setup(ctx)`。

`setup` 里能登记（每次都交回撤销函数，停用时宿主倒着撤）：

| 登记 | 用来 | 看谁 |
|---|---|---|
| `ctx.cardTypes`、`ctx.purge` | 卡片、彻底删除的改写函数（一般写在 `contracts`） | 提醒 |
| `ctx.quickActions`、`ctx.boardKinds`、`ctx.eventSubscribers` | 确认后执行的快速动作、看板的一种条目、事件触发的订阅方 | 提醒 |
| `ctx.internalJobs` | 守护进程按时间表做的事 | 记忆 |
| `ctx.operationMeans`、`ctx.apps` | 运营方案的手段、把 `/apps/<名字>/` 转到本机地址 | 手册第 3 节 |
| `ctx.agent.*` | 给 agent 的，见下一步 | |
| `ctx.doctor.register` | 体检项：设置 · 体检上这个插件那一块多一项（结果五种、文案键放 `<插件>.doctor.*`；插件本身、数据源、运行时那几项不用登记） | 手册第 3 节"体检项" |
| `ctx.effect(fn)` | 定时器、订阅：`fn` 交回撤销函数 | 提醒 |
| `ctx.lifecycle({ start, stop })` | 自己的起停 | 提醒、记忆 |

`brings` 只写守护进程这一半，工具个数要和实际登记的对上。

### 5. 给 agent 的（手册第 4 节）

都是数据，守护进程经宿主协议下发。不写 pi 扩展。

- **工具**：`ctx.agent.tools.register({ to, at, tools })`，工具用 `packages/daemon/src/agent-manager/host-tools.ts` 的 `defineHostTool` 写，参数用 `@ergo/protocol` 的 `Type`，幂等写 `readOnlyOrIdempotent`，只看的写 `nature: "look"`。
- **给谁**（`to`）：`agents`（`secretary`、`task`、`project`、`job`）、`sessions`、`toolkit`。都不写是所有 agent 的所有会话。子 agent、评审不收。
- **上下文块**：`ctx.agent.context.register`。`when: "wake"` 在唤起和压缩之后注入，要写 `id`，`text()` 同步、要快。`when: "input"` 跟在每条输入后面，`text()` 可以交回 Promise，要设上限。
- **输入附注和钩子**：`ctx.agent.notes.register`（内置浏览器）、`ctx.agent.hooks.register`（手册第 4.3 节）。
- **系统提示**：工具的说明够模型用就不写（日历、数据源都没写）。要讲跨工具的规矩、什么时候主动用，才写定义里的 `prompts`（`plugin` 写插件名、`flag`、`placeholders`、`fragments`，手册第 4.4 节）。条件的名字是中文，标 `// @i18n-ignore data`，照 `packages/daemon/src/reminders/prompt.ts`。改了默认提示跑 `packages/daemon/test/prompts/` 和 `npm run test:contract`。

### 6. 网页这一半（手册第 5 节）

定义 `WebPluginDefinition`：`name`、`title`、`owns`、`brings`、`setup(ctx)`。`ctx.register(插槽, 条目)` 往类型化插槽里放（`packages/web/src/plugins/slots.ts`）。**`owns` 和登记要一一对上**，对不上这个插件不装。

| 插槽 | 放什么 | 看谁 |
|---|---|---|
| `pages` | 自己一页和导航项，地址默认 `#/more/<id>`，不改核心 | 记忆；有自己地址的看日历 |
| `settingsSections` | 设置列表最下面的一节，不改核心 | `packages/web/test/plugins/host.test.ts` |
| `settingsPages` | 设置下面单独一页，要改核心，见下 | 语音、Claude Code、Codex |
| `cards`、`boardEntries`、`calendar` | 卡片的画法、看板条目、日历上的东西 | 提醒 |
| `chatItems`、`details` | 对话里的条目和详情 | 记忆 |
| `composerVoice`、`background` | 输入框的语音、不画东西的后台部件 | 语音 |
| `tabs` | 主导航里核心留了位置的页签 | 内置浏览器 |
| `dataSources` | 数据源详情里的设置那一块 | Looki |

插件只 import `plugins/api.ts`、`state/index.ts` 和核心模块，不 import 别的插件。界面规矩见 ergo-web-ui。

**加设置页。** 内容简单的用 `pages` 或 `settingsSections`。真要 `settingsPages`（`id` 是 `demo`），这几处都改：

1. `packages/web/src/app/route-hash.ts`：`MORE_PAGES`、`SETTINGS_PAGES` 各加一项。
2. `packages/web/src/pages/MorePage.tsx`：`PAGE_TITLES`、`PAGE_SUBS` 各一行；`SETTINGS_GROUPS` 挑一组加进 `rows`；`SubPage` 的 switch 和 `case "voice"` 写在一起回 `null`（内容是插件画的，这里只是没插件时的退路）。
3. `packages/protocol/locales/zh-CN/shell.json` 和 `en/` 同名文件：`shell.pages.demo.title`、`shell.pages.demo.sub`（`id` 带连字符的写成小驼峰）。
4. 插件里 `owns: { settingsPages: ["demo"] }`，`ctx.register("settingsPages", { id: "demo", Page })`。照 `packages/web/src/plugins/claude-code/`。

**漏了 `SETTINGS_GROUPS`、`SETTINGS_PAGES` 编译不报错**：前者设置列表里没入口，后者打开时导航上亮的不是"设置"。

**网页要取守护进程的数据**：没有插件自己开接口的口子，要改协议、网关、组合根、网页共七处，全列在 `.claude/skills/ergo-web-ui/web-data.md`。笔记例子没有这条路，照日历。

### 7. 进清单（手册第 2.4 节）

两份清单各加一行，排最后，两边先后一样。先后就是给同一种 agent 的工具的先后，别调已有的。

### 8. 数据契约和"连数据删"（手册第 7 节）

`contracts(ctx)` 里的登记**不管插件开没开都在，停用也不撤**，因为它写下的事件还在日志里。不拥有数据的插件不写 `contracts`（日历）。

- 卡片类型、前端请求（`ctx.requests.register`，只能是网关 `RequestHandlers` 里可选的那些）、素材来源、改写函数写在这里。里面用 `ctx.active(KEY)` 现取服务，插件没在运行时自动回"X插件没启用"。
- 可能被彻底删除碰到的事件都要有改写函数（`ctx.purge.register`），没登记的事件类型整个拒删。
- `ctx.removal.declare` 写明移除时勾"连数据删"删什么：`deletes`、`keeps`（给人看的，删不掉的照实写：聊天里提到的、备份快照里的）、`events`、`rewrite`、`cardTypes`、`notices`、`files`（数据目录里的相对路径）、`media`。素材库属于内核，不跟着删。例子：`packages/daemon/src/reminders/plugin.ts`，文件和媒体看 `packages/daemon/src/voice/plugin.ts` 的 `voiceRemoval`。
- 带用户原话、插件停着也要读的数据，视图放内核（语音对象在 `voice-records/`）。

### 9. 热插拔（手册第 8 节）

用户能在运行中停用、启用、移除。守住这几条：

1. 登记全经 `ctx`，自己开的定时器和订阅交给 `ctx.effect`，要起停的交给 `ctx.lifecycle`。漏了的停用后接着跑。
2. 正在跑的内部作业，撤销函数不会中止它，在 `stop` 里置中止信号、等它停下。
3. 再启用是新的一次 `setup`，上一次的 `ctx` 不能再用。`start` 里补上停着时错过的。
4. 停用不等于出错。给人看的统一说"X插件没启用"，用 `t("plugins.notEnabled", { title })`，`ctx.active` 自动带。

### 10. 多语言（手册第 9 节）

给人看的写成取值函数走 `t()`：`get title() { return t("notes.plugin.title"); }`。给模型看的只用中文，标 `// @i18n-ignore model`。

- 守护进程的 key 第一段是目录名，放 `packages/protocol/locales/zh-CN/<目录名>.json` 和 `en/` 下同名文件（目录名带连字符时写成小驼峰：`claudeCode.json`）。
- 网页的 key 放 `ui.json` 的 `ui.plugins.<名字>.*`。

## 怎么测

写测试前读 `.claude/skills/ergo-plugin/testing.md`：假内核、主切面、网页各测什么，假时钟怎么拨，`MorePage.tsx` 要 mock 什么。

**新插件进了清单，一批列插件的断言会红，事件流要重录，原型要加假插件。** 怎么找全、重录的先后都在那一份，`git grep '"looki"'` 找不全。

## 完成前检查

每一项答得出"做了、在哪"，或者"不适用、为什么"：

- [ ] 守护进程和网页同名，两份清单各一行，`brings.tools` 个数对，`owns` 和登记对。
- [ ] 假内核测了装上、停用、启用、移除并连数据删；停用后服务取到 `undefined`，工具回"X插件没启用"。
- [ ] 至少一条主切面过了；边界测试过了。
- [ ] `removal.declare` 写明了删什么、删不掉什么；不拥有数据的说明为什么没写。
- [ ] 给人看的字中英都有，`npm run i18n:check -- --data-dir <临时目录>` 过。
- [ ] 列插件的断言、原型的假插件、录下的事件流都更新了。
- [ ] 模块表和约定写进 `docs/architecture/README.md` 的"守护进程的模块""插件"两节和 `.en.md`，用户看得到的写进 `docs/user-guide/`，新词进 `CONTEXT.md`，取舍进 `docs/architecture/adr/`，`CHANGELOG.md` 有一行。
- [ ] 改了插件宿主（`plugins/host.ts`、`kernel.ts`，网页的 `plugins/host.ts`、`slots.ts`）或手册摘录的代码：`packages/daemon/test/plugins/plugin-guide-doc.test.ts` 过。
