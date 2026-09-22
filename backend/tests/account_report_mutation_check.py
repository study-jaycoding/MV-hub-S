"""제품 파일 수정 없이 메모리 변이를 실제 ingest·queue 시험으로 검출한다.

backend에서 python tests/account_report_mutation_check.py 실행.
각 변이는 지정된 시험의 지정 AssertionError로만 검출 성공으로 센다.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from credit_matching_mutation_check import CHILD


BACKEND = Path(__file__).resolve().parents[1]
TEST = "tests/test_account_report_consistency.py::"
QUEUE = "app.repo.manage_account_reports"
INGEST = "app.routers.ingest"

MUTATIONS = [
    (
        "DB 조회 제거", QUEUE,
        "saved = _find_account_transaction(conn, account_email, transaction)",
        "saved = transaction",
        "test_ingest_queue_uses_preserved_enrichment[A-B-A]",
        "queue must use ledger workspace",
    ),
    (
        "NULL 폴백 부활", QUEUE,
        'payload["workspace_id"] = saved["workspace_id"]',
        'payload["workspace_id"] = saved["workspace_id"] or transaction.get("workspace_id")',
        "test_queue_copies_null_even_when_payload_has_enrichment",
        "DB NULL must replace payload workspace",
    ),
    (
        "행 없어도 큐에 넣기", QUEUE,
        "if saved is None:\n                    missing_transactions += 1\n                    continue",
        "if saved is None:\n                    missing_transactions += 1\n                    saved = dict(transaction)",
        "test_queue_missing_valid_transaction_is_not_acknowledged_or_queued",
        "missing valid row must never be queued",
    ),
    (
        "반려를 실패로", QUEUE,
        "if _transaction_rejection_reason(transaction):\n                    continue",
        "if _transaction_rejection_reason(transaction):\n                    missing_transactions += 1\n                    continue",
        "test_invalid_spend_is_explicitly_rejected_and_acknowledged[True]",
        "explicit rejection must complete ACK",
    ),
    (
        "멱등 0건을 실패로", QUEUE,
        '"transactions_queued": missing_transactions == 0,',
        '"transactions_queued": missing_transactions == 0 and queued_transactions > 0,',
        "test_idempotent_zero_changes_are_success_without_resetting_failure",
        "idempotent zero changes must succeed",
    ),
    (
        "ingest 큐 ACK 무조건 성공", INGEST,
        'transactions_queued = queued["transactions_queued"]',
        "transactions_queued = True",
        "test_ingest_ledger_success_but_queue_lookup_missing_fails_ack",
        "queue lookup omission must fail ingest ACK",
    ),
    (
        "model NULL 폴백 부활", QUEUE,
        'payload["model"] = saved["model"]',
        'payload["model"] = saved["model"] or transaction.get("model")',
        "test_queue_copies_null_even_when_payload_has_enrichment",
        "DB NULL must replace payload model",
    ),
]


def main():
    # 기존 검증 실행기의 수집 훅을 재사용하되 facade 별칭도 변이 함수로 연결한다.
    child = CHILD.replace(
        "class Evidence:",
        "if payload['module'].endswith('manage_account_reports'):\n"
        "    from app.repo import manage\n"
        "    manage.queue_account_reports = module.queue_account_reports\n\n"
        "class Evidence:",
    )
    all_detected = True
    for name, module, old, new, test_name, assertion in MUTATIONS:
        test = TEST + test_name
        payload = {"module": module, "old": old, "new": new, "test": test}
        with tempfile.TemporaryDirectory(prefix="mvhub-ack-mutation-") as folder:
            # 부모의 CONTENT_HUB_* 는 버린다 — 자식이 pytest 보다 먼저 app 을 import 해 conftest 격리가 늦다.
            env = {
                **{k: v for k, v in os.environ.items() if not k.upper().startswith("CONTENT_HUB_")},
                "CONTENT_HUB_NO_PROXY": "1", "CONTENT_HUB_DB_POOL": "0",
                "CONTENT_HUB_DATA": folder, "CONTENT_HUB_DB": str(Path(folder) / "default.db"),
                "CONTENT_HUB_SHARED_URL": "http://127.0.0.1:1", "PYTHONIOENCODING": "utf-8",
            }
            result = subprocess.run(
                [sys.executable, "-c", child], input=json.dumps(payload), cwd=BACKEND,
                env=env, capture_output=True, text=True, encoding="utf-8", timeout=60,
            )
        lines = [line for line in result.stdout.splitlines() if line.startswith("MUTATION_EVIDENCE=")]
        evidence = json.loads(lines[-1].split("=", 1)[1]) if lines else {}
        failures = evidence.get("failures", [])
        detected = (
            result.returncode == 0 and evidence.get("exit") == 1 and len(failures) == 1
            and failures[0]["nodeid"] == test and failures[0]["when"] == "call"
            and failures[0]["message"].startswith("AssertionError")
            and assertion in failures[0]["message"]
        )
        all_detected &= detected
        print(json.dumps({"mutation": name, "detected_by_expected_assertion": detected,
                          "test": test, "failures": failures}, ensure_ascii=False), flush=True)
        if not detected:
            print(result.stdout)
            print(result.stderr)
    return 0 if all_detected else 1


if __name__ == "__main__":
    raise SystemExit(main())
