// Resolve 보내기 결과 가운데 확인이 필요한 것(부분 성공·실패·결과 불명) — 알림(.toast) 바로 아래에 ✕ 로 닫을 때까지 남는다
// (Jay 2026-10-14 · Codex 배포 전 검토 E4). 알림은 한 칸이고 2.5초라, 줄 서 있던 다음 작업의 글이 앞의 결과를 덮었다.
// 무엇을 남길지는 lib/useResolveTransferActions 가 정한다(세 줄까지 — 넘으면 오래된 것부터 빠진다). 여기는 그리기만 한다.
//  · 떠 있는 채 뒤 화면을 쓴다 — Esc 겹·키 주인으로 올리지 않는다(뒤 화면에 초점이 있을 때의 단축키·Esc 는 그대로다). 닫는 길은 ✕ 뿐이다.
//  · **안내 안에서 난 키는 밖으로 내보내지 않는다**(전파만 막는다 — Tab 이동·Enter·Space 의 단추 누르기는 그대로다). 뒤 화면의 키
//    처리(lib/useGenerationKeyboardActions·편집 탭 — window 의 버블 단계)는 키가 어디서 났는지 보지 않아, ✕ 에 초점을 둔 채 R·D 를
//    누르면 뒤의 고른 카드에 색·비활성이 걸렸다(Codex 코드 리뷰 — 길이 조절 창 EditTrimPop 과 같은 길).
//  · ✕ 를 마우스로 눌러도 초점을 가져가지 않는다 — 가져가면 줄이 사라지면서 초점이 BODY 로 떨어진다.
//  · 초점이 있던 줄이 사라지면 남은 줄의 ✕ 로 옮긴다(아래 focusAt).
//  · 편집 탭의 경고도 같은 줄에 선다(Jay 2026-10-24 — lib/useStateNotices). 그 줄은 닫기·글자 단추를 스스로 가져온다.
import { useLayoutEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import type { NoticeLine } from "../../lib/useStateNotices";

// 첫 마디(— 나 · 앞)를 굵게 — 무슨 일인지가 먼저 읽히게
function parts(text: string): [string, string] {
  const cut = text.search(/ — | · /);
  return cut < 0 ? [text, ""] : [text.slice(0, cut), text.slice(cut)];
}

const closersOf = (box: HTMLElement | null) => [...(box?.querySelectorAll<HTMLButtonElement>(".resolve-notice-x") ?? [])];

export function ResolveNotices({ items, onDismiss }: { items: readonly NoticeLine[]; onDismiss: (id: number) => void }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  // 초점이 있던 줄이 사라지면 남은 줄의 ✕ 로 옮긴다 — 같은 자리의 줄(없으면 마지막 줄)로. 줄이 사라지는 길은 둘이다: 키보드로 그 줄을
  //  닫았다 · **네 번째 결과가 와서 맨 위 줄이 빠졌다**(사용자가 한 일이 아니다). 안 옮기면 초점이 BODY 로 떨어져, 그 뒤의 Delete·화살표가
  //  뒤 화면에 먹는다(편집 탭: 고른 클립 삭제·재생헤드 — Codex 코드 리뷰). 초점이 안내 밖에 있었으면 건드리지 않는다.
  //  사라지기 전의 자리는 **그리는 중에** 읽는다 — 화면에 반영된 뒤에는 그 단추가 이미 없다(초점은 BODY 다).
  const focusAt = closersOf(boxRef.current).indexOf(document.activeElement as HTMLButtonElement);
  useLayoutEffect(() => {
    if (focusAt < 0) return;
    const left = closersOf(boxRef.current);
    if (left.includes(document.activeElement as HTMLButtonElement)) return; // 초점이 있던 줄이 그대로 있다
    left[Math.min(focusAt, left.length - 1)]?.focus(); // 마지막 줄까지 닫았으면 갈 곳이 없다 — 둔다
  }, [items, focusAt]);
  if (!items.length) return null;
  return (
    <div className="resolve-notices" ref={boxRef} role="status" aria-live="polite" aria-label={t("안내")}
      onKeyDown={(event) => event.stopPropagation()}>
      {items.map((item) => {
        const [head, rest] = parts(item.text);
        const own = "onDismiss" in item ? item : null; // 편집 탭 경고 — 닫기·단추를 스스로 가져온다
        return (
          <div className="resolve-notice" key={item.id}>
            <span title={own?.title}>
              <b>{head}</b>{rest}
              {own?.action && <>{" "}
                <button type="button" className="resolve-notice-act" onMouseDown={(event) => event.preventDefault()} onClick={own.action.run}>
                  {own.action.label}
                </button>
              </>}
            </span>
            <button type="button" className="resolve-notice-x" aria-label={t("안내 닫기")} title={t("안내 닫기")}
              onMouseDown={(event) => event.preventDefault()} onClick={() => ("onDismiss" in item ? item.onDismiss() : onDismiss(item.id))}>
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
