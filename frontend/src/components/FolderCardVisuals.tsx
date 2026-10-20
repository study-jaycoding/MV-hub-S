import type { ButtonHTMLAttributes, ReactNode } from "react";

// 공유 카드와 Assets의 자료·클릭 동작은 달라도 표지와 작은 폴더의 표시 구조는 같다.
export function FolderCardCoverContent({ heading, name, summary, badge, children }: {
  heading: string;
  name: string;
  summary: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return <>
    {children}
    {heading && <span className="ep-num" aria-hidden="true">{heading}</span>}
    {badge}
    <span className="ep-cap">{name && <b title={name}>{name}</b>}<span title={summary}>{summary}</span></span>
  </>;
}

export function FolderCardPreview({ name, count, className = "", children, ...button }: {
  name?: string;
  count?: number;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" data-ep-action {...button} className={"ep-cut" + (className ? ` ${className}` : "")}>
    {children}
    {name != null && <span className="ep-cut-name">{name}</span>}
    {count != null && <span className="ep-cut-n">{count}</span>}
  </button>;
}
