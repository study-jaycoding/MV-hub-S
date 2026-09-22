"""③ 변이 검증: 제품 파일을 쓰지 않고 자식 프로세스의 메모리에서만 한 결함씩 복원.

backend에서 실행: python tests/credit_matching_mutation_check.py
각 변이는 지정한 실제 진입점 시험의 AssertionError로 실패해야 검출로 인정한다.
문법/import/fixture 오류나 예상 밖 예외는 검출로 인정하지 않는다.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


BACKEND = Path(__file__).resolve().parents[1]
SAFETY = "tests/test_transaction_matching_safety.py::TransactionMatchingSafetyTests::"
INGEST = "tests/test_transaction_matching_ingest.py::TransactionMatchingIngestTests::"
MATCH_CALL = """        reason, matching = _component_matching(
            component_generations, component_transactions, edges, spend_amounts,
        )"""
GREEDY_CALL = """        reason, matching = None, {}
        used_transactions = set()
        pairs = sorted(
            (abs(generations[g]['sort_ts'] - transaction_timestamps[t]), t, g)
            for g in component_generations for t in edges[g]
        )
        for _, t, g in pairs:
            if g not in matching and t not in used_transactions:
                matching[g] = t
                used_transactions.add(t)"""

# 이름, 모듈, 원문, 변이문, 지정 시험, 기대 assertion의 의미를 판별할 문자열
MUTATIONS = [
    ("greedy", "transactions", MATCH_CALL, GREEDY_CALL,
     SAFETY + "test_augmenting_path_recovers_greedy_omission", "1 != 2"),
    ("incomplete", "transactions",
     "if len(by_generation) < len(generation_indices):", "if False:",
     SAFETY + "test_identical_amount_with_too_few_transactions_is_incomplete", "1 != 0"),
    ("amount_invariance", "transactions",
     "    for generation_index in generation_indices:\n        # 각 검사는",
     "    return None, by_generation\n    for generation_index in generation_indices:\n        # 각 검사는",
     SAFETY + "test_crossed_times_across_projects_are_ambiguous", "2 != 0"),
    ("empty_return", "transactions", "    inserted = 0\n",
     "    if not transactions:\n        return {'inserted': 0, 'matched': 0, 'matched_ids': []}\n    inserted = 0\n",
     SAFETY + "test_empty_cycle_matches_stored_transaction_after_generation_arrives",
     "empty cycle must reevaluate stored transactions"),
    ("ingest_empty_gate", "ingest", "if MANAGE_ENABLED and out.linked_uid:",
     "if MANAGE_ENABLED and body.account_transactions:",
     INGEST + "test_empty_transactions_match_after_generation_ingest",
     "empty ingest must evaluate stored transactions"),
    ("dirty", "transactions", "    mark_telemetry_dirty_in_connection(conn, dirty_ids)",
     "    pass  # mutation: dirty omitted",
     SAFETY + "test_candidate_addition_resolves_incomplete_and_marks_dirty_once", "{} !="),
    ("atomicity", "transactions", 'conn.execute("ROLLBACK")', 'conn.execute("COMMIT")',
     SAFETY + "test_conditional_write_failure_rolls_back_entire_component",
     "조건부 저장 실패 시 같은 요소의 앞선 확정도 롤백해야 한다"),
]

CHILD = r'''
import importlib
import json
from pathlib import Path
import sys
import pytest

payload = json.loads(sys.stdin.read())
module = importlib.import_module(payload['module'])
source = Path(module.__file__).read_text(encoding='utf-8')
assert source.count(payload['old']) == 1, 'mutation anchor must occur exactly once'
code = compile(source.replace(payload['old'], payload['new']), module.__file__, 'exec')
exec(code, module.__dict__)
if payload['module'].endswith('manage_transactions'):
    from app.repo import manage
    manage.record_transactions = module.record_transactions
    manage._match_transactions = module._match_transactions

class Evidence:
    def __init__(self):
        self.failures = []
    def pytest_runtest_logreport(self, report):
        if report.failed:
            crash = getattr(report.longrepr, 'reprcrash', None)
            self.failures.append({
                'nodeid': report.nodeid, 'when': report.when,
                'message': getattr(crash, 'message', str(report.longrepr)),
            })

evidence = Evidence()
result = pytest.main(['-q', '-p', 'no:cacheprovider', payload['test']], plugins=[evidence])
print('MUTATION_EVIDENCE=' + json.dumps({'exit': int(result), 'failures': evidence.failures}))
'''


def main():
    all_killed = True
    for name, target, old, new, test, assertion in MUTATIONS:
        payload = {
            "module": "app.repo.manage_transactions" if target == "transactions" else "app.routers.ingest",
            "old": old, "new": new, "test": test,
        }
        with tempfile.TemporaryDirectory(prefix="mvhub-credit-mutation-") as folder:
            # 부모의 CONTENT_HUB_* 는 버린다 — 자식이 pytest 보다 먼저 app 을 import 해 conftest 격리가 늦다.
            env = {**{k: v for k, v in os.environ.items() if not k.upper().startswith("CONTENT_HUB_")},
                   "CONTENT_HUB_NO_PROXY": "1", "CONTENT_HUB_DB_POOL": "0",
                   "CONTENT_HUB_DATA": folder, "CONTENT_HUB_DB": str(Path(folder) / "default.db"),
                   "PYTHONIOENCODING": "utf-8"}
            result = subprocess.run(
                [sys.executable, "-c", CHILD], input=json.dumps(payload), cwd=BACKEND,
                env=env, capture_output=True, text=True, encoding="utf-8", timeout=60,
            )
        evidence_lines = [line for line in result.stdout.splitlines()
                          if line.startswith("MUTATION_EVIDENCE=")]
        evidence = json.loads(evidence_lines[-1].split("=", 1)[1]) if evidence_lines else {}
        failures = evidence.get("failures", [])
        killed = (
            result.returncode == 0 and evidence.get("exit") == 1 and len(failures) == 1
            and failures[0]["nodeid"] == test and failures[0]["when"] == "call"
            and failures[0]["message"].startswith("AssertionError")
            and assertion in failures[0]["message"]
        )
        all_killed &= killed
        print(json.dumps({"mutation": name, "detected_by_expected_assertion": killed,
                          "test": test, "failures": failures}, ensure_ascii=False))
        if not killed:
            print(result.stdout)
            print(result.stderr)
    return 0 if all_killed else 1


if __name__ == "__main__":
    raise SystemExit(main())
