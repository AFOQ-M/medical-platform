-- ============================================================
-- منصة الموارد الطبية — المرحلة الثانية (Phase 2)
-- الترخيص الدقيق (Granular Authorization) + بحث محسّن
--
-- شغّل هذا الملف كاملاً في: Supabase Dashboard > SQL Editor > New query
-- (بعد أن يكون schema.sql الأصلي قد شُغّل مسبقًا)
--
-- هذا الملف تراكمي (idempotent) قدر الإمكان: يمكن تشغيله أكثر من مرة
-- بأمان دون كسر بيانات موجودة.
-- ============================================================

-- ------------------------------------------------------------
-- 0. أعمدة جديدة على الجداول الحالية
-- ------------------------------------------------------------

-- كلمات مفتاحية للبحث (اختياري لكل مورد)
alter table resources add column if not exists keywords text;

-- ------------------------------------------------------------
-- 1. جدول الملفات الشخصية (يمتد من auth.users)
-- ------------------------------------------------------------

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null check (role in ('super_admin', 'admin', 'staff')) default 'staff',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- إنشاء صف profiles تلقائيًا عند إنشاء مستخدم Auth جديد
-- (سواء عبر supabase.auth.signUp أو عبر Supabase Dashboard > Add user)
create or replace function fn_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role, active)
  values (new.id, new.email, 'staff', true)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function fn_handle_new_auth_user();

-- ------------------------------------------------------------
-- 2. جدول الصلاحيات (سطر واحد لكل تركيبة نطاق/نوع كيان/إجراء)
-- ------------------------------------------------------------

create table if not exists user_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  scope_type text not null check (scope_type in ('global', 'university')),
  scope_id uuid references universities(id) on delete cascade,
  entity_type text not null check (entity_type in ('academic_structure', 'resources', 'reports')),
  action text not null check (action in ('view', 'create', 'edit', 'delete')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint chk_scope_shape check (
    (scope_type = 'global' and scope_id is null) or
    (scope_type = 'university' and scope_id is not null)
  )
);

create unique index if not exists uq_user_permissions
  on user_permissions (user_id, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), entity_type, action);

create index if not exists idx_user_permissions_user_id on user_permissions(user_id);
create index if not exists idx_user_permissions_scope_id on user_permissions(scope_id);

-- ------------------------------------------------------------
-- 3. سجل نشاط الإدارة
-- ------------------------------------------------------------

create table if not exists admin_activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references profiles(id) on delete set null,
  action text not null,
  target_type text,
  target_id uuid,
  details text,
  created_at timestamptz not null default now()
);

create index if not exists idx_activity_log_created_at on admin_activity_log(created_at desc);

-- ------------------------------------------------------------
-- 4. دوال التحقق من الصلاحية (SECURITY DEFINER لتفادي التكرار في RLS)
-- ------------------------------------------------------------

create or replace function fn_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'super_admin' and active = true
  );
$$;

-- p_scope_id = NULL يعني "عملية على نطاق عام/جديد بلا جامعة محددة بعد"
-- (مثل إنشاء جامعة جديدة) — في هذه الحالة فقط صلاحية scope_type='global' تُقبل.
create or replace function fn_has_permission(p_entity_type text, p_scope_id uuid, p_action text)
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
        or (scope_type = 'university' and scope_id = p_scope_id)
      )
  );
end;
$$;

-- ------------------------------------------------------------
-- 5. RLS: profiles / user_permissions / admin_activity_log
-- ------------------------------------------------------------

alter table profiles enable row level security;
alter table user_permissions enable row level security;
alter table admin_activity_log enable row level security;

drop policy if exists "profiles_select_self_or_super" on profiles;
create policy "profiles_select_self_or_super"
  on profiles for select
  using (id = auth.uid() or fn_is_super_admin());

drop policy if exists "profiles_update_super_only" on profiles;
create policy "profiles_update_super_only"
  on profiles for update
  using (fn_is_super_admin());

drop policy if exists "profiles_delete_super_only" on profiles;
create policy "profiles_delete_super_only"
  on profiles for delete
  using (fn_is_super_admin());

drop policy if exists "user_permissions_select_self_or_super" on user_permissions;
create policy "user_permissions_select_self_or_super"
  on user_permissions for select
  using (user_id = auth.uid() or fn_is_super_admin());

drop policy if exists "user_permissions_write_super_only" on user_permissions;
drop policy if exists "user_permissions_insert_super_only" on user_permissions;
drop policy if exists "user_permissions_update_super_only" on user_permissions;
drop policy if exists "user_permissions_delete_super_only" on user_permissions;
create policy "user_permissions_insert_super_only"
  on user_permissions for insert
  with check (fn_is_super_admin());
create policy "user_permissions_update_super_only"
  on user_permissions for update
  using (fn_is_super_admin());
create policy "user_permissions_delete_super_only"
  on user_permissions for delete
  using (fn_is_super_admin());

drop policy if exists "activity_log_insert_self" on admin_activity_log;
create policy "activity_log_insert_self"
  on admin_activity_log for insert
  with check (actor_user_id = auth.uid());

drop policy if exists "activity_log_select_super_only" on admin_activity_log;
create policy "activity_log_select_super_only"
  on admin_activity_log for select
  using (fn_is_super_admin());

-- ------------------------------------------------------------
-- 6. إسقاط سياسات الكتابة القديمة (authenticated = admin)
-- ------------------------------------------------------------

drop policy if exists "admin_insert_universities" on universities;
drop policy if exists "admin_update_universities" on universities;
drop policy if exists "admin_delete_universities" on universities;

drop policy if exists "admin_insert_years" on years;
drop policy if exists "admin_update_years" on years;
drop policy if exists "admin_delete_years" on years;

drop policy if exists "admin_insert_subjects" on subjects;
drop policy if exists "admin_update_subjects" on subjects;
drop policy if exists "admin_delete_subjects" on subjects;

drop policy if exists "admin_insert_resources" on resources;
drop policy if exists "admin_update_resources" on resources;
drop policy if exists "admin_delete_resources" on resources;

drop policy if exists "admin_read_reports" on reports;
drop policy if exists "admin_delete_reports" on reports;

-- ------------------------------------------------------------
-- 7. سياسات الكتابة الجديدة القائمة على fn_has_permission
-- ------------------------------------------------------------

drop policy if exists "auth_insert_universities" on universities;
drop policy if exists "auth_update_universities" on universities;
drop policy if exists "auth_delete_universities" on universities;

drop policy if exists "auth_insert_years" on years;
drop policy if exists "auth_update_years" on years;
drop policy if exists "auth_delete_years" on years;

drop policy if exists "auth_insert_subjects" on subjects;
drop policy if exists "auth_update_subjects" on subjects;
drop policy if exists "auth_delete_subjects" on subjects;

drop policy if exists "auth_read_all_resources" on resources;
drop policy if exists "auth_insert_resources" on resources;
drop policy if exists "auth_update_resources" on resources;
drop policy if exists "auth_delete_resources" on resources;

drop policy if exists "auth_read_reports" on reports;
drop policy if exists "auth_delete_reports" on reports;

-- الجامعات: الإنشاء يتطلب صلاحية عامة (global) لأنه لا يوجد نطاق جامعة بعد.
-- التعديل/الحذف يتطلب صلاحية على تلك الجامعة بالذات (أو صلاحية عامة).
create policy "auth_insert_universities" on universities for insert
  with check (fn_has_permission('academic_structure', null, 'create'));

create policy "auth_update_universities" on universities for update
  using (fn_has_permission('academic_structure', id, 'edit'));

create policy "auth_delete_universities" on universities for delete
  using (fn_has_permission('academic_structure', id, 'delete'));

-- السنوات: النطاق = الجامعة التي تنتمي لها
create policy "auth_insert_years" on years for insert
  with check (fn_has_permission('academic_structure', university_id, 'create'));

create policy "auth_update_years" on years for update
  using (fn_has_permission('academic_structure', university_id, 'edit'));

create policy "auth_delete_years" on years for delete
  using (fn_has_permission('academic_structure', university_id, 'delete'));

-- المواد: النطاق = جامعة السنة التي تنتمي لها المادة
create policy "auth_insert_subjects" on subjects for insert
  with check (
    fn_has_permission('academic_structure', (select university_id from years where id = year_id), 'create')
  );

create policy "auth_update_subjects" on subjects for update
  using (
    fn_has_permission('academic_structure', (select university_id from years where id = year_id), 'edit')
  );

create policy "auth_delete_subjects" on subjects for delete
  using (
    fn_has_permission('academic_structure', (select university_id from years where id = year_id), 'delete')
  );

-- الموارد: القراءة الإدارية لكل الحالات (منشور/مخفي/مُبلَّغ) ضمن النطاق المصرَّح به
-- (تُضاف إلى سياسة public_read_published_resources الحالية، لا تستبدلها)
create policy "auth_read_all_resources" on resources for select
  using (
    fn_has_permission(
      'resources',
      (select y.university_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      'view'
    )
  );

-- الموارد: النطاق = جامعة المادة (عبر السنة)
create policy "auth_insert_resources" on resources for insert
  with check (
    fn_has_permission(
      'resources',
      (select y.university_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      'create'
    )
  );

create policy "auth_update_resources" on resources for update
  using (
    fn_has_permission(
      'resources',
      (select y.university_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      'edit'
    )
  );

create policy "auth_delete_resources" on resources for delete
  using (
    fn_has_permission(
      'resources',
      (select y.university_id from subjects s join years y on y.id = s.year_id where s.id = subject_id),
      'delete'
    )
  );

-- التقارير: القراءة والحذف حسب نطاق جامعة المورد المرتبط بالبلاغ
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
      'delete'
    )
  );

-- ------------------------------------------------------------
-- 8. دالة البحث الشامل (تُنفَّذ داخل Postgres، تحترم RLS تلقائيًا
--    لأنها SECURITY INVOKER الافتراضية — تعرض فقط الموارد المنشورة
--    أصلاً بحكم سياسة public_read_published_resources)
-- ------------------------------------------------------------

create or replace function search_resources(
  p_query text default null,
  p_type text default null,
  p_university_id uuid default null,
  p_year_number int default null,
  p_subject_id uuid default null,
  p_language text default null
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
  year_number int
)
language sql
stable
as $$
  select
    r.id, r.title, r.type, r.language, r.file_url, r.storage_provider,
    r.source_type, r.status, r.subject_id, r.keywords, r.created_at,
    s.name as subject_name, s.code as subject_code,
    u.id as university_id, u.name as university_name, y.year_number
  from resources r
  join subjects s on s.id = r.subject_id
  join years y on y.id = s.year_id
  join universities u on u.id = y.university_id
  where r.status = 'published'
    and (
      p_query is null or btrim(p_query) = '' or
      r.title ilike '%' || p_query || '%' or
      coalesce(r.keywords, '') ilike '%' || p_query || '%' or
      s.name ilike '%' || p_query || '%' or
      coalesce(s.code, '') ilike '%' || p_query || '%' or
      u.name ilike '%' || p_query || '%'
    )
    and (p_type is null or r.type = p_type)
    and (p_university_id is null or u.id = p_university_id)
    and (p_year_number is null or y.year_number = p_year_number)
    and (p_subject_id is null or s.id = p_subject_id)
    and (p_language is null or r.language = p_language)
  order by r.created_at desc
  limit 60;
$$;

-- ============================================================
-- انتهى هذا الملف. الخطوات المتبقية يدوية:
--
-- 1) رقّي أول مستخدم Super Admin يدويًا (مرة واحدة فقط):
--      update profiles set role = 'super_admin' where email = 'YOUR_EMAIL_HERE';
--
--    (المستخدم لازم يكون موجود مسبقًا في Authentication > Users،
--     وسيظهر تلقائيًا صف له في profiles بفضل الـ trigger أعلاه)
--
-- 2) لإنشاء أدمن/موظف جديد لاحقًا (الخيار اليدوي):
--      Supabase Dashboard > Authentication > Users > Add user
--      (فعّل Auto Confirm User) — سيظهر تلقائيًا في تبويب
--      "المستخدمون والصلاحيات" داخل لوحة التحكم ليمنحه Super Admin صلاحياته.
-- ============================================================
