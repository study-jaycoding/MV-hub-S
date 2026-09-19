"""격리 서버(S) 위에서 핵심 화면을 한 바퀴 도는 실측 시나리오 — 2026-09-19 실측에서 통과가 확인된 단계만 담았다.

  1) <venv python> tools/browser_measure/servers.py start
  2) <venv python> tools/browser_measure/smoke.py            (결과: 작업 폴더의 results_smoke.json. `--shots` 를 주면 shots/ 에 화면도)
     종료 코드: 0 = 전부 통과 · 1 = 제품 쪽 확인 필요(기대와 다름·예외·생성 요청 발생) · 2 = 시나리오만 낡음(대상을 찾지 못함 — UI 가 바뀌었다)
  3) <venv python> tools/browser_measure/servers.py stop

★누르지 않는다: Generate · 도크의 Alt+Enter · 카드의 ↻ 재생성 · Comfy 실행 · Resolve로 보내기 · 프로그램 업데이트 · HF 체크 · Assets 파일 조작.
  끝에서 비-GET 요청 가운데 `/api/gen-requests` 가 0건인지 확인하고, 아니면 실패로 끝난다.
새 단계를 더할 때: 선택자를 추측하지 말고 `Walker.appeared()` 로 무엇이 열렸는지 먼저 본다. 단축키를 재기 전에 선택이 살아 있는지 확인한다
(Esc 는 선택을 푼다). 창을 닫는 Esc 는 **새 페이지에서 처음 연 창**으로 잰다 — 두 번째부터는 증상이 안 보이는 결함이 있었다.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import Page  # noqa: E402
from walk import Walker, by_text, by_title, login  # noqa: E402

CARD = "document.querySelectorAll('.gen-cell .card')"
TOOL_DOT = "[...document.querySelectorAll('.lib-tools .af-dot, .assets-filters .af-dot')]"


async def run(base: str, work: Path, debug_port: int, shots: bool, verbose: bool) -> int:
    creds = json.loads((work / "S" / "creds.json").read_text(encoding="utf-8"))
    async with Page(debug_port, work / "chrome_profile") as pg:
        w = Walker(pg, "smoke", work, shots=shots, verbose=verbose)
        has_cards = lambda s, n: True if s.get("cards", 0) > 0 else "카드가 없다"  # noqa: E731
        one_selected = lambda s, n: True if s.get("selected") == 1 else f"선택 {s.get('selected')}개"  # noqa: E731

        await w.step("로그인", "일회용 관리자", lambda: login(pg, base, creds), settle=4, expect=has_cards)

        async def ensure_sidebar():
            if await pg.eval("!!document.querySelector('.proj-trash')"):
                return "열려 있음"
            await pg.click(by_title("필터 사이드바"))
            await asyncio.sleep(1)
            return "열었음" if await pg.eval("!!document.querySelector('.proj-trash')") else False
        await w.step("사이드바", "열린 상태 보장", ensure_sidebar)

        # 보기
        await w.step("라이브러리 보기", "리스트", w.click(by_title("리스트")))
        await w.step("라이브러리 보기", "그리드", w.click(by_title("그리드")), expect=has_cards)
        for kind in ("이미지", "영상", "전체"):
            await w.step("타입 눈금", kind, w.click(f"[...document.querySelectorAll('.lib-hist-tick')].find(b => b.title === {json.dumps(kind)})"), settle=2)

        # 검색
        def search(query: str):
            async def act():
                if not await pg.click("document.querySelector('input[placeholder*=\"Search\"]')"):
                    return False
                await pg.key("a", "KeyA", modifiers=2, vk=65)
                if query:
                    await pg.type(query)
                else:
                    await pg.key("Backspace", "Backspace", vk=8)
                await pg.key("Enter", "Enter", vk=13, text="\r")
                await pg.key("Escape", "Escape", vk=27)
                return f"query={query!r}"
            return act
        await w.step("검색", "없는 말 → 0건", search("zzqq-no-such-word"), settle=3, expect=lambda s, n: True if s["cards"] == 0 else f"{s['cards']}장")
        await w.step("검색", "지우기", search(""), settle=3, expect=has_cards)

        # 카드: 선택·컬러(필터에 반영)·비활성·태그·코멘트·미리보기·정보
        card = f"{CARD}[2]"
        red = f"{TOOL_DOT}.find(b => (b.title || '').includes('R 컬러'))"
        await w.step("카드", "클릭=선택", w.click(card), expect=one_selected)
        await w.step("단축키", "r = 빨강", w.press("r", "KeyR", vk=82, text="r"), settle=1.5)
        await w.step("툴바 필터", "R 컬러만 → 방금 칠한 카드", w.click(red), settle=2.5, expect=has_cards)
        await w.step("툴바 필터", "R 해제", w.click(red), settle=2.5, expect=has_cards)
        await w.step("카드", "다시 선택", w.click(card), expect=one_selected)
        await w.step("단축키", "r 다시 = 해제", w.press("r", "KeyR", vk=82, text="r"), settle=1.5)
        cell = f"(({card}).closest('.gen-cell') || {{}}).className"
        await w.step("단축키", "d = 비활성", w.press("d", "KeyD", vk=68, text="d"), settle=1.2)
        await w.step("단축키", "비활성 표시 확인", w.js(cell), expect=lambda s, n: True if "deactivated" in str(n) else f"class={n}")
        await w.step("단축키", "d 다시 = 복구", w.press("d", "KeyD", vk=68, text="d"), settle=1.2)
        await w.step("단축키", "복구 확인", w.js(cell), expect=lambda s, n: True if "deactivated" not in str(n) else f"class={n}")
        await w.step("단축키", "# = 태그 입력", w.appeared(w.press("#", "Digit3", modifiers=8, vk=51, text="#")), expect=lambda s, n: True if n and n["new"] else "아무것도 안 열림")
        await w.escape_all()
        await w.step("카드", "다시 선택", w.click(card), expect=one_selected)
        await w.step("단축키", "c = 코멘트 패널", w.appeared(w.press("c", "KeyC", vk=67, text="c"), 2), expect=lambda s, n: True if n and "cmt-panel" in n["new"] else f"{n}")
        await w.step("코멘트", "✕ 로 닫기(Esc 로는 안 닫히는 설계)", w.click("document.querySelector('.cmt-x')"))
        await w.step("카드", "더블클릭=미리보기", w.click(card, count=2), settle=2.5, expect=lambda s, n: True if "preview-backdrop" in s["layers"] else f"{s['layers']}")
        await w.step("미리보기", "Esc", w.press("Escape", "Escape", vk=27), expect=lambda s, n: True if "preview-backdrop" not in s["layers"] else "안 닫힘")
        await w.step("카드", "휠클릭=정보 팝업", w.click(card, button="middle"), settle=2, expect=lambda s, n: True if "info-popup" in s["layers"] else f"{s['layers']}")
        await w.step("정보 팝업", "Esc", w.press("Escape", "Escape", vk=27), expect=lambda s, n: True if "info-popup" not in s["layers"] else "안 닫힘")

        # 다중 선택
        await w.step("다중 선택", "Ctrl+A", w.press("a", "KeyA", modifiers=2, vk=65), expect=lambda s, n: True if s["selected"] >= 10 else f"선택 {s['selected']}")
        await w.step("다중 선택", "Esc = 해제", w.press("Escape", "Escape", vk=27), expect=lambda s, n: True if s["selected"] == 0 else f"선택 {s['selected']}")

        # 탭
        await w.step("탭", "공유 & 리뷰", w.click(by_text("공유 & 리뷰")), settle=4)
        await w.step("탭", "캔버스", w.click(by_text("캔버스")), settle=5)
        await w.step("탭", "작업 공간", w.click(by_text("작업 공간")), settle=3, expect=has_cards)

        # 프롬프트 도크 — 제출하지 않는다
        dock = "!!document.querySelector('.sl-gen') && document.querySelector('.sl-gen').getBoundingClientRect().width > 0"
        await w.step("프롬프트 도크", "Ctrl+K 숨김", w.press("k", "KeyK", modifiers=2, vk=75))
        await w.step("프롬프트 도크", "숨겨졌나", w.js(f"({dock}) ? 'visible' : 'hidden'"), expect=lambda s, n: True if n == "hidden" else n)
        await w.step("프롬프트 도크", "Ctrl+K 표시", w.press("k", "KeyK", modifiers=2, vk=75))
        await w.step("프롬프트 도크", "보이나", w.js(f"({dock}) ? 'visible' : 'hidden'"), expect=lambda s, n: True if n == "visible" else n)

        # ★새 페이지에서 처음 연 창이 Esc 한 번에 닫히는가 (2026-09-19 에 찾은 결함의 회귀 확인)
        async def first_open_one_escape(opener: str, marker: str, before=None):
            await pg.goto(base, settle=5)
            if before:
                await before()
            if not await pg.click(opener):
                return False
            await asyncio.sleep(2.5)
            if not await pg.eval(f"!!document.querySelector({json.dumps(marker)})"):
                return {"opened": False}
            await pg.key("Escape", "Escape", vk=27)
            await asyncio.sleep(1.2)
            return {"opened": True, "open_after_one_escape": await pg.eval(f"!!document.querySelector({json.dumps(marker)})")}

        async def open_account_menu():
            await pg.click("document.querySelector('.acct-avatar-btn')")
            await asyncio.sleep(1.5)
        closed = lambda s, n: True if isinstance(n, dict) and n.get("opened") and not n["open_after_one_escape"] else f"{n}"  # noqa: E731
        await w.step("Esc 1회", "관리자 창(처음 열기)", lambda: first_open_one_escape("document.querySelector('button.brand')", ".admin-window"), expect=closed)
        await w.step("Esc 1회", "설정 창(처음 열기)", lambda: first_open_one_escape(
            "[...document.querySelectorAll('.acct-pop button, .acct-action')].find(b => /Setting/.test(b.innerText))", ".settings-action", open_account_menu), expect=closed)
        await w.step("Esc 1회", "알림 센터(처음 열기)", lambda: first_open_one_escape("document.querySelector('.notification-bell')", ".notification-list, .notification-head"), expect=closed)

        # 분리 창
        async def goto(url: str):
            await pg.goto(url, settle=1)
            return url
        await w.step("분리 창", "Assets (읽기만)", lambda: goto(base + "?embed=assets"), settle=5, expect=lambda s, n: True if "assets-window" in s["layers"] else f"{s['layers']}")
        await w.step("분리 창", "PM 관리", lambda: goto(base + "?embed=manage"), settle=6, expect=lambda s, n: True if "manage-window" in s["layers"] else f"{s['layers']}")

        path = w.save()
        failed = [r for r in w.results if r["verdict"] == "failed"]
        stale = [r for r in w.results if r["verdict"] == "stale"]
        print(f"\n단계 {len(w.results)} · 실패 {len(failed)} · 낡은 단계 {len(stale)} · 생성 요청 {w.gen_requests}건 · 결과 {path}")
        if failed and not verbose:
            print("실패한 단계의 자세한 원인(기대값·화면 값)은 기본 모드에 남기지 않는다 — `--verbose` 로 다시 돌려 본다: "
                  + ", ".join(f"{r['n']:03d} {r['step']} ({r['reason']})" for r in failed))
        if stale:
            print("낡은 단계 = 화면이 바뀌어 대상을 못 찾은 것이다. 제품 결함이 아니라 이 시나리오를 고칠 차례: "
                  + ", ".join(f"{r['n']:03d} {r['step']}" for r in stale))
        return 1 if failed or w.gen_requests else (2 if stale else 0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "mvhub-browser-measure", help="servers.py 와 같은 작업 폴더")
    ap.add_argument("--server-port", type=int, default=8232)
    ap.add_argument("--debug-port", type=int, default=9331, help="브라우저 원격 디버깅 포트")
    ap.add_argument("--shots", action="store_true", help="단계마다 스크린샷 저장(실제 계정 이름이 찍힐 수 있다 — 저장소·보고서로 옮기지 않는다)")
    ap.add_argument("--verbose", action="store_true", help="콘솔·대화상자 원문까지 결과에 남긴다(기본은 종류와 경로만 — 원문에는 이름이 섞일 수 있다)")
    args = ap.parse_args()
    return asyncio.run(run(f"http://127.0.0.1:{args.server_port}/", args.work.resolve(), args.debug_port, args.shots, args.verbose))


if __name__ == "__main__":
    sys.exit(main())
