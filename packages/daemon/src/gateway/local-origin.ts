// 本机端口的来源校验（规格第 6 节）：本机端口只监听 127.0.0.1、自动信任，但要校验 Host 和 Origin。
// - Host 必须是 127.0.0.1:<端口> 或 localhost:<端口>：挡住 DNS 重绑定（外部域名解析到 127.0.0.1，浏览器带的 Host 是那个域名）；
// - 带了 Origin 就必须是本机端口自己的源：挡住别的网站发起的跨站请求和跨站 WebSocket。
//   不带 Origin 的不是浏览器里的页面（LSM 的健康探针、命令行工具、不在浏览器里的前端），本机信任只看从哪个端口进来，放行。
// 本机信任不看来源 IP。

export type OriginCheck = { ok: true } | { ok: false; reason: string };

export function checkLocalRequest(headers: { host?: string | undefined; origin?: string | undefined }, port: number): OriginCheck {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = headers.host?.toLowerCase();
  if (!host || !allowedHosts.includes(host)) return { ok: false, reason: `Host 不对：${headers.host ?? "（没有）"}` };
  const origin = headers.origin;
  if (origin !== undefined && !allowedHosts.some((h) => origin.toLowerCase() === `http://${h}`)) {
    return { ok: false, reason: `Origin 不对：${origin}` };
  }
  return { ok: true };
}
