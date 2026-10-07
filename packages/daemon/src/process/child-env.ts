// 子进程的环境变量：显式构造，不继承守护进程的环境（规格第 3 节"环境注入"）。
// 只从守护进程的环境里挑出 Windows 进程正常运行离不开的系统变量（PATH、SystemRoot、TEMP 等），
// 其余一律不带；模型 key 不走环境变量，经 stdin 的"启动"命令送进子进程的内存凭据。
//
// 守护进程被 LSM 注入的密钥、开发者 shell 里的各种变量，都不会漏给 agent 和它起的工具进程。

/** 允许从守护进程环境带过去的系统变量（Windows 上大小写不敏感） */
const SYSTEM_VARIABLES = [
  // Windows 进程运行必需
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "PATH",
  "TEMP",
  "TMP",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  // 用户目录与程序目录（git、npm 等工具要用）
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "PUBLIC",
  "ALLUSERSPROFILE",
  // POSIX 上的对应项
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  // 语言与时区
  "LANG",
  "LC_ALL",
  "TZ",
];

/** 二狗给每个 agent 子进程固定加的变量：pi 不做自动联网（模型目录刷新、统计） */
const FIXED_VARIABLES: Record<string, string> = {
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
};

const allowed = new Set(SYSTEM_VARIABLES.map((name) => name.toUpperCase()));

/** 无效的代理地址：本机的 discard 端口，没人监听，连上去立即被拒 */
export const OFFLINE_PROXY = "http://127.0.0.1:9";

/**
 * 联网开关关着的 agent（秘书一律关着），它的 bash 起的进程环境里加上这些（规格第 7 节，尽力而为、不是硬隔离）：
 * 代理地址一律设成无效值，curl、wget、git、pip、Python 的 requests / urllib 走代理就连不上；
 * NODE_USE_ENV_PROXY 让 Node（≥22.21）的 fetch 和 http 也按环境变量走代理。
 * 只加在 bash 起的进程上（子进程里的 bash 工具在起进程前加），agent 子进程自己的环境不受影响（它要连模型）。
 * Windows 上环境变量名不分大小写，同名的只写大写一份（Node 起进程时同名不同大小写的只传字典序第一个）。
 */
export const OFFLINE_SHELL_ENV: Readonly<Record<string, string>> = Object.freeze({
  HTTP_PROXY: OFFLINE_PROXY,
  HTTPS_PROXY: OFFLINE_PROXY,
  ALL_PROXY: OFFLINE_PROXY,
  FTP_PROXY: OFFLINE_PROXY,
  NO_PROXY: "",
  NODE_USE_ENV_PROXY: "1",
  // 打开 NODE_USE_ENV_PROXY 后 Node 每次启动都提示"EnvHttpProxyAgent 还是实验性的"，混进脚本的输出里；只关这一条
  NODE_OPTIONS: "--disable-warning=UNDICI-EHPA",
  NPM_CONFIG_PROXY: OFFLINE_PROXY,
  NPM_CONFIG_HTTPS_PROXY: OFFLINE_PROXY,
  PIP_PROXY: OFFLINE_PROXY,
});

/**
 * @param parentEnv 守护进程自己的环境（只从中挑系统变量）
 * @param explicit  拉起时显式给出的变量，同名时覆盖系统变量
 */
export function buildChildEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && allowed.has(name.toUpperCase())) env[name] = value;
  }
  for (const [name, value] of Object.entries({ ...FIXED_VARIABLES, ...explicit })) {
    // Windows 的环境变量名大小写不敏感，先去掉同名（不同大小写）的旧值
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
    }
    env[name] = value;
  }
  return env;
}
