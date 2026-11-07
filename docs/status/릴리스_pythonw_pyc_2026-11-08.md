---
status: active
updated: 2026-11-08
---

# 릴리스 제작 실패 — pythonw 확인이 스테이징에 pyc 를 남김 (2026-11-08)

owner: Claude 총괄(구현) · reviewer: Codex(사전 검토·독립 리뷰, 읽기 전용) · status: 검증 중(게이트·main 반영 뒤 고정 폴더 제작 남음) · touched_paths: 아래 계약 · updated: 2026-11-08

합의(계약 `05d3387f…`): Codex 세션 `01a1b69d`(gpt-6-astra·high·read-only, rollout 확인, 도구 0회) — 1차 [고침] 2 → 2차 [고침] 1 → 3차 VIBE-AGREE · 별도 Claude 세션 `9248a512`(claude-opus-5-5, 읽기 전용, 도구 0회) — 1차 [고침] 4 → 2차 [고침] 1(+범위 밖 관찰: 실패 뒤 자동 복원 — 호출 목록으로 해당 없음 확인) → 3차 VIBE-AGREE.

main `f040925d` 반영 뒤 Jay "릴리스 만들어서 나스에 올려라" → 고정 폴더 `D:\ClaudeCode\MV-hub-S-release` 에서 `make_release.ps1 -SkipPublish` 가 2.6분 만에 `[7/8] Creating zip...` 의 `Assert-ReleaseArchive` 에서 멈췄다: `Release archive contains forbidden local/test data: runtime/python/Lib/collections/__pycache__/__init__.cpython-314.pyc, …`(ctypes·email·compression 등). NAS 게시 없음·만든 ZIP 은 스크립트가 지움·고정 폴더 작업 트리 깨끗. Jay "고쳐서 다시".

## 원인(직접 확인)

- `Assert-PythonRuntimeTree`(`release/make_release.ps1:85`)에 Slack 전용 링크 묶음(`d83519e8`)이 넣은 pythonw 확인이 `Start-Process -FilePath $Windowless -ArgumentList @('-I', '-S', '-c', '"import ctypes,hashlib,hmac,json,urllib.request"')` — **`-B` 가 없다**. 스테이징 런타임에서 돌며 `urllib.request` 가 끌어오는 표준 라이브러리의 pyc 를 `runtime/python/Lib/**/__pycache__` 에 쓴다 → ZIP 에 실림 → 10-22 에 넣은 금지 목록(`^runtime/python/.*\.pyc$`)이 제작을 멈춘다. 바로 아래 python.exe 확인은 10-22 교훈으로 `-I -B`([배포판 pyc 부팅 거부](배포판_pyc_부팅거부_2026-10-22.md)), MCP 확인도 `-I -S -B`.
- 금지 목록이 제 일을 했다 — 그 검사가 없었다면 pyc 가 ZIP·배포 목록에 실리고, 설치 과정에서 다시 써질 경우 10-22 와 같은 지문 불일치(부팅 거부)가 재발할 수 있었다(Codex 사전 검토 [고침] 2).
- source-only 게이트·문자열 시험(`test_open_link_release.py` 가 `'-I', '-S'` 글자만 단언)은 제작을 돌리지 않아 못 잡았다.
- 다른 pyc 출처가 없는지(Claude 사전 검토 [고침] 1): 실패한 스테이징 `release/_staging/MVHub-2026.11.08-0016` 전체의 pyc 75개·`__pycache__` 14개가 **모두 `runtime/python` 아래**다(그 밖 0). 고치기 전 함수를 깨끗한 런타임 사본에 돌리면 75개가 생기고 상대 경로가 스테이징 75개와 정확히 같다(확인 스크립트가 대조) — 이번 실패에서 관측된 pyc 를 이 확인 하나로 모두 재현한다. 다른 제작 단계가 같은 모듈을 불러 같은 경로에 캐시를 만들었을 가능성까지 배제하는 결과는 아니며, 고친 뒤 전체 제작의 ZIP 금지 검사로 최종 확인한다(Codex 재검토 [고침] 1).

## 고침

- `make_release.ps1` 의 pythonw 확인 인자에 `-B` 를 **`-c` 앞에** 더한다: `@('-I', '-S', '-B', '-c', '"import …"')`(나머지 그대로). `-c` 뒤에 붙이면 스크립트 인자(sys.argv)가 되어 효과가 없다(Claude 사전 검토 [고침] 2). 같은 함수가 다 만든 ZIP 을 임시 폴더에 풀어 다시 확인할 때도 같은 인자다.
- 시험: pythonw 확인의 `ArgumentList` 안에 `'-B'` 가 있음을 단언(함수 전체에서 찾으면 python.exe 의 `-B` 때문에 놓친다) + 실제 번들 런타임 사본에서 함수 자체를 돌려 pyc 0 을 확인(고치기 전 판은 새 사본에 pyc 를 남겨 재현 — 고치기 전 상태에서 미리 돌려 보니 두 판 모두 75개, 실패한 제작의 스테이징 pyc 75개와 같음).
- 고치지 않는 곳: 업데이터(`update_release_worker.bat` 의 pythonw 확인)·`tools/qualify_release_artifact.py` 의 `_check_native_runtime`·mvhub:// 등록 명령(`run_agent_session.py` — 명령을 저장만 하고, 캐시는 그 명령이 실제로 실행될 때 생김). **이번 고침은 새 배포판에 pyc 가 실리는 것을 막는 데 한정한다.** pyc 가 배포 목록에 없는 설치본에서 실행 중 생기는 캐시는 목록 기반 지문 대조와 무관하다(10-22 Codex 확인 · `MV_agent.bat` 도 원래 `-B` 없이 돈다). pyc 가 배포 목록에 들어 있던 옛 판(10-22 이전 제작)으로 업데이트·되돌리기할 때의 영향은 실행해 확인하지 않았고, 이 고침으로 해결했다고 주장하지 않는다(Codex 사전 검토 [고침] 1). 코드로 본 것(Claude 사전 검토 [고침] 3): 업데이터의 설치 지문 검사 `Assert-InstalledReleasePayload`(`update_release_contract.ps1:180`)는 배포 목록(build-manifest payload) 항목만 하나씩 대조하고 목록 밖 파일은 보지 않는다 — 패키지 풀기(`update_release_worker.bat:1452`→`:1455`)·설치(`:1534`→`:1541`) 모두 pythonw 확인 뒤 이 검사다. 업데이터의 pythonw 확인은 **`-PackageRoot` 에 `open_link.py` 가 있을 때만** 돈다(`:760`). 이 파일에서 `Assert-PythonRuntime` 호출은 `:1452`(package)·`:1469`(staged)·`:1534`(installed) — 모두 들어오는 패키지 `$ExtractDir` — 와 `:1722`(이미 최신일 때 지금 설치본, `$TargetDir`) 넷뿐이다. 그래서 pyc 를 목록에 실은 옛 판(open_link 이전)으로 내려가는 업데이트에서는 돌지 않고, 업데이트 실패 뒤 자동 복원(`:1545~1585` — `Undo-ComponentSwaps`·`Commit-VersionMarker`·`Remove-SwapLeftovers`)은 이 확인을 부르지 않는다(Claude 재검토 [고침] 1·범위 밖 관찰에 대해 호출 목록으로 확인, 실행 확인은 아님). 각 곳을 안 고치는 이유: 업데이터·qualify = 새 판 목록에 pyc 가 없어 해가 없고 이번에 업데이트 경로를 건드리지 않는다 · 등록 명령 = 위 이유 + 저장된 등록 문자열 비교·옛 등록 정리·시험이 이 글자를 본다.

## 확인

- 조건별 시험 기록(지문 `3631dab2…`): no-staging-pyc `2961bc9c` — 사본 1,842 파일이 실패한 스테이징 런타임의 pyc 아닌 파일과 경로·SHA256 모두 같음 · 고친 함수 pyc 0→0(오류 없음) · 고치기 전(f040925d) 함수 0→75 · 그 75개 = 스테이징 75개(이름 같음, runtime/python 밖 0) / regression `fb85cfd7` — test_open_link_release·test_release_frontend_build 55 통과(새 단언은 고치기 전 코드와 `-c` 뒤 `-B` 를 둘 다 실패시킴, 리뷰 확인).
- 독립 리뷰: 새 Codex 세션 `01a1b6a8`(gpt-6-astra·high·read-only, rollout 확인, 도구 0회) — 1차 [P2] 확인 사본의 출처 증명 없음·[P3] 숨김 항목 → 확인 스크립트에 사본↔스테이징 경로·SHA256 대조와 `-Force` → 2차 **VIBE-REVIEW-PASS**(코드 diff 는 1차부터 지적 없음).
- 실제 제작 확인(`-SkipPublish`)은 main 반영 뒤 고정 폴더에서만 한다(배포판은 그 폴더에서만 만든다는 안전선). 실패하면 게시 전에 멈춘다.
- 지난 실패의 스테이징은 재사용되지 않는다(Claude 사전 검토 [고침] 4): 제작은 시작할 때 `Remove-Item -LiteralPath $StagingRoot -Recurse -Force`(`make_release.ps1:572`)로 `_staging` 전체를 지우고, 스테이징 폴더 이름도 제작 시각 버전이라 새로 만든다. pyc 목록 대조는 그 전에(다음 제작 전에) 남은 스테이징을 읽기만 해서 한다.

```vibe-intent
{
  "schema": 1,
  "id": "release-pythonw-no-pyc-20261108",
  "root": "D:/ClaudeCode/MV-hub-S-dev",
  "owner": {"host": "claude", "session": "0d796f46-f90e-4d40-ab85-e9c1233bf3bb"},
  "risk": {"level": "major", "reason": "배포 도구(make_release.ps1)의 런타임 검증을 바꾼다 — 틀리면 릴리스를 못 만들거나, 스테이징 pyc 가 배포판에 실려 업데이트한 PC 가 지문 불일치로 부팅을 거부한다(10-22)."},
  "goal": "make_release.ps1 의 pythonw 실행 확인이 스테이징·완성 ZIP 사본 런타임에 pyc 를 쓰지 않게 -B 를 더해, 릴리스 제작이 ZIP 금지 검사에 막히지 않고 배포판에 pyc 가 실리지 않게 한다. 다른 확인·업데이터·검사 도구·등록 명령은 바꾸지 않는다.",
  "touched_paths": [
    "release/make_release.ps1",
    "backend/tests/test_open_link_release.py"
  ],
  "criteria": [
    {"id": "no-staging-pyc", "success": "make_release.ps1 의 Assert-PythonRuntimeTree 함수 자체(파일에서 함수 정의를 꺼내 정의)를, 실패한 제작이 남긴 실제 번들 런타임(release/_staging 의 runtime/python)을 pyc 없이 복사한 새 사본에 돌리면 오류 없이 끝나고 사본에 .pyc 가 0개다. 다른 새 사본에 고치기 전 판(f040925d 의 make_release.ps1)의 함수를 돌리면 .pyc 가 생기고, 그 상대 경로 목록이 실패한 스테이징 전체의 .pyc 목록과 정확히 같다(스테이징에 runtime/python 밖 pyc 0 — 이번 실패에서 관측된 모든 pyc 경로를 고치기 전 함수로 재현함. 다른 제작 단계의 중복 생성 가능성까지 배제하는 결과는 아니며, 고친 뒤 전체 제작의 ZIP 금지 검사로 최종 확인한다). 확인 스크립트는 이 모두가 맞을 때만 종료 0", "failure": "고친 함수가 pyc 를 남김 · pythonw 확인 실패 · 고치기 전 판이 재현되지 않음(시험이 결함을 못 봄) · 스테이징에 이 확인으로 재현되지 않는 pyc 가 있음", "required": true, "verification": ["2961bc9c8a9949aa8d39b8694692b00e"]},
    {"id": "regression", "success": "backend/tests/test_open_link_release.py(pythonw 확인의 ArgumentList 가 '-I', '-S', '-B', '-c' 를 이 순서로 잇는다는 새 단언 포함 — 함수 전체에서 찾으면 python.exe 의 -B 때문에, -c 뒤에 붙으면 스크립트 인자가 되어 결함을 놓친다)와 backend/tests/test_release_frontend_build.py 가 통과한다", "failure": "회귀 또는 새 단언 실패", "required": true, "verification": ["fb85cfd762f04fed882693517511db61"]}
  ],
  "decisions": [
    {"id": "only-release-probe", "choice": "-B 는 make_release.ps1 의 pythonw 확인 한 곳에만 더한다", "why": "이번 고침은 새 배포판에 pyc 가 실리는 것을 막는 데 한정한다 — 배포판에 실리는 것은 제작 스테이징뿐이다. 업데이터의 설치 지문 검사 Assert-InstalledReleasePayload(update_release_contract.ps1:180)는 배포 목록 항목만 대조하고 목록 밖 파일은 보지 않으며(패키지 풀기 :1452→:1455·설치 :1534→:1541 모두 pythonw 확인 뒤), 업데이터의 pythonw 확인은 -PackageRoot 에 open_link.py 가 있을 때만 돌고(:760) 호출은 :1452·:1469·:1534(들어오는 패키지)·:1722(이미 최신일 때 지금 설치본) 넷뿐이라, pyc 를 목록에 실은 옛 판(open_link 이전)으로 내려가는 업데이트에서는 돌지 않고 실패 뒤 자동 복원(:1545~1585)은 이 확인을 부르지 않는다(호출 목록으로 확인, 실행 확인은 안 함, 해결했다고 주장하지 않음). MV_agent.bat 도 원래 -B 없이 돈다. 업데이터·qualify 는 해가 없고 이번에 업데이트 경로를 건드리지 않는다. 등록 명령은 거기에 더해 저장된 등록 문자열 비교·옛 등록 정리·시험이 그 글자를 본다", "alternative": "pythonw 실행 4곳 모두 -B", "revisit": "설치 검사가 목록 밖 파일을 거부하도록 바뀌거나, 설치본 런타임에 쓰기를 막아야 할 때"},
    {"id": "verify-build-after-merge", "choice": "실제 릴리스 제작(-SkipPublish)은 main 반영 뒤 고정 폴더에서 확인하고, 그 전에는 실제 번들 런타임 사본에서 함수 자체를 돌려 확인한다", "why": "배포판은 고정 폴더(HEAD = origin/main)에서만 만든다는 안전선. 함수 단위 확인은 이번 결함 경로(스테이징 런타임에서 pythonw 실행)를 그대로 재현한다", "alternative": "임시 작업실에서 make_release 를 돌림 — 안전선 위반", "revisit": "제작 스크립트에 격리 제작 모드가 생길 때"}
  ],
  "evidence": {"target": {"kind": "worktree"}, "consensus": [
    {"host": "codex", "session": "01a1b69d-c85c-7f53-b3e0-2e18f72a71cb", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/08/rollout-2026-11-08T00-25-56-01a1b69d-c85c-7f53-b3e0-2e18f72a71cb.jsonl"},
    {"host": "claude", "session": "9248a512-84de-4837-b555-660862bb9f7e", "transcript": "C:/Users/FX-PC06/.claude/projects/D--ClaudeCode/9248a512-84de-4837-b555-660862bb9f7e.jsonl"}
  ], "review": {"host": "codex", "session": "01a1b6a8-d741-79c3-89a1-7a8cbc3520c1", "transcript": "C:/Users/FX-PC06/.codex/sessions/2026/11/08/rollout-2026-11-08T00-38-01-01a1b6a8-d741-79c3-89a1-7a8cbc3520c1.jsonl"}}
}
```
