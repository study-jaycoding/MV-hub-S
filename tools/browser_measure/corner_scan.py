"""겹친 층의 모서리 반경 어긋남 찾기 — 격리 S 서버의 실제 화면(빌드 CSS)을 헤드리스 크롬으로 돈다(2026-11-06, Jay 지적:
크게 보기 Ctrl 카드의 그늘 막이 카드 틀 반경으로 잘려 원본 모서리에만 밝은 초승달).

  1) <venv python> tools/browser_measure/servers.py start
  2) <venv python> tools/browser_measure/corner_scan.py --work <작업 폴더> --server-port 8572   (결과: 작업 폴더의 results_corner.json)
     종료 코드: 0 = 어긋남 없음 · 1 = 어긋남 있음(목록 출력) · 3 = 격리 서버가 아님(시작 거부)
  3) <venv python> tools/browser_measure/servers.py stop

판정: 화면의 그림·영상(img·video·canvas)마다, 그 모서리와 같은 자리(2px 안)에 모서리가 있는 색 있는 층(배경·그라데이션·테두리)을 모아
'실제로 보이는 반경'(자기 반경과, 같은 모서리를 자르는 조상 틀의 반경 — overflow·clip-path round)을 비교한다. 위에 덮인 층은 1.5px 넘게
다르면(그늘이 빠진 초승달·그림 밖으로 삐진 색), 밑에 깔린 층은 그림보다 덜 둥글어 모서리 밖으로 보이면 적는다.
돌는 화면: 워크스페이스 격자(마우스·고름) · 크게 보기(+Ctrl) · 생성 정보 창 · 코멘트 그림 창 · 공유 & 리뷰(+Ctrl) · 캔버스(마우스·고름) ·
어셋 창(마우스·고름) · 어셋 크게 보기(+Ctrl). 그림이 없는 화면은 '그림 없음(미검사)'으로 따로 적는다 — 0건과 섞지 않는다.

★쓰기는 격리 서버와 작업 폴더에만: 앞 카드 두 장 공유(S 선택 창) · 생성 카드 넷 씬 불러오기 · 작업 폴더의 corner_assets 를 어셋 폴더로 등록.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import Page  # noqa: E402
from walk import by_text, login  # noqa: E402

DETECT = r"""(() => {
  const CORNERS = ['tl', 'tr', 'bl', 'br'];
  const sty = (e) => getComputedStyle(e);
  const zoomOf = (e) => { const w = e.offsetWidth; return w ? e.getBoundingClientRect().width / w : 1; };
  const pt = (r, c) => c === 'tl' ? [r.left, r.top] : c === 'tr' ? [r.right, r.top] : c === 'bl' ? [r.left, r.bottom] : [r.right, r.bottom];
  const radOf = (e, c) => { const s = sty(e); return parseFloat({tl: s.borderTopLeftRadius, tr: s.borderTopRightRadius, bl: s.borderBottomLeftRadius, br: s.borderBottomRightRadius}[c]) || 0; };
  const clipR = (e) => { const m = /round\s+([\d.]+)px/.exec(sty(e).clipPath || ''); return m ? parseFloat(m[1]) : null; };
  const effR = (e, c) => {
    const p = pt(e.getBoundingClientRect(), c);
    let best = radOf(e, c) * zoomOf(e); const own = clipR(e); if (own != null) best = Math.max(best, own * zoomOf(e));
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const q = pt(a.getBoundingClientRect(), c);
      if (Math.abs(q[0] - p[0]) > 2 || Math.abs(q[1] - p[1]) > 2) continue;
      const s = sty(a), z = zoomOf(a), cr = clipR(a);
      if (cr != null) best = Math.max(best, cr * z);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') best = Math.max(best, radOf(a, c) * z);
    }
    return Math.round(best * 10) / 10;
  };
  const shown = (e) => { let o = 1; for (let a = e; a; a = a.parentElement) { const s = sty(a); if (s.display === 'none' || s.visibility === 'hidden') return 0; o *= parseFloat(s.opacity); } return o; };
  const paints = (e) => {
    const s = sty(e); const m = /rgba?\(([^)]+)\)/.exec(s.backgroundColor); const p = m ? m[1].split(',').map(Number) : [];
    if (p.length && (p.length < 4 || p[3] > 0.03)) return 'bg';
    if (s.backgroundImage && s.backgroundImage !== 'none') return 'grad';
    if ((parseFloat(s.borderTopWidth) || 0) > 0 && !/rgba\(0, 0, 0, 0\)/.test(s.borderTopColor)) return 'border';
    return null;
  };
  const desc = (e) => { const parts = []; for (let a = e, i = 0; a && i < 3 && a !== document.body; a = a.parentElement, i++) parts.unshift(a.tagName.toLowerCase() + (a.classList.length ? '.' + [...a.classList].slice(0, 2).join('.') : '')); return parts.join(' > '); };
  const vw = innerWidth, vh = innerHeight;
  const media = [...document.querySelectorAll('img, video, canvas')].filter((m) => { const r = m.getBoundingClientRect(); return r.width > 24 && r.height > 24 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && shown(m) > 0.05; }).slice(0, 60);
  const all = [...document.querySelectorAll('body *')].map((e) => [e, e.getBoundingClientRect()]).filter(([, r]) => r.width > 8 && r.height > 8);
  const found = {};
  for (const m of media) {
    const mr = m.getBoundingClientRect();
    for (const [e, r] of all) {
      if (e === m) continue;
      const near = CORNERS.filter((c) => { const a = pt(r, c), b = pt(mr, c); return Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2; });
      if (!near.length) continue;
      const kind = paints(e); if (!kind) continue;
      if (shown(e) < 0.05) continue;
      const below = e.contains(m) || !!(e.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING);
      for (const c of near) {
        const rm = effR(m, c), re = effR(e, c);
        if (!(below ? re < rm - 1.5 : Math.abs(re - rm) > 1.5)) continue;
        const key = desc(e) + ' | ' + desc(m) + ' | ' + c;
        found[key] = found[key] || {layer: desc(e), media: desc(m), corner: c, layer_r: re, media_r: rm, where: below ? 'below' : 'above', kind, n: 0};
        found[key].n++;
      }
    }
  }
  return {media: media.length, findings: Object.values(found)};
})()"""

AUTH = """(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/auth.?token/i.test(k)) { const v = localStorage.getItem(k); try { return JSON.parse(v); } catch { return v; } } } return null; })()"""
CTRL = dict(key="Control", code="ControlLeft", windowsVirtualKeyCode=17)


async def _center(pg: Page, js: str):
    return await pg.eval(f"(() => {{ const e = {js}; if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + Math.min(r.height / 2, 60)]; }})()")


async def _mouse(pg: Page, x: float, y: float, button: str = "none", count: int = 0, kind: str = "mouseMoved") -> None:
    await pg.send("Input.dispatchMouseEvent", type=kind, x=x, y=y, button=button, clickCount=count)


async def _click(pg: Page, p, button: str = "left") -> None:
    await _mouse(pg, *p, button, 1, "mousePressed")
    await _mouse(pg, *p, button, 1, "mouseReleased")


async def _dbl(pg: Page, p) -> None:
    for kind, count in (("mousePressed", 1), ("mouseReleased", 1), ("mousePressed", 2), ("mouseReleased", 2)):
        await _mouse(pg, *p, "left", count, kind)


async def _key(pg: Page, k: str, code: str, vk: int, text: str | None = None) -> None:
    await pg.send("Input.dispatchKeyEvent", type="keyDown" if text else "rawKeyDown", key=k, code=code, windowsVirtualKeyCode=vk, **({"text": text} if text else {}))
    await pg.send("Input.dispatchKeyEvent", type="keyUp", key=k, code=code, windowsVirtualKeyCode=vk)


async def _api(pg: Page, method: str, url: str, body=None):
    payload = json.dumps(json.dumps(body)) if body is not None else "undefined"
    return await pg.eval(f"""(async () => {{ const t = {AUTH}; const r = await fetch({json.dumps(url)}, {{method: {json.dumps(method)},
        headers: Object.assign({{'Content-Type': 'application/json'}}, t ? {{Authorization: 'Bearer ' + t}} : {{}}), body: {payload}}});
        let j = null; try {{ j = await r.json(); }} catch {{}} return {{status: r.status, body: j}}; }})()""")


def _asset_folder(work: Path) -> Path:
    """S 의 그림 몇 장을 작업 폴더 안 시험 폴더로 복사한다(원본은 읽기만)."""
    dst = work / "corner_assets"
    dst.mkdir(exist_ok=True)
    if not any(dst.iterdir()):
        picked = [p for p in (work / "S").rglob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp") and 20_000 < p.stat().st_size < 3_000_000][:8]
        for p in picked:
            shutil.copy2(p, dst / p.name)
    return dst


async def run(base: str, work: Path, extra_css: str) -> dict:
    creds = json.loads((work / "S" / "creds.json").read_text(encoding="utf-8"))
    report: dict = {"states": {}, "prep": {}}
    async with Page(0, work / "chrome_profile_corner", size=(1600, 1000)) as pg:
        async def scan(name: str) -> None:
            r = await pg.eval(DETECT)
            report["states"][name] = r
            mark = "그림 없음(미검사)" if not r["media"] else f"어긋남 {len(r['findings'])}"
            print(f"{name}: 그림 {r['media']} · {mark}", flush=True)

        async def css() -> None:
            if extra_css:
                await pg.eval(f"(() => {{ if (document.getElementById('corner-css')) return; const s = document.createElement('style'); s.id = 'corner-css'; s.textContent = {json.dumps(extra_css)}; document.head.appendChild(s); }})()")

        async def ctrl_scan(name: str) -> None:
            await pg.send("Input.dispatchKeyEvent", type="rawKeyDown", modifiers=2, **CTRL)
            await asyncio.sleep(1.5)
            await scan(name)
            await pg.send("Input.dispatchKeyEvent", type="keyUp", **CTRL)

        await login(pg, base, creds)
        await asyncio.sleep(4)
        await css()
        card = "document.querySelector('.gen-cell .card')"
        for i in range(2):  # 준비 1 — 공유 탭이 비지 않게 앞 카드 두 장 공유(격리 서버)
            sel = f"document.querySelectorAll('.gen-cell .card')[{i}]"
            p = await _center(pg, sel)
            if not p or await pg.eval(f"!!{sel}.querySelector('.card-sf.on')"):
                continue
            await _mouse(pg, *p)
            await asyncio.sleep(0.4)
            await pg.click(f"{sel}.querySelector('.card-sf')")
            await asyncio.sleep(0.8)
            await pg.click("[...document.querySelectorAll('.s-pick button')].find(b => b.innerText.includes('공유'))")
            await asyncio.sleep(1.2)
        listing = await _api(pg, "GET", "/api/generations?limit=12&lean_params=1")  # 준비 2 — 생성 카드 넷 씬
        body = listing.get("body")
        items = body if isinstance(body, list) else (body or {}).get("items") or (body or {}).get("generations") or []
        gens = [g for g in items if isinstance(g, dict) and g.get("status") == "done"][:4]
        cards = [{"id": f"corner-g{i}", "kind": "generation", "x": 40 + (i % 2) * 260, "y": 40 + (i // 2) * 280, "genId": g["id"], "genIds": [g["id"]], "status": "done"} for i, g in enumerate(gens)]
        scene = {"format": "mv-scene", "version": 1, "name": "모서리 검사", "scene": {"name": "모서리 검사", "cards": cards, "edges": [], "camera": {"x": 0, "y": 0, "z": 1}}}
        mount = await _api(pg, "POST", "/api/assets/mounts", {"name": "모서리검사", "path": str(_asset_folder(work))})  # 준비 3
        report["prep"] = {"scene_cards": len(cards), "mount_status": mount.get("status")}

        p = await _center(pg, card)
        if p:
            await _mouse(pg, *p)
            await asyncio.sleep(0.6)
            await scan("워크스페이스 격자(마우스)")
            await _click(pg, p)
            await asyncio.sleep(0.5)
            await scan("워크스페이스 격자(고름)")
            await _dbl(pg, p)
            await asyncio.sleep(2.5)
            await scan("크게 보기")
            await ctrl_scan("크게 보기 + Ctrl 카드")
            await _key(pg, "Escape", "Escape", 27)
            await asyncio.sleep(1)
            await _click(pg, p, "middle")
            await asyncio.sleep(2)
            await scan("생성 정보 창")
            await _key(pg, "Escape", "Escape", 27)
            await asyncio.sleep(1)
            await _key(pg, "c", "KeyC", 67, text="c")
            await asyncio.sleep(2.5)
            await scan("코멘트 그림 창")
            await _key(pg, "Escape", "Escape", 27)
            await asyncio.sleep(1)
        await pg.click(by_text("공유 & 리뷰"))
        await asyncio.sleep(4)
        q = await _center(pg, card)
        if q:
            await _mouse(pg, *q)
            await asyncio.sleep(0.6)
            await scan("공유 & 리뷰(마우스)")
            await _dbl(pg, q)
            await asyncio.sleep(2.5)
            await ctrl_scan("공유 & 리뷰 크게 보기 + Ctrl 카드")
            await _key(pg, "Escape", "Escape", 27)
            await asyncio.sleep(1)
        else:
            await scan("공유 & 리뷰(마우스)")
        await pg.click(by_text("캔버스"))
        await asyncio.sleep(5)
        t = await _center(pg, "document.querySelector('.scene-tab')")
        if t and cards:  # 씬 패널(탭 휠 클릭)의 숨은 파일 입력으로 불러온다
            await _click(pg, t, "middle")
            await asyncio.sleep(1)
            report["prep"]["scene_loaded"] = await pg.eval(f"""(() => {{ const i = document.querySelector('input[type=file][accept*="json"]'); if (!i) return false;
                const dt = new DataTransfer(); dt.items.add(new File([{json.dumps(json.dumps(scene))}], 'corner.json', {{type: 'application/json'}}));
                i.files = dt.files; i.dispatchEvent(new Event('change', {{bubbles: true}})); return true; }})()""")
            await _key(pg, "Escape", "Escape", 27)
            await asyncio.sleep(5)
        await scan("캔버스")
        n = await _center(pg, "document.querySelector('[class*=\"scene-card\"], [class*=\"snode\"]')")
        if n:
            await _mouse(pg, *n)
            await asyncio.sleep(0.5)
            await scan("캔버스(마우스)")
            await _click(pg, n)
            await asyncio.sleep(0.6)
            await scan("캔버스(고름)")
        await pg.send("Page.navigate", url=base + "?embed=assets")
        await asyncio.sleep(6)
        await css()
        await pg.click("[...document.querySelectorAll('.assets-tree *')].find(e => e.children.length === 0 && (e.innerText || '').trim() === '모서리검사')")
        await asyncio.sleep(3)
        a = await _center(pg, "document.querySelector('.asset-cell')")
        if a:
            await _mouse(pg, *a)
            await asyncio.sleep(0.6)
            await scan("어셋 창(마우스)")
            await _click(pg, a)
            await asyncio.sleep(0.5)
            await scan("어셋 창(고름)")
            await _dbl(pg, a)
            await asyncio.sleep(2.5)
            await scan("어셋 크게 보기")
            await ctrl_scan("어셋 크게 보기 + Ctrl 칸")
        else:
            await scan("어셋 창(마우스)")
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--work", type=Path, required=True, help="servers.py 와 같은 작업 폴더")
    ap.add_argument("--server-port", type=int, default=8572)
    ap.add_argument("--css", type=Path, help="시안 확인용 — 페이지에 덧씌울 CSS(앱 파일은 안 바꾼다)")
    args = ap.parse_args()
    if args.server_port == 8010 or not (args.work / "S" / "creds.json").is_file():
        print("격리 S 서버(servers.py start 의 작업 폴더)가 아니라 시작하지 않는다", file=sys.stderr)
        return 3
    report = asyncio.run(run(f"http://127.0.0.1:{args.server_port}/", args.work, args.css.read_text(encoding="utf-8") if args.css else ""))
    (args.work / "results_corner.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    bad = [(name, f) for name, r in report["states"].items() for f in r["findings"]]
    empty = [name for name, r in report["states"].items() if not r["media"]]
    for name, f in bad:
        print(f"  ✗ {name} · {f['corner']} · 층 {f['layer_r']}px vs 그림 {f['media_r']}px ({f['where']}) · {f['layer']}  ||  {f['media']}")
    print(f"화면 {len(report['states'])} · 어긋남 {len(bad)} · 그림 없음(미검사) {len(empty)}{' — ' + ', '.join(empty) if empty else ''}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
