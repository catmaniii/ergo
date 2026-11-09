// 手机本机存的聊天记录（457）测试用的"守护进程那一头"：一个会话频道的事件日志，照守护进程 conversation/history.ts 给
// 往上翻的一页（historyPage）、第一次订阅补发的最近一页连同先补的几条（firstReplayAfter + replayPins），带游标的增量。
// 只照搬会话频道上和历史分页有关的规矩（消息、时间线记录、阶段记号、语音对象、会话树），排队、正在回复的一轮不管
// （这里造的会话没有）。真守护进程上的同一套在 packages/daemon/test/conversation/chat-cache-equivalence.test.ts。
import {
  agentVoiceIdsOf,
  type AgentVoiceRecord,
  type ConversationBranches,
  type EventFrame,
  grownTree,
  HISTORY_PAGE_SIZE,
  type HistoryMessage,
  type HistoryPage,
  type HistoryRecord,
  isDeletedEventPayload,
  type MessageEnvelope,
  type MessageEventPayload,
  nextBranchId,
  onBranchPath,
  pickMessageScope,
  rollbackFork,
  SINGLE_BRANCH,
  switchedTree,
  type VoiceRecord,
  voiceIdsOf,
} from "../../src/state/index.ts";

const TIME = "2026-11-09T09:00:00.000+08:00";

export class ConversationLog {
  readonly frames: EventFrame[] = [];
  readonly channel: string;
  constructor(channel = "secretary") {
    this.channel = channel;
  }

  get last(): number {
    return this.frames.length;
  }

  push(type: string, payload: unknown): EventFrame {
    const frame: EventFrame = { channel: this.channel, seq: this.frames.length + 1, type, payload };
    this.frames.push(frame);
    return frame;
  }

  /** 一条消息（文字；voiceId 给了是一段语音） */
  say(id: string, text: string, options: { speaker?: "user" | "agent"; voiceId?: string } = {}): EventFrame {
    const parts: MessageEnvelope["parts"] = options.voiceId
      ? [{ type: "voice", voiceId: options.voiceId, mediaId: "a".repeat(64), mime: "audio/webm", durationMs: 2000, waveform: [1, 2, 3] }]
      : [{ type: "text", text }];
    const message: MessageEnvelope = { id, conversation: this.channel as MessageEnvelope["conversation"], speaker: options.speaker ?? "user", time: TIME, parts };
    return this.push("message", { message } satisfies MessageEventPayload);
  }

  /** 一段用户语音的最新状态（version 每次加一） */
  voice(id: string, messageId: string, version: number, text: string): EventFrame {
    const voice: VoiceRecord = {
      id,
      messageId,
      conversation: this.channel as VoiceRecord["conversation"],
      mediaId: "a".repeat(64),
      mime: "audio/webm",
      durationMs: 2000,
      waveform: [1, 2, 3],
      status: "done",
      attempt: version,
      recognition: { text, model: "faux", elapsedMs: 10 } as unknown as VoiceRecord["recognition"],
      createdAt: TIME,
      updatedAt: TIME,
      version,
    };
    return this.push("voice", { voice });
  }

  /** 一条时间线记录 */
  record(text: string): EventFrame {
    return this.push("timeline_record", { record: { kind: "deviation", severity: "info", text, time: TIME } });
  }

  /** 现在的会话树 */
  tree(): ConversationBranches | undefined {
    const last = this.frames.findLast((f) => f.type === "session_branch" && !isDeletedEventPayload(f.payload));
    return last ? (last.payload as { branches: ConversationBranches }).branches : undefined;
  }

  /** 回到序号 seq 那条之前（照守护进程：长出一条新分支，从这条 session_branch 起） */
  rollback(seq: number): EventFrame {
    const tree = this.tree() ?? SINGLE_BRANCH;
    const fork = rollbackFork(tree, { seq })!;
    const at = this.frames.length + 1;
    const branches = grownTree(tree, { id: nextBranchId(tree), ...fork }, at, undefined);
    return this.push("session_branch", { change: "rollback", branches, from: tree.current, to: branches.current, by: "user", time: TIME });
  }

  /** 切到一条废弃分支 */
  switchTo(branchId: string): EventFrame {
    const tree = this.tree() ?? SINGLE_BRANCH;
    const at = this.frames.length + 1;
    const branches = switchedTree(tree, branchId, at, undefined);
    return this.push("session_branch", { change: "switch", branches, from: tree.current, to: branchId, by: "user", time: TIME });
  }

  /** 彻底删除几条消息：原来的事件改写成"已删除"标记，频道上追加 messages_purged（照守护进程 memory/purge.ts） */
  purge(seqs: number[]): EventFrame {
    const messages = seqs.map((seq) => {
      const frame = this.frames[seq - 1]!;
      const { message } = frame.payload as MessageEventPayload;
      this.frames[seq - 1] = { ...frame, payload: { deleted: true, deletedAt: TIME, messageId: message.id, messageTime: message.time } };
      // 这条消息的语音对象一起改写
      for (const [i, f] of this.frames.entries()) {
        if (f.type === "voice" && !isDeletedEventPayload(f.payload) && (f.payload as { voice: VoiceRecord }).voice.messageId === message.id) this.frames[i] = { ...f, payload: { deleted: true, deletedAt: TIME } };
      }
      return { seq, messageId: message.id };
    });
    return this.push("messages_purged", { messages, materialIds: [], toolCallIds: [], mediaIds: [], deletedAt: TIME });
  }

  private onPath(): (seq: number) => boolean {
    const tree = this.tree();
    return tree === undefined || tree.branches.length <= 1 ? () => true : (seq) => onBranchPath(tree, seq);
  }

  /** 各语音对象的最新状态（日志里最后一条） */
  private latestVoices(): { voices: Map<string, VoiceRecord>; agentVoices: Map<string, AgentVoiceRecord> } {
    const voices = new Map<string, VoiceRecord>();
    const agentVoices = new Map<string, AgentVoiceRecord>();
    for (const f of this.frames) {
      if (isDeletedEventPayload(f.payload)) continue;
      if (f.type === "voice") {
        const { voice } = f.payload as { voice: VoiceRecord };
        voices.set(voice.id, voice);
      }
      if (f.type === "agent_voice") {
        const { voice } = f.payload as { voice: AgentVoiceRecord };
        agentVoices.set(voice.id, voice);
      }
    }
    return { voices, agentVoices };
  }

  /** 往上翻的一页（照 history.ts 的 historyPage） */
  page(before: number | undefined, limit = HISTORY_PAGE_SIZE): HistoryPage {
    const onPath = this.onPath();
    const b = before ?? Number.MAX_SAFE_INTEGER;
    const messages = this.frames.filter((f) => f.type === "message" && f.seq < b && onPath(f.seq));
    const hasMore = messages.length > limit;
    const page = messages.slice(-limit);
    const from = hasMore ? page[0]!.seq : 1;
    const within = (f: EventFrame) => f.seq >= from && f.seq < b && onPath(f.seq);
    const records = this.frames
      .filter((f) => (f.type === "timeline_record" || f.type === "quick_action_executed") && within(f))
      .map((f) => ({ seq: f.seq, type: f.type, payload: f.payload }) as HistoryRecord);
    const stageStarts = this.frames.filter((f) => f.type === "stage_start" && within(f)).map((f) => ({ seq: f.seq, payload: f.payload as never }));
    const out = page.map(historyMessageOf);
    const envelopes = out.flatMap((m) => ("message" in m ? [m.message] : []));
    const latest = this.latestVoices();
    const voices = envelopes.flatMap((m) => voiceIdsOf(m.parts).flatMap((id) => latest.voices.get(id) ?? []));
    const agentVoices = [
      ...new Map(
        envelopes
          .flatMap((m) => [
            ...agentVoiceIdsOf(m.parts).flatMap((id) => latest.agentVoices.get(id) ?? []),
            ...m.parts.flatMap((p) => (p.type === "tool_call" && p.tool === "send_voice" ? [...latest.agentVoices.values()].filter((v) => v.mode === "tool" && v.toolCallId === p.callId) : [])),
          ])
          .map((v) => [v.id, v]),
      ).values(),
    ];
    return {
      conversation: this.channel,
      messages: out,
      records,
      hasMore,
      ...(voices.length > 0 ? { voices } : {}),
      ...(agentVoices.length > 0 ? { agentVoices } : {}),
      ...(stageStarts.length > 0 ? { stageStarts } : {}),
    };
  }

  /** 第一次订阅（游标 0）时从哪条之后补（照 firstReplayAfter，这里没有排队、正在回复的一轮） */
  firstReplayAfter(): number {
    const onPath = this.onPath();
    const messages = this.frames.filter((f) => f.type === "message" && onPath(f.seq));
    if (messages.length < HISTORY_PAGE_SIZE) return 0;
    return messages.at(-HISTORY_PAGE_SIZE)!.seq - 1;
  }

  /** 订阅时补发的：游标 0 是先补的几条（最新那条会话树、这一页消息的语音对象落在这一页之前的）加最近一页起的全部；否则游标之后的全部 */
  replay(cursor: number): EventFrame[] {
    if (cursor > 0) return this.frames.filter((f) => f.seq > cursor);
    const from = this.firstReplayAfter();
    const replay = this.frames.filter((f) => f.seq > from);
    if (from === 0) return replay;
    const pins: EventFrame[] = [];
    const branch = this.frames.findLast((f) => f.type === "session_branch");
    if (branch && branch.seq <= from) pins.push(branch);
    const inPage = new Set(replay.flatMap((f) => (f.type === "voice" && !isDeletedEventPayload(f.payload) ? [(f.payload as { voice: VoiceRecord }).voice.id] : [])));
    const wanted = new Set(replay.flatMap((f) => (f.type === "message" && !isDeletedEventPayload(f.payload) ? voiceIdsOf((f.payload as MessageEventPayload).message.parts) : [])).filter((id) => !inPage.has(id)));
    for (const id of wanted) {
      const last = this.frames.findLast((f) => f.seq <= from && f.type === "voice" && !isDeletedEventPayload(f.payload) && (f.payload as { voice: VoiceRecord }).voice.id === id);
      if (last) pins.push(last);
    }
    return [...pins.toSorted((a, b) => a.seq - b.seq), ...replay];
  }
}

/** 一条消息事件在历史页里的样子（照 history.ts 的 historyMessageOf） */
function historyMessageOf(frame: EventFrame): HistoryMessage {
  if (isDeletedEventPayload(frame.payload)) return { seq: frame.seq, deleted: frame.payload };
  const p = frame.payload as MessageEventPayload;
  return {
    seq: frame.seq,
    message: p.message,
    ...(p.idempotencyKey === undefined ? {} : { idempotencyKey: p.idempotencyKey }),
    ...pickMessageScope(p),
    ...(p.queueDelivery === undefined ? {} : { queueDelivery: p.queueDelivery }),
    ...(p.agentInput === true ? { agentInput: true as const } : {}),
  };
}
