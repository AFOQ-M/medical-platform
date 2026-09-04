-- ============================================================
-- Phase 6 — Forum MVP (ملتقى أفق)
-- ============================================================
--
-- Migration جديدة ومستقلة بالكامل — لا تعدّل أي جدول أو سياسة أو دالة
-- موجودة مسبقًا. أربعة جداول جديدة فقط: forum_categories, forum_topics,
-- forum_replies, forum_reports.
--
-- ------------------------------------------------------------
-- قرار تصميمي مهم — لماذا author_id يشير إلى auth.users وليس profiles
-- ------------------------------------------------------------
-- جدول profiles (schema_phase2.sql) مخصص حصريًا لموظفي/أدمن لوحة التحكم
-- (role in super_admin/admin/staff). الـtrigger fn_handle_new_auth_user
-- (المعدَّل في phase4b_auth_foundation_fix.sql) يتجاهل عمدًا كل مستخدمي
-- Anonymous Auth، ولا يُنشئ صفًا في profiles لأي طالب عادي حتى بعد ربط
-- Google — لأن الترقية (linkIdentity) تُعدّل نفس صف auth.users الموجود
-- ولا تُدرج صفًا جديدًا يُفعّل الـtrigger أصلًا.
-- لذلك: forum_topics.author_id و forum_replies.author_id يشيران مباشرة
-- إلى auth.users(id)، مع تخزين author_name (denormalized) وقت الإنشاء
-- (نفس منطق bestDisplayName() في js/auth.js) بدل الاعتماد على profiles
-- أو كشف auth.users للعميل عبر أي join.
-- forum_reports.reviewed_by يبقى يشير إلى profiles(id) لأن المراجع هو
-- أدمن فعليًا (من نفس نظام لوحة التحكم الحالي).
--
-- ------------------------------------------------------------
-- قرار تصميمي — التحقق من "ليس ضيفًا" على مستوى RLS
-- ------------------------------------------------------------
-- لا جدول سابق في المشروع احتاج التمييز بين مستخدم Anonymous ومستخدم
-- حقيقي على مستوى RLS (كل الجداول السابقة إما قراءة عامة أو أدمن فقط
-- عبر profiles). Supabase يُضمّن claim باسم is_anonymous في الـJWT لكل
-- جلسة Anonymous Auth. الدالة المساعدة أدناه (fn_forum_is_real_user)
-- تتحقق من هذا الـclaim، وتُستخدم في كل سياسة INSERT على جداول المنتعى.
-- ============================================================

-- ------------------------------------------------------------
-- 0) دالة مساعدة: هل المستخدم الحالي حقيقي (ليس Anonymous)؟
-- ------------------------------------------------------------

create or replace function fn_forum_is_real_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;

comment on function fn_forum_is_real_user() is
  'يُستخدم في سياسات RLS لجداول المنتدى فقط — true فقط لمستخدم مسجّل دخول فعليًا (ليس ضيفًا Anonymous Auth). لا علاقة له بأي جدول آخر في المشروع.';

-- ------------------------------------------------------------
-- 1) forum_categories
-- ------------------------------------------------------------

create table if not exists forum_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table forum_categories is 'الأقسام الخمسة الثابتة لملتقى أفق (Forum MVP) — لا تُدار من واجهة المستخدم في هذه المرحلة، فقط عبر SQL/Dashboard.';

-- ------------------------------------------------------------
-- 2) forum_topics
-- ------------------------------------------------------------

create table if not exists forum_topics (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references forum_categories(id) on delete restrict,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null,
  title text not null check (char_length(btrim(title)) between 3 and 200),
  content text not null check (char_length(btrim(content)) between 1 and 10000),
  is_locked boolean not null default false,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column forum_topics.author_name is 'اسم الكاتب وقت إنشاء الموضوع (denormalized من user_metadata) — لا join مع auth.users من العميل.';
comment on column forum_topics.is_locked is 'موضوع مغلق: يمكن قراءته لكن لا يمكن إضافة ردود جديدة عليه (يُفرض في RLS الردود أيضًا، وليس فقط في الواجهة).';
comment on column forum_topics.is_hidden is 'يضبطها أدمن لاحقًا (مراجعة بلاغات) — موضوع مخفي عن القراءة العامة، يبقى مرئيًا لصاحبه فقط.';

-- ------------------------------------------------------------
-- 3) forum_replies
-- ------------------------------------------------------------

create table if not exists forum_replies (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references forum_topics(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null,
  content text not null check (char_length(btrim(content)) between 1 and 5000),
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column forum_replies.is_hidden is 'يضبطها أدمن لاحقًا (مراجعة بلاغات) — رد مخفي عن القراءة العامة، يبقى مرئيًا لصاحبه فقط.';

-- ------------------------------------------------------------
-- 4) forum_reports
-- ------------------------------------------------------------

create table if not exists forum_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  topic_id uuid references forum_topics(id) on delete cascade,
  reply_id uuid references forum_replies(id) on delete cascade,
  reason text not null check (reason in ('offensive', 'harassment', 'inappropriate', 'misinformation', 'other')),
  details text check (details is null or char_length(details) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references profiles(id),
  constraint forum_reports_single_target check (
    (topic_id is not null and reply_id is null) or
    (topic_id is null and reply_id is not null)
  )
);

comment on table forum_reports is 'بلاغات المنتدى — هدف واحد فقط لكل بلاغ (موضوع أو رد، وليس الاثنين). لا حذف/إخفاء تلقائي للمحتوى عند الإبلاغ؛ المراجعة يدوية من الأدمن لاحقًا (خارج نطاق هذا الـMVP).';

-- ------------------------------------------------------------
-- 5) فهارس
-- ------------------------------------------------------------

create index if not exists idx_forum_topics_category_id on forum_topics(category_id);
create index if not exists idx_forum_topics_author_id on forum_topics(author_id);
create index if not exists idx_forum_topics_created_at on forum_topics(created_at desc);
create index if not exists idx_forum_replies_topic_id on forum_replies(topic_id);
create index if not exists idx_forum_replies_author_id on forum_replies(author_id);
create index if not exists idx_forum_reports_topic_id on forum_reports(topic_id);
create index if not exists idx_forum_reports_reply_id on forum_reports(reply_id);
create index if not exists idx_forum_reports_status on forum_reports(status);

-- ------------------------------------------------------------
-- 6) Trigger: تحديث updated_at تلقائيًا عند أي UPDATE
-- ------------------------------------------------------------

create or replace function fn_forum_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_forum_topics_touch on forum_topics;
create trigger trg_forum_topics_touch
  before update on forum_topics
  for each row execute function fn_forum_touch_updated_at();

drop trigger if exists trg_forum_replies_touch on forum_replies;
create trigger trg_forum_replies_touch
  before update on forum_replies
  for each row execute function fn_forum_touch_updated_at();

-- ------------------------------------------------------------
-- 7) تفعيل RLS على كل جداول المنتدى
-- ------------------------------------------------------------

alter table forum_categories enable row level security;
alter table forum_topics     enable row level security;
alter table forum_replies    enable row level security;
alter table forum_reports    enable row level security;

-- ------------------------------------------------------------
-- 8) سياسات forum_categories — قراءة عامة فقط للأقسام النشطة
-- ------------------------------------------------------------

create policy "public_read_forum_categories"
  on forum_categories for select
  using (is_active = true);

-- لا سياسات INSERT/UPDATE/DELETE عمدًا — إدارة الأقسام عبر SQL/Dashboard
-- فقط في هذه المرحلة (لا واجهة أدمن للمنتدى بعد، كما هو موضّح في الطلب).

-- ------------------------------------------------------------
-- 9) سياسات forum_topics
-- ------------------------------------------------------------

-- القراءة: أي زائر يرى المواضيع غير المخفية؛ صاحب الموضوع يرى موضوعه دائمًا.
create policy "read_visible_or_own_forum_topics"
  on forum_topics for select
  using (is_hidden = false or author_id = auth.uid());

-- الإنشاء: مستخدم حقيقي (غير ضيف) فقط، باسمه هو.
create policy "insert_own_forum_topics"
  on forum_topics for insert
  with check (author_id = auth.uid() and fn_forum_is_real_user());

-- التعديل: صاحب الموضوع فقط.
create policy "update_own_forum_topics"
  on forum_topics for update
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- الحذف: صاحب الموضوع فقط.
create policy "delete_own_forum_topics"
  on forum_topics for delete
  using (author_id = auth.uid());

-- ------------------------------------------------------------
-- 10) سياسات forum_replies
-- ------------------------------------------------------------

create policy "read_visible_or_own_forum_replies"
  on forum_replies for select
  using (is_hidden = false or author_id = auth.uid());

-- الإنشاء: مستخدم حقيقي، باسمه، وفقط إن كان الموضوع المستهدف مفتوحًا
-- وغير مخفي — فرض منع الرد على موضوع مغلق في قاعدة البيانات نفسها،
-- وليس فقط في الواجهة (كما هو مطلوب صراحة في الطلب).
create policy "insert_own_forum_replies"
  on forum_replies for insert
  with check (
    author_id = auth.uid()
    and fn_forum_is_real_user()
    and exists (
      select 1 from forum_topics t
      where t.id = forum_replies.topic_id
        and t.is_locked = false
        and t.is_hidden = false
    )
  );

create policy "update_own_forum_replies"
  on forum_replies for update
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy "delete_own_forum_replies"
  on forum_replies for delete
  using (author_id = auth.uid());

-- ------------------------------------------------------------
-- 11) سياسات forum_reports
-- ------------------------------------------------------------

-- القراءة: صاحب البلاغ فقط يرى بلاغه (لا Admin Review UI في هذا الـMVP؛
-- المراجعة عبر Supabase Dashboard مباشرة من فريق أفق في هذه المرحلة).
create policy "read_own_forum_reports"
  on forum_reports for select
  using (reporter_id = auth.uid());

-- الإنشاء: مستخدم حقيقي فقط، ببياناته هو كمُبلِّغ.
create policy "insert_own_forum_reports"
  on forum_reports for insert
  with check (reporter_id = auth.uid() and fn_forum_is_real_user());

-- لا سياسات UPDATE/DELETE لغير الأدمن عمدًا — المستخدم العادي لا يستطيع
-- تعديل/حذف أي بلاغ (لا حتى بلاغه هو، لمنع التلاعب بالأدلة). المراجعة
-- الإدارية (تغيير status/reviewed_by) ستُضاف لاحقًا مع Admin Dashboard
-- كوظيفة منفصلة — خارج نطاق هذا الـMVP كما هو موضّح في الطلب.

-- ------------------------------------------------------------
-- 12) Grants — نفس نمط الجداول العادية (M9): SELECT/INSERT/UPDATE/DELETE
-- عادية محمية بالكامل عبر RLS أعلاه، وليس REVOKE ALL (ذلك النمط خاص
-- بجداول rate-limit الداخلية التي لا PostgREST access لها إطلاقًا).
-- ------------------------------------------------------------

grant select on forum_categories to anon, authenticated;

grant select, insert, update, delete on forum_topics to anon, authenticated;
grant select, insert, update, delete on forum_replies to anon, authenticated;

-- forum_reports: لا داعي لمنح anon أي صلاحية إطلاقًا (الضيوف لا يُبلّغون
-- أصلًا حسب المتطلبات، وRLS كانت ستمنعهم على أي حال — لكن سحب الـgrant
-- طبقة حماية إضافية أقوى من RLS وحدها، بنفس فلسفة M1/M9).
grant select, insert on forum_reports to authenticated;

-- ------------------------------------------------------------
-- 13) بيانات الأقسام الخمسة (بنية أساسية للـMVP، وليست بيانات تجريبية)
-- ------------------------------------------------------------

insert into forum_categories (name, slug, description, sort_order, is_active) values
  ('المواد والمذاكرة',   'subjects-study',   'نقاشات حول المواد الدراسية وطرق المذاكرة',        1, true),
  ('الاختبارات والمراجعة', 'exams-review',     'مراجعات ونقاشات حول الاختبارات',                 2, true),
  ('أسئلة واستفسارات',    'questions',        'اطرح سؤالك الأكاديمي واحصل على إجابات من زملائك', 3, true),
  ('تجارب ونصائح',        'experiences-tips', 'شارك تجربتك الأكاديمية أو قدّم نصيحة لزملائك',    4, true),
  ('إعلانات أفق',         'announcements',    'إعلانات وتحديثات رسمية من فريق أفق المعرفة',       5, true)
on conflict (slug) do nothing;

-- ============================================================
-- نهاية Phase 6 — Forum MVP
-- لا DROP على أي جدول موجود. لا تعديل على أي سياسة/دالة/trigger سابقة.
-- ============================================================
