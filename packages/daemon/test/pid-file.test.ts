// pid 文件的启动时间（318 号票）：Windows 上记系统的进程创建时间，stop 钩子核对时对得上（以前按 process.uptime() 倒推，
// 杀毒软件扫新进程时会晚好几秒、超出 2 秒的容差，stop 钩子不肯停）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesRunningProcess, processStartTime, readPidFile, writePidFile } from "../src/process/pid-file.ts";

describe("pid 文件", () => {
  it.runIf(process.platform === "win32")("记的启动时间就是系统记的进程创建时间，核对得上", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-pid-"));
    try {
      const file = path.join(dir, "daemon.pid");
      const record = writePidFile(file, 18_888);
      expect(readPidFile(file)).toEqual(record);
      expect(Date.parse(record.startedAt)).toBe(processStartTime(process.pid)!.getTime());
      expect(matchesRunningProcess(record, process.pid)).toBe(true);
      // 差 3 秒就不认（pid 可能被复用了）
      expect(matchesRunningProcess({ ...record, startedAt: new Date(Date.parse(record.startedAt) + 3000).toISOString() }, process.pid)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
