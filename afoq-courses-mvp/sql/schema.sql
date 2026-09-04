-- ============================================================
-- منصة الموارد الطبية — مخطط قاعدة البيانات (المرحلة الأولى)
-- شغّل هذا الملف كاملاً في: Supabase Dashboard > SQL Editor > New query
-- ============================================================

-- تفعيل الامتداد اللازم لتوليد UUID (مفعّل افتراضيًا في Supabase غالبًا،
-- لكن هذا السطر آمن حتى لو كان مفعّلاً مسبقًا)
create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. الجداول
-- ------------------------------------------------------------

-- الجامعات
create table if not exists universities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_name text,
  logo_url text,
  created_at timestamp default now()
);

-- السنوات الدراسية (مرتبطة بكل جامعة)
create table if not exists years (
  id uuid primary key default gen_random_uuid(),
  university_id uuid references universities(id) on delete cascade,
  year_number int not null check (year_number between 1 and 6),
  created_at timestamp default now()
);

-- المواد الدراسية (مرتبطة بكل سنة)
create table if not exists subjects (
  id uuid primary key default gen_random_uuid(),
  year_id uuid references years(id) on delete cascade,
  name text not null,
  code text,
  created_at timestamp default now()
);

-- الموارد/الملفات (مرتبطة بكل مادة)
create table if not exists resources (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid references subjects(id) on delete cascade,
  title text not null,
  type text not null check (type in ('book','lecture','slides','summary','questions','past_exam','notes')),
  language text check (language in ('ar','en')),
  file_url text not null,
  storage_provider text check (storage_provider in ('google_drive','backblaze','telegram','external')),
  source_type text check (source_type in ('official','student','open_license','external_link')) default 'student',
  status text check (status in ('published','hidden','reported')) default 'published',
  created_at timestamp default now()
);

-- تقارير المشاكل (زر "الإبلاغ عن مشكلة")
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid references resources(id) on delete cascade,
  reason text not null,
  note text,
  created_at timestamp default now()
);

-- فهارس تُسرّع الاستعلامات الشائعة (فلترة/تصفح حسب العلاقات)
create index if not exists idx_years_university_id on years(university_id);
create index if not exists idx_subjects_year_id on subjects(year_id);
create index if not exists idx_resources_subject_id on resources(subject_id);
create index if not exists idx_resources_status on resources(status);
create index if not exists idx_reports_resource_id on reports(resource_id);

-- ------------------------------------------------------------
-- 2. تفعيل Row Level Security على كل الجداول
-- ------------------------------------------------------------

alter table universities enable row level security;
alter table years        enable row level security;
alter table subjects     enable row level security;
alter table resources    enable row level security;
alter table reports      enable row level security;

-- ------------------------------------------------------------
-- 3. سياسات القراءة (SELECT) — عامة للزوّار
-- ------------------------------------------------------------

-- الجامعات/السنوات/المواد: قراءة عامة بالكامل (لا تحتوي بيانات حسّاسة)
create policy "public_read_universities"
  on universities for select
  using (true);

create policy "public_read_years"
  on years for select
  using (true);

create policy "public_read_subjects"
  on subjects for select
  using (true);

-- الموارد: قراءة عامة فقط للموارد المنشورة (status = 'published')
create policy "public_read_published_resources"
  on resources for select
  using (status = 'published');

-- التقارير: لا قراءة عامة إطلاقًا (فقط الأدمن يشوفها عبر سياسة لاحقة)
-- (لا نضيف سياسة SELECT عامة لجدول reports عمدًا)

-- ------------------------------------------------------------
-- 4. سياسات الكتابة (INSERT/UPDATE/DELETE) — فقط للمستخدمين المسجّلين (الأدمن)
-- ------------------------------------------------------------

-- الجامعات
create policy "admin_insert_universities" on universities for insert
  with check (auth.role() = 'authenticated');
create policy "admin_update_universities" on universities for update
  using (auth.role() = 'authenticated');
create policy "admin_delete_universities" on universities for delete
  using (auth.role() = 'authenticated');

-- السنوات
create policy "admin_insert_years" on years for insert
  with check (auth.role() = 'authenticated');
create policy "admin_update_years" on years for update
  using (auth.role() = 'authenticated');
create policy "admin_delete_years" on years for delete
  using (auth.role() = 'authenticated');

-- المواد
create policy "admin_insert_subjects" on subjects for insert
  with check (auth.role() = 'authenticated');
create policy "admin_update_subjects" on subjects for update
  using (auth.role() = 'authenticated');
create policy "admin_delete_subjects" on subjects for delete
  using (auth.role() = 'authenticated');

-- الموارد
create policy "admin_insert_resources" on resources for insert
  with check (auth.role() = 'authenticated');
create policy "admin_update_resources" on resources for update
  using (auth.role() = 'authenticated');
create policy "admin_delete_resources" on resources for delete
  using (auth.role() = 'authenticated');

-- التقارير: أي زائر (حتى غير مسجّل) يقدر يرسل بلاغ، لكن فقط الأدمن يقرأ/يحذف
create policy "public_insert_reports"
  on reports for insert
  with check (true);

create policy "admin_read_reports"
  on reports for select
  using (auth.role() = 'authenticated');

create policy "admin_delete_reports"
  on reports for delete
  using (auth.role() = 'authenticated');

-- ============================================================
-- انتهى. بعد التشغيل: أنشئ مستخدم أدمن واحد من
-- Supabase Dashboard > Authentication > Users > Add user
-- (بريد إلكتروني + كلمة مرور) واستخدمه لتسجيل الدخول من /admin
-- ============================================================
