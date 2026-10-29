// 守卫的话按谁看用哪种语言（173 号票）：用户把语言换成英文以后——
// - 交回 agent 的说明照旧是中文（给模型的话不翻）：拒绝、"用户拒绝了这次调用"；
// - 审批卡上的工具名、类别名、原因，工具调用记录上的类别名和结果摘要是英文：判定在中文下做，给用户看的在英文下照同样的输入再判一遍；
// - 判定的身份不随语言变：审批记下的类别 id 照旧。
import fs from "node:fs";
import path from "node:path";
import { type ApprovalCardPayload, type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, type MessageEnvelope, type MessageEventPayload, type MessagePart } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { languageApi } from "../helpers/http.ts";
import { SECRETARY_START_TIMEOUT_MS, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS } = CHANNELS;
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
const HAN = /[一-鿿]/;

const messagesOf = (frontend: TestFrontend): MessageEnvelope[] => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
const toolParts = (frontend: TestFrontend): ToolCallPart[] => messagesOf(frontend).flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
const lastEcho = (frontend: TestFrontend): string =>
  messagesOf(frontend)
    .at(-1)!
    .parts.map((p) => (p.type === "text" ? p.text : ""))
    .join("");
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;

describe("英文下守卫的话：给 agent 的中文，给用户的英文", { timeout: 60_000 }, () => {
  it("先问我：审批卡是英文、记下的类别 id 照旧；用户拒绝，agent 收到中文的说明、工具调用记录的摘要是英文；硬拒绝同样", async () => {
    // 一起来就是英文（停着时写好的语言设置，启动时照它）
    const dataDir = makeTempDir("ergo-data-");
    const layout = dataDirLayout(dataDir);
    fs.mkdirSync(layout.config, { recursive: true });
    fs.writeFileSync(layout.languageFile, JSON.stringify({ format: 1, language: "en" }));
    const keys = path.join(realPathOf(dataDir)!, path.relative(dataDir, layout.secrets), "keys.json");
    const test = await startTestDaemon({
      reuse: { dataDir, homeDir: makeTempDir("ergo-home-") },
      secretary: [call("read", { path: "~/Documents/bill.txt" }), ECHO, call("read", { path: keys }), ECHO],
    });
    expect((await languageApi.list(test.url)).body).toMatchObject({ language: "en" });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });

    await frontend.sendText("look at my bill");
    const card = (await frontend.next(CARDS, EVENT_TYPES.card, SECRETARY_START_TIMEOUT_MS)).payload as CardEventPayload;
    const payload = card.card.payload as ApprovalCardPayload;
    expect(payload).toMatchObject({ tool: "read", toolTitle: "Read file", categoryTitles: ["Outside the project folders"] });
    expect(payload.reason).toContain("Outside the project folders");
    expect(payload.reason).toMatch(/^Ask the user first: /);
    expect(payload.reason).not.toMatch(HAN);
    expect(test.daemon.approvals.get(payload.approvalId)).toMatchObject({ categories: ["outside_project"] });

    const latest: Card = card.card;
    expect((await frontend.cardAction({ cardId: latest.id, action: "deny", expectedVersion: latest.version, note: "not now" })).ok).toBe(true);
    await waitUntil(() => turnEnds(frontend) >= 1, { describe: () => "等秘书处理完第一条" });
    expect(lastEcho(frontend)).toContain("[toolResult] read: 用户拒绝了这次调用：not now");
    expect(toolParts(frontend)).toMatchObject([{ tool: "read", categoryTitles: ["Outside the project folders"], outcome: "denied", resultSummary: "You declined it: not now" }]);

    // 硬拒绝（密钥区连读都拒绝）：agent 收到中文的说明，工具调用记录上是英文的原因
    await frontend.sendText("read the keys");
    await waitUntil(() => turnEnds(frontend) >= 2, { describe: () => "等秘书处理完第二条" });
    expect(lastEcho(frontend)).toContain("[toolResult] read: 拒绝：");
    expect(lastEcho(frontend)).toContain("密钥区连读都拒绝");
    const refused = toolParts(frontend).at(-1)!;
    expect(refused).toMatchObject({ tool: "read", outcome: "blocked", blockedBy: "hard_refusal" });
    expect(refused.resultSummary).toMatch(/^Refused: /);
    expect(refused.resultSummary).not.toMatch(HAN);
  });
});
