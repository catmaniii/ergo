// 设置 · 系统提示（71 号票，一份提示一个 md 文件）：各 agent 的系统提示按前缀、各角色、共用片段列出，标明用的是默认的
// 还是改过的；点进某一份（#/more/prompts/<编号>）直接在页面里看、改、保存（存进数据目录配置区的 prompts/），能一键恢复默认。
// 占位符写错时就地提示第几行错在哪、存不进去（检查和守护进程用同一个函数，守护进程那边照样再查）。
// 每次打开现取（文件可能被直接改过），不缓存。说法在状态层（state/system-prompts.ts）。
import { useCallback, useEffect, useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { useStore } from "../../app/store.tsx";
import {
  checkSystemPromptDraft,
  placeholderGroups,
  SYSTEM_PROMPT_STATE_LABEL,
  type SystemPromptDetail,
  type SystemPromptList,
  type SystemPromptState,
  systemPromptSections,
  systemPromptSubtitle,
  t,
} from "../../state/index.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { Section, Sheet } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 用的是默认的、改过的、有错：一个小签 */
function StateChip({ state }: { state: SystemPromptState }) {
  return <span className={`chip prompt-state prompt-state-${state}`}>{SYSTEM_PROMPT_STATE_LABEL[state]}</span>;
}

/** 列表（item 没给）或某一份（item 是编号） */
export function PromptsPage({ item, onOpen }: { item?: string; onOpen(id: string): void }) {
  return item ? <PromptEditor key={item} id={item} /> : <PromptList onOpen={onOpen} />;
}

function PromptList({ onOpen }: { onOpen(id: string): void }) {
  const { http } = useStore();
  const [list, setList] = useState<SystemPromptList>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    let live = true;
    http.systemPrompts().then(
      (l) => live && setList(l),
      (err: unknown) => live && setFailed(t("pages.prompts.loadFailed", { reason: errorText(err) })),
    );
    return () => {
      live = false;
    };
  }, [http]);

  return (
    <>
      <div className="muted prompt-intro">
        {list?.userDir ? t("pages.prompts.introWithDir", { dir: list.userDir, example: `{{${t("pages.prompts.syntaxName")}}}` }) : t("pages.prompts.intro", { example: `{{${t("pages.prompts.syntaxName")}}}` })}
      </div>
      {failed && <div className="hint">{failed}</div>}
      {!list && !failed && <div className="muted">{t("pages.prompts.loading")}</div>}
      {list &&
        systemPromptSections(list).map((section) => (
          <Section key={section.group} title={section.title} extra={<span className="muted prompt-section-note">{section.note}</span>}>
            <div className="prompt-rows">
              {section.prompts.map((p) => (
                <button key={p.id} type="button" className="prompt-row" onClick={() => onOpen(p.id)}>
                  <span className="prompt-row-text">
                    <span className="prompt-row-title">
                      <NamedText text={p.title} />
                      <StateChip state={p.state} />
                    </span>
                    <small>
                      <NamedText text={systemPromptSubtitle(p)} />
                    </small>
                  </span>
                  <span className="muted">›</span>
                </button>
              ))}
            </div>
          </Section>
        ))}
    </>
  );
}

function PromptEditor({ id }: { id: string }) {
  const { http } = useStore();
  const toast = useToast();
  const [detail, setDetail] = useState<SystemPromptDetail>();
  const [failed, setFailed] = useState<string>();
  /** 正在改的内容；没在改时编辑框里是现在用的 */
  const [draft, setDraft] = useState<string>();
  /** 守护进程拒了（或者没连上）的原因 */
  const [rejected, setRejected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(() => {
    http.systemPrompt(id).then(
      (d) => {
        setDetail(d);
        setFailed(undefined);
      },
      (err: unknown) => setFailed(t("pages.prompts.loadFailed", { reason: errorText(err) })),
    );
  }, [http, id]);
  useEffect(load, [load]);

  const value = draft ?? detail?.content ?? "";
  const check = detail && checkSystemPromptDraft(detail, value);
  const dirty = check?.changed === true;
  // 鸿蒙 App 的系统返回键（62 号票）：改了一半没保存时先撤销这次修改，再按才回到列表
  useBackLayer("overlay", dirty && !busy, () => {
    setDraft(undefined);
    setRejected(undefined);
  });

  const done = (d: SystemPromptDetail, text: string) => {
    setDetail(d);
    setDraft(undefined);
    setRejected(undefined);
    toast(text);
  };
  const save = () => {
    if (!check?.ok) return;
    setBusy(true);
    http
      .saveSystemPrompt(id, value)
      .then(
        (d) => done(d, d.state === "default" ? t("pages.prompts.savedAsDefault") : t("pages.prompts.saved")),
        (err: unknown) => setRejected(errorText(err)),
      )
      .finally(() => setBusy(false));
  };
  const reset = () => {
    setBusy(true);
    http
      .resetSystemPrompt(id)
      .then(
        (d) => {
          setConfirmReset(false);
          done(d, t("pages.prompts.restored"));
        },
        (err: unknown) => setRejected(errorText(err)),
      )
      .finally(() => setBusy(false));
  };

  if (!detail) return failed ? <div className="hint">{failed}</div> : <div className="muted">{t("pages.prompts.loading")}</div>;
  const problem = rejected ?? (check && !check.ok ? check.problem : undefined);
  return (
    <>
      <div className="prompt-head">
        <div className="prompt-row-title prompt-head-title">
          <NamedText text={detail.title} />
          <StateChip state={detail.state} />
        </div>
        <div className="muted">
          <NamedText text={systemPromptSubtitle(detail)} />
        </div>
      </div>
      {detail.state === "broken" && (
        <div className="prompt-broken" role="alert">
          <div>{t("pages.prompts.broken")}</div>
          <pre>{detail.problem}</pre>
          {detail.brokenContent !== undefined && (
            <button type="button" className="btn ghost small" onClick={() => setDraft(detail.brokenContent)}>
              {t("pages.prompts.loadBroken")}
            </button>
          )}
        </div>
      )}
      <textarea
        className="input prompt-editor"
        value={value}
        spellCheck={false}
        aria-label={t("pages.prompts.content")}
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
      {!problem && dirty && check?.isDefault && <div className="muted">{t("pages.prompts.sameAsDefault")}</div>}
      <div className="prompt-actions">
        <button type="button" className="btn primary" disabled={busy || !dirty || !check?.ok} onClick={save}>
          {busy ? t("pages.prompts.saving") : t("pages.prompts.save")}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(undefined);
            setRejected(undefined);
          }}
        >
          {t("pages.prompts.discard")}
        </button>
        <button type="button" className="btn ghost" disabled={busy || (detail.state === "default" && !dirty)} onClick={() => setConfirmReset(true)}>
          {t("pages.prompts.restoreDefault")}
        </button>
      </div>
      {detail.userFile && <div className="muted prompt-file">{t("pages.prompts.userFile", { file: detail.userFile })}</div>}
      <PlaceholderHelp detail={detail} />
      {confirmReset && (
        <Sheet title={t("pages.prompts.restoreTitle")} onClose={() => !busy && setConfirmReset(false)} center>
          <div className="modal-body">
            <p>{detail.state === "default" ? t("pages.prompts.restoreDraft") : t("pages.prompts.restoreDelete")}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmReset(false)}>
              {t("pages.prompts.cancel")}
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => {
                if (detail.state !== "default") return reset();
                setDraft(undefined);
                setConfirmReset(false);
              }}
            >
              {t("pages.prompts.restoreDefault")}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** 能用的占位符和写法 */
function PlaceholderHelp({ detail }: { detail: SystemPromptDetail }) {
  const groups = placeholderGroups(detail);
  // 写法说明里示例的占位符名按当前语言（中文下和原来一字不差："{{名字}} 填一个值；{{#条件}}……{{/条件}}……"）
  const name = t("pages.prompts.syntaxName");
  const cond = t("pages.prompts.syntaxCondition");
  const partial = t("pages.prompts.syntaxPartial");
  return (
    <Section title={t("pages.prompts.placeholders")}>
      <div className="muted prompt-syntax">
        {t("pages.prompts.syntax", { fill: `{{${name}}}`, when: `{{#${cond}}}……{{/${cond}}}`, unless: `{{^${cond}}}……{{/${cond}}}`, partial: `{{> ${partial}}}` })}
      </div>
      {groups.length === 0 && <div className="muted">{t("pages.prompts.noPlaceholders")}</div>}
      {groups.map((g) => {
        const rows = (
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
        );
        return g.items.length > 8 ? (
          <details key={g.title} className="prompt-placeholder-group">
            <summary>
              {t("pages.prompts.groupCount", { title: g.title, count: g.items.length })}
            </summary>
            {rows}
          </details>
        ) : (
          <div key={g.title} className="prompt-placeholder-group">
            <div className="prompt-placeholder-title">{g.title}</div>
            {rows}
          </div>
        );
      })}
    </Section>
  );
}
