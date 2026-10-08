// 편집 탭의 소스 뷰어 — 듀얼 뷰어(Jay 2026-10-08)의 왼쪽. 미디어 풀에서 고른 생성물을 타임라인과 나란히 본다.
//  영상은 브라우저 기본 재생 막대로 본다(편집 키 Space·J·K·L 은 언제나 타임라인 것이다 — 여기는 마우스로 조작한다).
// ponytail: 다빈치식 소스 조작(J/K/L·In/Out·끌어다 넣기)은 없다 — 넣기는 풀의 더블클릭·우클릭. 필요해지면 전용 재생 훅으로.
import { generationListMeta } from "../../lib/generationDisplay";
import { useT } from "../../lib/i18n";
import { thumbOf } from "../../lib/media";
import type { Generation } from "../../types";

export function EditSourceViewer({ gen }: { gen: Generation | null }) {
  const t = useT();
  const asset = gen?.assets[0];
  const detail = gen ? [gen.creator_name || gen.worker_name, gen.model,
    asset?.type === "video" ? generationListMeta(gen.params ?? {}).duration : null].filter(Boolean).join(" · ") : "";
  return (
    <section className="ed-view ed-src">
      <div className="ed-stage">
        {/* key = 주소 — 다른 생성물을 고르면 영상 요소를 새로 만든다(앞 영상의 재생 위치·소리가 이어지지 않게) */}
        {asset?.type === "video" && (
          <video key={asset.file_path} className="ed-media" src={asset.file_path} poster={thumbOf(gen!, 512) ?? undefined}
            controls playsInline preload="metadata" />
        )}
        {asset?.type === "image" && <img className="ed-media" src={asset.file_path} alt="" draggable={false} />}
        {!gen && <div className="ed-notice" role="status">{t("미디어 풀에서 생성물을 고르면 여기에서 봅니다.")}</div>}
        <span className="ed-chip ed-chip-l">{t("소스")}</span>
      </div>
      <div className="ed-trans ed-src-info" title={gen?.prompt ?? undefined}>{detail}</div>
    </section>
  );
}
