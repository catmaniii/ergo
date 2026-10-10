// 设置 · 系统提示（71 号票，照 drama_maker 的 prompts/*.md）：各 agent 的系统提示按前缀、各角色、共用片段列出，标明用的是默认的
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
      (err: unknown) => live && setFailed(`没取到：${errorText(err)}`),
    );
    return () => {
      live = false;
    };
  }, [http]);

  return (
    <>
      <div className="muted prompt-intro">
        各 agent 的系统提示，照 drama_maker 放在 md 文件里。改过的存在数据目录{list?.userDir ? `（${list.userDir}）` : ""}，有就用改过的、没有用默认的；agent 下一次拉起时生效，不用重启。动态的部分写成占位符，比如
        {" {{名字}}"}，由程序填。
      </div>
      {failed && <div className="hint">{failed}</div>}
      {!list && !failed && <div className="muted">正在取……</div>}
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
      (err: unknown) => setFailed(`没取到：${errorText(err)}`),
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
        (d) => done(d, d.state === "default" ? "和默认的一样，已恢复默认" : "已保存，下一次拉起时生效"),
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
          done(d, "已恢复默认");
        },
        (err: unknown) => setRejected(errorText(err)),
      )
      .finally(() => setBusy(false));
  };

  if (!detail) return failed ? <div className="hint">{failed}</div> : <div className="muted">正在取……</div>;
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
          <div>数据目录里改过的这一份有错，现在用的是默认的：</div>
          <pre>{detail.problem}</pre>
          {detail.brokenContent !== undefined && (
            <button type="button" className="btn ghost small" onClick={() => setDraft(detail.brokenContent)}>
              载入出错的那份来改
            </button>
          )}
        </div>
      )}
      <textarea
        className="input prompt-editor"
        value={value}
        spellCheck={false}
        aria-label="系统提示的内容"
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
      {!problem && dirty && check?.isDefault && <div className="muted">和默认的一样：保存就是恢复默认。</div>}
      <div className="prompt-actions">
        <button type="button" className="btn primary" disabled={busy || !dirty || !check?.ok} onClick={save}>
          {busy ? "保存中…" : "保存"}
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
          撤销修改
        </button>
        <button type="button" className="btn ghost" disabled={busy || (detail.state === "default" && !dirty)} onClick={() => setConfirmReset(true)}>
          恢复默认
        </button>
      </div>
      {detail.userFile && <div className="muted prompt-file">改过的存在 {detail.userFile}</div>}
      <PlaceholderHelp detail={detail} />
      {confirmReset && (
        <Sheet title="恢复默认？" onClose={() => !busy && setConfirmReset(false)} center>
          <div className="modal-body">
            <p>{detail.state === "default" ? "没保存的修改会丢掉，编辑框回到默认的内容。" : "改过的这一份会删掉，之后用默认的。删掉的找不回来。"}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirmReset(false)}>
              取消
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
              恢复默认
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
  return (
    <Section title="占位符">
      <div className="muted prompt-syntax">
        {"{{名字}} 填一个值；{{#条件}}……{{/条件}} 条件成立时才有中间这段，{{^条件}}……{{/条件}} 不成立时才有（条件独占一行时整行去掉）；{{> 片段}} 插入一段共用片段。写错了存不进去。"}
      </div>
      {groups.length === 0 && <div className="muted">这一份不能写占位符。</div>}
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
              {g.title}（{g.items.length} 个）
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
