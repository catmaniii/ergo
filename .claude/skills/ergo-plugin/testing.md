# 插件怎么测

接着 `.claude/skills/ergo-plugin/SKILL.md`。说明在手册 `docs/architecture/plugin-development.md` 第 10 节。

| 测什么 | 怎么测 | 例子 |
|---|---|---|
| 装上、停用、启用、移除 | `startPluginKernel({ plugins: [x] })`，`k.settings.act(名字, { action, idempotencyKey })`；默认之外的内核服务用 `extraService` 补 | `packages/daemon/test/plugins/plugin-guide.test.ts` |
| 边界 | 一条：组合根只 import `api.ts`、不建它的服务，目录外只 import `api.ts`，数据契约的形状 | `packages/daemon/test/calendar/boundary.test.ts` |
| 真实装配 | 主切面 `startTestDaemon({ extraPlugins: [x] })`，至少一条 | `packages/daemon/test/main/plugin-guide.test.ts` |
| 网页插件 | 宿主按状况装和停 | `packages/web/test/plugins/plugin-guide.test.ts` |
| 页面打得开 | 原型带 `?demo-plugins-off=<名字>` | `packages/web/test/page-opens.test.ts` |

## 两个容易卡住的

**假内核的时钟**：`startPluginKernel({ at: new Date(…) })` 定起点，`k.clock.advanceTo(时刻)` 拨过去（只能往后拨），途中到点的定时器按先后触发。用法看 `packages/daemon/test/data-sources/data-sources.test.ts`。

**网页测试 import 到 `MorePage.tsx`**：它引到 `src/app/build-info.ts`，里面的虚拟模块只在构建时有，测试里加载就报错。照 `packages/web/test/pages/settings-groups.test.ts` 在文件开头 mock（路径按测试文件的位置写）：

```ts
vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));
```

## 加插件会动到列插件的断言

新插件进了清单，所有列全部插件的断言都要补。这些写法只搜 `"looki"` 找不到：

| 写法 | 例子 | 什么时候动 |
|---|---|---|
| 插件名的数组 | `packages/daemon/test/main/entry.test.ts`、`gateway.test.ts`、`packages/web/test/plugins/boundary.test.ts` | 都动 |
| `startTestDaemon({ plugins: [...] })` | `plugin-status.test.ts`：它是"只装这些"，意思是"只停某一个"的用例也要补 | 都动 |
| 不带引号的键 `looki: "running"` | `plugin-settings.test.ts` | 都动 |
| 英文标题列表 `"Data source - Looki"` | `plugin-status.test.ts` | 都动 |
| 按位置写的状态数组 `["running", "running", …]` | `plugin-status.test.ts`、`plugin-settings.test.ts` | 都动 |
| 取尾部 `.slice(-2)` | `packages/web/test/plugins/assembly.test.ts`：新插件排在最后，尾部的个数和内容都变 | 都动 |
| 设置页列表 `list("settingsPages")`、`settingsShown` | `packages/web/test/plugins/voice.test.ts`、`packages/web/test/pages/settings-groups.test.ts` | 插件有设置页 |
| 工具先后 `[tool] …` | `reminders.test.ts`、`tasks.test.ts`、`memory-plugin.test.ts`：新工具排在插件贡献的工具那一处的最后 | 插件带工具 |

这样找全，然后把列出来的文件都跑一遍，红的才改：

```sh
git grep -lE '[Ll]ooki|"running", "running"|slice\(-[0-9]+\)|list\("settingsPages"\)|settingsShown' -- packages/daemon/test/main packages/web/test/plugins packages/web/test/pages
git grep -l '\[tool\] ' -- packages/daemon/test/main   # 插件带工具时
```

只把新插件补进去，不放松断言。

## 重录事件流，有先后

网页测试回放的 `packages/web/test/state/recordings/plugins-*.json` 由 `packages/daemon/test/main/plugin-status.test.ts` 录下。

1. 先把这个文件的断言改对。
2. `ERGO_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/plugin-status.test.ts`，要全绿。**失败的那条不存盘，命令也不提示。**
3. `git status` 要看到 8 个文件变了：`plugins-browsing-off`、`plugins-calendar-hot`、`plugins-calendar-off`、`plugins-google-off`、`plugins-hot-toggle`、`plugins-memory-off`、`plugins-reminders-off`、`plugins-voice-off`。少了哪个，就是录它的那条没过。
4. 不带环境变量再跑一次，再跑 `packages/web/test/plugins/assembly.test.ts` 回放。

## 原型的假插件

`packages/web/src/prototype/fake-plugins.ts` 不补也不报错，页面上却是错的：

1. `about()` 加一个 `if (name === "<名字>")` 分支。**不认得的名字会落到最后的"记忆"**，你的插件在设置 · 插件里就写成了记忆。
2. 状态表那行 `for (const name of [...])` 加上名字，不然原型里没有它。
3. `act()` 里移除时假的删除条数：不拥有数据的走默认就行，有自己数字的加一个分支。
