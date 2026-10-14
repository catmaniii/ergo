// 每个 agent 的会话里的 ⚙（114 号票）：秘书会话、任务整页（负责它的维护者）、项目整页（项目维护者）的标题栏上一个 ⚙（照标题栏现有的 icon-btn），
// 点开一个面板：手机是底部弹层，宽屏是屏幕正中的对话框（照仓库现有的 Sheet）。面板三块：
// - 这个 agent 单独的提示词：在通用模板后面追加（默认）、整份自己写两种，边改边查（和守护进程同一个检查），存了从它的下一轮起生效；
//   "恢复用通用模板"；下面是现在实际用的系统提示全文（只读，收着）；
// - 清空当前对话：先确认；项目维护者是重置维护者（16 号票的入口并到这里，项目档案栏里不再另放一个）；
// - 上下文用量：用了多少 / 窗口多大和进度条、上次压缩、离自动压缩还有多少，"现在压缩"；
// - 模型（120 号票，只有项目、任务的维护者有）：跟随设置 · 模型里它那一行，或者单独选定模型和思考档位；可选的模型、看图能力的说法
//   和设置 · 模型页同一套（取同一个接口），写明下一个新会话用的、最近在跑的会话实际用的、什么时候换（83 号票）。
// 设置 · 模型页上点某个单独配了模型的维护者，跳到它的页面后它的 ⚙ 自己打开（openAgentSettingsOnArrival）。
// 每次打开现取；在等清空、在压缩时过一会儿再取一次。只读的（任务结束了、项目归档了）面板照样能看，按钮都灰着。说法在状态层（state/agent-settings.ts）。
import { useCallback, useEffect, useState } from "react";
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
  type AgentSettingsView,
  checkAgentPromptDraft,
  maintainerFollowLabel,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  modelOptionLabel,
  type ModelOptionView,
  type ModelThinkingLevel,
  placeholderGroups,
  thinkingNote,
  visionText,
} from "../state/index.ts";
import { NamedText } from "./assistant-name.tsx";
import { Section, Segmented, Sheet } from "./common.tsx";
import { Icon } from "./icons.tsx";
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
      <button type="button" className="icon-btn agent-gear" aria-label="这个 agent 的设置" title="这个 agent 的设置：单独的提示词、模型、清空当前对话、上下文用量" onClick={() => setOpen(true)}>
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
      (err: unknown) => setFailed(`没取到：${errorText(err)}`),
    );
  }, [http, agentId]);
  useEffect(load, [load]);
  // 在等它说完再清、在压缩：过一会儿再取（面板关了就不取了）
  useEffect(() => {
    if (!view || !agentSettingsBusy(view)) return;
    const timer = setTimeout(load, POLL_MS);
    return () => clearTimeout(timer);
  }, [view, load]);

  return (
    <Sheet title={view ? <NamedText text={`设置 · ${view.label}`} /> : "设置"} onClose={onClose} center={wide}>
      {!view ? (
        <div className={failed ? "hint" : "muted"}>{failed ?? "正在取……"}</div>
      ) : (
        <div className="agent-panel">
          {view.readOnly && <div className="hint">{view.readOnly}</div>}
          <PromptBlock key={`${view.prompt.state}:${view.prompt.content}`} view={view} onView={setView} />
          {view.model && <ModelBlock view={view} onView={setView} />}
          <ClearBlock view={view} onView={setView} />
          <ContextBlock view={view} onView={setView} />
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
        (v) => done(v, v.prompt.state === "template" ? "追加的是空的：恢复用通用模板了" : "已保存：从它的下一轮起按新的"),
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
          done(v, "已恢复用通用模板：从它的下一轮起生效");
        },
        (err: unknown) => setRejected(errorText(err)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Section title="单独的提示词" extra={<span className="chip agent-prompt-state">{AGENT_PROMPT_STATE_LABEL[view.prompt.problem === undefined ? view.prompt.state : "template"]}</span>}>
      <div className="muted agent-note">
        现在：{agentPromptStateText(view)}。通用模板是设置 · 系统提示里的「<NamedText text={view.prompt.template.title} />」。改了从它的下一轮起生效（手头这一条说完，再按新的接着同一个会话）。
      </div>
      {view.prompt.problem && (
        <div className="prompt-broken" role="alert">
          <div>自己写的那份有错，现在用的是通用模板：</div>
          <pre>{view.prompt.problem}</pre>
        </div>
      )}
      <Segmented
        role="radio"
        label="单独的提示词怎么写"
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
        placeholder={mode === "append" ? "比如：回答尽量短，只说要点。" : undefined}
        aria-label={mode === "append" ? "追加在通用模板后面的一段" : "整份自己写的系统提示"}
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
          {busy ? "保存中…" : "保存"}
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
          撤销修改
        </button>
        <button type="button" className="btn ghost" disabled={readOnly || busy || view.prompt.state === "template"} onClick={() => setConfirmReset(true)}>
          恢复用通用模板
        </button>
      </div>
      <PlaceholderList view={view} />
      <details className="agent-effective">
        <summary>现在实际用的系统提示（全文，只读）</summary>
        <pre>{view.prompt.effective}</pre>
      </details>
      {confirmReset && (
        <Sheet title="恢复用通用模板？" onClose={() => !busy && setConfirmReset(false)} center>
          <div className="modal-body">
            <p>{view.prompt.state === "append" ? "追加的那一段会删掉，之后只用通用模板。" : "自己写的这一整份会删掉，之后用通用模板。"}删掉的找不回来。</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmReset(false)}>
              取消
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={reset}>
              恢复用通用模板
            </button>
          </div>
        </Sheet>
      )}
    </Section>
  );
}

const THINKING_OPTIONS = MODEL_THINKING_LEVELS.map((l) => ({ value: l, label: MODEL_THINKING_LABEL[l] }));

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
      (err: unknown) => live && setListError(`没取到模型清单：${errorText(err)}`),
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
        (err: unknown) => toast(`没改成：${errorText(err)}`),
      )
      .finally(() => setBusy(false));
  };
  const choose = (modelId: string) => {
    if (modelId === "") return run(http.followAgentModel(view.agentId), "改回跟随了：下一个新会话起生效");
    run(http.setAgentModel(view.agentId, { modelId, thinkingLevel: own?.thinkingLevel ?? model.role.thinkingLevel }), "单独配好了：下一个新会话起生效");
  };
  const think = (thinkingLevel: ModelThinkingLevel) => own && !busy && !readOnly && run(http.setAgentModel(view.agentId, { modelId: own.modelId, thinkingLevel }), "单独配好了：下一个新会话起生效");
  return (
    <Section title="模型">
      <div className="muted agent-note">{lines.switchNote}</div>
      {lines.unavailable && (
        <div className="prompt-broken" role="alert">
          {lines.unavailable}
        </div>
      )}
      <div className="model-choice agent-model-choice">
        <select className="input" aria-label="这个 agent 的模型" value={own?.modelId ?? ""} disabled={readOnly || busy} onChange={(e) => choose(e.target.value)}>
          <option value="">{maintainerFollowLabel(model)}</option>
          {list.map((m) => (
            <option key={m.modelId} value={m.modelId} disabled={!m.inCatalog && m.modelId !== own?.modelId}>
              {modelOptionLabel(m)}
            </option>
          ))}
        </select>
        {own && <Segmented<ModelThinkingLevel> role="radio" label="这个 agent 的思考档位" value={own.thinkingLevel} options={THINKING_OPTIONS} onChange={think} />}
      </div>
      <div className="agent-note agent-model-next">{lines.next}</div>
      {next && <div className="muted agent-note">{[visionText(next), note].filter(Boolean).join("；")}</div>}
      {listError && <div className="hint">{listError}</div>}
      {lines.session && <div className="muted agent-note">{lines.session}</div>}
      <div className="muted agent-note">它派出的子 agent、评审照设置 · 模型里各自那一行，不跟着它换。</div>
    </Section>
  );
}

/** 能用的占位符（和通用模板一样），收着 */
function PlaceholderList({ view }: { view: AgentSettingsView }) {
  const groups = placeholderGroups(view.prompt.template).filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <details className="prompt-placeholder-group">
      <summary>能用的占位符（和通用模板一样，写错了存不进去）</summary>
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
          toast(v.clear.pending ? "它正在说，说完这一条就清空" : copy.done);
        },
        (err: unknown) => {
          setConfirm(false);
          toast(`没清成：${errorText(err)}`);
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <Section title={view.clear.how === "reset_maintainer" ? "清空当前对话（重置维护者）" : "清空当前对话"}>
      <div className="muted agent-note">
        {view.clear.how === "reset_maintainer"
          ? "维护者对项目的理解存在项目档案里，不靠会话。理解跑偏了、或者想从头聊：新开一段会话，只凭项目档案重建理解，旧会话保留可查。"
          : "新开一段会话：它不再带着之前的聊天。旧消息不删，收在一条分隔线上面（更早的对话）。正在做的事不会忘：任务的计划、阶段和进展照常给它。"}
      </div>
      {line && <div className="muted agent-note">{line}</div>}
      <div className="auth-actions agent-actions">
        <button type="button" className="btn ghost" disabled={view.readOnly !== undefined || view.clear.pending || busy} onClick={() => setConfirm(true)}>
          {copy.button}
        </button>
      </div>
      {confirm && (
        <Sheet title={copy.title} onClose={() => !busy && setConfirm(false)} center>
          <div className="modal-body">
            <p>{copy.body}</p>
            {view.context.busy && <p className="muted">它正在说，等这一条说完再清。</p>}
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>
              取消
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={clear}>
              {view.clear.how === "reset_maintainer" ? "重置" : "清空"}
            </button>
          </div>
        </Sheet>
      )}
    </Section>
  );
}

/** 上下文用量和"现在压缩" */
function ContextBlock({ view, onView }: { view: AgentSettingsView; onView(v: AgentSettingsView): void }) {
  const { http } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const lines = agentContextLines(view.context, view.readOnly);
  const compact = () => {
    setBusy(true);
    http
      .compactAgent(view.agentId)
      .then(onView, (err: unknown) => toast(`没压成：${errorText(err)}`))
      .finally(() => setBusy(false));
  };
  return (
    <Section title="上下文用量">
      <div className={`agent-usage${lines.overLine ? " agent-usage-over" : ""}`}>{lines.usage}</div>
      {lines.ratio !== undefined && (
        <div className={`agent-usage-bar${lines.overLine ? " agent-usage-over" : ""}`} role="meter" aria-label="上下文用了窗口的几成" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(lines.ratio * 100)}>
          <div style={{ width: `${Math.round(lines.ratio * 1000) / 10}%` }} />
        </div>
      )}
      <div className="muted agent-note">{lines.autoCompact}</div>
      <div className="muted agent-note">{lines.lastCompacted}</div>
      {lines.compaction && <div className="agent-note">{lines.compaction}</div>}
      <div className="auth-actions agent-actions">
        <button type="button" className="btn ghost" disabled={!lines.canCompact || busy} title={lines.cannotCompact} onClick={compact}>
          {view.context.compaction === "idle" ? "现在压缩" : "压缩中…"}
        </button>
      </div>
      {lines.cannotCompact && view.readOnly === undefined && <div className="muted agent-note">{lines.cannotCompact}</div>}
      <div className="muted agent-note">压缩：更早的对话写成一段摘要，最近的原样留着；压缩那次照常记账（用途"压缩"），会话里记一笔"这里压缩过一次"。</div>
    </Section>
  );
}
