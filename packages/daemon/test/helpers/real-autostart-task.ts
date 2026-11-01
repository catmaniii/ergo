// 这台电脑上真的计划任务 LocalServiceManager 现在的完整定义：只读（Export-ScheduledTask）。
// 跑测试前后各取一次、断言一个字不差：重新注册一次，里面的 StartBoundary 就变了（install-autostart 用 -At (Get-Date)），删掉就变成空串。
// 没有这个任务的电脑（CI）、非 Windows：两次都是空串。
import { spawnSync } from "node:child_process";

export function realAutostartTaskDefinition(): string {
  if (process.platform !== "win32") return "";
  const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; if (Get-ScheduledTask -TaskName 'LocalServiceManager' -ErrorAction SilentlyContinue) { Export-ScheduledTask -TaskName 'LocalServiceManager' }";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
  return r.stdout ?? "";
}
