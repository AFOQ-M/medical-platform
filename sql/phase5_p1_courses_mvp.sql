-- ============================================================
-- Phase 5 — P1: Courses MVP (independent top-level feature)
-- ============================================================
--
-- Adds Courses as a new, independent top-level feature, parallel to
-- the existing university → faculty → year → subject → resource
-- hierarchy (Option A from the read-only Courses audit). Nothing in
-- this migration touches an existing table's columns, an existing
-- policy on an existing table, fn_has_permission(), fn_is_super_admin(),
-- the admin session-lock RPCs, or MFA enforcement.
--
-- Scope (MVP only): courses + course_lessons tables, indexes, RLS
-- (public published-only + admin via fn_has_permission), and widening
-- the user_permissions.entity_type CHECK constraint to accept
-- 'courses'. No enrollment, no progress tracking, no sections, no
-- categories/levels, no storage bucket, no new SECURITY DEFINER
-- functions (none were genuinely needed — RLS alone is sufficient
-- here, exactly like resources/reports).
--
-- Idempotent where practical (create table/index/policy ... if not
-- exists / drop policy if exists ... create policy), matching the
-- style already used in phase4_p1_4_years_subjects_is_active.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1. courses table
-- ------------------------------------------------------------

create table if not exists courses (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  short_description text,
  description text,
  cover_image_url text,
  instructor_name text,
  language text check (language in ('ar', 'en')),
  status text not null default 'draft' check (status in ('draft', 'published', 'hidden')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- نفس نمط resources_file_url_check (P1-6): رابط مطلق http/https غير فارغ فقط،
-- لكن هنا العمود اختياري (nullable) لذا القيد يُطبَّق فقط عند وجود قيمة.
alter table courses
  add constraint courses_cover_image_url_check
  check (
    cover_image_url is null
    or (btrim(cover_image_url) <> '' and btrim(cover_image_url) ~* '^https?://\S+')
  );

comment on table courses is
  'Phase 5 P1 — Courses MVP. Independent top-level feature, no FK into the academic hierarchy (universities/faculties/years/subjects/resources). status mirrors resources.status style (3-state) but adds draft, since a course needs an explicit pre-publish state.';

-- ------------------------------------------------------------
-- 2. course_lessons table
-- ------------------------------------------------------------

create table if not exists course_lessons (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references courses(id) on delete cascade,
  title text not null,
  content_type text not null check (content_type in ('video_url', 'external_link', 'text')),
  content_url text,
  content_text text,
  duration_minutes integer,
  sort_order integer not null default 0,
  status text not null default 'draft' check (status in ('draft', 'published', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- video_url/external_link يتطلبان content_url بمخطّط http/https صالح؛
-- text يتطلب content_text. لا نفرض تبادلية صارمة أبعد من ذلك (نفس روح
-- resources: القيد الوحيد المفروض على قاعدة البيانات هو صيغة الرابط).
alter table course_lessons
  add constraint course_lessons_content_url_check
  check (
    (content_type = 'text')
    or (content_url is not null and btrim(content_url) <> '' and btrim(content_url) ~* '^https?://\S+')
  );

comment on table course_lessons is
  'Phase 5 P1 — Courses MVP. Flat ordered lesson list per course (no sections for MVP). content_url used for video_url/external_link, content_text used for text.';

-- ------------------------------------------------------------
-- 3. Indexes — only the ones actually filtered/joined on, matching
--    the minimal-index philosophy already used across this schema.
-- ------------------------------------------------------------

create index if not exists idx_courses_status on courses(status);
create index if not exists idx_course_lessons_course_id on course_lessons(course_id);
create index if not exists idx_course_lessons_status on course_lessons(status);

-- ------------------------------------------------------------
-- 4. updated_at auto-touch — mirrors the fact that both tables declare
--    updated_at; since no existing generic trigger for this exists in
--    the repo, we set it explicitly from the admin UI instead of
--    adding a new trigger function (smaller, more additive change).
--    (No SQL object added here — see admin/admin.js payloads.)
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5. user_permissions.entity_type — widen CHECK to accept 'courses'
--    Same additive DROP/ADD CONSTRAINT shape already used in
--    schema_phase2_5.sql to widen scope_type with 'faculty'. No
--    existing row is affected; only a new allowed value is added.
-- ------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'user_permissions_entity_type_check'
      and conrelid = 'user_permissions'::regclass
  ) then
    alter table user_permissions drop constraint user_permissions_entity_type_check;
  end if;
end $$;

alter table user_permissions drop constraint if exists chk_entity_type;
alter table user_permissions add constraint chk_entity_type
  check (entity_type in ('academic_structure', 'resources', 'reports', 'courses'));

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------

alter table courses enable row level security;
alter table course_lessons enable row level security;

-- courses: public read — published only
drop policy if exists "public_read_published_courses" on courses;
create policy "public_read_published_courses"
  on courses for select
  using (status = 'published');

-- courses: authorized admins read everything (draft/hidden included).
-- Courses are global-scope only for MVP, so both scoped params are
-- passed null — under fn_has_permission's existing logic this means
-- only a 'global' scope_type grant satisfies it (a 'university' or
-- 'faculty' scoped grant for entity_type='courses' would never match,
-- since p_university_id/p_faculty_id are null here). That is a
-- deliberate MVP simplification, not a bug: courses have no natural
-- university/faculty scope to check against.
drop policy if exists "auth_read_all_courses" on courses;
create policy "auth_read_all_courses"
  on courses for select
  using (fn_has_permission('courses', null, null, 'view'));

drop policy if exists "auth_insert_courses" on courses;
create policy "auth_insert_courses"
  on courses for insert
  with check (fn_has_permission('courses', null, null, 'create'));

drop policy if exists "auth_update_courses" on courses;
create policy "auth_update_courses"
  on courses for update
  using (fn_has_permission('courses', null, null, 'edit'))
  with check (fn_has_permission('courses', null, null, 'edit'));

drop policy if exists "auth_delete_courses" on courses;
create policy "auth_delete_courses"
  on courses for delete
  using (fn_has_permission('courses', null, null, 'delete'));

-- course_lessons: public read — published lesson AND published parent course
drop policy if exists "public_read_published_course_lessons" on course_lessons;
create policy "public_read_published_course_lessons"
  on course_lessons for select
  using (
    status = 'published'
    and exists (
      select 1 from courses c
      where c.id = course_lessons.course_id and c.status = 'published'
    )
  );

drop policy if exists "auth_read_all_course_lessons" on course_lessons;
create policy "auth_read_all_course_lessons"
  on course_lessons for select
  using (fn_has_permission('courses', null, null, 'view'));

drop policy if exists "auth_insert_course_lessons" on course_lessons;
create policy "auth_insert_course_lessons"
  on course_lessons for insert
  with check (fn_has_permission('courses', null, null, 'create'));

drop policy if exists "auth_update_course_lessons" on course_lessons;
create policy "auth_update_course_lessons"
  on course_lessons for update
  using (fn_has_permission('courses', null, null, 'edit'))
  with check (fn_has_permission('courses', null, null, 'edit'));

drop policy if exists "auth_delete_course_lessons" on course_lessons;
create policy "auth_delete_course_lessons"
  on course_lessons for delete
  using (fn_has_permission('courses', null, null, 'delete'));

-- ============================================================
-- 7. Verification queries (read-only, run these after applying)
-- ============================================================

select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name in ('courses', 'course_lessons')
order by table_name, ordinal_position;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'chk_entity_type';

select tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename in ('courses', 'course_lessons')
order by tablename, cmd, policyname;

select indexname from pg_indexes where tablename in ('courses', 'course_lessons');

-- ============================================================
-- Rollback (manual only — not executed here):
--
-- drop table if exists course_lessons;
-- drop table if exists courses;
-- alter table user_permissions drop constraint if exists chk_entity_type;
-- alter table user_permissions add constraint chk_entity_type
--   check (entity_type in ('academic_structure', 'resources', 'reports'));
-- (Note: rolling back the entity_type constraint will fail if any
-- user_permissions row with entity_type='courses' still exists —
-- delete those rows first.)
-- ============================================================
