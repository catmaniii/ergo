/**
 * 从别处跳过来要定位的那一条还不在手里（158 号票：设置里素材出处的那条消息，常常在更早的历史里；105 号票待办里"去看看 ›"的卡、调用同样受益）：
 * 会话频道第一次只补发最近 50 条（09 号票），这里一页 200 条地往前取，直到它出现、翻到头、取失败，或者取满 REVEAL_HISTORY_MAX_PAGES 页
 * （再早的不自动取：一下子铺几千条进会话太重，用户自己往上翻照样能取）。每取回一页手里最早那条的序号变了，就接着取下一页
 * （同 useTaskHistory 的写法）。同一个地址只取这一轮
 */
import { useEffect, useRef, useState } from "react";
import { type ConversationId, olderHistory } from "../state/index.ts";
import { useStore } from "./store.tsx";

/** 一页取多少条（服务端最多 200） */
const REVEAL_HISTORY_PAGE = 200;
/** 最多自动往前取几页 */
export const REVEAL_HISTORY_MAX_PAGES = 10;

/** found：要定位的那一条已经在会话的条目里了 */
export function useRevealHistory(conversation: ConversationId, revealAt: string | undefined, found: boolean): void {
  const { ui, loadOlder } = useStore();
  const { canLoadOlder, before } = olderHistory(ui, conversation);
  const key = `${conversation}#${revealAt ?? ""}`;
  const [failed, setFailed] = useState<string>();
  // 这个地址已经取了几页
  const tries = useRef({ key: "", pages: 0 });
  useEffect(() => {
    if (!revealAt || found || !canLoadOlder || before === undefined || failed === key) return;
    if (tries.current.key !== key) tries.current = { key, pages: 0 };
    if (tries.current.pages >= REVEAL_HISTORY_MAX_PAGES) return;
    tries.current.pages += 1;
    let gone = false;
    loadOlder(conversation, REVEAL_HISTORY_PAGE).catch(() => {
      if (!gone) setFailed(key);
    });
    return () => {
      gone = true;
    };
  }, [revealAt, found, canLoadOlder, before, failed, key, conversation, loadOlder]);
}
