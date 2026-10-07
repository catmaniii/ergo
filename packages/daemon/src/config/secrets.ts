// 模型 key：由 LSM 从数据目录的密钥区注入守护进程的环境（条目里写 env.from: file），
// 守护进程从环境里取，再经 stdin 的"启动"命令显式交给 agent 子进程（不进子进程的环境变量，见 ADR-0004）。
// 密钥区只由 LSM 读，agent 读不到；仓库里永远没有 key。

/** provider id → 存 key 的环境变量名 */
export const MODEL_KEY_ENV: Readonly<Record<string, string>> = Object.freeze({
  deepseek: "DEEPSEEK_API_KEY",
});

/** 从守护进程的环境里取出各 provider 的 key（没设的不带） */
export function modelCredentials(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const [provider, name] of Object.entries(MODEL_KEY_ENV)) {
    const value = env[name]?.trim();
    if (value) credentials[provider] = value;
  }
  return credentials;
}
