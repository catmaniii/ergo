// stop 钩子结束进程前的核对（353 号票，process/stop-check.ts）：netstat 靠不住时认人的办法多了，这条保护不放松——
// 只有"在听这个端口的就是 pid 文件里那个进程、启动时间对得上"才结束它。这里全是假数据，不碰真进程。
import { describe, expect, it } from "vitest";
import { stopVerdict } from "../src/process/stop-check.ts";

const PORT = 5555;
const record = { pid: 100, startedAt: "2026-11-01T00:00:00.000Z", port: PORT };
const base = { port: PORT, pidFile: "D:/假的/daemon.pid", occupied: true, listeners: [100], record, matches: () => true };

describe("stop 钩子的核对", () => {
  it("在听的就是 pid 文件里的进程、启动时间对得上：结束它", () => {
    expect(stopVerdict(base)).toEqual({ action: "kill", pid: 100 });
  });

  it("端口真的空着：已经停了（pid 文件在不在都一样）", () => {
    expect(stopVerdict({ ...base, occupied: false, listeners: [] })).toMatchObject({ action: "stopped", message: expect.stringContaining("没人在听") });
    expect(stopVerdict({ ...base, occupied: false, listeners: [], record: undefined })).toMatchObject({ action: "stopped" });
  });

  it("有人占着、查不到是谁：什么也不结束，也不能说已经停了（pid 文件和启动时间都对得上也不行）", () => {
    const verdict = stopVerdict({ ...base, listeners: [] });
    expect(verdict).toMatchObject({ action: "refuse", reason: expect.stringContaining("查不到是谁") });
  });

  it("没有 pid 文件：不结束", () => {
    expect(stopVerdict({ ...base, record: undefined })).toMatchObject({ action: "refuse", reason: expect.stringContaining("没有 pid 文件") });
  });

  it("pid 文件记的端口和配置不一样：不结束", () => {
    expect(stopVerdict({ ...base, record: { ...record, port: PORT + 1 } })).toMatchObject({ action: "refuse" });
  });

  it("在听的是别的进程，或者不止一个：不结束", () => {
    expect(stopVerdict({ ...base, listeners: [200] })).toMatchObject({ action: "refuse", reason: expect.stringContaining("不是 pid 文件里的守护进程") });
    expect(stopVerdict({ ...base, listeners: [100, 200] })).toMatchObject({ action: "refuse", reason: expect.stringContaining("不是 pid 文件里的守护进程") });
  });

  it("pid 对得上、启动时间对不上（pid 被复用）：不结束", () => {
    expect(stopVerdict({ ...base, matches: () => false })).toMatchObject({ action: "refuse", reason: expect.stringContaining("启动时间") });
  });
});
