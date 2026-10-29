// 设置 · 数据源里 Google · 联系人下面的那一块（301 号票，dataSources 插槽）：没有要填的（只靠导入文件夹），写明进候选的是谁、
// 一张核对卡几个人，和怎么从 Google 联系人网页版导出 vCard（导出的文件放进同一页下面的导入文件夹）。纯渲染，不发请求。
import { t } from "../../state/index.ts";

/** 一张候选核对卡最多交几个人（和守护进程 google/contacts.ts 的 CONTACTS_BATCH 一样） */
export const GOOGLE_CONTACTS_BATCH = 10;

export function GoogleContactsPanel() {
  return (
    <div className="gcal-panel gcontacts-panel">
      <div className="hint">
        {t("ui.plugins.google.contacts.what")} {t("ui.plugins.google.contacts.batch", { count: GOOGLE_CONTACTS_BATCH })}
      </div>
      <details className="gcal-howto">
        <summary>{t("ui.plugins.google.contacts.howtoTitle")}</summary>
        <ol>
          <li>{t("ui.plugins.google.contacts.howto1")}</li>
          <li>{t("ui.plugins.google.contacts.howto2")}</li>
          <li>{t("ui.plugins.google.contacts.howto3")}</li>
        </ol>
      </details>
    </div>
  );
}
