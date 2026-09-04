-- ============================================================
-- Phase 4 — P1-4: Soft visibility for years/subjects via is_active
--
-- Scope (strict): years.is_active, subjects.is_active only.
-- Does NOT touch faculties.is_active or its existing RLS/behavior,
-- and does NOT add faculties.is_active filtering to search_resources().
-- That gap (search_resources() not filtering on faculty active state)
-- is a pre-existing, separate issue explicitly out of scope for P1-4
-- per product decision.
--
-- Mirrors the faculties.is_active pattern from schema_phase2_5.sql:
--   - additive column, NOT NULL DEFAULT true (existing rows unaffected)
--   - two-layer SELECT RLS: public sees only active rows, authorized
--     admins (fn_has_permission) see all rows regardless of is_active
--   - INSERT/UPDATE/DELETE policies untouched (already permission-gated)
--
-- No FK changes, no cascade changes, no data deletion, no data mutation
-- beyond the new column's default backfill (which happens automatically
-- and non-destructively as part of ADD COLUMN ... DEFAULT true).
-- Idempotent: safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. New columns
-- ------------------------------------------------------------

alter table years    add column if not exists is_active boolean not null default true;
alter table subjects add column if not exists is_active boolean not null default true;

comment on column years.is_active is
  'رؤية ناعمة (soft visibility) — P1-4. true = تظهر السنة للزوار عبر الاستعلامات/التصفح العام والبحث. false = مخفية عن الزوار لكن تبقى مُدارة بالكامل من لوحة التحكم (لا حذف، لا فقدان بيانات). القيمة الافتراضية true تحافظ على ظهور كل السنوات الحالية دون تغيير.';

comment on column subjects.is_active is
  'رؤية ناعمة (soft visibility) — P1-4. true = تظهر المادة للزوار عبر الاستعلامات/التصفح العام والبحث. false = مخفية عن الزوار لكن تبقى مُدارة بالكامل من لوحة التحكم (لا حذف، لا فقدان بيانات). القيمة الافتراضية true تحافظ على ظهور كل المواد الحالية دون تغيير.';

-- ------------------------------------------------------------
-- 2. Indexes — justified by the same query pattern already used for
--    faculties.is_active (idx_faculties_is_active): every public
--    listing/detail query below adds an .eq("is_active", true) filter,
--    and both new RLS SELECT policies filter on is_active directly.
-- ------------------------------------------------------------

create index if not exists idx_years_is_active    on years(is_active);
create index if not exists idx_subjects_is_active on subjects(is_active);

-- ------------------------------------------------------------
-- 3. RLS: replace the single unconditional public SELECT policy on
--    years/subjects with the two-layer pattern already used for
--    faculties (public_read_active_faculties + auth_read_all_faculties).
--    All INSERT/UPDATE/DELETE policies are untouched.
-- ------------------------------------------------------------

drop policy if exists "public_read_years" on years;
drop policy if exists "public_read_active_years" on years;
create policy "public_read_active_years"
  on years for select
  using (is_active = true);

drop policy if exists "auth_read_all_years" on years;
create policy "auth_read_all_years"
  on years for select
  using (fn_has_permission('academic_structure', university_id, faculty_id, 'view'));

drop policy if exists "public_read_subjects" on subjects;
drop policy if exists "public_read_active_subjects" on subjects;
create policy "public_read_active_subjects"
  on subjects for select
  using (is_active = true);

drop policy if exists "auth_read_all_subjects" on subjects;
create policy "auth_read_all_subjects"
  on subjects for select
  using (
    fn_has_permission(
      'academic_structure',
      (select y.university_id from years y where y.id = subjects.year_id),
      (select y.faculty_id from years y where y.id = subjects.year_id),
      'view'
    )
  );

-- ------------------------------------------------------------
-- 4. search_resources(): add years.is_active / subjects.is_active
--    filtering only. Signature, return columns, and all other filter
--    conditions (including the deliberate absence of a faculties.is_active
--    filter) are unchanged. CREATE OR REPLACE is safe here — same
--    signature as after phase4_p1_1_search_resources_pagination.sql.
-- ------------------------------------------------------------

create or replace function public.search_resources(
  p_query text default null::text,
  p_type text default null::text,
  p_university_id uuid default null::uuid,
  p_year_number integer default null::integer,
  p_subject_id uuid default null::uuid,
  p_language text default null::text,
  p_faculty_id uuid default null::uuid,
  p_limit integer default 60,
  p_offset integer default 0
)
returns table(
  id uuid, title text, type text, language text, file_url text, storage_provider text,
  source_type text, status text, subject_id uuid, keywords text, created_at timestamp with time zone,
  subject_name text, subject_code text, university_id uuid, university_name text,
  year_id uuid, year_number integer, faculty_id uuid, faculty_name text,
  verified boolean, view_count integer
)
language sql
stable
as $function$
  select
    r.id, r.title, r.type, r.language, r.file_url, r.storage_provider,
    r.source_type, r.status, r.subject_id, r.keywords, r.created_at,
    s.name as subject_name, s.code as subject_code,
    u.id as university_id, u.name as university_name,
    y.id as year_id, y.year_number,
    f.id as faculty_id, f.name as faculty_name,
    r.verified, r.view_count
  from resources r
  join subjects s on s.id = r.subject_id
  join years y on y.id = s.year_id
  left join faculties f on f.id = y.faculty_id
  join universities u on u.id = y.university_id
  where r.status = 'published'
    and y.is_active = true
    and s.is_active = true
    and (
      p_query is null or btrim(p_query) = '' or
      r.title ilike '%' || p_query || '%' or
      coalesce(r.keywords, '') ilike '%' || p_query || '%' or
      s.name ilike '%' || p_query || '%' or
      coalesce(s.code, '') ilike '%' || p_query || '%' or
      u.name ilike '%' || p_query || '%' or
      coalesce(f.name, '') ilike '%' || p_query || '%'
    )
    and (p_type is null or r.type = p_type)
    and (p_university_id is null or u.id = p_university_id)
    and (p_faculty_id is null or f.id = p_faculty_id)
    and (p_year_number is null or y.year_number = p_year_number)
    and (p_subject_id is null or s.id = p_subject_id)
    and (p_language is null or r.language = p_language)
  order by r.created_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

-- ============================================================
-- 5. Verification queries (read-only, run these after applying)
-- ============================================================

select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name in ('years','subjects') and column_name = 'is_active'
order by table_name;

select count(*) filter (where is_active) as active_years, count(*) as total_years from years;
select count(*) filter (where is_active) as active_subjects, count(*) as total_subjects from subjects;

select tablename, policyname, cmd, qual
from pg_policies
where tablename in ('years','subjects')
order by tablename, cmd, policyname;
-- ============================================================
