"""관리 창에서 할 수 있는 일의 고정 목록. 대상 계산·거절 이유·확인 문구·실행 명령이 여기 한 곳에 있다.

판단 로직(업데이트 자격·전환 안전)은 기존 도구에 있고, 여기는 부를지 말지와 무엇을 부를지만 정한다.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace

from .backup import task_problems
from .install import Installation, Runner, powershell_exe, trusted_git

ACTIONS = {"git-update": "Git 업데이트", "tools-update": "관리 도구 갱신", "console-rollback": "이전 관리 창으로",
           "intake-set": "생성 접수 바꾸기", "backup-save": "백업 복사 위치 저장(시험 복사)", "backup-run": "지금 복사",
           "release-deploy": "릴리스 배포", "release-resume": "배포 이어서 하기", "release-announce": "재공지",
           "release-remove": "알림 해제", "address-notice": "팀에 주소 공지"}
# 관리자 로그인이 필요한 작업 — 화면은 이것만 토큰을 파이프로 넘기고, 실행기는 이것만 토큰을 읽는다.
AUTH_KINDS: frozenset[str] = frozenset({"intake-set", "release-deploy", "release-resume", "release-announce",
                                        "release-remove"})


@dataclass(frozen=True)
class Plan:
    kind: str
    root: str
    role: str
    reference_commit: str          # 확인 창에 보인 '지금 보이는 최신' — 고정 대상이 아니다
    summary: tuple[str, ...]
    warnings: tuple[str, ...] = ()  # 진행은 막지 않고 화면에 알리기만 하는 것(권한)
    params: dict = field(default_factory=dict)  # 동작별 확인 대상 — 실행기가 실행 직전에 같은지 다시 비교한다

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, value: dict) -> "Plan":
        params = value.get("params") or {}
        return cls(kind=str(value["kind"]), root=str(value["root"]), role=str(value["role"]),
                   reference_commit=str(value.get("reference_commit") or ""),
                   summary=tuple(str(s) for s in value.get("summary") or ()),
                   warnings=tuple(str(s) for s in value.get("warnings") or ()),
                   params=dict(params) if isinstance(params, dict) else {"invalid": True})


@dataclass(frozen=True)
class Refusal:
    reasons: tuple[str, ...]


_TASK_REASONS = {
    "missing": "이 PC 에는 서버 예약 작업(MVHub Server)이 없습니다 — 서버 PC 에서만 업데이트합니다",
    "other": "서버 예약 작업이 이 폴더가 아닌 다른 설치를 가리킵니다",
    "unknown": "서버 예약 작업을 확인하지 못했습니다",
}
_PROBLEM_REASONS = {
    "stage_copy": "stage 사본 안에서 열린 관리 창입니다 — 서버 루트의 바로가기로 여세요",
    "not_git_clone": "이 폴더는 Git 클론이 아닙니다",
    "missing_updater": "업데이트 도구(tools\\run_update_git.ps1)가 없습니다",
    "no_runtime_python": "등록된 Python 기록(.mvhub-runtime\\python.txt)이 없습니다 — 자동시작 등록을 먼저 하세요",
}


def plan_git_update(inst: Installation, task_match: str, traces: list[tuple[str, str]],
                    acl_offenders: list[tuple[str, str, str]] | None, reference_commit: str = "",
                    unresolved_jobs: list[str] | None = ()) -> Plan | Refusal:
    """unresolved_jobs: 진행 중·결과 미확인 작업 ID. None = 조회 실패(거절). acl_offenders 는 알림만(acl_warnings)."""
    reasons = [_PROBLEM_REASONS[p] for p in inst.problems if p in _PROBLEM_REASONS]
    if unresolved_jobs is None:
        reasons.append("지난 업데이트 작업 기록을 확인하지 못했습니다(logs\\console-jobs)")
    for job_id in unresolved_jobs or []:
        reasons.append(f"이전 작업({job_id[:8]})이 진행 중이거나 결과를 확인하지 않았습니다 — 업데이트 화면에서 결과를 확인하세요")
    if task_match != "match":
        reasons.append(_TASK_REASONS.get(task_match, _TASK_REASONS["unknown"]))
    for _kind, text in traces:
        reasons.append(f"업데이트 흔적: {text} — 결과 확인 필요")
    if reasons:
        return Refusal(tuple(reasons))
    return Plan("git-update", str(inst.root), "server", reference_commit, _summary(inst, reference_commit),
                acl_warnings(acl_offenders))


def acl_warnings(acl_offenders: list[tuple[str, str, str]] | None) -> tuple[str, ...]:
    """권한 검사 결과 → 알림 문구. Jay 결정(2026-10-23): 권한은 업데이트를 막지 않고 알리기만 한다
    (기존 update_git.bat 처럼 단추만 누르면 진행 — 같은 계정의 승격 안 된 프로그램이 코드를 바꿀 위험은 감수)."""
    if acl_offenders is None:
        return ("설치 폴더 권한을 확인하지 못했습니다(진행에는 영향 없음)",)
    if not acl_offenders:
        return ()
    shown = ", ".join(f"{path} ({why} {sid})" for path, sid, why in acl_offenders[:3])
    more = f" 외 {len(acl_offenders) - 3}건" if len(acl_offenders) > 3 else ""
    return (f"관리자가 아닌 계정도 고칠 수 있는 파일이 있습니다(진행에는 영향 없음): {shown}{more}",)


def _summary(inst: Installation, reference_commit: str) -> tuple[str, ...]:
    shown_commit = reference_commit[:8] if reference_commit else "확인 못 함"
    return (
        f"{inst.root} 서버를 실행 시점의 최신 origin/main 으로 업데이트합니다.",
        f"지금 보이는 최신 main: {shown_commit} (참고 — 실제 설치 커밋은 실행 때 정해지고 결과에 표시됩니다)",
        "옆에서 새 코드를 준비·시험한 뒤 마지막에 서버를 잠깐 멈추고 바꿔 끼웁니다(약 3~5분, 약 30초 끊김).",
        "실패하면 이전 코드로 저절로 돌아갑니다. 이 창을 닫아도 업데이트는 끝까지 진행됩니다.",
    )


def with_reference(plan: Plan, inst: Installation, reference_commit: str) -> Plan:
    """검사를 통과한 계획에만 참고 커밋을 붙인다 — 거절될 Git 을 먼저 실행하지 않게."""
    return replace(plan, reference_commit=reference_commit, summary=_summary(inst, reference_commit))


def same_target(confirmed: Plan, current: Plan) -> bool:
    # 커밋은 비교하지 않는다 — coordinator 가 실행 때 직접 fetch 해 고른다(server_release_update.py:169).
    # 동작별 확인 대상(params)은 그대로 같아야 한다(2단계 설계 3판 0).
    return ((confirmed.kind, confirmed.root, confirmed.role, confirmed.params)
            == (current.kind, current.root, current.role, current.params))


def _common_refusals(inst: Installation, traces: list[tuple[str, str]], unresolved_jobs: list[str] | None) -> list[str]:
    reasons = [_PROBLEM_REASONS[p] for p in inst.problems if p in _PROBLEM_REASONS and p != "missing_updater"]
    if unresolved_jobs is None:
        reasons.append("지난 작업 기록을 확인하지 못했습니다(logs\\console-jobs)")
    for job_id in unresolved_jobs or []:
        reasons.append(f"이전 작업({job_id[:8]})이 진행 중이거나 결과를 확인하지 않았습니다 — 업데이트 화면에서 결과를 확인하세요")
    for _kind, text in traces:
        reasons.append(f"업데이트 흔적: {text}")
    return reasons


def plan_tools_update(inst: Installation, traces: list[tuple[str, str]],
                      unresolved_jobs: list[str] | None = ()) -> Plan | Refusal:
    """관리 창 코드만 실행 시점의 최신 origin/main 판으로(관리 창 전용 stage). 서버·서버 폴더는 그대로."""
    reasons = _common_refusals(inst, traces, unresolved_jobs)
    if reasons:
        return Refusal(tuple(reasons))
    summary = (
        "관리 창 코드를 실행 시점의 최신 origin/main 으로 바꿉니다(받은 커밋은 결과에 표시됩니다).",
        "서버와 서버 폴더는 그대로입니다 — 서버가 멈추지 않습니다.",
        "새 관리 창을 따로 꺼내 시작 점검을 통과해야 바꿉니다. 끝나면 관리 창을 다시 열면 적용됩니다.",
    )
    return Plan("tools-update", str(inst.root), "console", "", summary)


def plan_console_rollback(inst: Installation, pointer: dict | None, traces: list[tuple[str, str]],
                          unresolved_jobs: list[str] | None = ()) -> Plan | Refusal:
    """직전 관리 창 stage 로 되돌리기 — 지금 포인터(from)와 되돌릴 곳(to)을 확인 대상으로."""
    reasons = _common_refusals(inst, traces, unresolved_jobs)
    previous = (pointer or {}).get("previous")
    if not pointer or not previous:
        reasons.append("되돌릴 이전 관리 창이 없습니다")
    if reasons:
        return Refusal(tuple(reasons))
    summary = (f"관리 창을 이전 판 {previous[:12]} 로 되돌립니다(지금 {pointer['sha'][:12]}).",
               "서버와 서버 폴더는 그대로입니다. 끝나면 관리 창을 다시 열면 적용됩니다.")
    return Plan("console-rollback", str(inst.root), "console", "", summary,
                params={"from_sha": pointer["sha"], "to_sha": previous})


def plan_intake_set(inst: Installation, server: dict, paused_now: bool, want: bool) -> Plan | Refusal:
    """생성 접수 멈추기/다시 받기 — 확인 대상 = 확인한 서버·바꾸기 전 서버 값·원하는 값(실행 직전에 다시 비교).
    업데이트 흔적·미확인 작업으로는 막지 않는다 — 접수는 업데이트와 따로, 언제든 다시 받을 수 있어야 한다."""
    reasons = [_PROBLEM_REASONS[p] for p in inst.problems if p in ("stage_copy", "no_runtime_python")]
    if not isinstance(want, bool) or not isinstance(paused_now, bool):
        reasons.append("바꿀 값을 알 수 없습니다")
    elif paused_now == want:
        reasons.append(f"서버 값이 이미 '{'멈춤' if want else '받는 중'}' 입니다")
    if reasons:
        return Refusal(tuple(reasons))
    if want:
        summary = ("팀원의 새 생성 요청 접수를 멈춥니다(이미 시작된 생성은 끝까지 갑니다).",
                   "팀원 앱에는 '배포 준비로 새 생성 요청을 잠시 중지했습니다' 안내가 뜹니다.",
                   "서버를 다시 켜도 저절로 풀리지 않습니다 — 배포가 끝나면 이 화면에서 [다시 받기]를 누르세요.")
    else:
        summary = ("새 생성 요청을 다시 받습니다.", "팀원 앱에서 바로 새 생성을 보낼 수 있습니다.")
    return Plan("intake-set", str(inst.root), "server", "", summary,
                params={"server": dict(server), "from": paused_now, "paused": want})


def _job_refusals(inst: Installation, unresolved_jobs: list[str] | None, exclude: str = "") -> list[str]:
    """2단계 작업 공통: 사본 실행·등록 Python 없음·미확인 작업(exclude 는 이어서 하는 그 작업)."""
    reasons = [_PROBLEM_REASONS[p] for p in inst.problems if p in ("stage_copy", "no_runtime_python")]
    if unresolved_jobs is None:
        reasons.append("지난 작업 기록을 확인하지 못했습니다(logs\\console-jobs)")
    return reasons + [f"이전 작업({job_id[:8]})이 진행 중이거나 결과를 확인하지 않았습니다"
                      for job_id in unresolved_jobs or [] if job_id != exclude]


def _backup_refusals(inst: Installation, view: dict, unresolved_jobs: list[str] | None) -> list[str]:
    """백업 작업 공통: 미확인 작업·지원 안 하는 경로·설정 읽기 실패·예약 작업 조건(backup.task_problems)."""
    reasons = _job_refusals(inst, unresolved_jobs)
    reasons += [r for r in (view.get("unsupported"), view.get("error")) if r]
    return reasons + task_problems(view.get("task"))


def _norm_target(value) -> str:
    return str(value or "").strip().rstrip("\\/").casefold()


def plan_backup_save(inst: Installation, view: dict, target: str, unresolved_jobs: list[str] | None = ()
                     ) -> Plan | Refusal:
    """백업 복사 위치를 바꾸고 시험 복사 — 확인 대상 = 바꾸기 전 위치(지문)·새 위치."""
    reasons = _backup_refusals(inst, view, unresolved_jobs)
    setting = view.get("setting") or {}
    target = (target or "").strip()
    if setting.get("source") == "env":
        reasons.append("서버 기계 설정값 CONTENT_HUB_BACKUP_REPLICA_DIR 로 정해져 있어 여기서 바꾸지 않습니다")
    if not target:
        reasons.append("복사 위치(\\\\NAS\\공유폴더\\…)를 적으세요")
    elif _norm_target(target) == _norm_target(setting.get("target")):
        reasons.append("지금 위치와 같습니다 — [지금 복사]를 쓰세요")
    if reasons:
        return Refusal(tuple(reasons))
    summary = (f"백업 복사 위치를 {target} 로 바꾸고 시험 복사합니다(지금: {setting.get('target') or '없음'}).",
               "먼저 이 관리자 계정으로 그 위치에 쓸 수 있는지 확인합니다(20초 안).",
               "저장한 뒤 예약 작업(SYSTEM)으로 한 번 복사해 이번 결과만 확인합니다 — 첫 복사는 오래 걸릴 수 있습니다(창을 닫아도 계속).",
               "복사가 실패해도 새 위치는 저장된 채로 두고 이유와 [이전 위치로 되돌리기]를 보여 줍니다.")
    return Plan("backup-save", str(inst.root), "server", "", summary,
                params={"old_target": setting.get("target"), "old_id": setting.get("target_id"), "target": target})


def plan_backup_run(inst: Installation, view: dict, unresolved_jobs: list[str] | None = ()) -> Plan | Refusal:
    """지금 위치로 예약 작업 한 번 — 확인 대상 = 위치 지문."""
    reasons = _backup_refusals(inst, view, unresolved_jobs)
    setting = view.get("setting") or {}
    if not setting.get("target_id"):
        reasons.append("복사 위치가 없습니다 — 먼저 위치를 저장하세요")
    if reasons:
        return Refusal(tuple(reasons))
    summary = (f"지금 위치({setting.get('target')})로 백업을 한 번 복사합니다(예약 작업 SYSTEM — 창을 닫아도 계속).",
               "이번 실행의 결과만 확인해 보여 줍니다. 대상의 오래된 백업은 최근 30개만 남기고 정리됩니다.")
    return Plan("backup-run", str(inst.root), "server", "", summary, params={"target_id": setting["target_id"]})


def _release_refusals(inst: Installation, source: str, view: dict, unresolved_jobs: list[str] | None) -> list[str]:
    """릴리스 공통: 미확인 작업 · 릴리스 폴더 · 두 표지를 모두 읽었는지(웹의 deployBlocked 와 같게)."""
    reasons = _job_refusals(inst, unresolved_jobs)
    if not source:
        reasons.append("NAS 릴리스 폴더를 먼저 정하세요")
    overview = view.get("overview")
    if not isinstance(overview, dict):
        reasons.append(str(view.get("overview_error") or view.get("error") or "릴리스 폴더를 읽지 못했습니다"))
    elif overview.get("candidate_error"):
        reasons.append("NAS 의 후보 파일(candidate.json)을 읽을 수 없습니다 — 릴리스를 다시 만들어 올리세요")
    elif overview.get("published_state") == "error":
        reasons.append("팀 공개 표지(latest.json)를 읽을 수 없어 배포 상태를 확인할 수 없습니다")
    return reasons


def plan_release_deploy(inst: Installation, server: dict, source: str, view: dict, fields: dict,
                        notice: dict | None, unresolved_jobs: list[str] | None = ()) -> Plan | Refusal:
    """[배포] — 확인 대상 = 서버·릴리스 폴더·릴리스(지문)·화면이 본 두 표지 sha. 후보 줄은 promote, 그 밖은 deploy.
    이미 공지된 후보(공지됨·아직 배포 안 됨)는 알림을 다시 보내지 않는다(웹 [배포 반영]과 같게)."""
    reasons = _release_refusals(inst, source, view, unresolved_jobs)
    sha = str(fields.get("sha256") or "")
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        reasons.append("릴리스 지문을 확인하지 못했습니다")
    if reasons:
        return Refusal(tuple(reasons))
    overview = view["overview"]
    published = str((overview.get("published") or {}).get("sha256") or "")
    candidate = str(overview.get("sha256") or "") if overview.get("source") == "candidate" else ""
    is_candidate = bool(candidate) and sha == candidate and overview.get("pending") is True
    waiting = is_candidate and int((notice or {}).get("announcement_revision") or 0) > 0
    pub_version = str((overview.get("published") or {}).get("version") or "")
    older = bool(pub_version) and str(fields.get("version")) < pub_version and sha != published
    if sha == published:
        summary = (f"v{fields.get('version')} 은(는) 이미 팀에 배포된 릴리스입니다 — 팀원 알림만 다시 보냅니다.",)
    elif waiting:
        summary = (f"이미 알림이 나간 v{fields.get('version')} 을(를) 팀에 마저 배포합니다(알림은 다시 보내지 않음).",)
    elif older:
        summary = (f"v{fields.get('version')} 으로 되돌립니다 — 팀원 PC 가 지금(v{pub_version})보다 옛 릴리스로 내려갑니다.",
                   "DB 변경은 되돌아가지 않습니다.")
    else:
        summary = (f"v{fields.get('version')} 을(를) 팀에 배포합니다 — 팀원에게 알림이 가고 그 릴리스로 업데이트됩니다.",)
    if candidate and not is_candidate and sha != candidate and overview.get("pending") is True:
        summary += (f"배포 전 후보 v{overview.get('version')} 는 후보에서 내려옵니다(목록에는 남습니다).",)
    summary += ("알림 → 공지 확인 → NAS 표지 순서로 하고, 중간에 끊기면 [이어서 하기]로 다시 읽어 이어 갑니다(알림을 다시 보내지 않음).",
                "배포 순서: 생성 접수 멈추기 → 서버 Git 업데이트 → [배포] → 팀원 업데이트 뒤 생성 접수 다시 받기.")
    params = {"server": dict(server), "release_dir": source, **{k: fields[k] for k in ("version", "file", "sha256",
                                                                                       "size", "created_at")},
              "mode": "promote" if is_candidate else "deploy", "announce": not waiting,
              "expect_published": published, "expect_candidate": candidate}
    return Plan("release-deploy", str(inst.root), "server", "", summary, params=params)


def plan_release_resume(inst: Installation, server: dict, source: str, from_job: str, from_params: dict,
                        from_state: dict, intent: dict | None, unresolved_jobs: list[str] | None = ()
                        ) -> Plan | Refusal:
    """[이어서 하기] — 멈춘 배포의 의도 기록에서 이어 간다(그 작업 자체는 미확인 목록에서 뺀다).
    표지 상태는 실행기가 다시 읽어 판단한다(이어 갈지·멈출지는 resume_work)."""
    reasons = _job_refusals(inst, unresolved_jobs, exclude=from_job)
    if not source:
        reasons.append("NAS 릴리스 폴더를 먼저 정하세요")
    if from_state.get("status") in ("starting", "checking", "running"):
        reasons.append("그 배포가 아직 진행 중입니다")
    elif from_state.get("status") == "finished" and from_state.get("exit_code") == 0:
        reasons.append("그 배포는 이미 끝났습니다")
    if not intent or intent.get("step") not in ("announce", "announced", "nas"):
        reasons.append("이어 갈 배포 기록이 없습니다 — [배포]를 다시 누르세요")
    if from_params.get("release_dir") != source:
        reasons.append("NAS 릴리스 폴더가 그 배포 때와 다릅니다")
    if reasons:
        return Refusal(tuple(reasons))
    summary = (f"멈춘 배포(v{from_params.get('version')})를 이어 갑니다 — 서버 공지와 NAS 표지를 다시 읽어 판단합니다.",
               "알림은 다시 보내지 않습니다. 다른 관리자가 그 사이 바꿨으면 멈추고 알려 줍니다.")
    params = {"server": dict(server), "release_dir": source, "from_job": from_job,
              **{k: from_params[k] for k in ("version", "file", "sha256", "size", "created_at", "mode")}}
    return Plan("release-resume", str(inst.root), "server", "", summary, params=params)


def plan_notice_action(inst: Installation, kind: str, server: dict, notice: dict | None, sha: str,
                       unresolved_jobs: list[str] | None = ()) -> Plan | Refusal:
    """[재공지](알림만) · [해제](알림 목록에서만) — 확인 대상 = 서버·공지 ID·sha."""
    reasons = _job_refusals(inst, unresolved_jobs)
    if not notice or notice.get("sha256") != sha:
        reasons.append("이 릴리스의 공지 항목이 없습니다 — [배포]로 알림을 보내세요")
    if reasons:
        return Refusal(tuple(reasons))
    version = notice.get("version")
    summary = ((f"v{version} 알림을 팀원에게 다시 보냅니다 — 배포(NAS 표지)는 그대로입니다.",) if kind == "release-announce"
               else (f"v{version} 알림을 팀원 알림 목록에서 거둡니다 — 배포된 릴리스와 목록 줄은 그대로입니다.",))
    return Plan(kind, str(inst.root), "server", "", summary,
                params={"server": dict(server), "notice_id": notice["id"], "sha256": sha})


def plan_address_notice(inst: Installation, source: str, location: dict, url: str, name: str,
                        unresolved_jobs: list[str] | None = ()) -> Plan | Refusal:
    """[팀에 공지] — 확인 대상 = 릴리스 폴더·화면이 본 공지 판·주소·이름."""
    from .release import address_problem  # 늦게 — release → server_api → jobs → actions 순환을 피한다
    reasons = _job_refusals(inst, unresolved_jobs)
    if not source:
        reasons.append("NAS 릴리스 폴더를 먼저 정하세요(릴리스 화면)")
    if not location.get("ok"):
        reasons.append(f"지금 공지 파일을 읽지 못했습니다 — {location.get('error') or '이유 모름'}")
    problem = address_problem(url, name)
    if problem:
        reasons.append(problem)
    if reasons:
        return Refusal(tuple(reasons))
    seen = int((location.get("announcement") or {}).get("revision") or 0)
    url = url.strip().rstrip("/")
    summary = (f"팀에 서버 주소 {url} 를 공지합니다(이름: {name.strip() or '없음 — 주소로 보임'}).",
               "NAS 릴리스 폴더의 server-location.json 을 다음 판으로 씁니다 → 팀원 앱에 알림이 뜨고, 누르면 새 주소로 바뀝니다(자동 전환 아님).",
               "공지는 이 관리 창 한 곳에서만 내세요(옛 앱의 [팀에 공지]와 겹치면 판이 엇갈립니다).")
    return Plan("address-notice", str(inst.root), "server", "", summary,
                params={"release_dir": source, "revision_seen": seen, "url": url, "name": name.strip()})


def command_for(plan: Plan, inst: Installation) -> list[str]:
    if plan.kind != "git-update" or plan.root != str(inst.root):
        raise ValueError("unknown or foreign action")
    return [str(powershell_exe()), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(inst.root / "tools" / "run_update_git.ps1"), "-Root", str(inst.root), "-NoPause"]


def reference_main(inst: Installation, runner: Runner) -> str:
    """원격 main 의 지금 커밋(참고용). 못 읽으면 ''."""
    git = trusted_git()
    if git is None:
        return ""
    code, out = runner([str(git), "-C", str(inst.root), "ls-remote", "origin", "refs/heads/main"], 20)
    head = out.split()[0] if code == 0 and out.split() else ""
    return head if len(head) == 40 and all(c in "0123456789abcdef" for c in head) else ""
