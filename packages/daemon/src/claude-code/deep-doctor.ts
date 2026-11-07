// 深度体检（415）里 Claude Code 那一块的"登录"：本机的 Claude Code 登录了没有。按它自己的办法查——跑一次 `claude auth status`
// （不起会话、不调模型、不花额度，几秒内退出；环境照交给官方 App 的那份，去掉了 ANTHROPIC_API_KEY，看到的就是二狗用它时的登录），
// 读它打印的：默认是 JSON（loggedIn、authMethod、subscriptionType），不是 JSON 的按字认（"Login method: …"算登录了，
// "Not logged in"算没登录），都认不出来时看退出码。二狗不读、不存 Claude Code 的登录凭据（~/.claude 里的），只看这条命令说的。
// cost: deep——跑本机的外部程序、可能要几秒，平时体检不跑，只有用户点了"深度体检"才跑。
// 没登录 → 坏了（用它跑的任务、项目起不来），修法是在终端里跑 claude 按提示登录；命令没跑成、说的认不出来 → 没查出来。
import { t } from "@ergo/protocol";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import type { ClaudeCli, ClaudeCliResult } from "./cli.ts";

/** `claude auth status` 最多等多久（毫秒） */
export const CLAUDE_LOGIN_TIMEOUT_MS = 15_000;

/** 认不出来的输出最多带多少字 */
const TEXT_MAX = 120;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const short = (text: string) => {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX)}…` : line;
};

/** 登录方式写成一小句：订阅（Claude Max 订阅）、API Key、别的照原样；不知道是 undefined */
function methodText(info: Record<string, unknown>): string | undefined {
  const plan = info.subscriptionType ?? info.subscription;
  if (typeof plan === "string" && plan.trim() !== "") {
    const name = plan.trim();
    return t("claudeCode.doctor.login.subscription", { plan: name.charAt(0).toUpperCase() + name.slice(1) });
  }
  const method = info.authMethod ?? info.loginMethod ?? info.method;
  if (typeof method !== "string" || method.trim() === "") return undefined;
  if (/api.?key/i.test(method)) return t("claudeCode.doctor.login.apiKey");
  return method.trim();
}

/** 登录了：带不带登录方式 */
const loggedIn = (method: string | undefined): DoctorFinding =>
  method === undefined ? { level: "ok", fact: { key: "claudeCode.doctor.login.ok" } } : { level: "ok", fact: { key: "claudeCode.doctor.login.okMethod", params: { method } } };

const notLoggedIn: DoctorFinding = { level: "error", fact: { key: "claudeCode.doctor.login.no" }, fix: { key: "claudeCode.doctor.login.fix" } };

/** 判 `claude auth status` 跑完的结果 */
export function judgeClaudeLogin(result: ClaudeCliResult): DoctorFinding {
  const out = result.stdout.trim();
  // 默认打印 JSON
  try {
    const info = JSON.parse(out) as unknown;
    if (isRecord(info)) {
      const flag = info.loggedIn ?? info.logged_in;
      if (flag === false) return notLoggedIn;
      if (flag === true || result.code === 0) return loggedIn(methodText(info));
    }
  } catch {
    // 不是 JSON：按字认
  }
  const text = `${out}\n${result.stderr}`;
  if (/not\s+logged\s+in|logged\s+out|please\s+(log\s*in|run\s+\/login)/i.test(text)) return notLoggedIn;
  const method = /login method:\s*(.+)/i.exec(text)?.[1]?.trim();
  if (method !== undefined) return loggedIn(method);
  if (result.code === 0 && out !== "") return loggedIn(undefined);
  if (result.code !== 0 && result.code !== null) return notLoggedIn;
  return { level: "unknown", fact: { key: "claudeCode.doctor.login.unreadable", params: { text: short(text) || "?" } }, fix: { key: "doctor.fix.retry" } };
}

/** "登录"这一项（cli 现取：插件停用后不再跑；跑不起来交给 runDoctorCheck 算没查出来） */
export function claudeLoginCheck(cli: () => ClaudeCli): DoctorCheck {
  return {
    id: "login",
    title: "claudeCode.doctor.login.title",
    cost: "deep",
    timeoutMs: CLAUDE_LOGIN_TIMEOUT_MS + 2_000,
    run: async () => {
      let result: ClaudeCliResult;
      try {
        result = await cli().run(["auth", "status"], { timeoutMs: CLAUDE_LOGIN_TIMEOUT_MS });
      } catch (err) {
        return { level: "unknown", fact: { key: "claudeCode.doctor.login.failed", params: { message: short(err instanceof Error ? err.message : String(err)) } }, fix: { key: "doctor.fix.retry" } };
      }
      return judgeClaudeLogin(result);
    },
  };
}
