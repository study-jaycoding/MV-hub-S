// INPUT 카드의 출력 고르기(Jay 2026-10-29) — 기본 목록칸 대신: 맨 위 검색칸 + OUTPUT 들을 받는 것의 종류별 무리(같은 길이 알약).
//  이 INPUT 이 생성 카드의 어느 칸에 이어져 있으면(lanes) 그 무리만 보인다. 맞지 않는 출력은 숨기고 숨긴 수를 알린다.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { InputPickGroup } from "../../../lib/sceneEdges";

export interface InputPickItem {
  id: string;
  name: string;
  group: InputPickGroup;
}

const GROUPS: { key: InputPickGroup; label: string }[] = [
  { key: "model", label: "모델" },
  { key: "ref", label: "레퍼런스" },
  { key: "text", label: "텍스트" },
  { key: "none", label: "입력 없음" }, // 받는 소스가 아직 없는 OUTPUT(Jay 10-29 이름 정함)
];

// 이름 속 맞는 글자를 밝게(대소문자 무시)
function highlight(name: string, needle: string): ReactNode {
  const at = needle ? name.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark>{name.slice(at, at + needle.length)}</mark>
      {name.slice(at + needle.length)}
    </>
  );
}

export function InputChannelPicker({
  items,
  value,
  lanes,
  onPick,
}: {
  items: InputPickItem[];
  value: string; // 지금 고른 OUTPUT id(없으면 "")
  lanes: ReadonlySet<InputPickGroup>; // 이어진 생성 카드 칸 — 비면 거르지 않음
  onPick: (outputId: string) => void; // "" = 선택 해제
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null); // 밝힌 줄 — 번호가 아니라 id(무리 순서로 다시 줄 세워도 그대로)
  const boxRef = useRef<HTMLDivElement>(null);
  // 펼친 동안 카드를 연결 끝 점 층(z 9) 위로 — 카드 셸은 보드 것이라 React 가 다시 그리지 않는 data 속성으로 올린다(scene.css)
  useEffect(() => {
    const cardEl = boxRef.current?.closest(".scene-card");
    if (!open || !cardEl) return;
    cardEl.setAttribute("data-pop-open", "");
    return () => cardEl.removeAttribute("data-pop-open");
  }, [open]);
  // 바깥을 누르면 닫는다(잡는 단계 — 보드가 그 누름을 먼저 써도 닫힘)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const allowed = lanes.size ? items.filter((it) => lanes.has(it.group)) : items;
  const needle = query.trim().toLowerCase();
  const groups = GROUPS.map((g) => {
    const inGroup = allowed.filter((it) => it.group === g.key);
    const groupHit = !!needle && g.label.toLowerCase().includes(needle); // 무리 이름을 쳐도 그 무리가 다 나온다
    const shown = !needle || groupHit ? inGroup : inGroup.filter((it) => it.name.toLowerCase().includes(needle));
    return { ...g, groupHit, shown };
  }).filter((g) => g.shown.length);
  const flat = groups.flatMap((g) => g.shown);
  const current = items.find((it) => it.id === value);
  const at = Math.max(0, flat.findIndex((it) => it.id === activeId)); // 없으면 맨 위

  const openList = () => {
    setQuery("");
    setActiveId(value || null);
    setOpen(true);
  };
  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
    setQuery("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // 친 글자·Esc 가 캔버스 단축키(선택 풀기 등)로 가지 않게
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActiveId(flat[(at + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[at]) pick(flat[at].id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else setOpen(false);
    }
  };

  const hidden = items.length - flat.length;
  const laneLabel = GROUPS.filter((g) => lanes.has(g.key)).map((g) => g.label).join("·");
  const foot = needle
    ? `${flat.length}개 · 숨김 ${hidden}개${flat[at] ? ` · Enter = ${flat[at].name} 고르기` : ""}`
    : lanes.size && hidden
      ? `${laneLabel} 칸에 이어져 있어 ${laneLabel}만 · 다른 ${hidden}개 숨김`
      : "";

  return (
    <div className="scene-portpick" ref={boxRef}>
      <button
        type="button"
        className="scene-portedit-sel scene-portpick-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <span className="scene-portpick-cur">{current ? current.name : "출력 선택…"}</span>
        <svg className="scene-portpick-chev" viewBox="0 0 24 24" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="scene-portpick-pop" role="listbox" aria-label="출력 선택">
          <label className="scene-portpick-search">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input
              autoFocus
              value={query}
              placeholder="출력 이름 검색…"
              aria-label="출력 이름 검색"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveId(null);
              }}
              onKeyDown={onKey}
            />
            {query && (
              <button type="button" className="scene-portpick-clear" aria-label="친 글 지우기" onClick={() => setQuery("")}>
                ✕
              </button>
            )}
          </label>
          {groups.map((g) => (
            <div key={g.key} className={"scene-portpick-group g-" + g.key}>
              <div className="scene-portpick-og">
                <span className={"scene-portpick-pill" + (g.groupHit ? " hit" : "")}>{g.label}</span>
              </div>
              {g.shown.map((it) => {
                return (
                  <div
                    key={it.id}
                    role="option"
                    aria-selected={it.id === value}
                    className={"scene-portpick-op" + (it === flat[at] ? " on" : "") + (it.id === value ? " cur" : "")}
                    onMouseEnter={() => setActiveId(it.id)}
                    onMouseDown={(e) => e.preventDefault()} // 검색칸 초점 유지
                    onClick={() => pick(it.id)}
                  >
                    {g.groupHit ? it.name : highlight(it.name, needle)}
                  </div>
                );
              })}
            </div>
          ))}
          {!flat.length && (
            <div className="scene-portpick-empty">
              {needle ? `"${query.trim()}" 에 맞는 출력이 없습니다` : "고를 출력이 없습니다"}
            </div>
          )}
          {foot && <div className="scene-portpick-foot">{foot}</div>}
          {value && (
            <button type="button" className="scene-portpick-unset" onMouseDown={(e) => e.preventDefault()} onClick={() => pick("")}>
              선택 해제
            </button>
          )}
        </div>
      )}
    </div>
  );
}
