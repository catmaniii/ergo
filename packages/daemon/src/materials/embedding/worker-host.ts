// 在工作线程里算向量的 Embedder（规格第 15 节："向量计算要放在不阻塞守护进程事件循环的地方"）。
// - 第一次要算时才拉起工作线程（worker.ts），模型在线程里加载一次；
// - 闲置一段时间（默认 10 分钟）就结束线程，把模型占的内存（bge-m3 量化版约 1 GB）还回去，下次要算时再拉起；
// - 线程出错或退出时，交给它的请求都以出错结束，下次要算时重新拉起；模型没加载起来时同样作废这个线程；
// - close()：结束线程，等着的请求以出错结束。
import { Worker } from "node:worker_threads";
import type { Embedder } from "./embedder.ts";
import type { EmbedRequest, EmbedResponse, WorkerData } from "./worker-types.ts";

export interface WorkerEmbedderOptions<BackendOptions> {
  /** 模型名（记在每条向量旁边） */
  model: string;
  /** 工作线程里加载的推理后端模块（导出 createEmbedFunction(options)，见 worker-types.ts 的 EmbedBackend） */
  backend: URL;
  /** 交给后端 createEmbedFunction 的参数（要能结构化克隆） */
  backendOptions: BackendOptions;
  available(): boolean;
  unavailableHint(): string;
  /** 闲置多久结束线程（毫秒），默认 10 分钟 */
  idleMs?: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;

interface Pending {
  resolve(vectors: Float32Array[]): void;
  reject(err: Error): void;
}

/** 一个工作线程和交给它、还没回来的请求 */
interface Running {
  worker: Worker;
  pending: Map<number, Pending>;
}

export function createWorkerEmbedder<BackendOptions>(options: WorkerEmbedderOptions<BackendOptions>): Embedder {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  let current: Running | undefined;
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | undefined;

  /** 这个线程不能再用了：交给它的请求都以出错结束 */
  const retire = (running: Running, err: Error) => {
    if (current === running) current = undefined;
    for (const p of running.pending.values()) p.reject(err);
    running.pending.clear();
  };

  const terminate = async () => {
    clearTimeout(idleTimer);
    const running = current;
    if (!running) return;
    retire(running, new Error("算向量的工作线程已结束")); // @i18n-ignore log：只进日志
    await running.worker.terminate();
  };

  const armIdle = (running: Running) => {
    clearTimeout(idleTimer);
    if (running.pending.size > 0) return;
    idleTimer = setTimeout(() => void terminate(), idleMs);
    idleTimer.unref();
  };

  const ensureWorker = (): Running => {
    if (current) return current;
    const workerData: WorkerData<BackendOptions> = { backend: options.backend.href, options: options.backendOptions };
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData });
    // 线程不拦着守护进程退出
    worker.unref();
    const running: Running = { worker, pending: new Map() };
    worker.on("message", (message: EmbedResponse) => {
      const p = running.pending.get(message.id);
      if (!p) return;
      running.pending.delete(message.id);
      if ("error" in message) {
        const err = new Error(message.error);
        p.reject(err);
        // 模型没加载起来：这个线程不再用，下次要算时重新拉起、重新加载
        if (message.fatal) {
          retire(running, err);
          void worker.terminate();
        }
      } else {
        p.resolve(message.vectors);
      }
      if (current === running) armIdle(running);
    });
    worker.on("error", (err) => retire(running, err));
    worker.on("exit", (code) => retire(running, new Error(`算向量的工作线程退出了（退出码 ${code}）`))); // @i18n-ignore log：只进日志
    current = running;
    return running;
  };

  return {
    model: options.model,
    available: () => options.available(),
    unavailableHint: () => options.unavailableHint(),
    embed(texts) {
      clearTimeout(idleTimer);
      const running = ensureWorker();
      const id = nextId++;
      return new Promise<Float32Array[]>((resolve, reject) => {
        running.pending.set(id, { resolve, reject });
        const request: EmbedRequest = { id, texts: [...texts] };
        // 这是工作线程的 postMessage，不是浏览器窗口的，没有 targetOrigin
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        running.worker.postMessage(request);
      });
    },
    close: terminate,
  };
}
