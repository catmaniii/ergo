// 设置 · 语言 / Language（168 号票，用户 2026-10-19 定）：全局一个语言，所有设备、秘书和各个 agent 都跟着它；存在守护进程。
// - 上面一句说明（以前的聊天、卡片保持原来的语言，切换后新产生的才是新语言）；
// - 语言列表：本地名，小字写自带的还是来自 ~/.ergo/locales、改了几句、缺几句（缺的用中文补），正在用的打勾；点一种就换
//   （守护进程推 language 和临时事件 locale，开着的页面——包括这一页——不刷新就换过来，app/locale.ts）；
// - 选的语言不在了（~/.ergo/locales 里删了）：写明先用中文；
// - ~/.ergo/locales 里读不进来的文件：逐条写明哪个文件、哪里错；
// - 最下面写怎么加一种语言、怎么改某句译法。
// 每次打开、词典版本变了（换了语言、语言文件变了）现取一次列表。这一页的标题（MorePage）永远中英两种写着。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { languageGoneText, languageRows, type LocaleListView, localeProblemText, t } from "../../state/index.ts";
import { AssistantName } from "../../ui/assistant-name.tsx";
import { Section } from "../../ui/common.tsx";
import { T } from "../../ui/i18n.tsx";

export function LanguagePage() {
  const { http, ui } = useStore();
  const revision = ui.locale?.revision;
  /** 取到的列表，连同取的时候词典是哪一版 */
  const [loaded, setLoaded] = useState<{ revision: string | undefined; view: LocaleListView }>();
  const [loadFailed, setLoadFailed] = useState<string>();
  /** 正在换成哪种 */
  const [switching, setSwitching] = useState<string>();
  const [switchFailed, setSwitchFailed] = useState<string>();

  useEffect(() => {
    // 词典的版本（revision）变了——换了语言、~/.ergo/locales 里的文件变了——就重取一次
    let cancelled = false;
    http.locales().then(
      (next) => {
        if (cancelled) return;
        setLoaded({ revision, view: next });
        setLoadFailed(undefined);
      },
      (err: unknown) => {
        if (!cancelled) setLoadFailed(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [http, revision]);

  const view = loaded?.view;
  const choose = (language: string) => {
    if (switching !== undefined || language === view?.language) return;
    setSwitching(language);
    setSwitchFailed(undefined);
    http
      .setLanguage(language)
      .then(
        (result) => setLoaded((old) => (old ? { ...old, view: { ...old.view, language: result.language } } : old)),
        (err: unknown) => setSwitchFailed(t("shell.language.failed", { reason: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setSwitching(undefined));
  };

  const rows = view ? languageRows(view) : [];
  const gone = view ? languageGoneText(view) : undefined;
  const dir = view?.userDir ?? "~/.ergo/locales";
  return (
    <div className="language-page">
      <Section title={t("shell.language.list")}>
        <span className="muted">
          <T k="shell.language.intro" params={{ name: <AssistantName /> }} />
        </span>
        {!view && !loadFailed && <div className="muted">{t("shell.language.loading")}</div>}
        {loadFailed && (
          <div className="field-error" role="alert">
            {t("shell.language.loadFailed", { reason: loadFailed })}
          </div>
        )}
        {gone && (
          <div className="field-error" role="alert">
            {gone}
          </div>
        )}
        {view && (
          <div className="menu language-list" role="radiogroup" aria-label={t("shell.language.list")}>
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                role="radio"
                aria-checked={row.current}
                className={`menu-item${row.current ? " on" : ""}`}
                disabled={switching !== undefined}
                onClick={() => choose(row.id)}
              >
                <span className="menu-text">
                  <span lang={row.id}>{row.nativeName}</span>
                  <small>{row.notes.join(" · ")}</small>
                </span>
                {row.current ? <span className="language-current">✓ {t("shell.language.current")}</span> : switching === row.id ? <span className="muted">{t("shell.language.switching")}</span> : null}
              </button>
            ))}
          </div>
        )}
        {switchFailed && (
          <div className="field-error" role="alert">
            {switchFailed}
          </div>
        )}
      </Section>
      {view && view.problems.length > 0 && (
        <Section title={t("shell.language.problems")}>
          <ul className="language-problems">
            {view.problems.map((p) => (
              <li key={`${p.file}:${p.code}:${p.key ?? ""}`}>
                <T k="shell.language.problemLine" params={{ file: <code>{p.file}</code>, text: localeProblemText(p) }} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={t("shell.language.howTo.title")}>
        <div className="language-howto muted">
          <p>{t("shell.language.howTo.add", { dir })}</p>
          <p>{t("shell.language.howTo.override", { dir })}</p>
          <p>{t("shell.language.howTo.reload")}</p>
        </div>
      </Section>
    </div>
  );
}
