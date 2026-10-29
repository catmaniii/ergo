# 写二狗插件

> 给第一次写二狗插件的开发者看（人或 agent）。agent 写插件、改插件时先用 skill [ergo-plugin](../../.claude/skills/ergo-plugin/SKILL.md)（一张检查清单），细节回到这里。
> 依据：[ADR-0027](../adr/0027-plugin-host-kernel-and-agent-contributions.md)（插件宿主、agent 贡献、网页插槽、热插拔、拆插件）、[CONTEXT.md](../../CONTEXT.md) 的"插件""插件宿主""网页插件""agent 贡献""停用插件""移除插件"。宿主本身的参考见[开发者指南](../developer-guide.md)的"插件"一节。
> 最后更新：2026-10-25（286 号票：运行时贡献点；287 号票：Claude Code 插件——第一个带 agent 运行时的真插件；295 号票：数据源贡献点；299 号票：手机插件——设备交来的、外部日历；303 号票：数据源把记录写成素材；297 号票：Google 插件——第一个真的数据源插件，定期导入每隔几分钟；296 号票：Looki 插件——接外部接口的数据源、测试接本机假接口；298 号票：Google · Gmail——只读 IMAP 的按需查、导入本人写的；306 号票：按需查的工具只在连上时给、外部日历变了推给网页、断开确认框按数据源说话）

二狗的功能分**内核**和**插件**：事件日志、任务执行连同守卫、宿主协议、网关是内核；提醒、记忆、日历、语音、内置浏览器是插件。插件还能带来一个 **agent 运行时**（Claude Code、以后 Codex：维护者用它跑会话，见第 7 节的"运行时贡献点"），或者一种**外部数据的数据源**（Looki、Google、手机……：见第 7 节的"数据源贡献点"）。插件声明自己依赖什么，经插件宿主登记它的东西，每一次登记都能撤销，所以用户能在设置 · 插件里运行中停用、启用、移除它。

插件**和代码一起构建**：在仓库里加、重新构建、重启守护进程（ADR-0027"构建时打包，不运行时加载"）。不在运行时加载外部插件，"装别人写好的插件包、不用重新构建"不在这份手册里。

这份手册从一个最小的例子"笔记"讲起（守护进程那一半在 `packages/daemon/test/plugins/notes-example/`，网页那一半在 `packages/web/test/plugins/notes-example/`，两条测试把它装上、停用、启用、移除），每一步指向八个真插件里对应的代码。**手册里的代码都是摘出来的**：写着"摘自"的代码块每一行都在那个文件里，名字表里的名字在写明的文件里声明着，宿主每一种能登记的东西手册里都提到——`packages/daemon/test/plugins/plugin-guide-doc.test.ts` 核对，代码改了、手册没跟上就红。

## 1. 一个插件长什么样

一个功能插件三部分，守护进程里的和网页里的**同名、一起启停**（守护进程在插件频道上推 `plugin_status`，网页按它装、停自己的那一半）：

| 部分 | 放在哪 | 有什么 | 经谁登记 |
|---|---|---|---|
| 守护进程里的 | `packages/daemon/src/<模块>/plugin.ts` | 逻辑、事件和派生视图、卡片、定时作业、前端请求 | 插件宿主给的 `ctx`（每次登记返回撤销函数，记在插件名下） |
| 给二狗的 | 同一个 `plugin.ts` | 工具、每轮的上下文块、钩子、输入附注、系统提示里的条件和片段 | `ctx.agent`（agent 贡献）和定义里的 `prompts`；守护进程当数据下发，pi 那边的通用桥接扩展翻译给 agent，**不写 pi 扩展** |
| 网页上的 | `packages/web/src/plugins/<名字>/plugin.tsx` | 页面、页签、设置页、对话里的条目、详情、卡片、看板条目、日历、输入框的语音、后台部件 | 网页插件宿主的类型化插槽 |

八个真插件（照着看的时候从这张表找）：

| 插件 | 守护进程 | 给二狗的 | 网页 | 拿它当什么的例子 |
|---|---|---|---|---|
| 提醒 `reminders` | [reminders/plugin.ts](../../packages/daemon/src/reminders/plugin.ts)：视图、提醒卡、前端请求、看板种类、事件触发的订阅方、start/stop | 秘书的四个工具、条件"提醒"、片段 | [plugins/reminders/](../../packages/web/src/plugins/reminders/plugin.tsx)：卡片、看板条目、日历 | 最全的一个，第一个照它写 |
| 记忆 `memory` | [memory/plugin.ts](../../packages/daemon/src/memory/plugin.ts)：素材来源、改写函数、快速动作、内部作业 | 工具、醒来时的简报上下文块、条件"记忆" | [plugins/memory/](../../packages/web/src/plugins/memory/plugin.tsx)：页面、对话条目和详情、卡片、看板条目 | 内部作业、上下文块、素材来源、运行中再开始采集 |
| 日历 `calendar` | [calendar/plugin.ts](../../packages/daemon/src/calendar/plugin.ts)：只提供一个服务 | 没有 | [plugins/calendar/](../../packages/web/src/plugins/calendar/plugin.tsx)：有自己地址的页面 | 最小的；可选依赖、不拥有数据 |
| 语音 `voice` | [voice/plugin.ts](../../packages/daemon/src/voice/plugin.ts)：识别进程、合成、前端请求、移除时删媒体文件 | 两个工具随会话给（不经贡献缝）、条件"语音" | [plugins/voice/](../../packages/web/src/plugins/voice/plugin.tsx)：输入框的语音、后台部件、设置页 | 数据契约留在内核（`voice-records/`） |
| 内置浏览器 `browsing` | [browsing/plugin.ts](../../packages/daemon/src/browsing/plugin.ts)：设备通路、取件码、缩略图 | 八个工具（排在最后）、输入附注、条件"浏览" | [plugins/browsing/](../../packages/web/src/plugins/browsing/plugin.tsx)：页签、卡片 | 可选依赖别的插件、`at: "end"`、`ctx.page` |
| Claude Code `claude-code` | [claude-code/plugin.ts](../../packages/daemon/src/claude-code/plugin.ts)：只在数据契约里登记一个 agent 运行时，子进程入口 `claude-code/child/main.ts` | 没有（维护者整个会话跑在 Claude Code 里） | 没有网页插件（新建时选运行时、⚙、斜杠补全在内核的界面里，289 号票） | 带 agent 运行时的插件、自带 npm 依赖只在子进程里用（第 7 节"运行时贡献点"） |
| Google `google` | [google/plugin.ts](../../packages/daemon/src/google/plugin.ts)：数据契约里登记数据源 Google · 日历（日程经数据源的 `calendar()` 交给日历插件）、Google · Gmail（导入的你发出的邮件采成"本人写的"素材） | 查 Google 日历、搜 / 读 Gmail 邮件（数据源的按需查，内核替它给秘书） | [plugins/google/](../../packages/web/src/plugins/google/plugin.tsx)：设置 · 数据源里填地址、填 Gmail 应用专用密码的那两块（`dataSources` 插槽） | 有连接、要定时拉的数据源插件、定期导入每隔几分钟；只按需查、外部内容夹在外部数据标记里的数据源；自己写协议客户端不加依赖（第 7 节"数据源贡献点"） |
| Looki `looki` | [looki/plugin.ts](../../packages/daemon/src/looki/plugin.ts)：数据契约里登记数据源、两条采集规则、改写函数、连数据删；装配提供 Looki 服务（接官方开放接口） | 按需查的工具"查 Looki"（数据源的 `tools`，内核替它给秘书） | [plugins/looki/](../../packages/web/src/plugins/looki/plugin.tsx)：设置 · 数据源里填 Key 的那一块（`dataSources` 插槽） | 数据源插件：接外部接口、密钥只进密钥区、导入写成素材、测试接本机假接口（第 7 节"数据源贡献点"） |

一个插件的文件：

```text
packages/daemon/src/notes/
  api.ts       对外的：服务名和类型（内核、别的插件只 import 它）
  plugin.ts    插件的定义
  prompt.ts    系统提示里的（有才写）
  ……           服务、视图、工具、卡片
packages/web/src/plugins/notes/
  plugin.tsx   网页插件的定义
  ……           页面、卡片的组件
```

## 2. 最小的插件：笔记

秘书能"记笔记"，记下的笔记下一轮醒来时它看得到；移除时能连笔记一起删。

### 2.1 对外的接口：`api.ts`

服务名（`serviceKey`，带着类型）和类型放在 `api.ts`。内核和别的插件要用笔记，只 import 这一个文件，写进 `needs` / `wants`，用的时候经宿主按名字取：

<!-- 摘自 packages/daemon/test/plugins/notes-example/api.ts -->
```ts
export interface NoteService {
  /** 记一条；同一个幂等键重发拿到同一条 */
  add(text: string, idempotencyKey: string): Note;
  /** 全部笔记，先记的在前 */
  list(): Note[];
}

/** 笔记插件提供的服务名：别的模块写进 needs / wants，用 ctx.use / ctx.optional 取 */
export const NOTES = serviceKey<NoteService>("notes");
```

### 2.2 事件、视图和服务

写一律经事件存储追加（带幂等键），读走派生视图。真插件的事件类型、频道写进共享协议包（`packages/protocol/src/constants.ts` 的 `EVENT_TYPES`、`CHANNELS`，负载的类型也放协议包），例子就地写成常量：

<!-- 摘自 packages/daemon/test/plugins/notes-example/notes.ts -->
```ts
export const notesView: DerivedView = {
  name: "notes",
  channels: [NOTES_CHANNEL],
  create: (db) => db.exec("CREATE TABLE IF NOT EXISTS notes (note_id TEXT PRIMARY KEY, note TEXT NOT NULL, seq INTEGER NOT NULL)"),
  clear: (db) => db.exec("DELETE FROM notes"),
  apply(db, event) {
    // …
  },
};

export function createNoteService(options: { store: EventStore; now: () => string }): NoteService {
  const { store } = options;
  return {
    add(text, idempotencyKey) {
      // …
      const { event } = store.append({ channel: NOTES_CHANNEL, type: NOTE_EVENT, payload: { note } satisfies NoteEventPayload, idempotencyKey });
      return (event.payload as NoteEventPayload).note;
    },
    list: () => listNotes(store.reader),
  };
}
```

### 2.3 插件的定义

<!-- 摘自 packages/daemon/test/plugins/notes-example/plugin.ts -->
```ts
export const notesPlugin: PluginDefinition = {
  name: "notes", // 配置 plugins.disabled 里写的就是它，定了别改
  title: "笔记", // 日志、"笔记插件没启用"里用
  summary: "记下你让二狗记的话", // 设置 · 插件里的一句话
  brings: { tools: ["记笔记"] }, // 设置 · 插件里列的"它带来了什么"，工具个数和实际登记的对上
  needs: [KERNEL.store, KERNEL.clock],
  provides: [NOTES],
  views: [notesView],
  prompts: notesPrompts,
  contracts(ctx) {
    // 数据契约：不管开没开、装没装上都登记，停用不撤
    ctx.purge.register(notePurge);
    ctx.removal.declare({
      deletes: ["全部笔记"],
      keeps: ["聊天里提到过的笔记内容", "备份快照里的一份"],
      events: [{ channel: NOTES_CHANNEL, type: NOTE_EVENT }],
    });
  },
  setup(ctx) {
    // 装配：每次登记都返回撤销函数、记在插件名下，停用时倒着撤
    const store = ctx.use(KERNEL.store);
    const clock = ctx.use(KERNEL.clock);
    const notes = createNoteService({ store, now: () => clockIso(clock) });
    ctx.provide(NOTES, notes);
    const tools = noteTools(notes);
    ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => tools });
    ctx.agent.context.register({
      to: { agents: ["secretary"] },
      when: "wake",
      id: "recent",
      // …
    });
  },
};
```

定义里的每一项：

- `name`：小写英文，配置 `plugins.disabled` / `plugins.removed`、网页插件、语言文件的区域都用它，**定了别改**。
- `title`、`summary`、`brings`：给人看的（日志、"X插件没启用"、设置 · 插件），真插件写成取值函数走 `t()`（见第 9 节）。`brings` 只写守护进程这一半（`tools`、`cards`、`jobs`），网页上的由网页插件自己写。
- `needs` / `wants` / `provides`：依赖和提供的服务（第 6 节）。
- `views`：派生视图，宿主在打开事件存储之前收齐；停用时停着、再启用时整表补齐（第 7 节）。
- `prompts`：系统提示里的条件、占位符、片段（第 4.4 节）。
- `contracts(ctx)`：数据契约（第 7 节）。
- `setup(ctx)`：装配（第 3、4 节）。

### 2.4 进清单

守护进程的插件清单 [plugins/manifest.ts](../../packages/daemon/src/plugins/manifest.ts) 的 `PLUGIN_MANIFEST` 里加一行，网页的 [plugins/manifest.ts](../../packages/web/src/plugins/manifest.ts) 的 `WEB_PLUGIN_MANIFEST` 里加一行，两边先后一样。组合根（`daemon.ts`、网页的 `App.tsx`）只认清单，不出现任何一个插件。

**清单的先后就是给同一种 agent 的工具的先后**（agent 贡献按插件装的先后排），新插件排在最后，别随手调已有的——主切面测试比对秘书拿到的工具先后。

### 2.5 跑起来

先在假内核里测：`startPluginKernel`（`packages/daemon/test/helpers/plugin-kernel.ts`）用**真的**插件宿主、真的登记表和设置 · 插件那一层，把插件装进临时数据目录。笔记的测试 [plugin-guide.test.ts](../../packages/daemon/test/plugins/plugin-guide.test.ts) 装上、停用、启用、移除各一条，停用这一条：

<!-- 摘自 packages/daemon/test/plugins/plugin-guide.test.ts -->
```ts
const k = await startPluginKernel({ plugins: [notesPlugin] });
const result = await k.settings.act("notes", { action: "disable", idempotencyKey: "off-1" });
expect(result.changed).toEqual(["notes"]);
expect(k.pluginsConfig()).toEqual({ disabled: ["notes"] });
// …
expect(() => k.host.active(NOTES)).toThrow(new RequestRejected("not_allowed", "笔记插件没启用"));
expect(secretaryTools(k)).toEqual([]);
// …
const late = await addNote!.run({ text: "不该记下" }, { toolCallId: "c-2" });
expect(late).toMatchObject({ isError: true, text: expect.stringContaining("笔记插件没启用：现在用不了 add_note") });
```

移除并连数据删这一条：

<!-- 摘自 packages/daemon/test/plugins/plugin-guide.test.ts -->
```ts
const result = await k.settings.act("notes", { action: "remove", purgeData: true, idempotencyKey: "rm-1" });
expect(result.purged).toEqual({ events: 2, cards: 0, inboxItems: 0, files: 0 });
expect(k.pluginsConfig()).toEqual({ removed: ["notes"] });
// …
expect(k.store.read(NOTES_CHANNEL).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
expect(listNotes(k.store.reader)).toEqual([]);
```

假内核过了再走真实装配路径（第 10 节）。笔记的那一条在 [test/main/plugin-guide.test.ts](../../packages/daemon/test/main/plugin-guide.test.ts)：`startTestDaemon` 的 `extraPlugins` 把它接在插件清单后面、经组合根起真的守护进程，秘书真的调到"记笔记"，设置 · 插件的 HTTP 接口停用、启用、移除并连数据删。

## 3. 守护进程这一半：`ctx` 能登记什么

装配时宿主给的 `PluginContext`。每一个 `register` 都返回撤销函数、同时记在插件名下，停用时宿主倒着撤；停了以后再经这个 `ctx` 登记直接报错。撤销时各登记表做什么见[开发者指南](../developer-guide.md)的"能注册什么"。

| 登记 | 用来做什么 | 看谁 |
|---|---|---|
| `ctx.use(key)` / `ctx.optional(key)` / `ctx.provide(key, value)` | 取要的服务、现取可选的服务、提供自己的服务 | 第 6 节 |
| `ctx.cardTypes.register` | 卡片类型——一般写在 `contracts` 里（第 7 节） | 提醒卡 |
| `ctx.purge.register` / `ctx.purge.registerQuotes` | 彻底删除的改写函数、引用——一般写在 `contracts` 里 | 记忆、语音 |
| `ctx.quickActions.register` | 快速动作（秘书提议、用户在卡上确认后执行） | 提醒的删除、记忆命令 |
| `ctx.internalJobs.register` | 守护进程按时间表做的事（挂在调度器上，错过了开机补一次） | 记忆的每晚整理 |
| `ctx.boardKinds.register` | 看板上的一种条目（秘书看的看板、查看板也列它） | 提醒的"简单提醒" |
| `ctx.eventSubscribers.register` | 事件触发的订阅方（事件发生时交给它） | 提醒的"事件发生时提醒" |
| `ctx.operationMeans.register` | 运营方案里的一种手段（130 号票） | 还没有插件用 |
| `ctx.apps.register` | 把 `/apps/<应用名>/` 转发到本机的一个地址（132 号票） | 还没有插件用 |
| `ctx.agent.*` | 给二狗的（第 4 节） | |
| `ctx.effect(execute)` | 定时器、订阅、监听：执行它、记下它交回的撤销函数 | 下面 |
| `ctx.lifecycle({ start, stop })` | 插件自己的启停：宿主按依赖顺序叫 `start`，停用时 `stop` 最先叫 | 下面 |
| `ctx.log(line)`、`ctx.plugin` | 写日志（给开发者看的，不翻）、自己的插件名 | |

**自己开的东西都要交回撤销的办法**：订阅交给 `ctx.effect`，要起停的交给 `ctx.lifecycle`。提醒插件：

<!-- 摘自 packages/daemon/src/reminders/plugin.ts -->
```ts
    ctx.effect(() => workdayCalendar.onChange(() => reminders.recalculate()));
    ctx.lifecycle({
      start() {
        // …
        reminders.start();
        reminders.recalculate();
      },
      stop: () => reminders.stop(),
    });
```

**内部作业**：`register` 交回的撤销函数只取消计时器，正在跑的那一次不会被它中止——插件自己在 `stop` 里置中止信号、等它停下。记忆插件：

<!-- 摘自 packages/daemon/src/memory/plugin.ts -->
```ts
        ctx.effect(() => ctx.internalJobs.register(job.job));
        // …
        ctx.lifecycle({
          stop: async () => {
            job.abort();
            await job.whenIdle();
          },
        });
```

时间规则、`run(trigger, signal)` 的约定见[开发者指南](../developer-guide.md)的"插件的内部作业"。

**前端请求**：插件经数据契约登记网关请求里**可选的**那些（`ctx.requests.register(名字, 处理函数)`，名字是网关 `RequestHandlers` 里写成可选的；一个请求只能一个插件登记），处理函数里用 `ctx.active` 现取服务，插件没在运行时自动回"X插件没启用"。要新的请求先在网关的 `RequestHandlers` 里加一项可选的。HTTP 接口留在内核、经 `plugins.active(KEY)` 现取服务（日历的按月取）：

<!-- 摘自 packages/daemon/src/daemon.ts -->
```ts
        calendar: { month: (month) => plugins.active(CALENDAR).month(month) },
```

**要内核的新东西**：往 `packages/daemon/src/plugins/kernel.ts` 的 `KERNEL` 加一个服务名（只放插件真要的），组合根 `daemon.ts` 在 `plugins.setup` 的 `services` 里 `bindService` 绑上：

<!-- 摘自 packages/daemon/src/daemon.ts -->
```ts
        bindService(KERNEL.store, store),
```

## 4. 给二狗的：agent 贡献

插件给 agent 的东西经 `ctx.agent` 登记进 agent 贡献模块（`agent-host/contributions.ts`），守护进程按"给谁"筛好、当数据经宿主协议下发，子进程里的通用桥接扩展翻译给 pi。功能本身（工具的逻辑、上下文块的内容）都在守护进程的插件里，**不写 pi 扩展**（ADR-0027：pi 的扩展跟着会话生灭、工具注册了撤不掉）。

**给谁**（`to`，都不写是所有 agent 的所有会话）：`agents`（`secretary` 和三种维护者 `task`、`project`、`job`）、`sessions`（`secretary`、维护者的六种）、`toolkit`（按此刻的工具包筛；写了它，没有工具包的秘书就不给）。子 agent、评审不收插件的贡献。

### 4.1 工具

`ctx.agent.tools.register({ to, at, tools })`：`tools(target)` 交回 `HostTool`（用 `defineHostTool` 写：参数用 TypeBox，守卫的登记随工具走）。笔记的"记笔记"：

<!-- 摘自 packages/daemon/test/plugins/notes-example/notes.ts -->
```ts
    defineHostTool({
      name: ADD_NOTE_TOOL,
      title: "记笔记",
      description: "把用户要记下的一句话存成笔记。用户说\"记一下……\"时用",
      // …
      readOnlyOrIdempotent: true,
      run(args, call) {
        const note = notes.add(args.text, `add-note:${call.toolCallId}`);
        return { text: `记好了（${note.id}）。` };
      },
    }),
```

- 排在哪：默认排在"插件贡献的工具"那一处（秘书在两个附件工具之后、内核的工具前面）；写 `at: "end"` 排在内核的工具之后（内置浏览器的网页工具）。几个插件之间按清单的先后。
- 停用后正在跑的一轮里 agent 手里还是旧工具：宿主给插件的工具包了一层，回"X插件没启用：现在用不了 <工具>"（`isError`），插件不用自己挡。常驻的秘书手头这一条处理完按新的贡献重新装配。
- `brings.tools` 的个数要和实际登记的对上。

### 4.2 每轮的上下文块

`ctx.agent.context.register`：`when: "input"` 跟在交给 agent 的每条输入后面（开始处理那一刻现算 `text(message, target)`）；`when: "wake"` 在被唤起时和每次压缩之后注入（要写 `id`，宿主在前面加上"插件名:"，笔记的是 `notes:recent`）。文字是 `undefined` 或空的这一回就不注入。都作为消息追加进会话（模型看到的都要记下来）。记忆插件的简报：

<!-- 摘自 packages/daemon/src/memory/plugin.ts -->
```ts
    ctx.agent.context.register({ to: { agents: ["secretary"] }, when: "wake", id: MEMORY_BRIEF_BLOCK_ID, text: () => wakeBriefText(engineProvider.get()) });
```

`wake` 的 `text()` 是同步的、每轮都叫，要快（记忆插件用缓存的只读引擎）。`input` 的 `text()` 可以交回 Promise（266 号票：每条消息的记忆简报要检索）：会话和附件一起等齐了再交这条输入，出错的那块当没有——等的这段时间就是回话慢下来的时间，要设上限（记忆简报超过 3 秒就这一轮不带）。`input` 还可以给 `replyParts(message)`：文字算好之后取一次，交回的 part 放进这一轮的第一条回话（这一轮一条回话都没有就在结束前单独记一条），记忆简报靠它把"回忆了 N 条记忆"那一行的数据挂到回话上。

### 4.3 钩子和输入附注

- `ctx.agent.hooks.register({ id, kind, text })`：`system_prompt_suffix`（每条输入之前接在系统提示末尾，不进会话）、`compaction_instructions`（压缩时写摘要另按它写）。现在没有真插件用，例子在 `packages/daemon/test/plugins/host.test.ts`。
- `ctx.agent.notes.register({ to, text })`：接在交给 agent 的那条输入**自己的文字末尾**（同一条消息里）。内置浏览器拿它写"在网页上说的"那段说明：

<!-- 摘自 packages/daemon/src/browsing/plugin.ts -->
```ts
    ctx.agent.tools.register({ to: { agents: ["secretary"] }, at: "end", tools: () => tools });
    // …
    ctx.agent.notes.register({
      to: { agents: ["secretary"] },
      text: (message) => (message.speaker === "user" && message.browsing ? browsingInputNote(message.browsing, webSearch.appBrowserNote()) : undefined),
    });
```

### 4.4 系统提示：条件、占位符、片段

定义里的 `prompts`（`PluginPrompts`，不经 `ctx`，停用的插件的也收齐）：

- **条件**（`flag`）：插件在运行时成立。默认提示里讲这个插件的地方包在条件里（`{{#提醒}}…{{/提醒}}`），插件停用时就没有，句子照样要通顺；
- **占位符**（`placeholders`，一般是工具名）：插件停用也认得、也有值，用户改过的提示里写了不至于出错；
- **片段**（`fragments`）：默认的文件跟着插件走，插进写明的几份提示（`includedBy`，那份提示里写 `{{> 编号}}`），设置 · 系统提示里能看、能改。

<!-- 摘自 packages/daemon/test/plugins/notes-example/plugin.ts -->
```ts
const notesPrompts: PluginPrompts = {
  plugin: "notes",
  flag: { name: "笔记", description: "笔记插件在运行" },
  placeholders: [{ name: ADD_NOTE_TOOL, value: ADD_NOTE_TOOL, description: "记笔记的工具名" }],
  fragments: [],
};
```

提醒插件的片段（默认提示 `packages/daemon/prompts/secretary.md` 开头 `{{#提醒}}{{> reminders}}{{/提醒}}` 插它）：

<!-- 摘自 packages/daemon/src/reminders/prompt.ts -->
```ts
  fragments: [
    {
      id: "reminders",
      // …
      defaultFile: fileURLToPath(new URL("./prompts/reminders.md", import.meta.url)),
      includedBy: ["secretary"],
    },
  ],
```

`prompts.plugin` 要写成插件自己的名字。改了默认提示要跑 `packages/daemon/test/prompts/` 的测试；改到装配时另跑 `npm run test:contract`。

## 5. 网页这一半

网页插件的定义（`WebPluginDefinition`）：

<!-- 摘自 packages/web/test/plugins/notes-example/plugin.tsx -->
```tsx
export const notesWebPlugin: WebPluginDefinition = {
  name: "notes", // 和守护进程的插件名一样：守护进程报的状况按它对上
  title: "笔记", // 占位那句里写它
  owns: { pages: ["notes"], cards: ["note"] }, // 数据契约：拥有的位置，装配时一一登记
  brings: ["导航里的「笔记」页"], // 设置 · 插件里列的网页上的页面、栏目
  setup(ctx) {
    ctx.register("pages", { id: "notes", order: 75, icon: "layers", navLabel: "笔记", title: "笔记", sub: "你让二狗记下的话", Section: NotesSection, Column: NotesColumn });
    ctx.register("cards", { type: "note", Card: NoteCard });
  },
};
```

- `ctx.register(插槽, 条目)` 往类型化插槽里放（`SlotMap`，`packages/web/src/plugins/slots.ts`）；每次登记返回撤销函数，停用时倒着撤。`ctx.effect` 交回撤销函数的副作用（内置浏览器的 `ctx.effect(turnBrowsingOn)`）；`ctx.page` 是组合根交来的连接和 HTTP（只在 Node 里跑的测试是 `undefined`）。
- **`owns` 和登记一一对上**：登记了不归它的、拥有的没登记都算装配出错（这个插件不装，页面照常）。停用时核心按 `owns` 画占位。
- 插槽（核心在哪画、停用时怎样的全表见[开发者指南](../developer-guide.md)的"网页插件"）：

  | 插槽 | 放什么 | 看谁 |
  |---|---|---|
  | `pages` | 页面和导航项（`#/more/<id>`，或者自己的地址 `route`） | 记忆、日历 |
  | `tabs` | 主导航里核心留了位置的页签 | 内置浏览器 |
  | `settingsSections` / `settingsPages` | 设置列表里的一块 / 核心设置页的内容 | 语音的设置页 |
  | `chatItems` / `details` | 对话里一种条目 / 它的详情（种类先在状态层推出来，插件停用时照样推、换成占位） | 记忆的"回忆了 N 条记忆" |
  | `cards` | 一种卡片的画法 | 提醒卡、记忆删除卡 |
  | `boardEntries` | 看板上一种条目和它的菜单 | 提醒、记忆整理 |
  | `calendar` | 日历的图例、格子里的小标、一天的一节 | 提醒 |
  | `composerVoice` / `background` | 输入框的语音模式 / 整页挂一份的后台部件 | 语音 |
  | `dataSources` | 设置 · 数据源里一个数据源下面的设置（填 Key、地址，测试连接；或者手机 App 里的按钮），键是数据源 id | 手机（"从手机通讯录挑人""连上手机日历"）、Google（Google · 日历：填私密地址，297 号票） |

- 给人看的字走 `t()`、写成取值函数（`get title() { return t("ui.plugins.notes.title"); }`）；只 import `plugins/api.ts`、`state/index.ts` 和核心的模块。
- 核心里去它那一页的链接用 `useRouteAvailable` 判断（插件停用时不出）。
- 原型（`packages/web/src/prototype/fake-plugins.ts`）里加上它的样子，`?demo-plugins-off=<名字>` 看停用的样子、`?demo-plugins-removed=<名字>` 看移除的样子。

## 6. 依赖和边界

- **依赖都是服务**（`serviceKey<T>(名字)`）：内核的在 `KERNEL`，插件的在它自己的 `api.ts`。"依赖别的插件"就是依赖它提供的服务。
- `needs`：必需的。宿主按它排顺序装，缺一个不装（写进日志和 `/healthz`，启用着的插件没装上算降级）；运行中它要的插件停了，它跟着停（设置里写明"一起停的"）。装配时 `ctx.use(key)` 取，插件活着时一直在。
- `wants`：可选的。提供它的插件在就先装它；用 `ctx.optional(key)` **现取**——提供它的插件随时可能停，取到 `undefined` 就照常、少一样；**不要存起来**。它停了不连带停这个插件。日历要提醒：

<!-- 摘自 packages/daemon/src/calendar/plugin.ts -->
```ts
  wants: [REMINDERS],
  provides: [CALENDAR],
  setup(ctx) {
    ctx.provide(
      CALENDAR,
      createCalendarService({
        // …
        reminders: () => ctx.optional(REMINDERS),
```

- `provides`：装配时要 `ctx.provide` 齐，没 `provide` 的、没声明就 `use` 的算装配出错（这个插件不装）。
- **内核取插件的东西也走服务**：`plugins.service(KEY)` 现取（插件没在运行是 `undefined`），替插件接前端请求时用 `plugins.active(KEY)`（没在运行抛 `not_allowed`"X插件没启用"）。
- **不互相 import 内部**：守护进程里，插件目录之外（内核、别的插件）只 import 它的 `api.ts`，例外只有插件清单列它（还有写明的个别几处）。每个插件一条边界测试照抄日历的 `packages/daemon/test/calendar/boundary.test.ts`：组合根里不出现它、目录之外只 import `api.ts`。网页里：插件只 import `plugins/api.ts`、状态层的 `state/index.ts` 和核心的模块（`app/`、`ui/`、`model/`、`util/`……），不 import 别的插件和清单，核心不 import 插件——`packages/web/test/plugins/boundary.test.ts` 扫 import 检查，加插件时把它的目录加进那条测试的列表。
- 两个插件要共享的东西放内核或者放提供方的 `api.ts`（纯函数也行：记忆读存进素材的网页只用浏览插件 `api.ts` 里的 `savedPageOf`，不用 `wants`）。

## 7. 数据契约

`contracts(ctx)`（`ContractContext`）里登记的**不管插件开没开、装没装上都登记，停用也不撤**，因为停用的插件以前写下的事件还在日志里（投影能撤，事件不能撤），内核照样要解释它们：

| 登记 | 为什么停用也要在 |
|---|---|
| `ctx.cardTypes.register` | 卡片改写后的新版本要认它；卡上的动作里 `ctx.active(KEY)` 现取，没启用时回"X插件没启用" |
| `ctx.purge.register` / `ctx.purge.registerQuotes` | 彻底删除（ADR-0008）：没登记改写函数的事件类型整个拒删 |
| `ctx.materialSources.register` | 事件怎么变成素材（ADR-0006）：停用时照样给本人的话留原话副本，重建 `materials.db` 时照样采得出来 |
| `ctx.requests.register` | 前端请求：停用时回"X插件没启用"，不是"不认得" |
| `ctx.removal.declare` | 移除时"连数据删"删什么（下面） |
| `ctx.runtimes.register` | agent 运行时（286 号票，下面"运行时贡献点"）：维护者记着用哪个运行时，插件停用时也要认得、写得出"X插件没启用" |
| `ctx.dataSources.register` | 数据源（295 号票，下面"数据源贡献点"）：停用的插件的数据源照样在设置 · 数据源里列出、写"X插件没启用"，断开并删照样删得掉它导入的 |
| `ctx.active(key)` | 只能取本插件提供的服务，没在运行时抛"X插件没启用" |

`ctx.plugin` 是插件名。提醒插件的契约：

<!-- 摘自 packages/daemon/src/reminders/plugin.ts -->
```ts
  contracts(ctx) {
    ctx.cardTypes.register(reminderCardType(() => ctx.active(REMINDERS)));
    // …
    ctx.requests.register("createReminder", (params, idempotencyKey) => ctx.active(REMINDERS).createFromUser(params, idempotencyKey));
```

内置浏览器存进素材的网页（事件和素材都属于内核，素材来源和改写函数随插件登记）：

<!-- 摘自 packages/daemon/src/browsing/plugin.ts -->
```ts
    ctx.materialSources.register(webPageSavedSource);
    ctx.purge.register(webPageSavedPurge);
```

几条规矩：

- **新的事件类型、频道、负载类型写进协议包**；可能被彻底删除碰到的事件（带用户原话的），改写函数一律写进 `contracts`，不写进 `setup`。
- **派生视图**停用时停着（表留着、不再更新），再启用时整表按事件日志补一遍。停着的视图在普通的彻底删除时不重放：**带用户原话、插件停着也要读的数据，视图放内核**（语音对象的视图在内核的 `voice-records/`，插件停用时历史照样投影、彻底删除照样删干净）。移除并连数据删时，设置那一层会把这个插件停着的视图一起重放（215 号票）。
- **不拥有数据的插件不写 `contracts`**（日历只是合起来看的视图，设置里移除时没有"连数据删"的勾）。

**移除时"连数据删"**（211 号票，用户 2026-10-20 定）：用户在设置 · 插件里移除时能勾"连它的数据一起彻底删除"，删的是插件在 `ctx.removal.declare(PluginDataRemoval)` 里写明的，走彻底删除的同一个口子（同一个事务改写、视图重放、WAL 检查点、留一条只写插件名和条数的删除记录 `plugin_data_purged`）：

| 字段 | 删什么 |
|---|---|
| `deletes` / `keeps` | 给人看的"删哪些""删不掉的"（确认框逐条列出；取值函数走 `t()`）——删不掉的照实写：聊天里提到过的、备份快照里的 |
| `events` | 它拥有的事件（频道、类型；不写频道是所有频道里的这一类）：整条换成"已删除"标记 |
| `rewrite` | 只改它认的字段的事件：`when` 挑出要改的，用登记的改写函数，或者自带 `rewrite` |
| `cardTypes` | 它拥有的卡片类型：每个版本、关掉和长期没处理的记录；待我处理里这些卡的事项删掉 |
| `notices` | 待我处理里属于它的通知（通知的种类） |
| `files` | 它自己的文件或目录（数据目录里的相对路径） |
| `media` | 它的媒体（媒体库的 id，删的时候现算），提交之后删 |

**素材库不跟着插件删**（素材属于内核，用户要删去成批删除），删除记录类的事件（比如删除类的记忆命令）不碰——改写了重建时被删的素材会回来。提醒插件写明的：

<!-- 摘自 packages/daemon/src/reminders/plugin.ts -->
```ts
    ctx.removal.declare({
      get deletes() {
        return [t("reminders.plugin.purge.reminders"), t("reminders.plugin.purge.cards"), t("reminders.plugin.purge.notices")];
      },
      get keeps() {
        return [t("reminders.plugin.keep.secretary"), t("reminders.plugin.keep.backup")];
      },
      events: [{ channel: CHANNELS.board, type: EVENT_TYPES.reminder }],
      cardTypes: ["reminder"],
      notices: ["reminder_due", "missed_reminder"],
    });
```

语音的还写了文件和媒体（`packages/daemon/src/voice/plugin.ts` 的 `voiceRemoval`）。写之前想清楚哪些是这个插件的、哪些属于内核或会话，拿不准的问用户（211 号票记忆插件的"选 A"就是问过才定的）。

### 运行时贡献点：接一个 agent 运行时（286 号票）

维护者（任务的、项目的、定时作业的）跑会话用哪个 **agent 运行时**是它的一个属性（`Task.runtime`、`Project.runtime`，没写是 pi）。pi 是内核自带的；Claude Code（287 号票）、以后的 Codex 各是一个插件，经同一个贡献点登记（ADR-0027 的"运行时是插件贡献点，宿主协议是运行时的接缝"）。插件在数据契约里 `ctx.runtimes.register(运行时)`，运行时（`AgentRuntime`，`packages/daemon/src/runtime/runtimes.ts`）有这几样：

| 字段 | 是什么 |
|---|---|
| `id` | 小写英文、数字和连字符，维护者的运行时属性里写的就是它，定了别改（pi 是 `pi`） |
| `title` | 给人看的名字，写成取值函数走 `t()` |
| `entry` | 子进程入口：实现**宿主协议**的脚本的绝对路径（和守护进程同一种扩展名）。守护进程用 `process.execPath` 拉起它，每个会话一个（ADR-0002），名额、Job 对象、超时、闲置退出、孤儿回收和 pi 一样；它收同一条"启动"、说同一套消息（ADR-0004），网页和守护进程都不用知道下面是谁 |
| `capabilities` | 能力清单：共享协议包 `RUNTIME_OPERATIONS` 的每一项（插话、压缩、撤回、切分支、分支摘要、换模型写交接摘要、思考档位、斜杠命令转交、接管已有会话、彻底删除改写会话、做完这一步停下、范围审视、Remote Control）能不能做，**逐项写明**（加了新的一项每个运行时都得表态）。界面和守护进程按它决定显示什么、走哪条路；宿主协议里人人都要实现的（输入、中止、守卫、宿主工具、用量……）不在清单里 |
| `models()` | 可选的模型（不给是按设置 · 模型，二狗自己的模型目录）；子进程起来后能报回真的列表（宿主协议的 `runtime_catalog`，289 号票），这里是没报过时的后备 |
| `settings()` | 设置项：从几个里选一个（权限模式、思考档位……）。用户在维护者的 ⚙ 里选的模型和设置项经"启动"的 `runtimeOptions` 交给子进程（289 号票），默认值不交 |
| `sessions()` | 列本机能接管的会话（能力清单里 `take_over` 是 `true` 的要给，290 号票）；要用插件服务的经 `ctx.active` 现取 |
| `guardTools` | 运行时自带、二狗没装配的工具在守卫工具登记表里的登记（来源 `runtime`，288 号票：Claude Code 的 TodoWrite、Agent……）：用它的维护者会话里这些照登记判、不按工具白名单硬拒绝，没登记的照"未登记的写操作"判；能对上二狗工具的（Bash → bash……）由子进程在判定请求里映射过去 |
| `toolTimeouts` | 运行时自带的工具单次调用的超时（毫秒，`null` 是不按单次超时算），盖过守护进程的默认（288 号票：Claude Code 的子代理一次可能跑十几分钟） |

测试用的假运行时插件（只在测试里）：

<!-- 摘自 packages/daemon/test/helpers/fake-runtime.ts -->
```ts
export const fakeRuntimePlugin: PluginDefinition = {
  name: FAKE_RUNTIME_PLUGIN,
  title: FAKE_RUNTIME_TITLE,
  contracts(ctx) {
    ctx.runtimes.register(fakeRuntime);
  },
  setup() {},
};
```

pi 照同一个接口由组合根登记（不是插件、不能停用）：

<!-- 摘自 packages/daemon/src/daemon.ts -->
```ts
    const agentRuntimes = createRuntimeRegistry({ log, defaultFolder: (runtimeId) => workFolders.defaultOf(runtimeId) });
    agentRuntimes.register(piRuntime);
```

- **为什么写在契约里**：维护者记着用哪个运行时，插件停用、没装上、移除了也要认得它、写得出"X插件没启用"；能不能用跟着插件此刻在不在运行。
- **插件停用时**（运行时闸门 `packages/daemon/src/agent-host/runtime-gate.ts`）：用它的维护者不拉起，输入留在队里；有活拉不起时活动状态是"等你"，说明写明哪个插件没启用；执行中的任务转等我（原因"运行时没启用"，用户点"继续"没用）。正在做的那一轮做完才停（不中止），做完子进程就退出、不再拉起。启用后接着：等我的任务接着执行，排着的输入交给新拉起的子进程。
- **子进程入口是插件自己的文件**（照 pi 的 `packages/daemon/src/runtime/agent-child/main.ts`，最小的例子是测试里的 `packages/daemon/test/fixtures/fake-runtime-child.ts`）：只由守护进程按路径拉起，守护进程里别的代码不 import 它；运行时自己的 npm 依赖只在子进程里用（ADR-0001 的封装边界照旧）。
- **网页**：`GET /api/runtimes`（`RuntimesView`）列出登记了的运行时连同能力清单、能不能用。289 号票起：新建任务、项目时选运行时（只有 pi 能用时不显示），卡上标出（pi 不标），维护者的 ⚙ 里换运行时、选它的模型和设置项（`PUT /api/agents/<id>/runtime`），界面按能力清单收起它不支持的按钮（撤回、切分支、现在压缩）。
- **换运行时**（289 号票）：等手头这一条做完，原来的运行时写一份交接摘要（宿主协议 `write_handoff` → `handoff_written`，每个运行时都要实现：pi 照换模型的写法，Claude Code 推一条只读的交接提示），新的运行时新开一段会话、摘要作为下一条输入的上下文。
- **新建时选工作文件夹**（`AgentRuntime.workFolder: true`，305 号票）：新建它的任务、项目时多"在哪个文件夹做"（在设置里定的默认文件夹下新开、或用已有的），选定的就是维护者的工作目录；默认文件夹由内核的 `work-folders/` 按运行时存（登记表经 `defaultFolder` 带进运行时清单），插件不管存取。Claude Code 的网页那一半画"设置 · Claude Code"（`settingsPages` 插槽）。
- **斜杠命令转交**（能力清单 `slash_passthrough`，289 号票）：用户发的以 `/` 开头的话（二狗自己的命令除外）原样当输入交给子进程，不加时间标记、不展开 skill；子进程把能用的命令报回 `runtime_catalog.commands`，输入框的补全列它们。给了 `toolkitSkillCommands`（291 号票：工具包里的 skill 在运行时里的命令名）的，用户按 pi 的习惯打的 `/<目录名>` 是工具包里的 skill、又不是运行时报过的命令时，交过去之前换成它的写法（309 号票：Claude Code 是 `/ergo:<目录名>`）。
- **范围审视做不了的**（`AgentRuntime.recordedScopeReview: true`，309 号票）：子进程里调不了二狗的审视模型的运行时，能力清单 `scope_review` 照样写 `true`，压缩之前报宿主协议 `compacting`，守护进程按二狗自己记下的事件另起一次性子进程审视（工单结束时也是，不送 `scope_review`），结果和 pi 的一样记下。分支摘要同理在能力清单写 `branch_summary: false`（293 号票）。
- **测**：主切面 `packages/daemon/test/main/agent-runtimes.test.ts` 用假运行时插件走真实装配路径：维护者经它的子进程拉起、插件停用时任务转等我、启用后接着。

**真插件：Claude Code**（287 号票，[claude-code/plugin.ts](../../packages/daemon/src/claude-code/plugin.ts)）——接 Codex 这类的照它写：

<!-- 摘自 packages/daemon/src/claude-code/plugin.ts -->
```ts
export function createClaudeCodePlugin(
  options: { entry?: string; sessions?: ClaudeSessionSource; cli?: ClaudeCli; remoteTiming?: Partial<RemoteTiming>; sdkInstalled?: () => boolean } = {},
): PluginDefinition {
  let sessions: ClaudeSessionSource | undefined;
  let cli: ClaudeCli | undefined;
  return {
    name: CLAUDE_CODE_PLUGIN,
    // …
    needs: [KERNEL.oneShot, KERNEL.env],
    missing: (ctx) => claudeSdkMissing(options.sdkInstalled ?? (() => claudeSdkInstalled(ctx?.componentsDir))),
    contracts(ctx) {
      ctx.runtimes.register(
        claudeCodeRuntime(options.entry, {
          // …
        }),
      );
    },
    setup(ctx) {
      const run = ctx.use(KERNEL.oneShot);
      const env = ctx.use(KERNEL.env);
      ctx.effect(() => {
        sessions = options.sessions ?? oneShotSessionSource(run);
        cli = options.cli ?? detachedClaudeCli(() => env);
        // …
      });
    },
  };
}
```

- **目录**：`plugin.ts`（定义）、`api.ts`（插件名、运行时的 id：插件目录之外只 import 它）、`runtime.ts`（运行时：能力清单逐项照实写，这一张没做的填 `false`）、`child/`（子进程：`main.ts` 入口只做接线，`child.ts` 宿主协议这一层，`session.ts` 一个会话的轮次和外部程序的生命周期，`translator.ts` 把外部程序的事件翻回宿主协议，`records.ts` 二狗的会话名 ⇄ 外部程序的会话 id）。
- **自带的 npm 依赖只在子进程里**：真的 `query` 只在 `child/main.ts` 里引，别处只引类型；外部程序的调用做成可注入的（`runClaudeChild` 的 `queryFor`），守护进程里别的代码不 import `child/`——边界测试 `packages/daemon/test/claude-code/boundary.test.ts` 查。
- **不随二狗分发的依赖是可选的**（315 号票）：Claude Code 的 Agent SDK 是 Anthropic 自己的许可，在 `packages/daemon/package.json` 里写成 `optionalDependencies`（照常 `npm install` 会装上，打包发布时去掉，用的人自己装）。插件定义里给 `missing()`：它要的外部组件没装时交回给人看的一句（没装什么、在哪运行哪条命令装），装着是 `undefined`。宿主每次装配之前问一次：没装的不装配，记成没装上（`PluginInfo.missing`，设置 · 插件里状况写"没装"、下面是那一句，装好之前启用不了），依赖它的也不装；运行时不能用的原因写那一句而不是"没启用"（`RuntimeOwner.missing`）；装好后点启用就装上。数据契约照常登记。找包在不在只解析不加载（`claude-code/sdk-installed.ts` 是边界测试里写明的唯一例外）；主切面给 `createClaudeCodePlugin({ sdkInstalled })` 一个说"没装"的，不用真卸掉（`packages/daemon/test/main/fresh-install.test.ts`）。
- **不碰外部程序的凭据和会话文件**：二狗的会话名和外部程序的会话 id 对照另记在会话目录里；交给外部程序的环境去掉会改计费方式的变量（Claude Code 是 `ANTHROPIC_API_KEY`）。
- **契约测试用假的外部程序**：`packages/daemon/test/helpers/fake-claude-sdk.ts` 按 SDK 的消息格式吐事件（手动挡一条条地吐、按 faux 剧本自动回两种），适配子进程是真的（`packages/daemon/test/claude-code/adapter.contract.test.ts`），不启动真的 claude、不花额度；真机验证另开一张票。
- **守卫**（288 号票）：每次工具调用都要经宿主协议的判定请求（`guard_request`）过二狗守卫——Claude Code 是在交给 SDK 的 `PreToolUse` 钩子里发（`claude-code/child/guard.ts`，钩子是全量闸口，`canUseTool` 不是）；运行时自己要问用户的（AskUserQuestion、退出计划模式）报 `ask_user`，守护进程建提问卡、回答经 `ask_user_reply` 交回。
- **接管已有会话**（290 号票，能力 `take_over`）：运行时给齐 `sessions()`（列本机的会话、标出占着的）、`sessionBusy()`（收回前核对）、`forkSession()`、`sessionHistory()`（前情：主线最近一段，`RuntimeHistory`）四样，登记表核对少一样不收。外部程序的会话列表、读会话做成可注入的会话来源（Claude Code 是 `ClaudeSessionSource`，真的经内核服务 `KERNEL.oneShot` 拉一次性子进程 `child/sessions-main.ts` 用 SDK 读，SDK 还是只在 `child/` 里；主切面给 `createClaudeCodePlugin({ sessions })` 一个假的，`packages/daemon/test/helpers/fake-claude-sessions.ts`，不读用户真实的会话文件）。接管成任务 / 项目、前情事件、写入锁、交还收回是内核的（`takeover/`），插件不管。
- **交给官方 App、再收回来**（292 号票，能力 `remote_control`）：运行时给 `remoteControl`（`RuntimeRemoteControl`：开 / 唤醒自己的后台会话连上官方 App 并交回链接、停掉、只读跟随读新内容）和 `currentSession(会话目录)`（维护者现在接着的是哪个会话），登记表核对少一样不收。外部程序的命令行做成可注入的（Claude Code 是 `ClaudeCli`：真的由守护进程直接拉起本机的 claude，detached、**不进二狗的 Job**——`claude --bg` 会拉起它自己的后台服务，放进 Job 会被孤儿回收结束；主切面给 `createClaudeCodePlugin({ cli })` 一个扮演本机 claude 的假的，`packages/daemon/test/helpers/fake-claude-cli.ts`）。"现在在哪边"（二狗接管 / 官方 App / 空着）、打断关掉二狗的进程、只读跟随补记、收回后接着是内核的（`takeover/`，和 290 号票的交还 / 收回同一套状态），插件不管。
- **主切面换掉清单里的同名插件**：`startTestDaemon` 的 `extraPlugins` 里和清单同名的换掉清单里那个（位置不变），子进程入口换成接假 SDK 的（`packages/daemon/test/helpers/fake-claude-code.ts`、`packages/daemon/test/fixtures/fake-claude-child.ts`）；`packages/daemon/test/main/claude-code-runtime.test.ts` 让它的维护者跑完一轮，会话频道里的事件和 pi 跑同一个剧本的一样。

### 数据源贡献点：接一种外部数据（295 号票）

外面的数据（挂脖相机、Google 日历 / Gmail / 联系人、手机、账单……）**每种一个插件**（issue 25，用户 2026-10-25 定），插件在数据契约里 `ctx.dataSources.register(数据源)`。设置里一页"数据源"（`#/more/data-sources`，内核的页面，记忆页有链接过来）一处列出全部：名字、连接状态、上次同步和条数、立即同步、断开、用到的敏感类别、两种用法的开关；下面是共用的导入文件夹。ADR-0027 的"数据源是插件贡献点"一段讲为什么这么做。

规矩（issue 25 第 2、4 节）：

- **只产素材、不产结论**：插件把拿进来的写成**自己的事件**（频道、类型写进 `records`），经 `ctx.materialSources.register` 变成素材（ADR-0006），采集规则里用 `dataSourceMaterial` 写（303 号票，下面"把记录写成素材"）；不碰推理图谱、不直接写个人档案（进档案一律经候选核对卡），理解由记忆管理员每晚整理时做。
- **量大的先整理成摘要**：位置点、每隔几十秒一张的照片、心率曲线，插件先整理成"一段一段"的摘要再写事件；原始数据留在来源那边或插件自己的存储里。
- **密钥只进密钥区**：API Key、应用专用密码、私密地址经函数参数里的 `ctx.secrets`（`DataSourceSecrets`）存进数据目录密钥区的 `data-sources/<id>.json`，不进仓库、日志、事件；同步、导入出错的原因里带着密钥的，内核记下之前换成 `***`。

数据源（`DataSource`，`packages/daemon/src/data-sources/api.ts`）有这几样：

| 字段 | 是什么 |
|---|---|
| `id` / `title` / `summary` | 小写英文、数字和连字符，定了别改（用法开关、密钥区、同步记录按它记）；名字和一句话写成取值函数走 `t()` |
| `sensitive` | 用到的敏感类别（健康、财务、位置、关系……，`SensitiveCategory`）：对上记忆的敏感类别开关，页面上写明默认只记录、不用于推断。`dataSourceMaterial` 写的素材不写 `sensitive` 就带上这里的全部（保守）；某条记录不涉及的写窄（见下面"把记录写成素材"） |
| `usages` | 提供哪两种用法、默认开没开：`query`（按需查：给秘书 `tools`，现查不存）、`import`（导入：`sync` 和 `files`，`schedule` 是定期导入的时间——提醒那一套，或者 297 号票起每隔几分钟 `{ kind: "every", minutes }`；`destination` 写导入的东西去哪，不写是"整理成素材"；`syncOnConnect` 填好设置连上以后马上同步一次）。用户在数据源页上开关，存在配置区的 `data-sources.json` |
| `records` | 它导入的记录（事件的频道、类型）：页面上的"共几条"按它数；断开时选了"连已导入的一起删"，这些整条换成"已删除"标记，由它们采成的素材彻底删除 |
| `files` | 认导入文件夹里哪种文件（`DataSourceFileType`）：扩展名、文件名、内容特征（开头 4 KB）写了的都对上才认；`import(file, ctx)` 读文件、写记录，交回新进来几条 |
| `status(ctx)` | 连接状态（没连 / 连着 / 出错及原因 / 账号），要快；不给是"手动导入"的数据源（只靠导入文件夹）。可以带一句提示 `note`（不算出错："日历插件没启用"）和它下面的几样 `items`（几个日历，插件画的设置那一块列出）；307 号票起还能带插件画的那一块要的数据 `panel`（内核原样交给网页、不看里面：Looki 的"存一份到本地"）和断开的确认框里要说的一句 `disconnectNote`（"存到本地的文件不删"）。306 号票起连接状态还决定按需查的工具给不给秘书：内核只用插件报的**最近一次已知的**状态（装配时不等网络），所以插件在同步、按需查时碰到 Key 失效、地址失效要记在内存里、下一次 `status` 报 `error`（Looki 的 Key 不认、Gmail 登录没过、Google 日历每个地址都失效），一时的（限速、超时、连不上）照样报连着、原因写在 `problem`。报出错以后内核每小时替它再试一次（见下面 `recheck`），页面上写明"每小时自动再试一次，也可以重新填" |
| `configure(values, ctx)` | 填设置、测试连接：网页插件在 `dataSources` 插槽里画那一块，值经 POST 交来，插件存进 `ctx.secrets` |
| `sync(ctx)` | 同步一次（"立即同步"、定期导入到点了）：`ctx.trigger`、`ctx.lastSyncAt`、`ctx.signal`（断开、插件停用、守护进程停时置位） |
| `recheck(ctx)` | 出错后再试（306 号票）：`status()` 报出错时内核每小时叫一次，插件用存着的设置再测一次连接（不写记录、不用用户重填），更新自己记着的状态，好了下一次 `status()` 就报连着、按需查的工具跟着回来。Key 失效、密码错也照样叫（用户可能在别处修好了）。不给的、导入开着的内核照同步那样同步一次；能填设置而密钥区里什么都没有的不试。Looki 拿存着的 Key 调 `/me`，Gmail 用存着的地址密码登录一次，Google 日历每个地址拉一遍 |
| `disconnect(ctx)` | 断开时插件自己的清理（`ctx.purge` 为真时删它自己存储里的原始数据）；密钥区那一格、`records` 由内核删 |
| `tools(ctx)` | 按需查的工具（给秘书）：内核替数据源登记成 agent 贡献，只给按需查开着、插件在运行、**连着**（306 号票）的；给出去的那份变了才通知秘书重新装配（开关、填设置、断开、插件起停、同步做完、设备交来、按需查调完都比一比），正在跑的一轮里再调关着的回"关着"、没连上的回"没连上 / 出错了"（不叫插件） |
| `push` | 设备交来的（299 号票：手机上的二狗 App 读本机，经网页 `POST /api/data-sources/<id>/push`）：`body` 是交来的 `data` 的 TypeBox schema（内核先查，不对回 400），`receive(data, ctx)` 收下、交回新进来几条、给人看的 `summary`、交回设备的 `reply`；抛 `RequestRejected` 的回 400、不记。算"导入"这种用法（导入关着时不收），同一个幂等键只收一次 |
| `count(ctx)` | "共几条"自己数（插件在运行时代替按 `records` 数；记录是增量的时候用） |
| `disconnectNote` | 断开（只靠导入文件夹的是"删除已导入的"）时确认框里要说的一句，取值函数走 `t()`（306 号票）：确认框里"填过的密钥从这台电脑上删掉"只在密钥区真有它那一格时说，"素材照样在""由它们整理出的素材和原文副本"只在它的 `records` 登记了素材来源时说——没密钥、不进素材的数据源用这一句说实际会删什么（手机日历："同步来的手机日程不再显示在二狗的日历里……"，通讯录、Google 联系人："档案候选里还没处理的一起作废……"）。插件停用也认得；`status()` 报的 `disconnectNote` 优先（随状态变的） |
| `calendar(range, ctx)` | 交给日历插件显示的日程（外部日历，299 号票）：`[from, to)` 里的，只读、不进素材；日历页标出来自哪个数据源 |
| `localFolder(ctx)` | 它在这台电脑上的文件夹（307 号票：Looki 存到本地的位置）：网页发 `open` 动作时内核用和导入文件夹同一个"在电脑上打开"打开它（测试换成假的） |
| `raw` | 插件自己存储里的原始数据（300 号票：手机的原始位置点、照片的时间地点）：`title`、`days(ctx)`（有哪几天、各几条、整理成摘要了没有）、`clear(dates, ctx)`（清掉几天的）。数据源页按天列出、能按天清掉（动作 `clear_raw`）；不在 `records` 里、不进素材，断开并删时由插件的 `disconnect`（`ctx.purge`）删。设备会把同样的再交一遍的（手机每次读最近几天的照片），插件要记下每天清到哪一刻、那以前的再交来不收，不然清掉的马上回来 |

同步、导入一个文件、设备交来的结果都可以带 `summary`（这次进来的是什么，一句话，走 `t()`），数据源页"上次"那一行写它。

测试用的假数据源插件（只在测试里）：

<!-- 摘自 packages/daemon/test/helpers/fake-data-source.ts -->
```ts
    const fake: DataSource = {
      id: FAKE_SOURCE_ID,
      title: "假数据源",
      // …
      sensitive: ["health", "location"],
      usages: { query: { default: true }, import: { default: true, schedule: { kind: "daily", time: "04:00" } } },
      records: [{ channel: FAKE_CHANNEL, type: FAKE_RECORD }],
      files: [
        {
          title: "假记录文件（.fake）",
          extensions: [".fake"],
          sniff: (head) => head.toString("utf8").startsWith("FAKE"),
          // …
        },
      ],
      status: (c) => {
        if (!c.secrets.has("key")) return { connection: "not_connected" };
        return fakeRemote.keyRefused ? { connection: "error", problem: "Key 失效了", account: "fake-user" } : { connection: "connected", account: "fake-user" };
      },
      async configure(values, c) {
        // …
        c.secrets.set("key", key);
        return { connection: "connected", account: "fake-user" };
      },
      async sync(c) {
        // …
        return { added: ctx.active(FAKE).write(FAKE_RECORD, texts, "sync") };
      },
      // …
    };
    // …
    ctx.dataSources.register(fake);
```

- **为什么写在契约里**（同运行时）：插件停用、没装上、移除了，它的数据源照样在页面上列出（写"X插件没启用"、不能同步和按需查），断开并删照样删得掉它导入的、条数照样数得出；要插件在运行的函数里经 `ctx.active` 现取插件自己的服务，内核只在插件在运行时叫它们。
- **断开**（`DATA_SOURCE_DELETION`，走"删除参与方"登记表）：插件的 `disconnect` 先叫（插件在运行时）、密钥区那一格删掉；选"连已导入的一起删"时同一个事务里 `records` 的事件和它的同步记录整条换成标记、由这些记录采成的素材照彻底删除的口径删（记忆命令的出处是 `data_source`，原文副本、推理库里的证据跟着删）、"已导入"里它的文件提交之后删掉。确认框按数据源说话（306 号票）：页面上带着 `hasSecrets`、`toMaterials`，通用的那几句只在真有密钥、真进素材时出现，别的由数据源的 `disconnectNote` 说。
- **外部日历变了推给网页**（306 号票）：登记了 `calendar` 的数据源，它的 `records` 写进了新事件（同步、设备交来、填设置时写的）、连接状态变了、插件起停了，内核把外部日历的版本往上加，工作日历频道上推临时事件 `external_calendar`，开着的日历页不用换月就重新取——插件什么都不用做，只要日历里显示的东西都来自它登记的 `records` 和连接状态。
- **导入文件夹**（数据目录的 `imports/`，导完挪到 `imports/imported/`）：内核每分钟、文件夹一有变化、用户点"现在检查"时看一遍，认得的先挪进"已导入"再交给数据源导入（同一个文件不会被导两次），导入出错挪回原地；认不出的、几个数据源都认的、插件没启用的、导入关着的、出错的留在原地，页面上写明原因。导入文件夹不进备份快照（原始导出可能很大，导入后的数据在事件和素材里），所以插件别把只存在导入文件里、事件里没有的东西当成留得住的。
- **网页**：数据源页是内核的（`packages/web/src/pages/more/DataSourcesPage.tsx`），插件要在页面上填设置就登记 `dataSources` 插槽（`DataSourceSlot`：数据源 id 和 `Panel`），`owns` 里写上 `dataSources`；插件停用时这一块不画。
- **测**：假内核 `startPluginKernel` 带着数据源那一层（`dataSources`、`openedFolders`），例子是 `packages/daemon/test/data-sources/data-sources.test.ts`；主切面 `packages/daemon/test/main/data-sources.test.ts` 用假数据源插件走真实装配路径（同步采成素材、导入文件夹、断开并删时素材和原文副本跟着删），`packages/daemon/test/main/data-source-evidence.test.ts` 走到每晚整理（三种素材的证据性质、场景、敏感类别）。

**真的例子：Looki 插件**（`packages/daemon/src/looki/`，296 号票）：接 Looki 挂脖相机的官方开放接口（API Key、只读）。数据源的函数都是一行，经 `ctx.active` 现取插件自己的服务：

<!-- 摘自 packages/daemon/src/looki/plugin.ts -->
```ts
      const source: DataSource = {
        id: LOOKI_SOURCE_ID,
        // …
        sensitive: ["location", "emotion", "health"],
        usages: { query: { default: true }, import: { default: true, schedule: { kind: "daily", time: LOOKI_IMPORT_TIME } } },
        records,
        status: (c) => ctx.active(LOOKI).status(c.secrets),
        configure: (values, c) => ctx.active(LOOKI).configure(values, c.secrets),
        sync: (c) => ctx.active(LOOKI).sync(c),
        disconnect: () => ctx.active(LOOKI).reset(),
        tools: (c) => [lookiQueryTool(() => ctx.active(LOOKI), c.secrets, t("looki.tool.title"), () => ctx.active(LOOKI).today())],
      };
```

接外部接口的几条做法（都在 Looki 里）：

- **地址写死、只选区域**：两个区域的接口地址是代码里的常量（`looki/client.ts`），用户只选区域，Key 只发给这两个地址；测试连接直接拿 Key 调所选区域的 `/me`，一步判断。
- **先测再存**：`configure` 拿 Key 真调一次（读账号），过了才 `ctx.secrets.set`；账号打码后也存在那一格里，`status` 要快，不调接口。
- **出错分种类、给人看的走 `t()`**：Key 不认（状态是"出错"，要重新填，定期导入也停）、限速（同步里按 `Retry-After` 等一会儿再试，状态写明）、连不上、那边出错；原因里不带 Key（内核记下之前还会再换一遍 `***`）。给秘书的工具结果另写给模型看的中文。
- **宽松地读回包**：官方文档没写清的（外面包不包一层、时间的写法、字段在哪）多认几种写法，整理成插件自己的记录负载再写事件；照片、预签名链接这类不写进事件。
- **测试接本机的假接口**：插件写成 `createLookiPlugin(options)`，接口地址、限速要等多久都能换；假接口 `packages/daemon/test/helpers/fake-looki.ts` 照官方文档的返回格式写剧本（Key 不对回 401、限速回 429……），只听 127.0.0.1；主切面经 `extraPlugins` 换掉清单里的同名插件（`packages/daemon/test/main/looki-plugin.test.ts`）。测试里只许连本机回环地址，插件用调用时现取的 `globalThis.fetch`，连外网当场红。

#### 把记录写成素材（303 号票）

数据源导入的东西进记忆只有一条路：插件写自己的事件，在数据契约里登记采集规则，规则里用 `dataSourceMaterial(数据源, 记录)`（`packages/daemon/src/data-sources/material.ts`，从 `data-sources/index.ts` 取）把一条事件写成素材草稿。素材分三种（issue 25 第 2 节"按来源定证据的性质"，名字见 CONTEXT.md），**按"这是谁做的、谁说的"选**，不按数据源选——同一个数据源可以出几种（Gmail 发出的是本人写的、收到的是别人写给你的）：

| 种类（`kind`） | 是什么 | 素材 | 读成证据 |
|---|---|---|---|
| `observed_behavior` 观察到的本人行为 | 本人做的事：挂脖相机的一个时刻、一天拍照去过的地方、位置摘要、消费、运动 | 来源本人、"做"；`text` 是插件整理好的摘要，一段"文字"，留原文副本 | 本人做的（出处 observed），**能撑关于用户的结论** |
| `received_writing` 别人写给你的 | 收到的邮件、群里别人的话 | 来源外部（不可信）、"说"；`text` 是摘要（发件人和主题、一句话），一段"引用块"只留摘要和正文的哈希，正文要检索得到就给 `indexText`（只进索引） | 别人转述的（third_party_reported），**只当背景、不撑结论**；原文只有摘要 |
| `own_writing` 本人写的 | 发出的邮件、笔记、日记 | 来源本人、"说"；`text` 是原话，一段"打的字"，留原文副本 | 本人说的（user_stated） |

<!-- 摘自 packages/daemon/test/helpers/fake-data-source.ts -->
```ts
      ctx.materialSources.register({
        name: `fake-source-${type}`,
        eventType: type as EventType,
        capture: (event) => {
          const p = event.payload as FakeRecordPayload;
          return [
            dataSourceMaterial(source, {
              kind: p.kind ?? "observed_behavior",
              text: p.text,
              time: p.at,
              // …
              recordId: p.id,
            }),
          ];
        },
      });
```

记录里另外几样（`DataSourceRecordMaterial`）：

- **`time` 和 `scene`（场景）**：`time` 是开始的时间（不给用事件的时间），`scene` 里写结束时间 `end`、地点 `place`（给人看的名字）、和谁 `people`（称呼）、场景标签 `tags`（`work`、`social`、`family`、`travel`、`leisure`……记忆引擎认得的才算，认不出就别写）。数据源顺带知道这些，**能给就给**：记忆插件把它们接在证据原文后面一行"［场景］时间 14:00–17:00 · 地点 望京的公司 · 和 张三"给整理模型读，场景标签取你给的、再按日子补上工作日 / 周末——现在九成证据没场景，就靠数据源补。地点、和谁也进素材的检索。
- **`sensitive`（这条落在哪些敏感类别）**：不写就是数据源登记的 `sensitive` 全部（保守）。有一类没打开推断（`memory.sensitiveCategories`，默认都没打开），整条不读成证据——所以**按记录写窄**：挂脖相机拍到开会不涉及健康，写 `sensitive: []`；心率、体检写 `["health"]`，账单写 `["finance"]`。**地点不用为它写"位置"**：地点放进 `scene.place`，位置没打开时证据里只去掉地点、这条照读；一整条就是位置的（"今天去过哪、各待了多久"）才写 `["location"]`。
- **量大的先整理**：写进事件之前就整理成一段一段（一个时刻一条、一天的照片一条、一天的位置一条），原始的点、照片留在来源那边或插件自己的存储里。记忆这边另有一道：同一个数据源、同一种、同一天超过 3 条，每晚整理时合成一条证据（每条一行）；当天的等这一天过完再读；一夜最多读进 12 条数据源的证据（合成的算一条），多的按时间先后留到下一夜——用户说的话照旧全读，不被挤掉。
- **确定性**：采集规则只看事件本身（ADR-0006）。场景、敏感类别都写进事件负载，别在规则里读时钟、读设置、读插件的存储；彻底删除的改写函数把原话、地点、和谁、正文一起换掉。

第一波的写法：Looki（296）一个时刻一条 `observed_behavior`，`text` 是标题加描述，`scene` 给起止时间、地点（时刻的位置名）、标签认得出就给，`sensitive: []`；AI 日记是 Looki 的 AI 替用户写的，一篇一条 `received_writing`（说明"Looki · 标题"加摘要，全文给 `indexText` 只进检索），`sensitive: ["emotion", "health"]`——默认这两类没打开推断，所以默认只进检索（`packages/daemon/src/looki/materials.ts`）；手机（300）照片一天一条、位置一天一条 `observed_behavior`（照片那条地点放 `scene.place`、正文里不写地点、`sensitive: []`；位置那条整条是位置，`sensitive: ["location"]`。原始的照片时间地点、位置点存在插件自己的存储里按天整理、登记 `raw` 让用户按天清掉，今天的等过完这一天再整理，整理之后又交来那天的补一条——见 `packages/daemon/src/phone/photos-location.ts`；308 号票起地点按"起了名的 > 系统地名 > 坐标"写，地名是 App 在手机上用系统的坐标转地址转好交来的，守护进程不联网，起了名的常去的地方存在插件自己的存储里——改名后以前的摘要不重写，因为摘要写成事件就不动了，采集规则也不能去读存储）；Gmail（298）开了"导入我发出的邮件"才写，一封一条 `own_writing`（`text` 是主题加去掉引用原文的正文，`scene.people` 写收件人，`sensitive` 按关键词写窄：明显是财务、健康的标上，判不准的不标）；收到的邮件默认不导入，以后要导就是 `received_writing`（`text` 写"发件人：主题"，正文给 `indexText`）；Google 日历（297）和手机日历给日历插件，不写素材。

**真的例子：手机插件**（`packages/daemon/src/phone/`，299、300 号票）：四个数据源都是设备交来的（`push`），通讯录挑的人交给个人档案的候选核对卡，手机日历交给日历插件（`calendar`），这两个不进记忆素材；照片的时间地点、位置按天整理成摘要事件、登记采集规则进素材，原始数据给 `raw`：

<!-- 摘自 packages/daemon/src/phone/plugin.ts -->
```ts
    const calendar: DataSource = {
      id: PHONE_CALENDAR_SOURCE,
      // …
      usages: { import: { default: true } },
      records: [{ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_EVENT }],
      status: () => ctx.active(PHONE).calendarStatus(),
      push: { body: PhoneCalendarPush, receive: (data) => ctx.active(PHONE).receiveCalendar(data as PhoneCalendarPush) },
      count: () => ctx.active(PHONE).calendarCount(),
      calendar: (range) => ctx.active(PHONE).calendarEvents(range),
      disconnect: () => ctx.active(PHONE).unlinkCalendar(),
    };
```

- **不进素材也能接**：数据源只产素材是说"要进记忆就走素材"；通讯录挑的人走个人档案的候选（用户逐条确认才写进档案）、日历走日历插件，都不进素材。断开并删时 `records` 照删，别的模块里从它来的东西由那个模块登记删除参与方（个人档案的候选就是这么删的）。
- **网页那一半**：`dataSources` 插槽画按钮（在手机 App 里才有用，不在 App 里写明；照片、位置两块另写耗电和隐私说明），`background` 插槽两个后台部件（App 开着时定时同步）。原生桥的方法见 `frontend/harmony/entry/src/main/ets/bridge/NativeBridge.ets`，网页一侧的包装在 `packages/web/src/app/native-app.ts`。
- **插件自己的一块设置（`panel` + `configure`）**：308 号票"手机 · 位置"下面的"常去的地方"——`status()` 带 `panel`（协议包 `phone.ts` 的 `PhonePlacesView`，没连着也带），起名、改名、删经 `configure` 交来（`values.places` 是哪一样，同 Looki 的 `values.archive`），做不成的原因写进 `panel.refused`，不让 `configure` 回"出错"——内核会把出错的状态当成"填设置没过"一直挂在那一行上，而这种设置跟连没连上无关。数据存在插件自己的存储里的，"断开并删"时由插件的 `disconnect`（`purge`）一起删，并在 `disconnectNote` 里说一句。

**真的例子：Google 插件**（`packages/daemon/src/google/`，297 号票）：日历订阅（私密 iCal 地址），有连接、要定时拉的数据源照它写：

<!-- 摘自 packages/daemon/src/google/calendar-source.ts -->
```ts
    usages: {
      query: { default: true },
      import: {
        default: true,
        schedule: { kind: "every", minutes: GOOGLE_CALENDAR_SYNC_MINUTES },
        get destination() {
          return t("google.calendar.destination");
        },
        syncOnConnect: true,
      },
    },
    // …
    count: () => active().count(),
    calendar: (range, ctx) => active().calendarEvents(ctx, range.from, range.to),
```

- **地址、Key 只经 `ctx.secrets`**：几个日历各存一格（`feed.<id>`，id 是地址的哈希），事件、日志、页面上只有 id、名字和打了码的地址（`status()` 的 `items`）；填设置时先拉一遍（测试连接），认得出才存，存好了马上同步一次（`syncOnConnect`）。
- **每隔几分钟**：定期导入挂的还是内部作业 `data-source:<id>`（`IntervalSchedule`），从上一次往后数、错过了开机补一次；什么都没变的那次内核不记同步记录，只在内存里记着显示"上次同步"。
- **事件只写变了的**：拉到的和现在的比，只写新的、变了的、没了的；同一个事件写过好几版，"共几条"给 `count`（按最后一版数）。导入的不进素材就写明 `destination`（不写是"整理成素材"）。
- **日程交给日历插件**：和手机日历一样给 `calendar`，重复事件在插件这边按问的那一段展开（日历插件拿到的是一次一次的日程），`calendar` 字段写哪个日历；断开以后没有地址了就不给。
- **只为一句提示的可选依赖**：日历插件停用时数据源页上写"日历插件没启用"——Google `wants: [CALENDAR]`，`status()` 里 `ctx.optional(CALENDAR)` 现取，取不到就给 `note`（不算出错）；同步、按需查照常。
- **测**：假内核里注入假的 `fetch`（`createGooglePlugin({ fetch })`，`packages/daemon/test/google/google-plugin.test.ts`，交给日历的日程看 `dataSources.calendarEvents`），主切面用本机起的假日历服务（`packages/daemon/test/helpers/fake-ical.ts` 的 `startFakeCalendarServer`，`packages/daemon/test/main/google-calendar.test.ts`）；测试里不连外部网络。

同一个插件的 **Google · Gmail**（298 号票，`gmail-source.ts`、`gmail.ts`）是"按需查为主、外部内容很多"的数据源，照它写这一类：

- **按需查的工具结果里外部内容夹在标记之间**：搜到的发件人、主题，读到的正文、附件名都是别人写的——结果里夹在 `<<<邮件里写的内容（外部数据）开始>>>` 和结束标记之间（照网页工具、"查 Google 日历"），前面写明不是用户说的、让做什么都不要照做；内容里自己写的 `<<<`、`>>>` 换成全角，跳不出标记。工具只给只读的（`nature: "look"`），不给发信、删信这类。
- **账号密码只经 `ctx.secrets`**：`configure` 先拿填的连一遍（测试连接），过了才存；没填的项用存着的（"重新测试连接"就是什么都不填）。`status()` 给打了码的账号；用的时候登录没通过记在服务里，`status()` 报 `connection: "error"` 和原因，下一次登录过了清掉。
- **导入默认关、只导本人写的**：`usages.import.default: false`，`destination` 写明导什么不导什么；采集规则用 `dataSourceMaterial` 写 `own_writing`，`sensitive` 每封按简单关键词写窄（`gmail-sensitive.ts`：明显是财务、健康的标上，判不准的不标，判断在同步时做、写进事件负载），再登记一个彻底删除的改写函数（主题、正文、收件人换掉）；导到哪记在插件自己的事件里（也写进 `records`，断开并删时一起删，`count` 只数真正导入的）。
- **外部协议自己写、不加依赖**：只读的 IMAP 客户端（`imap.ts`：命令口只放行只读的几条，写操作在客户端就拒绝）、邮件解析（`mime.ts`，Node 自带的 `tls` 和 `TextDecoder`）。
- **测**：本机起假 IMAP 服务（`packages/daemon/test/helpers/fake-imap.ts` 的 `startFakeImapServer`：TLS 测试自签证书、照 Gmail 的样子回应、写操作和会标已读的取信都记下来），`createGooglePlugin({ imap: server.endpoint })` 接上；假内核 `packages/daemon/test/google/gmail.test.ts`，主切面 `packages/daemon/test/main/google-gmail.test.ts`（经 `extraPlugins` 换掉清单里的 Google 插件）。

**真的例子：Google · 联系人**（同一个插件的第三个数据源，301 号票）：只靠导入文件夹、导入的东西进个人档案候选（不进素材）的数据源照它写：

<!-- 摘自 packages/daemon/src/google/contacts-source.ts -->
```ts
    usages: {
      import: {
        default: true,
        get destination() {
          return t("google.contacts.destination");
        },
      },
    },
    // …
    files: [
      {
        get title() {
          return t("google.contacts.file");
        },
        extensions: [".vcf", ".vcard"],
        sniff: (head) => looksLikeVcard(head),
        import: (file, ctx) => active().importFile(file, ctx),
      },
    ],
    count: () => active().count(),
```

- **认文件**：扩展名加内容特征（开头 4 KB 里有 `BEGIN:VCARD`）都对上才认；读不出东西的在 `import` 里抛错（文件留在导入文件夹、页面上写原因），结果的 `summary` 写这次进来的是什么（数据源页"上次导入"那一行）。不写 `status` 就是"手动导入"：页面上没有连接、没有立即同步，断开叫"删除已导入的"。
- **进档案候选和手机通讯录选人同一条路**：`KERNEL.personalFiles` 的 `addCandidates("vcard", …)` + `composeCandidates()`，带 `dataSource`（删除已导入的时个人档案登记的删除参与方按它删还没写进档案的候选）。候选那一侧认人、规范化、和档案一样的不提、拒过的不再提，插件不管；插件只管"谁进、进哪几样"（本人那张、家人带关系、档案里有的、有生日纪念日关系的；一个字段几个值时多的给 `also`）。
- **量大的分批**：一份通讯录可能几百人——只取够格的人，再一批 10 个人交（一张卡最多带 100 条），交过的写一条自己的事件（哪几个人、合进了哪张卡）；插件经 `ctx.effect` 订阅事件存储里的 `card` 事件，那张卡处理完了接着交下一批，插件停着时处理的在 `lifecycle.start` 里补。同一份再导一次不重复：同一个人同一个字段同一个值记过就不再记、不再交。
- **测**：`packages/daemon/test/google/google-contacts.test.ts`（假内核 + 假的个人档案 `packages/daemon/test/helpers/fake-personal-files.ts`，往 `k.layout.imports` 放文件、`k.dataSources.scan()`）、主切面 `packages/daemon/test/main/google-contacts.test.ts`（真的档案、经 `POST /api/import-folder` 看一遍）。

## 8. 热插拔要守的规矩

用户能在设置 · 插件里运行中停用、启用、移除，马上生效、不重启。代码一直在（移除不卸载代码），每次启用是**新的一次装配**。插件要守的：

1. **每次登记都能撤销**：一律经 `ctx` 登记；自己开的定时器、订阅、监听交给 `ctx.effect`，要起停的交给 `ctx.lifecycle`。漏了的会在停用后接着跑。
2. **别人的服务现取**：`ctx.optional` 每次用的时候取；卡片动作、前端请求里用 `ctx.active`。存起来的引用在提供方停用后就是死的。
3. **停用后的状态**：它的服务取到 `undefined`，`active` 回"X插件没启用"；给 agent 的工具、上下文块从下一轮起没有（正在跑的一轮里再调回没启用）；视图摘下、停着；网页上它的页面和栏目马上收起，它拥有的位置显示"（X插件没启用，这条内容暂时看不到）"；依赖它的插件（`needs`）一起停，`wants` 它的照常。
4. **再启用时补齐**：`setup` 重新跑一遍（闭包是新的，上一次的 `ctx` 不能再用）；视图整表补齐停着时没看到的事件；`start` 里补上停着时错过的——提醒重新登记还没到点的计时，记忆从停下的采集位置补采，语音接着识别排着的。
5. **"X插件没启用"一个说法**：给人看的用 `t("plugins.notEnabled", { title })`（`plugins.active`、`ctx.active` 自动带），给模型看的照宿主包工具那一句的中文写；网页的占位核心画，插件不用管。
6. **停用不等于出错**：配置里停用的不算降级；装配、启动出错的只撤它和依赖它的，守护进程照常起来。

## 9. 多语言

- **给人看的走 `t()`**：定义里的 `title`、`summary`、`brings`，`removal.declare` 的 `deletes`、`keeps`，卡片、通知、回执，都写成取值函数（`get title() { return t("…"); }`），跟着当前语言：

<!-- 摘自 packages/daemon/src/reminders/plugin.ts -->
```ts
export const remindersPlugin: PluginDefinition = {
  name: "reminders",
  get title() {
    return t("reminders.plugin.title");
  },
  get summary() {
    return t("reminders.plugin.summary");
  },
```

- **key 的第一段是目录名**：守护进程 `notes/` 里的写 `notes.plugin.title`，放进 `packages/protocol/locales/zh-CN/<目录名>.json` 和 `en/` 下的同名文件（文件名就是区域，两种语言一一对应）。网页插件的写在 `ui.json` 的 `ui.plugins.<名字>.*`。
- **给模型看的只用中文**：工具说明、参数说明、工具结果、系统提示片段、上下文块、输入附注不翻，标 `// @i18n-ignore model`（整个文件都是的写 `// @i18n-ignore-file model：……`）；日志标 `log`（直接写在 `log(…)` 里的不用标）。一个函数同时给人和给模型看的，给模型那份包 `forModel(() => …)`。
- 写死中文的棘轮（`packages/daemon/test/i18n/hardcoded.test.ts`）每个区域是 0：新插件给人看的字一个都不能写死。`npm run i18n:check` 查英文缺没缺。规矩全文见[开发者指南](../developer-guide.md)的"多语言"。

## 10. 怎么测

| 测什么 | 怎么测 | 例子 |
|---|---|---|
| 装上、停用、启用、移除 | 假内核 `startPluginKernel`（真的插件宿主、登记表、设置那一层，临时数据目录；插件要的内核服务默认之外用 `extraService` 补） | `packages/daemon/test/plugins/plugin-guide.test.ts` |
| 边界 | 每个插件一条：组合根不出现它、目录之外只 import `api.ts`、数据契约的形状 | `packages/daemon/test/calendar/boundary.test.ts` |
| 走真实装配路径 | 主切面 `startTestDaemon({ plugins, extraPlugins })`：经组合根和插件清单起真的守护进程，停用只经数据目录配置或设置 · 插件的接口；给秘书的工具、提示、页面指令都看 | `packages/daemon/test/main/plugin-guide.test.ts`（笔记）、`calendar-plugin.test.ts`、`voice-plugin.test.ts`、`browsing-plugin.test.ts` |
| 网页收到什么 | 主切面 `plugin-status.test.ts` 录下网页收到的事件流（`packages/web/test/state/recordings/plugins-*.json`），网页测试原样回放、用真的网页插件清单装上，查插槽和占位 | `packages/web/test/plugins/assembly.test.ts`、`settings.test.ts` |
| 网页插件本身 | 网页插件宿主按报的状况装和停 | `packages/web/test/plugins/plugin-guide.test.ts` |
| 页面打得开 | `page-opens.test.ts` 用真 Chrome 打开构建产物，带 `?demo-plugins-off=<名字>` 每一页照样打得开 | `packages/web/test/page-opens.test.ts` |
| 截图 | 原型（`file://`）开着、停用各截改动的地方 | 212–214 号票的 Comments |

只在假内核里测过的插件不算上线过（ADR-0027 引的 dsh 复盘：手挂插件的单元测试全过、上线即崩），主切面至少一条。改完跑和改动相关的测试（`npx vitest run <测试文件>`），主切面挑相关的单独跑。

**加一个插件会动到列插件的断言**：`report().running`、`/healthz`、插件状况、设置 · 插件的清单、网页 `assembly.test.ts` 和 `boundary.test.ts` 的插件列表、原型的假插件；`startTestDaemon({ plugins: [...] })` 是"只装这些"，意思是"只停某一个"的地方要补上新插件；录下的 `plugins-*.json` 要重录（212–214 号票每张都改过这一圈）。

## 11. 上线

- [ ] 守护进程、网页两份清单各加一行（先后一样，新的排最后）；原型的 `fake-plugins.ts` 加上。
- [ ] 语言文件中英两份（守护进程的区域、网页的 `ui.plugins.<名字>.*`），`npm run i18n:check` 过。
- [ ] 文档：`docs/developer-guide.md` 和 `docs/developer-guide.en.md` 的模块表里加一行这个插件，用户看得到的写进 `docs/user-guide.md` 和 `docs/user-guide.en.md`；ADR-0027 加一段（拆插件、取舍）；`CONTEXT.md` 有新词时加；CHANGELOG。
- [ ] `npm run typecheck`、`npm run lint`、受影响的测试、相关主切面过。
- [ ] 合进 main 后经 LSM 重启守护进程（网页跟着守护进程一起发），`npm run smoke:page` 真的打开页面看一眼。鸿蒙 App 不用重装，除非改了原生部分。

## 附：名字表

<!-- 名字表 -->
| 名字 | 文件 | 说明 |
|---|---|---|
| `PluginDefinition`、`PluginContext`、`ContractContext`、`PluginLifecycle` | `packages/daemon/src/plugins/host.ts` | 插件的定义、装配时的 `ctx`、数据契约的 `ctx`、启停 |
| `serviceKey`、`bindService`、`ServiceKey` | `packages/daemon/src/plugins/host.ts` | 服务名；组合根绑内核的服务 |
| `PluginHost.service`、`PluginHost.active`、`PluginHost.enable`、`PluginHost.disable`、`PluginHost.remove`、`PluginHost.viewsOf` | `packages/daemon/src/plugins/host.ts` | 内核现取插件的服务；运行中停用、启用、移除 |
| `KERNEL` | `packages/daemon/src/plugins/kernel.ts` | 内核给插件的服务 |
| `PLUGIN_MANIFEST` | `packages/daemon/src/plugins/manifest.ts` | 守护进程的插件清单 |
| `PluginDataRemoval`、`purgePluginData` | `packages/daemon/src/plugins/removal.ts` | 移除时连数据删 |
| `AgentRuntime`、`createRuntimeRegistry`、`piRuntime` | `packages/daemon/src/runtime/runtimes.ts` | agent 运行时、运行时的登记表、内核自带的 pi |
| `RUNTIME_OPERATIONS`、`RuntimeCapabilities`、`RuntimesView` | `packages/protocol/src/runtimes.ts` | 能力清单的项、能力清单、`GET /api/runtimes` 的样子 |
| `createRuntimeGate` | `packages/daemon/src/agent-host/runtime-gate.ts` | 运行时闸门：维护者用的运行时能不能用、该不该停在等我 |
| `createPluginSettings` | `packages/daemon/src/plugins/settings.ts` | 设置 · 插件：写配置、连数据删 |
| `ContributionScope`、`ToolContribution`、`ContextContribution`、`HookContribution`、`NoteContribution` | `packages/daemon/src/agent-host/contributions.ts` | agent 贡献：给谁、工具、上下文块、钩子、输入附注 |
| `SECRETARY_TARGET` | `packages/daemon/src/secretary/secretary.ts` | 秘书这一份装配（测试里查秘书拿到的贡献） |
| `defineHostTool`、`HostTool` | `packages/daemon/src/agent-manager/host-tools.ts` | 守护进程代为执行的工具 |
| `PluginPrompts`、`PluginPromptFragment` | `packages/daemon/src/prompts/registry.ts` | 系统提示里的条件、占位符、片段 |
| `DerivedView`、`EventStore.attachView`、`EventStore.detachView` | `packages/daemon/src/events/event-store.ts` | 派生视图；运行中登记回去、摘下 |
| `PurgeRewriter` | `packages/daemon/src/events/purge.ts` | 彻底删除的改写函数 |
| `MaterialSource` | `packages/daemon/src/materials/capture.ts` | 事件怎么变成素材 |
| `CardTypeDefinition` | `packages/daemon/src/cards/registry.ts` | 卡片类型 |
| `InternalJob` | `packages/daemon/src/scheduler/internal-jobs.ts` | 内部作业 |
| `RequestHandlers` | `packages/daemon/src/gateway/gateway.ts` | 网关的请求（可选的那些插件能登记） |
| `WebPluginDefinition`、`WebPluginContext`、`createWebPluginHost` | `packages/web/src/plugins/host.ts` | 网页插件的定义、装配时的 `ctx`、宿主 |
| `SlotMap`、`PageSlot`、`CardSlot`、`SLOT_KEYS` | `packages/web/src/plugins/slots.ts` | 类型化插槽 |
| `WEB_PLUGIN_MANIFEST` | `packages/web/src/plugins/manifest.ts` | 网页的插件清单 |
| `usePlugins`、`useRouteAvailable` | `packages/web/src/plugins/react.tsx` | 取网页插件宿主；去某个地址的链接出不出 |
| `maskUnavailable` | `packages/web/src/state/chat-items.ts` | 会话条目归停用的插件的换成占位 |
| `startPluginKernel`、`extraService` | `packages/daemon/test/helpers/plugin-kernel.ts` | 插件的假内核 |
| `startTestDaemon` | `packages/daemon/test/helpers/daemon.ts` | 主切面的测试守护进程（`plugins`、`extraPlugins`） |
| `fakeRuntimePlugin`、`fakeRuntime` | `packages/daemon/test/helpers/fake-runtime.ts` | 测试用的假运行时插件 |
| `createClaudeCodePlugin`、`claudeCodePlugin` | `packages/daemon/src/claude-code/plugin.ts` | Claude Code 插件（287 号票：带 agent 运行时的真插件） |
| `ClaudeSessionSource`、`oneShotSessionSource`、`listResumable` | `packages/daemon/src/claude-code/sessions.ts` | Claude Code 本机会话的来源（290 号票：列会话、占用、前情、分叉；真的经一次性子进程） |
| `KERNEL.oneShot` | `packages/daemon/src/plugins/kernel.ts` | 拉一次性子进程（白名单环境、Job 对象、超时；内核服务，290 号票） |
| `FakeClaudeSessions`、`fakeTakeoverClaudeCodePlugin` | `packages/daemon/test/helpers/fake-claude-sessions.ts` | 假的本机会话来源（主切面） |
| `claudeCodeRuntime`、`CLAUDE_CODE_CAPABILITIES`、`CLAUDE_CODE_CHILD_ENTRY` | `packages/daemon/src/claude-code/runtime.ts` | Claude Code 运行时、能力清单、子进程入口 |
| `runClaudeChild` | `packages/daemon/src/claude-code/child/child.ts` | Claude Code 子进程的宿主协议这一层（SDK 的 `query` 由入口注入） |
| `createFakeClaudeSdk`、`scriptedClaudeSdk`、`FakeClaudeQuery` | `packages/daemon/test/helpers/fake-claude-sdk.ts` | 假的 Agent SDK（契约测试、主切面） |

| `DataSource`、`DataSourceFileType`、`DataSourceSecrets`、`DataSourceContext` | `packages/daemon/src/data-sources/api.ts` | 数据源、认的一种文件、密钥区的那一格、叫数据源的函数时交的 |
| `dataSourceMaterial`、`DataSourceRecordMaterial` | `packages/daemon/src/data-sources/material.ts` | 数据源的一条记录写成素材草稿（303 号票：三种素材、场景、敏感类别） |
| `createDataSourceRegistry`、`DataSourceRegistry` | `packages/daemon/src/data-sources/registry.ts` | 数据源的登记表 |
| `createDataSources`、`DataSources` | `packages/daemon/src/data-sources/service.ts` | 设置 · 数据源：页面、动作、定期导入、按需查的工具、导入文件夹 |
| `DATA_SOURCE_DELETION` | `packages/daemon/src/deletion/participants.ts` | 断开数据源时连已导入的一起删（删除参与方的一种删除） |
| `DataSourceSlot` | `packages/web/src/plugins/slots.ts` | 网页的数据源设置插槽 |
| `DataSourcePush`、`DataSourcePushOutcome`、`DataSourceCalendarEvent` | `packages/daemon/src/data-sources/api.ts` | 设备交来的、交回的、交给日历插件的一条日程（299 号票） |
| `KERNEL.externalCalendars` | `packages/daemon/src/plugins/kernel.ts` | 数据源交给日历插件的外部日历（内核服务，299 号票） |
| `fakeDataSourcePlugin` | `packages/daemon/test/helpers/fake-data-source.ts` | 测试用的假数据源插件 |
| `DataSourceSchedule`、`DataSourceItem` | `packages/daemon/src/data-sources/api.ts` | 定期导入的时间（提醒那一套或每隔几分钟）、数据源下面的一样（297 号票） |
| `IntervalSchedule`、`JobSchedule` | `packages/daemon/src/scheduler/internal-jobs.ts` | 内部作业的"每隔几分钟"、内部作业的时间表（297 号票） |
| `createGooglePlugin`、`googlePlugin` | `packages/daemon/src/google/plugin.ts` | Google 插件（297 号票：第一个真的数据源插件） |
| `createGoogleCalendar`、`GoogleCalendarService` | `packages/daemon/src/google/calendar-feeds.ts` | Google 日历订阅：存地址、测试连接、同步、展开 |
| `parseIcal`、`IcalEvent` | `packages/daemon/src/google/ical.ts` | iCal 解析（不加依赖） |
| `expandEvents` | `packages/daemon/src/google/recurrence.ts` | 重复事件只展开要看的那一段 |
| `fakeCalendarFetch`、`startFakeCalendarServer` | `packages/daemon/test/helpers/fake-ical.ts` | 测试用的假日历（注入的假 fetch、本机假服务） |
| `createGmail`、`GmailService` | `packages/daemon/src/google/gmail.ts` | Gmail：存设置、测试连接、搜、读、导入我发出的邮件（298 号票） |
| `connectImap`、`assertReadOnly` | `packages/daemon/src/google/imap.ts` | 只读的 IMAP 客户端（不加依赖）、只放行只读命令的那一道 |
| `parseMail`、`stripQuoted` | `packages/daemon/src/google/mime.ts` | 邮件解析（不加依赖）、本人写的去掉引用的原文 |
| `startFakeImapServer` | `packages/daemon/test/helpers/fake-imap.ts` | 测试用的假 IMAP 服务（本机、TLS 测试证书） |
