// 主切面：从快照恢复（规格第 18 节）。用户经 LSM 停掉守护进程，用恢复命令从指定日期的快照恢复数据目录，再经 LSM 起来。
// 这里直接调恢复命令背后的函数（命令行入口另有 restore-cli.test.ts），守护进程是临时数据目录里的测试实例。
// 恢复成旧快照之后，前端记的序号比服务端大：订阅时这些频道重新同步（04 号票），补发的就是快照里的事件。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type EventFrame, type MessageEventPayload, nowIso, type SubscribeResult } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { restoreSnapshot } from "../../src/backup/restore.ts";
import { backupArea, put, startBackupDaemon } from "../helpers/backup.ts";
import { reminderService } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { freePorts } from "../helpers/ports.ts";
import { waitUntil } from "../helpers/process.ts";
import { isReadOnly, listTree, makeWritable, snapshotFile } from "../helpers/snapshots.ts";
import { withoutFoldersBlock } from "../helpers/folders-block.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0 };
const TURN_END = EVENT_TYPES.turnEnd;

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

/** 落盘的事件，去掉和连接有关的东西，好比较 */
const persisted = (frames: EventFrame[]) => frames.filter((f) => f.type !== EVENT_TYPES.stream).map(({ channel, seq, type, payload }) => ({ channel, seq, type, payload }));

const noticeOf = (title: string) => ({ kind: "notice" as const, notice: "missed_reminder" as const, title, source: "测试", urgency: "non_blocking" as const });

describe("恢复命令", () => {
  it("守护进程在运行时拒绝执行，什么也不动；停掉之后才恢复", async () => {
    const ports = await freePorts();
    const test = await startBackupDaemon({ start: at(10, 7, 21), config: { ports } });
    // 本人素材的原文副本（08 号票）是只读的；模型区能重新下载，不进备份
    const original = put(test.dataDir, "materials/originals/2026-10/m-1.json", '{"format":1}');
    fs.chmodSync(original, 0o444);
    const model = put(test.dataDir, "models/Xenova/bge-m3/model.onnx", "很大的模型文件");
    await test.advanceTo(at(10, 8, 3, 30));
    expect(listTree(path.join(test.layout.backups, "2026-10-08")).filter((f) => f.includes("models/"))).toEqual([]);
    const after = put(test.dataDir, "projects/p-demo/after.md", "快照之后写的");

    // 守护进程起来后写了 pid 文件（23 号票起由 startDaemon 写），先按它判断
    await expect(restoreSnapshot({ config: test.daemon.config, layout: test.layout, date: "2026-10-08" })).rejects.toThrow(
      `守护进程还在运行（pid 文件里的守护进程（PID ${process.pid}）还在运行）：先在 Local Service Manager 里停掉 ergo-daemon，再恢复`,
    );
    expect(fs.existsSync(after)).toBe(true);
    expect(backupArea(test.layout.backups)).toEqual(["2026-10-08"]);

    await test.daemon.stop();
    const result = await restoreSnapshot({ config: test.daemon.config, layout: test.layout, date: "2026-10-08" });
    expect(fs.existsSync(after)).toBe(false);
    // 恢复之前的内容挪到了本机备份区的 pre-restore-… 里，没有丢
    expect(path.dirname(result.setAside)).toBe(test.layout.backups);
    expect(fs.readFileSync(path.join(result.setAside, "projects/p-demo/after.md"), "utf8")).toBe("快照之后写的");
    // 恢复出来的文件能写（本机备份区的快照文件是只读的，复制出来要去掉只读）；原来就只读的（原文副本）还是只读
    expect(isReadOnly(original)).toBe(true);
    const restored = listTree(test.dataDir).filter((f) => !f.startsWith("backups/") && !f.startsWith("models/") && !f.startsWith("materials/originals/"));
    for (const rel of restored) expect(isReadOnly(path.join(test.dataDir, rel))).toBe(false);
    // 模型区原地不动（没挪走，也没被清掉）
    expect(fs.readFileSync(model, "utf8")).toBe("很大的模型文件");
    expect(fs.existsSync(path.join(result.setAside, "models"))).toBe(false);
  });

  it("每恢复一次挪走一份 pre-restore-…，只留最近 2 份，更早的删掉", async () => {
    const test = await startBackupDaemon({ start: at(10, 7, 21) });
    await test.advanceTo(at(10, 8, 3, 30));
    await test.daemon.stop();
    const setAside: string[] = [];
    for (let i = 1; i <= 3; i++) {
      put(test.dataDir, "projects/p-demo/after.md", `第 ${i} 次恢复之前写的`);
      const result = await restoreSnapshot({ config: test.daemon.config, layout: test.layout, date: "2026-10-08", now: at(10, 8, 9, i) });
      setAside.push(path.basename(result.setAside));
    }
    expect(setAside).toEqual(["pre-restore-20261008-090100", "pre-restore-20261008-090200", "pre-restore-20261008-090300"]);
    expect(backupArea(test.layout.backups)).toEqual(["2026-10-08", ...setAside.slice(1)]);
    expect(fs.readFileSync(path.join(test.layout.backups, setAside[2]!, "projects/p-demo/after.md"), "utf8")).toBe("第 3 次恢复之前写的");
  });

  it("停掉守护进程，从本机备份区恢复到某一天，再起来：事件、看板、待我处理和会话都和那份快照一致，密钥区不动；前端带着更大的序号重连，这些频道重新同步", async () => {
    const first = await startBackupDaemon({
      start: at(10, 7, 21),
      secretary: [
        { kind: "reply", text: "第一轮的回复" },
        { kind: "reply", text: "第二轮的回复（快照之后，会丢）" },
      ],
    });
    const keyFile = put(first.dataDir, "secrets/deepseek-api-key.txt", "sk-快照之前的\n");
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe(ALL);
    await frontend.sendText("第一轮");
    await frontend.next(SECRETARY, TURN_END);
    reminderService(first.daemon).create({ text: "交房租", schedule: { kind: "once", at: nowIso(at(10, 9, 9)) } }, "agent");
    first.daemon.inbox.add(noticeOf("快照之前的事项"));
    await frontend.next(INBOX, EVENT_TYPES.inboxItem);
    const atSnapshot = persisted(frontend.events({ persistedOnly: true }));
    const cursorsAtSnapshot = frontend.cursors;

    await first.advanceTo(at(10, 8, 3, 30));
    // 快照之后：又聊了一轮、取消了提醒、多了一条事项，密钥换过
    await frontend.sendText("第二轮");
    await frontend.next(SECRETARY, TURN_END);
    reminderService(first.daemon).cancel("r-1", "agent");
    first.daemon.inbox.add(noticeOf("快照之后的事项"));
    await frontend.next(INBOX, EVENT_TYPES.inboxItem);
    fs.writeFileSync(keyFile, "sk-换过的\n");
    await frontend.disconnect();
    await first.daemon.stop();

    const result = await restoreSnapshot({ config: first.daemon.config, layout: first.layout, date: "2026-10-08" });
    expect(result.snapshot).toBe(path.join(first.layout.backups, "2026-10-08"));
    expect(fs.readFileSync(keyFile, "utf8")).toBe("sk-换过的\n");

    const restored = await startBackupDaemon({
      start: at(10, 8, 12),
      syncDir: first.syncDir,
      reuse: { dataDir: first.dataDir, homeDir: first.homeDir },
      secretary: [{ kind: "echo_context" }],
    });
    // 当天的快照恢复前就有了：启动时补做的备份不覆盖它
    expect(backupArea(restored.layout.backups).filter((n) => !n.startsWith("pre-restore-"))).toEqual(["2026-10-08"]);

    const seenBefore = frontend.events({ persistedOnly: true }).length;
    const response = await frontend.reconnect(Object.keys(ALL), restored.url);
    expect((response as { result: SubscribeResult }).result.resync.toSorted()).toEqual([BOARD, CARDS, INBOX, SECRETARY].toSorted());
    await waitUntil(() => JSON.stringify(frontend.cursors) === JSON.stringify(cursorsAtSnapshot), { timeoutMs: 5_000, describe: () => JSON.stringify(frontend.cursors) });
    const replayed = persisted(frontend.events({ persistedOnly: true }).slice(seenBefore));
    for (const channel of Object.keys(ALL)) {
      expect(replayed.filter((f) => f.channel === channel)).toEqual(atSnapshot.filter((f) => f.channel === channel));
    }
    expect(reminderService(restored.daemon).get("r-1")?.status).toBe("pending");
    expect(restored.daemon.inbox.list().map((i) => i.title)).toEqual(["快照之前的事项"]);

    // 会话：秘书接着快照里的那份 pi 会话，看得到第一轮，看不到快照之后的第二轮
    await frontend.sendText("第三轮");
    const reply = await agentReplyAfter(frontend, seenBefore, cursorsAtSnapshot[SECRETARY]!);
    expect(reply).toMatch(/\[user\] [^\n]*\n第一轮\n\[assistant\] 第一轮的回复\n\[user\] [^\n]*\n第三轮/);
    expect(reply).not.toContain("第二轮");
  });

  it("本机备份区里那一天的快照没了：从同步目录按清单和公共池恢复（会话文件只写了一半的最后一行也能正常读出）", async () => {
    const first = await startBackupDaemon({ start: at(10, 7, 21) });
    first.daemon.inbox.add(noticeOf("快照之前的事项"));
    const complete = '{"type":"session","id":"s1"}\n{"type":"message","n":1}\n';
    put(first.dataDir, "sessions/maintainer-demo/s1.jsonl", `${complete}{"type":"message","n":2,"te`);
    // 较大的媒体：同步目录里放在公共池，恢复时按清单从池里取回来
    const photo = crypto.randomBytes(150 * 1024);
    const sha = crypto.createHash("sha256").update(photo).digest("hex");
    put(first.dataDir, `materials/media/${sha}`, photo);
    const original = put(first.dataDir, "materials/originals/2026-10/m-1.json", '{"format":1}');
    fs.chmodSync(original, 0o444);
    await first.advanceTo(at(10, 8, 3, 30));
    expect(snapshotFile(first.syncDir, "2026-10-08", `materials/media/${sha}`)).toBe(path.join(first.syncDir, "pool", sha));
    first.daemon.inbox.add(noticeOf("快照之后的事项"));
    fs.rmSync(path.join(first.dataDir, "materials"), { recursive: true });
    await first.daemon.stop();
    fs.rmSync(path.join(first.layout.backups, "2026-10-08"), { recursive: true });

    const result = await restoreSnapshot({ config: first.daemon.config, layout: first.layout, date: "2026-10-08" });
    expect(result.snapshot).toBe(path.join(first.syncDir, "2026-10-08"));
    const session = fs.readFileSync(path.join(first.dataDir, "sessions/maintainer-demo/s1.jsonl"), "utf8");
    expect(session).toBe(complete);
    expect(session.trimEnd().split("\n").map((line) => JSON.parse(line) as unknown)).toHaveLength(2);
    expect(fs.readFileSync(path.join(first.dataDir, "materials/media", sha)).equals(photo)).toBe(true);
    expect(isReadOnly(path.join(first.dataDir, "materials/media", sha))).toBe(false);
    expect(isReadOnly(original)).toBe(true);

    const restored = await startBackupDaemon({ start: at(10, 8, 12), syncDir: first.syncDir, reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    expect(restored.daemon.inbox.list().map((i) => i.title)).toEqual(["快照之前的事项"]);
  });

  it("没有那一天的快照、或者快照没通过校验：拒绝，说明原因，数据目录不动", async () => {
    const test = await startBackupDaemon({ start: at(10, 7, 21) });
    await test.advanceTo(at(10, 9, 3, 30));
    await test.daemon.stop();
    const before = listTree(test.dataDir);

    await expect(restoreSnapshot({ config: test.daemon.config, layout: test.layout, date: "2026-10-01" })).rejects.toThrow(
      "找不到 2026-10-01 的快照。现有的快照——本机备份区：2026-10-08、2026-10-09；同步目录：2026-10-08、2026-10-09",
    );
    // 本机那份坏了：拒绝（同步目录里那份是好的，可以指定 from: "sync"）
    const db = path.join(test.layout.backups, "2026-10-09/data/db/ergo.db");
    makeWritable(db);
    fs.writeFileSync(db, Buffer.alloc(fs.statSync(db).size, 0x5a));
    await expect(restoreSnapshot({ config: test.daemon.config, layout: test.layout, date: "2026-10-09" })).rejects.toThrow(/没通过校验，没有恢复：db\/ergo\.db：file is not a database/);
    expect(listTree(test.dataDir)).toEqual(before);
    await restoreSnapshot({ config: test.daemon.config, layout: test.layout, date: "2026-10-09", from: "sync" });
  });
});

/** 等秘书会话里序号大于 afterSeq 的那条回复（秘书说的；只看第 fromIndex 个落盘事件之后收到的），取出它的文字 */
async function agentReplyAfter(frontend: TestFrontend, fromIndex: number, afterSeq: number): Promise<string> {
  const find = () =>
    frontend
      .events({ persistedOnly: true })
      .slice(fromIndex)
      .filter((f) => f.channel === SECRETARY && f.type === EVENT_TYPES.message && f.seq > afterSeq)
      .map((f) => (f.payload as MessageEventPayload).message)
      .find((m) => m.speaker === "agent");
  await waitUntil(() => find() !== undefined, { timeoutMs: 20_000 });
  return withoutFoldersBlock(find()!.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
}
