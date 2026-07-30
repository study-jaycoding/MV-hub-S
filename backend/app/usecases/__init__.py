"""usecases 계층 — 업무 흐름(오케스트레이션).

라우터(HTTP/인증/권한)와 repo/services(데이터·부수효과) 사이. 여러 repo 호출·부수효과를
하나의 업무 단위로 묶는다. FastAPI 를 import 하지 않는다 — HTTP 는 라우터 몫.
(ARCHITECTURE.md: routers -> usecases -> repo/services)
"""
