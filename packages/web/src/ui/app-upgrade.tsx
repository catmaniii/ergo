// 手机 App 太旧的提示：页面开在 App 里、App 低于最低版本时，内容区最上面一条"二狗 App 需要升级到 x.y"。
// 安卓：二狗带着安装包时按钮是"更新"（新版 App 在 App 里装，旧版 App 从二狗直接下载，ui/app-update.tsx，票 399）；没带时照旧给发布页的 APK 链接。
// 鸿蒙给手机安装教程（没法替用户签名），认不出哪种 App 给"装 App"那一节。
// 直接看本机版本和最低版本（页面是服务端给的，里面的最低版本就是服务端的要求），所以系统通知发不出去也看得到；升级后版本够了，这一条自然没有。
// 够新、不在 App 里（手机浏览器、电脑）时什么都不画。系统通知和待办由守护进程判断后发（ADR-0047）。
import { activeLocale, appUpgradeLink, appVersionOutdated, MIN_APP_VERSION, type ReportAppVersionParams, t } from "../state/index.ts";
import { AppUpdateAction, useAppUpdateView } from "./app-update.tsx";

export function AppUpgradeBar({ report }: { report: ReportAppVersionParams | undefined }) {
  const outdated = report !== undefined && appVersionOutdated(report.version);
  // 只有要提示、又是安卓的时候才问二狗带没带安装包
  const view = useAppUpdateView(outdated && report.platform === "android");
  if (!report || !outdated) return null;
  const pkg = report.platform === "android" ? view?.android : undefined;
  const link = appUpgradeLink(report.platform, activeLocale().meta.id);
  return (
    <div className="update-bar app-upgrade-bar" role="status">
      <span className="update-bar-text">{t("ui.appUpgrade.text", { version: MIN_APP_VERSION })}</span>
      <span className="update-bar-acts">
        {pkg ? (
          <AppUpdateAction pkg={pkg} />
        ) : (
          <a className="btn primary small" href={link.url} target="_blank" rel="noopener noreferrer">
            {link.kind === "download" ? t("ui.appUpgrade.download") : t("ui.appUpgrade.guide")}
          </a>
        )}
      </span>
    </div>
  );
}
