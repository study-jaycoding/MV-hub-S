"""서버 PC 전용 관리 창(tkinter). 화면(ui) · 관리 핵심(names·install·status·logs·actions·jobs) · 기존 도구 3층.

이 패키지는 가져오기만으로 Tk 를 띄우거나 작업을 실행하지 않는다. supervisor·activation·
release_update·qualify_release_artifact.TOOLS 쪽 코드는 이 패키지를 import 하지 않는다
(설계: docs/status/서버관리창_설계_2026-10-23.md).
"""
