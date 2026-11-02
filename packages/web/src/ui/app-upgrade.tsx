// 手机 App 太旧的提示：页面开在 App 里、App 低于最低版本时，内容区最上面一条"二狗 App 需要升级到 x.y"，点了去下载（安卓）或看教程（鸿蒙）。
// 直接看本机版本和最低版本（页面是服务端给的，里面的最低版本就是服务端的要求），所以系统通知发不出去也看得到；升级后版本够了，这一条自然没有。
// 够新、不在 App 里（手机浏览器、电脑）时什么都不画。系统通知和待办由守护进程判断后发（ADR-0047）。
import { activeLocale, appUpgradeLink, appVersionOutdated, MIN_APP_VERSION, type ReportAppVersionParams, t } from "../state/index.ts";

export function AppUpgradeBar({ report }: { report: ReportAppVersionParams | undefined }) {
  if (!report || !appVersionOutdated(report.version)) return null;
  const link = appUpgradeLink(report.platform, activeLocale().meta.id);
  return (
    <div className="update-bar app-upgrade-bar" role="status">
      <span className="update-bar-text">{t("ui.appUpgrade.text", { version: MIN_APP_VERSION })}</span>
      <span className="update-bar-acts">
        <a className="btn primary small" href={link.url} target="_blank" rel="noopener noreferrer">
          {link.kind === "download" ? t("ui.appUpgrade.download") : t("ui.appUpgrade.guide")}
        </a>
      </span>
    </div>
  );
}
