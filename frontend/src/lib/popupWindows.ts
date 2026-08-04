export const EMBED_MODES = {
  assets: "assets",
  manage: "manage",
} as const;

type EmbedMode = (typeof EMBED_MODES)[keyof typeof EMBED_MODES];

const WINDOW_OPTIONS: Record<EmbedMode, { name: string; features: string }> = {
  assets: {
    name: "contenthub-assets",
    features: "popup=yes,width=1180,height=780,left=140,top=80",
  },
  manage: {
    name: "contenthub-manage",
    features: "popup=yes,width=1180,height=820,left=120,top=60",
  },
};

// 열어둔 창 참조를 기억 → 같은 버튼을 다시 누르면 그 창을 맨 앞으로 올린다(닫지 않음).
// 닫기는 창의 X 버튼으로. 사용자가 창을 직접 닫으면 .closed 가 true 라 다음 클릭에서 새로 연다.
const openWindows: Partial<Record<EmbedMode, Window | null>> = {};

export function openEmbedWindow(mode: EmbedMode): void {
  const existing = openWindows[mode];
  if (existing && !existing.closed) {
    try {
      existing.focus(); // 이미 떠 있으면 앞으로 가져와 바로 조작
    } catch {
      /* same-origin defensive guard */
    }
    return;
  }
  const url = `/?embed=${mode}&v=${Date.now()}`;
  const opts = WINDOW_OPTIONS[mode];
  const w = window.open(url, opts.name, opts.features);
  openWindows[mode] = w;
  try {
    if (w) {
      w.location.href = url;
      w.focus();
    }
  } catch {
    /* same-origin defensive guard */
  }
}
