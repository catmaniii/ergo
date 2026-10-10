// 去掉文字里模型 key 的内容（73 号票：设置里"模型"的连通测试、模型探查的出错原因）。只有这一份：
// 模型探查的子进程（agent-child/probe.ts、model-probe-main.ts）报出错原因之前去掉一遍，守护进程（model-settings/）交给设置页、
// 写日志之前再去掉一遍，用的都是它。不引用 pi，子进程和守护进程都能用。

/** 换上去的字 */
export const REDACTED_KEY = "<已隐去>";

/**
 * 去掉 keys 的内容：整个 key、key 的一截（末尾 4 个字符起的片段：provider 的报错里常只露末尾几位，如 ****abcd），
 * 以及"api key: ****abcd"、"API key sk-****"这类写法后面跟着的那一截
 */
export function redactApiKeys(text: string, keys: Iterable<string>): string {
  let out = text;
  for (const key of keys) {
    if (key.length === 0) continue;
    out = out.split(key).join(REDACTED_KEY);
    for (let n = Math.min(key.length - 1, 12); n >= 4; n--) out = out.split(key.slice(-n)).join(REDACTED_KEY);
  }
  return out.replace(/(api[\s_-]?key\b[^:：]{0,20}[:：]?\s*)\S+/gi, `$1${REDACTED_KEY}`).replace(/\*{3,}\S*/g, REDACTED_KEY);
}
