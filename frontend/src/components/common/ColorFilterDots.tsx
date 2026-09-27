export interface ColorDotDef {
  k: string;
  hex: string;
}

export const ASSET_COLOR_DOTS: ColorDotDef[] = [
  { k: "r", hex: "#ff453a" },
  { k: "g", hex: "#34c759" },
  { k: "b", hex: "#0a84ff" },
];

export const ASSET_COLOR_BY_KEY: Record<string, string> = Object.fromEntries(
  ASSET_COLOR_DOTS.map(({ k, hex }) => [k, hex]),
);

export function ColorFilterDots({
  colorDots,
  activeColors,
  onToggleColor,
  grayOn,
  onToggleGray,
  finalOnly,
  onToggleFinal,
  apply,
  disabled,
}: {
  colorDots: ColorDotDef[];
  activeColors: Set<string>;
  onToggleColor: (hex: string) => void;
  grayOn?: boolean;
  onToggleGray?: () => void;
  finalOnly?: boolean;
  onToggleFinal?: () => void;
  // 같은 점을 '고른 카드에 입히는' 단추로도 쓴다(Resolve 프로젝트 카드) — 모양·동작은 같고 설명 글만 다르다.
  apply?: boolean;
  disabled?: boolean; // 고른 카드가 없을 때
}) {
  return (
    <>
      {onToggleGray && (
        <button
          className={"af-dot af-dot-gray" + (grayOn ? " on" : "")}
          disabled={disabled}
          title={apply ? "고른 카드 비활성(회색) — 단축키 d" : "비활성화(회색)된 카드만 숨기기 (다른 dot 과 반대)"}
          onClick={onToggleGray}
        />
      )}
      {onToggleFinal && (
        <button
          className={"af-dot af-dot-gold" + (finalOnly ? " on" : "")}
          title="최종(골드)으로 지정된 것만 보기"
          onClick={onToggleFinal}
        />
      )}
      {colorDots.map(({ k, hex }) => {
        const on = activeColors.has(hex);
        return (
          <button
            key={k}
            className={"af-dot" + (on ? " on" : "")}
            style={{
              background: hex,
              filter: on ? "brightness(1.2) saturate(1.25)" : "brightness(0.45) saturate(0.7)",
              opacity: on ? 1 : 0.85,
              borderColor: on ? "#fff" : "rgba(0,0,0,0.4)",
              boxShadow: on ? `0 0 0 2px ${hex}, 0 0 11px ${hex}` : "none",
            }}
            disabled={disabled}
            title={apply ? `고른 카드에 ${k.toUpperCase()} 컬러 — 단축키 ${k}` : `${k.toUpperCase()} 컬러만 보기`}
            onClick={() => onToggleColor(hex)}
          />
        );
      })}
    </>
  );
}
