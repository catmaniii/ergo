// 页面日志（124 号票：Debug 工具集）最先开始收：后面的模块执行时出的错也收得到
import "./app/page-log-start.ts";
// 多语言（168 号票）：画出来之前装上这台设备上次用的语言（记着的词典），原型（file://）按地址的 ?lang=，没写是中文。
// 172 号票：要在界面各模块加载之前装上（它们在模块顶层取的字才是这种语言的，不是 key），所以单放一个模块、排在前面引
import "./app/locale-boot.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/voice.css";
// 会话缩放（54 号票）
import "./styles/zoom.css";
// 详情页（56 号票）
import "./styles/detail.css";
// 任务和待办的管理（90 号票）：菜单、多选、任务详情顶部的一行
import "./styles/manage.css";
// 视觉规矩（颜色、线型、动效），压在前面几份上面
import "./styles/look.css";
// 视觉风格（39 号票）：风格清单生成的 token，和清单里每套风格自己的规则（<id>/style.css，限定在这套风格下），
// 压在上面几份后面（build/visual-styles-plugin.ts）
import "virtual:visual-styles";
import App from "./App.tsx";
import { connectNativeApp } from "./app/page-native.ts";
import { connectSystemNotify } from "./app/page-notify.ts";
import { pageTheme } from "./app/page-theme.ts";

// 外观和风格：index.html 的内联脚本已经按记住的选择挂好了，这里接手（设置里改、跟着系统深浅色变）
pageTheme();
// 开在鸿蒙 App 里（62 号票）：外观告诉 App、接上系统返回键；不在 App 里什么都不做
connectNativeApp();
// App 的系统通知（110 号票）：点了通知栏里的一条把 App 拉起来的，页面画出来之前先换到那一项；第一次问通知授权
connectSystemNotify();
// App 的原生内置浏览器（134 号票：告诉 App 有"浏览"页签了，页面里点的外链改到"浏览"里打开）212 号票起由浏览插件第一次装上时接上
// （App.tsx 建插件宿主时），插件停用了就不出"浏览"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
