// 设置 · 模型（73 号票，用户 2026-10-10 定）：设置里的一项，点进去是这一页。
// - 服务商：DeepSeek（在服务端调用），目前唯一、选不了别的，写一句"以后会支持更多服务商"；
// - API key：显示已配置 / 没配置和来源（LSM 从数据目录的密钥区注入），不显示 key；319 号票起能在这里填一个换掉
//   （密码框 + "保存 key"，和首次设置向导那一步共用 ui/model-key.tsx 的那一块），保存后不用重启；
// - 默认模型和思考档位（关、低、中、高），旁边是连通测试（发一条极短的请求，显示通不通、首 token 延迟）；
// - 各个 agent：秘书、任务维护者、项目维护者、子 agent、评审、范围审视各自用什么模型，"跟随默认"或者选定模型和思考档位；
// - 设置文件读不出来（读不了、不合规）时最上面提示"设置文件读不出来，正在用默认；保存会覆盖它"和原因；
// - 看图能力：每个模型能不能看图、按什么定的（这里改的、配置文件写明、模型目录），这里能改；
// - 生效时机写在最上面：一个会话固定一个模型，改了以后下一个新会话生效；长会话（秘书、项目维护者的对话、定时触发的任务）
//   下一轮新开会话、附交接摘要，任务执行中途不换（83 号票）。每个 agent 一行下面另有一句它的会话什么时候换。
// - 120 号票：项目、任务的维护者能在自己的 ⚙ 里单独配模型，盖过它那一行；项目维护者、任务维护者那一行下面一句列出哪几个单独配了，
//   点名字跳到它的页面、它的 ⚙ 自己打开。
// 设置存在守护进程（各设备一样）：打开页面时取一次（GET /api/model-settings），每改一处就把整份存回去，守护进程查过合规才存
// （不合规时说原因、页面照旧）。说法和"改一处、存整份"在状态层（state/model-settings.ts）。
import { useEffect, useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import {
  modelProviderNote,
  MODEL_AGENT_LABEL,
  MODEL_AGENT_NOTE,
  MODEL_AGENTS,
  modelAgentsNote,
  modelSettingsEffectNote,
  modelSettingsFileBrokenNote,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  modelKeyOf,
  modelOptionLabel,
  modelTestText,
  agentSummary,
  maintainerOverrideLine,
  type MaintainerModelView,
  sessionModelText,
  t,
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
import { openAgentSettingsOnArrival } from "../../ui/agent-settings.tsx";
import { NamedText, useNamedPlain } from "../../ui/assistant-name.tsx";
import { Section, Segmented } from "../../ui/common.tsx";
import { ModelKeySetting } from "../../ui/model-key.tsx";
import { useToast } from "../../ui/toast.tsx";

export function ModelsPage({ navigate }: { navigate: Navigate }) {
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

  if (!view) return <div className="muted">{error ? t("pages.models.loadFailed", { reason: error }) : t("pages.models.loading")}</div>;

  const save = (body: ModelSettingsBody) => {
    setSaving(true);
    http
      .saveModelSettings(body)
      .then(
        (v) => {
          setView(v);
          toast(t("pages.models.saved"));
        },
        (err: unknown) => toast(t("pages.models.saveFailed", { reason: err instanceof Error ? err.message : String(err) })),
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
  const provider = view.providers.find((p) => p.id === settings.provider);
  const optionOf = (modelId: string) => view.models.find((m) => m.modelId === modelId);
  const defaultNote = thinkingNote(optionOf(settings.default.modelId), settings.default.thinkingLevel);
  const tested = test && modelTestText(test);
  // 思考档位的名字按当前语言现取（不在模块顶层取）
  const thinkingOptions = MODEL_THINKING_LEVELS.map((l) => ({ value: l, label: MODEL_THINKING_LABEL[l] }));

  return (
    <div className="models-page">
      <div className="model-effect">
        <NamedText text={modelSettingsEffectNote()} />
      </div>
      {view.settingsFileError && (
        <div className="model-file-broken" role="alert">
          <b>{modelSettingsFileBrokenNote()}</b>
          <span className="muted">{view.settingsFileError}</span>
        </div>
      )}
      <Section title={t("pages.models.provider")}>
        <div className="voice-engines" role="radiogroup" aria-label={t("pages.models.providerLabel")}>
          {view.providers.map((p) => (
            <label key={p.id} className="check-row radio-row">
              <input type="radio" name="model-provider" value={p.id} checked={p.id === settings.provider} readOnly />
              <span>
                <b>{p.label}</b>
                <span className="muted">{t("pages.models.serverSide")}</span>
              </span>
            </label>
          ))}
        </div>
        <span className="muted">{modelProviderNote()}</span>
      </Section>

      <Section title="API key">
        <ModelKeySetting provider={provider?.label ?? settings.provider} apiKey={view.apiKey} onSaved={(apiKey) => setView((now) => (now === undefined ? now : { ...now, apiKey }))} />
      </Section>

      <Section
        title={t("pages.models.default")}
        extra={
          <button type="button" className="btn ghost small" disabled={testing} onClick={runTest}>
            {testing ? t("pages.models.testing") : t("pages.models.test")}
          </button>
        }
      >
        <div className="model-choice">
          <ModelSelect label={t("pages.models.default")} models={view.models} value={settings.default.modelId} disabled={saving} onChange={(modelId) => modelId && save(withDefault(settings, { modelId }))} />
          <Segmented<ModelThinkingLevel>
            role="radio"
            label={t("pages.models.defaultThinking")}
            value={settings.default.thinkingLevel}
            options={thinkingOptions}
            onChange={(thinkingLevel) => !saving && save(withDefault(settings, { thinkingLevel }))}
          />
        </div>
        {defaultNote && <span className="muted">{defaultNote}</span>}
        {tested && (
          <div className={`model-test ${tested.ok ? "ok" : "bad"}`} role="status">
            {tested.text}
          </div>
        )}
        {view.catalogError && <div className="sys-note">{t("pages.models.catalogFailed", { reason: view.catalogError })}</div>}
      </Section>

      <Section title={t("pages.models.agents")}>
        <span className="muted">
          <NamedText text={modelAgentsNote()} />
        </span>
        {MODEL_AGENTS.map((agent) => (
          <AgentRow key={agent} agent={agent} view={view} saving={saving} onSave={save} navigate={navigate} />
        ))}
      </Section>

      <Section title={t("pages.models.vision")}>
        <span className="muted">{t("pages.models.visionHint")}</span>
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

/**
 * 一个 agent：叫法、什么时候算新会话、下一个新会话用的；模型和思考档位各一个下拉（第一项是跟随默认）。
 * 项目维护者、任务维护者那一行下面另有一句：哪几个单独配了模型（120 号票），点名字去它的 ⚙
 */
function AgentRow({ agent, view, saving, onSave, navigate }: { agent: ModelAgent; view: ModelSettingsView; saving: boolean; onSave(body: ModelSettingsBody): void; navigate: Navigate }) {
  const named = useNamedPlain();
  const { settings } = view;
  const override = settings.agents[agent];
  const effective = view.effective[agent];
  const option = view.models.find((m) => m.modelId === effective.modelId);
  const note = thinkingNote(option, effective.thinkingLevel);
  const label = named(MODEL_AGENT_LABEL[agent]);
  const overrides = maintainerOverrideLine(view, agent);
  // 去它的 ⚙：项目去项目（宽屏是整页的项目，窄屏是维护者的会话，都有 ⚙），任务去任务详情
  const openGear = (m: Pick<MaintainerModelView, "agentId" | "owner">) => {
    openAgentSettingsOnArrival(m.agentId);
    navigate(m.owner.kind === "project" ? { tab: "projects", projectId: m.owner.id, chat: true } : { tab: "tasks", taskId: m.owner.id });
  };
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
        {overrides && (
          <small className="model-overrides">
            {overrides.lead}
            {overrides.items.map((item, i) => (
              <span key={item.agentId} className={item.unavailable ? "model-override-bad" : undefined} title={item.unavailable}>
                {i > 0 && t("pages.models.listSeparator")}
                <button type="button" className="link model-override-link" onClick={() => openGear(item)}>
                  {item.name}
                </button>
                {t("pages.models.overrideText", { text: item.text })}
              </span>
            ))}
          </small>
        )}
      </div>
      <div className="model-agent-selects">
        <ModelSelect
          label={t("pages.models.agentModel", { agent: label })}
          models={view.models}
          value={override?.modelId ?? ""}
          follow={t("pages.models.followDefault")}
          disabled={saving}
          onChange={(modelId) => onSave(withAgent(settings, agent, { modelId: modelId === "" ? null : modelId }))}
        />
        <select
          className="input"
          aria-label={t("pages.models.agentThinking", { agent: label })}
          value={override?.thinkingLevel ?? ""}
          disabled={saving}
          onChange={(e) => onSave(withAgent(settings, agent, { thinkingLevel: e.target.value === "" ? null : (e.target.value as ModelThinkingLevel) }))}
        >
          <option value="">{t("pages.models.followDefault")}</option>
          {MODEL_THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>
              {t("pages.models.thinkingOption", { level: MODEL_THINKING_LABEL[l] })}
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
      <select className="input" aria-label={t("pages.models.visionOf", { model: option.modelId })} value={choice} disabled={disabled} onChange={(e) => onChange(e.target.value as ModelVisionChoice)}>
        <option value="follow">{visionFollowLabel(option)}</option>
        <option value="on">{t("pages.models.visionOn")}</option>
        <option value="off">{t("pages.models.visionOff")}</option>
      </select>
    </div>
  );
}
