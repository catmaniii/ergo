// 找 Git Bash（规格第 9 节：v1 只开放一种 shell）。找法和 pi 的 bash 工具一样：Program Files 下的 Git\bin\bash.exe，
// 再找 PATH 上的 bash.exe（不要 System32 里的 WSL bash）。不是 Windows 时用 PATH 上的 bash（只为测试能在别的系统上跑）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function findGitBash(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (process.platform !== "win32") return "bash";
  const candidates = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]
    .filter((dir): dir is string => typeof dir === "string" && dir !== "")
    .map((dir) => path.join(dir, "Git", "bin", "bash.exe"));
  const found = candidates.find((file) => fs.existsSync(file));
  if (found) return found;
  try {
    const lines = execFileSync("where", ["bash.exe"], { encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/);
    return lines.map((l) => l.trim()).find((l) => l !== "" && !/\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(l) && fs.existsSync(l));
  } catch {
    return undefined;
  }
}
