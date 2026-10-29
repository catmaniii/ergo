// 测试里"像密钥的串"在运行时拼出来：源码里不出现完整的密钥样子，公开仓库的密钥扫描（按前缀认的那几类：sk-、ghp_、github_pat_、
// AKIA、AIza、xox?-、私钥开头）就不会把测试样本当成泄露的密钥。拼出来的串和直接写死的逐字一样，守卫、脱敏认的格式照样测得到。

/** 前缀和后半段拼成一个像密钥的串（前缀单写一段，源码里看不出完整的密钥） */
export const fakeSecret = (prefix: string, rest: string): string => `${prefix}${rest}`;

const DASHES = "-----";

/** 私钥文本块的开头一行：pemBegin("RSA") 是 RSA 私钥那种，不给是 PKCS#8 那种 */
export const pemBegin = (kind = ""): string => `${DASHES}BEGIN ${kind === "" ? "" : `${kind} `}PRIVATE KEY${DASHES}`;

/** 私钥文本块的结尾一行 */
export const pemEnd = (kind = ""): string => `${DASHES}END ${kind === "" ? "" : `${kind} `}PRIVATE KEY${DASHES}`;
