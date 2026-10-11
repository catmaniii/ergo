// 停稳手头这一轮（84 号票，AgentSession.stopTurn，照 AgentSense 重开前 abort + waitForIdle）：会话接一个假的子进程（报什么由测试说了算，
// 包括不理会 abort 的"停不下的一轮"），看拦着的时候会话做什么、不做什么：
// - 拦着时不开始下一条输入、不送插话，放开后按先后交给新的一轮；
// - 已经按 yield 停下、等着按新的装配接着干的那一轮（27 号票），停稳时直接按中止结束，装配照样换，"工具包已变更"跟在下一条输入后面；
//   abort 和 yield 碰上了（子进程报 yielded）也一样；
// - 到点没停下的那一轮作废：守卫看到的会话报出作废的原因（之后它的调用不放行），那一轮结束后不再作废。
import path from "node:path";
import { maintainerChannel } from "@ergou/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AgentManager, ManagedAgent } from "../src/agent-manager/agent-manager.ts";
import { AgentSession } from "../src/conversation/agent-session.ts";
import { appendMessage } from "../src/conversation/messages.ts";
import type { StreamHub } from "../src/conversation/stream-hub.ts";
import { conversationViews, pendingInputs } from "../src/conversation/views.ts";
import { openEventStore } from "../src/events/event-store.ts";
import type { GuardedSession, GuardRuntime } from "../src/guard-runtime/guard-runtime.ts";
import type { MediaStore } from "../src/media/media-store.ts";
import type { AgentReport, HostCommand } from "../src/runtime/index.ts";
import { voicesView } from "../src/voice/index.ts";
import { waitUntil } from "./helpers/process.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const CONVERSATION = maintainerChannel("tm-stop");

/** 假的子进程：记下收到的命令，报告由测试发 */
class FakeAgent {
  readonly agentId = "tm-stop";
  readonly pid = 4242;
  state: "running" | "exited" = "running";
  readonly commands: HostCommand[] = [];
  private readonly listeners = new Set<(report: AgentReport) => void>();
  private exit!: (exit: unknown) => void;
  readonly exited = new Promise<unknown>((resolve) => {
    this.exit = resolve;
  });

  send(command: HostCommand): void {
    if (this.state !== "running") throw new Error("子进程已经退出");
    this.commands.push(command);
  }
  onReport(listener: (report: AgentReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  report(report: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(report as AgentReport);
  }
  kill(): void {
    if (this.state === "exited") return;
    this.state = "exited";
    this.exit({ code: 0, signal: null, reason: "killed" });
  }
  holdAwake(): () => void {
    return () => {};
  }
  sent(type: HostCommand["type"]): HostCommand[] {
    return this.commands.filter((c) => c.type === type);
  }
  ready(): void {
    this.report({ type: "ready", pid: this.pid, sessionId: "s", sessionFile: "s.jsonl", session: "main", loaded: {}, vision: false, model: { modelId: "faux", thinkingLevel: "off" } });
  }
}

function setup() {
  const store = openEventStore({ file: path.join(makeTempDir("ergou-stop-"), "ergou.db"), views: [...conversationViews, voicesView] });
  const spawned: FakeAgent[] = [];
  let guarded: GuardedSession | undefined;
  const agents = {
    spawn: () => {
      const agent = new FakeAgent();
      spawned.push(agent);
      return agent as unknown as ManagedAgent;
    },
  } as unknown as AgentManager;
  const guards: GuardRuntime = {
    attach: (_proc, session) => {
      guarded = session;
      return () => {};
    },
    stop: () => {},
  };
  const session = new AgentSession({
    agents,
    store,
    streams: { delta: () => {} } as unknown as StreamHub,
    guards,
    media: {} as MediaStore,
    timeZone: "Asia/Shanghai",
    log: () => {},
    agentId: "tm-stop",
    conversation: CONVERSATION,
    label: "维护者",
    interject: true,
    spawn: () => ({ cwd: makeTempDir("ergou-stop-cwd-"), model: { provider: "faux", script: [] } }) as never,
    hostTools: () => [],
    guard: () => ({ agent: { kind: "maintainer", agentId: "tm-stop", cwd: ".", toolkit: { bash: false, network: false }, projectRecords: [], workingDirs: [] }, source: "测试" }),
    configuredVision: () => ({}),
    interruptedNote: () => "被打断了",
  });
  session.start();
  onTestFinished(async () => {
    await session.stop();
    store.close();
  });
  const say = (text: string) => appendMessage(store, { conversation: CONVERSATION, speaker: "user", parts: [{ type: "text", text }] }).id;
  const agent = () => spawned.at(-1)!;
  const inputsSent = () => agent().sent("user_input").map((c) => (c as { inputId: string }).inputId);
  const turnEnds = () => store.read(CONVERSATION).filter((e) => e.type === "turn_end").map((e) => e.payload as { inputMessageId: string; outcome: string });
  /** 用户说第一句：按需的会话这时才拉起子进程，就绪后交过去 */
  const begin = async (text: string) => {
    const id = say(text);
    await waitUntil(() => spawned.length > 0, { timeoutMs: 5_000, describe: () => "等拉起子进程" });
    agent().ready();
    await sentTo(agent(), id);
    return id;
  };
  return { store, session, spawned, agent, say, begin, inputsSent, turnEnds, guarded: () => guarded! };
}

/** 等子进程收到第一条输入（输入的准备是异步的） */
const sentTo = (agent: FakeAgent, inputId: string) =>
  waitUntil(() => agent.sent("user_input").some((c) => (c as { inputId: string }).inputId === inputId), { timeoutMs: 5_000, describe: () => `等 ${inputId} 交给子进程` });

describe("停稳手头这一轮（84 号票）", () => {
  it("拦着时不开始下一条、不送插话；这一轮结束了也等放开；放开后把排着的交给新的一轮", async () => {
    const t = setup();
    const first = await t.begin("先做这个");

    const stopping = t.session.stopTurn(5_000, "作废了");
    expect(t.agent().sent("abort")).toHaveLength(1);
    // 停稳期间用户又说了一句：不当插话送进要停的这一轮，留在队里
    const second = t.say("换个做法");
    await new Promise((r) => setTimeout(r, 50));
    expect(t.agent().sent("interject")).toEqual([]);

    t.agent().report({ type: "turn_end", outcome: "aborted" });
    const { stopped, release } = await stopping;
    expect(stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.inputsSent()).toEqual([first]);
    expect(pendingInputs(t.store.reader, CONVERSATION).map((i) => i.messageId)).toEqual([second]);

    release();
    await sentTo(t.agent(), second);
    expect(t.inputsSent()).toEqual([first, second]);
  });

  it("已经按 yield 停下、等着按新的装配接着干的那一轮：停稳时直接按中止结束，装配照样换，“工具包已变更”跟在下一条输入后面", async () => {
    const t = setup();
    const first = await t.begin("先做这个");
    t.session.reassemble("工具包已变更：去掉了联网");
    expect(t.agent().sent("yield")).toHaveLength(1);
    t.agent().report({ type: "turn_end", outcome: "yielded" });
    // 旧的子进程停掉、按新的装配拉起（还没就绪）
    await waitUntil(() => t.spawned.length === 2, { timeoutMs: 5_000, describe: () => "等按新的装配拉起" });

    const { stopped, release } = await t.session.stopTurn(5_000, "作废了");
    expect(stopped).toBe(true);
    expect(t.turnEnds()).toEqual([expect.objectContaining({ inputMessageId: first, outcome: "aborted" })]);
    // 新的子进程就绪：不再把手头那条接着交过去
    t.agent().ready();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.agent().commands).toEqual([]);

    release();
    const next = t.say("接着做");
    await sentTo(t.agent(), next);
    expect(t.agent().sent("user_input")).toEqual([expect.objectContaining({ inputId: next, context: expect.stringContaining("工具包已变更：去掉了联网") })]);
  });

  it("abort 和 yield 碰上了（子进程报 yielded）：一样按中止结束、不接着干，停稳马上回", async () => {
    const t = setup();
    const first = await t.begin("先做这个");
    t.session.reassemble("工具包已变更：加了 git");
    const stopping = t.session.stopTurn(5_000, "作废了");
    t.agent().report({ type: "turn_end", outcome: "yielded" });
    const { stopped, release } = await stopping;
    expect(stopped).toBe(true);
    expect(t.turnEnds()).toEqual([expect.objectContaining({ inputMessageId: first, outcome: "aborted" })]);
    release();
    const next = t.say("接着做");
    // 放开后先按新的装配重新拉起，再交下一条（带上"工具包已变更"）
    await waitUntil(() => t.spawned.length === 2, { timeoutMs: 5_000, describe: () => "等按新的装配拉起" });
    t.agent().ready();
    await sentTo(t.agent(), next);
    expect(t.agent().sent("user_input")).toEqual([expect.objectContaining({ inputId: next, context: expect.stringContaining("工具包已变更：加了 git") })]);
  });

  it("到点没停下的一轮作废：守卫看到的会话报出作废的原因（之后它的调用不放行）；那一轮结束后不再作废，排着的交给新的一轮", async () => {
    const t = setup();
    const first = await t.begin("先做这个");
    expect(t.guarded().superseded?.()).toBeUndefined();

    // 子进程不理会 abort：到点（50 毫秒）还没停下
    const { stopped, release } = await t.session.stopTurn(50, "用户从某个阶段重做了，这一轮已经作废");
    expect(stopped).toBe(false);
    expect(t.guarded().superseded?.()).toBe("用户从某个阶段重做了，这一轮已经作废");
    const second = t.say("换个做法");
    release();
    await new Promise((r) => setTimeout(r, 50));
    // 作废的那一轮还占着子进程：不送插话，也不开始下一条
    expect(t.agent().sent("interject")).toEqual([]);
    expect(t.inputsSent()).toEqual([first]);

    t.agent().report({ type: "turn_end", outcome: "completed" });
    await sentTo(t.agent(), second);
    expect(t.guarded().superseded?.()).toBeUndefined();
  });
});
