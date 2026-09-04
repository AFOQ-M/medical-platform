-- ============================================================
-- منصة الموارد الطبية — Phase 3: إصلاح تعارض النسخ المتعددة (Overload)
-- لدالة search_resources()  —  نسخة مُصحَّحة بعد فشل أول محاولة بخطأ 42P13
--
-- ============================================================
-- ماذا حدث بالضبط عند أول تشغيل لهذا الملف:
-- ============================================================
--
-- المحاولة الأولى افترضت أن CREATE OR REPLACE FUNCTION يمكنه إضافة
-- أعمدة جديدة في نهاية RETURNS TABLE لدالة موجودة بنفس توقيع المعاملات
-- (7 معاملات) دون الحاجة لحذفها أولاً. هذا الافتراض كان **خاطئًا** —
-- Postgres يرفض أي تغيير في نوع صف الإخراج (Row Type) عبر
-- CREATE OR REPLACE مهما كان التغيير بسيطًا، ويطلب صراحةً:
--
--   ERROR: 42P13: cannot change return type of existing function
--   DETAIL: Row type defined by OUT parameters is different.
--   HINT: Use DROP FUNCTION search_resources(text,text,uuid,integer,uuid,text,uuid) first.
--
-- أي أن دالة search_resources بتوقيع الـ7 معاملات كانت **موجودة أصلاً**
-- في قاعدة البيانات (على الأرجح بنسخة أعمدة الإخراج القديمة من
-- schema_phase2_5_part2.sql، بدون verified/view_count) — ومحاولة
-- استبدالها بنسخة ذات أعمدة إخراج مختلفة فشلت لهذا السبب بالضبط.
--
-- ============================================================
-- الإصلاح في هذا الملف
-- ============================================================
--
-- بدل الاعتماد على CREATE OR REPLACE لتغيير شكل الإخراج، هذا الملف:
--   1) يحذف صراحةً نسخة الـ7 معاملات الموجودة حاليًا (أيًّا كان شكل
--      إخراجها الحالي — الحذف لا يحتاج معرفة ذلك، فقط توقيع المعاملات).
--   2) يحذف صراحةً نسخة الـ6 معاملات القديمة المتبقية من
--      schema_phase2.sql (المشكلة الأصلية من الجولة السابقة).
--   3) يُنشئ بعدها نسخة كنسية واحدة نظيفة بتوقيع الـ7 معاملات وكل
--      أعمدة الإخراج المطلوبة لـ Phase 2.5 + Phase 3 معًا.
--
-- الترتيب إلزامي: DROP قبل CREATE، وليس العكس، وإلا يتكرر نفس الخطأ.
-- لا حذف بيانات (الدوال لا تحمل بيانات)، لا تغيير في RLS، لا تغيير في
-- جدول resources نفسه، لا تغيير في increment_resource_view()، لا تغيير
-- في أي واجهة أو تصميم.
-- ============================================================

-- ------------------------------------------------------------
-- (اختياري) استعلام تحقق — شغّله قبل التعديل لترى كل النسخ الموجودة فعليًا
-- ------------------------------------------------------------
-- select
--   p.oid,
--   n.nspname as schema,
--   p.proname as function_name,
--   pg_get_function_identity_arguments(p.oid) as identity_arguments,
--   pg_get_function_result(p.oid) as return_type
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where p.proname = 'search_resources'
--   and n.nspname = 'public';

-- ------------------------------------------------------------
-- 1) حذف نسخة الـ7 معاملات الحالية أولاً — إلزامي قبل إعادة إنشائها
--    بأعمدة إخراج مختلفة (هذا هو الإصلاح الفعلي لخطأ 42P13).
-- ------------------------------------------------------------

drop function if exists public.search_resources(
  text,     -- p_query
  text,     -- p_type
  uuid,     -- p_university_id
  integer,  -- p_year_number
  uuid,     -- p_subject_id
  text,     -- p_language
  uuid      -- p_faculty_id
);

-- ------------------------------------------------------------
-- 2) حذف نسخة الـ6 معاملات القديمة (المشكلة الأصلية من
--    schema_phase2.sql التي لم تُستبدَل أبدًا لاختلاف عدد المعاملات).
-- ------------------------------------------------------------

drop function if exists public.search_resources(
  text,     -- p_query
  text,     -- p_type
  uuid,     -- p_university_id
  integer,  -- p_year_number
  uuid,     -- p_subject_id
  text      -- p_language
);

-- ------------------------------------------------------------
-- 3) إنشاء النسخة الكنسية الوحيدة (7 معاملات) — لا يوجد الآن أي تعارض
--    توقيع محتمل لأن الخطوتين أعلاه أزالتا كل ما قد يتعارض معها.
--    نفس الأسماء/الأنواع/الترتيب/السلوك المستخدَم فعليًا في المشروع
--    (js/app.js و search.html)، وكل أعمدة الإخراج المطلوبة من
--    Phase 2.5 (faculty_id, faculty_name, year_id) و Phase 3
--    (verified, view_count) محفوظة بالكامل دون حذف أي عمود قديم.
-- ------------------------------------------------------------

create or replace function search_resources(
  p_query text default null,
  p_type text default null,
  p_university_id uuid default null,
  p_year_number int default null,
  p_subject_id uuid default null,
  p_language text default null,
  p_faculty_id uuid default null
)
returns table (
  id uuid,
  title text,
  type text,
  language text,
  file_url text,
  storage_provider text,
  source_type text,
  status text,
  subject_id uuid,
  keywords text,
  created_at timestamptz,
  subject_name text,
  subject_code text,
  university_id uuid,
  university_name text,
  year_id uuid,
  year_number int,
  faculty_id uuid,
  faculty_name text,
  verified boolean,
  view_count integer
)
language sql
stable
as $$
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
  limit 60;
$$;

-- ------------------------------------------------------------
-- 4) استعلام تحقق نهائي — شغّله بعد التنفيذ. يجب أن يُرجع **صفًا واحدًا
--    فقط** لـ search_resources، بتوقيع الـ7 معاملات، وبكل أعمدة
--    الإخراج الـ21 المذكورة أعلاه ضمن return_type.
-- ------------------------------------------------------------

select
  p.oid,
  n.nspname as schema,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_arguments(p.oid) as full_arguments,
  pg_get_function_result(p.oid) as return_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'search_resources'
  and n.nspname = 'public';

-- ------------------------------------------------------------
-- 5) تحقق من توقيع increment_resource_view() (لم يُعدَّل في هذا الملف
--    إطلاقًا — هذا استعلام قراءة فقط للتأكيد أنه بقي كما هو).
-- ------------------------------------------------------------

select
  p.oid,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as is_security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'increment_resource_view'
  and n.nspname = 'public';
