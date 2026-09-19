"""실측 단계 러너 — 한 단계 = 동작 → 잠깐 대기 → 화면 상태 조사 → 스크린샷 → 콘솔·네트워크·쓰기 요청·대화상자 회수.

결과는 단계별 JSON 으로 남는다. ★화면에는 시험 DB 의 실제 계정 이름·이메일이 나올 수 있다 — 결과·스크린샷을 저장소나 보고서에 옮기지 않는다.
"""
from __future__ import annotations

import asyncio
import json
import re
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


# 이메일은 요청 **경로** 안에 URL 인코딩된 꼴(`…/accounts/name%40host/status`)로도 실려 다닌다 — 두 꼴을 모두 가린다.
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", re.I)


def mask(value):
    """결과에 남기기 전에 이메일 꼴 문자열을 가린다(문자열·목록·사전을 재귀로). 표시 이름은 기계로 못 가린다 — 그래서 스크린샷은 기본 끔."""
    if isinstance(value, str):
        return EMAIL.sub("<email>", value)
    if isinstance(value, list):
        return [mask(v) for v in value]
    if isinstance(value, dict):
        return {k: mask(v) for k, v in value.items()}
    return value


URL = re.compile(r"https?://[^\s\"']+")


def url_path(url: str) -> str:
    """주소에서 호스트와 질의(?…)를 뗀 경로만 — 질의에는 검색어·이름이 실릴 수 있다."""
    return "/" + url.split("://", 1)[-1].split("/", 1)[-1].split("?", 1)[0].split("#", 1)[0] if "://" in url else url.split("?", 1)[0]


def redact(events: dict) -> dict:
    """콘솔·네트워크·쓰기 요청·대화상자에서 **종류와 경로만** 남긴다. 원문에는 표시 이름·프로젝트 이름이 섞일 수 있다."""
    return {
        "console": [{"kind": e["kind"], "paths": [mask(url_path(u)) for u in URL.findall(e.get("text", ""))][:2]} for e in events["console"]],
        "network": [{"status": e.get("status"), "method": e.get("method"), "path": mask(url_path(e.get("url", "")))} for e in events["network"]],
        "mutations": [mask(m.split("?", 1)[0]) for m in events["mutations"]],
        "dialogs": [{"type": d.get("type"), "accepted": d.get("accepted"), "chars": len(d.get("message", ""))} for d in events["dialogs"]],
    }


class Walker:
    """기본 모드의 결과·터미널에는 **자유 문장이 하나도 남지 않는다** — 단계의 메모(note)·예외 원문·검색어가 든 주소·네트워크 오류 원문은
    `verbose` 일 때만 남긴다(그때도 이메일은 가린다). 기본 모드에서 실패 원인은 고정 어휘 `reason`(대상 없음 / 기대와 다름 / 예외 종류)으로만 알린다."""

    def __init__(self, pg: Page, tag: str, out: Path, shots: bool = False, verbose: bool = False):
        self.pg, self.tag, self.out, self.shots, self.verbose, self.results, self.n = pg, tag, out, shots, verbose, [], 0

    async def step(self, feature: str, name: str, action, settle: float = 1.2, expect=None) -> dict:
        """action: 메모(str/dict)를 돌려주는 async 호출. 대상을 못 찾으면 False. expect(state, note) 는 True 또는 실패 사유."""
        self.n += 1
        self.pg.drain()
        # verdict: ok / stale(대상을 못 찾음 = 시나리오가 낡았다 — UI 가 바뀐 것) / failed(기대와 다름·예외 = 제품 쪽을 본다)
        started, verdict, reason = time.time(), "ok", ""
        try:
            note = await action()
            if note is False:
                verdict, reason, note = "stale", "대상을 찾지 못함", None
        except Exception as e:  # noqa: BLE001 — 한 단계의 실패가 실측 전체를 멈추지 않게
            verdict, reason, note = "failed", f"예외 {type(e).__name__}", f"{type(e).__name__}: {str(e)[:300]}"
        await asyncio.sleep(settle)
        try:
            state = await self.pg.eval(PROBE)
        except Exception as e:  # noqa: BLE001
            state = {"probe_error": str(e)[:200]}
        if verdict == "ok" and expect is not None:
            why = expect(state, note)
            if why is not True:
                verdict, reason, note = "failed", "기대와 다름", f"{why} | {note}"
        shot = None
        if self.shots:  # 화면에는 실제 계정 이름이 찍힐 수 있다 — 요청했을 때만 저장한다
            shot = f"{self.tag}_{self.n:03d}.png"
            try:
                await self.pg.shot(self.out / "shots" / shot)
            except Exception:  # noqa: BLE001
                shot = None
        raw = self.pg.drain()
        events = mask(raw) if self.verbose else redact(raw)  # 원문은 --verbose 일 때만(이메일은 그때도 가린다)
        ok = verdict == "ok"
        safe_state = {k: state.get(k) for k in ("cards", "selected", "layers")}  # url(검색어)·건수 글자는 기본 모드에서 뺀다
        record = mask({"n": self.n, "feature": feature, "step": name, "ok": ok, "verdict": verdict, "reason": reason,
                       "note": note if self.verbose else None, "state": state if self.verbose else safe_state,
                       "shot": shot, "console": events["console"][:8], "network": events["network"][:8],
                       "mutations": events["mutations"][:12], "dialogs": events["dialogs"], "sec": round(time.time() - started, 1)})
        self.results.append(record)
        extra = "".join([
            f" console={len(raw['console'])}" if raw["console"] else "",
            f" net={len(raw['network'])}" if raw["network"] else "",
            " 쓰기=" + ",".join(mask(m.split("?")[0]) for m in raw["mutations"][:3]) if raw["mutations"] else "",
            f" 대화상자={len(raw['dialogs'])}" if raw["dialogs"] else "",
        ])
        shown = json.dumps(record["note"], ensure_ascii=False)[:140] if self.verbose else (reason or "ok")
        print(f"[{ {'ok': 'OK   ', 'stale': 'STALE', 'failed': 'FAIL '}[verdict] }] {self.n:03d} {feature} / {name} -> {shown}"
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
            value = await self.pg.eval(expression)
            return "false" if value is False else value  # False 는 "대상을 찾지 못함"의 신호라, 값으로서의 false 와 구분한다
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
