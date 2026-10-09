import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/voice.css";
// 视觉规矩（颜色、线型、动效），压在前面几份上面（AgentSense 同）
import "./styles/look.css";
// 视觉风格（39 号票）：风格清单生成的 token，和清单里每套风格自己的规则（<id>/style.css，限定在这套风格下），
// 压在上面几份后面（build/visual-styles-plugin.ts）
import "virtual:visual-styles";
import App from "./App.tsx";
import { connectNativeApp } from "./app/page-native.ts";
import { pageTheme } from "./app/page-theme.ts";

// 外观和风格：index.html 的内联脚本已经按记住的选择挂好了，这里接手（设置里改、跟着系统深浅色变）
pageTheme();
// 开在鸿蒙 App 里（62 号票）：外观告诉 App、接上系统返回键；不在 App 里什么都不做
connectNativeApp();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
