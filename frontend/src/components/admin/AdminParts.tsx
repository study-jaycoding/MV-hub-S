// 관리자 창 공용 부품 — 탭 첫 줄·사람 표시·선 아이콘(Jay 2026-11-02 B안). 다섯 탭과 프로젝트 패널이 같은 모양을 쓴다.
import type { ReactNode } from "react";

const ICONS = {
  approve: <><circle cx="9" cy="8" r="3.5" /><path d="M3 20c.6-3.4 3-5.5 6-5.5 1.4 0 2.6.4 3.6 1.2" /><path d="m15 18 2 2 4-4.5" /></>,
  roles: <><circle cx="9" cy="8" r="3.5" /><path d="M2.8 20c.6-3.4 3.1-5.5 6.2-5.5s5.6 2.1 6.2 5.5" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.9c1.8.8 3 2.6 3.3 5.1" /></>,
  projects: <><path d="M12 3 3 8l9 5 9-5z" /><path d="m3 13 9 5 9-5" /></>,
  registry: <><path d="M8.5 6H20M8.5 12H20M8.5 18H20" /><path d="M4.2 6h.01M4.2 12h.01M4.2 18h.01" /></>,
  update: <><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4 19.5h16" /></>,
  key: <><circle cx="8" cy="15.5" r="4.5" /><path d="m11.3 12.2 8.2-8.2" /><path d="m16.5 7 3 3" /><path d="m13.8 9.7 2 2" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  folder: <path d="M3 6.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  pencil: <><path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.9z" /><path d="m14.5 6 3 3" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1.2" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" /><path d="M10 13h4" /></>,
  restore: <><rect x="3" y="4" width="18" height="5" rx="1.2" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" /><path d="M12 17v-4.5m-2.3 2.2 2.3-2.3 2.3 2.3" /></>,
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />,
};

// 격자·선 굵기는 머리줄 아이콘(TopIcon)과 같다.
export function AdminIcon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

// 모든 탭의 첫 줄 — 제목 · 한 줄 설명 · 오른쪽 주 동작.
export function AdminPageHead({ title, desc, children }: { title: string; desc: ReactNode; children?: ReactNode }) {
  return (
    <header className="admin-page">
      <div>
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>
      {children && <div className="admin-page-act">{children}</div>}
    </header>
  );
}

// 사람 한 줄 — 동그라미 · 이름 · 메일. 동그라미는 프로젝트 멤버 칸과 같은 모양이다.
export function AdminPerson({ name, sub, subTitle, mine = false }: { name: string; sub: string; subTitle?: string; mine?: boolean }) {
  return (
    <div className="admin-member">
      <span className={"project-member-avatar" + (mine ? " me" : "")}>{name.slice(0, 1).toUpperCase()}</span>
      <span className="admin-member-id">
        <span className="admin-mname">{name}</span>
        <span className="admin-muid" title={subTitle ?? sub}>{sub}</span>
      </span>
    </div>
  );
}
