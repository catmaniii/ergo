/**
 * 任务详情打开时把这个任务开始以来的会话历史取齐（60 号票）：会话频道第一次只补发最近 50 条（09 号票），更早的要往上翻；
 * 流程的偏差个数、计划外动作、阶段详情的尝试记录和出过的状况、"回到会话里这一段"都按整段会话算，
 * 取齐了数字才不随往上翻变。一页 200 条地往前取，直到手里最早的一条比 since 早、或者翻到头（状态层的 historyNeededSince 判断）：
 * 每取回一页，手里最早那条的序号变了，就接着取下一页。取失败了就停下（往上翻照常能取），不反复重试
 */
import { useEffect, useState } from "react";
import { type ConversationId, historyNeededSince, olderHistory } from "../state/index.ts";
import { useStore } from "./store.tsx";

/** 任务详情取历史时一页取多少条（服务端最多 200） */
const TASK_HISTORY_PAGE = 200;

/** since 不给（普通任务）就不取 */
export function useTaskHistory(conversation: ConversationId, since: string | undefined): void {
  const { ui, loadOlder } = useStore();
  const needed = since !== undefined && historyNeededSince(ui, conversation, since);
  // 手里最早那条的序号：取回一页它就变，据此接着取
  const { before } = olderHistory(ui, conversation);
  const [failed, setFailed] = useState<ConversationId>();
  useEffect(() => {
    if (!needed || before === undefined || failed === conversation) return;
    let gone = false;
    loadOlder(conversation, TASK_HISTORY_PAGE).catch(() => {
      if (!gone) setFailed(conversation);
    });
    return () => {
      gone = true;
    };
  }, [needed, before, failed, conversation, loadOlder]);
}
