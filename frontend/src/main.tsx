import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AssetsWindow } from "./components/AssetsWindow";
import { PromptProvider } from "./lib/prompt";
import { applyAccent, applyReduceMotion, loadAccent, loadLang, loadReduceMotion } from "./lib/theme";
import "./styles.css";

// 저장된 강조색·언어·모션설정을 렌더 전에 적용(FOUC 방지)
applyAccent(loadAccent());
document.documentElement.setAttribute("lang", loadLang());
applyReduceMotion(loadReduceMotion());

// `/?embed=assets` 로 열면 Assets 만 독립 창으로 렌더(분리된 브라우저 창).
const embed = new URLSearchParams(window.location.search).get("embed");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PromptProvider>{embed === "assets" ? <AssetsWindow /> : <App />}</PromptProvider>
  </StrictMode>,
);
