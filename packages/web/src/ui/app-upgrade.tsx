// 手机 App 太旧的提示：页面开在 App 里、App 低于最低版本时，内容区最上面一条"二狗 App 需要升级到 x.y"。
// 安卓：二狗带着安装包时按钮是"更新"（新版 App 在 App 里装，旧版 App 从二狗直接下载，ui/app-update.tsx，票 399）；没带时照旧给发布页的 APK 链接，
// 新版安卓 App 里这个链接交给手机的系统浏览器（AppUpgradeLink，票 386）。
// 待办里"App 太旧了"那条的"去升级"（AppUpgradeNoticeLink）：在这台手机自己的新版安卓 App 里、二狗又带着比它新的安装包时，
// 去设置 · 设备配对、定位到这台手机那一行的"更新"（一键更新，票 399）；不然照旧去下载或看教程（票 386）。
// 鸿蒙给手机安装教程（没法替用户签名），认不出哪种 App 给"装 App"那一节。
// 直接看本机版本和最低版本（页面是服务端给的，里面的最低版本就是服务端的要求），所以系统通知发不出去也看得到；升级后版本够了，这一条自然没有。
// 够新、不在 App 里（手机浏览器、电脑）时什么都不画。系统通知和待办由守护进程判断后发（ADR-0047）。
import type { MouseEvent, ReactNode } from "react";
import { useAccess } from "../app/access.tsx";
import { SYSTEM_BROWSER_LINK_ATTR } from "../app/browser-shell.ts";
import type { NativeApp } from "../app/native-app.ts";
import { openInPageNativeBrowser } from "../app/native-open.ts";
import { pageAppReport, pageNativeApp } from "../app/page-native.ts";
import { DEVICES_UPDATE_ITEM, toHash } from "../app/route.ts";
import {
  activeLocale,
  type AppOutdatedNoticeData,
  appUpdateFor,
  type AppUpdateView,
  appUpgradeLink,
  appVersionOutdated,
  MIN_APP_VERSION,
  type ReportAppVersionParams,
  t,
} from "../state/index.ts";
import { AppUpdateAction, useAppUpdateView } from "./app-update.tsx";

/**
 * 点了去升级的链接怎么开：交给手机的系统浏览器（新版安卓 App 才有 openSystemBrowser）；系统浏览器打不开（手机上没有浏览器、App 出错）时退回成
 * fallback（照没有这个方法时的样子开）。返回 true 是这次由这里管了（调用方拦下链接本来的跳转）；App 没有这个方法返回 false，链接照常
 */
export function openUpgradeOutside(app: Pick<NativeApp, "openSystemBrowser"> | undefined, url: string, fallback: (url: string) => void): boolean {
  const open = app?.openSystemBrowser;
  if (!open) return false;
  void open(url).then((ok) => {
    if (!ok) fallback(url);
  });
  return true;
}

/** 系统浏览器打不开时：在"浏览"里打开（浏览插件开着时），不然让 App 自己接这次跳转（它交给系统或"浏览"） */
function openInsideApp(url: string): void {
  if (!openInPageNativeBrowser(url)) window.location.assign(url);
}

/**
 * 去升级的链接（这条提示、待办里"App 太旧了"那一条的"去升级"）：安卓的 APK 下载链接在新版安卓 App 里交给手机的系统浏览器（票 386），
 * 下载、装都是系统的样子，用户熟悉，不用在"浏览"里存文件再去"文件"里找。旧版 App（没有这个方法）、鸿蒙的安装教程、不在 App 里时照旧是外链
 */
export function AppUpgradeLink({ link, className, children }: { link: { kind: "download" | "guide"; url: string }; className: string; children: ReactNode }) {
  const app = link.kind === "download" ? pageNativeApp() : undefined;
  const outside = app?.openSystemBrowser !== undefined;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (openUpgradeOutside(app, link.url, openInsideApp)) e.preventDefault();
  };
  return (
    <a className={className} href={link.url} target="_blank" rel="noopener noreferrer" {...(outside ? { [SYSTEM_BROWSER_LINK_ATTR]: "", onClick } : {})}>
      {children}
    </a>
  );
}

/**
 * 待办里"App 太旧了"那条的"去升级"能不能在 App 里一键更新（去设置 · 设备配对的"更新"）：
 * 页面开在能一键更新的安卓 App 里（inAppUpdate：原生桥上有 installAppUpdate）、这一条说的就是这台手机（selfDeviceId）、
 * 二狗带着比这台手机的 App 新的安卓安装包。别的（旧 App、鸿蒙、别的设备、电脑上、二狗没带包）照旧去下载或看教程
 */
export function upgradeInApp(input: {
  inAppUpdate: boolean;
  selfDeviceId: string | undefined;
  data: AppOutdatedNoticeData | undefined;
  /** 这台手机的 App 现在的版本（页面开在 App 里时报的）；没有就看这一条写的 */
  appVersion: string | undefined;
  view: AppUpdateView | undefined;
}): boolean {
  const { data } = input;
  if (!input.inAppUpdate || data === undefined || data.platform !== "android" || input.selfDeviceId === undefined || data.deviceId !== input.selfDeviceId) return false;
  return appUpdateFor({ appVersion: input.appVersion ?? data.version, appPlatform: "android" }, input.view) !== undefined;
}

/** 待办里"App 太旧了"那条的"去升级"：能一键更新时去设置 · 设备配对、定位到"更新"；不然是去下载或看教程的链接（按那台手机是哪种 App） */
export function AppUpgradeNoticeLink({ data, className, children }: { data: AppOutdatedNoticeData | undefined; className: string; children: ReactNode }) {
  const access = useAccess();
  const selfDeviceId = access?.access === "device" ? access.device.id : undefined;
  const inAppUpdate = pageNativeApp()?.appUpdate !== undefined;
  // 有可能一键更新时才问二狗带没带安装包
  const view = useAppUpdateView(inAppUpdate && data?.platform === "android" && data.deviceId === selfDeviceId);
  if (upgradeInApp({ inAppUpdate, selfDeviceId, data, appVersion: pageAppReport()?.version, view })) {
    return (
      <a className={className} href={toHash({ tab: "more", page: "devices", item: DEVICES_UPDATE_ITEM })} data-action="app-upgrade-devices">
        {children}
      </a>
    );
  }
  return (
    <AppUpgradeLink className={className} link={appUpgradeLink(data?.platform, activeLocale().meta.id)}>
      {children}
    </AppUpgradeLink>
  );
}

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
          <AppUpgradeLink link={link} className="btn primary small">
            {link.kind === "download" ? t("ui.appUpgrade.download") : t("ui.appUpgrade.guide")}
          </AppUpgradeLink>
        )}
      </span>
    </div>
  );
}
