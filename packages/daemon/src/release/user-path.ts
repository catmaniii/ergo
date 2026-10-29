// 用户 PATH（318 号票）：装的时候把 <安装目录>\bin 加进**用户的** PATH（HKCU\Environment\Path，不要管理员），卸载时撤掉。
// 读用 reg query，写用 .NET 的 Environment.SetEnvironmentVariable(…, "User")（写完会广播"环境变了"，新开的终端就认）。
// 测试换成一个 JSON 文件（环境变量 ERGO_USER_ENV_FILE），不碰真的注册表。
// @i18n-ignore-file log：出错原因给开发者看
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface UserPathStore {
  read(): string;
  write(value: string): void;
}

const PS = (script: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`], {
    encoding: "utf8",
    windowsHide: true,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * 真的：HKCU\Environment 的 Path。读写都不展开 %变量%、写回 REG_EXPAND_SZ（.NET 的 SetEnvironmentVariable 会把它改成 REG_SZ，
 * 用户 PATH 里原来写成 %USERPROFILE%\… 的几项就不展开了）；写完借 SetEnvironmentVariable 一个临时变量广播"环境变了"
 */
export function registryPathStore(): UserPathStore {
  return {
    read() {
      try {
        return PS(
          "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); if ($k) { [Console]::Out.Write($k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) }",
        );
      } catch {
        return "";
      }
    },
    write(value) {
      PS(
        "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $k.SetValue('Path', $env:ERGO_NEW_USER_PATH, [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close(); [Environment]::SetEnvironmentVariable('ERGO_PATH_BROADCAST', '1', 'User'); [Environment]::SetEnvironmentVariable('ERGO_PATH_BROADCAST', $null, 'User')",
        { ...process.env, ERGO_NEW_USER_PATH: value },
      );
    },
  };
}

/** 测试用：一个 JSON 文件里的 { "Path": "…" } */
export function fileUserPathStore(file: string): UserPathStore {
  return {
    read() {
      try {
        return (JSON.parse(fs.readFileSync(file, "utf8")) as { Path?: string }).Path ?? "";
      } catch {
        return "";
      }
    },
    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ Path: value }, null, 2));
    },
  };
}

/** 按环境挑：设了 ERGO_USER_ENV_FILE 用文件（测试），否则用注册表 */
export function userPathStore(env: NodeJS.ProcessEnv = process.env): UserPathStore {
  return env.ERGO_USER_ENV_FILE ? fileUserPathStore(env.ERGO_USER_ENV_FILE) : registryPathStore();
}

const same = (a: string, b: string) => path.resolve(a.replace(/[\\/]+$/, "")).toLowerCase() === path.resolve(b.replace(/[\\/]+$/, "")).toLowerCase();

/** PATH 里有没有这个目录 */
export function pathHas(value: string, dir: string): boolean {
  return value.split(";").some((p) => p.trim() !== "" && same(p.trim(), dir));
}

/** 加进用户 PATH（已经有了不动）；回是不是改了 */
export function addToUserPath(store: UserPathStore, dir: string): boolean {
  const value = store.read();
  if (pathHas(value, dir)) return false;
  const parts = value.split(";").filter((p) => p.trim() !== "");
  store.write([...parts, dir].join(";"));
  return true;
}

/** 从用户 PATH 里撤掉（别的原样）；回是不是改了 */
export function removeFromUserPath(store: UserPathStore, dir: string): boolean {
  const value = store.read();
  if (!pathHas(value, dir)) return false;
  store.write(
    value
      .split(";")
      .filter((p) => p.trim() !== "" && !same(p.trim(), dir))
      .join(";"),
  );
  return true;
}
