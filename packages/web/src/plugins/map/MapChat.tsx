// 地图页右边的二狗聊天窗（444）：和"浏览"右边的侧边栏是同一个东西——秘书本人，秘书的主会话（和"秘书"页签同一个会话、同一套
// 会话组件：消息、卡片、输入框的"＋"、停止、排队都一样，在这里发的话秘书页签里也看得到）；只是这里发的每条消息带上这时的地图上下文
// （中心、缩放、底图、看哪一天的足迹、哪张卡片，MapContext），秘书据此回答、用 show_on_map 画给你看。
// 样子照浏览侧边栏（同一组样式 .browse-side*）：没有标题栏，顶上一行"现在在看：地图 · ……"，最右边"收起"（›）。
// 宽屏挤压地图（MapPage 摆：地图 | 分隔条 | 聊天窗，宽度这台设备记住）；窄屏整屏盖住地图页，收起（›、系统返回）回到地图。
// 开着时秘书会话算在看（顶上不再提醒秘书说完了一轮，app/secretary-watching.ts）。
// 会话里的每一条照样能点开详情：照窄屏，详情整页滑入（ui/detail/DetailLayout.tsx）。
import { useEffect } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { setSecretaryWatching } from "../../app/secretary-watching.ts";
import { useSecretaryReading } from "../../app/secretary-unread.ts";
import { CHANNELS, type InboxPlace, type MapContext, t } from "../../state/index.ts";
import { useAssistantName } from "../../ui/assistant-name.tsx";
import { Conversation, useConversationPane } from "../../ui/conversation/Conversation.tsx";
import { DetailLayout } from "../../ui/detail/DetailLayout.tsx";
import { Icon } from "../../ui/icons.tsx";
import { MissedVoices } from "../../ui/missed-voices.tsx";

/** "等你处理"栏认的是秘书会话（和秘书页一样） */
const SECRETARY_INBOX: InboxPlace = { kind: "secretary" };

export function MapChat({ watching, context, cover, onClose }: { watching: string; context: () => MapContext; cover: boolean; onClose(): void }) {
  const [conversationRef, detail] = useConversationPane(false, CHANNELS.secretary);
  const name = useAssistantName();
  const reading = useSecretaryReading();
  const { bar } = reading;
  // 整屏盖住时：系统返回先收起它
  useBackLayer("overlay", cover, onClose);
  // 开着时秘书会话算在看
  useEffect(() => {
    setSecretaryWatching("map-chat", true);
    return () => setSecretaryWatching("map-chat", false);
  }, []);
  return (
    <DetailLayout wide={false} detail={detail} conversation={CHANNELS.secretary}>
      <div className="browse-side map-chat-side" aria-label={t("ui.plugins.map.chat.label", { name })}>
        <div className="browse-side-watch">
          <div className="browse-side-watch-row">
            <span className="browse-side-watch-label">{t("ui.plugins.map.chat.watching")}</span>
            <span className="browse-side-watch-page" title={watching}>
              {watching}
            </span>
            <button type="button" className="icon-btn browse-side-close map-chat-close" onClick={onClose} aria-label={t("ui.plugins.map.chat.close")} title={t("ui.plugins.map.chat.closeShort")}>
              <Icon name="forward" />
            </button>
          </div>
        </div>
        <Conversation
          conversation={CHANNELS.secretary}
          mode="secretary"
          wide={false}
          onDetail={detail.open}
          showDetail={detail.show}
          ref={conversationRef}
          inbox={SECRETARY_INBOX}
          onSeen={reading.onSeen}
          map={context}
          aboveComposer={bar && <MissedVoices bar={bar} onPlay={reading.play} onLocate={bar.firstItemId === undefined ? undefined : () => conversationRef.current?.reveal(bar.firstItemId!)} />}
        />
      </div>
    </DetailLayout>
  );
}

/** 标题栏最右边的聊天窗开关（和"浏览"顶上那一栏的二狗按钮一样：二狗的图标，开着时是按下的样子） */
export function MapChatToggle({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const name = useAssistantName();
  const label = open ? t("ui.plugins.map.chat.close") : t("ui.plugins.map.chat.open", { name });
  return (
    <button type="button" className={`icon-btn browse-side-toggle map-chat-toggle${open ? " on" : ""}`} onClick={onToggle} aria-pressed={open} aria-label={label} title={label}>
      <Icon name="ergo" />
    </button>
  );
}
