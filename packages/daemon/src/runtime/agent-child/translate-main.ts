// 一次性子进程的入口：翻斜杠命令的说明（310 号票）。由守护进程用 `node translate-main.ts` 拉起（runtime/translation.ts）：
// stdin 读一行请求（TranslationRequest），做完在 stdout 写一行结果（{ ok: true, result } 或 { ok: false, error }），然后退出。
// 不开会话、不写任何文件。
import { installBuiltinLocales } from "../../i18n/builtin.ts";
import { CHILD_LANGUAGE_ENV } from "../host-protocol.ts";
import { encodeLine, readJsonLines } from "../line-channel.ts";
import { redactApiKeys } from "../redact.ts";
import type { TranslationRequest } from "../translation.ts";
import { translateTexts } from "./translate.ts";

installBuiltinLocales(process.env[CHILD_LANGUAGE_ENV]);

let handled = false;

function finish(reply: unknown, code: number): void {
  process.stdout.write(encodeLine(reply), () => process.exit(code));
}

readJsonLines<TranslationRequest>(
  process.stdin,
  (request) => {
    if (handled) return;
    handled = true;
    translateTexts(request).then(
      (result) => finish({ ok: true, result }, 0),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        finish({ ok: false, error: redactApiKeys(message, Object.values(request.credentials ?? {})) }, 1);
      },
    );
  },
  {
    onInvalid: () => {
      handled = true;
      // 请求里可能有凭据：不回显原文
      finish({ ok: false, error: "无法解析的请求" }, 1); // @i18n-ignore log：编程错误
    },
    onEnd: () => {
      if (!handled) process.exit(1);
    },
  },
);
