// 캔버스 노드 설명 창(Jay 2026-10-30 B안) — 노드(.scene-card) 안 요소의 설명(title)을 브라우저 기본 말풍선 대신 앱 모양 창으로 그린다.
//  설명 글이 곧 구조다: 첫 줄 = 제목(" — " 뒤는 설명, “ 로 시작하면 나누지 않음) · 상태 색(data-tip-tone)이 있으면 그 줄이 상태 ·
//  "해결: …" = 해결 딱지 · "키 = 뜻 · 키 = 뜻" = 조작 키 · "라벨: 값" = 표 줄 · 나머지 = 흐린 덧말. 같은 글은 기본 말풍선에서도 줄로 읽힌다.
//  title 은 올려 둔 동안만 떼어(기본 말풍선이 겹치지 않게) 벗어나면 되돌린다 — 화면 읽기·시험은 같은 글을 본다.
//  씬 탭도 같은 창을 쓴다(Jay 2026-11-02, SceneBar) — within 으로 범위를 바꾸고, data-tip-head(이름)·data-tip-ws-*(워크스페이스 표식)를 읽고, actions 로 누를 단추를 넣는다.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { WorkspaceMark } from "../common/WorkspaceMark";

export type NodeTipTone = "bad" | "warn";
export interface NodeTipView {
  head?: string;
  status?: string;
  detail: string[];
  fix?: string;
  notes: string[];
  rows: [string, string][];
  keys: [string, string][];
}

const KEY = /^(.+?) = (.+)$/;
const ROW = /^([^:]{1,24}): (.+)$/;

// head = 첫 줄이 사람이 지은 이름이라 규칙으로 나누면 안 될 때(씬 탭 'A: B') — 첫 줄 대신 그대로 제목으로 쓴다
export function parseNodeTip(text: string, tone?: string, head?: string): NodeTipView {
  const v: NodeTipView = { detail: [], notes: [], rows: [], keys: [] };
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    if (i === 0 && head !== undefined) {
      v.head = head;
      return;
    }
    const segs = line.split(" · ");
    if (segs.every((s) => KEY.test(s))) {
      for (const s of segs) {
        const m = s.match(KEY)!;
        v.keys.push([m[1], m[2]]);
      }
      return;
    }
    const fix = line.match(/^해결(?: 방법)?\s*:\s*(.+)$/);
    if (fix) {
      v.fix = fix[1];
      return;
    }
    const quoted = line.startsWith("“");
    const colon = quoted ? null : line.match(ROW);
    const [first, ...rest] = quoted ? [line] : line.split(" — ");
    // 색이 있을 때 상태 줄 = 둘째 줄부터의 첫 줄, 또는 첫 줄이 '문제: 설명'이거나 바로 뒤가 '라벨: 값' 줄들일 때(생성 실패 — 이름 없이 상태부터)
    const statusFirst = i === 0 && !quoted && ROW.test(lines[1] ?? "");
    if (tone && v.status === undefined && (i > 0 || colon || statusFirst)) {
      v.status = colon && i === 0 ? colon[1] : first;
      const more = colon && i === 0 ? colon[2] : rest.join(" — ");
      if (more) v.detail.push(more);
    } else if (i === 0 && !colon) {
      v.head = first;
      if (rest.length) v.detail.push(rest.join(" — "));
    } else if (colon) {
      v.rows.push([colon[1], colon[2]]);
    } else {
      v.notes.push(line);
    }
  });
  return v;
}

interface Shown {
  view: NodeTipView;
  tone?: string;
  ws?: { id: string; label: string; missing: boolean };
  x: number;
  y: number;
  anchor?: DOMRect; // 누를 수 있는 창 — 포인터를 따라가면 못 누르므로 이 자리 밑에 붙는다
  extra?: ReactNode;
}

function TipBox({ view, tone, ws, x, y, anchor, extra, className, boxRef, onEnter, onLeave }: Shown & {
  className?: string;
  boxRef: RefObject<HTMLDivElement>;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const [pos, setPos] = useState({ left: x + 14, top: y + 18 });
  // 화면 끝에 걸리면 포인터 반대편으로 — 그린 뒤 크기를 재서 정한다
  useLayoutEffect(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    if (anchor) {
      setPos({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 8 - r.width)), top: anchor.bottom + 6 });
      return;
    }
    let left = x + 14;
    let top = y + 18;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, x - 14 - r.width);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - 12 - r.height);
    setPos({ left, top });
  }, [x, y, anchor, boxRef]);
  return (
    <div
      ref={boxRef}
      className={"node-tip" + (className ? " " + className : "") + (tone ? " tone-" + tone : "")}
      role={extra ? undefined : "tooltip"}
      style={pos}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {ws ? (
        <div className="node-tip-headline">
          <div className="node-tip-head">{view.head}</div>
          <span className={"node-tip-ws" + (ws.missing ? " missing" : "")}>
            <WorkspaceMark label={ws.label} id={ws.id} className={"sm" + (ws.missing ? " missing" : "")} />
            {ws.label}
          </span>
        </div>
      ) : (
        view.head && <div className="node-tip-head">{view.head}</div>
      )}
      {view.status && (
        <div className="node-tip-status">
          <i />
          {view.status}
        </div>
      )}
      {view.detail.map((d, i) => (
        <div className="node-tip-detail" key={"d" + i}>
          {d}
        </div>
      ))}
      {view.fix && (
        <div className="node-tip-fix">
          <b>해결</b>
          <span>{view.fix}</span>
        </div>
      )}
      {view.notes.map((n, i) => (
        <div className="node-tip-note" key={"n" + i}>
          {n}
        </div>
      ))}
      {view.rows.length > 0 && (
        <div className="node-tip-rows">
          {view.rows.map(([k, val], i) => (
            <Fragment key={"r" + i}>
              <span>{k}</span>
              <span>{val}</span>
            </Fragment>
          ))}
        </div>
      )}
      {view.keys.length > 0 && (
        <div className="node-tip-keys">
          {view.keys.map(([k, val], i) => (
            <span key={"k" + i}>
              <kbd>{k}</kbd>
              {val}
            </span>
          ))}
        </div>
      )}
      {extra && <div className="node-tip-actions">{extra}</div>}
    </div>
  );
}

export function NodeTip({
  rootRef,
  within = ".scene-card",
  className,
  actions,
}: {
  rootRef: RefObject<HTMLElement | null>;
  within?: string; // 이 요소 안의 title 만 창으로 그린다
  className?: string;
  actions?: (el: HTMLElement, close: () => void) => ReactNode; // 있으면 창을 요소 밑에 붙이고 마우스가 창으로 옮겨 가도 닫지 않는다(씬 탭의 단추)
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const hold = useRef({ stay: () => {}, leave: () => {} });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let host: HTMLElement | null = null;
    let text = "";
    let timer = 0;
    let leaving = 0;
    let at = { x: 0, y: 0 };
    const stay = () => window.clearTimeout(leaving);
    const close = () => {
      window.clearTimeout(timer);
      stay();
      // 떼어 둔 글을 되돌린다 — 그 사이 화면이 새 글을 붙였으면 그것을 둔다
      if (host && !host.hasAttribute("title")) host.setAttribute("title", text);
      host = null;
      setShown(null);
    };
    const leave = () => {
      stay();
      leaving = window.setTimeout(close, 180); // 요소와 창 사이의 틈을 건너는 동안은 닫지 않는다
    };
    hold.current = { stay, leave };
    const over = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || e.buttons) return; // 끄는 중에는 띄우지 않는다
      if (host && host.contains(target)) return stay(); // 같은 요소 안에서 움직임
      const el = target.closest?.<HTMLElement>("[title]");
      if (!el || !root.contains(el) || !el.closest(within)) return;
      close();
      const t = el.getAttribute("title") || "";
      if (!t.trim()) return;
      host = el;
      text = t;
      el.removeAttribute("title"); // 기본 말풍선이 같이 뜨지 않게
      at = { x: e.clientX, y: e.clientY };
      const { tipTone: tone, tipHead, tipWsId, tipWsLabel, tipWsMissing } = el.dataset;
      const ws = tipWsId ? { id: tipWsId, label: tipWsLabel || tipWsId, missing: tipWsMissing !== undefined } : undefined;
      timer = window.setTimeout(() => {
        const view = parseNodeTip(t, tone, tipHead);
        if (ws) view.rows = []; // 표식이 '워크스페이스: 이름' 줄을 대신한다
        const extra = actionsRef.current?.(el, close);
        setShown({ view, tone, ws, x: at.x, y: at.y, extra, anchor: actionsRef.current ? el.getBoundingClientRect() : undefined });
      }, 400);
    };
    const move = (e: MouseEvent) => {
      if (host) at = { x: e.clientX, y: e.clientY };
    };
    const out = (e: MouseEvent) => {
      if (!host || (e.relatedTarget instanceof Node && host.contains(e.relatedTarget))) return;
      if (actionsRef.current && boxRef.current) leave();
      else close();
    };
    const down = (e: MouseEvent) => {
      if (!(e.target instanceof Node && boxRef.current?.contains(e.target))) close(); // 창 안의 단추는 누를 수 있어야 한다
    };
    root.addEventListener("mouseover", over);
    root.addEventListener("mousemove", move);
    root.addEventListener("mouseout", out);
    window.addEventListener("mousedown", down, true);
    window.addEventListener("wheel", close, { capture: true, passive: true });
    window.addEventListener("keydown", close, true);
    return () => {
      root.removeEventListener("mouseover", over);
      root.removeEventListener("mousemove", move);
      root.removeEventListener("mouseout", out);
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("keydown", close, true);
      close();
    };
  }, [rootRef, within]);
  return shown
    ? createPortal(
        <TipBox {...shown} className={className} boxRef={boxRef} onEnter={() => hold.current.stay()} onLeave={() => hold.current.leave()} />,
        document.body,
      )
    : null;
}
