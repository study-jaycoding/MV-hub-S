import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import type { SeedanceImageTokenKind } from "../../lib/seedancePrompt";

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
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
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
