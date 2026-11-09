// Assets 독립 창 (embed 모드) — `/?embed=assets` 로 열리는 분리된 브라우저 창.
// 메인 앱과 별개로 AssetsView + 정보 팝업 + 미디어 미리보기를 자체적으로 띄운다.
// (project-viewer 의 ?embed=tree 분리 창과 같은 방식)
import { useEffect, useLayoutEffect, useState } from "react";
import type { InfoTarget, PreviewTarget } from "../types";
import { configureOperationContext, watchOperationContext } from "../app/operationContext";
import { useCommentWriteContext } from "../lib/commentTarget";
import { usePageSelectAllGuard } from "../lib/keyGate";
import { useAppToast } from "../lib/useAppToast";
import { AssetsView } from "./AssetsView";
import { InfoPopup } from "./InfoPopup";
import { MediaPreview } from "./MediaPreview";
import { PopupAuthPauseBanner } from "./app/AuthPauseBanner";

export function AssetsWindow() {
  usePageSelectAllGuard(); // 분리 창은 App 밖에서 뜬다 — 조합 중 Enter·입력칸 밖 Ctrl+A 지킴이를 이 창에도 건다(lib/keyGate)
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  // 실패 안내(ch:flash)도 이 창이 받아 그린다 — App 밖이라 받을 곳이 없어, 색·태그·코멘트 저장 실패를 모른 채 지나갔다(60회차)
  const { toast } = useAppToast();
  // 계정·연결 문맥 — 이 창은 App 을 거치지 않아 허브 기능 표식·작업 문맥이 비어 있었다(기본값 = 준비됨·로컬). 메인 앱과 같은 근거
  //  (/api/auth/config + 허브 상태)로 읽고, 바뀌면 다시 읽는다. 읽기 전·실패 = 준비 안 됨(코멘트 그림의 [편집]·전송을 막는다 — 어셋 그림 §4)
  const writeContext = useCommentWriteContext();
  useLayoutEffect(() => {
    configureOperationContext({
      key: writeContext?.key ?? "",
      serverOrigin: writeContext?.serverUrl || window.location.origin,
      authority: writeContext?.mode === "hub" ? "local" : "team",
      ready: !!writeContext,
    });
    return watchOperationContext();
  }, [writeContext]);

  useEffect(() => {
    document.title = "Millionvolt Hub — Assets (구성)";
  }, []);

  return (
    <div className="assets-window">
      <AssetsView onInfo={setInfo} onPreview={setPreview} writeContext={writeContext} />
      {info && <InfoPopup target={info} onClose={() => setInfo(null)} onPreview={setPreview} />}
      {preview && (
        // 비공개 허용은 실제 모드로 — 서버 직결 화면이면 숨긴다(기본 true 로 두면 서버 직결에도 비공개 입력이 보였다)
        <MediaPreview target={preview} onClose={() => setPreview(null)} localHub={writeContext ? writeContext.allowPrivate : false} />
      )}
      {toast && <div className="toast">{toast}</div>}
      <PopupAuthPauseBanner />
    </div>
  );
}
