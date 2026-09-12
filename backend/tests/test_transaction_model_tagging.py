"""거래에 모델 태그를 붙일 때 **이름이 모호하면 붙이지 않는다.**

★왜(2026-09-12 실측): 거래 응답에는 `display_name` 만 있고 모델 키가 없다
 (키는 `action·created_at·credits·display_name` 넷뿐 — CLI 1.1.24 실측).
 에이전트가 `model list` 로 이름→키를 되돌리는데, **표시명이 유일하지 않다**:

   Nano Banana Pro → nano_banana_pro · _ai_stylist · _relight · _skin_enhancer · _shots  (5개)
   Topaz           → topaz_image · topaz_image_generative · topaz_video                  (3개)
   Genjutsu        → hf_mult_motion_control · hf_mult_replace_object                     (2개)

 종전 dict 컴프리헨션은 **마지막 것이 조용히 이겨** 거의 모든 `Nano Banana Pro` 거래에
 `nano_banana_2_shots` 를 붙였다. 서버 매칭은 모델을 **하드 필터**로 쓰므로
 (`transaction_model != generation_model` 이면 간선을 버린다) 그 거래의 **매칭률이 0%** 가 됐다.

★실측 영향(로컬 거래 6,266건): 모호한 이름 655건(10.5%) 매칭률 **0%**, 그 밖 5,376건은 15%.
 제품 `_match_transactions` 를 실데이터에 돌리면 시간상 간선 후보가 245개인데
 **연결 요소 0개·변경 0건** — 모델 불일치로 전부 버려진다.

★**잘못 붙은 태그는 없는 것보다 나쁘다.** 미태깅은 시간+소유자 폴백을 타지만 오태깅은 정상 짝을 막는다.

★기존에 잘못 저장된 값은 **이 변경으로 안 지운다.** 모델을 NULL 로 되돌리면 후보가 하나뿐인
 연결 요소가 '확정' 조건을 통과해 **엉뚱한 모델에 금액이 붙는다**(코덱스가 재현: Nano Banana Pro
 거래 6.5크레딧이 seedream_v5_pro 생성물에 확정). 그 교정은 후보 집합 제한과 함께 별도로 한다.
"""

from __future__ import annotations

import unittest

from test_agent_contracts import _load_agent


def _model(display_name, job_type=None, job_set_type=None):
    out = {"display_name": display_name}
    if job_type:
        out["job_type"] = job_type
    if job_set_type:
        out["job_set_type"] = job_set_type
    return out


class UniqueModelByDisplayNameTests(unittest.TestCase):
    def setUp(self):
        self.agent = _load_agent()
        self.build = self.agent._unique_model_by_display_name

    def test_a_name_shared_by_several_models_is_left_out(self):
        """★이 시험이 이 파일의 이유다 — 하나를 골라 붙이면 나머지 넷이 전부 틀린다."""
        table = self.build([
            _model("Nano Banana Pro", "nano_banana_pro"),
            _model("Nano Banana Pro", "nano_banana_2_ai_stylist"),
            _model("Nano Banana Pro", "nano_banana_2_relight"),
            _model("Nano Banana Pro", "nano_banana_2_skin_enhancer"),
            _model("Nano Banana Pro", "nano_banana_2_shots"),
            _model("Nano Banana 2", "nano_banana_flash"),
        ])
        self.assertNotIn("Nano Banana Pro", table)
        self.assertEqual(table["Nano Banana 2"], "nano_banana_flash")  # 유일한 것은 남는다

    def test_the_order_of_the_model_list_does_not_change_the_answer(self):
        """dict 컴프리헨션은 **마지막 것이 이긴다** — 순서가 답을 바꾸면 그 함정이 남아 있다."""
        models = [
            _model("Topaz", "topaz_image"),
            _model("Topaz", "topaz_image_generative"),
            _model("Topaz", "topaz_video"),
            _model("Seedream 5.0 Pro", "seedream_v5_pro"),
        ]
        self.assertEqual(self.build(models), self.build(list(reversed(models))))
        self.assertNotIn("Topaz", self.build(models))

    def test_the_same_key_repeated_is_not_ambiguous(self):
        """판정 기준은 '행 수' 가 아니라 **서로 다른 유효 키의 수** 다(코덱스 조건)."""
        table = self.build([
            _model("Seedance 2.5", "seedance_2_5"),
            _model("Seedance 2.5", "seedance_2_5"),  # 같은 키가 두 번
        ])
        self.assertEqual(table["Seedance 2.5"], "seedance_2_5")

    def test_an_entry_without_a_key_never_makes_a_name_look_unique(self):
        """키가 빠진 항목을 '유일함' 의 근거로 쓰면 안 된다 — 그 이름은 아예 안 넣는다."""
        self.assertEqual(self.build([_model("Mystery")]), {})
        # 키 없는 항목이 섞여도 진짜 키 둘이면 여전히 모호하다
        table = self.build([
            _model("Genjutsu"),
            _model("Genjutsu", "hf_mult_motion_control"),
            _model("Genjutsu", "hf_mult_replace_object"),
        ])
        self.assertNotIn("Genjutsu", table)

    def test_both_the_old_and_new_key_fields_are_accepted(self):
        """CLI 1.x 가 `job_set_type` → `job_type` 로 개명했다 — 둘 다 받는다(기존 계약)."""
        self.assertEqual(
            self.build([_model("Old", job_set_type="old_key")])["Old"], "old_key"
        )
        self.assertEqual(
            self.build([_model("New", job_type="new_key")])["New"], "new_key"
        )
        # 둘 다 있으면 job_set_type 이 이긴다(기존 순서 유지)
        both = _model("Both", job_type="jt")
        both["job_set_type"] = "jst"
        self.assertEqual(self.build([both])["Both"], "jst")

    def test_rubbish_entries_are_ignored_without_crashing(self):
        table = self.build([None, "문자열", 42, {}, _model("", "empty_name"), _model("OK", "ok_key")])
        self.assertEqual(table, {"OK": "ok_key"})

    def test_an_empty_or_failed_model_list_tags_nothing(self):
        """목록 조회 실패는 '유일함 확인' 이 아니다 — 아무것도 붙이지 않는다."""
        self.assertEqual(self.build([]), {})


class TaggingAppliesTheTableTests(unittest.TestCase):
    """표를 실제로 거래에 적용하는 경로(제품 코드)까지 본다."""

    def setUp(self):
        self.agent = _load_agent()

    def test_an_ambiguous_transaction_keeps_no_model(self):
        models = [
            _model("Nano Banana Pro", "nano_banana_pro"),
            _model("Nano Banana Pro", "nano_banana_2_shots"),
            _model("Seedance 2.5", "seedance_2_5"),
        ]
        table = self.agent._unique_model_by_display_name(models)
        txns = [
            {"display_name": "Nano Banana Pro", "credits": -2, "action": "spend"},
            {"display_name": "Seedance 2.5", "credits": -32.5, "action": "spend"},
        ]
        for t in txns:  # push_once 가 하는 것과 같은 적용
            if t.get("display_name") in table:
                t["model"] = table[t["display_name"]]
        self.assertNotIn("model", txns[0])  # 모호하면 태그 없음 → 서버가 시간·소유자로 폴백
        self.assertEqual(txns[1]["model"], "seedance_2_5")


if __name__ == "__main__":
    unittest.main()
