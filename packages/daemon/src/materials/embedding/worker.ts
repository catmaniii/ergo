// 算向量的工作线程（由 worker-host.ts 拉起）：模型在这里加载、在这里算，不阻塞守护进程的事件循环。
// 具体用哪个模型由"后端"模块决定（workerData.backend 是它的 URL）：正式运行是 bge-m3-backend.ts，测试是假的后端。
// 后端模块导出 createEmbedFunction(options)，返回"一批文字 → 一批向量"的函数。
// 这个文件由 Node 直接加载（类型剥离），只用可擦除的语法，不引用二狗的其他模块。
import { parentPort, workerData } from "node:worker_threads";

interface WorkerData {
  backend: string;
  options: unknown;
}

type EmbedFunction = (texts: string[]) => Promise<Float32Array[]>;

interface Backend {
  createEmbedFunction(options: unknown): Promise<EmbedFunction>;
}

const port = parentPort;
if (!port) throw new Error("worker.ts 只能在工作线程里运行");
const data = workerData as WorkerData;

// 模型只加载一次
const ready: Promise<EmbedFunction> = import(data.backend).then((mod: Backend) => mod.createEmbedFunction(data.options));
// 加载失败先接住（由请求报出去），免得成为未处理的拒绝
ready.catch(() => {});

port.on("message", (message: { id: number; texts: string[] }) => {
  void (async () => {
    let embed: EmbedFunction;
    try {
      embed = await ready;
    } catch (err) {
      // 模型加载失败（文件坏了、版本不对）：标成致命，主线程收到后结束这个线程，
      // 下次要算时重新拉起、重新加载（用户可能已经换好了文件）
      port.postMessage({ id: message.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err), fatal: true });
      return;
    }
    try {
      const vectors = await embed(message.texts);
      // 向量的底层缓冲区直接转给主线程（几条向量共用一个缓冲区时只转一次）
      port.postMessage({ id: message.id, vectors }, [...new Set(vectors.map((v) => v.buffer as ArrayBuffer))]);
    } catch (err) {
      port.postMessage({ id: message.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
  })();
});
