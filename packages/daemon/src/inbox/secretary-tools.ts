// 秘书和待我处理（规格第 7 节，22 号票）：用户问"有什么要我处理的"时，秘书能列出待我处理里还没处理的事项、加以解释，
// 并把同一张卡放进聊天（聊天里只放卡片引用：同一 id、同一状态，在哪里点按钮都是同一张卡）。
// - 秘书不主动转述待我处理：新增事项不进秘书的模型输入（看板变化消息里也没有），只有用户问了、它调用工具才看到；
// - 秘书不能替用户在卡上做决定：这里没有、也不能有任何对卡片做动作的工具（卡片动作只接受来自前端的请求）；
// - 项目内部的事项（64 号票：建的时候标上 internal，isProjectInternal）秘书看不到细节：列出来只有一行"项目「X」内部的事项"
//   （不给标题、来源、卡片和正文），它们的卡片也不能放进秘书的聊天（对秘书来说待我处理里没有这些卡片）。
// 两个工具都不改卡片、不改待我处理，不落入任何关注类别；"放进聊天"每调一次往会话里多追加一条卡片引用（不是幂等的）。
// 事项的先后、紧急度的中文名用共享协议包的（compareInboxItems、URGENCY_LABEL），和 Web 的待我处理页一致。
import { type Card, compareInboxItems, type InboxItem, internalScopeLabel, isInboxItemProcessed, isProjectInternal, Type, URGENCY_LABEL } from "@ergou/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { oneLine } from "../util/text.ts";
import type { InboxService } from "./inbox.ts";
import { INBOX_TOOL } from "./tool-names.ts";

/** 一次最多放几张卡进聊天 */
const MAX_SHOWN = 10;

const NL = "\n";

/** 还没处理的事项（没归档的），按待我处理页的顺序（置顶的在前，然后按紧急度，同一档里新的在前） */
export function openInboxItems(inbox: InboxService, cards: CardService): InboxItem[] {
  return inbox
    .list()
    .filter((item) => !item.archived && !isInboxItemProcessed(item, item.kind === "card" ? cards.get(item.cardId)?.status : undefined))
    .toSorted(compareInboxItems);
}

/** 项目内部的事项（64 号票）：只说是哪个项目内部的、紧急度和时间，不给标题、来源、卡片和正文 */
const internalLine = (item: InboxItem, projectName: string) =>
  `- 事项 ${item.id}：${internalScopeLabel(projectName)}的事项（细节只在项目里看得到，用户在待我处理里直接处理；${URGENCY_LABEL[item.urgency]}；${item.createdAt}${item.read ? "" : "；未读"}）`;

/** 一条事项写成一行：编号、标题、紧急度、来源、时间，卡片事项带卡片编号和卡上的文字，通知带说明和能选的处理 */
function itemLine(item: InboxItem, cardOf: (cardId: string) => Card | undefined): string {
  if (item.internal) return internalLine(item, item.internal.projectName);
  const head = `- 事项 ${item.id}：${item.title}（${URGENCY_LABEL[item.urgency]}；来源：${item.source}；${item.createdAt}${item.read ? "" : "；未读"}）`;
  if (item.kind === "card") {
    const card = cardOf(item.cardId);
    return `${head}；卡片 ${item.cardId}${card ? `：${oneLine(card.text, 200)}` : ""}`;
  }
  const related = item.cardId ? `；相关的卡片 ${item.cardId}` : "";
  return `${head}；通知${item.body ? `：${oneLine(item.body, 200)}` : ""}（用户可选：${item.actions.join("、")}）${related}`;
}

/** 这张卡能放进秘书的聊天：待我处理里有它、它的事项都不是项目内部的（64 号票：对秘书来说待我处理里没有项目内部的卡片） */
function showable(id: string, inbox: InboxService, cards: CardService): boolean {
  const items = inbox.itemsForCard(id);
  return items.length > 0 && !items.some(isProjectInternal) && cards.get(id) !== undefined;
}

export function inboxTools(inbox: InboxService, cards: CardService): HostTool[] {
  return [
    defineHostTool({
      name: INBOX_TOOL.list,
      title: "列出待我处理",
      description: `列出用户的待我处理里还没处理的事项（置顶的在前，然后按紧急度）。只在用户问起时用，不要主动转述。要让用户在聊天里直接处理某张卡，用 ${INBOX_TOOL.show} 把它放进聊天；你不能替用户在卡上做决定。只读。`,
      parameters: Type.Object({}, { additionalProperties: false }),
      readOnlyOrIdempotent: true,
      nature: "look",
      run: () => {
        const items = openInboxItems(inbox, cards);
        if (items.length === 0) return { text: "待我处理里没有还没处理的事项。" };
        return { text: [`待我处理里还没处理的事项（${items.length} 项）：`, ...items.map((item) => itemLine(item, (id) => cards.get(id)))].join(NL) };
      },
    }),
    defineHostTool({
      name: INBOX_TOOL.show,
      title: "把卡片放进聊天",
      description: `把待我处理里的卡片放进聊天（卡片编号从 ${INBOX_TOOL.list} 的结果里抄）：聊天里显示的就是同一张卡，用户在哪里点按钮都一样。你不能替用户在卡上做决定。`,
      parameters: Type.Object(
        { cardIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_SHOWN, description: "卡片编号（c-…）" }) },
        { additionalProperties: false },
      ),
      // 不改卡片、不改待我处理，但每调一次聊天里多一条卡片引用：不是幂等的
      readOnlyOrIdempotent: false,
      run: ({ cardIds }) => {
        const wanted = [...new Set(cardIds)];
        const missing = wanted.filter((id) => !showable(id, inbox, cards));
        if (missing.length > 0) return { text: `待我处理里没有这些卡片：${missing.join("、")}（卡片编号从 ${INBOX_TOOL.list} 的结果里抄）`, isError: true };
        return { text: `已放进聊天：${wanted.map((id) => `${id}（${oneLine(cards.get(id)!.text, 60)}）`).join("、")}`, cardIds: wanted };
      },
    }),
  ];
}
