// 앱 확인 창 — 브라우저 기본 확인창 대신('MV Hub 종료'와 같은 모양, Jay 2026-10-22 B안). 캔버스 씬 삭제(SceneBar)·라이브러리 실패·차단 정리(LibraryToolbar)가
//  같이 쓴다. 확인 단추에 초점 — Enter 가 확인을 누른다(window.confirm 의 확인 자리). Esc = 취소.
//  창 밖 누름은 투명한 막이 받아 취소로 닫는다 — 막이 없으면 뒤의 단추가 눌리고 초점이 그리로 옮겨 Enter 가 그것을 눌렀다(Codex R2).
import type { ReactNode } from "react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";

export function HostConfirm({ label, title, confirmLabel, cancelLabel = "취소", children, onConfirm, onCancel }: {
  label: string; // 보조 기술이 읽는 창 이름
  title: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  children: ReactNode; // 본문(묻는 말)
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEscapeClose(onCancel); // 떠 있는 동안 뒤 화면의 단축키도 쉰다
  const boxRef = useRef<HTMLDivElement>(null);
  useModalFocus(boxRef);
  return createPortal(
    <>
      <div
        className="scene-del-catcher"
        onMouseDown={(event) => {
          event.preventDefault(); // 초점을 옮기지 않는다
          onCancel();
        }}
      />
      <div ref={boxRef} className="manage-float host-exit-confirm" role="alertdialog" aria-modal="true" aria-label={label}>
        <header className="admin-head">
          <span className="admin-title">{title}</span>
        </header>
        <div className="admin-body">
          <p className="host-exit-text">{children}</p>
          <div className="host-exit-actions">
            <button type="button" className="settings-action danger" autoFocus onClick={onConfirm}>
              {confirmLabel}
            </button>
            <button type="button" className="settings-action ghost" onClick={onCancel}>
              {cancelLabel}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
