import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyThemeInitial } from "@/shared/ui/theme";
import "@/shared/ui/styles/tokens.css";
import "@/shared/ui/styles/app.css";
import "@/shared/ui/styles/workbench.css";
import "@/shared/ui/styles/nav-rail.css";
import "@/shared/ui/styles/drawer.css";
import "@/shared/ui/styles/trace.css";
import "@/shared/ui/styles/agents.css";
import "@/shared/ui/styles/index.css";

// 首帧前应用持久化主题（避免亮色用户暗帧闪烁）
applyThemeInitial();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
