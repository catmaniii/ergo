// 守护进程"其他目录"（174 号票）的话按谁看用哪种语言：用户把语言换成英文以后——
// - 卡片（提醒卡、快速动作的确认卡）、待我处理的标题和来源、设置里系统提示的名字和说明是英文，没有一个汉字；
// - 交回秘书的工具结果、看板照旧中文（给模型的话不翻），里面用到的协议包说法（时间、状态名）、快速动作的名字、守卫的说法也是中文。
import fs from "node:fs";
import {
  ASSISTANT_NAME_MARK,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  type MessageEnvelope,
  type MessageEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { languageApi, systemPromptsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX } = CHANNELS;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
const HAN = /[一-鿿]/;
/** 名字占位是内部记号（前端换成用户起的名字），不算漏翻 */
const shown = (text: string) => text.replaceAll(ASSISTANT_NAME_MARK, "");

const messagesOf = (frontend: TestFrontend): MessageEnvelope[] => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
const lastEcho = (frontend: TestFrontend): string =>
  messagesOf(frontend)
    .at(-1)!
    .parts.map((p) => (p.type === "text" ? p.text : ""))
    .join("");
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);

/** 停着时写好语言设置，一起来就是英文 */
function englishDataDir(): string {
  const dataDir = makeTempDir("ergo-data-");
  const layout = dataDirLayout(dataDir);
  fs.mkdirSync(layout.config, { recursive: true });
  fs.writeFileSync(layout.languageFile, JSON.stringify({ format: 1, language: "en" }));
  return dataDir;
}

describe("英文下守护进程其他目录的话：给用户的英文，给秘书的中文", { timeout: 60_000 }, () => {
  it("提醒卡、快速动作的确认卡和待我处理的标题是英文；建提醒、提议快速动作、查看板的结果交回秘书是中文", async () => {
    const test = await startTestDaemon({
      reuse: { dataDir: englishDataDir(), homeDir: makeTempDir("ergo-home-") },
      secretary: [
        call("create_reminder", { text: "pay rent", inMinutes: 30 }),
        ECHO,
        call("propose_quick_action", { type: "workday_calendar", params: { change: "mark_rest", date: "2030-01-07" } }),
        ECHO,
        call("view_board", {}),
        ECHO,
      ],
    });
    expect((await languageApi.list(test.url)).body).toMatchObject({ language: "en" });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0 });

    // 建提醒：卡上是英文；秘书看到的结果是中文（落到哪天几点也是中文的写法）
    await frontend.sendText("remind me to pay rent in half an hour");
    await waitUntil(() => turnEnds(frontend) >= 1, { describe: () => "等秘书建好提醒" });
    const reminder = cardsOf(frontend).find((c) => c.type === "reminder")!;
    expect(reminder.text).toMatch(/^Reminder: pay rent · /);
    expect(reminder.text).not.toMatch(HAN);
    expect(lastEcho(frontend)).toMatch(/\[toolResult\] create_reminder: 已建好提醒 r-1「pay rent」：.+（现在是 .+）。/);
    expect(lastEcho(frontend)).not.toMatch(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);

    // 快速动作要先确认：确认卡、待我处理的标题和来源是英文；交回秘书的是中文
    await frontend.sendText("I'm off next Monday");
    await waitUntil(() => turnEnds(frontend) >= 2, { describe: () => "等秘书提议快速动作" });
    const action = cardsOf(frontend).find((c) => c.type === "quick_action")!;
    expect(action.text).toMatch(/^Quick action: /);
    expect(action.text).not.toMatch(HAN);
    const item = inboxOf(frontend).find((i) => i.kind === "card" && i.cardId === action.id)!;
    expect(item.title).toBe("Confirm quick action: Change work calendar");
    expect(shown(item.source)).not.toMatch(HAN);
    expect(lastEcho(frontend)).toMatch(/\[toolResult\] propose_quick_action: 等用户确认：[^\n]*2030[^\n]*（推断出来的动作，先问用户）。/);
    expect(lastEcho(frontend)).not.toContain("Mark Jan 7");

    // 查看板：给秘书看的，照旧中文（状态名、分组名也是中文）
    await frontend.sendText("what's on the board");
    await waitUntil(() => turnEnds(frontend) >= 3, { describe: () => "等秘书查看板" });
    expect(lastEcho(frontend)).toMatch(/\[toolResult\] view_board: ## 运营中（1）\n- 提醒 r-1「pay rent」：待触发；/);
  });

  it("设置里的系统提示：各份的名字、说明、占位符的说明是英文", async () => {
    const test = await startTestDaemon({ reuse: { dataDir: englishDataDir(), homeDir: makeTempDir("ergo-home-") } });
    const list = (await systemPromptsApi.list(test.url)).body;
    expect(list.prompts.length).toBeGreaterThan(0);
    for (const p of list.prompts) {
      expect(shown(p.title)).not.toMatch(HAN);
      expect(shown(p.description)).not.toMatch(HAN);
      for (const used of p.usedIn) expect(shown(used)).not.toMatch(HAN);
    }
    const detail = (await systemPromptsApi.get(test.url, list.prompts.find((p) => p.group === "role")!.id)).body;
    for (const placeholder of detail.placeholders) expect(shown(placeholder.description)).not.toMatch(HAN);
  });
});
