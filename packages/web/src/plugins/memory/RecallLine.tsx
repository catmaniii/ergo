// 调用记忆（187 号票）在对话里的那一行：一行"回忆了 N 条记忆 ›"，样子照工具调用那一行（.tool-sum：左边一道、小字、整行可点），
// 圆点换成记忆的图标；整行点开"这次用到的记忆"（RecallDetail.tsx）。没找到的、旧记录认不出条数的淡一点。
// 193 号票：挪进记忆插件，登记成会话条目 recall 的画法（plugins/memory/plugin.tsx）；记忆插件停用时这一条换成占位（核心的 maskUnavailable）。
import { type ChatItem, chatLook, type ChatLook } from "../../state/index.ts";
import type { ChatItemActions } from "../../ui/conversation/ChatItemView.tsx";
import { Icon } from "../../ui/icons.tsx";

export function RecallLine({ look, onOpen }: { look: Extract<ChatLook, { form: "recall_line" }>; onOpen?: (() => void) | undefined }) {
  return (
    <button type="button" className={`tool-sum recall-line${look.found ? "" : " recall-none"}`} onClick={onOpen} disabled={!onOpen}>
      <span className="recall-icon">
        <Icon name="layers" />
      </span>
      <span className="tool-sum-text">{look.text}</span>
      {onOpen && <span className="tool-more">›</span>}
    </button>
  );
}

/** 会话条目 recall 在对话层里：一行，照工具调用那一行；点整行看这次用到的记忆 */
export function RecallItem({ item, actions }: { item: ChatItem; actions: ChatItemActions }) {
  const look = chatLook(item);
  if (look.form !== "recall_line") return null;
  const { onDetail } = actions;
  return (
    <div className="msg assistant msg-tools msg-recall">
      {/* 275 号票：和工具调用那一行一样放在一格里（和"在想什么"那条同一列、同样的宽度上限） */}
      <div className="msg-part part-line">
        <RecallLine look={look} onOpen={look.open && onDetail ? () => onDetail(item.id) : undefined} />
      </div>
    </div>
  );
}
