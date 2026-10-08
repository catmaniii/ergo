import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/voice.css";
// 视觉规矩（颜色、线型、动效），压在前面几份上面（AgentSense 同）
import "./styles/look.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
