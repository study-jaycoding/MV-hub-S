// 편집 탭의 우클릭 메뉴들(Jay 2026-10-08) — 껍데기(EditMenu) 하나를 같이 쓴다. 껍데기는 자리·바깥 누르기·키 차단만 맡는다.
//  · EditTrackMenu — 카드 휠 클릭(2026-10-13 부터 — 그 전에는 우클릭): 지금 타임라인에 있는 트랙(V3·V2·V1)을 보여 주고,
//    고르면 그 트랙에 넣는다(찬 트랙은 교체).
//  · EditTrackHeadMenu — 트랙 머리 우클릭: 트랙 추가·위/아래로·삭제·빈 트랙 삭제·색(다빈치의 트랙 머리 메뉴).
//  · EditListMenu — 막대의 목록 단추: 비활성 숨기기(켜고 끄기) · 빈 곳 채우기(한 번 실행) · 배치 순서(내 순서면 이름순으로).
//  · EditClipMenu — 타임라인의 클립 우클릭: Resolve 보내기.
//  · EditFolderMenu — 왼쪽 폴더 트리의 폴더 우클릭: 공유 저장 · 최종 저장 · 원본 위치 열기(공유 & 리뷰 탭의 폴더 메뉴와 같다).
//  · 북마크 편집 창(EditMarkerMenu.tsx)도 이 껍데기를 쓴다.
//  편집 탭이 연 폴더 창의 카드도 쓴다 — 창이 떠 있는 동안 .body 는 inert 라 body 로 옮겨 그린다. 틀·바깥 누르기는 폴더
//  우클릭 메뉴(ProjectSection)와 같다.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  clampMenuPosition, FOLDER_MENU_W, folderMenuHeight, folderMenuKinds, folderMenuLabel, folderTone, type FolderMenuKind,
} from "../../lib/folderContextMenu";
import { fillKeys, hintOf } from "../../lib/editShortcuts";
import { useT } from "../../lib/i18n";
import { useKeyOwner } from "../../lib/keyGate";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { GROUP_COLORS } from "../scene/sceneColors";

const HEAD_H = 38; // 위아래 여백 + 제목 줄
const ROW_H = 30; // 줄 28 + 간격 2
const SEP_H = 11; // 가름줄 1 + 여백 + 간격
const GAP = 2; // 누른 자리와 메뉴 사이
const EDGE = 4; // clampMenuPosition 이 화면 가장자리에 두는 여백

// 누른 자리(at)에서 뜨는 메뉴의 한 축 자리 — 그 뒤(아래·오른쪽)에 자리가 있으면 거기, 없으면 앞(위·왼쪽)으로 뒤집는다.
//  화면 안으로 밀어 넣지 않는다: 밀어 넣으면 메뉴가 누른 자리를 덮는다.
const beside = (at: number, size: number, room: number) => (at + GAP + size <= room - EDGE ? at + GAP : at - GAP - size);

export function EditMenu({
  x,
  y,
  width,
  height,
  label,
  className = "",
  role = "menu",
  trigger,
  onClose,
  children,
}: {
  x: number;
  y: number;
  width: number;
  height: number; // 화면 밖으로 안 나가게 자리를 잡는 데만 쓴다
  label: string;
  className?: string;
  role?: "menu" | "dialog"; // 고르는 줄이 아니라 조절하는 칸이 든 창(길이 조절)은 dialog

  // 이 메뉴를 여닫는 단추(막대의 목록·북마크 색 단추) — 그 단추의 누름은 바깥 누름으로 치지 않는다. 치면 누르는 순간
  //  (pointerdown) 메뉴가 먼저 닫히고 뒤따르는 click 이 다시 열어, 다시 눌러도 안 닫힌다. 닫는 것은 그 단추의 click 이 한다.
  //  우클릭으로 뜨는 메뉴에는 그런 단추가 없다(안 준다).
  trigger?: RefObject<HTMLElement>;
  onClose: (byKey: boolean) => void; // byKey = Esc·Tab 으로 닫았다(바깥을 누른 것이 아니다)
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOutside = useRef(() => onCloseRef.current(false)).current;
  useOutsideMouseDown(ref, closeOutside, true, trigger);
  // 떠 있는 동안은 뒤 화면을 덮은 것이다 — 메뉴를 닫는 누름이 뒤 격자·타임라인의 고르기까지 바꾸지 않게(조작 규칙 4: pressStartedCovered 가
  //  이 표식을 본다). 키는 아래가 따로 막는다(58회차).
  useKeyOwner();
  // 단추로 여는 메뉴(trigger)는 부르는 쪽이 단추에 맞춰 준 자리 그대로다. 우클릭으로 뜨는 메뉴는 누른 자리를 덮지 않게 놓는다 —
  //  화면 아래쪽의 트랙 머리에서는 메뉴가 화면 안으로 밀려 올라가 누른 자리를 덮었고, 그래서 그 머리를 다시 눌러도 '메뉴 안'의
  //  누름이라 닫히지 않았다(2026-10-11 격리 실측). 위아래 어느 쪽에도 안 들어가는 큰 메뉴만 마지막에 화면 안으로 밀린다.
  const at = trigger ? { x, y } : { x: beside(x, width, window.innerWidth), y: beside(y, height, window.innerHeight) };
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
        // 하위 메뉴(.ed-submenu — 트랙 색)에 초점이 있으면 그 안에서만, 아니면 하위 메뉴의 단추는 빼고 돈다
        const sub = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>(".ed-submenu") ?? null;
        const items = [...((sub ?? menu)?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
          .filter((item) => sub || !item.closest(".ed-submenu"));
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
      role={role}
      aria-label={label}
      tabIndex={-1}
      style={{ ...clampMenuPosition(at.x, at.y, window.innerWidth, window.innerHeight, width, height), width }}
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

// 색 견본(트랙 색·북마크 색) — 팔레트를 안 주면 씬 그룹과 같은 여덟 색. onClear 가 있으면 '색 없음'도 고를 수 있다.
export function EditSwatches({
  label,
  value,
  colors = GROUP_COLORS,
  onPick,
  onClear,
}: {
  label: string;
  value: string | null;
  colors?: readonly string[];
  onPick: (color: string) => void;
  onClear?: () => void;
}) {
  const t = useT();
  return (
    <div className="ed-swatches" role="group" aria-label={label}>
      {colors.map((color) => (
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

const SUB_W = 168; // 트랙 색 하위 메뉴(.ed-submenu) — 자리 잡기에만 쓴다
const SUB_H = 110;

// 트랙 머리 우클릭(Jay 2026-10-23 — 다빈치처럼 읽기 좋게, '지금 기능만 정리'): 줄을 키우고 못 하는 줄은 흐린 글씨, 색은 '트랙 색 ›' 의
//  오른쪽 하위 메뉴(누르기·마우스 올림·→ 로 열고 ← 로 닫는다). 하위 메뉴는 메뉴 상자 안의 자식이다 — 바깥 누름·키를 EditMenu 가 메뉴 안으로 본다.
export function EditTrackHeadMenu({
  x,
  y,
  track,
  can,
  clips,
  color,
  onAct,
  onClose,
  blank = false,
}: {
  // 트랙 밖 빈 곳의 우클릭(Jay 2026-10-23) — 어느 트랙도 아니라 '트랙 추가(맨 위에) · 빈 트랙 모두 삭제'만. track 은 맨 위 트랙(그 위에 더한다)
  blank?: boolean;
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
  const colorRow = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<{ x: number; y: number; focus: boolean } | null>(null);
  // 메뉴 오른쪽에 자리가 없으면 왼쪽에 연다 — 양쪽 다 모자라면(좁은 창) 화면 안으로 민다. 세로는 '트랙 색' 줄에 맞추되 화면 안으로.
  const openColors = (focus: boolean) => {
    const row = colorRow.current;
    const menu = row?.parentElement?.getBoundingClientRect();
    if (!row || !menu) return;
    const top = row.getBoundingClientRect().top - 8;
    const x = menu.right - 2 + SUB_W <= window.innerWidth - EDGE ? menu.right - 2 : menu.left + 2 - SUB_W;
    setColors({
      x: Math.max(EDGE, Math.min(x, window.innerWidth - EDGE - SUB_W)),
      y: Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - SUB_H)),
      focus,
    });
  };
  // 키로 열었으면 고른 색(없으면 첫 색)에 초점
  useEffect(() => {
    if (colors?.focus) (subRef.current?.querySelector<HTMLButtonElement>(".ed-swatch.ed-on") ?? subRef.current?.querySelector("button"))?.focus();
  }, [colors]);
  const row = (action: TrackAct, label: string, enabled = true, hint = "", focus = false) => (
    <button type="button" role="menuitem" className="ed-tmenu-item" autoFocus={focus} disabled={!enabled}
      onPointerEnter={() => setColors(null)} onClick={() => onAct(action)}>
      {label}
      {hint && <i>{hint}</i>}
    </button>
  );
  if (blank) {
    return (
      <EditMenu x={x} y={y} width={214} height={HEAD_H + 2 * ROW_H} label={t("트랙 메뉴")} className="ed-hmenu" onClose={onClose}>
        <div className="ed-tmenu-head">{t("트랙")}</div>
        {row("add", t("트랙 추가"), true, t("맨 위에"), true)}
        {row("deleteEmpty", t("빈 트랙 모두 삭제"), can.removeEmpty)}
      </EditMenu>
    );
  }
  return (
    <EditMenu x={x} y={y} width={214} height={HEAD_H + 7 * ROW_H + 3 * SEP_H} label={t("트랙 메뉴")} className="ed-hmenu" onClose={onClose}>
      <div className="ed-tmenu-head">{t("V{track} 트랙").replace("{track}", String(track))}</div>
      {row("add", t("트랙 추가"), true, t("위에"), true)}
      <div className="ed-tmenu-sep" />
      {row("up", t("트랙 위로 이동"), can.up)}
      {row("down", t("트랙 아래로 이동"), can.down)}
      <div className="ed-tmenu-sep" />
      {row("delete", t("트랙 삭제"), can.remove, clips ? t("클립 {count}개").replace("{count}", String(clips)) : "")}
      {row("deleteEmpty", t("빈 트랙 모두 삭제"), can.removeEmpty)}
      <div className="ed-tmenu-sep" />
      <button ref={colorRow} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={!!colors}
        className={"ed-tmenu-item" + (colors ? " ed-open" : "")}
        onPointerEnter={() => colors || openColors(false)}
        onClick={() => (colors ? setColors(null) : openColors(true))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          openColors(true);
        }}>
        {t("트랙 색")}
        <span className="ed-tmenu-right">{color && <span className="ed-colordot" style={{ background: color }} />}›</span>
      </button>
      {colors && (
        <div ref={subRef} className="ed-submenu" role="menu" aria-label={t("트랙 색")} style={{ left: colors.x, top: colors.y }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft") return;
            event.preventDefault();
            setColors(null);
            colorRow.current?.focus();
          }}>
          <EditSwatches label={t("트랙 색")} value={color} onPick={(next) => onAct({ color: next })} />
          <button type="button" role="menuitem" className="ed-tmenu-item" disabled={color === null} onClick={() => onAct({ color: null })}>
            {t("색 없음")}
          </button>
        </div>
      )}
    </EditMenu>
  );
}

// V0 줄(다른 편집 보기 — Jay 2026-10-23, 모의 그림 ③) 우클릭 — '작업자 선택 ›'(서버에 저장한 다른 작업자 · 마지막 저장 시각)과 '트랙 색 ›' 두 줄만.
//  하위 메뉴는 트랙 머리 메뉴와 같은 모양(누르기·마우스 올림·→ 로 열고 ← 로 닫는다).
export interface V0Worker { key: string; name: string; at: string }
export function EditV0Menu({ x, y, workers, picked, color, onPick, onColor, onClose }: {
  x: number;
  y: number;
  workers: V0Worker[];
  picked: string | null;
  color: string | null;
  onPick: (key: string) => void;
  onColor: (color: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const rows = { workers: useRef<HTMLButtonElement>(null), colors: useRef<HTMLButtonElement>(null) };
  const subRef = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ kind: "workers" | "colors"; x: number; y: number; focus: boolean } | null>(null);
  const height = (kind: "workers" | "colors") => (kind === "colors" ? SUB_H : HEAD_H + Math.max(1, workers.length) * ROW_H);
  const open = (kind: "workers" | "colors", focus: boolean) => {
    const row = rows[kind].current;
    const menu = row?.parentElement?.getBoundingClientRect();
    if (!row || !menu) return;
    const top = row.getBoundingClientRect().top - 8;
    const left = menu.right - 2 + SUB_W <= window.innerWidth - EDGE ? menu.right - 2 : menu.left + 2 - SUB_W;
    setSub({ kind, focus, x: Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - SUB_W)),
      y: Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - height(kind))) });
  };
  useEffect(() => {
    if (sub?.focus) (subRef.current?.querySelector<HTMLButtonElement>(".ed-on, .ed-here") ?? subRef.current?.querySelector("button"))?.focus();
  }, [sub]);
  const opener = (kind: "workers" | "colors", label: string, right: ReactNode, focus = false) => (
    <button ref={rows[kind]} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={sub?.kind === kind} autoFocus={focus}
      className={"ed-tmenu-item" + (sub?.kind === kind ? " ed-open" : "")}
      onPointerEnter={() => sub?.kind === kind || open(kind, false)}
      onClick={() => (sub?.kind === kind ? setSub(null) : open(kind, true))}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight") return;
        event.preventDefault();
        open(kind, true);
      }}>
      {label}
      <span className="ed-tmenu-right">{right}›</span>
    </button>
  );
  return (
    <EditMenu x={x} y={y} width={214} height={HEAD_H + 2 * ROW_H} label={t("V0 트랙")} className="ed-hmenu" onClose={onClose}>
      <div className="ed-tmenu-head">{t("V0 트랙")}</div>
      {opener("workers", t("작업자 선택"), null, true)}
      {opener("colors", t("트랙 색"), color && <span className="ed-colordot" style={{ background: color }} />)}
      {sub && (
        <div ref={subRef} className="ed-submenu" role="menu" aria-label={sub.kind === "colors" ? t("트랙 색") : t("서버에 저장한 작업자")}
          style={{ left: sub.x, top: sub.y }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft") return;
            event.preventDefault();
            const back = rows[sub.kind].current;
            setSub(null);
            back?.focus();
          }}>
          {sub.kind === "colors" ? (
            <>
              <EditSwatches label={t("트랙 색")} value={color} onPick={(next) => onColor(next)} />
              <button type="button" role="menuitem" className="ed-tmenu-item" disabled={color === null} onClick={() => onColor(null)}>
                {t("색 없음")}
              </button>
            </>
          ) : (
            <>
              <div className="ed-tmenu-head">{t("서버에 저장한 작업자")}</div>
              {workers.length ? workers.map((worker) => (
                <button key={worker.key} type="button" role="menuitemradio" aria-checked={worker.key === picked}
                  className={"ed-tmenu-item" + (worker.key === picked ? " ed-here" : "")} onClick={() => onPick(worker.key)}>
                  {worker.name || t("이름 없음")}
                  <i>{worker.at}</i>
                </button>
              )) : <div className="ed-tmenu-note">{t("서버에 저장한 다른 작업자가 없습니다")}</div>}
            </>
          )}
        </div>
      )}
    </EditMenu>
  );
}

// 막대의 목록 단추(Jay 2026-10-08) — 비활성 숨기기는 켜고 끄는 것(옆 숫자 = 비활성 폴더 수), 빈 곳 채우기는 한 번 실행하는
//  것(옆 숫자 = 채울 수 있는 빈 컷 수 — 없으면 흐리다). 아래에 자리가 모자라면 단추 위로 뜬다.
export function EditListMenu({
  x,
  top,
  bottom,
  hideOff,
  offCount,
  fillCount,
  finalAll,
  order,
  archive,
  trigger,
  onHide,
  onFill,
  onClose,
}: {
  x: number;
  top: number;
  bottom: number;
  hideOff: boolean;
  offCount: number;
  fillCount: number;
  // 타임라인 최종 확정(Jay 2026-10-13 · 10-14 이름 '모두 최종으로 확정'에서 바꿈) — 타임라인의 생성물에 최종을 줄 수 있는 사람에게만 준다(안 주면 줄이 없다).
  //  count = 지금 최종으로 올라갈 생성물 수(이미 최종인 것은 뺀 수 — 0 이면 흐리다) · busy = 앞서 누른 것이 아직 도는 중
  finalAll?: { count: number; busy: boolean; onRun: () => void };
  // 배치 순서(Jay 2026-10-26 — 막대의 '폴더 순서' 알약을 여기로) — mine = 폴더를 끌어 이름순과 다르게 했다(foldersReordered). 그때만 누르면 이름순으로.
  //  폴더끼리 이름순이면(반복 자리만 끼워 둔 것 포함) '폴더순' 표시만 — 되돌리면 끼워 넣은 자리가 폴더 옆으로 모인다.
  order: { mine: boolean; onReset: () => void };
  archive?: { canImport: boolean; onExport: () => void; onImport: () => void; onBackup?: () => void };
  trigger: RefObject<HTMLElement>; // 목록 단추 — 다시 누르면 그 단추가 닫는다(EditMenu)
  onHide: () => void;
  onFill: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const height = HEAD_H - 22 + ((finalAll ? 4 : 3) + (archive ? 2 + (archive.onBackup ? 1 : 0) : 0)) * ROW_H + (archive ? SEP_H : 0); // 제목 줄이 없다
  const y = bottom + 4 + height > window.innerHeight ? top - 4 - height : bottom + 4;
  return (
    <EditMenu x={x} y={y} width={190} height={height} label={t("타임라인 정리")} trigger={trigger} onClose={onClose}>
      <button type="button" role="menuitemcheckbox" aria-checked={hideOff} autoFocus className={"ed-tmenu-item" + (hideOff ? " ed-here" : "")}
        title={fillKeys(t("비활성 폴더(빈 폴더·{key} 로 끈 폴더)를 타임라인에서 숨깁니다. 컷 이름을 누르고 {key} 를 누르면 그 폴더를 켜고 끕니다."),
          { key: hintOf("toggleOff") })} onClick={onHide}>
        {t("비활성 숨기기")}
        <i>{hideOff ? "✓ " : ""}{offCount || ""}</i>
      </button>
      <button type="button" role="menuitem" className="ed-tmenu-item" disabled={!fillCount}
        title={fillKeys(t("비어 있는 컷마다 생성물 하나를 넣습니다 — 최종 확인된 것이 먼저, 없으면 최신. 되돌리기({key}) 한 번에 돌아옵니다."),
          { key: hintOf("undo") })} onClick={onFill}>
        {t("빈 곳 채우기")}
        <i>{fillCount || ""}</i>
      </button>
      <button type="button" role="menuitem" className="ed-tmenu-item" disabled={!order.mine}
        title={order.mine ? t("컷 머리를 끌어 바꾼 폴더 순서를 이름순(폴더순)으로 되돌립니다 — 되돌리기 한 번에 돌아옵니다.")
          : t("타임라인의 폴더가 이름순(폴더순)입니다 — 컷 머리를 끌면 내 순서가 됩니다.")} onClick={order.onReset}>
        {t("배치 순서")}
        <i>{order.mine ? `${t("내 순서")} ↺` : t("폴더순")}</i>
      </button>
      {finalAll && (
        <button type="button" role="menuitem" className="ed-tmenu-item" disabled={!finalAll.count || finalAll.busy} aria-busy={finalAll.busy}
          title={t("타임라인에 있는 생성물을 모두 최종으로 확정합니다 — 켜진 컷의 켜진 클립만(숨긴 컷·꺼 둔 컷·꺼진 클립·꺼진 트랙은 뺍니다). 누르면 무엇이 바뀌는지 먼저 묻습니다.")}
          onClick={finalAll.onRun}>
          {t("타임라인 최종 확정")}
          <i>{finalAll.count || ""}</i>
        </button>
      )}
      {archive && <>
        <div className="ed-tmenu-sep" />
        <button type="button" role="menuitem" className="ed-tmenu-item" onClick={archive.onExport}>{t("편집 파일 보관")}</button>
        <button type="button" role="menuitem" className="ed-tmenu-item" disabled={!archive.canImport} onClick={archive.onImport}>{t("파일에서 편집 복원")}</button>
        {archive.onBackup && <button type="button" role="menuitem" className="ed-tmenu-item" onClick={archive.onBackup}>{t("DB 백업 보기·복원")}</button>}
      </>}
    </EditMenu>
  );
}

// 타임라인의 클립 우클릭(Jay 2026-10-08) — Resolve 보내기. 풀의 선택 막대에 있는 단추와 같은 길이다(앱의 보내기 줄).
//  count = 보낼 수 있는 생성물 수(공유 목록에서 찾은 것) — 없으면 흐리다. 여러 개면 옆에 수를 적는다.
export function EditClipMenu({
  x,
  y,
  title,
  count,
  busy,
  pendingCount,
  onSend,
  onTrim,
  final,
  onClose,
}: {
  x: number;
  y: number;
  title: string; // 'C0110 · V2' 또는 '클립 3개'
  count: number;
  busy: boolean; // 앱이 Resolve 작업을 처리하는 중 — 누르면 대기열에 더한다
  pendingCount: number;
  onSend: () => void;
  // 길이 조절 창을 연다(클립 하나를 눌렀을 때만 준다) — 휠 클릭과 같은 창. 휠 단추가 없는 마우스·트랙패드의 길이다.
  onTrim?: () => void;
  // 최종 선택(Jay 2026-10-13) — 이 클립들의 생성물에 최종을 줄 수 있을 때만 준다(안 주면 줄이 없다). checked = 줄 수 있는 것이
  //  전부 최종이다(누르면 해제) · count = 누르면 바뀌는 생성물 수(여러 개일 때만 적는다) · stale = 공유 목록을 다시 받는 중이거나
  //  받지 못했다(든 목록이 옛 것이라 흐리다 — 그 상태로 올리면 그사이 공유가 풀린 생성물을 다시 공유하게 된다)
  final?: { checked: boolean; count: number; stale: boolean; onToggle: () => void };
  onClose: () => void;
}) {
  const t = useT();
  return (
    <EditMenu x={x} y={y} width={190} height={HEAD_H + ROW_H * (1 + (onTrim ? 1 : 0) + (final ? 1 : 0))} label={t("클립 메뉴")} onClose={onClose}>
      <div className="ed-tmenu-head">{title}</div>
      <button type="button" role="menuitem" autoFocus className="ed-tmenu-item" disabled={!count} aria-busy={busy} onClick={onSend}
        title={busy
          ? t("Resolve 작업 {count}건 처리 중 · 선택 항목을 대기열에 추가").replace("{count}", String(pendingCount))
          : t("선택한 완료본을 프로젝트의 Render 폴더 구조로 저장하고 Resolve로 가져오기")}>
        {busy ? `${t("◆ Resolve에 추가")} (${pendingCount})` : t("◆ Resolve 보내기")}
        <i>{count > 1 ? count : ""}</i>
      </button>
      {onTrim && (
        <button type="button" role="menuitem" className="ed-tmenu-item" onClick={onTrim}>
          {"↔ " + t("길이 조절") /* 줄 앞 표시(Jay 2026-10-14) — 위의 ◆ 처럼 */}
          <i>{t("휠 클릭")}</i>
        </button>
      )}
      {final && (
        <button type="button" role="menuitemcheckbox" aria-checked={final.checked} className={"ed-tmenu-item" + (final.checked ? " ed-here" : "")}
          disabled={final.stale}
          title={final.stale ? t("공유 목록을 다시 받는 중이거나 받지 못했습니다 — 받은 뒤에 다시 눌러 주세요.")
            : final.checked ? t("최종 확정을 해제합니다(최종 전에 보류였던 것은 보류로, 나머지는 공유로 돌아갑니다).")
              : t("이 생성물을 최종으로 확정합니다 — 공유 & 리뷰의 최종(★)과 같은 것입니다.")}
          onClick={final.onToggle}>
          {"★ " + t("최종 선택")}
          <i>{final.checked ? "✓ " : ""}{final.count > 1 ? final.count : ""}</i>
        </button>
      )}
    </EditMenu>
  );
}

// 왼쪽 폴더 트리의 폴더 우클릭(Jay 2026-10-08) — 공유 & 리뷰 탭의 폴더 메뉴와 같은 것: 공유 저장 · 최종 저장, 이름 옆의
//  원본 위치 열기. 모양은 그 메뉴 그대로(folder-ctx-*)고, 껍데기만 편집 탭의 것이다(떠 있는 동안 뒤의 편집 키를 막는다).
// ponytail: 같은 줄이 ProjectSection 에도 있다 — 그 파일은 dev 에서 계속 바뀌는 중이라 여기서 뽑아내지 않았다(편집 탭이
//  dev 에 합쳐질 때 하나로). '모두 확인(+N)'은 넣지 않았다 — 편집 탭은 새 항목 확인을 다루지 않는다.
export function EditFolderMenu({
  x,
  y,
  name,
  path,
  depth,
  canOpen,
  onAct,
  onClose,
}: {
  x: number;
  y: number;
  name: string;
  path: string;
  depth: number; // 0 = 맨 위 폴더(하늘색), 그 아래는 라임 — 폴더 아이콘의 색
  canOpen: boolean; // 원본 위치 열기 — 이 PC 에서 접속했을 때만
  onAct: (kind: FolderMenuKind) => void;
  onClose: () => void;
}) {
  const t = useT();
  const kinds = folderMenuKinds("team");
  return (
    <EditMenu x={x} y={y} width={FOLDER_MENU_W} height={folderMenuHeight(kinds.length)} label={t("폴더 메뉴")} className="ed-fmenu"
      onClose={onClose}>
      <div className="folder-ctx-head">
        <div className="folder-ctx-name" title={path}>{name}</div>
        {canOpen && (
          <button type="button" className="folder-ctx-open" aria-label={t("원본 위치 열기")}
            title={t("원본 위치 열기 — 연결된 실제 폴더를 탐색기에서 엽니다")} onClick={() => onAct("open-folder")}>
            <span aria-hidden="true">📂</span>
          </button>
        )}
      </div>
      {kinds.map((kind, i) => (
        <button key={kind} type="button" role="menuitem" autoFocus={i === 0}
          className={"folder-ctx-btn tone-" + (kind === "save-finals" ? "final" : folderTone(depth))} onClick={() => onAct(kind)}>
          {t(folderMenuLabel(kind))}
        </button>
      ))}
    </EditMenu>
  );
}
