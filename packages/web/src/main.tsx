import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/voice.css";
// 视觉规矩（颜色、线型、动效），压在前面几份上面（AgentSense 同）
import "./styles/look.css";
import App from "./App.tsx";
import { pageTheme } from "./app/page-theme.ts";

// 外观：index.html 的内联脚本已经按记住的选择挂好了，这里接手（设置里改、跟着系统深浅色变）
pageTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
