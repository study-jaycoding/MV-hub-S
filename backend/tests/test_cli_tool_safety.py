"""CLI pin 안전장치 계약 — 스모크의 버전 판정과 업그레이드 안내 순서.

pin 은 "CLI 가 필드를 조용히 바꿔 데이터가 깨지는 것"을 막는 장치다. 그 장치가
헛돌지 않도록 두 가지를 고정한다.

1. 스모크의 버전 판정은 **정확 비교**여야 한다. 부분 문자열 비교면 pin `1.1.2` 가
   설치본 `1.1.23` 을 통과시켜, 검증하지 않은 CLI 로 릴리스가 나간다.
2. 안내 문구는 **pin 변경 → 설치 → 스모크** 순서여야 한다. 스모크의 첫 검사가
   `version == pin` 이므로, 반대 순서로 안내하면 정상 후보 버전도 항상 FAIL 이다.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ReportedCliVersionTests(unittest.TestCase):
    """`higgsfield version` 출력에서 버전 토큰만 정확히 뽑는다."""

    def setUp(self):
        self.smoke = _load("hf_cli_contract_smoke")

    def test_plain_output(self):
        self.assertEqual(self.smoke._reported_cli_version("higgsfield 1.1.23"), "1.1.23")

    def test_extra_words_after_version_are_ignored(self):
        self.assertEqual(
            self.smoke._reported_cli_version("higgsfield 1.1.23 (node 22)"), "1.1.23"
        )

    def test_version_line_among_other_lines(self):
        text = "checking...\nhiggsfield 1.2.0\nbye\n"
        self.assertEqual(self.smoke._reported_cli_version(text), "1.2.0")

    def test_unknown_output_is_none(self):
        self.assertIsNone(self.smoke._reported_cli_version("command not found"))
        self.assertIsNone(self.smoke._reported_cli_version(""))

    def test_prefix_pin_does_not_match_longer_version(self):
        """★핵심: pin 1.1.2 는 설치본 1.1.23 과 같지 않다."""
        actual = self.smoke._reported_cli_version("higgsfield 1.1.23")
        self.assertNotEqual(actual, "1.1.2")
        self.assertEqual(actual, "1.1.23")


class SmokeSourceContractTests(unittest.TestCase):
    def setUp(self):
        self.source = (TOOLS / "hf_cli_contract_smoke.py").read_text("utf-8")

    def test_no_substring_version_comparison(self):
        self.assertNotIn("pin in ver_txt", self.source)

    def test_success_message_matches_current_procedure(self):
        # 스모크는 pin 을 이미 바꾼 뒤 실행한다 — "pin 범프해도 안전"은 순서가 거꾸로다.
        self.assertNotIn("pin 범프해도 안전", self.source)
        self.assertIn("커밋·릴리스", self.source)

    def test_pin_is_read_with_bom_tolerance(self):
        self.assertIn('read_text("utf-8-sig")', self.source)


class CheckUpdateGuidanceTests(unittest.TestCase):
    """업데이트 확인 도구의 안내가 실제 절차와 같은 순서인지."""

    def setUp(self):
        self.source = (TOOLS / "hf_cli_check_update.py").read_text("utf-8")

    def test_pin_change_is_announced_before_smoke(self):
        # 파일 앞부분 설명이 아니라 "다음 단계" 안내 블록 안에서만 순서를 본다.
        guide = self.source[self.source.index("다음 단계 (docs/HF_CLI_UPGRADE.md 절차):") :]
        pin_step = guide.index("hf_cli_version.txt 를 ")
        smoke_step = guide.index("hf_cli_contract_smoke.py")
        self.assertLess(
            pin_step,
            smoke_step,
            "pin 변경 안내가 스모크 안내보다 먼저 나와야 한다(스모크가 version == pin 을 검사한다)",
        )

    def test_no_stale_smoke_first_guidance(self):
        self.assertNotIn("통과하면 hf_cli_version.txt", self.source)


if __name__ == "__main__":
    unittest.main()
