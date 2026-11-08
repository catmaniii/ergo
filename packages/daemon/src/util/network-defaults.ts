// 出站连接的网络默认值：守护进程和会联网的子进程入口最先导入它（只为副作用）。
// Node 20 起 net 默认"几个地址轮流试"（happy eyeballs），每个地址只等 250 毫秒，最后一个地址也照样掐掉。
// 用户这台电脑 IPv6 出不去、IPv4 出口在新加坡，连高德 restapi.amap.com 的握手要 0.38 秒左右，
// 于是 fetch 一律 ETIMEDOUT（curl 不受这个限制，能连上）——凡是握手超过 250 毫秒的外部服务都会这样。
// 把每个地址的等待放宽到 2.5 秒：IPv6 不通时照样马上报错换下一个地址，只是慢的 IPv4 不会被半路掐掉。
import net from "node:net";

/** 每个地址最多等多久（毫秒）再换下一个 */
export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2500;

net.setDefaultAutoSelectFamilyAttemptTimeout(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
