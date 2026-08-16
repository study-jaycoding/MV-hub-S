r"""운영 DB와 실제 크레딧을 건드리지 않는 생성 제출 중단·재시작 훈련.

사용:
  python tools\verify_generation_submission_recovery.py

임시 SQLite DB에서 CLI 호출 전 중단, 호출 후 결과 불명확, 서버 재시작, 기존 job 복구,
외부 미제출 확인 후 재큐잉을 순서대로 재현한다. Higgsfield CLI나 네트워크는 호출하지 않는다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app import db, repo  # noqa: E402
from app.config import DEFAULT_WORKER_ID  # noqa: E402

UI_TEST_EMAIL = "rl05-admin@example.invalid"
UI_TEST_PASSWORD = "rl05-test-password"


def _new_request(
    label: str,
    account_email: str,
    creator_uid: str = "drill-user",
) -> tuple[str, str]:
    gen_id = repo.create_local_generation(
        {"prompt": label, "model": "drill-model", "params": {}},
        DEFAULT_WORKER_ID,
        creator_uid=creator_uid,
    )
    request_id = repo.create_gen_request(
        account_email,
        "drill-user",
        gen_id,
        "create",
        {"prompt": label, "model": "drill-model", "params": {}},
    )
    return request_id, gen_id


def _expire(request_id: str) -> None:
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE gen_request SET lease_expires_at=datetime('now','-1 minute') "
            "WHERE id=?",
            (request_id,),
        )


def _assert_phase(request_id: str, gen_id: str, request: str, generation: str) -> None:
    actual_request = repo.get_gen_request(request_id)
    actual_generation = repo.get_generation(gen_id)
    assert actual_request and actual_request["status"] == request, actual_request
    assert actual_generation and actual_generation["status"] == generation, actual_generation


def run_drill() -> dict:
    report: dict[str, object] = {"database": "temporary", "paid_cli_called": False}

    pre_email = "drill-before@example.com"
    pre_id, pre_gen = _new_request("before paid CLI", pre_email)
    repo.claim_pending_requests(
        pre_email,
        limit=1,
        lease_owner="agent-before",
        submission_stage_capable=True,
    )
    _expire(pre_id)
    pre_transitions = repo.sweep_expired_generation_claims(pre_email)
    _assert_phase(pre_id, pre_gen, "pending", "pending")
    report["pre_submit_interrupt"] = pre_transitions

    post_email = "drill-after@example.com"
    post_id, post_gen = _new_request("after paid CLI started", post_email)
    repo.claim_pending_requests(
        post_email,
        limit=1,
        lease_owner="agent-after",
        submission_stage_capable=True,
    )
    begun = repo.begin_request_submission(
        post_id, post_email, "agent-after"
    )
    assert begun and begun["transitioned"] is True
    _expire(post_id)
    post_transitions = repo.sweep_expired_generation_claims(post_email)
    _assert_phase(post_id, post_gen, "recovery_required", "running")
    assert repo.claim_pending_requests(post_email, limit=16) == []
    report["post_submit_interrupt"] = post_transitions

    # 실제 프로세스 재시작과 같은 효과: 연결 풀을 모두 닫고 DB를 다시 연 뒤 startup 정리를 실행한다.
    db.flush_pool()
    db.init_db()
    orphaned = repo.fail_orphaned_jobs()
    _assert_phase(pre_id, pre_gen, "pending", "pending")
    _assert_phase(post_id, post_gen, "recovery_required", "running")
    report["restart"] = {"legacy_orphans_failed": orphaned, "holds_preserved": True}

    # 외부 목록에서 기존 job을 찾은 경우 새 생성 없이 같은 요청에 앵커한다.
    assert repo.apply_local_anchor(
        post_gen, post_id, "job-found-by-operator", verifying=True
    )
    _assert_phase(post_id, post_gen, "verifying", "running")
    assert repo.get_generation(post_gen)["job_id"] == "job-found-by-operator"
    report["existing_job_recovered"] = True

    manual_email = "drill-manual@example.com"
    manual_id, manual_gen = _new_request("operator confirmed absent", manual_email)
    repo.claim_pending_requests(
        manual_email,
        limit=1,
        lease_owner="agent-manual",
        submission_stage_capable=True,
    )
    repo.begin_request_submission(manual_id, manual_email, "agent-manual")
    assert repo.mark_request_recovery_required(
        manual_id, manual_email
    )
    assert repo.requeue_recovery_request(manual_id, "other@example.com") is None
    assert repo.requeue_recovery_request(manual_id, manual_email) == manual_gen
    _assert_phase(manual_id, manual_gen, "pending", "pending")
    report["explicit_absence_confirmation"] = True
    report["ok"] = True
    return report


def _initialize_database(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.environ["CONTENT_HUB_DB"] = str(path)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO creator(uid,name) "
            "VALUES('drill-user','Recovery Drill')"
        )


def _prepare_ui_database(path: Path) -> dict:
    _initialize_database(path)
    repo.ensure_admin_account(UI_TEST_EMAIL, UI_TEST_PASSWORD)
    account = repo.get_account(UI_TEST_EMAIL)
    assert account and account["creator_uid"]
    request_id, gen_id = _new_request(
        "RL-05 recovery UI smoke",
        UI_TEST_EMAIL,
        account["creator_uid"],
    )
    claimed = repo.claim_pending_requests(
        UI_TEST_EMAIL,
        limit=1,
        workspace_capable=True,
        lease_owner="ui-agent",
        submission_stage_capable=True,
    )
    assert claimed and claimed[0]["id"] == request_id
    assert repo.begin_request_submission(request_id, UI_TEST_EMAIL, "ui-agent")
    assert repo.mark_request_recovery_required(request_id, UI_TEST_EMAIL)
    _assert_phase(request_id, gen_id, "recovery_required", "running")
    return {
        "database": str(path.resolve()),
        "generation_id": gen_id,
        "request_id": request_id,
        "execution_phase": "recovery_required",
        "ui_email": UI_TEST_EMAIL,
        "ui_password": UI_TEST_PASSWORD,
        "paid_cli_called": False,
        "ok": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="MV Hub 생성 제출 중단·재시작 안전 훈련"
    )
    parser.add_argument(
        "--prepare-ui",
        type=Path,
        help="브라우저 UI 점검용 recovery_required 카드가 든 격리 DB를 만든다",
    )
    args = parser.parse_args()
    old_db = os.environ.get("CONTENT_HUB_DB")
    if args.prepare_ui:
        try:
            report = _prepare_ui_database(args.prepare_ui.resolve())
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0
        finally:
            db.flush_pool()
            if old_db is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old_db
            db.flush_pool()

    with tempfile.TemporaryDirectory(prefix="mvhub-submission-recovery-") as temp_dir:
        try:
            _initialize_database(Path(temp_dir) / "content_hub.db")
            report = run_drill()
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0
        finally:
            db.flush_pool()
            if old_db is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old_db
            db.flush_pool()


if __name__ == "__main__":
    raise SystemExit(main())
