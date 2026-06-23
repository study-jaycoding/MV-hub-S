// 구성/합성 보드 (구성 탭).
// 내 에셋을 자유 캔버스에 모아 배치·크기조절·레이어링하는 작업 공간.
// 보드 레이아웃은 localStorage 에 저장돼 새로고침해도 유지된다(로컬 우선).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Generation } from "../types";

interface BoardItem {
  id: string;
  genId: string;
  src: string;
  type: "image" | "video";
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const LS_KEY = "content-hub-board";

function loadBoard(): BoardItem[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as BoardItem[]) : [];
  } catch {
    return [];
  }
}

interface DragState {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
}

export function CompositionBoard() {
  const [items, setItems] = useState<BoardItem[]>(loadBoard);
  const [sources, setSources] = useState<Generation[]>([]);
  const zCounter = useRef<number>(
    items.reduce((m, it) => Math.max(m, it.z), 0),
  );
  const drag = useRef<DragState | null>(null);

  // 내 완료 에셋(소스 트레이)
  useEffect(() => {
    api
      .listGenerations({ tab: "my" })
      .then((gs) => setSources(gs.filter((g) => g.assets.length > 0)))
      .catch(() => {});
  }, []);

  // 레이아웃 영속
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(items));
  }, [items]);

  const bringFront = (id: string) =>
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, z: ++zCounter.current } : it)),
    );

  const addFromGen = (g: Generation) => {
    const asset = g.assets[0];
    if (!asset) return;
    const src = asset.thumbnail_path || asset.file_path;
    const id = `${g.id}-${Date.now().toString(36)}`;
    // 캔버스 좌상단 근처에 약간씩 어긋나게 쌓기
    const offset = items.length % 8;
    setItems((prev) => [
      ...prev,
      {
        id,
        genId: g.id,
        src,
        type: asset.type,
        x: 40 + offset * 24,
        y: 40 + offset * 24,
        w: 220,
        h: 220,
        z: ++zCounter.current,
      },
    ]);
  };

  const removeItem = (id: string) =>
    setItems((prev) => prev.filter((it) => it.id !== id));

  const clearBoard = () => {
    if (items.length && window.confirm("보드를 비울까요?")) setItems([]);
  };

  // ── 드래그/리사이즈 (pointer events + window 리스너) ──
  const onPointerDown = (
    e: React.PointerEvent,
    it: BoardItem,
    mode: "move" | "resize",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    bringFront(it.id);
    drag.current = {
      id: it.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origX: it.x,
      origY: it.y,
      origW: it.w,
      origH: it.h,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== d.id) return it;
        if (d.mode === "move") {
          return { ...it, x: Math.max(0, d.origX + dx), y: Math.max(0, d.origY + dy) };
        }
        return {
          ...it,
          w: Math.max(60, d.origW + dx),
          h: Math.max(60, d.origH + dy),
        };
      }),
    );
  };

  const onPointerUp = () => {
    drag.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  return (
    <div className="compose">
      <aside className="compose-tray">
        <div className="tray-head">
          <h4>내 에셋</h4>
          <span className="muted">{sources.length}</span>
        </div>
        <div className="tray-grid">
          {sources.length === 0 && (
            <span className="muted">동기화/생성 후 에셋이 여기 표시됩니다.</span>
          )}
          {sources.map((g) => {
            const a = g.assets[0];
            const src = a.thumbnail_path || a.file_path;
            return (
              <button
                key={g.id}
                className="tray-item"
                title={g.prompt}
                onClick={() => addFromGen(g)}
              >
                {a.type === "video" ? (
                  <video src={a.file_path} muted preload="metadata" />
                ) : (
                  <img src={src} loading="lazy" alt={g.prompt} />
                )}
                <span className="tray-add">＋</span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="compose-main">
        <div className="compose-toolbar">
          <span>구성 보드 · {items.length}개 배치</span>
          <span className="spotlight-spacer" />
          <button onClick={clearBoard} disabled={!items.length}>
            보드 비우기
          </button>
        </div>
        <div className="compose-canvas">
          {items.length === 0 && (
            <div className="compose-empty">
              왼쪽 <b>내 에셋</b>에서 클릭해 보드에 추가하세요. <br />
              조각을 끌어 옮기고, 우하단 핸들로 크기를 조절합니다. <br />
              배치는 자동으로 저장됩니다.
            </div>
          )}
          {items.map((it) => (
            <div
              key={it.id}
              className="board-item"
              style={{
                left: it.x,
                top: it.y,
                width: it.w,
                height: it.h,
                zIndex: it.z,
              }}
              onPointerDown={(e) => onPointerDown(e, it, "move")}
            >
              {it.type === "video" ? (
                <video src={it.src} muted loop preload="metadata" />
              ) : (
                <img src={it.src} draggable={false} alt="" />
              )}
              <button
                className="board-remove"
                title="제거"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => removeItem(it.id)}
              >
                ✕
              </button>
              <span
                className="board-resize"
                onPointerDown={(e) => onPointerDown(e, it, "resize")}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
