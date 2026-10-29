// 配对请求卡（卡片类型注册表里的 pairing）：显示新设备上的设备名、6 位短码、8 位十六进制短指纹和来源，
// 供用户在本机或已配对的设备上核对后批准。按钮闭环照卡片的规矩（按版本条件更新、先到先得、后到的"已被处理"）：
// - 批准（approve）：请求变成已批准，新设备下一次来问就领到凭证；卡片已处理。批准不算审批决定，不产生素材；
// - 拒绝（deny）：请求被拒，卡片已处理（不是"关掉不处理"，不产生回避信号）。
// 待批的请求 5 分钟后过期，卡片变成已过期，不能再处理（由配对模块的计时器做）。
// 137 号票：浏览器标识像网络上的自动访问的请求，负载里带着原因（automated），卡上、纯文本降级里多一句提示（不拦批准）。
import { automatedAccessHint, PairingCardPayload, t } from "@ergo/protocol";
import { defineCardType } from "../cards/registry.ts";
import type { PairingService } from "./pairing.ts";

/**
 * 纯文本降级版本：配对请求：iPhone · Safari · 短码 482913 · 短指纹 9f3ac21e（经隧道 · 203.0.113.24）；
 * 像自动访问的后面接上"。看起来像网络上的自动访问（……），不是你的设备就拒绝"
 */
export function pairingCardText(p: PairingCardPayload): string {
  const text = t("pairing.cardText", { deviceName: p.deviceName, shortCode: p.shortCode, fingerprint: p.fingerprint, from: p.from });
  return p.automated ? t("pairing.cardTextAutomated", { text, hint: automatedAccessHint(p.automated.reason) }) : text;
}

export function pairingCardType(pairing: PairingService) {
  return defineCardType({
    type: "pairing",
    version: 2,
    payload: PairingCardPayload,
    actions: {
      approve: { input: undefined, run: ({ payload, now }) => pairing.approveFromCard(payload, now) },
      deny: { input: undefined, run: ({ payload }) => pairing.denyFromCard(payload) },
    },
    toText: pairingCardText,
  });
}
