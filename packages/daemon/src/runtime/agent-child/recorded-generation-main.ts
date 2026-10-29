// 一次性子进程的入口：按二狗自己的事件记录另起一次生成（293 号票，recorded-generation.ts；Claude Code 撤回时写分支摘要，309 号票起还有
// Claude Code 的范围审视）。由守护进程用 `node recorded-generation-main.ts` 拉起（runtime/recorded-generation.ts）：stdin 读一行请求
// （RecordedGenerationRequest，凭据在里面），做完在 stdout 写一行结果（{ ok: true, result } 或 { ok: false, error }），然后退出。
// 不开会话、不写任何文件。
import { installBuiltinLocales } from "../../i18n/builtin.ts";
import { CHILD_LANGUAGE_ENV, type RecordedGenerationRequest } from "../host-protocol.ts";
import { encodeLine, readJsonLines } from "../line-channel.ts";
import { runRecordedGeneration } from "./recorded-generation.ts";

// 没写成的原因给用户看（撤回没做成的说明），按拉起时的语言写（174 号票，ADR-0029）
installBuiltinLocales(process.env[CHILD_LANGUAGE_ENV]);

let handled = false;

function finish(reply: unknown, code: number): void {
  process.stdout.write(encodeLine(reply), () => process.exit(code));
}

readJsonLines<RecordedGenerationRequest>(
  process.stdin,
  (request) => {
    if (handled) return;
    handled = true;
    runRecordedGeneration(request).then(
      (result) => finish({ ok: true, result }, 0),
      (err: unknown) => finish({ ok: false, error: err instanceof Error ? err.message : String(err) }, 1),
    );
  },
  {
    onInvalid: () => {
      handled = true;
      // 请求里有凭据：不回显原文
      finish({ ok: false, error: "无法解析的请求" }, 1); // @i18n-ignore log：编程错误
    },
    onEnd: () => {
      if (!handled) process.exit(1);
    },
  },
);
