"""릴리스(팀원 앱 배포)와 주소 공지 — 2단계 설계 3판 5·4·(5).

- NAS 릴리스 폴더 = 관리 창 전용 `.mvhub-runtime\\console-release\\INSTALL_SOURCE.txt`(배포 위치 설정용으로만).
- 표지·공지 파일을 다루는 함수는 루트 backend 코드를 **도우미 자식**(release_helper.py)이 가져와 부른다.
- 팀원 알림은 서버 API(공지 항목 찾기·등록·announce·삭제)로 — 관리자 로그인 토큰이 필요하다.
- [배포]는 외부 호출 전마다 의도를 기록(intent.json)하고, [이어서 하기]는 서버·NAS 를 다시 읽어 판단한다(자동 재공지 없음).
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Callable

from . import jobs, nas_access, server_api
from .install import CODE_ROOT, Installation, Runner, child_env, network_path, run_command

HELPER = CODE_ROOT / "tools" / "server_console" / "release_helper.py"
READ_TIMEOUT = 60.0
HASH_TIMEOUT = 900.0   # 판 zip(수백 MB)을 NAS 에서 읽어 지문을 낸다
LOCATION_TIMEOUT = 30.0
_SHA = re.compile(r"^[0-9a-f]{64}$")
NOTICE_PATH = "/api/update-notices/admin"


class ReleaseError(RuntimeError):
    pass


# ---- 설정(관리 창 전용 파일) ----

def release_root(inst: Installation) -> Path:
    return inst.root / ".mvhub-runtime" / "console-release"


def release_source(inst: Installation) -> str:
    """정해 둔 NAS 릴리스 폴더(없으면 '')."""
    try:
        return (release_root(inst) / "INSTALL_SOURCE.txt").read_text("utf-8-sig").strip()
    except OSError:
        return ""


def source_problem(value: str) -> str:
    text = value.strip()
    if not text:
        return "NAS 릴리스 폴더를 적으세요"
    if text.lower().startswith(("http://", "https://")):
        return "HTTP 주소에는 배포할 수 없습니다 — 폴더 경로(\\\\NAS\\…)를 적으세요"
    if not Path(text).is_absolute() or any(ord(c) < 32 for c in text) or len(text) > 260:
        return "절대 경로(\\\\NAS\\공유\\… 또는 D:\\…)를 적으세요"
    return ""


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temp.write_bytes(text.encode("utf-8"))
    os.replace(temp, path)


def save_source(inst: Installation, value: str) -> None:
    """Z:\\… 같은 연결 드라이브는 받지 않는다(관리자 창에는 안 보인다) — 화면이 실제 주소로 바꿔 보여 주고 다시 받는다."""
    text, why = network_path(value)
    if not why and text != value.strip():
        why = f"관리자 권한인 이 창에는 {value.strip()[:2]} 가 보이지 않습니다 — 실제 주소 {text} 로 적으세요"
    problem = why or source_problem(text)
    if problem:
        raise ReleaseError(problem)
    _atomic_text(release_root(inst) / "INSTALL_SOURCE.txt", text + "\n")


def read_state(inst: Installation) -> dict:
    """관리 창 상태(.mvhub-runtime\\console-state.json) — 서버 이름·마지막으로 낸 주소 공지 판."""
    try:
        value = json.loads((inst.root / ".mvhub-runtime" / "console-state.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def write_state(inst: Installation, **changes) -> None:
    _atomic_text(inst.root / ".mvhub-runtime" / "console-state.json",
                 json.dumps({**read_state(inst), **changes}, ensure_ascii=False, indent=1))


# ---- 도우미 자식 ----

def helper(inst: Installation, scratch: Path, source: str, command: str, *args: str,
           timeout: float = READ_TIMEOUT) -> dict:
    """루트 Python -I -B 로 release_helper.py. 응답 없음·형식 오류는 ok=False.
    source = **이 작업에서 확인한** NAS 릴리스 폴더 — 부를 때마다 새 빈 폴더에 그 값만 담은 INSTALL_SOURCE.txt 를 만들어
    함수의 root·CONTENT_HUB_DATA 로 쓴다(그사이 화면에서 폴더 설정을 바꿔도 이 작업의 쓰기 대상은 바뀌지 않는다)."""
    if inst.python is None:
        return {"ok": False, "error": "등록된 Python 이 없습니다", "status": 0}
    if source_problem(source):
        return {"ok": False, "error": f"NAS 릴리스 폴더: {source_problem(source)}", "status": 0}
    scratch.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="release-", dir=scratch))
    try:
        (root / "INSTALL_SOURCE.txt").write_text(source.strip() + "\n", encoding="utf-8")
        if command in ("read", "manifest", "promote", "deploy", "delete-info", "delete") and nas_access.is_unc(source):
            nas_access.allow_source_read(root)
        env = dict(child_env(inst), PYTHONDONTWRITEBYTECODE="1", CONTENT_HUB_DATA=str(root),
                   CONTENT_HUB_AUTH="0", CONTENT_HUB_PORT=str(inst.port))
        argv = [str(inst.python), "-I", "-B", str(HELPER), str(inst.root), str(root), command, *args]
        code, out = run_command(argv, timeout, env)
    except (OSError, nas_access.NasAccessError):
        return {"ok": False, "error": "NAS 작업용 임시 설정의 읽기 권한을 준비하지 못했습니다", "status": 500}
    finally:
        shutil.rmtree(root, ignore_errors=True)  # 이 호출이 방금 만든 빈 폴더(INSTALL_SOURCE.txt·assets)만
    try:
        value = json.loads(out.strip().splitlines()[-1]) if code == 0 else None
    except (ValueError, IndexError):
        value = None
    if not isinstance(value, dict):
        why = "시간 안에 끝나지 않았습니다" if code is None else "도우미가 실패했습니다"
        return {"ok": False, "error": f"릴리스 폴더 작업: {why}", "status": 0 if code is None else 500,
                "outcome_unknown": command == "delete"}
    return value


def scratch_dir(inst: Installation) -> Path:
    return inst.logs / "console-scratch"


def _b64(value: dict) -> str:
    return base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")


def shas(overview: dict | None) -> tuple[str, str]:
    """(공개 표지 sha, 후보 sha) — 없으면 ''. 화면이 본 값을 배포 확인 대상으로 쓴다."""
    overview = overview or {}
    published = (overview.get("published") or {}).get("sha256") or ""
    candidate = (overview.get("sha256") or "") if overview.get("source") == "candidate" else ""
    return str(published), str(candidate)


# ---- 서버 공지 항목(관리자 토큰) ----

def find_notice(server: dict, token: str, sha: str) -> dict | None:
    """sha 로 공지 항목 하나. 없으면 None. 옛 서버(라우트 없음)·그 밖의 오류는 ReleaseError."""
    if not _SHA.fullmatch(sha or ""):
        raise ReleaseError("릴리스 지문 형식이 아닙니다")
    code, payload = server_api.call(server, "GET", f"{NOTICE_PATH}/item?sha256={sha}", token)
    if code == 404 and server_api.detail(payload) not in ("", "Not Found"):
        return None
    if code == 404:
        raise ReleaseError("공유 서버를 업데이트한 뒤 쓸 수 있습니다(공지 항목 조회가 없는 서버)")
    item = server_api.expect_ok(code, payload, "공지 항목 찾기")
    if item.get("sha256") != sha or not isinstance(item.get("id"), str):
        raise ReleaseError("서버의 공지 항목이 요청과 다릅니다")
    return item


def register_notice(server: dict, token: str, fields: dict) -> dict:
    body = {key: fields[key] for key in FIELDS}
    payload = server_api.expect_ok(*server_api.call(server, "POST", f"{NOTICE_PATH}/register", token, body), "공지 등록")
    item = payload.get("item")
    if not isinstance(item, dict) or item.get("sha256") != fields["sha256"] or not isinstance(item.get("id"), str):
        raise ReleaseError("공지 등록 응답이 요청과 다릅니다")
    return item


def announce_notice(server: dict, token: str, notice_id: str) -> int:
    payload = server_api.expect_ok(*server_api.call(server, "POST", f"{NOTICE_PATH}/{notice_id}/announce", token, {}),
                                   "팀원 알림")
    revision = (payload.get("item") or {}).get("announcement_revision")
    if type(revision) is not int or revision < 1:
        raise ReleaseError("알림 응답 형식을 알 수 없습니다")
    return revision


def list_notices(server: dict, token: str) -> list[dict]:
    """서버의 모든 공지 항목(관리자) — 줄마다 알림 횟수·[해제] 대상."""
    rows = server_api.expect_ok(*server_api.call(server, "GET", f"{NOTICE_PATH}/list", token), "공지 목록", list)
    return [row for row in rows if isinstance(row, dict) and isinstance(row.get("sha256"), str)]


def find_delete_notice(server: dict, token: str, fields: dict) -> dict | None:
    """같은 이름의 파일을 가리키는 오래된 공지도 삭제 전에 해제해야 한다."""
    notice = find_notice(server, token, fields["sha256"])
    if notice is not None:
        return notice
    rows = list_notices(server, token)
    notice = next((row for row in rows
                   if str(row.get("file") or "").casefold() == str(fields.get("file") or "").casefold()), None)
    # 서버 API는 최근 5개만 준다. 목록 밖의 같은 파일명 공지가 없다고 추정하지 않는다.
    if notice is None and len(rows) >= 5:
        raise ReleaseError("서버 공지 목록이 일부만 보여 삭제 안전성을 확인할 수 없습니다 — 불필요한 공지를 [해제]한 뒤 다시 하세요")
    return notice


# ---- 의도 기록 ----

def write_intent(job: Path, **value) -> None:
    _atomic_text(job / "intent.json", json.dumps({**value, "at": time.time()}, ensure_ascii=False))


def read_intent(job: Path) -> dict | None:
    try:
        value = json.loads((job / "intent.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


Say = Callable[[str], None]
FIELDS = ("version", "file", "sha256", "size", "created_at")
RESUME_STEPS = ("announce", "announced", "nas")


def resume_source(inst: Installation, from_job: str) -> tuple[dict, dict, dict | None]:
    """멈춘 배포 작업의 (확인 대상 params, 상태, 의도 기록). 배포 작업이 아니면 빈 params."""
    folder = jobs.job_dir(inst, from_job)
    request = jobs.read_json(folder / "request.json") or {}
    plan = request.get("plan") if request.get("kind") == "release-deploy" else None
    params = plan.get("params") if isinstance(plan, dict) and isinstance(plan.get("params"), dict) else {}
    return params, jobs.read_job(inst, from_job), read_intent(folder)


_ALIVE = ("starting", "checking", "running")


def resume_chain(inst: Installation, from_job: str, look: int = 1000) -> tuple[str, ...]:
    """그 배포를 이어 가려다 이미 끝난(죽었거나 실패한) 재개 시도들 — 다음 재개를 막지 않게. 도는 중인 것은 넣지 않는다."""
    chain = []
    for job_id in jobs.recent_jobs(inst, look):
        request = jobs.read_json(jobs.job_dir(inst, job_id) / "request.json") or {}
        params = (request.get("plan") or {}).get("params") or {}
        if request.get("kind") == "release-resume" and params.get("from_job") == from_job and \
                jobs.read_job(inst, job_id).get("status") not in _ALIVE:
            chain.append(job_id)
    return tuple(chain)


def settle_chain(inst: Installation, from_job: str, chain: tuple[str, ...]) -> None:
    """이어서 하기가 서버·NAS 를 다시 읽어 끝냈다 — 멈춘 배포와 앞선 재개 시도의 '결과 확인 필요'를 푼다."""
    for job_id in (from_job, *chain):
        if jobs.needs_check(jobs.read_job(inst, job_id)):
            jobs.acknowledge(inst, job_id)


def find_resumable(inst: Installation, look: int = 30) -> dict | None:
    """가장 최근 배포(또는 이어서 하기)가 끝나지 못했고 의도 기록이 있으면 {job_id, version} — [이어서 하기] 대상."""
    for job_id in jobs.recent_jobs(inst, look):
        request = jobs.read_json(jobs.job_dir(inst, job_id) / "request.json") or {}
        kind = request.get("kind")
        if kind not in ("release-deploy", "release-resume"):
            continue
        state = jobs.read_job(inst, job_id)
        if state.get("status") in _ALIVE or (state.get("status") == "finished" and state.get("exit_code") == 0):
            return None
        source = job_id if kind == "release-deploy" else \
            str(((request.get("plan") or {}).get("params") or {}).get("from_job") or "")
        if not jobs.JOB_ID.fullmatch(source):
            return None
        params, _state, intent = resume_source(inst, source)
        if intent and intent.get("step") in RESUME_STEPS and params:
            return {"job_id": source, "version": params.get("version")}
        return None
    return None


def read_view(inst: Installation, runner: Runner, session: "server_api.Session | None") -> dict:
    """릴리스 화면: NAS 판 목록·두 표지(도우미 자식) + 로그인돼 있으면 서버의 공지 항목 + 이어 갈 배포."""
    source = release_source(inst)
    view = {"source": source, "read": {}, "notices": None, "notice_error": "", "auth_expired": False,
            "resume": find_resumable(inst), "removed_files": removed_files(inst, source)}
    if source:
        view["read"] = helper(inst, scratch_dir(inst), source, "read")
    if session is not None:
        try:
            view["notices"] = list_notices(server_api.verify_server(inst, runner), session.token)
        except (server_api.ServerError, ReleaseError) as exc:
            view["notice_error"], view["auth_expired"] = str(exc), isinstance(exc, server_api.AuthExpired)
    return view


def removed_files(inst: Installation, source: str) -> list[str]:
    """공지 부재를 성공으로 추정하지 않고 이 관리 도구에서 완료한 해제만 표시한다."""
    seen, removed = set(), []
    for job_id in jobs.recent_jobs(inst, 100):
        request = jobs.read_json(jobs.job_dir(inst, job_id) / "request.json") or {}
        kind = request.get("kind")
        if kind not in ("release-remove", "release-deploy", "release-announce", "release-resume", "release-delete"):
            continue
        params = (request.get("plan") or {}).get("params") or {}
        file = str(params.get("file") or "")
        if not file or params.get("release_dir") != source or file in seen:
            continue
        state = jobs.read_job(inst, job_id)
        if state.get("status") != "finished" or state.get("exit_code") != 0:
            continue
        seen.add(file)
        if kind == "release-remove":
            removed.append(file)
    return removed


def _nas(inst: Installation, job: Path, source: str, mode: str, item: dict, expect_published: str,
         expect_candidate: str) -> dict:
    expected = {key: item[key] for key in ("version", "file", "size", "sha256")}
    if mode == "promote":
        return helper(inst, job / "scratch", source, "promote", _b64(expected), timeout=HASH_TIMEOUT)
    return helper(inst, job / "scratch", source, "deploy", _b64(expected), expect_published, expect_candidate,
                  timeout=HASH_TIMEOUT)


def _nas_outcome(answer: dict, announced: bool, say: Say) -> tuple[int, dict]:
    if answer.get("ok"):
        result = answer.get("result") or {}
        state = "already" if result.get("already") else "promoted"
        say(f"완료: v{result.get('version')} — " + ("이미 팀에 배포된 릴리스였습니다(알림만)" if state == "already" else
                                                 "되돌렸습니다" if result.get("rolled_back") else "팀에 배포했습니다"))
        return 0, {"announced": announced, "deploy": state, "rolled_back": bool(result.get("rolled_back")),
                   "version": result.get("version")}
    unknown = int(answer.get("status") or 0) >= 500 or not answer.get("status")
    say(("결과 미확인: " if unknown else "실패: ") + str(answer.get("error")))
    return (3 if unknown else 1), {"announced": announced, "deploy": "unconfirmed" if unknown else "failed",
                                   "error": str(answer.get("error"))[:500], "resumable": announced}


def deploy_work(inst: Installation, job: Path, params: dict, token: str, say: Say) -> tuple[int, dict]:
    """[배포] — 공지 찾기(없으면 등록) → (필요하면) 알림 → 공지 확인 → NAS 표지. 외부 호출 전마다 의도 기록."""
    server, sha = params["server"], params["sha256"]
    announced = False
    try:
        item = find_notice(server, token, sha)
        if item is None:
            say("공지 항목을 등록합니다")
            item = register_notice(server, token, {key: params[key] for key in FIELDS})
        if params.get("announce"):
            write_intent(job, step="announce", notice_id=item["id"], sha256=sha,
                         revision_before=int(item.get("announcement_revision") or 0),
                         expect_published=params["expect_published"], expect_candidate=params["expect_candidate"])
            try:
                revision = announce_notice(server, token, item["id"])
            except server_api.ServerError as exc:
                if isinstance(exc, server_api.AuthExpired):
                    raise
                say(f"결과 미확인: 알림 결과를 확인할 수 없어 배포하지 않았습니다 — {exc}")
                return 3, {"announced": None, "deploy": "not_started", "error": str(exc)[:500], "resumable": True}
            announced = True
            write_intent(job, step="announced", notice_id=item["id"], sha256=sha, revision=revision,
                         revision_before=int(item.get("announcement_revision") or 0),
                         expect_published=params["expect_published"], expect_candidate=params["expect_candidate"])
            say(f"팀원 알림을 보냈습니다({revision}번째)")
        item = find_notice(server, token, sha)
        if item is None or int(item.get("announcement_revision") or 0) < 1:
            say("실패: 공지되지 않은 릴리스는 배포하지 않습니다")
            return 1, {"announced": announced, "deploy": "not_started", "error": "공지되지 않은 릴리스입니다"}
        write_intent(job, step="nas", notice_id=item["id"], sha256=sha,
                     expect_published=params["expect_published"], expect_candidate=params["expect_candidate"])
        say("NAS 표지를 바꿉니다(설치 파일 지문 확인 포함 — 몇 분 걸릴 수 있음)")
    except server_api.ServerError as exc:
        say(f"실패: {exc}")
        return 1, {"announced": announced, "deploy": "not_started", "error": str(exc)[:500], "resumable": announced,
                   "auth_expired": isinstance(exc, server_api.AuthExpired)}
    except ReleaseError as exc:
        say(f"실패: {exc}")
        return 1, {"announced": announced, "deploy": "not_started", "error": str(exc)[:500], "resumable": announced}
    answer = _nas(inst, job, params["release_dir"], params["mode"], item, params["expect_published"],
                  params["expect_candidate"])
    code, extra = _nas_outcome(answer, announced, say)
    if code == 0:
        write_intent(job, step="done", notice_id=item["id"], sha256=sha)
    return code, extra


def resume_work(inst: Installation, job: Path, params: dict, intent: dict, token: str, say: Say) -> tuple[int, dict]:
    """[이어서 하기] — 서버 공지와 NAS 를 다시 읽어 판단한다. 알림을 다시 보내지 않는다."""
    server, sha = params["server"], params["sha256"]
    try:
        item = find_notice(server, token, sha)
    except (server_api.ServerError, ReleaseError) as exc:
        say(f"실패: {exc}")
        return 1, {"deploy": "not_started", "error": str(exc)[:500],
                   "auth_expired": isinstance(exc, server_api.AuthExpired)}
    revision = int((item or {}).get("announcement_revision") or 0)
    # 알림 결과를 모른 채 멈췄으면(step=announce) 그 전 판보다 커야 나간 것이다. 그 뒤 단계면 공지돼 있기만 하면 된다.
    floor = int(intent.get("revision_before") or 0) if intent.get("step") == "announce" else 0
    if item is None or revision <= floor or revision < 1:
        why = "알림이 나가지 않았습니다 — [배포]를 다시 누르세요(새로 확인합니다)"
        say("멈춤: " + why)
        return 1, {"deploy": "not_started", "error": why}
    view = helper(inst, job / "scratch", params["release_dir"], "read")
    if not view.get("ok") or not isinstance(view.get("overview"), dict):
        why = str(view.get("error") or view.get("overview_error") or "릴리스 폴더를 읽지 못했습니다")
        say("멈춤: " + why)
        return 1, {"deploy": "not_started", "error": why[:500]}
    published, candidate = shas(view["overview"])
    old_pub, old_cand = intent.get("expect_published") or "", intent.get("expect_candidate") or ""
    if published == sha:
        say("이미 팀에 배포돼 있습니다 — 끝")
        return 0, {"deploy": "already", "version": item.get("version")}
    if (published, candidate) == (old_pub, old_cand):
        say("NAS 는 그대로입니다 — 표지 바꾸기부터 이어 갑니다")
        answer = _nas(inst, job, params["release_dir"], params["mode"], item, old_pub, old_cand)
    elif candidate == sha and published == old_pub:
        say("후보만 바뀐 상태입니다 — 공개 표지를 마저 바꿉니다")
        answer = _nas(inst, job, params["release_dir"], "deploy", item, old_pub, sha)
    else:
        why = "그 사이 다른 관리자가 릴리스 폴더를 바꿨습니다 — 화면을 다시 확인하세요"
        say("멈춤: " + why)
        return 1, {"deploy": "not_started", "error": why}
    return _nas_outcome(answer, True, say)


def announce_work(params: dict, token: str, say: Say) -> tuple[int, dict]:
    """[재공지] — 알림만(NAS 를 건드리지 않는다)."""
    try:
        revision = announce_notice(params["server"], token, params["notice_id"])
    except (server_api.ServerError, ReleaseError) as exc:
        say(f"실패: {exc}")
        return 1, {"error": str(exc)[:500], "auth_expired": isinstance(exc, server_api.AuthExpired)}
    say(f"완료: 팀원 알림을 다시 보냈습니다({revision}번째) — 배포는 그대로입니다")
    return 0, {"revision": revision}


def remove_work(params: dict, token: str, say: Say) -> tuple[int, dict]:
    """[해제] — 팀원 알림 목록에서만 거둔다(DELETE 만, 배포된 릴리스는 그대로)."""
    try:
        payload = server_api.expect_ok(*server_api.call(params["server"], "DELETE",
                                                        f"{NOTICE_PATH}/{params['notice_id']}", token), "알림 해제")
    except server_api.ServerError as exc:
        say(f"실패: {exc}")
        return 1, {"error": str(exc)[:500], "auth_expired": isinstance(exc, server_api.AuthExpired)}
    say("완료: 알림을 거뒀습니다" if payload.get("removed") else "완료: 이미 없는 알림이었습니다")
    return 0, {"removed": bool(payload.get("removed"))}


def delete_work(inst: Installation, job: Path, params: dict, token: str, say: Say) -> tuple[int, dict]:
    try:
        if find_delete_notice(params["server"], token, params) is not None:
            raise ReleaseError("팀원 알림이 남아 있습니다 — 먼저 [해제]하세요")
    except (server_api.ServerError, ReleaseError) as exc:
        return 1, {"error": str(exc)[:500], "auth_expired": isinstance(exc, server_api.AuthExpired)}
    expected = {key: params[key] for key in (*FIELDS, "sidecars")}
    write_intent(job, step="delete", file=params["file"], sha256=params["sha256"])
    say(f"릴리스 파일을 삭제합니다: {params['file']}")
    answer = helper(inst, job / "scratch", params["release_dir"], "delete", _b64(expected), timeout=HASH_TIMEOUT)
    if not answer.get("ok"):
        say(str(answer.get("error") or "삭제 결과를 확인하지 못했습니다"))
        unknown = answer.get("outcome_unknown") or not answer.get("status") or int(answer["status"]) >= 500
        return (3 if unknown else 1), answer
    if answer.get("deleted") is not True or answer.get("file") != params["file"]:
        return 3, {"error": "삭제 완료 응답이 대상과 일치하지 않습니다", "outcome_unknown": True}
    try:
        if find_delete_notice(params["server"], token, params) is not None:
            return 3, {**answer, "error": "파일은 삭제됐으나 새 팀원 알림이 확인됐습니다 — 해당 알림을 해제하세요"}
    except (server_api.ServerError, ReleaseError) as exc:
        return 3, {**answer, "error": "파일 삭제 후 팀원 알림을 확인하지 못했습니다",
                   "auth_expired": isinstance(exc, server_api.AuthExpired)}
    say(f"완료: v{params['version']} 릴리스 파일을 삭제했습니다")
    return 0, answer


# ---- 주소 공지(NAS server-location.json) ----

def read_location(inst: Installation, scratch: Path, source: str) -> dict:
    """{ok, announcement: {url, revision, name, announced_at} | None(아직 없음)} — 못 읽으면 ok=False."""
    return helper(inst, scratch, source, "location", timeout=LOCATION_TIMEOUT)


def address_problem(url: str, name: str) -> str:
    if not re.fullmatch(r"https?://[^\s/]+(:\d{1,5})?", url.strip().rstrip("/")):
        return "주소는 http://IP:포트 형식이어야 합니다"
    if len(name.strip()) > 64 or any(ord(c) < 32 for c in name):
        return "서버 이름은 제어 문자 없이 64자 이내여야 합니다"
    return ""


def address_work(inst: Installation, job: Path, params: dict, say: Say) -> tuple[int, dict]:
    """[팀에 공지] — 화면이 본 공지 판 그대로인지 다시 읽고 → 판+1 로 쓰고 → 다시 읽어 확인 → 판을 기억."""
    scratch = job / "scratch"
    before = read_location(inst, scratch, params["release_dir"])
    if not before.get("ok"):
        say(f"실패: {before.get('error')}")
        return 1, {"error": str(before.get("error"))[:500]}
    seen = int((before.get("announcement") or {}).get("revision") or 0)
    if seen != int(params.get("revision_seen") or 0):
        say("실패: 그 사이 공지 파일이 바뀌었습니다 — 화면을 다시 확인하세요")
        return 1, {"error": "그 사이 공지 파일이 바뀌었습니다"}
    last = max(seen, int(read_state(inst).get("last_published_revision") or 0))
    say(f"공지 파일을 씁니다(판 {last + 1})")
    answer = helper(inst, scratch, params["release_dir"], "publish", params["url"], params["name"], str(last),
                    timeout=LOCATION_TIMEOUT)
    if not answer.get("ok"):
        say(f"실패: {answer.get('error')}")
        return 1, {"error": str(answer.get("error"))[:500]}
    after = read_location(inst, scratch, params["release_dir"])
    written = (after.get("announcement") or {}) if after.get("ok") else {}
    mine = answer.get("announcement") or {}
    if written.get("revision") != mine.get("revision") or written.get("url") != mine.get("url"):
        say("결과 미확인: 쓴 뒤 다시 읽은 공지가 다릅니다")
        return 3, {"error": "쓴 뒤 다시 읽은 공지가 다릅니다", "announcement": mine}
    write_state(inst, last_published_revision=int(mine["revision"]), server_name=params["name"])
    say(f"완료: 팀에 공지했습니다(판 {mine['revision']}) — 팀원 앱에 알림이 뜨고, 누르면 새 주소로 바뀝니다")
    return 0, {"announcement": mine}
