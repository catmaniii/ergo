// 模型的 key 在网页上填（319 号票，用户 2026-10-28 定"A：网页里能填 key"）：设置 · 模型和首次设置向导的那一步共用这一块，
// 不抄两份。
// - 上面一行：现在配没配、从哪来（apiKeyText：只说配没配，没有 key 的内容）；
// - 密码框（type=password、autocomplete 关掉）+ "保存 key"：空、太短、太长时按钮点不了，下面一句说为什么；
// - 保存中、成功、失败各说一句：成功用响应里回的状态（effective 是 restart 时写明重启二狗后生效、怎么重启），
//   页面上不回显 key，也不把 key 放进任何提示；
// - 存好之后叫 onSaved（设置 · 模型据此把上面那份状态换成新的）。
// 拆成两块：ModelKeyForm 是纯渲染（测试在 Node 里直接渲染它查）；ModelKeySetting 接上 store、http 和本地状态。
// 请求体、草稿校验和"存好之后怎么说"在状态层（state/model-key.ts）；网络交给 http.saveModelKey（POST /api/model-settings/key）。
import { type FormEvent, useState } from "react";
import { useStore } from "../app/store.tsx";
import {
  apiKeyText,
  type ModelApiKeyStatus,
  type ModelKeyWriteResult,
  modelKeyBody,
  modelKeyDraftNote,
  modelKeyDraftProblem,
  modelKeySavedText,
  t,
} from "../state/index.ts";

/** 点"保存 key"：交给 http.saveModelKey（请求体是去掉 BOM、换行和首尾空白的那个 key）；回守护进程的结果 */
export function submitModelKey(http: { saveModelKey(key: string): Promise<ModelKeyWriteResult> }, raw: string): Promise<ModelKeyWriteResult> {
  return http.saveModelKey(modelKeyBody(raw).key);
}

/** 存好之后的一句（纯渲染：重启那一档的提示在测试里直接渲染它查） */
export function ModelKeySaved({ result }: { result: ModelKeyWriteResult }) {
  const saved = modelKeySavedText(result);
  return (
    <div className={`model-key-saved ${saved.effective}`} role="status">
      <b>{saved.text}</b>
      {saved.how !== undefined && <span className="muted model-key-restart">{saved.how}</span>}
    </div>
  );
}

/**
 * 这一块的纯渲染（自己不管状态、不碰网络）：现在配没配、密码框、保存按钮、草稿的提示、失败原因、存好之后那句。
 * provider 是给人看的服务商名字（还不知道时不给，标题用一句通用的）
 */
export function ModelKeyForm({
  provider,
  apiKey,
  draft,
  saving,
  blocked,
  note,
  failed,
  result,
  onDraft,
  onSave,
}: {
  provider?: string;
  apiKey?: ModelApiKeyStatus;
  draft: string;
  saving: boolean;
  /** 草稿存不了（空、太短、太长）：按钮点不了，下面那句话说明为什么 */
  blocked?: boolean;
  note?: string;
  failed?: string;
  result?: ModelKeyWriteResult;
  onDraft(text: string): void;
  onSave(): void;
}) {
  const status = apiKey === undefined ? undefined : apiKeyText(apiKey);
  const title = provider === undefined ? t("ui.modelKey.titleGeneric") : t("ui.modelKey.title", { provider });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave();
  };
  return (
    <div className="model-key-setting">
      <div className="skill-row model-key-row">
        <div>
          <b>{title}</b>
          {status !== undefined && <span className="muted">{status.detail}</span>}
        </div>
        <span className={`chip ${status === undefined ? "" : status.ok ? "chip-ok" : "chip-no"}`}>{status?.label ?? t("ui.modelKey.statusUnknown")}</span>
      </div>
      <form className="model-key-form" onSubmit={submit}>
        <input
          className="input"
          type="password"
          name="model-api-key"
          autoComplete="off"
          spellCheck={false}
          aria-label={t("ui.modelKey.inputLabel", { provider: provider ?? t("ui.modelKey.titleGeneric") })}
          placeholder={t("ui.modelKey.placeholder")}
          value={draft}
          disabled={saving}
          onChange={(event) => onDraft(event.target.value)}
        />
        <button type="submit" className="btn" disabled={saving || blocked === true}>
          {saving ? t("ui.modelKey.saving") : t("ui.modelKey.save")}
        </button>
      </form>
      {note !== undefined && <div className="muted model-key-note">{note}</div>}
      {failed !== undefined && (
        <div className="model-key-error" role="alert">
          {t("ui.modelKey.failed", { reason: failed })}
        </div>
      )}
      {result !== undefined && <ModelKeySaved result={result} />}
    </div>
  );
}

/**
 * 接上 http 的那一块：草稿、保存中、失败原因、存好的结果都在这里；空、太短、太长的不发请求。
 * 保存成功后把新的 key 状态交给 onSaved
 */
export function ModelKeySetting({ provider, apiKey, onSaved }: { provider?: string; apiKey?: ModelApiKeyStatus; onSaved?(apiKey: ModelApiKeyStatus): void }) {
  const { http } = useStore();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [result, setResult] = useState<ModelKeyWriteResult>();
  const problem = modelKeyDraftProblem(draft);

  const save = () => {
    if (saving || problem !== undefined) return;
    setSaving(true);
    setFailed(undefined);
    submitModelKey(http, draft)
      .then((next) => {
        setResult(next);
        setDraft("");
        onSaved?.(next.apiKey);
      }, (err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <ModelKeyForm
      provider={provider}
      apiKey={result?.apiKey ?? apiKey}
      draft={draft}
      saving={saving}
      blocked={problem !== undefined}
      note={modelKeyDraftNote(draft)}
      failed={failed}
      result={result}
      onDraft={setDraft}
      onSave={save}
    />
  );
}
