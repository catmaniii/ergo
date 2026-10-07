// 存储薄接口的工作线程：把耗时的整库操作（备份用的 VACUUM INTO、完整性检查）挪出守护进程的事件循环。
// 只转手给 sqlite.ts 里的同步函数，驱动仍然只在 sqlite.ts 里。一次一件，按收到的先后做。
import { parentPort } from "node:worker_threads";
import { integrityCheckSync, vacuumIntoSync, type WorkerOp, type WorkerReply } from "./sqlite.ts";

parentPort?.on("message", ({ id, op }: { id: number; op: WorkerOp }) => {
  let reply: WorkerReply;
  try {
    const result = op.op === "vacuum_into" ? vacuumIntoSync(op.source, op.dest) : integrityCheckSync(op.file);
    reply = { id, ok: true, result: result ?? null };
  } catch (err) {
    reply = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // worker_threads 的 MessagePort，不是浏览器的 window.postMessage，没有 targetOrigin
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort?.postMessage(reply);
});
