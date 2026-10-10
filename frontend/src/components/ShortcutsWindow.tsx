// 단축키 변경 플로팅 창 — 설정창의 "단축키 변경" 버튼으로 열린다(설정창 위에 뜸).
// 지정된 단축키를 그룹별로 보여주고, 행의 '변경'으로 다음 키를 캡처해 재지정한다.
// 캡처는 window keydown 캡처 단계 + stopPropagation 으로 다른 단축키·설정창 Esc 보다 먼저 가로챈다.
import { APP_EVENTS } from "../lib/appEvents";
import { useCustomEvent } from "../lib/useCustomEvent";
import { useEscapeClose } from "../lib/useEscapeClose";
import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import {
  SHORTCUTS,
  getBinding,
  defaultBinding,
  setBinding,
  resetBinding,
  resetAll as resetAllShortcuts,
  conflictOf,
  isReservedBinding,
  eventToBinding,
  prettyBinding,
  type ShortcutId,
} from "../lib/shortcuts";
import { CloseIcon } from "./common/ViewIcons";

export function ShortcutsWindow({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [, setTick] = useState(0);
  const rerender = () => setTick((x) => x + 1);
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const [msg, setMsg] = useState("");
  const capRef = useRef<ShortcutId | null>(null);
  capRef.current = capturing;
  useCustomEvent(APP_EVENTS.shortcutsChanged, rerender); // 다른 탭·창에서 바꾼 것도 열려 있는 이 창에 바로 보인다

  // 단일 캡처 단계 리스너: 캡처 중이면 다음 키를 그 항목에 재지정(Esc=취소), 아니면 Esc=창 닫기.
  // stopPropagation 으로 전역 단축키·설정창 Esc 가 함께 발동하지 않게 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cap = capRef.current;
      if (cap) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return; // 취소는 아래 useEscapeClose 가 한다
        const b = eventToBinding(e);
        if (!b) return; // 수식키만 눌림 — 계속 대기
        if (b === "process") {
          setMsg("한글 입력 상태에서는 키를 읽을 수 없습니다 — 영문으로 바꾸고 다시 누르세요.");
          return;
        }
        if (isReservedBinding(b)) {
          setMsg(`"${prettyBinding(b)}" 은(는) 이미 쓰이는 고정 키라 지정할 수 없습니다.`);
          return;
        }
        const clash = conflictOf(b, cap);
        if (clash) {
          const name = SHORTCUTS.find((s) => s.id === clash)?.label ?? clash;
          setMsg(`"${prettyBinding(b)}" 은(는) 이미 "${name}"에 사용 중입니다.`);
          return;
        }
        setBinding(cap, b);
        setCapturing(null);
        setMsg("");
        rerender();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Esc: 캡처 중이면 캡처만 취소, 아니면 이 창만 닫는다 — 설정 창·옆 패널보다 위 겹이다(lib/useEscapeClose).
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

  return (
    <>
      <div className="info-catcher sc-catcher" onMouseDown={onClose} />
      <div className="manage-float sc-float" role="dialog" aria-label={t("단축키")}>
        <header className="admin-head">
          <span className="admin-title">⌨ {t("단축키")}</span>
          <button className="assets-x" onClick={onClose} title={t("닫기")}>
            <CloseIcon />
          </button>
        </header>
        <div className="admin-body">
          <p className="settings-hint">
            각 행의 <b>변경</b>을 누르고 새 키를 누르면 재지정됩니다. (Esc로 취소 · ↺ 기본값)
          </p>
          <div className="sc-list">
            {SHORTCUTS.map((s, i) => {
              const cur = getBinding(s.id);
              const custom = cur !== defaultBinding(s.id);
              const newGroup = i === 0 || SHORTCUTS[i - 1].group !== s.group;
              return (
                <div key={s.id}>
                  {newGroup && <div className="sc-group">{s.group}</div>}
                  <div className={"sc-row" + (capturing === s.id ? " capturing" : "")}>
                    <span className="sc-label">{s.label}</span>
                    <kbd className="sc-key">
                      {capturing === s.id ? "키를 누르세요…" : prettyBinding(cur)}
                    </kbd>
                    <button
                      className="sc-edit"
                      onClick={() => {
                        setMsg("");
                        setCapturing((c) => (c === s.id ? null : s.id));
                      }}
                    >
                      {capturing === s.id ? "취소" : "변경"}
                    </button>
                    <button
                      className="sc-reset"
                      disabled={!custom}
                      title="기본값으로"
                      onClick={() => {
                        // 기본값을 그사이 다른 단축키가 쓰고 있으면 되돌리지 않는다 — 두 동작이 한 키에 걸린다.
                        const clash = conflictOf(defaultBinding(s.id), s.id);
                        if (clash) {
                          const name = SHORTCUTS.find((x) => x.id === clash)?.label ?? clash;
                          setMsg(`기본값 "${prettyBinding(defaultBinding(s.id))}" 은(는) 지금 "${name}"에 쓰이고 있습니다 — 그쪽을 먼저 바꾸세요.`);
                          return;
                        }
                        setMsg("");
                        resetBinding(s.id);
                        rerender();
                      }}
                    >
                      ↺
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {msg && <p className="manage-msg sc-warn">{msg}</p>}
          <button
            className="settings-action"
            onClick={() => {
              resetAllShortcuts();
              rerender();
            }}
          >
            {t("전체 기본값 복원")}
          </button>
        </div>
      </div>
    </>
  );
}
