// 主切面：体检"二狗本身"的新检查（410）接在真的守护进程上——临时数据目录、系统挑的端口、faux 模型，不碰真的服务管家（替身）：
// - 模型近况：agent 管家真的记下了这一轮的结局（faux 剧本用完 = 模型出错），体检里"模型近况"那一项跟着变；
// - 对话长度 + "现在压缩"：秘书的一轮用量过了自动压缩点、到了窗口九成，自动压缩没压成（会话补记了这次失败）→ 体检里这一项坏了、
//   带"现在压缩"按钮；按按钮上的 agent 调"现在压缩"的接口（网页的按钮走的就是它），真的压了一次；
// - 外网入口：服务管家（替身）推来的 tailnet 入口测得打不通 → 外网入口不是绿；二狗和服务管家连着，服务管家那项带上 link。
import { CHANNELS, type ConversationId, DOCTOR_CORE_GROUP, type DoctorCheckDataById, type DoctorView, EVENT_TYPES } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, doctorApi } from "../helpers/http.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { say } from "../helpers/task-flow.ts";

const SECRETARY = CHANNELS.secretary;
/** 约 2.5 万 token 的一大段（压缩时最近约 2 万原样留着，前面的写进摘要） */
const long = (n: number) => `材料${n}：${"一段很长的材料。".repeat(12_500)}`;

const turnEnds = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length;

/** 说一句，等这个会话又处理完一条 */
async function say1(frontend: TestFrontend, text: string, conversation: ConversationId = SECRETARY): Promise<void> {
  const before = turnEnds(frontend, conversation);
  await frontend.sendText(text, { conversation });
  await waitUntil(() => turnEnds(frontend, conversation) > before, { timeoutMs: 30_000, describe: () => `等 ${conversation} 处理完「${text.slice(0, 10)}」` });
}

const coreItem = (view: DoctorView, id: string) => view.groups.find((group) => group.id === DOCTOR_CORE_GROUP)!.items.find((item) => item.id === id)!;

describe("体检：二狗本身的新检查（410）", () => {
  it("模型近况：agent 管家记下这一轮出错了，体检里这一项要注意，事实写几轮里几轮出错", { timeout: 60_000 }, async () => {
    // 剧本是空的：秘书一调用模型就出错
    const td = await startTestDaemon({ secretary: [] });
    const quiet = coreItem((await doctorApi.view(td.url)).body, "model-calls");
    expect(quiet).toMatchObject({ level: "ok", text: { fact: "最近没调用过" } });

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await say1(frontend, "你好");
    expect(td.daemon.agents.recentTurns()).toEqual([expect.objectContaining({ agentId: "secretary", outcome: "error", error: expect.any(String) })]);
    const calls = coreItem((await doctorApi.view(td.url)).body, "model-calls");
    expect(calls.level).toBe("warn");
    expect(calls.text.fact).toContain("最近 15 分钟 1 轮里 1 轮出错");
    expect(calls.action).toEqual({ kind: "open", route: "#/more/models" });
  });

  it("对话长度：过了自动压缩点、到了窗口九成，自动压缩没压成（会话补记了）→ 坏了，带\"现在压缩\"；按按钮上的 agent 调接口，真的去压了", { timeout: 90_000 }, async () => {
    const steps: FauxStep[] = [
      say("好"),
      say("收到了一大段"),
      // 这一轮报的用量：12 万（faux 默认窗口 12.8 万：过了自动压缩点 128000 - 16384，也到了窗口九成）。
      // 剧本到这里用完：一轮结束 pi 自动压缩，写摘要那次模型出错，没压成
      { kind: "reply", text: "好", usage: { cacheHit: 0, cacheMiss: 120_000, output: 10 } },
    ];
    const td = await startTestDaemon({ secretary: steps });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await say1(frontend, "开头一句");
    await say1(frontend, long(1));
    await say1(frontend, "第二句");
    // 自动压缩结束了（没压成）：会话补记了，⚙ 那一份里有
    await expect.poll(async () => (await agentSettingsApi.view(td.url, "secretary")).body.context.lastAutoCompact?.outcome, { timeout: 30_000 }).toBe("failed");

    const before = coreItem((await doctorApi.view(td.url)).body, "context");
    expect(before.level).toBe("error");
    expect(before.action).toEqual({ kind: "compact", agentId: "secretary" });
    expect(before.text.fact).toContain("94%");
    expect(before.text.fact).not.toContain("秘书");
    expect(before.text.fix).toContain("现在压缩");

    // 网页上"现在压缩"的按钮：POST /api/agents/<按钮上的 agent>/compact（DoctorPage 的 compactAgent）。收下了、真的压了一次
    // （剧本用完了，这次压缩照样没压成；压成的那条路和会话 ⚙ 里同一个接口，agent-settings.test.ts 测着）
    const agentId = before.action!.kind === "compact" ? before.action!.agentId : "";
    const started = await agentSettingsApi.compact(td.url, agentId);
    expect(started.status).toBe(200);
    expect(["waiting", "running"]).toContain(started.body.context.compaction);
    await expect.poll(async () => (await agentSettingsApi.view(td.url, agentId)).body.context.lastCompact?.outcome, { timeout: 30_000 }).toBe("failed");
    expect((await agentSettingsApi.view(td.url, agentId)).body.context.compaction).toBe("idle");
  });

  it("外网入口：服务管家推来的 tailnet 入口测得打不通 → 不是绿（唯一的入口不通是坏了），事实写哪个入口、为什么；服务管家那项带上连接", { timeout: 60_000 }, async () => {
    const standIn = await startLsmStandIn({ entries: { entries: [], wrongPort: [] } });
    const td = await startTestDaemon({ env: { ERGO_SVC_PORT: "1", LSM_DATA_DIR: makeTempDir(), ...standIn.env } });
    const hello = await standIn.waitFor((m) => m.type === "hello", "hello");
    standIn.setEntries({ entries: [{ kind: "tailnet", url: "https://ergo.tail.example.test/", port: hello.externalPort, reachable: false, why: "tailnet 节点离线" }], wrongPort: [] });
    await expect
      .poll(async () => ((await doctorApi.view(td.url)).body.checks.find((check) => check.id === "external")!.data as DoctorCheckDataById["external"]).entries?.length ?? 0, { timeout: 15_000 })
      .toBe(1);
    const view = (await doctorApi.view(td.url)).body;
    const external = view.checks.find((check) => check.id === "external")!;
    expect(external.ok).toBe(false);
    expect(external.fix).toBe("doctor.fix.externalUnreachable");
    const item = coreItem(view, "external");
    expect(item.level).toBe("error");
    expect(item.text.fact).toContain("https://ergo.tail.example.test/（tailnet 节点离线）");
    // 二狗和服务管家（替身）连着
    expect((view.checks.find((check) => check.id === "supervisor")!.data as DoctorCheckDataById["supervisor"]).link).toBe("connected");
  });
});
