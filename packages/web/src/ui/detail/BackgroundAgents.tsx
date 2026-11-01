/**
 * 背后的 agent（368 号票，用户 2026-11-01："应该可以有地方实时查看背后有哪几个 agent 在运行，在做什么，进展如何。已经完成的 subagent 的对话历史可以查看，但无法再唤起"）：
 * - 标题栏上的入口（BackgroundAgentsEntry）："背后有 3 个 agent 在干活"，没有运行中的也能点开看已完成的，从来没有过不显示；手机上只留图标和个数；
 * - 列表（BackgroundAgentList）：宽屏在详情栏、手机从右边滑进来。运行中的在前，每个写编号或名字、派去做什么、哪个阶段、状态、现在在做哪一步、用时、工具调用次数、用量；
 * - 只读对话（BackgroundAgentChat）：收到的指令、它说的话、工具调用（点开现取完整参数和返回）、交回的结果。运行中的跟着最新的滚；没有输入框，也没有"继续"之类的按钮。
 *   368 号票之前跑的没记它说的话，写明；有什么显示什么。
 * 数据按 HTTP 现取（背后的 agent 频道上的临时事件一来就重新取，断线重连也取），现在在做什么另看活动状态（活动频道，比重新取来得快）。说法都在 state/background-agents.ts。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../../app/store.tsx";
import { tokensText } from "../../model/labels.ts";
import {
  agentActivity,
  BACKGROUND_AGENT_STATE_LABEL,
  type BackgroundAgentEntry,
  backgroundAgentDoing,
  backgroundAgentDuration,
  backgroundAgentName,
  backgroundAgentPurpose,
  type BackgroundAgentRow,
  backgroundAgentsEntry,
  backgroundAgentStage,
  backgroundAgentsVersion,
  type BackgroundAgentTranscript,
  backgroundCallIssue,
  callFullContent,
  callSentence,
  t,
  type ToolCallDetail,
} from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { Icon } from "../icons.tsx";
import { ValueView } from "./ValueView.tsx";

/** 取这个负责人背后的 agent：版本变了、连接恢复了都重新取。取不到（老版本的守护进程、断线）就当没有，不打断页面 */
export function useBackgroundAgents(maintainerId: string | undefined): readonly BackgroundAgentRow[] {
  const { http, ui } = useStore();
  const version = maintainerId === undefined ? 0 : backgroundAgentsVersion(ui, maintainerId);
  const connected = ui.connection === "online";
  const [rows, setRows] = useState<{ of: string; rows: readonly BackgroundAgentRow[] }>();
  useEffect(() => {
    if (maintainerId === undefined) return;
    const abort = new AbortController();
    http.backgroundAgents(maintainerId).then(
      (list) => {
        if (!abort.signal.aborted) setRows({ of: maintainerId, rows: list.agents });
      },
      () => {},
    );
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- version、connected 只用来在有变化、连接恢复时重取
  }, [http, maintainerId, version, connected]);
  return rows !== undefined && rows.of === maintainerId ? rows.rows : NONE;
}

const NONE: readonly BackgroundAgentRow[] = [];

/** 运行中的每秒走一下（用时跟着变）；没有运行中的不走 */
function useTicking(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** 标题栏上的入口：从来没有过就不显示 */
export function BackgroundAgentsEntry({ maintainerId, wide, onOpen }: { maintainerId: string; wide: boolean; onOpen(): void }) {
  const entry = backgroundAgentsEntry(useBackgroundAgents(maintainerId));
  if (!entry) return null;
  return (
    <button type="button" className={`bg-entry${entry.running > 0 ? " bg-entry-running" : ""}`} data-bg-entry onClick={onOpen} aria-label={entry.label} title={entry.label}>
      <Icon name="agents" />
      {wide ? <span className="bg-entry-text">{entry.label}</span> : <span className="bg-entry-count">{entry.count}</span>}
    </button>
  );
}

/** 列表：运行中的在前 */
export function BackgroundAgentList({ maintainerId, onOpen }: { maintainerId: string; onOpen?: ((agentId: string) => void) | undefined }) {
  const rows = useBackgroundAgents(maintainerId);
  const now = useTicking(rows.some((r) => r.state === "running"));
  if (rows.length === 0) return <div className="page-placeholder">{t("ui.backgroundAgents.none")}</div>;
  return (
    <div className="bg-list">
      <div className="muted bg-list-intro">{t("ui.backgroundAgents.intro")}</div>
      {rows.map((row) => (
        <BackgroundAgentCard key={row.agentId} row={row} now={now} onOpen={onOpen && (() => onOpen(row.agentId))} />
      ))}
    </div>
  );
}

/** 一行要的事实（用时 · 工具调用 · 用量） */
function factsOf(row: BackgroundAgentRow, now: number): string {
  const duration = backgroundAgentDuration(row, now);
  return [duration, t("ui.backgroundAgents.calls", { count: row.toolCalls }), tokensText(row.tokens, row.cacheHitTokens)].filter(Boolean).join(" · ");
}

function BackgroundAgentCard({ row, now, onOpen }: { row: BackgroundAgentRow; now: number; onOpen?: (() => void) | undefined }) {
  const { ui } = useStore();
  const doing = backgroundAgentDoing(row, agentActivity(ui, row.agentId));
  const stage = backgroundAgentStage(row);
  return (
    <button type="button" className={`bg-card bg-${row.state}`} data-bg-agent={row.agentId} onClick={onOpen} disabled={!onOpen}>
      <span className="bg-card-head">
        <b className="bg-card-name">{backgroundAgentName(row)}</b>
        <span className={`st bg-st bg-st-${row.state}`}>{BACKGROUND_AGENT_STATE_LABEL[row.state]}</span>
        <span className="tool-more" aria-hidden="true">
          ›
        </span>
      </span>
      <span className="bg-card-purpose">{backgroundAgentPurpose(row)}</span>
      <span className="muted bg-card-stage">{[row.taskTitle, stage].filter(Boolean).join(" · ")}</span>
      {doing && <span className="bg-card-doing">{doing}</span>}
      <span className="muted bg-card-facts">{factsOf(row, now)}</span>
    </button>
  );
}

/** 取这个 agent 的只读对话：版本变了就重新取（运行中的实时滚动靠它） */
function useTranscript(maintainerId: string, agentId: string): { state: "loading" } | { state: "missing" } | { state: "failed"; error: string } | { state: "ready"; transcript: BackgroundAgentTranscript } {
  const { http, ui } = useStore();
  const version = backgroundAgentsVersion(ui, maintainerId);
  const [got, setGot] = useState<{ of: string; result: ReturnType<typeof useTranscript> }>();
  useEffect(() => {
    const abort = new AbortController();
    const done = (result: ReturnType<typeof useTranscript>) => {
      if (!abort.signal.aborted) setGot({ of: agentId, result });
    };
    http.backgroundAgentTranscript(agentId).then(
      (transcript) => done(transcript ? { state: "ready", transcript } : { state: "missing" }),
      (err: unknown) => done({ state: "failed", error: err instanceof Error ? err.message : String(err) }),
    );
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- version 只用来在有变化时重取
  }, [http, agentId, version]);
  return got?.of === agentId ? got.result : { state: "loading" };
}

/** 只读对话：没有输入框，也没有"继续"之类的按钮 */
export function BackgroundAgentChat({ maintainerId, agentId }: { maintainerId: string; agentId: string }) {
  const got = useTranscript(maintainerId, agentId);
  if (got.state === "loading") return <div className="muted dt-note">{t("ui.backgroundAgents.loading")}</div>;
  if (got.state === "missing") return <div className="page-placeholder">{t("ui.backgroundAgents.gone")}</div>;
  if (got.state === "failed") return <div className="page-placeholder">{t("ui.backgroundAgents.failed", { error: got.error })}</div>;
  return <TranscriptView transcript={got.transcript} />;
}

function TranscriptView({ transcript }: { transcript: BackgroundAgentTranscript }) {
  const { agent, entries, saidRecorded, instructions } = transcript;
  const running = agent.state === "running";
  const now = useTicking(running);
  const stage = backgroundAgentStage(agent);
  const hasInput = entries.some((e) => e.kind === "input");
  // 运行中的跟着最新的滚：挨着底部时才跟（往上翻着看的不拽回来），刚打开时滚到底
  const end = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const count = entries.length;
  useEffect(() => {
    if (!running || !follow.current) return;
    end.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- count 只用来在多了一条时跟着滚
  }, [running, count]);
  useEffect(() => {
    const scroller = end.current?.closest<HTMLElement>(".detail-body");
    if (!scroller || !running) return;
    const onScroll = () => {
      follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [running]);
  return (
    <div className="bg-chat" data-bg-chat={agent.state}>
      <div className="bg-chat-head">
        <div className="bg-card-head">
          <b className="bg-card-name">{backgroundAgentName(agent)}</b>
          <span className={`st bg-st bg-st-${agent.state}`}>{BACKGROUND_AGENT_STATE_LABEL[agent.state]}</span>
        </div>
        <div className="muted">{[agent.taskTitle, stage].filter(Boolean).join(" · ")}</div>
        <div className="muted bg-card-facts">{factsOf(agent, now)}</div>
      </div>
      {!hasInput && instructions && <BackgroundEntry entry={{ kind: "input", text: instructions, at: agent.startedAt ?? "" }} />}
      {entries.map((entry, i) => (
        <BackgroundEntry key={entry.kind === "tool_call" ? entry.callId : `${entry.kind}-${i}`} entry={entry} />
      ))}
      {!saidRecorded && <div className="muted bg-chat-note">{t("ui.backgroundAgents.notRecorded")}</div>}
      {/* 做完的只能看：写一句，免得找继续的按钮 */}
      <div className="muted bg-chat-end" ref={end}>
        {running ? t("ui.backgroundAgents.liveNote") : t("ui.backgroundAgents.endedNote")}
      </div>
    </div>
  );
}

/** 对话里的一条 */
function BackgroundEntry({ entry }: { entry: BackgroundAgentEntry }) {
  switch (entry.kind) {
    case "input":
      return (
        <details className="bg-input" data-bg-entry-kind="input">
          <summary>
            {t("ui.backgroundAgents.input")}
            <EntryTime at={entry.at} />
          </summary>
          <div className="dt-doc">{entry.text}</div>
        </details>
      );
    case "said":
      return (
        <div className="bg-said" data-bg-entry-kind="said">
          <div className="dt-doc md">
            <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
          </div>
          <EntryTime at={entry.at} />
        </div>
      );
    case "tool_call":
      return <BackgroundCall entry={entry} />;
    case "result":
      return (
        <div className="bg-result" data-bg-entry-kind="result">
          <div className="bg-result-title">
            {t("ui.backgroundAgents.result")}
            <EntryTime at={entry.at} />
          </div>
          <div className="dt-doc">{entry.text}</div>
        </div>
      );
  }
}

function EntryTime({ at }: { at: string }) {
  if (!at) return null;
  return <span className="muted bg-time">{clockLabel(at)}</span>;
}

/** 一次工具调用：说成人话的一句，点开现取完整参数和返回 */
function BackgroundCall({ entry }: { entry: Extract<BackgroundAgentEntry, { kind: "tool_call" }> }) {
  const [open, setOpen] = useState(false);
  const sentence = useMemo(() => callSentence({ tool: entry.tool, argsSummary: entry.argsSummary }).text, [entry.tool, entry.argsSummary]);
  const issue = backgroundCallIssue(entry.outcome);
  return (
    <details className={`bg-call${issue ? " bg-call-issue" : ""}`} data-bg-entry-kind="tool_call" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="bg-call-text">{sentence}</span>
        {issue && <span className="chip chip-stopped">{issue}</span>}
        <EntryTime at={entry.at} />
      </summary>
      {open && <BackgroundCallBody entry={entry} />}
    </details>
  );
}

function BackgroundCallBody({ entry }: { entry: Extract<BackgroundAgentEntry, { kind: "tool_call" }> }) {
  const { http } = useStore();
  const [detail, setDetail] = useState<ToolCallDetail | null>();
  useEffect(() => {
    const abort = new AbortController();
    http.toolCallDetail(entry.callId, abort.signal).then(
      (d) => {
        if (!abort.signal.aborted) setDetail(d ?? null);
      },
      () => {
        if (!abort.signal.aborted) setDetail(null);
      },
    );
    return () => abort.abort();
  }, [http, entry.callId]);
  if (detail === undefined) return <div className="muted dt-note">{t("ui.detailPane.loadingResult")}</div>;
  // 取不到（删了、清掉了）：退回摘要
  if (detail === null) return <pre className="dt-pre">{entry.resultSummary}</pre>;
  const full = callFullContent(detail);
  return (
    <div className="bg-call-body">
      <pre className="dt-pre">{entry.argsSummary}</pre>
      {full.resultValue !== undefined ? <ValueView value={full.resultValue} tool={entry.tool} /> : <div className="dt-text">{full.result}</div>}
    </div>
  );
}
