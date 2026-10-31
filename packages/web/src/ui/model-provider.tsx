// 模型服务商（设置 · 模型和首次设置向导的"模型 Key"那一步共用这一块，不抄两份）：
// - 两个单选：DeepSeek、自定义（OpenAI 兼容）服务商——名字按守护进程给的登记表（ModelSettingsView.providers）写，不写死；
// - 选了自定义时多出这几项：接口地址（要填到 /v1 这一层，比如 https://api.openai.com/v1）、模型 id（能手填，也能点"拉取列表"
//   让守护进程照接口地址列一遍再挑；列不成时把原因原样写出来，照样能手填）、接口类型（openai-completions / openai-responses）；
// - 一句诚实的提示：换成自定义服务商只换"跑对话的模型"，记忆整理、联网搜索、读网页仍然要 DeepSeek 的 key；
// - 连通测试（ModelTestBlock，2026-10-30 起从这一块挪到 API key 那一块的底部）：测的是设置里选中的那个服务商；自定义时先把
//   这一块存好（守护进程按设置里选的服务商取 key），再测它里面的模型 id（草稿一起传）；
// - 存的是整份设置（POST /api/model-settings）：改了地址、模型 id、接口类型就存，存好叫 onSaved 换掉外面那份 view；
//   成功、失败各一句（存好一会儿是"下一个新会话起生效"）；切回 DeepSeek 时留着已经填的自定义那一块，以后再选不用重填。
// 判合规、收拾填的内容、列表和测试的说法在状态层（state/model-custom.ts）；这一块只接 store、http 和本地状态。
// 拆成三块：ModelProviderForm 是纯渲染、ModelTestBlock 是连通测试那一段的纯渲染（测试在 Node 里直接渲染它们查）；
// useModelProviderBlock 把状态和 http 接上，"拉取列表"和"连通测试"都要用它。
import { useState } from "react";
import { useStore } from "../app/store.tsx";
import {
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_ID,
  customDraftOf,
  customDraftUntouched,
  customModelOptions,
  customModelsText,
  customOf,
  customSavePlan,
  providerPickNeedsSave,
  type CustomDraft,
  type CustomProviderApi,
  modelProviderNote,
  type ModelCustomModel,
  type ModelCustomModelsResult,
  type ModelCustomProvider,
  type ModelProviderView,
  type ModelSettingsBody,
  type ModelSettingsView,
  type ModelTestBody,
  type ModelTestResult,
  modelTestText,
  t,
  tTable,
} from "../state/index.ts";
import { useToast } from "./toast.tsx";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 两种接口风格的说法（取值时现查，不在模块顶层取句子） */
const API_LABEL = tTable({ "openai-completions": "ui.modelProvider.apiCompletions", "openai-responses": "ui.modelProvider.apiResponses" });

/** 点"拉取列表"：交给 http.customModels——只带接口地址（key 照旧从密钥区那个文件来，请求体里没有 key） */
export function submitCustomModels(http: { customModels(baseUrl?: string): Promise<ModelCustomModelsResult> }, draft: CustomDraft): Promise<ModelCustomModelsResult> {
  return http.customModels(customOf(draft).baseUrl);
}

/** 服务商那一块要的东西（不含连通测试：它在 API key 那一块的底部，见 ModelTestBlock） */
export interface ModelProviderFormProps {
  providers: readonly ModelProviderView[];
  /** 现在选的（可能还没存进设置） */
  provider: string;
  /** 设置里存着的 */
  savedProvider: string;
  custom: CustomDraft;
  /** 拉到的模型（还没拉、或者又想手填时不给） */
  models?: readonly ModelCustomModel[];
  listing: boolean;
  saving: boolean;
  /** 存不了、拉不到的原因（原样写出来） */
  problem?: string;
  /** 拉到了几个 */
  listText?: string;
  onPick(id: string): void;
  onCustom(patch: Partial<CustomDraft>): void;
  /** 输入框离开时存一份 */
  onCommit(): void;
  onModelPick(id: string): void;
  onApi(api: CustomProviderApi): void;
  /** 不挑列表里的，改回手填 */
  onManual(): void;
  onList(): void;
}

/**
 * 这一块的纯渲染（自己不管状态、不碰网络）：两个单选、自定义那几项、拉到的模型（下拉）、原因。
 * provider 是现在选的（可能还没存），savedProvider 是设置里存着的（两个不一样就是"自定义还没存进去"）
 */
export function ModelProviderForm({
  providers,
  provider,
  savedProvider,
  custom,
  models,
  listing,
  saving,
  problem,
  listText,
  onPick,
  onCustom,
  onCommit,
  onModelPick,
  onApi,
  onManual,
  onList,
}: ModelProviderFormProps) {
  const busy = saving || listing;
  const isCustom = provider === CUSTOM_PROVIDER_ID;
  const picker = models !== undefined && models.length > 0;
  return (
    <>
      <div className="voice-engines" role="radiogroup" aria-label={t("ui.modelProvider.providerLabel")}>
        {providers.map((p) => (
          <label key={p.id} className="check-row radio-row">
            <input type="radio" name="model-provider" value={p.id} checked={p.id === provider} disabled={busy} onChange={() => onPick(p.id)} />
            <span>
              <b>{p.label}</b>
              <span className="muted">{t("ui.modelProvider.serverSide")}</span>
            </span>
          </label>
        ))}
      </div>
      <span className="muted">{modelProviderNote()}</span>
      {isCustom && (
        <div className="model-custom">
          <label className="model-custom-field">
            <span className="model-custom-label">{t("ui.modelProvider.baseUrl")}</span>
            <input
              className="input"
              type="url"
              name="model-custom-base-url"
              autoComplete="off"
              spellCheck={false}
              value={custom.baseUrl}
              placeholder={t("ui.modelProvider.baseUrlPlaceholder")}
              disabled={busy}
              onChange={(event) => onCustom({ baseUrl: event.target.value })}
              onBlur={onCommit}
            />
            <small className="muted">{t("ui.modelProvider.baseUrlHint")}</small>
          </label>
          <div className="model-custom-field">
            <span className="model-custom-label">{t("ui.modelProvider.modelId")}</span>
            <div className="model-custom-row">
              {picker ? (
                <select className="input" aria-label={t("ui.modelProvider.modelId")} value={custom.modelId.trim()} disabled={busy} onChange={(event) => onModelPick(event.target.value)}>
                  {customModelOptions(models, custom.modelId).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  type="text"
                  name="model-custom-model-id"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t("ui.modelProvider.modelId")}
                  value={custom.modelId}
                  placeholder={t("ui.modelProvider.modelIdPlaceholder")}
                  disabled={busy}
                  onChange={(event) => onCustom({ modelId: event.target.value })}
                  onBlur={onCommit}
                />
              )}
              <button type="button" className="btn ghost small" disabled={busy} onClick={onList}>
                {listing ? t("ui.modelProvider.listing") : t("ui.modelProvider.list")}
              </button>
              {picker && (
                <button type="button" className="link" disabled={busy} onClick={onManual}>
                  {t("ui.modelProvider.manual")}
                </button>
              )}
            </div>
            {listText !== undefined && <small className="muted">{listText}</small>}
          </div>
          <label className="model-custom-field">
            <span className="model-custom-label">{t("ui.modelProvider.api")}</span>
            <select className="input" value={custom.api} disabled={busy} onChange={(event) => onApi(event.target.value as CustomProviderApi)}>
              {CUSTOM_PROVIDER_APIS.map((api) => (
                <option key={api} value={api}>
                  {API_LABEL[api]}
                </option>
              ))}
            </select>
            <small className="muted">{t("ui.modelProvider.apiHint")}</small>
          </label>
          <p className="model-custom-note">{t("ui.modelProvider.deepSeekNeeded")}</p>
          {provider !== savedProvider && <p className="muted model-custom-note">{t("ui.modelProvider.notSaved")}</p>}
        </div>
      )}
      {problem !== undefined && (
        <div className="field-error model-custom-problem" role="alert">
          {problem}
        </div>
      )}
    </>
  );
}

/**
 * 连通测试（纯渲染）：一个按钮和它的结果。2026-10-30 起放在 API key 那一块的底部，测的是**设置里选中的**服务商
 * （自定义时连它那一块的草稿一起传，和以前一样）
 */
export function ModelTestBlock({ test, testing, busy, onTest }: { test?: ModelTestResult; testing: boolean; busy: boolean; onTest(): void }) {
  const said = test === undefined ? undefined : modelTestText(test);
  return (
    <div className="model-test-actions">
      <button type="button" className="btn ghost small" disabled={testing || busy} onClick={onTest}>
        {testing ? t("ui.modelProvider.testing") : t("ui.modelProvider.testCurrent")}
      </button>
      {said !== undefined && (
        <div className={`model-test ${said.ok ? "ok" : "bad"}`} role="status">
          {said.text}
        </div>
      )}
    </div>
  );
}

/** 服务商这一块接上 http 之后的样子：表单要的 props，加上连通测试的状态和动作 */
export interface ModelProviderBlock {
  form: ModelProviderFormProps;
  test: ModelTestResult | undefined;
  testing: boolean;
  /** 还存着 / 还拉着的时候连通测试点不了 */
  testBusy: boolean;
  onTest(): void;
}

/**
 * 服务商这一块的状态：现在选哪个服务商、自定义那几项填的是什么、拉到的模型、连通测试的结果都在这里。
 * 选服务商、改地址 / 模型 id / 接口类型都存整份设置（选 DeepSeek 时存得下，选自定义时地址和模型 id 合规才存）；
 * "拉取列表"和"连通测试"先把这一块存成"选自定义"，因为守护进程按设置里选的服务商取 key。
 * 设置 · 模型把它拆开摆（表单在上面，连通测试在 API key 那一块底部）；首次设置向导也照这个顺序摆
 */
export function useModelProviderBlock(view: ModelSettingsView, onSaved: (next: ModelSettingsView) => void): ModelProviderBlock {
  const { http } = useStore();
  const toast = useToast();
  const [picked, setPicked] = useState<string>();
  const [draft, setDraft] = useState<CustomDraft>();
  const [saving, setSaving] = useState(false);
  const [listing, setListing] = useState(false);
  const [models, setModels] = useState<ModelCustomModel[]>();
  const [listText, setListText] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [test, setTest] = useState<ModelTestResult>();
  const [testing, setTesting] = useState(false);

  const savedProvider = view.settings.provider;
  const provider = picked ?? savedProvider;
  const custom = draft ?? customDraftOf(view.settings);

  const save = (body: ModelSettingsBody, quiet = false): Promise<ModelSettingsView | undefined> => {
    setSaving(true);
    return http
      .saveModelSettings(body)
      .then(
        (next) => {
          onSaved(next);
          if (!quiet) toast(t("ui.modelProvider.saved"));
          return next;
        },
        (err: unknown) => {
          toast(t("ui.modelProvider.saveFailed", { reason: messageOf(err) }));
          return undefined;
        },
      )
      .finally(() => setSaving(false));
  };

  /** 存这一块（服务商 + 填的那几项）；不合规时不存，原因写在下面 */
  const commit = (nextProvider: string, nextDraft: CustomDraft, quiet = false): Promise<ModelSettingsView | undefined> => {
    const plan = customSavePlan(view.settings, nextProvider, nextDraft);
    if (!plan.ok) {
      setProblem(plan.error);
      return Promise.resolve(undefined);
    }
    setProblem(undefined);
    return save(plan.body, quiet);
  };

  const pick = (id: string) => {
    setPicked(id);
    setProblem(undefined);
    setTest(undefined);
    // 刚切到自定义、还什么都没填：不用这会儿就报"没填"，等填了再存
    if (!providerPickNeedsSave(id, custom)) return;
    void commit(id, custom);
  };

  const edit = (patch: Partial<CustomDraft>) => setDraft({ ...custom, ...patch });

  const commitDraft = () => {
    if (customDraftUntouched(custom)) return;
    void commit(provider, custom);
  };

  const pickModel = (modelId: string) => {
    edit({ modelId });
    void commit(provider, { ...custom, modelId });
  };

  const pickApi = (api: CustomProviderApi) => {
    edit({ api });
    void commit(provider, { ...custom, api });
  };

  const runList = async (): Promise<void> => {
    if (listing || saving) return;
    const plan = customSavePlan(view.settings, CUSTOM_PROVIDER_ID, custom);
    if (!plan.ok) {
      setProblem(plan.error);
      return;
    }
    setProblem(undefined);
    setModels(undefined);
    setListText(undefined);
    setListing(true);
    try {
      // 列表要用自定义服务商的 key（按设置里选的服务商取），所以先把它存成选中的
      if ((await save(plan.body, true)) === undefined) return;
      setPicked(CUSTOM_PROVIDER_ID);
      const result = await submitCustomModels(http, custom);
      const said = customModelsText(result);
      if (result.ok) {
        setModels(result.models);
        setListText(said.text);
      } else {
        setProblem(said.text);
      }
    } catch (err) {
      setProblem(messageOf(err));
    } finally {
      setListing(false);
    }
  };

  const runTest = async (): Promise<void> => {
    if (testing) return;
    setTesting(true);
    setTest(undefined);
    let target = view.settings.default.modelId;
    let payload: ModelTestBody = {};
    try {
      if (provider === CUSTOM_PROVIDER_ID) {
        const plan = customSavePlan(view.settings, CUSTOM_PROVIDER_ID, custom);
        if (!plan.ok) {
          setProblem(plan.error);
          return;
        }
        setProblem(undefined);
        if ((await save(plan.body, true)) === undefined) return;
        setPicked(CUSTOM_PROVIDER_ID);
        const sent: ModelCustomProvider = customOf(custom);
        target = sent.modelId;
        payload = { custom: sent };
      } else {
        // 刚从自定义切过来、还没存好：先把它存成 DeepSeek，测的才是 DeepSeek 那边（不然守护进程还按自定义取 key）
        if (provider !== view.settings.provider && (await commit(provider, custom, true)) === undefined) return;
        payload = { modelId: target };
      }
      setTest(await http.testModel(payload));
    } catch (err) {
      setTest({ ok: false, modelId: target, totalMs: 0, error: messageOf(err) });
    } finally {
      setTesting(false);
    }
  };

  return {
    form: {
      providers: view.providers,
      provider,
      savedProvider,
      custom,
      ...(models === undefined ? {} : { models }),
      listing,
      saving,
      ...(problem === undefined ? {} : { problem }),
      ...(listText === undefined ? {} : { listText }),
      onPick: pick,
      onCustom: edit,
      onCommit: commitDraft,
      onModelPick: pickModel,
      onApi: pickApi,
      onManual: () => {
        setModels(undefined);
        setListText(undefined);
      },
      onList: () => void runList(),
    },
    test,
    testing,
    testBusy: saving || listing,
    onTest: () => void runTest(),
  };
}
