// 主切面：秘书指挥服务管家（418）。真的守护进程，秘书接 faux 剧本，服务管家是替身（helpers/lsm-stand-in.ts：welcome 带 manage，
// 管理指令按剧本回；不连真的服务管家、不起任何服务）。对话审批照正式的默认关着。
// - 秘书有六个服务管家工具；"停 comfyui"直接做（不出卡），工具卡片记着做了什么；没有正常停止办法的 audiocpp 说停就自动改成强制停
//   （用户 11-07 定的"直接停"，也不出卡）；要停二狗自己的在本地就拒了，一条停的指令都没发；
// - 重启二狗自己：对话审批关着也出审批卡（不可逆的提交，卡上没有"秘书"）；批准后服务管家回"已排队"工具马上返回；
//   服务管家紧接着要求等空闲重启，二狗在秘书这一轮说完之前不停（这一轮里还在调别的工具也不停），说完才优雅停下、发 bye——不死锁。
import { type ApprovalCardPayload, type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, type MessageEventPayload, type MessagePart, Type } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import type { LsmManagedService } from "../../src/lsm/link.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { type LinkMessage, startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY, cards: CARDS } = CHANNELS;
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });

const service = (id: string, extra: Partial<LsmManagedService> = {}): LsmManagedService => ({
  id,
  title: id,
  port: null,
  state: "RUNNING",
  up: true,
  autostart: false,
  capabilities: ["start", "stop"],
  protected: false,
  protectedWhy: [],
  ...extra,
});
const SERVICES = [
  service("ergo-daemon", { title: "二狗", capabilities: ["start", "busy", "stop", "restart", "health"], protected: true, protectedWhy: ["调用方自己"] }),
  service("comfyui", { title: "画图", port: 18188 }),
  // 二狗名下的语音合成：没有停机钩子、也没接入，没有正常停止的办法（不带 force 停它回 no-capability）
  service("ergo-daemon--audiocpp", { title: "语音合成", port: 18090, capabilities: ["start", "health"] }),
];

/** 替身：列表照上面的；stop 回停了；restartSelf 回已排队，紧接着（回复之后）要求等空闲重启 */
async function standIn(heartbeatIntervalMs = 60_000) {
  const holder: { send?: (m: Record<string, unknown>) => void } = {};
  const lsm = await startLsmStandIn({
    heartbeatIntervalMs,
    manage: (m: LinkMessage) => {
      if (m.type === "manage.list") return { ok: true, self: "ergo-daemon", services: SERVICES, profiles: {}, lifeline: [{ id: "ergo-daemon", why: ["调用方自己"] }] };
      if (m.type === "manage.stop") {
        const target = SERVICES.find((s) => s.id === m.name)!;
        if (!target.capabilities.includes("stop") && m.force !== true) return { ok: false, error: { code: "no-capability", message: `${target.id} 没有停机能力。要停就带 force: true` } };
        return { ok: true, service: { ...target, state: "STOPPED", up: false } };
      }
      if (m.type === "manage.restartSelf") {
        setTimeout(() => holder.send?.({ type: "restart", id: "cmd-self", mode: "when-idle", deadlineMs: 3_600_000 }), 0);
        return { ok: true, queued: true, note: "已排队" };
      }
      return { ok: false, error: { code: "bad-request", message: `剧本里没有 ${m.type}` } };
    },
  });
  holder.send = (m) => lsm.send(m);
  return lsm;
}

const manageSent = (messages: ReadonlyArray<{ message: LinkMessage }>) => messages.map((m) => m.message).filter((m) => m.type.startsWith("manage."));
const toolPartsOf = (frontend: TestFrontend): ToolCallPart[] =>
  frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
const latestCards = (frontend: TestFrontend): Card[] => [
  ...new Map(frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => [(f.payload as CardEventPayload).card.id, (f.payload as CardEventPayload).card])).values(),
];
const lastText = (frontend: TestFrontend): string =>
  frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .filter((m) => m.speaker === "agent" && m.parts.some((p) => p.type === "text"))
    .at(-1)!
    .parts.map((p) => (p.type === "text" ? p.text : ""))
    .join("");

/** 守护进程接着在不在：/healthz 答不答 */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(new URL("/healthz", url));
    return true;
  } catch {
    return false;
  }
}

describe("秘书指挥服务管家", () => {
  it("秘书有六个服务管家工具；停别的服务直接做、工具卡片写着做了什么；没有正常停止办法的直接强制停、不出卡；停二狗自己在本地就拒了", async () => {
    const lsm = await standIn();
    const td = await startTestDaemon({
      env: lsm.env,
      secretary: [
        call("lsm_control", { action: "stop", service: "画图" }),
        call("lsm_control", { action: "stop", service: "audiocpp" }),
        call("lsm_control", { action: "stop", service: "ergo-daemon" }),
        { kind: "echo_context" },
      ],
      config: { guard: { conversationApprovals: "off" } },
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await lsm.waitFor((m) => m.type === "hello", "握手");
    await frontend.sendText("把画图和 audiocpp 停了，顺便把你自己也停了");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    const context = lastText(frontend);
    for (const tool of ["lsm_status", "lsm_logs", "lsm_control", "lsm_force", "lsm_entries", "lsm_restart_self"]) expect(context).toContain(`[tool] ${tool}`);
    expect(context).toContain("[toolResult] lsm_control: 已停止「comfyui」（画图）。");
    expect(context).toContain("[toolResult] lsm_control: 「ergo-daemon--audiocpp」（语音合成）没有正常停止的办法，已经强制停下（它手上正在做的断了）。");
    expect(context).toContain("[toolResult] lsm_control: 「ergo-daemon」（二狗）不能停止：这是二狗自己。");
    // 画图优雅停；语音合成先优雅停、回没有能力，自动改成强制停；二狗自己一条停的指令都没发
    expect(manageSent(lsm.messages).map(({ id: _id, ...rest }) => rest)).toEqual([
      { type: "manage.list" },
      { type: "manage.stop", name: "comfyui", mode: "now", force: false },
      { type: "manage.list" },
      { type: "manage.stop", name: "ergo-daemon--audiocpp", mode: "now", force: false },
      { type: "manage.stop", name: "ergo-daemon--audiocpp", mode: "now", force: true },
      { type: "manage.list" },
    ]);
    const parts = toolPartsOf(frontend);
    expect(parts.map((p) => [p.tool, p.argsSummary, p.categoryTitles, p.outcome])).toEqual([
      ["lsm_control", "action=stop service=画图", [], "done"],
      ["lsm_control", "action=stop service=audiocpp", [], "done"],
      // 本地拒了：工具结果是出错（没做成）
      ["lsm_control", "action=stop service=ergo-daemon", [], "error"],
    ]);
    expect(parts[0]!.resultSummary).toBe("已停止「comfyui」（画图）。 现在：「comfyui」（画图）：停着，端口 18188");
    expect(latestCards(frontend).filter((c) => c.type === "approval")).toEqual([]);
    expect(await answers(td.url)).toBe(true);
  }, 90_000);

  it("重启二狗自己：审批关着也出卡，批了马上返回已排队；秘书这一轮说完之前不停（还在调别的工具也不停），说完才停、发 bye", async () => {
    const lsm = await standIn(100);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // 秘书这一轮里接着调一个慢工具：只看、不算有副作用的调用（自己不报忙），这时只有"等它说完这一轮"在挡着重启
    const waitGate = defineHostTool({
      name: "wait_gate",
      title: "等放行",
      description: "测试用：等测试放行",
      parameters: Type.Object({}, { additionalProperties: false }),
      readOnlyOrIdempotent: true,
      nature: "look",
      run: async () => {
        await gate;
        return { text: "放行了" };
      },
    });
    const td = await startTestDaemon({
      env: lsm.env,
      secretary: [call("lsm_restart_self", { reason: "改了配置要生效" }), call("wait_gate", {}), say("好，空闲了就重启，回来接着聊")],
      secretaryTools: [waitGate],
      config: { guard: { conversationApprovals: "off" } },
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await lsm.waitFor((m) => m.type === "heartbeat", "第一次心跳");
    await frontend.sendText("重启一下你自己");

    let card: Card | undefined;
    await waitUntil(() => (card = latestCards(frontend).find((c) => c.type === "approval" && c.status === "pending")) !== undefined, { timeoutMs: 30_000, describe: () => "等审批卡" });
    const p = card!.payload as ApprovalCardPayload;
    expect([p.tool, p.toolTitle, p.argsSummary, p.categoryTitles]).toEqual(["lsm_restart_self", "等空闲后重启二狗", "reason=改了配置要生效", ["不可逆的提交"]]);
    expect(p.reason).toContain("特别敏感的操作，对话审批关着也要用户授权");
    expect(p.reason).not.toContain("秘书");
    // 批之前什么都没发
    expect(manageSent(lsm.messages)).toEqual([]);
    const from = lsm.messages.length;
    const r = await frontend.cardAction({ cardId: card!.id, action: "approve", expectedVersion: card!.version });
    if (!r.ok) throw new Error(`审批卡没处理成：${r.error.message}`);

    // 发了就返回：秘书拿到已排队、接着调下一个工具；服务管家要求等空闲重启，二狗应答、挂起
    expect(await lsm.waitFor((m) => m.type === "manage.restartSelf", "重启自己", { from })).toMatchObject({ mode: "when-idle" });
    expect(await lsm.waitFor((m) => m.type === "ack" && m.id === "cmd-self", "重启指令的应答", { from })).toMatchObject({ ok: true });
    const busy = await lsm.waitFor((m) => m.type === "heartbeat" && m.busy === true, "等秘书说完这一轮时报忙", { from });
    expect(busy.busyReason).toBe("秘书刚排上等空闲重启二狗，等它说完这一轮");
    // 这一轮还没说完：心跳照报、不停
    const seen = lsm.messages.length;
    await waitUntil(() => lsm.messages.slice(seen).filter((m) => m.message.type === "heartbeat").length >= 5, { timeoutMs: 10_000, describe: () => "再等几次心跳" });
    expect(lsm.messages.some((m) => m.message.type === "bye")).toBe(false);
    expect(await answers(td.url)).toBe(true);

    // 放行：秘书说完这一轮，二狗才优雅停下
    release!();
    expect(await lsm.waitFor((m) => m.type === "bye", "bye", { timeoutMs: 30_000 })).toEqual({ type: "bye", reason: "shutdown-complete" });
    // 停之前推的（这一轮的最后一句、回合结束）停机时先写出去再断开；这边连接关掉时它们都已经解开、交出来了
    await frontend.closed();
    expect(lastText(frontend)).toBe("好，空闲了就重启，回来接着聊");
    // 重启自己批了、做完了（拿到已排队就返回），接着调了慢工具
    const parts = toolPartsOf(frontend);
    expect(parts.map((part) => [part.tool, part.categoryTitles, part.disposition, part.outcome])).toEqual([
      ["lsm_restart_self", ["不可逆的提交"], "ask_first", "done"],
      ["wait_gate", [], "do", "done"],
    ]);
    expect(parts[0]!.resultSummary).toMatch(/^排好了：二狗空闲了（手上的任务、正在执行的调用做完，这一轮话说完）就会重启/);
    expect(frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length).toBe(1);
  }, 90_000);
});
