// 找本机的 Chrome（或 Edge）：在真浏览器里跑的测试（找不到时跳过）、部署后的冒烟（smoke-page.ts）用。
import { existsSync } from "node:fs";

export function findChrome(): string | undefined {
  const candidates = [process.env.AGENT_BROWSER_EXECUTABLE_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return candidates.find((p): p is string => p !== undefined && p !== "" && existsSync(p));
}
