// 录事件流：主切面里跑一段秘书聊天，把模拟前端收到的事件流（连同它自己的本地动作和连接状态）录下来，
// 给 Web 包的前端状态层回放测试用。重新录：ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/recordings.test.ts
import fs from "node:fs";
import { CHANNELS, EVENT_TYPES } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const TURN_END = EVENT_TYPES.turnEnd;

describe("录事件流", () => {
  it("secretary-chat：两轮秘书聊天，回复带推理，逐字流式输出", async () => {
    const { url } = await startTestDaemon({
      secretary: [
        { kind: "reply", thinking: "用户在打招呼，先回应，再问有什么事。", text: "在的。今天有什么要我帮忙的？" },
        { kind: "reply", text: "好，周五交房租，我记下了。不过现在我还不能建提醒，到时候需要你自己留意。" },
      ],
      secretaryTokensPerSecond: 60,
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("在吗");
    await frontend.next(SECRETARY, TURN_END);
    await frontend.sendText("帮我记一下：周五交房租");
    await frontend.next(SECRETARY, TURN_END);
    expect(frontend.events({ persistedOnly: true }).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    saveOrCheckRecording("secretary-chat", frontend.recording);
  });

  it("secretary-reconnect：刚发出一条网就断了，重连后补发的事件替换乐观显示的那条，不重不漏", async () => {
    const { url } = await startTestDaemon({
      secretary: [
        { kind: "reply", text: "在的。" },
        { kind: "reply", text: "收到，断网之前那条我看到了。" },
      ],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("在吗");
    await frontend.next(SECRETARY, TURN_END);

    await frontend.sendTextThenDrop("断网前发出的一句");
    // 另一个窗口看着，等秘书回完这一句
    const watcher = await TestFrontend.connect(url);
    await watcher.subscribe({ [SECRETARY]: 4 });
    await watcher.next(SECRETARY, TURN_END);

    await frontend.reconnect([SECRETARY]);
    await frontend.next(SECRETARY, TURN_END);
    // 断线前收到 1–4，重连后补上 5–8，不重不漏
    expect(frontend.events({ persistedOnly: true }).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    saveOrCheckRecording("secretary-reconnect", frontend.recording);
  });

  it("secretary-resync：数据目录恢复成了旧快照，前端的序号比服务端还大，重新同步", async () => {
    const backup = makeTempDir("ergou-db-backup-");
    const first = await startTestDaemon({ secretary: [{ kind: "reply", text: "第一轮的回复" }] });
    const frontend = await TestFrontend.connect(first.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("第一轮");
    await frontend.next(SECRETARY, TURN_END);
    await first.daemon.stop();
    const { db } = dataDirLayout(first.dataDir);
    fs.cpSync(db, backup, { recursive: true });

    const reuse = { dataDir: first.dataDir, homeDir: first.homeDir };
    const second = await startTestDaemon({ secretary: [{ kind: "reply", text: "第二轮的回复（快照之后，会丢）" }], reuse });
    await frontend.reconnect([SECRETARY], second.url);
    await frontend.sendText("第二轮");
    await frontend.next(SECRETARY, TURN_END);
    await frontend.disconnect();
    await second.daemon.stop();

    fs.rmSync(db, { recursive: true, force: true });
    fs.cpSync(backup, db, { recursive: true });
    const restored = await startTestDaemon({ secretary: [], reuse });
    await frontend.reconnect([SECRETARY], restored.url);
    await frontend.next(SECRETARY, TURN_END);
    expect(frontend.cursors).toEqual({ [SECRETARY]: 4 });
    saveOrCheckRecording("secretary-resync", frontend.recording);
  });
});
