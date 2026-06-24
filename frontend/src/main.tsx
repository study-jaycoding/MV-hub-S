import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { PromptProvider } from "./lib/prompt";
import { applyAccent, applyReduceMotion, loadAccent, loadLang, loadReduceMotion } from "./lib/theme";
import "./styles.css";

// 코드 스플리팅 — 메인 앱과 Assets 팝업을 별도 청크로. 메인 창은 App 청크만, 팝업(?embed=assets)은
// AssetsWindow 청크만 받는다(서로의 큰 코드를 안 받음 → 초기 로드 축소).
const App = lazy(() => import("./App"));
const AssetsWindow = lazy(() =>
  import("./components/AssetsWindow").then((m) => ({ default: m.AssetsWindow })),
);

// 저장된 강조색·언어·모션설정을 렌더 전에 적용(FOUC 방지)
applyAccent(loadAccent());
document.documentElement.setAttribute("lang", loadLang());
applyReduceMotion(loadReduceMotion());

// `/?embed=assets` 로 열면 Assets 만 독립 창으로 렌더(분리된 브라우저 창).
const embed = new URLSearchParams(window.location.search).get("embed");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PromptProvider>
      <Suspense fallback={null}>{embed === "assets" ? <AssetsWindow /> : <App />}</Suspense>
    </PromptProvider>
  </StrictMode>,
);
