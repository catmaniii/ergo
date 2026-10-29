// 每个 agent 的会话里的 ⚙（114 号票）：秘书会话、任务整页（负责它的维护者）、项目整页（项目维护者）的标题栏上一个 ⚙（照标题栏现有的 icon-btn），
// 点开一个面板：手机是底部弹层，宽屏是屏幕正中的对话框（照仓库现有的 Sheet）。面板四块：
// - 这个 agent 自己的名字和音色（241 号票）：名字（输入框，占位写"跟默认：<默认名>"，影响界面上的称呼、它自己的系统提示、语音播报的开头）、
//   音色（下拉：跟默认 / 各个参考音色，带试听；语音插件停用时写"语音插件没启用"），都能"恢复跟默认"；
// - 这个 agent 单独的提示词：在通用模板后面追加（默认）、整份自己写两种，边改边查（和守护进程同一个检查），存了从它的下一轮起生效；
//   "恢复用通用模板"；下面是现在实际用的系统提示全文（只读，收着）；
// - 清空当前对话：先确认；项目维护者是重置维护者（16 号票的入口并到这里，项目档案栏里不再另放一个）；
// - 上下文用量：用了多少 / 窗口多大和进度条、上次压缩、离自动压缩还有多少，"现在压缩"；
// - 模型（120 号票，只有项目、任务的维护者有）：跟随设置 · 模型里它那一行，或者单独选定模型和思考档位；可选的模型、看图能力的说法
//   和设置 · 模型页同一套（取同一个接口），写明下一个新会话用的、最近在跑的会话实际用的、什么时候换（83 号票）。
// - 运行时（289 号票，只有项目、任务的维护者有；只有 pi 能用、用的也是 pi 时不显示）：用哪个运行时（下拉：现在能用的；换了先确认——手头这一条做完，原来的写交接摘要，
//   新的新开一段会话），按它的能力清单多出它的设置项（Claude Code：权限模式、思考档位，各一个下拉）；有自己模型列表的运行时多一个"模型"下拉
//   （列表是它的），这时上面"模型"一块（二狗的模型目录，pi 用的）不显示；在换时写明"等手头这一条做完""原来的在写交接摘要"。
//   运行时不支持"现在压缩"的，上下文一块不放那个按钮（界面按能力清单收起运行时不支持的按钮）。
// 设置 · 模型页上点某个单独配了模型的维护者，跳到它的页面后它的 ⚙ 自己打开（openAgentSettingsOnArrival）。
// 每次打开现取；在等清空、在压缩时过一会儿再取一次。只读的（任务结束了、项目归档了）面板照样能看，按钮都灰着。说法在状态层（state/agent-settings.ts）。
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../app/store.tsx";
import {
  agentModelLines,
  AGENT_CLEAR_COPY,
  AGENT_PROMPT_MODE_INFO,
  AGENT_PROMPT_MODES,
  AGENT_PROMPT_STATE_LABEL,
  agentClearText,
  agentContextLines,
  agentPromptDraft,
  type AgentPromptMode,
  agentPromptStateText,
  agentSettingsBusy,
  type AgentRuntimeBody,
  type AgentRuntimeView,
  type AgentSettingsView,
  checkAgentPromptDraft,
  maintainerFollowLabel,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  modelOptionLabel,
  type ModelOptionView,
  type ModelThinkingLevel,
  placeholderGroups,
  PI_RUNTIME_ID,
  runtimeBlockShown,
  runtimeOptionsFor,
  runtimeSettingValue,
  runtimeStateLine,
  runtimeSupports,
  t,
  thinkingNote,
  visionText,
} from "../state/index.ts";
import { NamedText } from "./assistant-name.tsx";
import { AgentRoleBlock } from "./agent-roles.tsx";
import { Section, Segmented, Sheet } from "./common.tsx";
import { T } from "./i18n.tsx";
import { Icon } from "./icons.tsx";
import { useRuntimes } from "./runtimes.tsx";
import { TakeoverPanel } from "./takeover.tsx";
import { useToast } from "./toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 清空的幂等键（file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数） */
const clearKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** 在等清空、在压缩时多久再取一次 */
const POLL_MS = 1500;

/** 别的页要打开的 ⚙（120 号票：设置 · 模型页上点某个单独配了模型的维护者）：跳过去之后，它的 ⚙ 挂上时自己打开一次 */
let arrival: string | undefined;

export function openAgentSettingsOnArrival(agentId: string): void {
  arrival = agentId;
}

/** 这个 agent 的 ⚙ 是不是别的页要打开的（取了就清掉，只开一次） */
function takeArrival(agentId: string): boolean {
  if (arrival !== agentId) return false;
  arrival = undefined;
  return true;
}

/** 标题栏上的 ⚙：点开这个 agent 的面板 */
export function AgentSettingsButton({ agentId, wide }: { agentId: string; wide: boolean }) {
  const [open, setOpen] = useState(() => takeArrival(agentId));
  return (
    <>
      <button type="button" className="icon-btn agent-gear" aria-label={t("ui.agentSettings.gear")} title={t("ui.agentSettings.gearTitle")} onClick={() => setOpen(true)}>
        <Icon name="gear" />
      </button>
      {open && <AgentSettingsSheet agentId={agentId} wide={wide} onClose={() => setOpen(false)} />}
    </>
  );
}

function AgentSettingsSheet({ agentId, wide, onClose }: { agentId: string; wide: boolean; onClose(): void }) {
  const { http } = useStore();
  const [view, setView] = useState<AgentSettingsView>();
  const [failed, setFailed] = useState<string>();
  const load = useCallback(() => {
    http.agentSettings(agentId).then(
      (v) => {
        setView(v);
        setFailed(undefined);
      },
      (err: unknown) => setFailed(t("ui.agentSettings.loadFailed", { error: errorText(err) })),
    );
  }, [http, agentId]);
  useEffect(load, [load]);
  // 运行时清单（289 号票）：打开时现取（运行时一块的选项、模型、设置项，按能力清单收起按钮）
  const runtimes = useRuntimes(true);
  // 在等它说完再清、在压缩、在换运行时：过一会儿再取（面板关了就不取了）
  useEffect(() => {
    if (!view || (!agentSettingsBusy(view) && !view.runtime?.switching)) return;
    const timer = setTimeout(load, POLL_MS);
    return () => clearTimeout(timer);
  }, [view, load]);

  return (
    <Sheet title={view ? <NamedText text={t("ui.agentSettings.titleOf", { label: view.label })} /> : t("ui.agentSettings.title")} onClose={onClose} center={wide}>
      {!view ? (
        <div className={failed ? "hint" : "muted"}>{failed ?? t("ui.agentSettings.loading")}</div>
      ) : (
        <div className="agent-panel">
          {view.readOnly && <div className="hint">{view.readOnly}</div>}
          <AgentRoleBlock view={view} onSaved={load} />
          <PromptBlock key={`${view.prompt.state}:${view.prompt.content}`} view={view} onView={setView} />
          {runtimeBlockShown(runtimes, view.runtime) && <RuntimeBlock view={view} runtimes={runtimes} onView={setView} />}
          {/* 二狗的模型目录（pi 用的）：运行时有自己的模型列表的（Claude Code）不显示，模型在运行时一块里选 */}
          {view.model && !runtimeOwnModels(runtimes, view.runtime?.id) && <ModelBlock view={view} onView={setView} />}
          <ClearBlock view={view} onView={setView} />
          <ContextBlock view={view} onView={setView} canCompact={runtimeSupports(runtimes, view.runtime?.id, "compact")} />
        </div>
      )}
    </Sheet>
  );
}

/** 单独的提示词：两种写法、编辑框、按钮、实际用的全文 */
function PromptBlock({ view, onView }: { view: AgentSettingsView; onView(v: AgentSettingsView): void }) {
  const { http } = useStore();
  const toast = useToast();
  const [mode, setMode] = useState<AgentPromptMode>(view.prompt.state === "replace" ? "replace" : "append");
  const [draft, setDraft] = useState<string>();
  const [rejected, setRejected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const readOnly = view.readOnly !== undefined;
  const value = draft ?? agentPromptDraft(view, mode);
  const check = checkAgentPromptDraft(view, mode, value);
  const problem = rejected ?? check.problem;

  const done = (v: AgentSettingsView, text: string) => {
    setDraft(undefined);
    setRejected(undefined);
    onView(v);
    toast(text);
  };
  const save = () => {
    setBusy(true);
    http
      .saveAgentPrompt(view.agentId, { mode, content: value })
      .then(
        (v) => done(v, v.prompt.state === "template" ? t("ui.agentSettings.prompt.savedEmpty") : t("ui.agentSettings.prompt.saved")),
        (err: unknown) => setRejected(errorText(err)),
      )
      .finally(() => setBusy(false));
  };
  const reset = () => {
    setBusy(true);
    http
      .resetAgentPrompt(view.agentId)
      .then(
        (v) => {
          setConfirmReset(false);
          done(v, t("ui.agentSettings.prompt.resetDone"));
        },
        (err: unknown) => setRejected(errorText(err)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Section title={t("ui.agentSettings.prompt.title")} extra={<span className="chip agent-prompt-state">{AGENT_PROMPT_STATE_LABEL[view.prompt.problem === undefined ? view.prompt.state : "template"]}</span>}>
      <div className="muted agent-note">
        <T k="ui.agentSettings.prompt.note" params={{ state: agentPromptStateText(view), template: <NamedText text={view.prompt.template.title} /> }} />
      </div>
      {view.prompt.problem && (
        <div className="prompt-broken" role="alert">
          <div>{t("ui.agentSettings.prompt.broken")}</div>
          <pre>{view.prompt.problem}</pre>
        </div>
      )}
      <Segmented
        role="radio"
        label={t("ui.agentSettings.prompt.modeLabel")}
        value={mode}
        options={AGENT_PROMPT_MODES.map((m) => ({ value: m, label: AGENT_PROMPT_MODE_INFO[m].label }))}
        onChange={(m) => {
          setMode(m);
          setDraft(undefined);
          setRejected(undefined);
        }}
      />
      <div className="muted agent-note">{AGENT_PROMPT_MODE_INFO[mode].hint}</div>
      <textarea
        className="input prompt-editor agent-prompt-editor"
        value={value}
        spellCheck={false}
        readOnly={readOnly}
        placeholder={mode === "append" ? t("ui.agentSettings.prompt.placeholder") : undefined}
        aria-label={mode === "append" ? t("ui.agentSettings.prompt.appendLabel") : t("ui.agentSettings.prompt.replaceLabel")}
        aria-invalid={problem !== undefined}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setRejected(undefined);
        }}
      />
      {problem && (
        <pre className="field-error prompt-problem" role="alert">
          {problem}
        </pre>
      )}
      <div className="prompt-actions">
        <button type="button" className="btn primary" disabled={readOnly || busy || !check.changed || !check.ok} onClick={save}>
          {busy ? t("ui.agentSettings.saving") : t("ui.agentSettings.save")}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy || draft === undefined}
          onClick={() => {
            setDraft(undefined);
            setRejected(undefined);
          }}
        >
          {t("ui.agentSettings.prompt.discard")}
        </button>
        <button type="button" className="btn ghost" disabled={readOnly || busy || view.prompt.state === "template"} onClick={() => setConfirmReset(true)}>
          {t("ui.agentSettings.prompt.reset")}
        </button>
      </div>
      <PlaceholderList view={view} />
      <details className="agent-effective">
        <summary>{t("ui.agentSettings.prompt.effective")}</summary>
        <pre>{view.prompt.effective}</pre>
      </details>
      {/* 确认挂到 body 上（同运行时一块的换运行时确认）：手机上 ⚙ 是底部弹层，套在里面的弹层会被它的滚动区裁掉、看不见 */}
      {confirmReset &&
        createPortal(
          <Sheet title={t("ui.agentSettings.prompt.resetConfirmTitle")} onClose={() => !busy && setConfirmReset(false)} center>
            <div className="modal-body">
              <p>{view.prompt.state === "append" ? t("ui.agentSettings.prompt.resetConfirmAppend") : t("ui.agentSettings.prompt.resetConfirmReplace")}</p>
            </div>
            <div className="auth-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmReset(false)}>
                {t("ui.agentSettings.cancel")}
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={reset}>
                {t("ui.agentSettings.prompt.reset")}
              </button>
            </div>
          </Sheet>,
          document.body,
        )}
    </Section>
  );
}

/** 思考档位的选项（现取：档位的名字跟着当前语言） */
const thinkingOptions = () => MODEL_THINKING_LEVELS.map((l) => ({ value: l, label: MODEL_THINKING_LABEL[l] }));

/** 模型（120 号票）：跟随它那一行，或者单独选定模型和思考档位；可选的模型和看图能力取设置 · 模型的同一份（GET /api/model-settings） */
function ModelBlock({ view, onView }: { view: AgentSettingsView; onView(v: AgentSettingsView): void }) {
  const { http } = useStore();
  const toast = useToast();
  const [models, setModels] = useState<readonly ModelOptionView[]>();
  const [listError, setListError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    http.modelSettings().then(
      (v) => live && setModels(v.models),
      (err: unknown) => live && setListError(t("ui.agentSettings.model.listFailed", { error: errorText(err) })),
    );
    return () => {
      live = false;
    };
  }, [http]);
  const model = view.model!;
  const lines = agentModelLines(model);
  const readOnly = view.readOnly !== undefined;
  const own = model.own;
  // 清单还没取到时下拉里至少有单独配的那一个（看得出现在选的是什么）
  const list = models ?? (own ? [{ modelId: own.modelId, inCatalog: true }] : []);
  // 看图能力、思考档位的说明：清单取到了才写（和设置 · 模型页同一套说法）
  const next = models?.find((m) => m.modelId === model.next.modelId);
  const note = thinkingNote(next, model.next.thinkingLevel);
  const run = (request: Promise<AgentSettingsView>, done: string) => {
    setBusy(true);
    request
      .then(
        (v) => {
          onView(v);
          toast(done);
        },
        (err: unknown) => toast(t("ui.agentSettings.model.changeFailed", { error: errorText(err) })),
      )
      .finally(() => setBusy(false));
  };
  const choose = (modelId: string) => {
    if (modelId === "") return run(http.followAgentModel(view.agentId), t("ui.agentSettings.model.followed"));
    run(http.setAgentModel(view.agentId, { modelId, thinkingLevel: own?.thinkingLevel ?? model.role.thinkingLevel }), t("ui.agentSettings.model.own"));
  };
  const think = (thinkingLevel: ModelThinkingLevel) => own && !busy && !readOnly && run(http.setAgentModel(view.agentId, { modelId: own.modelId, thinkingLevel }), t("ui.agentSettings.model.own"));
  return (
    <Section title={t("ui.agentSettings.model.title")}>
      <div className="muted agent-note">{lines.switchNote}</div>
      {lines.unavailable && (
        <div className="prompt-broken" role="alert">
          {lines.unavailable}
        </div>
      )}
      <div className="model-choice agent-model-choice">
        <select className="input" aria-label={t("ui.agentSettings.model.select")} value={own?.modelId ?? ""} disabled={readOnly || busy} onChange={(e) => choose(e.target.value)}>
          <option value="">{maintainerFollowLabel(model)}</option>
          {list.map((m) => (
            <option key={m.modelId} value={m.modelId} disabled={!m.inCatalog && m.modelId !== own?.modelId}>
              {modelOptionLabel(m)}
            </option>
          ))}
        </select>
        {own && <Segmented<ModelThinkingLevel> role="radio" label={t("ui.agentSettings.model.thinking")} value={own.thinkingLevel} options={thinkingOptions()} onChange={think} />}
      </div>
      <div className="agent-note agent-model-next">{lines.next}</div>
      {next && <div className="muted agent-note">{[visionText(next), note].filter(Boolean).join(t("ui.agentSettings.model.noteSep"))}</div>}
      {listError && <div className="hint">{listError}</div>}
      {lines.session && <div className="muted agent-note">{lines.session}</div>}
      <div className="muted agent-note">{t("ui.agentSettings.model.subAgents")}</div>
    </Section>
  );
}

/** 这个运行时有没有自己的模型列表（有的话模型在运行时一块里选） */
const runtimeOwnModels = (runtimes: readonly AgentRuntimeView[] | undefined, id: string | undefined): boolean =>
  id !== undefined && id !== PI_RUNTIME_ID && runtimes?.find((r) => r.id === id)?.models !== undefined;

/**
 * 运行时（289 号票）：用哪个运行时（换了先确认）、它自己的模型（有列表的）、按能力清单多出的设置项。改了从下一轮起（手头这一条处理完按新的
 * 重新拉起）；换运行时的等手头这一条做完、原来的写好交接摘要才换
 */
function RuntimeBlock({ view, runtimes, onView }: { view: AgentSettingsView; runtimes: readonly AgentRuntimeView[] | undefined; onView(v: AgentSettingsView): void }) {
  const { http } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [switchTo, setSwitchTo] = useState<string>();
  const state = view.runtime!;
  const readOnly = view.readOnly !== undefined;
  const current = runtimes?.find((r) => r.id === state.id);
  const line = runtimeStateLine(state);
  const options = runtimeOptionsFor(runtimes, state);
  const run = (body: AgentRuntimeBody, done: string) => {
    setBusy(true);
    http
      .setAgentRuntime(view.agentId, body)
      .then(
        (v) => {
          setSwitchTo(undefined);
          onView(v);
          toast(done);
        },
        (err: unknown) => toast(t("ui.agentSettings.runtime.changeFailed", { error: errorText(err) })),
      )
      .finally(() => setBusy(false));
  };
  /** 只改选的值：运行时不变，别的照旧 */
  const choose = (patch: { model?: string | null; setting?: { id: string; value: string } }) => {
    const model = patch.model === undefined ? state.model : (patch.model ?? undefined);
    const settings = { ...state.settings, ...(patch.setting ? { [patch.setting.id]: patch.setting.value } : {}) };
    run({ runtime: state.id, ...(model === undefined ? {} : { model }), settings }, t("ui.agentSettings.runtime.saved"));
  };
  const target = switchTo === undefined ? undefined : options.find((o) => o.id === switchTo);
  return (
    <Section title={t("ui.agentSettings.runtime.title")}>
      <div className="muted agent-note">{t("ui.agentSettings.runtime.note")}</div>
      {/* 接管自已有的会话（290 号票）：哪个会话、工作目录、交还 / 收回 */}
      <TakeoverPanel view={view} onView={onView} />
      {/* 维护者在哪个文件夹做（305 号票）：能选工作文件夹的运行时写出来；接管来的上面那一块写了 */}
      {state.workdir !== undefined && state.takeover === undefined && <div className="muted agent-note agent-workdir">{t("ui.agentSettings.runtime.workdir", { path: state.workdir })}</div>}
      {line && (
        <div className={state.switching ? "agent-note agent-runtime-state" : "prompt-broken"} role={state.switching ? undefined : "alert"}>
          {line}
        </div>
      )}
      <div className="model-choice agent-runtime-choice">
        <select
          className="input"
          aria-label={t("ui.agentSettings.runtime.select")}
          value={state.switching?.to ?? state.id}
          disabled={readOnly || busy || state.switching !== undefined}
          onChange={(e) => e.target.value !== state.id && setSwitchTo(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id} disabled={o.disabled}>
              {o.title}
            </option>
          ))}
        </select>
      </div>
      {current?.models && !state.switching && (
        <label className="agent-runtime-field">
          <span>{t("ui.agentSettings.runtime.model")}</span>
          <select className="input" value={state.model ?? ""} disabled={readOnly || busy} onChange={(e) => choose({ model: e.target.value === "" ? null : e.target.value })}>
            <option value="">{t("ui.agentSettings.runtime.modelInherit", { runtime: state.title })}</option>
            {current.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {!state.switching &&
        current?.settings.map((setting) => (
          <label key={setting.id} className="agent-runtime-field">
            <span>{setting.title}</span>
            <select className="input" value={runtimeSettingValue(setting, state)} disabled={readOnly || busy} onChange={(e) => choose({ setting: { id: setting.id, value: e.target.value } })}>
              {setting.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.title}
                </option>
              ))}
            </select>
          </label>
        ))}
      {/* 确认挂到 body 上：手机上 ⚙ 是底部弹层，套在里面的弹层会被它的滚动区裁掉、看不见 */}
      {target &&
        createPortal(
          <Sheet title={t("ui.agentSettings.runtime.confirmTitle", { to: target.title })} onClose={() => !busy && setSwitchTo(undefined)} center>
            <div className="modal-body">
              <p>{t("ui.agentSettings.runtime.confirmBody", { from: state.title, to: target.title })}</p>
              {view.context.busy && <p className="muted">{t("ui.agentSettings.runtime.confirmBusy")}</p>}
            </div>
            <div className="auth-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setSwitchTo(undefined)}>
                {t("ui.agentSettings.cancel")}
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => run({ runtime: target.id }, t("ui.agentSettings.runtime.switching", { to: target.title }))}>
                {t("ui.agentSettings.runtime.confirm")}
              </button>
            </div>
          </Sheet>,
          document.body,
        )}
    </Section>
  );
}

/** 能用的占位符（和通用模板一样），收着 */
function PlaceholderList({ view }: { view: AgentSettingsView }) {
  const groups = placeholderGroups(view.prompt.template).filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <details className="prompt-placeholder-group">
      <summary>{t("ui.agentSettings.placeholders")}</summary>
      {groups.map((g) => (
        <div key={g.title}>
          <div className="prompt-placeholder-title">{g.title}</div>
          <dl className="prompt-placeholders">
            {g.items.map((it) => (
              <div key={it.code}>
                <dt>
                  <code>{it.code}</code>
                </dt>
                <dd>{it.description}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </details>
  );
}

/** 清空当前对话（项目维护者：重置维护者）：先确认 */
function ClearBlock({ view, onView }: { view: AgentSettingsView; onView(v: AgentSettingsView): void }) {
  const { http } = useStore();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = AGENT_CLEAR_COPY[view.clear.how];
  const line = agentClearText(view);
  const clear = () => {
    setBusy(true);
    http
      .clearAgent(view.agentId, clearKey())
      .then(
        (v) => {
          setConfirm(false);
          onView(v);
          toast(v.clear.pending ? t("ui.agentSettings.clear.pending") : copy.done);
        },
        (err: unknown) => {
          setConfirm(false);
          toast(t("ui.agentSettings.clear.failed", { error: errorText(err) }));
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <Section title={view.clear.how === "reset_maintainer" ? t("ui.agentSettings.clear.titleReset") : t("ui.agentSettings.clear.title")}>
      <div className="muted agent-note">
        {view.clear.how === "reset_maintainer"
          ? t("ui.agentSettings.clear.noteReset")
          : t("ui.agentSettings.clear.note")}
      </div>
      {line && <div className="muted agent-note">{line}</div>}
      <div className="auth-actions agent-actions">
        <button type="button" className="btn ghost" disabled={view.readOnly !== undefined || view.clear.pending || busy} onClick={() => setConfirm(true)}>
          {copy.button}
        </button>
      </div>
      {/* 确认挂到 body 上（同运行时一块的换运行时确认）：手机上 ⚙ 是底部弹层，套在里面的弹层会被它的滚动区裁掉、看不见 */}
      {confirm &&
        createPortal(
          <Sheet title={copy.title} onClose={() => !busy && setConfirm(false)} center>
            <div className="modal-body">
              <p>{copy.body}</p>
              {view.context.busy && <p className="muted">{t("ui.agentSettings.clear.busy")}</p>}
            </div>
            <div className="auth-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>
                {t("ui.agentSettings.cancel")}
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={clear}>
                {view.clear.how === "reset_maintainer" ? t("ui.agentSettings.clear.reset") : t("ui.agentSettings.clear.clear")}
              </button>
            </div>
          </Sheet>,
          document.body,
        )}
    </Section>
  );
}

/** 上下文用量和"现在压缩"（289 号票：运行时不支持压缩的不放按钮） */
function ContextBlock({ view, onView, canCompact = true }: { view: AgentSettingsView; onView(v: AgentSettingsView): void; canCompact?: boolean }) {
  const { http } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const lines = agentContextLines(view.context, view.readOnly);
  const compact = () => {
    setBusy(true);
    http
      .compactAgent(view.agentId)
      .then(onView, (err: unknown) => toast(t("ui.agentSettings.context.compactFailed", { error: errorText(err) })))
      .finally(() => setBusy(false));
  };
  return (
    <Section title={t("ui.agentSettings.context.title")}>
      <div className={`agent-usage${lines.overLine ? " agent-usage-over" : ""}`}>{lines.usage}</div>
      {lines.ratio !== undefined && (
        <div className={`agent-usage-bar${lines.overLine ? " agent-usage-over" : ""}`} role="meter" aria-label={t("ui.agentSettings.context.meter")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(lines.ratio * 100)}>
          <div style={{ width: `${Math.round(lines.ratio * 1000) / 10}%` }} />
        </div>
      )}
      <div className="muted agent-note">{lines.autoCompact}</div>
      <div className="muted agent-note">{lines.lastCompacted}</div>
      {lines.compaction && <div className="agent-note">{lines.compaction}</div>}
      {canCompact && (
        <div className="auth-actions agent-actions">
          <button type="button" className="btn ghost" disabled={!lines.canCompact || busy} title={lines.cannotCompact} onClick={compact}>
            {view.context.compaction === "idle" ? t("ui.agentSettings.context.compact") : t("ui.agentSettings.context.compacting")}
          </button>
        </div>
      )}
      {canCompact && lines.cannotCompact && view.readOnly === undefined && <div className="muted agent-note">{lines.cannotCompact}</div>}
      <div className="muted agent-note">{t("ui.agentSettings.context.note")}</div>
    </Section>
  );
}
