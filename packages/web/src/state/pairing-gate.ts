// 配对等待页怎么开场（纯函数，规格第 6 节）。外网端口上的页面没被信任时（打开时 /api/access 回 none，
// 或者用着用着连接报 unpaired），配对等待页有三种开场：
// - 新设备：自动发起配对请求；
// - 此设备已被吊销：不自动申请，只显示"此设备已被吊销"和"重新申请"按钮，免得刚吊销掉的设备马上又在待我处理里
//   冒出一张配对请求卡。服务端在吊销后第一次见到那个凭证时告诉页面原因，同时让浏览器删掉凭证——刷新一次之后
//   它就和新设备分不出来了，所以页面在浏览器里留一个不敏感的记号（只有"本设备已被吊销"这件事，不含设备 id 和凭证），
//   看到记号也按被吊销开场。点"重新申请"或者重新被信任（配对成功）之后擦掉；
// - 凭证过期了（连续 365 天没用，或者领到之后一直没用就作废）：同样等用户点"重新申请"，但不留记号。
import type { AccessInfo, CredentialRejection } from "./protocol.ts";

export type PairingOpening = "request" | "revoked" | "expired";

/** reason：这一次知道的不被信任的原因；revokedMark：浏览器里有没有"本设备已被吊销"的记号 */
export function pairingOpening(reason: CredentialRejection | undefined, revokedMark: boolean): PairingOpening {
  if (reason === "revoked" || revokedMark) return "revoked";
  return reason === "expired" ? "expired" : "request";
}

/** 问到信任情况之后，"本设备已被吊销"的记号该是什么：知道被吊销了就留下，被信任了就擦掉，否则不动 */
export function revokedMarkAfter(access: AccessInfo, marked: boolean): boolean {
  if (access.access !== "none") return false;
  return marked || access.reason === "revoked";
}
