// 편집 탭의 우클릭 메뉴들(Jay 2026-10-08) — 껍데기(EditMenu) 하나를 같이 쓴다. 껍데기는 자리·바깥 누르기·키 차단만 맡는다.
//  · EditTrackMenu — 카드 휠 클릭(2026-10-13 부터 — 그 전에는 우클릭): 지금 타임라인에 있는 트랙(V3·V2·V1)을 보여 주고,
//    고르면 그 트랙에 넣는다(찬 트랙은 교체).
//  · EditTrackHeadMenu — 트랙 머리 우클릭: 트랙 추가·위/아래로·삭제·빈 트랙 삭제·색(다빈치의 트랙 머리 메뉴).
//  · EditListMenu — 막대의 목록 단추: 비활성 숨기기(켜고 끄기) · 빈 곳 채우기(한 번 실행).
//  · EditClipMenu — 타임라인의 클립 우클릭: Resolve 보내기.
//  · EditFolderMenu — 왼쪽 폴더 트리의 폴더 우클릭: 공유 저장 · 최종 저장 · 원본 위치 열기(공유 & 리뷰 탭의 폴더 메뉴와 같다).
//  · 북마크 편집 창(EditMarkerMenu.tsx)도 이 껍데기를 쓴다.
//  편집 탭이 연 폴더 창의 카드도 쓴다 — 창이 떠 있는 동안 .body 는 inert 라 body 로 옮겨 그린다. 틀·바깥 누르기는 폴더
//  우클릭 메뉴(ProjectSection)와 같다.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  clampMenuPosition, FOLDER_MENU_W, folderMenuHeight, folderMenuKinds, folderMenuLabel, folderTone, type FolderMenuKind,
} from "../../lib/folderContextMenu";
import { useT } from "../../lib/i18n";
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

// 막대의 목록 단추(Jay 2026-10-08) — 비활성 숨기기는 켜고 끄는 것(옆 숫자 = 비활성 폴더 수), 빈 곳 채우기는 한 번 실행하는
//  것(옆 숫자 = 채울 수 있는 빈 컷 수 — 없으면 흐리다). 아래에 자리가 모자라면 단추 위로 뜬다.
export function EditListMenu({
  x,
  top,
  bottom,
  hideOff,
  offCount,
  fillCount,
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
  trigger: RefObject<HTMLElement>; // 목록 단추 — 다시 누르면 그 단추가 닫는다(EditMenu)
  onHide: () => void;
  onFill: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const height = HEAD_H - 22 + 2 * ROW_H; // 제목 줄이 없다
  const y = bottom + 4 + height > window.innerHeight ? top - 4 - height : bottom + 4;
  return (
    <EditMenu x={x} y={y} width={190} height={height} label={t("타임라인 정리")} trigger={trigger} onClose={onClose}>
      <button type="button" role="menuitemcheckbox" aria-checked={hideOff} autoFocus className={"ed-tmenu-item" + (hideOff ? " ed-here" : "")}
        title={t("비활성 폴더(빈 폴더·D 로 끈 폴더)를 타임라인에서 숨깁니다. 컷 이름을 누르고 D 를 누르면 그 폴더를 켜고 끕니다.")} onClick={onHide}>
        {t("비활성 숨기기")}
        <i>{hideOff ? "✓ " : ""}{offCount || ""}</i>
      </button>
      <button type="button" role="menuitem" className="ed-tmenu-item" disabled={!fillCount}
        title={t("비어 있는 컷마다 생성물 하나를 넣습니다 — 최종 확인된 것이 먼저, 없으면 최신. 되돌리기(Ctrl+Z) 한 번에 돌아옵니다.")} onClick={onFill}>
        {t("빈 곳 채우기")}
        <i>{fillCount || ""}</i>
      </button>
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
  onClose: () => void;
}) {
  const t = useT();
  return (
    <EditMenu x={x} y={y} width={190} height={HEAD_H + ROW_H * (onTrim ? 2 : 1)} label={t("클립 메뉴")} onClose={onClose}>
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
          {t("길이 조절")}
          <i>{t("휠 클릭")}</i>
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
