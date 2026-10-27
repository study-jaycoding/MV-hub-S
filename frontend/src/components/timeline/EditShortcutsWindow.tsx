// 편집 탭 단축키 창 — 막대의 H 단추로 연다(Jay 2026-10-23, 모의 그림 _shots/mock_edit1023_shortcuts.png). 껍데기는 설정의 단축키 창(ShortcutsWindow)과 같다.
//  동작마다 칸 둘 — 칸을 누르면 그 칸에 다음 키(또는 Ctrl·Alt·Shift + 휠)를 받는다. 규칙·저장은 lib/editShortcuts, 계약은
//  docs/status/편집탭_단축키설정_설계_2026-10-23.md(설계 7). 창이 열린 동안 편집 키는 쉰다(useEscapeClose 의 겹 — lib/keyGate).
import { useEffect, useRef, useState } from "react";
import {
  actionDef, droppedOnLoad, EDIT_ACTIONS, EDIT_GROUPS, isCustom, isWheelSlot, keySlot, resetAction, resetAllEditShortcuts,
  setSlot, shiftShadows, slotsOf, slotText, useEditShortcutsVersion, wheelSlots,
  type EditActionId, type EditGroup, type SetResult, type Slot,
} from "../../lib/editShortcuts";
import { useT } from "../../lib/i18n";
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { CloseIcon } from "../common/ViewIcons";

const COLUMNS: EditGroup[][] = [["play", "edit"], ["mark", "view"]];
const WHEEL_REST_MS = 300; // 휠을 받은 뒤 이만큼 다음 휠이 없을 때까지 같은 몸짓을 먹는다(창·페이지가 스크롤되지 않게)

type Capture = { id: EditActionId; index: 0 | 1 };

export function EditShortcutsWindow({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEditShortcutsVersion(); // 다른 탭·창에서 바꾼 것도 열려 있는 이 창에 바로 보인다
  const [capturing, setCapturing] = useState<Capture | null>(null);
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");
  const capRef = useRef<Capture | null>(null);
  capRef.current = capturing;
  const labelOf = (id: EditActionId) => t(actionDef(id).label);

  const explain = (result: SetResult, slot: Slot): string => {
    if (result.ok) return "";
    const shown = slot ? `"${slotText(slot, true)}"` : "";
    if (result.reason === "conflict" && result.clash) return `${shown} ${t("은(는) 이미")} "${labelOf(result.clash)}"${t("에 사용 중입니다.")}`;
    if (result.reason === "reserved") {
      return result.reserved === "browser" ? `${shown} ${t("은(는) 브라우저가 가져가는 키라 지정할 수 없습니다.")}`
        : `${shown} ${t("은(는) 앱이 고정한 키라 지정할 수 없습니다(Esc · Tab · Enter).")}`;
    }
    if (result.reason === "same") return t("같은 동작의 다른 칸과 같은 입력입니다.");
    if (result.reason === "storage") return t("브라우저 저장 공간에 쓰지 못해 바꾸지 않았습니다.");
    if (result.reason === "input") return t("이 동작은 그 입력을 받지 않습니다.");
    return t("지정할 수 없는 입력입니다.");
  };
  // 받은 것을 그 칸에 — 안 되면 칸은 그대로 두고 까닭을 알린다(받기는 계속)
  const apply = (slot: string) => {
    const cap = capRef.current;
    if (!cap) return;
    const result = setSlot(cap.id, cap.index, slot);
    if (!result.ok) return setMsg(explain(result, slot));
    setCapturing(null);
    setMsg("");
  };

  // 받는 중의 키 — 창(캡처 단계)이 먼저 가로챈다. Esc 는 아래 useEscapeClose(받기 취소 → 다시 누르면 창 닫기). Backspace 도 보통 키로 받는다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const cap = capRef.current;
      if (!cap || event.key === "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const slot = keySlot(event);
      if (!slot) return; // 수식키만 눌렀다 — 계속 기다린다
      if (actionDef(cap.id).input === "wheel") return setMsg(t("이 동작은 휠로만 지정합니다 — Ctrl·Alt·Shift 중 하나를 누른 채 휠을 굴리세요."));
      apply(slot);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  // 받는 중의 휠 — 판정 전에 기본 동작을 막고 전파를 끊는다(창·페이지가 스크롤되거나 타임라인이 확대되지 않게). 칸을 정한 뒤에도
  //  같은 몸짓(관성 포함)은 마지막 휠 뒤 WHEEL_REST_MS 동안 다음 휠이 없을 때까지 먹는다.
  const restUntil = useRef(0);
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      const now = performance.now();
      const cap = capRef.current;
      if (!cap && now >= restUntil.current) return;
      event.preventDefault();
      event.stopPropagation();
      restUntil.current = now + WHEEL_REST_MS;
      if (!cap || actionDef(cap.id).input === "key" || !(event.deltaY || event.deltaX)) return; // 휠을 못 받는 동작 — 먹기만
      const slots = wheelSlots(event);
      if (!slots) return setMsg(t("Ctrl·Alt·Shift 중 하나를 누른 채 휠을 굴리세요(수식키 없는 휠은 지정할 수 없습니다)."));
      apply(cap.id === "scrollX" ? slots[1] : slots[0]); // 좌우 넘기기는 방향 없음(휠이 방향·크기를 준다)
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  });
  useEscapeClose(
    () => {
      if (capRef.current) {
        setCapturing(null);
        setMsg("");
      } else onClose();
    },
    true,
    true,
    true,
  );
  const floatRef = useRef<HTMLDivElement>(null);
  useModalFocus(floatRef);

  const reasons: Record<string, string> = {
    format: t("형식이 맞지 않아"), reserved: t("지정할 수 없는 키라"), input: t("그 동작이 받지 않는 입력이라"), conflict: t("다른 동작과 겹쳐"),
  };
  const notices = [
    ...droppedOnLoad().map((item) => `${t("저장돼 있던")} "${labelOf(item.id)}" ${t("의 지정은")} ${reasons[item.reason]}${item.clash ? ` ("${labelOf(item.clash)}")` : ""} ${t("기본값으로 돌렸습니다.")}`),
    ...shiftShadows().map((item) => `"${slotText(item.slot, true)}" ${t("은(는)")} "${labelOf(item.winner)}"${t("가 먼저 받습니다")} — "${labelOf(item.shadowed)}" ${t("의 Shift 변형 대신.")}`),
  ];
  const needle = query.trim().toLowerCase();
  const matches = (id: EditActionId) => !needle || labelOf(id).toLowerCase().includes(needle)
    || slotsOf(id).some((slot) => !!slot && slotText(slot, true).toLowerCase().includes(needle));

  const slotButton = (id: EditActionId, index: 0 | 1, slot: Slot) => {
    const active = capturing?.id === id && capturing.index === index;
    return (
      <span key={index} className={"ed-sc-slot" + (slot && isWheelSlot(slot) ? " ed-sc-wheel" : "") + (active ? " ed-sc-active" : "")}>
        <button type="button" className="ed-sc-pick" aria-pressed={active}
          title={active ? t("받는 중 — 키를 누르거나 Ctrl·Alt·Shift + 휠 (Esc 취소)") : t("눌러서 이 칸 바꾸기")}
          onClick={() => {
            setMsg("");
            setCapturing(active ? null : { id, index });
          }}>
          {active ? t("키를 누르세요…") : slot ? slotText(slot, true) : "＋"}
        </button>
        {slot && !active && (
          <button type="button" className="ed-sc-x" title={t("이 칸 비우기")} aria-label={t("이 칸 비우기")}
            onClick={() => {
              const result = setSlot(id, index, null);
              setMsg(explain(result, null));
            }}>×</button>
        )}
      </span>
    );
  };
  const row = (id: EditActionId) => {
    const slots = slotsOf(id);
    return (
      <div key={id} className={"sc-row" + (capturing?.id === id ? " capturing" : "")}>
        <span className="sc-label">{labelOf(id)}</span>
        <span className="ed-sc-keys">
          {slots[0] === null && slots[1] === null && capturing?.id !== id && <span className="ed-sc-none">{t("없음")}</span>}
          {slotButton(id, 0, slots[0])}
          {slotButton(id, 1, slots[1])}
        </span>
        <button className="sc-reset" disabled={!isCustom(id)} title={t("기본값으로")}
          onClick={() => {
            const result = resetAction(id);
            if (!result.ok && result.reason === "conflict" && result.clash) {
              return setMsg(`${t("기본값이 지금")} "${labelOf(result.clash)}"${t("에 쓰이고 있습니다 — 그쪽을 먼저 바꾸세요.")}`);
            }
            setMsg(explain(result, null));
          }}>↺</button>
      </div>
    );
  };
  const group = (key: EditGroup) => {
    const ids = EDIT_ACTIONS.filter((def) => def.group === key && matches(def.id)).map((def) => def.id);
    const escape = key === "edit" && (!needle || t("고르기 풀기 · 창 닫기").toLowerCase().includes(needle) || "esc".includes(needle)); // 영어 글은 대문자로 시작한다(Codex 묶음 검토 R4)
    if (!ids.length && !escape) return null;
    return (
      <div key={key} className="sc-list">
        <div className="sc-group">{t(EDIT_GROUPS[key])}</div>
        {ids.map(row)}
        {escape && (
          <div className="sc-row ed-sc-fixed">
            <span className="sc-label">{t("고르기 풀기 · 창 닫기")}</span>
            <span className="ed-sc-keys"><kbd className="sc-key">Esc</kbd></span>
            <span className="ed-sc-tag">{t("고정")}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="info-catcher sc-catcher" onMouseDown={onClose} />
      <div ref={floatRef} className="manage-float sc-float ed-sc-float" role="dialog" aria-label={t("편집 탭 단축키")}>
        <header className="admin-head">
          <span className="admin-title">⌨ {t("편집 탭 단축키")}</span>
          <button className="assets-x" onClick={onClose} title={t("닫기")}>
            <CloseIcon />
          </button>
        </header>
        <div className="admin-body">
          <p className="settings-hint">
            {t("칸을 누르고 새 키를 누르면 바뀝니다 — 확대·축소·트랙 높이·좌우는 Ctrl·Alt·Shift 를 누른 채 휠을 굴려도 됩니다. (Esc 취소 · × 비우기 · ↺ 기본값) · 이 브라우저의 내 설정이라 다른 사람에게는 영향이 없습니다.")}
          </p>
          <input className="ed-sc-find" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t("동작 이름이나 키로 찾기 — 예: 북마크, Alt")} aria-label={t("단축키 찾기")} />
          <div className="ed-sc-cols">
            {COLUMNS.map((groups, index) => <div key={index}>{groups.map(group)}</div>)}
          </div>
          {(msg || notices.length > 0) && <p className="manage-msg sc-warn" role="status">{msg || notices.join(" ")}</p>}
          <button
            className="settings-action"
            onClick={() => {
              resetAllEditShortcuts();
              setCapturing(null);
              setMsg("");
            }}
          >
            {t("전체 기본값 복원")}
          </button>
        </div>
      </div>
    </>
  );
}
