// 把前端状态层接到 React：连接推来的输入交给 reduce，界面从这里读状态、发请求。
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { type CardView, cardView, type ConversationItem, conversationView, initialUiState, type MessagePart, reduce, resumeCursors, type UiState } from "../state/index.ts";
import { nowIso } from "../model/labels.ts";
import type { Connection } from "./connection.ts";

interface Store {
  ui: UiState;
  sendMessage(conversation: string, parts: MessagePart[]): void;
  /** 点卡片上的按钮；note 是动作附带的说明 */
  cardAction(cardId: string, action: string, note?: string): void;
}

const StoreContext = createContext<Store | null>(null);

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function StoreProvider({ connection, children }: { connection: Connection; children: ReactNode }) {
  const [ui, dispatch] = useReducer(reduce, initialUiState);
  // 事件处理函数里要读最新的状态（比如卡片的当前版本）
  const uiRef = useRef(ui);
  useEffect(() => {
    uiRef.current = ui;
  }, [ui]);

  // 连上就收事件；断开重连时带上每个频道最后收到的序号，重复补发的事件由状态层丢掉
  useEffect(() => connection.connect(resumeCursors(uiRef.current), dispatch), [connection]);

  const sendMessage = useCallback(
    (conversation: string, parts: MessagePart[]) => {
      const idempotencyKey = newKey();
      dispatch({ kind: "send_message", conversation, idempotencyKey, parts, time: nowIso() });
      connection.sendMessage({ conversation, idempotencyKey, parts });
    },
    [connection],
  );

  const cardAction = useCallback(
    (cardId: string, action: string, note?: string) => {
      const view = cardView(uiRef.current, cardId);
      if (!view) return;
      const idempotencyKey = newKey();
      dispatch({ kind: "card_action", cardId, action, idempotencyKey });
      connection.cardAction({ cardId, action, expectedVersion: view.card.version, idempotencyKey, note });
    },
    [connection],
  );

  const store = useMemo(() => ({ ui, sendMessage, cardAction }), [ui, sendMessage, cardAction]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore 必须在 StoreProvider 里用");
  return s;
}

export function useConversation(conversation: string): ConversationItem[] {
  const { ui } = useStore();
  return useMemo(() => conversationView(ui, conversation), [ui, conversation]);
}

export function useCard(cardId: string): CardView | undefined {
  return cardView(useStore().ui, cardId);
}
