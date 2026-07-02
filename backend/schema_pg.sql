-- 자동 생성(migrate_to_pg.py) — SQLite 스키마 내성 → PG DDL

CREATE TABLE IF NOT EXISTS account (
  email text,
  name text,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  global_role text,                         -- v02 RBAC 전역 역할(CSV 복수). 레거시 role(C0~C5) 폐기
  hidden integer NOT NULL DEFAULT 0,        -- 관리자가 목록에서 가린 계정
  creator_uid text,
  created_at text NOT NULL DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'),
  approved_at text,
  PRIMARY KEY (email)
);

CREATE TABLE IF NOT EXISTS app_setting (
  key text,
  value text,
  PRIMARY KEY (key)
);

CREATE TABLE IF NOT EXISTS asset (
  id text,
  generation_id text NOT NULL,
  type text NOT NULL,
  file_path text NOT NULL,
  thumbnail_path text,
  source_url text,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS asset_comment (
  id text,
  project text NOT NULL,
  path text NOT NULL,
  author text NOT NULL,
  text text NOT NULL,
  created_at text NOT NULL DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'),
  parent_id text,
  muted bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS asset_comment_read (
  worker_id text NOT NULL,
  project text NOT NULL,
  path text NOT NULL,
  read_at text NOT NULL,
  PRIMARY KEY (worker_id, project, path)
);

CREATE TABLE IF NOT EXISTS asset_meta (
  project text NOT NULL,
  path text NOT NULL,
  is_source bigint NOT NULL DEFAULT 0,
  source_name text,
  tags text,
  comment text,
  color text,
  content_sha text,
  PRIMARY KEY (project, path)
);

CREATE TABLE IF NOT EXISTS auto_tag (
  id text,
  name text NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS creator (
  uid text,
  name text,
  global_role text,                         -- v02 RBAC 전역 역할(멤버 목록 표기축). 레거시 role 폐기
  PRIMARY KEY (uid)
);

CREATE TABLE IF NOT EXISTS gen_auto_tag (
  generation_id text NOT NULL,
  auto_tag_id text NOT NULL,
  PRIMARY KEY (generation_id, auto_tag_id)
);

CREATE TABLE IF NOT EXISTS gen_reference (
  generation_id text NOT NULL,
  reference_id text NOT NULL,
  role text,
  PRIMARY KEY (generation_id, reference_id, role)
);

CREATE TABLE IF NOT EXISTS gen_tag (
  generation_id text NOT NULL,
  tag_id text NOT NULL,
  PRIMARY KEY (generation_id, tag_id)
);

CREATE TABLE IF NOT EXISTS generation (
  id text,
  worker_id text NOT NULL,
  prompt text NOT NULL,
  display_prompt text,
  model text,
  params text,
  color text,
  status text NOT NULL DEFAULT 'pending',
  created_at text NOT NULL DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'),
  sort_ts double precision,
  job_id text,
  is_source bigint NOT NULL DEFAULT 0,
  source_name text,
  comment text,
  error text,
  hf_missing bigint NOT NULL DEFAULT 0,
  creator_uid text,
  project_id text,
  deleted_at text,
  is_final integer NOT NULL DEFAULT 0,      -- v02 CMS: Supervisor 가 지정한 최종(골드)
  final_by text,                            -- 최종 지정자 creator_uid
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS generation_comment (
  id text,
  gen_id text NOT NULL,
  author text NOT NULL,
  text text NOT NULL,
  created_at text NOT NULL DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'),
  parent_id text,
  muted bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS generation_comment_read (
  worker_id text NOT NULL,
  gen_id text NOT NULL,
  read_at text NOT NULL,
  PRIMARY KEY (worker_id, gen_id)
);

CREATE TABLE IF NOT EXISTS history (
  id text,
  parent_gen_id text NOT NULL,
  child_gen_id text NOT NULL,
  relation text NOT NULL DEFAULT 'derived',
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_edge ON history(parent_gen_id, child_gen_id, relation);

CREATE TABLE IF NOT EXISTS project (
  id text,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'team',
  created_by text,
  created_at text NOT NULL DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'),
  archived bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS project_member (
  project_id text NOT NULL,
  creator_uid text NOT NULL,
  project_role text,                        -- v02 프로젝트 역할 CSV(project_manager/supervisor/creator)
  PRIMARY KEY (project_id, creator_uid)
);

CREATE TABLE IF NOT EXISTS reference (
  id text,
  type text NOT NULL,
  file_path text NOT NULL,
  thumbnail_path text,
  source text,
  source_url text,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS share (
  id text,
  generation_id text NOT NULL,
  shared_by text NOT NULL,
  visibility text NOT NULL DEFAULT 'team',
  shared_at text NOT NULL DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS tag (
  id text,
  name text NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS worker (
  id text,
  name text NOT NULL,
  account_type text NOT NULL DEFAULT 'personal',
  PRIMARY KEY (id)
);
