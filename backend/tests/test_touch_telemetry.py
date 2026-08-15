"""touch_generation_telemetry 특성화 테스트 — share/publish 복붙 통합의 동작 계약 고정.

계약: ①MANAGE off 면 아무것도 안 함 ②gen_id 없으면 안 함 ③정상이면 mark_telemetry_dirty
([gen_id]) 호출 ④내부 예외는 삼켜 호출 흐름(공유·발행)에 절대 전파 안 됨.
"""

import unittest
from unittest import mock

from app.routers import _telemetry, publish, share


class TouchTelemetryTests(unittest.TestCase):
    def test_manage_off_is_noop(self):
        with mock.patch.object(_telemetry, "MANAGE_ENABLED", False), mock.patch(
            "app.repo.manage.mark_telemetry_dirty"
        ) as dirty:
            _telemetry.touch_generation_telemetry("g1")
        dirty.assert_not_called()

    def test_empty_gen_id_is_noop(self):
        with mock.patch.object(_telemetry, "MANAGE_ENABLED", True), mock.patch(
            "app.repo.manage.mark_telemetry_dirty"
        ) as dirty:
            _telemetry.touch_generation_telemetry(None)
            _telemetry.touch_generation_telemetry("")
        dirty.assert_not_called()

    def test_marks_dirty_with_single_id_list(self):
        with mock.patch.object(_telemetry, "MANAGE_ENABLED", True), mock.patch(
            "app.repo.manage.mark_telemetry_dirty"
        ) as dirty:
            _telemetry.touch_generation_telemetry("g1")
        dirty.assert_called_once_with(["g1"])

    def test_internal_failure_never_propagates(self):
        with mock.patch.object(_telemetry, "MANAGE_ENABLED", True), mock.patch(
            "app.repo.manage.mark_telemetry_dirty", side_effect=RuntimeError("db down")
        ):
            _telemetry.touch_generation_telemetry("g1")  # 예외 없으면 통과

    def test_share_and_publish_use_the_single_definition(self):
        # 복붙 회귀 방지 — 두 라우터의 _touch_telemetry 가 같은 함수 객체여야 한다.
        self.assertIs(share._touch_telemetry, _telemetry.touch_generation_telemetry)
        self.assertIs(publish._touch_telemetry, _telemetry.touch_generation_telemetry)


if __name__ == "__main__":
    unittest.main()
