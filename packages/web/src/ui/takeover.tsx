// 从运行时已有的会话接管（290 号票）在界面上：新建任务、项目的对话框里选了能接管已有会话的运行时（Claude Code）时，运行时那一排下面多一个
// "从 Claude Code 会话接管…"（TakeoverLink）；点了换成接管的对话框（TakeoverSheet）：列本机的会话（每次现取，能刷新），一行一个——标题、
// 工作目录、分支 · 最近活动 · 大小，被占着的带一个签写明在哪；选中被占着的下面说清为什么不能直接接（终端里开着的没有锁，接了会分叉、丢话），
// 能勾"分叉一份接管"；接成任务要写接着让它做什么，接成项目可以不写。说法在状态层（state/takeover.ts）。
// ⚙ 里接管来的那一行（交还 / 收回）在 agent-settings.tsx 的运行时一块里（TakeoverPanel）；292 号票起它也是"会话在哪边"那一块：交给官方 App、
// 在官方 App 里时的标记和链接、收回到<名字>（说法和按钮在状态层的 takeoverPanel）。
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import {
  type AgentSettingsView,
  type ResumableSessionView,
  sessionMetaLine,
  t,
  type TakeoverAction,
  type TakeoverKind,
  takeoverPanel,
  takeoverPick,
  takeoverReady,
  takeoverRuntime,
  takeoverToast,
} from "../state/index.ts";
import { AssistantName, useAssistantName } from "./assistant-name.tsx";
import { Sheet } from "./common.tsx";
import { T } from "./i18n.tsx";
import { useRuntimes } from "./runtimes.tsx";
import { useToast } from "./toast.tsx";

const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 运行时那一排下面的入口：选的运行时能接管已有会话才有 */
export function TakeoverLink({ runtime, onOpen }: { runtime: string; onOpen(): void }) {
  const found = takeoverRuntime(useRuntimes(), runtime);
  if (!found) return null;
  return (
    <button type="button" className="takeover-link" onClick={onOpen}>
      {t("ui.takeover.link", { runtime: found.title })}
    </button>
  );
}

/**
 * 接管的对话框：as 是建任务还是项目；initial 是原来对话框里已经写了的话（带过来，省得重写）；onBack 回原来的对话框，onClose 关掉
 * （接管好了也关掉）
 */
export function TakeoverSheet({ runtime, as, initial, onBack, onClose }: { runtime: string; as: TakeoverKind; initial: string; onBack(): void; onClose(): void }) {
  const { http } = useStore();
  const toast = useToast();
  const found = takeoverRuntime(useRuntimes(), runtime);
  const runtimeTitle = found?.title ?? runtime;
  /** 取到的会话和取到的时间（"几分钟前"按它算） */
  const [listed, setListed] = useState<{ sessions: ResumableSessionView[]; at: number }>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string>();
  const [fork, setFork] = useState(false);
  const [request, setRequest] = useState(initial);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  /** 同一次接管重发用同一个幂等键（换了会话、勾了分叉就换一个） */
  const [key, setKey] = useState(newKey);

  const fetchSessions = useCallback(
    () =>
      http
        .runtimeSessions(runtime)
        .then(
          (view) => setListed({ sessions: view.sessions, at: Date.now() }),
          (err: unknown) => setLoadError(errorText(err)),
        )
        .finally(() => setLoading(false)),
    [http, runtime],
  );
  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);
  const refresh = () => {
    setLoading(true);
    setLoadError(undefined);
    void fetchSessions();
  };

  const sessions = listed?.sessions;
  const session = sessions?.find((s) => s.id === picked);
  const pick = session ? takeoverPick(session, runtimeTitle) : undefined;
  const ready = takeoverReady({ session, fork, as, request }) && !sending;

  const choose = (id: string) => {
    setPicked(id);
    setFork(false);
    setSendError(undefined);
    setKey(newKey());
  };
  const submit = () => {
    if (!session) return;
    setSending(true);
    setSendError(undefined);
    http
      .takeOver(runtime, { sessionId: session.id, as, request: request.trim(), ...(fork ? { fork: true } : {}), idempotencyKey: key })
      .then(
        (result) => {
          toast(takeoverToast({ as, id: result.taskId ?? result.projectId ?? "", title: session.title, fork, runtimeTitle }));
          onClose();
        },
        (err: unknown) => setSendError(errorText(err)),
      )
      .finally(() => setSending(false));
  };

  return (
    <Sheet title={t("ui.takeover.title", { runtime: runtimeTitle })} onClose={onClose} center>
      <div className="hint takeover-intro">
        <T k={as === "task" ? "ui.takeover.introTask" : "ui.takeover.introProject"} params={{ runtime: runtimeTitle, name: <AssistantName /> }} />
      </div>
      <div className="takeover-bar">
        <span className="muted">{sessions === undefined ? (loading ? t("ui.takeover.loading") : "") : t("ui.takeover.count", { count: sessions.length, n: sessions.length })}</span>
        <button type="button" className="btn small ghost" disabled={loading} onClick={refresh}>
          {t("ui.takeover.refresh")}
        </button>
      </div>
      {loadError && (
        <div className="prompt-broken" role="alert">
          {t("ui.takeover.loadFailed", { error: loadError })}
        </div>
      )}
      {sessions && sessions.length === 0 && <div className="hint">{t("ui.takeover.empty", { runtime: runtimeTitle })}</div>}
      {sessions && sessions.length > 0 && (
        <div className="takeover-list" role="radiogroup" aria-label={t("ui.takeover.title", { runtime: runtimeTitle })}>
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={picked === s.id}
              className={`takeover-row${picked === s.id ? " on" : ""}${s.busy !== undefined ? " busy" : ""}`}
              onClick={() => choose(s.id)}
            >
              <span className="takeover-title">{s.title}</span>
              <span className="takeover-cwd">{s.cwd}</span>
              <span className="takeover-meta">
                <span>{sessionMetaLine(s, listed!.at)}</span>
                {s.busy !== undefined && <span className={`chip ${s.heldBy ? "chip-quiet" : "chip-no"} takeover-busy`}>{s.heldBy ? t("ui.takeover.held") : t("ui.takeover.busy")}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {session && pick?.busy && (
        <div className="takeover-note">
          <div>{pick.note}</div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={fork}
              onChange={(e) => {
                setFork(e.target.checked);
                setKey(newKey());
              }}
            />
            <span>{t("ui.takeover.fork")}</span>
          </label>
        </div>
      )}
      {session && (
        <div className="hint takeover-where">
          <T k="ui.takeover.where" params={{ cwd: <code>{session.cwd}</code> }} />
        </div>
      )}
      <label className="field">
        <span>{as === "task" ? t("ui.takeover.requestTask") : t("ui.takeover.requestProject")}</span>
        <textarea value={request} onChange={(e) => setRequest(e.target.value)} placeholder={as === "task" ? t("ui.takeover.placeholderTask") : t("ui.takeover.placeholderProject")} />
      </label>
      {sendError && (
        <div className="prompt-broken" role="alert">
          {sendError}
        </div>
      )}
      <div className="auth-actions sc-actions">
        <button type="button" className="btn ghost" disabled={sending} onClick={onBack}>
          {t("ui.takeover.back")}
        </button>
        <button type="button" className="btn primary" disabled={!ready} onClick={submit}>
          {fork ? t("ui.takeover.submitFork") : t("ui.takeover.submit")}
        </button>
      </div>
    </Sheet>
  );
}

/** ⚙ 运行时一块里接管来的那一行：接管自哪个会话、工作目录；交还 / 收回 */
export function TakeoverPanel({ view, onView }: { view: AgentSettingsView; onView(v: AgentSettingsView): void }) {
  const { http } = useStore();
  const toast = useToast();
  const name = useAssistantName();
  /** 正在做的那个动作（交给官方 App 要等进程退干净、后台会话开起来，几秒到半分钟） */
  const [busy, setBusy] = useState<TakeoverAction>();
  const state = view.runtime;
  const panel = state ? takeoverPanel(state, name) : undefined;
  if (!state || !panel) return null;
  const done = (action: TakeoverAction) =>
    action === "remote" ? t("ui.takeover.remoteDone") : action === "reclaim" ? t("ui.takeover.reclaimed", { runtime: state.title }) : t("ui.takeover.returned", { runtime: state.title });
  const act = (action: TakeoverAction) => {
    setBusy(action);
    http
      .agentTakeover(view.agentId, action)
      .then(
        (v) => {
          onView(v);
          toast(done(action));
        },
        (err: unknown) => toast(t("ui.takeover.actFailed", { error: errorText(err) })),
      )
      .finally(() => setBusy(undefined));
  };
  const working = (action: TakeoverAction, label: string) => (busy !== action ? label : action === "remote" ? t("ui.takeover.remoteBusy") : action === "reclaim" ? t("ui.takeover.reclaimBusy") : label);
  return (
    <div className={`takeover-panel${panel.place === "ergo" ? "" : ` ${panel.place}`}`}>
      {panel.head !== undefined && (
        <div className="takeover-panel-head">
          {panel.head}
          {panel.place === "remote" && <span className="chip remote-badge">{t("state.takeover.remoteBadge")}</span>}
        </div>
      )}
      {panel.where !== undefined && <div className="takeover-cwd">{panel.where}</div>}
      <div className="muted takeover-panel-note">{panel.note}</div>
      {panel.url !== undefined && (
        <a className="takeover-remote-link" href={panel.url} target="_blank" rel="noreferrer">
          {t("ui.takeover.openLink")}
          <span className="takeover-remote-url">{panel.url}</span>
        </a>
      )}
      {panel.noLink !== undefined && <div className="muted takeover-panel-note">{panel.noLink}</div>}
      <div className="takeover-actions">
        {panel.buttons.map((b) => (
          <button key={b.action} type="button" className={`btn small ${b.primary ? "primary" : "ghost"}`} disabled={busy !== undefined || view.readOnly !== undefined} onClick={() => act(b.action)}>
            {working(b.action, b.label)}
          </button>
        ))}
      </div>
    </div>
  );
}
