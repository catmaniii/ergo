// 原型的 ?demo-debug（124 号票）：直接打开构建产物、地址里带 ?demo-debug 时，一打开就在"关于二狗"（没给别的地址时），
// Debug 工具集已经打开（1 小时），通知记录、页面日志里先放几条假的，连接一组有假的断线次数（fake-connection.ts 的 stats），
// 看各组的样子。不带参数什么都不变。
import { notifyLog, openDebugForDemo, pageLog } from "../app/page-debug.ts";
import { nowIso } from "../state/index.ts";
import { demoParam } from "./fake-connection.ts";

/** 几分钟前的协议时间 */
const ago = (minutes: number) => nowIso(new Date(Date.now() - minutes * 60_000));

export function startDemoDebug(): void {
  if (demoParam("demo-debug") === null) return;
  openDebugForDemo();
  if (!window.location.hash || window.location.hash === "#/") history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/more/about`);
  notifyLog.push({ at: ago(42), id: "n-r-12", title: "提醒：给妈妈打电话", via: "browser", outcome: "sent" });
  notifyLog.push({ at: ago(41), id: "n-r-12", title: "提醒：给妈妈打电话", via: "browser", outcome: "duplicate" });
  notifyLog.push({ at: ago(18), id: "secretary:m-301", title: "二狗：周报草稿写好了", via: "browser", outcome: "denied", detail: "浏览器通知没允许（default）" });
  notifyLog.push({ at: ago(6), id: "debug-local-1", title: "【测试】Debug 工具集发的本机通知", via: "app", outcome: "foreground" });
  notifyLog.push({ at: ago(5), id: "debug-local-2", title: "【测试】Debug 工具集发的本机通知", via: "app", outcome: "sent", forced: true, detail: "通知编号 1840562210" });
  notifyLog.push({ at: ago(2), id: "n-r-13", title: "提醒：【测试】Debug 工具集的测试提醒（15 秒）", via: "app", outcome: "no_reply" });
  pageLog.push({ at: ago(30), source: "console.warn", text: "AudioContext was not allowed to start. It must be resumed (or created) after a user gesture on the page." });
  pageLog.push({ at: ago(12), source: "unhandledrejection", text: "Error: 取历史失败（HTTP 502）\n    at HttpDaemonClient.history (index.html:1:20931)" });
  pageLog.push({ at: ago(3), source: "console.error", text: "WebSocket connection to 'wss://ergo.example/ws' failed" });
}
