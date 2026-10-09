// 秘书聊天：唯一的默认对话入口。秘书只有一条长期主线会话。界面上秘书叫用户起的名字（43 号票，默认"个人助理"，
// 标题里是带底色的名字标签），代码和领域术语照旧叫秘书。
// 56 号票起会话里每一条都能点开详情：宽屏在右栏，窄屏整页滑入（ui/detail/）。
import { useRef } from "react";
import { useStore } from "../app/store.tsx";
import { activityNote, agentActivity, CHANNELS } from "../state/index.ts";
import { AssistantName } from "../ui/assistant-name.tsx";
import { ActivityDot, TopBar } from "../ui/common.tsx";
import { Conversation, type ConversationHandle } from "../ui/conversation/Conversation.tsx";
import { DetailLayout, useDetail } from "../ui/detail/DetailLayout.tsx";
import { StartTaskButton } from "./shared.tsx";

export function SecretaryPage({ wide }: { wide: boolean }) {
  const conversationRef = useRef<ConversationHandle>(null);
  const detail = useDetail(wide, CHANNELS.secretary, conversationRef);
  // 秘书的活动状态（25 号票；秘书的 agent id 和它的会话 id 一样是 secretary）：干活中写着在做什么，等你批准时写着批什么
  const activity = agentActivity(useStore().ui, CHANNELS.secretary);
  return (
    <DetailLayout wide={wide} detail={detail} conversation={CHANNELS.secretary}>
      <div className="chat-col">
        <TopBar title={<AssistantName />} sub={wide ? "主线会话" : undefined}>
          <ActivityDot state={activity.state} note={activityNote(activity)} />
          <StartTaskButton compact />
        </TopBar>
        <Conversation conversation={CHANNELS.secretary} mode="secretary" onDetail={detail.open} ref={conversationRef} />
      </div>
    </DetailLayout>
  );
}
