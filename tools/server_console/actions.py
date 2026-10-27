"""관리 창에서 할 수 있는 일의 고정 목록. 대상 계산·거절 이유·확인 문구·실행 명령이 여기 한 곳에 있다.

판단 로직(업데이트 자격·전환 안전)은 기존 도구에 있고, 여기는 부를지 말지와 무엇을 부를지만 정한다.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace

from . import names
from .backup import task_problems
from .install import Installation, Runner, network_path, powershell_exe, trusted_git

ACTIONS = {"git-update": "Git 업데이트", "tools-update": "관리 도구 갱신", "console-rollback": "이전 관리 창으로",
           "intake-set": "생성 접수 바꾸기", "backup-save": "백업 복사 위치 저장(시험 복사)", "backup-run": "지금 복사",
           "release-deploy": "릴리스 배포", "release-resume": "배포 이어서 하기", "release-announce": "재공지",
           "release-remove": "알림 해제", "address-notice": "팀에 주소 공지",
           "server-stop": "서버 끄기", "server-start": "서버 켜기", "server-restart": "서버 다시 켜기",
           "server-autostart": "자동시작 다시 등록", "backup-drill": "백업 확인(복원 연습)",
           "move-rehearsal": "연습 내보내기", "move-out": "진짜 이사 내보내기", "move-undo": "이사 되돌리기(UNDO)",
           "move-restore": "백업으로 복구"}
POWER_KINDS = ("server-stop", "server-start", "server-restart", "server-autostart")
# 실행기가 새 콘솔 창의 감싸개(console_run.py)를 띄워 기다리는 이사 계열 — 판정은 감싸개의 결과 파일·생사(jobs.read_job).
MOVE_KINDS = ("move-rehearsal", "move-out", "move-undo", "move-restore")
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


def plan_intake_set(inst: Installation, server: dict, paused_now: bool, want: bool,
                    moving: bool = False) -> Plan | Refusal:
    """생성 접수 멈추기/다시 받기 — 확인 대상 = 확인한 서버·바꾸기 전 서버 값·원하는 값(실행 직전에 다시 비교).
    업데이트 흔적·미확인 작업으로는 막지 않는다 — 접수는 업데이트와 따로, 언제든 다시 받을 수 있어야 한다.
    단 서버 이사 진행 중(moving)에는 거절 — OUT 이 접수를 멈춘 사이 다시 열면 이사 중 생성이 들어온다(설계 3판)."""
    reasons = [_PROBLEM_REASONS[p] for p in inst.problems if p in ("stage_copy", "no_runtime_python")]
    if moving:
        reasons.append("서버 이사가 진행 중입니다 — 이사가 끝난 뒤(또는 되돌린 뒤) 바꾸세요")
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


def _job_refusals(inst: Installation, unresolved_jobs: list[str] | None, exclude: tuple[str, ...] = ()) -> list[str]:
    """2단계 작업 공통: 사본 실행·등록 Python 없음·미확인 작업(exclude 는 이어서 하는 그 배포와 그 재개 시도들)."""
    reasons = [_PROBLEM_REASONS[p] for p in inst.problems if p in ("stage_copy", "no_runtime_python")]
    if unresolved_jobs is None:
        reasons.append("지난 작업 기록을 확인하지 못했습니다(logs\\console-jobs)")
    return reasons + [f"이전 작업({job_id[:8]})이 진행 중이거나 결과를 확인하지 않았습니다 — 업데이트 화면에서 확인하세요"
                      for job_id in unresolved_jobs or [] if job_id not in exclude]


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
    typed = (target or "").strip()
    target, why = network_path(typed)  # 예약 작업(SYSTEM)에는 Z: 가 안 보인다 — 실제 주소로
    if setting.get("source") == "env":
        reasons.append("서버 기계 설정값 CONTENT_HUB_BACKUP_REPLICA_DIR 로 정해져 있어 여기서 바꾸지 않습니다")
    if why:
        reasons.append(why)
    elif not target:
        reasons.append("복사 위치(\\\\NAS\\공유폴더\\…)를 적으세요")
    elif _norm_target(target) == _norm_target(setting.get("target")):
        reasons.append("지금 위치와 같습니다 — [지금 복사]를 쓰세요")
    if reasons:
        return Refusal(tuple(reasons))
    summary = (f"백업 복사 위치를 {target} 로 바꾸고 시험 복사합니다(지금: {setting.get('target') or '없음'}).",
               *((f"{typed[:2]} 는 예약 작업(SYSTEM)에 보이지 않아 실제 주소로 바꿔 저장합니다.",) if target != typed else ()),
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
                        from_state: dict, intent: dict | None, unresolved_jobs: list[str] | None = (),
                        chain: tuple[str, ...] = ()) -> Plan | Refusal:
    """[이어서 하기] — 멈춘 배포의 의도 기록에서 이어 간다. 그 배포와 이미 끝난(죽었거나 실패한) 그 배포의 재개 시도(chain)는
    미확인 목록에서 뺀다 — 아직 도는 재개는 빼지 않는다. 표지 상태는 실행기가 다시 읽어 판단한다(resume_work)."""
    reasons = _job_refusals(inst, unresolved_jobs, exclude=(from_job, *chain))
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


def _blockers(ready_payload) -> str:
    """서버가 /api/ready 로 알리는 진행 중인 일(확인 창 경고용 — 판정에는 쓰지 않는다)."""
    runtime = (ready_payload or {}).get("runtime") if isinstance(ready_payload, dict) else None
    runtime = runtime if isinstance(runtime, dict) else {}
    blockers = runtime.get("update_blockers") if isinstance(runtime.get("update_blockers"), dict) else {}
    parts = [f"{label} {blockers.get(key)}" for key, label in (("generation", "생성"), ("resolve", "Resolve"),
                                                               ("comfy", "Comfy")) if blockers.get(key)]
    if runtime.get("active_http"):
        parts.append(f"요청 {runtime.get('active_http')}")
    return " · ".join(str(p) for p in parts)


def _off_params(inst: Installation) -> tuple[str, dict | None, list[str]]:
    from .power import read_off  # 늦게 — power → server_api → jobs → actions 순환을 피한다
    state, off = read_off(inst)
    reasons = ["관리 창의 끈 기록(logs\\console-server-off.json)을 읽지 못했습니다 — 수동 확인"] if state == "bad" else []
    return (f"{off['phase']}:{off['job_id']}" if off else ""), off, reasons


def plan_power(inst: Installation, kind: str, tasks: dict | None, traces: list[tuple[str, str]],
               unresolved: list[str] | None, ready_payload=None) -> Plan | Refusal:
    """[끄기]·[켜기]·[다시 켜기] — 확인 대상 = 두 작업의 켜짐 여부·끈 기록(설계 B-1). 실행기가 잠금 안에서 다시 본다."""
    from .power import common_refusals
    reasons = common_refusals(inst, kind, tasks, traces, unresolved)
    off_key, _off, off_reasons = _off_params(inst)
    reasons += off_reasons
    enabled = {name: ((tasks or {}).get(name) or {}).get("state") not in ("Disabled", "Missing", None)
               for name in (names.TASK_SERVER, names.TASK_WATCHDOG)}
    if kind == "server-restart" and tasks is not None and not all(enabled.values()):
        reasons.append("꺼 둔 예약 작업이 있습니다 — [켜기]를 쓰세요")
    if reasons:
        return Refusal(tuple(reasons))
    busy = _blockers(ready_payload)
    cut = (f"지금 서버에서 진행 중: {busy} — 끊깁니다. 먼저 생성 접수를 멈추고 0 이 될 때 하길 권합니다."
           if busy else "팀원 앱의 서버 연결이 잠시 끊깁니다(생성 접수를 먼저 멈추면 안전합니다).")
    summary = {
        "server-stop": ("서버를 끕니다 — 예약 작업(Server·Watchdog)을 끄고 이 설치 서버 프로세스를 정리합니다.", cut,
                        "꺼진 동안은 Git 업데이트를 할 수 없고, 재부팅해도 켜지지 않습니다. 다시 켤 때는 [켜기].",
                        "NAS 복사 예약(BackupCopy)은 그대로 둡니다."),
        "server-start": ("서버를 켭니다 — Server·Watchdog 를 둘 다 켜고 시작한 뒤 서버 신원·응답을 확인합니다(최대 약 3분).",
                         "이미 정상으로 돌고 있으면 서버는 그대로 두고 꺼진 작업만 켭니다."),
        "server-restart": ("서버를 다시 켭니다 — 끄기 → 켜기를 한 작업으로(약 1~3분).", cut),
    }[kind]
    return Plan(kind, str(inst.root), "server", "", summary, params={"enabled": enabled, "off": off_key})


def plan_autostart(inst: Installation, tasks: dict | None, traces: list[tuple[str, str]],
                   unresolved: list[str] | None) -> Plan | Refusal:
    """[자동시작 다시 등록](설치·복구) — 예약 작업 3개를 이 설치로 다시 만들고 서버를 다시 켠다(설계 B-3)."""
    from .power import PowerError, common_refusals, register_command
    reasons = common_refusals(inst, "server-autostart", tasks, traces, unresolved) + _off_params(inst)[2]
    try:
        register_command(inst)
    except PowerError as exc:
        reasons.append(str(exc))
    if reasons:
        return Refusal(tuple(reasons))
    summary = ("자동시작을 다시 등록합니다(설치·복구용) — 먼저 이 설치 서버를 끈 뒤 register_autostart.bat 을 실행합니다.",
               "예약 작업 3개(Server·Watchdog·BackupCopy)를 이 설치로 다시 만듭니다 — 꺼 둔 작업도 켜집니다.",
               f"Python 기록은 지금 값({inst.python})으로 고정해 다시 씁니다. Node 위치도 다시 찾아 씁니다.",
               "서버를 바로 다시 켜고(팀 연결이 잠시 끊김), NAS 복사 위치가 있으면 복사를 한 번 돌립니다.",
               "중간에 실패하면 무엇이 바뀌었는지 보여 줍니다(최대 10분).")
    return Plan("server-autostart", str(inst.root), "server", "", summary,
                params={"python": str(inst.python), "port": inst.port})


def plan_drill(inst: Installation, selection: dict | None, unresolved: list[str] | None = ()) -> Plan | Refusal:
    """[이 백업 확인] — 확인 대상 = 백업 루트·상대 폴더·stamp(실행기가 같은 세트를 다시 찾는다, 설계 B-2)."""
    from .backup import BackupError, find_set
    reasons = _job_refusals(inst, unresolved)
    if not selection:
        reasons.append("확인할 백업을 목록에서 고르세요")
    else:
        try:
            find_set(inst, selection)
        except BackupError as exc:
            reasons.append(str(exc))
    if reasons:
        return Refusal(tuple(reasons))
    mb = (selection.get("bytes") or 0) / 1_000_000
    summary = (f"백업 {selection['stamp']}(약 {mb:,.0f} MB)을 임시 폴더에 복원해 격리 서버로 로그인까지 확인합니다.",
               "지금 서버와 실제 DB 는 그대로입니다. 임시 폴더(작업 기록 안)에 DB 사본이 생기고 끝나면 지웁니다.",
               "검증은 서버 루트 코드로 합니다(지금 도는 stage 코드와의 호환 확인은 아닙니다). 몇 분 걸릴 수 있습니다.")
    return Plan("backup-drill", str(inst.root), "server", "", summary,
                params={key: selection[key] for key in ("root", "folder", "stamp")})


def plan_move(inst: Installation, kind: str, tasks: dict | None, traces: list[tuple[str, str]],
              unresolved: list[str] | None, selection: dict | None = None,
              stopped: list[str] | None = None) -> Plan | Refusal:
    """서버 이사(설계 D) — 새 콘솔 창에서 기존 도구를 사람이 답하며 진행. 확인 대상 = 데이터 폴더·포트(+복구는 세트)."""
    from .backup import BackupError, find_set, unsupported_paths
    from .install import machine_env
    from .power import common_refusals
    reasons = common_refusals(inst, kind, tasks, traces, unresolved)
    _key, off, off_reasons = _off_params(inst)
    reasons += off_reasons
    if kind == "move-out" and off:
        reasons.append("관리 창이 서버를 끈 상태입니다 — [켜기] 뒤에 진짜 이사를 하세요")
    params = {"data_dir": str(inst.data_dir), "port": inst.port}
    if kind == "move-restore":
        if not off or off.get("phase") != "stopped":
            reasons.append("먼저 [끄기]로 서버를 끄세요(켜기·끄기 화면)")
        reasons += stopped if stopped is not None else ["서버가 실제로 꺼졌는지 확인하지 못했습니다"]
        if unsupported_paths(inst) or machine_env("CONTENT_HUB_DB"):
            reasons.append("표준 배치(<루트>\\backend\\data)가 아니라 여기서 복구하지 않습니다 — 수동 절차(SERVER_RECOVERY.md)")
        if not selection:
            reasons.append("복구할 백업을 목록에서 고르세요")
        else:
            try:
                files = find_set(inst, selection)
                params.update({key: selection[key] for key in ("root", "folder", "stamp")})
            except BackupError as exc:
                reasons.append(str(exc))
    if reasons:
        return Refusal(tuple(reasons))
    window = "새 콘솔 창이 열립니다 — 질문은 그 창에서 답하세요. 그 창을 X 로 닫으면 중간에 멈춥니다."
    summary = {
        "move-rehearsal": ("연습 내보내기 — 서버를 멈추지 않고 지금 DB 를 찍어 바탕화면 이사 폴더에 담습니다.", window,
                           "새 PC 에서 미리 확인하는 용도입니다. 진짜 이사 뒤에 더 새 연습본을 풀면 진짜 이사본이 거절될 수 있습니다."),
        "move-out": ("진짜 이사 내보내기 — 생성 접수 멈춤 → 진행 중 생성 0 대기(최대 15분) → 서버 정지 → 바탕화면 이사 폴더.",
                     "팀 공유가 약 30분 멈춥니다. 이 서버는 꺼진 채로 둡니다. 되돌리기는 [되돌리기(UNDO)](새 PC 가 이 IP 를 받기 전까지).",
                     window, "진행하는 동안 이 관리 창은 DB 를 읽지 않습니다."),
        "move-undo": ("이사 전 상태로 되돌립니다 — 생성 접수 원래 값·원래 켜져 있던 예약 작업·서버를 되살립니다.",
                      "★새 PC 에 이 서버의 IP 를 이미 줬다면 하지 마세요 — 두 서버의 자료가 갈라집니다.", window),
    }.get(kind)
    if kind == "move-restore":
        summary = (f"백업 {selection['stamp']} 으로 이 PC 의 DB 를 되살립니다(복원 연습 통과해야 설치).",
                   f"교체할 DB: {inst.data_dir}\\db\\content_hub.db·content_trash.db·manage_hub.db — 지금 DB 는 "
                   "db\\_before_move_<시각>\\ 로 보존됩니다.",
                   f"원본 세트: {files['content'].parent}\\*_{selection['stamp']}.db · 포트 {inst.port} · Python {inst.python} · "
                   "서버 루트 코드로 검증·설치합니다.",
                   window, "끝나면 관리 창으로 돌아와 [켜기](도구 출력의 MV_server.bat·register_autostart 안내 대신). "
                   "켠 뒤 생성 접수 상태를 확인하세요(복원한 DB 의 값 그대로).")
    return Plan(kind, str(inst.root), "server", "", summary, params=params)


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
