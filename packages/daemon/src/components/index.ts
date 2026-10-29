// 组件（323 号票）：模型、语音这些大件按需下载。别的模块只从这里取东西。
// - 清单（manifest.json + manifest.ts）：随版本发布的一份数据，默认装不装、打开哪些功能都写在里面；
// - 下载器（downloader.ts、transport.ts、proxy.ts）：断点续传、几个地址探速挑快的、校验对了才换上、走系统代理；
// - 服务（service.ts）：装、删、更新、暂停、继续、取消、离线导入，设置 · 组件和以后的 `ergo components` 共用；
// - 检测（probes.ts）：有没有 N 卡、本机装没装 Claude Code、别处是不是已经有了。
import { createHttpTransport, type Transport } from "./transport.ts";
import { type ProxyFor, proxyResolver, readWindowsProxy } from "./proxy.ts";

export { type Components, type ComponentsOptions, createComponents } from "./service.ts";
export { type ComponentManifest, type LoadedManifest, loadManifest, type ManifestVerifier, minisignManifestVerifier, parseManifest, pickVariant, shippedManifestVerifier } from "./manifest.ts";
export { type ComponentProbes, createComponentProbes } from "./probes.ts";
export { createHttpTransport, type Transport } from "./transport.ts";
export { proxyResolver, type ProxyFor } from "./proxy.ts";

/** 系统代理隔多久重新看一次（毫秒）：用户改了代理，下一次下载跟着变 */
const PROXY_REFRESH_MS = 60_000;

/** 按环境变量和 Windows 的系统代理定走哪个代理；系统代理最多一分钟重新读一次 */
export function systemProxyFor(env: NodeJS.ProcessEnv): ProxyFor {
  let resolver: ProxyFor | undefined;
  let at = 0;
  return (url) => {
    if (!resolver || Date.now() - at > PROXY_REFRESH_MS) {
      resolver = proxyResolver({ env, system: readWindowsProxy });
      at = Date.now();
    }
    return resolver(url);
  };
}

/** 正式用的下载那一层：走系统代理 */
export function componentTransport(env: NodeJS.ProcessEnv, userAgent: string): Transport {
  return createHttpTransport({ proxyFor: systemProxyFor(env), userAgent });
}
