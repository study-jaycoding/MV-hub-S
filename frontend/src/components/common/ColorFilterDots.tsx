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
}: {
  colorDots: ColorDotDef[];
  activeColors: Set<string>;
  onToggleColor: (hex: string) => void;
  grayOn?: boolean;
  onToggleGray?: () => void;
  finalOnly?: boolean;
  onToggleFinal?: () => void;
}) {
  return (
    <>
      {onToggleGray && (
        <button
          className={"af-dot af-dot-gray" + (grayOn ? " on" : "")}
          title="비활성화(회색)된 카드만 숨기기 (다른 dot 과 반대)"
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
            title={`${k.toUpperCase()} 컬러만 보기`}
            onClick={() => onToggleColor(hex)}
          />
        );
      })}
    </>
  );
}
