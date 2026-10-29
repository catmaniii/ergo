// 记忆管理员（242 号票，#/more/memory/curator）：每晚 03:00 由它整理记忆的那个 agent（243 号票起按需拉起：看历史不用它在跑，
// 在这页发消息才把它拉起来，闲置退出）。
// 285 号票起是整页对话：记忆页顶上"和记忆管理员聊"那张卡点进来，宽屏也不留左边的栏目，‹ 回记忆页；标题写"记忆管理员"。
// - 上面是它的历史消息和每一夜的整理日记（就是普通的会话消息：03:00 的那条唤醒是系统消息，日记是它自己的回复）；
// - 下面照常打字跟它说话（发一句、它回一句）：深聊一条结论的来龙去脉、让它改状态、忘掉、别推断都走这里；输入框写"和记忆管理员说…"
//   （285 号票：这页的会话按秘书的样子画，以前传进来的占位没用上、写的是"和<名字>说…"）；
// - 输入框上面一行了解你访谈（285 号票，用户 2026-10-26 定的）：没在聊时写聊过几个、下次聊什么和"开始访谈"（POST /api/memory/interview，
//   已经开着就是那一次；和 /interview 斜杠命令开的同一次）；正在聊时写主题和怎么停，不再给按钮。会话里来了新消息就重取一次
//   （管理员收尾了、开了一次，这一行跟着变）；取不到就不画这一行；
// - 点标题栏的 ⚙ 能改它单独的提示词、清空对话、看上下文用量（和秘书、维护者同一个面板；模型那行先跟随秘书的）；
// - 宽屏标题栏的副标题是最近一次整理（哪一夜、跑成什么样、管理员自己额外花了几次模型调用）。
// 它和秘书的"问记忆"分工：轻问题走秘书的 ask_memory，深聊/动手在这里（秘书会把话转过来）。
// 数据都来自会话频道（维护者那一套）、GET /api/memory/summary 和 GET /api/memory/interview，这里只画。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { retryLoad } from "../../app/retry-load.ts";
import { type InterviewStatusView, MEMORY_CURATOR_AGENT_ID, MEMORY_CURATOR_CONVERSATION, memoryCuratorNightLine, memoryInterviewBar, type MemorySummaryView, t } from "../../state/index.ts";
import { AgentSettingsButton } from "../../ui/agent-settings.tsx";
import { TopBar } from "../../ui/common.tsx";
import { Conversation, useConversationPane } from "../../ui/conversation/Conversation.tsx";
import { DetailLayout } from "../../ui/detail/DetailLayout.tsx";
import { useToast } from "../../ui/toast.tsx";

/**
 * 记忆管理员的整页对话：onBack 回记忆页。会话自己在分页里往上取更早的消息，不需要外面再包一层滚动。
 * wide 只影响标题栏（⚙ 的面板形态、副标题"最近一次整理"只在宽屏写）。
 * 2026-10-23 用户反馈："回忆了多少条记忆和 Agent 的想法，右边的箭头被挡住了，整条点了也没有展开"——
 * 这一页原来没接详情（`Conversation` 没给 `onDetail`），那些行就都是灰的、连行尾的 › 都不画。现在照秘书页那套
 * `useConversationPane` + `DetailLayout` 接上：点一行照常开右边的详情（回收了的记忆、调用的参数和完整返回都在里面）。
 */
export function MemoryCuratorPage({ wide, onBack }: { wide: boolean; onBack: (() => void) | undefined }) {
  const { http, ui, watchChannels } = useStore();
  const [conversationRef, detail] = useConversationPane(wide, MEMORY_CURATOR_CONVERSATION);
  // 这个会话的频道（和真实的前端一样订阅；历史由连接按频道补发）
  useEffect(() => watchChannels([MEMORY_CURATOR_CONVERSATION]), [watchChannels]);
  const [summary, setSummary] = useState<MemorySummaryView>();
  useEffect(() => {
    let live = true;
    retryLoad(() => http.memorySummary())
      .then((view) => live && setSummary(view))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [http]);
  const note = summary?.ready === true ? memoryCuratorNightLine(summary.lastNight) : undefined;
  return (
    <DetailLayout wide={wide} detail={detail} conversation={MEMORY_CURATOR_CONVERSATION}>
      <div className="chat-col">
        <TopBar title={t("pages.memory.curator")} onBack={onBack} sub={wide ? note : undefined}>
          <AgentSettingsButton agentId={MEMORY_CURATOR_AGENT_ID} wide={wide} />
        </TopBar>
        <Conversation
          ref={conversationRef}
          conversation={MEMORY_CURATOR_CONVERSATION}
          mode="secretary"
          wide={wide}
          onDetail={detail.open}
          showDetail={detail.show}
          composerPlaceholder={t("pages.memory.curatorPlaceholder")}
          aboveComposer={<InterviewBar messages={ui.conversations[MEMORY_CURATOR_CONVERSATION]?.messages.length ?? 0} />}
        />
      </div>
    </DetailLayout>
  );
}

/** 输入框上面那一行了解你访谈：messages 是会话里现在有几条（变了就重取一次） */
function InterviewBar({ messages }: { messages: number }) {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<InterviewStatusView>();
  const [opening, setOpening] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- messages 只用来在会话里来了新消息时重取
  useEffect(() => {
    let live = true;
    http
      .memoryInterview()
      .then((next) => live && setView(next))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [http, messages]);
  if (view === undefined) return null;
  const bar = memoryInterviewBar(view);
  /** 开一次访谈（已经开着就是那一次）：管理员在这页上问第一个问题 */
  const start = () => {
    setOpening(true);
    http
      .startInterview()
      .then(() => http.memoryInterview())
      .then(setView)
      .catch((err: unknown) => toast(t("pages.memory.interviewFailed", { reason: err instanceof Error ? err.message : String(err) })))
      .finally(() => setOpening(false));
  };
  return (
    <div className="mem-interview-bar" role="status">
      <span className="mem-interview-text">
        <b>{bar.title}</b>
        <span className="muted">{bar.detail}</span>
      </span>
      {bar.canStart && (
        <button type="button" className="btn small primary" data-action="interview" disabled={opening} onClick={start}>
          {t("pages.memory.interviewStart")}
        </button>
      )}
    </div>
  );
}
