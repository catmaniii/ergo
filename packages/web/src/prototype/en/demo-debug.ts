// demo-debug.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_DEMO_DEBUG: Phrases = {
  "提醒：给妈妈打电话": "Reminder: call Mom",
  "二狗：周报草稿写好了": "ergo: the weekly report draft is ready",
  "浏览器通知没允许（default）": "Browser notifications not allowed (default)",
  "【测试】Debug 工具集发的本机通知": "[Test] Local notification from the Debug tools",
  "通知编号 1840562210": "Notification ID 1840562210",
  "提醒：【测试】Debug 工具集的测试提醒（15 秒）": "Reminder: [Test] test reminder from the Debug tools (15 seconds)",
  "Error: 取历史失败（HTTP 502）\n    at HttpDaemonClient.history (index.html:1:20931)": "Error: failed to fetch history (HTTP 502)\n    at HttpDaemonClient.history (index.html:1:20931)",
};
