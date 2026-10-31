// 模型的 key 在网页上填（319 号票，用户 2026-10-28 定"A：网页里能填 key"）：设置 · 模型和首次设置向导的那一步共用这一块，
// 不抄两份。
// - 2026-10-30 起设置 · 模型按**服务商逐条列出**（用户反馈"选了自定义却只看到 DeepSeek 的 key，找不到别的模型的 key 在哪填"）：
//   每个服务商一行——名字、配没配、从哪来（apiKeyText：没有 key 的内容）、一个密码框和一个"保存 key"；
//   换 key 不用先把它选成当前服务商，给"另一个服务商"填 key 就在它那一行填。首次向导只列当前那一个；
// - 密码框（type=password、autocomplete 关掉）：空、太短、太长时按钮点不了，下面一句说为什么；
// - 保存中、成功、失败各说一句：成功用响应里回的状态（effective 是 restart 时写明重启二狗后生效、怎么重启），
//   页面上不回显 key，也不把 key 放进任何提示；
// - 存好之后叫 onSaved（设置 · 模型据此把这一份 key 状态换成新的）。
// 拆成两块：ModelKeyForm 是纯渲染（测试在 Node 里直接渲染它查）；ModelKeySetting 接上 store、http 和本地状态。
// 请求体、草稿校验和"存好之后怎么说"在状态层（state/model-key.ts）；网络交给 http.saveModelKey（POST /api/model-settings/key，
// 请求体带 provider 就写那个服务商的密钥文件）。
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
  type ModelProviderView,
  t,
} from "../state/index.ts";

/** 点"保存 key"：交给 http.saveModelKey（请求体是去掉 BOM、换行和首尾空白的那个 key，provider 是这一行的服务商）；回守护进程的结果 */
export function submitModelKey(http: { saveModelKey(key: string, provider?: string): Promise<ModelKeyWriteResult> }, raw: string, provider?: string): Promise<ModelKeyWriteResult> {
  const body = modelKeyBody(raw, provider);
  return http.saveModelKey(body.key, body.provider);
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

/** 一个服务商那一行：它是谁、它的 key 现在配没配、这一行输入框里的草稿、这一行的保存状态 */
export interface ModelKeyRow {
  provider: ModelProviderView;
  /** 还没取到时不给（这时小签写"不知道配没配"，照样能填） */
  apiKey?: ModelApiKeyStatus;
  draft: string;
  /** 这一行正在存 */
  saving: boolean;
  /** 这一行没存成的原因 */
  failed?: string;
  /** 这一行存好的结果 */
  result?: ModelKeyWriteResult;
}

/**
 * 这一块的纯渲染（自己不管状态、不碰网络）：按 rows 的顺序一个服务商一行——名字和配没配、密码框、保存按钮、
 * 草稿的提示、失败原因、存好之后那句
 */
export function ModelKeyForm({
  rows,
  onDraft,
  onSave,
}: {
  rows: readonly ModelKeyRow[];
  onDraft(providerId: string, text: string): void;
  onSave(providerId: string): void;
}) {
  return (
    <>
      {rows.map((row) => (
        <OneKeyRow key={row.provider.id} row={row} onDraft={onDraft} onSave={onSave} />
      ))}
    </>
  );
}

/** rows 里的一行 */
function OneKeyRow({ row, onDraft, onSave }: { row: ModelKeyRow; onDraft(providerId: string, text: string): void; onSave(providerId: string): void }) {
  const { provider, draft, saving } = row;
  // 存好之后显示响应里回的那份状态（不另存一次）
  const status = row.apiKey === undefined ? undefined : apiKeyText(row.apiKey);
  const problem = modelKeyDraftProblem(draft);
  const note = modelKeyDraftNote(draft);
  const title = t("ui.modelKey.title", { provider: provider.label });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(provider.id);
  };
  return (
    <div className="model-key-setting" data-provider={provider.id}>
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
          data-provider={provider.id}
          autoComplete="off"
          spellCheck={false}
          aria-label={t("ui.modelKey.inputLabel", { provider: provider.label })}
          placeholder={t("ui.modelKey.placeholder")}
          value={draft}
          disabled={saving}
          onChange={(event) => onDraft(provider.id, event.target.value)}
        />
        <button type="submit" className="btn" disabled={saving || problem !== undefined}>
          {saving ? t("ui.modelKey.saving") : t("ui.modelKey.save")}
        </button>
      </form>
      {note !== undefined && <div className="muted model-key-note">{note}</div>}
      {row.failed !== undefined && (
        <div className="model-key-error" role="alert">
          {t("ui.modelKey.failed", { reason: row.failed })}
        </div>
      )}
      {row.result !== undefined && <ModelKeySaved result={row.result} />}
    </div>
  );
}

/**
 * 接上 http 的那一块：每个服务商的草稿、正在存哪一行、失败原因、存好的结果都在这里；空、太短、太长的不发请求。
 * 保存成功后把新的 key 状态和是哪个服务商交给 onSaved
 */
export function ModelKeySetting({
  providers,
  apiKeys,
  onSaved,
}: {
  providers: readonly ModelProviderView[];
  /** 每个服务商的 key 状态（键是服务商 id）；还没取到时不给 */
  apiKeys?: Record<string, ModelApiKeyStatus>;
  onSaved?(providerId: string, apiKey: ModelApiKeyStatus): void;
}) {
  const { http } = useStore();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string>();
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, ModelKeyWriteResult>>({});

  const save = (providerId: string) => {
    const raw = drafts[providerId] ?? "";
    if (saving !== undefined || modelKeyDraftProblem(raw) !== undefined) return;
    setSaving(providerId);
    setFailed((now) => {
      if (now[providerId] === undefined) return now;
      const next = { ...now };
      delete next[providerId];
      return next;
    });
    submitModelKey(http, raw, providerId)
      .then((next) => {
        setResults((now) => ({ ...now, [providerId]: next }));
        setDrafts((now) => ({ ...now, [providerId]: "" }));
        onSaved?.(providerId, next.apiKey);
      }, (err: unknown) => setFailed((now) => ({ ...now, [providerId]: err instanceof Error ? err.message : String(err) })))
      .finally(() => setSaving(undefined));
  };

  return (
    <ModelKeyForm
      rows={providers.map((provider) => ({
        provider,
        draft: drafts[provider.id] ?? "",
        saving: saving === provider.id,
        ...(apiKeys?.[provider.id] === undefined ? {} : { apiKey: apiKeys[provider.id] }),
        ...(failed[provider.id] === undefined ? {} : { failed: failed[provider.id] }),
        ...(results[provider.id] === undefined ? {} : { result: results[provider.id] }),
      }))}
      onDraft={(providerId, text) => setDrafts((now) => ({ ...now, [providerId]: text }))}
      onSave={save}
    />
  );
}
