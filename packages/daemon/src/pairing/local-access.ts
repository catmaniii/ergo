// 本机来的也要配对（469）：本机端口的信任从"按端口"变成"按端口 + 这个设置"。
// - 设置（LocalPairingSetting）：真相是这一份的配置文件 config/ergo.json 的 pairing.localRequestsNeedPairing，默认关（本机端口来的自动信任，
//   和以前一样）。起来时从配置读（loadConfig），设置 · 设备配对里拨、`ergo local-pairing off` 关，写回配置文件、同时换掉内存里的——
//   网关每个请求现取，改了马上生效；打开的那一刻网关关掉本机端口上没凭证的连接（onChange）。
// - 本机程序的令牌（LocalToken）：守护进程每次起来生成一份新的（256 位随机值），写进这一份数据目录的密钥区（协议包的 LOCAL_TOKEN_FILE）。
//   不带浏览器的本机程序——命令行（ergo components、ergo local-pairing）、冒烟脚本（smoke:page）、守护进程自己截服务首页的无头浏览器——
//   按数据目录读它，带在 LOCAL_TOKEN_HEADER 里。内存里只留摘要，比对按摘要、定长比较；原值不进日志、事件、错误信息，
//   也不进守护进程的环境（子进程拿不到）；agent 读不到密钥区（守卫拒）。设置关着时网关不看它；外网端口永远不认它。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { writePairingConfig } from "../config/config.ts";

export interface LocalPairingSetting {
  /** 现在开没开 */
  on(): boolean;
  /** 开或关：写进配置文件、换掉内存里的；回这一下变没变 */
  set(on: boolean): boolean;
  /** 改了叫 listener（网关在打开时关掉本机端口上没凭证的连接）；返回取消订阅 */
  onChange(listener: (on: boolean) => void): () => void;
}

export function createLocalPairingSetting(options: { configFile: string; initial: boolean; log: (line: string) => void }): LocalPairingSetting {
  let current = options.initial;
  const listeners = new Set<(on: boolean) => void>();
  return {
    on: () => current,
    set(on) {
      if (on === current) return false;
      writePairingConfig(options.configFile, { localRequestsNeedPairing: on });
      current = on;
      options.log(`设置里改了：本机来的也要配对 ${on ? "开" : "关"}`); // @i18n-ignore log：改设置只进日志
      for (const listener of listeners) listener(on);
      return true;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface LocalToken {
  /** 原值：只交给守护进程自己起的无头浏览器（截服务首页，只发给二狗自己的本机端口）；不进日志 */
  value(): string;
  /** 请求里带的是不是它（没带、长短不对都不是） */
  matches(candidate: string | undefined): boolean;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** 守护进程起来时：生成一份新的令牌写进密钥区（旧的随之作废）。写不进去只记一行（不带令牌），守护进程照常用，本机的命令行这次连不上 */
export function issueLocalToken(file: string, log: (line: string) => void): LocalToken {
  const token = randomBytes(32).toString("base64url");
  const expected = digest(token);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, token);
  } catch (err) {
    // @i18n-ignore-next log
    log(`本机程序的令牌写不进密钥区（${err instanceof Error ? err.message : String(err)}）："本机来的也要配对"开着时本机的命令行连不上二狗`);
  }
  return {
    value: () => token,
    matches: (candidate) => candidate !== undefined && candidate.length > 0 && timingSafeEqual(digest(candidate), expected),
  };
}

/** 本机程序读令牌（命令行、冒烟脚本）：按数据目录找，没有、读不了是 undefined（守护进程没起来过，或者旧版本） */
export function readLocalToken(file: string): string | undefined {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}
