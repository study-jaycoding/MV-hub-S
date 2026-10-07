import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { PromptProvider } from "./lib/prompt";
import { EMBED_MODES } from "./lib/popupWindows";
import { applyAccent, applyReduceMotion, loadAccent, loadLang, loadReduceMotion } from "./lib/theme";
import { bootSceneStore } from "./lib/sceneBoot";
import "./styles.css";

// 코드 스플리팅 — 메인 앱과 Assets 팝업을 별도 청크로. 메인 창은 App 청크만, 팝업(?embed=assets)은
// AssetsWindow 청크만 받는다(서로의 큰 코드를 안 받음 → 초기 로드 축소).
const App = lazy(() => import("./App"));
const AssetsWindow = lazy(() =>
  import("./components/AssetsWindow").then((m) => ({ default: m.AssetsWindow })),
);
// PM 대시보드(분리형) — `?embed=manage` 전용 청크. 메인 앱 코드와 분리.
const ManageWindow = lazy(() =>
  import("./components/ManageWindow").then((m) => ({ default: m.ManageWindow })),
);

// 저장된 강조색·언어·모션설정을 렌더 전에 적용(FOUC 방지)
applyAccent(loadAccent());
document.documentElement.setAttribute("lang", loadLang());
applyReduceMotion(loadReduceMotion());

// `/?embed=assets` 로 열면 Assets 만 독립 창으로 렌더(분리된 브라우저 창).
const embed = new URLSearchParams(window.location.search).get("embed");

const root = createRoot(document.getElementById("root")!);

function render(children: React.ReactNode) {
  root.render(
    <StrictMode>
      <PromptProvider>
        <Suspense fallback={null}>{children}</Suspense>
      </PromptProvider>
    </StrictMode>,
  );
}

// 씬 저장소를 못 열면 **빈 데이터로 진행하지 않는다**. 빈 캔버스로 띄우면 사용자는 작업물이 사라진 줄
// 알고, 그 상태의 저장이 멀쩡한 백업까지 덮을 수 있다(적대 리뷰 r3). 이유를 보여 주고 멈춘다.
function renderStoreError(message: string) {
  const root = document.getElementById("root")!;
  root.innerHTML = "";
  const box = document.createElement("div");
  box.style.cssText =
    "max-width:560px;margin:14vh auto;padding:22px 26px;border:1px solid #4a3030;border-radius:12px;" +
    "background:#1a1316;color:#cdd3dc;font:14px/1.7 'Malgun Gothic',system-ui,sans-serif";
  const title = document.createElement("b");
  title.style.cssText = "display:block;margin-bottom:8px;font-size:16px;color:#ff9b9b";
  title.textContent = "캔버스 저장소를 열지 못했습니다";
  const body = document.createElement("p");
  body.style.cssText = "margin:0 0 14px";
  body.textContent =
    "작업물은 그대로 있습니다. 브라우저가 저장소를 막고 있거나(시크릿 창·사이트 데이터 차단) " +
    "다른 창이 쓰고 있을 수 있습니다. 다른 창을 닫고 다시 시도하세요.";
  const detail = document.createElement("p");
  detail.style.cssText = "margin:0 0 14px;font-size:12px;color:#8a93a2";
  detail.textContent = message;
  const retry = document.createElement("button");
  retry.textContent = "다시 시도";
  retry.style.cssText =
    "padding:7px 16px;border-radius:8px;border:1px solid #3c4a2e;background:#2f3a24;color:#c4e84a;" +
    "font-weight:700;cursor:pointer";
  retry.onclick = () => window.location.reload();
  box.append(title, body, detail, retry);
  root.append(box);
}

// ★순서를 강제한다: 저장소 열기·이관 완료 → App 마운트 → (App 안에서) 백업 미러.
//  App 의 effect 로 미루면 늦다 — 첫 렌더에서 이미 씬 목록을 읽는다(useSceneCoordination).
void bootSceneStore().then((result) => {
  if (result.kind === "failed") {
    renderStoreError(result.error);
    return;
  }
  render(
    embed === EMBED_MODES.assets ? (
      <AssetsWindow />
    ) : embed === EMBED_MODES.manage ? (
      <ManageWindow />
    ) : (
      <App />
    ),
  );
});
