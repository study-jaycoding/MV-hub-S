"""코드에서 뽑는 목록(docs/inventory/*.md) 생성기 — 손으로 쓰면 낡는 목록을 코드에서 다시 만든다.

  python tools/gen_inventory.py           docs/inventory/ 의 네 목록을 다시 쓴다
  python tools/gen_inventory.py --check   다시 만들어 디스크와 비교만 한다(다르면 종료 코드 1)

표준 라이브러리만 쓰고 **앱 코드를 import 하지 않는다**(AST·정규식으로 읽기만 한다 → 사용자 데이터에 닿을 길이 없다).
출력에는 날짜·줄 번호를 넣지 않는다(편집할 때마다 낡는다). 코드 조각은 `ast.unparse` 가 아니라 소스 원문을 옮긴다
(파이썬 버전에 따라 unparse 결과가 달라 가짜 '낡음'이 난다). 어긋남 검사는 `backend/tests/test_docs_inventory_fresh.py`.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "inventory"
SKIP_DIRS = {"node_modules", ".venv", "__pycache__", "dist", "graft", "data", "data_test", "_pm_test_data_snapshots"}
METHODS = ("get", "post", "put", "patch", "delete", "head", "options", "websocket", "api_route")
WINDOWS_BUILTIN = {"APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "COMPUTERNAME", "USERNAME", "USERPROFILE", "TEMP", "TMP",
                   "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "PROGRAMFILES"}
SECRET_NAME = re.compile(r"PASSWORD|SECRET|TOKEN|KEY")
# DDL(CREATE TABLE)이 있는 파일 → 그 테이블이 사는 DB. 기계로는 안 나오는 유일한 수동 표라, 표에 없는 DDL 위치가
# 생기면 생성을 실패시켜 조용히 낡지 않게 한다.
DB_FAMILY = {
    "backend/schema.sql": "content DB",
    "backend/app/db_migrations.py": "content DB",
    "backend/app/repo/id_resolve.py": "content DB",
    "backend/app/repo/manage_schema.py": "content DB",
    "backend/app/manage_db.py": "manage_hub.db",
    "backend/app/repo/trash.py": "trash DB (ATTACH)",
    "backend/app/services/worker_backup.py": "worker_backup_state.db",
    "agent_push.py": "agent_state.db (작업자 PC)",
}


def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def files(base: str, *suffixes: str) -> list[Path]:
    root = ROOT / base
    return sorted(
        (p for p in root.rglob("*")
         if p.is_file() and p.suffix in suffixes and not (set(p.relative_to(ROOT).parts) & SKIP_DIRS)),
        key=rel,
    )


def product_py() -> list[Path]:
    """제품 파이썬 전부 — `backend/app` + `backend/` 바로 밑(서버 기동기 `serve.py` 등) + 저장소 루트(`agent_push.py` 등)."""
    top = [p for d in (ROOT, ROOT / "backend") for p in d.iterdir() if p.is_file() and p.suffix == ".py"]
    return files("backend/app", ".py") + sorted(top, key=rel)


def scripts() -> list[Path]:
    top = [p for p in ROOT.iterdir() if p.is_file() and p.suffix in (".bat", ".ps1")]
    return sorted(top + files("tools", ".bat", ".ps1") + files("release", ".bat", ".ps1") + files("deploy", ".bat", ".ps1"), key=rel)


_TEXT: dict[Path, str] = {}
_TREE: dict[Path, ast.Module] = {}


def text(p: Path) -> str:
    if p not in _TEXT:
        _TEXT[p] = p.read_text(encoding="utf-8-sig", errors="replace")
    return _TEXT[p]


def tree(p: Path) -> ast.Module:
    if p not in _TREE:
        _TREE[p] = ast.parse(text(p))
    return _TREE[p]


_LINES: dict[Path, list[bytes]] = {}


def seg(p: Path, node: ast.AST, limit: int = 80) -> str:
    """노드의 소스 원문(공백 정규화). `ast.get_source_segment` 는 부를 때마다 파일을 다시 쪼개 수만 번 부르면 분 단위로 느리다."""
    if p not in _LINES:  # ast 의 col_offset 은 UTF-8 바이트 기준이라 줄을 바이트로 들고 있는다
        _LINES[p] = [line.encode("utf-8") for line in text(p).split("\n")]
    lines, a, b = _LINES[p], node.lineno - 1, node.end_lineno - 1
    if a == b:
        raw = lines[a][node.col_offset:node.end_col_offset]
    else:
        raw = b"\n".join([lines[a][node.col_offset:], *lines[a + 1:b], lines[b][:node.end_col_offset]])
    s = " ".join(raw.decode("utf-8", "replace").split())
    return s if len(s) <= limit else s[:limit] + "…"


def const_str(node) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def callee(node: ast.Call) -> str:
    f = node.func
    return f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")


def functions(mod: ast.Module):
    """(qualname, node) for every function, outermost first."""
    stack: list[tuple[ast.AST, str]] = [(mod, "")]
    while stack:
        node, qual = stack.pop()
        for ch in ast.iter_child_nodes(node):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = f"{qual}.{ch.name}" if qual else ch.name
                if not isinstance(ch, ast.ClassDef):
                    yield name, ch
                stack.append((ch, name))
            else:
                stack.append((ch, qual))


def own_nodes(fn: ast.AST):
    """Nodes of a function body, not descending into nested defs."""
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        n = stack.pop()
        yield n
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            stack.extend(ast.iter_child_nodes(n))


def cell(s: object) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ").strip() or "—"


def table(head: list[str], rows: list[list[object]]) -> list[str]:
    out = ["| " + " | ".join(head) + " |", "| " + " | ".join("---" for _ in head) + " |"]
    return out + ["| " + " | ".join(cell(c) for c in r) + " |" for r in rows] + [""]


def ticks(items) -> str:
    return " ".join(f"`{i}`" for i in items) if items else "—"


def header(title: str, rules: list[str]) -> list[str]:
    return [
        f"# {title}",
        "",
        "> 이 파일은 `python tools/gen_inventory.py` 가 코드에서 뽑아 만든다. **손으로 고치지 않는다** — 다음 생성 때 사라진다.",
        "> 코드와 어긋나면 `backend/tests/test_docs_inventory_fresh.py` 가 실패한다. 그때는 위 명령을 다시 돌리고 문서 커밋으로 올린다.",
        "",
        "뽑는 규칙과 한계:",
        "",
        *[f"- {r}" for r in rules],
        "",
    ]


# ───────────────────────── endpoints ─────────────────────────
def _local_tables() -> tuple[tuple[str, ...], frozenset[str]]:
    vals = {}
    for node in tree(ROOT / "backend/app/routers/_proxy.py").body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in ("_LOCAL_PREFIXES", "_LOCAL_EXACT"):
                v = node.value
                if isinstance(v, ast.Call):  # frozenset({...}) — 빈 frozenset() 도 허용
                    v = v.args[0] if v.args else ast.Tuple(elts=[])
                vals[node.targets[0].id] = tuple(ast.literal_eval(v))
    return tuple(vals["_LOCAL_PREFIXES"]), frozenset(vals["_LOCAL_EXACT"])


def _depends(p: Path, node: ast.AST) -> set[str]:
    return {seg(p, n.args[0]) for n in ast.walk(node) if isinstance(n, ast.Call) and callee(n) == "Depends" and n.args}


def _proxy_names(mod: ast.Module) -> set[str]:
    names = set()
    for n in ast.walk(mod):
        if isinstance(n, ast.ImportFrom):
            if (n.module or "").split(".")[-1] == "_proxy":
                names |= {a.asname or a.name for a in n.names}
            names |= {a.asname or a.name for a in n.names if a.name == "_proxy"}
    return names


def endpoints() -> tuple[list[str], int]:
    prefixes, exact = _local_tables()
    app_files = files("backend/app", ".py")
    routers: dict[tuple[str, str], dict] = {}
    for p in app_files:
        for node in ast.walk(tree(p)):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and callee(node.value) == "APIRouter":
                kw = {k.arg: k.value for k in node.value.keywords}
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        routers[(rel(p), t.id)] = {
                            "prefix": const_str(kw.get("prefix")) or "",
                            "deps": _depends(p, kw["dependencies"]) if "dependencies" in kw else set(),
                        }
    # 라우터 모듈 안의 `router.include_router(child.router[, prefix=…])`: 자식이 부모의 접두·의존성을 물려받는다.
    for p in files("backend/app/routers", ".py"):
        for node in ast.walk(tree(p)):
            if isinstance(node, ast.Call) and callee(node) == "include_router" and node.args:
                parent, child = node.func.value, node.args[0]
                known = isinstance(parent, ast.Name) and isinstance(child, ast.Attribute) and isinstance(child.value, ast.Name)
                pkey = (rel(p), parent.id) if known else None
                ckey = (rel(p.with_name(child.value.id + ".py")), child.attr) if known else None
                if pkey not in routers or ckey not in routers:
                    # 접두 상속을 조용히 빠뜨리면 경로가 틀린 채로 통과한다 — 모르는 꼴이면 크게 실패한다.
                    raise SystemExit(f"{rel(p)}: 해석할 수 없는 include_router 꼴 `{seg(p, node)}` — tools/gen_inventory.py 의 endpoints() 를 넓힌다.")
                extra = next((const_str(k.value) or "" for k in node.keywords if k.arg == "prefix"), "")
                routers[ckey]["prefix"] = routers[pkey]["prefix"] + extra + routers[ckey]["prefix"]
                routers[ckey]["deps"] |= routers[pkey]["deps"]
    by_file: dict[str, list[list[object]]] = {}
    for p in app_files:
        proxy_names = _proxy_names(tree(p))
        for _qual, fn in functions(tree(p)):
            for d in fn.decorator_list:
                if not (isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in METHODS
                        and isinstance(d.func.value, ast.Name)):
                    continue
                owner = routers.get((rel(p), d.func.value.id), {"prefix": "", "deps": set()})
                kw = {k.arg: k.value for k in d.keywords}
                raw = const_str(d.args[0]) if d.args else const_str(kw.get("path"))
                path = owner["prefix"] + (raw if raw is not None else "<동적>")
                method = d.func.attr.upper()
                if method == "API_ROUTE":
                    method = "/".join(sorted(ast.literal_eval(kw["methods"]))) if "methods" in kw else "GET"  # set 이어도 순서 고정
                if not path.startswith("/api/"):
                    kind = "해당 없음"
                elif path in exact or path.startswith(prefixes):
                    delegates = any(isinstance(n, ast.Name) and n.id in proxy_names for n in ast.walk(fn))
                    kind = "로컬 예외 · 핸들러가 `_proxy` 호출" if delegates else "로컬 예외"
                else:
                    kind = "기본 중계"
                deps = owner["deps"] | _depends(p, d) | _depends(p, fn.args)
                by_file.setdefault(rel(p), []).append([f"`{method}`", f"`{path}`", f"`{fn.name}`", kind, ticks(sorted(deps))])
    total = sum(len(v) for v in by_file.values())
    out = header("엔드포인트 목록", [
        "FastAPI 데코레이터(`@router.get(…)`·`@app.get(…)`·`websocket`·`api_route`)를 AST 로 읽는다. 경로 = `APIRouter(prefix=)` + 데코레이터 경로이고, 라우터 안의 `include_router` 는 부모 접두를 물려받는다.",
        "**중앙 프록시 분류(위임 모드에서)** 는 `routers/_proxy.py` 의 `_LOCAL_PREFIXES`·`_LOCAL_EXACT` 에 `is_local_path` 와 같은 규칙을 적용한 것이다. **실제 중계는 `proxying()` 이 참일 때만** 일어난다 — AUTH off + 공유 서버 토큰 있음 + `CONTENT_HUB_NO_PROXY` 아님(작업자 PC 의 로컬 허브). 공유 서버 본체·test_dev 에서는 `기본 중계` 경로도 자기가 처리한다. `/media`·`/api/media-thumb` 의 서버 보존본 폴백은 별도 예외다.",
        "`로컬 예외 · 핸들러가 _proxy 호출` 은 핸들러 **본문이 `_proxy` 를 직접 참조**할 때만 붙는다(팀 탭 등에서 핸들러가 골라서 위임). 헬퍼·usecase 를 거쳐 위임하면 안 보이므로, 이 표시가 없다고 위임이 없다는 뜻은 아니다.",
        "`Depends` 칸은 라우터·데코레이터·핸들러 인자에 직접 적힌 것만이다. 인증 미들웨어와 핸들러 본문의 권한 검사는 안 나온다.",
    ])
    out += [f"전체 {total}개.", ""]
    for f in sorted(by_file):
        rows = sorted(by_file[f], key=lambda r: (r[1], r[0]))
        out += [f"## `{f}` — {len(rows)}개", ""] + table(["메서드", "경로", "핸들러", "중앙 프록시 분류(위임 모드에서)", "Depends"], rows)
    return out, total


# ───────────────────────── env vars ─────────────────────────
ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]{2,}")


def _reads_env(p: Path, n: ast.Call) -> bool:
    """`os.getenv`·`os.environ.get/pop`·`_env_int` 류. `env = os.environ.copy(); env.pop("X")` 같은 로컬 사본 조작은 읽기가 아니다."""
    f = n.func
    if isinstance(f, ast.Attribute):
        if f.attr in ("get", "pop", "setdefault"):
            return "environ" in seg(p, f.value, 200)
        return "env" in f.attr.lower()
    return "env" in getattr(f, "id", "").lower()


def env_vars() -> tuple[list[str], int]:
    seen: dict[str, dict[str, set[str]]] = {}

    def note(name: str | None, where: str, kind: str = "read", default: str | None = None):
        if name and ENV_NAME.fullmatch(name):
            e = seen.setdefault(name, {"default": set(), "read": set(), "set": set()})
            e[kind].add(where)
            if default is not None:
                e["default"].add("(표시 안 함)" if SECRET_NAME.search(name) else default)

    for p in product_py() + files("tools", ".py") + files("release", ".py") + files("deploy", ".py"):
        mod = tree(p)
        loops: dict[int, list[str]] = {}  # for v in ("A", "B"): os.environ.get(v)  → 그 반복문 안의 v 만 푼다
        for loop in ast.walk(mod):
            if isinstance(loop, ast.For) and isinstance(loop.target, ast.Name) and isinstance(loop.iter, (ast.Tuple, ast.List)):
                names = [const_str(e) for e in loop.iter.elts]
                if names and all(names):
                    for n in ast.walk(loop):
                        if isinstance(n, ast.Name) and n.id == loop.target.id:
                            loops[id(n)] = names
        for n in ast.walk(mod):
            if isinstance(n, ast.Call) and n.args and _reads_env(p, n):
                kw = {k.arg: k.value for k in n.keywords}
                dflt = n.args[1] if len(n.args) > 1 else kw.get("default")
                first = n.args[0]
                names = [const_str(first)] if const_str(first) else loops.get(id(first), [])
                for name in names:
                    note(name, rel(p), default=seg(p, dflt, 60) if dflt is not None else None)
            elif isinstance(n, ast.Subscript) and "environ" in seg(p, n.value, 200):
                note(const_str(n.slice), rel(p), "set" if isinstance(n.ctx, (ast.Store, ast.Del)) else "read")
            elif isinstance(n, ast.Compare) and len(n.comparators) == 1 and "environ" in seg(p, n.comparators[0], 200):
                note(const_str(n.left), rel(p))
            elif isinstance(n, ast.Dict) and any(k is None and "environ" in seg(p, v, 200) for k, v in zip(n.keys, n.values)):
                for k in n.keys:  # {**os.environ, "X": 값} — 자식 프로세스(CLI·PowerShell)에 넘기는 변수
                    note(const_str(k) if k is not None else None, rel(p), "set")
    fe = files("frontend/src", ".ts", ".tsx") + sorted((ROOT / "frontend").glob("vite.config.*"))
    for p in fe:
        for name in re.findall(r"(?:import\.meta\.env|process\.env)\.([A-Z][A-Z0-9_]{2,})", text(p)):
            note(name, rel(p))
    for p in scripts():
        src = text(p)
        for name in list(seen):
            if re.search(rf'(?i)(?:\bset\s+"?{name}=|\$env:{name}\s*=)', src):
                note(name, rel(p), "set")
    product = sorted(n for n in seen if n.upper() not in WINDOWS_BUILTIN and seen[n]["read"])
    builtin = sorted(n for n in seen if n.upper() in WINDOWS_BUILTIN)
    handed = sorted(n for n in seen if n.upper() not in WINDOWS_BUILTIN and not seen[n]["read"])
    out = header("환경변수 목록", [
        "**직접 읽는 파일** = 환경변수를 그 자리에서 읽는 코드다. 파이썬은 AST 로 찾는다: 첫 인자가 대문자 문자열이고 호출 대상 이름에 `env` 가 들어간 호출(`os.getenv`·`os.environ.get`·`_env_int` 류), `environ[\"X\"]`, `\"X\" in os.environ`, 그리고 `for v in (\"A\", \"B\"): os.environ.get(v)` 꼴. 프런트는 `import.meta.env.X`·`process.env.X`.",
        "`config.py` 가 읽어 **상수로 내보낸 값**(`AUTH_ENABLED` 등)을 쓰는 모듈은 여기 안 나온다 — 그 상수 이름으로 다시 찾는다.",
        "**기본값** 은 호출의 둘째 인자 소스 그대로다. `os.environ.get(\"X\") or \"기본\"` 처럼 호출 밖에서 주는 기본값과, 이름을 조립해 읽는 변수는 안 잡힌다. 이름에 PASSWORD·SECRET·TOKEN·KEY 가 들어가면 기본값을 가린다.",
        "**설정하는 곳** = 코드가 읽는 이름을 `.bat`/`.ps1` 이 `set X=`·`$env:X =` 로 주는 자리와 파이썬의 `os.environ[\"X\"] = …`.",
        "스캔 범위는 `backend/app`·`backend/*.py`(서버 기동기 `serve.py` 등)·루트 `*.py`(`agent_push.py` 등)·`tools`·`release`·`deploy`·`frontend/src` 다. **시험 폴더(`backend/tests`·`frontend/tests`)는 보지 않는다** — 시험 전용 변수는 여기 없다.",
    ])
    out += [f"제품 환경변수 {len(product)}개.", ""]
    out += table(["이름", "기본값", "직접 읽는 파일", "설정하는 곳"],
                 [[f"`{n}`", ticks(sorted(seen[n]["default"])), ticks(sorted(seen[n]["read"])), ticks(sorted(seen[n]["set"]))]
                  for n in product])
    out += ["## 코드가 읽지 않고 자식 프로세스에 넘기기만 하는 변수", "",
            "`{**os.environ, \"X\": 값}` 꼴로 CLI·PowerShell 같은 자식에게 준다(예: 과금 공간을 정하는 `HIGGSFIELD_WORKSPACE_ID`).", ""]
    out += table(["이름", "넘기는 파일"], [[f"`{n}`", ticks(sorted(seen[n]["set"]))] for n in handed])
    out += ["## Windows 가 주는 변수 (제품 설정 아님)", ""]
    out += table(["이름", "직접 읽는 파일"], [[f"`{n}`", ticks(sorted(seen[n]["read"]))] for n in builtin])
    return out, len(product)


# ───────────────────────── db tables ─────────────────────────
_NAME = r"(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)"  # 스키마 접두(trash.trashed)는 떼고 테이블 이름만
CREATE = re.compile(rf"CREATE\s+(?:VIRTUAL\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{_NAME}", re.I)
RENAME = re.compile(rf"ALTER\s+TABLE\s+{_NAME}\s+RENAME\s+TO\s+", re.I)
TOUCH = re.compile(rf"\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|FROM|JOIN)\s+{_NAME}", re.I)


def sql_literals(p: Path) -> list[str]:
    if p.suffix == ".sql":
        return [text(p)]
    mod = tree(p)
    docstrings = {id(n.body[0].value) for n in ast.walk(mod)
                  if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and n.body
                  and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
    # f-string 의 상수 조각도 Constant 로 나온다 → 테이블 이름이 상수 조각에 있으면 잡힌다.
    return [n.value for n in ast.walk(mod) if const_str(n) and id(n) not in docstrings]


def db_tables() -> tuple[list[str], int]:
    sources = [ROOT / "backend/schema.sql"] + product_py()
    lits = {p: sql_literals(p) for p in sources}
    defined: dict[str, set[str]] = {}
    renamed_away: set[str] = set()
    for p, strings in lits.items():
        for s in strings:
            for name in CREATE.findall(s):
                defined.setdefault(name, set()).add(rel(p))
            renamed_away |= set(RENAME.findall(s))
    unknown = sorted({f for fs in defined.values() for f in fs} - set(DB_FAMILY))
    if unknown:
        raise SystemExit("CREATE TABLE 이 새 파일에 생겼다: " + ", ".join(unknown)
                         + "\n  → tools/gen_inventory.py 의 DB_FAMILY 에 '그 테이블이 어느 DB 에 사는지'를 추가한다.")
    rebuild = sorted(t for t in defined if t in renamed_away)
    real = sorted(t for t in defined if t not in renamed_away)
    writers: dict[str, set[str]] = {t: set() for t in defined}
    readers: dict[str, set[str]] = {t: set() for t in defined}
    for p, strings in lits.items():
        for s in strings:
            for verb, name in TOUCH.findall(s):
                if name in defined:
                    (readers if verb.upper() in ("FROM", "JOIN") else writers)[name].add(rel(p))
    short = lambda fs: ticks(sorted(f.removeprefix("backend/app/") for f in fs))  # noqa: E731
    out = header("DB 테이블 목록", [
        "`backend/schema.sql` 과 제품 파이썬(`backend/app`·`backend/*.py`·루트 `*.py`)의 **문자열 리터럴**(f-string 의 상수 조각 포함, 독스트링 제외)에서 `CREATE TABLE` 을 찾는다.",
        "**DB** 칸은 DDL 이 있는 파일로 정한다(이 도구의 `DB_FAMILY` 표). `content DB` 는 그때 고른 콘텐츠 DB(`db_paths.get_db_path()` — 계정·모드에 따라 파일이 다르다)이고 `manage_schema.py` 의 PM 테이블도 거기 산다. `manage_hub.db` 는 팀 텔레메트리 전용으로 물리 분리돼 있다.",
        "**쓰는 모듈** = 리터럴 안의 `INSERT INTO`·`REPLACE INTO`·`UPDATE`·`DELETE FROM <테이블>`, **읽는 모듈** = `FROM`·`JOIN <테이블>`. 테이블 이름 자체를 `{}` 로 끼워 조립한 SQL 과 `FROM a, b` 의 둘째 이름은 못 잡는다 — **빈칸이 '아무도 안 쓴다'는 뜻은 아니다.** 경로는 `backend/app/` 을 뗀 것이다.",
        "컬럼은 싣지 않는다. 정의 파일의 `CREATE TABLE` 과 그 뒤 `ALTER TABLE … ADD COLUMN` 마이그레이션을 본다.",
    ])
    out += [f"테이블 {len(real)}개.", ""]
    out += table(["테이블", "DB", "정의 파일", "쓰는 모듈", "읽는 모듈"],
                 [[f"`{t}`", " / ".join(sorted({DB_FAMILY[f] for f in defined[t]})), short(defined[t]), short(writers[t]), short(readers[t])]
                  for t in real])
    out += ["## 재구축용 임시 테이블", "", "마이그레이션이 `CREATE TABLE x_new` → 복사 → `ALTER TABLE x_new RENAME TO x` 로 쓰고 버리는 이름이다.", ""]
    out += table(["테이블", "정의 파일"], [[f"`{t}`", short(defined[t])] for t in rebuild])
    return out, len(real)


# ───────────────────────── background jobs ─────────────────────────
SPAWN = {"Thread", "Timer", "create_task", "ensure_future", "run_coroutine_threadsafe"}
STARTER = re.compile(r"^_?(start|schedule)_")


def is_spawn(p: Path, n: ast.Call) -> bool:
    name = callee(n)
    if name in ("create_task", "ensure_future"):  # `create_task` 는 PM '작업 만들기' 함수 이름이기도 하다
        return bool(re.search(r"(asyncio|loop|tg|group)\.\w+$", seg(p, n.func, 200)))
    return name in SPAWN


def spawn_target(p: Path, n: ast.Call) -> str:
    kw = {k.arg: k.value for k in n.keywords}
    tgt = kw.get("target") or (n.args[1] if callee(n) == "Timer" and len(n.args) > 1 else (n.args[0] if n.args else None))
    label = const_str(kw.get("name"))
    return (seg(p, tgt, 70) if tgt is not None else "?") + (f" (name={label})" if label else "")


def _import_map(p: Path) -> dict[str, str]:
    """main.py 의 `from .x.y import z` / `from .x import y` → 이름이 정의된 모듈 파일."""
    out = {}
    for n in ast.walk(tree(p)):
        if isinstance(n, ast.ImportFrom) and n.level == 1:
            base = p.parent.joinpath(*(n.module or "").split(".")) if n.module else p.parent
            for a in n.names:
                for cand in (base / (a.name + ".py"), base.with_suffix(".py"), base / "__init__.py"):
                    if cand.is_file():
                        out[a.asname or a.name] = rel(cand)
                        break
    return out


def background_jobs() -> tuple[list[str], int]:
    main = ROOT / "backend/app/main.py"
    imports = _import_map(main)
    lifes = [fn for _q, fn in functions(tree(main))
             if isinstance(fn, ast.AsyncFunctionDef) and any("asynccontextmanager" in seg(main, d) for d in fn.decorator_list)]
    boot: list[list[object]] = []

    def visit(stmts: list[ast.stmt], conds: list[str], thread_vars: set[str]):
        for st in stmts:
            if isinstance(st, ast.If):
                c = seg(main, st.test, 120)
                visit(st.body, conds + [c], thread_vars)
                visit(st.orelse, conds + [f"not ({c})"], thread_vars)
            elif isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            elif isinstance(st, (ast.Try, ast.With, ast.AsyncWith, ast.For, ast.AsyncFor, ast.While)):
                for block in (getattr(st, "body", []), getattr(st, "orelse", []), getattr(st, "finalbody", []),
                              *[h.body for h in getattr(st, "handlers", [])]):
                    visit(block, conds, thread_vars)
            else:
                for n in ast.walk(st):
                    if not isinstance(n, ast.Call):
                        continue
                    name = callee(n)
                    if is_spawn(main, n):
                        what, how = spawn_target(main, n), name
                    elif (name == "start" and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
                          and n.func.value.id not in thread_vars):
                        what, how = n.func.value.id, "start()"
                    elif STARTER.match(name):
                        what, how = seg(main, n.func), "호출"
                    else:
                        continue
                    owner = imports.get(re.split(r"[.( ]", what)[0], "backend/app/main.py")
                    boot.append([f"`{what}`", how, " and ".join(conds) or "항상", f"`{owner}`"])

    for life in lifes:
        tv = {t.id for n in ast.walk(life) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call)
              and callee(n.value) in ("Thread", "Timer") for t in n.targets if isinstance(t, ast.Name)}
        visit(life.body, [], tv)

    after: list[list[object]] = []
    during: list[list[object]] = []
    loops: list[list[object]] = []
    agent = ROOT / "agent_push.py"
    for p in product_py():
        for qual, fn in functions(tree(p)):
            if p == main and fn in lifes:
                continue
            for n in own_nodes(fn):
                if isinstance(n, ast.Call) and callee(n) == "add_task" and n.args:
                    after.append([f"`{rel(p)}`", f"`{qual}`", f"`{seg(p, n.args[0], 70)}`"])
                elif isinstance(n, ast.Call) and is_spawn(p, n):
                    during.append([f"`{rel(p)}`", f"`{qual}`", callee(n), f"`{spawn_target(p, n)}`"])
                elif p == agent and isinstance(n, ast.While) and isinstance(n.test, ast.Constant) and n.test.value is True:
                    loops.append([f"`{qual}`"])
    # 파일을 복사만 하는 릴리스 스크립트는 빼고, 인자를 붙여 실제로 실행하는 줄만 본다.
    launchers = [rel(p) for p in scripts() if re.search(r'agent_push\.py"?\s+--', text(p))]

    def unique(rows: list[list[object]]) -> list[list[object]]:
        """같은 함수가 같은 대상을 여러 자리에서 띄우면 한 줄로 합치되 횟수(×N)를 남긴다 — 자리를 숨기지 않는다."""
        counts: dict[tuple, int] = {}
        for r in rows:
            counts[tuple(r)] = counts.get(tuple(r), 0) + 1
        return [[*r[:-1], f"{r[-1]} ×{n}" if n > 1 else r[-1]] for r, n in sorted(counts.items())]

    out = header("백그라운드 작업 목록", [
        "**① 기동 때** = `backend/app/main.py` 의 lifespan(`@asynccontextmanager`) 안에서 부르는 `X.start()`·`threading.Thread`·`asyncio.create_task`·`start_*`/`schedule_*` 호출. **조건** 은 그 호출을 둘러싼 `if` 를 소스 그대로 옮긴 것이다 — 실행 모드(공유 서버 본체 / 작업자 허브 / test_dev)별 차이가 여기서 갈린다.",
        "**② 응답 뒤** = FastAPI `BackgroundTasks.add_task(…)`. **③ 그 밖의 동시성 시작점** = `Thread`·`Timer`·`asyncio.create_task`·`ensure_future`·`run_coroutine_threadsafe` 자리 전부다(`backend/app`·`backend/*.py`·루트 `*.py`). **오래 도는 루프**(①의 `X.start()` 가 안에서 띄우는 `self._run()` 류)와 **짧게 끝나는 내부 태스크**(소켓 송신기·단일 비행 등)가 섞여 있으니 대상 칸으로 구분한다. 요청 하나 동안만 도는 `asyncio.to_thread` 는 뺐다.",
        "**④ 작업자 에이전트** = `agent_push.py` 를 인자와 함께 실행하는 스크립트(`--watch` 가 상주 모드)와, 그 파일에서 `while True:` 를 가진 함수. 뒤쪽은 **상주 루프 후보일 뿐**이다 — 파일을 끝까지 읽는 짧은 반복도 같은 꼴이라 섞여 있다(상주 루프의 본체는 `main`).",
        "주기·간격·중지 방법은 기계로 안 나온다 — 정의 모듈의 머리말과 [환경변수 목록](env_vars.md)의 `*_INTERVAL` 을 본다.",
    ])
    out += ["## ① 기동 때 시작되는 것 (lifespan)", ""] + table(["대상", "방식", "조건", "정의 모듈"], boot)
    after, during, loops = unique(after), unique(during), unique(loops)
    out += ["## ② 응답 뒤에 도는 것 (BackgroundTasks)", ""] + table(["파일", "함수", "대상"], after)
    out += ["## ③ 그 밖의 동시성 시작점", ""] + table(["파일", "함수", "방식", "대상"], during)
    out += ["## ④ 작업자 에이전트 (`agent_push.py`)", "", "실행하는 스크립트: " + ticks(launchers), ""]
    out += table(["`while True` 를 가진 함수(상주 루프 후보)"], loops)
    return out, len(boot) + len(after) + len(during) + len(loops)


BUILDERS = {
    "endpoints.md": endpoints,
    "env_vars.md": env_vars,
    "db_tables.md": db_tables,
    "background_jobs.md": background_jobs,
}


def render() -> dict[str, tuple[bytes, int]]:
    """파일 이름 → (LF·UTF-8 바이트, 항목 수). 시험도 이것을 부른다."""
    built = {name: build() for name, build in BUILDERS.items()}
    return {name: (("\n".join(lines).rstrip("\n") + "\n").encode("utf-8"), n) for name, (lines, n) in built.items()}


def stale(rendered: dict[str, tuple[bytes, int]]) -> list[str]:
    """디스크의 목록 중 코드와 어긋난 것(줄끝은 정규화해서 비교 — autocrlf 체크아웃 대비)."""
    return [name for name, (data, _n) in rendered.items()
            if not (OUT / name).is_file() or (OUT / name).read_bytes().replace(b"\r\n", b"\n") != data]


def main() -> int:
    rendered = render()
    if "--check" in sys.argv[1:]:
        old = stale(rendered)
        if old:
            print("코드와 어긋난 목록: " + ", ".join(old))
            print("고치기: python tools/gen_inventory.py  → 바뀐 docs/inventory/ 를 문서 커밋으로 올린다")
        return 1 if old else 0
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (data, n) in rendered.items():
        (OUT / name).write_bytes(data)
        print(f"docs/inventory/{name}: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
