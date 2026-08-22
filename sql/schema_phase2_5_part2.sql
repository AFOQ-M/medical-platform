-- ============================================================
-- منصة الموارد الطبية — المرحلة 2.5 / الجزء الثاني (Phase 2.5 — Part 2)
-- تحديث دالة البحث لدعم الكلية + تصليب faculty_id إن كان آمنًا
--
-- شغّل هذا الملف بعد schema.sql + schema_phase2.sql + schema_phase2_5.sql
--
-- هذا الملف لا يعيد إنشاء جدول faculties ولا سياسات RLS الخاصة به
-- (تلك من مسؤولية schema_phase2_5.sql فقط). يقتصر هذا الملف على:
--   1) تحديث search_resources() لتفهم مستوى الكلية
--   2) فحص آمن + تصليب اختياري لعمود years.faculty_id إلى NOT NULL
-- ============================================================

-- ------------------------------------------------------------
-- 1. تحديث دالة البحث الشامل لتضم الكلية
--
-- نُبقي كل المعاملات والأعمدة القديمة كما هي بنفس الترتيب (استدعاءات
-- search.html الحالية تستخدم أسماء معاملات، لا ترتيبًا موضعيًا، لذا
-- إضافة p_faculty_id بأمان في النهاية لا تكسر أي استدعاء قديم).
-- نضيف فقط: معامل p_faculty_id، وأعمدة faculty_id/faculty_name/year_id
-- إلى النتيجة المُرجعة.
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
  faculty_name text
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
    f.id as faculty_id, f.name as faculty_name
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
-- 2. فحص آمن + تصليب اختياري لـ years.faculty_id
--
-- لا نُجري ALTER ... NOT NULL دون تحقق. نتحقق أولاً أنه لا توجد أي
-- سنة بقيمة faculty_id فارغة؛ فقط في هذه الحالة نصلّب العمود.
-- إن وُجدت سنوات بلا كلية، نكتفي بتنبيه (RAISE NOTICE) ولا نغيّر شيئًا،
-- ليتم حلّها يدويًا من لوحة التحكم (تبويب السنوات) ثم إعادة تشغيل
-- هذا القسم لاحقًا.
-- ------------------------------------------------------------

do $$
declare
  v_null_count int;
  v_already_not_null boolean;
begin
  select count(*) into v_null_count from years where faculty_id is null;

  select not attnotnull into v_already_not_null
  from pg_attribute
  where attrelid = 'years'::regclass and attname = 'faculty_id';

  if v_null_count = 0 then
    if v_already_not_null then
      alter table years alter column faculty_id set not null;
      raise notice 'years.faculty_id تم تصليبه إلى NOT NULL بنجاح (كل السنوات لديها كلية صالحة).';
    else
      raise notice 'years.faculty_id مُصلَّب مسبقًا إلى NOT NULL. لا حاجة لأي إجراء.';
    end if;
  else
    raise notice 'تم تخطي تصليب years.faculty_id: توجد % سنة/سنوات بلا كلية محددة. عدّلها من لوحة التحكم (تبويب السنوات) ثم أعد تشغيل هذا القسم.', v_null_count;
  end if;
end $$;

-- ============================================================
-- ملاحظة: بعد تشغيل هذا الملف، راقب رسائل NOTICE في نتيجة الاستعلام
-- (Supabase SQL Editor يعرضها أسفل النتيجة) لمعرفة هل تم التصليب
-- فعليًا أم لا تزال هناك سنوات بحاجة لمراجعة يدوية.
-- ============================================================
