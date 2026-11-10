// GPU 보기 모드의 덧판 — 마우스 올린 카드 한 장을 DOM(카드 컴포넌트의 읽기 형태)으로 그 자리에 띄운다
//  (docs/status/캔버스_GPU판설계_2026-11-11.md 계약 overlay). 카메라 층(.scene-canvas) 안이라 줌·이동을 그대로 따른다.
//  안에 초점이 있으면 붙잡아 둔다(onPinChange) — 마우스가 떠나도 내려가지 않고, 다른 카드에 새 덧판도 안 띄운다.
//  속(children)은 SceneBoard 가 넘기는 카드 컴포넌트의 mode:"read" 갈래다 — 변경 콜백이 없다.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ReactNode } from "react";

export interface GpuOverlayCardProps {
  x: number;
  y: number;
  w: number;
  h: number;
  /** .scene-card 뒤에 붙는 종류 클래스(scene-card-ref·has-node 등 — DOM 카드 틀과 같은 모습) */
  className: string;
  onPinChange: (pinned: boolean) => void;
  children: ReactNode;
}

export const GpuOverlayCard = forwardRef<HTMLDivElement | null, GpuOverlayCardProps>(function GpuOverlayCard(props, ref) {
  const el = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => el.current!, []);
  const pinRef = useRef(props.onPinChange);
  pinRef.current = props.onPinChange;
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onIn = () => pinRef.current(true);
    const onOut = (e: FocusEvent) => {
      if (!node.contains(e.relatedTarget as Node | null)) pinRef.current(false);
    };
    node.addEventListener("focusin", onIn);
    node.addEventListener("focusout", onOut);
    return () => {
      node.removeEventListener("focusin", onIn);
      node.removeEventListener("focusout", onOut);
      pinRef.current(false);
    };
  }, []);
  return (
    <div
      ref={el}
      className={"scene-card scene-gpu-overlay " + props.className}
      data-gpu-overlay=""
      style={{ left: props.x, top: props.y, width: props.w, height: props.h }}
    >
      {props.children}
    </div>
  );
});
