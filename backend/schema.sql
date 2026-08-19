-- Content Hub — 로컬 SQLite 스키마 (Phase 1)
-- 설계 근거: DESIGN.md §2 데이터 모델
-- 적용:  sqlite3 content_hub.db < backend/schema.sql
--        또는 app.db.init_db() 로 자동 적용
--
-- 주의: journal_mode = WAL 은 DB 파일에 영속적으로 기록되는 설정이라
--        스키마와 함께 선언해 둔다. foreign_keys 는 연결마다 다시 켜야 하므로
--        db.py 의 커넥션 팩토리에서도 PRAGMA foreign_keys = ON 을 반복 적용한다.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 작업자(개인/팀 계정 구분)
CREATE TABLE IF NOT EXISTS worker (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'personal'   -- 'personal' | 'team'
);

-- 생성 기록(프롬프트, 모델, 파라미터, 컬러, 상태)
CREATE TABLE IF NOT EXISTS generation (
    id         TEXT PRIMARY KEY,
    worker_id  TEXT NOT NULL REFERENCES worker(id),
    prompt     TEXT NOT NULL,                         -- CLI 로 보낸 본문(인라인 칩 제외)
    display_prompt TEXT,                              -- UI 표시용(칩 자리에 @소스명). 없으면 prompt 사용
    model      TEXT,
    params     TEXT,                                 -- JSON 문자열
    color      TEXT,                                 -- 컬러 마커 (hex/name)
    status     TEXT NOT NULL DEFAULT 'pending',      -- pending|running|done|failed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sort_ts    REAL,                                 -- 정렬용 정밀 epoch(힉스필드 created_at sub-second). 표시는 created_at, 정렬은 이것
    job_id     TEXT,                                 -- Higgsfield 잡 id. 로컬 생성본↔동기화본 연결(중복 방지)
    is_source  INTEGER NOT NULL DEFAULT 0,           -- 소스 라이브러리 등록 여부(@ 로 프롬프트에서 참조)
    source_name TEXT,                                -- @이름 (예: 매튜). 소스로 등록 시 부여
    comment    TEXT,                                 -- 카드 코멘트(메모)
    error      TEXT,                                 -- 실패 사유(CLI stderr 등). status=failed 일 때 표시
    hf_missing INTEGER NOT NULL DEFAULT 0,           -- 힉스필드에서 삭제됨(generate get 검증). 로컬-only 판정
    creator_uid TEXT,                                -- 생성자 식별자(result_url 의 user_<id>). 팀 워크스페이스에서 누가 만들었나
    is_final   INTEGER NOT NULL DEFAULT 0,           -- v02 CMS: Supervisor 가 지정한 최종(골드). 1=최종
    final_by   TEXT,                                 -- 최종 지정자 creator_uid(누가 골드 찍었나)
    final_at   TEXT,                                 -- 최종 지정 시각
    origin     TEXT,                                 -- 행 출생: 'synced'(동기화본) | 'local'(내 생성/가져오기). 동기화↔로컬 판별을 id==job_id 좌표에서 분리(id 통일 리팩터 0a)
    generator  TEXT,                                 -- 만든 도구: NULL=힉스필드(기본) | 'comfy'(캔버스 Comfy 노드 출력을 저장). HF 삭제검증 제외·필터·공유 앵커 구분용
    workspace_scope TEXT NOT NULL DEFAULT 'unknown' CHECK(workspace_scope IN ('team','personal','unknown')),
    workspace_id TEXT,                               -- team일 때 Higgsfield workspace UUID
    workspace_name TEXT                              -- 현재 귀속 워크스페이스 표시 이름(생성 시 기본값, 수동 변경 가능)
);

-- 공유·최종 생성물 원본 보존 작업. 다운로드를 요청 응답과 분리하고 상태를 영속화해
-- 프로세스 재시작 뒤에도 이어서 처리한다. 원격 URL·프롬프트는 이 테이블에 기록하지 않는다.
CREATE TABLE IF NOT EXISTS media_preservation (
    generation_id TEXT PRIMARY KEY REFERENCES generation(id) ON DELETE CASCADE,
    reason        TEXT NOT NULL,                    -- shared | final | manual | admin
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending|running|complete|partial|failed|capacity
    attempts      INTEGER NOT NULL DEFAULT 0,
    cached_count  INTEGER NOT NULL DEFAULT 0,
    failed_count  INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    bytes_cached  INTEGER NOT NULL DEFAULT 0,
    error_code    TEXT,                             -- 안전한 분류값만(URL·예외 원문 금지)
    next_retry_at TEXT,
    requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_preservation_due
    ON media_preservation(status, next_retry_at, updated_at);

-- 생성자(워크스페이스 멤버) uid → 사용자 지정 이름. CLI 가 uid→이름을 안 주므로 직접 라벨링.
CREATE TABLE IF NOT EXISTS creator (
    uid  TEXT PRIMARY KEY,
    name TEXT,
    global_role TEXT                           -- v02 전역 역할 CSV(복수 가능) admin/product_director/production_director/member
);

-- 앱 설정(key-value). 제공자 신원(provider_uid/name/email) 등 단일값 보관.
-- 제공자 신원 = 공유 파일명·작성자 표기의 기준. CLI account status 이메일에서 기본값을 잡고
-- 사용자가 표시이름을 바꾸면 그때부터 그 이름으로 표기·파일명 생성.
CREATE TABLE IF NOT EXISTS app_setting (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- 최신 100건 창을 넘어선 누락 위험과 과거 이력 자동 보충의 계정별 감사 상태.
-- 프로세스 메모리가 아니라 DB에 두어 재시작 뒤에도 gap·쿨다운·최근 성공 판정을 이어간다.
CREATE TABLE IF NOT EXISTS history_import_audit (
    account_email        TEXT PRIMARY KEY,
    gap_detected_at      TEXT,
    gap_resolved_at      TEXT,
    last_auto_started_at TEXT,
    last_success_at      TEXT
);
-- 주의: idx_generation_job 인덱스는 db.py 의 _migrate 에서 생성한다
-- (기존 DB 는 ALTER 로 컬럼을 먼저 추가해야 하므로 여기서 만들면 executescript 가 실패).

-- 생성 결과물(이미지/영상 + 썸네일)
CREATE TABLE IF NOT EXISTS asset (
    id             TEXT PRIMARY KEY,
    generation_id  TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    type           TEXT NOT NULL,                    -- 'image' | 'video'
    file_path      TEXT NOT NULL,                    -- 로컬 캐시 경로(/media/..) 또는 원격 URL
    thumbnail_path TEXT,
    source_url     TEXT                              -- 원본 원격 URL 보존(출처 영속, byte-cache 후에도)
);

-- 생성에 쓰인 레퍼런스(이미지/영상 + 썸네일)
CREATE TABLE IF NOT EXISTS reference (
    id             TEXT PRIMARY KEY,
    type           TEXT NOT NULL,                    -- 'image' | 'video'
    file_path      TEXT NOT NULL,                    -- 로컬 캐시 경로(/media/..) 또는 원격 URL
    thumbnail_path TEXT,
    source         TEXT,                             -- 'uploaded' | 'from_generation'
    source_url     TEXT,                             -- 원본 원격 URL 보존(소스 재사용 영속성)
    share_url      TEXT                              -- ★공유 전용: 힉스필드 공개 URL. 로컬 동작엔 미사용
                                                     --   (로컬은 file_path 토큰 그대로, 번들 export 만 이걸 씀)
);

-- generation ↔ reference 다대다 연결. role 에 @Image/@Video 슬롯 저장
CREATE TABLE IF NOT EXISTS gen_reference (
    generation_id TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    reference_id  TEXT NOT NULL REFERENCES reference(id),
    role          TEXT,                              -- '@Image1', '@Video' 등 슬롯
    PRIMARY KEY (generation_id, reference_id, role)
);

-- 태그
CREATE TABLE IF NOT EXISTS tag (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

-- generation ↔ tag 다대다 연결
CREATE TABLE IF NOT EXISTS gen_tag (
    generation_id TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    tag_id        TEXT NOT NULL REFERENCES tag(id),
    PRIMARY KEY (generation_id, tag_id)
);

-- 자동 태그(별도 네임스페이스) — 일반 tag 와 분리. 필터 사이드바에서만 관리,
-- # 피커·카드 T팝업·일반 태그 facets 에는 절대 노출되지 않는다(구조적 격리).
-- 사이드바에서 '무장'한 자동 태그는 생성 시 새 결과물에 자동 적용된다.
CREATE TABLE IF NOT EXISTS auto_tag (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    owner_uid TEXT,                       -- 계정별 전역 태그 소유자(creator_uid). NULL=레거시/단독
    UNIQUE(owner_uid, name)               -- 같은 이름이라도 계정마다 따로 가질 수 있다(전역 충돌 제거)
);
CREATE TABLE IF NOT EXISTS gen_auto_tag (
    generation_id TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    auto_tag_id   TEXT NOT NULL REFERENCES auto_tag(id),
    PRIMARY KEY (generation_id, auto_tag_id)
);

-- 프로젝트(작업 묶음) — 공유·이동의 단위. 로드맵 §0-4/§4-4.
-- 개인필터(태그·컬러)와 다르다: 프로젝트는 팀 공통 그룹이며, 선택하면 그 안 결과물만 보인다.
CREATE TABLE IF NOT EXISTS project (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'team',      -- 'team' | 'personal'
    created_by TEXT,                              -- 만든 사람(provider/creator uid). 로그인 전엔 제공자
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived   INTEGER NOT NULL DEFAULT 0,        -- 보관(목록에서 숨김, 데이터는 보존)
    sort_order INTEGER,                           -- 관리자 수동 정렬 순서(작을수록 위). NULL=미지정(생성물 순 폴백)
    render_root_path TEXT,                        -- 팀 공유 렌더 폴더 경로(예 Z:\...). 각 PC 가 이 경로를 자기 디스크에서 읽는다(경로만 공유)
    workspace_scope TEXT NOT NULL DEFAULT 'unknown' CHECK(workspace_scope IN ('team','personal','unknown')),
    workspace_id TEXT,                            -- 이 프로젝트가 속한 Higgsfield workspace UUID
    workspace_name TEXT                           -- 프로젝트 지정 당시 표시 이름 스냅샷
);

-- 프로젝트 멤버(전방 호환) — 등급·로그인 단계에서 가시성 enforcement 의 근거가 된다.
-- 현재(로그인 전)는 기록만 하고 차단엔 쓰지 않는다(로드맵: 식별 먼저, 차단은 나중).
CREATE TABLE IF NOT EXISTS project_member (
    project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    creator_uid  TEXT NOT NULL,
    project_role TEXT,                          -- v02 프로젝트 역할 project_manager/supervisor/editor
    PRIMARY KEY (project_id, creator_uid)
);

-- 로그인 계정(보안) — 로드맵 §4-1/§4-2. 멤버(creator)와 별개로 '로그인하는 사람'.
-- 자동 등록(status=pending) → 관리자 승인(approved). 첫 계정은 부트스트랩 관리자(C0/approved).
-- ⚠️ CONTENT_HUB_AUTH=1 일 때만 enforcement 작동(기본 off — 식별 먼저, 차단은 켤 때).
CREATE TABLE IF NOT EXISTS account (
    email         TEXT PRIMARY KEY,
    name          TEXT,
    password_hash TEXT NOT NULL,                 -- pbkdf2_sha256$iter$salt$hash (stdlib)
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    global_role   TEXT,                           -- v02 전역 역할 CSV(복수 가능, enforcement 가 읽는 축)
    creator_uid   TEXT,                           -- 선택: 생성자 식별자 연결(작성자 매핑)
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at   TEXT,
    password_changed_at TEXT                       -- 설정되면 그 이전 발급된 세션 토큰 무효(비번 변경/리셋 시 갱신)
);

-- 에이전트가 보고한 팀 워크스페이스 등록부. CLI에는 조직 전체 멤버 API가 없으므로 각 계정의
-- workspace list 보고를 합쳐 MV-Hub가 확인한 접근 관계를 만든다. 생성물/프로젝트의 스냅샷 이름과
-- 달리 여기의 name/credits는 마지막 보고값이다.
CREATE TABLE IF NOT EXISTS workspace_registry (
    id            TEXT PRIMARY KEY,
    name          TEXT,
    plan_type     TEXT,
    credits       REAL,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspace_member (
    workspace_id  TEXT NOT NULL REFERENCES workspace_registry(id) ON DELETE CASCADE,
    account_email TEXT NOT NULL,
    creator_uid   TEXT,
    user_role     TEXT,
    is_selected   INTEGER NOT NULL DEFAULT 0,
    is_available  INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_id, account_email)
);

-- 발행 기록(누가, 언제, 공개 범위)
CREATE TABLE IF NOT EXISTS share (
    id            TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generation(id),
    shared_by     TEXT NOT NULL REFERENCES worker(id),
    visibility    TEXT NOT NULL DEFAULT 'team',
    shared_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 히스토리(parent_gen → child_gen). relation: 'derived'(재생성/가져오기) | 'reference'(@소스로 생성)
-- ※ relation 컬럼·유니크 인덱스(idx_history_edge)는 _migrate 에서 생성한다(기존 DB ALTER 순서 때문).
-- ※ 옛 이름 lineage → history 리네임은 db._pre_migrate 가 executescript 이전에 처리(빈 테이블 충돌 회피).
CREATE TABLE IF NOT EXISTS history (
    id            TEXT PRIMARY KEY,
    parent_gen_id TEXT NOT NULL REFERENCES generation(id),
    child_gen_id  TEXT NOT NULL REFERENCES generation(id),
    relation      TEXT NOT NULL DEFAULT 'derived'
);

-- 로컬 실행 생성요청 큐 — 허브의 생성/재생성 버튼이 만든 요청을, 그 사람 PC의 에이전트가
-- 가져가 자기 로컬 CLI 로 실행한다(서버는 실행 안 함). 결과는 gen_id placeholder 카드에 채워짐.
-- 모델 핵심: 서버=요청 중계+결과 DB, 실행=각자 로컬 CLI. (project_content_hub_push_model)
CREATE TABLE IF NOT EXISTS gen_request (
    id            TEXT PRIMARY KEY,
    account_email TEXT NOT NULL,                  -- 요청한 로그인 계정(이 계정 에이전트만 가져감)
    creator_uid   TEXT,                           -- 그 계정의 힉스필드 생성자 uid(귀속)
    gen_id        TEXT NOT NULL,                  -- 즉시 만든 placeholder generation(여기 결과가 채워짐)
    kind          TEXT NOT NULL DEFAULT 'create', -- 'create' | 'regenerate'
    payload       TEXT,                           -- JSON: {model, prompt, params, references, source_gen_id}
    status        TEXT NOT NULL DEFAULT 'pending',-- preparing | pending | claimed | submitting | tracking | verifying | blocked | recovery_required | done | failed | canceled
    error         TEXT,
    provider_status TEXT,                         -- Higgsfield 원시 상태(알 수 없는 신규값도 그대로 보존)
    last_checked_at TEXT,                         -- generate get 마지막 확인 시각
    next_check_at TEXT,                           -- 다음 권위 조회 예정 시각(진단·복구용)
    check_failures INTEGER NOT NULL DEFAULT 0,    -- 연속 조회/보고 실패 횟수
    lease_owner   TEXT,                           -- 이 요청을 추적 중인 에이전트 식별자
    lease_expires_at TEXT,                        -- 에이전트 유실 시 다른 프로세스가 인계 가능한 시각
    terminal_at   TEXT,                           -- 완료/실패가 최종 확정된 시각
    canvas_attempt_id TEXT,                       -- 캔버스가 요청 전에 저장한 복구 표식
    canvas_scene_id TEXT,                         -- 개인 캔버스 씬 ID(로컬 허브에만 저장)
    canvas_card_id TEXT,                          -- 결과가 돌아갈 생성카드 ID
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_genrequest_acct ON gen_request(account_email, status);
CREATE INDEX IF NOT EXISTS idx_genrequest_gen_latest ON gen_request(gen_id, created_at DESC, id DESC);
-- idx_genrequest_canvas_attempt 는 db_migrations._migrate 에서 만든다.
-- 기존 DB 는 canvas_attempt_id 컬럼을 ALTER 로 먼저 추가해야 하므로 여기서 만들면
-- schema.sql 적용이 마이그레이션보다 앞서 실행되어 앱 시작이 실패한다.

-- 생성 상태 영구 이력. 회전 운영 로그가 오래되어 사라져도 요청→앵커→검증→완료 흐름을
-- generation/request 기준으로 다시 확인할 수 있다. 프롬프트·결과 URL·오류 원문은 저장하지 않는다.
-- generation/gen_request 삭제 후에도 장애 분석 이력이 남아야 하므로 의도적으로 FK를 걸지 않는다.
CREATE TABLE IF NOT EXISTS generation_event (
    id              TEXT PRIMARY KEY,
    generation_id   TEXT NOT NULL,
    request_id      TEXT,
    job_id           TEXT,
    event            TEXT NOT NULL,
    from_phase       TEXT,
    to_phase         TEXT,
    provider_status  TEXT,
    reason_code      TEXT,
    actor_uid        TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_generation_event_gen
    ON generation_event(generation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_generation_event_request
    ON generation_event(request_id, created_at DESC, id DESC);

-- 관리자·프로젝트 중요 변경 감사 기록. details에는 허용된 짧은 메타만 들어가며
-- 비밀번호·이메일·프롬프트·URL 같은 민감 원문은 공통 저장 함수가 제거한다.
CREATE TABLE IF NOT EXISTS audit_event (
    id          TEXT PRIMARY KEY,
    action      TEXT NOT NULL,
    actor_uid   TEXT,
    target_type TEXT NOT NULL,
    target_id   TEXT,
    project_id  TEXT,
    fields      TEXT NOT NULL DEFAULT '[]',
    details     TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_event_created
    ON audit_event(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_project
    ON audit_event(project_id, created_at DESC, id DESC);

-- 모든 상태 변경을 같은 DB 트랜잭션에서 자동 포착한다. 애플리케이션의 의미 이벤트
-- (요청됨/앵커확보/결과대기 등)와 함께 남아, 누락 없이 상태 전이를 재구성할 수 있다.
CREATE TRIGGER IF NOT EXISTS trg_generation_event_insert
AFTER INSERT ON generation
BEGIN
    INSERT INTO generation_event(id,generation_id,job_id,event,to_phase)
    VALUES(lower(hex(randomblob(16))),NEW.id,NEW.job_id,'generation_status_changed',NEW.status);
END;

CREATE TRIGGER IF NOT EXISTS trg_generation_event_status
AFTER UPDATE OF status ON generation
WHEN OLD.status IS NOT NEW.status
BEGIN
    INSERT INTO generation_event(id,generation_id,job_id,event,from_phase,to_phase)
    VALUES(lower(hex(randomblob(16))),NEW.id,NEW.job_id,'generation_status_changed',OLD.status,NEW.status);
END;

CREATE TRIGGER IF NOT EXISTS trg_gen_request_event_insert
AFTER INSERT ON gen_request
BEGIN
    INSERT INTO generation_event(id,generation_id,request_id,event,to_phase,actor_uid)
    VALUES(
        lower(hex(randomblob(16))),NEW.gen_id,NEW.id,'request_status_changed',NEW.status,
        CASE WHEN instr(COALESCE(NEW.creator_uid,''),'@')>0 THEN NULL ELSE NEW.creator_uid END
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_gen_request_event_status
AFTER UPDATE OF status ON gen_request
WHEN OLD.status IS NOT NEW.status
BEGIN
    INSERT INTO generation_event(
        id,generation_id,request_id,event,from_phase,to_phase,provider_status,actor_uid
    ) VALUES(
        lower(hex(randomblob(16))),NEW.gen_id,NEW.id,'request_status_changed',
        OLD.status,NEW.status,NULL,
        CASE WHEN instr(COALESCE(NEW.creator_uid,''),'@')>0 THEN NULL ELSE NEW.creator_uid END
    );
END;

-- 분리 창(Assets 파일 브라우저)용 파일별 메타데이터(소스/태그/코멘트/컬러).
-- 파일은 generation 이 아니므로 (project, path) 키로 별도 보관.
-- ★계정별 개인화: owner_uid(creator_uid)별로 같은 파일에 각자 다른 설정을 가진다 — 남의 설정과
--   절대 안 섞인다(각자 자기 소스/태그/컬러로 필터·생성). 코멘트 스레드(asset_comment)만 공유.
CREATE TABLE IF NOT EXISTS asset_meta (
    project     TEXT NOT NULL,
    path        TEXT NOT NULL,
    owner_uid   TEXT NOT NULL DEFAULT '',          -- 개인 에셋 설정 소유자(creator_uid). ''=레거시/단독
    is_source   INTEGER NOT NULL DEFAULT 0,
    source_name TEXT,
    tags        TEXT,                              -- JSON 배열 문자열
    comment     TEXT,
    color       TEXT,
    content_sha TEXT,                              -- 파일 내용 지문(sha256). 폴더/파일명 바뀌어도 소스 재매칭용
    PRIMARY KEY (project, path, owner_uid)
);

-- 파일 코멘트 스레드(공유 — 누가/언제/무엇을). asset_meta 와 별개로 다대일.
CREATE TABLE IF NOT EXISTS asset_comment (
    id         TEXT PRIMARY KEY,
    project    TEXT NOT NULL,
    path       TEXT NOT NULL,
    author     TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    parent_id  TEXT,                                 -- 답글이면 부모 코멘트 id
    muted      INTEGER NOT NULL DEFAULT 0,           -- [구] '내 알림 끄기' 캡처 — 비공개 코멘트로 대체, 잔존 데이터용
    is_private INTEGER NOT NULL DEFAULT 0            -- 1=비공개(작성자 로컬 DB 에만 존재, 서버·번들로 안 나감)
);
CREATE INDEX IF NOT EXISTS idx_asset_comment_pp ON asset_comment(project, path);

-- 사용자별 코멘트 마지막 확인 시각(미확인 C 뱃지 계산용)
CREATE TABLE IF NOT EXISTS asset_comment_read (
    worker_id TEXT NOT NULL,
    project   TEXT NOT NULL,
    path      TEXT NOT NULL,
    read_at   TEXT NOT NULL,
    PRIMARY KEY (worker_id, project, path)
);

-- 생성본 코멘트 스레드(공유, 에셋과 별개) — 글·답글(parent_id). 팀 공유 대상.
-- asset_comment 와 동일 모델이되 키가 (project,path) 가 아니라 gen_id.
CREATE TABLE IF NOT EXISTS generation_comment (
    id         TEXT PRIMARY KEY,
    gen_id     TEXT NOT NULL,
    author     TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    parent_id  TEXT,                                 -- 답글이면 부모 코멘트 id
    muted      INTEGER NOT NULL DEFAULT 0,           -- [구] '내 알림 끄기' 캡처 — 비공개 코멘트로 대체, 잔존 데이터용
    is_private INTEGER NOT NULL DEFAULT 0            -- 1=비공개(작성자 로컬 DB 에만 존재, 서버·번들로 안 나감)
);
CREATE INDEX IF NOT EXISTS idx_generation_comment_gen ON generation_comment(gen_id);

-- 사용자별 생성본 코멘트 마지막 확인 시각(미확인 C 뱃지 계산용 — 레거시 gen 단위)
CREATE TABLE IF NOT EXISTS generation_comment_read (
    worker_id TEXT NOT NULL,
    gen_id    TEXT NOT NULL,
    read_at   TEXT NOT NULL,
    PRIMARY KEY (worker_id, gen_id)
);

-- 사용자별 '확인한 개별 생성본 코멘트' — C 뱃지를 코멘트 단위로 끈다.
-- gen 단위 read_at 과 달리 "어떤 코멘트를 봤는지"를 개별로 추적 → 패널에서 NEW 표시·개별 확인.
-- (한 코멘트를 클릭해 확인하면 그 행만 seen 에 들어가고, 그 gen 의 모든 코멘트가 seen 이면 뱃지 꺼짐)
CREATE TABLE IF NOT EXISTS generation_comment_seen (
    worker_id  TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (worker_id, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_gen_comment_seen_w ON generation_comment_seen(worker_id);

-- 남의 팀 카드에 다는 '내 로컬 색'(개인 뷰) — 로컬 generation 행이 없는(남이 만든) 카드용.
-- 색은 서버에 미러 안 하는 개인메타라 계정별 로컬 DB 에만 둔다. anchor = job_id 우선, 없으면 서버 id.
CREATE TABLE IF NOT EXISTS gen_color_overlay (
    anchor TEXT PRIMARY KEY,
    color  TEXT
);

-- 남의 팀 카드에 다는 '내 로컬 태그'(개인 뷰) — 색 shadow 와 동형(태그는 리스트라 다중행).
-- 서버에 미러 안 하는 개인메타. anchor = job_id 우선(없으면 서버 id). 레지스트리는 DISTINCT tag.
CREATE TABLE IF NOT EXISTS gen_tag_overlay (
    anchor TEXT NOT NULL,
    tag    TEXT NOT NULL,
    PRIMARY KEY (anchor, tag)
);

-- 캔버스 씬 백업 — 브라우저 localStorage(원본)의 단방향 미러(로컬→DB). 캐시 소실 시 복구용.
-- 복구는 프론트가 '로컬 버킷 키 자체가 없을 때'만 수행(로컬이 항상 정답 — 코덱스 합의).
-- owner_uid = deps.actor_id(개인 편집물, asset_meta 패턴) — identity._REMAP_PLAN 리맵 대상.
-- project_id: 현재 씬은 전역(항상 '')이지만 미래 프로젝트별 분리를 위해 키에 포함.
CREATE TABLE IF NOT EXISTS scene_backup (
    owner_uid  TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    scene_id   TEXT NOT NULL,
    name       TEXT,
    data       TEXT NOT NULL,                          -- 씬 JSON 원문(프론트 직렬화 그대로)
    data_hash  TEXT NOT NULL,                          -- sha256(data) — 변경분만 재업로드하는 대조 키
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (owner_uid, project_id, scene_id)
);

-- 캔버스 생성카드 소속 — "이 카드에 이 생성물이 담겨 있다"는 사실 하나당 한 줄.
-- scene_backup 이 씬 전체를 통째로 덮어쓰는 미러라, 늦게 저장한 브라우저가 이겨 다른 브라우저에서
-- 쌓은 결과가 사라졌다(실측: 카드-생성물 57건 중 서버가 기억하는 건 1건). 소속만 여기로 분리해
-- 더하기 전용으로 쌓으면 덮어쓰기 자체가 없어 브라우저끼리 싸우지 않는다.
--   · 삭제는 실제 삭제가 아니라 removed_at 표시 — 안 그러면 아직 모르는 다른 브라우저가
--     자기 로컬 목록으로 그 생성물을 되살린다(합치기는 합집합이므로).
--   · owner_uid = deps.actor_id(개인 편집물) — identity._REMAP_PLAN 리맵 대상.
--   · 개인 편집물이라 팀 서버로 보내지 않는다(_proxy._LOCAL_PREFIXES '/api/scenes').
CREATE TABLE IF NOT EXISTS scene_card_generation (
    owner_uid     TEXT NOT NULL,
    scene_id      TEXT NOT NULL,
    card_id       TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    removed_at    TEXT,                                  -- 카드에서 뺐음(다른 브라우저에도 전파)
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (owner_uid, scene_id, card_id, generation_id)
);
-- 씬 열 때 그 씬 전체를 한 번에 읽는다(카드별 N번 조회 금지).
CREATE INDEX IF NOT EXISTS idx_scene_card_gen_scene
    ON scene_card_generation(owner_uid, scene_id);

CREATE INDEX IF NOT EXISTS idx_generation_worker  ON generation(worker_id);
CREATE INDEX IF NOT EXISTS idx_generation_created ON generation(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_gen   ON share(generation_id);  -- generation 당 공유 1개
CREATE INDEX IF NOT EXISTS idx_share_shared_at    ON share(shared_at DESC, generation_id);  -- team-fresh(+N) 기준선 범위 스캔
-- 목록 정렬 키(sort_ts) 인덱스는 db.py _migrate 에서 생성(sort_ts 가 ALTER 로 추가되는 컬럼이라
-- 여기서 만들면 신규/구버전 분기가 꼬임 — idx_generation_job 과 동일한 이유).
CREATE INDEX IF NOT EXISTS idx_asset_generation   ON asset(generation_id);
CREATE INDEX IF NOT EXISTS idx_genref_gen         ON gen_reference(generation_id);
CREATE INDEX IF NOT EXISTS idx_gentag_gen         ON gen_tag(generation_id);
CREATE INDEX IF NOT EXISTS idx_history_parent     ON history(parent_gen_id);
CREATE INDEX IF NOT EXISTS idx_history_child      ON history(child_gen_id);
