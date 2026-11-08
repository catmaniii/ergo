// 秘书聊天：唯一的默认对话入口。秘书只有一条长期主线会话。界面上秘书叫用户起的名字（默认"二狗"，
// 原来是"个人助理"），左上角的标题写"个人秘书：<名字>"（名字是带底色的名字标签，ui/secretary-title.tsx），
// 代码和领域术语照旧叫秘书。
// 会话里每一条都能点开详情：宽屏在右栏，窄屏整页滑入（ui/detail/）。
// 会话一镜到底缩放：标题栏的 ▤ / 💬 一直显示（秘书主线不是任务会话）。
// 输入框上面的"等你处理"栏列出秘书对话里来的待办事项（快速动作卡、审批卡、中断不确定……）。
// 看到哪了报成已读位置（"秘书"页签的红点、秘书新消息的提醒跟着它，几台设备同步）；不在时念的语音在输入框上面一条小栏
// （app/secretary-unread.ts 的 useSecretaryReading，小栏的样子在 ui/missed-voices.tsx），和"等你处理"栏上下排着。
// 模型的 key 还没配时输入框上面再一条"还没配模型……去配置"（ui/model-key-notice.tsx），排在"不在时念的语音"上面。
// 标题上的"等你……"能点，跳到要处理的那张卡（ActivityDot 的 jump）。
import { useSecretaryReading } from "../app/secretary-unread.ts";
import { useStore } from "../app/store.tsx";
import { activityJump, activityNote, agentActivity, CHANNELS, type InboxPlace, secretaryPageSub } from "../state/index.ts";
import { useAssistantName } from "../ui/assistant-name.tsx";
import { AgentSettingsButton } from "../ui/agent-settings.tsx";
import { ActivityDot, TopBar } from "../ui/common.tsx";
import { Conversation, useConversationPane, ZoomToggle } from "../ui/conversation/Conversation.tsx";
import { DetailLayout } from "../ui/detail/DetailLayout.tsx";
import { MissedVoices } from "../ui/missed-voices.tsx";
import { ModelKeyNotice, useModelKey } from "../ui/model-key-notice.tsx";
import { SecretaryTitle } from "../ui/secretary-title.tsx";
import { SecretaryPhoneMenu } from "./SecretaryPhoneMenu.tsx";
import { StartTaskButton } from "./shared.tsx";

/** "等你处理"栏认的是秘书会话 */
const SECRETARY_INBOX: InboxPlace = { kind: "secretary" };

/** at：从待办跳过来要定位的那一条 */
export function SecretaryPage({ wide, at }: { wide: boolean; at?: string | undefined }) {
  const [conversationRef, detail] = useConversationPane(wide, CHANNELS.secretary);
  // 秘书的活动状态（秘书的 agent id 和它的会话 id 一样是 secretary）：干活中写着在做什么，等你批准时写着批什么
  const { ui, quoteCard } = useStore();
  const activity = agentActivity(ui, CHANNELS.secretary);
  const jump = activityJump(ui, CHANNELS.secretary);
  const name = useAssistantName();
  const reading = useSecretaryReading();
  const { bar } = reading;
  const modelKey = useModelKey();
  return (
    // 卡片详情里的"引用"：引用到秘书的输入框
    <DetailLayout wide={wide} detail={detail} conversation={CHANNELS.secretary} onQuote={(cardId) => quoteCard(CHANNELS.secretary, cardId)}>
      <div className="chat-col">
        {/* 副标题：设了"我的名字"是"<名字>的主线会话"，没设照旧（宽屏写"主线会话"，窄屏没有） */}
        {/* 手机竖屏：标题栏分两行，第二行是副标题和活动状态，按钮都收进 ⋯ */}
        <TopBar
          twoLine={!wide}
          title={<SecretaryTitle name={name} />}
          sub={
            wide ? (
              secretaryPageSub(ui, wide)
            ) : (
              <>
                {secretaryPageSub(ui, wide) !== undefined && <span className="secretary-sub-text">{secretaryPageSub(ui, wide)}</span>}
                <ActivityDot state={activity.state} note={activityNote(activity)} jump={jump} />
              </>
            )
          }
        >
          {!wide && <SecretaryPhoneMenu agentId={CHANNELS.secretary} handle={conversationRef} />}
          {wide && <ActivityDot state={activity.state} note={activityNote(activity)} jump={jump} />}
          {wide && <StartTaskButton compact />}
          {wide && <ZoomToggle handle={conversationRef} />}
          {/* 这个 agent 的 ⚙：单独的提示词、清空当前对话、上下文用量（秘书的 agent id 和它的会话 id 一样） */}
          {wide && <AgentSettingsButton agentId={CHANNELS.secretary} wide={wide} />}
        </TopBar>
        <Conversation
          conversation={CHANNELS.secretary}
          mode="secretary"
          wide={wide}
          onDetail={detail.open}
          showDetail={detail.show}
          ref={conversationRef}
          revealAt={at}
          inbox={SECRETARY_INBOX}
          onSeen={reading.onSeen}
          aboveComposer={
            <>
              <ModelKeyNotice view={modelKey} />
              {bar && <MissedVoices bar={bar} onPlay={reading.play} onLocate={bar.firstItemId === undefined ? undefined : () => conversationRef.current?.reveal(bar.firstItemId!)} />}
            </>
          }
        />
      </div>
    </DetailLayout>
  );
}
