// 深度体检（415）里 Codex 那一块的"登录"：本机的 Codex 登录了没有。按它自己的办法查——跑一次 `codex login status`
// （不起 app-server、不开会话、不调模型，几秒内退出；环境照交给 Codex 的那份 codexProcessEnv，去掉了改计费方式、改账号的变量，
// 看到的就是二狗用它时的登录）。它把结果写在标准错误里："Logged in using ChatGPT"、"Logged in using an API key - sk-…***"、
// "Not logged in"（没登录时退出码是 1）。二狗不读 auth.json、不回显 Key 的任何部分，只认是哪种登录。
// cost: deep——跑本机的外部程序，平时体检不跑，只有用户点了"深度体检"才跑。
// 没登录 → 坏了（用它跑的任务、项目起不来），修法是在终端里跑 codex login；没找到 codex、命令没跑成、说的认不出来 → 没查出来。
import { execFile } from "node:child_process";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import { buildChildEnv } from "../process/child-env.ts";
import { codexProcessEnv, findCodexEntry } from "./install.ts";

/** `codex login status` 最多等多久（毫秒） */
export const CODEX_LOGIN_TIMEOUT_MS = 15_000;

/** 一条命令跑完：退出码（被结束的是 null）、标准输出、标准错误 */
export interface CodexCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一次 `codex login status`（正式的见 codexLoginStatus；测试换成假的）。没找到 codex、起不来抛错 */
export type CodexLoginStatus = (signal: AbortSignal) => Promise<CodexCommandResult>;

/** 认不出来的输出最多带多少字（API Key 那一行不会走到这里：认得出来） */
const TEXT_MAX = 120;

/**
 * 正式的：按 PATH 找本机的 codex（和插件的 missing 同一个找法），跑 `codex login status`。env 现取守护进程自己的环境，
 * 照子进程的白名单（buildChildEnv）再去掉 Codex 认的那些改账号变量（codexProcessEnv）
 */
export function codexLoginStatus(env: () => Readonly<Record<string, string | undefined>>): CodexLoginStatus {
  return (signal) =>
    new Promise((resolve, reject) => {
      const parent = env();
      const entry = findCodexEntry(parent);
      if (!entry) return reject(new Error("codex not found on PATH")); // @i18n-ignore log：给开发者看的，页面上写的是 codex.doctor.login.failed
      execFile(
        entry.command,
        [...entry.args, "login", "status"],
        { env: codexProcessEnv(buildChildEnv(parent)), timeout: CODEX_LOGIN_TIMEOUT_MS, windowsHide: true, signal, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          // 退出码不是 0 也交回（没登录就是 1）；起不来、被结束的才算出错
          const code: unknown = err === null ? 0 : (err as { code?: unknown }).code;
          if (typeof code !== "number") return reject(err ?? new Error("codex login status failed")); // @i18n-ignore log：给开发者看的
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

const notLoggedIn: DoctorFinding = { level: "error", fact: { key: "codex.doctor.login.no" }, fix: { key: "codex.doctor.login.fix" } };

/** 判 `codex login status` 跑完的结果 */
export function judgeCodexLogin(result: CodexCommandResult): DoctorFinding {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/not\s+logged\s+in/i.test(text)) return notLoggedIn;
  if (/logged\s+in\s+using\s+chatgpt/i.test(text)) return { level: "ok", fact: { key: "codex.doctor.login.chatgpt" } };
  if (/logged\s+in\s+using\s+an?\s+api\s+key/i.test(text)) return { level: "ok", fact: { key: "codex.doctor.login.apiKey" } };
  if (/logged\s+in/i.test(text) && result.code === 0) return { level: "ok", fact: { key: "codex.doctor.login.ok" } };
  if (result.code !== 0 && result.code !== null) return notLoggedIn;
  const line = text.trim().replace(/\s+/g, " ");
  return { level: "unknown", fact: { key: "codex.doctor.login.unreadable", params: { text: (line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX)}…` : line) || "?" } }, fix: { key: "doctor.fix.retry" } };
}

/** "登录"这一项 */
export function codexLoginCheck(status: CodexLoginStatus): DoctorCheck {
  return {
    id: "login",
    title: "codex.doctor.login.title",
    cost: "deep",
    timeoutMs: CODEX_LOGIN_TIMEOUT_MS + 2_000,
    run: async (signal) => {
      let result: CodexCommandResult;
      try {
        result = await status(signal);
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, TEXT_MAX);
        return { level: "unknown", fact: { key: "codex.doctor.login.failed", params: { message } }, fix: { key: "doctor.fix.retry" } };
      }
      return judgeCodexLogin(result);
    },
  };
}
