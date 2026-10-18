import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, loadThemeChoice, systemPrefersDark } from "./theme";
import "./styles.css";
import "./light.css";

// **必须在 React 渲染前同步应用主题**：
// 主题原本只在 App 的 useEffect 里写入 `<html data-theme>`，而那是首帧之后才跑——
// 深色用户每次启动都会先闪一下浅色背景，观感像"页面先坏了一下"。
// 这里在模块求值阶段就写好，首帧直接用正确主题。
applyTheme(loadThemeChoice(), systemPrefersDark());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
