// 调用记忆在对话里的那一行：收成一行（ui/conversation/rows.tsx 的 ChatLineView），标题"记忆"、记忆的图标，
// 一句"回忆了 N 条记忆"；取到第一条记忆的标题时换成"回忆了 N 条：<标题>"（按素材 id 现取，和"这次用到的记忆"同一个接口，
// 不缓存：忘掉、彻底删除之后再画就没有标题）。整行点开"这次用到的记忆"（RecallDetail.tsx）。没找到的、旧记录认不出条数的淡一点。
// 挪进记忆插件，登记成会话条目 recall 的画法（plugins/memory/plugin.tsx）；记忆插件停用时这一条换成占位（核心的 maskUnavailable）。
import { useEffect, useState } from "react";
import { useOptionalStore } from "../../app/store.tsx";
import { type ChatItem, type ChatLine, chatLook, recallLineTitled, recallTitle } from "../../state/index.ts";
import type { ChatItemActions } from "../../ui/conversation/ChatItemView.tsx";
import { LineItem } from "../../ui/conversation/ChatItemView.tsx";

/** 第一条记忆的标题：按素材 id 现取；没有素材 id、还在取、取不到（删了、出错）、不在页面里（没有接口）是 undefined */
function useRecallTitle(materialId: string | undefined): string | undefined {
  const http = useOptionalStore()?.http;
  const [got, setGot] = useState<{ id: string; title: string | undefined }>();
  useEffect(() => {
    if (materialId === undefined || http === undefined) return;
    const abort = new AbortController();
    http.material(materialId, abort.signal).then(
      (view) => {
        if (!abort.signal.aborted) setGot({ id: materialId, title: view ? recallTitle(view) : undefined });
      },
      () => {
        if (!abort.signal.aborted) setGot({ id: materialId, title: undefined });
      },
    );
    return () => abort.abort();
  }, [http, materialId]);
  return got !== undefined && got.id === materialId ? got.title : undefined;
}

/** 会话条目 recall 在对话层里：一行；点整行看这次用到的记忆 */
export function RecallItem({ item, actions }: { item: ChatItem; actions: ChatItemActions }) {
  const look = chatLook(item);
  const line = look.form === "line" && look.kind === "recall" ? look : undefined;
  const title = useRecallTitle(line?.recallFirst);
  if (!line || item.kind !== "recall") return null;
  const { onDetail } = actions;
  const titled: ChatLine = title === undefined ? line : { ...line, text: recallLineTitled(item.recall, title) };
  return <LineItem look={titled} onOpen={line.open && onDetail ? () => onDetail(item.id) : undefined} kind="recall" />;
}
