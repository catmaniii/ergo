// 一次性子进程的入口：模型探查（设置里的"模型"，73 号票）——列出模型目录里某个服务商的模型，或者做一次连通测试。
// 由守护进程用 `node model-probe-main.ts` 拉起（runtime/model-probe.ts）：stdin 读一行请求（ModelProbeRequest），
// 做完在 stdout 写一行结果（{ ok: true, result } 或 { ok: false, error }），然后退出。不开会话、不写任何文件。
import type { ModelProbeRequest } from "../host-protocol.ts";
import { encodeLine, readJsonLines } from "../line-channel.ts";
import { redactApiKeys } from "../redact.ts";
import { probeModels } from "./probe.ts";

let handled = false;

function finish(reply: unknown, code: number): void {
  process.stdout.write(encodeLine(reply), () => process.exit(code));
}

readJsonLines<ModelProbeRequest>(
  process.stdin,
  (request) => {
    if (handled) return;
    handled = true;
    probeModels(request).then(
      (result) => finish({ ok: true, result }, 0),
      (err: unknown) => {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        finish({ ok: false, error: request.type === "ping" ? redactApiKeys(message, Object.values(request.credentials)) : message }, 1);
      },
    );
  },
  {
    onInvalid: () => {
      handled = true;
      // 请求里可能有凭据：不回显原文
      finish({ ok: false, error: "无法解析的请求" }, 1);
    },
    onEnd: () => {
      if (!handled) process.exit(1);
    },
  },
);
