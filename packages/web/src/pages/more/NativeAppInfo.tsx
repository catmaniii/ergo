// 设置顶部的"在鸿蒙 App 里运行"（62 号票）：页面开在鸿蒙 App 里时显示 App 版本和"换地址"（回到 App 的地址页）；
// 在手机浏览器、电脑上什么都不显示。
import { pageNativeApp } from "../../app/page-native.ts";

export function NativeAppInfo() {
  const app = pageNativeApp();
  if (!app) return null;
  return (
    <div className="menu-item">
      <span className="menu-text">
        在鸿蒙 App 里运行
        <small>App 版本 {app.version}</small>
      </span>
      <button type="button" className="btn ghost small" onClick={() => app.editServer()}>
        换地址
      </button>
    </div>
  );
}
