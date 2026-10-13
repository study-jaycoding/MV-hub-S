// Resolve 보내기 결과 가운데 확인이 필요한 것(부분 성공·실패·결과 불명) — 알림(.toast) 바로 아래에 ✕ 로 닫을 때까지 남는다
// (Jay 2026-10-14 · Codex 배포 전 검토 E4). 알림은 한 칸이고 2.5초라, 줄 서 있던 다음 작업의 글이 앞의 결과를 덮었다.
// 무엇을 남길지는 lib/useResolveTransferActions 가 정한다(세 줄까지 — 넘으면 오래된 것부터 빠진다). 여기는 그리기만 한다.
//  · 떠 있는 채 뒤 화면을 쓴다 — Esc 겹·키 주인으로 올리지 않는다(뒤 화면의 단축키·Esc 는 그대로다). 닫는 길은 ✕ 뿐이다.
//  · ✕ 를 마우스로 눌러도 초점을 가져가지 않는다 — 가져가면 줄이 사라지면서 초점이 BODY 로 떨어진다. 키보드(Tab)로 닫았으면
//    남은 줄의 ✕ 로 초점을 옮긴다(없으면 둔다).
import { useRef } from "react";
import { useT } from "../../lib/i18n";
import type { ResolveNotice } from "../../lib/useResolveTransferActions";

// 첫 마디(— 나 · 앞)를 굵게 — 무슨 일인지가 먼저 읽히게
function parts(text: string): [string, string] {
  const cut = text.search(/ — | · /);
  return cut < 0 ? [text, ""] : [text.slice(0, cut), text.slice(cut)];
}

export function ResolveNotices({ items, onDismiss }: { items: readonly ResolveNotice[]; onDismiss: (id: number) => void }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  if (!items.length) return null;
  return (
    <div className="resolve-notices" ref={boxRef} role="status" aria-live="polite" aria-label={t("Resolve 보내기 결과")}>
      {items.map((item) => {
        const [head, rest] = parts(item.text);
        return (
          <div className="resolve-notice" key={item.id}>
            <span><b>{head}</b>{rest}</span>
            <button type="button" className="resolve-notice-x" aria-label={t("안내 닫기")} title={t("안내 닫기")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                // 키보드로 닫았다(초점이 이 단추에 있다) — 사라지기 전에 남은 줄의 ✕ 로 옮긴다
                if (document.activeElement === event.currentTarget) {
                  const all = [...(boxRef.current?.querySelectorAll<HTMLButtonElement>(".resolve-notice-x") ?? [])];
                  const at = all.indexOf(event.currentTarget);
                  (all[at + 1] ?? all[at - 1])?.focus();
                }
                onDismiss(item.id);
              }}>
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
