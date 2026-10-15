# MV Hub MCP 어댑터

## 현재 작업: 영속 연결 v2

같은 PC의 Codex·Claude Code는 MV Hub의 **AI·MCP 연결 → Codex·Claude Code 연결 허용**에서 등록한다.
다른 로컬 stdio MCP 앱은 그 화면에서 제공하는 설정을 한 번 복사한다. 클라이언트 자체 신뢰 승인과
최초 MCP 새로고침/재시작이 필요할 수 있다. 웹·휴대폰 원격 커넥터는 이번 범위가 아니다.
MV Hub와 LLM은 같은 Windows 로그인 사용자로 실행한다. 서비스 계정이나 다른 사용자 실행은 자동 등록을 차단한다.
기존 설정 사본은 사용자 설정 폴더의 `.mvhub-backup-*`에 보존되며 외부로 공유하지 않는다.

v2 등록 설정에는 `--url`과 `--profile`이 들어간다. 프로필은 Windows DPAPI로 암호화하며
클라이언트별로 분리한다. 설정에는 프로필 파일 경로만 있고 비밀 원문이나 허브 로그인 토큰은 없다.
최초 등록 뒤에는 재연결 코드를 입력하지 않는다. 명시적 권한 해제·로그아웃·계정 변경 등에는 재등록이 필요하다.

새 등록은 계정 기준이며 현재 앱의 공간 선택에 묶이지 않는다. 기존 공간 고정 연결은 명시 재등록할 때만 바뀐다.
`read_context(kind="workspaces")`로 실제 접근 가능한 공간을 조회한 뒤, 다른 조회와 계획에
`workspace_scope`와 팀 공간의 `workspace_id`를 명시한다. 기본 생성은 캔버스 없이 MV Hub 라이브러리에 기록된다.
`read_context`로 실제 모델·프로젝트·컷·자료를 확인하고 `prepare_generation_plan` → `execute_generation_plan` → `get_result(wait_seconds=25)` 순서로 처리한다.
Codex PC·휴대폰에는 `get_result`의 `display_directory`에 기존 작업 소유 로컬 절대경로를 지정하고,
반환된 `display.reference`를 최종 답변에 그대로 넣는다. 어댑터가 이미지 내장 HTML을 준비하며 LLM의 별도 제작은 필요 없다.
ImageContent 직접 표시 앱은 폴더를 생략할 수 있다. 파일 준비 성공은 실제 화면 표시 확인과 다르다.
Codex·Claude 공통으로 실행 전 조건·위치를 알리고 `presentation.stage` 변경 시 `message`를 안내한다.
최종 답변은 `card_text`(상태→조건→위치) 다음에 이미지를 표시한다. Claude는 네이티브 이미지 또는
`display.path`의 같은 결과 카드를 사용하며 Codex 전용 참조를 출력하지 않는다. 선택 항목 완료는 전체 완료가 아니다.
미리보기 조회는 생성·과금 없이 기존 결과만 읽는다. 영상은 기존 포스터만 표시하고, 원본은 MV Hub에서 확인한다.
MCP 이미지 표시를 지원하지 않는 앱에서도 생성 ID와 상태는 텍스트로 확인할 수 있다. 도구 설명은 완료 뒤 결과 조회를 안내한다.
프로젝트·컷을 생략할 수 있다. `add_to_canvas`는 사용자가 요청할 때만 `scene_id`를 명시하며 새 생성을 하지 않는다.
브라우저 탭을 닫아도 기본 생성은 가능하지만 허브 서버와 작업자는 실행 중이어야 한다.

새 포장 파일 `local_setup.py`는 표준 라이브러리만 사용한다. 실제 등록 시험은 임시 사용자 폴더에서 실행한다.

```powershell
& "$env:LOCALAPPDATA\MVHub-MCP\venv\Scripts\python.exe" tools\mcp_adapter\test_server.py
& "$env:LOCALAPPDATA\MVHub-MCP\venv\Scripts\python.exe" tools\mcp_adapter\test_local_setup.py
& "$env:LOCALAPPDATA\MVHub-MCP\venv\Scripts\python.exe" tools\mcp_adapter\test_persistent.py
```

v2 구현·검증·독립 리뷰 상태의 정본은 [MCP 운영 문서](../../docs/MCP_INTEGRATION.md)다.
아래는 `--url`만 쓰는 **구형 v1 설정과 당시 실증 기록**이다. v2에 코드 페어링·탭 상주·단일 클라이언트 제한을 적용하지 않는다.

## 구형 v1 계약과 개발 검증 이력

Claude·Codex 같은 MCP 클라이언트가 **열려 있는 MV Hub 앱**과 연결하는 로컬 stdio 어댑터다.
힉스필드에 직접 생성 요청을 보내지 않는다. 자료 조회와 생성 계획 준비를 도구로 제공하고,
최초 앱 연결에서 실행을 허용하면, 명확한 사용자 생성 요청에 따라 기존 생성·기록 경로로 바로 실행한다.
생성마다 앱 승인 버튼을 누를 필요는 없다. 연결한 앱은 열어 두어야 한다.

## 릴리스 번들 계약 (개발 검증 완료)

릴리스 제작 코드는 `server.py`, `requirements.txt`, `requirements.lock.txt`와 전용
`tools/mcp_adapter/site-packages`를 함께 포장한다. 잠근 의존성 29개를 `--no-deps`로 설치하며,
백엔드 Python 패키지와 별도로 관리한다. 실행 파일은 설치 폴더의 `runtime/python/python.exe`이고
인자 순서는 `-I`, `-S`, 어댑터 절대 경로, `--url`, 로컬 허브 주소다.
두 격리 옵션을 생략하지 않는다. `/api/mcp/app/setup`의 `python_args`가 이 순서를 제공한다.
개발 환경은 빈 목록이며 예전 응답에 필드가 없어도 기존 설정을 유지한다.

릴리스 번들이 불완전하면 설정 조회가 503 `MCP 번들이 불완전합니다. 앱을 다시 설치하세요.`로 중단된다.
작업자에게 개발용 Python 설치로 우회시키지 않는다. 아직 전체 ZIP 제작·설치·배포는 하지 않았다.
한글·공백 이동 경로의 패키지 모형에서 실제 SDK stdio 도구 7개, 환경변수 오염 격리,
백엔드 `.pth` 제외를 확인했으며 자세한 근거와 미완료 항목은 [운영 기록](../../docs/MCP_INTEGRATION.md#실사용-연결-준비-2026-10-15)에 있다.
패키지 모형과 별도로 개발 DB 사본에서 Claude MCP의 이미지 1건 생성 완료 및 기록을 확인했다.
새 Codex CLI도 7개 도구 로드·페어링·조회와 완료 결과 확인에 성공했고 추가 유료 생성은 하지 않았다.
이 결과가 전체 ZIP 설치나 기존 데스크톱 대화의 도구 자동 갱신을 뜻하지는 않는다. Claude와 명시된 개발 검증 범위의 마감에 합의했다.

업데이트할 때는 기존 MCP 프로세스를 종료하고 앱에서 등록 설정을 다시 복사해 경로·옵션을 대조한다.
클라이언트 재시작/MCP 재로드와 새 코드 페어링이 필요하다. 기존 대화의 도구 목록이 자동 갱신됐다고 가정하지 않는다.

## 개발 환경 설치

Python 3.11 이상을 사용한다. 앱의 기존 Python 환경과 의존성을 섞지 않도록 별도 환경을 만든다.
아래 명령은 저장소 루트의 PowerShell에서 실행한다. 이미 있는 환경은 덮어쓰지 않는다.

```powershell
$mcpEnvironment = Join-Path $env:LOCALAPPDATA 'MVHub-MCP\venv'
if (Test-Path -LiteralPath $mcpEnvironment) { throw '기존 환경을 먼저 확인하세요.' }
python -m venv $mcpEnvironment
if ($LASTEXITCODE -ne 0) { throw '환경 생성 실패' }
& "$mcpEnvironment\Scripts\python.exe" -m pip install -r tools\mcp_adapter\requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'MCP 설치 실패' }
```

SDK 버전은 `mcp==2.3.0`으로 고정한다. 아래 설정 예시는 직접 설치한 Python과 개발 저장소의
절대 경로로 바꾼다. 이 문서를 읽거나 어댑터를 설치하는 것만으로 클라이언트 설정은 바뀌지 않는다.

## 개발 환경 클라이언트 설정 예

Claude의 MCP 서버 JSON 설정:

```json
{
  "mcpServers": {
    "mvhub": {
      "command": "C:\\Users\\YOUR_USER\\AppData\\Local\\MVHub-MCP\\venv\\Scripts\\python.exe",
      "args": ["D:\\YOUR_REPO\\tools\\mcp_adapter\\server.py", "--url", "http://127.0.0.1:8012"]
    }
  }
}
```

Codex의 MCP 서버 TOML 설정:

설정 필드는 [공식 설정 참고 문서](https://learn.chatgpt.com/docs/config-file/config-reference)를 따른다.

```toml
[mcp_servers.mvhub]
command = 'C:\Users\YOUR_USER\AppData\Local\MVHub-MCP\venv\Scripts\python.exe'
args = ['D:\YOUR_REPO\tools\mcp_adapter\server.py', '--url', 'http://127.0.0.1:8012']
tool_timeout_sec = 150
```

예시는 MCP 지원 코드로 실행한 격리 개발 서버 `8012`를 지정한다. 일반 dev에 MCP가 없으면 사용할 수 없다.
대상 허브에 MCP 기능이 구현된 버전이 실행 중이어야 한다. `--url`은 필수이며 생략하면 시작하지 않는다.
공유 서버 주소나 외부 주소는 받지 않는다.
원격 웹 클라이언트를 위한 공개 HTTP MCP 서버는 제공하지 않는다.

## 사용

1. `check_connection`으로 주소의 MCP 지원 여부를 확인한다. `available`은 기능 응답만 확인한 것이며 실제 계정·페어링·생성 준비를 뜻하지 않는다.
   `unavailable`이면 앱 실행·주소·응답을, `wrong_app`이면 MCP 지원 버전과 포트를 확인한다.
2. MV Hub 앱에서 사용할 계정·워크스페이스·씬을 열고 MCP 창을 연다.
3. 클라이언트에서 `connect`를 호출하고 받은 6자리 코드를 앱에 입력해 자료 조회·크레딧 사용을 포함한 실행을 허용한다.
4. `read_context(kind="scene")`로 현재 씬과 `context_id`를 읽는다. 프로젝트·생성물·모델도 조회할 수 있다.
5. 해당 `context_id`와 자료 ID를 넣어 `prepare_generation_plan`으로 계획을 준비한다.
6. 사용자가 명확히 생성을 요청했다면 `execute_generation_plan(plan_id=...)`을 호출한다. 실제 크레딧이 소모될 수 있다.
7. 시작 응답은 접수나 완료가 아니다. `get_plan`의 실행 오류·항목 상태·`generation_status`로 확인한다.

`request_execution`은 기존 호환용으로 앱 승인 화면만 연다. 이 도구를 호출하는 것만으로 생성되지는 않는다.
구버전 연결의 `can_execute`는 false다. 앱에서 연결을 해제하고 실행 허용으로 새로 연결해야 직접 실행할 수 있다.
불명확한 응답이나 실패는 자동 재제출하지 않는다. `execution=null`은 현재 앱의 관측값이 없다는 뜻이며 미실행을 보장하지 않는다.

연결이 새로 시작되면 다시 페어링해야 한다. 다른 활성 연결이 있으면 앱에서 연결 상태를 먼저 확인한다.
클라이언트 이름은 요청자가 주장한 표시값이며 실제 실행 모델을 증명하지 않는다.
런타임 인증 비밀값은 어댑터 메모리에만 두고 HTTP 헤더로 전달한다. 설정·도구 인자·도구 결과에 넣지 않는다.
페어링 코드는 사용자가 앱에 입력하기 위한 값이다. 작업 결과로 반환된 자료는 사용하는 AI 서비스에 전달될 수 있다.

## 범위와 제한

- 도구: `check_connection`, `connect`, `read_context`, `prepare_generation_plan`, `get_plan`, `request_execution`, `execute_generation_plan`.
- 계획: 항목 1~20개, 항목별 참고 자료 0~8개. 현재 버전은 `depends_on` 등 항목 간 의존성 입력을 받지 않는다.
- 조회: 1~50개. 요청 JSON 64 KiB, HTTP 응답 256 KiB 이하.
- HTTP 요청 제한 30초, 작업 결과 대기 최대 90초. 시간 초과 시 자동 재제출하지 않고 앱에서 처리 상태를 확인한다.
- 어댑터는 `http://127.0.0.1:PORT`, `http://[::1]:PORT`만 허용한다. 프록시·리디렉션·호스트 이름은 사용하지 않는다.
- 도구 목록은 페어링 전에 보이지만, 업무 자료 조회와 계획 작업은 앱 승인 전 허용하지 않는다.
- stdout은 MCP 통신 전용이다. 진단은 stderr를 사용한다.

## 이 PC의 재사용 설정 (2026-10-15)

Codex와 Claude Code 사용자 설정의 `mvhub`는 다음을 사용한다. 임시 시험용 8014에는 연결하지 않는다.

- Python: `C:\Users\FX-PC06\AppData\Local\MVHub-MCP\venv\Scripts\python.exe` (`mcp==2.3.0`).
- 어댑터: `C:\Users\FX-PC06\.codex\worktrees\mvhub-mcp\MV-hub-S-dev\tools\mcp_adapter\server.py`.
- 허브: `http://127.0.0.1:8016`. 최초 등록 당시에는 실행하지 않았으나 현재는 개발 DB 사본으로 격리 실행 중이다.
  사용자 승인 후 실제 계정·워크스페이스 연결과 Claude의 이미지 1건 생성·기록을 확인했다.
  검증 범위와 남은 조건은 [현행 상태](../../docs/MCP_INTEGRATION.md#실사용-연결-준비-2026-10-15)를 따른다.
- Codex `tool_timeout_sec=150`. 새 클라이언트 세션에서 도구 로드를 확인한다. 기존 대화에 자동 반영됐다고 가정하지 않는다.
- Claude Desktop·일반 ChatGPT 웹 커넥터 등록은 별도다. 이번 등록은 이 PC의 Codex·Claude Code다.
- 기존 Codex 대화에는 옛 6개 도구·schema가 남아 있었으나 새 CLI 세션에서는 7개 도구와 연결·완료 결과 조회를 확인했다.
  기존 데스크톱 대화까지 자동 갱신됐다고 가정하지 않는다. SDK 패키지 모형과 실제 CLI 검증 근거는 구분한다.

실제 등록 명령(기존 동명 등록이 없는 상태에서 실행):

```powershell
$mcpPython = "$env:LOCALAPPDATA\MVHub-MCP\venv\Scripts\python.exe"
$mcpAdapter = 'C:\Users\FX-PC06\.codex\worktrees\mvhub-mcp\MV-hub-S-dev\tools\mcp_adapter\server.py'
# 이 PC에서 버전을 확인한 CODEX_CLI_PATH를 사용했다.
& $env:CODEX_CLI_PATH mcp add mvhub -- $mcpPython $mcpAdapter --url http://127.0.0.1:8016
claude.cmd mcp add --scope user --transport stdio mvhub -- $mcpPython $mcpAdapter --url http://127.0.0.1:8016
```

Codex 등록 명령 뒤 `%USERPROFILE%\.codex\config.toml`의 `[mcp_servers.mvhub]` 절에
`tool_timeout_sec = 150`을 추가한다. 위 등록 명령만으로는 이 값이 저장되지 않는다.
등록 해제는 `& $env:CODEX_CLI_PATH mcp remove mvhub`, `claude.cmd mcp remove --scope user mvhub`다.
등록은 미커밋 worktree를 참조한다. 이 폴더를 삭제·이동하면 연결이 깨진다. 릴리스 경로로 전환할 때 다시 등록한다.

같은 어댑터 세션과 앱 연결이 살아 있으면 후속 요청마다 코드를 입력하지 않는다.
새 LLM 세션에서 어댑터가 새로 실행될 때, 어댑터/허브 재시작, 계정·워크스페이스 변경, 앱 연결 임대 만료 시 다시 페어링한다.
동시에 한 클라이언트만 연결된다. Claude에서 Codex로 바꿀 때는 앱에서 기존 연결을 해제한다.

실제 앱 가동 방법과 사용 흐름은 [MCP 운영 문서](../../docs/MCP_INTEGRATION.md#실사용-연결-준비-2026-10-15)를 따른다.

## 격리 시험

```powershell
& "$mcpEnvironment\Scripts\python.exe" tools\mcp_adapter\test_server.py
```

시험은 임시 loopback HTTP 서버와 실제 SDK stdio 하위 프로세스를 연결한다.
실사용 DB·서버·힉스필드 생성 API에 접근하지 않는다. 도구 schema, 페어링 전 차단,
계획·승인 화면·직접 실행 요청 전달, 실행 권한 표시, 요청·응답 크기, 인증 비밀값 노출 방지, 프록시·리디렉션 차단을 확인한다.
