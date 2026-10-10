// 设置 · 模型（73 号票，用户 2026-10-10 定）：设置里的一项，点进去是这一页。
// - 服务商：DeepSeek（在服务端调用），目前唯一、选不了别的，写一句"以后会支持更多服务商"；
// - API key：只显示已配置 / 没配置和来源（LSM 从数据目录的密钥区注入），不显示 key、也不在这里输入；没配置时说去 LSM 里配；
// - 默认模型和思考档位（关、低、中、高），旁边是连通测试（发一条极短的请求，显示通不通、首 token 延迟）；
// - 各个 agent：秘书、任务维护者、项目维护者、子 agent、评审、范围审视各自用什么模型，"跟随默认"或者选定模型和思考档位；
// - 设置文件读不出来（读不了、不合规）时最上面提示"设置文件读不出来，正在用默认；保存会覆盖它"和原因；
// - 看图能力：每个模型能不能看图、按什么定的（这里改的、配置文件写明、模型目录），这里能改；
// - 生效时机写在最上面：一个会话固定一个模型，改了以后下一个新会话生效；长会话（秘书、项目维护者的对话、定时作业的维护者）
//   下一轮新开会话、附交接摘要，任务执行中途不换（83 号票）。每个 agent 一行下面另有一句它的会话什么时候换。
// 设置存在守护进程（各设备一样）：打开页面时取一次（GET /api/model-settings），每改一处就把整份存回去，守护进程查过合规才存
// （不合规时说原因、页面照旧）。说法和"改一处、存整份"在状态层（state/model-settings.ts）。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  apiKeyText,
  MODEL_PROVIDER_NOTE,
  MODEL_AGENT_LABEL,
  MODEL_AGENT_NOTE,
  MODEL_AGENTS,
  MODEL_AGENTS_NOTE,
  MODEL_SETTINGS_EFFECT_NOTE,
  MODEL_SETTINGS_FILE_BROKEN_NOTE,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  modelKeyOf,
  modelOptionLabel,
  modelTestText,
  agentSummary,
  sessionModelText,
  thinkingNote,
  visionChoiceOf,
  visionFollowLabel,
  visionText,
  withDefault,
  withAgent,
  withVision,
  type ModelOptionView,
  type ModelAgent,
  type ModelSettingsBody,
  type ModelSettingsView,
  type ModelTestResult,
  type ModelThinkingLevel,
  type ModelVisionChoice,
} from "../../state/index.ts";
import { NamedText, useNamedPlain } from "../../ui/assistant-name.tsx";
import { Section, Segmented } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

const THINKING_OPTIONS = MODEL_THINKING_LEVELS.map((l) => ({ value: l, label: MODEL_THINKING_LABEL[l] }));

export function ModelsPage() {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<ModelSettingsView>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ModelTestResult>();

  useEffect(() => {
    let live = true;
    http.modelSettings().then(
      (v) => {
        if (!live) return;
        setView(v);
        setError(undefined);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [http]);

  if (!view) return <div className="muted">{error ? `取不到模型设置：${error}` : "正在取模型设置……"}</div>;

  const save = (body: ModelSettingsBody) => {
    setSaving(true);
    http
      .saveModelSettings(body)
      .then(
        (v) => {
          setView(v);
          toast("存好了：下一个新会话起生效");
        },
        (err: unknown) => toast(`没存成：${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setSaving(false));
  };
  const runTest = () => {
    setTesting(true);
    setTest(undefined);
    http
      .testModel(view.settings.default.modelId)
      .then(setTest, (err: unknown) => setTest({ ok: false, modelId: view.settings.default.modelId, totalMs: 0, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => setTesting(false));
  };

  const { settings } = view;
  const key = apiKeyText(view.apiKey);
  const provider = view.providers.find((p) => p.id === settings.provider);
  const optionOf = (modelId: string) => view.models.find((m) => m.modelId === modelId);
  const defaultNote = thinkingNote(optionOf(settings.default.modelId), settings.default.thinkingLevel);
  const tested = test && modelTestText(test);

  return (
    <div className="models-page">
      <div className="model-effect">
        <NamedText text={MODEL_SETTINGS_EFFECT_NOTE} />
      </div>
      {view.settingsFileError && (
        <div className="model-file-broken" role="alert">
          <b>{MODEL_SETTINGS_FILE_BROKEN_NOTE}</b>
          <span className="muted">{view.settingsFileError}</span>
        </div>
      )}
      <Section title="服务商">
        <div className="voice-engines" role="radiogroup" aria-label="模型服务商">
          {view.providers.map((p) => (
            <label key={p.id} className="check-row radio-row">
              <input type="radio" name="model-provider" value={p.id} checked={p.id === settings.provider} readOnly />
              <span>
                <b>{p.label}</b>
                <span className="muted">在服务端调用</span>
              </span>
            </label>
          ))}
        </div>
        <span className="muted">{MODEL_PROVIDER_NOTE}</span>
      </Section>

      <Section title="API key">
        <div className="skill-row model-key-row">
          <div>
            <b>{provider?.label ?? settings.provider} 的 API key</b>
            <span className="muted">{key.detail}</span>
          </div>
          <span className={`chip ${key.ok ? "chip-ok" : "chip-no"}`}>{key.label}</span>
        </div>
      </Section>

      <Section
        title="默认模型"
        extra={
          <button type="button" className="btn ghost small" disabled={testing} onClick={runTest}>
            {testing ? "测试中…" : "连通测试"}
          </button>
        }
      >
        <div className="model-choice">
          <ModelSelect label="默认模型" models={view.models} value={settings.default.modelId} disabled={saving} onChange={(modelId) => modelId && save(withDefault(settings, { modelId }))} />
          <Segmented<ModelThinkingLevel>
            role="radio"
            label="默认的思考档位"
            value={settings.default.thinkingLevel}
            options={THINKING_OPTIONS}
            onChange={(thinkingLevel) => !saving && save(withDefault(settings, { thinkingLevel }))}
          />
        </div>
        {defaultNote && <span className="muted">{defaultNote}</span>}
        {tested && (
          <div className={`model-test ${tested.ok ? "ok" : "bad"}`} role="status">
            {tested.text}
          </div>
        )}
        {view.catalogError && <div className="sys-note">查不到模型目录：{view.catalogError}（现在只能选配置里登记过的和已经选了的）</div>}
      </Section>

      <Section title="各个 agent">
        <span className="muted">
          <NamedText text={MODEL_AGENTS_NOTE} />
        </span>
        {MODEL_AGENTS.map((agent) => (
          <AgentRow key={agent} agent={agent} view={view} saving={saving} onSave={save} />
        ))}
      </Section>

      <Section title="看图能力">
        <span className="muted">能看图的模型收到聊天里的图片；看不了的只收到一行带附件引用的占位。这里改的为准，其次是配置文件写明的，都没写按模型目录。</span>
        {view.models.map((option) => (
          <VisionRow
            key={option.modelId}
            option={option}
            choice={visionChoiceOf(settings, modelKeyOf(settings.provider, option.modelId))}
            disabled={saving}
            onChange={(choice) => save(withVision(settings, modelKeyOf(settings.provider, option.modelId), choice))}
          />
        ))}
      </Section>
    </div>
  );
}

/** 模型的下拉：follow 给了时第一项是"跟随默认"（值是空串） */
function ModelSelect({
  label,
  models,
  value,
  follow,
  disabled,
  onChange,
}: {
  label: string;
  models: readonly ModelOptionView[];
  value: string;
  follow?: string;
  disabled: boolean;
  onChange(modelId: string): void;
}) {
  return (
    <select className="input" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {follow !== undefined && <option value="">{follow}</option>}
      {models.map((m) => (
        <option key={m.modelId} value={m.modelId} disabled={!m.inCatalog && m.modelId !== value}>
          {modelOptionLabel(m)}
        </option>
      ))}
    </select>
  );
}

/** 一个 agent：叫法、什么时候算新会话、下一个新会话用的；模型和思考档位各一个下拉（第一项是跟随默认） */
function AgentRow({ agent, view, saving, onSave }: { agent: ModelAgent; view: ModelSettingsView; saving: boolean; onSave(body: ModelSettingsBody): void }) {
  const named = useNamedPlain();
  const { settings } = view;
  const override = settings.agents[agent];
  const effective = view.effective[agent];
  const option = view.models.find((m) => m.modelId === effective.modelId);
  const note = thinkingNote(option, effective.thinkingLevel);
  const label = named(MODEL_AGENT_LABEL[agent]);
  return (
    <div className="model-agent-row">
      <div className="model-agent-head">
        <b>
          <NamedText text={MODEL_AGENT_LABEL[agent]} />
        </b>
        <small className="muted">{MODEL_AGENT_NOTE[agent]}</small>
        <small>{agentSummary(view, agent)}</small>
        {agent === "secretary" && view.secretarySession && <small className="muted">{sessionModelText(view.secretarySession)}</small>}
        {note && <small className="muted">{note}</small>}
      </div>
      <div className="model-agent-selects">
        <ModelSelect
          label={`${label}的模型`}
          models={view.models}
          value={override?.modelId ?? ""}
          follow="跟随默认"
          disabled={saving}
          onChange={(modelId) => onSave(withAgent(settings, agent, { modelId: modelId === "" ? null : modelId }))}
        />
        <select
          className="input"
          aria-label={`${label}的思考档位`}
          value={override?.thinkingLevel ?? ""}
          disabled={saving}
          onChange={(e) => onSave(withAgent(settings, agent, { thinkingLevel: e.target.value === "" ? null : (e.target.value as ModelThinkingLevel) }))}
        >
          <option value="">跟随默认</option>
          {MODEL_THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>
              思考{MODEL_THINKING_LABEL[l]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** 一个模型的看图能力：现在能不能、按什么定的；下拉改（跟随 / 能看图 / 看不了） */
function VisionRow({ option, choice, disabled, onChange }: { option: ModelOptionView; choice: ModelVisionChoice; disabled: boolean; onChange(choice: ModelVisionChoice): void }) {
  return (
    <div className="skill-row model-vision-row">
      <div>
        <b>{option.name ?? option.modelId}</b>
        <span className="muted">
          {option.modelId} · {visionText(option)}
        </span>
      </div>
      <select className="input" aria-label={`${option.modelId}的看图能力`} value={choice} disabled={disabled} onChange={(e) => onChange(e.target.value as ModelVisionChoice)}>
        <option value="follow">{visionFollowLabel(option)}</option>
        <option value="on">能看图</option>
        <option value="off">看不了</option>
      </select>
    </div>
  );
}
