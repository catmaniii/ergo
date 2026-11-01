// 设置 · 浏览与填框：
// - 搜索引擎："浏览"页签（鸿蒙 App 里的原生内置浏览器）地址栏里打关键词时用哪个（只记在这台设备上，默认必应），选中的下面写着它的搜索地址；
// - 授权的文件夹（单独一页 #/more/authorized-folders，这里留一行去那里的链接）：见 AuthorizedFolders.tsx。
// - agent 联网搜索、读网页（是三种方式的队列）：秘书、负责人、子 agent 联网搜索、读网页按什么顺序用哪几种，
//   见 WebToolsSetting.tsx。存在守护进程那边，所有设备共用；和上面"浏览"地址栏的搜索引擎是两回事。
import { pageBrowseSettings, useSearchEngine } from "../../app/page-browse-settings.ts";
import { SEARCH_ENGINE_IDS, SEARCH_ENGINES, type SearchEngineId, t } from "../../state/index.ts";
import { Section, Segmented } from "../../ui/common.tsx";
import { T } from "../../ui/i18n.tsx";
import { WebToolsSetting } from "./WebToolsSetting.tsx";

export function BrowsingPage({ onOpenAuthorizedFolders }: { onOpenAuthorizedFolders(): void }) {
  const engine = useSearchEngine();
  // 搜索引擎的名字按当前语言现取（不在模块顶层取）
  const engineOptions = SEARCH_ENGINE_IDS.map((id) => ({ value: id, label: SEARCH_ENGINES[id].label }));
  return (
    <>
      <Section title={t("pages.browsing.searchEngine")}>
        <span className="muted">{t("pages.browsing.searchEngineHint")}</span>
        <div className="appearance-choice">
          <Segmented<SearchEngineId> role="radio" label={t("pages.browsing.searchEngine")} value={engine} options={engineOptions} onChange={(id) => pageBrowseSettings().setSearchEngine(id)} />
        </div>
        <span className="muted engine-url">
          <T k="pages.browsing.searchUrl" params={{ engine: SEARCH_ENGINES[engine].label, url: <code>{SEARCH_ENGINES[engine].search}</code>, keyword: <i>{t("pages.browsing.keyword")}</i> }} />
        </span>
      </Section>
      <WebToolsSetting />
      <button type="button" className="menu-item settings-link-row" data-page="authorized-folders" onClick={onOpenAuthorizedFolders}>
        <span className="menu-text">
          {t("pages.browsing.authorizedFoldersLink")}
          <small>{t("pages.browsing.authorizedFoldersHint")}</small>
        </span>
        <span className="muted">›</span>
      </button>
    </>
  );
}
