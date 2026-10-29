// 设置顶部的"在鸿蒙 App 里运行"（62 号票）：页面开在鸿蒙 App 里时显示 App 版本和"换地址"（回到 App 的地址页）；
// 新版 App 下面再一行"系统通知"（110 号票）：开没开，没开时"去打开"（没问过就弹系统的授权框，拒过的拉起系统的通知设置）。
// 在手机浏览器、电脑上什么都不显示。
import { useEffect, useState } from "react";
import type { NativeNotify } from "../../app/native-notify.ts";
import { pageNativeApp } from "../../app/page-native.ts";
import { t } from "../../state/index.ts";

export function NativeAppInfo() {
  const app = pageNativeApp();
  if (!app) return null;
  return (
    <>
      <div className="menu-item">
        <span className="menu-text">
          {t("pages.nativeApp.title")}
          <small>{t("pages.nativeApp.version", { version: app.version })}</small>
        </span>
        <button type="button" className="btn ghost small" onClick={() => app.editServer()}>
          {t("pages.nativeApp.changeServer")}
        </button>
      </div>
      {app.notify && <NotifySetting notify={app.notify} />}
    </>
  );
}

/** App 的系统通知开没开；从系统设置回来（页面回到前台、拿回焦点）再看一眼 */
function NotifySetting({ notify }: { notify: NativeNotify }) {
  const [state, setState] = useState(() => notify.state());
  useEffect(() => {
    const again = () => setState(notify.state());
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [notify]);
  if (!state) return null;
  return (
    <div className="menu-item">
      <span className="menu-text">
        {t("pages.nativeApp.notifications")}
        <small>{state.enabled ? t("pages.nativeApp.notificationsOn") : t("pages.nativeApp.notificationsOff")}</small>
      </span>
      {!state.enabled && (
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            void notify.prepare(true).then((next) => setState(next ?? notify.state()));
          }}
        >
          {t("pages.nativeApp.turnOn")}
        </button>
      )}
    </div>
  );
}
