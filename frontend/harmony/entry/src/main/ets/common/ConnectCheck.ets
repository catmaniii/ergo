/**
 * 扫码之后测连不连得上（对应安卓 common/ConnectCheck.kt）：这个文件只有判断，不碰网络、不碰界面的字，不引用任何 kit，
 * frontend/test/connect.test.ts 直接把它跑起来和安卓拿同一份例子（frontend/test/connect-vectors.tsv）核对。
 */

/** 连不上的原因：键是 harmony.connect.reason.<这里> */
export type ConnectFailure = 'dns' | 'timeout' | 'cert' | 'refused' | 'notErgo' | 'other';

/** @ohos.net.http 的错误码（底层是 libcurl 的 CURLE_*，加了 2300000）归到哪一种 */
export function classifyConnectError(code: number): ConnectFailure {
  switch (code) {
    case 2300005: // 解析不了代理
    case 2300006: // 解析不了主机
      return 'dns';
    case 2300028: // 超时
      return 'timeout';
    case 2300035: // SSL 握手失败
    case 2300058: // 本地证书有问题
    case 2300059: // SSL 算法用不了
    case 2300060: // 对方证书验证不过
    case 2300066: // SSL 引擎起不来
    case 2300077: // CA 证书有问题
    case 2300080: // SSL 关闭失败
    case 2300083: // 签发者不对
      return 'cert';
    case 2300007: // 连不上
    case 2300055: // 发不出去
    case 2300056: // 收不到
      return 'refused';
    case 2300047: // 跳转太多（这边不跟跳转）
    case 2300052: // 对方什么都没回
      return 'notErgo';
    default:
      return 'other';
  }
}

/** 二狗回"我有没有被信任"的样子（gateway.ts 的 /api/access，两个端口都有、不需要凭证）：{ "access": "none" | "device" | "local", ... } */
const ERGO_ACCESS: RegExp = /^\s*\{[\s\S]*"access"\s*:\s*"(none|device|local)"[\s\S]*\}\s*$/;

/** 对面是不是二狗：200 且回的是这个样子。别的网站（网页、404、跳到登录页）都不是 */
export function isErgoAccess(status: number, body: string): boolean {
  return status === 200 && ERGO_ACCESS.test(body);
}

/** 看得出是 tailnet 的主机：.ts.net、带 tail / tailnet / headscale 这段的域名（服务管家的 tailnet 入口常这么起名）、100.64.0.0/10 的地址 */
export function isTailnetHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name.endsWith('.ts.net') || name.endsWith('.tailscale.net')) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name);
  if (v4 !== null) {
    const second = Number(v4[2]);
    return v4[1] === '100' && second >= 64 && second <= 127;
  }
  return name.split('.').slice(0, -2).some((part: string) => part === 'tail' || part === 'tailnet' || part === 'headscale');
}

/** 提醒检查什么，先后按这个地址最可能的原因：看得出是 tailnet 的把 tailnet 那条排最前。键是 harmony.connect.check.<这里> */
export function connectChecklist(host: string): string[] {
  return isTailnetHost(host) ? ['tailnet', 'computer', 'remote'] : ['computer', 'remote', 'tailnet'];
}
