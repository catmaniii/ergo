# 网页要取守护进程的数据

页面要的数据不在事件流里（要现算、量大、要带参数）时，加一个 HTTP 接口。插件自己开不了接口：路径、网关、组合根、网页要一起改，共七处。

已经在事件流里的不用走这条路：写进 `packages/web/src/state/` 的纯函数，页面从状态取。

**照日历按月取写**，它是一条完整的真实例子（笔记例子 `notes-example` 没有这条路）。

| # | 文件 | 加什么 | 日历的写法 |
|---|---|---|---|
| 1 | `packages/protocol/src/http-schema.ts`，或者自己的 `*-schema.ts` 再从 `packages/protocol/src/index.ts` 导出 | 响应体的 TypeBox 定义和类型 | `calendar-schema.ts` 的 `CalendarMonthView` |
| 2 | `packages/protocol/src/http.ts` | 路径常量；`HTTP_PATHS` 一个函数；`HttpRoute` 一种；`parseHttpPath` 一个分支 | `CALENDAR`；`HTTP_PATHS.calendarMonth`；`{ route: "calendar" }` |
| 3 | `packages/daemon/src/gateway/http-api.ts` | `HttpApiOptions` 一个字段，类型从插件的 `api.ts` 来；`handlersOf` 的 switch 一个 `case` | `calendar: CalendarService`；`case "calendar"` 回 `sendJson` |
| 4 | `packages/daemon/src/daemon.ts` | `createHttpApi({ … })` 给这个字段，函数里 `plugins.active(KEY)` 现取，`KEY` 从插件的 `api.ts` import | `calendar: { month: (month) => plugins.active(CALENDAR).month(month) }` |
| 5 | `packages/web/src/state/protocol.ts` | `export type { … } from "@ergo/protocol"`，页面才能从 `state/index.ts` 取类型 | `CalendarMonthView` 那行 |
| 6 | `packages/web/src/app/daemon-http.ts` | `DaemonHttp` 接口一个方法，`HttpDaemonClient` 一个实现（`this.json<T>(await fetch(…))`） | `calendarMonth` |
| 7 | `packages/web/src/prototype/fake-http.ts` | `FakeDaemonHttp` 一个方法，给原型的假数据 | `calendarMonth` |

第 3、4、6、7 处漏了编译不过。第 1、2、5 处是这几处要用到的名字。

## 页面里怎么用

```tsx
const { http } = useStore(); // 从 app/store.tsx
useEffect(() => {
  let alive = true;
  http.demoToday().then((v) => { if (alive) setView(v); }, (err: unknown) => { if (alive) setError(String(err)); });
  return () => { alive = false; };
}, [http]);
```

短的例子看 `packages/web/src/plugins/claude-code/ClaudeCodePage.tsx`。取到的数据事件来了要算旧的，照日历：`packages/web/src/state/calendar.ts` 判断旧没旧，`packages/web/src/plugins/calendar/CalendarPage.tsx` 重取。

要显示取的中、取不到两种状态，原型里也要能看（第 7 处）。

## 几个规矩

- **插件停用时**：`plugins.active(KEY)` 抛"X插件没启用"，接口回 400 带这句话，不用自己判断。别在组合根存服务的引用，停用后就是死的。
- **写的接口**：`POST`、`PUT` 的 handler 先过 `checkHttpBody(<schema>, body)`，照 `http-api.ts` 里 `language` 那个 `case`。
- **凭证**：外网端口要设备凭证由网关统一管，接口里不用查。

## 怎么测

| 测什么 | 例子 |
|---|---|
| 路径拼得出、拆得回 | `packages/protocol/test/http.test.ts` |
| 真接口（主切面）：停用时的那句话也测 | `packages/daemon/test/main/calendar-plugin.test.ts`，请求写进 `packages/daemon/test/helpers/http.ts`（`calendarApi`） |
| 页面在原型里打得开 | `npx vitest run --project web test/page-opens.test.ts` |
