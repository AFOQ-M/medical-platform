-- ============================================================
-- منصة الموارد الطبية — Phase 3.5 / 3.6: عدّاد المشاهدات + علامة "موثّق"
--
-- إضافات فقط (Additive) على resources — لا تُعدَّل أي سياسة RLS موجودة
-- تخص التعديل العادي (title/status/verified/... إلخ يبقى محكومًا بنفس
-- صلاحيات user_permissions كما هو تمامًا؛ verified عمود عادي يمر عبر
-- نفس سياسة UPDATE الحالية، فلا حاجة لأي سياسة جديدة من أجله).
--
-- العمود الوحيد الذي يحتاج مسارًا جديدًا هو view_count، لأن الزوار
-- (anon) ليس لديهم أي صلاحية UPDATE على resources أصلًا (ولا نريد
-- منحهم واحدة). لذلك أُضيفت دالة increment_resource_view() بنطاق
-- ضيق جدًا: تتجاوز RLS عمدًا (security definer) لكنها لا تلمس شيئًا
-- سوى +1 على عمود واحد، وفقط على مورد status='published'.
--
-- ============================================================
-- لماذا يُعاد إنشاء هذا الملف (تصحيح خطأ 42P13)
-- ============================================================
--
-- التشغيل السابق فشل بالخطأ:
--
--   ERROR: 42P13: cannot change return type of existing function
--   DETAIL: Row type defined by OUT parameters is different.
--   HINT: Use DROP FUNCTION search_resources(text,text,uuid,integer,uuid,text,uuid) first.
--
-- السبب: قاعدة البيانات تحتوي أصلاً على search_resources بتوقيع 7
-- معاملات (من schema_phase2_5_part2.sql)، لكن بأعمدة إخراج لا تضم
-- verified/view_count. لا يمكن لـ CREATE OR REPLACE FUNCTION تغيير
-- شكل صف الإخراج (OUT parameters) لدالة موجودة بنفس توقيع المعاملات
-- — يجب حذفها صراحةً أولاً بتوقيعها الدقيق، ثم إنشاؤها من جديد.
--
-- بالإضافة، توجد نسخة أقدم بتوقيع 6 معاملات (من schema_phase2.sql،
-- قبل إضافة p_faculty_id في Phase 2.5) لم تُحذف قط لأن اختلاف عدد
-- المعاملات يجعلها overload منفصلاً عن نظر Postgres، لا نسخة يُستبدل.
-- يجب حذفها أيضًا حتى يبقى تطبيق-facing واحد فقط.
--
-- ترتيب هذا الملف الآن:
--   1) إضافة resources.view_count (إن لم يكن موجودًا)
--   2) إضافة resources.verified (إن لم يكن موجودًا)
--   3) إنشاء/تحديث increment_resource_view(uuid)
--   4) حذف نسخة search_resources ذات الـ6 معاملات (القديمة)
--   5) حذف نسخة search_resources ذات الـ7 معاملات (الحالية بأي شكل إخراج)
--   6) إنشاء النسخة الكنسية الوحيدة (7 معاملات) بأعمدة الإخراج الكاملة
--   7) صلاحيات increment_resource_view
--   8) استعلامات تحقق (pg_proc)
--
-- هذا الملف آمن التشغيل بعد Phase 2.5 (يتعامل بشكل صريح مع كل من
-- توقيعي 6 و7 معاملات، بغض النظر عن حالة الإخراج الحالية لأيٍّ منهما).
-- لا تغيير على RLS، هرمية الكليات، الصلاحيات، أو أي واجهة.
-- ============================================================

-- ------------------------------------------------------------
-- 1) و 2) الأعمدة الجديدة على resources
-- ------------------------------------------------------------

alter table resources add column if not exists view_count integer not null default 0;
alter table resources add column if not exists verified boolean not null default false;

comment on column resources.view_count is 'عدد مرات فتح المورد من الزوار — يُزاد فقط عبر increment_resource_view()، لا يُعدَّل مباشرة أبدًا';
comment on column resources.verified is 'علامة "موثّق" يضبطها الأدمن يدويًا من لوحة التحكم — لا علاقة لها بـ source_type';

-- ------------------------------------------------------------
-- 3) دالة زيادة عدّاد المشاهدات — الطريق الوحيد المتاح للزوار العامّين
--    لتعديل أي شيء في resources على الإطلاق.
--
--    هذه الدالة توقيعها ثابت منذ البداية (uuid) → لا تعارض OUT، لذا
--    CREATE OR REPLACE آمن هنا (بخلاف search_resources أدناه).
-- ------------------------------------------------------------

create or replace function increment_resource_view(p_resource_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update resources
  set view_count = view_count + 1
  where id = p_resource_id and status = 'published';
$$;

-- ------------------------------------------------------------
-- 4) حذف نسخة الـ6 معاملات القديمة من search_resources (من
--    schema_phase2.sql، قبل p_faculty_id). لا تُستخدم من التطبيق
--    منذ Phase 2.5، لكنها بقيت overload منفصلاً في قاعدة البيانات.
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
-- 5) حذف نسخة الـ7 معاملات الحالية (أيًّا كان شكل إخراجها الآن —
--    الحذف بالتوقيع لا يحتاج معرفة شكل الإخراج). هذا هو الإصلاح
--    الفعلي لخطأ 42P13: لا يمكن لـ CREATE OR REPLACE تغيير OUT
--    parameters، لذا يجب الحذف الصريح قبل إعادة الإنشاء.
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
-- 6) إنشاء النسخة الكنسية الوحيدة (7 معاملات) — نفس الأسماء/الأنواع/
--    الترتيب المستخدَم فعليًا في المشروع (js/app.js و search.html
--    يستدعيان بأسماء معاملات، لا ترتيبًا موضعيًا)، وكل أعمدة الإخراج
--    المطلوبة من Phase 2.5 (faculty_id, faculty_name, year_id) و
--    Phase 3 (verified, view_count) محفوظة دون حذف أي عمود قديم.
--
--    الآن لا يوجد أي تعارض توقيع محتمل لأن الخطوتين 4 و5 أزالتا كل
--    ما قد يتعارض معها، فـ CREATE OR REPLACE هنا يُنشئ الدالة من جديد.
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
-- 7) صلاحيات increment_resource_view — تُعاد كتابتها هنا في كل
--    تشغيل حتى تبقى مضمونة بغض النظر عن ترتيب التشغيل السابق.
-- ------------------------------------------------------------

revoke all on function increment_resource_view(uuid) from public;
grant execute on function increment_resource_view(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 8) استعلامات تحقق — شغّلها بعد التنفيذ للتأكد من النتيجة النهائية.
-- ------------------------------------------------------------

-- 8.a يجب أن يُرجع صفًا واحدًا فقط: نسخة الـ7 معاملات، بكل الأعمدة
--     الـ21 المطلوبة (تضم verified و view_count) ضمن return_type.
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

-- 8.b يجب أن يُرجع صفرًا من الصفوف — تأكيد أن نسخة الـ6 معاملات
--     القديمة لم تعد موجودة.
select
  p.oid,
  pg_get_function_identity_arguments(p.oid) as identity_arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'search_resources'
  and n.nspname = 'public'
  and pg_get_function_identity_arguments(p.oid) =
    'text, text, uuid, integer, uuid, text';

-- 8.c عدد النسخ الكلي لـ search_resources في public — يجب أن يكون 1.
select count(*) as total_search_resources_overloads
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'search_resources'
  and n.nspname = 'public';

-- 8.d تأكيد وجود increment_resource_view(uuid) وأنها security definer.
select
  p.oid,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as is_security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'increment_resource_view'
  and n.nspname = 'public';
