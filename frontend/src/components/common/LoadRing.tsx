// 원본 받는 중 — 크고 얇은 링, 글자는 링 안(Jay 2026-11-09 시안 A2). 수정 창·크게 보기가 흐린 썸네일 위 가운데에 띄운다.
//  pct 를 알면 채워지는 링 + % · sub(받은 양), 모르면 도는 호 + label. 자리(가운데)는 부모가 position 을 가진 칸 — CSS .load-ring
const SIZE = 92;
const STROKE = 3;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

export function LoadRing({ pct, label, sub }: { pct: number | null; label: string; sub?: string }) {
  const known = pct != null && Number.isFinite(pct);
  const value = known ? Math.min(1, Math.max(0, pct)) : 0;
  return (
    <div className="load-ring" role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(value * 100) : undefined}>
      <svg className={known ? undefined : "spin"} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className="load-ring-track" cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" strokeWidth={STROKE} />
        <circle className="load-ring-bar" cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" strokeWidth={STROKE} strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={known ? C * (1 - value) : C * 0.72} transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`} />
      </svg>
      <div className="load-ring-in">
        {known ? <b>{Math.round(value * 100)}%</b> : <b className="word">{label}</b>}
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}
