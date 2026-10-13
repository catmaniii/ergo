// 秘书聊天：唯一的默认对话入口。秘书只有一条长期主线会话。界面上秘书叫用户起的名字（43 号票，默认"二狗"，89 号票起；
// 原来是"个人助理"），左上角的标题写"个人秘书：<名字>"（89 号票，名字是带底色的名字标签，ui/secretary-title.tsx），
// 代码和领域术语照旧叫秘书。
// 56 号票起会话里每一条都能点开详情：宽屏在右栏，窄屏整页滑入（ui/detail/）。
// 54 号票起会话一镜到底缩放：标题栏的 ▤ / 💬 一直显示（照 AgentSense，秘书主线不是任务会话）。
// 107 号票：输入框上面的"等你处理"栏列出秘书对话里来的待办事项（快速动作卡、审批卡、中断不确定……）。
import { useStore } from "../app/store.tsx";
import { activityNote, agentActivity, CHANNELS, type InboxPlace } from "../state/index.ts";
import { useAssistantName } from "../ui/assistant-name.tsx";
import { ActivityDot, TopBar } from "../ui/common.tsx";
import { Conversation, useConversationPane, ZoomToggle } from "../ui/conversation/Conversation.tsx";
import { DetailLayout } from "../ui/detail/DetailLayout.tsx";
import { SecretaryTitle } from "../ui/secretary-title.tsx";
import { StartTaskButton } from "./shared.tsx";

/** "等你处理"栏认的是秘书会话（107 号票） */
const SECRETARY_INBOX: InboxPlace = { kind: "secretary" };

/** at：从待办跳过来要定位的那一条（105 号票） */
export function SecretaryPage({ wide, at }: { wide: boolean; at?: string | undefined }) {
  const [conversationRef, detail] = useConversationPane(wide, CHANNELS.secretary);
  // 秘书的活动状态（25 号票；秘书的 agent id 和它的会话 id 一样是 secretary）：干活中写着在做什么，等你批准时写着批什么
  const activity = agentActivity(useStore().ui, CHANNELS.secretary);
  const name = useAssistantName();
  return (
    <DetailLayout wide={wide} detail={detail} conversation={CHANNELS.secretary}>
      <div className="chat-col">
        <TopBar title={<SecretaryTitle name={name} />} sub={wide ? "主线会话" : undefined}>
          <ActivityDot state={activity.state} note={activityNote(activity)} />
          <StartTaskButton compact />
          <ZoomToggle handle={conversationRef} />
        </TopBar>
        <Conversation conversation={CHANNELS.secretary} mode="secretary" wide={wide} onDetail={detail.open} ref={conversationRef} revealAt={at} inbox={SECRETARY_INBOX} />
      </div>
    </DetailLayout>
  );
}
