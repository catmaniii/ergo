// 编 ergo.exe 小启动器（318 号票）：用 Windows 自带的 C# 编译器（.NET Framework 4 的 csc.exe），不装 Visual Studio、不加依赖。
// 编不了（没有 csc、编出来跑不起来——比如被杀毒软件拦了、删了）就不带 ergo.exe，只用 ergo.cmd（同样的事，批处理写的）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LAUNCHER_SOURCE = path.resolve(import.meta.dirname, "..", "installer", "launcher", "ergo.cs");
export const LAUNCHER_CMD = path.resolve(import.meta.dirname, "..", "installer", "ergo.cmd");

/** Windows 自带的 csc.exe（.NET Framework 4，64 位优先）；没有是 undefined */
export function findCsc(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windir = env.SystemRoot || env.windir || "C:\\Windows";
  return ["Framework64", "Framework"].map((f) => path.join(windir, "Microsoft.NET", f, "v4.0.30319", "csc.exe")).find((p) => fs.existsSync(p));
}

export type LauncherResult = { ok: true; exe: string } | { ok: false; reason: string };

/** 编 ergo.exe 到 out；不行回原因 */
export function compileLauncher(out: string, options: { csc?: string } = {}): LauncherResult {
  const csc = options.csc ?? findCsc();
  if (!csc) return { ok: false, reason: "没找到 Windows 自带的 C# 编译器（.NET Framework 4 的 csc.exe）" };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(csc, ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", "/codepage:65001", `/out:${out}`, LAUNCHER_SOURCE], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(out)) return { ok: false, reason: `csc 编译失败：${(r.stdout || "") + (r.stderr || "") || r.error?.message || r.status}` };
  return { ok: true, exe: out };
}

/**
 * 编出来的 ergo.exe 能不能跑：在一个只有 ergo.json 和假的命令行（node 是 nodeExe）的临时版本目录里跑一次 `ergo.exe probe`，
 * 看到命令行打印的参数才算能用（本机杀毒软件拦了、删了的都算不能用）
 */
export function probeLauncher(exe: string, nodeExe: string, scratch: string): LauncherResult {
  const home = path.join(scratch, "launcher-probe");
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "node"), { recursive: true });
  fs.mkdirSync(path.join(home, "app", "packages", "daemon", "src", "cli"), { recursive: true });
  fs.writeFileSync(path.join(home, "ergo.json"), "{}");
  fs.writeFileSync(path.join(home, "node.path"), nodeExe);
  fs.writeFileSync(path.join(home, "app", "packages", "daemon", "src", "cli", "main.js"), "console.log(JSON.stringify(process.argv.slice(2)));");
  const copy = path.join(home, "ergo.exe");
  try {
    fs.copyFileSync(exe, copy);
    const r = spawnSync(copy, ["probe", "a b"], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    if (r.status === 0 && r.stdout.trim() === JSON.stringify(["probe", "a b"])) return { ok: true, exe };
    return { ok: false, reason: `ergo.exe 跑不起来（退出码 ${r.status}${r.error ? `，${r.error.message}` : ""}）` };
  } catch (err) {
    return { ok: false, reason: `ergo.exe 跑不起来：${(err as Error).message}` };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
