// 一个 agent 处理一条会话的输入（规格第 3、7 节）：秘书和维护者共用这一个类，各自只配置差异
// （常驻还是按需唤起、每次唤起的装配、守卫看到的 agent、怎么称呼它）；15、16 号票的项目维护者直接用它。
//
// - 输入队列就是事件日志：会话里交给 agent 的消息（用户消息、运行时的通知）排队（派生视图 agent_inputs），
//   一次处理一条——交给子进程时追加 turn_start，处理完追加 turn_end 出队，再取下一条。内存里只记"正在处理哪一条"。
// - 唤起：常驻的（秘书）一开始就拉起；按需的（维护者）有输入等着才经 agent 管家唤起（名额满了排队），
//   闲置退出后再来输入时重新唤起。每次唤起接着会话目录里最近的会话还是新开，由装配决定。
// - 回复：流式增量交给 StreamHub 节流推送（不落盘），定稿后只把文本和推理 part 写进会话；
//   代为执行的工具产生的卡片以一条只有卡片引用的消息出现在会话里，发出的附件（117 号票）以一条只有附件的消息出现；
//   会话里的消息都带上 scope（所属的任务、项目）。
// - 每次工具调用都先经守卫（forwardToolCalls + guards.attach，07 号票）；运行时自带的工具的登记也进守卫的注册表、运行时自己要问用户的
//   建提问卡（288 号票，Claude Code：runtimeTools、questions）。
// - 处理到一半被打断（子进程崩溃、守护进程重启）的输入不再重送：标成"中断"出队，会话里追加一条系统说明。
//   意外退出后隔一会儿（1 秒起翻倍，最多 30 秒）常驻的重新拉起，按需的有输入等着才再唤起。重新拉起时子进程从会话文件里
//   最后一个完整回合续上（去掉写到一半的一行、给被中断的工具调用补上结果），被中断的有副作用的调用由守卫接入记下（23 号票，
//   见 guard-runtime/executions.ts、recovery/）。
// - 代为执行的工具调用时带上正在处理的那条输入（快速动作判定"用户明确点了"、素材检索不列出命令本身，21 号票）。
// - 语音（31 号票）：队首是还没识别完的语音时，它在队里等着（后面的也不越过它），也不为它唤起 agent；
//   识别有了结局（会话频道上的 voice 事件）再看队首。交过去的是识别出的文字（注明"语音转写"），识别失败的是"[语音，识别失败]"。
//   210 号票（用户 2026-10-20："语音重试期间，我发的文字可以先发给二狗"）：只有第一次识别挡着后面的；第一次没识别成、进了自动重试
//   （208 号票）的从那一刻起不挡了——它照旧等着，排在它后面的照先后先交（已经排着的马上交，之后来的照常交），同一批里的也不等它；
//   它有了结局再作为一条新输入排到那时队列的末尾（agent_inputs 的 queue_seq），交过去时带一句几点说的、识别晚了（agent-input.ts）。
//   哪条挡、哪条不挡问输入队列的挡板（214 号票：inputGate，ready / waiting / deferred）：语音插件在运行时由它回答（voice/gate.ts），
//   不在时按内核的（input-gate.ts：还没识别完的语音不挡队列，只有这样的语音的消息先不交）；只看语音对象，守护进程重启后一样。
// - 彻底删除（21 号票，给了 sessionRewriteFor 时）：会话里来了 messages_purged，会话文件里对应的原话也要改写（改写哪些由
//   记忆模块从删除事件生成，改写本身由 agent 管家在一次性子进程里做）。子进程内存里还有原文，所以等手头这一条处理完，
//   停掉子进程、改写会话文件、再拉起（接着同一个会话）；和崩溃后的重新拉起共用一段收尾（relaunch）。
//   start() 时把以前的 messages_purged 再对一遍（上次改写到一半被杀也补上；改写是幂等的），改完才拉起。
// - 13 号票起（维护者执行任务）：
//   - 什么时候能处理输入由配置的 canProcess 决定（任务排队、暂停、结束时输入留在队里），状态变了由拉起它的模块 poke()；
//   - 每次唤起的装配、代为执行的工具和守卫看到的会话都按当时的情况现取（函数）；要换一套装配时 refresh()：
//     等手头这一条处理完，停掉子进程，下次唤起按新的装配拉起（接着同一个会话）；
//   - 插话（interjectNotices 打开时）：正在处理一条输入时运行时标了插话送达的通知（14 号票：无进展的催促）、秘书转达的话（103 号票）
//     送进去（在下一步之前插入）；
//     子进程在回合结束时报出收下了哪几条（turn_end.interjected），这几条随之记成处理完；没收下的照常排队。
//     144 号票起用户直接说的话不再插话：正在回复时用户发的排进会话的队列（message-queue.ts），这一轮做完再交；
//   - 重注入块：装配里的 contextBlock 在每条输入之前（被唤起：刚拉起，或者闲着时来了新输入）注入，压缩之后也注入；
//     setContextBlock 换成最新的；
//   - abortTurn：中止手头这一轮（任务暂停、取消时）；
//   - stopReply（144 号票，用户点了输入框旁的"停止"）：中止手头这一轮，已经说出来的留着（回复标"已停止"），时间线上记一笔
//     "你停止了这一轮"；没在回复时什么都不做；
//   - stopTurn（84 号票：重开前先 abort 再 waitForIdle）：先拦住不再开始下一条输入，中止手头这一轮，等它真的结束
//     （有时限）；到点还没结束的，这一轮之后的工具调用守卫一律不放行（superseded）。调用方做完它的事（提交重置）再放开。
//     拦着的时候：不送插话（用户说的话留在队里，放开后作为输入处理）；按 yield 停下、等着按新的装配接着干的那一轮（27 号票）
//     不再接着干，按中止结束（装配照样换，"工具包已变更"跟在下一条输入后面）。
// - 22 号票起（秘书的看板变化）：配置了 inputContext 的，交给子进程一条输入时可以带一条跟在它后面的上下文消息
//   （在开始处理这条输入的那一刻现取，系统提示不动）。266 号票起插件给的那几块可以是异步的（记忆简报要检索）：和附件一起等齐了再交；
//   插件还可以给这一轮的回话带上 part（记忆简报的结构化部分），放进这一轮的第一条回话，这一轮一条回话都没有就在结束前单独记一条。
// - 32 号票（语音回复，voice/voice-reply.ts）：给了 voiceReplies 的，用户发语音时交给子进程的输入后面跟它的说明（和上面的
//   上下文消息拼在一起）；一轮完成之后它可以要求追问 agent 一句（回复长、又没写口语总结时）：会话在处理下一条输入之前把这句
//   交给子进程（followUp），这一次不算新回复——它说的不进会话、不流式推送、不记 turn_start/turn_end，工具照常代为执行、
//   照常经守卫（调用记录照常进会话），用量照常记在那条输入名下；子进程退出、任务暂停时不再追问（交还给语音回复兜底）。
//   口语总结工具不在这里加：各处的装配把它放进代为执行的工具。合成本身跟着会话频道上的回合走，不在这里。
// - 24 号票：每次模型调用的用量记在谁名下（交给 agent 管家的 ledger，现取）：正在处理（或刚处理完）的那条输入所属的定时作业，
//   没有就是任务，再没有是项目，都没有按会话的 scope。agent 在账本里的角色由配置给（ledgerRole）；秘书的用量不论输入属于谁
//   都是系统开销（账本按角色判）。
// - 16 号票起（项目维护者的会话分段）：会话里的消息带上的范围可以随当前这一段变（scope 给函数）；
//   accepts 决定现在处理哪条输入（只处理属于当前这一段的，别的留在队里，不挡着后面的）；闲置退出时告诉拉起它的模块（onIdleExit）。
// - 18 号票起（范围审视，维护者才有，给了 scopeReview 时）：协调在 scope-reviews.ts（SessionScopeReviews），这里只接上几处——
//   拉起时装配里带上审视的那一份、交每条输入之前对照物变了先送、子进程就绪后送等着的审视、有审视等着又没有子进程时拉起一个；
//   reviewScope() 让子进程审视这个会话里还没审视过的部分（工单结束时，子进程退出之前），审视在做时不换装配、不改写会话文件。
// - 27 号票（工具包变了立即生效）：reassemble(notice)——
//   - 正在处理一条输入：让子进程做完手头这一步就停下（宿主协议的 yield：当前的工具调用结束、下一次模型调用之前），
//     回合以 yielded 结束后停掉子进程、马上按新的装配拉起（接着同一个会话），再把"工具包已变更：……"作为一条用户输入交过去，
//     它就接着原来那条输入干（那条输入仍在处理中，接着的这一轮结束时才记成处理完）；停下时还没进上下文的插话留在队里；
//     模型那一步已经不再调用工具（在写最后的回复）时这一轮照常结束，之后和闲着时一样；
//   - 闲着（子进程还在）：停掉子进程，下次有输入按新的装配拉起；
//   - 没有子进程（休眠）：什么都不用停，下次唤起自然按新的装配。
//   后两种情况"工具包已变更"跟在下一条输入后面（上下文消息）交给它。
// - 83 号票（换模型就新开会话，给了 modelSwitch 时）：一个会话固定一个模型，设置里改了这个 agent 的模型或思考档位，
//   下一条能换的输入（modelSwitch.allowed：秘书是用户的消息，项目维护者是对话段里的，定时作业的维护者是一次运行的开头；
//   任务执行中途不换）之前带上 handoff 拉起——休眠的唤起时就带上；子进程活着的，就绪时报了"接着的会话和装配参数不一样"（differs）
//   或者设置在它拉起之后改了（wanted 和拉起时的不一样），先停掉再带上 handoff 拉起。子进程用原来的模型写交接摘要、新开会话
//   （agent-child/handoff.ts），就绪时报回换没换成：换成了会话里记一条"已换成 X 模型，接着之前的对话"，再把这条输入交给新会话；
//   交接摘要没写成，记一条说明，这一条照旧交给原来的会话，下一条能换的输入再试（同一条不再试）。
// - 128 号票（agent 贡献，给了 contributions 时）：插件经 agent 贡献缝给这个 agent 的上下文块（被唤起时注入的那种）、钩子订阅
//   拉起时放进装配参数（宿主协议的通用贡献清单），交每条输入之前现算一遍、文字变了先送过去（contribution 命令，同范围审视的对照物）；
//   跟在输入后面的那种和看板变化、语音的说明拼在一起（排在最后）。工具由拉起它的模块放进 hostTools（守卫的登记随工具走）。
// - 144 号票（排队）：这一轮一结束（正常结束、停止、出错、中止、被打断，追加 turn_end 之后马上），会话把排队的消息一起交出去
//   （QueueDelivery：追加成普通的用户消息，同一批带同一个 queueDelivery），再从输入队列取下一条；交出去的一批作为一轮的输入一起交给子进程
//   （文字按先后拼在一条输入里，图片按先后跟着），turn_start、turn_end 带上另外几条（moreInputMessageIds），一起开始、一起出队。
//   守护进程停下时不交（重启后会话起来时交）。
// - 114 号票（会话里的 ⚙）：
//   - 清空当前对话（clear，秘书、任务的维护者；项目维护者的清空是重置维护者，走 16 号票的会话分段）：手头这一条处理完，会话里记一条分隔线
//     （conversation_cleared），停掉子进程，之后拉起时新开一段会话（宿主协议的 freshSession，名字由分隔线的消息 id 定，所以重启后照样认得）；
//     旧消息不删，界面上收在分隔线上面。排着的输入交给新的那一段；
//   - 现在压缩（compactNow）：手头这一条处理完（没有子进程先拉起）送 compact，压缩时不交新的输入、不闲置退出，压完（compacted）记下结果；
//   - 每次压缩压好了（自动的、手动的都算），时间线上记一笔"这里压缩过一次"（timeline_record，种类 compaction）；
//   - 子进程就绪时报的上下文窗口和压缩设置记着（context），⚙ 里的上下文用量按它算。
// - 150 号票（会话回退）：navigateSession——先停稳手头这一轮（照 stopTurn：abort 再等它结束），
//   拦着不交排队的消息、不开始下一条输入，子进程在会话树上挪（宿主协议的 navigate_session：回到某条输入之前、写分支摘要、叶子落盘），
//   挪成了由调用方（rollback.ts）在同一段里把分支事件写进事件日志，然后放开：排着的消息交给新分支。休眠的、正在重新拉起的先拉起来再挪。
//   293 号票：子进程的运行时不自己写分支摘要的（能力清单 branch_summary 是 false，Claude Code，给了 ownBranchSummary 时问），停稳之后由这里按
//   被放弃的那段里二狗自己记下的事件、用拉起它时的二狗模型另起一次写（navigationSummary → agent 管家的 recordedGeneration），写好的交给子进程；
//   运行时报回的文件恢复结果（session_navigated.files）随挪成了的结果交给调用方。
// - 286 号票（运行时，给了 launchBlocked 时）：要拉起子进程之前（有输入等着、现在压缩、范围审视、会话回退）先问一句"现在拉不拉得起"——
//   维护者用的运行时插件停用了就不拉：输入留在队里、压缩等着、会话回退回这个原因；能拉起了由拉起它的模块 poke()。
// - 289 号票（运行时的斜杠命令、中途换运行时）：
//   - 拉起时按子进程的运行时定"斜杠命令原样转交"（slashPassthrough：能力清单 slash_passthrough），是的话用户打的 /命令 原样交给它（agent-input.ts）；
//   - 中途换运行时（switchRuntime，给了 runtimeSwitch 时）：和清空一样等手头这一条处理完，拦着不交下一条输入；这段会话里 agent 说过话的，
//     先让原来的运行时写交接摘要（宿主协议 write_handoff；没有子进程的按原来的运行时拉起一个；拉不起、没写成的照样换，说明里写原因），
//     停掉它；会话里记一条"已换成 X"（sessionStart，消息 id 以 m-rt- 开头，之后拉起都带上由它定的 freshSession：新的运行时新开一段会话，
//     重启后照样认得），交接摘要跟在下一条输入后面交给新的（pendingNotice）；最后由拉起它的模块把维护者的运行时改成新的（commit）。
//     写交接摘要时 ⚙ 上显示"原来的在写交接摘要"。
// - 291 号票（工具包当场换，给了 liveToolkit / retool 时）：子进程的运行时能力清单里 live_toolkit 是 true（Claude Code）的，工具包变了（reassemble）
//   不 yield、不重新拉起——子进程就绪着就现取此刻的装配（retool：代为执行的工具、守卫看到的 agent 和工具注册表、skill），守护进程这边按新的
//   代为执行、判定、计时，再送宿主协议 toolkit（工具、skill、"工具包已变更"那句），子进程当场换；手头这一轮照常接着干，在等结果的调用照常交回。
//   子进程还没就绪（拉起中）的照旧：停掉、按新的装配重新拉起。
// - 309 号票（Claude Code 的范围审视、二狗 skill 的斜杠写法）：
//   - 子进程的运行时自己不审视的（Claude Code，给了 recordedScopeReview 时问）：范围审视由二狗按自己记下的事件另起一次（scope-reviews.ts 的 recorded：
//     这段会话里上次压缩之后的部分，recorded-transcript.ts 的 unreviewedRanges / recordedSegment；agent 管家的 recordedGeneration，用量记在这个 agent 名下）——
//     压缩之前子进程报 compacting 时、工单结束时（reviewScope）；没有子进程时按要拉起的运行时（runtimeSwitch.current）判；
//   - 斜杠命令原样转交的运行时里，用户打的 /<目录名>（或 /skill:<目录名>）是这次装配的 skill、又不是运行时自己的命令时，交过去之前换成运行时里的
//     写法（runtimeSlash：Claude Code 的 /ergo:<目录名>，agent-input.ts）。
import { randomUUID } from "node:crypto";
import {
  type AgentCompactionState,
  type AgentCompactResult,
  type BranchFilesRewind,
  type ConversationId,
  EVENT_TYPES,
  type LedgerOwner,
  type LedgerRole,
  type MemoryRecall,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type MessagesPurgedEventPayload,
  PI_RUNTIME_ID,
  type RuntimeChoice,
  type RuntimeSwitchState,
  type SeqRange,
  type SessionModelView,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
  turnFailedNote,
  nowIso,
  t,
  tTable,
} from "@ergo/protocol";
import type { AgentManager, ManagedAgent, ManagedExit, SpawnAgentRequest } from "../agent-manager/agent-manager.ts";
import type { ContributedManifest } from "../agent-host/contributions.ts";
import { type HostTool, hostToolTimeouts, serveHostTools } from "../agent-manager/host-tools.ts";
import type { EventStore } from "../events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, isBuiltinDescriptor, registerTools, type ToolDescriptor, type ToolRegistry } from "../guard/index.ts";
import type { GuardedSession, GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { RuntimeQuestions } from "./runtime-questions.ts";
import type { UsageAttribution } from "../ledger/index.ts";
import type { MediaStore } from "../media/media-store.ts";
import {
  type AgentReport,
  type CompactedReport,
  type InterruptedToolResult,
  type ModelSpec,
  type NavigateTarget,
  REINJECTION_BLOCK_ID,
  type SessionBranchMarker,
  type SessionContextInfo,
  type SessionNavigatedReport,
  type SessionRewriteRequest,
} from "../runtime/index.ts";
import { RequestRejected } from "../errors.ts";
import { providerOf } from "../model-settings/providers.ts";
import { type AgentInputContext, prepareAgentInput } from "./agent-input.ts";
import { type InputGate, unattendedInputGate } from "./input-gate.ts";
import { finalParts, quoteMessage } from "./agent-replies.ts";
import { recordedSegment, recordedTranscript, unreviewedRanges } from "./recorded-transcript.ts";
import { modelSwitchedNote, modelSwitchFailedNote, sameModel } from "./model-switch.ts";
import type { SkillCommand } from "../skills/skill-command.ts";
import { ergoCommandsIn, type SlashConversationKind } from "../slash-commands/commands.ts";
import { appendMessage, buildMessage, buildTimelineRecord, type MessageScope, newMessageId } from "./messages.ts";
import type { QueueDelivery } from "./message-queue.ts";
import { type ScopeReviewResult, SessionScopeReviews, type SessionScopeReviewOptions } from "./scope-reviews.ts";
import type { StreamHub } from "./stream-hub.ts";
import { agentSpokeAfter, getMessage, lastClearMarker, lastRuntimeSwitchMarker, pendingInputs, type QueuedInput, replying, RUNTIME_SWITCH_MESSAGE_PREFIX, startedInputs } from "./views.ts";

/** 清空当前对话之后新开的那一段会话的名字（114 号票）：由分隔线的消息 id 定，重启后照样认得 */
export const clearedSessionName = (markerId: string): string => `cleared-${markerId}`;

/** 换运行时之后新开的那一段会话的名字（289 号票）：由会话里那条"已换成"的消息 id 定，重启后照样认得 */
export const switchedSessionName = (markerId: string): string => `switched-${markerId}`;

/**
 * 这段会话现在叫什么（拉起时带上 freshSession）：最近一次清空的分隔线、最近一次换运行时的说明，谁在后用谁；都没有是 undefined
 */
function latestSessionName(store: EventStore, conversation: ConversationId): string | undefined {
  const cleared = lastClearMarker(store.reader, conversation);
  const switched = lastRuntimeSwitchMarker(store.reader, conversation);
  if (switched && (!cleared || switched.globalSeq > cleared.globalSeq)) return switchedSessionName(switched.messageId);
  return cleared && clearedSessionName(cleared.messageId);
}

/** 这段会话从哪算起（全局序号）：最近一次清空、换运行时，都没有是 0 */
function sessionSince(store: EventStore, conversation: ConversationId): number {
  return Math.max(lastClearMarker(store.reader, conversation)?.globalSeq ?? 0, lastRuntimeSwitchMarker(store.reader, conversation)?.globalSeq ?? 0);
}

/** 换运行时：原来的运行时写交接摘要时，把它拉起来最多等多久（毫秒） */
const HANDOFF_READY_TIMEOUT_MS = 60_000;
/** 子进程自己按 timeoutMs 收尾，这边多等这么久才算它没回 */
const HANDOFF_GRACE_MS = 30_000;

/** ⚙ 面板要的这个会话此刻的样子（114 号票） */
export interface AgentSessionPanel {
  /** 子进程在不在（排队、拉起中也算在） */
  running: boolean;
  /** 正在处理一条输入 */
  busy: boolean;
  /** "现在压缩"到哪了 */
  compaction: AgentCompactionState;
  /** 上一次手动压缩的结果（守护进程这次起来以后的） */
  lastCompact: AgentCompactResult | undefined;
  /** 清空等着手头这一条处理完 */
  clearPending: boolean;
  /** 最近一次就绪时报的上下文窗口和压缩设置（守护进程这次起来以后还没就绪过是 undefined） */
  context: SessionContextInfo | undefined;
  /** 最近一次就绪时报的会话实际用的模型（120 号票：⚙ 上显示；还没就绪过是 undefined） */
  model: SessionModelView | undefined;
  /** 正在换运行时（289 号票）：换成哪个、到哪了；没在换是 undefined */
  runtimeSwitch: { to: string; state: RuntimeSwitchState } | undefined;
}

/**
 * 会话树上挪（150 号票）：挪到哪、写不写分支摘要、落盘的记号（宿主协议 navigate_session 去掉 type、requestId）。
 * 293 号票：summary.abandoned 是被放弃的那段（会话频道上的序号段，停稳之后现算）——子进程的运行时不自己写分支摘要的（能力清单 branch_summary
 * 是 false，Claude Code），二狗按这几段里自己记下的事件、用这个 agent 的二狗模型另起一次写好交过去（宿主协议的 summary.written）
 */
export interface SessionNavigation {
  target: NavigateTarget;
  marker: SessionBranchMarker;
  summary?: { instructions: string; abandoned?: () => readonly SeqRange[] };
}

/**
 * 挪成了：离开的那条分支在会话文件里的末端、新分支从哪一条长出来、写好的分支摘要、这是哪个会话（会话文件的名字）；
 * 293 号票起还有运行时把它改过的文件恢复到撤回点没有（能力清单 rewind_files 的运行时才有）
 */
export interface SessionNavigated {
  from: string;
  at: string;
  summary?: string;
  session: string | undefined;
  files?: BranchFilesRewind;
}

/** 回退时停稳手头这一轮、把子进程拉起来最多各等多久（毫秒） */
export const NAVIGATE_STOP_TIMEOUT_MS = 10_000;
export const NAVIGATE_READY_TIMEOUT_MS = 60_000;

/** 子进程意外退出后再拉起的等待时间：1 秒起，每次翻倍，最多 30 秒 */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** 会话此刻的状态：休眠（按需的，没有子进程）、拉起中（含排队）、闲着、在处理一条输入、意外退出后等着再拉起、已停止 */
export type AgentSessionStatus = "asleep" | "starting" | "idle" | "busy" | "restarting" | "stopped";

/** 每次唤起的装配：agent id、代为执行的工具、超时、守卫转发、常驻由会话类自己填 */
export type AgentSessionSpawn = Omit<SpawnAgentRequest, "agentId" | "hostTools" | "toolTimeouts" | "toolTitles" | "forwardToolCalls" | "resident">;

/** 守卫看到的这个会话：agent、来源、会话段、所属的任务（工具注册表、会话、消息范围由会话类填） */
/**
 * 守卫看到的会话（工具注册表、会话、归属由这里补）。runtimeTools（288 号票）：会话的运行时自带、二狗没装配的工具的登记
 * （Claude Code 的 TodoWrite、Agent……，AgentRuntime.guardTools），加进守卫的工具注册表
 */
export type AgentSessionGuard = Omit<GuardedSession, "tools" | "conversation" | "messageScope"> & { runtimeTools?: readonly ToolDescriptor[] };

export interface AgentSessionOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  guards: GuardRuntime;
  /**
   * 运行时自己要问用户的（288 号票，宿主协议 23 的 ask_user：Claude Code 的 AskUserQuestion、退出计划模式的批准）：每次拉起接上，
   * runtimeTitle 是卡上写的运行时的名字。不给的会话（秘书、子 agent：pi 不问）收到也不管
   */
  questions?: { service: RuntimeQuestions; runtimeTitle: () => string };
  media: MediaStore;
  /** 交给模型的每条消息前面的本地时间标记按它换算 */
  timeZone: string;
  log: (line: string) => void;
  agentId: string;
  conversation: ConversationId;
  /** 日志里怎么称呼它："秘书"、"维护者" */
  label: string;
  /**
   * 会话里给人看的系统说明（"……这次没能回复"）里怎么称呼它；不给就用 label。
   * 秘书用名字占位（43 号票：前端按用户起的名字显示，改名后旧的也跟着变）
   */
  displayName?: string;
  /**
   * 会话里的消息带上的归属（维护者会话：任务、项目）；给函数时每条消息现取（任务的维护者带上当时的阶段，25 号票；
   * 项目维护者的随当前这一段变，16 号票）。守卫接入在判定一次调用时取一次，这次调用的记录用那一刻的
   */
  scope?: MessageScope | (() => MessageScope);
  /** 这个 agent 在 token 账本里的角色（秘书、维护者）；不给是维护者 */
  ledgerRole?: LedgerRole;
  /** 现在处理不处理这条排着的输入（不给就按先后都处理）：不处理的留在队里，接着看后面的（16 号票） */
  accepts?(input: QueuedAgentInput): boolean;
  /** 闲置退出了（按需的 agent，16 号票：对话段在维护者闲置退出时结束） */
  onIdleExit?(): void;
  /** 子进程就绪了：它打开的是哪个会话（16 号票：项目维护者的第一段对话段接着以前的会话时，记下接的是哪个） */
  onReady?(ready: { session: string }): void;
  /**
   * 现在的子进程是不是按过时的装配拉起的（16 号票：维护者换了一段会话、项目的装配变了）：交下一条输入之前看一眼，
   * 过时了就停掉、按新的装配重新拉起再交。不给就只看 refresh()
   */
  outdated?(): boolean;
  /** 常驻（秘书）：一开始就拉起、意外退出后重新拉起，不闲置退出、不排队；否则有输入才唤起 */
  resident?: boolean;
  /** 第几次唤起（1 起）时的装配 */
  spawn(n: number): AgentSessionSpawn;
  /** 守护进程代为执行的工具（它们的登记加进守卫的工具注册表）：每次唤起现取 */
  hostTools(): readonly HostTool[];
  /** 守卫看到的这个会话：每次唤起现取 */
  guard(): AgentSessionGuard;
  /**
   * 此刻的守卫视角（27 号票，不给就一直用唤起时的）：守卫每次判定现取，传入唤起时的那一份。
   * 工具包收窄了，子进程重新装配之前发起的调用、正在等审批的调用也按新的判
   */
  guardNow?(spawned: GuardAgent): GuardAgent;
  /** 现在能不能处理输入（不给就总是能）：不能时输入留在队里，状态变了调 poke() */
  canProcess?(): boolean;
  /**
   * 正在处理一条输入时，运行时标了插话送达的通知（14 号票：无进展的催促）、秘书转达的话（103 号票）送进去（维护者）；不打开就排队。
   * 144 号票起用户在这个会话里直接说的话一律不插话：正在回复时排进会话的队列，这一轮做完再交（queue）
   */
  interjectNotices?: boolean;
  /** 排队的消息（144 号票，message-queue.ts）：这一轮结束时一起交出去；不给就没有队列可交 */
  queue?: QueueDelivery;
  /**
   * 配置里写明的看图能力（79 号票；73 号票起设置页改的优先），键是「provider/模型 id」（faux 是 faux）；没写的按模型目录。
   * 拉起时现取。实际生效的由子进程在 ready 里报回（接着已有的会话时是会话开始时定下的）：用户消息里的图片据此作为图片交过去
   * 还是投影成占位，读取附件读图时据此交不交图片
   */
  configuredVision(): Readonly<Record<string, boolean>>;
  /** 处理到一半被打断的那条输入的系统说明（quoted 是它开头的引用，可能为空） */
  interruptedNote(quoted: string): string;
  /**
   * 处理到一半被打断时由拉起它的模块重新交一次的输入（99 号票：秘书的任务做完通知，task-done.ts 起来后重交）：照样标成中断出队，
   * 但不出上面那句系统说明。不给是都出
   */
  redeliveredOnInterrupt?(message: MessageEnvelope): boolean;
  /**
   * 交给子进程这条输入时，跟在它后面的一条上下文消息（秘书的看板变化，22 号票）：开始处理这条输入的那一刻现取
   * （在 turn_start 之前），undefined 就不带
   */
  inputContext?(message: MessageEnvelope): string | undefined;
  /** 语音回复（32 号票）：用户发语音时跟在输入后面的说明、一轮完成之后的追问；不给就没有 */
  voiceReplies?: SessionVoiceReplies;
  /**
   * 输入队列的挡板（214 号票）：这条消息这时还要不要等（31、208、210 号票的规矩由语音插件回答）；不给、回 undefined 时按内核的
   * （input-gate.ts：语音插件不在时还没识别完的语音不挡队列）
   */
  inputGate?(message: MessageEnvelope): InputGate | undefined;
  /** 挡板的规矩变了（214 号票：语音插件运行中停用、启用）时叫 listener，会话再看一眼队首；回取消的函数。不给就只跟着事件看 */
  onGateChange?(listener: () => void): () => void;
  /**
   * 插件经 agent 贡献缝给的（128 号票，agent-host/contributions.ts 按这个 agent 此刻的样子筛好）：上下文块和钩子订阅（拉起时、
   * 交每条输入之前现取）、跟在输入后面的上下文块。不给就没有
   */
  contributions?: SessionContributions;
  /** 彻底删除之后会话文件要改写哪些原话（记忆模块从删除事件生成）；不给就不改写 */
  sessionRewriteFor?(purges: readonly MessagesPurgedEventPayload[]): Omit<SessionRewriteRequest, "sessionDir">;
  onStatus?(status: AgentSessionStatus): void;
  /**
   * 范围审视（18 号票，维护者）：审视用的模型、审视的说明、此刻的对照物（交每条输入之前、守护进程要审视时现取），
   * 压缩会话时子进程自己做的审视的结果交给 onCompactionReview。拉起时装配里由这里带上
   */
  scopeReview?: SessionScopeReviewOptions;
  /**
   * 库里每个 skill 的斜杠命令（82 号票，按整个库算）：用户打 /目录名 时从里面挑出这次装配了的展开；
   * 不给就按装配的目录自己算（目录名就是命令名，没有"集合名:目录名"）
   */
  skillCommands?(): readonly SkillCommand[];
  /**
   * 这是哪种会话（82 号票）：二狗自己的命令（/workflow、/task）只在有它们的会话里优先，同名的 skill 在别的会话里直接 /目录名 就展开。
   * 不给就当这个会话里没有二狗自己的命令
   */
  slashConversation?: SlashConversationKind;
  /**
   * 交给它的用户消息末尾带一行消息 id（125 号票：维护者引用用户原话时照抄它，运行时据此核实）。秘书不用（它不引用），维护者都给
   */
  userMessageIds?: boolean;
  /**
   * 换模型就新开会话（83 号票，见文件开头）：设置里改了模型，下一条能换的输入之前新开会话、附交接摘要。不给就不换
   * （任务的维护者：一个任务一个会话，执行中途不换）
   */
  modelSwitch?: AgentSessionModelSwitch;
  /**
   * 现在拉不起子进程的原因（286 号票：维护者用的运行时插件没在运行，"X插件没启用"）：要拉起之前问一句，有原因就不拉——
   * 输入留在队里，现在压缩等着，会话回退回这个原因（not_allowed）。能拉起了由拉起它的模块 poke()。不给就总能拉起
   */
  launchBlocked?(): string | undefined;
  /**
   * 子进程的运行时能不能把斜杠命令原样转交（289 号票：能力清单 slash_passthrough）：拉起时按请求里的运行时问一句（没写是 pi），
   * 能的话用户打的 /命令 原样交给它。不给就都不转交（pi 的规矩：二狗自己展开 skill）
   */
  slashPassthrough?(runtime: string): boolean;
  /**
   * 子进程的运行时能不能当场换工具包（291 号票：能力清单 live_toolkit）：拉起时按请求里的运行时问一句（没写是 pi）。能的话工具包变了不 yield、
   * 不重新拉起，送 toolkit（见 retool）。不给就都不能（pi 的规矩）
   */
  liveToolkit?(runtime: string): boolean;
  /**
   * 当场换工具包时现取此刻的装配（291 号票）：之后 hostTools()、guard() 交回的就是它；交回这份装配里 skill 的目录。liveToolkit 给了才用
   */
  retool?(): { skillPaths: readonly string[] };
  /** 中途换运行时（289 号票，见 switchRuntime）要的；不给就不能换 */
  runtimeSwitch?: AgentSessionRuntimeSwitch;
  /**
   * 子进程的运行时自己写不写分支摘要（293 号票：能力清单 branch_summary）：撤回时按此刻子进程的运行时问一句（没写是 pi）。不写的（Claude Code）
   * 由二狗按自己记下的事件、用这个 agent 拉起时的二狗模型另起一次写（agent 管家的 recordedGeneration），写好交给子进程放进新分支的上下文。
   * 不给是都自己写（pi 的规矩）
   */
  ownBranchSummary?(runtime: string): boolean;
  /**
   * 子进程的运行时的范围审视由二狗另起（309 号票：AgentRuntime.recordedScopeReview，Claude Code）：守护进程要的审视、压缩之前的审视都按二狗自己记下的事件、
   * 用审视的模型另起一次（见文件开头）。不给是都在子进程里做（pi 的规矩）
   */
  recordedScopeReview?(runtime: string): boolean;
  /**
   * 斜杠命令原样转交的运行时里二狗 skill 的写法（309 号票）：skillCommands 给这次装配的 skill 目录在运行时里的命令名（不带 /，一一对应；Claude Code 是
   * ergo:<目录名>），commands 是运行时自己的命令名（同名时运行时的优先，不换）。拉起时按子进程的运行时问一句；不给、回 undefined 是不换
   */
  runtimeSlash?(runtime: string): { skillCommands(skillDirs: readonly string[]): readonly string[]; commands(): readonly string[] } | undefined;
}

/** 中途换运行时（289 号票）要的：交接摘要的写法和最多等多久、运行时给人看的名字、换完了怎么记 */
export interface AgentSessionRuntimeSwitch {
  /** 交接摘要的写法（prompts/handoff-summary.md 填好值，和换模型同一份）：要写时现取 */
  instructions(): string;
  /** 写交接摘要那次模型调用最多等多久（毫秒） */
  timeoutMs: number;
  /** 现在用的运行时 */
  current(): string;
  /** 运行时给人看的名字 */
  title(runtime: string): string;
  /** 换完了（原来的停掉、会话里记好了"已换成"）：把维护者的运行时、给它选的值改成新的（任务、项目上记一条 runtime_set） */
  commit(to: string, options: RuntimeChoice | undefined): void;
}

/** 换模型就新开会话（83 号票）要的：交接摘要的写法、什么时候能换、设置里此刻给它的模型 */
export interface AgentSessionModelSwitch {
  /** 交接摘要的写法（prompts/handoff-summary.md 填好值）：带上 handoff 拉起时现取 */
  instructions(): string;
  /** 处理这条输入之前能不能换（秘书：用户的消息；项目维护者：对话段里；定时作业的维护者：一次运行的开头）。任务执行中途不换 */
  allowed(input: QueuedAgentInput): boolean;
  /** 设置里此刻给这个 agent 的模型：子进程活着时设置改了，下一条能换的输入之前按它重新拉起（换不换由子进程比对会话开始时的） */
  wanted(): ModelSpec;
}

/** 排着等 agent 处理的一条输入：消息 id 和它的事件负载（所属的任务、项目……） */
export interface QueuedAgentInput {
  messageId: string;
  payload: MessageEventPayload;
}

/** 输入队列里的一条，连同它的消息事件负载（按全局序号取） */
export function queuedAgentInput(store: EventStore, input: Pick<QueuedInput, "messageId" | "globalSeq">): QueuedAgentInput {
  return { messageId: input.messageId, payload: store.readGlobal(input.globalSeq - 1, 1)[0]!.payload as MessageEventPayload };
}

/** 一轮完成之后运行时要追问 agent 的一句（32 号票：回复长、又没写口语总结时追问它补写） */
export interface SessionFollowUp {
  /** 交给子进程的话 */
  readonly text: string;
  /** 追问结束时调一次：答完、出错、中止，或者没法追问（子进程退出、任务暂停） */
  done(): void;
}

/** 插件经 agent 贡献缝给会话的（128 号票） */
export interface SessionContributions {
  /** 此刻的上下文块（被唤起时注入的那种）和钩子订阅：一个会话里 id 不变，只换文字 */
  manifest(): ContributedManifest;
  /** 跟在这条输入后面的（开始处理它的那一刻现取；266 号票起可以是异步的，等齐了再交这条输入）；没有是 undefined */
  inputContext(message: MessageEnvelope): string | undefined | Promise<string | undefined>;
  /** 这一轮的回话要带上的 part（266 号票：记忆简报的结构化部分），上面那块算好之后取；不给就没有 */
  replyParts?(message: MessageEnvelope): readonly MessagePart[];
  /** 接在这条输入自己的文字末尾的输入附注（212 号票，开始处理它的那一刻现取）；没有是 undefined。不给就没有 */
  inputNote?(message: MessageEnvelope): string | undefined;
}

/** 语音回复给会话的（32 号票，voice/voice-reply.ts 实现） */
export interface SessionVoiceReplies {
  /** 交给子进程这条输入时跟在后面的说明（用户这条是语音时才有） */
  inputContext(message: MessageEnvelope): string | undefined;
  /**
   * 一轮完成（turn_end 已经追加）之后要不要追问 agent 一句：要的话会话在处理下一条输入之前交给子进程，
   * 它这次说的不进会话（不算新回复）
   */
  followUp(conversation: ConversationId, inputMessageId: string): SessionFollowUp | undefined;
  /**
   * 接着会话时给这个会话里被中断的发语音调用（86 号票）补上的结果：键是工具调用 id（和守护进程知道的别的被中断的调用合在一起，
   * 子进程只给会话最后一轮里没有结果的补）
   */
  interruptedResults?(conversation: ConversationId): Record<string, InterruptedToolResult>;
}

/**
 * 语音回复给 agent 的：会话用上面两件；口语总结工具、发语音工具（86 号票）由各处的装配放进代为执行的工具
 * （守卫的工具包也就有它们）
 */
export interface AgentVoiceReplies extends SessionVoiceReplies {
  readonly tools: readonly HostTool[];
}

export class AgentSession {
  private readonly options: AgentSessionOptions;
  private readonly inputContext: AgentInputContext;
  private proc: ManagedAgent | undefined;
  private ready = false;
  /** 正在处理的那条输入（追问时是被追问的那条；一起交出的一批时是第一条） */
  private current: string | undefined;
  /** 和 current 一起交给子进程的另外几条输入（144 号票：排队交出的一批），按先后 */
  private currentMore: string[] = [];
  /** 用户点了停止的那一轮（144 号票：它以中止结束时时间线上记一笔"你停止了这一轮"） */
  private userStop: string | undefined;
  /** 等着交给子进程的追问（32 号票）：在下一条输入之前 */
  private followUp: { inputMessageId: string; ask: SessionFollowUp } | undefined;
  /** 正在进行的追问：子进程这次说的不进会话 */
  private asking: SessionFollowUp | undefined;
  /** 正在处理（或刚处理完）的那条输入所属的任务、项目：用量记在它名下 */
  private inputScope: MessageScope = {};
  /** 这一轮的回话要带上的 part（266 号票，插件给的）：放进这一轮的第一条回话；这一轮没有回话就在结束前单独记一条 */
  private turnParts: { input: string; parts: MessagePart[] } | undefined;
  /** 正在生成的回复：子进程里的消息 id → 定稿后的消息 id（流式增量和定稿消息共用它） */
  private reply: { agentMessageId: string; messageId: string } | undefined;
  private spawns = 0;
  private crashes = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  /** 正在重新拉起（停子进程、改写会话文件、崩溃后的退避）：期间不取输入 */
  private relaunching = false;
  /** 等着在会话文件里改写的彻底删除 */
  private readonly pendingPurges: MessagesPurgedEventPayload[] = [];
  /** 送进去当插话、还不知道收没收下的输入（消息 id → 送给的子进程） */
  private readonly interjected = new Map<string, ManagedAgent>();
  /** 要换一套装配：手头这一条处理完就停掉子进程，下次按新的装配拉起 */
  private stale = false;
  /** 工具包变了、正等子进程做完手头这一步停下（27 号票）：停下后要告诉 agent 的话 */
  private yieldNotice: string | undefined;
  /**
   * 子进程按 yield 停下了：按新的装配拉起后，把这句话作为一条输入交过去，接着手头那条输入干。
   * restart：旧的子进程还没停（范围审视在做时不换装配，18 号票：审视兑现之后再停）
   */
  private resume: { notice: string; restart: boolean } | undefined;
  /** 工具包变了时 agent 闲着或休眠：跟在下一条输入后面告诉它的话 */
  private pendingNotice: string | undefined;
  /**
   * 现在的子进程手里的工具（291 号票）：代为执行的工具、守卫看到的 agent 和工具注册表——拉起时的，工具包当场换过的是换后的；
   * live 是这个子进程能当场换工具包（运行时 live_toolkit）
   */
  private held: { proc: ManagedAgent; live: boolean; hostTools: readonly HostTool[]; agent: GuardAgent; registry: ToolRegistry } | undefined;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;
  /** 不再跟着挡板的规矩变（214 号票） */
  private offGate: (() => void) | undefined;
  private currentStatus: AgentSessionStatus = "asleep";
  /** 有人拦着不让开始下一条输入（stopTurn 还没放开，84 号票）：拦了几次 */
  private holds = 0;
  /** 等手头这一轮结束的（stopTurn）：状态一变就各自看一眼 */
  private readonly turnWaiters = new Set<() => void>();
  /** 作废了的那一轮（stopTurn 到点没停下）：还是它在处理时，守卫不再放行这一轮的调用 */
  private superseded: { input: string; reason: string } | undefined;
  /** 范围审视（给了 scopeReview 时） */
  private readonly reviews: SessionScopeReviews | undefined;
  /** 会话实际用的模型（子进程最近一次就绪时报的，73 号票）；还没就绪过是 undefined */
  private model: SessionModelView | undefined;
  /** 现在的子进程是按哪个模型拉起的（83 号票：设置在它拉起之后改了没有） */
  private spawnedModel: ModelSpec | undefined;
  /** 现在的子进程拉起时给的凭据、它的运行时（293 号票：二狗替不自己写分支摘要的运行时另起一次写，用同一个模型和凭据） */
  private spawnedCredentials: Record<string, string> = {};
  private spawnedRuntime: string = PI_RUNTIME_ID;
  /** 现在的子进程接着的会话开始时的模型和装配参数里的不一样（就绪时报的 differs，83 号票） */
  private modelDiffers = false;
  /** 为哪条输入带着 handoff 拉起过（83 号票）：没换成时这一条不再试，下一条能换的输入再试 */
  private switchTriedFor: string | undefined;
  /** 带着 handoff 拉起、还没就绪（子进程可能在写交接摘要） */
  private switching = false;
  /** 清空当前对话（114 号票）：等手头这一条处理完再清；值是请求的幂等键 */
  private clearWanted: string | undefined;
  /**
   * 正在写清空的分隔线（114 号票）：store.append 同步通知订阅者、pump 会被重入，那时新的一段还没定下来（freshSession、stale 没设上），
   * 排着的输入会交给旧的子进程。写的时候 pump 一律不动，写完定下新的一段再接着
   */
  private clearing = false;
  /** 最近一次清空之后那一段会话的名字（拉起时带上 freshSession）；没清空过是 undefined */
  private freshSession: string | undefined;
  /** 现在压缩（114 号票）：等手头这一条处理完再送 compact */
  private compactWanted = false;
  /** 送了 compact、还没压完：放开不闲置退出 */
  private compacting: (() => void) | undefined;
  private lastCompact: AgentCompactResult | undefined;
  /** 最近一次就绪时报的上下文窗口和压缩设置 */
  private contextInfo: SessionContextInfo | undefined;
  /** 现在的子进程手里通用贡献清单里插件那几项的文字（id → 文字，128 号票）：交每条输入之前比一比，变了先送 */
  private contributed = new Map<string, string>();
  /** 正在会话树上挪（150 号票）：拦着不交排队的消息（交了会落在被放弃的那段里） */
  private navigating = false;
  /** 送了 navigate_session、等 session_navigated 的（requestId → 收结果的、送给的子进程） */
  private readonly navigations = new Map<string, { proc: ManagedAgent; settle(report: SessionNavigatedReport | Error): void }>();
  /** 子进程最近一次就绪时报的会话名字（会话文件的名字） */
  private sessionName: string | undefined;
  /** 要换运行时（289 号票）：等手头这一条处理完再换；换的过程中也一直在（拦着不交下一条输入） */
  private runtimeWanted: { to: string; options: RuntimeChoice | undefined; state: RuntimeSwitchState; running: boolean } | undefined;
  /** 送了 write_handoff、等 handoff_written 的（requestId → 收结果的、送给的子进程） */
  private readonly handoffs = new Map<string, { proc: ManagedAgent; settle(result: { text?: string; error?: string } | Error): void }>();

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.inputContext = {
      store: options.store,
      media: options.media,
      timeZone: options.timeZone,
      vision: false,
      ...(options.skillCommands ? { skillCommands: () => options.skillCommands!() } : {}),
      ergoCommands: options.slashConversation ? ergoCommandsIn(options.slashConversation) : [],
      ...(options.userMessageIds ? { userMessageIds: true } : {}),
      // 插件给的输入附注（212 号票：浏览侧边栏、悬浮按钮发的消息后面那段网页上下文），交的时候现取
      ...(options.contributions?.inputNote ? { inputNote: (message: MessageEnvelope) => options.contributions?.inputNote?.(message) } : {}),
    };
    this.reviews =
      options.scopeReview &&
      new SessionScopeReviews(
        { ...options.scopeReview, agentId: options.agentId, label: options.label },
        {
          readyProcess: () => (this.ready && this.proc?.state === "running" ? this.proc : undefined),
          // 有审视等着、没有子进程：按当前的装配拉起一个（接着同一个会话）
          wake: () => this.pump(),
          // 审视做完了：等着它的换装配、改写会话文件可以做了
          settled: () => this.pump(),
          // 309 号票：运行时自己不审视的由二狗按自己记下的事件另起一次（这段会话里上次压缩之后的；凭据没给就用子进程拉起时的）
          ...(options.recordedScopeReview
            ? {
                recorded: {
                  wanted: () => this.recordedReviews(),
                  spawn: () => this.spawns,
                  segment: () => recordedSegment(options.store, options.conversation, unreviewedRanges(options.store, options.conversation)),
                  generate: (request, credentials) =>
                    options.agents.recordedGeneration({ ...request, credentials: credentials ?? this.spawnedCredentials }, { agentId: options.agentId, attribution: this.usageAttribution() }),
                  log: options.log,
                },
              }
            : {}),
        },
      );
  }

  get status(): AgentSessionStatus {
    return this.currentStatus;
  }

  /** 当前子进程的 pid（还没拉起、排队中或已退出时没有） */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /**
   * 会话实际用的模型、思考档位和看图能力（子进程最近一次就绪时报的，73 号票：接着已有的会话时是会话开始时定下的）；
   * 还没就绪过是 undefined。设置页拿它告诉用户秘书的主线会话现在用的是哪个
   */
  get sessionModel(): SessionModelView | undefined {
    return this.model;
  }

  /** 正在换模型（83 号票：带着 handoff 拉起、还没就绪，子进程可能在写交接摘要）：秘书据此不把这段时间算成"不在运行" */
  get switchingModel(): boolean {
    return this.switching;
  }

  /** ⚙ 面板要的这个会话此刻的样子（114 号票） */
  get panel(): AgentSessionPanel {
    return {
      running: this.proc !== undefined,
      busy: this.current !== undefined && this.asking === undefined,
      compaction: this.compacting ? "running" : this.compactWanted ? "waiting" : "idle",
      lastCompact: this.lastCompact,
      clearPending: this.clearWanted !== undefined,
      context: this.contextInfo,
      model: this.model,
      runtimeSwitch: this.runtimeWanted && { to: this.runtimeWanted.to, state: this.runtimeWanted.state },
    };
  }

  /** 给人看的出错说明里怎么称呼它（173 号票）：label 后面带 agent 编号（label 由拉起它的模块按当时的语言给） */
  private who(): string {
    return t("conversation.session.who", { name: this.options.label, agentId: this.options.agentId });
  }

  /**
   * 清空当前对话（114 号票）：手头这一条处理完就在会话里记一条分隔线、停掉子进程，下次拉起新开一段会话（常驻的马上拉起），
   * 不再带着之前的聊天；排着的输入交给新的那一段。同一个幂等键只清一次。返回清了没有（done）还是等它说完（waiting）
   */
  clear(idempotencyKey: string): "done" | "waiting" {
    if (this.stopped) throw new Error(t("conversation.session.stopped", { who: this.who() }));
    this.clearWanted ??= idempotencyKey;
    this.pump();
    return this.clearWanted === undefined ? "done" : "waiting";
  }

  /**
   * 中途换运行时（289 号票，见文件开头）：手头这一条处理完，原来的写交接摘要、停掉，会话里记一条"已换成"，新的新开一段会话、
   * 交接摘要跟在下一条输入后面；换完由 runtimeSwitch.commit 把维护者的运行时改成新的。正在换的时候又要换的：换成最后要的那个
   * （已经在写交接摘要的照样写完，按最后要的换）。换成现在用的那个、又没在换：什么都不做
   */
  switchRuntime(to: string, options: RuntimeChoice | undefined): void {
    if (this.stopped) throw new Error(t("conversation.session.stopped", { who: this.who() }));
    if (!this.options.runtimeSwitch) throw new Error(`${this.options.label}（${this.options.agentId}）的会话不能换运行时`); // @i18n-ignore log：编程错误
    if (this.runtimeWanted) {
      this.runtimeWanted.to = to;
      this.runtimeWanted.options = options;
      return;
    }
    if (to === this.options.runtimeSwitch.current()) return;
    this.runtimeWanted = { to, options, state: "waiting", running: false };
    this.pump();
  }

  /** 现在压缩（114 号票）：手头这一条处理完再压，没有子进程先拉起（接着同一个会话）；已经在等、在压时什么都不做 */
  compactNow(): void {
    if (this.stopped || this.compacting || this.compactWanted) return;
    this.compactWanted = true;
    this.pump();
  }

  /**
   * 开始接输入：上次被打断的输入标成中断（不重送）；以前彻底删除过的先把会话文件对一遍；
   * 然后常驻的拉起，按需的有输入等着才唤起
   */
  start(): void {
    const { store, conversation } = this.options;
    // 会话里来了消息：闲着就开始处理；有消息被彻底删除了：闲着就改写会话文件
    this.unsubscribe = store.onAppend((event) => {
      if (event.channel !== conversation) return;
      if (event.type === EVENT_TYPES.message) {
        this.maybeInterject(event.payload as MessageEventPayload);
        this.pump();
      }
      // 语音识别有了结局（31 号票）：等着它的那条输入现在可以交过去了
      if (event.type === EVENT_TYPES.voice) this.pump();
      if (event.type === EVENT_TYPES.messagesPurged && this.options.sessionRewriteFor) {
        this.pendingPurges.push(event.payload as MessagesPurgedEventPayload);
        this.pump();
      }
    });
    // 挡板的规矩变了（214 号票：语音插件运行中停用了，还没识别完的语音不再挡队列；启用了，又照它的规矩挡）：再看一眼队首
    this.offGate = this.options.onGateChange?.(() => this.pump());
    this.interruptStartedInputs();
    // 上次停下时还排着的消息（144 号票）：这时不在回复，交出去
    this.deliverQueued();
    // 以前清空过（114 号票）、换过运行时（289 号票）：之后拉起都带上那一段的名字（新开过就照常接着它）
    this.freshSession = latestSessionName(store, conversation);
    const purgedBefore = this.options.sessionRewriteFor
      ? store.read(conversation, 0, EVENT_TYPES.messagesPurged).map((e) => e.payload as MessagesPurgedEventPayload)
      : [];
    if (purgedBefore.length > 0) this.relaunch(() => this.rewriteSessions(purgedBefore), 0);
    else this.pump();
  }

  /** 状态变了（能处理输入了、有新的装配）：看一眼队首 */
  poke(): void {
    this.pump();
  }

  /** 换一套装配：手头这一条处理完就停掉子进程，下次唤起按新的装配拉起（接着同一个会话） */
  refresh(): void {
    this.stale = true;
    this.pump();
  }

  /**
   * 工具包变了（27 号票）：正在处理一条输入时让它做完手头这一步就停下、按新的装配重新拉起、接着干（见文件开头）；
   * 闲着时停掉子进程；休眠时什么都不用做。notice 是告诉 agent 的那句"工具包已变更：……"
   */
  reassemble(notice: string): void {
    if (this.stopped) return;
    if (this.resume?.restart) {
      // 已经停在两次模型调用之间、还没重新拉起（等范围审视做完）：拉起时取的就是最新的装配，这句话一起带过去
      this.resume.notice = joinContext(this.resume.notice, notice) ?? notice;
      return;
    }
    // 能当场换工具包的运行时（291 号票）：子进程就绪着就当场换，不停下、不重新拉起
    if (this.held?.live && this.held.proc === this.proc && this.ready && this.proc?.state === "running" && this.retool(notice)) return;
    const busy = this.current !== undefined && this.ready && this.proc?.state === "running";
    if (!busy) {
      this.pendingNotice = joinContext(this.pendingNotice, notice);
      if (this.proc) this.stale = true;
      return this.pump();
    }
    this.stale = true;
    this.yieldNotice = joinContext(this.yieldNotice, notice);
    try {
      this.proc!.send({ type: "yield" });
    } catch {
      // 刚好退出了：重新拉起时自然按新的装配
    }
  }

  /**
   * 工具包当场换（291 号票，见文件开头）：现取此刻的装配，守护进程这边按新的代为执行、判定、计时，送 toolkit 给子进程。
   * 送不出去（刚好退出了）交回 false，照旧的路子（重新拉起时自然按新的装配）
   */
  private retool(notice: string): boolean {
    const held = this.held;
    const { options } = this;
    if (!held || !options.retool) return false;
    let skillPaths: readonly string[];
    let hostTools: readonly HostTool[];
    let guard: AgentSessionGuard;
    try {
      ({ skillPaths } = options.retool());
      hostTools = options.hostTools();
      guard = options.guard();
    } catch (err) {
      // 取不到此刻的装配：照旧的路子（停掉、按新的装配重新拉起时再取）
      options.log(`${options.label}（${options.agentId}）当场换工具包时取不到装配：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    const { runtimeTools, agent } = guard;
    try {
      held.proc.send({ type: "toolkit", tools: hostTools.map((tool) => tool.spec), skillPaths: [...skillPaths], notice });
    } catch {
      return false;
    }
    held.hostTools = hostTools;
    held.agent = agent;
    held.registry = sessionRegistry(hostTools, runtimeTools);
    held.proc.retool({ toolTimeouts: hostToolTimeouts(hostTools), toolTitles: Object.fromEntries(hostTools.map((tool) => [tool.spec.name, tool.descriptor.title])) });
    // 用户打的 /目录名 展开（二狗的 skill 交给运行时的不展开，slashPassthrough）也按新的
    this.inputContext.skillDirs = [...skillPaths];
    options.log(`${options.label}（${options.agentId}）的工具包当场换了：${notice}`);
    return true;
  }

  /**
   * 停稳手头这一轮（84 号票：从某个阶段重做之前，先 abort 再 waitForIdle）：先拦住不再开始下一条输入，中止手头这一轮，
   * 等它真的结束（最多 timeoutMs）。到点还没结束的，这一轮之后的工具调用守卫一律不放行（交回 reason）。
   * 返回放开的函数（重复叫只算一次）：调用方提交了它的变化再放开，会话接着处理排着的输入
   */
  async stopTurn(timeoutMs: number, reason: string): Promise<{ stopped: boolean; release: () => void }> {
    this.holds++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.holds--;
      this.pump();
    };
    const input = this.current;
    if (input === undefined) return { stopped: true, release };
    // 已经按 yield 停下、等着按新的装配接着干（子进程这一轮已经结束，abort 送不到）：直接按中止结束
    if (this.resume) {
      this.endYieldedTurn(input);
      return { stopped: true, release };
    }
    this.abortTurn();
    const stopped = await new Promise<boolean>((resolve) => {
      const check = () => {
        if (this.current === input) return;
        clearTimeout(timer);
        this.turnWaiters.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.turnWaiters.delete(check);
        resolve(false);
      }, timeoutMs);
      this.turnWaiters.add(check);
      check();
    });
    if (!stopped) this.superseded = { input, reason };
    return { stopped, release };
  }

  /** 有人要停下这一轮（stopTurn 还拦着，或者到点没停下、作废了）：它不再接着干 */
  private stopWanted(input: string | undefined): boolean {
    return input !== undefined && (this.holds > 0 || this.superseded?.input === input);
  }

  /**
   * 按 yield 停下的这一轮不再接着干（84 号票：停稳期间）：按中止结束；还要换的装配照样换（resume、stale 留着），
   * "工具包已变更"跟在下一条输入后面
   */
  private endYieldedTurn(input: string): void {
    this.pendingNotice = joinContext(this.pendingNotice, this.resume?.notice ?? this.yieldNotice);
    if (this.resume) this.resume.notice = "";
    this.yieldNotice = undefined;
    this.finishTurn(input, "aborted");
    this.endCurrent();
    this.notifyTurnWaiters();
  }

  /** 状态变了（这一轮结束了）：等它结束的各自看一眼 */
  private notifyTurnWaiters(): void {
    // 各自看到这一轮结束就把自己从集合里删掉：边遍历边删当前这个是安全的
    for (const check of this.turnWaiters) check();
  }

  /** 正在处理的那一轮作废了（stopTurn 到点没停下）：原因；不是就 undefined */
  private supersededReason(): string | undefined {
    if (this.superseded && this.superseded.input !== this.current) this.superseded = undefined;
    return this.superseded?.reason;
  }

  /** 中止手头这一轮（任务暂停、取消）；没在处理就什么都不做 */
  abortTurn(): void {
    if (this.current === undefined || this.proc?.state !== "running") return;
    try {
      this.proc.send({ type: "abort" });
    } catch {
      // 刚好退出了
    }
  }

  /** 正在回复（144 号票：处理着一条输入，追问口语总结不算）：输入框上有"停止"，用户发的话排队 */
  get replying(): boolean {
    return this.current !== undefined && this.asking === undefined;
  }

  /**
   * 用户点了停止（144 号票）：中止手头这一轮（照 abortTurn：已经说出来的留着、正在执行的工具按中止处理），这一轮以中止结束时
   * 时间线上记一笔"你停止了这一轮"，会话回到空闲，排队的消息马上交出去作为下一轮。停的只是这一轮：任务的状态不动。
   * 没在回复时什么都不做，返回 false
   */
  stopReply(): boolean {
    const input = this.current;
    if (this.stopped || input === undefined || this.asking) return false;
    this.userStop = input;
    this.options.log(`用户停止了${this.options.label}（${this.options.agentId}）这一轮`);
    // 已经按 yield 停下、等着按新的装配接着干（子进程这一轮已经结束，abort 送不到）：直接按中止结束，装配照样换
    if (this.resume) {
      this.endYieldedTurn(input);
      this.pump();
      return true;
    }
    this.abortTurn();
    return true;
  }

  /**
   * 会话树上挪（150 号票：会话回退；151 号票：切换分支）。做法：先停稳手头这一轮（stopTurn：abort 再等它结束，
   * 到点没停下就不挪，抛出原因），拦着不交排队的消息、不开始下一条输入；子进程不在（休眠、正在重新拉起）就先拉起来；送 navigate_session，
   * 等子进程挪完（回退时它先写分支摘要）。挪成了在放开之前调 commit（调用方把分支事件写进事件日志——之后交出去的排队消息才落在新分支上），
   * 再放开：排着的消息交出去作为新分支的下一轮。没挪成抛出原因，会话没动
   */
  async navigateSession(
    request: SessionNavigation,
    commit: (navigated: SessionNavigated) => void,
    timeouts: { stopMs: number; readyMs: number } = { stopMs: NAVIGATE_STOP_TIMEOUT_MS, readyMs: NAVIGATE_READY_TIMEOUT_MS },
  ): Promise<SessionNavigated> {
    const who = `${this.options.label}（${this.options.agentId}）`; // @i18n-ignore log：日志里的称呼
    // 回退叫"撤回"，切换分支（151 号票）叫"切换"
    const switching = request.marker.change === "switch";
    if (this.stopped) throw new RequestRejected("not_allowed", t("conversation.session.stopped", { who: this.who() }));
    if (this.navigating) throw new RequestRejected("conflict", t("conversation.session.navigating"));
    this.navigating = true;
    // 等着的追问（32 号票：回复长、没写口语总结时追问一句）问的是被放弃的那段，不问了
    this.dropFollowUp();
    // @i18n-ignore-next model：这一轮之后的调用回给 agent 的原因
    const { stopped, release } = await this.stopTurn(timeouts.stopMs, switching ? "用户切换了分支，这一轮作废了" : "用户撤回了会话，这一轮作废了");
    try {
      if (!stopped) throw new RequestRejected("not_allowed", t(switching ? "conversation.session.switchNotStopped" : "conversation.session.rollbackNotStopped", { who: this.who() }));
      this.dropFollowUp();
      const proc = await this.readyProcess(timeouts.readyMs);
      // 写分支摘要时不闲置退出（按需的维护者，152 号票）
      const awake = proc.holdAwake("navigate");
      try {
        const requestId = randomUUID();
        // 分支摘要（293 号票）：运行时自己写的交给它写；不自己写的二狗先按自己的记录写好（没写成就不挪，会话没动）
        const summary = await this.navigationSummary(request);
        const report = await new Promise<SessionNavigatedReport | Error>((resolve) => {
          this.navigations.set(requestId, { proc, settle: resolve });
          try {
            proc.send({ type: "navigate_session", requestId, target: request.target, marker: request.marker, ...(summary.command ? { summary: summary.command } : {}) });
          } catch (err) {
            this.navigations.delete(requestId);
            resolve(err instanceof Error ? err : new Error(String(err)));
          }
        });
        if (report instanceof Error) throw new RequestRejected("internal", t(switching ? "conversation.session.switchFailed" : "conversation.session.rollbackFailed", { error: report.message }));
        if (!report.ok) throw new RequestRejected("not_allowed", report.error);
        const text = report.summary ?? summary.text;
        const navigated: SessionNavigated = {
          from: report.from,
          at: report.at,
          ...(text === undefined ? {} : { summary: text }),
          session: this.sessionName,
          ...(report.files === undefined ? {} : { files: report.files }),
        };
        this.options.log(`${who}在会话树上挪了：${request.marker.change} → ${request.marker.branchId}`);
        commit(navigated);
        return navigated;
      } finally {
        awake();
      }
    } finally {
      this.navigating = false;
      release();
    }
  }

  /**
   * 撤回时的分支摘要交给子进程的样子（293 号票）：子进程的运行时自己写的（pi）照旧交 instructions；不自己写的（Claude Code）二狗按被放弃的那段里
   * 自己记下的事件、用拉起它时的二狗模型和凭据另起一次写（一次性子进程，用量记在这个 agent 名下、purpose 是 branch_summary），交 written，
   * 给人看的那段（text）留着记进分支摘要那条消息。那段里没有可写的（只有分隔线这些）就不写，同 pi；没写成抛出原因（not_allowed，会话没动）
   */
  private async navigationSummary(request: SessionNavigation): Promise<{ command?: { instructions: string } | { written: string }; text?: string }> {
    const wanted = request.summary;
    if (!wanted) return {};
    if (this.options.ownBranchSummary?.(this.spawnedRuntime) !== false) return { command: { instructions: wanted.instructions } };
    const turns = recordedTranscript(this.options.store, this.options.conversation, wanted.abandoned?.() ?? []);
    if (turns.length === 0 || this.spawnedModel === undefined) return {};
    try {
      const written = await this.options.agents.recordedGeneration(
        { task: { kind: "branch_summary", instructions: wanted.instructions }, model: this.spawnedModel, credentials: this.spawnedCredentials, turns, usageId: `branch-summary-${request.marker.branchId}` },
        { agentId: this.options.agentId, attribution: this.usageAttribution() },
      );
      if (written.kind !== "branch_summary") return {};
      return written.context ? { command: { written: written.context }, text: written.text } : {};
    } catch (err) {
      throw new RequestRejected("not_allowed", t("conversation.session.rollbackFailed", { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** 范围审视由二狗另起（309 号票）：现在的子进程（没有子进程时是要拉起的那个）的运行时自己不审视 */
  private recordedReviews(): boolean {
    const runtime = this.proc ? this.spawnedRuntime : (this.options.runtimeSwitch?.current() ?? this.spawnedRuntime);
    return this.options.recordedScopeReview?.(runtime) === true;
  }

  /** 等到有一个就绪的子进程（会话树上挪要它）：没有就拉起（休眠的、意外退出等着重拉的、改写完会话文件的），到点还没有就抛出 */
  private async readyProcess(timeoutMs: number): Promise<ManagedAgent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.stopped) throw new RequestRejected("not_allowed", t("conversation.session.stopped", { who: this.who() }));
      if (this.proc && this.ready && this.proc.state === "running") return this.proc;
      // 拉不起（286 号票：运行时插件没启用）：不等到点，直接回原因
      const blocked = this.proc ? undefined : this.options.launchBlocked?.();
      if (blocked !== undefined) throw new RequestRejected("not_allowed", blocked);
      // 拦着的时候 pump 不拉起：这里拉（等着退避重拉的计时器先停掉）
      if (!this.proc && !this.relaunching) {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.spawn();
      }
      if (Date.now() > deadline) throw new RequestRejected("internal", t("conversation.session.notReady", { who: this.who() }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * 会话里要判定副作用的工具（守卫的工具注册表：框架自带的加上这个会话代为执行的工具、运行时自带的工具（288 号票）；
   * 150 号票回退前列出做了的事用）
   */
  effectTools(): ToolRegistry {
    return sessionRegistry(this.options.hostTools(), this.options.guard().runtimeTools);
  }

  /** 换成最新的重注入块：活着的子进程在下一条输入之前、下次压缩之后注入它（重新拉起时由装配给；宿主协议 18 起按 id 换通用贡献清单里那一块） */
  setContextBlock(text: string): void {
    if (this.proc?.state !== "running") return;
    try {
      this.proc.send({ type: "contribution", id: REINJECTION_BLOCK_ID, text });
    } catch {
      // 刚好退出了：下次唤起时装配里有最新的
    }
  }

  /**
   * 让子进程审视这个会话里还没审视过的部分（18 号票：工单结束时）：子进程活着就送 scope_review；没有子进程（闲置退出了、
   * 守护进程重启过）就按当前的装配拉起一个再送。结果回来、子进程中途退出、超时都兑现（后两种 error 写原因）
   */
  reviewScope(timeoutMs: number): Promise<ScopeReviewResult> {
    if (!this.reviews) throw new Error(`${this.options.label}（${this.options.agentId}）的会话没有装配范围审视`); // @i18n-ignore log：编程错误
    return this.reviews.request(timeoutMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.reviews?.stop();
    this.unsubscribe?.();
    this.offGate?.();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const proc = this.proc;
    if (proc) {
      proc.kill();
      await proc.exited;
    }
    this.setStatus("stopped");
  }

  /**
   * 闲着时：有要改写的会话文件先改写；有追问等着先追问；有输入等着时没有子进程就唤起（常驻的总是拉起），
   * 就绪了就把队首的那条交过去
   */
  private pump(): void {
    if (this.stopped) return;
    // 不在回复：排队的消息先交出去（144 号票；它们在输入队列里排在已经排着的后面）
    if (this.current === undefined && !this.clearing) this.deliverQueued();
    if (this.relaunching || this.retryTimer || this.clearing) return;
    // stopTurn 拦着（84 号票）：按 yield 停下的那一轮只换装配、不再接着干（resumeTurn 里看），不开始下一条，等调用方提交了它的变化、放开
    if (this.resume) return this.resumeTurn();
    if (this.holds > 0) return;
    if (this.current !== undefined) return;
    // 正在压缩（114 号票）：压完再交下一条
    if (this.compacting) return;
    // 换运行时（289 号票）：手头这一条处理完就换，换完再交下一条（任务暂停着也能换）
    if (this.runtimeWanted) return this.switchRuntimeWhenIdle();
    // 清空当前对话（114 号票）：手头这一条处理完就清，排着的输入交给新开的那一段
    if (this.clearWanted !== undefined) return this.clearWhenIdle();
    if (this.pendingPurges.length > 0) return this.rewriteWhenIdle();
    if (this.stale) return this.restartWhenIdle();
    // 现在压缩（114 号票）：任务暂停着也能压（不干活）
    if (this.compactWanted) return this.compactWhenIdle();
    if (this.options.canProcess && !this.options.canProcess()) return this.dropFollowUp();
    if (this.followUp) return this.askFollowUp(this.followUp);
    const { store, conversation } = this.options;
    const next = this.nextInput();
    if (!this.proc) {
      if (next || this.options.resident || this.reviews?.waiting) this.spawn();
      return;
    }
    if (!next) return;
    if (this.options.outdated?.()) {
      this.stale = true;
      return this.restartWhenIdle();
    }
    if (!this.ready || this.proc.state !== "running") return;
    // 换模型（83 号票）：接着的会话和设置里的不一样、这条输入之前又能换，停掉子进程，带上 handoff 重新拉起再交
    if (this.switchDue(next)) {
      this.stale = true;
      return this.restartWhenIdle();
    }
    // 当插话送过、子进程没收下的：照常作为一条输入送
    this.interjected.delete(next.messageId);
    const message = getMessage(store.reader, next.messageId);
    if (!message) {
      this.finishTurn(next.messageId, "error", `找不到消息 ${next.messageId}`); // @i18n-ignore log：不该发生的内部错误
      return this.pump();
    }
    // 排队交出的一批（144 号票）：同一批后面几条一起交过去
    const more = this.batchAfter(next);
    if (!more) return;
    const batch = [message, ...more];
    const last = batch.at(-1)!;
    this.current = message.id;
    this.currentMore = batch.slice(1).map((m) => m.id);
    this.inputScope = next.scope;
    this.setStatus("busy");
    // 工具包在 agent 闲着、休眠时变过（27 号票）：那句"工具包已变更"跟在这条输入后面
    const ownContext = joinContext(
      this.pendingNotice,
      this.options.inputContext?.(message),
      // 用不用语音回复看这一轮最后一条（32 号票）：说明跟着最后一条
      this.options.voiceReplies?.inputContext(last),
    );
    // 插件的每轮上下文块（128 号票）排在最后；266 号票起可以是异步的（记忆简报），和附件一起等齐
    const contributed = this.options.contributions?.inputContext(message);
    this.pendingNotice = undefined;
    // 范围审视的对照物或近期范围记录变了：先送过去（这条输入之前的 before_agent_start 拼的就是最新的）
    this.reviews?.sync(this.proc);
    // 插件的上下文块、钩子订阅的文字变了：同样先送过去（这条输入之前注入、拼的就是最新的）
    this.syncContributions(this.proc);
    const started: TurnStartEventPayload = { inputMessageId: message.id, ...(this.currentMore.length > 0 ? { moreInputMessageIds: [...this.currentMore] } : {}) };
    store.append({ channel: conversation, type: EVENT_TYPES.turnStart, payload: started });
    // 附件的内容要读文件（PDF 还要抽文本），是异步的；准备好时还是同一个子进程、还在处理这一条，才交过去
    const proc = this.proc;
    const stillCurrent = () => this.proc === proc && this.current === message.id;
    Promise.all([Promise.all(batch.map((m) => prepareAgentInput(this.inputContext, m))), Promise.resolve(contributed).catch(() => undefined)]).then(
      ([prepared, plugins]) => {
        if (!stillCurrent()) return;
        const context = joinContext(ownContext, plugins);
        // 这一轮的回话要带上的 part（266 号票）：插件那几块算好了才取
        const parts = this.options.contributions?.replyParts?.(message) ?? [];
        this.turnParts = parts.length > 0 ? { input: message.id, parts: [...parts] } : undefined;
        // 一批的几条：文字按先后拼成一条（每条照旧带自己的时间标记），图片按先后跟着
        const input = { text: prepared.map((p) => p.text).join("\n\n"), images: prepared.flatMap((p) => p.images) };
        try {
          proc.send({
            type: "user_input",
            inputId: message.id,
            text: input.text,
            ...(input.images.length > 0 ? { images: input.images } : {}),
            ...(context === undefined ? {} : { context }),
          });
        } catch (err) {
          // 子进程刚好退出了：这条在退出时按中断处理
          this.options.log(`交给${this.options.label}（${this.options.agentId}）的输入没送出去：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      (err: unknown) => {
        if (!stillCurrent()) return;
        const reason = err instanceof Error ? err.message : String(err);
        this.options.log(`准备${this.options.label}（${this.options.agentId}）的输入出错：${reason}`);
        this.systemNote(turnFailedNote(this.options.displayName ?? this.options.label, t("conversation.session.attachmentFailed", { reason })));
        this.finishTurn(message.id, "error", reason);
        this.endCurrent();
        this.setStatus("idle");
        this.pump();
      },
    );
  }

  /**
   * 子进程按 yield 停下之后（27 号票）：按新的装配拉起（接着同一个会话），就绪后把"工具包已变更"作为一条输入交过去，
   * 接着手头那条输入干（它仍在处理中）。这时任务已经不能处理输入了（暂停、取消）：手头那条以中止结束
   */
  private resumeTurn(): void {
    const resume = this.resume!;
    if (resume.restart) {
      // 范围审视在做时不换装配（子进程还要交审视的结果，18 号票）：审视兑现之后（settled 会再 pump）再停
      if (this.reviews?.inFlight) return;
      resume.restart = false;
      const proc = this.proc;
      // 这次退出是计划内的：onExit 看到它不是当前的子进程就不当崩溃处理
      this.proc = undefined;
      this.ready = false;
      return this.relaunch(async () => {
        if (!proc) return;
        proc.kill();
        await proc.exited;
      }, 0);
    }
    if (!this.proc) return this.spawn();
    if (!this.ready || this.proc.state !== "running") return;
    // 停稳期间（84 号票）：这一轮不再接着干
    if (this.current !== undefined && this.stopWanted(this.current)) this.endYieldedTurn(this.current);
    this.resume = undefined;
    const current = this.current;
    if (current === undefined) {
      this.setStatus("idle");
      return this.pump();
    }
    if (this.options.canProcess && !this.options.canProcess()) {
      this.finishTurn(current, "aborted");
      this.endCurrent();
      this.setStatus("idle");
      return this.pump();
    }
    try {
      this.proc.send({ type: "user_input", inputId: `toolkit-${current}-${this.spawns}`, text: resume.notice });
    } catch (err) {
      // 子进程刚好退出了：手头这条在退出时按中断处理
      this.options.log(`交给${this.options.label}（${this.options.agentId}）的"工具包已变更"没送出去：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 这条输入这时挡不挡（31、210 号票；214 号票起问挡板 inputGate）：ready 能交；waiting（语音在第一次识别中）等着、后面的也不越过它；
   * deferred（语音在自动重试；语音插件不在时只有语音、还没识别完的）等着、但不挡后面的
   */
  private gateOf(messageId: string): InputGate {
    const message = getMessage(this.options.store.reader, messageId);
    if (message === undefined) return "ready";
    return this.options.inputGate?.(message) ?? unattendedInputGate(this.options.store.reader, message);
  }

  /**
   * 这条能当插话送了：它自己的语音都识别出了结局，队里排在它之前（正在处理的那条除外）的没有还在第一次识别的语音——
   * 不越过前面没识别完的（31 号票）；前面等着自动重试的不挡它（210 号票）
   */
  private settledUpTo(messageId: string): boolean {
    for (const queued of pendingInputs(this.options.store.reader, this.options.conversation)) {
      if (queued.messageId === messageId) break;
      if (queued.messageId !== this.current && this.gateOf(queued.messageId) === "waiting") return false;
    }
    return this.gateOf(messageId) === "ready";
  }

  /**
   * 下一条要处理的输入：按先后，给了 accepts 时跳过现在不处理的（16 号票：留在队里，不挡着后面的）；
   * 要处理的那条是还在第一次识别的语音（31 号票）：它在队里等着，后面的也不越过它，也不为它唤起 agent，识别有了结局（voice 事件）再看；
   * 是进了自动重试的语音（210 号票）：它留在队里等着，不挡后面的，接着往后找
   */
  private nextInput() {
    const accepts = this.options.accepts;
    for (const queued of pendingInputs(this.options.store.reader, this.options.conversation)) {
      if (accepts && !accepts(queuedAgentInput(this.options.store, queued))) continue;
      const gate = this.gateOf(queued.messageId);
      if (gate === "deferred") continue;
      return gate === "ready" ? queued : undefined;
    }
    return undefined;
  }

  /**
   * 排队交出的一批里排在这条后面的几条（144 号票：同一个 queueDelivery、还在等着、现在处理的），按先后；不是一批里的是空的。
   * 一批里还有在第一次识别的语音时整批等着（undefined），识别有了结局（voice 事件）再看；进了自动重试的那条不等（210 号票：
   * 它留在队里，有了结局再单独交）。按队列的先后往后数（210 号票起有了结局的语音排到末尾，不能按消息的序号比）
   */
  private batchAfter(head: QueuedInput): MessageEnvelope[] | undefined {
    const { store, conversation, accepts } = this.options;
    const delivery = queuedAgentInput(store, head).payload.queueDelivery;
    if (delivery === undefined) return [];
    const out: MessageEnvelope[] = [];
    let afterHead = false;
    for (const queued of pendingInputs(store.reader, conversation)) {
      if (!afterHead) {
        afterHead = queued.messageId === head.messageId;
        continue;
      }
      const input = queuedAgentInput(store, queued);
      if (input.payload.queueDelivery !== delivery) break;
      if (accepts && !accepts(input)) break;
      const gate = this.gateOf(queued.messageId);
      if (gate === "deferred") continue;
      if (gate === "waiting") return undefined;
      const message = getMessage(store.reader, queued.messageId);
      if (message) out.push(message);
    }
    return out;
  }

  /**
   * 排队的消息交出去（144 号票）：交出去的那一批追加成普通的用户消息，接着由输入队列交给 agent。上一轮还没出队（被打断的那一轮
   * 正在标中断）时不交，出了队再交
   */
  private deliverQueued(): void {
    // 正在会话树上挪（150 号票）：交了会落在被放弃的那段里，挪完（分支事件写进事件日志之后）再交
    if (this.navigating) return;
    if (!this.options.queue || replying(this.options.store.reader, this.options.conversation)) return;
    try {
      const ids = this.options.queue.deliver(this.options.conversation);
      if (ids.length > 0) this.options.log(`${this.options.label}（${this.options.agentId}）交出排队的 ${ids.length} 条消息`);
    } catch (err) {
      this.options.log(`${this.options.label}（${this.options.agentId}）交出排队的消息出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }

  /**
   * 换模型（83 号票）：处理这条输入之前要不要停掉活着的子进程、带上 handoff 重新拉起——接着的会话和装配参数里的不一样
   * （就绪时报的），或者设置在子进程拉起之后改了（换不换由子进程比对会话开始时的），而且这条输入之前能换、还没为它试过
   */
  private switchDue(next: QueuedInput): boolean {
    const sw = this.options.modelSwitch;
    if (!sw || next.messageId === this.switchTriedFor) return false;
    const changed = this.spawnedModel !== undefined && sameModel(this.spawnedModel, sw.wanted()) === false;
    if (!this.modelDiffers && !changed) return false;
    return sw.allowed(queuedAgentInput(this.options.store, next));
  }

  /**
   * 这次拉起要不要带上 handoff（83 号票）：下一条要处理的输入之前能换、还没为它试过（换没换成都只试一次）。处理到一半重新拉起
   * （工具包变了接着干、追问）不带：手头那一轮还要在原来的会话里做完
   */
  private handoffFor(): { instructions: string } | undefined {
    const sw = this.options.modelSwitch;
    if (!sw || this.current !== undefined || this.resume || this.followUp) return undefined;
    const next = this.nextInput();
    if (!next || next.messageId === this.switchTriedFor || !sw.allowed(queuedAgentInput(this.options.store, next))) return undefined;
    this.switchTriedFor = next.messageId;
    return { instructions: sw.instructions() };
  }

  /**
   * 闲着时清空当前对话（114 号票）：会话里记一条分隔线，之后拉起时按它的名字新开一段会话；有子进程就停掉（常驻的马上按新的一段拉起）。
   * 审视在做时不清（子进程还要交审视的结果），做完了再看。手头的追问、"工具包已变更"的说明、等着的压缩都不带到新的一段
   */
  private clearWhenIdle(): void {
    if (this.reviews?.inFlight) return;
    const key = this.clearWanted!;
    this.clearWanted = undefined;
    const { store, conversation } = this.options;
    const built = buildMessage({ conversation, speaker: "system", parts: [{ type: "conversation_cleared" }] }, { ...this.scope(), idempotencyKey: `clear:${conversation}:${key}` });
    // 写分隔线时挡住重入的 pump（见 clearing）：不然排着的那条（秘书不收插话，用户接着说的；维护者排着的运行时通知）会交给旧的子进程
    this.clearing = true;
    let appended: ReturnType<typeof store.append>;
    try {
      appended = store.append(built.event);
    } finally {
      this.clearing = false;
    }
    const { event, duplicate } = appended;
    if (duplicate) return this.pump();
    const marker = (event.payload as MessageEventPayload).message;
    this.freshSession = clearedSessionName(marker.id);
    this.options.log(`${this.options.label}（${this.options.agentId}）清空了当前对话：新开一段会话 ${this.freshSession}`);
    this.pendingNotice = undefined;
    this.compactWanted = false;
    this.switchTriedFor = undefined;
    this.dropFollowUp();
    this.stale = true;
    this.restartWhenIdle();
  }

  /** 闲着时现在压缩（114 号票）：没有子进程先拉起，就绪了送 compact；压缩时拿着不闲置退出，压完（compacted）放开 */
  private compactWhenIdle(): void {
    if (this.reviews?.inFlight) return;
    if (!this.proc) return this.spawn();
    if (!this.ready || this.proc.state !== "running") return;
    this.compactWanted = false;
    const proc = this.proc;
    this.compacting = proc.holdAwake("compact");
    this.setStatus("busy");
    try {
      proc.send({ type: "compact" });
    } catch {
      // 刚好退出了：退出时按没压成收尾
    }
  }

  /** 压缩结束了（114 号票）：压好了在时间线上记一笔；是"现在压缩"要的就记下结果、接着处理排着的输入 */
  private onCompacted(report: CompactedReport): void {
    if (report.outcome === "done") {
      const detail =
        report.tokensBefore === undefined
          ? t("conversation.compaction.detail", { why: COMPACTION_REASON_TEXT[report.reason] })
          : t("conversation.compaction.detailWithTokens", { why: COMPACTION_REASON_TEXT[report.reason], tokens: tokensText(report.tokensBefore) });
      const { event } = buildTimelineRecord(this.options.conversation, { kind: "compaction", summary: t("conversation.compaction.summary"), detail }, this.scope());
      this.options.store.append(event);
    }
    if (report.reason !== "manual" || !this.compacting) return;
    this.endCompaction({ outcome: report.outcome === "done" ? "done" : report.outcome === "nothing" ? "nothing" : "failed", at: nowIso(), ...(report.outcome === "failed" ? { message: report.error ?? t("conversation.compaction.failed") } : report.outcome === "aborted" ? { message: t("conversation.compaction.aborted") } : {}) });
    this.setStatus("idle");
    this.pump();
  }

  /** "现在压缩"结束：放开不闲置退出，记下结果 */
  private endCompaction(result: AgentCompactResult): void {
    this.compacting?.();
    this.compacting = undefined;
    this.lastCompact = result;
  }

  /** 插件的上下文块、钩子订阅此刻的文字和子进程手里的不一样的，按 id 送过去（128 号票） */
  private syncContributions(proc: ManagedAgent): void {
    const manifest = this.options.contributions?.manifest();
    if (!manifest) return;
    for (const { id, text } of [...manifest.contextBlocks, ...manifest.hooks]) {
      if (this.contributed.get(id) === text) continue;
      try {
        proc.send({ type: "contribution", id, text });
        this.contributed.set(id, text);
      } catch {
        // 刚好退出了：下次唤起时装配里有最新的
      }
    }
  }

  private spawn(): void {
    const { options } = this;
    // 拉不起（286 号票）：什么都不动，等拉起它的模块 poke()
    if (options.launchBlocked?.() !== undefined) return;
    this.stale = false;
    const request = options.spawn(++this.spawns);
    // 插件经 agent 贡献缝给的上下文块、钩子订阅（128 号票）：放进装配参数，记下这次给的文字
    const contributed = options.contributions?.manifest();
    this.contributed = new Map([...(contributed?.contextBlocks ?? []), ...(contributed?.hooks ?? [])].map((c) => [c.id, c.text]));
    const handoff = this.handoffFor();
    this.spawnedModel = request.model;
    this.spawnedCredentials = { ...request.credentials };
    this.spawnedRuntime = request.runtime ?? PI_RUNTIME_ID;
    this.modelDiffers = false;
    this.switching = handoff !== undefined;
    const hostTools = options.hostTools();
    const { runtimeTools, ...guard } = options.guard();
    // 实际能不能看图等子进程在 ready 里报回（模型目录只有子进程查得到）；就绪之前不交输入
    this.inputContext.vision = false;
    // 这次装配了的 skill：用户打 /目录名、/skill:目录名 时在加时间标记之前展开（72、82 号票）
    this.inputContext.skillDirs = request.skillPaths ?? [];
    // 子进程的运行时能转交斜杠命令的（289 号票，Claude Code）：用户打的 /命令 原样交给它；二狗的 skill 换成运行时里的写法（309 号票）
    this.inputContext.slashPassthrough = options.slashPassthrough?.(request.runtime ?? PI_RUNTIME_ID) === true;
    const slash = this.inputContext.slashPassthrough ? options.runtimeSlash?.(request.runtime ?? PI_RUNTIME_ID) : undefined;
    if (slash) this.inputContext.runtimeSlash = slash;
    else delete this.inputContext.runtimeSlash;
    const vision = options.configuredVision();
    // 接着会话：被中断的发语音调用补"会自己补发、不要重发"（86 号票），请求里给的优先
    const voiceResults = request.continueSession ? options.voiceReplies?.interruptedResults?.(options.conversation) : undefined;
    const proc = options.agents.spawn({
      ...request,
      ...(voiceResults && Object.keys(voiceResults).length > 0 ? { interruptedToolResults: { ...voiceResults, ...request.interruptedToolResults } } : {}),
      ...(Object.keys(vision).length === 0 ? {} : { vision }),
      ...(this.reviews ? { scopeReview: this.reviews.setup(this.spawns) } : {}),
      ...(handoff ? { handoff } : {}),
      // 清空过（114 号票）：那一段还没有就新开，有了照常接着
      ...(this.freshSession === undefined ? {} : { freshSession: this.freshSession }),
      ...(contributed && (contributed.contextBlocks.length > 0 || contributed.hooks.length > 0) ? { contributions: contributed } : {}),
      agentId: options.agentId,
      hostTools: hostTools.map((tool) => tool.spec),
      toolTimeouts: hostToolTimeouts(hostTools),
      toolTitles: Object.fromEntries(hostTools.map((tool) => [tool.spec.name, tool.descriptor.title])),
      forwardToolCalls: true,
      ...(options.resident ? { resident: true } : {}),
      ledger: () => this.usageAttribution(),
    });
    this.proc = proc;
    this.ready = false;
    this.setStatus("starting");
    // 这个子进程手里的工具（291 号票：能当场换工具包的运行时换了之后，守卫、代为执行都按换后的）
    // 带类型的 bash 工具（28）、联网搜索和读网页（70）也是代为执行的，但登记的就是框架自带的那份（来源 typed_shell、web），不再加一遍；
    // 运行时自带的工具（288：Claude Code 的 TodoWrite、Agent……）的登记接在后面
    const held = {
      proc,
      live: options.liveToolkit?.(request.runtime ?? PI_RUNTIME_ID) === true && options.retool !== undefined,
      hostTools,
      agent: guard.agent,
      registry: sessionRegistry(hostTools, runtimeTools),
    };
    this.held = held;
    // 调用记忆的结构化部分（187 号票）：工具交回结果时按工具调用 id 记下，守卫接入写这次调用的记录时取走
    const recalls = new Map<string, MemoryRecall>();
    options.guards.attach(proc, {
      ...guard,
      get agent() {
        return held.agent;
      },
      // 工具包每次判定现取（27 号票）：改了工具包，子进程重新装配之前的调用也按新的判
      ...(options.guardNow ? { currentAgent: () => options.guardNow!(held.agent) } : {}),
      get tools() {
        return held.registry;
      },
      conversation: options.conversation,
      ...(options.scope ? { messageScope: () => this.scope() } : {}),
      superseded: () => this.supersededReason(),
      takeRecall: (toolCallId) => {
        const recall = recalls.get(toolCallId);
        recalls.delete(toolCallId);
        return recall;
      },
    });
    serveHostTools(proc, () => held.hostTools, {
      log: options.log,
      onRecall: (toolCallId, recall) => recalls.set(toolCallId, recall),
      // 工具产生的卡片以一条只有卡片引用的消息出现在会话里
      onCards: (cardIds) => appendMessage(options.store, { conversation: options.conversation, speaker: "agent", parts: cardIds.map((cardId) => ({ type: "card_ref", cardId })) }, this.scope()),
      // 工具发出的附件（发附件，117 号票起维护者也有）同样是 agent 的一条消息，带上会话此刻的归属（任务、项目、阶段）
      onAttachments: (parts) => appendMessage(options.store, { conversation: options.conversation, speaker: "agent", parts }, this.scope()),
      // 工具据此知道正在处理哪条输入、模型能不能看图（读取附件读图）；这一轮收下的插话由子进程随调用报上来（86 号票）
      // 一起交出的一批（144 号票）：另外几条也算这一轮处理的用户消息
      context: () => ({
        ...(this.current === undefined ? {} : { inputMessageId: this.current }),
        ...(this.current !== undefined && this.currentMore.length > 0 ? { moreInputMessageIds: [...this.currentMore] } : {}),
        vision: this.inputContext.vision,
      }),
    });
    // 运行时自己要问用户的（288：Claude Code 的 AskUserQuestion、退出计划模式的批准）：建提问卡，回答交回子进程
    options.questions?.service.attach(proc, {
      agentId: options.agentId,
      conversation: options.conversation,
      source: guard.source,
      ...(guard.internal ? { internal: guard.internal } : {}),
      scope: () => this.scope(),
      runtimeTitle: options.questions.runtimeTitle,
    });
    proc.onReport((report) => {
      if (this.proc === proc) this.onReport(report);
    });
    void proc.exited.then((exit) => this.onExit(proc, exit));
    // 范围审视接在会话之后：同一条报告（就绪、退出）会话先处理
    this.reviews?.attach(proc);
  }

  private onReport(report: AgentReport): void {
    const { options } = this;
    switch (report.type) {
      case "ready":
        this.ready = true;
        this.crashes = 0;
        this.inputContext.vision = report.vision;
        this.model = { modelId: report.model.modelId, thinkingLevel: report.model.thinkingLevel, vision: report.vision };
        this.contextInfo = report.context;
        this.modelDiffers = report.model.differs === true;
        this.switching = false;
        this.sessionName = report.session;
        // 换模型（83 号票）：换成了、或者交接摘要没写成，会话里记一条说明（在这条输入的回复之前）
        if (report.handoff) {
          const { handoff } = report;
          options.log(
            handoff.error === undefined
              ? `${options.label}（${options.agentId}）换了模型：${handoff.from.model.modelId} → ${handoff.to.modelId}，新开会话 ${report.session}（原来的会话 ${handoff.from.session}）`
              : `${options.label}（${options.agentId}）换模型没成（${handoff.from.model.modelId} → ${handoff.to.modelId}），照旧接着会话 ${report.session}：${handoff.error}`,
          );
          // 换成了：agent 从这里新开了一段会话（150 号票：回退点只在这之后）
          if (handoff.error === undefined) this.systemNote(modelSwitchedNote(handoff), { sessionStart: true });
          else this.systemNote(modelSwitchFailedNote(handoff));
        }
        options.onReady?.({ session: report.session });
        this.setStatus("idle");
        this.pump();
        return;
      case "stream_delta":
        if (this.current === undefined || this.asking) return;
        options.streams.delta(options.conversation, this.replyIdFor(report.messageId), report.part === "thinking" ? "reasoning" : "text", report.delta);
        return;
      case "message_final": {
        // 追问时它说的不进会话
        if (this.current === undefined || this.asking) return;
        const messageId = this.replyIdFor(report.messageId);
        this.endReply();
        const said = finalParts(report.message.parts);
        // 插件给这一轮回话的 part（266 号票：记忆简报的结构化部分）放进这一轮有内容的第一条回话
        const extra = said.length > 0 && this.turnParts?.input === this.current ? this.takeTurnParts() : [];
        const parts = [...extra, ...said];
        // 说到一半被中止的（144 号票：用户点了停止、任务暂停取消）：已经说出来的留着，标"已停止"
        const stopped = report.message.stopReason === "aborted" ? { stopped: true as const } : {};
        // 同一条回复里调用的工具（152 号票）：撤回到"开始阶段"那次调用之前时，这条回复说的话一起回到废弃分支上
        const calls = report.message.parts.flatMap((p) => (p.type === "tool_call" ? [p.toolCallId] : []));
        if (parts.length > 0) appendMessage(options.store, { id: messageId, conversation: options.conversation, speaker: "agent", parts, ...stopped, ...(calls.length > 0 ? { calls } : {}) }, this.scope());
        return;
      }
      case "turn_end": {
        if (this.current === undefined) return;
        this.endReply();
        if (this.asking) return this.endFollowUp();
        // 这一轮里收下的插话随这一轮记成处理完（在这一轮的输入之前出队）
        for (const id of report.interjected ?? []) {
          if (!this.interjected.delete(id)) continue;
          const started: TurnStartEventPayload = { inputMessageId: id };
          options.store.append({ channel: options.conversation, type: EVENT_TYPES.turnStart, payload: started });
          this.finishTurn(id, "completed");
        }
        // 按 yield 停在两次模型调用之间（27 号票）：手头这条输入还没做完，按新的装配拉起后接着干。
        // 停稳期间（84 号票，abort 和 yield 碰上了）：不再接着干，按中止结束，装配照样换
        if (report.outcome === "yielded") {
          if (!this.stopWanted(this.current) && this.userStop !== this.current) return this.restartForResume();
          this.stale = true;
          this.endYieldedTurn(this.current);
          this.setStatus("idle");
          return this.pump();
        }
        if (this.yieldNotice !== undefined) {
          // 停下之前这一轮自己结束了：和闲着时一样，"工具包已变更"跟在下一条输入后面
          this.pendingNotice = joinContext(this.pendingNotice, this.yieldNotice);
          this.yieldNotice = undefined;
        }
        // 315 号票：没配模型 key 时 pi 报的是英文的"No API key found…/login…"，换成给人看的"还没配模型、去哪配"
        if (report.outcome === "error") this.systemNote(turnFailedNote(options.displayName ?? options.label, this.missingKeyReason() ?? report.errorMessage ?? t("conversation.unknownError")));
        const input = this.current;
        this.finishTurn(input, report.outcome, report.errorMessage);
        // 这一轮结束了：排队的消息马上交出去（144 号票），排在"闲下来"时才交的通知（秘书的任务做完）前面
        this.deliverQueued();
        // 回复长、又没写口语总结（32）：在下一条输入之前追问一句
        const ask = report.outcome === "completed" ? options.voiceReplies?.followUp(options.conversation, input) : undefined;
        if (ask) this.followUp = { inputMessageId: input, ask };
        this.endCurrent();
        this.setStatus("idle");
        this.pump();
        return;
      }
      case "compacted":
        return this.onCompacted(report);
      case "session_navigated": {
        const waiting = this.navigations.get(report.requestId);
        this.navigations.delete(report.requestId);
        waiting?.settle(report);
        return;
      }
      case "handoff_written": {
        const waiting = this.handoffs.get(report.requestId);
        this.handoffs.delete(report.requestId);
        waiting?.settle(report);
        return;
      }
      case "error":
        // 没收下的插话：留在队里，回合结束后照常作为一条输入送
        if (report.inputId !== undefined && this.interjected.delete(report.inputId)) return this.pump();
        options.log(`${options.label}（${options.agentId}）的子进程报错（${report.code}${report.fatal ? "，致命" : ""}）：${report.message}`);
        return;
      default:
        // 心跳不处理；用量由 agent 管家交给账本（归属是上面的 usageAttribution）；代为执行的工具由 serveHostTools 处理，
        // 范围审视的结果由 SessionScopeReviews 处理，
        // 守卫判定和工具调用的记录由守卫接入处理
        return;
    }
  }

  private onExit(proc: ManagedAgent, exit: ManagedExit): void {
    for (const [id, owner] of this.interjected) if (owner === proc) this.interjected.delete(id);
    // 在会话树上挪到一半退出了（150 号票：写分支摘要卡住被结束、意外退出）：没挪成，会话文件还没动（摘要写好之前不改）
    for (const [id, waiting] of this.navigations) {
      if (waiting.proc !== proc) continue;
      this.navigations.delete(id);
      waiting.settle(new Error(t(exit.reason === "unresponsive" ? "conversation.session.summaryTimeout" : "conversation.session.childExited")));
    }
    // 写交接摘要时退出了（289 号票）：没写成，照样换
    for (const [id, waiting] of this.handoffs) {
      if (waiting.proc !== proc) continue;
      this.handoffs.delete(id);
      waiting.settle(new Error(t("conversation.session.childExited")));
    }
    if (proc !== this.proc) return;
    this.proc = undefined;
    this.ready = false;
    // 写交接摘要时退出了（83 号票）：这一条不再试换（重新拉起时不带 handoff），下一条能换的输入再试
    this.switching = false;
    // 压缩到一半退出了（114 号票）：按没压成收尾
    if (this.compacting) {
      const message = t(exit.reason === "unresponsive" ? "conversation.compaction.timeout" : "conversation.compaction.childExited");
      this.endCompaction({ outcome: "failed", at: nowIso(), message });
    }
    this.endReply();
    if (this.stopped) {
      // 守护进程在停：排队的消息不交，重启后会话起来时交
      this.endCurrent();
      return this.setStatus("stopped");
    }
    // 追问到一半、或者还没交过去子进程就退出了：不再追问（交还给语音回复兜底）
    this.endFollowUp(false);
    this.dropFollowUp();
    this.endCurrent();
    if (!this.options.resident && (exit.reason === "idle" || exit.reason === "killed" || exit.reason === "cancelled")) {
      // 闲置退出（或者被结束）：之后再来输入时重新唤起；退出途中来了输入的，现在就唤起
      this.setStatus("asleep");
      if (exit.reason === "idle") this.options.onIdleExit?.();
      return this.pump();
    }
    // 意外退出（或者超时中止后还不结束被结束）：正在处理的那条不再交给它，隔一会儿再拉起；排队的消息这时就交出去（等再拉起时处理）
    this.interruptStartedInputs();
    this.deliverQueued();
    this.crashes += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.crashes - 1), RETRY_MAX_MS);
    this.options.log(
      `${this.options.label}（${this.options.agentId}）的子进程意外退出（${exit.reason}，code ${exit.code}，signal ${exit.signal}），${delay} 毫秒后${this.options.resident ? "重新拉起" : "有输入再唤起"}`,
    );
    // 等着改写的会话文件趁这时候一起改
    const purges = this.pendingPurges.splice(0);
    this.relaunch(() => (purges.length > 0 ? this.rewriteSessions(purges) : Promise.resolve()), delay);
  }

  /**
   * 重新拉起（崩溃之后、改写会话文件之后共用的收尾）：先做完 before，再等 delayMs（崩溃后的退避），
   * 然后常驻的拉起、按需的有输入才唤起。期间没有子进程，不取输入
   */
  private relaunch(before: () => Promise<void>, delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.relaunching = true;
    this.setStatus("restarting");
    void before().finally(() => {
      this.relaunching = false;
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (!this.options.resident) this.setStatus("asleep");
        this.pump();
      }, delayMs);
      this.retryTimer.unref();
    });
  }

  /**
   * 闲着时（手头这一条处理完）改写会话文件：子进程内存里还有原文，所以先停掉子进程，改完再拉起，接着同一个会话。
   * 正在处理一条输入时等它的 turn_end；正在重新拉起时等拉起来以后
   */
  private rewriteWhenIdle(): void {
    // 审视在做时不改写（子进程还要交审视的结果），做完了再看
    if (this.stopped || this.relaunching || this.current !== undefined || this.retryTimer || this.pendingPurges.length === 0 || this.reviews?.inFlight) return;
    const purges = this.pendingPurges.splice(0);
    const proc = this.proc;
    // 这次退出是计划内的：onExit 看到它不是当前的子进程就不当崩溃处理
    this.proc = undefined;
    this.ready = false;
    this.endReply();
    this.relaunch(async () => {
      if (proc) {
        proc.kill();
        await proc.exited;
      }
      await this.rewriteSessions(purges);
    }, 0);
  }

  /** 子进程按 yield 停下了（27 号票）：停掉它，马上按新的装配拉起，就绪后接着手头那条输入（resumeTurn） */
  private restartForResume(): void {
    this.resume = { notice: this.yieldNotice ?? "工具包已变更。", restart: true }; // @i18n-ignore model：交给 agent 的通知
    this.yieldNotice = undefined;
    this.endReply();
    this.pump();
  }

  /** 闲着时换运行时（289 号票，见 switchRuntime）：在换就等它换完；审视在做时等它做完（子进程还要交审视的结果） */
  private switchRuntimeWhenIdle(): void {
    const wanted = this.runtimeWanted;
    if (!wanted || wanted.running || this.stopped || this.relaunching || this.current !== undefined || this.retryTimer || this.reviews?.inFlight || this.navigating) return;
    wanted.running = true;
    void this.performRuntimeSwitch(wanted)
      .catch((err: unknown) => this.options.log(`${this.options.label}（${this.options.agentId}）换运行时出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
      .finally(() => {
        if (this.runtimeWanted === wanted) this.runtimeWanted = undefined;
        if (!this.stopped) this.pump();
      });
  }

  /**
   * 换运行时（289 号票）：这段会话里 agent 说过话的，先让原来的运行时写交接摘要（没有子进程的按原来的运行时拉起一个）、停掉它；
   * 会话里记一条"已换成"，之后拉起都带上由它定的新会话名字，交接摘要跟在下一条输入后面；最后 commit 把维护者的运行时改成新的
   */
  private async performRuntimeSwitch(wanted: NonNullable<AgentSession["runtimeWanted"]>): Promise<void> {
    const sw = this.options.runtimeSwitch!;
    const { store, conversation } = this.options;
    const from = sw.current();
    let summary: string | undefined;
    let failure: string | undefined;
    if (agentSpokeAfter(store.reader, conversation, sessionSince(store, conversation))) {
      wanted.state = "handoff";
      try {
        const proc = await this.readyProcess(HANDOFF_READY_TIMEOUT_MS);
        const awake = proc.holdAwake("runtime-handoff");
        try {
          summary = await this.requestHandoff(proc, sw.instructions(), sw.timeoutMs);
        } finally {
          awake();
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      // 原来的子进程停掉（计划内的退出：onExit 看到它不是当前的子进程就不当崩溃处理）
      const proc = this.proc;
      this.proc = undefined;
      this.ready = false;
      this.endReply();
      if (proc) {
        proc.kill();
        await proc.exited;
      }
    } else if (this.proc) {
      const proc = this.proc;
      this.proc = undefined;
      this.ready = false;
      proc.kill();
      await proc.exited;
    }
    if (this.stopped) return;
    const to = wanted.to;
    const toTitle = sw.title(to);
    const fromTitle = sw.title(from);
    this.options.log(
      failure === undefined
        ? `${this.options.label}（${this.options.agentId}）换运行时：${from} → ${to}${summary === undefined ? "（没有要交接的）" : "，原来的写好了交接摘要"}`
        : `${this.options.label}（${this.options.agentId}）换运行时：${from} → ${to}，交接摘要没写成：${failure}`,
    );
    const noteId = `${RUNTIME_SWITCH_MESSAGE_PREFIX}${randomUUID()}`;
    const text =
      failure !== undefined
        ? t("conversation.runtimeSwitch.noSummary", { to: toTitle, from: fromTitle, error: failure })
        : summary !== undefined
          ? t("conversation.runtimeSwitch.done", { to: toTitle })
          : t("conversation.runtimeSwitch.fresh", { to: toTitle });
    appendMessage(store, { id: noteId, conversation, speaker: "system", parts: [{ type: "text", text }], sessionStart: true }, this.scope());
    this.freshSession = switchedSessionName(noteId);
    this.sessionName = undefined;
    this.model = undefined;
    this.contextInfo = undefined;
    // @i18n-ignore-next model：交接摘要前面那句给新的运行时看
    if (summary !== undefined) this.pendingNotice = joinContext(`【交接摘要】这个对话之前由 ${fromTitle} 做，现在换成由你（${toTitle}）接着。下面是之前写的交接摘要，照它接着往下做，不用复述，也不用向用户确认换了运行时。\n\n${summary}`, this.pendingNotice);
    sw.commit(to, wanted.options);
  }

  /** 让子进程写交接摘要（289 号票，宿主协议 write_handoff）：写好交回摘要；没写成、退出了、到点没回抛出原因 */
  private requestHandoff(proc: ManagedAgent, instructions: string, timeoutMs: number): Promise<string> {
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handoffs.delete(requestId);
        reject(new Error(t("conversation.runtimeSwitch.timeout", { seconds: Math.round(timeoutMs / 1000) })));
      }, timeoutMs + HANDOFF_GRACE_MS);
      timer.unref();
      this.handoffs.set(requestId, {
        proc,
        settle: (result) => {
          clearTimeout(timer);
          if (result instanceof Error) return reject(result);
          if (result.error !== undefined || !result.text) return reject(new Error(result.error ?? t("conversation.unknownError")));
          resolve(result.text);
        },
      });
      try {
        proc.send({ type: "write_handoff", requestId, instructions, timeoutMs });
      } catch (err) {
        clearTimeout(timer);
        this.handoffs.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 闲着时换一套装配：停掉子进程，下次有输入（常驻的马上）按新的装配拉起 */
  private restartWhenIdle(): void {
    // 审视在做时不换（子进程还要交审视的结果），做完了再看
    if (this.stopped || this.relaunching || this.current !== undefined || this.retryTimer || !this.stale || this.reviews?.inFlight) return;
    this.stale = false;
    const proc = this.proc;
    // 没有子进程：下次唤起时自然用新的装配
    if (!proc) return this.pump();
    // 这次退出是计划内的：onExit 看到它不是当前的子进程就不当崩溃处理
    this.proc = undefined;
    this.ready = false;
    this.endReply();
    this.relaunch(async () => {
      proc.kill();
      await proc.exited;
    }, 0);
  }

  /**
   * 正在处理一条输入时来了标了插话送达的运行时通知（14 号票：无进展的催促）、秘书转达的话（103 号票）：作为插话送进去（在下一步之前插入）。
   * 附件要先读：读好时还在处理同一条、这条也还在排队（没被当成普通输入送出去）才送。144 号票起用户在这个会话里直接说的话不插话
   * （正在回复时排进会话的队列，不进会话，也就不到这里）
   */
  private maybeInterject(payload: MessageEventPayload): void {
    const { options } = this;
    const message = payload.message;
    const interjectable = (message?.speaker === "user" && message.relayedBy !== undefined) || (message?.speaker === "system" && payload.agentInput === true && payload.interject === true);
    // 追问时不送插话（32 号票）：留在队里，追问完照常作为输入处理；按 yield 停下、等着重新拉起时也不送（子进程这一轮已经结束了）；
    // 停稳期间（84 号票）、用户点了停止（144 号票）也不送：这一轮要停了，留在队里，作为下一条输入
    if (!options.interjectNotices || !interjectable || this.current === undefined || this.asking || this.resume || this.stopWanted(this.current) || this.userStop === this.current || !this.ready || this.proc?.state !== "running") return;
    if (options.accepts && !options.accepts({ messageId: message.id, payload })) return;
    // 还没识别完的语音不当插话，排在它后面的话也不越过它（31 号票）：都留在队里，识别完了按先后作为输入处理
    if (!this.settledUpTo(message.id)) return;
    const proc = this.proc;
    const turn = this.current;
    prepareAgentInput(this.inputContext, message).then(
      (input) => {
        const stillQueued = pendingInputs(options.store.reader, options.conversation).some((q) => q.messageId === message.id);
        if (this.proc !== proc || this.current !== turn || !stillQueued || this.stopWanted(turn)) return;
        try {
          proc.send({ type: "interject", inputId: message.id, text: input.text, ...(input.images.length > 0 ? { images: input.images } : {}) });
          this.interjected.set(message.id, proc);
        } catch {
          // 子进程刚好退出了：这句话留在队里
        }
      },
      () => {
        // 读附件出错：留在队里，作为普通输入处理时再报
      },
    );
  }

  /** 改写会话文件（一次性子进程）；改写不了只记日志（下次 start() 时再对一遍） */
  private async rewriteSessions(purges: readonly MessagesPurgedEventPayload[]): Promise<void> {
    const { options } = this;
    if (!options.sessionRewriteFor) return;
    try {
      const { files, entries, summaries } = await options.agents.rewriteSessions(options.agentId, options.sessionRewriteFor(purges));
      if (files > 0) options.log(`彻底删除：改写了${options.label}（${options.agentId}）会话文件里的 ${entries} 条原话、${summaries} 段摘要（${files} 个文件）`);
    } catch (err) {
      options.log(`彻底删除：改写${options.label}（${options.agentId}）的会话文件出错，下次启动时再改：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }

  /** 用量记在谁名下：输入所属的定时作业优先，其次任务、项目，再按会话的 scope */
  private usageAttribution(): UsageAttribution {
    return { owner: ownerOf({ ...this.scope(), ...this.inputScope }), role: this.options.ledgerRole ?? "maintainer" };
  }

  private replyIdFor(agentMessageId: string): string {
    if (this.reply?.agentMessageId !== agentMessageId) {
      this.endReply();
      this.reply = { agentMessageId, messageId: newMessageId() };
    }
    return this.reply.messageId;
  }

  /** 结束正在生成的回复的流式推送（定稿、回合结束、子进程退出时） */
  private endReply(): void {
    if (this.reply) this.options.streams.end(this.options.conversation, this.reply.messageId);
    this.reply = undefined;
  }

  /**
   * 这一轮没成是因为模型没配 key（315 号票，第一次装的人）：现在的子进程是 pi、模型目录里的模型、拉起时没有那家服务商的 key——
   * 给人看的原因（还没配模型、去设置 · 模型看怎么配）；不是这种情况是 undefined
   */
  private missingKeyReason(): string | undefined {
    const model = this.spawnedModel;
    if (this.spawnedRuntime !== PI_RUNTIME_ID || model?.kind !== "catalog" || this.spawnedCredentials[model.provider]) return undefined;
    return t("conversation.session.noModelKey", { provider: providerOf(model.provider)?.label ?? model.provider });
  }

  private systemNote(text: string, extra: Pick<MessageEnvelope, "sessionStart"> = {}): void {
    appendMessage(this.options.store, { conversation: this.options.conversation, speaker: "system", parts: [{ type: "text", text }], ...extra }, this.scope());
  }

  /** 会话里的消息现在带上的任务、项目、阶段 */
  private scope(): MessageScope {
    const { scope } = this.options;
    return typeof scope === "function" ? scope() : (scope ?? {});
  }


  /** 把追问交给子进程（32）：没有子进程就唤起，就绪了再交；交不过去（刚好退出）在退出时收尾 */
  private askFollowUp(followUp: { inputMessageId: string; ask: SessionFollowUp }): void {
    if (!this.proc) return this.spawn();
    if (!this.ready || this.proc.state !== "running") return;
    this.followUp = undefined;
    this.current = followUp.inputMessageId;
    this.asking = followUp.ask;
    this.setStatus("busy");
    try {
      this.proc.send({ type: "user_input", inputId: `follow-up-${randomUUID()}`, text: followUp.ask.text });
    } catch (err) {
      this.options.log(`追问${this.options.label}（${this.options.agentId}）没送出去：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 追问结束；next 时接着处理下一条输入（子进程退出时由退出的收尾接着） */
  private endFollowUp(next = true): void {
    const asked = this.asking;
    if (!asked) return;
    this.asking = undefined;
    this.current = undefined;
    asked.done();
    if (!next) return;
    this.setStatus("idle");
    this.pump();
  }

  /** 等着的追问不再追问（任务暂停、子进程退出）：交还给语音回复兜底 */
  private dropFollowUp(): void {
    const pending = this.followUp;
    this.followUp = undefined;
    pending?.ask.done();
  }

  /**
   * 一条输入处理完（出队）。是手头这一轮的：一起交出的另外几条同时出队（144 号票）；用户点了停止、以中止结束的，先在时间线上记一笔
   * "你停止了这一轮"
   */
  private finishTurn(inputMessageId: string, outcome: TurnEndEventPayload["outcome"], error?: string): void {
    const { store, conversation } = this.options;
    const more = inputMessageId === this.current ? this.currentMore : [];
    if (inputMessageId === this.userStop) {
      this.userStop = undefined;
      if (outcome === "aborted") store.append(buildTimelineRecord(conversation, { kind: "stopped", summary: t("conversation.stoppedTurn") }, this.scope()).event);
    }
    // 插件给这一轮回话的 part 还没放进回话（这一轮一条回话都没有：出错、中止）：结束前单独记一条，带过的照样记得
    if (this.turnParts?.input === inputMessageId) appendMessage(store, { conversation, speaker: "agent", parts: this.takeTurnParts() }, this.scope());
    const payload: TurnEndEventPayload = { inputMessageId, ...(more.length > 0 ? { moreInputMessageIds: [...more] } : {}), outcome, ...(error === undefined ? {} : { error }) };
    store.append({ channel: conversation, type: EVENT_TYPES.turnEnd, payload });
  }

  /** 取走这一轮回话要带上的 part（266 号票），之后就没有了 */
  private takeTurnParts(): MessagePart[] {
    const parts = this.turnParts?.parts ?? [];
    this.turnParts = undefined;
    return parts;
  }

  /** 手头这一轮了结了（出过队）：不再记着它 */
  private endCurrent(): void {
    this.current = undefined;
    this.currentMore = [];
    this.turnParts = undefined;
  }

  /**
   * 处理到一半被打断的输入（已有 turn_start、还没有 turn_end）：标成中断出队，追加系统说明，不重送。
   * 拉起它的模块自己会重新交一次的（redeliveredOnInterrupt，99 号票：秘书的任务做完通知）不出说明（用户没法重发系统通知）
   */
  private interruptStartedInputs(): void {
    const { store, conversation } = this.options;
    /** 已经出过说明的一批（144 号票：一起交出的几条只出一句，引第一条） */
    const noted = new Set<string>();
    for (const input of startedInputs(store.reader, conversation)) {
      const message = getMessage(store.reader, input.messageId);
      const delivery = queuedAgentInput(store, input).payload.queueDelivery;
      const first = delivery === undefined || !noted.has(delivery);
      if (delivery !== undefined) noted.add(delivery);
      if (first && !(message && this.options.redeliveredOnInterrupt?.(message))) this.systemNote(this.options.interruptedNote(quoteMessage(message?.parts ?? [])));
      this.finishTurn(input.messageId, "interrupted");
    }
  }

  private setStatus(status: AgentSessionStatus): void {
    this.notifyTurnWaiters();
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.options.onStatus?.(status);
  }
}

/** 压缩是怎么起的（时间线上那一笔的说明） */
const COMPACTION_REASON_TEXT: Readonly<Record<CompactedReport["reason"], string>> = tTable({
  manual: "conversation.compaction.manual",
  threshold: "conversation.compaction.threshold",
  overflow: "conversation.compaction.overflow",
});

/** token 数的说法：一万以上写"8.2 万"（和界面上的一样）；单位（中文按万、英文按千）和写法在语言文件里（173 号票） */
function tokensText(n: number): string {
  if (n < 10_000) return String(n);
  const unit = Number(t("conversation.compaction.tokensUnit")) || 10_000;
  return t("conversation.compaction.tokensLarge", { n: Number((n / unit).toFixed(1)) });
}

/** 两段上下文消息拼在一起（都没有是 undefined） */
function joinContext(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((p): p is string => p !== undefined && p.length > 0);
  return present.length > 0 ? present.join("\n\n") : undefined;
}

/** 归属的优先次序：定时作业、任务、项目；都没有是 null */
function ownerOf(scope: MessageScope): LedgerOwner | null {
  if (scope.scheduledJobId !== undefined) return { kind: "scheduled_job", id: scope.scheduledJobId };
  if (scope.taskId !== undefined) return { kind: "task", id: scope.taskId };
  if (scope.projectId !== undefined) return { kind: "project", id: scope.projectId };
  return null;
}

/** 会话的守卫工具注册表：框架自带的，加上这个会话代为执行的工具（框架自带的那几样不再加），再加上运行时自带的工具（288 号票） */
function sessionRegistry(hostTools: readonly HostTool[], runtimeTools: readonly ToolDescriptor[] | undefined): ToolRegistry {
  return registerTools(BUILTIN_TOOL_REGISTRY, ...hostTools.map((tool) => tool.descriptor).filter((d) => !isBuiltinDescriptor(d)), ...(runtimeTools ?? []));
}
