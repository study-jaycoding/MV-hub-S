// Assets 독립 창 (embed 모드) — `/?embed=assets` 로 열리는 분리된 브라우저 창.
// 메인 앱과 별개로 AssetsView + 정보 팝업 + 미디어 미리보기를 자체적으로 띄운다.
// (project-viewer 의 ?embed=tree 분리 창과 같은 방식)
import { useEffect, useState } from "react";
import type { InfoTarget, PreviewTarget } from "../types";
import { usePageSelectAllGuard } from "../lib/keyGate";
import { AssetsView } from "./AssetsView";
import { InfoPopup } from "./InfoPopup";
import { MediaPreview } from "./MediaPreview";

export function AssetsWindow() {
  usePageSelectAllGuard(); // 분리 창은 App 밖에서 뜬다 — 조합 중 Enter·입력칸 밖 Ctrl+A 지킴이를 이 창에도 건다(lib/keyGate)
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  useEffect(() => {
    document.title = "Millionvolt Hub — Assets (구성)";
  }, []);

  return (
    <div className="assets-window">
      <AssetsView onInfo={setInfo} onPreview={setPreview} />
      {info && <InfoPopup target={info} onClose={() => setInfo(null)} onPreview={setPreview} />}
      {preview && (
        <MediaPreview target={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
