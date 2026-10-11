import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import type { SeedanceImageTokenKind } from "../../lib/seedancePrompt";
import { useEscapeClose } from "../../lib/useEscapeClose";

interface Props {
  x: number;
  y: number;
  enabled: boolean;
  onChoose: (role: SeedanceImageTokenKind) => void;
  onClose: () => void;
}

export function SpotlightRefRoleMenu({ x, y, enabled, onChoose, onClose }: Props) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  // Esc 는 맨 위 겹으로 닫는다(lib/useEscapeClose) — 겹이어야 떠 있는 동안 뒤 화면의 키가 쉰다. 전엔 document 에 직접 걸어, 메뉴가 뜬 채
  //  Ctrl+K 를 누르면 메뉴 뒤에서 프롬프트가 숨었다(2026-10-11 Codex 통합 검토).
  useEscapeClose(onClose, true, true, true);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  // body 포털: 트레이 overflow/도크 backdrop-filter에 잘리지 않고 화면 좌표로 배치한다.
  return createPortal(
    <div ref={menuRef} className="sl-dropdown sl-ref-role-menu" role="menu" aria-label={t("레퍼런스 역할")}
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 224)), top: Math.max(8, Math.min(y, window.innerHeight - 142)) }}
      onMouseDown={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()}>
      {([["start", "첫 프레임"], ["end", "끝 프레임"], ["image", "옴니 레퍼런스"]] as const).map(([role, label]) => (
        <button key={role} type="button" role="menuitem" className="sl-dd-item" disabled={!enabled}
          title={enabled ? undefined : t("레퍼런스 모드에서만 지정할 수 있습니다.")}
          onClick={() => onChoose(role)}>{t(label)}</button>
      ))}
    </div>, document.body,
  );
}
