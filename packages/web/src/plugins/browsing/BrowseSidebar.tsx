/**
 * 浏览侧边栏（147 号票）：秘书本人陪着浏览器。内容就是秘书的主会话——和"秘书"页签同一个会话、同一套会话组件（消息、卡片、
 * 输入框的"＋"、停止、排队、放大都一样），在这里发的话秘书页签里也看得到，反过来也一样；只是这里发的每条消息带上这时的网页上下文
 * （app/browse-side.ts 的 context），秘书这一轮能读网页、操作选中的框、开网址。
 * 没有标题栏（2026-10-18 用户：侧边栏空间有限）：顶上就是"现在在看"：网页标题加域名，最右边"收起"（›，手机整屏时只有它和返回手势能收）；
 * 有选中的框时再一行"选中：<框的说明>"，右边 × 取消选中。
 * 它画在 App 另开的一个 Web 组件里（二狗网页的侧边栏模式 ?ergo=side，SideApp.tsx），App 把它摆在原生网页上面：宽屏盖住网页右边
 * 400 宽的一块，窄屏整屏盖住（返回手势由 App 收起）。"收起"、×、发消息带的网页上下文经 control（side-remote.ts 的 RemoteSide：
 * 经 App 转给"浏览"页那一份 BrowseSide）。
 * 会话里的每一条照样能点开详情（2026-10-19 用户：工具调用那一条在侧边栏里点不开）：照窄屏，详情整页滑入盖住侧边栏，‹ 退回
 * （ui/detail/DetailLayout.tsx；挂在侧边栏模式外框的 .dp-host 上，App.tsx）。
 */
import { type BrowseSideView, type SidebarControl, watchingText } from "./browse-side.ts";
import { useSecretaryReading } from "../../app/secretary-unread.ts";
import { CHANNELS, type InboxPlace, selectedFieldText, t } from "../../state/index.ts";
import { useAssistantName } from "../../ui/assistant-name.tsx";
import { Conversation, useConversationPane } from "../../ui/conversation/Conversation.tsx";
import { DetailLayout } from "../../ui/detail/DetailLayout.tsx";
import { Icon } from "../../ui/icons.tsx";
import { MissedVoices } from "../../ui/missed-voices.tsx";

/** "等你处理"栏认的是秘书会话（和秘书页一样） */
const SECRETARY_INBOX: InboxPlace = { kind: "secretary" };

export function BrowseSidebar({ control, view }: { control: SidebarControl; view: BrowseSideView }) {
  const [conversationRef, detail] = useConversationPane(false, CHANNELS.secretary);
  const name = useAssistantName();
  const reading = useSecretaryReading();
  const { bar } = reading;
  const watching = watchingText(view.page);
  const close = () => control.setOpen(false);
  return (
    <DetailLayout wide={false} detail={detail} conversation={CHANNELS.secretary}>
      <div className="browse-side" aria-label={t("pages.browseSidebar.label", { name })}>
        <div className="browse-side-watch">
          <div className="browse-side-watch-row">
            <span className="browse-side-watch-label">{t("pages.browseSidebar.watching")}</span>
            {watching ? (
              <span className="browse-side-watch-page" title={view.page?.url}>
                {watching.title}
                {watching.title !== watching.host && <small> · {watching.host}</small>}
              </span>
            ) : (
              <span className="browse-side-watch-page muted">{t("pages.browseSidebar.noPage")}</span>
            )}
            <button type="button" className="icon-btn browse-side-close" onClick={close} aria-label={t("pages.browseSidebar.close")} title={t("pages.browseSidebar.closeShort")}>
              <Icon name="forward" />
            </button>
          </div>
          {view.selected && (
            <div className="browse-side-watch-row">
              <span className="browse-side-watch-label">{t("pages.browseSidebar.selected")}</span>
              <span className="browse-side-watch-field">{selectedFieldText(view.selected)}</span>
              <button type="button" className="icon-btn browse-side-unselect" onClick={() => control.clearSelection()} aria-label={t("pages.browseSidebar.unselect")} title={t("pages.browseSidebar.unselect")}>
                <Icon name="cross" />
              </button>
            </div>
          )}
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
          browsing={() => control.context()}
          aboveComposer={bar && <MissedVoices bar={bar} onPlay={reading.play} onLocate={bar.firstItemId === undefined ? undefined : () => conversationRef.current?.reveal(bar.firstItemId!)} />}
        />
      </div>
    </DetailLayout>
  );
}
