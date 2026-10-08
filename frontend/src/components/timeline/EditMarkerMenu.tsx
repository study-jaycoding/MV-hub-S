// 편집 탭 — 북마크(다빈치의 마커) 편집 창(Jay 2026-10-08). 눈금자의 북마크를 더블클릭·우클릭하거나, 북마크가 있는 자리에서
//  M 을 누르면 뜬다. 이름은 Enter·바깥 누르기에 저장하고 Esc·Tab 은 버린다. 색은 누르는 즉시 바뀌고 창은 그대로 있다.
//  껍데기(자리·바깥 누르기·키 차단)는 EditMenu 의 것이고, 저장·버리기는 이 창의 일이다.
import { useState } from "react";
import { timecode, type EditMarker } from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { EditMenu, EditSwatches } from "./EditTrackMenu";

export function EditMarkerMenu({
  x,
  y,
  time,
  marker,
  onName,
  onColor,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  time: number;
  marker: EditMarker;
  onName: (name: string) => void; // 바뀐 것이 없으면 받는 쪽이 아무것도 하지 않는다
  onColor: (color: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(marker.name ?? "");
  return (
    <EditMenu x={x} y={y} width={212} height={150} label={t("북마크")} className="ed-mmenu"
      onClose={(byKey) => {
        if (!byKey) onName(name);
        onClose();
      }}>
      <div className="ed-tmenu-head">{t("북마크")} · {timecode(time)}</div>
      <input className="ed-mmenu-name" autoFocus value={name} maxLength={40} placeholder={t("이름")} aria-label={t("북마크 이름")}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          // 한글 조합 중의 Enter 는 글자를 확정하는 키다 — 저장·닫기는 그다음 Enter 에(앱의 다른 입력칸과 같은 규칙)
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
          onName(name);
          onClose();
        }} />
      <EditSwatches label={t("북마크 색")} value={marker.color ?? null} onPick={onColor} />
      <button type="button" role="menuitem" className="ed-tmenu-item" onClick={() => {
        onRemove();
        onClose();
      }}>
        {t("북마크 지우기")}
        <i>Alt+M</i>
      </button>
    </EditMenu>
  );
}
