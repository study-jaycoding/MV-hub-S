export function nearestCellIndex(
  grid: HTMLElement | null,
  cellSelector: string,
  currentIndex: number,
  key: string,
): number | null {
  if (!grid) return null;
  const cells = Array.from(grid.querySelectorAll(cellSelector)) as HTMLElement[];
  const curEl = cells.find((c) => Number(c.dataset.idx) === currentIndex);
  if (!curEl) return cells.length ? Number(cells[0].dataset.idx) : null;
  const cr = curEl.getBoundingClientRect();
  const cx = (cr.left + cr.right) / 2;
  const cy = (cr.top + cr.bottom) / 2;
  let best: number | null = null;
  let bestScore = Infinity;
  for (const el of cells) {
    const idx = Number(el.dataset.idx);
    if (idx === currentIndex) continue;
    const r = el.getBoundingClientRect();
    const x = (r.left + r.right) / 2;
    const y = (r.top + r.bottom) / 2;
    const dx = x - cx;
    const dy = y - cy;
    let ok = false;
    let primary = 0;
    let secondary = 0;
    if (key === "ArrowRight") {
      ok = dx > 1;
      primary = dx;
      secondary = Math.abs(dy);
    } else if (key === "ArrowLeft") {
      ok = dx < -1;
      primary = -dx;
      secondary = Math.abs(dy);
    } else if (key === "ArrowDown") {
      ok = dy > 1;
      primary = dy;
      secondary = Math.abs(dx);
    } else if (key === "ArrowUp") {
      ok = dy < -1;
      primary = -dy;
      secondary = Math.abs(dx);
    }
    if (!ok) continue;
    const score = primary + secondary * 2;
    if (score < bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  return best;
}
