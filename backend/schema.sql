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
    final_at   TEXT                                  -- 최종 지정 시각
);

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
    sort_order INTEGER                            -- 관리자 수동 정렬 순서(작을수록 위). NULL=미지정(생성물 순 폴백)
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
    approved_at   TEXT
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
    status        TEXT NOT NULL DEFAULT 'pending',-- pending | running | done | failed | canceled
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_genrequest_acct ON gen_request(account_email, status);

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
    muted      INTEGER NOT NULL DEFAULT 0            -- 작성 시점 '내 알림 끄기' 캡처(작성자 본인 알림만 억제)
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
    muted      INTEGER NOT NULL DEFAULT 0            -- 작성 시점 '내 알림 끄기' 캡처(작성자 본인 알림만 억제)
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

CREATE INDEX IF NOT EXISTS idx_generation_worker  ON generation(worker_id);
CREATE INDEX IF NOT EXISTS idx_generation_created ON generation(created_at);
CREATE INDEX IF NOT EXISTS idx_share_gen          ON share(generation_id);
-- 목록 정렬 키(sort_ts) 인덱스는 db.py _migrate 에서 생성(sort_ts 가 ALTER 로 추가되는 컬럼이라
-- 여기서 만들면 신규/구버전 분기가 꼬임 — idx_generation_job 과 동일한 이유).
CREATE INDEX IF NOT EXISTS idx_asset_generation   ON asset(generation_id);
CREATE INDEX IF NOT EXISTS idx_genref_gen         ON gen_reference(generation_id);
CREATE INDEX IF NOT EXISTS idx_gentag_gen         ON gen_tag(generation_id);
CREATE INDEX IF NOT EXISTS idx_history_parent     ON history(parent_gen_id);
CREATE INDEX IF NOT EXISTS idx_history_child      ON history(child_gen_id);
