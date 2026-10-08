// 편집 탭의 우클릭 메뉴들(Jay 2026-10-08) — 껍데기(EditMenu) 하나를 같이 쓴다. 껍데기는 자리·바깥 누르기·키 차단만 맡는다.
//  · EditTrackMenu — 카드 우클릭: 지금 타임라인에 있는 트랙(V3·V2·V1)을 보여 주고, 고르면 그 트랙에 넣는다(찬 트랙은 교체).
//  · EditTrackHeadMenu — 트랙 머리 우클릭: 트랙 추가·위/아래로·삭제·빈 트랙 삭제·색(다빈치의 트랙 머리 메뉴).
//  · 북마크 편집 창(EditMarkerMenu.tsx)도 이 껍데기를 쓴다.
//  편집 탭이 연 폴더 창의 카드도 쓴다 — 창이 떠 있는 동안 .body 는 inert 라 body 로 옮겨 그린다. 틀·바깥 누르기는 폴더
//  우클릭 메뉴(ProjectSection)와 같다.
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clampMenuPosition } from "../../lib/folderContextMenu";
import { useT } from "../../lib/i18n";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { GROUP_COLORS } from "../scene/sceneColors";

const HEAD_H = 38; // 위아래 여백 + 제목 줄
const ROW_H = 30; // 줄 28 + 간격 2
const SEP_H = 11; // 가름줄 1 + 여백 + 간격

export function EditMenu({
  x,
  y,
  width,
  height,
  label,
  className = "",
  onClose,
  children,
}: {
  x: number;
  y: number;
  width: number;
  height: number; // 화면 밖으로 안 나가게 자리를 잡는 데만 쓴다
  label: string;
  className?: string;
  onClose: (byKey: boolean) => void; // byKey = Esc·Tab 으로 닫았다(바깥을 누른 것이 아니다)
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOutside = useRef(() => onCloseRef.current(false)).current;
  useOutsideMouseDown(ref, closeOutside);
  // 메뉴가 떠 있는 동안의 키 — 캡처 단계에서 먼저 본다(리스너는 한 번만 건다: useEscapeClose 의 주석).
  //  · Esc·Tab 은 메뉴가 먹고 닫는다. Esc 는 뒤의 폴더 창까지 닫지 않게, Tab 은 초점이 메뉴 밖으로 나가지 않게 —
  //    나가면 뒤 단추를 Enter·Space 로 누를 수 있다(전파를 막아도 단추의 기본 동작은 남는다, Codex 코드 리뷰).
  //  · 줄은 ↑↓ 로 옮긴다(Tab 이 닫기라 다른 길이 없다).
  //  · 메뉴 밖에서 난 키는 뒤 화면(편집 키·라이브러리 키)으로 보내지 않는다 — 고를 줄이 없어 초점을 단추에 못 준 메뉴에서
  //    M·R 같은 키가 뒤에서 실행되던 길. 브라우저 기본 동작(새로고침 등)은 막지 않는다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const menu = ref.current;
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const items = [...(menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const down = event.key === "ArrowDown";
        items[at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (!menu?.contains(event.target as Node)) event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // 고를 줄이 하나도 없으면(autoFocus 할 단추가 없다) 메뉴 자신이 초점을 받는다.
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <div
      ref={ref}
      className={"folder-ctx-menu ed-tmenu" + (className ? ` ${className}` : "")}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ ...clampMenuPosition(x, y, window.innerWidth, window.innerHeight, width, height), width }}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

// here = 이 카드가 지금 있는 트랙 · taken = 다른 카드가 있다(고르면 교체) · locked = 잠긴 트랙이 걸려 못 넣는다
export interface TrackRow {
  track: number;
  state: "empty" | "taken" | "here" | "locked";
}

export function EditTrackMenu({
  x,
  y,
  rows,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  rows: TrackRow[]; // 위 트랙부터
  onPick: (track: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const hint = { empty: t("비어 있음"), taken: t("교체"), here: t("지금 여기"), locked: t("잠김") };
  const first = rows.find((row) => row.state === "empty" || row.state === "taken");
  return (
    <EditMenu x={x} y={y} width={190} height={HEAD_H + rows.length * ROW_H} label={t("넣을 트랙")} onClose={onClose}>
      <div className="ed-tmenu-head">{t("넣을 트랙")}</div>
      {rows.map((row) => (
        <button
          key={row.track}
          type="button"
          role="menuitem"
          autoFocus={row === first}
          className={"ed-tmenu-item" + (row.state === "here" ? " ed-here" : "")}
          disabled={row.state === "here" || row.state === "locked"}
          onClick={() => onPick(row.track)}
        >
          <b>V{row.track}</b>
          <i>{hint[row.state]}</i>
        </button>
      ))}
    </EditMenu>
  );
}

// 색 견본 한 줄(트랙 색·북마크 색) — 씬 그룹과 같은 여덟 색. onClear 가 있으면 '색 없음'도 고를 수 있다.
export function EditSwatches({
  label,
  value,
  onPick,
  onClear,
}: {
  label: string;
  value: string | null;
  onPick: (color: string) => void;
  onClear?: () => void;
}) {
  const t = useT();
  return (
    <div className="ed-swatches" role="group" aria-label={label}>
      {GROUP_COLORS.map((color) => (
        <button key={color} type="button" className={"ed-swatch" + (color === value ? " ed-on" : "")} style={{ background: color }}
          aria-label={`${label} ${color}`} aria-pressed={color === value} onClick={() => onPick(color)} />
      ))}
      {onClear && (
        <button type="button" className="ed-swatch ed-swatch-none" title={t("색 없음")} aria-label={t("색 없음")}
          disabled={value === null} onClick={onClear}>×</button>
      )}
    </div>
  );
}

export type TrackAct = "add" | "up" | "down" | "delete" | "deleteEmpty" | { color: string | null };

export function EditTrackHeadMenu({
  x,
  y,
  track,
  can,
  clips,
  color,
  onAct,
  onClose,
}: {
  x: number;
  y: number;
  track: number;
  can: { up: boolean; down: boolean; remove: boolean; removeEmpty: boolean }; // 못 하는 것은 흐리게(잠금·맨 위/아래·한 줄뿐)
  clips: number; // 이 트랙의 클립 수 — 트랙을 지우면 같이 빠진다
  color: string | null;
  onAct: (action: TrackAct) => void;
  onClose: () => void;
}) {
  const t = useT();
  const row = (action: TrackAct, label: string, enabled = true, hint = "", focus = false) => (
    <button type="button" role="menuitem" className="ed-tmenu-item" autoFocus={focus} disabled={!enabled} onClick={() => onAct(action)}>
      {label}
      {hint && <i>{hint}</i>}
    </button>
  );
  return (
    <EditMenu x={x} y={y} width={206} height={HEAD_H + 6 * ROW_H + 3 * SEP_H} label={t("트랙 메뉴")} className="ed-hmenu" onClose={onClose}>
      <div className="ed-tmenu-head">V{track}</div>
      {row("add", t("이 위에 트랙 추가"), true, "", true)}
      <div className="ed-tmenu-sep" />
      {row("up", t("트랙 위로 옮기기"), can.up)}
      {row("down", t("트랙 아래로 옮기기"), can.down)}
      <div className="ed-tmenu-sep" />
      {row("delete", t("트랙 삭제"), can.remove, clips ? t("클립 {count}개").replace("{count}", String(clips)) : "")}
      {row("deleteEmpty", t("빈 트랙 모두 삭제"), can.removeEmpty)}
      <div className="ed-tmenu-sep" />
      <EditSwatches label={t("트랙 색")} value={color} onPick={(next) => onAct({ color: next })} onClear={() => onAct({ color: null })} />
    </EditMenu>
  );
}
