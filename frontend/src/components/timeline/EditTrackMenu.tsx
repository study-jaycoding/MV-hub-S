// 편집 탭 — 카드 우클릭 메뉴(Jay 2026-10-08). 지금 타임라인에 있는 트랙(V3·V2·V1)을 보여 주고, 고르면 그 트랙에 넣는다.
//  찬 트랙을 고르면 교체, 빈 트랙이면 그 자리에 들어간다. 편집 탭이 연 폴더 창의 카드가 쓴다 — 창이 떠 있는 동안 .body 는
//  inert 라 body 로 옮겨 그린다. 틀·바깥 누르기는 폴더 우클릭 메뉴(ProjectSection)와 같다.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { clampMenuPosition } from "../../lib/folderContextMenu";
import { useT } from "../../lib/i18n";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";

// here = 이 카드가 지금 있는 트랙 · taken = 다른 카드가 있다(고르면 교체) · locked = 잠긴 트랙이 걸려 못 넣는다
export interface TrackRow {
  track: number;
  state: "empty" | "taken" | "here" | "locked";
}

const MENU_W = 190;
const HEAD_H = 38; // 위아래 여백 + 제목 줄
const ROW_H = 30; // 줄 28 + 간격 2

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
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useOutsideMouseDown(ref, onClose);
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
        onCloseRef.current();
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
  const hint = { empty: t("비어 있음"), taken: t("교체"), here: t("지금 여기"), locked: t("잠김") };
  const first = rows.find((row) => row.state === "empty" || row.state === "taken");
  return createPortal(
    <div
      ref={ref}
      className="folder-ctx-menu ed-tmenu"
      role="menu"
      aria-label={t("넣을 트랙")}
      tabIndex={-1}
      style={clampMenuPosition(x, y, window.innerWidth, window.innerHeight, MENU_W, HEAD_H + rows.length * ROW_H)}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
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
    </div>,
    document.body,
  );
}
