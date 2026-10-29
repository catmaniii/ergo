// 测试里永远不连外部网络（用户 2026-10-22 问"测试是不是真在调 DeepSeek、那样挺费算力"）：
// 除了本机回环地址，任何 http(s) 请求直接抛错。要测网络就用本机起的假服务（127.0.0.1 / localhost / ::1），
// 这也是仓库里原本的写法（假 TTS、假 MCP、假模型服务、假 catalog）。
//
// 用 .mjs 而不是 .ts：它只给 vitest 当 setupFiles 用，不进任何 tsconfig 的类型检查。
//
// 效果：以后谁不小心在测试里写了真请求（比如忘给 DeepSeekChat 注入假的 post），会当场红，
// 而不是默默花钱。
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
const realFetch = globalThis.fetch;

/** 从 fetch 的入参里取 hostname；相对地址（没有 host）不管，交给原来的 fetch 自己报错 */
function hostOf(input) {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input !== null && typeof input === "object" && typeof input.url === "string") return new URL(input.url).hostname;
  } catch {
    return "";
  }
  return "";
}

globalThis.fetch = async (input, init) => {
  const host = hostOf(input);
  if (host !== "" && !LOOPBACK.has(host.toLowerCase())) {
    throw new Error(`测试不许连外部网络：${String(typeof input === "string" ? input : input?.url)}（要测网络请用本机假服务）`);
  }
  return realFetch(input, init);
};
