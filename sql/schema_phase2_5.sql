-- ============================================================
-- منصة الموارد الطبية — المرحلة 2.5 / الجزء الأول (Phase 2.5 — Part 1)
-- طبقة الكلية/التخصص (Faculty) + ترحيل قاعدة البيانات + الترخيص
--
-- شغّل هذا الملف كاملاً في: Supabase Dashboard > SQL Editor > New query
-- (بعد أن يكون schema.sql و schema_phase2.sql قد شُغّلا مسبقًا)
--
-- هذا الملف تراكمي (idempotent) قدر الإمكان: يمكن تشغيله أكثر من مرة
-- بأمان دون تكرار البيانات أو كسر شيء موجود.
--
-- لا يحذف هذا الملف أي جدول، ولا يُفرغ أي بيانات، ولا يغيّر نظام
-- الصلاحيات الحالي — فقط يوسّعه ليفهم مستوى الكلية الجديد.
-- ============================================================

-- ------------------------------------------------------------
-- 0. جدول الكليات/التخصصات (faculties) — كيان جديد فعلي في القاعدة
-- ------------------------------------------------------------

create table if not exists faculties (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references universities(id) on delete cascade,
  name text not null,
  code text,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- لا نكرر اسم نفس الكلية داخل نفس الجامعة
create unique index if not exists uq_faculties_university_name
  on faculties(university_id, name);

create index if not exists idx_faculties_university_id on faculties(university_id);
create index if not exists idx_faculties_is_active on faculties(is_active);

-- ------------------------------------------------------------
-- 1. ترحيل البيانات الحالية: إنشاء كلية افتراضية لكل جامعة تحتوي سنوات
--
-- سبب هذا الإجراء: المخطط قبل هذا الملف لا يحتوي أي معلومة عن الكلية،
-- والمطلوب أن تصبح علاقة "سنة → كلية" حقيقية. بما أنه لا يمكن تخمين
-- اسم الكلية الحقيقي للبيانات الحالية، نُنشئ كلية مؤقتة واحدة لكل
-- جامعة تحتوي سنوات فعلاً، ونربط كل سنواتها الحالية بها. هذا إجراء
-- غير مدمّر بالكامل: لا يُحذف أي صف، فقط يُضاف عمود ويُملأ لاحقًا.
-- على مدير المنصة إعادة تسمية/تقسيم هذه الكلية المؤقتة يدويًا من
-- لوحة التحكم (بعد الجزء الثاني) إلى الكليات الحقيقية إن أراد ذلك.
-- ------------------------------------------------------------

insert into faculties (university_id, name, code, description, is_active)
select u.id,
       'كلية عامة (مؤقت — يُرجى المراجعة)',
       null,
       'تم إنشاء هذه الكلية تلقائيًا أثناء ترحيل المرحلة 2.5 لربط السنوات الحالية بكيان كلية. الرجاء إعادة تسميتها أو تقسيمها إلى الكليات الحقيقية.',
       true
from universities u
where exists (select 1 from years y where y.university_id = u.id)
on conflict (university_id, name) do nothing;

-- ------------------------------------------------------------
-- 2. تحديث جدول years: إضافة faculty_id (بدون حذف university_id)
--
-- نُبقي على university_id عمدًا لأنه لا يزال مستخدَمًا مباشرة في
-- الواجهة الحالية (admin.js, year.html, subject.html) وفي سياسات RLS
-- الحالية على subjects/resources. حذفه الآن يكسر الموقع الحيّ قبل
-- تحديث الواجهة في الجزء الثاني. بدلاً من ذلك، نضيف trigger يضمن
-- عدم تعارض العمودين أبدًا (لا يمكن أن تنتمي سنة لكلية من جامعة
-- مختلفة عن الجامعة المسجّلة في نفس السطر).
--
-- faculty_id متروك NULLABLE عمدًا في هذا الجزء (وليس NOT NULL):
-- نموذج "إضافة سنة" الحالي في admin.js لا يرسل faculty_id بعد،
-- وجعل العمود إجباريًا الآن سيمنع إضافة أي سنة جديدة حتى يُحدَّث
-- ذلك النموذج في الجزء الثاني. كل السنوات الحالية تُملأ بالكلية
-- المؤقتة أعلاه؛ يوصى بجعل العمود NOT NULL كخطوة تالية فور تحديث
-- نموذج السنة في لوحة التحكم.
-- ------------------------------------------------------------

alter table years add column if not exists faculty_id uuid references faculties(id);

update years y
set faculty_id = f.id
from faculties f
where f.university_id = y.university_id
  and y.faculty_id is null
  and f.description like 'تم إنشاء هذه الكلية تلقائيًا%';

create index if not exists idx_years_faculty_id on years(faculty_id);

-- دالة/محفّز: يضمن أن university_id يبقى متطابقًا دائمًا مع جامعة
-- الكلية المختارة في faculty_id (يمنع الحالة الفاسدة: سنة تابعة
-- لكلية من جامعة أ، لكن مسجَّلة تحت جامعة ب).
create or replace function fn_sync_year_university_from_faculty()
returns trigger
language plpgsql
as $$
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
$$;

drop trigger if exists trg_sync_year_university on years;
create trigger trg_sync_year_university
  before insert or update of faculty_id on years
  for each row execute function fn_sync_year_university_from_faculty();

-- ------------------------------------------------------------
-- 3. تفعيل RLS على faculties
-- ------------------------------------------------------------

alter table faculties enable row level security;

-- ------------------------------------------------------------
-- 4. توسيع جدول user_permissions ليدعم نطاق "كلية" (faculty)
--
-- لا نستبدل الجدول ولا نحذف أي صف. نضيف عمودًا جديدًا nullable،
-- ونوسّع قيود CHECK الحالية لتقبل scope_type = 'faculty'.
-- ------------------------------------------------------------

alter table user_permissions add column if not exists scope_faculty_id uuid references faculties(id) on delete cascade;

create index if not exists idx_user_permissions_scope_faculty_id on user_permissions(scope_faculty_id);

-- قيد scope_type: كان يقبل فقط ('global','university') — يجب توسيعه
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'user_permissions_scope_type_check'
      and conrelid = 'user_permissions'::regclass
  ) then
    alter table user_permissions drop constraint user_permissions_scope_type_check;
  end if;
end $$;

alter table user_permissions drop constraint if exists chk_scope_type;
alter table user_permissions add constraint chk_scope_type
  check (scope_type in ('global', 'university', 'faculty'));

-- قيد شكل النطاق: كل نوع نطاق له عمود واحد محدد فقط
alter table user_permissions drop constraint if exists chk_scope_shape;
alter table user_permissions add constraint chk_scope_shape check (
  (scope_type = 'global'     and scope_id is null     and scope_faculty_id is null) or
  (scope_type = 'university' and scope_id is not null and scope_faculty_id is null) or
  (scope_type = 'faculty'    and scope_id is null      and scope_faculty_id is not null)
);

-- فهرس التفرّد: نضيف عمود الكلية إليه لمنع تكرار نفس صلاحية الكلية
drop index if exists uq_user_permissions;
create unique index if not exists uq_user_permissions
  on user_permissions (
    user_id,
    scope_type,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(scope_faculty_id, '00000000-0000-0000-0000-000000000000'::uuid),
    entity_type,
    action
  );

-- ------------------------------------------------------------
-- 5. توسيع دالة التحقق من الصلاحية لفهم نطاق الكلية
--
-- نُبقي fn_has_permission(entity_type, scope_id, action) كما هي
-- تمامًا (تُستخدم اليوم في سياسات universities) — لا نكسرها.
-- نضيف نسخة موازية (overload) بأربعة معاملات تُستخدم في كل مكان
-- يحتاج فهم نطاق الكلية إلى جانب الجامعة (years, subjects,
-- resources, reports).
-- ------------------------------------------------------------

create or replace function fn_has_permission(
  p_entity_type text,
  p_university_id uuid,
  p_faculty_id uuid,
  p_action text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_active boolean;
begin
  select role, active into v_role, v_active from profiles where id = auth.uid();

  if v_role is null or v_active is not true then
    return false;
  end if;

  if v_role = 'super_admin' then
    return true;
  end if;

  return exists (
    select 1 from user_permissions
    where user_id = auth.uid()
      and active = true
      and entity_type = p_entity_type
      and action = p_action
      and (
        scope_type = 'global'
        or (scope_type = 'university' and p_university_id is not null and scope_id = p_university_id)
        or (scope_type = 'faculty' and p_faculty_id is not null and scope_faculty_id = p_faculty_id)
      )
  );
end;
$$;

-- ------------------------------------------------------------
-- 6. سياسات RLS على faculties
-- ------------------------------------------------------------

drop policy if exists "public_read_active_faculties" on faculties;
create policy "public_read_active_faculties"
  on faculties for select
  using (is_active = true);

-- الأدمن (بصلاحية جامعة أو صلاحية الكلية نفسها) يرى كل الكليات بما فيها المعطّلة
drop policy if exists "auth_read_all_faculties" on faculties;
create policy "auth_read_all_faculties"
  on faculties for select
  using (fn_has_permission('academic_structure', university_id, id, 'view'));

-- الإنشاء: يتطلب صلاحية على مستوى الجامعة (أو عامة) — الكلية غير موجودة بعد
drop policy if exists "auth_insert_faculties" on faculties;
create policy "auth_insert_faculties"
  on faculties for insert
  with check (fn_has_permission('academic_structure', university_id, null, 'create'));

drop policy if exists "auth_update_faculties" on faculties;
create policy "auth_update_faculties"
  on faculties for update
  using (fn_has_permission('academic_structure', university_id, id, 'edit'));

drop policy if exists "auth_delete_faculties" on faculties;
create policy "auth_delete_faculties"
  on faculties for delete
  using (fn_has_permission('academic_structure', university_id, id, 'delete'));

-- ------------------------------------------------------------
-- 7. تحديث سياسات years لتفهم نطاق الكلية أيضًا (وليس الجامعة فقط)
-- ------------------------------------------------------------

drop policy if exists "auth_insert_years" on years;
drop policy if exists "auth_update_years" on years;
drop policy if exists "auth_delete_years" on years;

create policy "auth_insert_years" on years for insert
  with check (fn_has_permission('academic_structure', university_id, faculty_id, 'create'));

create policy "auth_update_years" on years for update
  using (fn_has_permission('academic_structure', university_id, faculty_id, 'edit'));

create policy "auth_delete_years" on years for delete
  using (fn_has_permission('academic_structure', university_id, faculty_id, 'delete'));

-- ------------------------------------------------------------
-- 8. تحديث سياسات subjects لتنحدر عبر السنة إلى الكلية والجامعة معًا
-- ------------------------------------------------------------

drop policy if exists "auth_insert_subjects" on subjects;
drop policy if exists "auth_update_subjects" on subjects;
drop policy if exists "auth_delete_subjects" on subjects;

create policy "auth_insert_subjects" on subjects for insert
  with check (
    fn_has_permission(
      'academic_structure',
      (select university_id from years where id = year_id),
      (select faculty_id from years where id = year_id),
      'create'
    )
  );

create policy "auth_update_subjects" on subjects for update
  using (
    fn_has_permission(
      'academic_structure',
      (select university_id from years where id = year_id),
      (select faculty_id from years where id = year_id),
      'edit'
    )
  );

create policy "auth_delete_subjects" on subjects for delete
  using (
    fn_has_permission(
      'academic_structure',
      (select university_id from years where id = year_id),
      (select faculty_id from years where id = year_id),
      'delete'
    )
  );

-- ------------------------------------------------------------
-- 9. تحديث سياسات resources لتنحدر عبر subjects → years إلى الكلية والجامعة
-- ------------------------------------------------------------

drop policy if exists "auth_read_all_resources" on resources;
drop policy if exists "auth_insert_resources" on resources;
drop policy if exists "auth_update_resources" on resources;
drop policy if exists "auth_delete_resources" on resources;

create policy "auth_read_all_resources" on resources for select
  using (
    fn_has_permission(
      'resources',
      (select y.university_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      (select y.faculty_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      'view'
    )
  );

create policy "auth_insert_resources" on resources for insert
  with check (
    fn_has_permission(
      'resources',
      (select y.university_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      (select y.faculty_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      'create'
    )
  );

create policy "auth_update_resources" on resources for update
  using (
    fn_has_permission(
      'resources',
      (select y.university_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      (select y.faculty_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      'edit'
    )
  );

create policy "auth_delete_resources" on resources for delete
  using (
    fn_has_permission(
      'resources',
      (select y.university_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      (select y.faculty_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      'delete'
    )
  );

-- ------------------------------------------------------------
-- 10. تحديث سياسات reports لتنحدر عبر resources → subjects → years
-- ------------------------------------------------------------

drop policy if exists "auth_read_reports" on reports;
drop policy if exists "auth_delete_reports" on reports;

create policy "auth_read_reports" on reports for select
  using (
    fn_has_permission(
      'reports',
      (
        select y.university_id
        from resources r
        join subjects s on s.id = r.subject_id
        join years y on y.id = s.year_id
        where r.id = resource_id
      ),
      (
        select y.faculty_id
        from resources r
        join subjects s on s.id = r.subject_id
        join years y on y.id = s.year_id
        where r.id = resource_id
      ),
      'view'
    )
  );

create policy "auth_delete_reports" on reports for delete
  using (
    fn_has_permission(
      'reports',
      (
        select y.university_id
        from resources r
        join subjects s on s.id = r.subject_id
        join years y on y.id = s.year_id
        where r.id = resource_id
      ),
      (
        select y.faculty_id
        from resources r
        join subjects s on s.id = r.subject_id
        join years y on y.id = s.year_id
        where r.id = resource_id
      ),
      'delete'
    )
  );

-- ============================================================
-- ملاحظات مهمة يجب معرفتها قبل الانتقال إلى الجزء الثاني (Part 2):
--
-- 1) faculty_id في جدول years لا يزال NULLABLE عمدًا (انظر التعليق
--    في القسم 2 أعلاه). بمجرد تحديث نموذج "إضافة سنة" في admin.js
--    ليختار كلية فعليًا، شغّل:
--      alter table years alter column faculty_id set not null;
--
-- 2) لم يتم تعديل search_resources() في هذا الجزء عمدًا. الجزء الثاني
--    يحتاج: إضافة معامل p_faculty_id، JOIN مع faculties، وإرجاع
--    faculty_id/faculty_name ضمن النتائج.
--
-- 3) الكلية المؤقتة التي أُنشئت تلقائيًا لكل جامعة تحتوي سنوات
--    (القسم 1) يجب على Super Admin مراجعتها وإعادة تسميتها/تقسيمها
--    إلى الكليات الحقيقية من لوحة التحكم بعد تحديث واجهة الكليات.
--
-- 4) admin_activity_log لم يتغيّر هيكليًا (action هو نص حر أصلاً)،
--    لكن يجب استخدام القيم التالية عند تسجيل عمليات الكليات:
--      faculty_created, faculty_updated, faculty_disabled, faculty_deleted
--    وتسجيل منح/سحب صلاحيات الكلية بنفس نمط:
--      permission_granted / permission_revoked (كما هو حاليًا في admin.js)
--
-- 5) fn_has_permission(entity_type, scope_id, action) بثلاثة معاملات
--    بقيت كما هي بدون أي تغيير (تُستخدم في سياسات universities فقط).
--    النسخة الجديدة بأربعة معاملات لا تستبدلها، بل تتعايش معها.
-- ============================================================
