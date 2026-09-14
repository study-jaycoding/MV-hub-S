"""`job_exists` 의 삭제 판정 계약 — 살아 있는 생성물을 지우지 않는다.

★왜 필요한가(2026-09-12 재현): 종전 구현은 CLI 응답 **전문**에서 `"job not found"` 를
 찾아 삭제로 판정했다. 그래서 **프롬프트에 그 문구가 든 멀쩡한 잡**이
 `status=completed`·`result_url` 있음인데도 False 가 되고, 그 False 가 그대로
 `usecases/hf_missing.py` 의 휴지통 이동으로 이어졌다.

★CLI 실측(higgsfield 1.1.24, 2026-09-12):
   없는 잡    → stdout 비어 있음 / stderr `Error: Job not found` / 종료코드 3
   잘못된 id  → stderr `Error: invalid id: ...`
 즉 정상 잡의 stdout(JSON)에는 not-found 형태가 나타나지 않는다.

가짜는 **CLI 실행 경계(`_run`)에만** 둔다 — 판정 로직은 제품 코드 그대로 돈다.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from app.services import cli_bridge

JOB = "e045d369-81c7-4598-8395-978b8713779f"


def _run_returns(text: str):
    async def _fake(*args, **kwargs):
        return text

    return _fake


def _run_raises(message: str):
    async def _fake(*args, **kwargs):
        raise cli_bridge.CLIError(message)

    return _fake


def _job(**extra) -> str:
    body = {
        "id": JOB,
        "status": "completed",
        "job_type": "nano_banana_pro",
        "result_url": "https://example.invalid/out.png",
        "params": {"prompt": "a photo"},
    }
    body.update(extra)
    return json.dumps(body)


class JobExistsTests(unittest.TestCase):
    def _call(self, job_id: str = JOB):
        return asyncio.run(cli_bridge.job_exists(job_id))

    def test_a_live_job_whose_prompt_says_job_not_found_is_not_treated_as_deleted(self):
        """★이 시험이 이 파일의 이유다 — 프롬프트 문구로 생성물을 지우면 안 된다."""
        raw = _job(params={"prompt": "a lost dog poster reading: job not found"})
        with patch.object(cli_bridge, "_run", new=_run_returns(raw)):
            self.assertIs(self._call(), True)

    def test_the_phrase_anywhere_in_a_valid_job_body_does_not_delete_it(self):
        """프롬프트만이 아니라 어떤 필드에 있어도 마찬가지다."""
        for field, value in (
            ("error", "Job not found"),          # 힉스필드가 남긴 과거 오류 문구
            ("display_name", "Job Not Found"),
            ("source_name", "job not found.png"),
        ):
            with self.subTest(field=field):
                with patch.object(cli_bridge, "_run", new=_run_returns(_job(**{field: value}))):
                    self.assertIs(self._call(), True)

    def test_a_deleted_job_is_still_reported_as_deleted(self):
        """실측 형태: 종료코드≠0 + stderr `Error: Job not found` → _run 이 CLIError."""
        message = f"higgsfield generate get {JOB} --json 실패(rc=3): Error: Job not found"
        with patch.object(cli_bridge, "_run", new=_run_raises(message)):
            self.assertIs(self._call(), False)

    def test_an_unrelated_cli_failure_changes_nothing(self):
        """타임아웃·네트워크·PATH 는 '확인불가'다 — 일시 오류로 지우면 안 된다."""
        for message in (
            f"CLI 타임아웃: higgsfield generate get {JOB} --json",
            "higgsfield CLI 를 찾을 수 없음 (PATH 확인)",
            f"higgsfield generate get {JOB} --json 실패(rc=1): Error: invalid id: {JOB}",
        ):
            with self.subTest(message=message[:40]):
                with patch.object(cli_bridge, "_run", new=_run_raises(message)):
                    self.assertIsNone(self._call())

    def test_stdout_is_never_a_delete_notice(self):
        """★정상 종료의 stdout 은 잡 JSON 이 아니면 **확인불가**다(코덱스 리뷰).

        실측상 not-found 는 stdout 으로 오지 않는다(stderr + rc=3). 그래서 stdout 에서
        문구를 찾는 것은 참을 만들지 못하고 거짓 양성만 만든다 — 잘린 JSON·프록시 오류
        본문이 그 문구를 품으면 멀쩡한 생성물이 사라진다.
        """
        for raw in (
            "Error: Job not found",
            '{"id": "%s", "params": {"prompt": "Error: Job not found' % JOB,  # 잘린 JSON
            'WARN: retrying\n{"id": "x", "params": {"prompt": "Error: Job not found"}}',
        ):
            with self.subTest(raw=raw[:34]):
                with patch.object(cli_bridge, "_run", new=_run_returns(raw)):
                    self.assertIsNone(self._call())

    def test_a_different_error_that_starts_the_same_way_is_not_a_delete(self):
        """★줄 끝 고정이 없으면 여기서 걸린다 — 뜻이 다른 메시지를 삭제로 읽으면 안 된다."""
        for stderr in (
            "Error: Job not found in cache; retry upstream",
            "Error: Job not found for workspace, but exists elsewhere",
        ):
            with self.subTest(stderr=stderr[:40]):
                message = f"higgsfield generate get {JOB} --json 실패(rc=1): {stderr}"
                with patch.object(cli_bridge, "_run", new=_run_raises(message)):
                    self.assertIsNone(self._call())

    def test_arbitrary_text_that_merely_mentions_the_phrase_is_unknown(self):
        """★경계 시험: 그 문구를 품은 **임의 본문**은 삭제 통보가 아니다.

        실측상 CLI 는 not-found 를 `Error: Job not found` 형태로만 알린다. 프록시·게이트웨이가
        끼어든 오류 본문이 우연히 그 말을 담을 수 있으므로, 형태를 확인하지 않고 부분일치로
        지우면 멀쩡한 생성물이 사라진다. 판정 못 하면 None(다음에 다시 본다)이 정직하다.
        """
        for raw in (
            "<html><body>upstream gateway: job not found in cache</body></html>",
            "warning: job not found in the local index, retrying",
        ):
            with self.subTest(raw=raw[:32]):
                with patch.object(cli_bridge, "_run", new=_run_returns(raw)):
                    self.assertIsNone(self._call())

    def test_a_cli_failure_body_that_merely_mentions_the_phrase_is_unknown(self):
        """CLIError 경로도 같다 — 게이트웨이 본문이 stderr 로 들어올 수 있다.

        통보는 **줄 끝**에 있어야 한다. 본문 중간에 묻힌 문구는 통보가 아니다.
        """
        message = (
            f"higgsfield generate get {JOB} --json 실패(rc=1): "
            "<html>502 upstream: job not found in cache</html>"
        )
        with patch.object(cli_bridge, "_run", new=_run_raises(message)):
            self.assertIsNone(self._call())

    def test_unparseable_output_is_unknown_not_deleted(self):
        for raw in ("", "   ", "<html>502 Bad Gateway</html>"):
            with self.subTest(raw=raw[:20]):
                with patch.object(cli_bridge, "_run", new=_run_returns(raw)):
                    self.assertIsNone(self._call())

    def test_a_different_job_in_the_response_is_unknown_not_alive(self):
        """물어본 잡을 안 돌려줬으면 이 잡의 생사를 모른다 — True 로 단정하지 않는다."""
        other = _job(id="11111111-2222-4333-8444-555555555555")
        with patch.object(cli_bridge, "_run", new=_run_returns(other)):
            self.assertIsNone(self._call())

    def test_the_id_match_is_case_insensitive(self):
        """UUID 대소문자 차이로 살아 있는 잡을 '확인불가'로 떨어뜨리지 않는다."""
        with patch.object(cli_bridge, "_run", new=_run_returns(_job(id=JOB.upper()))):
            self.assertIs(self._call(), True)

    def test_a_json_list_or_scalar_is_unknown(self):
        for raw in ("[]", '["x"]', "3", '"text"', "null"):
            with self.subTest(raw=raw):
                with patch.object(cli_bridge, "_run", new=_run_returns(raw)):
                    self.assertIsNone(self._call())


class GetJobRawTests(unittest.TestCase):
    def _call(self):
        return asyncio.run(cli_bridge.get_job_raw(JOB))

    def test_live_job_with_not_found_in_prompt_is_preserved(self):
        for prompt in (
            "a lost dog poster reading: job not found",
            "Error: Job not found",
            "first line\nError: Job not found\nlast line",
            "Error: Job not found in cache; retry upstream",
        ):
            for indent in (None, 2):
                with self.subTest(prompt=prompt, indent=indent):
                    expected = json.loads(_job(params={"prompt": prompt}))
                    raw = json.dumps(expected, indent=indent)
                    with patch.object(cli_bridge, "_run", new=_run_returns(raw)):
                        self.assertEqual(self._call(), expected)

    def test_not_found_and_invalid_output_remain_unknown(self):
        for raw in (
            "Error: Job not found", "", "   ", "<html>502 Bad Gateway</html>",
            '{"id": "%s", "params": {"prompt": "Error: Job not found' % JOB,
            "[]", "null", '"Error: Job not found"', '{"status":"completed"}',
        ):
            with self.subTest(raw=raw):
                with patch.object(cli_bridge, "_run", new=_run_returns(raw)):
                    self.assertIsNone(self._call())
        for message in ("Error: Job not found", "CLI timeout"):
            with self.subTest(message=message):
                with patch.object(cli_bridge, "_run", new=_run_raises(message)):
                    self.assertIsNone(self._call())


if __name__ == "__main__":
    unittest.main()
