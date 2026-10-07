// 测试用的临时用户目录：测试里起的守护进程环境中，用户目录类变量都指向一个临时主目录。
// 守护进程按白名单把这些变量传给 agent 子进程，所以测试里的子进程看不到真实的用户主目录。
// （本文件不引用 vitest，测试夹具进程也能用。）
import fs from "node:fs";
import path from "node:path";

/** 用户目录类环境变量，全部指向 homeDir 之下（目录会建好） */
export function tempUserProfileEnv(homeDir: string): Record<string, string> {
  const appData = path.join(homeDir, "AppData", "Roaming");
  const localAppData = path.join(homeDir, "AppData", "Local");
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const { root } = path.parse(homeDir);
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    HOMEDRIVE: root.replace(/[\\/]+$/, ""),
    HOMEPATH: path.sep + path.relative(root, homeDir),
  };
}

/** base 上覆盖 overrides；Windows 的变量名大小写不敏感，同名（不同大小写）的旧值先去掉 */
export function withEnv(
  base: Readonly<Record<string, string | undefined>>,
  ...overrides: Array<Readonly<Record<string, string | undefined>>>
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const layer of overrides) {
    for (const [name, value] of Object.entries(layer)) {
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
      }
      env[name] = value;
    }
  }
  return env;
}
