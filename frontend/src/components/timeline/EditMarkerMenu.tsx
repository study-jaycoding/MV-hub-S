// 편집 탭 — 북마크(다빈치의 마커)의 메뉴 둘(Jay 2026-10-08). 색은 다빈치의 마커 색 16가지(MARKER_COLORS).
//  · EditMarkerMenu — 북마크 편집 창. 눈금자의 북마크를 더블클릭·우클릭하거나, 북마크가 있는 자리에서 M 을 누르면 뜬다.
//    이름은 Enter·바깥 누르기에 저장하고 Esc·Tab 은 버린다. 색은 누르는 즉시 바뀌고 창은 그대로 있다.
//  · EditMarkerColorMenu — 막대의 북마크 단추 옆 ▾. 새 북마크의 색을 고르고, 북마크를 모두 지운다(다빈치의 마커 색 메뉴).
//  껍데기(자리·바깥 누르기·키 차단)는 EditMenu 의 것이고, 저장·버리기는 이 창의 일이다.
import { useState } from "react";
import { MARKER_COLORS, timecode, type EditMarker } from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { EditMenu, EditSwatches } from "./EditTrackMenu";

const COLORS = MARKER_COLORS.map((item) => item.color);

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
    <EditMenu x={x} y={y} width={212} height={176} label={t("북마크")} className="ed-mmenu"
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
      <EditSwatches label={t("북마크 색")} value={marker.color ?? null} colors={COLORS} onPick={onColor} />
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

const COLOR_MENU_H = 26 * (MARKER_COLORS.length + 1) + 23;

export function EditMarkerColorMenu({
  x,
  top,
  bottom,
  value,
  count,
  onPick,
  onClearAll,
  onClose,
}: {
  x: number;
  top: number; // 메뉴를 연 단추의 위·아래 — 아래에 자리가 모자라면 단추 위로 띄운다(단추를 덮으면 두 번 누를 때 엉뚱한 색이 골라진다)
  bottom: number;
  value: string; // 새 북마크에 쓸 색
  count: number; // 이 시퀀스의 북마크 수(0 이면 '모두 지우기'가 흐리다)
  onPick: (color: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const y = bottom + 4 + COLOR_MENU_H > window.innerHeight ? top - 4 - COLOR_MENU_H : bottom + 4;
  return (
    <EditMenu x={x} y={y} width={172} height={COLOR_MENU_H} label={t("새 북마크의 색")} className="ed-cmenu" onClose={onClose}>
      <button type="button" role="menuitem" className="ed-tmenu-item" disabled={!count} onClick={onClearAll}>
        {t("모두 지우기")}
        <i>×</i>
      </button>
      <div className="ed-tmenu-sep" />
      {MARKER_COLORS.map(({ name, color }) => (
        <button key={color} type="button" role="menuitemradio" aria-checked={color === value} autoFocus={color === value}
          className={"ed-tmenu-item" + (color === value ? " ed-here" : "")} onClick={() => onPick(color)}>
          {t(name)}
          <span className="ed-cmenu-tag" style={{ background: color }} />
        </button>
      ))}
    </EditMenu>
  );
}
