"""실측 단계 러너 — 한 단계 = 동작 → 잠깐 대기 → 화면 상태 조사 → 스크린샷 → 콘솔·네트워크·쓰기 요청·대화상자 회수.

결과는 단계별 JSON 으로 남는다. ★화면에는 시험 DB 의 실제 계정 이름·이메일이 나올 수 있다 — 결과·스크린샷을 저장소나 보고서에 옮기지 않는다.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from cdp import Page

# 지금 화면의 요약: 카드 수·선택 수·건수 표시·떠 있는 층(창/메뉴)·포커스
PROBE = r"""
(() => {
  const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const layers = new Set();
  for (const e of document.querySelectorAll('[class]')) {
    const cn = typeof e.className === 'string' ? e.className : '';
    const m = cn.match(/[\w-]*(modal|popup|dialog|menu|drawer|popover|toast|backdrop|window|viewer|picker|confirm|panel|console)[\w-]*/i);
    if (m && vis(e)) layers.add(m[0]);
  }
  const cards = document.querySelectorAll('.gen-cell .card');
  return { cards: cards.length, selected: [...cards].filter(c => /\bselected\b/.test(c.className)).length,
           count: (document.querySelector('.lib-count') || {}).innerText || null, layers: [...layers].slice(0, 14),
           url: location.pathname + location.search };
})()
"""
# 동작 전후에 "새로 보이게 된 요소"를 찾기 위한 보이는 클래스 집계
VISIBLE_CLASSES = r"""
(() => { const out = {}; for (const e of document.querySelectorAll('[class]')) { const r = e.getBoundingClientRect();
  if (r.width < 3 || r.height < 3) continue; const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none') continue;
  const c = typeof e.className === 'string' ? e.className.trim().split(/\s+/)[0] : ''; if (c) out[c] = (out[c] || 0) + 1; } return out; })()
"""
BUTTONS = "[...document.querySelectorAll('button,[role=button],[role=tab],[role=menuitem]')]"


def by_title(part: str) -> str:
    return f"{BUTTONS}.find(b => ((b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '')).includes({json.dumps(part)}))"


def by_text(text: str, exact: bool = True) -> str:
    test = f"b.innerText.trim() === {json.dumps(text)}" if exact else f"b.innerText.includes({json.dumps(text)})"
    return f"{BUTTONS}.find(b => {test} && b.getBoundingClientRect().width > 0)"


async def login(pg: Page, base_url: str, creds: dict) -> str:
    """AUTH-on 서버의 로그인 화면을 통과한다. 자격은 servers.py 가 만든 일회용 관리자(S/creds.json)만 쓴다."""
    await pg.goto(base_url, settle=3)
    if not await pg.eval("!!document.querySelector('.login-submit')"):
        return "already"
    await pg.click("document.querySelectorAll('input')[0]")
    await pg.type(creds["email"])
    await pg.click("document.querySelectorAll('input')[1]")
    await pg.type(creds["password"])
    await pg.click("document.querySelector('.login-submit')")
    ok = await pg.wait("!document.querySelector('.login-submit')", 20)
    await asyncio.sleep(4)
    return "ok" if ok else "FAILED"


class Walker:
    def __init__(self, pg: Page, tag: str, out: Path):
        self.pg, self.tag, self.out, self.results, self.n = pg, tag, out, [], 0

    async def step(self, feature: str, name: str, action, settle: float = 1.2, expect=None) -> dict:
        """action: 메모(str/dict)를 돌려주는 async 호출. 대상을 못 찾으면 False. expect(state, note) 는 True 또는 실패 사유."""
        self.n += 1
        self.pg.drain()
        started, ok = time.time(), True
        try:
            note = await action()
            if note is False:
                ok, note = False, "대상을 찾지 못함"
        except Exception as e:  # noqa: BLE001 — 한 단계의 실패가 실측 전체를 멈추지 않게
            ok, note = False, f"예외 {type(e).__name__}: {str(e)[:300]}"
        await asyncio.sleep(settle)
        try:
            state = await self.pg.eval(PROBE)
        except Exception as e:  # noqa: BLE001
            state = {"probe_error": str(e)[:200]}
        if ok and expect is not None:
            verdict = expect(state, note)
            if verdict is not True:
                ok, note = False, f"기대와 다름: {verdict} | {note}"
        shot = f"{self.tag}_{self.n:03d}.png"
        try:
            await self.pg.shot(self.out / "shots" / shot)
        except Exception:  # noqa: BLE001
            shot = None
        events = self.pg.drain()
        record = {"n": self.n, "feature": feature, "step": name, "ok": ok, "note": note, "state": state, "shot": shot,
                  "console": events["console"][:8], "network": events["network"][:8], "mutations": events["mutations"][:12],
                  "dialogs": events["dialogs"], "sec": round(time.time() - started, 1)}
        self.results.append(record)
        extra = "".join([
            f" console={len(events['console'])}" if events["console"] else "",
            f" net={len(events['network'])}" if events["network"] else "",
            " 쓰기=" + ",".join(m.split("?")[0] for m in events["mutations"][:3]) if events["mutations"] else "",
            " 대화상자=" + json.dumps([d["message"][:60] for d in events["dialogs"]], ensure_ascii=False) if events["dialogs"] else "",
        ])
        print(f"[{'OK ' if ok else 'FAIL'}] {self.n:03d} {feature} / {name} -> {json.dumps(note, ensure_ascii=False)[:140]}"
              f" | cards={state.get('cards')} sel={state.get('selected')}{extra}", flush=True)
        return record

    def save(self) -> Path:
        path = self.out / f"results_{self.tag}.json"
        path.write_text(json.dumps(self.results, ensure_ascii=False, indent=1), encoding="utf-8")
        return path

    # 자주 쓰는 동작
    def click(self, js_element: str, **kw):
        async def act():
            return (await self.pg.click(js_element, **kw)) or False
        return act

    def press(self, key: str, code: str | None = None, modifiers: int = 0, text: str | None = None, vk: int | None = None):
        async def act():
            await self.pg.key(key, code, modifiers, text, vk)
            return f"key {key}"
        return act

    def js(self, expression: str):
        async def act():
            return await self.pg.eval(expression)
        return act

    def appeared(self, action, settle: float = 1.5):
        """동작 뒤에 새로 보이게 된 요소의 클래스 이름 — 무엇이 열렸는지 선택자를 몰라도 알 수 있다."""
        async def act():
            before = await self.pg.eval(VISIBLE_CLASSES)
            if await action() is False:
                return False
            await asyncio.sleep(settle)
            after = await self.pg.eval(VISIBLE_CLASSES)
            return {"new": sorted(k for k in after if k not in before)[:25]}
        return act

    async def escape_all(self) -> None:
        for _ in range(3):
            await self.pg.key("Escape", "Escape", vk=27)
            await asyncio.sleep(0.25)
