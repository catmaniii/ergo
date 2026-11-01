// 自己看一眼一个服务在不在跑（363 号票）：服务管家启动时说"已经有一份在跑"（日志文件被占着），那份是不是真的活着，它这一下没探，二狗替它看。
// 判法和服务管家的探活一样（packages/supervisor/src/probe.mjs）：写了健康检查的 GET 它（状态码 400 以下算过，默认最多等 3 秒），没写的端口连得上就算。
// 只看本机回环；连不上、超时都是 false，不抛错。
import net from "node:net";
import type { OperationService } from "@ergo/protocol";

const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 3000;

function canConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: HOST });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function serviceHealthy(service: Pick<OperationService, "port" | "health">): Promise<boolean> {
  const timeoutMs = service.health?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!service.health) return canConnect(service.port, timeoutMs);
  try {
    const res = await fetch(`http://${HOST}:${service.port}${service.health.path}`, { signal: AbortSignal.timeout(timeoutMs) });
    // 不要正文：不取走的话连接收尾时 undici 可能抛错（服务管家踩过，见 probe.mjs 的 httpOk）
    await res.body?.cancel().catch(() => {});
    return res.status < 400;
  } catch {
    return false;
  }
}
