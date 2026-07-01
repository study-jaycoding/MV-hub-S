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

export function openEmbedWindow(mode: EmbedMode): void {
  const url = `/?embed=${mode}&v=${Date.now()}`;
  const opts = WINDOW_OPTIONS[mode];
  const w = window.open(url, opts.name, opts.features);
  try {
    if (w) {
      w.location.href = url;
      w.focus();
    }
  } catch {
    /* same-origin defensive guard */
  }
}
