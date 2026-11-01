---
name: ergo-data-source
description: 写二狗（ergo）数据源插件时用：接一种外部数据（账号、接口、手机、导出文件），要做填 Key 或授权、同步、存本地、写成记忆素材、在设置 · 数据源里给用户看、断开和删除。先读 ergo-plugin，数据源也是插件。
---

# 写数据源插件

先读 `.claude/skills/ergo-dev/SKILL.md` 和 `.claude/skills/ergo-plugin/SKILL.md`。字段的完整说明在 `docs/architecture/plugin-development.md` 第 7 节"数据源贡献点"，类型在 `packages/daemon/src/data-sources/api.ts` 的 `DataSource`。

每种外部数据一个插件。插件在 `contracts` 里 `ctx.dataSources.register(source)`：停用、移除了照样在页面上列出，断开并删照样删得掉。内核替它画页面、定时、数条数、给秘书工具、管密钥区、做删除。

## 照哪个写

| 数据长什么样 | 照 |
|---|---|
| API Key、定期导入、按需查、写成素材 | Looki：`packages/daemon/src/looki/plugin.ts`、`materials.ts`、`service.ts`，网页 `packages/web/src/plugins/looki/` |
| 要定时拉的连接，日程交给日历显示 | Google 日历：`packages/daemon/src/google/calendar-source.ts`、`calendar-feeds.ts` |
| 账号密码，按需查为主，能连几个账号 | Gmail：`packages/daemon/src/google/gmail-source.ts`、`gmail-accounts.ts`、`gmail-tools.ts` |
| 只靠导入文件夹，进个人档案候选 | Google 联系人：`packages/daemon/src/google/contacts-source.ts`、`contacts.ts` |
| 手机等设备交来，有原始数据 | 手机：`packages/daemon/src/phone/plugin.ts`、`photos-location.ts` |
| 最小骨架（只在测试里） | `packages/daemon/test/helpers/fake-data-source.ts` |

## 骨架

数据源的函数都是一行，经 `ctx.active` 现取插件自己的服务（内核只在插件运行时叫它们）：

```ts
contracts(ctx) {
  const records = [{ channel: DEMO_CHANNEL, type: DEMO_RECORD }];
  const source: DataSource = {
    id: "demo", // 小写英文、数字、连字符，定了别改
    get title() { return t("demo.source.title"); },
    sensitive: [],
    usages: { import: { default: true, schedule: { kind: "daily", time: "04:00" } } },
    records,
    status: (c) => ctx.active(DEMO).status(c.secrets),
    configure: (values, c) => ctx.active(DEMO).configure(values, c.secrets),
    sync: (c) => ctx.active(DEMO).sync(c),
    disconnect: () => ctx.active(DEMO).reset(),
  };
  ctx.dataSources.register(source);
  ctx.materialSources.register(demoMaterialSource(source));
  ctx.purge.register(demoPurge);
  ctx.removal.declare({ /* 第 6 步 */ });
},
```

插件标题写成 `数据源-名字`，英文 `Data source - Name`，语言文件里写。

## 步骤

### 1. 授权

仓库里没有 OAuth 流程。现有的都是用户填一样东西：Key（Looki）、私密地址（Google 日历）、应用专用密码（Gmail），或者手机上的授权（手机）。

- `configure(values, ctx)`：**先测再存**。拿填的真调一次，过了才 `ctx.secrets.set`，交回 `DataSourceStatus`。
- 密钥只经 `ctx.secrets`，落在密钥区 `secrets/data-sources/<id>.json`，不进仓库、事件、日志。一个值一格，别拼成一段：内核按格把出错原因里的密钥换成 `***`。
- 接口地址写死在代码里，用户只选区域（`packages/daemon/src/looki/client.ts`）。
- `status(ctx)` 要快、不连网。同步或按需查碰到 Key 失效，记在内存里，下一次报 `connection: "error"`；要用户重新填的带 `needsAuth: true`。一时的限速、超时照样报连着，原因写 `problem`。
- `recheck(ctx)`：出错后内核每小时叫一次，用存着的设置再测，好了下次 `status` 报连着。

网页：`dataSources` 插槽（`{ id, Panel }`，`owns: { dataSources: [id] }`）画填写那一块，经 `http.dataSourceAction(id, { action: "configure", values, idempotencyKey })` 交，照 `packages/web/src/plugins/looki/LookiPanel.tsx`。密码框不回显，发完清掉。

### 2. 同步

- `usages.import`：`default` 默认开不开；`schedule` 是 `{ kind: "daily", time }` 或 `{ kind: "every", minutes }`；`syncOnConnect` 填好就同步一次；导入的不进素材时写 `destination`，走 `t()`。
- `sync(ctx)` 交回 `{ added, summary? }`。`ctx.signal` 在断开、停用、守护进程停时置位，要停下。
- 文件导入：`files` 里写 `extensions`、`sniff`、`import`。内核看导入文件夹 `imports/`，导完挪进 `imports/imported/`。这个文件夹不进备份，别把只存在文件里的东西当成留得住。
- 设备交来：`push: { body, receive }`，`body` 是 TypeBox schema，经 `POST /api/data-sources/<id>/push`。
- 只写变了的；同一条写过几版时给 `count`。

### 3. 存本地

| 什么 | 存哪 |
|---|---|
| 拿进来的记录 | 插件自己的事件，频道和类型写进 `records` |
| 密钥 | `ctx.secrets` |
| 量大的原始数据（位置点、照片的时间地点） | 插件自己的存储（`KERNEL.layout` 取数据目录），按天整理成摘要再写事件，登记 `raw`（`days`、`clear`）。设备会重交的要记下清到哪一刻 |
| 给用户留的文件 | 用户电脑上的文件夹，`localFolder` 让页面能打开（Looki 的 `archive.ts`） |

### 4. 写成素材（要进记忆时）

只有这一条路：写事件，登记采集规则。不碰推理图谱，不直接写个人档案（进档案走候选核对卡：`KERNEL.personalFiles` 的 `addCandidates` 加 `composeCandidates`，来源加进 `PERSONAL_SUGGEST_ORIGINS`，照 `packages/daemon/src/google/contacts.ts`）。

```ts
ctx.materialSources.register({
  name: "demo-record", // 素材 id 由它算，定了别改
  eventType: DEMO_RECORD as EventType,
  capture: (event) => [dataSourceMaterial(source, { kind: "observed_behavior", text: payload.text, time: payload.at, sensitive: [], recordId: payload.id })],
});
```

`dataSourceMaterial` 从 `packages/daemon/src/data-sources/material.ts` 取。`kind` 按"谁做的、谁说的"选，同一个数据源可以出几种：

| `kind` | 是什么 | `text` | 读成证据 |
|---|---|---|---|
| `observed_behavior` | 本人做的事：拍到的时刻、去过的地方 | 整理好的摘要 | 能撑关于用户的结论 |
| `received_writing` | 别人写给你的：收到的邮件 | 摘要，正文给 `indexText`（只进检索） | 只当背景 |
| `own_writing` | 本人写的：发出的邮件 | 原话 | 本人说的 |

- `sensitive` 按记录写窄。不写就带上数据源登记的全部类别，默认设置下这条进不了推断。开会的照片写 `[]`，心率写 `["health"]`。地点放 `scene.place`，整条都是位置的才写 `["location"]`。
- `scene`（`end`、`place`、`people`、`tags`）能给就给。
- `capture` 只看事件本身，不读时钟、设置、插件存储。要的都写进事件负载。
- 配一个改写函数（`ctx.purge.register`），把原话、地点、和谁、正文换掉。

### 5. 给用户、给秘书看

页面是内核的：`#/more/data-sources` 卡片总览，`#/more/data-sources/<id>` 详情（`packages/web/src/pages/more/DataSourceDetail.tsx`）。插件要给的：

- `stored(query, ctx)`：不进素材的记录列出来，要快、不连网。进素材的内核自己按 `origin.dataSource` 列。
- `live(query, ctx)`：现查上游给人看，只读，不写事件、不进素材、不经过模型。量大的条目写 `openable: true`，点开时 `query.open` 是那条的 `id`。
- `calendar(range, ctx)`：交给日历插件显示的日程。
- 结果带 `summary`，页面"上次"那行写它。

按需查：`usages.query` 加 `tools(ctx)`。内核只在按需查开着、插件运行、连着时替它给秘书，不用经 `ctx.agent`。工具给只读的（`nature: "look"`）。结果里别人写的内容夹在外部数据标记之间，自带的 `<<<`、`>>>` 换成全角，照 `packages/daemon/src/google/gmail-tools.ts`。工具说明和结果给模型看，标 `@i18n-ignore model`。

### 6. 断开和删除

内核管流程，插件说清楚：

- **断开**：`disconnect(ctx)` 先叫（`ctx.purge` 为真时删自己存储里的原始数据），密钥区那一格内核删。选"连已导入的一起删"时，`records` 的事件换成"已删除"标记，由它们采成的素材一起彻底删除。
- **一次连几个账号**：每个账号是 `status().items` 的一项，给 `disconnectItem(item, ctx)`，交回 `{ owns(event) }`。老配置经 `migrate(ctx)` 转，要能重复执行、备份留在密钥区。
- **确认框的话**：没密钥、不进素材的数据源写 `disconnectNote`，说实际会删什么。
- **别的模块里的**（档案候选、外部日历）：由接收的模块登记删除参与方（`packages/daemon/src/deletion/participants.ts`）。
- **移除插件时连数据删**：`ctx.removal.declare`。照 Looki：`events: records`，`files` 列密钥区那个文件（数据目录里的 `secrets/data-sources/<id>.json`）和插件自己的文件，`deletes`、`keeps` 走 `t()`；素材不跟着删，`keeps` 里照实说。

## 怎么测

测试不连外网：地址做成插件的选项（`createLookiPlugin({ endpoints })`、`createGooglePlugin({ fetch })`），接本机假服务。

| 测什么 | 例子 |
|---|---|
| 登记、填设置、同步、断开、用法开关（假内核） | `packages/daemon/test/data-sources/data-sources.test.ts` |
| 看数据（`stored`、`live`，断言没有新事件、新素材） | `packages/daemon/test/data-sources/data-browse.test.ts` |
| 真实装配：采成素材、导入文件夹、断开并删 | `packages/daemon/test/main/data-sources.test.ts`、`packages/daemon/test/main/looki-plugin.test.ts`（经 `extraPlugins` 换掉清单里的同名插件） |
| 假的上游 | `packages/daemon/test/helpers/fake-looki.ts`、`fake-ical.ts`、`fake-imap.ts` |

假内核里 `k.dataSources.act(id, { action: "configure", values, idempotencyKey })`、`k.dataSources.view()`、`k.layout.imports` 都能用。测定时同步：`startPluginKernel({ at })` 定起点，`k.clock.advanceTo(时刻)` 拨过去。

## 完成前检查

- [ ] ergo-plugin 的完成前检查都过了。
- [ ] 填错 Key：状态是出错、原因写明、日志和事件里搜不到 Key。
- [ ] 同步一次：条数对，再同步不重复；进素材的在素材库里有，`sensitive`、`scene` 按记录写了。
- [ ] 页面上看得到：连接状态、已获取几条、上次同步。
- [ ] 断开留着已导入、断开并删各测一次：记录换成标记、素材删了、密钥区那一格没了，别的数据源不受影响。
- [ ] 插件停用时写"X插件没启用"，不能同步，断开并删照样能做。
- [ ] 主切面至少一条过了，测试里没有外网请求。
