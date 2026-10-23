"""관리 창에서 할 수 있는 일의 고정 목록. 대상 계산·거절 이유·확인 문구·실행 명령이 여기 한 곳에 있다.

판단 로직(업데이트 자격·전환 안전)은 기존 도구에 있고, 여기는 부를지 말지와 무엇을 부를지만 정한다.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace

from .install import Installation, Runner, powershell_exe, trusted_git

ACTIONS = {"git-update": "Git 업데이트", "tools-update": "관리 도구 갱신", "console-rollback": "이전 관리 창으로",
           "intake-set": "생성 접수 바꾸기"}
# 관리자 로그인이 필요한 작업 — 화면은 이것만 토큰을 파이프로 넘기고, 실행기는 이것만 토큰을 읽는다.
AUTH_KINDS: frozenset[str] = frozenset({"intake-set"})


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
