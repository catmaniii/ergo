// 配对页怎么开场、现在是哪一页（纯函数，规格第 6 节）。外网端口上的页面没被信任时（打开时 /api/access 回 none，
// 或者用着用着连接报 unpaired），显示配对页。137 号票起一律先是说明页，点了"请求配对"才发配对请求
// （公网上的扫描程序用无界面的 Chrome 打开页面、不点按钮，就不会在待我处理里冒出配对请求）。开场有三种，只差说明页上说什么：
// - 新设备：这是二狗、这台设备还没配对；
// - 此设备已被吊销：标题写"此设备已被吊销"。服务端在吊销后第一次见到那个凭证时告诉页面原因，同时让浏览器删掉凭证——
//   刷新一次之后它就和新设备分不出来了，所以页面在浏览器里留一个不敏感的记号（只有"本设备已被吊销"这件事，
//   不含设备 id 和凭证），看到记号也按被吊销开场。点"请求配对"或者重新被信任（配对成功）之后擦掉；
// - 凭证过期了（连续 365 天没用，或者领到之后一直没用就作废）：写明凭证过期了，不留记号。
import type { AccessInfo, CredentialRejection, PairingRequestView } from "./protocol.ts";

export type PairingOpening = "new" | "revoked" | "expired";

/** reason：这一次知道的不被信任的原因；revokedMark：浏览器里有没有"本设备已被吊销"的记号 */
export function pairingOpening(reason: CredentialRejection | undefined, revokedMark: boolean): PairingOpening {
  if (reason === "revoked" || revokedMark) return "revoked";
  return reason === "expired" ? "expired" : "new";
}

/** 问到信任情况之后，"本设备已被吊销"的记号该是什么：知道被吊销了就留下，被信任了就擦掉，否则不动 */
export function revokedMarkAfter(access: AccessInfo, marked: boolean): boolean {
  if (access.access !== "none") return false;
  return marked || access.reason === "revoked";
}

/**
 * 配对页现在是哪一页（137 号票）：
 * - intro：说明页，点"请求配对"才发请求。还没有请求、上一个请求过期了或被拒了（不自动重发，要再点一次）；
 * - waiting：等批准（短码、短指纹、倒计时，设备名还能改）；
 * - claiming：已批准，正在领凭证；
 * - paired：领到了凭证，进入二狗。
 * 待批的请求以时间为准：过了 expiresAt 就算过期（守护进程的计时器还没来得及落事件也一样）
 */
export type PairingStage = "intro" | "waiting" | "claiming" | "paired";

export function pairingStage(request: PairingRequestView | undefined, now: number): PairingStage {
  switch (request?.status) {
    case "pending":
      return now < Date.parse(request.expiresAt) ? "waiting" : "intro";
    case "approved":
      return "claiming";
    case "paired":
      return "paired";
    default:
      return "intro";
  }
}

/**
 * 说明页上多说的那一句：上一个请求被拒了（denied）、过期了（expired）优先；没有请求时按开场——
 * 此设备已被吊销（revoked）、凭证过期了（credential_expired）；新设备不多说（undefined）
 */
export type PairingIntroNote = "denied" | "expired" | "revoked" | "credential_expired";

export function pairingIntroNote(opening: PairingOpening, request: PairingRequestView | undefined, now: number): PairingIntroNote | undefined {
  if (request?.status === "denied") return "denied";
  if (request?.status === "expired" || (request?.status === "pending" && now >= Date.parse(request.expiresAt))) return "expired";
  if (opening === "revoked") return "revoked";
  return opening === "expired" ? "credential_expired" : undefined;
}
