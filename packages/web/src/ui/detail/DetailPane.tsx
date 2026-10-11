/**
 * 详情面板（56 号票）：照搬 AgentSense web/src/ui/DetailPane.tsx 的外壳（标题栏的 ‹、"详情"、"在对话中定位"，换一页正文滚回顶部，
 * 没有详情时的空状态）、TextDetail、ToolDetail 的分段（Section）和 ValueView。内容由状态层的 detailContent 推好（按条目 id 现查），
 * 这里只管画。和 AgentSense 一样，详情里能一层层点进去（onOpen：组里的一次调用、挂着的内部调用），返回由外面的返回栈管。
 * 种类：
 * - 文本：用户消息、回复（Markdown）、思考、语音（识别出的文字 / 送进 TTS 的原文）、系统说明；工具发的语音（87 号票）下面接着
 *   发它的那次"发语音"调用（聊天里不单独显示它），画法和单次工具调用的详情一样；
 * - 工具调用组：按先后列出每一步的思考和调用，出了状况的标清楚是第几次；每次调用能展开看返回（展开时现取完整内容）、点 › 进单次调用；
 * - 单次工具调用：被拦下的照 AgentSense 的 GuardDetail（Agent 想做什么、为什么没有执行、系统回给 Agent 的原话），
 *   执行了的照 MilestoneToolDetail（Agent 想做什么、守卫怎么判的）；参数按字段画（ValueView），原始参数折进"给开发者看"，
 *   返回能展开，被截断的注明。完整参数和返回每次打开现取（53 号票：不缓存），取不到的退回摘要；
 * - 卡片：整张卡照会话里的画法；时间线记录：种类、一句话、详细说明，操作记录还有凭什么执行的和结果。
 * AgentSense 里绑着它的安全判定的部分（规则核对、修补经过、敏感片段高亮）二狗没有对应的数据，不搬。
 * 60 号票：流程计划卡的详情换成 AgentSense 的计划详情（PlanDetail：涉及的敏感信息、步骤、版本差异、计划审查、检测项全览，
 * WorkflowPlanDetail.tsx）；计划台账里点开的计划按卡片打开（会话没翻到那张卡也看得了）；长程任务的阶段详情（AgentSense 的
 * MilestoneDetail，StageDetail.tsx）从阶段抽屉、阶段栏点开；执行中出过的状况（AgentSense 的 IncidentsDetail，incidents.tsx）从阶段抽屉、
 * 阶段栏下面那一行的个数点开。这几种照 AgentSense 不给"在对话中定位"（阶段详情里有"回到会话里这一段"）。
 */
import { type ReactNode, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL } from "../../model/cards.ts";
import {
  type CallFullContent,
  type CallLine,
  type CallRun,
  callFullContent,
  chatItems,
  type ConversationId,
  type DetailContent,
  detailContent,
  detailKey,
  type DetailTarget,
  detailTitle,
  GENERIC_BASH_LABEL,
  isCardType,
  sizeLabel,
  type TaskPanel,
  TOOL_CALL_VALUE_MAX_BYTES,
} from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { NamedText } from "../assistant-name.tsx";
import { CardPanel } from "../cards/CardPanel.tsx";
import { PartView } from "../conversation/parts.tsx";
import { labelOf, ValueView } from "./ValueView.tsx";
import { StageDetail, type StageDetailSource, StageRuleDetail } from "./StageDetail.tsx";
import { WorkflowPlanDetail } from "./WorkflowPlanDetail.tsx";
import { IncidentsDetail } from "./incidents.tsx";
import { Section } from "./section.tsx";

export function DetailPane({
  detail,
  conversation,
  onReveal,
  onClose,
  onOpen,
  onGo,
  stages,
  panel,
}: {
  detail?: DetailTarget | undefined;
  /** 详情所在的会话（按它取条目，现查）；原型里没有会话假数据的任务没有（只开得了"⋯"里的几样） */
  conversation: ConversationId | undefined;
  /** 在对话中定位（不给 id 是现在这一条；阶段详情的"回到会话里这一段"给那一段第一条的 id） */
  onReveal?: ((id?: string) => void) | undefined;
  /** 标题栏左边的 ‹：先一层层退，退到底宽屏关掉、窄屏回到会话（外面的返回栈管） */
  onClose?: (() => void) | undefined;
  /** 从一条详情钻进另一条（组里的一次调用、挂着的内部调用） */
  onOpen?: ((id: string) => void) | undefined;
  /** 从一页详情钻进另一页（84 号票：阶段详情里点一条规则） */
  onGo?: ((target: DetailTarget) => void) | undefined;
  /** 长程任务的阶段（阶段详情要的，任务详情页给） */
  stages?: StageDetailSource | undefined;
  /** 任务详情"⋯"里的计划、工单、工具包、消耗、运行画成什么（90 号票），任务详情页给 */
  panel?: ((panel: TaskPanel) => ReactNode) | undefined;
}) {
  const { ui } = useStore();
  const items = useMemo(() => (conversation ? chatItems(ui, conversation) : []), [ui, conversation]);
  const content = detail?.type === "item" ? detailContent(ui, items, detail) : undefined;
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
  const runs: OpenRuns = {
    open: openRuns,
    toggle: (head) =>
      setOpenRuns((s) => {
        const n = new Set(s);
        if (n.has(head)) n.delete(head);
        else n.add(head);
        return n;
      }),
  };
  if (!detail || (detail.type === "item" && !content)) {
    return (
      <div className="detail detail-empty">
        <div className="detail-empty-icon">◧</div>
        <div>点任意一条历史——消息、思考、卡片、工具调用，这里显示它的细节</div>
      </div>
    );
  }
  return (
    <div className="detail">
      <div className="detail-bar">
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="返回">
            ‹
          </button>
        )}
        <span className="detail-bar-title">{detailTitle(detail)}</span>
        {content && content.kind !== "missing" && onReveal && (
          <button type="button" className="link" onClick={() => onReveal()}>
            在对话中定位
          </button>
        )}
      </div>
      {/* 换了一页就从头看（上一页滚到哪、展开了什么都不带过来）：按详情的 id 重新挂上正文 */}
      <div className="detail-body" key={detailKey(detail)}>
        {detail.type === "panel" ? (
          (panel?.(detail.panel) ?? <div className="page-placeholder">这里看不了</div>)
        ) : detail.type === "plan" ? (
          <WorkflowPlanDetail cardId={detail.cardId} />
        ) : detail.type === "stage" ? (
          <StageDetail
            source={stages}
            taskId={detail.taskId}
            stageId={detail.stageId}
            items={items}
            onReveal={onReveal}
            onRule={onGo && ((ruleId) => onGo({ type: "rule", taskId: detail.taskId, stageId: detail.stageId, ruleId }))}
          />
        ) : detail.type === "rule" ? (
          <StageRuleDetail source={stages} taskId={detail.taskId} stageId={detail.stageId} ruleId={detail.ruleId} />
        ) : detail.type === "incidents" ? (
          <IncidentsDetail taskId={detail.taskId} kind={detail.kind} items={items} onOpen={onOpen} />
        ) : (
          content && <DetailBody content={content} onOpen={onOpen} runs={runs} />
        )}
      </div>
    </div>
  );
}

function DetailBody({ content, onOpen, runs }: { content: DetailContent; onOpen?: ((id: string) => void) | undefined; runs: OpenRuns }) {
  switch (content.kind) {
    case "missing":
      return (
        <div className="page-placeholder">
          {content.reason === "deleted" ? "这条消息已彻底删除，原话不在了" : "这一条不在已加载的会话里了（可能被删了，或者会话换了）"}
        </div>
      );
    case "text":
      return (
        <>
          <TextDetail content={content} />
          {/* 工具发的语音（87 号票）：发它的那次"发语音"调用会话里不单独显示，在这里接着看（和单次工具调用的详情一样） */}
          {content.toolCall && (
            <div className="dt-embed">
              <ToolDetail content={content.toolCall} onOpen={onOpen} embedded />
            </div>
          )}
          <InternalCalls calls={content.internalCalls} onOpen={onOpen} />
        </>
      );
    case "tool_group":
      return (
        <>
          <GroupDetail content={content} onOpen={onOpen} runs={runs} />
          <InternalCalls calls={content.internalCalls} onOpen={onOpen} />
        </>
      );
    case "tool_call":
      return <ToolDetail content={content} onOpen={onOpen} />;
    case "card":
      // 流程计划卡：AgentSense 的计划详情（60 号票）
      if (content.cardType === "workflow_plan")
        return (
          <>
            <WorkflowPlanDetail cardId={content.cardId} />
            <InternalCalls calls={content.internalCalls} onOpen={onOpen} />
          </>
        );
      return (
        <>
          <div className="dt-head">
            <span className="tag tag-plan">{isCardType(content.cardType) ? CARD_TYPE_LABEL[content.cardType] : "卡片"}</span>
            <span className={`dt-status${content.pending ? "" : " ok"}`}>{content.status}</span>
          </div>
          <div className="dt-title">
            <NamedText text={content.title} />
          </div>
          <Section title="卡片">
            <CardPanel cardId={content.cardId} />
          </Section>
          <InternalCalls calls={content.internalCalls} onOpen={onOpen} />
        </>
      );
    case "record":
      return (
        <>
          <RecordDetail content={content} />
          <InternalCalls calls={content.internalCalls} onOpen={onOpen} />
        </>
      );
  }
}

// ───────────────────────── 文本 ─────────────────────────

const TEXT_TAG_CLASS = { user: "tag-user", thinking: "tag-thinking", reply: "tag-reply", voice: "tag-user", system: "tag-context" } as const;

/** 消息 / 思考 / 回复 / 语音 / 系统说明：详情里给出完整原文（AgentSense 的 TextDetail） */
function TextDetail({ content }: { content: Extract<DetailContent, { kind: "text" }> }) {
  const facts = [content.voice?.duration, content.voice?.status, `${content.chars} 字`].filter(Boolean).join(" · ");
  return (
    <>
      <div className="dt-head">
        <span className={`tag ${content.voice?.speaker === "agent" ? "tag-reply" : TEXT_TAG_CLASS[content.tag]}`}>{content.label}</span>
        <span className="dt-status">{facts}</span>
      </div>
      {content.task && <div className="dt-title">所属任务：{content.task.slice(0, 40)}</div>}
      <Section title="完整内容">
        {/* 模型回复本来就是 Markdown，按渲染后的样子看；其余按原文看 */}
        {!content.text ? (
          <div className="muted">（没有文字）</div>
        ) : content.markdown ? (
          <div className="dt-doc md">
            <Markdown remarkPlugins={[remarkGfm]}>{content.text}</Markdown>
          </div>
        ) : (
          <div className="dt-doc">{content.tag === "system" ? <NamedText text={content.text} /> : content.text}</div>
        )}
      </Section>
      {content.attachments.length > 0 && (
        <Section title="附件">
          <div className="dt-attachments">
            {content.attachments.map((p, i) => (
              <PartView key={i} part={p} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

// ───────────────────────── 工具调用组 ─────────────────────────

/** 展开了的同类调用（按第一条的 id）：放在详情外壳里，点进一次调用再退回来还展开着（AgentSense 的 openRuns 也在详情之外） */
interface OpenRuns {
  readonly open: ReadonlySet<string>;
  toggle(head: string): void;
}

/**
 * "还有 N 次同样的操作"后面怎么说：在授权内的照 AgentSense 说"都在授权内"；没命中关注类别、不需要授权的照实说
 * （AgentSense 对应的是"只看，没改动东西"，二狗没命中关注类别不等于只读）
 */
const RUN_GRANT_TEXT: Readonly<Record<Extract<CallRun, { kind: "head" }>["grant"], string>> = {
  within: "都在授权内",
  not_needed: "都不需要授权",
  mixed: "都在授权内或不需要授权",
};

/** 工具调用组：按先后列出每一步的思考和调用，出了状况的标清楚是第几次（用户 2026-10-09 定） */
function GroupDetail({ content, onOpen, runs }: { content: Extract<DetailContent, { kind: "tool_group" }>; onOpen?: ((id: string) => void) | undefined; runs: OpenRuns }) {
  // 连续的同类调用合成一条（照 AgentSense ZoomHistory 的 runs）：点第一条下面的"还有 N 次 ▾"才逐条显示
  const { open: openRuns, toggle: toggleRun } = runs;
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-tool">工具调用</span>
        <span className={`dt-status ${content.issues.length ? "no" : "ok"}`}>
          {content.count} 次调用{content.issues.map((i) => ` · ${i.count} 次${i.label}`).join("")}
        </span>
      </div>
      <div className="dt-title">{content.title}</div>
      {content.issues.length > 0 && (
        <Section title="出了状况的">
          <div className="dg-issues">
            {content.issues.map((i) => (
              <span key={i.issue} className={`chip ${i.issue === "asked" || i.issue === "waiting" ? "chip-you" : "chip-stopped"}`}>
                {i.label}：第 {i.numbers.join("、")} 次
              </span>
            ))}
          </div>
        </Section>
      )}
      <Section title="每一步（按先后）">
        <ol className="dg-steps">
          {content.steps.map((step) =>
            step.kind === "thinking" ? (
              <li key={step.id} className="dg-think">
                <span className="dg-think-tag">💭 思考</span>
                {step.text}
              </li>
            ) : step.run?.kind === "tail" && !openRuns.has(step.run.head) ? null : (
              <li key={step.call.id}>
                <CallRow call={step.call} onOpen={onOpen} />
                {step.run?.kind === "head" && (
                  <button type="button" className="dg-run" onClick={() => toggleRun(step.call.id)} aria-expanded={openRuns.has(step.call.id)}>
                    {openRuns.has(step.call.id) ? "收起同类操作 ▴" : `还有 ${step.run.more} 次同样的操作，${RUN_GRANT_TEXT[step.run.grant]} ▾`}
                  </button>
                )}
              </li>
            ),
          )}
        </ol>
      </Section>
    </>
  );
}

/** 一次调用出的状况怎么说：被拦下（硬拒绝、按规则退回……）、你拒绝了、等你批准、出错、问过你 */
function issueText(call: CallLine): string | undefined {
  if (!call.issue) return undefined;
  if (call.issue === "asked") return `问过你：${call.verdict}，你批准后执行的`;
  if (call.issue === "blocked") return `被拦下：${call.why ?? call.verdict}`;
  return call.issueLabel;
}

/** 组里的一次调用：第几次、说人话的那一句（67 号票）、›；出的状况；判定的小签；能展开看返回 */
function CallRow({ call, onOpen }: { call: CallLine; onOpen?: ((id: string) => void) | undefined }) {
  const cls = call.internal && !call.issue ? "dg-internal" : call.issue === "asked" || call.issue === "waiting" ? "dg-asked" : call.issue ? "dg-stopped" : "";
  const issue = issueText(call);
  return (
    <div className={`dg-call ${cls}`}>
      <button type="button" className="dg-call-head" onClick={onOpen ? () => onOpen(call.id) : undefined} disabled={!onOpen}>
        <span className="dg-n">{call.number === undefined ? "内部" : `#${call.number}`}</span>
        <span className={`dg-said${call.said ? "" : " dg-said-raw"}`}>
          <NamedText text={call.sentence} />
        </span>
        {onOpen && <span className="tool-more">›</span>}
      </button>
      {issue && <div className="dg-issue">{issue}</div>}
      {call.internal && <div className="muted dt-note">内部调用：会话里由{call.internal}代表</div>}
      <VerdictChips call={call} />
      <ResultFold call={call} />
    </div>
  );
}

/** 关注类别、守卫的判定、授权内、通用 bash、结局的小签 */
function VerdictChips({ call }: { call: CallLine }) {
  return (
    <div className="chips">
      {call.categories.map((c) => (
        <span key={c} className="chip chip-op">
          {c}
        </span>
      ))}
      {call.verdict && <span className={`chip ${call.disposition === "do" && call.why === undefined ? "chip-quiet" : ""}`}>{call.verdict}</span>}
      {call.grant === "within" && <span className="chip chip-ok">授权内</span>}
      {call.genericBash && <span className="chip chip-generic">{GENERIC_BASH_LABEL}</span>}
      <span className={`chip tc-out tc-out-${call.outcome === "denied" ? "blocked" : call.outcome}`}>{call.status}</span>
    </div>
  );
}

/** 组里每次调用的返回：默认收着，展开时现取完整的（取不到就是摘要） */
function ResultFold({ call }: { call: CallLine }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="dt-fold" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{call.executed ? "返回" : "系统回给 Agent 的话"}</summary>
      {open && <FullResult call={call} />}
    </details>
  );
}

function FullResult({ call }: { call: CallLine }) {
  const full = useCallFull(call);
  if (full.state === "loading") return <div className="muted dt-note">正在取完整的返回…</div>;
  if (full.state !== "ready") return <SummaryFallback call={call} what="result" note={full.state === "failed" ? `取完整内容失败：${full.error}` : undefined} />;
  // 过了保留期、超出总量上限清掉了的（65 号票）：只剩摘要，和没存完整内容一样退回聊天里的摘要，注明为什么
  if (full.content.cleared) return <SummaryFallback call={call} what="result" note={full.content.clearedNote} />;
  return <ResultBody full={full.content} tool={call.tool} />;
}

// ───────────────────────── 单次工具调用 ─────────────────────────

type CallFull = { state: "loading" } | { state: "absent" } | { state: "failed"; error: string } | { state: "ready"; content: CallFullContent };

/**
 * 一次调用的完整参数和返回：每次打开现取，不缓存（53 号票：只靠完整内容找到的彻底删除，会话里不会有通知）。
 * 还在执行的调用结束时（结局变了）再取一次
 */
function useCallFull(call: CallLine): CallFull {
  const { http } = useStore();
  const { callId, status } = call;
  // 取到的结果记着是哪次调用、什么结局时取的；换了调用、结局变了就还没取到（loading）
  const [got, setGot] = useState<{ callId: string; status: string; full: CallFull }>();
  useEffect(() => {
    const abort = new AbortController();
    const done = (full: CallFull) => {
      if (!abort.signal.aborted) setGot({ callId, status, full });
    };
    http.toolCallDetail(callId, abort.signal).then(
      (detail) => done(detail ? { state: "ready", content: callFullContent(detail) } : { state: "absent" }),
      (err: unknown) => done({ state: "failed", error: err instanceof Error ? err.message : String(err) }),
    );
    return () => abort.abort();
  }, [http, callId, status]);
  return got && got.callId === callId && got.status === status ? got.full : { state: "loading" };
}

/** 完整内容取不到时退回摘要，并说明为什么 */
function SummaryFallback({ call, what, note }: { call: CallLine; what: "args" | "result"; note?: string | undefined }) {
  const text = what === "args" ? call.args : call.result;
  return (
    <>
      {text ? <pre className="dt-pre">{text}</pre> : <div className="muted">（没有）</div>}
      <div className="muted dt-note">{note ?? (call.outcome === "running" ? "还在执行，完整内容执行完才有；上面是摘要。" : "这次调用没有存完整内容（二狗更新之前的调用），上面是摘要。")}</div>
    </>
  );
}

/** 截断的说明：哪个值、原长多少、只留了开头多少 */
function truncatedNote(t: CallFullContent["truncated"][number], tool: string): string {
  const where = t.where === "result" ? "返回" : `参数「${t.path.map((p) => labelOf(p, tool)).join(" › ")}」`;
  return `${where}太长，只留了开头 ${TOOL_CALL_VALUE_MAX_BYTES / 1024} KB（原长 ${sizeLabel(t.bytes)}），末尾注明了已截断`;
}

/** 返回：能解析成结构就按结构画；本来就是正文就原样显示（AgentSense 的 ResultSection）；截断、不记、删除、图片都注明 */
function ResultBody({ full, tool }: { full: CallFullContent; tool: string }) {
  const notes = [
    ...full.truncated.filter((t) => t.where === "result").map((t) => truncatedNote(t, tool)),
    ...(full.withheld ? ["读了密钥文件，返回没有记下来"] : []),
    ...(full.purgedLabel ? [`这次调用的内容${full.purgedLabel}`] : []),
    ...full.media.map((m) => `${m}没有存进来，返回里是占位`),
  ];
  return (
    <>
      {full.resultValue !== undefined ? <ValueView value={full.resultValue} tool={tool} /> : <div className="dt-text">{full.result}</div>}
      {notes.map((n) => (
        <div key={n} className="muted dt-note">
          {n}
        </div>
      ))}
    </>
  );
}

/** 单次工具调用的详情（embedded：接在工具发的语音的详情下面，87 号票） */
function ToolDetail({ content, onOpen, embedded = false }: { content: Extract<DetailContent, { kind: "tool_call" }>; onOpen?: ((id: string) => void) | undefined; embedded?: boolean }) {
  const { call, position } = content;
  const full = useCallFull(call);
  const fetched = full.state === "ready" ? full.content : undefined;
  // 过了保留期、超出总量上限清掉了的（65 号票）：参数和返回只剩摘要，和没存完整内容一样退回聊天里的摘要，注明为什么；
  // 工具的中文名、耗时、效果记录照旧用取来的
  const ready = fetched && !fetched.cleared ? fetched : undefined;
  const fallbackNote = full.state === "failed" ? `取完整内容失败：${full.error}` : fetched?.clearedNote;
  const issue = issueText(call);
  const argsNotes = ready ? ready.truncated.filter((t) => t.where === "args").map((t) => truncatedNote(t, call.tool)) : [];
  const params =
    full.state === "loading" ? (
      <div className="muted dt-note">正在取完整的参数…</div>
    ) : ready ? (
      <>
        <ValueView value={ready.args} tool={call.tool} />
        {argsNotes.map((n) => (
          <div key={n} className="muted dt-note">
            {n}
          </div>
        ))}
      </>
    ) : (
      <SummaryFallback call={call} what="args" note={fallbackNote} />
    );
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-tool">{fetched?.toolTitle ?? call.label}</span>
        <span className={`dt-status ${call.outcome === "done" ? "ok" : call.outcome === "running" ? "" : "no"}`}>
          {call.status}
          {call.executed ? "" : ` · ${call.why ?? call.issueLabel ?? "被拦下"}`}
        </span>
      </div>
      {position && (
        <div className="dt-title">
          第 {position.number} 次调用
          {/* 组的详情：按先后看这一组的每一步（往里钻一层，‹ 回到这一次） */}
          {onOpen ? (
            <button type="button" className="link-btn" onClick={() => onOpen(content.itemId)}>
              这一组共 {position.count} 次 ›
            </button>
          ) : (
            `（这一组共 ${position.count} 次）`
          )}
        </div>
      )}
      {call.internal && <div className="dt-title">内部调用：会话里由{call.internal}代表</div>}
      {call.sentVoice && <div className="dt-title">{embedded ? "发这条语音的那次调用（聊天里不单独显示）" : "这次调用发出了语音气泡：聊天里不单独显示，由那个气泡代表"}</div>}
      <Section title="Agent 想做什么">
        {/* 说人话的那一句（67 号票，照 AgentSense 的 describeCall ?? 中文名；没有模板的是"中文名 · 参数值"） */}
        <div className="dt-text">
          <NamedText text={call.sentence} />
        </div>
        {(call.time || fetched?.durationMs !== undefined) && (
          <div className="muted dt-note">
            {call.time ? clockLabel(call.time) : ""}
            {fetched?.durationMs !== undefined ? `${call.time ? " · " : ""}用时 ${durationLabel(fetched.durationMs)}` : ""}
            {call.scope.agentId ? ` · 子 agent ${call.scope.agentId}` : ""}
          </div>
        )}
        {content.stage && <div className="muted dt-note">在做：{content.stage}</div>}
      </Section>
      <Section title={call.executed ? "守卫怎么判的" : "为什么没有执行"}>
        {issue && <div className={`dg-issue${call.issue === "asked" || call.issue === "waiting" ? " dg-you" : ""}`}>{issue}</div>}
        <dl className="dt-kv">
          <dt>关注类别</dt>
          <dd>{call.categories.length ? call.categories.join("、") : "没有命中（直接做只记录）"}</dd>
          <dt>处置</dt>
          <dd>{call.verdict || "—"}</dd>
          <dt>授权</dt>
          <dd>{call.grantLabel}</dd>
        </dl>
        {call.genericBash && <div className="muted dt-note">{GENERIC_BASH_LABEL}：没有事先规定类型的 bash 调用。守卫照常检查；拆不开的先问你，并在要点层和全局层单独标出。</div>}
      </Section>
      {call.outcome === "done" && (
        <Section title="效果记录">
          <EffectList full={full} genericBash={call.genericBash} />
        </Section>
      )}
      {!call.executed && (
        <Section title="系统回给 Agent 的原话">
          {ready ? <div className="dt-text">{ready.result}</div> : <SummaryFallback call={call} what="result" note={fallbackNote} />}
          <div className="muted dt-note">
            {call.issue === "waiting"
              ? "这次调用在等你在审批卡上批准，批准了才执行。"
              : "Agent 只收到这段话，这次调用本身没有发生。它接下来怎么做，在对话里接着看。"}
          </div>
        </Section>
      )}
      <Section title="参数">{params}</Section>
      {ready && (
        <details className="dt-raw">
          <summary>原始参数（给开发者看）</summary>
          <pre className="dt-pre">{ready.rawArgs}</pre>
        </details>
      )}
      {call.executed && (
        <details className="dt-raw dt-fold">
          <summary>返回结果{ready?.truncated.some((t) => t.where === "result") ? "（已截断）" : ""}</summary>
          {full.state === "loading" ? <div className="muted dt-note">正在取完整的返回…</div> : ready ? <ResultBody full={ready} tool={call.tool} /> : <SummaryFallback call={call} what="result" note={fallbackNote} />}
        </details>
      )}
    </>
  );
}

/**
 * 效果记录（守护进程的效果日志，56 号票）：执行成功之后实际做成了什么——每条一行摘要，下面列涉及的对象。
 * 和参数一起从完整内容里取来；通用 bash 拆出来的每条操作各一条
 */
function EffectList({ full, genericBash }: { full: CallFull; genericBash: boolean }) {
  if (full.state === "loading") return <div className="muted dt-note">正在取效果记录…</div>;
  if (full.state !== "ready") return <div className="muted dt-note">{full.state === "failed" ? `取效果记录失败：${full.error}` : "这次调用没有另存的完整内容，也就取不到效果记录。"}</div>;
  const { effects, purgedLabel } = full.content;
  if (purgedLabel) return <div className="muted dt-note">{purgedLabel}，效果记录里的原话一起换成了删除标记。</div>;
  if (!effects) return <div className="muted dt-note">守护进程没有给出效果记录。</div>;
  if (!effects.length) return <div className="muted dt-note">效果日志里没找到这次调用的记录。</div>;
  return (
    <>
      <ul className="dt-effects">
        {effects.map((e) => (
          <li key={e.seq}>
            <div className="dt-effect-sum">{e.summary}</div>
            {e.content && <div className="muted">{e.content}（效果日志里只记了长度和摘要哈希）</div>}
            {e.objects.length > 0 && (
              <ul className="dt-effect-objs">
                {e.objects.map((o, i) => (
                  <li key={`${i}:${o}`}>{o}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {genericBash && effects.length > 1 && <div className="muted dt-note">这段命令拆成了 {effects.length} 条操作，各记一条。</div>}
    </>
  );
}

function durationLabel(ms: number): string {
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

// ───────────────────────── 时间线记录 ─────────────────────────

const SEVERITY_TEXT = { info: "一般", notice: "留意", alert: "警示" } as const;

function RecordDetail({ content }: { content: Extract<DetailContent, { kind: "record" }> }) {
  const op = content.operation;
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-context">{content.label}</span>
        <span className={`dt-status${content.severity === "alert" ? " no" : op ? (op.ok ? " ok" : " no") : ""}`}>
          {op ? (op.ok ? "执行成功" : "没成功") : content.severity ? SEVERITY_TEXT[content.severity] : ""}
          {content.time ? ` · ${clockLabel(content.time)}` : ""}
        </span>
      </div>
      <div className="dt-title">
        <NamedText text={content.summary} />
      </div>
      {content.detail && (
        <Section title="详细说明">
          <div className="dt-text">
            <NamedText text={content.detail} />
          </div>
        </Section>
      )}
      {content.workOrderId && <div className="muted dt-note">工单 {content.workOrderId}</div>}
      {op && (
        <Section title="执行">
          <dl className="dt-kv">
            <dt>动作</dt>
            <dd>{op.name}</dd>
            <dt>凭什么</dt>
            <dd>{op.basis ?? "—"}</dd>
            <dt>结果</dt>
            <dd>
              <NamedText text={op.result} />
            </dd>
          </dl>
        </Section>
      )}
    </>
  );
}

// ───────────────────────── 挂着的内部调用 ─────────────────────────

/** 挂在这一条上的内部工具调用（52 号票：条目里不显示，详情页查得到），点 › 进单次调用 */
function InternalCalls({ calls, onOpen }: { calls: readonly CallLine[]; onOpen?: ((id: string) => void) | undefined }) {
  if (calls.length === 0) return null;
  return (
    <Section title="相关的内部调用">
      <ol className="dg-steps">
        {calls.map((call) => (
          <li key={call.id}>
            <CallRow call={call} onOpen={onOpen} />
          </li>
        ))}
      </ol>
    </Section>
  );
}
