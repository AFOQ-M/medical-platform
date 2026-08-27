-- P1-Final M2: search_path hardening on search_resources() and
-- fn_sync_year_university_from_faculty(). Only change vs. the live functions
-- is adding SET search_path — body/signature/return type unchanged.
-- Applied to production and verified live (see P1-FINAL-REPORT.md, M2).

CREATE OR REPLACE FUNCTION public.search_resources(p_query text DEFAULT NULL::text, p_type text DEFAULT NULL::text, p_university_id uuid DEFAULT NULL::uuid, p_year_number integer DEFAULT NULL::integer, p_subject_id uuid DEFAULT NULL::uuid, p_language text DEFAULT NULL::text, p_faculty_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 60, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, title text, type text, language text, file_url text, storage_provider text, source_type text, status text, subject_id uuid, keywords text, created_at timestamp with time zone, subject_name text, subject_code text, university_id uuid, university_name text, year_id uuid, year_number integer, faculty_id uuid, faculty_name text, verified boolean, view_count integer)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $function$
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

CREATE OR REPLACE FUNCTION public.fn_sync_year_university_from_faculty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, public
AS $function$
declare
  v_university_id uuid;
begin
  if new.faculty_id is not null then
    select university_id into v_university_id from faculties where id = new.faculty_id;
    if v_university_id is null then
      raise exception 'faculty_id % غير موجود في جدول faculties', new.faculty_id;
    end if;
    new.university_id := v_university_id;
  end if;
  return new;
end;
$function$;
