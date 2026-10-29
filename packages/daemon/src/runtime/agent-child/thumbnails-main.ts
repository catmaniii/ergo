// 一次性子进程的入口：缩小成小图（145 号票的 view_files，149 号票起是秘书在用）。由守护进程用 `node thumbnails-main.ts` 拉起
// （runtime/thumbnails.ts）：stdin 读一行请求（ThumbnailRequest），做完在 stdout 写一行结果（{ ok: true, result } 或 { ok: false, error }），
// 然后退出。只读请求里的那几个文件，不写任何文件。
import { encodeLine, readJsonLines } from "../line-channel.ts";
import type { ThumbnailRequest } from "../thumbnails.ts";
import { makeThumbnails } from "./thumbnails.ts";

let handled = false;

function finish(reply: unknown, code: number): void {
  process.stdout.write(encodeLine(reply), () => process.exit(code));
}

readJsonLines<ThumbnailRequest>(
  process.stdin,
  (request) => {
    if (handled) return;
    handled = true;
    makeThumbnails(request).then(
      (result) => finish({ ok: true, result }, 0),
      (err: unknown) => finish({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) }, 1),
    );
  },
  {
    onInvalid: () => {
      handled = true;
      finish({ ok: false, error: "无法解析的请求" }, 1); // @i18n-ignore log：编程错误
    },
    onEnd: () => {
      if (!handled) process.exit(1);
    },
  },
);
